/**
 * `samohost provision` orchestrator (SPEC §3 story 1, §5 state machine).
 *
 * Staged execution, persisting after EVERY transition:
 *
 *   planned ─create→ creating ─api ok→ booting ─ready gate→ ready
 *   creating ─api fail→ failed              (no resource)
 *   booting  ─gate timeout→ degraded        (resource exists, reclaimable)
 *
 * Orphan-safety: the record is persisted as `creating` BEFORE the provider
 * API call (so a crash mid-call leaves evidence), the create request carries
 * the `managed-by=samohost` / `samohost-id=<uuid>` labels, and provider id +
 * ip are persisted the moment the API accepts.
 *
 * The booting→ready gate (bounded by spec.timeoutSec, default 600s):
 *   1. poll provider.get() until server status == running;
 *   2. ssh-keyscan the HARDENED port until sshd answers — then TOFU-pin:
 *      fingerprint ALL scanned keys, prefer ed25519, persist the fingerprint
 *      and plant the key line via recordHostKey();
 *   3. pinned (StrictHostKeyChecking=yes) SSH probes as the baseline's
 *      non-root user for the cloud-init completion sentinel.
 * Timeout at any stage ⇒ `degraded`, never silent loss.
 *
 * Credentials: this module never reads HCLOUD_TOKEN — only the provider
 * adapter does, at call time. The private key is never read, only its path
 * is recorded (ssh -i).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProvisionSpec, VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";
import type { ProviderPort } from "../providers/types.ts";
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SAMOHOST_ID_LABEL,
} from "../providers/types.ts";
import { buildCloudInit } from "../cloudinit/builder.ts";
import {
  hardeningModule,
  PROVISION_SENTINEL_PATH,
} from "../cloudinit/hardening.ts";
import { resolveModules } from "./preview.ts";
import { assertTransition } from "../orchestrator/lifecycle.ts";
import {
  buildSshArgs,
  defaultKnownHostsDir,
  recordHostKey,
  type SpawnFn,
} from "../ssh/runner.ts";
import { parseScannedKeys, pickPinKey } from "../ssh/hostkey.ts";
import { expandTilde } from "./adopt.ts";

/** The Ubuntu image every samohost VM uses (hardening baseline targets it). */
export const PROVISION_IMAGE = "ubuntu-24.04";

/**
 * Hetzner label key pattern (name part, no prefix):
 *   single char:  `[a-zA-Z0-9]`
 *   multi-char:   `[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?`
 *
 * Both key and value share the same charset; value additionally permits
 * an empty string (Hetzner docs allow value="").
 */
const LABEL_KEY_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$|^[a-zA-Z0-9]$/;
const LABEL_CHAR_RE = /^[a-zA-Z0-9._-]*$/;
const LABEL_MAX_LEN = 63;

/**
 * Validate `spec.labels` against Hetzner constraints. Returns an array of
 * human-readable error strings (empty == valid). Called in the validation
 * phase: nothing is persisted or sent to the provider on any error.
 */
export function validateCustomLabels(
  labels: Record<string, string> | undefined,
): string[] {
  if (labels === undefined) return [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (key.length === 0) {
      errors.push(`label key must not be empty`);
      continue;
    }
    if (key.length > LABEL_MAX_LEN) {
      errors.push(
        `label key "${key.slice(0, 20)}…" exceeds ${LABEL_MAX_LEN} characters (${key.length})`,
      );
      continue;
    }
    if (!LABEL_KEY_RE.test(key)) {
      errors.push(
        `label key "${key}" is invalid: must match [a-zA-Z0-9._-], start and end ` +
          `with alphanumeric`,
      );
    }
    if (value.length > LABEL_MAX_LEN) {
      errors.push(
        `label value for key "${key}" exceeds ${LABEL_MAX_LEN} characters (${value.length})`,
      );
      continue;
    }
    if (value.length > 0 && !LABEL_CHAR_RE.test(value)) {
      errors.push(
        `label value "${value}" for key "${key}" is invalid: must match [a-zA-Z0-9._-]`,
      );
    }
  }
  return errors;
}

/**
 * The pinned-SSH readiness probe. `boot-finished` proves cloud-init finished
 * its run; the samohost sentinel proves our SSH-critical hardening ran (sshd
 * restart on the hardened port, ufw bring-up, root authorized_keys lockdown).
 * The sentinel is intentionally written BEFORE the slow, apt-lock-contending
 * service enables (fail2ban / unattended-upgrades / apparmor) so a first-boot
 * apt-daily lock can never strand this gate; those enables are lock-tolerant +
 * non-fatal and still end enabled (see src/cloudinit/hardening.ts Phase 2).
 * Non-blocking by design: it is polled with the loop's own deadline instead of
 * hanging in `cloud-init status --wait`.
 */
export const READY_PROBE_COMMAND =
  "test -f /var/lib/cloud/instance/boot-finished && " +
  `test -f ${PROVISION_SENTINEL_PATH} && echo SAMOHOST_PROVISION_COMPLETE`;

export interface ProvisionInput {
  spec: ProvisionSpec;
  /** The --ssh-key value: path to either half of the keypair (~ expanded). */
  sshKey: string;
}

export interface KeyPairResolution {
  /** What VmRecord.sshKeyPath records (ssh -i uses it). */
  privateKeyPath: string;
  publicKeyPath: string;
  /** The public key TEXT — the only key material ever read or embedded. */
  publicKey: string;
}

/**
 * Resolve --ssh-key (public or private path) into the pair: cloud-init gets
 * the .pub text, the state record points at the PRIVATE key. Both halves must
 * exist — the ready gate needs the private key for the pinned probes.
 */
export function resolveKeyPair(
  path: string,
): { ok: true; pair: KeyPairResolution } | { ok: false; errors: string[] } {
  const p = expandTilde(path);
  const privateKeyPath = p.endsWith(".pub") ? p.slice(0, -4) : p;
  const publicKeyPath = `${privateKeyPath}.pub`;

  const errors: string[] = [];
  if (!existsSync(privateKeyPath)) {
    errors.push(
      `private key not found: ${privateKeyPath} (the provision ready-gate ` +
        `probes SSH with it, and \`samohost ssh\` records it)`,
    );
  }
  if (!existsSync(publicKeyPath)) {
    errors.push(
      `public key not found: ${publicKeyPath} (cloud-init embeds its text ` +
        `for the admin user)`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  if (publicKey.length === 0) {
    return { ok: false, errors: [`public key file is empty: ${publicKeyPath}`] };
  }
  return { ok: true, pair: { privateKeyPath, publicKeyPath, publicKey } };
}

export interface ProvisionDeps {
  provider: ProviderPort;
  store: StateStore;
  /** Spawns `ssh-keyscan` and `ssh` (injected; tests never touch a network). */
  spawn: SpawnFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  knownHostsDir: string;
  controlDir?: string;
  /** Delay between ready-gate attempts. Default 5000ms. */
  pollIntervalMs?: number;
  /**
   * Detect the control-plane's own outbound (egress) IP so it can be
   * auto-injected into trustedIps — exempting the ready-gate's own polling
   * IP from UFW `limit` and fail2ban. Returns null on any failure (silently
   * skipped). Injected so tests never touch the network.
   */
  detectEgressIp?: () => Promise<string | null>;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;

export async function runProvision(
  input: ProvisionInput,
  opts: { json: boolean },
  deps: ProvisionDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const spec = { ...input.spec };

  // ---- validation (nothing persisted, no provider calls, on any error) ----
  const keyRes = resolveKeyPair(input.sshKey);
  if (!keyRes.ok) {
    for (const e of keyRes.errors) err(`error: ${e}`);
    return 1;
  }
  const { privateKeyPath, publicKeyPath, publicKey } = keyRes.pair;
  spec.sshKeyPath = publicKeyPath;

  const { modules, errors: moduleErrors } = resolveModules(spec.modules);
  const validationErrors = [
    ...moduleErrors,
    ...[hardeningModule, ...modules].flatMap((m) => m.validate(spec)),
    ...validateCustomLabels(spec.labels),
  ];
  if (validationErrors.length > 0) {
    for (const e of validationErrors) err(`error: ${e}`);
    return 1;
  }

  const userData = buildCloudInit(spec, modules, { sshPubkey: publicKey });

  // ---- planned (persisted) ----
  const now = new Date().toISOString();
  let record: VmRecord = {
    id: crypto.randomUUID(),
    provider: spec.provider,
    providerId: "",
    name: spec.name,
    ip: "",
    sshKeyPath: privateKeyPath,
    sshPort: spec.sshPort,
    sshUser: spec.adminUser,
    hostKeyFingerprint: "",
    region: spec.region,
    type: spec.type,
    modules: spec.modules,
    lifecycleState: "planned",
    createdAt: now,
    updatedAt: now,
  };
  record = deps.store.upsert(record);

  const persist = (changes: Partial<VmRecord>): void => {
    if (
      changes.lifecycleState !== undefined &&
      changes.lifecycleState !== record.lifecycleState
    ) {
      assertTransition(record.lifecycleState, changes.lifecycleState);
    }
    record = deps.store.upsert({ ...record, ...changes });
  };

  // ---- creating (persisted BEFORE the API call — crash evidence) ----
  persist({ lifecycleState: "creating" });

  let providerId: string;
  try {
    // Merge custom labels first so managed labels overwrite any key collision.
    // This is the security invariant: a user must not be able to supply a label
    // that masks the managed-by or samohost-id tags used for orphan discovery.
    const mergedLabels: Record<string, string> = {
      ...(spec.labels ?? {}),
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [SAMOHOST_ID_LABEL]: record.id,
    };
    const info = await deps.provider.create({
      name: spec.name,
      serverType: spec.type,
      image: PROVISION_IMAGE,
      location: spec.region,
      userData,
      labels: mergedLabels,
    });
    providerId = info.providerId;
    // ---- booting: provider id + ip persisted the moment the API accepts ----
    persist({
      lifecycleState: "booting",
      providerId: info.providerId,
      ip: info.ipv4 ?? "",
    });
  } catch (e) {
    const norm = deps.provider.normalizeError(e);
    persist({ lifecycleState: "failed" });
    err(`error: provider create failed [${norm.kind}]: ${norm.message}`);
    return 1;
  }

  // ---- booting → ready gate ----
  const deadline = deps.now() + spec.timeoutSec * 1000;
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const controlDir =
    deps.controlDir ?? join(deps.knownHostsDir, "..", "cm");

  type Gate = "server-running" | "ssh-up" | "cloud-init-complete";
  let gate: Gate = "server-running";
  let ready = false;

  while (deps.now() < deadline) {
    if (gate === "server-running") {
      try {
        const info = await deps.provider.get(providerId);
        if (info.ipv4 !== null && info.ipv4 !== record.ip) {
          persist({ ip: info.ipv4 });
        }
        if (info.status === "running" && (record.ip !== "" || info.ipv4 !== null)) {
          // never advance to ssh probes without a target address (samorev #2)
          gate = "ssh-up";
        }
      } catch {
        // transient get failures: keep polling within the deadline
      }
    } else if (gate === "ssh-up") {
      const res = await deps.spawn("ssh-keyscan", [
        "-T",
        "5",
        "-p",
        String(record.sshPort),
        record.ip,
      ]);
      if (res.code === 0 && res.stdout.trim().length > 0) {
        try {
          const keys = parseScannedKeys(res.stdout);
          const pin = pickPinKey(keys);
          // TOFU: persist the pin, plant the line; all later SSH enforces it.
          persist({ hostKeyFingerprint: pin.fingerprint });
          recordHostKey(record, pin.line, deps.knownHostsDir);
          gate = "cloud-init-complete";
        } catch {
          // unparsable scan output — retry next tick
        }
      }
    } else {
      const args = buildSshArgs(record, READY_PROBE_COMMAND, {
        knownHostsDir: deps.knownHostsDir,
        controlDir,
      });
      const res = await deps.spawn("ssh", args);
      if (res.code === 0 && res.stdout.includes("SAMOHOST_PROVISION_COMPLETE")) {
        ready = true;
        break;
      }
    }
    await deps.sleep(interval);
  }

  if (!ready) {
    persist({ lifecycleState: "degraded" });
    err(
      `error: VM did not reach ready within ${spec.timeoutSec}s ` +
        `(stalled at gate: ${gate}) — recorded as degraded. The provider ` +
        `resource EXISTS (provider id ${record.providerId}) and is ` +
        `reclaimable: \`samohost destroy ${record.name}\`.`,
    );
    // Machine-readable degraded record on stdout so `--json` callers can reclaim
    // by id. Omitting it made automated callers print a false "ORPHAN — no
    // provider id" even though the resource exists and is reclaimable.
    if (opts.json) {
      out(JSON.stringify(record, null, 2));
    }
    return 1;
  }

  persist({ lifecycleState: "ready" });

  if (opts.json) {
    out(JSON.stringify(record, null, 2));
  } else {
    out(
      `ready ${record.name}  ${record.sshUser}@${record.ip}:${record.sshPort}  ` +
        `[${record.lifecycleState}]  provider_id=${record.providerId}  id=${record.id}`,
    );
    out(
      `host key pinned (TOFU at first boot): ${record.hostKeyFingerprint}`,
    );
  }
  return 0;
}

/** Production deps: real providers wire fetch; spawn/clock/paths are real. */
export function defaultProvisionDeps(provider: ProviderPort, store: StateStore): ProvisionDeps {
  return {
    provider,
    store,
    spawn: realSpawn,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
  };
}

/** Spawn a short-lived process and capture its output (no shell). */
async function realSpawn(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return {
    code: typeof r.status === "number" ? r.status : 255,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
}
