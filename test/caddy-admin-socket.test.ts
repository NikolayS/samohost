/**
 * New layout: the base Caddyfile moves Caddy's admin API from TCP
 * localhost:2019 (open to every local process) to a unix socket in the
 * caddy user's home. A Caddy that does not come back is restored to the
 * previous Caddyfile. Static apps and the legacy layout are unchanged.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function section9(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §9."));
  const end = lines.findIndex((l, i) => i > start && /^# §(9b|9c|10)\./.test(l));
  return lines.slice(start, end - 1).join("\n");
}

function run9(layout: "split" | "legacy", isActive: "0" | "3", tlsMode?: "local") {
  const dir = mkdtempSync(join(tmpdir(), "samohost-caddy-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "argv.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("caddy", "exit 0");
  stub("systemctl", `if [[ "$1" == reload ]]; then exit 1; fi\nif [[ "$1" == is-active ]]; then exit ${isActive}; fi\nexit 0`);
  const etc = join(dir, "etc-caddy");
  mkdirSync(etc);
  writeFileSync(join(etc, "Caddyfile"), "# previous\nimport sites.d/*.caddy\n");
  const text = section9(buildHostBootstrapScript(nodeApp(), nodeOpts(tlsMode ? { tlsMode } : {})))
    .replaceAll("/etc/caddy", etc)
    .replace(/\/usr\/bin\/systemctl /g, "systemctl ");
  const res = spawnSync("bash", ["-c", `set -euo pipefail\nSAMOHOST_DB_LAYOUT=${layout}\n${text}`], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir },
  });
  return {
    res,
    caddyfile: readFileSync(join(etc, "Caddyfile"), "utf8"),
    calls: readFileSync(log, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Caddy admin API (split layout)", () => {
  test("the base Caddyfile sets the admin unix socket; reload fails once and the restart switches", () => {
    const r = run9("split", "0");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.caddyfile).toBe(
        "# Caddy global options (ACME TLS — default).\n{\n  admin unix//var/lib/caddy/admin.sock\n}\n\nimport sites.d/*.caddy\n",
      );
      expect(r.calls).toContain("caddy validate --config");
      expect(r.calls).toContain("systemctl restart caddy");
    } finally {
      r.cleanup();
    }
  });

  test("local TLS keeps local_certs next to the admin socket", () => {
    const r = run9("split", "0", "local");
    try {
      expect(r.caddyfile).toContain("{\n  local_certs\n  admin unix//var/lib/caddy/admin.sock\n}\n");
    } finally {
      r.cleanup();
    }
  });

  test("Caddy not active afterwards: the previous Caddyfile is restored and bootstrap stops", () => {
    const r = run9("split", "3");
    try {
      expect(r.res.status).toBe(1);
      expect(r.res.stderr).toContain("restoring the previous Caddyfile");
      expect(r.caddyfile).toBe("# previous\nimport sites.d/*.caddy\n");
    } finally {
      r.cleanup();
    }
  });

  test("legacy layout: today's base Caddyfile without an admin line", () => {
    const r = run9("legacy", "0");
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.caddyfile).toBe("# Caddy global options (ACME TLS — default).\n\nimport sites.d/*.caddy\n");
    } finally {
      r.cleanup();
    }
  });
});
