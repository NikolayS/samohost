/**
 * Deploy and heal scripts run as the deploy user. On a server where another
 * app's vhost names a log file in /var/log/caddy (owned by caddy, mode 600),
 * `caddy validate` as the deploy user cannot open that file. The scripts
 * validate through the exact sudo rule
 * `(caddy) /usr/bin/caddy validate --config /etc/caddy/Caddyfile` when the
 * deploy user has it, and as the deploy user otherwise (servers whose apps
 * were bootstrapped before the rule). Bootstrap writes the rule for static,
 * legacy and new-layout deploy users.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CADDY_VALIDATE_FN_LINES } from "../src/caddy/validate.ts";
import { buildDeployScript } from "../src/app/script.ts";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

function runFn(opts: { ruleExists: boolean; validateExit: number }) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-caddy-validate-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(join(bin, "caddy"), `#!/usr/bin/env bash\nprintf 'caddy %s\\n' "$*" >> '${log}'\nexit ${opts.validateExit}\n`, { mode: 0o755 });
    writeFileSync(
      join(bin, "sudo"),
      [
        "#!/usr/bin/env bash",
        `printf 'sudo %s\\n' "$*" >> '${log}'`,
        `if [[ "$*" == *" -l "* ]]; then exit ${opts.ruleExists ? 0 : 1}; fi`,
        'while [[ $# -gt 0 ]]; do case "$1" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done',
        'c="$1"; shift; if [[ "$c" == /usr/bin/caddy ]]; then c=caddy; fi',
        'exec "$c" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const prog = ["set -euo pipefail", ...CADDY_VALIDATE_FN_LINES, "if samohost_caddy_validate; then echo VALID; else echo INVALID; fi"].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    return { out: res.stdout, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const staticApp = () =>
  nodeApp({ kind: "static", mainHost: "site.example.com", appUser: "shop", envFile: undefined, migrateCmd: undefined, rlsUrlVar: undefined, assertions: undefined });

describe("samohost_caddy_validate", () => {
  test("with the sudo rule: validates as the caddy user", () => {
    const r = runFn({ ruleExists: true, validateExit: 0 });
    expect(r.out).toBe("VALID\n");
    expect(r.calls).toContain("sudo -n -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile");
  });

  test("without the sudo rule: validates as the deploy user, as before", () => {
    const r = runFn({ ruleExists: false, validateExit: 0 });
    expect(r.out).toBe("VALID\n");
    expect(r.calls).not.toContain("sudo -n -u caddy");
    expect(r.calls).toContain("caddy validate --config /etc/caddy/Caddyfile");
  });

  test("an invalid config fails on both paths", () => {
    expect(runFn({ ruleExists: true, validateExit: 1 }).out).toBe("INVALID\n");
    expect(runFn({ ruleExists: false, validateExit: 1 }).out).toBe("INVALID\n");
  });
});

describe("deploy and heal scripts use samohost_caddy_validate", () => {
  const scripts: Array<[string, () => string]> = [
    ["static deploy", () => buildDeployScript(staticApp(), { sha: "5555555555555555555555555555555555555555" })],
    ["static heal", () => buildConfigHealScript(staticApp())],
    ["node heal", () => buildConfigHealScript(nodeApp({ mainHost: "shop.example.com" }))],
  ];
  for (const [label, render] of scripts) {
    test(`${label}: no direct caddy validate call`, () => {
      const text = render();
      expect(text).toContain("samohost_caddy_validate() {");
      const direct = text
        .split("\n")
        .filter((l) => /(^|[\s;(|&])caddy validate /.test(l) && !l.trimStart().startsWith("#"));
      // The only direct call is the fallback inside the function.
      expect(direct).toEqual(["    caddy validate --config /etc/caddy/Caddyfile >/dev/null"]);
    });
  }
});

describe("bootstrap — the deploy user's sudo rule for validation as caddy", () => {
  const rule = "shop ALL=(caddy) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile";
  test("static app", () => {
    expect(buildHostBootstrapScript(staticApp(), { appUser: "shop" })).toContain(`\n${rule}\n`);
  });
  test("node app: the legacy and the new-layout sudoers both have it", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script.split(`\n${rule}\n`).length - 1).toBe(2);
  });
});
