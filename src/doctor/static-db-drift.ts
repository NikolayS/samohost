/**
 * src/doctor/static-db-drift.ts — LOCAL-only fleet-doctor guardrail.
 *
 * Check id: "static-db-drift"
 * Group:    "infra-sizing"
 *
 * Reads apps.json (AppRecord[]) in memory; makes NO SSH connections and no
 * hcloud API calls.
 *
 * Detects apps that are registered as kind="static" but carry DB fields whose
 * migrations NEVER run (neither env-create nor prod-deploy has a migrate phase
 * for static apps). This is the exact pattern that produced the "gamechangers"
 * situation: kind=static with migrateCmd/dbBackend/databaseUrlEnv set, so the
 * app's migration history is invisible to the managed flow.
 *
 * This is the DETECTION mirror of P1's validateStaticNoDb() in
 * src/manifest/toml.ts. P1 blocks NEW registrations with this shape; this
 * check surfaces EXISTING (pre-P1) apps that already drifted.
 *
 * Offending fields (same predicate as validateStaticNoDb):
 *   - migrateCmd set
 *   - dbBackend set to a non-"none" value ("dblab" or "template")
 *   - previewDbBackend set to a non-"none" value
 *   - databaseUrlEnv set
 *   - envDbVars non-empty
 *
 * "none" values are explicit declarations of no-database and are NOT offending.
 *
 * Recommendation: re-register as kind=node with the same DB fields so the
 * migrate phase runs in both preview env-create and production deploy.
 *
 * Background:
 *   The gamechangers app (kind=static + migrateCmd + dbBackend=dblab) is the
 *   canonical real-world case. Its migrations were silently not running because
 *   the static serve path has no migrate phase. Without this check the drift
 *   remained invisible in both the doctor and fleet sweep outputs.
 */

import type { AppRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result shape compatible with DoctorResult from src/commands/doctor.ts */
export interface StaticDbDriftResult {
  /** The AppRecord id of the drifted app. */
  appId: string;
  id: "static-db-drift";
  group: "infra-sizing";
  status: "pass" | "fail";
  description: string;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// checkStaticDbDrift — pure function, no I/O.
// ---------------------------------------------------------------------------

/**
 * Inspect all AppRecords for kind=static apps that carry DB fields. Return
 * one StaticDbDriftResult per offending app (status="fail"), or nothing for
 * apps that are clean.
 *
 * Callers (fleet-doctor.ts) fold the results into the per-VM checks[] for
 * the VM the app is registered on, so they appear in the failingVms counter
 * and JSON output alongside the SSH probe results.
 *
 * @param apps  All AppRecord entries from apps.json (or a per-VM slice)
 * @returns     One result per offending static-with-DB app, or empty array
 */
export function checkStaticDbDrift(apps: AppRecord[]): StaticDbDriftResult[] {
  const results: StaticDbDriftResult[] = [];

  for (const app of apps) {
    // Only check static apps — node and absent (default node) are fine.
    if (app.kind !== "static") continue;

    // Collect offending fields using the same predicate as validateStaticNoDb.
    const offending: string[] = [];

    if (app.migrateCmd !== undefined) offending.push("migrateCmd");
    if (app.dbBackend !== undefined && app.dbBackend !== "none") offending.push("dbBackend");
    if (app.previewDbBackend !== undefined && app.previewDbBackend !== "none") {
      offending.push("previewDbBackend");
    }
    if (app.databaseUrlEnv !== undefined) offending.push("databaseUrlEnv");
    if (app.envDbVars !== undefined && app.envDbVars.length > 0) offending.push("envDbVars");

    if (offending.length === 0) {
      // Clean static app with no DB fields — no finding.
      continue;
    }

    // Emit a FINDING for this app.
    results.push({
      appId: app.id,
      id: "static-db-drift",
      group: "infra-sizing",
      status: "fail",
      description:
        `app "${app.name}" is registered as kind=static but declares DB field(s) ` +
        `whose migrations NEVER run (static apps have no migrate phase in ` +
        `env-create or prod-deploy). ` +
        `Offending field(s): ${offending.join(", ")}. ` +
        `Re-register as kind=node to fold into the managed migrate flow.`,
      stdout: "",
      stderr: "",
    });
  }

  return results;
}
