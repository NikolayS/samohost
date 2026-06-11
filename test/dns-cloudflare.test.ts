import { describe, expect, test } from "bun:test";
import { CloudflareDns, CloudflareError, type FetchFn } from "../src/dns/cloudflare.ts";

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

/** Scripted fetch: pops responses in order, records calls. */
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
const REC = {
  id: "rec-1",
  type: "A",
  name: "*.samo.cat",
  content: "178.105.246.151",
  proxied: false,
};

function dns(fetchFn: FetchFn): CloudflareDns {
  return new CloudflareDns({ token: "test-token", zoneId: "zone-1", fetchFn });
}

describe("CloudflareDns", () => {
  test("listRecords queries by name+type with the bearer header", async () => {
    const f = fakeFetch([ok([REC])]);
    const recs = await dns(f.fn).listRecords("*.samo.cat", "A");
    expect(recs).toEqual([REC]);
    expect(f.calls[0]!.url).toContain("/zones/zone-1/dns_records?type=A&name=");
    expect(f.calls[0]!.url).toContain(encodeURIComponent("*.samo.cat"));
    expect(f.calls[0]!.auth).toBe("Bearer test-token");
  });

  test("ensureRecord creates when absent", async () => {
    const f = fakeFetch([ok([]), ok(REC)]);
    const rec = await dns(f.fn).ensureRecord("*.samo.cat", "A", "178.105.246.151", false);
    expect(rec).toEqual(REC);
    expect(f.calls[1]!.method).toBe("POST");
    expect(f.calls[1]!.body).toMatchObject({
      type: "A",
      name: "*.samo.cat",
      content: "178.105.246.151",
    });
  });

  test("ensureRecord is a no-op when the record already matches", async () => {
    const f = fakeFetch([ok([REC])]);
    const rec = await dns(f.fn).ensureRecord("*.samo.cat", "A", "178.105.246.151", false);
    expect(rec).toEqual(REC);
    expect(f.calls).toHaveLength(1); // GET only — no write
  });

  test("ensureRecord updates in place when content differs", async () => {
    const f = fakeFetch([
      ok([{ ...REC, content: "1.2.3.4" }]),
      ok(REC),
    ]);
    await dns(f.fn).ensureRecord("*.samo.cat", "A", "178.105.246.151", false);
    expect(f.calls[1]!.method).toBe("PUT");
    expect(f.calls[1]!.url).toContain("/dns_records/rec-1");
  });

  test("removeRecord deletes every match and reports the count", async () => {
    const f = fakeFetch([
      ok([REC, { ...REC, id: "rec-2" }]),
      ok({ id: "rec-1" }),
      ok({ id: "rec-2" }),
    ]);
    expect(await dns(f.fn).removeRecord("*.samo.cat", "A")).toBe(2);
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  test("API errors surface code+message but never the token", async () => {
    const f = fakeFetch([
      {
        status: 403,
        json: { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null },
      },
    ]);
    try {
      await dns(f.fn).listRecords("*.samo.cat", "A");
      throw new Error("expected CloudflareError");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareError);
      expect((e as Error).message).toContain("9109");
      expect((e as Error).message).not.toContain("test-token");
    }
  });
});
