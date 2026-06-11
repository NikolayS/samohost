/**
 * `samohost adopt` (SPEC-DELTA §1).
 *
 * Register an EXISTING, already-hardened VM into local state with NO provider
 * API call and NO SSH at adopt time. Host-key pinning is mandatory: the operator
 * must supply an out-of-band-verified `--host-key-fingerprint`; without it we
 * refuse to adopt, because all later SSH pins this key
 * (`StrictHostKeyChecking=yes`) and an unpinned host invites a host-key MITM.
 *
 * The written record gets `lifecycleState: "adopted"` (behaves like `ready`).
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { Provider, VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";
import {
  defaultKnownHostsDir,
  knownHostsPathFor,
  recordHostKey,
  type SpawnFn,
} from "../ssh/runner.ts";
import { spawnSync } from "node:child_process";

/**
 * Effects needed to plant the verified host key at adopt time. Injected so the
 * flow is unit-tested offline (no real ssh-keyscan / network).
 *
 *  - `spawn`: the same spawn abstraction the ssh runner uses; adopt invokes
 *    `ssh-keyscan -p <port> <host>` through it.
 *  - `knownHostsDir`: per-VM known_hosts directory the key line is written into.
 */
export interface AdoptHostKeyDeps {
  spawn: SpawnFn;
  knownHostsDir: string;
}

/** Normalized adopt input (produced by the CLI parser). */
export interface AdoptInput {
  name: string;
  ip: string;
  sshPort: number;
  sshUser: string;
  /** Path to the *private* key (may contain a leading ~). */
  sshKey: string;
  /** `SHA256:<43 base64 chars>` — out-of-band verified, mandatory. */
  hostKeyFingerprint: string;
  provider?: Provider;
  providerId?: string;
  region?: string;
  type?: string;
}

const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Expand a leading `~` / `~/` to the operator's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/** Validate adopt input. Returns a list of human-readable errors (empty == ok). */
export function validateAdopt(input: AdoptInput): string[] {
  const errors: string[] = [];

  if (isIP(input.ip) === 0) {
    errors.push(`invalid --ip: ${input.ip} (must be a valid IPv4 or IPv6 address)`);
  }
  if (
    !Number.isInteger(input.sshPort) ||
    input.sshPort < 1 ||
    input.sshPort > 65535
  ) {
    errors.push(`invalid --ssh-port: ${input.sshPort} (must be 1-65535)`);
  }
  if (!FINGERPRINT_RE.test(input.hostKeyFingerprint)) {
    errors.push(
      `invalid --host-key-fingerprint: ${input.hostKeyFingerprint} ` +
        `(expected SHA256:<43 base64 chars>, e.g. the output of ` +
        `\`ssh-keyscan -p <port> <ip> | ssh-keygen -lf -\`)`,
    );
  }
  return errors;
}

/**
 * Run adopt. Validates, expands the key path (existence check only — the file is
 * never read; a missing file is a warning, not an error), writes the record via
 * the store with a fresh uuid, and prints it (line or `--json`). No network I/O.
 */
export async function runAdopt(
  input: AdoptInput,
  opts: { json: boolean },
  store: StateStore,
  out: (s: string) => void,
  err: (s: string) => void,
  hostKeyDeps?: AdoptHostKeyDeps,
): Promise<number> {
  const errors = validateAdopt(input);
  if (errors.length > 0) {
    for (const e of errors) err(`error: ${e}`);
    return 1;
  }

  const sshKeyPath = expandTilde(input.sshKey);
  if (!existsSync(sshKeyPath)) {
    err(
      `warning: ssh key file not found: ${sshKeyPath} ` +
        `(adopt does not read it; ensure it exists before \`samohost ssh\`)`,
    );
  }

  const now = new Date().toISOString();
  const record: VmRecord = {
    id: crypto.randomUUID(),
    provider: input.provider ?? "hetzner",
    providerId: input.providerId ?? "",
    name: input.name,
    ip: input.ip,
    sshKeyPath,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    hostKeyFingerprint: input.hostKeyFingerprint,
    region: input.region ?? "",
    type: input.type ?? "",
    modules: [],
    lifecycleState: "adopted",
    createdAt: now,
    updatedAt: now,
  };

  // Plant the verified host key BEFORE persisting the record, so a fingerprint
  // mismatch (a possible MITM) aborts adopt without recording anything — the
  // trust decision and the known_hosts write stay atomic. Skipped only when no
  // deps are injected (pure offline unit tests that don't exercise this path).
  if (hostKeyDeps) {
    try {
      await plantVerifiedHostKey(record, record.hostKeyFingerprint, hostKeyDeps);
    } catch (e) {
      if (e instanceof HostKeyMismatchError) {
        err(`error: ${e.message}`);
        err(`  expected (out-of-band verified): ${e.expected}`);
        err(`  observed (ssh-keyscan, all keys): ${e.scanned}`);
        err(
          `Refusing to adopt: the live host key does not match the verified ` +
            `fingerprint. Nothing was recorded. Re-verify the host out of band.`,
        );
      } else {
        err(`error: host key plant failed: ${(e as Error).message}`);
      }
      return 1;
    }
  }

  const saved = store.upsert(record);

  if (opts.json) {
    out(JSON.stringify(saved, null, 2));
  } else {
    out(
      `adopted ${saved.name}  ${saved.sshUser}@${saved.ip}:${saved.sshPort}  ` +
        `[${saved.lifecycleState}]  id=${saved.id}`,
    );
  }
  return 0;
}

/**
 * Raised when NONE of the scanned host keys match the verified fingerprint.
 *
 * `scanned` is a human-readable, typed summary of every observed key (e.g.
 * `ssh-rsa SHA256:..., ssh-ed25519 SHA256:...`) so the operator can see exactly
 * what the host offered versus what they pinned.
 */
export class HostKeyMismatchError extends Error {
  readonly expected: string;
  /** Typed summary of all observed fingerprints (for operator diagnostics). */
  readonly scanned: string;
  constructor(expected: string, scanned: string) {
    super(
      `host key fingerprint mismatch (possible MITM): none of the scanned host ` +
        `keys match the out-of-band-verified fingerprint`,
    );
    this.name = "HostKeyMismatchError";
    this.expected = expected;
    this.scanned = scanned;
  }
}

/**
 * Extract EVERY host-key line from `ssh-keyscan` stdout. Unrestricted
 * `ssh-keyscan -p <port> <host>` emits one entry per host key type (ssh-rsa,
 * ssh-ed25519, ecdsa-...), typically ssh-rsa first, interleaved with banner
 * comments (`# host:port SSH-2.0-...`) and blank lines. We must consider ALL of
 * them: the operator may have pinned the fingerprint of ANY one type, so taking
 * only the first line wrongly refuses a genuine host pinned by, e.g., ed25519.
 */
export function parseScannedKeyLines(stdout: string): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    lines.push(line);
  }
  if (lines.length === 0) {
    throw new Error("ssh-keyscan returned no host key line");
  }
  return lines;
}

/**
 * Back-compat single-line accessor: the FIRST real host-key entry. Retained for
 * callers/tests that only need one line; the adopt flow uses
 * {@link parseScannedKeyLines} and matches the pinned fingerprint among ALL of
 * them.
 */
export function parseScannedKeyLine(stdout: string): string {
  return parseScannedKeyLines(stdout)[0]!;
}

/** The key-type field of a known_hosts line (e.g. `ssh-ed25519`), or `?`. */
function keyTypeOfLine(keyLine: string): string {
  const fields = keyLine.trim().split(/\s+/);
  // `<host> <keytype> <blob>` → keytype is the second-to-last field.
  return fields.length >= 2 ? (fields[fields.length - 2] ?? "?") : "?";
}

/**
 * Compute the SHA256 fingerprint of a known_hosts key line, in the exact form
 * `ssh-keygen -lf` prints (`SHA256:<base64, unpadded>`). The fingerprint is the
 * SHA256 of the raw (base64-decoded) key blob — the last whitespace field of
 * the line. Pure: no spawn, deterministic, unit-testable without network.
 */
export function fingerprintOfKeyLine(keyLine: string): string {
  const fields = keyLine.trim().split(/\s+/);
  const blob = fields[fields.length - 1];
  if (blob === undefined || blob.length === 0) {
    throw new Error(`malformed host key line: ${keyLine}`);
  }
  const raw = Buffer.from(blob, "base64");
  if (raw.length === 0) {
    throw new Error(`host key blob is not valid base64: ${keyLine}`);
  }
  const digest = createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/**
 * Scan the host key over the network (via the injected spawn → `ssh-keyscan`),
 * confirm it matches the out-of-band-verified `expectedFingerprint`, and on a
 * match append the exact key line to the per-VM known_hosts file via
 * recordHostKey(). Idempotent: if the line is already present it is not
 * appended again. Throws {@link HostKeyMismatchError} on mismatch (nothing is
 * recorded).
 *
 * This is the wiring NikolayS/samohost#4 is about: without it the per-VM
 * known_hosts file only holds a marker comment and the first real SSH connect
 * fails under StrictHostKeyChecking=yes.
 */
export async function plantVerifiedHostKey(
  vm: VmRecord,
  expectedFingerprint: string,
  deps: AdoptHostKeyDeps,
): Promise<void> {
  // ssh-keyscan -p <port> <host>. Bracketing is unnecessary for keyscan's own
  // argv (it brackets the host:port in its OUTPUT); we pass host + port flag.
  const res = await deps.spawn("ssh-keyscan", [
    "-p",
    String(vm.sshPort),
    vm.ip,
  ]);
  if (res.code !== 0) {
    throw new Error(
      `ssh-keyscan failed (exit ${res.code}) for ${vm.ip}:${vm.sshPort}` +
        (res.stderr ? `: ${res.stderr.trim()}` : ""),
    );
  }

  // Fingerprint EVERY scanned key line and match the pinned fingerprint against
  // ANY of them. Real ssh-keyscan offers one key per host-key type (rsa first,
  // then ed25519/ecdsa); the operator may have pinned any single type, so we
  // must not assume the first line is the relevant one.
  const keyLines = parseScannedKeyLines(res.stdout);
  const observed = keyLines.map((line) => ({
    line,
    type: keyTypeOfLine(line),
    fp: fingerprintOfKeyLine(line),
  }));
  const match = observed.find((k) => k.fp === expectedFingerprint);
  if (match === undefined) {
    // Surface ALL observed fingerprints, typed, so the operator can compare.
    const summary = observed.map((k) => `${k.type} ${k.fp}`).join(", ");
    throw new HostKeyMismatchError(expectedFingerprint, summary);
  }
  const keyLine = match.line;

  // Idempotency: if this exact key line is already recorded, do not duplicate.
  const path = knownHostsPathFor(vm, deps.knownHostsDir);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(keyLine)) return;
  }
  recordHostKey(vm, keyLine, deps.knownHostsDir);
}

/**
 * Default production deps for the adopt host-key plant: ssh-keyscan over a
 * short-lived spawned process, writing into the per-VM known_hosts directory
 * (honoring SAMOHOST_KNOWN_HOSTS_DIR, matching the ssh runner).
 */
export function defaultAdoptHostKeyDeps(): AdoptHostKeyDeps {
  return {
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file, args) => {
      const r = spawnSync(file, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return Promise.resolve({
        code: typeof r.status === "number" ? r.status : 255,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
      });
    },
  };
}
