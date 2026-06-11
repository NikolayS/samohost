/**
 * DBLab Engine preflight for SOLO previews (SPEC-DELTA §4 dblab backend).
 *
 * The live VM teaches the distinction this module encodes: an INSTALLED SHAPE
 * (dblab.service unit file exists, ZFS datasets tank/dblab|postgresql|previews
 * reserved) is not a RUNNING ENGINE (unit inactive/dead + disabled, no
 * dblab/dblab-engine binary on PATH, no API listening). `env create --db dblab`
 * must be gated on the latter, not the former.
 *
 * Probes are read-only, unprivileged where possible, and batched into ONE SSH
 * connection via audit/batch.ts (same fail2ban-safety requirement as audits).
 * Evaluation is PURE: probe outputs in, a typed report out — fully
 * unit-testable offline.
 */

import type { AuditCheck } from "../types.ts";

/** DBLab Engine's default API port. */
export const DBLAB_API_PORT = 2345;

/**
 * Probe set. Shaped as {@link AuditCheck}s so buildAuditScript/parseAuditOutput
 * are reused verbatim; `expect` is unused here (evaluation below is richer
 * than regex matching).
 */
export const DBLAB_PROBES: AuditCheck[] = [
  {
    id: "unit-file",
    description: "dblab.service unit file exists (shows ExecStart)",
    probeCommand:
      "systemctl cat dblab.service 2>/dev/null | grep -E '^(ExecStart|Description)=' || echo NO_UNIT",
    expect: "",
  },
  {
    id: "unit-active",
    description: "dblab.service is active",
    probeCommand: "systemctl is-active dblab.service",
    expect: "",
  },
  {
    id: "unit-enabled",
    description: "dblab.service is enabled",
    probeCommand: "systemctl is-enabled dblab.service",
    expect: "",
  },
  {
    id: "cli-binary",
    description: "dblab CLI on PATH",
    probeCommand: "command -v dblab || echo NO_CLI",
    expect: "",
  },
  {
    id: "engine-binary",
    description: "engine binary at the unit's ExecStart path",
    probeCommand:
      "test -x /usr/local/bin/dblab-engine && echo ENGINE_BINARY_OK || echo NO_ENGINE_BINARY",
    expect: "",
  },
  {
    id: "api-listen",
    description: `something listening on the DBLab API port ${DBLAB_API_PORT}`,
    probeCommand: `ss -ltnH 2>/dev/null | awk '{print $4}' || echo SS_FAILED`,
    expect: "",
  },
  {
    id: "zfs-datasets",
    description: "ZFS datasets for dblab/postgres/previews",
    probeCommand:
      "zfs list -H -o name 2>/dev/null | grep -E '^tank/(dblab|postgresql|previews)$' || echo NO_ZFS_MATCH",
    expect: "",
  },
  {
    id: "postgres-local",
    description: "local PostgreSQL accepting connections on 127.0.0.1:5432",
    probeCommand: "pg_isready -h 127.0.0.1 -p 5432 2>&1 || true",
    expect: "",
  },
];

export type PreflightStatus = "READY" | "BLOCKED" | "UNKNOWN";

export interface DblabCheckResult {
  id: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
}

export interface DblabPreflightReport {
  /** The gate for `env create --db dblab`: engine confirmed running. */
  engine: PreflightStatus;
  /** Readiness of the `--db template` fallback (local Postgres up). */
  templateFallback: PreflightStatus;
  checks: DblabCheckResult[];
  reasons: string[];
}

function section(
  sections: Map<string, string>,
  id: string,
): string | undefined {
  const s = sections.get(id);
  return s === undefined || s.length === 0 ? undefined : s;
}

/**
 * Pure evaluation of the batched probe output (parseAuditOutput sections).
 *
 * engine READY    : unit active AND engine/api evidence (binary or listener)
 * engine BLOCKED  : positive evidence the engine is NOT running (inactive,
 *                   disabled-only shape, binary missing) — installed-shape
 *                   facts (unit file, ZFS datasets) do NOT make it ready.
 * engine UNKNOWN  : probes missing/unreadable (e.g. connection died).
 */
export function evaluateDblabPreflight(
  sections: Map<string, string>,
): DblabPreflightReport {
  const checks: DblabCheckResult[] = [];
  const reasons: string[] = [];

  const get = (id: string) => section(sections, id);

  // --- unit file (installed shape) ---
  const unitFile = get("unit-file");
  const unitFilePresent =
    unitFile !== undefined && !unitFile.includes("NO_UNIT");
  checks.push({
    id: "unit-file",
    status: unitFile === undefined ? "unknown" : unitFilePresent ? "pass" : "fail",
    detail: unitFile ?? "no probe output",
  });

  // --- unit active ---
  const active = get("unit-active");
  const isActive = active !== undefined && active.trim() === "active";
  checks.push({
    id: "unit-active",
    status: active === undefined ? "unknown" : isActive ? "pass" : "fail",
    detail: active ?? "no probe output",
  });

  // --- unit enabled ---
  const enabled = get("unit-enabled");
  const isEnabled = enabled !== undefined && enabled.trim() === "enabled";
  checks.push({
    id: "unit-enabled",
    status: enabled === undefined ? "unknown" : isEnabled ? "pass" : "fail",
    detail: enabled ?? "no probe output",
  });

  // --- binaries ---
  const cli = get("cli-binary");
  const cliPresent = cli !== undefined && !cli.includes("NO_CLI");
  checks.push({
    id: "cli-binary",
    status: cli === undefined ? "unknown" : cliPresent ? "pass" : "fail",
    detail: cli ?? "no probe output",
  });

  const engineBin = get("engine-binary");
  const engineBinPresent =
    engineBin !== undefined && engineBin.includes("ENGINE_BINARY_OK");
  checks.push({
    id: "engine-binary",
    status:
      engineBin === undefined ? "unknown" : engineBinPresent ? "pass" : "fail",
    detail: engineBin ?? "no probe output",
  });

  // --- API listener ---
  const listeners = get("api-listen");
  const apiListening =
    listeners !== undefined &&
    !listeners.includes("SS_FAILED") &&
    new RegExp(`[:.]${DBLAB_API_PORT}$`, "m").test(listeners);
  checks.push({
    id: "api-listen",
    status:
      listeners === undefined || listeners.includes("SS_FAILED")
        ? "unknown"
        : apiListening
          ? "pass"
          : "fail",
    detail: apiListening
      ? `listener on :${DBLAB_API_PORT}`
      : `no listener on :${DBLAB_API_PORT}`,
  });

  // --- ZFS datasets (installed shape / capacity) ---
  const zfs = get("zfs-datasets");
  const datasets =
    zfs === undefined || zfs.includes("NO_ZFS_MATCH")
      ? []
      : zfs.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  checks.push({
    id: "zfs-datasets",
    status: zfs === undefined ? "unknown" : datasets.length > 0 ? "pass" : "fail",
    detail: datasets.length > 0 ? datasets.join(", ") : "none found",
  });

  // --- local postgres (template fallback) ---
  const pg = get("postgres-local");
  const pgUp = pg !== undefined && /accepting connections/i.test(pg);
  checks.push({
    id: "postgres-local",
    status: pg === undefined ? "unknown" : pgUp ? "pass" : "fail",
    detail: pg ?? "no probe output",
  });

  // ---- engine verdict -------------------------------------------------------
  let engine: PreflightStatus;
  const coreUnknown = active === undefined && cli === undefined;
  if (coreUnknown) {
    engine = "UNKNOWN";
    reasons.push("engine: probes returned nothing — connection or probe failure");
  } else if (isActive && (cliPresent || apiListening)) {
    engine = "READY";
  } else {
    engine = "BLOCKED";
    if (unitFilePresent && !isActive) {
      reasons.push(
        "engine: INSTALLED SHAPE ONLY — dblab.service unit file exists but the " +
          `service is ${active?.trim() ?? "unknown"}` +
          (isEnabled ? "" : " and disabled"),
      );
    } else if (!unitFilePresent) {
      reasons.push("engine: no dblab.service unit on the host");
    }
    if (!engineBinPresent) {
      reasons.push(
        "engine: ExecStart binary /usr/local/bin/dblab-engine missing or not " +
          "executable — the unit cannot start until the engine is installed",
      );
    }
    if (!cliPresent) {
      reasons.push("engine: dblab CLI not on PATH — env scripts cannot drive clones");
    }
    if (!apiListening && listeners !== undefined) {
      reasons.push(`engine: nothing listening on the API port :${DBLAB_API_PORT}`);
    }
    if (datasets.includes("tank/dblab")) {
      reasons.push(
        "note: tank/dblab ZFS dataset is reserved — storage is ready once the " +
          "engine is installed",
      );
    }
  }

  // ---- template fallback verdict -------------------------------------------
  let templateFallback: PreflightStatus;
  if (pg === undefined) {
    templateFallback = "UNKNOWN";
    reasons.push("template fallback: postgres probe returned nothing");
  } else if (pgUp) {
    templateFallback = "READY";
  } else {
    templateFallback = "BLOCKED";
    reasons.push(
      "template fallback: local PostgreSQL is not accepting connections on " +
        "127.0.0.1:5432",
    );
  }

  return { engine, templateFallback, checks, reasons };
}
