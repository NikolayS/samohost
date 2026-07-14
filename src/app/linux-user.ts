/** Strict service-account names safe for Linux tools and generated root scripts. */

const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const RESERVED_APP_USERS = new Set([
  "root",
  "postgres",
  "caddy",
  "sshd",
  "nobody",
]);

/** Return a neutral validation error, or undefined when the value is safe. */
export function linuxAppUserError(value: unknown): string | undefined {
  if (typeof value !== "string") return "appUser must be a string";
  if (value.length === 0) return "appUser must not be empty";
  if (value.length > 32) return "appUser must be at most 32 characters";
  if (!LINUX_USER_RE.test(value)) {
    return "appUser must match ^[a-z_][a-z0-9_-]{0,31}$";
  }
  if (RESERVED_APP_USERS.has(value)) {
    return "appUser must not name a reserved system account";
  }
  return undefined;
}

/** Fail closed before a user name reaches persistence or script rendering. */
export function assertLinuxAppUser(value: unknown): asserts value is string {
  const error = linuxAppUserError(value);
  if (error !== undefined) throw new Error(error);
}

/** Validate an optional AppSpec/AppRecord appUser. */
export function assertOptionalLinuxAppUser(
  value: unknown,
): asserts value is string | undefined {
  if (value !== undefined) assertLinuxAppUser(value);
}
