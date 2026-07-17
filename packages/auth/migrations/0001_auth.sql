-- @samo/auth — canonical auth migration.
--
-- Creates the three auth tables for client apps using plain bcrypt+cookie auth.
--
-- IMPORTANT: table names are deliberately prefixed with app_ to avoid
-- colliding with Supabase GoTrue reserved names (users, sessions, identities,
-- refresh_tokens, audit_log_entries, schema_migrations, mfa_factors, flow_state).
-- GoTrue owns those names; this module owns the app_ namespace.
--
-- Productized from field-record-1:
--   migrations/0003_auth.sql   — app_users + app_sessions
--   migrations/0009_login_attempts.sql — throttle state
--   migrations/0010_hashed_tokens.sql  — hashed-token CHECK constraint
--   src/throttle-db.ts         — throttle logic
--   src/auth.ts                — session semantics
--
-- Hardening applied vs field-record-1 originals:
--   1. The CHECK constraint enforcing 64-char hex on app_sessions.token is
--      included inline (not via a separate migration), making this a single
--      idempotent bootstrap for any new client app.
--   2. app_users has no organizations FK here — organisational structure is
--      client-specific. The FK can be added in the client's own migration.
--   3. A pruning index on login_attempts.window_start is included (field-record
--      added this in migration 0021 after the fact).
--   4. All CREATE TABLE statements use IF NOT EXISTS for idempotency.
--
-- Vanilla Postgres 16+. No Supabase, no GoTrue, no pg_cron, no RLS.
-- Apply with: psql $DATABASE_URL -f 0001_auth.sql

-- ---------------------------------------------------------------------------
-- app_users
-- ---------------------------------------------------------------------------
-- One row per human user account. application_id / organization_id FKs are
-- the client app's responsibility — add them in the next migration.
-- status: 'active' | 'suspended' | 'deleted' (enforced by app logic).
-- archived_at: soft-delete timestamp; NULL means the account is live.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- app_sessions
-- ---------------------------------------------------------------------------
-- One row per live session. The token column stores the SHA-256 hex digest
-- of the raw token — the raw token lives ONLY in the httpOnly cookie.
--
-- CHECK constraint enforces the 64-char hex shape at the DB level so no
-- code path can accidentally store a raw token.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE
                          CHECK (token ~ '^[0-9a-f]{64}$'),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the ON DELETE CASCADE FK and the resolveSession JOIN.
CREATE INDEX IF NOT EXISTS idx_app_sessions_app_user_id ON app_sessions (app_user_id);

-- ---------------------------------------------------------------------------
-- login_attempts
-- ---------------------------------------------------------------------------
-- Persistent sign-in throttle state. Survives restarts/deploys.
-- One row per normalised login (LOWER(login)); only one live window per login.
-- window_start: when the current 15-minute throttle window opened.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  login_key     TEXT        NOT NULL UNIQUE,   -- LOWER(login)
  attempt_count INTEGER     NOT NULL DEFAULT 1,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the isThrottled lookup (login_key) and expiry pruning (window_start).
CREATE INDEX IF NOT EXISTS idx_login_attempts_login_key    ON login_attempts (login_key);
CREATE INDEX IF NOT EXISTS idx_login_attempts_window_start ON login_attempts (window_start);
