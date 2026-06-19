/**
 * `samohost runner` command family — runner-host provisioning surface.
 *
 * Subcommands:
 *   host-prep — print the ONE-TIME root script that installs the CI-port
 *               cleanup hook on the shared self-hosted GitHub Actions runner and
 *               wires it into the runner's job hooks.
 *
 * Like `env plan --host-prep`, this is OFFLINE and RENDER-ONLY: no network, no
 * SSH, no state writes. It resolves the VM from state purely to anchor the
 * output to a known host; the rendered script is applied by an operator with
 * root (NOT by repo-admin, NOT by samohost).
 */

import {
  buildRunnerHostPrepScript,
  DEFAULT_CI_PORTS,
  DEFAULT_HOOK_PATH,
  DEFAULT_RUNNER_HOME,
} from "../ci/runner-hook.ts";
import { StateStore } from "../state/store.ts";
import type { VmRecord } from "../types.ts";

/** VM lookup by id or name (same idiom as commands/env.ts). */
function findVm(store: StateStore, target: string): VmRecord | undefined {
  return store.list().find((r) => r.id === target || r.name === target);
}

export interface RunnerHostPrepInput {
  vm: string;
  /** CI ports the cleanup hook guards (default [3100]). */
  ciPorts: number[];
  /** actions-runner home carrying the hook env vars (default DEFAULT_RUNNER_HOME). */
  runnerHome?: string;
  /** Cleanup hook install path (default DEFAULT_HOOK_PATH). */
  hookDir?: string;
}

/**
 * Resolve the VM from state and print the runner host-prep script. Offline and
 * render-only — mirrors `runEnvPlan`'s `--host-prep` branch. Returns the process
 * exit code.
 */
export function runRunnerHostPrep(
  input: RunnerHostPrepInput,
  _opts: { json: boolean },
  vmStore: StateStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const vm = findVm(vmStore, input.vm);
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }

  const ciPorts = input.ciPorts.length > 0 ? input.ciPorts : [...DEFAULT_CI_PORTS];
  out(
    buildRunnerHostPrepScript({
      sshUser: vm.sshUser,
      runnerHome: input.runnerHome ?? DEFAULT_RUNNER_HOME,
      hookDir: input.hookDir ?? DEFAULT_HOOK_PATH,
      ciPorts,
    }),
  );
  return 0;
}
