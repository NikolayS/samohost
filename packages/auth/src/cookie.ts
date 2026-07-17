/**
 * @samo/auth — cookie helpers.
 *
 * Builds Set-Cookie headers for the session cookie. The cookie is:
 *   - HttpOnly (JavaScript cannot read it)
 *   - SameSite=Lax (CSRF protection for most flows)
 *   - Max-Age set to SESSION_TTL_MS / 1000
 *   - Path=/
 *   - Secure omitted here — callers running behind HTTPS terminate at the
 *     reverse proxy; add Secure in the caller if needed.
 *
 * Cookie name: samo_session (generic, not tied to field-record's fr_session).
 *
 * parseCookieToken: parses the Cookie request header to extract the token.
 */

import { SESSION_TTL_MS } from './session.ts'

export const SESSION_COOKIE_NAME = 'samo_session'

const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000)  // 604800 (7 days)

/**
 * Build a Set-Cookie header value for a new session.
 *
 * @param rawToken - The raw session token (not the hash — that lives in the DB).
 */
export function buildSetCookieHeader(rawToken: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    `Max-Age=${SESSION_TTL_SEC}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ')
}

/**
 * Build a Set-Cookie header that clears the session cookie.
 */
export function clearCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ')
}

/**
 * Parse the Cookie request header and extract the session token value.
 * Returns null if the cookie is absent.
 *
 * @param cookieHeader - The raw value of the Cookie HTTP request header.
 */
export function parseCookieToken(cookieHeader: string): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE_NAME) {
      return rest.join('=') || null
    }
  }
  return null
}
