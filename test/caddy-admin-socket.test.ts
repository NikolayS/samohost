/**
 * Caddy's admin API: the new layout moves it from TCP localhost:2019 (open
 * to every local process) to a unix socket in the caddy user's home. Once a
 * server has the socket, no bootstrap moves it back to TCP: every app kind
 * keeps the admin line when the current Caddyfile has it or a layout marker
 * on the server says split. The switch itself restarts Caddy; a Caddy that
 * does not come back is restored to the previous Caddyfile.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript, type HostBootstrapOptions } from "../src/app/bootstrap.ts";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { buildHostPrepScript } from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";
import { goldenCases } from "./bootstrap-golden-fixtures.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

const ADMIN = "  admin unix//var/lib/caddy/admin.sock";
const SOCKET_FILE = "# Caddy global options (ACME TLS — default).\n{\n" + ADMIN + "\n}\n\nimport sites.d/*.caddy\n";
const TCP_FILE = "# Caddy global options (ACME TLS — default).\n\nimport sites.d/*.caddy\n";

function section9(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §9."));
  const end = lines.findIndex((l, i) => i > start && /^# §(9b|9c|10|12|13)\./.test(l));
  return lines.slice(start, end - 1).join("\n");
}

type Run = {
  app?: AppRecord;
  opts?: HostBootstrapOptions;
  layout?: "split" | "legacy";
  caddyfile?: string;
  markers?: Record<string, string>;
  /** Exit codes of successive `systemctl reload caddy` calls; the last one repeats. */
  reloads?: number[];
  isActive?: number;
  restartFailsOnce?: boolean;
};

function run9(r: Run) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-caddy-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "argv.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const reloads = r.reloads ?? [1, 0];
  const counter = join(dir, "reload-count");
  const once = join(dir, "restarted-once");
  stub("caddy", "exit 0");
  stub(
    "systemctl",
    [
      `if [[ "$1" == reload ]]; then`,
      `  n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); echo $((n + 1)) > ${JSON.stringify(counter)}`,
      `  codes=(${reloads.join(" ")}); i=$(( n < \${#codes[@]} ? n : \${#codes[@]} - 1 )); exit "\${codes[$i]}"`,
      `fi`,
      `if [[ "$1" == is-active ]]; then exit ${r.isActive ?? 0}; fi`,
      `if [[ "$1" == restart && ${r.restartFailsOnce ? 1 : 0} == 1 && ! -e ${JSON.stringify(once)} ]]; then touch ${JSON.stringify(once)}; exit 1; fi`,
      "exit 0",
    ].join("\n"),
  );
  const etc = join(dir, "etc-caddy");
  mkdirSync(etc);
  if (r.caddyfile !== undefined) writeFileSync(join(etc, "Caddyfile"), r.caddyfile);
  const state = join(dir, "var-lib-samohost");
  mkdirSync(join(state, "db-layout"), { recursive: true });
  for (const [app, body] of Object.entries(r.markers ?? {})) writeFileSync(join(state, "db-layout", app), body);
  const text = section9(buildHostBootstrapScript(r.app ?? nodeApp(), r.opts ?? nodeOpts()))
    .replaceAll("/etc/caddy", etc)
    .replaceAll("/var/lib/samohost", state)
    .replace(/\/usr\/bin\/systemctl /g, "systemctl ");
  const layout = r.layout !== undefined ? `SAMOHOST_DB_LAYOUT=${r.layout}\n` : "";
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${layout}${text}`], {
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

function check(r: Run, fn: (out: ReturnType<typeof run9>) => void) {
  const out = run9(r);
  try {
    fn(out);
  } finally {
    out.cleanup();
  }
}

const restarts = (calls: string) => calls.split("\n").filter((l) => l === "systemctl restart caddy").length;

describe("Caddy admin API: switch to the unix socket (split layout)", () => {
  test("the base Caddyfile sets the admin socket; reload fails once and the restart switches", () => {
    check({ layout: "split", caddyfile: TCP_FILE }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toBe(SOCKET_FILE);
      expect(o.calls).toContain("caddy validate --config");
      expect(restarts(o.calls)).toBe(1);
    });
  });

  test("local TLS keeps local_certs next to the admin socket", () => {
    check({ layout: "split", caddyfile: TCP_FILE, opts: nodeOpts({ tlsMode: "local" }) }, (o) => {
      expect(o.caddyfile).toContain("{\n  local_certs\n" + ADMIN + "\n}\n");
    });
  });

  test("Caddy not active afterwards: the previous Caddyfile is restored and bootstrap stops", () => {
    check({ layout: "split", caddyfile: TCP_FILE, isActive: 3 }, (o) => {
      expect(o.res.status).toBe(1);
      expect(o.res.stderr).toContain("restoring the previous Caddyfile");
      expect(o.caddyfile).toBe(TCP_FILE);
    });
  });

  test("restart fails with the new Caddyfile: the previous one is restored and Caddy restarted", () => {
    check({ layout: "split", caddyfile: TCP_FILE, isActive: 3, restartFailsOnce: true }, (o) => {
      expect(o.res.status).toBe(1);
      expect(o.caddyfile).toBe(TCP_FILE);
      expect(restarts(o.calls)).toBe(2);
    });
  });

  test("after the switch, one reload over the socket proves that later reloads work", () => {
    check({ layout: "split", caddyfile: TCP_FILE, reloads: [1, 0] }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.calls.split("\n").filter((l) => l === "systemctl reload caddy").length).toBe(2);
      expect(restarts(o.calls)).toBe(1);
    });
  });

  test("reload over the socket fails: previous Caddyfile restored, Caddy restarted, message names the version", () => {
    check({ layout: "split", caddyfile: TCP_FILE, reloads: [1, 1] }, (o) => {
      expect(o.res.status).toBe(1);
      expect(o.res.stderr).toContain("Caddy 2.5.1 or later");
      expect(o.caddyfile).toBe(TCP_FILE);
      expect(restarts(o.calls)).toBe(2);
    });
  });

  test("socket already in use: a reload, no restart", () => {
    check({ layout: "split", caddyfile: SOCKET_FILE, reloads: [0] }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toBe(SOCKET_FILE);
      expect(restarts(o.calls)).toBe(0);
    });
  });
});

describe("Caddy admin API: no way back to TCP", () => {
  const legacyNode = { layout: "legacy" as const };
  const statics = goldenCases().map((c) => ({ name: c.file, app: c.app, opts: c.opts }));

  test("legacy node app on a server whose Caddyfile has the socket: kept", () => {
    check({ ...legacyNode, caddyfile: SOCKET_FILE, reloads: [0] }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toBe(SOCKET_FILE);
    });
  });

  test("legacy node app on a server with another app's split marker: socket written", () => {
    check({ ...legacyNode, caddyfile: TCP_FILE, markers: { other: "split\n" } }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toBe(SOCKET_FILE);
    });
  });

  for (const s of statics) {
    test(`static app (${s.name}) on a server whose Caddyfile has the socket: kept`, () => {
      check({ app: s.app, opts: s.opts, caddyfile: SOCKET_FILE, reloads: [0] }, (o) => {
        expect(o.res.status, o.res.stderr).toBe(0);
        expect(o.caddyfile).toBe(SOCKET_FILE);
      });
    });

    test(`static app (${s.name}) on a server with a split marker: socket written`, () => {
      check({ app: s.app, opts: s.opts, caddyfile: TCP_FILE, markers: { shop: "split\n" } }, (o) => {
        expect(o.res.status, o.res.stderr).toBe(0);
        expect(o.caddyfile).toBe(SOCKET_FILE);
      });
    });

    test(`static app (${s.name}) on a server without the socket or a marker: today's file and reload`, () => {
      check({ app: s.app, opts: s.opts, caddyfile: TCP_FILE, reloads: [0] }, (o) => {
        expect(o.res.status, o.res.stderr).toBe(0);
        expect(o.caddyfile).toBe(TCP_FILE);
        expect(o.calls.split("\n").filter((l) => l === "systemctl reload caddy").length).toBe(1);
        expect(restarts(o.calls)).toBe(0);
      });
    });
  }

  test("static release channel: a fresh base file gets the socket when a split marker exists", () => {
    const s = goldenCases()[0]!;
    const app = { ...s.app, releaseTagPattern: "v*" };
    check({ app, opts: s.opts, markers: { shop: "split\n" } }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toContain(ADMIN);
    });
  });

  test("legacy node app without the socket or a marker: today's file", () => {
    check({ ...legacyNode, caddyfile: TCP_FILE, reloads: [0] }, (o) => {
      expect(o.res.status, o.res.stderr).toBe(0);
      expect(o.caddyfile).toBe(TCP_FILE);
      expect(restarts(o.calls)).toBe(0);
    });
  });

  test("host-prep and heal never rewrite the base Caddyfile (host-prep only appends the import)", () => {
    const prep = buildHostPrepScript(nodeApp(), "samo");
    expect(prep).not.toMatch(/(?<!>)> \/etc\/caddy\/Caddyfile/);
    expect(prep).not.toMatch(/tee \/etc\/caddy\/Caddyfile/);
    const heal = buildConfigHealScript(nodeApp({ mainHost: "shop.example.com" }), { controlPlaneIp: "192.0.2.10" });
    expect(heal).not.toMatch(/> \/etc\/caddy\/Caddyfile|tee \/etc\/caddy\/Caddyfile|mv [^\n]* \/etc\/caddy\/Caddyfile/);
  });
});
