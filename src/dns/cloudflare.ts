/**
 * DNS provider port + Cloudflare adapter (SPEC-DELTA §5).
 *
 * The port mirrors the VM `Provider` seam: a narrow interface so a Namecheap
 * (or other) adapter can be added without touching callers. The Cloudflare
 * implementation uses injected `fetch` and is fully unit-tested against mocks;
 * NOTHING in the CLI calls the write methods today (live DNS writes are out of
 * scope until a samo.cat-scoped token is provisioned and the manager approves
 * the cutover) — the adapter exists so the automation path is typed, tested,
 * and ready.
 *
 * Token handling: supplied at construction from the environment at call time,
 * sent only as the Authorization header, never logged, never persisted. The
 * zone id is explicit config — zone-scoped tokens often lack the list-zones
 * scope, so we never try to discover it.
 */

import type { CfWildcardRecord } from "./preflight.ts";

export interface DnsRecord {
  id: string;
  type: string;
  /** Fully-qualified record name (e.g. `*.samo.cat`). */
  name: string;
  content: string;
  proxied: boolean;
}

export interface DnsProviderPort {
  /** Records matching (name, type) in the zone. */
  listRecords(name: string, type: string): Promise<DnsRecord[]>;
  /** Create or update so exactly one (name, type) record has this content. */
  ensureRecord(
    name: string,
    type: string,
    content: string,
    proxied: boolean,
  ): Promise<DnsRecord>;
  /** Remove all (name, type) records. Returns how many were removed. */
  removeRecord(name: string, type: string): Promise<number>;
}

export class CloudflareError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`cloudflare api ${status}: ${message}`);
    this.name = "CloudflareError";
    this.status = status;
  }
}

const API = "https://api.cloudflare.com/client/v4";

/** The callable part of fetch — all the adapter needs (and all tests fake). */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

/**
 * READ-ONLY: fetch the wildcard A record for a zone by NAME (two GETs: zone
 * lookup, then record lookup). Used by `dns status` to verify origin targeting
 * of proxied records — public DNS cannot (it sees edge IPs). Requires a token
 * with Zone:Read + DNS:Read on the zone. Never writes anything.
 */
export async function lookupWildcardRecord(
  opts: { token: string; fetchFn?: FetchFn },
  zoneName: string,
  recordName: string,
): Promise<CfWildcardRecord> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${API}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
    });
    let parsed: CfEnvelope<T>;
    try {
      parsed = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareError(res.status, "non-JSON response");
    }
    if (!res.ok || !parsed.success) {
      const msg =
        parsed.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ||
        "request failed";
      throw new CloudflareError(res.status, msg);
    }
    return parsed.result;
  };

  const zones = await get<Array<{ id: string }>>(
    `/zones?name=${encodeURIComponent(zoneName)}`,
  );
  if (zones.length === 0) {
    throw new CloudflareError(
      404,
      `no zone named ${zoneName} visible to this token`,
    );
  }
  const records = await get<
    Array<{ content: string; proxied?: boolean }>
  >(
    `/zones/${zones[0]!.id}/dns_records?type=A&name=${encodeURIComponent(recordName)}`,
  );
  if (records.length === 0) return { found: false };
  return {
    found: true,
    content: records[0]!.content,
    proxied: records[0]!.proxied ?? false,
  };
}

export class CloudflareDns implements DnsProviderPort {
  private readonly token: string;
  private readonly zoneId: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: { token: string; zoneId: string; fetchFn?: FetchFn }) {
    this.token = opts.token;
    this.zoneId = opts.zoneId;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(`${API}/zones/${this.zoneId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: CfEnvelope<T>;
    try {
      parsed = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareError(res.status, "non-JSON response");
    }
    if (!res.ok || !parsed.success) {
      // Error messages from the API are safe to surface; the token never is.
      const msg =
        parsed.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ||
        "request failed";
      throw new CloudflareError(res.status, msg);
    }
    return parsed.result;
  }

  async listRecords(name: string, type: string): Promise<DnsRecord[]> {
    const q = `?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
    const result = await this.call<DnsRecord[]>("GET", `/dns_records${q}`);
    return result;
  }

  async ensureRecord(
    name: string,
    type: string,
    content: string,
    proxied: boolean,
  ): Promise<DnsRecord> {
    const existing = await this.listRecords(name, type);
    const payload = { type, name, content, proxied, ttl: 1 };
    if (existing.length === 0) {
      return this.call<DnsRecord>("POST", "/dns_records", payload);
    }
    const first = existing[0]!;
    if (first.content === content && first.proxied === proxied) {
      return first; // already correct — no write
    }
    return this.call<DnsRecord>(
      "PUT",
      `/dns_records/${first.id}`,
      payload,
    );
  }

  async removeRecord(name: string, type: string): Promise<number> {
    const existing = await this.listRecords(name, type);
    for (const rec of existing) {
      await this.call<unknown>("DELETE", `/dns_records/${rec.id}`);
    }
    return existing.length;
  }
}
