/**
 * Node apps with the new env layout (migrate.env next to the runtime env
 * file): the service runs as a separate runtime user '<app>-run' under a
 * hardened systemd unit, and the deploy user's sudo rules name exact files.
 *
 * Static apps and node apps that keep the legacy env layout get today's
 * script, sudo rules and unit byte for byte (golden files rendered from the
 * code before this change).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { buildDeployScript } from "../src/app/script.ts";
import { dbSection } from "./bootstrap-db-harness.ts";
import { goldenCases, goldenNodeApp, goldenNodeOpts } from "./bootstrap-golden-fixtures.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const script = (): string => buildHostBootstrapScript(goldenNodeApp(), goldenNodeOpts());

/** Lines from the `# §<from>.` heading up to the line before the `# §<to>.` heading. */
function section(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`# §${from}.`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith(`# §${to}.`));
  expect(start, `§${from} heading`).toBeGreaterThan(0);
  expect(end, `§${to} heading`).toBeGreaterThan(start);
  return lines.slice(start, end - 1).join("\n");
}

function stubDir(stubs: Record<string, string>): { dir: string; log: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "samohost-runtime-user-"));
  const log = join(dir, "argv.log");
  for (const [name, body] of Object.entries(stubs)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runBash(text: string, path: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail\n${text}`], {
    encoding: "utf8",
    env: { PATH: `${path}:/usr/bin:/bin`, ...env },
  });
}

/** Run §6 and §7 with /etc paths moved into a sandbox; return the written files. */
function writtenSudoersAndUnit(layout: "legacy" | "split", text = script()) {
  const sb = stubDir({ visudo: "", systemctl: "" });
  try {
    const body = section(text, "6", "8")
      .replaceAll("/etc/sudoers.d/", `${sb.dir}/`)
      .replaceAll("/etc/systemd/system/", `${sb.dir}/`)
      .replace(/^\/usr\/bin\/systemctl /gm, "systemctl ");
    const res = runBash(body, sb.dir, { SAMOHOST_DB_LAYOUT: layout });
    expect(res.status, res.stderr).toBe(0);
    return {
      sudoers: readFileSync(join(sb.dir, "shop-agent"), "utf8"),
      unit: readFileSync(join(sb.dir, "shop.service"), "utf8"),
    };
  } finally {
    sb.cleanup();
  }
}

const SPLIT_SUDOERS = [
  "shop ALL=(root) NOPASSWD: /usr/bin/systemctl enable shop",
  "shop ALL=(root) NOPASSWD: /usr/bin/systemctl start shop",
  "shop ALL=(root) NOPASSWD: /usr/bin/systemctl stop shop",
  "shop ALL=(root) NOPASSWD: /usr/bin/systemctl restart shop",
  "shop ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy",
  "shop ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/00-main-shop.caddy",
  "shop ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/.samohost-heal-next-00-main-shop.caddy",
  "shop ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/.samohost-heal-next-00-main-shop.caddy /etc/caddy/sites.d/00-main-shop.caddy",
  "shop ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/.samohost-heal-next-00-main-shop.caddy",
  "shop ALL=(root) NOPASSWD: /usr/bin/tee /opt/shop/release.env",
  "shop ALL=(caddy) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile",
].join("\n") + "\n";

const SPLIT_UNIT = [
  "[Unit]",
  "Description=shop main service",
  "After=network.target postgresql.service",
  "",
  "[Service]",
  "User=shop-run",
  "Group=shop-run",
  "WorkingDirectory=/opt/shop/app",
  "EnvironmentFile=/opt/shop/staging.env",
  "EnvironmentFile=-/opt/shop/release.env",
  "ExecStart=/usr/bin/node dist/server.js",
  "Restart=always",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectControlGroups=yes",
  "ProtectProc=invisible",
  "RestrictSUIDSGID=yes",
  "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
  "CapabilityBoundingSet=",
  "LockPersonality=yes",
  "MemoryMax=50%",
  "TasksMax=256",
  "ReadWritePaths=/opt/shop/uploads",
  "InaccessiblePaths=-/opt/shop/migrate.env -/opt/shop/.gh-token -/opt/shop/git-safe.conf -/opt/shop/app/.git -/opt/shop/app/.npmrc",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n") + "\n";

/** Parse `user ALL=(runas) NOPASSWD: cmd args` into a matcher (exact or sudo regex). */
function sudoMatcher(rules: string) {
  const parsed = rules.trim().split("\n").map((line) => {
    const m = /^\S+ ALL=\((\w+)\) NOPASSWD: (\S+)(?: (.*))?$/.exec(line);
    if (m === null) throw new Error(`unparsed rule: ${line}`);
    return { runas: m[1]!, cmd: m[2]!, args: m[3] ?? "" };
  });
  return (cmd: string, args: string): boolean =>
    parsed.some((r) => {
      if (r.runas !== "root" || r.cmd !== cmd) return false;
      if (r.args.startsWith("^") && r.args.endsWith("$")) return new RegExp(r.args).test(args);
      return r.args === args;
    });
}

describe("golden: static apps and the legacy env layout are unchanged", () => {
  for (const c of goldenCases()) {
    test(`static bootstrap script ${c.file} is byte-identical`, () => {
      expect(buildHostBootstrapScript(c.app, c.opts)).toBe(fixture(c.file));
    });
  }

  test("legacy layout: the sudo rules and the unit written on the server are today's, byte for byte", () => {
    const { sudoers, unit } = writtenSudoersAndUnit("legacy");
    expect(sudoers).toBe(fixture("bootstrap-node-legacy-sudoers.txt"));
    expect(unit).toBe(fixture("bootstrap-node-legacy-unit.txt"));
  });

  test("legacy layout: the runtime user section does nothing", () => {
    const sb = stubDir({ id: "exit 1", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "" });
    try {
      const res = runBash(section(script(), "5c", "6"), sb.dir, { SAMOHOST_DB_LAYOUT: "legacy" });
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(sb.log)).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("env layout is decided before the sudo rules and the unit", () => {
  function layoutOf(envBody: string | undefined, withMigrateEnv: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "samohost-layout-"));
    try {
      const envFile = join(dir, "staging.env");
      if (envBody !== undefined) writeFileSync(envFile, envBody);
      if (withMigrateEnv) writeFileSync(join(dir, "migrate.env"), "DATABASE_URL=x\n");
      const text = buildHostBootstrapScript(
        { ...goldenNodeApp(), envFile, appDir: join(dir, "app") },
        { ...goldenNodeOpts(), appBase: dir },
      );
      const res = runBash(`${section(text, "3b", "4")}\necho "LAYOUT=$SAMOHOST_DB_LAYOUT"`, "/usr/bin");
      expect(res.status, res.stderr).toBe(0);
      return /LAYOUT=(\w+)/.exec(res.stdout)?.[1] ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("fresh server: split; superuser address and no migrate.env: legacy; migrate.env present: split", () => {
    expect(layoutOf(undefined, false)).toBe("split");
    expect(layoutOf("DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n", false)).toBe("legacy");
    expect(layoutOf("DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n", true)).toBe("split");
    expect(layoutOf("APP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n", false)).toBe("split");
  });

  test("the layout is set once, before §6, and the database section still sees it", () => {
    const text = script();
    const assignments = text.split("\n").filter((l) => /^\s*SAMOHOST_DB_LAYOUT=/.test(l));
    expect(assignments.length).toBe(3); // marker, legacy and split arms of one if
    expect(text.indexOf("SAMOHOST_DB_LAYOUT=legacy")).toBeLessThan(text.indexOf("# §6."));
    expect(dbSection(text)).toContain("SAMOHOST_DB_LAYOUT=legacy");
  });
});

describe("new layout: runtime user '<app>-run'", () => {
  test("created as a system user with no login shell, its own group only, owning only the uploads folder", () => {
    const sb = stubDir({ id: "exit 1", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "", install: "" });
    try {
      const res = runBash(section(script(), "5c", "6"), sb.dir, { SAMOHOST_DB_LAYOUT: "split" });
      expect(res.status, res.stderr).toBe(0);
      const calls = readFileSync(sb.log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "id shop-run",
        "useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin shop-run",
        "usermod --shell /usr/sbin/nologin shop-run",
        "gpasswd -d shop-run shop",
        "install -d -m 750 -o shop-run -g shop-run /opt/shop/uploads",
      ]);
    } finally {
      sb.cleanup();
    }
  });

  test("a symbolic link at the uploads folder is refused before chown and chmod", () => {
    const sb = stubDir({ id: "exit 0", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "" });
    try {
      const link = join(sb.dir, "uploads");
      symlinkSync("/etc", link);
      const text = section(script(), "5c", "6").replaceAll("/opt/shop/uploads", link);
      const res = runBash(text, sb.dir, { SAMOHOST_DB_LAYOUT: "split" });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("is a symbolic link");
      expect(readFileSync(sb.log, "utf8")).not.toMatch(/^(chown|chmod) /m);
    } finally {
      sb.cleanup();
    }
  });

  test("an existing uploads folder: owner changed without following links; files with more than one hard link skipped", () => {
    const sb = stubDir({ id: "exit 0", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "", install: "" });
    try {
      const uploads = join(sb.dir, "uploads");
      mkdirSync(join(uploads, "sub"), { recursive: true });
      writeFileSync(join(uploads, "photo.jpg"), "x");
      writeFileSync(join(sb.dir, "outside"), "secret");
      linkSync(join(sb.dir, "outside"), join(uploads, "linked"));
      symlinkSync("/etc/hosts", join(uploads, "sub", "link"));
      const text = section(script(), "5c", "6").replaceAll("/opt/shop/uploads", uploads);
      const res = runBash(text, sb.dir, { SAMOHOST_DB_LAYOUT: "split" });
      expect(res.status, res.stderr).toBe(0);
      const calls = readFileSync(sb.log, "utf8");
      const chowned = calls.split("\n").filter((l) => l.startsWith("chown ")).join(" ");
      expect(chowned).toContain(`-h shop-run:shop-run`);
      expect(chowned).toContain(join(uploads, "photo.jpg"));
      expect(chowned).toContain(join(uploads, "sub", "link"));
      expect(chowned).not.toContain(join(uploads, "linked"));
      expect(calls).not.toMatch(/^chown -hR/m);
      expect(calls).not.toMatch(/^install /m);
      expect(calls).toContain(`chmod 750 ${uploads}`);
      expect(res.stderr).toContain("more than one hard link");
    } finally {
      sb.cleanup();
    }
  });

  test("an existing runtime user is kept (no second useradd)", () => {
    const sb = stubDir({ id: "exit 0", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "", install: "" });
    try {
      const res = runBash(section(script(), "5c", "6"), sb.dir, { SAMOHOST_DB_LAYOUT: "split" });
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(sb.log, "utf8")).not.toContain("useradd");
    } finally {
      sb.cleanup();
    }
  });

  test("no sudo rule names the runtime user", () => {
    expect(script()).not.toMatch(/^shop-run .*NOPASSWD/m);
    expect(writtenSudoersAndUnit("split").sudoers).not.toContain("shop-run");
  });

  test("an app name that cannot form a Linux user name stops the new-layout bootstrap; legacy output unchanged", () => {
    const long = "a".repeat(29); // "<29 chars>-run" is 33 characters
    const app = goldenNodeApp();
    const text = buildHostBootstrapScript(
      { ...app, name: long, serviceUnit: long, appDir: `/opt/${long}/app`, envFile: `/opt/${long}/staging.env` },
      { ...goldenNodeOpts(), appUser: "shop" },
    );
    const sb = stubDir({ id: "exit 1", useradd: "", usermod: "", gpasswd: "", chown: "", chmod: "" });
    try {
      const res = runBash(section(text, "5c", "6"), sb.dir, { SAMOHOST_DB_LAYOUT: "split" });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("ERROR");
      expect(existsSync(sb.log) ? readFileSync(sb.log, "utf8") : "").not.toContain("useradd");
    } finally {
      sb.cleanup();
    }
    expect(text).not.toContain("SAMOHOST_SPLIT_SUDOERS");
    expect(text).not.toContain("SAMOHOST_SPLIT_UNIT");
  });
});

describe("new layout: deploy user's sudo rules", () => {
  test("the written sudoers file is exactly the expected rule list", () => {
    expect(writtenSudoersAndUnit("split").sudoers).toBe(SPLIT_SUDOERS);
  });

  test("no wildcard, no journalctl, no daemon-reload, no psql as postgres", () => {
    const rules = writtenSudoersAndUnit("split").sudoers;
    expect(rules).not.toContain("*");
    expect(rules).not.toContain("journalctl");
    expect(rules).not.toContain("daemon-reload");
    expect(rules).not.toContain("(postgres)");
  });

  test("no rule for preview vhost files: <app>-<label> overlaps between apps whose names share a prefix", () => {
    const rules = writtenSudoersAndUnit("split").sudoers;
    expect(rules).not.toContain("^");
    const allowed = sudoMatcher(SPLIT_SUDOERS);
    expect(allowed("/usr/bin/tee", "/etc/caddy/sites.d/shop-feat-x.caddy")).toBe(false);
    expect(allowed("/usr/bin/rm", "-f /etc/caddy/sites.d/shop-feat-x.caddy")).toBe(false);
  });

  test("every sudo command of the node deploy and heal scripts is allowed by the new rules", () => {
    const app = goldenNodeApp();
    const texts = [
      buildDeployScript(app, { sha: "5555555555555555555555555555555555555555" }),
      buildConfigHealScript(app, { controlPlaneIp: "192.0.2.10" }),
    ];
    const allowed = sudoMatcher(SPLIT_SUDOERS);
    const seen: string[] = [];
    for (const text of texts) {
      for (const m of text.matchAll(/\bsudo (\/usr\/bin\/[a-z]+)((?: (?:'[^']*'|"[^"]*"|[^\s;|&<>'"]+))*)/g)) {
        const cmd = m[1]!;
        const args = m[2]!
          .trim()
          .replaceAll('"${SAMOHOST_UNIT}"', "shop")
          .replaceAll('"$SAMOHOST_RELEASE_ENV_FILE"', "/opt/shop/release.env")
          .replace(/'([^']*)'/g, "$1");
        if (args.includes("$")) throw new Error(`unresolved argument in: sudo ${cmd} ${args}`);
        seen.push(`${cmd} ${args}`);
        expect(allowed(cmd, args), `sudo ${cmd} ${args}`).toBe(true);
      }
    }
    // The heal staging file name in the rules is the one the heal script uses.
    expect(seen).toContain(
      "/usr/bin/mv -- /etc/caddy/sites.d/.samohost-heal-next-00-main-shop.caddy /etc/caddy/sites.d/00-main-shop.caddy",
    );
    expect(seen).toContain("/usr/bin/systemctl restart shop");
    expect(seen).toContain("/usr/bin/tee /opt/shop/release.env");
  });

  test("the sudo grant self-check still passes with the new rule count", () => {
    const count = SPLIT_SUDOERS.trim().split("\n").filter((l) => l.includes("NOPASSWD")).length;
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

describe("new layout: hardened systemd unit", () => {
  test("the written unit is exactly the expected text", () => {
    expect(writtenSudoersAndUnit("split").unit).toBe(SPLIT_UNIT);
  });

  test("each hardening line is present once; MemoryDenyWriteExecute is not set", () => {
    const unit = writtenSudoersAndUnit("split").unit.split("\n");
    for (const line of [
      "User=shop-run",
      "Group=shop-run",
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "PrivateDevices=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectControlGroups=yes",
      "ProtectProc=invisible",
      "RestrictSUIDSGID=yes",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
      "CapabilityBoundingSet=",
      "LockPersonality=yes",
      "MemoryMax=50%",
      "TasksMax=256",
      "ReadWritePaths=/opt/shop/uploads",
    ]) {
      expect(unit.filter((l) => l === line).length, line).toBe(1);
    }
    expect(unit.join("\n")).not.toContain("MemoryDenyWriteExecute");
  });

  test("secrets of the deploy user are hidden from the service", () => {
    const line = writtenSudoersAndUnit("split").unit.split("\n").find((l) => l.startsWith("InaccessiblePaths="));
    const paths = (line ?? "").slice("InaccessiblePaths=".length).split(" ");
    expect(paths).toEqual([
      "-/opt/shop/migrate.env",
      "-/opt/shop/.gh-token",
      "-/opt/shop/git-safe.conf",
      "-/opt/shop/app/.git",
      "-/opt/shop/app/.npmrc",
    ]);
  });
});

describe("new layout: deploy keeps the release readable by the runtime user", () => {
  test("the node deploy sets umask 022 only when migrate.env exists", () => {
    const text = buildDeployScript(goldenNodeApp(), { sha: "5555555555555555555555555555555555555555" });
    expect(text).toContain('if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then umask 022; fi');
  });
});
