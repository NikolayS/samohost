/**
 * App identities reach systemd descriptions, Caddy and sudoers paths, and
 * generated shell. Keep their alphabet deliberately narrow at both ingress
 * and builder boundaries so a hand-edited state file cannot become code.
 */

export const SAFE_APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SAFE_APP_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export function isSafeAppName(value: string): boolean {
  return SAFE_APP_NAME_RE.test(value);
}

export function isSafeAppId(value: string): boolean {
  return SAFE_APP_ID_RE.test(value);
}

export function assertSafeAppName(value: string): void {
  if (!isSafeAppName(value)) {
    throw new Error(
      `invalid app name ${JSON.stringify(value)}: expected a lowercase DNS label ` +
        "using only a-z, 0-9, and interior hyphens (maximum 63 characters)",
    );
  }
}

export function assertSafeAppId(value: string): void {
  if (!isSafeAppId(value)) {
    throw new Error(
      `invalid app id ${JSON.stringify(value)}: expected 1-128 characters from ` +
        "A-Z, a-z, 0-9, dot, underscore, and interior hyphens",
    );
  }
}

export function assertSafeAppIdentity(app: { name: string; id: string }): void {
  assertSafeAppName(app.name);
  assertSafeAppId(app.id);
}
