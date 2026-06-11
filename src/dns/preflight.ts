/**
 * DNS preflight for preview domains (SPEC-DELTA §5).
 *
 * The SOLO plan serves previews at `<app>-<branch>.samo.cat`, which requires
 * the preview domain's DNS to actually deliver traffic to the VM — and that is
 * currently NOT true: `samo.cat` is on Namecheap registrar nameservers with no
 * wildcard, while the operator's Cloudflare tooling/token only covers
 * `samo.team`/`samo.green`. This module turns that situation into a typed,
 * testable report instead of a deploy-time surprise.
 *
 * Everything here is PURE — the resolver results are inputs, so unit tests
 * never touch the network. The command layer (commands/dns.ts) injects live
 * NS/A lookups (reads only; samohost performs NO live DNS writes).
 */

/** Who answers authoritatively for the domain. */
export type DnsAuthority = "cloudflare" | "namecheap" | "other" | "unresolved";

/** State of the wildcard (`*.domain`) needed for zero-API preview serving. */
export type WildcardState = "present" | "absent" | "mismatch" | "unknown";

/** Result of a resolver lookup: records, a clean NXDOMAIN, or a query error. */
export type LookupResult =
  | { kind: "records"; values: string[] }
  | { kind: "nxdomain" }
  | { kind: "error"; message: string };

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
 * Judge the wildcard from the A-lookup of a probe label under the domain
 * (e.g. `samohost-wildcard-probe.samo.cat`): a label nobody would create
 * explicitly, so a successful resolution proves a wildcard record.
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
  /** VM IP the wildcard must point at (omit to only check existence). */
  expectedIp?: string;
  /** Whether CLOUDFLARE_API_TOKEN is set (presence ONLY — never the value). */
  cloudflareTokenPresent: boolean;
  /** Zones the operator's Cloudflare config/token is known to cover. */
  cloudflareZones: string[];
}

export interface DnsPreflightReport {
  domain: string;
  authority: DnsAuthority;
  wildcard: WildcardState;
  /** Previews would SERVE today: wildcard resolves (to the expected IP if
   * given). Independent of who hosts the DNS. */
  servingReady: boolean;
  /** samohost could AUTOMATE records today: authority is Cloudflare AND a
   * token is present AND the zone is in the token's coverage. */
  automationReady: boolean;
  reasons: string[];
}

/** Pure evaluation: lookup results + local config → report. */
export function evaluateDnsPreflight(
  input: DnsPreflightInput,
): DnsPreflightReport {
  const authority = classifyAuthority(input.ns);
  const wildcard = evaluateWildcard(input.wildcardProbe, input.expectedIp);
  const reasons: string[] = [];

  const servingReady = wildcard === "present";
  if (wildcard === "absent") {
    reasons.push(
      `no wildcard: *.${input.domain} does not resolve — previews cannot be reached. ` +
        `Fix (one-time, manual): add a wildcard A record at the current DNS host` +
        (input.expectedIp ? ` pointing at ${input.expectedIp}` : ""),
    );
  } else if (wildcard === "mismatch") {
    reasons.push(
      `wildcard mismatch: *.${input.domain} resolves but NOT to the expected IP ` +
        `${input.expectedIp} — previews would hit the wrong host`,
    );
  } else if (wildcard === "unknown") {
    reasons.push(`wildcard state unknown: probe lookup failed (resolver error)`);
  }

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
    servingReady,
    automationReady,
    reasons,
  };
}
