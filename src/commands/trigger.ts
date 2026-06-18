/**
 * `samohost trigger` command family (SPEC-DELTA §7 "trigger — samo-level
 * auto-deploy poller").
 *
 * Subcommands:
 *   run   — perform ONE idempotent poll cycle across registered apps:
 *             enumerate candidates, resolve tracked-branch SHAs, and (when a
 *             new SHA is found) call the existing `runAppDeploy` machinery.
 *
 * Design principle: REUSE, don't re-implement.
 * `runAppDeploy` (src/commands/app.ts) already enforces:
 *   - known-bad-SHA guard
 *   - CI-green gate
 *   - health-200 gate (#45)
 *   - rollback and bookkeeping
 *
 * The trigger adds the "should we deploy?" iteration layer and pre-checks CI
 * state via checkCiGreen so that a pending/red/none CI result is classified as
 * a transient SKIP (not a deploy failure). Only on CI "success" does the
 * trigger call deps.deploy (runAppDeploy, which still re-gates on its own).
 *
 * Ordered short-circuits (no CI call made for these):
 *   same-SHA   → up-to-date
 *   known-bad  → known-bad
 *   dry-run    → would-deploy  (offline-safe; no CI call)
 *   CI pending → skipped (reason: ci-pending)
 *   CI none    → skipped (reason: ci-none)
 *   CI failure → skipped (reason: ci-red)
 *   CI success → call deploy; non-zero exit → failed (genuine deploy failure)
 */

import { AppStore } from "../state/apps.ts";
import { StateStore } from "../state/store.ts";
import {
  runAppDeploy,
  defaultAppDeployDeps,
  type AppDeployInput,
  type RefResolver,
} from "./app.ts";
import { checkCiGreen } from "../app/cigate.ts";
import type { DeployOutcome } from "../app/parse.ts";
import {
  runEnvGc,
  defaultEnvExecDeps,
  defaultEnvStore,
} from "./env.ts";
import type { EnvStore } from "../state/envs.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-VM GC summary folded into TriggerRunReport when --gc is active.
 * Returned by the injected gc dep after running a GC pass on one VM.
 */
export interface GcSummary {
  candidates: number;
  reaped: number;
  pruned: number;
}

export interface TriggerRunInput {
  /** Narrow to a single VM by name or id (optional). */
  vm?: string;
  /** Narrow to a single app by name (optional). */
  app?: string;
  dryRun: boolean;
  /**
   * When true, run an env GC pass per live VM in scope after the deploy loop.
   * DEFAULT: false (absent = no GC at all). GC only ever reaps branch-gone and
   * orphan-vm envs (never ttl — no default age-based cleanup in the trigger).
   * Under --dry-run the GC pass runs in dry-run too (reap:false).
   * SAFETY: this must be OPT-IN. The trigger runs unattended; destructive
   * operations must never happen unless explicitly requested.
   */
  gc?: boolean;
}

export interface TriggerAppResult {
  app: string;
  vm: string;
  action:
    | "deployed"
    | "up-to-date"
    | "known-bad"
    | "skipped"
    | "would-deploy"
    | "failed"
    | "error";
  sha?: string;
  reason?: string;
  outcome?: DeployOutcome;
  error?: string;
}

export interface TriggerRunReport {
  cycleAt: string;
  results: TriggerAppResult[];
  deployed: number;
  skipped: number;
  failed: number;
  /**
   * Per-VM GC summary (vmId → counts). Only present when --gc was active and
   * at least one live VM was in scope and the gc dep is wired.
   */
  gc?: Record<string, GcSummary>;
}

/**
 * The CURRIED form of the deploy function: AppDeployDeps are already bound
 * inside it. The trigger injects this to stay decoupled from deploy-specific
 * dependencies (SSH runner, CI fetch, etc.).
 *
 * Signature mirrors `runAppDeploy` minus the `deps` parameter.
 */
export type TriggerDeploy = (
  input: AppDeployInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
) => Promise<number>;

export interface TriggerDeps {
  /** Resolve repo + branch → full SHA (the same RefResolver type as in app.ts). */
  resolveRef: RefResolver;
  /** CURRIED runAppDeploy — AppDeployDeps already bound inside. */
  deploy: TriggerDeploy;
  /**
   * Injected fetch used by checkCiGreen. Prod wires globalThis.fetch; tests
   * inject a fixture that returns workflow_runs JSON without hitting the network.
   */
  fetch: typeof globalThis.fetch;
  /**
   * Optional env override for token lookup inside checkCiGreen (tests inject
   * `{}` or `{ GH_TOKEN: "..." }`; prod uses process.env by default).
   */
  env?: Record<string, string | undefined>;
  /** Clock for cycleAt timestamps. */
  now: () => Date;
  /**
   * OPTIONAL: Curried GC function. When present and input.gc is true, called
   * once per unique live VM in scope (after the deploy loop). Restricted to
   * branch-gone + orphan-vm reasons (NOT ttl — no default age-based cleanup).
   *
   * Signature: (vmId, opts) => Promise<GcSummary>
   *
   * OPTIONAL so that all existing test fixtures that build {resolveRef, deploy,
   * fetch, now} continue to compile and run unchanged. When absent, the GC pass
   * is silently skipped even if input.gc is true.
   */
  gc?: (vmId: string, opts: { reap: boolean }) => Promise<GcSummary>;
  /**
   * OPTIONAL: EnvStore used to enumerate live-VM ids for the GC pass scope.
   * When absent, GC scope is derived from candidate app vmIds (live VMs only).
   * OPTIONAL to preserve backward compatibility with existing test fixtures.
   */
  envStore?: EnvStore;
}

// ---------------------------------------------------------------------------
// runTriggerRun
// ---------------------------------------------------------------------------

/**
 * Perform ONE idempotent poll cycle.
 *
 * Algorithm (per SPEC-DELTA §7 + #52 CI-skip classification):
 *
 * 1. Enumerate all apps from appStore joined to vmStore:
 *    - Skip apps whose VM is missing or whose lifecycleState is not in
 *      {ready, adopted}.
 *    - Apply --vm / --app narrowing when provided.
 * 2. For each candidate: resolve the tracked-branch SHA via resolveRef.
 * 3. Ordered short-circuits (no CI call for these):
 *    - equal to deployedSha → action up-to-date; no CI call, no deploy.
 *    - equal to failedSha   → action known-bad; no CI call, no deploy (avoids
 *                              the pointless SSH/CI round-trip).
 *    - --dry-run            → action would-deploy; no CI call, no deploy
 *                              (offline-safe).
 * 4. Check CI via checkCiGreen(repo, sha, {fetch, env}):
 *    - "pending"  → action skipped, reason "ci-pending"; DO NOT call deploy.
 *    - "none"     → action skipped, reason "ci-none";    DO NOT call deploy.
 *    - "failure"  → action skipped, reason "ci-red";     DO NOT call deploy.
 *    - "success"  → proceed to call deps.deploy.
 * 5. Call deps.deploy. Non-zero exit → action failed (genuine deploy failure).
 * 6. Per-app isolation: catch any throw per-app; record action=error; continue.
 * 7. Exit 0 if all actions are {deployed, up-to-date, known-bad, skipped,
 *    would-deploy}; exit 1 if any action is {failed, error}.
 *
 * Bucket mapping for report counters:
 *   deployed            → report.deployed
 *   up-to-date          → report.skipped
 *   known-bad           → report.skipped
 *   skipped             → report.skipped  (includes all ci-* reasons)
 *   would-deploy        → report.skipped
 *   failed | error      → report.failed
 */
export async function runTriggerRun(
  input: TriggerRunInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  deps: TriggerDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const cycleAt = deps.now().toISOString();

  // ---- Build the candidate list -------------------------------------------
  // We collect all apps that match the --vm / --app filters (if provided).
  // VM lifecycle filtering is handled inline during iteration so non-live VMs
  // still appear in the report as action=skipped.
  const allVms = vmStore.list();
  const allApps = appStore.list();

  const LIVE_STATES = new Set(["ready", "adopted"]);

  const candidates = allApps.filter((app) => {
    // --app narrowing
    if (input.app !== undefined && app.name !== input.app) return false;

    // Find the owning VM
    const vmRecord = allVms.find((v) => v.id === app.vmId);
    if (vmRecord === undefined) return false;

    // --vm narrowing (by name or id)
    if (
      input.vm !== undefined &&
      vmRecord.name !== input.vm &&
      vmRecord.id !== input.vm
    ) return false;

    return true;
  });

  // ---- Process each candidate ---------------------------------------------
  const results: TriggerAppResult[] = [];

  for (const app of candidates) {
    const vmRecord = allVms.find((v) => v.id === app.vmId)!;
    const vmName = vmRecord.name;

    // Skip apps whose VM is not in {ready, adopted} — report as skipped.
    if (!LIVE_STATES.has(vmRecord.lifecycleState)) {
      results.push({
        app: app.name,
        vm: vmName,
        action: "skipped",
        reason: `vm lifecycleState=${vmRecord.lifecycleState}`,
      });
      continue;
    }

    try {
      // Resolve the current SHA for the tracked branch
      const resolvedSha = await deps.resolveRef(app.repo, app.branch);

      // up-to-date check
      if (app.deployedSha !== undefined && resolvedSha === app.deployedSha) {
        results.push({
          app: app.name,
          vm: vmName,
          action: "up-to-date",
          sha: resolvedSha,
        });
        continue;
      }

      // known-bad early skip (avoids pointless SSH/CI round-trip)
      if (app.failedSha !== undefined && resolvedSha === app.failedSha) {
        results.push({
          app: app.name,
          vm: vmName,
          action: "known-bad",
          sha: resolvedSha,
        });
        continue;
      }

      // --dry-run: report would-deploy without calling CI or runAppDeploy.
      // Dry-run must be offline-safe — no network calls.
      if (input.dryRun) {
        results.push({
          app: app.name,
          vm: vmName,
          action: "would-deploy",
          sha: resolvedSha,
        });
        continue;
      }

      // Check CI state. pending/none/failure are transient — classify as skipped
      // so the systemd timer cycle exits 0 (not a deploy failure). Only on
      // "success" do we proceed to call deploy.
      const ciStatus = await checkCiGreen(app.repo, resolvedSha, {
        fetch: deps.fetch,
        env: deps.env,
      });

      if (ciStatus === "pending") {
        results.push({
          app: app.name,
          vm: vmName,
          action: "skipped",
          sha: resolvedSha,
          reason: "ci-pending",
        });
        continue;
      }

      if (ciStatus === "none") {
        results.push({
          app: app.name,
          vm: vmName,
          action: "skipped",
          sha: resolvedSha,
          reason: "ci-none",
        });
        continue;
      }

      if (ciStatus === "failure") {
        results.push({
          app: app.name,
          vm: vmName,
          action: "skipped",
          sha: resolvedSha,
          reason: "ci-red",
        });
        continue;
      }

      // ciStatus === "success" — proceed to deploy.
      // Always pass the resolved SHA explicitly so runAppDeploy never resolves
      // twice. runAppDeploy still re-runs its own CI gate + known-bad + health
      // gates — it remains the deploy authority.
      const deployInput: AppDeployInput = {
        vm: vmName,
        app: app.name,
        sha: resolvedSha,
        skipCiGate: false,
      };

      const deployExit = await deps.deploy(
        deployInput,
        { json: false },
        vmStore,
        appStore,
        out,
        err,
      );

      if (deployExit === 0) {
        results.push({
          app: app.name,
          vm: vmName,
          action: "deployed",
          sha: resolvedSha,
        });
      } else {
        results.push({
          app: app.name,
          vm: vmName,
          action: "failed",
          sha: resolvedSha,
        });
      }
    } catch (e) {
      results.push({
        app: app.name,
        vm: vmName,
        action: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- GC pass (opt-in: only when input.gc is true and dep is wired) ------
  // Runs AFTER the deploy loop so the deploy pass always completes unaffected.
  // Restricted to branch-gone + orphan-vm reasons (no ttl in the trigger).
  // Under --dry-run the GC pass runs in dry-run too (reap:false, never reaps).
  // Deduplicated by vmId so each live VM is gc'd exactly once even with
  // multiple apps.
  let gcByVm: Record<string, GcSummary> | undefined;

  if (input.gc === true && deps.gc !== undefined) {
    // Collect unique live VM ids from the candidates we processed.
    const seenVmIds = new Set<string>();
    for (const app of candidates) {
      const vmRecord = allVms.find((v) => v.id === app.vmId);
      if (vmRecord === undefined) continue;
      if (!LIVE_STATES.has(vmRecord.lifecycleState)) continue;
      seenVmIds.add(vmRecord.id);
    }

    if (seenVmIds.size > 0) {
      gcByVm = {};
      // reap:true unless we are in a dry-run (trigger --dry-run propagates to gc)
      const reap = !input.dryRun;

      for (const vmId of seenVmIds) {
        try {
          const summary = await deps.gc(vmId, { reap });
          gcByVm[vmId] = summary;

          // Only print text output if something was reaped/pruned (quiet when nothing happened)
          if (!opts.json && (summary.reaped > 0 || summary.pruned > 0)) {
            out(
              `  gc ${vmId}: candidates=${summary.candidates} reaped=${summary.reaped} pruned=${summary.pruned}`,
            );
          }
        } catch (e) {
          // GC failure for one VM must not abort the cycle
          err(
            `samohost: warning: gc pass failed for VM ${vmId}: ` +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      }
    }
  }

  // ---- Build report -------------------------------------------------------
  let deployed = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of results) {
    switch (r.action) {
      case "deployed":
        deployed++;
        break;
      case "up-to-date":
      case "known-bad":
      case "skipped":
      case "would-deploy":
        skipped++;
        break;
      case "failed":
      case "error":
        failed++;
        break;
    }
  }

  const report: TriggerRunReport = {
    cycleAt,
    results,
    deployed,
    skipped,
    failed,
    ...(gcByVm !== undefined ? { gc: gcByVm } : {}),
  };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(
      `trigger run at ${cycleAt}: ` +
        `${results.length} candidate(s) — ` +
        `deployed=${deployed} skipped=${skipped} failed=${failed}`,
    );
    for (const r of results) {
      const shaStr = r.sha !== undefined ? ` sha=${r.sha.slice(0, 12)}` : "";
      const reasonStr = r.reason !== undefined ? ` (${r.reason})` : "";
      const errStr = r.error !== undefined ? ` error: ${r.error}` : "";
      out(`  ${r.vm}/${r.app}: ${r.action}${shaStr}${reasonStr}${errStr}`);
    }
  }

  // Exit code: 0 if no failures; 1 if any failed or errored
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Production dependency wiring
// ---------------------------------------------------------------------------

/**
 * Default production deps for `trigger run`:
 *   - resolveRef: from defaultAppDeployDeps() (same `gh api` resolver)
 *   - deploy: closure that binds defaultAppDeployDeps() once and calls
 *             runAppDeploy — AppDeployDeps are bound inside, NOT exposed.
 *   - fetch: globalThis.fetch (real network; token read from GH_TOKEN/GITHUB_TOKEN
 *            at call time inside checkCiGreen — never stored here)
 *   - env: undefined (checkCiGreen falls back to process.env)
 *   - now: () => new Date()
 *   - gc: closure that calls runEnvGc with defaultEnvExecDeps() + defaultEnvStore()
 *         bound; restricted to branch-gone + orphan-vm (no ttl); only INVOKED
 *         when input.gc is true — set but lazy.
 *   - envStore: defaultEnvStore()
 */
export function defaultTriggerDeps(): TriggerDeps {
  // Bind AppDeployDeps once for the lifetime of this trigger run.
  const appDeployDeps = defaultAppDeployDeps();
  const envStore = defaultEnvStore();

  return {
    // Reuse the same resolver the deploy path uses (no new resolver code).
    resolveRef: appDeployDeps.resolveRef,

    // Curried: AppDeployDeps already captured in closure.
    deploy: (input, opts, vmStore, appStore, out, err) =>
      runAppDeploy(input, opts, vmStore, appStore, appDeployDeps, out, err),

    // Real network fetch; checkCiGreen reads GH_TOKEN/GITHUB_TOKEN from
    // process.env at call time (env: undefined → default).
    fetch: globalThis.fetch,

    now: () => new Date(),

    // Curried GC function: EnvExecDeps + EnvStore already bound. Only invoked
    // when input.gc is true. Restricted to branch-gone + orphan-vm (no ttl arg
    // → ttl-based reaping disabled). AppStore and StateStore are passed in at
    // call time from the trigger's own stores.
    gc: async (vmId: string, opts: { reap: boolean }): Promise<GcSummary> => {
      const envExecDeps = defaultEnvExecDeps();
      // Null sink for gc text output: trigger accumulates summary counts only.
      const noop = (_s: string) => {};

      // We need vmStore and appStore — use new default stores for the gc call.
      // This mirrors the pattern in cli.ts (new StateStore() / defaultAppStore()).
      // Lazy import avoids a circular-at-load issue if this grows.
      const { StateStore: VmStateStore } = await import("../state/store.ts");
      const { AppStore: GcAppStore } = await import("../state/apps.ts");
      const gcVmStore = new VmStateStore();
      const gcAppStore = new GcAppStore();

      const gcInput: import("./env.ts").EnvGcInput = {
        vm: vmId,
        reap: opts.reap,
        // No ttl: trigger never does age-based reaping
      };

      // Run gc; capture counts from the JSON output (json:true suppresses text).
      let outStr = "";
      const captureOut = (s: string) => { outStr += s; };

      await runEnvGc(
        gcInput,
        { json: true },
        gcVmStore,
        gcAppStore,
        envStore,
        envExecDeps,
        captureOut,
        noop,
      );

      // Parse the GcReport JSON to extract summary counts.
      try {
        const report = JSON.parse(outStr) as import("./env.ts").GcReport;
        return {
          candidates: report.candidates.length,
          reaped: report.reaped.length,
          pruned: report.pruned.length,
        };
      } catch {
        return { candidates: 0, reaped: 0, pruned: 0 };
      }
    },

    envStore,
  };
}
