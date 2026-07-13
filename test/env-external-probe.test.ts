/**
 * TDD spec for external HTTPS reachability gate on env create (samohost #55).
 *
 * Root cause: the on-host health phase runs `curl http://localhost:PORT/` inside
 * the remote bash script, so it returns ok even when the preview is EXTERNALLY
 * unreachable (TLS not yet provisioned, DNS not propagated, Caddy not listening
 * on the public port, etc.). This is the same false-success class as #45.
 *
 * Fix: after the on-host create script reports ok AND an httpProbe dep is wired,
 * runEnvCreate performs a real EXTERNAL HTTPS check before reporting success.
 * - URL: https://<vhost>/
 * - Expects HTTP 200; any non-200 or thrown error is a failure.
 * - Bounded retry: max EXTERNAL_PROBE_RETRIES=8, EXTERNAL_PROBE_SLEEP_MS=5000
 *   (SAFETY CAPS, not targets — returns immediately on first 200).
 * - On ultimate failure: outcome downgraded to "failed", exit code 1, env record
 *   kept for inspection (idempotent re-run), DNS record kept.
 *
 * The dep is OPTIONAL so existing fixtures { remote, now, uuid } compile unchanged.
 * When absent, behavior is unchanged (no external gate).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvCreate,
  type EnvExecDeps,
} from "../src/commands/env.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures — prod-shape data (mirrors env-dns.test.ts)
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
    dbBackend: "none",
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

// Phase marker helpers
const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;

// Full successful on-host output: all phases complete
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");

// Failed on-host output (build fails)
const CREATE_FAIL = [
  M("clone", "start"), M("clone", "ok"),
  M("build", "start"), M("build", "fail"),
].join("\n");

// No-op sleep that returns immediately (prevents tests sleeping 25s)
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

// Remote that always returns CREATE_OK from on-host script
function fakeRemote(output: string): EnvExecDeps["remote"] {
  return (_vm, _script) =>
    Promise.resolve({ code: 0, stdout: output, stderr: "" });
}

// The expected vhost for app "myapp", branch "feat/preview", domain "samo.cat"
const EXPECTED_VHOST = "myapp-feat-preview.samo.cat";

// ---------------------------------------------------------------------------
// Test stores
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-ext-probe-"));
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

describe("env-external-probe: external HTTPS reachability gate (issue #55)", () => {

  // (a) CORE RED TEST: on-host ok BUT external probe returns 502 for all attempts
  //     → exit 1, outcome "failed", err mentions vhost + unreachable
  test("(a) on-host ok but probe always 502 → exit 1, outcome=failed, err mentions vhost", async () => {
    let probeCalls = 0;
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => {
        probeCalls++;
        return { status: 502, ok: false };
      },
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    // probe must have been called (at least once, up to cap)
    expect(probeCalls).toBeGreaterThan(0);
    // err must mention the vhost
    expect(c.e).toMatch(/myapp-feat-preview\.samo\.cat/);
    // err must mention unreachable (or similar)
    expect(c.e).toMatch(/unreachable|external|502/i);
    // env record must still be persisted (idempotent re-run)
    const rec = envStore.get("vm-gc1", "myapp", "feat/preview");
    expect(rec).toBeDefined();
    expect(rec?.vhost).toBe(EXPECTED_VHOST);
  });

  // Also test JSON output: report.outcome === "failed"
  test("(a-json) JSON output: report.outcome=failed when probe fails", async () => {
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => ({ status: 502, ok: false }),
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: true }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    const report = JSON.parse(c.o);
    expect(report.outcome).toBe("failed");
  });

  // (b) on-host ok AND probe returns 200 on first attempt → exit 0, outcome=ok,
  //     httpProbe called with exactly `https://<vhost>/`
  test("(b) on-host ok + probe 200 on first attempt → exit 0, outcome=ok", async () => {
    const probedUrls: string[] = [];
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (url: string) => {
        probedUrls.push(url);
        return { status: 200, ok: true };
      },
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("ok");
    // probe was called exactly once (stopped on first 200)
    expect(probedUrls).toHaveLength(1);
    // called with the correct URL
    expect(probedUrls[0]).toBe(`https://${EXPECTED_VHOST}/`);
  });

  // (c) external probe THROWS on every attempt → treated as failure → exit 1, outcome=failed
  test("(c) probe throws TLS error on every attempt → exit 1, outcome=failed", async () => {
    let probeCalls = 0;
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => {
        probeCalls++;
        throw new Error("TLS handshake failed");
      },
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    expect(probeCalls).toBeGreaterThan(0);
    expect(c.e).toMatch(/unreachable|external|TLS|error/i);
    // env record kept for inspection
    expect(envStore.get("vm-gc1", "myapp", "feat/preview")).toBeDefined();
  });

  // (d) probe fails on attempt 1 then 200 on attempt 2 (flaky-first-create) →
  //     exit 0, outcome=ok; httpProbe called twice, sleep called once
  test("(d) probe: fail then 200 on retry → exit 0, outcome=ok; probe×2, sleep×1", async () => {
    let probeCallCount = 0;
    let sleepCallCount = 0;
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => {
        probeCallCount++;
        if (probeCallCount === 1) return { status: 503, ok: false };
        return { status: 200, ok: true };
      },
      sleep: async (_ms: number) => {
        sleepCallCount++;
      },
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("ok");
    // httpProbe called exactly twice (attempt 1 failed, attempt 2 succeeded)
    expect(probeCallCount).toBe(2);
    // sleep called exactly once (between attempt 1 and attempt 2)
    expect(sleepCallCount).toBe(1);
  });

  // (e) NO httpProbe dep present → behavior unchanged, exit 0 on CREATE_OK (back-compat)
  test("(e) no httpProbe dep → unchanged behavior, exit 0 on CREATE_OK", async () => {
    let n = 0;
    // Intentionally omit httpProbe and sleep — existing fixture shape
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_OK),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      // httpProbe: omitted
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/preview",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    // Should succeed as before — no external gate applied
    expect(code).toBe(0);
    expect(c.o).toContain("ok");
  });

  // (f) when on-host outcome is already "failed"/"incomplete", probe must NOT run
  test("(f) on-host outcome=failed → httpProbe never called", async () => {
    let probeCalls = 0;
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(CREATE_FAIL),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => {
        probeCalls++;
        return { status: 200, ok: true };
      },
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/probe-skip",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    // probe must NOT have been called — on-host already failed
    expect(probeCalls).toBe(0);
  });

  // (f-incomplete) also test incomplete on-host outcome
  test("(f-incomplete) on-host outcome=incomplete → httpProbe never called", async () => {
    // Incomplete: a start with no terminal
    const incompleteOut = M("clone", "start"); // no ok/fail
    let probeCalls = 0;
    let n = 0;
    const deps: EnvExecDeps = {
      remote: fakeRemote(incompleteOut),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      httpProbe: async (_url: string) => {
        probeCalls++;
        return { status: 200, ok: true };
      },
      sleep: noopSleep,
    };
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-gc1", app: "myapp", branch: "feat/probe-skip-inc",
        db: "none", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    expect(probeCalls).toBe(0);
  });
});
