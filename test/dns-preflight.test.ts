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

  test("wildcard mismatch is called out with the expected ip", () => {
    const r = evaluateDnsPreflight({
      ...base,
      ns: records("dns1.registrar-servers.com"),
      wildcardProbe: records("9.9.9.9"),
      cloudflareTokenPresent: false,
    });
    expect(r.wildcard).toBe("mismatch");
    expect(r.servingReady).toBe(false);
    expect(r.reasons.join("\n")).toContain("178.105.246.151");
  });
});
