# Dev story: every open PR has a current preview-link comment

**As** the samo platform, **for every open PR on a registered non-static app**,
**there is a posted samohost preview-link comment** pointing at a preview URL —
because that comment is the **client-facing affordance**: it is how a client or
bot who opens the PR finds and clicks their preview. A PR with a live preview env
but no posted link is, to the person reading the PR, a PR with no preview.

This story guards the *delivery* of the link, not the liveness of the env behind
it. `previews-reachable.md` asserts the preview URL serves; this story asserts the
URL was actually handed to the client on the PR.

## What counts as the preview-link comment

The samohost trigger posts exactly one comment per PR, upserted by an HTML marker
(see `src/preview/pr.ts`):

- marker line: `<!-- samohost-preview -->`
- visible line: `🔎 **Preview:** <url> — auto-updates on push.`

A PR passes if **any** comment on it contains the marker
`<!-- samohost-preview -->` **OR** the visible `🔎 Preview:` line, and that
comment carries a `http(s)://` URL (the link the client clicks). Either signal is
accepted because the marker is the robust upsert anchor while the `🔎` line is what
a human actually sees — requiring both would be brittle if the body format is ever
tweaked, and either one alone proves the link was delivered.

## Scope

- **Included:** every app in `~/.samohost/apps.json` whose `kind` is **not**
  `"static"` (static apps get no PR previews and no link comment). Today that is
  exactly **`field-record`** (repo `Tanya301/field-record-1`).
- **Excluded:** `kind == "static"` apps (e.g. `game-changers`).
- **Open PRs only**, from the app's own repo. Cross-repo (fork) PRs are not in
  scope (the trigger does not preview forks); the runner counts only same-repo PRs.

## Acceptance criteria (verified against the LIVE GitHub PRs)

For each registered non-static app, list its **open** PRs via `gh` and read each
PR's comments via `gh` (read-only). The story passes when **every** open PR has a
current preview-link comment as defined above. A PR with **no** such comment is a
**FAIL** / FINDING.

Ground truth is the GitHub PR's actual comments — never `state.json`, never the
trigger's `action`/`commentError` field, never an internal log. The comment either
exists on the PR or it does not.

## ABSOLUTE constraint — read-only observability

This story may ONLY `gh`-query / `jq` / `grep`. It MUST NEVER mutate anything: it
does **not** post, edit, or delete comments, does **not** open/close/merge PRs,
does **not** create/destroy envs, does **not** `systemctl`/`ssh`/edit/deploy/fix.
A missing comment is a **FINDING to REPORT**, never something the runner posts or
repairs. The user has explicitly and repeatedly forbidden touching previews/prod;
this runner builds the test and reports what it shows, nothing more.

(The `gh` impl is read-only here: `gh pr list` and `gh api .../issues/<n>/comments`
are GET requests; no `gh pr comment`, no POST/PATCH/DELETE is ever issued.)

## Runner

`~/samohost/dev-stories/preview-comment-current.sh` — drives off
`~/.samohost/apps.json` (registered non-static apps → repo), lists each repo's
open PRs with `gh pr list`, reads each PR's comments with
`gh api repos/<repo>/issues/<n>/comments`, and asserts the marker or `🔎 Preview:`
line + a URL is present. Prints `PASS`/`FAIL` per PR. Exit 0 = every open PR has a
current preview-link comment; exit 1 = one or more missing (prints which). Runnable
on demand; no systemd timer is installed by this story.

## Last known result (2026-06-22)

6 open PRs on `field-record` (`Tanya301/field-record-1`); **2/6** carry a current
preview-link comment:

- **PASS** #173 `preview/modern-font` — comment present, marker + `🔎 Preview:`
  → `https://field-record-preview-modern-font.samo.cat`.
- **PASS** #176 `preview/field-speed-two-column` — comment present, marker +
  `🔎 Preview:` → `https://field-record-preview-field-speed-two-column.samo.cat`.
- **FAIL** #181 `preview/bright-green-background` — no preview-link comment.
- **FAIL** #184 `preview/pink-background-2` — no preview-link comment.
- **FAIL** #185 `fix/theme-switcher-buttons` — no preview-link comment.
- **FAIL** #188 `preview/blue-background` — no preview-link comment.

This is a real, test-surfaced client-facing gap: four open PRs never received the
preview-link comment, so a client opening any of them sees no preview to click —
consistent with `previews-reachable.md`'s finding that #181/#184/#185/#188 have no
preview env (no env → the trigger posts no link). **FINDING reported, not fixed** —
posting comments or creating previews is out of scope for this read-only story.
