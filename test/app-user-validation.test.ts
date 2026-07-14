import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { parseArgs } from "../src/cli.ts";
import { runAppRegister } from "../src/commands/app.ts";
import { buildEnvCreateScript, buildHostPrepScript } from "../src/env/script.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1",
    name: "friends-site",
    kind: "static",
    repo: "NikolayS/friends-of-twin-peaks",
    branch: "main",
    appDir: "/opt/friends-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://friends.example.com/",
    serviceUnit: "friends-site",
    mainHost: "friends.example.com",
    ...overrides,
  };
}

function vm(): VmRecord {
  return {
    id: "vm-1",
    provider: "hetzner",
    providerId: "1",
    name: "shared-client-vm",
    ip: "192.0.2.10",
    sshKeyPath: "/tmp/test-key",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    region: "fsn1",
    type: "cx22",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function manifest(appUser: string): string {
  return [
    'name = "friends-site"',
    'kind = "static"',
    'repo = "NikolayS/friends-of-twin-peaks"',
    'branch = "main"',
    'appDir = "/opt/friends-site/app"',
    'buildCmd = "npm run build"',
    'healthUrl = "https://friends.example.com/"',
    'serviceUnit = "friends-site"',
    `appUser = ${JSON.stringify(appUser)}`,
    'dbBackend = "none"',
    "",
  ].join("\n");
}

const INVALID_USERS = [
  "",
  "root",
  "postgres",
  "caddy",
  "sshd",
  "nobody",
  "-agent",
  "Agent",
  "agent user",
  "agent\nroot ALL=(ALL) NOPASSWD: ALL",
  "agent;id",
  "agent$",
  "a".repeat(33),
];

describe("strict Linux appUser validation", () => {
  test("valid client service users remain accepted at every render boundary", () => {
    for (const appUser of ["friends-site", "gregg-site", "agent_1", "_service"]) {
      expect(() =>
        buildHostBootstrapScript(app(), { appUser })
      ).not.toThrow();
      expect(() =>
        buildEnvCreateScript(app({ appUser }), {
          name: "friends-site-main",
          branch: "main",
          port: 3100,
          vhost: "friends-site-main.samo.cat",
          dbBackend: "none",
        })
      ).not.toThrow();
      expect(() => buildHostPrepScript(app({ appUser }), "samo")).not.toThrow();
      expect(parseSamohostToml(manifest(appUser)).ok).toBe(true);
    }
  });

  test("CLI bootstrap rejects invalid app users before command construction", () => {
    for (const appUser of INVALID_USERS) {
      expect(() =>
        parseArgs([
          "app",
          "bootstrap",
          "shared-client-vm",
          "friends-site",
          "--app-user",
          appUser,
        ])
      ).toThrow(/app-user|Linux user/i);
    }
  });

  test("programmatic register rejects invalid app users without persistence", () => {
    for (const appUser of INVALID_USERS) {
      const dir = mkdtempSync(join(tmpdir(), "samohost-app-user-register-"));
      try {
        const vmStore = new StateStore(join(dir, "state.json"));
        const appStore = new AppStore(join(dir, "apps.json"));
        vmStore.upsert(vm());
        let stderr = "";
        const code = runAppRegister({
          vm: "shared-client-vm",
          name: "friends-site",
          kind: "static",
          repo: "NikolayS/friends-of-twin-peaks",
          branch: "main",
          appDir: "/opt/friends-site/app",
          buildCmd: "npm run build",
          serviceUnit: "friends-site",
          healthUrl: "https://friends.example.com/",
          rlsNonSuperuser: false,
          dbBackend: "none",
          appUser,
        }, { json: false }, vmStore, appStore, () => {}, (line) => {
          stderr += `${line}\n`;
        });
        expect(code).toBe(1);
        expect(stderr).toMatch(/appUser|Linux user/i);
        expect(appStore.list()).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("manifest validation collects an appUser error", () => {
    for (const appUser of INVALID_USERS) {
      const result = parseSamohostToml(manifest(appUser));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/appUser|Linux user/i);
    }
  });

  test("AppStore rejects unsafe appUser on write and persisted-record load", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-app-user-store-"));
    try {
      const path = join(dir, "apps.json");
      const store = new AppStore(path);
      expect(() => store.upsert(app({ appUser: "agent\nroot ALL=(ALL) NOPASSWD: ALL" })))
        .toThrow(/appUser|Linux user/i);

      writeFileSync(path, JSON.stringify({
        version: 1,
        apps: [app({ appUser: "root" })],
      }));
      expect(() => store.list()).toThrow(/corrupt|appUser|Linux user/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("privileged script renderers reject injected persisted values", () => {
    for (const appUser of INVALID_USERS) {
      expect(() => buildHostBootstrapScript(app(), { appUser })).toThrow(
        /appUser|Linux user/i,
      );
      expect(() =>
        buildEnvCreateScript(app({ appUser }), {
          name: "friends-site-main",
          branch: "main",
          port: 3100,
          vhost: "friends-site-main.samo.cat",
          dbBackend: "none",
        })
      ).toThrow(/appUser|Linux user/i);
      expect(() => buildHostPrepScript(app({ appUser }), "samo")).toThrow(
        /appUser|Linux user/i,
      );
    }
  });
});
