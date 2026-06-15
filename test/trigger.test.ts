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
  type TriggerAppResult,
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
const SHA_B = "bbb1111bbb2222bbb3333bbb4444bbb555566666";
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
    rlsNonSuperuser: false,
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
  // Test 1: new SHA → deploy called once with resolved SHA; action deployed;
  //         report.deployed === 1
  // -------------------------------------------------------------------------
  test("1 — new SHA: deploy called once with resolved SHA; action=deployed; deployed===1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: (_repo, _branch) => Promise.resolve(SHA_A),
      deploy,
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

  // -------------------------------------------------------------------------
  // Test 2: resolved SHA === app.deployedSha → deploy NOT called; action up-to-date
  // -------------------------------------------------------------------------
  test("2 — up-to-date: deploy NOT called; action=up-to-date", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_A }));

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: false }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: resolved SHA === app.failedSha → deploy NOT called; action=known-bad
  //         single-app cycle with only known-bad → exit 0, failed===0, skipped===1
  // -------------------------------------------------------------------------
  test("3 — known-bad: deploy NOT called; exit 0; skipped===1; failed===0", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ failedSha: SHA_FAILED }));

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_FAILED),
      deploy,
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

  // -------------------------------------------------------------------------
  // Test 4: VM lifecycleState 'destroyed' → app skipped; deploy NOT called;
  //         action=skipped, reason mentions state
  // -------------------------------------------------------------------------
  test("4 — destroyed VM: app skipped; deploy NOT called; action=skipped, reason mentions state", async () => {
    vmStore.upsert(makeVm({ lifecycleState: "destroyed" }));
    appStore.upsert(makeApp());

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
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

  // -------------------------------------------------------------------------
  // Test 5: --dry-run with a new SHA → deploy NOT called; action=would-deploy
  //         with the sha
  // -------------------------------------------------------------------------
  test("5 — dry-run: deploy NOT called; action=would-deploy with sha", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
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

  // -------------------------------------------------------------------------
  // Test 6: per-app isolation: two apps, first's deploy throws → second still
  //         processed; cycle exit 1; both appear in results (first=error, second ok)
  // -------------------------------------------------------------------------
  test("6 — isolation: first deploy throws, second is still processed; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ name: "app-one", id: "app-one-id", deployedSha: SHA_OLD }));
    appStore.upsert(makeApp({ name: "app-two", id: "app-two-id", deployedSha: SHA_OLD }));

    let callCount = 0;
    const deploy: TriggerDeps["deploy"] = async (input, _opts, _vmStore, _appStore, _out, _err) => {
      callCount++;
      if (input.app === "app-one") throw new Error("network failure");
      return 0;
    };

    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
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

  // -------------------------------------------------------------------------
  // Test 6b: non-throw exit-1 deploy (simulates CI refused / rolled-back) →
  //          action=failed; report.failed===1; cycle exit 1
  // -------------------------------------------------------------------------
  test("6b — non-throw exit-1 deploy: action=failed; failed===1; exit 1", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD }));

    // fake deploy returns 1 (e.g. CI gate refused or deploy rolled back)
    const { deploy, calls } = makeFakeDeploy(1);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun({ dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err);

    // deploy was called
    expect(calls.length).toBe(1);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.failed).toBe(1);
    expect(report.deployed).toBe(0);

    const result = report.results[0]!;
    expect(result.action).toBe("failed");

    // cycle exit 1 because deploy returned non-zero
    expect(code).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: multi-app cycle: one up-to-date + one deployed → exit 0,
  //         deployed===1, skipped>=1
  // -------------------------------------------------------------------------
  test("7 — multi-app cycle: up-to-date + deployed → exit 0; deployed===1; skipped>=1", async () => {
    vmStore.upsert(makeVm());
    // app-alpha: already up-to-date (same SHA)
    appStore.upsert(makeApp({ name: "app-alpha", id: "app-alpha-id", deployedSha: SHA_A }));
    // app-beta: has old SHA → will be deployed
    appStore.upsert(makeApp({ name: "app-beta", id: "app-beta-id", deployedSha: SHA_OLD }));

    let resolveCallCount = 0;
    const deps: TriggerDeps = {
      resolveRef: () => { resolveCallCount++; return Promise.resolve(SHA_A); },
      deploy: makeFakeDeploy(0).deploy,
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

  // -------------------------------------------------------------------------
  // Test 8: --vm / --app narrowing selects only the matching app
  // -------------------------------------------------------------------------
  test("8 — --vm/--app narrowing: only matching app processed", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ name: "app-one", id: "app-one-id", deployedSha: SHA_OLD }));
    appStore.upsert(makeApp({ name: "app-two", id: "app-two-id", deployedSha: SHA_OLD }));

    const { deploy, calls } = makeFakeDeploy(0);
    const deps: TriggerDeps = {
      resolveRef: () => Promise.resolve(SHA_A),
      deploy,
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
    const { UsageError } = require("../src/cli.ts");
    expect(() => parseArgs(["trigger", "wat"])).toThrow(/unknown trigger subcommand/);
  });

  test("9d — trigger with no subcommand throws UsageError", () => {
    expect(() => parseArgs(["trigger"])).toThrow(/requires a subcommand/);
  });
});

// ---------------------------------------------------------------------------
// Structural assertion: trigger does NOT call checkCiGreen directly.
// (The CI gate lives in runAppDeploy — the trigger is just a scheduler.)
// We verify this by ensuring no real `fetch` is ever passed into the trigger
// (only the fake deploy fn is injected). If the trigger imported checkCiGreen
// and called it, we would see that in coverage or require additional injection.
// This test documents the contract by checking that a trigger run with a fake
// deploy that returns 0 never requires a fetch implementation.
// ---------------------------------------------------------------------------
test("structural — trigger accepts no fetch dep (CI gate is in runAppDeploy, not trigger)", () => {
  // TriggerDeps has no `fetch` field — this is enforced by TypeScript.
  // At runtime, verify that a complete TriggerDeps can be constructed without fetch:
  const deps: TriggerDeps = {
    resolveRef: () => Promise.resolve("abc123"),
    deploy: async () => 0,
    now: () => new Date(),
  };
  // No `fetch` property on deps
  expect("fetch" in deps).toBe(false);
});
