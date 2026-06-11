/**
 * Host-key scanning + fingerprinting for provision-time TOFU pinning.
 *
 * On a freshly created VM there is no out-of-band fingerprint to compare
 * against (samohost created the machine seconds ago over an authenticated
 * API), so provision does trust-on-first-boot: the first successful
 * `ssh-keyscan` of the hardened port defines the pin, and every later
 * connection enforces it (`StrictHostKeyChecking=yes`, per-VM known_hosts).
 * The residual risk window is the seconds between boot and first scan; the
 * caveat is documented in SPEC-DELTA.
 *
 * Multi-key lesson from NikolayS/samohost#5 (adopt-side): ssh-keyscan emits
 * one line per key TYPE (typically ssh-rsa first), interleaved with `#`
 * banner comments. We therefore fingerprint ALL lines and pick the ed25519
 * key deliberately instead of trusting line order. PR #5 is not merged into
 * this base; when it lands, its adopt-side helpers can fold into this module.
 */

import { createHash } from "node:crypto";

/** One scanned host key: the raw known_hosts line, its type, its SHA256 pin. */
export interface ScannedKey {
  line: string;
  /** e.g. `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`. */
  type: string;
  /** `SHA256:<unpadded base64>` — the exact `ssh-keygen -lf` format. */
  fingerprint: string;
}

/**
 * Parse `ssh-keyscan` stdout into every host-key line (banners/blank lines
 * skipped), each typed and fingerprinted. Throws if no key line is present.
 */
export function parseScannedKeys(stdout: string): ScannedKey[] {
  const keys: ScannedKey[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    keys.push({
      line,
      type: keyTypeOfLine(line),
      fingerprint: fingerprintOfKeyLine(line),
    });
  }
  if (keys.length === 0) {
    throw new Error("ssh-keyscan returned no host key line");
  }
  return keys;
}

/** The key-type field of a known_hosts line (second-to-last field). */
function keyTypeOfLine(keyLine: string): string {
  const fields = keyLine.trim().split(/\s+/);
  return fields.length >= 2 ? (fields[fields.length - 2] ?? "?") : "?";
}

/**
 * SHA256 fingerprint of a known_hosts key line in `ssh-keygen -lf` form:
 * `SHA256:` + unpadded base64 of the SHA256 of the base64-decoded key blob
 * (the last whitespace field). Pure and deterministic — no spawn, no network.
 */
export function fingerprintOfKeyLine(keyLine: string): string {
  const fields = keyLine.trim().split(/\s+/);
  const blob = fields[fields.length - 1];
  if (blob === undefined || blob.length === 0) {
    throw new Error(`malformed host key line: ${keyLine}`);
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(blob)) {
    throw new Error(`host key blob is not valid base64: ${keyLine}`);
  }
  const raw = Buffer.from(blob, "base64");
  if (raw.length === 0) {
    throw new Error(`host key blob is not valid base64: ${keyLine}`);
  }
  const digest = createHash("sha256")
    .update(raw)
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/**
 * Choose which scanned key becomes the pin: prefer ed25519 (modern default,
 * what `samohost ssh` will negotiate once it is in known_hosts), else fall
 * back to the first key the host offered.
 */
export function pickPinKey(keys: ScannedKey[]): ScannedKey {
  return keys.find((k) => k.type === "ssh-ed25519") ?? keys[0]!;
}
