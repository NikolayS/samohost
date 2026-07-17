/**
 * @samo/auth — RED-first test suite.
 *
 * TDD: these tests are written BEFORE the implementation.
 * All tests must fail (import error or assertion failure) on first commit.
 *
 * Coverage:
 *   1. hashPassword / verifyPassword — bcrypt round-trip + wrong-password rejection
 *      + minimum-length enforcement
 *   2. Session store — raw token never persisted; DB stores only SHA-256 hash;
 *      createSession returns raw token; validateSession hashes before lookup;
 *      revokeSession hashes before delete
 *   3. Cookie helpers — httpOnly + SameSite=Lax attributes enforced
 *   4. requireAuth guard — rejects missing / invalid / expired / revoked sessions;
 *      accepts valid session and attaches user to context
 *   5. Login throttle — locks after THROTTLE_MAX_ATTEMPTS failures within window;
 *      resets on clearThrottle; isThrottled returns false when no failures;
 *      recordFailure increments; expired windows do not block
 *   6. Migration smoke — 0001_auth.sql is valid SQL containing the required
 *      CREATE TABLE / CHECK / index statements; no GoTrue-reserved table names
 *
 * Test approach:
 *   - bcrypt tests use real bcryptjs (no mock of the algo under test).
 *   - Session-store tests use an in-process SQLite DB (via Bun's built-in
 *     :memory: SQLite) shaped to match the Postgres migration exactly, so no
 *     real Postgres server is needed in CI and the schema contract is validated.
 *     The real prod shape: app_sessions.token stores a 64-char hex SHA-256
 *     digest; app_users has id UUID, login TEXT, password_hash TEXT, role TEXT,
 *     status TEXT, archived_at TIMESTAMPTZ nullable.
 *   - Cookie tests inspect the Set-Cookie header string directly.
 *   - requireAuth tests use a minimal fake request/response pair.
 *   - Throttle tests use the same in-process SQLite DB.
 *   - Migration test reads the SQL file and asserts structural presence.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  hashPassword,
  verifyPassword,
  validatePasswordLength,
  BCRYPT_ROUNDS,
} from '../src/password.ts'

import {
  createSession,
  validateSession,
  revokeSession,
  SESSION_TTL_MS,
} from '../src/session.ts'

import {
  buildSetCookieHeader,
  clearCookieHeader,
  SESSION_COOKIE_NAME,
  parseCookieToken,
} from '../src/cookie.ts'

import {
  requireAuth,
  type AuthRequest,
} from '../src/middleware.ts'

import {
  SqliteThrottle,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
} from '../src/throttle.ts'

// ---------------------------------------------------------------------------
// SQLite helper — in-process DB shaped to match the Postgres migration.
// The schema mirrors 0001_auth.sql exactly (column names + CHECK constraint).
// ---------------------------------------------------------------------------

/** Spin up an in-process SQLite DB with the auth schema applied. */
function makeTestDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE app_users (
      id           TEXT        PRIMARY KEY,
      login        TEXT        NOT NULL UNIQUE,
      email        TEXT,
      password_hash TEXT       NOT NULL,
      role         TEXT        NOT NULL DEFAULT 'user',
      status       TEXT        NOT NULL DEFAULT 'active',
      created_at   TEXT        NOT NULL DEFAULT (datetime('now')),
      archived_at  TEXT
    );

    CREATE TABLE app_sessions (
      id          TEXT        PRIMARY KEY,
      app_user_id TEXT        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      -- SQLite: enforce length=64 and all-hex via GLOB repeating pattern.
      -- Postgres equivalent: CHECK (token ~ '^[0-9a-f]{64}$')
      token       TEXT        NOT NULL UNIQUE
                              CHECK (length(token) = 64 AND lower(token) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
      expires_at  TEXT        NOT NULL,
      created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE login_attempts (
      id            TEXT        PRIMARY KEY,
      login_key     TEXT        NOT NULL UNIQUE,
      attempt_count INTEGER     NOT NULL DEFAULT 1,
      window_start  TEXT        NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT        NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

// SHA-256 hex — used to verify the module never stores the raw token.
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// ---------------------------------------------------------------------------
// 1. Password helpers
// ---------------------------------------------------------------------------

describe('hashPassword / verifyPassword', () => {
  test('round-trip: correct password verifies to true', async () => {
    const hash = await hashPassword('correct-horse-battery')
    const ok = await verifyPassword('correct-horse-battery', hash)
    expect(ok).toBe(true)
  })

  test('wrong password verifies to false', async () => {
    const hash = await hashPassword('correct-horse-battery')
    const ok = await verifyPassword('wrong-password-xyz', hash)
    expect(ok).toBe(false)
  })

  test('produced hash is a bcrypt hash (starts with $2)', async () => {
    const hash = await hashPassword('longenoughpw')
    expect(hash.startsWith('$2')).toBe(true)
  })

  test('BCRYPT_ROUNDS is 12', () => {
    expect(BCRYPT_ROUNDS).toBe(12)
  })

  test('password shorter than 8 chars throws', async () => {
    await expect(hashPassword('short')).rejects.toThrow('at least 8')
  })

  test('validatePasswordLength throws on 7-char input', () => {
    expect(() => validatePasswordLength('1234567')).toThrow()
  })

  test('validatePasswordLength passes on 8-char input', () => {
    expect(() => validatePasswordLength('12345678')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. Session store (SQLite-backed, matching Postgres migration shape)
// ---------------------------------------------------------------------------

describe('session store', () => {
  let db: Database
  let userId: string

  beforeEach(() => {
    db = makeTestDb()
    userId = randomBytes(16).toString('hex')
    // Insert a fixture user.
    db.run(
      `INSERT INTO app_users (id, login, password_hash, role, status)
       VALUES (?, ?, ?, 'user', 'active')`,
      [userId, 'testuser', '$2b$12$placeholder'],
    )
  })

  afterEach(() => {
    db.close()
  })

  test('createSession returns a raw token (64-char hex)', async () => {
    const token = await createSession(db, userId)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('raw token is NOT stored in DB — only its SHA-256 hash is', async () => {
    const token = await createSession(db, userId)
    const rows = db.query<{ token: string }, []>('SELECT token FROM app_sessions').all()
    expect(rows.length).toBe(1)
    const stored = rows[0]!.token
    // The stored value must NOT equal the raw token.
    expect(stored).not.toBe(token)
    // The stored value must equal the SHA-256 hash of the raw token.
    expect(stored).toBe(sha256hex(token))
  })

  test('stored token is exactly 64 lowercase hex chars', async () => {
    await createSession(db, userId)
    const rows = db.query<{ token: string }, []>('SELECT token FROM app_sessions').all()
    expect(rows[0]!.token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('validateSession returns the user for a valid token', async () => {
    const token = await createSession(db, userId)
    const user = await validateSession(db, token)
    expect(user).not.toBeNull()
    expect(user!.id).toBe(userId)
  })

  test('validateSession returns null for an unknown token', async () => {
    const fakeToken = randomBytes(32).toString('hex')
    const user = await validateSession(db, fakeToken)
    expect(user).toBeNull()
  })

  test('validateSession returns null for an expired session', async () => {
    const token = await createSession(db, userId, -1000) // already expired
    const user = await validateSession(db, token)
    expect(user).toBeNull()
  })

  test('revokeSession deletes the session so subsequent validateSession returns null', async () => {
    const token = await createSession(db, userId)
    await revokeSession(db, token)
    const user = await validateSession(db, token)
    expect(user).toBeNull()
  })

  test('revokeSession hashes before deleting (no raw token in DB after creation)', async () => {
    const token = await createSession(db, userId)
    // Confirm the row exists.
    const before = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM app_sessions').get()!
    expect(before.count).toBe(1)
    await revokeSession(db, token)
    const after = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM app_sessions').get()!
    expect(after.count).toBe(0)
  })

  test('SESSION_TTL_MS is 7 days', () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// 3. Cookie helpers
// ---------------------------------------------------------------------------

describe('cookie helpers', () => {
  test('buildSetCookieHeader includes HttpOnly', () => {
    const header = buildSetCookieHeader('rawtoken123abc')
    expect(header.toLowerCase()).toContain('httponly')
  })

  test('buildSetCookieHeader includes SameSite=Lax', () => {
    const header = buildSetCookieHeader('rawtoken123abc')
    expect(header.toLowerCase()).toContain('samesite=lax')
  })

  test('buildSetCookieHeader uses SESSION_COOKIE_NAME', () => {
    const header = buildSetCookieHeader('rawtoken123abc')
    expect(header).toContain(`${SESSION_COOKIE_NAME}=rawtoken123abc`)
  })

  test('buildSetCookieHeader includes Max-Age / Expires', () => {
    const header = buildSetCookieHeader('rawtoken123abc')
    const lower = header.toLowerCase()
    expect(lower.includes('max-age') || lower.includes('expires')).toBe(true)
  })

  test('clearCookieHeader sets Max-Age=0', () => {
    const header = clearCookieHeader()
    expect(header).toContain('Max-Age=0')
  })

  test('clearCookieHeader uses SESSION_COOKIE_NAME', () => {
    const header = clearCookieHeader()
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`)
  })

  test('SESSION_COOKIE_NAME is a non-empty string', () => {
    expect(typeof SESSION_COOKIE_NAME).toBe('string')
    expect(SESSION_COOKIE_NAME.length).toBeGreaterThan(0)
  })

  test('parseCookieToken extracts token from Cookie header', () => {
    // SESSION_COOKIE_NAME may or may not be samo_session; test with the actual name.
    const cookieHeader = `other=x; ${SESSION_COOKIE_NAME}=deadbeef; more=y`
    const token = parseCookieToken(cookieHeader)
    expect(token).toBe('deadbeef')
  })

  test('parseCookieToken returns null when cookie absent', () => {
    const token = parseCookieToken('other=x; unrelated=y')
    expect(token).toBeNull()
  })

  test('parseCookieToken returns null for empty string', () => {
    const token = parseCookieToken('')
    expect(token).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. requireAuth middleware
// ---------------------------------------------------------------------------

/** Minimal fake request shim for middleware testing — structurally identical to AuthRequest. */
type FakeReq = AuthRequest

/** Minimal fake response shim. */
interface FakeRes {
  statusCode: number
  ended: boolean
  body: string
  end(body?: string): void
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    ended: false,
    body: '',
    end(b = '') { this.ended = true; this.body = b },
  }
}

describe('requireAuth middleware', () => {
  let db: Database
  let userId: string

  beforeEach(() => {
    db = makeTestDb()
    userId = randomBytes(16).toString('hex')
    db.run(
      `INSERT INTO app_users (id, login, password_hash, role, status)
       VALUES (?, ?, ?, 'user', 'active')`,
      [userId, 'middleware-user', '$2b$12$placeholder'],
    )
  })

  afterEach(() => {
    db.close()
  })

  test('rejects request with no Cookie header — 401', async () => {
    const req: FakeReq = { headers: {} }
    const res = makeRes()
    let nextCalled = false
    await requireAuth(db, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects request with invalid token in cookie — 401', async () => {
    const req: FakeReq = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=notavalidtoken` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuth(db, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects expired session — 401', async () => {
    const token = await createSession(db, userId, -1000)
    const req: FakeReq = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuth(db, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects revoked session — 401', async () => {
    const token = await createSession(db, userId)
    await revokeSession(db, token)
    const req: FakeReq = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuth(db, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('accepts valid session — calls next and attaches user', async () => {
    const token = await createSession(db, userId)
    const req: AuthRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuth(db, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
    expect(req.user?.id).toBe(userId)
  })
})

// ---------------------------------------------------------------------------
// 5. Login throttle (SQLite-backed)
// ---------------------------------------------------------------------------

describe('login throttle', () => {
  let db: Database

  beforeEach(() => {
    db = makeTestDb()
  })

  afterEach(() => {
    db.close()
  })

  test('THROTTLE_MAX_ATTEMPTS is 5', () => {
    expect(THROTTLE_MAX_ATTEMPTS).toBe(5)
  })

  test('THROTTLE_WINDOW_MS is 15 minutes', () => {
    expect(THROTTLE_WINDOW_MS).toBe(15 * 60 * 1000)
  })

  test('isThrottled returns false with no recorded failures', async () => {
    const t = new SqliteThrottle(db)
    const throttled = await t.isThrottled('alice')
    expect(throttled).toBe(false)
  })

  test('isThrottled returns false after 4 failures (below threshold)', async () => {
    const t = new SqliteThrottle(db)
    for (let i = 0; i < 4; i++) await t.recordFailure('alice')
    expect(await t.isThrottled('alice')).toBe(false)
  })

  test('isThrottled returns true after 5 failures (at threshold)', async () => {
    const t = new SqliteThrottle(db)
    for (let i = 0; i < 5; i++) await t.recordFailure('alice')
    expect(await t.isThrottled('alice')).toBe(true)
  })

  test('clearThrottle resets throttle — isThrottled returns false', async () => {
    const t = new SqliteThrottle(db)
    for (let i = 0; i < 5; i++) await t.recordFailure('alice')
    await t.clearThrottle('alice')
    expect(await t.isThrottled('alice')).toBe(false)
  })

  test('throttle is per-identifier — bob not affected by alice failures', async () => {
    const t = new SqliteThrottle(db)
    for (let i = 0; i < 5; i++) await t.recordFailure('alice')
    expect(await t.isThrottled('bob')).toBe(false)
  })

  test('login key is case-insensitive — ALICE and alice share throttle state', async () => {
    const t = new SqliteThrottle(db)
    for (let i = 0; i < 3; i++) await t.recordFailure('ALICE')
    for (let i = 0; i < 2; i++) await t.recordFailure('alice')
    expect(await t.isThrottled('Alice')).toBe(true)
  })

  test('expired window does not trigger throttle', async () => {
    const t = new SqliteThrottle(db)
    // Manually insert an expired window (window_start 20 minutes ago).
    const expiredStart = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    db.run(
      `INSERT INTO login_attempts (id, login_key, attempt_count, window_start, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [randomBytes(8).toString('hex'), 'carol', 10, expiredStart],
    )
    expect(await t.isThrottled('carol')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Migration smoke test — 0001_auth.sql structural checks
// ---------------------------------------------------------------------------

describe('0001_auth.sql migration', () => {
  const migPath = join(import.meta.dir, '../migrations/0001_auth.sql')
  let sql: string

  beforeEach(() => {
    sql = readFileSync(migPath, 'utf8')
  })

  test('migration file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(100)
  })

  test('creates app_users table', () => {
    expect(sql).toContain('app_users')
    expect(sql.toLowerCase()).toContain('create table')
  })

  test('creates app_sessions table', () => {
    expect(sql).toContain('app_sessions')
  })

  test('creates login_attempts table', () => {
    expect(sql).toContain('login_attempts')
  })

  test('app_sessions has hashed-token CHECK constraint (64-char hex)', () => {
    // The CHECK should enforce 64-char hex — look for the regex pattern.
    expect(sql).toContain("'^[0-9a-f]{64}$'")
  })

  test('does NOT use GoTrue-reserved table names', () => {
    const lower = sql.toLowerCase()
    // Must not create tables named users, sessions, identities, refresh_tokens.
    expect(lower).not.toMatch(/create table\s+(if not exists\s+)?["']?users["']?/)
    expect(lower).not.toMatch(/create table\s+(if not exists\s+)?["']?sessions["']?/)
    expect(lower).not.toMatch(/create table\s+(if not exists\s+)?["']?identities["']?/)
  })

  test('has index on app_sessions(app_user_id)', () => {
    expect(sql.toLowerCase()).toContain('idx_app_sessions')
  })

  test('has index on login_attempts(login_key)', () => {
    expect(sql.toLowerCase()).toContain('idx_login_attempts')
  })
})
