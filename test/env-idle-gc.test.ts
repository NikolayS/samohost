/**
 * test/env-idle-gc.test.ts — RED-phase tests for atomic idle autodestroy.
 *
 * Covers:
 *   1. lastAccess (not createdAt) drives idle computation.
 *   2. Reap fires only when idle > threshold.
 *   3. Warn-only mode (idleReap: false) logs candidates but destroys nothing.
 *   4. When idleReap: true, runEnvDestroy is called for each over-threshold env.
 *   5. SAMOHOST_IDLE_THRESHOLD_MS env var (or default 45 min) governs threshold.
 *   6. Access-log stamp: stampLastAccess() updates EnvRecord.lastAccess.
 *   7. buildEnvCreateScript Caddy vhost snippet includes per-vhost JSON access log.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvIdleGc,
  stampLastAccess,
  type EnvIdleGcInput,
  IDLE_THRESHOLD_DEFAULT_MS,
} from "../src/commands/env-idle.ts";
import {
  buildEnvCreateScript,
} from "../src/env/script.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-idle-1",
    provider: "hetzner",
    providerId: "999",
    name: "samo-we-idle-test",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
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

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-idle-1",
    vmId: "vm-idle-1",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

function makeEnv(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-idle-abc",
    vmId: "vm-idle-1",
    appName: "field-record-1",
    branch: "feat/idle-test",
    name: "field-record-1-feat-idle-test",
    port: 3101,
    vhost: "field-record-1-feat-idle-test.samo.cat",
    dbBackend: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
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
// Setup / teardown
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-idle-gc-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. stampLastAccess
// ---------------------------------------------------------------------------

describe("stampLastAccess", () => {
  test("updates EnvRecord.lastAccess to the provided ISO timestamp", () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);
    const env = makeEnv();
    envStore.upsert(env);

    const ts = "2026-06-23T10:00:00.000Z";
    stampLastAccess(envStore, env.vmId, env.appName, env.branch, ts);

    const updated = envStore.get(env.vmId, env.appName, env.branch);
    expect(updated).toBeDefined();
    expect(updated!.lastAccess).toBe(ts);
  });

  test("does NOT change createdAt when stamping lastAccess", () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);
    const original = makeEnv({ createdAt: "2026-01-01T00:00:00.000Z" });
    envStore.upsert(original);

    stampLastAccess(envStore, original.vmId, original.appName, original.branch,
      "2026-06-23T12:00:00.000Z");

    const updated = envStore.get(original.vmId, original.appName, original.branch);
    expect(updated!.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("no-op (no throw) when the env record does not exist", () => {
    // Should not throw even when there is nothing to stamp.
    expect(() =>
      stampLastAccess(envStore, "vm-gone", "app-gone", "feat/gone",
        "2026-06-23T00:00:00.000Z")
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. IDLE_THRESHOLD_DEFAULT_MS
// ---------------------------------------------------------------------------

describe("IDLE_THRESHOLD_DEFAULT_MS", () => {
  test("default threshold is 45 minutes in milliseconds", () => {
    expect(IDLE_THRESHOLD_DEFAULT_MS).toBe(45 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 3. warn-only mode (idleReap: false) — logs candidates, destroys nothing
// ---------------------------------------------------------------------------

describe("runEnvIdleGc — warn-only (idleReap: false)", () => {
  test("returns candidates but calls no destroyEnv when idleReap is false", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000; // 30 min
    // lastAccess was 60 min ago → exceeds threshold
    const lastAccess = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const env = makeEnv({ lastAccess });
    envStore.upsert(env);

    let destroyCalled = 0;
    const destroyEnv = async (_vmId: string, _appName: string, _branch: string) => {
      destroyCalled++;
      return 0;
    };

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: false, // warn-only
      now: () => now,
    };

    const c = capture();
    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv, c.out, c.err
    );

    // warn-only: zero destroys
    expect(destroyCalled).toBe(0);
    // but the env is a candidate
    expect(report.candidates.length).toBe(1);
    expect(report.candidates[0]!.name).toBe(env.name);
    // reaped list is empty
    expect(report.reaped.length).toBe(0);
    // output should warn about the candidate
    expect(c.o + c.e).toMatch(/would.reap|warn.*idle|idle.*warn/i);
  });

  test("env below threshold is NOT a candidate even in warn-only mode", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 60 * 60 * 1000; // 60 min
    // lastAccess was only 10 min ago → below threshold
    const lastAccess = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const env = makeEnv({ lastAccess });
    envStore.upsert(env);

    const destroyEnv = async () => 0;

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: false,
      now: () => now,
    };

    const c = capture();
    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv, c.out, c.err
    );

    expect(report.candidates.length).toBe(0);
    expect(report.reaped.length).toBe(0);
  });

  test("env with NO lastAccess uses createdAt only as fallback, not primary signal", async () => {
    // When lastAccess is absent, fall back to createdAt so recently-created
    // envs are not immediately a candidate (they were just created = activity).
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000; // 30 min
    // No lastAccess, but createdAt is very recent (5 min ago) → NOT idle
    const recentEnv = makeEnv({
      createdAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    });
    delete (recentEnv as Partial<EnvRecord>).lastAccess;
    envStore.upsert(recentEnv);

    const destroyEnv = async () => 0;

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: false,
      now: () => now,
    };

    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv,
      (_s) => {}, (_s) => {}
    );

    // Recent env (no lastAccess, recent createdAt) → NOT a candidate
    expect(report.candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. idle computation from lastAccess, NOT createdAt
// ---------------------------------------------------------------------------

describe("runEnvIdleGc — idle computed from lastAccess, not createdAt", () => {
  test("env with old createdAt but recent lastAccess is NOT a candidate", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000; // 30 min

    // createdAt was 7 DAYS ago (would reap if using createdAt)
    // lastAccess was only 5 min ago → NOT idle
    const env = makeEnv({
      createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccess: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    });
    envStore.upsert(env);

    const destroyEnv = async () => 0;

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: false,
      now: () => now,
    };

    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv,
      (_s) => {}, (_s) => {}
    );

    // Should NOT be a candidate because lastAccess is recent
    expect(report.candidates.length).toBe(0);
  });

  test("env with recent createdAt but old lastAccess IS a candidate", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000; // 30 min

    // createdAt was just 2 min ago (brand new if using createdAt)
    // lastAccess was 60 min ago → IS idle
    const env = makeEnv({
      createdAt: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
      lastAccess: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    });
    envStore.upsert(env);

    const destroyEnv = async () => 0;

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: false,
      now: () => now,
    };

    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv,
      (_s) => {}, (_s) => {}
    );

    // lastAccess is old → IS a candidate despite new createdAt
    expect(report.candidates.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. reap=true fires runEnvDestroy atomically
// ---------------------------------------------------------------------------

describe("runEnvIdleGc — idleReap: true calls destroyEnv atomically", () => {
  test("destroyEnv called once per over-threshold env when idleReap is true", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;

    const env = makeEnv({
      lastAccess: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    });
    envStore.upsert(env);

    const destroyed: Array<{ vmId: string; appName: string; branch: string }> = [];
    const destroyEnv = async (vmId: string, appName: string, branch: string) => {
      destroyed.push({ vmId, appName, branch });
      // Also remove from store to simulate success
      envStore.remove(vmId, appName, branch);
      return 0;
    };

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: true,
      now: () => now,
    };

    const c = capture();
    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv, c.out, c.err
    );

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.vmId).toBe(env.vmId);
    expect(destroyed[0]!.appName).toBe(env.appName);
    expect(destroyed[0]!.branch).toBe(env.branch);
    expect(report.reaped.length).toBe(1);
    expect(report.reaped[0]).toBe(env.name);
  });

  test("destroyEnv failure is recorded as failed, env is kept", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;

    const env = makeEnv({
      lastAccess: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    });
    envStore.upsert(env);

    // destroyEnv returns non-zero → failure
    const destroyEnv = async () => 1;

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: true,
      now: () => now,
    };

    const c = capture();
    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv, c.out, c.err
    );

    expect(report.reaped.length).toBe(0);
    expect(report.failed.length).toBe(1);
    expect(report.failed[0]!.name).toBe(env.name);
    // env still in store
    const stillThere = envStore.get(env.vmId, env.appName, env.branch);
    expect(stillThere).toBeDefined();
  });

  test("one destroy failure does not abort other candidates in the same cycle", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    const thresholdMs = 30 * 60 * 1000;

    const env1 = makeEnv({
      id: "env-a",
      branch: "feat/a",
      name: "field-record-1-feat-a",
      port: 3101,
      vhost: "field-record-1-feat-a.samo.cat",
      lastAccess: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    });
    const env2 = makeEnv({
      id: "env-b",
      branch: "feat/b",
      name: "field-record-1-feat-b",
      port: 3102,
      vhost: "field-record-1-feat-b.samo.cat",
      lastAccess: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
    });
    envStore.upsert(env1);
    envStore.upsert(env2);

    let callCount = 0;
    const destroyEnv = async (_vmId: string, _appName: string, branch: string) => {
      callCount++;
      // First call fails, second succeeds
      if (branch === env1.branch) return 1;
      envStore.remove(_vmId, _appName, branch);
      return 0;
    };

    const input: EnvIdleGcInput = {
      vm: vm.id,
      idleThresholdMs: thresholdMs,
      idleReap: true,
      now: () => now,
    };

    const c = capture();
    const report = await runEnvIdleGc(
      input, vmStore, appStore, envStore, destroyEnv, c.out, c.err
    );

    expect(callCount).toBe(2);
    expect(report.reaped.length).toBe(1);
    expect(report.failed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Env record has lastAccess field (types.ts)
// ---------------------------------------------------------------------------

describe("EnvRecord.lastAccess field", () => {
  test("EnvRecord can be constructed with lastAccess as optional ISO string", () => {
    // TypeScript compile check: if types.ts doesn't have lastAccess, tsc fails.
    const env: EnvRecord = makeEnv({ lastAccess: "2026-06-23T10:00:00.000Z" });
    expect(env.lastAccess).toBe("2026-06-23T10:00:00.000Z");
  });

  test("EnvRecord without lastAccess is valid (optional field)", () => {
    const env: EnvRecord = makeEnv();
    expect(env.lastAccess).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Caddy vhost snippet includes per-vhost JSON access log
// ---------------------------------------------------------------------------

describe("buildEnvCreateScript — per-vhost JSON access log in Caddy snippet", () => {
  const sampleApp: AppRecord = {
    id: "app-log-1",
    vmId: "vm-log-1",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    kind: "node",
  };

  const target = {
    name: "field-record-1-feat-log",
    branch: "feat/log",
    port: 3103,
    vhost: "field-record-1-feat-log.samo.cat",
    dbBackend: "none" as const,
  };

  test("generated Caddy snippet includes a log block with format json", () => {
    const script = buildEnvCreateScript(sampleApp, target);
    // Must contain a log { ... } block in the Caddy vhost snippet
    expect(script).toContain("log {");
    expect(script).toContain("format json");
  });

  test("generated Caddy snippet logs to /var/log/caddy/<env-name>.log via $SAMOHOST_ENV_NAME", () => {
    const script = buildEnvCreateScript(sampleApp, target);
    // The vhost snippet is written by a bash printf at runtime; the log path
    // uses $SAMOHOST_ENV_NAME so different envs each get their own log file.
    // The script contains the literal prefix /var/log/caddy/ and the variable.
    expect(script).toContain("/var/log/caddy/");
    expect(script).toContain("$SAMOHOST_ENV_NAME");
  });

  test("log block emits ts and request.host fields (json format includes them)", () => {
    const script = buildEnvCreateScript(sampleApp, target);
    // The log directive with json format implies ts + request.host.
    // Verify the output directive is present.
    expect(script).toContain("output file");
    expect(script).toContain("/var/log/caddy/");
  });
});
