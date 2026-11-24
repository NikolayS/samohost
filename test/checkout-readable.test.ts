/**
 * New layout: the service runs as <app>-run, which reads the checkout only
 * through the world-read bit. §11 sets umask 077 for the env files; the
 * clone in §12 must not inherit it, and bootstrap and deploy open up files
 * that an earlier clone or deploy left owner-only (except .git and links).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildDeployScript } from "../src/app/script.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";
import { goldenCases } from "./bootstrap-golden-fixtures.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);

function section12(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §12."));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# §13."));
  return lines.slice(start, end - 1).join("\n");
}

/** The lines before §0: shebang, comments, shell options and folder. */
function header(text: string): string {
  const lines = text.split("\n");
  const s0 = lines.findIndex((l) => l.startsWith("# §0."));
  return lines.slice(0, s0 - 1).join("\n");
}

/**
 * Run §12 after `umask 077` (as §11 leaves it) with stub sudo and git.
 * fromDeniedFolder: run the script header first, from a folder that the stub
 * sudo treats as closed to the other user (as /home/<operator>, mode 750, is
 * for the deploy user): a command run there as another user fails.
 */
function runClone(layout: "split" | "legacy", fromDeniedFolder = false) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-clone-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const denied = join(dir, "operator-home");
  mkdirSync(denied);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // sudo -u <user> [VAR=value ...] cmd args: run the command as the test user,
  // unless the working directory is the folder closed to the other user.
  stub(
    "sudo",
    [
      'if [[ "$1" == -u ]]; then',
      '  if [[ -n "${T_DENIED:-}" && "$(pwd -P)" == "$T_DENIED" ]]; then echo "find: Failed to change directory: $T_DENIED: Permission denied" >&2; exit 1; fi',
      "  shift 2",
      "fi",
      'exec env "$@"',
    ].join("\n"),
  );
  stub("chown", "exit 0");
  stub(
    "git",
    [
      'for a in "$@"; do last="$a"; done',
      'if [[ " $* " == *" clone "* ]]; then',
      '  mkdir -p "$last/.git/objects" "$last/src" "$last/public"',
      '  echo "{}" > "$last/package.json"; echo x > "$last/src/a.js"; echo x > "$last/public/i.css"; echo x > "$last/.git/config"',
      "fi",
      "exit 0",
    ].join("\n"),
  );
  const appDir = join(dir, "app");
  const app = nodeApp({ appDir, envFile: join(dir, "staging.env") });
  const full = buildHostBootstrapScript(app, nodeOpts({ appBase: dir }));
  const text = section12(full);
  writeFileSync(join(dir, ".gh-token"), "token\n");
  const res = spawnSync(
    "bash",
    [
      "-c",
      `${fromDeniedFolder ? `${header(full)}\n` : ""}set -euo pipefail\numask 077\nTOKEN_FILE=${JSON.stringify(join(dir, ".gh-token"))}\nSAMOHOST_DB_LAYOUT=${layout}\n${text}`,
    ],
    {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...(fromDeniedFolder ? { T_DENIED: realpathSync(denied) } : {}) },
      ...(fromDeniedFolder ? { cwd: denied } : {}),
    },
  );
  return { dir, appDir, res, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("bootstrap clone (§12)", () => {
  test("rendered: umask 022 before the clone and the read bits after it, split layout only", () => {
    const text = section12(buildHostBootstrapScript(nodeApp(), nodeOpts()));
    const umaskAt = text.indexOf('if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then umask 022; fi');
    expect(umaskAt).toBeGreaterThan(0);
    expect(umaskAt).toBeLessThan(text.indexOf(' clone "$REPO_URL" "$APP_DIR"'));
    expect(text).toContain(
      `sudo -u 'shop' find "$APP_DIR" -path "$APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} +`,
    );
  });

  test("split layout: the checkout is readable by other users; .git stays as cloned", () => {
    const r = runClone("split");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(mode(join(r.appDir, "package.json"))).toBe("644");
      expect(mode(join(r.appDir, "src"))).toBe("755");
      expect(mode(join(r.appDir, "src", "a.js"))).toBe("644");
      expect(mode(join(r.appDir, "public", "i.css"))).toBe("644");
      expect(mode(join(r.appDir, ".git"))).toBe("755"); // created under umask 022, not opened by chmod
      expect(mode(join(r.dir, ".gh-token"))).toBe("600");
    } finally {
      r.cleanup();
    }
  });

  test("legacy layout: unchanged (umask 077 from §11 still applies)", () => {
    const r = runClone("legacy");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(mode(join(r.appDir, "package.json"))).toBe("600");
      expect(mode(join(r.appDir, "src"))).toBe("700");
    } finally {
      r.cleanup();
    }
  });
});

describe("bootstrap working directory", () => {
  const cases: Array<[string, string]> = [
    ["node", buildHostBootstrapScript(nodeApp(), nodeOpts())],
    ...goldenCases().map((c): [string, string] => [c.file, buildHostBootstrapScript(c.app, c.opts)]),
  ];
  for (const [name, text] of cases) {
    test(`${name}: cd / right after set -euo pipefail, before the first command run as another user`, () => {
      const lines = text.split("\n");
      const set = lines.indexOf("set -euo pipefail");
      const cd = lines.indexOf("cd /");
      const otherUser = lines.findIndex((l) => !l.trimStart().startsWith("#") && /\b(sudo -u|runuser)\b/.test(l));
      expect(set).toBeGreaterThan(0);
      expect(cd).toBeGreaterThan(set);
      expect(lines.slice(set + 1, cd).every((l) => l === "" || l.startsWith("#"))).toBe(true);
      expect(otherUser).toBeGreaterThan(cd);
    });
  }

  test("split layout: §12 passes when the caller's folder is closed to the deploy user", () => {
    const r = runClone("split", true);
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(mode(join(r.appDir, "package.json"))).toBe("644");
    } finally {
      r.cleanup();
    }
  });
});

describe("node deploy", () => {
  function setup(withMigrateEnv: boolean) {
    const sb = makeDeploySandbox();
    writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:0a0b@127.0.0.1:5432/shop\n");
    if (withMigrateEnv) writeFileSync(sb.migrateEnvFile, "DATABASE_URL=postgresql://shop_owner:0c0d@127.0.0.1:5432/shop\n");
    mkdirSync(join(sb.appDir, ".git"), { recursive: true });
    mkdirSync(join(sb.appDir, "public"), { mode: 0o700 });
    writeFileSync(join(sb.appDir, "package.json"), "{}", { mode: 0o600 });
    writeFileSync(join(sb.appDir, "public", "i.css"), "x", { mode: 0o600 });
    writeFileSync(join(sb.appDir, ".git", "config"), "x", { mode: 0o600 });
    chmodSync(join(sb.appDir, ".git"), 0o700);
    const outside = join(sb.dir, "outside.txt");
    writeFileSync(outside, "x", { mode: 0o600 });
    symlinkSync(outside, join(sb.appDir, "link-out"));
    return { sb, outside };
  }

  test("split layout: unchanged files left owner-only get the read bits; .git and link targets do not", () => {
    const { sb, outside } = setup(true);
    try {
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: "5555555555555555555555555555555555555555" }));
      expect(res.status, res.stderr).toBe(0);
      expect(mode(join(sb.appDir, "package.json"))).toBe("644");
      expect(mode(join(sb.appDir, "public"))).toBe("755");
      expect(mode(join(sb.appDir, "public", "i.css"))).toBe("644");
      expect(mode(join(sb.appDir, ".git"))).toBe("700");
      expect(mode(join(sb.appDir, ".git", "config"))).toBe("600");
      expect(mode(outside)).toBe("600");
      expect(existsSync(join(sb.appDir, "dist", "release.txt"))).toBe(true);
      expect(mode(join(sb.appDir, "dist", "release.txt"))).toBe("644");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy layout (no migrate env file): modes unchanged", () => {
    const { sb } = setup(false);
    try {
      const res = sb.run(
        buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: "5555555555555555555555555555555555555555" }),
      );
      expect(res.status, res.stderr).toBe(0);
      expect(mode(join(sb.appDir, "package.json"))).toBe("600");
      expect(mode(join(sb.appDir, "public"))).toBe("700");
    } finally {
      sb.cleanup();
    }
  });
});
