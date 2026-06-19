/**
 * Tests for src/preview/heal.ts — runHealPass and HealDeps (samohost #78:
 * self-healing DBLab preview clones).
 *
 * RED phase: these tests MUST FAIL before the implementation is written.
 *
 * Design principles being tested:
 *  - ONE batched probe per (app, vm) (the connection budget forbids per-env
 *    probes). The probe returns a clone-id → verdict map.
 *  - A dblab env whose clone is DEAD/MISSING → recreate called → action "healed".
 *  - A dblab env whose clone is ALIVE → recreate NOT called → action "healthy".
 *  - Fail-closed: verdict "unknown" → recreate NOT called → action "skipped".
 *  - A clone id missing from the probe map → treated as "unknown" (fail-closed).
 *  - recreate "budget" → action "skipped" + deferred++ (NOT a failure) and the
 *    remaining dead envs are also deferred (no further re-create attempts).
 *  - Per-env isolation: recreate throw → that env "heal-failed"; others proceed.
 *  - Backend filter: template/none envs are NOT examined.
 *  - A probe throw → every env skipped/deferred, cycle does not abort.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHealPass,
  type HealDeps,
  type CloneHealth,
  type RecreateOutcome,
  type HealSummary,
} from "../src/preview/heal.ts";
import { EnvStore } from "../src/state/envs.ts";
import type { AppRecord, VmRecord, EnvRecord, EnvDbBackend } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

function makeEnv(
  branch: string,
  dbBackend: EnvDbBackend = "dblab",
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
    dbBackend,
    ...(dbBackend === "dblab" ? { dbName: name } : {}),
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

// ---------------------------------------------------------------------------
// Fake dep factories
// ---------------------------------------------------------------------------

/**
 * Batched probe fake driven by a per-clone-id verdict map. Throws if "throw" is
 * passed as the WHOLE-batch verdict (sentinel key "*"). Records the batch sizes.
 */
function makeFakeProbe(
  verdicts: Record<string, CloneHealth | "throw">,
): { probeClones: HealDeps["probeClones"]; batches: number } {
  let batches = 0;
  const probeClones: HealDeps["probeClones"] = async (_vm, _app, envs) => {
    batches++;
    if (verdicts["*"] === "throw") throw new Error("ssh transport boom");
    const m = new Map<string, CloneHealth>();
    for (const e of envs) {
      const id = e.dbName ?? e.name;
      const v = verdicts[id];
      // omit a clone id from the map to exercise the "missing → unknown" path
      if (v !== undefined && v !== "throw") m.set(id, v);
    }
    return m;
  };
  return {
    probeClones,
    get batches() { return batches; },
  } as { probeClones: HealDeps["probeClones"]; batches: number };
}

function makeFakeRecreate(
  store: EnvStore,
  outcomes: Record<string, RecreateOutcome> = {},
  onCall?: (id: string) => void,
): { recreate: HealDeps["recreate"]; calls: string[] } {
  const calls: string[] = [];
  const recreate: HealDeps["recreate"] = async (_vm, _app, env) => {
    const id = env.dbName ?? env.name;
    calls.push(id);
    onCall?.(id);
    if (outcomes[id] === "throw" as unknown as RecreateOutcome) {
      throw new Error(`recreate boom for ${id}`);
    }
    const outcome = outcomes[id] ?? "ok";
    if (outcome === "ok") store.upsert({ ...env, createdAt: "2026-06-19T03:01:00.000Z" });
    return outcome;
  };
  return { recreate, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runHealPass (samohost #78)", () => {
  let dir: string;
  let store: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-heal-"));
    store = new EnvStore(join(dir, "envs.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("dead clone → recreate called → healed; ONE batched probe used", async () => {
    const app = makeApp();
    const vm = makeVm();
    const env = makeEnv("preview/yellow-background", "dblab");
    store.upsert(env);
    const id = env.dbName!;

    const probe = makeFakeProbe({ [id]: "dead" });
    const { recreate, calls } = makeFakeRecreate(store);
    const cap = capture();

    const summary: HealSummary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(probe.batches).toBe(1); // single batched probe, never per-env
    expect(calls).toEqual([id]);
    expect(summary.examined).toBe(1);
    expect(summary.healed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]!.action).toBe("healed");
    expect(store.get(vm.id, app.name, env.branch)).toBeDefined();
  });

  test("alive clone → recreate NOT called → healthy (untouched)", async () => {
    const app = makeApp();
    const vm = makeVm();
    const env = makeEnv("preview/modern-font", "dblab");
    store.upsert(env);
    const id = env.dbName!;

    const probe = makeFakeProbe({ [id]: "alive" });
    const { recreate, calls } = makeFakeRecreate(store);
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toEqual([]);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]!.action).toBe("healthy");
  });

  test("unknown → fail-closed → recreate NOT called → skipped", async () => {
    const app = makeApp();
    const vm = makeVm();
    const env = makeEnv("preview/pink-background", "dblab");
    store.upsert(env);

    const probe = makeFakeProbe({ [env.dbName!]: "unknown" });
    const { recreate, calls } = makeFakeRecreate(store);
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toEqual([]);
    expect(summary.results[0]!.action).toBe("skipped");
    expect(summary.failed).toBe(0);
  });

  test("clone id missing from probe map → treated as unknown (fail-closed)", async () => {
    const app = makeApp();
    const vm = makeVm();
    const env = makeEnv("preview/ghost", "dblab");
    store.upsert(env);

    const probe = makeFakeProbe({}); // map omits the clone id entirely
    const { recreate, calls } = makeFakeRecreate(store);
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toEqual([]);
    expect(summary.results[0]!.action).toBe("skipped");
    expect(summary.results[0]!.health).toBe("unknown");
  });

  test("recreate budget → skipped + deferred; remaining dead envs also deferred", async () => {
    const app = makeApp();
    const vm = makeVm();
    const e1 = makeEnv("preview/a", "dblab");
    const e2 = makeEnv("preview/b", "dblab");
    const e3 = makeEnv("preview/c", "dblab");
    store.upsert(e1); store.upsert(e2); store.upsert(e3);

    const probe = makeFakeProbe({
      [e1.dbName!]: "dead",
      [e2.dbName!]: "dead",
      [e3.dbName!]: "dead",
    });
    // First recreate hits the budget wall → "budget"; the pass must STOP
    // attempting further re-creates this cycle.
    const { recreate, calls } = makeFakeRecreate(store, { [e1.dbName!]: "budget" });
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toEqual([e1.dbName!]); // only ONE recreate attempted
    expect(summary.healed).toBe(0);
    expect(summary.failed).toBe(0); // budget is NOT a failure
    expect(summary.deferred).toBe(3); // all three dead envs deferred
    for (const r of summary.results) expect(r.action).toBe("skipped");
  });

  test("per-env isolation: recreate throw → heal-failed; others still healed", async () => {
    const app = makeApp();
    const vm = makeVm();
    const e1 = makeEnv("preview/a", "dblab");
    const e2 = makeEnv("preview/b", "dblab");
    store.upsert(e1); store.upsert(e2);

    const probe = makeFakeProbe({ [e1.dbName!]: "dead", [e2.dbName!]: "dead" });
    const { recreate, calls } = makeFakeRecreate(store, {
      [e1.dbName!]: "throw" as unknown as RecreateOutcome,
      [e2.dbName!]: "ok",
    });
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toContain(e1.dbName!);
    expect(calls).toContain(e2.dbName!);
    expect(summary.healed).toBe(1);
    expect(summary.failed).toBe(1);
    const byEnv = Object.fromEntries(summary.results.map((r) => [r.env, r.action]));
    expect(byEnv[e1.name]).toBe("heal-failed");
    expect(byEnv[e2.name]).toBe("healed");
  });

  test("backend filter: template/none envs are NOT examined", async () => {
    const app = makeApp();
    const vm = makeVm();
    store.upsert(makeEnv("preview/tpl", "template"));
    store.upsert(makeEnv("preview/none", "none"));
    const dblabEnv = makeEnv("preview/dblab", "dblab");
    store.upsert(dblabEnv);

    let probedIds: string[] = [];
    const probeClones: HealDeps["probeClones"] = async (_vm, _app, envs) => {
      probedIds = envs.map((e) => e.dbName ?? e.name);
      return new Map(probedIds.map((id) => [id, "alive" as CloneHealth]));
    };
    const { recreate } = makeFakeRecreate(store);
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(probedIds).toEqual([dblabEnv.dbName!]);
    expect(summary.examined).toBe(1);
  });

  test("probe throw → every env deferred; cycle does not abort", async () => {
    const app = makeApp();
    const vm = makeVm();
    store.upsert(makeEnv("preview/a", "dblab"));
    store.upsert(makeEnv("preview/b", "dblab"));

    const probe = makeFakeProbe({ "*": "throw" });
    const { recreate, calls } = makeFakeRecreate(store);
    const cap = capture();

    const summary = await runHealPass(
      app, vm, { probeClones: probe.probeClones, recreate, envStore: store }, cap.out, cap.err,
    );

    expect(calls).toEqual([]);
    expect(summary.failed).toBe(0);
    expect(summary.deferred).toBe(2);
    for (const r of summary.results) expect(r.action).toBe("skipped");
  });
});
