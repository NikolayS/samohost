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

## Manual runbook: adding an additional *.samo.team host to a client app

`AppRecord.mainHost` is a single scalar — samohost has no first-class
"additional host" concept. Giving a client a second nicer `*.samo.team`
alias is done by hand-authoring a control-plane Caddy vhost. This is rare
enough that a manual fixture beats a command.

No DNS change is needed. The `*.samo.team` wildcard in Cloudflare and the
`tls internal` wildcard cert on the control-plane already cover any new
subdomain automatically.

### Steps

**1. Check app host-sensitivity first (read the app repo)**

The app may reject or redirect requests that arrive on a host it was not
configured for. Look for:

- `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` / trusted-host middleware
- `Cookie Domain=` attribute (scopes cookies to a specific hostname)
- Redirect-to-a-fixed-host logic (`redirect to mainHost` patterns)
- Absolute URLs built from `BASE_URL` / `MAIN_HOST` env

If **host-agnostic** (no Domain attr on cookies, path-relative redirects,
no host allowlist) — a Caddy route alone suffices.

If **host-sensitive** — the route is still required, but you also need an
app-config change (update env vars, re-deploy). That config change is out
of scope for this runbook; resolve it in the client's repo first.

**2. Probe the client VM's own Caddy**

The VM's Caddy may be host-locked to `mainHost`. Check before writing the
control-plane vhost:

```bash
VM_IP=<vm-ip>
ORIG=<original-mainHost>        # e.g. field-record-1.samo.team
NEW=<new-host>.samo.team

curl -s -o /dev/null -w '%{http_code}' -H "Host: $NEW"  http://$VM_IP/
curl -s -o /dev/null -w '%{http_code}' -H "Host: $ORIG" http://$VM_IP/
```

- Both return `200` → VM Caddy is host-agnostic; pass `{host}` upstream as
  normal (no `header_up Host` needed).
- `$NEW` returns `308` or rejects, `$ORIG` returns `200` → VM Caddy is
  host-locked. The control-plane vhost **must rewrite** the upstream Host
  header to `$ORIG` (see step 3). This is safe when the app's cookies carry
  no `Domain` attribute — the browser scopes cookies to the host it connected
  to and never sees the internal rewrite.

**3. Add a NEW sites.d file on the control plane**

SSH to the control plane (`91.99.233.145`). Do **not** edit the main
Caddyfile or the client's existing vhost snippet.

```bash
# Pick the next available NN prefix (ls /etc/caddy/sites.d/ to see existing)
sudo tee /etc/caddy/sites.d/NN-<name>.caddy <<'EOF'
<new-host>.samo.team {
    tls internal
    reverse_proxy <vm-ip>:80 {
        # ONLY include header_up Host if VM Caddy is host-locked (step 2).
        # Replace with the host the VM's Caddy accepts.
        header_up Host <original-accepted-host>
        header_up X-Real-IP {remote_host}
    }
    log {
        output file /var/log/caddy/<new-host>.samo.team.log
        format json
    }
}
EOF
```

**4. Validate and reload**

```bash
caddy validate --config /etc/caddy/Caddyfile
# Must print "Valid configuration" with no errors before proceeding.

caddy reload --config /etc/caddy/Caddyfile
# Uses Caddy's admin API. Do NOT use `systemctl reload caddy` —
# it currently fails on this control plane with a 226/NAMESPACE error
# (a /tmp mount-namespace quirk unrelated to this change).
# The sites.d file is already on disk and is imported at next full restart.
```

**5. Verify**

```bash
NEW=<new-host>.samo.team
ORIG=<original-mainHost>

# New host must serve the real app, not the static "Not deployed yet" fallback
curl -s -o /dev/null -w '%{http_code}' https://$NEW/
curl -s https://$NEW/api/version   # or any live endpoint

# Original host must still work
curl -s -o /dev/null -w '%{http_code}' https://$ORIG/

# Spot-check an unrelated client (e.g. samograph) to confirm no regression
curl -s -o /dev/null -w '%{http_code}' https://samograph.samo.team/
```

Expected: all return `200`; new host returns the real app, not a redirect to
the old host.

**6. Rollback if needed**

```bash
sudo rm /etc/caddy/sites.d/NN-<name>.caddy
caddy reload --config /etc/caddy/Caddyfile
```

### Caveats

- **Host-coupled features (magic links, email, BASE_URL) still point at the
  original host.** A Caddy route alone does not change what the app considers
  its canonical host. Making the new host canonical — updating `BASE_URL`,
  `MAIN_HOST`, `AppRecord.mainHost`, re-deploying, and retiring the old host
  — is a separate follow-up.

- **`systemctl reload caddy` is broken on this control plane** (226/NAMESPACE
  error). Use `caddy reload` via the admin API. The sites.d file persists
  across full restarts. Track the fix separately.

### Worked example — field-record.samo.team (2026-07-20)

App repo audit: field-record uses plain session cookies with no `Domain`
attribute and path-relative redirects — host-agnostic at the app layer.

VM Caddy probe: `curl -H "Host: field-record.samo.team" http://178.105.246.151/`
returned `308`; `curl -H "Host: field-record-1.samo.team" ...` returned `200`.
VM Caddy is host-locked to `field-record-1.samo.team`.

File added:

```
/etc/caddy/sites.d/15-field-record-second-host.caddy
```

```caddy
field-record.samo.team {
    tls internal
    reverse_proxy 178.105.246.151:80 {
        header_up Host field-record-1.samo.team
        header_up X-Real-IP {remote_host}
    }
    log {
        output file /var/log/caddy/field-record.samo.team.log
        format json
    }
}
```

Result: `field-record.samo.team` serves the live app; `field-record-1.samo.team`
kept live; no other clients affected.

---

## samohost vhost template caveat

Issue #121 (open 2026-07-06): the current `host-prep` vhost template generates
a single-upstream `:443` only. This is unusable for multi-service apps and
clobbers hand-authored `00-main-<app>.caddy` snippets. If your app needs
multiple upstreams (e.g. app on :3000 + API on :4000), write the Caddyfile
snippet manually and do not use the vhost template until #121 is resolved.
