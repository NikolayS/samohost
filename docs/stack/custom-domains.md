# Custom domains — Cloudflare-for-SaaS runbook

Lets a client's own FQDN (e.g. `www.acme.com`) route to their samohost app.
The mechanism is Cloudflare Custom Hostnames (CF-for-SaaS): Cloudflare issues a
cert for the client's domain and routes traffic to our control plane, which
forwards it to the correct project VM.

---

## Prerequisites

### Operator (one-time per control plane)

| Item | Detail |
|------|--------|
| `CLOUDFLARE_SAMOTEAM` env var | CF API token, zone-scoped to `samo.team`, scope: `SSL and Certificates:Edit`. **This is NOT `CLOUDFLARE_SAMOCAT` and NOT `CLOUDFLARE_API_TOKEN`** — do not substitute. Source: `src/commands/domain.ts:defaultDomainDeps`. |
| CF-for-SaaS entitlement | The `samo.team` zone must have the SaaS entitlement enabled (contact Cloudflare support; the token alone is not sufficient without it). Already enabled as of 2026-07-05 — proven by `www.samorev.xyz`. |
| `SAMOHOST_SAAS_ZONE_ID` | Optional. If the token has no `Zone:Read` scope, set this to the `samo.team` zone ID to skip the zones:list lookup. If unset, `SAMOHOST_SAAS_ZONE` (default: `samo.team`) is used to resolve it. Source: `src/commands/domain.ts:864-865`. |
| `SAMOHOST_CUSTOM_HOSTNAME_TARGET` | Optional. CNAME target printed in DNS instructions (default: `cname.samo.team`). Override only in non-standard deployments. Source: `src/commands/domain.ts:292`. |
| `cname.samo.team` resolves to control plane | The CF-for-SaaS fallback origin. Must point at `91.99.233.145`. Verify: `dig cname.samo.team`. |
| App registered in samohost state | Run `samohost app list` to confirm. Static apps additionally need a health-proven active release before `domain add` will succeed. |
| CLI runs ON the control plane | `domain add` writes a Caddy snippet locally via `bash -s`. It must run on `91.99.233.145`, not a laptop. |

---

## Commands

```
samohost domain search <fqdn>                   # RDAP availability check (no creds)
samohost domain add    <app> <fqdn> [--dcv txt|http]
samohost domain check  <fqdn>
samohost domain list   [--app <name>]
samohost domain rm     <fqdn> --yes
```

All commands accept `--json` for machine-readable output.

---

## What `domain add` does

Source: `src/commands/domain.ts:runDomainAdd`, `src/env/script.ts:2742,2960`.

1. Resolves the app name → VM from `~/.samohost/` state. Errors if 0 or >1
   apps match.
2. Validates the FQDN (lowercase dotted DNS name; rejects bare labels).
3. Calls the Cloudflare API (`POST /zones/<samo.team>/custom_hostnames`) to
   create a CF-for-SaaS Custom Hostname with a DV cert. DCV method defaults to
   `txt` (recommended); `--dcv http` is available but stalls on an HTTPS-only
   control plane.
4. Pushes a Caddy vhost snippet to the **app VM** over SSH (`bash -s`).
   Node/Bun apps: `http://<fqdn> { reverse_proxy localhost:<port> }`.
   Static apps: requires a verified active release; the snippet serves from the
   active release directory.
5. Writes a Caddy routing snippet **locally on the control plane**
   (`/etc/caddy/sites.d/10-domain-<label>.caddy`):
   ```
   <fqdn> {
       tls internal
       reverse_proxy <vmIp>:80 {
           header_up Host <httpHost>
           header_up X-Real-IP {remote_host}
       }
       header { X-Content-Type-Options nosniff }
   }
   ```
   Reloads Caddy. Without this step the domain goes CF-active but returns a CF
   error page because the control plane has no route for it.
6. Persists a `DomainRecord` to `~/.samohost/domains.json`.
7. Prints the DNS instructions the client must configure.

---

## Customer DNS — three records

All three must be set before the domain goes live. `domain add` prints them.

| # | Type | Host | Value |
|---|------|------|-------|
| 1 | CNAME | `<fqdn>` (e.g. `www.acme.com`) | `cname.samo.team` |
| 2 | CNAME | `_acme-challenge.<fqdn>` | `<hash>.dcv.cloudflare.com` (from `dcv_delegation_records` in CF response — printed by `domain add`) |
| 3 | TXT | printed by CF as `ownership_verification.name` | `ownership_verification.value` (printed by `domain add`) |

Record 2 lets Cloudflare complete ACME DCV via DNS delegation.
Record 3 proves domain ownership to Cloudflare.

Both records 2 and 3 are printed by `domain add` from the CF API response.
If the output scrolled past, re-run `domain check <fqdn>` while it is still
pending — it reprints the instructions.

---

## Verify the domain is live

```bash
# Poll until both hostname_status and ssl_status are "active".
# Exit 0 = active; exit 1 = still pending.
samohost domain check www.acme.com

# Machine-readable:
samohost domain check www.acme.com --json
```

Expected final state:

```
fqdn:             www.acme.com
hostname_status:  active
ssl_status:       active
cname_resolved:   yes (→ cname.samo.team)
active:           yes
```

---

## Worked example — www.samorev.xyz (PR #114, live 2026-07-05)

```bash
# 1. Add the custom domain (run on the control plane)
samohost domain add samorev www.samorev.xyz

# Output included:
#   Type: CNAME   Host: www.samorev.xyz   Value: cname.samo.team
#   DCV CNAME: _acme-challenge.www.samorev.xyz  →  <hash>.dcv.cloudflare.com
#   Ownership TXT: ...

# 2. Customer set: CNAME www.samorev.xyz → cname.samo.team
#    + the DCV CNAME and ownership TXT from the output above.

# 3. Poll until active
samohost domain check www.samorev.xyz
```

---

## Gotchas

**Use a subdomain, not a bare apex.**
Apex domains (`acme.com`) cannot CNAME — most registrars flatten or reject
CNAME at the root. The `www.samorev.xyz` apex attempt failed for this reason.
Always register `www.<domain>` or another subdomain. If the client's registrar
does not support ALIAS/ANAME at the apex, move DNS to Cloudflare.

**Cloudflare DNS must be grey-cloud (DNS-only).**
If the client's DNS is managed by Cloudflare, the CNAME record for the custom
domain must have the proxy toggle **OFF** (grey cloud). An orange-cloud CNAME
intercepts the CF-for-SaaS flow.

**CF validation can go stale with no CLI recovery.**
There is no `domain recheck` command. If the CF custom hostname status stalls
in a permanent pending/error state after the customer's DNS is correct, a
manual PATCH to the CF API is needed (`PATCH /zones/<zone>/custom_hostnames/<id>`
with `{"ssl":{"method":"txt"}}`). This was the case during the samorev.xyz
onboarding. Filed as a known gap.

**CF-active + error page = missing control-plane vhost.**
If `domain check` shows `active` but the browser returns a Cloudflare error
page (not your app), the control-plane Caddy snippet is missing. Re-run
`domain add` (it is idempotent) or check
`/etc/caddy/sites.d/10-domain-<label>.caddy` on the control plane manually.

**Token degrade mode.**
If `CLOUDFLARE_SAMOTEAM` is not set, `domain add` warns and skips the CF step
but still writes the Caddy vhosts and state record. The domain will not be
reachable until the token is added and `domain add` is re-run.

**Static apps need an active release.**
For static-file apps, `domain add` refuses to write the app-VM vhost unless a
health-proven active release is present. Run `samohost app deploy` first.

---

## Remove a custom domain

```bash
samohost domain rm www.acme.com --yes
```

Deletes the CF Custom Hostname, removes both Caddy snippets (app VM + control
plane), and drops the state record. Non-fatal if VM is unreachable — state is
still cleaned up.

---

## Runtime routing chain

```
Client browser
  → Cloudflare edge (CF-for-SaaS cert for www.acme.com)
  → control-plane Caddy :443  (tls internal, CF Full mode)
      matches the sites.d/10-domain-www-acme-com.caddy block
  → app VM :80  (Host: <app.mainHost or fqdn>)
  → app Caddy vhost
  → localhost:<port>  (Node/Bun process) or file_server (static)
```

The `tls internal` on the control plane is correct: Cloudflare terminates the
client TLS (CF Full mode), so the control-plane cert does not need to be
publicly trusted.
