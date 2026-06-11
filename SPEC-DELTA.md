# SPEC delta proposal: v0.1 → v0.2 (driven by the field-record-1 deployment)

Status: DRAFT — to be merged into SPEC.md on a samohost branch after manager review.

## Why a delta

SPEC v0.1 assumes the lifecycle starts at `provision` (a new VM). The first real
deployment (plan SOLO, Tanya301/field-record-1, GitHub issue #117) starts from an
*existing*, already-hardened production VM that we must operate without re-provisioning.
v0.1 defers "import" to post-v0.1; reality promotes it to the first feature.

## New commands / modules (build order)

### 1. `samohost adopt` (NEW — was "roadmap: import")
Register an existing VM into local state without any provider API call:

```
samohost adopt --name samo-we-field-record --ip 178.105.246.151 \
  --ssh-port 2223 --ssh-user agent --ssh-key ~/.ssh/id_ed25519 \
  --host-key-fingerprint 'SHA256:...' [--provider hetzner --provider-id <id>]
```

- Writes a `VmRecord` with `lifecycle_state: adopted` (new state, behaves like `ready`).
- **Host key pinning is mandatory at adopt time** (out-of-band verified fingerprint).
  All later SSH goes through a runner that pins this key (`StrictHostKeyChecking=yes`,
  per-VM known_hosts file under `~/.samohost/known_hosts.d/<id>`).
- `status --audit` then works unchanged against adopted VMs.

Rationale from the field: tonight's host-key change + fail2ban ban (bantime 86400,
maxretry 3) proved ad-hoc ssh/keyscan against hardened hosts is harmful. The tool must
own host-key state and enforce a probe budget (≤1 connection per operation, multiplexed).

### 2. Remote exec layer (internal)
- Single SSH connection per command run (ControlMaster multiplexing), bounded retries
  with backoff, never more than 2 connection attempts per 10 min on auth-layer failure
  (fail2ban-safe).
- All sudo invocations use absolute paths (`sudo /usr/bin/systemctl ...`) — required by
  `Defaults use_pty` + exact-path NOPASSWD grants (issue #99 lesson).
- Secrets never appear in argv (stdin piping only), never logged.

### 3. `app` module + `samohost app` command family
Generalizes field-record's `deploy/deploy.sh` (435 lines of production lessons):

```
samohost app deploy <vm> --app field-record [--ref main|--sha X]
samohost app status <vm> --app field-record
samohost app rollback <vm> --app field-record
```

App spec (per app, in `~/.samohost/apps/<name>.toml` or repo-side `.samohost.toml`):
repo, branch, build cmd, migrate cmd, health URL, env file path, systemd unit, port.

Encoded lessons (each becomes a unit-tested behavior):
- CI-green gate before deploy (GitHub Actions API by SHA; skip red, wait on pending).
- Known-bad-SHA guard (`DEPLOY_FAILED_SHA` equivalent in samohost state, not env file).
- Build preservation + coherent rollback: previous build dir AND git reset to
  pre-deploy SHA (split-state corruption lesson).
- Self-overwrite-safe execution: remote helper script is copied to a temp path before
  exec (bash byte-offset splice lesson).
- Post-deploy assertions as pluggable checks: HTTP health, RLS-active probe
  (`SELECT rolsuper FROM pg_roles WHERE rolname = current_user` must be `f`).
- Idempotent seed hook; deployed-SHA recorded on success only.

### 4. `env` command family — per-branch preview environments
(Name chosen to avoid colliding with v0.1 `preview` = offline cloud-init render.)

```
samohost env create <vm> --app field-record --branch feat/x
samohost env list <vm> [--app field-record]
samohost env destroy <vm> --app field-record --branch feat/x
samohost env gc <vm> --ttl 7d         # reap envs whose branch is merged/deleted
```

Per env: sanitized name (git branch → DNS label: lowercase, [a-z0-9-], ≤63, hash suffix
on collision/overflow), dedicated port from a recorded pool, checkout in
`/opt/<app>/envs/<name>`, templated systemd instance (`<app>@<name>.service`),
Caddy vhost `<name>.samo.cat` (or chosen preview domain), DB provisioning:
- **dblab backend**: DBLab Engine clone on `tank/dblab` (datasets already reserved on
  the platform VM); env's DATABASE_URL points at the clone port. Destroy = clone delete.
- **template backend** (fallback until DBLab Engine confirmed):
  `CREATE DATABASE <app>_env_<name> TEMPLATE <prod_db_snapshot>`.

State: envs are child records of the VM record (`envs[]`), each with branch, port,
db backend handle, vhost, created_at, last_deployed_sha.

### 5. DNS provider port (Cloudflare adapter, read/write per-zone)
Only needed if the preview domain lands on Cloudflare (decision pending —
samo.cat currently on Namecheap NS). Interface mirrors the Provider port:
`ensureRecord(zone, name, type, value, proxied)`, `removeRecord(...)`. Token via
`CLOUDFLARE_API_TOKEN`; zone ID supplied in config (tokens may lack list scope).

### 6. Hardening baseline corrections (apply to v0.1 builder NOW)
- Ubuntu 24.04 socket-activated sshd: port must be set via
  `/etc/systemd/system/ssh.socket.d/port.conf` (ListenStream reset + rebind);
  `Port` in sshd_config is silently ignored.
- fail2ban jail.local: `backend=systemd`, `banaction=nftables` (Ubuntu 24.04
  `jail.d/defaults-debian.conf` overrides ufw banaction silently), parameterized
  `ignoreip` (trusted IPs: control planes + operator machines doing frequent SSH).
- `MaxStartups 100:30:200` to survive burst SSH from agents.
- Audit checks extended accordingly.

## State machine addition

```
(absent) ─adopt→ adopted ─destroy→ destroying → destroyed
adopted: status/audit/app/env commands legal; provision-only transitions illegal.
```

## Out of scope still (unchanged)
Resize, snapshots, drift correction, GCP/DO providers.
