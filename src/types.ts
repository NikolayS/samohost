/**
 * samohost frozen interfaces (SPEC §4).
 *
 * These are the core abstractions agreed at the "interfaces frozen" gate
 * (SPEC Sprint 0). Changing them is a breaking change across the codebase.
 */

export type Provider = "hetzner" | "aws";

/**
 * Lifecycle states for a managed VM (SPEC §5 state machine).
 *
 *   planned ─create→ creating ─api ok→ booting ─cloud-init ok→ ready
 *   creating ─api fail→ failed
 *   booting  ─timeout/err→ degraded
 *   ready/degraded/failed ─destroy→ destroying → destroyed
 *
 * SPEC-DELTA §1 adds an `adopted` state for VMs registered from an existing,
 * already-hardened host (no provider create). It behaves like `ready`:
 *
 *   (absent) ─adopt→ adopted ─destroy→ destroying → destroyed
 */
export type LifecycleState =
  | "planned"
  | "creating"
  | "booting"
  | "ready"
  | "adopted"
  | "degraded"
  | "failed"
  | "destroying"
  | "destroyed";

/**
 * Normalized provisioning request. Produced by the CLI layer from flags /
 * wizard, then consumed by the orchestrator and cloud-init builder.
 *
 * Defaults (applied during normalization): sshPort=2223, adminUser="samo",
 * timeoutSec=600, modules=[], trustedIps=[].
 */
export interface ProvisionSpec {
  provider: Provider;
  region: string;
  type: string;
  name: string;
  /** Path to the public key on the operator's machine. The builder never reads
   * it; the key *text* is injected as a parameter (see {@link BuildParams}). */
  sshKeyPath: string;
  /** Hardened SSH port. Default 2223. */
  sshPort: number;
  /** Non-root sudo user created on the box. Default "samo". */
  adminUser: string;
  /** Optional module names (e.g. ["postgres"]). Hardening is implicit. */
  modules: string[];
  /** IPs that must never be banned by fail2ban (control planes etc.). */
  trustedIps: string[];
  /** Bound for booting→ready polling, in seconds. Default 600. */
  timeoutSec: number;
}

/** A single file to be written by cloud-init's `write_files`. */
export interface WriteFile {
  path: string;
  content: string;
  permissions?: string;
  owner?: string;
}

/**
 * A composable piece of cloud-init produced by a {@link Module}. The builder
 * concatenates fragments in a fixed order and renders deterministic YAML.
 */
export interface CloudInitFragment {
  packages?: string[];
  writeFiles?: WriteFile[];
  runcmd?: string[];
}

/**
 * A read-only probe used by `status --audit` to confirm a control is active.
 * `expect` is matched against the probe's stdout.
 */
export interface AuditCheck {
  id: string;
  description: string;
  probeCommand: string;
  expect: RegExp | string;
}

/**
 * A composable unit of VM capability (hardening baseline, postgres, ...).
 * SPEC §4 key abstraction.
 */
export interface Module {
  name: string;
  /** Return a list of human-readable validation errors (empty == valid). */
  validate(spec: ProvisionSpec): string[];
  /** Pure: produce this module's cloud-init contribution for the spec. */
  cloudInitFragment(spec: ProvisionSpec): CloudInitFragment;
  /** Probes that prove this module's controls are live on the box. */
  auditChecks: AuditCheck[];
}

/** Extra (non-spec) inputs the builder needs but must not persist. */
export interface BuildParams {
  /** The SSH *public* key text. Public material — safe to embed. */
  sshPubkey: string;
}

/**
 * A persisted VM record in the local state store (SPEC §4/§5).
 */
export interface VmRecord {
  id: string;
  provider: Provider;
  /** Provider-native resource id (e.g. Hetzner server id, EC2 instance id). */
  providerId: string;
  name: string;
  ip: string;
  sshKeyPath: string;
  sshPort: number;
  /** Remote login user for SSH (SPEC-DELTA §1). For provisioned VMs this equals
   * the spec's adminUser; for adopted VMs it is supplied via --ssh-user. */
  sshUser: string;
  /** Pinned host key fingerprint, out-of-band verified at adopt time
   * (SPEC-DELTA §1). Format: `SHA256:<43 base64 chars>`. All SSH pins this
   * key (`StrictHostKeyChecking=yes`, per-VM known_hosts). */
  hostKeyFingerprint: string;
  region: string;
  type: string;
  modules: string[];
  lifecycleState: LifecycleState;
  createdAt: string;
  updatedAt: string;
}
