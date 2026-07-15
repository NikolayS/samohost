/**
 * test/generator-stale.test.ts — RED/GREEN TDD for Phase 1 of the
 * "never silently lose an update" fix.
 *
 * Phase 1 scope:
 *   1. AppRecord.generatorSha?: string in src/types.ts
 *   2. Deploy success stamps generatorSha (injected dep, not live git call)
 *   3. checkGeneratorStaleness() — offline local-state check, no SSH
 *   4. runAppStatus non-JSON output shows gen: current / STALE / legacy line
 *
 * All tests in this file are RED before implementation and must go GREEN
 * with NO modification after Phase 1 implementation is complete.
 *
 * Note on "current generator sha" source: tests inject a literal string
 * so they run offline. Production defaults to
 *   () => execSync('git -C ~/samohost-trigger rev-parse HEAD').toString().trim()
 * which reads the canonical trigger checkout (always origin/main post-cycle),
 * not the operator's feature-branch shell cwd.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GROUP 2 + 3: offline staleness check + status output
import {
  checkGeneratorStaleness,
  type GeneratorStalenessResult,
} from "../src/commands/generator-stale.ts";

import {
  runAppRegister,
  runAppStatus,
} from "../src/commands/app.ts";

import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CURRENT_SHA = "aaaa1234567890abcdef1234567890abcdef1234";
const OLD_SHA     = "bbbb1234567890abcdef1234567890abcdef1234";

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-gen-test",
    provider: "hetzner",
    providerId: "99001",
    name: "samo-we-test",
    ip: "10.0.0.99",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "C".repeat(43),
    region: "fsn1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeAppRecord(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-gen-001",
    vmId: "vm-gen-test",
    name: "gen-test-app",
    repo: "samo-agent/gen-test",
    branch: "main",
    appDir: "/home/gen-test/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "gen-test",
    ...o,
  };
}

// ---------------------------------------------------------------------------
// GROUP 2 — offline staleness check
// checkGeneratorStaleness(apps, currentSha) → GeneratorStalenessResult[]
// ---------------------------------------------------------------------------

describe("GROUP 2 — checkGeneratorStaleness (offline, no SSH)", () => {
  test("app with generatorSha === currentSha reports status:current", () => {
    const app = makeAppRecord({ generatorSha: CURRENT_SHA });
    const results = checkGeneratorStaleness([app], CURRENT_SHA);
    expect(results).toHaveLength(1);
    expect(results[0]!.appId).toBe(app.id);
    expect(results[0]!.appName).toBe(app.name);
    expect(results[0]!.status).toBe("current");
  });

  test("app with generatorSha !== currentSha (OLD_SHA) reports status:stale", () => {
    const app = makeAppRecord({ generatorSha: OLD_SHA });
    const results = checkGeneratorStaleness([app], CURRENT_SHA);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("stale");
  });

  test("app with no generatorSha (legacy/absent) reports status:stale (treated as stale, not crash)", () => {
    const app = makeAppRecord();
    // generatorSha is undefined — legacy record
    expect(app.generatorSha).toBeUndefined();
    const results = checkGeneratorStaleness([app], CURRENT_SHA);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("stale");
  });

  test("mixed fleet: current + stale + legacy — all reported correctly", () => {
    const current = makeAppRecord({ id: "app-1", name: "app-current", generatorSha: CURRENT_SHA });
    const stale   = makeAppRecord({ id: "app-2", name: "app-stale",   generatorSha: OLD_SHA });
    const legacy  = makeAppRecord({ id: "app-3", name: "app-legacy"   });
    const results = checkGeneratorStaleness([current, stale, legacy], CURRENT_SHA);
    expect(results).toHaveLength(3);
    const byName = Object.fromEntries(results.map(r => [r.appName, r.status]));
    expect(byName["app-current"]).toBe("current");
    expect(byName["app-stale"]).toBe("stale");
    expect(byName["app-legacy"]).toBe("stale");
  });

  test("empty fleet returns empty array (no crash)", () => {
    const results = checkGeneratorStaleness([], CURRENT_SHA);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — runAppStatus shows gen: line (injected currentSha, offline)
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-gen-test-"));
  vmStore = new StateStore(join(dir, "vms.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  vmStore.upsert(makeVm());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

function registerApp(o: Partial<AppRecord> = {}) {
  const c = capture();
  runAppRegister(
    {
      vm: "samo-we-test",
      name: "gen-test-app",
      repo: "samo-agent/gen-test",
      branch: "main",
      appDir: "/home/gen-test/app",
      buildCmd: "npm run build",
      healthUrl: "http://localhost:3000/health",
      serviceUnit: "gen-test",
    },
    { json: false },
    vmStore,
    appStore,
    c.out,
    c.err,
  );
  // Upsert extra fields (generatorSha etc.) directly after register
  const rec = appStore.get("vm-gen-test", "gen-test-app");
  if (rec && Object.keys(o).length > 0) {
    appStore.upsert({ ...rec, ...o });
  }
}

describe("GROUP 3 — runAppStatus shows gen: column (offline)", () => {
  test("app with generatorSha === currentSha shows 'gen: current'", () => {
    registerApp({ generatorSha: CURRENT_SHA });
    const c = capture();
    const code = runAppStatus(
      { vm: "samo-we-test", app: "gen-test-app" },
      { json: false, currentGeneratorSha: CURRENT_SHA },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toMatch(/gen:\s+current/i);
  });

  test("app with stale generatorSha shows 'gen: STALE'", () => {
    registerApp({ generatorSha: OLD_SHA });
    const c = capture();
    const code = runAppStatus(
      { vm: "samo-we-test", app: "gen-test-app" },
      { json: false, currentGeneratorSha: CURRENT_SHA },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toMatch(/gen:\s+STALE/i);
  });

  test("app with no generatorSha (legacy) shows 'gen: legacy' or 'gen: STALE'", () => {
    registerApp();
    const c = capture();
    const code = runAppStatus(
      { vm: "samo-we-test", app: "gen-test-app" },
      { json: false, currentGeneratorSha: CURRENT_SHA },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    // Accept either 'legacy' or 'STALE' — both are correct policy for absent generatorSha
    expect(c.o).toMatch(/gen:\s+(legacy|STALE)/i);
  });

  test("runAppStatus --json includes generatorSha field from AppRecord", () => {
    registerApp({ generatorSha: CURRENT_SHA });
    const c = capture();
    const code = runAppStatus(
      { vm: "samo-we-test", app: "gen-test-app" },
      { json: true },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    expect(parsed.generatorSha).toBe(CURRENT_SHA);
  });
});
