/** Coordinated project-VM then control-plane production-route transaction. */

import type { AppRecord, VmRecord } from "../types.ts";
import type { SpawnResult } from "../ssh/runner.ts";
import {
  buildControlPlaneMainRouteReconcileScript,
  controlPlaneMainRouteFingerprint,
  needsControlPlaneMainRoute,
} from "./control-plane.ts";
import {
  buildProjectMainRouteBeginScript,
  buildProjectMainRouteCommitScript,
  buildProjectMainRoutePrepareScript,
  buildProjectMainRouteRollbackScript,
} from "./project-main.ts";

export type RouteScriptRunner = (
  vm: VmRecord,
  script: string,
) => Promise<SpawnResult>;

export interface TwoHopRouteDeps {
  projectRoute: RouteScriptRunner;
  controlPlaneRoute: RouteScriptRunner;
}

export interface TwoHopRouteResult {
  ok: boolean;
  routing: "ready" | "removed" | "failed";
  error?: string;
  warning?: string;
}

export function hasMainRouteDrift(app: AppRecord, vm: VmRecord): boolean {
  const desired = controlPlaneMainRouteFingerprint(app, vm);
  return (
    (app.controlPlaneRouteFingerprint === undefined &&
      app.mainHost !== undefined) ||
    (app.controlPlaneRouteFingerprint !== undefined &&
      app.controlPlaneRouteFingerprint !== desired)
  );
}

function failure(label: string, result: SpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${label} failed (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`;
}

async function rollbackProject(
  app: AppRecord,
  vm: VmRecord,
  fingerprint: string,
  deps: TwoHopRouteDeps,
): Promise<string | undefined> {
  try {
    const result = await deps.projectRoute(
      vm,
      buildProjectMainRouteRollbackScript(app, fingerprint),
    );
    return result.code === 0 ? undefined : failure("project-route rollback", result);
  } catch (e) {
    return `project-route rollback threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function beginTwoHopMainRoute(
  app: AppRecord,
  vm: VmRecord,
  deps: TwoHopRouteDeps,
): Promise<SpawnResult> {
  const desired = controlPlaneMainRouteFingerprint(app, vm);
  return deps.projectRoute(
    vm,
    buildProjectMainRouteBeginScript(
      app,
      desired,
      app.controlPlaneRouteFingerprint,
    ),
  );
}

export async function rollbackTwoHopMainRoute(
  app: AppRecord,
  vm: VmRecord,
  deps: TwoHopRouteDeps,
): Promise<string | undefined> {
  return rollbackProject(
    app,
    vm,
    controlPlaneMainRouteFingerprint(app, vm),
    deps,
  );
}

/** Complete a transaction begun before deploy, or a same-SHA route-only one. */
export async function completeTwoHopMainRoute(
  app: AppRecord,
  vm: VmRecord,
  deps: TwoHopRouteDeps,
): Promise<TwoHopRouteResult> {
  const desired = controlPlaneMainRouteFingerprint(app, vm);
  let prepared: SpawnResult;
  try {
    prepared = await deps.projectRoute(
      vm,
      buildProjectMainRoutePrepareScript(app, desired),
    );
  } catch (e) {
    const rollback = await rollbackProject(app, vm, desired, deps);
    return {
      ok: false,
      routing: "failed",
      error: `project-route prepare threw: ${e instanceof Error ? e.message : String(e)}` +
        (rollback === undefined ? "" : `; ${rollback}`),
    };
  }
  if (prepared.code !== 0) {
    const rollback = await rollbackProject(app, vm, desired, deps);
    return {
      ok: false,
      routing: "failed",
      error: failure("project-route prepare", prepared) +
        (rollback === undefined ? "" : `; ${rollback}`),
    };
  }

  let controlPlane: SpawnResult;
  try {
    controlPlane = await deps.controlPlaneRoute(
      vm,
      buildControlPlaneMainRouteReconcileScript(app, vm),
    );
  } catch (e) {
    const rollback = await rollbackProject(app, vm, desired, deps);
    return {
      ok: false,
      routing: "failed",
      error: `control-plane route reconcile threw: ${e instanceof Error ? e.message : String(e)}` +
        (rollback === undefined ? "" : `; ${rollback}`),
    };
  }
  if (controlPlane.code !== 0) {
    const rollback = await rollbackProject(app, vm, desired, deps);
    return {
      ok: false,
      routing: "failed",
      error: failure("control-plane route reconcile", controlPlane) +
        (rollback === undefined ? "" : `; ${rollback}`),
    };
  }

  try {
    const committed = await deps.projectRoute(
      vm,
      buildProjectMainRouteCommitScript(app, desired),
    );
    if (committed.code !== 0) {
      return {
        ok: false,
        routing: "failed",
        error: failure("project-route commit", committed),
      };
    }
  } catch (e) {
    return {
      ok: false,
      routing: "failed",
      error: `project-route commit threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return {
    ok: true,
    routing: needsControlPlaneMainRoute(app) ? "ready" : "removed",
  };
}

export async function reconcileTwoHopMainRoute(
  app: AppRecord,
  vm: VmRecord,
  deps: TwoHopRouteDeps,
): Promise<TwoHopRouteResult> {
  let begun: SpawnResult;
  try {
    begun = await beginTwoHopMainRoute(app, vm, deps);
  } catch (e) {
    return {
      ok: false,
      routing: "failed",
      error: `project-route begin threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (begun.code !== 0) {
    return { ok: false, routing: "failed", error: failure("project-route begin", begun) };
  }
  return completeTwoHopMainRoute(app, vm, deps);
}
