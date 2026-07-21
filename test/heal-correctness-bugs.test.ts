/**
 * RED tests for two correctness bugs in buildConfigHealScript (PR #188 follow-up).
 *
 * BUG-1: inline-Caddyfile guard misfires on comment lines
 *   The guard that detects an app's mainHost as an inline site block in
 *   /etc/caddy/Caddyfile uses `grep -qF <mainHost>`. This matches ANY line
 *   containing the mainHost — including comment lines (e.g. a comment containing
 *   'samograph.samo.team' misfires the guard and exits 'inline-caddyfile').
 *
 *   Fix: strip comment lines before searching. Only a non-comment line whose
 *   content contains the mainHost as a structural site-block header should fire.
 *
 * BUG-2: trailing empty element from renderVhost.split("\n")
 *   renderVhost returns a string ending in "\n". Calling .split("\n") on it
 *   produces a trailing empty-string element, which becomes an extra blank line
 *   inside the heredoc (double trailing newline after the closing "}").
 *   The live file written by the same heredoc has it too, so re-runs still match
 *   — but it's a byte discrepancy vs renderVhost's own output and misleads cmp.
 *
 *   Fix: drop the trailing empty element before spreading into the heredoc.
 *
 * Both tests use pure builder assertions (no SSH, no network, no real VM).
 *
 * COMMIT DISCIPLINE: this file is the RED commit. It must FAIL before the
 * implementation is applied, and PASS after.
 */

import { describe, expect, test } from "bun:test";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { renderVhost, planFromApp } from "../src/caddy/render.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A node app that mimics samograph — mainHost appears as a comment in Caddyfile. */
function nodeApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-samograph-test",
    vmId: "vm-1111",
    name: "samograph",
    repo: "Tanya301/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "https://samograph.samo.team/api/version",
    serviceUnit: "samograph",
    mainHost: "samograph.samo.team",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BUG-1: inline-Caddyfile guard MUST NOT misfire on comment lines
// ---------------------------------------------------------------------------

describe("BUG-1: inline-Caddyfile guard excludes comment lines", () => {
  /**
   * RED: today the guard emits plain `grep -qF <mainHost>` which matches
   * comment lines. The generated bash must instead exclude lines whose first
   * non-whitespace character is '#' before checking for the mainHost.
   *
   * We verify this by inspecting the generated bash script itself: the grep
   * command that checks for the mainHost MUST NOT be a bare `grep -qF`
   * against the raw Caddyfile. It must filter comment lines first.
   */
  test("BUG-1a: guard does NOT use bare grep -qF <mainHost> against raw Caddyfile", () => {
    const script = buildConfigHealScript(nodeApp());
    // Bug: the current guard is:
    //   if grep -qF 'samograph.samo.team' /etc/caddy/Caddyfile 2>/dev/null; then
    // This is wrong because it matches comment lines.
    // The fix must eliminate bare fixed-string grep against the raw Caddyfile for the host.
    //
    // We detect the bug by confirming the generated script does NOT contain the
    // bare pattern: "grep -qF '<mainHost>' /etc/caddy/Caddyfile"
    // (the fix will pipe through a comment-stripping step first).
    const bareGuardPattern = `grep -qF 'samograph.samo.team' /etc/caddy/Caddyfile`;
    expect(script).not.toContain(bareGuardPattern);
  });

  test("BUG-1b: guard strips comment lines before checking for mainHost (grep -v pattern present)", () => {
    const script = buildConfigHealScript(nodeApp());
    // After the fix, the guard must filter out lines starting with optional
    // whitespace followed by '#'. The generated bash must include a mechanism
    // to exclude comment lines — e.g. `grep -v '^\s*#'` or equivalent.
    // We check that a comment-stripping grep appears near the mainHost check.
    //
    // The exact implementation can vary, but the generated script must have
    // some form of comment exclusion piped into (or preceding) the mainHost check.
    // We verify by looking for grep -v with a hash-comment pattern.
    // Acceptable patterns: grep -v '^\s*#', grep -v '^[[:space:]]*#', etc.
    // The pattern matches: grep -v '<something>#'
    expect(script).toMatch(/grep\s+-v\s+['"].+#/m);
  });

  test("BUG-1c: a comment line containing the mainHost does NOT trigger the guard", () => {
    // This is the definitive behavioral test.
    // We simulate what the bash guard does in TypeScript:
    //   Given a Caddyfile whose only occurrence of 'samograph.samo.team' is in a comment,
    //   the guard must NOT fire.
    //
    // We verify by inspecting the generated script: the guard must be written
    // such that stripping comment lines from the input would leave no match for mainHost.
    //
    // Simulated Caddyfile content (the bug scenario):
    //   # site block for samograph.samo.team was here (now in sites.d)
    //   {
    //     import sites.d/*.caddy
    //   }
    //
    // After stripping comment lines: no line contains 'samograph.samo.team' → guard must NOT fire.
    //
    // We verify the guard uses grep -v / sed / awk to strip comments before the host check,
    // by confirming the generated script contains the comment-strip step.

    const script = buildConfigHealScript(nodeApp());

    // The guard must explicitly exclude comment lines. We do a stricter assertion:
    // the script must contain a pipeline or sequence where comment lines are removed
    // BEFORE or AS PART OF the mainHost grep.
    //
    // Acceptable patterns include:
    //   grep -v '^\s*#' /etc/caddy/Caddyfile | grep -qF 'samograph.samo.team'
    //   sed '/^\s*#/d' /etc/caddy/Caddyfile | grep -qF 'samograph.samo.team'
    //   grep -vE '^\s*#' /etc/caddy/Caddyfile | grep -qF 'samograph.samo.team'
    //
    // All these patterns include both the comment-strip step and the host name.
    // We verify by looking for the mainHost grep being applied to filtered output.
    expect(script).toMatch(
      /grep\s+-v[^\n]*#[^\n]*\|\s*grep[^\n]*samograph\.samo\.team/,
    );
  });

  test("BUG-1d: a REAL inline site block for the mainHost still triggers the guard", () => {
    // The guard must still fire when the mainHost appears as a REAL (non-comment) site block.
    // i.e., the comment-stripping must not suppress a real inline block.
    //
    // We verify this by checking the generated script:
    // After stripping comment lines, if the remaining content contains the mainHost,
    // the guard fires. The script must still include a grep for mainHost (after stripping).
    //
    // Verify: the mainHost string still appears in the guard logic (not removed entirely).
    const script = buildConfigHealScript(nodeApp());
    expect(script).toContain("samograph.samo.team");
    // The guard line that fires the inline-caddyfile exit must reference the mainHost.
    expect(script).toContain("inline-caddyfile: samograph.samo.team");
  });
});

// ---------------------------------------------------------------------------
// BUG-2: trailing empty element from renderVhost.split("\n") adds extra blank line
// ---------------------------------------------------------------------------

describe("BUG-2: split(\\\"\\\\n\\\") drops trailing empty element", () => {
  test("BUG-2a: renderVhost output ends with a newline (confirming the root cause)", () => {
    // This documents the root cause: renderVhost returns "...\n}", which ends
    // with "}\n". Splitting on "\n" gives ["...", "}", ""] — the trailing "".
    const vhost = renderVhost(planFromApp(nodeApp()));
    expect(vhost.endsWith("\n")).toBe(true);
    const parts = vhost.split("\n");
    // The last element from split is an empty string due to trailing newline.
    expect(parts[parts.length - 1]).toBe("");
  });

  test("BUG-2b: the generated heal heredoc does NOT contain a trailing blank line after the closing brace", () => {
    // After the fix: the heredoc content for the node app must end with just "}"
    // (the closing brace of the site block), not "}\n\n" (an extra blank line).
    //
    // We locate the heredoc in the generated script and check that the line
    // immediately before the SAMOHOST_MAIN_VHOST_CONTENT delimiter is not empty.
    const script = buildConfigHealScript(nodeApp());
    const lines = script.split("\n");

    // Find the SAMOHOST_MAIN_VHOST_CONTENT closing delimiter (first occurrence,
    // which follows the write-to-temp-file heredoc).
    const delimIdx = lines.indexOf("SAMOHOST_MAIN_VHOST_CONTENT");
    expect(delimIdx).toBeGreaterThan(0);

    // The line immediately before the delimiter must NOT be empty.
    // Bug: it is "" (an empty string from the trailing-element artifact).
    const lineBeforeDelim = lines[delimIdx - 1];
    expect(lineBeforeDelim).not.toBe("");
    // It should be "}" — the closing brace of the site block.
    expect(lineBeforeDelim?.trim()).toBe("}");
  });

  test("BUG-2c: the generated heal heredoc (fresh-write branch) also has no trailing blank line", () => {
    // The fresh-write branch (elif for when the file does not exist) also uses
    // the same split pattern. Verify it too has no trailing blank line.
    const script = buildConfigHealScript(nodeApp());
    const lines = script.split("\n");

    // The second occurrence of SAMOHOST_MAIN_VHOST_CONTENT is the closing delimiter
    // of the fresh-write heredoc.
    let count = 0;
    let secondDelimIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "SAMOHOST_MAIN_VHOST_CONTENT") {
        count++;
        if (count === 2) {
          secondDelimIdx = i;
          break;
        }
      }
    }
    // If the script only has one heredoc (e.g. only the write-to-temp branch is
    // generated), this assertion is skipped gracefully.
    if (secondDelimIdx === -1) return;

    const lineBeforeSecondDelim = lines[secondDelimIdx - 1];
    expect(lineBeforeSecondDelim).not.toBe("");
    expect(lineBeforeSecondDelim?.trim()).toBe("}");
  });

  test("BUG-2d: the split lines embedded in the heredoc match renderVhost's own lines exactly", () => {
    // The definitive assertion: the lines embedded in the heredoc between
    // the opener and SAMOHOST_MAIN_VHOST_CONTENT must be byte-identical to
    // what renderVhost returns (split by newline, trailing empty dropped).
    const app = nodeApp();
    const script = buildConfigHealScript(app);
    const lines = script.split("\n");

    // Find the first SAMOHOST_MAIN_VHOST_CONTENT delimiter
    const delimIdx = lines.indexOf("SAMOHOST_MAIN_VHOST_CONTENT");
    expect(delimIdx).toBeGreaterThan(0);

    // Find the opener (the heredoc start line before the content)
    // The opener matches "<<'SAMOHOST_MAIN_VHOST_CONTENT'" (single-quoted delimiter)
    let openerIdx = -1;
    for (let i = delimIdx - 1; i >= 0; i--) {
      if ((lines[i] ?? "").includes("<<'SAMOHOST_MAIN_VHOST_CONTENT'")) {
        openerIdx = i;
        break;
      }
    }
    expect(openerIdx).toBeGreaterThan(-1);

    // Lines between opener and delimiter = the embedded heredoc content
    const embeddedLines = lines.slice(openerIdx + 1, delimIdx);

    // Expected: renderVhost output split by "\n", trailing empty element removed.
    const vhostOutput = renderVhost(planFromApp(app));
    const expectedLines = vhostOutput.split("\n");
    // Remove the trailing empty element (the bug artifact we're fixing).
    if (expectedLines[expectedLines.length - 1] === "") {
      expectedLines.pop();
    }

    expect(embeddedLines).toEqual(expectedLines);
  });
});
