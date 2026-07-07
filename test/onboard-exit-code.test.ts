/**
 * Exit-code honesty tests for `samohost onboard`.
 *
 * Kept in a separate file so a module-level import failure for the
 * `computeOnboardExitCode` export (which does not exist in the RED commit)
 * does not suppress the other onboard test failures.
 *
 * RED: computeOnboardExitCode is not yet exported from cli.ts → import error.
 * GREEN: function added + cli.ts onboard case wired to use it.
 */

import { describe, expect, test } from "bun:test";
import { computeOnboardExitCode } from "../src/cli.ts";

describe("exit-code honesty: computeOnboardExitCode", () => {
  test("returns 1 when appRegistered=false (status=created)", () => {
    // cli.ts currently uses `report.status === "error" ? 1 : 0` which silently
    // exits 0 when status="created" but appRegistered=false or triggerCovered=false.
    // This pins the correct contract: any partial success must be exit 1.
    expect(
      computeOnboardExitCode({
        status: "created",
        appRegistered: false,
        triggerCovered: false,
        scaffoldedFiles: [],
      }),
    ).toBe(1);
  });

  test("returns 1 when triggerCovered=false (status=updated)", () => {
    expect(
      computeOnboardExitCode({
        status: "updated",
        prUrl: "https://github.com/org/app/pull/1",
        appRegistered: true,
        triggerCovered: false,
        scaffoldedFiles: [],
      }),
    ).toBe(1);
  });

  test("returns 1 when status=error", () => {
    expect(
      computeOnboardExitCode({
        status: "error",
        appRegistered: false,
        triggerCovered: false,
        scaffoldedFiles: [],
      }),
    ).toBe(1);
  });

  test("returns 0 when fully successful (status=created, appRegistered=true, triggerCovered=true)", () => {
    expect(
      computeOnboardExitCode({
        status: "created",
        prUrl: "https://github.com/org/app/pull/1",
        appRegistered: true,
        triggerCovered: true,
        scaffoldedFiles: [],
      }),
    ).toBe(0);
  });
});
