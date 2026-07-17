/**
 * @samo/auth — concrete Postgres implementations (postgres.js).
 *
 * This is the PRODUCTION path a client imports and runs against vanilla Postgres.
 * SQLite (bun:sqlite) is a TEST/DEV double only — see test/auth.test.ts.
 *
 * PgSessionStore: createSession / validateSession / revokeSession
 *   - Session tokens are 32 random bytes rendered as 64-char hex (raw).
 *   - The raw token is returned to the caller for placement in an httpOnly cookie.
 *   - ONLY the SHA-256 hex digest is stored in app_sessions.token.
 *   - The CHECK constraint (token ~ '^[0-9a-f]{64}$') rejects any raw-token writes.
 *   - validateSession enforces: expires_at > NOW(), user.status = 'active',
 *     user.archived_at IS NULL.
 *
 * PgThrottle: isThrottled / recordFailure / clearThrottle
 *   - DB-backed throttle state survives restarts.
 *   - 5 failures within a 15-minute window locks the account.
 *   - Throttle key is LOWER(login) — case-insensitive.
 *
 * requireAuthPg: middleware guard backed by PgSessionStore.
 *   - Framework-agnostic (same AuthRequest / AuthResponse shape as requireAuth).
 *   - Does NOT import bun:sqlite; safe for vanilla-Node/Postgres server code.
 *
 * Both classes accept a postgres.js Sql instance (import('postgres').Sql).
 * Wire them at server startup alongside the requireAuthPg middleware.
 *
 * Usage:
 *   import postgres from 'postgres'
 *   import { PgSessionStore, PgThrottle, requireAuthPg } from '@samo/auth'
 *
 *   const sql = postgres(process.env.DATABASE_URL!)
 *   const sessions = new PgSessionStore(sql)
 *   const throttle = new PgThrottle(sql)
 *
 *   // In a route handler:
 *   await requireAuthPg(sessions, req, res, next)
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import type { SessionUser } from './session.ts'
import { SESSION_TTL_MS } from './session.ts'
import { THROTTLE_MAX_ATTEMPTS, THROTTLE_WINDOW_MS } from './throttle.ts'
import { parseCookieToken } from './cookie.ts'
import type { AuthRequest, AuthResponse, NextFn } from './middleware.ts'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function generateRawToken(): string {
  return randomBytes(32).toString('hex')
}

// ---------------------------------------------------------------------------
// PgSessionStore
// ---------------------------------------------------------------------------

export class PgSessionStore {
  constructor(private readonly sql: Sql) {}

  /**
   * Create a session for an authenticated user.
   *
   * @param userId       The authenticated user's UUID.
   * @param ttlOverrideMs  Optional TTL override in ms. Negative = pre-expired (test use only).
   * @returns Raw session token for placement in an httpOnly cookie.
   *          This value is NEVER stored — only its SHA-256 hash is written to app_sessions.
   */
  async createSession(userId: string, ttlOverrideMs?: number): Promise<string> {
    const raw = generateRawToken()
    const hash = hashToken(raw)
    const ttl = ttlOverrideMs ?? SESSION_TTL_MS
    const expiresAt = new Date(Date.now() + ttl).toISOString()

    await this.sql`
      INSERT INTO app_sessions (app_user_id, token, expires_at)
      VALUES (${userId}, ${hash}, ${expiresAt})
    `
    return raw
  }

  /**
   * Resolve a raw session token to its user.
   * Returns null if the session is missing, expired, or the user is inactive/archived.
   *
   * The raw token is hashed before lookup — the DB never sees raw tokens.
   */
  async validateSession(rawToken: string): Promise<SessionUser | null> {
    const hash = hashToken(rawToken)

    const rows = await this.sql<SessionUser[]>`
      SELECT
        u.id,
        u.login,
        u.email,
        u.role,
        u.status
      FROM app_sessions s
      JOIN app_users u ON u.id = s.app_user_id
      WHERE s.token = ${hash}
        AND s.expires_at > NOW()
        AND u.status = 'active'
        AND u.archived_at IS NULL
      LIMIT 1
    `

    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      login: row.login,
      email: row.email ?? null,
      role: row.role,
      status: row.status,
    }
  }

  /**
   * Delete a session (sign-out). Accepts the raw token from the cookie.
   * Hashes before delete — the DB never sees raw tokens.
   */
  async revokeSession(rawToken: string): Promise<void> {
    const hash = hashToken(rawToken)
    await this.sql`DELETE FROM app_sessions WHERE token = ${hash}`
  }
}

// ---------------------------------------------------------------------------
// PgThrottle
// ---------------------------------------------------------------------------

export class PgThrottle {
  constructor(private readonly sql: Sql) {}

  /**
   * Returns true if the login is currently throttled.
   * Throttled = a live row exists (window not yet expired) AND attempt_count >= threshold.
   */
  async isThrottled(login: string): Promise<boolean> {
    const key = login.toLowerCase()
    const cutoff = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()

    const rows = await this.sql<{ attempt_count: number }[]>`
      SELECT attempt_count
      FROM login_attempts
      WHERE login_key = ${key}
        AND window_start > ${cutoff}
      LIMIT 1
    `

    const row = rows[0]
    if (!row) return false
    return row.attempt_count >= THROTTLE_MAX_ATTEMPTS
  }

  /**
   * Record one failed sign-in attempt for the login.
   *
   * - Live window exists: increment attempt_count.
   * - Row is expired OR absent: insert a fresh row with count=1.
   *
   * Uses Postgres UPSERT with conditional reset:
   *   ON CONFLICT (login_key) DO UPDATE:
   *     - If the existing window_start is still live → increment.
   *     - If the existing window_start is expired → reset to count=1 with new window.
   */
  async recordFailure(login: string): Promise<void> {
    const key = login.toLowerCase()
    const cutoff = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()
    const now = new Date().toISOString()

    await this.sql`
      INSERT INTO login_attempts (login_key, attempt_count, window_start, updated_at)
      VALUES (${key}, 1, ${now}, ${now})
      ON CONFLICT (login_key) DO UPDATE SET
        attempt_count = CASE
          WHEN login_attempts.window_start > ${cutoff}
            THEN login_attempts.attempt_count + 1
          ELSE 1
        END,
        window_start = CASE
          WHEN login_attempts.window_start > ${cutoff}
            THEN login_attempts.window_start
          ELSE ${now}
        END,
        updated_at = ${now}
    `
  }

  /**
   * Clear throttle state for the login (called on successful sign-in).
   */
  async clearThrottle(login: string): Promise<void> {
    const key = login.toLowerCase()
    await this.sql`DELETE FROM login_attempts WHERE login_key = ${key}`
  }
}

// ---------------------------------------------------------------------------
// requireAuthPg — middleware backed by PgSessionStore
// ---------------------------------------------------------------------------

/**
 * requireAuthPg — middleware backed by PgSessionStore.
 *
 * Framework-agnostic guard. Does NOT import bun:sqlite — safe for
 * vanilla-Postgres server code.
 *
 * On success: calls next() and attaches the resolved user to req.user.
 * On failure: sets res.statusCode = 401 and calls res.end() with a JSON body.
 *
 * Usage (Fastify-style):
 *   await requireAuthPg(sessions, req, reply, () => { /* route handler *\/ })
 *
 * Usage (Express-style):
 *   app.use((req, res, next) => requireAuthPg(sessions, req, res, next))
 */
export async function requireAuthPg(
  store: PgSessionStore,
  req: AuthRequest,
  res: AuthResponse,
  next: NextFn,
): Promise<void> {
  const cookieHeader = req.headers['cookie'] ?? ''
  const token = parseCookieToken(cookieHeader)

  if (!token) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  const user = await store.validateSession(token)
  if (!user) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  req.user = user
  await next()
}
