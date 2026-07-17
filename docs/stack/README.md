# SAMO stack handbook — agent onboarding

Read this before touching any SAMO project. It documents the **real, deployed
state** of every major infrastructure component. Each section links to its
detailed file. Where aspirations diverge from reality, both are stated.

Sources: ground-truth audit 2026-07-07 against live repos and verified VM
state. Fabricated or memory-only claims were rejected; every fact below has a
cited source file or live verification date.

---

## What is samohost?

`samohost` is the CLI that provisions, deploys, and manages client project VMs
on Hetzner Cloud. It is the control-plane tool, not an app itself. Each client
project gets one VM (cx22/cx23 class) running prod + preview environments
together. The control plane itself runs on a separate CX33 at `91.99.233.145`.

```
samo.team control plane (CX33)
  └── samohost-trigger.timer  — polls every 3-5 min, deploys on SHA change
  └── Caddy reverse proxy      — routes *.samo.team to project VMs

Project VM (cx23, one per client project)
  └── App process (Node/Bun)
  └── Postgres 18
  └── DBLab Engine v4.1.3    — thin-clone preview DBs
  └── Caddy                   — TLS + vhost
```

---

## Read order for agents

| Step | File | What you learn |
|------|------|---------------|
| 1 | This file | Stack overview, component inventory |
| 2 | [postgres.md](postgres.md) | Which PG version to use and why |
| 3 | [dblab.md](dblab.md) | Preview DB architecture — NON-NEGOTIABLE policy |
| 4 | [supabase.md](supabase.md) | Real auth state (NOT what the preferred-stack memory says) |
| 5 | [zfs.md](zfs.md) | Pool naming, shapes, and constraints |
| 6 | [routing.md](routing.md) | Caddy, Cloudflare tokens, domain map |
| 7 | [deploy.md](deploy.md) | Trigger poller, CI gate, PR previews |
| 8 | [custom-domains.md](custom-domains.md) | Add a client custom domain via Cloudflare-for-SaaS |

Also read before any PR/MR:
- [`docs/setup-checklist.md`](../setup-checklist.md) — env vars + token scopes
- [`docs/control-plane-setup.md`](../control-plane-setup.md) — trigger wiring
- [`docs/dblab-install-runbook.md`](../dblab-install-runbook.md) — operator steps for DBLab

---

## Non-negotiable owner decisions

These cannot be overridden by a brief, a plan, or an agent decision:

1. **Previews ALWAYS use DBLab thin clones.** Never the template/dump fallback.
   Owner-stated 2026-07-06: "dblab is non-discussable for previews, it is our
   choice." See [dblab.md](dblab.md).

2. **ZFS pool on field-record NEVER moves off `/tank`.** PG data dir stays at
   `/tank/postgresql/18/main`. See [zfs.md](zfs.md).

3. **Postgres 18 is the single target version.** The samo.team control-plane
   currently runs PG 17 (provisioned before the standard was set) — that is a
   known gap, not a second standard. See [postgres.md](postgres.md).

4. **GoTrue / Supabase is NOT assumed present on project VMs.** Do not reserve
   GoTrue table names (`users`, `sessions`, `identities`, `refresh_tokens`)
   unless the owner explicitly enables the Supabase stack for that project.
   See [supabase.md](supabase.md).

5. **`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (chat) are never wired into
   samohost.** All LLM calls go through `claude -p` OAuth subprocess.
   `OPENAI_API_KEY` is allowed only for image gen (`gpt-image-1`).

---

## VM inventory (as of 2026-07-07)

| VM | IP | Size | Role | PG | DBLab |
|----|----|------|----|--|----|
| samo-team-control-plane | 91.99.233.145 | CX33 | samo.team control plane | 17 (gap — target is 18) | no |
| samo-we-field-record | 178.105.246.151 | CX33 | field-record-1 project | 18 | yes (volume-backed, tank) |
| samograph | 116.203.249.135 | CX23 | samograph project | 17 (unverified on-VM) | yes (loopback ZFS, fixed 2026-07-07) |

---

## Preferred stack (agent default for new components)

When the owner hasn't specified a technology choice, default to:

- **Postgres 18** (see [postgres.md](postgres.md))
- **TypeScript** (Bun runtime preferred for new services)
- **Caddy** for TLS + reverse proxy (never nginx)
- **DBLab thin clones** for preview environments (see [dblab.md](dblab.md))
- **Plain bcrypt + cookie sessions** for app-level auth on new client apps
  (GoTrue/Supabase auth is staged but not deployed — see [supabase.md](supabase.md))
- **ZFS pool named `tank`** on every VM with an attached volume

This list is non-exhaustive. Add entries via owner direction, not assumption.
