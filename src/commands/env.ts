/**
 * `samohost env` command family (SPEC-DELTA §4 — per-branch preview envs).
 *
 * Subcommands:
 *   plan     — print the create/destroy/host-prep script for a branch
 *              (OFFLINE: no network, no SSH, no state writes — review first).
 *   create   — allocate name+port, push the create script over ONE pinned SSH
 *              connection, parse phase markers, record the env on success.
 *   list     — table/JSON of envs on a VM (offline).
 *   destroy  — push the destroy script, remove the env record.
 *
 * SOLO topology (Tanya301/field-record-1#117): production and previews share
 * one VM. Production is the registered app itself (`app deploy`); previews are
 * env records — `<app>-<branch-label>.<previewDomain>`, default previewDomain
 * `samo.cat`, e.g. `field-record-1-feat-x.samo.cat`.
 *
 * All effects (SSH spawn, clock, uuid) are injected so the flows unit-test
 * offline, mirroring commands/app.ts.
 */

import { spawnSync } from "node:child_process";
import { parseEnvOutcome, type EnvOutcome } from "../env/parse.ts";
import { envName } from "../env/name.ts";
import { allocatePort, DEFAULT_POOL, type PortPool } from "../env/ports.ts";
import {
  buildEnvCreateScript,
  buildEnvDestroyScript,
  buildHostPrepScript,
  targetFromRecord,
  type EnvScriptTarget,
} from "../env/script.ts";
import { AppStore } from "../state/apps.ts";
import { EnvStore } from "../state/envs.ts";
import { StateStore } from "../state/store.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import type {
  AppRecord,
  EnvDbBackend,
  EnvRecord,
  VmRecord,
} from "../types.ts";

/** Default preview domain for the SOLO plan (issue #117). */
export const DEFAULT_PREVIEW_DOMAIN = "samo.cat";

// ---------------------------------------------------------------------------
// Parsed inputs (produced by the CLI parser)
// ---------------------------------------------------------------------------

export interface EnvPlanInput {
  vm: string;
  app: string;
  /** Branch is required unless hostPrep is set. */
  branch?: string;
  db: EnvDbBackend;
  previewDomain: string;
  /** Print the destroy script instead of the create script. */
  destroy: boolean;
  /** Print the one-time root host-prep script instead. */
  hostPrep: boolean;
}

export interface EnvCreateInput {
  vm: string;
  app: string;
  branch: string;
  db: EnvDbBackend;
  previewDomain: string;
}

export interface EnvListInput {
  vm: string;
  app?: string;
}

export interface EnvDestroyInput {
  vm: string;
  app: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Shared lookups / derivation
// ---------------------------------------------------------------------------

function findVm(store: StateStore, target: string): VmRecord | undefined {
  return store.list().find((r) => r.id === target || r.name === target);
}

interface Resolved {
  vm: VmRecord;
  app: AppRecord;
}

function resolve(
  vmStore: StateStore,
  appStore: AppStore,
  vmTarget: string,
  appTarget: string,
  err: (s: string) => void,
): Resolved | undefined {
  const vm = findVm(vmStore, vmTarget);
  if (vm === undefined) {
    err(`error: VM not found in state: ${vmTarget}`);
    return undefined;
  }
  const app = appStore.get(vm.id, appTarget);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${appTarget}`);
    return undefined;
  }
  return { vm, app };
}

/**
 * Derive the script target for a NEW env of (app, branch): sanitized name
 * (collision-aware against existing envs), lowest free port from the pool,
 * vhost under the preview domain. Pure given the existing-env snapshot.
 */
export function deriveTarget(
  app: AppRecord,
  branch: string,
  db: EnvDbBackend,
  previewDomain: string,
  existingOnVm: readonly EnvRecord[],
  pool: PortPool = DEFAULT_POOL,
): EnvScriptTarget | { error: string } {
  const names = new Map(existingOnVm.map((e) => [e.name, e.branch]));
  const name = envName(app.name, branch, names);
  const port = allocatePort(
    existingOnVm.map((e) => e.port),
    pool,
  );
  if (port === undefined) {
    return {
      error:
        `port pool exhausted (${pool.size} ports from ${pool.base}) — ` +
        `destroy stale envs before creating new ones`,
    };
  }
  return {
    name,
    branch,
    port,
    vhost: `${name}.${previewDomain}`,
    dbBackend: db,
    ...(db === "dblab" ? { dbName: name } : {}),
    ...(db === "template" ? { dbName: name.replace(/-/g, "_") } : {}),
  };
}

// ---------------------------------------------------------------------------
// plan (offline)
// ---------------------------------------------------------------------------

export function runEnvPlan(
  input: EnvPlanInput,
  _opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  envStore: EnvStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const r = resolve(vmStore, appStore, input.vm, input.app, err);
  if (r === undefined) return 1;

  if (input.hostPrep) {
    out(buildHostPrepScript(r.app, r.vm.sshUser));
    return 0;
  }

  if (input.branch === undefined) {
    err("error: --branch is required (unless --host-prep)");
    return 1;
  }

  // Prefer the persisted record (stable name/port) when the env exists.
  const existing = envStore.get(r.vm.id, r.app.name, input.branch);
  const target = existing
    ? targetFromRecord(existing)
    : deriveTarget(
        r.app,
        input.branch,
        input.db,
        input.previewDomain,
        envStore.listFor(r.vm.id),
      );
  if ("error" in target) {
    err(`error: ${target.error}`);
    return 1;
  }

  out(
    input.destroy
      ? buildEnvDestroyScript(r.app, target)
      : buildEnvCreateScript(r.app, target),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// list (offline)
// ---------------------------------------------------------------------------

export function runEnvList(
  input: EnvListInput,
  opts: { json: boolean },
  vmStore: StateStore,
  envStore: EnvStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }
  const envs = envStore.listFor(vm.id, input.app);
  if (opts.json) {
    out(JSON.stringify(envs, null, 2));
    return 0;
  }
  if (envs.length === 0) {
    out(`no envs on vm ${vm.name}`);
    return 0;
  }
  out(
    [
      "APP            BRANCH                NAME                                     PORT  DB        VHOST",
      ...envs.map(
        (e) =>
          `${e.appName.padEnd(14)} ${e.branch.padEnd(21)} ${e.name.padEnd(40)} ` +
          `${String(e.port).padEnd(5)} ${e.dbBackend.padEnd(9)} ${e.vhost}`,
      ),
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// create / destroy (remote, injected runner)
// ---------------------------------------------------------------------------

/** Injectable remote runner: run a script (passed on stdin) on the VM. */
export type RemoteScriptRunner = (
  vm: VmRecord,
  script: string,
) => Promise<SpawnResult>;

export interface EnvExecDeps {
  remote: RemoteScriptRunner;
  now: () => Date;
  uuid: () => string;
}

export interface EnvCreateReport {
  env: string;
  vm: string;
  app: string;
  branch: string;
  port: number;
  vhost: string;
  db: EnvDbBackend;
  outcome: EnvOutcome;
  exitCode: number;
}

export async function runEnvCreate(
  input: EnvCreateInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  envStore: EnvStore,
  deps: EnvExecDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const r = resolve(vmStore, appStore, input.vm, input.app, err);
  if (r === undefined) return 1;

  const existing = envStore.get(r.vm.id, r.app.name, input.branch);
  // Re-create reuses the recorded name/port (idempotent re-run after a failed
  // create); a fresh env allocates.
  const target = existing
    ? targetFromRecord(existing)
    : deriveTarget(
        r.app,
        input.branch,
        input.db,
        input.previewDomain,
        envStore.listFor(r.vm.id),
      );
  if ("error" in target) {
    err(`error: ${target.error}`);
    return 1;
  }

  const script = buildEnvCreateScript(r.app, target);
  let result: SpawnResult;
  try {
    result = await deps.remote(r.vm, script);
  } catch (e) {
    err(
      `error: remote env-create connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }

  const { outcome } = parseEnvOutcome(result.stdout + "\n" + result.stderr);

  // Record on success — AND on failure, so the allocated name/port are pinned
  // for an idempotent re-run / destroy-cleanup. Failed envs are visible in
  // `env list` rather than silently leaking host-side residue.
  const record: EnvRecord = {
    id: existing?.id ?? deps.uuid(),
    vmId: r.vm.id,
    appName: r.app.name,
    branch: input.branch,
    name: target.name,
    port: target.port,
    vhost: target.vhost,
    dbBackend: target.dbBackend,
    ...(target.dbName !== undefined ? { dbName: target.dbName } : {}),
    createdAt: existing?.createdAt ?? deps.now().toISOString(),
  };
  envStore.upsert(record);

  const exitCode = outcome === "ok" ? 0 : 1;
  const report: EnvCreateReport = {
    env: target.name,
    vm: r.vm.name,
    app: r.app.name,
    branch: input.branch,
    port: target.port,
    vhost: target.vhost,
    db: target.dbBackend,
    outcome,
    exitCode,
  };
  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(
      `env ${target.name} (${input.branch}) on ${r.vm.name}: ${outcome}` +
        (outcome === "ok" ? ` — https://${target.vhost}` : ""),
    );
    if (outcome !== "ok") {
      err(
        `env create did not succeed (outcome=${outcome}); the partial env is ` +
          `recorded — re-run create (idempotent) or destroy to clean up`,
      );
    }
  }
  return exitCode;
}

export async function runEnvDestroy(
  input: EnvDestroyInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  envStore: EnvStore,
  deps: EnvExecDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const r = resolve(vmStore, appStore, input.vm, input.app, err);
  if (r === undefined) return 1;

  const env = envStore.get(r.vm.id, r.app.name, input.branch);
  if (env === undefined) {
    err(
      `error: no env recorded for branch ${input.branch} of ${r.app.name} on ${r.vm.name}`,
    );
    return 1;
  }

  const script = buildEnvDestroyScript(r.app, targetFromRecord(env));
  let result: SpawnResult;
  try {
    result = await deps.remote(r.vm, script);
  } catch (e) {
    err(
      `error: remote env-destroy connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }

  const { outcome } = parseEnvOutcome(result.stdout + "\n" + result.stderr);
  if (outcome !== "ok") {
    // Keep the record: host-side residue likely remains; destroy is idempotent.
    err(
      `error: env destroy did not complete (outcome=${outcome}); record kept — re-run destroy`,
    );
    return 1;
  }

  envStore.remove(r.vm.id, r.app.name, input.branch);
  if (opts.json) {
    out(JSON.stringify({ env: env.name, vm: r.vm.name, outcome }, null, 2));
  } else {
    out(`env ${env.name} destroyed on ${r.vm.name}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Production dependency wiring (not exercised by unit tests)
// ---------------------------------------------------------------------------

/** Run ssh with the env script on stdin (`bash -s`) over the pinned runner. */
function defaultRemoteScriptRunner(): RemoteScriptRunner {
  return (vm, script) => {
    const deps: RunDeps = {
      clock: () => Date.now(),
      knownHostsDir:
        process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
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
    return runRemote(vm, "bash -s", deps);
  };
}

/** Default production env-exec deps. */
export function defaultEnvExecDeps(): EnvExecDeps {
  return {
    remote: defaultRemoteScriptRunner(),
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
  };
}

/** Construct the default env store (honors SAMOHOST_ENVS). */
export function defaultEnvStore(): EnvStore {
  return new EnvStore();
}
