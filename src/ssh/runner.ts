/**
 * SSH runner (SPEC-DELTA §2 — remote exec layer).
 *
 * Hardened hosts run fail2ban (bantime 86400, maxretry 3) and pin their host
 * key. Ad-hoc ssh/keyscan against such hosts is harmful: a few failed auth-layer
 * connections can ban the operator for a day. This module therefore:
 *
 *   - builds a single, fully-pinned ssh argv (ControlMaster multiplexing,
 *     per-VM known_hosts, StrictHostKeyChecking=yes);
 *   - owns per-VM host-key state under `~/.samohost/known_hosts.d/<id>`;
 *   - enforces a connection budget (≤2 attempts / rolling 600s / VM);
 *   - classifies connection failures into a typed taxonomy and NEVER retries
 *     ban/hostkey failures (retrying burns budget and worsens bans).
 *
 * Tests inject `spawn`, `clock`, and `knownHostsDir` — there is no live network
 * and no real `~/.samohost` access in the unit tests.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { VmRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Default base dir for samohost local state (`~/.samohost`). */
function samohostHome(): string {
  return join(homedir(), ".samohost");
}

/** Default per-VM known_hosts directory (`~/.samohost/known_hosts.d`). */
export function defaultKnownHostsDir(): string {
  return join(samohostHome(), "known_hosts.d");
}

/** Default ssh ControlPath directory (`~/.samohost/cm`). */
export function defaultControlDir(): string {
  return join(samohostHome(), "cm");
}

/** The per-VM known_hosts file path: `<dir>/<vm.id>`. */
export function knownHostsPathFor(vm: VmRecord, dir: string): string {
  return join(dir, vm.id);
}

// ---------------------------------------------------------------------------
// buildSshArgs — pure argv builder
// ---------------------------------------------------------------------------

export interface SshArgOpts {
  /** Per-VM known_hosts directory (default ~/.samohost/known_hosts.d). */
  knownHostsDir?: string;
  /** ssh ControlPath directory (default ~/.samohost/cm). */
  controlDir?: string;
}

/**
 * Build the exact ssh argv (everything after the `ssh` binary itself) for
 * running `command` on `vm`. Pure: no I/O, fully deterministic. The command is
 * the final, single argv element — it is NOT shell-split, so secrets embedded
 * by the caller stay in one slot (and should be avoided in argv regardless).
 */
export function buildSshArgs(
  vm: VmRecord,
  command: string,
  opts: SshArgOpts = {},
): string[] {
  const knownHostsDir = opts.knownHostsDir ?? defaultKnownHostsDir();
  const controlDir = opts.controlDir ?? defaultControlDir();
  const knownHosts = knownHostsPathFor(vm, knownHostsDir);
  const controlPath = join(controlDir, "%C");

  return [
    "-p",
    String(vm.sshPort),
    "-i",
    vm.sshKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ControlPersist=60s",
    `${vm.sshUser}@${vm.ip}`,
    command,
  ];
}

// ---------------------------------------------------------------------------
// Per-VM known_hosts management
// ---------------------------------------------------------------------------

/**
 * Ensure the per-VM known_hosts file exists with a marker comment recording the
 * out-of-band-verified fingerprint. Idempotent: if the file already exists it is
 * left untouched (so a previously recorded host-key line is never clobbered).
 * The file is chmod 600.
 *
 * Returns the file path.
 */
export function ensureKnownHosts(vm: VmRecord, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = knownHostsPathFor(vm, dir);
  if (!existsSync(path)) {
    const marker =
      `# samohost known_hosts for vm ${vm.id} (${vm.name})\n` +
      `# pinned fingerprint (out-of-band verified): ${vm.hostKeyFingerprint}\n` +
      `# host key line is appended by recordHostKey() after first verified connection\n`;
    writeFileSync(path, marker, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return path;
}

/**
 * Append a verified host key line (the literal known_hosts entry, e.g.
 * `[ip]:port ssh-ed25519 AAAA...`) to the per-VM known_hosts file. Ensures the
 * file exists first and keeps it chmod 600.
 */
export function recordHostKey(vm: VmRecord, keyLine: string, dir: string): void {
  ensureKnownHosts(vm, dir);
  const path = knownHostsPathFor(vm, dir);
  const line = keyLine.endsWith("\n") ? keyLine : keyLine + "\n";
  appendFileSync(path, line);
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// ConnectionBudget — fail2ban-safe rate limiting
// ---------------------------------------------------------------------------

export type Clock = () => number; // epoch milliseconds

/** Thrown when a VM's connection budget is exhausted within the window. */
export class BudgetExceededError extends Error {
  readonly kind = "budget-exceeded" as const;
  constructor(vmId: string, max: number, windowSec: number) {
    super(
      `connection budget exhausted for vm ${vmId}: ${max} attempts per ${windowSec}s. ` +
        `Refusing to connect again — the hardened host runs fail2ban (bantime 86400s = 24h, ` +
        `maxretry 3) and further attempts risk banning this operator IP for a full day. ` +
        `Wait for the window to slide, or verify the host/key out of band first.`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface BudgetOpts {
  clock?: Clock;
  /** Max attempts per window (default 2). */
  maxAttempts?: number;
  /** Rolling window in seconds (default 600). */
  windowSec?: number;
}

/**
 * Per-VM rolling-window connection budget. In-memory for now; the per-VM
 * timestamp arrays are the only state, so persistence (load/save the map) can be
 * layered on without changing the window logic.
 */
export class ConnectionBudget {
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly attempts = new Map<string, number[]>();

  constructor(opts: BudgetOpts = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.windowMs = (opts.windowSec ?? 600) * 1000;
  }

  /**
   * Record one connection attempt for `vmId`. Throws {@link BudgetExceededError}
   * if doing so would exceed the budget within the rolling window. On success
   * the attempt timestamp is recorded.
   */
  consume(vmId: string): void {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(vmId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxAttempts) {
      // keep the pruned list so the window keeps sliding correctly
      this.attempts.set(vmId, recent);
      throw new BudgetExceededError(
        vmId,
        this.maxAttempts,
        this.windowMs / 1000,
      );
    }
    recent.push(now);
    this.attempts.set(vmId, recent);
  }
}

// ---------------------------------------------------------------------------
// redact — strip secrets before logging
// ---------------------------------------------------------------------------

/**
 * Strip likely secrets from text before it is logged. Targets long base64-ish
 * runs (40+ chars) that follow a secret-ish label (`password`, `token`,
 * `PASSWORD=`, `secret`, `api[_-]?key`, `Authorization: Bearer`, ...). Raw
 * stdout/stderr is returned unredacted to callers; only logging goes through
 * this helper.
 */
export function redact(text: string): string {
  const LABEL =
    "(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization|bearer)";
  // label, optional separator (= : space "Bearer"), then a 40+ char secret run
  const re = new RegExp(
    `(${LABEL}\\s*[:=]?\\s*(?:Bearer\\s+)?)([A-Za-z0-9+/_=-]{40,})`,
    "gi",
  );
  return text.replace(re, (_m, prefix: string) => `${prefix}REDACTED`);
}

// ---------------------------------------------------------------------------
// runRemote — compose budget + args + spawn, classify failures
// ---------------------------------------------------------------------------

export type SshErrorKind = "banned-or-blocked" | "hostkey-mismatch";

/** Typed connection failure. Never produced for ordinary non-zero exits. */
export class SshError extends Error {
  readonly kind: SshErrorKind;
  readonly stderr: string;
  constructor(kind: SshErrorKind, message: string, stderr: string) {
    super(message);
    this.name = "SshError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable spawn: run a binary with argv, resolve with the captured result. */
export type SpawnFn = (file: string, args: string[]) => Promise<SpawnResult>;

export interface RunDeps {
  spawn: SpawnFn;
  clock: Clock;
  knownHostsDir: string;
  /** ssh ControlPath dir (defaults to knownHostsDir's sibling cm/ in prod). */
  controlDir?: string;
  /** Shared budget across calls; one is created per-call if omitted (tests
   * exercise the per-call window by reusing deps, so we key a module budget by
   * knownHostsDir to keep call sites simple). */
  budget?: ConnectionBudget;
}

const HOSTKEY_RE = /Host key verification failed/i;
const REFUSED_RE = /Connection refused/i;

// A budget per knownHostsDir keeps `runRemote(vm, cmd, deps)` ergonomic in tests
// (reusing the same deps object reuses the same budget) without forcing callers
// to thread a ConnectionBudget instance through.
const budgetsByDir = new Map<string, ConnectionBudget>();

/**
 * Run `command` on `vm` over a single pinned ssh connection. Consumes one unit
 * of connection budget, ensures the per-VM known_hosts file exists, builds the
 * argv and spawns ssh.
 *
 *  - exit 255 with stderr matching `Connection refused` → throws
 *    {@link SshError} kind `banned-or-blocked` (NOT retried).
 *  - exit 255 with stderr matching `Host key verification failed` → throws
 *    {@link SshError} kind `hostkey-mismatch` (NOT retried).
 *  - any other exit code → resolves with `{code, stdout, stderr}`.
 *
 * Budget exhaustion throws {@link BudgetExceededError} before spawning.
 */
export async function runRemote(
  vm: VmRecord,
  command: string,
  deps: RunDeps,
): Promise<SpawnResult> {
  const budget =
    deps.budget ??
    budgetsByDir.get(deps.knownHostsDir) ??
    (() => {
      const b = new ConnectionBudget({ clock: deps.clock });
      budgetsByDir.set(deps.knownHostsDir, b);
      return b;
    })();

  // Budget first — refuse before we ever touch the network.
  budget.consume(vm.id);

  ensureKnownHosts(vm, deps.knownHostsDir);

  const controlDir = deps.controlDir ?? join(dirname(deps.knownHostsDir), "cm");
  const args = buildSshArgs(vm, command, {
    knownHostsDir: deps.knownHostsDir,
    controlDir,
  });

  const res = await deps.spawn("ssh", args);

  if (res.code === 255) {
    if (HOSTKEY_RE.test(res.stderr)) {
      throw new SshError(
        "hostkey-mismatch",
        `host key verification failed for vm ${vm.id} — the pinned key did not ` +
          `match. Not retrying. Verify the host key out of band before reconnecting.`,
        res.stderr,
      );
    }
    if (REFUSED_RE.test(res.stderr)) {
      throw new SshError(
        "banned-or-blocked",
        `connection refused for vm ${vm.id} — the operator may be fail2ban-banned ` +
          `(bantime 86400s) or the port is blocked. Not retrying (retries burn ` +
          `budget and worsen bans).`,
        res.stderr,
      );
    }
    // Some other 255 (e.g. generic ssh error) — surface as banned-or-blocked is
    // wrong; treat as a plain failure result so callers can inspect stderr.
  }

  return { code: res.code, stdout: res.stdout, stderr: res.stderr };
}
