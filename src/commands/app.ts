/**
 * `samohost app` command family (SPEC-DELTA §3 "app module").
 *
 * Subcommands:
 *   register  — write an AppRecord (offline; no network, no SSH).
 *   plan      — print the deploy script for a SHA (offline; like `preview`).
 *   deploy    — resolve SHA, run the CI gate, push the deploy script over ONE
 *               SSH connection, parse phase markers, update AppRecord state.
 *   status    — print an app record + its deploy bookkeeping (offline).
 *
 * The deploy path's effects (resolve-sha fetch, CI-gate fetch, SSH spawn,
 * clock) are all injected so the whole flow is unit-tested offline.
 */

import { spawnSync } from "node:child_process";
import { checkCiGreen, type CiStatus } from "../app/cigate.ts";
import { parseDeployOutcome, type DeployOutcome } from "../app/parse.ts";
import { buildDeployScript } from "../app/script.ts";
import { AppStore } from "../state/apps.ts";
import { StateStore } from "../state/store.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import type { AppRecord, AppSpec, VmRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Parsed inputs (produced by the CLI parser)
// ---------------------------------------------------------------------------

export interface AppRegisterInput {
  vm: string;
  name: string;
  repo: string;
  branch: string;
  appDir: string;
  buildCmd: string;
  serviceUnit: string;
  healthUrl: string;
  /** Public production host for the durable main-env Caddy vhost
   * (field-record-1#117 ITEM C). Absent → host-prep emits no main vhost. */
  mainHost?: string;
  migrateCmd?: string;
  seedCmd?: string;
  envFile?: string;
  /** Repeatable --env-db-var (issue #11): env vars whose DB URLs are rewired
   * per preview env. Absent → the env script defaults to ["DATABASE_URL"]. */
  envDbVars?: string[];
  rlsNonSuperuser: boolean;
  /** Env var holding the NON-superuser URL for the RLS probe (issue #2). */
  rlsUrlVar?: string;
}

export interface AppPlanInput {
  vm: string;
  app: string;
  sha: string;
}

export interface AppDeployInput {
  vm: string;
  app: string;
  /** Explicit SHA to deploy. Mutually exclusive with `ref`. */
  sha?: string;
  /** Git ref to resolve to a SHA via `gh api`. Defaults to the app branch. */
  ref?: string;
  skipCiGate: boolean;
  /** Bypass the known-bad-SHA guard (issue #2: a FALSE rollback brands a good
   * SHA known-bad and wedges redeploys). Logged loudly when used. */
  force?: boolean;
}

export interface AppStatusInput {
  vm: string;
  app: string;
}

export interface AppClearFailedInput {
  vm: string;
  app: string;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function findVm(store: StateStore, target: string): VmRecord | undefined {
  return store.list().find((r) => r.id === target || r.name === target);
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function runAppRegister(
  input: AppRegisterInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }

  const spec: AppSpec = {
    name: input.name,
    repo: input.repo,
    branch: input.branch,
    appDir: input.appDir,
    buildCmd: input.buildCmd,
    healthUrl: input.healthUrl,
    serviceUnit: input.serviceUnit,
    ...(input.mainHost !== undefined ? { mainHost: input.mainHost } : {}),
    ...(input.migrateCmd !== undefined ? { migrateCmd: input.migrateCmd } : {}),
    ...(input.seedCmd !== undefined ? { seedCmd: input.seedCmd } : {}),
    ...(input.envFile !== undefined ? { envFile: input.envFile } : {}),
    ...(input.envDbVars !== undefined && input.envDbVars.length > 0
      ? { envDbVars: input.envDbVars }
      : {}),
    ...(input.rlsUrlVar !== undefined ? { rlsUrlVar: input.rlsUrlVar } : {}),
    ...(input.rlsNonSuperuser
      ? { assertions: { rlsNonSuperuser: true } }
      : {}),
  };

  const existing = appStore.get(vm.id, input.name);
  const record: AppRecord = {
    ...spec,
    id: existing?.id ?? crypto.randomUUID(),
    vmId: vm.id,
    // Preserve deploy bookkeeping across a re-register of the same app.
    ...(existing?.deployedSha !== undefined
      ? { deployedSha: existing.deployedSha }
      : {}),
    ...(existing?.failedSha !== undefined
      ? { failedSha: existing.failedSha }
      : {}),
    ...(existing?.lastDeployAt !== undefined
      ? { lastDeployAt: existing.lastDeployAt }
      : {}),
  };

  const saved = appStore.upsert(record);
  if (opts.json) {
    out(JSON.stringify(saved, null, 2));
  } else {
    out(
      `registered app ${saved.name} on vm ${vm.name} ` +
        `(repo ${saved.repo}@${saved.branch}, unit ${saved.serviceUnit}, id=${saved.id})`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export function runAppPlan(
  input: AppPlanInput,
  _opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }
  const app = appStore.get(vm.id, input.app);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${input.app}`);
    return 1;
  }
  out(buildDeployScript(app, { sha: input.sha }));
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function runAppStatus(
  input: AppStatusInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }
  const app = appStore.get(vm.id, input.app);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${input.app}`);
    return 1;
  }
  if (opts.json) {
    out(JSON.stringify(app, null, 2));
    return 0;
  }
  out(
    [
      `app: ${app.name}`,
      `vm: ${vm.name}`,
      `repo: ${app.repo}@${app.branch}`,
      `app_dir: ${app.appDir}`,
      `service_unit: ${app.serviceUnit}`,
      `health_url: ${app.healthUrl}`,
      `main_host: ${app.mainHost ?? "-"}`,
      `deployed_sha: ${app.deployedSha ?? "-"}`,
      `failed_sha: ${app.failedSha ?? "-"}`,
      `last_deploy_at: ${app.lastDeployAt ?? "-"}`,
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// clear-failed
// ---------------------------------------------------------------------------

/**
 * Operator escape hatch (issue #2 downstream finding): a rollback — even a
 * FALSE one caused by a probe defect — records the deployed SHA as failedSha,
 * and the known-bad-SHA guard then refuses every redeploy of it. This clears
 * the record so the SHA can be deployed again. Offline; touches only samohost
 * state, never the VM.
 */
export function runAppClearFailed(
  input: AppClearFailedInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }
  const app = appStore.get(vm.id, input.app);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${input.app}`);
    return 1;
  }

  if (app.failedSha === undefined) {
    if (opts.json) {
      out(JSON.stringify(app, null, 2));
    } else {
      out(
        `app ${app.name} on vm ${vm.name} has no failedSha recorded — nothing to clear`,
      );
    }
    return 0;
  }

  const cleared = app.failedSha;
  const updated: AppRecord = { ...app };
  delete updated.failedSha;
  const saved = appStore.upsert(updated);

  if (opts.json) {
    out(JSON.stringify(saved, null, 2));
  } else {
    out(
      `cleared failedSha ${cleared} for app ${app.name} on vm ${vm.name} — ` +
        `the known-bad-SHA guard will no longer refuse deploys of this commit`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

/** Injectable remote runner: run a script (passed on stdin) on the VM. */
export type RemoteScriptRunner = (
  vm: VmRecord,
  script: string,
) => Promise<SpawnResult>;

/** Injectable git-ref resolver (`gh api` in prod). Returns a full SHA. */
export type RefResolver = (repo: string, ref: string) => Promise<string>;

export interface AppDeployDeps {
  /** Run the deploy script remotely over one SSH connection (stdin). */
  remote: RemoteScriptRunner;
  /** Resolve a ref → SHA (only used when --ref is given). */
  resolveRef: RefResolver;
  /** Injected fetch for the CI gate. */
  fetch: typeof fetch;
  /** Clock for lastDeployAt timestamps. */
  now: () => Date;
  /** Env override for token lookup (tests). */
  env?: Record<string, string | undefined>;
}

export interface AppDeployReport {
  app: string;
  vm: string;
  sha: string;
  ci?: CiStatus;
  outcome: DeployOutcome;
  exitCode: number;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function runAppDeploy(
  input: AppDeployInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  deps: AppDeployDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }
  const app = appStore.get(vm.id, input.app);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${input.app}`);
    return 1;
  }

  // ---- resolve the target SHA --------------------------------------------
  let sha: string;
  if (input.sha !== undefined) {
    sha = input.sha;
  } else {
    const ref = input.ref ?? app.branch;
    try {
      sha = (await deps.resolveRef(app.repo, ref)).trim();
    } catch (e) {
      err(
        `error: failed to resolve ref ${ref} for ${app.repo}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
    if (!SHA_RE.test(sha)) {
      err(`error: resolved ref ${ref} to an invalid sha: ${sha}`);
      return 1;
    }
  }

  // ---- known-bad-SHA guard (samohost state, not env file) ----------------
  // Escape hatches (issue #2): a rollback caused by a deploy-tooling defect
  // (e.g. a misconfigured RLS probe) brands a perfectly good SHA known-bad and
  // wedges every redeploy. `app clear-failed` removes the record; --force
  // bypasses the guard for one deploy, loudly.
  if (app.failedSha !== undefined && app.failedSha === sha) {
    if (input.force === true) {
      err(
        `WARNING: --force given — BYPASSING the known-bad-SHA guard: ${sha} ` +
          `matches this app's recorded failedSha (a prior deploy of this exact ` +
          `SHA failed and was rolled back). Proceeding anyway.`,
      );
    } else {
      err(
        `error: ${sha} matches this app's recorded failedSha — a prior deploy of ` +
          `this exact SHA failed and was rolled back. Refusing to redeploy a ` +
          `known-bad commit. Push a fix, run ` +
          `\`samohost app clear-failed ${input.vm} ${input.app}\` if the failure ` +
          `was a tooling defect (e.g. a false rollback), or rerun with --force.`,
      );
      return 1;
    }
  }

  // ---- CI-green gate ------------------------------------------------------
  let ci: CiStatus | undefined;
  if (!input.skipCiGate) {
    ci = await checkCiGreen(app.repo, sha, {
      fetch: deps.fetch,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    });
    if (ci === "failure") {
      err(
        `error: CI gate refused ${sha}: GitHub Actions reports a failed/cancelled ` +
          `run. Never deploying red. (Override with --skip-ci-gate at your own risk.)`,
      );
      return 1;
    }
    if (ci === "pending" || ci === "none") {
      err(
        `error: CI gate is not green for ${sha} (status=${ci}). The run is still ` +
          `in flight or not found. Wait for CI to finish, then retry. ` +
          `(Override with --skip-ci-gate.)`,
      );
      return 1;
    }
  }

  // ---- build + push the script over ONE connection -----------------------
  const script = buildDeployScript(app, { sha });
  let result: SpawnResult;
  try {
    result = await deps.remote(vm, script);
  } catch (e) {
    err(`error: remote deploy connection failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const combined = result.stdout + "\n" + result.stderr;
  const { outcome } = parseDeployOutcome(combined);

  // ---- update bookkeeping -------------------------------------------------
  const stamped = deps.now().toISOString();
  const updated: AppRecord = { ...app, lastDeployAt: stamped };
  if (outcome === "deployed") {
    updated.deployedSha = sha;
    // A successful deploy supersedes any prior bad-SHA guard for this app.
    delete updated.failedSha;
  } else if (outcome === "rolled-back" || outcome === "rollback-failed") {
    updated.failedSha = sha;
    // deployedSha is intentionally NOT advanced on failure.
  }
  // 'incomplete' leaves deployedSha/failedSha unchanged (state unknown).
  appStore.upsert(updated);

  const exitCode = outcome === "deployed" ? 0 : 1;
  const report: AppDeployReport = {
    app: app.name,
    vm: vm.name,
    sha,
    ...(ci !== undefined ? { ci } : {}),
    outcome,
    exitCode,
  };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(`deploy ${app.name}@${sha.slice(0, 12)} on ${vm.name}: ${outcome}`);
    if (outcome !== "deployed") {
      err(`deploy did not succeed (outcome=${outcome}); see remote output above`);
    }
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// Production dependency wiring (not exercised by unit tests)
// ---------------------------------------------------------------------------

/** Run ssh with the deploy script on stdin (`bash -s`) over the pinned runner. */
function defaultRemoteScriptRunner(): RemoteScriptRunner {
  const deps: RunDeps = {
    clock: () => Date.now(),
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      // The runner appends the remote command as the final argv element; we use
      // `bash -s` so the script body is read from stdin (never argv, never a
      // file on the remote) — secrets-safe and splice-safe.
      const res = spawnSync(file, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return Promise.resolve({
        code: typeof res.status === "number" ? res.status : 255,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
      });
    },
  };
  return (vm, script) => {
    // Pipe the script to the runner via a stdin-injecting spawn wrapper.
    const piping: RunDeps = {
      ...deps,
      spawn: (file, args) => {
        const res = spawnSync(file, args, {
          encoding: "utf8",
          input: script,
          maxBuffer: 16 * 1024 * 1024,
        });
        return Promise.resolve({
          code: typeof res.status === "number" ? res.status : 255,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
        });
      },
    };
    return runRemote(vm, "bash -s", piping);
  };
}

/** Resolve a ref → SHA via `gh api` (single short-lived process). */
function defaultRefResolver(): RefResolver {
  return (repo, ref) => {
    const res = spawnSync(
      "gh",
      ["api", `repos/${repo}/commits/${ref}`, "--jq", ".sha"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (res.status !== 0) {
      const msg = (res.stderr || res.error?.message || "gh api failed").trim();
      return Promise.reject(new Error(msg));
    }
    return Promise.resolve((res.stdout ?? "").trim());
  };
}

/** Default production deploy deps. */
export function defaultAppDeployDeps(): AppDeployDeps {
  return {
    remote: defaultRemoteScriptRunner(),
    resolveRef: defaultRefResolver(),
    fetch: globalThis.fetch,
    now: () => new Date(),
  };
}

/** Construct the default app store (honors SAMOHOST_APPS). */
export function defaultAppStore(): AppStore {
  return new AppStore();
}
