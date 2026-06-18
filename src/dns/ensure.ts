/**
 * Preview-DNS helpers for per-VM proxied A records (samohost issue #37,
 * updated issue #54).
 *
 * Design (issue #54): each preview env gets a PROXIED Cloudflare A record
 * `<preview-host>.samo.cat -> vm.ip` (proxied=true). PROXIED (orange cloud)
 * is required because:
 *   (a) The record content is the env's VM IP, so CF edge connects to the
 *       correct VM for both CF-locked and open VMs (as long as the VM's :443
 *       is reachable from CF — which it always is, by firewall rule).
 *   (b) The origin serves self-signed HTTPS via Caddy `tls internal`. CF Full
 *       mode accepts a self-signed origin cert, so CF edge terminates the real
 *       cert for clients while forwarding over a CF→origin TLS connection that
 *       uses the self-signed cert. No browser ever sees the self-signed cert.
 *   (c) On CF-locked VMs (field-record) origin :443 is firewalled to CF IPs
 *       only, so clients MUST reach the origin through the CF proxy — the
 *       unproxied (grey-cloud) pattern used before issue #54 was unreachable
 *       (curl 000) because ACME HTTP-01 could not complete on a CF-locked
 *       :443, and clients cannot reach a grey-cloud origin through that firewall.
 *
 * These are thin wrappers over DnsProviderPort — a separate module so that
 * the logic can be unit-tested and later swapped without touching env.ts.
 */

import type { DnsProviderPort } from "./cloudflare.ts";

/**
 * Ensure exactly one PROXIED A record: `host -> ip`.
 * Idempotent: a second call with the same (host, ip, proxied=true) is a no-op.
 */
export async function ensurePreviewDns(
  provider: DnsProviderPort,
  host: string,
  ip: string,
): Promise<void> {
  await provider.ensureRecord(host, "A", ip, /* proxied= */ true);
}

/**
 * Remove the proxied A record for `host` (created by ensurePreviewDns).
 * Called by env destroy. Safe to call when no record exists (returns 0).
 */
export async function removePreviewDns(
  provider: DnsProviderPort,
  host: string,
): Promise<void> {
  await provider.removeRecord(host, "A");
}
