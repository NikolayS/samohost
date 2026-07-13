/**
 * Persistent tracked-branch preview for release-channel apps (samohost #150).
 *
 * A standing preview is deliberately NOT PR-owned: it has no `prNumber`, so
 * closing a PR cannot reap it. Its lifecycle is declared by
 * `AppRecord.standingPreview` and its source is `AppRecord.branch`.
 */

import type { AppRecord, VmRecord } from "../types.ts";
import type { EnvStore } from "../state/envs.ts";
import type { RefResolver } from "../commands/app.ts";

export type StandingPreviewAction =
  | "created"
  | "redeployed"
  | "unchanged"
  | "failed"
  | "error";

export interface StandingPreviewResult {
  app: string;
  vm: string;
  branch: string;
  action: StandingPreviewAction;
  sha?: string;
  url?: string;
  error?: string;
}

export interface EnsureStandingPreviewResult {
  vhost: string;
  outcome: "ok" | "failed";
}

export interface StandingPreviewDeps {
  envStore: EnvStore;
  resolveRef: RefResolver;
  ensurePreview: (args: {
    vm: string;
    app: string;
    branch: string;
    headSha: string;
  }) => Promise<EnsureStandingPreviewResult>;
}

/**
 * Resolve and converge one opted-in app's stable branch preview.
 *
 * The ensure dependency owns the on-host create/redeploy and external probe.
 * It must stamp `lastDeployedSha` only after success. This orchestrator also
 * removes any stale `prNumber` ownership after success, making the standing
 * environment immune to the closed-PR reaper.
 */
export async function runStandingPreviewPass(
  app: AppRecord,
  vm: VmRecord,
  deps: StandingPreviewDeps,
): Promise<StandingPreviewResult> {
  const base = { app: app.name, vm: vm.name, branch: app.branch };

  if (app.standingPreview !== true) {
    return { ...base, action: "unchanged" };
  }

  let headSha: string;
  try {
    headSha = (await deps.resolveRef(app.repo, app.branch)).trim();
    if (headSha.length === 0) throw new Error("resolved branch SHA is empty");
  } catch (e) {
    return {
      ...base,
      action: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const existing = deps.envStore.get(vm.id, app.name, app.branch);
  if (existing?.lastDeployedSha === headSha && existing.prNumber === undefined) {
    return {
      ...base,
      action: "unchanged",
      sha: headSha,
      url: `https://${existing.vhost}`,
    };
  }

  const wasNew = existing === undefined;
  let ensured: EnsureStandingPreviewResult;
  try {
    ensured = await deps.ensurePreview({
      vm: vm.name,
      app: app.name,
      branch: app.branch,
      headSha,
    });
  } catch (e) {
    return {
      ...base,
      action: "error",
      sha: headSha,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (ensured.outcome !== "ok") {
    return {
      ...base,
      action: "failed",
      sha: headSha,
      ...(ensured.vhost.length > 0 ? { url: `https://${ensured.vhost}` } : {}),
      error: "standing preview create/redeploy or external probe failed",
    };
  }

  const stored = deps.envStore.get(vm.id, app.name, app.branch);
  if (stored === undefined || stored.lastDeployedSha !== headSha) {
    return {
      ...base,
      action: "failed",
      sha: headSha,
      error: "standing preview reported success without persisting the deployed SHA",
    };
  }

  // A branch may have existed as a PR preview before it became the standing
  // branch. Successful convergence transfers ownership away from that PR.
  if (stored.prNumber !== undefined) {
    deps.envStore.upsert({ ...stored, prNumber: undefined });
  }

  return {
    ...base,
    action: wasNew ? "created" : "redeployed",
    sha: headSha,
    url: `https://${stored.vhost}`,
  };
}
