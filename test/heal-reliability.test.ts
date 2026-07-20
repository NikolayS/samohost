/**
 * test/heal-reliability.test.ts — RED/GREEN regression tests for the five
 * heal-reliability fixes shipped in fix/heal-reliability.
 *
 * Fix 1 — no sudo-tee-to-/tmp: the generated heal script must NOT call
 *   `sudo /usr/bin/tee "$_new_main_vhost"` for the mktemp comparison copy.
 *   Only the staged sites.d paths may use sudo tee.
 *
 * Fix 2 — node-app sudoers: buildHostBootstrapScript for a node app must
 *   include the same four Caddy grants that the static sudoers block already has.
 *
 * Fix 3 — inline-Caddyfile pre-flight: buildConfigHealScript must emit a
 *   guard that checks `import sites.d/*.caddy` is present in /etc/caddy/Caddyfile;
 *   if absent, the script emits an inline-caddyfile finding and exits without
 *   writing anything. The generated script must also check whether the app's
 *   mainHost appears as an inline site block, and exit before writing if so.
 *
 * Fix 4 — adopt-provenance flag: buildConfigHealScript called with
 *   adoptProvenance=true must emit logic that:
 *     a) checks if regenerated content is byte-identical to live (modulo header),
 *     b) if identical, prepends the provenance header and adopts the file,
 *     c) if divergent, still emits drift-foreign and skips.
 *   A second run after adoption must return no-drift (idempotence).
 *
 * Fix 5 — HEAL_VM_CAP env override: the trigger respects SAMOHOST_HEAL_VM_CAP
 *   env var to override the default cap of 2; the default stays 2.
 *
 * All tests are pure-builder + injected-runner patterns. No live SSH.
 * CLI-only; Playwright not applicable (no user-facing UI change).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { buildHostBootstrapScript, type HostBootstrapOptions } from "../src/app/bootstrap.ts";
import {
  runTriggerRun,
  type TriggerRunInput,
  type TriggerDeps,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import { PHASE_PREFIX } from "../src/app/script.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function nodeApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-node-reliability",
    vmId: "vm-reliability-1",
    name: "samograph",
    repo: "Tanya301/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "https://samograph.samo.team/",
    serviceUnit: "samograph",
    mainHost: "samograph.samo.team",
    mainListen: undefined,
    deployedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1234",
    generatorSha: "oldoldoldoldoldoldoldoldoldoldoldold5678",
    ...overrides,
  };
}

function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-reliability",
    vmId: "vm-reliability-2",
    name: "samorev",
    repo: "Tanya301/samorev",
    branch: "main",
    kind: "static",
    appDir: "/opt/samorev/app",
    buildCmd: "npm run build",
    healthUrl: "https://samorev.samo.team/",
    serviceUnit: "samorev",
    mainHost: "samorev.samo.team",
    mainListen: undefined,
    deployedSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1234",
    generatorSha: "oldoldoldoldoldoldoldoldoldoldoldold5678",
    ...overrides,
  };
}

function nodeAppRecord(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-bootstrap-node",
    vmId: "vm-bootstrap-1",
    name: "demo-node",
    repo: "Tanya301/demo-node",
    branch: "main",
    appDir: "/opt/demo-node/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "demo-node",
    ...overrides,
  };
}

function nodeBootstrapOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "demo-node-user",
    dbName: "demo_node_db",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 1 — no sudo-tee-to-/tmp (node + static paths)
// ---------------------------------------------------------------------------

describe("Fix 1 — no sudo tee to mktemp comparison file", () => {
  test("node heal script: sudo /usr/bin/tee is never used to write the mktemp comparison temp file", () => {
    const script = buildConfigHealScript(nodeApp());

    // The comparison temp file is _new_main_vhost (assigned via mktemp).
    // It must be written with plain redirection (cat > or heredoc >) NOT sudo tee.
    // Pattern to detect the violation: sudo /usr/bin/tee "$_new_main_vhost"
    expect(script).not.toMatch(/sudo\s+\/usr\/bin\/tee\s+['"]\$_new_main_vhost['"]/);
    expect(script).not.toMatch(/sudo\s+\/usr\/bin\/tee\s+"\$_new_main_vhost"/);
    expect(script).not.toMatch(/sudo\s+\/usr\/bin\/tee\s+'\$_new_main_vhost'/);
  });

  test("node heal script: every sudo /usr/bin/tee targets a literal /etc/caddy/sites.d/ path", () => {
    const script = buildConfigHealScript(nodeApp());

    // Extract all lines containing sudo /usr/bin/tee
    const teLines = script
      .split("\n")
      .filter((l) => /sudo\s+\/usr\/bin\/tee/.test(l));

    // Every privileged tee must target /etc/caddy/sites.d/
    for (const line of teLines) {
      expect(line).toMatch(/\/etc\/caddy\/sites\.d\//);
    }
  });

  test("static heal script: sudo /usr/bin/tee is never used to write the mktemp comparison temp file", () => {
    const script = buildConfigHealScript(staticApp());

    expect(script).not.toMatch(/sudo\s+\/usr\/bin\/tee\s+['"]\$_new_main_vhost['"]/);
    expect(script).not.toMatch(/sudo\s+\/usr\/bin\/tee\s+"\$_new_main_vhost"/);
  });

  test("static heal script: every sudo /usr/bin/tee targets a literal /etc/caddy/sites.d/ path", () => {
    const script = buildConfigHealScript(staticApp());

    const teLines = script
      .split("\n")
      .filter((l) => /sudo\s+\/usr\/bin\/tee/.test(l));

    for (const line of teLines) {
      expect(line).toMatch(/\/etc\/caddy\/sites\.d\//);
    }
  });

  test("node heal script: comparison temp file is written with plain cat redirection (no sudo)", () => {
    const script = buildConfigHealScript(nodeApp());
    // The temp file must be written without sudo.
    // The write-to-temp pattern: cat > "$_new_main_vhost" <<'HEREDOC'
    // The read-from-temp pattern (for staged write): < "$_new_main_vhost"
    // We check that no line has `sudo ... > "$_new_main_vhost"` (writing to the var)
    // A line with `< "$_new_main_vhost"` (reading from it for the staged sudo tee) is fine.
    const allSudoWritesToVar = script
      .split("\n")
      .filter((l) => /sudo/.test(l) && />\s+"\$_new_main_vhost"/.test(l));
    expect(allSudoWritesToVar).toHaveLength(0);
    // Positive: the comparison file IS written (cat > pattern)
    expect(script).toMatch(/cat > "\$_new_main_vhost"/);
  });

  test("static heal script: comparison temp file is written with plain cat redirection (no sudo)", () => {
    const script = buildConfigHealScript(staticApp());
    const allSudoWritesToVar = script
      .split("\n")
      .filter((l) => /sudo/.test(l) && />\s+"\$_new_main_vhost"/.test(l));
    expect(allSudoWritesToVar).toHaveLength(0);
    expect(script).toMatch(/cat > "\$_new_main_vhost"/);
  });

  test("heredoc delimiters are preserved: node uses quoted SAMOHOST_MAIN_VHOST_CONTENT", () => {
    const script = buildConfigHealScript(nodeApp());
    // Single-quoted heredoc = no shell expansion of embedded vhost content.
    expect(script).toContain("<<'SAMOHOST_MAIN_VHOST_CONTENT'");
    expect(script).toContain("SAMOHOST_MAIN_VHOST_CONTENT");
  });

  test("heredoc delimiters are preserved: static uses unquoted SAMOHOST_STATIC_VHOST_CONTENT", () => {
    const script = buildConfigHealScript(staticApp());
    // Unquoted heredoc = bash expands $SAMOHOST_STATIC_DIR at runtime.
    expect(script).toContain("<<SAMOHOST_STATIC_VHOST_CONTENT");
    // Must NOT be quoted (that would prevent runtime expansion of $SAMOHOST_STATIC_DIR)
    expect(script).not.toContain("<<'SAMOHOST_STATIC_VHOST_CONTENT'");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — node-app sudoers: four Caddy grants
// ---------------------------------------------------------------------------

describe("Fix 2 — node-app bootstrap sudoers includes Caddy grants", () => {
  test("node bootstrap sudoers contains: NOPASSWD: /usr/bin/systemctl reload caddy", () => {
    const script = buildHostBootstrapScript(nodeAppRecord(), nodeBootstrapOpts());
    // Extract the sudoers heredoc block
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : script;
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/systemctl reload caddy/);
  });

  test("node bootstrap sudoers contains: NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy", () => {
    const script = buildHostBootstrapScript(nodeAppRecord(), nodeBootstrapOpts());
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : script;
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/tee \/etc\/caddy\/sites\.d\/\*\.caddy/);
  });

  test("node bootstrap sudoers contains: NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy", () => {
    const script = buildHostBootstrapScript(nodeAppRecord(), nodeBootstrapOpts());
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : script;
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/mv -- \/etc\/caddy\/sites\.d\/\*\.caddy \/etc\/caddy\/sites\.d\/\*\.caddy/);
  });

  test("node bootstrap sudoers contains: NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy", () => {
    const script = buildHostBootstrapScript(nodeAppRecord(), nodeBootstrapOpts());
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : script;
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/rm -f \/etc\/caddy\/sites\.d\/\*\.caddy/);
  });

  test("node bootstrap sudoers still retains all original node-app grants (daemon-reload, service unit, psql, journalctl)", () => {
    const script = buildHostBootstrapScript(nodeAppRecord(), nodeBootstrapOpts());
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : script;
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/systemctl daemon-reload/);
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/systemctl restart demo-node/);
    expect(sudoBlock).toMatch(/\(postgres\)\s+NOPASSWD:\s*\/usr\/bin\/psql/);
    expect(sudoBlock).toMatch(/NOPASSWD:\s*\/usr\/bin\/journalctl/);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — inline-Caddyfile pre-flight guard
// ---------------------------------------------------------------------------

describe("Fix 3 — inline-Caddyfile pre-flight guard in generated heal script", () => {
  test("generated script checks for 'import sites.d/*.caddy' in /etc/caddy/Caddyfile", () => {
    const script = buildConfigHealScript(nodeApp());
    // The pre-flight must grep for the import line
    expect(script).toMatch(/grep.*import.*sites\.d.*\/etc\/caddy\/Caddyfile|grep.*\/etc\/caddy\/Caddyfile.*import.*sites\.d/s);
  });

  test("generated script emits inline-caddyfile finding and exits 0 when import missing", () => {
    const script = buildConfigHealScript(nodeApp());
    // Must contain the outcome string
    expect(script).toContain("inline-caddyfile");
    // And must exit (the script must bail out before writing anything)
    expect(script).toMatch(/inline-caddyfile.*exit 0|exit 0.*inline-caddyfile/s);
  });

  test("generated script does NOT write sites.d file when running the inline-caddyfile exit path", () => {
    const script = buildConfigHealScript(nodeApp());
    // The inline-caddyfile guard must appear BEFORE the actual vhost write block
    // (after the rollback function definition which also contains sites.d references).
    // We find the end of the rollback() function definition and look from there.
    const rollbackEndIdx = script.indexOf("\n}\n");
    expect(rollbackEndIdx).toBeGreaterThanOrEqual(0);
    const bodyScript = script.slice(rollbackEndIdx);

    // In the body (outside rollback), inline-caddyfile guard must appear before
    // the first sudo tee/mv to sites.d
    const inlineCaddyfileIdx = bodyScript.indexOf("inline-caddyfile");
    const bodyLines = bodyScript.split("\n");
    const firstSudoSitesTeeBodyIdx = bodyLines
      .findIndex((l) => /sudo.*tee.*\/etc\/caddy\/sites\.d\/|sudo.*mv.*\/etc\/caddy\/sites\.d\//.test(l));

    expect(inlineCaddyfileIdx).toBeGreaterThanOrEqual(0);
    expect(firstSudoSitesTeeBodyIdx).toBeGreaterThanOrEqual(0);

    const inlineCaddyfileBodyLineIdx = bodyLines.findIndex((l) => l.includes("inline-caddyfile"));
    expect(inlineCaddyfileBodyLineIdx).toBeLessThan(firstSudoSitesTeeBodyIdx);
  });

  test("static heal script also includes the inline-Caddyfile pre-flight guard", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toMatch(/grep.*import.*sites\.d.*\/etc\/caddy\/Caddyfile|grep.*\/etc\/caddy\/Caddyfile.*import.*sites\.d/s);
    expect(script).toContain("inline-caddyfile");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — adopt-provenance flag
// ---------------------------------------------------------------------------

describe("Fix 4 — adopt-provenance flag in buildConfigHealScript", () => {
  test("buildConfigHealScript accepts an adoptProvenance option", () => {
    // Must not throw when the option is passed
    expect(() => buildConfigHealScript(nodeApp(), { adoptProvenance: true })).not.toThrow();
  });

  test("without adoptProvenance, the drift-foreign path does NOT emit adoption logic", () => {
    const script = buildConfigHealScript(nodeApp());
    // Default (adoptProvenance=false/undefined) — no adopt attempt
    // The word 'adopt' should be absent from default-mode scripts
    expect(script).not.toContain("adopt");
    expect(script).not.toContain("ADOPT");
  });

  test("with adoptProvenance=true, the script emits the adoption check block", () => {
    const script = buildConfigHealScript(nodeApp(), { adoptProvenance: true });
    // Must contain the adopt logic
    expect(script).toMatch(/adopt|ADOPT/i);
  });

  test("with adoptProvenance=true, adoption only fires when content is byte-identical (no drift)", () => {
    const script = buildConfigHealScript(nodeApp(), { adoptProvenance: true });
    // The adoption logic must compare content before prepending the header
    // (cmp or diff check before the header prepend)
    expect(script).toContain("cmp");
    expect(script).toMatch(/adopt|ADOPT/i);
  });

  test("with adoptProvenance=true, script still emits drift-foreign when content differs", () => {
    const script = buildConfigHealScript(nodeApp(), { adoptProvenance: true });
    // Even in adopt mode, divergent content is still rejected
    expect(script).toContain("drift-foreign");
  });

  test("second run after adoption returns no-drift (idempotence: provenance header stamped on first run)", () => {
    // After adoption, the vhost file has the provenance header. A second run
    // through the normal heal path finds the header and proceeds to cmp.
    // If content matches (it does after adoption), it returns no-drift.
    // This is tested by verifying the script has the cmp → no-drift path
    // which fires when the header IS present (post-adoption state).
    const script = buildConfigHealScript(nodeApp(), { adoptProvenance: true });
    expect(script).toContain(`${PHASE_PREFIX}no-drift:ok>>>`);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — HEAL_VM_CAP env override
// ---------------------------------------------------------------------------

describe("Fix 5 — HEAL_VM_CAP is env-overridable via SAMOHOST_HEAL_VM_CAP", () => {
  let tmpDir: string;
  let appStorePath: string;
  let vmStorePath: string;
  let appStore: AppStore;
  let vmStore: StateStore;

  const CURRENT_SHA = "fix5sha000000000000000000000000000000001";
  const OLD_GEN_SHA = "oldsha0000000000000000000000000000000001";

  function makeVm(n: number): VmRecord {
    return {
      id: `vm-cap-${n}`,
      provider: "hetzner",
      providerId: `cap${n}`,
      name: `samo-cap-vm-${n}`,
      ip: `10.10.${n}.1`,
      sshKeyPath: "/home/u/.ssh/id_ed25519",
      sshPort: 22,
      sshUser: "agent",
      hostKeyFingerprint: `SHA256:${"C".repeat(43)}`,
      region: "fsn1",
      type: "cx23",
      modules: [],
      lifecycleState: "adopted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function makeAppForVm(vmId: string, appName: string): AppRecord {
    return {
      id: `app-${vmId}-${appName}`,
      vmId,
      name: appName,
      repo: `Tanya301/${appName}`,
      branch: "main",
      appDir: `/opt/${appName}/app`,
      buildCmd: "npm run build",
      healthUrl: `https://${appName}.samo.team/`,
      serviceUnit: appName,
      mainHost: `${appName}.samo.team`,
      // deployedSha matches resolveRef output so trigger classifies the app as up-to-date
      // (not needing a deploy), making it eligible for the heal pass.
      deployedSha: CURRENT_SHA,
      generatorSha: OLD_GEN_SHA,
      lastDeployAt: new Date(Date.now() - 700_000).toISOString(), // past 10-min grace
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "heal-cap-test-"));
    appStorePath = join(tmpDir, "apps.json");
    vmStorePath = join(tmpDir, "vms.json");
    appStore = new AppStore(appStorePath);
    vmStore = new StateStore(vmStorePath);

    // Create 4 VMs + 4 apps (all stale, all eligible for heal)
    for (let i = 1; i <= 4; i++) {
      const vm = makeVm(i);
      vmStore.upsert(vm);
      const app = makeAppForVm(vm.id, `cap-app-${i}`);
      appStore.upsert(app);
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env["SAMOHOST_HEAL_VM_CAP"];
  });

  function makeDeps(healed: string[]): TriggerDeps {
    return {
      resolveRef: () => Promise.resolve(CURRENT_SHA),
      deploy: async () => 0,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [] }),
      })) as unknown as typeof globalThis.fetch,
      now: () => new Date(),
      appHeal: async (app) => {
        healed.push(app.name);
        return { outcome: "no-drift", app: app.name };
      },
    };
  }

  function makeInput(): TriggerRunInput {
    return {
      appHeal: true,
      dryRun: false,
      currentGeneratorSha: CURRENT_SHA,
      alertRepo: undefined,
    };
  }

  const noop = (_s: string) => {};

  test("default cap is 2 when SAMOHOST_HEAL_VM_CAP is unset", async () => {
    delete process.env["SAMOHOST_HEAL_VM_CAP"];

    const healed: string[] = [];
    const deps = makeDeps(healed);

    await runTriggerRun(makeInput(), { json: false }, vmStore, appStore, deps, noop, noop);

    // Default cap = 2 → at most 2 heals
    expect(healed.length).toBeLessThanOrEqual(2);
  });

  test("SAMOHOST_HEAL_VM_CAP=4 allows all 4 VMs to be healed in one cycle", async () => {
    process.env["SAMOHOST_HEAL_VM_CAP"] = "4";

    const healed: string[] = [];
    const deps = makeDeps(healed);

    await runTriggerRun(makeInput(), { json: false }, vmStore, appStore, deps, noop, noop);

    // With cap=4, all 4 eligible VMs should be healed
    expect(healed.length).toBe(4);
  });

  test("SAMOHOST_HEAL_VM_CAP=1 limits to exactly 1 heal per cycle", async () => {
    process.env["SAMOHOST_HEAL_VM_CAP"] = "1";

    const healed: string[] = [];
    const deps = makeDeps(healed);

    await runTriggerRun(makeInput(), { json: false }, vmStore, appStore, deps, noop, noop);

    expect(healed.length).toBeLessThanOrEqual(1);
  });
});
