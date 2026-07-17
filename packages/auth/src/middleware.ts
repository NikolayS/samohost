/**
 * @samo/auth — requireAuth middleware / guard.
 *
 * Framework-agnostic: works with any req/res pair that exposes
 * req.headers (Record<string, string>) and res.statusCode + res.end().
 *
 * On success: calls next() and attaches the resolved user to req.user.
 * On failure: sets res.statusCode = 401 and calls res.end() with a JSON body.
 *
 * Accepts a Bun SQLite Database — matches the test fixture shape.
 * For express/fastify adapt by wrapping; the guard logic is identical.
 */

import type { Database } from 'bun:sqlite'
import { parseCookieToken } from './cookie.ts'
import { validateSession, type SessionUser } from './session.ts'

export interface AuthRequest {
  headers: Record<string, string>
  user?: SessionUser
}

export interface AuthResponse {
  statusCode: number
  end(body?: string): void
}

export type NextFn = () => void | Promise<void>

/**
 * requireAuth middleware.
 *
 * Usage (Fastify-style):
 *   await requireAuth(db, req, reply, () => { /* route handler *\/ })
 *
 * Usage (Express-style):
 *   app.use((req, res, next) => requireAuth(db, req, res, next))
 */
export async function requireAuth(
  db: Database,
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

  const user = await validateSession(db, token)
  if (!user) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  req.user = user
  await next()
}
