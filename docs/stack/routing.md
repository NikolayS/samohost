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

### Managed production routes

For an app with both `mainHost` and `mainListen = "cp-http80"`, a successful
`samohost app deploy` (including release-tag deploys through `trigger run`)
reconciles a control-plane snippet under `/etc/caddy/sites.d/`:

```
<mainHost> {
    tls internal
    reverse_proxy <app-vm-ip>:80 {
        header_up Host <mainHost>
        header_up X-Real-IP {remote_host}
    }
}
```

Registration remains offline: it records the declaration, and app bootstrap
writes the initial project-VM vhost. A production routing change is then a
two-hop transaction: samohost snapshots the old project-VM snippet, applies
and locally health-checks the desired project topology in a transition snippet
while the old host remains live, and only then changes the control-plane
snippet. If the control-plane step fails, the transition is removed and the
project VM is restored and health-checked through its old host. Re-registering with a changed
host/IP updates the stable managed files; changing away from `cp-http80`
updates/removes the project topology before removing the control-plane route.
Apps sharing one VM retain independent transaction files and route snippets.

The AppRecord separately stores a fingerprint of the last successfully applied
project-plus-control-plane routing specification. After resolving the target
SHA, `trigger run` reconciles config-only drift when that SHA is already
deployed. A new SHA/tag must pass CI and its healthy deploy before either route
can advance. Host renames replace the same managed files; `cp-http80 → tls`
and `mainHost` removal remove the control-plane hop only after the project hop
is ready. The fingerprint, deployed SHA, and release cursor advance only after
both Caddy transactions succeed.

The reconciler never edits `/etc/caddy/Caddyfile`. The control plane must
already have the canonical `import sites.d/*.caddy` line. It stages and
atomically renames the snippet, validates the complete Caddy config, then
reloads. A validation or reload failure restores and reloads the previous
snippet; the project-VM transaction then restores its snapshot. The deploy is
not stamped successful, so the trigger retries.
If the same hostname is still declared in a legacy hand-authored file, the
reconciler fails closed instead of creating an ambiguous duplicate or claiming
to manage a route it cannot update.

Run production deploys from the control plane. The timer user needs only the
local sudo operations used by the transaction: install/copy/move/remove files
under `/etc/caddy/sites.d/`, `caddy validate --config /etc/caddy/Caddyfile`, and
`systemctl reload caddy`. Do not grant Caddyfile write access and do not add
main-host blocks by hand.

Source: `samo.team/SPEC.md` (line 522 diagram), memory `project_samo_mvp_no_cloudflare_token.md`.

The project-VM vhost and the control-plane route are deliberately separate:
multi-service path routing stays on the project VM, while the control plane
has exactly one upstream (`<app-vm-ip>:80`) per public host.
