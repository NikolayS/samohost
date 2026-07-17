/**
 * @samo/auth — session store.
 *
 * Session tokens are 32 random bytes rendered as 64-char hex (raw).
 * The raw token is returned to the caller for placement in an httpOnly cookie.
 * ONLY the SHA-256 hex digest of the raw token is persisted in app_sessions.
 *
 * This design is lifted from field-record-1 (migration 0010_hashed_tokens.sql,
 * src/auth.ts createSessionForUser / resolveSession / revokeSession):
 *   - A DB breach cannot replay sessions because hashes are one-way.
 *   - The CHECK constraint on app_sessions.token ('^[0-9a-f]{64}$') rejects
 *     any code path that accidentally tries to store a raw token.
 *
 * Accepts a Bun SQLite Database instance. Production code using postgres.js
 * should use the PgSessionStore (see below) or wrap postgres.js with the
 * AuthDb interface.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string
  login: string
  email: string | null
  role: string
  status: string
}

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
// Public API
//
// These functions accept a Bun SQLite Database directly. The schema must match
// the 0001_auth.sql migration (app_sessions, app_users tables).
//
// For postgres.js (production), call the same functions via PgSessionStore.
// ---------------------------------------------------------------------------

/**
 * Create a session for an authenticated user.
 *
 * @param db           Bun SQLite Database with auth schema applied.
 * @param userId       The authenticated user's ID.
 * @param ttlOverrideMs  Optional TTL override in ms. Negative = pre-expired (test use only).
 * @returns Raw session token for placement in an httpOnly cookie.
 *          This value is NEVER stored — only its SHA-256 hash is written to app_sessions.
 */
export async function createSession(
  db: Database,
  userId: string,
  ttlOverrideMs?: number,
): Promise<string> {
  const raw = generateRawToken()
  const hash = hashToken(raw)
  const ttl = ttlOverrideMs ?? SESSION_TTL_MS
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  const id = randomBytes(16).toString('hex')

  db.run(
    `INSERT INTO app_sessions (id, app_user_id, token, expires_at)
     VALUES (?, ?, ?, ?)`,
    [id, userId, hash, expiresAt],
  )
  return raw
}

/**
 * Resolve a raw session token to its user.
 * Returns null if the session is missing, expired, or the user is inactive/archived.
 *
 * The raw token is hashed before lookup — the DB never sees raw tokens.
 */
export async function validateSession(
  db: Database,
  rawToken: string,
): Promise<SessionUser | null> {
  const hash = hashToken(rawToken)
  const now = new Date().toISOString()

  const row = db.query<SessionUser & { expires_at: string }, [string, string]>(`
    SELECT
      u.id,
      u.login,
      u.email,
      u.role,
      u.status,
      s.expires_at
    FROM app_sessions s
    JOIN app_users u ON u.id = s.app_user_id
    WHERE s.token = ?
      AND s.expires_at > ?
      AND u.status = 'active'
      AND u.archived_at IS NULL
    LIMIT 1
  `).get(hash, now)

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
export async function revokeSession(
  db: Database,
  rawToken: string,
): Promise<void> {
  const hash = hashToken(rawToken)
  db.run('DELETE FROM app_sessions WHERE token = ?', [hash])
}

// ---------------------------------------------------------------------------
// Production postgres.js adapter interface.
//
// When using postgres.js in a server, implement AuthDb and pass it to
// the Pg-prefixed variants below, or build your own thin wrapper.
// ---------------------------------------------------------------------------

export interface AuthDb {
  insertSession(params: {
    id: string
    appUserId: string
    token: string       // SHA-256 hex digest only — never the raw token
    expiresAt: string   // ISO 8601
  }): Promise<void>

  findSessionWithUser(tokenHash: string, nowIso: string): Promise<SessionUser | null>

  deleteSession(tokenHash: string): Promise<void>
}

/**
 * Create a session using a generic AuthDb (e.g., postgres.js wrapper).
 * Identical semantics to createSession — exists so prod code avoids importing bun:sqlite.
 */
export async function createSessionPg(
  db: AuthDb,
  userId: string,
  ttlOverrideMs?: number,
): Promise<string> {
  const raw = generateRawToken()
  const hash = hashToken(raw)
  const ttl = ttlOverrideMs ?? SESSION_TTL_MS
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  const id = randomBytes(16).toString('hex')

  await db.insertSession({ id, appUserId: userId, token: hash, expiresAt })
  return raw
}

export async function validateSessionPg(db: AuthDb, rawToken: string): Promise<SessionUser | null> {
  const hash = hashToken(rawToken)
  return db.findSessionWithUser(hash, new Date().toISOString())
}

export async function revokeSessionPg(db: AuthDb, rawToken: string): Promise<void> {
  const hash = hashToken(rawToken)
  await db.deleteSession(hash)
}
