/**
 * Bootstrap of the build model (split layout only): the build user
 * <app>-build, its folders, the root-owned step script, no cron/at/linger
 * for the build user, a root-only migrate.env with APP_DATABASE_URL, the
 * service unit on /opt/<app>/current. The legacy layout is untouched.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildStepScript } from "../src/app/build-steps.ts";
import { dbSection, makeSandbox, nodeApp, nodeOpts, runSection, sandboxScript } from "./bootstrap-db-harness.ts";

function section(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`# §${from}.`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith(`# §${to}.`));
  expect(start, `§${from}`).toBeGreaterThan(0);
  expect(end, `§${to}`).toBeGreaterThan(start);
  return lines.slice(start, end - 1).join("\n");
}

function run5d(layout: "split" | "legacy", opts: { hardlinks?: string; userExists?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-5d-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("id", opts.userExists ? "exit 0" : "exit 1");
  for (const name of ["useradd", "usermod", "gpasswd", "loginctl", "chown", "chmod"]) stub(name, "exit 0");
  stub("install", 'if [[ "$1" == -d ]]; then mkdir -p "${@: -1}"; fi');
  stub("systemd-run", "exit 0");
  stub("mv", 'a=(); for x in "$@"; do case "$x" in -fT|-T|-f|--) ;; *) a+=("$x");; esac; done; /bin/mv -f "${a[0]}" "${a[1]}"');
  const base = join(dir, "opt-shop");
  mkdirSync(base);
  const etc = join(dir, "etc");
  mkdirSync(etc);
  writeFileSync(join(dir, "protected_hardlinks"), `${opts.hardlinks ?? "1"}\n`);
  const lib = join(dir, "usr-local-lib-samohost");
  const replace = (t: string) =>
    t
      .replaceAll("/opt/shop", base)
      .replaceAll("/usr/local/lib/samohost", lib)
      .replaceAll("/etc/cron.deny", join(etc, "cron.deny"))
      .replaceAll("/etc/at.deny", join(etc, "at.deny"))
      .replaceAll("/proc/sys/fs/protected_hardlinks", join(dir, "protected_hardlinks"));
  const body = replace(section(buildHostBootstrapScript(nodeApp(), nodeOpts()), "5d", "6"));
  const runOnce = () =>
    spawnSync("bash", ["-c", `set -euo pipefail\nSAMOHOST_DB_LAYOUT=${layout}\n${body}`], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
  return {
    dir, base, etc, lib, runOnce, replace,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("§5d build user and step script", () => {
  test("split layout: build user without login, home or other groups; no cron, at or lingering", () => {
    const r = run5d("split");
    try {
      const res = r.runOnce();
      expect(res.status, res.stderr).toBe(0);
      expect(r.runOnce().status).toBe(0);
      const calls = r.calls();
      expect(calls).toContain(
        "useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin shop-build",
      );
      expect(calls).toContain("usermod --shell /usr/sbin/nologin shop-build");
      expect(calls).toContain("gpasswd -d shop-build shop");
      expect(calls).toContain("loginctl disable-linger shop-build");
      for (const f of ["cron.deny", "at.deny"]) {
        expect(readFileSync(join(r.etc, f), "utf8").split("\n").filter((l) => l === "shop-build").length, f).toBe(1);
      }
    } finally {
      r.cleanup();
    }
  });

  test("split layout: build folders for the build user, releases for root and the runtime group", () => {
    const r = run5d("split");
    try {
      expect(r.runOnce().status).toBe(0);
      const calls = r.calls();
      expect(calls).toContain(`install -d -m 700 -o shop-build -g shop-build ${r.base}/build`);
      expect(calls).toContain(`install -d -m 700 -o shop-build -g shop-build ${r.base}/build-cache`);
      expect(calls).toContain(`install -d -m 750 -o root -g shop-run ${r.base}/releases`);
    } finally {
      r.cleanup();
    }
  });

  test("split layout: the step script is written root-owned with the rendered content", () => {
    const r = run5d("split");
    try {
      expect(r.runOnce().status).toBe(0);
      const app = nodeApp();
      const expected = buildStepScript({
        appName: "shop", buildUser: "shop-build", runUser: "shop-run", appBase: "/opt/shop", checkoutDir: app.appDir,
        envFile: app.envFile!, migrateEnvFile: "/opt/shop/migrate.env", releaseEnvFile: "/opt/shop/release.env",
        tokenFile: "/opt/shop/.gh-token", gitSafeConf: "/opt/shop/git-safe.conf", buildCmd: app.buildCmd,
        ...(app.migrateCmd !== undefined ? { migrateCmd: app.migrateCmd } : {}),
      });
      expect(readFileSync(join(r.lib, "apps", "shop", "step"), "utf8")).toBe(r.replace(expected));
      expect(r.calls()).toContain(`chown root:root ${r.lib}/apps/shop/step.next`);
      expect(r.calls()).toContain(`chmod 755 ${r.lib}/apps/shop/step.next`);
    } finally {
      r.cleanup();
    }
  });

  test("split layout: fs.protected_hardlinks not 1 stops bootstrap", () => {
    const r = run5d("split", { hardlinks: "0" });
    try {
      const res = r.runOnce();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("protected_hardlinks");
    } finally {
      r.cleanup();
    }
  });

  test("an app name whose build user would be longer than 32 characters: the new layout is refused", () => {
    const name = "a".repeat(28); // a...a-run has 32 characters, a...a-build 34
    const text = buildHostBootstrapScript(
      nodeApp({ name, serviceUnit: name, appDir: `/opt/${name}/app`, envFile: `/opt/${name}/staging.env` }),
      nodeOpts({ appUser: "shop" }),
    );
    const body = section(text, "5d", "6");
    expect(body).toContain('if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then');
    expect(body).toContain(`ERROR: the build user name ${name}-build is not a valid user name`);
    expect(body).not.toContain("SAMOHOST_STEP_SCRIPT");
  });

  test("legacy layout: nothing", () => {
    const r = run5d("legacy");
    try {
      expect(r.runOnce().status).toBe(0);
      expect(r.calls()).toBe("");
    } finally {
      r.cleanup();
    }
  });
});

describe("§11 migrate.env in the build model", () => {
  test("an app without a usable runtime user keeps migrate.env owned by the deploy user (the deploy reads it)", () => {
    const name = "b".repeat(29); // b...b-run has 33 characters
    const text = buildHostBootstrapScript(
      nodeApp({ name, serviceUnit: name, appDir: `/opt/${name}/app`, envFile: `/opt/${name}/staging.env` }),
      nodeOpts({ appUser: "shop" }),
    );
    expect(text).toContain(`chown 'shop':'shop' "$SAMOHOST_WRITE_DIR/migrate"`);
    expect(text).not.toContain('chown root:root "$SAMOHOST_WRITE_DIR/migrate"');
  });

  test("has APP_DATABASE_URL next to the owner role's DATABASE_URL, and is written for root only", () => {
    const sb = makeSandbox();
    try {
      const script = sandboxScript(join(sb.dir, "staging.env"));
      expect(dbSection(script)).toContain('chown root:root "$SAMOHOST_WRITE_DIR/migrate"');
      const res = runSection(sb, dbSection(script));
      expect(res.status, res.stderr).toBe(0);
      const migrate = readFileSync(join(sb.dir, "migrate.env"), "utf8");
      expect(migrate).toMatch(/^APP_DATABASE_URL=postgresql:\/\/shop_app:[0-9a-f]+@127\.0\.0\.1:5432\/shop$/m);
      expect(migrate).toMatch(/^DATABASE_URL=postgresql:\/\/shop_owner:/m);
    } finally {
      sb.cleanup();
    }
  });
});
