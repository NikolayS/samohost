/**
 * Host-prep re-run on a node cp-http80 app whose main vhost an older samohost
 * wrote. Upstream main's host-prep wrote `<host> {\n\treverse_proxy
 * localhost:<port>\n}\n` with no provenance header; this version renders the
 * cp-http80 vhost with renderVhost. A live file byte-equal to the previous
 * form, or one that starts with samohost's provenance header, is upgraded in
 * place with a backup; any other differing file is still refused.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostPrepScript } from "../src/env/script.ts";
import { buildConfigHealScript, SAMOHOST_PROVENANCE_HEADER } from "../src/app/heal-script.ts";
import { planFromApp, previousNodeMainVhost, renderVhost } from "../src/caddy/render.ts";
import { nodeApp } from "./bootstrap-db-harness.ts";

const CP = "192.0.2.10";
const cpApp = () => nodeApp({ mainHost: "shop.example.com", mainListen: "cp-http80", appUser: "shop" });
const PREVIOUS = "shop.example.com {\n\treverse_proxy localhost:3100\n}\n";

function extractFn(script: string, name: string): string {
  const m = script.match(new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`));
  if (m === null) throw new Error(`bash function ${name}() not found`);
  return m[1]!;
}

/** The lines of the heredoc that starts at the line matching opener. */
function heredoc(script: string, opener: RegExp, terminator: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => opener.test(l));
  expect(start, `heredoc opener ${opener}`).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf(terminator, start + 1);
  return lines.slice(start + 1, end).join("\n") + "\n";
}

export function runGuard(opts: {
  live: string | null;
  staged: string;
  previous?: string;
  force?: boolean;
  validateExit?: number;
  reloadExit?: number;
}) {
  const script = buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP });
  const fn = extractFn(script, "samohost_apply_main_vhost");
  const dir = mkdtempSync(join(tmpdir(), "samohost-prev-vhost-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(
      join(bin, "caddy"),
      `#!/usr/bin/env bash\nprintf 'caddy %s\\n' "$*" >> '${log}'\n[[ "$1" == validate ]] && exit ${opts.validateExit ?? 0}\nexit 0\n`,
      { mode: 0o755 },
    );
    // sudo: record the user, run the command; /usr/bin/caddy is the caddy shim.
    writeFileSync(
      join(bin, "sudo"),
      [
        "#!/usr/bin/env bash",
        `printf 'sudo %s\\n' "$*" >> '${log}'`,
        "while [[ $# -gt 0 ]]; do case \"$1\" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done",
        'if [[ "$1" == /usr/bin/caddy ]]; then shift; exec caddy "$@"; fi',
        'exec "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "runuser"),
      `#!/usr/bin/env bash\nprintf 'runuser %s\\n' "$*" >> '${log}'\nwhile [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift\nif [[ "$1" == /usr/bin/caddy ]]; then shift; exec caddy "$@"; fi\nexec "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "systemctl"),
      `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> '${log}'\n[[ "$1" == reload ]] && exit ${opts.reloadExit ?? 0}\nexit 0\n`,
      { mode: 0o755 },
    );
    const sites = join(dir, "sites.d");
    mkdirSync(sites);
    const staged = join(sites, ".staged-00-main-shop.caddy");
    const live = join(sites, "00-main-shop.caddy");
    writeFileSync(staged, opts.staged);
    if (opts.live !== null) writeFileSync(live, opts.live);
    const previous = join(dir, "previous.caddy");
    if (opts.previous !== undefined) writeFileSync(previous, opts.previous);
    const prog = [
      "set -uo pipefail",
      fn,
      `samohost_apply_main_vhost '${staged}' '${live}' '${opts.force === true ? "true" : "false"}'${opts.previous !== undefined ? ` '${previous}'` : ""}`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` } });
    return {
      code: res.status,
      stderr: res.stderr,
      stdout: res.stdout,
      live: existsSync(live) ? readFileSync(live, "utf8") : null,
      backups: readdirSync(sites).filter((f) => f.startsWith("00-main-shop.caddy.bak.")).map((f) => readFileSync(join(sites, f), "utf8")),
      calls: existsSync(log) ? readFileSync(log, "utf8") : "",
      stagedLeft: existsSync(staged),
      previousLeft: existsSync(previous),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NEW = renderVhost(planFromApp(cpApp(), { trustedProxies: [CP] }));

describe("host-prep re-run — main vhost written by an older samohost", () => {
  test("previousNodeMainVhost is the form upstream main's host-prep wrote", () => {
    expect(previousNodeMainVhost(cpApp())).toBe(PREVIOUS);
  });

  test("the rendered host-prep passes the previous form to the guard for a node cp-http80 app", () => {
    const script = buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP });
    expect(heredoc(script, /<<'SAMOHOST_PREVIOUS_MAIN_VHOST'$/, "SAMOHOST_PREVIOUS_MAIN_VHOST")).toBe(PREVIOUS);
    expect(script).toMatch(/samohost_apply_main_vhost \\\n.*\n.*\n\s+false \\\n\s+"\$SAMOHOST_PREVIOUS_MAIN_VHOST"/);
  });

  test("a node app without cp-http80 passes no previous form", () => {
    const script = buildHostPrepScript(nodeApp({ mainHost: "shop.example.com" }), "samo");
    expect(script).not.toContain("SAMOHOST_PREVIOUS_MAIN_VHOST");
  });

  test("a live file byte-equal to the previous form is upgraded with a backup, validated and reloaded", () => {
    const r = runGuard({ live: PREVIOUS, staged: NEW, previous: PREVIOUS });
    expect(r.code, r.stderr).toBe(0);
    expect(r.live).toBe(NEW);
    expect(r.backups).toEqual([PREVIOUS]);
    expect(r.calls).toContain("caddy validate");
    expect(r.calls).toContain("systemctl reload caddy");
    expect(r.stagedLeft).toBe(false);
    expect(r.previousLeft).toBe(false);
  });

  test("a live file with samohost's provenance header (an older render) is upgraded with a backup", () => {
    const older = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com:80 {\n\treverse_proxy localhost:3100\n}\n`;
    const r = runGuard({ live: older, staged: NEW, previous: PREVIOUS });
    expect(r.code, r.stderr).toBe(0);
    expect(r.live).toBe(NEW);
    expect(r.backups).toEqual([older]);
  });

  test("a hand-authored file is still refused and left unchanged", () => {
    const hand = "http://shop.example.com:80 {\n\treverse_proxy /ws localhost:9000\n\treverse_proxy localhost:3100\n}\n";
    const r = runGuard({ live: hand, staged: NEW, previous: PREVIOUS });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("refusing to overwrite hand-authored/drifted main vhost");
    expect(r.live).toBe(hand);
    expect(r.calls).not.toContain("validate");
    expect(r.previousLeft).toBe(false);
  });

  test("an identical live file is a no-op", () => {
    const r = runGuard({ live: NEW, staged: NEW, previous: PREVIOUS });
    expect(r.code).toBe(0);
    expect(r.calls).toBe("");
    expect(r.previousLeft).toBe(false);
  });
});

/** Run the whole heal script with /etc/caddy in a sandbox and stub commands. */
function runHeal(live: string) {
  const script = buildConfigHealScript(cpApp(), { controlPlaneIp: CP });
  const dir = mkdtempSync(join(tmpdir(), "samohost-prev-heal-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("caddy", `printf 'caddy %s\\n' "$*" >> '${log}'`);
    stub("systemctl", `printf 'systemctl %s\\n' "$*" >> '${log}'`);
    stub("curl", "printf 200");
    stub("sleep", "exit 0");
    stub(
      "sudo",
      [
        `printf 'sudo %s\\n' "$*" >> '${log}'`,
        "while [[ $# -gt 0 ]]; do case \"$1\" in -n) shift ;; -l) shift ;; -u) shift 2 ;; *) break ;; esac; done",
        'c="$1"; shift; case "$c" in /usr/bin/*) c="${c#/usr/bin/}" ;; esac',
        'exec "$c" "$@"',
      ].join("\n"),
    );
    const etc = join(dir, "etc-caddy");
    mkdirSync(join(etc, "sites.d"), { recursive: true });
    writeFileSync(join(etc, "Caddyfile"), "{\n}\nimport sites.d/*.caddy\n");
    const livePath = join(etc, "sites.d", "00-main-shop.caddy");
    writeFileSync(livePath, live);
    const res = spawnSync("bash", ["-c", script.replaceAll("/etc/caddy", etc)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    return { code: res.status, out: res.stdout + res.stderr, live: readFileSync(livePath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("heal — main vhost written by an older samohost's host-prep", () => {
  test("a node cp-http80 main vhost byte-equal to the previous form is regenerated", () => {
    const r = runHeal(PREVIOUS);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("drift-foreign");
    expect(r.live).toBe(NEW);
    expect(r.out).toContain("<<<SAMOHOST_PHASE:heal:ok>>>");
  });

  test("a hand-authored main vhost without the header is still drift-foreign and unchanged", () => {
    const hand = "shop.example.com {\n\treverse_proxy localhost:3100\n\theader X-Hand 1\n}\n";
    const r = runHeal(hand);
    expect(r.out).toContain("drift-foreign");
    expect(r.live).toBe(hand);
  });
});
