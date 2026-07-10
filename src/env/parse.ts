/**
 * Phase-marker parsing for env create/destroy scripts (SPEC-DELTA §4).
 *
 * Same `<<<SAMOHOST_PHASE:...>>>` convention as app deploys (app/parse.ts) but
 * with the env phase allowlist and a simpler outcome model: env scripts have
 * no rollback — a failed create leaves the partial env in place for inspection
 * and the (idempotent) destroy script is the cleanup path.
 */

import { ENV_PHASE_PREFIX, type EnvPhaseName } from "./script.ts";

export type EnvPhaseStatus = "start" | "ok" | "fail";

export interface EnvPhaseEvent {
  phase: EnvPhaseName;
  status: EnvPhaseStatus;
}

/**
 *  - `ok`         : all observed phases completed, none failed.
 *  - `failed`     : some phase emitted `fail`.
 *  - `incomplete` : a `start` had no terminal status (connection dropped), or
 *                   no markers were seen at all.
 */
export type EnvOutcome = "ok" | "failed" | "incomplete";

const VALID_PHASES = new Set<EnvPhaseName>([
  "port-check",
  "clone",
  "install",
  "build",
  "db-preflight",
  "db",
  "envfile",
  "secrets-preflight",
  "secrets",
  "migrate",
  "unit",
  "vhost",
  "health",
  "unit-stop",
  "vhost-remove",
  "db-drop",
  "dir-remove",
]);

const MARKER_RE = new RegExp(
  ENV_PHASE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "([a-z-]+):(start|ok|fail)>>>",
  "g",
);

/** Extract the ordered env phase events from a raw output blob. */
export function parseEnvPhaseStream(raw: string): EnvPhaseEvent[] {
  const events: EnvPhaseEvent[] = [];
  for (const m of raw.matchAll(MARKER_RE)) {
    const phase = m[1] as EnvPhaseName;
    if (!VALID_PHASES.has(phase)) continue;
    events.push({ phase, status: m[2] as EnvPhaseStatus });
  }
  return events;
}

/** Derive the terminal outcome from an env phase event stream. */
export function envOutcome(events: EnvPhaseEvent[]): EnvOutcome {
  if (events.length === 0) return "incomplete";
  let pendingStart: EnvPhaseName | undefined;
  for (const ev of events) {
    if (ev.status === "start") {
      pendingStart = ev.phase;
    } else if (ev.status === "ok") {
      if (pendingStart === ev.phase) pendingStart = undefined;
    } else if (ev.status === "fail") {
      return "failed";
    }
  }
  return pendingStart === undefined ? "ok" : "incomplete";
}

/** Convenience: raw blob → events + outcome. */
export function parseEnvOutcome(raw: string): {
  events: EnvPhaseEvent[];
  outcome: EnvOutcome;
} {
  const events = parseEnvPhaseStream(raw);
  return { events, outcome: envOutcome(events) };
}
