import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildDeployScript } from "../src/app/script.ts";
import { buildStepScript } from "../src/app/build-steps.ts";
import type { AppRecord } from "../src/types.ts";

const TARGET = { sha: "abc1234def5678901234567890abcdef12345678" };

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "a",
    vmId: "v",
    name: "shop",
    repo: "x/y",
    branch: "main",
    appDir: "/opt/shop/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "shop",
    mainHost: "shop.example.com",
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("database backup rendering compatibility", () => {
  const cases: Array<[string, AppRecord, typeof TARGET & { tag?: string }, string]> = [
    ["static", app({ kind: "static" }), TARGET, "dc9b19da9feddd87312497289ff7e8d51938efafe385099122fc3e9b70e5c961"],
    ["static release channel", app({ kind: "static", releaseTagPattern: "v*", releaseTagFormat: "date", releaseCiWorkflow: ".github/workflows/ci.yml" }), { ...TARGET, tag: "v20261125.1" }, "b2b1f1331045ac37a7e297005d38c85606e67ec958fa2488e93bc95b13c7774c"],
    ["split node without migrate", app({ envFile: "/opt/shop/staging.env" }), TARGET, "a5455d35d26bb7e45c7e688d380d3104cba072630239c6440bd4735736e5f6ad"],
    ["split node without a database", app({ envFile: "/opt/shop/staging.env", migrateCmd: "npm run migrate", dbBackend: "none" }), TARGET, "d758b63e2e7b297b18500bb59feef68d91e27b1c82b2b6d0a41ad072b52edbf5"],
    ["legacy node with migrate", app({ migrateCmd: "npm run migrate" }), TARGET, "48a6240cf7b9dd2e05a24b412c85a0dcccffe9a85e47d7c58c7401df5f0b991d"],
  ];

  for (const [name, record, target, expected] of cases) {
    test(`${name} matches its pinned rendering`, () => {
      expect(sha256(buildDeployScript(record, target))).toBe(expected);
    });
  }

  test("split node without migrate has the 0a47e89 step script byte for byte", () => {
    expect(sha256(buildStepScript({
      appName: "shop",
      buildUser: "shop-build",
      runUser: "shop-run",
      appBase: "/opt/shop",
      checkoutDir: "/opt/shop/app",
      envFile: "/opt/shop/staging.env",
      migrateEnvFile: "/opt/shop/migrate.env",
      releaseEnvFile: "/opt/shop/release.env",
      database: "shop",
      tokenFile: "/opt/shop/.gh-token",
      gitSafeConf: "/opt/shop/git-safe.conf",
      buildCmd: "npm run build",
      includeBackup: false,
    }))).toBe("cd6e67eb158724007db8c441d7436dfdd905b92e6750f6560e7106728b6cdb39");
  });
});
