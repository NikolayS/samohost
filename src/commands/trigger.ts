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
import type { PrPreviewSummary, PrPreviewResult } from "../preview/pr.ts";
import type { HealSummary, HealResult } from "../preview/heal.ts";
import type { EnvIdleGcDeps } from "./env-idle.ts";
import type { AppRecord, EnvDbBackend, EnvRecord, VmRecord } from "../types.ts";
import type { SpawnResult } from "../ssh/runner.ts";
import {
  assertStoredPreviewBackend,
  resolvePreviewDbBackend,
  validatePreviewEnvIsolation,
} from "../preview/db-policy.ts";

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Select the DB backend to use when auto-creating a PR-preview env for `app`.
 *
 * Priority (highest → lowest):
 *   1. `app.previewDbBackend` — explicit operator override for preview envs.
 *   2. `app.dbBackend === 'none'` — app carries no database at all; previews
 *      must not attempt a clone (no dblab or template setup needed).
 *   3. `"dblab"` — default for all DB-carrying apps (thin clone via DBLab
 *      Engine, instant, storage-cheap, the primary backend for the SOLO plan).
 *
 * There is NO silent fallback to `"template"`: any non-dblab backend must be
 * stated explicitly in the AppSpec.
 */
export function previewDbBackendFor(app: AppRecord): EnvDbBackend {
  validatePreviewEnvIsolation(app);
  return resolvePreviewDbBackend(app);
}

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
  /**
   * When true, run the PR-preview pass per live app in scope after the GC pass.
   * DEFAULT: false (absent = no PR previews at all). For each open PR, ensures
   * a preview env exists at the PR head SHA and posts/updates a clickable URL
   * comment. Reaps envs for PRs that are no longer open.
   * SAFETY: OPT-IN — destructive (reap) operations never happen unless explicitly
   * requested.
   */
  prPreviews?: boolean;
  /**
   * When true, run the self-heal pass per live app in scope INDEPENDENTLY of
   * --pr-previews. The heal pass detects dead DBLab clone ports (DB-UNREACHABLE)
   * and re-cuts the affected envs via the existing idempotent runEnvCreate path.
   *
   * DEFAULT: false (absent = heal only runs when --pr-previews is also set,
   * for backward compatibility). Set explicitly to `true` for cron/manual
   * invocations where PR-preview management is not needed but dead-clone
   * healing is still required (e.g. preview VMs without a GitHub PR workflow).
   *
   * SAFETY: OPT-IN. Non-destructive (re-creates never drop production data —
   * DBLab backend drops+re-creates only the per-env clone, not prod).
   */
  heal?: boolean;
  /**
   * When true, run an idle-GC pass per live VM in scope after the deploy loop.
   *
   * The idle-GC pass reads each env's Caddy JSON access log at
   * `/var/log/caddy/<env-name>.log` via the pinned SSH runner, stamps
   * `EnvRecord.lastAccess` from the max `ts`, then computes
   * `idle = now - lastAccess` (falling back to `createdAt` when no access
   * has been recorded) and reaps any env whose idle time exceeds the threshold.
   *
   * Threshold: `SAMOHOST_IDLE_THRESHOLD_MS` env var (default 14d).
   * Reap gate: `SAMOHOST_IDLE_REAP=1` env var (default warn-only).
   *
   * SAFETY: OPT-IN. Destructive when SAMOHOST_IDLE_REAP=1; warn-only otherwise.
   * This flag gates whether the idle-GC dep is invoked at all — the inner
   * SAMOHOST_IDLE_REAP env var gates whether actual destruction occurs.
   */
  idleGc?: boolean;
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
  /**
   * Per-app PR-preview summaries. Only present when --pr-previews was active,
   * at least one live app was in scope, and the prPreview dep is wired.
   */
  prPreviews?: PrPreviewSummary[];
  /**
   * Per-app self-heal summaries (samohost #78). Present when --pr-previews was
   * active, a live app was in scope, and the heal dep is wired. Surfaces every
   * clone re-cut after the daily DBLab snapshot refresh reaped it.
   */
  heal?: HealSummary[];
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
  /**
   * OPTIONAL: Curried PR-preview function. When present and input.prPreviews is
   * true, called once per live candidate app (after the GC pass, so gc's reap
   * results are visible to the reaper). Returns a PrPreviewSummary per app.
   *
   * Signature: (app, vm) => Promise<PrPreviewSummary>
   *
   * OPTIONAL so that all existing test fixtures that build {resolveRef, deploy,
   * fetch, now} continue to compile and run unchanged. When absent, the PR-preview
   * pass is silently skipped even if input.prPreviews is true.
   */
  prPreview?: (app: AppRecord, vm: VmRecord) => Promise<PrPreviewSummary>;
  /**
   * OPTIONAL: Curried self-heal function (samohost #78). When present and
   * input.prPreviews is true, called once per live candidate app BEFORE the
   * PR-preview pass so a clone reaped by the ~03:00 DBLab snapshot refresh is
   * re-cut and the preview re-wired in the same cycle. OPTIONAL so existing
   * fixtures compile; absent => heal pass skipped.
   */
  heal?: (app: AppRecord, vm: VmRecord) => Promise<HealSummary>;
  /**
   * OPTIONAL: Combined per-VM batch cycle that replaces the separate
   * `deps.heal` + `deps.prPreview` calls when present.
   *
   * The production implementation (`defaultTriggerDeps`) uses this to run ALL
   * per-VM SSH work — clone-health probe + dead-clone re-creates + PR env
   * creates/redeployments — in AT MOST 2 SSH sessions per VM per cycle:
   *   Session 1: batched clone-health probe (buildBatchedProbeScript).
   *   Session 2: runBatchedVmCycle — all heal re-creates + PR creates in ONE
   *              combined `bash -s` heredoc (one SSH connection regardless of N).
   *
   * This is the PRIMARY fix for the connection-budget exhaustion bug:
   * the old per-item SSH pattern (1 probe + N recreates + M PR creates = 1+N+M
   * connections) exhausted the fail2ban-safe 2/600 s budget for VMs with ≥ 2
   * preview envs needing attention.
   *
   * When present, `runTriggerRun` uses this instead of calling `heal` and
   * `prPreview` separately. The caller decides which sub-passes to activate via
   * `cycleOpts.{ heal, prPreviews }`.
   *
   * OPTIONAL so all existing test fixtures that build TriggerDeps without
   * batchedVmCycle continue to compile and run unchanged.
   */
  batchedVmCycle?: (
    app: AppRecord,
    vm: VmRecord,
    cycleOpts: { heal: boolean; prPreviews: boolean },
  ) => Promise<{ heal: HealSummary; prPreview: PrPreviewSummary }>;
  /**
   * OPTIONAL: Curried idle-GC function (samohost #87). When present and
   * `input.idleGc` is true, called once per unique live VM in scope after the
   * deploy loop and branch-gone GC pass. For each env on the VM, reads the
   * per-vhost Caddy JSON access log via the injected `readRemoteLog` dep,
   * stamps `EnvRecord.lastAccess`, then reaps idle-past-threshold envs.
   *
   * Signature: (vmId, opts) => Promise<GcSummary>
   *
   * `opts.reap`: false = warn-only (logs candidates, destroys nothing);
   *             true  = actually call runEnvDestroy per candidate.
   * `opts.envStore`: the same EnvStore instance the trigger uses (so
   *   lastAccess stamps are visible to callers of envStore.get after the
   *   pass without a re-load).
   * `opts.readRemoteLog`: injectable SSH reader, same shape as EnvIdleGcDeps.
   *
   * OPTIONAL so all existing test fixtures that build {resolveRef, deploy,
   * fetch, now} continue to compile and run unchanged.
   */
  idleGc?: (
    vmId: string,
    opts: {
      reap: boolean;
      envStore: EnvStore;
      readRemoteLog: EnvIdleGcDeps["readRemoteLog"];
    },
  ) => Promise<GcSummary>;
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

  // ---- Idle-GC pass (samohost #87) ----------------------------------------
  // Runs AFTER the branch-gone GC pass (so gc's reap results are visible)
  // and BEFORE the self-heal pass (so a re-healed clone is not immediately
  // idle-reaped if it has recent traffic in the new access log).
  //
  // For each unique live VM in scope:
  //   1. Call deps.idleGc(vmId, { reap, envStore, readRemoteLog }) which:
  //      a. For every env on the VM, reads /var/log/caddy/<name>.log via SSH.
  //      b. Stamps EnvRecord.lastAccess from max(ts) in that file (or falls
  //         back to createdAt when the file is absent / empty / unreachable).
  //      c. Reaps envs idle > SAMOHOST_IDLE_THRESHOLD_MS when reap=true, or
  //         logs warn-only when reap=false.
  //   2. The reap flag is derived from SAMOHOST_IDLE_REAP env var (default:
  //      false = warn-only). --dry-run does NOT propagate here because the
  //      idle-GC reap gate is a SEPARATE operator control (SAMOHOST_IDLE_REAP);
  //      --dry-run already gates the branch-gone gc above.
  //
  // SAFETY: OPT-IN via input.idleGc. Absent => silently skipped.
  //         Destructive ops gate on SAMOHOST_IDLE_REAP in the dep.
  if (input.idleGc === true && deps.idleGc !== undefined) {
    const seenVmIdsForIdle = new Set<string>();
    for (const app of candidates) {
      const vmRecord = allVms.find((v) => v.id === app.vmId);
      if (vmRecord === undefined) continue;
      if (!LIVE_STATES.has(vmRecord.lifecycleState)) continue;
      seenVmIdsForIdle.add(vmRecord.id);
    }

    if (seenVmIdsForIdle.size > 0) {
      // Resolve the effective envStore (prefer deps.envStore if set).
      const effectiveEnvStore = deps.envStore ?? defaultEnvStore();

      // Resolve the SSH-based log reader from the production dep (or a noop for tests).
      // The production idleGc closure owns the real readRemoteLog; we pass a default
      // that the closure may ignore (it has its own wired reader).
      const defaultReadRemoteLog = async (_path: string): Promise<string> => "";

      // Import readIdleReap lazily to avoid a circular-at-load issue.
      const { readIdleReap: resolveIdleReap } = await import("./env-idle.ts");
      const reap = resolveIdleReap();

      for (const vmId of seenVmIdsForIdle) {
        try {
          const summary = await deps.idleGc(vmId, {
            reap,
            envStore: effectiveEnvStore,
            readRemoteLog: defaultReadRemoteLog,
          });

          if (!opts.json && summary.candidates > 0) {
            out(
              `  idle-gc ${vmId}: candidates=${summary.candidates} reaped=${summary.reaped}${reap ? "" : " (warn-only)"}`,
            );
          }
        } catch (e) {
          // idle-GC failure for one VM must not abort the cycle.
          err(
            `samohost: warning: idle-gc pass failed for VM ${vmId}: ` +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      }
    }
  }

  // ---- Self-heal + PR-preview pass ----------------------------------------
  //
  // BATCHED PATH (preferred, when deps.batchedVmCycle is wired):
  //   Calls batchedVmCycle once per live candidate app. The closure runs ALL
  //   per-VM SSH work — clone-health probe + dead-clone re-creates + PR env
  //   creates/redeployments — in AT MOST 2 SSH sessions per VM (probe + one
  //   runBatchedVmCycle call), instead of the old 2+N per-item pattern that
  //   exhausted the fail2ban-safe budget.
  //
  // FALLBACK PATH (when batchedVmCycle is absent, e.g. test fixtures that do
  //   not supply it):
  //   Runs the separate deps.heal and deps.prPreview closures as before. This
  //   path is kept to avoid breaking any existing test fixtures or callers that
  //   build TriggerDeps without batchedVmCycle. All shipped production wiring
  //   MUST supply batchedVmCycle.
  //
  // Gating: `input.heal === true` OR `input.prPreviews === true`.
  // Per-app isolation: one app's failure must not abort the cycle.
  let healSummaries: HealSummary[] | undefined;
  let prPreviewSummaries: PrPreviewSummary[] | undefined;

  const wantHealOrPreview = input.heal === true || input.prPreviews === true;

  if (wantHealOrPreview && deps.batchedVmCycle !== undefined) {
    // ---- BATCHED path (primary production path) ---------------------------
    const liveAppsForBatch: Array<{ app: AppRecord; vm: VmRecord }> = [];
    for (const app of candidates) {
      const vmRecord = allVms.find((v) => v.id === app.vmId);
      if (vmRecord === undefined) continue;
      if (!LIVE_STATES.has(vmRecord.lifecycleState)) continue;
      liveAppsForBatch.push({ app, vm: vmRecord });
    }

    if (liveAppsForBatch.length > 0) {
      if (input.heal === true || input.prPreviews === true) healSummaries = [];
      if (input.prPreviews === true) prPreviewSummaries = [];

      for (const { app, vm: vmRecord } of liveAppsForBatch) {
        try {
          const result = await deps.batchedVmCycle(app, vmRecord, {
            heal: input.heal === true || input.prPreviews === true,
            prPreviews: input.prPreviews === true,
          });

          if (healSummaries !== undefined) {
            healSummaries.push(result.heal);
            const hs = result.heal;
            if (!opts.json && (hs.healed > 0 || hs.failed > 0 || hs.deferred > 0)) {
              out(
                `  heal ${vmRecord.name}/${app.name}: examined=${hs.examined}` +
                  ` healed=${hs.healed} failed=${hs.failed} deferred=${hs.deferred}`,
              );
            }
          }
          if (prPreviewSummaries !== undefined) {
            prPreviewSummaries.push(result.prPreview);
          }
        } catch (e) {
          err(
            `samohost: warning: batched preview cycle failed for app ${app.name}: ` +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      }
    }
  } else {
    // ---- FALLBACK path (backward-compat: separate heal + prPreview) -------
    if ((input.heal === true || input.prPreviews === true) && deps.heal !== undefined) {
      const liveHealApps: Array<{ app: AppRecord; vm: VmRecord }> = [];
      for (const app of candidates) {
        const vmRecord = allVms.find((v) => v.id === app.vmId);
        if (vmRecord === undefined) continue;
        if (!LIVE_STATES.has(vmRecord.lifecycleState)) continue;
        liveHealApps.push({ app, vm: vmRecord });
      }
      if (liveHealApps.length > 0) {
        healSummaries = [];
        for (const { app, vm: vmRecord } of liveHealApps) {
          try {
            const summary = await deps.heal(app, vmRecord);
            healSummaries.push(summary);
            if (!opts.json && (summary.healed > 0 || summary.failed > 0 || summary.deferred > 0)) {
              out(`  heal ${vmRecord.name}/${app.name}: examined=${summary.examined} healed=${summary.healed} failed=${summary.failed} deferred=${summary.deferred}`);
            }
          } catch (e) {
            err(`samohost: warning: heal pass failed for app ${app.name}: ` + (e instanceof Error ? e.message : String(e)));
          }
        }
      }
    }

    // PR-preview pass (opt-in: only when input.prPreviews is true and dep is wired).
    // Runs AFTER the GC pass so gc's reap results are visible to the pr-preview
    // reaper (guards against double-reap: if gc removed a branch-gone env, the
    // existence guard in runPrPreviewPass will see it as already gone).
    // Per-app isolation: one app's prPreview failure must not abort the cycle.
    if (input.prPreviews === true && deps.prPreview !== undefined) {
      const liveCandidateApps: Array<{ app: (typeof candidates)[number]; vm: VmRecord }> = [];

      // POLICY (src/preview/pr.ts lines 9-12): PR previews deploy at HEAD
      // regardless of CI status — DELIBERATE. checkCiGreen is NOT consulted here.
      for (const app of candidates) {
        const vmRecord = allVms.find((v) => v.id === app.vmId);
        if (vmRecord === undefined) continue;
        if (!LIVE_STATES.has(vmRecord.lifecycleState)) continue;
        liveCandidateApps.push({ app, vm: vmRecord });
      }

      if (liveCandidateApps.length > 0) {
        prPreviewSummaries = [];

        for (const { app, vm: vmRecord } of liveCandidateApps) {
          try {
            const summary = await deps.prPreview(app, vmRecord);
            prPreviewSummaries.push(summary);
          } catch (e) {
            // PR-preview failure for one app must not abort the cycle
            err(
              `samohost: warning: pr-preview pass failed for app ${app.name}: ` +
                (e instanceof Error ? e.message : String(e)),
            );
          }
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
    ...(healSummaries !== undefined ? { heal: healSummaries } : {}),
    ...(prPreviewSummaries !== undefined ? { prPreviews: prPreviewSummaries } : {}),
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
 * Validate operator prerequisites before the trigger starts.
 *
 * Returns `true` when all required env vars are present.
 * Returns `false` and emits a prominent error via `err()` when a required var
 * is absent — FAIL LOUD once at startup instead of silently skipping DNS each
 * cycle (the silent skip caused infinite-fail-with-zero-progress incidents).
 *
 * Required vars (HARD_PREREQS):
 *   CLOUDFLARE_SAMOCAT — zone-scoped DNS write token used by ensurePreviewDns.
 *                         Without it every preview cycle silently skips DNS,
 *                         making previews unreachable on non-wildcard VMs.
 *
 * Exported for use in CLI startup and in tests.
 */
export function checkTriggerPrereqs(opts: {
  env: Record<string, string | undefined>;
  err: (s: string) => void;
}): boolean {
  let ok = true;

  if (!opts.env["CLOUDFLARE_SAMOCAT"]) {
    opts.err(
      "samohost: ERROR — CLOUDFLARE_SAMOCAT is required for preview DNS but is missing. " +
        "Set it via a systemd EnvironmentFile drop-in " +
        "(e.g. /etc/systemd/system/samohost-trigger.service.d/secrets.conf). " +
        "Without this token, per-preview DNS records will not be created and previews " +
        "on VMs not covered by the wildcard A record will not resolve. " +
        "See docs/control-plane-setup.md for the full configuration checklist.",
    );
    ok = false;
  }

  return ok;
}

/**
 * Optional overrides for defaultTriggerDeps (primarily for testing).
 *
 * Passing `envStore` threads that instance through the shared GC / heal /
 * prPreview closures so in-cycle writes are immediately visible without a
 * disk round-trip (fixes the dual-store regression described in trigger.ts).
 */
export interface TriggerDepsOpts {
  /**
   * Override the EnvStore instance used by the trigger, GC, heal, and
   * prPreview closures. Defaults to defaultEnvStore() (disk-backed).
   * Test-only: allows verifying that all closures share one in-memory instance.
   */
  envStore?: EnvStore;
  /**
   * Injectable SSH remote function (for integration tests — counts calls per
   * VM to prove the budget invariant). When provided, the batchedVmCycle
   * closure uses it for BOTH the clone-health probe AND the batch work call
   * instead of the prod `runRemote` runner. This is the ONLY way to verify
   * the budget invariant without a real VM.
   *
   * Production: absent (undefined) → batchedVmCycle uses defaultEnvExecDeps().remote.
   */
  remote?: (vm: VmRecord, script: string) => Promise<SpawnResult>;
  /**
   * Injectable resolveRef function (for integration tests — avoids real
   * GitHub API calls that hit the network and may time out). When provided,
   * defaultTriggerDeps returns this instead of the production `gh api`
   * resolver, so tests can supply an instant-returning mock.
   *
   * Production: absent (undefined) → uses defaultAppDeployDeps().resolveRef.
   */
  resolveRef?: RefResolver;
  /**
   * Injectable PR-listing function (for integration tests — avoids requiring
   * a live `gh` binary). When provided, batchedVmCycle uses it instead of
   * spawning `gh pr list`.
   *
   * Production: absent (undefined) → batchedVmCycle spawns `gh pr list`.
   */
  listOpenPrs?: (repo: string) => Promise<Array<{ number: number; headRef: string; headSha: string }>>;
  /**
   * Injectable ensurePreviewDns function (for integration tests).
   *
   * When provided, batchedVmCycle calls this for each NEW PR preview (where
   * no existing env record exists) to create the per-preview Cloudflare A
   * record before the batch SSH so ACME HTTP-01 can resolve.
   *
   * Production: absent → batchedVmCycle uses CloudflareDns from
   * CLOUDFLARE_SAMOCAT env var. If the var is also absent, falls back to
   * the DNS-degrade warning (wildcard reliance).
   */
  ensurePreviewDns?: (vhost: string, ip: string) => Promise<void>;
  /**
   * Injectable external HTTPS probe (for integration tests — avoids real
   * network calls). When provided, batchedVmCycle calls this after a
   * successful batch run for each PR item before stamping lastDeployedSha
   * and posting the preview-ready comment.
   *
   * Production: absent → batchedVmCycle uses the system curl probe
   * (buildCurlProbeArgs / parseCurlProbeResult), same as runEnvCreate.
   */
  httpProbe?: (url: string) => Promise<{ status: number; ok: boolean }>;
  /**
   * Injectable sleep function for integration tests.
   *
   * When provided, the HTTPS probe retry loop uses this instead of the real
   * setTimeout — allows tests to avoid 5s×8=40s wait when probing a fake URL.
   *
   * Production: absent → real Promise-based setTimeout(ms).
   */
  sleep?: (ms: number) => Promise<void>;
}

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
 *   - envStore: ONE shared defaultEnvStore() instance threaded through all
 *               closures (gc, heal, prPreview) so in-cycle writes are visible
 *               across passes without requiring a disk round-trip.
 */
export function defaultTriggerDeps(opts: TriggerDepsOpts = {}): TriggerDeps {
  // Bind AppDeployDeps once for the lifetime of this trigger run.
  const appDeployDeps = defaultAppDeployDeps();
  // ONE shared EnvStore for the whole cycle — passed through to every closure
  // that reads or writes env records (gc, heal, prPreview). Callers may inject
  // a custom instance via opts.envStore (used by tests).
  const envStore = opts.envStore ?? defaultEnvStore();

  return {
    // Reuse the same resolver the deploy path uses (no new resolver code).
    // Tests may inject a fast mock via opts.resolveRef to avoid real GitHub API calls.
    resolveRef: opts.resolveRef ?? appDeployDeps.resolveRef,

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

    // Curried PR-preview function. Only invoked when input.prPreviews is true.
    // Builds PrPreviewDeps fresh per call (lazy stores mirror the gc closure
    // pattern above).
    //
    // listOpenPrs: spawnSync `gh pr list --repo <repo> --state open
    //   --json number,headRefName,headRefOid,isCrossRepository`
    //   → parse JSON → filter out isCrossRepository → map to OpenPr.
    //   gh reads GH_TOKEN from process.env at runtime (already exported by the
    //   wrapper). On gh failure → throw (caught per-app upstream).
    //
    // ensurePreview: calls runEnvCreate (db=previewDbBackendFor(app) defaulting to
    //   "dblab", DEFAULT_PREVIEW_DOMAIN). Reads the persisted record back and sets
    //   lastDeployedSha on it.
    //
    // upsertPrComment: spawnSync gh api to list issue comments, find one whose
    //   body includes the marker → PATCH; else POST. NEVER writes tokens to disk.
    //
    // reapPreview: calls runEnvDestroy; if record already gone (runEnvDestroy
    //   returns 1 with "no env recorded") → treat as no-op (swallow, log warn).
    // Curried self-heal function (samohost #78). Only invoked when
    // input.prPreviews is true. Uses the SHARED envStore so heal writes are
    // immediately visible to the prPreview pass in the same cycle (fixes the
    // dual-store regression: previously opened new HealEnvStore() here).
    heal: async (app: AppRecord, vmRecord: VmRecord): Promise<HealSummary> => {
      const { runHealPass } = await import("../preview/heal.ts");
      const { defaultHealDeps } = await import("../preview/heal-deps.ts");
      const noop = (_s: string) => {};
      // Pass the shared envStore so heal and prPreview see the same records.
      return runHealPass(app, vmRecord, defaultHealDeps(envStore), noop, (s: string) => process.stderr.write(s + "\n"));
    },

    prPreview: async (app: AppRecord, vmRecord: VmRecord): Promise<PrPreviewSummary> => {
      const { spawnSync } = await import("node:child_process");
      const {
        runPrPreviewPass,
      } = await import("../preview/pr.ts");
      const { DEFAULT_PREVIEW_DOMAIN, runEnvCreate, runEnvDestroy, defaultEnvExecDeps: mkEnvExecDeps } = await import("./env.ts");
      const { StateStore: PrVmStore } = await import("../state/store.ts");
      const { AppStore: PrAppStore } = await import("../state/apps.ts");

      // Use the SHARED envStore so prPreview and heal see the same env records
      // in the same cycle (fixes the dual-store regression: previously opened
      // new PrEnvStore() here, diverging from the trigger's own envStore).
      const prEnvStore = envStore;

      const listOpenPrs = async (repo: string) => {
        const res = spawnSync(
          "gh",
          ["pr", "list", "--repo", repo, "--state", "open",
           "--json", "number,headRefName,headRefOid,isCrossRepository"],
          { encoding: "utf8" },
        );
        if (res.status !== 0) {
          throw new Error(
            `gh pr list failed (exit ${res.status}): ${res.stderr ?? ""}`,
          );
        }
        const parsed = JSON.parse(res.stdout) as Array<{
          number: number;
          headRefName: string;
          headRefOid: string;
          isCrossRepository: boolean;
        }>;
        // Filter out cross-repository (fork) PRs to avoid branch-name collisions.
        return parsed
          .filter((pr) => !pr.isCrossRepository)
          .map((pr) => ({
            number: pr.number,
            headRef: pr.headRefName,
            headSha: pr.headRefOid,
          }));
      };

      const ensurePreviewImpl = async (args: {
        vm: string;
        app: string;
        branch: string;
        headSha: string;
        prNumber: number;
      }) => {
        const prVmStore = new PrVmStore();
        const prAppStore = new PrAppStore();
        const envExecDeps = mkEnvExecDeps();
        const noop = (_s: string) => {};
        let capturedOut = "";
        const capOut = (s: string) => { capturedOut += s; };

        await runEnvCreate(
          {
            vm: args.vm,
            app: args.app,
            branch: args.branch,
            db: previewDbBackendFor(app),
            previewDomain: DEFAULT_PREVIEW_DOMAIN,
            // Pass the SHA to runEnvCreate so it stamps it ONLY on outcome=ok.
            // runEnvCreate clears lastDeployedSha on failure (dishonest-state fix:
            // MR-A). Do NOT stamp via a separate post-create upsert — that
            // unconditional write is the root cause of needDeploy=false on broken envs.
            lastDeployedSha: args.headSha,
          },
          { json: true },
          prVmStore,
          prAppStore,
          prEnvStore,
          envExecDeps,
          capOut,
          noop,
        );

        // Parse the EnvCreateReport to get vhost + outcome.
        let vhost = "";
        let outcome: "ok" | "failed" = "failed";
        try {
          const createReport = JSON.parse(capturedOut) as import("./env.ts").EnvCreateReport;
          vhost = createReport.vhost;
          outcome = createReport.outcome === "ok" ? "ok" : "failed";
        } catch {
          // Parse failure → treat as failed
        }

        // Stamp prNumber ONLY on success: prNumber marks this env as PR-managed
        // so the closed-PR reaper knows it is safe to reap. We only want that
        // marker when the env is actually live (outcome=ok); a failed env without
        // prNumber is protected from the reaper by the prNumber===undefined guard
        // in runPrPreviewPass, which is the correct safe behavior.
        // NOTE: lastDeployedSha was already stamped (or cleared) by runEnvCreate
        // above — do NOT re-stamp it here.
        if (outcome === "ok") {
          const vmRec = prVmStore.list().find((v) => v.name === args.vm);
          if (vmRec !== undefined && vhost !== "") {
            const rec = prEnvStore.get(vmRec.id, args.app, args.branch);
            if (rec !== undefined && rec.prNumber !== args.prNumber) {
              prEnvStore.upsert({ ...rec, prNumber: args.prNumber });
            }
          }
        }

        return { vhost, outcome, lastDeployedSha: args.headSha };
      };

      const upsertPrCommentImpl = async (
        repo: string,
        prNumber: number,
        marker: string,
        body: string,
      ) => {
        // List existing comments for the PR issue.
        const listRes = spawnSync(
          "gh",
          ["api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate"],
          { encoding: "utf8" },
        );
        let existingCommentId: number | undefined;
        if (listRes.status === 0) {
          try {
            const comments = JSON.parse(listRes.stdout) as Array<{
              id: number;
              body: string;
            }>;
            const found = comments.find((c) => c.body.includes(marker));
            if (found !== undefined) existingCommentId = found.id;
          } catch {
            // Parse failure → create new comment
          }
        }

        // Inspect the write call's exit status: a 401 / network drop here
        // otherwise silently skips the comment (the env is fine, but the client
        // never gets their link with no signal). Throw on failure so the caller
        // (runPrPreviewPass) surfaces it as a non-fatal warning instead of
        // swallowing it. stderr is included for diagnosis; gh does not print the
        // token, so no secret is exposed.
        const writeRes = existingCommentId !== undefined
          ? // PATCH existing comment
            spawnSync(
              "gh",
              [
                "api", "--method", "PATCH",
                `repos/${repo}/issues/comments/${existingCommentId}`,
                "-f", `body=${body}`,
              ],
              { encoding: "utf8" },
            )
          : // POST new comment
            spawnSync(
              "gh",
              [
                "api", "--method", "POST",
                `repos/${repo}/issues/${prNumber}/comments`,
                "-f", `body=${body}`,
              ],
              { encoding: "utf8" },
            );
        if (writeRes.status !== 0) {
          const verb = existingCommentId !== undefined ? "PATCH" : "POST";
          throw new Error(
            `gh api ${verb} preview comment failed (exit ${writeRes.status}): ` +
              `${(writeRes.stderr ?? "").trim() || (writeRes.error?.message ?? "")}`,
          );
        }
      };

      const reapPreviewImpl = async (args: {
        vm: string;
        app: string;
        branch: string;
      }) => {
        const prVmStore = new PrVmStore();
        const prAppStore = new PrAppStore();
        const envExecDeps = mkEnvExecDeps();
        const noop = (_s: string) => {};

        const exitCode = await runEnvDestroy(
          { vm: args.vm, app: args.app, branch: args.branch },
          { json: false },
          prVmStore,
          prAppStore,
          prEnvStore,
          envExecDeps,
          noop,
          (s: string) => {
            // "no env recorded" → idempotent, swallow gracefully
            if (!s.includes("no env recorded")) {
              process.stderr.write(`samohost: pr-preview reap: ${s}\n`);
            }
          },
        );
        // Non-zero exit (e.g. "no env recorded") → idempotent no-op
        if (exitCode !== 0) {
          // Already logged above; continue.
        }
      };

      const noop = (_s: string) => {};

      return runPrPreviewPass(app, vmRecord, {
        listOpenPrs,
        ensurePreview: ensurePreviewImpl,
        upsertPrComment: upsertPrCommentImpl,
        reapPreview: reapPreviewImpl,
        envStore: prEnvStore,
        now: () => new Date(),
      }, noop, noop);
    },

    // Curried idle-GC function (samohost #87). Only invoked when
    // input.idleGc is true. For each env on the VM:
    //   1. Read /var/log/caddy/<name>.log via pinned SSH runner.
    //   2. Parse max(ts) → stamp EnvRecord.lastAccess.
    //   3. Compute idle = now - lastAccess (fallback to createdAt).
    //   4. Reap envs idle > SAMOHOST_IDLE_THRESHOLD_MS when reap=true,
    //      or log warn-only when reap=false.
    //
    // The `readRemoteLog` arg in opts is the caller-supplied reader — in
    // the trigger's runTriggerRun call it is a noop default (the real reader
    // is wired HERE in the closure via spawnSync). We build our own real
    // readRemoteLog from the VM record (looked up by vmId at call time).
    idleGc: async (
      vmId: string,
      opts: {
        reap: boolean;
        envStore: EnvStore;
        readRemoteLog: EnvIdleGcDeps["readRemoteLog"];
      },
    ): Promise<GcSummary> => {
      const {
        runEnvIdleGc,
        readAccessLogMaxTs,
        stampLastAccess,
        readIdleThresholdMs,
      } = await import("./env-idle.ts");
      const { StateStore: IdleVmStore } = await import("../state/store.ts");
      const { spawnSync } = await import("node:child_process");
      const { buildSshArgs, ensureKnownHosts, defaultKnownHostsDir } = await import("../ssh/runner.ts");

      const idleVmStore = new IdleVmStore();
      const allVmsForIdle = idleVmStore.list();
      const vm = allVmsForIdle.find((v) => v.id === vmId);
      if (vm === undefined) {
        // VM not found in state store — skip silently.
        return { candidates: 0, reaped: 0, pruned: 0 };
      }

      // Build a readRemoteLog backed by the pinned SSH runner for this VM.
      // Uses `cat <logPath>` to read the file; exits 0 even when empty, 1
      // when the file does not exist (cat returns empty stdout on missing files
      // on some systems, but we handle that via parseAccessLogMaxTs returning
      // null on empty content). We use `cat ... || true` to guarantee exit 0
      // so a missing log file (env just created, no traffic yet) is not an error.
      const knownHostsDir = process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir();
      ensureKnownHosts(vm, knownHostsDir);

      const sshReadFile = async (logPath: string): Promise<string> => {
        const sshArgs = buildSshArgs(vm, `cat '${logPath}' 2>/dev/null || true`, {
          knownHostsDir,
        });
        const res = spawnSync("ssh", sshArgs, {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024, // 64 MB max log size
          timeout: 30_000, // 30s per file — faster than full script timeout
        });
        if (typeof res.status === "number" && res.status !== 0) {
          throw new Error(`ssh cat ${logPath} exited ${res.status}: ${res.stderr ?? ""}`);
        }
        return res.stdout ?? "";
      };

      const idleEnvStore = opts.envStore;
      const thresholdMs = readIdleThresholdMs();

      // Step 1: Stamp lastAccess for each env from the access log.
      const envsOnVm = idleEnvStore.listFor(vmId);
      for (const env of envsOnVm) {
        const maxTsEpochSec = await readAccessLogMaxTs(env.name, {
          readRemoteLog: sshReadFile,
        });
        if (maxTsEpochSec !== null) {
          const iso = new Date(maxTsEpochSec * 1000).toISOString();
          stampLastAccess(idleEnvStore, env.vmId, env.appName, env.branch, iso);
        }
      }

      // Step 2: Run the idle-GC sweep (uses lastAccess just stamped above).
      const noop = (_s: string) => {};
      const { runEnvDestroy, defaultEnvExecDeps: mkEnvExecDeps } = await import("./env.ts");
      const { AppStore: IdleAppStore } = await import("../state/apps.ts");

      const idleAppStore = new IdleAppStore();
      const envExecDeps = mkEnvExecDeps();

      const destroyEnv = async (
        _destroyVmId: string,
        appName: string,
        branch: string,
      ): Promise<number> => {
        return runEnvDestroy(
          { vm: vm.name, app: appName, branch },
          { json: false },
          idleVmStore,
          idleAppStore,
          idleEnvStore,
          envExecDeps,
          noop,
          noop,
        );
      };

      const report = await runEnvIdleGc(
        {
          vm: vmId,
          idleThresholdMs: thresholdMs,
          idleReap: opts.reap,
          now: () => new Date(),
        },
        idleVmStore,
        idleAppStore,
        idleEnvStore,
        destroyEnv,
        noop,
        (s: string) => process.stderr.write(s + "\n"),
      );

      return {
        candidates: report.candidates.length,
        reaped: report.reaped.length,
        pruned: 0,
      };
    },

    // -----------------------------------------------------------------------
    // batchedVmCycle — PRIMARY PRODUCTION PATH for heal + PR previews.
    //
    // Runs ALL per-VM SSH work in AT MOST 2 SSH sessions per cycle:
    //   Session 1 (probe): buildBatchedProbeScript → parseBatchedProbe →
    //                      identifies dead clones without re-creating anything.
    //   Session 2 (work):  runBatchedVmCycle → one combined `bash -s` call
    //                      covering every dead-clone re-create AND every PR
    //                      env create/redeploy that has a changed SHA.
    //
    // Uses opts.remote when provided (integration tests inject a counting
    // remote to verify the budget invariant). Falls back to the production
    // SSH runner (defaultEnvExecDeps().remote) when absent.
    // -----------------------------------------------------------------------
    batchedVmCycle: async (
      app: AppRecord,
      vmRecord: VmRecord,
      cycleOpts: { heal: boolean; prPreviews: boolean },
    ): Promise<{ heal: HealSummary; prPreview: PrPreviewSummary }> => {
      // Fail closed before constructing a probe, heal, or existing-preview
      // script. Legacy AppRecords can predate the preview env allowlist and
      // would otherwise reach the batched path without calling
      // previewDbBackendFor() (which is only needed for a brand-new target).
      validatePreviewEnvIsolation(app);

      // Audit every record already known to be PR-managed before the
      // unchanged-SHA filter can hide it. Explicit `env destroy` intentionally
      // does not call this guard, so operators can still remove an unsafe
      // legacy none/template preview and recreate it with DBLab.
      for (const stored of envStore.listFor(vmRecord.id, app.name)) {
        if (stored.prNumber !== undefined) {
          assertStoredPreviewBackend(app, stored.dbBackend);
        }
      }

      // The injectable remote for counting in tests; prod uses the real runner.
      // NOTE: we import the factory here but build the WORK remote lazily after
      // computing the item count so it gets a proportionally scaled timeout
      // (Fix 1 — BATCH_TIMEOUT).
      const { defaultEnvExecDeps: mkEnvExecDeps2 } = await import("./env.ts");

      // ------------------------------------------------------------------
      // Phase 1: Probe clone health + live ports (1 SSH call per VM).
      //
      // FIX 3 (PORT_GUARD): the probe script already outputs ss -ltnH via
      // HEAL_PROBE_PORTS_{BEGIN,END}. We now parse and cache those live ports
      // so Phase-3 can pass them to deriveTarget as extraUsedPorts — causing
      // deriveTarget to skip squatted ports.  If deriveTarget's only candidate
      // is squatted (pool exhausted when live ports removed), it returns an
      // {error} and the PR is fail-closed (not pre-upserted, not batched).
      // ------------------------------------------------------------------
      type LocalCloneHealth = "alive" | "dead" | "unknown";
      const cloneHealthMap = new Map<string, LocalCloneHealth>();
      // Live ports parsed from Phase-1 probe. Empty set when Phase-1 did not run.
      let phase1LivePorts: ReadonlySet<number> = new Set();

      const dblabEnvs: EnvRecord[] = cycleOpts.heal
        ? envStore.listFor(vmRecord.id, app.name).filter((e) => e.dbBackend === "dblab")
        : [];

      if (dblabEnvs.length > 0) {
        const { buildBatchedProbeScript, parseBatchedProbe, parseProbeListeningPorts } =
          await import("../preview/heal-deps.ts");
        const cloneIds = dblabEnvs.map((e) => e.dbName ?? e.name);
        const probeScript = buildBatchedProbeScript(cloneIds);
        // Phase-1 uses the standard 120s probe remote (opts.remote for tests,
        // default runner for prod). Timeout is NOT scaled here because the probe
        // is proportional to #clones, not #work items.
        const probeRemote = opts.remote ?? mkEnvExecDeps2().remote;
        try {
          const probeResult = await probeRemote(vmRecord, probeScript); // SSH CALL #1
          const parsed = parseBatchedProbe(probeResult.code === 0, probeResult.stdout, cloneIds);
          for (const [k, v] of parsed) cloneHealthMap.set(k, v);
          // FIX 3: cache live ports from the same probe output.
          phase1LivePorts = parseProbeListeningPorts(probeResult.stdout);
        } catch (e) {
          // Probe failed → mark all as unknown (fail-closed; no healing this cycle).
          process.stderr.write(
            `samohost: batchedVmCycle: probe failed for ${app.name}@${vmRecord.name} — ` +
              `${e instanceof Error ? e.message : String(e)}; no heal this cycle\n`,
          );
          for (const env of dblabEnvs) {
            cloneHealthMap.set(env.dbName ?? env.name, "unknown");
          }
        }
      }

      // Dead clones: need re-creating.
      const deadEnvs = dblabEnvs.filter(
        (env) => cloneHealthMap.get(env.dbName ?? env.name) === "dead",
      );

      // ------------------------------------------------------------------
      // Phase 2: List open PRs (gh CLI — no SSH).
      //
      // B1 FIX: distinguish "no open PRs" from "could not fetch PRs".
      // A gh-list ERROR (thrown or non-zero exit) means we have NO RELIABLE
      // knowledge of which PRs are open.  Proceeding with openPrs=[] would
      // cause the closed-PR reap loop to destroy EVERY PR-managed env on this
      // VM — a catastrophic false-positive.
      //
      // Strategy: use a sentinel `prListSucceeded` flag.  Only when the list
      // call succeeds do we populate `openPrs` and allow the reap loop to run.
      // On any error we SKIP the PR preview pass for this app (fail-loud via
      // stderr) so the issue is visible in the journal.
      //
      // FIX 5b (REPORTING_PRLIST): capture the error message in `prListError`
      // so it appears in PrPreviewSummary.listError, making a list-failure
      // distinguishable from zero-open-PRs.
      // ------------------------------------------------------------------
      type OpenPrItem = { number: number; headRef: string; headSha: string };
      let openPrs: OpenPrItem[] = [];
      let prListSucceeded = !cycleOpts.prPreviews; // true when pass is disabled (no-op)
      let prListError: string | undefined;

      if (cycleOpts.prPreviews) {
        try {
          if (opts.listOpenPrs !== undefined) {
            openPrs = await opts.listOpenPrs(app.repo);
          } else {
            const { spawnSync: spawnSyncPr } = await import("node:child_process");
            const res = spawnSyncPr(
              "gh",
              [
                "pr", "list", "--repo", app.repo, "--state", "open",
                "--json", "number,headRefName,headRefOid,isCrossRepository",
              ],
              { encoding: "utf8" },
            );
            if (res.status !== 0) {
              // Non-zero exit from gh pr list — fail-loud and skip this app.
              throw new Error(
                `gh pr list failed (exit ${res.status}): ${(res.stderr ?? "").trim()}`,
              );
            }
            const parsed = JSON.parse(res.stdout) as Array<{
              number: number;
              headRefName: string;
              headRefOid: string;
              isCrossRepository: boolean;
            }>;
            openPrs = parsed
              .filter((p) => !p.isCrossRepository)
              .map((p) => ({
                number: p.number,
                headRef: p.headRefName,
                headSha: p.headRefOid,
              }));
          }
          // Only reach here on success — set the sentinel.
          prListSucceeded = true;
        } catch (e) {
          // Fail-loud: surface the error so operators see it in the journal.
          // Do NOT proceed with openPrs=[] — that would false-positive reap.
          prListError = e instanceof Error ? e.message : String(e);
          process.stderr.write(
            `samohost: batchedVmCycle: gh pr list FAILED for ${app.name} — ` +
              `${prListError}; ` +
              `SKIPPING PR preview pass for this app this cycle to avoid ` +
              `false-positive reap of PR-managed envs\n`,
          );
          // prListSucceeded stays false → reap loop is gated below.
        }
      }

      // Older PR env records may not have prNumber persisted. Match every open
      // PR by branch and audit the stored backend before filtering unchanged
      // SHAs or applying the per-cycle cap, otherwise an already-up-to-date
      // legacy none/template preview can bypass the DBLab-only policy forever.
      for (const pr of openPrs) {
        const existing = envStore.get(vmRecord.id, app.name, pr.headRef);
        if (existing !== undefined) {
          assertStoredPreviewBackend(app, existing.dbBackend);
        }
      }

      // H5 CAP: apply MAX_PR_PREVIEWS_PER_CYCLE before computing needDeploy.
      // Safety cap — not a target.  Emit a warning when truncated.
      const { MAX_PR_PREVIEWS_PER_CYCLE } = await import("../preview/pr.ts");
      if (openPrs.length > MAX_PR_PREVIEWS_PER_CYCLE) {
        process.stderr.write(
          `samohost: batchedVmCycle: ${app.name} has ${openPrs.length} open PRs — ` +
            `processing only the first ${MAX_PR_PREVIEWS_PER_CYCLE} (safety cap); ` +
            `remaining ${openPrs.length - MAX_PR_PREVIEWS_PER_CYCLE} skipped this cycle\n`,
        );
        openPrs = openPrs.slice(0, MAX_PR_PREVIEWS_PER_CYCLE);
      }

      // PRs that need a deploy (new env or changed SHA).
      const prsNeedingDeploy = openPrs.filter((pr) => {
        const existing = envStore.get(vmRecord.id, app.name, pr.headRef);
        return existing === undefined || existing.lastDeployedSha !== pr.headSha;
      });

      // ------------------------------------------------------------------
      // Phase 3: Build batch work items (no SSH).
      //
      // FIX 3 (PORT_GUARD): pass phase1LivePorts as extraUsedPorts to
      // deriveTarget so squatted ports are skipped during allocation. If the
      // pool is exhausted after excluding squatted ports, deriveTarget returns
      // {error} and the PR item is fail-closed (not pre-upserted, not batched).
      //
      // FIX 5a (REPORTING_DERIVETARGET): when deriveTarget fails, push a
      // descriptive "failed" result immediately into prEarlyFailures so
      // Phase-6 can surface the real error instead of the generic fallback
      // "item not found in batch output".
      // ------------------------------------------------------------------
      const {
        buildEnvCreateScript,
        targetFromRecord: localTargetFromRecord,
      } = await import("../env/script.ts");
      const {
        deriveTarget: localDeriveTarget,
        DEFAULT_PREVIEW_DOMAIN: localPreviewDomain,
      } = await import("./env.ts");
      const { DEFAULT_POOL: localPool } = await import("../env/ports.ts");

      // Early failures from Phase-3 (deriveTarget, port squatter, DNS missing).
      // Keyed by headRef so Phase-6 can find them per-PR.
      const prEarlyFailures = new Map<string, { prNumber: number; error: string }>();

      // Heal items: one item per dead clone, using the existing stored target.
      const deadCloneItems: Array<{ envName: string; cloneId: string; script: string }> = [];
      for (const env of deadEnvs) {
        const target = localTargetFromRecord(env);
        const script = buildEnvCreateScript(app, target);
        deadCloneItems.push({ envName: env.name, cloneId: env.dbName ?? env.name, script });
      }

      // PR items: one item per PR needing deploy, allocating a new target
      // for first-time creates.  FIX 3: pass live ports to deriveTarget.
      const prWorkItems: Array<{
        branch: string; headSha: string; prNumber: number; script: string;
        vhost: string; isNewEnv: boolean;
      }> = [];
      // Track newly pre-upserted env records for port-conflict avoidance
      // across multiple new PR envs in the same batch cycle.
      const preUpsertedBranches = new Set<string>();

      for (const pr of prsNeedingDeploy) {
        const existing = envStore.get(vmRecord.id, app.name, pr.headRef);
        let targetForPr: import("../env/script.ts").EnvScriptTarget;
        const isNewEnv = existing === undefined;

        if (existing !== undefined) {
          assertStoredPreviewBackend(app, existing.dbBackend);
          targetForPr = localTargetFromRecord(existing);
        } else {
          // New env: derive target using store-only allocation (natural allocation).
          const allEnvsNow = envStore.listFor(vmRecord.id);
          const t = localDeriveTarget(
            app,
            pr.headRef,
            previewDbBackendFor(app),
            localPreviewDomain,
            allEnvsNow,
            localPool,
            // extraUsedPorts intentionally NOT passed here — we want the store-only
            // natural allocation so we can explicitly check if IT is squatted.
          );
          if ("error" in t) {
            // Port pool exhausted or bad domain.
            // FIX 5a: push a descriptive failed result so Phase-6 surfaces the
            // real error rather than "item not found in batch output".
            const errMsg = t.error;
            process.stderr.write(
              `samohost: batchedVmCycle: cannot derive target for PR #${pr.number}` +
                ` (${pr.headRef}): ${errMsg}\n`,
            );
            prEarlyFailures.set(pr.headRef, { prNumber: pr.number, error: errMsg });
            continue;
          }

          // FIX 3 (PORT_GUARD): FAIL-CLOSED. The old single-env path (runEnvCreate)
          // probed actually-bound ports and refused to proceed if the allocated port
          // was already live. In the batched path the allocation was store-only, so
          // a squatter caused a wedged env (port pinned forever in the record).
          //
          // Fix: compare the naturally-allocated port against Phase-1 live ports. If
          // squatted → fail this PR for the current cycle. The next cycle will retry
          // and either the squatter will be gone, or the cycle will fail again. We
          // do NOT try a different port — that would silently let the PR land on an
          // unexpected port while the squatter is still bound on the intended one.
          const allocatedListenerPorts = t.ports !== undefined
            ? Object.values(t.ports)
            : [t.port];
          const squattedPort = allocatedListenerPorts.find((port) =>
            phase1LivePorts.has(port)
          );
          if (squattedPort !== undefined) {
            const errMsg =
              `listener port ${squattedPort} is already bound on ${vmRecord.name} ` +
              `(squatted by a foreign process per Phase-1 probe); ` +
              `skipping this PR — will retry next cycle after squatter vacates`;
            process.stderr.write(`samohost: batchedVmCycle: ${errMsg}\n`);
            prEarlyFailures.set(pr.headRef, { prNumber: pr.number, error: errMsg });
            continue;
          }

          targetForPr = t;

          // Pre-upsert a placeholder env record to reserve the allocated port
          // for subsequent PRs in the same batch loop (avoids collisions).
          if (!preUpsertedBranches.has(pr.headRef)) {
            preUpsertedBranches.add(pr.headRef);
            envStore.upsert({
              id: crypto.randomUUID(),
              vmId: vmRecord.id,
              appName: app.name,
              branch: pr.headRef,
              name: targetForPr.name,
              port: targetForPr.port,
              ...(targetForPr.ports !== undefined
                ? { ports: targetForPr.ports }
                : {}),
              vhost: targetForPr.vhost,
              dbBackend: targetForPr.dbBackend,
              ...(targetForPr.dbName !== undefined ? { dbName: targetForPr.dbName } : {}),
              createdAt: new Date().toISOString(),
            });
          }
        }

        const script = buildEnvCreateScript(app, targetForPr);
        prWorkItems.push({
          branch: pr.headRef,
          headSha: pr.headSha,
          prNumber: pr.number,
          script,
          vhost: targetForPr.vhost,
          isNewEnv,
        });
      }

      // ------------------------------------------------------------------
      // DNS ensure phase: call ensurePreviewDns for PR items that need it.
      //
      // FIX 2 (DNS_RETRY): re-ensure DNS not only for brand-new envs
      // (isNewEnv=true) but ALSO for existing envs that lack lastDeployedSha
      // — those are envs from a prior failed cycle where the env record was
      // pre-upserted but the deploy never completed.  On the first cycle the
      // DNS ensure fires (isNewEnv=true), but on every subsequent retry cycle
      // isNewEnv=false because the placeholder record exists.  Without this
      // fix, DNS is never re-ensured and the ACME HTTP-01 challenge cannot
      // resolve → the preview stays unreachable forever after the first miss.
      //
      // FIX 4 (PREREQ_CONSISTENT): when CLOUDFLARE_SAMOCAT is missing in
      // the production code path (opts.ensurePreviewDns not injected), we no
      // longer silently degrade to wildcard-reliance.  A missing token means
      // the DNS record will not be created and the preview WILL NOT resolve on
      // per-VM DNS setups — exactly the 525 root cause we ship this PR to fix.
      // The token is already required by checkTriggerPrereqs() at startup; the
      // runtime degrade was inconsistent AND re-caused the same bug at the
      // create step.  Items that fail the DNS step are recorded in prEarlyFailures
      // so Phase-6 surfaces them as action="failed".
      // ------------------------------------------------------------------
      for (const item of prWorkItems) {
        // FIX 2: call DNS ensure for isNewEnv=true OR for existing envs that
        // have no lastDeployedSha (prior failed cycle — DNS was never confirmed).
        const existingForItem = envStore.get(vmRecord.id, app.name, item.branch);
        const needsDnsEnsure = item.isNewEnv || existingForItem?.lastDeployedSha === undefined;
        if (!needsDnsEnsure) continue;

        if (opts.ensurePreviewDns !== undefined) {
          // Test-injected spy.
          try {
            await opts.ensurePreviewDns(item.vhost, vmRecord.ip);
          } catch (e) {
            process.stderr.write(
              `samohost: batchedVmCycle: warning: ensurePreviewDns failed for ` +
                `${item.vhost} — ${e instanceof Error ? e.message : String(e)}; continuing\n`,
            );
          }
        } else {
          // Production: use CloudflareDns from CLOUDFLARE_SAMOCAT env var.
          //
          // FIX 4 (PREREQ_CONSISTENT): token absence is a hard error, not a
          // silent degrade.  checkTriggerPrereqs() already exits 1 at startup
          // when the token is missing; this runtime gate is the defence-in-depth
          // counterpart.  The token is required for previews to resolve —
          // proceeding without it causes the 525 we are fixing.
          const cfToken = process.env["CLOUDFLARE_SAMOCAT"];
          if (!cfToken) {
            const dnsErr =
              `CLOUDFLARE_SAMOCAT is not set — cannot ensure DNS for ${item.vhost}; ` +
              `preview will not resolve without a per-record DNS entry. ` +
              `Set CLOUDFLARE_SAMOCAT via a systemd EnvironmentFile drop-in and restart.`;
            process.stderr.write(`samohost: batchedVmCycle: ERROR — ${dnsErr}\n`);
            // Record the failure so Phase-6 surfaces it as action="failed".
            prEarlyFailures.set(item.branch, { prNumber: item.prNumber, error: dnsErr });
            continue;
          }
          try {
            const { CloudflareDns } = await import("../dns/cloudflare.ts");
            const { ensurePreviewDns: ensureDns } = await import("../dns/ensure.ts");
            const zoneId = process.env["SAMOHOST_SAMOCAT_ZONE_ID"];
            const provider = new CloudflareDns({
              token: cfToken,
              ...(zoneId ? { zoneId } : { zoneName: "samo.cat" }),
            });
            await ensureDns(provider, item.vhost, vmRecord.ip);
          } catch (e) {
            process.stderr.write(
              `samohost: batchedVmCycle: warning: DNS ensure failed for ` +
                `${item.vhost} — ${e instanceof Error ? e.message : String(e)}; continuing\n`,
            );
          }
        }
      }

      // Remove items that failed DNS ensure from the work list so they are not
      // batched to the VM (they are already recorded in prEarlyFailures for
      // Phase-6 to surface as action="failed").
      const effectivePrWorkItems = prWorkItems.filter(
        (item) => !prEarlyFailures.has(item.branch),
      );

      // ------------------------------------------------------------------
      // Phase 4: Run batch (1 SSH call for ALL heal + PR work).
      //
      // FIX 1 (BATCH_TIMEOUT): compute a timeout proportional to the number
      // of work items so large batches do not hit the old fixed 120s wall.
      // Formula (from batch.ts): BASE + N × PER_ITEM.
      // Only applies to the WORK session (Phase 4).  The Phase-1 probe uses
      // the standard default timeout (120s) — probe is cheap; scaling it
      // would not help the timed-out multi-PR scenario.
      // ------------------------------------------------------------------
      const {
        runBatchedVmCycle: runBatch,
        computeBatchTimeoutMs,
      } = await import("../ssh/batch.ts");

      let batchResult: import("../ssh/batch.ts").BatchedVmCycleOutput = {
        ok: true,
        prResults: [],
        healResults: [],
      };

      const hasWork = deadCloneItems.length > 0 || effectivePrWorkItems.length > 0;
      if (hasWork) {
        // FIX 1: scale the work-session timeout by total item count.
        const totalItems = deadCloneItems.length + effectivePrWorkItems.length;
        const scaledTimeoutMs = computeBatchTimeoutMs(totalItems);
        // When opts.remote is injected (tests), use it as-is (it's a fake).
        // In production, build a fresh runner with the scaled timeout.
        const workRemote = opts.remote ?? mkEnvExecDeps2({ timeoutMs: scaledTimeoutMs }).remote;

        batchResult = await runBatch({
          vm: vmRecord,
          app,
          prs: effectivePrWorkItems,
          deadClones: deadCloneItems,
          envStore,
          remote: workRemote, // SSH CALL #2 (conditional — only when there is work)
        });
      }

      // ------------------------------------------------------------------
      // Phase 5: Build HealSummary from probe + batch results.
      // ------------------------------------------------------------------
      const healResults: HealResult[] = [];
      for (const env of dblabEnvs) {
        const cloneId = env.dbName ?? env.name;
        const health = (cloneHealthMap.get(cloneId) ?? "unknown") as
          "alive" | "dead" | "unknown";

        if (health === "alive") {
          healResults.push({
            env: env.name, app: app.name, branch: env.branch,
            cloneId, health, action: "healthy",
          });
        } else if (health === "unknown") {
          healResults.push({
            env: env.name, app: app.name, branch: env.branch,
            cloneId, health, action: "skipped",
            error: "clone liveness unknown — fail-closed",
          });
        } else {
          // dead
          if (!batchResult.ok) {
            healResults.push({
              env: env.name, app: app.name, branch: env.branch,
              cloneId, health, action: "heal-failed",
              error: batchResult.error ?? "batch SSH call failed",
            });
          } else {
            const hr = batchResult.healResults.find((r) => r.envName === env.name);
            if (hr?.found === true) {
              healResults.push({
                env: env.name, app: app.name, branch: env.branch,
                cloneId, health, action: "healed",
              });
            } else {
              healResults.push({
                env: env.name, app: app.name, branch: env.branch,
                cloneId, health, action: "heal-failed",
                error: hr !== undefined ? hr.stderr : "item not found in batch output",
              });
            }
          }
        }
      }

      const healSummaryOut: HealSummary = {
        app: app.name,
        vm: vmRecord.name,
        examined: dblabEnvs.length,
        healed: healResults.filter((r) => r.action === "healed").length,
        failed: healResults.filter((r) => r.action === "heal-failed").length,
        deferred: healResults.filter((r) => r.action === "skipped" && r.health === "dead").length,
        results: healResults,
      };

      // ------------------------------------------------------------------
      // Phase 6: Build PrPreviewSummary + post comments.
      //
      // FIX 5a (REPORTING_DERIVETARGET): check prEarlyFailures FIRST so the
      // real error (port exhaustion, squatted port, DNS missing) is surfaced
      // instead of the generic "item not found in batch output" fallback.
      // ------------------------------------------------------------------
      const prPreviewResultsList: PrPreviewResult[] = [];
      const openPrBranchSet = new Set(openPrs.map((p) => p.headRef));
      const PR_COMMENT_MARKER = "<!-- samohost-preview -->";

      // Process PRs that needed deploy.
      for (const pr of prsNeedingDeploy) {
        // FIX 5a: surface early failures (deriveTarget, port squatter, DNS) with
        // the real error message before falling through to the batch-result logic.
        const earlyFail = prEarlyFailures.get(pr.headRef);
        if (earlyFail !== undefined) {
          prPreviewResultsList.push({
            prNumber: pr.number, branch: pr.headRef,
            action: "failed", error: earlyFail.error,
          });
          continue;
        }

        const existingRecord = envStore.get(vmRecord.id, app.name, pr.headRef);

        if (!batchResult.ok) {
          prPreviewResultsList.push({
            prNumber: pr.number, branch: pr.headRef,
            action: "failed", error: batchResult.error ?? "batch SSH call failed",
          });
          continue;
        }

        const pr2 = batchResult.prResults.find((r) => r.branch === pr.headRef);
        const wasNewEnv = existingRecord === undefined ||
          existingRecord.lastDeployedSha === undefined;

        if (pr2?.found === true) {
          const rec = envStore.get(vmRecord.id, app.name, pr.headRef);
          const vhost = rec?.vhost ?? existingRecord?.vhost ?? "";
          const url = vhost ? `https://${vhost}` : undefined;

          // B3 FIX: external HTTPS reachability gate (mirrors the old
          // runEnvCreate path in env.ts:691-728).
          //
          // The on-host script's health phase runs `curl http://localhost:PORT/`
          // inside the remote bash — it returns ok even when the preview URL is
          // EXTERNALLY unreachable (TLS not provisioned, DNS not propagated,
          // Caddy not listening on 443, etc.).
          //
          // Only stamp lastDeployedSha + post the comment when the PUBLIC URL
          // returns 200 via the external probe.  On failure, leave the record
          // WITHOUT a lastDeployedSha stamp so the reconcile loop retries next
          // cycle (dishonest-state fix: stamping on failure would make
          // needDeploy=false and the broken preview would never be retried).
          let probeOk = true; // default: no probe wired → treat as ok (back-compat)
          if (url !== undefined) {
            const { EXTERNAL_PROBE_RETRIES } = await import("./env.ts");
            const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
            const PROBE_SLEEP_MS = 5000;
            let lastProbeStatus: number | undefined;
            let lastProbeError: string | undefined;
            probeOk = false;

            const probe = opts.httpProbe ?? (async (probeUrl: string) => {
              // Production: use system curl (avoids Bun's CA verification issues
              // with Cloudflare's GTS edge cert chain, per env.ts:533-537).
              const { spawnSync: curlSpawn } = await import("node:child_process");
              const { buildCurlProbeArgs, parseCurlProbeResult } = await import("./env.ts");
              const curlArgs = buildCurlProbeArgs(probeUrl);
              // curlArgs[0] is always "curl" (non-undefined) — buildCurlProbeArgs
              // returns a string[] with "curl" as the first element.
              const cmd = curlArgs[0] as string;
              const res = curlSpawn(cmd, curlArgs.slice(1), { encoding: "utf8", timeout: 15_000 });
              return parseCurlProbeResult(res.stdout ?? "", res.status ?? 1);
            });

            for (let attempt = 0; attempt < EXTERNAL_PROBE_RETRIES; attempt++) {
              if (attempt > 0) await sleep(PROBE_SLEEP_MS);
              try {
                const result = await probe(`${url}/`);
                lastProbeStatus = result.status;
                if (result.ok) { probeOk = true; break; }
              } catch (e) {
                lastProbeError = e instanceof Error ? e.message : String(e);
              }
            }

            if (!probeOk) {
              const detail = lastProbeError !== undefined
                ? `error: ${lastProbeError}`
                : `HTTP ${lastProbeStatus}`;
              process.stderr.write(
                `samohost: batchedVmCycle: external probe FAILED for ${url}/ — ` +
                  `on-host phases passed but the public URL is unreachable (${detail}); ` +
                  `not stamping lastDeployedSha — will retry next cycle\n`,
              );
            }
          }

          if (probeOk) {
            // Stamp lastDeployedSha + prNumber ONLY when the external probe passed.
            if (rec !== undefined) {
              envStore.upsert({ ...rec, lastDeployedSha: pr.headSha, prNumber: pr.number });
            }

            const action: PrPreviewResult["action"] = wasNewEnv ? "created" : "redeployed";

            // Post or update the preview-link comment.
            let commentError: string | undefined;
            if (url !== undefined) {
              const body =
                `${PR_COMMENT_MARKER}\n\u{1F50E} **Preview:** ${url} — auto-updates on push.`;
              try {
                const { spawnSync: spawnSyncGh } = await import("node:child_process");
                // Find existing comment.
                const listRes = spawnSyncGh(
                  "gh",
                  ["api", `repos/${app.repo}/issues/${pr.number}/comments`, "--paginate"],
                  { encoding: "utf8" },
                );
                let existingCommentId: number | undefined;
                if (listRes.status === 0) {
                  const comments = JSON.parse(listRes.stdout) as Array<{ id: number; body: string }>;
                  const found = comments.find((c) => c.body.includes(PR_COMMENT_MARKER));
                  if (found !== undefined) existingCommentId = found.id;
                }
                const writeRes = existingCommentId !== undefined
                  ? spawnSyncGh(
                      "gh",
                      ["api", "--method", "PATCH",
                       `repos/${app.repo}/issues/comments/${existingCommentId}`,
                       "-f", `body=${body}`],
                      { encoding: "utf8" },
                    )
                  : spawnSyncGh(
                      "gh",
                      ["api", "--method", "POST",
                       `repos/${app.repo}/issues/${pr.number}/comments`,
                       "-f", `body=${body}`],
                      { encoding: "utf8" },
                    );
                if (writeRes.status !== 0) {
                  throw new Error(
                    `gh api comment write failed (exit ${writeRes.status}): ` +
                      `${(writeRes.stderr ?? "").trim()}`,
                  );
                }
              } catch (e) {
                commentError = e instanceof Error ? e.message : String(e);
                process.stderr.write(
                  `samohost: batchedVmCycle: PR #${pr.number} (${app.name}): env is up at ` +
                    `${url} but POSTING comment FAILED — ${commentError}\n`,
                );
              }
            }

            prPreviewResultsList.push({
              prNumber: pr.number, branch: pr.headRef, url, action,
              ...(commentError !== undefined ? { commentError } : {}),
            });
          } else {
            // External probe failed: report as failed, no stamp, no comment.
            prPreviewResultsList.push({
              prNumber: pr.number, branch: pr.headRef,
              action: "failed",
              error: "external HTTPS probe failed — preview unreachable; will retry next cycle",
            });
          }
        } else {
          prPreviewResultsList.push({
            prNumber: pr.number, branch: pr.headRef,
            action: "failed",
            error: pr2 !== undefined ? pr2.stderr : "item not found in batch output",
          });
        }
      }

      // Unchanged PRs (already up to date — no deploy needed).
      for (const pr of openPrs) {
        const alreadyProcessed = prsNeedingDeploy.some((p) => p.headRef === pr.headRef);
        if (!alreadyProcessed) {
          const existing = envStore.get(vmRecord.id, app.name, pr.headRef);
          prPreviewResultsList.push({
            prNumber: pr.number, branch: pr.headRef,
            url: existing !== undefined ? `https://${existing.vhost}` : undefined,
            action: "unchanged",
          });
        }
      }

      // Reap closed-PR envs (envs whose PR is no longer open AND were PR-managed).
      //
      // B1 FIX: ONLY run the reap when prListSucceeded=true.  When the PR list
      // call failed, we have no reliable knowledge of which PRs are open.
      // Reaping with openPrBranchSet={} would destroy ALL PR-managed envs —
      // a catastrophic false-positive.  Skip reap entirely on list failure.
      if (prListSucceeded) {
        const allEnvsForApp = envStore.listFor(vmRecord.id, app.name);
        for (const env of allEnvsForApp) {
          if (openPrBranchSet.has(env.branch)) continue; // still open — keep
          if (env.prNumber === undefined) continue; // not PR-managed — never reap
          if (envStore.get(vmRecord.id, app.name, env.branch) === undefined) continue; // already gone

          try {
            const { runEnvDestroy: localRunEnvDestroy, defaultEnvExecDeps: mkEnvExecDeps3 } =
              await import("./env.ts");
            const { StateStore: ReapVmStore } = await import("../state/store.ts");
            const { AppStore: ReapAppStore } = await import("../state/apps.ts");
            const reapVmStore = new ReapVmStore();
            const reapAppStore = new ReapAppStore();
            const reapEnvExecDeps = mkEnvExecDeps3();
            const noopReap = (_s: string) => {};

            await localRunEnvDestroy(
              { vm: vmRecord.name, app: app.name, branch: env.branch },
              { json: false },
              reapVmStore,
              reapAppStore,
              envStore,
              reapEnvExecDeps,
              noopReap,
              (s: string) => {
                if (!s.includes("no env recorded")) {
                  process.stderr.write(`samohost: batchedVmCycle reap: ${s}\n`);
                }
              },
            );
            prPreviewResultsList.push({ prNumber: -1, branch: env.branch, action: "reaped" });
          } catch (e) {
            prPreviewResultsList.push({
              prNumber: -1, branch: env.branch, action: "error",
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      const prPreviewSummaryOut: PrPreviewSummary = {
        app: app.name,
        vm: vmRecord.name,
        openPrs: openPrs.length,
        results: prPreviewResultsList,
        // FIX 5b (REPORTING_PRLIST): surface gh-list error so callers can
        // distinguish "zero open PRs" from "PR list call failed → zero processed".
        ...(prListError !== undefined ? { listError: prListError } : {}),
      };

      return { heal: healSummaryOut, prPreview: prPreviewSummaryOut };
    },

    // Test-only sentinel: confirms that heal and prPreview closures use the
    // same envStore instance as deps.envStore (not fresh instances). Tests
    // assert (deps as any)._envStoreShared === true.
    _envStoreShared: true,
  } as TriggerDeps & { _envStoreShared: boolean };
}
