# Setup checklist — everything a bot needs before samohost works

This is the single ordered list of credentials, scopes, and prerequisites an
autonomous operator (human or bot) must have in place **before** any samohost
command that touches a provider, GitHub, DNS, or the edge will succeed.

No secret VALUES appear here — only env-var **names** and the **scopes** each
must carry. Deliver every token out-of-band (password-manager share / agreed
private channel); never paste a token into an issue, a commit, a CI log, or an
agent brief.

Read-only / offline commands (`list`, `preview`, `app plan`, `env plan`,
`app register`, `status` without `--audit`) need none of this. The table below
is the gate for the write/network paths.

## Quick map — env var → who reads it → scope

| Env var | Read by | Required for | Scope / kind |
|---|---|---|---|
| `HCLOUD_TOKEN` | `src/providers/hetzner.ts` | `provision`, `destroy` (real Hetzner API) | Hetzner Cloud API token, **Read & Write**, on the target Hetzner **project** (token is project-scoped — must be the project the VMs live in) |
| `GH_TOKEN` (preferred) or `GITHUB_TOKEN` | `src/app/cigate.ts`, ref resolver, `trigger` | `app deploy` (CI-green gate + ref→SHA resolve), `trigger run` | GitHub token with **read** access to the app repo's Actions runs & commits. `gh auth token` supplies this if the logged-in `gh` account can read the repo. |
| `CLOUDFLARE_SAMOCAT` | `src/commands/env.ts`, `src/dns/cloudflare.ts` | per-preview DNS during `env create` (the `<app>-<branch>.samo.cat` A record) | Cloudflare API token **zone-scoped to `samo.cat`**, `Zone:DNS:Edit` + `Zone:Zone:Read` (zones:list, so samohost resolves the zone id itself). DNS only — it **cannot** deploy the Worker. |
| `CLOUDFLARE_API_TOKEN` | `src/commands/dns.ts`, `src/dns/preflight.ts`; also `wrangler` | `dns status` Cloudflare-API origin verification; **Worker deploy** (`bunx wrangler deploy`) | Two different scopes depending on use — see "Two distinct Cloudflare tokens" below. |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler` | Worker deploy only | Cloudflare account id of the account owning `samo.cat`. Not a secret, but required. |
| `SAMOHOST_SAMOCAT_ZONE_ID` | `src/commands/env.ts` | optional | Pins the `samo.cat` zone id so samohost skips the zones:list lookup. Optional — omit and the `CLOUDFLARE_SAMOCAT` token resolves it. |
| GitHub fine-grained PAT (`Administration: R/W`) | `gh api .../actions/runners` (operator-side) | one-time **self-hosted runner** registration | Per-repo, **Administration: Read and write**, nothing else. See `docs/runner-admin-handoff.md`. Used on the operator host only; never lands on a VM. |
| `CLOUDFLARE_SAMOTEAM` | `src/commands/domain.ts` (`defaultDomainDeps`) | `domain add`, `domain check`, `domain rm` (CF-for-SaaS Custom Hostnames) | Cloudflare API token **zone-scoped to `samo.team`**, `SSL and Certificates:Edit` scope. **Also requires the CF-for-SaaS entitlement on the `samo.team` zone** — contact Cloudflare support to enable it if not already on. Without this entitlement, the token alone is not sufficient. When the token is absent the commands degrade cleanly (warn; still write Caddy vhost + state). |
| `RESEND_API_KEY` (or app-chosen name) | **the deployed app, not samohost** | only if the client app sends email | samohost never reads this. If the app emails, the operator places the key in the app's own `--env-file` on the host; samohost never reads or writes that file. Listed only so a bot does not look for it in samohost. |

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are **not** used by samohost — do not
wire them.

## Two distinct Cloudflare tokens (this trips bots)

`samo.cat` needs **two separate Cloudflare tokens** with non-overlapping scope.
Do not try to make one token do both — the DNS token returns CF error `10000`
on Workers endpoints, and a Workers token cannot edit DNS.

1. **DNS token** — `CLOUDFLARE_SAMOCAT`
   - `Zone:DNS:Edit` + `Zone:Zone:Read`, zone-scoped to `samo.cat`.
   - Used by `env create` (per-preview A record) and `dns status`.
   - When used by `dns status`, the same value is also accepted via
     `CLOUDFLARE_API_TOKEN` (that command reads `CLOUDFLARE_API_TOKEN`).

2. **Workers token** — supplied as `CLOUDFLARE_API_TOKEN` at Worker-deploy time
   - `Account > Workers Scripts: Edit` (account owning `samo.cat`) **and**
     `Zone > Workers Routes: Edit` (zone `samo.cat`).
   - Used **only** for `bunx wrangler deploy` of the preview banner Worker,
     together with `CLOUDFLARE_ACCOUNT_ID`. See `docs/edge-preview-banner.md`.

Keep these as two physically separate tokens. Never widen the existing
`samo.team` / `samo.green` DNS token to cover `samo.cat`.

## SSH keypair + out-of-band host-key fingerprint

- A bot needs an **SSH keypair** it controls (`ed25519` recommended). The
  `.pub` half goes into cloud-init at `provision` time; the **private key path**
  is recorded so later `ssh` / `status --audit` / `logs` / `app deploy` /
  `env create` reach the VM.
- For `adopt` (registering an already-existing VM) the bot **must** supply
  `--host-key-fingerprint 'SHA256:…'` verified **out-of-band** (from the
  provider console / the provisioning log) — samohost does **no** trust-on-first-use
  and **no** keyscan. A wrong or unverified fingerprint is a hard stop. The
  fingerprint is pinned and reused for every later SSH to that VM.
- `provision` captures and pins the host key itself from the create flow, so a
  provisioned VM needs no fingerprint flag.

## Install samohost + where state lives

```bash
# Requires Bun — https://bun.sh
git clone https://github.com/NikolayS/samohost.git
cd samohost
bun install
bun run src/cli.ts --help          # discovery surface; per-command usage in the same output
```

- **State directory: `~/.samohost/`** — all VM records, app records, env
  records, and pinned host keys. Writes are atomic. There is no server and no
  remote state; back up this directory if VM/app/env state matters. Override is
  not required for normal operation.
- The repo is **public** — never commit a token, never write one into a file
  under the repo, never echo a `systemctl cat`/unit body that contains an
  `Environment=` line.

## Ordered bring-up (greenfield, fully autonomous)

1. Install Bun, clone, `bun install`. Confirm `bun run src/cli.ts --help`.
2. Export `HCLOUD_TOKEN` (target Hetzner project). `bun run src/cli.ts provision …`
   — or `adopt` an existing VM with its out-of-band fingerprint.
3. `status <vm> --audit` to confirm the hardening baseline over the pinned SSH.
4. (One-time, root, on the VM) `app bootstrap` → review → run as root; then
   `env plan <vm> <app> --host-prep` → review → run as root. These place OS
   users, DB, env file, and the preview host-prep that later `env create`
   depends on. See `docs/control-plane-setup.md`.
5. `app register <vm> …` (or `--from-toml <path>` — see README) to record the
   app. Export `GH_TOKEN`. `app deploy <vm> <app> --ref main`.
6. For previews: export `CLOUDFLARE_SAMOCAT`, ensure the `*.samo.cat` wildcard
   exists (`dns status samo.cat --expect-ip <vm-ip> --cf-zone samo.cat`), decide
   origin TLS (see `docs/preview-reachability.md`), then `env preflight <vm>`
   and `env create <vm> <app> --branch <b>`.
7. For unattended auto-deploy (and optional auto PR previews via
   `trigger run --pr-previews`) + the edge banner: stand up the control plane
   (`docs/control-plane-setup.md`) and deploy the Worker
   (`docs/edge-preview-banner.md`).

If any token in the table above is missing, the dependent command fails loudly
with the env-var name in the error — that is the signal to obtain it, not to
`--force` past it.
