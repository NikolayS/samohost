/**
 * New layout: §5 makes /opt/<app> root-owned, and migrate.env and
 * release.env sit next to the env file. So the env file must be directly in
 * /opt/<app>/ (not in the checkout, not elsewhere), and the checkout must be
 * a folder directly in /opt/<app>/. Bootstrap refuses other paths when it
 * finds the new layout. The legacy layout keeps today's behaviour.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function section4b(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §4b."));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# §5."));
  return lines.slice(start, end - 1).join("\n");
}

/** Run §4b on this Mac with the layout forced through the marker check. */
function run4b(text: string, layout: "split" | "legacy") {
  const body = section4b(text).replace(/^(\s*)SAMOHOST_DB_LAYOUT=\w+$/gm, `$1SAMOHOST_DB_LAYOUT=${layout}`);
  return spawnSync("bash", ["-c", `set -euo pipefail\n${body}\necho "LAYOUT=$SAMOHOST_DB_LAYOUT"`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
}

const REFUSED: Array<[string, { envFile?: string; appDir?: string }]> = [
  ["env file inside the checkout", { envFile: "/opt/shop/app/.env" }],
  ["env file outside /opt/<app>", { envFile: "/etc/shop/staging.env" }],
  ["env file in another app's folder", { envFile: "/opt/shopx/staging.env" }],
  ["env file named like the uploads folder", { envFile: "/opt/shop/uploads" }],
  ["env file named like the token file", { envFile: "/opt/shop/.gh-token" }],
  ["env file named like the checkout", { envFile: "/opt/shop/app" }],
  ["env file path with ..", { envFile: "/opt/shop/../shop/staging.env" }],
  ["checkout at /opt/<app> itself", { appDir: "/opt/shop" }],
  ["checkout outside /opt/<app>", { appDir: "/srv/shop/app" }],
  ["checkout named like the uploads folder", { appDir: "/opt/shop/uploads" }],
];

describe("new layout: env file and checkout paths", () => {
  test("default paths: no refusal lines, and §4b passes in both layouts", () => {
    const text = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(text).not.toContain("the new layout needs");
    expect(run4b(text, "split").status).toBe(0);
  });

  test("an env file with another name directly in /opt/<app> is accepted", () => {
    const text = buildHostBootstrapScript(nodeApp({ envFile: "/opt/shop/.env" }), nodeOpts());
    expect(text).not.toContain("the new layout needs");
  });

  for (const [what, change] of REFUSED) {
    test(`refused in the new layout: ${what}; the legacy layout continues`, () => {
      const text = buildHostBootstrapScript(nodeApp(change), nodeOpts());
      const split = run4b(text, "split");
      expect(split.status).toBe(1);
      expect(split.stderr).toContain("the new layout needs");
      const legacy = run4b(text, "legacy");
      expect(legacy.status, legacy.stderr).toBe(0);
      expect(legacy.stdout).toContain("LAYOUT=legacy");
    });
  }
});
