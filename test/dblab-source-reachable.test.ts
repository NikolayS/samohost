/**
 * test/dblab-source-reachable.test.ts — RED→GREEN TDD
 *
 * Root cause (verified 2026-07-16 on samograph): the DBLab engine's
 * `logicalDump` job uses `pg_dump` against the source connection
 * (server.yml `retrieval.spec.logicalDump.options.source.connection`).
 * When postgres starts BEFORE docker0 is assigned its IP (e.g. because
 * dockerd restarted after postgres), postgres never binds the docker0
 * address (`172.17.0.1`) even though `listen_addresses` includes it.
 * The scheduled refresh then runs `pg_dump` → "Connection refused" →
 * marks the pool "empty" → DROPS ALL LIVE CLONES.
 *
 * Fix applied 2026-07-16:
 *   1. Restart postgres to bind the docker0 address (one-time; prod
 *      blipped < 5s then reconnected).
 *   2. Recreate the dblab container with `--add-host=host.docker.internal:host-gateway`
 *      and point `source.connection.host` at `host.docker.internal` in
 *      server.yml — so the container always resolves the gateway IP at
 *      runtime regardless of what the docker0 IP happens to be.
 *   3. Add a systemd drop-in for `postgresql@16-main.service`:
 *      `After=docker.service Wants=docker.service` so on reboot postgres
 *      starts AFTER docker0 exists and binds all configured addresses.
 *   4. Raise `maxCloneCount` from 4 → 8 so new previews are not refused.
 *
 * Samohost-owned productization:
 *   - docs/dblab-install-runbook.md: update `docker run` to include
 *     `--add-host=host.docker.internal:host-gateway`; document the
 *     postgresql ordering drop-in; note maxCloneCount ≥ 8 for multi-PR
 *     workloads.
 *   - src/dblab/preflight.ts: add `dblab-source-reachable` probe (nc from
 *     the dblab container to host.docker.internal:5432) + evaluate
 *     `source` verdict so operators are warned BEFORE a refresh bombs.
 */

import { describe, expect, test } from "bun:test";
import {
  DBLAB_PROBES,
  evaluateDblabPreflight,
} from "../src/dblab/preflight.ts";

/** Compose a sections map like parseAuditOutput would produce. */
function sections(o: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(o));
}

/**
 * Full healthy shape (2026-07-16 samograph post-fix, verified at runtime):
 * - engine up, healthz 200, CLI at ~/bin/dblab
 * - source reachable: `nc -w2 host.docker.internal 5432` from the
 *   dblab container returns "open" (Connection established)
 * - postgres bound on docker0 (172.17.0.1:5432) AND on 127.0.0.1:5432
 */
const LIVE_VM_WITH_SOURCE = {
  "engine-healthz":
    '{"version":"v4.1.3-20260508-1125","edition":"community","instanceID":"d961sbo0238c73bd09d0"}',
  "engine-container": "postgresai/dblab-server:4.1.3 Up 2 hours",
  "cli-binary": "/home/samo/bin/dblab",
  "api-listen": "127.0.0.1:5432\n172.17.0.1:5432\n127.0.0.1:2345\n0.0.0.0:2223",
  "zfs-datasets": "dblab/dblab_pool",
  "postgres-local": "127.0.0.1:5432 - accepting connections",
  // NEW: source reachable from within the dblab container
  "dblab-source-reachable": "host.docker.internal (172.17.0.1:5432) open",
};

/**
 * Source BROKEN shape: postgres started before docker0 was assigned —
 * only binds 127.0.0.1, never 172.17.0.1. nc from the dblab container
 * returns "Connection refused". This is the time-bomb state found on
 * 2026-07-16.
 */
const SOURCE_BROKEN = {
  ...LIVE_VM_WITH_SOURCE,
  "dblab-source-reachable": "nc: connect to host.docker.internal (172.17.0.1) port 5432 (tcp) failed: Connection refused",
};

/** Source probe not yet installed (old dblab container without --add-host). */
const SOURCE_PROBE_MISSING = {
  ...LIVE_VM_WITH_SOURCE,
  "dblab-source-reachable": "NO_SOURCE_PROBE",
};

describe("dblab-source-reachable probe (Bug C — 2026-07-16 time bomb)", () => {
  // RED: this probe does not exist yet in DBLAB_PROBES.
  test("DBLAB_PROBES includes a dblab-source-reachable probe that runs nc from the dblab container", () => {
    const probe = DBLAB_PROBES.find((p) => p.id === "dblab-source-reachable");
    expect(probe).toBeDefined();
    // The probe runs `nc` from INSIDE the dblab container so it tests
    // the exact same network path that logicalDump uses.
    expect(probe?.probeCommand).toContain("docker exec dblab_server");
    expect(probe?.probeCommand).toContain("nc");
    // Tests the host.docker.internal alias (resilient to docker0 IP changes).
    expect(probe?.probeCommand).toContain("host.docker.internal");
    expect(probe?.probeCommand).toContain("5432");
  });

  // RED: evaluateDblabPreflight does not emit a `source` verdict yet.
  test("source READY when nc from dblab container to host.docker.internal:5432 succeeds", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM_WITH_SOURCE));
    expect(r.source).toBe("READY");
    const check = r.checks.find((c) => c.id === "dblab-source-reachable");
    expect(check?.status).toBe("pass");
  });

  test("source BLOCKED when nc returns Connection refused — surfaces the time-bomb warning", () => {
    const r = evaluateDblabPreflight(sections(SOURCE_BROKEN));
    expect(r.source).toBe("BLOCKED");
    const reasons = r.reasons.join("\n");
    // Must surface the actionable fix: restart postgres and use host-gateway.
    expect(reasons).toContain("source");
    expect(reasons).toContain("172.17.0.1");
    expect(reasons).toContain("restart");
    // Must name the ordering fix so the operator knows the durable solution.
    expect(reasons).toContain("After=docker.service");
  });

  test("source UNKNOWN when probe is missing (old container without --add-host)", () => {
    const r = evaluateDblabPreflight(sections(SOURCE_PROBE_MISSING));
    expect(r.source).toBe("UNKNOWN");
    const reasons = r.reasons.join("\n");
    expect(reasons).toContain("source");
  });

  test("source UNKNOWN when probe section absent entirely", () => {
    // No dblab-source-reachable key in sections.
    const r = evaluateDblabPreflight(sections({
      "engine-healthz": LIVE_VM_WITH_SOURCE["engine-healthz"],
      "engine-container": LIVE_VM_WITH_SOURCE["engine-container"],
      "cli-binary": LIVE_VM_WITH_SOURCE["cli-binary"],
      "api-listen": LIVE_VM_WITH_SOURCE["api-listen"],
      "zfs-datasets": LIVE_VM_WITH_SOURCE["zfs-datasets"],
      "postgres-local": LIVE_VM_WITH_SOURCE["postgres-local"],
    }));
    expect(r.source).toBe("UNKNOWN");
  });

  test("every check id in report matches DBLAB_PROBES 1:1 including the new source probe", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM_WITH_SOURCE));
    const reportIds = r.checks.map((c) => c.id).sort();
    const probeIds = DBLAB_PROBES.map((p) => p.id).sort();
    expect(reportIds).toEqual(probeIds);
  });

  test("engine READY verdict is unaffected when source is broken (source is a separate gate)", () => {
    // The engine may be up even when source is broken (clones still work;
    // only the NEXT SCHEDULED REFRESH would fail). Engine verdict must not
    // be downgraded — callers that gate only on engine READY still work.
    const r = evaluateDblabPreflight(sections(SOURCE_BROKEN));
    expect(r.engine).toBe("READY");
  });

  test("source probe is read-only — no sudo, no mutating commands", () => {
    const probe = DBLAB_PROBES.find((p) => p.id === "dblab-source-reachable");
    expect(probe).toBeDefined();
    expect(probe!.probeCommand).not.toContain("sudo");
    expect(probe!.probeCommand).not.toMatch(/\b(rm|tee|mv|cp|mkdir|touch|dd)\b/);
  });
});

describe("runbook content — docker run includes --add-host (Bug C regression gate)", () => {
  // Verify that the install runbook's `docker run` command documents the
  // --add-host flag so new VM installs don't reproduce the time bomb.
  test("dblab-install-runbook.md documents --add-host=host.docker.internal:host-gateway in docker run", async () => {
    const fs = await import("node:fs/promises");
    const runbook = await fs.readFile(
      new URL("../docs/dblab-install-runbook.md", import.meta.url),
      "utf-8",
    );
    // The canonical docker run command must include the host-gateway flag.
    expect(runbook).toContain("--add-host=host.docker.internal:host-gateway");
    // The source connection must reference host.docker.internal (not a raw IP).
    expect(runbook).toContain("host.docker.internal");
    // The postgresql ordering drop-in must be documented.
    expect(runbook).toContain("After=docker.service");
    expect(runbook).toContain("postgresql@");
    // maxCloneCount guidance must be present.
    expect(runbook).toContain("maxCloneCount");
  });
});
