/**
 * Hetzner adapter tests (SPEC §6: "Provider adapters against recorded/mocked
 * HTTP — no real cloud calls in CI").
 *
 * fetch is injected; every response body here is a fixture matching the
 * documented Hetzner Cloud API v1 shape (test/fixtures/hetzner/*.json —
 * verified against https://docs.hetzner.cloud: POST /servers returns
 * {server, action, next_actions, root_password}, GET /servers/{id} returns
 * {server}, DELETE returns {action}, errors are {error:{code,message}}).
 *
 * Credential rules under test:
 *  - HCLOUD_TOKEN is read at CALL time (env), never at construction;
 *  - the token value never appears in any error message (normalizeError redacts);
 *  - the create response's root_password is NEVER surfaced in the mapped result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SAMOHOST_ID_LABEL,
  type CreateServerSpec,
  type ProviderError,
} from "../src/providers/types.ts";
import { HetznerProvider, HETZNER_BASE_URL } from "../src/providers/hetzner.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "hetzner");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const TEST_TOKEN = "hcloudFIXTUREtokenAAAABBBBCCCCDDDDEEEEFFFF0123456789";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface QueuedResponse {
  status: number;
  body: unknown;
}

/** Minimal fetch mock: replays queued responses, records every call. */
function mockFetch(queue: QueuedResponse[]): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`mockFetch: unexpected extra call to ${url}`);
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const SPEC: CreateServerSpec = {
  name: "samo-test-vm",
  serverType: "cx22",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config\npackage_update: true\n",
  labels: {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [SAMOHOST_ID_LABEL]: "00000000-0000-4000-8000-000000000001",
  },
};

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env["HCLOUD_TOKEN"];
  process.env["HCLOUD_TOKEN"] = TEST_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env["HCLOUD_TOKEN"];
  else process.env["HCLOUD_TOKEN"] = savedToken;
});

describe("HetznerProvider.create", () => {
  test("POSTs /v1/servers with bearer token, labels, user_data — and NO ssh_keys", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: fixture("create-server.json") },
    ]);
    const provider = new HetznerProvider({ fetch });

    const info = await provider.create(SPEC);

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${HETZNER_BASE_URL}/servers`);
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call.headers["content-type"]).toContain("application/json");

    const body = call.body as Record<string, unknown>;
    expect(body["name"]).toBe("samo-test-vm");
    expect(body["server_type"]).toBe("cx22");
    expect(body["image"]).toBe("ubuntu-24.04");
    expect(body["location"]).toBe("nbg1");
    expect(body["user_data"]).toBe(SPEC.userData);
    expect(body["start_after_create"]).toBe(true);
    expect(body["labels"]).toEqual(SPEC.labels);
    // Keys are cloud-init-only (baseline plants the operator pubkey for the
    // non-root user; root login + password auth are disabled). No Hetzner-side
    // key resource is created — see PR notes.
    expect("ssh_keys" in body).toBe(false);
    // We must never enable delete protection.
    expect("protection" in body).toBe(false);

    expect(info.providerId).toBe("4711");
    expect(info.name).toBe("samo-test-vm");
    expect(info.status).toBe("initializing");
    expect(info.ipv4).toBe("192.0.2.10");
    expect(info.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
  });

  test("the create response's root_password never surfaces in the result", async () => {
    const { fetch } = mockFetch([
      { status: 201, body: fixture("create-server.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    const info = await provider.create(SPEC);
    expect(JSON.stringify(info)).not.toContain("FIXTUREonlyRootPw");
  });

  test("token is read at call time and a missing token maps to auth without any HTTP call", async () => {
    const { fetch, calls } = mockFetch([]);
    const provider = new HetznerProvider({ fetch });
    delete process.env["HCLOUD_TOKEN"];

    let thrown: unknown;
    try {
      await provider.create(SPEC);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(calls.length).toBe(0);

    const norm = provider.normalizeError(thrown);
    expect(norm.kind).toBe("auth");
    expect(norm.message).toContain("HCLOUD_TOKEN");
  });
});

describe("HetznerProvider.get / list", () => {
  test("get maps status, ipv4 and volume ids", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: fixture("get-server-running.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    const info = await provider.get("4711");
    expect(calls[0]!.url).toBe(`${HETZNER_BASE_URL}/servers/4711`);
    expect(calls[0]!.method).toBe("GET");
    expect(info.status).toBe("running");
    expect(info.ipv4).toBe("192.0.2.10");
    expect(info.volumeIds).toEqual(["70101", "70102"]);
  });

  test("get maps a not-yet-running server", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: fixture("get-server-initializing.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    const info = await provider.get("4711");
    expect(info.status).toBe("initializing");
  });

  test("list filters by managed-by=samohost label selector", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: fixture("list-servers.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    const servers = await provider.list();
    const url = new URL(calls[0]!.url);
    expect(url.pathname.endsWith("/servers")).toBe(true);
    expect(url.searchParams.get("label_selector")).toBe(
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    );
    expect(servers.length).toBe(2);
    expect(servers[0]!.providerId).toBe("4711");
    expect(servers[1]!.status).toBe("off");
    expect(servers[1]!.ipv4).toBeNull();
    expect(servers[1]!.volumeIds).toEqual(["70103"]);
  });
});

describe("HetznerProvider.destroy", () => {
  test("issues exactly one DELETE and never touches protection endpoints", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: fixture("delete-server.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    await provider.destroy("4711");
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${HETZNER_BASE_URL}/servers/4711`);
    expect(calls[0]!.url).not.toContain("protection");
  });
});

describe("HetznerProvider.listVolumes", () => {
  test("resolves the server's volume ids to id/name/size details", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: fixture("get-server-running.json") },
      { status: 200, body: fixture("get-volume.json") },
      {
        status: 200,
        body: {
          volume: { id: 70102, name: "samo-test-wal", size: 10, server: 4711 },
        },
      },
    ]);
    const provider = new HetznerProvider({ fetch });
    const volumes = await provider.listVolumes("4711");
    expect(calls.map((c) => c.url)).toEqual([
      `${HETZNER_BASE_URL}/servers/4711`,
      `${HETZNER_BASE_URL}/volumes/70101`,
      `${HETZNER_BASE_URL}/volumes/70102`,
    ]);
    expect(volumes).toEqual([
      { id: "70101", name: "samo-test-data", sizeGb: 50 },
      { id: "70102", name: "samo-test-wal", sizeGb: 10 },
    ]);
  });

  test("a server without volumes yields an empty list with one call", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: fixture("get-server-initializing.json") },
    ]);
    const provider = new HetznerProvider({ fetch });
    const volumes = await provider.listVolumes("4711");
    expect(volumes).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe("HetznerProvider.normalizeError — taxonomy mapping", () => {
  async function errorFor(
    status: number,
    body: unknown,
  ): Promise<ProviderError> {
    const { fetch } = mockFetch([{ status, body }]);
    const provider = new HetznerProvider({ fetch });
    try {
      await provider.get("4711");
    } catch (e) {
      return provider.normalizeError(e);
    }
    throw new Error(`expected status ${status} to throw`);
  }

  const err = (code: string, message: string) => ({ error: { code, message } });

  const TABLE: Array<[number, unknown, ProviderError["kind"]]> = [
    [401, err("unauthorized", "unable to authenticate"), "auth"],
    [403, err("forbidden", "insufficient permissions"), "auth"],
    [404, err("not_found", "server not found"), "notFound"],
    [429, err("rate_limit_exceeded", "rate limit exceeded"), "rate"],
    [500, err("unknown_error", "internal error"), "transient"],
    [503, err("unavailable", "service temporarily unavailable"), "transient"],
    // resource_limit_exceeded wins over its HTTP status (Hetzner sends 403).
    [403, fixture("error-resource-limit.json"), "quota"],
    [422, err("invalid_input", "invalid server name"), "unknown"],
  ];

  for (const [status, body, kind] of TABLE) {
    test(`HTTP ${status} ${(body as { error: { code: string } }).error.code} → ${kind}`, async () => {
      const norm = await errorFor(status, body);
      expect(norm.kind).toBe(kind);
      expect(norm.message.length).toBeGreaterThan(0);
    });
  }

  test("a thrown network error (fetch failed) → transient", () => {
    const provider = new HetznerProvider({
      fetch: (() => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(provider.normalizeError(new TypeError("fetch failed")).kind).toBe(
      "transient",
    );
  });

  test("arbitrary junk → unknown", () => {
    const { fetch } = mockFetch([]);
    const provider = new HetznerProvider({ fetch });
    expect(provider.normalizeError("boom").kind).toBe("unknown");
    expect(provider.normalizeError(undefined).kind).toBe("unknown");
  });

  test("normalizeError REDACTS the live token value from messages", async () => {
    // Simulate a pathological error body that echoes the Authorization header.
    const norm = await errorFor(401, {
      error: {
        code: "unauthorized",
        message: `unable to authenticate with Bearer ${TEST_TOKEN}`,
      },
    });
    expect(norm.message).not.toContain(TEST_TOKEN);
    expect(norm.message).toContain("[REDACTED]");
  });
});
