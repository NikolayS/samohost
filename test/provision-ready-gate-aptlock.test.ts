/**
 * Regression gate for the provision ready-gate apt-lock strand bug
 * (NikolayS/samohost — provision reliability).
 *
 * Root cause: hardening.ts wrote the completion sentinel
 * (/var/lib/samohost/provision-complete) as the FINAL runcmd, AFTER
 * `ufw --force enable`, `systemctl enable --now fail2ban`/`unattended-upgrades`
 * /`apparmor` + aa-enforce. On a fresh VM those contend with apt-daily for the
 * dpkg/apt lock and `enable --now unattended-upgrades` can block long enough
 * that the sentinel is never written, the runcmd module hangs, cloud-init never
 * reaches boot-finished, and the booting→ready gate (provision.ts) times out at
 * the spec deadline.
 *
 * The fix keeps the SAME security posture (ufw + fail2ban + apparmor +
 * unattended-upgrades all still end enabled) but breaks the dependency:
 *   1. the ready sentinel is written as soon as SSH-critical hardening is done,
 *      BEFORE the slow apt-lock-contending service enables; and
 *   2. the apt-lock-contending steps are lock-tolerant + non-fatal (wait for the
 *      apt/dpkg lock, then `|| true`) so a slow first-boot apt lock can never
 *      strand cloud-init / the gate.
 *
 * These are pure render/data-contract assertions over the cloud-init the builder
 * emits (no host, no network) — a Playwright spec is N/A for a cloud-init
 * ordering invariant; the renderer is exercised end-to-end via buildCloudInit.
 */

import { describe, expect, test } from "bun:test";
import { buildCloudInit } from "../src/cloudinit/builder.ts";
import {
  hardeningModule,
  PROVISION_SENTINEL_PATH,
} from "../src/cloudinit/hardening.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";

/** Extract the ordered runcmd entries from a rendered cloud-init document. */
function runcmdLines(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l === "runcmd:");
  if (start === -1) return [];
  const cmds: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith("  - ")) break;
    // Strip the "  - " prefix and any surrounding YAML single-quotes.
    let cmd = l.slice(4);
    if (cmd.startsWith("'") && cmd.endsWith("'")) {
      cmd = cmd.slice(1, -1).split("''").join("'");
    }
    cmds.push(cmd);
  }
  return cmds;
}

describe("provision ready-gate must not depend on apt-lock-contending steps", () => {
  const out = buildCloudInit(makeSpec(), [], { sshPubkey: SAMPLE_PUBKEY });
  const cmds = runcmdLines(out);

  const sentinelIdx = cmds.findIndex((c) => c.includes(PROVISION_SENTINEL_PATH));
  const unattendedIdx = cmds.findIndex((c) =>
    /enable .*\bunattended-upgrades\b/.test(c),
  );
  const fail2banIdx = cmds.findIndex((c) =>
    /enable .*\bfail2ban\b/.test(c),
  );
  const apparmorIdx = cmds.findIndex((c) =>
    /enable .*\bapparmor\b/.test(c),
  );

  test("the runcmd list and all gating commands are present", () => {
    expect(cmds.length).toBeGreaterThan(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(unattendedIdx).toBeGreaterThanOrEqual(0);
    expect(fail2banIdx).toBeGreaterThanOrEqual(0);
    expect(apparmorIdx).toBeGreaterThanOrEqual(0);
  });

  test("the completion sentinel is written BEFORE `enable --now unattended-upgrades` (the slow apt-lock step that strands the gate)", () => {
    expect(sentinelIdx).toBeLessThan(unattendedIdx);
  });

  test("the completion sentinel is written BEFORE every apt-lock-contending service enable (fail2ban, unattended-upgrades, apparmor)", () => {
    expect(sentinelIdx).toBeLessThan(fail2banIdx);
    expect(sentinelIdx).toBeLessThan(unattendedIdx);
    expect(sentinelIdx).toBeLessThan(apparmorIdx);
  });

  test("the apt-lock-contending service enables are non-fatal so a held first-boot lock can never strand cloud-init / the gate", () => {
    for (const idx of [fail2banIdx, unattendedIdx, apparmorIdx]) {
      const cmd = cmds[idx]!;
      expect(
        cmd.includes("|| true"),
        `expected runcmd to be non-fatal (|| true): ${cmd}`,
      ).toBe(true);
    }
  });

  test("the slow service enables wait for the apt/dpkg lock so they don't fail spuriously while still ending enabled", () => {
    // After the sentinel, at least one command must guard on the apt/dpkg lock
    // (e.g. cloud-init status --wait, apt-get -o DPkg::Lock or a lock-wait loop)
    // so the enables are lock-tolerant rather than racing apt-daily.
    const post = cmds.slice(sentinelIdx + 1).join("\n");
    expect(
      /lock|cloud-init status --wait|DPkg::Lock|fuser .*lock|apt-daily/.test(post),
      "expected a lock-tolerance guard after the sentinel for the apt-contending steps",
    ).toBe(true);
  });

  test("SECURITY POSTURE PRESERVED: ufw + fail2ban + apparmor + unattended-upgrades are all still enabled by the runcmd", () => {
    const joined = cmds.join("\n");
    expect(joined).toContain("ufw --force enable");
    expect(/enable .*\bfail2ban\b/.test(joined)).toBe(true);
    expect(/enable .*\bunattended-upgrades\b/.test(joined)).toBe(true);
    expect(/enable .*\bapparmor\b/.test(joined)).toBe(true);
    expect(joined).toContain("aa-enforce");
    // sysctl hardening still applied.
    expect(joined).toContain("sysctl --system");
  });

  test("SSH-critical hardening still runs before the sentinel (ssh restart + ufw bring-up + root key truncation)", () => {
    const sshRestartIdx = cmds.findIndex((c) => c === "systemctl restart ssh");
    const ufwEnableIdx = cmds.findIndex((c) => c === "ufw --force enable");
    const rootKeyIdx = cmds.findIndex((c) =>
      c.includes("/root/.ssh/authorized_keys") && c.includes("truncate"),
    );
    expect(sshRestartIdx).toBeGreaterThanOrEqual(0);
    expect(ufwEnableIdx).toBeGreaterThanOrEqual(0);
    expect(rootKeyIdx).toBeGreaterThanOrEqual(0);
    expect(sshRestartIdx).toBeLessThan(sentinelIdx);
    expect(ufwEnableIdx).toBeLessThan(sentinelIdx);
    expect(rootKeyIdx).toBeLessThan(sentinelIdx);
  });

  test("the hardening module's own fragment exposes the same ordering invariant (unit-level)", () => {
    const frag = hardeningModule.cloudInitFragment(makeSpec());
    const runcmd = frag.runcmd ?? [];
    const sIdx = runcmd.findIndex((c) => c.includes(PROVISION_SENTINEL_PATH));
    const uIdx = runcmd.findIndex((c) =>
      /enable .*\bunattended-upgrades\b/.test(c),
    );
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(uIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeLessThan(uIdx);
  });
});
