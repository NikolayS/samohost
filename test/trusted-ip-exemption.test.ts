/**
 * RED tests for the provision self-ban fix (NikolayS/samohost#96).
 *
 * Root-cause: the booting→ready gate polls SSH every 5 s from the
 * control-plane IP. UFW `limit <port>/tcp` trips on ≥6 connections in 30 s,
 * and fail2ban fires too. The control-plane bans itself before cloud-init
 * writes the readiness sentinel, so the VM records `degraded` at the 1200 s
 * timeout even though cloud-init finished at ~69 s.
 *
 * Fix contract (both assertions here must be GREEN after the fix):
 *
 * 1. hardening.ts: for every entry in trustedIps, emit
 *      `ufw allow from <ip> to any port <sshPort> proto tcp`
 *    BEFORE the `ufw limit <sshPort>/tcp` line.  UFW first-match wins, so
 *    the trusted source bypasses the rate-limiter entirely.
 *
 * 2. hardening.ts: fail2ban `ignoreip` must include all trustedIps (not just
 *    loopback). This already works — kept here as a regression guard.
 *
 * 3. provision.ts: `runProvision` calls `deps.detectEgressIp()` before
 *    building cloud-init and prepends the result to `spec.trustedIps` when
 *    it returns a non-null IP, so the ready-gate's own polling IP is exempt
 *    by default with zero operator configuration.
 *
 * 4. provision.ts: explicit `--trusted-ip` values passed in the spec are
 *    additive — neither the auto-detected egress IP nor the explicit IPs
 *    suppress each other.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCloudInit } from "../src/cloudinit/builder.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";
import { StateStore } from "../src/state/store.ts";
import { FakeProvider } from "./fake-provider.ts";
import {
  runProvision,
  type ProvisionDeps,
} from "../src/commands/provision.ts";
import type { SpawnFn } from "../src/ssh/runner.ts";
import type { VmRecord } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────
// Shared fixture data (mirrors provision.test.ts)
// ─────────────────────────────────────────────────────────────

const ED_LINE =
  "[192.0.2.55]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";
const RSA_LINE =
  "[192.0.2.55]:2223 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABFIXTURErsaBLOBzzzzAAAA0123456789ab";
const SCAN_OUTPUT = `# banner\n${RSA_LINE}\n${ED_LINE}\n`;

function makeProvisionEnv() {
  const dir = mkdtempSync(join(tmpdir(), "samohost-trusted-ip-"));
  const privKeyPath = join(dir, "id_ed25519");
  const pubKeyPath = join(dir, "id_ed25519.pub");
  writeFileSync(privKeyPath, "FIXTURE PRIVATE KEY\n");
  writeFileSync(pubKeyPath, SAMPLE_PUBKEY + "\n");

  const store = new StateStore(join(dir, "state.json"));
  const fake = new FakeProvider();
  fake.statusSequence = ["initializing", "running"];

  let keyscanCalls = 0;
  let sshCalls = 0;
  const spawn: SpawnFn = async (file, _args) => {
    if (file === "ssh-keyscan") {
      keyscanCalls += 1;
      if (keyscanCalls <= 1) return { code: 1, stdout: "", stderr: "refused" };
      return { code: 0, stdout: SCAN_OUTPUT, stderr: "" };
    }
    if (file === "ssh") {
      sshCalls += 1;
      if (sshCalls <= 1) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "SAMOHOST_PROVISION_COMPLETE\n", stderr: "" };
    }
    throw new Error(`unexpected spawn: ${file}`);
  };

  let nowMs = 1_000_000;
  const deps: ProvisionDeps = {
    provider: fake,
    store,
    spawn,
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
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

// ─────────────────────────────────────────────────────────────
// 1. hardening.ts — ufw allow-from must precede ufw limit
// ─────────────────────────────────────────────────────────────

describe("hardening — UFW trusted-IP exemption (fix for self-ban)", () => {
  test("each trusted IP gets a ufw allow-from rule in the runcmd", () => {
    const trustedIps = ["203.0.113.7", "198.51.100.4"];
    const spec = makeSpec({ trustedIps });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });

    for (const ip of trustedIps) {
      expect(out).toContain(
        `ufw allow from ${ip} to any port 2223 proto tcp`,
      );
    }
  });

  test("ufw allow-from rule for each trusted IP precedes ufw limit (UFW first-match wins)", () => {
    const trustedIps = ["203.0.113.7", "198.51.100.4"];
    const spec = makeSpec({ trustedIps, sshPort: 2223 });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });

    const limitIdx = out.indexOf("ufw limit 2223/tcp");
    expect(limitIdx).toBeGreaterThan(-1);

    for (const ip of trustedIps) {
      const allowIdx = out.indexOf(
        `ufw allow from ${ip} to any port 2223 proto tcp`,
      );
      expect(allowIdx).toBeGreaterThan(-1);
      expect(allowIdx).toBeLessThan(limitIdx);
    }
  });

  test("allow-from rules use the correct sshPort (not hard-coded 2223)", () => {
    const spec = makeSpec({ trustedIps: ["10.0.0.1"], sshPort: 40022 });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });

    expect(out).toContain("ufw allow from 10.0.0.1 to any port 40022 proto tcp");
    expect(out).toContain("ufw limit 40022/tcp");

    const allowIdx = out.indexOf("ufw allow from 10.0.0.1 to any port 40022 proto tcp");
    const limitIdx = out.indexOf("ufw limit 40022/tcp");
    expect(allowIdx).toBeLessThan(limitIdx);
  });

  test("no allow-from rules are emitted when trustedIps is empty (no spurious rules)", () => {
    const spec = makeSpec({ trustedIps: [] });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    expect(out).not.toContain("ufw allow from");
  });
});

// ─────────────────────────────────────────────────────────────
// 2. hardening.ts — fail2ban ignoreip (already works; regression guard)
// ─────────────────────────────────────────────────────────────

describe("hardening — fail2ban ignoreip includes trusted IPs", () => {
  test("ignoreip contains all trustedIps in addition to loopback", () => {
    const spec = makeSpec({ trustedIps: ["203.0.113.7", "198.51.100.4"] });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    expect(out).toContain("ignoreip = 127.0.0.1/8 ::1 203.0.113.7 198.51.100.4");
  });

  test("ignoreip still contains loopback even with empty trustedIps", () => {
    const spec = makeSpec({ trustedIps: [] });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    expect(out).toContain("ignoreip = 127.0.0.1/8 ::1");
  });
});

// ─────────────────────────────────────────────────────────────
// 3. provision.ts — auto-inject control-plane egress IP
// ─────────────────────────────────────────────────────────────

describe("provision — auto-inject control-plane egress IP as trusted", () => {
  test("when detectEgressIp returns an IP it appears as a ufw allow-from rule in the cloud-init", async () => {
    const env = makeProvisionEnv();
    const EGRESS_IP = "10.99.1.1";
    const spec = makeSpec({ name: "prov-vm", trustedIps: [] });

    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      { ...env.deps, detectEgressIp: async () => EGRESS_IP },
      env.outFn,
      env.errFn,
    );

    expect(code).toBe(0);
    const userData = env.fake.createCalls[0]!.userData;
    // The egress IP must be exempted from the UFW rate-limiter.
    expect(userData).toContain(
      `ufw allow from ${EGRESS_IP} to any port 2223 proto tcp`,
    );
    // And must precede the limit rule.
    const allowIdx = userData.indexOf(
      `ufw allow from ${EGRESS_IP} to any port 2223 proto tcp`,
    );
    const limitIdx = userData.indexOf("ufw limit 2223/tcp");
    expect(allowIdx).toBeLessThan(limitIdx);
    expect((env.store.list()[0] as VmRecord & { controlPlaneIp?: string }).controlPlaneIp)
      .toBe(EGRESS_IP);
  });

  test("when detectEgressIp returns null the provision still succeeds (graceful no-op)", async () => {
    const env = makeProvisionEnv();
    const spec = makeSpec({ name: "prov-vm", trustedIps: [] });

    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      { ...env.deps, detectEgressIp: async () => null },
      env.outFn,
      env.errFn,
    );

    expect(code).toBe(0);
    // No allow-from rules when no IP was detected and no trustedIps in spec.
    const userData = env.fake.createCalls[0]!.userData;
    expect(userData).not.toContain("ufw allow from");
  });

  test("when detectEgressIp is absent the provision succeeds (backwards-compat)", async () => {
    const env = makeProvisionEnv();
    const spec = makeSpec({ name: "prov-vm", trustedIps: [] });

    // deps without detectEgressIp — the original shape
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

// ─────────────────────────────────────────────────────────────
// 4. provision.ts — explicit trustedIps are additive with detected egress IP
// ─────────────────────────────────────────────────────────────

describe("provision — explicit trustedIps are additive with auto-detected egress IP", () => {
  test("both the explicit IP and the auto-detected egress IP appear as allow-from rules", async () => {
    const env = makeProvisionEnv();
    const EXPLICIT_IP = "192.0.2.100";
    const EGRESS_IP = "10.99.2.2";
    const spec = makeSpec({ name: "prov-vm", trustedIps: [EXPLICIT_IP] });

    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      { ...env.deps, detectEgressIp: async () => EGRESS_IP },
      env.outFn,
      env.errFn,
    );

    expect(code).toBe(0);
    const userData = env.fake.createCalls[0]!.userData;
    expect(userData).toContain(
      `ufw allow from ${EXPLICIT_IP} to any port 2223 proto tcp`,
    );
    expect(userData).toContain(
      `ufw allow from ${EGRESS_IP} to any port 2223 proto tcp`,
    );
  });

  test("duplicate IPs are not emitted twice (egress IP already in explicit trustedIps)", async () => {
    const env = makeProvisionEnv();
    const IP = "10.99.3.3";
    const spec = makeSpec({ name: "prov-vm", trustedIps: [IP] });

    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      { ...env.deps, detectEgressIp: async () => IP },
      env.outFn,
      env.errFn,
    );

    const userData = env.fake.createCalls[0]!.userData;
    const rule = `ufw allow from ${IP} to any port 2223 proto tcp`;
    const count = userData.split(rule).length - 1;
    expect(count).toBe(1);
  });
});
