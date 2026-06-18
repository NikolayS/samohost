/**
 * RED-first test suite for the edge preview banner worker.
 *
 * Threat model (from brief):
 *   Today each client app renders its own preview banner from app code.
 *   The owner directive: the banner must be DEFINED ONCE in the platform and
 *   injected at a layer the app cannot alter/remove. This Worker runs at the
 *   Cloudflare edge AFTER the origin responds — neither app code nor the origin
 *   VM can strip or restyle the injected banner.
 *
 * These tests exercise the pure, bun-testable API:
 *   - isPreviewHost(hostname)    — routing guard
 *   - injectBanner(html, label)  — canonical string transform
 *   - handleEdgeRequest(req, res) — end-to-end Worker logic
 *
 * HTMLRewriter streaming is used in the CF runtime but is not tested here
 * (no Miniflare available in bun:test). The pure injectBanner function is the
 * tested canonical transform; the runtime Worker MUST call the same
 * previewBannerHtml/PREVIEW_BANNER_STYLE so both paths are byte-identical for
 * any given label.
 */

import { describe, test, expect } from "bun:test";
import { isPreviewHost } from "../src/edge/worker.ts";
import { injectBanner } from "../src/edge/worker.ts";
import { handleEdgeRequest } from "../src/edge/worker.ts";
import { PREVIEW_BANNER_STYLE, previewBannerHtml } from "../src/edge/banner.ts";

// ---------------------------------------------------------------------------
// isPreviewHost
// ---------------------------------------------------------------------------

describe("isPreviewHost", () => {
  test("returns true for a subdomain of samo.cat", () => {
    expect(isPreviewHost("field-record-demo-red-login.samo.cat")).toBe(true);
  });

  test("returns true for a single-label subdomain of samo.cat", () => {
    expect(isPreviewHost("x.samo.cat")).toBe(true);
  });

  test("returns false for the samo.cat apex (no subdomain)", () => {
    expect(isPreviewHost("samo.cat")).toBe(false);
  });

  test("returns false for a prod host on samo.team zone", () => {
    expect(isPreviewHost("field-record-1.samo.team")).toBe(false);
  });

  test("returns false for a subdomain-injection attack (samo.cat.attacker.com)", () => {
    expect(isPreviewHost("evil.samo.cat.attacker.com")).toBe(false);
  });

  test("returns false for samo.green", () => {
    expect(isPreviewHost("samo.green")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectBanner — canonical string transform
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Test Page</title>
</head>
<body>
<h1>Hello World</h1>
<p>Some content</p>
</body>
</html>`;

describe("injectBanner", () => {
  test("injects exactly one banner element", () => {
    const result = injectBanner(SAMPLE_HTML, "field-record-demo");
    const matches = result.match(/id="samo-preview-banner"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  test("injects the <style> block with scoped id into <head>", () => {
    const result = injectBanner(SAMPLE_HTML, "field-record-demo");
    expect(result).toContain("#samo-preview-banner");
    // Style must appear before </head>
    const styleIdx = result.indexOf("<style");
    const headCloseIdx = result.indexOf("</head>");
    expect(styleIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(headCloseIdx);
  });

  test("banner div is positioned right after <body>", () => {
    const result = injectBanner(SAMPLE_HTML, "field-record-demo");
    const bodyOpenIdx = result.indexOf("<body");
    const bodyTagEnd = result.indexOf(">", bodyOpenIdx);
    const bannerIdx = result.indexOf('<div id="samo-preview-banner"', bodyTagEnd);
    // Banner should appear immediately (within a few chars) after the <body> tag close
    expect(bannerIdx).toBeGreaterThan(bodyTagEnd);
    // There should be no other content (only optional whitespace) between body and banner
    const between = result.slice(bodyTagEnd + 1, bannerIdx).trim();
    expect(between).toBe("");
  });

  test("includes the label text in the banner", () => {
    const result = injectBanner(SAMPLE_HTML, "field-record-demo");
    expect(result).toContain("field-record-demo");
    // Should appear as PREVIEW — <label>
    expect(result).toContain("PREVIEW");
  });

  test("HTML-escapes dangerous characters in the label", () => {
    const result = injectBanner(SAMPLE_HTML, "<script>evil</script>");
    // The literal < must NOT appear inside the banner text unescaped
    // Find the banner div and check its text
    const bannerStart = result.indexOf('<div id="samo-preview-banner"');
    const bannerEnd = result.indexOf("</div>", bannerStart);
    const bannerContent = result.slice(bannerStart, bannerEnd);
    expect(bannerContent).not.toContain("<script>");
    expect(bannerContent).toContain("&lt;");
  });

  test("preserves original body content after the banner", () => {
    const result = injectBanner(SAMPLE_HTML, "demo");
    expect(result).toContain("<h1>Hello World</h1>");
    expect(result).toContain("<p>Some content</p>");
  });

  test("PREVIEW_BANNER_STYLE is scoped to #samo-preview-banner", () => {
    expect(PREVIEW_BANNER_STYLE).toContain("#samo-preview-banner");
  });

  test("previewBannerHtml uses fallback 'preview' when label is empty", () => {
    const html = previewBannerHtml("");
    expect(html).toContain("PREVIEW");
    // Should not have a trailing '— ' with nothing after it
    expect(html).not.toMatch(/PREVIEW\s*—\s*</);
  });

  test("previewBannerHtml includes the data-samo-preview-banner attribute", () => {
    const html = previewBannerHtml("test-branch");
    expect(html).toContain('data-samo-preview-banner="1"');
  });

  test("previewBannerHtml includes role=status", () => {
    const html = previewBannerHtml("test-branch");
    expect(html).toContain('role="status"');
  });
});

// ---------------------------------------------------------------------------
// handleEdgeRequest — end-to-end Worker logic
// ---------------------------------------------------------------------------

function makeRequest(url: string): Request {
  return new Request(url);
}

function makeHtmlResponse(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).length),
      ...extraHeaders,
    },
  });
}

function makeJsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("handleEdgeRequest — end-to-end", () => {
  test("preview host + text/html + 200 => banner injected, status preserved", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/");
    const res = makeHtmlResponse(SAMPLE_HTML, 200);
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(result.status).toBe(200);
    expect(body).toContain('id="samo-preview-banner"');
  });

  test("preview host + text/html + 200 => content-length header removed", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/");
    const res = makeHtmlResponse(SAMPLE_HTML, 200);
    const result = await handleEdgeRequest(req, res);
    // content-length must be absent or updated — after injection the old value is wrong
    // Our impl removes it so it gets recomputed
    expect(result.headers.get("content-length")).toBeNull();
  });

  test("preview host + application/json + 200 => body unchanged (no banner)", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/api/version");
    const originalBody = JSON.stringify({ version: "1.0.0", env: "preview" });
    const res = makeJsonResponse(originalBody, 200);
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(body).toBe(originalBody);
    expect(body).not.toContain("samo-preview-banner");
  });

  test("preview host + text/html + 200 + Content-Encoding: gzip => pass-through unchanged", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/");
    const fakeGzipBody = "fake-compressed-bytes";
    const res = new Response(fakeGzipBody, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
      },
    });
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(body).toBe(fakeGzipBody);
    expect(body).not.toContain("samo-preview-banner");
  });

  test("preview host + text/html + 404 => unchanged, no banner", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/missing");
    const notFoundBody = "<html><body>Not Found</body></html>";
    const res = new Response(notFoundBody, {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(result.status).toBe(404);
    expect(body).toBe(notFoundBody);
    expect(body).not.toContain("samo-preview-banner");
  });

  test("prod host (samo.team) + text/html + 200 => unchanged, no banner (prod isolation)", async () => {
    // This mirrors the prod shape: field-record-1.samo.team is on the samo.team zone
    // and must NEVER receive the banner. The CF route only covers *.samo.cat so this
    // test proves the guard exists in the Worker logic layer as defense in depth.
    const req = makeRequest("https://field-record-1.samo.team/");
    const res = makeHtmlResponse(SAMPLE_HTML, 200);
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(body).not.toContain("samo-preview-banner");
    expect(body).toBe(SAMPLE_HTML);
  });

  test("banner label is derived from subdomain (subdomain label in content)", async () => {
    const req = makeRequest("https://field-record-demo-red-login.samo.cat/");
    const res = makeHtmlResponse(SAMPLE_HTML, 200);
    const result = await handleEdgeRequest(req, res);
    const body = await result.text();
    expect(body).toContain("field-record-demo-red-login");
  });

  test("banner markup is byte-identical (same previewBannerHtml) for two different preview hosts except the label", async () => {
    const req1 = makeRequest("https://env-alpha.samo.cat/");
    const req2 = makeRequest("https://env-beta.samo.cat/");
    const res1 = makeHtmlResponse(SAMPLE_HTML, 200);
    const res2 = makeHtmlResponse(SAMPLE_HTML, 200);
    const result1 = await handleEdgeRequest(req1, res1);
    const result2 = await handleEdgeRequest(req2, res2);
    const body1 = await result1.text();
    const body2 = await result2.text();
    // Both have the banner
    expect(body1).toContain('id="samo-preview-banner"');
    expect(body2).toContain('id="samo-preview-banner"');
    // The style block is identical (single source of truth: PREVIEW_BANNER_STYLE)
    expect(body1).toContain(PREVIEW_BANNER_STYLE);
    expect(body2).toContain(PREVIEW_BANNER_STYLE);
    // Only the labels differ
    expect(body1).toContain("env-alpha");
    expect(body2).toContain("env-beta");
    // After stripping label text, the structure (style + markup template) is the same
    const stripped1 = body1.replace("env-alpha", "LABEL");
    const stripped2 = body2.replace("env-beta", "LABEL");
    expect(stripped1).toBe(stripped2);
  });

  test("preview host + text/html + 301 redirect => unchanged, no banner", async () => {
    const req = makeRequest("https://field-record-demo.samo.cat/old-path");
    const res = new Response(null, {
      status: 301,
      headers: {
        "Content-Type": "text/html",
        Location: "https://field-record-demo.samo.cat/new-path",
      },
    });
    const result = await handleEdgeRequest(req, res);
    expect(result.status).toBe(301);
    expect(result.headers.get("location")).toBe("https://field-record-demo.samo.cat/new-path");
  });
});
