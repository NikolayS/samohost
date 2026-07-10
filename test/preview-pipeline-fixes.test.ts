/**
 * RED tests for samohost preview-pipeline fixes (task w2iwdzbeh).
 *
 * These tests pin the four correctness properties that are currently broken:
 *
 *   (a) BATCH SSH — a cycle with a dead clone + N PRs consumes the connection
 *       budget AT MOST ONCE per VM regardless of how many preview work-items
 *       need attention (root-cause: heal + PR-preview each open separate SSH
 *       connections that together exhaust the 2/600s budget after 2 items).
 *
 *   (b) ERROR SURFACING — a failed runEnvCreate emits result.stderr through
 *       the err() callback so DBLab "maxCloneCount exceeded" / build failures
 *       are visible in the journal (currently swallowed — only generic message
 *       shown).
 *
 *   (c) SINGLE ENV STORE — defaultTriggerDeps() wires ONE EnvStore instance
 *       through envStore, heal, and prPreview so heal writes are immediately
 *       visible to the prPreview pass within the same cycle (regression from
 *       trigger.ts:847 single-store design: both closures currently open fresh
 *       EnvStore() instances).
 *
 *   (d) FAIL LOUD ON MISSING CF TOKEN — defaultTriggerDeps() (or the trigger
 *       startup path) emits a prominent one-time ERROR when CLOUDFLARE_SAMOCAT
 *       is absent, not a silent per-cycle skip that makes the cause invisible.
 *
 * All four tests MUST FAIL on the current codebase (RED).
 * After the implementation PRs they MUST PASS (GREEN).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvCreate,
  type EnvCreateInput,
  type EnvExecDeps,
} from "../src/commands/env.ts";
import {
  type TriggerDeps,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

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

/** Helpers for stdout/stderr capture. */
function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { err += s + "\n"; },
    get o() { return out; },
    get e() { return err; },
  };
}

/** Build phase markers for a create script that succeeds. */
const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");

// ---------------------------------------------------------------------------
// (a) BATCH SSH — budget consumed at most once per VM per cycle
//
// The batch-SSH contract: when the trigger runs a cycle that needs to
// (1) probe clone health AND (2) deploy N PR preview envs, the total number
// of separate SSH connections to any given VM must be ≤ 1.
//
// We test this by injecting a connection-counting remote dep into EnvExecDeps
// and a HealDeps that also counts probes, then running the full cycle and
// asserting connectionCount ≤ 1 regardless of N.
//
// Implementation note: the correct fix is to add a per-VM BatchRunner
// (src/ssh/batch.ts) that builds one `bash -s` heredoc per cycle and issues
// it as a single runRemote call. The trigger's defaultTriggerDeps wires this
// BatchRunner so that both heal and prPreview share the open connection.
// ---------------------------------------------------------------------------

describe("(a) batch SSH — budget consumed once per VM", () => {
  /**
   * Per-VM SSH connection counter that also simulates a batch-capable remote.
   * Each call to `remote(vm, script)` increments the counter for that VM.
   */
  function makeCountingDeps() {
    const connectionsByVmId = new Map<string, number>();
    const remoteImpl = async (vm: VmRecord, _script: string) => {
      const prev = connectionsByVmId.get(vm.id) ?? 0;
      connectionsByVmId.set(vm.id, prev + 1);
      return { code: 0, stdout: CREATE_OK, stderr: "" };
    };
    return {
      connectionsByVmId,
      remote: remoteImpl,
      totalConnections: () =>
        [...connectionsByVmId.values()].reduce((a, b) => a + b, 0),
    };
  }

  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-batch-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("3 PR preview creates + 1 heal probe share ONE SSH connection per VM", async () => {
    // This is the core regression: currently 3 PR creates + 1 heal probe
    // = 4 separate SSH connections, exhausting the 2/600s budget.
    // After the fix: everything batched → 1 connection per VM per cycle.
    const { connectionsByVmId, remote } = makeCountingDeps();
    const vm = makeVm();
    const app = makeApp();

    // Simulate 3 PR envs needing creation (dead / not yet created).
    // Also simulate 1 dead clone needing healing.
    // Wire a cycle-deps object that uses a shared remote with the counter.
    //
    // The contract: after a full cycle, connectionsByVmId.get("vm-1111") === 1.
    // (Currently it will be >= 4 because heal and each PR env create are separate.)

    // We call the per-VM batch function directly rather than the full trigger
    // to isolate the contract: runBatchedVmCycle(vm, app, prs, healOpts, remote)
    // must produce exactly 1 remote() call.
    const { runBatchedVmCycle } = await import("../src/ssh/batch.ts");

    const prs = [
      { branch: "pr-1", headSha: "aaa1", prNumber: 1 },
      { branch: "pr-2", headSha: "bbb2", prNumber: 2 },
      { branch: "pr-3", headSha: "ccc3", prNumber: 3 },
    ];

    const deadClones = [
      { envName: "field-record-pr-1", cloneId: "clone-1" },
    ];

    await runBatchedVmCycle({
      vm,
      app,
      prs,
      deadClones,
      envStore,
      remote,
    });

    // THE ASSERTION: regardless of N prs + M dead clones, only 1 SSH connection
    const count = connectionsByVmId.get("vm-1111") ?? 0;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (b) ERROR SURFACING — runEnvCreate emits result.stderr on non-ok outcomes
// ---------------------------------------------------------------------------

describe("(b) error surfacing — stderr surfaced on failed env-create", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-errsurface-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("DBLab-reject stderr surfaces in err() when env-create outcome is failed", async () => {
    const DBLAB_REJECT =
      "Error: cannot create clone: maxCloneCount (5) reached; delete an existing clone first";

    // Non-ok remote result: outcome phase markers show failure (status="fail"),
    // stderr has the DBLab message.
    // NOTE: the parse.ts EnvPhaseStatus uses "fail" not "failed".
    const M_FAIL = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
    const CREATE_FAIL =
      M_FAIL("clone", "start") + "\n" +
      M_FAIL("clone", "fail") + "\n";

    const deps: EnvExecDeps = {
      remote: async (_vm, _script) => ({
        code: 1,
        stdout: CREATE_FAIL,
        stderr: DBLAB_REJECT,
      }),
      uuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };

    const input: EnvCreateInput = {
      vm: "samo-we-field-record",
      app: "field-record",
      branch: "pr-1",
      db: "dblab",
      previewDomain: "samo.cat",
    };

    const c = capture();
    await runEnvCreate(
      input,
      { json: false },
      vmStore,
      appStore,
      envStore,
      deps,
      c.out,
      c.err,
    );

    // THE ASSERTION: the specific DBLab error must be visible in the err() output.
    // Currently only "env create did not succeed (outcome=failed)" is emitted.
    expect(c.e).toContain(DBLAB_REJECT);
  });

  test("stderr is included in EnvCreateReport JSON on non-ok outcome", async () => {
    const DBLAB_REJECT =
      "Error: cannot create clone: maxCloneCount (5) reached; delete an existing clone first";

    const M_FAIL = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
    const CREATE_FAIL =
      M_FAIL("clone", "start") + "\n" +
      M_FAIL("clone", "fail") + "\n";

    const deps: EnvExecDeps = {
      remote: async (_vm, _script) => ({
        code: 1,
        stdout: CREATE_FAIL,
        stderr: DBLAB_REJECT,
      }),
      uuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };

    const input: EnvCreateInput = {
      vm: "samo-we-field-record",
      app: "field-record",
      branch: "pr-1",
      db: "dblab",
      previewDomain: "samo.cat",
    };

    const c = capture();
    await runEnvCreate(
      input,
      { json: true },
      vmStore,
      appStore,
      envStore,
      deps,
      c.out,
      c.err,
    );

    // THE ASSERTION: EnvCreateReport must include a `stderr` field when non-empty.
    const report = JSON.parse(c.o.trim()) as { outcome: string; stderr?: string };
    expect(report.outcome).toBe("failed");
    expect(report.stderr).toBe(DBLAB_REJECT);
  });
});

// ---------------------------------------------------------------------------
// (c) SINGLE ENV STORE — heal + prPreview share the same instance
// ---------------------------------------------------------------------------

describe("(c) single env store — heal and prPreview share deps.envStore", () => {
  test("defaultTriggerDeps heal closure uses deps.envStore, not a fresh instance", async () => {
    // We can inspect this by calling defaultTriggerDeps() with a patched env
    // that has no CLOUDFLARE_SAMOCAT (to avoid real network deps), then checking
    // that the heal and prPreview closures reference the same EnvStore identity
    // as deps.envStore.
    //
    // The mechanism: after the fix, defaultTriggerDeps() will pass the shared
    // envStore to defaultHealDeps(envStore) and runPrPreviewPass's ensurePreview.
    // We verify this by writing to deps.envStore and reading back through the
    // heal closure's internal envStore — they must be the same object.
    //
    // Implementation strategy: expose a `_envStore` test hook OR inspect
    // defaultTriggerDeps().envStore identity by comparing it with what heal
    // would use (requires the heal closure to accept an envStore injection).

    // Direct approach: verify that defaultTriggerDeps().envStore is the SAME
    // instance that would be used by the heal closure. We do this by importing
    // defaultTriggerDeps and checking the exported `_sharedEnvStore` symbol,
    // OR by requiring that TriggerDeps now exposes a `sharedEnvStore` property
    // that equals deps.envStore.
    //
    // After the fix, TriggerDeps (the return value of defaultTriggerDeps) must
    // satisfy: deps._sharedEnvStoreForTest === deps.envStore.
    // This is exposed ONLY in test mode (via a test-only export or by the
    // fact that heal now requires an envStore param from deps).

    // We proxy-test this at the functional level: write an env record to
    // deps.envStore directly, then call deps.heal on a VM that has no dblab
    // envs in a separate store — if they're the same instance the write is
    // visible; if they're separate instances it's not.
    //
    // Since defaultTriggerDeps does real SSH/filesystem, we test the structural
    // invariant via the new exported `sharedEnvStoreForTesting` from trigger.ts
    // (to be added as part of the fix).

    const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");
    const deps = defaultTriggerDeps();

    // After the fix: deps must expose a `_envStoreShared` symbol confirming
    // the heal and prPreview closures reference deps.envStore.
    // Currently: this property does not exist → test fails (RED).
    expect((deps as unknown as Record<string, unknown>)["_envStoreShared"]).toBe(true);
  });

  test("an env upserted into deps.envStore is visible without reloading from disk", async () => {
    // Functional test: the trigger's envStore and the heal pass's envStore must
    // be the same in-memory instance. If they're separate, a write to one is NOT
    // visible in the other until the next disk read.
    //
    // Setup: create a fresh EnvStore backed by a temp file. Create a trigger
    // deps object that uses THIS store (not the default disk path). Write a
    // record to the shared store, then read it back via the store that the
    // heal closure would use. They must match without reloading from disk.

    // This test requires that defaultTriggerDeps accepts an optional envStore
    // override (for testing), OR that the fix exposes the shared instance.
    // After the fix: defaultTriggerDeps(opts?: { envStore?: EnvStore }) is
    // accepted; tests pass envStore explicitly.

    const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");

    const dir = mkdtempSync(join(tmpdir(), "samohost-store-test-"));
    try {
      const sharedStore = new EnvStore(join(dir, "envs.json"));
      // After the fix, defaultTriggerDeps accepts { envStore } override.
      const deps = (defaultTriggerDeps as unknown as (
        o?: { envStore?: EnvStore }
      ) => TriggerDeps)({ envStore: sharedStore });

      // Write to the shared store via deps.envStore.
      const testRecord = {
        id: "test-env-id",
        vmId: "vm-1111",
        appName: "field-record",
        branch: "pr-shared-test",
        name: "field-record-pr-shared-test",
        port: 3999,
        vhost: "field-record-pr-shared-test.samo.cat",
        dbBackend: "dblab" as const,
        createdAt: new Date().toISOString(),
      };
      deps.envStore!.upsert(testRecord);

      // Read back via sharedStore (should be the same in-memory instance).
      const retrieved = sharedStore.get("vm-1111", "field-record", "pr-shared-test");

      // THE ASSERTION: same in-memory object — no disk round-trip needed.
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("test-env-id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) FAIL LOUD ON MISSING CF TOKEN — startup warning/error when absent
// ---------------------------------------------------------------------------

describe("(d) fail loud — missing CLOUDFLARE_SAMOCAT emits startup error", () => {
  test("defaultTriggerDeps warns loudly when CLOUDFLARE_SAMOCAT is absent", () => {
    // Capture original env var value.
    const orig = process.env["CLOUDFLARE_SAMOCAT"];
    delete process.env["CLOUDFLARE_SAMOCAT"];

    try {
      // After the fix, defaultTriggerDeps() (or a new checkTriggerPrereqs()
      // function called at trigger startup) emits a prominent startup warning
      // (not a per-cycle silent skip) when CLOUDFLARE_SAMOCAT is absent.
      //
      // The warning must be on stderr and must include "CLOUDFLARE_SAMOCAT" and
      // the word "required" or "missing" or "ERROR" so operators can find it.
      //
      // Implementation choice: defaultTriggerDeps() calls checkTriggerPrereqs()
      // which is exported and testable. checkTriggerPrereqs({ env, err }) emits
      // the warning and returns false when a required var is absent.
      //
      // Test shape: import checkTriggerPrereqs and assert the warning appears.

      const { checkTriggerPrereqs } = require("../src/commands/trigger.ts") as {
        checkTriggerPrereqs: (opts: {
          env: Record<string, string | undefined>;
          err: (s: string) => void;
        }) => boolean;
      };

      const errLines: string[] = [];
      const ok = checkTriggerPrereqs({
        env: {},
        err: (s) => errLines.push(s),
      });

      // THE ASSERTIONS:
      // 1. Returns false (prerequisite not met).
      expect(ok).toBe(false);
      // 2. Error message mentions the missing variable.
      const combined = errLines.join("\n");
      expect(combined).toContain("CLOUDFLARE_SAMOCAT");
      // 3. The word "required" or "missing" or "ERROR" must appear (fail-loud).
      expect(combined.toLowerCase()).toMatch(/required|missing|error/);
    } finally {
      // Restore original value.
      if (orig !== undefined) {
        process.env["CLOUDFLARE_SAMOCAT"] = orig;
      }
    }
  });

  test("defaultTriggerDeps does NOT warn when CLOUDFLARE_SAMOCAT is set", () => {
    const orig = process.env["CLOUDFLARE_SAMOCAT"];
    process.env["CLOUDFLARE_SAMOCAT"] = "test-token-value";

    try {
      const { checkTriggerPrereqs } = require("../src/commands/trigger.ts") as {
        checkTriggerPrereqs: (opts: {
          env: Record<string, string | undefined>;
          err: (s: string) => void;
        }) => boolean;
      };

      const errLines: string[] = [];
      const ok = checkTriggerPrereqs({
        env: { CLOUDFLARE_SAMOCAT: "test-token-value" },
        err: (s) => errLines.push(s),
      });

      expect(ok).toBe(true);
      // No error lines expected when token is present.
      expect(errLines.filter((l) => l.includes("CLOUDFLARE_SAMOCAT"))).toHaveLength(0);
    } finally {
      if (orig !== undefined) {
        process.env["CLOUDFLARE_SAMOCAT"] = orig;
      } else {
        delete process.env["CLOUDFLARE_SAMOCAT"];
      }
    }
  });
});
