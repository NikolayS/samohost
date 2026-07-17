/**
 * @samo/auth — Postgres-path tests (RED first).
 *
 * TDD: these tests are written BEFORE the Postgres implementation.
 * On first commit they must FAIL (import error or missing export).
 *
 * Coverage:
 *   7.  PgSessionStore — concrete postgres.js-backed session store:
 *         createSession, validateSession, revokeSession against real Postgres.
 *         Raw token never in DB; only SHA-256 hash stored.
 *         Expired sessions rejected. Revoked sessions rejected.
 *   8.  PgThrottle — concrete postgres.js-backed throttle:
 *         isThrottled, recordFailure, clearThrottle against real Postgres.
 *         Survives restart (DB-backed). Locks after 5 failures in 15 min.
 *   9.  requireAuthPg — middleware accepting AuthDb (not bun:sqlite).
 *         Rejects missing/invalid/expired/revoked. Accepts valid session.
 *   10. Cookie Secure flag — buildSetCookieHeader includes Secure by default.
 *         clearCookieHeader also includes Secure by default.
 *         An explicit insecure=true option omits Secure (for local/dev).
 *   11. index.ts exports — PgSessionStore, PgThrottle, requireAuthPg, buildSetCookieHeader
 *         (with secure option) must be importable from the package root.
 *
 * Integration tests (sections 7+8) require a real Postgres instance.
 * They run when PG_TEST_URL is set; they are NOT skipped silently in CI —
 * the CI job must supply a postgres service container and set PG_TEST_URL.
 * A missing PG_TEST_URL causes these tests to FAIL FAST (not skip) so CI
 * catches a misconfigured workflow.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Imports — these will fail on RED commit (PgSessionStore etc. don't exist yet)
// ---------------------------------------------------------------------------

import {
  PgSessionStore,
  PgThrottle,
  requireAuthPg,
  buildSetCookieHeader,
  clearCookieHeader,
  SESSION_COOKIE_NAME,
  type AuthDb,
  type AuthRequest,
} from '../src/index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// ---------------------------------------------------------------------------
// 10. Cookie Secure flag (no Postgres needed)
// ---------------------------------------------------------------------------

describe('cookie Secure flag', () => {
  test('buildSetCookieHeader includes Secure by default', () => {
    const header = buildSetCookieHeader('tok123')
    expect(header).toContain('Secure')
  })

  test('buildSetCookieHeader omits Secure when insecure=true', () => {
    const header = buildSetCookieHeader('tok123', { insecure: true })
    expect(header).not.toContain('Secure')
  })

  test('clearCookieHeader includes Secure by default', () => {
    const header = clearCookieHeader()
    expect(header).toContain('Secure')
  })

  test('clearCookieHeader omits Secure when insecure=true', () => {
    const header = clearCookieHeader({ insecure: true })
    expect(header).not.toContain('Secure')
  })

  test('buildSetCookieHeader still includes HttpOnly', () => {
    const header = buildSetCookieHeader('tok123')
    expect(header.toLowerCase()).toContain('httponly')
  })

  test('buildSetCookieHeader still includes SameSite=Lax', () => {
    const header = buildSetCookieHeader('tok123')
    expect(header.toLowerCase()).toContain('samesite=lax')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — require real Postgres via PG_TEST_URL
// These FAIL if PG_TEST_URL is absent (not skip!) so CI catches misconfiguration.
// ---------------------------------------------------------------------------

const pgUrl = process.env['PG_TEST_URL']

if (!pgUrl) {
  // In CI, PG_TEST_URL must always be set. Fail hard so it's not silently missed.
  // In a local dev run without Postgres, you can skip by not running pg.test.ts.
  throw new Error(
    'PG_TEST_URL is not set. Real-Postgres integration tests cannot run.\n' +
    'CI must provide a postgres service container and set PG_TEST_URL.\n' +
    'Locally: export PG_TEST_URL=postgres://user:pass@localhost:5432/authtest',
  )
}

// ---------------------------------------------------------------------------
// Shared Postgres connection + schema bootstrap
// ---------------------------------------------------------------------------

let sql: import('postgres').Sql

beforeAll(async () => {
  // Dynamic import so the module-level throw above triggers before postgres is loaded.
  const postgres = (await import('postgres')).default
  sql = postgres(pgUrl, { max: 2, idle_timeout: 10 })

  // Apply minimal auth schema for integration tests.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS app_users (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      login         TEXT        NOT NULL UNIQUE,
      email         TEXT,
      password_hash TEXT        NOT NULL,
      role          TEXT        NOT NULL DEFAULT 'user',
      status        TEXT        NOT NULL DEFAULT 'active',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at   TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      app_user_id UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      token       TEXT        NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      login_key     TEXT        NOT NULL UNIQUE,
      attempt_count INTEGER     NOT NULL DEFAULT 1,
      window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
})

afterAll(async () => {
  // Clean up test data
  await sql.unsafe(`
    DELETE FROM app_sessions;
    DELETE FROM login_attempts;
    DELETE FROM app_users;
  `)
  await sql.end()
})

/** Insert a test user and return its id. */
async function insertUser(login: string): Promise<string> {
  const rows = await sql<[{ id: string }]>`
    INSERT INTO app_users (login, password_hash)
    VALUES (${login}, ${'$2b$12$placeholder'})
    RETURNING id
  `
  return rows[0]!.id
}

// ---------------------------------------------------------------------------
// 7. PgSessionStore — real Postgres
// ---------------------------------------------------------------------------

describe('PgSessionStore (real Postgres)', () => {
  test('createSession returns a raw token (64-char hex)', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-create-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('raw token is NOT stored in DB — only its SHA-256 hash is', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-hash-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    const rows = await sql<[{ token: string }]>`SELECT token FROM app_sessions WHERE app_user_id = ${userId}`
    expect(rows.length).toBe(1)
    const stored = rows[0]!.token
    expect(stored).not.toBe(token)
    expect(stored).toBe(sha256hex(token))
  })

  test('validateSession returns user for valid token', async () => {
    const store = new PgSessionStore(sql)
    const login = `sess-valid-${randomBytes(4).toString('hex')}`
    const userId = await insertUser(login)
    const token = await store.createSession(userId)
    const user = await store.validateSession(token)
    expect(user).not.toBeNull()
    expect(user!.id).toBe(userId)
    expect(user!.login).toBe(login)
  })

  test('validateSession returns null for unknown token', async () => {
    const store = new PgSessionStore(sql)
    const fakeToken = randomBytes(32).toString('hex')
    const user = await store.validateSession(fakeToken)
    expect(user).toBeNull()
  })

  test('validateSession returns null for expired session', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-expired-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId, -1000) // already expired
    const user = await store.validateSession(token)
    expect(user).toBeNull()
  })

  test('revokeSession makes subsequent validateSession return null', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-revoke-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    const before = await store.validateSession(token)
    expect(before).not.toBeNull()
    await store.revokeSession(token)
    const after = await store.validateSession(token)
    expect(after).toBeNull()
  })

  test('revokeSession deletes by hash — raw token never reaches DB', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-revhash-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    await store.revokeSession(token)
    const rows = await sql<[{ count: string }]>`
      SELECT COUNT(*) as count FROM app_sessions WHERE app_user_id = ${userId}
    `
    expect(parseInt(rows[0]!.count, 10)).toBe(0)
  })

  test('archived user is rejected by validateSession', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-archived-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    // Archive the user
    await sql`UPDATE app_users SET archived_at = NOW() WHERE id = ${userId}`
    const user = await store.validateSession(token)
    expect(user).toBeNull()
  })

  test('inactive user (status != active) is rejected by validateSession', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`sess-inactive-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    await sql`UPDATE app_users SET status = 'suspended' WHERE id = ${userId}`
    const user = await store.validateSession(token)
    expect(user).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 8. PgThrottle — real Postgres
// ---------------------------------------------------------------------------

describe('PgThrottle (real Postgres)', () => {
  test('isThrottled returns false with no failures', async () => {
    const throttle = new PgThrottle(sql)
    const login = `throttle-none-${randomBytes(4).toString('hex')}`
    expect(await throttle.isThrottled(login)).toBe(false)
  })

  test('isThrottled returns false after 4 failures (below threshold)', async () => {
    const throttle = new PgThrottle(sql)
    const login = `throttle-4-${randomBytes(4).toString('hex')}`
    for (let i = 0; i < 4; i++) await throttle.recordFailure(login)
    expect(await throttle.isThrottled(login)).toBe(false)
  })

  test('isThrottled returns true after 5 failures (at threshold)', async () => {
    const throttle = new PgThrottle(sql)
    const login = `throttle-5-${randomBytes(4).toString('hex')}`
    for (let i = 0; i < 5; i++) await throttle.recordFailure(login)
    expect(await throttle.isThrottled(login)).toBe(true)
  })

  test('clearThrottle resets throttle', async () => {
    const throttle = new PgThrottle(sql)
    const login = `throttle-clear-${randomBytes(4).toString('hex')}`
    for (let i = 0; i < 5; i++) await throttle.recordFailure(login)
    await throttle.clearThrottle(login)
    expect(await throttle.isThrottled(login)).toBe(false)
  })

  test('throttle is per-identifier', async () => {
    const throttle = new PgThrottle(sql)
    const loginA = `throttle-isola-${randomBytes(4).toString('hex')}`
    const loginB = `throttle-isolb-${randomBytes(4).toString('hex')}`
    for (let i = 0; i < 5; i++) await throttle.recordFailure(loginA)
    expect(await throttle.isThrottled(loginB)).toBe(false)
  })

  test('login key is case-insensitive', async () => {
    const throttle = new PgThrottle(sql)
    const base = `throttle-case-${randomBytes(4).toString('hex')}`
    for (let i = 0; i < 3; i++) await throttle.recordFailure(base.toUpperCase())
    for (let i = 0; i < 2; i++) await throttle.recordFailure(base.toLowerCase())
    expect(await throttle.isThrottled(base)).toBe(true)
  })

  test('expired window does not trigger throttle', async () => {
    const throttle = new PgThrottle(sql)
    const login = `throttle-exp-${randomBytes(4).toString('hex')}`
    const key = login.toLowerCase()
    // Insert an already-expired window directly
    await sql`
      INSERT INTO login_attempts (login_key, attempt_count, window_start, updated_at)
      VALUES (${key}, 10, NOW() - INTERVAL '20 minutes', NOW())
    `
    expect(await throttle.isThrottled(login)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. requireAuthPg — middleware accepting AuthDb interface
// ---------------------------------------------------------------------------

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

describe('requireAuthPg middleware (real Postgres)', () => {
  test('rejects missing cookie — 401', async () => {
    const store = new PgSessionStore(sql)
    const req: AuthRequest = { headers: {} }
    const res = makeRes()
    let nextCalled = false
    await requireAuthPg(store, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects invalid token — 401', async () => {
    const store = new PgSessionStore(sql)
    const req: AuthRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=notavalidtoken` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuthPg(store, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects expired session — 401', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`mw-expired-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId, -1000)
    const req: AuthRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuthPg(store, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('rejects revoked session — 401', async () => {
    const store = new PgSessionStore(sql)
    const userId = await insertUser(`mw-revoked-${randomBytes(4).toString('hex')}`)
    const token = await store.createSession(userId)
    await store.revokeSession(token)
    const req: AuthRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuthPg(store, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  test('accepts valid session — calls next and attaches user', async () => {
    const store = new PgSessionStore(sql)
    const login = `mw-valid-${randomBytes(4).toString('hex')}`
    const userId = await insertUser(login)
    const token = await store.createSession(userId)
    const req: AuthRequest = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }
    const res = makeRes()
    let nextCalled = false
    await requireAuthPg(store, req, res, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
    expect(req.user?.id).toBe(userId)
    expect(req.user?.login).toBe(login)
  })
})
