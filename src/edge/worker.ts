/**
 * src/edge/worker.ts — Cloudflare Worker: injects the platform preview banner
 * into HTML responses for *.samo.cat preview hostnames.
 *
 * Architecture decision — buffer + injectBanner (not HTMLRewriter):
 *   The implementation reads the origin response body as text (await res.text()),
 *   runs the pure injectBanner() transform, and returns a new Response.
 *   This makes the entire transform 100% unit-testable under bun:test without
 *   Miniflare, because HTMLRewriter is a CF Workers runtime global unavailable
 *   in bun. For the modest HTML sizes served by samo.cat preview environments
 *   this buffering is acceptable. A future optimization documented here:
 *   replace the buffered path with HTMLRewriter streaming for large documents:
 *     new HTMLRewriter()
 *       .on('head', { element: (el) => el.append(styleHtml, { html: true }) })
 *       .on('body', { element: (el) => el.prepend(bannerDiv, { html: true }) })
 *       .transform(originResponse)
 *   Both approaches share previewBannerHtml() and PREVIEW_BANNER_STYLE as the
 *   single source of truth, so the byte output is identical for any given label.
 *
 * Prod isolation:
 *   The CF route pattern *.samo.cat/* binds this Worker only to the samo.cat
 *   zone. Production hosts live on samo.team (a different zone) and are NEVER
 *   matched. The isPreviewHost() guard is a defense-in-depth check inside the
 *   Worker logic itself.
 *
 * Content-Encoding handling:
 *   HTMLRewriter cannot parse gzip/br/deflate-compressed bodies. Our approach:
 *   (a) The default fetch export strips Accept-Encoding from the forwarded
 *       request (Accept-Encoding: identity) so the origin always returns plain
 *       text to the Worker. Cloudflare re-compresses the response to the client.
 *   (b) handleEdgeRequest() additionally guards on Content-Encoding: if the
 *       origin somehow returns a compressed body (e.g. a pre-compressed static
 *       file served with explicit Content-Encoding header), we pass it through
 *       unchanged rather than corrupt it. Defense in depth.
 *
 * Label derivation:
 *   The banner text is PREVIEW — <subdomain-label> where subdomain-label is the
 *   part of the hostname before .samo.cat. We do NOT call /api/version or read
 *   app config — that would re-introduce the app coupling this Worker eliminates.
 *   The subdomain already encodes the environment identity (e.g.
 *   "field-record-demo-red-login.samo.cat" → label "field-record-demo-red-login").
 */

import { previewBannerHtml, PREVIEW_BANNER_STYLE } from "./banner.ts";

// Re-export PREVIEW_BANNER_STYLE so tests can import it from worker.ts
export { PREVIEW_BANNER_STYLE };

// ---------------------------------------------------------------------------
// isPreviewHost
// ---------------------------------------------------------------------------

/**
 * Returns true only for *.samo.cat subdomains (not the apex samo.cat itself).
 *
 * Accepts: field-record-demo-red-login.samo.cat, x.samo.cat
 * Rejects:
 *   samo.cat              — apex, no preview functionality
 *   field-record-1.samo.team — wrong zone (prod)
 *   evil.samo.cat.attacker.com — suffix-injection attack
 *   samo.green            — different product/zone
 */
export function isPreviewHost(hostname: string): boolean {
  // Must END with exactly ".samo.cat" and have at least one character before it.
  // The endsWith check plus the length guard prevents matching "samo.cat" apex.
  // It also rejects "evil.samo.cat.attacker.com" because that does NOT end in ".samo.cat".
  return hostname.endsWith(".samo.cat") && hostname.length > ".samo.cat".length;
}

// ---------------------------------------------------------------------------
// labelFromHostname
// ---------------------------------------------------------------------------

/**
 * Extracts the subdomain label from a preview hostname.
 * "field-record-demo-red-login.samo.cat" => "field-record-demo-red-login"
 * Falls back to empty string (previewBannerHtml will substitute "preview").
 */
function labelFromHostname(hostname: string): string {
  if (!isPreviewHost(hostname)) return "";
  // Strip trailing ".samo.cat"
  return hostname.slice(0, hostname.length - ".samo.cat".length);
}

// ---------------------------------------------------------------------------
// injectBanner — pure string transform (canonical, fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * Injects the platform preview banner into an HTML string.
 *
 * Transform:
 *   1. Appends <style>PREVIEW_BANNER_STYLE</style> just before </head>.
 *      If <head> is absent (malformed HTML), the style is prepended to the body
 *      injection point below.
 *   2. Prepends the banner <div> immediately after the opening <body> tag.
 *
 * The label is the subdomain portion of the preview hostname. It is HTML-escaped
 * inside previewBannerHtml().
 *
 * This function is the TESTED, CANONICAL transform. The CF runtime uses the same
 * previewBannerHtml() + PREVIEW_BANNER_STYLE so both paths produce byte-identical
 * output for any given label.
 */
export function injectBanner(html: string, label: string): string {
  const banner = previewBannerHtml(label);

  // Split into <style>...</style> and <div>...</div> parts.
  // previewBannerHtml returns "<style>...</style><div ...>...</div>"
  // We need to inject the style into <head> and the div into <body>.
  const styleEnd = banner.indexOf("</style>") + "</style>".length;
  const stylePart = banner.slice(0, styleEnd);
  const divPart = banner.slice(styleEnd);

  let result = html;

  // Step 1: inject <style> before </head>
  const headCloseIdx = result.indexOf("</head>");
  if (headCloseIdx !== -1) {
    result =
      result.slice(0, headCloseIdx) +
      stylePart +
      result.slice(headCloseIdx);
  }
  // If <head> is absent, we'll inject the style along with the div in step 2.

  // Step 2: inject banner div immediately after <body ...>
  const bodyOpenIdx = result.indexOf("<body");
  if (bodyOpenIdx !== -1) {
    const bodyTagEnd = result.indexOf(">", bodyOpenIdx);
    if (bodyTagEnd !== -1) {
      const inject = headCloseIdx !== -1 ? divPart : (stylePart + divPart);
      result =
        result.slice(0, bodyTagEnd + 1) +
        inject +
        result.slice(bodyTagEnd + 1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleEdgeRequest — pure, testable Worker logic
// ---------------------------------------------------------------------------

/**
 * Core Worker logic. Accepts the original request and the origin response;
 * returns a (potentially modified) Response.
 *
 * Guards (in order):
 *   a. Hostname must be a preview host (*.samo.cat, not apex).
 *   b. Response must be 2xx (status 200–299).
 *   c. Content-Type must start with "text/html".
 *   d. Content-Encoding must be absent (defense-in-depth; origin should not
 *      return compressed bodies because the default fetch export requests
 *      Accept-Encoding: identity, but we guard here anyway).
 *
 * If any guard fails, originResponse is returned unchanged.
 *
 * When all guards pass:
 *   - Reads the body as text.
 *   - Runs injectBanner(html, label).
 *   - Returns a new Response with modified body, all original headers copied,
 *     and Content-Length removed (it is now incorrect after injection; the CF
 *     runtime or browser will handle transfer without it).
 */
export async function handleEdgeRequest(
  request: Request,
  originResponse: Response
): Promise<Response> {
  const hostname = new URL(request.url).hostname;

  // Guard a: preview host only
  if (!isPreviewHost(hostname)) {
    return originResponse;
  }

  // Guard b: 2xx only
  const status = originResponse.status;
  if (status < 200 || status > 299) {
    return originResponse;
  }

  // Guard c: text/html only
  const contentType = originResponse.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("text/html")) {
    return originResponse;
  }

  // Guard d: no Content-Encoding (compressed body cannot be parsed)
  if (originResponse.headers.get("Content-Encoding")) {
    return originResponse;
  }

  // All guards passed — read and transform
  const html = await originResponse.text();
  const label = labelFromHostname(hostname);
  const injected = injectBanner(html, label);

  // Copy all headers, remove Content-Length (now incorrect after injection)
  const newHeaders = new Headers(originResponse.headers);
  newHeaders.delete("content-length");

  return new Response(injected, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: newHeaders,
  });
}

// ---------------------------------------------------------------------------
// Default export — the CF Workers fetch handler
// ---------------------------------------------------------------------------

/**
 * The Cloudflare Workers fetch handler deployed via wrangler.
 *
 * Before fetching the origin, the request is rewritten to include
 * Accept-Encoding: identity. This ensures the origin returns uncompressed HTML
 * that our text() buffer can read. Cloudflare automatically re-compresses the
 * final response to the client (gzip/brotli negotiated at the CF<->client layer).
 *
 * We use globalThis.fetch rather than a typed ExportedHandler to avoid
 * requiring @cloudflare/workers-types in the testable modules. The wrangler
 * deploy target picks this up as the Workers entry point.
 */
const workerFetch = async (request: Request): Promise<Response> => {
  // Rewrite Accept-Encoding so origin returns uncompressed HTML.
  // Only needed for preview hosts, but it's harmless for all requests and
  // avoids the overhead of a hostname check before the origin fetch.
  const originRequest = new Request(request, {
    headers: (() => {
      const h = new Headers(request.headers);
      h.set("Accept-Encoding", "identity");
      return h;
    })(),
  });

  const originResponse = await fetch(originRequest);
  return handleEdgeRequest(request, originResponse);
};

export default { fetch: workerFetch };
