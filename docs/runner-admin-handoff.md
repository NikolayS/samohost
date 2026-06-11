# GitHub Actions runner registration — admin-token handoff

Status: BLOCKED on a repo-admin credential. This document is the exact,
minimal handoff so the owner can unblock it in one pass. No secret values
appear here, and none should ever be committed, pasted into issues, or logged.

## Why this is blocked

Registering (or removing) a self-hosted GitHub Actions runner on a repository
requires **repo Administration** permission:

```
POST /repos/{owner}/{repo}/actions/runners/registration-token
POST /repos/{owner}/{repo}/actions/runners/remove-token
GET  /repos/{owner}/{repo}/actions/runners
```

GitHub returns **404 (not 403)** when the caller lacks admin on the repo —
which is exactly what both the operator's `gh` auth and the VM deploy token
get today against `Tanya301/field-record-1`. The runner-migration runbook
(field-record-1 PR #138) is ready; only this permission is missing.

## What the repo owner must provide (pick ONE)

Ordered by preference. The repo is user-owned (`Tanya301`), so org-level
runner groups are not applicable.

### Option A — fine-grained PAT (recommended)

Created by **Tanya301** at https://github.com/settings/personal-access-tokens/new:

- **Resource owner:** Tanya301
- **Repository access:** Only select repositories → `Tanya301/field-record-1`
- **Repository permissions:** `Administration: Read and write` — nothing else
- **Expiration:** 7 days (the migration needs it for minutes)

This token can administer that one repo and nothing else, and it expires on
its own even if revocation is forgotten.

### Option B — make the operator account a repo admin

Repo → Settings → Collaborators → change the deploying account's role to
**Admin**. Existing `gh` auth then works with no new token. Downgrade back to
Write after the migration. Choose this if minting PATs is unacceptable.

### Option C — GitHub App (durable, most setup)

A GitHub App owned by Tanya301 with repository permission
`Administration: Read and write`, installed on `field-record-1` only; the
operator holds the app's private key and mints short-lived installation
tokens. Right choice only if runner registration will recur often enough to
justify the setup; for a one-time migration, prefer A.

## Handoff rules (both sides)

- Deliver the token out-of-band (password manager share / direct message in
  an agreed private channel). Never in a GitHub issue, commit, or CI log.
- The admin token is used ONLY on the operator machine to mint runner
  registration/remove tokens. **The admin token never lands on any VM** —
  only the short-lived (1 hour) single-purpose registration token does.
- Revoke the token (or downgrade the role) immediately after step 6 below.

## Exact execution sequence (operator, once credential arrives)

Non-secret command shapes; `$ADMIN_TOKEN` is supplied via the environment,
never echoed, never in argv of remote commands.

```bash
# 1. Capability probe (read-only): proves the token sees runner endpoints.
GH_TOKEN=$ADMIN_TOKEN gh api repos/Tanya301/field-record-1/actions/runners --jq '.total_count'

# 2. Mint a registration token (valid 1 hour, single-purpose).
REG_TOKEN=$(GH_TOKEN=$ADMIN_TOKEN gh api -X POST \
  repos/Tanya301/field-record-1/actions/runners/registration-token --jq .token)

# 3. Install + register the runner on the platform VM using the runbook and
#    script merged in field-record-1 PR #138 (runs under fr-ci.slice).
#    The registration token is passed to the VM via stdin, not argv:
#      ./config.sh --url https://github.com/Tanya301/field-record-1 \
#        --name samo-we-field-record --labels self-hosted,linux,x64 --unattended
#    (token consumed interactively/stdin per the runbook)

# 4. Verify: a queued workflow run is picked up by the NEW runner
#    (gh run list / gh run view <id> --json jobs shows runnerName).

# 5. Remove the OLD runner (old VM 5.78.176.78) once the new one is green:
GH_TOKEN=$ADMIN_TOKEN gh api repos/Tanya301/field-record-1/actions/runners \
  --jq '.runners[] | "\(.id) \(.name) \(.status)"'
GH_TOKEN=$ADMIN_TOKEN gh api -X DELETE \
  repos/Tanya301/field-record-1/actions/runners/<OLD_RUNNER_ID>

# 6. Revoke the admin token (owner) / downgrade the role. Done.
```

Rollback: the old runner keeps working until step 5 — if the new runner
misbehaves, simply skip 5/6 and remove the new runner instead.

## Relation to samohost

samohost does not (yet) own runner lifecycle. If this recurs, the natural
home is an `app runner` subcommand that wraps steps 1–5 with the same
secrets-discipline as `app deploy` (admin token from env at call time, never
persisted). Deferred until a second migration proves the need.
