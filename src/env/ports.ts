/**
 * Per-VM port-pool allocation for preview environments (SPEC-DELTA §4
 * "dedicated port from a recorded pool").
 *
 * The pool is a contiguous range reserved for envs on one VM, kept clear of
 * the production app's port (field-record production listens at 3000; the
 * default env pool starts at 3100). Allocation is deterministic: lowest free
 * port wins, so plans are reproducible and state diffs stay readable.
 */

export interface PortPool {
  /** First port in the pool (inclusive). */
  base: number;
  /** Number of ports in the pool. */
  size: number;
}

/** Default pool: 3100..3199 (production stays below at 3000). */
export const DEFAULT_POOL: PortPool = { base: 3100, size: 100 };

/**
 * Lowest free port in the pool given the ports already in use on the VM.
 * Returns undefined when the pool is exhausted (caller surfaces the error —
 * 100 simultaneous previews on one tiny VM is a signal, not a use case).
 *
 * PURE: `used` is the union of (a) ports recorded in the env store AND (b)
 * ports a caller has probed as LIVE-BOUND on the target host (see
 * {@link parseListeningPorts}). Keeping the OS probe out of this function lets
 * unit tests stay offline — the caller injects the in-use snapshot.
 *
 * Skipping live-bound ports is the reliability complement to #71's
 * fail-closed: #71 stops a preview from silently serving a foreign squatter
 * (the port goes dark); this stops the preview from ever landing on a squatted
 * port in the first place, so it just uses the next free one. #71 remains the
 * backstop for a port that gets bound in the race between probe and bind.
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

/**
 * Parse `ss -ltnH` output into the set of locally-bound TCP listen ports.
 *
 * `ss -ltnH` prints one listener per line; `-H` omits the header. Columns:
 *   State  Recv-Q  Send-Q  Local-Address:Port  Peer-Address:Port  [Process]
 *
 * We read the port from the LOCAL-ADDRESS column only (column 4) — never the
 * peer column — matching exactly the local-address forms #71's port-check
 * greps for, so allocation skips precisely what the on-host check would fail
 * on (EADDRINUSE class):
 *   IPv4 wildcard/loopback: 0.0.0.0:PORT, 127.0.0.1:PORT
 *   IPv6 wildcard/loopback: [::]:PORT, [::1]:PORT
 *   bare wildcard:          *:PORT
 *
 * PURE: no I/O — the caller runs the probe and passes the captured stdout.
 */
export function parseListeningPorts(ssOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const rawLine of ssOutput.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    // Local-Address:Port is the 4th whitespace-separated column. Reading only
    // this column avoids mistaking a peer address (e.g. an established peer at
    // 1.2.3.4:3100) for a local listen port.
    const cols = line.split(/\s+/);
    const local = cols[3];
    if (local === undefined) continue;
    // The port is the final `:NNN` segment of the local address. For [::]:3102
    // / [::1]:3102 this still takes the trailing :3102 (the IPv6 host part is
    // bracketed, so the last colon is the port separator).
    const m = local.match(/:(\d+)$/);
    if (m === null) continue;
    const port = Number(m[1]);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}
