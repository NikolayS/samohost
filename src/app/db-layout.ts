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

/** Names in the app base directory that bootstrap and deploy use themselves. */
const RESERVED_IN_APP_BASE = new Set(["migrate.env", "release.env", "git-safe.conf", ".gh-token", "uploads"]);

/**
 * Split layout: bootstrap makes the app base directory root-owned, and
 * migrate.env and release.env sit next to the env file. So the env file and
 * the checkout must both be entries directly in the app base directory, with
 * names that bootstrap does not use for other files. Returns the reason when
 * they are not, or undefined.
 */
export function splitLayoutPathError(appBase: string, envFile: string, appDir: string): string | undefined {
  if (!/^(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/.test(appBase) || /\/\.\.?(\/|$)/.test(appBase)) {
    return `the new layout needs an absolute app base directory without . or .. parts (it is ${appBase})`;
  }
  const nameIn = (path: string): string | undefined => {
    if (!path.startsWith(`${appBase}/`)) return undefined;
    const name = path.slice(appBase.length + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return undefined;
    return name;
  };
  const checkout = nameIn(appDir.replace(/\/+$/, ""));
  if (checkout === undefined || RESERVED_IN_APP_BASE.has(checkout)) {
    return `the new layout needs the checkout to be a folder directly in ${appBase}/ other than uploads (it is ${appDir})`;
  }
  const env = nameIn(envFile);
  if (env === undefined || RESERVED_IN_APP_BASE.has(env) || env === checkout) {
    return `the new layout needs the env file directly in ${appBase}/, named other than ${[...RESERVED_IN_APP_BASE, checkout].join(", ")} (it is ${envFile})`;
  }
  return undefined;
}
