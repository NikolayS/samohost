# Runner job hook — CI-port cleanup on the shared self-hosted runner

Status: landable in samohost now; the apply + runner restart are operator-gated
on **host root** (NOT repo-admin).

## Problem

The SAMO client CI runs on a **shared** self-hosted GitHub Actions runner.
Playwright's CI `webServer` binds port **3100**. When a prior run's webServer is
orphaned (job cancelled, runner restarted mid-suite), it keeps holding 3100 and
every subsequent run fails with:

```
Error: http://localhost:3100 is already used
```

A per-client `ci.yml` port-kill was tried and **failed**: the runner host has no
`fuser`/`lsof`, and a client repo has no authority over the runner host. The fix
belongs to whoever provisions the runner host — samohost — via the runner's
built-in **job hooks**.

## The fix

`samohost runner host-prep <vm>` renders a one-time root script (offline,
render-only — samohost never executes it, never SSHes) that:

1. Installs a cleanup hook at **`/opt/samohost-ci/clean-ci-ports.sh`**
   (`install -m 0755`).
2. Idempotently sets two keys in the runner's `.env`
   (default **`/home/ghrunner/actions-runner/.env`**):

   ```
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/samohost-ci/clean-ci-ports.sh
   ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/samohost-ci/clean-ci-ports.sh
   ```

   The runner invokes the same script at job start AND job completion — a port
   is freed before a run begins and again after it ends.
3. Prints the **operator follow-up**: restart the runner service so it re-reads
   `.env` (`systemctl restart actions.runner.*.service`). This is NOT executed
   by the rendered script.

### What the cleanup hook does

- `set -uo pipefail` (NOT `set -e`): a cleanup must tolerate "already gone".
  Every step is `|| true`.
- For each CI port (default `3100`, plus any `--ci-port` extras): find the
  listening PID with **`ss -ltnpH "sport = :$port"`** (parsing `pid=`), falling
  back to scanning **`/proc/net/tcp`** + `/proc/*/fd`. `kill`, brief wait, then
  `kill -9`.
- Reaps orphaned Playwright webServers by a **narrow** command-line signature
  (`pgrep -f` for the `playwright ... webServer` launcher only — a bare
  `next dev` / `npm start` is deliberately NOT matched).
- **Guarded against the production app**: a PID under `system.slice` (a real
  systemd unit), excluding the runner's own `fr-ci.slice`, is treated as
  protected and never killed. A true orphan that outlived its job has
  re-parented to init and left its job cgroup, so it is not protected.

### Hard constraint: no `fuser` / `lsof`

The runner host lacks both. The hook references **neither** — PID discovery is
`ss` with a `/proc/net/tcp` fallback. (Enforced by a test:
`expect(script).not.toMatch(/\b(fuser|lsof)\b/)`.)

## Apply (operator, host root)

```bash
# Render (offline; anywhere samohost state knows the VM):
samohost runner host-prep samo-we-field-record > /tmp/runner-host-prep.sh

# Review, then on the runner host as root:
sudo bash /tmp/runner-host-prep.sh
sudo systemctl restart actions.runner.*.service   # re-read .env

# Verify: a queued run frees port 3100 at job start instead of failing.
```

Flags: `--ci-port N` (repeatable; default `3100`),
`--runner-home PATH` (default `/home/ghrunner/actions-runner`).

## Relation to the port pool

The preview-env port pool (`src/env/ports.ts`) now starts at **3101** (was
3100), so a preview env can never collide with the shared CI port. See the
optional change in the accompanying PR.

## No-op after the ephemeral runner migration (#117)

Once the runner migrates to ephemeral, per-job runners (Tanya301/field-record-1
#117 / PR #138, `fr-ci.slice`), each job gets a fresh environment and the
orphaned-webServer class of failure disappears. The hook is then a harmless
no-op (it finds nothing to clean) — keep it as a backstop or drop it.
