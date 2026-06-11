/**
 * Lifecycle state machine (SPEC §5).
 *
 *   planned ─create→ creating ─api ok→ booting ─cloud-init ok→ ready
 *   creating ─api fail→ failed (no resource)
 *   booting  ─timeout/err→ degraded (resource exists, reclaimable)
 *   ready/degraded/failed/adopted ─destroy→ destroying → destroyed
 *
 * Orphan-safety (SPEC §2 failure handling): `creating` and `booting` may also
 * transition to `destroying` — a record stuck there after a crash can still own
 * a live provider resource, and `destroy` must always be able to reclaim it.
 *
 * Every command that persists a `lifecycleState` change goes through
 * {@link assertTransition} first, so an illegal move is a programming error
 * surfaced loudly instead of silently corrupting state.
 */

import type { LifecycleState } from "../types.ts";

/** The complete set of legal transitions. Anything absent is illegal. */
export const LIFECYCLE_TRANSITIONS: ReadonlyArray<
  readonly [LifecycleState, LifecycleState]
> = [
  ["planned", "creating"],
  ["creating", "booting"],
  ["creating", "failed"],
  ["booting", "ready"],
  ["booting", "degraded"],
  ["ready", "destroying"],
  ["adopted", "destroying"],
  ["degraded", "destroying"],
  ["failed", "destroying"],
  ["creating", "destroying"],
  ["booting", "destroying"],
  ["destroying", "destroyed"],
] as const;

const TABLE = new Set(LIFECYCLE_TRANSITIONS.map(([f, t]) => `${f}->${t}`));

/** True iff `from → to` is a legal lifecycle transition. */
export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return TABLE.has(`${from}->${to}`);
}

/** Raised on an illegal transition attempt. Carries `from`/`to` for callers. */
export class IllegalTransitionError extends Error {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  constructor(from: LifecycleState, to: LifecycleState) {
    super(
      `illegal lifecycle transition: ${from} → ${to}. ` +
        `Legal moves from '${from}': ` +
        (legalFrom(from).join(", ") || "(none — terminal state)"),
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

function legalFrom(from: LifecycleState): LifecycleState[] {
  return LIFECYCLE_TRANSITIONS.filter(([f]) => f === from).map(([, t]) => t);
}

/** Throw {@link IllegalTransitionError} unless `from → to` is legal. */
export function assertTransition(
  from: LifecycleState,
  to: LifecycleState,
): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
