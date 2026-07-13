import type { AppSpec, EnvDbBackend } from "../types.ts";

/** Whether an app needs an isolated database in preview environments. */
export function isDatabaseBackedApp(app: AppSpec): boolean {
  if (app.kind === "static") return false;

  if (app.dbBackend !== undefined && app.dbBackend !== "none") return true;
  if (app.previewDbBackend === "dblab" || app.previewDbBackend === "template") return true;
  if (app.migrateCmd !== undefined) return true;
  if (app.databaseUrlEnv !== undefined) return true;
  if ((app.envDbVars?.length ?? 0) > 0) return true;

  // Missing dbBackend is the legacy "database present" state. A no-database
  // node app must opt out explicitly; otherwise fail closed.
  return app.dbBackend !== "none";
}

/**
 * Resolve and enforce the preview database policy before any remote mutation.
 * Database-backed previews are DBLab-only; none/template are never fallbacks.
 */
export function resolvePreviewDbBackend(
  app: AppSpec,
  requested?: EnvDbBackend,
): EnvDbBackend {
  const resolved =
    requested ??
    app.previewDbBackend ??
    (app.kind === "static" || app.dbBackend === "none" ? "none" : "dblab");

  if (isDatabaseBackedApp(app) && resolved !== "dblab") {
    throw new Error(
      `database-backed app '${app.name}' requires previewDbBackend='dblab' ` +
        `(resolved '${resolved}'); 'none' and 'template' previews are forbidden`,
    );
  }

  return resolved;
}
