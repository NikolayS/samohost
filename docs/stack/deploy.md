# Deploy — trigger poller, CI gate, PR previews

## Architecture overview

```
samohost-trigger.timer  (control plane, runs every 3-5 min)
  └── samohost trigger run [--pr-previews]
        ├── enumerate registered apps
        ├── resolve tracked-branch HEAD SHA (GitHub API)
        ├── skip if SHA unchanged since last deploy
        ├── skip if CI not green (cigate.ts)
        └── deploy (SSH → remote script) where SHA changed + CI green
```

Source: `docs/control-plane-setup.md`, `src/commands/trigger.ts`.

## Dedicated trigger checkout

The timer runs from `/home/testuser/samohost-trigger` — a checkout that is
NOT the agent workspace (`~/samohost`). Each cycle it does:

```bash
git fetch origin main && git reset --hard origin/main
```

**Critical:** do not point the timer at `~/samohost` or any agent workspace.
An agent may be on a feature branch; running the timer from there executes
feature-branch code in production. This happened 2026-06-19.

The agent workspace is `~/samohost`. The trigger workspace is
`~/samohost-trigger`. They are physically separate.

Source: `docs/control-plane-setup.md`, memory `reference_samohost_trigger_and_preview_backend.md`.

## CI-green gate

`src/app/cigate.ts` reads the GitHub Actions API by commit SHA. Requires
`GH_TOKEN` or `GITHUB_TOKEN` with read access to the app repo's Actions runs.

**Private repos with no token**: "no CI run found" and "no repo access" are
indistinguishable at the API level. samohost issue #10 tracks this. Configure
`GH_TOKEN` for every registered private-repo app.

**PR previews are CI-ungated by design.** A PR preview environment is created
regardless of CI status on the PR branch — it is a pre-merge artifact for
review, not a production gate.

Source: `docs/setup-checklist.md`, `src/app/cigate.ts`.

## PR preview lifecycle

Enabled via `samohost trigger run --pr-previews` (or the timer with
`PR_PREVIEWS=true`).

1. Enumerate open PRs for each registered app (GitHub API)
2. Ensure a preview env at each PR HEAD SHA
3. Post / update one idempotent comment per PR (`<!-- samohost-preview -->` marker)
   with URL `https://{env}.samo.cat`
4. On cycle: reap envs for closed or merged PRs

**Same-repo PRs only.** Fork PRs are filtered out to prevent branch-name
collisions in the env registry.

Source: `docs/control-plane-setup.md`.

## Known bugs (open as of 2026-07-07)

| Issue | Summary |
|---|---|
| #125 | PR-preview failures are swallowed (noop sinks); timer reports success while previews fail every cycle |
| #124 | VM resolution by name ignores `lifecycleState` — `findVm` first-matches DESTROYED records and shadows the live VM |
| #123 | `app deploy` swallows remote script output — failures report `outcome=incomplete` with zero diagnostics |
| #122 | `app deploy` `cwd`/`migrate` bug — auto-deploy on main merge hits this |

These are tracked in NikolayS/samohost. Do not close them without a fix.

## Escape hatches

When a SHA is marked as failed-and-stuck:
```bash
samohost app clear-failed <app>   # clear the bad SHA guard
samohost app deploy <app> --force  # deploy regardless of CI / failed guard
```

Source: SPEC-DELTA.md.

## Per-project deploy state

### field-record-1 (as of 2026-06-26)

field-record is on its homemade `deploy/deploy.sh` cron. samohost is NOT
installed on that VM. Deploy is manual/cron, not trigger-driven.

**This is a legacy exception specific to field-record.** All samohost-managed
apps (including the gregg-sites static sites) deploy ONLY via the control-plane
trigger from a tag — never via an on-VM script and never by the author SSHing
in. No per-agent or per-author SSH key should ever be installed on a
samohost-managed app VM for deploy purposes.

### samograph (as of 2026-07-07)

Using samohost-trigger. Was broken by a stale DESTROYED app record (issue #124)
and by issue #122 on auto-deploy. Fixed by pruning dead records 2026-07-06.
Auto-deploy on next main merge hits #122 (cwd/migrate) — manual deploy
`samohost app deploy samograph --force` works.

## Tag is not ship

Pushing a git tag does not guarantee the app is deployed. Always poll:
1. Wait for `samohost-trigger.timer` next cycle (up to 5 min) or run
   `samohost trigger run` manually
2. Verify `/api/version` (or equivalent) returns the expected tag/SHA
3. Only then report "deployed"

Source: `feedback_tag_is_not_ship.md` — v0.8.168 was tagged, deploy failed with
TS2493, prod stayed on v0.8.167 while the prior report called it shipped.
