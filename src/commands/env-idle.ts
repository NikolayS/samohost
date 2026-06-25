/**
 * src/commands/env-idle.ts — Atomic idle autodestroy for preview envs.
 *
 * Design:
 *
 * TRIGGER SOURCE — Caddy JSON access log
 *   The env-create script writes a per-vhost Caddy `log { output file
 *   /var/log/caddy/<name>.log  format json }` block.  Each line is a JSON
 *   object containing `"ts"` (Unix epoch float) and `"request.host"`.  The
 *   trigger GC pass reads the file's mtime (or scans max-ts) via
 *   `readAccessLogMaxTs()` injected into `EnvIdleGcDeps`, then stamps
 *   EnvRecord.lastAccess.
 *
 * IDLENESS — lastAccess not createdAt
 *   idle = now - lastAccess  (falls back to createdAt when lastAccess absent)
 *   createdAt is stamped ONCE at create time and never changes — using it as
 *   the idle signal would destroy busy envs that have been alive >threshold.
 *
 * WARN-ONLY FIRST (operator-prereq-or-degraded-gate rule)
 *   `idleReap: false` → logs what WOULD be reaped, touches nothing.
 *   `idleReap: true`  → calls the injected `destroyEnv` (= `runEnvDestroy`)
 *   for each over-threshold env.
 *
 * CONFIGURE
 *   `SAMOHOST_IDLE_THRESHOLD_MS` env var (ms).
 *   Default: IDLE_THRESHOLD_DEFAULT_MS = 14 days.
 *
 * DBLab maxIdleMinutes note
 *   The DBLab server.yml `maxIdleMinutes` clone-expiry reaper fights with
 *   this teardown: if DBLab expires a clone first, samohost's destroy phase
 *   fails at the dblab CLI step. Operators should either:
 *     (a) set `maxIdleMinutes` >= SAMOHOST_IDLE_THRESHOLD_MS / 60000 + 30
 *         (give samohost time to destroy cleanly before DBLab beats it), OR
 *     (b) set `maxIdleMinutes: 0` to disable DBLab's own idle reaper entirely
 *         and let samohost own the lifecycle.
 *   The destroy script already tolerates a missing clone (`|| true`), so a
 *   DBLab-expired clone does not block host-side cleanup — it is safe to set
 *   `maxIdleMinutes` to 0 or to a value larger than the samohost threshold.
 */

import type { EnvRecord } from "../types.ts";
import type { EnvStore } from "../state/envs.ts";
import type { StateStore } from "../state/store.ts";
import type { AppStore } from "../state/apps.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default idle threshold: 14 days. Override via SAMOHOST_IDLE_THRESHOLD_MS. */
export const IDLE_THRESHOLD_DEFAULT_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnvIdleGcInput {
  /** VM name or id. */
  vm: string;
  /**
   * Idle threshold in ms. An env is a candidate when:
   *   (now - lastAccess) >= idleThresholdMs   (or createdAt when lastAccess absent)
   */
  idleThresholdMs: number;
  /**
   * WARN-ONLY first (operator-prereq-or-degraded-gate rule):
   *   false → dry-run: log what would be reaped, destroy NOTHING.
   *   true  → actually call destroyEnv for each over-threshold candidate.
   */
  idleReap: boolean;
  /** Injected clock (tests use a fixed Date). */
  now: () => Date;
}

export interface IdleGcCandidate {
  name: string;
  vmId: string;
  appName: string;
  branch: string;
  idleMs: number;
}

export interface IdleGcReport {
  vm: string;
  dryRun: boolean;
  candidates: IdleGcCandidate[];
  reaped: string[];
  failed: Array<{ name: string; error: string }>;
  kept: number;
}

/**
 * The injected destroy function: matches the shape of a curried runEnvDestroy
 * (vm by id/name, app name, branch → exit code). Returns 0 on success, non-0
 * on failure. Tests inject a fake; production injects the real runEnvDestroy.
 */
export type DestroyEnvFn = (
  vmId: string,
  appName: string,
  branch: string,
) => Promise<number>;

// ---------------------------------------------------------------------------
// stampLastAccess
// ---------------------------------------------------------------------------

/**
 * Update EnvRecord.lastAccess to `ts` for the env identified by
 * (vmId, appName, branch). No-op when the env is not in the store.
 *
 * Called by the trigger GC pass after reading the per-vhost access log.
 */
export function stampLastAccess(
  envStore: EnvStore,
  vmId: string,
  appName: string,
  branch: string,
  ts: string,
): void {
  const rec = envStore.get(vmId, appName, branch);
  if (rec === undefined) return;
  envStore.upsert({ ...rec, lastAccess: ts });
}

// ---------------------------------------------------------------------------
// idleSinceMs — pure helper
// ---------------------------------------------------------------------------

/**
 * How many ms has an env been idle, relative to `now`?
 *
 * Uses lastAccess when present; falls back to createdAt so a brand-new env
 * without any access yet is treated as "last accessed at create time" and is
 * not immediately a candidate.
 */
export function idleSinceMs(env: EnvRecord, now: Date): number {
  const anchor = env.lastAccess ?? env.createdAt;
  const anchorMs = new Date(anchor).getTime();
  if (Number.isNaN(anchorMs)) return 0;
  return Math.max(0, now.getTime() - anchorMs);
}

// ---------------------------------------------------------------------------
// runEnvIdleGc
// ---------------------------------------------------------------------------

/**
 * One GC cycle: scan all envs on the target VM, identify those idle >
 * threshold (from lastAccess, falling back to createdAt), and either warn
 * (idleReap: false) or atomically destroy (idleReap: true) each one via the
 * injected destroyEnv.
 *
 * Per-env isolation: one destroy failure never aborts the rest of the cycle.
 */
export async function runEnvIdleGc(
  input: EnvIdleGcInput,
  vmStore: StateStore,
  _appStore: AppStore,
  envStore: EnvStore,
  destroyEnv: DestroyEnvFn,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<IdleGcReport> {
  // Resolve VM
  const allVms = vmStore.list();
  const vm = allVms.find((v) => v.id === input.vm || v.name === input.vm);
  const vmLabel = vm?.name ?? input.vm;
  const vmId = vm?.id ?? input.vm;

  const now = input.now();
  const envs = envStore.listFor(vmId);

  const candidates: IdleGcCandidate[] = [];
  const reaped: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  let kept = 0;

  for (const env of envs) {
    const idle = idleSinceMs(env, now);

    if (idle < input.idleThresholdMs) {
      kept++;
      continue;
    }

    const candidate: IdleGcCandidate = {
      name: env.name,
      vmId: env.vmId,
      appName: env.appName,
      branch: env.branch,
      idleMs: idle,
    };
    candidates.push(candidate);

    if (!input.idleReap) {
      // WARN-ONLY: log what would be reaped, touch nothing.
      const idleMinutes = Math.round(idle / 60_000);
      out(
        `samohost: idle-gc [warn-only] would reap ${env.name} — idle ${idleMinutes}min > threshold ${Math.round(input.idleThresholdMs / 60_000)}min`,
      );
      continue;
    }

    // REAP: call the injected destroyEnv (= runEnvDestroy in production).
    try {
      const exitCode = await destroyEnv(env.vmId, env.appName, env.branch);
      if (exitCode === 0) {
        reaped.push(env.name);
        out(`samohost: idle-gc reaped ${env.name} (idle ${Math.round(idle / 60_000)}min)`);
      } else {
        failed.push({ name: env.name, error: `destroyEnv exit ${exitCode}` });
        err(
          `samohost: idle-gc: destroy failed for ${env.name} (exit ${exitCode}) — keeping`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ name: env.name, error: msg });
      err(`samohost: idle-gc: destroy threw for ${env.name}: ${msg} — keeping`);
    }
  }

  return {
    vm: vmLabel,
    dryRun: !input.idleReap,
    candidates,
    reaped,
    failed,
    kept,
  };
}

// ---------------------------------------------------------------------------
// Caddy JSON access log parsing
// ---------------------------------------------------------------------------

/**
 * Caddy JSON access log line shape (format json).
 *
 * Real log line (captured from Caddy v2, verified on the field-record-1 VM):
 *   {"level":"info","ts":1750694400.123,"logger":"http.log.access.log0",
 *    "msg":"handled request","request":{"remote_ip":"1.2.3.4","remote_port":"55000",
 *    "proto":"HTTP/1.1","method":"GET","host":"field-record-1-feat-idle.samo.cat",
 *    "uri":"/","headers":{},"tls":{}},"bytes_read":0,"user_id":"",
 *    "duration":0.002,"size":0,"status":200,"resp_headers":{}}
 *
 * Only `ts` (Unix epoch float, seconds.fraction) is load-bearing for
 * idle detection. `request.host` allows future per-vhost filtering if
 * multiple envs ever share one log file (currently each env has its own).
 */
interface CaddyLogLine {
  ts?: number;
  [key: string]: unknown;
}

/**
 * Parse the text content of a Caddy JSON access log (one JSON object per
 * line) and return the maximum `ts` value (Unix epoch float, seconds).
 *
 * Returns `null` when:
 *   - The content is empty.
 *   - No line has a valid numeric `ts` field.
 *
 * Tolerates:
 *   - Trailing newlines (Caddy appends \n per line).
 *   - Malformed or non-JSON lines (skipped silently — e.g. Caddy startup).
 *   - Lines without a `ts` field (skipped).
 *
 * This is a PURE function — no I/O. It operates on the string content already
 * fetched from the remote host by the caller.
 */
export function parseAccessLogMaxTs(content: string): number | null {
  if (content.length === 0) return null;

  let maxTs: number | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: CaddyLogLine;
    try {
      parsed = JSON.parse(line) as CaddyLogLine;
    } catch {
      // Malformed line — skip silently.
      continue;
    }

    const ts = parsed.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (maxTs === null || ts > maxTs) {
      maxTs = ts;
    }
  }

  return maxTs;
}

// ---------------------------------------------------------------------------
// EnvIdleGcDeps — injectable dependencies for readAccessLogMaxTs
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for `readAccessLogMaxTs`.
 *
 * In production this wraps the pinned SSH runner (same as `runRemote` in
 * env.ts). In tests a deterministic fake is injected — no SSH, no network.
 *
 * `readRemoteLog(logPath)` reads the file at `logPath` on the remote VM via
 * the pinned SSH runner and returns its full text content, or throws on
 * connection failure / permission denied.
 */
export interface EnvIdleGcDeps {
  readRemoteLog: (logPath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// readAccessLogMaxTs — SSH-based reader (uses injected deps)
// ---------------------------------------------------------------------------

/** Log directory for Caddy access logs (per-vhost JSON files). */
export const CADDY_LOG_DIR = "/var/log/caddy";

/**
 * Compute the path of the per-env Caddy access log on the remote host.
 * Matches the path written by `buildEnvCreateScript` (env/script.ts):
 *   output file /var/log/caddy/<name>.log
 */
export function caddyLogPathFor(envName: string): string {
  return `${CADDY_LOG_DIR}/${envName}.log`;
}

/**
 * Read the per-vhost Caddy JSON access log from the remote VM (via the
 * injected `deps.readRemoteLog`), parse the max `ts` value, and return it
 * as a Unix epoch float (seconds).
 *
 * Returns `null` when:
 *   - The log file does not exist (env not yet served any traffic).
 *   - The file is empty (no requests yet).
 *   - `deps.readRemoteLog` throws (SSH error, connection refused, permission
 *     denied) — fail-open: the GC pass falls back to `createdAt`.
 *
 * NOTE: This function swallows all errors from `readRemoteLog` by design.
 * The idle-GC pass must NEVER abort because it cannot reach one VM's log;
 * it falls back to `createdAt` for that env and continues.
 */
export async function readAccessLogMaxTs(
  envName: string,
  deps: EnvIdleGcDeps,
): Promise<number | null> {
  const logPath = caddyLogPathFor(envName);
  let content: string;
  try {
    content = await deps.readRemoteLog(logPath);
  } catch {
    // SSH failure, file-not-found, etc. — fall back gracefully.
    return null;
  }
  return parseAccessLogMaxTs(content);
}

// ---------------------------------------------------------------------------
// Production wiring helpers
// ---------------------------------------------------------------------------

/**
 * Read the SAMOHOST_IDLE_THRESHOLD_MS env var, falling back to
 * IDLE_THRESHOLD_DEFAULT_MS (14 days).
 */
export function readIdleThresholdMs(): number {
  const raw = process.env["SAMOHOST_IDLE_THRESHOLD_MS"];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return IDLE_THRESHOLD_DEFAULT_MS;
}

/**
 * Read the SAMOHOST_IDLE_REAP env var to determine whether reaping is enabled.
 * Default: false (warn-only) — operator must opt in via `SAMOHOST_IDLE_REAP=1`.
 */
export function readIdleReap(): boolean {
  const v = process.env["SAMOHOST_IDLE_REAP"];
  return v === "1" || v === "true";
}
