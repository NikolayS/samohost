/**
 * Phase C — conservative firewall auto-remediation for web-ports-not-world-open.
 *
 * Entry point: remediateSafeVm (called from fleet-doctor.ts after audit sweep).
 *
 * SAFETY CONTRACT (never violated):
 *   - classifyVm probes ONLY /etc/caddy/sites.d/ — never the parent Caddyfile.
 *   - ENTANGLED / UNKNOWN VMs are never mutated regardless of --apply.
 *   - Additive CF-range allow rules are added BEFORE any ufw delete lines.
 *   - A count gate after the additive step aborts the script (set -euo pipefail
 *     + explicit check) before deletes fire if curl cannot reach CF endpoints.
 *   - Verify probe after the lock must return pass; on fail the function emits a
 *     revert instruction and returns verified:false.
 *   - The whole remediation for-loop (in fleet-doctor.ts) is strictly sequential
 *     (for…of, same constraint as the main audit sweep).
 */

import { buildFirewallLines } from "../env/script.ts";
import { parseWebPortsNotWorldOpenOutput } from "../commands/doctor.ts";
import { redact } from "../ssh/runner.ts";
import type { VmRecord } from "../types.ts";
import type { RemoteRunner } from "../commands/status.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of a VM's TLS posture based on sites.d snippets. */
export type VmClass = "SAFE" | "ENTANGLED" | "UNKNOWN";

/**
 * Per-VM remediation outcome, embedded in FleetDoctorReport.remediations[].
 *
 * - wouldLock:  set in dry-run mode (apply:false) to indicate the VM would have
 *               been locked if --apply were given.  Absent on applied runs.
 * - applied:    true when the additive+delete SSH script was executed.
 * - verified:   true when the post-lock probe confirms no world-open rule remains.
 *               Absent when applied:false or when verify was not reached.
 * - alert:      human-readable reason for ENTANGLED / UNKNOWN outcomes.
 */
export interface FleetRemediationResult {
  vmName: string;
  class: VmClass;
  applied: boolean;
  verified?: boolean;
  wouldLock?: boolean;
  alert?: string;
}

// ---------------------------------------------------------------------------
// Classifier — TWO-READ probe scoped exclusively to /etc/caddy/sites.d/
// ---------------------------------------------------------------------------

/** SSH command that counts sites.d snippets and how many use `tls internal`. */
const CLASSIFIER_CMD =
  'printf "TOTAL=%s\\nTLS=%s\\n" ' +
  '"$(ls /etc/caddy/sites.d/*.caddy 2>/dev/null | wc -l | tr -d \' \')" ' +
  '"$(grep -rl \'tls internal\' /etc/caddy/sites.d/ 2>/dev/null | wc -l | tr -d \' \')"';

/**
 * Classify a VM by inspecting its /etc/caddy/sites.d/ snippets over SSH.
 *
 * Decision tree:
 *   total == 0                     → ENTANGLED (empty sites.d)
 *   tls_count == total (total > 0) → SAFE      (all snippets use tls internal)
 *   tls_count < total              → ENTANGLED (at least one snippet is unknown)
 *   SSH transport error            → UNKNOWN
 *
 * The probe NEVER reads /etc/caddy/Caddyfile — that file always contains
 * `import sites.d/*.caddy` without `tls internal`, so a whole-tree grep would
 * falsely classify every VM as ENTANGLED.
 */
export async function classifyVm(vm: VmRecord, runner: RemoteRunner): Promise<VmClass> {
  let stdout: string;
  try {
    const result = await runner(vm, CLASSIFIER_CMD);
    stdout = result.stdout;
  } catch {
    return "UNKNOWN";
  }

  const totalMatch = stdout.match(/^TOTAL=(\d+)/m);
  const tlsMatch = stdout.match(/^TLS=(\d+)/m);

  if (!totalMatch || !tlsMatch) {
    return "UNKNOWN";
  }

  const total = parseInt(totalMatch[1]!, 10);
  const tls = parseInt(tlsMatch[1]!, 10);

  if (total === 0) return "ENTANGLED";
  if (tls === total) return "SAFE";
  return "ENTANGLED";
}

// ---------------------------------------------------------------------------
// Relock script builder — additive-first, never extends buildFirewallLines
// ---------------------------------------------------------------------------

/**
 * Build the world-open deletion lines for the relock script.
 *
 * These lines are ALWAYS emitted AFTER the additive CF-range allow rules
 * (produced by buildFirewallLines). They must NOT be added to buildFirewallLines
 * itself — that function is called inside buildHostPrepScript where deletes must
 * not appear.
 *
 * IPv6 equivalents are included because Ubuntu UFW tracks v4 and v6 rules
 * independently.
 */
export function buildRelockDeleteLines(): string[] {
  return [
    "# Phase C relock — Step 2: remove world-open rules (AFTER additive rules above).",
    "# UFW manages v4 and v6 together when IPV6=yes (Ubuntu default); one delete covers both.",
    "ufw delete allow 443/tcp 2>/dev/null || true",
    "ufw delete allow 443 2>/dev/null || true",
    "ufw delete allow 80/tcp 2>/dev/null || true",
    "ufw delete allow 80 2>/dev/null || true",
  ];
}

/** SSH command for the post-lock verify step — mirrors the web-ports-not-world-open probe. */
const VERIFY_CMD =
  "ufw status 2>/dev/null | grep -E '^(80|443)(/|[[:space:]])'";

/**
 * Build the full additive-first relock bash script.
 *
 * Step 1: emit CF-range allow rules (via buildFirewallLines).
 * Step 2: count gate — abort before deletes if no CF :443 rule landed.
 * Step 3: emit world-open delete lines (via buildRelockDeleteLines).
 *
 * The script runs under set -euo pipefail: any error in the additive step
 * aborts before the delete step fires.
 */
function buildRelockScript(sshUser: string, controlPlaneIp?: string): string {
  const addLines = buildFirewallLines(true, sshUser, {
    allowCfHttps: true,
    controlPlaneIp,
  });
  const delLines = buildRelockDeleteLines();

  const gateCheck = [
    "# Phase C relock — Step 2a: count gate (abort if no CF :443 rule landed).",
    "_cf_rule_count=$(ufw status | grep -cE '443.*ALLOW.*[0-9]{1,3}\\.' || true)",
    "if [ \"$_cf_rule_count\" -eq 0 ]; then",
    "  echo 'ERROR: Phase C relock aborted — no CF :443 rules detected after additive step. Run ufw allow 443/tcp to restore access.' >&2",
    "  exit 1",
    "fi",
  ];

  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "# Phase C relock — generated by samohost fleet-doctor --remediate --apply.",
    "# Additive-first: CF ranges are added BEFORE world-open rules are removed.",
    "",
    ...addLines,
    "",
    ...gateCheck,
    "",
    ...delLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// remediateSafeVm — execute or dry-run the relock for a classified-SAFE VM
// ---------------------------------------------------------------------------

/**
 * Execute (or dry-run) the additive-first relock for a VM that has already been
 * classified SAFE.
 *
 * When apply:false, no SSH mutation occurs — only the relock script is logged.
 * When apply:true:
 *   1. Send the relock script in one SSH session.
 *   2. Send the verify probe in a second SSH session.
 *   3. Return applied:true, verified:true/false based on the probe result.
 *      On verify failure, the function still returns (non-fatal); the caller
 *      (fleet-doctor.ts) surfaces the failure in the report.
 */
export async function remediateSafeVm(
  vm: VmRecord,
  runner: RemoteRunner,
  apply: boolean,
  controlPlaneIp?: string,
): Promise<FleetRemediationResult> {
  const script = buildRelockScript(vm.sshUser, controlPlaneIp);

  if (!apply) {
    return {
      vmName: vm.name,
      class: "SAFE",
      applied: false,
      wouldLock: true,
    };
  }

  // Step 1 + 2 + 3 (additive + gate + delete) — one SSH session.
  try {
    await runner(vm, script);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      vmName: vm.name,
      class: "SAFE",
      applied: false,
      verified: false,
      alert: `relock SSH error: ${redact(msg)}`,
    };
  }

  // Step 4: verify — second SSH session.
  let verified = false;
  try {
    const verifyResult = await runner(vm, VERIFY_CMD);
    const parseResult = parseWebPortsNotWorldOpenOutput(verifyResult.stdout);
    verified = parseResult.status === "pass";
    if (!verified) {
      // Emit revert instruction via alert field.
      return {
        vmName: vm.name,
        class: "SAFE",
        applied: true,
        verified: false,
        alert:
          "POST-LOCK VERIFY FAILED: world-open rule still present. " +
          "Revert: ufw allow 443/tcp && ufw allow 80/tcp",
      };
    }
  } catch {
    return {
      vmName: vm.name,
      class: "SAFE",
      applied: true,
      verified: false,
      alert: "verify SSH error — check ufw status manually",
    };
  }

  return {
    vmName: vm.name,
    class: "SAFE",
    applied: true,
    verified: true,
  };
}
