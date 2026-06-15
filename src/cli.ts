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
import {
  runAdopt,
  defaultAdoptHostKeyDeps,
  type AdoptInput,
} from "./commands/adopt.ts";
import { runList } from "./commands/list.ts";
import { runStatus, type StatusInput } from "./commands/status.ts";
import {
  runSsh,
  defaultSshSessionDeps,
  type SshInput,
} from "./commands/ssh.ts";
import {
  runLogs,
  DEFAULT_LOG_LINES,
  type LogsInput,
} from "./commands/logs.ts";
import {
  runAppRegister,
  runAppRegisterFromToml,
  runAppPlan,
  runAppDeploy,
  runAppStatus,
  runAppClearFailed,
  runAppBootstrap,
  defaultAppDeployDeps,
  defaultAppStore,
  type AppRegisterInput,
  type AppRegisterFromTomlInput,
  type AppPlanInput,
  type AppDeployInput,
  type AppStatusInput,
  type AppClearFailedInput,
  type AppBootstrapInput,
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
  isValidPreviewDomain,
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
import {
  runProvision,
  defaultProvisionDeps,
} from "./commands/provision.ts";
import { runDestroy, defaultConfirm, type DestroyInput } from "./commands/destroy.ts";
import { HetznerProvider } from "./providers/hetzner.ts";
import { StateStore } from "./state/store.ts";
import type { EnvDbBackend } from "./types.ts";

export const VERSION = "0.1.0";

const HELP = `samohost ${VERSION} — provision security-hardened Linux VMs

Usage:
  samohost provision --provider hetzner --region <r> --type <t> \\
      --name <n> --ssh-key <path> [options]
  samohost destroy <vm-name-or-id> [--yes] [--json]
  samohost preview --provider <hetzner|aws> --region <r> --type <t> \\
      --ssh-pubkey <key|@file> [options]
  samohost adopt --name <n> --ip <ip> --ssh-user <u> --ssh-key <path> \\
      --host-key-fingerprint 'SHA256:...' [options]
  samohost list [--json]
  samohost status <vm-name-or-id> [--audit] [--json]
  samohost ssh <vm-name-or-id> [-- <command...>]
  samohost logs <vm-name-or-id> [--unit <name>] [--lines <n>] [--follow]
  samohost app register <vm> --name <n> --repo <owner/name> \\
      --service-unit <u> --health-url <url> [options]
  samohost app plan <vm> <app> --sha <sha>
  samohost app deploy <vm> <app> [--sha <sha> | --ref <ref>] \\
      [--skip-ci-gate] [--force] [--json]
  samohost app status <vm> <app> [--json]
  samohost app clear-failed <vm> <app> [--json]
  samohost app bootstrap <vm> <app> --app-user <user> [options]
  samohost env plan <vm> <app> (--branch <b> [--destroy] | --host-prep) [options]
  samohost env create <vm> <app> --branch <b> [--db dblab|template|none] [--json]
  samohost env list <vm> [--app <name>] [--json]
  samohost env destroy <vm> <app> --branch <b> [--json]
  samohost env preflight <vm> [--json]
  samohost dns status <domain> [--expect-ip <ip>] [--cf-zone <z>] [--json]
  samohost --help
  samohost --version

provision options (Hetzner only in v0.1 — AWS deferred; needs HCLOUD_TOKEN in env):
  --provider hetzner         cloud provider (required; aws is deferred)
  --region <region>          provider location, e.g. nbg1/fsn1/hel1 (required)
  --type <type>              server type, e.g. cx22 (required)
  --ssh-key <path>           keypair path — either half; the .pub text goes
                             into cloud-init, the private path is recorded
                             for \`samohost ssh\` (required)
  --name <name>              VM name (default: samohost-<provider>)
  --module <name>            optional module (repeatable)
  --ssh-port <port>          hardened SSH port (default: 2223)
  --admin-user <user>        non-root sudo user (default: samo)
  --trusted-ip <ip>          never-banned IP for fail2ban (repeatable)
  --timeout <seconds>        booting→ready gate bound (default: 600;
                             timeout leaves the VM recorded as 'degraded')
  --label <key=value>        custom provider label (repeatable); managed labels
                             (managed-by, samohost-id) always win on collision
  --json                     print the final VmRecord as JSON

destroy options (typed VM-name confirmation unless --yes):
  --yes                      skip the confirmation prompt
  --json                     print the destroyed record as JSON
  attached volumes are reported but NEVER deleted

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

ssh (interactive session — or run a one-off command — over the pinned host
key; same machinery as status --audit: per-VM known_hosts, strict checking,
the recorded user/port/key; no keyscan, no trust-on-first-use):
  -- <command...>            run this command instead of opening a shell;
                             everything after -- is passed to the remote
                             verbatim and the remote exit code is returned

logs options (systemd journal over the pinned SSH; uses the granted
non-interactive sudo path /usr/bin/journalctl):
  --unit <name>              systemd unit to read (default: the single
                             registered app's service unit; required when
                             0 or >1 apps are registered on the VM)
  --lines <n>                how many recent lines (default: ${DEFAULT_LOG_LINES})
  --follow                   keep streaming (-f) until interrupted
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
  --env-file <path>          remote env file path (NEVER read/written by samohost)
  --env-db-var <NAME>        env var whose DB URL must point at the per-env db in
                             preview envs (repeatable; default: DATABASE_URL)
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

app bootstrap options (PR-A1+A2 — ONE-TIME OS bootstrap + DB + env + clone;
  printed for operator review; NOT auto-executed by samohost; run as root):
  <vm>                       VM name or id (required)
  <app>                      app name or id (required)
  --app-user <user>          OS user created to run the app (required)
  --db-name <name>           Database to create — REQUIRED, EXPLICIT.
                             Never derived from app name (e.g. field_record,
                             NOT field-record or field_record_1). Must match
                             the actual database on the host.
  --app-base <path>          base directory (default: /opt/<app-name>)
  --node-major <N>           Node.js major via NodeSource (default: 22)
  --pg-major <N>             PostgreSQL major via PGDG (default: 18)
  --exec-start <cmd>         ExecStart for MAIN unit
                             (default: /usr/bin/node dist/server.js)
  --tls <acme|local>         Caddy TLS mode (default: acme; local => local_certs)
  --app-db-role <role>       non-superuser DB role for the RLS URL placeholder
                             (default: app_user; deploy.sh rotates the password)
  --seed-owner-login <name>  value for SEED_OWNER_LOGIN in the env file
                             (default: owner)

env options (per-branch preview environments — SOLO plan, one shared VM):
  --branch <branch>          git branch the env tracks (required except --host-prep)
  --db <dblab|template|none> per-env database backend (default: dblab)
  --template-db <name>       (plan/create, --db template) template database to
                             copy (default: <app dashes→underscores>_template)
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

export interface ParsedProvision {
  kind: "provision";
  spec: ProvisionSpec;
  /** Raw --ssh-key path (pub or priv); resolved by the provision command. */
  sshKey: string;
  json: boolean;
}

export interface ParsedDestroy {
  kind: "destroy";
  input: DestroyInput;
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

export interface ParsedSsh {
  kind: "ssh";
  input: SshInput;
}

export interface ParsedLogs {
  kind: "logs";
  input: LogsInput;
}

export interface ParsedAppRegister {
  kind: "app-register";
  input: AppRegisterInput;
  json: boolean;
}

export interface ParsedAppRegisterFromToml {
  kind: "app-register-from-toml";
  input: AppRegisterFromTomlInput;
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

export interface ParsedAppBootstrap {
  kind: "app-bootstrap";
  input: AppBootstrapInput;
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
  | ParsedProvision
  | ParsedDestroy
  | ParsedAdopt
  | ParsedList
  | ParsedStatus
  | ParsedSsh
  | ParsedLogs
  | ParsedAppRegister
  | ParsedAppRegisterFromToml
  | ParsedAppPlan
  | ParsedAppDeploy
  | ParsedAppStatus
  | ParsedAppClearFailed
  | ParsedAppBootstrap
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
  if (first === "provision") {
    return parseProvision(argv.slice(1));
  }
  if (first === "destroy") {
    return parseDestroy(argv.slice(1));
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
  if (first === "ssh") {
    return parseSsh(argv.slice(1));
  }
  if (first === "logs") {
    return parseLogs(argv.slice(1));
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

function parseProvision(args: string[]): ParsedProvision {
  let provider: string | undefined;
  let region: string | undefined;
  let type: string | undefined;
  let name: string | undefined;
  let sshKey: string | undefined;
  let sshPort = 2223;
  let adminUser = "samo";
  let timeoutSec = 600;
  let json = false;
  const modules: string[] = [];
  const trustedIps: string[] = [];
  const labels: Record<string, string> = {};
  let hasLabels = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--provider": provider = takeValue(args, i, a); i++; break;
      case "--region": region = takeValue(args, i, a); i++; break;
      case "--type": type = takeValue(args, i, a); i++; break;
      case "--name": name = takeValue(args, i, a); i++; break;
      case "--ssh-key": sshKey = takeValue(args, i, a); i++; break;
      case "--module": modules.push(takeValue(args, i, a)); i++; break;
      case "--trusted-ip": trustedIps.push(takeValue(args, i, a)); i++; break;
      case "--ssh-port": sshPort = parseIntFlag(takeValue(args, i, a), a); i++; break;
      case "--admin-user": adminUser = takeValue(args, i, a); i++; break;
      case "--timeout": timeoutSec = parseIntFlag(takeValue(args, i, a), a); i++; break;
      case "--json": json = true; break;
      case "--label": {
        const raw = takeValue(args, i, a);
        const eq = raw.indexOf("=");
        if (eq === -1) {
          throw new UsageError(
            `--label value must be in key=value form, got: "${raw}"`,
          );
        }
        labels[raw.slice(0, eq)] = raw.slice(eq + 1);
        hasLabels = true;
        i++;
        break;
      }
      default:
        throw new UsageError(`unknown flag: ${a}`);
    }
  }

  if (provider === undefined) throw new UsageError("--provider is required");
  if (provider === "aws") {
    throw new UsageError(
      "provision --provider aws is deferred (v0.1 provisions Hetzner only; " +
        "`samohost preview --provider aws` still renders offline)",
    );
  }
  if (provider !== "hetzner") {
    throw new UsageError(`invalid --provider: ${provider} (hetzner)`);
  }
  if (region === undefined) throw new UsageError("--region is required");
  if (type === undefined) throw new UsageError("--type is required");
  if (sshKey === undefined) throw new UsageError("--ssh-key is required");

  const spec: ProvisionSpec = {
    provider,
    region,
    type,
    name: name ?? `samohost-${provider}`,
    // Resolved (to the .pub path) by the provision command's key pairing.
    sshKeyPath: "",
    sshPort,
    adminUser,
    modules,
    trustedIps,
    timeoutSec,
    ...(hasLabels ? { labels } : {}),
  };
  return { kind: "provision", spec, sshKey, json };
}

function parseDestroy(args: string[]): ParsedDestroy {
  let target: string | undefined;
  let yes = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes") { yes = true; continue; }
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (target !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
    target = a;
  }
  if (target === undefined) {
    throw new UsageError("destroy requires a VM name or id");
  }
  return { kind: "destroy", input: { target, yes }, json };
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

function parseSsh(args: string[]): ParsedSsh {
  let target: string | undefined;
  let remoteCommand: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      const rest = args.slice(i + 1);
      if (rest.length === 0) {
        throw new UsageError("ssh: nothing after -- (drop it for an interactive session)");
      }
      remoteCommand = rest.join(" ");
      break;
    }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    if (target !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
    target = a;
  }
  if (target === undefined) {
    throw new UsageError("ssh requires a VM name or id");
  }
  return {
    kind: "ssh",
    input: {
      target,
      ...(remoteCommand !== undefined ? { remoteCommand } : {}),
    },
  };
}

function parseLogs(args: string[]): ParsedLogs {
  let target: string | undefined;
  let unit: string | undefined;
  let lines = DEFAULT_LOG_LINES;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--unit":
        unit = takeValue(args, i, a);
        i++;
        break;
      case "--lines":
        lines = parseIntFlag(takeValue(args, i, a), a);
        if (lines <= 0) {
          throw new UsageError(`--lines must be a positive integer, got: ${lines}`);
        }
        i++;
        break;
      case "--follow":
        follow = true;
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
    throw new UsageError("logs requires a VM name or id");
  }
  return {
    kind: "logs",
    input: {
      target,
      lines,
      follow,
      ...(unit !== undefined ? { unit } : {}),
    },
  };
}

type AppSub = "register" | "plan" | "deploy" | "status" | "clear-failed" | "bootstrap";

const APP_SUBS: readonly AppSub[] = [
  "register",
  "plan",
  "deploy",
  "status",
  "clear-failed",
  "bootstrap",
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
    case "bootstrap":
      return parseAppBootstrap(rest);
  }
}

/** Shared: collect leading positional args (until the first flag). */
function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`missing value for ${flag}`);
  return v;
}

function parseAppRegister(
  args: string[],
): ParsedAppRegister | ParsedAppRegisterFromToml {
  let vm: string | undefined;
  let fromToml: string | undefined;
  let name: string | undefined;
  let repo: string | undefined;
  let branch = "main";
  let appDir: string | undefined;
  let buildCmd = "npm run build";
  let serviceUnit: string | undefined;
  let healthUrl: string | undefined;
  let mainHost: string | undefined;
  let migrateCmd: string | undefined;
  let seedCmd: string | undefined;
  let envFile: string | undefined;
  const envDbVars: string[] = [];
  let rlsNonSuperuser = false;
  let rlsUrlVar: string | undefined;
  let kind: "node" | "static" | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--from-toml": fromToml = takeValue(args, i, a); i++; break;
      case "--name": name = takeValue(args, i, a); i++; break;
      case "--repo": repo = takeValue(args, i, a); i++; break;
      case "--branch": branch = takeValue(args, i, a); i++; break;
      case "--app-dir": appDir = takeValue(args, i, a); i++; break;
      case "--build-cmd": buildCmd = takeValue(args, i, a); i++; break;
      case "--service-unit": serviceUnit = takeValue(args, i, a); i++; break;
      case "--health-url": healthUrl = takeValue(args, i, a); i++; break;
      case "--main-host": {
        // Public PRODUCTION host for the durable main-env Caddy vhost
        // (field-record-1#117 ITEM C). Embedded in a root-run host-prep
        // script — validate strictly, same posture as --preview-domain.
        const v = takeValue(args, i, a);
        if (!isValidPreviewDomain(v)) {
          throw new UsageError(
            `invalid --main-host: ${v} (expected a dotted lowercase DNS ` +
              `name like field-record-1.samo.team)`,
          );
        }
        mainHost = v;
        i++;
        break;
      }
      case "--migrate-cmd": migrateCmd = takeValue(args, i, a); i++; break;
      case "--seed-cmd": seedCmd = takeValue(args, i, a); i++; break;
      case "--env-file": envFile = takeValue(args, i, a); i++; break;
      case "--env-db-var": {
        // Embedded in on-host grep/sed patterns — validate strictly (#11).
        const v = takeValue(args, i, a);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
          throw new UsageError(
            `invalid --env-db-var: ${v} (expected an env var name like APP_DATABASE_URL)`,
          );
        }
        envDbVars.push(v);
        i++;
        break;
      }
      case "--assert-rls": rlsNonSuperuser = true; break;
      case "--rls-url-var": rlsUrlVar = takeValue(args, i, a); i++; break;
      case "--kind": {
        // issue #36: serve kind ("node" | "static")
        const v = takeValue(args, i, a);
        if (v !== "node" && v !== "static") {
          throw new UsageError(
            `invalid --kind: ${v} (expected "node" or "static")`,
          );
        }
        kind = v;
        i++;
        break;
      }
      case "--json": json = true; break;
      default:
        if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
        if (vm !== undefined) throw new UsageError(`unexpected extra argument: ${a}`);
        vm = a;
    }
  }

  if (vm === undefined) throw new UsageError("app register requires a <vm> argument");

  // ---- --from-toml path: flags are not required (manifest supplies them) ---
  // When --from-toml is given, ignore any flag-based fields that were NOT also
  // provided — the manifest is the source of truth. If both --from-toml and
  // required flags are provided, --from-toml takes precedence and flags are
  // ignored (documented behaviour; use one or the other, not both).
  if (fromToml !== undefined) {
    return {
      kind: "app-register-from-toml",
      input: { vm, tomlPath: fromToml },
      json,
    };
  }

  // ---- flag path (existing behaviour, unchanged) ---------------------------
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
    ...(kind !== undefined ? { kind } : {}),
    ...(mainHost !== undefined ? { mainHost } : {}),
    ...(migrateCmd !== undefined ? { migrateCmd } : {}),
    ...(seedCmd !== undefined ? { seedCmd } : {}),
    ...(envFile !== undefined ? { envFile } : {}),
    ...(envDbVars.length > 0 ? { envDbVars } : {}),
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

function parseAppBootstrap(args: string[]): ParsedAppBootstrap {
  let appUser: string | undefined;
  let dbName: string | undefined;
  let appBase: string | undefined;
  let nodeMajor: number | undefined;
  let pgMajor: number | undefined;
  let execStart: string | undefined;
  let tlsMode: "acme" | "local" | undefined;
  let appDbRole: string | undefined;
  let seedOwnerLogin: string | undefined;

  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--app-user") { appUser = takeValue(args, i, a); return i + 1; }
    // PR-A2 REQUIRED: DB name is always explicit — never derived from app.name.
    if (a === "--db-name") { dbName = takeValue(args, i, a); return i + 1; }
    if (a === "--app-base") { appBase = takeValue(args, i, a); return i + 1; }
    if (a === "--node-major") {
      nodeMajor = parseIntFlag(takeValue(args, i, a), a);
      return i + 1;
    }
    if (a === "--pg-major") {
      pgMajor = parseIntFlag(takeValue(args, i, a), a);
      return i + 1;
    }
    if (a === "--exec-start") { execStart = takeValue(args, i, a); return i + 1; }
    if (a === "--tls") {
      const v = takeValue(args, i, a);
      if (v !== "acme" && v !== "local") {
        throw new UsageError(`invalid --tls: ${v} (acme|local)`);
      }
      tlsMode = v;
      return i + 1;
    }
    // PR-A2 optional DB/env options
    if (a === "--app-db-role") { appDbRole = takeValue(args, i, a); return i + 1; }
    if (a === "--seed-owner-login") { seedOwnerLogin = takeValue(args, i, a); return i + 1; }
    // Legacy --print is a no-op (bootstrap always prints to stdout)
    if (a === "--print") { return i; }
    return undefined;
  });

  if (vm === undefined) throw new UsageError("app bootstrap requires <vm> <app>");
  if (app === undefined) throw new UsageError("app bootstrap requires <vm> <app>");
  if (appUser === undefined) throw new UsageError("app bootstrap requires --app-user <user>");
  if (dbName === undefined) throw new UsageError("app bootstrap requires --db-name <name> (REQUIRED: must be explicit; not derived from app name)");

  const input: AppBootstrapInput = {
    vm,
    app,
    appUser,
    dbName,
    ...(appBase !== undefined ? { appBase } : {}),
    ...(nodeMajor !== undefined ? { nodeMajor } : {}),
    ...(pgMajor !== undefined ? { pgMajor } : {}),
    ...(execStart !== undefined ? { execStart } : {}),
    ...(tlsMode !== undefined ? { tlsMode } : {}),
    ...(appDbRole !== undefined ? { appDbRole } : {}),
    ...(seedOwnerLogin !== undefined ? { seedOwnerLogin } : {}),
  };
  return { kind: "app-bootstrap", input };
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
  let templateDb: string | undefined;
  let destroy = false;
  let hostPrep = false;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--branch") { branch = takeValue(args, i, a); return i + 1; }
    if (a === "--db") { db = parseDbBackend(takeValue(args, i, a)); return i + 1; }
    if (a === "--preview-domain") { previewDomain = takeValue(args, i, a); return i + 1; }
    if (a === "--template-db") { templateDb = takeValue(args, i, a); return i + 1; }
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
    ...(templateDb !== undefined ? { templateDb } : {}),
  };
  return { kind: "env-plan", input, json };
}

function parseEnvCreate(args: string[]): ParsedEnvCreate {
  let branch: string | undefined;
  let db: EnvDbBackend = "dblab";
  let previewDomain = DEFAULT_PREVIEW_DOMAIN;
  let templateDb: string | undefined;
  let json = false;
  const { vm, app } = takeVmApp(args, (a, i) => {
    if (a === "--branch") { branch = takeValue(args, i, a); return i + 1; }
    if (a === "--db") { db = parseDbBackend(takeValue(args, i, a)); return i + 1; }
    if (a === "--preview-domain") { previewDomain = takeValue(args, i, a); return i + 1; }
    if (a === "--template-db") { templateDb = takeValue(args, i, a); return i + 1; }
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
    input: {
      vm, app, branch, db, previewDomain,
      ...(templateDb !== undefined ? { templateDb } : {}),
    },
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
    case "provision": {
      const store = new StateStore();
      const provider = new HetznerProvider({ fetch: globalThis.fetch });
      return runProvision(
        { spec: cmd.spec, sshKey: cmd.sshKey },
        { json: cmd.json },
        defaultProvisionDeps(provider, store),
        out,
        err,
      );
    }
    case "destroy": {
      const store = new StateStore();
      const provider = new HetznerProvider({ fetch: globalThis.fetch });
      return runDestroy(
        cmd.input,
        { json: cmd.json },
        { provider, store, confirm: defaultConfirm },
        out,
        err,
      );
    }
    case "adopt":
      return runAdopt(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        out,
        err,
        defaultAdoptHostKeyDeps(),
      );
    case "list":
      return runList({ json: cmd.json }, new StateStore(), out, err);
    case "status":
      return runStatus(cmd.input, { json: cmd.json }, new StateStore(), out, err);
    case "ssh":
      return runSsh(cmd.input, new StateStore(), defaultSshSessionDeps(), out, err);
    case "logs":
      return runLogs(
        cmd.input,
        new StateStore(),
        defaultAppStore(),
        defaultSshSessionDeps(),
        out,
        err,
      );
    case "app-register":
      return runAppRegister(
        cmd.input,
        { json: cmd.json },
        new StateStore(),
        defaultAppStore(),
        out,
        err,
      );
    case "app-register-from-toml":
      return runAppRegisterFromToml(
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
    case "app-bootstrap":
      return runAppBootstrap(
        cmd.input,
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
