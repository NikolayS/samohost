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
    // Exactly one warning line on stderr, containing the expected prefix.
    expect(errLines.length).toBe(1);
    expect(errLines[0]).toContain("RDAP probe failed");
  });
});

// ---------------------------------------------------------------------------
// note field — rdap.org false-positive caveat (Finding 1)
// ---------------------------------------------------------------------------

describe("runDomainSearch — note field", () => {
  test("available result carries a note about the rdap.org false-positive risk", async () => {
    // KNOWN LIMITATION: rdap.org returns HTTP 404 both for genuinely-unregistered
    // domains AND for TLDs whose registries have no RDAP support. The two cases are
    // runtime-indistinguishable — we cannot tell them apart from the HTTP response
    // alone. The `note` field surfaces this caveat so callers can warn users.
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(404) };
    const input: DomainSearchInput = { fqdn: "zzq-rdap-false-positive.xyz" };

    await runDomainSearch(input, { json: false }, deps, out, err);

    const text = outLines.join("\n");
    expect(text).toMatch(/rdap\.org/i);
    expect(text).toMatch(/registrar/i);
  });

  test("taken result does NOT carry a note (no false-positive risk for HTTP 200)", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(200, '{"ldhName":"taken.com"}') };
    const input: DomainSearchInput = { fqdn: "taken.com" };

    await runDomainSearch(input, { json: false }, deps, out, err);

    const text = outLines.join("\n");
    // Taken results are unambiguous; no caveat note should appear.
    expect(text).not.toMatch(/registrar/i);
  });

  test("unknown result does NOT carry a note", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(503) };
    const input: DomainSearchInput = { fqdn: "example.de" };

    await runDomainSearch(input, { json: false }, deps, out, err);

    const text = outLines.join("\n");
    expect(text).not.toMatch(/registrar/i);
  });

  test("--json available result includes 'note' field with caveat text", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(404) };
    const input: DomainSearchInput = { fqdn: "zzq-rdap-json-note.xyz" };

    await runDomainSearch(input, { json: true }, deps, out, err);

    const report = JSON.parse(outLines.join("")) as {
      fqdn: string;
      status: string;
      note?: string;
    };
    expect(report.status).toBe("available");
    expect(typeof report.note).toBe("string");
    expect(report.note).toContain("rdap.org");
    expect(report.note).toContain("registrar");
  });

  test("--json taken result omits 'note' field", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(200, '{"ldhName":"google.com"}') };
    const input: DomainSearchInput = { fqdn: "google.com" };

    await runDomainSearch(input, { json: true }, deps, out, err);

    const report = JSON.parse(outLines.join("")) as Record<string, unknown>;
    expect("note" in report).toBe(false);
  });

  test("--json unknown result omits 'note' field", async () => {
    const { outLines, out, err } = makeOutput();
    const deps: DomainSearchDeps = { fetch: fakeFetch(503) };
    const input: DomainSearchInput = { fqdn: "example.de" };

    await runDomainSearch(input, { json: true }, deps, out, err);

    const report = JSON.parse(outLines.join("")) as Record<string, unknown>;
    expect("note" in report).toBe(false);
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
