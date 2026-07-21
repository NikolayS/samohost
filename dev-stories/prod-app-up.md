# Dev story: every non-static app's PRODUCTION site is up

**As** the samo platform, **for every registered non-static app**, the app's
**public PRODUCTION site** must serve and report itself as production — so a
client or bot who opens the live product sees it running, not a 500, not a
blank page, not a staging/preview build masquerading as prod.

This is the **most important user-facing surface**: a real outage here is the
one thing that must never reach the user uncaught. The previews story
(`previews-reachable.md`) guards the PR-preview surface; this story guards the
durable production surface.

## Domain convention (do NOT confuse the two)

- **Production** lives on **`samo.team`** (Cloudflare zone). For field-record the
  live prod vhost is `field-record-1.samo.team` → reverse-proxy `localhost:3000`
  (the production port), confirmed in the prod VM's main `Caddyfile`.
- **Previews** live on **`samo.cat`** (per-PR `<app>-<branch>.samo.cat`). A prod
  check that lands on a `*.samo.cat` host is a discovery bug, not a pass.

A `*.samo.cat` URL is never evidence for this story.

## Scope

- **Included:** every app in `~/.samohost/apps.json` whose `kind` is **not**
  `"static"`. Today that is exactly **`field-record`**.
- **Excluded:** `kind == "static"` apps (e.g. `game-changers`) — they have no
  `/api/version` and no `env` field, so the production-env assertion does not
  apply.

## Acceptance criteria (verified against the LIVE prod url)

For each in-scope app, its production URL `https://<prodHost>/api/version` must:

1. Return **HTTP 200**.
2. Report **`"env": "production"`** (catches a prod vhost accidentally wired to
   a staging/preview build, or an `env` of `staging`/`preview`/empty).

An app whose production host cannot be determined by **read-only** means, or
whose prod URL is unreachable / non-200 / wrong env, **FAILS** the story.

Ground truth is the URL response — never `state.json`, never a trigger
`action` field, never an internal status log. The running surface is truth.

## Production-host discovery (read-only only)

The runner determines each app's public prod host without mutating anything:

1. If `apps.json` carries an explicit `mainHost` for the app, use it.
2. Otherwise derive it from the prod VM's main Caddy config, read-only: the
   `*.samo.team` site block that `reverse_proxy`es to the app's production port
   (the port in the app's `healthUrl`, e.g. `localhost:3000`). The VM, SSH user,
   port and key come from `~/.samohost/state.json` (matched on the app's
   `vmId`). SSH is `BatchMode`, `cat`/`awk` only — **no** remote mutation.
3. If neither path yields a `samo.team` host (and never a `samo.cat` host),
   that is reported as a **FINDING/FAIL** ("prod host undeterminable read-only"),
   not silently skipped.

## ABSOLUTE constraint — read-only observability

This story may ONLY read / curl / ssh-cat / jq / grep. It MUST NEVER mutate:
no env create/destroy, no `systemctl`, no remote edits, no deploy, no merge, no
"fixing". A failure is a **FINDING to REPORT**, never something to touch. The
user has explicitly and repeatedly forbidden touching prod/previews.

## Runner

`~/samohost/dev-stories/prod-app-up.sh` — drives off `~/.samohost/apps.json`
(in-scope apps) + `~/.samohost/state.json` (VM/SSH) and curls each app's prod
`/api/version`. Prints `PASS`/`FAIL` per app. Exit 0 = every in-scope prod is
up and reports production; exit 1 = one or more failed (prints which).

## Last known result (2026-06-22)

1/1 in-scope production sites healthy:
- PASS `field-record` -> `https://field-record-1.samo.team/api/version`
  (HTTP 200, env=production, displayVersion v2026-06-20-1).
- `game-changers` excluded (kind=static).

No prod outage surfaced. The only platform gap observed during authoring is
that `apps.json` does not persist `mainHost`, so prod-host discovery currently
depends on reading the prod VM's Caddyfile; recording `mainHost` at register
time would let the check run with no SSH at all. (Reported as a FINDING, not
fixed.)
