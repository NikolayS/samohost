/**
 * Preview-DNS helpers for per-VM unproxied A records (samohost issue #37).
 *
 * Design: each preview env gets an UNPROXIED Cloudflare A record
 * `<preview-host>.samo.cat -> vm.ip` (proxied=false). Unproxied is critical
 * for two reasons:
 *   (a) it bypasses the proxied wildcard A record that points all *.samo.cat
 *       at the field-record VM only, routing each preview directly to its own
 *       origin VM IP;
 *   (b) it allows Caddy on the origin to complete an ACME HTTP-01 challenge
 *       for the preview vhost, obtaining a real Let's Encrypt certificate with
 *       no browser warning.
 *
 * These are thin wrappers over DnsProviderPort — a separate module so that
 * the logic can be unit-tested and later swapped without touching env.ts.
 */

import type { DnsProviderPort } from "./cloudflare.ts";

/**
 * Ensure exactly one unproxied A record: `host -> ip`.
 * Idempotent: a second call with the same (host, ip) is a no-op.
 */
export async function ensurePreviewDns(
  provider: DnsProviderPort,
  host: string,
  ip: string,
): Promise<void> {
  await provider.ensureRecord(host, "A", ip, /* proxied= */ false);
}

/**
 * Remove the unproxied A record for `host` (created by ensurePreviewDns).
 * Called by env destroy. Safe to call when no record exists (returns 0).
 */
export async function removePreviewDns(
  provider: DnsProviderPort,
  host: string,
): Promise<void> {
  await provider.removeRecord(host, "A");
}
