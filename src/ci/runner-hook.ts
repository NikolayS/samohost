/**
 * Pure bash-string builders for the GitHub Actions runner-host CI-port cleanup
 * hook (runner-host provisioning layer).
 *
 * Problem this solves: the SAMO client CI runs on a SHARED self-hosted runner.
 * Playwright's CI `webServer` binds port 3100; when a prior run's webServer is
 * orphaned (job cancelled / runner restarted mid-suite), it keeps holding 3100
 * and every subsequent run fails with `Error: http://localhost:3100 is already
 * used`. A per-client `ci.yml` port-kill was tried and FAILED: the runner lacks
 * `fuser`/`lsof`, and a client repo has no authority over the runner host. The
 * fix belongs to whoever provisions the runner host — samohost — via the
 * runner's built-in job hooks (`ACTIONS_RUNNER_HOOK_JOB_{STARTED,COMPLETED}`).
 *
 * Both builders are PURE: no I/O, deterministic, snapshot-stable. Same contract
 * as `env/script.ts`'s `buildHostPrepScript` — samohost RENDERS the host-prep
 * for an operator with root to review and apply once; samohost never executes
 * it and never SSHes anywhere for this command.
 */

/** Default CI port held by Playwright's webServer on the shared runner. */
export const DEFAULT_CI_PORTS: readonly number[] = [3100];

/** Default install path of the cleanup hook on the runner host. */
export const DEFAULT_HOOK_PATH = "/opt/samohost-ci/clean-ci-ports.sh";

/** Default actions-runner home (where `.env` carrying the hook vars lives). */
export const DEFAULT_RUNNER_HOME = "/home/ghrunner/actions-runner";

/** Single-quote for safe embedding in generated bash (same as env/script.ts). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the cleanup-hook payload installed on the runner host and invoked by
 * the runner as both the JOB_STARTED and JOB_COMPLETED hook.
 *
 * Behavior (a cleanup must tolerate "already gone", so `set -uo pipefail` — NOT
 * `set -e` — mirroring the destroy-script convention in env/script.ts):
 *   1. For each CI port: find the listening PID WITHOUT fuser/lsof (the runner
 *      host has neither). Prefer `ss -ltnpH "sport = :$port"` parsing `pid=`,
 *      fall back to scanning `/proc/net/tcp[6]`. `kill`, brief wait, then
 *      `kill -9`; every step `|| true`.
 *   2. Reap orphaned CI webServers by command-line signature (playwright/npm
 *      webServer start), GUARDED so it can never touch the production app: skip
 *      any PID whose cgroup is under system.slice (a real systemd unit) — only
 *      strays that escaped a cgroup are reaped.
 */
export function buildCiCleanupScript(opts: { ciPorts: number[] }): string {
  const ports = opts.ciPorts.length > 0 ? opts.ciPorts : [...DEFAULT_CI_PORTS];
  const portList = ports.map((p) => String(p)).join(" ");

  return [
    "#!/usr/bin/env bash",
    "# samohost CI-port cleanup hook (generated) — runner-host JOB_STARTED /",
    "# JOB_COMPLETED hook. Frees the Playwright webServer port(s) left behind by",
    "# an orphaned prior run. Tolerant by design (a cleanup must never fail the",
    "# job it guards), so: set -uo pipefail (NOT set -e), every step || true.",
    "#",
    "# Constraint: the runner host lacks the usual port-to-PID utilities, so PID",
    "# discovery uses ss with a /proc/net/tcp fallback only.",
    "set -uo pipefail",
    "",
    `CI_PORTS=(${portList})`,
    "",
    "# Hex-encoded local port for the /proc/net/tcp fallback (e.g. 3100 -> 0C1C).",
    "_proc_pids_on_port() {",
    "  local port=$1 hexport pid",
    '  hexport=$(printf "%04X" "$port" 2>/dev/null || true)',
    '  [[ -z "$hexport" ]] && return 0',
    "  # State 0A = LISTEN. Column 2 is local_address \"IP:PORT\"; column 10 is inode.",
    '  local inodes',
    "  inodes=$(awk -v hp=\":$hexport\" '$2 ~ hp\"$\" && $4 == \"0A\" {print $10}' \\",
    "    /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)",
    '  [[ -z "$inodes" ]] && return 0',
    "  # Map listening inodes -> owning pids by scanning /proc/*/fd socket links.",
    "  local fd target ino",
    '  for pid in $(ls /proc 2>/dev/null | grep -E "^[0-9]+$"); do',
    '    for fd in /proc/"$pid"/fd/*; do',
    '      target=$(readlink "$fd" 2>/dev/null || true)',
    '      [[ "$target" =~ ^socket:\\[([0-9]+)\\]$ ]] || continue',
    '      ino=${BASH_REMATCH[1]}',
    '      if grep -qx "$ino" <<<"$inodes"; then echo "$pid"; fi',
    "    done",
    "  done | sort -u",
    "}",
    "",
    "# Listening PID(s) on a port: ss first, then the /proc/net/tcp fallback.",
    "_pids_on_port() {",
    "  local port=$1 pids",
    '  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null \\',
    "    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)",
    '  if [[ -z "$pids" ]]; then',
    '    pids=$(_proc_pids_on_port "$port" || true)',
    "  fi",
    '  echo "$pids"',
    "}",
    "",
    "# A PID is PROTECTED (the production app — must NEVER be killed) when it",
    "# lives in a real systemd service cgroup under system.slice, EXCLUDING the",
    "# CI runner's own slice (fr-ci.slice; see runner-admin-handoff.md / PR #138).",
    "# A true orphan webServer that outlived its job has been re-parented to init",
    "# and left its job cgroup, so it is NOT under system.slice and NOT protected.",
    "_is_protected() {",
    "  local pid=$1 cg",
    '  cg=$(cat /proc/"$pid"/cgroup 2>/dev/null || true)',
    '  grep -q "system.slice" <<<"$cg" && ! grep -q "fr-ci.slice" <<<"$cg"',
    "}",
    "",
    "for port in \"${CI_PORTS[@]}\"; do",
    '  for pid in $(_pids_on_port "$port"); do',
    '    [[ -z "$pid" ]] && continue',
    '    if _is_protected "$pid"; then',
    '      echo "ci-cleanup: skipping protected (system.slice) pid $pid on port $port" >&2',
    "      continue",
    "    fi",
    '    echo "ci-cleanup: freeing port $port (pid $pid)" >&2',
    '    kill "$pid" 2>/dev/null || true',
    "    sleep 1",
    '    kill -9 "$pid" 2>/dev/null || true',
    "  done",
    "done",
    "",
    "# Reap orphaned CI webServers by command-line signature: only the Playwright",
    "# webServer launcher (`playwright ... webServer` / the npm script Playwright",
    "# spawns for it). Deliberately NARROW — a bare `next dev`/`npm start` is not",
    "# matched, so a long-running app server is never collateral. Guarded against",
    "# the production unit/User the same way (system.slice skip) as a backstop.",
    "for pid in $(pgrep -f 'playwright[^ ]*[ ].*webServer|@playwright/test.*webServer|node .*playwright.*webServer' 2>/dev/null || true); do",
    '  [[ -z "$pid" ]] && continue',
    '  if _is_protected "$pid"; then continue; fi',
    '  echo "ci-cleanup: reaping orphan ci webServer pid $pid" >&2',
    '  kill "$pid" 2>/dev/null || true',
    "  sleep 1",
    '  kill -9 "$pid" 2>/dev/null || true',
    "done",
    "",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Render the ONE-TIME runner-host preparation an operator with root must review
 * and apply: install the cleanup hook, wire it into the runner's job hooks via
 * the runner `.env`, then (operator-gated) restart the runner service so it
 * re-reads `.env`. RENDER-ONLY — samohost does not execute it, identical to the
 * `buildHostPrepScript` contract in env/script.ts.
 */
export function buildRunnerHostPrepScript(opts: {
  sshUser: string;
  runnerHome: string;
  hookDir: string;
  ciPorts: number[];
}): string {
  const ports = opts.ciPorts.length > 0 ? opts.ciPorts : [...DEFAULT_CI_PORTS];
  const hookPath = opts.hookDir;
  const envFile = `${opts.runnerHome.replace(/\/+$/, "")}/.env`;
  const cleanup = buildCiCleanupScript({ ciPorts: ports });

  return [
    "#!/usr/bin/env bash",
    "# samohost runner host-prep — ONE-TIME, run by an operator with root on the",
    "# shared self-hosted GitHub Actions runner host. Review before applying.",
    "# Nothing here is executed by samohost itself (render-only, like env host-prep).",
    "set -euo pipefail",
    "",
    `# CI ports guarded by the hook: ${ports.join(", ")}`,
    `# Runner home (carries the hook env vars): ${opts.runnerHome}`,
    "",
    "# 1. Install the CI-port cleanup hook. It frees the Playwright webServer",
    "#    port(s) left by an orphaned prior run, using ss with a /proc fallback",
    "#    (the usual port-to-PID utilities are absent on this host).",
    `install -d -m 0755 "$(dirname ${sq(hookPath)})"`,
    `install -m 0755 /dev/stdin ${sq(hookPath)} <<'CLEANUP_HOOK'`,
    cleanup,
    "CLEANUP_HOOK",
    "",
    "# 2. Wire the hook into the runner's job lifecycle, idempotently. The runner",
    "#    reads these from its .env on (re)start and invokes the same script at",
    "#    job start AND job completion — belt-and-suspenders so a port is freed",
    "#    before a run begins and again after it ends.",
    `touch ${sq(envFile)}`,
    `grep -q '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' ${sq(envFile)} \\`,
    `  || printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\\n' ${sq(hookPath)} >> ${sq(envFile)}`,
    `grep -q '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' ${sq(envFile)} \\`,
    `  || printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\\n' ${sq(hookPath)} >> ${sq(envFile)}`,
    "",
    "# 3. Operator follow-up (NOT run here): the runner only re-reads .env on",
    "#    service restart, so restart the runner service to activate the hook.",
    "#    Inspect the unit name first; on a typical install it is:",
    "#      systemctl restart actions.runner.*.service",
    `echo 'NEXT (operator): restart the runner service so it re-reads ${envFile}' >&2`,
    "echo '       e.g.  systemctl restart actions.runner.*.service' >&2",
    "echo '       then verify: a queued run frees port(s) at job start' >&2",
    "",
    "# Note: no sudoers grant is added by this prep — installs run as root here.",
    "# (If a future variant adds a /etc/sudoers.d/ grant, validate it before",
    "#  leaving the file in place:  visudo -cf /etc/sudoers.d/<file> .)",
    "",
  ].join("\n");
}
