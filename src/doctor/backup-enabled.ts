/**
 * src/doctor/backup-enabled.ts — fleet-doctor guardrail for Hetzner backups.
 *
 * Check id: "backup-enabled"
 * Group:    "infra-sizing"
 *
 * Calls provider.getWithBackup(providerId) per VM and fails when backup_window
 * is null (backups off). This is a LIVE hcloud probe (unlike dblab-sizing which
 * is purely local), so it is async and injectable via ProviderPortWithBackup.
 *
 * Exclusions (by design — see docs/stack/backups.md):
 *   - field-record VM (providerId 137236481): excluded mid-migration; backups
 *     enabled separately after the volume-shrink migration completes.
 *   - release-gate-runner: stateless CI box; backups intentionally off.
 *   - Nik-owned VMs: naturally excluded because provider.list() + store.list()
 *     only contain samohost-managed (managed-by=samohost) VMs.
 *
 * The fleet-doctor wiring in src/commands/fleet-doctor.ts passes the provider
 * to checkBackupEnabled alongside the VmRecord[] slice for the current VM.
 *
 * Background:
 *   Hetzner built-in automated backups are the fleet standard for client VMs
 *   (owner decision, 2026-07). They are enabled at provision time via
 *   enableBackup() and verified fleet-wide by this guardrail.
 *   See docs/stack/backups.md for the full runbook.
 */

import type { VmRecord } from "../types.ts";
import type { ProviderPortWithBackup } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result shape compatible with DoctorResult from src/commands/doctor.ts */
export interface BackupEnabledResult {
  vmId: string;
  id: "backup-enabled";
  group: "infra-sizing";
  status: "pass" | "fail";
  description: string;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Provider IDs excluded from this check (never flag as failing).
// ---------------------------------------------------------------------------

/** field-record VM — mid-migration; backups enabled separately post-migration. */
const FIELD_RECORD_PROVIDER_ID = "137236481";

/**
 * release-gate-runner — stateless CI box; backups intentionally disabled.
 * Identified by name prefix since the provider id may change across re-creates.
 */
const EXCLUDED_NAME_PREFIXES = ["release-gate-runner"];

function isExcluded(vm: VmRecord): boolean {
  if (vm.providerId === FIELD_RECORD_PROVIDER_ID) return true;
  for (const prefix of EXCLUDED_NAME_PREFIXES) {
    if (vm.name.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// checkBackupEnabled — one result per VM, parallel-safe.
// ---------------------------------------------------------------------------

/**
 * Check that every samohost-managed VM has Hetzner automated backups enabled.
 *
 * @param vms      VmRecord[] to check (typically the fleet's ready+adopted VMs)
 * @param provider ProviderPortWithBackup — must implement getWithBackup(id)
 * @returns        One BackupEnabledResult per VM, in the same order as `vms`
 */
export async function checkBackupEnabled(
  vms: VmRecord[],
  provider: ProviderPortWithBackup,
): Promise<BackupEnabledResult[]> {
  const results: BackupEnabledResult[] = [];

  for (const vm of vms) {
    // Excluded VMs always pass (not reported as failing).
    if (isExcluded(vm)) {
      results.push({
        vmId: vm.id,
        id: "backup-enabled",
        group: "infra-sizing",
        status: "pass",
        description: `${vm.name}: backups check skipped (excluded VM — see docs/stack/backups.md).`,
        stdout: "",
        stderr: "",
      });
      continue;
    }

    try {
      const info = await provider.getWithBackup(vm.providerId);

      if (info.backup_window !== null && info.backup_window !== "") {
        results.push({
          vmId: vm.id,
          id: "backup-enabled",
          group: "infra-sizing",
          status: "pass",
          description: `${vm.name}: Hetzner automated backups enabled (window: ${info.backup_window}).`,
          stdout: "",
          stderr: "",
        });
      } else {
        results.push({
          vmId: vm.id,
          id: "backup-enabled",
          group: "infra-sizing",
          status: "fail",
          description:
            `${vm.name}: Hetzner automated backups are OFF (backup_window=null). ` +
            `Enable via: hcloud server enable-backup ${vm.providerId}. ` +
            `20% surcharge; daily window auto-assigned. See docs/stack/backups.md.`,
          stdout: "",
          stderr: "",
        });
      }
    } catch (e) {
      // Provider call failed — emit fail (fail-safe: unknown backup state = fail).
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        vmId: vm.id,
        id: "backup-enabled",
        group: "infra-sizing",
        status: "fail",
        description:
          `${vm.name}: could not read backup_window from provider: ${msg}. See docs/stack/backups.md.`,
        stdout: "",
        stderr: "",
      });
    }
  }

  return results;
}
