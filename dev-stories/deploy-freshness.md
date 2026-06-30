# Dev story: production reflects the latest merge (deploy freshness)

**As** the samo platform, **for every registered non-static app**, the app's
**public PRODUCTION** build must be consistent with the **latest merged commit
on its default branch**. In plain terms: when something is merged and the deploy
is supposed to have happened, prod must actually be running that commit — not an
older one.

This catches the **"tagged / merged but prod never updated"** class of outage:
CI is green, the PR is merged, a deploy was *believed* to have run, yet the live
production surface is still serving a stale build. That gap is invisible to a
"site is up" check (`prod-app-up.md`) — a stale build is up, healthy, and wrong.
This story is the freshness guard that sits alongside it.

## Ground truth

The running production surface is truth, never a status log. Specifically:

- The **latest default-branch SHA** comes from GitHub (`gh api .../commits/<branch>`).
- The **deployed SHA** is what samohost recorded for prod at deploy time:
  `apps.json[].deployedSha`.
- Prod liveness is the **live `/api/version`** response (curled, not inferred).

If prod's `/api/version` exposed a commit SHA we would compare it directly to the
latest merge. It currently does **not** (today it reports
`{version, displayVersion, env, branch}` with **no SHA**), so the SHA comparison
is `deployedSha` (what samohost says it shipped) vs the latest merge, with the
**live `/api/version`** used as the required reachability/identity anchor.

## Scope

- **Included:** every app in `~/.samohost/apps.json` whose `kind` is **not**
  `"static"`. Today that is exactly **`field-record`** (`Tanya301/field-record-1`,
  default branch `main`).
- **Excluded:** `kind == "static"` apps (e.g. `game-changers`) — they have no
  `/api/version`, no `env`, and no recorded `deployedSha`, so "prod runs the
  latest merge" is not expressible as a SHA comparison for them.

## Acceptance criteria (per in-scope app)

A. **Prod is reachable and is production.** `https://<prodHost>/api/version`
   returns **HTTP 200** and reports **`"env": "production"`**. (Same live anchor
   as `prod-app-up.md`; a stale-but-down prod is a different, also-failing story.)

B. **Latest default-branch SHA is obtainable** from GitHub for the app's
   `repo`@`branch`.

C. **Freshness.** If `apps.json` records a `deployedSha` for the app:
   - `deployedSha == latestSha`  → **FRESH** (PASS).
   - `deployedSha != latestSha`  → **STALE** (FAIL): merged-but-prod-never-updated.
     The finding reports both SHAs and how far behind prod is.

   If `apps.json` records **no** `deployedSha` (exact SHA mapping unavailable),
   the freshness item is reported as a **FINDING, not a hard FAIL**: per the
   story brief, when exact SHA mapping isn't available we assert prod is
   reachable (criterion A) and **report what prod shows vs the latest merge**.
   The item is marked `WARN` and prints prod's `displayVersion`/`version`
   alongside the latest SHA + commit date so a human can judge.

An app **FAILS** the story if A or B cannot be satisfied, or if C resolves to
STALE. A `WARN` (no `deployedSha` to compare) does **not** fail the run by
itself — it is surfaced as a finding so the SHA-mapping gap gets recorded.

## Production-host discovery (read-only only)

Identical to `prod-app-up.md`:
1. explicit `mainHost` in `apps.json` wins;
2. else derive from the prod VM's main `Caddyfile` (read-only `ssh`/`awk`):
   the `*.samo.team` site block that `reverse_proxy`es to the app's prod port
   (the port in `healthUrl`). VM / SSH user / port / key come from
   `~/.samohost/state.json` matched on the app's `vmId`. SSH is `BatchMode`,
   `cat`/`awk` only — **no** remote mutation.
3. A `*.samo.cat` host is a preview, never accepted as prod. Undeterminable prod
   host = FAIL finding, not a silent skip.

## ABSOLUTE constraint — read-only observability

This story may ONLY read / curl / `gh`-query / `ssh-cat` / `jq` / `grep`. It MUST
NEVER mutate anything: no env create/destroy, no `systemctl`, no remote edits, no
deploy, no re-deploy, no merge, no "fixing". **A stale prod is a FINDING to
REPORT, never something this test touches.** The user has explicitly and
repeatedly forbidden touching prod/previews — this test builds the signal and
reports it; remediation (re-deploy) is a separate, human-authorized action.

## Runner

`~/samohost/dev-stories/deploy-freshness.sh` — drives off `~/.samohost/apps.json`
(in-scope apps + `deployedSha`) + `~/.samohost/state.json` (VM/SSH for prod-host
discovery), uses `gh` for the latest default-branch SHA, and curls each app's
prod `/api/version` as the live anchor. Prints `PASS` / `FAIL` / `WARN` per app.
Exit 0 = every in-scope app is reachable+production and either FRESH or only
WARN (no SHA to compare); exit 1 = any app unreachable / not-production /
prod-host-undeterminable / latest-SHA-unobtainable / **STALE**.

## Last known result (2026-06-22)

1 in-scope app, 0 failed:

- **PASS** `field-record` — prod `https://field-record-1.samo.team/api/version`
  HTTP 200, `env=production`, `displayVersion=v2026-06-20-1`; latest `main` =
  `ca7fccd` (2026-06-20T00:11:34Z, "ci: move test-server port … (#178)");
  recorded `deployedSha=ca7fccd` → **FRESH** (prod is on the latest merge).
- `game-changers` excluded (kind=static).

### Findings surfaced during authoring (reported, NOT fixed)

1. **Prod `/api/version` exposes no commit SHA.** It returns
   `{version, displayVersion, env, branch:null}`. Freshness therefore relies on
   `apps.json.deployedSha`, which is samohost's *record* of what it shipped, not
   a value read back from the running build. If a deploy updated prod but failed
   to persist `deployedSha` (or vice-versa), this check can't catch the
   discrepancy from the live surface alone. Adding a `sha` (or `gitSha`) field to
   `/api/version` would let the test compare the **running** build to the latest
   merge directly, closing the gap. (FINDING — not changed by this test.)
2. **`apps.json` does not persist `mainHost`.** As in `prod-app-up.md`,
   prod-host discovery falls back to SSH-reading the prod Caddyfile; recording
   `mainHost` at register time would make this check (and that one) run with no
   SSH at all. (FINDING — not changed by this test.)
