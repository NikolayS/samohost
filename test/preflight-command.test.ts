import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  DEFAULT_CLOUDFLARE_ZONES,
  runDnsStatus,
  type DnsStatusDeps,
} from "../src/commands/dns.ts";
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

  test("dns status defaults cf zones to the CLIENT model: samo.team + samo.cat", () => {
    const cmd = parseArgs(["dns", "status", "samo.cat"]);
    if (cmd.kind !== "dns-status") throw new Error("expected dns-status");
    // Clients use samo.team (prod) + samo.cat (previews). samo.green is samo's
    // OWN dev/platform domain and must never be a client-facing default.
    expect(cmd.input.cfZones).toEqual(["samo.team", "samo.cat"]);
  });

  test("DEFAULT_CLOUDFLARE_ZONES is the client model: includes samo.cat, excludes samo.green", () => {
    expect(DEFAULT_CLOUDFLARE_ZONES).toContain("samo.cat");
    expect(DEFAULT_CLOUDFLARE_ZONES).toContain("samo.team");
    expect(DEFAULT_CLOUDFLARE_ZONES).not.toContain("samo.green");
  });

  test("dns requires the status subcommand", () => {
    expect(() => parseArgs(["dns"])).toThrow(/requires a subcommand/);
    expect(() => parseArgs(["dns", "wat"])).toThrow(/unknown dns subcommand/);
  });
});

// ---------------------------------------------------------------------------
// env preflight command (fake remote)
// ---------------------------------------------------------------------------

/**
 * Remote output mirroring the LIVE SOLO VM (runtime-verified 2026-06-12,
 * issue #7): engine runs as the dblab_server container, healthz answers,
 * CLI at ~agent/bin/dblab. healthz body captured verbatim.
 */
const LIVE_VM_OUTPUT = [
  "<<<SAMOHOST_AUDIT:engine-healthz>>>",
  '{"version":"v4.1.3-20260508-1125","edition":"community","instanceID":"d8lkc7q52olc73a3g70g"}',
  "<<<SAMOHOST_AUDIT:engine-container>>>",
  "postgresai/dblab-server:4.1.3 Up 2 hours",
  "<<<SAMOHOST_AUDIT:cli-binary>>>",
  "/home/agent/bin/dblab",
  "<<<SAMOHOST_AUDIT:api-listen>>>",
  "127.0.0.1:5432",
  "127.0.0.1:2345",
  "<<<SAMOHOST_AUDIT:zfs-datasets>>>",
  "tank/dblab",
  "tank/postgresql",
  "tank/previews",
  "<<<SAMOHOST_AUDIT:postgres-local>>>",
  "127.0.0.1:5432 - accepting connections",
].join("\n");

/** The pre-install shape: engine down, no CLI anywhere. */
const ENGINE_DOWN_OUTPUT = LIVE_VM_OUTPUT
  .replace(/\{"version[^\n]*/, "NO_HEALTHZ")
  .replace("postgresai/dblab-server:4.1.3 Up 2 hours", "NO_CONTAINER")
  .replace("/home/agent/bin/dblab", "NO_CLI")
  .replace("\n127.0.0.1:2345", "");

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

  test("LIVE VM shape (engine container up): exit 0, READY, one connection", async () => {
    const scripts: string[] = [];
    const c = capture();
    const code = await runEnvPreflight(
      { vm: "samo-we-field-record" }, { json: false },
      vmStore, fakeDeps(LIVE_VM_OUTPUT, scripts), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(scripts).toHaveLength(1); // ONE batched script = one connection
    expect(c.o).toContain("dblab engine: READY");
    expect(c.o).toContain("template fallback: READY");
    // The container model is reported, and the retired unit is not probed.
    expect(c.o).toContain("postgresai/dblab-server:4.1.3");
    expect(scripts[0]).not.toContain("dblab.service");
    expect(scripts[0]).toContain("healthz");
  });

  test("engine down (pre-install shape): exit 1, BLOCKED with runbook pointer (json)", async () => {
    const c = capture();
    const code = await runEnvPreflight(
      { vm: "samo-we-field-record" }, { json: true },
      vmStore, fakeDeps(ENGINE_DOWN_OUTPUT), c.out, c.err,
    );
    expect(code).toBe(1);
    const rep = JSON.parse(c.o);
    expect(rep.engine).toBe("BLOCKED");
    expect(rep.reasons.join("\n")).toContain("docs/dblab-install-runbook.md");
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
  cfRecordLookup?: DnsStatusDeps["cfRecordLookup"];
}): DnsStatusDeps {
  return {
    resolveNs: () => Promise.resolve(o.ns),
    resolveA: () => Promise.resolve(o.a),
    env: { CLOUDFLARE_API_TOKEN: o.token },
    ...(o.cfRecordLookup !== undefined ? { cfRecordLookup: o.cfRecordLookup } : {}),
  };
}

const CF_NS: LookupResult = {
  kind: "records",
  values: ["derek.ns.cloudflare.com", "jade.ns.cloudflare.com"],
};
const EDGE_IPS: LookupResult = {
  kind: "records",
  values: ["104.21.51.28", "172.67.220.4"],
};

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

  test("LIVE proxied shape: CF API confirms origin -> exit 0, present+proxied, edge IPs not a mismatch", async () => {
    const calls: string[][] = [];
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.cat"] },
      { json: true },
      dnsDeps({
        ns: CF_NS,
        a: EDGE_IPS,
        token: "tok-value",
        cfRecordLookup: (token, zone, name) => {
          calls.push([token, zone, name]);
          return Promise.resolve({
            found: true,
            content: "178.105.246.151",
            proxied: true,
          });
        },
      }),
      c.out, c.err,
    );
    expect(code).toBe(0);
    const rep = JSON.parse(c.o);
    expect(rep.wildcard).toBe("present");
    expect(rep.wildcardSource).toBe("cloudflare-api");
    expect(rep.proxied).toBe(true);
    expect(rep.servingReady).toBe(true);
    expect(rep.automationReady).toBe(true);
    expect(calls).toEqual([["tok-value", "samo.cat", "*.samo.cat"]]);
    expect(c.o).not.toContain("tok-value"); // token never printed
  });

  test("CF record targeting the wrong origin: exit 1, mismatch via cloudflare-api", async () => {
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.cat"] },
      { json: true },
      dnsDeps({
        ns: CF_NS,
        a: EDGE_IPS,
        token: "tok-value",
        cfRecordLookup: () =>
          Promise.resolve({ found: true, content: "1.2.3.4", proxied: true }),
      }),
      c.out, c.err,
    );
    expect(code).toBe(1);
    const rep = JSON.parse(c.o);
    expect(rep.wildcard).toBe("mismatch");
    expect(rep.wildcardSource).toBe("cloudflare-api");
  });

  test("CF lookup errors are REDACTED before reaching output", async () => {
    const secret = "cf-secret-token-abcdef123456";
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.cat"] },
      { json: true },
      dnsDeps({
        ns: CF_NS,
        a: EDGE_IPS,
        token: secret,
        cfRecordLookup: () =>
          Promise.reject(
            new Error(`request failed for Bearer ${secret} at /zones`),
          ),
      }),
      c.out, c.err,
    );
    expect(code).toBe(1); // falls back to public-dns judgment: unknown on a CF zone
    expect(c.o + c.e).not.toContain(secret);
    expect(c.o).toContain("REDACTED");
    expect(c.o).toContain("cloudflare api read failed");
    expect(JSON.parse(c.o).wildcard).toBe("unknown");
  });

  test("missing token: CF lookup never attempted, edge IPs reported unknown not mismatch", async () => {
    let lookupCalled = false;
    const c = capture();
    const code = await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.cat"] },
      { json: true },
      dnsDeps({
        ns: CF_NS,
        a: EDGE_IPS,
        cfRecordLookup: () => {
          lookupCalled = true;
          return Promise.resolve({ found: true, content: "x" });
        },
      }),
      c.out, c.err,
    );
    expect(code).toBe(1);
    expect(lookupCalled).toBe(false);
    const rep = JSON.parse(c.o);
    expect(rep.wildcard).toBe("unknown");
    expect(rep.automationReady).toBe(false);
  });

  test("zone not in --cf-zone coverage: CF lookup not attempted", async () => {
    let lookupCalled = false;
    const c = capture();
    await runDnsStatus(
      { domain: "samo.cat", expectIp: "178.105.246.151", cfZones: ["samo.team"] },
      { json: true },
      dnsDeps({
        ns: CF_NS,
        a: EDGE_IPS,
        token: "tok",
        cfRecordLookup: () => {
          lookupCalled = true;
          return Promise.resolve({ found: false });
        },
      }),
      c.out, c.err,
    );
    expect(lookupCalled).toBe(false);
  });
});
