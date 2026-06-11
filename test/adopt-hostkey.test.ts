/**
 * Regression tests for NikolayS/samohost#4 — `adopt` must plant the verified
 * host-key line into the per-VM known_hosts file via recordHostKey(), so the
 * FIRST real SSH connection succeeds under StrictHostKeyChecking=yes.
 *
 * Before this fix `adopt` only stored the fingerprint; the known_hosts file got
 * a marker comment but never the actual key line, so every later command's
 * first connect failed on an unknown host key.
 *
 * No network here: ssh-keyscan is faked via the injected spawn abstraction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAdopt,
  plantVerifiedHostKey,
  type AdoptHostKeyDeps,
} from "../src/commands/adopt.ts";
import { knownHostsPathFor } from "../src/ssh/runner.ts";
import { StateStore } from "../src/state/store.ts";
import type { SpawnResult } from "../src/ssh/runner.ts";
import type { VmRecord } from "../src/types.ts";

// A real ed25519 host key (generated with ssh-keygen). The base64 blob below is
// a valid key; its true SHA256 fingerprint (matching `ssh-keygen -lf`) is FP.
const KEY_BLOB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIP8LufXzJ7LkmCa9vsGNNkATaNeYVlsPhtHs1nLvo4fY";
const FP = "SHA256:+7oavt/iczXd+Q5lOt9tLgmM7nxZe26h9P6UUQsbni0";
const KEY_LINE = `[178.105.246.151]:2223 ssh-ed25519 ${KEY_BLOB}`;

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "samo-field",
    ip: "178.105.246.151",
    sshPort: 2223,
    sshUser: "agent",
    sshKey: "/nonexistent/key",
    hostKeyFingerprint: FP,
    ...overrides,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() {
      return out;
    },
    get e() {
      return err;
    },
  };
}

/**
 * Fake ssh-keyscan: returns the canned key line on stdout, mirroring the real
 * `ssh-keyscan -p <port> <host>` shape (key lines on stdout; ssh-keyscan also
 * prints `# host:port SSH-2.0-...` comment banners which we include).
 */
function fakeKeyscanDeps(
  knownHostsDir: string,
  keyLine: string,
): { deps: AdoptHostKeyDeps; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const deps: AdoptHostKeyDeps = {
    knownHostsDir,
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      calls.push({ file, args });
      return Promise.resolve({
        code: 0,
        stdout:
          `# 178.105.246.151:2223 SSH-2.0-OpenSSH_9.6\n` + `${keyLine}\n`,
        stderr: "",
      });
    },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Multi-key regression (NikolayS/samohost#4 follow-up).
//
// Real, unrestricted `ssh-keyscan -p <port> <host>` emits MANY key lines — one
// per host key type — typically with the ssh-rsa line FIRST, then ed25519 /
// ecdsa. The fixtures below are the EXACT lines + fingerprints emitted by the
// runtime sandbox host (127.0.0.1:2299), so the mock matches prod shape: the
// blobs are real and their SHA256 fingerprints (verified against `ssh-keygen
// -lf -`) are the constants below. The pinned/out-of-band-verified fingerprint
// is the ED25519 one, which is NOT the first scanned line — the exact case that
// must NOT be refused as a MITM.
// ---------------------------------------------------------------------------
const MK_RSA_LINE =
  "[127.0.0.1]:2299 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC3N+kr5AEI0Kla1t1zU3I/uJrnr3QBNa41zxzrUja3UQ9N5J+FHBCI9kbGE2nAc7Gn72HFGMSMyYJfJ6fc5nqXhhXUz3cnYUHu4LbvwC3tPF8b1UNqIott9DvMXvW58YESu+tcHzjfnJVoWgwc4LXKn0G7qRMpdYmGjCgT/H0TkxEFRoQNJ+gaJ+72fiIHH0aPeHblcFvUjFpjSQKvEhfc5F1kPl+Un42SYLsQh4ZN5tUaL1RNjP1YTrmIEOKvVN237JbRX22N/twNYupOz/0Jt9OBMnZetaW4ILKoDk7jYAzfi5Eie3buLx9XckKiN9QsJo6bFuUN/QRM/gdg+FEXmCQPaGcO91pJfNjcb2ZwzjEF6osv6R1Y1Kml2H9EbCXCO/w28TaHJaONLMh6MXFknU2t9LzilkXzmVgc247VJogSmGPay/TqLtDMnCNvDjxwk+i0iexhvx/bmPdFjNny9Yc19dArjEn7pC38pouEYeLc9VWURuZeyAfO6ca7kx8=";
const MK_RSA_FP = "SHA256:oku3n4zQX/cIQrLrFyPHfPJann3AnwH5OPwgA5C7Z/E";
const MK_ED_LINE =
  "[127.0.0.1]:2299 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFCviR20uT18RBaXxXoWBgDMWqbq1hb8OLxPJaQhas9E";
const MK_ED_FP = "SHA256:s34mRMX6hboFZUeCK07Ml5UTDAZzeP1DCDWH6OmmBKU";
const MK_ECDSA_LINE =
  "[127.0.0.1]:2299 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBKbNPar/V50mSpIxbRZu+Tpgi30gVtFWW6hgleAEwyTLvRUSxuTI0EzjIcz5rDuOm+9wXLp8hwtoxp+esiCuSwg=";
const MK_ECDSA_FP = "SHA256:8AtLU6ZNwndW8eHdamoif2XSWMsF6xp+f5Y8RwhW7NQ";

/**
 * Fake ssh-keyscan emitting the FULL multi-key prod shape: per-type banner
 * comments interleaved with the rsa / ed25519 / ecdsa key lines, RSA first —
 * exactly what `ssh-keyscan -p 2299 127.0.0.1` prints against the sandbox host.
 */
function fakeMultiKeyscanDeps(knownHostsDir: string): {
  deps: AdoptHostKeyDeps;
  calls: { file: string; args: string[] }[];
} {
  const calls: { file: string; args: string[] }[] = [];
  const stdout =
    `# 127.0.0.1:2299 SSH-2.0-OpenSSH_9.6\n` +
    `${MK_RSA_LINE}\n` +
    `# 127.0.0.1:2299 SSH-2.0-OpenSSH_9.6\n` +
    `${MK_ED_LINE}\n` +
    `# 127.0.0.1:2299 SSH-2.0-OpenSSH_9.6\n` +
    `${MK_ECDSA_LINE}\n`;
  const deps: AdoptHostKeyDeps = {
    knownHostsDir,
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      calls.push({ file, args });
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
  };
  return { deps, calls };
}

function mkInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "sandbox-local",
    ip: "127.0.0.1",
    sshPort: 2299,
    sshUser: "agent",
    sshKey: "/nonexistent/key",
    hostKeyFingerprint: MK_ED_FP,
    ...overrides,
  };
}

describe("adopt matches the pinned fingerprint among ALL scanned keys (#4 multi-key)", () => {
  let dir: string;
  let khDir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-adopt-mk-"));
    khDir = join(dir, "known_hosts.d");
    store = new StateStore(join(dir, "state.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function vmFromStore(): VmRecord {
    const recs = store.list();
    if (recs.length !== 1) throw new Error(`expected 1 record, got ${recs.length}`);
    return recs[0]!;
  }

  test("pinned fingerprint is the ED25519 (NOT the first/rsa) line: adopt succeeds and plants exactly that line", async () => {
    const c = capture();
    const { deps } = fakeMultiKeyscanDeps(khDir);
    const code = await runAdopt(
      mkInput(),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    // Before the fix: code===1, error "fingerprint mismatch (possible MITM)"
    // because only the FIRST (rsa) line was fingerprinted.
    expect(c.e).not.toContain("mismatch");
    expect(code).toBe(0);

    const vm = vmFromStore();
    const path = knownHostsPathFor(vm, khDir);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    // exactly the matching ed25519 line is planted...
    expect(content).toContain(MK_ED_LINE);
    // ...and NOT the non-matching rsa / ecdsa lines.
    expect(content).not.toContain(MK_RSA_LINE);
    expect(content).not.toContain(MK_ECDSA_LINE);
  });

  test("when NO scanned key matches, adopt fails and the error lists ALL observed typed fingerprints", async () => {
    const c = capture();
    const { deps } = fakeMultiKeyscanDeps(khDir);
    // pin a fingerprint that matches none of the three scanned keys.
    const bogus = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const code = await runAdopt(
      mkInput({ hostKeyFingerprint: bogus }),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    expect(code).toBe(1);
    expect(c.e.toLowerCase()).toContain("mismatch");
    // expected fingerprint surfaced
    expect(c.e).toContain(bogus);
    // ALL observed fingerprints surfaced, typed
    expect(c.e).toContain(MK_RSA_FP);
    expect(c.e).toContain(MK_ED_FP);
    expect(c.e).toContain(MK_ECDSA_FP);
    expect(c.e).toContain("ssh-rsa");
    expect(c.e).toContain("ssh-ed25519");
    // nothing recorded
    expect(store.list().length).toBe(0);
  });

  test("re-adopt with the multi-key scan is idempotent (no duplicate ed25519 line)", async () => {
    const c = capture();
    const { deps } = fakeMultiKeyscanDeps(khDir);
    const code = await runAdopt(
      mkInput(),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    expect(code).toBe(0);
    const vm = vmFromStore();
    const path = knownHostsPathFor(vm, khDir);

    const { deps: deps2 } = fakeMultiKeyscanDeps(khDir);
    await plantVerifiedHostKey(vm, MK_ED_FP, deps2);

    const content = readFileSync(path, "utf8");
    const occurrences = content.split(MK_ED_LINE).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("adopt plants the verified host key (#4)", () => {
  let dir: string;
  let khDir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-adopt-hk-"));
    khDir = join(dir, "known_hosts.d");
    store = new StateStore(join(dir, "state.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function vmFromStore(): VmRecord {
    const recs = store.list();
    if (recs.length !== 1) throw new Error(`expected 1 record, got ${recs.length}`);
    return recs[0]!;
  }

  test("on a fingerprint match, the key line is appended to known_hosts.d/<id>", async () => {
    const c = capture();
    const { deps, calls } = fakeKeyscanDeps(khDir, KEY_LINE);
    const code = await runAdopt(
      validInput(),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    expect(code).toBe(0);

    // ssh-keyscan was invoked through the injected spawn abstraction.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.file).toBe("ssh-keyscan");
    expect(calls[0]!.args).toContain("-p");
    expect(calls[0]!.args).toContain("2223");
    expect(calls[0]!.args).toContain("178.105.246.151");

    // The literal known_hosts key line is now present — this is what makes the
    // first real SSH connect succeed under StrictHostKeyChecking=yes.
    const vm = vmFromStore();
    const path = knownHostsPathFor(vm, khDir);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(KEY_LINE);
  });

  test("on a fingerprint MISMATCH, adopt fails and records nothing", async () => {
    const c = capture();
    // ssh-keyscan returns a DIFFERENT (attacker) key whose fingerprint will not
    // match the out-of-band-verified FP.
    const otherLine =
      "[178.105.246.151]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { deps } = fakeKeyscanDeps(khDir, otherLine);
    const code = await runAdopt(
      validInput(),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    expect(code).toBe(1);
    // both fingerprints surfaced to the operator
    expect(c.e).toContain(FP);
    expect(c.e.toLowerCase()).toContain("mismatch");
    // nothing recorded: no record persisted, no key line written
    expect(store.list().length).toBe(0);
    if (existsSync(khDir)) {
      // if a marker file was created, it must NOT contain the scanned key line
      const files = require("node:fs").readdirSync(khDir);
      for (const f of files) {
        const content = readFileSync(join(khDir, f), "utf8");
        expect(content).not.toContain(otherLine);
      }
    }
  });

  test("re-planting the SAME verified key is idempotent (no duplicate line)", async () => {
    const c = capture();
    const { deps } = fakeKeyscanDeps(khDir, KEY_LINE);
    const code = await runAdopt(
      validInput(),
      { json: false },
      store,
      c.out,
      c.err,
      deps,
    );
    expect(code).toBe(0);
    const vm = vmFromStore();
    const path = knownHostsPathFor(vm, khDir);

    // A second plant against the SAME per-VM known_hosts file (e.g. re-adopt of
    // the same host, or a retry) must not append the key line twice.
    const { deps: deps2 } = fakeKeyscanDeps(khDir, KEY_LINE);
    await plantVerifiedHostKey(vm, FP, deps2);

    const content = readFileSync(path, "utf8");
    const occurrences = content.split(KEY_LINE).length - 1;
    expect(occurrences).toBe(1);
  });
});
