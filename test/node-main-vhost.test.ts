/**
 * Main vhost of a node app with the split env layout
 * (/etc/caddy/sites.d/00-main-<app>.caddy).
 *
 * Bootstrap, as root, writes the vhost from values fixed at bootstrap (host
 * name, port, control-plane address) with the same text that `app heal`
 * renders, has Caddy validate the whole configuration as the caddy user
 * (which creates the vhost's log file as caddy), and reloads Caddy. Heal
 * validates through the exact rule `sudo -u caddy /usr/bin/caddy validate
 * --config /etc/caddy/Caddyfile`, and its rollback removes a vhost file that
 * it created.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildConfigHealScript, SAMOHOST_PROVENANCE_HEADER } from "../src/app/heal-script.ts";
import { mainVhostTrustedProxies, planFromApp, renderVhost } from "../src/caddy/render.ts";
import { goldenNodeApp, goldenNodeOpts } from "./bootstrap-golden-fixtures.ts";

const VALIDATE_AS_CADDY = "sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile";
/** Heal runs as the deploy user: non-interactive sudo, so a missing rule fails at once. */
const HEAL_VALIDATE_AS_CADDY = "sudo -n -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile";
const CONTROL_PLANE = "192.0.2.10";

/** The vhost text that `app heal` renders for the golden node app. */
function healRender(): string {
  const app = goldenNodeApp();
  return renderVhost(planFromApp(app, { trustedProxies: mainVhostTrustedProxies(app, CONTROL_PLANE) }));
}

/** Lines from the `# §<from>.` heading up to the line before the `# §<to>.` heading. */
function section(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`# §${from}.`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith(`# §${to}.`));
  expect(start, `§${from} heading`).toBeGreaterThan(0);
  expect(end, `§${to} heading`).toBeGreaterThan(start);
  return lines.slice(start, end - 1).join("\n");
}

/**
 * Sandbox with stub sudo (logs the call, drops `-u <user>`, runs the command
 * from the stubs or the system), caddy (fails when $T_CADDY_FAIL=1),
 * systemctl, curl (prints $T_CURL_CODE) and sleep. /etc/caddy/ and the step
 * script path are moved into the sandbox by the caller.
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "samohost-main-vhost-"));
  const bin = join(dir, "bin");
  const caddyDir = join(dir, "etc-caddy");
  mkdirSync(bin);
  mkdirSync(join(caddyDir, "sites.d"), { recursive: true });
  writeFileSync(join(caddyDir, "Caddyfile"), "import sites.d/*.caddy\n");
  const log = join(dir, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // sudo -l answers whether the caddy validate rule exists (T_CADDY_RULE=1).
  stub("sudo", ['if [[ " $* " == *" -l "* ]]; then [[ "${T_CADDY_RULE:-0}" == 1 ]]; exit $?; fi', 'while [[ "$1" == -n || "$1" == -u ]]; do if [[ "$1" == -u ]]; then shift 2; else shift; fi; done', 'c="$1"; shift', 'exec "${c#/usr/bin/}" "$@"'].join("\n"));
  stub("caddy", 'if [[ "${T_CADDY_FAIL:-0}" == 1 ]]; then echo "caddy: invalid config" >&2; exit 1; fi');
  stub("systemctl", 'if [[ "${T_RELOAD_FAIL:-0}" == 1 ]]; then echo "reload failed" >&2; exit 1; fi');
  stub("curl", 'printf "%s" "${T_CURL_CODE:-200}"');
  stub("sleep", "exit 0");
  // GNU mv -T is not in macOS mv; the targets here are files, so mv -f is the same.
  stub("mv", 'a=(); for x in "$@"; do if [[ "$x" == -fT ]]; then a+=(-f); else a+=("$x"); fi; done\nexec /bin/mv "${a[@]}"');
  const run = (text: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", text.replaceAll("/etc/caddy/", `${caddyDir}/`).replaceAll(" /usr/bin/systemctl ", " systemctl ")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, ...env },
    });
  return {
    dir,
    vhost: join(caddyDir, "sites.d", "00-main-shop.caddy"),
    run,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "").replaceAll(`${caddyDir}/`, "/etc/caddy/"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("bootstrap: main vhost of a split-layout node app", () => {
  const script = () => buildHostBootstrapScript(goldenNodeApp(), goldenNodeOpts());
  const mainSection = () => section(script(), "12b", "13");
  const runSection = (sb: ReturnType<typeof sandbox>, layout: string, env: Record<string, string> = {}) =>
    sb.run(`set -euo pipefail\nSAMOHOST_DB_LAYOUT=${layout}\n${mainSection()}`, env);

  test("the vhost text in the script is the text that heal renders (heal then finds no drift)", () => {
    expect(mainSection()).toContain(healRender().replace(/\n$/, ""));
    expect(healRender().split("\n")[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
  });

  test("fresh server: writes the vhost, validates as the caddy user, then reloads Caddy once", () => {
    const sb = sandbox();
    try {
      const res = runSection(sb, "split");
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(sb.vhost, "utf8")).toBe(healRender());
      const calls = sb.calls().split("\n").filter((l) => l !== "");
      const validate = calls.indexOf(VALIDATE_AS_CADDY);
      expect(validate, sb.calls()).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("systemctl reload caddy")).toBeGreaterThan(validate);
      expect(calls.filter((l) => l.startsWith("caddy ") && !l.includes("validate"))).toEqual([]);
    } finally {
      sb.cleanup();
    }
  });

  test("re-run with the same vhost: no write, no reload", () => {
    const sb = sandbox();
    try {
      writeFileSync(sb.vhost, healRender());
      const res = runSection(sb, "split");
      expect(res.status, res.stderr).toBe(0);
      expect(sb.calls()).not.toContain("systemctl reload caddy");
    } finally {
      sb.cleanup();
    }
  });

  test("an older samohost vhost (with the header) is replaced; a hand-written one (no header) is kept with a warning", () => {
    const sb = sandbox();
    try {
      writeFileSync(sb.vhost, `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com {\n}\n`);
      expect(runSection(sb, "split").status).toBe(0);
      expect(readFileSync(sb.vhost, "utf8")).toBe(healRender());
      writeFileSync(sb.vhost, "http://shop.example.com {\n\trespond 200\n}\n");
      const res = runSection(sb, "split");
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("WARNING");
      expect(readFileSync(sb.vhost, "utf8")).toBe("http://shop.example.com {\n\trespond 200\n}\n");
    } finally {
      sb.cleanup();
    }
  });

  test("validation fails: a new vhost is removed, a previous one restored, no reload, exit 1", () => {
    const sb = sandbox();
    try {
      let res = runSection(sb, "split", { T_CADDY_FAIL: "1" });
      expect(res.status).toBe(1);
      expect(existsSync(sb.vhost)).toBe(false);
      const old = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com {\n}\n`;
      writeFileSync(sb.vhost, old);
      res = runSection(sb, "split", { T_CADDY_FAIL: "1" });
      expect(res.status).toBe(1);
      expect(readFileSync(sb.vhost, "utf8")).toBe(old);
      expect(sb.calls()).not.toContain("systemctl reload caddy");
    } finally {
      sb.cleanup();
    }
  });

  test("reload fails: the previous vhost is restored, exit 1", () => {
    const sb = sandbox();
    try {
      const old = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com {\n}\n`;
      writeFileSync(sb.vhost, old);
      const res = runSection(sb, "split", { T_RELOAD_FAIL: "1" });
      expect(res.status).toBe(1);
      expect(readFileSync(sb.vhost, "utf8")).toBe(old);
      expect(existsSync(join(sb.dir, "etc-caddy", "sites.d", ".00-main-shop.caddy.next"))).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  test("the vhost is written to a dot file in sites.d and moved into place", () => {
    expect(mainSection()).toContain('mv -fT "$SAMOHOST_MAIN_VHOST_TMP" "$SAMOHOST_MAIN_VHOST"');
    expect(mainSection()).toContain("SAMOHOST_MAIN_VHOST_TMP='/etc/caddy/sites.d/.00-main-shop.caddy.next'");
  });

  test("sites.d that is a symbolic link: error, nothing written", () => {
    const sb = sandbox();
    try {
      const sites = join(sb.dir, "etc-caddy", "sites.d");
      const real = join(sb.dir, "elsewhere");
      mkdirSync(real);
      rmSync(sites, { recursive: true });
      spawnSync("ln", ["-s", real, sites]);
      const res = runSection(sb, "split");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("/sites.d is not a folder owned by root");
      expect(spawnSync("ls", ["-A", real], { encoding: "utf8" }).stdout).toBe("");
    } finally {
      sb.cleanup();
    }
  });

  test("a symbolic link at the vhost path: error, nothing written", () => {
    const sb = sandbox();
    try {
      const target = join(sb.dir, "target");
      writeFileSync(target, "x\n");
      spawnSync("ln", ["-s", target, sb.vhost]);
      const res = runSection(sb, "split");
      expect(res.status).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("x\n");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy layout: the section changes nothing (host-prep writes the vhost there)", () => {
    const sb = sandbox();
    try {
      const res = runSection(sb, "legacy");
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(sb.vhost)).toBe(false);
      expect(sb.calls()).toBe("");
    } finally {
      sb.cleanup();
    }
  });

  test("the section comes after the clone and before the self-check; apps without mainHost have none", () => {
    const text = script();
    expect(text.indexOf("# §12b.")).toBeGreaterThan(text.indexOf("# §12."));
    expect(text.indexOf("# §13.")).toBeGreaterThan(text.indexOf("# §12b."));
    const { mainHost: _omit, ...noHost } = goldenNodeApp();
    expect(buildHostBootstrapScript(noHost, goldenNodeOpts())).not.toContain("# §12b.");
  });
});

describe("heal: node app on a split-layout server", () => {
  const heal = () => buildConfigHealScript(goldenNodeApp(), { controlPlaneIp: CONTROL_PLANE });
  const runHeal = (sb: ReturnType<typeof sandbox>, env: Record<string, string> = {}) => {
    const step = join(sb.dir, "step");
    writeFileSync(step, "#!/bin/sh\n");
    chmodSync(step, 0o755);
    return sb.run(heal().replaceAll("/usr/local/lib/samohost/apps/shop/step", step), { T_CADDY_RULE: "1", ...env });
  };

  test("validates through the exact caddy rule (the caddy user can open the vhost's log file)", () => {
    const sb = sandbox();
    try {
      const res = runHeal(sb);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("main vhost: created");
      expect(sb.calls()).toContain(HEAL_VALIDATE_AS_CADDY);
      expect(readFileSync(sb.vhost, "utf8")).toBe(healRender());
    } finally {
      sb.cleanup();
    }
  });

  test("the healthy app's vhost written by bootstrap: no drift, no reload", () => {
    const sb = sandbox();
    try {
      writeFileSync(sb.vhost, healRender());
      const res = runHeal(sb);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("main vhost: no drift");
      expect(sb.calls()).not.toContain("systemctl reload caddy");
    } finally {
      sb.cleanup();
    }
  });

  test("rollback removes a vhost file that heal created", () => {
    const sb = sandbox();
    try {
      const res = runHeal(sb, { T_CADDY_FAIL: "1" });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("main vhost: created");
      expect(existsSync(sb.vhost)).toBe(false);
      expect(sb.calls()).toContain("sudo /usr/bin/rm -f /etc/caddy/sites.d/00-main-shop.caddy");
    } finally {
      sb.cleanup();
    }
  });

  test("rollback restores a previous vhost and does not remove it", () => {
    const sb = sandbox();
    try {
      const old = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com {\n}\n`;
      writeFileSync(sb.vhost, old);
      const res = runHeal(sb, { T_CADDY_FAIL: "1" });
      expect(res.status).toBe(1);
      expect(readFileSync(sb.vhost, "utf8")).toBe(old);
      expect(sb.calls()).not.toContain("sudo /usr/bin/rm -f /etc/caddy/sites.d/00-main-shop.caddy");
    } finally {
      sb.cleanup();
    }
  });

  test("a deploy user without the caddy validate sudo rule validates as itself, as before", () => {
    const sb = sandbox();
    try {
      const res = sb.run(heal());
      expect(res.status, res.stderr).toBe(0);
      expect(sb.calls()).not.toContain("-u caddy");
      expect(sb.calls()).toContain("caddy validate --config /etc/caddy/Caddyfile");
    } finally {
      sb.cleanup();
    }
  });
});

describe("bootstrap: the main vhost is rendered only from a valid host name and plain lines", () => {
  const withRoute = (body: string, matchPath = "/x") => ({
    ...goldenNodeApp(),
    services: [{ name: "web", unit: "shop", listeners: [{ name: "web", port: 3000, portEnv: "PORT" }] }],
    defaultListener: "web",
    routes: [{ matchPath, respond: { status: 200, body } }],
  });

  test("a mainHost that is not a dotted lowercase DNS name: error before any script text", () => {
    for (const host of ["shop.example.com\nSAMOHOST_MAIN_VHOST_CONTENT", "Shop.Example.com", "shop example.com", ""]) {
      expect(() => buildHostBootstrapScript({ ...goldenNodeApp(), mainHost: host }, goldenNodeOpts()), JSON.stringify(host)).toThrow(/mainHost/);
    }
  });

  test("a rendered vhost line equal to the heredoc delimiter: error", () => {
    expect(() => buildHostBootstrapScript(withRoute("a\nSAMOHOST_MAIN_VHOST_CONTENT\nb"), goldenNodeOpts())).toThrow(/main vhost/);
    expect(() => buildHostBootstrapScript(withRoute("ok", "/x\nSAMOHOST_MAIN_VHOST_CONTENT"), goldenNodeOpts())).toThrow(/main vhost/);
  });

  test("a rendered vhost line with a control character: error", () => {
    expect(() => buildHostBootstrapScript(withRoute("a\u0007b"), goldenNodeOpts())).toThrow(/main vhost/);
    expect(() => buildHostBootstrapScript(withRoute("a\rb"), goldenNodeOpts())).toThrow(/main vhost/);
  });

  test("plain routes still render", () => {
    expect(buildHostBootstrapScript(withRoute("not here"), goldenNodeOpts())).toContain("# §12b.");
  });
});
