/**
 * Tests for `samohost trigger run` — samo-level auto-deploy poller (issue #50).
 *
 * RED phase: these tests MUST FAIL before the implementation is written.
 *
 * Design principles being tested:
 *  - Trigger is a thin iteration layer over runAppDeploy; it does NOT
 *    re-implement the CI gate, known-bad guard, health gate, or rollback.
 *  - The injected `deploy` is the CURRIED form (AppDeployDeps already bound
 *    inside it). No separate deployDeps field.
 *  - The trigger always passes the resolved SHA explicitly so runAppDeploy
 *    never resolves twice.
 *  - Per-app isolation: one app's failure/throw must not abort the cycle.
 *  - Exit 0 when all candidates are {deployed, up-to-date, known-bad, skipped}.
 *  - Exit 1 when any app's deploy returned non-zero or threw.
 *
 * New in #52: trigger calls checkCiGreen (via injected fetch) BEFORE deciding
 * to call deps.deploy. pending/none/red CI → action=skipped (transient, exit 0).
 * Only on CI "success" does trigger call deps.deploy. Genuine deploy-execution
 * failures (deploy returned non-zero) remain action=failed (exit 1). Same-SHA
 * and known-bad short-circuit BEFORE the CI call (no unnecessary fetch).
 * Dry-run is also offline-safe (no CI call, no deploy).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runTriggerRun,
  type TriggerRunInput,
  type TriggerDeps,
  type TriggerRunReport,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";
import type { AppDeployInput } from "../src/commands/app.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SHA_A = "aaa1111aaa2222aaa3333aaa4444aaa555566666";
const SHA_OLD = "000000000000000000000000000000000000000a";
const SHA_FAILED = "ffffffffffffffffffffffffffffffffffffffff";

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
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
    ...o,
  };
}

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111",
    vmId: "vm-1111",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    serviceUnit: "field-record",
    healthUrl: "http://localhost:3000/api/version",
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

// ---------------------------------------------------------------------------
// Fake deploy factory: records calls; returns configurable exit code.
// ---------------------------------------------------------------------------

interface DeployCall {
  input: AppDeployInput;
}

function makeFakeDeploy(exitCode = 0): {
  deploy: TriggerDeps["deploy"];
  calls: DeployCall[];
} {
  const calls: DeployCall[] = [];
  const deploy: TriggerDeps["deploy"] = async (input, _opts, _vmStore, _appStore, _out, _err) => {
    calls.push({ input });
    return exitCode;
  };
  return { deploy, calls };
}

// ---------------------------------------------------------------------------
// Fake fetch factory: returns a workflow_runs response with the given CI state.
// Records whether it was called and how many times.
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch that returns the given workflow_runs payload.
 * Mimics the same pattern used in test/app-cigate.test.ts.
 */
function makeFakeFetch(
  runs: Array<{ status?: string; conclusion?: string | null }>,
  opts: { ok?: boolean } = {},
): { fetch: typeof globalThis.fetch; callCount: () => number } {
  let count = 0;
  const fakeFetch = (async (_url: unknown, _init?: unknown) => {
    count++;
    return {
      ok: opts.ok ?? true,
      json: async () => ({ workflow_runs: runs }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, callCount: () => count };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe("trigger run", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-trigger-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // -------------------------------------------------------------------------
  // NEW Test 1 (brief #52 case 1): new SHA, CI success →
  //   deploy called once, action=deployed, exit 0
  // -------------------------------------------------------------------------
  test("new-1 — new SHA, CI success: deploy called once; action=deployed; exit 0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: (_repo, _branch) => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date("2026-06-15T10:00:00.000Z"),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    // CI must have been checked
    expect(callCount()).toBeGreaterThanOrEqual(1);
    // deploy must have been called exactly once
    expect(calls.length).toBe(1);
    // resolved SHA must be passed explicitly
    expect(calls[0]!.input.sha).toBe(SHA_A);
    expect(calls[0]!.input.app).toBe("field-record");
    expect(calls[0]!.input.vm).toBe("samo-we-field-record");

    expect(report.results[0]!.action).toBe("deployed");
    expect(report.deployed).toBe(1);
    expect(report.failed).toBe(0);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 2 (brief #52 case 2): new SHA, CI pending →
  //   deploy NOT called, action=skipped, reason=ci-pending, exit 0
  // -------------------------------------------------------------------------
  test("new-2 — new SHA, CI pending: deploy NOT called; action=skipped; reason=ci-pending; exit 0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "in_progress", conclusion: null },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    expect(callCount()).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("ci-pending");
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 3 (brief #52 case 3): new SHA, CI failure →
  //   deploy NOT called, action=skipped, reason=ci-red, exit 0
  // -------------------------------------------------------------------------
  test("new-3 — new SHA, CI failure: deploy NOT called; action=skipped; reason=ci-red; exit 0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "failure" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    expect(callCount()).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("ci-red");
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 4 (brief #52 case 4): new SHA, CI none (empty runs) →
  //   deploy NOT called, action=skipped, reason=ci-none, exit 0
  // -------------------------------------------------------------------------
  test("new-4 — new SHA, CI none: deploy NOT called; action=skipped; reason=ci-none; exit 0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([]); // empty runs → "none"

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    expect(callCount()).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("ci-none");
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 5 (brief #52 case 5): new SHA, CI success, but deploy returns
  //   non-zero (genuine deploy failure) →
  //   action=failed, report.failed===1, exit 1
  // -------------------------------------------------------------------------
  test("new-5 — new SHA, CI success, deploy fails: action=failed; failed===1; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    // CI says green, but deploy execution fails
    const { deploy, calls } = makeFakeDeploy(1);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    // CI was checked
    expect(callCount()).toBeGreaterThanOrEqual(1);
    // deploy was called (CI was green)
    expect(calls.length).toBe(1);

    const result = report.results[0]!;
    expect(result.action).toBe("failed");
    expect(report.failed).toBe(1);
    expect(report.deployed).toBe(0);
    expect(code).toBe(1);
  });

  // -------------------------------------------------------------------------
  // NEW Test 6 (brief #52 case 6): same-SHA → up-to-date, NO CI call
  //   (fetch must NOT be invoked for this app)
  // -------------------------------------------------------------------------
  test("new-6 — same-SHA: action=up-to-date; NO CI call (fetch not invoked)", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_A }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    // No CI call — up-to-date short-circuits before CI check
    expect(callCount()).toBe(0);
    expect(calls.length).toBe(0);
    expect(report.results[0]!.action).toBe("up-to-date");
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 7 (brief #52 case 7): known-bad SHA → known-bad, NO CI call
  // -------------------------------------------------------------------------
  test("new-7 — known-bad SHA: action=known-bad; NO CI call (fetch not invoked)", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ failedSha: SHA_FAILED }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_FAILED),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    // No CI call — known-bad short-circuits before CI check
    expect(callCount()).toBe(0);
    expect(calls.length).toBe(0);
    expect(report.results[0]!.action).toBe("known-bad");
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 8 (brief #52 case 8): --dry-run, new SHA →
  //   would-deploy, NO deploy, NO CI call (offline-safe)
  // -------------------------------------------------------------------------
  test("new-8 — dry-run, new SHA: action=would-deploy; NO deploy; NO CI call", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: true }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);

    // dry-run must not call CI or deploy
    expect(callCount()).toBe(0);
    expect(calls.length).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("would-deploy");
    expect(result.sha).toBe(SHA_A);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // NEW Test 9 (brief #52 case 9): per-app isolation preserved —
  //   two apps, first's deploy throws → second still processed; exit 1
  //   (Note: both apps get CI=success so deploy IS called for both)
  // -------------------------------------------------------------------------
  test("new-9 — isolation: first deploy throws; second still processed; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ name: "app-one", id: "app-one-id", deployedSha: SHA_OLD }));
    appStore.upsert(makeApp({ name: "app-two", id: "app-two-id", deployedSha: SHA_OLD }));

    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    let callCount = 0;
    const deploy: TriggerDeps["deploy"] = async (input, _opts, _vmStore, _appStore, _out, _err) => {
      callCount++;
      if (input.app === "app-one") throw new Error("network failure");
      return 0;
    };

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.results.length).toBe(2);

    const appOneResult = report.results.find((r) => r.app === "app-one")!;
    const appTwoResult = report.results.find((r) => r.app === "app-two")!;

    expect(appOneResult).toBeDefined();
    expect(appTwoResult).toBeDefined();
    expect(appOneResult.action).toBe("error");
    // second app was still processed (CI checked + deploy attempted)
    expect(["deployed", "failed", "up-to-date"].includes(appTwoResult.action)).toBe(true);

    // cycle exit must be 1 because of the error
    expect(code).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Existing tests — kept for regression (reframed where needed for #52)
  // -------------------------------------------------------------------------

  // Test 1 (original): basic deploy path — CI success → deploy called once.
  // Now uses fetch injection because trigger calls checkCiGreen.
  test("1 — new SHA: deploy called once with resolved SHA; action=deployed; deployed===1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: (_repo, _branch) => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date("2026-06-15T10:00:00.000Z"),
    };

    const c = capture();
    const input: TriggerRunInput = { dryRun: false };
    const code = await runTriggerRun(input, { json: false }, vmStore, appStore, deps, c.out, c.err);

    // deploy must have been called exactly once
    expect(calls.length).toBe(1);
    // resolved SHA must be passed explicitly (never re-resolve)
    expect(calls[0]!.input.sha).toBe(SHA_A);
    // app name and vm must be correct
    expect(calls[0]!.input.app).toBe("field-record");
    expect(calls[0]!.input.vm).toBe("samo-we-field-record");
    // CI gate must NOT be skipped (trigger defers CI enforcement to runAppDeploy)
    expect(calls[0]!.input.skipCiGate).toBe(false);

    // exit code 0 (successful deploy)
    expect(code).toBe(0);
  });

  // Test 2 (original): up-to-date — no CI call, no deploy.
  test("2 — up-to-date: deploy NOT called; action=up-to-date", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_A }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: false }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
    expect(code).toBe(0);
  });

  // Test 3 (original): known-bad — no CI call, no deploy; exit 0, skipped===1.
  test("3 — known-bad: deploy NOT called; exit 0; skipped===1; failed===0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ failedSha: SHA_FAILED }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_FAILED),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
    expect(code).toBe(0);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    const result = report.results[0]!;
    expect(result.action).toBe("known-bad");
  });

  // Test 4 (original): destroyed VM → skipped.
  test("4 — destroyed VM: app skipped; deploy NOT called; action=skipped, reason mentions state", async () => {
    vmStore.upsert(makeVm({ lifecycleState: "destroyed" }));
    appStore.upsert(makeApp());

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
    expect(code).toBe(0);

    const report: TriggerRunReport = JSON.parse(c.o);
    const result = report.results[0]!;
    expect(result.action).toBe("skipped");
    expect(result.reason).toMatch(/destroyed/);
  });

  // Test 5 (original): dry-run → would-deploy, no deploy, no CI call.
  test("5 — dry-run: deploy NOT called; action=would-deploy with sha", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: true }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
    expect(code).toBe(0);

    const report: TriggerRunReport = JSON.parse(c.o);
    const result = report.results[0]!;
    expect(result.action).toBe("would-deploy");
    expect(result.sha).toBe(SHA_A);
  });

  // Test 6 (original): per-app isolation — first deploy throws, second processed.
  // Now uses fetch injection.
  test("6 — isolation: first deploy throws, second is still processed; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ name: "app-one", id: "app-one-id", deployedSha: SHA_OLD }));
    appStore.upsert(makeApp({ name: "app-two", id: "app-two-id", deployedSha: SHA_OLD }));

    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    let callCount = 0;
    const deploy: TriggerDeps["deploy"] = async (input, _opts, _vmStore, _appStore, _out, _err) => {
      callCount++;
      if (input.app === "app-one") throw new Error("network failure");
      return 0;
    };

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    // Both apps processed
    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.results.length).toBe(2);

    const appOneResult = report.results.find((r) => r.app === "app-one")!;
    const appTwoResult = report.results.find((r) => r.app === "app-two")!;

    expect(appOneResult).toBeDefined();
    expect(appTwoResult).toBeDefined();
    expect(appOneResult.action).toBe("error");
    // second app was still deployed or attempted
    expect(["deployed", "failed", "up-to-date"].includes(appTwoResult.action)).toBe(true);

    // cycle exit must be 1 because of the error
    expect(code).toBe(1);
  });

  // Test 6b (original, reframed for #52): non-throw exit-1 deploy (genuine deploy
  // EXECUTION failure after CI was already confirmed green) → action=failed;
  // report.failed===1; cycle exit 1.
  // This is NOT a CI-block scenario — CI passed; runAppDeploy itself returned non-zero.
  test("6b — genuine deploy failure (non-throw exit-1, CI success): action=failed; failed===1; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    // CI says green, but deploy execution returns non-zero
    const { deploy, calls } = makeFakeDeploy(1);
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    // deploy was called (CI was green)
    expect(calls.length).toBe(1);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.failed).toBe(1);
    expect(report.deployed).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("failed");

    // cycle exit 1 because deploy returned non-zero
    expect(code).toBe(1);
  });

  // Test 7 (original): multi-app cycle: up-to-date + deployed → exit 0.
  // Uses fetch injection.
  test("7 — multi-app cycle: up-to-date + deployed → exit 0; deployed===1; skipped>=1", async () => {
    vmStore.upsert(makeVm());
    // app-alpha: already up-to-date (same SHA)
    appStore.upsert(makeApp({ name: "app-alpha", id: "app-alpha-id", deployedSha: SHA_A }));
    // app-beta: has old SHA → will be deployed
    appStore.upsert(makeApp({ name: "app-beta", id: "app-beta-id", deployedSha: SHA_OLD }));

    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    let resolveCallCount = 0;
    const deps: TriggerDeps = {
      resolveRef: () => { resolveCallCount++; return Promise.resolve(SHA_A); },
      deploy: makeFakeDeploy(0).deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(code).toBe(0);
    expect(report.deployed).toBe(1);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect(report.results.length).toBe(2);
  });

  // Test 8 (original): --vm / --app narrowing.
  // Uses fetch injection.
  test("8 — --vm/--app narrowing: only matching app processed", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ name: "app-one", id: "app-one-id", deployedSha: SHA_OLD }));
    appStore.upsert(makeApp({ name: "app-two", id: "app-two-id", deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false, app: "app-one" },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );

    const report: TriggerRunReport = JSON.parse(c.o);
    // Only app-one in results
    expect(report.results.length).toBe(1);
    expect(report.results[0]!.app).toBe("app-one");
    // deploy called only for app-one
    expect(calls.length).toBe(1);
    expect(calls[0]!.input.app).toBe("app-one");
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 9: parseArgs for trigger subcommand
// ---------------------------------------------------------------------------

describe("parseArgs trigger", () => {
  test("9a — trigger run --dry-run --json yields correct parsed command", () => {
    const cmd = parseArgs(["trigger", "run", "--dry-run", "--json"]);
    if (cmd.kind !== "trigger-run") throw new Error(`expected trigger-run, got ${cmd.kind}`);
    expect(cmd.input.dryRun).toBe(true);
    expect(cmd.json).toBe(true);
    expect(cmd.input.vm).toBeUndefined();
    expect(cmd.input.app).toBeUndefined();
  });

  test("9b — trigger run --vm myvm --app myapp", () => {
    const cmd = parseArgs(["trigger", "run", "--vm", "myvm", "--app", "myapp"]);
    if (cmd.kind !== "trigger-run") throw new Error(`expected trigger-run, got ${cmd.kind}`);
    expect(cmd.input.vm).toBe("myvm");
    expect(cmd.input.app).toBe("myapp");
    expect(cmd.input.dryRun).toBe(false);
  });

  test("9c — unknown trigger subcommand throws UsageError", () => {
    expect(() => parseArgs(["trigger", "wat"])).toThrow(/unknown trigger subcommand/);
  });

  test("9d — trigger with no subcommand throws UsageError", () => {
    expect(() => parseArgs(["trigger"])).toThrow(/requires a subcommand/);
  });
});

// ---------------------------------------------------------------------------
// Structural assertion: TriggerDeps NOW has fetch + env fields (added in #52).
// The trigger uses them to call checkCiGreen before deciding to deploy.
// ---------------------------------------------------------------------------
test("structural — TriggerDeps has fetch and env fields (added in #52)", () => {
  // Verify that a complete TriggerDeps requires fetch:
  const deps: TriggerDeps = {
    resolveRef: () => Promise.resolve("abc123"),
    deploy: async () => 0,
    fetch: globalThis.fetch,
    env: { GH_TOKEN: "test" },
    now: () => new Date(),
  };
  expect("fetch" in deps).toBe(true);
  expect("env" in deps).toBe(true);
});
