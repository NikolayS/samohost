/**
 * `samohost status` (SPEC §3 story 4).
 *
 * Reads a VM from local state by name or id and, with `--audit`, runs the
 * hardening module's read-only probes over pinned SSH. The command deliberately
 * does not attempt host-key discovery: the per-VM known_hosts entry must already
 * have been recorded from an out-of-band-verified key.
 */

import { spawnSync } from "node:child_process";
import { buildAuditScript, parseAuditOutput } from "../audit/batch.ts";
import { hardeningModule } from "../cloudinit/hardening.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import type { AuditCheck, VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";

export interface StatusInput {
  target: string;
  audit: boolean;
}

export interface AuditResult {
  id: string;
  description: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StatusResult {
  record: VmRecord;
  audit?: AuditResult[];
}

export type RemoteRunner = (
  vm: VmRecord,
  command: string,
) => Promise<SpawnResult>;

function findRecord(records: VmRecord[], target: string): VmRecord | undefined {
  return records.find((r) => r.id === target || r.name === target);
}

function matches(check: AuditCheck, stdout: string): boolean {
  if (typeof check.expect === "string") return stdout.trim() === check.expect;
  return check.expect.test(stdout);
}

function formatRecord(r: VmRecord): string {
  return [
    `name: ${r.name}`,
    `id: ${r.id}`,
    `provider: ${r.provider}`,
    `provider_id: ${r.providerId || "-"}`,
    `address: ${r.sshUser}@${r.ip}:${r.sshPort}`,
    `state: ${r.lifecycleState}`,
    `region: ${r.region || "-"}`,
    `type: ${r.type || "-"}`,
  ].join("\n");
}

function formatAudit(results: AuditResult[]): string {
  return results
    .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.description}`)
    .join("\n");
}

async function runAudit(
  vm: VmRecord,
  remote: RemoteRunner,
): Promise<AuditResult[]> {
  // ONE connection for the whole audit — per-check connections are a rapid-SYN
  // burst that kernel-level SSH rate limiting (xt_recent) treats as an attack.
  const checks = hardeningModule.auditChecks;
  const res = await remote(vm, buildAuditScript(checks));
  const sections = parseAuditOutput(res.stdout, checks);
  return checks.map((check) => {
    const observed = sections.get(check.id);
    return {
      id: check.id,
      description: check.description,
      ok: observed !== undefined && matches(check, observed),
      stdout: observed ?? "",
      stderr:
        observed === undefined
          ? `audit section missing from remote output (ssh stderr: ${res.stderr.slice(0, 200)})`
          : "",
      exitCode: observed === undefined ? 255 : 0,
    };
  });
}

function defaultRemoteRunner(): RemoteRunner {
  const deps: RunDeps = {
    clock: () => Date.now(),
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      const res = spawnSync(file, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return Promise.resolve({
        code: typeof res.status === "number" ? res.status : 255,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
      });
    },
  };
  return (vm, command) => runRemote(vm, command, deps);
}

export async function runStatus(
  input: StatusInput,
  opts: { json: boolean },
  store: StateStore,
  out: (s: string) => void,
  err: (s: string) => void,
  remote: RemoteRunner = defaultRemoteRunner(),
): Promise<number> {
  const record = findRecord(store.list(), input.target);
  if (record === undefined) {
    err(`error: VM not found in state: ${input.target}`);
    return 1;
  }

  if (!input.audit) {
    if (opts.json) out(JSON.stringify({ record }, null, 2));
    else out(formatRecord(record));
    return 0;
  }

  try {
    const audit = await runAudit(record, remote);
    const result: StatusResult = { record, audit };
    const ok = audit.every((r) => r.ok);
    if (opts.json) out(JSON.stringify(result, null, 2));
    else out(`${formatRecord(record)}\n\naudit:\n${formatAudit(audit)}`);
    return ok ? 0 : 1;
  } catch (e) {
    err(`error: audit failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
