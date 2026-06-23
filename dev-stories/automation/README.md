# Automation — dev-story timers

The unit files here are installed on the samohost control plane as **reference
copies** of how each read-only dev story runs automatically. All five stories
run unattended on systemd timers; none requires a human or an interactive
session to trigger it.

| Story | Service / Timer | Runner (stable path on control plane) | Cadence |
|-------|-----------------|----------------------------------------|---------|
| Open-PR previews reachable | `dev-story-previews.{service,timer}` | `~/bin/dev-story-previews.sh` | every 10 min |
| Production app is up | `dev-story-prod-app-up.{service,timer}` | `~/bin/dev-story-prod-app-up.sh` | every 15 min |
| Deploy freshness | `dev-story-deploy-freshness.{service,timer}` | `~/bin/dev-story-deploy-freshness.sh` | every 15 min |
| Preview-link comment current | `dev-story-preview-comment-current.{service,timer}` | `~/bin/dev-story-preview-comment-current.sh` | every 15 min |
| Demo envs reachable | `dev-story-demo-envs-reachable.{service,timer}` | `~/bin/dev-story-demo-envs-reachable.sh` | every 15 min |

**How each is installed and enabled on the control plane:**

```
# stable runner (NOT a repo-checkout path) so automation never breaks on a stale tree
install -m 0755 <story>.sh ~/bin/dev-story-<story>.sh

sudo cp dev-story-<story>.service dev-story-<story>.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dev-story-<story>.timer
```

Each timer fires its runner on a delay after boot (`OnBootSec=3min`) and then on
an interval (`OnUnitActiveSec`, 10 min for previews / 15 min for the rest),
`AccuracySec=30s`. Each `.service` is a `Type=oneshot` unit running as
`testuser` with `Environment=HOME=/home/testuser`, and enters `failed` state
when its story fails — detectable via
`systemctl is-failed dev-story-<story>.service`, `systemctl --failed`, or the
journal (`journalctl -u dev-story-<story>.service`). A passing story deactivates
cleanly (`success`).

The runners read runtime state from `~/.samohost/*.json` and, where GitHub is
needed (`deploy-freshness`, `preview-comment-current`), use the `gh` CLI which
resolves its own auth (`gh auth token`) at runtime — **no credentials are
embedded in any committed file**. Every runner is read-only: it curls / queries
GitHub / parses with jq and `grep`; it mutates nothing.
