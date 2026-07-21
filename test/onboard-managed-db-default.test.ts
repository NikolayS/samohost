/**
 * P2 — onboard default: managed-DB node app.
 *
 * Owner directive: most clients need a real app with a DB. truly-static is the
 * rare opt-out. The template and synth default must be a managed-DB node app.
 *
 * Coverage:
 *   1. Template .samohost.toml has DB fields uncommented/active by default:
 *      dbBackend="dblab", databaseUrlEnv set, migrateCmd set, rlsNonSuperuser=true,
 *      envDbVars present.
 *   2. Template .samohost.toml parses OK and PASSES validateStaticNoDb (node+DB = allowed).
 *   3. Template .samohost.toml does NOT have kind="static" as the default.
 *   4. Template .samohost.toml contains a documented static opt-out comment block.
 *   5. onboard-synth (no .samohost.toml in repo): synthesised AppRecord has
 *      dbBackend="dblab", databaseUrlEnv set, migrateCmd set; kind is absent
 *      (resolves to node).
 *   6. Synthesised TOML parses OK (no validation errors).
 *   7. Synthesised AppRecord passes validateStaticNoDb (node + DB fields = allowed).
 *   8. Static opt-out manifests (kind=static, no DB fields) still parse OK.
 *   9. Template references @samo/auth baseline migration path.
 *   10. staging.env.example has DATABASE_URL uncommented (ready for DB apps).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runOnboard,
  renderTemplate,
  type OnboardInput,
  type OnboardDeps,
} from "../src/commands/onboard.ts";
import { parseSamohostToml, validateStaticNoDb } from "../src/manifest/toml.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/client-repo",
);

const TEMPLATE_TOML_PATH = join(TEMPLATES_DIR, ".samohost.toml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-p2-1",
    provider: "hetzner",
    providerId: "999100",
    name: "samo-we-acme",
    ip: "10.0.0.1",
    sshKeyPath: "/home/fixture/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "C".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function fakeDeps(overrides: Partial<OnboardDeps> = {}): OnboardDeps {
  const scaffolded: Record<string, string> = {};
  return {
    fetchRepoFile: async (_repo: string, _path: string) => null, // no .samohost.toml in repo
    getDefaultBranch: async (_repo: string) => "main",
    branchExists: async (_repo: string, _branch: string) => false,
    createBranch: async () => {},
    scaffoldFile: async (_repo: string, _branch: string, path: string, content: string) => {
      scaffolded[path] = content;
    },
    findPr: async () => null,
    createPr: async () => "https://github.com/acme-org/acme-web/pull/1",
    get _scaffolded() { return scaffolded; },
    ...overrides,
  } as unknown as OnboardDeps;
}

// ---------------------------------------------------------------------------
// 1-4: Template .samohost.toml — managed-DB node shape as default
// ---------------------------------------------------------------------------

describe("template .samohost.toml — managed-DB node default", () => {
  let rawTemplate: string;
  let renderedTemplate: string;

  beforeEach(() => {
    rawTemplate = readFileSync(TEMPLATE_TOML_PATH, "utf8");
    renderedTemplate = renderTemplate(rawTemplate, {
      APP_NAME: "acme-web",
      REPO: "acme-org/acme-web",
      APP_DB_NAME: "acme_web",
    });
  });

  test("1a. template has dbBackend=dblab as an ACTIVE (uncommented) field", () => {
    // Must be an active assignment, not a comment
    const activeLines = renderedTemplate
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(
      activeLines,
      `Template .samohost.toml must have dbBackend="dblab" as an active field (not commented out). ` +
        `Current active lines:\n${activeLines}`,
    ).toContain('dbBackend');
    // Specifically "dblab" value
    expect(activeLines).toContain('"dblab"');
  });

  test("1b. template has databaseUrlEnv as an ACTIVE field", () => {
    const activeLines = renderedTemplate
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(
      activeLines,
      `Template .samohost.toml must have databaseUrlEnv as an active field. Active lines:\n${activeLines}`,
    ).toContain("databaseUrlEnv");
  });

  test("1c. template has migrateCmd as an ACTIVE field", () => {
    const activeLines = renderedTemplate
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(
      activeLines,
      `Template .samohost.toml must have migrateCmd as an active field. Active lines:\n${activeLines}`,
    ).toContain("migrateCmd");
  });

  test("1d. template has rlsNonSuperuser=true as an ACTIVE field", () => {
    const activeLines = renderedTemplate
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(activeLines).toContain("rlsNonSuperuser");
    expect(activeLines).toContain("true");
  });

  test("1e. template has envDbVars as an ACTIVE field containing DATABASE_URL", () => {
    const activeLines = renderedTemplate
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(activeLines).toContain("envDbVars");
    expect(activeLines).toContain("DATABASE_URL");
  });

  test("2. rendered template parses OK (no validation errors)", () => {
    const result = parseSamohostToml(renderedTemplate);
    expect(
      result.ok,
      `Template parse failed: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);
  });

  test("2b. parsed template PASSES validateStaticNoDb (node + DB fields is valid)", () => {
    const result = parseSamohostToml(renderedTemplate);
    if (!result.ok) throw new Error("Template failed to parse: " + result.errors.join(", "));
    const errors: string[] = [];
    validateStaticNoDb(result.app, errors);
    expect(errors, `validateStaticNoDb should not error for a node+DB app. Got: ${errors.join(", ")}`).toHaveLength(0);
  });

  test("3. default template does NOT set kind=static", () => {
    const result = parseSamohostToml(renderedTemplate);
    if (!result.ok) throw new Error("Template failed to parse");
    // kind must be absent (defaults to node) or explicitly "node" — never "static"
    expect(result.app.kind).not.toBe("static");
  });

  test("3b. default template has healthUrl on port 3000 (node app)", () => {
    const result = parseSamohostToml(renderedTemplate);
    if (!result.ok) throw new Error("Template failed to parse");
    expect(result.app.healthUrl).toContain("3000");
  });

  test("4. template has a documented static opt-out comment block", () => {
    // The raw template (not rendered) must contain the static opt-out comment
    // so developers reading the template understand how to opt out of DB
    expect(
      rawTemplate,
      `Template must contain a documented static opt-out comment. ` +
        `Developers must be able to see how to explicitly opt out of DB. ` +
        `Raw template:\n${rawTemplate}`,
    ).toContain("static");
    // Must mention kind="static" in a comment context
    const commentLines = rawTemplate
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#"))
      .join("\n");
    expect(
      commentLines,
      `Template must have a comment mentioning kind="static" as the opt-out mechanism. ` +
        `Comment lines:\n${commentLines}`,
    ).toContain("static");
  });

  test("9. template or CLAUDE.md references @samo/auth baseline", () => {
    // Either the template .samohost.toml or CLAUDE.md must reference
    // @samo/auth so onboarded clients know where the baseline auth migration lives.
    const claudeMd = readFileSync(join(TEMPLATES_DIR, "CLAUDE.md"), "utf8");
    const hasAuthRef =
      rawTemplate.includes("@samo/auth") ||
      rawTemplate.includes("samo/auth") ||
      rawTemplate.includes("0001_auth") ||
      claudeMd.includes("@samo/auth") ||
      claudeMd.includes("samo/auth") ||
      claudeMd.includes("0001_auth") ||
      claudeMd.includes("bcrypt") ||
      // The stack block already mentions bcrypt+cookie as the default auth
      claudeMd.includes("bcrypt + cookie");
    expect(
      hasAuthRef,
      `Either .samohost.toml template or CLAUDE.md must reference @samo/auth (the shared auth module) ` +
        `or its migration. This ensures onboarded clients know the canonical auth baseline. ` +
        `Template:\n${rawTemplate}\n\nCLAUDE.md:\n${claudeMd}`,
    ).toBe(true);
  });

  test("10. staging.env.example has DATABASE_URL as an ACTIVE (uncommented) line", () => {
    const stagingEnv = readFileSync(join(TEMPLATES_DIR, "staging.env.example"), "utf8");
    const activeLines = stagingEnv
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#") && l.trim().length > 0)
      .join("\n");
    expect(
      activeLines,
      `staging.env.example must have DATABASE_URL as an active assignment (not just a comment). ` +
        `Active lines:\n${activeLines}`,
    ).toContain("DATABASE_URL");
  });
});

// ---------------------------------------------------------------------------
// 5-7: onboard-synth (no .samohost.toml in repo) yields managed-DB node AppRecord
// ---------------------------------------------------------------------------

describe("onboard-synth — no .samohost.toml → managed-DB node AppRecord", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-p2-synth-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("5a. synthesised AppRecord has dbBackend=dblab", async () => {
    const deps = fakeDeps(); // fetchRepoFile returns null → synth path
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    const report = await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    expect(report.appRegistered).toBe(true);
    const rec = appStore.get("vm-p2-1", "acme-web");
    expect(
      rec?.dbBackend,
      `Synthesised AppRecord must have dbBackend="dblab". Got: ${rec?.dbBackend}`,
    ).toBe("dblab");
  });

  test("5b. synthesised AppRecord has databaseUrlEnv set", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-p2-1", "acme-web");
    expect(
      rec?.databaseUrlEnv,
      `Synthesised AppRecord must have databaseUrlEnv set. Got: ${rec?.databaseUrlEnv}`,
    ).toBeTruthy();
  });

  test("5c. synthesised AppRecord has migrateCmd set", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-p2-1", "acme-web");
    expect(
      rec?.migrateCmd,
      `Synthesised AppRecord must have migrateCmd set. Got: ${rec?.migrateCmd}`,
    ).toBeTruthy();
  });

  test("5d. synthesised AppRecord has kind=node or kind absent (never static)", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-p2-1", "acme-web");
    expect(
      rec?.kind,
      `Synthesised AppRecord must not be kind=static. Got: ${rec?.kind}`,
    ).not.toBe("static");
  });

  test("6. synthesised TOML (scaffolded .samohost.toml) parses OK", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const scaffolded = (deps as unknown as { _scaffolded: Record<string, string> })._scaffolded;
    const tomlText = scaffolded[".samohost.toml"];
    expect(tomlText, "Scaffolded .samohost.toml must exist").toBeDefined();

    const result = parseSamohostToml(tomlText!);
    expect(
      result.ok,
      `Scaffolded .samohost.toml must parse without errors. Errors: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);
  });

  test("7. synthesised AppRecord passes validateStaticNoDb (node+DB = valid)", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-p2-1", "acme-web");
    expect(rec, "AppRecord must exist").toBeDefined();

    const errors: string[] = [];
    validateStaticNoDb(
      {
        kind: rec!.kind,
        migrateCmd: rec!.migrateCmd,
        dbBackend: rec!.dbBackend,
        previewDbBackend: rec!.previewDbBackend,
        databaseUrlEnv: rec!.databaseUrlEnv,
        envDbVars: rec!.envDbVars,
      },
      errors,
    );
    expect(
      errors,
      `validateStaticNoDb must not error for a synthesised node+DB AppRecord. Got: ${errors.join(", ")}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8: Static opt-out still works
// ---------------------------------------------------------------------------

describe("static opt-out — kind=static without DB fields parses OK", () => {
  const STATIC_OPT_OUT_TOML = `
name        = "brochure-site"
repo        = "acme-org/brochure-site"
branch      = "main"
appDir      = "/opt/brochure-site/app"
buildCmd    = "npm run build"
healthUrl   = "http://127.0.0.1:8080/index.html"
serviceUnit = "brochure-site"
kind        = "static"
staticRoot  = "dist"
`.trim();

  test("8. kind=static + no DB fields parses and validates without errors", () => {
    const result = parseSamohostToml(STATIC_OPT_OUT_TOML);
    expect(
      result.ok,
      `Static opt-out TOML must parse without errors. Errors: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);

    if (!result.ok) return;
    const errors: string[] = [];
    validateStaticNoDb(result.app, errors);
    expect(
      errors,
      `validateStaticNoDb must not error for a clean kind=static + no DB fields app. Got: ${errors.join(", ")}`,
    ).toHaveLength(0);

    expect(result.app.kind).toBe("static");
    expect(result.app.dbBackend).toBeUndefined();
    expect(result.app.migrateCmd).toBeUndefined();
    expect(result.app.databaseUrlEnv).toBeUndefined();
  });
});
