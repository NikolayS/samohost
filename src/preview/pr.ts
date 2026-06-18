/**
 * PR Preview auto-comment pass (SPEC-DELTA: PR previews).
 *
 * For each registered app, enumerates OPEN PRs and ensures a preview env
 * exists & is deployed at the PR head SHA. Posts or updates exactly ONE
 * comment per PR with the clickable preview URL. Reaps previews for PRs that
 * are no longer open.
 *
 * POLICY: PR previews are deployed at the PR HEAD regardless of CI status —
 * DELIBERATE. checkCiGreen is NOT consulted here. Rationale: the comment
 * conveys a preview URL (a friction-killer for non-technical clients / bot PRs
 * that may have no CI). The existing main→prod deploy path keeps its CI gate.
 *
 * Same-repo PRs only: the PROD listOpenPrs impl filters OUT cross-repository
 * (fork) PRs (gh `isCrossRepository:true`) so fork branch-name collisions
 * cannot shadow same-repo envs. The filtering is in the prod dep implementation;
 * runPrPreviewPass takes whatever listOpenPrs returns.
 */

import type { AppRecord, VmRecord } from "../types.ts";
import type { EnvStore } from "../state/envs.ts";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * HTML comment marker embedded at the start of every preview comment body.
 * Used to locate the existing comment for upsert (find-by-marker).
 */
export const PR_PREVIEW_COMMENT_MARKER = "<!-- samohost-preview -->";

/**
 * Maximum number of open PRs processed in a single pass.
 * SAFETY CAP — not a target. Design the natural termination signal first;
 * use the cap only as a backstop. When the open-PR count exceeds this value,
 * a single warning is emitted via err and only the first N are processed.
 */
export const MAX_PR_PREVIEWS_PER_CYCLE = 20;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single open PR from the GitHub API (normalized). */
export interface OpenPr {
  number: number;
  /** Raw headRef (slashes preserved byte-for-byte). */
  headRef: string;
  headSha: string;
}

/** Result for a single PR in one pass. */
export interface PrPreviewResult {
  prNumber: number;
  /** RAW headRef (slashes preserved). */
  branch: string;
  /** https://<vhost> when a preview exists/was created. */
  url?: string;
  action: "created" | "redeployed" | "unchanged" | "failed" | "reaped" | "error";
  error?: string;
}

/** Summary of one pass across all open (and newly-reaped closed) PRs for an app. */
export interface PrPreviewSummary {
  app: string;
  vm: string;
  /** Count of open PRs seen (pre-cap). */
  openPrs: number;
  results: PrPreviewResult[];
}

/** Return value of ensurePreview. */
export interface EnsurePreviewResult {
  vhost: string;
  outcome: "ok" | "failed";
  lastDeployedSha: string;
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface PrPreviewDeps {
  /**
   * List OPEN PRs for the given repo. Prod impl uses `gh pr list --state open`
   * and filters out cross-repository (fork) PRs.
   */
  listOpenPrs: (repo: string) => Promise<OpenPr[]>;

  /**
   * Create or redeploy the preview env for (vm, app, branch) at the current
   * branch tip, recording lastDeployedSha=headSha on the EnvRecord.
   *
   * IMPORTANT: the prod impl wraps runEnvCreate (db default "template",
   * DEFAULT_PREVIEW_DOMAIN) and reads the persisted EnvRecord back from envStore
   * to record lastDeployedSha — so the unit-test fake MUST ALSO upsert an
   * EnvRecord into the SAME injected envStore (matching prod write shape) for
   * the SHA-compare in subsequent cycles to behave identically.
   */
  ensurePreview: (args: {
    vm: string;
    app: string;
    branch: string;
    headSha: string;
  }) => Promise<EnsurePreviewResult>;

  /**
   * Find a comment containing `marker` on the PR → PATCH it; else POST a new
   * comment. Guarantees exactly ONE comment per PR containing the marker.
   */
  upsertPrComment: (
    repo: string,
    prNumber: number,
    marker: string,
    body: string,
  ) => Promise<void>;

  /**
   * Reap the preview env for a closed PR's branch. Guarded by caller via
   * envStore.get existence check. Must be idempotent: if the env record is
   * already gone (e.g. gc ran first in the same cycle), it should no-op
   * gracefully.
   *
   * Guard vs gc double-reap: the existence guard (envStore.get !== undefined)
   * + idempotent destroy covers the case where gc already reaped the env
   * before this pass reaches the reap step.
   */
  reapPreview: (args: { vm: string; app: string; branch: string }) => Promise<void>;

  /** Shared env store — read for SHA-compare; written by ensurePreview fake/prod. */
  envStore: EnvStore;

  /** Clock for audit purposes (currently unused in output; reserved). */
  now: () => Date;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Build the comment body for a preview URL.
 * The marker MUST be first so find-by-marker is robust regardless of body edits.
 */
function buildCommentBody(url: string): string {
  return `${PR_PREVIEW_COMMENT_MARKER}\n🔎 **Preview:** ${url} — auto-updates on push.`;
}

/**
 * Perform ONE idempotent PR-preview pass for a single (app, vm) pair.
 *
 * Algorithm:
 * 1. listOpenPrs(app.repo) → capture pre-cap count.
 * 2. Cap to MAX_PR_PREVIEWS_PER_CYCLE; emit warning if truncated.
 * 3. For each capped PR (per-PR try/catch — one PR's throw → error, continue):
 *    a. branch = pr.headRef (RAW, slashes preserved).
 *    b. existing = envStore.get(vm.id, app.name, branch).
 *    c. needDeploy = existing===undefined || existing.lastDeployedSha !== pr.headSha.
 *    d. If needDeploy: ensurePreview → url → action=created|redeployed|failed.
 *       Then upsertPrComment (state changed).
 *    e. If NOT needDeploy (unchanged): url from existing.vhost; NO ensurePreview
 *       call; NO upsertPrComment call (avoid API spam on stable PRs).
 * 4. CLOSED-PR REAP: openSet = Set of capped headRefs (cap-scoped by design).
 *    For every env in envStore.listFor(vm.id, app.name): if branch NOT in
 *    openSet AND envStore.get(...) !== undefined (existence guard) →
 *    reapPreview; push reaped result. Per-env try/catch.
 */
export async function runPrPreviewPass(
  app: AppRecord,
  vm: VmRecord,
  deps: PrPreviewDeps,
  _out: (s: string) => void,
  err: (s: string) => void,
): Promise<PrPreviewSummary> {
  const allOpenPrs = await deps.listOpenPrs(app.repo);
  const totalOpen = allOpenPrs.length;

  // Cap
  let prsToProcess: OpenPr[];
  if (allOpenPrs.length > MAX_PR_PREVIEWS_PER_CYCLE) {
    err(
      `samohost: pr-preview: ${app.name} has ${allOpenPrs.length} open PRs — ` +
        `processing only the first ${MAX_PR_PREVIEWS_PER_CYCLE} (safety cap); ` +
        `remaining ${allOpenPrs.length - MAX_PR_PREVIEWS_PER_CYCLE} skipped this cycle`,
    );
    prsToProcess = allOpenPrs.slice(0, MAX_PR_PREVIEWS_PER_CYCLE);
  } else {
    prsToProcess = allOpenPrs;
  }

  const results: PrPreviewResult[] = [];

  // Per-PR processing
  for (const pr of prsToProcess) {
    try {
      const branch = pr.headRef; // RAW — slashes preserved byte-for-byte

      const existing = deps.envStore.get(vm.id, app.name, branch);
      const needDeploy =
        existing === undefined || existing.lastDeployedSha !== pr.headSha;

      if (needDeploy) {
        const r = await deps.ensurePreview({
          vm: vm.name,
          app: app.name,
          branch,
          headSha: pr.headSha,
        });

        const url = r.outcome === "ok" ? `https://${r.vhost}` : undefined;

        let action: PrPreviewResult["action"];
        if (r.outcome !== "ok") {
          action = "failed";
        } else if (existing === undefined) {
          action = "created";
        } else {
          action = "redeployed";
        }

        // Post/update comment when state changed (created or redeployed)
        if (action !== "failed" && url !== undefined) {
          const body = buildCommentBody(url);
          await deps.upsertPrComment(app.repo, pr.number, PR_PREVIEW_COMMENT_MARKER, body);
        }

        results.push({ prNumber: pr.number, branch, url, action });
      } else {
        // Unchanged: url from existing env record; no API calls
        const url = `https://${existing!.vhost}`;
        results.push({ prNumber: pr.number, branch, url, action: "unchanged" });
      }
    } catch (e) {
      results.push({
        prNumber: pr.number,
        branch: pr.headRef,
        action: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // CLOSED-PR REAP
  // openSet is scoped to the capped set (by design — documented; acceptable).
  const openSet = new Set(prsToProcess.map((p) => p.headRef));

  const allEnvs = deps.envStore.listFor(vm.id, app.name);
  for (const env of allEnvs) {
    if (openSet.has(env.branch)) continue; // branch is open — keep

    // Existence guard: check again to avoid double-reap (gc may have removed it)
    if (deps.envStore.get(vm.id, app.name, env.branch) === undefined) continue;

    try {
      await deps.reapPreview({ vm: vm.name, app: app.name, branch: env.branch });
      results.push({ prNumber: -1, branch: env.branch, action: "reaped" });
    } catch (e) {
      results.push({
        prNumber: -1,
        branch: env.branch,
        action: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    app: app.name,
    vm: vm.name,
    openPrs: totalOpen,
    results,
  };
}
