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
import {
  evaluateDnsPreflight,
  type DnsPreflightReport,
  type LookupResult,
} from "../dns/preflight.ts";

/**
 * Zones the operator's existing Cloudflare config/token are known to cover
 * (infra repo documents samo.team + samo.green; samo.cat is NOT among them).
 * Overridable per call with --cf-zone.
 */
export const DEFAULT_CLOUDFLARE_ZONES = ["samo.team", "samo.green"];

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

  const report: DnsPreflightReport = evaluateDnsPreflight({
    domain: input.domain,
    ns,
    wildcardProbe,
    ...(input.expectIp !== undefined ? { expectedIp: input.expectIp } : {}),
    cloudflareTokenPresent:
      (deps.env["CLOUDFLARE_API_TOKEN"] ?? "").length > 0,
    cloudflareZones: input.cfZones,
  });

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(`domain: ${report.domain}`);
    out(`authority: ${report.authority}`);
    out(`wildcard: ${report.wildcard}`);
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
  };
}
