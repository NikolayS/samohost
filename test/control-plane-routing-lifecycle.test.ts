import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAppRegister,
  type AppRegisterInput,
} from "../src/commands/app.ts";
import {
  buildControlPlaneMainRouteReconcileScript,
  controlPlaneMainRouteFingerprint,
} from "../src/caddy/control-plane.ts";
import {
  runTriggerRun,
  type TriggerDeps,
  type TriggerRunReport,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_HOST = "old-client.samo.team";
const NEW_HOST = "new-client.samo.team";

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

function input(
  overrides: Partial<AppRegisterInput> = {},
): AppRegisterInput {
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

describe("register -> same-SHA trigger routing lifecycle", () => {
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

  function seedAppliedRoute(): { id: string; fingerprint: string } {
    const original = register(input());
    const fingerprint = controlPlaneMainRouteFingerprint(original, vm());
    appStore.upsert({
      ...original,
      deployedSha: SHA,
      controlPlaneRouteFingerprint: fingerprint,
    });
    return { id: original.id, fingerprint };
  }

  async function trigger(
    reconcile: NonNullable<TriggerDeps["reconcileControlPlaneRoute"]>,
  ): Promise<{ code: number; report: TriggerRunReport; err: string }> {
    let deployCalls = 0;
    const deps: TriggerDeps = {
      resolveRef: async () => SHA,
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      reconcileControlPlaneRoute: reconcile,
      fetch: (async () => {
        throw new Error("same-SHA routing-only drift must not call CI");
      }) as unknown as typeof fetch,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
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

  test("host rename reconciles before same-SHA short-circuit and stamps success", async () => {
    const seeded = seedAppliedRoute();
    const changed = register(input({ mainHost: NEW_HOST }));
    expect(changed.id).toBe(seeded.id);
    expect(changed.deployedSha).toBe(SHA);
    expect(changed.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);

    let script = "";
    const result = await trigger(async (app, targetVm) => {
      script = buildControlPlaneMainRouteReconcileScript(app, targetVm);
      return { code: 0, stdout: "route ready", stderr: "" };
    });

    expect(result.code).toBe(0);
    expect(result.report.results[0]).toMatchObject({
      action: "up-to-date",
      reason: "routing-reconciled",
      sha: SHA,
    });
    expect(script).toContain(`${NEW_HOST} {`);
    expect(script).not.toContain(`${OLD_HOST} {`);
    const saved = appStore.get(vm().id, "client-site")!;
    expect(saved.controlPlaneRouteFingerprint).toBe(
      controlPlaneMainRouteFingerprint(saved, vm()),
    );
    expect(saved.controlPlaneRouteFingerprint).not.toBe(seeded.fingerprint);
  });

  for (const [label, overrides] of [
    ["cp-http80 -> tls", { mainListen: "tls" as const }],
    ["mainHost removal", { mainHost: undefined, mainListen: undefined }],
  ] as const) {
    test(`${label} removes the old managed route at the same SHA`, async () => {
      const seeded = seedAppliedRoute();
      const changed = register(input(overrides));
      expect(changed.controlPlaneRouteFingerprint).toBe(seeded.fingerprint);

      let script = "";
      const result = await trigger(async (app, targetVm) => {
        script = buildControlPlaneMainRouteReconcileScript(app, targetVm);
        return { code: 0, stdout: "route removed", stderr: "" };
      });

      expect(result.code).toBe(0);
      expect(result.report.results[0]?.reason).toBe("routing-reconciled");
      expect(script).toContain("No control-plane route is desired");
      expect(script).toContain('rm -f "$SNIPPET"');
      const saved = appStore.get(vm().id, "client-site")!;
      expect(saved.controlPlaneRouteFingerprint).toBe(
        controlPlaneMainRouteFingerprint(saved, vm()),
      );
    });
  }

  test("failed reconcile rolls config back and never advances the state stamp", async () => {
    const seeded = seedAppliedRoute();
    register(input({ mainHost: NEW_HOST }));
    let script = "";
    const result = await trigger(async (app, targetVm) => {
      script = buildControlPlaneMainRouteReconcileScript(app, targetVm);
      return { code: 1, stdout: "", stderr: "reload failed; prior route restored" };
    });

    expect(result.code).toBe(1);
    expect(result.report.results[0]?.action).toBe("error");
    expect(result.report.results[0]?.error).toContain("prior route restored");
    expect(script).toContain('mv -f "$BACKUP" "$SNIPPET"');
    expect(script).toContain("systemctl reload caddy");
    expect(
      appStore.get(vm().id, "client-site")?.controlPlaneRouteFingerprint,
    ).toBe(seeded.fingerprint);
  });
});
