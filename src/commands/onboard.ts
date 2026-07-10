/**
 * `samohost onboard <org/repo>` — client-onboarding package (issue #127).
 *
 * Collapses the manual onboarding checklist into one idempotent command:
 *   1. Reads .samohost.toml from the target repo (GitHub API) or a local path.
 *   2. Scaffolds templates/client-repo/ into the target repo as a branch + PR.
 *   3. Registers the app in the samohost state store (equivalent to
 *      `app register --from-toml`).
 *   4. Verifies trigger coverage (app present in store = trigger will pick it up).
 *
 * All I/O is injected via OnboardDeps so the flow is fully unit-testable offline.
 *
 * Idempotency guarantees:
 *   - If the samohost-onboarding branch already has an open PR → updates files
 *     on the branch but does NOT create a second PR (status = "updated").
 *   - If the app is already registered → upserts the record (no duplicate).
 *   - Safe to re-run after partial failures.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAppRegister, type AppRegisterInput } from "./app.ts";
import { parseSamohostToml } from "../manifest/toml.ts";
import type { AppStore } from "../state/apps.ts";
import type { StateStore } from "../state/store.ts";

// ---------------------------------------------------------------------------
// Template files
// ---------------------------------------------------------------------------

/**
 * Canonical list of template file paths (relative to templates/client-repo/).
 * Every path in this list is scaffolded into the target repo on every onboard run.
 */
export const TEMPLATE_FILES: readonly string[] = [
  ".github/workflows/ci.yml",
  ".samohost.toml",
  "CLAUDE.md",
  "staging.env.example",
];

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../templates/client-repo",
);

/** Load a template file from the bundled templates directory. */
function loadTemplate(relativePath: string): string {
  return readFileSync(join(TEMPLATES_DIR, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Substitution variables for template rendering. */
export interface TemplateVars {
  /** Runner tag injected into ci.yml (replaces {{RUNNER_TAG}}). Defaults to "self-hosted". */
  RUNNER_TAG?: string;
  /** App name (replaces {{APP_NAME}}). */
  APP_NAME?: string;
  /** GitHub owner/repo (replaces {{REPO}}). */
  REPO?: string;
  /** Database name (replaces {{APP_DB_NAME}}). Defaults to APP_NAME with dashes → underscores. */
  APP_DB_NAME?: string;
}

/**
 * Render a template string by replacing `{{KEY}}` placeholders with the
 * supplied values. Unknown placeholders are replaced with sensible defaults
 * rather than left as raw markers — the scaffolded files must be valid YAML/TOML
 * out of the box.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const runnerTag = vars.RUNNER_TAG ?? "self-hosted";
  const appName   = vars.APP_NAME   ?? "my-app";
  const repo      = vars.REPO       ?? "org/my-app";
  const appDbName = vars.APP_DB_NAME ?? appName.replace(/-/g, "_");

  return template
    .replace(/\{\{RUNNER_TAG\}\}/g, runnerTag)
    .replace(/\{\{APP_NAME\}\}/g,   appName)
    .replace(/\{\{REPO\}\}/g,       repo)
    .replace(/\{\{APP_DB_NAME\}\}/g, appDbName);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OnboardInput {
  /** GitHub owner/repo of the client repository, e.g. "acme-org/acme-web". */
  repo: string;
  /** VM name or id in samohost state where the app will deploy. */
  vm: string;
  /**
   * Local path to a .samohost.toml file.  When provided, this file is used
   * instead of fetching from GitHub.  Useful for initial onboarding before
   * the toml exists in the repo.
   */
  tomlPath?: string;
  /**
   * Self-hosted runner tag to inject into the scaffolded ci.yml.
   * Defaults to "self-hosted" (works for any repo with exactly one self-hosted
   * runner; override when the runner carries an additional tag label).
   */
  runnerTag?: string;
}

export type OnboardStatus = "created" | "updated" | "error";

export interface OnboardReport {
  status: OnboardStatus;
  prUrl?: string;
  appRegistered: boolean;
  triggerCovered: boolean;
  scaffoldedFiles: string[];
}

/**
 * External I/O dependencies — all injected so the command is testable offline.
 */
export interface OnboardDeps {
  /**
   * Fetch a file from a GitHub repo (default branch).
   * Returns the file content as a string, or null when not found.
   */
  fetchRepoFile(repo: string, path: string): Promise<string | null>;

  /** Return the default branch name for a GitHub repo. */
  getDefaultBranch(repo: string): Promise<string>;

  /** Check whether a branch exists in the target repo. */
  branchExists(repo: string, branch: string): Promise<boolean>;

  /**
   * Create a new branch in the target repo from a given base SHA or branch.
   * Must be a no-op if the branch already exists.
   */
  createBranch(repo: string, branch: string, base: string): Promise<void>;

  /** Create or update a single file on a branch in the target repo. */
  scaffoldFile(
    repo: string,
    branch: string,
    path: string,
    content: string,
  ): Promise<void>;

  /**
   * Look for an open PR from `branch` → default branch.
   * Returns the PR URL if found, null otherwise.
   */
  findPr(repo: string, branch: string): Promise<string | null>;

  /** Create a PR and return its URL. Only called when findPr returns null. */
  createPr(
    repo: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Default (live) deps — requires GITHUB_TOKEN in env
// ---------------------------------------------------------------------------

const ONBOARD_BRANCH = "samohost-onboarding";

const GH_API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN must be set for live onboarding");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "samohost-onboard/0.1",
  };
}

export function defaultOnboardDeps(): OnboardDeps {
  return {
    async fetchRepoFile(repo, path) {
      const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
        headers: ghHeaders(),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as { content: string; encoding: string };
      if (data.encoding !== "base64") throw new Error(`Unexpected encoding: ${data.encoding}`);
      return Buffer.from(data.content, "base64").toString("utf8");
    },

    async getDefaultBranch(repo) {
      const res = await fetch(`${GH_API}/repos/${repo}`, { headers: ghHeaders() });
      if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as { default_branch: string };
      return data.default_branch;
    },

    async branchExists(repo, branch) {
      const res = await fetch(`${GH_API}/repos/${repo}/branches/${branch}`, {
        headers: ghHeaders(),
      });
      return res.status === 200;
    },

    async createBranch(repo, branch, base) {
      // First resolve base to a SHA if it looks like a branch name.
      const refRes = await fetch(
        `${GH_API}/repos/${repo}/git/refs/heads/${base}`,
        { headers: ghHeaders() },
      );
      if (!refRes.ok) throw new Error(`Cannot resolve base branch ${base}: ${refRes.status}`);
      const refData = (await refRes.json()) as { object: { sha: string } };
      const sha = refData.object.sha;

      const res = await fetch(`${GH_API}/repos/${repo}/git/refs`, {
        method: "POST",
        headers: ghHeaders(),
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      });
      if (!res.ok && res.status !== 422) {
        // 422 = ref already exists — treat as success (idempotent)
        throw new Error(`Cannot create branch ${branch}: ${res.status}`);
      }
    },

    async scaffoldFile(repo, branch, path, content) {
      // Check if file already exists (to supply sha for update).
      const getRes = await fetch(
        `${GH_API}/repos/${repo}/contents/${path}?ref=${branch}`,
        { headers: ghHeaders() },
      );
      const existing = getRes.ok
        ? ((await getRes.json()) as { sha: string })
        : null;

      const body: Record<string, string> = {
        message: `chore(samohost): scaffold ${path}`,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
      };
      if (existing) body["sha"] = existing.sha;

      const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Cannot scaffold ${path}: ${res.status} ${await res.text()}`);
      }
    },

    async findPr(repo, branch) {
      const res = await fetch(
        `${GH_API}/repos/${repo}/pulls?head=${repo.split("/")[0]}:${branch}&state=open`,
        { headers: ghHeaders() },
      );
      if (!res.ok) {
        // Surface transient API errors instead of silently routing to createPr.
        // Returning null here would incorrectly call createPr and risk creating
        // a duplicate PR when an existing one is already open.
        throw new Error(`GitHub API error ${res.status} listing PRs for ${repo}: ${res.statusText}`);
      }
      const data = (await res.json()) as Array<{ html_url: string }>;
      return data[0]?.html_url ?? null;
    },

    async createPr(repo, branch, title, body) {
      const defaultBranch = await this.getDefaultBranch(repo);
      const res = await fetch(`${GH_API}/repos/${repo}/pulls`, {
        method: "POST",
        headers: ghHeaders(),
        body: JSON.stringify({ title, body, head: branch, base: defaultBranch }),
      });
      if (!res.ok) throw new Error(`Cannot create PR: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { html_url: string };
      return data.html_url;
    },
  };
}

// ---------------------------------------------------------------------------
// runOnboard
// ---------------------------------------------------------------------------

/**
 * Onboard a client repo: scaffold template files as a branch+PR, register the
 * app, and verify trigger coverage.
 *
 * Returns an {@link OnboardReport} describing what happened.  Exit codes are
 * communicated via the report's `status` field (never throws for user errors).
 */
export async function runOnboard(
  input: OnboardInput,
  deps: OnboardDeps,
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<OnboardReport> {
  const { repo, vm: vmName, tomlPath, runnerTag } = input;

  // ---- 1. Resolve VM -------------------------------------------------------
  const vmRecord = vmStore.list().find(
    (v) => v.name === vmName || v.id === vmName,
  );
  if (!vmRecord) {
    err(`error: VM not found in state: ${vmName}`);
    return { status: "error", appRegistered: false, triggerCovered: false, scaffoldedFiles: [] };
  }

  // ---- 2. Read .samohost.toml ----------------------------------------------
  // Track whether .samohost.toml already exists in the target repo so we can
  // skip-if-exists in step 6.  "exists in repo" = fetched from GitHub (not from
  // a local --toml-path and not synthesised from the template).
  let samoTomlAlreadyInRepo = false;
  let tomlText: string;
  if (tomlPath) {
    try {
      tomlText = readFileSync(tomlPath, "utf8");
    } catch (e) {
      err(`error: cannot read toml file ${tomlPath}: ${e instanceof Error ? e.message : String(e)}`);
      return { status: "error", appRegistered: false, triggerCovered: false, scaffoldedFiles: [] };
    }
  } else {
    const fetched = await deps.fetchRepoFile(repo, ".samohost.toml");
    if (!fetched) {
      out(`info: no .samohost.toml found in ${repo} — will scaffold a template`);
      // Build a minimal toml from the repo name
      const appName = repo.split("/")[1]!;
      tomlText = renderTemplate(loadTemplate(".samohost.toml"), {
        APP_NAME: appName,
        REPO: repo,
        RUNNER_TAG: runnerTag,
      });
    } else {
      tomlText = fetched;
      samoTomlAlreadyInRepo = true;
    }
  }

  // ---- 3. Parse toml to extract app metadata --------------------------------
  const parsed = parseSamohostToml(tomlText);
  if (!parsed.ok) {
    err(`error: manifest validation failed (${parsed.errors.length} error(s)):`);
    for (const msg of parsed.errors) err(`  - ${msg}`);
    return { status: "error", appRegistered: false, triggerCovered: false, scaffoldedFiles: [] };
  }

  const appName = parsed.app.name;
  const appRepo = parsed.app.repo;
  const vars: TemplateVars = {
    APP_NAME: appName,
    REPO: appRepo,
    RUNNER_TAG: runnerTag,
  };

  // ---- 4. Determine PR status (for idempotency) -----------------------------
  const existingPrUrl = await deps.findPr(repo, ONBOARD_BRANCH);
  const isUpdate = existingPrUrl !== null;

  // ---- 5. Ensure branch exists ---------------------------------------------
  const branchAlreadyExists = await deps.branchExists(repo, ONBOARD_BRANCH);
  if (!branchAlreadyExists) {
    const defaultBranch = await deps.getDefaultBranch(repo);
    await deps.createBranch(repo, ONBOARD_BRANCH, defaultBranch);
  }

  // ---- 6. Scaffold template files ------------------------------------------
  const scaffoldedFiles: string[] = [];
  for (const templatePath of TEMPLATE_FILES) {
    // Never clobber an existing .samohost.toml — it is the client's source of
    // truth and may have been customised after the initial onboard.  Use the
    // real manifest (already fetched in step 2) for registration; just skip
    // re-scaffolding it on the onboarding branch.
    if (templatePath === ".samohost.toml" && samoTomlAlreadyInRepo) {
      out(`info: .samohost.toml already exists in ${repo} — preserving existing manifest (not overwriting)`);
      continue;
    }
    const rawContent = loadTemplate(templatePath);
    const rendered = renderTemplate(rawContent, vars);
    await deps.scaffoldFile(repo, ONBOARD_BRANCH, templatePath, rendered);
    scaffoldedFiles.push(templatePath);
  }

  // ---- 7. Create or surface PR ----------------------------------------------
  let prUrl: string;
  if (isUpdate) {
    prUrl = existingPrUrl!;
    out(`updated samohost onboarding branch in ${repo} (PR already open: ${prUrl})`);
  } else {
    prUrl = await deps.createPr(
      repo,
      ONBOARD_BRANCH,
      `chore: samohost onboarding — CI + .samohost.toml + CLAUDE.md`,
      `## samohost onboarding

Scaffolded by \`samohost onboard ${repo}\`.

### Files added
${scaffoldedFiles.map((f) => `- \`${f}\``).join("\n")}

### Next steps
1. Merge this PR.
2. The \`samohost-trigger.timer\` on the control plane will pick up the app
   automatically and auto-deploy on every push to \`main\`.
3. Open a PR to test CI — the \`ci.yml\` workflow will run on your
   self-hosted runner.

Refs: NikolayS/samohost#127
`,
    );
    out(`opened samohost onboarding PR: ${prUrl}`);
  }

  // ---- 8. Register the app in samohost state --------------------------------
  // We already have the parsed manifest — build AppRegisterInput directly so we
  // don't need to write a temp file or re-read from disk.
  const nullOut = (_s: string) => {};
  const errLines: string[] = [];
  const captureErr = (s: string) => { errLines.push(s); };

  const { app } = parsed;
  const registerInput: AppRegisterInput = {
    vm: vmName,
    name: app.name,
    repo: app.repo,
    branch: app.branch,
    appDir: app.appDir,
    buildCmd: app.buildCmd,
    serviceUnit: app.serviceUnit,
    healthUrl: app.healthUrl,
    rlsNonSuperuser: app.rlsNonSuperuser === true,
    ...(app.kind              !== undefined ? { kind:              app.kind }              : {}),
    ...(app.migrateCmd        !== undefined ? { migrateCmd:        app.migrateCmd }        : {}),
    ...(app.seedCmd           !== undefined ? { seedCmd:           app.seedCmd }           : {}),
    ...(app.envFile           !== undefined ? { envFile:           app.envFile }           : {}),
    ...(app.mainHost          !== undefined ? { mainHost:          app.mainHost }          : {}),
    ...(app.rlsUrlVar         !== undefined ? { rlsUrlVar:         app.rlsUrlVar }         : {}),
    ...(app.envDbVars         !== undefined ? { envDbVars:         app.envDbVars }         : {}),
    ...(app.dbBackend         !== undefined ? { dbBackend:         app.dbBackend }         : {}),
    ...(app.previewDbBackend  !== undefined ? { previewDbBackend:  app.previewDbBackend }  : {}),
    ...(app.appUser           !== undefined ? { appUser:           app.appUser }           : {}),
    // ---- fields that were previously dropped (samorev #140) ----
    ...(app.releaseTagPattern !== undefined ? { releaseTagPattern: app.releaseTagPattern } : {}),
    ...(app.services          !== undefined ? { services:          app.services }          : {}),
    ...(app.routes            !== undefined ? { routes:            app.routes }            : {}),
    ...(app.defaultListener   !== undefined ? { defaultListener:   app.defaultListener }   : {}),
    ...(app.mainListen        !== undefined ? { mainListen:        app.mainListen }        : {}),
    ...(app.secrets           !== undefined ? { secrets:           app.secrets }           : {}),
    ...(app.databaseUrlEnv    !== undefined ? { databaseUrlEnv:    app.databaseUrlEnv }    : {}),
  };

  const exitCode = runAppRegister(
    registerInput,
    { json: false },
    vmStore,
    appStore,
    nullOut,
    captureErr,
  );

  const appRegistered = exitCode === 0;
  if (!appRegistered) {
    for (const line of errLines) err(line);
  } else {
    out(`registered app ${appName} on VM ${vmRecord.name}`);
  }

  // ---- 9. Verify trigger coverage ------------------------------------------
  // The trigger iterates appStore.list() filtered by vmId.  An app is "covered"
  // when it appears in that list — no separate trigger-specific state needed.
  const triggerCovered = appStore
    .list()
    .some((a) => a.vmId === vmRecord.id && a.name === appName);

  out(
    `onboard complete — status=${isUpdate ? "updated" : "created"}, ` +
    `app=${appRegistered ? "registered" : "FAILED"}, ` +
    `trigger=${triggerCovered ? "covered" : "NOT covered"}`,
  );

  return {
    status: isUpdate ? "updated" : "created",
    prUrl,
    appRegistered,
    triggerCovered,
    scaffoldedFiles,
  };
}
