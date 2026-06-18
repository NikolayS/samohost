# Edge Preview Banner

## What it does

A Cloudflare Worker (`samohost-preview-banner`) runs on every `*.samo.cat` request
and injects a platform-defined preview banner into HTML responses at the edge,
AFTER the origin Caddy server has responded and BEFORE the byte stream reaches the
browser.

The banner text is `PREVIEW — <subdomain>` where `<subdomain>` is the part of the
preview hostname before `.samo.cat` (e.g. `field-record-demo-red-login` from
`field-record-demo-red-login.samo.cat`).

## Why it exists — threat model

Previously each client app rendered its own preview banner from app code:
- `field-record` read `/api/version` env in `product-practices.js`
- `game-changers` read `window.__GC1_CONFIG__`

This caused different colors, different markup per client, and meant any app
engineer could accidentally restyle or delete the banner. The owner directive:
**the banner must be defined once in the platform and injected at a layer the app
cannot alter or remove.**

## Why it is untamperable

Cloudflare proxies every `*.samo.cat` preview host (orange cloud, Full mode,
origin Caddy `tls internal`). The Worker runs at the edge after the origin
responds. Neither the origin application code nor the origin VM can strip or
restyle the injected banner — the banner bytes are inserted into the HTTP response
stream by Cloudflare before the response arrives at the user's browser.

### Honest caveat

App JavaScript that runs **after** page load could still call
`document.getElementById('samo-preview-banner').remove()`. This is strictly better
than app-side banners (which the app fully controls at source) because:

1. The banner **is** present in the initial HTML parse and first paint.
2. The `position:fixed; pointer-events:none` overlay does not reflow content, so
   there is no layout incentive to remove it.
3. Deliberate removal requires a targeted, intentional effort rather than
   accidental omission.

## Production isolation

Production hosts live on the `samo.team` zone, which is a **different Cloudflare
zone** from `samo.cat`. The CF route pattern `*samo.cat/*` only matches the
`samo.cat` zone. Prod hosts (`field-record-1.samo.team`, etc.) are **never**
matched and never receive the banner. The `isPreviewHost()` guard inside the
Worker logic provides a second layer of defense.

## Implementation notes

### Buffer + injectBanner (not HTMLRewriter streaming)

The Worker reads the origin response as text (`await res.text()`), runs the pure
`injectBanner(html, label)` function, and returns a new `Response`. This makes the
entire transform 100% unit-testable under `bun test` without Miniflare. For the
modest HTML sizes of samo.cat preview environments this buffering is acceptable.

A future optimization: replace the buffered path with `HTMLRewriter` streaming:
```ts
new HTMLRewriter()
  .on('head', { element: (el) => el.append(styleHtml, { html: true }) })
  .on('body', { element: (el) => el.prepend(bannerDiv, { html: true }) })
  .transform(originResponse)
```
Both approaches share `previewBannerHtml()` and `PREVIEW_BANNER_STYLE` from
`src/edge/banner.ts` as the single source of truth, so the injected bytes are
identical for any given label.

### Content-Encoding handling

`HTMLRewriter` and `text()` cannot parse compressed bodies. Two defenses:

1. The `fetch` handler strips `Accept-Encoding` from the request sent to the
   origin (`Accept-Encoding: identity`), so the origin returns uncompressed HTML.
   Cloudflare re-compresses the response to the client at the CF↔client layer.
2. `handleEdgeRequest()` additionally checks for `Content-Encoding` on the origin
   response and passes through unchanged if present, rather than corrupting a
   compressed body. Defense in depth.

### Label derivation

The subdomain is used as-is as the environment identifier. We do NOT call
`/api/version` or read `config.js` — that would re-introduce the app coupling
this Worker is specifically designed to eliminate.

## Deploy

### Token permissions required

The active `CLOUDFLARE_SAMOCAT` token is DNS-only and **cannot deploy this Worker**
(CF error 10000 on Workers endpoints). A new token is needed with:

- **Account > Workers Scripts: Edit** — on the account owning `samo.cat`
- **Zone > Workers Routes: Edit** — scoped to zone `samo.cat`

### Deploy command

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<token-with-workers-edit> \
  bunx wrangler deploy
```

Both env vars are supplied at deploy time. They are **never committed** to this
repository (the repo is public).

## Files

| Path | Purpose |
|---|---|
| `src/edge/banner.ts` | Single source of truth: `PREVIEW_BANNER_STYLE`, `previewBannerHtml()` |
| `src/edge/worker.ts` | Worker logic: `isPreviewHost()`, `injectBanner()`, `handleEdgeRequest()`, default fetch export |
| `wrangler.toml` | Wrangler deploy manifest (no secrets) |
| `test/edge-banner.test.ts` | Full test suite (RED→GREEN TDD) |
