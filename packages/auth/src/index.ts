/**
 * @samo/auth — canonical bcrypt+cookie client-app auth module.
 *
 * Re-exports all public API surfaces. Consumers can import from the
 * top-level package or from individual sub-paths for tree-shaking:
 *
 *   import { hashPassword, verifyPassword } from '@samo/auth'
 *   import { createSession, validateSession, revokeSession, SESSION_TTL_MS } from '@samo/auth'
 *   import { buildSetCookieHeader, clearCookieHeader, parseCookieToken, SESSION_COOKIE_NAME } from '@samo/auth'
 *   import { requireAuth } from '@samo/auth'
 *   import { SqliteThrottle, THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS } from '@samo/auth'
 *
 * Postgres PRODUCTION path (requires `postgres` npm package):
 *   import { PgSessionStore, PgThrottle, requireAuthPg } from '@samo/auth'
 *   NOTE: PgSessionStore + PgThrottle are the production defaults.
 *         SqliteThrottle / createSession / validateSession / revokeSession are
 *         TEST/DEV doubles only — do NOT use as the prod default.
 *
 * Migration: packages/auth/migrations/0001_auth.sql
 */

export {
  hashPassword,
  verifyPassword,
  validatePasswordLength,
  BCRYPT_ROUNDS,
} from './password.ts'

export {
  createSession,
  validateSession,
  revokeSession,
  createSessionPg,
  validateSessionPg,
  revokeSessionPg,
  SESSION_TTL_MS,
  type SessionUser,
  type AuthDb,
} from './session.ts'

export {
  buildSetCookieHeader,
  clearCookieHeader,
  parseCookieToken,
  SESSION_COOKIE_NAME,
  type CookieOptions,
} from './cookie.ts'

export {
  requireAuth,
  type AuthRequest,
  type AuthResponse,
  type NextFn,
} from './middleware.ts'

export {
  SqliteThrottle,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
} from './throttle.ts'

// ---------------------------------------------------------------------------
// Postgres PRODUCTION path — concrete postgres.js-backed implementations.
// These are the production exports. Use PgSessionStore + PgThrottle in all
// server code that runs against real Postgres. SqliteThrottle and the
// standalone createSession/validateSession/revokeSession functions are test
// doubles only.
// ---------------------------------------------------------------------------

export { PgSessionStore, PgThrottle, requireAuthPg } from './pg.ts'
