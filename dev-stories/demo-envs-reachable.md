# Dev story: demo environments are reachable and live

**As** the samo platform, **for every demo environment** (a branch starting
`demo/` in `~/.samohost/envs.json`, e.g. `demo/red-bg`, `demo/red-login`),
**there is an environment that actually serves** — because demos are shown to
real people, so they must be live, not a 404, not prod, not a stale build, and
not a static catch-all masquerading as a live app.

## Acceptance criteria (verified against the LIVE url)

For each demo env (`branch` begins with `demo/`) in `envs.json`, its vhost must:

1. Return **HTTP 200** on `/api/version`.
2. Serve a JSON body that reports **`"env": "preview"`** (demos are previews of
   a branch; this catches a demo wired to prod, and catches a static catch-all
   that returns the homepage HTML with a 200 — HTTP 200 alone is NOT proof the
   app is live).
3. Report **`branch`** equal to the demo's `branch` from `envs.json` (catches a
   demo serving the wrong commit/branch).

A demo env whose vhost is unreachable, returns non-200, does not return parseable
JSON with `env=preview`, or reports the wrong branch, **fails** the story.

Ground truth is the URL response body, never a status log, `state.json`, or the
samohost trigger's `action` field (which has misreported `failed` while an env
served 200, and conversely a static 200 is not evidence the demo app is live).

## Scope and constraints

This is a **read-only observability test**. The runner ONLY reads `envs.json`,
curls each demo vhost, and parses JSON with `jq`. It mutates nothing — it does
not create/destroy envs, restart services, ssh anywhere, edit configs, or "fix"
anything. A failure is a **FINDING to report**, never something the runner
touches. Previews and prod are explicitly off-limits.

## Runner

`~/samohost/dev-stories/demo-envs-reachable.sh` — enumerates demo envs from
`~/.samohost/envs.json` (`branch` starting `demo/`), curls each vhost's
`/api/version`, and checks HTTP 200 + `env=preview` + branch match. Exit 0 = all
demos healthy; exit 1 = one or more failed (prints PASS/FAIL per demo). Runnable
on demand; no systemd timer is installed by this story.

## Last known result (2026-06-22, runner exit 1)

2 demo envs found; **1/2 healthy** (so the story currently FAILS, exit 1):

- **PASS** `field-record` `demo/red-login` -> `field-record-demo-red-login.samo.cat`
  (HTTP 200, `content-type: application/json`, `env=preview`, `branch=demo/red-login`).
- **FAIL** `game-changers` `demo/red-bg` -> `game-changers-demo-red-bg.samo.cat`
  (HTTP 200 but `content-type: text/html` — `/api/version` returns the site's
  homepage HTML, not a version JSON; no `env` field, jq parse error). This is a
  real, test-surfaced gap: `game-changers` is a **static** app (`kind: "static"`
  in `apps.json`) with no `/api/version` endpoint, so its SPA/catch-all answers
  200 with the index page. A demo that is meant to be "live with env=preview"
  cannot prove it via this endpoint, and a naive HTTP-200-only check would have
  falsely passed it. **FINDING reported, not fixed** — touching previews/demos
  is out of scope for this read-only story.
