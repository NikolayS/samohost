/**
 * §4 copies the operator's authorized_keys to the deploy user. Root used
 * `install -d` and `install -o` into /home/<user>/.ssh, which follows a
 * symbolic link the deploy user placed there. In the new layout root
 * refuses links at .ssh and authorized_keys and copies the keys only when
 * the file is missing, writing it as the user. The legacy layout and static
 * apps keep today's lines.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function section4(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §4."));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# §5."));
  return lines.slice(start, end - 1).join("\n");
}

function run4(layout: "split" | "legacy", prepare: (ssh: string, dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-ssh-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "argv.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("id", "exit 0");
  stub("useradd", "exit 0");
  // install: create directories so later steps can write; log everything.
  stub("install", 'if [[ "$1" == -d ]]; then mkdir -p "${@: -1}"; fi');
  // sudo -u <user> <cmd...>: run <cmd...> as the test user.
  stub("sudo", 'if [[ "$1" == -u ]]; then shift 2; fi\nexec "$@"');
  mkdirSync(join(dir, "root", ".ssh"), { recursive: true });
  writeFileSync(join(dir, "root", ".ssh", "authorized_keys"), "ssh-ed25519 AAAAoperator\n");
  const ssh = join(dir, "home", "shop", ".ssh");
  mkdirSync(join(dir, "home", "shop"), { recursive: true });
  prepare(ssh, dir);
  const body = section4(buildHostBootstrapScript(nodeApp(), nodeOpts()))
    .replaceAll("/root/.ssh", join(dir, "root", ".ssh"))
    .replaceAll("/home/", `${join(dir, "home")}/`);
  const res = spawnSync("bash", ["-c", `set -euo pipefail\nSAMOHOST_DB_LAYOUT=${layout}\n${body}`], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { dir, ssh, res, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("§4 authorized_keys copy", () => {
  test("new layout, no keys yet: written as the user, not by a root install -o", () => {
    const r = run4("split");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(readFileSync(join(r.ssh, "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAAoperator\n");
      expect(r.calls).toContain("sudo -u shop install -d -m 700");
      expect(r.calls).not.toMatch(/^install .*-o shop/m);
    } finally {
      r.cleanup();
    }
  });

  test("new layout, keys present: kept unchanged", () => {
    const r = run4("split", (ssh) => {
      mkdirSync(ssh);
      writeFileSync(join(ssh, "authorized_keys"), "ssh-ed25519 AAAAown\n");
    });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(readFileSync(join(r.ssh, "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAAown\n");
    } finally {
      r.cleanup();
    }
  });

  test("new layout: a symbolic link at .ssh stops bootstrap", () => {
    const r = run4("split", (ssh, dir) => {
      mkdirSync(join(dir, "target"));
      symlinkSync(join(dir, "target"), ssh);
    });
    try {
      expect(r.res.status).toBe(1);
      expect(r.res.stderr).toContain("is a symbolic link");
      expect(existsSync(join(r.dir, "target", "authorized_keys"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("new layout: a symbolic link at authorized_keys stops bootstrap", () => {
    const r = run4("split", (ssh, dir) => {
      mkdirSync(ssh);
      writeFileSync(join(dir, "victim"), "keep\n");
      symlinkSync(join(dir, "victim"), join(ssh, "authorized_keys"));
    });
    try {
      expect(r.res.status).toBe(1);
      expect(readFileSync(join(r.dir, "victim"), "utf8")).toBe("keep\n");
    } finally {
      r.cleanup();
    }
  });

  test("legacy layout: today's root install lines", () => {
    const r = run4("legacy");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.calls).toMatch(/^install -d -m 700 -o shop -g shop .*\/home\/shop\/\.ssh$/m);
      expect(r.calls).toMatch(/^install -m 600 -o shop -g shop .*\/authorized_keys$/m);
    } finally {
      r.cleanup();
    }
  });
});
