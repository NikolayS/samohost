/**
 * tests for `samohost onboard <org/repo>` (issue #127 — client-onboarding package)
 *
 * Coverage:
 *   - parseArgs: `onboard <repo> --vm <name>` parses to {kind:"onboard", input}
 *   - parseArgs: missing <repo> positional → UsageError
 *   - parseArgs: missing --vm → UsageError
 *   - runOnboard: scaffolds the canonical template files into a target repo branch+PR
 *   - runOnboard: registers the app in the state store via toml
 *   - runOnboard: idempotent on re-run (no duplicate PR, no duplicate app record)
 *   - runOnboard: trigger coverage verified = app appears in state store after registration
 *   - template rendering: .samohost.toml placeholder substitution (repo, name)
 *   - template rendering: ci.yml runner-tag placeholder substituted
 *   - template rendering: CLAUDE.md contains both sync-block markers
 *   - template rendering: staging.env.example exists and has non-empty content
 *   - exit-code honesty: non-zero when appRegistered=false or triggerCovered=false
 *   - ci.yml template: NO #117 / AppArmor / host-PG markers (real content check)
 *   - ci.yml template: comment is correct (scaffold-time substitution, not repo variable)
 *   - ci.yml template: default runs-on has no duplicate self-hosted label
 *   - re-onboard clobber: existing .samohost.toml is never overwritten
 *   - findPr: surfaces non-200 GitHub API errors instead of silently returning null
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "../src/cli.ts";
import {
  runOnboard,
  renderTemplate,
  TEMPLATE_FILES,
  defaultOnboardDeps,
  type OnboardInput,
  type OnboardDeps,
} from "../src/commands/onboard.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/client-repo",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-onboard-1",
    provider: "hetzner",
    providerId: "999001",
    name: "samo-we-acme",
    ip: "1.2.3.4",
    sshKeyPath: "/home/fixture/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "nbg1",
    type: "cx22",
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
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { err += s + "\n"; },
    get o() { return out; },
    get e() { return err; },
  };
}

const SAMPLE_TOML = `
name        = "acme-web"
repo        = "acme-org/acme-web"
branch      = "main"
appDir      = "/opt/acme-web/app"
buildCmd    = "npm run build"
healthUrl   = "http://127.0.0.1:3000/api/version"
serviceUnit = "acme-web"
mainHost    = "acme.example.com"
`.trim();

/** Builds a minimal OnboardDeps that never makes real network calls.
 *
 * Default behaviour: the target repo does NOT yet have a .samohost.toml
 * (fetchRepoFile returns null) — simulating the initial onboard scenario.
 * `runOnboard` will render the template toml from the repo name in this case.
 * For re-onboard / clobber-guard tests, override fetchRepoFile to return the
 * existing toml content.
 */
function fakeDeps(overrides: Partial<OnboardDeps> = {}): OnboardDeps {
  const scaffolded: Record<string, string> = {};
  let prCreated = false;

  return {
    fetchRepoFile: async (_repo: string, _path: string) => null,
    getDefaultBranch: async (_repo: string) => "main",
    branchExists: async (_repo: string, _branch: string) => false,
    createBranch: async (_repo: string, _branch: string, _base: string) => { /* no-op */ },
    scaffoldFile: async (_repo: string, _branch: string, path: string, content: string) => {
      scaffolded[path] = content;
    },
    findPr: async (_repo: string, _branch: string) => null,
    createPr: async (_repo: string, _branch: string, _title: string, _body: string) => {
      prCreated = true;
      return "https://github.com/acme-org/acme-web/pull/1";
    },
    get _scaffolded() { return scaffolded; },
    get _prCreated() { return prCreated; },
    ...overrides,
  } as unknown as OnboardDeps;
}

// ---------------------------------------------------------------------------
// parseArgs — onboard command
// ---------------------------------------------------------------------------

describe("parseArgs onboard", () => {
  test("parses required positional + --vm flag", () => {
    const cmd = parseArgs(["onboard", "acme-org/acme-web", "--vm", "samo-we-acme"]);
    if (cmd.kind !== "onboard") throw new Error(`expected 'onboard', got '${cmd.kind}'`);
    expect(cmd.input.repo).toBe("acme-org/acme-web");
    expect(cmd.input.vm).toBe("samo-we-acme");
  });

  test("parses optional --runner-tag", () => {
    const cmd = parseArgs([
      "onboard", "acme-org/acme-web",
      "--vm", "samo-we-acme",
      "--runner-tag", "acme-runner",
    ]);
    if (cmd.kind !== "onboard") throw new Error(`expected 'onboard'`);
    expect(cmd.input.runnerTag).toBe("acme-runner");
  });

  test("parses optional --toml-path", () => {
    const cmd = parseArgs([
      "onboard", "acme-org/acme-web",
      "--vm", "samo-we-acme",
      "--toml-path", "/local/path/.samohost.toml",
    ]);
    if (cmd.kind !== "onboard") throw new Error(`expected 'onboard'`);
    expect(cmd.input.tomlPath).toBe("/local/path/.samohost.toml");
  });

  test("missing repo positional → UsageError", () => {
    expect(() => parseArgs(["onboard", "--vm", "samo-we-acme"])).toThrow(UsageError);
  });

  test("missing --vm → UsageError", () => {
    expect(() => parseArgs(["onboard", "acme-org/acme-web"])).toThrow(UsageError);
  });

  test("repo must contain a slash → UsageError", () => {
    expect(() =>
      parseArgs(["onboard", "not-an-org-repo", "--vm", "samo-we-acme"])
    ).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// runOnboard — scaffold shape
// ---------------------------------------------------------------------------

describe("runOnboard scaffold", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-onboard-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("scaffolds all required template files", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = {
      repo: "acme-org/acme-web",
      vm: "samo-we-acme",
    };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.status).toBe("created");
    // Every entry in TEMPLATE_FILES must have been scaffolded
    for (const f of TEMPLATE_FILES) {
      expect(report.scaffoldedFiles).toContain(f);
    }
  });

  test("scaffolds .github/workflows/ci.yml", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = {
      repo: "acme-org/acme-web",
      vm: "samo-we-acme",
    };

    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    const raw = (deps as unknown as { _scaffolded: Record<string, string> })._scaffolded;
    expect(raw[".github/workflows/ci.yml"]).toBeDefined();
    expect(raw[".github/workflows/ci.yml"]).toContain("on:");
    expect(raw[".github/workflows/ci.yml"]).toContain("pull_request");
  });

  test("scaffolds .samohost.toml with repo and name filled in", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = {
      repo: "acme-org/acme-web",
      vm: "samo-we-acme",
    };

    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    const raw = (deps as unknown as { _scaffolded: Record<string, string> })._scaffolded;
    const toml = raw[".samohost.toml"];
    expect(toml).toBeDefined();
    // The .samohost.toml template has standard required fields
    expect(toml).toContain("name");
    expect(toml).toContain("repo");
    expect(toml).toContain("healthUrl");
    expect(toml).toContain("serviceUnit");
  });

  test("scaffolds CLAUDE.md with both SAMO sync-block markers", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    const raw = (deps as unknown as { _scaffolded: Record<string, string> })._scaffolded;
    const claude = raw["CLAUDE.md"];
    expect(claude).toBeDefined();
    expect(claude).toContain("SAMO-STACK:START");
    expect(claude).toContain("SAMO-STACK:END");
    expect(claude).toContain("SAMO-DEV-PRINCIPLES:START");
    expect(claude).toContain("SAMO-DEV-PRINCIPLES:END");
  });

  test("scaffolds staging.env.example with non-empty content", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    const raw = (deps as unknown as { _scaffolded: Record<string, string> })._scaffolded;
    const stagingEnv = raw["staging.env.example"] ?? "";
    expect(stagingEnv.length).toBeGreaterThan(0);
  });

  test("PR URL appears in the report", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.prUrl).toBe("https://github.com/acme-org/acme-web/pull/1");
  });
});

// ---------------------------------------------------------------------------
// runOnboard — app registration
// ---------------------------------------------------------------------------

describe("runOnboard app registration", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-onboard-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registers the app in the state store after parsing the toml", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.appRegistered).toBe(true);
    // The app must appear in the store under the VM
    const appRecord = appStore.get("vm-onboard-1", "acme-web");
    expect(appRecord).toBeDefined();
    expect(appRecord!.repo).toBe("acme-org/acme-web");
    expect(appRecord!.serviceUnit).toBe("acme-web");
  });

  test("retains staticRoot from an existing static-app manifest", async () => {
    const deps = fakeDeps({
      fetchRepoFile: async (_repo, path) =>
        path === ".samohost.toml"
          ? `${SAMPLE_TOML}\nkind = "static"\nstaticRoot = "dist"\n`
          : null,
    });
    const report = await runOnboard(
      { repo: "acme-org/acme-web", vm: "samo-we-acme" },
      deps,
      vmStore,
      appStore,
      () => {},
      () => {},
    );

    expect(report.appRegistered).toBe(true);
    const appRecord = appStore.get("vm-onboard-1", "acme-web");
    expect(appRecord?.kind).toBe("static");
    expect(appRecord?.staticRoot).toBe("dist");
  });

  test("trigger coverage: registered app appears in store (trigger would pick it up)", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.triggerCovered).toBe(true);
    // Verify directly: trigger iterates appStore.list() — app must be present
    const all = appStore.list();
    expect(all.some((a) => a.repo === "acme-org/acme-web")).toBe(true);
  });

  test("VM not found → error exit (no crash)", async () => {
    const deps = fakeDeps();
    const c = capture();
    // Use a vm name that doesn't exist in the store
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "nonexistent-vm" };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.status).toBe("error");
    expect(c.e).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// runOnboard — idempotency
// ---------------------------------------------------------------------------

describe("runOnboard idempotency", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-onboard-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert(vm());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("re-run when PR already exists → status=updated, no second PR created", async () => {
    let prCreateCalls = 0;
    const deps = fakeDeps({
      findPr: async () => "https://github.com/acme-org/acme-web/pull/1",
      createPr: async () => {
        prCreateCalls++;
        return "https://github.com/acme-org/acme-web/pull/1";
      },
    });
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    const report = await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    expect(report.status).toBe("updated");
    expect(prCreateCalls).toBe(0);
    expect(report.prUrl).toBe("https://github.com/acme-org/acme-web/pull/1");
  });

  test("re-run when app already registered → app record updated, not duplicated", async () => {
    const deps = fakeDeps();
    const c = capture();
    const input: OnboardInput = { repo: "acme-org/acme-web", vm: "samo-we-acme" };

    // First run
    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);
    // Second run
    await runOnboard(input, deps, vmStore, appStore, c.out, c.err);

    // Must not have two records for the same (vm, app)
    const all = appStore.list().filter((a) => a.name === "acme-web");
    expect(all.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  test("substitutes {{RUNNER_TAG}} in ci.yml template text", () => {
    const tmpl = 'runs-on: [self-hosted, "{{RUNNER_TAG}}"]';
    const result = renderTemplate(tmpl, { RUNNER_TAG: "acme-runner" });
    expect(result).toBe('runs-on: [self-hosted, "acme-runner"]');
  });

  test("substitutes {{RUNNER_TAG}} with default when not provided", () => {
    const tmpl = 'runs-on: [self-hosted, "{{RUNNER_TAG}}"]';
    const result = renderTemplate(tmpl, {});
    expect(result).toContain("self-hosted");
    expect(result).not.toContain("{{RUNNER_TAG}}");
  });

  test("ci.yml template has no #117 AppArmor workaround markers", () => {
    // The raw ci.yml template content must not reference issue #117 or
    // AppArmor or host-PG markers — those are field-record-1 one-offs.
    const ciContent = readFileSync(
      join(TEMPLATES_DIR, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ciContent).not.toContain("#117");
    expect(ciContent).not.toContain("AppArmor");
    expect(ciContent).not.toContain("apparmor");
    expect(ciContent).not.toContain("host-PG");
    expect(ciContent).not.toContain("host_pg");
  });

  test("ci.yml template comment is correct: scaffold-time substitution, NOT a repository variable", () => {
    const ciContent = readFileSync(
      join(TEMPLATES_DIR, ".github/workflows/ci.yml"),
      "utf8",
    );
    // The comment must NOT claim RUNNER_TAG is a "repository variable" — it is a
    // scaffold-time {{RUNNER_TAG}} substitution performed by `samohost onboard`.
    expect(ciContent).not.toContain("repository variable");
  });

  test("ci.yml default runs-on has no duplicate self-hosted label", () => {
    const ciContent = readFileSync(
      join(TEMPLATES_DIR, ".github/workflows/ci.yml"),
      "utf8",
    );
    // When rendered with the default RUNNER_TAG="self-hosted", the runs-on line
    // must not produce [self-hosted, "self-hosted"] (a duplicate label).
    const rendered = renderTemplate(ciContent, {});
    expect(rendered).not.toContain('[self-hosted, "self-hosted"]');
    expect(rendered).not.toContain("[self-hosted, 'self-hosted']");
    // The rendered output must still reference self-hosted
    expect(rendered).toContain("self-hosted");
  });
});

// Note: exit-code honesty tests live in test/onboard-exit-code.test.ts
// (separate file so an import-level failure doesn't suppress other tests).

// ---------------------------------------------------------------------------
// RE-ONBOARD CLOBBER GUARD: existing .samohost.toml must not be overwritten
// ---------------------------------------------------------------------------

describe("re-onboard clobber guard", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-clobber-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert({
      id: "vm-clob-1",
      provider: "hetzner",
      providerId: "999003",
      name: "samo-we-acme",
      ip: "1.2.3.6",
      sshKeyPath: "/home/fixture/.ssh/id_ed25519",
      sshPort: 2223,
      sshUser: "agent",
      hostKeyFingerprint: "SHA256:" + "D".repeat(43),
      region: "nbg1",
      type: "cx22",
      modules: [],
      lifecycleState: "adopted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("re-onboard when .samohost.toml already exists → scaffoldFile NOT called for .samohost.toml", async () => {
    const customToml = SAMPLE_TOML + "\n# client-customized: do not overwrite\n";
    let samoTomlScaffoldCalls = 0;
    const deps = fakeDeps({
      // Repo already has a .samohost.toml — return custom content for that path
      fetchRepoFile: async (_repo, path) => {
        if (path === ".samohost.toml") return customToml;
        return null;
      },
      scaffoldFile: async (_repo, _branch, path, _content) => {
        if (path === ".samohost.toml") {
          samoTomlScaffoldCalls++;
        }
      },
    });
    const c = capture();
    const report = await runOnboard(
      { repo: "acme-org/acme-web", vm: "samo-we-acme" },
      deps,
      vmStore,
      appStore,
      c.out,
      c.err,
    );

    // The onboard must succeed
    expect(report.status).not.toBe("error");
    // .samohost.toml must NOT be scaffolded when it already exists in the repo
    expect(samoTomlScaffoldCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findPr: must surface non-200 GitHub API errors
// ---------------------------------------------------------------------------

describe("defaultOnboardDeps().findPr surfaces API errors", () => {
  test("findPr throws on non-200 response instead of silently returning null", async () => {
    const originalFetch = globalThis.fetch;
    // Temporarily set a valid token so ghHeaders() doesn't throw
    const originalToken = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "test-token-placeholder";
    try {
      globalThis.fetch = (async () =>
        new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;
      const deps = defaultOnboardDeps();
      // findPr must throw on a 500 (transient API error), not silently return null.
      // Returning null routes incorrectly to createPr, risking duplicate PRs.
      await expect(
        deps.findPr("acme-org/acme-web", "samohost-onboarding"),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env["GITHUB_TOKEN"];
      } else {
        process.env["GITHUB_TOKEN"] = originalToken;
      }
    }
  });
});
