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
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";

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
    // GNU mv -T is not in macOS mv; the targets here are files, so mv -f is the same.
    writeFileSync(
      join(bin, "mv"),
      `#!/usr/bin/env bash\nprintf 'mv %s\\n' "$*" >> '${log}'\na=(); for x in "$@"; do if [[ "$x" == -fT ]]; then a+=(-f); else a+=("$x"); fi; done\nexec /bin/mv "\${a[@]}"\n`,
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
      sites: readdirSync(sites),
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

/**
 * Run the whole heal script with /etc/caddy, $HOME and $TMPDIR in a sandbox
 * and stub commands. `rule` is whether the deploy user has the sudo rule to
 * validate as caddy (sudo -n -l answers it). `failNewVhost` makes validation
 * fail while the live vhost is the current render. `codes` are the HTTP codes
 * curl answers, one per call; the last one repeats.
 */
function runHeal(live: string | null, opts: { rule?: boolean; failNewVhost?: boolean; codes?: string[] } = {}) {
  const script = buildConfigHealScript(cpApp(), { controlPlaneIp: CP });
  const dir = mkdtempSync(join(tmpdir(), "samohost-prev-heal-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const home = join(dir, "home");
    const tmp = join(dir, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    const log = join(dir, "calls.log");
    const etc = join(dir, "etc-caddy");
    const livePath = join(etc, "sites.d", "00-main-shop.caddy");
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub(
      "caddy",
      [
        `printf 'caddy %s\\n' "$*" >> '${log}'`,
        ...(opts.failNewVhost === true ? [`if [[ "$1" == validate ]] && grep -q trusted_proxies '${livePath}' 2>/dev/null; then echo "caddy: invalid" >&2; exit 1; fi`] : []),
        "exit 0",
      ].join("\n"),
    );
    stub("systemctl", `printf 'systemctl %s\\n' "$*" >> '${log}'`);
    const codes = opts.codes ?? ["200"];
    const counter = join(dir, "curl.count");
    stub(
      "curl",
      [
        `n=$(cat '${counter}' 2>/dev/null || echo 0); echo $((n + 1)) > '${counter}'`,
        `codes=(${codes.join(" ")}); i=$n; if (( i >= \${#codes[@]} )); then i=$(( \${#codes[@]} - 1 )); fi`,
        'printf "%s" "${codes[$i]}"',
      ].join("\n"),
    );
    stub("sleep", "exit 0");
    stub(
      "sudo",
      [
        `printf 'sudo %s\\n' "$*" >> '${log}'`,
        `if [[ " $* " == *" -l "* ]]; then exit ${opts.rule === false ? 1 : 0}; fi`,
        "while [[ $# -gt 0 ]]; do case \"$1\" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done",
        'c="$1"; shift; case "$c" in /usr/bin/*) c="${c#/usr/bin/}" ;; esac',
        'exec "$c" "$@"',
      ].join("\n"),
    );
    mkdirSync(join(etc, "sites.d"), { recursive: true });
    writeFileSync(join(etc, "Caddyfile"), "{\n}\nimport sites.d/*.caddy\n");
    if (live !== null) writeFileSync(livePath, live);
    const res = spawnSync("bash", ["-c", script.replaceAll("/etc/caddy", etc)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: home, TMPDIR: tmp },
    });
    const backupDir = join(home, "samohost-backups");
    return {
      code: res.status,
      out: res.stdout + res.stderr,
      live: existsSync(livePath) ? readFileSync(livePath, "utf8") : null,
      sites: readdirSync(join(etc, "sites.d")),
      tmpLeft: readdirSync(tmp),
      kept: existsSync(backupDir) ? readdirSync(backupDir).map((f) => ({ name: f, text: readFileSync(join(backupDir, f), "utf8") })) : [],
      calls: existsSync(log) ? readFileSync(log, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The outcome `app heal` reports for this output (src/commands/app.ts parseHealOutcome). */
function outcomeOf(out: string): string {
  if (out.includes("<<<SAMOHOST_PHASE:no-drift:ok>>>")) return "no-drift";
  if (out.includes("<<<SAMOHOST_PHASE:rollback:fail>>>")) return "rollback-failed";
  if (out.includes("<<<SAMOHOST_PHASE:rollback:ok>>>")) return "rolled-back";
  if (out.includes("<<<SAMOHOST_PHASE:heal:ok>>>")) return out.includes("drift-foreign:") ? "drift-foreign" : "healed";
  return "incomplete";
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

  test("the previous form without the caddy validate sudo rule: drift-foreign, exit 0, the file byte-identical, no backup written", () => {
    const r = runHeal(PREVIOUS, { rule: false });
    expect(r.code, r.out).toBe(0);
    expect(outcomeOf(r.out)).toBe("drift-foreign");
    expect(r.live).toBe(PREVIOUS);
    expect(r.sites).toEqual(["00-main-shop.caddy"]);
    expect(r.tmpLeft).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(r.calls).not.toContain("tee");
    // Only the sudo -n -l check of the rule names the validation; nothing validates.
    expect(r.calls).not.toMatch(/^caddy validate/m);
    expect(r.calls).not.toContain("sudo -n -u caddy");
    expect(r.calls).not.toContain("systemctl reload");
    expect(r.out.split("\n").filter((l) => l.includes("host-prep or a bootstrap re-run")).length).toBe(1);
  });

  test("the previous form with the caddy validate sudo rule: upgraded, a backup of it kept, no drift on the next heal", () => {
    const r = runHeal(PREVIOUS, { rule: true });
    expect(r.code, r.out).toBe(0);
    expect(outcomeOf(r.out)).toBe("healed");
    expect(r.live).toBe(NEW);
    expect(r.kept.map((k) => k.text)).toEqual([PREVIOUS]);
    expect(r.kept[0]!.name).toMatch(/^00-main-shop\.caddy\.bak\.\d{8}T\d{6}Z$/);
    // Validated as caddy before the write and after it.
    expect(r.calls.split("\n").filter((l) => l.startsWith("sudo -n -u caddy /usr/bin/caddy validate --config ")).length).toBe(2);
    expect(r.sites).toEqual(["00-main-shop.caddy"]);
    expect(r.tmpLeft).toEqual([]);
    const again = runHeal(NEW, { rule: true });
    expect(again.code, again.out).toBe(0);
    expect(outcomeOf(again.out)).toBe("no-drift");
    expect(again.kept).toEqual([]);
  });

  test("the previous form with the rule and a failed validation of the new file: previous file restored, rolled back cleanly, no new file", () => {
    // The previous form answered with a redirect before the change, and after the restore.
    const r = runHeal(PREVIOUS, { rule: true, failNewVhost: true, codes: ["308"] });
    expect(r.code).toBe(1);
    expect(r.live).toBe(PREVIOUS);
    expect(outcomeOf(r.out)).toBe("rolled-back");
    expect(r.sites).toEqual(["00-main-shop.caddy"]);
    expect(r.tmpLeft).toEqual([]);
    expect(r.kept).toEqual([]);
    // Caddy was not reloaded with the change: the rollback does not reload it either.
    expect(r.calls).not.toContain("systemctl reload");
  });

  test("a hand-authored main vhost with the rule is still drift-foreign and unchanged", () => {
    const hand = "shop.example.com {\n\treverse_proxy localhost:3100\n\theader X-Hand 1\n}\n";
    const r = runHeal(hand, { rule: true });
    expect(r.code).toBe(0);
    expect(outcomeOf(r.out)).toBe("drift-foreign");
    expect(r.live).toBe(hand);
    expect(r.calls).not.toContain("caddy validate");
    expect(r.tmpLeft).toEqual([]);
  });
});

describe("heal — rollback compares the health check with the state before the change", () => {
  test("a health check that fails after the reload, and the same code as before the change after the restore: rolled-back", () => {
    const older = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com:80 {\n\treverse_proxy localhost:3100\n}\n`;
    // Before: 404; after the reload: 502 (ten tries); after the restore: 404.
    const r = runHeal(older, { codes: ["404", ...Array(10).fill("502"), "404"] });
    expect(r.code).toBe(1);
    expect(r.live).toBe(older);
    expect(outcomeOf(r.out)).toBe("rolled-back");
    // The change and the restore are each reloaded once.
    expect(r.calls.split("\n").filter((l) => l === "systemctl reload caddy").length).toBe(2);
  });

  test("a code after the restore that differs from the code before the change: rollback-failed", () => {
    const older = `${SAMOHOST_PROVENANCE_HEADER}\nhttp://shop.example.com:80 {\n\treverse_proxy localhost:3100\n}\n`;
    const r = runHeal(older, { codes: ["200", "502"] });
    expect(r.code).toBe(1);
    expect(r.live).toBe(older);
    expect(outcomeOf(r.out)).toBe("rollback-failed");
    expect(r.out).toContain("before the change: HTTP 200");
  });

  test("a failed validation of a vhost that heal created removes it and leaves no temporary file", () => {
    const r = runHeal(null, { failNewVhost: true });
    expect(r.code).toBe(1);
    expect(r.live).toBeNull();
    expect(r.sites).toEqual([]);
    expect(r.tmpLeft).toEqual([]);
    expect(outcomeOf(r.out)).toBe("rolled-back");
  });
});

describe("host-prep — Caddy validation as the caddy user, restore on a failed reload", () => {
  test("the guard validates as the caddy user, not as root", () => {
    const r = runGuard({ live: PREVIOUS, staged: NEW, previous: PREVIOUS });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls).toContain("sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile");
    expect(r.calls.split("\n").filter((l) => l.startsWith("caddy validate")).length).toBe(1);
  });

  test("a failed reload after the write restores the previous file and exits 1", () => {
    const r = runGuard({ live: PREVIOUS, staged: NEW, previous: PREVIOUS, reloadExit: 1 });
    expect(r.code).toBe(1);
    expect(r.live).toBe(PREVIOUS);
    expect(r.stderr).toContain("reload failed");
  });

  test("a failed validation restores the previous file through a temporary file and mv -fT; only the backup stays next to it", () => {
    const r = runGuard({ live: PREVIOUS, staged: NEW, previous: PREVIOUS, validateExit: 1 });
    expect(r.code).toBe(1);
    expect(r.live).toBe(PREVIOUS);
    expect(r.sites.filter((f) => !f.startsWith("00-main-shop.caddy.bak."))).toEqual(["00-main-shop.caddy"]);
    expect(r.backups).toEqual([PREVIOUS]);
    expect(r.calls).toMatch(/^mv -fT .*\/sites\.d\/00-main-shop\.caddy\.restore\.\d+ .*\/sites\.d\/00-main-shop\.caddy$/m);
  });

  test("a failed reload restores the previous file through a temporary file and mv -fT; only the backup stays next to it", () => {
    const r = runGuard({ live: PREVIOUS, staged: NEW, previous: PREVIOUS, reloadExit: 1 });
    expect(r.code).toBe(1);
    expect(r.live).toBe(PREVIOUS);
    expect(r.sites.filter((f) => !f.startsWith("00-main-shop.caddy.bak."))).toEqual(["00-main-shop.caddy"]);
    expect(r.backups).toEqual([PREVIOUS]);
    expect(r.calls).toMatch(/^mv -fT .*\.restore\.\d+ .*\/sites\.d\/00-main-shop\.caddy$/m);
  });

  test("the guard does not cp the backup onto the live path", () => {
    const fn = extractFn(buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP }), "samohost_apply_main_vhost");
    expect(fn).not.toMatch(/cp "\$\{backup\}" "\$live"/);
    expect(fn).toContain('install -m 644 "${backup}"');
  });

  test("a failed reload after a first write removes the new file", () => {
    const r = runGuard({ live: null, staged: NEW, reloadExit: 1 });
    expect(r.code).toBe(1);
    expect(r.live).toBeNull();
  });
});

describe("host-prep and bootstrap — the app's Caddy log file belongs to caddy", () => {
  function runRepair(script: string, opts: { owner: string; link?: boolean }) {
    const lines = script.split("\n");
    const start = lines.findIndex((l) => l.startsWith("SAMOHOST_APP_CADDY_LOG="));
    expect(start, "log repair block").toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l === "fi");
    const dir = mkdtempSync(join(tmpdir(), "samohost-caddy-log-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "calls.log");
      writeFileSync(join(bin, "id"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "stat"), `#!/usr/bin/env bash\necho ${opts.owner}\n`, { mode: 0o755 });
      writeFileSync(join(bin, "chown"), `#!/usr/bin/env bash\nprintf 'chown %s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
      const logs = join(dir, "var-log-caddy");
      mkdirSync(logs);
      if (opts.link === true) {
        writeFileSync(join(dir, "elsewhere"), "");
        spawnSync("ln", ["-s", join(dir, "elsewhere"), join(logs, "shop-prod.log")]);
      } else {
        writeFileSync(join(logs, "shop-prod.log"), "");
      }
      const body = lines.slice(start, end + 1).join("\n").replaceAll("/var/log/caddy", logs);
      const res = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
      return { code: res.status, out: res.stdout + res.stderr, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const hostPrep = () => buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP });
  const bootstrap = () => buildHostBootstrapScript(cpApp(), nodeOpts({ firewallOpts: { controlPlaneIp: CP } }));

  for (const [name, render, validation] of [
    ["host-prep", hostPrep, "samohost_apply_main_vhost \\\n"],
    ["bootstrap", bootstrap, "\nsudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile\n"],
  ] as const) {
    test(`${name}: a root-owned /var/log/caddy/<app>-prod.log is given to caddy before validation`, () => {
      const script = render();
      const repair = script.indexOf("SAMOHOST_APP_CADDY_LOG=");
      expect(repair).toBeGreaterThan(0);
      expect(script.indexOf(validation, repair)).toBeGreaterThan(repair);
      const r = runRepair(script, { owner: "root" });
      expect(r.code, r.out).toBe(0);
      // -h: a symbolic link put there after the check is not followed.
      expect(r.calls).toMatch(/^chown -h caddy:caddy .*\/shop-prod\.log$/m);
    });

    test(`${name}: a log file owned by caddy is left as it is; a symbolic link is not followed`, () => {
      expect(runRepair(render(), { owner: "caddy" }).calls).toBe("");
      const link = runRepair(render(), { owner: "root", link: true });
      expect(link.code).toBe(0);
      expect(link.calls).toBe("");
      expect(link.out).toContain("symbolic link");
    });
  }

  test("bootstrap validates the Caddyfile as the caddy user in §9", () => {
    const script = bootstrap();
    expect(script).toContain("sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile");
    expect(script).not.toMatch(/^caddy validate --config/m);
    const staticScript = buildHostBootstrapScript(
      nodeApp({ kind: "static", mainHost: "site.example.com", appUser: "shop", envFile: undefined, migrateCmd: undefined }),
      { appUser: "shop" },
    );
    expect(staticScript).not.toMatch(/^\s*caddy validate --config/m);
    expect(staticScript).toContain("sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile");
  });
});
