import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runAppRegister,
  runAppPlan,
  runAppDeploy,
  runAppStatus,
  runAppRegisterFromToml,
  runAppBootstrap,
  type AppDeployDeps,
} from "../src/commands/app.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { SpawnResult } from "../src/ssh/runner.ts";
import type { VmRecord } from "../src/types.ts";
import {
  buildEnvCreateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";

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
  test("bootstrap defers --db-name requirements until the stored app kind is known", () => {
    const staticShape = parseArgs([
      "app", "bootstrap", "vm", "site", "--app-user", "site",
    ]);
    if (staticShape.kind !== "app-bootstrap") throw new Error("expected app-bootstrap");
    expect(staticShape.input.dbName).toBeUndefined();

    const nodeShape = parseArgs([
      "app", "bootstrap", "vm", "api", "--app-user", "api",
      "--db-name", "api_prod",
    ]);
    if (nodeShape.kind !== "app-bootstrap") throw new Error("expected app-bootstrap");
    expect(nodeShape.input.dbName).toBe("api_prod");
  });

  test("bootstrap parses the control-plane source IP used for cp-http80 firewall access", () => {
    const parsed = parseArgs([
      "app", "bootstrap", "vm", "site", "--app-user", "site",
      "--control-plane-ip", "91.99.233.145",
    ]);
    if (parsed.kind !== "app-bootstrap") throw new Error("expected app-bootstrap");
    expect((parsed.input as typeof parsed.input & { controlPlaneIp?: string }).controlPlaneIp)
      .toBe("91.99.233.145");
  });

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

  // Issue #2 bug 2: the RLS probe's env-var name must be configurable —
  // field-record's non-superuser URL is APP_DATABASE_URL.
  test("register parses --rls-url-var", () => {
    const cmd = parseArgs([
      "app", "register", "vm",
      "--name", "field-record",
      "--repo", "Tanya301/field-record-1",
      "--service-unit", "field-record",
      "--health-url", "http://localhost:3000/api/version",
      "--rls-url-var", "APP_DATABASE_URL",
    ]);
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.rlsUrlVar).toBe("APP_DATABASE_URL");
  });

  test("register parses repeatable --env-db-var and validates names (#11)", () => {
    const cmd = parseArgs([
      "app", "register", "vm",
      "--name", "field-record-sbxenv",
      "--repo", "Tanya301/field-record-1",
      "--service-unit", "field-record",
      "--health-url", "http://localhost:3000/api/version",
      "--env-db-var", "DATABASE_URL",
      "--env-db-var", "APP_DATABASE_URL",
    ]);
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.envDbVars).toEqual(["DATABASE_URL", "APP_DATABASE_URL"]);
    // No flag → undefined (script layer defaults to ["DATABASE_URL"]).
    const bare = parseArgs([
      "app", "register", "vm", "--name", "x", "--repo", "o/r",
      "--service-unit", "x", "--health-url", "http://h",
    ]);
    if (bare.kind !== "app-register") throw new Error("expected app-register");
    expect(bare.input.envDbVars).toBeUndefined();
    // Names are embedded in on-host grep/sed patterns — validate strictly.
    expect(() =>
      parseArgs([
        "app", "register", "vm", "--name", "x", "--repo", "o/r",
        "--service-unit", "x", "--health-url", "http://h",
        "--env-db-var", "BAD NAME",
      ]),
    ).toThrow(/--env-db-var/);
    expect(() =>
      parseArgs([
        "app", "register", "vm", "--name", "x", "--repo", "o/r",
        "--service-unit", "x", "--health-url", "http://h",
        "--rls-url-var", "not-a-valid$name",
      ]),
    ).toThrow(/invalid --rls-url-var/);
  });

  // field-record-1#117 ITEM C (7th drift class): the production public host
  // must be registrable so host-prep can emit the durable main-env vhost.
  test("register parses --main-host and validates it strictly (#117 ITEM C)", () => {
    const cmd = parseArgs([
      "app", "register", "vm",
      "--name", "field-record",
      "--repo", "Tanya301/field-record-1",
      "--service-unit", "field-record",
      "--health-url", "http://localhost:3000/api/version",
      "--main-host", "field-record-1.samo.team",
    ]);
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.mainHost).toBe("field-record-1.samo.team");
    // No flag → undefined (host-prep then omits the main vhost snippet).
    const bare = parseArgs([
      "app", "register", "vm", "--name", "x", "--repo", "o/r",
      "--service-unit", "x", "--health-url", "http://h",
    ]);
    if (bare.kind !== "app-register") throw new Error("expected app-register");
    expect(bare.input.mainHost).toBeUndefined();
    // The host is embedded in a ROOT-run host-prep script — validate strictly
    // (dotted lowercase DNS name), same posture as the preview-domain fix.
    expect(() =>
      parseArgs([
        "app", "register", "vm", "--name", "x", "--repo", "o/r",
        "--service-unit", "x", "--health-url", "http://h",
        "--main-host", "bad host!",
      ]),
    ).toThrow(/--main-host/);
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

describe("app bootstrap uses the stored app kind for the database contract", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-bootstrap-kind-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
    appStore.upsert({
      id: "app-static",
      vmId: "vm-1111",
      name: "site",
      kind: "static",
      repo: "example/site",
      branch: "main",
      appDir: "/opt/site/app",
      buildCmd: "npm run build",
      healthUrl: "https://site.example.com/",
      serviceUnit: "site",
    });
    appStore.upsert({
      id: "app-node",
      vmId: "vm-1111",
      name: "api",
      kind: "node",
      repo: "example/api",
      branch: "main",
      appDir: "/opt/api/app",
      buildCmd: "npm run build",
      healthUrl: "http://localhost:3000/health",
      serviceUnit: "api",
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("static bootstrap needs no db name and emits no database bootstrap data", () => {
    const c = capture();
    const code = runAppBootstrap(
      { vm: "samo-we-field-record", app: "site", appUser: "site" },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(c.e).toBe("");
    expect(c.o).not.toContain("createdb");
    expect(c.o).not.toContain("DATABASE_URL=");
    expect(c.o).not.toContain("undefined");
  });

  test("static bootstrap rejects an inert --db-name", () => {
    const c = capture();
    const code = runAppBootstrap(
      { vm: "samo-we-field-record", app: "site", appUser: "site", dbName: "unused" },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.o).toBe("");
    expect(c.e).toContain("--db-name is not valid for a static app");
  });

  test("cp-http80 bootstrap fails closed without a control-plane IP", () => {
    const existing = appStore.get("vm-1111", "site")!;
    appStore.upsert({
      ...existing,
      mainHost: "site.example.com",
      mainListen: "cp-http80",
    });
    const c = capture();
    const code = runAppBootstrap(
      { vm: "samo-we-field-record", app: "site", appUser: "site" },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.o).toBe("");
    expect(c.e).toContain("--control-plane-ip");
  });

  test("cp-http80 bootstrap emits only the requested source-restricted :80 rule", () => {
    const existing = appStore.get("vm-1111", "site")!;
    appStore.upsert({
      ...existing,
      mainHost: "site.example.com",
      mainListen: "cp-http80",
    });
    const c = capture();
    const input = {
      vm: "samo-we-field-record",
      app: "site",
      appUser: "site",
      controlPlaneIp: "91.99.233.145",
    } as Parameters<typeof runAppBootstrap>[0] & { controlPlaneIp: string };
    const code = runAppBootstrap(input, vmStore, appStore, c.out, c.err);
    expect(code).toBe(0);
    expect(c.e).toBe("");
    expect(c.o).toContain("proto tcp from '91.99.233.145' to any port 80");
    expect(c.o).not.toMatch(/ufw allow (?:80|80\/tcp)/);
  });

  test("cp-http80 bootstrap rejects a non-IP control-plane source", () => {
    const existing = appStore.get("vm-1111", "site")!;
    appStore.upsert({
      ...existing,
      mainHost: "site.example.com",
      mainListen: "cp-http80",
    });
    const c = capture();
    const input = {
      vm: "samo-we-field-record",
      app: "site",
      appUser: "site",
      controlPlaneIp: "0.0.0.0/0",
    } as Parameters<typeof runAppBootstrap>[0] & { controlPlaneIp: string };
    expect(runAppBootstrap(input, vmStore, appStore, c.out, c.err)).toBe(1);
    expect(c.o).toBe("");
    expect(c.e).toContain("valid IP");
  });

  test("cp-http80 bootstrap reuses the source IP persisted during provision", () => {
    const existing = appStore.get("vm-1111", "site")!;
    appStore.upsert({
      ...existing,
      mainHost: "site.example.com",
      mainListen: "cp-http80",
    });
    vmStore.upsert(vm({
      controlPlaneIp: "91.99.233.145",
    } as Partial<VmRecord> & { controlPlaneIp: string }));
    const c = capture();
    expect(runAppBootstrap(
      { vm: "samo-we-field-record", app: "site", appUser: "site" },
      vmStore,
      appStore,
      c.out,
      c.err,
    )).toBe(0);
    expect(c.e).toBe("");
    expect(c.o).toContain("proto tcp from '91.99.233.145' to any port 80");
  });

  test("node bootstrap still requires and uses an explicit db name", () => {
    const missing = capture();
    expect(runAppBootstrap(
      { vm: "samo-we-field-record", app: "api", appUser: "api" },
      vmStore,
      appStore,
      missing.out,
      missing.err,
    )).toBe(1);
    expect(missing.e).toContain("requires --db-name");

    const explicit = capture();
    expect(runAppBootstrap(
      { vm: "samo-we-field-record", app: "api", appUser: "api", dbName: "api_prod" },
      vmStore,
      appStore,
      explicit.out,
      explicit.err,
    )).toBe(0);
    expect(explicit.o).toContain("createdb api_prod");
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

  test("register persists rlsUrlVar on the app record (issue #2 bug 2)", () => {
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
        rlsNonSuperuser: true,
        rlsUrlVar: "APP_DATABASE_URL",
      },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.rlsUrlVar).toBe("APP_DATABASE_URL");
  });

  test("register persists envDbVars on the AppRecord (#11)", () => {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record", name: "field-record",
        repo: "Tanya301/field-record-1", branch: "main",
        appDir: "/opt/field-record/app", buildCmd: "npm run build",
        serviceUnit: "field-record",
        healthUrl: "http://localhost:3000/api/version",
        rlsNonSuperuser: false,
        envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"],
      },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(appStore.get("vm-1111", "field-record")?.envDbVars).toEqual([
      "DATABASE_URL", "APP_DATABASE_URL",
    ]);
  });

  // Persistence guard (#117 ITEM C): a parsed-but-dropped mainHost would make
  // `--main-host` a silent no-op — host-prep would render WITHOUT the main
  // vhost while the operator believes it is covered.
  test("register persists mainHost on the AppRecord (#117 ITEM C)", () => {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record", name: "field-record",
        repo: "Tanya301/field-record-1", branch: "main",
        appDir: "/opt/field-record/app", buildCmd: "npm run build",
        serviceUnit: "field-record",
        healthUrl: "http://localhost:3000/api/version",
        rlsNonSuperuser: false,
        mainHost: "field-record-1.samo.team",
      },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(appStore.get("vm-1111", "field-record")?.mainHost).toBe(
      "field-record-1.samo.team",
    );
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

  test("empty stream → outcome incomplete, deployedSha NOT set", async () => {
    register();
    const c = capture();
    const code = await runAppDeploy(
      { vm: "samo-we-field-record", app: "field-record", sha: SHA, skipCiGate: true },
      { json: true }, vmStore, appStore,
      deployDeps(""),
      c.out, c.err,
    );
    expect(code).toBe(1);
    expect(JSON.parse(c.o).outcome).toBe("incomplete");
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.deployedSha).toBeUndefined();
    expect(rec?.failedSha).toBeUndefined();
    expect(rec?.lastDeployAt).toBe("2026-06-11T12:00:00.000Z");
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

// ---------------------------------------------------------------------------
// Issue #36 — --kind flag for app register
// ---------------------------------------------------------------------------

describe("parseArgs app register --kind", () => {
  function baseRegisterArgs(extra: string[] = []): string[] {
    return [
      "app", "register", "samo-we-field-record",
      "--name", "gc1",
      "--repo", "samo-agent/gc1",
      "--service-unit", "gc1",
      "--health-url", "http://localhost:3000/health",
      ...extra,
    ];
  }

  test("--kind static persists kind:'static' on the AppRecord", () => {
    const cmd = parseArgs(baseRegisterArgs(["--kind", "static"]));
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.kind).toBe("static");
  });

  test("--kind node persists kind:'node' on the AppRecord", () => {
    const cmd = parseArgs(baseRegisterArgs(["--kind", "node"]));
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.kind).toBe("node");
  });

  test("no --kind flag leaves kind undefined (defaults to node in the impl)", () => {
    const cmd = parseArgs(baseRegisterArgs());
    if (cmd.kind !== "app-register") throw new Error("expected app-register");
    expect(cmd.input.kind).toBeUndefined();
  });

  test("--kind bogus throws a UsageError", () => {
    expect(() => parseArgs(baseRegisterArgs(["--kind", "bogus"]))).toThrow(/--kind/);
  });
});

describe("app register --kind integration (temp store)", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-kind-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(
      {
        id: "vm-1111",
        provider: "hetzner",
        providerId: "1",
        name: "samo-we-field-record",
        ip: "1.2.3.4",
        sshKeyPath: "/k",
        sshPort: 2223,
        sshUser: "agent",
        hostKeyFingerprint: "SHA256:" + "A".repeat(43),
        region: "fsn1",
        type: "cx22",
        modules: [],
        lifecycleState: "adopted",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as import("../src/types.ts").VmRecord,
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("--kind static persists kind:'static' on the saved AppRecord", () => {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "gc1",
        repo: "samo-agent/gc1",
        branch: "main",
        appDir: "/opt/gc1/app",
        buildCmd: "npm run build",
        serviceUnit: "gc1",
        healthUrl: "http://localhost:3000/health",
        rlsNonSuperuser: false,
        kind: "static",
        staticRoot: "dist",
      },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "gc1");
    expect(rec?.kind).toBe("static");
    expect(rec?.staticRoot).toBe("dist");
  });

  test("--from-toml with kind in the toml persists it on the AppRecord", () => {
    const { join: pathJoin } = require("node:path");
    const { writeFileSync } = require("node:fs");
    const tomlPath = pathJoin(dir, "test.toml");
    writeFileSync(
      tomlPath,
      [
        'name = "gc1"',
        'repo = "samo-agent/gc1"',
        'branch = "main"',
        'appDir = "/opt/gc1/app"',
        'buildCmd = "npm run build"',
        'healthUrl = "http://localhost:3000/health"',
        'serviceUnit = "gc1"',
        'kind = "static"',
        'staticRoot = "dist"',
      ].join("\n"),
    );
    const { runAppRegisterFromToml } = require("../src/commands/app.ts");
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "gc1");
    expect(rec?.kind).toBe("static");
    expect(rec?.staticRoot).toBe("dist");
  });
});

// ---------------------------------------------------------------------------
// Issue #97 follow-up (#98) — appUser dropped during registration
//
// Root cause (same bug class as #95's dbBackend): AppRegisterInput had no
// appUser field, runAppRegister's AppSpec spread did not include it, and
// runAppRegisterFromToml didn't thread it from AppManifest to AppRegisterInput.
//
// Consequence: even after adding AppSpec.appUser (done in #97's RED commit),
// an AppRecord registered via --from-toml has appUser=undefined, so
// buildCloneFnLines falls back to plain `git` — the dubious-ownership failure
// the entire #97 fix was written to prevent.
//
// RED: reg-au-1 through reg-au-3 fail on the current code.
// GREEN: after threading appUser through runAppRegister + runAppRegisterFromToml.
// ---------------------------------------------------------------------------

describe("issue #98 — appUser threading through runAppRegister / --from-toml", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  const vmRecord: VmRecord = {
    id: "vm-2222",
    provider: "hetzner",
    providerId: "9876543",
    name: "samo-we-field-record",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "fsn1",
    type: "cx23",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function capture98() {
    let out = "";
    let err = "";
    return {
      out: (s: string) => { out += s + "\n"; },
      err: (s: string) => { err += s + "\n"; },
      get o() { return out; },
      get e() { return err; },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-appuser-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vmRecord);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeToml98(extra: string): string {
    const tomlPath = join(dir, "test.toml");
    writeFileSync(tomlPath, [
      'name        = "samohost-fixture"',
      'repo        = "samo-agent/samohost-fixture"',
      'branch      = "main"',
      'appDir      = "/opt/samohost-fixture/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/api/version"',
      'serviceUnit = "samohost-fixture"',
      extra,
    ].filter(Boolean).join("\n"));
    return tomlPath;
  }

  test("reg-au-1: runAppRegister with appUser persists it on the AppRecord", () => {
    // BUG: runAppRegister's AppSpec construction does not spread appUser from
    // AppRegisterInput, so the AppRecord is saved without the field even when
    // the caller explicitly supplies it.
    const c = capture98();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "samohost-fixture",
        repo: "samo-agent/samohost-fixture",
        branch: "main",
        appDir: "/opt/samohost-fixture/app",
        buildCmd: "npm run build",
        serviceUnit: "samohost-fixture",
        healthUrl: "http://localhost:3000/api/version",
        rlsNonSuperuser: false,
        appUser: "samohost-fixture",
      },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-2222", "samohost-fixture");
    expect(rec).toBeDefined();
    // Fails today: appUser is not spread into the AppSpec, so rec.appUser is undefined.
    expect(rec?.appUser).toBe("samohost-fixture");
  });

  test("reg-au-2: --from-toml with appUser in the TOML yields AppRecord.appUser", () => {
    // BUG: runAppRegisterFromToml builds AppRegisterInput from AppManifest but
    // never passes app.appUser, so the field is dropped before runAppRegister
    // is called.
    const tomlPath = writeToml98('appUser = "samohost-fixture"');
    const c = capture98();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-2222", "samohost-fixture");
    expect(rec).toBeDefined();
    // Fails today: appUser is dropped in the manifest→AppRegisterInput→AppSpec chain.
    expect(rec?.appUser).toBe("samohost-fixture");
  });

  test("reg-au-3: AppRecord.appUser drives sudo-based git in buildEnvCreateScript", () => {
    // End-to-end consequence: a correctly-registered app (appUser set) must
    // produce a clone script that uses `sudo -u <appUser> ... /usr/bin/git`
    // rather than plain git — preventing the dubious-ownership failure.
    const tomlPath = writeToml98('appUser = "samohost-fixture"');
    const c = capture98();
    runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    const rec = appStore.get("vm-2222", "samohost-fixture");
    expect(rec).toBeDefined();
    const envTarget: EnvScriptTarget = {
      name: "samohost-fixture-feat-x",
      branch: "feat/x",
      port: 3200,
      vhost: "samohost-fixture-feat-x.samo.cat",
      dbBackend: "none",
    };
    const script = buildEnvCreateScript(rec!, envTarget);
    // Fails today: rec.appUser is undefined → buildCloneFnLines generates
    // plain `git clone` instead of `sudo -u 'samohost-fixture' ... /usr/bin/git`.
    expect(script).toContain("sudo -u 'samohost-fixture'");
    expect(script).toContain("/usr/bin/git");
  });

  test("reg-au-4: absent appUser leaves AppRecord.appUser undefined (no regression)", () => {
    // Regression guard: existing TOML manifests without appUser must not be
    // affected — the AppRecord stays free of the field.
    const tomlPath = writeToml98("");
    const c = capture98();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-2222", "samohost-fixture");
    expect(rec?.appUser).toBeUndefined();
  });
});
