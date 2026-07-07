# DBLab Engine — preview databases

## Non-negotiable policy

**Previews ALWAYS use DBLab thin clones. Never the template/dump fallback.**

Owner-stated 2026-07-06: "dblab is non-discussable for previews, it is our
choice." This is not an architectural preference or a cost recommendation — it
is a fixed platform decision. If you are writing code that touches preview
environment creation and DBLab is not available, the correct response is to
surface the error, not to fall back to template copy.

## What DBLab is

DBLab Engine v4.1.3 runs as a Docker container (`postgresai/dblab-server:4.1.3`)
on each project VM. It maintains its own copy of the database under a ZFS
dataset and serves thin, copy-on-write clones per preview environment.

- Each clone is a Docker container (`postgresai/extended-postgres:18-0.6.2`)
- API endpoint: `http://127.0.0.1:2345/healthz`
- Clone IDs = environment names (e.g. `pr-42-feature-foo`)
- Lease default: 20160 min (14 days) — source: `src/env/script.ts`
  (`DBLAB_LEASE_DEFAULT_MINUTES=20160`)
- State tracked in `~/.samohost/` via `infra/dblab/clone-registry.ts`

Full operator install steps: [`docs/dblab-install-runbook.md`](../dblab-install-runbook.md)

## DBLab is Docker-only — no native binary

There is no published `dblab-engine` native binary. The engine ships
exclusively as the `postgresai/dblab-server` Docker image (privileged, mounts
the Docker socket). The legacy `dblab.service` ExecStart that referenced
`/usr/local/bin/dblab-engine` pointed to a nonexistent file — it must be
replaced with the docker-run model. Source: `docs/dblab-install-runbook.md`
"Hard facts that shape this install."

## Deployment shapes

### Volume-backed (field-record, CX33)

ZFS pool `tank` on an attached Hetzner volume (`/dev/sdb`). Datasets:
- `tank/postgresql` — PG data dir (NEVER move off tank; see [zfs.md](zfs.md))
- `tank/dblab` — DBLab mountDir
- `tank/previews` — reserved

`shared_buffers` per clone: 256 MB (8 GB host — see runbook sizing section).

Source: `docs/dblab-install-runbook.md`, VM handoff 2026-06-12.

### Loopback / cx23 minimal profile (samograph and new client VMs)

**No separate Hetzner volume is needed.** A file-backed ZFS pool lives on the
40 GB root disk. This profile has been verified in production on samograph
(CX23) as of 2026-07-07.

Measured footprint on a 3.7 GB RAM CX23:

| Resource | Value |
|---|---|
| Engine container RAM | ~21 MiB |
| Per-clone RAM | ~45 MiB |
| ZFS ARC cap (`zfs_arc_max`) | 256–512 MB |
| Per-clone `shared_buffers` | 128 MB |
| Clone cap | 2–3 |
| Swap | 2 GB swapfile |
| Incremental cost | ~EUR 0 (no added volume) |

**The cx33 + 50 GiB volume plan is ~100x over-provisioned for typical client
projects.** The loopback profile fits on the existing VM's root disk.

ZFS ARC cap is mandatory on CX23. Without it, ARC defaults to ~50% of 3.7 GB
= ~1.85 GB, leaving almost nothing for the app. Set via `/etc/modprobe.d/zfs.conf`:
```
options zfs zfs_arc_max=536870912   # 512 MB
```

Source: footprint measured 2026-07-06, samograph production verified 2026-07-07.

## Platform gap — DBLab is not auto-installed by cloud-init

As of 2026-07-07, `samohost app bootstrap` does NOT auto-install Docker, ZFS,
or DBLab. The optional-module registry is empty:
`src/commands/preview.ts` lines 19-24 — "v0.1 ships no concrete optional module
implementation yet."

DBLab is currently a **manual operator runbook** + read-only preflight check.
Every freshly provisioned CX23 client VM is NOT dblab-ready out of the box.

The fix (a dblab cloud-init module baked into the provisioning flow) is a
platform decision tracked in issue #127. Do not assume DBLab is running on a
VM unless the operator has confirmed the runbook was completed and
`curl -s http://127.0.0.1:2345/healthz` returns healthy.

## samohost preflight

`samohost env preflight <vm>` runs the DBLab readiness check
(`src/dblab/preflight.ts`). It verifies the API is reachable and at least one
clone pool is configured. Run this before any `env create --db dblab`.

## Key configuration fields (server.yml)

```yaml
server:
  verificationToken: <token stored at /root/.dblab/token, mode 600>
  port: 2345

poolManager:
  mountDir: /var/lib/dblab          # or loopback pool path on cx23

provision:
  portPool: {from: 6000, to: 6099}
  dockerImage: "postgresai/extended-postgres:18-0.6.2"
  cloneAccessAddresses: "127.0.0.1"

retrieval:
  mode: logical                     # pg_dump from host PG18
  # preSnapshotSuffix: "_pre"       # REQUIRED — missing this broke samograph initially
```

`preSnapshotSuffix: '_pre'` is required in the retrieval config. Its absence
caused the samograph DBLab to fail with wrong pool mode detection (fixed
2026-07-07, issue #128).

## Current fleet state

| VM | DBLab state | Notes |
|---|---|---|
| samo-we-field-record | RUNNING | volume-backed, tank, verified 2026-06-12 |
| samograph | RUNNING | loopback ZFS, fixed 2026-07-07 (issue #128) |
| samo.team control plane | NOT installed | auth only, no client DBs |
