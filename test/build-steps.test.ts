/**
 * The root-owned step script of a new-layout node app: install, build,
 * migrate and seed run as <app>-build in a hardened transient systemd
 * service; release makes a root-owned copy of the build for <app>-run and
 * switches the `current` link; rollback switches it back.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  database: "shop",
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
function sandbox(params: Partial<BuildStepParams> = {}, edits: Array<[string, string]> = []) {
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
  stub(bin, "pg_dump", `if [[ -e ${JSON.stringify(join(dir, "fail-pg-dump"))} ]]; then exit 1; fi; printf 'dump-data'`, log);
  stub(bin, "psql", `if [[ -e ${JSON.stringify(join(dir, "fail-psql"))} ]]; then exit 1; fi; cat ${JSON.stringify(join(dir, "db-bytes"))}`, log);
  writeFileSync(join(dir, "db-bytes"), "1024\n");
  stub(bin, "df", `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 999999999 1 '; cat ${JSON.stringify(join(dir, "free-kb"))}; printf ' 1%% /\\n'`, log);
  writeFileSync(join(dir, "free-kb"), "999999999\n");
  // GNU cp options on macOS: drop --preserve=timestamps and --, copy with -RP.
  stub(bin, "cp", 'a=(); for x in "$@"; do case "$x" in -R|-P|--preserve=timestamps|--) ;; *) a+=("$x");; esac; done\nprintf "releases at copy: %s\\n" "$(ls "$(dirname "${a[1]}")" | grep -v "\\.src$" | grep -v "\\.tmp$" | tr "\\n" " ")" >> ' + JSON.stringify(log) + '\n/bin/cp -RP "${a[@]}"', log);
  // GNU tar's --no-overwrite-dir is not in macOS tar; drop it there.
  stub(bin, "tar", 'a=(); for x in "$@"; do [[ "$x" == --no-overwrite-dir ]] || a+=("$x"); done\nexec /usr/bin/tar "${a[@]}"', log);
  // mv -T on macOS: replace the destination entry, then rename.
  stub(bin, "mv", 'args=(); t=0; for a in "$@"; do case "$a" in -fT|-T) t=1;; -f|--) ;; *) args+=("$a");; esac; done\nif [[ $t == 1 ]]; then rm -f "${args[1]}" 2>/dev/null || rmdir "${args[1]}" 2>/dev/null || true; fi\n/bin/mv -f "${args[0]}" "${args[1]}"', log);
  const text = buildStepScript({ ...PARAMS, ...params })
    .replaceAll("/opt/shop", base)
    .replace("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", `export PATH=${bin}:/usr/bin:/bin`)
    .replace("/proc/sys/fs/protected_hardlinks", join(dir, "protected_hardlinks"))
    .replaceAll("/run/samohost", join(dir, "run-samohost"))
    .replaceAll("/var/backups/samohost/shop", join(base, "backups"))
    .replaceAll("/usr/bin/systemctl", join(bin, "systemctl"))
    .replace("/usr/bin/timeout -k 5 60 /usr/sbin/runuser -u postgres -- /usr/bin/psql", join(bin, "psql"))
    .replace("/usr/bin/timeout -k 30 600 /usr/sbin/runuser -u postgres -- /usr/bin/pg_dump", join(bin, "pg_dump"))
    .replaceAll('install -d -m 700 -o root -g root "$BACKUP_ROOT"', 'mkdir -p "$BACKUP_ROOT"; chmod 700 "$BACKUP_ROOT"')
    .replaceAll('install -d -m 700 -o root -g root "$BACKUP_DIR"', 'mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"')
    .replace("MIN_FREE_KB=2097152", "MIN_FREE_KB=0");
  let edited = text;
  for (const [a, b] of edits) edited = edited.replace(a, b);
  const script = join(dir, "step");
  writeFileSync(script, edited);
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

  test("database size lookup cannot wait for a password or run without a time limit", () => {
    expect(text).toContain("/usr/bin/timeout -k 5 60 /usr/sbin/runuser -u postgres -- /usr/bin/psql -X -w -qAt");
  });

  test("omits database backup variables when the backup step is omitted", () => {
    const withoutBackup = buildStepScript({ ...PARAMS, includeBackup: false });
    expect(withoutBackup).not.toContain("\nDATABASE=");
    expect(withoutBackup).not.toContain("\nBACKUP_DIR=");
  });

  test("backup publishes only a complete dump and keeps the newest five", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      const backups = join(s.base, "backups");
      mkdirSync(backups);
      for (let n = 1; n <= 7; n++) writeFileSync(join(backups, `2026010${n}T000000Z-1111111.dump`), "old");
      writeFileSync(join(backups, ".backup.abandoned.tmp"), "partial");
      const result = s.step("backup");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const files = readdirSync(backups);
      expect(files.filter((name) => name.endsWith(".dump")).length).toBe(5);
      expect(files.some((name) => name.endsWith("-abcdef0.dump"))).toBe(true);
      expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a failed pg_dump leaves no final or temporary file and does not prune", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      writeFileSync(join(s.dir, "fail-pg-dump"), "1");
      const backups = join(s.base, "backups");
      mkdirSync(backups);
      for (let n = 1; n <= 7; n++) writeFileSync(join(backups, `2026010${n}T000000Z-1111111.dump`), "old");
      const result = s.step("backup");
      expect(result.status).toBe(1);
      const files = readdirSync(backups);
      expect(files.filter((name) => name.endsWith(".dump")).length).toBe(7);
      expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("backup checks database size and free space before creating a file", () => {
    const s = sandbox({}, [["MIN_FREE_KB=0", "MIN_FREE_KB=2097152"]]);
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      writeFileSync(join(s.dir, "db-bytes"), `${512 * 1024 * 1024}\n`);
      writeFileSync(join(s.dir, "free-kb"), `${3 * 1024 * 1024}\n`);
      expect(s.step("backup").status).toBe(0);
      expect(s.calls()).toContain("psql -X -w -qAt --dbname=postgres");
      expect(s.calls()).toContain("pg_dump --no-password --lock-wait-timeout=60000 -Fc --dbname=shop");
    } finally { s.cleanup(); }
  });

  test("backup refuses insufficient space without calling pg_dump or leaving a temporary file", () => {
    const s = sandbox({}, [["MIN_FREE_KB=0", "MIN_FREE_KB=2097152"]]);
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      writeFileSync(join(s.dir, "db-bytes"), `${1536 * 1024 * 1024}\n`);
      writeFileSync(join(s.dir, "free-kb"), `${3 * 1024 * 1024}\n`);
      const result = s.step("backup");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("database size is 1536 MB");
      expect(result.stderr).toContain("backup disk free space is 3072 MB");
      expect(s.calls()).not.toContain("pg_dump");
      expect(readdirSync(join(s.base, "backups")).some((name) => name.includes(".tmp"))).toBe(false);
    } finally { s.cleanup(); }
  });

  test("pruning protects the new dump from five future names", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      const backups = join(s.base, "backups"); mkdirSync(backups);
      const future = Array.from({ length: 5 }, (_, i) => `2099010${i + 1}T000000Z-1111111.dump`);
      for (const name of future) writeFileSync(join(backups, name), "old");
      expect(s.step("backup").status).toBe(0);
      const names = readdirSync(backups).sort();
      expect(names.some((name) => name.endsWith("-abcdef0.dump"))).toBe(true);
      expect(names.filter((name) => future.includes(name))).toEqual(future.slice(1).sort());
    } finally { s.cleanup(); }
  });

  test("pruning ignores manual files and retains the new dump plus four matching old dumps", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      const backups = join(s.base, "backups"); mkdirSync(backups);
      writeFileSync(join(backups, "pre-restore-manual.dump"), "manual");
      for (let n = 1; n <= 6; n++) writeFileSync(join(backups, `2026010${n}T000000Z-1111111.dump`), "old");
      expect(s.step("backup").status).toBe(0);
      const names = readdirSync(backups).sort();
      expect(names).toContain("pre-restore-manual.dump");
      expect(names.filter((name) => /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}\.dump$/.test(name)).map((name) => name.includes("-abcdef0") ? "new" : name)).toEqual([
        "20260103T000000Z-1111111.dump", "20260104T000000Z-1111111.dump", "20260105T000000Z-1111111.dump", "20260106T000000Z-1111111.dump", "new",
      ]);
    } finally { s.cleanup(); }
  });

  test("a pruning removal failure is a warning and keeps the new backup", () => {
    const s = sandbox({}, [['if ! rm -f -- "$old"; then', 'if [[ "$old" == *20260101* ]] || ! rm -f -- "$old"; then']]);
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      const backups = join(s.base, "backups"); mkdirSync(backups);
      for (let n = 1; n <= 6; n++) writeFileSync(join(backups, `2026010${n}T000000Z-1111111.dump`), "old");
      const result = s.step("backup");
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("WARNING: could not remove old database backup");
      expect(readdirSync(backups).some((name) => name.endsWith("-abcdef0.dump"))).toBe(true);
      expect(existsSync(join(backups, "20260101T000000Z-1111111.dump"))).toBe(true);
    } finally { s.cleanup(); }
  });

  test("backup creates the final dump as mode 0600 and dumps the app database", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      expect(s.step("backup").status).toBe(0);
      const file = readdirSync(join(s.base, "backups")).find((name) => name.endsWith(".dump"))!;
      expect(statSync(join(s.base, "backups", file)).mode & 0o777).toBe(0o600);
      expect(s.calls()).toContain("--dbname=shop");
      expect(buildStepScript(PARAMS).indexOf("umask 077")).toBeLessThan(buildStepScript(PARAMS).indexOf('tmp="$(mktemp'));
    } finally { s.cleanup(); }
  });

  test("backup refuses a symbolic-link app folder before writing", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      const target = join(s.dir, "elsewhere"); mkdirSync(target);
      symlinkSync(target, join(s.base, "backups"));
      const result = s.step("backup");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not a folder owned by root or is a symbolic link");
      expect(readdirSync(target)).toEqual([]);
      expect(s.calls()).not.toContain("pg_dump");
    } finally { s.cleanup(); }
  });

  test("backup reports a missing release.env without a sed diagnostic", () => {
    const s = sandbox();
    try {
      const result = s.step("backup");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("backup did not run: release.env is missing or unreadable");
      expect(result.stderr).not.toContain("sed:");
      expect(s.calls()).not.toContain("pg_dump");
    } finally { s.cleanup(); }
  });

  test("build steps run as the build user in a hardened transient service with limits", () => {
    for (const line of [
      "--uid=\"$BUILD_USER\" --gid=\"$BUILD_USER\"",
      "-p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes",
      "-p ProtectControlGroups=yes -p ProtectProc=invisible -p RestrictSUIDSGID=yes",
      '-p "RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK" -p CapabilityBoundingSet=',
      '-p MemoryMax=75% -p TasksMax=1024 -p "RuntimeMaxSec=$2"',
      "-p LockPersonality=yes -p RestrictNamespaces=yes",
      '-p KillMode=control-group -p "InaccessiblePaths=$HIDDEN"',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain(
      "HIDDEN='-/opt/shop/staging.env -/opt/shop/migrate.env -/opt/shop/.gh-token -/opt/shop/git-safe.conf -/opt/shop/app/.git -/opt/shop/releases'",
    );
  });

  test("step units: system call filter, namespaces, clock, hostname, kernel logs, realtime, private /dev/shm, IPC removal", () => {
    for (const line of [
      "-p RestrictNamespaces=yes -p SystemCallFilter=@system-service -p SystemCallErrorNumber=EPERM",
      "-p SystemCallArchitectures=native -p ProtectClock=yes -p ProtectHostname=yes -p ProtectKernelLogs=yes",
      "-p RestrictRealtime=yes -p TemporaryFileSystem=/dev/shm -p RemoveIPC=yes",
    ]) {
      expect(text).toContain(line);
    }
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
  test("a failed database size lookup stops without calling pg_dump", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "release.env"), "SAMO_RELEASE_SHA=abcdef0123456789\n");
      writeFileSync(join(s.dir, "fail-psql"), "1");
      const result = s.step("backup");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("backup did not run: could not read the size of database shop");
      expect(s.calls()).not.toContain("pg_dump");
    } finally {
      s.cleanup();
    }
  });
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

  test("install: the build user empties build/ in place inside its unit; root walks no tree in build/", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.base, "build", "stale.txt"), "old\n");
      const inode = statSync(join(s.base, "build")).ino;
      expect(s.step("install").status).toBe(0);
      expect(existsSync(join(s.base, "build", "stale.txt"))).toBe(false);
      expect(statSync(join(s.base, "build")).ino).toBe(inode);
      const text = buildStepScript(PARAMS);
      expect(text).toMatch(/INSTALL_CMD='[^\n]*find \. -mindepth 1 -maxdepth 1 -exec rm -rf -- \{\} \+/);
      expect(text).not.toContain('find "$BUILD_DIR"');
      expect(text).not.toContain('du -sk -- "$BUILD_DIR"');
      const calls = s.calls().split("\n");
      expect(calls.findIndex((l) => l === "pkill -KILL -u shop-build")).toBeLessThan(calls.findIndex((l) => l.includes("--unit=samohost-shop-install")));
    } finally {
      s.cleanup();
    }
  });

  test("install: the extracting tar keeps the mode of the existing build/ (--no-overwrite-dir), then chmod 700", () => {
    const text = buildStepScript(PARAMS);
    expect(text).toContain("tar --no-overwrite-dir -xf -; chmod 700 .");
  });

  test("install: build/ stays mode 700 although the checkout folder is 755 (the archive's ./ entry)", () => {
    const s = sandbox();
    try {
      chmodSync(join(s.base, "build"), 0o700);
      chmodSync(join(s.base, "app"), 0o755);
      // GNU tar (on the server) gives an existing folder the mode of the
      // archive's ./ entry; this stub does the same around the system tar.
      const tar = join(s.dir, "bin", "tar");
      writeFileSync(tar, [
        "#!/usr/bin/env bash",
        'if [[ "$*" != "--no-overwrite-dir -xf -" ]]; then exec /usr/bin/tar "$@"; fi',
        't="$(mktemp)"; cat > "$t"; /usr/bin/tar -xf - < "$t"',
        "p=\"$(/usr/bin/tar -tvf \"$t\" | awk '$NF == \"./\" || $NF == \".\" { print $1; exit }')\"",
        'm=0; for i in 0 1 2; do x="${p:$((1 + i * 3)):3}"; v=0; [[ ${x:0:1} == r ]] && v=$((v + 4)); [[ ${x:1:1} == w ]] && v=$((v + 2)); [[ ${x:2:1} == x ]] && v=$((v + 1)); m="$m$v"; done',
        'chmod "$m" .; rm -f "$t"',
      ].join("\n") + "\n");
      chmodSync(tar, 0o755);
      expect(s.step("install").status).toBe(0);
      expect(existsSync(join(s.base, "build", "package.json"))).toBe(true);
      expect((statSync(join(s.base, "build")).mode & 0o777).toString(8)).toBe("700");
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

  test("network: no step reaches the metadata address; install and build reach no loopback address but the resolver stub", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      expect(s.step("migrate").status).toBe(0);
      const lines = s.calls().split("\n");
      for (const unit of ["install", "build"]) {
        const line = lines.find((l) => l.includes(`--unit=samohost-shop-${unit}`))!;
        expect(line, unit).toContain("-p IPAddressDeny=169.254.169.254 127.0.0.0/8 ::1 -p IPAddressAllow=127.0.0.53");
      }
      const migrate = lines.find((l) => l.includes("--unit=samohost-shop-migrate"))!;
      expect(migrate).toContain("-p IPAddressDeny=169.254.169.254 ");
      expect(migrate).not.toContain("127.0.0.0/8");
      expect(migrate).not.toContain("IPAddressAllow");
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
      // install -d also sets the mode of a folder that already exists.
      expect(buildStepScript(PARAMS)).toContain("\ninstall -d -m 755 /run/samohost\n");
      expect(buildStepScript(PARAMS)).not.toContain("mkdir -p -m 755 /run/samohost");
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

  test("release: the copy runs as the build user in a unit without network, writing only the new folder; root changes owners after it", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      const inode = statSync(join(s.base, "build")).ino;
      const res = s.step("release");
      expect(res.status, res.stderr).toBe(0);
      const calls = s.calls().split("\n");
      const unit = calls.findIndex((l) => l.includes("--unit=samohost-shop-copy --uid=shop-build --gid=shop-build"));
      expect(unit).toBeGreaterThanOrEqual(0);
      const line = calls[unit]!;
      const dest = /-p ReadWritePaths=(\S+)/.exec(line)![1]!;
      expect(dest).toMatch(new RegExp(`^${s.base}/releases/[0-9TZ]+-[0-9]+\\.tmp$`));
      expect(line).toContain("-p PrivateNetwork=yes");
      expect(line).toContain("-p IPAddressDeny=any");
      expect(line).toContain(`InaccessiblePaths=-${s.base}/staging.env -${s.base}/migrate.env -${s.base}/.gh-token -${s.base}/git-safe.conf -${s.base}/app/.git `);
      expect(line).not.toContain("EnvironmentFile");
      const giveDest = calls.indexOf(`chown shop-build:shop-build ${dest}`);
      const takeDest = calls.indexOf(`chown root:root ${dest}`);
      const owners = calls.indexOf(`chown -hR root:shop-run ${dest}`);
      expect(giveDest).toBeGreaterThanOrEqual(0);
      expect(giveDest).toBeLessThan(unit);
      expect(takeDest).toBeGreaterThan(unit);
      expect(owners).toBeGreaterThan(takeDest);
      // build/ stays in place (same inode) with its content; the service's InaccessiblePaths keeps covering it.
      expect(statSync(join(s.base, "build")).ino).toBe(inode);
      expect(readdirSync(join(s.base, "build"))).toContain("dist");
      const text = buildStepScript(PARAMS);
      expect(text).not.toContain('mv -T -- "$BUILD_DIR"');
      expect(text).not.toContain("contains no other file of the server");
      expect(text).not.toContain('chown -hR root:root "$snap"');
    } finally {
      s.cleanup();
    }
  });

  test("release: special files (FIFOs) are removed from the release", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      spawnSync("mkfifo", [join(s.base, "build", "pipe")]);
      expect(s.step("release").status).toBe(0);
      const rel = join(s.base, readlinkSync(join(s.base, "current")));
      expect(existsSync(join(rel, "package.json"))).toBe(true);
      expect(existsSync(join(rel, "pipe"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("no step unit can create AF_UNIX sockets (no descriptor passing to the service over an abstract socket)", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("build").status).toBe(0);
      expect(s.step("migrate").status).toBe(0);
      expect(s.step("release").status).toBe(0);
      const units = s.calls().split("\n").filter((l) => l.startsWith("systemd-run "));
      expect(units.length).toBe(4);
      for (const line of units) {
        expect(line).toContain("-p RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK ");
        expect(line).not.toContain("AF_UNIX");
      }
    } finally {
      s.cleanup();
    }
  });

  test("disk: release refuses a build/ larger than the limit, and a copy that would leave less free space than the limit", () => {
    const text = buildStepScript(PARAMS);
    expect(text).toContain("MAX_BUILD_KB=2097152");
    expect(text).toContain("MIN_FREE_KB=2097152");
    for (const [edit, message] of [
      [["MAX_BUILD_KB=2097152", "MAX_BUILD_KB=1"], "more than the limit of 1 KiB"],
      [["MIN_FREE_KB=0", "MIN_FREE_KB=999999999999"], "less than 999999999999 KiB"],
    ] as const) {
      const s = sandbox({}, [edit as unknown as [string, string]]);
      try {
        expect(s.step("install").status).toBe(0);
        expect(s.step("build").status).toBe(0);
        const res = s.step("release");
        expect(res.status).toBe(1);
        expect(res.stderr).toContain(message);
        expect(existsSync(join(s.base, "current"))).toBe(false);
        expect(readdirSync(join(s.base, "build"))).toContain("dist");
      } finally {
        s.cleanup();
      }
    }
  }, 60000);

  test("release removes releases other than current and previous before the copy: at most three exist", () => {
    const s = sandbox();
    try {
      for (const d of ["a", "b", "old1", "old2", "x.tmp"]) mkdirSync(join(s.base, "releases", d));
      require("node:fs").symlinkSync("releases/a", join(s.base, "current"));
      require("node:fs").symlinkSync("releases/b", join(s.base, "previous"));
      expect(s.step("release").status).toBe(0);
      expect(s.calls()).toContain("releases at copy: a b \n");
      const now = readlinkSync(join(s.base, "current")).replace("releases/", "");
      expect(readdirSync(join(s.base, "releases")).sort()).toEqual(["a", now].sort());
      expect(readlinkSync(join(s.base, "previous"))).toBe("releases/a");
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

  test("rollback refuses when the previous link names a release that does not exist", () => {
    const s = sandbox();
    try {
      mkdirSync(join(s.base, "releases", "a"));
      require("node:fs").symlinkSync("releases/a", join(s.base, "current"));
      require("node:fs").symlinkSync("releases/gone", join(s.base, "previous"));
      const res = s.step("rollback");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("previous release releases/gone does not exist");
      expect(readlinkSync(join(s.base, "current"))).toBe("releases/a");
    } finally {
      s.cleanup();
    }
  });

  test("rollback without a previous release removes current (exit 3); the next release does not keep the failed one as previous", () => {
    const s = sandbox();
    try {
      expect(s.step("install").status).toBe(0);
      expect(s.step("release").status).toBe(0);
      const failed = readlinkSync(join(s.base, "current"));
      const res = s.step("rollback");
      expect(res.status).toBe(3);
      expect(res.stderr).toContain("no previous release");
      expect(existsSync(join(s.base, "current"))).toBe(false);
      spawnSync("sleep", ["1"]);
      expect(s.step("install").status).toBe(0);
      expect(s.step("release").status).toBe(0);
      expect(readlinkSync(join(s.base, "current"))).not.toBe(failed);
      expect(existsSync(join(s.base, "previous"))).toBe(false);
      expect(readdirSync(join(s.base, "releases"))).not.toContain(failed.replace("releases/", ""));
    } finally {
      s.cleanup();
    }
  }, 30000);

  test("rollback switches current back to the previous release", () => {
    const s = sandbox();
    try {
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
