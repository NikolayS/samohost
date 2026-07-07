# Postgres — version standard

## The one standard: Postgres 18

**All new provisioning targets Postgres 18.**

Sources (all verified 2026-07-07):

- `samohost app bootstrap` defaults to PG 18:
  `src/app/bootstrap.ts` — `const pgMajor = opts.pgMajor ?? 18`
- field-record-1 VM runs PG 18 on `/tank/postgresql/18/main` (live, verified
  per `docs/dblab-install-runbook.md` and VM handoff 2026-06-12)
- samo.team SPEC.md §7.1 targets PG 18: "Every project runs PostgreSQL 18
  (targeting GA release in Q3 2025; using PG17 during beta period with upgrade
  path)" (samo.team/SPEC.md lines 762-764)
- DBLab clone images use `postgresai/extended-postgres:18-0.6.2` (tag verified
  published on Docker Hub 2026-07-07; the runbook's earlier "UNVERIFIED" note
  is now resolved)

## Known gap: samo.team control plane runs PG 17

The samo.team control-plane VM (`91.99.233.145`, CX33) runs PG 17. This is
because `samo.team/infra/cloud-init/template.ts` line 66 has `pgVersion ?? 17` as its
default and was never updated when the target moved to PG 18. The SPEC says
"upgrade path from PG17 during beta" — migrating the live control-plane from
17 to 18 is an **owner decision**, not something an agent should do
autonomously.

The SPEC.md v0.1 text in some places mentions PG 17 — that text predates the
code implementation. **The `bootstrap.ts` default (18) is authoritative for new
VMs.**

## What agents must do

- When provisioning a new VM via `samohost app bootstrap`, accept the default
  PG 18. Do not pass `--pg-major 17`.
- When writing migrations, schema, or any Postgres-version-sensitive SQL, target
  PG 18 syntax and features.
- Do not cite "PG 17 is the standard" based on the samo.team control-plane.
  That VM is a known exception; the standard is 18.
- The samograph VM PG version has not been verified live on the VM (provisioned
  by samo.team cloud-init, likely PG 17). Verify with `psql --version` before
  assuming.

## Version matrix (verified)

| Deployment | PG version | Source |
|---|---|---|
| samohost bootstrap default | **18** | `src/app/bootstrap.ts:pgMajor??18` |
| field-record-1 VM | **18** | `docs/dblab-install-runbook.md`, VM handoff 2026-06-12 |
| samo.team SPEC target | **18** | `samo.team/SPEC.md §7.1 lines 762-764` |
| DBLab clone image | **18** | `postgresai/extended-postgres:18-0.6.2` |
| samo.team control-plane (live) | **17** (gap) | `samo.team/infra/cloud-init/template.ts:66` |
| samograph VM (live) | unverified | provisioned by samo.team cloud-init; assumed 17 |
