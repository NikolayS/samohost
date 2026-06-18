/**
 * Duration parsing utility for `samohost env gc --ttl`.
 *
 * Parses strings of the form `<N><unit>` where unit is one of:
 *   s  = seconds
 *   m  = minutes
 *   h  = hours
 *   d  = days
 *
 * Returns milliseconds or `undefined` for any rejected input.
 *
 * Rejected inputs:
 *   - Zero value (e.g. "0d", "0s")
 *   - Negative values (e.g. "-1d")
 *   - Bare numbers with no unit (e.g. "3600", "7")
 *   - Strings containing spaces (e.g. "7 d", " 7d")
 *   - Uppercase unit letters ("7D", "7H", "7M", "7S") — case-strict
 *   - Float values (e.g. "1.5d")
 *   - Unknown unit letters (e.g. "7w", "7ms")
 *   - Empty string or just a unit letter ("d")
 */
export function parseDuration(s: string): number | undefined {
  // Reject anything with spaces immediately
  if (s !== s.trim() || s.includes(" ")) return undefined;

  // Must match exactly: one or more decimal digits followed by a single lowercase unit letter
  const match = /^(\d+)([smhd])$/.exec(s);
  if (match === null) return undefined;

  const n = parseInt(match[1]!, 10);
  const unit = match[2]!;

  // Reject zero
  if (n === 0) return undefined;

  // n is always non-negative because we matched only \d+ (no minus sign)
  switch (unit) {
    case "s": return n * 1_000;
    case "m": return n * 60 * 1_000;
    case "h": return n * 3_600 * 1_000;
    case "d": return n * 86_400 * 1_000;
    default:  return undefined; // unreachable, but satisfies the type-checker
  }
}
