/**
 * CI-green gate (SPEC-DELTA §3 "CI-green gate before deploy").
 *
 * Queries the GitHub Actions API for workflow runs at a given commit SHA and
 * reduces them to a single decision, mirroring deploy.sh's gate:
 *
 *     failure / cancelled  → 'failure'  → REFUSE (never deploy red)
 *     in_progress / queued → 'pending'  → WAIT
 *     no run found         → 'none'     → WAIT (run likely still queued)
 *     success              → 'success'  → GO
 *
 * The token is read from the environment AT CALL TIME (GH_TOKEN, then
 * GITHUB_TOKEN). It is never stored on any record and never logged. `fetch` is
 * injected so the decision logic is unit-tested fully offline.
 */
import {
  CANONICAL_RELEASE_CI_WORKFLOW,
  CANONICAL_RELEASE_CI_WORKFLOW_ID,
} from "./release-policy.ts";

export type CiStatus = "success" | "pending" | "failure" | "none";

export interface CiGateDeps {
  /** Injected fetch (the global in prod, a fixture in tests). */
  fetch: typeof fetch;
  /** Override env lookup (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Shape of the fields we read from the Actions runs response. */
interface WorkflowRun {
  status?: string | null;
  conclusion?: string | null;
}
interface RunsResponse {
  workflow_runs?: WorkflowRun[];
}

function tokenFrom(env: Record<string, string | undefined>): string | undefined {
  const gh = env["GH_TOKEN"];
  if (gh && gh.length > 0) return gh;
  const gt = env["GITHUB_TOKEN"];
  if (gt && gt.length > 0) return gt;
  return undefined;
}

/**
 * Determine the CI status for `repo` @ `sha`. Pure decision over the GitHub
 * Actions response; the only side effect is the injected `fetch`.
 *
 * On any transport/parse error, or an unauthenticated/failed HTTP response, we
 * return 'none' (treated as WAIT by callers) rather than throwing — refusing to
 * deploy on an unverifiable CI state is the safe default, matching deploy.sh's
 * `|| echo '{"workflow_runs":[]}'` fallback.
 */
export async function checkCiGreen(
  repo: string,
  sha: string,
  deps: CiGateDeps,
  workflow?: string,
): Promise<CiStatus> {
  const env = deps.env ?? process.env;
  const token = tokenFrom(env);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const workflowId = workflow === CANONICAL_RELEASE_CI_WORKFLOW
    ? CANONICAL_RELEASE_CI_WORKFLOW_ID
    : workflow;
  const runsPath = workflowId === undefined
    ? "actions/runs"
    : `actions/workflows/${encodeURIComponent(workflowId)}/runs`;
  const url =
    `https://api.github.com/repos/${repo}/${runsPath}` +
    `?head_sha=${encodeURIComponent(sha)}&per_page=${workflow === undefined ? 20 : 1}`;

  let body: RunsResponse;
  try {
    const res = await deps.fetch(url, { headers });
    if (!res.ok) return "none";
    body = (await res.json()) as RunsResponse;
  } catch {
    return "none";
  }

  const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  // A release app names one trusted workflow. GitHub returns newest first; the
  // newest run for the exact SHA is authoritative after a rerun.
  return decide(workflow === undefined ? runs : runs.slice(0, 1));
}

/** Reduce the run list to a single status (deploy.sh decision table). */
function decide(runs: WorkflowRun[]): CiStatus {
  if (runs.length === 0) return "none";

  let anySuccess = false;
  let anyPending = false;

  for (const run of runs) {
    const conclusion = (run.conclusion ?? "").toLowerCase();
    const status = (run.status ?? "").toLowerCase();

    // Any failed/cancelled run is decisive: refuse.
    if (conclusion !== "" && conclusion !== "success") {
      return "failure";
    }
    if (conclusion === "success") anySuccess = true;
    // A run with no conclusion yet (queued/in_progress/waiting) is pending.
    if (conclusion === "" || status === "queued" || status === "in_progress") {
      if (conclusion === "") anyPending = true;
    }
  }

  // Failure already returned. Pending (an unfinished run) outranks success so
  // we don't green-light while another required run is still in flight.
  if (anyPending) return "pending";
  if (anySuccess) return "success";
  return "none";
}
