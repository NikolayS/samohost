#!/usr/bin/env bun
/**
 * samohost CLI entry (SPEC §4 CLI layer).
 *
 * Pure argument parsing → typed command requests, plus the process exit-code
 * contract. v0.1 wires only `preview` (offline); other commands are scaffolded.
 *
 * Exit codes:
 *   0  success
 *   1  validation / runtime error
 *   2  usage error (unknown command/flag, bad args)
 */

import { readFileSync } from "node:fs";
import type { Provider, ProvisionSpec } from "./types.ts";
import { runPreview } from "./commands/preview.ts";
import { runAdopt, type AdoptInput } from "./commands/adopt.ts";
import { runList } from "./commands/list.ts";
import { runStatus, type StatusInput } from "./commands/status.ts";
import {
  runAppRegister,
  runAppPlan,
  runAppDeploy,
  runAppStatus,
  runAppClearFailed,
  defaultAppDeployDeps,
  defaultAppStore,
  type AppRegisterInput,
  type AppPlanInput,
  type AppDeployInput,
  type AppStatusInput,
  type AppClearFailedInput,
} from "./commands/app.ts";
import {
  runEnvPlan,
  runEnvCreate,
  runEnvList,
  runEnvDestroy,
  runEnvPreflight,
  defaultEnvExecDeps,
  defaultEnvStore,
  DEFAULT_PREVIEW_DOMAIN,
  type EnvPlanInput,
  type EnvCreateInput,
  type EnvListInput,
  type EnvDestroyInput,
  type EnvPreflightInput,
} from "./commands/env.ts";
import {
  runDnsStatus,
  defaultDnsStatusDeps,
  DEFAULT_CLOUDFLARE_ZONES,
  type DnsStatusInput,
} from "./commands/dns.ts";
import { StateStore } from "./state/store.ts";
import type { EnvDbBackend } from "./types.ts";

export const VERSION = "0.1.0";

const HELP = `samohost ${VERSION} — provision security-hardened Linux VMs

Usage:
  samohost preview --provider <hetzner|aws> --region <r> --type <t> \\
      --ssh-pubkey <key|@file> [options]
  samohost adopt --name <n> --ip <ip> --ssh-user <u> --ssh-key <path> \\
      --host-key-fingerprint 'SHA256:...' [options]
  samohost list [--json]
  samohost status <vm-name-or-id> [--audit] [--json]
  samohost app register <vm> --name <n> --repo <owner/name> \\
      --service-unit <u> --health-url <url> [options]
  samohost app plan <vm> <app> --sha <sha>
  samohost app deploy <vm> <app> [--sha <sha> | --ref <ref>] \\
      [--skip-ci-gate] [--force] [--json]
  samohost app status <vm> <app> [--json]
  samohost app clear-failed <vm> <app> [--json]
  samohost env plan <vm> <app> (--branch <b> [--destroy] | --host-prep) [options]
  samohost env create <vm> <app> --branch <b> [--db dblab|template|none] [--json]
  samohost env list <vm> [--app <name>] [--json]
  samohost env destroy <vm> <app> --branch <b> [--json]
  samohost env preflight <vm> [--json]
  samohost dns status <domain> [--expect-ip <ip>] [--cf-zone <z>] [--json]
  samohost --help
  samohost --version

preview options:
  --provider <hetzner|aws>   cloud provider (required)
  --region <region>          provider region (required)
  --type <type>              server type / instance size (required)
  --ssh-pubkey <key|@file>   SSH public key text, or @/path/to/key.pub (required)
  --name <name>              VM name (default: samohost-<provider>)
  --module <name>            optional module (repeatable)
  --ssh-port <port>          hardened SSH port (default: 2223)
  --admin-user <user>        non-root sudo user (default: samo)
  --trusted-ip <ip>          never-banned IP for fail2ban (repeatable)
  --timeout <seconds>        boot-ready timeout (default: 600)
  --json                     emit a JSON envelope instead of raw YAML

adopt options (register an existing hardened VM, no network call):
  --name <name>                       VM name (required)
  --ip <ipv4|ipv6>                    reachable address (required)
  --ssh-user <user>                   remote login user (required)
  --ssh-key <path>                    private key path, ~ expanded (required)
  --host-key-fingerprint <SHA256:..>  out-of-band verified host key (REQUIRED)
  --ssh-port <port>                   SSH port (default: 22)
  --provider <hetzner|aws>            optional provider tag
  --provider-id <id>                  optional provider-native resource id
  --region <region>                   optional region tag
  --type <type>                       optional server type tag
  --json                              print the raw record as JSON

list options:
  --json                     emit the raw records array instead of a table

status options:
  --audit                    run live hardening probes over pinned SSH
  --json                     emit a JSON status/audit result

app register options (write an AppRecord; offline, no network):
  <vm>                       VM name or id the app deploys on (required)
  --name <name>              app name, unique per VM (required)
  --repo <owner/name>        GitHub repo (required)
  --service-unit <unit>      systemd unit restarted on deploy (required)
  --health-url <url>         post-deploy health URL (required)
  --branch <branch>          tracked branch (default: main)
  --app-dir <path>           remote checkout dir (default: /opt/<name>/app)
  --build-cmd <cmd>          build command (default: npm run build)
  --migrate-cmd <cmd>        optional migration command
  --seed-cmd <cmd>           optional idempotent seed command
  --env-file <path>          remote env file; sourced (read-only) by the deploy
                             script before install — NEVER written by samohost
  --assert-rls               require app to connect as a non-superuser (RLS gate)
  --rls-url-var <NAME>       env var holding the NON-superuser URL the RLS probe
                             uses (default: RLS_DATABASE_URL || DATABASE_URL)
  --json                     print the raw record as JSON

app deploy options:
  --sha <sha>                explicit SHA to deploy (mutually exclusive w/ --ref)
  --ref <ref>                git ref resolved to a SHA via gh api (default: branch)
  --skip-ci-gate             bypass the GitHub Actions CI-green gate (risky)
  --force                    bypass the known-bad-SHA guard (logged loudly; for
                             recovering from a false rollback)
  --json                     emit a JSON deploy report

app clear-failed (offline; clears the known-bad-SHA guard record):
  clears the app's recorded failedSha so deploys of that commit are no
  longer refused — use after a rollback caused by a tooling defect (e.g.
  a misconfigured RLS probe), when the commit itself was healthy

env options (per-branch preview environments — SOLO plan, one shared VM):
  --branch <branch>          git branch the env tracks (required except --host-prep)
  --db <dblab|template|none> per-env database backend (default: dblab)
  --preview-domain <domain>  vhost domain (default: ${DEFAULT_PREVIEW_DOMAIN};
                             vhost = <app>-<branch-label>.<domain>)
  --destroy                  (plan) print the destroy script instead of create
  --host-prep                (plan) print the ONE-TIME root host-prep script
  --app <name>               (list) narrow to one app
  --json                     emit JSON instead of text

env preflight (READ-ONLY probes over one SSH connection):
  reports dblab engine READY/BLOCKED/UNKNOWN (gate for --db dblab) and the
  template-fallback readiness, with per-check detail and reasons

dns status options (READ-ONLY: public NS/A lookups + token PRESENCE check):
  --expect-ip <ip>           IP the preview wildcard must point at
  --cf-zone <zone>           zone the local Cloudflare token/config covers
                             (repeatable; default: ${DEFAULT_CLOUDFLARE_ZONES.join(", ")})
  --json                     emit the JSON report
`;

export interface ParsedPreview {
  kind: "preview";
  spec: ProvisionSpec;
  sshPubkey: string;
  json: boolean;
}

export interface ParsedAdopt {
  kind: "adopt";
  input: AdoptInput;
  json: boolean;
}

export interface ParsedList {
  kind: "list";
  json: boolean;
}

export interface ParsedStatus {
  kind: "status";
  input: StatusInput;
  json: boolean;
}

export interface ParsedAppRegister {
  kind: "app-register";
  input: AppRegisterInput;
  json: boolean;
}

export interface ParsedAppPlan {
  kind: "app-plan";
  input: AppPlanInput;
  json: boolean;
}

export interface ParsedAppDeploy {
  kind: "app-deploy";
  input: AppDeployInput;
  json: boolean;
}

export interface ParsedAppStatus {
  kind: "app-status";
  input: AppStatusInput;
  json: boolean;
}

export interface ParsedAppClearFailed {
  kind: "app-clear-failed";
  input: AppClearFailedInput;
  json: boolean;
}

export interface ParsedEnvPlan {
  kind: "env-plan";
  input: EnvPlanInput;
  json: boolean;
}

export interface ParsedEnvCreate {
  kind: "env-create";
  input: EnvCreateInput;
  json: boolean;
}

export interface ParsedEnvList {
  kind: "env-list";
  input: EnvListInput;
  json: boolean;
}

export interface ParsedEnvDestroy {
  kind: "env-destroy";
  input: EnvDestroyInput;
  json: boolean;
}

export interface ParsedEnvPreflight {
  kind: "env-preflight";
  input: EnvPreflightInput;
  json: boolean;
}

export interface ParsedDnsStatus {
  kind: "dns-status";
  input: DnsStatusInput;
  json: boolean;
}

export type ParsedCommand =
  | ParsedPreview
  | ParsedAdopt
  | ParsedList
  | ParsedStatus
  | ParsedAppRegister
  | ParsedAppPlan
  | ParsedAppDeploy
  | ParsedAppStatus
  | ParsedAppClearFailed
  | ParsedEnvPlan
  | ParsedEnvCreate
  | ParsedEnvList
  | ParsedEnvDestroy
  | ParsedEnvPreflight
  | ParsedDnsStatus
  | { kind: "help" }
  | { kind: "version" };

/** Raised for usage errors → exit 2. */
export class UsageError extends Error {}

const PROVIDERS: readonly Provider[] = ["hetzner", "aws"];

function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Pure argument parser. Throws {@link UsageError} on bad usage. Does NOT read
 * files unless `resolvePubkeyFile` is provided (so it's unit-testable offline);
 * the CLI passes a reader that handles the `@file` form.
 */
export function parseArgs(
  argv: string[],
  resolvePubkeyFile: (path: string) => string = readPubkeyFile,
): ParsedCommand {
  if (argv.length === 0) return { kind: "help" };

  const first = argv[0]!;
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version" || first === "-v") return { kind: "version" };

  if (first === "preview") {
    return parsePreview(argv.slice(1), resolvePubkeyFile);
  }
  if (first === "adopt") {
    return parseAdopt(argv.slice(1));
  }
  if (first === "list") {
    return parseList(argv.slice(1));
  }
  if (first === "status") {
    return parseStatus(argv.slice(1));
  }
  if (first === "app") {
    return parseApp(argv.slice(1));
  }
  if (first === "env") {
    return parseEnv(argv.slice(1));
  }
  if (first === "dns") {
    return parseDns(argv.slice(1));
  }

  // A bare --help/--version may also appear after an (absent) command.
  if (first.startsWith("-")) {
    throw new UsageError(`unknown flag: ${first}`);
  }
  throw new UsageError(`unknown command: ${first}`);
}

function parsePreview(
  args: string[],
  resolvePubkeyFile: (path: string) => string,
): ParsedPreview {
  let provider: string | undefined;
  let region: string | undefined;
  let type: string | undefined;
  let name: string | undefined;
  let sshPubkeyRaw: string | undefined;
  let sshPort = 2223;
  let adminUser = "samo";
  let timeoutSec = 600;
  let json = false;
  const modules: string[] = [];
  const trustedIps: string[] = [];

  const next = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) throw new UsageError(`missing value for ${flag}`);
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--provider":
        provider = next(i, a);
        i++;
        break;
      case "--region":
        region = next(i, a);
        i++;
        break;
      case "--type":
        type = next(i, a);
        i++;
        break;
      case "--name":
        name = next(i, a);
        i++;
        break;
      case "--ssh-pubkey":
        sshPubkeyRaw = next(i, a);
        i++;
        break;
      case "--module":
        modules.push(next(i, a));
        i++;
        break;
      case "--trusted-ip":
        trustedIps.push(next(i, a));
        i++;
        break;
      case "--ssh-port":
        sshPort = parseIntFlag(next(i, a), a);
        i++;
        break;
      case "--admin-user":
        adminUser = next(i, a);
        i++;
        break;
      case "--timeout":
        timeoutSec = parseIntFlag(next(i, a), a);
        i++;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new UsageError(`unknown flag: ${a}`);
    }
  }

  if (provider === undefined) throw new UsageError("--provider is required");
  if (!isProvider(provider)) {
    throw new UsageError(`invalid --provider: ${provider} (hetzner|aws)`);
  }
  if (region === undefined) throw new UsageError("--region is required");
  if (type === undefined) throw new UsageError("--type is required");
  if (sshPubkeyRaw === undefined) {
    throw new UsageError("--ssh-pubkey is required");
  }

  const sshPubkey = sshPubkeyRaw.startsWith("@")
    ? resolvePubkeyFile(sshPubkeyRaw.slice(1))
    : sshPubkeyRaw;

  const spec: ProvisionSpec = {
    provider,
    region,
    type,
    name: name ?? `samohost-${provider}`,
    sshKeyPath: sshPubkeyRaw.startsWith("@") ? sshPubkeyRaw.slice(1) : "",
    sshPort,
    adminUser,
    modules,
    trustedIps,
    timeoutSec,
  };

  return { kind: "preview", spec, sshPubkey, json };
}

function parseAdopt(args: string[]): ParsedAdopt {
  let name: string | undefined;
  let ip: string | undefined;
  let sshPort = 22;
  let sshUser: string | undefined;
  let sshKey: string | undefined;
  let hostKeyFingerprint: string | undefined;
  let provider: string | undefined;
  let providerId: string | undefined;
  let region: string | undefined;
  let type: string | undefined;
  let json = false;

  const next = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) throw new UsageError(`missing value for ${flag}`);
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--name":
        name = next(i, a);
        i++;
        break;
      case "--ip":
        ip = next(i, a);
        i++;
        break;
      case "--ssh-port":
        sshPort = parseIntFlag(next(i, a), a);
        i++;
        break;
      case "--ssh-user":
        sshUser = next(i, a);
        i++;
        break;
      case "--ssh-key":
        sshKey = next(i, a);
        i++;
        break;
      case "--host-key-fingerprint":
        hostKeyFingerprint = next(i, a);
        i++;
        break;
      case "--provider":
        provider = next(i, a);
        i++;
        break;
      case "--provider-id":
        providerId = next(i, a);
        i++;
        break;
      case "--region":
        region = next(i, a);
        i++;
        break;
      case "--type":
        type = next(i, a);
        i++;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new UsageError(`unknown flag: ${a}`);
    }
  }

  if (name === undefined) throw new UsageError("--name is required");
  if (ip === undefined) throw new UsageError("--ip is required");
  if (sshUser === undefined) throw new UsageError("--ssh-user is required");
  if (sshKey === undefined) throw new UsageError("--ssh-key is required");
  if (hostKeyFingerprint === undefined) {
    throw new UsageError(
      "--host-key-fingerprint is required: adopt pins the host key and all " +
        "later SSH uses StrictHostKeyChecking=yes, so out-of-band verification " +
        "of the fingerprint is mandatory (an unpinned host invites a MITM). " +
        "Get it with: ssh-keyscan -p <port> <ip> | ssh-keygen -lf -",
    );
  }
  let providerNarrowed: Provider | undefined;
  if (provider !== undefined) {
    if (!isProvider(provider)) {
      throw new UsageError(`invalid --provider: ${provider} (hetzner|aws)`);
    }
    providerNarrowed = provider;
  }

  const input: AdoptInput = {
    name,
    ip,
    sshPort,
    sshUser,
    sshKey,
    hostKeyFingerprint,
    ...(providerNarrowed !== undefined ? { provider: providerNarrowed } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(type !== undefined ? { type } : {}),
  };
  return { kind: "adopt", input, json };
}

function parseList(args: string[]): ParsedList {
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
    } else {
      throw new UsageError(`unknown flag: ${a}`);
    }
  }
  return { kind: "list", json };
}

function parseStatus(args: string[]): ParsedStatus {
  let target: string | undefined;
  let audit = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--audit":
        audit = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
        if (target !== undefined) {
          throw new UsageError(`unexpected extra argument: ${a}`);
        }
        target = a;
    }
  }

  if (target === undefined) {
    throw new UsageError("status requires a VM name or id");
  }
  return { kind: "status", input: { target, audit }, json };
}

type AppSub = "register" | "plan" | "deploy" | "status" | "clear-failed";

const APP_SUBS: readonly AppSub[] = [
  "register",
  "plan",
  "deploy",
  "status",
  "clear-failed",
];

function parseApp(args: string[]): ParsedCommand {
  const sub = args[0];
  if (sub === undefined) {
    throw new UsageError(
      `app requires a subcommand: ${APP_SUBS.join(" | ")}`,
    );
  }
  if (!(APP_SUBS as readonly string[]).includes(sub)) {
    throw new UsageError(`unknown app subcommand: ${sub}`);
  }
  const rest = args.slice(1);
  switch (sub as AppSub) {
    case "register":
      return parseAppRegister(rest);
    case "plan":
      return parseAppPlan(rest);
    case "deploy":
      return parseAppDeploy(rest);
    case "status":
      return parseAppStatus(rest);
    case "clear-failed":
      return parseAppClearFailed(rest);
  }
}

/** Shared: collect leading positional args (until the first flag). */
function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`missing value for ${flag}`);
  return v;
}

function parseAppRegister(args: string[]): ParsedAppRegister {
  let vm: string | undefined;
  let name: string | undefined;
  let repo: string | undefined;
  let branch = "main";
  let appDir: string | undefined;
  let buildCmd = "npm run build";
  let serviceUnit: string | undefined;
  let healthUrl: string | undefined;
  let migrateCmd: string | undefined;
  let seedCmd: string | undefined;
  let envFile: string | undefined;
  let rlsNonSuperuser = false;
  let rlsUrlVar: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--name": name = takeValue(args, i, a); i++; break;
      case "--repo": repo = takeValue(args, i, a); i++; break;
      case "--branch": branch = takeValue(args, i, a); i++; break;
      case "--app-dir": appDir = takeValue(args, i, a); i++; break;
      case "--build-cmd": buildCmd = takeValue(args, i, a); i++; break;
      case "--service-unit": serviceUnit = takeValue(args, i, a); i++; break;
      case "--health-url": healthUrl = takeValue(args, i, a); i++; break;
      case "--migrate-cmd": migrateCmd = takeValue(args, i, a); i++; break;
      case "--seed-cmd": seedCmd = takeValue(args, i, a); i++; break;
      case "--env-file": envFile = takeValue(args, i, a); i++; break;
      case "--assert-rls": rlsNonSuperuser = true; break;
      case "--rls-url-var": rlsUrlVar = takeValue(args, i, a); i++; break;
      case "--json": json = true; break;
      default:
        if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
        if (vm !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
        vm = a;
    }
  }

  if (vm === undefined) throw new UsageError("app register requires a <vm> argument");
  if (name === undefined) throw new UsageError("--name is required");
  if (repo === undefined) throw new UsageError("--repo is required");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new UsageError(`invalid --repo: ${repo} (expected owner/name)`);
  }
  if (serviceUnit === undefined) throw new UsageError("--service-unit is required");
  if (healthUrl === undefined) throw new UsageError("--health-url is required");
  if (rlsUrlVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rlsUrlVar)) {
    throw new UsageError(
      `invalid --rls-url-var: ${rlsUrlVar} (must be a valid env var name, ` +
        `e.g. APP_DATABASE_URL)`,
    );
  }
  const resolvedAppDir = appDir ?? `/opt/${name}/app`;

  const input: AppRegisterInput = {
    vm,
    name,
    repo,
    branch,
    appDir: resolvedAppDir,
    buildCmd,
    serviceUnit,
    healthUrl,
    rlsNonSuperuser,
    ...(migrateCmd !== undefined ? { migrateCmd } : {}),
    ...(seedCmd !== undefined ? { seedCmd } : {}),
    ...(envFile !== undefined ? { envFile } : {}),
    ...(rlsUrlVar !== undefined ? { rlsUrlVar } : {}),
  };
  return { kind: "app-register", input, json };
}

/** Collect up to two positionals (<vm> <app>) plus flags. */
function takeVmApp(
  args: string[],
  onFlag: (a: string, i: number) => number | undefined,
): { vm?: string; app?: string } {
  const out: { vm?: string; app?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = onFlag(a, i);
    if (consumed !== undefined) {
      i = consumed;
      continue;
    }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (out.vm === undefined) out.vm = a;
    else if (out.app === undefined) out.app = a;
    else throw new UsageError(`unexpected extra argument: ${a}`);
  }
  return out;
}

function parseAppPlan(args: string[]): ParsedAppPlan {
  let sha: string | undefined;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--sha") { sha = takeValue(args, i, a); return i + 1; }
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined) throw new UsageError("app plan requires <vm> <app>");
  if (app === undefined) throw new UsageError("app plan requires <vm> <app>");
  if (sha === undefined) throw new UsageError("--sha is required for app plan");
  return { kind: "app-plan", input: { vm, app, sha }, json };
}

function parseAppDeploy(args: string[]): ParsedAppDeploy {
  let sha: string | undefined;
  let ref: string | undefined;
  let skipCiGate = false;
  let force = false;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--sha") { sha = takeValue(args, i, a); return i + 1; }
    if (a === "--ref") { ref = takeValue(args, i, a); return i + 1; }
    if (a === "--skip-ci-gate") { skipCiGate = true; return i; }
    if (a === "--force") { force = true; return i; }
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined) throw new UsageError("app deploy requires <vm> <app>");
  if (app === undefined) throw new UsageError("app deploy requires <vm> <app>");
  if (sha !== undefined && ref !== undefined) {
    throw new UsageError("--sha and --ref are mutually exclusive");
  }
  const input: AppDeployInput = {
    vm,
    app,
    skipCiGate,
    ...(force ? { force } : {}),
    ...(sha !== undefined ? { sha } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
  return { kind: "app-deploy", input, json };
}

function parseAppClearFailed(args: string[]): ParsedAppClearFailed {
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined || app === undefined) {
    throw new UsageError("app clear-failed requires <vm> <app>");
  }
  return { kind: "app-clear-failed", input: { vm, app }, json };
}

function parseAppStatus(args: string[]): ParsedAppStatus {
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined) throw new UsageError("app status requires <vm> <app>");
  if (app === undefined) throw new UsageError("app status requires <vm> <app>");
  return { kind: "app-status", input: { vm, app }, json };
}

// ---------------------------------------------------------------------------
// env subcommands
// ---------------------------------------------------------------------------

const DB_BACKENDS: readonly EnvDbBackend[] = ["dblab", "template", "none"];

function parseDbBackend(v: string): EnvDbBackend {
  if ((DB_BACKENDS as readonly string[]).includes(v)) return v as EnvDbBackend;
  throw new UsageError(`invalid --db: ${v} (dblab|template|none)`);
}

function parseEnv(args: string[]): ParsedCommand {
  const sub = args[0];
  if (sub === undefined) {
    throw new UsageError(
      "env requires a subcommand: plan | create | list | destroy",
    );
  }
  const rest = args.slice(1);
  switch (sub) {
    case "plan":
      return parseEnvPlan(rest);
    case "create":
      return parseEnvCreate(rest);
    case "list":
      return parseEnvList(rest);
    case "destroy":
      return parseEnvDestroy(rest);
    case "preflight":
      return parseEnvPreflight(rest);
    default:
      throw new UsageError(`unknown env subcommand: ${sub}`);
  }
}

function parseEnvPreflight(args: string[]): ParsedEnvPreflight {
  let vm: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (vm !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
    vm = a;
  }
  if (vm === undefined) throw new UsageError("env preflight requires <vm>");
  return { kind: "env-preflight", input: { vm }, json };
}

function parseDns(args: string[]): ParsedDnsStatus {
  const sub = args[0];
  if (sub === undefined) throw new UsageError("dns requires a subcommand: status");
  if (sub !== "status") throw new UsageError(`unknown dns subcommand: ${sub}`);

  let domain: string | undefined;
  let expectIp: string | undefined;
  const cfZones: string[] = [];
  let json = false;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--expect-ip") { expectIp = takeValue(rest, i, a); i++; continue; }
    if (a === "--cf-zone") { cfZones.push(takeValue(rest, i, a)); i++; continue; }
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (domain !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
    domain = a;
  }
  if (domain === undefined) throw new UsageError("dns status requires <domain>");
  return {
    kind: "dns-status",
    input: {
      domain,
      cfZones: cfZones.length > 0 ? cfZones : [...DEFAULT_CLOUDFLARE_ZONES],
      ...(expectIp !== undefined ? { expectIp } : {}),
    },
    json,
  };
}

function parseEnvPlan(args: string[]): ParsedEnvPlan {
  let branch: string | undefined;
  let db: EnvDbBackend = "dblab";
  let previewDomain = DEFAULT_PREVIEW_DOMAIN;
  let destroy = false;
  let hostPrep = false;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--branch") { branch = takeValue(args, i, a); return i + 1; }
    if (a === "--db") { db = parseDbBackend(takeValue(args, i, a)); return i + 1; }
    if (a === "--preview-domain") { previewDomain = takeValue(args, i, a); return i + 1; }
    if (a === "--destroy") { destroy = true; return i; }
    if (a === "--host-prep") { hostPrep = true; return i; }
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined || app === undefined) {
    throw new UsageError("env plan requires <vm> <app>");
  }
  if (branch === undefined && !hostPrep) {
    throw new UsageError("env plan requires --branch (or --host-prep)");
  }
  const input: EnvPlanInput = {
    vm,
    app,
    db,
    previewDomain,
    destroy,
    hostPrep,
    ...(branch !== undefined ? { branch } : {}),
  };
  return { kind: "env-plan", input, json };
}

function parseEnvCreate(args: string[]): ParsedEnvCreate {
  let branch: string | undefined;
  let db: EnvDbBackend = "dblab";
  let previewDomain = DEFAULT_PREVIEW_DOMAIN;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--branch") { branch = takeValue(args, i, a); return i + 1; }
    if (a === "--db") { db = parseDbBackend(takeValue(args, i, a)); return i + 1; }
    if (a === "--preview-domain") { previewDomain = takeValue(args, i, a); return i + 1; }
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined || app === undefined) {
    throw new UsageError("env create requires <vm> <app>");
  }
  if (branch === undefined) {
    throw new UsageError("--branch is required for env create");
  }
  return {
    kind: "env-create",
    input: { vm, app, branch, db, previewDomain },
    json,
  };
}

function parseEnvList(args: string[]): ParsedEnvList {
  let app: string | undefined;
  let json = false;
  let vm: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--app") { app = takeValue(args, i, a); i++; continue; }
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (vm !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
    vm = a;
  }
  if (vm === undefined) throw new UsageError("env list requires <vm>");
  return {
    kind: "env-list",
    input: { vm, ...(app !== undefined ? { app } : {}) },
    json,
  };
}

function parseEnvDestroy(args: string[]): ParsedEnvDestroy {
  let branch: string | undefined;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--branch") { branch = takeValue(args, i, a); return i + 1; }
    if (a === "--json") { json = true; return i; }
    return undefined;
  });
  if (vm === undefined || app === undefined) {
    throw new UsageError("env destroy requires <vm> <app>");
  }
  if (branch === undefined) {
    throw new UsageError("--branch is required for env destroy");
  }
  return { kind: "env-destroy", input: { vm, app, branch }, json };
}

function parseIntFlag(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new UsageError(`${flag} must be an integer, got: ${v}`);
  }
  return n;
}

function readPubkeyFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new UsageError(`cannot read ssh pubkey file: ${path}`);
  }
}

/** Entry point. Returns the process exit code. */
export async function main(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s + "\n"),
  err: (s: string) => void = (s) => process.stderr.write(s + "\n"),
): Promise<number> {
  let cmd: ParsedCommand;
  try {
    cmd = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`error: ${e.message}`);
      err(HELP);
      return 2;
    }
    throw e;
  }

  switch (cmd.kind) {
    case "help":
      out(HELP);
      return 0;
    case "version":
      out(VERSION);
      return 0;
    case "preview":
      return runPreview(cmd.spec, cmd.sshPubkey, { json: cmd.json }, out, err);
    case "adopt":
      return runAdopt(cmd.input, { json: cmd.json }, new StateStore(), out, err);
    case "list":
      return runList({ json: cmd.json }, new StateStore(), out, err);
    case "status":
      return runStatus(cmd.input, { json: cmd.json }, new StateStore(), out, err);
    case "app-register":
      return runAppRegister(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        out,
        err,
      );
    case "app-plan":
      return runAppPlan(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        out,
        err,
      );
    case "app-deploy":
      return runAppDeploy(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        defaultAppDeployDeps(),
        out,
        err,
      );
    case "app-status":
      return runAppStatus(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        out,
        err,
      );
    case "app-clear-failed":
      return runAppClearFailed(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        out,
        err,
      );
    case "env-plan":
      return runEnvPlan(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        defaultEnvStore(),
        out,
        err,
      );
    case "env-create":
      return runEnvCreate(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        defaultEnvStore(),
        defaultEnvExecDeps(),
        out,
        err,
      );
    case "env-list":
      return runEnvList(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultEnvStore(),
        out,
        err,
      );
    case "env-destroy":
      return runEnvDestroy(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        defaultEnvStore(),
        defaultEnvExecDeps(),
        out,
        err,
      );
    case "env-preflight":
      return runEnvPreflight(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultEnvExecDeps(),
        out,
        err,
      );
    case "dns-status":
      return runDnsStatus(
        cmd.input,
        { json: cmd.json },
        defaultDnsStatusDeps(),
        out,
        err,
      );
  }
}

// Execute when run directly (not when imported by tests).
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
