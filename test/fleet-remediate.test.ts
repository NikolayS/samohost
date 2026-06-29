/**
 * test/fleet-remediate.test.ts — RED TDD for Phase C conservative auto-remediation.
 *
 * ALL four test groups in this file are RED until Phase C lands:
 *   - src/remediate/firewall-lock.ts does not exist
 *   - runFleetDoctor does not accept remediate/apply opts
 *   - classifyVm is not exported from anywhere
 *   - ParsedDoctor.input has no remediate/apply/controlPlaneIp fields
 *
 * After Phase C implementation, every test here must pass with no modification.
 *
 * Design constraints verified by these tests:
 *   - OFF BY DEFAULT: remediate:true required; without it the new code path
 *     is never entered.
 *   - DRY-RUN: apply:false means no SSH mutation (no ufw delete ever sent).
 *   - ENTANGLED/UNKNOWN: classifier gate; these classes never trigger mutation.
 *   - SAFE + APPLY: additive CF allows appear BEFORE world-open deletes in the
 *     relock script (set -euo pipefail abort-on-curl-fail makes this safe).
 *   - SCOPED classifier: grep scoped to sites.d/ only; parent Caddyfile ignored.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RED: module does not exist yet
import {
  classifyVm,
  type FleetRemediationResult,
  type VmClass,
} from "../src/remediate/firewall-lock.ts";

import {
  runFleetDoctor,
} from "../src/commands/fleet-doctor.ts";

import { parseArgs } from "../src/cli.ts";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord, AppRecord } from "../src/types.ts";
import type { RemoteRunner } from "../src/commands/status.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-remed-bbbb-cccc-dddd-eeeeeeeeeeee",
    provider: "hetzner",
    providerId: "55555",
    name: "prod-vm-remed",
    ip: "10.0.0.5",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "C".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

/**
 * Minimal audit runner that returns pass for all checks except overrides.
 * Recognises the audit script by looking for <<<SAMOHOST_AUDIT:...>>> markers.
 */
function makeAuditRunner(overrides: Record<string, string> = {}): RemoteRunner {
  return (_vm, script) => {
    const ids: string[] = [];
    const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) ids.push(m[1]!);
    const bodies: Record<string, string> = {
      "ssh-port": "port 2223",
      "ufw-active": "Status: active\nDefault: deny (incoming)",
      "fail2ban-active": "active",
      "sysctl-rpfilter": "1",
      "sysctl-syncookies": "1",
      "sysctl-redirects": "0",
      "apparmor-enforced": "12 profiles are in enforce mode.",
      "permitrootlogin": "permitrootlogin no",
      "passwordauth": "passwordauthentication no",
      "allowusers": "allowusers agent",
      "maxauthtries": "maxauthtries 3",
      "clientalive": "clientaliveinterval 300\nclientalivecountmax 2",
      "x11forwarding": "x11forwarding no",
      "allowagentforwarding": "allowagentforwarding no",
      "permituserenvironment": "permituserenvironment no",
      "permitemptypasswords": "permitemptypasswords no",
      "root-authorized-keys-empty": "0",
      "ufw-limit-ssh": "2223/tcp                   LIMIT       Anywhere",
      "web-ports-not-world-open": "",
      "unattended-upgrades-active": "active",
      "only-intended-ports": "",
      "env-file-perms": "600 agent",
      "git-remote-no-token": "origin\thttps://github.com/Tanya301/field-record-1 (fetch)",
      "ss-listeners": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
      "fail2ban-jail": "Status for the jail: sshd",
      "service-crash-loop": "Started service.",
      "failed-auth-burst": "Accepted publickey",
      "sudo-failures": "Accepted publickey",
      "fail2ban-ban-spike": "Total banned: 3",
      ...overrides,
    };
    const stdout = ids
      .map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`)
      .join("\n");
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
}

/** Return true if the command is a doctor audit script (contains audit markers). */
function isAuditScript(cmd: string): boolean {
  return cmd.includes("<<<SAMOHOST_AUDIT:");
}

/** Return true if the command is the Caddy TLS classifier probe for sites.d. */
function isClassifierProbe(cmd: string): boolean {
  return cmd.includes("/etc/caddy/sites.d/");
}

/** Return true if the command contains additive CF allow rules. */
function isCfAllowCmd(cmd: string): boolean {
  return cmd.includes("ufw allow from") && cmd.includes("443");
}

/** Return true if the command issues a ufw delete. */
function isDeleteCmd(cmd: string): boolean {
  return cmd.includes("ufw delete");
}

/** Return true if the command is the post-lock verify probe. */
function isVerifyProbe(cmd: string): boolean {
  return cmd.includes("ufw status") && cmd.includes("grep");
}

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-remed-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// (a) DRY-RUN DEFAULT — remediate:true, apply:false
// ===========================================================================
describe("(a) DRY-RUN DEFAULT — remediate:true apply:false", () => {
  test("a1 — runner called exactly once (audit only), no ufw delete ever sent", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const calls: string[] = [];
    const runner: RemoteRunner = (vmArg, cmd) => {
      calls.push(cmd);
      return makeAuditRunner({ "web-ports-not-world-open": "443/tcp ALLOW Anywhere" })(vmArg, cmd);
    };

    const outLines: string[] = [];
    await runFleetDoctor(
      { json: true, remediate: true, apply: false },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    // Runner called exactly once: only the audit pass.
    expect(calls).toHaveLength(1);
    expect(isAuditScript(calls[0]!)).toBe(true);

    // No ufw delete command was ever sent.
    expect(calls.some(isDeleteCmd)).toBe(false);
  });

  test("a2 — JSON output has remediation entry with applied:false and wouldLock:true", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const outLines: string[] = [];
    await runFleetDoctor(
      { json: true, remediate: true, apply: false },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      makeAuditRunner({ "web-ports-not-world-open": "443/tcp ALLOW Anywhere" }),
    );

    const report = JSON.parse(outLines.join(""));
    expect(report.remediations).toBeDefined();
    expect(Array.isArray(report.remediations)).toBe(true);
    expect(report.remediations.length).toBeGreaterThan(0);
    const entry = report.remediations[0] as FleetRemediationResult;
    expect(entry.applied).toBe(false);
    expect(entry.wouldLock).toBe(true);
    expect(entry.vmName).toBe(vm.name);
  });

  test("a3 — VM passing web-ports check does NOT appear in remediations", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const outLines: string[] = [];
    // Default passRunner has web-ports-not-world-open="" (pass).
    await runFleetDoctor(
      { json: true, remediate: true, apply: false },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      makeAuditRunner(),
    );

    const report = JSON.parse(outLines.join(""));
    // remediations may be absent or empty — either is acceptable.
    const remediations: FleetRemediationResult[] = report.remediations ?? [];
    expect(remediations.length).toBe(0);
  });

  test("a4 — --apply without --remediate is a UsageError", () => {
    expect(() => parseArgs(["doctor", "--all", "--apply"])).toThrow();
  });
});

// ===========================================================================
// (b) ENTANGLED / empty-sites.d / mixed — apply:true, never locks
// ===========================================================================
describe("(b) ENTANGLED / empty-sites.d / mixed — alert-only, no lock", () => {
  /**
   * Build a runner that handles:
   * - audit script → web-ports-not-world-open=fail
   * - classifier probe → returns the supplied classifierOutput
   * - any other command → pass through (should not happen)
   */
  function makeEntangledRunner(classifierOutput: string | null): RemoteRunner {
    return (vmArg, cmd) => {
      if (isAuditScript(cmd)) {
        return makeAuditRunner({ "web-ports-not-world-open": "443/tcp ALLOW Anywhere" })(vmArg, cmd);
      }
      if (isClassifierProbe(cmd)) {
        if (classifierOutput === null) {
          return Promise.reject(new Error("SSH transport error: connection reset"));
        }
        return Promise.resolve({ code: 0, stdout: classifierOutput, stderr: "" });
      }
      // Anything else is unexpected in these ENTANGLED tests.
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
  }

  test("b1 — empty sites.d (total=0) → ENTANGLED, no ufw delete", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const calls: string[] = [];
    const runner: RemoteRunner = (vmArg, cmd) => {
      calls.push(cmd);
      return makeEntangledRunner("TOTAL=0\nTLS=0")(vmArg, cmd);
    };

    const outLines: string[] = [];
    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    expect(calls.some(isDeleteCmd)).toBe(false);

    const report = JSON.parse(outLines.join(""));
    const entry = report.remediations?.[0] as FleetRemediationResult | undefined;
    expect(entry).toBeDefined();
    expect(entry!.class).toBe("ENTANGLED");
    expect(entry!.applied).toBe(false);
    expect(typeof entry!.alert).toBe("string");
    expect(entry!.alert!.length).toBeGreaterThan(0);
  });

  test("b2 — mixed snippets (total=2, tls=1) → ENTANGLED, no ufw delete", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const calls: string[] = [];
    const runner: RemoteRunner = (vmArg, cmd) => {
      calls.push(cmd);
      return makeEntangledRunner("TOTAL=2\nTLS=1")(vmArg, cmd);
    };

    const outLines: string[] = [];
    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    expect(calls.some(isDeleteCmd)).toBe(false);

    const report = JSON.parse(outLines.join(""));
    const entry = report.remediations?.[0] as FleetRemediationResult | undefined;
    expect(entry!.class).toBe("ENTANGLED");
    expect(entry!.applied).toBe(false);
  });

  test("b3 — SSH transport error during classify → UNKNOWN, no ufw delete", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const calls: string[] = [];
    const runner: RemoteRunner = (vmArg, cmd) => {
      calls.push(cmd);
      return makeEntangledRunner(null)(vmArg, cmd);
    };

    const outLines: string[] = [];
    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    expect(calls.some(isDeleteCmd)).toBe(false);

    const report = JSON.parse(outLines.join(""));
    const entry = report.remediations?.[0] as FleetRemediationResult | undefined;
    expect(entry!.class).toBe("UNKNOWN");
    expect(entry!.applied).toBe(false);
  });
});

// ===========================================================================
// (c) SAFE + APPLY — additive-first lock, CF CIDRs before deletes
// ===========================================================================
describe("(c) SAFE + APPLY — additive-first lock, verify", () => {
  /**
   * Multi-stage runner that simulates the full remediation flow for a SAFE VM:
   * 1. Audit: web-ports-not-world-open=fail
   * 2. Classifier: TOTAL=1, TLS=1 (SAFE)
   * 3. Relock script (SSH call that has ufw allow from ... and ufw delete ...)
   * 4. Verify: empty output (no world-open rules remain)
   */
  function makeSafeApplyRunner(): { runner: RemoteRunner; commands: string[] } {
    const commands: string[] = [];
    const runner: RemoteRunner = (vmArg, cmd) => {
      commands.push(cmd);

      if (isAuditScript(cmd)) {
        return makeAuditRunner({ "web-ports-not-world-open": "443/tcp ALLOW Anywhere" })(vmArg, cmd);
      }
      if (isClassifierProbe(cmd)) {
        return Promise.resolve({ code: 0, stdout: "TOTAL=1\nTLS=1", stderr: "" });
      }
      if (isVerifyProbe(cmd) && !isCfAllowCmd(cmd)) {
        // Verify probe: return empty (no world-open rules remain after lock).
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      // Relock script: return success.
      return Promise.resolve({ code: 0, stdout: "Rules updated", stderr: "" });
    };
    return { runner, commands };
  }

  test("c1 — CF allow appears in script before ufw delete (additive-first ordering)", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const { runner, commands } = makeSafeApplyRunner();
    const outLines: string[] = [];

    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    // Find the relock command(s). The relock script must contain both CF allows
    // and ufw deletes. If they are a single script, CF allows must precede deletes
    // by string position. If they are separate commands, CF allow command must
    // come at a lower index than the delete command.
    const cfAllowCmds = commands.filter(isCfAllowCmd);
    const deleteCmds = commands.filter(isDeleteCmd);

    expect(cfAllowCmds.length).toBeGreaterThan(0);
    expect(deleteCmds.length).toBeGreaterThan(0);

    // Find first position in commands[] of each type.
    const firstCfAllowIdx = commands.findIndex(isCfAllowCmd);
    const firstDeleteIdx = commands.findIndex(isDeleteCmd);

    if (firstCfAllowIdx === firstDeleteIdx) {
      // Same command — check by string position within the script.
      const script = commands[firstCfAllowIdx]!;
      const allowPos = script.indexOf("ufw allow from");
      const deletePos = script.indexOf("ufw delete");
      expect(allowPos).toBeGreaterThanOrEqual(0);
      expect(deletePos).toBeGreaterThanOrEqual(0);
      expect(allowPos).toBeLessThan(deletePos);
    } else {
      // Separate commands — CF allow command must come before delete command.
      expect(firstCfAllowIdx).toBeLessThan(firstDeleteIdx);
    }
  });

  test("c2 — verify probe matches web-ports-not-world-open pattern", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const { runner, commands } = makeSafeApplyRunner();
    const outLines: string[] = [];

    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    // There must be a verify probe command that checks ufw status for 80/443.
    const verifyCmd = commands.find(isVerifyProbe);
    expect(verifyCmd).toBeDefined();
    // Must filter for 80 and 443 lines (same as web-ports-not-world-open check).
    expect(verifyCmd).toMatch(/ufw status/);
    expect(verifyCmd).toMatch(/80|443/);
  });

  test("c3 — result has applied:true and verified:true", async () => {
    const vm = makeVm();
    store.upsert(vm);

    const { runner } = makeSafeApplyRunner();
    const outLines: string[] = [];

    await runFleetDoctor(
      { json: true, remediate: true, apply: true, controlPlaneIp: "10.99.0.1" },
      store,
      appStore,
      (s) => outLines.push(s),
      () => {},
      runner,
    );

    const report = JSON.parse(outLines.join(""));
    const entry = report.remediations?.[0] as FleetRemediationResult | undefined;
    expect(entry).toBeDefined();
    expect(entry!.class).toBe("SAFE");
    expect(entry!.applied).toBe(true);
    expect(entry!.verified).toBe(true);
    expect(entry!.vmName).toBe(vm.name);
  });

  test("c4 — --apply without --control-plane-ip is a UsageError", () => {
    expect(() =>
      parseArgs(["doctor", "--all", "--remediate", "--apply"]),
    ).toThrow();
  });
});

// ===========================================================================
// (d) SITES.D-SCOPED CLASSIFIER REGRESSION
// ===========================================================================
describe("(d) SITES.D-SCOPED CLASSIFIER REGRESSION", () => {
  test("d1 — classifyVm ignores /etc/caddy/Caddyfile, scopes only to sites.d/", async () => {
    const vm = makeVm();

    /**
     * Runner that simulates a VM where:
     * - The parent Caddyfile only has `import sites.d/*.caddy` (no tls internal)
     * - The sites.d/ snippets DO contain `tls internal`
     *
     * A whole-tree grep would find no `tls internal` in the Caddyfile and wrongly
     * mark the VM ENTANGLED. The scoped classifier must ignore Caddyfile entirely.
     */
    const runner: RemoteRunner = (_vmArg, cmd) => {
      if (cmd.includes("/etc/caddy/Caddyfile")) {
        // Parent Caddyfile — contains `import sites.d/*.caddy` but NOT tls internal.
        return Promise.resolve({ code: 0, stdout: "import sites.d/*.caddy", stderr: "" });
      }
      if (cmd.includes("/etc/caddy/sites.d/")) {
        // TOTAL=1, TLS=1 — all snippets use tls internal.
        return Promise.resolve({ code: 0, stdout: "TOTAL=1\nTLS=1", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    // RED: classifyVm does not exist yet.
    const vmClass: VmClass = await classifyVm(vm, runner);
    expect(vmClass).toBe("SAFE");
  });

  test("d2 — classifyVm returns ENTANGLED for a VM with mixed snippets", async () => {
    const vm = makeVm();

    const runner: RemoteRunner = (_vmArg, cmd) => {
      if (cmd.includes("/etc/caddy/sites.d/")) {
        return Promise.resolve({ code: 0, stdout: "TOTAL=3\nTLS=2", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const vmClass: VmClass = await classifyVm(vm, runner);
    expect(vmClass).toBe("ENTANGLED");
  });

  test("d3 — classifyVm returns ENTANGLED for empty sites.d (total=0)", async () => {
    const vm = makeVm();

    const runner: RemoteRunner = (_vmArg, cmd) => {
      if (cmd.includes("/etc/caddy/sites.d/")) {
        return Promise.resolve({ code: 0, stdout: "TOTAL=0\nTLS=0", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const vmClass: VmClass = await classifyVm(vm, runner);
    expect(vmClass).toBe("ENTANGLED");
  });

  test("d4 — classifyVm returns UNKNOWN when SSH throws", async () => {
    const vm = makeVm();

    const runner: RemoteRunner = () => {
      return Promise.reject(new Error("connection refused"));
    };

    const vmClass: VmClass = await classifyVm(vm, runner);
    expect(vmClass).toBe("UNKNOWN");
  });
});

// ===========================================================================
// (e) CLI parse — --remediate and --apply flag wiring
// ===========================================================================
describe("(e) CLI parseArgs — --remediate / --apply / --control-plane-ip", () => {
  test("e1 — --remediate sets remediate:true in parsed input", () => {
    const parsed = parseArgs(["doctor", "--all", "--remediate"]);
    expect(parsed.kind).toBe("doctor");
    if (parsed.kind === "doctor") {
      expect((parsed.input as any).remediate).toBe(true);
      expect((parsed.input as any).apply).toBe(false);
    }
  });

  test("e2 — --remediate --apply --control-plane-ip sets all three", () => {
    const parsed = parseArgs([
      "doctor",
      "--all",
      "--remediate",
      "--apply",
      "--control-plane-ip",
      "10.99.0.1",
    ]);
    expect(parsed.kind).toBe("doctor");
    if (parsed.kind === "doctor") {
      expect((parsed.input as any).remediate).toBe(true);
      expect((parsed.input as any).apply).toBe(true);
      expect((parsed.input as any).controlPlaneIp).toBe("10.99.0.1");
    }
  });

  test("e3 — --apply without --remediate is a UsageError", () => {
    expect(() => parseArgs(["doctor", "--all", "--apply"])).toThrow();
  });

  test("e4 — --apply without --control-plane-ip is a UsageError", () => {
    expect(() =>
      parseArgs(["doctor", "--all", "--remediate", "--apply"]),
    ).toThrow();
  });

  test("e5 — --remediate without --all is a UsageError", () => {
    expect(() => parseArgs(["doctor", "vm-name", "--remediate"])).toThrow();
  });
});
