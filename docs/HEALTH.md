# HEALTH.md — samo per-client project health definition

A project is **healthy** only when every BLOCKER criterion below is GREEN with fresh, timestamped evidence
produced against **merged origin/main HEAD**. UNKNOWN is never GREEN (fail-closed). Verdicts:

| Verdict | Meaning |
|---|---|
| GREEN | Criterion checked, passed, evidence on file with SHA + UTC timestamp |
| RED | Criterion checked, failed — BLOCKER, blocks merge/ship |
| AMBER | Criterion checked, failed — tracked, non-blocking |
| UNKNOWN | Evidence absent, stale, or produced from a non-main SHA — treated as RED on BLOCKER criteria |

**Evidence freshness:** prod + pipeline ≤ 24 h; per-preview ≤ 2 trigger cycles (~10 min); drill-based
criteria ≤ their schedule + 24 h grace. Older → auto-UNKNOWN.

---

## 1. Purpose

> Health is a **deterministic check**, not a judgment call.

Every criterion below compiles to a concrete command that exits 0 (GREEN) or non-zero (RED/AMBER/UNKNOWN).
A human "looks good to me" or a CI green that doesn't prove the running process is GREEN is not acceptable
evidence. This spec exists to prevent propped or asserted passes from reaching the merge gate.

Implemented via `samohost health <app>` (see §6 — not yet built). Until then, every criterion names the
existing samohost/samotest signals it reuses so they can be run manually or scripted.

---

## 2. Criteria

### TIER 0: IDENTITY (prerequisite — everything else keys off it)

**ID-1 Version endpoint exists.**
The statement: `GET /api/version` on every vhost returns 200 JSON `{env, sha}` where `sha` is
**baked into the build artifact at build time** (not read from `.env` — prod code loading a preview
EnvironmentFile reports the right env with the wrong code).

Check: external TLS-verified curl (`buildCurlProbeArgs`/`parseCurlProbeResult`,
`src/commands/env.ts:608-653`) + `jq -e .sha`. GREEN = 200 + non-empty sha.

> Note: samograph prod currently 404s this — that is a RED today by design.
> Without ID-1 passing, every SHA check silently degrades to a bare-200.

Reuses: `buildCurlProbeArgs`/`parseCurlProbeResult` (`src/commands/env.ts:608-653`)

---

### TIER 1: PROD (4 BLOCKERs + 4 BLOCKERs)

**PROD-1 Serves the real app externally.** [BLOCKER]
External curl (NOT from the VM) of `https://<mainHost>/` = 200 with a pinned app-identifying body
marker; no CF 52x/1016; `http://` → 301/308 to https. On-VM localization: `systemctl is-active caddy`
+ `ss -ltnH` shows `:443` — a 521 is attributed to the origin, not retried as an edge blip.

Reuses: `caddy-serving` check (`src/doctor/checks.ts:223-233`) + `buildCurlProbeArgs`

**PROD-2 Gold flow works.** [BLOCKER]
Scripted login → session cookie → authenticated DB-backed action → non-empty tenant-scoped data, in one
run, transcript saved. Any pre-seeded prop beyond the standing smoke user = RED.

Reuses: `runAutomated` (`samotest src/automatedRunner.ts:122`) against `https://<mainHost>` with the
samotest fixture account.

**PROD-3 Deploy is live-verified.** [BLOCKER]
`gh api .../commits/main --jq .sha` == live `/api/version` sha == `app.deployedSha` (apps.json). Lag
> 2 trigger cycles = RED regardless of tags or CI reports (the "tagged but not shipped" class). Closes
the gap where `doctor` and the deploy gate only assert HTTP 200 (`src/doctor/checks.ts:334-335`,
`src/app/script.ts:291-293`).

Reuses: `runAppStatus` (`src/commands/app.ts:415-452`); `gh` SHA plumbing from trigger.

**PROD-4 All services routed.** [BLOCKER]
For every declared service unit: `systemctl is-active` == active (crash-loop grep at
`checks.ts:250-261` misses cleanly-stopped units), internal port bound (`ss -ltnH`), Caddy upstream
present in `sites.d`, one external probe per service = expected status. N declared == N active == N
routed == N passing; hand-authored vhost byte-identical to reviewed state (issue #121 class).

Reuses: `auditVm()` (`src/commands/doctor.ts:484`); `only-intended-ports` (`checks.ts:374-389`)

**PROD-5 DB not exposed.** [BLOCKER]
On-host: `:5432`, `:2345`, `6000-6099` loopback-only. Off-VM: `nc -z -w5 <vm-ip> 5432` and `2345`
both fail. DBLab `cloneAccessAddresses` == `127.0.0.1`.

Reuses: `pg-localhost` parser (`src/commands/doctor.ts:221-241`) + `only-intended-ports`

**PROD-6 Least privilege.** [AMBER]
`rolsuper=f` and `rolbypassrls=f` for the app's RLS URL; non-root `User=`; secrets mode 600; no token
in git remote; hardened sshd (all `samohost status <vm> --audit` checks pass).

Reuses: `rls-nonsuperuser` (`src/doctor/checks.ts:307-317`)

> Split policy (owner-decided): internet/container-reachable prod-DB exposure = BLOCKER (PROD-5);
> least-privilege drift = AMBER (PROD-6). See §4.

**PROD-7 Backups fresh and restorable.** [BLOCKER]
Newest ZFS snapshot < 24 h; DBLab daily logical retrieval succeeded < 24 h (`/healthz` healthy +
latest snapshot `dataStateAt` < 24 h); off-VM copy < 7 d. Fresh snapshot + failed retrieval = RED.

Reuses: `evaluateDblabPreflight` (`src/dblab/preflight.ts:107-239`); DBLab `/status` API.

**PROD-8 Rollback proven, bad SHA remembered.** [BLOCKER]
Last failed deploy (or quarterly drill): `rollback:ok` marker + post-rollback health 200 +
`/api/version` == pre-deploy SHA + `failedSha` recorded (`src/commands/app.ts:640-660`) + next
trigger cycle reports known-bad-skipped, not retry. `outcome=incomplete` with zero diagnostics
(#123 class) = RED.

Reuses: deploy phase markers (`src/app/parse.ts:79-119`); `runAppStatus` `failedSha` field.

---

### TIER 2: PREVIEW (per-env; aggregate = every open buildable PR green)

**PREV-1 Exists and serves externally.** [BLOCKER]
set(open same-repo buildable PRs) == set(healthy EnvRecords). Each `https://<app>-<branch>.samo.cat/`
external curl (TLS verify ON, 200 only, `env.ts:608` probe) returns app content through the CF edge;
preview banner injected; single `<!-- samohost-preview -->` PR comment with a URL that actually loads.
**An EnvRecord without `lastDeployedSha` is unhealthy by contract** (`src/commands/env.ts:813-843`) —
readable offline, before any probe. Any CF 521/522/525/526 = RED.

Reuses: `buildCurlProbeArgs`/`parseCurlProbeResult`; `lastDeployedSha` stamp contract.

**PREV-2 Full stack, not a frontend shell.** [BLOCKER]
Per service: `systemctl is-active <unit>@<env>` == active AND `NRestarts` stable across a 30 s window
(n1==n2 via `systemctl show -p NRestarts`) AND no crash-loop journal pattern AND every
`services[].listeners[].healthPath` returns 200 at the env's **allocated** port from
`envs.json .ports[<listener>]`. "HTTP 200 on /" is explicitly NOT env health. Plus one DB-backed
endpoint on the preview URL returns 200 with non-empty data.

Reuses: `service-crash-loop` parser (`src/commands/doctor.ts:110-120`); `buildBatchedProbeScript`
(`src/preview/heal-deps.ts:66`).

**PREV-3 Isolated — own clone, never prod, with write proof.** [BLOCKER]
(a) Config: every `envDbVars` URL points at `127.0.0.1:<clone-port ∈ 6000-6099, ≠5432>`; clone id ==
env name; `EnvRecord.dbBackend == dblab` (template/none for a DB app = RED by policy).
(b) `ss -tnp` on the env's service PIDs shows zero established connections to `:5432`.
(c) **Write-isolation canary**: POST a state-changing request via the PUBLIC preview URL, assert
count == 1 in the CLONE via the env's `DATABASE_URL` AND count == 0 in PROD via
`sudo -u postgres psql`. Catches any preview→prod write path regardless of mechanism.
(d) **Bake guard**: built bundle contains no prod listener port —
`! grep -RqE '127\.0\.0\.1:(8887|3000|8888|8189|8790)' <env build output>` — and baked
`APP_API_ORIGIN` port == `envs.json .ports["app-api"]`.

Reuses: `pg-localhost` loopback parser; `only-intended-ports`; `evaluateDblabPreflight`.

**PREV-4 Runs the PR HEAD code — artifact-verified.** [BLOCKER]
Preview `/api/version` **build-baked** sha == `gh pr view --json headRefOid` (lag ≤ 2 cycles).
`SAMO_BRANCH` from `.env` is NOT acceptable evidence — prod code loading the preview's EnvironmentFile
also reports the correct branch while running the wrong code. Runtime anchors: `readlink /proc/$(…MainPID…)/cwd`
is under `/var/lib/samohost/envs/<env>/` AND `ExecStart` contains no path under the registered
`app.appDir` (a hardcoded `/opt/<app>/start-prod.sh` fails immediately).

Reuses: `buildCurlProbeArgs`; `gh` PR headRefOid plumbing; `auditVm`.

**PREV-5 Clone schema current; migrate never targets prod.** [BLOCKER]
(a) Create transcript `migrate:ok` marker, emitted only for a real per-env DB.
(b) Zero pending migrations against the clone URL.
(c) **Snapshot freshness + parity preflight**: latest DBLab snapshot `dataStateAt` < 26 h (via
`curl 127.0.0.1:2345/status`); prod `pg_tables` set ⊆ clone's (or prod `max(schema_migrations)` ==
clone's) BEFORE migrate runs. Any migrate whose `DATABASE_URL` resolved to the prod host:port = instant
RED + incident.

Extends: `evaluateDblabPreflight` (`src/dblab/preflight.ts:107-239`) which today checks only
engine/CLI/ZFS — freshness and schema parity are new.

**PREV-6 Gold flow on the clone; RLS parity by code, never by hand.** [BLOCKER]
Same gold flow as PROD-2 against the preview vhost. Parity markers ok in the create/heal transcript
(globals sync, role-membership replay, BYPASSRLS-only replay). **Strict-equality drift check**: clone
`count(rolbypassrls=t over app login roles)` == the replay's `emitted_bypass` count **exactly** —
the shipped gate (`src/env/script.ts:698`) only fails when clone < emitted, so a manual
`ALTER ROLE … BYPASSRLS` (clone 1 > emitted 0) passes silently today. Any pass propped by manual psql
= RED.

**Functional app-role canary** (independent of the sync's own gates):
`. <env>/.env; psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM <core table>'` exits 0 with a
number (permission-denied = RED); scoped `table_privileges` count for app roles > 0 AND >= prod's.
A repo test pins that every parity gate returns non-zero when a captured count fails `^[0-9]+$` —
**empty output is never treated as 0**.

Reuses: `rls-nonsuperuser` (`checks.ts:307-317`); heal phase markers; `samotest gate check`
freshness semantics (`samotest src/gate.ts:528`).

**PREV-7 Zero manual steps (recreate drill).** [BLOCKER]
Weekly rotating drill: `env destroy` → wait ≤ 2 trigger cycles → PREV-1..6 all green with zero
human commands. `journalctl _COMM=sshd` shows zero interactive sessions outside the pinned runner
during the window.

**PREV-8 Unbuildable PRs fail honestly.** [BLOCKER]
For each open PR without a healthy env: trigger records `action=failed/error` WITH remote stderr
(never `outcome=incomplete`, zero diagnostics — #123/#125 class), PR comment states the failing phase,
that trigger service run exited non-zero. Monthly negative drill: deliberately broken PR visible in all
three places within one cycle.

Reuses: `outcome` parse contract (`src/env/parse.ts:64-86`); trigger `ExecMainStatus`.

**PREV-9 Lifecycle hygiene.** [BLOCKER]
Four inventories reconcile: open PRs == EnvRecords == `dblab clone list` == on-VM artifacts (units,
`sites.d`, DNS A records, env dirs). Any orphan = RED (a leaked clone eats the 2–3 clone cap and
blocks new PRs).

---

### TIER 3: PIPELINE

**PIPE-1 Trigger pulse.** [BLOCKER]
`systemctl is-active samohost-trigger.timer` == active+enabled; `systemctl is-failed samohost-trigger.service`
!= failed; a COMPLETED run summary in journal within 15 min (3× cycle); `WorkingDirectory` ==
`~/samohost-trigger`; that checkout: `git status --porcelain` empty AND HEAD == `git ls-remote origin main`.
A dead trigger must be visible BEFORE previews decay.

Reuses: `computeOnboardExitCode` (`src/cli.ts:133-137`) `triggerCovered` field.

**PIPE-2 Self-healing clones.** [BLOCKER]
Heal pass reports every dblab env alive or dead→healed (`HealResult` verdicts,
`src/commands/trigger.ts:1822-1873`); no env `health=dead` > 30 min; post-03:00 window: healed == 0,
failed == 0; drill: destroyed clone converges to PREV-2 green within 2 cycles; unknown-liveness envs
skipped fail-closed (`heal-deps.ts` probe contract), never blind-recreated.

Reuses: `parseBatchedProbe` / `parseProbeListeningPorts` (`src/preview/heal-deps.ts`).

**PIPE-3 env-create fails closed.** [BLOCKER]
Quarterly negative drills: DBLab down → exit 1, explicit diagnostic, zero fallback artifacts; missing
secrets → loud preflight fail; broken origin-TLS → on-host ok but external probe downgrades outcome to
`failed` (`src/commands/env.ts:762-807` contract). Any silent success or template fallback = RED.

Reuses: `evaluateDblabPreflight`; `outcome` downgrade contract.

**PIPE-4 Fleet invariants.** [BLOCKER]
`samohost doctor --all --json`: `samo_doctor_fleet_vms_failing` == 0; unknowns individually explained;
no VM with world-open non-web ports; host keys pinned; fleet-alert issue absent/closed
(`src/commands/fleet-doctor.ts`).

Reuses: `runFleetDoctor` (`src/commands/fleet-doctor.ts:40-57`); Prometheus series `samo_doctor_fleet_vms_*`.

**PIPE-5 Deterministic merge gates.** [BLOCKER]
`cigate` (`src/app/cigate.ts:53-80`): zero deploys on non-green CI except logged `--force` with reason;
private repos have a working `GH_TOKEN` so no-access ≠ no-CI (#10); `failedSha` skipped every cycle
until `clear-failed`; sampled merged PRs: last approval AFTER last commit.

Reuses: `checkCiGreen` (`src/app/cigate.ts:53-80`); `failedSha`/`deployedSha` from `runAppStatus`.

**PIPE-6 Failures surface in one cycle.** [BLOCKER]
Injected failures (monthly, one per class) visible in: `ExecMainStatus` non-zero, fleet-alert issue,
PR comment. Continuous: journal must never match the #125 signature (per-env failures + run exit 0).

Reuses: `upsertGhIssue` alerting pattern (`src/commands/fleet-doctor.ts:16`).

---

### TIER 4: TRUTH

**TRUTH-1 Verified on merged main.** [BLOCKER]
Report records the main SHA probed; prod `/api/version` sha == that == `git ls-remote origin main` at
probe time; trigger checkout clean at `origin/main`; envs stamped by the trigger, not ad-hoc CLI.
Every fix SHA a proof cites: `git merge-base --is-ancestor <sha> origin/main`. Evidence from any
non-main SHA or dirty checkout → that criterion UNKNOWN.

**TRUTH-2 No props.** [BLOCKER]
Recreate drill (PREV-7) + prop audit: zero interactive sessions during the window; live mutable state
(clone roles, `server.yml`, `sites.d`, unit templates) diffs clean against what generated scripts
would produce; every known manual fix has a tracking issue before its criterion may be green.

**TRUTH-3 Evidence, not assertion.** [BLOCKER]
Report machine-assembled from stored artifacts (doctor JSON, curl transcripts, gold-flow transcripts,
heal summaries, drill logs), each with UTC timestamp + probed SHA; freshness enforced by the generator;
green-without-artifact fails report validation.

Reuses: `staleEvidenceReasons` freshness semantics (`samotest src/gate.ts:528`); `GateReport` shape
(`samotest src/gate.ts:70-109`).

**TRUTH-4 Honest gaps.** [AMBER]
Every open issue tagged to a criterion forces at-best AMBER with the issue linked (e.g. #121→PROD-4,
#123/#125→PREV-8/PIPE-6); the report's gap list is a superset of the handbook's; closing requires issue
closed AND the criterion's own probe green on merged main.

---

## 3. Verdict levels

| Verdict | BLOCKER criteria | NON-BLOCKER criteria |
|---|---|---|
| GREEN | Probe passed, evidence fresh, SHA verified | Probe passed |
| RED | Probe failed — blocks merge and ship | Probe failed — surfaced in report |
| AMBER | Not applicable (BLOCKER criteria cannot be AMBER) | Probe failed — tracked, non-blocking |
| UNKNOWN | Treated as RED (fail-closed) | Surfaced as gap |

The aggregate verdict is GREEN only when zero BLOCKER criteria are RED or UNKNOWN.

---

## 4. Owner decisions (settled policy)

These were decided by the owner and are not open for per-project negotiation.

| Decision | Policy | Rationale |
|---|---|---|
| Gold-flow (PROD-2 / PREV-6) | BLOCKER | "The UI works before we merge." No merge without a real samotest walk that passes end-to-end. |
| Prod-DB internet exposure (PROD-5) | BLOCKER (RED) | Container/internet-reachable prod DB = critical severity regardless of other controls. |
| Least-privilege drift (PROD-6) | AMBER | Important but not outage-class; tracked, not a blocker. |
| Preview-up SLA / prod deploy-freshness | ~10 min (2 trigger cycles); staler = RED | Matches the trigger cadence; anything older is stale by construction. |
| NRestarts > 0 since env creation | RED (BLOCKER) | Safer default — any restart is a signal something is wrong; investigate before shipping. |

---

## 5. Red-team coverage index

Every row below maps a real production failure to the criterion(ia) that would catch it.

| Failure | Catching criterion(ia) |
|---|---|
| 1. All previews 521; trigger dead/inactive | PIPE-1 (trigger pulse) + PREV-1 (external 200) + PROD-1 (origin `:443` localization) |
| 2. Preview wrote to prod DB (baked prod port in bundle) | PREV-3(c) write-isolation canary + PREV-3(d) bake guard |
| 3. Frontend 200, API crash-looping | PREV-2 (per-listener healthPath + is-active + NRestarts stable) |
| 4. GOLD pass propped by manual `ALTER ROLE BYPASSRLS` + unmerged branch | PREV-6 strict-equality drift + TRUTH-1 provenance + TRUTH-2 recreate drill |
| 5. env-create failed — snapshot lagged prod schema | PREV-5(c) snapshot freshness + schema parity preflight |
| 6. Preview ran prod code (hardcoded prod entrypoint) | ID-1 + PREV-4 build-baked SHA + MainPID cwd/ExecStart anchors |
| 7. Fail-open globals sync (empty count treated as 0) | PREV-6 app-role canary + privilege-floor parity + fail-closed gate repo test |

---

## 6. How it is checked: `samohost health <app>` (productization target — not yet built)

Extends `samohost doctor` / `auditVm` (`src/commands/doctor.ts:484`). Four phases:

**Phase 0 — offline state (no network, always runs)**
Reads `apps.json` (`runAppStatus`), `envs.json` (any EnvRecord missing `lastDeployedSha` → pre-mark RED
for PREV-1), and the onboard readiness contract (`computeOnboardExitCode`, `src/cli.ts:133-137`). If not
onboarded, everything downstream is UNKNOWN.

**Phase 1 — one batched SSH probe on the app VM**
Calls `auditVm(record, app, remote)` with the explicitly looked-up AppRecord (only `runDoctor` hardcodes
`apps[0]`; `auditVm` itself accepts any app — `src/commands/doctor.ts:484-570`). Extends the checks
catalog with new probes in the same template/parser pattern (`src/doctor/checks.ts`):
`systemctl is-active` + `NRestarts` sampled twice 30 s apart per `unit@env`; per-listener curl at
allocated port; `ss -tnp` no-`:5432` for env PIDs; write-isolation canary (post via public URL in
Phase 2, the two psql counts here); bake-guard grep over the env build dir; MainPID cwd + ExecStart
anchors; clone `rolbypassrls` strict-equality count; app-role `SELECT count(*)` canary; `sites.d`/units/
env-dirs inventory (PREV-9). DBLab slice reuses `evaluateDblabPreflight` + new freshness and prod-vs-clone
schema parity probes (PREV-5, PROD-7).

**Phase 2 — external probes from the control plane**
Prod + each env vhost: `buildCurlProbeArgs`/`parseCurlProbeResult` (TLS verify ON, 200-only, no
redirects — the exact probe the trigger's B3 gate uses at `src/commands/trigger.ts:1918-1938`), plus
body-marker grep and `/api/version` JSON parse (ID-1, PROD-1, PREV-1, PREV-4). SHA triangle: `gh api`
main HEAD + `gh pr view --json headRefOid` per PR + live version sha + `deployedSha` (PROD-3, PREV-4,
TRUTH-1). `nc -z` closed-port checks (PROD-5). Trigger pulse via local systemctl/journalctl (PIPE-1).

**Phase 3: `--deep`**
Runs `samotest gate check --manifest <path>` (`samotest src/cli.ts:122`) for PROD-2/PREV-6/TRUTH-3.
Requires a `samotestManifest` field on `AppRecord` (acknowledged gap: samohost has no per-app scenario
mapping today). Without `--deep` or the field, gold-flow criteria report UNKNOWN — never green.

**Output**
Per-criterion table, one row per criterion (per-env criteria expand per env):

```
CRITERION | TIER    | VERDICT | EVIDENCE
PREV-4    | preview | RED     | env pr-142: live sha 9f3c1a != head 77bd02, lag 47m > 10m @2026-07-10T08:41Z
```

`--json` emits a `HealthReport` mirroring samotest's `GateReport` shape (`required/passed/failed/waived`
+ per-check evidence, `samotest src/gate.ts:70-109`), written to `~/.samohost/health/<app>-<ts>.json` —
the stored artifact IS the TRUTH-3 evidence chain. Prometheus series names mirror fleet-doctor
(`samo_health_<app>_criteria_{red,unknown,amber}`).

**Trigger wiring (continuous health)**
A `health` pass runs at the end of every `runTriggerRun` (`src/commands/trigger.ts:353`) after heal +
pr-previews — Phases 0+2 per registered app, Phase 1 SSH probes every Nth cycle. RED → `upsertGhIssue`
with marker `<!-- samohost-health-<app> -->` (fleet-doctor pattern, `src/util/gh-comment.ts`); trigger
run exits non-zero (satisfies PIPE-6). GREEN → issue closed.

**Implementation order:** (1) `health.ts` skeleton + Phase 0 + `auditVm` reuse with explicit app
lookup; (2) Phase 2 external probes + SHA triangle + report/JSON artifact; (3) new on-VM checks in
`checks.ts` (NRestarts, listeners, canaries, anchors); (4) DBLab freshness/parity; (5) trigger pass +
GH issue + Prometheus; (6) `--deep` samotest linkage.
