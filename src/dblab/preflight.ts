/**
 * DBLab Engine preflight for SOLO previews (SPEC-DELTA §4 dblab backend).
 *
 * The runtime-verified contract (issue #7, live install 2026-06-12 on the
 * SOLO VM, DBLab v4.1.3): the engine runs as the `dblab_server` docker
 * container (postgresai/dblab-server) with its API on 127.0.0.1:2345; the
 * legacy `dblab.service` unit's ExecStart binary (/usr/local/bin/dblab-engine)
 * has no published artifact and the unit is retired — probing it produced
 * false BLOCKED verdicts once the real engine was live. Liveness is therefore
 * the engine's own `/healthz` endpoint; drivability is the `dblab` client CLI
 * resolving on PATH or at ~/bin/dblab (the runbook's install location, which
 * non-login shells do not have on PATH).
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
    id: "engine-healthz",
    description: `engine healthz answering on 127.0.0.1:${DBLAB_API_PORT}`,
    probeCommand: `curl -fsS --max-time 5 http://127.0.0.1:${DBLAB_API_PORT}/healthz 2>/dev/null || echo NO_HEALTHZ`,
    expect: "",
  },
  {
    id: "engine-container",
    description: "dblab_server container (image + status)",
    probeCommand:
      "docker ps --filter name=dblab_server --format '{{.Image}} {{.Status}}' 2>/dev/null | grep . || echo NO_CONTAINER",
    expect: "",
  },
  {
    id: "cli-binary",
    description: "dblab CLI on PATH or at ~/bin/dblab",
    probeCommand:
      'command -v dblab 2>/dev/null || { test -x "$HOME/bin/dblab" && echo "$HOME/bin/dblab"; } || echo NO_CLI',
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
 * engine READY    : healthz answers AND the CLI resolves (PATH or ~/bin) —
 *                   the same two conditions the generated db-preflight phase
 *                   gates on, so the verdicts cannot diverge.
 * engine BLOCKED  : healthz dead or CLI missing; container/ZFS facts are
 *                   reported as context, never as a substitute for healthz.
 * engine UNKNOWN  : probes missing/unreadable (e.g. connection died).
 */
export function evaluateDblabPreflight(
  sections: Map<string, string>,
): DblabPreflightReport {
  const checks: DblabCheckResult[] = [];
  const reasons: string[] = [];

  const get = (id: string) => section(sections, id);

  // --- engine healthz (the liveness gate) ---
  const healthz = get("engine-healthz");
  const healthzOk = healthz !== undefined && !healthz.includes("NO_HEALTHZ");
  checks.push({
    id: "engine-healthz",
    status: healthz === undefined ? "unknown" : healthzOk ? "pass" : "fail",
    detail: healthz ?? "no probe output",
  });

  // --- engine container (the runtime model; reported, not gating) ---
  const container = get("engine-container");
  const containerUp =
    container !== undefined && !container.includes("NO_CONTAINER");
  checks.push({
    id: "engine-container",
    status:
      container === undefined ? "unknown" : containerUp ? "pass" : "fail",
    detail: containerUp ? container : "dblab_server container not running",
  });

  // --- CLI (two-path resolution: PATH or ~/bin/dblab) ---
  const cli = get("cli-binary");
  const cliPresent = cli !== undefined && !cli.includes("NO_CLI");
  checks.push({
    id: "cli-binary",
    status: cli === undefined ? "unknown" : cliPresent ? "pass" : "fail",
    detail: cliPresent ? cli!.trim() : "not on PATH and no ~/bin/dblab",
  });

  // --- API listener (corroboration only; healthz is authoritative) ---
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
  const coreUnknown = healthz === undefined && cli === undefined;
  if (coreUnknown) {
    engine = "UNKNOWN";
    reasons.push("engine: probes returned nothing — connection or probe failure");
  } else if (healthzOk && cliPresent) {
    engine = "READY";
  } else {
    engine = "BLOCKED";
    if (!healthzOk) {
      reasons.push(
        `engine: no answer on http://127.0.0.1:${DBLAB_API_PORT}/healthz — ` +
          "the engine is not running; install/start it per docs/dblab-install-runbook.md",
      );
      if (!containerUp && container !== undefined) {
        reasons.push(
          "engine: dblab_server container is not running (the engine ships " +
            "as the postgresai/dblab-server docker container)",
        );
      }
    }
    if (!cliPresent) {
      reasons.push(
        "engine: dblab CLI not found on PATH or at ~/bin/dblab — env scripts " +
          "cannot drive clones",
      );
    }
    if (!apiListening && listeners !== undefined && !healthzOk) {
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
