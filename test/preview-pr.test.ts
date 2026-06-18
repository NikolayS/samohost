/**
 * Tests for src/preview/pr.ts — runPrPreviewPass and PrPreviewDeps.
 *
 * RED phase: these tests MUST FAIL before the implementation is written.
 *
 * Design principles being tested:
 *  - Open PR with no env → ensurePreview called; comment posted; action=created.
 *  - PR push (sha changed) → ensurePreview called again; comment upserted; action=redeployed.
 *  - Unchanged PR (sha same) → ensurePreview NOT called; comment NOT posted; action=unchanged.
 *  - Slash branch names preserved byte-for-byte.
 *  - Cap: > MAX_PR_PREVIEWS_PER_CYCLE PRs → only first N ensured; warning emitted.
 *  - Closed-PR reap: env for a branch not in open set → reapPreview called; guarded.
 *  - Isolation: one PR throws → others still processed.
 *  - Sequential create-then-unchanged: fake writes EnvRecord to shared store so
 *    the sha-compare works across two runPrPreviewPass calls on the same store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPrPreviewPass,
  PR_PREVIEW_COMMENT_MARKER,
  MAX_PR_PREVIEWS_PER_CYCLE,
  type PrPreviewDeps,
  type OpenPr,
  type EnsurePreviewResult,
  type PrPreviewSummary,
} from "../src/preview/pr.ts";
import { EnvStore } from "../src/state/envs.ts";
import type { AppRecord, VmRecord, EnvRecord } from "../src/types.ts";

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

function makePr(o: Partial<OpenPr> & { number: number }): OpenPr {
  return {
    headRef: `feature/pr-${o.number}`,
    headSha: `sha${o.number}${"0".repeat(36 - String(o.number).length)}`,
    ...o,
  };
}

/** Build a fake EnvRecord to seed into the store (prod-shape). */
function makeEnvRecord(
  vmId: string,
  appName: string,
  branch: string,
  lastDeployedSha: string,
  prNumber?: number,
): EnvRecord {
  const safeBranch = branch.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 40);
  const name = `${appName}-${safeBranch}`.slice(0, 63);
  return {
    id: `env-${branch}`,
    vmId,
    appName,
    branch,
    name,
    port: 3100,
    vhost: `${name}.samo.cat`,
    dbBackend: "template",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastDeployedSha,
    ...(prNumber !== undefined ? { prNumber } : {}),
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
// Fake dep factories
// ---------------------------------------------------------------------------

/**
 * A fake ensurePreview that writes the EnvRecord into the SAME envStore,
 * mirroring the prod-shape so SHA-compare works on subsequent calls.
 * Also stamps prNumber onto the EnvRecord to match prod shape (trigger.ts
 * upserts {…rec, lastDeployedSha, prNumber} after calling runEnvCreate).
 */
function makeFakeEnsurePreview(
  envStore: EnvStore,
  vm: VmRecord,
  outcome: "ok" | "failed" = "ok",
): {
  ensurePreview: PrPreviewDeps["ensurePreview"];
  calls: Array<{ vm: string; app: string; branch: string; headSha: string; prNumber: number }>;
} {
  const calls: Array<{ vm: string; app: string; branch: string; headSha: string; prNumber: number }> = [];
  const ensurePreview = async (args: { vm: string; app: string; branch: string; headSha: string; prNumber: number }): Promise<EnsurePreviewResult> => {
    calls.push({ ...args });
    if (outcome === "failed") {
      return { vhost: "", outcome: "failed", lastDeployedSha: args.headSha };
    }
    // Write EnvRecord to the shared store (prod shape) so sha-compare works.
    // Stamp prNumber so the reap guard (env.prNumber !== undefined) works.
    const rec = makeEnvRecord(vm.id, args.app, args.branch, args.headSha, args.prNumber);
    envStore.upsert(rec);
    return { vhost: rec.vhost, outcome: "ok", lastDeployedSha: args.headSha };
  };
  return { ensurePreview, calls };
}

function makeFakeUpsertPrComment(): {
  upsertPrComment: PrPreviewDeps["upsertPrComment"];
  calls: Array<{ repo: string; prNumber: number; marker: string; body: string }>;
} {
  const calls: Array<{ repo: string; prNumber: number; marker: string; body: string }> = [];
  const upsertPrComment = async (repo: string, prNumber: number, marker: string, body: string): Promise<void> => {
    calls.push({ repo, prNumber, marker, body });
  };
  return { upsertPrComment, calls };
}

function makeFakeReapPreview(): {
  reapPreview: PrPreviewDeps["reapPreview"];
  calls: Array<{ vm: string; app: string; branch: string }>;
} {
  const calls: Array<{ vm: string; app: string; branch: string }> = [];
  const reapPreview = async (args: { vm: string; app: string; branch: string }): Promise<void> => {
    calls.push({ ...args });
  };
  return { reapPreview, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPrPreviewPass", () => {
  let dir: string;
  let envStore: EnvStore;
  const vm = makeVm();
  const app = makeApp();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-prpreview-"));
    envStore = new EnvStore(join(dir, "envs.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // ---------------------------------------------------------------------------
  // Case 1: PR open, no env → ensurePreview called once; comment posted; action=created
  // ---------------------------------------------------------------------------
  test("pr-1 — open PR, no existing env: ensurePreview called once; comment posted; action=created", async () => {
    const pr = makePr({ number: 42, headRef: "feature/my-branch", headSha: "sha-abc123" });
    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment, calls: commentCalls } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    };

    const c = capture();
    const summary: PrPreviewSummary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    // ensurePreview called once with correct args
    expect(ensureCalls.length).toBe(1);
    expect(ensureCalls[0]!.branch).toBe("feature/my-branch");
    expect(ensureCalls[0]!.headSha).toBe("sha-abc123");

    // comment posted once
    expect(commentCalls.length).toBe(1);
    expect(commentCalls[0]!.prNumber).toBe(42);
    expect(commentCalls[0]!.marker).toBe(PR_PREVIEW_COMMENT_MARKER);
    // body includes marker and url
    expect(commentCalls[0]!.body).toContain(PR_PREVIEW_COMMENT_MARKER);
    expect(commentCalls[0]!.body).toContain("https://");

    // result
    const result = summary.results.find((r) => r.prNumber === 42);
    expect(result).toBeDefined();
    expect(result!.action).toBe("created");
    expect(result!.url).toContain("https://");

    // counters
    expect(summary.openPrs).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Case 2: PR push (sha changed) → ensurePreview called (redeploy); comment upserted; action=redeployed
  // ---------------------------------------------------------------------------
  test("pr-2 — PR push (sha changed): ensurePreview called; comment upserted; action=redeployed", async () => {
    const branch = "feature/my-branch";
    const oldSha = "sha-old-0000000000000000000000000000";
    const newSha = "sha-new-1111111111111111111111111111";
    const pr = makePr({ number: 7, headRef: branch, headSha: newSha });

    // Seed env with OLD sha
    const existingEnv = makeEnvRecord(vm.id, app.name, branch, oldSha);
    envStore.upsert(existingEnv);

    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment, calls: commentCalls } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    expect(ensureCalls.length).toBe(1);
    expect(commentCalls.length).toBe(1);

    const result = summary.results.find((r) => r.prNumber === 7);
    expect(result!.action).toBe("redeployed");
  });

  // ---------------------------------------------------------------------------
  // Case 3: unchanged (sha same) → ensurePreview NOT called; comment NOT posted; url present
  // ---------------------------------------------------------------------------
  test("pr-3 — unchanged (sha same): ensurePreview NOT called; comment NOT posted; action=unchanged; url present", async () => {
    const branch = "feature/stable";
    const sha = "sha-stable-00000000000000000000000000";
    const pr = makePr({ number: 5, headRef: branch, headSha: sha });

    // Seed env with the SAME sha
    const existingEnv = makeEnvRecord(vm.id, app.name, branch, sha);
    envStore.upsert(existingEnv);

    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment, calls: commentCalls } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    // MUST NOT call ensurePreview or upsertPrComment
    expect(ensureCalls.length).toBe(0);
    expect(commentCalls.length).toBe(0);

    const result = summary.results.find((r) => r.prNumber === 5);
    expect(result!.action).toBe("unchanged");
    expect(result!.url).toContain("https://");
  });

  // ---------------------------------------------------------------------------
  // Case 4: slash branch names preserved byte-for-byte
  // ---------------------------------------------------------------------------
  test("pr-4 — slash branch 'preview/pink-background' passed byte-for-byte to ensurePreview", async () => {
    const pr = makePr({ number: 99, headRef: "preview/pink-background", headSha: "sha-pink-0000000000000000000000000" });

    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    await runPrPreviewPass(app, vm, deps, c.out, c.err);

    expect(ensureCalls.length).toBe(1);
    expect(ensureCalls[0]!.branch).toBe("preview/pink-background");
  });

  // ---------------------------------------------------------------------------
  // Case 5: cap — 25 open PRs → only first MAX_PR_PREVIEWS_PER_CYCLE ensured; warning emitted
  // ---------------------------------------------------------------------------
  test(`pr-5 — ${25} open PRs: ensurePreview called at most MAX_PR_PREVIEWS_PER_CYCLE (${MAX_PR_PREVIEWS_PER_CYCLE}); warning emitted`, async () => {
    const prs: OpenPr[] = Array.from({ length: 25 }, (_, i) =>
      makePr({ number: i + 1, headRef: `feature/pr-${i + 1}`, headSha: `sha${i + 1}${"0".repeat(35)}` }),
    );

    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => prs,
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    // cap applied
    expect(ensureCalls.length).toBeLessThanOrEqual(MAX_PR_PREVIEWS_PER_CYCLE);

    // warning emitted via err
    expect(c.e).toContain(String(MAX_PR_PREVIEWS_PER_CYCLE));

    // openPrs count is the total (pre-cap)
    expect(summary.openPrs).toBe(25);
  });

  // ---------------------------------------------------------------------------
  // Case 6: closed-PR reap — env for branch not in open set → reapPreview called
  // ---------------------------------------------------------------------------
  test("pr-6 — closed PR branch in store: reapPreview called once; guarded against double-reap", async () => {
    const oldBranch = "old/feature";
    // Seed an env for a closed branch — prNumber set because this was created
    // by the PR-preview pass (prod shape: only PR-managed envs are reap-eligible).
    const staleEnv = makeEnvRecord(vm.id, app.name, oldBranch, "sha-stale", 77);
    envStore.upsert(staleEnv);

    // Current open PRs do NOT include oldBranch
    const pr = makePr({ number: 1, headRef: "feature/current", headSha: "sha-current-0000000000000000000000" });

    const { ensurePreview } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment } = makeFakeUpsertPrComment();
    const { reapPreview, calls: reapCalls } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    // reapPreview called once for the stale branch
    expect(reapCalls.length).toBe(1);
    expect(reapCalls[0]!.branch).toBe(oldBranch);

    // result includes a reaped entry
    const reaped = summary.results.find((r) => r.action === "reaped");
    expect(reaped).toBeDefined();
    expect(reaped!.branch).toBe(oldBranch);

    // Second pass (after reap): reapPreview NOT called again (existence guard)
    // Simulate the reap having removed the record
    envStore.remove(vm.id, app.name, oldBranch);

    const { reapPreview: reapPreview2, calls: reapCalls2 } = makeFakeReapPreview();
    const deps2: PrPreviewDeps = {
      ...deps,
      reapPreview: reapPreview2,
      // Same envStore (now without the stale record)
    };

    const c2 = capture();
    await runPrPreviewPass(app, vm, deps2, c2.out, c2.err);

    // NOT called again because existence guard: envStore.get returns undefined
    expect(reapCalls2.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Case 7: isolation — ensurePreview throws for PR #1 but PR #2 still processed
  // ---------------------------------------------------------------------------
  test("pr-7 — ensurePreview throws for PR #1: action=error; PR #2 still processed; action=created", async () => {
    const pr1 = makePr({ number: 1, headRef: "feature/bad", headSha: "sha-bad-00000000000000000000000000" });
    const pr2 = makePr({ number: 2, headRef: "feature/good", headSha: "sha-good-0000000000000000000000000" });

    let callCount = 0;
    const throwingEnsure = async (args: { vm: string; app: string; branch: string; headSha: string; prNumber: number }): Promise<EnsurePreviewResult> => {
      callCount++;
      if (args.branch === "feature/bad") throw new Error("SSH timeout");
      const rec = makeEnvRecord(vm.id, args.app, args.branch, args.headSha, args.prNumber);
      envStore.upsert(rec);
      return { vhost: rec.vhost, outcome: "ok", lastDeployedSha: args.headSha };
    };

    const { upsertPrComment, calls: commentCalls } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr1, pr2],
      ensurePreview: throwingEnsure,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    const r1 = summary.results.find((r) => r.prNumber === 1);
    const r2 = summary.results.find((r) => r.prNumber === 2);

    expect(r1!.action).toBe("error");
    expect(r1!.error).toContain("SSH timeout");

    expect(r2!.action).toBe("created");

    // comment posted for PR #2 (not PR #1)
    expect(commentCalls.some((c) => c.prNumber === 2)).toBe(true);
    expect(commentCalls.some((c) => c.prNumber === 1)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Case 8: sequential create-then-unchanged — fake writes EnvRecord so sha-compare works
  // ---------------------------------------------------------------------------
  test("pr-8 — sequential passes: first pass creates env (sha written to store); second pass detects unchanged", async () => {
    const pr = makePr({ number: 10, headRef: "feature/persistent", headSha: "sha-persistent-0000000000000000000" });

    const { ensurePreview, calls: ensureCalls } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment, calls: commentCalls } = makeFakeUpsertPrComment();
    const { reapPreview } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [pr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    // First pass: no env yet → create
    const c1 = capture();
    const summary1 = await runPrPreviewPass(app, vm, deps, c1.out, c1.err);
    const r1 = summary1.results.find((r) => r.prNumber === 10);
    expect(r1!.action).toBe("created");
    expect(ensureCalls.length).toBe(1);

    // Second pass: same PR, same sha → unchanged (ensurePreview NOT called again)
    const c2 = capture();
    const summary2 = await runPrPreviewPass(app, vm, deps, c2.out, c2.err);
    const r2 = summary2.results.find((r) => r.prNumber === 10);
    expect(r2!.action).toBe("unchanged");
    // ensureCalls still 1 — NOT called the second time
    expect(ensureCalls.length).toBe(1);
    // upsertPrComment also not called the second time
    // (first call at pass 1 = 1, second pass should not add)
    const commentsBefore = commentCalls.filter((c) => c.prNumber === 10).length;
    expect(commentsBefore).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Case 9: closed-PR reap NEVER touches a manually-created env (prNumber undefined)
  //
  // Setup: TWO envs in the store for the same (vm, app), neither branch is in the
  // open-PR set:
  //   - prEnv: prNumber=42, branch="feature/closed-pr" — WAS created by the
  //     PR-preview pass → MUST be reaped.
  //   - demoEnv: prNumber=undefined, branch="demo/red-login" — manually-created
  //     demo preview → MUST NOT be reaped (ever).
  //
  // The current implementation (no prNumber guard) would reap BOTH.
  // After the fix, only the PR-managed env is reaped.
  // ---------------------------------------------------------------------------
  test("pr-9 — closed-PR reap NEVER touches a manually-created env (prNumber undefined)", async () => {
    const prBranch = "feature/closed-pr";
    const demoBranch = "demo/red-login";

    // PR-managed env (prNumber set) — branch NOT in open-PR set → should be reaped
    const prEnv = makeEnvRecord(vm.id, app.name, prBranch, "sha-pr-old", 42);
    envStore.upsert(prEnv);

    // Demo env (prNumber NOT set) — manually-created; branch NOT in open-PR set
    // → MUST be kept regardless
    const demoEnv = makeEnvRecord(vm.id, app.name, demoBranch, "sha-demo");
    envStore.upsert(demoEnv);

    // Open PRs: a different PR, so neither stale branch is in the open set
    const openPr = makePr({ number: 99, headRef: "feature/other", headSha: "sha-other-000000000000000000000000" });

    const { ensurePreview } = makeFakeEnsurePreview(envStore, vm);
    const { upsertPrComment } = makeFakeUpsertPrComment();
    const { reapPreview, calls: reapCalls } = makeFakeReapPreview();

    const deps: PrPreviewDeps = {
      listOpenPrs: async () => [openPr],
      ensurePreview,
      upsertPrComment,
      reapPreview,
      envStore,
      now: () => new Date(),
    };

    const c = capture();
    const summary = await runPrPreviewPass(app, vm, deps, c.out, c.err);

    // reapPreview called EXACTLY ONCE — only for the PR-managed branch
    expect(reapCalls.length).toBe(1);
    expect(reapCalls[0]!.branch).toBe(prBranch);

    // The demo branch is NEVER passed to reapPreview
    expect(reapCalls.some((r) => r.branch === demoBranch)).toBe(false);

    // summary has one reaped result (the PR env) — demo is silent (not listed as reaped)
    const reaped = summary.results.filter((r) => r.action === "reaped");
    expect(reaped.length).toBe(1);
    expect(reaped[0]!.branch).toBe(prBranch);
  });
});
