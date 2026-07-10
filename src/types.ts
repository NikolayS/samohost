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
  /**
   * Optional custom labels to attach to the provider resource at create time.
   * Merged with the managed labels (`managed-by=samohost`, `samohost-id=<uuid>`);
   * the managed labels WIN on key collision so a user cannot mislabel a
   * samohost-managed VM to evade inventory/cleanup.
   *
   * Keys and values must conform to Hetzner label constraints:
   *   - key: 1–63 chars, pattern `[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?`
   *     (single-char keys are simply `[a-zA-Z0-9]`)
   *   - value: 0–63 chars, same charset as key (empty value is allowed)
   *
   * Populated from `--label key=value` CLI flags or the `[provision]` TOML
   * section (PR-D). Absent when no custom labels are requested.
   */
  labels?: Record<string, string>;
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
  /**
   * The probe needs root (e.g. `sshd -T`, `ufw status`, `aa-status`). When the
   * auditing user lacks it, the probe yields nothing or a permission error —
   * that is reported as `unknown`, not `fail`: a missing privilege is not a
   * hardening regression (live-confirmed against the platform VM, where three
   * controls false-FAILed as the unprivileged `agent` user).
   */
  requiresSudo?: boolean;
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
 * Optional post-deploy assertions for an app (SPEC-DELTA §3 "post-deploy
 * assertions as pluggable checks"). Generalized from field-record's RLS probe.
 */
export interface AppAssertions {
  /**
   * Verify the app connects to Postgres as a NON-superuser. Superusers bypass
   * RLS unconditionally, so a superuser connection silently voids the security
   * guarantee. When true, the deploy script emits a psql probe
   * `SELECT rolsuper FROM pg_roles WHERE rolname = current_user` and expects
   * `f` (false); anything else triggers rollback. (deploy.sh RLS-active gate.)
   */
  rlsNonSuperuser?: boolean;
}

/**
 * Declarative spec for a deployable app (SPEC-DELTA §3 "app module"). This is
 * the generalization of field-record's deploy.sh inputs into typed config.
 *
 * NOTE on secrets: `envFile` is a path to a remote env file. The deploy script
 * SOURCES it read-only before install (issue #2: pushed scripts inherit nothing
 * from the service environment, so migrate/seed/probes need it), but samohost
 * NEVER writes it (divergence from deploy.sh, which rotated APP_DATABASE_URL
 * into staging.env). Deployed-SHA bookkeeping lives in samohost state
 * ({@link AppRecord}), not in any remote env file.
 */
export interface AppSpec {
  /** App name, unique per VM (e.g. "field-record"). */
  name: string;
  /**
   * Serve kind: `"node"` (default, absent = node) runs a Node.js process via a
   * systemd template instance and reverse-proxies it; `"static"` serves a
   * pre-built asset bundle (Vite/SPA output) directly via Caddy `file_server`
   * with no Node.js service, no DB, no env file. Optional: all existing AppRecords
   * without this field are treated as `"node"`.
   */
  kind?: "node" | "static";
  /** GitHub repo in `owner/name` form (e.g. "Tanya301/field-record-1"). */
  repo: string;
  /** Git branch to track. Default "main". */
  branch: string;
  /** Absolute app checkout dir on the remote (e.g. /opt/field-record/app). */
  appDir: string;
  /** Build command (e.g. "npm run build"). */
  buildCmd: string;
  /** Optional migration command, run after build, before restart. */
  migrateCmd?: string;
  /** Optional idempotent seed command, run after a healthy deploy. */
  seedCmd?: string;
  /** Health URL polled after restart (e.g. http://localhost:3000/api/version). */
  healthUrl: string;
  /**
   * PUBLIC host of the PRODUCTION (main-env) app, e.g.
   * `field-record-1.samo.team` (field-record-1#117 ITEM C, 7th drift class).
   * When set, host-prep emits a durable Caddy vhost snippet
   * `/etc/caddy/sites.d/00-main-<name>.caddy` proxying this host to the
   * production port (derived from {@link healthUrl}), so the main vhost is
   * provisioned state instead of a hand-applied VM-local edit that the next
   * Caddyfile churn de-references. Optional for back-compat.
   */
  mainHost?: string;
  /** systemd unit name (e.g. "field-record"). Restarted via full-path sudo. */
  serviceUnit: string;
  /** Remote env file path. Sourced read-only by the deploy script before
   * install; NEVER written by samohost (see interface note). */
  envFile?: string;
  /**
   * Env vars whose values are database URLs that MUST point at the per-env
   * database in preview envs (issue #11: a faithful operator template
   * otherwise wires previews to the PRODUCTION db). The env-create script
   * rewrites ONLY the db-name path component of each listed var ON THE HOST;
   * samohost never sees the values. Default when absent: ["DATABASE_URL"].
   */
  envDbVars?: string[];
  /**
   * Env-var name holding the NON-superuser connection URL for the RLS probe
   * (issue #2: field-record's is APP_DATABASE_URL, while DATABASE_URL is the
   * superuser URL — probing via the wrong var falsely rolls back healthy
   * deploys). When set, the probe consults ONLY this var; when absent, the
   * back-compat fallback chain RLS_DATABASE_URL || DATABASE_URL applies.
   */
  rlsUrlVar?: string;
  /** Optional pluggable post-deploy assertions. */
  assertions?: AppAssertions;
  /**
   * OS user that owns the production app checkout and the envs root (created
   * by `samohost app bootstrap --app-user <user>`). When set, env-create runs
   * all git operations (clone/fetch/checkout) as this user via
   * `sudo -u <appUser> GIT_CONFIG_GLOBAL=<git-safe.conf> /usr/bin/git`,
   * preventing `fatal: detected dubious ownership in repository` (git ≥ 2.35.2
   * rejects checkouts whose owner differs from the calling process user). The
   * 600 `.gh-token` is also unreadable by the SSH user — this field makes the
   * clone run as the user who CAN read it. The preview systemd template unit
   * is also reconciled: `User=<appUser>` so the preview process runs as the
   * user that owns the env dir and the code. Absent on existing AppRecords that
   * pre-date this field: the SSH user is used as before (back-compat).
   */
  appUser?: string;
  /**
   * Persistent DB backend for this app's own production database.
   * When set to `"none"` the app carries no database at all — preview envs
   * must not attempt a dblab clone or a template copy. Absent on existing
   * AppRecords that pre-date this field; treated as implicitly DB-present.
   */
  dbBackend?: EnvDbBackend;
  /**
   * Per-app default DB backend for auto-created PR-preview envs (src/preview/pr.ts).
   * When absent, falls back to `app.dbBackend === 'none' ? 'none' : 'dblab'`.
   * An explicit value always wins. Set to `"template"` only when an operator
   * explicitly needs the legacy createdb-template fallback. There is NO silent
   * fallback to `"template"`; any non-dblab backend must be stated explicitly here.
   */
  previewDbBackend?: EnvDbBackend;

  // ---- Multi-service spec model (additive; absent = legacy single-service) --

  /**
   * Declared services. When absent, consumers call `servicesOf(app)` to get
   * the synthesized legacy single-service shape. NEVER access this directly
   * in consumers — always go through `servicesOf()`.
   */
  services?: ServiceSpec[];
  /**
   * Caddy routing rules for a multi-service app. When absent (legacy), no
   * routes are registered (the single service handles all traffic).
   */
  routes?: RouteSpec[];
  /**
   * Name of the listener that receives the default (unmatched) request path.
   * REQUIRED when `services` is set. Must reference an existing listener name.
   */
  defaultListener?: string;
  /**
   * How the production main-host is wired into Caddy:
   *  - `"cp-http80"` : control-plane plain HTTP on port 80 (no TLS termination
   *                    here; TLS is handled upstream, e.g. a CF tunnel).
   *  - `"tls"`       : full TLS termination on this VM (ACME or internal cert).
   * Absent = legacy behaviour (host-prep derives mode from existing convention).
   */
  mainListen?: "cp-http80" | "tls";
}

/**
 * A persisted app record: an {@link AppSpec} bound to a VM, plus deploy
 * bookkeeping. Stored separately from VMs in `~/.samohost/apps.json`.
 *
 *   - `deployedSha`  : last SHA that deployed AND passed health/assertions.
 *   - `failedSha`    : last SHA that failed and was rolled back (known-bad
 *                      guard equivalent of deploy.sh's DEPLOY_FAILED_SHA, but
 *                      kept in samohost state, NOT in the remote env file).
 */
export interface AppRecord extends AppSpec {
  id: string;
  /** Id of the {@link VmRecord} this app is deployed on. */
  vmId: string;
  deployedSha?: string;
  failedSha?: string;
  lastDeployAt?: string;
}

/**
 * Database backend for a preview environment (SPEC-DELTA §4):
 *  - `dblab`    : DBLab Engine thin clone — instant, storage-cheap, the primary
 *                 backend for the SOLO plan (destroy = clone delete).
 *  - `template` : `createdb --template=<tpl>` fallback until DBLab Engine is
 *                 confirmed on the host (destroy = dropdb).
 *  - `none`     : app runs against whatever its env file already points at
 *                 (no per-env database).
 */
export type EnvDbBackend = "dblab" | "template" | "none";

// ---------------------------------------------------------------------------
// Multi-service spec model (PR: multi-service app spec — additive, optional)
//
// All fields are OPTIONAL on AppSpec/AppRecord/EnvRecord. Absent = legacy
// single-service behaviour, byte-identical to the pre-multi-service state.
// ---------------------------------------------------------------------------

/**
 * A single inbound listener for a service: the port it binds, the env var
 * that carries the port, and optional routing metadata.
 *
 * `routed`: when false (default: undefined = treated as true for back-compat),
 * Caddy will NOT reverse-proxy public traffic to this listener. Use for
 * internal/metrics listeners that must never be publicly reachable.
 */
export interface ListenerSpec {
  /** Unique name across all listeners in this app (used as a `to` target). */
  name: string;
  /** TCP port the process binds. Must be unique across all listeners. */
  port: number;
  /** Environment variable injected with the port number. Must be unique. */
  portEnv: string;
  /** HTTP path polled by health checks (default "/" when absent). */
  healthPath?: string;
  /**
   * Whether Caddy may route external traffic to this listener.
   * Absent or true = routable; false = internal-only (metrics, etc.).
   */
  routed?: boolean;
}

/**
 * A named service within a multi-service app. Each service maps to one
 * systemd unit and may expose one or more listeners.
 */
export interface ServiceSpec {
  /** Unique name for this service within the app. */
  name: string;
  /** systemd unit name (e.g. "field-record", "field-record-worker"). */
  unit: string;
  /**
   * Optional override for the ExecStart path in the systemd unit.
   * When absent the unit file is used as-is (no ExecStart override).
   */
  execStart?: string;
  /** One or more inbound listeners this service exposes. */
  listeners: ListenerSpec[];
}

/**
 * A Caddy routing rule for a multi-service app.
 *
 * Exactly one of `matchPath | matchRegexp` must be set (matcher).
 * Exactly one of `to | respond` must be set (action).
 *
 * `name`: optional Caddy named-matcher id. Must match `[a-z][a-z0-9-]*`.
 */
export interface RouteSpec {
  /** Optional Caddy named-matcher id: `[a-z][a-z0-9-]*`. */
  name?: string;
  /** Caddy `path` matcher (e.g. "/api/*"). Mutually exclusive with matchRegexp. */
  matchPath?: string;
  /**
   * Caddy `path_regexp` pattern. Must compile as a Go regexp AND use only
   * Caddy-safe characters (no unescaped quotes or control chars that would
   * break the config file). Mutually exclusive with matchPath.
   */
  matchRegexp?: string;
  /**
   * Target listener name (must exist and have routed !== false).
   * Mutually exclusive with respond.
   */
  to?: string;
  /**
   * Static response target: Caddy returns this status + body directly.
   * Mutually exclusive with to.
   */
  respond?: {
    status: number;
    body: string;
  };
}

/**
 * A persisted preview environment (SPEC-DELTA §4 "env command family"): one
 * git branch of one app, running as a systemd template instance on the VM,
 * served on its own vhost. Stored in `~/.samohost/envs.json`; the natural
 * identity is (vmId, appName, branch).
 */
export interface EnvRecord {
  id: string;
  /** Id of the {@link VmRecord} this env runs on. */
  vmId: string;
  /** Name of the {@link AppRecord} this env is an instance of. */
  appName: string;
  /** The git branch this env tracks (raw, unsanitized). */
  branch: string;
  /** Sanitized DNS-label name, `<app>-<branch-label>` (env/name.ts). Doubles
   * as the systemd instance name and the env dir name. */
  name: string;
  /** App port allocated from the per-VM pool (env/ports.ts). */
  port: number;
  /** Full vhost, `<name>.<previewDomain>` (e.g. x.samo.cat). */
  vhost: string;
  dbBackend: EnvDbBackend;
  /** dblab clone id or template-backend database name (absent for `none`). */
  dbName?: string;
  /** Template database override for the `template` backend (`--template-db`);
   * absent → the script derives `<app dashes→underscores>_template`. */
  templateDb?: string;
  createdAt: string;
  /** Last SHA deployed into this env (set by env-aware deploys; optional). */
  lastDeployedSha?: string;
  /** PR number that owns this preview env, when it was created by the PR-preview
   * pass (src/preview/pr.ts). Absent for manually-created or demo previews —
   * which the closed-PR reaper MUST NEVER touch. */
  prNumber?: number;
  /**
   * ISO-8601 timestamp of the most-recent HTTP request served by the env's
   * Caddy vhost, as stamped by the idle-GC pass from the per-vhost JSON access
   * log at `/var/log/caddy/<name>.log`. Absent until the first GC cycle reads
   * the log. When absent, the idle-GC falls back to `createdAt` so brand-new
   * envs are not immediately reaped.
   */
  lastAccess?: string;
  /**
   * Per-listener allocated port numbers for multi-service envs, keyed by
   * listener name (e.g. `{ "web": 40100, "metrics": 40101 }`).
   * Absent for legacy single-service envs (`EnvRecord.port` covers them).
   * Set by the port-allocator in a later PR; read-only here.
   */
  ports?: Record<string, number>;
}

/**
 * A persisted custom-domain mapping: a client-owned FQDN bound to one of
 * our apps via a Cloudflare for SaaS Custom Hostname + a Caddy vhost snippet.
 * Stored in `~/.samohost/domains.json` (override: SAMOHOST_DOMAINS env).
 * Natural identity: `fqdn` (globally unique across all apps and VMs).
 */
export interface DomainRecord {
  id: string;
  /** Client domain, natural identity (e.g. "myapp.com"). */
  fqdn: string;
  /** Name of the AppRecord this domain routes to. */
  appName: string;
  /** Id of the VmRecord the app runs on. */
  vmId: string;
  /** Cloudflare Custom Hostname id (absent until CF create succeeds). */
  customHostnameId?: string;
  /** Last-observed CF ssl.status (e.g. "pending_validation", "active"). */
  sslStatus?: string;
  /** Last-observed CF hostname status (e.g. "pending", "active"). */
  hostnameStatus?: string;
  createdAt: string;
  updatedAt?: string;
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
