/**
 * The root-owned step script of a new-layout node app: install, build,
 * migrate and seed run as <app>-build in a hardened transient systemd
 * service; release makes a root-owned copy of the build for <app>-run and
 * switches the `current` link; rollback switches it back.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStepScript, buildStepScriptPath, type BuildStepParams } from "../src/app/build-steps.ts";

const PARAMS: BuildStepParams = {
  appName: "shop",
  buildUser: "shop-build",
  runUser: "shop-run",
  appBase: "/opt/shop",
  checkoutDir: "/opt/shop/app",
  envFile: "/opt/shop/staging.env",
  migrateEnvFile: "/opt/shop/migrate.env",
  releaseEnvFile: "/opt/shop/release.env",
  tokenFile: "/opt/shop/.gh-token",
  gitSafeConf: "/opt/shop/git-safe.conf",
  buildCmd: "npm run build",
  migrateCmd: "npm run migrate",
};

function stub(bin: string, name: string, body: string, log: string) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A sandbox /opt/shop with stubs; `step(name)` runs the script there. */
function sandbox(params: Partial<BuildStepParams> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-steps-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const base = join(dir, "opt-shop");
  for (const d of ["app/.git", "app/src", "build", "build-cache", "releases"]) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, "app", "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(base, "app", "package-lock.json"), "{}\n");
  writeFileSync(join(base, "app", ".npmrc"), "//registry/:_authToken=x\n");
  writeFileSync(join(base, "app", "src", "server.ts"), "// app\n");
  writeFileSync(join(base, "app", ".git", "config"), "[core]\n");
  writeFileSync(join(dir, "protected_hardlinks"), "1\n");
  // systemd-run: log the arguments, then run the command after `/bin/bash -c`
  // in --working-directory with the -E variables (PATH kept for the stubs).
  stub(bin, "systemd-run", [
    'wd=""; envs=(); cmd=""',
    'while [[ $# -gt 0 ]]; do case "$1" in',
    '  --working-directory=*) wd="${1#*=}"; shift;;',
    '  -E) envs+=("$2"); shift 2;;',
    '  -p) shift 2;;',
    '  /bin/bash) cmd="$3"; break;;',
    '  *) shift;;',
    'esac; done',
    'cd "$wd" && env "${envs[@]}" PATH="$PATH" bash -c "$cmd"',
  ].join("\n"), log);
  stub(bin, "npm", 'if [[ "$1" == run && "$2" == build ]]; then mkdir -p dist && echo built > dist/server.js; fi', log);
  stub(bin, "pkill", "exit 1", log);
  stub(bin, "chown", "exit 0", log);
  // flock: held when <dir>/locked exists.
  stub(bin, "flock", `if [[ -e ${JSON.stringify(join(dir, "locked"))} ]]; then exit 1; fi`, log);
  // systemctl is-active <unit>: the content of <dir>/state-<unit>, else inactive.
  stub(bin, "systemctl", `f=${JSON.stringify(dir)}/state-$2; if [[ -f "$f" ]]; then cat "$f"; [[ "$(cat "$f")" == active ]] && exit 0; exit 3; fi; echo inactive; exit 3`, log);
  // GNU cp options on macOS: drop --preserve=timestamps and --, copy with -RP.
  stub(bin, "cp", 'a=(); for x in "$@"; do case "$x" in -R|-P|--preserve=timestamps|--) ;; *) a+=("$x");; esac; done\n/bin/cp -RP "${a[@]}"', log);
  // mv -T on macOS: replace the destination entry, then rename.
  stub(bin, "mv", 'args=(); t=0; for a in "$@"; do case "$a" in -fT|-T) t=1;; -f|--) ;; *) args+=("$a");; esac; done\nif [[ $t == 1 ]]; then rm -f "${args[1]}" 2>/dev/null || rmdir "${args[1]}" 2>/dev/null || true; fi\n/bin/mv -f "${args[0]}" "${args[1]}"', log);
  const text = buildStepScript({ ...PARAMS, ...params })
    .replaceAll("/opt/shop", base)
    .replace("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", `export PATH=${bin}:/usr/bin:/bin`)
    .replace("/proc/sys/fs/protected_hardlinks", join(dir, "protected_hardlinks"))
    .replaceAll("/run/samohost", join(dir, "run-samohost"));
  const script = join(dir, "step");
  writeFileSync(script, text);
  chmodSync(script, 0o755);
  const step = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { dir, base, step, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("step script: rendered", () => {
  const text = buildStepScript(PARAMS);
  test("lives at a root-owned path per app", () => {
    expect(buildStepScriptPath("shop")).toBe("/usr/local/lib/samohost/apps/shop/step");
  });

  test("build steps run as the build user in a hardened transient service with limits", () => {
    for (const line of [
      "--uid=\"$BUILD_USER\" --gid=\"$BUILD_USER\"",
      "-p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes",
      "-p ProtectControlGroups=yes -p ProtectProc=invisible -p RestrictSUIDSGID=yes",
      '-p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK" -p CapabilityBoundingSet=',
      '-p LockPersonality=yes -p MemoryMax=75% -p TasksMax=1024 -p "RuntimeMaxSec=$2"',
      '-p KillMode=control-group -p "InaccessiblePaths=$HIDDEN"',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain(
      "HIDDEN='-/opt/shop/staging.env -/opt/shop/migrate.env -/opt/shop/.gh-token -/opt/shop/git-safe.conf -/opt/shop/app/.git -/opt/shop/releases'",
    );
  });

  test("install and build may write build/ and build-cache/ only; migrate and seed nothing but /tmp, with migrate.env", () => {
    expect(text).toContain('samohost_build_unit install 1800 "$BUILD_DIR $CACHE_DIR" "" "$CACHE_DIR" "$INSTALL_CMD"');
    expect(text).toContain('samohost_build_unit build 1800 "$BUILD_DIR $CACHE_DIR" "" "$CACHE_DIR" "$BUILD_CMD"');
    expect(text).toContain('samohost_build_unit "$1" 900 "" "$MIGRATE_ENV" "" "$cmd"');
  });

  test("commands are fixed in the script", () => {
    expect(text).toContain("BUILD_CMD='npm run build'");
    expect(text).toContain("MIGRATE_CMD='npm run migrate'");
    expect(text).toContain("SEED_CMD=''");
  });
});

describe("step script: executed", () => {
  test("wrong arguments: usage and exit 2", () => {
    const s = sandbox();
    try {
      expect(s.step().status).toBe(2);
      expect(s.step("install", "x").status).toBe(2);
      expect(s.step("deploy").status).toBe(2);
    } finally {
      s.cleanup();
    }
  });

  test("install copies the checkout without .git into build/ and runs npm ci there; build writes dist/", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "build", "stale.txt"), "old\n");
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      const files = readdirSync(join(s.base, "build")).sort();
      expect(files).toEqual([".npmrc", "dist", "package-lock.json", "package.json", "src"]);
      expect(s.calls()).toContain("npm ci --include=dev");
      expect(s.calls()).toContain("npm run build");
      expect(s.calls()).toMatch(/systemd-run .*--unit=samohost-shop-install --uid=shop-build --gid=shop-build/);
      // Release identity: the build reads SAMO_RELEASE_TAG and SAMO_RELEASE_SHA from release.env.
      const buildLine = s.calls().split("\n").find((l) => l.includes("--unit=samohost-shop-build"))!;
      expect(buildLine).toContain(`EnvironmentFile=-${s.base}/release.env`);
    } finally {
      s.cleanup();
    }
  });

  test("install and build: HOME is the private /tmp; only the npm cache folder persists between deploys", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      for (const unit of ["install", "build"]) {
        const line = s.calls().split("\n").find((l) => l.includes(`--unit=samohost-shop-${unit}`))!;
        expect(line, unit).toContain("-E HOME=/tmp");
        expect(line, unit).toContain(`-E npm_config_cache=${s.base}/build-cache`);
      }
    } finally {
      s.cleanup();
    }
  });

  test("install: root empties build/ after killing build-user processes, before the build user runs", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "build", "stale.txt"), "old\n");
      expect(s.step("install").status).toBe(0);
      const calls = s.calls().split("\n");
      const kill = calls.findIndex((l) => l === "pkill -KILL -u shop-build");
      const unit = calls.findIndex((l) => l.includes("--unit=samohost-shop-install"));
      expect(kill).toBeGreaterThanOrEqual(0);
      expect(kill).toBeLessThan(unit);
      expect(existsSync(join(s.base, "build", "stale.txt"))).toBe(false);
      expect(buildStepScript(PARAMS)).not.toMatch(/INSTALL_CMD=.*rm -rf/);
    } finally {
      s.cleanup();
    }
  });

  test("release copies without ACLs, extended attributes or owners (cp -R -P --preserve=timestamps)", () => {
    const s = sandbox();
    try {
      expect(s.step("release").status).toBe(0);
      expect(s.calls()).toMatch(/^cp -R -P --preserve=timestamps -- /m);
      expect(buildStepScript(PARAMS)).not.toContain("cp -a");
    } finally {
      s.cleanup();
    }
  });

  test("migrate gets migrate.env through EnvironmentFile and no writable path", () => {
    const s = sandbox();
    try {
      expect(s.step("migrate").status).toBe(0);
      const line = s.calls().split("\n").find((l) => l.includes("--unit=samohost-shop-migrate"))!;
      expect(line).toContain(`EnvironmentFile=${s.base}/migrate.env`);
      expect(line).not.toContain("ReadWritePaths");
      expect(line).toContain("-E HOME=/tmp");
    } finally {
      s.cleanup();
    }
  });

  test("seed without a seed command at bootstrap: error", () => {
    const s = sandbox();
    try {
      const res = s.step("seed");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no seed command");
    } finally {
      s.cleanup();
    }
  });

  test("release: root-owned copy without .npmrc and world bits; current and previous links; two kept", () => {
    const s = sandbox();
    try {
      const names: string[] = [];
      for (let i = 0; i < 3; i++) {
        expect(s.step("install").status).toBe(0);
        expect(s.step("build").status).toBe(0);
        const res = s.step("release");
        expect(res.status, res.stderr).toBe(0);
        names.push(readlinkSync(join(s.base, "current")));
        spawnSync("sleep", ["1"]);
      }
      expect(lstatSync(join(s.base, "current")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(s.base, "previous"))).toBe(names[1]!);
      expect(readdirSync(join(s.base, "releases")).sort()).toEqual([names[1]!, names[2]!].map((n) => n.replace("releases/", "")).sort());
      const rel = join(s.base, names[2]!);
      expect(existsSync(join(rel, ".npmrc"))).toBe(false);
      expect(readFileSync(join(rel, "dist", "server.js"), "utf8")).toBe("built\n");
      expect(statSync(join(rel, "package.json")).mode & 0o007).toBe(0);
      expect(statSync(rel).mode & 0o777).toBe(0o750);
      expect(s.calls()).toContain(`chown -hR root:shop-run ${s.base}/releases/`);
      expect(s.calls()).toContain("pkill -KILL -u shop-build");
    } finally {
      s.cleanup();
    }
  }, 60000);

  test("one lock per app: while another step holds it, every step refuses and changes nothing", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, "locked"), "");
      for (const step of ["install", "build", "migrate", "release", "rollback", "cleanup"]) {
        const res = s.step(step);
        expect(res.status, step).toBe(1);
        expect(res.stderr, step).toContain("another step of app shop is running");
      }
      expect(s.calls()).not.toContain("systemd-run");
      expect(s.calls()).not.toContain("pkill");
      expect(s.calls()).toContain(`flock -n 9`);
      expect(buildStepScript(PARAMS)).toContain("LOCK=/run/samohost/shop.lock");
    } finally {
      s.cleanup();
    }
  });

  test("a step unit of the app still active (for example after a dropped connection): install, build and release refuse", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      writeFileSync(join(s.dir, "state-samohost-shop-build"), "active\n");
      for (const step of ["install", "build", "release"]) {
        const res = s.step(step);
        expect(res.status, step).toBe(1);
        expect(res.stderr, step).toContain("samohost-shop-build is active");
      }
      expect(existsSync(join(s.base, "current"))).toBe(false);
      expect(readdirSync(join(s.base, "build"))).toContain("package.json");
    } finally {
      s.cleanup();
    }
  });

  test("release copies from a root-owned snapshot of build/ and leaves an empty build/ for the build user", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      const res = s.step("release");
      expect(res.status, res.stderr).toBe(0);
      const calls = s.calls().split("\n");
      const mv = calls.findIndex((l) => l.startsWith(`mv -T -- ${s.base}/build ${s.base}/releases/`) && l.endsWith(".src"));
      const own = calls.findIndex((l) => l.startsWith(`chown -hR root:root ${s.base}/releases/`) && l.endsWith(".src"));
      const cp = calls.findIndex((l) => l.startsWith("cp -R -P"));
      expect(mv).toBeGreaterThanOrEqual(0);
      expect(own).toBeGreaterThan(mv);
      expect(cp).toBeGreaterThan(own);
      expect(calls[cp]).toContain(".src/. ");
      expect(readdirSync(join(s.base, "build"))).toEqual([]);
      expect(calls).toContain(`chown shop-build:shop-build ${s.base}/build`);
      expect(readdirSync(join(s.base, "releases")).filter((n) => n.endsWith(".src"))).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("release refuses to copy when fs.protected_hardlinks is not 1", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, "protected_hardlinks"), "0\n");
      const res = s.step("release");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("protected_hardlinks");
      expect(existsSync(join(s.base, "current"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("rollback switches current back to the previous release; without one it fails", () => {
    const s = sandbox();
    try {
      expect(s.step("rollback").status).toBe(1);
      s.step("release");
      const first = readlinkSync(join(s.base, "current"));
      spawnSync("sleep", ["1"]);
      s.step("release");
      expect(readlinkSync(join(s.base, "current"))).not.toBe(first);
      expect(s.step("rollback").status).toBe(0);
      expect(readlinkSync(join(s.base, "current"))).toBe(first);
    } finally {
      s.cleanup();
    }
  });
});
