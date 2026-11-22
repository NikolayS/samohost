/**
 * Database environment layout of a node app on its server.
 *
 * Split layout (default for node apps bootstrapped by this version):
 *   - the runtime env file (AppRecord.envFile, loaded by the systemd unit)
 *     holds the app's non-superuser APP_DATABASE_URL and no other database
 *     address;
 *   - the migrate env file (next to it, `migrate.env`) holds DATABASE_URL for
 *     the app's migration role (owner of the app's database only, not a
 *     cluster superuser) and the SEED_OWNER_* values. Only the deploy
 *     script's migrate step loads it.
 *
 * Legacy layout (apps bootstrapped before the split): one env file with the
 * superuser DATABASE_URL. Bootstrap and deploy detect it on the server (the
 * env file has a `DATABASE_URL=postgresql://postgres:` line and there is no
 * migrate env file) and keep it unchanged.
 */

/** Path of the migrate env file for a runtime env file path. */
export function migrateEnvFileOf(envFile: string): string {
  const slash = envFile.lastIndexOf("/");
  if (slash < 0) {
    throw new Error(`env file path must be absolute: ${JSON.stringify(envFile)}`);
  }
  const path = `${envFile.slice(0, slash)}/migrate.env`;
  if (path === envFile) {
    throw new Error(
      `env file ${JSON.stringify(envFile)} has the reserved name migrate.env; choose another envFile`,
    );
  }
  return path;
}

/**
 * Path of the release env file for a runtime env file path: written by each
 * node deploy (SAMO_RELEASE_TAG, SAMO_RELEASE_SHA) and loaded by the systemd
 * unit as an optional second EnvironmentFile.
 */
export function releaseEnvFileOf(envFile: string): string {
  const slash = envFile.lastIndexOf("/");
  if (slash < 0) {
    throw new Error(`env file path must be absolute: ${JSON.stringify(envFile)}`);
  }
  const path = `${envFile.slice(0, slash)}/release.env`;
  if (path === envFile) {
    throw new Error(
      `env file ${JSON.stringify(envFile)} has the reserved name release.env; choose another envFile`,
    );
  }
  return path;
}

/**
 * Names of the variables that hold database addresses for this app: they are
 * kept out of the environment of `npm ci` and the build in the split layout.
 */
export function databaseUrlVarsOf(app: {
  rlsUrlVar?: string;
  databaseUrlEnv?: string;
  envDbVars?: string[];
}): string[] {
  const names = new Set<string>(["DATABASE_URL", "APP_DATABASE_URL"]);
  for (const name of [app.rlsUrlVar, app.databaseUrlEnv, ...(app.envDbVars ?? [])]) {
    if (name !== undefined) names.add(name);
  }
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid database URL variable name: ${JSON.stringify(name)}`);
    }
  }
  return [...names];
}
