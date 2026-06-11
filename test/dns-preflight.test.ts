import { describe, expect, test } from "bun:test";
import {
  classifyAuthority,
  evaluateDnsPreflight,
  evaluateWildcard,
  type LookupResult,
} from "../src/dns/preflight.ts";

const records = (...values: string[]): LookupResult => ({ kind: "records", values });
const NX: LookupResult = { kind: "nxdomain" };
const ERR: LookupResult = { kind: "error", message: "SERVFAIL" };

describe("classifyAuthority", () => {
  test("cloudflare NS (live samo.team shape: derek/jade)", () => {
    expect(
      classifyAuthority(records("derek.ns.cloudflare.com", "jade.ns.cloudflare.com")),
    ).toBe("cloudflare");
  });

  test("namecheap NS (live samo.cat shape: registrar-servers)", () => {
    expect(
      classifyAuthority(records("dns1.registrar-servers.com", "dns2.registrar-servers.com")),
    ).toBe("namecheap");
  });

  test("mixed or unrecognized NS → other", () => {
    expect(classifyAuthority(records("ns1.example-dns.org"))).toBe("other");
    expect(
      classifyAuthority(records("derek.ns.cloudflare.com", "dns1.registrar-servers.com")),
    ).toBe("other");
  });

  test("failed/empty lookup → unresolved", () => {
    expect(classifyAuthority(NX)).toBe("unresolved");
    expect(classifyAuthority(ERR)).toBe("unresolved");
    expect(classifyAuthority(records())).toBe("unresolved");
  });

  test("case and trailing dots tolerated", () => {
    expect(classifyAuthority(records("DEREK.NS.CLOUDFLARE.COM."))).toBe("cloudflare");
  });
});

describe("evaluateWildcard", () => {
  test("nxdomain → absent (live samo.cat shape today)", () => {
    expect(evaluateWildcard(NX, "178.105.246.151")).toBe("absent");
  });

  test("resolves to the expected ip → present", () => {
    expect(evaluateWildcard(records("178.105.246.151"), "178.105.246.151")).toBe("present");
  });

  test("resolves elsewhere → mismatch", () => {
    expect(evaluateWildcard(records("1.2.3.4"), "178.105.246.151")).toBe("mismatch");
  });

  test("no expected ip: any resolution counts as present", () => {
    expect(evaluateWildcard(records("1.2.3.4"))).toBe("present");
  });

  test("resolver error → unknown", () => {
    expect(evaluateWildcard(ERR, "178.105.246.151")).toBe("unknown");
  });
});

describe("evaluateDnsPreflight", () => {
  const base = {
    domain: "samo.cat",
    expectedIp: "178.105.246.151",
    cloudflareZones: ["samo.team", "samo.green"],
  };

  test("LIVE samo.cat shape: namecheap + no wildcard → nothing ready, both reasons", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("dns1.registrar-servers.com", "dns2.registrar-servers.com"),
      wildcardProbe: NX,
      cloudflareTokenPresent: true,
    });
    expect(r.authority).toBe("namecheap");
    expect(r.wildcard).toBe("absent");
    expect(r.servingReady).toBe(false);
    expect(r.automationReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("no wildcard");
    expect(r.reasons.join("\n")).toContain("Namecheap");
    expect(r.reasons.join("\n")).toContain("no Namecheap provider");
  });

  test("manual wildcard at namecheap: serving ready, automation not", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("dns1.registrar-servers.com"),
      wildcardProbe: records("178.105.246.151"),
      cloudflareTokenPresent: false,
    });
    expect(r.servingReady).toBe(true);
    expect(r.automationReady).toBe(false);
  });

  test("cloudflare + token + zone covered + wildcard → fully ready, no reasons", () => {
    const r = evaluateDnsPreflight({
      domain: "samo.team",
      expectedIp: "178.105.246.151",
      cloudflareZones: ["samo.team", "samo.green"],
      ns: records("derek.ns.cloudflare.com", "jade.ns.cloudflare.com"),
      wildcardProbe: records("178.105.246.151"),
      cloudflareTokenPresent: true,
    });
    expect(r.servingReady).toBe(true);
    expect(r.automationReady).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("cloudflare authority but zone NOT covered by the token → automation blocked with zone reason", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("derek.ns.cloudflare.com"),
      wildcardProbe: records("178.105.246.151"),
      cloudflareTokenPresent: true,
    });
    expect(r.automationReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("samo.team, samo.green");
    expect(r.reasons.join("\n")).toContain("zone-scoped token");
  });

  test("cloudflare authority but token missing → automation blocked with token reason", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("derek.ns.cloudflare.com"),
      wildcardProbe: NX,
      cloudflareTokenPresent: false,
    });
    expect(r.automationReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("CLOUDFLARE_API_TOKEN is not set");
  });

  test("wildcard mismatch is called out with the expected ip and observed ips", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("dns1.registrar-servers.com"),
      wildcardProbe: records("9.9.9.9"),
      cloudflareTokenPresent: false,
    });
    expect(r.wildcard).toBe("mismatch");
    expect(r.wildcardSource).toBe("public-dns");
    expect(r.servingReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("178.105.246.151");
    expect(r.reasons.join("\n")).toContain("9.9.9.9");
  });
});

// ---------------------------------------------------------------------------
// Cloudflare proxied (orange-cloud) semantics
// ---------------------------------------------------------------------------

describe("evaluateDnsPreflight — proxied records", () => {
  const CF_NS = records("derek.ns.cloudflare.com", "jade.ns.cloudflare.com");
  /** The LIVE samo.cat shape after the fix: proxied A → origin, edge IPs public. */
  const liveProxied = {
    domain: "samo.cat",
    expectedIp: "178.105.246.151",
    cloudflareZones: ["samo.cat"],
    ns: CF_NS,
    wildcardProbe: records("104.21.51.28", "172.67.220.4"), // CF edge IPs
    cloudflareTokenPresent: true,
  };

  test("LIVE shape: proxied A -> expected origin => present + fully ready, edge IPs are NOT a mismatch", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      cfWildcardRecord: { found: true, content: "178.105.246.151", proxied: true },
    });
    expect(r.wildcard).toBe("present");
    expect(r.wildcardSource).toBe("cloudflare-api");
    expect(r.proxied).toBe(true);
    expect(r.servingReady).toBe(true);
    expect(r.automationReady).toBe(true);
    expect(r.observedIps).toEqual(["104.21.51.28", "172.67.220.4"]);
    expect(r.reasons).toEqual([]);
  });

  test("CF record targeting the WRONG origin still blocks, even though it's proxied", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      cfWildcardRecord: { found: true, content: "1.2.3.4", proxied: true },
    });
    expect(r.wildcard).toBe("mismatch");
    expect(r.servingReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("1.2.3.4");
    expect(r.reasons.join("\n")).toContain("178.105.246.151");
  });

  test("CF record correct but public DNS not resolving yet => absent (propagation pending)", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      wildcardProbe: NX,
      cfWildcardRecord: { found: true, content: "178.105.246.151", proxied: true },
    });
    expect(r.wildcard).toBe("absent");
    expect(r.servingReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("propagation");
  });

  test("zone has NO wildcard record at the API => absent, regardless of public cache", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      cfWildcardRecord: { found: false },
    });
    expect(r.wildcard).toBe("absent");
    expect(r.reasons.join("\n")).toContain("no A record");
    expect(r.reasons.join("\n")).toContain("stale cache");
  });

  test("UNPROXIED CF record -> expected origin: public probe must match directly too", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      wildcardProbe: records("178.105.246.151"),
      cfWildcardRecord: { found: true, content: "178.105.246.151", proxied: false },
    });
    expect(r.wildcard).toBe("present");
    expect(r.proxied).toBe(false);
    expect(r.servingReady).toBe(true);
  });

  test("NO API data on a Cloudflare zone: edge-looking IPs => unknown (never false mismatch)", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      cloudflareTokenPresent: false,
      // no cfWildcardRecord — token missing
    });
    expect(r.wildcard).toBe("unknown");
    expect(r.wildcardSource).toBe("public-dns");
    expect(r.servingReady).toBe(false);
    expect(r.automationReady).toBe(false);
    const joined = r.reasons.join("\n");
    expect(joined).toContain("proxied edge IPs");
    expect(joined).toContain("104.21.51.28");
    expect(joined).not.toContain("wildcard mismatch");
  });

  test("non-Cloudflare authority keeps direct mismatch semantics (no proxy excuse)", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      ns: records("dns1.registrar-servers.com"),
      cloudflareTokenPresent: false,
    });
    expect(r.wildcard).toBe("mismatch");
  });

  test("CF lookup error is surfaced as a reason and judgment falls back to public DNS", () => {
    const r = evaluateDnsPreflight({
      ...liveProxied,
      cfLookupError: "cloudflare api 403: 9109 Invalid access token",
    });
    expect(r.wildcard).toBe("unknown"); // public-dns fallback on a CF zone
    expect(r.reasons.join("\n")).toContain("cloudflare api read failed");
  });
});
