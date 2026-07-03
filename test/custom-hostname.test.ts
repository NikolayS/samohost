/**
 * Tests for CloudflareDns custom hostname methods.
 *
 * Uses the same fakeFetch pattern as dns-cloudflare.test.ts.
 * All response shapes are taken verbatim from the Cloudflare for SaaS
 * Custom Hostnames API (docs.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
 * domain-support/custom-hostnames/), not guessed.
 */

import { describe, expect, test } from "bun:test";
import {
  CloudflareDns,
  CloudflareError,
  type FetchFn,
  type CustomHostname,
} from "../src/dns/cloudflare.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fn: FetchFn = (input, init) => {
    const r = responses.shift();
    if (!r) throw new Error("fakeFetch: no scripted response left");
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>)?.["authorization"],
    });
    return Promise.resolve(
      new Response(JSON.stringify(r.json), { status: r.status ?? 200 }),
    );
  };
  return { fn, calls };
}

const ok = (result: unknown) => ({ json: { success: true, errors: [], result } });
const err = (status: number, code: number, message: string) => ({
  status,
  json: { success: false, errors: [{ code, message }], result: null },
});

// Real-shaped fixture from the CF API docs
const CH_PENDING: CustomHostname = {
  id: "ch-abc123",
  hostname: "myapp.com",
  status: "pending",
  ssl: {
    id: "ssl-xyz",
    status: "pending_validation",
    method: "http",
    validation_records: [
      {
        http_url: "http://myapp.com/.well-known/pki-validation/abc.txt",
        http_body: "dummytoken123",
      },
    ],
  },
  ownership_verification: {
    type: "txt",
    name: "_cf-custom-hostname.myapp.com",
    value: "ownership-token-abc",
  },
  verification_errors: [],
};

const CH_ACTIVE: CustomHostname = {
  id: "ch-abc123",
  hostname: "myapp.com",
  status: "active",
  ssl: {
    id: "ssl-xyz",
    status: "active",
    method: "http",
    validation_records: [],
  },
};

function dns(fetchFn: FetchFn): CloudflareDns {
  // Use a pre-resolved zoneId so zone-lookup GETs do not appear in the call sequence
  return new CloudflareDns({ token: "test-token", zoneId: "zone-saas", fetchFn });
}

// ---------------------------------------------------------------------------
// createCustomHostname
// ---------------------------------------------------------------------------

describe("CloudflareDns.createCustomHostname", () => {
  test("POSTs to /custom_hostnames with correct body and returns a pending CustomHostname", async () => {
    const f = fakeFetch([ok(CH_PENDING)]);
    const result = await dns(f.fn).createCustomHostname("myapp.com", "http");
    expect(result).toEqual(CH_PENDING);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/zones/zone-saas/custom_hostnames");
    expect(call.auth).toBe("Bearer test-token");
    expect(call.body).toEqual({
      hostname: "myapp.com",
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
  });

  test("defaults DCV method to 'txt' (not http — CP serves HTTPS-only, http-DCV stalls)", async () => {
    // Bug #114: http-DCV requires serving a token at /.well-known/pki-validation/
    // on plain HTTP port 80. Our control plane is HTTPS-only, so http-DCV
    // permanently stalls. Default must be txt so the CNAME delegation path is used.
    const f = fakeFetch([ok(CH_PENDING)]);
    await dns(f.fn).createCustomHostname("myapp.com");
    expect(f.calls[0]!.body).toMatchObject({
      ssl: { method: "txt" },
    });
  });

  test("accepts txt DCV method", async () => {
    const f = fakeFetch([ok({ ...CH_PENDING, ssl: { ...CH_PENDING.ssl, method: "txt" } })]);
    await dns(f.fn).createCustomHostname("myapp.com", "txt");
    expect(f.calls[0]!.body).toMatchObject({
      ssl: { method: "txt" },
    });
  });

  test("surfaces CF errors as CloudflareError", async () => {
    const f = fakeFetch([err(403, 1004, "Custom hostname not allowed on this zone")]);
    try {
      await dns(f.fn).createCustomHostname("myapp.com");
      throw new Error("expected CloudflareError");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareError);
      expect((e as CloudflareError).status).toBe(403);
      expect((e as Error).message).toContain("1004");
      expect((e as Error).message).not.toContain("test-token");
    }
  });
});

// ---------------------------------------------------------------------------
// getCustomHostname
// ---------------------------------------------------------------------------

describe("CloudflareDns.getCustomHostname", () => {
  test("GETs /custom_hostnames/<id> and returns the CustomHostname", async () => {
    const f = fakeFetch([ok(CH_ACTIVE)]);
    const result = await dns(f.fn).getCustomHostname("ch-abc123");
    expect(result).toEqual(CH_ACTIVE);
    expect(f.calls[0]!.method).toBe("GET");
    expect(f.calls[0]!.url).toContain("/custom_hostnames/ch-abc123");
  });

  test("returns pending state with validation_records", async () => {
    const f = fakeFetch([ok(CH_PENDING)]);
    const result = await dns(f.fn).getCustomHostname("ch-abc123");
    expect(result.ssl.status).toBe("pending_validation");
    expect(result.ssl.validation_records).toBeDefined();
    expect(result.ssl.validation_records!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listCustomHostnames
// ---------------------------------------------------------------------------

describe("CloudflareDns.listCustomHostnames", () => {
  test("GETs /custom_hostnames and returns array", async () => {
    const f = fakeFetch([ok([CH_PENDING, CH_ACTIVE])]);
    const result = await dns(f.fn).listCustomHostnames();
    expect(result).toHaveLength(2);
    expect(f.calls[0]!.url).toContain("/custom_hostnames");
    expect(f.calls[0]!.url).not.toContain("hostname=");
  });

  test("filters by hostname query param when provided", async () => {
    const f = fakeFetch([ok([CH_PENDING])]);
    const result = await dns(f.fn).listCustomHostnames("myapp.com");
    expect(result).toHaveLength(1);
    expect(f.calls[0]!.url).toContain("hostname=myapp.com");
  });

  test("returns empty array when no match", async () => {
    const f = fakeFetch([ok([])]);
    const result = await dns(f.fn).listCustomHostnames("unknown.com");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteCustomHostname
// ---------------------------------------------------------------------------

describe("CloudflareDns.deleteCustomHostname", () => {
  test("DELETEs /custom_hostnames/<id> and returns id object", async () => {
    const f = fakeFetch([ok({ id: "ch-abc123" })]);
    const result = await dns(f.fn).deleteCustomHostname("ch-abc123");
    expect(result).toEqual({ id: "ch-abc123" });
    expect(f.calls[0]!.method).toBe("DELETE");
    expect(f.calls[0]!.url).toContain("/custom_hostnames/ch-abc123");
  });

  test("surfaces CF errors as CloudflareError on delete", async () => {
    const f = fakeFetch([err(404, 1001, "custom hostname not found")]);
    try {
      await dns(f.fn).deleteCustomHostname("ch-gone");
      throw new Error("expected CloudflareError");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareError);
      expect((e as CloudflareError).status).toBe(404);
    }
  });
});
