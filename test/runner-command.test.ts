import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/cli.ts";
import {
  runRunnerHostPrep,
  type RunnerHostPrepInput,
} from "../src/commands/runner.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() {
      return out;
    },
    get e() {
      return err;
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs runner", () => {
  test("host-prep takes <vm> and parses to the runner-host-prep kind", () => {
    const cmd = parseArgs(["runner", "host-prep", "samo-we-field-record"]);
    if (cmd.kind !== "runner-host-prep") throw new Error("expected runner-host-prep");
    expect(cmd.input.vm).toBe("samo-we-field-record");
    expect(cmd.input.ciPorts).toEqual([3100]); // default
  });

  test("--ci-port is repeatable and overrides the default set", () => {
    const cmd = parseArgs([
      "runner", "host-prep", "vm", "--ci-port", "3100", "--ci-port", "4000",
    ]);
    if (cmd.kind !== "runner-host-prep") throw new Error("expected runner-host-prep");
    expect(cmd.input.ciPorts).toEqual([3100, 4000]);
  });

  test("--runner-home overrides the default runner home", () => {
    const cmd = parseArgs([
      "runner", "host-prep", "vm", "--runner-home", "/srv/runner",
    ]);
    if (cmd.kind !== "runner-host-prep") throw new Error("expected runner-host-prep");
    expect(cmd.input.runnerHome).toBe("/srv/runner");
  });

  test("non-integer --ci-port throws UsageError", () => {
    expect(() =>
      parseArgs(["runner", "host-prep", "vm", "--ci-port", "abc"]),
    ).toThrow(/integer/);
  });

  test("unknown runner subcommand throws UsageError", () => {
    expect(() => parseArgs(["runner", "wat"])).toThrow(UsageError);
    expect(() => parseArgs(["runner", "wat"])).toThrow(/unknown runner subcommand/);
  });

  test("bare runner (no subcommand) throws UsageError", () => {
    expect(() => parseArgs(["runner"])).toThrow(/requires a subcommand/);
  });

  test("host-prep without a <vm> throws UsageError", () => {
    expect(() => parseArgs(["runner", "host-prep"])).toThrow(/requires <vm>/);
  });
});

// ---------------------------------------------------------------------------
// Command (offline, temp store, render-only)
// ---------------------------------------------------------------------------

describe("runRunnerHostPrep", () => {
  let dir: string;
  let vmStore: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-runner-"));
    vmStore = new StateStore(join(dir, "state.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function input(o: Partial<RunnerHostPrepInput> = {}): RunnerHostPrepInput {
    return {
      vm: "samo-we-field-record",
      ciPorts: [3100],
      ...o,
    };
  }

  test("prints the host-prep script and writes NO state", () => {
    const before = JSON.stringify(vmStore.list());
    const c = capture();
    const code = runRunnerHostPrep(input(), { json: false }, vmStore, c.out, c.err);
    expect(code).toBe(0);
    expect(c.o).toContain("ACTIONS_RUNNER_HOOK_JOB_STARTED");
    expect(c.o).toContain("install -m 0755");
    expect(c.o).toContain("3100");
    // Render-only: state is untouched.
    expect(JSON.stringify(vmStore.list())).toBe(before);
  });

  test("--ci-port override flows into the rendered cleanup hook", () => {
    const c = capture();
    const code = runRunnerHostPrep(
      input({ ciPorts: [3100, 4000] }),
      { json: false },
      vmStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("3100");
    expect(c.o).toContain("4000");
  });

  test("resolves the runner home override into the .env path", () => {
    const c = capture();
    runRunnerHostPrep(
      input({ runnerHome: "/srv/runner" }),
      { json: false },
      vmStore,
      c.out,
      c.err,
    );
    expect(c.o).toContain("/srv/runner/.env");
  });

  test("unknown vm fails cleanly (exit 1)", () => {
    const c = capture();
    const code = runRunnerHostPrep(
      input({ vm: "nope" }),
      { json: false },
      vmStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found");
  });
});
