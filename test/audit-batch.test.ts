import { describe, expect, test } from "bun:test";
import {
  buildAuditScript,
  parseAuditOutput,
} from "../src/audit/batch.ts";
import type { AuditCheck } from "../src/types.ts";

const CHECKS: AuditCheck[] = [
  {
    id: "alpha",
    description: "first probe",
    probeCommand: "echo a",
    expect: "a",
  },
  {
    id: "beta",
    description: "second probe",
    probeCommand: "systemctl is-active foo",
    expect: /^active$/m,
  },
];

describe("buildAuditScript", () => {
  test("renders one delimiter + wrapped probe per check, exits 0", () => {
    const script = buildAuditScript(CHECKS);
    expect(script).toBe(
      [
        "set -u",
        "",
        'echo "<<<SAMOHOST_AUDIT:alpha>>>"',
        "{ echo a ; } 2>&1 || true",
        'echo "<<<SAMOHOST_AUDIT:beta>>>"',
        "{ systemctl is-active foo ; } 2>&1 || true",
        "exit 0",
        "",
      ].join("\n"),
    );
  });

  test("a failing probe cannot abort later probes (|| true wrapping)", () => {
    const script = buildAuditScript(CHECKS);
    for (const line of script.split("\n")) {
      if (line.startsWith("{ ")) expect(line).toEndWith("|| true");
    }
  });
});

describe("parseAuditOutput", () => {
  test("splits sections by delimiter", () => {
    const out = [
      "<<<SAMOHOST_AUDIT:alpha>>>",
      "a",
      "<<<SAMOHOST_AUDIT:beta>>>",
      "active",
      "",
    ].join("\n");
    const m = parseAuditOutput(out, CHECKS);
    expect(m.get("alpha")).toBe("a");
    expect(m.get("beta")).toBe("active");
  });

  test("discards noise before the first delimiter (MOTD, warnings)", () => {
    const out = [
      "Warning: Permanently added ...",
      "<<<SAMOHOST_AUDIT:alpha>>>",
      "a",
    ].join("\n");
    const m = parseAuditOutput(out, CHECKS);
    expect(m.get("alpha")).toBe("a");
    expect(m.has("beta")).toBe(false);
  });

  test("missing section is absent (not empty string for the wrong check)", () => {
    const out = ["<<<SAMOHOST_AUDIT:beta>>>", "inactive"].join("\n");
    const m = parseAuditOutput(out, CHECKS);
    expect(m.has("alpha")).toBe(false);
    expect(m.get("beta")).toBe("inactive");
  });

  test("unknown delimiter ids are treated as body text, not section breaks", () => {
    const out = [
      "<<<SAMOHOST_AUDIT:alpha>>>",
      "<<<SAMOHOST_AUDIT:not-a-check>>>",
      "tail",
    ].join("\n");
    const m = parseAuditOutput(out, CHECKS);
    expect(m.get("alpha")).toBe("<<<SAMOHOST_AUDIT:not-a-check>>>\ntail");
  });

  test("multi-line section bodies are preserved", () => {
    const out = [
      "<<<SAMOHOST_AUDIT:alpha>>>",
      "line1",
      "line2",
      "<<<SAMOHOST_AUDIT:beta>>>",
      "active",
    ].join("\n");
    const m = parseAuditOutput(out, CHECKS);
    expect(m.get("alpha")).toBe("line1\nline2");
  });
});
