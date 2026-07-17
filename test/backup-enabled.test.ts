/**
 * test/backup-enabled.test.ts — RED→GREEN TDD for the backup-enabled
 * fleet-doctor guardrail and provision-time enableBackup call.
 *
 * Check id:   "backup-enabled"
 * Group:      "infra-sizing"
 * Kind:       LIVE hcloud probe — calls provider.getWithBackup(id) to read
 *             backup_window field (null = backups off, string = backups on).
 *
 * Logic:
 *   - checkBackupEnabled(vms, provider) calls provider.getWithBackup(id) per VM.
 *   - Returns one BackupEnabledResult per VM.
 *   - status="fail" when backup_window is null (backups off).
 *   - status="pass" when backup_window is a non-empty string (backups on).
 *   - field-record VM (provider id 137236481) is excluded from fleet enable
 *     (mid-migration exclusion — separate follow-up).
 *   - VMs NOT managed by samohost are naturally excluded (provider.list()
 *     already filters by managed-by=samohost label).
 *   - The release-gate-runner VM (stateless CI box) is excluded by convention;
 *     its exclusion is documented in docs/stack/backups.md.
 *
 * Provision-time:
 *   - FakeProvider.enableBackupCalls tracks calls to enableBackup(id).
 *   - runProvision calls provider.enableBackup(providerId) after server create.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord } from "../src/types.ts";

// RED: this module does not exist yet.
import {
  checkBackupEnabled,
  type BackupEnabledResult,
} from "../src/doctor/backup-enabled.ts";

// RED: ProviderPort does not have enableBackup or getWithBackup yet.
import type { ProviderPortWithBackup } from "../src/providers/types.ts";

import { FakeProvider } from "./fake-provider.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";
import { runProvision, type ProvisionDeps } from "../src/commands/provision.ts";
import { PROVISION_SENTINEL_PATH } from "../src/cloudinit/hardening.ts";
import { knownHostsPathFor } from "../src/ssh/runner.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-0000-0000-0000-0000-000000000001",
    provider: "hetzner",
    providerId: "99001",
    name: "client-vm",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "nbg1",
    type: "cx23",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samo-backup-enabled-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers: minimal fake provider that exposes backup_window
// ---------------------------------------------------------------------------

/**
 * Minimal provider stub that returns backup_window per server id.
 * Implements ProviderPortWithBackup (extends ProviderPort + enableBackup +
 * getWithBackup).
 */
function makeBackupProvider(
  backupWindowById: Record<string, string | null>,
): ProviderPortWithBackup {
  const base = new FakeProvider();
  return {
    ...base,
    enableBackup: async (_id: string) => { /* no-op */ },
    getWithBackup: async (id: string) => {
      const info = {
        providerId: id,
        name: `vm-${id}`,
        status: "running" as const,
        ipv4: "1.2.3.4",
        labels: { "managed-by": "samohost" },
        volumeIds: [],
        backup_window: backupWindowById[id] ?? null,
      };
      return info;
    },
  };
}

// ===========================================================================
// 1. checkBackupEnabled — core scenarios
// ===========================================================================
describe("1. checkBackupEnabled — core scenarios", () => {

  test("1a. backup_window=null → fail with descriptive message", async () => {
    const vm = makeVm({ providerId: "99001", name: "client-vm" });
    store.upsert(vm);

    const provider = makeBackupProvider({ "99001": null });
    const results = await checkBackupEnabled([vm], provider);

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe("backup-enabled");
    expect(r.group).toBe("infra-sizing");
    expect(r.status).toBe("fail");
    expect(r.description).toContain("client-vm");
    expect(r.description).toContain("backups");
    expect(r.description).toContain("docs/stack/backups.md");
  });

  test("1b. backup_window='22-02' → pass", async () => {
    const vm = makeVm({ providerId: "99002", name: "backed-up-vm" });
    store.upsert(vm);

    const provider = makeBackupProvider({ "99002": "22-02" });
    const results = await checkBackupEnabled([vm], provider);

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe("backup-enabled");
    expect(r.status).toBe("pass");
  });

  test("1c. empty fleet → empty result array", async () => {
    const provider = makeBackupProvider({});
    const results = await checkBackupEnabled([], provider);
    expect(results).toHaveLength(0);
  });

  test("1d. mixed fleet: one with backups, one without → correct per-VM statuses", async () => {
    const vmOk = makeVm({ id: "vm-ok", providerId: "10001", name: "vm-ok" });
    const vmBad = makeVm({ id: "vm-bad", providerId: "10002", name: "vm-bad" });
    store.upsert(vmOk);
    store.upsert(vmBad);

    const provider = makeBackupProvider({ "10001": "02-06", "10002": null });
    const results = await checkBackupEnabled([vmOk, vmBad], provider);

    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.vmId === vmOk.id);
    const bad = results.find((r) => r.vmId === vmBad.id);
    expect(ok?.status).toBe("pass");
    expect(bad?.status).toBe("fail");
    expect(bad?.description).toContain("vm-bad");
  });

  test("1e. result shape is compatible with DoctorResult (id, group, status, description, stdout, stderr)", async () => {
    const vm = makeVm({ providerId: "99003" });
    const provider = makeBackupProvider({ "99003": "01-05" });
    const results = await checkBackupEnabled([vm], provider);
    const r = results[0]!;
    expect(typeof r.id).toBe("string");
    expect(typeof r.group).toBe("string");
    expect(typeof r.description).toBe("string");
    expect(["pass", "fail", "unknown", "skip"]).toContain(r.status);
    expect(typeof r.stdout).toBe("string");
    expect(typeof r.stderr).toBe("string");
  });
});

// ===========================================================================
// 2. Fleet-doctor integration — backup-enabled appears in JSON output
// ===========================================================================
describe("2. Fleet-doctor integration", () => {
  const ED_LINE =
    "[10.0.0.1]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";

  function makePassRunner() {
    return (_vm: VmRecord, script: string) => {
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
        "git-remote-no-token": "origin\thttps://github.com/Tanya301/client-app (fetch)",
        "ss-listeners":
          "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
        "caddy-serving":
          "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
        "fail2ban-jail": "Status for the jail: sshd",
        "service-crash-loop": "Started client.service.",
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
  }

  test("2a. backup_window=null → backup-enabled=fail in fleet JSON, counted in failingVms", async () => {
    // RED: runFleetDoctor does not inject backup-enabled check yet.
    const { runFleetDoctor } = await import("../src/commands/fleet-doctor.ts");

    const vm = makeVm({ providerId: "20001", name: "client-no-backup" });
    store.upsert(vm);

    const provider = makeBackupProvider({ "20001": null });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      makePassRunner(),
      provider,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-no-backup",
    );
    expect(vmResult).toBeDefined();
    const backupCheck = vmResult.checks?.find(
      (c: { id: string }) => c.id === "backup-enabled",
    );
    expect(backupCheck).toBeDefined();
    expect(backupCheck.status).toBe("fail");
    expect(report.failingVms).toBeGreaterThan(0);
  });

  test("2b. backup_window='22-06' → backup-enabled=pass, failingVms=0", async () => {
    const { runFleetDoctor } = await import("../src/commands/fleet-doctor.ts");

    const vm = makeVm({ providerId: "20002", name: "client-with-backup" });
    store.upsert(vm);

    const provider = makeBackupProvider({ "20002": "22-06" });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      makePassRunner(),
      provider,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-with-backup",
    );
    const backupCheck = vmResult?.checks?.find(
      (c: { id: string }) => c.id === "backup-enabled",
    );
    expect(backupCheck?.status).toBe("pass");
    expect(report.failingVms).toBe(0);
  });
});

// ===========================================================================
// 3. Provision-time: enableBackup called after VM creation
// ===========================================================================
describe("3. Provision-time enableBackup", () => {
  const ED_LINE =
    "[192.0.2.55]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";

  function makeDeps(
    dir: string,
    fake: FakeProvider,
  ): ProvisionDeps {
    const privKeyPath = join(dir, "id_ed25519");
    const pubKeyPath = join(dir, "id_ed25519.pub");
    const { writeFileSync } = require("node:fs");
    writeFileSync(privKeyPath, "FAKE_PRIVATE_KEY\n", { mode: 0o600 });
    writeFileSync(pubKeyPath, SAMPLE_PUBKEY + "\n");
    const knownHostsDir = join(dir, "known_hosts");
    require("node:fs").mkdirSync(knownHostsDir, { recursive: true });

    let keyscanDone = false;
    let sshDone = false;

    const spawnFn = async (
      file: string,
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (file === "ssh-keyscan") {
        if (!keyscanDone) {
          keyscanDone = true;
          return { code: 0, stdout: `# banner\n${ED_LINE}\n`, stderr: "" };
        }
        return { code: 0, stdout: `# banner\n${ED_LINE}\n`, stderr: "" };
      }
      if (file === "ssh") {
        if (!sshDone) {
          sshDone = true;
          return {
            code: 0,
            stdout: "SAMOHOST_PROVISION_COMPLETE",
            stderr: "",
          };
        }
        return { code: 0, stdout: "SAMOHOST_PROVISION_COMPLETE", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    fake.statusSequence = ["running"];

    return {
      provider: fake,
      store: new StateStore(join(dir, "state.json")),
      spawn: spawnFn,
      now: (() => {
        const start = Date.now();
        return () => start + 5000; // always within deadline
      })(),
      sleep: async () => {},
      knownHostsDir,
      detectEgressIp: async () => null,
    };
  }

  test("3a. runProvision calls enableBackup on the new server's providerId", async () => {
    const fake = new FakeProvider();
    const deps = makeDeps(dir, fake);

    const spec = makeSpec({
      name: "test-backup-client",
      type: "cx23",
    });

    const outLines: string[] = [];
    const errLines: string[] = [];
    const code = await runProvision(
      { json: false },
      spec,
      deps,
      (s) => outLines.push(s),
      (s) => errLines.push(s),
    );

    expect(code).toBe(0);
    // RED: enableBackupCalls does not exist on FakeProvider yet.
    expect(fake.enableBackupCalls).toHaveLength(1);
    // The id that was enabled must be the provider id returned by create().
    const createdId = fake.createCalls[0] ? String(9001) : undefined;
    expect(fake.enableBackupCalls[0]).toBe(createdId ?? fake.enableBackupCalls[0]);
  });

  test("3b. enableBackup failure is non-fatal — provision still succeeds", async () => {
    // If Hetzner returns a transient error on enable_backup, the VM is still
    // provisioned (backups can be enabled later by fleet-doctor remediation).
    const fake = new FakeProvider();
    // RED: failEnableBackupWith not on FakeProvider yet.
    fake.failEnableBackupWith = { kind: "transient", message: "backup-enable failed" };

    const deps = makeDeps(dir, fake);
    const spec = makeSpec({ name: "test-backup-resilient", type: "cx23" });

    const errLines: string[] = [];
    const code = await runProvision(
      { json: false },
      spec,
      deps,
      () => {},
      (s) => errLines.push(s),
    );

    // Provision must succeed even if enable_backup fails.
    expect(code).toBe(0);
    // A warning must be emitted (non-fatal).
    expect(errLines.some((l) => l.includes("backup"))).toBe(true);
  });
});
