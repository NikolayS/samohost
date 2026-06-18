# Preview reachability — CF-proxied origin + origin TLS

This is the concrete decision a bot must make **before the first preview**
(whether created manually with `env create` or automatically by `trigger run
--pr-previews`), plus how samohost's external reachability gate behaves. Getting the origin-TLS
decision wrong is the failure that broke the first field-record previews:
on-host phases pass, but the public preview URL never returns 200.

## The topology

```
browser ──TLS──▶ Cloudflare edge (orange cloud, *.samo.cat) ──TLS──▶ origin Caddy on the VM
```

Every `*.samo.cat` preview host is a **proxied** (orange-cloud) Cloudflare
record pointing at the VM IP. This is required for the edge preview banner
Worker to run (`docs/edge-preview-banner.md`) and it means **TLS terminates at
the Cloudflare edge, then a second TLS hop runs CF → origin.**

## The decision: Cloudflare SSL/TLS mode + origin TLS must agree

Pick one and apply it on the `samo.cat` zone in the Cloudflare dashboard
(SSL/TLS → Overview) **before** creating any preview env:

- **Full** mode + origin Caddy `tls internal` (self-signed) — what the
  preview banner doc and the live setup assume. CF accepts the origin's
  self-signed cert without validating the chain. This is the documented,
  working combination for `*.samo.cat` previews.
- **Full (strict)** mode requires a CF-trusted origin certificate (CF Origin CA
  cert or a real LE cert) on Caddy. `tls internal` will fail the CF→origin hop
  under strict, producing edge **526** errors. Only choose strict if you also
  install a trusted origin cert.
- **Flexible** mode (CF→origin over plain HTTP) is **wrong** here — the origin
  Caddy redirects HTTP→HTTPS, causing a redirect loop. Do not use it.

If the mode and the origin cert disagree, the on-host health phase still passes
(it probes Caddy locally) but the external probe fails — see below. The fix is
to align the CF mode with the origin TLS, **not** to bypass the gate.

## samohost's external reachability gate (issue #55)

`env create` does not trust the on-host health check alone. The on-host phase
curls Caddy's **local** listener (`--resolve <vhost>:443:127.0.0.1`, SNI = the
vhost so Caddy selects the right cert), which proves the site serves locally but
says nothing about the public path. After a successful on-host create, samohost
runs an **external HTTPS probe against the real public URL**
`https://<app>-<branch>.samo.cat/`:

- Uses **system `curl`** with the OS CA bundle, **not** Bun's `fetch`. Bun's
  fetch mis-verifies the Cloudflare edge chain and falsely returns a TLS error
  where system curl gets a clean 200 (issue #58). Do not "fix" this back to
  fetch.
- Only an HTTP **200** counts as reachable. No redirect following
  (`-L` is deliberately absent) — a 301/302 is a failure, surfacing the
  Flexible-mode redirect loop instead of hiding it.
- Retries up to `EXTERNAL_PROBE_RETRIES` (8) attempts with a 5s sleep between
  them — worst case ~40s. This window exists specifically to absorb
  **Cloudflare edge cert provisioning lag** on a brand-new proxied hostname:
  the first probe(s) commonly fail with an edge TLS/`525`/`522` while CF mints
  the edge cert, then succeed. This is the "first-probe-retry" behavior — a
  single early failure is **not** terminal.
- If all attempts fail, the env outcome is downgraded to `failed`, exit 1, and
  the error names the public URL and last status. **The env record and the DNS
  record are kept** so a re-run is idempotent and a `destroy` can clean up.

### Static sites

For an app registered with `kind = "static"` there is no service on the
allocated port, so the on-host health phase curls Caddy's local HTTPS listener
for the static `file_server` vhost (same `--resolve` SNI technique). The same
external 200 gate then applies to the public URL. The first external probe may
need the retry window for the same CF edge-cert reason.

## DNS prerequisite

`env create` ensures the per-preview A record **before** pushing the create
script (so Caddy's first ACME/HTTP-01 attempt can resolve). For that it needs
`CLOUDFLARE_SAMOCAT` (zone-scoped to `samo.cat`). Without it, samohost prints a
degrade warning and relies on a pre-existing `*.samo.cat` **wildcard** A record
— so either set the token **or** create the wildcard manually. Verify with:

```bash
CLOUDFLARE_API_TOKEN=… bun run src/cli.ts dns status samo.cat \
  --expect-ip <vm-ip> --cf-zone samo.cat
```

For a **proxied** wildcard, public DNS returns Cloudflare **edge** IPs by
design (104.21.x / 172.67.x), never the origin. `dns status` knows this: with a
token + zone coverage it verifies the record's origin target at the Cloudflare
API (`wildcard_source: cloudflare-api`, `proxied: true`) rather than comparing
public A results to the origin IP. Without API access on a CF zone, a non-origin
IP reports `unknown` (never a false `mismatch`). See
`docs/dns-preview-authority.md` for the full authority analysis.
