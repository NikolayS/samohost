/**
 * TDD spec for per-VM preview DNS routing (samohost issue #37, updated #54).
 *
 * Design (issue #54): when `env create` succeeds, samohost ensures a PROXIED
 * Cloudflare A record `<preview-host>.samo.cat -> vm.ip` BEFORE pushing the
 * create script. PROXIED (orange cloud) is required so the CF edge fronts the
 * origin; the origin serves self-signed HTTPS via Caddy `tls internal` which
 * CF Full mode accepts. This works even when the VM firewalls origin :443 to
 * CF IPs only. When `env destroy` succeeds, samohost removes that record. Both
 * operations gracefully degrade to a warning when no DNS provider is configured.
 *
 * These tests inject a fake DnsProviderPort to exercise the real
 * runEnvCreate / runEnvDestroy code paths — no mocking of the commands
 * themselves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DnsProviderPort, DnsRecord, FetchFn } from "../src/dns/cloudflare.ts";
import { resolveZoneId, CloudflareError } from "../src/dns/cloudflare.ts";
import {
  runEnvCreate,
  runEnvDestroy,
  type EnvExecDeps,
} from "../src/commands/env.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures — prod-shape data
// ---------------------------------------------------------------------------

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-gc1",
    provider: "hetzner",
    providerId: "999111",
    name: "samo-gc1",
    ip: "46.225.115.31",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 22,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "fsn1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function appRec(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-gc1",
    vmId: "vm-gc1",
    name: "myapp",
    repo: "Tanya301/myapp",
    branch: "main",
    appDir: "/opt/myapp/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "myapp",
    ...o,
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

// Phase marker helpers — copy exact format from env-command.test.ts
const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;

// Success output: all phases complete with :ok markers
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");

// Failure output: a phase emits :fail — outcome = "failed" per parseEnvOutcome
const CREATE_FAIL = [
  M("clone", "start"), M("clone", "ok"),
  M("build", "start"), M("build", "fail"),
].join("\n");

const DESTROY_OK = ["unit-stop", "vhost-remove", "db-drop", "dir-remove"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");

// ---------------------------------------------------------------------------
// Fake DnsProviderPort — records every call for assertion
// ---------------------------------------------------------------------------

interface DnsCall {
  method: "ensure" | "remove" | "list";
  name: string;
  type: string;
  content?: string;
  proxied?: boolean;
}

function fakeDnsProvider(): { provider: DnsProviderPort; calls: DnsCall[] } {
  const calls: DnsCall[] = [];
  const provider: DnsProviderPort = {
    listRecords(name, type) {
      calls.push({ method: "list", name, type });
      return Promise.resolve([]);
    },
    ensureRecord(name, type, content, proxied) {
      calls.push({ method: "ensure", name, type, content, proxied });
      const rec: DnsRecord = { id: "fake-rec-1", type, name, content, proxied };
      return Promise.resolve(rec);
    },
    removeRecord(name, type) {
      calls.push({ method: "remove", name, type });
      return Promise.resolve(1);
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Fake remote runner producing a given stdout
// ---------------------------------------------------------------------------

function fakeRemote(output: string): EnvExecDeps["remote"] {
  return (_vm, _script) =>
    Promise.resolve({ code: 0, stdout: output, stderr: "" });
}

// ---------------------------------------------------------------------------
// Test stores
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-env-dns-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
  vmStore.upsert(vm());
  appStore.upsert(appRec());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("env-dns: per-VM preview DNS (issue #37 / #54)", () => {
  test("create: ensureRecord called with (target.vhost, A, vm.ip, proxied=true) on success — PROXIED required so CF fronts the CF-locked origin (issue #54)", async () => {
    const { provider, calls } = fakeDnsProvider();
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => provider,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview-dns",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    // DNS must have been called exactly once
    const ensureCalls = calls.filter((c) => c.method === "ensure");
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]!.name).toBe("myapp-feat-preview-dns.samo.cat");
    expect(ensureCalls[0]!.type).toBe("A");
    expect(ensureCalls[0]!.content).toBe("46.225.115.31"); // vm.ip
    // PROXIED=true so CF edge fronts the origin; origin serves tls internal
    // which CF Full mode accepts; works even when VM firewalls :443 to CF only.
    expect(ensureCalls[0]!.proxied).toBe(true);
  });

  test("create: DNS ensured BEFORE remote script is pushed", async () => {
    const { provider } = fakeDnsProvider();
    const order: string[] = [];
    let n = 0;
    const deps: EnvExecDeps = {
      remote: (_vm, _script) => {
        order.push("remote");
        return Promise.resolve({ code: 0, stdout: CREATE_OK, stderr: "" });
      },
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => {
        const origEnsure = provider.ensureRecord.bind(provider);
        const wrapped: DnsProviderPort = {
          listRecords: provider.listRecords.bind(provider),
          removeRecord: provider.removeRecord.bind(provider),
          ensureRecord(name: string, type: string, content: string, proxied: boolean) {
            order.push("dns-ensure");
            return origEnsure(name, type, content, proxied);
          },
        };
        return wrapped;
      },
    };
    const c = capture();
    await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/order-check",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    // DNS call must appear before remote call
    const dnsIdx = order.indexOf("dns-ensure");
    const remoteIdx = order.indexOf("remote");
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(remoteIdx).toBeGreaterThanOrEqual(0);
    expect(dnsIdx).toBeLessThan(remoteIdx);
  });

  test("create: DNS NOT called when {vm,app} resolution fails", async () => {
    const { provider, calls } = fakeDnsProvider();
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => provider,
    };
    const c = capture();
    // Use an unknown VM — resolve will fail before DNS is touched
    const code = await runEnvCreate(
      { vm: "nonexistent-vm", app: "myapp", branch: "feat/preview-dns",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("create: DNS failure warns via err and CONTINUES (create still runs)", async () => {
    let n = 0;
    const throwingProvider: DnsProviderPort = {
      listRecords: () => Promise.resolve([]),
      ensureRecord: () => Promise.reject(new Error("CF API unreachable")),
      removeRecord: () => Promise.resolve(0),
    };
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => throwingProvider,
    };
    const c = capture();
    // Should NOT throw; create must still complete
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/dns-fail",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    // Create succeeded despite DNS failure
    expect(code).toBe(0);
    // A warning must have been emitted via err
    expect(c.e).toMatch(/dns|cloudflare|CF API/i);
  });

  test("create: failed create outcome leaves DNS record (idempotent re-create reuses it)", async () => {
    const { provider, calls } = fakeDnsProvider();
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_FAIL),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => provider,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/fail-run",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    // outcome = "failed" → exit code 1
    expect(code).toBe(1);
    // DNS record WAS ensured (it is left for idempotent re-create)
    const ensureCalls = calls.filter((cc) => cc.method === "ensure");
    expect(ensureCalls).toHaveLength(1);
    // remove was NOT called after the failed create
    const removeCalls = calls.filter((cc) => cc.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });

  test("destroy: removeRecord called with (env.vhost, A) on success", async () => {
    // First create the env
    const { provider: createProvider } = fakeDnsProvider();
    let n = 0;
    const createDeps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => createProvider,
    };
    await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/to-destroy",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, createDeps, capture().out, capture().err,
    );

    // Now destroy with a fresh DNS provider
    const { provider: destroyProvider, calls: destroyCalls } = fakeDnsProvider();
    const destroyDeps: EnvExecDeps = {
      remote: fakeRemote(DESTROY_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => destroyProvider,
    };
    const c = capture();
    const code = await runEnvDestroy(
      { vm: "samo-gc1", app: "myapp", branch: "feat/to-destroy" },
      { json: false }, vmStore, appStore, envStore, destroyDeps, c.out, c.err,
    );
    expect(code).toBe(0);
    const removeCalls = destroyCalls.filter((cc) => cc.method === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]!.name).toBe("myapp-feat-to-destroy.samo.cat");
    expect(removeCalls[0]!.type).toBe("A");
  });

  test("destroy: DNS NOT called (and record not removed) when destroy outcome is not ok", async () => {
    // Create the env first
    let n = 0;
    const createDeps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => fakeDnsProvider().provider,
    };
    await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/destroy-fail",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, createDeps, capture().out, capture().err,
    );

    // Destroy with a FAILED outcome
    const failOutput = [M("unit-stop", "start"), M("unit-stop", "fail")].join("\n");
    const { provider: failProvider, calls: failCalls } = fakeDnsProvider();
    const failDeps: EnvExecDeps = {
      remote: fakeRemote(failOutput),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => failProvider,
    };
    const c = capture();
    const code = await runEnvDestroy(
      { vm: "samo-gc1", app: "myapp", branch: "feat/destroy-fail" },
      { json: false }, vmStore, appStore, envStore, failDeps, c.out, c.err,
    );
    expect(code).toBe(1);
    // DNS remove must NOT have been called — destroy did not complete
    expect(failCalls.filter((cc) => cc.method === "remove")).toHaveLength(0);
  });

  test("destroy: DNS failure warns via err and CONTINUES (record still removed from state)", async () => {
    let n = 0;
    const createDeps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => fakeDnsProvider().provider,
    };
    await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/dns-remove-fail",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, createDeps, capture().out, capture().err,
    );

    const throwingProvider: DnsProviderPort = {
      listRecords: () => Promise.resolve([]),
      ensureRecord: () => Promise.resolve({ id: "x", type: "A", name: "", content: "", proxied: false }),
      removeRecord: () => Promise.reject(new Error("CF API gone")),
    };
    const destroyDeps: EnvExecDeps = {
      remote: fakeRemote(DESTROY_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => throwingProvider,
    };
    const c = capture();
    const code = await runEnvDestroy(
      { vm: "samo-gc1", app: "myapp", branch: "feat/dns-remove-fail" },
      { json: false }, vmStore, appStore, envStore, destroyDeps, c.out, c.err,
    );
    // Destroy should still succeed (exit 0) and warn about DNS
    expect(code).toBe(0);
    expect(c.e).toMatch(/dns|cloudflare|CF API/i);
    // The env record should still be removed from state
    expect(envStore.get("vm-gc1", "myapp", "feat/dns-remove-fail")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Graceful degrade: NO DNS provider
  // ---------------------------------------------------------------------------

  test("graceful degrade: create without dns dep emits one warning and still succeeds", async () => {
    let n = 0;
    // Omit 'dns' entirely — the dep is optional (must not break existing { remote, now, uuid } shape)
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      // dns: omitted
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/no-dns",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    // Exactly one warning line mentioning only CLOUDFLARE_SAMOCAT (zone-id is no
    // longer required — it is resolved automatically from the token; issue #54).
    const warnLines = c.e.split("\n").filter((l) => l.includes("CLOUDFLARE_SAMOCAT"));
    expect(warnLines).toHaveLength(1);
    // Zone-id env var is NO LONGER required in the warning message — the token
    // alone is sufficient now (samohost resolves the zone id via zones:list).
    expect(warnLines[0]).not.toContain("SAMOHOST_SAMOCAT_ZONE_ID");
  });

  test("graceful degrade: destroy without dns dep emits one warning and still succeeds", async () => {
    // Create the env first (also without dns)
    let n = 0;
    const nodns: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
    };
    await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/no-dns-destroy",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, nodns, capture().out, capture().err,
    );

    const destroyDeps: EnvExecDeps = {
      remote: fakeRemote(DESTROY_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      // dns: omitted
    };
    const c = capture();
    const code = await runEnvDestroy(
      { vm: "samo-gc1", app: "myapp", branch: "feat/no-dns-destroy" },
      { json: false }, vmStore, appStore, envStore, destroyDeps, c.out, c.err,
    );
    expect(code).toBe(0);
    const warnLines = c.e.split("\n").filter((l) => l.includes("CLOUDFLARE_SAMOCAT"));
    expect(warnLines).toHaveLength(1);
  });

  test("graceful degrade: factory returning undefined behaves same as omitted dep", async () => {
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-15T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      dns: () => undefined, // factory returns undefined — no token configured
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/undefined-provider",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    const warnLines = c.e.split("\n").filter((l) => l.includes("CLOUDFLARE_SAMOCAT"));
    expect(warnLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveZoneId unit tests (issue #54 third bullet)
// ---------------------------------------------------------------------------

/** Minimal scripted fetch for resolveZoneId tests. */
function fakeZoneFetch(responses: Array<{ status?: number; json: unknown }>): FetchFn {
  return (_input, _init) => {
    const r = responses.shift();
    if (!r) throw new Error("fakeZoneFetch: no scripted response left");
    return Promise.resolve(
      new Response(JSON.stringify(r.json), { status: r.status ?? 200 }),
    );
  };
}

const zoneOk = (id: string) => ({
  json: { success: true, errors: [], result: [{ id }] },
});
const zoneEmpty = () => ({
  json: { success: true, errors: [], result: [] },
});

describe("resolveZoneId (issue #54): zone-id self-resolution from token", () => {
  test("resolves and returns the zone id when exactly one zone is found", async () => {
    const fetchFn = fakeZoneFetch([zoneOk("zone-abc-123")]);
    const id = await resolveZoneId({ token: "tok", fetchFn }, "samo.cat");
    expect(id).toBe("zone-abc-123");
  });

  test("throws CloudflareError(404, ...) when zero zones are returned — never silent", async () => {
    const fetchFn = fakeZoneFetch([zoneEmpty()]);
    await expect(
      resolveZoneId({ token: "tok", fetchFn }, "samo.cat"),
    ).rejects.toBeInstanceOf(CloudflareError);
    // Error must mention the zone name and not the token value.
    try {
      const fetchFn2 = fakeZoneFetch([zoneEmpty()]);
      await resolveZoneId({ token: "secret-token", fetchFn: fetchFn2 }, "samo.cat");
    } catch (e) {
      expect((e as Error).message).toContain("samo.cat");
      expect((e as Error).message).not.toContain("secret-token");
      expect((e as CloudflareError).status).toBe(404);
    }
  });

  test("requests /zones?name=<zoneName> — reuses same path as lookupWildcardRecord", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = (input) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(zoneOk("z1").json), { status: 200 }),
      );
    };
    await resolveZoneId({ token: "tok", fetchFn }, "samo.cat");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/zones?name=samo.cat");
  });

  test("CloudflareDns lazily resolves its own zone id when constructed with zoneName only", async () => {
    // Simulate: token present, zone-id env var absent → CloudflareDns(zoneName)
    // First call goes to /zones?name=... to resolve the id, then to the write endpoint.
    const { CloudflareDns: CfDns } = await import("../src/dns/cloudflare.ts");
    const responses: Array<{ status?: number; json: unknown }> = [
      zoneOk("zone-lazy-1"), // zone lookup
      { json: { success: true, errors: [], result: [] } }, // listRecords (ensureRecord first call)
      { json: { success: true, errors: [], result: { id: "new-rec", type: "A", name: "x.samo.cat", content: "1.2.3.4", proxied: true } } }, // POST
    ];
    const fetchFn = fakeZoneFetch(responses);
    const lazyCf = new CfDns({ token: "tok", zoneName: "samo.cat", fetchFn });
    const rec = await lazyCf.ensureRecord("x.samo.cat", "A", "1.2.3.4", true);
    expect(rec.id).toBe("new-rec");
  });
});
