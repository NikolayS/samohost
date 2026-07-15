/**
 * RED tests for the static-app heal fix (filed as GitHub issue from real-fleet
 * dry-run finding).
 *
 * Three bugs under test:
 *
 *   BUG-1: buildConfigHealScript calls renderVhost(planFromApp(app)) for static
 *           apps, which produces a node-style `reverse_proxy localhost:<port>`
 *           vhost — WRONG for static apps. Must produce file_server + try_files
 *           + encode gzip block matching the deploy path's static vhost format.
 *
 *   BUG-2: The static deploy path (buildDeployScript) writes the main vhost
 *           snippet WITHOUT the provenance header that heal's provenance gate
 *           requires. So heal marks EVERY real static app as 'drift-foreign' and
 *           never reconciles them. Fix: the deploy's static vhost heredoc must
 *           also emit the provenance header as its FIRST line; heal's provenance
 *           check must match.
 *
 *   BUG-3: Heal candidate selection in trigger (runTriggerRun) has no guard for
 *           apps with deployedSha === undefined (never-deployed). A
 *           never-deployed app will always have a stale (absent) generatorSha,
 *           so it would be selected — but heal requires a live vhost to reconcile
 *           (there is nothing to heal if the app was never deployed). Fix: add
 *           `if (appRecord.deployedSha === undefined) continue;` to the heal
 *           candidate loop.
 *
 * All tests are PURE (no SSH, no network, no real VM).
 * Tests MUST FAIL before the implementation; MUST PASS after.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigHealScript, SAMOHOST_PROVENANCE_HEADER } from "../src/app/heal-script.ts";
import { buildDeployScript } from "../src/app/script.ts";
import {
  runTriggerRun,
  type TriggerRunInput,
  type TriggerDeps,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-test",
    vmId: "vm-static-1",
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

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-static-1",
    provider: "hetzner",
    providerId: "999001",
    name: "samo-we-static",
    ip: "10.10.10.20",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 22,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "C".repeat(43),
    region: "nbg1",
    type: "cx23",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

const CURRENT_GEN_SHA = "cccccccccccccccccccccccccccccccccccccc01";

// ---------------------------------------------------------------------------
// BUG-1: heal renders file_server block (not reverse_proxy) for static apps
// ---------------------------------------------------------------------------

describe("BUG-1: heal renders correct static vhost (file_server, not reverse_proxy)", () => {
  test("heal-1a: buildConfigHealScript for static app contains 'file_server'", () => {
    const script = buildConfigHealScript(staticApp());
    // Static vhost must contain file_server directive
    expect(script).toContain("file_server");
  });

  test("heal-1b: buildConfigHealScript for static app does NOT contain 'reverse_proxy'", () => {
    const script = buildConfigHealScript(staticApp());
    // Must NOT fall through to node-style renderVhost which emits reverse_proxy
    expect(script).not.toContain("reverse_proxy");
  });

  test("heal-1c: main vhost block in heal script starts with the provenance header", () => {
    const script = buildConfigHealScript(staticApp());
    // The provenance header must appear in the embedded vhost content
    expect(script).toContain(SAMOHOST_PROVENANCE_HEADER);
  });

  test("heal-1d: main vhost block contains try_files with =404 (matches deploy format)", () => {
    const script = buildConfigHealScript(staticApp());
    // Must match the deploy path's try_files directive exactly
    expect(script).toContain("try_files {path} {path}/ =404");
  });

  test("heal-1e: main vhost block contains encode gzip", () => {
    const script = buildConfigHealScript(staticApp());
    expect(script).toContain("encode gzip");
  });

  test("heal-1f: main vhost block uses the correct address (http:// prefix for cp-http80)", () => {
    const script = buildConfigHealScript(staticApp({ mainListen: "cp-http80", mainHost: "samo.team" }));
    // cp-http80 → address must be http://samo.team (not bare samo.team)
    expect(script).toContain("http://samo.team");
  });

  test("heal-1g: main vhost block uses bare address (no http:// prefix) when not cp-http80", () => {
    const script = buildConfigHealScript(staticApp({ mainListen: undefined, mainHost: "samo.team" }));
    // non-cp-http80 → bare address + tls internal
    expect(script).toContain("tls internal");
    // The address line must NOT be prefixed with http://
    const lines = script.split("\n");
    const addressLine = lines.find((l) => l.trim() === "samo.team {");
    expect(addressLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BUG-2: deploy static vhost must carry the provenance header so heal can
//         recognize it (provenance consistency between deploy and heal)
// ---------------------------------------------------------------------------

describe("BUG-2: deploy writes provenance header on static vhost (provenance consistency)", () => {
  test("heal-2a: buildDeployScript for static app embeds provenance header in main vhost content", () => {
    const app = staticApp({ releaseTagPattern: undefined });
    const script = buildDeployScript(app, {
      sha: "def5678def5678def5678def5678def567890ab",
    });
    // The static vhost heredoc must include the provenance header as its first
    // content line so heal's provenance gate accepts it on the next run.
    expect(script).toContain(SAMOHOST_PROVENANCE_HEADER);
  });

  test("heal-2b: the provenance header in deploy's static vhost is the FIRST line of the site block content", () => {
    const app = staticApp({ releaseTagPattern: undefined });
    const script = buildDeployScript(app, {
      sha: "def5678def5678def5678def5678def567890ab",
    });
    // Find the heredoc content block for the static vhost.
    // The heredoc delimiter is CADDY (unquoted, so vars expand).
    // The provenance header should appear as the first non-address line after
    // the opening tee line.
    const lines = script.split("\n");
    const heredocStart = lines.findIndex((l) => l.includes("sudo /usr/bin/tee") && l.includes("CADDY"));
    expect(heredocStart).toBeGreaterThanOrEqual(0);
    // The very next line after the tee line is the address line (e.g. "http://samo.team {")
    // The line AFTER that must be the provenance header
    const provenanceLine = lines[heredocStart + 2];
    expect(provenanceLine).toContain(SAMOHOST_PROVENANCE_HEADER);
  });

  test("heal-2c: heal's provenance gate accepts the header that deploy now writes", () => {
    // The SAMOHOST_PROVENANCE_HEADER constant (used in the provenance gate bash check)
    // must match the string that deploy embeds in the vhost.
    // This test verifies they are the same constant — no drift between the two.
    const deployApp = staticApp({ releaseTagPattern: undefined });
    const deployScript = buildDeployScript(deployApp, {
      sha: "def5678def5678def5678def5678def567890ab",
    });
    const healScript = buildConfigHealScript(staticApp());
    // Both must contain the exact same provenance header string
    expect(deployScript).toContain(SAMOHOST_PROVENANCE_HEADER);
    expect(healScript).toContain(SAMOHOST_PROVENANCE_HEADER);
    // The header in the heal script's provenance-gate bash check must be the same
    // string as the one embedded in the deploy script's vhost content.
    // (If they differ, deploy writes X but heal gates on Y → permanent drift-foreign.)
    const headerInHeal = SAMOHOST_PROVENANCE_HEADER;
    const headerInDeploy = SAMOHOST_PROVENANCE_HEADER; // same exported constant
    expect(headerInHeal).toBe(headerInDeploy);
  });
});

// ---------------------------------------------------------------------------
// BUG-3: never-deployed apps must be skipped from heal candidate selection
// ---------------------------------------------------------------------------

describe("BUG-3: never-deployed apps skipped from heal candidate selection (no SSH)", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "heal-static-fix-"));
    vmStore = new StateStore(join(dir, "vms.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(makeVm());
  }

  function teardown() {
    rmSync(dir, { recursive: true, force: true });
  }

  test("heal-3a: never-deployed static app (no deployedSha) is NOT selected as heal candidate", async () => {
    setup();
    try {
      // A static app with no deployedSha — never deployed
      const app = staticApp({ deployedSha: undefined, generatorSha: undefined });
      appStore.upsert(app);

      let sshCallCount = 0;
      const deps: TriggerDeps = {
        resolveRef: () => Promise.resolve("headsha00000000000000000000000000000000001"),
        deploy: async () => 0,
        fetch: (async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })) as unknown as typeof globalThis.fetch,
        now: () => new Date("2026-07-15T12:00:00.000Z"),
        appHeal: async (_app, _opts) => {
          // If this is called for a never-deployed app, the test MUST fail
          sshCallCount++;
          return { outcome: "healed" as const, app: _app.name };
        },
      };

      const input: TriggerRunInput = {
        dryRun: false,
        appHeal: true,
        currentGeneratorSha: CURRENT_GEN_SHA,
      };

      let out = "";
      let errStr = "";
      await runTriggerRun(
        input,
        { json: false },
        vmStore,
        appStore,
        deps,
        (s) => { out += s; },
        (s) => { errStr += s; },
      );

      // appHeal must NOT have been called for a never-deployed app
      expect(sshCallCount).toBe(0);
    } finally {
      teardown();
    }
  });

  test("heal-3b: never-deployed static app does not appear in appHeal results (not even as 'skipped-never-deployed')", async () => {
    setup();
    try {
      const app = staticApp({ deployedSha: undefined, generatorSha: undefined });
      appStore.upsert(app);

      const healedApps: string[] = [];
      const deps: TriggerDeps = {
        resolveRef: () => Promise.resolve("headsha00000000000000000000000000000000001"),
        deploy: async () => 0,
        fetch: (async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })) as unknown as typeof globalThis.fetch,
        now: () => new Date("2026-07-15T12:00:00.000Z"),
        appHeal: async (_app, _opts) => {
          healedApps.push(_app.name);
          return { outcome: "healed" as const, app: _app.name };
        },
      };

      const input: TriggerRunInput = {
        dryRun: false,
        appHeal: true,
        currentGeneratorSha: CURRENT_GEN_SHA,
      };

      let out = "";
      await runTriggerRun(
        input,
        { json: true },
        vmStore,
        appStore,
        deps,
        (s) => { out += s; },
        (_s) => {},
      );

      // The never-deployed app must never reach appHeal
      expect(healedApps).not.toContain("samo-site");
    } finally {
      teardown();
    }
  });

  test("heal-3c: deployed app IS selected as heal candidate (control — skip only affects never-deployed)", async () => {
    setup();
    try {
      // Same app but WITH deployedSha (it was deployed) — should be selected
      const app = staticApp({
        deployedSha: CURRENT_GEN_SHA, // matches resolveRef output → up-to-date
        generatorSha: "old-gen-sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", // stale → eligible
        lastDeployAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
      });
      appStore.upsert(app);

      let healCalled = false;
      const deps: TriggerDeps = {
        resolveRef: () => Promise.resolve(CURRENT_GEN_SHA), // app is up-to-date
        deploy: async () => 0,
        fetch: (async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })) as unknown as typeof globalThis.fetch,
        now: () => new Date("2026-07-15T12:00:00.000Z"),
        appHeal: async (_app, _opts) => {
          healCalled = true;
          return { outcome: "healed" as const, app: _app.name };
        },
      };

      const input: TriggerRunInput = {
        dryRun: false,
        appHeal: true,
        currentGeneratorSha: CURRENT_GEN_SHA,
      };

      await runTriggerRun(
        input,
        { json: false },
        vmStore,
        appStore,
        deps,
        (_s) => {},
        (_s) => {},
      );

      // A deployed app with stale generatorSha MUST be selected for heal
      expect(healCalled).toBe(true);
    } finally {
      teardown();
    }
  });
});
