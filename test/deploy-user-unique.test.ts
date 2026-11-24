/**
 * The new layout relies on the deploy user having only the sudo rules that
 * bootstrap writes to /etc/sudoers.d/<app>-agent. Bootstrap stops in the new
 * layout when another file in /etc/sudoers.d names that user (as the user of
 * a rule, in Defaults:<user>, in a user alias, or as %<user>), and the
 * message names the file. A path that only contains the name does not count.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function run3b(layout: "split" | "legacy", files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-sudoers-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const lines = buildHostBootstrapScript(nodeApp(), nodeOpts()).split("\n");
    const start = lines.findIndex((l) => l.startsWith("# §3b."));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("# §4."));
    const body = lines
      .slice(start, end - 1)
      .join("\n")
      .replace(/^(\s*)SAMOHOST_DB_LAYOUT=\w+$/gm, `$1SAMOHOST_DB_LAYOUT=${layout}`)
      .replaceAll("/etc/sudoers.d/", `${dir}/`);
    const res = spawnSync("bash", ["-c", `set -euo pipefail\n${body}\necho PASSED`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    return { dir, res };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OWN = { "shop-agent": "shop ALL=(root) NOPASSWD: /usr/bin/systemctl restart shop\n" };

describe("new layout: no other sudo rules for the deploy user", () => {
  test("only bootstrap's own file names the user: continues", () => {
    const { res } = run3b("split", OWN);
    expect(res.status, res.stderr).toBe(0);
  });

  for (const [what, body] of [
    ["a rule for the user", "shop ALL=(ALL) NOPASSWD: ALL\n"],
    ["Defaults for the user", "Defaults:shop !requiretty\n"],
    ["a user alias with the user", "User_Alias DEPLOY = agent, shop\nDEPLOY ALL=(root) /usr/bin/true\n"],
    ["a rule for the user's group", "%shop ALL=(root) /usr/bin/true\n"],
  ] as const) {
    test(`another file with ${what}: stops and names the file`, () => {
      const { dir, res } = run3b("split", { ...OWN, "90-extra": body });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${dir}/90-extra`);
    });
  }

  test("other users' rules, paths that contain the name, comments: continue", () => {
    const { res } = run3b("split", {
      ...OWN,
      "other-agent": "agent ALL=(root) NOPASSWD: /usr/bin/tee /opt/shop/release.env\n# shop used to be here\n",
      "shop-run-x": "shop-run ALL=(root) /usr/bin/true\n",
    });
    expect(res.status, res.stderr).toBe(0);
  });

  test("legacy layout: not checked", () => {
    const { res } = run3b("legacy", { ...OWN, "90-extra": "shop ALL=(ALL) NOPASSWD: ALL\n" });
    expect(res.status, res.stderr).toBe(0);
  });
});
