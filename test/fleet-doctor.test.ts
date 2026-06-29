/**
 * test/fleet-doctor.test.ts — RED TDD for Phase A fleet doctor.
 *
 * ALL tests in this file are RED against current code:
 *   - auditVm is not exported from doctor.ts
 *   - parseLivenessOutput has no 4th serveKind parameter
 *   - src/commands/fleet-doctor.ts does not exist
 *   - src/util/gh-comment.ts does not exist
 *   - parseArgs(["doctor", "--all"]) throws UsageError "requires"
 *
 * After all five changes land, every test here must be GREEN with no modification.
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

// RED: auditVm not yet exported
import {
  auditVm,
  parseLivenessOutput,
} from "../src/commands/doctor.ts";

// RED: module does not exist yet
import {
  runFleetDoctor,
  type FleetDoctorReport,
} from "../src/commands/fleet-doctor.ts";

// RED: module does not exist yet
import {
  upsertIssueComment,
  upsertGhIssue,
} from "../src/util/gh-comment.ts";

import { parseArgs } from "../src/cli.ts";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord, AppRecord } from "../src/types.ts";
import type { RemoteRunner } from "../src/commands/status.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    provider: "hetzner",
    providerId: "12345",
    name: "prod-vm-1",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeApp(vmId: string, o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111-2222-3333-4444",
    vmId,
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    envFile: "/opt/field-record/.env",
    rlsUrlVar: "APP_DATABASE_URL",
    ...o,
  };
}

// ALL_PASS_OUTPUT was defined here for reference during test authoring (unused in assertions).

function passRunner(overrides: Record<string, string> = {}): RemoteRunner {
  return (_vm, script) => {
    const ids: string[] = [];
    const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) ids.push(m[1]!);
    const bodies: Record<string, string> = {
      "ssh-port": "port 2223",
      "ufw-active": "Status: active\nDefault: deny (incoming)",
      "fail2ban-active": "active",
      "sysctl-rpfilter": "1", "sysctl-syncookies": "1",
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
      "service-crash-loop": "Started field-record.service.",
      "failed-auth-burst": "Accepted publickey",
      "sudo-failures": "Accepted publickey",
      "fail2ban-ban-spike": "Total banned: 3",
      "rls-nonsuperuser": "f",
      "pg-localhost": "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
      "app-health": "200",
      ...overrides,
    };
    const stdout = ids
      .map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`)
      .join("\n");
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
}

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-fleet-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// A. auditVm — extracted exported function (RED: not yet exported)
// ===========================================================================
describe("A. auditVm export", () => {
  test("A1 — returns DoctorResult[] for a ready VM with pass remote", async () => {
    const record = makeVm();
    const app = makeApp(record.id);
    // RED: auditVm is not exported from doctor.ts yet — this import fails.
    const results = await auditVm(record, app, passRunner());
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const fails = results.filter(r => r.status === "fail" && r.group !== "core-suspicious");
    expect(fails).toHaveLength(0);
  });

  test("A2 — auditVm throws when remote throws (not swallowed)", async () => {
    const record = makeVm();
    const throwingRunner: RemoteRunner = () => Promise.reject(new Error("connection refused"));
    // RED: auditVm does not exist; also this behavior is new (runDoctor catches, auditVm re-throws)
    await expect(auditVm(record, undefined, throwingRunner)).rejects.toThrow("connection refused");
  });

  test("A3 — runDoctor still works (no behavior change) after extraction", async () => {
    // Ensure runDoctor calling auditVm internally produces exit 0 on all-pass input.
    // This is an existing test pattern; included here to guard the refactor.
    const { runDoctor } = await import("../src/commands/doctor.ts");
    const record = makeVm();
    store.upsert(record);
    const app = makeApp(record.id);
    appStore.upsert(app);
    let outStr = "";
    const code = await runDoctor(
      { target: record.name, infra: false },
      { json: false },
      store,
      appStore,
      (s) => { outStr += s + "\n"; },
      () => {},
      passRunner(),
    );
    expect(code).toBe(0);
    expect(outStr).toContain("pass");
  });
});

// ===========================================================================
// B. parseLivenessOutput caddy-serving — kind-aware fix
//    (RED: 4th parameter does not exist yet)
// ===========================================================================
describe("B. parseLivenessOutput caddy-serving serveKind fix", () => {
  const SS_443_ONLY = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*";
  const SS_BOTH = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*";

  test("B1 — :443 only + serveKind=static → pass (CF-fronted static box)", () => {
    // RED: parseLivenessOutput currently requires both :80 AND :443 unconditionally.
    // With 4th param absent or "node", this returns fail. Only "static" makes it pass.
    const result = parseLivenessOutput("caddy-serving", SS_443_ONLY, 2223, "static");
    expect(result.status).toBe("pass");
  });

  test("B2 — :443 only + serveKind=node → fail (node needs both ports)", () => {
    // RED: 4th parameter does not exist yet (TypeScript error).
    const result = parseLivenessOutput("caddy-serving", SS_443_ONLY, 2223, "node");
    expect(result.status).toBe("fail");
  });

  test("B3 — both :80 + :443 + serveKind=static → still pass", () => {
    // RED: 4th parameter does not exist yet.
    const result = parseLivenessOutput("caddy-serving", SS_BOTH, 2223, "static");
    expect(result.status).toBe("pass");
  });

  test("B4 — :443 only + serveKind omitted → fail (backward compat, node assumed)", () => {
    // This already passes today (both required, only :443, → fail).
    // Listed here to guard that the fix does not break the default behavior.
    const result = parseLivenessOutput("caddy-serving", SS_443_ONLY, 2223);
    expect(result.status).toBe("fail");
  });

  test("B5 — static app auditVm run: :443-only ss-listeners → caddy-serving=pass end-to-end", async () => {
    // RED: auditVm not exported; also serveKind not wired through evaluateDoctorCheck yet.
    const record = makeVm();
    const app = makeApp(record.id, { kind: "static" });
    const runner: RemoteRunner = (_vm, script) => {
      const ids: string[] = [];
      const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(script)) !== null) ids.push(m[1]!);
      // ss-listeners has :443 only (no :80)
      const ssl443Only = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*";
      const bodies: Record<string, string> = {
        ...Object.fromEntries(ids.map((id) => [id, ""])),
        "ssh-port": "port 2223",
        "ufw-active": "Status: active\nDefault: deny (incoming)",
        "fail2ban-active": "active",
        "sysctl-rpfilter": "1", "sysctl-syncookies": "1",
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
        "ss-listeners": ssl443Only,
        "fail2ban-jail": "Status for the jail: sshd",
        "failed-auth-burst": "Accepted publickey",
        "sudo-failures": "Accepted publickey",
        "fail2ban-ban-spike": "Total banned: 3",
      };
      const stdout = ids.map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`).join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    const results = await auditVm(record, app, runner);
    const caddyResult = results.find(r => r.id === "caddy-serving");
    expect(caddyResult).toBeDefined();
    // RED: currently false-fails because :80 is absent. Fix makes it pass for kind=static.
    expect(caddyResult!.status).toBe("pass");
  });
});

// ===========================================================================
// C. runFleetDoctor — sequential fleet sweep
//    (RED: src/commands/fleet-doctor.ts does not exist)
// ===========================================================================
describe("C. runFleetDoctor", () => {
  test("C1 — empty store → report totalVms=0, exit 0", async () => {
    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
    );
    expect(code).toBe(0);
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.totalVms).toBe(0);
    expect(report.failingVms).toBe(0);
    expect(report.errorVms).toBe(0);
    expect(report.vms).toHaveLength(0);
  });

  test("C2 — VMs not in {ready,adopted} are skipped", async () => {
    const skipped: VmRecord["lifecycleState"][] = [
      "planned", "creating", "booting", "degraded", "failed", "destroying", "destroyed",
    ];
    for (const state of skipped) {
      store.upsert(makeVm({ id: `vm-${state}`, name: `vm-${state}`, lifecycleState: state }));
    }
    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
    );
    expect(code).toBe(0);
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.totalVms).toBe(0);
  });

  test("C3 — strictly sequential: remote called one-at-a-time (no concurrent calls)", async () => {
    const vm1 = makeVm({ id: "vm-1", name: "vm-1", lifecycleState: "ready" });
    const vm2 = makeVm({ id: "vm-2", name: "vm-2", lifecycleState: "adopted", ip: "10.0.0.2" });
    store.upsert(vm1);
    store.upsert(vm2);

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;

    const sequentialCheckRunner: RemoteRunner = (_vm, script) => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      totalCalls++;
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        // Simulate async latency
        setTimeout(() => {
          concurrentCalls--;
          const ids: string[] = [];
          const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(script)) !== null) ids.push(m[1]!);
          const stdout = ids.map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n`).join("\n");
          resolve({ code: 0, stdout, stderr: "" });
        }, 10);
      });
    };

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      sequentialCheckRunner,
    );

    // STRICT: never more than 1 concurrent SSH call
    expect(maxConcurrent).toBe(1);
    expect(totalCalls).toBe(2);
  });

  test("C4 — unreachable VM recorded as probe-error; sweep continues to next VM", async () => {
    const vm1 = makeVm({ id: "vm-1", name: "vm-unreachable", lifecycleState: "ready" });
    const vm2 = makeVm({ id: "vm-2", name: "vm-ok", lifecycleState: "ready", ip: "10.0.0.2" });
    store.upsert(vm1);
    store.upsert(vm2);

    const mixedRunner: RemoteRunner = (record, script) => {
      if (record.name === "vm-unreachable") {
        return Promise.reject(new Error("Connection refused"));
      }
      return passRunner()(record, script);
    };

    let outStr = "";
    let errStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      (s) => { errStr += s; },
      mixedRunner,
    );

    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.totalVms).toBe(2);
    expect(report.errorVms).toBe(1);

    const errorResult = report.vms.find(v => v.vmName === "vm-unreachable");
    expect(errorResult).toBeDefined();
    expect(errorResult!.probeError).toMatch(/probe-error/);

    const okResult = report.vms.find(v => v.vmName === "vm-ok");
    expect(okResult).toBeDefined();
    expect(okResult!.checks).toBeDefined();

    // Exit 1 because errorVms > 0
    expect(code).toBe(1);
  });

  test("C5 — all-pass fleet → exit 0, failingVms=0, errorVms=0", async () => {
    store.upsert(makeVm({ id: "vm-a", name: "vm-a", lifecycleState: "ready" }));
    store.upsert(makeVm({ id: "vm-b", name: "vm-b", lifecycleState: "adopted", ip: "10.0.0.2" }));
    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
    );
    expect(code).toBe(0);
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.failingVms).toBe(0);
    expect(report.errorVms).toBe(0);
    expect(report.totalVms).toBe(2);
  });

  test("C6 — one VM with a failing check → exit 1, failingVms=1", async () => {
    const vm = makeVm({ lifecycleState: "ready" });
    store.upsert(vm);
    // ufw-active fail: return wrong value for that check
    const failRunner = passRunner({ "ufw-active": "inactive" });
    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      failRunner,
    );
    expect(code).toBe(1);
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.failingVms).toBe(1);
    const vmResult = report.vms[0]!;
    expect(vmResult.checks).toBeDefined();
    const failing = vmResult.checks!.filter(
      c => c.status === "fail" && c.group !== "core-suspicious"
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  test("C7 — suspicious findings counted in findingVms but do NOT cause exit 1 alone", async () => {
    const vm = makeVm({ lifecycleState: "ready" });
    store.upsert(vm);
    // 30 failed auth lines → suspicious finding, but no actual fail checks
    const thirtyFails = Array(30).fill(
      "Jun 11 12:00 host sshd[1]: Failed password for root from 1.2.3.4"
    ).join("\n");
    const suspiciousRunner = passRunner({ "failed-auth-burst": thirtyFails });
    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      suspiciousRunner,
    );
    expect(code).toBe(0);
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(report.failingVms).toBe(0);
    expect(report.findingVms).toBe(1);
  });

  test("C8 — FleetDoctorReport JSON has required fields", async () => {
    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
    );
    const report = JSON.parse(outStr) as FleetDoctorReport;
    expect(typeof report.at).toBe("string");
    expect(new Date(report.at).toString()).not.toBe("Invalid Date");
    expect(typeof report.totalVms).toBe("number");
    expect(typeof report.failingVms).toBe("number");
    expect(typeof report.errorVms).toBe("number");
    expect(typeof report.findingVms).toBe("number");
    expect(Array.isArray(report.vms)).toBe(true);
  });
});

// ===========================================================================
// D. CLI --all flag parsing
//    (RED: parseDoctor does not recognize --all, throws "requires")
// ===========================================================================
describe("D. CLI doctor --all flag", () => {
  test("D1 — doctor --all parses without error", () => {
    // RED: currently throws UsageError "doctor requires a VM name or id"
    const cmd = parseArgs(["doctor", "--all"]);
    expect(cmd.kind).toBe("doctor");
    if (cmd.kind !== "doctor") throw new Error("wrong kind");
    expect(cmd.input.all).toBe(true);
    expect(cmd.input.target).toBeUndefined();
  });

  test("D2 — doctor --all --json parses json flag", () => {
    // RED: same
    const cmd = parseArgs(["doctor", "--all", "--json"]);
    if (cmd.kind !== "doctor") throw new Error("wrong kind");
    expect(cmd.input.all).toBe(true);
    expect(cmd.json).toBe(true);
  });

  test("D3 — doctor --all --alert-repo owner/repo parses alertRepo", () => {
    // RED: --alert-repo flag not recognized yet
    const cmd = parseArgs(["doctor", "--all", "--alert-repo", "NikolayS/samohost"]);
    if (cmd.kind !== "doctor") throw new Error("wrong kind");
    expect(cmd.input.alertRepo).toBe("NikolayS/samohost");
  });

  test("D4 — doctor <target> --all → UsageError (mutually exclusive)", () => {
    // RED: currently throws "unexpected extra argument" on --all (unknown flag path)
    expect(() => parseArgs(["doctor", "my-vm", "--all"])).toThrow(/exclusive|cannot/i);
  });

  test("D5 — doctor with no target and no --all → still throws /requires/", () => {
    expect(() => parseArgs(["doctor"])).toThrow(/requires/);
  });

  test("D6 — doctor --alert-repo without --all → UsageError (alert-repo requires --all)", () => {
    // RED: flag not recognized yet
    expect(() => parseArgs(["doctor", "my-vm", "--alert-repo", "owner/repo"])).toThrow();
  });
});

// ===========================================================================
// E. src/util/gh-comment.ts exports
//    (RED: file does not exist)
// ===========================================================================
describe("E. gh-comment.ts helper exports", () => {
  test("E1 — upsertIssueComment is a function", () => {
    // RED: module does not exist
    expect(typeof upsertIssueComment).toBe("function");
  });

  test("E2 — upsertGhIssue is a function", () => {
    // RED: module does not exist
    expect(typeof upsertGhIssue).toBe("function");
  });
});

// ===========================================================================
// F. Fleet alert body safety contract
//    (RED: runFleetDoctor does not exist; also alertRepo path not wired)
// ===========================================================================
describe("F. Fleet alert body — no client data, no raw log lines", () => {
  test("F1 — text output of runFleetDoctor (non-json) does not contain raw SSH stdout", async () => {
    const vm = makeVm({ lifecycleState: "ready" });
    store.upsert(vm);
    // Remote returns a body that contains a fake raw log line
    const dangerousRunner: RemoteRunner = (_vm, script) => {
      const ids: string[] = [];
      const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(script)) !== null) ids.push(m[1]!);
      // Inject a suspicious-looking raw log line into failed-auth-burst
      const bodies: Record<string, string> = {
        "ss-listeners": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*",
        "failed-auth-burst": Array(30).fill(
          "Jun 11 12:00 host sshd: Failed password for root from 192.168.1.1"
        ).join("\n"),
      };
      const stdout = ids.map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`).join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    let outStr = "";
    await runFleetDoctor(
      { json: false },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      dangerousRunner,
    );
    // The fleet summary output must NOT contain raw journal lines
    expect(outStr).not.toContain("Failed password for root from 192.168.1.1");
    // But it SHOULD surface a finding count
    expect(outStr).toMatch(/finding|suspicious/i);
  });
});
