/**
 * TDD RED tests: --force-main-vhost CLI flag wired end-to-end
 * (cli -> EnvPlanInput -> runEnvPlan -> buildHostPrepScript -> bakedForce).
 *
 * Root cause: `runEnvPlan` calls `buildHostPrepScript(r.app, r.vm.sshUser)`
 * with NO firewallOpts, so `bakedForce` is hardcoded `false` regardless of any
 * CLI flag.  No `--force-main-vhost` token was parsed in src/cli.ts, making a
 * deliberate static->node vhost swap impossible via the automated host-prep path.
 *
 * Fix targets:
 *   1. src/cli.ts `parseEnvPlan`: accept `--force-main-vhost` boolean flag.
 *   2. src/commands/env.ts `EnvPlanInput`: add optional `forceMainVhost?: boolean`.
 *   3. src/commands/env.ts `runEnvPlan`: thread `forceMainVhost` into
 *      `buildHostPrepScript(r.app, r.vm.sshUser, { forceMainVhost })`.
 *
 * Tests:
 *   (1) CLI: `--force-main-vhost` is parsed; input.forceMainVhost === true.
 *   (2) CLI: without the flag, input.forceMainVhost is undefined/false (default preserved).
 *   (3) CLI: unknown flag still throws UsageError (flag is properly registered).
 *   (4) runEnvPlan + forceMainVhost=true → emitted bash has `force=true` in the
 *       samohost_apply_main_vhost call.
 *   (5) runEnvPlan without forceMainVhost → emitted bash has `force=false` in the
 *       samohost_apply_main_vhost call (default-refuse guard preserved).
 *   (6) End-to-end execution: with forceMainVhost=true and a differing live vhost →
 *       the overwrite path runs (backup created, caddy validate called, reload invoked).
 *   (7) End-to-end execution: without forceMainVhost and a differing live vhost →
 *       the guard REFUSES (non-zero exit, file unchanged).
 *   (8) End-to-end execution: with forceMainVhost=true and caddy validate failure →
 *       backup is RESTORED (rollback path still intact on the force path).
 */

import { describe, expect, test } from "bun:test";
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
import { spawnSync } from "node:child_process";
import { parseArgs } from "../src/cli.ts";
import { runEnvPlan, type EnvPlanInput } from "../src/commands/env.ts";
import { buildHostPrepScript } from "../src/env/script.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAIN_HOST = "samograph.samo.team";

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-samograph",
    ip: "1.2.3.4",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function appRec(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-sg",
    vmId: "vm-1111",
    name: "samograph",
    repo: "Tanya301/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "samograph",
    mainHost: MAIN_HOST,
    ...o,
  };
}

/** What the single-service render produces for the node app (staged content). */
const STAGED_NODE = `${MAIN_HOST} {\n\treverse_proxy localhost:3000\n}\n`;

/**
 * What the live file looks like for a static->node conversion scenario:
 * a static file_server vhost that now needs to become a node reverse_proxy.
 */
const LIVE_STATIC = [
  `${MAIN_HOST} {`,
  `\troot * "/opt/samograph/app/dist"`,
  `\ttry_files {path} {path}/ =404`,
  `\tfile_server`,
  `\tencode gzip`,
  `\ttls internal`,
  `}`,
  ``,
].join("\n");

/** Multi-listener hand-authored vhost (samograph prod shape). */
const LIVE_CUSTOM = [
  `http://${MAIN_HOST}:80 {`,
  `\treverse_proxy /calls/*/stream localhost:8080 {`,
  `\t\ttransport http {`,
  `\t\t\tread_buffer 4096`,
  `\t\t}`,
  `\t}`,
  `\treverse_proxy localhost:3000`,
  `}`,
  ``,
].join("\n");

// ---------------------------------------------------------------------------
// State-store helpers for runEnvPlan
// ---------------------------------------------------------------------------

/**
 * Build minimal in-memory stores with exactly one VM + one app registered.
 * runEnvPlan calls StateStore.get() and AppStore.get(), so both must be
 * populated with the fixture records.
 */
function makeStores() {
  const tmpDir = mkdtempSync(join(tmpdir(), "samohost-fmv-"));
  const vmStore = new StateStore(join(tmpDir, "state.json"));
  const appStore = new AppStore(join(tmpDir, "apps.json"));
  const envStore = new EnvStore(join(tmpDir, "envs.json"));

  const v = vm();
  const a = appRec();
  vmStore.upsert(v);
  appStore.upsert(a);

  return { vmStore, appStore, envStore, tmpDir };
}

/** Capture stdout/stderr from runEnvPlan. */
function planOutput(
  input: EnvPlanInput,
  stores: ReturnType<typeof makeStores>,
): { code: number; out: string; err: string } {
  let out = "";
  let errOut = "";
  const { vmStore, appStore, envStore } = stores;
  const code = runEnvPlan(
    input,
    { json: false },
    vmStore,
    appStore,
    envStore,
    (s) => (out += s + "\n"),
    (s) => (errOut += s + "\n"),
  );
  return { code, out, err: errOut };
}

// ---------------------------------------------------------------------------
// Bash-function runner for end-to-end execution tests
// ---------------------------------------------------------------------------

/**
 * Extract a bash function definition (closing brace at column 0) from a script.
 */
function extractFn(script: string, name: string): string {
  const re = new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`);
  const m = script.match(re);
  if (m === null) throw new Error(`bash function ${name}() not found in script`);
  return m[1]!;
}

interface GuardRun {
  code: number;
  stdout: string;
  stderr: string;
  liveContent: string | null;
  reloadInvoked: boolean;
  validateInvoked: boolean;
  backupCount: number;
}

/**
 * Execute the guard function extracted from a host-prep script with the given
 * baked force value (passed as the third argument to samohost_apply_main_vhost).
 */
function runGuardFromScript(opts: {
  script: string;
  liveContent: string | null;
  stagedContent?: string;
  caddyValidateExitCode?: number;
}): GuardRun {
  const {
    script,
    liveContent,
    stagedContent = STAGED_NODE,
    caddyValidateExitCode = 0,
  } = opts;

  // Extract the guard function. If forceMainVhost is not wired yet, the baked
  // value in the script will be "false" — we pass it verbatim to exercise the
  // actual generated CLI.
  const fn = extractFn(script, "samohost_apply_main_vhost");

  // Extract the samohost_apply_main_vhost call line from the script to get the
  // baked force arg (third positional).  The call has the form:
  //   samohost_apply_main_vhost \
  //     <staged> \
  //     <live> \
  //     <force>
  // We execute the function with the baked force value by running the call
  // lines verbatim (with real temp paths substituted in).
  const dir = mkdtempSync(join(tmpdir(), "samohost-fmv-guard-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const validateLog = join(dir, "validate.log");
    const reloadLog = join(dir, "reload.log");

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

    // Extract the baked force value from the generated script's call site.
    // The call appears as:
    //   samohost_apply_main_vhost \
    //     /etc/caddy/sites.d/.staged-00-main-samograph.caddy \
    //     /etc/caddy/sites.d/00-main-samograph.caddy \
    //     true|false
    const callMatch = script.match(
      /samohost_apply_main_vhost \\\n\s+[^\\\n]+\\\n\s+[^\\\n]+\\\n\s+(true|false)/,
    );
    const bakedForce = callMatch ? callMatch[1] : "false";

    const prog = [
      "set -uo pipefail",
      fn,
      `samohost_apply_main_vhost '${stagedPath}' '${livePath}' '${bakedForce}'`,
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
// (1) CLI: --force-main-vhost is parsed → input.forceMainVhost === true
// ---------------------------------------------------------------------------

describe("CLI parsing: --force-main-vhost", () => {
  test("(1) --force-main-vhost sets forceMainVhost=true in env-plan input", () => {
    const cmd = parseArgs([
      "env", "plan", "samo-we-samograph", "samograph",
      "--host-prep", "--force-main-vhost",
    ]);
    if (cmd.kind !== "env-plan") throw new Error(`expected env-plan, got ${cmd.kind}`);
    // This assertion is RED until --force-main-vhost is parsed in src/cli.ts.
    expect(cmd.input.forceMainVhost).toBe(true);
  });

  test("(2) without --force-main-vhost, forceMainVhost is undefined/falsy (default safe)", () => {
    const cmd = parseArgs([
      "env", "plan", "samo-we-samograph", "samograph",
      "--host-prep",
    ]);
    if (cmd.kind !== "env-plan") throw new Error(`expected env-plan, got ${cmd.kind}`);
    // forceMainVhost should be absent or explicitly false, never accidentally true.
    expect(!cmd.input.forceMainVhost).toBe(true);
  });

  test("(3) --force-main-vhost without --host-prep is accepted (flag is orthogonal)", () => {
    // The flag is a modifier on the output script; it doesn't require --host-prep.
    // (Without --host-prep, --branch is required — use that here.)
    expect(() =>
      parseArgs([
        "env", "plan", "samo-we-samograph", "samograph",
        "--branch", "main", "--force-main-vhost",
      ]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (4-5) runEnvPlan: forceMainVhost threads into buildHostPrepScript
// ---------------------------------------------------------------------------

describe("runEnvPlan: forceMainVhost threads into the emitted script", () => {
  test("(4) forceMainVhost=true → emitted bash has force=true baked into samohost_apply_main_vhost call", () => {
    const stores = makeStores();
    try {
      const input: EnvPlanInput = {
        vm: "samo-we-samograph",
        app: "samograph",
        db: "dblab",
        previewDomain: "samo.cat",
        destroy: false,
        hostPrep: true,
        forceMainVhost: true,
      };
      const { code, out } = planOutput(input, stores);
      expect(code).toBe(0);
      // The emitted call to samohost_apply_main_vhost must carry `true` as the
      // third arg. Without the fix, bakedForce is always "false".
      expect(out).toContain("samohost_apply_main_vhost");
      // The call site has the form: "  true" on the last line of the call block.
      expect(out).toMatch(/samohost_apply_main_vhost \\\n\s+[^\\\n]+\\\n\s+[^\\\n]+\\\n\s+true/);
    } finally {
      rmSync(stores.tmpDir, { recursive: true, force: true });
    }
  });

  test("(5) forceMainVhost absent → emitted bash has force=false (default-refuse guard preserved)", () => {
    const stores = makeStores();
    try {
      const input: EnvPlanInput = {
        vm: "samo-we-samograph",
        app: "samograph",
        db: "dblab",
        previewDomain: "samo.cat",
        destroy: false,
        hostPrep: true,
        // forceMainVhost intentionally omitted
      };
      const { code, out } = planOutput(input, stores);
      expect(code).toBe(0);
      expect(out).toContain("samohost_apply_main_vhost");
      expect(out).toMatch(/samohost_apply_main_vhost \\\n\s+[^\\\n]+\\\n\s+[^\\\n]+\\\n\s+false/);
    } finally {
      rmSync(stores.tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (6-8) End-to-end bash execution of the emitted guard with baked force value
// ---------------------------------------------------------------------------

describe("end-to-end: guard behavior driven by the baked force value in the emitted script", () => {
  test("(6) forceMainVhost=true + differing live vhost → overwrite applied, backup created, reload invoked", () => {
    // Script emitted with forceMainVhost: true → bakedForce = "true" in the call.
    const script = buildHostPrepScript(appRec(), "agent", { forceMainVhost: true });
    const r = runGuardFromScript({ script, liveContent: LIVE_STATIC });

    expect(r.code).toBe(0);
    expect(r.liveContent).toBe(STAGED_NODE); // staged node vhost is now live
    expect(r.backupCount).toBeGreaterThanOrEqual(1); // timestamped backup exists
    expect(r.validateInvoked).toBe(true);
    expect(r.reloadInvoked).toBe(true);
  });

  test("(7) forceMainVhost absent/false + differing live vhost → guard REFUSES, file unchanged", () => {
    // Script emitted WITHOUT forceMainVhost → bakedForce = "false".
    // A static->node conversion scenario: the live file is the old static vhost.
    const script = buildHostPrepScript(appRec(), "agent"); // default: no force
    const r = runGuardFromScript({ script, liveContent: LIVE_STATIC });

    expect(r.code).not.toBe(0);
    // The live file must be byte-identical to what it was before the run.
    expect(r.liveContent).toBe(LIVE_STATIC);
    expect(r.stderr).toMatch(/refusing to overwrite/i);
    expect(r.stderr).toContain("--force-main-vhost");
    // No validate, no reload — the guard aborts before both.
    expect(r.validateInvoked).toBe(false);
    expect(r.reloadInvoked).toBe(false);
  });

  test("(7b) forceMainVhost absent/false + custom multi-service live vhost → guard REFUSES (samograph landmine)", () => {
    const script = buildHostPrepScript(appRec(), "agent");
    const r = runGuardFromScript({ script, liveContent: LIVE_CUSTOM });

    expect(r.code).not.toBe(0);
    expect(r.liveContent).toBe(LIVE_CUSTOM); // original custom vhost preserved
    expect(r.stderr).toMatch(/refusing to overwrite/i);
  });

  test("(8) forceMainVhost=true + caddy validate failure → backup RESTORED (rollback path intact)", () => {
    // Verify backup+validate+rollback is preserved on the force path: this is the
    // safety net that prevents a broken node vhost from taking routing dark.
    const script = buildHostPrepScript(appRec(), "agent", { forceMainVhost: true });
    const r = runGuardFromScript({
      script,
      liveContent: LIVE_STATIC,
      caddyValidateExitCode: 1,
    });

    expect(r.code).not.toBe(0); // non-zero: validate failed, rollback happened
    // The original bytes must be restored from the backup.
    expect(r.liveContent).toBe(LIVE_STATIC);
    expect(r.validateInvoked).toBe(true); // validate was attempted
    expect(r.reloadInvoked).toBe(false); // reload was never reached
    // A backup file was created (and then used for restore).
    expect(r.backupCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// (bonus) CLI -> runEnvPlan integration: full path from parseArgs to script
// ---------------------------------------------------------------------------

describe("CLI -> runEnvPlan -> script: forceMainVhost threads end-to-end", () => {
  test("parsed --force-main-vhost flows through to force=true in the emitted script", () => {
    // Parse the CLI args first.
    const cmd = parseArgs([
      "env", "plan", "samo-we-samograph", "samograph",
      "--host-prep", "--force-main-vhost",
    ]);
    if (cmd.kind !== "env-plan") throw new Error(`expected env-plan, got ${cmd.kind}`);

    // Thread the parsed input into runEnvPlan.
    const stores = makeStores();
    try {
      const { code, out } = planOutput(cmd.input, stores);
      expect(code).toBe(0);
      // The final emitted bash must have true baked in — not false.
      expect(out).toMatch(/samohost_apply_main_vhost \\\n\s+[^\\\n]+\\\n\s+[^\\\n]+\\\n\s+true/);
    } finally {
      rmSync(stores.tmpDir, { recursive: true, force: true });
    }
  });
});
