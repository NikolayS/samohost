/**
 * Per-app favicon letter-mark generator and Caddy vhost snippet helpers.
 *
 * Serves a neutral per-app SVG letter-mark as a FALLBACK when the app's own
 * /favicon.ico is absent. The fallback is injected into samohost-generated
 * Caddy vhost blocks at deploy/heal time — no per-repo chore, no paid APIs.
 *
 * Design constraints (all enforced by tests):
 *   - letter  = appName[0].toUpperCase()
 *   - fill    = deterministic hue from a stable djb2 hash of appName
 *   - NO #4263eb (samo.team platform indigo)
 *   - NO #0c7f4d (samo.team landing green)
 *   - NO backticks or $ in SVG output (unquoted bash heredoc safety)
 *   - Single-quoted SVG attributes (valid XML; safe in any heredoc context)
 *   - 32×32 viewBox, rounded rectangle (rx=6), white bold letter centered
 *
 * Caddy vhost integration:
 *   faviconVhostLinesStatic(staticDirVar, appName) — for file_server apps
 *     Caddy file matcher checks the app's own /favicon.ico first;
 *     falls back to inline SVG respond only when the file is absent.
 *
 *   faviconVhostLinesNode(appName) — for reverse_proxy apps
 *     Returns a handle block for favicon paths; the caller is responsible
 *     for placing it BEFORE the catch-all handle in renderVhost.
 *     For node apps we serve the letter-mark directly without 404-detection
 *     because adding handle_errors around individual routes in Caddy requires
 *     an extra layer that complicates the vhost structure significantly.
 *     Apps that ship their OWN /favicon.ico (served by the Node process) will
 *     return 200 from the upstream — the handle block here runs FIRST so we
 *     need a different approach: the node favicon handle should proxy the
 *     upstream first and only serve the letter-mark as a respond on 404.
 *     Implementation: use a `handle` + `reverse_proxy` first; for the
 *     letter-mark fallback we use a `handle_errors` scoped to the favicon
 *     handle. This is done via Caddy's `handle_errors` directive within the
 *     handle block + `expression {http.error.status_code} == 404`.
 */

// ---------------------------------------------------------------------------
// Color palette — deterministic, excludes SAMO brand colors
// ---------------------------------------------------------------------------

/**
 * Simple djb2-style hash → a hue (0–359) for the letter-mark fill.
 * The hash is stable: same input always produces the same hue.
 */
function stableHue(appName: string): number {
  let h = 5381;
  for (let i = 0; i < appName.length; i++) {
    h = ((h << 5) + h + appName.charCodeAt(i)) & 0x7fffffff;
  }
  // Map to 0–359 degrees
  const hue = h % 360;
  // Avoid the ranges occupied by SAMO brand colors:
  //   #4263eb ≈ hsl(229°)  → dodge 220–240
  //   #0c7f4d ≈ hsl(152°)  → dodge 145–160
  if (hue >= 220 && hue <= 240) {
    return (hue + 50) % 360;
  }
  if (hue >= 145 && hue <= 160) {
    return (hue + 40) % 360;
  }
  return hue;
}

/**
 * Convert HSL (0–360, 55%, 42%) to a hex color string.
 * Lightness 42% gives good contrast for white text on all hues.
 */
function hslToHex(h: number, s = 55, l = 42): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ---------------------------------------------------------------------------
// faviconSvg — public API
// ---------------------------------------------------------------------------

/**
 * Generate a neutral per-app SVG letter-mark (32×32 viewBox).
 *
 * Constraints:
 *   - Single-quoted SVG attributes (bash-heredoc safe, valid XML)
 *   - No double-quotes in the SVG body (Caddy respond body safety)
 *   - No $ or backtick anywhere
 *   - No SAMO platform colors
 */
export function faviconSvg(appName: string): string {
  const letter = (appName[0] ?? "A").toUpperCase();
  const fill = hslToHex(stableHue(appName));
  // Single-quoted attributes throughout; no double-quotes needed.
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'>` +
    `<rect width='32' height='32' rx='6' fill='${fill}'/>` +
    `<text x='16' y='22' font-family='Arial,sans-serif' font-size='18' font-weight='bold' ` +
    `text-anchor='middle' fill='white'>${letter}</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Caddy snippet helpers
// ---------------------------------------------------------------------------

/**
 * Caddy vhost body lines for a STATIC app vhost with favicon fallback.
 *
 * Returns the COMPLETE site-block body (everything between the `{address} {`
 * opener and the closing `}`). The caller (staticMainVhostLines) splices these
 * lines in place of the normal flat body when `appName` is provided.
 *
 * WHY `route {}` is required:
 *   Caddy's caddyfile adapter reorders directives inside a site block by its
 *   built-in directive precedence table. The `rewrite` handler produced by
 *   `try_files` has higher precedence than `handle` — so the adapter always
 *   places the try_files rewrite BEFORE any `handle` blocks, regardless of the
 *   order they appear in the source Caddyfile. `try_files =404` causes Caddy to
 *   short-circuit with a 404 response before later routes can fire, so a plain
 *   `handle @samohost_favicon` after `try_files` is silently dead code.
 *   The `route {}` directive opts out of the reordering: its contents are kept
 *   in EXACT source order, making the favicon handles fire before try_files.
 *
 * Indented with a single tab (matches staticMainVhostLines convention).
 */
export function faviconVhostBodyLines(
  releaseDirVar: string,
  staticDirVar: string,
  appName: string,
  addTls: boolean,
): string[] {
  const svg = faviconSvg(appName);
  // The `root` directive is already set in the site block to $SAMOHOST_STATIC_DIR.
  // Caddy's `file` matcher resolves against the site root — no $ needed.
  //
  // `/favicon.svg` is always served as the generated letter-mark (apps don't
  // ship a .svg favicon to their static dir).
  //
  // `/favicon.ico` is served from disk when the app ships one; otherwise falls
  // back to the same generated SVG (browsers accept SVG for the favicon.ico URL).
  const tlsLine = addTls ? [`\t\ttls internal`] : [];
  return [
    `\t# samohost-worktree "${releaseDirVar}"`,
    `\troot * "${staticDirVar}"`,
    `\troute {`,
    `\t\t@samohost_has_favicon file /favicon.ico`,
    `\t\thandle /favicon.svg {`,
    `\t\t\theader Content-Type image/svg+xml`,
    `\t\t\trespond "${svg}" 200`,
    `\t\t}`,
    `\t\thandle /favicon.ico {`,
    `\t\t\thandle @samohost_has_favicon {`,
    `\t\t\t\tfile_server`,
    `\t\t\t}`,
    `\t\t\thandle {`,
    `\t\t\t\theader Content-Type image/svg+xml`,
    `\t\t\t\trespond "${svg}" 200`,
    `\t\t\t}`,
    `\t\t}`,
    `\t\ttry_files {path} {path}/ =404`,
    `\t\tfile_server`,
    `\t\tencode gzip`,
    `\t}`,
    ...tlsLine,
  ];
}

/**
 * @deprecated Use faviconVhostBodyLines instead.
 * Kept for backward compat with existing tests; delegates to faviconVhostBodyLines.
 */
export function faviconVhostLinesStatic(staticDirVar: string, appName: string): string[] {
  // Provide empty releaseDirVar and no TLS — used only in unit tests
  // that check for /favicon.ico and <svg presence in the output.
  return faviconVhostBodyLines("$SAMOHOST_RELEASE_DIR", staticDirVar, appName, false);
}

/**
 * Caddy vhost lines for the favicon fallback in a NODE app vhost.
 *
 * The block proxies to the upstream first. When the upstream returns 404
 * (app ships no favicon), handle_errors catches it and responds with the
 * inline letter-mark SVG.
 *
 * Must be inserted BEFORE the catch-all `handle {}` in renderVhost.
 * Indented with a single tab.
 */
export function faviconVhostLinesNode(appName: string, defaultPort: number): string[] {
  const svg = faviconSvg(appName);
  // Caddy `handle` accepts only ONE inline path argument; for multiple paths use
  // a named path matcher declared at block scope before the handle.
  return [
    `\t@samohost_favicon path /favicon.ico /favicon.svg`,
    `\thandle @samohost_favicon {`,
    `\t\treverse_proxy localhost:${defaultPort} {`,
    `\t\t\t@fav404 status 404`,
    `\t\t\thandle_response @fav404 {`,
    `\t\t\t\theader Content-Type image/svg+xml`,
    `\t\t\t\trespond "${svg}" 200`,
    `\t\t\t}`,
    `\t\t}`,
    `\t}`,
  ];
}
