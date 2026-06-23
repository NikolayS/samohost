/**
 * Tests for harden self-heal (MR-A).
 *
 * RED phase: these tests MUST FAIL before the bugs are fixed.
 *
 * Three behaviors pinned:
 *
 * (A) src/commands/env.ts runEnvCreate: a FAILED/partial create must NOT
 *     record lastDeployedSha on the EnvRecord.
 *
 *     Root cause trace:
 *       trigger.ts ensurePreviewImpl calls runEnvCreate then UNCONDITIONALLY
 *       stamps { ...rec, lastDeployedSha: args.headSha } via a post-create
 *       upsert (lines ~814-818). This is the dishonest-state trap: reconcile
 *       reads lastDeployedSha===headSha → needDeploy=false → never retries the
 *       broken env.
 *
 *     FIX: add optional `lastDeployedSha?` to EnvCreateInput. runEnvCreate
 *     stamps it ONLY when outcome === "ok". trigger.ts ensurePreviewImpl drops
 *     its post-create upsert (runEnvCreate owns the stamp).
 *
 *     RED TEST: call runEnvCreate with lastDeployedSha set in the input on a
 *     CREATE_FAIL output. The stored record MUST NOT carry lastDeployedSha.
 *
 * (B) src/preview/heal.ts runHealPass: DB-UNREACHABLE — the app process is
 *     up but cannot connect to its DBLab clone (port unreachable after the
 *     daily snapshot refresh reaps the ZFS dataset). probeClones must return
 *     "dead" for a TCP-unreachable clone; the heal pass must then re-cut it.
 *     (Tests via the HealDeps.probeClones Map interface which already supports
 *     this — the fix is in the production probeClones impl; the test pins the
 *     contract.)
 *
 * (C) src/commands/trigger.ts: heal must run when `input.heal === true`
 *     regardless of `input.prPreviews`. Today gated on prPreviews=true.
 *     FIX: add `heal?: boolean` to TriggerRunInput; gate on
 *     `(input.heal === true || input.prPreviews === true) && deps.heal`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvCreate,
  type EnvExecDeps,
  type EnvCreateInput,
} from "../src/commands/env.ts";
import {
  runHealPass,
  type HealDeps,
  type HealSummary,
  type CloneHealth,
} from "../src/preview/heal.ts";
import {
  runTriggerRun,
  type TriggerRunInput,
  type TriggerDeps,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

function makeEnvRecord(
  branch: string,
  o: Partial<EnvRecord> = {},
): EnvRecord {
  const safeBranch = branch.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 40);
  const name = `field-record-${safeBranch}`.slice(0, 63);
  return {
    id: `env-${branch}`,
    vmId: "vm-1111",
    appName: "field-record",
    branch,
    name,
    port: 3100,
    vhost: `${name}.samo.cat`,
    dbBackend: "dblab",
    dbName: `dblab-clone-${safeBranch}`,
    createdAt: "2026-01-01T00:00:00.000Z",
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

const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");
const CREATE_FAIL = [
  M("clone", "start"), M("clone", "ok"),
  M("install", "start"), M("install", "ok"),
  M("build", "start"), M("build", "ok"),
  M("db", "start"), M("db", "fail"),
].join("\n");

function fakeEnvDeps(output: string): EnvExecDeps {
  let n = 0;
  return {
    remote: () => Promise.resolve({ code: 0, stdout: output, stderr: "" }),
    now: () => new Date("2026-06-23T12:00:00.000Z"),
    uuid: () => `uuid-${++n}`,
  };
}

// ---------------------------------------------------------------------------
// SECTION A — runEnvCreate with lastDeployedSha: failed create must not stamp
// ---------------------------------------------------------------------------

describe("runEnvCreate — lastDeployedSha only stamped on success", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-A-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("successful create with lastDeployedSha in input stamps it on the record", async () => {
    // This tests the NEW behavior: caller passes lastDeployedSha in EnvCreateInput;
    // runEnvCreate stamps it only when outcome=ok.
    // This test will FAIL until EnvCreateInput gains the lastDeployedSha field.
    const input: EnvCreateInput = {
      vm: "samo-we-field-record",
      app: "field-record",
      branch: "feat/ok",
      db: "dblab",
      previewDomain: "samo.cat",
      lastDeployedSha: "sha-success-001", // NEW field in EnvCreateInput
    };
    const c = capture();
    const code = await runEnvCreate(
      input, { json: false }, vmStore, appStore, envStore,
      fakeEnvDeps(CREATE_OK), c.out, c.err,
    );
    expect(code).toBe(0);
    const rec = envStore.get("vm-1111", "field-record", "feat/ok");
    expect(rec).toBeDefined();
    // After a SUCCESSFUL create the sha must be stamped.
    expect(rec?.lastDeployedSha).toBe("sha-success-001");
  });

  test("failed create with lastDeployedSha in input does NOT stamp it", async () => {
    // THE KEY RED TEST for Section A.
    // Today EnvCreateInput has no lastDeployedSha field (so the test fails on
    // type/behavior). Once the field exists, the test asserts the fix:
    // a failed create must leave lastDeployedSha undefined in the record.
    const input: EnvCreateInput = {
      vm: "samo-we-field-record",
      app: "field-record",
      branch: "feat/fail",
      db: "dblab",
      previewDomain: "samo.cat",
      lastDeployedSha: "sha-that-must-not-be-stamped", // NEW field
    };
    const c = capture();
    const code = await runEnvCreate(
      input, { json: false }, vmStore, appStore, envStore,
      fakeEnvDeps(CREATE_FAIL), c.out, c.err,
    );
    expect(code).toBe(1); // failed create

    const rec = envStore.get("vm-1111", "field-record", "feat/fail");
    expect(rec).toBeDefined(); // record IS persisted (for idempotent re-run)

    // THE KEY ASSERTION: failed create must NOT stamp lastDeployedSha.
    // If the record carries the sha, the reconciler sees needDeploy=false
    // and the broken env is never retried — the dishonest-state trap.
    expect(rec?.lastDeployedSha).toBeUndefined();
  });

  test("failed re-create after success clears the previously stamped sha", async () => {
    // An env that previously succeeded (sha=A) then fails on re-create must
    // have its lastDeployedSha CLEARED (set to undefined), so needDeploy=true
    // on the next reconcile cycle.

    // Step 1: successful create stamps sha.
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat",
        lastDeployedSha: "sha-A" }, // NEW field
      { json: false }, vmStore, appStore, envStore,
      fakeEnvDeps(CREATE_OK), capture().out, capture().err,
    );
    expect(envStore.get("vm-1111", "field-record", "feat/x")?.lastDeployedSha).toBe("sha-A");

    // Step 2: failed re-create clears sha.
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat",
        lastDeployedSha: "sha-B" }, // NEW sha — must NOT be stamped on failure
      { json: false }, vmStore, appStore, envStore,
      fakeEnvDeps(CREATE_FAIL), c.out, c.err,
    );
    expect(code).toBe(1);
    const after = envStore.get("vm-1111", "field-record", "feat/x");
    expect(after).toBeDefined();
    expect(after?.lastDeployedSha).toBeUndefined(); // cleared on failure
  });

  test("create without lastDeployedSha in input never sets it (no regression)", async () => {
    // Existing callers that don't pass lastDeployedSha must not have it appear.
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record", branch: "feat/no-sha",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeEnvDeps(CREATE_OK), c.out, c.err,
    );
    expect(code).toBe(0);
    const rec = envStore.get("vm-1111", "field-record", "feat/no-sha");
    expect(rec?.lastDeployedSha).toBeUndefined(); // no regression
  });
});

// ---------------------------------------------------------------------------
// SECTION B — heal.ts: DB-UNREACHABLE (TCP port unreachable → "dead")
// ---------------------------------------------------------------------------

describe("runHealPass — DB-UNREACHABLE: probeClones returns dead for TCP-unreachable clone", () => {
  let dir: string;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-B-"));
    envStore = new EnvStore(join(dir, "envs.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeDeps(
    healthMap: Map<string, CloneHealth>,
    recreateCalls: string[],
    recreateOutcome: "ok" | "failed" | "budget" = "ok",
  ): HealDeps {
    return {
      probeClones: async () => healthMap,
      recreate: async (_vm, _app, env) => {
        recreateCalls.push(env.branch);
        return recreateOutcome;
      },
      envStore,
    };
  }

  test("clone status=alive → healthy, no recreate", async () => {
    const env = makeEnvRecord("feat/all-good");
    envStore.upsert(env);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[env.dbName!, "alive"]]), calls),
      capture().out, capture().err,
    );
    expect(calls).toHaveLength(0);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]?.action).toBe("healthy");
  });

  test("clone TCP-unreachable (probe returns 'dead') → heal triggers re-create", async () => {
    // The clone exists in the DBLab engine registry but its TCP port is
    // UNREACHABLE (ECONNREFUSED) — the daily snapshot refresh has reaped the
    // underlying ZFS dataset while the engine's registration is stale.
    // probeClones MUST classify this as "dead".
    // This test pins the contract: "dead" → heal calls recreate.
    const env = makeEnvRecord("feat/tcp-dead");
    envStore.upsert(env);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[env.dbName!, "dead"]]), calls),
      capture().out, capture().err,
    );
    expect(calls).toContain("feat/tcp-dead");
    expect(summary.healed).toBe(1);
    expect(summary.results[0]?.action).toBe("healed");
    expect(summary.results[0]?.health).toBe("dead");
  });

  test("clone id absent from probe map → 'unknown' → fail-closed (no recreate)", async () => {
    const env = makeEnvRecord("feat/probe-gap");
    envStore.upsert(env);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map(), calls), // empty map
      capture().out, capture().err,
    );
    expect(calls).toHaveLength(0);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]?.action).toBe("skipped");
  });

  test("probeClones throws → all envs skipped, no crash", async () => {
    const env = makeEnvRecord("feat/probe-throws");
    envStore.upsert(env);

    const calls: string[] = [];
    const failDeps: HealDeps = {
      probeClones: async () => { throw new Error("SSH timeout"); },
      recreate: async (_vm, _app, env) => { calls.push(env.branch); return "ok"; },
      envStore,
    };
    const c = capture();
    const summary = await runHealPass(makeApp(), makeVm(), failDeps, c.out, c.err);
    expect(calls).toHaveLength(0);
    expect(summary.healed).toBe(0);
    expect(c.e).toContain("SSH timeout");
    expect(summary.results[0]?.action).toBe("skipped");
  });

  test("recreate=budget → deferred (NOT counted as failed)", async () => {
    const env = makeEnvRecord("feat/budget");
    envStore.upsert(env);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[env.dbName!, "dead"]]), calls, "budget"),
      capture().out, capture().err,
    );
    expect(summary.deferred).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]?.action).toBe("skipped");
  });

  test("recreate=failed → counted as failed", async () => {
    const env = makeEnvRecord("feat/recreate-fail");
    envStore.upsert(env);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[env.dbName!, "dead"]]), calls, "failed"),
      capture().out, capture().err,
    );
    expect(summary.failed).toBe(1);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]?.action).toBe("heal-failed");
  });

  test("non-dblab envs NOT passed to probeClones", async () => {
    const templateEnv = makeEnvRecord("feat/tmpl", { dbBackend: "template", dbName: undefined });
    const noneEnv     = makeEnvRecord("feat/none-db", { port: 3101, dbBackend: "none", dbName: undefined });
    envStore.upsert(templateEnv);
    envStore.upsert(noneEnv);

    let probeCalled = false;
    const deps: HealDeps = {
      probeClones: async (_vm, _app, envs) => {
        probeCalled = envs.length > 0;
        return new Map();
      },
      recreate: async () => "ok",
      envStore,
    };
    const summary = await runHealPass(makeApp(), makeVm(), deps, capture().out, capture().err);
    expect(probeCalled).toBe(false);
    expect(summary.examined).toBe(0);
  });

  test("prNumber=undefined (manual/cron) env IS healed — heal not gated by prNumber", async () => {
    // The closed-PR reaper guards on prNumber to protect manual envs.
    // Heal must NOT apply that guard — it heals ALL dead dblab clones.
    const manualEnv = makeEnvRecord("demo/manual");
    expect(manualEnv.prNumber).toBeUndefined();
    envStore.upsert(manualEnv);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[manualEnv.dbName!, "dead"]]), calls),
      capture().out, capture().err,
    );
    expect(calls).toContain("demo/manual");
    expect(summary.healed).toBe(1);
  });

  test("prNumber=42 (PR-managed) env IS also healed", async () => {
    const prEnv = makeEnvRecord("feature/pr-42", { prNumber: 42 });
    envStore.upsert(prEnv);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([[prEnv.dbName!, "dead"]]), calls),
      capture().out, capture().err,
    );
    expect(calls).toContain("feature/pr-42");
    expect(summary.healed).toBe(1);
  });

  test("multiple envs — only dead ones healed, mix of prNumbers", async () => {
    const envAlive  = makeEnvRecord("feat/alive",  { port: 3100 });
    const envDead   = makeEnvRecord("feat/dead",   { port: 3101, prNumber: 7 });
    const envUnknown = makeEnvRecord("demo/manual", { port: 3102 });
    envStore.upsert(envAlive);
    envStore.upsert(envDead);
    envStore.upsert(envUnknown);

    const calls: string[] = [];
    const summary = await runHealPass(
      makeApp(), makeVm(),
      makeDeps(new Map([
        [envAlive.dbName!,   "alive"],
        [envDead.dbName!,    "dead"],
        [envUnknown.dbName!, "unknown"],
      ]), calls),
      capture().out, capture().err,
    );
    expect(calls).toEqual(["feat/dead"]);
    expect(summary.healed).toBe(1);
    expect(summary.examined).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SECTION C — trigger.ts: heal flag independent of --pr-previews
// ---------------------------------------------------------------------------

describe("trigger.ts — heal flag is independent of --pr-previews", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-C-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function baseTriggerDeps(healCalls: string[]): TriggerDeps {
    return {
      resolveRef: async () => "sha-abc",
      deploy: async () => 0,
      fetch: async () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      heal: async (app: AppRecord, _vm: VmRecord): Promise<HealSummary> => {
        healCalls.push(app.name);
        return {
          app: app.name, vm: "samo-we-field-record",
          examined: 0, healed: 0, failed: 0, deferred: 0, results: [],
        };
      },
    };
  }

  test("heal=true, prPreviews=false → heal pass RUNS (the RED test)", async () => {
    // TODAY FAILS: heal gated on `input.prPreviews === true` in trigger.ts.
    // FIX: add `heal?: boolean` to TriggerRunInput; gate on
    // `(input.heal === true || input.prPreviews === true) && deps.heal`.
    const healCalls: string[] = [];
    const input: TriggerRunInput = {
      dryRun: true,
      heal: true,        // new flag
      prPreviews: false, // pr-preview pass must NOT run
    };
    await runTriggerRun(input, { json: false }, vmStore, appStore,
      baseTriggerDeps(healCalls), capture().out, capture().err);
    expect(healCalls).toContain("field-record"); // FAILS before fix
  });

  test("heal=false, prPreviews=false → heal pass does NOT run", async () => {
    const healCalls: string[] = [];
    const input: TriggerRunInput = { dryRun: true, heal: false, prPreviews: false };
    await runTriggerRun(input, { json: false }, vmStore, appStore,
      baseTriggerDeps(healCalls), capture().out, capture().err);
    expect(healCalls).toHaveLength(0);
  });

  test("heal=true, prPreviews=true → both heal and pr-preview run", async () => {
    const healCalls: string[] = [];
    const prCalls: string[] = [];
    const deps: TriggerDeps = {
      ...baseTriggerDeps(healCalls),
      prPreview: async (app: AppRecord) => {
        prCalls.push(app.name);
        return { app: app.name, vm: "samo-we-field-record", openPrs: 0, results: [] };
      },
    };
    const input: TriggerRunInput = { dryRun: true, heal: true, prPreviews: true };
    await runTriggerRun(input, { json: false }, vmStore, appStore, deps, capture().out, capture().err);
    expect(healCalls).toContain("field-record");
    expect(prCalls).toContain("field-record");
  });

  test("heal=undefined, prPreviews=true → backward-compat: heal still runs", async () => {
    // Existing behavior must not regress.
    const healCalls: string[] = [];
    const input: TriggerRunInput = { dryRun: true, prPreviews: true };
    await runTriggerRun(input, { json: false }, vmStore, appStore,
      baseTriggerDeps(healCalls), capture().out, capture().err);
    expect(healCalls).toContain("field-record");
  });
});
