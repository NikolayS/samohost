# samohost

`samohost` is an operator-local TypeScript/Bun CLI that provisions and manages
security-hardened Linux VMs (Hetzner Cloud in v0.1; AWS deferred), deploys apps
onto them, and stands up per-git-branch preview environments — with the full
hardening baseline baked into every VM and all state kept on your own machine.
There is no server to run and provider credentials never leave the operator host.

## Install / run

Requires [Bun](https://bun.sh). From a clone of this repo:

```bash
bun install
bun run src/cli.ts --help          # or: bun run src/cli.ts <command>
```

State lives at `~/.samohost/` (VMs, apps, envs, pinned host keys). Provider
credentials come from the environment: `HCLOUD_TOKEN` for Hetzner.

**Running samohost autonomously (bot operator):** start with
[`docs/setup-checklist.md`](docs/setup-checklist.md) — the single ordered list
of every token, scope, and prerequisite needed before any write/network command
works (Hetzner / GitHub / Cloudflare DNS / Cloudflare Workers / runner-admin PAT
/ SSH keypair + host-key fingerprint). Then:
[`docs/control-plane-setup.md`](docs/control-plane-setup.md) (what runs where +
the trigger `.service`/`.timer` + one-time root host-prep ordering),
[`docs/preview-reachability.md`](docs/preview-reachability.md) (the CF-proxied
origin / origin-TLS decision + the external reachability gate),
[`docs/dblab-install-runbook.md`](docs/dblab-install-runbook.md),
[`docs/dns-preview-authority.md`](docs/dns-preview-authority.md),
[`docs/edge-preview-banner.md`](docs/edge-preview-banner.md), and
[`docs/air-conformance.md`](docs/air-conformance.md) (the CI-enforced mapping of
each [postgres-ai/air](https://gitlab.com/postgres-ai/air) hardening directive to
samohost's cloud-init baseline + `doctor` probes — generated, never hand-edited).

## Command surface

Every command supports `--json` except the interactive/streaming pair
(`ssh`, `logs`). Read-only commands make no provider calls unless noted.

```bash
# Provision / teardown a hardened VM (real Hetzner API; needs HCLOUD_TOKEN)
samohost provision --provider hetzner --region nbg1 --type cx23 --name web --ssh-key ~/.ssh/id_ed25519
samohost destroy web                       # typed-name confirmation unless --yes; volumes reported, never deleted
samohost preview --provider hetzner --region nbg1 --type cx23 --ssh-pubkey @~/.ssh/id_ed25519.pub  # render cloud-init only, no API call

# Adopt an existing VM into state (no provider call; host key pinned at adopt time)
samohost adopt --name web --ip 10.0.0.5 --ssh-user samo --ssh-key ~/.ssh/id_ed25519 --host-key-fingerprint 'SHA256:…'

# Observe
samohost list
samohost status web --audit                # SSHes in, runs read-only hardening probes (pass/fail/unknown)
samohost ssh web                           # interactive shell over the pinned host key (no keyscan, no TOFU)
samohost ssh web -- uptime -p              # …or run a one-off command; remote exit code is returned
samohost logs web --lines 200 --follow     # systemd journal via sudo journalctl; unit defaults to the single
                                           # registered app's service unit (use --unit with 0 or >1 apps)

# Deploy an app (CI-gated, RLS-checked, env-file sourced, rollback-safe)
samohost app register web --name field-record --repo owner/repo --service-unit field-record --health-url http://127.0.0.1:3000/api/version --env-file /opt/app/staging.env --assert-rls --rls-url-var APP_DATABASE_URL
samohost app register web --from-toml .samohost.toml  # …or read every app field from a repo-side manifest (see "App manifest")
samohost app plan web field-record --sha <sha>     # print the deploy script, no execution
samohost app deploy web field-record --sha <sha>   # CI-green gate; --skip-ci-gate / --force to override
samohost app status web field-record
samohost app clear-failed web field-record         # clear a recorded known-bad SHA

# Per-branch preview environments (vhost <app>-<branch>.<domain>, own DB per env)
samohost env preflight web                          # is the DBLab engine / template fallback ready?
samohost env plan web field-record --host-prep      # render the one-time root host-prep for review
samohost env create web field-record --branch feat/x --db dblab   # or --db template | none
samohost env list web
samohost env destroy web field-record --branch feat/x

# Preview DNS preflight (read-only)
samohost dns status example.com --expect-ip 10.0.0.5 --cf-zone example.com

# Auto-deploy (samo-level) — replaces per-client on-box deploy timers
samohost trigger run                              # poll all registered apps; deploy where SHA changed
samohost trigger run --vm web --app field-record  # narrow to one app
samohost trigger run --dry-run --json             # report what would deploy, no SSH
```

### Auto-deploy (samo-level)

`samohost trigger run` is the ONE samo-level mechanism that replaces
per-client on-box deploy timers. It performs one idempotent poll cycle:

1. Enumerates all registered apps (optionally narrowed by `--vm`/`--app`).
2. Skips apps on VMs not in `{ready, adopted}` lifecycle state.
3. For each candidate, resolves the tracked-branch HEAD SHA via the GitHub API.
4. Compares the resolved SHA to `app.deployedSha`:
   - **equal** → no-op (`up-to-date`).
   - **equals `app.failedSha`** → skip early (`known-bad`), avoiding a pointless
     SSH/CI round-trip; `runAppDeploy` would also catch it.
   - **different** → delegates to `runAppDeploy` with the resolved SHA passed
     explicitly (so `runAppDeploy` never resolves twice).
5. `runAppDeploy` enforces the CI-green gate, health-200 gate, known-bad
   guard, and rollback — the trigger adds only the iteration/scheduler layer.
6. One app's failure or error does not abort the cycle (per-app isolation).

Intended to run from a samohost-managed control-plane systemd timer, e.g.:

```ini
# /etc/systemd/system/samohost-trigger.timer
[Timer]
OnCalendar=*:0/5       # every 5 minutes
[Install]
WantedBy=timers.target
```

Exit 0 when every candidate ended in `{deployed, up-to-date, known-bad,
skipped, would-deploy}`; exit 1 when any deploy returned non-zero or threw.

### SPEC v0.1 coverage

Implemented from the [SPEC v0.1](SPEC.md) minimum surface: `provision`
(Hetzner), `preview` (offline, Hetzner + AWS render), `list`, `status`
(+`--audit`), `ssh`, `logs`, `destroy` — plus `adopt` and the `app`/`env`/`dns`
families added by [SPEC-DELTA](SPEC-DELTA.md). Still **deferred** from v0.1
scope (the README documents only what works):

- **postgres module** (PG17 + PostgREST + Caddy + audit checks) —
  [#26](https://github.com/NikolayS/samohost/issues/26). `--module postgres`
  currently renders the hardening baseline only.
- **AWS adapter** for `provision`/`destroy` —
  [#15](https://github.com/NikolayS/samohost/issues/15) (item 1). `provision
  --provider aws` is rejected at parse time; `preview --provider aws` works.

## 5-minute quickstart (adopt → deploy)

For an existing hardened VM with a non-root sudo user on a custom SSH port:

```bash
# 1. Adopt it (verify the fingerprint out-of-band first; it is pinned for all later SSH)
samohost adopt --name web --ip <ip> --ssh-user samo --ssh-key ~/.ssh/id_ed25519 \
  --host-key-fingerprint 'SHA256:…'
samohost status web --audit                         # confirm the hardening baseline

# 2. Register the app once (mirrors your deploy.sh), then deploy a SHA
samohost app register web --name myapp --repo owner/repo \
  --service-unit myapp --health-url http://127.0.0.1:3000/api/version \
  --env-file /opt/myapp/app.env --assert-rls --rls-url-var APP_DATABASE_URL
samohost app deploy web myapp --sha <sha>           # fetch → build → migrate → restart → health → RLS probe
```

`provision` instead of `adopt` gives you the VM too, from one command.

## App manifest (`.samohost.toml`)

Instead of passing every `app register` field as a flag, a client repo can
carry a `.samohost.toml` manifest and register from it:

```bash
samohost app register web --from-toml .samohost.toml
```

When `--from-toml` is given, **the manifest is the sole source of truth** — any
`app register` flags are ignored. Field names map **1:1** to the internal
`AppSpec` (no translation jargon). Unknown keys are **rejected** (typo
protection: a misspelled `helathUrl` fails loudly), and validation collects
**all** errors before returning (never bail-on-first). The parser is
`src/manifest/toml.ts`; a fully-commented example is at
[`docs/examples/.samohost.toml.example`](docs/examples/.samohost.toml.example).

```toml
# [app] — required
name        = "field-record-1"                     # app name, unique per VM
repo        = "Tanya301/field-record-1"            # GitHub owner/name
branch      = "main"                               # tracked branch
appDir      = "/opt/field-record-1/app"            # remote checkout dir
buildCmd    = "npm run build"                       # build command
healthUrl   = "http://127.0.0.1:3000/api/version"  # post-deploy health URL (must 200)
serviceUnit = "field-record-1"                      # systemd unit restarted on deploy

# [app] — optional
# migrateCmd      = "npm run migrate"
# seedCmd         = "npm run seed"
# envFile         = "/opt/field-record-1/app.env"   # sourced read-only on deploy; never read/written by samohost
# mainHost        = "field-record-1.samo.team"       # public production host for the main-env Caddy vhost
# rlsUrlVar       = "RLS_DATABASE_URL"               # env var holding the non-superuser URL for the RLS probe
# envDbVars       = ["DATABASE_URL"]                 # vars whose DB host:port is rewritten per preview env
# rlsNonSuperuser = true                             # require non-superuser connection (RLS gate)
# kind            = "node"                            # "node" (default) | "static"
# staticRoot      = "dist"                            # static only: repo-relative served directory; default repo root
# releaseTagPattern = "v*"                            # opt in to tag-only production
# releaseTagFormat  = "date"                          # required: vYYYYMMDD.N, real dates only
# releaseCiWorkflow = ".github/workflows/ci.yml"      # required: canonical trusted Actions workflow

# [provision] — OPTIONAL; parsed + validated but NOT yet consumed by app register
# (reserved for a future `provision --from-toml`). Allowed keys only:
# [provision]
# serverType = "cx22"
# location   = "nbg1"
# [provision.labels]
# team = "field-record"
```

No secrets ever belong in the manifest — it lives in a (often public) client
repo. Database URLs / tokens stay in the app's own `--env-file` on the host.

### Database roles and env files of a node app

`app bootstrap --db-name <db>` creates two PostgreSQL roles for a node app,
both without superuser, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS:

- `<db>_app`: the role the running app uses (`APP_DATABASE_URL`).
- `<db>_owner`: the owner of database `<db>` and nothing else, used by
  `migrateCmd` and `seedCmd` (`DATABASE_URL` in the migrate env file).

CONNECT on `<db>` is revoked from PUBLIC and granted to these two roles.
Passwords are generated on the server and kept on re-runs.

`<db>_owner` owns schema `public` of `<db>`, so migrations can create
tables in it (PostgreSQL 15 and later give CREATE on `public` only to its
owner). `<db>_app` gets USAGE on schema `public`, SELECT, INSERT, UPDATE and
DELETE on tables, and USAGE, SELECT and UPDATE on sequences: as default
privileges for objects that `<db>_owner` creates later, and as grants on the
objects that exist when bootstrap runs. A bootstrap re-run grants these
rights again on all existing tables, including tables from which a migration
revoked them; the next migrate run revokes them again. If
`APP_DATABASE_URL` names a role that samohost did not create, that role and
the line are left unchanged, and the role gets CONNECT on `<db>` and the
same rights.

What the app sees:

- new layout: the running app has `APP_DATABASE_URL` and no
  `DATABASE_URL`. `DATABASE_URL` (the owner role) and `APP_DATABASE_URL`
  are both set only for `migrateCmd` and `seedCmd`.
- old layout (bootstrapped by an older samohost): the running app keeps
  `DATABASE_URL` (the superuser) and `APP_DATABASE_URL`.

Two env files sit next to each other on the server:

- the runtime env file (`envFile`, loaded by the systemd unit): the app's
  `APP_DATABASE_URL` and no other database address;
- `migrate.env` in the same directory: the owner role's `DATABASE_URL` and
  `SEED_OWNER_LOGIN` / `SEED_OWNER_PASSWORD`. Only the deploy's migrate and
  seed steps load it. `npm ci` and the build run with no database address in
  their environment.

An app bootstrapped by an older samohost has the superuser `DATABASE_URL` in
its runtime env file and no `migrate.env`. Bootstrap and deploy detect that
and keep it as it is. To move such an app to the new layout:

1. As root on the server, remove the `DATABASE_URL=postgresql://postgres:...`
   and `SEED_OWNER_*` lines from the runtime env file.
2. Run `app bootstrap` again. It now uses the new layout: it creates
   `<db>_owner`, makes it the owner of `<db>`, writes `migrate.env`, and prints
   a warning when objects in schema `public` are owned by another role.
3. As root, give those objects to `<db>_owner`
   (`sudo -u postgres env PGOPTIONS='-c search_path=pg_catalog' psql -d <db>`,
   then `ALTER TABLE public.<name> OWNER TO <db>_owner;` for each table, view
   and unowned sequence), so migrations can alter them. Keep the
   `search_path` setting: the owner of `<db>` can set the database's
   `search_path`, and a superuser session that resolves names through
   `public` could run functions that role wrote.
4. Deploy. The next deploy finds `migrate.env` and uses the new layout.

### Client addresses behind the control plane (cp-http80 node apps)

The control plane proxies to this server's Caddy on port 80, and Caddy
proxies to the app on `localhost:<port>`. Caddy's main vhost, including the
favicon route, keeps the X-Forwarded-For entries of the control-plane
address only (`trusted_proxies`). The runtime env file gets
`TRUSTED_PROXIES=127.0.0.1,<control plane address>`: the app's TCP peer is
Caddy on 127.0.0.1 (the app listens on `HOST=0.0.0.0`), then the control
plane. Bootstrap, heal and host-prep use the control-plane address
recorded for the VM; `app bootstrap --control-plane-ip` with a different
address is refused.

### Rollback of a node deploy

A node deploy runs fetch, checkout, install, build, migrate, restart and the
health check. `dist/` is copied to `dist.prev/` before install and build.

- If install, build or migrate fails and a previous release exists (`dist/`
  was present before the deploy), the deploy resets the checkout to the
  previous commit and restores `dist/` from `dist.prev/`. The service was not
  restarted and keeps running the previous release; its health is checked.
- If the health check fails after the restart, the deploy restores the same
  files and `release.env`, restarts the service and checks health again.
- On a first deploy (no `dist/` before it) a failure is reported without a
  rollback.

Migrations that already ran are not undone, in either case. `node_modules`
is not restored. The previous release must therefore work with the new
schema: add columns as nullable or with a default, and drop a column only
in a release after the code stopped using it. samohost records the commit as
failed (`failedSha`) after a rollback and does not deploy it again until
`app clear-failed`.

### Runtime user and service hardening of a node app

This applies to node apps with the split env layout (a `migrate.env` next to
the runtime env file; every new node app). Static apps and node apps that
keep the legacy layout get the same sudo rules and unit as before.

- The service runs as `<app>-run`: a system user with no login shell, no
  sudo rules and its own group only. It reads the release through the
  world-read bit of the checkout, `node_modules` and `dist/`, and writes only
  `/opt/<app>/uploads`. systemd reads `EnvironmentFile=` files before it
  drops to this user, so the runtime env file stays mode 600.
- The unit sets `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, `PrivateDevices`, the kernel and cgroup protections,
  `RestrictSUIDSGID`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, an
  empty `CapabilityBoundingSet`, `LockPersonality`, `MemoryMax=50%`,
  `TasksMax=256`, `ReadWritePaths=/opt/<app>/uploads`, and
  `InaccessiblePaths=` for `migrate.env`, `.gh-token`, `git-safe.conf`, the
  checkout's `.git` and `.npmrc`. `MemoryDenyWriteExecute` is not set
  because Node's JIT needs it off.
- `/opt/<app>` is root-owned (755). The deploy user owns only the checkout
  `/opt/<app>/app`, and the runtime user owns `/opt/<app>/uploads`. Nobody
  but root can create, rename or replace entries next to the files that
  root writes and systemd reads (the env file, `migrate.env`,
  `release.env`, `git-safe.conf`, the token file), so a symbolic link
  cannot point root or systemd at another file. Bootstrap refuses symbolic
  links that an earlier deploy user left there.
- The deploy user keeps building and deploying. It writes `release.env`
  through an exact `sudo /usr/bin/tee /opt/<app>/release.env` rule. Its
  other sudo rules name exact files: `00-main-<app>.caddy` and the heal
  staging file
  `.samohost-heal-next-00-main-<app>.caddy`. For preview vhost files it gets
  sudo regular expressions (sudo 1.9.10 or later) that match only
  `/etc/caddy/sites.d/<app>-<label>.caddy` with the label in `[a-z0-9-]`.
  It has no `journalctl`, `daemon-reload` or `psql` rule: `samohost logs`
  and `samohost doctor` connect as the operator user, and the deploy and
  heal scripts of these apps do not use the other two.
- The deploy sets `umask 022` so the runtime user can read what it builds.

Previews of these apps are not built yet. They will need rules for
`systemctl enable --now`, `disable --now` and `reset-failed` of the preview
instance `<app>@<label>`, and a way to create and drop the preview database
that is not `psql` as `postgres`. The preview unit should use the same
runtime user and hardening.

To move an existing server that already has `migrate.env`:

1. Run `samohost app bootstrap` again. It creates `<app>-run`, gives it
   `/opt/<app>/uploads`, rewrites the sudo rules and the unit, and runs
   `systemctl daemon-reload`. The running service keeps its old user until
   it restarts.
2. Deploy, or restart the service. It then runs as `<app>-run`.
3. If the app writes files anywhere other than `/opt/<app>/uploads`, those
   writes now fail. Move that data under `uploads/` first.

## How it's tested

- **Unit + golden/snapshot:** `bun test` (457 tests; rendered deploy/env scripts
  are snapshot-pinned so a contract change is a visible diff). Typecheck with
  `bunx tsc --noEmit`. CI runs both on every PR.
- **Executed validation:** write-path changes are re-run end-to-end in a
  disposable Docker sandbox before any real host, and the whole lifecycle
  (`provision → status --audit → app deploy → env create → destroy`) has been
  run against a real Hetzner VM with zero-orphan teardown. samohost deployed
  its first production app and first live preview environment this way.

## Design

See [SPEC.md](SPEC.md) for the architecture, lifecycle state machine, and the
provider/module abstractions, and [SPEC-DELTA.md](SPEC-DELTA.md) for the
adopt/app/env/provision amendments driven by real deployments.
