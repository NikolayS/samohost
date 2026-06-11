import { describe, expect, test } from "bun:test";
import { branchLabel, envName, fnv1a } from "../src/env/name.ts";

describe("branchLabel", () => {
  test("simple branch passes through", () => {
    expect(branchLabel("main")).toBe("main");
  });

  test("slashes, underscores, dots, case collapse to single dashes", () => {
    expect(branchLabel("feat/Add_Login.v2")).toBe("feat-add-login-v2");
  });

  test("runs of symbols collapse; leading/trailing dashes trimmed", () => {
    expect(branchLabel("--weird//branch__")).toBe("weird-branch");
  });

  test("symbol-only branch sanitizes to empty", () => {
    expect(branchLabel("///")).toBe("");
  });
});

describe("envName", () => {
  test("issue #117 pattern: <app>-<branch-label>", () => {
    expect(envName("field-record-1", "feat/x")).toBe("field-record-1-feat-x");
  });

  test("deterministic: same inputs, same name", () => {
    expect(envName("app", "feat/x")).toBe(envName("app", "feat/x"));
  });

  test("symbol-only branch falls back to app + hash", () => {
    const n = envName("app", "///");
    expect(n).toMatch(/^app-[0-9a-f]{6}$/);
  });

  test("overflow truncates and appends the branch hash, ≤63 chars", () => {
    const long = "feature/" + "x".repeat(80);
    const n = envName("field-record-1", long);
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toMatch(/-[0-9a-f]{6}$/);
    expect(n.startsWith("field-record-1-")).toBe(true);
  });

  test("collision with a DIFFERENT branch gets a hash suffix", () => {
    const existing = new Map([["app-feat-x", "feat/x"]]);
    // feat_x sanitizes to the same label as feat/x but is another branch.
    const n = envName("app", "feat_x", existing);
    expect(n).not.toBe("app-feat-x");
    expect(n).toMatch(/^app-feat-x-[0-9a-f]{6}$/);
  });

  test("re-deriving for the SAME branch keeps the plain name (no suffix)", () => {
    const existing = new Map([["app-feat-x", "feat/x"]]);
    expect(envName("app", "feat/x", existing)).toBe("app-feat-x");
  });

  test("name is a valid DNS label: [a-z0-9-], no edge dashes", () => {
    for (const b of ["Feat/UPPER", "a..b", "-x-", "ünïcode/ß"]) {
      const n = envName("app", b);
      expect(n).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(n.length).toBeLessThanOrEqual(63);
    }
  });
});

describe("fnv1a", () => {
  test("stable and distinct for the collision pair", () => {
    expect(fnv1a("feat/x")).toBe(fnv1a("feat/x"));
    expect(fnv1a("feat/x")).not.toBe(fnv1a("feat_x"));
    expect(fnv1a("feat/x")).toMatch(/^[0-9a-f]{6}$/);
  });
});
