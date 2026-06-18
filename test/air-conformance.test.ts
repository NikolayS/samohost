/**
 * test/air-conformance.test.ts — the air conformance GATE (NikolayS/samohost#64).
 *
 * This is the prevention the audit asked for: a golden that enumerates air's
 * hardening directives and FAILS CI if samohost's cloud-init baseline is missing
 * one without an explicit, documented waiver. It turns the air comparison from a
 * stale prose doc into an enforced contract.
 *
 * What it guards (see src/cloudinit/air-conformance.ts AIR_DIRECTIVES):
 *   1. Every CONFORMS directive's required substring(s) appear in the rendered
 *      cloud-init baseline. Remove a directive from hardening.ts → this fails.
 *   2. Every DIVERGES/WAIVED directive carries a written reason (no silent drop).
 *   3. Every CONFORMS sshd/ufw directive has a matching `doctor` probe
 *      (closes the #64 "doctor checks a subset" coverage gap).
 *   4. docs/air-conformance.md equals the generated output (doc can't drift).
 *   5. The guard actually bites: a synthetic baseline with a directive removed
 *      is detected as missing (proves the test isn't vacuously passing).
 *
 * E2E note: this is a pure render/data-contract test (no browser, no host); a
 * Playwright spec is N/A. The cloud-init renderer is exercised end-to-end here
 * via renderBaselineForConformance() (real builder + real hardeningModule).
 */

import { describe, expect, test } from "bun:test";
import {
  AIR_DIRECTIVES,
  missingSubstrings,
  renderBaselineForConformance,
  renderConformanceDoc,
  requiredSubstrings,
} from "../src/cloudinit/air-conformance.ts";
import { buildDoctorChecks } from "../src/doctor/checks.ts";

const DOC_PATH = new URL("../docs/air-conformance.md", import.meta.url).pathname;

describe("air conformance gate (#64)", () => {
  const rendered = renderBaselineForConformance();

  // -------------------------------------------------------------------------
  // 1. Every CONFORMS directive is actually present in the rendered baseline.
  //    This is the core gate: a missing sshd/ufw directive fails CI here.
  // -------------------------------------------------------------------------
  describe("every CONFORMS air directive is present in the cloud-init baseline", () => {
    for (const d of AIR_DIRECTIVES.filter((x) => x.status === "CONFORMS")) {
      test(`${d.id}: ${d.description}`, () => {
        const missing = missingSubstrings(d, rendered);
        expect(
          missing,
          `air directive '${d.id}' missing from cloud-init baseline: ${missing.join(", ")} ` +
            `(source: ${d.airSource}). Add it to src/cloudinit/hardening.ts or mark the ` +
            `directive DIVERGES/WAIVED with a reason in src/cloudinit/air-conformance.ts.`,
        ).toEqual([]);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2. No air row is silently dropped — DIVERGES/WAIVED need a written reason.
  // -------------------------------------------------------------------------
  test("every DIVERGES/WAIVED directive carries a non-empty reason", () => {
    for (const d of AIR_DIRECTIVES) {
      if (d.status === "DIVERGES" || d.status === "WAIVED") {
        expect(
          (d.reason ?? "").trim().length,
          `air directive '${d.id}' is ${d.status} but has no reason`,
        ).toBeGreaterThan(20);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 3. Doctor probes the same matrix: every CONFORMS sshd/ufw directive that
  //    declares a doctorCheckId must have that probe in buildDoctorChecks().
  //    (Closes #64's "doctor checks a subset" gap — doctor enforces what the
  //    baseline sets.)
  // -------------------------------------------------------------------------
  test("every CONFORMS directive with a doctorCheckId has a matching doctor probe", () => {
    const checks = buildDoctorChecks(2223, undefined);
    const ids = new Set(checks.map((c) => c.id));
    for (const d of AIR_DIRECTIVES) {
      if (d.status === "CONFORMS" && d.doctorCheckId) {
        expect(
          ids.has(d.doctorCheckId),
          `air directive '${d.id}' expects doctor probe '${d.doctorCheckId}', ` +
            `but buildDoctorChecks() does not emit it.`,
        ).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 4. Every sshd directive named in #64 as MISSING is now CONFORMS — pins the
  //    specific closures so a future regression that flips one back to a non-
  //    CONFORMS status is loud, not silent.
  // -------------------------------------------------------------------------
  test("the #64 MISSING sshd/ufw directives are all CONFORMS now", () => {
    const mustConform = [
      "max-auth-tries",
      "client-alive",
      "allow-agent-forwarding",
      "permit-user-environment",
      "permit-empty-passwords",
      "remove-root-authorized-keys",
      "ufw-limit-ssh",
    ];
    const byId = Object.fromEntries(AIR_DIRECTIVES.map((d) => [d.id, d.status]));
    for (const id of mustConform) {
      expect(byId[id], `directive '${id}' (a #64 gap) must be CONFORMS`).toBe(
        "CONFORMS",
      );
    }
  });

  // -------------------------------------------------------------------------
  // 5. The committed doc equals the generated doc (no stale-doc drift — the very
  //    failure mode #64 was opened to prevent).
  // -------------------------------------------------------------------------
  test("docs/air-conformance.md matches the generated output", async () => {
    const committed = await Bun.file(DOC_PATH).text();
    expect(committed).toBe(renderConformanceDoc());
  });

  // -------------------------------------------------------------------------
  // 6. The guard actually bites: prove that removing a directive is detected.
  //    Strip a CONFORMS directive's text from a copy of the baseline and confirm
  //    missingSubstrings() reports it. If this ever passes vacuously, the whole
  //    gate is worthless — so we test the test.
  // -------------------------------------------------------------------------
  test("guard fails when a directive is removed from the rendered baseline", () => {
    const target = AIR_DIRECTIVES.find(
      (d) => d.id === "max-auth-tries" && d.status === "CONFORMS",
    );
    expect(target).toBeDefined();

    // Sanity: present in the real baseline.
    expect(missingSubstrings(target!, rendered)).toEqual([]);

    // Now simulate a baseline that dropped the directive.
    let tampered = rendered;
    for (const s of requiredSubstrings(target!)) {
      tampered = tampered.split(s).join("");
    }
    const missing = missingSubstrings(target!, tampered);
    expect(missing.length).toBeGreaterThan(0);
  });
});
