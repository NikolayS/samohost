import { describe, expect, test } from "bun:test";
import { buildAuditScript, parseAuditOutput } from "../src/audit/batch.ts";
import {
  DBLAB_PROBES,
  evaluateDblabPreflight,
} from "../src/dblab/preflight.ts";

/** Compose a sections map like parseAuditOutput would produce. */
function sections(o: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(o));
}

/**
 * The LIVE SOLO VM shape (verified 2026-06-11): unit file exists with
 * ExecStart=/usr/local/bin/dblab-engine, service inactive/dead + disabled, no
 * binaries, PG18 up on 127.0.0.1:5432, ZFS datasets reserved.
 */
const LIVE_VM = {
  "unit-file": "Description=Database Lab Engine\nExecStart=/usr/local/bin/dblab-engine",
  "unit-active": "inactive",
  "unit-enabled": "disabled",
  "cli-binary": "NO_CLI",
  "engine-binary": "NO_ENGINE_BINARY",
  "api-listen": "127.0.0.1:5432\n0.0.0.0:2223\n0.0.0.0:443",
  "zfs-datasets": "tank/dblab\ntank/postgresql\ntank/previews",
  "postgres-local": "127.0.0.1:5432 - accepting connections",
};

describe("evaluateDblabPreflight", () => {
  test("LIVE VM shape: engine BLOCKED (installed-shape only), template READY", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM));
    expect(r.engine).toBe("BLOCKED");
    expect(r.templateFallback).toBe("READY");
    const joined = r.reasons.join("\n");
    expect(joined).toContain("INSTALLED SHAPE ONLY");
    expect(joined).toContain("disabled");
    expect(joined).toContain("/usr/local/bin/dblab-engine missing");
    expect(joined).toContain("dblab CLI not on PATH");
    expect(joined).toContain("tank/dblab ZFS dataset is reserved");
  });

  test("fully running engine: READY with no engine reasons", () => {
    const r = evaluateDblabPreflight(
      sections({
        ...LIVE_VM,
        "unit-active": "active",
        "unit-enabled": "enabled",
        "cli-binary": "/usr/local/bin/dblab",
        "engine-binary": "ENGINE_BINARY_OK",
        "api-listen": "127.0.0.1:5432\n127.0.0.1:2345",
      }),
    );
    expect(r.engine).toBe("READY");
    expect(r.reasons.filter((x) => x.startsWith("engine:"))).toEqual([]);
  });

  test("active unit but no CLI and no API listener: BLOCKED", () => {
    const r = evaluateDblabPreflight(
      sections({ ...LIVE_VM, "unit-active": "active" }),
    );
    expect(r.engine).toBe("BLOCKED");
  });

  test("active + API listening but CLI missing: READY via listener evidence", () => {
    const r = evaluateDblabPreflight(
      sections({
        ...LIVE_VM,
        "unit-active": "active",
        "api-listen": "127.0.0.1:2345",
      }),
    );
    expect(r.engine).toBe("READY");
  });

  test("no probe output at all: engine and fallback UNKNOWN", () => {
    const r = evaluateDblabPreflight(sections({}));
    expect(r.engine).toBe("UNKNOWN");
    expect(r.templateFallback).toBe("UNKNOWN");
  });

  test("postgres down: template fallback BLOCKED", () => {
    const r = evaluateDblabPreflight(
      sections({
        ...LIVE_VM,
        "postgres-local": "127.0.0.1:5432 - no response",
      }),
    );
    expect(r.templateFallback).toBe("BLOCKED");
  });

  test("port 5432 listening does NOT count as the dblab API", () => {
    const r = evaluateDblabPreflight(
      sections({ ...LIVE_VM, "unit-active": "active", "cli-binary": "NO_CLI" }),
    );
    // 127.0.0.1:5432 in api-listen must not satisfy the :2345 check.
    expect(r.engine).toBe("BLOCKED");
  });

  test("every check id appears exactly once in the report", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM));
    expect(r.checks.map((c) => c.id).sort()).toEqual(
      DBLAB_PROBES.map((p) => p.id).sort(),
    );
  });
});

describe("probe script round-trip", () => {
  test("buildAuditScript + parseAuditOutput recover per-probe sections", () => {
    const script = buildAuditScript(DBLAB_PROBES);
    expect(script).toContain("systemctl is-active dblab.service");
    expect(script).toContain("zfs list");
    // Simulate combined remote output with delimiters as the script emits them.
    const fake = DBLAB_PROBES.map(
      (p) => `<<<SAMOHOST_AUDIT:${p.id}>>>\noutput-of-${p.id}`,
    ).join("\n");
    const parsed = parseAuditOutput(fake, DBLAB_PROBES);
    expect(parsed.get("unit-active")).toBe("output-of-unit-active");
    expect(parsed.size).toBe(DBLAB_PROBES.length);
  });

  test("probes are read-only (no sudo, no mutating commands)", () => {
    for (const p of DBLAB_PROBES) {
      expect(p.probeCommand).not.toContain("sudo");
      expect(p.probeCommand).not.toMatch(/\b(rm|tee|mv|cp|mkdir|touch|dd)\b/);
      // Only redirections to /dev/null or fd-merges are allowed.
      for (const m of p.probeCommand.matchAll(/\d?>+\s*(\S+)/g)) {
        expect(["/dev/null", "&1", "&2"]).toContain(m[1]!);
      }
    }
  });
});
