# DBLab Engine install runbook — SOLO VM (root operator)

Target: `samo-we-field-record` (Ubuntu 24.04, host PostgreSQL 18, ZFS pool `tank`,
8 GB cx33 also running prod + CI). Goal: per-git-branch preview databases as thin
clones, consumed by `samohost env create --db dblab`.

Researched 2026-06-11 against DBLab **v4.1.3** (canonical repo:
`gitlab.com/postgres-ai/database-lab`; config reference:
<https://postgres.ai/docs/reference-guides/database-lab-engine-configuration-reference>;
CLI reference: <https://postgres.ai/docs/reference-guides/dblab-client-cli-reference>).
The `postgres-ai/air` infrastructure prototype is not publicly accessible (403/404);
the maintained public analogues are `postgres-ai/dle-se-ansible` and the
`engine/configs/` examples at tag `v4.1.3`.

## Hard facts that shape this install

1. **Docker is mandatory. There is no no-Docker mode.** The engine ships as the
   `postgresai/dblab-server` image (privileged, mounts the Docker socket), and
   **every clone is a Postgres Docker container** (`provision.dockerImage` is a
   required config field). ⇒ **The AppArmor `runc` profile fix is a hard
   prerequisite** — until `docker run --rm hello-world` passes on the VM, nothing
   here can proceed.
2. **The existing `dblab.service` unit is built on a false premise.** Its
   `ExecStart=/usr/local/bin/dblab-engine` references a native server binary that
   does not exist as a published artifact (only the *client* `dblab` ships as a
   bare binary). Replace the unit with the docker-run model below (or let
   `--restart on-failure` supervise).
3. **DBLab does not adopt the existing host PG data dir.** It maintains its own
   copy of the database under its `poolManager.mountDir` and snapshots/clones
   *that*. Prod data stays on `tank/postgresql` untouched; DBLab gets
   `tank/dblab` (already reserved) and holds a **second full copy** there —
   budget disk accordingly (ZFS compression helps).
4. **Retrieval mode: use `logical`** (pg_dump/pg_restore from host PG18 on
   127.0.0.1:5432). Physical mode needs basebackup/WAL tooling we don't run.
   Logical refresh puts real dump load on prod — schedule off-peak, low cadence
   (nightly at most).

## Root steps (copy-paste, in order)

```bash
# 0. PREREQ — Docker must actually start containers (AppArmor fix first)
docker run --rm hello-world   # MUST pass; otherwise stop here

# 1. ZFS dataset (keeps everything on tank; prod dataset untouched)
zfs list tank/dblab || zfs create tank/dblab
zfs set mountpoint=/var/lib/dblab compression=on atime=off logbias=throughput tank/dblab
zfs list -o name,mountpoint,avail tank/dblab

# 2. Images (verify a PG18 clone-image tag exists on Docker Hub before pulling;
#    18-0.6.2 came from the v4.1.3 config example)
docker pull postgresai/dblab-server:4.1.3
docker pull postgresai/extended-postgres:18-0.6.2

# 3. Config
mkdir -p /root/.dblab/engine/configs /root/.dblab/engine/meta
curl -sSL https://gitlab.com/postgres-ai/database-lab/-/raw/v4.1.3/engine/configs/config.example.logical_generic.yml \
  -o /root/.dblab/engine/configs/server.yml
# Edit server.yml:
#   server.verificationToken: <strong random; store at /root/.dblab/token, 600>
#   server.port: 2345
#   poolManager.mountDir: /var/lib/dblab
#   provision.portPool: {from: 6000, to: 6099}
#   provision.dockerImage: "postgresai/extended-postgres:18-0.6.2"
#   provision.cloneAccessAddresses: "127.0.0.1"
#   retrieval (logical): source = host PG18 at 172.17.0.1:5432 (or host-gateway),
#     db field_record, a read-only dump role; schedule: nightly
#   databaseConfigs: shared_buffers 256MB, work_mem small  # 8GB VM — see sizing
# NOTE: host PG must accept connections from the Docker bridge for logicalDump
# (pg_hba.conf + listen_addresses) — add a dump-only role, scram, bridge subnet.

# 4. Run the engine (Docker supervises; API on localhost only)
docker run --name dblab_server --label dblab_control --privileged \
  --publish 127.0.0.1:2345:2345 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /var/lib/dblab:/var/lib/dblab/:rshared \
  --volume /root/.dblab/engine/configs:/home/dblab/configs:ro \
  --volume /root/.dblab/engine/meta:/home/dblab/meta \
  --detach --restart on-failure \
  postgresai/dblab-server:4.1.3

# 5. Retire the dead unit; verify
systemctl disable --now dblab.service || true   # ExecStart binary doesn't exist
curl -s http://127.0.0.1:2345/healthz; docker logs dblab_server --tail 20

# 6. Client CLI (single binary) + init
DBLAB_CLI_VERSION=4.1.3 bash -c 'curl -sSL https://dblab.sh | bash'
dblab init --environment-id solo --url http://127.0.0.1:2345 \
  --token "$(cat /root/.dblab/token)" --insecure
```

## Acceptance (what samohost preflight should then see)

- `curl -s http://127.0.0.1:2345/healthz` → healthy; engine container running.
- One full round-trip:
  `dblab clone create --username samohost_env --password <pw> --id smoke-1`
  → `dblab clone status smoke-1 | jq -r '.db.port'` returns a port (jq is fine
  for an operator one-liner; samohost itself parses without jq, see below) →
  `psql` connects on 127.0.0.1:<port> → `dblab clone destroy smoke-1`.
- `samohost env preflight <vm>` reports the dblab backend READY.

## samohost contract corrections — LANDED (issue #7, runtime-verified 2026-06-12)

All three corrections below are implemented in `src/env/script.ts` +
`src/dblab/preflight.ts` and verified against the LIVE engine:

- **Port parsing**: `dblab clone status` returns the port at **`.db.port`** as
  a **string** (verified against `engine/pkg/models/clone.go` + `database.go`
  @ v4.1.3 AND against the live engine's JSON, captured into
  `test/fixtures/dblab-clone-status.json`). The generated script's
  `samohost_clone_port()` parses it with python3 (sed fallback anchored to the
  `"db"` object) — no jq dependency on hosts.
- **Engine liveness gate** probes `http://127.0.0.1:2345/healthz` and resolves
  the CLI via `command -v dblab` then `~/bin/dblab` (the install location
  above is NOT on PATH in non-login shells). `systemctl is-active
  dblab.service` is gone everywhere — the unit is retired (its ExecStart
  binary never existed as a published artifact).
- **envDbVars mapping**: the dblab envfile phase rewrites ONLY host:port of
  each mapped var to `127.0.0.1:<clone-port>`; the operator template's
  user/password/dbname carry over. ⚠️ LOGICAL retrieval does NOT carry
  cluster roles, and the restore drops grants/RLS policies whose roles are
  missing (live-verified) — the db phase repairs this by replaying
  roles/ownership/grants/policies from the prod catalogs into the clone and
  gating on policy parity (`samohost_sync_clone_globals`). See SPEC-DELTA §4.
- Still open (filed separately):
  - engine-side root fix: `logicalRestore.queryPreprocessing` SQL that creates
    the prod roles (with hashes) BEFORE restore, so grants/policies restore
    natively and the samohost-side sync becomes a no-op;
  - `dblab clone create --branch <git-branch>` (4.x native branching) for
    per-branch previews instead of bare `--id`.

## Re-creating a dblab preview is NOT yet idempotent (issue #59)

A **second** `env create … --db dblab` for an env whose previous create already
made a DBLab clone fails the **db phase**:

```
<<<SAMOHOST_PHASE:db:start>>>
failed to get response: clone with ID "<env-name>" already exists
<<<SAMOHOST_PHASE:db:fail>>>
```

This aborts before the vhost/health phases, so the env is never re-served.
(The `--db template` backend does NOT have this problem — its db phase is
`dropdb --if-exists` + `createdb --template`, i.e. recreate semantics. Only the
dblab backend currently fails on a pre-existing clone.)

**Remedy until #59 lands the `clone destroy` self-heal:** before re-creating a
dblab preview, destroy the env first so its clone is removed, then create again:

```bash
bun run src/cli.ts env destroy <vm> <app> --branch <b>   # runs `dblab clone destroy <id>`
bun run src/cli.ts env create  <vm> <app> --branch <b> --db dblab
```

If `env destroy` cannot run (no record), hand-destroy the clone on the VM:
`dblab clone destroy <env-name>` (the clone id is the env name). A bot hitting
the `clone with ID "…" already exists` db-phase failure should treat it as
"destroy-then-recreate", **not** retry the bare `env create`.

## Sizing guardrails (8 GB VM with prod + CI)

- Each clone container gets its own `shared_buffers`/shm (example config ships
  1 GB each — **lower to 256 MB** in `databaseConfigs`). Cap concurrent previews
  (2–3), but do not set short clone idle expiry for PR previews. Open PR
  previews are cleaned up by samohost when the PR is merged or closed, or by
  explicit `env destroy`; DBLab expiring the clone underneath a still-running
  preview leaves the app process up with a dead database and can show Internal
  Server Error. Set `maxIdleMinutes: 20160` (14 days) or `maxIdleMinutes: 0`
  (disabled) unless samohost's own idle reaper is configured to destroy the
  whole preview first.
- DBLab on this box adds: engine container + second DB copy on `tank/dblab` +
  one PG container per clone. Watch `MemAvailable` before raising caps; CI's
  fence is 3 G.

## Open items

- Confirm `postgresai/extended-postgres:18-*` tag availability (UNVERIFIED).
- `postgres-ai/air` prototype inaccessible — re-consult if access is granted.
