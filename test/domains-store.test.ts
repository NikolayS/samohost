import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainStore } from "../src/state/domains.ts";
import type { DomainRecord } from "../src/types.ts";

let dir: string;
let domainsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-domains-"));
  domainsPath = join(dir, "domains.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function domain(
  fqdn: string,
  appName: string,
  vmId: string,
  overrides: Partial<DomainRecord> = {},
): DomainRecord {
  return {
    id: `domain-${fqdn}`,
    fqdn,
    appName,
    vmId,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DomainStore", () => {
  test("upsert then get by fqdn", () => {
    const store = new DomainStore(domainsPath);
    store.upsert(domain("myapp.com", "field-record", "vm-a"));
    expect(existsSync(domainsPath)).toBe(true);

    const reread = new DomainStore(domainsPath);
    const got = reread.get("myapp.com");
    expect(got?.id).toBe("domain-myapp.com");
    expect(got?.fqdn).toBe("myapp.com");
    expect(got?.appName).toBe("field-record");
    expect(reread.get("other.com")).toBeUndefined();
  });

  test("list returns all records", () => {
    const store = new DomainStore(domainsPath);
    store.upsert(domain("myapp.com", "field-record", "vm-a"));
    store.upsert(domain("shop.com", "shop-app", "vm-b"));
    expect(store.list().length).toBe(2);
    expect(store.list().map((d) => d.fqdn).sort()).toEqual([
      "myapp.com",
      "shop.com",
    ]);
  });

  test("upsert replaces by fqdn preserving id", () => {
    const store = new DomainStore(domainsPath);
    const first = store.upsert(
      domain("myapp.com", "field-record", "vm-a", {
        customHostnameId: "ch-old",
      }),
    );
    const second = store.upsert(
      domain("myapp.com", "field-record", "vm-a", {
        id: "DIFFERENT-ID",
        customHostnameId: "ch-new",
      }),
    );
    expect(store.list().length).toBe(1);
    // id of existing record is preserved
    expect(second.id).toBe(first.id);
    expect(store.get("myapp.com")?.customHostnameId).toBe("ch-new");
  });

  test("remove by fqdn", () => {
    const store = new DomainStore(domainsPath);
    store.upsert(domain("myapp.com", "field-record", "vm-a"));
    expect(store.remove("myapp.com")).toBe(true);
    expect(store.remove("myapp.com")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("empty store lists nothing; no tmp leftover after write", () => {
    const store = new DomainStore(domainsPath);
    expect(store.list()).toEqual([]);
    store.upsert(domain("myapp.com", "field-record", "vm-a"));
    expect(existsSync(`${domainsPath}.tmp`)).toBe(false);
  });

  test("stores optional fields: customHostnameId, sslStatus, hostnameStatus, updatedAt", () => {
    const store = new DomainStore(domainsPath);
    store.upsert(
      domain("myapp.com", "field-record", "vm-a", {
        customHostnameId: "ch-abc123",
        sslStatus: "pending_validation",
        hostnameStatus: "pending",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const got = store.get("myapp.com");
    expect(got?.customHostnameId).toBe("ch-abc123");
    expect(got?.sslStatus).toBe("pending_validation");
    expect(got?.hostnameStatus).toBe("pending");
    expect(got?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("crash-safe: recovers from corrupt primary via .bak", () => {
    const store = new DomainStore(domainsPath);
    store.upsert(domain("one.com", "app", "vm-a"));
    store.upsert(domain("two.com", "app", "vm-a")); // second write → bak
    expect(existsSync(`${domainsPath}.bak`)).toBe(true);

    writeFileSync(domainsPath, "{ not json", "utf8");
    const recovered = new DomainStore(domainsPath);
    expect(recovered.list().map((d) => d.fqdn)).toContain("one.com");
  });

  test("defaultDomainsPath honors SAMOHOST_DOMAINS env", async () => {
    const { defaultDomainsPath } = await import("../src/state/domains.ts");
    const orig = process.env["SAMOHOST_DOMAINS"];
    process.env["SAMOHOST_DOMAINS"] = "/tmp/test-domains.json";
    expect(defaultDomainsPath()).toBe("/tmp/test-domains.json");
    if (orig === undefined) {
      delete process.env["SAMOHOST_DOMAINS"];
    } else {
      process.env["SAMOHOST_DOMAINS"] = orig;
    }
  });
});
