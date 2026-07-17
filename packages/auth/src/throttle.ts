/**
 * @samo/auth — DB-backed login throttle.
 *
 * Lifted from field-record-1 src/throttle-db.ts (issue #23, migration 0009).
 * The throttle state survives process restarts because it is Postgres/SQLite-backed.
 *
 * Contract (identical to field-record-1):
 *   THROTTLE_MAX_ATTEMPTS = 5   (5 failures blocks the 6th attempt)
 *   THROTTLE_WINDOW_MS    = 15 * 60 * 1000   (15 minutes)
 *
 * Throttle key: LOWER(login) — case-insensitive, normalised at the boundary.
 *
 * Behaviour:
 *   isThrottled    — true if a live window row exists AND attempt_count >= 5.
 *   recordFailure  — upsert: increment if live window; insert fresh if expired/absent.
 *   clearThrottle  — DELETE the row (called on successful sign-in).
 *
 * SqliteThrottle: implementation backed by Bun SQLite (used in tests and for
 * lightweight deployments). The login_attempts table must exist (created by
 * 0001_auth.sql migration).
 *
 * For postgres.js production use, see DbThrottle (field-record-1's class) or
 * build a wrapper matching the same public interface.
 */

import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export const THROTTLE_MAX_ATTEMPTS = 5
export const THROTTLE_WINDOW_MS    = 15 * 60 * 1000   // 15 minutes

export class SqliteThrottle {
  constructor(private readonly db: Database) {}

  /**
   * Returns true if the login is currently throttled.
   * Throttled = a live row exists (window not yet expired) AND attempt_count >= threshold.
   */
  async isThrottled(login: string): Promise<boolean> {
    const key = login.toLowerCase()
    // Cutoff timestamp — rows with window_start older than this are expired.
    const cutoff = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()

    const row = this.db.query<{ attempt_count: number }, [string, string]>(`
      SELECT attempt_count
      FROM login_attempts
      WHERE login_key = ?
        AND window_start > ?
      LIMIT 1
    `).get(key, cutoff)

    if (!row) return false
    return row.attempt_count >= THROTTLE_MAX_ATTEMPTS
  }

  /**
   * Record one failed sign-in attempt for the login.
   *
   * - Live window exists: increment attempt_count.
   * - Row is expired OR absent: insert a fresh row with count=1.
   *
   * SQLite does not support "ON CONFLICT DO UPDATE ... CASE ... THEN" as
   * elegantly as Postgres, so we implement the upsert logic manually.
   */
  async recordFailure(login: string): Promise<void> {
    const key = login.toLowerCase()
    const cutoff = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()
    const now = new Date().toISOString()

    const existing = this.db.query<{ id: string; attempt_count: number; window_start: string }, [string]>(`
      SELECT id, attempt_count, window_start FROM login_attempts WHERE login_key = ?
    `).get(key)

    if (!existing) {
      // No row — insert fresh.
      const id = randomBytes(8).toString('hex')
      this.db.run(
        `INSERT INTO login_attempts (id, login_key, attempt_count, window_start, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
        [id, key, now, now],
      )
      return
    }

    if (existing.window_start <= cutoff) {
      // Expired window — reset to count=1, new window_start.
      this.db.run(
        `UPDATE login_attempts
         SET attempt_count = 1, window_start = ?, updated_at = ?
         WHERE login_key = ?`,
        [now, now, key],
      )
      return
    }

    // Live window — increment.
    this.db.run(
      `UPDATE login_attempts
       SET attempt_count = attempt_count + 1, updated_at = ?
       WHERE login_key = ?`,
      [now, key],
    )
  }

  /**
   * Clear throttle state for the login (called on successful sign-in).
   */
  async clearThrottle(login: string): Promise<void> {
    const key = login.toLowerCase()
    this.db.run('DELETE FROM login_attempts WHERE login_key = ?', [key])
  }
}
