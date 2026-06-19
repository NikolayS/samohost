/**
 * Tests for src/preview/heal-deps.ts — classifyClone, parseBatchedProbe,
 * buildBatchedProbeScript (samohost #78 production probe). PURE; offline.
 *
 * Verdict contract:
 *   - SSH failed / no CLI                → every clone unknown (fail-closed)
 *   - status ERR (clone gone)            → dead
 *   - status OK + port + port listening  → alive
 *   - status OK + port NOT listening     → dead (the 03:00-refresh symptom)
 *   - status not OK (FATAL etc.)         → dead
 *   - clone id with no section in output → unknown (fail-closed)
 *   - garbage status section             → unknown (fail-closed)
 */

import { describe, expect, test } from "bun:test";
import {
  classifyClone,
  isBudgetMessage,
  parseBatchedProbe,
  buildBatchedProbeScript,
  HEAL_PROBE_NO_CLI,
  HEAL_PROBE_CLONE_BEGIN,
  HEAL_PROBE_CLONE_END,
  HEAL_PROBE_STATUS_ERR,
  HEAL_PROBE_PORTS_BEGIN,
  HEAL_PROBE_PORTS_END,
} from "../src/preview/heal-deps.ts";

function okStatus(port: number): string {
  return JSON.stringify({
    id: "field-record-preview-modern-font",
    status: { code: "OK", message: "Clone is ready to accept Postgres connections." },
    db: { host: "localhost", port: String(port), username: "samohost_env", dbName: "postgres" },
  });
}

function ssWith(...ports: number[]): string {
  return ports.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:*`).join("\n");
}

/** Frame a batched probe output for the given clone sections + ss block. */
function frameBatch(sections: Record<string, string>, ssLines: string): string {
  const parts: string[] = [];
  for (const [id, body] of Object.entries(sections)) {
    parts.push(`${HEAL_PROBE_CLONE_BEGIN}${id}`, body, `${HEAL_PROBE_CLONE_END}${id}`);
  }
  parts.push(HEAL_PROBE_PORTS_BEGIN, ssLines, HEAL_PROBE_PORTS_END);
  return parts.join("\n");
}

describe("classifyClone (samohost #78)", () => {
  test("clone gone (STATUS_ERR) → dead", () => {
    expect(classifyClone(HEAL_PROBE_STATUS_ERR, new Set([3100]))).toBe("dead");
  });
  test("OK + listening port → alive", () => {
    expect(classifyClone(okStatus(6003), new Set([6003, 3102]))).toBe("alive");
  });
  test("OK + port NOT listening → dead (03:00-refresh symptom)", () => {
    expect(classifyClone(okStatus(6003), new Set([3100, 3101]))).toBe("dead");
  });
  test("non-OK status (FATAL) → dead", () => {
    const fatal = JSON.stringify({ status: { code: "FATAL" }, db: { port: "" } });
    expect(classifyClone(fatal, new Set([3103]))).toBe("dead");
  });
  test("OK but no port → dead", () => {
    const noPort = JSON.stringify({ status: { code: "OK" }, db: { port: "" } });
    expect(classifyClone(noPort, new Set([6003]))).toBe("dead");
  });
  test("empty section → unknown (fail-closed)", () => {
    expect(classifyClone("", new Set([6003]))).toBe("unknown");
  });
  test("garbage section → unknown (fail-closed)", () => {
    expect(classifyClone("not json", new Set([6003]))).toBe("unknown");
  });
});

describe("parseBatchedProbe (samohost #78)", () => {
  test("SSH transport failure → every clone unknown", () => {
    const m = parseBatchedProbe(false, "", ["a", "b"]);
    expect(m.get("a")).toBe("unknown");
    expect(m.get("b")).toBe("unknown");
  });

  test("no dblab CLI on host → every clone unknown", () => {
    const m = parseBatchedProbe(true, HEAL_PROBE_NO_CLI, ["a", "b"]);
    expect(m.get("a")).toBe("unknown");
    expect(m.get("b")).toBe("unknown");
  });

  test("mixed batch: one alive, one dead-by-port, one gone, one missing", () => {
    const ids = ["alive-one", "deadport-one", "gone-one", "absent-one"];
    const out = frameBatch(
      {
        "alive-one": okStatus(6003),
        "deadport-one": okStatus(6099), // port not in ss
        "gone-one": HEAL_PROBE_STATUS_ERR,
        // "absent-one" has NO section at all
      },
      ssWith(6003, 3100),
    );
    const m = parseBatchedProbe(true, out, ids);
    expect(m.get("alive-one")).toBe("alive");
    expect(m.get("deadport-one")).toBe("dead");
    expect(m.get("gone-one")).toBe("dead");
    expect(m.get("absent-one")).toBe("unknown"); // missing section → fail-closed
  });
});

describe("buildBatchedProbeScript (samohost #78)", () => {
  test("is read-only and covers every clone id in one script", () => {
    const s = buildBatchedProbeScript(["clone-a", "clone-b"]);
    expect(s).toContain("clone status");
    expect(s).toContain("ss -ltnH");
    expect(s).not.toContain("sudo");
    expect(s).not.toContain("clone create");
    expect(s).not.toContain("clone destroy");
    expect(s).toContain("'clone-a'");
    expect(s).toContain("'clone-b'");
    // The ports block appears exactly once for the whole batch.
    expect(s.split(HEAL_PROBE_PORTS_BEGIN).length - 1).toBe(1);
  });

  test("safely single-quotes a clone id containing a quote", () => {
    const s = buildBatchedProbeScript(["weird'id"]);
    expect(s).toContain("weird'\\''id");
  });
});

describe("isBudgetMessage (samohost #78)", () => {
  test("matches the BudgetExceededError stderr signature", () => {
    const msg = "error: remote env-create connection failed: connection budget exhausted for vm X: 2 attempts per 600s. Refusing to connect again";
    expect(isBudgetMessage(msg)).toBe(true);
  });
  test("does not match an ordinary create failure", () => {
    expect(isBudgetMessage("env create did not succeed (outcome=failed)")).toBe(false);
  });
});
