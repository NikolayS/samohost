import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildDeployScript } from "../src/app/script.ts";
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
    ["split node without a database", app({ envFile: "/opt/shop/staging.env", migrateCmd: "npm run migrate", dbBackend: "none" }), TARGET, "bee7a479710fbfad7827691679c333a20c37dbedfc39b5e579a947dc9c814aa4"],
    ["legacy node with migrate", app({ migrateCmd: "npm run migrate" }), TARGET, "48a6240cf7b9dd2e05a24b412c85a0dcccffe9a85e47d7c58c7401df5f0b991d"],
  ];

  for (const [name, record, target, expected] of cases) {
    test(`${name} stays byte-for-byte equal to the pinned 0a47e89 rendering`, () => {
      expect(sha256(buildDeployScript(record, target))).toBe(expected);
    });
  }
});
