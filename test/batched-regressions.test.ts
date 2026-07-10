/**
 * RED tests for three cross-client regressions in the batched PR-preview path
 * (samohost PR #134 follow-up) and two hardening items.
 *
 * B1 DESTRUCTIVE: a failed "gh pr list" is swallowed → openPrs=[] → the
 *   closed-PR reap loop destroys EVERY PR-managed env.  Fix: distinguish
 *   "no open PRs" from "could not fetch PRs"; on ERROR skip the app entirely.
 *
 * B2 DNS MISSING: the batched path never calls ensurePreviewDns, so new
 *   previews get no Cloudflare DNS record (525 cause).  Fix: call
 *   ensurePreviewDns for each new PR preview before the batch SSH.
 *
 * B3 PROBE BYPASSED: the batched path stamps lastDeployedSha and posts the
 *   "preview ready" comment on the sentinel alone, without verifying the
 *   public URL.  Fix: run the external HTTPS probe before stamping success.
 *
 * H4 SUBSHELL ISOLATION: each batch item must be wrapped in ( ... ) so an
 *   "exit 1" inside one item does NOT abort the whole bash session.
 *
 * H5 CAP MISSING: MAX_PR_PREVIEWS_PER_CYCLE=20 cap is not applied in the
 *   batched path.
 *
 * All tests MUST FAIL on the current branch (RED) and MUST PASS after the
 * implementation fix (GREEN).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBatchScript } from "../src/ssh/batch.ts";
import { defaultTriggerDeps, runTriggerRun } from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-b134",
    provider: "hetzner",
    providerId: "999000001",
    name: "samo-we-regtest",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 22,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "fsn1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-b134",
    vmId: "vm-b134",
    name: "regtest-app",
    repo: "Tanya301/regtest-1",
    branch: "main",
    appDir: "/opt/regtest/app",
    buildCmd: "npm run build",
    serviceUnit: "regtest-app",
    healthUrl: "http://localhost:3100/api/version",
    ...o,
  };
}

function makePrEnvRecord(branch: string, prNumber: number, o: Partial<EnvRecord> = {}): EnvRecord {
  const safeName = `regtest-app-${branch.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 63);
  return {
    id: `env-${branch}`,
    vmId: "vm-b134",
    appName: "regtest-app",
    branch,
    name: safeName,
    port: 3101,
    vhost: `${safeName}.samo.cat`,
    dbBackend: "none" as const,
    prNumber,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

/**
 * Build a success-shaped batch output for the given item id.
 * Must match the sentinel format in batch.ts.
 */
function fakeBatchSuccess(itemId: string): string {
  const phases = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"];
  const phaseLines = phases
    .flatMap((p) => [
      `<<<SAMOHOST_PHASE:${p}:start>>>`,
      `<<<SAMOHOST_PHASE:${p}:ok>>>`,
    ])
    .join("\n");
  return [
    `<<<SAMOHOST_BATCH:START:${itemId}>>>`,
    phaseLines,
    `<<<SAMOHOST_BATCH:END:${itemId}>>>`,
  ].join("\n");
}

function noop(_s: string) {}

// ---------------------------------------------------------------------------
// Shared setup/teardown
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-regressions-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
  vmStore.upsert(makeVm());
  appStore.upsert(makeApp());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// B1: failing gh pr list must NOT reap any PR-managed env
// ---------------------------------------------------------------------------

describe("B1: failed listOpenPrs must skip the app — no reap", () => {
  test("a PR-managed env survives when listOpenPrs throws (no reap)", async () => {
    // Plant a PR-managed env (prNumber set → eligible for reap when gh list fails).
    const plantedEnv = makePrEnvRecord("feat/old-pr", 42, {
      lastDeployedSha: "sha-of-old-pr",
    });
    envStore.upsert(plantedEnv);

    // Inject a listOpenPrs that simulates a gh CLI failure (e.g. auth expired).
    const ghFailure = async (_repo: string): Promise<never> => {
      throw new Error("gh pr list: HTTP 401 — token expired");
    };

    // Remote is a no-op: should never be called when listOpenPrs fails.
    const remoteCalls: string[] = [];
    const countingRemote = async (_vm: VmRecord, script: string) => {
      remoteCalls.push(script.slice(0, 40));
      return { code: 0, stdout: "", stderr: "" };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs: ghFailure,
      remote: countingRemote,
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      (s) => { outJson += s; },
      noop,
    );

    // Parse the trigger-run JSON report.
    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string; branch?: string }> }>;
    };

    // THE ASSERTION: no "reaped" entries.
    // On buggy code: listOpenPrs failure is swallowed → openPrs=[] →
    //   closed-PR reap loop runs → every PR-managed env is "reaped".
    // After fix: failure is detected → app is skipped entirely → no "reaped".
    const reapedEntries = (report.prPreviews ?? []).flatMap((s) =>
      s.results.filter((r) => r.action === "reaped"),
    );
    expect(reapedEntries).toHaveLength(0);

    // Additionally: the env record must still be in the store (not silently removed).
    const stillThere = envStore.get("vm-b134", "regtest-app", "feat/old-pr");
    expect(stillThere).toBeDefined();
    expect(stillThere?.prNumber).toBe(42);
  });

  test("listOpenPrs returning non-zero status (spawnSync path) must also skip reap", async () => {
    // This test covers the spawnSync branch (no opts.listOpenPrs injected) where
    // gh pr list returns a non-zero exit status.  In the current code:
    //   if (res.status === 0) { openPrs = parsed; }
    //   catch { /* swallowed */ }
    // A non-zero status silently leaves openPrs=[] which triggers the reap.
    //
    // After the fix, a non-zero status must also skip the app.
    //
    // We test via opts.listOpenPrs to avoid spawning real gh, but the fix
    // must cover BOTH the opts path AND the spawnSync path in production.

    const plantedEnv = makePrEnvRecord("feat/another-pr", 99, {
      lastDeployedSha: "sha-another",
    });
    envStore.upsert(plantedEnv);

    // Simulate the SILENT failure that occurs when gh pr list returns non-zero:
    // instead of throwing (opts path) it returns an empty array (after the fix,
    // a non-zero-status result must throw or be treated as an error).
    // We simulate this by injecting a function that returns [] and separately
    // rely on the test above to cover the throw path.
    //
    // The observable assertion here is the same: NO "reaped" entries when the
    // caller signals via the standard error path.
    const silentFail = async (_repo: string): Promise<never> => {
      throw new Error("gh pr list: exit 1 (non-zero status)");
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs: silentFail,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string }> }>;
    };
    const reapedEntries = (report.prPreviews ?? []).flatMap((s) =>
      s.results.filter((r) => r.action === "reaped"),
    );
    expect(reapedEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B2: ensurePreviewDns must be called for new PR previews in the batched path
// ---------------------------------------------------------------------------

describe("B2: batched path calls ensurePreviewDns for new PR previews", () => {
  test("creating a new PR preview in the batched path ensures its DNS record", async () => {
    // PR #7 — no existing env in store → new env → DNS must be ensured.
    const pr7 = { number: 7, headRef: "feat/my-pr", headSha: "abc1234def567890" };

    const listOpenPrs = async () => [pr7];

    // The batch item id for PR #7 with branch "feat/my-pr":
    //   pr-${prNumber}-${headRef.replace(/[^a-z0-9]/gi, "-")}
    //   → pr-7-feat-my-pr
    const batchItemId = "pr-7-feat-my-pr";

    // Remote: one call for the batch (no probe since heal:false).
    const remote = async (_vm: VmRecord, _script: string) => ({
      code: 0,
      stdout: fakeBatchSuccess(batchItemId),
      stderr: "",
    });

    // Spy for ensurePreviewDns.
    const dnsCalls: Array<{ vhost: string; ip: string }> = [];
    const ensurePreviewDns = async (vhost: string, ip: string): Promise<void> => {
      dnsCalls.push({ vhost, ip });
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      ensurePreviewDns,
      // Inject a passing httpProbe so the test doesn't try real curl on a fake URL.
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore,
      appStore,
      deps,
      noop,
      noop,
    );

    // THE ASSERTION: ensurePreviewDns was called at least once.
    // On buggy code: batched path never calls ensurePreviewDns → dnsCalls=[] → FAIL.
    // After fix: called with the new env's vhost and VM's IP → dnsCalls has 1 entry.
    expect(dnsCalls.length).toBeGreaterThan(0);

    // The call must use the VM's IP.
    const firstCall = dnsCalls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.ip).toBe("10.0.0.1");

    // The vhost must belong to the preview domain (samo.cat).
    expect(firstCall?.vhost).toContain(".samo.cat");
  });

  test("ensurePreviewDns is NOT called for unchanged PRs (no extra DNS calls)", async () => {
    // PR #8 already deployed at the current SHA → unchanged → no DNS call.
    const branch = "feat/existing-pr";
    const headSha = "existing-sha-1234567890";
    const existingEnv = makePrEnvRecord(branch, 8, {
      lastDeployedSha: headSha,
      vhost: "regtest-app-feat-existing-pr.samo.cat",
    });
    envStore.upsert(existingEnv);

    const listOpenPrs = async () => [
      { number: 8, headRef: branch, headSha },
    ];

    const dnsCalls: string[] = [];
    const ensurePreviewDns = async (vhost: string, _ip: string) => {
      dnsCalls.push(vhost);
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      ensurePreviewDns,
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore,
      appStore,
      deps,
      noop,
      noop,
    );

    // No DNS call for unchanged PR.
    expect(dnsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B3: external HTTPS probe must gate lastDeployedSha stamp + comment
// ---------------------------------------------------------------------------

describe("B3: batched path runs HTTPS probe before stamping success", () => {
  test("when httpProbe fails, lastDeployedSha is NOT stamped on the env record", async () => {
    const pr = { number: 5, headRef: "feat/probe-test", headSha: "probe-sha-1234567890" };
    const listOpenPrs = async () => [pr];

    const batchItemId = "pr-5-feat-probe-test";

    // Remote returns success-shaped output (the on-host script "succeeded").
    const remote = async (_vm: VmRecord, _script: string) => ({
      code: 0,
      stdout: fakeBatchSuccess(batchItemId),
      stderr: "",
    });

    // External HTTPS probe fails (e.g., TLS not yet provisioned, DNS not propagated).
    let probeCalled = false;
    const httpProbe = async (_url: string) => {
      probeCalled = true;
      return { status: 502, ok: false };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      httpProbe,
      // No-op sleep: avoid 8 × 5s retry waits in unit test.
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore,
      appStore,
      deps,
      noop,
      noop,
    );

    // THE ASSERTION 1: the probe must have been called.
    // On buggy code: no probe → probeCalled=false → FAIL (if we assert true).
    // After fix: probe is called → probeCalled=true → PASS.
    expect(probeCalled).toBe(true);

    // THE ASSERTION 2: lastDeployedSha must NOT be stamped when probe fails.
    // On buggy code: no probe → lastDeployedSha IS stamped → FAIL.
    // After fix: probe fails → no stamp → lastDeployedSha is undefined → PASS.
    const rec = envStore.get("vm-b134", "regtest-app", pr.headRef);
    expect(rec).toBeDefined(); // placeholder record was upserted in Phase 3
    expect(rec?.lastDeployedSha).toBeUndefined();
  });

  test("when httpProbe succeeds, lastDeployedSha IS stamped on the env record", async () => {
    const pr = { number: 6, headRef: "feat/probe-ok", headSha: "probe-ok-sha-1234567890" };
    const listOpenPrs = async () => [pr];

    const batchItemId = "pr-6-feat-probe-ok";

    const remote = async (_vm: VmRecord, _script: string) => ({
      code: 0,
      stdout: fakeBatchSuccess(batchItemId),
      stderr: "",
    });

    // Probe succeeds immediately.
    const httpProbe = async (_url: string) => ({ status: 200, ok: true });

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      httpProbe,
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore,
      appStore,
      deps,
      noop,
      noop,
    );

    // When probe succeeds, lastDeployedSha IS stamped.
    const rec = envStore.get("vm-b134", "regtest-app", pr.headRef);
    expect(rec).toBeDefined();
    expect(rec?.lastDeployedSha).toBe(pr.headSha);
  });

  test("when httpProbe fails, no preview-ready comment is attempted", async () => {
    // If the comment-posting machinery runs, it would call spawnSync("gh", ...).
    // We verify indirectly: the JSON report should NOT show action=created/redeployed
    // for an item whose probe failed — it should show action=failed.
    const pr = { number: 9, headRef: "feat/no-comment-on-probe-fail", headSha: "sha-no-comment" };
    const listOpenPrs = async () => [pr];

    const batchItemId = "pr-9-feat-no-comment-on-probe-fail";

    const remote = async (_vm: VmRecord, _script: string) => ({
      code: 0,
      stdout: fakeBatchSuccess(batchItemId),
      stderr: "",
    });

    const httpProbe = async (_url: string) => ({ status: 503, ok: false });

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      httpProbe,
      sleep: async (_ms: number) => {},
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore,
      appStore,
      deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string; prNumber: number }> }>;
    };

    // The PR result should NOT be "created" or "redeployed" when probe failed.
    // On buggy code: no probe → action="created" → FAIL.
    // After fix: probe fails → action="failed" → PASS.
    const prResult = (report.prPreviews ?? [])
      .flatMap((s) => s.results)
      .find((r) => r.prNumber === pr.number);

    expect(prResult).toBeDefined();
    // Should NOT report success when external probe says the URL is unreachable.
    expect(prResult?.action).not.toBe("created");
    expect(prResult?.action).not.toBe("redeployed");
  });
});

// ---------------------------------------------------------------------------
// H4: each batch item must be subshell-isolated (exit 1 in one != whole-abort)
// ---------------------------------------------------------------------------

describe("H4: buildBatchScript wraps each item in a subshell", () => {
  test("each item in the batch script is wrapped in ( ... ) subshell", () => {
    const script = buildBatchScript([
      { id: "item-a", script: "echo hello-a" },
      { id: "item-b", script: "exit 1" },
      { id: "item-c", script: "echo hello-c" },
    ]);

    // THE ASSERTION: the combined script must use subshells so that item-b's
    // "exit 1" does NOT abort the bash session and item-c still runs.
    //
    // On buggy code: `set +e` ... `set -e` only, no subshells → "exit 1" kills
    //   the parent bash process → item-c sentinel never appears → FAIL.
    // After fix: each item is wrapped in `( ... )` so "exit 1" in item-b only
    //   exits the subshell → item-c still runs → PASS.

    // Check that the script contains subshell opening for each item.
    // The exact format after the fix: each item wrapped like:
    //   set +e
    //   (
    //     echo '<<<SAMOHOST_BATCH:START:item-a>>>'
    //     ...
    //     echo '<<<SAMOHOST_BATCH:END:item-a>>>'
    //   )
    //   set -e
    //
    // We check for the presence of `(\n` or `( ` (subshell open) before each
    // sentinel START marker to confirm wrapping.

    // Find the sentinel for item-b (the exit-1 item).
    const startB = "<<<SAMOHOST_BATCH:START:item-b>>>";
    const posB = script.indexOf(startB);
    expect(posB).toBeGreaterThan(-1);

    // There must be a `(` somewhere BEFORE the START sentinel that represents
    // the subshell opening for item-b.
    // We look in the 100 chars preceding the sentinel to keep the assertion local.
    const contextBeforeB = script.slice(Math.max(0, posB - 100), posB);
    expect(contextBeforeB).toMatch(/\(\s*\n/); // opening paren followed by newline

    // Also verify item-c's sentinel appears AFTER item-b in the script
    // (the structure test — the ORDER must be maintained).
    const startC = "<<<SAMOHOST_BATCH:START:item-c>>>";
    const posC = script.indexOf(startC);
    expect(posC).toBeGreaterThan(posB);
  });

  test("buildBatchScript produces parseable output even when one item would exit", () => {
    // Structural test: the script must produce parseBatchOutput-compatible output
    // even when one item fails.  We do not run bash here; we verify the TEXT
    // structure contains closing subshell `)` after each item's END sentinel.

    const script = buildBatchScript([
      { id: "good-item", script: "echo ok" },
      { id: "bad-item", script: "exit 1" },
    ]);

    // Each item must have a matching `)` close after the END sentinel.
    const endGood = "<<<SAMOHOST_BATCH:END:good-item>>>";
    const posEndGood = script.indexOf(endGood);
    expect(posEndGood).toBeGreaterThan(-1);

    // In the 50 chars after the END echo line, there must be a `)` closing the subshell.
    const afterGood = script.slice(posEndGood, posEndGood + 100);
    expect(afterGood).toMatch(/\)\s*\n/); // closing paren followed by newline
  });
});

// ---------------------------------------------------------------------------
// H5: MAX_PR_PREVIEWS_PER_CYCLE cap must be applied in the batched path
// ---------------------------------------------------------------------------

describe("H5: batched path applies MAX_PR_PREVIEWS_PER_CYCLE cap", () => {
  test("when > 20 open PRs exist, only first 20 are processed and a warning is emitted", async () => {
    // 25 open PRs — all new (no existing envs).
    const twentyFivePrs = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      headRef: `feat/pr-${i + 1}`,
      headSha: `sha-pr-${i + 1}`,
    }));

    const listOpenPrs = async () => twentyFivePrs;

    // Remote: return success for each item in whatever batch arrives.
    // We track how many unique PR branches appear in the combined batch script
    // to count how many were actually built as work items.
    let batchedPrCount = 0;
    const remote = async (_vm: VmRecord, script: string) => {
      // Count SAMOHOST_BATCH:START occurrences (one per PR work item).
      const matches = script.match(/<<<SAMOHOST_BATCH:START:/g);
      batchedPrCount = matches ? matches.length : 0;
      // Return success sentinels for all items that appeared (even though they're
      // not all stamped — we just want the batch to process without errors).
      return { code: 0, stdout: "", stderr: "" };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      // No-op sleep and trivially-passing probe to avoid network/timer delays.
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    // Capture process.stderr to verify the cap warning (batchedVmCycle writes
    // cap warnings directly to process.stderr, not via the err() callback).
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrLines: string[] = [];
    process.stderr.write = (msg: string | Uint8Array, ..._rest: unknown[]): boolean => {
      stderrLines.push(typeof msg === "string" ? msg : "");
      return origStderrWrite(msg);
    };

    try {
      await runTriggerRun(
        { prPreviews: true, heal: false, dryRun: false },
        { json: false },
        vmStore,
        appStore,
        deps,
        noop,
        noop,
      );
    } finally {
      process.stderr.write = origStderrWrite;
    }

    // THE ASSERTION 1: at most 20 PRs should be turned into batch work items.
    // On buggy code: all 25 appear in the script → batchedPrCount=25 → FAIL.
    // After fix: cap applied → batchedPrCount <= 20 → PASS.
    expect(batchedPrCount).toBeLessThanOrEqual(20);

    // THE ASSERTION 2: a cap warning must appear in stderr.
    const capWarning = stderrLines.find(
      (l) => l.includes("25") && (l.includes("20") || l.includes("cap") || l.includes("safety")),
    );
    expect(capWarning).toBeDefined();
  });

  test("when <= 20 open PRs exist, all are processed (no spurious cap)", async () => {
    // Exactly 3 PRs — all should be processed without a cap warning.
    const threePrs = [
      { number: 1, headRef: "feat/pr-1", headSha: "sha-1" },
      { number: 2, headRef: "feat/pr-2", headSha: "sha-2" },
      { number: 3, headRef: "feat/pr-3", headSha: "sha-3" },
    ];

    const listOpenPrs = async () => threePrs;

    let batchedCount = 0;
    const remote = async (_vm: VmRecord, script: string) => {
      const matches = script.match(/<<<SAMOHOST_BATCH:START:/g);
      batchedCount = matches ? matches.length : 0;
      return { code: 0, stdout: "", stderr: "" };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore,
      appStore,
      deps,
      noop,
      noop,
    );

    // All 3 should be included (no cap triggered for <=20).
    expect(batchedCount).toBe(3);
  });
});
