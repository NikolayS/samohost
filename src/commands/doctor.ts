/**
 * `samohost doctor` — READ-ONLY security/hardening doctor command.
 *
 * Runs ALL probes in ONE SSH connection (same kernel-rate-limit reasoning as
 * status --audit). Evaluates pass/fail/unknown/skip per check group:
 *
 *   core-host:       match-based (evaluate() from status.ts maps AuditResult → DoctorResult)
 *   core-liveness:   custom liveness parsers
 *   core-suspicious: suspicious-activity parsers — findings only, NEVER exit 1
 *   app-db:          match + pg-localhost parser; skipped when infra flag or no app/postgres
 *
 * ABSOLUTE CONSTRAINT: this command NEVER mutates any state (local or remote).
 * It calls AppStore.list() / .get() only — never .upsert() / .remove().
 */

import { spawnSync } from "node:child_process";
import { buildAuditScript, parseAuditOutput } from "../audit/batch.ts";
import { redact } from "../ssh/runner.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import {
  evaluate,
  PERMISSION_RE,
  type AuditResult,
  type RemoteRunner,
} from "./status.ts";
import type { StateStore } from "../state/store.ts";
import type { AppStore } from "../state/apps.ts";
import {
  buildDoctorChecks,
  type DoctorCheck,
  type DoctorGroup,
} from "../doctor/checks.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DoctorStatus = "pass" | "fail" | "unknown" | "skip";

export interface DoctorResult {
  id: string;
  description: string;
  group: DoctorGroup;
  status: DoctorStatus;
  stdout: string;
  stderr: string;
  /** Only populated for kind:"suspicious" checks. */
  findings?: string[];
}

export interface DoctorInput {
  target: string;
  infra: boolean;
}

// ---------------------------------------------------------------------------
// Liveness parser — exposed for direct unit testing.
// ---------------------------------------------------------------------------

/**
 * Parse ss -ltnH output for port liveness.
 * - "ssh-port-listening": sshPort in ss output → pass; else fail.
 * - "caddy-serving": both 80 AND 443 in ss output → pass; else fail.
 * - "fail2ban-jail": output contains "Status for the jail:" → pass; else fail.
 * - "service-crash-loop": ≥3 crash indicators → fail; else pass.
 * - "pg-localhost" (via parsePgLocalhostOutput): handled separately.
 */
export function parseLivenessOutput(
  checkId: string,
  stdout: string,
  sshPort: number,
): Pick<DoctorResult, "status" | "stdout" | "stderr"> {
  const out = stdout.trim();

  if (checkId === "ssh-port-listening" || checkId === "ss-listeners") {
    // Check for ssh port in listener output.
    const portRe = new RegExp(`:\\b${sshPort}\\b`);
    const pass = portRe.test(out);
    return { status: pass ? "pass" : "fail", stdout: out, stderr: "" };
  }

  if (checkId === "caddy-serving") {
    const has80 = /:80\b/.test(out);
    const has443 = /:443\b/.test(out);
    return {
      status: has80 && has443 ? "pass" : "fail",
      stdout: out,
      stderr: "",
    };
  }

  if (checkId === "fail2ban-jail") {
    const pass = /Status for the jail:/i.test(out);
    const isError = PERMISSION_RE.test(out) || out.trim() === "";
    if (isError) return { status: "unknown", stdout: out, stderr: "" };
    return { status: pass ? "pass" : "fail", stdout: out, stderr: "" };
  }

  if (checkId === "service-crash-loop") {
    const CRASH_RE =
      /Failed with result|Main process exited|Stopping .* after/gi;
    const matches = out.match(CRASH_RE) ?? [];
    const CRASH_THRESHOLD = 3;
    return {
      status: matches.length >= CRASH_THRESHOLD ? "fail" : "pass",
      stdout: out,
      stderr: "",
    };
  }

  // For "ss-listeners" used as liveness probe for SSH port:
  const portRe = new RegExp(`:\\b${sshPort}\\b`);
  return {
    status: portRe.test(out) ? "pass" : "fail",
    stdout: out,
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// Suspicious parser — exposed for direct unit testing.
// ---------------------------------------------------------------------------

/**
 * Parse suspicious-activity output. These checks NEVER cause exit 1 — they
 * produce findings[] that are displayed separately. Status is always "pass"
 * (clean) or "unknown" (probe unavailable). Raw log lines are NEVER emitted
 * in findings — only category + count + timestamps.
 *
 * All findings text is routed through redact() to strip credential strings.
 */
export function parseSuspiciousOutput(
  checkId: string,
  stdout: string,
): Pick<DoctorResult, "status" | "stdout" | "stderr" | "findings"> {
  const out = stdout.trim();

  if (PERMISSION_RE.test(out) || out === "") {
    return { status: "unknown", stdout: out, stderr: "", findings: [] };
  }

  if (checkId === "failed-auth-burst") {
    // Probe returns raw journal text; count locally so we can redact before findings.
    const FAILED_AUTH_RE = /failed password|invalid user/gi;
    const matches = out.match(FAILED_AUTH_RE) ?? [];
    const count = matches.length;
    const THRESHOLD = 20;
    if (count > THRESHOLD) {
      return {
        status: "pass", // suspicious NEVER fails — only findings
        stdout: out,
        stderr: "",
        // Only category + count, NEVER raw log lines. redact() as defense-in-depth.
        findings: [redact(`failed-auth: ${count} failed auth attempts detected (threshold: ${THRESHOLD})`)],
      };
    }
    return { status: "pass", stdout: out, stderr: "", findings: [] };
  }

  if (checkId === "sudo-failures") {
    // Probe returns raw journal text; count locally.
    const SUDO_FAIL_RE = /sudo:.*authentication failure/gi;
    const matches = out.match(SUDO_FAIL_RE) ?? [];
    const count = matches.length;
    const THRESHOLD = 5;
    if (count > THRESHOLD) {
      return {
        status: "pass",
        stdout: out,
        stderr: "",
        findings: [redact(`sudo-failures: ${count} sudo authentication failures detected (threshold: ${THRESHOLD})`)],
      };
    }
    return { status: "pass", stdout: out, stderr: "", findings: [] };
  }

  if (checkId === "fail2ban-ban-spike") {
    const match = out.match(/Total banned:\s*(\d+)/i);
    if (!match) {
      return { status: "unknown", stdout: out, stderr: "", findings: [] };
    }
    const count = parseInt(match[1]!, 10);
    const THRESHOLD = 50;
    if (count > THRESHOLD) {
      return {
        status: "pass",
        stdout: out,
        stderr: "",
        findings: [redact(`fail2ban-ban-spike: ${count} total bans in sshd jail (threshold: ${THRESHOLD})`)],
      };
    }
    return { status: "pass", stdout: out, stderr: "", findings: [] };
  }

  return { status: "pass", stdout: out, stderr: "", findings: [] };
}

// ---------------------------------------------------------------------------
// pg-localhost parser — exposed for direct unit testing.
// ---------------------------------------------------------------------------

/**
 * Parse ss -ltnH (or ss -ltnH | grep ':5432') output to determine whether
 * Postgres is listening only on loopback.
 *
 * Pass: :5432 found, all listeners are on 127.0.0.1 / [::1] (loopback).
 * Fail: :5432 found on 0.0.0.0 or :: (external exposure).
 * Unknown: no :5432 listener found at all.
 */
export function parsePgLocalhostOutput(
  stdout: string,
): Pick<DoctorResult, "status" | "stdout" | "stderr"> {
  const out = stdout.trim();
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);

  const pg5432Lines = lines.filter((l) => /:5432/.test(l));
  if (pg5432Lines.length === 0) {
    return { status: "unknown", stdout: out, stderr: "" };
  }

  // Check for external listeners (0.0.0.0:5432 or :::5432 or *:5432)
  const externalRe = /^LISTEN\s+\d+\s+\d+\s+(0\.0\.0\.0|::|\*):5432/;
  const hasExternal = pg5432Lines.some((l) => externalRe.test(l));
  if (hasExternal) {
    return { status: "fail", stdout: out, stderr: "" };
  }

  // All :5432 listeners are loopback (127.0.0.1 or [::1]).
  return { status: "pass", stdout: out, stderr: "" };
}

// ---------------------------------------------------------------------------
// web-ports-not-world-open parser — exposed for direct unit testing.
// ---------------------------------------------------------------------------

/**
 * Parse filtered `ufw status` output (80/443 lines only) for world-open rules.
 * - FAIL: any line matches Anywhere / 0.0.0.0/0 / ::/0 (including "Anywhere (v6)").
 * - PASS: all 80/443 lines have a restricted source, OR no 80/443 rules at all.
 * - UNKNOWN: probe returned a permission error (sudo not granted).
 */
export function parseWebPortsNotWorldOpenOutput(
  stdout: string,
): Pick<DoctorResult, "status" | "stdout" | "stderr"> {
  const out = stdout.trim();
  if (PERMISSION_RE.test(out)) {
    return { status: "unknown", stdout: out, stderr: "" };
  }
  if (out === "") {
    // No 80/443 rules in ufw → absent = not world-open → pass.
    return { status: "pass", stdout: out, stderr: "" };
  }
  const WORLD_OPEN_RE = /\bAnywhere\b|0\.0\.0\.0\/0|::\/0/i;
  const hasWorldOpen = out.split("\n").some((line) => WORLD_OPEN_RE.test(line));
  return { status: hasWorldOpen ? "fail" : "pass", stdout: out, stderr: "" };
}

// ---------------------------------------------------------------------------
// Detect :5432 loopback from ss output (for auto-detect scoping).
// ---------------------------------------------------------------------------

function detectPostgresLoopback(ssOutput: string): boolean {
  const lines = ssOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  const pg5432Lines = lines.filter((l) => /:5432/.test(l));
  // Has a :5432 listener and at least one is on loopback
  if (pg5432Lines.length === 0) return false;
  return pg5432Lines.some((l) => /127\.0\.0\.1:5432|\[::1\]:5432/.test(l));
}

// ---------------------------------------------------------------------------
// Evaluate a single DoctorCheck against its observed output.
// ---------------------------------------------------------------------------

function evaluateDoctorCheck(
  check: DoctorCheck,
  observed: string | undefined,
  sshStderr: string,
  sshPort: number,
  skip: boolean,
): DoctorResult {
  if (skip) {
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      status: "skip",
      stdout: "",
      stderr: "",
    };
  }

  if (observed === undefined) {
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      status: "unknown",
      stdout: "",
      stderr: `audit section missing from remote output (ssh stderr: ${sshStderr.slice(0, 200)})`,
    };
  }

  // Suspicious checks: use parseSuspiciousOutput, never fail.
  if (check.kind === "suspicious") {
    const parsed = parseSuspiciousOutput(check.id, observed);
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      ...parsed,
    };
  }

  // pg-localhost: special parser.
  if (check.id === "pg-localhost") {
    const parsed = parsePgLocalhostOutput(observed);
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      ...parsed,
    };
  }

  // Liveness checks: use parseLivenessOutput.
  if (check.kind === "liveness" && check.id !== "ss-listeners") {
    const parsed = parseLivenessOutput(check.id, observed, sshPort);
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      ...parsed,
    };
  }

  // ss-listeners itself: pass (it's a data-capture probe, not a match check).
  if (check.id === "ss-listeners") {
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      status: "pass",
      stdout: observed,
      stderr: "",
    };
  }

  // git-remote-no-token: invert — pass when NO embedded credentials found.
  if (check.id === "git-remote-no-token") {
    const TOKEN_RE = /:\/\/[^/]*:[^/]*@/;
    const hasToken = TOKEN_RE.test(observed);
    if (check.requiresSudo && (observed.trim() === "" || PERMISSION_RE.test(observed))) {
      return {
        id: check.id,
        description: check.description,
        group: check.group,
        status: "unknown",
        stdout: observed,
        stderr: "probe requires root; rerun audit as a user with the matching sudo grants to verify",
      };
    }
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      status: hasToken ? "fail" : "pass",
      stdout: observed,
      stderr: "",
    };
  }

  // web-ports-not-world-open: custom parser — FAIL when 80/443 is world-open in UFW.
  if (check.id === "web-ports-not-world-open") {
    const parsed = parseWebPortsNotWorldOpenOutput(observed);
    return {
      id: check.id,
      description: check.description,
      group: check.group,
      ...parsed,
    };
  }

  // Standard match check: delegate to status.ts evaluate() → map to DoctorResult.
  const auditResult: AuditResult = evaluate(check, observed, sshStderr);
  return {
    id: check.id,
    description: check.description,
    group: check.group,
    status: auditResult.status as DoctorStatus,
    stdout: auditResult.stdout,
    stderr: auditResult.stderr,
  };
}

// ---------------------------------------------------------------------------
// Output formatting.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<DoctorStatus, string> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  unknown: "UNKNOWN",
  skip: "SKIP   ",
};

const GROUP_HEADERS: Record<DoctorGroup, string> = {
  "core-host": "CORE — host",
  "core-liveness": "CORE — liveness",
  "core-suspicious": "CORE — suspicious",
  "app-db": "APP / DATABASE",
};

function formatDoctor(results: DoctorResult[]): string {
  const lines: string[] = [];
  const groups: DoctorGroup[] = ["core-host", "core-liveness", "core-suspicious", "app-db"];

  for (const group of groups) {
    const groupResults = results.filter((r) => r.group === group);
    if (groupResults.length === 0) continue;
    lines.push(`\n${GROUP_HEADERS[group]}`);
    for (const r of groupResults) {
      let line = `${STATUS_LABEL[r.status]}  ${r.id}  ${r.description}`;
      if (r.status === "unknown") {
        line += "  (probe needs root — not verifiable as this user)";
      }
      if (r.status === "skip") {
        line += "  n/a (infra mode / no app)";
      }
      lines.push(line);
      if (r.findings && r.findings.length > 0) {
        for (const f of r.findings) {
          lines.push(`         finding: ${f}`);
        }
      }
    }
  }

  const n = (s: DoctorStatus) => results.filter((r) => r.status === s).length;
  const allFindings = results.flatMap((r) => r.findings ?? []);
  lines.push(
    `\n${n("pass")} pass / ${n("fail")} fail / ${n("unknown")} unknown / ${n("skip")} skip` +
    (allFindings.length > 0 ? ` / ${allFindings.length} findings` : ""),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// defaultRemoteRunner — mirrors status.ts.
// ---------------------------------------------------------------------------

function defaultRemoteRunner(): RemoteRunner {
  const deps: RunDeps = {
    clock: () => Date.now(),
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      const res = spawnSync(file, args, {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
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

// ---------------------------------------------------------------------------
// runDoctor — main entry point.
// ---------------------------------------------------------------------------

export async function runDoctor(
  input: DoctorInput,
  opts: { json: boolean },
  store: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
  remote: RemoteRunner = defaultRemoteRunner(),
): Promise<number> {
  // Resolve VM.
  const record = store.list().find((r) => r.id === input.target || r.name === input.target);
  if (record === undefined) {
    err(`error: VM not found in state: ${input.target}`);
    return 1;
  }

  // Look up first registered app for this VM (READ-ONLY: .list() only).
  const apps = appStore.list().filter((a) => a.vmId === record.id);
  const app = apps[0];

  // Build app params if an app is registered.
  const appParams = app
    ? {
        appDir: app.appDir,
        envFile: app.envFile ?? `/opt/${app.name}/.env`,
        serviceUnit: app.serviceUnit,
        healthUrl: app.healthUrl,
        rlsUrlVar: app.rlsUrlVar ?? "DATABASE_URL",
      }
    : undefined;

  // Build the full check list (with app-param substitutions).
  const checks = buildDoctorChecks(record.sshPort, appParams);

  // ONE connection — all probes in one script.
  let sshResult: SpawnResult;
  try {
    sshResult = await remote(record, buildAuditScript(checks));
  } catch (e) {
    err(`error: doctor probe failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Parse all sections from the single output.
  const sections = parseAuditOutput(sshResult.stdout, checks);

  // Extract ss-listeners output for: liveness, pg-localhost, auto-detect.
  const ssListenersOutput = sections.get("ss-listeners") ?? "";

  // Determine if Postgres is on loopback (for auto-detect scoping).
  const pgLoopback = detectPostgresLoopback(ssListenersOutput);

  // Determine whether app-db checks should be skipped.
  // Skip when: --infra flag, OR (no app AND no :5432 loopback).
  const skipAppDb = input.infra || (!app && !pgLoopback);

  // Evaluate each check.
  const results: DoctorResult[] = checks.map((check) => {
    const isAppScoped = check.appScoped === true;
    const skip = isAppScoped && skipAppDb;

    // For pg-localhost: use ssListenersOutput (both the explicit pg grep and
    // the ss-listeners section work; prefer the ss-listeners for consistency).
    let observed = sections.get(check.id);
    if (check.id === "pg-localhost" && observed !== undefined) {
      // The probe runs ss -ltnH | grep ':5432' — observed is the filtered output.
      // Fall through to evaluateDoctorCheck which calls parsePgLocalhostOutput.
    } else if (check.id === "pg-localhost" && ssListenersOutput) {
      // Fallback: derive from ss-listeners.
      observed = ssListenersOutput;
    }

    return evaluateDoctorCheck(check, observed, sshResult.stderr, record.sshPort, skip);
  });

  // Exit code: 1 IFF any check status === "fail".
  // unknown, skip, and suspicious findings do NOT cause exit 1.
  const anyFail = results.some(
    (r) => r.status === "fail" && r.group !== "core-suspicious",
  );

  if (opts.json) {
    out(
      JSON.stringify(
        { record, infraMode: input.infra, checks: results },
        null,
        2,
      ),
    );
  } else {
    out(formatDoctor(results));
  }

  return anyFail ? 1 : 0;
}
