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
`src/commands/preview.ts` lines 19-24 — "v0.1 ships no concrete optional module
implementation yet."

Supabase appears only in `SPEC.md §8 Roadmap / Deferred (post-v0.1)`.

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
- For new client apps: default to **plain bcrypt + cookie sessions** (the
  pattern from field-record-1) unless the owner specifies otherwise.
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
