# Control-plane setup — what runs where

samohost is operator-local: there is no samohost server. But two capabilities —
**unattended auto-deploy** (`trigger run`) and **preview-env GC** — are meant to
run on a schedule from a single long-lived host: the **control plane**. This
doc says what lives where, the systemd units, and the one-time ordering.

> The control plane is the machine that runs samohost on a timer. It is **not**
> a project VM. Project VMs only run the deployed apps + previews; the control
> plane runs the samohost CLI that drives them over SSH.

## What runs where

| Concern | Where | Mechanism |
|---|---|---|
| Provision / adopt / status / ssh / logs | operator host or control plane (ad-hoc) | `samohost` CLI invoked by a human/bot |
| App deploy (main → prod) | control plane, on a timer | `samohost trigger run` |
| Preview GC (branch-gone / orphan) | control plane, same timer (opt-in) | `samohost trigger run --gc` |
| The deployed app + preview envs | each project VM | systemd units written by `app bootstrap` / `env create` host-prep |
| Edge preview banner | Cloudflare (no VM) | `wrangler deploy` of the Worker — see `docs/edge-preview-banner.md` |

State for the control plane lives in **`~/.samohost/`** of the user that runs
the timer (VM records, app records, env records, pinned host keys). The timer
user must own that directory and the SSH private keys referenced by the records.

## The trigger `.service` + `.timer`

`samohost trigger run` performs exactly **one** idempotent poll cycle (enumerate
registered apps → resolve tracked-branch HEAD SHA → deploy where the SHA changed
and CI is green → exit). It is designed to be invoked repeatedly by a systemd
timer, **not** to loop internally. Install a oneshot service + a timer:

```ini
# /etc/systemd/system/samohost-trigger.service
[Unit]
Description=samohost auto-deploy poll cycle
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=samo                      # the user whose ~/.samohost holds the state
WorkingDirectory=/home/samo/samohost
# Tokens come from the environment — keep them in a 0600 EnvironmentFile,
# NEVER inline here and NEVER in a world-readable path. Audit drop-ins too:
# /etc/systemd/system/samohost-trigger.service.d/*.conf override this file.
EnvironmentFile=/home/samo/.samohost.env     # GH_TOKEN, CLOUDFLARE_SAMOCAT, etc. (0600)
ExecStart=/usr/bin/bun run src/cli.ts trigger run --gc
```

```ini
# /etc/systemd/system/samohost-trigger.timer
[Unit]
Description=Run samohost auto-deploy every 5 minutes

[Timer]
OnCalendar=*:0/5               # every 5 minutes
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now samohost-trigger.timer
systemctl list-timers samohost-trigger.timer     # verify next-elapse
journalctl -u samohost-trigger.service -n 50      # inspect a cycle
```

Notes:
- `trigger run` exits **0** when every candidate ended in `{deployed,
  up-to-date, known-bad, skipped, would-deploy}` and **1** if any deploy failed
  or threw — so a non-zero unit shows as a failed timer run.
- `--gc` is **opt-in** and only reaps **branch-gone** + **orphan-vm** envs (never
  TTL-based — the trigger does no age-based reaping). Drop `--gc` for deploy-only.
- `--vm <name>` / `--app <name>` narrow scope; `--dry-run --json` reports what
  would deploy (and, with `--gc`, what would be reaped) without acting — use it
  to validate the unit before enabling reaping.
- Per-app isolation: one app's failure does not abort the cycle.
- **Secret discipline:** drop-ins under
  `/etc/systemd/system/samohost-trigger.service.d/*.conf` override the unit and
  can re-introduce inline `Environment=` secrets — audit them, not just the
  base unit, on any rotation.

### PR previews (`--pr-previews`, live since #68)

Add `--pr-previews` to `trigger run` for zero-friction GitHub PR previews. Each
cycle the trigger:

- Enumerates **open PRs** for each live registered app's repo (`gh pr list
  --state open`); **same-repo only** — cross-repository (fork) PRs are filtered
  out to stop fork branch-name collisions shadowing same-repo envs.
- Ensures a preview env at each PR's HEAD SHA — creates if absent, redeploys if
  the recorded SHA differs; unchanged PRs (same SHA) are skipped (no API spam).
- Posts or **updates exactly one** idempotent comment per PR (located by the
  `<!-- samohost-preview -->` marker) with a clickable URL:
  `🔎 Preview: https://<env>.samo.cat — auto-updates on push`.
- **Reaps** preview envs for PRs that are no longer open (after the GC pass).

PR previews are **CI-ungated by design** — they deploy at PR HEAD without
consulting the CI-green gate (the comment is just a preview URL; non-technical
clients and bot PRs may have no CI). The main→prod deploy path keeps its CI gate
unchanged. Safety backstop: `MAX_PR_PREVIEWS_PER_CYCLE` = 20 with a single
warning. Per-PR try/catch — one PR's failure does not abort the cycle.

```ini
# To enable PR previews on the timer, append the flag to ExecStart:
ExecStart=/usr/bin/bun run src/cli.ts trigger run --gc --pr-previews
```

Previews still need the same CF DNS + origin-TLS setup as any `env create`
(`docs/preview-reachability.md`).

## One-time host prep ordering (per project VM, run as root on the VM)

samohost **renders** these scripts for operator review and does **not**
auto-execute them. Run each on the VM as root, in order, after the VM is
`ready`/`adopted`:

1. **`app bootstrap <vm> <app> --app-user <user> --db-name <name> …`**
   Renders the ONE-TIME OS bootstrap: creates the app OS user, installs Node
   (NodeSource) + PostgreSQL (PGDG) at the pinned majors, creates the database
   (`--db-name` is **required and explicit** — never derived from the app name),
   writes the systemd main unit + env file template + Caddy main-host vhost.
   Review the script, then run it as root on the VM.

2. **`env plan <vm> <app> --host-prep`**
   Renders the ONE-TIME root host-prep that preview envs depend on (preview
   directory layout, per-env systemd template unit, Caddy preview vhost
   plumbing, sudoers grants). Review, then run as root on the VM.

Only after both have run on the VM will `app deploy` and `env create` succeed.
`env preflight <vm>` confirms the DBLab engine / template-fallback readiness for
the `--db dblab` path (see `docs/dblab-install-runbook.md`).

## Sequence summary

```
provision|adopt VM ─▶ status --audit ─▶ (root on VM) app bootstrap ─▶ (root on VM) env plan --host-prep
        ─▶ app register ─▶ app deploy ─▶ env preflight ─▶ env create
        ─▶ enable samohost-trigger.timer (unattended deploy + opt-in GC)
        ─▶ wrangler deploy (edge banner)
```
