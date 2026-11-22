/**
 * §0 writes and chmods the GitHub token file as root. On a server where the
 * deploy user still owns /opt/<app> (every legacy server, and an older
 * new-layout server before §5 runs), a symbolic link at /opt/<app> or at the
 * token file would point that write or chmod at another file. §0 refuses
 * both, in all layouts. The rest of §0 is unchanged.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { goldenCases } from "./bootstrap-golden-fixtures.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function section0(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §0."));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# §1."));
  return lines.slice(start, end - 1).join("\n");
}

function run0(prepare: (dir: string, base: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-token-"));
  const base = join(dir, "opt-shop");
  prepare(dir, base);
  const body = section0(buildHostBootstrapScript(nodeApp(), nodeOpts())).replaceAll("/opt/shop", base);
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${body}\necho PASSED`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  return { dir, base, res, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("§0 token file: no symbolic links", () => {
  test("a symbolic link at the token file stops bootstrap; the target keeps its mode and content", () => {
    const r = run0((dir, base) => {
      mkdirSync(base);
      writeFileSync(join(dir, "victim"), "keep\n", { mode: 0o644 });
      symlinkSync(join(dir, "victim"), join(base, ".gh-token"));
    });
    try {
      expect(r.res.status).toBe(1);
      expect(r.res.stderr).toContain("is a symbolic link");
      expect(statSync(join(r.dir, "victim")).mode & 0o777).toBe(0o644);
      expect(readFileSync(join(r.dir, "victim"), "utf8")).toBe("keep\n");
    } finally {
      r.cleanup();
    }
  });

  test("a symbolic link at /opt/<app> stops bootstrap before mkdir", () => {
    const r = run0((dir, base) => {
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), base);
    });
    try {
      expect(r.res.status).toBe(1);
      expect(r.res.stderr).toContain("is a symbolic link");
      expect(existsSync(join(r.dir, "elsewhere", ".gh-token"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("a regular pre-placed token file is still used and set to 600", () => {
    const r = run0((_dir, base) => {
      mkdirSync(base);
      writeFileSync(join(base, ".gh-token"), "x", { mode: 0o644 });
    });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(statSync(join(r.base, ".gh-token")).mode & 0o777).toBe(0o600);
    } finally {
      r.cleanup();
    }
  });

  test("static scripts get the same two refusals", () => {
    for (const c of goldenCases()) {
      const s0 = section0(buildHostBootstrapScript(c.app, c.opts));
      expect(s0.match(/is a symbolic link/g)?.length, c.file).toBe(2);
    }
  });
});
