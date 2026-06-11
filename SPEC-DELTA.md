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

Contract amendments from the first real deploy cycle (2026-06-11; each
runtime-proven in an executed sandbox before the first production deploy
completed through samohost the same night — issue #2 / PR #8, issue #4 / PR #5):

- **The deploy script SOURCES the registered `--env-file` (read-only) before
  install.** v0.1's "samohost never reads or writes the app's env file" is
  narrowed to never-WRITES: migrate/seed/probes need the app environment, and
  values still never transit samohost (sourcing happens on-host inside the
  pushed script). Without this, migrate dies with no `DATABASE_URL`.
- **Install is `npm ci --include=dev`** — once the env file is sourced,
  `NODE_ENV=production` reaches the shell and plain `npm ci` drops the build
  toolchain (`tsc: not found`). Couples with the sourcing change by design.
- **The RLS probe's env var is declared at register time**
  (`app register --rls-url-var APP_DATABASE_URL`). A configured var is
  EXCLUSIVE — no silent fallback to `DATABASE_URL`, because that fallback IS
  the failure mode: probing the superuser URL falsely rolls back a healthy
  deploy and brands the good SHA known-bad.
- **failedSha escape hatches:** `app clear-failed <vm> <app>` and
  `app deploy --force` (loud). A probe-defect rollback must not wedge the
  pipeline behind a hand-edit of local state.
- **`adopt` plants the verified host key** (issue #4): after the out-of-band
  fingerprint check, ssh-keyscan output is fingerprinted across ALL key lines
  (keyscan ordering is racy — first-line-only matching refuses genuine hosts
  intermittently) and the matching line is recorded into the per-VM
  known_hosts. First real connection works under `StrictHostKeyChecking=yes`
  with no manual plant.
- **CI gate auth:** the gate reads `GH_TOKEN`/`GITHUB_TOKEN`; on a private
  repo with no token, "no CI run" and "no access" are indistinguishable today
  (issue #10) — operator remedy: `GH_TOKEN="$(gh auth token)"`.

### 4. `env` command family — per-branch preview environments — **IMPLEMENTED**
(Name chosen to avoid colliding with v0.1 `preview` = offline cloud-init render.)

Maps Tanya301/field-record-1#117's SOLO plan onto one shared VM:

| #117 concept | samohost surface |
|---|---|
| production `field-record-1.samo.team` | the registered app itself (`app register/deploy`, port 3000) |
| preview `field-record-1-{branch}.samo.cat` | `EnvRecord` — vhost `<app>-<branch-label>.<previewDomain>`, default domain `samo.cat` |
| previews backed by DBLab branching | `--db dblab` (default): thin clone per env; `--db template`: createdb fallback; `--db none` |
| one tiny-project VM for prod+previews | env port pool 3100–3199 beside production's 3000; systemd template instances under the same hardened host |

Implemented command surface (src/commands/env.ts):

```
samohost env plan <vm> <app> --branch feat/x [--db dblab|template|none]
                            [--destroy] [--host-prep] [--preview-domain samo.cat]
samohost env create <vm> <app> --branch feat/x [--db ...] [--json]
samohost env list <vm> [--app field-record-1] [--json]
samohost env destroy <vm> <app> --branch feat/x [--json]
samohost env gc ...                 # DEFERRED (reap merged/deleted branches)
```

Per env (all implemented as pure, snapshot-tested builders in src/env/):
sanitized name (git branch → DNS label: lowercase, [a-z0-9-], ≤63, deterministic
fnv1a hash suffix on collision/overflow — name.ts), dedicated port from the
recorded pool (lowest-free, ports.ts), fresh checkout in `<app-parent>/envs/<name>`
(`--reference` clone off the production checkout), templated systemd instance
(`<unit>@<name>.service`), Caddy vhost snippet in `/etc/caddy/sites.d/` + reload,
DB provisioning:
- **dblab backend** (default): DBLab Engine thin clone; clone id = env name; env's
  DATABASE_URL points at the clone port. Destroy = clone delete. The emitted
  `dblab` CLI calls are PLAN HOOKS — flags to be confirmed once DBLab Engine is
  live on the VM (datasets already reserved on the platform VM).
- **template backend** (fallback until DBLab Engine confirmed):
  `dropdb --if-exists <db>` + `createdb --template=<tpl> <db>` — NO per-env
  role (see the issue #11 redesign below). Template db defaults to
  `<app dashes→underscores>_template`; override per env with `--template-db`
  (persisted on the EnvRecord, so re-create/destroy reuse it).

Secret handling: the env file is composed ON THE HOST from an operator-managed
template (`<app-parent>/envs.template.env`) with PORT appended and the mapped
DB vars rewired there (below); dblab clone passwords are generated on-host
(`openssl rand`). samohost never reads, writes, or parses a secret value.

**Per-env DB var mapping — `envDbVars` (issue #11, the production
cross-wiring lesson).** The executed sandbox proof showed the original design
silently writing PREVIEW data into the PRODUCTION database: the envfile phase
appended only PORT + DATABASE_URL, while the app under test reads
APP_DATABASE_URL for its RLS write path — that var could only come from the
operator template, i.e. it pointed at prod. A preview POST returned 201 into
prod and the preview's own GET showed [] — dishonest both ways. The template
shape the host-prep comment told operators to produce was the dangerous one;
omitting the var instead hard-failed boot. Lesson: *any* env var an app reads
as a DB URL is part of the env-isolation contract, and the control plane must
be told which vars those are.

Design now:
- `app register --env-db-var <NAME>` (repeatable, validated against
  `[A-Za-z_][A-Za-z0-9_]*`; default `DATABASE_URL`) persists
  `AppRecord.envDbVars` — the set of env vars that MUST point at the per-env
  database.
- The create script's envfile phase (template backend) rewires each mapped
  var ON THE HOST: read its value from the copied template, rewrite ONLY the
  db-name path component of the URL (scheme/user/password/host/port/query
  preserved; port and `?params` optional; double-quoted values accepted),
  STRIP the original line (dotenv loaders are app-dependent; systemd
  EnvironmentFile is last-wins, but append-only composition is unsafe), and
  hard-fail the phase if a mapped var is missing or not a URL — an env that
  could inherit production is never composed. samohost never sees the values;
  the script never echoes them.
- **Per-env roles were DROPPED** (issue #11 findings 2+3): the env keeps the
  SAME roles as production, so the grants copied with the template database
  and the app's RLS policies apply unchanged — the prod URL contract
  (e.g. "DATABASE_URL bypasses RLS, APP_DATABASE_URL is the policy-fitted app
  role") survives into the preview. Trade-off, accepted for the SOLO plan:
  inter-env isolation is weaker (all envs share prod's roles); an env can
  technically reach a sibling env's db. Previews are same-trust-domain here.
- **Re-run semantics**: the db phase is drop-if-exists + recreate, so create
  re-runs are genuinely idempotent — and a re-run RESETS per-env db data
  (previews are disposable; the CLI failure guidance says so).
- dblab backend: envDbVars mapping is a TODO entangled with the clone-status
  port-field fix (issue #7) — clones need host:port rewired per
  `dblab clone status`, with template creds kept (they exist in the physical
  clone). Until then dblab keeps its original append-DATABASE_URL shape.

**Deterministic template-DB creation (operator runbook).** `createdb -T <src>`
requires ZERO other connections on `<src>`, and lazy connection pools make the
naive check RACY-GREEN (an idle app holds no connections; the copy succeeds
until the first pooled request). Procedure:
1. `systemctl stop <app-unit>`
2. `sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM
   pg_stat_activity WHERE datname='<src>' AND pid<>pg_backend_pid();"`
3. `sudo -u postgres createdb -T <src> <app_name_underscored>_template`
4. `systemctl start <app-unit>` and verify health.
(Alternative without downtime: `pg_dump <src> | psql <template>`.) With the
same-roles design no extra grants are needed inside the template.

One-time root setup is NOT auto-applied: `env plan --host-prep` renders the
reviewable script (systemd template unit, Caddy sites.d include, exact-path
sudoers grants, env template file) for an operator with root.

State: envs live in their own document `~/.samohost/envs.json` (EnvStore,
identity (vmId, appName, branch)) — NOT as child records of the VM record as
originally sketched: the VM store stays lifecycle-only and the stores share the
atomic-write contract, mirroring apps.json.

Create/destroy run as pushed scripts over ONE pinned SSH connection with
`<<<SAMOHOST_PHASE:...>>>` markers (env/parse.ts outcomes: ok|failed|incomplete).
No rollback in env scripts: a failed create stays recorded (name/port pinned) so
re-create is idempotent and destroy is the cleanup path.

DNS decision (deferred automation): previews assume a ONE-TIME wildcard A record
`*.samo.cat → VM IP` at the registrar (Namecheap), so no per-env DNS API calls
are needed and Caddy gets per-vhost certs via HTTP-01. The Cloudflare adapter
(§5) is only needed if the preview domain moves to a Cloudflare zone.
**Preflight:** `samohost dns status samo.cat --expect-ip <vm-ip>` (§5) verifies
the wildcard exists before any env is created; as of 2026-06-11 it does NOT.

**DBLab preflight (installed shape ≠ running engine).** The live SOLO VM has
the dblab.service unit file (ExecStart=/usr/local/bin/dblab-engine) and the
tank/dblab|postgresql|previews ZFS datasets — but the service is inactive+
disabled, the engine binary and dblab CLI are absent, and nothing listens on
the API port. `samohost env preflight <vm>` (read-only probes batched into ONE
SSH connection via audit/batch.ts; pure evaluation in src/dblab/preflight.ts)
reports the dblab-engine gate as READY | BLOCKED | UNKNOWN with per-check
detail and reasons, plus the `--db template` fallback's readiness (local
Postgres on 127.0.0.1:5432 — currently READY). `env create --db dblab` is
additionally gated ON-HOST: a `db-preflight` script phase refuses to attempt a
clone unless dblab.service is active AND the dblab CLI exists, pointing at
`env preflight` for diagnosis.

### 5. DNS provider port + preflight — **IMPLEMENTED (adapter unwired by design)**

Live facts (verified 2026-06-11): previews target `<app>-<branch>.samo.cat`,
but samo.cat is on **Namecheap registrar nameservers** and `*.samo.cat` does
not resolve, while the operator's Cloudflare token/config cover samo.team +
samo.green only. Full analysis and unblock options:
`docs/dns-preview-authority.md`.

- `samohost dns status <domain> [--expect-ip <ip>]` (src/commands/dns.ts) —
  READ-ONLY preflight: classifies authority from NS records
  (cloudflare | namecheap | other | unresolved), probes a synthetic label to
  detect the wildcard (present | absent | mismatch | unknown), checks token
  PRESENCE only, and reports `serving_ready` (wildcard → VM; what previews
  need) separately from `automation_ready` (Cloudflare authority + token +
  zone coverage). Pure evaluation in src/dns/preflight.ts; resolver injected.
- **Proxied (orange-cloud) semantics** (added 2026-06-11 after the live
  `*.samo.cat` proxied wildcard was falsely reported `mismatch`): public DNS
  returns CF EDGE IPs for proxied records, never the origin, so the public
  probe cannot judge origin targeting. When authority is Cloudflare + token
  present + zone covered, `dns status` verifies the record's CONTENT/proxied
  state at the CF API (read-only zone-by-name + record GETs,
  `lookupWildcardRecord`) and uses it as authoritative; the public probe only
  answers delegation/propagation. Report carries `wildcardSource`
  (cloudflare-api | public-dns), `proxied`, `observedIps`. Without API access
  on a CF zone, non-origin IPs ⇒ `unknown` (never false `mismatch`); non-CF
  authority keeps direct comparison. CF API errors are token-redacted before
  any output (tested).
- `DnsProviderPort` + `CloudflareDns` adapter (src/dns/cloudflare.ts):
  `listRecords` / `ensureRecord` (idempotent: create / update / no-op) /
  `removeRecord`, injected fetch, unit-tested against mocks. **No CLI write
  path calls it** — live DNS writes stay out of scope until a samo.cat-scoped
  token exists and the cutover is approved. Token via `CLOUDFLARE_API_TOKEN`;
  zone ID supplied in config (zone-scoped tokens may lack list scope).

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

## Deferred from the env milestone (tracked, not lost)
- `env gc` (reap envs whose branch is merged/deleted; TTL-based).
- Cloudflare DNS adapter WRITES — adapter implemented + tested (§5) but
  deliberately unwired; needs a samo.cat-scoped token and an approved cutover.
- Namecheap DNS provider — only if samo.cat stays on Namecheap AND needs
  ongoing automation (see docs/dns-preview-authority.md; one manual wildcard
  avoids it entirely).
- Hetzner `provision`/rebuild path — blocked on HCLOUD_TOKEN availability on the operator machine.
- DBLab Engine INSTALL on the platform VM — preflight now detects/blocks
  (installed shape only: unit file + ZFS datasets, no engine binary, service
  dead); the `dblab` CLI calls in env scripts remain plan hooks until
  `env preflight` reports READY.
- GitHub Actions runner registration — blocked on a repo-admin token; exact handoff + execution sequence documented in `docs/runner-admin-handoff.md`.
