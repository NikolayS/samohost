/**
 * test/fleet-doctor-cli-wiring.test.ts — RED TDD for CLI wiring of
 * backup-enabled provider in the `samohost doctor --all` path.
 *
 * BLOCKING ISSUE (samorev PR #178): cli.ts calls runFleetDoctor with 5 args,
 * omitting the optional `provider` arg. The backup-enabled guardrail only runs
 * when `provider !== undefined` in fleet-doctor.ts. So `samohost fleet-doctor`
 * in production NEVER surfaces VMs with backups off.
 *
 * RED against current code:
 *   - `defaultFleetDoctorProvider` is not exported from cli.ts → import fails.
 *   - Even if it were, the cli.ts doctor branch does not pass it to
 *     runFleetDoctor, so backup-enabled would be absent from fleet output.
 *
 * GREEN after fix:
 *   - cli.ts exports `defaultFleetDoctorProvider()` that returns a
 *     `ProviderPortWithBackup` (a HetznerProvider with globalThis.fetch).
 *   - The doctor --all branch in cli.ts constructs the provider and passes it
 *     as the 7th argument to runFleetDoctor.
 *   - runFleetDoctor with a VM + provider now includes backup-enabled in checks[].
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

// RED: defaultFleetDoctorProvider is not exported from cli.ts yet.
// This import line will cause a TypeScript/runtime error until the fix lands.
import { defaultFleetDoctorProvider } from "../src/cli.ts";

import { runFleetDoctor } from "../src/commands/fleet-doctor.ts";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord } from "../src/types.ts";
import type {
  ProviderPortWithBackup,
  ServerInfoWithBackup,
} from "../src/providers/types.ts";
import type { RemoteRunner } from "../src/commands/status.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-wiring-0001-0000-0000-000000000001",
    provider: "hetzner",
    providerId: "55001",
    name: "client-vm-wiring",
    ip: "10.0.0.99",
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

/** Minimal pass runner for the SSH audit phase so backup check is reached. */
function passRunner(): RemoteRunner {
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
      "git-remote-no-token":
        "origin\thttps://github.com/Tanya301/wiring-test (fetch)",
      "ss-listeners":
        "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
      "fail2ban-jail": "Status for the jail: sshd",
      "service-crash-loop": "Started wiring.service.",
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

/**
 * Minimal ProviderPortWithBackup stub that returns backup_window per id.
 * Used to prove that when a provider IS passed, the backup-enabled check runs.
 */
function makeStubProvider(
  backupWindowById: Record<string, string | null>,
): ProviderPortWithBackup {
  return {
    async create() {
      throw new Error("not implemented in stub");
    },
    async get() {
      throw new Error("not implemented in stub");
    },
    async list() {
      return [];
    },
    async destroy() {
      throw new Error("not implemented in stub");
    },
    async listVolumes() {
      return [];
    },
    normalizeError(e: unknown) {
      return { kind: "unknown" as const, message: String(e) };
    },
    async enableBackup(_id: string) {
      // no-op
    },
    async getWithBackup(id: string): Promise<ServerInfoWithBackup> {
      const window = backupWindowById[id] ?? null;
      return {
        providerId: id,
        name: `vm-${id}`,
        status: "running",
        ipv4: "10.0.0.99",
        labels: { "managed-by": "samohost" },
        volumeIds: [],
        backup_window: window,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samo-fleet-wiring-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// W1. defaultFleetDoctorProvider export — proves CLI constructs the provider
// ===========================================================================
describe("W1. defaultFleetDoctorProvider export", () => {
  test("W1a — defaultFleetDoctorProvider() is exported from cli.ts", () => {
    // RED: this export does not exist yet; the import above will fail at load time
    // if the export is missing. The test itself just proves the value is usable.
    expect(typeof defaultFleetDoctorProvider).toBe("function");
  });

  test("W1b — defaultFleetDoctorProvider() returns a ProviderPortWithBackup", () => {
    // RED: no export yet. After fix, this proves HetznerProvider is constructed.
    const provider = defaultFleetDoctorProvider();
    // Duck-type check: ProviderPortWithBackup requires getWithBackup
    expect(typeof provider.getWithBackup).toBe("function");
    // Also verify the full ProviderPort surface
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.get).toBe("function");
    expect(typeof provider.list).toBe("function");
    expect(typeof provider.destroy).toBe("function");
    expect(typeof provider.normalizeError).toBe("function");
    expect(typeof provider.enableBackup).toBe("function");
  });
});

// ===========================================================================
// W2. runFleetDoctor with provider — backup-enabled check runs and appears
// ===========================================================================
describe("W2. runFleetDoctor with provider — backup-enabled in check set", () => {
  test("W2a — with provider + backups OFF → backup-enabled=fail in JSON output", async () => {
    const vm = makeVm({ providerId: "55001" });
    store.upsert(vm);

    // backup_window=null → backups off
    const provider = makeStubProvider({ "55001": null });

    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
      provider,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-vm-wiring",
    );
    expect(vmResult).toBeDefined();

    const checks: Array<{ id: string; status: string }> = vmResult.checks ?? [];
    const backupCheck = checks.find((c) => c.id === "backup-enabled");

    // W2a assertion: backup-enabled MUST appear when provider is passed.
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.status).toBe("fail");

    // The failing VM is counted in failingVms.
    expect(report.failingVms).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  test("W2b — with provider + backups ON → backup-enabled=pass", async () => {
    const vm = makeVm({ providerId: "55002", name: "client-vm-backed-up" });
    store.upsert(vm);

    const provider = makeStubProvider({ "55002": "22-06" });

    let outStr = "";
    const code = await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
      provider,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-vm-backed-up",
    );
    expect(vmResult).toBeDefined();

    const checks: Array<{ id: string; status: string }> = vmResult.checks ?? [];
    const backupCheck = checks.find((c) => c.id === "backup-enabled");

    expect(backupCheck).toBeDefined();
    expect(backupCheck!.status).toBe("pass");
    expect(report.failingVms).toBe(0);
    expect(code).toBe(0);
  });

  test("W2c — WITHOUT provider → backup-enabled check absent from results", async () => {
    // This documents the current (broken) CLI behavior: no provider → no backup check.
    // After the fix, the CLI passes a provider, so this scenario only applies to
    // callers that deliberately omit the provider (e.g. legacy unit tests).
    const vm = makeVm({ providerId: "55003", name: "client-vm-no-provider" });
    store.upsert(vm);

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      passRunner(),
      // provider intentionally omitted
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-vm-no-provider",
    );
    expect(vmResult).toBeDefined();

    const checks: Array<{ id: string; status: string }> = vmResult.checks ?? [];
    const backupCheck = checks.find((c) => c.id === "backup-enabled");

    // Without a provider, backup-enabled should NOT appear (by design — skipped).
    expect(backupCheck).toBeUndefined();
  });
});

// ===========================================================================
// W3. Prove CLI wiring: defaultFleetDoctorProvider + runFleetDoctor produce
//     backup-enabled results — equivalent to what the fixed CLI branch does.
// ===========================================================================
describe("W3. CLI wiring end-to-end via defaultFleetDoctorProvider", () => {
  test("W3a — defaultFleetDoctorProvider() returns provider that runFleetDoctor accepts", async () => {
    // RED: defaultFleetDoctorProvider not exported yet.
    // This test proves the CLI wiring by composing the exact same objects the
    // fixed cli.ts doctor branch will compose, and verifying the outcome.

    const vm = makeVm({ providerId: "55004", name: "client-vm-cli-equiv" });
    store.upsert(vm);

    // Get the CLI-default provider. In tests, HCLOUD_TOKEN is absent so any
    // live call will fail — but checkBackupEnabled catches errors and emits
    // status:'fail', so backup-enabled WILL appear in results.
    const provider = defaultFleetDoctorProvider();

    let outStr = "";
    let errStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      (s) => { errStr += s; },
      passRunner(),
      provider,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find(
      (v: { vmName: string }) => v.vmName === "client-vm-cli-equiv",
    );
    expect(vmResult).toBeDefined();

    const checks: Array<{ id: string; status: string }> = vmResult.checks ?? [];
    const backupCheck = checks.find((c) => c.id === "backup-enabled");

    // The backup-enabled check MUST appear — regardless of pass/fail status.
    // (It will be status='fail' because HCLOUD_TOKEN is absent in CI, causing
    //  getWithBackup to throw — checkBackupEnabled safely catches this and emits fail.)
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.id).toBe("backup-enabled");
  });
});
