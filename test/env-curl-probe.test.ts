/**
 * TDD RED tests for the curl-based httpProbe implementation helpers.
 *
 * Context (samohost #55 / #57 follow-up):
 *   Bun's global fetch mis-verifies the Cloudflare GTS-WE1 edge cert chain on
 *   some hostnames (game-changers-demo-red-bg.samo.cat: 12/12 fetch throws
 *   "unable to get local issuer certificate"; same chain on
 *   field-record-demo-red-login.samo.cat returns 200). System curl uses the OS
 *   CA bundle, which verifies the CF chain correctly and returns HTTP 200 5/5.
 *   This means the merged Bun-fetch probe produces FALSE-NEGATIVE failures that
 *   would wrongly block legitimate previews.
 *
 * Fix: replace defaultEnvExecDeps's httpProbe with a spawnSync curl call.
 *   Two pure exported helpers are unit-tested here:
 *     - buildCurlProbeArgs(url): string[]  — command-line builder
 *     - parseCurlProbeResult(stdout, exitCode): { status: number; ok: boolean }
 *       — parses curl's %{http_code} output
 *
 * These tests import the helpers and assert their behavior WITHOUT hitting any
 * real network (pure functions, no mocks needed).
 *
 * The existing injected-fake tests in env-external-probe.test.ts remain
 * unchanged — they exercise runEnvCreate via the injected dep boundary and do
 * not care about the production curl wiring.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCurlProbeArgs,
  parseCurlProbeResult,
} from "../src/commands/env.ts";

// ---------------------------------------------------------------------------
// buildCurlProbeArgs
// ---------------------------------------------------------------------------

describe("buildCurlProbeArgs: curl command-line builder", () => {
  const url = "https://myapp-feat-preview.samo.cat/";

  test("includes the target URL", () => {
    const args = buildCurlProbeArgs(url);
    expect(args).toContain(url);
  });

  test("does NOT contain -k or --insecure (TLS cert verification must be ON)", () => {
    const args = buildCurlProbeArgs(url);
    // Neither the short flag nor the long flag may appear anywhere in the args
    expect(args).not.toContain("-k");
    expect(args).not.toContain("--insecure");
    // Also check no arg contains -k as a substring (e.g. combined short flags like -ksSo)
    for (const arg of args) {
      // We allow args that contain 'k' only as part of a word (--max-time etc.)
      // Reject any combined short-flag that includes k, e.g. -ksSo or -sk
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        expect(arg).not.toMatch(/k/);
      }
    }
  });

  test("sets --max-time (timeout) to limit each attempt", () => {
    const args = buildCurlProbeArgs(url);
    // --max-time should be present
    const joined = args.join(" ");
    expect(joined).toMatch(/--max-time/);
  });

  test("requests %{http_code} in the -w / --write-out format string", () => {
    const args = buildCurlProbeArgs(url);
    const joined = args.join(" ");
    expect(joined).toContain("%{http_code}");
  });

  test("suppresses body output (-o /dev/null or equivalent)", () => {
    const args = buildCurlProbeArgs(url);
    const joined = args.join(" ");
    // Should discard the response body
    expect(joined).toMatch(/-o\s+\/dev\/null|--output\s+\/dev\/null/);
  });

  test("does NOT follow redirects (no -L / --location)", () => {
    const args = buildCurlProbeArgs(url);
    expect(args).not.toContain("-L");
    expect(args).not.toContain("--location");
    // Check combined short flags too
    for (const arg of args) {
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        expect(arg).not.toMatch(/L/);
      }
    }
  });

  test("restricts to HTTPS protocol only (--proto =https or similar)", () => {
    const args = buildCurlProbeArgs(url);
    const joined = args.join(" ");
    // Must restrict to https so http-downgrade can't sneak through
    expect(joined).toMatch(/--proto[= ]=https|--proto[= ]https/);
  });

  test("first element is 'curl' binary name", () => {
    const args = buildCurlProbeArgs(url);
    expect(args[0]).toBe("curl");
  });

  test("returns an array (not a string)", () => {
    const args = buildCurlProbeArgs(url);
    expect(Array.isArray(args)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCurlProbeResult
// ---------------------------------------------------------------------------

describe("parseCurlProbeResult: HTTP status parser", () => {
  test("stdout '200', exit 0 → { status: 200, ok: true }", () => {
    const result = parseCurlProbeResult("200", 0);
    expect(result).toEqual({ status: 200, ok: true });
  });

  test("stdout '200\\n', exit 0 → { status: 200, ok: true } (handles trailing newline)", () => {
    const result = parseCurlProbeResult("200\n", 0);
    expect(result).toEqual({ status: 200, ok: true });
  });

  test("stdout '301', exit 0 → { status: 301, ok: false } (no redirect-following)", () => {
    const result = parseCurlProbeResult("301", 0);
    expect(result).toEqual({ status: 301, ok: false });
  });

  test("stdout '502', exit 0 → { status: 502, ok: false }", () => {
    const result = parseCurlProbeResult("502", 0);
    expect(result).toEqual({ status: 502, ok: false });
  });

  test("stdout '000', exit non-zero → { status: 0, ok: false } (TLS failure / connection error)", () => {
    // curl emits 000 and exit-code 60 on cert verify failure, 6 on DNS failure, etc.
    const result = parseCurlProbeResult("000", 60);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  test("stdout '000', exit 6 → ok: false (DNS resolve failure)", () => {
    const result = parseCurlProbeResult("000", 6);
    expect(result.ok).toBe(false);
  });

  test("non-zero exit code forces ok: false regardless of stdout", () => {
    // Even if stdout somehow says 200 but curl exits non-zero, treat as failure
    const result = parseCurlProbeResult("200", 1);
    expect(result.ok).toBe(false);
  });

  test("empty stdout, non-zero exit → { status: 0, ok: false }", () => {
    const result = parseCurlProbeResult("", 1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  test("stdout '404', exit 0 → { status: 404, ok: false }", () => {
    const result = parseCurlProbeResult("404", 0);
    expect(result).toEqual({ status: 404, ok: false });
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL_PROBE_RETRIES value (bumped from 5 → 8 for CF edge provisioning lag)
// ---------------------------------------------------------------------------

describe("EXTERNAL_PROBE_RETRIES cap", () => {
  test("EXTERNAL_PROBE_RETRIES export is 8 (bumped for CF edge provisioning lag)", () => {
    // Import the exported constant to confirm the cap was bumped.
    // We can infer this from the probe behavior: with a fake that always
    // returns 502, the probe must be called at most 8 times (not 5).
    // We test this directly against the exported constant.
    const { EXTERNAL_PROBE_RETRIES_EXPORT } = require("../src/commands/env.ts");
    expect(EXTERNAL_PROBE_RETRIES_EXPORT).toBe(8);
  });
});
