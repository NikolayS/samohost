/**
 * test/dblab-not-oversized.test.ts — RED→GREEN TDD for the dblab-not-oversized
 * fleet-doctor guardrail.
 *
 * Check id:   "dblab-not-oversized"
 * Group:      "infra-sizing"
 * Kind:       LOCAL-only — reads state.json + apps.json, no SSH, no hcloud call.
 *
 * Logic:
 *   - An app is dblab-backed when AppRecord.previewDbBackend === "dblab".
 *   - The dblab VM is the VmRecord whose id matches AppRecord.vmId.
 *   - Approved minimal server types: cx23, cx22, cpx11.
 *   - Anything else (cx33, cx41, cx52, ccx*, cpx31+, …) is oversized.
 *   - Emit status "fail" with a descriptive message when any dblab VM is
 *     over-sized; emit "pass" when all dblab VMs are on the approved profile.
 *
 * Volume-tracking caveat (code comment in impl):
 *   samohost state.json does not currently track attached volume size; the check
 *   therefore flags on server type alone. A follow-up is needed to track volume
 *   metadata so large volumes on otherwise-approved types are also caught.
 *
 * Real-world fixture:
 *   field-record (app "field-record", vmId 8846e4d4-…) is on cx33 with
 *   previewDbBackend="dblab" → MUST flag as oversized.
 *   Other clients are on cx23 without dblab → MUST NOT be flagged.
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
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord, AppRecord } from "../src/types.ts";
import type { RemoteRunner } from "../src/commands/status.ts";

// RED: this export does not exist yet.
import { checkDblabNotOversized } from "../src/doctor/dblab-sizing.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-0000-0000-0000-0000-000000000001",
    provider: "hetzner",
    providerId: "12345",
    name: "field-record-vm",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "nbg1",
    type: "cx33",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(vmId: string, overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
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
    previewDbBackend: "dblab",
    ...overrides,
  };
}

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samo-dblab-sizing-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// 1. Core check scenarios
// ===========================================================================
describe("1. checkDblabNotOversized — core scenarios", () => {

  test("1a. cx33 dblab VM → fail with descriptive message", () => {
    // RED: checkDblabNotOversized does not exist yet.
    // This is the real-world field-record scenario: cx33 + previewDbBackend=dblab → must fail.
    const vm = makeVm({ id: "8846e4d4-2303-41a9-950a-71b1048247a4", type: "cx33", name: "field-record-vm" });
    const app = makeApp(vm.id);
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.id).toBe("dblab-not-oversized");
    expect(result.group).toBe("infra-sizing");
    expect(result.status).toBe("fail");
    // Description must mention the VM name and server type.
    expect(result.description).toContain("field-record-vm");
    expect(result.description).toContain("cx33");
    // Must mention the approved profile.
    expect(result.description).toContain("cx23");
    // Must reference the cost doc.
    expect(result.description).toContain("docs/stack/dblab.md");
  });

  test("1b. cx23 dblab VM → pass", () => {
    // Approved minimal profile: cx23 with dblab should NOT fail.
    const vm = makeVm({ id: "vm-cx23-1", type: "cx23", name: "small-dblab-vm" });
    const app = makeApp(vm.id);
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });

  test("1c. cx22 dblab VM → pass (also approved minimal profile)", () => {
    const vm = makeVm({ id: "vm-cx22-1", type: "cx22", name: "cx22-dblab-vm" });
    const app = makeApp(vm.id);
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });

  test("1d. cpx11 dblab VM → pass (also approved minimal profile)", () => {
    const vm = makeVm({ id: "vm-cpx11-1", type: "cpx11", name: "cpx11-dblab-vm" });
    const app = makeApp(vm.id);
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });

  test("1e. cx33 VM that is NOT dblab → not flagged by this check (pass)", () => {
    // A cx33 VM whose app uses previewDbBackend="template" or "none" or no field
    // should NOT be flagged — this check is dblab-specific.
    const vm = makeVm({ id: "vm-cx33-nodb", type: "cx33", name: "cx33-no-dblab" });
    const app = makeApp(vm.id, { previewDbBackend: "template" });
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });

  test("1f. cx33 VM with no previewDbBackend field (absent = not dblab) → pass", () => {
    const vm = makeVm({ id: "vm-cx33-nofield", type: "cx33", name: "cx33-no-previewfield" });
    const appWithoutField = makeApp(vm.id, { previewDbBackend: undefined });
    store.upsert(vm);
    appStore.upsert(appWithoutField);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });

  test("1g. empty fleet (no VMs, no apps) → pass", () => {
    // No dblab VMs at all → nothing to flag.
    const result = checkDblabNotOversized([], []);

    expect(result.status).toBe("pass");
  });
});

// ===========================================================================
// 2. Multiple VMs — mixed fleet
// ===========================================================================
describe("2. Multiple VMs — mixed dblab and non-dblab", () => {

  test("2a. one oversized dblab VM + five cx23 VMs → fail (only the dblab VM flagged)", () => {
    // Mirrors real-world fleet: 1 field-record (cx33+dblab) + 5 cx23 clients.
    const dblabVm = makeVm({
      id: "8846e4d4-2303-41a9-950a-71b1048247a4",
      type: "cx33",
      name: "field-record-vm",
    });
    const dblabApp = makeApp(dblabVm.id, { previewDbBackend: "dblab" });
    store.upsert(dblabVm);
    appStore.upsert(dblabApp);

    for (let i = 1; i <= 5; i++) {
      const vm = makeVm({ id: `vm-cx23-${i}`, type: "cx23", name: `client-${i}` });
      // These apps either have no dblab or have template backend.
      const app = makeApp(vm.id, { previewDbBackend: i % 2 === 0 ? "template" : undefined });
      store.upsert(vm);
      appStore.upsert(app);
    }

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("fail");
    // Only the dblab oversized VM should appear in the description.
    expect(result.description).toContain("field-record-vm");
    expect(result.description).toContain("cx33");
    // Client VMs must NOT appear.
    expect(result.description).not.toContain("client-1");
    expect(result.description).not.toContain("client-2");
  });

  test("2b. two oversized dblab VMs → fail, both mentioned in description", () => {
    const vm1 = makeVm({ id: "vm-dblab-a", type: "cx33", name: "dblab-vm-a" });
    const vm2 = makeVm({ id: "vm-dblab-b", type: "cx41", name: "dblab-vm-b" });
    const app1 = makeApp(vm1.id, { previewDbBackend: "dblab" });
    const app2 = makeApp(vm2.id, { previewDbBackend: "dblab" });
    store.upsert(vm1);
    store.upsert(vm2);
    appStore.upsert(app1);
    appStore.upsert(app2);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("fail");
    expect(result.description).toContain("dblab-vm-a");
    expect(result.description).toContain("dblab-vm-b");
  });

  test("2c. all dblab VMs on cx23 → pass", () => {
    for (let i = 1; i <= 3; i++) {
      const vm = makeVm({ id: `vm-ok-${i}`, type: "cx23", name: `ok-${i}` });
      const app = makeApp(vm.id, { previewDbBackend: "dblab" });
      store.upsert(vm);
      appStore.upsert(app);
    }

    const result = checkDblabNotOversized(store.list(), appStore.list());

    expect(result.status).toBe("pass");
  });
});

// ===========================================================================
// 3. Oversized-type coverage
// ===========================================================================
describe("3. Oversized server types are all flagged", () => {
  const OVERSIZED_TYPES = ["cx33", "cx41", "cx52", "ccx13", "ccx23", "ccx33", "cpx31", "cpx41", "cpx51"];

  for (const serverType of OVERSIZED_TYPES) {
    test(`3. ${serverType} + dblab → fail`, () => {
      const vm = makeVm({ id: `vm-${serverType}`, type: serverType, name: `vm-${serverType}` });
      const app = makeApp(vm.id, { previewDbBackend: "dblab" });
      store.upsert(vm);
      appStore.upsert(app);

      const result = checkDblabNotOversized(store.list(), appStore.list());

      expect(result.status).toBe("fail");
    });
  }
});

// ===========================================================================
// 4. Fleet-doctor integration — check appears in buildAlertBody / fleet output
// ===========================================================================
describe("4. Fleet-doctor integration", () => {

  test("4a. checkDblabNotOversized result shape is compatible with DoctorResult", () => {
    // The result must have all required DoctorResult fields so it can be
    // embedded into fleet-doctor output without special-casing.
    const vm = makeVm({ type: "cx23" });
    const app = makeApp(vm.id);
    store.upsert(vm);
    appStore.upsert(app);

    const result = checkDblabNotOversized(store.list(), appStore.list());

    // Required DoctorResult fields:
    expect(typeof result.id).toBe("string");
    expect(typeof result.description).toBe("string");
    expect(typeof result.group).toBe("string");
    expect(["pass", "fail", "unknown", "skip"]).toContain(result.status);
    // stdout and stderr are optional metadata (may be empty string).
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });

  test("4b. runFleetDoctor includes dblab-not-oversized in JSON output when VM is oversized", async () => {
    // RED: runFleetDoctor does not call checkDblabNotOversized yet.
    // After wiring, the fleet JSON must include a local-only check with id="dblab-not-oversized".
    const { runFleetDoctor } = await import("../src/commands/fleet-doctor.ts");

    const vm = makeVm({ id: "8846e4d4-2303-41a9-950a-71b1048247a4", type: "cx33", name: "field-record-vm" });
    const app = makeApp(vm.id, { previewDbBackend: "dblab" });
    store.upsert(vm);
    appStore.upsert(app);

    // Minimal pass runner — returns empty bodies for all SSH probes.
    const passRunner: RemoteRunner = (_vm, script) => {
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
        "caddy-serving": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
        "fail2ban-jail": "Status for the jail: sshd",
        "service-crash-loop": "Started field-record.service.",
        "failed-auth-burst": "Accepted publickey",
        "sudo-failures": "Accepted publickey",
        "fail2ban-ban-spike": "Total banned: 3",
        "rls-nonsuperuser": "f",
        "pg-localhost": "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
        "app-health": "200",
      };
      const stdout = ids
        .map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`)
        .join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner,
    );

    const report = JSON.parse(outStr);
    // The fleet report must include a VM-level dblab-not-oversized entry.
    // It appears as a local check in the per-VM checks array.
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "field-record-vm");
    expect(vmResult).toBeDefined();
    const dblabCheck = vmResult.checks?.find((c: { id: string }) => c.id === "dblab-not-oversized");
    expect(dblabCheck).toBeDefined();
    expect(dblabCheck.status).toBe("fail");
    // The fleet report failingVms counter must include this VM.
    expect(report.failingVms).toBeGreaterThan(0);
  });

  test("4c. cx23 dblab VM → dblab-not-oversized=pass in fleet JSON, not counted in failingVms", async () => {
    const { runFleetDoctor } = await import("../src/commands/fleet-doctor.ts");

    const vm = makeVm({ id: "vm-cx23-ok", type: "cx23", name: "small-dblab" });
    const app = makeApp(vm.id, { previewDbBackend: "dblab" });
    store.upsert(vm);
    appStore.upsert(app);

    const passRunner: RemoteRunner = (_vm, script) => {
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
        "caddy-serving": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
        "fail2ban-jail": "Status for the jail: sshd",
        "service-crash-loop": "Started field-record.service.",
        "failed-auth-burst": "Accepted publickey",
        "sudo-failures": "Accepted publickey",
        "fail2ban-ban-spike": "Total banned: 3",
        "rls-nonsuperuser": "f",
        "pg-localhost": "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
        "app-health": "200",
      };
      const stdout = ids
        .map((id) => `<<<SAMOHOST_AUDIT:${id}}>>>\n${bodies[id] ?? ""}`)
        .join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "small-dblab");
    expect(vmResult).toBeDefined();
    const dblabCheck = vmResult.checks?.find((c: { id: string }) => c.id === "dblab-not-oversized");
    expect(dblabCheck).toBeDefined();
    expect(dblabCheck.status).toBe("pass");
    // cx23 dblab VM must NOT inflate failingVms.
    expect(report.failingVms).toBe(0);
  });
});
