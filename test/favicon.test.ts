/**
 * Favicon provisioning tests — RED/GREEN TDD
 *
 * RED: these tests fail until src/caddy/favicon.ts is implemented and
 * staticMainVhostLines() / renderVhost() are updated to emit favicon blocks.
 *
 * What is gated:
 *   1. faviconSvg(appName) — deterministic letter-mark SVG generator
 *      - letter = appName[0].toUpperCase()
 *      - fill color = stable hue derived from string hash of appName
 *      - NO indigo #4263eb (samo.team platform brand)
 *      - NO backticks or $ (would break unquoted bash heredocs)
 *   2. staticMainVhostLines() — favicon fallback block in static vhost
 *      - serves app's own /favicon.ico first (file matcher)
 *      - falls back to inline SVG respond block when file absent
 *   3. renderVhost() — favicon fallback for node vhosts
 *      - handle block for /favicon.ico and /favicon.svg paths
 *      - passes through to upstream for apps that serve their own favicon
 *   4. Byte-identity: adding favicon lines to staticMainVhostLines must NOT
 *      break the existing three-way deploy==heal==bootstrap contract (the
 *      new lines must appear in all three generators via the shared helper).
 */

import { describe, expect, test } from "bun:test";
import {
  faviconSvg,
  faviconVhostBodyLines,
  faviconVhostLinesStatic,
  faviconVhostLinesNode,
} from "../src/caddy/favicon.ts";
import {
  staticMainVhostLines,
  SAMOHOST_PROVENANCE_HEADER,
} from "../src/app/heal-script.ts";
import { renderVhost } from "../src/caddy/render.ts";
import type { VhostPlan } from "../src/caddy/render.ts";

// ---------------------------------------------------------------------------
// 1. faviconSvg — SVG generator
// ---------------------------------------------------------------------------

describe("faviconSvg: letter-mark SVG generator", () => {
  test("returns a string", () => {
    expect(typeof faviconSvg("samograph")).toBe("string");
  });

  test("uses the first letter of appName uppercased as the displayed letter", () => {
    const svg = faviconSvg("samograph");
    expect(svg).toContain(">S<");
  });

  test("field-record → F", () => {
    const svg = faviconSvg("field-record");
    expect(svg).toContain(">F<");
  });

  test("gregg-brandalise → G", () => {
    const svg = faviconSvg("gregg-brandalise");
    expect(svg).toContain(">G<");
  });

  test("friends-of-twin-peaks → F (not SAMO mark)", () => {
    const svg = faviconSvg("friends-of-twin-peaks");
    expect(svg).toContain(">F<");
  });

  test("color is NOT samo.team platform indigo #4263eb", () => {
    for (const name of ["samograph", "samorev", "friends-of-twin-peaks", "gregg-brandalise", "field-record"]) {
      const svg = faviconSvg(name);
      expect(svg).not.toContain("#4263eb");
      expect(svg).not.toContain("4263eb");
    }
  });

  test("color is NOT samo.team green #0c7f4d", () => {
    for (const name of ["samograph", "samorev", "friends-of-twin-peaks", "gregg-brandalise", "field-record"]) {
      const svg = faviconSvg(name);
      expect(svg).not.toContain("#0c7f4d");
    }
  });

  test("is deterministic — same appName always gives same output", () => {
    expect(faviconSvg("samograph")).toBe(faviconSvg("samograph"));
    expect(faviconSvg("friends-of-twin-peaks")).toBe(faviconSvg("friends-of-twin-peaks"));
  });

  test("different appNames produce different colors", () => {
    // Very unlikely to collide given the hash distribution
    const svg1 = faviconSvg("samograph");
    const svg2 = faviconSvg("samorev");
    // Extract fill color from both — they should differ (different hue)
    // We just assert the whole SVG differs (letter may differ too, which is fine)
    expect(svg1).not.toBe(svg2);
  });

  test("SVG contains no backtick or dollar sign (bash heredoc safety)", () => {
    const svg = faviconSvg("samograph");
    expect(svg).not.toContain("`");
    expect(svg).not.toContain("$");
  });

  test("SVG uses single-quoted attributes (safe in unquoted heredoc)", () => {
    const svg = faviconSvg("samograph");
    // Must not use double-quoted XML attributes (would break some heredoc contexts)
    // Single-quoted SVG attributes are valid XML/SVG
    expect(svg).toContain("viewBox='0 0 32 32'");
  });

  test("SVG has correct 32x32 viewBox and rounded rectangle", () => {
    const svg = faviconSvg("samograph");
    expect(svg).toContain("viewBox='0 0 32 32'");
    expect(svg).toContain("<rect");
    expect(svg).toContain("rx=");
  });

  test("SVG is valid opening with <svg tag", () => {
    const svg = faviconSvg("samograph");
    expect(svg.trim()).toMatch(/^<svg /);
  });
});

// ---------------------------------------------------------------------------
// 2. faviconVhostLinesStatic — Caddy lines for static app fallback
// ---------------------------------------------------------------------------

describe("faviconVhostLinesStatic: Caddy snippet for static apps", () => {
  const lines = faviconVhostLinesStatic("$SAMOHOST_STATIC_DIR", "samograph");

  test("returns an array of strings", () => {
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("contains a handle block for /favicon.ico and /favicon.svg", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("/favicon.ico");
    expect(joined).toContain("/favicon.svg");
  });

  test("uses a file matcher to check for app-supplied favicon first", () => {
    const joined = lines.join("\n");
    // Must use Caddy file matcher so existing repo favicons are not overridden
    expect(joined).toMatch(/@\w+\s+file/);
  });

  test("falls back to inline SVG respond when file absent", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("respond");
    expect(joined).toContain("<svg");
  });

  test("SVG literal in fallback does not contain $ or backtick (bash-safe)", () => {
    const joined = lines.join("\n");
    // Bash var refs like $SAMOHOST_STATIC_DIR are expected; only check the SVG body.
    expect(joined).not.toContain("`");
    const svgStart = joined.indexOf("<svg");
    const svgEnd = joined.indexOf("</svg>") + 6;
    const svgPart = svgStart >= 0 && svgEnd > svgStart ? joined.slice(svgStart, svgEnd) : joined;
    expect(svgPart).not.toContain("$");
    expect(svgPart).not.toContain("`");
  });

  test("serves SVG as image/svg+xml content type", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("image/svg+xml");
  });

  test("uses file_server directive for own-favicon branch", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("file_server");
  });
});

// ---------------------------------------------------------------------------
// 3. faviconVhostLinesNode — Caddy lines for node app fallback
// ---------------------------------------------------------------------------

describe("faviconVhostLinesNode: Caddy snippet for node apps", () => {
  const lines = faviconVhostLinesNode("samograph", 3000);

  test("returns an array of strings", () => {
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("contains a handle block for favicon paths", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("/favicon.ico");
  });

  test("falls back with inline SVG on 404 from upstream", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("<svg");
  });

  test("SVG in fallback does not contain $ or backtick", () => {
    const joined = lines.join("\n");
    expect(joined).not.toContain("`");
    expect(joined).not.toContain("$");
  });

  test("serves SVG as image/svg+xml content type", () => {
    const joined = lines.join("\n");
    expect(joined).toContain("image/svg+xml");
  });
});

// ---------------------------------------------------------------------------
// 4. staticMainVhostLines — favicon block integrated
// ---------------------------------------------------------------------------

describe("staticMainVhostLines: includes favicon fallback", () => {
  test("generated vhost contains favicon handle block", () => {
    const lines = staticMainVhostLines(
      "http://samorev.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "samorev",
    );
    const joined = lines.join("\n");
    expect(joined).toContain("/favicon.ico");
    expect(joined).toContain("<svg");
  });

  test("favicon SVG in static vhost has correct letter for app name", () => {
    const lines = staticMainVhostLines(
      "http://friends-of-twin-peaks.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "friends-of-twin-peaks",
    );
    const joined = lines.join("\n");
    expect(joined).toContain(">F<");
  });

  test("file_server used for own-favicon branch (not overriding app favicon)", () => {
    const lines = staticMainVhostLines(
      "http://game-changers.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "game-changers",
    );
    const joined = lines.join("\n");
    // Has file matcher + file_server for the app's own favicon
    expect(joined).toMatch(/@\w+\s+file/);
    expect(joined).toContain("file_server");
  });

  test("closing brace is LAST line (favicon block inserted before close)", () => {
    const lines = staticMainVhostLines(
      "http://samorev.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "samorev",
    );
    expect(lines[lines.length - 1]).toBe("}");
  });

  test("favicon SVG contains no $ or backtick (unquoted heredoc safety)", () => {
    const lines = staticMainVhostLines(
      "http://samorev.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "samorev",
    );
    const joined = lines.join("\n");
    // Check only the favicon portion (lines after encode gzip but before closing brace)
    // Simple: the whole joined must not have $ in the SVG literal
    // The SVG is embedded as a literal string, so no $ anywhere in it
    // (bash vars like $SAMOHOST_STATIC_DIR appear elsewhere, that's expected)
    // Check that the SVG tag itself has no $
    const svgStart = joined.indexOf("<svg");
    const svgEnd = joined.indexOf("</svg>") + 6;
    const svgPart = joined.slice(svgStart, svgEnd);
    expect(svgPart).not.toContain("$");
    expect(svgPart).not.toContain("`");
  });

  test("backward compat: addTls=false still works with new appName param", () => {
    // Old callers without appName param should still work (appName defaults to empty)
    const lines = staticMainVhostLines(
      "http://samo.team",
      "$REL",
      "$STAT",
      false,
    );
    // Must still produce a valid vhost (provenance header + address + close brace)
    expect(lines[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
    expect(lines[lines.length - 1]).toBe("}");
  });

  test("provenance header remains first line", () => {
    const lines = staticMainVhostLines(
      "http://samorev.samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
      "samorev",
    );
    expect(lines[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
  });
});

// ---------------------------------------------------------------------------
// 5. renderVhost — favicon fallback for node apps
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<VhostPlan> = {}): VhostPlan {
  return {
    host: "samograph.samo.team",
    listen: "cp-http80",
    routes: [],
    defaultPort: 3000,
    logFile: "/var/log/caddy/samograph-prod.log",
    appName: "samograph",
    ...overrides,
  };
}

describe("renderVhost: includes favicon fallback for node apps", () => {
  test("rendered vhost contains favicon handle block", () => {
    const out = renderVhost(makePlan());
    expect(out).toContain("/favicon.ico");
    expect(out).toContain("<svg");
  });

  test("favicon block appears BEFORE the catch-all handle (multi-route plan)", () => {
    // Use a plan with routes so renderVhost emits a `handle {}` catch-all wrapper.
    const planWithRoutes = makePlan({
      routes: [
        {
          name: "stream",
          matcher: { regexp: "^/stream$" },
          target: { port: 8888 },
        },
      ],
    });
    const out = renderVhost(planWithRoutes);
    const faviconPos = out.indexOf("/favicon.ico");
    // The catch-all `handle {` is the last one (after the favicon block)
    const catchAllPos = out.lastIndexOf("\thandle {");
    // favicon handle must appear before the final catch-all
    expect(faviconPos).toBeGreaterThan(0);
    expect(catchAllPos).toBeGreaterThan(faviconPos);
  });

  test("favicon letter correct for samograph (S)", () => {
    const out = renderVhost(makePlan({ appName: "samograph" }));
    expect(out).toContain(">S<");
  });

  test("favicon letter correct for field-record (F)", () => {
    const out = renderVhost(makePlan({ host: "field-record-1.samo.team", appName: "field-record" }));
    expect(out).toContain(">F<");
  });

  test("no samo.team indigo color in rendered vhost", () => {
    const out = renderVhost(makePlan());
    expect(out).not.toContain("#4263eb");
  });

  test("favicon SVG has no $ or backtick (safe in Caddy config)", () => {
    const out = renderVhost(makePlan());
    const svgStart = out.indexOf("<svg");
    const svgEnd = out.indexOf("</svg>") + 6;
    const svgPart = out.slice(svgStart, svgEnd);
    expect(svgPart).not.toContain("$");
    expect(svgPart).not.toContain("`");
  });

  test("serves image/svg+xml content type", () => {
    const out = renderVhost(makePlan());
    expect(out).toContain("image/svg+xml");
  });

  test("log block still present after favicon addition", () => {
    const out = renderVhost(makePlan());
    expect(out).toContain("log {");
    expect(out).toContain("output file /var/log/caddy/samograph-prod.log");
  });

  test("closing brace is still last line", () => {
    const out = renderVhost(makePlan());
    const lines = out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("}");
  });

  test("zero-routes vhost still renders (back-compat)", () => {
    // Must not throw with zero routes
    const out = renderVhost(makePlan({ routes: [], appName: "samograph" }));
    expect(out).toContain("reverse_proxy localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// 6. No SAMO platform branding on client sites
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REGRESSION: cache headers must be present when appName is provided
// samorev finding: faviconVhostBodyLines() omitted staticCacheHeaderLines()
// causing ALL static apps (game-changers, samorev, friends-of-twin-peaks,
// gregg-brandalise) to lose Cache-Control headers after the favicon PR.
// ---------------------------------------------------------------------------

describe("REGRESSION: cache headers preserved on favicon-enabled static vhost", () => {
  // Test against staticMainVhostLines WITH appName — the NEW code path that
  // was regressing.  The OLD path (no appName) already had coverage.
  const apps = ["samorev", "game-changers", "friends-of-twin-peaks", "gregg-brandalise"];

  for (const name of apps) {
    test(`${name}: Cache-Control immutable header present in staticMainVhostLines output`, () => {
      const joined = staticMainVhostLines(
        `http://${name}.samo.team`,
        "$SAMOHOST_RELEASE_DIR",
        "$SAMOHOST_STATIC_DIR",
        false,
        name,
      ).join("\n");
      // Must have the immutable matcher for fingerprinted assets
      expect(joined).toContain("@samohost_immutable");
      expect(joined).toContain("max-age=31536000, immutable");
    });

    test(`${name}: Cache-Control no-cache header present in staticMainVhostLines output`, () => {
      const joined = staticMainVhostLines(
        `http://${name}.samo.team`,
        "$SAMOHOST_RELEASE_DIR",
        "$SAMOHOST_STATIC_DIR",
        false,
        name,
      ).join("\n");
      expect(joined).toContain("@samohost_documents");
      expect(joined).toContain('Cache-Control "no-cache"');
    });

    test(`${name}: favicon route{} block present alongside cache headers`, () => {
      const joined = staticMainVhostLines(
        `http://${name}.samo.team`,
        "$SAMOHOST_RELEASE_DIR",
        "$SAMOHOST_STATIC_DIR",
        false,
        name,
      ).join("\n");
      // Both cache headers AND favicon must coexist
      expect(joined).toContain("route {");
      expect(joined).toContain("/favicon.ico");
      expect(joined).toContain("max-age=31536000, immutable");
    });
  }

  test("CRITICAL — buildConfigHealScript static output has both cache headers and favicon block", () => {
    // Call buildConfigHealScript for a static app and verify the embedded
    // heredoc content has BOTH cache-control lines AND the favicon route block.
    // This test exercises the full production code path — the same code that
    // determines what runs on the actual VMs.
    const app = {
      id: "cache-regression-test",
      vmId: "vm-cache-reg",
      name: "game-changers",
      repo: "Tanya301/game-changers",
      branch: "main",
      kind: "static" as const,
      appDir: "/opt/game-changers/app",
      buildCmd: "npm run build",
      healthUrl: "https://game-changers.samo.team/",
      serviceUnit: "game-changers",
      mainHost: "game-changers.samo.team",
      mainListen: "cp-http80" as const,
      deployedSha: "abc1234abc1234abc1234abc1234abc1234abc12",
      generatorSha: "oldsha111oldsha111oldsha111oldsha111oldsh1",
    };
    // Import buildConfigHealScript dynamically in the test
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildConfigHealScript } = require("../src/app/heal-script.ts");
    const script = buildConfigHealScript(app);
    // Must have immutable cache header
    expect(script).toContain("max-age=31536000, immutable");
    // Must have no-cache header for documents
    expect(script).toContain('Cache-Control "no-cache"');
    // Must have the favicon route block
    expect(script).toContain("route {");
    expect(script).toContain("/favicon.ico");
  });
});

// ---------------------------------------------------------------------------
// NAME GUARD: hostile app.name must not break Caddy config or SVG
// ---------------------------------------------------------------------------

describe("name guard: hostile appName rejected by faviconVhostBodyLines and faviconVhostLinesNode", () => {
  test('faviconVhostBodyLines throws on appName containing double-quote', () => {
    expect(() => {
      faviconVhostBodyLines("$REL", "$STAT", 'bad"name', false);
    }).toThrow();
  });

  test('faviconVhostBodyLines throws on appName containing < (SVG injection)', () => {
    expect(() => {
      faviconVhostBodyLines("$REL", "$STAT", "<script>", false);
    }).toThrow();
  });

  test('faviconVhostBodyLines throws on appName containing & (XML entity injection)', () => {
    expect(() => {
      faviconVhostBodyLines("$REL", "$STAT", "a&b", false);
    }).toThrow();
  });

  test('faviconVhostBodyLines accepts safe alphanumeric-dash-underscore names', () => {
    // Must NOT throw for real production names
    for (const name of ["samorev", "game-changers", "friends-of-twin-peaks", "gregg-brandalise", "field-record-1"]) {
      expect(() => {
        faviconVhostBodyLines("$REL", "$STAT", name, false);
      }).not.toThrow();
    }
  });

  test('faviconVhostLinesNode throws on appName containing double-quote', () => {
    expect(() => {
      faviconVhostLinesNode('bad"name', 3000);
    }).toThrow();
  });

  test('faviconVhostLinesNode accepts safe names', () => {
    expect(() => {
      faviconVhostLinesNode("samograph", 3000);
    }).not.toThrow();
  });
});

describe("favicon: no SAMO platform branding on any client app", () => {
  const clientApps = [
    "samograph",
    "field-record",
    "samorev",
    "game-changers",
    "friends-of-twin-peaks",
    "gregg-brandalise",
  ];

  for (const app of clientApps) {
    test(`${app}: no #4263eb (samo.team platform indigo)`, () => {
      const svg = faviconSvg(app);
      expect(svg).not.toContain("4263eb");
    });

    test(`${app}: no #0c7f4d (samo.team landing green)`, () => {
      const svg = faviconSvg(app);
      expect(svg).not.toContain("0c7f4d");
    });
  }
});

// ---------------------------------------------------------------------------
// REGRESSION: /favicon.svg must NOT unconditionally override an app's own file
//
// Bug introduced in commit 472f8e8: faviconVhostBodyLines() emits /favicon.svg
// as an unconditional `respond` with the generated mark — no file matcher.
// Astro sites friends-of-twin-peaks and gregg-brandalise both ship their own
// /favicon.svg and would have it clobbered by the platform letter-mark on the
// next heal cycle.
//
// The fix mirrors what /favicon.ico already does: add @samohost_has_favicon_svg
// file matcher, serve app's own file if present, else fall back to the
// generated mark respond.
// ---------------------------------------------------------------------------

describe("REGRESSION: /favicon.svg for static apps — own file must not be overridden", () => {
  test("faviconVhostBodyLines: /favicon.svg uses a file matcher (not unconditional respond)", () => {
    const lines = faviconVhostBodyLines("$REL", "$STAT", "friends-of-twin-peaks", false);
    const joined = lines.join("\n");
    // The /favicon.svg block must have a Caddy file matcher so the app's own
    // favicon.svg is served when present — same pattern as /favicon.ico.
    // If there is NO file matcher for /favicon.svg, this regex won't match.
    expect(joined).toMatch(/@\w+\s+file\s+\/favicon\.svg/);
  });

  test("faviconVhostBodyLines: /favicon.svg block has a file_server branch (serves own file)", () => {
    // The block for /favicon.svg must have a nested file_server branch so an
    // app that ships its own /favicon.svg gets it served — not the letter-mark.
    const lines = faviconVhostBodyLines("$REL", "$STAT", "gregg-brandalise", false);
    const joined = lines.join("\n");
    // Locate the favicon.svg section and verify file_server appears in it.
    const svgHandleIdx = joined.indexOf("handle /favicon.svg");
    expect(svgHandleIdx).toBeGreaterThanOrEqual(0);
    // There must be a file_server after the /favicon.svg handle opener (before
    // the /favicon.ico handle starts — use the substring between the two).
    const icoHandleIdx = joined.indexOf("handle /favicon.ico");
    const svgSection = joined.slice(svgHandleIdx, icoHandleIdx > svgHandleIdx ? icoHandleIdx : undefined);
    expect(svgSection).toContain("file_server");
  });

  test("faviconVhostBodyLines: /favicon.svg still has generated-mark fallback respond (for apps without own svg)", () => {
    // Apps without a /favicon.svg must still get the letter-mark.
    const lines = faviconVhostBodyLines("$REL", "$STAT", "samograph", false);
    const joined = lines.join("\n");
    const svgHandleIdx = joined.indexOf("handle /favicon.svg");
    const icoHandleIdx = joined.indexOf("handle /favicon.ico");
    const svgSection = joined.slice(svgHandleIdx, icoHandleIdx > svgHandleIdx ? icoHandleIdx : undefined);
    // Must contain a `respond` with the generated mark for apps without own svg.
    expect(svgSection).toContain("respond");
    expect(svgSection).toContain("<svg");
  });

  test("faviconVhostLinesNode: /favicon.svg proxied to upstream (app's own svg preserved on 200)", () => {
    // Node path already proxies upstream and only falls back on 404.
    // Verify /favicon.svg is included in the upstream proxy matcher
    // (so the app's own /favicon.svg is served when upstream returns 200).
    const lines = faviconVhostLinesNode("friends-of-twin-peaks", 3000);
    const joined = lines.join("\n");
    // The matcher must cover both /favicon.ico AND /favicon.svg
    expect(joined).toContain("/favicon.svg");
    // Must use handle_response for 404 — proxy first, generate only on miss
    expect(joined).toContain("handle_response");
  });

  test("/favicon.ico behavior unchanged: file matcher present, file_server for own ico, respond fallback", () => {
    // Regression guard: fixing svg must not break the ico logic.
    const lines = faviconVhostBodyLines("$REL", "$STAT", "samograph", false);
    const joined = lines.join("\n");
    // file matcher for ico
    expect(joined).toMatch(/@\w+\s+file\s+\/favicon\.ico/);
    // file_server in the ico block
    const icoHandleIdx = joined.indexOf("handle /favicon.ico");
    expect(icoHandleIdx).toBeGreaterThanOrEqual(0);
    const icoSection = joined.slice(icoHandleIdx);
    expect(icoSection).toContain("file_server");
    expect(icoSection).toContain("respond");
  });
});
