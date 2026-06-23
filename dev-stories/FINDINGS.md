# samohost fixture-lifecycle — FINDINGS

Every finding the `dev-stories/functional/fixture-lifecycle.sh` PR-preview lifecycle
fixture surfaced while driving the throwaway `samo-agent/samohost-fixture` app
through provision -> host-prep -> create -> scale -> redeploy -> teardown on a real
Hetzner VM.

Each finding is labelled:

- **FIXTURE-SIDE (fixed)** — a defect/limitation in the *harness*; already fixed
  in `functional/fixture-lifecycle.sh`.
- **PLATFORM (surface)** — a defect/limitation in the *samohost platform itself*
  (`~/samohost-trigger/src/**`); surfaced here for triage, NOT fixed by the harness.

`file:line` is given where the behaviour is anchored in code. Line numbers are at
time of writing and may drift.

---

## FIXTURE-SIDE (fixed)

### F1. Teardown name-collision orphaned a live VM — fixed
The provision-retry loop reused ONE vm name across attempts. On a retry,
attempt-1's pre-retry `samohost destroy <name>` marked the (shared) **state
record** `destroyed`; the EXIT-trap teardown then did `samohost destroy <name>`,
which resolves the now-`destroyed` record and **refuses** (`destroy.ts:60`
"already destroyed"), so attempt-2's **live provider VM** was left running — a
real orphan on the last run.

`samohost destroy` only ever resolves its target against the **state store** by
id-or-name (`destroy.ts:53` `r.id === target || r.name === target`) and hard-stops
on a `destroyed` record — it can NEVER reach a live provider resource whose record
is stale. There is no `destroy-by-id` (provider-id) subcommand.

Fix (`functional/fixture-lifecycle.sh`):
- (a) The EXIT-trap now reclaims **by Hetzner PROVIDER ID** via a direct
  `DELETE /servers/<id>` (`hetzner_destroy_by_id`, base URL matches
  `src/providers/hetzner.ts` `HETZNER_BASE_URL`), independent of the state record —
  it reclaims a live VM even if the record is stale/`destroyed`.
- (b) Each provision attempt gets a **UNIQUE name** `<base>-a<index>`, so retries
  never collide with a prior attempt's (possibly still-live) resource.
- (c) **Every** provider id provisioned this run is tracked
  (`PROVISIONED_PROVIDER_IDS`/`..._NAMES`) and the trap reclaims **each one still
  live** at the provider, re-fencing on the live name (PROTECTED_VMS + `*fixture*`)
  before any delete.
- Between-retry cleanup is now also **by provider id**, not by the shared name.
- A SELF-TEST (`selftest_teardown_by_id`) proves the property: it reclaims a LIVE
  VM whose state record is already `destroyed` — the regression guard for this bug.
- `PROTECTED_VMS` fences and the single loud `ORPHAN VM — manual cleanup needed`
  line are preserved (and the by-id path emits ORPHAN lines for every
  non-reclaimable id, incl. missing `HCLOUD_TOKEN` at teardown).

### F2. Redeploy step never pushed a commit — fixed
The redeploy assertion generated a random BG color but **never pushed** anything,
so the preview could never reflect a new color/SHA and the assertion could not
legitimately pass.

Fix: the redeploy step now clones the first open PR branch into a throwaway
dir (never the operator's working tree), edits ONLY the `const BG = '#......'`
line in `server.js` (the fixture's BG constant, `samohost-fixture/server.js:41`),
commits, and **pushes** to the PR head branch; then captures the new head SHA and
polls the preview for **both** the new color and the new short-SHA. Harmless on
the throwaway fixture repo.

---

## PLATFORM (surface)

### P1. `cx22` is deprecated at Hetzner (422)
`cx22` (the old smallest shared type) now returns HTTP 422 at create. The fixture
pins `cx23` (current smallest). The CLI help still documents `cx22` as the example
type (`src/cli.ts:131` `--type <type>  server type, e.g. cx22`). Surface: update
the example, and consider validating/normalising deprecated server types with a
clear error rather than a raw provider 422.

### P2. Provision booting->ready gate was too tight — now 1200s
The booting->ready gate is bounded by `spec.timeoutSec`, **default 600s**
(`src/commands/provision.ts:15`, deadline at `provision.ts:283`), settable ONLY
via the `--timeout` CLI flag — the `[provision]` TOML table is not consumed by any
command yet. A hardened `cx23` first boot (apparmor/fail2ban/nftables/ufw/
unattended-upgrades + `aa-enforce`, completion sentinel written LAST) regularly
exceeds 600s. The fixture raises the gate to **1200s** (`--timeout 1200`).
Surface: 600s is too tight for the hardened image's first boot; raise the default
or make it manifest-driven.

### P3. Provision RELIABILITY — hardened sshd sometimes never comes up (recurring)
Distinct from P2: on a fresh `cx23`, the hardened `sshd` sometimes **never** comes
up within ~20 min, so the ready-gate's SSH probe
(`src/commands/provision.ts` ~330: ssh + `SAMOHOST_PROVISION_COMPLETE` sentinel)
times out and the VM lands `degraded` even at 1200s. Recurring/non-deterministic.
The fixture compensates with a retry (`PROVISION_ATTEMPTS=2`, unique name each),
but the underlying first-boot flakiness is a **platform** reliability gap — the
hardened cloud-init occasionally wedges sshd on fresh hardware.

### P4. `*.samo.cat` wildcard pinned to one IP — per-preview DNS is NOT optional
The `*.samo.cat` wildcard A record is pinned to **field-record's** IP. Any preview
on a *different* VM whose per-preview A record is not written falls back to that
wildcard, so Cloudflare (Full mode) opens its origin TLS handshake against the
WRONG origin and returns **525 forever** (routing/origin mismatch, not a cert
race). Per-preview DNS is written by `runEnvCreate` **only when
`CLOUDFLARE_SAMOCAT` is set**; otherwise it emits `DNS_DEGRADE_WARNING`
(`src/commands/env.ts:470`, "CLOUDFLARE_SAMOCAT not set — ...") and skips it.
Surface: for any multi-VM preview topology, per-preview DNS is **mandatory**, not a
degrade-OK optional. The fixture sources the token and asserts the degrade warning
is ABSENT so a missing-token run fails loudly with the real cause.

### P5. Born-broken (failed-create) env persists a record + prNumber -> un-reapable
When `env create` fails its external probe (or on-host create), the env **record
is still persisted** for idempotent re-run (`src/commands/env.ts:677,701` — "env
record kept for inspection"). But that born-broken record carries a prNumber/open
branch, and `env gc` is **NEVER a candidate if the branch is open and not
ttl-expired** (`src/commands/env.ts:1250`). So a failed-create env with an open PR
is **un-reapable** by the normal paths and **wedges the `env list`** with a dead
entry that neither serves traffic nor gets collected. Surface: failed/never-ready
envs need their own reap path (or auto-destroy on create-failure) so a born-broken
record doesn't accumulate.

**STATUS — root dishonest-state stamp FIXED by this MVP run:** the underlying
mechanism that *created* the born-broken-but-looks-deployed record — `trigger.ts
ensurePreviewImpl` unconditionally stamping `lastDeployedSha = headSha` even when
the create FAILED, so reconcile computed `needDeploy = false` and never retried the
broken env — is now fixed. `lastDeployedSha` is stamped in `runEnvCreate` **only on
`outcome === "ok"`** and explicitly cleared on failure, so a failed create no longer
masquerades as deployed and the reconcile loop re-attempts it.
Merged: **#86** (`fix/heal-dishonest-state-db-unreachable`), SHA
`4648d26d2f95eac35e38c2aa640c2204fcfa5664`.
(Note: a dedicated reap path for an env that *stays* born-broken across retries —
auto-destroy-on-create-failure — is still a surface; the dishonest-state half is the
piece fixed here.)

**STATUS — DB-UNREACHABLE self-heal gap FIXED by this MVP run:** `probeClones` in
the self-heal pass previously trusted the DBLab engine's clone status and never
caught a clone whose TCP port went **unreachable** after the daily DBLab snapshot
refresh, so a dead clone was never reclassified "dead" and never re-materialised.
`probeClones` now actively probes clone reachability and classifies an unreachable
clone as dead; the heal flag was also **ungated from `--pr-previews`** so cron/manual
invocations heal dead clones too. Same merge as the dishonest-state fix:
**#86**, SHA `4648d26d2f95eac35e38c2aa640c2204fcfa5664` (self-heal follow-up to the
DBLab clone work in **#79** `feat/78-self-healing-dblab-clones`, SHA
`b308f87253a5c32f118a4ebd89e78f3b95962ad7`).

### P6. The two reap paths disagree — PR-closed vs branch-gone
The teardown-on-close lifecycle has two different triggers that **don't agree**:
- `env gc` reaps on **branch-gone** (the head ref is absent on the remote —
  `src/commands/env.ts:404,1248,1252`), covering deleted + merged-then-deleted.
- The samo-level trigger GC reaps **branch-gone + orphan-vm only, never ttl**
  (`src/commands/trigger.ts:90-92,185`).

Neither reaps on **PR-closed-but-branch-still-present**: closing a PR without
deleting its head branch leaves the preview **up**. The fixture works around this
by `gh pr close --delete-branch` (+ explicit ref delete) so the branch-gone path
fires — but a real user who just clicks "Close PR" keeps an always-on preview.
Surface: reconcile the two paths; reap on PR-closed, not only on branch-gone.

### P7. Host-prep is operator-manual, not auto-run on register -> fresh VM 522s
`app register` is offline/no-SSH (`src/commands/app.ts:5`). The two one-time root
host-prep steps — `app bootstrap` (Caddy + base Caddyfile + Node + main unit) and
`env plan --host-prep` (ufw 443/tcp + per-env `@.service` template + Caddy sites.d
include + sudoers) — only **render** scripts (samohost never auto-executes
host-mutating scripts); the operator must run them as root, IN ORDER, AFTER
register and BEFORE the first `trigger run`. Skip them and a fresh VM has no Caddy
and a closed 443 -> Cloudflare returns **CF 522** (connection refused at origin) on
every preview, forever. The fixture now renders + root-applies both. Surface:
nothing auto-runs host-prep on register, so the "register then immediately create a
preview" path is a 522 trap for operators.

### P8. Idle-death + wake-on-demand absent -> always-on cost
- **No idle/TTL reaping.** `env gc` only reaps branch-gone / orphan-vm /
  orphan-app, and ttl-expired **only when `--ttl` is passed explicitly**
  (`src/commands/env.ts:1249-1253`); the trigger GC pass **never** applies ttl
  ("no default age-based cleanup in the trigger", `src/commands/trigger.ts:91`).
  An open-PR preview nobody visits stays up forever.
- **No wake-on-demand.** Nothing starts a stopped preview unit on URL access; a
  stopped preview 502s and stays down until the next deploy/trigger.

Together: every open PR is **one always-on systemd unit + port + (dblab) clone**,
cost scales linearly with open PRs, and there is no idle suspension. Surfaced as
the harness's two XFAIL (documented-gap) assertions, NOT fixed here.

**STATUS — ADDRESSED by this MVP run (two of the three gaps; one still in review):**
- **No-rebuild-command → ADDRESSED (merged).** A first-class
  `preview rebuild <vm> <app> <branch>` subcommand now re-materialises a wedged or
  stale preview without waiting for the next deploy/trigger — covers the "stopped
  preview stays down until next deploy" half operationally.
  Merged: **#85** (`feat/preview-rebuild-command`), SHA
  `9aa93fb1b358e57701f3073575747fc41ef5df49`.
- **No-idle-teardown → ADDRESSED (warn-only), PENDING MERGE.** Atomic idle
  autodestroy for preview envs keyed on `lastAccess` (NOT `createdAt`), shipped
  **warn-only first** per the operator-prereq / degraded-gate rule. This is the
  always-on-cost reaping gap. **NOT yet merged** as of this run — tracked in PR
  **#87** (`feat/preview-idle-autodestroy`, OPEN, tip `e476344`); no merge SHA yet.
  Mark FIXED only once #87 lands.
- **Wake-on-demand:** still absent — `preview rebuild` is the operator-driven
  substitute; auto wake-on-URL-access remains a gap.

The harness is **ready to schedule** mechanically (it provisions, fences, reaps
by-id, and the orphan watchdog backstops budget). The nightly is **NOT installed
yet** because the most recent real run is not green, and the failure is
**product-side**, not harness-side and **not** provisioning reliability.

**Latest run summary:** `4 pass / 4 fail / 0 expected-fail` (run log
`/tmp/fixture-run.log`, 2026-06-23). The PASSing assertions prove the early path
is healthy: `teardown-by-id` (orphan-strand regression guard), `provision`
(throwaway `cx23` came up on **attempt 1/3 — provisioning did NOT flake**),
`register`, and `create-dns` (the 525/wrong-origin path is cleared — per-preview
DNS wrote correctly).

**Root-cause blocker — a single product/host-prep failure (NOT provisioning, NOT
a harness assertion bug):**

> `host-prep: a ROOT host-prep step FAILED on the fresh fixture VM — fresh VM has
> no Caddy and/or 443 closed; previews will CF 522. This is the real cause; fix
> host-prep before the lifecycle assertions can pass.`

Every one of the 4 failures cascades from that one root cause — they are not
independent bugs:

- `create PR#3 [preview/blue-bg]` never reached `200+env=preview+branch` within
  300s — **CF 522** (connection refused at origin: no Caddy / closed 443).
- `create PR#2 [preview/green-bg]` — no preview env created (same origin failure).
- `scale: preview count 1 != open-PR count 2` — downstream of the failed creates.
- `redeploy PR#3` pushed a new BG/SHA but the preview never reflected it — **CF
  522** again (the origin was never serving).
- `teardown-on-close PR#3` — preview env still present 300s after
  close+branch-delete (the never-ready/born-broken env did not reap; see P5/P6).

**Classification:** this is the **P7 CF-522 host-prep trap surfacing live** — the
root `app bootstrap` (Caddy + base Caddyfile + main unit) and/or
`env plan --host-prep` (ufw 443/tcp) root step did not leave the fresh VM serving
on 443, so Cloudflare (Full) hits a closed origin and returns **522** forever. It
is a **remaining product-side assertion failure**, deterministic this run, and
must be **resolved before the nightly is installed**. Once host-prep reliably
opens 443 + serves Caddy on a fresh fixture VM (creates/redeploy/scale/teardown go
green), flip `cleanEnoughToSchedule` and install the 03:30 UTC daily oneshot+timer.

Until then: the **orphan watchdog** (`samohost-fixture-orphan-reaper.timer`, every
30m + boot-catchup, `Persistent=true`) is the budget backstop — it reaps any
stray `samohost-fixture-*` VM older than 60m even when a run is parked here.

---

## OPEN — field-record cutover onto samohost-managed lifecycle (NOT done here)

> **OPEN / HELD DECISION — touches a client VM; needs platform-team + samjr-bootstrap
> coordination. Deliberately NOT actioned in this MVP run.**

The fixes above (dishonest-state stamp #86, DB-UNREACHABLE self-heal #86, idle
autodestroy #87-pending, `preview rebuild` #85) all land in the **samohost
platform** and are exercised against the throwaway fixture app. They do **NOT**
automatically reach the live **field-record** VM (`samo-we-field-record`, Hetzner
`137236481`, `ssh -p 2223 agent@178.105.246.151`).

field-record today runs its **own UNVERSIONED, snowflake preview cron**
(`preview-reconcile.sh` / `preview-teardown.sh`) — these scripts are **not present
anywhere in this samohost repo** (verified: no match under version control) and
**predate / sit outside** the samohost-managed lifecycle. They are therefore
**missing the self-heal** behaviour just fixed here: a born-broken env still looks
deployed, a DB-UNREACHABLE clone after the daily DBLab refresh is never reclassified
dead, and there is no idle autodestroy / `preview rebuild` path.

**The real fix for field-record is a CUTOVER** of that VM off its hand-rolled cron
and onto the samohost-managed preview lifecycle (the `trigger`/`env`/`preview`
commands carrying these fixes). That is explicitly **OUT OF SCOPE for this MVP run**
because:
- it **mutates a live client VM** (no silent client-VM changes), and
- it must go through **platform-team / `samjr` bootstrap** coordination — the VM's
  source of truth is the `samjr/samo-we-field-record-bootstrap` branch, and the
  rule is *do not snowflake the VM*; the cutover has to be authored there, not patched
  ad-hoc on the box.

**Until the cutover happens, the merged platform fixes do not protect field-record's
previews.** This item stays OPEN and is the one held decision from this run.
