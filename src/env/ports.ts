/**
 * Per-VM port-pool allocation for preview environments (SPEC-DELTA §4
 * "dedicated port from a recorded pool").
 *
 * The pool is a contiguous range reserved for envs on one VM, kept clear of
 * the production app's port (field-record production listens at 3000) AND of
 * the shared CI runner's Playwright webServer port (3100 — see
 * `src/ci/runner-hook.ts`). The default env pool therefore starts at 3101 so a
 * preview env can never land on the CI port (a latent prod/CI/preview
 * collision). Allocation is deterministic: lowest free port wins, so plans are
 * reproducible and state diffs stay readable.
 */

export interface PortPool {
  /** First port in the pool (inclusive). */
  base: number;
  /** Number of ports in the pool. */
  size: number;
}

/**
 * Default pool: 3101..3199 (production stays below at 3000; the shared CI
 * runner's Playwright webServer port 3100 is excluded — it must never be
 * handed to a preview env).
 */
export const DEFAULT_POOL: PortPool = { base: 3101, size: 99 };

/**
 * Lowest free port in the pool given the ports already in use on the VM.
 * Returns undefined when the pool is exhausted (caller surfaces the error —
 * 100 simultaneous previews on one tiny VM is a signal, not a use case).
 */
export function allocatePort(
  used: readonly number[],
  pool: PortPool = DEFAULT_POOL,
): number | undefined {
  const taken = new Set(used);
  for (let p = pool.base; p < pool.base + pool.size; p++) {
    if (!taken.has(p)) return p;
  }
  return undefined;
}
