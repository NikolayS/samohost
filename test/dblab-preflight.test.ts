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
 * The LIVE SOLO VM shape (runtime-verified 2026-06-12, issue #7): the engine
 * runs as the `dblab_server` docker container (postgresai/dblab-server:4.1.3),
 * healthz answers on 127.0.0.1:2345, the CLI lives at ~agent/bin/dblab (NOT on
 * PATH in non-login shells), and the legacy dblab.service ExecStart binary
 * does not exist. healthz body captured verbatim from the live engine.
 */
const LIVE_VM = {
  "engine-healthz":
    '{"version":"v4.1.3-20260508-1125","edition":"community","instanceID":"d8lkc7q52olc73a3g70g"}',
  "engine-container": "postgresai/dblab-server:4.1.3 Up 2 hours",
  "cli-binary": "/home/agent/bin/dblab",
  "api-listen": "127.0.0.1:5432\n127.0.0.1:2345\n0.0.0.0:2223\n0.0.0.0:443",
  "zfs-datasets": "tank/dblab\ntank/postgresql\ntank/previews",
  "postgres-local": "127.0.0.1:5432 - accepting connections",
};

/** The pre-install shape (engine down, no CLI anywhere). */
const ENGINE_DOWN = {
  ...LIVE_VM,
  "engine-healthz": "NO_HEALTHZ",
  "engine-container": "NO_CONTAINER",
  "cli-binary": "NO_CLI",
  "api-listen": "127.0.0.1:5432\n0.0.0.0:2223\n0.0.0.0:443",
};

describe("evaluateDblabPreflight (issue #7: healthz is the gate, not the retired unit)", () => {
  test("LIVE VM shape: engine READY via healthz + home-dir CLI; legacy unit irrelevant", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM));
    expect(r.engine).toBe("READY");
    expect(r.templateFallback).toBe("READY");
    expect(r.reasons.filter((x) => x.startsWith("engine:"))).toEqual([]);
    // The container model is REPORTED (image + status), not just probed.
    const container = r.checks.find((c) => c.id === "engine-container");
    expect(container?.status).toBe("pass");
    expect(container?.detail).toContain("postgresai/dblab-server:4.1.3");
    // CLI detail names the resolved path (PATH or ~/bin fallback).
    const cli = r.checks.find((c) => c.id === "cli-binary");
    expect(cli?.status).toBe("pass");
    expect(cli?.detail).toContain("/home/agent/bin/dblab");
  });

  test("engine down (pre-install shape): BLOCKED with healthz + runbook + CLI reasons", () => {
    const r = evaluateDblabPreflight(sections(ENGINE_DOWN));
    expect(r.engine).toBe("BLOCKED");
    expect(r.templateFallback).toBe("READY");
    const joined = r.reasons.join("\n");
    expect(joined).toContain("healthz");
    expect(joined).toContain("docs/dblab-install-runbook.md");
    expect(joined).toContain("dblab_server");
    expect(joined).toContain("dblab CLI not found");
    expect(joined).toContain("~/bin/dblab");
    expect(joined).toContain("tank/dblab ZFS dataset is reserved");
  });

  test("healthz answers but CLI missing everywhere: BLOCKED naming the CLI", () => {
    const r = evaluateDblabPreflight(
      sections({ ...LIVE_VM, "cli-binary": "NO_CLI" }),
    );
    expect(r.engine).toBe("BLOCKED");
    expect(r.reasons.join("\n")).toContain("dblab CLI not found");
  });

  test("CLI present but healthz dead: BLOCKED (container evidence does not substitute)", () => {
    const r = evaluateDblabPreflight(
      sections({ ...LIVE_VM, "engine-healthz": "NO_HEALTHZ" }),
    );
    expect(r.engine).toBe("BLOCKED");
    expect(r.reasons.join("\n")).toContain("healthz");
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

  test("every check id appears exactly once in the report", () => {
    const r = evaluateDblabPreflight(sections(LIVE_VM));
    expect(r.checks.map((c) => c.id).sort()).toEqual(
      DBLAB_PROBES.map((p) => p.id).sort(),
    );
  });
});

describe("probe set (issue #7 contract)", () => {
  test("probes the engine API + container + two-path CLI; never the retired unit", () => {
    const all = DBLAB_PROBES.map((p) => p.probeCommand).join("\n");
    expect(all).toContain("curl -fsS --max-time 5 http://127.0.0.1:2345/healthz");
    expect(all).toContain("dblab_server");
    expect(all).toContain("command -v dblab");
    expect(all).toContain("$HOME/bin/dblab");
    // The legacy unit/binary do not exist on the host — probing them produced
    // false BLOCKED verdicts.
    expect(all).not.toContain("dblab.service");
    expect(all).not.toContain("/usr/local/bin/dblab-engine");
  });

  test("buildAuditScript + parseAuditOutput recover per-probe sections", () => {
    const script = buildAuditScript(DBLAB_PROBES);
    expect(script).toContain("healthz");
    expect(script).toContain("zfs list");
    // Simulate combined remote output with delimiters as the script emits them.
    const fake = DBLAB_PROBES.map(
      (p) => `<<<SAMOHOST_AUDIT:${p.id}>>>\noutput-of-${p.id}`,
    ).join("\n");
    const parsed = parseAuditOutput(fake, DBLAB_PROBES);
    expect(parsed.get("engine-healthz")).toBe("output-of-engine-healthz");
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
