# Supabase / auth — real state

## Summary: no full Supabase is deployed anywhere

The SAMO preferred-stack memory entry says "self-hosted Supabase." **This is an
aspiration, not a current deployment.** Every source-verified component tells a
different story. Agents must not assume GoTrue or the Supabase stack is running
on any project VM.

Three distinct realities, all verified 2026-07-07:

---

### 1. samo.team control plane — standalone GoTrue only

The control plane runs **one GoTrue container** named
`samo-gotrue-controlplane` (image: `supabase/gotrue`, port 9999). Caddy routes
`/auth/*` to it. This is the authentication subsystem for samo.team's own
UI — it is not the full Supabase stack.

Sources:
- `/home/testuser/samo.team/infra/gotrue/README.md`
- `/home/testuser/samo.team/infra/gotrue/launch.ts` and `ensure.ts`

---

### 2. field-record-1 VM — Supabase staged, intentionally disabled

A full Supabase compose stack exists on the VM at `/opt/samo/supabase` with
`supabase.service` in the systemd registry. **The service is intentionally
disabled** and the field-record app does not use it.

The field-record-1 app uses **plain bcrypt + cookie sessions** instead:
- `Tanya301/field-record-1:src/auth.ts` — `bcrypt.compare()`, cookie name
  `fr_session`
- `Tanya301/field-record-1:migrations/0003_auth.sql` — creates `app_users` and
  `app_sessions` tables

Owner directive (2026-06-05): "plain email+password vs app_users table + cookie
session; NO GoTrue/OAuth/MFA/email flows."

Note: `field-record-1:docs/db-naming.md` lists GoTrue-reserved table names as
a precaution. That document predates the owner's decision to drop GoTrue and
does not reflect current state. GoTrue is not running; those names are not
reserved in practice.

---

### 3. samohost — Supabase in the deferred roadmap only

The optional-module registry is empty:
`src/commands/preview.ts` line 20 — "v0.1 ships no concrete optional module
implementation yet."

Supabase appears only in `SPEC.md §8 Roadmap / Deferred (post-v0.1)`.

---

## Canonical client-app auth: @samo/auth

For all new client apps, use **`packages/auth` (`@samo/auth`)** — the shared
bcrypt+cookie auth module productized from field-record-1.

**Location:** `packages/auth/` in this repo.

**Production consumption (vanilla Postgres):**

```ts
import postgres from 'postgres'
import { PgSessionStore, PgThrottle, requireAuthPg, buildSetCookieHeader } from '@samo/auth'

const sql = postgres(process.env.DATABASE_URL!)
const sessions = new PgSessionStore(sql)   // production session store
const throttle = new PgThrottle(sql)       // production throttle

// In a sign-in route:
if (await throttle.isThrottled(login)) { /* 429 */ }
const token = await sessions.createSession(userId)
res.setHeader('Set-Cookie', buildSetCookieHeader(token))  // Secure by default

// In a protected route:
await requireAuthPg(sessions, req, res, next)  // 401 on missing/invalid/expired/revoked
```

**SQLite double (test/dev only):** `createSession` / `validateSession` / `revokeSession`
(Bun SQLite-backed) + `SqliteThrottle` are test doubles. Do NOT use as the production
session store in a server that runs against real Postgres.

**What it provides:**
- `PgSessionStore` — postgres.js-backed session store (PRODUCTION default).
  Raw token returned to caller; only SHA-256 hash stored in `app_sessions`.
  `validateSession` enforces: `expires_at > NOW()`, `status = 'active'`, `archived_at IS NULL`.
- `PgThrottle` — postgres.js-backed throttle (PRODUCTION default).
  5 failures / 15-min window; DB-backed so survives restarts; case-insensitive key.
- `requireAuthPg` — middleware guard backed by `PgSessionStore`. 401 on
  missing/invalid/expired/revoked session; attaches user to `req.user` on success.
- `hashPassword` / `verifyPassword` — bcryptjs, 12 rounds, min-8 chars.
- `buildSetCookieHeader` / `clearCookieHeader` / `parseCookieToken` — httpOnly,
  SameSite=Lax, Secure by default, 7-day Max-Age. Pass `{ insecure: true }` only
  for local/dev to omit the Secure flag.
- `requireAuth` — same guard but backed by Bun SQLite (test/dev only).
- `SqliteThrottle` — SQLite-backed throttle (test/dev only).
- Migration: `packages/auth/migrations/0001_auth.sql` — creates `app_users`,
  `app_sessions`, `login_attempts` on vanilla Postgres 16+.

Apply migration: `psql "$DATABASE_URL" -f packages/auth/migrations/0001_auth.sql`

**When to use GoTrue / full Supabase instead:** Only when the owner explicitly
enables it for a specific project.

---

## What agents must do

- **`ANTHROPIC_API_KEY` is unconditionally banned** in all samohost code and
  client apps. All LLM calls go through `claude -p` OAuth subprocess. There is
  no condition (Supabase-enabled or otherwise) under which this key is wired in.
- Do NOT wire `SUPABASE_URL` or Supabase client libraries into client apps
  unless the owner has explicitly enabled the Supabase stack for that project.
- Do NOT reserve GoTrue table names (`users`, `sessions`, `identities`,
  `refresh_tokens`, `audit_log_entries`, `schema_migrations`, `mfa_factors`,
  `flow_state`) in new client app migrations. GoTrue is not running on project
  VMs.
- For new client apps: use **`@samo/auth`** (`packages/auth/`) as the default.
  Do not copy-paste field-record-1 auth code into new apps; depend on the module.
- The samo.team UI's `/auth/*` endpoint is powered by standalone GoTrue — this
  is correct and intentional. Do not "upgrade" it to a full Supabase stack
  without an explicit owner decision.

---

## If/when Supabase is enabled for a project

The owner will state this explicitly. At that point:
1. Enable the existing compose stack on the VM (`systemctl enable --now supabase`)
2. Run the Supabase migrations (separate from the app's own migrations)
3. Remove the plain-auth tables only if confirmed safe
4. Update the CLAUDE.md for that project repo to note GoTrue is active

Until that happens, assume GoTrue is absent.
