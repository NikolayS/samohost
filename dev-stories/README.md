# dev-stories

Acceptance tests for the **platform / infra layer** — the dev-and-ops analog of
user stories. A user story asserts "a person can do X in the product"; a **dev
story** asserts "the platform plumbing actually does X," verified against the
**live running surface**, never against a status log or internal state.

Why this exists: on 2026-06-22 the samohost trigger logged `action: "failed"`
for every PR preview, and that log was taken at face value as "previews are
down" — they were not (every URL served HTTP 200). The log was a hypothesis;
the running surface is ground truth. Dev stories make that distinction a
**test that runs itself**, so an outage is detected by probing the thing users
touch, and a noisy/false status can never again masquerade as an outage.

## Rules

- A dev story is satisfied **only** by hitting the real surface: `curl` the URL,
  load the page, run the walk. Reading `state.json` / a trigger report and
  inferring is NOT a dev story.
- Each story = a markdown spec (acceptance criteria, in plain language) + an
  executable runner that exits 0 (pass) / non-zero (fail).
- Stories are **automated** (systemd timer / CI), and also runnable on demand.
- A failing dev story is a real, user-facing problem — right-size urgency to
  what the live check shows, not to what a log says.

## Stories

All five read-only stories run **unattended** on the control plane via systemd
timers — no human and no interactive session has to trigger them. A failing
story leaves its `.service` in `failed` state (surfaced by `systemctl --failed`
/ `systemctl is-failed dev-story-<name>.service`) with full detail in the
journal. They remain runnable on demand too.

| Story | Spec | Runner | Automation |
|-------|------|--------|------------|
| Open-PR previews reachable | [previews-reachable.md](previews-reachable.md) | [`check-previews.sh`](check-previews.sh) | [`automation/dev-story-previews.timer`](automation/dev-story-previews.timer) (every 10 min) |
| Production app is up | [prod-app-up.md](prod-app-up.md) | [`prod-app-up.sh`](prod-app-up.sh) | [`automation/dev-story-prod-app-up.timer`](automation/dev-story-prod-app-up.timer) (every 15 min) |
| Deploy freshness (prod reflects latest merge) | [deploy-freshness.md](deploy-freshness.md) | [`deploy-freshness.sh`](deploy-freshness.sh) | [`automation/dev-story-deploy-freshness.timer`](automation/dev-story-deploy-freshness.timer) (every 15 min) |
| Open-PR preview-link comment current | [preview-comment-current.md](preview-comment-current.md) | [`preview-comment-current.sh`](preview-comment-current.sh) | [`automation/dev-story-preview-comment-current.timer`](automation/dev-story-preview-comment-current.timer) (every 15 min) |
| Demo envs reachable | [demo-envs-reachable.md](demo-envs-reachable.md) | [`demo-envs-reachable.sh`](demo-envs-reachable.sh) | [`automation/dev-story-demo-envs-reachable.timer`](automation/dev-story-demo-envs-reachable.timer) (every 15 min) |

> Note: the previews runner is committed here as `check-previews.sh`; on the
> control plane the stable runner path that the timer executes is
> `~/bin/dev-story-previews.sh`. The four newer runners are committed under their
> own names (`<story>.sh`) and are byte-identical to the stable
> `~/bin/dev-story-<story>.sh` copies the timers execute — automation never
> depends on a repo checkout.
