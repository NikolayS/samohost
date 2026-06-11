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
