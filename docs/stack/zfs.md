# ZFS — pool policy

## Pool name: always `tank`

The ZFS pool is always named `tank`. This is enforced across all deployments
and referenced by the PG data dir path, DBLab mountDir, and backup targets.
Source: `samo.team/infra/zfs/pool.ts` (renders pool creation commands with
`tank` hardcoded).

## Two pool shapes

### Volume-backed (field-record, CX33 with attached volume)

Used when the VM has a dedicated Hetzner block volume (`/dev/sdb`).

```bash
zpool create -o ashift=12 -O compression=lz4 -O atime=off -O recordsize=8k \
  tank /dev/sdb
```

Dataset layout:
```
tank/postgresql   — PG data dir (mountpoint /tank/postgresql, NEVER move this)
tank/dblab        — DBLab mountDir (/var/lib/dblab → /tank/dblab symlink or mountpoint)
tank/previews     — reserved
```

ZFS options:
- `compression=lz4` — mandatory, reduces disk use significantly on DB workloads
- `atime=off` — mandatory, eliminates atime write amplification
- `logbias=throughput` — set on the `tank/dblab` dataset
- `recordsize=8k` — at pool creation for DB alignment

Source: `samo.team/infra/zfs/pool.ts`, `docs/dblab-install-runbook.md`.

### Loopback (cx23 minimal profile, samograph and new client VMs)

A file-backed pool on the 40 GB root disk. No attached Hetzner volume required.
DBLab uses this pool; prod Postgres is NOT on ZFS on these VMs (it runs in the
standard Ubuntu apt-managed data dir).

```bash
# Create a sparse image (adjust size to root disk free space)
truncate -s 20G /var/lib/dblab/dblab_pool
zpool create -o ashift=12 -O compression=lz4 -O atime=off \
  tank /var/lib/dblab/dblab_pool
```

Used by DBLab only. Pool is named `tank` regardless of shape.

Source: samograph deployment, verified 2026-07-07.

## Hard constraint: PG data dir never moves off /tank

**On field-record (and any VM where prod PG lives on a ZFS volume): the
Postgres data directory must always be `/tank/postgresql/18/main`. Do not
move it off the pool for any reason, including storage rebalancing, OS
reinstall, or volume migration.**

This is an owner-stated constraint (VM handoff 2026-06-12). PG data on ZFS
pool `tank` enables instant DBLab snapshots of the entire prod state. Moving it
to a non-ZFS path breaks DBLab's physical retrieval path and requires a full
logical dump cycle to recover.

## ZFS ARC cap (mandatory on CX23)

On a CX23 (3.7 GB RAM), the ZFS ARC must be capped or it will consume ~1.85 GB
by default, starving the application.

Set in `/etc/modprobe.d/zfs.conf` (applied at boot; also settable live):

```
options zfs zfs_arc_max=536870912   # 512 MB cap
```

For a cx23 running only DBLab + a small app:
- 512 MB ARC is sufficient and leaves ~2.7 GB for app + OS
- Do not set below 256 MB (clone metadata thrashes)

Source: footprint measurement 2026-07-06, samograph production 2026-07-07.

## Consistent dataset properties

These ZFS properties must be set on any DBLab-adjacent dataset:

| Property | Value | Reason |
|---|---|---|
| `compression` | `lz4` | Space + speed on DB blocks |
| `atime` | `off` | Eliminate atime write amplification |
| `logbias` | `throughput` | DBLab dataset; avoids log-device bottleneck |
| `recordsize` | `8k` (pool creation only) | PG 8k page alignment |
