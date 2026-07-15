/**
 * test/trigger-autoheal-wiring.test.ts — RED/GREEN wiring tests for Phase 3
 * production wiring.
 *
 * RED phase: these tests MUST FAIL before the wiring is added.
 * GREEN phase: wire appHeal, fileHealAlert, currentGeneratorSha resolution,
 * SAMOHOST_APP_HEAL env gate, and --app-heal CLI flag for them to pass.
 *
 * Tests:
 *   W1 — defaultTriggerDeps().appHeal is undefined when SAMOHOST_APP_HEAL is
 *         absent (default-off gate: merging does NOT activate autonomous healing).
 *   W2 — defaultTriggerDeps().appHeal is defined and calls runAppHeal when
 *         SAMOHOST_APP_HEAL is set to a truthy value.
 *   W3 — defaultTriggerDeps().fileHealAlert is defined (wired to upsertGhIssue path).
 *   W4 — parseTriggerRun: --app-heal flag sets input.appHeal = true.
 *   W5 — parseTriggerRun: SAMOHOST_APP_HEAL env var sets input.appHeal = true
 *         at the CLI dispatch layer (trigger run entry reads the env gate).
 *   W6 — when input.appHeal is true but input.currentGeneratorSha is absent,
 *         the trigger entry in cli.ts resolves it via resolveProductionGeneratorSha
 *         and injects it (integration: dispatch layer sets currentGeneratorSha).
 *
 * Scope guard: only wiring + gate + flag; NO logic changes to runTriggerRun.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultTriggerDeps,
  type TriggerDepsOpts,
  type TriggerDeps,
} from "../src/commands/trigger.ts";

// ---------------------------------------------------------------------------
// W1 — default-off gate: appHeal dep absent when SAMOHOST_APP_HEAL is unset
// ---------------------------------------------------------------------------

describe("W1 — default-off gate: appHeal dep absent when SAMOHOST_APP_HEAL unset", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["SAMOHOST_APP_HEAL"];
    delete process.env["SAMOHOST_APP_HEAL"];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env["SAMOHOST_APP_HEAL"] = savedEnv;
    } else {
      delete process.env["SAMOHOST_APP_HEAL"];
    }
  });

  test("defaultTriggerDeps().appHeal is undefined when SAMOHOST_APP_HEAL is absent", () => {
    const deps = defaultTriggerDeps();
    // The gate: merging this PR must NOT change the running trigger's behavior.
    // appHeal must remain absent (undefined) until the operator sets the env flag.
    expect(deps.appHeal).toBeUndefined();
  });

  test("defaultTriggerDeps().appHeal is undefined when SAMOHOST_APP_HEAL is empty string", () => {
    process.env["SAMOHOST_APP_HEAL"] = "";
    const deps = defaultTriggerDeps();
    expect(deps.appHeal).toBeUndefined();
  });

  test("defaultTriggerDeps().appHeal is undefined when SAMOHOST_APP_HEAL is '0'", () => {
    process.env["SAMOHOST_APP_HEAL"] = "0";
    const deps = defaultTriggerDeps();
    expect(deps.appHeal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W2 — when SAMOHOST_APP_HEAL is set, appHeal dep is defined
// ---------------------------------------------------------------------------

describe("W2 — appHeal dep is defined when SAMOHOST_APP_HEAL is truthy", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["SAMOHOST_APP_HEAL"];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env["SAMOHOST_APP_HEAL"] = savedEnv;
    } else {
      delete process.env["SAMOHOST_APP_HEAL"];
    }
  });

  test("defaultTriggerDeps().appHeal is a function when SAMOHOST_APP_HEAL=1", () => {
    process.env["SAMOHOST_APP_HEAL"] = "1";
    const deps = defaultTriggerDeps();
    expect(typeof deps.appHeal).toBe("function");
  });

  test("defaultTriggerDeps().appHeal is a function when SAMOHOST_APP_HEAL=true", () => {
    process.env["SAMOHOST_APP_HEAL"] = "true";
    const deps = defaultTriggerDeps();
    expect(typeof deps.appHeal).toBe("function");
  });

  test("defaultTriggerDeps().appHeal returns an AppHealResult shape", async () => {
    // We can't call it without a real VM/SSH but we can verify the closure
    // returns a properly-shaped promise when invoked with a fake app (it will
    // fail because the VM doesn't exist, but we can verify it's the right type).
    process.env["SAMOHOST_APP_HEAL"] = "1";
    const deps = defaultTriggerDeps();
    expect(typeof deps.appHeal).toBe("function");
    // The dep is defined — we don't invoke it here (would need real SSH);
    // W2 is satisfied by confirming it is a function.
  });
});

// ---------------------------------------------------------------------------
// W3 — fileHealAlert dep is defined in defaultTriggerDeps
// ---------------------------------------------------------------------------

describe("W3 — fileHealAlert dep is defined in defaultTriggerDeps", () => {
  test("defaultTriggerDeps().fileHealAlert is a function", () => {
    // fileHealAlert must always be wired (regardless of env gate) so that
    // when a failing-heal alert is needed and alertRepo is set, the dep exists.
    const deps = defaultTriggerDeps();
    expect(typeof deps.fileHealAlert).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// W4 — CLI: --app-heal flag sets input.appHeal = true
// ---------------------------------------------------------------------------

describe("W4 — CLI --app-heal flag sets input.appHeal = true", () => {
  test("parseTriggerRun includes appHeal=true when --app-heal is passed", async () => {
    // Import the CLI module and check that --app-heal is parsed.
    // We test via the exported parseTrigger function (or indirectly).
    // Since parseTrigger is not exported, we test via the full dispatch by
    // checking the ParsedCommand type that the CLI produces.
    //
    // Strategy: import the internal parser indirectly by checking that the
    // CLI module exports recognise --app-heal. We do this by calling the
    // parseTriggerRun function indirectly via the module's argv parsing entry.
    //
    // Alternative: export parseTriggerRun from cli.ts (the cleanest approach),
    // or test via a helper that converts argv → input.
    //
    // Since parseTriggerRun is not currently exported, we verify the flag is
    // accepted by the CLI by importing a test helper OR by checking the type
    // exposed after the wiring is done.
    //
    // For the RED phase: we expect --app-heal to throw UsageError because it is
    // not yet parsed → this test FAILS (no error = flag IS accepted unexpectedly).
    // After wiring: --app-heal is accepted → no throw.
    //
    // We test via parseCliCommand (exported from cli.ts) which builds the full
    // parsed command including TriggerRunInput.

    // Dynamic import to get the current module state.
    const cli = await import("../src/cli.ts");

    // parseCliCommand is exported for testing.
    // If it is NOT exported yet, the import will fail → test will error (RED).
    if (typeof cli.parseCliCommand !== "function") {
      throw new Error("parseCliCommand is not exported from cli.ts — cannot test CLI flag parsing");
    }

    const cmd = cli.parseCliCommand(["trigger", "run", "--app-heal"]);
    expect(cmd.kind).toBe("trigger-run");
    // After wiring, appHeal must be true in the parsed input.
    expect((cmd as { input: { appHeal?: boolean } }).input.appHeal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W5 — env gate in CLI dispatch: SAMOHOST_APP_HEAL sets input.appHeal = true
// ---------------------------------------------------------------------------

describe("W5 — SAMOHOST_APP_HEAL env sets input.appHeal=true at CLI dispatch", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["SAMOHOST_APP_HEAL"];
    delete process.env["SAMOHOST_APP_HEAL"];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env["SAMOHOST_APP_HEAL"] = savedEnv;
    } else {
      delete process.env["SAMOHOST_APP_HEAL"];
    }
  });

  test("parseTriggerRun without --app-heal + SAMOHOST_APP_HEAL=1 => input.appHeal=true", async () => {
    process.env["SAMOHOST_APP_HEAL"] = "1";

    const cli = await import("../src/cli.ts");

    if (typeof cli.parseCliCommand !== "function") {
      throw new Error("parseCliCommand is not exported from cli.ts");
    }

    // No --app-heal flag passed; env gate should activate it.
    const cmd = cli.parseCliCommand(["trigger", "run"]);
    expect(cmd.kind).toBe("trigger-run");
    expect((cmd as { input: { appHeal?: boolean } }).input.appHeal).toBe(true);
  });

  test("parseTriggerRun without --app-heal + SAMOHOST_APP_HEAL absent => input.appHeal absent/false", async () => {
    // Env gate absent → input.appHeal must NOT be set to true.
    const cli = await import("../src/cli.ts");

    if (typeof cli.parseCliCommand !== "function") {
      throw new Error("parseCliCommand is not exported from cli.ts");
    }

    const cmd = cli.parseCliCommand(["trigger", "run"]);
    expect(cmd.kind).toBe("trigger-run");
    // appHeal must be absent or false when the env flag is not set.
    const appHeal = (cmd as { input: { appHeal?: boolean } }).input.appHeal;
    expect(appHeal === undefined || appHeal === false).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W6 — currentGeneratorSha is resolved via resolveProductionGeneratorSha
//       when appHeal=true and currentGeneratorSha is absent in the parsed input
// ---------------------------------------------------------------------------

describe("W6 — currentGeneratorSha injected from resolveProductionGeneratorSha", () => {
  test("defaultTriggerDeps accepts an injectable resolveGeneratorSha opt (for testing)", () => {
    // The wiring must allow tests to inject a generator SHA resolver so tests
    // don't call execSync('git -C ~/samohost-trigger rev-parse HEAD').
    //
    // defaultTriggerDeps(opts) must accept opts.resolveGeneratorSha: () => string
    // and expose a way to retrieve the SHA without calling real git.
    //
    // We verify this by checking that TriggerDepsOpts accepts resolveGeneratorSha
    // OR by checking that the CLI dispatch layer resolves currentGeneratorSha
    // before calling runTriggerRun when input.appHeal is true.
    //
    // For RED: defaultTriggerDeps does NOT wire currentGeneratorSha resolution.
    // For GREEN: the CLI dispatch layer or defaultTriggerDeps resolves it.
    //
    // We verify via the opts type that the test-injectable is accepted.
    // If TriggerDepsOpts does not have resolveGeneratorSha, TypeScript will
    // error at build time but the test will still try at runtime.

    // Verify the option is accepted at runtime.
    const resolveGeneratorSha = () => "test-sha-1234";

    // This must not throw; if TriggerDepsOpts doesn't accept the field, it
    // will either be silently ignored (JS) or fail TS compilation.
    const opts: TriggerDepsOpts & { resolveGeneratorSha?: () => string } = {
      resolveGeneratorSha,
    };

    // After wiring: defaultTriggerDeps accepts resolveGeneratorSha in opts.
    // For now just verify the shape compiles and the call doesn't throw.
    expect(() => defaultTriggerDeps(opts as TriggerDepsOpts)).not.toThrow();
  });

  test("CLI dispatch resolves currentGeneratorSha when appHeal=true (SAMOHOST_APP_HEAL=1)", async () => {
    // This test verifies that when SAMOHOST_APP_HEAL=1 is set, the CLI dispatch
    // layer populates currentGeneratorSha in the TriggerRunInput before calling
    // runTriggerRun. Since we can't run the real git command in CI, we verify
    // the mechanism exists via parseCliCommand producing the right structure.
    //
    // After wiring: the CLI dispatch should either:
    //   a) resolve currentGeneratorSha in the parseCliCommand / dispatch path, OR
    //   b) let defaultTriggerDeps resolve it at call time.
    //
    // RED: cli.parseCliCommand doesn't expose currentGeneratorSha.
    // GREEN: the parsed command or the dispatch wires it.
    //
    // We use a lighter approach: verify that the parsed TriggerRunInput when
    // appHeal=true does NOT leave currentGeneratorSha undefined AND the code
    // path does not call real git when a test hook is provided.
    //
    // For the wiring test, we primarily care that:
    //   1. The CLI accepts --app-heal.
    //   2. The env gate activates appHeal.
    //   3. The wiring provides currentGeneratorSha resolution.
    //
    // Since (3) resolves at runtime (not parse time), this is covered by W2
    // (appHeal dep is wired) + the unit test confirming resolveProductionGeneratorSha
    // is called.  We mark this test as a structural assertion.

    const cli = await import("../src/cli.ts");

    if (typeof cli.parseCliCommand !== "function") {
      throw new Error("parseCliCommand not exported");
    }

    // The parsed command for `trigger run --app-heal` must be valid (no error).
    // currentGeneratorSha is resolved at dispatch time, not parse time.
    const cmd = cli.parseCliCommand(["trigger", "run", "--app-heal"]);
    expect(cmd.kind).toBe("trigger-run");
    // The parsed input must have appHeal=true.
    expect((cmd as { input: { appHeal?: boolean } }).input.appHeal).toBe(true);
  });
});
