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

/** Validate that preview env composition cannot inherit production secrets. */
export function validatePreviewEnvIsolation(app: AppSpec): void {
  if (app.kind === "static") return;

  // databaseUrlEnv is a compatibility alias for the primary DB URL, but the
  // clone-rewiring implementation intentionally iterates envDbVars so every
  // declared database URL receives clone-only credentials. Refuse a split
  // declaration or the compatibility variable could retain prod credentials.
  const effectiveDbVars = new Set(app.envDbVars ?? ["DATABASE_URL"]);
  if (
    app.databaseUrlEnv !== undefined &&
    !effectiveDbVars.has(app.databaseUrlEnv)
  ) {
    throw new Error(
      `${app.databaseUrlEnv} is declared as databaseUrlEnv but is missing from ` +
        `envDbVars; every preview DB URL must be clone-rewired`,
    );
  }

  if (app.envFile === undefined) return;
  const allow = app.previewEnvAllowlist;
  if (allow === undefined) {
    throw new Error(
      `app '${app.name}' declares envFile but has no previewEnvAllowlist; ` +
        `refusing to copy the production environment into preview code`,
    );
  }
  const allowed = new Set(allow);
  const envNameRe = /^[A-Z_][A-Z0-9_]*$/;
  for (const name of [...allow, ...(app.previewEnvUnset ?? [])]) {
    if (!envNameRe.test(name)) throw new Error(`invalid preview env name '${name}'`);
  }
  const requiredDbVars = isDatabaseBackedApp(app)
    ? effectiveDbVars
    : new Set(app.envDbVars ?? []);
  for (const name of requiredDbVars) {
    if (!allowed.has(name)) {
      throw new Error(`${name} must be present in previewEnvAllowlist for clone rewiring`);
    }
  }
  const generated = new Set(app.secrets ?? []);
  for (const name of allow) {
    if (generated.has(name)) {
      throw new Error(`${name} cannot be copied from production and generated per preview`);
    }
  }
  for (const name of app.previewEnvUnset ?? []) {
    if (requiredDbVars.has(name)) {
      throw new Error(`${name} cannot be unset because it is required for clone rewiring`);
    }
  }
}

/** Existing preview records may not preserve a legacy unsafe DB backend. */
export function assertStoredPreviewBackend(
  app: AppSpec,
  stored: EnvDbBackend,
): void {
  if (isDatabaseBackedApp(app) && stored !== "dblab") {
    throw new Error(
      `existing preview for database-backed app '${app.name}' is recorded with ` +
        `dbBackend='${stored}'; destroy/recreate it explicitly with DBLab before deployment`,
    );
  }
}
