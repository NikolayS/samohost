/**
 * RED tests: selectable DB backend for preview envs (issue: no-DB apps can never
 * serve a preview because the platform forces dblab).
 *
 * Changes tested (all failing on current code):
 *   1. previewDbBackendFor() honors app.dbBackend: when dbBackend='none' and no
 *      explicit previewDbBackend, returns 'none' (currently returns 'dblab').
 *   2. parseSamohostToml accepts a `dbBackend` field in [app] (currently rejected
 *      as unknown key).
 *   3. parseSamohostToml accepts a `previewDbBackend` field in [app] (currently
 *      rejected as unknown key).
 *   4. preview-rebuild resolves db backend from the app record instead of
 *      hardcoding 'dblab' — when app has previewDbBackend='none' the
 *      EnvCreateInput.db must be 'none'.
 *   5. `preview rebuild --db none` is accepted by the CLI parser (currently throws
 *      UsageError on unknown flag).
 *   6. Fixture .samohost.toml with explicit dbBackend='none' parses to ok=true.
 *
 * RED commit: all of these MUST FAIL on the origin/main codebase.
 * GREEN commit: implementation passes them all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewDbBackendFor } from "../src/commands/trigger.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { parseArgs } from "../src/cli.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import {
  runPreviewRebuild,
  type PreviewRebuildDeps,
  type PreviewRebuildInput,
} from "../src/commands/preview-rebuild.ts";
import type { EnvCreateInput } from "../src/commands/env.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
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

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111",
    vmId: "vm-1111",
    name: "samohost-fixture",
    repo: "samo-agent/samohost-fixture",
    branch: "main",
    appDir: "/opt/samohost-fixture/app",
    buildCmd: "npm run build",
    serviceUnit: "samohost-fixture",
    healthUrl: "http://localhost:3000/api/version",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { err += s + "\n"; },
    get o() { return out; },
    get e() { return err; },
  };
}

// ---------------------------------------------------------------------------
// 1. previewDbBackendFor: honors app.dbBackend when previewDbBackend is absent
// ---------------------------------------------------------------------------

describe("previewDbBackendFor — dbBackend fallback", () => {
  test("db-1: app.dbBackend='none', no previewDbBackend → returns 'none'", () => {
    // Current code: returns app.previewDbBackend ?? 'dblab' = 'dblab' (WRONG).
    // Fixed code: returns app.previewDbBackend ?? (app.dbBackend === 'none' ? 'none' : 'dblab') = 'none'.
    const app = makeApp({ dbBackend: "none" });
    expect(previewDbBackendFor(app)).toBe("none");
  });

  test("db-2: app.dbBackend='none' AND previewDbBackend='dblab' → explicit override wins", () => {
    // Explicit previewDbBackend ALWAYS wins regardless of dbBackend.
    const app = makeApp({ dbBackend: "none", previewDbBackend: "dblab" });
    expect(previewDbBackendFor(app)).toBe("dblab");
  });

  test("db-3: app.dbBackend='dblab', no previewDbBackend → returns 'dblab'", () => {
    // dbBackend != 'none' → still defaults to 'dblab'.
    const app = makeApp({ dbBackend: "dblab" });
    expect(previewDbBackendFor(app)).toBe("dblab");
  });

  test("db-4: neither dbBackend nor previewDbBackend set → returns 'dblab' (no regression)", () => {
    // Regression guard: the existing default must not change.
    const app = makeApp();
    expect(previewDbBackendFor(app)).toBe("dblab");
  });

  test("db-5: app.dbBackend='template', no previewDbBackend → returns 'dblab' (template on app != template on preview)", () => {
    // Only 'none' on dbBackend propagates; 'template' on the app level does not
    // implicitly force template previews — explicit previewDbBackend is required.
    const app = makeApp({ dbBackend: "template" });
    expect(previewDbBackendFor(app)).toBe("dblab");
  });
});

// ---------------------------------------------------------------------------
// 2. parseSamohostToml: dbBackend field accepted
// ---------------------------------------------------------------------------

describe("parseSamohostToml — dbBackend field", () => {
  const minimalToml = `
name = "samohost-fixture"
repo = "samo-agent/samohost-fixture"
branch = "main"
appDir = "/opt/samohost-fixture/app"
buildCmd = "npm run build"
healthUrl = "http://localhost:3000/api/version"
serviceUnit = "samohost-fixture"
`;

  test("toml-1: dbBackend='none' is accepted (not rejected as unknown key)", () => {
    // Current code: APP_KEYS does not include 'dbBackend' → {ok:false, errors:['unknown top-level key: dbBackend']}.
    // Fixed code: APP_KEYS includes 'dbBackend' → parses ok.
    const result = parseSamohostToml(minimalToml + `\ndbBackend = "none"\n`);
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.dbBackend).toBe("none");
  });

  test("toml-2: dbBackend='dblab' is accepted", () => {
    // Updated (PR secrets+databaseUrlEnv): explicit dbBackend='dblab' requires databaseUrlEnv.
    const result = parseSamohostToml(
      minimalToml + `\ndbBackend = "dblab"\ndatabaseUrlEnv = "DATABASE_URL"\n`,
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.dbBackend).toBe("dblab");
  });

  test("toml-3: dbBackend='template' is accepted", () => {
    // Updated (PR secrets+databaseUrlEnv): explicit dbBackend='template' requires databaseUrlEnv.
    const result = parseSamohostToml(
      minimalToml + `\ndbBackend = "template"\ndatabaseUrlEnv = "DATABASE_URL"\n`,
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.dbBackend).toBe("template");
  });

  test("toml-4: invalid dbBackend value is rejected with a clear error", () => {
    const result = parseSamohostToml(minimalToml + `\ndbBackend = "postgres"\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("dbBackend"))).toBe(true);
  });

  test("toml-5: absent dbBackend → app.dbBackend is undefined (optional)", () => {
    const result = parseSamohostToml(minimalToml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.dbBackend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. parseSamohostToml: previewDbBackend field accepted
// ---------------------------------------------------------------------------

describe("parseSamohostToml — previewDbBackend field", () => {
  const minimalToml = `
name = "samohost-fixture"
repo = "samo-agent/samohost-fixture"
branch = "main"
appDir = "/opt/samohost-fixture/app"
buildCmd = "npm run build"
healthUrl = "http://localhost:3000/api/version"
serviceUnit = "samohost-fixture"
`;

  test("toml-prev-1: previewDbBackend='none' is accepted (not rejected as unknown key)", () => {
    // Current code: APP_KEYS does not include 'previewDbBackend' → {ok:false, errors:['unknown top-level key: previewDbBackend']}.
    // Fixed code: parses ok.
    const result = parseSamohostToml(
      minimalToml + `\ndbBackend = "none"\npreviewDbBackend = "none"\n`,
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.previewDbBackend).toBe("none");
  });

  test("toml-prev-2: previewDbBackend='dblab' is accepted", () => {
    // Updated (PR secrets+databaseUrlEnv): explicit previewDbBackend='dblab' requires databaseUrlEnv.
    const result = parseSamohostToml(
      minimalToml + `\npreviewDbBackend = "dblab"\ndatabaseUrlEnv = "DATABASE_URL"\n`,
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.previewDbBackend).toBe("dblab");
  });

  test("toml-prev-3: absent previewDbBackend → app.previewDbBackend is undefined", () => {
    const result = parseSamohostToml(minimalToml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.previewDbBackend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. runPreviewRebuild: db backend resolved from app, not hardcoded
// ---------------------------------------------------------------------------

describe("runPreviewRebuild — db backend resolution", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-rebuild-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeRebuildDeps(
    capturedInputs: EnvCreateInput[],
  ): PreviewRebuildDeps {
    return {
      runEnvCreate: async (input, _opts, _vmStore, _appStore, _envStore, _execDeps, _out, _err) => {
        capturedInputs.push(input);
        return 0;
      },
      vmStore,
      appStore,
      envStore: {
        get: () => undefined,
        list: () => [],
        listFor: () => [],
        upsert: () => {},
        remove: () => {},
      } as any,
    };
  }

  test("rebuild-1: app has previewDbBackend='none' → EnvCreateInput.db='none' (not 'dblab')", async () => {
    // Current code: EnvCreateInput.db is HARDCODED to 'dblab' → captured input.db='dblab' (WRONG).
    // Fixed code: resolves via previewDbBackendFor(app) → 'none'.
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ dbBackend: "none", previewDbBackend: "none" }));

    const capturedInputs: EnvCreateInput[] = [];
    const deps = makeRebuildDeps(capturedInputs);

    const input: PreviewRebuildInput = {
      vm: "samo-we-field-record",
      app: "samohost-fixture",
      branch: "feat/test",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(0);
    expect(capturedInputs).toHaveLength(1);
    // The critical assertion: db must be 'none', not the hardcoded 'dblab'.
    expect(capturedInputs[0]!.db).toBe("none");
  });

  test("rebuild-2: app has dbBackend='none' and no previewDbBackend → EnvCreateInput.db='none'", async () => {
    // previewDbBackendFor fallback: dbBackend='none' propagates to preview.
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ dbBackend: "none" }));

    const capturedInputs: EnvCreateInput[] = [];
    const deps = makeRebuildDeps(capturedInputs);

    const input: PreviewRebuildInput = {
      vm: "samo-we-field-record",
      app: "samohost-fixture",
      branch: "feat/test",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(0);
    expect(capturedInputs[0]!.db).toBe("none");
  });

  test("rebuild-3: app with no dbBackend/previewDbBackend → EnvCreateInput.db='dblab' (no regression)", async () => {
    // Standard DB app: preview still uses dblab.
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp());

    const capturedInputs: EnvCreateInput[] = [];
    const deps = makeRebuildDeps(capturedInputs);

    const input: PreviewRebuildInput = {
      vm: "samo-we-field-record",
      app: "samohost-fixture",
      branch: "feat/test",
    };
    const c = capture();
    const code = await runPreviewRebuild(input, { json: false }, deps, c.out, c.err);

    expect(code).toBe(0);
    expect(capturedInputs[0]!.db).toBe("dblab");
  });

  test("rebuild-4: --db none CLI override → EnvCreateInput.db='none' regardless of app config", async () => {
    // Operator explicitly passes --db none on the command line.
    // This test also covers that PreviewRebuildInput accepts a db field.
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp()); // no previewDbBackend, no dbBackend

    const capturedInputs: EnvCreateInput[] = [];
    const deps = makeRebuildDeps(capturedInputs);

    const input: PreviewRebuildInput & { db?: "dblab" | "template" | "none" } = {
      vm: "samo-we-field-record",
      app: "samohost-fixture",
      branch: "feat/test",
      db: "none",
    };
    const c = capture();
    const code = await runPreviewRebuild(input as PreviewRebuildInput, { json: false }, deps, c.out, c.err);

    expect(code).toBe(0);
    // --db override must win over the default.
    expect(capturedInputs[0]!.db).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 5. CLI parser: `preview rebuild --db <backend>` accepted
// ---------------------------------------------------------------------------

describe("parseArgs: preview rebuild --db flag", () => {
  test("cli-rebuild-1: preview rebuild vm1 app1 feat/x --db none → db='none'", () => {
    // Current code: '--db' is unknown flag → UsageError.
    // Fixed code: accepted, sets input.db='none'.
    const cmd = parseArgs(["preview", "rebuild", "vm1", "app1", "feat/x", "--db", "none"]);
    if (cmd.kind !== "preview-rebuild") throw new Error(`expected preview-rebuild, got ${cmd.kind}`);
    expect((cmd.input as any).db).toBe("none");
  });

  test("cli-rebuild-2: preview rebuild vm1 app1 feat/x --db dblab → db='dblab'", () => {
    const cmd = parseArgs(["preview", "rebuild", "vm1", "app1", "feat/x", "--db", "dblab"]);
    if (cmd.kind !== "preview-rebuild") throw new Error(`expected preview-rebuild, got ${cmd.kind}`);
    expect((cmd.input as any).db).toBe("dblab");
  });

  test("cli-rebuild-3: preview rebuild vm1 app1 feat/x (no --db) → db absent/undefined", () => {
    // Without --db, db resolves from app at runtime (not at parse time).
    const cmd = parseArgs(["preview", "rebuild", "vm1", "app1", "feat/x"]);
    if (cmd.kind !== "preview-rebuild") throw new Error(`expected preview-rebuild, got ${cmd.kind}`);
    // db should be absent (undefined) — resolution happens in runPreviewRebuild.
    expect((cmd.input as any).db).toBeUndefined();
  });

  test("cli-rebuild-4: preview rebuild with invalid --db value throws UsageError", () => {
    expect(() =>
      parseArgs(["preview", "rebuild", "vm1", "app1", "feat/x", "--db", "postgres"])
    ).toThrow(/invalid --db/);
  });
});

// ---------------------------------------------------------------------------
// 6. Fixture .samohost.toml with dbBackend='none' (what the fixture SHOULD declare)
// ---------------------------------------------------------------------------

describe("fixture toml with dbBackend='none'", () => {
  const FIXTURE_WITH_DB_BACKEND = `
# .samohost.toml — fixture for samohost-fixture app (test data only; no secrets)
name        = "samohost-fixture"
repo        = "samo-agent/samohost-fixture"
branch      = "main"
appDir      = "/opt/samohost-fixture/app"
buildCmd    = "npm run build"
healthUrl   = "http://localhost:3000/api/version"
serviceUnit = "samohost-fixture"
dbBackend   = "none"

[provision]
serverType = "cx23"
location   = "fsn1"
`;

  test("fixture-1: fixture toml with dbBackend='none' parses to ok=true", () => {
    // Current code: 'dbBackend' is unknown → {ok:false}.
    // Fixed code: parses ok.
    const result = parseSamohostToml(FIXTURE_WITH_DB_BACKEND);
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.app.dbBackend).toBe("none");
  });

  test("fixture-2: fixture toml: previewDbBackendFor resolves 'none' when dbBackend='none'", () => {
    // End-to-end: parse the toml, construct an AppRecord, call previewDbBackendFor.
    const result = parseSamohostToml(FIXTURE_WITH_DB_BACKEND);
    if (!result.ok) throw new Error(result.errors.join(", "));

    // Simulate the AppRecord that would be registered from this manifest.
    const app = makeApp({
      dbBackend: result.app.dbBackend,
      previewDbBackend: result.app.previewDbBackend,
    });
    expect(previewDbBackendFor(app)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 7. buildEnvCreateScript with db='none': no db-preflight phase emitted
//    (regression guard: the script.ts none-backend path must stay clean)
// ---------------------------------------------------------------------------

import { buildEnvCreateScript } from "../src/env/script.ts";
import type { EnvScriptTarget } from "../src/env/script.ts";

describe("buildEnvCreateScript(db='none'): no-DB preview script", () => {
  function app() {
    return makeApp() as any; // AppRecord shape compatible with script builder
  }

  function target(db: "dblab" | "template" | "none"): EnvScriptTarget {
    return {
      name: "samohost-fixture-feat-x",
      branch: "feat/x",
      port: 3100,
      vhost: "samohost-fixture-feat-x.samo.cat",
      dbBackend: db,
    };
  }

  test("none-1: db='none' script contains no db-preflight phase marker", () => {
    const s = buildEnvCreateScript(app(), target("none"));
    expect(s).not.toContain("db-preflight");
  });

  test("none-2: db='none' script contains no dblab clone create", () => {
    const s = buildEnvCreateScript(app(), target("none"));
    expect(s).not.toContain("clone create");
    expect(s).not.toContain("SAMOHOST_DBLAB_BIN");
  });

  test("none-3: db='none' script still contains clone (git clone), install, build, unit phases", () => {
    const s = buildEnvCreateScript(app(), target("none"));
    // The git checkout phase must still be there (no-DB app still needs code).
    expect(s).toContain("samohost_clone_env_dir");
    // The unit phase must still restart the service.
    expect(s).toContain("systemctl");
  });
});
