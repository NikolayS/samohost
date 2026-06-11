import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { runDnsStatus, type DnsStatusDeps } from "../src/commands/dns.ts";
import { runEnvPreflight, type EnvExecDeps } from "../src/commands/env.ts";
import { StateStore } from "../src/state/store.ts";
import type { LookupResult } from "../src/dns/preflight.ts";
import type { VmRecord } from "../src/types.ts";

function vm(): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs env preflight / dns status", () => {
  test("env preflight takes <vm> and --json", () => {
    const cmd = parseArgs(["env", "preflight", "samo-we-field-record", "--json"]);
    if (cmd.kind !== "env-preflight") throw new Error("expected env-preflight");
    expect(cmd.input.vm).toBe("samo-we-field-record");
    expect(cmd.json).toBe(true);
    expect(() => parseArgs(["env", "preflight"])).toThrow(/requires <vm>/);
  });

  test("dns status takes <domain>, --expect-ip, repeatable --cf-zone", () => {
    const cmd = parseArgs([
      "dns", "status", "samo.cat",
      "--expect-ip", "178.105.246.151",
      "--cf-zone", "samo.team", "--cf-zone", "samo.green",
    ]);
    if (cmd.kind !== "dns-status") throw new Error("expected dns-status");
    expect(cmd.input.domain).toBe("samo.cat");
    expect(cmd.input.expectIp).toBe("178.105.246.151");
    expect(cmd.input.cfZones).toEqual(["samo.team", "samo.green"]);
  });

  test("dns status defaults cf zones to samo.team + samo.green", () => {
    const cmd = parseArgs(["dns", "status", "samo.cat"]);
    if (cmd.kind !== "dns-status") throw new Error("expected dns-status");
    expect(cmd.input.cfZones).toEqual(["samo.team", "samo.green"]);
  });

  test("dns requires the status subcommand", () => {
    expect(() => parseArgs(["dns"])).toThrow(/requires a subcommand/);
    expect(() => parseArgs(["dns", "wat"])).toThrow(/unknown dns subcommand/);
  });
});

// ---------------------------------------------------------------------------
// env preflight command (fake remote)
// ---------------------------------------------------------------------------

/** Remote output mirroring the LIVE SOLO VM (installed shape, dead engine). */
const LIVE_VM_OUTPUT = [
  "<<<SAMOHOST_AUDIT:unit-file>>>",
  "ExecStart=/usr/local/bin/dblab-engine",
  "<<<SAMOHOST_AUDIT:unit-active>>>",
  "inactive",
  "<<<SAMOHOST_AUDIT:unit-enabled>>>",
  "disabled",
  "<<<SAMOHOST_AUDIT:cli-binary>>>",
  "NO_CLI",
  "<<<SAMOHOST_AUDIT:engine-binary>>>",
  "NO_ENGINE_BINARY",
  "<<<SAMOHOST_AUDIT:api-listen>>>",
  "127.0.0.1:5432",
  "<<<SAMOHOST_AUDIT:zfs-datasets>>>",
  "tank/dblab",
  "tank/postgresql",
  "tank/previews",
  "<<<SAMOHOST_AUDIT:postgres-local>>>",
  "127.0.0.1:5432 - accepting connections",
].join("\n");

function fakeDeps(stdout: string, scripts?: string[]): EnvExecDeps {
  return {
    remote: (_vm, script) => {
      scripts?.push(script);
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
    now: () => new Date("2026-06-11T13:00:00.000Z"),
    uuid: () => "uuid-1",
  };
}

describe("runEnvPreflight", () => {
  let dir: string;
  let vmStore: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-pf-"));
    vmStore = new StateStore(join(dir, "state.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("live VM shape: exit 1, engine BLOCKED, template READY, one connection", async () => {
    const scripts: string[] = [];
    const c = capture();
    const code = await runEnvPreflight(
      { vm: "samo-we-field-record" }, { json: false },
      vmStore, fakeDeps(LIVE_VM_OUTPUT, scripts), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(scripts).toHaveLength(1); // ONE batched script = one connection
    expect(c.o).toContain("dblab engine: BLOCKED");
    expect(c.o).toContain("template fallback: READY");
    expect(c.o).toContain("INSTALLED SHAPE ONLY");
  });

  test("running engine: exit 0 and READY (json shape)", async () => {
    const running = LIVE_VM_OUTPUT
      .replace("inactive", "active")
      .replace("NO_CLI", "/usr/local/bin/dblab")
      .replace("127.0.0.1:5432\n<<<SAMOHOST_AUDIT:zfs", "127.0.0.1:2345\n<<<SAMOHOST_AUDIT:zfs");
    const c = capture();
    const code = await runEnvPreflight(
      { vm: "samo-we-field-record" }, { json: true },
      vmStore, fakeDeps(running), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(JSON.parse(c.o).engine).toBe("READY");
  });

  test("unknown vm fails cleanly", async () => {
    const c = capture();
    const code = await runEnvPreflight(
      { vm: "nope" }, { json: false }, vmStore, fakeDeps(""), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found");
  });
});

// ---------------------------------------------------------------------------
// dns status command (fake resolver)
// ---------------------------------------------------------------------------

function dnsDeps(o: {
  ns: LookupResult;
  a: LookupResult;
  token?: string;
}): DnsStatusDeps {
  return {
    resolveNs: () => Promise.resolve(o.ns),
    resolveA: () => Promise.resolve(o.a),
    env: { CLOUDFLARE_API_TOKEN: o.token },
  };
}

describe("runDnsStatus", () => {
  test("live samo.cat shape: exit 1, namecheap, no wildcard", async () => {
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.team", "samo.green"] },
      { json: false },
      dnsDeps({
        ns: { kind: "records", values: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] },
        a: { kind: "nxdomain" },
      }),
      c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.o).toContain("authority: namecheap");
    expect(c.o).toContain("wildcard: absent");
    expect(c.o).toContain("serving_ready: false");
  });

  test("wildcard pointing at the VM: exit 0 even without automation", async () => {
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.team"] },
      { json: true },
      dnsDeps({
        ns: { kind: "records", values: ["dns1.registrar-servers.com"] },
        a: { kind: "records", values: ["178.105.246.151"] },
      }),
      c.out, c.err,
    );
    expect(code).toBe(0);
    const rep = JSON.parse(c.o);
    expect(rep.servingReady).toBe(true);
    expect(rep.automationReady).toBe(false);
  });

  test("token presence is read from env but its value never printed", async () => {
    const c = capture();
    await runDnsStatus(
      { domain: "samo.team", cfZones: ["samo.team"] },
      { json: true },
      dnsDeps({
        ns: { kind: "records", values: ["derek.ns.cloudflare.com"] },
        a: { kind: "records", values: ["178.105.246.151"] },
        token: "super-secret-token-value-1234567890",
      }),
      c.out, c.err,
    );
    expect(JSON.parse(c.o).automationReady).toBe(true);
    expect(c.o).not.toContain("super-secret");
  });
});
