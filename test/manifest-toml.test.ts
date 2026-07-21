/**
 * PR-D — .samohost.toml reader tests (field-record-1#117 samohost PR-D).
 *
 * RED commit: all assertions are written; the module does not exist yet.
 *
 * Coverage:
 *   - valid full manifest parses to expected AppManifest + ProvisionManifest
 *   - ALL missing required fields reported (not just the first)
 *   - wrong field types produce specific errors
 *   - unknown top-level key → error naming the key (typo protection)
 *   - unknown [provision] key → error
 *   - malformed TOML → {ok:false}, never throws
 *   - [provision].labels parses to string→string record; non-string value → error
 *   - INTEGRATION: `app register --from-toml <fixture> <vm>` via runAppRegister
 *     with a temp store — registers the app, malformed manifest exits 1, no persist
 *   - round-trip: AppSpec from --from-toml equals AppSpec from equivalent flags
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { runAppRegister, runAppRegisterFromToml } from "../src/commands/app.ts";
import { previewDbBackendFor } from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "samohost.toml");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/fixture/.ssh/id_ed25519",
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

// ---------------------------------------------------------------------------
// parseSamohostToml — valid manifest
// ---------------------------------------------------------------------------

describe("parseSamohostToml — valid full manifest", () => {
  test("complete fixture parses to ok=true", () => {
    const result = parseSamohostToml(FIXTURE_TEXT);
    expect(result.ok).toBe(true);
  });

  test("all required app fields are present and correct", () => {
    const result = parseSamohostToml(FIXTURE_TEXT);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.name).toBe("field-record");
    expect(result.app.repo).toBe("Tanya301/field-record-1");
    expect(result.app.branch).toBe("main");
    expect(result.app.appDir).toBe("/opt/field-record/app");
    expect(result.app.buildCmd).toBe("npm run build");
    expect(result.app.healthUrl).toBe("http://localhost:3000/api/version");
    expect(result.app.serviceUnit).toBe("field-record");
  });

  test("optional app fields are present and correct", () => {
    const result = parseSamohostToml(FIXTURE_TEXT);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.app.migrateCmd).toBe("npm run migrate");
    expect(result.app.seedCmd).toBe("npm run db:seed");
    expect(result.app.envFile).toBe("/opt/field-record/staging.env");
    expect(result.app.mainHost).toBe("field-record-1.samo.team");
    expect(result.app.rlsUrlVar).toBe("APP_DATABASE_URL");
    expect(result.app.envDbVars).toEqual(["DATABASE_URL", "APP_DATABASE_URL"]);
    expect(result.app.rlsNonSuperuser).toBe(true);
  });

  test("[provision] table parses to ProvisionManifest", () => {
    const result = parseSamohostToml(FIXTURE_TEXT);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.provision).toBeDefined();
    expect(result.provision?.serverType).toBe("cx22");
    expect(result.provision?.location).toBe("fsn1");
    expect(result.provision?.labels).toEqual({ env: "prod", team: "platform" });
  });

  test("minimal manifest (required fields only, no optionals, no [provision]) parses ok", () => {
    const minimal = [
      'name = "my-app"',
      'repo = "owner/my-app"',
      'branch = "main"',
      'appDir = "/opt/my-app/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/health"',
      'serviceUnit = "my-app"',
    ].join("\n");
    const result = parseSamohostToml(minimal);
    if (!result.ok) throw new Error("errors: " + result.errors.join(", "));
    expect(result.ok).toBe(true);
    expect(result.provision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseSamohostToml — missing required fields (ALL reported)
// ---------------------------------------------------------------------------

describe("parseSamohostToml — missing required fields", () => {
  test("empty string reports ALL 7 required fields", () => {
    const result = parseSamohostToml("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    // Must report all 7 required fields, not just the first
    const joined = result.errors.join("\n");
    expect(joined).toContain("name");
    expect(joined).toContain("repo");
    expect(joined).toContain("branch");
    expect(joined).toContain("appDir");
    expect(joined).toContain("buildCmd");
    expect(joined).toContain("healthUrl");
    expect(joined).toContain("serviceUnit");
    expect(result.errors.length).toBeGreaterThanOrEqual(7);
  });

  test("missing name → error names the field", () => {
    const toml = FIXTURE_TEXT.replace(/^name\s*=.+$/m, "");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("name"))).toBe(true);
  });

  test("missing healthUrl → error names the field", () => {
    const toml = FIXTURE_TEXT.replace(/^healthUrl\s*=.+$/m, "");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("healthUrl"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSamohostToml — wrong field types
// ---------------------------------------------------------------------------

describe("parseSamohostToml — wrong field types", () => {
  test("healthUrl = 123 (number instead of string) → type error", () => {
    const toml = FIXTURE_TEXT.replace(
      /^healthUrl\s*=.+$/m,
      "healthUrl = 123",
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("healthUrl"))).toBe(true);
  });

  test('envDbVars = "DATABASE_URL" (string instead of array) → type error', () => {
    const toml = FIXTURE_TEXT.replace(
      /^envDbVars\s*=.+$/m,
      'envDbVars = "DATABASE_URL"',
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("envDbVars"))).toBe(true);
  });

  test('rlsNonSuperuser = "yes" (string instead of bool) → type error', () => {
    const toml = FIXTURE_TEXT.replace(
      /^rlsNonSuperuser\s*=.+$/m,
      'rlsNonSuperuser = "yes"',
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("rlsNonSuperuser"))).toBe(true);
  });

  test("envDbVars array element not a string → type error", () => {
    const toml = FIXTURE_TEXT.replace(
      /^envDbVars\s*=.+$/m,
      "envDbVars = [1, 2]",
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("envDbVars"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSamohostToml — unknown key rejection (typo protection)
// ---------------------------------------------------------------------------

describe("parseSamohostToml — unknown key rejection", () => {
  test("unknown top-level key → error naming the key", () => {
    // Insert the typo before the [provision] section so it is a top-level key
    const toml = FIXTURE_TEXT.replace(
      "[provision]",
      'helathUrl = "http://typo"\n\n[provision]',
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("helathUrl"))).toBe(true);
  });

  test("unknown [provision] key → error naming the key", () => {
    // Append an unknown key inside the [provision] section
    const toml = FIXTURE_TEXT.replace(
      "[provision.labels]",
      'unknownKey = "value"\n\n[provision.labels]',
    );
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("unknownKey"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSamohostToml — malformed TOML
// ---------------------------------------------------------------------------

describe("parseSamohostToml — malformed TOML", () => {
  test("syntax error → {ok:false} with error message, never throws", () => {
    const badToml = 'name = "unclosed\nrepo = "owner/app"';
    const result = parseSamohostToml(badToml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("completely invalid content → {ok:false}, never throws", () => {
    const trash = "=====garbage not toml=====\n[[[[";
    const result = parseSamohostToml(trash);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSamohostToml — [provision].labels type validation
// ---------------------------------------------------------------------------

describe("parseSamohostToml — [provision].labels", () => {
  test("string→string labels table parses correctly", () => {
    const result = parseSamohostToml(FIXTURE_TEXT);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.provision?.labels).toEqual({ env: "prod", team: "platform" });
  });

  test("non-string label value → error naming the key", () => {
    const toml = [
      'name = "my-app"',
      'repo = "owner/my-app"',
      'branch = "main"',
      'appDir = "/opt/my-app/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/health"',
      'serviceUnit = "my-app"',
      "[provision]",
      "[provision.labels]",
      "env = 123",
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((err) => err.includes("env") || err.includes("label"))).toBe(true);
  });

  test("[provision] without labels parses ok (labels is optional)", () => {
    const toml = [
      'name = "my-app"',
      'repo = "owner/my-app"',
      'branch = "main"',
      'appDir = "/opt/my-app/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/health"',
      'serviceUnit = "my-app"',
      "[provision]",
      'serverType = "cx22"',
      'location = "fsn1"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("errors: " + result.errors.join(", "));
    expect(result.provision?.labels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: runAppRegisterFromToml — temp store
// ---------------------------------------------------------------------------

describe("runAppRegisterFromToml — integration with temp store", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-toml-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("--from-toml fixture registers the app with manifest values", () => {
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath: FIXTURE_PATH },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec).toBeDefined();
    expect(rec?.name).toBe("field-record");
    expect(rec?.repo).toBe("Tanya301/field-record-1");
    expect(rec?.branch).toBe("main");
    expect(rec?.appDir).toBe("/opt/field-record/app");
    expect(rec?.buildCmd).toBe("npm run build");
    expect(rec?.healthUrl).toBe("http://localhost:3000/api/version");
    expect(rec?.serviceUnit).toBe("field-record");
    expect(rec?.migrateCmd).toBe("npm run migrate");
    expect(rec?.seedCmd).toBe("npm run db:seed");
    expect(rec?.envFile).toBe("/opt/field-record/staging.env");
    expect(rec?.mainHost).toBe("field-record-1.samo.team");
    expect(rec?.rlsUrlVar).toBe("APP_DATABASE_URL");
    expect(rec?.envDbVars).toEqual(["DATABASE_URL", "APP_DATABASE_URL"]);
    expect(rec?.assertions?.rlsNonSuperuser).toBe(true);
  });

  test("malformed TOML exits 1 and persists nothing", () => {
    const badPath = join(dir, "bad.toml");
    writeFileSync(badPath, 'name = "unclosed\nrepo = "owner/app"');
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath: badPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(0);
  });

  test("invalid manifest (missing required field) exits 1 and persists nothing", () => {
    const badPath = join(dir, "invalid.toml");
    writeFileSync(badPath, 'name = "only-name-no-other-fields"\n');
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath: badPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("error");
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(0);
  });

  test("unknown VM exits 1 with error message", () => {
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "nonexistent-vm", tomlPath: FIXTURE_PATH },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: --from-toml AppSpec == flags AppSpec
// ---------------------------------------------------------------------------

describe("round-trip: --from-toml produces same AppSpec as equivalent flags", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStoreToml: AppStore;
  let appStoreFlags: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-roundtrip-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStoreToml = new AppStore(join(dir, "apps-toml.json"));
    appStoreFlags = new AppStore(join(dir, "apps-flags.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("AppSpec from --from-toml equals AppSpec from equivalent flags (field-by-field)", () => {
    // Register via --from-toml
    const c1 = capture();
    const code1 = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath: FIXTURE_PATH },
      { json: false },
      vmStore,
      appStoreToml,
      c1.out,
      c1.err,
    );
    expect(code1).toBe(0);

    // Register via equivalent flags (the same values as in the fixture)
    const c2 = capture();
    const code2 = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "field-record",
        repo: "Tanya301/field-record-1",
        branch: "main",
        appDir: "/opt/field-record/app",
        buildCmd: "npm run build",
        serviceUnit: "field-record",
        healthUrl: "http://localhost:3000/api/version",
        migrateCmd: "npm run migrate",
        seedCmd: "npm run db:seed",
        envFile: "/opt/field-record/staging.env",
        mainHost: "field-record-1.samo.team",
        rlsUrlVar: "APP_DATABASE_URL",
        envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"],
        rlsNonSuperuser: true,
      },
      { json: false },
      vmStore,
      appStoreFlags,
      c2.out,
      c2.err,
    );
    expect(code2).toBe(0);

    const recToml = appStoreToml.get("vm-1111", "field-record");
    const recFlags = appStoreFlags.get("vm-1111", "field-record");
    expect(recToml).toBeDefined();
    expect(recFlags).toBeDefined();

    // Compare AppSpec fields (id and vmId differ by design; focus on spec fields)
    const specFields = [
      "name", "repo", "branch", "appDir", "buildCmd", "healthUrl",
      "serviceUnit", "migrateCmd", "seedCmd", "envFile", "mainHost",
      "rlsUrlVar", "envDbVars", "assertions",
    ] as const;
    for (const field of specFields) {
      expect(recToml?.[field]).toEqual(recFlags?.[field]);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #36 — kind field in .samohost.toml
// ---------------------------------------------------------------------------

describe("parseSamohostToml — kind field", () => {
  function minimal(extra = ""): string {
    return [
      'name = "my-app"',
      'repo = "owner/my-app"',
      'branch = "main"',
      'appDir = "/opt/my-app/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/health"',
      'serviceUnit = "my-app"',
      extra,
    ]
      .filter(Boolean)
      .join("\n");
  }

  test('kind = "static" parses ok and is present in the app manifest', () => {
    const result = parseSamohostToml(minimal('kind = "static"'));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.kind).toBe("static");
  });

  test('kind = "node" parses ok and is present in the app manifest', () => {
    const result = parseSamohostToml(minimal('kind = "node"'));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.kind).toBe("node");
  });

  test("absent kind parses ok and kind is undefined", () => {
    const result = parseSamohostToml(minimal());
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.kind).toBeUndefined();
  });

  test('kind = "bogus" is rejected with a clear error', () => {
    const result = parseSamohostToml(minimal('kind = "bogus"'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("kind"))).toBe(true);
    expect(result.errors.some((e) => e.includes('"node"') || e.includes('"static"'))).toBe(true);
  });

  test('kind = 123 (wrong type) is rejected', () => {
    const result = parseSamohostToml(minimal("kind = 123"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("kind"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #88 (incomplete) — dbBackend/previewDbBackend dropped by --from-toml
//
// Root cause: runAppRegisterFromToml builds AppRegisterInput from AppManifest
// but omits dbBackend and previewDbBackend. AppRegisterInput has no such fields
// and runAppRegister's AppSpec construction does not include them. The result is
// an AppRecord with no dbBackend, so previewDbBackendFor() returns 'dblab' for
// a no-DB app, forcing a DBLab clone path that fails on hosts with no DBLab.
//
// RED: these tests FAIL on current code (the thread is missing).
// GREEN: after adding dbBackend+previewDbBackend to AppRegisterInput and
//         threading them through runAppRegisterFromToml → runAppRegister.
// ---------------------------------------------------------------------------

describe("runAppRegisterFromToml — dbBackend/previewDbBackend threading (#88)", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-db-backend-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert({
      id: "vm-1111",
      provider: "hetzner",
      providerId: "137236481",
      name: "samo-we-field-record",
      ip: "178.105.246.151",
      sshKeyPath: "/home/fixture/.ssh/id_ed25519",
      sshPort: 2223,
      sshUser: "agent",
      hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      region: "fsn1",
      type: "cx33",
      modules: [],
      lifecycleState: "adopted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  function writeToml(extra: string): string {
    const path = join(dir, "test.toml");
    writeFileSync(path, [
      'name        = "samohost-fixture"',
      'repo        = "samo-agent/samohost-fixture"',
      'branch      = "main"',
      'appDir      = "/opt/samohost-fixture/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/api/version"',
      'serviceUnit = "samohost-fixture"',
      extra,
    ].filter(Boolean).join("\n"));
    return path;
  }

  test("reg-db-1: manifest with dbBackend='none' yields AppRecord.dbBackend='none'", () => {
    // BUG: runAppRegisterFromToml drops dbBackend — the AppRecord gets no
    // dbBackend, so previewDbBackendFor() returns 'dblab' instead of 'none'.
    // This is the root cause of the 521 / never-serves issue on no-DB hosts.
    const tomlPath = writeToml('dbBackend = "none"');
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "samohost-fixture");
    expect(rec).toBeDefined();
    // Fails today: rec.dbBackend is undefined (dropped during AppRegisterInput build)
    expect(rec?.dbBackend).toBe("none");
  });

  test("reg-db-2: AppRecord from dbBackend='none' toml: previewDbBackendFor returns 'none'", () => {
    // End-to-end: register from toml, then confirm the preview backend is 'none'.
    // Fails today: previewDbBackendFor falls through to 'dblab' because
    // dbBackend was dropped and both rec.previewDbBackend and rec.dbBackend are undefined.
    const tomlPath = writeToml('dbBackend = "none"');
    const c = capture();
    runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    const rec = appStore.get("vm-1111", "samohost-fixture");
    expect(rec).toBeDefined();
    expect(previewDbBackendFor(rec!)).toBe("none");
  });

  test("reg-db-3: manifest with previewDbBackend='template' yields AppRecord.previewDbBackend='template'", () => {
    // Also dropped: previewDbBackend is not threaded from AppManifest to AppRegisterInput.
    // Updated (PR secrets+databaseUrlEnv): previewDbBackend='template' is explicitly
    // DB-backed → databaseUrlEnv is now required; add it to satisfy the new rule.
    const tomlPath = writeToml(
      'previewDbBackend = "template"\ndatabaseUrlEnv = "DATABASE_URL"',
    );
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "samohost-fixture");
    expect(rec).toBeDefined();
    expect(rec?.previewDbBackend).toBe("template");
    expect(rec?.databaseUrlEnv).toBe("DATABASE_URL");
  });

  test("reg-db-4: manifest with both dbBackend='none' and previewDbBackend='dblab' → both persisted", () => {
    // Explicit previewDbBackend must override the dbBackend='none' fallback.
    // Updated (PR secrets+databaseUrlEnv): previewDbBackend='dblab' is explicitly
    // DB-backed → databaseUrlEnv is now required; add it to satisfy the new rule.
    const tomlPath = writeToml(
      'dbBackend = "none"\npreviewDbBackend = "dblab"\ndatabaseUrlEnv = "DATABASE_URL"',
    );
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "samohost-fixture");
    expect(rec?.dbBackend).toBe("none");
    expect(rec?.previewDbBackend).toBe("dblab");
    expect(rec?.databaseUrlEnv).toBe("DATABASE_URL");
    // previewDbBackend explicit value wins
    expect(previewDbBackendFor(rec!)).toBe("dblab");
  });

  test("reg-db-5: manifest with no dbBackend/previewDbBackend → both remain undefined (no regression)", () => {
    // Regression guard: existing apps without these fields must not be affected.
    const tomlPath = writeToml("");
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "samohost-fixture");
    expect(rec?.dbBackend).toBeUndefined();
    expect(rec?.previewDbBackend).toBeUndefined();
    // Default: 'dblab' for apps without explicit backend (no regression)
    expect(previewDbBackendFor(rec!)).toBe("dblab");
  });
});

// ---------------------------------------------------------------------------
// Multi-service spec model — manifest-toml validation (PR: multi-service spec)
//
// RED: all assertions written; the parser does not yet accept [[services]],
//      [[routes]], defaultListener, or mainListen.
// ---------------------------------------------------------------------------

/** Minimal valid TOML with required legacy fields only. */
function minimalBase(): string {
  return [
    'name        = "my-app"',
    'repo        = "owner/my-app"',
    'branch      = "main"',
    'appDir      = "/opt/my-app/app"',
    'buildCmd    = "npm run build"',
    'healthUrl   = "http://localhost:3000/health"',
    'serviceUnit = "my-app"',
  ].join("\n");
}

/** Minimal TOML with a valid two-service block. */
function twoServiceBase(): string {
  return [
    minimalBase(),
    'defaultListener = "web"',
    "[[services]]",
    'name = "web"',
    'unit = "my-app"',
    "  [[services.listeners]]",
    '  name    = "web"',
    "  port    = 3000",
    '  portEnv = "PORT"',
    '  routed  = true',
    "[[services]]",
    'name = "worker"',
    'unit = "my-app-worker"',
    "  [[services.listeners]]",
    '  name    = "worker-metrics"',
    "  port    = 9100",
    '  portEnv = "METRICS_PORT"',
  ].join("\n");
}

describe("parseSamohostToml — multi-service [[services]] valid parse", () => {
  test("two-service manifest with defaultListener parses ok", () => {
    const result = parseSamohostToml(twoServiceBase());
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services).toHaveLength(2);
    expect(result.app.defaultListener).toBe("web");
    const web = result.app.services![0]!;
    expect(web.name).toBe("web");
    expect(web.unit).toBe("my-app");
    expect(web.listeners[0]!.name).toBe("web");
    expect(web.listeners[0]!.port).toBe(3000);
    expect(web.listeners[0]!.portEnv).toBe("PORT");
    expect(web.listeners[0]!.routed).toBe(true);
  });

  test("mainListen = 'tls' is accepted", () => {
    // mainListen must come before [[services]] to avoid TOML context association
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      'mainListen = "tls"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name    = "web"',
      "  port    = 3000",
      '  portEnv = "PORT"',
      '  routed  = true',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.mainListen).toBe("tls");
  });

  test("mainListen = 'cp-http80' is accepted", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      'mainListen = "cp-http80"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name    = "web"',
      "  port    = 3000",
      '  portEnv = "PORT"',
      '  routed  = true',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.mainListen).toBe("cp-http80");
  });

  test("[[routes]] with matchPath + to resolves to routed listener", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'name       = "api"',
      'matchPath  = "/api/*"',
      'to         = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes).toHaveLength(1);
    expect(result.app.routes![0]!.matchPath).toBe("/api/*");
    expect(result.app.routes![0]!.to).toBe("web");
  });

  test("[[routes]] respond target is accepted", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchPath = "/healthz"',
      "[routes.respond]",
      "status = 200",
      'body   = "ok"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes).toHaveLength(1);
    expect(result.app.routes![0]!.respond?.status).toBe(200);
    expect(result.app.routes![0]!.respond?.body).toBe("ok");
  });

  test("[[routes]] matchRegexp with valid Caddy-safe pattern", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'name          = "rpc"',
      'matchRegexp   = "^/api/v[0-9]+"',
      'to            = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.matchRegexp).toBe("^/api/v[0-9]+");
  });

  test("absent [[services]] parses ok — legacy shape, services undefined", () => {
    const result = parseSamohostToml(minimalBase());
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services).toBeUndefined();
    expect(result.app.routes).toBeUndefined();
    expect(result.app.defaultListener).toBeUndefined();
  });
});

describe("parseSamohostToml — multi-service validation: duplicate names", () => {
  test("ms-dup-1: duplicate service names → error naming both", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
      "[[services]]",
      'name = "web"',   // duplicate
      'unit = "my-app-worker"',
      "  [[services.listeners]]",
      '  name = "metrics"',
      "  port = 9100",
      '  portEnv = "METRICS_PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("web"))).toBe(true);
  });

  test("ms-dup-2: duplicate listener names (global across services) → error", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "shared"',    // same name in two services
      "  port = 3000",
      '  portEnv = "PORT"',
      "[[services]]",
      'name = "worker"',
      'unit = "my-app-worker"',
      "  [[services.listeners]]",
      '  name = "shared"',   // duplicate listener name
      "  port = 9100",
      '  portEnv = "METRICS_PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("shared"))).toBe(true);
  });

  test("ms-dup-3: duplicate listener ports → error naming the port", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
      "[[services]]",
      'name = "worker"',
      'unit = "my-app-worker"',
      "  [[services.listeners]]",
      '  name = "metrics"',
      "  port = 3000",     // duplicate port
      '  portEnv = "METRICS_PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("3000"))).toBe(true);
  });

  test("ms-dup-4: duplicate portEnv values → error naming the variable", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
      "[[services]]",
      'name = "worker"',
      'unit = "my-app-worker"',
      "  [[services.listeners]]",
      '  name = "metrics"',
      "  port = 9100",
      '  portEnv = "PORT"',  // duplicate portEnv
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("PORT"))).toBe(true);
  });
});

describe("parseSamohostToml — multi-service validation: routes", () => {
  test("ms-route-1: route.to referencing nonexistent listener → error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchPath = "/api/*"',
      'to        = "nonexistent"',  // listener "nonexistent" does not exist
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("ms-route-2: route.to targeting listener with routed=false → error", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name    = "web"',
      "  port    = 3000",
      '  portEnv = "PORT"',
      '  routed  = false',   // not routable
      "[[routes]]",
      'matchPath = "/api/*"',
      'to        = "web"',   // references a non-routed listener
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("web") && (e.toLowerCase().includes("routed") || e.toLowerCase().includes("route")))).toBe(true);
  });

  test("ms-route-3: route with both matchPath and matchRegexp → exactly-one error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchPath   = "/api/*"',
      'matchRegexp = "^/api"',   // both present
      'to          = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("matchpath") || e.toLowerCase().includes("matchregexp"))).toBe(true);
  });

  test("ms-route-4: route with neither matchPath nor matchRegexp → exactly-one error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'to = "web"',   // no matcher at all
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("matchpath") || e.toLowerCase().includes("matchregexp"))).toBe(true);
  });

  test("ms-route-5: route with both to and respond → exactly-one error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchPath = "/api/*"',
      'to        = "web"',
      "[routes.respond]",
      "status = 200",
      'body   = "ok"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("to") || e.toLowerCase().includes("respond"))).toBe(true);
  });

  test("ms-route-6: route with neither to nor respond → exactly-one error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchPath = "/api/*"',
      // no to, no respond
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("to") || e.toLowerCase().includes("respond"))).toBe(true);
  });

  test("ms-route-7: regexp that does not compile → error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'matchRegexp = "[invalid("',   // unclosed bracket → compile error
      'to          = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("regexp") || e.toLowerCase().includes("regex"))).toBe(true);
  });

  test("ms-route-8: regexp with unsafe charset (double quote) → error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      // double-quote inside the regexp is unsafe to embed in Caddy config
      "matchRegexp = '^/api/\"evil'",
      'to          = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("regexp") || e.toLowerCase().includes("charset"))).toBe(true);
  });
});

describe("parseSamohostToml — multi-service validation: defaultListener", () => {
  test("ms-dl-1: [[services]] present but defaultListener absent → error", () => {
    const toml = [
      minimalBase(),
      // no defaultListener
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("defaultlistener"))).toBe(true);
  });

  test("ms-dl-2: defaultListener pointing to nonexistent listener → error", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "does-not-exist"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("does-not-exist"))).toBe(true);
  });
});

describe("parseSamohostToml — multi-service validation: matcher name charset", () => {
  test("ms-name-1: route name with invalid chars (uppercase) → error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'name      = "Api-Route"',   // uppercase A not in [a-z][a-z0-9-]*
      'matchPath = "/api/*"',
      'to        = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("name"))).toBe(true);
  });

  test("ms-name-2: route name matching [a-z][a-z0-9-]* is accepted", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'name      = "api-v2"',
      'matchPath = "/api/*"',
      'to        = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.name).toBe("api-v2");
  });

  test("ms-name-3: route name starting with digit → error", () => {
    const toml = [
      twoServiceBase(),
      "[[routes]]",
      'name      = "1bad"',   // starts with digit
      'matchPath = "/api/*"',
      'to        = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("name"))).toBe(true);
  });
});

describe("parseSamohostToml — multi-service validation: unknown sub-table keys", () => {
  test("ms-key-1: unknown key inside [[services]] rejected", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name       = "web"',
      'unit       = "my-app"',
      'typoField  = "oops"',   // unknown key
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("typoField"))).toBe(true);
  });

  test("ms-key-2: unknown key inside [[services.listeners]] rejected", () => {
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name        = "web"',
      "  port        = 3000",
      '  portEnv     = "PORT"',
      '  unknownFlag = true',  // unknown key
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("unknownFlag"))).toBe(true);
  });
});

describe("parseSamohostToml — multi-service: mainListen validation", () => {
  test("ms-ml-1: mainListen with invalid value rejected (value at ROOT level)", () => {
    // Fix: mainListen must appear at the root table, BEFORE any [[services]] headers.
    // Appending after [[services.listeners]] binds the key to the listener sub-table
    // (TOML context), triggering an unknown-key error instead of the enum guard.
    const toml = [
      minimalBase(),
      'defaultListener = "web"',
      'mainListen = "bogus"',        // at root — exercises the enum guard
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name    = "web"',
      "  port    = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("mainlisten"))).toBe(true);
  });
});

// ===========================================================================
// samorev injection + validation gap fixes (PR #135 blocking)
// RED: all assertions below fail on the current #135 head.
// GREEN: pass after the implementation fixes in toml.ts / services.ts / app.ts.
// ===========================================================================

// ---------------------------------------------------------------------------
// Fix 1 + Fix 7: brace/dollar injection guard + printable-ASCII charset in matchRegexp
// ---------------------------------------------------------------------------

describe("injection guard: matchRegexp — brace/dollar + charset (Fix 1, Fix 7)", () => {
  /** Build a two-service TOML with one [[routes]] entry using the supplied regexp. */
  function routeWithRegexp(regexp: string): string {
    return [
      twoServiceBase(),
      "[[routes]]",
      `matchRegexp = ${JSON.stringify(regexp)}`,
      'to          = "web"',
    ].join("\n");
  }

  // --- RED: brace-dollar sequences ------------------------------------
  test("inj-re-1: {$ sequence rejected (Caddy env-substitution guard)", () => {
    const result = parseSamohostToml(routeWithRegexp("{$SECRET}"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("brace")
    )).toBe(true);
  });

  test("inj-re-2: bare { not forming a quantifier rejected", () => {
    const result = parseSamohostToml(routeWithRegexp("{notAQuantifier}"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("brace") || e.toLowerCase().includes("unsafe")
    )).toBe(true);
  });

  test("inj-re-3: bare } without matching { rejected", () => {
    const result = parseSamohostToml(routeWithRegexp("^/api}badclose"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("brace") || e.toLowerCase().includes("unsafe")
    )).toBe(true);
  });

  // --- RED: printable-ASCII guard (Fix 7) ----------------------------
  test("inj-re-4: non-ASCII character (U+00E9 é) rejected (printable-ASCII guard)", () => {
    // Current CADDY_SAFE_REGEXP admits U+00E9 — it's not in ["\\\`\x00-\x1f\x7f].
    // After Fix 7 (^[\x20-\x7e]+$), U+00E9 > 0x7e is rejected.
    const result = parseSamohostToml(routeWithRegexp("café"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("charset") || e.toLowerCase().includes("ascii")
    )).toBe(true);
  });

  // --- GREEN (regression guards already working pre-fix) --------------
  test("inj-re-5: backslash in matchRegexp rejected (already banned pre-fix)", () => {
    const result = parseSamohostToml(routeWithRegexp("^/api\\test"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("charset")
    )).toBe(true);
  });

  test("inj-re-6: backtick in matchRegexp rejected (already banned pre-fix)", () => {
    const result = parseSamohostToml(routeWithRegexp("^/api`cmd`exec"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("charset")
    )).toBe(true);
  });

  test("inj-re-7: newline in matchRegexp rejected (already banned pre-fix)", () => {
    // Newline is \x0a — in the \x00-\x1f control range, already banned.
    const result = parseSamohostToml(routeWithRegexp("^/api\ninjected"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("regexp") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("charset")
    )).toBe(true);
  });

  // --- GREEN (valid quantifiers must remain accepted post-fix) --------
  test("inj-re-8: valid quantifier {1,3} accepted (regex quantifier allowance)", () => {
    const result = parseSamohostToml(routeWithRegexp("^/api/v[0-9]{1,3}"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.matchRegexp).toBe("^/api/v[0-9]{1,3}");
  });

  test("inj-re-9: valid quantifier {2,} accepted (open-ended quantifier)", () => {
    const result = parseSamohostToml(routeWithRegexp("^/path/[a-z]{2,}"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.matchRegexp).toBe("^/path/[a-z]{2,}");
  });

  test("inj-re-10: valid quantifier {5} accepted (exact-count quantifier)", () => {
    const result = parseSamohostToml(routeWithRegexp("[0-9]{5}"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.matchRegexp).toBe("[0-9]{5}");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: injection guard on matchPath and respond.body
// ---------------------------------------------------------------------------

describe("injection guard: matchPath (Fix 2)", () => {
  function routeWithPath(path: string): string {
    return [
      twoServiceBase(),
      "[[routes]]",
      `matchPath = ${JSON.stringify(path)}`,
      'to        = "web"',
    ].join("\n");
  }

  test("inj-path-1: {$ injection in matchPath rejected", () => {
    // matchPath currently has NO charset guard — any string passes.
    const result = parseSamohostToml(routeWithPath("{$SECRET}/api"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("matchpath") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("brace")
    )).toBe(true);
  });

  test("inj-path-2: bare non-quantifier brace in matchPath rejected", () => {
    const result = parseSamohostToml(routeWithPath("{injection}/api"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("matchpath") || e.toLowerCase().includes("brace") || e.toLowerCase().includes("unsafe")
    )).toBe(true);
  });

  test("inj-path-3: double-quote in matchPath rejected", () => {
    const result = parseSamohostToml(routeWithPath('/api/"evil'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("matchpath") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("charset")
    )).toBe(true);
  });

  test("inj-path-4: normal path /api/* is still accepted", () => {
    const result = parseSamohostToml(routeWithPath("/api/*"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.matchPath).toBe("/api/*");
  });
});

describe("injection guard: respond.body (Fix 2)", () => {
  function routeWithBody(body: string): string {
    return [
      twoServiceBase(),
      "[[routes]]",
      'matchPath = "/healthz"',
      "[routes.respond]",
      "status = 200",
      `body   = ${JSON.stringify(body)}`,
    ].join("\n");
  }

  test("inj-body-1: {$ injection in respond.body rejected", () => {
    // respond.body currently has NO charset guard.
    const result = parseSamohostToml(routeWithBody("{$SECRET}"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("body") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("brace")
    )).toBe(true);
  });

  test("inj-body-2: double-quote in respond.body rejected", () => {
    const result = parseSamohostToml(routeWithBody('ok"evil'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("body") || e.toLowerCase().includes("unsafe") || e.toLowerCase().includes("charset")
    )).toBe(true);
  });

  test("inj-body-3: normal respond.body 'ok' is still accepted", () => {
    const result = parseSamohostToml(routeWithBody("ok"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.routes![0]!.respond?.body).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Fix 3a: portEnv charset ^[A-Z_][A-Z0-9_]*$
// ---------------------------------------------------------------------------

describe("portEnv charset validation (Fix 3)", () => {
  function listenerWithPortEnv(portEnv: string): string {
    return [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      `  portEnv = ${JSON.stringify(portEnv)}`,
    ].join("\n");
  }

  test("portenv-1: portEnv with hyphen rejected (must be [A-Z_][A-Z0-9_]*)", () => {
    const result = parseSamohostToml(listenerWithPortEnv("bad-port-env"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("portenv") || e.toLowerCase().includes("env")
    )).toBe(true);
  });

  test("portenv-2: portEnv with lowercase rejected", () => {
    const result = parseSamohostToml(listenerWithPortEnv("port"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("portenv") || e.toLowerCase().includes("env")
    )).toBe(true);
  });

  test("portenv-3: portEnv starting with digit rejected", () => {
    const result = parseSamohostToml(listenerWithPortEnv("1PORT"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("portenv") || e.toLowerCase().includes("env")
    )).toBe(true);
  });

  test("portenv-4: portEnv = PORT accepted", () => {
    const result = parseSamohostToml(listenerWithPortEnv("PORT"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.portEnv).toBe("PORT");
  });

  test("portenv-5: portEnv = _PORT accepted (underscore prefix)", () => {
    const result = parseSamohostToml(listenerWithPortEnv("_PORT"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.portEnv).toBe("_PORT");
  });

  test("portenv-6: portEnv = APP_PORT_8080 accepted (complex valid name)", () => {
    const result = parseSamohostToml(listenerWithPortEnv("APP_PORT_8080"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.portEnv).toBe("APP_PORT_8080");
  });
});

// ---------------------------------------------------------------------------
// Fix 3b: service name + listener name charset ^[a-z][a-z0-9-]*$
// ---------------------------------------------------------------------------

describe("service/listener name charset validation (Fix 3)", () => {
  function serviceWithName(svcName: string): string {
    return [
      minimalBase(),
      `defaultListener = "web"`,
      "[[services]]",
      `name = ${JSON.stringify(svcName)}`,
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      "  port = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
  }

  function listenerWithName(lsName: string): string {
    return [
      minimalBase(),
      `defaultListener = ${JSON.stringify(lsName)}`,
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      `  name = ${JSON.stringify(lsName)}`,
      "  port = 3000",
      '  portEnv = "PORT"',
    ].join("\n");
  }

  test("svcname-1: service name with uppercase rejected", () => {
    const result = parseSamohostToml(serviceWithName("Web-Service"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("service") && e.toLowerCase().includes("name")
    )).toBe(true);
  });

  test("svcname-2: service name starting with digit rejected", () => {
    const result = parseSamohostToml(serviceWithName("1web"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("service") && e.toLowerCase().includes("name")
    )).toBe(true);
  });

  test("svcname-3: service name with underscore rejected", () => {
    const result = parseSamohostToml(serviceWithName("web_worker"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("service") && e.toLowerCase().includes("name")
    )).toBe(true);
  });

  test("lsname-1: listener name with underscore rejected", () => {
    const result = parseSamohostToml(listenerWithName("web_listener"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("listener") && e.toLowerCase().includes("name")
    )).toBe(true);
  });

  test("lsname-2: listener name with uppercase rejected", () => {
    const result = parseSamohostToml(listenerWithName("Web"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("listener") && e.toLowerCase().includes("name")
    )).toBe(true);
  });

  test("lsname-3: listener name = web-front accepted (hyphen ok)", () => {
    const result = parseSamohostToml(listenerWithName("web-front"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.name).toBe("web-front");
  });
});

// ---------------------------------------------------------------------------
// Fix 4: port must be an integer in 1..65535
// ---------------------------------------------------------------------------

describe("port integer range validation (Fix 4)", () => {
  function listenerWithPort(portLiteral: string): string {
    return [
      minimalBase(),
      'defaultListener = "web"',
      "[[services]]",
      'name = "web"',
      'unit = "my-app"',
      "  [[services.listeners]]",
      '  name = "web"',
      `  port = ${portLiteral}`,
      '  portEnv = "PORT"',
    ].join("\n");
  }

  test("port-1: port = 0 rejected (below 1)", () => {
    const result = parseSamohostToml(listenerWithPort("0"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("port") && (e.includes("1") || e.toLowerCase().includes("range") || e.toLowerCase().includes("integer"))
    )).toBe(true);
  });

  test("port-2: port = -1 rejected (negative)", () => {
    const result = parseSamohostToml(listenerWithPort("-1"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("port") && (e.toLowerCase().includes("range") || e.toLowerCase().includes("integer"))
    )).toBe(true);
  });

  test("port-3: port = 70000 rejected (above 65535)", () => {
    const result = parseSamohostToml(listenerWithPort("70000"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("port") && (e.includes("65535") || e.toLowerCase().includes("range"))
    )).toBe(true);
  });

  test("port-4: port = 3.5 rejected (non-integer float)", () => {
    // TOML: 3.5 is a valid float; typeof 3.5 === "number" passes current check.
    // After fix: Number.isInteger(3.5) === false → rejected.
    const result = parseSamohostToml(listenerWithPort("3.5"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("port") && (e.toLowerCase().includes("integer") || e.toLowerCase().includes("range"))
    )).toBe(true);
  });

  test("port-5: port = 1 accepted (lower bound)", () => {
    const result = parseSamohostToml(listenerWithPort("1"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.port).toBe(1);
  });

  test("port-6: port = 65535 accepted (upper bound)", () => {
    const result = parseSamohostToml(listenerWithPort("65535"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.port).toBe(65535);
  });

  test("port-7: port = 3000 accepted (typical value)", () => {
    const result = parseSamohostToml(listenerWithPort("3000"));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.services![0]!.listeners[0]!.port).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: [[routes]] without [[services]] must be rejected
// ---------------------------------------------------------------------------

describe("routes-without-services rejection (Fix 5)", () => {
  test("rws-1: [[routes]] declared without [[services]] → error", () => {
    // Currently: routes parsing runs independently of services; if services is
    // undefined, route.to cross-reference is skipped — no error emitted.
    // After fix: any [[routes]] without [[services]] must produce an error.
    const toml = [
      minimalBase(),
      "[[routes]]",
      'matchPath = "/api/*"',
      'to        = "web"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      (e.toLowerCase().includes("route") && e.toLowerCase().includes("service")) ||
      e.toLowerCase().includes("routes") ||
      e.toLowerCase().includes("topology")
    )).toBe(true);
  });

  test("rws-2: [[routes]] with respond (no to) without [[services]] → also rejected", () => {
    const toml = [
      minimalBase(),
      "[[routes]]",
      'matchPath = "/healthz"',
      "[routes.respond]",
      "status = 200",
      'body   = "ok"',
    ].join("\n");
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("route") || e.toLowerCase().includes("service")
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 6a: runAppRegister validates programmatic services/defaultListener
// ---------------------------------------------------------------------------

describe("runAppRegister — programmatic service topology validation (Fix 6)", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-svc-val-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function base() {
    return {
      vm: "samo-we-field-record",
      name: "svc-test-app",
      repo: "owner/svc-test",
      branch: "main",
      appDir: "/opt/svc-test/app",
      buildCmd: "npm run build",
      serviceUnit: "svc-test-app",
      healthUrl: "http://localhost:3000/health",
      rlsNonSuperuser: false as const,
    };
  }

  const validService = {
    name: "web",
    unit: "svc-test-app",
    listeners: [{ name: "web", port: 3000, portEnv: "PORT" }],
  };

  test("reg-svc-1: services set + no defaultListener → exits 1 (validation gap)", () => {
    // Currently runAppRegister has NO validation for services/defaultListener.
    // A dangling defaultListener gets persisted to disk and breaks servicesOf later.
    const c = capture();
    const code = runAppRegister({
      ...base(),
      services: [validService],
      // defaultListener deliberately absent
    }, { json: false }, vmStore, appStore, c.out, c.err);
    expect(code).toBe(1);
    // Nothing should be persisted when validation fails
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(0);
  });

  test("reg-svc-2: services set + defaultListener references nonexistent listener → exits 1", () => {
    const c = capture();
    const code = runAppRegister({
      ...base(),
      services: [validService],
      defaultListener: "does-not-exist",
    }, { json: false }, vmStore, appStore, c.out, c.err);
    expect(code).toBe(1);
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(0);
  });

  test("reg-svc-3: routes set without services → exits 1", () => {
    const c = capture();
    const code = runAppRegister({
      ...base(),
      routes: [{ matchPath: "/api/*", to: "web" }],
      // services deliberately absent
    }, { json: false }, vmStore, appStore, c.out, c.err);
    expect(code).toBe(1);
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(0);
  });

  test("reg-svc-4: valid services + matching defaultListener → exits 0 and persists", () => {
    // GREEN even before fix: confirms no regression when input is valid.
    // (This tests that we don't break the valid path.)
    const c = capture();
    const code = runAppRegister({
      ...base(),
      services: [validService],
      defaultListener: "web",
    }, { json: false }, vmStore, appStore, c.out, c.err);
    // After fix, this must still pass.
    expect(code).toBe(0);
    expect(appStore.list().filter((r) => r.vmId === "vm-1111")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// releaseTagPattern — parse-only, inert field (no deploy-gate behavior)
//
// RED: these tests fail until APP_KEYS includes "releaseTagPattern",
//      AppManifest/AppSpec/AppRecord carry the field, and runAppRegisterFromToml
//      threads it through.
// GREEN: after the implementation in toml.ts / types.ts / commands/app.ts.
//
// Scope: accept + persist only. The tag-gated deploy feature is a separate,
// not-yet-shipped design; prod deploys on main SHA + CI-green regardless.
// ---------------------------------------------------------------------------

describe("parseSamohostToml — releaseTagPattern (parse-only, inert)", () => {
  function minimal(extra = ""): string {
    return [
      'name        = "my-app"',
      'repo        = "owner/my-app"',
      'branch      = "main"',
      'appDir      = "/opt/my-app/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/health"',
      'serviceUnit = "my-app"',
      extra,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // rtp-1: present + valid glob → parses ok, value lands in AppManifest
  test('rtp-1: releaseTagPattern = "v*" parses ok and value is present', () => {
    const result = parseSamohostToml(minimal([
      'releaseTagPattern = "v*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n")));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.releaseTagPattern).toBe("v*");
  });

  // rtp-2: absent → field undefined, legacy manifests byte-identical
  test("rtp-2: absent releaseTagPattern → field is undefined (legacy manifests unchanged)", () => {
    const result = parseSamohostToml(minimal());
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.releaseTagPattern).toBeUndefined();
  });

  // rtp-3: empty string → validation error (non-empty required)
  test('rtp-3: releaseTagPattern = "" (empty string) → validation error', () => {
    const result = parseSamohostToml(minimal('releaseTagPattern = ""'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("releasetagpattern"))).toBe(true);
  });

  // rtp-4: non-string type → validation error
  test("rtp-4: releaseTagPattern = 123 (wrong type) → validation error", () => {
    const result = parseSamohostToml(minimal("releaseTagPattern = 123"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("releasetagpattern"))).toBe(true);
  });

  // rtp-5: various valid glob patterns are accepted
  test('rtp-5: releaseTagPattern = "release-*" (more complex glob) parses ok', () => {
    const result = parseSamohostToml(minimal([
      'releaseTagPattern = "v2026*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n")));
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.releaseTagPattern).toBe("v2026*");
  });
});

describe("runAppRegisterFromToml — releaseTagPattern threaded to AppRecord", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-rtp-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert({
      id: "vm-1111",
      provider: "hetzner",
      providerId: "137236481",
      name: "samo-we-field-record",
      ip: "178.105.246.151",
      sshKeyPath: "/home/fixture/.ssh/id_ed25519",
      sshPort: 2223,
      sshUser: "agent",
      hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      region: "fsn1",
      type: "cx33",
      modules: [],
      lifecycleState: "adopted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeToml(extra: string): string {
    const path = join(dir, "test.toml");
    writeFileSync(path, [
      'name        = "rtp-fixture"',
      'repo        = "samo-agent/rtp-fixture"',
      'branch      = "main"',
      'appDir      = "/opt/rtp-fixture/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/api/version"',
      'serviceUnit = "rtp-fixture"',
      extra,
    ].filter(Boolean).join("\n"));
    return path;
  }

  // rtp-6: releaseTagPattern in toml → lands on AppRecord
  test('rtp-6: releaseTagPattern "v*" in toml → AppRecord.releaseTagPattern = "v*"', () => {
    const tomlPath = writeToml([
      'releaseTagPattern = "v*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n"));
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "rtp-fixture");
    expect(rec).toBeDefined();
    expect(rec?.releaseTagPattern).toBe("v*");
  });

  // rtp-7: absent releaseTagPattern → AppRecord field absent (no regression)
  test("rtp-7: absent releaseTagPattern → AppRecord.releaseTagPattern undefined (no regression)", () => {
    const tomlPath = writeToml("");
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "rtp-fixture");
    expect(rec).toBeDefined();
    expect(rec?.releaseTagPattern).toBeUndefined();
  });
});

// ===========================================================================
// secrets[] + databaseUrlEnv — schema + validation (PR: declare secrets[] +
// databaseUrlEnv). RED: all assertions below fail on current code because the
// fields do not exist yet (unknown-key rejection or no DB-backed check).
// GREEN: after adding both fields to types.ts, toml.ts, commands/app.ts.
//
// DB-backed predicate used by the parser (mirrors previewDbBackendFor() but
// only for EXPLICITLY stored values — absent fields exempt legacy apps):
//   isExplicitlyDbBacked =
//     (previewDbBackend !== undefined && previewDbBackend !== "none")
//     || (previewDbBackend === undefined && dbBackend !== undefined && dbBackend !== "none")
// ===========================================================================

/** Re-usable minimal valid TOML builder for secrets tests. */
function minimalForSecrets(extra = ""): string {
  return [
    'name        = "my-app"',
    'repo        = "owner/my-app"',
    'branch      = "main"',
    'appDir      = "/opt/my-app/app"',
    'buildCmd    = "npm run build"',
    'healthUrl   = "http://localhost:3000/health"',
    'serviceUnit = "my-app"',
    extra,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// sec-parse: secrets + databaseUrlEnv field parsing
// ---------------------------------------------------------------------------

describe("parseSamohostToml — secrets[] + databaseUrlEnv parse", () => {
  // sec-1: valid values → parse ok, values land in AppManifest
  test("sec-1: valid secrets + databaseUrlEnv parse ok and land in AppManifest", () => {
    // RED: currently fails — 'secrets' and 'databaseUrlEnv' are unknown keys.
    const toml = minimalForSecrets([
      'secrets = ["JWT_SECRET", "SESSION_SECRET"]',
      'databaseUrlEnv = "DATABASE_URL"',
      'dbBackend = "dblab"',  // make it explicitly DB-backed so databaseUrlEnv is not flagged missing
    ].join("\n"));
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.secrets).toEqual(["JWT_SECRET", "SESSION_SECRET"]);
    expect(result.app.databaseUrlEnv).toBe("DATABASE_URL");
  });

  // sec-2: bad secret name charset → error naming the bad value
  test("sec-2: secrets entry with hyphen (bad charset) → error naming the bad value", () => {
    // RED: currently the error is "unknown key: secrets"; after fix the error
    // must name the bad value "bad-name", not just reject the key.
    const toml = minimalForSecrets('secrets = ["GOOD_NAME", "bad-name"]');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    // Must mention the bad value — "unknown key: secrets" does NOT satisfy this.
    expect(result.errors.some((e) => e.includes("bad-name"))).toBe(true);
  });

  // sec-3: bad databaseUrlEnv charset → error naming the bad value
  test("sec-3: databaseUrlEnv with hyphen (bad charset) → error naming the bad value", () => {
    // RED: currently "unknown key: databaseUrlEnv"; after fix the error must
    // mention the bad value "bad-db-url".
    const toml = minimalForSecrets('databaseUrlEnv = "bad-db-url"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    // Must mention the bad value — "unknown key: databaseUrlEnv" does NOT satisfy.
    expect(result.errors.some((e) => e.includes("bad-db-url"))).toBe(true);
  });

  // sec-4: duplicate secret names → error mentioning "duplicate"
  test("sec-4: duplicate secret names → collected error", () => {
    // RED: currently "unknown key: secrets"; after fix must say "duplicate".
    const toml = minimalForSecrets('secrets = ["JWT_SECRET", "JWT_SECRET"]');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("JWT_SECRET"))).toBe(true);
  });

  // sec-5: DB-backed (explicit dbBackend=dblab) without databaseUrlEnv → hard error
  test("sec-5: explicit dbBackend=dblab without databaseUrlEnv → hard error", () => {
    // RED: currently ok=true (no such check exists); after fix must fail.
    const toml = minimalForSecrets('dbBackend = "dblab"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("databaseurlenv") && e.toLowerCase().includes("required"),
    )).toBe(true);
  });

  // sec-6: explicit previewDbBackend=dblab without databaseUrlEnv → hard error
  test("sec-6: explicit previewDbBackend=dblab without databaseUrlEnv → hard error", () => {
    // RED: currently ok=true; after fix must fail.
    const toml = minimalForSecrets('previewDbBackend = "dblab"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("databaseurlenv") && e.toLowerCase().includes("required"),
    )).toBe(true);
  });

  // sec-7: explicit previewDbBackend=template without databaseUrlEnv → hard error
  test("sec-7: explicit previewDbBackend=template without databaseUrlEnv → hard error", () => {
    // RED: currently ok=true; after fix must fail.
    const toml = minimalForSecrets('previewDbBackend = "template"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) =>
      e.toLowerCase().includes("databaseurlenv") && e.toLowerCase().includes("required"),
    )).toBe(true);
  });

  // sec-8: explicit dbBackend=none without databaseUrlEnv → ok (non-DB app)
  test("sec-8: explicit dbBackend=none without databaseUrlEnv → ok", () => {
    // Regression guard: this must already pass and must keep passing after the fix.
    const toml = minimalForSecrets('dbBackend = "none"');
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.databaseUrlEnv).toBeUndefined();
  });

  // sec-9: explicit previewDbBackend=none without databaseUrlEnv → ok
  test("sec-9: explicit previewDbBackend=none without databaseUrlEnv → ok", () => {
    // Regression guard: previewDbBackend=none means no DB clone; exempt.
    const toml = minimalForSecrets('previewDbBackend = "none"');
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.databaseUrlEnv).toBeUndefined();
  });

  // sec-10: legacy manifest (neither secrets nor databaseUrlEnv nor dbBackend) → unchanged
  test("sec-10: legacy manifest (no new fields, no explicit dbBackend) → ok, fields absent", () => {
    // CRITICAL regression guard: the default 'dblab' backend is not stored per-app;
    // legacy apps without explicit dbBackend/previewDbBackend must NOT be required to
    // declare databaseUrlEnv. This is the "legacy manifests → unchanged" guarantee.
    const result = parseSamohostToml(minimalForSecrets());
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.secrets).toBeUndefined();
    expect(result.app.databaseUrlEnv).toBeUndefined();
  });

  // sec-11: secrets = [] (empty array) → ok, stored as empty array
  test("sec-11: secrets = [] (empty array) → ok, field is empty array", () => {
    // RED: currently fails — 'secrets' is an unknown key.
    const toml = minimalForSecrets('secrets = []');
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.secrets).toEqual([]);
  });

  // sec-12: secrets with underscore-prefixed name → valid charset
  test("sec-12: secrets entry _SESSION_KEY (underscore prefix) → accepted", () => {
    // RED: currently fails — 'secrets' is an unknown key.
    const toml = minimalForSecrets([
      'secrets = ["_SESSION_KEY"]',
      'databaseUrlEnv = "DATABASE_URL"',
      'dbBackend = "dblab"',
    ].join("\n"));
    const result = parseSamohostToml(toml);
    if (!result.ok) throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    expect(result.app.secrets).toEqual(["_SESSION_KEY"]);
  });

  // sec-13: secrets entry starting with digit → bad charset error
  test("sec-13: secrets entry starting with digit → bad charset error", () => {
    const toml = minimalForSecrets('secrets = ["1BAD_SECRET"]');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("1BAD_SECRET"))).toBe(true);
  });

  // sec-14: databaseUrlEnv with lowercase → bad charset error
  test("sec-14: databaseUrlEnv with lowercase → bad charset error", () => {
    const toml = minimalForSecrets('databaseUrlEnv = "database_url"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.includes("database_url"))).toBe(true);
  });

  // sec-15: databaseUrlEnv wrong type (integer) → type error
  test("sec-15: databaseUrlEnv = 123 (wrong type) → type error", () => {
    const toml = minimalForSecrets('databaseUrlEnv = 123');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("databaseurlenv"))).toBe(true);
  });

  // sec-16: secrets wrong type (not an array) → type error
  test("sec-16: secrets = 'JWT_SECRET' (string, not array) → type error", () => {
    const toml = minimalForSecrets('secrets = "JWT_SECRET"');
    const result = parseSamohostToml(toml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.errors.some((e) => e.toLowerCase().includes("secrets"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sec-int: integration — secrets + databaseUrlEnv thread from TOML to AppRecord
// ---------------------------------------------------------------------------

describe("runAppRegisterFromToml — secrets + databaseUrlEnv threaded to AppRecord", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-secrets-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeSecretsToml(extra: string): string {
    const path = join(dir, "test.toml");
    writeFileSync(path, [
      'name        = "secrets-app"',
      'repo        = "owner/secrets-app"',
      'branch      = "main"',
      'appDir      = "/opt/secrets-app/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/api/version"',
      'serviceUnit = "secrets-app"',
      extra,
    ].filter(Boolean).join("\n"));
    return path;
  }

  // sec-int-1: both fields land on AppRecord
  test("sec-int-1: secrets + databaseUrlEnv land on AppRecord after --from-toml", () => {
    // RED: currently fails — 'secrets'/'databaseUrlEnv' are unknown keys.
    const tomlPath = writeSecretsToml([
      'secrets        = ["JWT_SECRET", "SESSION_SECRET"]',
      'databaseUrlEnv = "DATABASE_URL"',
      'dbBackend      = "dblab"',
    ].join("\n"));
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "secrets-app");
    expect(rec).toBeDefined();
    expect(rec?.secrets).toEqual(["JWT_SECRET", "SESSION_SECRET"]);
    expect(rec?.databaseUrlEnv).toBe("DATABASE_URL");
  });

  // sec-int-2: legacy manifest (no new fields) → ok, fields absent on AppRecord
  test("sec-int-2: legacy manifest (no secrets, no databaseUrlEnv, no dbBackend) → ok, fields absent", () => {
    const tomlPath = writeSecretsToml("");
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "secrets-app");
    expect(rec).toBeDefined();
    // Legacy apps are byte-identical: no new keys should appear.
    expect(rec?.secrets).toBeUndefined();
    expect(rec?.databaseUrlEnv).toBeUndefined();
  });

  // sec-int-3: dbBackend=none → no databaseUrlEnv required; AppRecord.dbBackend=none
  test("sec-int-3: dbBackend=none without databaseUrlEnv → ok, no new key on AppRecord", () => {
    const tomlPath = writeSecretsToml('dbBackend = "none"');
    const c = capture();
    const code = runAppRegisterFromToml(
      { vm: "samo-we-field-record", tomlPath },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "secrets-app");
    expect(rec).toBeDefined();
    expect(rec?.dbBackend).toBe("none");
    expect(rec?.databaseUrlEnv).toBeUndefined();
    expect(rec?.secrets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// static-db-drift: kind=static MUST NOT declare any DB fields
//
// A kind=static app NEVER runs migrations in either path:
//   - env-create branches to buildStaticEnvCreateScript (no migrate phase)
//   - prod deploy's migrate block is inside the node-only else branch
// Declaring DB fields on a static app produces silent drift — migrations
// are configured but never run. validateStaticNoDb() catches this loudly.
//
// RED: these tests fail until validateStaticNoDb() is implemented and wired
// into parseSamohostToml() and runAppRegister().
// ---------------------------------------------------------------------------

describe("parseSamohostToml — kind=static with DB fields is rejected (validateStaticNoDb)", () => {
  /** Minimal valid static manifest, with optional extra fields appended. */
  function minimalStatic(extra: string = ""): string {
    return [
      'name        = "static-app"',
      'repo        = "owner/static-app"',
      'branch      = "main"',
      'appDir      = "/opt/static-app/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:8080/index.html"',
      'serviceUnit = "static-app"',
      'kind        = "static"',
      'staticRoot  = "dist"',
      extra,
    ].filter(Boolean).join("\n");
  }

  /** Minimal valid node manifest, with optional extra fields appended. */
  function minimalNode(extra: string = ""): string {
    return [
      'name        = "node-app"',
      'repo        = "owner/node-app"',
      'branch      = "main"',
      'appDir      = "/opt/node-app/app"',
      'buildCmd    = "npm run build"',
      'healthUrl   = "http://localhost:3000/health"',
      'serviceUnit = "node-app"',
      extra,
    ].filter(Boolean).join("\n");
  }

  // static-db-1: kind=static + migrateCmd → error names the field
  test("static-db-1: kind=static + migrateCmd → error names migrateCmd", () => {
    const result = parseSamohostToml(minimalStatic('migrateCmd = "npm run migrate"'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("migrateCmd");
    expect(joined).toContain("kind=node");
  });

  // static-db-2: kind=static + dbBackend=dblab → error names dbBackend
  test("static-db-2: kind=static + dbBackend=dblab → error names dbBackend", () => {
    const result = parseSamohostToml(
      minimalStatic('dbBackend = "dblab"\ndatabaseUrlEnv = "DATABASE_URL"'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("dbBackend");
    expect(joined).toContain("kind=node");
  });

  // static-db-3: kind=static + dbBackend=template → error names dbBackend
  test("static-db-3: kind=static + dbBackend=template → error names dbBackend", () => {
    const result = parseSamohostToml(
      minimalStatic('dbBackend = "template"\ndatabaseUrlEnv = "DATABASE_URL"'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("dbBackend");
    expect(joined).toContain("kind=node");
  });

  // static-db-4: kind=static + databaseUrlEnv → error names databaseUrlEnv
  test("static-db-4: kind=static + databaseUrlEnv → error names databaseUrlEnv", () => {
    const result = parseSamohostToml(minimalStatic('databaseUrlEnv = "DATABASE_URL"'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("databaseUrlEnv");
    expect(joined).toContain("kind=node");
  });

  // static-db-5: kind=static + envDbVars non-empty → error names envDbVars
  test("static-db-5: kind=static + envDbVars non-empty → error names envDbVars", () => {
    const result = parseSamohostToml(
      minimalStatic('envDbVars = ["DATABASE_URL"]'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("envDbVars");
    expect(joined).toContain("kind=node");
  });

  // static-db-6: kind=static + previewDbBackend=dblab → error names previewDbBackend
  test("static-db-6: kind=static + previewDbBackend=dblab → error names previewDbBackend", () => {
    const result = parseSamohostToml(
      minimalStatic('previewDbBackend = "dblab"\ndatabaseUrlEnv = "DATABASE_URL"'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("previewDbBackend");
    expect(joined).toContain("kind=node");
  });

  // static-db-7: multiple DB fields set → ALL named in errors (all-errors-collected)
  test("static-db-7: kind=static + migrateCmd + databaseUrlEnv + envDbVars → all three named in errors", () => {
    const result = parseSamohostToml(
      minimalStatic([
        'migrateCmd     = "npm run migrate"',
        'databaseUrlEnv = "DATABASE_URL"',
        'envDbVars      = ["DATABASE_URL", "APP_DATABASE_URL"]',
      ].join("\n")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    const joined = result.errors.join("\n");
    expect(joined).toContain("migrateCmd");
    expect(joined).toContain("databaseUrlEnv");
    expect(joined).toContain("envDbVars");
    expect(joined).toContain("kind=node");
  });

  // static-db-8: kind=static + dbBackend="none" (explicit) → OK (plain static with no DB)
  test("static-db-8: kind=static + dbBackend=none → ok (plain static with explicit no-DB declaration)", () => {
    const result = parseSamohostToml(minimalStatic('dbBackend = "none"'));
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.ok).toBe(true);
  });

  // static-db-9: kind=static with no DB fields → OK (plain static)
  test("static-db-9: kind=static with no DB fields → ok (plain static manifest unchanged)", () => {
    const result = parseSamohostToml(minimalStatic());
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.ok).toBe(true);
  });

  // static-db-10: kind=node + DB fields → OK (coherent DB-backed node app, no false positive)
  test("static-db-10: kind=node + migrateCmd + dbBackend + databaseUrlEnv + envDbVars → ok (coherent node app)", () => {
    const result = parseSamohostToml(
      minimalNode([
        'migrateCmd     = "npm run migrate"',
        'dbBackend      = "dblab"',
        'databaseUrlEnv = "DATABASE_URL"',
        'envDbVars      = ["DATABASE_URL"]',
      ].join("\n")),
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.ok).toBe(true);
  });

  // static-db-11: kind absent (defaults to node) + DB fields → OK (legacy/node apps unchanged)
  test("static-db-11: kind absent (implicit node) + DB fields → ok (legacy apps unchanged)", () => {
    const result = parseSamohostToml(
      minimalNode([
        'migrateCmd     = "npm run migrate"',
        'dbBackend      = "dblab"',
        'databaseUrlEnv = "DATABASE_URL"',
      ].join("\n")),
    );
    if (!result.ok) {
      throw new Error("expected ok=true; errors: " + result.errors.join(", "));
    }
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// static-db-reg: runAppRegister rejects kind=static + DB fields programmatically
//
// The TOML parse path catches these at manifest-parse time.
// The register path must also catch them so a programmatic caller (not using
// --from-toml) cannot persist an incoherent AppRecord.
// ---------------------------------------------------------------------------

describe("runAppRegister — kind=static with DB fields rejected (validateStaticNoDb)", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-static-db-reg-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Shared minimal static register input (no DB fields). */
  function staticBase(): Parameters<typeof runAppRegister>[0] {
    return {
      vm: "samo-we-field-record",
      name: "static-app",
      repo: "owner/static-app",
      branch: "main",
      appDir: "/opt/static-app/app",
      buildCmd: "npm run build",
      serviceUnit: "static-app",
      healthUrl: "http://localhost:8080/index.html",
      rlsNonSuperuser: false,
      kind: "static" as const,
      staticRoot: "dist",
    };
  }

  // reg-sdb-1: kind=static + migrateCmd → exit 1, error names migrateCmd
  test("reg-sdb-1: kind=static + migrateCmd → exit 1, error names migrateCmd", () => {
    const c = capture();
    const code = runAppRegister(
      { ...staticBase(), migrateCmd: "npm run migrate" },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("migrateCmd");
    expect(c.e).toContain("kind=node");
    // Must not have persisted the app
    expect(appStore.get("vm-1111", "static-app")).toBeUndefined();
  });

  // reg-sdb-2: kind=static + dbBackend=dblab → exit 1, error names dbBackend
  test("reg-sdb-2: kind=static + dbBackend=dblab → exit 1, error names dbBackend", () => {
    const c = capture();
    const code = runAppRegister(
      { ...staticBase(), dbBackend: "dblab" as const, databaseUrlEnv: "DATABASE_URL" },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("dbBackend");
    expect(c.e).toContain("kind=node");
    expect(appStore.get("vm-1111", "static-app")).toBeUndefined();
  });

  // reg-sdb-3: kind=static + databaseUrlEnv → exit 1, error names databaseUrlEnv
  test("reg-sdb-3: kind=static + databaseUrlEnv → exit 1, error names databaseUrlEnv", () => {
    const c = capture();
    const code = runAppRegister(
      { ...staticBase(), databaseUrlEnv: "DATABASE_URL" },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("databaseUrlEnv");
    expect(c.e).toContain("kind=node");
    expect(appStore.get("vm-1111", "static-app")).toBeUndefined();
  });

  // reg-sdb-4: kind=static + envDbVars non-empty → exit 1, error names envDbVars
  test("reg-sdb-4: kind=static + envDbVars non-empty → exit 1, error names envDbVars", () => {
    const c = capture();
    const code = runAppRegister(
      { ...staticBase(), envDbVars: ["DATABASE_URL"] },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("envDbVars");
    expect(c.e).toContain("kind=node");
    expect(appStore.get("vm-1111", "static-app")).toBeUndefined();
  });

  // reg-sdb-5: kind=static with no DB fields → exit 0 (plain static unchanged)
  test("reg-sdb-5: kind=static with no DB fields → exit 0, app persisted (plain static unchanged)", () => {
    const c = capture();
    const code = runAppRegister(
      staticBase(),
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(appStore.get("vm-1111", "static-app")).toBeDefined();
  });

  // reg-sdb-6: kind=static + dbBackend=none → exit 0 (explicit no-DB is valid)
  test("reg-sdb-6: kind=static + dbBackend=none → exit 0 (explicit no-DB declaration)", () => {
    const c = capture();
    const code = runAppRegister(
      { ...staticBase(), dbBackend: "none" as const },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    const rec = appStore.get("vm-1111", "static-app");
    expect(rec).toBeDefined();
    expect(rec?.dbBackend).toBe("none");
  });

  // reg-sdb-7: kind=node + DB fields → exit 0 (coherent, no false positive)
  test("reg-sdb-7: kind=node + DB fields → exit 0 (coherent node app, no false positive)", () => {
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "node-app",
        repo: "owner/node-app",
        branch: "main",
        appDir: "/opt/node-app/app",
        buildCmd: "npm run build",
        serviceUnit: "node-app",
        healthUrl: "http://localhost:3000/health",
        rlsNonSuperuser: false,
        migrateCmd: "npm run migrate",
        dbBackend: "dblab" as const,
        databaseUrlEnv: "DATABASE_URL",
        envDbVars: ["DATABASE_URL"],
      },
      { json: false },
      vmStore,
      appStore,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(appStore.get("vm-1111", "node-app")).toBeDefined();
  });
});
