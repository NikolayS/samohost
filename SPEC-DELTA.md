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
- **dblab backend** (default): DBLab Engine thin clone; clone id = env name; the
  mapped `envDbVars` are repointed at the clone's port (see the issue #7
  contract below). Destroy = clone delete. The CLI calls are runtime-verified
  against the live v4.1.3 engine (issue #7, 2026-06-12) — no longer plan hooks.
- **template backend** (fallback when the engine is down; see #21 for the
  staleness trade-off):
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
- **dblab backend mapping (issue #7, closes the PR #12 TODO)**: the dblab
  envfile phase applies the SAME envDbVars mapping, but rewrites ONLY the
  host:port of each mapped var to `127.0.0.1:<clone-port>` (the engine's
  `cloneAccessAddresses` + 6000–6099 port pool), with the clone port read from
  the NESTED `.db.port` STRING in `dblab clone status` JSON (v4.1.3 contract,
  fixture captured from the live engine; python3 parse with an anchored-sed
  fallback — no jq dependency). **Why credentials carry over (and what makes
  that true):** the SOLO engine's retrieval mode is LOGICAL — live-verified
  2026-06-12 that a fresh clone holds prod's database (same name, same
  tables) but NONE of prod's cluster roles, and that the restore silently
  dropped ALL grants and ALL 14 RLS policies because the roles they reference
  did not exist in the clone's cluster. So the db phase runs
  `samohost_sync_clone_globals`: it regenerates, from the PROD catalogs, the
  roles (attributes + password hashes via pg_authid, read through the
  exact-path sudo psql grant — hashes move host-side only, never through
  samohost), table ownership, table grants, and RLS policies (deparsed from
  pg_policies), applies them to the clone via the script's own on-host clone
  superuser (`clone create --username/--password` adds exactly that one extra
  role), and GATES the phase on policy-count parity with prod. After the
  sync, keeping the operator template's user/password/dbname preserves the
  prod URL contract ("DATABASE_URL bypasses RLS, APP_DATABASE_URL is the
  policy-fitted app role") exactly as the template backend's same-roles
  design does — verified live: sign-in with production credentials succeeds
  against a preview wired to a clone. On engines whose retrieval carries
  globals (physical mode) the sync degrades to ignored duplicate-DDL and an
  already-true parity check. Known limits (fine for this app, documented):
  sequence/function grants and default privileges are not replayed. The
  engine-side long-term fix (logicalRestore queryPreprocessing creating
  roles BEFORE restore, so grants/policies restore natively) is filed as a
  follow-up. The old append-only `DATABASE_URL=` shape is gone.

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

**DBLab preflight (the engine is a container; the unit is retired — issue
#7).** Runtime-verified 2026-06-12: the engine runs as the `dblab_server`
docker container (postgresai/dblab-server:4.1.3) with its API on
127.0.0.1:2345; the legacy `dblab.service` unit's ExecStart binary
(/usr/local/bin/dblab-engine) has no published artifact, and the CLI is
installed at `~agent/bin/dblab` (NOT on PATH in non-login shells). The
original preflight gated on the unit and reported false BLOCKED against the
live engine. Now: `samohost env preflight <vm>` (read-only probes batched into
ONE SSH connection via audit/batch.ts; pure evaluation in
src/dblab/preflight.ts) gates the engine verdict on the `/healthz` endpoint
answering AND the CLI resolving (PATH, then ~/bin/dblab), reports the
container model (image + status) as context, and never probes the retired
unit — plus the `--db template` fallback's readiness (local Postgres on
127.0.0.1:5432). `env create --db dblab` is gated ON-HOST by the same two
conditions in its `db-preflight` phase (so the verdicts cannot diverge),
pointing at `env preflight` and docs/dblab-install-runbook.md on failure.

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
- ~~DBLab Engine INSTALL on the platform VM~~ — DONE 2026-06-12 (container
  model per docs/dblab-install-runbook.md); `env preflight` reports READY and
  the env scripts' CLI calls are runtime-verified (issue #7).
- GitHub Actions runner registration — blocked on a repo-admin token; exact handoff + execution sequence documented in `docs/runner-admin-handoff.md`.

## Provision/destroy delta (v0.1 lifecycle, Hetzner-only — feat/provision)

### AWS deferred to post-v0.2
SPEC v0.1 §2 promised "Hetzner OR AWS" for provision. The shipped `provision`
is **Hetzner only**: the `Provider` port (src/providers/types.ts) is in place
and the orchestrator is provider-agnostic, but no AWS adapter exists yet and
`provision --provider aws` is rejected at parse time with a "deferred"
message. `preview --provider aws` still renders offline. Rationale: tonight's
from-scratch lifecycle test runs on Hetzner; the AWS SDK adapter is pure
add-on work behind the port.

### Provision-time host-key pinning is TOFU (trust on first BOOT)
`adopt` demands an out-of-band-verified fingerprint because the host predates
samohost. A freshly **provisioned** box has no out-of-band channel — samohost
created it seconds ago via the authenticated provider API — so the
booting→ready gate pins trust-on-first-boot: once `ssh-keyscan` answers on
the hardened port, ALL scanned key lines are fingerprinted (multi-key lesson
from #5), the **ed25519** key is preferred, its fingerprint is persisted in
`VmRecord.hostKeyFingerprint` and its line planted via `recordHostKey()`; all
subsequent SSH (including the cloud-init sentinel probes that gate `ready`)
runs `StrictHostKeyChecking=yes` against that pin. **Caveat:** the trust
window is the seconds between sshd answering and the first scan; an active
MITM inside that window could supply the pinned key. Acceptable for v0.1
cattle (same model as `gh`/cloud-init ecosystems); operators can compare
`samohost status` fingerprints against the provider console out-of-band.

### SSH keys are cloud-init-only (no Hetzner key resource)
`POST /v1/servers` is sent **without** `ssh_keys`: the hardening baseline
already plants the operator's public key for the non-root admin user, and
root login + password auth are disabled, so a provider-side key resource
would only add a second lifecycle (create/dedupe/cleanup) for zero security
gain. The `root_password` Hetzner returns in that case is ignored and never
surfaced. Delete protection is never enabled.

### Destroy surfaces volumes — never deletes them
`destroy` lists volumes attached to the server (server.volumes → volume
details) and prints `attached volume NOT deleted: id/name/size` before the
server DELETE. Data outlives cattle by default; volume deletion stays a
manual, deliberate act. On provider API failure the record stays
`destroying` (truthful + retryable); `notFound` counts as already-gone.
Crash reclaim: destroy is legal from `creating`/`booting` so a provision
that died mid-flight is never orphaned.

### 7. `trigger` — samo-level auto-deploy poller

#### The per-client timer problem

Before this feature, every client project shipped its own on-box deploy
timer (a systemd timer or cron job running `samohost app deploy` on the VM
itself). This had two failure modes:

1. **Operator explosion** — adding a new client or a new app required
   logging in to the project VM and manually installing a new timer unit.
2. **Credential sprawl** — each on-box timer needed `gh` auth to resolve
   SHAs and hit the CI gate, so GitHub tokens lived on every project VM
   instead of on the control plane where they belong.

#### The poller design

`samohost trigger run [--vm <name>] [--app <name>] [--dry-run] [--json]`
performs ONE idempotent poll cycle from the samo control plane:

1. Enumerate all registered `AppRecord`s joined to `VmRecord`s from the
   local state stores.
2. Filter: skip apps on VMs not in `{ready, adopted}` lifecycle state;
   apply `--vm`/`--app` narrowing when provided.
3. For each candidate, resolve the tracked-branch HEAD SHA via `resolveRef`
   (same `gh api repos/<owner>/<name>/commits/<ref>` call the `app deploy`
   path uses — injected for testability).
4. Compare resolved SHA to `app.deployedSha`:
   - **equal** → `up-to-date`; no deploy.
   - **equals `app.failedSha`** → `known-bad`; no deploy (early skip avoids
     a pointless SSH/CI round-trip; `runAppDeploy` would also catch it).
   - **different** → call the injected `TriggerDeploy` (the curried form of
     `runAppDeploy`) with the resolved SHA passed **explicitly** so
     `runAppDeploy` never calls `resolveRef` a second time.
5. `--dry-run` reports `would-deploy` / `up-to-date` / `known-bad` /
   `skipped` without calling `runAppDeploy` or touching any VM.
6. Per-app isolation: a thrown error or non-zero deploy for one app is
   recorded and reported (`action=error|failed`) but the cycle continues
   to the next app. No single app can abort the batch.

Exit codes:
- `0` — all candidates ended in `{deployed, up-to-date, known-bad, skipped,
  would-deploy}` AND no unexpected errors.
- `1` — any app's deploy returned non-zero or threw.

#### Why poller over webhook

Webhooks from GitHub require an inbound HTTPS endpoint with a secret, which
adds infra and surface area. A control-plane cron/timer is simpler:
idempotent, self-healing after downtime, and trivially tested offline. The
CI gate inside `runAppDeploy` means a red SHA is refused regardless of poll
frequency — over-polling is safe.

#### Why reuse `runAppDeploy` instead of reimplementing

`runAppDeploy` already enforces all deploy-time gates in one place:

- Known-bad-SHA guard (wedge prevention from false rollbacks)
- CI-green gate (`gh` check-runs, `checkCiGreen`)
- Health-200 gate (live HTTP probe after restart — added in #45)
- Rollback and bookkeeping

The trigger adds ONLY the "should we deploy?" iteration layer. This keeps
the gate logic in a single, well-tested function and ensures that the
samo-level poller and the manual `samohost app deploy` path share the
exact same enforcement. Changes to gates only need to be made in one place.

#### Dependency injection design

`TriggerDeps` has three fields:

```ts
export interface TriggerDeps {
  resolveRef: RefResolver;   // resolve repo+branch → SHA (no deploy)
  deploy: TriggerDeploy;     // CURRIED runAppDeploy (AppDeployDeps already bound)
  now: () => Date;
}
```

`deploy` is the CURRIED form — `AppDeployDeps` (SSH runner, fetch, clock)
are bound at the prod callsite inside `defaultTriggerDeps()`. The trigger
itself never sees `AppDeployDeps` and has no `fetch` field (no CI gate, no
SSH runner). Unit tests inject a fake `TriggerDeploy` that records calls
and returns a configurable exit code, keeping tests fully offline.

#### Generalizes to future clients

With per-client timers, adding a new game-changer or client project required
manual on-box setup. With `trigger run`, registering a new `AppRecord` (one
offline write to `~/.samohost/apps.json`) is sufficient — the next poll
cycle picks it up automatically. The poller scales horizontally across any
number of registered apps with zero per-app configuration.

### 8. Release-tag production channel

Driving issue: **#132** ("release-tag → production deploy channel").

#### The "every push ships prod" problem

Today the `trigger` poller (§7) tracks a single ref per app — the configured
`branch` HEAD — for BOTH the production main-env and (soon) branch previews.
That conflates two different release cadences: previews want *every* branch
push, but production wants to ship only on a deliberate, human-cut **release
tag**. Without a separate channel, any merge to `main` immediately deploys to
production the moment CI goes green.

#### The channel

A new OPTIONAL `AppSpec.releaseTagPattern?: string` (mirrored in the
`.samohost.toml` manifest and `app register`) opts an app into a **release-tag
production channel**:

- **ABSENT (default)** — behavior is byte-for-byte unchanged: production tracks
  `branch` HEAD via the existing `resolveRef(repo, branch)` path. Every existing
  `AppRecord` is untouched.
- **SET** — production tracks the **latest git tag matching the glob** instead
  of `branch` HEAD. Branch/`main` keep driving previews (PR2); prod ships ONLY
  on a new matching tag ("Tag ≠ ship" honored — a tag that does not advance the
  resolved sha is a no-op).

`releaseTagPattern` is independent of vhost management: existing registered
apps may opt into tag delivery whether or not they declare `mainHost`. A
non-string `releaseTagPattern` is rejected with a type error.

Activation is rollback-safe. For an app that already has `deployedSha`, the
first trigger cycle records the latest existing matching tag as a monotonic
cursor without deploying it. Only a strictly newer semver tag advances
production. If no tag exists during activation, the channel is armed empty and
the first subsequently-created matching tag is deployable. Re-registering with
a different pattern resets this internal cursor. This prevents enabling the
feature from rolling a newer production checkout back to a historical tag.

#### Tag resolution (`resolveLatestTag`)

A new GitHub client `resolveLatestTag(repo, pattern): Promise<{tag, sha} | null>`
(in `src/commands/app.ts`, beside `defaultRefResolver`):

1. Lists tags via `gh api --paginate repos/<repo>/tags`.
2. Filters names by the glob (`*`, `?`, `[...]` supported).
3. Sorts survivors by **SEMVER DESCENDING** — a leading `v` is stripped, so
   `v1.10.0 > v1.9.0 > v1.2.0` (numeric, not lexical). **Prereleases**
   (`-rc.1`, …) are EXCLUDED unless the pattern opts in (contains a `-`).
4. Takes the greatest, then **DEREFERENCES to a COMMIT sha** via
   `gh api repos/<repo>/commits/<tag>` — this resolves both lightweight AND
   annotated tags to the target commit (an annotated tag's own object sha is
   never returned).
5. Returns `{tag, sha}`, or `null` if no tag matches. **NEVER a branch-HEAD
   fallback.**

The selection logic is factored into a pure `selectLatestTag(names, pattern)`
and an IO-injected `makeResolveLatestTag(ghTagIo)` so semver ordering,
prerelease policy, and annotated-tag deref are unit-tested fully offline.

#### Trigger wiring (surgical; downstream reused verbatim)

`TriggerDeps` gains an OPTIONAL `resolveLatestTag?` (wired in
`defaultTriggerDeps` from the `app.ts` sibling; optional keeps every existing
test fixture valid). At the single resolve step in `runTriggerRun`:

- If `app.releaseTagPattern` is set AND `deps.resolveLatestTag` is wired →
  resolve the latest tag. `null` → record `action=skipped`, `reason=no-matching-tag`
  and continue (prod stays put; no branch fallback, no CI round-trip). Otherwise
  use its sha.
- Else → the existing `resolveRef(repo, branch)` branch-HEAD path, EXACTLY as
  before.

Everything downstream — the `deployedSha` up-to-date compare, the `failedSha`
known-bad short-circuit, `--dry-run`, `checkCiGreen` on the resolved sha, and
`runAppDeploy` — is REUSED UNCHANGED and already ref-agnostic.

#### Acceptance criteria (each traces to a red test in `test/release-tag.test.ts`)

- **§8 #1** semver ordering — `selectLatestTag` picks `v1.10.0` over `v1.9.0`
  over `v1.2.0` (numeric, not lexical).
- **§8 #2** prereleases excluded by a plain glob; included only when the glob
  opts in (contains `-`).
- **§8 #3** annotated-tag deref — the resolved sha is the COMMIT sha, obtained
  by dereferencing the winning tag NAME (not the tag-object sha).
- **§8 #4** no matching tag → `action=skipped`, `reason=no-matching-tag`, NO
  branch fallback (`resolveRef` never called), no CI call, prod `deployedSha`
  unchanged.
- **§8 #5** an app WITHOUT `releaseTagPattern` is byte-for-byte unchanged — the
  branch-HEAD path runs and `resolveLatestTag` is never consulted.
- **§8 #6** a new latest tag advances prod (`action=deployed`, deploy called
  once with the tag's sha); a tag already at `deployedSha` → `up-to-date`.
- **§8 #7** a failed tag deploy sets `failedSha`, which the known-bad
  short-circuit honors on the next cycle (no re-deploy, no CI round-trip).
- **§8 #8** existing schema behavior remains compatible:
  `releaseTagPattern` does not require `mainHost`.
