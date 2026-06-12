/**
 * `samohost ssh` (SPEC §2/§4 — v0.1 minimum surface; deferred note in #15).
 *
 * Opens an interactive SSH session to a VM from local state — or, with a
 * trailing `-- <command...>`, runs that command — using the SAME pinned
 * machinery as every other remote call (src/ssh/runner.ts buildSshArgs):
 * per-VM known_hosts under `~/.samohost/known_hosts.d/`, the recorded
 * sshUser/sshPort/sshKeyPath, `StrictHostKeyChecking=yes`. No keyscan, no
 * trust-on-first-use: if the host key was never recorded, ssh refuses —
 * exactly like `status --audit` would.
 *
 * Unlike runRemote (capture + classify), a session inherits the operator's
 * terminal: ssh is spawned with stdio inherited and its exit code is the
 * command's exit code. The spawn is injected so tests never touch a network.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  buildSshArgs,
  defaultKnownHostsDir,
  ensureKnownHosts,
} from "../ssh/runner.ts";
import type { StateStore } from "../state/store.ts";
import type { VmRecord } from "../types.ts";

export interface SshInput {
  /** VM name or id (resolved against local state). */
  target: string;
  /** Joined `-- <command...>` words; undefined = interactive session. */
  remoteCommand?: string;
}

/**
 * Injectable terminal-inheriting spawn: run `file` with `args`, stdio wired to
 * the operator's terminal, resolve with the process exit code.
 */
export type InheritSpawn = (file: string, args: string[]) => Promise<number>;

export interface SshSessionDeps {
  spawn: InheritSpawn;
  /** Per-VM known_hosts directory (default ~/.samohost/known_hosts.d). */
  knownHostsDir: string;
  /** ssh ControlPath dir (defaults to knownHostsDir's sibling cm/). */
  controlDir?: string;
}

/**
 * Pure argv builder for a session. With a command it is exactly
 * {@link buildSshArgs}; without one it is the same argv minus the trailing
 * command element, so the pin/port/user/key can never drift between the
 * interactive and non-interactive paths.
 */
export function buildSshSessionArgs(
  vm: VmRecord,
  remoteCommand: string | undefined,
  opts: { knownHostsDir?: string; controlDir?: string } = {},
): string[] {
  if (remoteCommand !== undefined) return buildSshArgs(vm, remoteCommand, opts);
  const args = buildSshArgs(vm, "", opts);
  args.pop(); // drop the empty command → ssh opens an interactive session
  return args;
}

function findVm(store: StateStore, target: string): VmRecord | undefined {
  return store.list().find((r) => r.id === target || r.name === target);
}

/**
 * Shared session runner for `ssh` and `logs`: ensure the per-VM known_hosts
 * file and the ControlMaster socket dir exist, then spawn ssh inheriting the
 * terminal. Returns ssh's exit code.
 */
export async function spawnSshSession(
  vm: VmRecord,
  remoteCommand: string | undefined,
  deps: SshSessionDeps,
): Promise<number> {
  ensureKnownHosts(vm, deps.knownHostsDir);
  const controlDir = deps.controlDir ?? join(dirname(deps.knownHostsDir), "cm");
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const args = buildSshSessionArgs(vm, remoteCommand, {
    knownHostsDir: deps.knownHostsDir,
    controlDir,
  });
  return deps.spawn("ssh", args);
}

export async function runSsh(
  input: SshInput,
  store: StateStore,
  deps: SshSessionDeps,
  _out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const vm = findVm(store, input.target);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.target}`);
    return 1;
  }
  return spawnSshSession(vm, input.remoteCommand, deps);
}

/** Production deps: real ssh, stdio inherited, exit code propagated. */
export function defaultSshSessionDeps(): SshSessionDeps {
  return {
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file, args) =>
      new Promise<number>((resolve) => {
        const child = nodeSpawn(file, args, { stdio: "inherit" });
        child.on("error", () => resolve(255));
        child.on("close", (code) => resolve(code ?? 255));
      }),
  };
}
