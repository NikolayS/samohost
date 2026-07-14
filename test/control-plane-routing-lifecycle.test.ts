import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runAppDeploy,
  runAppRegister,
  type AppDeployDeps,
  type AppRegisterInput,
} from "../src/commands/app.ts";
import {
  controlPlaneMainRouteFingerprint,
  controlPlaneMainRoutePath,
  renderControlPlaneMainRoute,
} from "../src/caddy/control-plane.ts";
import { projectMainRoutePath } from "../src/caddy/project-main.ts";
import { reconcileTwoHopMainRoute } from "../src/caddy/two-hop.ts";
import {
  runTriggerRun,
  type TriggerDeps,
  type TriggerRunReport,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";
import type { SpawnResult } from "../src/ssh/runner.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_HOST = "old-client.samo.team";
const NEW_HOST = "new-client.samo.team";

type CpProbeMode = "success" | "unreachable" | "bad-gateway" | "wrong-identity";

function vm(): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "123",
    name: "shared-client-sites",
    ip: "167.233.128.162",
    sshKeyPath: "/home/samo/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function input(overrides: Partial<AppRegisterInput> = {}): AppRegisterInput {
  return {
    vm: "shared-client-sites",
    name: "client-site",
    repo: "example/client-site",
    branch: "main",
    appDir: "/opt/client-site/app",
    buildCmd: "npm run build",
    serviceUnit: "client-site",
    healthUrl: "http://127.0.0.1:3000/health",
    rlsNonSuperuser: false,
    mainHost: OLD_HOST,
    mainListen: "cp-http80",
    ...overrides,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { err += s + "\n"; },
    get o() { return out; },
    get e() { return err; },
  };
}

function ok(stdout = "ok"): SpawnResult {
  return { code: 0, stdout, stderr: "" };
}

function phase(script: string): "begin" | "prepare" | "rollback" | "commit" {
  if (script.includes("transaction begin")) return "begin";
  if (script.includes("transaction prepare")) return "prepare";
  if (script.includes("transaction rollback")) return "rollback";
  if (script.includes("transaction commit")) return "commit";
  throw new Error("unknown project routing script");
}

describe("register -> deploy/trigger two-hop routing lifecycle", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-routing-lifecycle-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function register(spec: AppRegisterInput): AppRecord {
    const c = capture();
    expect(
      runAppRegister(spec, { json: false }, vmStore, appStore, c.out, c.err),
      c.e,
    ).toBe(0);
    return appStore.get(vm().id, spec.name)!;
  }

  function seedAppliedRoute(spec = input()): { app: AppRecord; fingerprint: string } {
    const original = register(spec);
    const fingerprint = controlPlaneMainRouteFingerprint(original, vm());
    const applied = {
      ...original,
      deployedSha: SHA,
      controlPlaneRouteFingerprint: fingerprint,
    };
    appStore.upsert(applied);
    return { app: applied, fingerprint };
  }

  function routingHarness(cpCode = 0) {
    const events: string[] = [];
    const projectScripts: string[] = [];
    const controlScripts: string[] = [];
    const projectRoute = async (_vm: VmRecord, script: string): Promise<SpawnResult> => {
      const p = phase(script);
      events.push(`project:${p}`);
      projectScripts.push(script);
      return ok(p);
    };
    const controlPlaneRoute = async (_vm: VmRecord, script: string): Promise<SpawnResult> => {
      events.push("control-plane");
      controlScripts.push(script);
      return cpCode === 0 ? ok("cp") : { code: cpCode, stdout: "", stderr: "caddy reload failed" };
    };
    return { events, projectScripts, controlScripts, projectRoute, controlPlaneRoute };
  }

  function executedControlPlaneHarness(
    oldApp: AppRecord,
    probeMode: CpProbeMode,
    identity: { sha: string; tag: string } = { sha: SHA, tag: SHA },
  ) {
    const base = routingHarness();
    const sandbox = join(dir, `cp-${probeMode}`);
    const caddyDir = join(sandbox, "caddy");
    const sitesDir = join(caddyDir, "sites.d");
    const binDir = join(sandbox, "bin");
    const reloadLog = join(sandbox, "reload.log");
    const projectReloadLog = join(sandbox, "project-reload.log");
    const curlLog = join(sandbox, "curl.log");
    const projectCaddyDir = join(sandbox, "project-caddy");
    const projectSitesDir = join(projectCaddyDir, "sites.d");
    mkdirSync(sitesDir, { recursive: true });
    mkdirSync(projectSitesDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(reloadLog, "");
    writeFileSync(projectReloadLog, "");
    writeFileSync(curlLog, "");
    writeFileSync(join(caddyDir, "Caddyfile"), "import sites.d/*.caddy\n");
    writeFileSync(join(projectCaddyDir, "Caddyfile"), "import sites.d/*.caddy\n");
    const snippet = controlPlaneMainRoutePath(oldApp).replace("/etc/caddy", caddyDir);
    const oldRoute = renderControlPlaneMainRoute(oldApp, vm()) + "\n";
    writeFileSync(snippet, oldRoute);
    const projectSnippet = projectMainRoutePath(oldApp).replace(
      "/etc/caddy",
      projectCaddyDir,
    );
    const projectAddress = oldApp.mainListen === "tls"
      ? oldApp.mainHost!
      : `http://${oldApp.mainHost!}:80`;
    const projectOldRoute = oldApp.kind === "static"
      ? [
        `${projectAddress} {`,
        `\troot * "${oldApp.appDir}"`,
        "\ttry_files {path} /index.html",
        "\tfile_server",
        "}",
        "",
      ].join("\n")
      : [
        `${projectAddress} {`,
        "\treverse_proxy localhost:3000",
        "}",
        "",
      ].join("\n");
    writeFileSync(projectSnippet, projectOldRoute);
    writeFileSync(join(binDir, "caddy"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(binDir, "systemctl"), [
      "#!/usr/bin/env bash",
      'if [[ "${SAMOHOST_TEST_HOP:-cp}" == "project" ]]; then',
      '  printf "%s\\n" "$*" >> "$PROJECT_RELOAD_LOG"',
      "else",
      '  printf "%s\\n" "$*" >> "$CP_RELOAD_LOG"',
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    writeFileSync(join(binDir, "curl"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$CP_CURL_LOG"',
      'output=""',
      'while [[ "$#" -gt 0 ]]; do',
      '  if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi',
      "done",
      'if [[ -z "$output" ]]; then printf "200"; exit 0; fi',
      'case "$CP_PROBE_MODE" in',
      "  unreachable) exit 7 ;;",
      "  bad-gateway) printf 'upstream unavailable' > \"$output\"; printf '502' ;;",
      "  wrong-identity) printf '%s' '{\"version\":\"old\",\"tag\":\"old\",\"sha\":\"0000000000000000000000000000000000000000\",\"environment\":\"production\"}' > \"$output\"; printf '200' ;;",
      "  success) printf '{\"version\":\"%s\",\"tag\":\"%s\",\"sha\":\"%s\",\"environment\":\"production\"}' \"$CP_EXPECTED_TAG\" \"$CP_EXPECTED_TAG\" \"$CP_EXPECTED_SHA\" > \"$output\"; printf '200' ;;",
      "  *) exit 65 ;;",
      "esac",
      "",
    ].join("\n"));
    for (const command of ["caddy", "curl", "sleep", "systemctl"]) {
      chmodSync(join(binDir, command), 0o755);
    }

    const projectRoute = async (
      _vm: VmRecord,
      script: string,
    ): Promise<SpawnResult> => {
      const p = phase(script);
      base.events.push(`project:${p}`);
      base.projectScripts.push(script);
      const sandboxed = script
        .replaceAll("/etc/caddy", projectCaddyDir)
        .replaceAll("/tmp/samohost-main-route-", `${sandbox}/project-txn-`)
        .replaceAll("sudo /usr/bin/", "")
        .replaceAll("/usr/bin/curl", "curl");
      const result = spawnSync("bash", ["-s"], {
        input: sandboxed,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          SAMOHOST_TEST_HOP: "project",
          CP_RELOAD_LOG: reloadLog,
          PROJECT_RELOAD_LOG: projectReloadLog,
          CP_CURL_LOG: curlLog,
        },
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };

    const controlPlaneRoute = async (
      _vm: VmRecord,
      script: string,
    ): Promise<SpawnResult> => {
      base.events.push("control-plane");
      base.controlScripts.push(script);
      const sandboxed = script
        .replaceAll("/etc/caddy", caddyDir)
        .replaceAll("sudo /usr/bin/", "")
        .replaceAll(" -o root -g root", "")
        .replaceAll("/usr/bin/curl", "curl");
      const result = spawnSync("bash", ["-s"], {
        input: sandboxed,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          CP_PROBE_MODE: probeMode,
          CP_EXPECTED_SHA: identity.sha,
          CP_EXPECTED_TAG: identity.tag,
          CP_RELOAD_LOG: reloadLog,
          PROJECT_RELOAD_LOG: projectReloadLog,
          CP_CURL_LOG: curlLog,
        },
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    return {
      ...base,
      projectRoute,
      controlPlaneRoute,
      snippet,
      oldRoute,
      reloadLog,
      curlLog,
      projectSnippet,
      projectOldRoute,
      projectReloadLog,
    };
  }

  async function trigger(
    harness: ReturnType<typeof routingHarness>,
    overrides: Partial<TriggerDeps> = {},
  ): Promise<{ code: number; report: TriggerRunReport; err: string }> {
    let deployCalls = 0;
    const deps: TriggerDeps = {
      resolveRef: async () => SHA,
      deploy: async () => { deployCalls++; return 0; },
      reconcileMainRoute: (app, targetVm) => reconcileTwoHopMainRoute(
        app,
        targetVm,
        {
          projectRoute: harness.projectRoute,
          controlPlaneRoute: harness.controlPlaneRoute,
        },
      ),
      fetch: (async () => {
        throw new Error("same-SHA routing-only drift must not call CI");
      }) as unknown as typeof fetch,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      ...overrides,
    };
    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    expect(deployCalls).toBe(0);
    return { code, report: JSON.parse(c.o), err: c.e };
  }

  async function deployStaticReleaseThroughExecutedProbe(probeMode: CpProbeMode) {
    const releaseSpec = input({
      kind: "static",
      buildCmd: "npm run build",
      healthUrl: "http://127.0.0.1/version.json",
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    const seeded = seedAppliedRoute(releaseSpec);
    const renameHost = probeMode === "wrong-identity";
    if (renameHost) register({ ...releaseSpec, mainHost: NEW_HOST });
    const tag = "v20260714.1";
    const harness = executedControlPlaneHarness(
      seeded.app,
      probeMode,
      { sha: NEW_SHA, tag },
    );
    const deps: AppDeployDeps = {
      remote: async () => {
        harness.events.push("deploy");
        return ok("<<<SAMOHOST_PHASE:health:start>>>\n<<<SAMOHOST_PHASE:health:ok>>>");
      },
      resolveRef: async () => NEW_SHA,
      isCommitOnBranch: async () => true,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
      }) as Response) as unknown as typeof fetch,
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      env: { GH_TOKEN: "test" },
      projectRoute: harness.projectRoute,
      controlPlaneRoute: harness.controlPlaneRoute,
    };
    const c = capture();
    const code = await runAppDeploy(
      {
        vm: vm().name,
        app: "client-site",
        sha: NEW_SHA,
        releaseTag: tag,
        skipCiGate: false,
      },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    return {
      code,
      err: c.e,
      harness,
      saved: appStore.get(vm().id, "client-site")!,
      seeded,
    };
  }

  test("same-SHA host rename prepares project VM, then CP, then commits/stamps", async () => {
    const seeded = seedAppliedRoute();
    const changed = register(input({ mainHost: NEW_HOST }));
    expect(changed.id).toBe(seeded.app.id);
    expect(changed.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);

    const h = routingHarness();
    const result = await trigger(h);

    expect(result.code).toBe(0);
    expect(result.report.results[0]).toMatchObject({
      action: "up-to-date",
      reason: "routing-reconciled",
      sha: SHA,
    });
    expect(h.events).toEqual([
      "project:begin",
      "project:prepare",
      "control-plane",
      "project:commit",
    ]);
    const prepare = h.projectScripts.find((s) => phase(s) === "prepare")!;
    expect(prepare).toContain(NEW_HOST);
    expect(prepare).not.toContain(`Host: ${OLD_HOST}`);
    expect(h.controlScripts[0]).toContain(`${NEW_HOST} {`);
    expect(h.controlScripts[0]).not.toContain(`${OLD_HOST} {`);
    const saved = appStore.get(vm().id, "client-site")!;
    expect(saved.controlPlaneRouteFingerprint).toBe(
      controlPlaneMainRouteFingerprint(saved, vm()),
    );
  });

  for (const [label, overrides, projectNeedle] of [
    ["cp-http80 -> tls", { mainListen: "tls" as const }, "tls internal"],
    ["mainHost removal", { mainHost: undefined, mainListen: undefined }, 'rm -f "$LIVE"'],
  ] as const) {
    test(`${label} changes project topology before removing CP`, async () => {
      seedAppliedRoute();
      register(input(overrides));
      const h = routingHarness();
      const result = await trigger(h);
      expect(result.code).toBe(0);
      expect(h.events).toEqual([
        "project:begin",
        "project:prepare",
        "control-plane",
        "project:commit",
      ]);
      expect(h.projectScripts.find((s) => phase(s) === "prepare")).toContain(projectNeedle);
      expect(h.controlScripts[0]).toContain("No control-plane route is desired");
    });
  }

  test("CP failure restores and health-checks the old project route; no stamp", async () => {
    const seeded = seedAppliedRoute();
    register(input({ mainHost: NEW_HOST }));
    const h = routingHarness(1);
    const result = await trigger(h);

    expect(result.code).toBe(1);
    expect(result.report.results[0]?.action).toBe("error");
    expect(h.events).toEqual([
      "project:begin",
      "project:prepare",
      "control-plane",
      "project:rollback",
    ]);
    const rollback = h.projectScripts.find((s) => phase(s) === "rollback")!;
    expect(rollback).toContain("restore_previous");
    expect(rollback).toContain("restored project route is not healthy");
    expect(
      appStore.get(vm().id, "client-site")?.controlPlaneRouteFingerprint,
    ).toBe(seeded.fingerprint);
  });

  for (const [label, probeMode, expectedStatus] of [
    ["unreachable project VM", "unreachable", "transport-error"],
    ["upstream 502", "bad-gateway", "502"],
  ] as const) {
    test(`executed CP probe: ${label} rolls back both hops and leaves state old`, async () => {
      const seeded = seedAppliedRoute();
      register(input({ mainHost: NEW_HOST }));
      const h = executedControlPlaneHarness(seeded.app, probeMode);
      const result = await trigger(h);

      expect(result.code).toBe(1);
      expect(result.report.results[0]?.error).toContain(
        `last status: ${expectedStatus}`,
      );
      expect(h.events).toEqual([
        "project:begin",
        "project:prepare",
        "control-plane",
        "project:rollback",
      ]);
      expect(readFileSync(h.snippet, "utf8")).toBe(h.oldRoute);
      expect(readFileSync(h.projectSnippet, "utf8")).toBe(h.projectOldRoute);
      expect(readFileSync(h.reloadLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(readFileSync(h.projectReloadLog, "utf8").trim().split("\n")).toHaveLength(3);
      const curlArgs = readFileSync(h.curlLog, "utf8");
      expect(curlArgs).toContain(`--resolve ${NEW_HOST}:443:127.0.0.1`);
      expect(curlArgs).toContain(`https://${NEW_HOST}/health`);
      expect(curlArgs).toContain("--insecure");
      expect(curlArgs).toContain("--noproxy *");
      expect(
        appStore.get(vm().id, "client-site")?.controlPlaneRouteFingerprint,
      ).toBe(seeded.fingerprint);
    });
  }

  test("executed CP probe: wrong static identity rolls back CP and project release", async () => {
    const result = await deployStaticReleaseThroughExecutedProbe("wrong-identity");
    expect(result.code).toBe(1);
    expect(result.err).toContain("last status: 200");
    expect(result.harness.events).toEqual([
      "project:begin",
      "deploy",
      "project:prepare",
      "control-plane",
      "project:rollback",
    ]);
    expect(readFileSync(result.harness.snippet, "utf8")).toBe(result.harness.oldRoute);
    expect(readFileSync(result.harness.projectSnippet, "utf8")).toBe(
      result.harness.projectOldRoute,
    );
    expect(readFileSync(result.harness.reloadLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(result.harness.projectReloadLog, "utf8").trim().split("\n"))
      .toHaveLength(3);
    expect(result.saved.deployedSha).toBe(SHA);
    expect(result.saved.controlPlaneRouteFingerprint).toBe(result.seeded.fingerprint);
  });

  test("executed CP probe: exact static tag/SHA identity commits both hops then stamps", async () => {
    const result = await deployStaticReleaseThroughExecutedProbe("success");
    expect(result.code, result.err).toBe(0);
    expect(result.harness.events).toEqual([
      "project:begin",
      "deploy",
      "project:prepare",
      "control-plane",
      "project:commit",
    ]);
    const live = readFileSync(result.harness.snippet, "utf8");
    expect(live).toBe(result.harness.oldRoute);
    expect(readFileSync(result.harness.reloadLog, "utf8")).toBe("");
    const curlArgs = readFileSync(result.harness.curlLog, "utf8");
    expect(curlArgs).toContain(`--resolve ${OLD_HOST}:443:127.0.0.1`);
    expect(curlArgs).toContain(`https://${OLD_HOST}/version.json`);
    expect(readFileSync(result.harness.projectReloadLog, "utf8").trim().split("\n"))
      .toHaveLength(2);
    expect(result.saved.deployedSha).toBe(NEW_SHA);
    expect(result.saved.controlPlaneRouteFingerprint).toBe(
      controlPlaneMainRouteFingerprint(result.saved, vm()),
    );
  });

  test("project commit failure leaves routing state unstamped for a resumable retry", async () => {
    const seeded = seedAppliedRoute();
    register(input({ mainHost: NEW_HOST }));
    const h = routingHarness();
    const result = await trigger(h, {
      reconcileMainRoute: (app, targetVm) => reconcileTwoHopMainRoute(
        app,
        targetVm,
        {
          projectRoute: async (routeVm, script) => {
            if (phase(script) === "commit") {
              h.events.push("project:commit");
              h.projectScripts.push(script);
              return { code: 1, stdout: "", stderr: "project reload failed" };
            }
            return h.projectRoute(routeVm, script);
          },
          controlPlaneRoute: h.controlPlaneRoute,
        },
      ),
    });

    expect(result.code).toBe(1);
    expect(result.report.results[0]?.action).toBe("error");
    expect(h.events).toEqual([
      "project:begin",
      "project:prepare",
      "control-plane",
      "project:commit",
    ]);
    expect(
      appStore.get(vm().id, "client-site")?.controlPlaneRouteFingerprint,
    ).toBe(seeded.fingerprint);
  });

  test("two apps on one VM transact and stamp independently", async () => {
    seedAppliedRoute();
    seedAppliedRoute(input({
      name: "second-site",
      repo: "example/second-site",
      appDir: "/opt/second-site/app",
      serviceUnit: "second-site",
      mainHost: "second-old.samo.team",
    }));
    register(input({ mainHost: NEW_HOST }));
    register(input({
      name: "second-site",
      repo: "example/second-site",
      appDir: "/opt/second-site/app",
      serviceUnit: "second-site",
      mainHost: "second-new.samo.team",
    }));
    const h = routingHarness();
    const result = await trigger(h);
    expect(result.code).toBe(0);
    expect(result.report.results).toHaveLength(2);
    expect(h.events.filter((e) => e === "control-plane")).toHaveLength(2);
    expect(h.projectScripts.filter((s) => phase(s) === "commit")).toHaveLength(2);
    for (const name of ["client-site", "second-site"]) {
      const saved = appStore.get(vm().id, name)!;
      expect(saved.controlPlaneRouteFingerprint).toBe(
        controlPlaneMainRouteFingerprint(saved, vm()),
      );
    }
  });

  test("new release deploy completes two hops before deploy/release state advances", async () => {
    const releaseSpec = input({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    seedAppliedRoute(releaseSpec);
    register({ ...releaseSpec, mainHost: NEW_HOST });
    const h = routingHarness();
    const appDeployDeps: AppDeployDeps = {
      remote: async () => {
        h.events.push("deploy");
        return ok("<<<SAMOHOST_PHASE:health:start>>>\n<<<SAMOHOST_PHASE:health:ok>>>");
      },
      resolveRef: async () => NEW_SHA,
      isCommitOnBranch: async () => true,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
      }) as Response) as unknown as typeof fetch,
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      env: { GH_TOKEN: "test" },
      projectRoute: h.projectRoute,
      controlPlaneRoute: h.controlPlaneRoute,
    };
    const c = capture();
    const code = await runAppDeploy(
      {
        vm: vm().name,
        app: "client-site",
        sha: NEW_SHA,
        releaseTag: "v20260714.1",
        skipCiGate: false,
      },
      { json: true },
      vmStore,
      appStore,
      appDeployDeps,
      c.out,
      c.err,
    );
    expect(code, c.e).toBe(0);
    expect(h.events).toEqual([
      "project:begin",
      "deploy",
      "project:prepare",
      "control-plane",
      "project:commit",
    ]);
    expect(appStore.get(vm().id, "client-site")?.deployedSha).toBe(NEW_SHA);
  });

  test("CP failure after a new static release rolls project route/release back and keeps state old", async () => {
    const releaseSpec = input({
      kind: "static",
      buildCmd: "npm run build",
      healthUrl: "http://127.0.0.1/version.json",
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    const seeded = seedAppliedRoute(releaseSpec);
    register({ ...releaseSpec, mainHost: NEW_HOST });
    const h = routingHarness(1);
    let deployScript = "";
    const deps: AppDeployDeps = {
      remote: async (_vm, script) => {
        h.events.push("deploy");
        deployScript = script;
        return ok("<<<SAMOHOST_PHASE:health:start>>>\n<<<SAMOHOST_PHASE:health:ok>>>");
      },
      resolveRef: async () => NEW_SHA,
      isCommitOnBranch: async () => true,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
      }) as Response) as unknown as typeof fetch,
      now: () => new Date(),
      env: { GH_TOKEN: "test" },
      projectRoute: h.projectRoute,
      controlPlaneRoute: h.controlPlaneRoute,
    };
    const c = capture();
    expect(await runAppDeploy(
      {
        vm: vm().name,
        app: "client-site",
        sha: NEW_SHA,
        releaseTag: "v20260714.1",
        skipCiGate: false,
      },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    )).toBe(1);
    expect(h.events).toEqual([
      "project:begin",
      "deploy",
      "project:prepare",
      "control-plane",
      "project:rollback",
    ]);
    expect(deployScript).toContain("Prior release cleanup is deferred");
    expect(deployScript).toContain("SAMOHOST_OLD_ROUTE_ADDRESS");
    expect(deployScript).toContain("01-samohost-transition-");
    expect(h.projectScripts.find((s) => phase(s) === "rollback")).toContain(
      "worktree remove --force",
    );
    expect(h.projectScripts.find((s) => phase(s) === "rollback")).toContain(
      "/etc/caddy/.samohost-next-Caddyfile",
    );
    const saved = appStore.get(vm().id, "client-site")!;
    expect(saved.deployedSha).toBe(SHA);
    expect(saved.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);
  });

  test("deploy failure rolls project snapshot back without touching CP", async () => {
    const seeded = seedAppliedRoute();
    register(input({ mainHost: NEW_HOST }));
    const h = routingHarness();
    const deps: AppDeployDeps = {
      remote: async () => {
        h.events.push("deploy");
        return ok(
          "<<<SAMOHOST_PHASE:health:start>>>\n" +
            "<<<SAMOHOST_PHASE:health:fail>>>\n" +
            "<<<SAMOHOST_PHASE:rollback:ok>>>",
        );
      },
      resolveRef: async () => NEW_SHA,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
      }) as Response) as unknown as typeof fetch,
      now: () => new Date(),
      env: { GH_TOKEN: "test" },
      projectRoute: h.projectRoute,
      controlPlaneRoute: h.controlPlaneRoute,
    };
    const c = capture();
    expect(await runAppDeploy(
      { vm: vm().name, app: "client-site", sha: NEW_SHA, skipCiGate: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    )).toBe(1);
    expect(h.events).toEqual(["project:begin", "deploy", "project:rollback"]);
    expect(h.controlScripts).toHaveLength(0);
    const saved = appStore.get(vm().id, "client-site")!;
    expect(saved.deployedSha).toBe(SHA);
    expect(saved.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);
  });

  test("new-tag CI failure does not touch either route hop or deploy state", async () => {
    const releaseSpec = input({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    const seeded = seedAppliedRoute(releaseSpec);
    register({ ...releaseSpec, mainHost: NEW_HOST });
    let deployCalls = 0;
    let routeCalls = 0;
    const deps: TriggerDeps = {
      resolveRef: async () => NEW_SHA,
      resolveLatestTag: async () => ({ tag: "v20260714.1", sha: NEW_SHA }),
      isCommitOnBranch: async () => true,
      deploy: async () => { deployCalls++; return 0; },
      reconcileMainRoute: async () => {
        routeCalls++;
        return { ok: true, routing: "ready" };
      },
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "failure" }] }),
      }) as Response) as unknown as typeof fetch,
      env: { GH_TOKEN: "test" },
      now: () => new Date(),
    };
    appStore.upsert({
      ...appStore.get(vm().id, "client-site")!,
      releaseTagChannelInitialized: true,
      releaseTagCursor: "v20260713.1",
    });
    const c = capture();
    expect(await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    )).toBe(0);
    expect(JSON.parse(c.o).results[0]?.reason).toBe("ci-red");
    expect(deployCalls).toBe(0);
    expect(routeCalls).toBe(0);
    const saved = appStore.get(vm().id, "client-site")!;
    expect(saved.deployedSha).toBe(SHA);
    expect(saved.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);
    expect(saved.releaseTagCursor).toBe("v20260713.1");
  });
});
