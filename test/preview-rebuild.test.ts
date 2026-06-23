/**
 * Tests for `samohost preview rebuild <vm> <app> <branch>` (MR-C).
 *
 * RED phase: these tests MUST FAIL before the implementation is written.
 *
 * What is pinned:
 *  - `parseArgs(["preview", "rebuild", vm, app, branch])` returns kind="preview-rebuild"
 *    with the correct vm/app/branch positionals and json=false by default.
 *  - `parseArgs([…, "--json"])` returns json=true.
 *  - Missing positionals throw UsageError with a helpful message.
 *  - `runPreviewRebuild` resolves the VmRecord + AppRecord from state stores and
 *    delegates to `runEnvCreate` (idempotent rebuild).
 *  - When the VM is not found, runPreviewRebuild exits 1 and writes to err.
 *  - When the app is not found on the VM, runPreviewRebuild exits 1 and writes to err.
 *  - Incremental status output: "rebuilding <env>" is emitted to out before the
 *    delegate call; --json wraps the EnvCreateReport in a rebuild envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/cli.ts";
import {
  runPreviewRebuild,
  type PreviewRebuildInput,
  type PreviewRebuildDeps,
} from "../src/commands/preview-rebuild.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
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

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111",
    vmId: "vm-1111",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    serviceUnit: "field-record",
    healthUrl: "http://localhost:3000/api/version",
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

// (No phase markers needed in this file — runEnvCreate is fully faked.)

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parseArgs preview rebuild", () => {
  test("preview rebuild <vm> <app> <branch> → kind=preview-rebuild with correct fields", () => {
    const cmd = parseArgs([
      "preview", "rebuild",
      "samo-we-field-record",
      "field-record",
      "feat/my-branch",
    ]);
    if (cmd.kind !== "preview-rebuild") {
      throw new Error(`expected preview-rebuild, got ${cmd.kind}`);
    }
    expect(cmd.input.vm).toBe("samo-we-field-record");
    expect(cmd.input.app).toBe("field-record");
    expect(cmd.input.branch).toBe("feat/my-branch");
    expect(cmd.json).toBe(false);
  });

  test("preview rebuild … --json → json=true", () => {
    const cmd = parseArgs([
      "preview", "rebuild",
      "my-vm", "my-app", "my-branch",
      "--json",
    ]);
    if (cmd.kind !== "preview-rebuild") {
      throw new Error(`expected preview-rebuild, got ${cmd.kind}`);
    }
    expect(cmd.json).toBe(true);
  });

  test("preview rebuild missing branch → UsageError", () => {
    expect(() =>
      parseArgs(["preview", "rebuild", "my-vm", "my-app"])
    ).toThrow(UsageError);
  });

  test("preview rebuild missing app → UsageError", () => {
    expect(() =>
      parseArgs(["preview", "rebuild", "my-vm"])
    ).toThrow(UsageError);
  });

  test("preview rebuild missing vm → UsageError", () => {
    expect(() =>
      parseArgs(["preview", "rebuild"])
    ).toThrow(UsageError);
  });

  test("preview rebuild unknown flag → UsageError", () => {
    expect(() =>
      parseArgs(["preview", "rebuild", "v", "a", "b", "--bogus"])
    ).toThrow(UsageError);
  });

  test("preview with no subcommand still works (backward compat: requires --provider)", () => {
    // The existing `preview` (cloud-init render) must NOT be broken.
    expect(() =>
      parseArgs(["preview", "--provider", "hetzner", "--region", "nbg1", "--type", "cx22", "--ssh-pubkey", "ssh-ed25519 key user@host"])
    ).not.toThrow();
    const cmd = parseArgs(["preview", "--provider", "hetzner", "--region", "nbg1", "--type", "cx22", "--ssh-pubkey", "ssh-ed25519 key user@host"]);
    expect(cmd.kind).toBe("preview");
  });
});

// ---------------------------------------------------------------------------
// runPreviewRebuild tests
// ---------------------------------------------------------------------------

describe("runPreviewRebuild", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;
  const vm = makeVm();
  const app = makeApp();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-rebuild-"));
    vmStore = new StateStore(join(dir, "vms.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    // Seed VM and app into state stores
    vmStore.upsert(vm);
    appStore.upsert(app);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // ---------------------------------------------------------------------------
  // Helper: build deps with a fake runEnvCreate that records its calls.
  // ---------------------------------------------------------------------------

  type EnvCreateCall = {
    vm: string;
    app: string;
    branch: string;
    json: boolean;
  };

  function makeFakeDeps(outcome: "ok" | "failed" = "ok"): {
    deps: PreviewRebuildDeps;
    calls: EnvCreateCall[];
  } {
    const calls: EnvCreateCall[] = [];
    const deps: PreviewRebuildDeps = {
      runEnvCreate: async (input, opts, _vmStore, _appStore, _envStore, _execDeps, out, _err) => {
        calls.push({ vm: input.vm, app: input.app, branch: input.branch, json: opts.json });
        const exitCode = outcome === "ok" ? 0 : 1;
        if (opts.json) {
          out(JSON.stringify({
            env: `${input.app}-feat-x`,
            vm: input.vm,
            app: input.app,
            branch: input.branch,
            port: 3100,
            vhost: `${input.app}-feat-x.samo.cat`,
            db: "dblab",
            outcome,
            exitCode,
          }, null, 2));
        } else {
          out(`env ${input.app}-feat-x (${input.branch}) on ${input.vm}: ${outcome}`);
        }
        return exitCode;
      },
      vmStore,
      appStore,
      envStore,
    };
    return { deps, calls };
  }

  // ---------------------------------------------------------------------------
  // Test 1: basic rebuild delegates to runEnvCreate with correct EnvCreateInput
  // ---------------------------------------------------------------------------
  test("rb-1 — rebuild resolves vm+app and calls runEnvCreate with correct EnvCreateInput", async () => {
    const { deps, calls } = makeFakeDeps();
    const input: PreviewRebuildInput = {
      vm: vm.name,
      app: app.name,
      branch: "feat/my-branch",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.vm).toBe(vm.name);
    expect(calls[0]!.app).toBe(app.name);
    expect(calls[0]!.branch).toBe("feat/my-branch");
    expect(calls[0]!.json).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 2: incremental status output — "rebuilding …" emitted before delegate
  // ---------------------------------------------------------------------------
  test("rb-2 — incremental status: 'rebuilding' emitted to out before delegate result", async () => {
    const outLines: string[] = [];
    const { deps } = makeFakeDeps();
    const input: PreviewRebuildInput = {
      vm: vm.name,
      app: app.name,
      branch: "feat/status",
    };
    const code = await runPreviewRebuild(
      input,
      { json: false },
      deps,
      (s) => outLines.push(s),
      (_s) => {},
    );

    expect(code).toBe(0);
    // The first line emitted must be a status line (before delegate output)
    expect(outLines.length).toBeGreaterThan(0);
    expect(outLines[0]).toMatch(/rebuild/i);
    expect(outLines[0]).toContain("feat/status");
  });

  // ---------------------------------------------------------------------------
  // Test 3: --json passes json=true down to runEnvCreate
  // ---------------------------------------------------------------------------
  test("rb-3 — --json propagated to runEnvCreate", async () => {
    const { deps, calls } = makeFakeDeps();
    const input: PreviewRebuildInput = {
      vm: vm.name,
      app: app.name,
      branch: "feat/json",
    };
    const c = capture();
    await runPreviewRebuild(input, { json: true }, deps, c.out, c.err);

    expect(calls[0]!.json).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 4: VM not found → exit 1, error message to err
  // ---------------------------------------------------------------------------
  test("rb-4 — VM not found in state → exit 1 + error to err", async () => {
    const { deps } = makeFakeDeps();
    const input: PreviewRebuildInput = {
      vm: "nonexistent-vm",
      app: app.name,
      branch: "feat/x",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(1);
    expect(c.e).toContain("nonexistent-vm");
  });

  // ---------------------------------------------------------------------------
  // Test 5: App not found on VM → exit 1, error message to err
  // ---------------------------------------------------------------------------
  test("rb-5 — app not found on VM → exit 1 + error to err", async () => {
    const { deps } = makeFakeDeps();
    const input: PreviewRebuildInput = {
      vm: vm.name,
      app: "nonexistent-app",
      branch: "feat/x",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(1);
    expect(c.e).toContain("nonexistent-app");
  });

  // ---------------------------------------------------------------------------
  // Test 6: delegate failure (runEnvCreate returns 1) propagates exit code
  // ---------------------------------------------------------------------------
  test("rb-6 — runEnvCreate returns 1 → runPreviewRebuild returns 1", async () => {
    const { deps } = makeFakeDeps("failed");
    const input: PreviewRebuildInput = {
      vm: vm.name,
      app: app.name,
      branch: "feat/failing",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 7: runEnvCreate called with default db=dblab and previewDomain=samo.cat
  // ---------------------------------------------------------------------------
  test("rb-7 — EnvCreateInput defaults: db=dblab, previewDomain=samo.cat", async () => {
    type FullCall = {
      input: import("../src/commands/env.ts").EnvCreateInput;
      opts: { json: boolean };
    };
    const fullCalls: FullCall[] = [];
    const deps: PreviewRebuildDeps = {
      runEnvCreate: async (input, opts, _vmStore, _appStore, _envStore, _execDeps, out, _err) => {
        fullCalls.push({ input, opts });
        out(`env built`);
        return 0;
      },
      vmStore,
      appStore,
      envStore,
    };

    const pInput: PreviewRebuildInput = {
      vm: vm.name,
      app: app.name,
      branch: "feat/defaults",
    };
    const c = capture();
    await runPreviewRebuild(pInput, { json: false }, deps, c.out, c.err);

    expect(fullCalls.length).toBe(1);
    expect(fullCalls[0]!.input.db).toBe("dblab");
    expect(fullCalls[0]!.input.previewDomain).toBe("samo.cat");
  });
});
