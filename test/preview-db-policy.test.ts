import { describe, expect, test } from "bun:test";
import {
  assertStoredPreviewBackend,
  isDatabaseBackedApp,
  resolvePreviewDbBackend,
  validatePreviewEnvIsolation,
} from "../src/preview/db-policy.ts";
import type { AppSpec } from "../src/types.ts";

function app(overrides: Partial<AppSpec> = {}): AppSpec {
  return {
    name: "example",
    repo: "acme/example",
    branch: "main",
    appDir: "/opt/example/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "example",
    ...overrides,
  };
}

describe("preview database policy", () => {
  test("legacy database-backed apps default to DBLab", () => {
    expect(isDatabaseBackedApp(app())).toBe(true);
    expect(resolvePreviewDbBackend(app())).toBe("dblab");
  });

  test("database-backed apps reject explicit none", () => {
    expect(() =>
      resolvePreviewDbBackend(app({
        migrateCmd: "npm run migrate",
        previewDbBackend: "none",
      })),
    ).toThrow(/requires previewDbBackend='dblab'.*resolved 'none'/);
  });

  test("database-backed apps reject explicit template", () => {
    expect(() =>
      resolvePreviewDbBackend(app({ previewDbBackend: "template" })),
    ).toThrow(/requires previewDbBackend='dblab'.*resolved 'template'/);
  });

  test("manual none override cannot bypass a DBLab app policy", () => {
    expect(() =>
      resolvePreviewDbBackend(
        app({ previewDbBackend: "dblab", databaseUrlEnv: "DATABASE_URL" }),
        "none",
      ),
    ).toThrow(/resolved 'none'/);
  });

  test("explicit no-database node apps are exempt", () => {
    const noDb = app({ dbBackend: "none" });
    expect(isDatabaseBackedApp(noDb)).toBe(false);
    expect(resolvePreviewDbBackend(noDb)).toBe("none");
  });

  test("static apps are exempt and never allocate DBLab by default", () => {
    const staticApp = app({ kind: "static" });
    expect(isDatabaseBackedApp(staticApp)).toBe(false);
    expect(resolvePreviewDbBackend(staticApp)).toBe("none");
  });

  test("durable production DB plus DBLab previews is accepted", () => {
    expect(resolvePreviewDbBackend(app({
      dbBackend: "none",
      previewDbBackend: "dblab",
      migrateCmd: "npm run migrate",
      databaseUrlEnv: "DATABASE_URL",
    }))).toBe("dblab");
  });

  test("existing none/template records fail closed before redeploy", () => {
    const dbApp = app({ migrateCmd: "npm run migrate" });
    expect(() => assertStoredPreviewBackend(dbApp, "none")).toThrow(/destroy\/recreate.*DBLab/);
    expect(() => assertStoredPreviewBackend(dbApp, "template")).toThrow(/destroy\/recreate.*DBLab/);
    expect(() => assertStoredPreviewBackend(dbApp, "dblab")).not.toThrow();
  });

  test("production env templates require an explicit narrow preview allowlist", () => {
    const dbApp = app({
      envFile: "/opt/app/prod.env",
      envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"],
      databaseUrlEnv: "APP_DATABASE_URL",
    });
    expect(() => validatePreviewEnvIsolation(dbApp)).toThrow(/no previewEnvAllowlist/);
    expect(() => validatePreviewEnvIsolation({
      ...dbApp,
      previewEnvAllowlist: ["DATABASE_URL", "APP_DATABASE_URL", "NODE_ENV"],
    })).not.toThrow();
  });

  test("production signing secrets cannot be copied into previews", () => {
    expect(() => validatePreviewEnvIsolation(app({
      envFile: "/opt/app/prod.env",
      envDbVars: ["DATABASE_URL"],
      databaseUrlEnv: "DATABASE_URL",
      previewEnvAllowlist: ["DATABASE_URL", "SESSION_SECRET"],
      secrets: ["SESSION_SECRET"],
    }))).toThrow(/cannot be copied from production/);
  });

  test("databaseUrlEnv must participate in the all-URL clone rewiring set", () => {
    expect(() => validatePreviewEnvIsolation(app({
      envDbVars: ["DATABASE_URL"],
      databaseUrlEnv: "APP_DATABASE_URL",
    }))).toThrow(/APP_DATABASE_URL.*missing from envDbVars.*clone-rewired/);
  });
});
