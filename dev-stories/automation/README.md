# Automation — dev-story-previews

The two unit files here (`dev-story-previews.service` and
`dev-story-previews.timer`) are installed on the samohost control plane as
reference copies for how the previews-reachable dev story runs automatically.

**How it is installed and enabled on the control plane:**

```
sudo cp dev-story-previews.service dev-story-previews.timer \
    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dev-story-previews.timer
```

The timer fires `check-previews.sh` every 10 minutes (`OnUnitActiveSec=10min`)
with a 3-minute delay after boot (`OnBootSec=3min`). The service unit runs as
`testuser` and enters `failed` state when the story fails — detectable via
`systemctl is-failed dev-story-previews.service` or
`systemctl --failed`. The runner (`check-previews.sh`) reads runtime state from
`~/.samohost/apps.json` and `~/.samohost/envs.json` and acquires a GitHub token
via `gh auth token` at runtime — no credentials are embedded anywhere.
