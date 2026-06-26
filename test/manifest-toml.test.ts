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
    const tomlPath = writeToml('previewDbBackend = "template"');
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
    // Fails today: rec.previewDbBackend is undefined (dropped)
    expect(rec?.previewDbBackend).toBe("template");
  });

  test("reg-db-4: manifest with both dbBackend='none' and previewDbBackend='dblab' → both persisted", () => {
    // Explicit previewDbBackend must override the dbBackend='none' fallback.
    const tomlPath = writeToml('dbBackend = "none"\npreviewDbBackend = "dblab"');
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
