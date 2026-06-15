/**
 * PR-C — provision manifest labels: custom labels merge, managed labels win
 * on collision, invalid labels produce validation errors.
 *
 * Fake-provider only; no network, no real ~/.samohost.
 *
 * field-record-1#117 (samohost PR-C: provision manifest fields — labels + merge)
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvisionSpec, VmRecord } from "../src/types.ts";
import { StateStore } from "../src/state/store.ts";
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SAMOHOST_ID_LABEL,
} from "../src/providers/types.ts";
import {
  runProvision,
  type ProvisionDeps,
} from "../src/commands/provision.ts";
import { parseArgs, UsageError } from "../src/cli.ts";
import { FakeProvider } from "./fake-provider.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Test-env helpers (mirrors provision.test.ts conventions)
// ---------------------------------------------------------------------------

const ED_LINE =
  "[192.0.2.55]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";
const RSA_LINE =
  "[192.0.2.55]:2223 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABFIXTURErsaBLOBzzzzAAAA0123456789ab";
const SCAN_OUTPUT = `# banner\n${RSA_LINE}\n${ED_LINE}\n`;

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "samohost-labels-"));
  const privKeyPath = join(dir, "id_ed25519");
  const pubKeyPath = join(dir, "id_ed25519.pub");
  writeFileSync(privKeyPath, "FIXTURE PRIVATE KEY (never read by samohost)\n");
  writeFileSync(pubKeyPath, SAMPLE_PUBKEY + "\n");

  const store = new StateStore(join(dir, "state.json"));
  const fake = new FakeProvider();
  fake.statusSequence = ["initializing", "running"];

  let keyscanCalled = false;
  const deps: ProvisionDeps = {
    provider: fake,
    store,
    spawn: async (file, _args) => {
      if (file === "ssh-keyscan") {
        keyscanCalled = true;
        return { code: 0, stdout: SCAN_OUTPUT, stderr: "" };
      }
      if (file === "ssh") {
        return { code: 0, stdout: "SAMOHOST_PROVISION_COMPLETE\n", stderr: "" };
      }
      throw new Error(`unexpected spawn: ${file}`);
    },
    now: (() => {
      let t = 1_000_000;
      return () => t;
    })(),
    sleep: async (ms) => { void ms; },
    knownHostsDir: join(dir, "known_hosts.d"),
    controlDir: join(dir, "cm"),
    pollIntervalMs: 1000,
  };

  const out: string[] = [];
  const errs: string[] = [];
  return {
    dir, privKeyPath, pubKeyPath, store, fake, deps,
    out, errs,
    outFn: (s: string) => out.push(s),
    errFn: (s: string) => errs.push(s),
  };
}

function labelSpec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return makeSpec({ name: "label-vm", ...overrides });
}

// ---------------------------------------------------------------------------
// CLI parsing — --label flag
// ---------------------------------------------------------------------------

describe("parseArgs provision --label", () => {
  const BASE = [
    "provision",
    "--provider", "hetzner",
    "--region", "nbg1",
    "--type", "cx22",
    "--name", "vm1",
    "--ssh-key", "~/.ssh/id_ed25519",
  ];

  test("single --label key=value is parsed into spec.labels", () => {
    const cmd = parseArgs([...BASE, "--label", "env=prod"]);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.labels).toEqual({ env: "prod" });
  });

  test("multiple --label flags accumulate into spec.labels", () => {
    const cmd = parseArgs([
      ...BASE,
      "--label", "env=prod",
      "--label", "team=platform",
      "--label", "cost-center=eng",
    ]);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.labels).toEqual({
      env: "prod",
      team: "platform",
      "cost-center": "eng",
    });
  });

  test("absent --label leaves spec.labels undefined", () => {
    const cmd = parseArgs(BASE);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.labels).toBeUndefined();
  });

  test("--label missing value throws UsageError", () => {
    expect(() => parseArgs([...BASE, "--label"])).toThrow(UsageError);
  });

  test("--label without = is a UsageError (must be key=value form)", () => {
    expect(() => parseArgs([...BASE, "--label", "justkey"])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// runProvision — label merge in provider.create() call
// ---------------------------------------------------------------------------

describe("runProvision — custom labels merged into provider.create()", () => {
  test("custom label env=prod appears in create() call labels", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { env: "prod" } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    const call = env.fake.createCalls[0]!;
    expect(call.labels["env"]).toBe("prod");
  });

  test("multiple custom labels all appear in create() call", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { env: "staging", team: "platform" } });
    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const call = env.fake.createCalls[0]!;
    expect(call.labels["env"]).toBe("staging");
    expect(call.labels["team"]).toBe("platform");
  });

  test("managed labels are always present alongside custom labels", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { env: "prod" } });
    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const call = env.fake.createCalls[0]!;
    const rec = env.store.list()[0]!;
    expect(call.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(call.labels[SAMOHOST_ID_LABEL]).toBe(rec.id);
  });

  test("no custom labels: create() still carries managed labels (no regression)", async () => {
    const env = makeEnv();
    const spec = labelSpec(); // no labels field
    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const call = env.fake.createCalls[0]!;
    const rec = env.store.list()[0]!;
    expect(call.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(call.labels[SAMOHOST_ID_LABEL]).toBe(rec.id);
    // No extra keys beyond the two managed ones
    expect(Object.keys(call.labels)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Managed labels WIN on key collision (security invariant)
// ---------------------------------------------------------------------------

describe("runProvision — managed labels win on collision", () => {
  test("custom label keyed managed-by=evil does NOT override managed value", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { [MANAGED_BY_LABEL]: "evil" } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    const call = env.fake.createCalls[0]!;
    expect(call.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
  });

  test("custom label keyed samohost-id=evil does NOT override the record UUID", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { [SAMOHOST_ID_LABEL]: "evil-override" } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    const call = env.fake.createCalls[0]!;
    const rec = env.store.list()[0]!;
    // Must be the real UUID, not "evil-override"
    expect(call.labels[SAMOHOST_ID_LABEL]).toBe(rec.id);
    expect(call.labels[SAMOHOST_ID_LABEL]).not.toBe("evil-override");
  });

  test("collision on both managed keys at once: both managed values survive", async () => {
    const env = makeEnv();
    const spec = labelSpec({
      labels: {
        [MANAGED_BY_LABEL]: "attacker",
        [SAMOHOST_ID_LABEL]: "attacker-id",
      },
    });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    const call = env.fake.createCalls[0]!;
    const rec = env.store.list()[0]!;
    expect(call.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(call.labels[SAMOHOST_ID_LABEL]).toBe(rec.id);
  });
});

// ---------------------------------------------------------------------------
// Label validation — invalid keys/values abort before provider call or persist
// ---------------------------------------------------------------------------

describe("runProvision — label validation errors", () => {
  async function expectValidationFailure(labels: Record<string, string>) {
    const env = makeEnv();
    const spec = labelSpec({ labels });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code, `expected exit 1 for labels ${JSON.stringify(labels)}`).toBe(1);
    expect(env.fake.createCalls.length).toBe(0);
    expect(env.store.list()).toEqual([]);
    return env.errs.join("\n");
  }

  test("empty key is rejected", async () => {
    const msg = await expectValidationFailure({ "": "value" });
    expect(msg).toContain("label");
  });

  test("key exceeding 63 characters is rejected", async () => {
    const longKey = "a".repeat(64);
    const msg = await expectValidationFailure({ [longKey]: "value" });
    expect(msg).toContain("label");
  });

  test("value exceeding 63 characters is rejected", async () => {
    const longVal = "a".repeat(64);
    const msg = await expectValidationFailure({ validkey: longVal });
    expect(msg).toContain("label");
  });

  test("key with illegal character (space) is rejected", async () => {
    const msg = await expectValidationFailure({ "bad key": "value" });
    expect(msg).toContain("label");
  });

  test("key with illegal character (slash) is rejected", async () => {
    const msg = await expectValidationFailure({ "bad/key": "value" });
    expect(msg).toContain("label");
  });

  test("value with illegal character (space) is rejected", async () => {
    const msg = await expectValidationFailure({ goodkey: "bad value" });
    expect(msg).toContain("label");
  });

  test("valid labels pass: alphanumeric + dots + dashes + underscores", async () => {
    const env = makeEnv();
    const spec = labelSpec({
      labels: {
        "env": "prod",
        "cost-center": "eng",
        "build.version": "1.2.3",
        "A_Label": "Value_123",
      },
    });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(env.fake.createCalls.length).toBe(1);
  });

  test("key starting with invalid char (dash) is rejected", async () => {
    const msg = await expectValidationFailure({ "-badstart": "value" });
    expect(msg).toContain("label");
  });

  test("key ending with invalid char (dash) is rejected", async () => {
    const msg = await expectValidationFailure({ "badend-": "value" });
    expect(msg).toContain("label");
  });

  test("single-char key is valid (no start/end constraint for single chars)", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { "a": "b" } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
  });

  test("exactly 63-char key is valid", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { ["a".repeat(63)]: "v" } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
  });

  test("exactly 63-char value is valid", async () => {
    const env = makeEnv();
    const spec = labelSpec({ labels: { key: "v".repeat(63) } });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Existing cli-provision.test.ts behaviour — no regression on --label absent
// ---------------------------------------------------------------------------

describe("no regression — existing provision happy path unchanged", () => {
  test("spec.labels is absent when --label is not supplied (parseArgs)", () => {
    const cmd = parseArgs([
      "provision",
      "--provider", "hetzner",
      "--region", "nbg1",
      "--type", "cx22",
      "--name", "vm1",
      "--ssh-key", "~/.ssh/id_ed25519",
    ]);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.labels).toBeUndefined();
  });
});
