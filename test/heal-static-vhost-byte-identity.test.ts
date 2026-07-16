/**
 * Byte-identity contract: deploy static vhost == heal static vhost ==
 * bootstrap-expected static vhost, for the same app + release inputs.
 *
 * ROOT CAUSE BEING GATED:
 *   heal-script.ts's static vhost heredoc was missing the
 *   `# samohost-worktree "<releaseDir>"` comment line that both deploy
 *   (script.ts) and bootstrap (bootstrap.ts) include/expect.
 *
 *   Result: after a heal, the next `bootstrap` cmp check fails with
 *   "active static main vhost diverges from structured deployment state;
 *   refusing bootstrap route change" — every subsequent deploy on a
 *   heal-touched static app is BLOCKED.
 *
 * THREE-WAY CONTRACT (must hold byte-for-byte for the same inputs):
 *   1. deploy (buildDeployScript)        writes the main vhost to disk
 *   2. heal   (buildConfigHealScript)    re-writes it on heal
 *   3. bootstrap (buildHostBootstrapScript) constructs expected and cmp-checks
 *
 * The gate: all three use a shared staticMainVhostLines() helper so the
 * template CANNOT diverge. The structural byte-identity tests here pin the
 * contract permanently.
 *
 * Also renames the misleading test at app-heal.test.ts:~283 ('via renderVhost')
 * — the implementation fix renames it; this file documents the correct contract.
 */

import { describe, expect, test } from "bun:test";
import {
  buildConfigHealScript,
  SAMOHOST_PROVENANCE_HEADER,
  staticMainVhostLines,
} from "../src/app/heal-script.ts";
import { buildDeployScript } from "../src/app/script.ts";
import {
  buildHostBootstrapScript,
  type HostBootstrapOptions,
} from "../src/app/bootstrap.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-vhost-identity-test",
    vmId: "vm-identity-1",
    name: "samo-site",
    repo: "Tanya301/samo-site",
    branch: "main",
    kind: "static",
    appDir: "/opt/samo-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://samo.team/",
    serviceUnit: "samo-site",
    mainHost: "samo.team",
    mainListen: "cp-http80",
    deployedSha: "abc1234abc1234abc1234abc1234abc1234abc12",
    generatorSha: "oldsha111oldsha111oldsha111oldsha111oldsh1",
    ...overrides,
  };
}

function staticOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "agent",
    // no dbName — static apps have no database
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers: extract heredoc lines from generated bash scripts
// ---------------------------------------------------------------------------

/**
 * Extract lines inside a heredoc whose opening line contains openMarker and
 * whose closing delimiter matches closeDelimiter (exact line match).
 *
 * startAfter: skip this many matching openMarker occurrences (0 = first).
 * Returns null if the heredoc is not found.
 */
function extractHeredocLines(
  script: string,
  openMarker: string,
  closeDelimiter: string,
  startAfter = 0,
): string[] | null {
  const lines = script.split("\n");
  let start = -1;
  let matchCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(openMarker)) {
      if (matchCount === startAfter) {
        start = i + 1;
        break;
      }
      matchCount++;
    }
  }
  if (start === -1) return null;
  const end = lines.indexOf(closeDelimiter, start);
  if (end === -1) return null;
  return lines.slice(start, end);
}

/**
 * Normalize bash variable expressions so that structurally-equivalent lines
 * from different generators compare equal even though they reference different
 * bash variable names that hold the same runtime value.
 *
 *   deploy:    ${SAMOHOST_CANDIDATE_DIR}  → <RELEASE_DIR>
 *   bootstrap: ${SAMOHOST_CHECKOUT_REAL}  → <RELEASE_DIR>
 *   heal:      $SAMOHOST_RELEASE_DIR      → <RELEASE_DIR>
 *
 *   all:       ${SAMOHOST_STATIC_DIR} / $SAMOHOST_STATIC_DIR → <STATIC_DIR>
 */
function normalizeVarExprs(line: string): string {
  return line
    .replace(/\$\{SAMOHOST_CANDIDATE_DIR\}/g, "<RELEASE_DIR>")
    .replace(/\$\{SAMOHOST_CHECKOUT_REAL\}/g, "<RELEASE_DIR>")
    .replace(/\$SAMOHOST_RELEASE_DIR(?!\w)/g, "<RELEASE_DIR>")
    .replace(/\$\{SAMOHOST_STATIC_DIR\}/g, "<STATIC_DIR>")
    .replace(/\$SAMOHOST_STATIC_DIR(?!\w)/g, "<STATIC_DIR>");
}

// ---------------------------------------------------------------------------
// PART 1: staticMainVhostLines shared helper
// (This test FAILS in RED state — function does not exist yet)
// ---------------------------------------------------------------------------

describe("staticMainVhostLines: shared helper emits the canonical static vhost template", () => {
  test("helper is exported from heal-script.ts", () => {
    // RED: fails until the function is exported from heal-script.ts
    expect(typeof staticMainVhostLines).toBe("function");
  });

  test("helper includes the samohost-worktree comment as the second body line", () => {
    const lines = staticMainVhostLines(
      "http://samo.team",
      "$SAMOHOST_RELEASE_DIR",
      "$SAMOHOST_STATIC_DIR",
      false,
    );
    const hasWorktree = lines.some((l) => l.includes("# samohost-worktree"));
    expect(hasWorktree).toBe(true);
  });

  test("helper worktree comment embeds the provided releaseDirVar verbatim", () => {
    const lines = staticMainVhostLines(
      "http://samo.team",
      "$MY_RELEASE_VAR",
      "$MY_STATIC_VAR",
      false,
    );
    const worktreeLine = lines.find((l) => l.includes("# samohost-worktree"));
    expect(worktreeLine).toBeDefined();
    expect(worktreeLine).toContain("$MY_RELEASE_VAR");
  });

  test("helper line order: provenance, address-open, worktree, root, cache policy, serving, [tls], close-brace", () => {
    const relVar = "$SAMOHOST_RELEASE_DIR";
    const statVar = "$SAMOHOST_STATIC_DIR";
    const lines = staticMainVhostLines("http://samo.team", relVar, statVar, false);
    const norm = lines.map(normalizeVarExprs);
    expect(norm[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
    expect(norm[1]).toBe("http://samo.team {");
    expect(norm[2]).toContain("# samohost-worktree");
    expect(norm[2]).toContain("<RELEASE_DIR>");
    expect(norm[3]).toContain("root *");
    expect(norm[3]).toContain("<STATIC_DIR>");
    expect(norm[4]).toContain("@samohost_immutable path_regexp");
    expect(norm[5]).toContain("max-age=31536000, immutable");
    expect(norm[6]).toContain("@samohost_documents path");
    expect(norm[7]).toContain('Cache-Control "no-cache"');
    expect(norm[8]).toBe("\ttry_files {path} {path}/ =404");
    expect(norm[9]).toBe("\tfile_server");
    expect(norm[10]).toBe("\tencode gzip");
    // no tls internal when addTls=false
    expect(norm[11]).toBe("}");
    expect(norm.length).toBe(12);
  });

  test("helper adds tls internal immediately before the close-brace", () => {
    const lines = staticMainVhostLines("samo.team", "$SAMOHOST_RELEASE_DIR", "$SAMOHOST_STATIC_DIR", true);
    const norm = lines.map(normalizeVarExprs);
    expect(norm[11]).toBe("\ttls internal");
    expect(norm[12]).toBe("}");
    expect(norm.length).toBe(13);
  });

  test("helper does NOT add tls internal when addTls=false", () => {
    const lines = staticMainVhostLines("http://samo.team", "$REL", "$STAT", false);
    expect(lines.join("\n")).not.toContain("tls internal");
  });

  test("helper gives fingerprinted assets immutable caching and documents revalidation", () => {
    const rendered = staticMainVhostLines(
      "http://samo.team",
      "$REL",
      "$STAT",
      false,
    ).join("\n");

    expect(rendered).toContain("@samohost_immutable path_regexp");
    expect(rendered).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(rendered).toContain("@samohost_documents path / */ *.html /config.js /version.json");
    expect(rendered).toContain('Cache-Control "no-cache"');
  });
});

// ---------------------------------------------------------------------------
// PART 2: Heal script itself contains the worktree comment
// (This test FAILS in RED state — heal omits the worktree line)
// ---------------------------------------------------------------------------

describe("buildConfigHealScript: static vhost heredoc includes worktree comment", () => {
  test("cp-http80 static app heal script includes samohost-worktree comment", () => {
    const script = buildConfigHealScript(staticApp({ mainListen: "cp-http80" }));
    // FAILS on current code: heal's heredoc omits the worktree line
    expect(script).toContain("# samohost-worktree");
  });

  test("tls-internal static app heal script includes samohost-worktree comment", () => {
    const script = buildConfigHealScript(staticApp({ mainListen: undefined }));
    expect(script).toContain("# samohost-worktree");
  });

  test("heal worktree comment references SAMOHOST_RELEASE_DIR (the active-state JSON release dir)", () => {
    const script = buildConfigHealScript(staticApp());
    const worktreeLine = script.split("\n").find((l) => l.includes("# samohost-worktree"));
    expect(worktreeLine).toBeDefined();
    // Must reference the release dir variable (equivalent to SAMOHOST_CANDIDATE_DIR in deploy
    // and SAMOHOST_CHECKOUT_REAL in bootstrap — same runtime value)
    expect(worktreeLine).toContain("SAMOHOST_RELEASE_DIR");
  });
});

// ---------------------------------------------------------------------------
// PART 3: Three-way structural byte-identity — deploy == heal == bootstrap
// ---------------------------------------------------------------------------

describe("three-way byte-identity: deploy static vhost == heal static vhost == bootstrap expected", () => {
  const app = staticApp({ mainListen: "cp-http80" });

  test("deploy static vhost heredoc contains provenance + worktree + all directives", () => {
    const script = buildDeployScript(app, {
      sha: "abc1234abc1234abc1234abc1234abc1234abc12",
    });
    // The static vhost heredoc uses '<<CADDY || rollback' as the opener (unique in script).
    const lines = extractHeredocLines(script, "<<CADDY || rollback", "CADDY");
    expect(lines).not.toBeNull();
    const norm = lines!.map(normalizeVarExprs);
    expect(norm[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
    expect(norm.some((l) => l.includes("# samohost-worktree"))).toBe(true);
    expect(norm.some((l) => l.includes("file_server"))).toBe(true);
    expect(norm.some((l) => l.includes("try_files"))).toBe(true);
  });

  test("heal static vhost heredoc contains provenance + worktree + all directives", () => {
    const script = buildConfigHealScript(app);
    // The drift-detect branch uses '<<SAMOHOST_STATIC_VHOST_CONTENT' on the tee line.
    const lines = extractHeredocLines(
      script,
      ">/dev/null <<SAMOHOST_STATIC_VHOST_CONTENT",
      "SAMOHOST_STATIC_VHOST_CONTENT",
    );
    expect(lines).not.toBeNull();
    const norm = lines!.map(normalizeVarExprs);
    expect(norm[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
    // This FAILS in RED state (heal omits the worktree line)
    expect(norm.some((l) => l.includes("# samohost-worktree"))).toBe(true);
    expect(norm.some((l) => l.includes("file_server"))).toBe(true);
    expect(norm.some((l) => l.includes("try_files"))).toBe(true);
  });

  test("bootstrap expected vhost block (post-deploy state path) contains provenance + worktree + all directives", () => {
    const script = buildHostBootstrapScript(app, staticOpts());
    // The post-deploy (has-state) path uses 'cat > "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" <<CADDY_SITE'.
    // There are two CADDY_SITE heredocs; the first is the post-deploy (has-worktree) one.
    const lines = extractHeredocLines(script, "<<CADDY_SITE", "CADDY_SITE");
    expect(lines).not.toBeNull();
    const norm = lines!.map(normalizeVarExprs);
    expect(norm[0]).toBe(SAMOHOST_PROVENANCE_HEADER);
    expect(norm.some((l) => l.includes("# samohost-worktree"))).toBe(true);
    expect(norm.some((l) => l.includes("file_server"))).toBe(true);
  });

  test("CRITICAL — deploy and heal template lines are structurally identical (same directives, same order)", () => {
    const deployScript = buildDeployScript(app, {
      sha: "abc1234abc1234abc1234abc1234abc1234abc12",
    });
    const healScript = buildConfigHealScript(app);

    // Deploy: static vhost heredoc opened with '<<CADDY || rollback'
    const deployLines = extractHeredocLines(deployScript, "<<CADDY || rollback", "CADDY");
    // Heal: drift-detect branch heredoc (first SAMOHOST_STATIC_VHOST_CONTENT)
    const healLines = extractHeredocLines(
      healScript,
      ">/dev/null <<SAMOHOST_STATIC_VHOST_CONTENT",
      "SAMOHOST_STATIC_VHOST_CONTENT",
    );

    expect(deployLines).not.toBeNull();
    expect(healLines).not.toBeNull();

    const normDeploy = deployLines!.map(normalizeVarExprs);
    const normHeal = healLines!.map(normalizeVarExprs);

    // DEFINITIVE assertion: same number of lines, same content, same order.
    // FAILS in RED state because heal omits the worktree comment line.
    expect(normHeal).toEqual(normDeploy);
  });

  test("CRITICAL — heal and bootstrap expected template lines are structurally identical", () => {
    const healScript = buildConfigHealScript(app);
    const bootstrapScript = buildHostBootstrapScript(app, staticOpts());

    const healLines = extractHeredocLines(
      healScript,
      ">/dev/null <<SAMOHOST_STATIC_VHOST_CONTENT",
      "SAMOHOST_STATIC_VHOST_CONTENT",
    );
    // First CADDY_SITE heredoc in bootstrap = the post-deploy (has-state) path
    const bootstrapLines = extractHeredocLines(bootstrapScript, "<<CADDY_SITE", "CADDY_SITE");

    expect(healLines).not.toBeNull();
    expect(bootstrapLines).not.toBeNull();

    const normHeal = healLines!.map(normalizeVarExprs);
    const normBootstrap = bootstrapLines!.map(normalizeVarExprs);

    // FAILS in RED state because heal omits the worktree comment line.
    expect(normHeal).toEqual(normBootstrap);
  });
});

// ---------------------------------------------------------------------------
// PART 4: Misleading test description documentation
// The test at app-heal.test.ts:~283 ('also regenerates the main vhost via
// renderVhost for static apps that have mainHost') is renamed in the
// implementation. This test documents the correct contract.
// ---------------------------------------------------------------------------

describe("app-heal contract: static main vhost uses runtime heredoc NOT renderVhost", () => {
  test("buildConfigHealScript for static app does NOT call renderVhost (uses runtime bash heredoc)", () => {
    const script = buildConfigHealScript(staticApp());
    // Static heal uses an unquoted heredoc (bash expands $SAMOHOST_STATIC_DIR at runtime).
    // The unquoted delimiter appears literally in the script.
    expect(script).toContain("SAMOHOST_STATIC_VHOST_CONTENT");
    // Must NOT embed a single-quoted heredoc (that would suppress variable expansion)
    expect(script).not.toContain("'SAMOHOST_STATIC_VHOST_CONTENT'");
    // Must NOT produce reverse_proxy (that would mean renderVhost was called)
    expect(script).not.toContain("reverse_proxy");
  });
});
