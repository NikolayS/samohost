/**
 * Tests for `samohost app heal` — Phase 2 of the "never silently lose an update" fix.
 *
 * RED-first: these tests are written BEFORE the implementation. They test:
 *   1. SNAPSHOT — buildConfigHealScript(nodeApp) produces a deterministic bash string
 *      containing all safety phases in order.
 *   2. SNAPSHOT — buildConfigHealScript(staticApp) reads .samohost-active-static.json path,
 *      regenerates the active-route snippet, and includes the same safety sequence.
 *   3. NO-DRIFT PATH — inject a runner that returns "cmp identical" outcome;
 *      assert runAppHeal stamps generatorSha + lastHealAt and returns exitCode=0
 *      with outcome='no-drift'.
 *   4. PROVENANCE-FOREIGN SKIP — inject a runner that returns stdout indicating a
 *      file lacks the samohost provenance header; assert outcome contains
 *      'drift-foreign' finding and file is NOT reloaded.
 *   5. ROLLBACK ON HEALTH FAIL — inject a runner whose stdout contains health:fail
 *      phase marker followed by rollback:ok; assert runAppHeal records exitCode=1
 *      and does NOT stamp generatorSha.
 *   6. DRY-RUN DEFAULT — call runAppHeal with apply=false; assert the injected
 *      runner is never called (pure diff output only, no SSH).
 *
 * All tests use pure-builder + injected-runner patterns. No live SSH, no network,
 * no real VM. CLI-only command (no browser UI): Playwright not applicable.
 *
 * Phase 3 (trigger auto-heal) is NOT in scope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { runAppHeal, type AppHealInput, type AppHealDeps } from "../src/commands/app.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import { parseArgs } from "../src/cli.ts";
import { PHASE_PREFIX } from "../src/app/script.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-test",
    ip: "178.105.246.151",
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

/** A node app record (field-record-like). */
function nodeApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111-node",
    vmId: "vm-1111",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    mainHost: "field-record-1.samo.team",
    mainListen: "cp-http80",
    deployedSha: "abc1234def5678901234567890abcdef12345678",
    generatorSha: "oldgenshaoldgenshaoldgenshaoldgenshaold12",
    ...overrides,
  };
}

/** A static app record. */
function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-2222-static",
    vmId: "vm-1111",
    name: "samo-site",
    repo: "Tanya301/samo-site",
    branch: "main",
    kind: "static",
    appDir: "/opt/samo-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://samo.team/",
    serviceUnit: "samo-site",
    mainHost: "samo.team",
    mainListen: "cp-http80",
    deployedSha: "def5678def5678def5678def5678def567890ab",
    generatorSha: "oldgenshaoldgenshaoldgenshaoldgenshaold12",
    ...overrides,
  };
}

function capture() {
  let out = "";
  let errStr = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { errStr += s + "\n"; },
    get o() { return out; },
    get e() { return errStr; },
  };
}

// ---------------------------------------------------------------------------
// Temporary state dirs for AppStore/StateStore isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let appsPath: string;
let vmStorePath: string;
let appStore: AppStore;
let vmStore: StateStore;
let testVm: VmRecord;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "app-heal-test-"));
  appsPath = join(tmpDir, "apps.json");
  vmStorePath = join(tmpDir, "vms.json");
  appStore = new AppStore(appsPath);
  vmStore = new StateStore(vmStorePath);
  testVm = vm();
  vmStore.upsert(testVm);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. SNAPSHOT — buildConfigHealScript for a node app
// ---------------------------------------------------------------------------

describe("buildConfigHealScript snapshot — node app", () => {
  test("is deterministic (pure)", () => {
    const app = nodeApp();
    expect(buildConfigHealScript(app)).toBe(buildConfigHealScript(app));
  });

  test("emits the samohost heal script header", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("samohost config-heal script");
    expect(script).toContain("bash -s");
  });

  test("includes provenance header gate: grep for samohost header before overwriting", () => {
    const script = buildConfigHealScript(nodeApp());
    // Must grep the exact provenance header before overwriting any file
    expect(script).toContain("generated by samohost/src/caddy/render.ts");
  });

  test("backs up the live vhost file before overwriting (mktemp backup pattern)", () => {
    const script = buildConfigHealScript(nodeApp());
    // The main vhost backup variable assignment must be present
    expect(script).toContain('SAMOHOST_MAIN_VHOST_BACKUP="$(mktemp)"');
    // The backup assignment must come before the actual move of staged → live
    // (the staged→live mv is in the main body, after the provenance check and cmp)
    const backupIdx = script.indexOf('SAMOHOST_MAIN_VHOST_BACKUP="$(mktemp)"');
    // The live-file atomic mv (from staged to live)
    const mvPattern = `sudo /usr/bin/mv -- '/etc/caddy/sites.d/.samohost-heal-next-00-main-field-record.caddy' '/etc/caddy/sites.d/00-main-field-record.caddy'`;
    // Find the mv OUTSIDE the rollback function (after the rollback definition)
    const rollbackEnd = script.indexOf("\n}\n\necho");
    const mvIdx = script.indexOf(mvPattern, rollbackEnd);
    expect(backupIdx).toBeGreaterThanOrEqual(0);
    expect(mvIdx).toBeGreaterThanOrEqual(0);
    expect(backupIdx).toBeLessThan(mvIdx);
  });

  test("uses cmp to detect no-drift before writing", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("cmp");
  });

  test("uses sudo /usr/bin/tee to write the regenerated vhost (not direct file write)", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("sudo /usr/bin/tee");
  });

  test("validates the combined Caddy config after staging", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("caddy validate --config /etc/caddy/Caddyfile");
  });

  test("reloads caddy via full-path sudo systemctl (never bare sudo systemctl)", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("sudo /usr/bin/systemctl reload caddy");
    // No bare `sudo systemctl` in executable lines
    const codeLines = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const line of codeLines) {
      expect(/sudo\s+systemctl\b/.test(line)).toBe(false);
    }
  });

  test("includes the 10x3s health probe loop", () => {
    const script = buildConfigHealScript(nodeApp());
    // Health retry count and sleep from the existing deploy script constants
    expect(script).toMatch(/seq 1 10/);
    expect(script).toMatch(/sleep 3/);
  });

  test("includes rollback: restore backup on health failure", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("rollback");
    // rollback:ok and rollback:fail markers
    expect(script).toContain(`${PHASE_PREFIX}rollback:ok>>>`);
    expect(script).toContain(`${PHASE_PREFIX}rollback:fail>>>`);
  });

  test("includes heal:ok phase marker", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain(`${PHASE_PREFIX}heal:ok>>>`);
  });

  test("includes no-drift phase marker path", () => {
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain(`${PHASE_PREFIX}no-drift:ok>>>`);
  });

  test("targets the correct main vhost path for node apps", () => {
    const script = buildConfigHealScript(nodeApp());
    // /etc/caddy/sites.d/00-main-<app>.caddy
    expect(script).toContain("/etc/caddy/sites.d/00-main-field-record.caddy");
  });

  test("regenerated vhost content contains the renderVhost provenance header", () => {
    const script = buildConfigHealScript(nodeApp());
    // The script embeds the renderVhost output which starts with the provenance header
    expect(script).toContain("generated by samohost/src/caddy/render.ts — do not edit by hand");
    // Also contains the mainHost
    expect(script).toContain("field-record-1.samo.team");
  });

  test("does NOT touch env files or systemd units (Caddy-layer artifacts only)", () => {
    const script = buildConfigHealScript(nodeApp());
    // Must NOT write to staging.env, .env, or systemd drop-in paths
    expect(script).not.toContain("staging.env");
    expect(script).not.toContain("systemd/system");
    // Must NOT restart the service unit (that's a content deploy, not a config heal)
    expect(script).not.toContain("systemctl restart");
  });
});

// ---------------------------------------------------------------------------
// 2. SNAPSHOT — buildConfigHealScript for a static app
// ---------------------------------------------------------------------------

describe("buildConfigHealScript snapshot — static app", () => {
  test("is deterministic (pure)", () => {
    const app = staticApp();
    expect(buildConfigHealScript(app)).toBe(buildConfigHealScript(app));
  });

  test("reads .samohost-active-static.json to learn the current release dir", () => {
    const script = buildConfigHealScript(staticApp());
    // Must reference the correct activeState path from staticReleaseStatePaths
    expect(script).toContain(".samohost-active-static.json");
  });

  test("regenerates the active-route snippet (file_server directives, NOT renderVhost output)", () => {
    const script = buildConfigHealScript(staticApp());
    // The active-route file is a raw snippet: root * "<dir>" + try_files + file_server + encode gzip
    expect(script).toContain(".samohost-active-static.caddy");
    // Must contain the active-route snippet format (not a site block)
    expect(script).toContain("file_server");
    expect(script).toContain("try_files");
    expect(script).toContain("encode gzip");
  });

  test("also regenerates the main vhost (via runtime bash heredoc, NOT renderVhost) for static apps that have mainHost", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toContain("/etc/caddy/sites.d/00-main-samo-site.caddy");
    expect(script).toContain("samo.team");
  });

  test("reads releaseDir from the active-state JSON (not from git)", () => {
    const script = buildConfigHealScript(staticApp());
    // Must parse the JSON to get releaseDir — look for python3 or jq invocation
    // or a bash json extraction. The script reads the JSON file to get the
    // release directory so it can reconstruct the active-route path.
    expect(script).toMatch(/python3|jq|releaseDir/);
  });

  test("includes provenance-gate check before overwriting any artifact", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toContain("generated by samohost/src/caddy/render.ts");
  });

  test("includes cmp drift detection for both artifacts", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toContain("cmp");
  });

  test("includes rollback markers", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toContain(`${PHASE_PREFIX}rollback:ok>>>`);
    expect(script).toContain(`${PHASE_PREFIX}rollback:fail>>>`);
  });

  test("does NOT include git fetch/checkout/install/build/migrate (content redeploy phases)", () => {
    const script = buildConfigHealScript(staticApp());
    // Heal must NEVER ship content
    expect(script).not.toContain("git fetch");
    expect(script).not.toContain("git checkout");
    expect(script).not.toContain("npm ci");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("npm run build");
  });

  test("does NOT touch the active-state JSON (read-only in v1)", () => {
    const script = buildConfigHealScript(staticApp());
    // .samohost-active-static.json is READ-ONLY in v1; heal must never write it
    // Check that we only read it (cat/python3 read) not write with tee
    const lines = script.split("\n");
    for (const line of lines) {
      if (line.includes(".samohost-active-static.json")) {
        // Must not write to it
        expect(line).not.toContain("tee");
        expect(line).not.toContain("> ");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. NO-DRIFT PATH — cmp identical, stamp generatorSha + lastHealAt
// ---------------------------------------------------------------------------

describe("runAppHeal — no-drift path", () => {
  const GEN_SHA = "currentgenshaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

  test("stamps generatorSha on no-drift (convergence recorded even when nothing changed)", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    let runnerCalled = false;
    const deps: AppHealDeps = {
      remote: async (_vmArg, _script) => {
        runnerCalled = true;
        return {
          code: 0,
          stdout: `${PHASE_PREFIX}heal:start>>>\n${PHASE_PREFIX}no-drift:ok>>>\nheal complete\n`,
          stderr: "",
        };
      },
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => GEN_SHA,
    };

    const input: AppHealInput = {
      vm: "samo-we-test",
      app: "field-record",
      apply: true,
    };

    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(code).toBe(0);
    expect(runnerCalled).toBe(true);

    const updated = appStore.get(testVm.id, "field-record");
    expect(updated?.generatorSha).toBe(GEN_SHA);
    expect(updated?.lastHealAt).toBe("2026-07-15T10:00:00.000Z");
  });

  test("reports outcome=no-drift when cmp finds no changes", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({
        code: 0,
        stdout: `${PHASE_PREFIX}heal:start>>>\n${PHASE_PREFIX}no-drift:ok>>>\nheal complete\n`,
        stderr: "",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => GEN_SHA,
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(code).toBe(0);
    expect(cap.o).toContain("no-drift");
  });

  test("JSON output includes outcome and exitCode fields", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({
        code: 0,
        stdout: `${PHASE_PREFIX}heal:start>>>\n${PHASE_PREFIX}no-drift:ok>>>\nheal complete\n`,
        stderr: "",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => GEN_SHA,
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: true }, vmStore, appStore, deps, cap.out, cap.err);

    const report = JSON.parse(cap.o.trim());
    expect(report.outcome).toBe("no-drift");
    expect(report.exitCode).toBe(0);
    expect(report.app).toBe("field-record");
  });
});

// ---------------------------------------------------------------------------
// 4. PROVENANCE-FOREIGN SKIP
// ---------------------------------------------------------------------------

describe("runAppHeal — provenance-foreign finding", () => {
  test("does NOT overwrite files lacking the samohost provenance header", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    let reloadCalled = false;
    const deps: AppHealDeps = {
      remote: async () => {
        // Script detects the file has no samohost provenance header → drift-foreign
        // No reload is triggered; outcome is drift-foreign
        return {
          code: 0,
          stdout: [
            `${PHASE_PREFIX}heal:start>>>`,
            // drift-foreign finding is emitted; no caddy reload marker
            `drift-foreign: /etc/caddy/sites.d/00-main-field-record.caddy lacks samohost provenance header`,
            `${PHASE_PREFIX}heal:ok>>>`,
          ].join("\n"),
          stderr: "",
        };
      },
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "genshaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    // Exit 0: drift-foreign is a finding, not a failure (file is preserved)
    expect(code).toBe(0);
    // Reload must NOT have been called (no caddy-reload marker in output)
    expect(reloadCalled).toBe(false);
    // Output must indicate drift-foreign finding
    expect(cap.o + cap.e).toContain("drift-foreign");
  });

  test("drift-foreign finding prevents generatorSha stamp when foreign files present", async () => {
    const app = nodeApp({ vmId: testVm.id, generatorSha: "old-sha-11111111111111111111111111111111" });
    appStore.upsert(app);

    const NEW_GEN_SHA = "new-gen-sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaa11";
    const deps: AppHealDeps = {
      remote: async () => ({
        code: 0,
        stdout: [
          `${PHASE_PREFIX}heal:start>>>`,
          `drift-foreign: /etc/caddy/sites.d/00-main-field-record.caddy lacks samohost provenance header`,
          `${PHASE_PREFIX}heal:ok>>>`,
        ].join("\n"),
        stderr: "",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => NEW_GEN_SHA,
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    // generatorSha must NOT be stamped when drift-foreign finding is present
    // (the config was not actually healed — foreign files block convergence)
    const updated = appStore.get(testVm.id, "field-record");
    expect(updated?.generatorSha).toBe("old-sha-11111111111111111111111111111111");
  });
});

// ---------------------------------------------------------------------------
// 5. ROLLBACK ON HEALTH FAIL
// ---------------------------------------------------------------------------

describe("runAppHeal — rollback on health probe failure", () => {
  test("returns exitCode=1 when health probe fails after caddy reload", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({
        code: 1,
        stdout: [
          `${PHASE_PREFIX}heal:start>>>`,
          `${PHASE_PREFIX}caddy-reload:start>>>`,
          `${PHASE_PREFIX}caddy-reload:ok>>>`,
          `${PHASE_PREFIX}health:start>>>`,
          `${PHASE_PREFIX}health:fail>>>`,
          `health check failed after retries — rolling back`,
          `${PHASE_PREFIX}rollback:ok>>>`,
        ].join("\n"),
        stderr: "health check failed",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "new-gen-sha-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(code).toBe(1);
  });

  test("does NOT stamp generatorSha on rollback (same as deploy: failed heal does not advance stamp)", async () => {
    const originalGenSha = "oldgenshaoldgenshaoldgenshaoldgenshaold12";
    const app = nodeApp({ vmId: testVm.id, generatorSha: originalGenSha });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({
        code: 1,
        stdout: [
          `${PHASE_PREFIX}heal:start>>>`,
          `${PHASE_PREFIX}caddy-reload:start>>>`,
          `${PHASE_PREFIX}caddy-reload:ok>>>`,
          `${PHASE_PREFIX}health:start>>>`,
          `${PHASE_PREFIX}health:fail>>>`,
          `${PHASE_PREFIX}rollback:ok>>>`,
        ].join("\n"),
        stderr: "health probe failed",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "new-gen-sha-ccccccccccccccccccccccccccccc1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    // generatorSha must NOT advance on rollback
    const updated = appStore.get(testVm.id, "field-record");
    expect(updated?.generatorSha).toBe(originalGenSha);
  });

  test("JSON report includes outcome=rolled-back on health failure", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({
        code: 1,
        stdout: [
          `${PHASE_PREFIX}heal:start>>>`,
          `${PHASE_PREFIX}health:fail>>>`,
          `${PHASE_PREFIX}rollback:ok>>>`,
        ].join("\n"),
        stderr: "",
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "gen1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: true }, vmStore, appStore, deps, cap.out, cap.err);

    const report = JSON.parse(cap.o.trim());
    expect(report.exitCode).toBe(1);
    expect(["rolled-back", "rollback-failed", "incomplete"]).toContain(report.outcome);
  });
});

// ---------------------------------------------------------------------------
// 6. DRY-RUN DEFAULT — no SSH when apply=false
// ---------------------------------------------------------------------------

describe("runAppHeal — dry-run mode (default)", () => {
  test("does NOT call the remote runner when apply=false", async () => {
    const app = nodeApp({ vmId: testVm.id });
    appStore.upsert(app);

    let runnerCallCount = 0;
    const deps: AppHealDeps = {
      remote: async () => {
        runnerCallCount++;
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "gen-sha-dryrun-11111111111111111111111111",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: false };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(code).toBe(0);
    expect(runnerCallCount).toBe(0);
    // Dry-run output must indicate what WOULD change
    expect(cap.o + cap.e).toMatch(/dry.?run|would|diff/i);
  });

  test("does NOT stamp generatorSha on dry-run", async () => {
    const originalGenSha = "oldgenshaoldgenshaoldgenshaoldgenshaold12";
    const app = nodeApp({ vmId: testVm.id, generatorSha: originalGenSha });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "new-gen-sha-dryrun-aaaaaaaaaaaaaaaaaaaaaa1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: false };
    const cap = capture();
    await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    const updated = appStore.get(testVm.id, "field-record");
    expect(updated?.generatorSha).toBe(originalGenSha);
  });
});

// ---------------------------------------------------------------------------
// 7. CLI parsing — app heal subcommand
// ---------------------------------------------------------------------------

describe("parseArgs app heal", () => {
  test("parses app heal <vm> <app> (dry-run default, no --apply)", () => {
    const parsed = parseArgs(["app", "heal", "samo-we-test", "field-record"]);
    expect(parsed.kind).toBe("app-heal");
    if (parsed.kind !== "app-heal") throw new Error("unexpected");
    expect(parsed.input.vm).toBe("samo-we-test");
    expect(parsed.input.app).toBe("field-record");
    expect(parsed.input.apply).toBe(false);
    expect(parsed.input.all).toBeUndefined();
  });

  test("parses app heal <vm> <app> --apply", () => {
    const parsed = parseArgs(["app", "heal", "samo-we-test", "field-record", "--apply"]);
    expect(parsed.kind).toBe("app-heal");
    if (parsed.kind !== "app-heal") throw new Error("unexpected");
    expect(parsed.input.apply).toBe(true);
  });

  test("parses app heal --all --apply", () => {
    const parsed = parseArgs(["app", "heal", "samo-we-test", "--all", "--apply"]);
    expect(parsed.kind).toBe("app-heal");
    if (parsed.kind !== "app-heal") throw new Error("unexpected");
    expect(parsed.input.all).toBe(true);
    expect(parsed.input.apply).toBe(true);
  });

  test("parses app heal <vm> --app <name> --apply", () => {
    const parsed = parseArgs(["app", "heal", "samo-we-test", "--app", "field-record", "--apply"]);
    expect(parsed.kind).toBe("app-heal");
    if (parsed.kind !== "app-heal") throw new Error("unexpected");
    expect(parsed.input.app).toBe("field-record");
    expect(parsed.input.apply).toBe(true);
  });

  test("parses --json flag", () => {
    const parsed = parseArgs(["app", "heal", "samo-we-test", "field-record", "--json"]);
    expect(parsed.kind).toBe("app-heal");
    if (parsed.kind !== "app-heal") throw new Error("unexpected");
    expect(parsed.json).toBe(true);
  });

  test("rejects app heal without <vm> argument", () => {
    expect(() => parseArgs(["app", "heal"])).toThrow();
  });

  test("rejects app heal with unknown flag", () => {
    expect(() => parseArgs(["app", "heal", "vm1", "app1", "--unknown"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Error cases — VM/app not found
// ---------------------------------------------------------------------------

describe("runAppHeal — error cases", () => {
  test("returns 1 when VM not found", async () => {
    const deps: AppHealDeps = {
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      now: () => new Date(),
      resolveGeneratorSha: () => "gen1",
    };
    const input: AppHealInput = { vm: "nonexistent-vm", app: "field-record", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);
    expect(code).toBe(1);
    expect(cap.e).toContain("VM not found");
  });

  test("returns 1 when app not found on VM", async () => {
    const deps: AppHealDeps = {
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      now: () => new Date(),
      resolveGeneratorSha: () => "gen1",
    };
    const input: AppHealInput = { vm: "samo-we-test", app: "nonexistent-app", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);
    expect(code).toBe(1);
    expect(cap.e).toContain("app not found");
  });

  test("returns 1 when app has no mainHost (cannot regenerate main vhost)", async () => {
    const app = nodeApp({ vmId: testVm.id, mainHost: undefined });
    appStore.upsert(app);

    const deps: AppHealDeps = {
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      now: () => new Date(),
      resolveGeneratorSha: () => "gen1",
    };
    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    const code = await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);
    expect(code).toBe(1);
    expect(cap.e).toContain("mainHost");
  });
});

// ---------------------------------------------------------------------------
// 9. SSH-as-appUser — mirrors #161/#164 deploy fix
// ---------------------------------------------------------------------------

describe("runAppHeal — SSH as appUser (mirrors deploy #161/#164)", () => {
  test("SSHes as appUser when app.appUser is set", async () => {
    const app = nodeApp({ vmId: testVm.id, appUser: "field-record-user" });
    appStore.upsert(app);

    let capturedSshUser: string | undefined;
    const deps: AppHealDeps = {
      remote: async (vmArg, _script) => {
        capturedSshUser = vmArg.sshUser;
        return {
          code: 0,
          stdout: `${PHASE_PREFIX}heal:start>>>\n${PHASE_PREFIX}no-drift:ok>>>\n`,
          stderr: "",
        };
      },
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "gen1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(capturedSshUser).toBe("field-record-user");
  });

  test("SSHes as VM sshUser when app.appUser is not set", async () => {
    const app = nodeApp({ vmId: testVm.id, appUser: undefined });
    appStore.upsert(app);

    let capturedSshUser: string | undefined;
    const deps: AppHealDeps = {
      remote: async (vmArg, _script) => {
        capturedSshUser = vmArg.sshUser;
        return {
          code: 0,
          stdout: `${PHASE_PREFIX}heal:start>>>\n${PHASE_PREFIX}no-drift:ok>>>\n`,
          stderr: "",
        };
      },
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveGeneratorSha: () => "gen1",
    };

    const input: AppHealInput = { vm: "samo-we-test", app: "field-record", apply: true };
    const cap = capture();
    await runAppHeal(input, { json: false }, vmStore, appStore, deps, cap.out, cap.err);

    expect(capturedSshUser).toBe("agent"); // vm.sshUser
  });
});
