/**
 * New layout: /opt/<app> is root-owned, so the deploy user cannot create,
 * rename or replace entries next to the files root writes and systemd reads
 * (env files, migrate.env, release.env, git-safe.conf, the token file). The
 * deploy user owns the checkout only and writes release.env through an exact
 * sudo tee rule. The legacy layout keeps today's §5 lines.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildDeployScript } from "../src/app/script.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const OLD_LINES = [
  "install -d -m 755 -o 'shop' -g 'shop' '/opt/shop'",
  "install -d -m 755 -o 'shop' -g 'shop' '/opt/shop/uploads'",
  "install -d -m 755 -o 'shop' -g 'shop' '/opt/shop/app'",
];

function section5(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §5."));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# §5c."));
  return lines.slice(start, end - 1).join("\n");
}

/** Run §5 with /opt/shop moved into a sandbox and install/chown/chmod stubbed. */
function runSection5(layout: "split" | "legacy", prepare: (base: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-base-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "argv.log");
  for (const name of ["install", "chown", "chmod"]) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const base = join(dir, "opt-shop");
  mkdirSync(base);
  prepare(base);
  const text = section5(buildHostBootstrapScript(nodeApp(), nodeOpts())).replaceAll("/opt/shop", base);
  const res = spawnSync("bash", ["-c", `set -euo pipefail\nSAMOHOST_DB_LAYOUT=${layout}\n${text}`], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { base, res, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("§5 directory layout", () => {
  test("rendered: the env layout is decided (§3b) before §4 and §5", () => {
    const text = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(text.indexOf("# §3b.")).toBeGreaterThan(0);
    expect(text.indexOf("# §3b.")).toBeLessThan(text.indexOf("# §4."));
    expect(text.indexOf("SAMOHOST_DB_LAYOUT=split")).toBeLessThan(text.indexOf("# §5."));
  });

  test("split layout: appBase becomes root-owned before the deploy user's folders are made", () => {
    const r = runSection5("split");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.calls).toEqual([
        `install -d -m 755 -o root -g root ${r.base}`,
        `chown -h root:root ${r.base}`,
        `chmod 755 ${r.base}`,
        `install -d -m 755 -o shop -g shop ${r.base}/uploads`,
        `install -d -m 755 -o shop -g shop ${r.base}/app`,
      ]);
    } finally {
      r.cleanup();
    }
  });

  for (const name of ["uploads", "app", ".gh-token", "git-safe.conf"]) {
    test(`split layout: a symbolic link at ${name} stops bootstrap before root follows it`, () => {
      const r = runSection5("split", (base) => symlinkSync("/etc", join(base, name)));
      try {
        expect(r.res.status).toBe(1);
        expect(r.res.stderr).toContain("is a symbolic link");
        expect(r.calls.some((c) => c.includes(`${r.base}/uploads`) || c.includes(`${r.base}/app`))).toBe(false);
      } finally {
        r.cleanup();
      }
    });
  }

  test("split layout: a symbolic link at release.env is removed", () => {
    const r = runSection5("split", (base) => symlinkSync("/etc/passwd", join(base, "release.env")));
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(existsSync(join(r.base, "release.env"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("legacy layout: today's three install lines, nothing else", () => {
    const r = runSection5("legacy");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.calls).toEqual(OLD_LINES.map((l) => l.replaceAll("'", "").replaceAll("/opt/shop", r.base)));
    } finally {
      r.cleanup();
    }
  });
});

describe("deploy: release.env in the root-owned directory", () => {
  const SHA = "5555555555555555555555555555555555555555";
  function setup(healthCode = "200", previous?: string) {
    const sb = makeDeploySandbox({ healthCode });
    writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:0a0b@127.0.0.1:5432/shop\n");
    writeFileSync(sb.migrateEnvFile, "DATABASE_URL=postgresql://shop_owner:0c0d@127.0.0.1:5432/shop\n");
    if (previous !== undefined) writeFileSync(join(sb.dir, "release.env"), previous);
    mkdirSync(join(sb.appDir, "dist"));
    return sb;
  }

  test("split layout: written through sudo /usr/bin/tee, not a temporary file in the directory", () => {
    const sb = setup();
    try {
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA, tag: "v20261122.3" }));
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(sb.sudoLog, "utf8")).toContain(`/usr/bin/tee ${join(sb.dir, "release.env")}`);
      expect(readFileSync(join(sb.dir, "release.env"), "utf8")).toBe(`SAMO_RELEASE_TAG=v20261122.3\nSAMO_RELEASE_SHA=${SHA}\n`);
    } finally {
      sb.cleanup();
    }
  });

  test("split layout: rollback writes the previous content back through sudo tee", () => {
    const previous = "SAMO_RELEASE_TAG=v20261121.1\nSAMO_RELEASE_SHA=1111111\n";
    const sb = setup("500", previous);
    try {
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA }));
      expect(res.status).toBe(1);
      expect(readFileSync(join(sb.dir, "release.env"), "utf8")).toBe(previous);
      const tees = readFileSync(sb.sudoLog, "utf8").split("\n").filter((l) => l.startsWith("/usr/bin/tee "));
      expect(tees.length).toBe(2);
    } finally {
      sb.cleanup();
    }
  });
});
