/**
 * GitHub comment / issue upsert helpers.
 *
 * Extracted from src/commands/trigger.ts upsertPrCommentImpl so fleet-doctor
 * and future callers can post structured alerts without duplicating the
 * find-PATCH-or-POST logic.
 *
 * NEVER writes tokens to disk. Uses `gh` CLI which reads GH_TOKEN from env.
 */

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// upsertIssueComment — find existing comment with marker → PATCH; else POST.
// Mirrors src/commands/trigger.ts:975-1032 (additive extraction, not removal).
// ---------------------------------------------------------------------------

export interface IssueCommentUpsertOpts {
  /** "owner/repo" */
  repo: string;
  issueNumber: number;
  /** HTML comment string used as idempotency key, e.g. "<!-- samohost-preview -->" */
  marker: string;
  /** Full replacement body; marker MUST be present. */
  body: string;
}

/**
 * Find existing comment on issue/PR containing marker → PATCH; else POST.
 * Throws on non-zero gh exit. NEVER writes tokens to disk.
 */
export function upsertIssueComment(opts: IssueCommentUpsertOpts): void {
  const { repo, issueNumber, marker, body } = opts;

  // List existing comments for the issue/PR.
  const listRes = spawnSync(
    "gh",
    ["api", `repos/${repo}/issues/${issueNumber}/comments`, "--paginate"],
    { encoding: "utf8" },
  );

  let existingCommentId: number | undefined;
  if (listRes.status === 0) {
    try {
      const comments = JSON.parse(listRes.stdout) as Array<{
        id: number;
        body: string;
      }>;
      const found = comments.find((c) => c.body.includes(marker));
      if (found !== undefined) existingCommentId = found.id;
    } catch {
      // Parse failure → create new comment
    }
  }

  const writeRes = existingCommentId !== undefined
    ? // PATCH existing comment
      spawnSync(
        "gh",
        [
          "api", "--method", "PATCH",
          `repos/${repo}/issues/comments/${existingCommentId}`,
          "-f", `body=${body}`,
        ],
        { encoding: "utf8" },
      )
    : // POST new comment
      spawnSync(
        "gh",
        [
          "api", "--method", "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f", `body=${body}`,
        ],
        { encoding: "utf8" },
      );

  if (writeRes.status !== 0) {
    const verb = existingCommentId !== undefined ? "PATCH" : "POST";
    throw new Error(
      `gh api ${verb} issue comment failed (exit ${writeRes.status}): ` +
        `${(writeRes.stderr ?? "").trim() || (writeRes.error?.message ?? "")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// upsertGhIssue — find open issue with marker in body → PATCH; else POST.
// Used by fleet-doctor to maintain a single "fleet alert" issue.
// ---------------------------------------------------------------------------

export interface GhIssueUpsertOpts {
  /** "owner/repo" */
  repo: string;
  title: string;
  /** "<!-- samohost-fleet-alert -->" embedded in issue body */
  marker: string;
  /** Full replacement body; marker MUST be present. */
  body: string;
}

/**
 * Find open issue in repo whose body contains marker → PATCH body+title; else POST (create).
 * Uses: gh api repos/<repo>/issues?state=open&per_page=100 --paginate
 * Throws on non-zero gh exit. NEVER writes tokens to disk.
 */
export function upsertGhIssue(opts: GhIssueUpsertOpts): void {
  const { repo, title, marker, body } = opts;

  // List open issues in the repo.
  const listRes = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/issues`,
      "--paginate",
      "-f", "state=open",
      "-f", "per_page=100",
    ],
    { encoding: "utf8" },
  );

  let existingIssueNumber: number | undefined;
  if (listRes.status === 0) {
    try {
      const issues = JSON.parse(listRes.stdout) as Array<{
        number: number;
        body: string | null;
      }>;
      const found = issues.find((i) => (i.body ?? "").includes(marker));
      if (found !== undefined) existingIssueNumber = found.number;
    } catch {
      // Parse failure → create new issue
    }
  }

  const writeRes = existingIssueNumber !== undefined
    ? // PATCH existing issue
      spawnSync(
        "gh",
        [
          "api", "--method", "PATCH",
          `repos/${repo}/issues/${existingIssueNumber}`,
          "-f", `title=${title}`,
          "-f", `body=${body}`,
        ],
        { encoding: "utf8" },
      )
    : // POST new issue
      spawnSync(
        "gh",
        [
          "api", "--method", "POST",
          `repos/${repo}/issues`,
          "-f", `title=${title}`,
          "-f", `body=${body}`,
        ],
        { encoding: "utf8" },
      );

  if (writeRes.status !== 0) {
    const verb = existingIssueNumber !== undefined ? "PATCH" : "POST";
    throw new Error(
      `gh api ${verb} issue failed (exit ${writeRes.status}): ` +
        `${(writeRes.stderr ?? "").trim() || (writeRes.error?.message ?? "")}`,
    );
  }
}
