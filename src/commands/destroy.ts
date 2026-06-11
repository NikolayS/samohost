/**
 * `samohost destroy` (SPEC §3 story 5, §5 state machine).
 *
 * Tears down the provider resource with a typed-name confirmation (the
 * cost-leak guard: `--yes` is the only bypass), transitioning
 * `<reclaimable> → destroying → destroyed` and persisting after each step.
 *
 * Consistency contract:
 *  - attached volumes are SURFACED (id/name/size) but NEVER deleted — data
 *    outlives cattle by default;
 *  - a provider API failure leaves the record in `destroying` (truthful:
 *    delete was attempted, resource may still exist) and exits non-zero;
 *    re-running destroy retries from there;
 *  - provider `notFound` means the resource is already gone: proceed to
 *    `destroyed`;
 *  - records that never owned a resource (failed creates, empty providerId)
 *    skip the API call entirely;
 *  - delete protection is never enabled anywhere, so no unprotect dance.
 *
 * Destroy is legal from creating/booting too (crash reclaim — see
 * orchestrator/lifecycle.ts): a provision that died mid-flight must always be
 * reclaimable.
 */

import { createInterface } from "node:readline";
import type { VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";
import type { ProviderPort } from "../providers/types.ts";
import { canTransition } from "../orchestrator/lifecycle.ts";

export interface DestroyInput {
  /** VM name or record id. */
  target: string;
  /** Skip the typed confirmation. */
  yes: boolean;
}

export interface DestroyDeps {
  provider: ProviderPort;
  store: StateStore;
  /** Prompt the operator; resolves with the typed line. */
  confirm: (prompt: string) => Promise<string>;
}

export async function runDestroy(
  input: DestroyInput,
  opts: { json: boolean },
  deps: DestroyDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const records = deps.store.list();
  let record = records.find(
    (r) => r.id === input.target || r.name === input.target,
  );
  if (record === undefined) {
    err(`error: no VM named or id'd '${input.target}' in state`);
    return 1;
  }
  if (record.lifecycleState === "destroyed") {
    err(`error: ${record.name} is already destroyed`);
    return 1;
  }
  const retrying = record.lifecycleState === "destroying";
  if (!retrying && !canTransition(record.lifecycleState, "destroying")) {
    err(
      `error: cannot destroy ${record.name} from state '${record.lifecycleState}'`,
    );
    return 1;
  }

  // ---- typed confirmation (cost-leak guard) ----
  if (!input.yes) {
    const typed = await deps.confirm(
      `This will DELETE the provider resource for '${record.name}' ` +
        `(${record.provider} id ${record.providerId || "-"}). ` +
        `Type the VM name to confirm: `,
    );
    if (typed.trim() !== record.name) {
      err(
        `aborted: confirmation '${typed.trim()}' does not match VM name ` +
          `'${record.name}'. Nothing was changed.`,
      );
      return 1;
    }
  }

  const persist = (changes: Partial<VmRecord>): void => {
    record = deps.store.upsert({ ...record!, ...changes });
  };

  // ---- surface (never delete) attached volumes ----
  if (record.providerId !== "") {
    try {
      const volumes = await deps.provider.listVolumes(record.providerId);
      for (const v of volumes) {
        out(
          `attached volume NOT deleted: id=${v.id} name=${v.name} ` +
            `size=${v.sizeGb}GB — delete it manually if it is no longer needed`,
        );
      }
    } catch (e) {
      const norm = deps.provider.normalizeError(e);
      // notFound = server already gone; anything else is informational only.
      if (norm.kind !== "notFound") {
        err(`warning: could not list attached volumes [${norm.kind}]: ${norm.message}`);
      }
    }
  }

  // ---- destroying (persisted before the API call) ----
  if (!retrying) persist({ lifecycleState: "destroying" });

  if (record.providerId !== "") {
    try {
      await deps.provider.destroy(record.providerId);
    } catch (e) {
      const norm = deps.provider.normalizeError(e);
      if (norm.kind !== "notFound") {
        err(
          `error: provider delete failed [${norm.kind}]: ${norm.message}. ` +
            `State left as 'destroying' — the resource may still exist; ` +
            `re-run \`samohost destroy ${record.name}\` to retry.`,
        );
        return 1;
      }
      // notFound: already gone — fall through to destroyed.
    }
  }

  persist({ lifecycleState: "destroyed" });

  if (opts.json) {
    out(JSON.stringify(record, null, 2));
  } else {
    out(`destroyed ${record.name}  (provider id ${record.providerId || "-"})`);
  }
  return 0;
}

/** Production confirm(): one line from the controlling terminal. */
export function defaultConfirm(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
