# Preview DNS: target vs. authority — the samo.cat mismatch

Status: BLOCKING for preview serving (discovered 2026-06-11; verified by
manager via public DNS). `samohost dns status samo.cat --expect-ip <vm-ip>`
reproduces this report at any time, read-only.

## The mismatch

The SOLO plan (Tanya301/field-record-1#117) serves previews at

```
<app>-<branch-label>.samo.cat        e.g. field-record-1-feat-x.samo.cat
```

but, as verified live:

- `samo.team` is on **Cloudflare** (derek/jade nameservers) — production
  `field-record-1.samo.team` works and could be automated.
- `samo.cat` is on **Namecheap registrar nameservers**
  (`registrar-servers.com`) — NOT Cloudflare.
- A random `*.samo.cat` label does **not resolve**: there is no wildcard, so
  today every preview vhost would be unreachable regardless of what the VM
  serves.
- The existing infra Cloudflare tooling and `CLOUDFLARE_API_TOKEN` cover
  `samo.team` + `samo.green` only. Even if `samo.cat` moved to Cloudflare,
  the current token could not manage it.

Two distinct readiness questions follow (and `dns status` reports them
separately):

- **serving_ready** — does `*.samo.cat` resolve to the VM? (What previews
  actually need.)
- **automation_ready** — could samohost manage records via an API? (Only
  needed if we want per-env or automated DNS changes.)

## Paths to unblock (pick one)

### Option 1 — manual wildcard at Namecheap (fastest, recommended for now)

One-time, in the Namecheap DNS panel: add `A` record, host `*`, value
`<VM IP>` (production VM: `178.105.246.151`). No API, no token, no NS move.
Caddy then issues per-vhost certificates via HTTP-01 as envs appear.
serving_ready becomes true; automation stays unavailable (and is not needed —
the wildcard covers every branch forever).

### Option 2 — move samo.cat NS to Cloudflare

Add the zone in Cloudflare, switch nameservers at Namecheap, then mint a
**zone-scoped token for samo.cat** (the existing samo.team/samo.green token
must not be widened). samohost's Cloudflare adapter (`src/dns/cloudflare.ts`,
implemented and unit-tested, no live callers yet) can then ensure the wildcard
programmatically. Choose this if samo.cat will need more DNS automation than
one wildcard.

### Option 3 — Namecheap provider in samohost

The DNS provider port (`DnsProviderPort`) is deliberately narrow so a
Namecheap adapter can slot in. Namecheap's API, however, requires account API
enablement plus a source-IP allowlist, and replaces the WHOLE host list per
call (read-modify-write hazards). Not worth it for one wildcard record; only
revisit if samo.cat must stay on Namecheap AND needs ongoing automation.

### Non-option — switch previews to samo.team

`*.samo.team` automation is already possible (Cloudflare + existing token),
but #117 explicitly names samo.cat for previews and samo.team carries
production traffic; mixing throwaway preview hostnames into the production
zone is a decision for the owner, not a default. Listed for completeness.

## Decision needed from the owner

Option 1 unless ongoing samo.cat automation is anticipated. After the wildcard
exists, `samohost dns status samo.cat --expect-ip 178.105.246.151` must report
`serving_ready: true`; that command is the acceptance check.
