/**
 * Production wiring for the self-heal pass (samohost #78).
 *
 * Splits into:
 *   - parseCloneHealth / parseBatchedProbe: PURE mapping of the probe output to
 *     {@link CloneHealth} verdicts. Unit-tested offline against the live shape.
 *   - defaultHealDeps: the real {@link HealDeps} — ONE batched SSH command that
 *     reads `dblab clone status <id>` for EVERY env plus the host's listening
 *     ports (reusing the #71/#73 `ss -ltnH` logic) in a single connection
 *     (mandatory: the runner enforces a fail2ban-safe ≤2-conn/600s budget), plus
 *     a recreate that re-runs the idempotent dblab `runEnvCreate` and maps a
 *     budget-exceeded error to "budget" (defer, never ban).
 *
 * SAFETY: probeClones is READ-ONLY (status + ss). recreate re-cuts ONLY the
 * preview's own clone and restarts ONLY the preview's own unit (env/script.ts);
 * it never touches prod or Caddy globally.
 */

import { spawnSync } from "node:child_process";
import type { AppRecord, EnvRecord, VmRecord } from "../types.ts";
import type { CloneHealth, HealDeps, RecreateOutcome } from "./heal.ts";
import type { EnvStore } from "../state/envs.ts";
import {
  BudgetExceededError,
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
} from "../ssh/runner.ts";
import { parseListeningPorts } from "../env/ports.ts";
import { DEFAULT_PREVIEW_DOMAIN, runEnvCreate, defaultEnvExecDeps } from "../commands/env.ts";
import { AppStore } from "../state/apps.ts";
import { StateStore } from "../state/store.ts";

// Markers framing each section of the batched probe's stdout.
export const HEAL_PROBE_NO_CLI = "SAMOHOST_HEAL_NO_CLI";
export const HEAL_PROBE_CLONE_BEGIN = "SAMOHOST_HEAL_CLONE_BEGIN:"; // + cloneId
export const HEAL_PROBE_CLONE_END = "SAMOHOST_HEAL_CLONE_END:"; // + cloneId
export const HEAL_PROBE_STATUS_ERR = "SAMOHOST_HEAL_STATUS_ERR";
export const HEAL_PROBE_PORTS_BEGIN = "SAMOHOST_HEAL_PORTS_BEGIN";
export const HEAL_PROBE_PORTS_END = "SAMOHOST_HEAL_PORTS_END";

function jsq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Recognise the connection-budget-exhausted signature in a create's stderr.
 * runEnvCreate swallows the BudgetExceededError thrown by the runner into an
 * `error: remote env-create connection failed: connection budget exhausted …`
 * line + exit 1, so the message is the only signal the heal layer gets. We match
 * the stable BudgetExceededError phrasing (src/ssh/runner.ts) so a budget defer
 * is never mis-counted as a heal failure.
 */
export function isBudgetMessage(text: string): boolean {
  return /connection budget exhausted/i.test(text);
}

/**
 * Build ONE bash script that probes the liveness of ALL given clone ids in a
 * single SSH connection. For each clone it prints, between per-clone markers,
 * either the `dblab clone status <id>` JSON or a STATUS_ERR marker (clone gone /
 * engine down). It then prints the host's `ss -ltnH` once between PORTS markers.
 *
 * READ-ONLY: status + ss only. No sudo, no writes, no clone create/destroy.
 */
export function buildBatchedProbeScript(cloneIds: readonly string[]): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    "# Resolve the dblab CLI: PATH first, then ~/bin (runbook install location).",
    'SAMOHOST_DBLAB_BIN="$(command -v dblab || true)"',
    'if [[ -z "$SAMOHOST_DBLAB_BIN" && -x "$HOME/bin/dblab" ]]; then',
    '  SAMOHOST_DBLAB_BIN="$HOME/bin/dblab"',
    "fi",
    'if [[ -z "$SAMOHOST_DBLAB_BIN" ]]; then',
    `  echo ${jsq(HEAL_PROBE_NO_CLI)}`,
    "  exit 0",
    "fi",
  ];
  for (const id of cloneIds) {
    const q = jsq(id);
    lines.push(
      `echo ${jsq(HEAL_PROBE_CLONE_BEGIN)}${q}`,
      `if ! "$SAMOHOST_DBLAB_BIN" clone status ${q} 2>/dev/null; then`,
      `  echo ${jsq(HEAL_PROBE_STATUS_ERR)}`,
      "fi",
      `echo ${jsq(HEAL_PROBE_CLONE_END)}${q}`,
    );
  }
  lines.push(
    `echo ${jsq(HEAL_PROBE_PORTS_BEGIN)}`,
    "ss -ltnH 2>/dev/null || true",
    `echo ${jsq(HEAL_PROBE_PORTS_END)}`,
  );
  return lines.join("\n");
}

/** Extract the text between two line-markers (exclusive). Empty when absent. */
function between(stdout: string, begin: string, end: string): string {
  const b = stdout.indexOf(begin);
  if (b < 0) return "";
  const afterBegin = b + begin.length;
  const e = stdout.indexOf(end, afterBegin);
  return stdout.slice(afterBegin, e < 0 ? undefined : e).trim();
}

/**
 * PURE: extract the listening-ports set from the PORTS section of a
 * batched-probe stdout. Returns an empty set when the section is absent
 * (e.g. Phase-1 never ran or the probe failed).
 *
 * Called by `batchedVmCycle` to get live-bound ports from the Phase-1 probe
 * output so it can fail-closed on a squatted port before pre-upserting an env
 * record and dispatching batch SSH work.
 */
export function parseProbeListeningPorts(probeStdout: string): ReadonlySet<number> {
  const section = between(probeStdout, HEAL_PROBE_PORTS_BEGIN, HEAL_PROBE_PORTS_END);
  return parseListeningPorts(section);
}

/**
 * PURE: map one clone's status-section + the host's listening ports to a
 * {@link CloneHealth} verdict.
 *
 *   - "unknown": status section empty / non-JSON (inconclusive) → fail-closed.
 *   - "dead"   : STATUS_ERR (clone gone), OR status not OK, OR no port, OR the
 *                advertised port is NOT listening (the 03:00-refresh symptom).
 *   - "alive"  : status OK, numeric `.db.port`, AND that port is listening.
 */
export function classifyClone(
  statusSection: string,
  listeningPorts: ReadonlySet<number>,
): CloneHealth {
  if (statusSection.includes(HEAL_PROBE_STATUS_ERR)) return "dead";
  if (statusSection.length === 0) return "unknown";

  let parsed: unknown;
  try {
    parsed = JSON.parse(statusSection);
  } catch {
    return "unknown";
  }
  const obj = parsed as { status?: { code?: unknown }; db?: { port?: unknown } };
  if (obj.status?.code !== "OK") return "dead";

  const portRaw = obj.db?.port;
  const port =
    typeof portRaw === "string" ? parseInt(portRaw, 10)
    : typeof portRaw === "number" ? portRaw
    : NaN;
  if (!Number.isFinite(port) || port <= 0) return "dead";

  return listeningPorts.has(port) ? "alive" : "dead";
}

/**
 * PURE: parse the WHOLE batched-probe output into a clone-id → verdict map.
 *
 * @param probeExitOk false ⇒ SSH transport failed ⇒ every clone "unknown".
 * @param stdout      the batched script's stdout.
 * @param cloneIds    the ids that were probed (so a missing section ⇒ "unknown").
 */
export function parseBatchedProbe(
  probeExitOk: boolean,
  stdout: string,
  cloneIds: readonly string[],
): Map<string, CloneHealth> {
  const out = new Map<string, CloneHealth>();
  if (!probeExitOk || stdout.includes(HEAL_PROBE_NO_CLI)) {
    for (const id of cloneIds) out.set(id, "unknown");
    return out;
  }
  const listening = new Set(
    parseListeningPorts(between(stdout, HEAL_PROBE_PORTS_BEGIN, HEAL_PROBE_PORTS_END)),
  );
  for (const id of cloneIds) {
    const section = between(
      stdout,
      `${HEAL_PROBE_CLONE_BEGIN}${id}`,
      `${HEAL_PROBE_CLONE_END}${id}`,
    );
    out.set(id, section.length === 0 ? "unknown" : classifyClone(section, listening));
  }
  return out;
}

/**
 * Build the production {@link HealDeps}.
 *
 * `probeClones` runs ONE batched SSH command (status-for-all + ss) over the
 * pinned runner and maps the result with {@link parseBatchedProbe}. A connection
 * failure throws — the heal pass catches it and heals nothing this cycle.
 *
 * `recreate` re-runs the idempotent dblab `runEnvCreate` against the SAME
 * injected envStore. A BudgetExceededError (the runner refusing further
 * connections this window) is mapped to "budget" so the heal pass defers rather
 * than failing — and the operator IP is never banned.
 */
export function defaultHealDeps(envStore: EnvStore): HealDeps {
  const timeoutMs = 120_000;

  const probeClones = async (
    vm: VmRecord,
    _app: AppRecord,
    envs: readonly EnvRecord[],
  ): Promise<Map<string, CloneHealth>> => {
    const cloneIds = envs.map((e) => e.dbName ?? e.name);
    const script = buildBatchedProbeScript(cloneIds);
    const deps: RunDeps = {
      clock: () => Date.now(),
      knownHostsDir:
        process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
      spawn: (file, args) => {
        const res = spawnSync(file, args, {
          encoding: "utf8",
          input: script,
          maxBuffer: 16 * 1024 * 1024,
          timeout: timeoutMs,
        });
        return Promise.resolve({
          code: typeof res.status === "number" ? res.status : 255,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
        });
      },
    };
    const result = await runRemote(vm, "bash -s", deps);
    return parseBatchedProbe(result.code === 0, result.stdout, cloneIds);
  };

  const recreate = async (
    vm: VmRecord,
    app: AppRecord,
    env: EnvRecord,
  ): Promise<RecreateOutcome> => {
    const vmStore = new StateStore();
    const appStore = new AppStore();
    const envExecDeps = defaultEnvExecDeps();
    const noop = (_s: string) => {};
    // Capture create stderr so we can distinguish a genuine create failure from
    // the runner refusing to connect because the per-VM connection budget is
    // spent. runEnvCreate CATCHES the BudgetExceededError thrown by its remote
    // call and returns exit 1 with the budget message on stderr (it does NOT
    // re-throw it), so the only reliable signal at this layer is the message.
    let createErr = "";

    try {
      const exit = await runEnvCreate(
        {
          vm: vm.name,
          app: app.name,
          branch: env.branch,
          db: "dblab",
          previewDomain: DEFAULT_PREVIEW_DOMAIN,
          ...(env.templateDb !== undefined ? { templateDb: env.templateDb } : {}),
        },
        { json: true },
        vmStore,
        appStore,
        envStore,
        envExecDeps,
        noop,
        (s: string) => {
          createErr += s + "\n";
          process.stderr.write(`samohost: heal recreate: ${s}\n`);
        },
      );
      if (exit === 0) return "ok";
      // Budget-exhausted (swallowed into exit 1 by runEnvCreate) → defer, not fail.
      if (isBudgetMessage(createErr)) return "budget";
      return "failed";
    } catch (e) {
      // The pinned runner refuses to connect when the per-VM budget is spent
      // (fail2ban-safety). That is NOT a heal failure — defer to the next cycle.
      if (e instanceof BudgetExceededError) return "budget";
      if (isBudgetMessage(e instanceof Error ? e.message : String(e))) return "budget";
      // runEnvCreate normally returns an exit code rather than throwing; any
      // other throw is a genuine failure for this env.
      process.stderr.write(
        `samohost: heal recreate: ${env.name} threw — ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return "failed";
    }
  };

  return { probeClones, recreate, envStore };
}
