import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import { buildControlPlaneMainRouteReconcileScript } from "../src/caddy/control-plane.ts";
import { buildProjectMainRouteBeginScript } from "../src/caddy/project-main.ts";
import { runAppRegister, type AppRegisterInput } from "../src/commands/app.ts";
import { buildHostPrepScript } from "../src/env/script.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

const SHA = "a".repeat(40);

function vm(): VmRecord {
  return {
    id: "vm-safe-1",
    provider: "hetzner",
    providerId: "123",
    name: "safe-vm",
    ip: "192.0.2.10",
    sshKeyPath: "/tmp/key",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-safe-1",
    vmId: vm().id,
    name: "safe-app",
    repo: "example/safe-app",
    branch: "main",
    appDir: "/opt/safe-app/app",
    buildCmd: "npm run build",
    healthUrl: "http://127.0.0.1:3000/health",
    serviceUnit: "safe-app",
    mainHost: "safe-app.samo.team",
    mainListen: "cp-http80",
    ...overrides,
  };
}

const MANIFEST = `
name = "safe-app"
repo = "example/safe-app"
branch = "main"
appDir = "/opt/safe-app/app"
buildCmd = "npm run build"
healthUrl = "http://127.0.0.1:3000/health"
serviceUnit = "safe-app"
`;

describe("app identity injection boundaries", () => {
  test.each([
    ["newline/Caddy", "safe\\nattacker.example { respond \\\"owned\\\" 200 }"],
    ["shell substitution", "safe$(touch /tmp/owned)"],
    ["shell separator", "safe;touch-owned"],
  ])("manifest rejects %s payload", (_label, encoded) => {
    const result = parseSamohostToml(
      MANIFEST.replace('name = "safe-app"', `name = "${encoded}"`),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("field name must be");
  });

  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-app-identity-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.each([
    "safe\nattacker.example { respond \"owned\" 200 }",
    "safe$(touch-owned)",
    "safe;touch-owned",
  ])("programmatic register rejects payload %p without persistence", (name) => {
    const input: AppRegisterInput = {
      vm: vm().name,
      name,
      repo: "example/safe-app",
      branch: "main",
      appDir: "/opt/safe-app/app",
      buildCmd: "npm run build",
      healthUrl: "http://127.0.0.1:3000/health",
      serviceUnit: "safe-app",
      rlsNonSuperuser: false,
    };
    let stderr = "";
    expect(runAppRegister(
      input,
      { json: false },
      vmStore,
      appStore,
      () => {},
      (s) => { stderr += s; },
    )).toBe(1);
    expect(stderr).toContain("invalid app name");
    expect(appStore.list()).toHaveLength(0);
  });

  test("routing and shell builders reject hand-edited unsafe name/id state", () => {
    const badName = app({ name: "safe\nmalicious.example { abort }" });
    const badId = app({ id: "id\n$(touch-owned)" });
    for (const bad of [badName, badId]) {
      expect(() => buildControlPlaneMainRouteReconcileScript(bad, vm())).toThrow(
        /invalid app (name|id)/,
      );
      expect(() => buildProjectMainRouteBeginScript(bad, "f".repeat(64))).toThrow(
        /invalid app (name|id)/,
      );
      expect(() => buildDeployScript(bad, { sha: SHA })).toThrow(
        /invalid app (name|id)/,
      );
      expect(() => buildHostPrepScript(bad, "samo")).toThrow(
        /invalid app (name|id)/,
      );
    }
  });

  test("generated control-plane comments never interpolate raw app identity", () => {
    const script = buildControlPlaneMainRouteReconcileScript(app(), vm());
    expect(script).not.toContain("app-safe-1");
    expect(script).not.toContain("reconcile: safe-app");
    expect(script).toContain("stable route identity is encoded in the filename");
  });
});
