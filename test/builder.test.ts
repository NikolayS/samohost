import { describe, expect, test } from "bun:test";
import { buildCloudInit } from "../src/cloudinit/builder.ts";
import { hardeningModule } from "../src/cloudinit/hardening.ts";
import type { CloudInitFragment, Module } from "../src/types.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";

const GOLDEN_PATH = new URL(
  "./fixtures/hardening-baseline.cloud-init.yaml",
  import.meta.url,
).pathname;

describe("buildCloudInit", () => {
  test("matches the committed golden snapshot", async () => {
    const spec = makeSpec({ trustedIps: ["203.0.113.7", "198.51.100.4"] });
    const out = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    const golden = await Bun.file(GOLDEN_PATH).text();
    expect(out).toBe(golden);
  });

  test("is deterministic: two calls are byte-identical", () => {
    const spec = makeSpec({ trustedIps: ["10.0.0.1"] });
    const a = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    const b = buildCloudInit(spec, [], { sshPubkey: SAMPLE_PUBKEY });
    expect(a).toBe(b);
  });

  test("hardening directives are always present", () => {
    const out = buildCloudInit(makeSpec(), [], { sshPubkey: SAMPLE_PUBKEY });
    // SSH socket override (the 24.04 gotcha)
    expect(out).toContain("/etc/systemd/system/ssh.socket.d/port.conf");
    expect(out).toContain("ListenStream=0.0.0.0:2223");
    // sshd_config port
    expect(out).toContain("Port 2223");
    expect(out).toContain("PasswordAuthentication no");
    expect(out).toContain("PermitRootLogin no");
    expect(out).toContain("MaxStartups 100:30:200");
    // air-conformance sshd directives (#64)
    expect(out).toContain("MaxAuthTries 3");
    expect(out).toContain("ClientAliveInterval 300");
    expect(out).toContain("ClientAliveCountMax 2");
    expect(out).toContain("AllowAgentForwarding no");
    expect(out).toContain("PermitUserEnvironment no");
    expect(out).toContain("PermitEmptyPasswords no");
    // air: root authorized_keys removed at provision
    expect(out).toContain("/root/.ssh/authorized_keys");
    // ufw (rate-LIMIT the SSH port, not allow), fail2ban, sysctl, unattended-upgrades, apparmor
    expect(out).toContain("ufw limit 2223/tcp");
    expect(out).not.toContain("ufw allow 2223/tcp");
    expect(out).toContain("backend = systemd");
    expect(out).toContain("net.ipv4.tcp_syncookies = 1");
    expect(out).toContain("unattended-upgrades");
    expect(out).toContain("aa-enforce");
    // The completion sentinel is written as soon as SSH-critical hardening is
    // done — BEFORE the slow, apt-lock-contending service enables (fail2ban /
    // unattended-upgrades / apparmor). This decouples the booting→ready gate from
    // a first-boot apt-daily lock that could otherwise strand provisioning. The
    // slow enables still run afterwards (still enabled, just lock-tolerant).
    const runcmd = out.slice(out.indexOf("runcmd:"));
    const sentinelIdx = runcmd.indexOf("/var/lib/samohost/provision-complete");
    const unattendedIdx = runcmd.indexOf(
      "systemctl enable --now unattended-upgrades",
    );
    expect(sentinelIdx).toBeGreaterThan(-1);
    expect(unattendedIdx).toBeGreaterThan(-1);
    expect(sentinelIdx).toBeLessThan(unattendedIdx);
  });

  test("hardening is rendered first even if listed after other modules", () => {
    const marker: Module = {
      name: "marker",
      validate: () => [],
      cloudInitFragment: (): CloudInitFragment => ({
        runcmd: ["echo marker-module-runcmd"],
      }),
      auditChecks: [],
    };
    const out = buildCloudInit(makeSpec(), [marker], {
      sshPubkey: SAMPLE_PUBKEY,
    });
    const hardeningIdx = out.indexOf("systemctl daemon-reload");
    const markerIdx = out.indexOf("echo marker-module-runcmd");
    expect(hardeningIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(-1);
    expect(hardeningIdx).toBeLessThan(markerIdx);
  });

  test("a duplicate hardening module is not rendered twice", () => {
    const out = buildCloudInit(makeSpec(), [hardeningModule], {
      sshPubkey: SAMPLE_PUBKEY,
    });
    const occurrences = out.split("Port 2223").length - 1;
    expect(occurrences).toBe(1);
  });

  test("custom port flows through every control", () => {
    const out = buildCloudInit(makeSpec({ sshPort: 40022 }), [], {
      sshPubkey: SAMPLE_PUBKEY,
    });
    expect(out).toContain("Port 40022");
    expect(out).toContain("ListenStream=0.0.0.0:40022");
    expect(out).toContain("ufw limit 40022/tcp");
    expect(out).toContain("port = 40022");
  });

  test("never emits a private key or denylisted secret marker", () => {
    // A hostile param attempting to smuggle a private key in the pubkey slot
    // must not be echoed: only the public-key slot carries it, and our
    // denylist asserts no private-key markers ever appear.
    const denylist = [
      "BEGIN OPENSSH PRIVATE KEY",
      "BEGIN RSA PRIVATE KEY",
      "BEGIN EC PRIVATE KEY",
      "PRIVATE KEY-----",
    ];
    const out = buildCloudInit(makeSpec(), [], { sshPubkey: SAMPLE_PUBKEY });
    for (const marker of denylist) {
      expect(out.includes(marker)).toBe(false);
    }
  });

  test("the only injected dynamic value is the public key", () => {
    const key = "ssh-ed25519 AAAAUNIQUEpubkeyMARKER42 user@host";
    const out = buildCloudInit(makeSpec(), [], { sshPubkey: key });
    expect(out).toContain(key);
  });
});
