# Dev story: open-PR previews are live and correct

**As** the samo platform, **for every open PR** on a registered (non-static)
app, **there is a preview environment that actually serves**, so a client or
bot who opens the PR's preview link sees their change running — not a 404, not
prod, not a stale build.

## Acceptance criteria (verified against the LIVE url)

For each open PR on each registered non-static app, its preview URL must:

1. Return **HTTP 200** on `/api/version`.
2. Report **`env": "preview"`** (not `production` — catches a preview wired to
   prod, as PR #188/blue-background was on 2026-06-22).
3. Report **`branch` == the PR's head branch** (catches a preview serving the
   wrong commit/branch).

A PR with **no preview env**, or whose URL is unreachable / wrong env / wrong
branch, **fails** the story.

Ground truth is the URL response. The samohost trigger's `action` field is NOT
evidence — it has misreported `failed` while the env served 200.

## Runner

`~/bin/dev-story-previews.sh` — drives off `~/.samohost/apps.json` (registered
apps) + `gh pr list` (open PRs) + `~/.samohost/envs.json` (env→vhost) and curls
each preview. Exit 0 = all healthy; exit 1 = one or more failed (prints which).

## Automation

`dev-story-previews.service` + `.timer` (every 10 min, `OnUnitActiveSec=10min`).
The unit enters `failed` state when the story fails → monitorable via
`systemctl is-failed dev-story-previews.service` / `--failed`.

## Last known result (2026-06-22)

2/6 open-PR previews healthy:
- PASS #173 `preview/modern-font`, #176 `preview/field-speed-two-column` (200, env=preview, branch ok).
- FAIL #181, #184, #185, #188 — **no preview env exists** (new PRs not getting previews created). This is the real, test-surfaced gap to fix — distinct from the trigger's cosmetic `failed`-reporting bug.
