/**
 * test/trigger-app-heal.test.ts — RED/GREEN tests for Phase 3 of the
 * "never silently lose an update" fix: trigger auto-heal pass.
 *
 * RED phase: these tests MUST FAIL before the implementation is written.
 * GREEN phase: add the heal pass to runTriggerRun, reusing Phase-2 runAppHeal
 * via deps.appHeal, for them to pass.
 *
 * Design (from Fable advisor / manager-critic review):
 *   - After the deploy loop (and GC/idle-GC passes), before batchedVmCycle:
 *     a new "app-config heal pass" runs on apps whose this-cycle action was
 *     'up-to-date' AND whose generatorSha !== currentHeadSha (stale generator).
 *   - MUTUAL EXCLUSION: apps that were deployed this cycle are NEVER healed.
 *     Guard derived from results array (not lastDeployAt).
 *   - SKIP conditions: (a) deployed this cycle, (b) failedSha === currentHeadSha,
 *     (c) lastDeployAt within 10-min manual-deploy grace window.
 *   - RATE LIMIT: at most HEAL_VM_CAP (2) VMs healed per cycle. Remaining get
 *     action='deferred' in appHeal report.
 *   - ALERT on persistent failure: healFailCount field on AppRecord bumped on
 *     each failed heal; reset to 0 on success. When healFailCount >= 3,
 *     calls deps.fileHealAlert (injectable; production calls upsertGhIssue).
 *   - dryRun=true or input.appHeal=false skips the pass entirely.
 *   - Seam: optional deps.appHeal: (app, opts: { apply: boolean }) => Promise<AppHealResult>
 *     in TriggerDeps. Optional alertRepo?: string in TriggerRunInput.
 *
 * CLI: no browser UI; Playwright not applicable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTriggerRun,
  type TriggerRunInput,
  type TriggerDeps,
  type TriggerRunReport,
  type AppHealPassSummary,
  type AppHealResult,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared SHA constants
// ---------------------------------------------------------------------------

const CURRENT_HEAD_SHA = "cccccccccccccccccccccccccccccccccccccc01";
const OLD_GEN_SHA      = "0000000000000000000000000000000000000001";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-autoheal-1",
    provider: "hetzner",
    providerId: "99001",
    name: "samo-we-autoheal",
    ip: "10.10.10.10",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 22,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "nbg1",
    type: "cx23",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-autoheal-1",
    vmId: "vm-autoheal-1",
    name: "autoheal-app",
    repo: "Tanya301/autoheal-app",
    branch: "main",
    appDir: "/opt/autoheal-app/app",
    buildCmd: "npm run build",
    serviceUnit: "autoheal-app",
    healthUrl: "http://localhost:3000/health",
    mainHost: "autoheal-app.samo.team",
    mainListen: "cp-http80",
    // up-to-date: deployed SHA matches HEAD
    deployedSha: CURRENT_HEAD_SHA,
    // stale generator — generator advanced past what healed the app
    generatorSha: OLD_GEN_SHA,
    ...o,
  };
}

function capture() {
  let out = "";
  let errStr = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { errStr += s + "\n"; },
    get o() { return out; },
    get e() { return errStr; },
  };
}

// ---------------------------------------------------------------------------
// Fake trigger deps factory:
// - resolveRef always returns CURRENT_HEAD_SHA (so app is always up-to-date)
// - deploy is a noop (never called because app is already up-to-date)
// - fetch is a noop (CI not checked for up-to-date apps)
// - now is injectable for grace-window tests
// ---------------------------------------------------------------------------

function makeBaseDeps(
  overrides: Partial<TriggerDeps> = {},
  nowDate: Date = new Date("2026-07-15T12:00:00.000Z"),
): TriggerDeps {
  return {
    resolveRef: () => Promise.resolve(CURRENT_HEAD_SHA),
    deploy: async () => 0,
    fetch: (async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })) as unknown as typeof globalThis.fetch,
    now: () => nowDate,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake appHeal factory: records calls, returns configurable outcome.
// ---------------------------------------------------------------------------

function makeFakeAppHeal(outcome: AppHealResult["outcome"] = "healed"): {
  appHeal: NonNullable<TriggerDeps["appHeal"]>;
  calls: Array<{ app: AppRecord; opts: { apply: boolean } }>;
} {
  const calls: Array<{ app: AppRecord; opts: { apply: boolean } }> = [];
  const appHeal: NonNullable<TriggerDeps["appHeal"]> = async (app, opts) => {
    calls.push({ app, opts });
    return { outcome, app: app.name };
  };
  return { appHeal, calls };
}

// ---------------------------------------------------------------------------
// Shared beforeEach/afterEach
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trigger-autoheal-"));
  vmStore = new StateStore(join(dir, "vms.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  vmStore.upsert(makeVm());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — eligible selection: up-to-date + stale generatorSha → healed
// ---------------------------------------------------------------------------

describe("Test 1 — eligible selection", () => {
  test("appHeal called exactly once for an up-to-date app with stale generatorSha", async () => {
    const app = makeApp({ deployedSha: CURRENT_HEAD_SHA, generatorSha: OLD_GEN_SHA });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(1);
    expect(calls[0]!.app.name).toBe("autoheal-app");
    expect(calls[0]!.opts.apply).toBe(true);
  });

  test("appHeal NOT called when generatorSha already matches currentGeneratorSha (converged)", async () => {
    const app = makeApp({ deployedSha: CURRENT_HEAD_SHA, generatorSha: CURRENT_HEAD_SHA });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("no-drift");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — no heal on deployed-this-cycle
// ---------------------------------------------------------------------------

describe("Test 2 — no heal on deployed-this-cycle", () => {
  test("appHeal NOT called for app deployed this cycle even if generatorSha is stale", async () => {
    // App has OLD deployedSha so trigger will deploy it (SHA mismatch)
    const OLD_SHA = "aaaa000000000000000000000000000000000001";
    const app = makeApp({ deployedSha: OLD_SHA, generatorSha: OLD_GEN_SHA });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");

    // resolveRef returns CURRENT_HEAD_SHA (new SHA → triggers deploy)
    const deps = makeBaseDeps({
      appHeal,
      resolveRef: () => Promise.resolve(CURRENT_HEAD_SHA),
      // CI green so deploy proceeds
      fetch: (async () => ({
        ok: true,
        json: async () => ({
          workflow_runs: [{ status: "completed", conclusion: "success" }],
        }),
      })) as unknown as typeof globalThis.fetch,
      deploy: async (_input, _opts, _vmStore, _appStore) => {
        // Simulate deploy updating deployedSha
        const current = _appStore.list().find((a) => a.name === "autoheal-app");
        if (current !== undefined) {
          _appStore.upsert({ ...current, deployedSha: CURRENT_HEAD_SHA });
        }
        return 0;
      },
    });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    // The app was deployed this cycle → appHeal must NOT be called
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — no heal on failedSha match
// ---------------------------------------------------------------------------

describe("Test 3 — no heal on failedSha match", () => {
  test("appHeal NOT called when app.failedSha === currentGeneratorSha", async () => {
    // App is up-to-date (deployed SHA matches HEAD) but failedSha matches the
    // generatorSha — a previous heal attempt failed; skip this cycle.
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      failedSha: CURRENT_HEAD_SHA, // failedSha blocks heal (same as deploy known-bad pattern)
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — 10-min manual-deploy grace
// ---------------------------------------------------------------------------

describe("Test 4 — 10-min manual-deploy grace", () => {
  test("appHeal NOT called when lastDeployAt is within 10 minutes of now", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    // lastDeployAt 5 min ago — inside the 10-min grace window
    const recentDeploy = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      lastDeployAt: recentDeploy,
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal }, now);

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });

  test("appHeal IS called when lastDeployAt is older than 10 minutes", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    // lastDeployAt 15 min ago — outside the 10-min grace window
    const oldDeploy = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      lastDeployAt: oldDeploy,
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal }, now);

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — rate limit cap (2 VMs per cycle)
// ---------------------------------------------------------------------------

describe("Test 5 — rate limit cap (HEAL_VM_CAP=2)", () => {
  test("appHeal called at most 2 times when 3 eligible apps exist", async () => {
    // Register 3 VMs, each with 1 app — all eligible
    for (let i = 1; i <= 3; i++) {
      vmStore.upsert(makeVm({
        id: `vm-cap-${i}`,
        name: `samo-we-cap-${i}`,
      }));
      appStore.upsert(makeApp({
        id: `app-cap-${i}`,
        vmId: `vm-cap-${i}`,
        name: `cap-app-${i}`,
        deployedSha: CURRENT_HEAD_SHA,
        generatorSha: OLD_GEN_SHA,
      }));
    }

    const { appHeal, calls } = makeFakeAppHeal("healed");
    // Return CURRENT_HEAD_SHA for all apps (all up-to-date)
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    const report: TriggerRunReport = JSON.parse(
      await (async () => {
        await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);
        return c.o;
      })(),
    );

    // At most 2 heals per cycle (HEAL_VM_CAP)
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // The third app must appear as deferred in the report
    const healPass = report.appHeal;
    expect(healPass).toBeDefined();
    const deferred = (healPass ?? []).filter((s) => s.action === "deferred");
    expect(deferred.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — non-stale skipped (generatorSha === currentGeneratorSha)
// (Already covered in Test 1 second sub-test — additional explicit test)
// ---------------------------------------------------------------------------

describe("Test 6 — non-stale app skipped (already converged)", () => {
  test("appHeal NOT called when generatorSha matches currentGeneratorSha", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: CURRENT_HEAD_SHA, // already converged
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("no-drift");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — heal failure increments healFailCount
// ---------------------------------------------------------------------------

describe("Test 7 — heal failure increments healFailCount", () => {
  test("healFailCount bumped by 1 when appHeal returns heal-failed outcome", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      healFailCount: 0,
    });
    appStore.upsert(app);

    const { appHeal } = makeFakeAppHeal("heal-failed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const updated = appStore.list().find((a) => a.name === "autoheal-app");
    expect(updated?.healFailCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — alert fires at HEAL_FAIL_ALERT_THRESHOLD (3 failures)
// ---------------------------------------------------------------------------

describe("Test 8 — alert fires at threshold", () => {
  test("fileHealAlert called when healFailCount reaches 3 after this cycle's failure", async () => {
    // healFailCount = 2; this cycle fails → bumped to 3 → alert fires
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      healFailCount: 2,
    });
    appStore.upsert(app);

    const { appHeal } = makeFakeAppHeal("heal-failed");

    const alertCalls: Array<{ appName: string; failCount: number }> = [];
    const fileHealAlert = async (appName: string, failCount: number) => {
      alertCalls.push({ appName, failCount });
    };

    const deps = makeBaseDeps({ appHeal, fileHealAlert });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
      alertRepo: "NikolayS/samohost",
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]!.appName).toBe("autoheal-app");
    expect(alertCalls[0]!.failCount).toBe(3);
  });

  test("fileHealAlert NOT called when healFailCount is below threshold (< 3)", async () => {
    // healFailCount = 1; this cycle fails → bumped to 2 → below threshold, no alert
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      healFailCount: 1,
    });
    appStore.upsert(app);

    const { appHeal } = makeFakeAppHeal("heal-failed");

    const alertCalls: unknown[] = [];
    const fileHealAlert = async (appName: string, failCount: number) => {
      alertCalls.push({ appName, failCount });
    };

    const deps = makeBaseDeps({ appHeal, fileHealAlert });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(alertCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — heal success resets healFailCount
// ---------------------------------------------------------------------------

describe("Test 9 — heal success resets healFailCount", () => {
  test("healFailCount reset to 0 when appHeal returns healed", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
      healFailCount: 2,
    });
    appStore.upsert(app);

    const { appHeal } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const updated = appStore.list().find((a) => a.name === "autoheal-app");
    expect(updated?.healFailCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10 — dryRun=true skips heal pass entirely
// ---------------------------------------------------------------------------

describe("Test 10 — dryRun=true skips heal pass entirely", () => {
  test("appHeal NOT called when dryRun=true, even with stale generatorSha", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: true, // dry-run — heal must be skipped
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 11 — input.appHeal = false skips pass
// ---------------------------------------------------------------------------

describe("Test 11 — input.appHeal=false skips pass", () => {
  test("appHeal dep NOT called when input.appHeal is false", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: false, // opt-in flag false → skip
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });

  test("appHeal dep NOT called when input.appHeal is absent (undefined)", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    });
    appStore.upsert(app);

    const { appHeal, calls } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    // No appHeal field in input
    const input: TriggerRunInput = {
      dryRun: false,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 12 — per-app isolation: one app's failure does not abort the pass
// ---------------------------------------------------------------------------

describe("Test 12 — per-app isolation", () => {
  test("second eligible app still healed when first app's appHeal throws", async () => {
    // Two apps on two VMs, both eligible
    vmStore.upsert(makeVm({ id: "vm-iso-1", name: "samo-we-iso-1" }));
    vmStore.upsert(makeVm({ id: "vm-iso-2", name: "samo-we-iso-2" }));

    appStore.upsert(makeApp({
      id: "app-iso-1",
      vmId: "vm-iso-1",
      name: "iso-app-1",
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    }));
    appStore.upsert(makeApp({
      id: "app-iso-2",
      vmId: "vm-iso-2",
      name: "iso-app-2",
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    }));

    const calls: string[] = [];
    let firstCall = true;
    const appHeal: NonNullable<TriggerDeps["appHeal"]> = async (app, _opts) => {
      calls.push(app.name);
      if (firstCall) {
        firstCall = false;
        throw new Error("simulated heal crash on first app");
      }
      return { outcome: "healed", app: app.name };
    };

    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    // Must not throw; per-app isolation must catch the error
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    // Both apps were attempted (second was not aborted by first's failure)
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 13 — report includes appHeal summaries in JSON output
// ---------------------------------------------------------------------------

describe("Test 13 — report JSON contains appHeal summaries", () => {
  test("TriggerRunReport.appHeal is present and contains per-app outcomes", async () => {
    const app = makeApp({
      deployedSha: CURRENT_HEAD_SHA,
      generatorSha: OLD_GEN_SHA,
    });
    appStore.upsert(app);

    const { appHeal } = makeFakeAppHeal("healed");
    const deps = makeBaseDeps({ appHeal });

    const input: TriggerRunInput = {
      dryRun: false,
      appHeal: true,
      currentGeneratorSha: CURRENT_HEAD_SHA,
    };

    const c = capture();
    await runTriggerRun(input, { json: true }, vmStore, appStore, deps, c.out, c.err);

    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.appHeal).toBeDefined();
    expect(Array.isArray(report.appHeal)).toBe(true);
    expect(report.appHeal!.length).toBeGreaterThanOrEqual(1);

    const entry = report.appHeal![0] as AppHealPassSummary;
    expect(entry.app).toBe("autoheal-app");
    expect(entry.action).toBe("healed");
  });
});
