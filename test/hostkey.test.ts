/**
 * Provision-side host-key scanning (TOFU — trust on first BOOT).
 *
 * On a freshly created box there is no out-of-band fingerprint to verify
 * against (we created the machine seconds ago), so provision pins whatever the
 * first ssh-keyscan returns and proceeds with StrictHostKeyChecking=yes from
 * then on. The multi-key lesson from NikolayS/samohost#5 applies here too:
 * ssh-keyscan emits one line per key TYPE (rsa first, typically), so we must
 * fingerprint ALL lines and pick deliberately — we pin the ed25519 key when
 * the host offers one.
 *
 * (PR #5's adopt-side scanning is not merged into this base; this module is
 * the provision-side equivalent and the natural shared home once #5 lands.)
 */

import { describe, expect, test } from "bun:test";
import {
  fingerprintOfKeyLine,
  parseScannedKeys,
  pickPinKey,
} from "../src/ssh/hostkey.ts";

const ED_LINE =
  "[192.0.2.10]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";
const RSA_LINE =
  "[192.0.2.10]:2223 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABFIXTURErsaBLOBzzzzAAAA0123456789ab";
const ED_FP = "SHA256:avywloR+f7SsRsjE1lq97ETMAqBwRNZI3yu+d8I8d7A";
const RSA_FP = "SHA256:qmnSU90QZVuP+8bV7z/1oVyZ587cucM0Ajm3JCpersU";

const SCAN_OUTPUT = [
  "# 192.0.2.10:2223 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13",
  RSA_LINE,
  "# 192.0.2.10:2223 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13",
  ED_LINE,
  "",
].join("\n");

describe("parseScannedKeys", () => {
  test("extracts EVERY key line, skipping banners and blanks, with type + fingerprint", () => {
    const keys = parseScannedKeys(SCAN_OUTPUT);
    expect(keys.length).toBe(2);
    expect(keys[0]).toEqual({ line: RSA_LINE, type: "ssh-rsa", fingerprint: RSA_FP });
    expect(keys[1]).toEqual({ line: ED_LINE, type: "ssh-ed25519", fingerprint: ED_FP });
  });

  test("throws when ssh-keyscan returned no key line", () => {
    expect(() => parseScannedKeys("# banner only\n\n")).toThrow(/no host key/i);
  });
});

describe("fingerprintOfKeyLine", () => {
  test("matches ssh-keygen -lf format (SHA256:<unpadded base64>)", () => {
    expect(fingerprintOfKeyLine(ED_LINE)).toBe(ED_FP);
    expect(fingerprintOfKeyLine(RSA_LINE)).toBe(RSA_FP);
  });

  test("rejects malformed lines", () => {
    expect(() => fingerprintOfKeyLine("   ")).toThrow();
    expect(() => fingerprintOfKeyLine("[h]:1 ssh-ed25519 !!!notbase64!!!")).toThrow();
  });
});

describe("pickPinKey", () => {
  test("prefers the ed25519 key even when rsa is scanned first", () => {
    const keys = parseScannedKeys(SCAN_OUTPUT);
    expect(pickPinKey(keys).fingerprint).toBe(ED_FP);
  });

  test("falls back to the first key when no ed25519 is offered", () => {
    const keys = parseScannedKeys(RSA_LINE + "\n");
    expect(pickPinKey(keys).fingerprint).toBe(RSA_FP);
  });
});
