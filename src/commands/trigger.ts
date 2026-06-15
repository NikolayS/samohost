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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TriggerRunInput {
  /** Narrow to a single VM by name or id (optional). */
  vm?: string;
  /** Narrow to a single app by name (optional). */
  app?: string;
  dryRun: boolean;
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
 */
export function defaultTriggerDeps(): TriggerDeps {
  // Bind AppDeployDeps once for the lifetime of this trigger run.
  const appDeployDeps = defaultAppDeployDeps();

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
  };
}
