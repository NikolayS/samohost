# samohost — SPEC v0.1

## 1. Goal & Why It's Needed

**Goal:** `samohost` is a TypeScript/Bun CLI that provisions and manages security-hardened Linux VMs on AWS (EC2) and Hetzner Cloud from a single, declarative command — and tears them down cleanly.

**Why this exists:** Standing up a *correctly hardened* VM today means hand-assembling SSH config, UFW rules, Fail2Ban, sysctl tuning, unattended-upgrades, AppArmor, and a non-root sudo user — per provider, per project, by hand. This is slow, error-prone, and inconsistent: the security baseline drifts between machines and between engineers. Cloud provider consoles and raw Terraform give you a VM but not an opinionated, audited security posture, and generic config-management tools (Ansible, etc.) require their own runtime, inventory, and learning curve. `samohost` collapses "give me a hardened box with optionally Postgres/ZFS/Supabase on it" into one command with a reproducible, version-controlled cloud-init artifact. The hardening is **not optional and not a checklist the user maintains** — it is baked into every VM the tool creates, so "secure by default" is the only mode.

**Why a CLI (not a SaaS/control-plane):** The tool is operator-local. State lives on the operator's machine; provider credentials never leave it. There is no server to run, no account to create. This keeps the trust boundary small and makes the tool usable inside CI or a laptop identically.

## 2. Scope Decisions

- **Primary user:** A solo/small-team backend or platform engineer (the "postgres.ai-adjacent" power user) who needs disposable-but-hardened dev/test/demo VMs — frequently to run Postgres, DBLab thin clones, or a Supabase stack — without becoming a full-time sysadmin. They are comfortable on the command line and already hold AWS/Hetzner credentials.
- **v0.1 minimum end-to-end:** `provision` → hardened, reachable VM on **Hetzner OR AWS** with the **full mandatory hardening baseline** applied via cloud-init, recorded in local state; plus `preview` (offline render), `list`, `status`, `ssh`, `logs`, and `destroy`. **One optional module ships in v0.1: PostgreSQL 17 + PostgREST + Caddy** (the highest-value path for the target user). All other modules (ZFS, noVNC, DBLab, Supabase, plain Node/Bun) are scaffolded as module interfaces but **deferred** to later versions.
- **Lifecycle ownership:** v0.1 owns **create → observe → destroy**. It does **not** own in-place reconfiguration, resize, patching orchestration beyond unattended-upgrades, or snapshot/backup. Re-provisioning is the supported "change" path (cattle, not pets).
- **Success metric:** A user runs `samohost provision --provider hetzner ...` and within one command obtains a VM they can `samohost ssh` into on the hardened port as the non-root user, where an automated post-boot audit (`samohost status <vm> --audit`) confirms every baseline control is active.
- **Failure handling:** (a) **Partial provisioning** — provisioning is staged with a recorded `lifecycle_state`; if a stage past "API create" fails, the VM is written to state as `degraded` with the failing stage noted, never silently lost, and `destroy` can always reclaim it. (b) **Drift** — out of scope to *correct* in v0.1, but `status --audit` *detects* hardening drift and reports it. (c) **Lost/corrupt local state** — state writes are atomic (temp-file + rename) with a one-deep backup; provider-side resource tags (`managed-by=samohost`, `samohost-id=<uuid>`) are written at create time so orphaned resources are always discoverable.

## 3. User Stories

1. **As a platform engineer (Dana),** I want to run `samohost provision --provider hetzner --region nbg1 --type cx22 --ssh-key ~/.ssh/id_ed25519.pub` so that I get a fully hardened Ubuntu VM in minutes without writing any cloud-init or firewall rules myself. *Outcome:* a reachable VM with the full security baseline, recorded locally, SSH-able via `samohost ssh`.
2. **As a security-conscious engineer (Sam),** I want to run `samohost preview --provider aws --module postgres` so that I can read and review the exact cloud-init YAML and hardening directives **before** any cloud API call or spend. *Outcome:* deterministic YAML printed to stdout (or `--json`), zero network calls, exit 0.
3. **As a Postgres developer (Priya),** I want to provision a VM with `--module postgres` so that I get PostgreSQL 17 + PostgREST behind Caddy with automatic TLS on the hardened box. *Outcome:* a working REST-over-Postgres endpoint reachable on 443, with DB isolated in its own systemd resource slice.
4. **As an operator (Omar),** I want `samohost list` and `samohost status <vm> --audit` so that I can see every VM I manage, its provider/IP/modules, and confirm the hardening controls are actually active. *Outcome:* a human table (or `--json`) plus a pass/fail audit of each baseline control.
5. **As a cost-conscious user (Dana again),** I want `samohost destroy <vm>` to tear down the VM and its provider-side resources with a typed confirmation so that I never leak billable resources. *Outcome:* provider resources deleted, state entry marked `destroyed`, confirmation required unless `--yes`.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ CLI layer (arg parse, --json/--yes, help, exit codes)        │
│   commands: provision list status destroy preview ssh logs   │
├──────────────────────────────────────────────────────────────┤
│ Orchestrator (lifecycle state machine, staged execution)     │
├───────────────┬───────────────┬──────────────────────────────┤
│ Provider port │ CloudInit     │ State store                  │
│ (interface)   │ builder       │ (atomic JSON @ ~/.samohost)  │
│  ├ Hetzner    │  ├ hardening  │                              │
│  │  (fetch)   │  │  baseline  │ Config loader (TOML)        │
│  └ AWS        │  └ modules[]  │  @ ~/.samohost/config.toml  │
│    (SDK v3)   │               │                              │
└───────────────┴───────────────┴──────────────────────────────┘
```

**Components & boundaries:**

- **CLI layer** — pure argument parsing → typed command request objects; no provider/network logic. Owns output formatting (table vs `--json`) and the process exit-code contract.
- **Orchestrator** — drives the provisioning state machine. Knows nothing provider-specific beyond the `Provider` interface; composes CloudInit builder + provider + state store.
- **`Provider` port** — a narrow interface every backend implements: `create(spec)`, `get(id)`, `list()`, `destroy(id)`, `normalizeError(e)`. This is the seam that lets GCP/DigitalOcean be added later without touching the orchestrator. **Hetzner** = direct `fetch` HTTP calls; **AWS** = AWS SDK v3 EC2 client.
- **CloudInit builder** — pure functions: `(spec, modules[]) → cloud-init YAML string`. The hardening baseline is a non-removable module always prepended. Being pure makes it the most heavily unit-tested unit and powers `preview` with zero side effects.
- **State store** — local JSON at `~/.samohost/state.json`; atomic writes (temp + `rename`), one backup. Each record: `{id(uuid), provider, provider_id, name, ip, ssh_key_path, ssh_port, region, type, modules[], lifecycle_state, created_at, updated_at}`.
- **Config loader** — parses `~/.samohost/config.toml` for credentials + defaults; credentials may also come from env (`HCLOUD_TOKEN`, standard AWS chain). Env overrides file.

**Key abstractions:** `Provider` (port), `Module` (`{name, validate(spec), cloudInitFragment(spec), auditChecks[]}`), `VmRecord` (state), `ProvisionSpec` (normalized request).

## 5. Implementation Details

**Data flow (provision):**
1. CLI parses flags / runs interactive wizard → `ProvisionSpec`.
2. Config loader resolves credentials + fills defaults.
3. Module set validated (`validate(spec)`); hardening baseline always included.
4. CloudInit builder renders YAML (deterministic, sorted keys).
5. *(preview stops here and prints.)*
6. Orchestrator advances the state machine, persisting after each transition.

**Lifecycle state machine** (persisted in `lifecycle_state`):
```
planned ─create→ creating ─api ok→ booting ─cloud-init ok→ ready
    │               │                  │
    │               └─ api fail→ failed (no resource)
    └─ (preview: never persisted)
booting ─cloud-init timeout/err→ degraded   (resource exists, reclaimable)
ready/degraded/failed ─destroy→ destroying → destroyed
creating/booting ─destroy (crash reclaim)→ destroying → destroyed
```

- Transition past `creating` (API accepted) **always** writes a record with provider tags `managed-by=samohost`, `samohost-id=<uuid>` so nothing is orphaned even if the process dies.
- `booting→ready` is gated by polling for cloud-init completion (SSH-reachable + sentinel marker), bounded by `--timeout` (default 600s). Timeout ⇒ `degraded`, not failure.

**Key algorithms:**
- **Deterministic YAML render** — keys sorted, module fragments concatenated in fixed order; identical `(spec, modules)` ⇒ byte-identical output (snapshot-testable, makes `preview` trustworthy).
- **Hardening audit** (`status --audit`) — SSH in and run read-only probes mapped from each module's `auditChecks` (e.g. `sshd -T | grep port`, `ufw status`, `systemctl is-active fail2ban`, sysctl reads, `aa-status`), returning per-control pass/fail.
- **Atomic state write** — serialize → write `state.json.tmp` → `fsync` → `rename` over `state.json`, keeping `state.json.bak`.
- **Provider error normalization** — each provider maps native errors to a common `{kind: auth|quota|notFound|rate|transient|unknown, message}` so the orchestrator handles them uniformly (retry transient/rate with backoff; surface auth/quota immediately).

**Security/credential handling:** credentials are read at call time, never written to state or logs; cloud-init artifacts and logs are scrubbed of secrets before printing. SSH defaults to the hardened port and the non-root user recorded in state.

## 6. Tests Plan

**Test-first (TDD):**
- **CloudInit builder** — snapshot + property tests first: baseline always present, module ordering deterministic, secrets never emitted, `--module postgres` yields expected directives.
- **State store** — atomic-write + crash-safety (simulate failure between temp-write and rename; assert prior state recoverable from `.bak`).
- **Lifecycle state machine** — table-driven transition tests (legal/illegal transitions, degraded path) written before the orchestrator.
- **Provider error normalization** — map fixture errors to the common taxonomy.

**CI tests:**
- Unit: config loader (env vs file precedence), CLI arg parsing → `ProvisionSpec`, `--json` output shape.
- Provider adapters against recorded/mocked HTTP (Hetzner `fetch` mocked) and AWS SDK client mocked — **no real cloud calls in CI**.
- Golden-file test for `preview` per provider × `postgres` module.
- Integration: `provision`→`list`→`status`→`destroy` against an in-memory fake provider implementing the `Provider` port.
- Lint/typecheck gate (`tsc --noEmit`, formatter check).

**Manual tests:** the five user stories in §3 are the manual test script, run against one real Hetzner project and one real AWS account before tagging a release.

## 7. Implementation Plan (sprints, parallelized)

**Sprint 0 — Foundations:** repo, Bun + TS config, lint/test harness, `Provider`/`Module`/`VmRecord`/`ProvisionSpec` interfaces agreed. *Gate: interfaces frozen.*

**Sprint 1 — Parallel core (after interfaces frozen):**
- *CLI/systems eng:* CLI parsing, command skeletons, state store (TDD), lifecycle state machine (TDD).
- *Security eng:* hardening baseline cloud-init builder + audit checks (TDD, snapshot).
- *Cloud eng:* Hetzner adapter first (simpler, `fetch`), then AWS adapter — both against mocks.
- *Test eng:* golden/snapshot infra + fake provider for integration tests.

**Sprint 2 — Integration & first module:**
- Wire orchestrator end-to-end (`provision`/`list`/`status`/`destroy`/`ssh`/`logs`) over both real providers.
- `postgres` module (PG17 + PostgREST + Caddy + DB systemd slice) + its audit checks.
- `status --audit` connects builder audit metadata to live probes.

**Sprint 3 — Hardening & release:** partial-provision/degraded paths, atomic-state crash tests, error-taxonomy retries/backoff, docs, manual run of all five user stories on real AWS+Hetzner, tag v0.1.

## 8. Roadmap / Deferred (post-v0.1)

- Modules: ZFS, noVNC, DBLab Engine, self-hosted Supabase, standalone Node 22/Bun.
- `samohost import` state reconciliation from provider tags; drift *correction* (not just detection).
- In-place reconfigure / resize; snapshots & backups.
- Additional providers: GCP, DigitalOcean (the `Provider` port already accommodates them).

## 9. Changelog

- **v0.1** — Initial spec. TypeScript/Bun. Hetzner + AWS. Full hardening baseline always applied. Single optional module: `postgres` (PG17 + PostgREST + Caddy). Lifecycle state machine with degraded/orphan-safe paths. Atomic local state store. TDD test plan. 4-sprint parallel implementation plan.
