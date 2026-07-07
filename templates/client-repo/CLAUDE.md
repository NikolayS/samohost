# {{APP_NAME}} — Claude Code guidance

<!-- SAMO-STACK:START (canonical agent onboarding — do not edit in place; source is samohost docs/stack/) -->
## Stack — read before any task

The canonical SAMO stack handbook lives in the samohost repo under `docs/stack/`.
Read it before writing code, filing issues, or planning work.

Key non-negotiables for SAMO client projects:

- **Postgres version**: 18 is the standard. Do not downgrade.
- **Preview databases**: ALWAYS DBLab thin clones. Never a template/dump fallback.
- **Supabase / GoTrue**: not deployed on client VMs. Default to plain bcrypt +
  cookie sessions for new auth.
- **ZFS pool**: named `tank` when present. App data never moves off `/tank`.
- **Deploy**: `samohost-trigger.timer` handles auto-deploy. Verify `/api/version`
  after any manual deploy. Tag ≠ ship.
- **CI gate**: every PR must pass CI before samohost-trigger will auto-deploy to prod.
<!-- SAMO-STACK:END -->

<!-- SAMO-DEV-PRINCIPLES:START (synced block — update the canonical source then re-sync; do not edit in place) -->
## Development principles

Accumulated, non-negotiable working principles for SAMO projects. Canonical source:
Tanya301/SAMO-Platform-Onboarding > PRINCIPLES.md. Keep this block in sync.

### 1. Re-review after ANY post-review change — green CI is not "reviewed"

Once a reviewer approves a PR, **any** later commit invalidates that approval —
including a commit that fixes the review's own findings. Re-review the delta
**before** merge. Never merge a post-review commit on the strength of a prior
approval plus a green pipeline.

Order: review → fix-commit → **re-review the delta** → merge.

### 2. TDD — RED commit before GREEN commit

Write a failing test first. Commit it as RED. Then implement. Commit as GREEN.
Never bundle tests and implementation in one commit.

### 3. Tests mock prod shape

Before writing a mock, read the actual prod code path. Record the exact shape.
A passing test against a wrong shape is a false-positive.

### 4. Fix root cause, not symptom

Trace state to where it is produced. Adding guards at the consumer treats
symptoms. Document root-cause analysis in the PR description.

### 5. No dead-UI time

Every async wait > 1 second must have continuous visible UI feedback with a
meaningful label. Never: click → screen does nothing for 30 seconds.

### 6. No secrets in committed artifacts

Never commit tokens, passwords, or API keys. Use `$ENV_VAR_NAME` placeholders.
The runner provides the real value via environment.
<!-- SAMO-DEV-PRINCIPLES:END -->

## Project-specific notes

<!-- Add project-specific agent guidance here: migration conventions, test
     credentials, known quirks, etc. -->
