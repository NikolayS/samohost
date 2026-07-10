/**
 * Landmine-guard tests for buildHostPrepScript — "refuse to overwrite a
 * differing main vhost" (samohost issue: samograph prod-dark hazard).
 *
 * ROOT CAUSE: buildHostPrepScript() emitted a bare `cat > /etc/caddy/sites.d/
 * 00-main-<app>.caddy <<'CADDY'` heredoc that blindly overwrites the live main
 * vhost on every host-prep re-run.  For multi-service apps (e.g. samograph) the
 * live file is hand-authored with path/ws routing that the single-service render
 * does not know about.  Re-running host-prep silently drops all custom routing
 * AND flips to the wrong listen form → prod goes dark.
 *
 * FIX: the emitted bash now contains a `samohost_apply_main_vhost()` guard
 * function that:
 *   1. Writes the intended vhost to a .staged-* file.
 *   2. Compares with the live file; refuses (non-zero) if different unless
 *      force=true was baked in via --force-main-vhost.
 *   3. On force: timestamped backup → apply → caddy validate → restore+error if
 *      validate fails; else reload.
 *   4. On identical: idempotent no-op (exit 0, no reload).
 *   5. On absent: first-time write → validate → reload.
 *
 * Tests follow the repo's column-0 bash-extraction convention: extract the
 * function from the generated script and EXECUTE it in a temp dir with
 * PATH-shimmed `caddy` + `systemctl`; no toContain-only assertions.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostPrepScript } from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1111",
    name: "samograph",
    repo: "Tanya301/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "samograph",
    ...o,
  };
}

const MAIN_HOST = "samograph.example.com";

/** Staged content: what the single-service render produces. */
const STAGED = "samograph.example.com {\n\treverse_proxy localhost:3000\n}\n";

/**
 * Differing content: what the hand-authored samograph live file looks like
 * (multi-service path routing + ws-upgrade rules that the staged content drops).
 */
const DIFFERING = [
  "http://samograph.example.com:80 {",
  "\treverse_proxy /calls/*/stream localhost:8080 {",
  "\t\ttransport http {",
  "\t\t\tread_buffer 4096",
  "\t\t}",
  "\t}",
  "\treverse_proxy /webhook* localhost:9000",
  "\treverse_proxy localhost:3000",
  "}",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Extraction helper (column-0 bash-extraction convention)
// ---------------------------------------------------------------------------

/**
 * Extract a bash function definition (named `name`, closing brace at column 0)
 * from a generated script.  Throws if not found — that is the expected RED
 * failure mode before the guard is implemented.
 */
function extractFn(script: string, name: string): string {
  const re = new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`);
  const m = script.match(re);
  if (m === null) throw new Error(`bash function ${name}() not found in script`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Sandbox runner
// ---------------------------------------------------------------------------

interface GuardRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Content of the live file after the run; null = file does not exist. */
  liveContent: string | null;
  reloadInvoked: boolean;
  validateInvoked: boolean;
  /** Number of timestamped backup files found (00-main-samograph.caddy.bak.*). */
  backupCount: number;
}

/**
 * Extract the guard function from a generated host-prep script and execute it
 * in a sandboxed temp dir with PATH-shimmed `caddy` + `systemctl`.
 *
 * The function is always extracted from `buildHostPrepScript(app({ mainHost }),
 * "agent")` — no forceMainVhost opt needed, because the test passes force
 * directly to the function call as its third argument.
 */
function runGuard(opts: {
  liveContent: string | null;
  stagedContent?: string;
  force: boolean;
  caddyValidateExitCode?: number;
}): GuardRun {
  const {
    liveContent,
    stagedContent = STAGED,
    force,
    caddyValidateExitCode = 0,
  } = opts;

  // Extract the guard function from the generated script.
  // On current main (before the fix), extractFn throws — that IS the RED failure.
  const script = buildHostPrepScript(app({ mainHost: MAIN_HOST }), "agent");
  const fn = extractFn(script, "samohost_apply_main_vhost");

  const dir = mkdtempSync(join(tmpdir(), "samohost-guard-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const validateLog = join(dir, "validate.log");
    const reloadLog = join(dir, "reload.log");

    // caddy shim: logs validate calls, returns the configured exit code.
    writeFileSync(
      join(binDir, "caddy"),
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "validate" ]]; then',
        `  printf 'validate\\n' >> '${validateLog}'`,
        `  exit ${caddyValidateExitCode}`,
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    // systemctl shim: logs reload calls.
    writeFileSync(
      join(binDir, "systemctl"),
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "reload" ]]; then',
        `  printf 'reload\\n' >> '${reloadLog}'`,
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const sitesDir = join(dir, "sites.d");
    mkdirSync(sitesDir, { recursive: true });

    const stagedPath = join(sitesDir, ".staged-00-main-samograph.caddy");
    const livePath = join(sitesDir, "00-main-samograph.caddy");

    writeFileSync(stagedPath, stagedContent);
    if (liveContent !== null) writeFileSync(livePath, liveContent);

    const forceArg = force ? "true" : "false";
    const prog = [
      "set -uo pipefail",
      fn,
      `samohost_apply_main_vhost '${stagedPath}' '${livePath}' '${forceArg}'`,
    ].join("\n");

    const res = spawnSync("bash", ["-c", prog], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
    });

    let liveAfter: string | null = null;
    try {
      liveAfter = readFileSync(livePath, "utf8");
    } catch {
      liveAfter = null;
    }

    const backupCount = readdirSync(sitesDir).filter((f) =>
      f.startsWith("00-main-samograph.caddy.bak."),
    ).length;

    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      liveContent: liveAfter,
      reloadInvoked: existsSync(reloadLog),
      validateInvoked: existsSync(validateLog),
      backupCount,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHostPrepScript — main-vhost landmine guard (samohost_apply_main_vhost)", () => {
  test(
    "(a) differing live file → non-zero exit, file UNCHANGED byte-for-byte, diff in output, no reload, no validate",
    () => {
      const r = runGuard({ liveContent: DIFFERING, force: false });

      expect(r.code).not.toBe(0);
      // The live file must not have been modified — byte-for-byte original.
      expect(r.liveContent).toBe(DIFFERING);
      // Operator message naming the problem and the escape hatch.
      expect(r.stderr).toMatch(/refusing to overwrite/i);
      expect(r.stderr).toContain("--force-main-vhost");
      // A unified diff must appear (lines starting with - or + are diagnostic output).
      expect(r.stderr + r.stdout).toMatch(/^[+-]/m);
      // No caddy validate and no systemctl reload — the guard aborts before both.
      expect(r.validateInvoked).toBe(false);
      expect(r.reloadInvoked).toBe(false);
    },
  );

  test("(b) identical live file → exit 0, file unchanged, no validate, no reload (idempotent)", () => {
    const r = runGuard({ liveContent: STAGED, force: false });

    expect(r.code).toBe(0);
    expect(r.liveContent).toBe(STAGED);
    expect(r.validateInvoked).toBe(false);
    expect(r.reloadInvoked).toBe(false);
  });

  test(
    "(c) --force-main-vhost + differing file → backup created, staged content applied, validate + reload invoked",
    () => {
      const r = runGuard({ liveContent: DIFFERING, force: true });

      expect(r.code).toBe(0);
      expect(r.liveContent).toBe(STAGED); // staged content is now live
      expect(r.backupCount).toBeGreaterThanOrEqual(1); // timestamped backup file exists
      expect(r.validateInvoked).toBe(true);
      expect(r.reloadInvoked).toBe(true);
    },
  );

  test(
    "(d) --force-main-vhost + caddy validate returns non-zero → backup RESTORED (original bytes), non-zero exit, no reload",
    () => {
      const r = runGuard({
        liveContent: DIFFERING,
        force: true,
        caddyValidateExitCode: 1,
      });

      expect(r.code).not.toBe(0);
      // Original bytes restored from the backup — not the staged content.
      expect(r.liveContent).toBe(DIFFERING);
      expect(r.validateInvoked).toBe(true); // validate was attempted
      expect(r.reloadInvoked).toBe(false); // reload was never reached
    },
  );

  test(
    "(e) file absent → first-time write, validate + reload invoked, no backup (nothing to back up)",
    () => {
      const r = runGuard({ liveContent: null, force: false });

      expect(r.code).toBe(0);
      expect(r.liveContent).toBe(STAGED);
      expect(r.backupCount).toBe(0);
      expect(r.validateInvoked).toBe(true);
      expect(r.reloadInvoked).toBe(true);
    },
  );
});
