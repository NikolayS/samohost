/**
 * `samohost logs` (SPEC §2/§4 — v0.1 minimum surface; deferred note in #15).
 *
 * Streams a systemd unit's journal from a VM over the pinned SSH session
 * machinery (src/commands/ssh.ts → src/ssh/runner.ts buildSshArgs). The
 * remote invocation is the granted non-interactive sudo form — full path,
 * exactly `sudo /usr/bin/journalctl ...` — because the hardened hosts grant
 * NOPASSWD on absolute paths only (see src/app/script.ts note 3).
 *
 * Unit resolution: an explicit `--unit` always wins; otherwise, if exactly
 * one app is registered on the VM, its serviceUnit is the obvious default.
 * With zero or several registered apps there is no honest default, so the
 * command refuses and names the candidates instead of guessing.
 */

import type { AppStore } from "../state/apps.ts";
import type { StateStore } from "../state/store.ts";
import type { AppRecord, VmRecord } from "../types.ts";
import { spawnSshSession, type SshSessionDeps } from "./ssh.ts";

export const DEFAULT_LOG_LINES = 100;

export interface LogsInput {
  /** VM name or id (resolved against local state). */
  target: string;
  /** systemd unit; default = the single registered app's serviceUnit. */
  unit?: string;
  /** journalctl -n value. */
  lines: number;
  /** journalctl -f: stream until interrupted. */
  follow: boolean;
}

/**
 * Valid systemd unit-name characters (plus the template `@` and type suffix
 * dot). The unit is embedded in a remote shell command line, so anything
 * outside this set is rejected outright rather than quoted.
 */
const UNIT_RE = /^[A-Za-z0-9:_.@\\-]+$/;

/** Build the exact remote command. Throws on an unsafe unit name. */
export function buildLogsCommand(
  unit: string,
  lines: number,
  follow: boolean,
): string {
  if (!UNIT_RE.test(unit)) {
    throw new Error(
      `invalid unit name: ${JSON.stringify(unit)} — expected systemd unit ` +
        `characters only (letters, digits, : _ . @ -)`,
    );
  }
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error(`--lines must be a positive integer, got: ${lines}`);
  }
  return (
    `sudo /usr/bin/journalctl -u ${unit} -n ${lines}` + (follow ? " -f" : "")
  );
}

/**
 * Resolve the unit to read: explicit wins; else the single registered app's
 * serviceUnit; else throw with the candidate list.
 */
export function resolveLogsUnit(
  appsOnVm: AppRecord[],
  explicit?: string,
): string {
  if (explicit !== undefined) return explicit;
  if (appsOnVm.length === 1) return appsOnVm[0]!.serviceUnit;
  if (appsOnVm.length === 0) {
    throw new Error(
      "no apps registered on this VM — pass --unit <name> to pick the " +
        "systemd unit to read",
    );
  }
  const candidates = appsOnVm
    .map((a) => `${a.name} (${a.serviceUnit})`)
    .join(", ");
  throw new Error(
    `multiple apps registered on this VM: ${candidates} — pass --unit <name>`,
  );
}

function findVm(store: StateStore, target: string): VmRecord | undefined {
  return store.list().find((r) => r.id === target || r.name === target);
}

export async function runLogs(
  input: LogsInput,
  store: StateStore,
  appStore: AppStore,
  deps: SshSessionDeps,
  _out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const vm = findVm(store, input.target);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.target}`);
    return 1;
  }

  let command: string;
  try {
    const appsOnVm = appStore.list().filter((a) => a.vmId === vm.id);
    const unit = resolveLogsUnit(appsOnVm, input.unit);
    command = buildLogsCommand(unit, input.lines, input.follow);
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  return spawnSshSession(vm, command, deps);
}
