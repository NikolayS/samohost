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
import { buildAuditScript, parseAuditOutput } from "../audit/batch.ts";
import {
  DBLAB_PROBES,
  evaluateDblabPreflight,
  type DblabPreflightReport,
} from "../dblab/preflight.ts";
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
  /** Template database override for the `template` backend (issue #11 f6). */
  templateDb?: string;
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
  /** Template database override for the `template` backend (issue #11 f6).
   * Persisted on the EnvRecord so re-create/destroy reuse it. */
  templateDb?: string;
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
 * A preview domain must be a well-formed dotted DNS name (e.g. `samo.cat`):
 * at least two labels, each label [a-z0-9] with internal hyphens allowed, no
 * leading/trailing hyphen or dot, total length sane. This is deliberately
 * strict — anything that fails here (incl. the value `undefined`, "", or a
 * single label) would otherwise render an unservable vhost.
 */
export function isValidPreviewDomain(domain: unknown): domain is string {
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 253) {
    return false;
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  // ≥2 labels, lowercase; the final label (TLD) must be alphabetic.
  return new RegExp(
    `^${label}(?:\\.${label})*\\.[a-z]{2,63}$`,
  ).test(domain.toLowerCase()) && domain === domain.toLowerCase();
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
  templateDb?: string,
): EnvScriptTarget | { error: string } {
  // Fail closed on a bad preview domain. The TS type says `string`, but JS
  // callers (e.g. an ad-hoc driver reading a nonexistent `app.previewDomain`
  // field) can pass `undefined`, which a template literal turns into the
  // literal vhost `<name>.undefined`. That bogus vhost was written to a live
  // Caddy snippet and broke every *.samo.cat preview (field-record-1#117 →
  // HTTP 525). Validate here so an invalid domain can never reach a vhost.
  if (!isValidPreviewDomain(previewDomain)) {
    return {
      error:
        `invalid preview domain ${JSON.stringify(previewDomain)} — expected a ` +
        `dotted DNS name like "samo.cat" (set --preview-domain or fix the caller)`,
    };
  }
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
    ...(db === "template" && templateDb !== undefined ? { templateDb } : {}),
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
        DEFAULT_POOL,
        input.templateDb,
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
        DEFAULT_POOL,
        input.templateDb,
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
    ...(target.templateDb !== undefined ? { templateDb: target.templateDb } : {}),
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
          `recorded — re-run create (idempotent; NOTE: a re-run drops and ` +
          `recreates the per-env database) or destroy to clean up`,
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
// preflight (remote read-only probes, ONE connection)
// ---------------------------------------------------------------------------

export interface EnvPreflightInput {
  vm: string;
}

/**
 * Run the DBLab/preview readiness probes (dblab/preflight.ts) over one SSH
 * connection and print READY/BLOCKED/UNKNOWN with reasons. Exit 0 only when
 * the dblab engine gate is READY (the template fallback's state is reported
 * but does not gate the exit code — `--db template` is chosen explicitly).
 */
export async function runEnvPreflight(
  input: EnvPreflightInput,
  opts: { json: boolean },
  vmStore: StateStore,
  deps: EnvExecDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }

  const script = buildAuditScript(DBLAB_PROBES);
  let result: SpawnResult;
  try {
    result = await deps.remote(vm, script);
  } catch (e) {
    err(
      `error: remote preflight connection failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }

  const sections = parseAuditOutput(result.stdout, DBLAB_PROBES);
  const report: DblabPreflightReport = evaluateDblabPreflight(sections);

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(`dblab engine: ${report.engine}`);
    out(`template fallback: ${report.templateFallback}`);
    for (const c of report.checks) {
      out(`  [${c.status.padEnd(7)}] ${c.id}: ${c.detail.split("\n")[0]}`);
    }
    for (const r of report.reasons) out(`  - ${r}`);
  }
  return report.engine === "READY" ? 0 : 1;
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
