/**
 * Self-healing DBLab preview clones (samohost #78).
 *
 * ROOT CAUSE: DBLab runs a daily logical snapshot refresh (~03:00) that retires
 * the old snapshot and GCs every clone bound to it. The preview apps keep
 * dialing the now-dead clone port → ECONNREFUSED → 500 on login. The clone is
 * gone but the preview's systemd unit, .env, and Caddy vhost all survive — so
 * the env LOOKS alive while its database has vanished.
 *
 * HEAL: in the trigger's preview pass (runs every cycle, ~3 min):
 *   1. ONE batched SSH probe reads every dblab-backed preview's clone liveness
 *      at once (status + port reachability). Batching is mandatory: the pinned
 *      SSH runner enforces a fail2ban-safe connection budget (≤2 attempts /
 *      600s / VM), so a per-env probe would exhaust the budget after two envs.
 *   2. For each env whose clone is DEAD/MISSING, re-run the env-create path.
 *      runEnvCreate is ALREADY idempotent for the dblab backend (env/script.ts):
 *        - drops-if-exists then re-creates the clone from the CURRENT snapshot,
 *        - re-wires every envDbVars URL's host:port at the new clone
 *          (`samohost_rewire_db_hostport`) → DATABASE_URL/APP_DATABASE_URL point
 *          at the new clone port,
 *        - restarts ONLY that env's systemd template instance (never Caddy
 *          globally, never prod),
 *        - reloads ONLY that env's Caddy snippet, re-runs the health probe.
 *      Each re-create is one SSH connection, so it too is budget-bound — the
 *      heal pass re-creates as many dead envs as the remaining budget allows
 *      this cycle and CONVERGES across the 3-min cycles (the budget is
 *      per-process and resets every invocation).
 *
 * SAFETY:
 *   - previews ONLY: enumerates EnvRecords (preview envs); never touches the
 *     production app (separate AppRecord/deploy path) or its 5432 DB.
 *   - non-dblab envs (template/none) are SKIPPED (not snapshot-bound).
 *   - HEALTHY envs are left untouched (idempotent — zero side effects).
 *   - per-env isolation: one env's heal throw → that env failed; others proceed.
 *   - fail-closed on an INDETERMINATE probe ("unknown"): do NOT re-create
 *     blindly; report skipped and retry next cycle.
 *   - budget-aware: when re-creates exhaust the connection budget, the remaining
 *     dead envs are reported `skipped` (reason: budget) — NOT failed — because
 *     they will be healed by the next cycle. Never bans the operator IP.
 */

import type { AppRecord, EnvRecord, VmRecord } from "../types.ts";
import type { EnvStore } from "../state/envs.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The liveness verdict for one env's dblab clone.
 *   - "alive"  : clone present, status OK, usable port, AND port reachable.
 *   - "dead"   : clone present-but-unusable (status not OK / no port) OR clone
 *                absent OR its port unreachable (the 03:00-refresh symptom).
 *   - "unknown": could not determine liveness (probe inconclusive / engine
 *                unreachable) → fail-closed: do NOT heal this cycle.
 */
export type CloneHealth = "alive" | "dead" | "unknown";

/** Result for a single env in one heal pass. */
export interface HealResult {
  /** Env name (`<app>-<branch-label>`). */
  env: string;
  app: string;
  branch: string;
  /** The clone id (EnvRecord.dbName ?? name). */
  cloneId: string;
  /** The liveness verdict that drove the action. */
  health: CloneHealth;
  /**
   *   - "healthy"    : clone alive → no action.
   *   - "healed"     : clone was dead/missing → re-created successfully.
   *   - "heal-failed": clone was dead/missing → re-create attempted but FAILED.
   *   - "skipped"    : not healed this cycle — either liveness unknown
   *                    (fail-closed) or the connection budget is exhausted (will
   *                    heal next cycle). Never a hard failure.
   */
  action: "healthy" | "healed" | "heal-failed" | "skipped";
  /** Populated for heal-failed / skipped / probe errors. */
  error?: string;
}

/** Summary of one heal pass across all dblab-backed envs for an (app, vm). */
export interface HealSummary {
  app: string;
  vm: string;
  /** Count of dblab-backed envs examined for this (app, vm). */
  examined: number;
  healed: number;
  failed: number;
  /** Dead envs deferred to a later cycle (budget exhausted) — not failures. */
  deferred: number;
  results: HealResult[];
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Outcome of a single re-create attempt. */
export type RecreateOutcome = "ok" | "failed" | "budget";

export interface HealDeps {
  /**
   * Probe the liveness of EVERY given env's dblab clone in ONE SSH round-trip.
   * Returns a map keyed by clone id (`env.dbName ?? env.name`). A clone id
   * absent from the returned map is treated as "unknown" (fail-closed).
   *
   * MUST be a single connection for the whole batch (the connection budget
   * forbids per-env probes). A throw (e.g. SSH transport failure / budget
   * exhausted before the probe) is caught by the caller and every env is
   * reported as a probe failure (NOT healed this cycle).
   *
   * Production impl (defaultHealDeps): ONE `bash -s` script that, per clone,
   * prints `dblab clone status <id>` + the host's `ss -ltnH` once, and maps each
   * to alive/dead/unknown (reusing the #71/#73 port-reachability logic).
   */
  probeClones: (
    vm: VmRecord,
    app: AppRecord,
    envs: readonly EnvRecord[],
  ) => Promise<Map<string, CloneHealth>>;

  /**
   * Re-create (heal) one env: re-run the idempotent env-create path so the clone
   * is re-cut from the current snapshot, DATABASE_URL re-wired, the unit
   * restarted. Returns:
   *   - "ok"     : env usable again.
   *   - "failed" : create ran but did not succeed (env still down).
   *   - "budget" : the connection budget is exhausted — NOT attempted; defer to
   *                the next cycle. (The production impl maps a BudgetExceededError
   *                to this; it MUST NOT let the cycle ban the operator IP.)
   * MUST NOT throw for these ordinary cases.
   *
   * Production impl wraps runEnvCreate(db="dblab") against the SAME injected
   * envStore.
   */
  recreate: (
    vm: VmRecord,
    app: AppRecord,
    env: EnvRecord,
  ) => Promise<RecreateOutcome>;

  /** Shared env store — read to enumerate dblab envs for this (app, vm). */
  envStore: EnvStore;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Perform ONE idempotent self-heal pass for a single (app, vm) pair.
 *
 * 1. Enumerate (vm.id, app.name) envs; keep dbBackend === "dblab".
 * 2. ONE batched probeClones → health map (a probe throw ⇒ every env reported
 *    as heal-failed with the error; the cycle does not abort).
 * 3. For each env (per-env try/catch):
 *      alive   → healthy (no side effects).
 *      unknown → skipped (fail-closed).
 *      dead    → recreate → ok ⇒ healed; failed ⇒ heal-failed; budget ⇒ skipped
 *                (deferred — counted separately, NOT a failure).
 */
export async function runHealPass(
  app: AppRecord,
  vm: VmRecord,
  deps: HealDeps,
  _out: (s: string) => void,
  err: (s: string) => void,
): Promise<HealSummary> {
  const dblabEnvs = deps.envStore
    .listFor(vm.id, app.name)
    .filter((e) => e.dbBackend === "dblab");

  const results: HealResult[] = [];

  if (dblabEnvs.length === 0) {
    return { app: app.name, vm: vm.name, examined: 0, healed: 0, failed: 0, deferred: 0, results };
  }

  // ---- ONE batched liveness probe for the whole app's dblab envs ----------
  let health: Map<string, CloneHealth>;
  try {
    health = await deps.probeClones(vm, app, dblabEnvs);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err(
      `samohost: heal: ${app.name}: batched clone probe failed — ${message}; ` +
        `no env healed this cycle (will retry)`,
    );
    for (const env of dblabEnvs) {
      results.push({
        env: env.name,
        app: app.name,
        branch: env.branch,
        cloneId: env.dbName ?? env.name,
        health: "unknown",
        action: "skipped",
        error: message,
      });
    }
    return {
      app: app.name,
      vm: vm.name,
      examined: dblabEnvs.length,
      healed: 0,
      failed: 0,
      deferred: dblabEnvs.length,
      results,
    };
  }

  // ---- Per-env decision + heal -------------------------------------------
  // Once the budget is known exhausted (a recreate returned "budget"), stop
  // attempting further re-creates this cycle and defer the rest — cheaper and
  // avoids generating noisy budget errors per remaining env.
  let budgetExhausted = false;

  for (const env of dblabEnvs) {
    const cloneId = env.dbName ?? env.name;
    const verdict = health.get(cloneId) ?? "unknown";

    try {
      if (verdict === "alive") {
        results.push(mk(env, app, cloneId, "alive", "healthy"));
        continue;
      }

      if (verdict === "unknown") {
        err(
          `samohost: heal: ${env.name}: clone liveness UNKNOWN — NOT healing ` +
            `this cycle (fail-closed); will retry next cycle`,
        );
        results.push(
          mk(env, app, cloneId, "unknown", "skipped", "clone liveness unknown — fail-closed"),
        );
        continue;
      }

      // verdict === "dead" → heal (unless the budget is already spent).
      if (budgetExhausted) {
        results.push(
          mk(env, app, cloneId, "dead", "skipped", "connection budget exhausted — deferred to next cycle"),
        );
        continue;
      }

      err(
        `samohost: heal: ${env.name}: clone ${cloneId} is DEAD/MISSING ` +
          `(likely reaped by the daily DBLab snapshot refresh) — re-creating from ` +
          `the current snapshot and re-wiring the app`,
      );
      const outcome = await deps.recreate(vm, app, env);
      if (outcome === "ok") {
        results.push(mk(env, app, cloneId, "dead", "healed"));
      } else if (outcome === "budget") {
        budgetExhausted = true;
        err(
          `samohost: heal: ${env.name}: connection budget exhausted before ` +
            `re-create — deferring this and any remaining dead envs to the next ` +
            `cycle (avoids fail2ban ban)`,
        );
        results.push(
          mk(env, app, cloneId, "dead", "skipped", "connection budget exhausted — deferred to next cycle"),
        );
      } else {
        err(`samohost: heal: ${env.name}: re-create FAILED — env still down; will retry next cycle`);
        results.push(mk(env, app, cloneId, "dead", "heal-failed", "re-create did not succeed"));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      err(`samohost: heal: ${env.name}: heal threw — ${message}`);
      results.push(mk(env, app, cloneId, verdict, "heal-failed", message));
    }
  }

  let healed = 0;
  let failed = 0;
  let deferred = 0;
  for (const r of results) {
    if (r.action === "healed") healed++;
    else if (r.action === "heal-failed") failed++;
    else if (r.action === "skipped" && r.health === "dead") deferred++;
  }

  return {
    app: app.name,
    vm: vm.name,
    examined: dblabEnvs.length,
    healed,
    failed,
    deferred,
    results,
  };
}

function mk(
  env: EnvRecord,
  app: AppRecord,
  cloneId: string,
  health: CloneHealth,
  action: HealResult["action"],
  error?: string,
): HealResult {
  return {
    env: env.name,
    app: app.name,
    branch: env.branch,
    cloneId,
    health,
    action,
    ...(error !== undefined ? { error } : {}),
  };
}
