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
import { CloudflareDns, type DnsProviderPort } from "../dns/cloudflare.ts";
import { ensurePreviewDns, removePreviewDns } from "../dns/ensure.ts";

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
  /**
   * Optional DNS provider factory for per-VM preview DNS (issue #37).
   *
   * The field is OPTIONAL (`?:`) so that the 628 existing test fixtures that
   * build `{ remote, now, uuid }` continue to compile and run unchanged.
   * When absent (or the factory returns `undefined`), DNS operations are
   * skipped and a single warning is emitted via `err`.
   *
   * Returns a DnsProviderPort or undefined when no credentials are available.
   */
  dns?: () => DnsProviderPort | undefined;
  /**
   * Optional external HTTPS probe for the real reachability gate (issue #55).
   *
   * The field is OPTIONAL (`?:`) so all existing test fixtures that build
   * `{ remote, now, uuid }` keep compiling unchanged. When absent, no
   * external gate is applied (back-compat). When present, it is called with
   * `https://<vhost>/` after a successful on-host create and must return
   * `{ status, ok }` — any non-200 or thrown error is treated as failure.
   *
   * In production this is wired to `global fetch`. In unit tests pass a
   * deterministic fake; never use a real network in tests.
   */
  httpProbe?: (url: string) => Promise<{ status: number; ok: boolean }>;
  /**
   * Optional injectable sleep used between external probe retry attempts
   * (issue #55). Defaults to a real Promise-based setTimeout in production.
   * Inject a no-op in unit tests so they don't sleep 25s.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Warning emitted when no DNS provider is configured.
 *
 * CLOUDFLARE_SAMOCAT is the only required env var (issue #54): samohost
 * resolves the zone id itself via zones:list when SAMOHOST_SAMOCAT_ZONE_ID is
 * unset, so omitting it is no longer an error — only the token is required.
 */
const DNS_DEGRADE_WARNING =
  "samohost: CLOUDFLARE_SAMOCAT not set — " +
  "skipping per-preview DNS (relying on a wildcard A record); previews on a " +
  "VM not covered by the wildcard will not resolve";

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

// ---------------------------------------------------------------------------
// External HTTPS probe constants (issue #55)
// ---------------------------------------------------------------------------

/**
 * Maximum number of external probe attempts after a successful on-host create.
 * SAFETY CAP — not a target. Returns as soon as the first 200 is received.
 * Worst-case added wall-clock: EXTERNAL_PROBE_RETRIES × EXTERNAL_PROBE_SLEEP_MS
 * = 8 × 5000ms = 40s (bumped from 5 to accommodate CF edge provisioning lag).
 */
const EXTERNAL_PROBE_RETRIES = 8;

/** Exported alias used by unit tests to assert the cap value. */
export const EXTERNAL_PROBE_RETRIES_EXPORT = EXTERNAL_PROBE_RETRIES;

/**
 * Milliseconds to sleep between external probe retry attempts.
 * SAFETY CAP — not a target; the sleep only fires if the previous attempt
 * did not return 200.
 */
const EXTERNAL_PROBE_SLEEP_MS = 5000;

// ---------------------------------------------------------------------------
// Curl-based HTTPS probe helpers (issue #55 / Bun-fetch CA bug fix)
//
// Background: Bun's global fetch cannot reliably verify the Cloudflare edge
// cert chain (Google Trust Services WE1 ← GTS Root R4 ← GlobalSign) on
// certain hostnames. Observed: game-changers-demo-red-bg.samo.cat throws
// "unable to get local issuer certificate" on 12/12 consecutive attempts,
// while system curl returns HTTP 200 on 5/5 (same cert chain). System curl
// uses the OS CA bundle which verifies the CF chain correctly.
//
// The production httpProbe is replaced with a spawnSync curl invocation.
// TLS verification is ON (no -k / --insecure): a cert that does not verify
// MUST count as a probe failure; we cannot declare a preview "reachable" if
// its TLS is broken.
// ---------------------------------------------------------------------------

/**
 * Build the curl argument list for a single external probe attempt.
 *
 * Flags:
 *   -sS          silent (suppress progress), but still emit errors to stderr
 *   -o /dev/null discard response body
 *   -w %{http_code}  write only the numeric HTTP status code to stdout
 *   --max-time 10    hard limit 10s per attempt
 *   --proto =https   allow HTTPS only (no http:// downgrade)
 *   (NO -k / --insecure — full TLS cert verification required)
 *   (NO -L / --location — do not follow redirects; only 200 is success)
 */
export function buildCurlProbeArgs(url: string): string[] {
  return [
    "curl",
    "-sS",
    "-o", "/dev/null",
    "-w", "%{http_code}",
    "--max-time", "10",
    "--proto", "=https",
    url,
  ];
}

/**
 * Parse the output of a curl invocation that used `-w %{http_code}`.
 *
 * @param stdout  - stdout from curl (the numeric HTTP status code, e.g. "200")
 * @param exitCode - curl's exit code (0 = success, non-zero = error/TLS fail/timeout)
 *
 * Rules:
 *   - Non-zero exit code always → ok:false (covers TLS errors, DNS failures,
 *     timeouts, etc.)
 *   - stdout "000" (connection-level failure while exit=0 is unusual but
 *     possible in some curl versions) → status:0, ok:false
 *   - status === 200 AND exit 0 → ok:true
 *   - any other parseable status → ok:false (3xx not followed, 5xx, 4xx)
 *   - unparseable stdout → status:0, ok:false
 */
export function parseCurlProbeResult(
  stdout: string,
  exitCode: number,
): { status: number; ok: boolean } {
  // Non-zero exit = curl encountered an error (TLS, DNS, timeout, etc.)
  if (exitCode !== 0) {
    return { status: 0, ok: false };
  }
  const trimmed = stdout.trim();
  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    return { status: 0, ok: false };
  }
  // "000" is curl's sentinel for connection-level failure (cert error, etc.)
  if (parsed === 0) {
    return { status: 0, ok: false };
  }
  return { status: parsed, ok: parsed === 200 };
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

  // Ensure the per-preview DNS A record BEFORE pushing the create script so
  // the first ACME HTTP-01 challenge from Caddy can resolve to this VM's IP.
  const dnsProvider = deps.dns?.();
  if (dnsProvider !== undefined) {
    try {
      await ensurePreviewDns(dnsProvider, target.vhost, r.vm.ip);
    } catch (e) {
      err(
        `samohost: warning: DNS ensure failed for ${target.vhost} — ` +
          `${e instanceof Error ? e.message : String(e)}; continuing create`,
      );
    }
  } else {
    err(DNS_DEGRADE_WARNING);
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

  let { outcome } = parseEnvOutcome(result.stdout + "\n" + result.stderr);

  // External HTTPS reachability gate (issue #55).
  //
  // Root cause: the on-host health phase runs `curl http://localhost:PORT/`
  // inside the remote bash script, so it returns ok even when the preview
  // URL is EXTERNALLY unreachable (TLS not provisioned, DNS not propagated,
  // Caddy not listening on the public port, etc.).
  //
  // When httpProbe is wired AND the on-host outcome is ok, probe the public
  // URL to get real external confirmation before reporting success. If all
  // attempts fail, downgrade outcome to "failed" and exit 1. The env record
  // is still persisted for an idempotent re-run (same as a failed on-host
  // create). DNS record is kept (re-create reuses it).
  if (outcome === "ok" && deps.httpProbe !== undefined) {
    const probeUrl = `https://${target.vhost}/`;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let probeOk = false;
    for (let attempt = 0; attempt < EXTERNAL_PROBE_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(EXTERNAL_PROBE_SLEEP_MS);
      }
      try {
        const probeResult = await deps.httpProbe(probeUrl);
        lastStatus = probeResult.status;
        if (probeResult.ok) {
          probeOk = true;
          break;
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!probeOk) {
      outcome = "failed";
      const detail =
        lastError !== undefined
          ? `error: ${lastError}`
          : `HTTP ${lastStatus}`;
      err(
        `samohost: external probe failed for https://${target.vhost}/ — ` +
          `on-host phases passed but the public URL is unreachable (${detail}); ` +
          `env record kept for inspection — re-run create or destroy to clean up`,
      );
    }
  }

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

  // Remove the per-preview DNS A record after a successful destroy.
  // On DNS failure, warn and continue — the local record is still removed and
  // the stale proxied DNS entry is harmless once the origin no longer responds
  // (CF will return a 521/522 for the vhost, which is an acceptable failure
  // mode for a destroyed env).
  const dnsProvider = deps.dns?.();
  if (dnsProvider !== undefined) {
    try {
      await removePreviewDns(dnsProvider, env.vhost);
    } catch (e) {
      err(
        `samohost: warning: DNS remove failed for ${env.vhost} — ` +
          `${e instanceof Error ? e.message : String(e)}; record still removed locally`,
      );
    }
  } else {
    err(DNS_DEGRADE_WARNING);
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
    // Per-preview DNS factory (issue #37, updated issue #54).
    //
    // CLOUDFLARE_SAMOCAT is intentionally a SEPARATE env var from
    // CLOUDFLARE_API_TOKEN used by `dns status`. That token is a broad
    // read/write API token; CLOUDFLARE_SAMOCAT is a zone-scoped write
    // token for samo.cat ONLY. They must remain separate — granting
    // samo.cat write access to the global read token would be over-privileged.
    //
    // SAMOHOST_SAMOCAT_ZONE_ID is now OPTIONAL (issue #54): CLOUDFLARE_SAMOCAT
    // has zones:list scope, so samohost resolves the zone id itself when the
    // env var is unset. CloudflareDns accepts `zoneName` and lazily resolves
    // the zone id on the first write call (one extra GET /zones?name=samo.cat,
    // result cached). SAMOHOST_SAMOCAT_ZONE_ID takes precedence when set
    // (zero-change for existing deployments that pin the zone id explicitly).
    //
    // DEFAULT_PREVIEW_DOMAIN ("samo.cat") is the only zone we have a
    // CLOUDFLARE_SAMOCAT token for, so it is the right fallback for zone
    // discovery when the zone-id env var is absent.
    dns: () => {
      const token = process.env["CLOUDFLARE_SAMOCAT"];
      if (!token) {
        // Caller checks for undefined and emits the degrade warning.
        return undefined;
      }
      const zoneId = process.env["SAMOHOST_SAMOCAT_ZONE_ID"];
      return new CloudflareDns({
        token,
        ...(zoneId ? { zoneId } : { zoneName: DEFAULT_PREVIEW_DOMAIN }),
      });
    },
    // External HTTPS reachability probe (issue #55, curl-CA fix).
    //
    // REPLACES the previous Bun-fetch implementation which produced
    // FALSE-NEGATIVE failures: Bun's fetch cannot reliably verify the
    // Cloudflare GTS-WE1 edge cert chain on some hostnames
    // (game-changers-demo-red-bg.samo.cat: 12/12 attempts threw
    // "unable to get local issuer certificate"; same cert chain on
    // field-record-demo-red-login.samo.cat returned 200 — opposite result).
    // System curl uses the OS CA bundle which verifies the CF chain correctly.
    //
    // TLS verification is ON (no -k / --insecure). A cert that does not
    // verify is a probe FAILURE — we cannot declare a preview "reachable"
    // when TLS is broken. curl exits non-zero on TLS errors; parseCurlProbeResult
    // maps that to { status: 0, ok: false } which the retry loop treats as a
    // failed attempt (same as a thrown error in the old fetch path).
    //
    // redirect:"manual" behavior is preserved by NOT passing -L / --location:
    // curl returns the 3xx status code directly (not followed), which
    // parseCurlProbeResult maps to ok:false — same as before.
    httpProbe: (url: string) => {
      const args = buildCurlProbeArgs(url);
      const res = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
      const exitCode = typeof res.status === "number" ? res.status : 1;
      return Promise.resolve(parseCurlProbeResult(res.stdout ?? "", exitCode));
    },
    // Promise-based sleep wired to real setTimeout.
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Construct the default env store (honors SAMOHOST_ENVS). */
export function defaultEnvStore(): EnvStore {
  return new EnvStore();
}
