/**
 * src/edge/banner.ts — SINGLE source of truth for the platform preview banner.
 *
 * Threat model:
 *   Previously each client app rendered its own preview banner from app code.
 *   This let app engineers accidentally restyle or delete the banner, and caused
 *   inconsistent appearance across products. By defining the banner here — at the
 *   platform layer — and injecting it at the Cloudflare edge (post-origin, before
 *   the byte stream reaches the browser), neither the origin app code nor any app
 *   engineer can prevent the banner from appearing on preview hostnames.
 *
 *   Honest caveat: app JavaScript that runs AFTER page load could still call
 *   document.getElementById('samo-preview-banner').remove(). This is strictly
 *   better than app-side banners (which the app fully controls and can delete from
 *   source), because: (a) the banner IS present in the initial HTML parse and paint,
 *   (b) the fixed overlay does not reflow content so there is no layout incentive to
 *   remove it, and (c) deliberate removal would require a targeted effort versus
 *   accidental omission.
 *
 * The platform banner identity:
 *   Dark slate (#1f2933) background, white text. This is intentionally distinct from
 *   any app color scheme (not gold, not amber, not any product's brand color).
 *   Fixed overlay: position:fixed; top:0; left:0; right:0; z-index:2147483647.
 *   pointer-events:none so it never intercepts user clicks even on touchscreens.
 *   Height ~28px so it is visible but not disruptive.
 *   No body margin/padding offset is applied — the fixed overlay does NOT reflow
 *   content, which avoids per-app layout breakage across diverse client apps.
 */

/** CSS scoped under #samo-preview-banner — cannot collide with app CSS. */
export const PREVIEW_BANNER_STYLE: string = `
#samo-preview-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2147483647;
  pointer-events: none;
  background: #1f2933;
  color: #ffffff;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: center;
  line-height: 28px;
  height: 28px;
  overflow: hidden;
  white-space: nowrap;
  box-sizing: border-box;
  border-bottom: 1px solid #3d5166;
}
`.trim();

/**
 * Escapes HTML special characters in a string so it is safe to embed in HTML
 * attribute values and text nodes.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returns the complete banner markup for the given label.
 *
 * The label is the subdomain portion of the preview hostname (e.g.
 * "field-record-demo-red-login" from "field-record-demo-red-login.samo.cat").
 * We do NOT call /api/version or read any app config to derive the label —
 * that would re-introduce app coupling that this Worker is specifically designed
 * to eliminate.
 *
 * If label is empty, falls back to the string "preview".
 *
 * The <style> block is injected here rather than as an inline style attribute
 * because CSP rules of the form `style-src 'self'` would block inline style
 * attributes but permit a <style> element already present in the HTML. This
 * makes the banner compatible with stricter CSP policies used by client apps.
 */
export function previewBannerHtml(branch: string): string {
  const label = branch.trim() === "" ? "preview" : escapeHtml(branch);
  const text = `PREVIEW — ${label}`;

  return (
    `<style>${PREVIEW_BANNER_STYLE}</style>` +
    `<div id="samo-preview-banner" data-samo-preview-banner="1" role="status">${text}</div>`
  );
}
