/**
 * Tests for `runEnvGc` + CLI parsing of `env gc`.
 * RED phase: written before implementation.
 *
 * Safety assertions (brief §TDD):
 *   - dry-run zero-effect: no envStore writes AND no deps.remote calls
 *   - degraded/transitional VM → KEEP unconditionally
 *   - orphan-vm prune does NOT SSH
 *   - SSH timeout/throw → failed+KEEP, no crash
 *   - one failure does not abort gc (second candidate still processed)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runEnvGc,
  type EnvExecDeps,
  type EnvGcInput,
} from "../src/commands/env.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "123",
    name: "samo-we-field-record",
    ip: "1.2.3.4",
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

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1111",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

function makeEnv(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-abc",
    vmId: "vm-1111",
    appName: "field-record-1",
    branch: "feat/gone",
    name: "field-record-1-feat-gone",
    port: 3100,
    vhost: "field-record-1-feat-gone.samo.cat",
    dbBackend: "dblab",
    dbName: "field-record-1-feat-gone",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

const DESTROY_OK = ["unit-stop", "vhost-remove", "db-drop", "dir-remove"]
  .flatMap((p) => [
    `<<<SAMOHOST_PHASE:${p}:start>>>`,
    `<<<SAMOHOST_PHASE:${p}:ok>>>`,
  ])
  .join("\n");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-gc-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// CLI parsing: `env gc`
// ---------------------------------------------------------------------------

describe("parseArgs env gc", () => {
  test("env gc <vm> parses; dry-run is default (reap=false)", () => {
    const cmd = parseArgs(["env", "gc", "samo-we-field-record"]);
    if (cmd.kind !== "env-gc") throw new Error(`expected env-gc, got ${cmd.kind}`);
    expect(cmd.input.vm).toBe("samo-we-field-record");
    expect(cmd.input.reap).toBe(false);
    expect(cmd.input.app).toBeUndefined();
    expect(cmd.input.ttl).toBeUndefined();
    expect(cmd.json).toBe(false);
  });

  test("--reap sets reap=true", () => {
    const cmd = parseArgs(["env", "gc", "my-vm", "--reap"]);
    if (cmd.kind !== "env-gc") throw new Error(`expected env-gc, got ${cmd.kind}`);
    expect(cmd.input.reap).toBe(true);
  });

  test("--ttl 7d parsed and stored in ms", () => {
    const cmd = parseArgs(["env", "gc", "my-vm", "--ttl", "7d"]);
    if (cmd.kind !== "env-gc") throw new Error(`expected env-gc, got ${cmd.kind}`);
    expect(cmd.input.ttl).toBe(7 * 24 * 3600 * 1000);
  });

  test("--app <name> parsed", () => {
    const cmd = parseArgs(["env", "gc", "my-vm", "--app", "my-app"]);
    if (cmd.kind !== "env-gc") throw new Error(`expected env-gc, got ${cmd.kind}`);
    expect(cmd.input.app).toBe("my-app");
  });

  test("--json parsed", () => {
    const cmd = parseArgs(["env", "gc", "my-vm", "--json"]);
    if (cmd.kind !== "env-gc") throw new Error(`expected env-gc, got ${cmd.kind}`);
    expect(cmd.json).toBe(true);
  });

  test("missing vm throws", () => {
    expect(() => parseArgs(["env", "gc"])).toThrow(/requires.*<vm>/);
  });

  test("unknown flag throws", () => {
    expect(() => parseArgs(["env", "gc", "vm", "--bogus"])).toThrow(/unknown flag/);
  });

  test("invalid --ttl throws", () => {
    expect(() => parseArgs(["env", "gc", "vm", "--ttl", "0d"])).toThrow(/invalid.*--ttl/i);
  });

  test("parseEnv error message includes 'gc'", () => {
    // The error from `env bogus` must list gc among the subcommands
    try {
      parseArgs(["env", "bogus"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(String(e)).toMatch(/gc/);
    }
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — dry-run zero-effect
// ---------------------------------------------------------------------------

describe("runEnvGc — dry-run (default)", () => {
  test("dry-run with branch-gone candidate: NO envStore writes, NO remote calls", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/gone" }));

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: (_vm, _script) => { remoteCalls++; return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }); },
      now: () => new Date("2026-06-18T12:00:00.000Z"),
      uuid: () => "uuid-1",
      branchState: async (_repo, _branch) => "gone",
    };

    const c = capture();
    const input: EnvGcInput = {
      vm: "samo-we-field-record",
      reap: false, // dry-run
    };
    await runEnvGc(input, { json: false }, vmStore, appStore, envStore, deps, c.out, c.err);

    // Zero remote calls
    expect(remoteCalls).toBe(0);
    // Record untouched
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeDefined();
  });

  test("dry-run lists candidate with reason branch-gone and action destroy", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/gone" }));

    const deps: EnvExecDeps = {
      remote: (_vm, _script) => Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }),
      now: () => new Date("2026-06-18T12:00:00.000Z"),
      uuid: () => "uuid-1",
      branchState: async () => "gone",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: false },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(c.o).toMatch(/branch-gone/);
    expect(c.o).toMatch(/destroy/);
    expect(c.o).toMatch(/candidates=1/);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — orphan-vm: dead VM → prune record only, NO SSH
// ---------------------------------------------------------------------------

describe("runEnvGc — orphan-vm (dead VM)", () => {
  test("env on a missing VM: dry-run lists orphan-vm + prune-record", async () => {
    // VM NOT in vmStore → orphan
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ vmId: "vm-dead-99" }));

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    await runEnvGc(
      { vm: "vm-dead-99", reap: false },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(c.o).toMatch(/orphan-vm/);
    expect(c.o).toMatch(/prune-record/);
  });

  test("env on destroyed VM with --reap: envStore.remove called, NO remote SSH", async () => {
    vmStore.upsert(makeVm({ lifecycleState: "destroyed" }));
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv());

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeUndefined();
    expect(c.o).toMatch(/pruned record/);
    expect(c.o).toMatch(/orphan-vm/);
  });

  test("env on failed VM with --reap: state-only prune, no SSH", async () => {
    vmStore.upsert(makeVm({ lifecycleState: "failed" }));
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv());

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — transitional/degraded VM → KEEP unconditionally
// ---------------------------------------------------------------------------

describe("runEnvGc — transitional VM → KEEP", () => {
  for (const state of ["degraded", "creating", "booting", "planned"] as const) {
    test(`lifecycleState=${state} with --reap: neither remote nor envStore.remove called`, async () => {
      vmStore.upsert(makeVm({ lifecycleState: state }));
      appStore.upsert(makeApp());
      envStore.upsert(makeEnv({ branch: "feat/gone" }));

      let remoteCalls = 0;
      const deps: EnvExecDeps = {
        remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }); },
        now: () => new Date(),
        uuid: () => "u",
        branchState: async () => "gone",
      };

      const c = capture();
      await runEnvGc(
        { vm: "samo-we-field-record", reap: true },
        { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
      );

      expect(remoteCalls).toBe(0);
      expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeDefined();
      expect(c.o).toMatch(/kept/);
    });
  }
});

// ---------------------------------------------------------------------------
// runEnvGc — branch-open → KEEP
// ---------------------------------------------------------------------------

describe("runEnvGc — branch-open → KEEP", () => {
  test("open branch on live VM, no TTL: not a candidate", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/alive" }));

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "open",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/alive")).toBeDefined();
    expect(c.o).toMatch(/kept=1/);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — TTL
// ---------------------------------------------------------------------------

describe("runEnvGc — TTL", () => {
  test("TTL off by default: old env with open branch is KEPT", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({
      branch: "feat/old",
      createdAt: "2020-01-01T00:00:00.000Z",
    }));

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      now: () => new Date("2026-06-18T12:00:00.000Z"),
      uuid: () => "u",
      branchState: async () => "open",
    };

    await runEnvGc(
      { vm: "samo-we-field-record", reap: false },
      { json: false }, vmStore, appStore, envStore, deps, capture().out, capture().err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/old")).toBeDefined();
  });

  test("TTL on with 1d: env older than 1d with open branch → candidate ttl-expired", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    // created 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    envStore.upsert(makeEnv({
      branch: "feat/old",
      createdAt: twoDaysAgo,
    }));

    const deps: EnvExecDeps = {
      remote: () => Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }),
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "open",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: false, ttl: 24 * 3600 * 1000 },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(c.o).toMatch(/ttl-expired/);
    expect(c.o).toMatch(/candidates=1/);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — branch-gone + live VM → actual destroy with --reap
// ---------------------------------------------------------------------------

describe("runEnvGc — branch-gone on live VM + --reap", () => {
  test("calls remote with destroy script, removes record on ok outcome", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/gone" }));

    const scripts: string[] = [];
    const deps: EnvExecDeps = {
      remote: (_vm, script) => {
        scripts.push(script);
        return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" });
      },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    const code = await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(scripts.length).toBeGreaterThan(0);
    // Should contain the env-destroy script markers
    expect(scripts[0]).toContain("env-destroy script");
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeUndefined();
    expect(c.o).toMatch(/reaped/);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — SSH throw → failed+KEEP, no crash
// ---------------------------------------------------------------------------

describe("runEnvGc — SSH throw → failed+KEEP, no crash", () => {
  test("remote throws: env is failed+KEEP, gc continues, non-zero exit", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/gone" }));

    const deps: EnvExecDeps = {
      remote: () => { throw new Error("SSH connection refused"); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    const code = await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    // Record kept
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeDefined();
    // Exit non-zero because failed>0
    expect(code).toBe(1);
    // Summary shows failed=1
    expect(c.o).toMatch(/failed=1/);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — one failure does not abort (second candidate still processed)
// ---------------------------------------------------------------------------

describe("runEnvGc — one failure does not abort", () => {
  test("two candidates: first fails → failed, second succeeds → reaped; both in summary", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/first", id: "env-1", port: 3100, name: "field-record-1-feat-first", vhost: "field-record-1-feat-first.samo.cat" }));
    envStore.upsert(makeEnv({ branch: "feat/second", id: "env-2", port: 3101, name: "field-record-1-feat-second", vhost: "field-record-1-feat-second.samo.cat" }));

    let callCount = 0;
    const deps: EnvExecDeps = {
      remote: (_vm, _script) => {
        callCount++;
        if (callCount === 1) {
          // First destroy call fails
          return Promise.resolve({ code: 0, stdout: "<<<SAMOHOST_PHASE:unit-stop:start>>><<<SAMOHOST_PHASE:unit-stop:fail>>>", stderr: "" });
        }
        // Second succeeds
        return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" });
      },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    const code = await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(c.o).toMatch(/failed=1/);
    expect(c.o).toMatch(/reaped=1/);
    expect(code).toBe(1); // non-zero because failed>0
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — branchState throws → KEEP (fail-closed)
// ---------------------------------------------------------------------------

describe("runEnvGc — branchState throws → KEEP", () => {
  test("branchState throws for a live-VM env: KEPT, no crash", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/check-fail" }));

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => { throw new Error("git ls-remote exit 128"); },
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/check-fail")).toBeDefined();
    expect(c.o).toMatch(/kept/);
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — JSON output shape
// ---------------------------------------------------------------------------

describe("runEnvGc — JSON output", () => {
  test("--json emits expected shape with vm, dryRun, candidates, reaped, pruned, kept, failed", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());
    envStore.upsert(makeEnv({ branch: "feat/gone" }));

    const deps: EnvExecDeps = {
      remote: () => Promise.resolve({ code: 0, stdout: DESTROY_OK, stderr: "" }),
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const lines: string[] = [];
    await runEnvGc(
      { vm: "samo-we-field-record", reap: false },
      { json: true }, vmStore, appStore, envStore, deps,
      (s) => lines.push(s),
      () => {},
    );

    const json = JSON.parse(lines.join(""));
    expect(json).toHaveProperty("vm");
    expect(json).toHaveProperty("dryRun", true);
    expect(json).toHaveProperty("candidates");
    expect(Array.isArray(json.candidates)).toBe(true);
    expect(json).toHaveProperty("reaped");
    expect(json).toHaveProperty("pruned");
    expect(typeof json.kept).toBe("number");
    expect(json).toHaveProperty("failed");
  });
});

// ---------------------------------------------------------------------------
// runEnvGc — orphan-app: live VM but no AppRecord → prune record, no SSH
// ---------------------------------------------------------------------------

describe("runEnvGc — orphan-app", () => {
  test("live VM but AppRecord not found → prune-record, no SSH", async () => {
    vmStore.upsert(makeVm());
    // appStore has NO app for this env
    envStore.upsert(makeEnv());

    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: () => { remoteCalls++; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      now: () => new Date(),
      uuid: () => "u",
      branchState: async () => "gone",
    };

    const c = capture();
    await runEnvGc(
      { vm: "samo-we-field-record", reap: true },
      { json: false }, vmStore, appStore, envStore, deps, c.out, c.err,
    );

    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/gone")).toBeUndefined();
    expect(c.o).toMatch(/orphan-app/);
  });
});
