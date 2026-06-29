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
import type { StateStore } from "../state/store.ts";
import type { AppStore } from "../state/apps.ts";
import type { RemoteRunner } from "./status.ts";

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
  at: string;         // ISO-8601
  vms: FleetVmResult[];
  totalVms: number;   // VMs attempted (lifecycleState in {ready,adopted})
  failingVms: number; // VMs with ≥1 fail (group !== core-suspicious)
  errorVms: number;   // VMs where probeError is set
  findingVms: number; // VMs with ≥1 suspicious finding
}

// ---------------------------------------------------------------------------
// Default alert repo for upsertFleetAlert.
// ---------------------------------------------------------------------------

const DEFAULT_ALERT_REPO = "NikolayS/samohost";

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
  opts: { json: boolean; alertRepo?: string },
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
      results.push({ vmId: record.id, vmName: record.name, probeError: `probe-error: ${msg}` });
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

  const report: FleetDoctorReport = {
    at: new Date().toISOString(),
    vms: results,
    totalVms: vms.length,
    failingVms,
    errorVms,
    findingVms,
  };

  // Post fleet alert to GitHub (non-fatal: catch any error).
  const alertRepo = opts.alertRepo ?? DEFAULT_ALERT_REPO;
  // Only alert when there's an explicit alertRepo or the default repo is clearly intended.
  // For the fleet alert, we always try when alertRepo is explicitly set or VMs exist.
  if (opts.alertRepo !== undefined) {
    try {
      upsertFleetAlert(report, alertRepo);
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
