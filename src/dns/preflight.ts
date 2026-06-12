/**
 * DNS preflight for preview domains (SPEC-DELTA §5).
 *
 * The SOLO plan serves previews at `<app>-<branch>.samo.cat`. This module
 * turns the domain's DNS situation into a typed, testable report instead of a
 * deploy-time surprise: who is authoritative, does the wildcard exist, and
 * does it actually target the VM.
 *
 * PROXIED (orange-cloud) SEMANTICS — the part naive checks get wrong: for a
 * Cloudflare-proxied record, public DNS returns Cloudflare EDGE IPs by design,
 * never the origin. Comparing public A results against the origin IP therefore
 * proves nothing (live lesson: `*.samo.cat` proxied → 178.105.246.151 was
 * correct, yet the public probe saw 104.21.x/172.67.x and a naive check called
 * it "mismatch"). Origin targeting can only be verified at the Cloudflare API
 * (read-only record fetch). So:
 *
 *   - With CF API data ({@link CfWildcardRecord}): the record's content is
 *     authoritative for origin targeting; the public probe only answers "does
 *     the world resolve it yet" (delegation/propagation).
 *   - Without CF API data on a Cloudflare-authority zone: edge IPs that don't
 *     equal the origin are reported as `unknown` (verification needs a token),
 *     never `mismatch`.
 *   - Non-Cloudflare authority: direct public-DNS comparison, as before.
 *
 * Everything here is PURE — resolver and API results are inputs, so unit
 * tests never touch the network. The command layer (commands/dns.ts) injects
 * live NS/A lookups and the read-only CF record fetch; samohost performs NO
 * live DNS writes.
 */

/** Who answers authoritatively for the domain. */
export type DnsAuthority = "cloudflare" | "namecheap" | "other" | "unresolved";

/** State of the wildcard (`*.domain`) needed for zero-API preview serving. */
export type WildcardState = "present" | "absent" | "mismatch" | "unknown";

/** Where the wildcard judgment came from. */
export type WildcardSource = "cloudflare-api" | "public-dns";

/** Result of a resolver lookup: records, a clean NXDOMAIN, or a query error. */
export type LookupResult =
  | { kind: "records"; values: string[] }
  | { kind: "nxdomain" }
  | { kind: "error"; message: string };

/** Read-only view of the wildcard record at the Cloudflare API. */
export interface CfWildcardRecord {
  /** Whether the zone has a record for the wildcard name at all. */
  found: boolean;
  /** Record content (the ORIGIN ip), when found. */
  content?: string;
  /** Orange-cloud state, when found. */
  proxied?: boolean;
}

/**
 * Classify the authority from NS records. Matching is suffix-based on the
 * well-known managed-DNS hostnames (e.g. `derek.ns.cloudflare.com`,
 * `dns1.registrar-servers.com` — Namecheap's default nameservers).
 */
export function classifyAuthority(ns: LookupResult): DnsAuthority {
  if (ns.kind !== "records" || ns.values.length === 0) return "unresolved";
  const lower = ns.values.map((v) => v.toLowerCase().replace(/\.$/, ""));
  if (lower.every((v) => v.endsWith(".ns.cloudflare.com"))) return "cloudflare";
  if (lower.every((v) => v.endsWith(".registrar-servers.com"))) {
    return "namecheap";
  }
  return "other";
}

/**
 * Public-DNS-only wildcard judgment (no Cloudflare API data). Correct for
 * unproxied records; for proxied records this CANNOT verify origin targeting —
 * callers on Cloudflare-authority zones must treat its "mismatch" as unknown
 * (evaluateDnsPreflight does).
 */
export function evaluateWildcard(
  probe: LookupResult,
  expectedIp?: string,
): WildcardState {
  if (probe.kind === "nxdomain") return "absent";
  if (probe.kind === "error") return "unknown";
  if (probe.values.length === 0) return "absent";
  if (expectedIp === undefined) return "present";
  return probe.values.includes(expectedIp) ? "present" : "mismatch";
}

export interface DnsPreflightInput {
  domain: string;
  /** NS lookup for the domain. */
  ns: LookupResult;
  /** A lookup for the wildcard probe label. */
  wildcardProbe: LookupResult;
  /** VM ORIGIN IP the wildcard must target (omit to only check existence). */
  expectedIp?: string;
  /** Whether CLOUDFLARE_API_TOKEN is set (presence ONLY — never the value). */
  cloudflareTokenPresent: boolean;
  /** Zones the operator's Cloudflare config/token is known to cover. */
  cloudflareZones: string[];
  /** Read-only CF API view of the wildcard record, when it was obtainable
   * (Cloudflare authority + token + zone coverage). Authoritative for origin
   * targeting; absence falls back to public-DNS-only judgment. */
  cfWildcardRecord?: CfWildcardRecord;
  /** Redacted message when the CF API read was attempted but failed. */
  cfLookupError?: string;
}

export interface DnsPreflightReport {
  domain: string;
  authority: DnsAuthority;
  wildcard: WildcardState;
  /** What the wildcard judgment is based on. */
  wildcardSource: WildcardSource;
  /** Orange-cloud state of the wildcard record (only known via the CF API). */
  proxied?: boolean;
  /** What the public probe actually resolved to (edge IPs when proxied). */
  observedIps?: string[];
  /** Previews would SERVE today: the wildcard targets the origin (verified at
   * the CF API for proxied records) AND the public internet resolves it. */
  servingReady: boolean;
  /** samohost could AUTOMATE records today: authority is Cloudflare AND a
   * token is present AND the zone is in the token's coverage. */
  automationReady: boolean;
  reasons: string[];
}

/** Pure evaluation: lookup results + CF API view + local config → report. */
export function evaluateDnsPreflight(
  input: DnsPreflightInput,
): DnsPreflightReport {
  const authority = classifyAuthority(input.ns);
  const reasons: string[] = [];
  const observedIps =
    input.wildcardProbe.kind === "records"
      ? input.wildcardProbe.values
      : undefined;
  const publiclyResolves =
    input.wildcardProbe.kind === "records" &&
    input.wildcardProbe.values.length > 0;

  // ---- wildcard judgment -----------------------------------------------------
  let wildcard: WildcardState;
  let wildcardSource: WildcardSource = "public-dns";
  let proxied: boolean | undefined;

  const cf = input.cfWildcardRecord;
  if (cf !== undefined) {
    // The CF API view is authoritative for origin targeting.
    wildcardSource = "cloudflare-api";
    if (!cf.found) {
      wildcard = "absent";
      reasons.push(
        `no wildcard: the Cloudflare zone has no A record for *.${input.domain}`,
      );
      if (publiclyResolves) {
        reasons.push(
          `note: public DNS still resolves the probe (${observedIps!.join(", ")}) — ` +
            `stale cache or a record outside this zone`,
        );
      }
    } else {
      proxied = cf.proxied ?? false;
      const contentOk =
        input.expectedIp === undefined || cf.content === input.expectedIp;
      if (!contentOk) {
        wildcard = "mismatch";
        reasons.push(
          `wildcard mismatch: the Cloudflare record for *.${input.domain} targets ` +
            `${cf.content ?? "(empty)"}, expected origin ${input.expectedIp}` +
            (proxied ? " (record is proxied; origin checked at the API)" : ""),
        );
      } else if (publiclyResolves) {
        // Origin verified at the API; world resolves it. For proxied records
        // the public IPs are Cloudflare edge addresses — expected, NOT a
        // mismatch.
        wildcard = "present";
      } else if (input.wildcardProbe.kind === "error") {
        wildcard = "unknown";
        reasons.push(
          `Cloudflare record for *.${input.domain} targets the expected origin, ` +
            `but the public probe lookup failed (resolver error)`,
        );
      } else {
        wildcard = "absent";
        reasons.push(
          `Cloudflare record for *.${input.domain} targets the expected origin, ` +
            `but public DNS does not resolve it yet — NS delegation/propagation pending`,
        );
      }
    }
  } else {
    // Public-DNS-only judgment.
    wildcard = evaluateWildcard(input.wildcardProbe, input.expectedIp);
    if (wildcard === "mismatch" && authority === "cloudflare") {
      // Edge IPs on a Cloudflare zone are indistinguishable from a wrong
      // target without the API — report unknown, never a false mismatch.
      wildcard = "unknown";
      reasons.push(
        `*.${input.domain} resolves to ${observedIps!.join(", ")}, not ` +
          `${input.expectedIp} — on a Cloudflare-authority zone these are likely ` +
          `proxied edge IPs; a ${input.domain}-scoped token is needed to verify ` +
          `the origin record (read-only)`,
      );
    } else if (wildcard === "mismatch") {
      reasons.push(
        `wildcard mismatch: *.${input.domain} resolves to ` +
          `${observedIps!.join(", ")} but NOT to the expected IP ` +
          `${input.expectedIp} — previews would hit the wrong host`,
      );
    } else if (wildcard === "absent") {
      reasons.push(
        `no wildcard: *.${input.domain} does not resolve — previews cannot be reached. ` +
          `Fix (one-time, manual): add a wildcard A record at the current DNS host` +
          (input.expectedIp ? ` pointing at ${input.expectedIp}` : ""),
      );
    } else if (wildcard === "unknown") {
      reasons.push(`wildcard state unknown: probe lookup failed (resolver error)`);
    }
  }

  if (input.cfLookupError !== undefined) {
    reasons.push(`cloudflare api read failed: ${input.cfLookupError}`);
  }

  const servingReady = wildcard === "present";

  // ---- automation ------------------------------------------------------------
  const zoneCovered = input.cloudflareZones.includes(input.domain);
  let automationReady = false;
  if (authority === "cloudflare") {
    if (!input.cloudflareTokenPresent) {
      reasons.push(
        `authority is Cloudflare but CLOUDFLARE_API_TOKEN is not set — ` +
          `record automation unavailable`,
      );
    } else if (!zoneCovered) {
      reasons.push(
        `authority is Cloudflare but the operator token/config is only known to ` +
          `cover [${input.cloudflareZones.join(", ")}] — a ${input.domain} ` +
          `zone-scoped token is needed for automation`,
      );
    } else {
      automationReady = true;
    }
  } else if (authority === "namecheap") {
    reasons.push(
      `authority is Namecheap (registrar-servers.com) — samohost has no Namecheap ` +
        `provider. Either move ${input.domain} NS to Cloudflare (then extend the ` +
        `token), or set the wildcard manually at Namecheap (no automation needed)`,
    );
  } else if (authority === "other") {
    reasons.push(
      `authority is neither Cloudflare nor Namecheap — inspect NS records manually`,
    );
  } else {
    reasons.push(`NS lookup failed or empty — domain may not be delegated`);
  }

  return {
    domain: input.domain,
    authority,
    wildcard,
    wildcardSource,
    ...(proxied !== undefined ? { proxied } : {}),
    ...(observedIps !== undefined ? { observedIps } : {}),
    servingReady,
    automationReady,
    reasons,
  };
}
