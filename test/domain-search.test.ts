/**
 * Tests for `samohost domain search <fqdn>` — RDAP-based availability checker.
 *
 * All fetch calls are injected via DomainSearchDeps so tests run offline.
 * Prod shape rules:
 *   HTTP 404 → "available"
 *   HTTP 200 → "taken"
 *   any other status, or network error → "unknown"
 */

import { describe, expect, test } from "bun:test";
import {
  runDomainSearch,
  type DomainSearchInput,
  type DomainSearchDeps,
} from "../src/commands/domain.ts";

// ---------------------------------------------------------------------------
// Output capture helper
// ---------------------------------------------------------------------------

function makeOutput() {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (s: string) => { outLines.push(s); },
    err: (s: string) => { errLines.push(s); },
  };
}

// ---------------------------------------------------------------------------
// Fake fetch factories
// ---------------------------------------------------------------------------

function fakeFetch(status: number, body = "{}"): DomainSearchDeps["fetch"] {
  return async (_url: string, _init?: RequestInit) =>
    new Response(body, { status });
}

function errorFetch(message: string): DomainSearchDeps["fetch"] {
  return async (_url: string, _init?: RequestInit) => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Text-mode tests
// ---------------------------------------------------------------------------

describe("runDomainSearch — text mode", () => {
  test("HTTP 404 → available", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(404) };
    const input: DomainSearchInput = { fqdn: "zzq-samo-check-99999.com" };

    const code = await runDomainSearch(input, { json: false }, deps, out, err);

    expect(code).toBe(0);
    const text = outLines.join("\n");
    expect(text).toMatch(/available/i);
    expect(text).toContain("zzq-samo-check-99999.com");
  });

  test("HTTP 200 → taken", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = {
      fetch: fakeFetch(200, '{"ldhName":"google.com","status":["active"]}'),
    };
    const input: DomainSearchInput = { fqdn: "google.com" };

    const code = await runDomainSearch(input, { json: false }, deps, out, err);

    expect(code).toBe(0);
    const text = outLines.join("\n");
    expect(text).toMatch(/taken/i);
    expect(text).toContain("google.com");
  });

  test("no-RDAP TLD (e.g. 501) → unknown", async () => {
    const { outLines, out, err } = makeOutput();
    // Some ccTLDs return 501 Not Implemented or redirect; simulate with 501
    const deps: DomainSearchDeps = { fetch: fakeFetch(501) };
    const input: DomainSearchInput = { fqdn: "example.de" };

    const code = await runDomainSearch(input, { json: false }, deps, out, err);

    expect(code).toBe(0);
    const text = outLines.join("\n");
    expect(text).toMatch(/unknown/i);
    expect(text).toContain("example.de");
  });

  test("non-standard 302 status → unknown (inconclusive)", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(302) };
    const input: DomainSearchInput = { fqdn: "example.ar" };

    const code = await runDomainSearch(input, { json: false }, deps, out, err);

    expect(code).toBe(0);
    expect(outLines.join("\n")).toMatch(/unknown/i);
  });

  test("network error → unknown (not a crash)", async () => {
    const { outLines, errLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: errorFetch("network timeout") };
    const input: DomainSearchInput = { fqdn: "example.com" };

    // Must not throw — errors are swallowed into unknown status
    const code = await runDomainSearch(input, { json: false }, deps, out, err);

    expect(code).toBe(0);
    expect(outLines.join("\n")).toMatch(/unknown/i);
    // No uncaught error — err output is optional but if present must not be
    // a thrown exception (just a warning line)
    expect(errLines.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// JSON-mode tests
// ---------------------------------------------------------------------------

describe("runDomainSearch — JSON mode", () => {
  test("--json emits {fqdn, status:'available'} for 404", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(404) };
    const input: DomainSearchInput = { fqdn: "zzq-samo-check-12345.com" };

    const code = await runDomainSearch(input, { json: true }, deps, out, err);

    expect(code).toBe(0);
    const report = JSON.parse(outLines.join("")) as {
      fqdn: string;
      status: string;
    };
    expect(report.fqdn).toBe("zzq-samo-check-12345.com");
    expect(report.status).toBe("available");
  });

  test("--json emits {fqdn, status:'taken'} for 200", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = {
      fetch: fakeFetch(200, '{"ldhName":"google.com"}'),
    };
    const input: DomainSearchInput = { fqdn: "google.com" };

    const code = await runDomainSearch(input, { json: true }, deps, out, err);

    expect(code).toBe(0);
    const report = JSON.parse(outLines.join("")) as {
      fqdn: string;
      status: string;
    };
    expect(report.fqdn).toBe("google.com");
    expect(report.status).toBe("taken");
  });

  test("--json emits {fqdn, status:'unknown'} for non-404/non-200", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(503) };
    const input: DomainSearchInput = { fqdn: "example.de" };

    const code = await runDomainSearch(input, { json: true }, deps, out, err);

    expect(code).toBe(0);
    const report = JSON.parse(outLines.join("")) as {
      fqdn: string;
      status: string;
    };
    expect(report.fqdn).toBe("example.de");
    expect(report.status).toBe("unknown");
  });

  test("--json emits {fqdn, status:'unknown'} on network error", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: errorFetch("ECONNREFUSED") };
    const input: DomainSearchInput = { fqdn: "example.com" };

    const code = await runDomainSearch(input, { json: true }, deps, out, err);

    expect(code).toBe(0);
    const report = JSON.parse(outLines.join("")) as {
      fqdn: string;
      status: string;
    };
    expect(report.fqdn).toBe("example.com");
    expect(report.status).toBe("unknown");
  });

  test("JSON report includes a 'reason' field", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(404) };
    const input: DomainSearchInput = { fqdn: "zzq-test.com" };

    await runDomainSearch(input, { json: true }, deps, out, err);

    const report = JSON.parse(outLines.join("")) as {
      reason: string;
    };
    expect(typeof report.reason).toBe("string");
    expect(report.reason.length).toBeGreaterThan(0);
  });
});
