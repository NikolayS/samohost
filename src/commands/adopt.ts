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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { Provider, VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";

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
export function runAdopt(
  input: AdoptInput,
  opts: { json: boolean },
  store: StateStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
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
