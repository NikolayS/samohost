import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runAppRegister,
  runAppPlan,
  runAppDeploy,
  runAppStatus,
  type AppDeployDeps,
} from "../src/commands/app.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { SpawnResult } from "../src/ssh/runner.ts";
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
    get o() { return out; },
    get e() { return err; },
  };
}

const SHA = "abc1234def5678901234567890abcdef12345678";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs app", () => {
  test("register with required + optional flags", () => {
    const cmd = parseArgs([
      "app", "register", "samo-we-field-record",
      "--name", "field-record",
      "--repo", "Tanya301/field-record-1",
      "--service-unit", "field-record",
      "--health-url", "http://localhost:3000/api/version",
      "--migrate-cmd", "npm run migrate",
      "--assert-rls",
    ]);
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.vm).toBe("samo-we-field-record");
    expect(cmd.input.name).toBe("field-record");
    expect(cmd.input.repo).toBe("Tanya301/field-record-1");
    expect(cmd.input.branch).toBe("main"); // default
    expect(cmd.input.appDir).toBe("/opt/field-record/app"); // derived default
    expect(cmd.input.migrateCmd).toBe("npm run migrate");
    expect(cmd.input.rlsNonSuperuser).toBe(true);
  });

  test("register rejects a non owner/name repo", () => {
    expect(() =>
      parseArgs([
        "app", "register", "vm", "--name", "x", "--repo", "noslash",
        "--service-unit", "x", "--health-url", "http://h",
      ]),
    ).toThrow(/owner\/name/);
  });

  test("plan requires --sha", () => {
    const cmd = parseArgs(["app", "plan", "vm", "field-record", "--sha", SHA]);
    if (cmd.kind !== "app-plan") throw new Error("expected app-plan");
    expect(cmd.input).toEqual({ vm: "vm", app: "field-record", sha: SHA });
    expect(() => parseArgs(["app", "plan", "vm", "field-record"])).toThrow(/--sha/);
  });

  test("deploy --sha and --ref are mutually exclusive", () => {
    expect(() =>
      parseArgs(["app", "deploy", "vm", "fr", "--sha", SHA, "--ref", "main"]),
    ).toThrow(/mutually exclusive/);
  });

  test("deploy parses --ref --skip-ci-gate --json", () => {
    const cmd = parseArgs([
      "app", "deploy", "vm", "fr", "--ref", "main", "--skip-ci-gate", "--json",
    ]);
    if (cmd.kind !== "app-deploy") throw new Error("expected app-deploy");
    expect(cmd.input.ref).toBe("main");
    expect(cmd.input.skipCiGate).toBe(true);
    expect(cmd.json).toBe(true);
  });

  test("unknown subcommand throws", () => {
    expect(() => parseArgs(["app", "wat"])).toThrow(/unknown app subcommand/);
    expect(() => parseArgs(["app"])).toThrow(/requires a subcommand/);
  });
});

// ---------------------------------------------------------------------------
// Commands (offline, temp stores)
// ---------------------------------------------------------------------------

describe("app commands", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-app-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function register(): void {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "field-record",
        repo: "Tanya301/field-record-1",
        branch: "main",
        appDir: "/opt/field-record/app",
        buildCmd: "npm run build",
        serviceUnit: "field-record",
        healthUrl: "http://localhost:3000/api/version",
        migrateCmd: "npm run migrate",
        seedCmd: "npm run db:seed",
        rlsNonSuperuser: true,
      },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
  }

  test("register writes an AppRecord bound to the VM id", () => {
    register();
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec).toBeDefined();
    expect(rec?.vmId).toBe("vm-1111");
    expect(rec?.assertions?.rlsNonSuperuser).toBe(true);
    expect(rec?.deployedSha).toBeUndefined();
  });

  test("register fails for an unknown VM", () => {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "nope", name: "x", repo: "o/r", branch: "main",
        appDir: "/opt/x/app", buildCmd: "b", serviceUnit: "x",
        healthUrl: "http://h", rlsNonSuperuser: false,
      },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found");
  });

  test("plan prints the deploy script for the sha", () => {
    register();
    const c = capture();
    const code = runAppPlan(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("set -euo pipefail");
    expect(c.o).toContain(SHA);
    expect(c.o).toContain("sudo /usr/bin/systemctl restart");
  });

  test("status prints bookkeeping (offline)", () => {
    register();
    const c = capture();
    const code = runAppStatus(
      { vm: "samo-we-field-record", app: "field-record" },
      { json: true }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    expect(parsed.name).toBe("field-record");
    expect(parsed.deployedSha).toBeUndefined();
  });

  // ---- deploy end-to-end (fake spawn emits canned phase streams) ----------

  function deployDeps(
    phaseStream: string,
    overrides: Partial<AppDeployDeps> = {},
  ): AppDeployDeps {
    return {
      remote: (_vm, _script): Promise<SpawnResult> =>
        Promise.resolve({ code: 0, stdout: phaseStream, stderr: "" }),
      resolveRef: (_repo, _ref) => Promise.resolve(SHA),
      fetch: (async () =>
        ({ ok: true, json: async () => ({ workflow_runs: [{ conclusion: "success" }] }) }) as Response) as unknown as typeof fetch,
      now: () => new Date("2026-06-11T12:00:00.000Z"),
      env: { GH_TOKEN: "tok" },
      ...overrides,
    };
  }

  const HAPPY = [
    "<<<SAMOHOST_PHASE:fetch:start>>>", "<<<SAMOHOST_PHASE:fetch:ok>>>",
    "<<<SAMOHOST_PHASE:build:start>>>", "<<<SAMOHOST_PHASE:build:ok>>>",
    "<<<SAMOHOST_PHASE:restart:start>>>", "<<<SAMOHOST_PHASE:restart:ok>>>",
    "<<<SAMOHOST_PHASE:health:start>>>", "<<<SAMOHOST_PHASE:health:ok>>>",
  ].join("\n");

  const ROLLED_BACK = [
    "<<<SAMOHOST_PHASE:build:start>>>", "<<<SAMOHOST_PHASE:build:ok>>>",
    "<<<SAMOHOST_PHASE:health:start>>>", "<<<SAMOHOST_PHASE:health:fail>>>",
    "<<<SAMOHOST_PHASE:rollback:ok>>>",
  ].join("\n");

  test("deploy happy path: exit 0, deployedSha set, outcome deployed", async () => {
    register();
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: false },
      { json: true }, vmStore, appStore, deployDeps(HAPPY), c.out, c.err,
    );
    expect(code).toBe(0);
    const report = JSON.parse(c.o);
    expect(report.outcome).toBe("deployed");
    expect(report.ci).toBe("success");
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.deployedSha).toBe(SHA);
    expect(rec?.failedSha).toBeUndefined();
    expect(rec?.lastDeployAt).toBe("2026-06-11T12:00:00.000Z");
  });

  test("deploy rollback path: exit 1, failedSha set, deployedSha unchanged", async () => {
    register();
    // seed a prior good deploy so we can assert deployedSha is NOT advanced.
    appStore.upsert({ ...appStore.get("vm-1111", "field-record")!, deployedSha: "GOODSHA" });
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: false },
      { json: true }, vmStore, appStore, deployDeps(ROLLED_BACK), c.out, c.err,
    );
    expect(code).toBe(1);
    const report = JSON.parse(c.o);
    expect(report.outcome).toBe("rolled-back");
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.failedSha).toBe(SHA);
    expect(rec?.deployedSha).toBe("GOODSHA"); // NOT advanced on failure
  });

  test("known-bad-SHA guard refuses a recorded failedSha", async () => {
    register();
    appStore.upsert({ ...appStore.get("vm-1111", "field-record")!, failedSha: SHA });
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: false },
      { json: false }, vmStore, appStore, deployDeps(HAPPY), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("known-bad");
  });

  test("CI gate refuses a red sha (no remote call made)", async () => {
    register();
    let remoteCalled = false;
    const deps = deployDeps(HAPPY, {
      remote: () => { remoteCalled = true; return Promise.resolve({ code: 0, stdout: "", stderr: "" }); },
      fetch: (async () =>
        ({ ok: true, json: async () => ({ workflow_runs: [{ conclusion: "failure" }] }) }) as Response) as unknown as typeof fetch,
    });
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: false },
      { json: false }, vmStore, appStore, deps, c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("CI gate refused");
    expect(remoteCalled).toBe(false);
  });

  test("--skip-ci-gate bypasses the gate and deploys", async () => {
    register();
    let fetchCalled = false;
    const deps = deployDeps(HAPPY, {
      fetch: (async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } as Response; }) as unknown as typeof fetch,
    });
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: true },
      { json: true }, vmStore, appStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(fetchCalled).toBe(false); // gate skipped → fetch never called
    expect(JSON.parse(c.o).ci).toBeUndefined();
  });

  test("--ref resolves a sha via the injected resolver", async () => {
    register();
    let seenRef: string | undefined;
    const deps = deployDeps(HAPPY, {
      resolveRef: (_repo, ref) => { seenRef = ref; return Promise.resolve(SHA); },
    });
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", ref: "feat/x", skipCiGate: false },
      { json: true }, vmStore, appStore, deps, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(seenRef).toBe("feat/x");
    expect(JSON.parse(c.o).sha).toBe(SHA);
  });

  test("incomplete stream leaves deployedSha/failedSha unchanged", async () => {
    register();
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: true },
      { json: true }, vmStore, appStore,
      deployDeps("<<<SAMOHOST_PHASE:build:start>>>\n<<<SAMOHOST_PHASE:build:fail>>>"),
      c.out, c.err,
    );
    expect(code).toBe(1);
    expect(JSON.parse(c.o).outcome).toBe("incomplete");
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.deployedSha).toBeUndefined();
    expect(rec?.failedSha).toBeUndefined();
    expect(rec?.lastDeployAt).toBe("2026-06-11T12:00:00.000Z"); // attempt stamped
  });
});
