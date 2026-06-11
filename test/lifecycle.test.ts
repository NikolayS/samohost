/**
 * Lifecycle state machine — table-driven transition tests (SPEC §5/§6).
 *
 * Written BEFORE the orchestrator (TDD). The machine under test lives in
 * src/orchestrator/lifecycle.ts and is the single authority every command uses
 * before persisting a state change:
 *
 *   planned ─create→ creating ─api ok→ booting ─cloud-init ok→ ready
 *   creating ─api fail→ failed (no resource)
 *   booting  ─timeout/err→ degraded (resource exists, reclaimable)
 *   ready/degraded/failed/adopted ─destroy→ destroying → destroyed
 *
 * Orphan-safety addition (SPEC §2 failure handling): a record stuck in
 * `creating` or `booting` after a crash STILL owns a possibly-live provider
 * resource, so `destroy` must be legal from those states too — otherwise a
 * crashed provision could never be reclaimed.
 */

import { describe, expect, test } from "bun:test";
import type { LifecycleState } from "../src/types.ts";
import {
  canTransition,
  assertTransition,
  IllegalTransitionError,
  LIFECYCLE_TRANSITIONS,
} from "../src/orchestrator/lifecycle.ts";

const ALL_STATES: LifecycleState[] = [
  "planned",
  "creating",
  "booting",
  "ready",
  "adopted",
  "degraded",
  "failed",
  "destroying",
  "destroyed",
];

const LEGAL: Array<[LifecycleState, LifecycleState, string]> = [
  ["planned", "creating", "create requested"],
  ["creating", "booting", "provider API accepted"],
  ["creating", "failed", "provider API rejected (no resource)"],
  ["booting", "ready", "cloud-init completion confirmed"],
  ["booting", "degraded", "readiness timeout — resource exists, reclaimable"],
  ["ready", "destroying", "destroy"],
  ["adopted", "destroying", "destroy (SPEC-DELTA §1)"],
  ["degraded", "destroying", "destroy reclaims a degraded VM"],
  ["failed", "destroying", "destroy clears a failed record"],
  ["creating", "destroying", "crash reclaim: API may have accepted before death"],
  ["booting", "destroying", "crash reclaim: resource exists"],
  ["destroying", "destroyed", "provider delete confirmed"],
];

describe("lifecycle transition table", () => {
  test("every legal transition is allowed", () => {
    for (const [from, to, why] of LEGAL) {
      expect(canTransition(from, to)).toBe(true);
      // assertTransition must not throw for legal moves.
      expect(() => assertTransition(from, to)).not.toThrow();
      expect(why.length).toBeGreaterThan(0);
    }
  });

  test("the exported table matches the legal set exactly", () => {
    const exported = new Set(
      LIFECYCLE_TRANSITIONS.map(([f, t]) => `${f}->${t}`),
    );
    const expected = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    expect(exported).toEqual(expected);
  });

  test("everything not in the table is illegal", () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const key = `${from}->${to}`;
        expect(canTransition(from, to)).toBe(legal.has(key));
      }
    }
  });

  const ILLEGAL_SAMPLES: Array<[LifecycleState, LifecycleState, string]> = [
    ["planned", "ready", "cannot skip create+boot"],
    ["planned", "booting", "cannot skip the provider create call"],
    ["creating", "ready", "cannot skip the boot gate"],
    ["ready", "creating", "no re-provision of a live VM (cattle: destroy+recreate)"],
    ["ready", "ready", "self-transition is not a transition"],
    ["failed", "booting", "a failed create owns no resource to boot"],
    ["degraded", "ready", "v0.1 has no repair path — destroy and re-provision"],
    ["destroyed", "destroying", "destroyed is terminal"],
    ["destroyed", "creating", "destroyed is terminal"],
    ["destroying", "ready", "destroy is one-way"],
    ["adopted", "booting", "adopted VMs never go through provision stages"],
  ];

  test("assertTransition throws IllegalTransitionError with from/to in message", () => {
    for (const [from, to] of ILLEGAL_SAMPLES) {
      expect(canTransition(from, to)).toBe(false);
      try {
        assertTransition(from, to);
        throw new Error(`expected assertTransition(${from}, ${to}) to throw`);
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalTransitionError);
        const err = e as IllegalTransitionError;
        expect(err.from).toBe(from);
        expect(err.to).toBe(to);
        expect(err.message).toContain(from);
        expect(err.message).toContain(to);
      }
    }
  });
});
