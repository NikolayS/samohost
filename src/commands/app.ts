/**
 * `samohost app` command family (SPEC-DELTA §3 "app module").
 *
 * Subcommands:
 *   register   — write an AppRecord (offline; no network, no SSH).
 *   plan       — print the deploy script for a SHA (offline; like `preview`).
 *   deploy     — resolve SHA, run the CI gate, push the deploy script over ONE
 *                SSH connection, parse phase markers, update AppRecord state.
 *   status     — print an app record + its deploy bookkeeping (offline).
 *   bootstrap  — print the ONE-TIME OS bootstrap script (PR-A1: runtimes,
 *                OS user, /opt layout, sudoers, MAIN unit, sshd, Caddy).
 *
 * The deploy path's effects (resolve-sha fetch, CI-gate fetch, SSH spawn,
 * clock) are all injected so the whole flow is unit-tested offline.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { checkCiGreen, type CiStatus } from "../app/cigate.ts";
import { parseDeployOutcome, type DeployOutcome } from "../app/parse.ts";
import { buildDeployScript } from "../app/script.ts";
import {
  buildHostBootstrapScript,
  type HostBootstrapOptions,
} from "../app/bootstrap.ts";
import { AppStore } from "../state/apps.ts";
import { StateStore } from "../state/store.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import type { AppRecord, AppSpec, EnvDbBackend, ServiceSpec, RouteSpec, VmRecord } from "../types.ts";
import { parseSamohostToml, validateServicesTopology } from "../manifest/toml.ts";

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
  /**
   * Serve kind (issue #36): `"node"` (default when absent) or `"static"`.
   * Absent = node; all existing AppRecords are valid.
   */
  kind?: "node" | "static";
  /**
   * Persistent DB backend for this app's own production database.
   * `"none"` = app carries no database; preview envs must skip all DB phases.
   * Absent on existing AppRecords; treated as implicitly DB-present.
   * Mirrors {@link AppSpec.dbBackend}.
   */
  dbBackend?: EnvDbBackend;
  /**
   * Per-app default DB backend for auto-created PR-preview envs.
   * When absent, falls back via previewDbBackendFor() in trigger/preview-rebuild.
   * Mirrors {@link AppSpec.previewDbBackend}.
   */
  previewDbBackend?: EnvDbBackend;
  /**
   * Glob selecting the git tags that drive the PRODUCTION deploy channel
   * (issue #132). When set, prod tracks the latest matching semver tag instead
   * of `branch` HEAD; requires {@link mainHost}. Absent → unchanged (branch
   * HEAD). Mirrors {@link AppSpec.releaseTagPattern}.
   */
  releaseTagPattern?: string;
  /**
   * OS user that owns the production app checkout and the envs root (created
   * by `samohost app bootstrap --app-user <user>`). When set, env-create runs
   * all git operations as this user via `sudo -u <appUser> GIT_CONFIG_GLOBAL=...`.
   * Mirrors {@link AppSpec.appUser}.
   */
  appUser?: string;

  // ---- Multi-service spec model (additive; absent = legacy single-service) --
  /** Declared services. Mirrors {@link AppSpec.services}. */
  services?: ServiceSpec[];
  /** Caddy routing rules. Mirrors {@link AppSpec.routes}. */
  routes?: RouteSpec[];
  /** Default listener name (required when services is set). Mirrors {@link AppSpec.defaultListener}. */
  defaultListener?: string;
  /** Production main-host Caddy wiring mode. Mirrors {@link AppSpec.mainListen}. */
  mainListen?: "cp-http80" | "tls";
  /**
   * Optional glob pattern for release tags (e.g. `"v*"`). Mirrors
   * {@link AppSpec.releaseTagPattern}.
   *
   * IMPORTANT — accepted + persisted; the tag-gated deploy behavior is a
   * separate, not-yet-shipped feature — prod deploys on main SHA + CI-green
   * regardless of this value.
   */
  releaseTagPattern?: string;

  /**
   * App-level secret env-var NAMES to auto-generate per preview env (PR-B).
   * Each entry must match ^[A-Z_][A-Z0-9_]*$. No duplicates.
   * Mirrors {@link AppSpec.secrets}.
   */
  secrets?: string[];

  /**
   * Env-var name holding the DB connection URL (e.g. "DATABASE_URL").
   * Required for explicitly DB-backed apps. Mirrors {@link AppSpec.databaseUrlEnv}.
   */
  databaseUrlEnv?: string;
}

/**
 * Input for `app register --from-toml`: the `<vm>` positional arg plus the
 * path to a `.samohost.toml` manifest. The VM is NOT part of the manifest
 * (it is repo-portable; the target VM is supplied at register time).
 *
 * NOTE: the `[provision]` section of the TOML (serverType/location/labels) is
 * parsed and validated but NOT consumed here. It is intended for a future
 * `provision --from-toml` command.
 * TODO(PR-E): wire provision --from-toml to consume the [provision] table.
 */
export interface AppRegisterFromTomlInput {
  vm: string;
  tomlPath: string;
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

/**
 * Inputs for `app bootstrap` (PR-A1 OS prep). All HostBootstrapOptions fields
 * plus the VM/app identifiers. `appUser` is required; other opts have defaults.
 */
export interface AppBootstrapInput {
  vm: string;
  app: string;
  appUser: string;
  /**
   * PR-A2 REQUIRED — the database name to create on the host.
   * MUST be passed explicitly; never derived from app.name.
   * See HostBootstrapOptions.dbName.
   */
  dbName: string;
  appBase?: string;
  nodeMajor?: number;
  pgMajor?: number;
  execStart?: string;
  tlsMode?: "acme" | "local";
  /** PR-A2 optional — non-superuser DB role for the RLS URL placeholder. Default "app_user". */
  appDbRole?: string;
  /** PR-A2 optional — value written into SEED_OWNER_LOGIN. Default "owner". */
  seedOwnerLogin?: string;
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

  // Fix 6a: validate service topology on the programmatic path too.
  // The TOML path runs the same check via parseSamohostToml. Without this guard,
  // `app register` (called from CLI flags or other code) could persist an AppRecord
  // with a dangling defaultListener or routes-without-services, causing a runtime
  // error in servicesOf() or in the Caddy config writer.
  if (input.services !== undefined || input.routes !== undefined || input.defaultListener !== undefined) {
    const topologyErrors: string[] = [];
    validateServicesTopology(
      input.services,
      input.routes,
      input.defaultListener,
      topologyErrors,
    );
    if (topologyErrors.length > 0) {
      err(`error: service topology validation failed (${topologyErrors.length} error(s)):`);
      for (const msg of topologyErrors) {
        err(`  - ${msg}`);
      }
      return 1;
    }
  }

  // issue #132: the release-tag prod channel needs a durable main vhost, so
  // mainHost is required whenever releaseTagPattern is set.
  if (input.releaseTagPattern !== undefined && input.mainHost === undefined) {
    err(`error: releaseTagPattern requires mainHost to be set`);
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
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
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
    ...(input.dbBackend !== undefined ? { dbBackend: input.dbBackend } : {}),
    ...(input.previewDbBackend !== undefined ? { previewDbBackend: input.previewDbBackend } : {}),
    ...(input.releaseTagPattern !== undefined ? { releaseTagPattern: input.releaseTagPattern } : {}),
    ...(input.appUser !== undefined ? { appUser: input.appUser } : {}),
    // Multi-service spec model (additive; absent = legacy single-service)
    ...(input.services !== undefined ? { services: input.services } : {}),
    ...(input.routes !== undefined ? { routes: input.routes } : {}),
    ...(input.defaultListener !== undefined ? { defaultListener: input.defaultListener } : {}),
    ...(input.mainListen !== undefined ? { mainListen: input.mainListen } : {}),
    // accepted + persisted; the tag-gated deploy behavior is a separate,
    // not-yet-shipped feature — prod deploys on main SHA + CI-green regardless of this value.
    ...(input.releaseTagPattern !== undefined ? { releaseTagPattern: input.releaseTagPattern } : {}),
    // PR-B/PR-C schema: accepted + persisted; secret generation and DB URL rewriting
    // are separate, not-yet-shipped features.
    ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    ...(input.databaseUrlEnv !== undefined ? { databaseUrlEnv: input.databaseUrlEnv } : {}),
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
// register --from-toml
// ---------------------------------------------------------------------------

/**
 * Read a `.samohost.toml` manifest from `input.tomlPath`, parse + validate it,
 * then delegate to {@link runAppRegister} to write the AppRecord.
 *
 * Fail-closed: if the file cannot be read or the manifest is invalid, prints
 * all errors to stderr and returns 1 without persisting anything.
 *
 * The `[provision]` table in the manifest is parsed and validated but NOT
 * consumed here (it targets a future `provision --from-toml` command).
 *
 * @see AppRegisterFromTomlInput
 */
export function runAppRegisterFromToml(
  input: AppRegisterFromTomlInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  // ---- read file -----------------------------------------------------------
  let text: string;
  try {
    text = readFileSync(input.tomlPath, "utf8");
  } catch (e) {
    err(
      `error: cannot read manifest file ${input.tomlPath}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }

  // ---- parse + validate ---------------------------------------------------
  const result = parseSamohostToml(text);
  if (!result.ok) {
    err(`error: manifest validation failed (${result.errors.length} error(s)):`);
    for (const msg of result.errors) {
      err(`  - ${msg}`);
    }
    return 1;
  }

  // ---- build AppRegisterInput from manifest --------------------------------
  const { app } = result;
  const registerInput: AppRegisterInput = {
    vm: input.vm,
    name: app.name,
    repo: app.repo,
    branch: app.branch,
    appDir: app.appDir,
    buildCmd: app.buildCmd,
    serviceUnit: app.serviceUnit,
    healthUrl: app.healthUrl,
    rlsNonSuperuser: app.rlsNonSuperuser === true,
    ...(app.kind !== undefined ? { kind: app.kind } : {}),
    ...(app.migrateCmd !== undefined ? { migrateCmd: app.migrateCmd } : {}),
    ...(app.seedCmd !== undefined ? { seedCmd: app.seedCmd } : {}),
    ...(app.envFile !== undefined ? { envFile: app.envFile } : {}),
    ...(app.mainHost !== undefined ? { mainHost: app.mainHost } : {}),
    ...(app.rlsUrlVar !== undefined ? { rlsUrlVar: app.rlsUrlVar } : {}),
    ...(app.envDbVars !== undefined ? { envDbVars: app.envDbVars } : {}),
    ...(app.dbBackend !== undefined ? { dbBackend: app.dbBackend } : {}),
    ...(app.previewDbBackend !== undefined ? { previewDbBackend: app.previewDbBackend } : {}),
    ...(app.releaseTagPattern !== undefined ? { releaseTagPattern: app.releaseTagPattern } : {}),
    ...(app.appUser !== undefined ? { appUser: app.appUser } : {}),
    // Multi-service spec model (additive; absent = legacy single-service)
    ...(app.services !== undefined ? { services: app.services } : {}),
    ...(app.routes !== undefined ? { routes: app.routes } : {}),
    ...(app.defaultListener !== undefined ? { defaultListener: app.defaultListener } : {}),
    ...(app.mainListen !== undefined ? { mainListen: app.mainListen } : {}),
    ...(app.releaseTagPattern !== undefined ? { releaseTagPattern: app.releaseTagPattern } : {}),
    ...(app.secrets !== undefined ? { secrets: app.secrets } : {}),
    ...(app.databaseUrlEnv !== undefined ? { databaseUrlEnv: app.databaseUrlEnv } : {}),
  };

  return runAppRegister(registerInput, opts, vmStore, appStore, out, err);
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
// bootstrap (PR-A1)
// ---------------------------------------------------------------------------

/**
 * Print the ONE-TIME OS bootstrap script for operator review and application.
 *
 * Resolves the AppRecord from state (same lookup pattern as `env plan
 * --host-prep`), builds the bootstrap script via {@link buildHostBootstrapScript},
 * and prints it to stdout. The operator reviews and applies it with root;
 * samohost NEVER auto-executes this script.
 *
 * Scope (PR-A1): runtimes (Node/PG/Caddy), app OS user, /opt layout, sudoers,
 * MAIN systemd unit, sshd AllowUsers drop-in, Caddy base config.
 * Scope (PR-A2): DB bootstrap + createdb (dbName REQUIRED, explicit),
 * base env file seeding, full token-safe repo clone, extended self-check table.
 */
export function runAppBootstrap(
  input: AppBootstrapInput,
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

  const opts: HostBootstrapOptions = {
    appUser: input.appUser,
    dbName: input.dbName,
    ...(input.appBase !== undefined ? { appBase: input.appBase } : {}),
    ...(input.nodeMajor !== undefined ? { nodeMajor: input.nodeMajor } : {}),
    ...(input.pgMajor !== undefined ? { pgMajor: input.pgMajor } : {}),
    ...(input.execStart !== undefined ? { execStart: input.execStart } : {}),
    ...(input.tlsMode !== undefined ? { tlsMode: input.tlsMode } : {}),
    ...(input.appDbRole !== undefined ? { appDbRole: input.appDbRole } : {}),
    ...(input.seedOwnerLogin !== undefined ? { seedOwnerLogin: input.seedOwnerLogin } : {}),
  };

  out(buildHostBootstrapScript(app, opts));
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

// ---------------------------------------------------------------------------
// Release-tag production channel (issue #132 / SPEC-DELTA §8)
// ---------------------------------------------------------------------------

/** A resolved release tag: the tag name plus the COMMIT sha it points at. */
export interface TagRef {
  tag: string;
  sha: string;
}

/**
 * Resolve the LATEST release tag matching `pattern` for `repo` → its commit
 * sha, or `null` when no tag matches. NEVER falls back to a branch HEAD.
 * The same type is injected into the trigger as `resolveLatestTag`.
 */
export type LatestTagResolver = (
  repo: string,
  pattern: string,
) => Promise<TagRef | null>;

/**
 * Low-level GitHub IO for the tag resolver, split out so the selection logic
 * ({@link selectLatestTag}) and the deref/list orchestration are unit-tested
 * offline with a fake, while prod wires `gh api`.
 */
export interface GhTagIo {
  /** List every tag name in the repo (e.g. `gh api --paginate repos/<r>/tags`). */
  listTags: (repo: string) => Promise<string[]>;
  /**
   * Dereference a tag ref to its target COMMIT sha. `gh api
   * repos/<r>/commits/<ref>` resolves BOTH lightweight and annotated tags to
   * the underlying commit (an annotated tag's own object sha is NOT returned).
   */
  resolveCommitSha: (repo: string, ref: string) => Promise<string>;
}

/** Parsed semver components; `prerelease` empty ⇒ a final release. */
interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

/** Convert a shell-style glob (`*`, `?`, `[...]`) into an anchored RegExp. */
export function tagGlobToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      re += ".*";
      i++;
    } else if (c === "?") {
      re += ".";
      i++;
    } else if (c === "[") {
      // Character class: copy through the matching ']'.
      let j = i + 1;
      let cls = "[";
      if (glob[j] === "!" || glob[j] === "^") {
        cls += "^";
        j++;
      }
      if (glob[j] === "]") {
        cls += "\\]";
        j++;
      }
      while (j < glob.length && glob[j] !== "]") {
        cls += glob[j] === "\\" ? "\\\\" : glob[j];
        j++;
      }
      if (j >= glob.length) {
        // Unterminated '[' → treat as a literal '['.
        re += "\\[";
        i++;
        continue;
      }
      re += cls + "]";
      i = j + 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(re + "$");
}

/** Parse a (possibly `v`-prefixed) tag name into semver parts, or null. */
function parseSemver(name: string): Semver | null {
  const s = name.replace(/^v/, "");
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(s);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
    prerelease: m[4] !== undefined ? m[4].split(".") : [],
    raw: name,
  };
}

/** Semver precedence (SemVer §11): negative if a < b, positive if a > b. */
function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease;
  const bp = b.prerelease;
  // A final release outranks any prerelease of the same core version.
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const x = ap[i]!;
    const y = bp[i]!;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ap.length - bp.length;
}

/**
 * From `names`, keep those matching the glob `pattern` that parse as semver,
 * EXCLUDE prereleases unless the pattern opts in (a `-` OUTSIDE any `[...]`
 * class), and return
 * the greatest by semver precedence — or `null` if none qualify. Pure.
 */
export function selectLatestTag(
  names: string[],
  pattern: string,
): string | null {
  const re = tagGlobToRegExp(pattern);
  // Opt into prereleases only on a hyphen that is part of the glob's matching
  // intent — i.e. OUTSIDE any character class. A `-` inside e.g. `[0-9]` (as in
  // "v[0-9]*.[0-9]*.[0-9]*") must NOT enable prereleases for a prod deploy.
  const allowPrerelease = pattern.replace(/\[[^\]]*\]/g, "").includes("-");
  let best: Semver | null = null;
  for (const name of names) {
    if (!re.test(name)) continue;
    const sv = parseSemver(name);
    if (sv === null) continue;
    if (!allowPrerelease && sv.prerelease.length > 0) continue;
    if (best === null || compareSemver(sv, best) > 0) best = sv;
  }
  return best === null ? null : best.raw;
}

/**
 * Build a {@link LatestTagResolver} over an injected {@link GhTagIo}: list
 * tags, pick the latest matching semver ({@link selectLatestTag}), then deref
 * that tag to its commit sha. Returns null (no branch fallback) when nothing
 * matches.
 */
export function makeResolveLatestTag(io: GhTagIo): LatestTagResolver {
  return async (repo, pattern) => {
    const names = await io.listTags(repo);
    const latest = selectLatestTag(names, pattern);
    if (latest === null) return null;
    const sha = (await io.resolveCommitSha(repo, latest)).trim();
    return { tag: latest, sha };
  };
}

/** Prod {@link GhTagIo}: `gh api` (single short-lived process per call). */
function defaultGhTagIo(): GhTagIo {
  return {
    listTags: (repo) => {
      const res = spawnSync(
        "gh",
        ["api", "--paginate", `repos/${repo}/tags`, "--jq", ".[].name"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      if (res.status !== 0) {
        const msg = (res.stderr || res.error?.message || "gh api failed").trim();
        return Promise.reject(new Error(msg));
      }
      const names = (res.stdout ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return Promise.resolve(names);
    },
    // Reuses the SAME endpoint as defaultRefResolver: commits/<ref> resolves an
    // annotated tag to the target commit (not the tag object).
    resolveCommitSha: defaultRefResolver(),
  };
}

/** Resolve the latest matching release tag → commit sha via `gh api`. */
export function defaultResolveLatestTag(): LatestTagResolver {
  return makeResolveLatestTag(defaultGhTagIo());
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
