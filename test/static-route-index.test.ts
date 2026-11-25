/**
 * The static route names the index file: `try_files {path} {path}/index.html =404`.
 * On Caddy 2.11.9 the earlier `try_files {path} {path}/ =404` answered 404 for
 * a bare `/`. Every generator writes the new line; every place that compares a
 * live file with the expected one accepts the earlier line as samohost's own
 * output (and host-prep and heal replace it), and a file that differs in more
 * than that line is still refused.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostPrepScript, buildEnvCreateScript, buildCustomDomainVhostScript } from "../src/env/script.ts";
import { buildConfigHealScript, staticMainVhostLines } from "../src/app/heal-script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildDeployScript } from "../src/app/script.ts";
import { faviconVhostBodyLines } from "../src/caddy/favicon.ts";
import {
  PREVIOUS_STATIC_ROUTE_SED,
  PREVIOUS_STATIC_TRY_FILES,
  STATIC_TRY_FILES,
} from "../src/app/static-root.ts";
import type { AppRecord } from "../src/types.ts";
import { nodeApp } from "./bootstrap-db-harness.ts";

const NEW_LINE = "try_files {path} {path}/index.html =404";
const OLD_LINE = "try_files {path} {path}/ =404";

function siteApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-site-0001",
    vmId: "vm-site-0001",
    name: "site",
    kind: "static",
    repo: "example/site",
    branch: "main",
    appDir: "/opt/site/app",
    buildCmd: "true",
    healthUrl: "http://127.0.0.1/",
    serviceUnit: "site",
    mainHost: "site.example.com",
    mainListen: "cp-http80",
    appUser: "site",
    ...overrides,
  } as AppRecord;
}

/** Lines of a script that would write the earlier route (not the sed, a message or a comment). */
function oldRouteLines(script: string): string[] {
  return script
    .split("\n")
    .filter((l) => l.includes(OLD_LINE))
    .filter((l) => !l.includes(PREVIOUS_STATIC_ROUTE_SED))
    .filter((l) => !l.includes("older samohost"))
    .filter((l) => !l.trim().startsWith("#"))
    .filter((l) => !l.includes("grep -qsF"));
}

describe("generators write the route with the index file", () => {
  test("the constants", () => {
    expect(STATIC_TRY_FILES).toBe(NEW_LINE);
    expect(PREVIOUS_STATIC_TRY_FILES).toBe(OLD_LINE);
    expect(PREVIOUS_STATIC_ROUTE_SED).toBe(`sed 's|${OLD_LINE}|${NEW_LINE}|'`);
  });

  test("deploy: active-route snippet and main vhost", () => {
    const script = buildDeployScript(siteApp(), { sha: "a".repeat(40) } as never);
    expect(script).toContain(`root * "%s"\\n${NEW_LINE}\\nfile_server\\nencode gzip\\n`);
    expect(faviconVhostBodyLines("$R", "$S", "site", false).join("\n")).toContain(`\t\t${NEW_LINE}`);
    expect(oldRouteLines(script)).toEqual([]);
  });

  test("heal, host-prep, bootstrap and preview create", () => {
    const scripts = {
      heal: buildConfigHealScript(siteApp()),
      hostPrep: buildHostPrepScript(siteApp(), "samo"),
      bootstrap: buildHostBootstrapScript(siteApp(), { appUser: "site" } as never),
      preview: buildEnvCreateScript(siteApp({ mainListen: undefined }), {
        name: "site-pr-1",
        branch: "pr-1",
        port: 4100,
        vhost: "site-pr-1.samo.cat",
        dbBackend: "none",
        dbName: "site-pr-1",
      } as never),
    };
    for (const [name, s] of Object.entries(scripts)) {
      expect(s, name).toContain(NEW_LINE);
      expect(oldRouteLines(s), name).toEqual([]);
    }
    expect(staticMainVhostLines("x", "$R", "$S", false)).toContain(`\t${NEW_LINE}`);
  });

  test("node apps: the host-prep guard has no static route upgrade", () => {
    const s = buildHostPrepScript(nodeApp({ mainHost: "shop.example.com", mainListen: "cp-http80", appUser: "shop" }), "samo");
    expect(s).not.toContain(PREVIOUS_STATIC_ROUTE_SED);
  });
});

// ---------------------------------------------------------------------------
// host-prep: samohost_apply_main_vhost of a static app
// ---------------------------------------------------------------------------

function extractFn(script: string, name: string): string {
  const m = script.match(new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`));
  if (m === null) throw new Error(`bash function ${name}() not found`);
  return m[1]!;
}

const FRESH_NEW = `http://site.example.com {\n\troot * "/opt/site/app"\n\t${NEW_LINE}\n\tfile_server\n\tencode gzip\n}\n`;
const FRESH_OLD = FRESH_NEW.replace(NEW_LINE, OLD_LINE);

function runGuard(live: string | null, staged: string) {
  const fn = extractFn(buildHostPrepScript(siteApp(), "samo"), "samohost_apply_main_vhost");
  const dir = mkdtempSync(join(tmpdir(), "samohost-static-route-guard-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("caddy", `printf 'caddy %s\\n' "$*" >> '${log}'`);
    stub("systemctl", `printf 'systemctl %s\\n' "$*" >> '${log}'`);
    stub(
      "sudo",
      [
        `printf 'sudo %s\\n' "$*" >> '${log}'`,
        "while [[ $# -gt 0 ]]; do case \"$1\" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done",
        'if [[ "$1" == /usr/bin/caddy ]]; then shift; exec caddy "$@"; fi',
        'exec "$@"',
      ].join("\n"),
    );
    stub("mv", `a=(); for x in "$@"; do if [[ "$x" == -fT ]]; then a+=(-f); else a+=("$x"); fi; done\nexec /bin/mv "\${a[@]}"`);
    const sites = join(dir, "sites.d");
    mkdirSync(sites);
    const stagedPath = join(sites, ".staged-00-main-site.caddy");
    const livePath = join(sites, "00-main-site.caddy");
    writeFileSync(stagedPath, staged);
    if (live !== null) writeFileSync(livePath, live);
    const prog = ["set -uo pipefail", fn, `samohost_apply_main_vhost '${stagedPath}' '${livePath}' false`].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` } });
    return {
      code: res.status,
      out: res.stdout + res.stderr,
      live: existsSync(livePath) ? readFileSync(livePath, "utf8") : null,
      backups: readdirSync(sites).filter((f) => f.startsWith("00-main-site.caddy.bak.")).map((f) => readFileSync(join(sites, f), "utf8")),
      calls: existsSync(log) ? readFileSync(log, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("host-prep re-run — static main vhost", () => {
  test("the earlier route is upgraded in place without --force-main-vhost, with a backup", () => {
    const r = runGuard(FRESH_OLD, FRESH_NEW);
    expect(r.code, r.out).toBe(0);
    expect(r.live).toBe(FRESH_NEW);
    expect(r.backups).toEqual([FRESH_OLD]);
    expect(r.out).toContain("has the static route of an older samohost; replacing it with the current render (backup kept)");
    expect(r.calls).toContain("caddy validate --config /etc/caddy/Caddyfile");
    expect(r.calls).toContain("systemctl reload caddy");
  });

  test("the current route: no change, no backup, no reload", () => {
    const r = runGuard(FRESH_NEW, FRESH_NEW);
    expect(r.code, r.out).toBe(0);
    expect(r.live).toBe(FRESH_NEW);
    expect(r.backups).toEqual([]);
    expect(r.calls).toBe("");
  });

  test("a file that differs in more than the try_files line is still refused", () => {
    const hand = FRESH_OLD.replace("\tfile_server\n", "\tfile_server\n\theader X-Hand 1\n");
    const r = runGuard(hand, FRESH_NEW);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to overwrite hand-authored/drifted main vhost");
    expect(r.live).toBe(hand);
    expect(r.backups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bootstrap and custom domain: the compare lines, run on real files
// ---------------------------------------------------------------------------

/** Runs one rendered line with the named variables set to files holding the given texts. */
function runLine(line: string, files: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-static-route-cmp-"));
  try {
    const env: Record<string, string> = {};
    for (const [name, text] of Object.entries(files)) {
      const p = join(dir, name);
      if (text !== null) writeFileSync(p, text);
      env[name] = p;
    }
    const res = spawnSync("bash", ["-c", `set -euo pipefail\n${line}\necho ACCEPTED`], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: res.status, out: res.stdout + res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lineWith(script: string, needle: string): string {
  const found = script.split("\n").filter((l) => l.includes(needle));
  expect(found.length, needle).toBe(1);
  return found[0]!;
}

const ROUTE_NEW = `root * "/opt/site/releases/r1"\n${NEW_LINE}\nfile_server\nencode gzip\n`;
const ROUTE_OLD = ROUTE_NEW.replace(NEW_LINE, OLD_LINE);
const ROUTE_HAND = `${ROUTE_OLD}header X-Hand 1\n`;
const MAIN_NEW = staticMainVhostLines("http://site.example.com", "/opt/site/releases/r1", "/opt/site/releases/r1", false, "site").join("\n") + "\n";
const MAIN_OLD = MAIN_NEW.replace(NEW_LINE, OLD_LINE);
const MAIN_HAND = MAIN_OLD.replace("\t\tfile_server\n\t\tencode gzip", "\t\tfile_server\n\t\theader X-Hand 1\n\t\tencode gzip");

describe("bootstrap re-run — static route of an earlier samohost", () => {
  const script = buildHostBootstrapScript(siteApp(), { appUser: "site" } as never);
  const routeLine = lineWith(script, 'cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" "$SAMOHOST_ACTIVE_ROUTE"').trim();
  const mainLine = lineWith(script, '  cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST" ||').trim();
  const freshLine = lineWith(script, "not the canonical fresh route").trim();

  test("active deployment: the route and the main vhost with the current line pass", () => {
    expect(runLine(routeLine, { SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_NEW }).code).toBe(0);
    expect(runLine(mainLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: MAIN_NEW, SAMOHOST_MAIN_VHOST: MAIN_NEW }).code).toBe(0);
  });

  test("active deployment: the route and the main vhost with the earlier line are accepted", () => {
    const r1 = runLine(routeLine, { SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_OLD });
    expect(r1.code, r1.out).toBe(0);
    const r2 = runLine(mainLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: MAIN_NEW, SAMOHOST_MAIN_VHOST: MAIN_OLD });
    expect(r2.code, r2.out).toBe(0);
  });

  test("active deployment: files that differ in more than the try_files line are refused", () => {
    const r1 = runLine(routeLine, { SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_HAND });
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("active static route does not match structured deployment state");
    const r2 = runLine(mainLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: MAIN_NEW, SAMOHOST_MAIN_VHOST: MAIN_HAND });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("active static main vhost diverges from structured deployment state");
  });

  test("no deployment yet: the fresh route with the earlier line is accepted, a hand-edited one refused", () => {
    expect(runLine(freshLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: FRESH_NEW, SAMOHOST_MAIN_VHOST: FRESH_NEW }).code).toBe(0);
    const r = runLine(freshLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: FRESH_NEW, SAMOHOST_MAIN_VHOST: FRESH_OLD });
    expect(r.code, r.out).toBe(0);
    const hand = runLine(freshLine, { SAMOHOST_BOOTSTRAP_EXPECTED_MAIN: FRESH_NEW, SAMOHOST_MAIN_VHOST: `${FRESH_OLD}# hand\n` });
    expect(hand.code).toBe(1);
    expect(hand.out).toContain("is not the canonical fresh route");
  });
});

describe("custom domain — active route of an earlier samohost", () => {
  const script = buildCustomDomainVhostScript(siteApp(), "client.example");
  const line = lineWith(script, 'cmp -s "$EXPECTED_ROUTE" "$SAMOHOST_ACTIVE_ROUTE"').trim();

  test("current and earlier route accepted, a hand-edited route refused", () => {
    expect(runLine(line, { EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_NEW }).code).toBe(0);
    const r = runLine(line, { EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_OLD });
    expect(r.code, r.out).toBe(0);
    const hand = runLine(line, { EXPECTED_ROUTE: ROUTE_NEW, SAMOHOST_ACTIVE_ROUTE: ROUTE_HAND });
    expect(hand.code).toBe(1);
    expect(hand.out).toContain("active static route does not match structured release state");
  });
});
