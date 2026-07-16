/**
 * TDD RED commit: dblab provisioning module (#127).
 *
 * Asserts the minimal verified €0 profile from issue #127 steps 1-19:
 *   - Docker CE + zfsutils-linux installed
 *   - Sparse 10G loopback ZFS pool created
 *   - dblab_server 4.1.3 on 127.0.0.1:2345
 *   - zfs_arc_max=256 MB (module param at load)
 *   - clone cap 2, per-clone shared_buffers 128 MB, container memory 1 GB
 *   - 2 GB swapfile
 *   - fail2ban KEPT ENABLED, control-plane IP whitelisted in ignoreip (#127 critical lesson)
 *   - "dblab" name registered in resolveModules
 */

import { describe, expect, test } from "bun:test";
import { buildCloudInit } from "../src/cloudinit/builder.ts";
import { dblabModule, DBLAB_VERSION, DBLAB_ARC_MAX_BYTES } from "../src/cloudinit/dblab.ts";
import { resolveModules } from "../src/commands/preview.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";

/** Control-plane IP that must always appear in fail2ban ignoreip (#127). */
const CONTROL_PLANE_IP = "91.99.233.145";

/**
 * Build the FULL cloud-init with hardening+dblab for a spec that includes the
 * control-plane as a trusted IP (matching the auto-injection in provision.ts).
 */
function buildFull(overrides: Parameters<typeof makeSpec>[0] = {}) {
  const spec = makeSpec({ trustedIps: [CONTROL_PLANE_IP], ...overrides });
  return buildCloudInit(spec, [dblabModule], { sshPubkey: SAMPLE_PUBKEY });
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

describe("resolveModules — dblab module registered (#127)", () => {
  test("'dblab' resolves without error", () => {
    const { modules, errors } = resolveModules(["dblab"]);
    expect(errors).toEqual([]);
    expect(modules.some((m) => m.name === "dblab")).toBe(true);
  });

  test("unknown module still errors", () => {
    const { errors } = resolveModules(["not-a-module"]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Package installation
// ---------------------------------------------------------------------------

describe("dblab module — package installation", () => {
  test("includes apt-transport-https (Docker prereq)", () => {
    expect(buildFull()).toContain("apt-transport-https");
  });

  test("includes ca-certificates (Docker prereq)", () => {
    expect(buildFull()).toContain("ca-certificates");
  });

  test("includes gnupg (Docker GPG key)", () => {
    expect(buildFull()).toContain("gnupg");
  });

  test("includes zfsutils-linux", () => {
    expect(buildFull()).toContain("zfsutils-linux");
  });
});

// ---------------------------------------------------------------------------
// Docker CE install
// ---------------------------------------------------------------------------

describe("dblab module — Docker CE install", () => {
  test("adds the official Docker apt repo GPG key", () => {
    expect(buildFull()).toContain("download.docker.com");
  });

  test("installs docker-ce from the official repo", () => {
    expect(buildFull()).toContain("docker-ce");
  });

  test("installs containerd.io", () => {
    expect(buildFull()).toContain("containerd.io");
  });

  test("adds the adminUser to the docker group", () => {
    const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
    const out = buildCloudInit(spec, [dblabModule], { sshPubkey: SAMPLE_PUBKEY });
    expect(out).toContain("usermod");
    expect(out).toContain("docker");
    expect(out).toContain("samo");
  });
});

// ---------------------------------------------------------------------------
// ZFS loopback pool
// ---------------------------------------------------------------------------

describe("dblab module — ZFS loopback pool setup", () => {
  test("creates the sparse 10G loopback file with fallocate", () => {
    const out = buildFull();
    expect(out).toContain("fallocate");
    expect(out).toContain("10G");
    expect(out).toContain("dblab.img");
  });

  test("attaches the loopback device", () => {
    expect(buildFull()).toContain("losetup");
  });

  test("creates the ZFS pool named 'dblab'", () => {
    expect(buildFull()).toContain("zpool create dblab");
  });

  test("creates and configures the ZFS dataset", () => {
    const out = buildFull();
    expect(out).toContain("zfs create");
    expect(out).toContain("dblab/dblab_pool");
  });

  test("sets ZFS dataset compression + atime=off for throughput", () => {
    const out = buildFull();
    expect(out).toContain("compression=on");
    expect(out).toContain("atime=off");
  });

  test("writes the loopback persistence systemd service", () => {
    const out = buildFull();
    expect(out).toContain("dblab-loopback.service");
    expect(out).toContain("zfs-import.target");
  });
});

// ---------------------------------------------------------------------------
// ZFS ARC cap
// ---------------------------------------------------------------------------

describe("dblab module — ZFS ARC cap (issue #127 minimal profile)", () => {
  test("DBLAB_ARC_MAX_BYTES is 256 MB", () => {
    expect(DBLAB_ARC_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  test("sets zfs_arc_max as a kernel module param", () => {
    const out = buildFull();
    expect(out).toContain("zfs_arc_max");
    expect(out).toContain(String(DBLAB_ARC_MAX_BYTES));
  });

  test("loads the zfs module param so the cap is applied on next load", () => {
    const out = buildFull();
    // The modprobe.d config is the durable mechanism; the update-initramfs or
    // sysctl-equivalent ensures the value is applied at boot.
    expect(out).toContain("modprobe.d");
  });
});

// ---------------------------------------------------------------------------
// dblab server config
// ---------------------------------------------------------------------------

describe("dblab module — server configuration", () => {
  test("DBLAB_VERSION is pinned to 4.1.3", () => {
    expect(DBLAB_VERSION).toBe("4.1.3");
  });

  test("writes /root/.dblab/engine/configs/server.yml", () => {
    expect(buildFull()).toContain("/root/.dblab/engine/configs/server.yml");
  });

  test("server.yml has port 2345", () => {
    expect(buildFull()).toContain("2345");
  });

  test("server.yml has container memory limit 1 GB (1073741824 bytes)", () => {
    expect(buildFull()).toContain("1073741824");
  });

  test("server.yml has maxCloneCount: 2", () => {
    expect(buildFull()).toContain("2");
    // More specific: the clone cap keyword
    expect(buildFull()).toContain("maxCloneCount");
  });

  test("server.yml has per-clone shared_buffers 128MB", () => {
    expect(buildFull()).toContain("128MB");
  });

  test("server.yml has cloneAccessAddresses restricted to 127.0.0.1", () => {
    const out = buildFull();
    expect(out).toContain("127.0.0.1");
    expect(out).toContain("cloneAccessAddresses");
  });

  test("server.yml has port pool starting at 6000", () => {
    expect(buildFull()).toContain("6000");
  });

  test("server.yml has maxIdleMinutes: 20160 (14 days — avoids mid-PR clone expiry)", () => {
    expect(buildFull()).toContain("20160");
  });

  test("server.yml has retrieval source pointing at Docker bridge gateway", () => {
    // The prod PG is accessed at 172.17.0.1 (Docker bridge gateway) from inside
    // the dblab_server container.
    expect(buildFull()).toContain("172.17.0.1");
  });

  test("server.yml has logical retrieval jobs", () => {
    const out = buildFull();
    expect(out).toContain("logicalDump");
    expect(out).toContain("logicalRestore");
  });
});

// ---------------------------------------------------------------------------
// startup.sh (busybox grep workaround — issue #127 step 10)
// ---------------------------------------------------------------------------

describe("dblab module — startup.sh", () => {
  test("writes /root/.dblab/engine/startup.sh", () => {
    expect(buildFull()).toContain("startup.sh");
  });

  test("startup.sh installs grep (busybox workaround)", () => {
    // DBLab's Alpine base image uses busybox grep which lacks -P;
    // the workaround installs full grep via apk.
    const out = buildFull();
    expect(out).toContain("apk add");
    expect(out).toContain("grep");
  });
});

// ---------------------------------------------------------------------------
// Engine launch
// ---------------------------------------------------------------------------

describe("dblab module — engine launch", () => {
  test("runs the engine as the 'dblab_server' container", () => {
    expect(buildFull()).toContain("dblab_server");
  });

  test("pins the engine image to version 4.1.3", () => {
    expect(buildFull()).toContain("postgresai/dblab-server:4.1.3");
  });

  test("publishes the API port on 127.0.0.1 only (not 0.0.0.0)", () => {
    const out = buildFull();
    expect(out).toContain("127.0.0.1:2345:2345");
    // Must NOT expose on all interfaces
    expect(out).not.toContain("0.0.0.0:2345");
  });

  test("runs the engine with --privileged (required for ZFS mounts)", () => {
    expect(buildFull()).toContain("--privileged");
  });

  test("mounts the Docker socket (required for clone containers)", () => {
    expect(buildFull()).toContain("/var/run/docker.sock");
  });

  test("mounts the dblab data dir with rshared propagation", () => {
    const out = buildFull();
    expect(out).toContain("/var/lib/dblab");
    expect(out).toContain("rshared");
  });

  test("starts with --restart on-failure (engine is the only supervisor)", () => {
    expect(buildFull()).toContain("--restart on-failure");
  });
});

// ---------------------------------------------------------------------------
// CLI install + init + initial refresh
// ---------------------------------------------------------------------------

describe("dblab module — CLI install and initial refresh", () => {
  test("installs the dblab CLI via the official install script", () => {
    const out = buildFull();
    expect(out).toContain("dblab.sh");
    expect(out).toContain("DBLAB_CLI_VERSION=4.1.3");
  });

  test("inits the CLI with environment-id=solo and the correct URL", () => {
    const out = buildFull();
    expect(out).toContain("dblab init");
    expect(out).toContain("--environment-id");
    expect(out).toContain("http://127.0.0.1:2345");
  });

  test("triggers initial snapshot refresh", () => {
    expect(buildFull()).toContain("dblab instance snapshots refresh");
  });

  test("verifies healthz after engine start", () => {
    const out = buildFull();
    expect(out).toContain("/healthz");
  });
});

// ---------------------------------------------------------------------------
// Swapfile
// ---------------------------------------------------------------------------

describe("dblab module — 2 GB swapfile (issue #127 minimal profile)", () => {
  test("creates a 2 GB swapfile", () => {
    const out = buildFull();
    expect(out).toContain("/swapfile");
    // 2 GB: either '2G' (fallocate) or count=2048 (dd with 1M blocks)
    expect(out).toMatch(/2G|2048/);
  });

  test("activates the swapfile via swapon", () => {
    expect(buildFull()).toContain("swapon");
  });

  test("persists swapfile in /etc/fstab", () => {
    expect(buildFull()).toContain("fstab");
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: fail2ban preserved — never disabled (#127 lesson)
// ---------------------------------------------------------------------------

describe("dblab module — fail2ban MUST stay enabled (#127 critical lesson)", () => {
  test("never emits 'systemctl stop fail2ban'", () => {
    expect(buildFull()).not.toContain("systemctl stop fail2ban");
  });

  test("never emits 'systemctl disable fail2ban'", () => {
    expect(buildFull()).not.toContain("systemctl disable fail2ban");
  });

  test("never emits any disable/stop pattern for fail2ban", () => {
    const out = buildFull();
    expect(out).not.toMatch(/systemctl\s+(stop|disable)\s+fail2ban/);
    expect(out).not.toMatch(/fail2ban.*(stop|disable)/);
  });

  test("never drops the UFW rule for the hardened SSH port", () => {
    // The manual install deleted the UFW :2223 rule → near-lockout.
    // The module must NEVER emit a ufw delete command.
    expect(buildFull()).not.toContain("ufw delete");
  });

  test("full output keeps fail2ban enabled via hardening module", () => {
    // The hardening module emits 'systemctl enable --now fail2ban'; the dblab
    // module must not undo it. Verify the enable is present in the combined output.
    expect(buildFull()).toContain("systemctl enable --now fail2ban");
  });

  test("control-plane IP appears in fail2ban ignoreip", () => {
    // The hardening module writes jail.local with trustedIps in ignoreip;
    // the control-plane IP must appear there because provision.ts auto-injects
    // it into trustedIps before cloud-init is built.
    const out = buildFull();
    expect(out).toContain("ignoreip");
    expect(out).toContain(CONTROL_PLANE_IP);
    // The two must appear in proximity (same jail.local block).
    const ignoreipIdx = out.indexOf("ignoreip");
    const cpIdx = out.indexOf(CONTROL_PLANE_IP);
    expect(ignoreipIdx).not.toBe(-1);
    expect(cpIdx).not.toBe(-1);
    // Control-plane IP is within 200 chars of ignoreip line
    expect(Math.abs(ignoreipIdx - cpIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Host Postgres bridge access (#127 step 11)
// ---------------------------------------------------------------------------

describe("dblab module — host Postgres bridge access", () => {
  test("configures pg_hba.conf to allow Docker bridge subnet", () => {
    const out = buildFull();
    // The pg_hba.conf entry for 172.17.0.0/16 allows the dblab_server container
    // to dump prod postgres.
    expect(out).toContain("172.17.0.0/16");
  });
});

// ---------------------------------------------------------------------------
// SSH stability (#127 step 18)
// ---------------------------------------------------------------------------

describe("dblab module — SSH stability", () => {
  test("masks ssh.socket to prevent socket-activation restart loop", () => {
    expect(buildFull()).toContain("systemctl mask ssh.socket");
  });
});

// ---------------------------------------------------------------------------
// Module audit checks
// ---------------------------------------------------------------------------

describe("dblab module — audit checks", () => {
  test("has at least one audit check for engine healthz", () => {
    const check = dblabModule.auditChecks.find(
      (c) => c.probeCommand.includes("healthz"),
    );
    expect(check).toBeDefined();
  });
});
