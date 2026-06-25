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
import type { PrPreviewSummary } from "../preview/pr.ts";
import type { HealSummary } from "../preview/heal.ts";
import type { EnvIdleGcDeps } from "./env-idle.ts";
import type { AppRecord, EnvDbBackend, VmRecord } from "../types.ts";

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
  return app.previewDbBackend ?? (app.dbBackend === "none" ? "none" : "dblab");
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

  // ---- Self-heal pass (samohost #78) -------------------------------------
  // Runs BEFORE the PR-preview pass and AFTER the GC pass so:
  //   - a GC'd env is not re-healed (consistent view)
  //   - a clone re-cut by heal is visible to the PR-preview pass (which sees a
  //     healthy env instead of a broken one that would need re-creating anyway)
  //
  // Gating: `input.heal === true` OR `input.prPreviews === true` (backward
  // compat — before the `heal` flag existed, heal ran whenever prPreviews ran).
  // Cron/manual invocations that don't manage PR-previews can now set
  // `--heal` without `--pr-previews` to heal dead clones independently.
  //
  // ONE batched probe per app + budget-aware re-creates of the dead ones;
  // healthy previews untouched. Per-app isolation: one app's heal failure
  // must not abort the cycle.
  let healSummaries: HealSummary[] | undefined;
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

  // ---- PR-preview pass (opt-in: only when input.prPreviews is true and dep is wired) ----
  // Runs AFTER the GC pass so gc's reap results are visible to the pr-preview
  // reaper (guards against double-reap: if gc removed a branch-gone env, the
  // existence guard in runPrPreviewPass will see it as already gone).
  // Per-app isolation: one app's prPreview failure must not abort the cycle.
  let prPreviewSummaries: PrPreviewSummary[] | undefined;

  if (input.prPreviews === true && deps.prPreview !== undefined) {
    const liveCandidateApps: Array<{ app: (typeof candidates)[number]; vm: VmRecord }> = [];

    // POLICY (src/preview/pr.ts lines 9-12): PR previews deploy at HEAD
    // regardless of CI status — DELIBERATE. checkCiGreen is NOT consulted here.
    // The prod-deploy CI gate (above) skips apps with ci-none; the PR-preview
    // pass must run for those apps regardless, so we filter by VM liveness only
    // and do NOT propagate the prod-deploy CI result here.
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
    // input.prPreviews is true. Fresh env store per call so the re-cut clone's
    // wiring is persisted to ~/.samohost/envs.json (mirrors prPreview closure).
    heal: async (app: AppRecord, vmRecord: VmRecord): Promise<HealSummary> => {
      const { runHealPass } = await import("../preview/heal.ts");
      const { defaultHealDeps } = await import("../preview/heal-deps.ts");
      const { EnvStore: HealEnvStore } = await import("../state/envs.ts");
      const healEnvStore = new HealEnvStore();
      const noop = (_s: string) => {};
      return runHealPass(app, vmRecord, defaultHealDeps(healEnvStore), noop, (s: string) => process.stderr.write(s + "\n"));
    },

    prPreview: async (app: AppRecord, vmRecord: VmRecord): Promise<PrPreviewSummary> => {
      const { spawnSync } = await import("node:child_process");
      const {
        runPrPreviewPass,
      } = await import("../preview/pr.ts");
      const { DEFAULT_PREVIEW_DOMAIN, runEnvCreate, runEnvDestroy, defaultEnvExecDeps: mkEnvExecDeps } = await import("./env.ts");
      const { StateStore: PrVmStore } = await import("../state/store.ts");
      const { AppStore: PrAppStore } = await import("../state/apps.ts");
      const { EnvStore: PrEnvStore } = await import("../state/envs.ts");

      const prEnvStore = new PrEnvStore();

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
  };
}
