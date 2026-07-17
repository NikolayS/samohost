/**
 * @samo/auth — password helpers.
 *
 * Uses bcryptjs (pure-JS, no native bindings) with 12 rounds — matching
 * field-record-1's production value. Minimum password length: 8 chars,
 * enforced at hash time so the constraint is always applied at the auth layer.
 */

import bcrypt from 'bcryptjs'

export const BCRYPT_ROUNDS = 12

export function validatePasswordLength(password: string): void {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordLength(password)
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
