# samohost — Claude Code guidance

<!-- SAMO-STACK:START (canonical agent onboarding — do not edit in place; source is docs/stack/) -->
## Stack — read before any task

The canonical SAMO stack handbook lives in `docs/stack/`. Read it before writing
code, filing issues, or planning work. It documents verified, real state — not
aspirations.

**Start here:** [`docs/stack/README.md`](docs/stack/README.md) — overview, VM
inventory, non-negotiable policies, and read order.

Quick reference for the most common agent mistakes:

- **Postgres version**: 18 is the single standard. The samo.team control plane
  running PG 17 is a known gap, not a second standard.
  See [`docs/stack/postgres.md`](docs/stack/postgres.md).

- **Preview databases**: ALWAYS DBLab thin clones. Never a template/dump
  fallback. Owner-stated, non-negotiable.
  See [`docs/stack/dblab.md`](docs/stack/dblab.md).

- **Supabase / GoTrue**: no full Supabase stack is deployed on any project VM.
  Do NOT reserve GoTrue table names in migrations. Default to plain bcrypt +
  cookie sessions for new client apps.
  See [`docs/stack/supabase.md`](docs/stack/supabase.md).

- **ZFS pool**: always named `tank`. PG data dir on field-record NEVER moves
  off `/tank`. See [`docs/stack/zfs.md`](docs/stack/zfs.md).

- **Deploy**: `samohost-trigger.timer` runs from `~/samohost-trigger`, NOT the
  agent workspace. Tag ≠ ship — verify `/api/version` after deploy.
  See [`docs/stack/deploy.md`](docs/stack/deploy.md).
<!-- SAMO-STACK:END -->

<!-- SAMO-DEV-PRINCIPLES:START (synced block — update the canonical source then re-sync; do not edit in place) -->
## Development principles

Accumulated, non-negotiable working principles for SAMO projects. Canonical source: Tanya301/SAMO-Platform-Onboarding > PRINCIPLES.md. Keep this block in sync.

### 1. Re-review after ANY post-review change — green CI is not "reviewed"
Once a reviewer (samorev) approves an MR/PR, **any** later commit invalidates that approval — **including a commit that fixes the review's own findings**. Re-review the change (at minimum the new delta) **before** merge. Never merge a post-review commit on the strength of the prior PASS plus a green pipeline: a passing pipeline proves it builds and tests pass, not that it was reviewed.

Order: review → fix-commit → **re-review the delta** → merge.  (NOT: review → fix-commit → merge.)
<!-- SAMO-DEV-PRINCIPLES:END -->
