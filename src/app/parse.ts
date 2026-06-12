/**
 * Phase-marker stream parser (SPEC-DELTA §3 "app module").
 *
 * The remote deploy script (see `./script.ts`) emits markers of the form
 *
 *     <<<SAMOHOST_PHASE:<name>:(start|ok|fail)>>>
 *
 * interleaved with ordinary build/log output. This module extracts the marker
 * events from a (possibly garbage-interleaved) stdout/stderr blob and derives a
 * single terminal outcome for the deploy.
 */

import { PHASE_PREFIX, type PhaseName } from "./script.ts";

export type PhaseStatus = "start" | "ok" | "fail";

export interface PhaseEvent {
  phase: PhaseName;
  status: PhaseStatus;
}

/**
 * Terminal outcome of a deploy run, derived from the phase event stream:
 *  - `deployed`        : reached a terminal phase with no failure and no rollback.
 *  - `rolled-back`     : a phase failed and `rollback:ok` was seen.
 *  - `rollback-failed` : a phase failed and `rollback:fail` was seen.
 *  - `incomplete`      : a phase failed with no rollback marker, OR the stream
 *                        ended mid-phase (a `start` with no matching `ok`/`fail`
 *                        and no rollback) — i.e. the connection dropped.
 */
export type DeployOutcome =
  | "deployed"
  | "rolled-back"
  | "rollback-failed"
  | "incomplete";

// Global marker regex. Phase names are a fixed allowlist; anything else is
// treated as noise (so a literal `<<<SAMOHOST_PHASE:bogus:ok>>>` in log text is
// ignored rather than mis-parsed).
const VALID_PHASES = new Set<PhaseName>([
  "fetch",
  "checkpoint",
  "checkout",
  "install",
  "build",
  "migrate",
  "restart",
  "health",
  "assert-rls",
  "seed",
  "rollback",
]);

const MARKER_RE = new RegExp(
  // PHASE_PREFIX is a literal; escape its regex-special chars.
  escapeRegExp(PHASE_PREFIX) + "([a-z-]+):(start|ok|fail)>>>",
  "g",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the ordered list of phase events from a raw output blob. */
export function parsePhaseStream(raw: string): PhaseEvent[] {
  const events: PhaseEvent[] = [];
  for (const m of raw.matchAll(MARKER_RE)) {
    const phase = m[1] as PhaseName;
    const status = m[2] as PhaseStatus;
    if (!VALID_PHASES.has(phase)) continue; // ignore unknown phase names
    events.push({ phase, status });
  }
  return events;
}

/** Derive the terminal outcome from a parsed (or raw) event stream. */
export function deployOutcome(events: PhaseEvent[]): DeployOutcome {
  let pendingStart: PhaseName | undefined;
  let sawFailure = false;

  for (const ev of events) {
    if (ev.phase === "rollback") {
      if (ev.status === "ok") return "rolled-back";
      if (ev.status === "fail") return "rollback-failed";
      continue;
    }
    if (ev.status === "start") {
      pendingStart = ev.phase;
    } else if (ev.status === "ok") {
      if (pendingStart === ev.phase) pendingStart = undefined;
    } else if (ev.status === "fail") {
      sawFailure = true;
      pendingStart = undefined;
    }
  }

  // A failure with no rollback:ok/fail seen ⇒ the rollback path didn't complete.
  if (sawFailure) return "incomplete";
  // A start with no matching terminal status ⇒ stream cut off mid-phase.
  if (pendingStart !== undefined) return "incomplete";
  return "deployed";
}

/** Convenience: parse a raw blob straight to its terminal outcome. */
export function parseDeployOutcome(raw: string): {
  events: PhaseEvent[];
  outcome: DeployOutcome;
} {
  const events = parsePhaseStream(raw);
  return { events, outcome: deployOutcome(events) };
}
