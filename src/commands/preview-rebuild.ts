/**
 * `samohost preview rebuild <vm> <app> <branch>` — idempotent env rebuild.
 *
 * Looks up the VmRecord and AppRecord from state stores, then delegates to the
 * already-idempotent `runEnvCreate` flow:
 *   destroy-if-exists clone → dblab clone create latest snapshot →
 *   samohost_sync_clone_globals → rewire .env DATABASE_URL to
 *   127.0.0.1:<clonePort> → restart unit → sudo tee+reload the Caddy snippet →
 *   #55 external HTTPS health probe.
 *
 * Defaults: db=dblab, previewDomain=samo.cat (same as `env create`).
 * Supports --json and incremental status output.
 */

import {
  runEnvCreate,
  DEFAULT_PREVIEW_DOMAIN,
  defaultEnvStore,
  defaultEnvExecDeps,
  type EnvCreateInput,
  type EnvExecDeps,
} from "./env.ts";
import { AppStore } from "../state/apps.ts";
import { EnvStore } from "../state/envs.ts";
import { StateStore } from "../state/store.ts";

// ---------------------------------------------------------------------------
// Input / dependency types
// ---------------------------------------------------------------------------

export interface PreviewRebuildInput {
  vm: string;
  app: string;
  branch: string;
}

/**
 * Injectable dependencies for `runPreviewRebuild`. Separated from the
 * production wiring so tests can inject fakes without touching the filesystem,
 * SSH, or network.
 */
export interface PreviewRebuildDeps {
  /**
   * Delegate: runs the idempotent env-create flow.
   * In tests this is a fake; in production it is the real `runEnvCreate`.
   */
  runEnvCreate: (
    input: EnvCreateInput,
    opts: { json: boolean },
    vmStore: StateStore,
    appStore: AppStore,
    envStore: EnvStore,
    execDeps: EnvExecDeps,
    out: (s: string) => void,
    err: (s: string) => void,
  ) => Promise<number>;
  vmStore: StateStore;
  appStore: AppStore;
  envStore: EnvStore;
}

// ---------------------------------------------------------------------------
// Production dependency factory
// ---------------------------------------------------------------------------

export function defaultPreviewRebuildDeps(): PreviewRebuildDeps {
  return {
    runEnvCreate,
    vmStore: new StateStore(),
    appStore: new AppStore(),
    envStore: defaultEnvStore(),
  };
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/**
 * Run the `preview rebuild` command.
 *
 * Exits:
 *   0  rebuild succeeded (env-create reported ok)
 *   1  VM/app not found in state, or env-create returned non-zero
 */
export async function runPreviewRebuild(
  input: PreviewRebuildInput,
  opts: { json: boolean },
  deps: PreviewRebuildDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  // Resolve VM
  const vm = deps.vmStore.list().find(
    (r) => r.id === input.vm || r.name === input.vm,
  );
  if (vm === undefined) {
    err(`error: VM not found in state: ${input.vm}`);
    return 1;
  }

  // Resolve app on VM
  const app = deps.appStore.get(vm.id, input.app);
  if (app === undefined) {
    err(`error: app not found on vm ${vm.name}: ${input.app}`);
    return 1;
  }

  // Incremental status output before the (potentially long) delegate call.
  out(`rebuilding preview env for ${app.name} / ${input.branch} on ${vm.name} …`);

  const createInput: EnvCreateInput = {
    vm: input.vm,
    app: input.app,
    branch: input.branch,
    db: "dblab",
    previewDomain: DEFAULT_PREVIEW_DOMAIN,
  };

  return deps.runEnvCreate(
    createInput,
    { json: opts.json },
    deps.vmStore,
    deps.appStore,
    deps.envStore,
    defaultEnvExecDeps(),
    out,
    err,
  );
}
