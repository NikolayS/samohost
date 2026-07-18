# Routing — Caddy + Cloudflare

## Caddy is the only reverse proxy

Every SAMO VM uses Caddy. No nginx, no HAProxy. Configuration pattern:

```
/etc/caddy/Caddyfile          — imports sites.d/*.caddy
/etc/caddy/sites.d/           — per-vhost snippets (written by samohost)
```

Sources: `field-record-1:deploy/setup-vm.sh`, `src/app/bootstrap.ts`
(Caddy sites.d pattern, `tlsMode='acme'` default).

TLS: Caddy handles ACME (Let's Encrypt) on project VMs by default. The control
plane uses CF-proxied TLS or `tls internal` depending on the vhost.

## Domain map

Three namespaces, three purposes:

| Domain | Purpose | Who manages DNS |
|---|---|---|
| `*.samo.team` | samo.team's own project and control plane | Cloudflare, wildcard |
| `*.samo.green` | samo.team's own project previews / staging | Cloudflare, wildcard |
| `*.samo.cat` | Client project previews (samohost-managed) | Cloudflare, programmatic via `CLOUDFLARE_SAMOCAT` |

Preview URL pattern: `{app}-{branch-label}.samo.cat`

`samo.cat` NS was moved to Cloudflare 2026-06-11 (Option 2 from
`docs/dns-preview-authority.md`). Per-preview A records are written by
`samohost env create` via the `CLOUDFLARE_SAMOCAT` token.

## Cloudflare tokens — three in total, never combined

### Token 1: `CLOUDFLARE_SAMOCAT` (DNS only)

- Scope: `Zone:DNS:Edit` + `Zone:Zone:Read`, zone-scoped to `samo.cat`
- Used by: `env create` (writes per-preview A record) — `src/commands/env.ts:1010`
- Do NOT add Workers scope to this token

### Token 2: `CLOUDFLARE_API_TOKEN` (dns status + Workers deploy)

- Used by **two separate operations with different required scopes:**
  1. `dns status` — presence check + read-only CF API origin verify
     (`src/commands/dns.ts:81`: `deps.env["CLOUDFLARE_API_TOKEN"]`). For this
     use only DNS read scope is needed.
  2. `bunx wrangler deploy` — preview banner Worker deploy (`wrangler.toml`).
     For this use the required scope is `Account > Workers Scripts: Edit` +
     `Zone > Workers Routes: Edit` (account + `samo.cat` zone).
     See `docs/edge-preview-banner.md`.
- Because `dns status` and `wrangler deploy` share this env-var name, a
  Workers-scoped token satisfies both. Do NOT reuse `CLOUDFLARE_SAMOCAT` for
  this var — a DNS-only token succeeds at `dns status` but fails at `wrangler`.

Source: `docs/setup-checklist.md` "Two distinct Cloudflare tokens."

### Token 3: `CLOUDFLARE_SAMOTEAM` (CF-for-SaaS custom domains)

- Scope: `SSL and Certificates:Edit`, zone-scoped to `samo.team`
- Used by: `samohost domain add/rm` (Custom Hostnames)
- Requires CF-for-SaaS entitlement on the `samo.team` zone — contact Cloudflare
  support if not already enabled; the token alone is not sufficient without it
- When absent: commands degrade cleanly (warn, still write Caddy vhost + state)

## Control plane as router

The samo.team control plane (CX33, `91.99.233.145`) acts as a router for
`*.samo.team`. Its Caddy `reverse_proxy` routes each `{project}.samo.team`
request to the corresponding project VM. No CF DNS API token is needed for
this routing; Cloudflare handles the wildcard DNS record to the control plane
IP.

Source: `samo.team/SPEC.md` (line 522 diagram), memory `project_samo_mvp_no_cloudflare_token.md`.

## Control-plane Caddy reload — resilient to a broken `systemctl reload`

`domain add`/`domain rm` write a `sites.d` snippet on the control plane and then
reload Caddy. The reload is **resilient**:

```
sudo /usr/bin/systemctl reload caddy || sudo /usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
```

Why the fallback exists: the control-plane `caddy.service` has `PrivateTmp=true`.
On a long-running instance the systemd-private `/tmp` staging dir can be evicted
by the `D /tmp … 30d` tmpfiles cleaner, after which **`systemctl reload caddy`
fails with `status=226/NAMESPACE`** ("Failed to set up mount namespacing:
/tmp: No such file or directory"). The running Caddy is unaffected and keeps
serving, but any config change (routing, custom domains) silently fails to apply.
The admin-API fallback (`caddy reload`, localhost:2019) is zero-downtime and
immune to the namespace issue; it fails **closed** if the config is invalid.

This affects **every** long-running `PrivateTmp=true` service on the host, not
just Caddy. Host-side remedy (needs a maintenance window; NOT required for
`domain add`): `systemctl restart caddy` to recreate the namespace dir, and fix
the `/tmp` tmpfiles rule so it stops evicting live `systemd-private-*` dirs.

Only the two **control-plane** reload sites use the fallback
(`buildControlPlaneCustomDomainVhostScript` / `…RemoveScript`). App-VM reloads
stay `systemctl`-only — the app-VM `samo` sudoers grant covers only
`/usr/bin/systemctl reload caddy`, so a `caddy reload` fallback there would
password-prompt.

## samohost vhost template caveat

Issue #121 (open 2026-07-06): the current `host-prep` vhost template generates
a single-upstream `:443` only. This is unusable for multi-service apps and
clobbers hand-authored `00-main-<app>.caddy` snippets. If your app needs
multiple upstreams (e.g. app on :3000 + API on :4000), write the Caddyfile
snippet manually and do not use the vhost template until #121 is resolved.
