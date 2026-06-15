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

export type AuditStatus = "pass" | "fail" | "unknown";

export interface AuditResult {
  id: string;
  description: string;
  ok: boolean;
  /**
   * `unknown` = the probe could not be evaluated (needs root the auditing
   * user lacks: empty output or a permission error). Distinct from `fail`,
   * which means the control was observed NOT active.
   */
  status: AuditStatus;
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
  const label: Record<AuditStatus, string> = {
    pass: "PASS   ",
    fail: "FAIL   ",
    unknown: "UNKNOWN",
  };
  const rows = results.map(
    (r) =>
      `${label[r.status]}  ${r.id}  ${r.description}` +
      (r.status === "unknown" ? "  (probe needs root — not verifiable as this user)" : ""),
  );
  const n = (s: AuditStatus) => results.filter((r) => r.status === s).length;
  rows.push(
    `\n${n("pass")} pass / ${n("fail")} fail / ${n("unknown")} unknown`,
  );
  return rows.join("\n");
}

/** Output that signals "the probe ran but was not allowed", not "control off". */
export const PERMISSION_RE =
  /permission denied|you need to be root|must be root|not permitted|operation not permitted|enough privilege/i;

export function evaluate(
  check: AuditCheck,
  observed: string | undefined,
  sshStderr: string,
): AuditResult {
  if (observed === undefined) {
    return result(check, "unknown", "", `audit section missing from remote output (ssh stderr: ${sshStderr.slice(0, 200)})`, 255);
  }
  if (matches(check, observed)) return result(check, "pass", observed, "", 0);
  if (check.requiresSudo && (observed.trim() === "" || PERMISSION_RE.test(observed))) {
    return result(check, "unknown", observed, "probe requires root; rerun audit as a user with the matching sudo grants to verify", 0);
  }
  return result(check, "fail", observed, "", 0);
}

function result(
  check: AuditCheck,
  status: AuditStatus,
  stdout: string,
  stderr: string,
  exitCode: number,
): AuditResult {
  return {
    id: check.id,
    description: check.description,
    ok: status === "pass",
    status,
    stdout,
    stderr,
    exitCode,
  };
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
  return checks.map((check) =>
    evaluate(check, sections.get(check.id), res.stderr),
  );
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
    const statusResult: StatusResult = { record, audit };
    // unknown is tolerated for the exit code (visible in output); fail is not.
    const anyFail = audit.some((r) => r.status === "fail");
    if (opts.json) out(JSON.stringify(statusResult, null, 2));
    else out(`${formatRecord(record)}\n\naudit:\n${formatAudit(audit)}`);
    return anyFail ? 1 : 0;
  } catch (e) {
    err(`error: audit failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
