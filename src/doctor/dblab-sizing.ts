/**
 * src/doctor/dblab-sizing.ts — LOCAL-only fleet-doctor guardrail.
 *
 * Check id: "dblab-not-oversized"
 * Group:    "infra-sizing"
 *
 * Reads state.json (VmRecord[]) + apps.json (AppRecord[]) in memory;
 * makes NO SSH connections and no hcloud API calls.
 *
 * An app is dblab-backed when AppRecord.previewDbBackend === "dblab".
 * The dblab VM is the VmRecord whose id matches AppRecord.vmId.
 *
 * Approved minimal server types: cx23, cx22, cpx11.
 * Anything larger is considered oversized for a dblab-only box.
 *
 * Volume-tracking caveat:
 *   samohost state.json does not currently track attached volume size or
 *   extraCostEurMonth on VmRecord. The check therefore flags on server type
 *   alone. A follow-up is needed to add a volumeSizeGb (or extraCostEurMonth)
 *   field to VmRecord so large volumes on otherwise-approved types are also
 *   caught — see docs/stack/dblab.md for the open issue.
 *
 * Background:
 *   field-record (app "field-record", vmId 8846e4d4-…) is the canonical
 *   real-world case: cx33 + 100GB volume + previewDbBackend="dblab".
 *   The cx23 minimal profile costs ~EUR5.49/mo vs ~EUR14/mo for cx33.
 *   Without this check the over-provisioning was invisible until the owner
 *   reviewed the Hetzner bill manually.
 */

import type { VmRecord, AppRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result shape compatible with DoctorResult from src/commands/doctor.ts */
export interface DblabSizingResult {
  id: "dblab-not-oversized";
  group: "infra-sizing";
  status: "pass" | "fail";
  description: string;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Approved server types for a dblab VM.
// cx23 is the canonical SAMO minimal profile (~EUR5.49/mo, 2vCPU/4GB).
// cx22 and cpx11 are also accepted (comparable or smaller).
// ---------------------------------------------------------------------------

const APPROVED_DBLAB_TYPES: ReadonlySet<string> = new Set([
  "cx23",
  "cx22",
  "cpx11",
]);

// ---------------------------------------------------------------------------
// checkDblabNotOversized — pure function, no I/O.
// ---------------------------------------------------------------------------

/**
 * Inspect all dblab-backed apps and their associated VMs. Return "fail" if
 * any dblab VM is on a server type NOT in APPROVED_DBLAB_TYPES, "pass" otherwise.
 *
 * @param vms   All VmRecord entries from state.json
 * @param apps  All AppRecord entries from apps.json
 */
export function checkDblabNotOversized(
  vms: VmRecord[],
  apps: AppRecord[],
): DblabSizingResult {
  // Build a lookup map for VMs by id for O(1) access.
  const vmById = new Map<string, VmRecord>(vms.map((v) => [v.id, v]));

  // Collect all apps whose previewDbBackend is explicitly "dblab".
  const dblabApps = apps.filter((a) => a.previewDbBackend === "dblab");

  // For each dblab app, find the associated VM and check its server type.
  // Track oversized VMs (deduped by vmId) for the description.
  const oversized: Array<{ vmName: string; vmType: string }> = [];
  const seenVmIds = new Set<string>();

  for (const app of dblabApps) {
    const vm = vmById.get(app.vmId);
    if (!vm) continue; // orphan app with no matching VM — skip
    if (seenVmIds.has(vm.id)) continue; // deduplicate if multiple apps share a VM
    seenVmIds.add(vm.id);

    if (!APPROVED_DBLAB_TYPES.has(vm.type)) {
      oversized.push({ vmName: vm.name, vmType: vm.type });
    }
  }

  if (oversized.length === 0) {
    return {
      id: "dblab-not-oversized",
      group: "infra-sizing",
      status: "pass",
      description: "All DBLab VMs are on the cx23 minimal profile.",
      stdout: "",
      stderr: "",
    };
  }

  // Build a per-VM fail message.
  const lines = oversized.map(
    ({ vmName, vmType }) =>
      `DBLab VM ${vmName} is ${vmType} — not on the cx23 minimal profile ` +
      `(oversized dblab box costs ~EUR14/mo vs ~EUR5.49). ` +
      `See docs/stack/dblab.md.`,
  );

  return {
    id: "dblab-not-oversized",
    group: "infra-sizing",
    status: "fail",
    description: lines.join(" | "),
    stdout: "",
    stderr: "",
  };
}
