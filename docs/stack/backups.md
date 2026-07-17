# Hetzner Automated Backups — Fleet Standard

**Status:** default-ON for all client VMs as of 2026-07 (samohost PR #178).

## What this is

Hetzner built-in automated backups — the simple 20%-surcharge daily-backup
feature. NOT a custom pipeline, NOT rsync, NOT Restic. One toggle per VM.
Hetzner assigns a daily window automatically; you cannot pick the exact time.

## How to verify backup status

```
# Via hcloud CLI — backup_window non-null means backups are on.
hcloud server describe <server-name> | grep backup_window

# Via fleet-doctor (checks all samohost-managed VMs):
samohost fleet-doctor --json | jq '.vms[].checks[] | select(.id=="backup-enabled")'
```

A `backup_window` value like `"22-02"` means backups run between 22:00–02:00 UTC.
A `backup_window` of `null` means backups are OFF — that is a fleet-doctor FAIL.

## How to enable backups on an existing VM

```bash
# hcloud CLI
hcloud server enable-backup <server-name>

# Or via API (HCLOUD_TOKEN must be set):
curl -X POST https://api.hetzner.cloud/v1/servers/<id>/actions/enable_backup \
  -H "Authorization: Bearer $HCLOUD_TOKEN"
```

Idempotent: calling on an already-backed-up server is a no-op.

## How to disable backups (if needed)

```bash
hcloud server disable-backup <server-name>
```

Reverting is additive: `enable_backup` can be called again later.

## Cost

20% monthly surcharge on the server base price.
A cx23 at ~€5.49/mo → backup costs ~€1.10/mo extra.
Hetzner retains the last 7 daily backups per VM.

## Default-ON at provision time

`samohost provision` calls `enableBackup(providerId)` immediately after the
server is created (src/commands/provision.ts). Failure is non-fatal: the VM is
still provisioned and the fleet-doctor `backup-enabled` check will surface the
gap at the next sweep.

## Fleet-doctor guardrail

`checkBackupEnabled` (src/doctor/backup-enabled.ts) runs as part of
`samohost fleet-doctor`. It calls `getWithBackup(providerId)` per VM and
emits:
- `status: "pass"` — `backup_window` is a non-empty string.
- `status: "fail"` — `backup_window` is null (backups off). Action required.

Group: `infra-sizing`. Check id: `backup-enabled`.

## Exclusion list

Some VMs are deliberately excluded from this check:

| VM | Reason |
|----|--------|
| field-record (hcloud id 137236481, ip 178.105.246.151) | Mid-migration (volume shrink via rescue mode as of 2026-07). Enable backups separately after migration completes: `hcloud server enable-backup samo-we-field-record`. |
| release-gate-runner | Stateless CI box — ephemeral, rebuilt on every sprint. Backups intentionally off. |
| Nik-owned VMs | Naturally excluded: `provider.list()` + `store.list()` only enumerate VMs labeled `managed-by=samohost`. |

## Enabling field-record backups post-migration

Once the field-record volume-shrink rescue is complete:
```bash
hcloud server enable-backup samo-we-field-record
# Verify:
hcloud server describe samo-we-field-record | grep backup_window
```

Then run `samohost fleet-doctor` to confirm the check shows `pass`.
