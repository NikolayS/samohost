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
import { StateStore } from "./state/store.ts";

export const VERSION = "0.1.0";

const HELP = `samohost ${VERSION} — provision security-hardened Linux VMs

Usage:
  samohost preview --provider <hetzner|aws> --region <r> --type <t> \\
      --ssh-pubkey <key|@file> [options]
  samohost adopt --name <n> --ip <ip> --ssh-user <u> --ssh-key <path> \\
      --host-key-fingerprint 'SHA256:...' [options]
  samohost list [--json]
  samohost status <vm-name-or-id> [--audit] [--json]
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

export type ParsedCommand =
  | ParsedPreview
  | ParsedAdopt
  | ParsedList
  | ParsedStatus
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
  }
}

// Execute when run directly (not when imported by tests).
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
