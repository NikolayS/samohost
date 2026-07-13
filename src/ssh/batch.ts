/**
 * Batched per-VM SSH cycle runner (preview-pipeline budget fix).
 *
 * ROOT CAUSE: the trigger's heal pass AND the PR-preview pass each open
 * separate SSH connections to the same VM. With a connection budget of 2
 * attempts per 600 s (fail2ban-safe), a VM with ≥ 2 PR preview envs
 * exhausts the budget before all creates complete — subsequent work-items
 * throw BudgetExceededError and the preview never converges.
 *
 * FIX: `runBatchedVmCycle` collects ALL per-VM SSH work for one trigger
 * cycle (heal re-creates + PR env creates/updates) and issues it as a
 * SINGLE `bash -s` remote call. The connection budget is therefore consumed
 * ONCE per VM per cycle regardless of N previews.
 *
 * The combined bash script uses a per-section sentinel wrapper so the
 * caller can splice the combined stdout/stderr back into per-work-item
 * results using `parseBatchOutput`.
 *
 * Sentinel format (matches ENV_PHASE_PREFIX from env/script.ts):
 *   <<<SAMOHOST_BATCH:START:<id>>>>
 *   ... script output ...
 *   <<<SAMOHOST_BATCH:END:<id>>>>
 *
 * Design:
 *   - remote() is called ONCE for the entire VM's work-load.
 *   - Each work-item (dead clone re-create / PR env create) is wrapped in a
 *     sentinel block inside the combined script.
 *   - If remote() throws (e.g. BudgetExceededError, SshError), ALL work-
 *     items for that VM fail together — this is correct: if we cannot reach
 *     the VM we cannot do any work there.
 *   - Each work-item's parsed outcome is returned in `BatchWorkResult[]`.
 */

import type { VmRecord } from "../types.ts";
import type { AppRecord } from "../types.ts";
import type { EnvStore } from "../state/envs.ts";
import type { SpawnResult } from "./runner.ts";

// ---------------------------------------------------------------------------
// Batch timeout scaling
// ---------------------------------------------------------------------------

/**
 * Base SSH timeout for a batch session (covers connection overhead + minimal
 * script startup before any work items run).
 */
export const BATCH_TIMEOUT_BASE_MS = 120_000; // 2 min base

/**
 * Per-item allowance added to the base timeout. Each work item (PR build or
 * dead-clone re-create) can run the full env-create script; budgeting 2 min
 * per item ensures a single 120s wall-clock timeout does not abort a 5-item
 * batch that legitimately takes up to 10 min.
 */
export const BATCH_TIMEOUT_PER_ITEM_MS = 120_000; // 2 min per item

/**
 * Compute the SSH wall-clock timeout for a batch session with `nItems` work
 * items. Returns a value proportional to N so large batches do not time out
 * before all items complete.
 *
 * Formula: BASE + N × PER_ITEM
 *   nItems=0 → 120 s (base only, covers the probe / no-op path)
 *   nItems=1 → 240 s
 *   nItems=5 → 720 s (12 min — enough for 5 full dblab+build+restart cycles)
 *
 * The old fixed 120 s fired on nItems≥2 because a 2-item batch (each ~90s)
 * takes 180 s total but the session timed out after 120 s.
 */
export function computeBatchTimeoutMs(nItems: number): number {
  return BATCH_TIMEOUT_BASE_MS + Math.max(0, nItems) * BATCH_TIMEOUT_PER_ITEM_MS;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One unit of SSH work for a single VM cycle.
 * Either a PR env create/update or a dead clone re-create (heal).
 */
export interface BatchWorkItem {
  /** Stable ID used to correlate sentinel blocks in the combined output. */
  id: string;
  /** The bash script fragment to run (must be self-contained). */
  script: string;
}

/** Result for one BatchWorkItem after the combined SSH call. */
export interface BatchWorkResult {
  id: string;
  stdout: string;
  stderr: string;
  /** True if the item's sentinel START/END block was found in the output. */
  found: boolean;
}

/** Return type of runBatchedVmCycle. */
export interface BatchCycleResult {
  /** False if the combined SSH call itself failed (remote threw or exit!=0). */
  ok: boolean;
  /** Error from the remote() call when ok=false. */
  error?: string;
  /** Per-work-item results (empty when ok=false). */
  items: BatchWorkResult[];
  /** Raw combined stdout from the SSH session. */
  rawStdout: string;
  /** Raw combined stderr from the SSH session. */
  rawStderr: string;
}

// ---------------------------------------------------------------------------
// Sentinel helpers
// ---------------------------------------------------------------------------

const SENTINEL_START = (id: string) => `<<<SAMOHOST_BATCH:START:${id}>>>`;
const SENTINEL_END = (id: string) => `<<<SAMOHOST_BATCH:END:${id}>>>`;

/**
 * Wrap a script fragment in sentinel markers so its output can be extracted
 * from the combined output of a multi-script bash session.
 */
export function wrapScriptWithSentinels(id: string, script: string): string {
  return [
    `echo '${SENTINEL_START(id)}'`,
    script,
    `echo '${SENTINEL_END(id)}'`,
  ].join("\n");
}

/**
 * Build the combined bash -s script from an array of BatchWorkItems.
 * Each item's script is wrapped in sentinels AND a subshell ( ... ) so that
 * an `exit 1` inside one item exits only the subshell, not the parent bash
 * session.  Without the subshell a persistently broken PR build would abort
 * all subsequent items in the same batch (including heals + other PRs).
 *
 * Structure per item:
 *   set +e
 *   (
 *     echo '<<<SAMOHOST_BATCH:START:<id>>>>'
 *     <script>
 *     echo '<<<SAMOHOST_BATCH:END:<id>>>>'
 *   )
 *   set -e
 */
export function buildBatchScript(items: BatchWorkItem[]): string {
  const parts = items.map((item) => {
    const sentineled = wrapScriptWithSentinels(item.id, item.script);
    // Indent the sentineled script body one level inside the subshell.
    const indented = sentineled
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return ["set +e", "(", indented, ")", "set -e"].join("\n");
  });
  return ["#!/bin/bash", "set -euo pipefail", ...parts].join("\n\n");
}

/**
 * Parse the combined stdout/stderr from a batch SSH call back into per-item
 * sections. Each section is extracted by finding the SENTINEL_START /
 * SENTINEL_END pair for each item id.
 */
export function parseBatchOutput(
  items: BatchWorkItem[],
  rawStdout: string,
  rawStderr: string,
): BatchWorkResult[] {
  return items.map((item) => {
    const start = SENTINEL_START(item.id);
    const end = SENTINEL_END(item.id);
    const si = rawStdout.indexOf(start);
    const ei = rawStdout.indexOf(end);

    if (si === -1 || ei === -1 || si >= ei) {
      return { id: item.id, stdout: "", stderr: rawStderr, found: false };
    }

    const section = rawStdout.slice(si + start.length, ei).trim();
    return { id: item.id, stdout: section, stderr: rawStderr, found: true };
  });
}

// ---------------------------------------------------------------------------
// runBatchedVmCycle — the primary public API
// ---------------------------------------------------------------------------

/**
 * Inputs for a single VM's batch cycle.
 */
export interface BatchedVmCycleInput {
  vm: VmRecord;
  app: AppRecord;
  /** PR envs that need creating or re-deploying this cycle. */
  prs: Array<{
    branch: string;
    headSha: string;
    prNumber: number;
    /** The script to run for this PR (build + restart). */
    script?: string;
  }>;
  /** Persistent tracked-branch preview needing create/redeploy this cycle. */
  standing?: {
    branch: string;
    headSha: string;
    script?: string;
  };
  /** Dead clones that need re-creation this cycle. */
  deadClones: Array<{
    envName: string;
    cloneId: string;
    /** The script to run for this re-create. */
    script?: string;
  }>;
  envStore: EnvStore;
  /**
   * Injectable remote runner: run a script on the VM and return stdout/stderr.
   * MUST be called EXACTLY ONCE per cycle (the whole point of this module).
   */
  remote: (vm: VmRecord, script: string) => Promise<SpawnResult>;
}

/**
 * Result of a VM batch cycle.
 */
export interface BatchedVmCycleOutput {
  ok: boolean;
  error?: string;
  prResults: Array<{
    branch: string;
    prNumber: number;
    headSha: string;
    stdout: string;
    stderr: string;
    found: boolean;
  }>;
  standingResult?: {
    branch: string;
    headSha: string;
    stdout: string;
    stderr: string;
    found: boolean;
  };
  healResults: Array<{
    envName: string;
    cloneId: string;
    stdout: string;
    stderr: string;
    found: boolean;
  }>;
}

/**
 * Execute ALL per-VM SSH work for one trigger cycle in a single SSH session.
 *
 * One call to remote() regardless of how many PRs or dead clones are in scope.
 * This is the primary fix for the connection-budget exhaustion bug.
 */
export async function runBatchedVmCycle(
  input: BatchedVmCycleInput,
): Promise<BatchedVmCycleOutput> {
  const { vm, prs, standing, deadClones, remote } = input;

  // Build per-item BatchWorkItems for prs + dead clones.
  const items: BatchWorkItem[] = [];

  for (const pr of prs) {
    const id = `pr-${pr.prNumber}-${pr.branch.replace(/[^a-z0-9]/gi, "-")}`;
    // Use provided script or a placeholder if not given (callers wire real scripts).
    const script = pr.script ?? `echo "pr-preview: branch=${pr.branch} sha=${pr.headSha}"`;
    items.push({ id, script });
  }

  if (standing !== undefined) {
    const id = `standing-${standing.branch.replace(/[^a-z0-9]/gi, "-")}`;
    const script = standing.script ??
      `echo "standing-preview: branch=${standing.branch} sha=${standing.headSha}"`;
    items.push({ id, script });
  }

  for (const clone of deadClones) {
    const id = `heal-${clone.cloneId}-${clone.envName.replace(/[^a-z0-9]/gi, "-")}`;
    const script = clone.script ?? `echo "heal: env=${clone.envName} clone=${clone.cloneId}"`;
    items.push({ id, script });
  }

  // If there is no work, return early with no SSH call.
  if (items.length === 0) {
    return { ok: true, prResults: [], healResults: [] };
  }

  // Build the combined script and run it in ONE SSH session.
  const combinedScript = buildBatchScript(items);

  let raw: SpawnResult;
  try {
    // THE KEY INVARIANT: remote() is called EXACTLY ONCE per VM per cycle.
    raw = await remote(vm, combinedScript);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error,
      prResults: prs.map((pr) => ({
        branch: pr.branch,
        prNumber: pr.prNumber,
        headSha: pr.headSha,
        stdout: "",
        stderr: error,
        found: false,
      })),
      ...(standing !== undefined
        ? {
            standingResult: {
              branch: standing.branch,
              headSha: standing.headSha,
              stdout: "",
              stderr: error,
              found: false,
            },
          }
        : {}),
      healResults: deadClones.map((c) => ({
        envName: c.envName,
        cloneId: c.cloneId,
        stdout: "",
        stderr: error,
        found: false,
      })),
    };
  }

  const parsed = parseBatchOutput(items, raw.stdout, raw.stderr);
  const parsedById = new Map(parsed.map((r) => [r.id, r]));

  const prResults = prs.map((pr) => {
    const id = `pr-${pr.prNumber}-${pr.branch.replace(/[^a-z0-9]/gi, "-")}`;
    const r = parsedById.get(id);
    return {
      branch: pr.branch,
      prNumber: pr.prNumber,
      headSha: pr.headSha,
      stdout: r?.stdout ?? "",
      stderr: r?.stderr ?? raw.stderr,
      found: r?.found ?? false,
    };
  });

  const standingResult = standing === undefined
    ? undefined
    : (() => {
        const id = `standing-${standing.branch.replace(/[^a-z0-9]/gi, "-")}`;
        const r = parsedById.get(id);
        return {
          branch: standing.branch,
          headSha: standing.headSha,
          stdout: r?.stdout ?? "",
          stderr: r?.stderr ?? raw.stderr,
          found: r?.found ?? false,
        };
      })();

  const healResults = deadClones.map((clone) => {
    const id = `heal-${clone.cloneId}-${clone.envName.replace(/[^a-z0-9]/gi, "-")}`;
    const r = parsedById.get(id);
    return {
      envName: clone.envName,
      cloneId: clone.cloneId,
      stdout: r?.stdout ?? "",
      stderr: r?.stderr ?? raw.stderr,
      found: r?.found ?? false,
    };
  });

  return {
    ok: true,
    prResults,
    ...(standingResult !== undefined ? { standingResult } : {}),
    healResults,
  };
}
