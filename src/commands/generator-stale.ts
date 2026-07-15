/**
 * src/commands/generator-stale.ts — Phase 1 of the "never silently lose an
 * update" fix.
 *
 * Provides an OFFLINE (no SSH) check that compares each AppRecord's stored
 * generatorSha against the current samohost generator SHA. An absent
 * generatorSha (legacy record) is treated as stale — never as current, never
 * as a crash.
 *
 * This is NOT a DoctorCheck/AuditCheck SSH probe — it reads local AppStore
 * state and compares strings. It is called from doctor/fleet-doctor output
 * formatting as a data-only pass, not over SSH.
 *
 * Phase 2 (heal command) and Phase 3 (trigger auto-heal) are NOT in scope here.
 */

import { execSync } from "node:child_process";
import type { AppRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeneratorStatus = "current" | "stale";

export interface GeneratorStalenessResult {
  appId: string;
  appName: string;
  vmId: string;
  /** Stored generatorSha, or undefined for legacy records. */
  generatorSha: string | undefined;
  status: GeneratorStatus;
}

// ---------------------------------------------------------------------------
// Core check — purely offline, no SSH, no remote runner
// ---------------------------------------------------------------------------

/**
 * Check each app in `apps` for generator staleness against `currentSha`.
 *
 * Rules (per Phase 1 spec):
 *   - app.generatorSha === currentSha  → status: "current"
 *   - app.generatorSha !== currentSha  → status: "stale"
 *   - app.generatorSha === undefined   → status: "stale" (legacy = treated as stale)
 *
 * Never throws; an empty array is returned for an empty input.
 */
export function checkGeneratorStaleness(
  apps: AppRecord[],
  currentSha: string,
): GeneratorStalenessResult[] {
  return apps.map((app) => {
    const isStale =
      app.generatorSha === undefined || app.generatorSha !== currentSha;
    return {
      appId: app.id,
      appName: app.name,
      vmId: app.vmId,
      generatorSha: app.generatorSha,
      status: isStale ? "stale" : "current",
    };
  });
}

// ---------------------------------------------------------------------------
// Production generator SHA resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the current samohost generator SHA from the canonical trigger
 * checkout at ~/samohost-trigger.
 *
 * The trigger resets to origin/main HEAD before each deploy cycle, so
 * ~/samohost-trigger HEAD is always the honest generation SHA. Using the
 * operator's cwd (which may be a feature branch) would produce false-stale
 * results.
 *
 * Only called in production. Tests inject a literal string via
 * AppDeployDeps.resolveGeneratorSha.
 */
export function resolveProductionGeneratorSha(): string {
  return execSync(
    "git -C ~/samohost-trigger rev-parse HEAD",
    { encoding: "utf8" },
  ).trim();
}
