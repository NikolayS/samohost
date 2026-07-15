/**
 * Tests for the release-tag PRODUCTION deploy channel (issue #132,
 * SPEC-DELTA §8).
 *
 * RED phase: these assertions are written to fail before the implementation
 * exists — no `releaseTagPattern` field, no `selectLatestTag` /
 * `makeResolveLatestTag`, no trigger conditional.
 *
 * Contract (each item traces to a red case below):
 *  - §8 #1 semver ordering: v1.10.0 > v1.9.0 > v1.2.0 (numeric, not lexical).
 *  - §8 #2 prereleases excluded unless the glob opts in (contains "-").
 *  - §8 #3 annotated-tag deref: the resolved sha is the COMMIT sha, obtained
 *          by dereferencing the tag name (not the tag-object sha).
 *  - §8 #4 no matching tag → trigger action=skipped, reason=no-matching-tag,
 *          NO branch fallback (resolveRef never called), prod deployedSha
 *          unchanged.
 *  - §8 #5 an app WITHOUT releaseTagPattern is byte-for-byte unchanged: the
 *          branch-HEAD path is taken and resolveLatestTag is never called.
 *  - §8 #6 a new latest tag advances prod: deploy called once, action=deployed
 *          (i.e. NOT up-to-date); same tag as deployedSha → up-to-date.
 *  - §8 #7 a failed tag deploy sets failedSha → known-bad short-circuit next
 *          cycle (deploy not called, CI not checked).
 *  - §8 #8 releaseTagPattern remains independent of mainHost.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareReleaseTags,
  isDateReleaseTag,
  selectLatestTag,
  makeResolveLatestTag,
  runAppDeploy,
  runAppRegister,
  type AppDeployDeps,
  type GhTagIo,
} from "../src/commands/app.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import {
  runTriggerRun,
  type TriggerDeps,
  type TriggerRunReport,
} from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";
import type { AppDeployInput } from "../src/commands/app.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA_TAG = "1111111111111111111111111111111111111111"; // commit a tag points at
const SHA_OLD = "0000000000000000000000000000000000000000";
const TAG_OBJECT_SHA = "dddddddddddddddddddddddddddddddddddddddd"; // annotated tag object

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
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    serviceUnit: "field-record",
    healthUrl: "http://localhost:3000/api/version",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() {
      return out;
    },
    get e() {
      return err;
    },
  };
}

function makeFakeFetch(
  runs: Array<{ status?: string; conclusion?: string | null }>,
): { fetch: typeof globalThis.fetch; callCount: () => number; urls: string[] } {
  let count = 0;
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    count++;
    urls.push(String(input));
    return {
      ok: true,
      json: async () => ({ workflow_runs: runs }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, callCount: () => count, urls };
}

// ---------------------------------------------------------------------------
// §8 #1 / #2 — pure tag selection (semver order + prerelease policy)
// ---------------------------------------------------------------------------

describe("selectLatestTag — semver ordering & prerelease policy", () => {
  test("date format accepts only real-calendar vYYYYMMDD.N releases", () => {
    expect(isDateReleaseTag("v20260713.1")).toBe(true);
    expect(isDateReleaseTag("v20240229.12")).toBe(true);
    expect(isDateReleaseTag("v20260229.1")).toBe(false);
    expect(isDateReleaseTag("v20261301.1")).toBe(false);
    expect(isDateReleaseTag("v20260713.0")).toBe(false);
    expect(isDateReleaseTag("v20260713.01")).toBe(false);
    expect(isDateReleaseTag("v1.2.3")).toBe(false);
  });

  test("date-formatted selection rejects matching non-date semver tags", () => {
    expect(selectLatestTag(
      ["v99999999.1", "v20260712.2", "v20260713.1", "v1.2.3"],
      "v*",
      "date",
    )).toBe("v20260713.1");
  });
  test("§8 #1 picks the greatest by SEMVER, not lexical (v1.10.0 > v1.9.0)", () => {
    // Lexical sort would put "v1.9.0" after "v1.10.0" (wrong); semver must win.
    expect(selectLatestTag(["v1.2.0", "v1.10.0", "v1.9.0"], "v*")).toBe(
      "v1.10.0",
    );
    // Second rung: with v1.10.0 removed, v1.9.0 outranks v1.2.0.
    expect(selectLatestTag(["v1.2.0", "v1.9.0"], "v*")).toBe("v1.9.0");
  });

  test("§8 #2 excludes prereleases when the glob does NOT opt in", () => {
    // v1.1.0-rc.1 has the higher core version but is a prerelease; with the
    // plain "v*" glob it must be excluded, leaving the v1.0.0 final release.
    expect(selectLatestTag(["v1.0.0", "v1.1.0-rc.1"], "v*")).toBe("v1.0.0");
    // No non-prerelease survivor → null (never a prerelease by default).
    expect(selectLatestTag(["v1.1.0-rc.1", "v1.1.0-rc.2"], "v*")).toBeNull();
  });

  test("§8 #2 includes prereleases only when the glob opts in (contains '-')", () => {
    // The glob explicitly targets prereleases, so they are eligible and the
    // greater rc wins.
    expect(selectLatestTag(["v2.0.0-rc.1", "v2.0.0-rc.2"], "v*-*")).toBe(
      "v2.0.0-rc.2",
    );
  });

  test("§8 #2 a hyphen INSIDE a glob character class is NOT a prerelease opt-in", () => {
    // Regression (PR #133 review): "[0-9]" contains a literal '-', but a class
    // is not a prerelease opt-in. The documented example glob must still
    // EXCLUDE release candidates from a PRODUCTION deploy.
    expect(
      selectLatestTag(["v1.0.0", "v1.2.0-rc.1"], "v[0-9]*.[0-9]*.[0-9]*"),
    ).toBe("v1.0.0");
  });

  test("no tag matches the glob → null", () => {
    expect(selectLatestTag(["nightly-2026", "latest"], "v*")).toBeNull();
    expect(selectLatestTag([], "v*")).toBeNull();
  });

  test("rejects partial semver matches instead of treating garbage as stable", () => {
    expect(selectLatestTag(["v1.2.3garbage"], "v*")).toBeNull();
    expect(selectLatestTag(["v1.2.3+build.7"], "v*")).toBe(
      "v1.2.3+build.7",
    );
  });

  test("release tag comparison is semver-aware and fail-closed", () => {
    expect(compareReleaseTags("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareReleaseTags("v1.8.0", "v1.9.0")).toBeLessThan(0);
    expect(compareReleaseTags("garbage", "v1.9.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §8 #3 — annotated-tag deref via makeResolveLatestTag
// ---------------------------------------------------------------------------

describe("makeResolveLatestTag — deref to commit sha", () => {
  test("§8 #3 dereferences the tag NAME to a COMMIT sha (annotated tag)", async () => {
    const derefCalls: string[] = [];
    const io: GhTagIo = {
      listTags: async () => ["v1.0.0", "v1.2.0"],
      // An annotated tag's OWN object sha is TAG_OBJECT_SHA; commits/<tag>
      // resolves through it to the underlying commit SHA_TAG. The resolver
      // must return the commit sha, obtained by dereferencing the tag name.
      resolveCommitSha: async (_repo, ref) => {
        derefCalls.push(ref);
        return SHA_TAG;
      },
    };
    const resolve = makeResolveLatestTag(io);
    const got = await resolve("Tanya301/field-record-1", "v*");

    expect(got).not.toBeNull();
    expect(got!.tag).toBe("v1.2.0");
    expect(got!.sha).toBe(SHA_TAG); // commit sha, NOT the tag-object sha
    expect(got!.sha).not.toBe(TAG_OBJECT_SHA);
    // Deref was performed against the winning tag NAME (not a raw sha).
    expect(derefCalls).toEqual(["v1.2.0"]);
  });

  test("§8 #4 no matching tag → null and NO deref call (never a branch fallback)", async () => {
    const derefCalls: string[] = [];
    const io: GhTagIo = {
      listTags: async () => ["nightly-123"],
      resolveCommitSha: async (_repo, ref) => {
        derefCalls.push(ref);
        return SHA_TAG;
      },
    };
    const resolve = makeResolveLatestTag(io);
    expect(await resolve("Tanya301/field-record-1", "v*")).toBeNull();
    expect(derefCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Trigger-level wiring (§8 #4, #5, #6, #7)
// ---------------------------------------------------------------------------

describe("trigger run — release-tag production channel", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-reltag-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("§8 #4 no-matching-tag → skipped, no branch fallback, prod unchanged", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_OLD,
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
      }),
    );

    let deployCalls = 0;
    let branchResolveCalls = 0;
    const { fetch: fakeFetch, callCount } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: async () => {
        branchResolveCalls++;
        return SHA_TAG;
      },
      resolveLatestTag: async () => null, // no tag matches
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date("2026-06-15T10:00:00.000Z"),
    };

    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    const report: TriggerRunReport = JSON.parse(c.o);

    const r = report.results[0]!;
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("no-matching-tag");
    expect(deployCalls).toBe(0);
    // NEVER fall back to the branch HEAD or run the CI gate.
    expect(branchResolveCalls).toBe(0);
    expect(callCount()).toBe(0);
    // Prod stays exactly where it was.
    expect(appStore.get("vm-1111", "field-record")?.deployedSha).toBe(SHA_OLD);
    expect(
      appStore.get("vm-1111", "field-record")?.releaseTagChannelInitialized,
    ).toBe(true);
    expect(report.skipped).toBe(1);
    expect(code).toBe(0);
  });

  test("release resolver/verifier absence and off-main tags fail closed", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
      releaseTagChannelInitialized: true,
    }));
    const base = {
      resolveRef: async () => { throw new Error("branch fallback forbidden"); },
      deploy: async () => 0,
      fetch: makeFakeFetch([{ conclusion: "success" }]).fetch,
      env: { GH_TOKEN: "test" },
      now: () => new Date(),
    };

    const noResolver = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, base,
      noResolver.out, noResolver.err,
    )).toBe(1);
    expect((JSON.parse(noResolver.o) as TriggerRunReport).results[0]!.error)
      .toContain("resolver is absent");

    const noVerifier = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore,
      { ...base, resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }) },
      noVerifier.out, noVerifier.err,
    )).toBe(1);
    expect((JSON.parse(noVerifier.o) as TriggerRunReport).results[0]!.error)
      .toContain("ancestry verifier is absent");

    const offMain = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore,
      {
        ...base,
        resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
        isCommitOnBranch: async () => false,
      },
      offMain.out, offMain.err,
    )).toBe(0);
    expect((JSON.parse(offMain.o) as TriggerRunReport).results[0]!.reason)
      .toBe("release-sha-not-on-main");
  });

  test("§8 #5 app WITHOUT releaseTagPattern is unchanged (branch-HEAD path)", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({ deployedSha: SHA_OLD })); // no releaseTagPattern

    const deployInputs: AppDeployInput[] = [];
    let tagResolveCalls = 0;
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: async () => SHA_TAG,
      // Wired, but MUST NOT be consulted for a pattern-less app.
      resolveLatestTag: async () => {
        tagResolveCalls++;
        return { tag: "v9.9.9", sha: "deadbeef" };
      },
      deploy: async (input) => {
        deployInputs.push(input);
        return 0;
      },
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    const report: TriggerRunReport = JSON.parse(c.o);

    expect(tagResolveCalls).toBe(0); // release-tag path NOT taken
    expect(deployInputs.length).toBe(1);
    expect(deployInputs[0]!.sha).toBe(SHA_TAG); // branch HEAD, as before
    expect(report.results[0]!.action).toBe("deployed");
    expect(code).toBe(0);
  });

  test("first tag cut after an empty initialized channel deploys", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_OLD,
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagChannelInitialized: true,
      }),
    );
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);
    let deployCalls = 0;
    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run");
      },
      resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
      isCommitOnBranch: async () => true,
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date(),
    };
    const c = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err,
    )).toBe(0);
    expect(deployCalls).toBe(1);
    expect(appStore.get("vm-1111", "field-record")?.releaseTagCursor).toBe(
      "v20260713.1",
    );
  });

  test("safe activation baselines an old tag without rolling back existing prod", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        // Production is already on a newer commit that no historical tag
        // points at (the real Samograph rollout shape).
        deployedSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
      }),
    );

    let deployCalls = 0;
    const { fetch: fakeFetch, callCount } = makeFakeFetch([]);
    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run");
      },
      resolveLatestTag: async () => ({ tag: "v20260710.1", sha: SHA_OLD }),
      isCommitOnBranch: async () => true,
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c1 = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, deps, c1.out, c1.err,
    )).toBe(0);
    const report1: TriggerRunReport = JSON.parse(c1.o);
    expect(report1.results[0]!.reason).toBe("release-tag-baselined");
    expect(deployCalls).toBe(0);
    expect(callCount()).toBe(0);
    expect(appStore.get("vm-1111", "field-record")?.releaseTagCursor).toBe(
      "v20260710.1",
    );
    expect(
      appStore.get("vm-1111", "field-record")?.releaseTagChannelInitialized,
    ).toBe(true);

    // The same tag remains inert on later cycles.
    const c2 = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, deps, c2.out, c2.err,
    )).toBe(0);
    const report2: TriggerRunReport = JSON.parse(c2.o);
    expect(report2.results[0]!.reason).toBe("no-new-release-tag");
    expect(deployCalls).toBe(0);
  });

  test("a tag newer than the activation cursor deploys and advances the cursor", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_OLD,
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagCursor: "v20260710.1",
        releaseTagChannelInitialized: true,
      }),
    );

    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);
    let deployCalls = 0;
    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run");
      },
      resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
      isCommitOnBranch: async () => true,
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date(),
    };

    const c = capture();
    expect(await runTriggerRun(
      { dryRun: false }, { json: true }, vmStore, appStore, deps, c.out, c.err,
    )).toBe(0);
    const report: TriggerRunReport = JSON.parse(c.o);
    expect(report.results[0]!.action).toBe("deployed");
    expect(deployCalls).toBe(1);
    expect(appStore.get("vm-1111", "field-record")?.releaseTagCursor).toBe(
      "v20260713.1",
    );
  });

  test("§8 #6 a new latest tag advances prod: deploy once, action=deployed", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_OLD,
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagCursor: "v20260712.1",
        releaseTagChannelInitialized: true,
      }),
    );

    const deployInputs: AppDeployInput[] = [];
    const { fetch: fakeFetch, urls } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run for a tag-tracked app");
      },
      resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
      isCommitOnBranch: async () => true,
      deploy: async (input) => {
        deployInputs.push(input);
        return 0;
      },
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    const report: TriggerRunReport = JSON.parse(c.o);

    expect(deployInputs.length).toBe(1);
    expect(deployInputs[0]!.sha).toBe(SHA_TAG);
    expect(deployInputs[0]!.releaseTag).toBe("v20260713.1");
    expect(urls[0]).toContain("/actions/workflows/ci.yml/runs?");
    expect(report.results[0]!.action).toBe("deployed");
    expect(report.results[0]!.sha).toBe(SHA_TAG);
    expect(code).toBe(0);
  });

  test("§8 #6 latest tag already deployed → up-to-date, no deploy", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_TAG, // already on the latest tag's commit
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagCursor: "v20260713.1",
        releaseTagChannelInitialized: true,
      }),
    );

    let deployCalls = 0;
    const { fetch: fakeFetch, callCount } = makeFakeFetch([]);

    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run");
      },
      resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
      isCommitOnBranch: async () => true,
      deploy: async () => {
        deployCalls++;
        return 0;
      },
      fetch: fakeFetch,
      env: {},
      now: () => new Date(),
    };

    const c = capture();
    const code = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c.out,
      c.err,
    );
    const report: TriggerRunReport = JSON.parse(c.o);

    expect(report.results[0]!.action).toBe("up-to-date");
    expect(deployCalls).toBe(0);
    expect(callCount()).toBe(0); // short-circuits before the CI gate
    expect(code).toBe(0);
  });

  test("§8 #7 failed tag deploy sets failedSha → known-bad next cycle", async () => {
    vmStore.upsert(makeVm());
    appStore.upsert(
      makeApp({
        deployedSha: SHA_OLD,
        mainHost: "field-record-1.samo.team",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagCursor: "v20260712.1",
        releaseTagChannelInitialized: true,
      }),
    );

    // Fake deploy that mimics runAppDeploy's real bookkeeping: on a non-zero
    // (failed) deploy it stamps failedSha on the AppRecord.
    let deployCalls = 0;
    const deployStampingFailure: TriggerDeps["deploy"] = async (
      input,
      _opts,
      _vmStore,
      store,
      _out,
      _err,
    ) => {
      deployCalls++;
      const rec = store.get("vm-1111", input.app)!;
      store.compareAndSwap(rec, { ...rec, failedSha: input.sha! });
      return 1; // deploy failed
    };

    const { fetch: fakeFetch } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);

    const deps: TriggerDeps = {
      resolveRef: async () => {
        throw new Error("branch path must not run");
      },
      resolveLatestTag: async () => ({ tag: "v20260713.1", sha: SHA_TAG }),
      isCommitOnBranch: async () => true,
      deploy: deployStampingFailure,
      fetch: fakeFetch,
      env: { GH_TOKEN: "ghp_test" },
      now: () => new Date(),
    };

    // Cycle 1: deploy runs and fails → action=failed, failedSha stamped.
    const c1 = capture();
    const code1 = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      c1.out,
      c1.err,
    );
    const report1: TriggerRunReport = JSON.parse(c1.o);
    expect(report1.results[0]!.action).toBe("failed");
    expect(deployCalls).toBe(1);
    expect(appStore.get("vm-1111", "field-record")?.failedSha).toBe(SHA_TAG);
    expect(code1).toBe(1);

    // Cycle 2: same tag → known-bad short-circuit; deploy NOT called again.
    const { fetch: fakeFetch2, callCount: cc2 } = makeFakeFetch([
      { status: "completed", conclusion: "success" },
    ]);
    const deps2: TriggerDeps = { ...deps, fetch: fakeFetch2 };
    const c2 = capture();
    const code2 = await runTriggerRun(
      { dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps2,
      c2.out,
      c2.err,
    );
    const report2: TriggerRunReport = JSON.parse(c2.o);
    expect(report2.results[0]!.action).toBe("known-bad");
    expect(deployCalls).toBe(1); // unchanged — no second deploy
    expect(cc2()).toBe(0); // no CI round-trip for a known-bad sha
    expect(code2).toBe(0);
  });
});

describe("release deploy authority", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-release-authority-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(makeVm());
    appStore.upsert(makeApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(overrides: Partial<AppDeployDeps> = {}): AppDeployDeps {
    return {
      remote: async () => ({
        code: 0,
        stdout: "<<<SAMOHOST_PHASE:health:start>>>\n<<<SAMOHOST_PHASE:health:ok>>>",
        stderr: "",
      }),
      resolveRef: async () => SHA_TAG,
      isCommitOnBranch: async () => true,
      fetch: makeFakeFetch([{ status: "completed", conclusion: "success" }]).fetch,
      now: () => new Date(),
      env: { GH_TOKEN: "test" },
      ...overrides,
    };
  }

  test("manual and skip-CI release deploys are refused before remote execution", async () => {
    let remoteCalls = 0;
    const d = deps({ remote: async () => {
      remoteCalls++;
      return { code: 0, stdout: "", stderr: "" };
    } });
    const manual = capture();
    expect(await runAppDeploy(
      { vm: makeVm().name, app: "field-record", sha: SHA_TAG, skipCiGate: false },
      { json: false }, vmStore, appStore, d, manual.out, manual.err,
    )).toBe(1);
    expect(manual.e).toContain("cannot be deployed manually");

    const skipped = capture();
    expect(await runAppDeploy(
      {
        vm: makeVm().name,
        app: "field-record",
        sha: SHA_TAG,
        releaseTag: "v20260713.1",
        skipCiGate: true,
      },
      { json: false }, vmStore, appStore, d, skipped.out, skipped.err,
    )).toBe(1);
    expect(skipped.e).toContain("--skip-ci-gate is forbidden");
    expect(remoteCalls).toBe(0);
  });

  test("hand-edited state with a non-canonical workflow fails closed before CI or SSH", async () => {
    const existing = appStore.get("vm-1111", "field-record")!;
    appStore.compareAndSwap(existing, makeApp({
      id: existing.id,
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/release.yml",
    }));
    let fetchCalls = 0;
    let remoteCalls = 0;
    const c = capture();
    expect(await runAppDeploy(
      {
        vm: makeVm().name,
        app: "field-record",
        sha: SHA_TAG,
        releaseTag: "v20260713.1",
        skipCiGate: false,
      },
      { json: false }, vmStore, appStore,
      deps({
        fetch: (async () => {
          fetchCalls++;
          throw new Error("must not fetch");
        }) as unknown as typeof fetch,
        remote: async () => {
          remoteCalls++;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
      c.out,
      c.err,
    )).toBe(1);
    expect(c.e).toContain(".github/workflows/ci.yml");
    expect(fetchCalls).toBe(0);
    expect(remoteCalls).toBe(0);
  });

  test("a forged tag/SHA pair or off-main release is refused", async () => {
    const forged = capture();
    expect(await runAppDeploy(
      {
        vm: makeVm().name,
        app: "field-record",
        sha: SHA_TAG,
        releaseTag: "v20260713.1",
        skipCiGate: false,
      },
      { json: false }, vmStore, appStore,
      deps({ resolveRef: async () => SHA_OLD }), forged.out, forged.err,
    )).toBe(1);
    expect(forged.e).toContain("does not resolve to requested sha");

    const offMain = capture();
    expect(await runAppDeploy(
      {
        vm: makeVm().name,
        app: "field-record",
        sha: SHA_TAG,
        releaseTag: "v20260713.1",
        skipCiGate: false,
      },
      { json: false }, vmStore, appStore,
      deps({ isCommitOnBranch: async () => false }), offMain.out, offMain.err,
    )).toBe(1);
    expect(offMain.e).toContain("not an ancestor");
  });

  test("verified release re-gates the exact configured workflow before SSH", async () => {
    const seen: string[] = [];
    let remoteCalls = 0;
    const d = deps({
      fetch: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return {
          ok: true,
          json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }),
        } as Response;
      }) as unknown as typeof fetch,
      remote: async () => {
        remoteCalls++;
        return {
          code: 0,
          stdout: "<<<SAMOHOST_PHASE:health:start>>>\n<<<SAMOHOST_PHASE:health:ok>>>",
          stderr: "",
        };
      },
    });
    const c = capture();
    expect(await runAppDeploy(
      {
        vm: makeVm().name,
        app: "field-record",
        sha: SHA_TAG,
        releaseTag: "v20260713.1",
        skipCiGate: false,
      },
      { json: true }, vmStore, appStore, d, c.out, c.err,
    )).toBe(0);
    expect(remoteCalls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/actions/workflows/ci.yml/runs?");
    expect(seen[0]).toContain("per_page=1");
  });
});

// ---------------------------------------------------------------------------
// §8 #8 — schema compatibility: releaseTagPattern is independent of mainHost
// ---------------------------------------------------------------------------

describe("validation — releaseTagPattern remains independent of mainHost", () => {
  test("release channel requires date format and the canonical trusted workflow path", () => {
    const base = [
      'name = "field-record"',
      'repo = "Tanya301/field-record-1"',
      'branch = "main"',
      'appDir = "/opt/field-record/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/api/version"',
      'serviceUnit = "field-record"',
      'releaseTagPattern = "v*"',
    ];
    const missing = parseSamohostToml(base.join("\n"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.join("\n")).toContain('releaseTagFormat = "date"');
      expect(missing.errors.join("\n")).toContain(
        'releaseCiWorkflow = ".github/workflows/ci.yml" is required',
      );
    }
    const inexact = parseSamohostToml([
      ...base,
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = "ci.yml"',
    ].join("\n"));
    expect(inexact.ok).toBe(false);
    if (!inexact.ok) {
      expect(inexact.errors.join("\n")).toContain("canonical trusted workflow path");
    }
  });

  test("programmatic registration rejects filename-only and alternate workflow paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-release-ci-policy-"));
    try {
      const vmStore = new StateStore(join(dir, "state.json"));
      const appStore = new AppStore(join(dir, "apps.json"));
      vmStore.upsert(makeVm());
      for (const releaseCiWorkflow of [
        "ci.yml",
        ".github/workflows/release.yml",
        "../ci.yml",
      ]) {
        const c = capture();
        expect(runAppRegister(
          {
            vm: "samo-we-field-record",
            name: "field-record",
            repo: "Tanya301/field-record-1",
            branch: "main",
            appDir: "/opt/field-record/app",
            buildCmd: "npm run build",
            serviceUnit: "field-record",
            healthUrl: "http://localhost:3000/api/version",
            rlsNonSuperuser: false,
            releaseTagPattern: "v*",
            releaseTagFormat: "date",
            releaseCiWorkflow,
          },
          { json: false }, vmStore, appStore, c.out, c.err,
        )).toBe(1);
        expect(c.e).toContain(".github/workflows/ci.yml");
        expect(appStore.get("vm-1111", "field-record")).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("static release channel requires an owned mainHost", () => {
    const res = parseSamohostToml([
      'name = "site"',
      'repo = "example/site"',
      'branch = "main"',
      'appDir = "/opt/site/app"',
      'buildCmd = "true"',
      'healthUrl = "http://localhost/"',
      'serviceUnit = "site"',
      'kind = "static"',
      'releaseTagPattern = "v*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("mainHost is required");
  });

  test("§8 #8 TOML: releaseTagPattern without mainHost remains valid", () => {
    const toml = [
      'name = "field-record"',
      'repo = "Tanya301/field-record-1"',
      'branch = "main"',
      'appDir = "/opt/field-record/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/api/version"',
      'serviceUnit = "field-record"',
      'releaseTagPattern = "v*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n");
    const res = parseSamohostToml(toml);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.app.releaseTagPattern).toBe("v*");
    }
  });

  test("§8 #8 TOML: releaseTagPattern WITH mainHost → ok, field carried", () => {
    const toml = [
      'name = "field-record"',
      'repo = "Tanya301/field-record-1"',
      'branch = "main"',
      'appDir = "/opt/field-record/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/api/version"',
      'serviceUnit = "field-record"',
      'mainHost = "field-record-1.samo.team"',
      'releaseTagPattern = "v*"',
      'releaseTagFormat = "date"',
      'releaseCiWorkflow = ".github/workflows/ci.yml"',
    ].join("\n");
    const res = parseSamohostToml(toml);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.app.releaseTagPattern).toBe("v*");
    }
  });

  test("§8 #8 TOML: non-string releaseTagPattern → type error", () => {
    const toml = [
      'name = "field-record"',
      'repo = "Tanya301/field-record-1"',
      'branch = "main"',
      'appDir = "/opt/field-record/app"',
      'buildCmd = "npm run build"',
      'healthUrl = "http://localhost:3000/api/version"',
      'serviceUnit = "field-record"',
      'mainHost = "field-record-1.samo.team"',
      "releaseTagPattern = 42",
    ].join("\n");
    const res = parseSamohostToml(toml);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.errors.some((e) => /releaseTagPattern must be a string/.test(e)),
      ).toBe(true);
    }
  });

  test("§8 #8 app register: releaseTagPattern without mainHost persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-reltag-reg-"));
    try {
      const vmStore = new StateStore(join(dir, "state.json"));
      const appStore = new AppStore(join(dir, "apps.json"));
      vmStore.upsert(makeVm());

      const c = capture();
      const code = runAppRegister(
        {
          vm: "samo-we-field-record",
          name: "field-record",
          repo: "Tanya301/field-record-1",
          branch: "main",
          appDir: "/opt/field-record/app",
          buildCmd: "npm run build",
          serviceUnit: "field-record",
          healthUrl: "http://localhost:3000/api/version",
          rlsNonSuperuser: false,
          releaseTagPattern: "v*",
          releaseTagFormat: "date",
          releaseCiWorkflow: ".github/workflows/ci.yml",
        },
        { json: false },
        vmStore,
        appStore,
        c.out,
        c.err,
      );
      expect(code).toBe(0);
      expect(appStore.get("vm-1111", "field-record")?.releaseTagPattern).toBe(
        "v*",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("§8 #8 app register: releaseTagPattern WITH mainHost persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-reltag-reg2-"));
    try {
      const vmStore = new StateStore(join(dir, "state.json"));
      const appStore = new AppStore(join(dir, "apps.json"));
      vmStore.upsert(makeVm());

      const c = capture();
      const code = runAppRegister(
        {
          vm: "samo-we-field-record",
          name: "field-record",
          repo: "Tanya301/field-record-1",
          branch: "main",
          appDir: "/opt/field-record/app",
          buildCmd: "npm run build",
          serviceUnit: "field-record",
          healthUrl: "http://localhost:3000/api/version",
          rlsNonSuperuser: false,
          mainHost: "field-record-1.samo.team",
          releaseTagPattern: "v*",
          releaseTagFormat: "date",
          releaseCiWorkflow: ".github/workflows/ci.yml",
        },
        { json: false },
        vmStore,
        appStore,
        c.out,
        c.err,
      );
      expect(code).toBe(0);
      expect(appStore.get("vm-1111", "field-record")?.releaseTagPattern).toBe(
        "v*",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changing releaseTagPattern resets the internal activation cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-reltag-reg3-"));
    try {
      const vmStore = new StateStore(join(dir, "state.json"));
      const appStore = new AppStore(join(dir, "apps.json"));
      vmStore.upsert(makeVm());
      appStore.upsert(makeApp({
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
        releaseTagCursor: "v20260712.1",
        releaseTagChannelInitialized: true,
      }));

      const c = capture();
      expect(runAppRegister(
        {
          vm: "samo-we-field-record",
          name: "field-record",
          repo: "Tanya301/field-record-1",
          branch: "main",
          appDir: "/opt/field-record/app",
          buildCmd: "npm run build",
          serviceUnit: "field-record",
          healthUrl: "http://localhost:3000/api/version",
          rlsNonSuperuser: false,
          releaseTagPattern: "v2026*",
          releaseTagFormat: "date",
          releaseCiWorkflow: ".github/workflows/ci.yml",
        },
        { json: false }, vmStore, appStore, c.out, c.err,
      )).toBe(0);
      const saved = appStore.get("vm-1111", "field-record");
      expect(saved?.releaseTagPattern).toBe("v2026*");
      expect(saved?.releaseTagCursor).toBeUndefined();
      expect(saved?.releaseTagChannelInitialized).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
