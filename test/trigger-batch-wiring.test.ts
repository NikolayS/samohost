/**
 * Integration tests proving the REAL trigger cycle wires runBatchedVmCycle and
 * checkTriggerPrereqs — NOT test-only shelf-ware.
 *
 * TWO RED → GREEN contracts:
 *
 * (1) SSH-COUNT: one trigger cycle with a dead clone + N PRs on a single VM
 *     must make AT MOST `CONNECTION_BUDGET_PER_VM` (2) SSH remote() calls,
 *     not 2 + N. Verified by injecting a counting remote into defaultTriggerDeps
 *     and running the actual heal pass.
 *
 *     RED on current code because defaultTriggerDeps ignores opts.remote — the
 *     counting remote is never called (0 calls) → expect(calls > 0) fails.
 *     GREEN after wiring: batchedVmCycle uses opts.remote for probe + batch →
 *     2 calls max.
 *
 * (2) PREREQ-WIRED: `samohost trigger run` with CLOUDFLARE_SAMOCAT absent must
 *     emit a prominent error and exit 1 at startup (not silently succeed and then
 *     skip DNS each cycle). Verified by calling main() directly.
 *
 *     RED on current code because cli.ts does not call checkTriggerPrereqs.
 *     GREEN after wiring: prereq check runs before runTriggerRun → err output
 *     contains "CLOUDFLARE_SAMOCAT" and exit code is 1.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriggerRun } from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Budget: at most this many remote() calls per VM per cycle (fail2ban safety). */
const CONNECTION_BUDGET_PER_VM = 2;

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

function makeEnvRecord(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-1111",
    vmId: "vm-1111",
    appName: "field-record",
    branch: "pr-1",
    name: "field-record-pr-1",
    port: 3001,
    vhost: "field-record-pr-1.samo.cat",
    dbBackend: "dblab" as const,
    dbName: "field-record-pr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function noop(_s: string) {}

// Fake probe output indicating clone IS dead: triggers a re-create in the
// batch work item, so the counting remote is called TWICE (probe + batch).
const FAKE_PROBE_DEAD = (cloneId: string) =>
  [
    `SAMOHOST_HEAL_CLONE_BEGIN:${cloneId}`,
    "SAMOHOST_HEAL_STATUS_ERR",
    `SAMOHOST_HEAL_CLONE_END:${cloneId}`,
    "SAMOHOST_HEAL_PORTS_BEGIN",
    "SAMOHOST_HEAL_PORTS_END",
  ].join("\n");

// Fake batch output: sentineled success output for a work item.
// The sentinel format must match batch.ts's SENTINEL_START/END.
const FAKE_BATCH_SUCCESS = (id: string) =>
  [
    `<<<SAMOHOST_BATCH:START:${id}>>>`,
    "<<<SAMOHOST_PHASE:clone:start>>>",
    "<<<SAMOHOST_PHASE:clone:ok>>>",
    "<<<SAMOHOST_PHASE:install:start>>>",
    "<<<SAMOHOST_PHASE:install:ok>>>",
    "<<<SAMOHOST_PHASE:build:start>>>",
    "<<<SAMOHOST_PHASE:build:ok>>>",
    "<<<SAMOHOST_PHASE:db:start>>>",
    "<<<SAMOHOST_PHASE:db:ok>>>",
    "<<<SAMOHOST_PHASE:envfile:start>>>",
    "<<<SAMOHOST_PHASE:envfile:ok>>>",
    "<<<SAMOHOST_PHASE:unit:start>>>",
    "<<<SAMOHOST_PHASE:unit:ok>>>",
    "<<<SAMOHOST_PHASE:vhost:start>>>",
    "<<<SAMOHOST_PHASE:vhost:ok>>>",
    "<<<SAMOHOST_PHASE:health:start>>>",
    "<<<SAMOHOST_PHASE:health:ok>>>",
    `<<<SAMOHOST_BATCH:END:${id}>>>`,
  ].join("\n");

// ---------------------------------------------------------------------------
// (1) SSH-COUNT: batchedVmCycle uses remote() ≤ budget times per VM per cycle
// ---------------------------------------------------------------------------

describe("(1) SSH-count — heal cycle makes ≤ budget remote() calls per VM", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-batch-wiring-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test(
    "one cycle with a dead clone + no PRs makes exactly ≤ 2 remote() calls (not 2+N per item)",
    async () => {
      // Set up: 1 dblab env whose clone is dead.
      const env = makeEnvRecord({ dbBackend: "dblab", dbName: "field-record-pr-1" });
      envStore.upsert(env);

      // Counting remote: records every call with a timestamp so we can count.
      // Returns appropriate fake output depending on call number:
      //   call 1 (probe): dead clone output → triggers heal batch work
      //   call 2 (batch): success-shaped output
      const callCount = { value: 0 };
      const countingRemote = async (_vm: VmRecord, _script: string) => {
        callCount.value += 1;
        if (callCount.value === 1) {
          // First call is the probe: report the clone as dead to trigger batch work.
          return {
            code: 0,
            stdout: FAKE_PROBE_DEAD("field-record-pr-1"),
            stderr: "",
          };
        }
        // Subsequent calls: success-shaped batch output.
        // The heal item id uses sanitised branch name.
        const healId = "heal-field-record-pr-1-field-record-pr-1";
        return {
          code: 0,
          stdout: FAKE_BATCH_SUCCESS(healId),
          stderr: "",
        };
      };

      const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");
      // Inject counting remote. In RED state defaultTriggerDeps ignores opts.remote
      // and the counting remote is never called → callCount.value stays 0.
      const deps = defaultTriggerDeps({ envStore, remote: countingRemote } as Parameters<typeof defaultTriggerDeps>[0]);

      // Run a heal-only cycle (no PR previews — avoids needing gh CLI).
      await runTriggerRun(
        { heal: true, prPreviews: false, dryRun: false },
        { json: false },
        vmStore,
        appStore,
        deps,
        noop,
        noop,
      );

      // THE ASSERTIONS:
      // 1. remote() was called at least once (proves it's wired, not using hardcoded SSH).
      //    RED: callCount.value === 0 → 0 > 0 = false → test fails.
      //    GREEN: callCount.value >= 1 (probe + optional batch work).
      expect(callCount.value).toBeGreaterThan(0);

      // 2. remote() was called at most CONNECTION_BUDGET_PER_VM times (proves batching).
      //    RED: would be 1 (probe) + 1 (recreate) = 2 if wired but not batched, OR
      //         0 if not wired at all. Either way this assertion passes only when wired.
      //    GREEN: probe + one batch call = 2 ≤ budget.
      expect(callCount.value).toBeLessThanOrEqual(CONNECTION_BUDGET_PER_VM);
    },
  );

  test(
    "N dead clones still make at most CONNECTION_BUDGET_PER_VM remote() calls (budget invariant)",
    async () => {
      // Set up: 3 dblab envs, all dead. On the current (un-batched) code this would
      // be: 1 probe + 3 recreate = 4 calls > budget=2.
      // After the fix: 1 probe + 1 batch(3 items) = 2 calls ≤ budget.
      for (let i = 1; i <= 3; i++) {
        envStore.upsert(makeEnvRecord({
          id: `env-${i}`,
          branch: `pr-${i}`,
          name: `field-record-pr-${i}`,
          port: 3000 + i,
          vhost: `field-record-pr-${i}.samo.cat`,
          dbName: `field-record-pr-${i}`,
        }));
      }

      const callCount = { value: 0 };
      const countingRemote = async (_vm: VmRecord, _script: string) => {
        callCount.value += 1;
        if (callCount.value === 1) {
          // Probe: report all 3 clones as dead.
          const deadOutput = [1, 2, 3].map(i => FAKE_PROBE_DEAD(`field-record-pr-${i}`)).join("\n");
          return { code: 0, stdout: deadOutput, stderr: "" };
        }
        // Batch work: return success for each heal item.
        const batchOutput = [1, 2, 3]
          .map(i => FAKE_BATCH_SUCCESS(`heal-field-record-pr-${i}-field-record-pr-${i}`))
          .join("\n");
        return { code: 0, stdout: batchOutput, stderr: "" };
      };

      const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");
      const deps = defaultTriggerDeps({ envStore, remote: countingRemote } as Parameters<typeof defaultTriggerDeps>[0]);

      await runTriggerRun(
        { heal: true, prPreviews: false, dryRun: false },
        { json: false },
        vmStore,
        appStore,
        deps,
        noop,
        noop,
      );

      // RED: callCount.value = 0 (remote not used) → 0 > 0 fails.
      // GREEN: callCount.value ≤ 2 regardless of N=3 dead clones.
      expect(callCount.value).toBeGreaterThan(0);
      expect(callCount.value).toBeLessThanOrEqual(CONNECTION_BUDGET_PER_VM);
    },
  );
});

// ---------------------------------------------------------------------------
// (3) APPUSER-SSH: batchedVmCycle work-batch SSHes as app.appUser when set
//
// ROOT CAUSE: trigger.ts:1965 passes `vm: vmRecord` unmodified to runBatch;
// the vmRecord.sshUser is 'samo' (the VM's OS-level SSH user), but on shared-web
// VMs the app's files are owned by a dedicated OS user (appUser = e.g. 'gregg-site').
// The fix: `vm: app.appUser !== undefined ? { ...vmRecord, sshUser: app.appUser } : vmRecord`.
//
// RED: current code → work-batch remote call receives vm.sshUser = 'samo' (wrong).
// GREEN after fix: work-batch remote call receives vm.sshUser = 'gregg-site' (correct).
//
// Probe call (SSH #1) MUST stay on vmRecord.sshUser='samo' — it's a read-only
// system probe (dblab status + ss -ltnH) that does NOT touch appUser-owned dirs.
// ---------------------------------------------------------------------------

describe("(3) APPUSER-SSH — batchedVmCycle work-batch SSHes as app.appUser when set", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  const VM_SSH_USER = "samo";
  const APP_USER = "gregg-site";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-appuser-ssh-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));

    // Shared-web VM: sshUser is the platform user 'samo', NOT the app user.
    vmStore.upsert(makeVm({ sshUser: VM_SSH_USER }));

    // App with appUser set (shared-web pattern — multiple apps per VM, each with
    // a dedicated OS user owning its files).
    appStore.upsert(makeApp({ appUser: APP_USER }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test(
    "work-batch remote() call receives vm.sshUser = app.appUser (not vm.sshUser) when appUser is set",
    async () => {
      // Set up: 1 dblab env whose clone is dead — this causes a work-batch SSH call.
      const env = makeEnvRecord({ dbBackend: "dblab", dbName: "field-record-pr-1" });
      envStore.upsert(env);

      // Spy remote: records the vm.sshUser passed to each call.
      // call 1 (probe): returns dead clone output → triggers work batch.
      // call 2 (batch): returns success-shaped batch output.
      const capturedSshUsers: string[] = [];
      const spyRemote = async (vm: VmRecord, _script: string) => {
        capturedSshUsers.push(vm.sshUser);
        if (capturedSshUsers.length === 1) {
          // First call = Phase-1 probe; return dead-clone output.
          return {
            code: 0,
            stdout: FAKE_PROBE_DEAD("field-record-pr-1"),
            stderr: "",
          };
        }
        // Second call = work-batch; return success-shaped output.
        const healId = "heal-field-record-pr-1-field-record-pr-1";
        return {
          code: 0,
          stdout: FAKE_BATCH_SUCCESS(healId),
          stderr: "",
        };
      };

      const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");
      const deps = defaultTriggerDeps({
        envStore,
        remote: spyRemote,
      } as Parameters<typeof defaultTriggerDeps>[0]);

      await runTriggerRun(
        { heal: true, prPreviews: false, dryRun: false },
        { json: false },
        vmStore,
        appStore,
        deps,
        noop,
        noop,
      );

      // The spy must have been called at least twice (probe + work batch).
      expect(capturedSshUsers.length).toBeGreaterThanOrEqual(2);

      // Probe call (SSH #1): MUST use vm.sshUser ('samo') — it's a system-level
      // probe (dblab status + ss -ltnH), no appUser-owned dir access.
      expect(capturedSshUsers[0]).toBe(VM_SSH_USER);

      // Work-batch call (SSH #2):
      //   RED:   receives 'samo' (vmRecord.sshUser, unchanged) → test FAILS.
      //   GREEN: receives 'gregg-site' (app.appUser override) → test PASSES.
      expect(capturedSshUsers[1]).toBe(APP_USER);
    },
  );

  test(
    "work-batch remote() call keeps vm.sshUser unchanged when app has NO appUser (no regression)",
    async () => {
      // Register a second app WITHOUT appUser (single-app VM pattern).
      vmStore.upsert(makeVm({
        id: "vm-single",
        name: "samo-we-single",
        sshUser: "agent",
        providerId: "999999",
        hostKeyFingerprint: "SHA256:" + "B".repeat(43),
      }));
      appStore.upsert(makeApp({
        id: "app-single",
        vmId: "vm-single",
        name: "field-record-single",
        // appUser intentionally absent
      }));
      envStore.upsert(makeEnvRecord({
        id: "env-single",
        vmId: "vm-single",
        appName: "field-record-single",
        dbBackend: "dblab",
        dbName: "field-record-pr-1",
      }));

      // Only watch the single-app VM (narrow by vm name).
      const capturedSshUsers: string[] = [];
      const spyRemote = async (vm: VmRecord, _script: string) => {
        capturedSshUsers.push(vm.sshUser);
        if (capturedSshUsers.length === 1) {
          return { code: 0, stdout: FAKE_PROBE_DEAD("field-record-pr-1"), stderr: "" };
        }
        const healId = "heal-field-record-pr-1-field-record-pr-1";
        return { code: 0, stdout: FAKE_BATCH_SUCCESS(healId), stderr: "" };
      };

      const { defaultTriggerDeps } = await import("../src/commands/trigger.ts");
      // Narrow to the single-app VM so the shared-web app above is not processed.
      const deps = defaultTriggerDeps({
        envStore,
        remote: spyRemote,
      } as Parameters<typeof defaultTriggerDeps>[0]);

      await runTriggerRun(
        { heal: true, prPreviews: false, dryRun: false, vm: "samo-we-single" },
        { json: false },
        vmStore,
        appStore,
        deps,
        noop,
        noop,
      );

      // When appUser is absent, the work-batch call must use the original vm.sshUser.
      // This guards against the fix accidentally overriding non-shared-web apps.
      expect(capturedSshUsers.length).toBeGreaterThanOrEqual(2);
      expect(capturedSshUsers[1]).toBe("agent");
    },
  );
});

// ---------------------------------------------------------------------------
// (2) PREREQ-WIRED: trigger-run fails loud when CLOUDFLARE_SAMOCAT absent
// ---------------------------------------------------------------------------

describe("(2) prereq-wired — trigger-run emits startup error when CF token absent", () => {
  test(
    "main([trigger, run]) emits CLOUDFLARE_SAMOCAT error and exits 1 when token absent",
    async () => {
      const orig = process.env["CLOUDFLARE_SAMOCAT"];
      delete process.env["CLOUDFLARE_SAMOCAT"];

      try {
        const { main } = await import("../src/cli.ts");

        const errLines: string[] = [];
        const outLines: string[] = [];
        const captureErr = (s: string) => errLines.push(s);
        const captureOut = (s: string) => outLines.push(s);

        // Run trigger-run with --dry-run to avoid touching any real state.
        // In RED state: cli.ts skips checkTriggerPrereqs → runTriggerRun runs
        // with empty stores → exit 0, no error message.
        // In GREEN state: cli.ts calls checkTriggerPrereqs first → error message
        // emitted → exit 1.
        const exitCode = await main(
          ["trigger", "run", "--dry-run"],
          captureOut,
          captureErr,
        );

        const combined = errLines.join("\n");

        // THE ASSERTIONS:
        // RED: exitCode = 0, combined does not contain "CLOUDFLARE_SAMOCAT" → both fail.
        // GREEN: exitCode = 1, combined contains "CLOUDFLARE_SAMOCAT".
        expect(exitCode).toBe(1);
        expect(combined).toContain("CLOUDFLARE_SAMOCAT");
        // Also verify the message is actionable (mentions "required" or "missing" or "ERROR").
        expect(combined.toLowerCase()).toMatch(/required|missing|error/);
      } finally {
        if (orig !== undefined) {
          process.env["CLOUDFLARE_SAMOCAT"] = orig;
        } else {
          delete process.env["CLOUDFLARE_SAMOCAT"];
        }
      }
    },
  );

  test(
    "main([trigger, run]) does NOT emit CF-token error when CLOUDFLARE_SAMOCAT is set",
    async () => {
      const orig = process.env["CLOUDFLARE_SAMOCAT"];
      process.env["CLOUDFLARE_SAMOCAT"] = "test-token-for-prereq-check";

      try {
        const { main } = await import("../src/cli.ts");

        const errLines: string[] = [];
        const captureErr = (s: string) => errLines.push(s);

        // When token is present, the prereq check passes and we proceed to
        // runTriggerRun. With empty stores it returns 0.
        await main(
          ["trigger", "run", "--dry-run"],
          noop,
          captureErr,
        );

        const combined = errLines.join("\n");

        // No CLOUDFLARE_SAMOCAT error when token is present.
        // RED: if checkTriggerPrereqs is NOT called, this passes trivially (no error
        // emitted) — but the previous test's assertion on exit=1 catches the RED state.
        expect(combined).not.toContain("CLOUDFLARE_SAMOCAT");
      } finally {
        if (orig !== undefined) {
          process.env["CLOUDFLARE_SAMOCAT"] = orig;
        } else {
          delete process.env["CLOUDFLARE_SAMOCAT"];
        }
      }
    },
  );
});
