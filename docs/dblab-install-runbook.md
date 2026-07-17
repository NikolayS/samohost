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
#   provision.dockerImage: "postgresai/extended-postgres:16-0.6.2"  # match host PG major
#   provision.cloneAccessAddresses: "127.0.0.1"
#   cloning.maxCloneCount: 8  # default 4 is too low for multi-PR workloads
#   retrieval (logical):
#     source.connection.host: "host.docker.internal"  # NOT 172.17.0.1 (Bug C: IP is dynamic)
#     source.connection.port: 5432
#     db <appdb>, a read-only dump role; schedule: "0 3 * * 0" (weekly off-peak)
#   databaseConfigs: shared_buffers 128MB (cx23) or 256MB (cx33), work_mem small
# NOTE: host PG must accept connections from the Docker bridge for logicalDump:
#   - pg_hba.conf: host all all 172.16.0.0/12 trust  (covers docker0 + bridge nets)
#   - listen_addresses: 'localhost,172.17.0.1'  (or '*' with tight hba)
#   - AND postgresql@.service must start AFTER docker.service (see Bug C below)

# 4. Run the engine (Docker supervises; API on localhost only)
#
# --add-host=host.docker.internal:host-gateway is REQUIRED (Bug C fix,
# 2026-07-16): it makes `host.docker.internal` resolve to the host's
# docker0 gateway IP inside the container. Without it, the logicalDump
# job (which runs pg_dump in a sub-container that ALSO needs this alias)
# cannot reach host postgres, and the weekly refresh marks the pool
# "empty" → DROPS ALL LIVE CLONES. See "Bug C" section below.
docker run --name dblab_server --label dblab_control --privileged \
  --publish 127.0.0.1:2345:2345 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /var/lib/dblab:/var/lib/dblab/:rshared \
  --volume /root/.dblab/engine/configs:/home/dblab/configs:ro \
  --volume /root/.dblab/engine/meta:/home/dblab/meta \
  --add-host=host.docker.internal:host-gateway \
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

## Loopback ZFS profile (cx23 / no attached volume) — boot ordering fix

**Bug B (2026-07-16):** On samograph (cx23, loopback ZFS), the ZFS pool `dblab`
did NOT import on reboot 3x because `zfs-import-cache.service` ran before
`dblab-loopback.service` set up the loop device. Root cause: the loopback unit
declared `Before=zfs-import.target` but systemd started `zfs-import-cache.service`
(which has its own `Before=zfs-import.target`) independently, racing the loopback
setup. `zfs-import-cache` then aborted (signal=ABRT) because the backing file
`/var/lib/dblab-pool/dblab.img` was not reachable as a block device yet.

**Fix (operator must apply on each loopback-ZFS VM):**

```bash
# 1. Fix dblab-loopback.service to declare explicit ordering before ZFS import
cat > /etc/systemd/system/dblab-loopback.service <<'UNIT'
[Unit]
Description=DBLab loopback device for ZFS pool (samograph cx23 profile)
DefaultDependencies=no
After=local-fs.target systemd-udev-settle.service
Before=zfs-import-cache.service zfs-import-scan.service zfs-import.target docker.service
Wants=zfs-import-cache.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'losetup -j /var/lib/dblab-pool/dblab.img | grep -q . || losetup -f /var/lib/dblab-pool/dblab.img'
ExecStop=/bin/bash -c 'losetup -j /var/lib/dblab-pool/dblab.img | cut -d: -f1 | xargs -r losetup -d'

[Install]
WantedBy=multi-user.target
UNIT

# 2. Add a drop-in to zfs-import-cache.service requiring our loopback unit
mkdir -p /etc/systemd/system/zfs-import-cache.service.d
cat > /etc/systemd/system/zfs-import-cache.service.d/10-dblab-loopback.conf <<'DROPIN'
[Unit]
Requires=dblab-loopback.service
After=dblab-loopback.service
DROPIN

# 3. Add Restart=on-failure to dblab-loopback to recover from transient ABRT
# (already handled by docker --restart on-failure for the engine container)
# The drop-in ensures zfs-import-cache retries if it failed due to ordering.

# 4. Reload and verify
systemctl daemon-reload
systemctl enable dblab-loopback.service
systemctl status dblab-loopback.service zfs-import-cache.service

# 5. Test the boot sequence without rebooting:
#    a. stop pool + detach loop
systemctl stop dblab-loopback.service
zpool export dblab 2>/dev/null || true
#    b. re-run in order
systemctl start dblab-loopback.service
zpool import dblab 2>/dev/null || zpool import -f dblab
zpool list dblab
```

**Root cause note:** `zfs-import-cache.service` has `ConditionFileNotEmpty=/etc/zfs/zpool.cache`
which means it only runs when a cache file exists. On loopback-ZFS VMs the cache
records `/dev/loopN` — which must already exist when the import runs. The drop-in
enforces this ordering. Without it, every reboot leaves DBLab down until manual
`zpool import dblab`.

**This is a per-VM artifact** — `dblab-loopback.service` is NOT provisioned by
samohost. The provisioning gap is tracked in the docs/stack/dblab.md platform-gap
section. Until a cloud-init module is added, every new loopback-ZFS VM needs this
operator step after DBLab is installed.

## Bug C — postgres-before-docker source break (2026-07-16)

**Root cause:** When `dockerd` restarts (or starts after a crash) while
`postgresql@16-main` is already running, postgres has already bound its
addresses from `listen_addresses`. If `listen_addresses` includes `172.17.0.1`
(the docker0 bridge IP) but docker0 was not assigned that IP at the time
postgres started, the bind silently fails — postgres only holds `127.0.0.1`.
The DBLab engine's `logicalDump` job spawns a temporary
`postgresai/extended-postgres` container and runs `pg_dump` against the
configured `source.connection.host`. When that host is `172.17.0.1` and the
socket is not bound there, pg_dump gets "Connection refused", the retrieval job
fails, and the engine marks the pool `empty` → **drops all live clones**.

`skipStartRefresh: true` hides the break at startup, but a scheduled weekly
refresh (`timetable: "0 3 * * 0"`) triggers the same chain. The failure mode
is silent until Sunday 03:00 UTC.

**Durable fix (apply to every loopback-ZFS and CX23 VM):**

```bash
# 1. Restart postgres so it binds listen_addresses including 172.17.0.1
#    (one-time; apps use a connection pool and reconnect within seconds).
systemctl restart postgresql@16-main
pg_isready -h 172.17.0.1 -p 5432  # must say "accepting connections"

# 2. Add a drop-in so postgres starts AFTER docker on every boot,
#    ensuring docker0 exists before postgres tries to bind it.
mkdir -p /etc/systemd/system/postgresql@16-main.service.d
cat > /etc/systemd/system/postgresql@16-main.service.d/10-docker-after.conf <<'DROPIN'
[Unit]
# postgres must start AFTER docker so docker0 (172.17.0.1) exists when
# postgres binds listen_addresses (Bug C fix, 2026-07-16).
After=network.target docker.service
Wants=docker.service
DROPIN
systemctl daemon-reload

# 3. Use host.docker.internal in server.yml (NOT the raw 172.17.0.1 IP)
#    and recreate the container with --add-host so the alias resolves:
#
#    In /root/.dblab/engine/configs/server.yml:
#      retrieval.spec.logicalDump.options.source.connection.host: "host.docker.internal"
#
#    Then recreate (clones blip briefly while the engine reconnects):
docker stop dblab_server && docker rm dblab_server
docker run --name dblab_server --label dblab_control --privileged \
  --publish 127.0.0.1:2345:2345 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /var/lib/dblab:/var/lib/dblab/:rshared \
  --volume /root/.dblab/engine/configs:/home/dblab/configs:ro \
  --volume /root/.dblab/engine/meta:/home/dblab/meta \
  --add-host=host.docker.internal:host-gateway \
  --detach --restart on-failure \
  postgresai/dblab-server:4.1.3

# 4. Verify source is reachable from inside the container:
docker exec dblab_server sh -c 'nc -w2 -z host.docker.internal 5432 && echo OK || echo FAIL'
# Must print OK.

# 5. Verify preflight now reports source: READY
samohost env preflight <vm-name>   # source: READY expected
```

**Why `host.docker.internal` and not the raw IP `172.17.0.1`?**
The `--add-host=host.docker.internal:host-gateway` flag wires the alias to
whatever the docker0 gateway IP is at runtime (determined by `ip route`
inside the container). This is resilient to docker0 getting a different IP
on different VMs or after a manual docker network reset. The raw IP is
fragile — if docker0 ever changes, the source connection breaks again.

**`maxCloneCount` note:** The default `maxCloneCount: 4` in server.yml is
too low for a VM with multiple active PR previews. Raise it to at least 8
for client projects with concurrent open PRs:

```yaml
cloning:
  maxCloneCount: 8   # was 4; 6+ clones refused new previews on samograph
```

**This is a per-VM artifact** — the postgresql ordering drop-in and the
dblab container re-creation must be applied to every affected VM by the
operator. Until samohost provisions these automatically (cloud-init module
follow-up), new VMs may silently have this bug after a dockerd restart.

## Open items

- Confirm `postgresai/extended-postgres:18-*` tag availability (UNVERIFIED).
- `postgres-ai/air` prototype inaccessible — re-consult if access is granted.
- Bug B (loopback boot ordering) must be baked into the cloud-init DBLab module
  when it is implemented (PR #128 follow-up).
- Bug C (postgres-before-docker source break) must be baked into the cloud-init
  DBLab module (postgresql ordering drop-in + host.docker.internal in server.yml
  + --add-host in the container run command).
