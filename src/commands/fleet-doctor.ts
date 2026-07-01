/**
 * `samohost doctor --all` — sequential fleet-wide doctor sweep.
 *
 * Audits every VM in state that is in `ready` or `adopted` lifecycleState.
 * VMs in any other state are silently skipped.
 *
 * STRICTLY SEQUENTIAL — one SSH at a time. The control plane has xt_recent
 * SSH rate-limiting (same reasoning as ConnectionBudget in src/ssh/runner.ts);
 * concurrent probes across N VMs would trigger a ban.
 *
 * ABSOLUTE CONSTRAINT: no raw SSH stdout/stderr in any output or GitHub issue
 * body. Only check ids, VM names, aggregated counts.
 */

import { auditVm, defaultRemoteRunner, type DoctorResult } from "./doctor.ts";
import { upsertGhIssue } from "../util/gh-comment.ts";
import { redact } from "../ssh/runner.ts";
import type { StateStore } from "../state/store.ts";
import type { AppStore } from "../state/apps.ts";
import type { RemoteRunner } from "./status.ts";
import {
  classifyVm,
  remediateSafeVm,
  type FleetRemediationResult,
} from "../remediate/firewall-lock.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetVmResult {
  vmId: string;
  vmName: string;
  /** Populated on success; absent when probeError is set. */
  checks?: DoctorResult[];
  /** SSH unreachable or other probe failure — recorded, sweep continues. */
  probeError?: string;
}

export interface FleetDoctorReport {
  at: string;          // ISO-8601
  vms: FleetVmResult[];
  totalVms: number;    // VMs attempted (lifecycleState in {ready,adopted})
  failingVms: number;  // VMs with ≥1 fail check (group !== core-suspicious)
  errorVms: number;    // VMs where probeError is set (SSH unreachable)
  findingVms: number;  // VMs with ≥1 suspicious finding
  /**
   * VMs that have ≥1 "unknown" check AND 0 "fail" checks.
   * These are typically no-sudo hosts where requiresSudo probes return
   * permission-denied instead of a real value — they look alarming when lumped
   * into samo_doctor_fleet_vms_failing but are not actually broken.
   * Emitted as a separate Prometheus series (samo_doctor_fleet_vms_unknown)
   * so dashboards can distinguish "needs sudo grants" from "truly failing".
   */
  unknownVms: number;
  /** Populated only when opts.remediate is true. */
  remediations?: FleetRemediationResult[];
}

// Re-export so callers (tests) can reference the type from fleet-doctor.ts imports.
export type { FleetRemediationResult };

// ---------------------------------------------------------------------------
// Fleet alert body builder.
// MUST NOT include raw log lines — only check ids, VM names, counts.
// ---------------------------------------------------------------------------

function buildAlertBody(report: FleetDoctorReport): string {
  const MARKER = "<!-- samohost-fleet-alert -->";
  const lines: string[] = [MARKER, ""];
  lines.push(`## Fleet Doctor Alert — ${report.at}`);
  lines.push("");
  lines.push(
    `**${report.totalVms}** VM(s) checked — ` +
    `**${report.failingVms}** failing, ` +
    `**${report.unknownVms}** unknown (no-sudo), ` +
    `**${report.errorVms}** unreachable, ` +
    `**${report.findingVms}** with suspicious findings.`,
  );
  lines.push("");

  const failing = report.vms.filter(
    (v) => v.checks && v.checks.some((c) => c.status === "fail" && c.group !== "core-suspicious"),
  );
  if (failing.length > 0) {
    lines.push("### Failing VMs");
    for (const v of failing) {
      const failIds = (v.checks ?? [])
        .filter((c) => c.status === "fail" && c.group !== "core-suspicious")
        .map((c) => c.id);
      // Never include raw check stdout — only the check IDs.
      lines.push(`- \`${v.vmName}\` → ${failIds.map((id) => `\`${id}\``).join(", ")}`);
    }
    lines.push("");
  }

  const errors = report.vms.filter((v) => v.probeError);
  if (errors.length > 0) {
    lines.push("### Unreachable VMs");
    for (const v of errors) {
      lines.push(`- \`${v.vmName}\` → probe-error (SSH unreachable)`);
    }
    lines.push("");
  }

  if (report.findingVms > 0) {
    lines.push(`### Suspicious Activity`);
    lines.push(`${report.findingVms} VM(s) have suspicious findings (see \`doctor <vm>\` for details).`);
    lines.push("");
  }

  if (failing.length === 0 && errors.length === 0 && report.findingVms === 0) {
    lines.push("All VMs passed. No action required.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// upsertFleetAlert — post/update fleet alert GitHub issue.
// Errors are caught by the caller (non-fatal to sweep).
// ---------------------------------------------------------------------------

function upsertFleetAlert(report: FleetDoctorReport, alertRepo: string): void {
  const MARKER = "<!-- samohost-fleet-alert -->";
  const body = buildAlertBody(report);
  const hasIssues = report.failingVms > 0 || report.errorVms > 0 || report.findingVms > 0;
  const title = hasIssues
    ? `Fleet Doctor Alert: ${report.failingVms} failing, ${report.errorVms} unreachable`
    : "Fleet Doctor: All VMs healthy";
  upsertGhIssue({ repo: alertRepo, title, marker: MARKER, body });
}

// ---------------------------------------------------------------------------
// Human-readable summary (non-JSON output).
// NO raw SSH stdout. Only check IDs, VM names, counts.
// ---------------------------------------------------------------------------

function formatFleetReport(report: FleetDoctorReport): string {
  const lines: string[] = [];
  lines.push(`Fleet Doctor — ${report.at}`);
  lines.push(
    `${report.totalVms} VM(s) checked | ` +
    `${report.failingVms} failing | ` +
    `${report.unknownVms} unknown (no-sudo) | ` +
    `${report.errorVms} unreachable | ` +
    `${report.findingVms} with suspicious findings`,
  );
  lines.push("");

  for (const v of report.vms) {
    if (v.probeError) {
      lines.push(`  [ERROR] ${v.vmName}: ${v.probeError}`);
      continue;
    }
    const failing = (v.checks ?? []).filter(
      (c) => c.status === "fail" && c.group !== "core-suspicious",
    );
    const findings = (v.checks ?? []).flatMap((c) => c.findings ?? []);
    if (failing.length > 0) {
      const failIds = failing.map((c) => c.id).join(", ");
      lines.push(`  [FAIL]  ${v.vmName}: ${failIds}`);
    } else if (findings.length > 0) {
      // Surface finding count without raw log content.
      lines.push(`  [FIND]  ${v.vmName}: ${findings.length} suspicious finding(s)`);
    } else {
      lines.push(`  [PASS]  ${v.vmName}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// runFleetDoctor — main entry point.
// ---------------------------------------------------------------------------

export async function runFleetDoctor(
  opts: {
    json: boolean;
    alertRepo?: string;
    /** Enable the Phase C remediation pass (dry-run unless apply is also true). */
    remediate?: boolean;
    /** Mutate: actually execute the relock SSH script. Requires remediate:true. */
    apply?: boolean;
    /** Control-plane IP for the :80 source-restricted allow rule. Required when apply:true. */
    controlPlaneIp?: string;
  },
  store: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
  remote?: RemoteRunner,
): Promise<number> {
  const runner = remote ?? defaultRemoteRunner();

  // Only probe VMs that are in an operational lifecycle state.
  const vms = store.list().filter(
    (r) => r.lifecycleState === "ready" || r.lifecycleState === "adopted",
  );

  const results: FleetVmResult[] = [];

  // STRICTLY SEQUENTIAL — for...of, NOT Promise.all.
  for (const record of vms) {
    const app = appStore.list().find((a) => a.vmId === record.id);
    try {
      const checks = await auditVm(record, app, runner);
      results.push({ vmId: record.id, vmName: record.name, checks });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`fleet-doctor: ${record.name}: probe-error: ${msg}`);
      results.push({ vmId: record.id, vmName: record.name, probeError: `probe-error: ${redact(msg)}` });
    }
  }

  // Aggregate counters.
  const failingVms = results.filter(
    (v) =>
      v.checks !== undefined &&
      v.checks.some((c) => c.status === "fail" && c.group !== "core-suspicious"),
  ).length;

  const errorVms = results.filter((v) => v.probeError !== undefined).length;

  const findingVms = results.filter(
    (v) =>
      v.checks !== undefined &&
      v.checks.some((c) => (c.findings?.length ?? 0) > 0),
  ).length;

  // unknownVms: VMs that have ≥1 unknown check AND 0 fail checks (excluding
  // core-suspicious from both sides). These are hosts where sudo-gated probes
  // returned permission-denied — a capability gap, not a hardening failure.
  // Separating this counter from failingVms stops no-sudo hosts from inflating
  // the samo_doctor_fleet_vms_failing dashboard alert.
  const unknownVms = results.filter(
    (v) =>
      v.checks !== undefined &&
      !v.checks.some((c) => c.status === "fail" && c.group !== "core-suspicious") &&
      v.checks.some((c) => c.status === "unknown"),
  ).length;

  // ---------------------------------------------------------------------------
  // Phase C — remediation pass (sequential, same constraint as audit loop).
  // Entered only when opts.remediate is true.
  // ---------------------------------------------------------------------------

  let remediations: FleetRemediationResult[] | undefined;

  if (opts.remediate) {
    remediations = [];

    // FIX 4 guard: defence-in-depth beyond CLI validation.
    // A non-CLI caller could pass apply:true without controlPlaneIp and accidentally
    // delete the world-open :80 rule without adding the control-plane :80 replacement,
    // which would dark the prod control-plane→VM hop.
    if (opts.apply && opts.controlPlaneIp === undefined) {
      throw new Error(
        "runFleetDoctor: apply:true requires controlPlaneIp — " +
        "omitting it would remove the world-open :80 rule without adding " +
        "the control-plane source-restricted replacement (darkening the prod hop).",
      );
    }

    // Collect VMs that failed the web-ports-not-world-open check.
    const webPortFailVms = results.filter(
      (v) =>
        v.checks !== undefined &&
        v.checks.some(
          (c) => c.id === "web-ports-not-world-open" && c.status === "fail",
        ),
    );

    // STRICTLY SEQUENTIAL — for...of, NOT Promise.all.
    for (const vmResult of webPortFailVms) {
      const record = vms.find((r) => r.id === vmResult.vmId);
      if (!record) continue;

      if (!opts.apply) {
        // Dry-run: call the read-only classifier so the report shows the TRUE class.
        // classifyVm only greps /etc/caddy/sites.d/ over SSH — it never mutates.
        let dryVmClass: import("../remediate/firewall-lock.ts").VmClass;
        try {
          dryVmClass = await classifyVm(record, runner);
        } catch {
          dryVmClass = "UNKNOWN";
        }
        remediations.push({
          vmName: vmResult.vmName,
          class: dryVmClass,
          applied: false,
          // wouldLock is true only when the VM would actually be locked (i.e., SAFE).
          wouldLock: dryVmClass === "SAFE",
        });
        continue;
      }

      // Gate 3 — Classifier gate.
      let vmClass: import("../remediate/firewall-lock.ts").VmClass;
      try {
        vmClass = await classifyVm(record, runner);
      } catch {
        vmClass = "UNKNOWN";
      }

      if (vmClass !== "SAFE") {
        const alertMsg =
          vmClass === "ENTANGLED"
            ? `ENTANGLED: sites.d has missing or non-tls-internal snippets; manual review required`
            : `UNKNOWN: classifier SSH probe failed; cannot determine TLS posture`;
        remediations.push({
          vmName: vmResult.vmName,
          class: vmClass,
          applied: false,
          alert: alertMsg,
        });
        err(`fleet-doctor: ${vmResult.vmName}: remediation skipped (${vmClass}): ${alertMsg}`);
        continue;
      }

      // Gate 4 — Apply gate: SAFE + apply.
      const result = await remediateSafeVm(
        record,
        runner,
        true,
        opts.controlPlaneIp,
      );
      remediations.push(result);

      if (result.verified === false) {
        err(
          `fleet-doctor: ${vmResult.vmName}: relock verify FAILED — ${result.alert ?? "unknown"}`,
        );
      }
    }
  }

  const report: FleetDoctorReport = {
    at: new Date().toISOString(),
    vms: results,
    totalVms: vms.length,
    failingVms,
    errorVms,
    findingVms,
    unknownVms,
    ...(remediations !== undefined ? { remediations } : {}),
  };

  // Post fleet alert to GitHub (non-fatal: catch any error).
  if (opts.alertRepo !== undefined) {
    try {
      upsertFleetAlert(report, opts.alertRepo);
    } catch (e) {
      err(`fleet-doctor: alert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Output.
  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(formatFleetReport(report));
  }

  // Exit 1 if any VM is failing or unreachable.
  return failingVms > 0 || errorVms > 0 ? 1 : 0;
}
