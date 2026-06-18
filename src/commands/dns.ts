/**
 * `samohost dns status` — preview-domain DNS preflight (SPEC-DELTA §5).
 *
 * READ-ONLY: performs NS + A lookups (public DNS reads) and checks token
 * PRESENCE in the environment. It never prints token values and never writes
 * DNS records. The resolver is injected so unit tests run offline.
 *
 *   samohost dns status samo.cat --expect-ip 178.105.246.151
 *
 * answers: who is authoritative (Cloudflare / Namecheap / other), does the
 * wildcard previews depend on exist and point at the VM, and could samohost
 * automate records today (Cloudflare authority + token + zone coverage).
 */

import { resolve4, resolveNs } from "node:dns/promises";
import { lookupWildcardRecord } from "../dns/cloudflare.ts";
import {
  classifyAuthority,
  evaluateDnsPreflight,
  type CfWildcardRecord,
  type DnsPreflightReport,
  type LookupResult,
} from "../dns/preflight.ts";

/**
 * Client-facing Cloudflare zones, defaulted for the CLIENT domain model:
 * samo.team (production) + samo.cat (preview environments). samo.green is
 * samo's OWN dev/platform domain and is deliberately excluded here — it is
 * never client-facing. (The air-infra repo documents samo's *infra* domains
 * — samo.team + samo.green — which is a different concern from the client
 * model and must not leak into this default.)
 * Overridable per call with --cf-zone.
 */
export const DEFAULT_CLOUDFLARE_ZONES = ["samo.team", "samo.cat"];

/** Probe label that proves a wildcard: nobody creates this record explicitly. */
export const WILDCARD_PROBE_LABEL = "samohost-wildcard-probe";

export interface DnsStatusInput {
  domain: string;
  expectIp?: string;
  cfZones: string[];
}

export interface DnsStatusDeps {
  /** NS lookup for a domain. */
  resolveNs(domain: string): Promise<LookupResult>;
  /** A lookup for a name. */
  resolveA(name: string): Promise<LookupResult>;
  /** Env for token-PRESENCE check (never the value). */
  env: Record<string, string | undefined>;
  /** READ-ONLY Cloudflare record fetch (zone by name → wildcard A record).
   * Only invoked when authority is Cloudflare AND the token is present AND
   * the zone is covered. Optional so offline contexts can omit it. */
  cfRecordLookup?: (
    token: string,
    zoneName: string,
    recordName: string,
  ) => Promise<CfWildcardRecord>;
}

/** Strip the token value from any error text before it can reach output. */
function redactToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("REDACTED") : text;
}

export async function runDnsStatus(
  input: DnsStatusInput,
  opts: { json: boolean },
  deps: DnsStatusDeps,
  out: (s: string) => void,
  _err: (s: string) => void,
): Promise<number> {
  const ns = await deps.resolveNs(input.domain);
  const wildcardProbe = await deps.resolveA(
    `${WILDCARD_PROBE_LABEL}.${input.domain}`,
  );

  // Proxied records resolve to edge IPs publicly, so origin targeting can only
  // be verified at the CF API (read-only). Attempt it whenever we credibly can.
  const token = deps.env["CLOUDFLARE_API_TOKEN"] ?? "";
  let cfWildcardRecord: CfWildcardRecord | undefined;
  let cfLookupError: string | undefined;
  if (
    token.length > 0 &&
    deps.cfRecordLookup !== undefined &&
    classifyAuthority(ns) === "cloudflare" &&
    input.cfZones.includes(input.domain)
  ) {
    try {
      cfWildcardRecord = await deps.cfRecordLookup(
        token,
        input.domain,
        `*.${input.domain}`,
      );
    } catch (e) {
      cfLookupError = redactToken(
        e instanceof Error ? e.message : String(e),
        token,
      );
    }
  }

  const report: DnsPreflightReport = evaluateDnsPreflight({
    domain: input.domain,
    ns,
    wildcardProbe,
    ...(input.expectIp !== undefined ? { expectedIp: input.expectIp } : {}),
    cloudflareTokenPresent: token.length > 0,
    cloudflareZones: input.cfZones,
    ...(cfWildcardRecord !== undefined ? { cfWildcardRecord } : {}),
    ...(cfLookupError !== undefined ? { cfLookupError } : {}),
  });

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(`domain: ${report.domain}`);
    out(`authority: ${report.authority}`);
    out(`wildcard: ${report.wildcard} (via ${report.wildcardSource})`);
    if (report.proxied !== undefined) out(`proxied: ${report.proxied}`);
    if (report.observedIps !== undefined) {
      out(`observed_ips: ${report.observedIps.join(", ")}`);
    }
    out(`serving_ready: ${report.servingReady}`);
    out(`automation_ready: ${report.automationReady}`);
    for (const r of report.reasons) out(`  - ${r}`);
  }
  // Exit 0 when previews would actually serve; automation is advisory.
  return report.servingReady ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Production dependency wiring (live DNS READS only)
// ---------------------------------------------------------------------------

function asLookup(p: Promise<string[]>): Promise<LookupResult> {
  return p.then(
    (values): LookupResult => ({ kind: "records", values }),
    (e): LookupResult => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA") {
        return { kind: "nxdomain" };
      }
      return { kind: "error", message: code ?? String(e) };
    },
  );
}

export function defaultDnsStatusDeps(): DnsStatusDeps {
  return {
    resolveNs: (domain) => asLookup(resolveNs(domain)),
    resolveA: (name) => asLookup(resolve4(name)),
    env: process.env,
    cfRecordLookup: (token, zoneName, recordName) =>
      lookupWildcardRecord({ token }, zoneName, recordName),
  };
}
