import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAppRegisterFromToml } from "../src/commands/app.ts";
import { runEnvGc, type EnvExecDeps, type GcReport } from "../src/commands/env.ts";
import { runEnvIdleGc } from "../src/commands/env-idle.ts";
import { runTriggerRun, type TriggerDeps } from "../src/commands/trigger.ts";
import { runHealPass } from "../src/preview/heal.ts";
import { runPrPreviewPass } from "../src/preview/pr.ts";
import { runStandingPreviewPass } from "../src/preview/standing.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import { runBatchedVmCycle } from "../src/ssh/batch.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

function vm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-standing",
    provider: "hetzner",
    providerId: "123",
    name: "standing-vm",
    ip: "192.0.2.10",
    sshKeyPath: "/tmp/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    region: "fsn1",
    type: "cx23",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-standing",
    vmId: "vm-standing",
    name: "gregg-brandalise",
    repo: "NikolayS/gregg-brandalise",
    branch: "main",
    appDir: "/opt/gregg-brandalise/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/",
    serviceUnit: "gregg-brandalise",
    releaseTagPattern: "v*",
    standingPreview: true,
    ...overrides,
  };
}

function env(overrides: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-standing",
    vmId: "vm-standing",
    appName: "gregg-brandalise",
    branch: "main",
    name: "gregg-brandalise-main",
    port: 3100,
    vhost: "gregg-brandalise-main.samo.cat",
    dbBackend: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-standing-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
  vmStore.upsert(vm());
  appStore.upsert(app());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("standing preview manifest opt-in", () => {
  const manifest = (extra: string) => [
    'name = "gregg-brandalise"',
    'repo = "NikolayS/gregg-brandalise"',
    'branch = "main"',
    'appDir = "/opt/gregg-brandalise/app"',
    'buildCmd = "npm run build"',
    'healthUrl = "http://localhost:3000/"',
    'serviceUnit = "gregg-brandalise"',
    extra,
  ].filter(Boolean).join("\n");

  test("persists opt-in with a separate release tag channel", () => {
    const path = join(dir, "standing.toml");
    writeFileSync(path, manifest('releaseTagPattern = "v*"\nstandingPreview = true'));

    const code = runAppRegisterFromToml(
      { vm: "standing-vm", tomlPath: path }, { json: false }, vmStore, appStore,
      () => {}, () => {},
    );

    expect(code).toBe(0);
    expect(appStore.get("vm-standing", "gregg-brandalise")?.standingPreview).toBe(true);
  });

  test("rejects opt-in without a release tag channel", () => {
    const path = join(dir, "invalid-standing.toml");
    writeFileSync(path, manifest("standingPreview = true"));
    let error = "";

    const code = runAppRegisterFromToml(
      { vm: "standing-vm", tomlPath: path }, { json: false }, vmStore, appStore,
      () => {}, (line) => { error += line; },
    );

    expect(code).toBe(1);
    expect(error).toContain("releaseTagPattern");
  });
});

describe("tracked branch convergence", () => {
  test("creates, no-ops at the same SHA, then redeploys a newer SHA", async () => {
    let sha = "a".repeat(40);
    let ensures = 0;
    const deps = {
      envStore,
      resolveRef: async () => sha,
      ensurePreview: async (args: { headSha: string }) => {
        ensures++;
        envStore.upsert({
          ...(envStore.get("vm-standing", "gregg-brandalise", "main") ?? env()),
          lastDeployedSha: args.headSha,
        });
        return { vhost: env().vhost, outcome: "ok" as const };
      },
    };

    expect((await runStandingPreviewPass(app(), vm(), deps)).action).toBe("created");
    expect((await runStandingPreviewPass(app(), vm(), deps)).action).toBe("unchanged");
    expect(ensures).toBe(1);

    sha = "b".repeat(40);
    expect((await runStandingPreviewPass(app(), vm(), deps)).action).toBe("redeployed");
    expect(ensures).toBe(2);
    expect(envStore.get("vm-standing", "gregg-brandalise", "main")?.lastDeployedSha)
      .toBe(sha);
  });

  test("fails when the create path does not persist the deployed SHA", async () => {
    const result = await runStandingPreviewPass(app(), vm(), {
      envStore,
      resolveRef: async () => "c".repeat(40),
      ensurePreview: async () => ({ vhost: env().vhost, outcome: "ok" }),
    });

    expect(result.action).toBe("failed");
    expect(envStore.get("vm-standing", "gregg-brandalise", "main")).toBeUndefined();
  });
});

describe("standing preview lifecycle guards", () => {
  test("branch/TTL GC cannot reap the tracked branch", async () => {
    envStore.upsert(env());
    let remoteCalls = 0;
    const deps: EnvExecDeps = {
      remote: async () => {
        remoteCalls++;
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      uuid: () => "uuid",
      branchState: async () => "gone",
    };
    let output = "";

    await runEnvGc(
      { vm: "standing-vm", app: "gregg-brandalise", reap: true, ttl: 1 },
      { json: true }, vmStore, appStore, envStore, deps,
      (line) => { output += line; }, () => {},
    );
    const report = JSON.parse(output) as GcReport;

    expect(report.candidates).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(remoteCalls).toBe(0);
    expect(envStore.get("vm-standing", "gregg-brandalise", "main")).toBeDefined();
  });

  test("idle GC cannot reap the tracked branch", async () => {
    envStore.upsert(env({ lastAccess: "2026-01-01T00:00:00.000Z" }));
    let destroys = 0;
    const report = await runEnvIdleGc(
      {
        vm: "standing-vm",
        idleThresholdMs: 1,
        idleReap: true,
        now: () => new Date("2026-07-13T00:00:00.000Z"),
      },
      vmStore, appStore, envStore,
      async () => { destroys++; return 0; }, () => {}, () => {},
    );

    expect(report.candidates).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(destroys).toBe(0);
  });

  test("PR-close reaping cannot remove it, even with stale PR ownership", async () => {
    envStore.upsert(env({ prNumber: 42 }));
    let reaps = 0;
    await runPrPreviewPass(app(), vm(), {
      envStore,
      listOpenPrs: async () => [],
      ensurePreview: async () => { throw new Error("unexpected create"); },
      upsertPrComment: async () => {},
      reapPreview: async () => { reaps++; },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    }, () => {}, () => {});

    expect(reaps).toBe(0);
    expect(envStore.get("vm-standing", "gregg-brandalise", "main")).toBeDefined();
  });

  test("DBLab-backed tracked branches remain eligible for clone healing", async () => {
    envStore.upsert(env({ dbBackend: "dblab", dbName: "gregg-main" }));
    let recreates = 0;
    const report = await runHealPass(app(), vm(), {
      envStore,
      probeClones: async () => new Map([["gregg-main", "dead"]]),
      recreate: async () => { recreates++; return "ok"; },
    }, () => {}, () => {});

    expect(report.healed).toBe(1);
    expect(recreates).toBe(1);
  });
});

describe("trigger reporting and SSH batching", () => {
  test("a failed standing preview makes the trigger cycle fail red", async () => {
    appStore.upsert(app({ deployedSha: "d".repeat(40) }));
    const deps: TriggerDeps = {
      resolveRef: async () => "d".repeat(40),
      deploy: async () => 0,
      fetch: globalThis.fetch,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      standingPreview: async () => ({
        app: "gregg-brandalise",
        vm: "standing-vm",
        branch: "main",
        action: "failed",
        error: "public probe failed",
      }),
    };

    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, deps, () => {}, () => {},
    )).toBe(1);
  });

  test("standing work shares the single batched SSH session", async () => {
    let remoteCalls = 0;
    const result = await runBatchedVmCycle({
      vm: vm(),
      app: app(),
      prs: [],
      standing: { branch: "main", headSha: "e".repeat(40), script: 'echo "standing work"' },
      deadClones: [],
      envStore,
      remote: async () => {
        remoteCalls++;
        return {
          code: 0,
          stdout: [
            "<<<SAMOHOST_BATCH:START:standing-main>>>",
            "standing work",
            "<<<SAMOHOST_BATCH:END:standing-main>>>",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(remoteCalls).toBe(1);
    expect(result.standingResult?.found).toBe(true);
  });
});
