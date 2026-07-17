/**
 * test/doctor-drift-checks.test.ts — RED→GREEN TDD for two new doctor checks:
 *
 *   1. static-with-DB drift (offline, record-based):
 *      src/doctor/static-db-drift.ts checkStaticDbDrift()
 *      Fires when kind=static AND any DB field is set (same predicate as P1's
 *      validateStaticNoDb, but as DETECTION for already-registered apps rather
 *      than a gate at registration time).
 *
 *   2. dark-DB probe (on-VM, via existing SSH batch):
 *      Extends appDbCheckTemplates in checks.ts (id="dark-db") +
 *      parseDarkDbOutput() parser in doctor.ts.
 *      Fires when pg_database / pg_roles shows an app DB/role NOT declared by
 *      the AppRecord (dbBackend absent/"none" yet a non-system DB exists).
 *      Fail-safe on probe error → status "unknown".
 *
 * RED: both checkStaticDbDrift (check 1) and parseDarkDbOutput (check 2) do NOT
 * exist yet. All tests below are expected to fail until the implementation lands.
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

// RED: checkStaticDbDrift does not exist yet.
import { checkStaticDbDrift } from "../src/doctor/static-db-drift.ts";

// RED: parseDarkDbOutput does not exist yet.
import {
  parseDarkDbOutput,
  auditVm,
} from "../src/commands/doctor.ts";

import { runFleetDoctor } from "../src/commands/fleet-doctor.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-0000-0000-0000-0000-000000000001",
    provider: "hetzner",
    providerId: "12345",
    name: "test-vm",
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

function makeApp(vmId: string, overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    vmId,
    name: "gamechangers",
    repo: "Tanya301/gamechangers",
    branch: "main",
    appDir: "/opt/gamechangers/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "gamechangers",
    envFile: "/opt/gamechangers/.env",
    ...overrides,
  };
}

/** Minimal pass runner for auditVm/fleet-doctor SSH probe tests. */
function makePassRunner(overrides: Record<string, string> = {}): RemoteRunner {
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
      "git-remote-no-token": "origin\thttps://github.com/Tanya301/gamechangers (fetch)",
      "ss-listeners": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
      "caddy-serving": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
      "fail2ban-jail": "Status for the jail: sshd",
      "service-crash-loop": "Started gamechangers.service.",
      "failed-auth-burst": "Accepted publickey",
      "sudo-failures": "Accepted publickey",
      "fail2ban-ban-spike": "Total banned: 3",
      "rls-nonsuperuser": "f",
      "pg-localhost": "",
      "app-health": "200",
      // dark-db probe: no app databases, only system DBs/roles
      "dark-db": "postgres\ntemplate0\ntemplate1",
      ...overrides,
    };
    const stdout = ids
      .map((id) => `<<<SAMOHOST_AUDIT:${id}>>>\n${bodies[id] ?? ""}`)
      .join("\n");
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
}

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samo-drift-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// CHECK 1: static-with-DB drift (offline, record-based)
// ===========================================================================

describe("1. checkStaticDbDrift — static-with-DB drift detection", () => {

  // ---- fires cases ----

  test("1a. kind=static + migrateCmd set → FINDING emitted", () => {
    const vm = makeVm();
    const app = makeApp(vm.id, {
      kind: "static",
      migrateCmd: "bun run db:migrate",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.id).toBe("static-db-drift");
    expect(r.group).toBe("infra-sizing");
    expect(r.status).toBe("fail");
    // Must name the app
    expect(r.description).toContain("gamechangers");
    // Must mention the offending field
    expect(r.description).toContain("migrateCmd");
    // Must recommend re-registering as kind=node
    expect(r.description).toMatch(/kind=node/i);
  });

  test("1b. kind=static + dbBackend=dblab → FINDING emitted", () => {
    const vm = makeVm();
    const app = makeApp(vm.id, {
      kind: "static",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.status).toBe("fail");
    expect(r.description).toContain("dbBackend");
    expect(r.description).toContain("gamechangers");
  });

  test("1c. kind=static + previewDbBackend=template → FINDING emitted", () => {
    const app = makeApp("vm1", {
      kind: "static",
      previewDbBackend: "template",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.description).toContain("previewDbBackend");
  });

  test("1d. kind=static + databaseUrlEnv set → FINDING emitted", () => {
    const app = makeApp("vm1", {
      kind: "static",
      databaseUrlEnv: "DATABASE_URL",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.description).toContain("databaseUrlEnv");
  });

  test("1e. kind=static + envDbVars non-empty → FINDING emitted", () => {
    const app = makeApp("vm1", {
      kind: "static",
      envDbVars: ["DATABASE_URL", "REPLICA_URL"],
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.description).toContain("envDbVars");
  });

  test("1f. kind=static + multiple DB fields → all fields named in finding", () => {
    const app = makeApp("vm1", {
      kind: "static",
      migrateCmd: "bun run migrate",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("fail");
    const desc = results[0]!.description;
    expect(desc).toContain("migrateCmd");
    expect(desc).toContain("dbBackend");
    expect(desc).toContain("databaseUrlEnv");
  });

  // ---- does-not-fire cases ----

  test("1g. kind=static + NO DB fields → no finding (clean static app)", () => {
    const app = makeApp("vm1", {
      kind: "static",
      // No DB fields
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(0);
  });

  test("1h. kind=static + dbBackend=none → no finding (explicit no-DB)", () => {
    // dbBackend=none and previewDbBackend=none are valid for static apps
    const app = makeApp("vm1", {
      kind: "static",
      dbBackend: "none",
      previewDbBackend: "none",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(0);
  });

  test("1i. kind=node + DB fields → no finding (node+DB is the correct shape)", () => {
    const app = makeApp("vm1", {
      kind: "node",
      migrateCmd: "bun run migrate",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(0);
  });

  test("1j. kind absent (default node) + DB fields → no finding", () => {
    const app = makeApp("vm1", {
      // kind absent → treated as node
      migrateCmd: "bun run migrate",
      dbBackend: "dblab",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(0);
  });

  test("1k. empty fleet → no findings", () => {
    const results = checkStaticDbDrift([]);
    expect(results.length).toBe(0);
  });

  test("1l. fleet with one clean static + one drifted static → only one finding", () => {
    const clean = makeApp("vm1", { kind: "static", name: "clean-static" });
    const drifted = makeApp("vm2", {
      kind: "static",
      name: "drifted-static",
      migrateCmd: "bun run migrate",
    });
    const results = checkStaticDbDrift([clean, drifted]);

    expect(results.length).toBe(1);
    expect(results[0]!.description).toContain("drifted-static");
    expect(results[0]!.description).not.toContain("clean-static");
  });

  test("1m. result shape is compatible with DoctorResult (required fields)", () => {
    const app = makeApp("vm1", {
      kind: "static",
      migrateCmd: "bun run migrate",
    });
    const results = checkStaticDbDrift([app]);

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(typeof r.id).toBe("string");
    expect(typeof r.description).toBe("string");
    expect(typeof r.group).toBe("string");
    expect(["pass", "fail", "unknown", "skip"]).toContain(r.status);
    expect(typeof r.stdout).toBe("string");
    expect(typeof r.stderr).toBe("string");
  });
});

// ===========================================================================
// CHECK 2: dark-DB probe (on-VM, via SSH batch)
// ===========================================================================

describe("2. parseDarkDbOutput — dark (undeclared) database detection", () => {

  // ---- fires cases ----

  test("2a. dbBackend absent + real app DB on VM → FAIL (dark DB detected)", () => {
    // AppRecord declares no DB (dbBackend absent), but the VM probe finds
    // "myapp" database (non-system).
    const result = parseDarkDbOutput(
      // probe output: pg_database names + pg_roles names (line-delimited)
      "postgres\ntemplate0\ntemplate1\nmyapp",
      undefined, // dbBackend not declared
      undefined, // databaseUrlEnv not declared
    );

    expect(result.status).toBe("fail");
    expect(result.stdout).toContain("myapp");
    // Must mention the undeclared DB
    expect(result.description ?? result.stdout).toMatch(/myapp|undeclared|dark/i);
  });

  test("2b. dbBackend=none + real app DB on VM → FAIL (dark DB detected)", () => {
    const result = parseDarkDbOutput(
      "postgres\ntemplate0\ntemplate1\ngamechangers_prod",
      "none",
      undefined,
    );

    expect(result.status).toBe("fail");
    expect(result.stdout).toContain("gamechangers_prod");
  });

  test("2c. dbBackend absent + real app role on VM → FAIL", () => {
    // Probe lists both pg_database and pg_roles; an app role named "gamechangers_user"
    // that is NOT a system role signals a hand-installed DB.
    const result = parseDarkDbOutput(
      // Format: DB section then ROLES section, or combined — impl determines
      "DATABASES:postgres\ntemplate0\ntemplate1\nROLES:postgres\npg_monitor\npg_read_all_settings\ngamechangers_user",
      undefined,
      undefined,
    );

    expect(result.status).toBe("fail");
  });

  // ---- does-not-fire cases ----

  test("2d. dbBackend=dblab declared → PASS even when DB exists (DB is declared)", () => {
    // When the AppRecord declares dbBackend=dblab, the DB presence is expected
    // and should not trigger the dark-DB finding.
    const result = parseDarkDbOutput(
      "postgres\ntemplate0\ntemplate1\ngamechangers_prod",
      "dblab",
      "DATABASE_URL",
    );

    expect(result.status).toBe("pass");
  });

  test("2e. dbBackend=template declared → PASS (DB is declared)", () => {
    const result = parseDarkDbOutput(
      "postgres\ntemplate0\ntemplate1\ngamechangers",
      "template",
      "DATABASE_URL",
    );

    expect(result.status).toBe("pass");
  });

  test("2f. only system DBs present + dbBackend absent → PASS (no dark DB)", () => {
    // Only postgres / template0 / template1 — all system DBs, nothing to flag.
    const result = parseDarkDbOutput(
      "postgres\ntemplate0\ntemplate1",
      undefined,
      undefined,
    );

    expect(result.status).toBe("pass");
  });

  test("2g. only system roles + dbBackend absent → PASS", () => {
    const result = parseDarkDbOutput(
      "DATABASES:postgres\ntemplate0\ntemplate1\nROLES:postgres\npg_monitor\npg_read_all_settings\npg_read_all_stats\npg_stat_scan_tables\npg_read_server_files\npg_write_server_files\npg_execute_server_program\npg_signal_backend\npg_checkpoint",
      undefined,
      undefined,
    );

    expect(result.status).toBe("pass");
  });

  // ---- fail-safe on probe error ----

  test("2h. probe error (empty output) → unknown (fail-safe, sweep continues)", () => {
    // Empty output means the probe failed or pg_database query couldn't run.
    const result = parseDarkDbOutput("", undefined, undefined);

    expect(result.status).toBe("unknown");
  });

  test("2i. probe error (permission denied output) → unknown", () => {
    const result = parseDarkDbOutput(
      "could not connect to server: Connection refused",
      undefined,
      undefined,
    );

    // Probe error = unknown (fail-safe: we cannot determine DB state)
    expect(result.status).toBe("unknown");
  });

  test("2j. result has required DoctorResult fields", () => {
    const result = parseDarkDbOutput(
      "postgres\ntemplate0\ntemplate1",
      undefined,
      undefined,
    );

    expect(typeof result.status).toBe("string");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });
});

// ===========================================================================
// CHECK 2 INTEGRATION: dark-DB probe wired into auditVm / fleet-doctor
// ===========================================================================

describe("3. dark-DB probe integration into auditVm and fleet-doctor", () => {

  test("3a. auditVm with dark-DB probe in SSH output → dark-db check appears in results", async () => {
    const vm = makeVm();
    // App with no declared DB (dbBackend absent)
    const app = makeApp(vm.id, { kind: "node" });

    // Runner returns a clean dark-db probe (only system DBs)
    const runner = makePassRunner({ "dark-db": "postgres\ntemplate0\ntemplate1" });

    const results = await auditVm(vm, app, runner);

    const darkDbResult = results.find((r) => r.id === "dark-db");
    expect(darkDbResult).toBeDefined();
    // Only system DBs → should be pass (no dark DB)
    expect(darkDbResult!.status).toBe("pass");
  });

  test("3b. auditVm with undeclared app DB in probe output → dark-db fails", async () => {
    const vm = makeVm();
    // App with no declared DB (dbBackend absent/none)
    const app = makeApp(vm.id, { kind: "node", dbBackend: "none" });

    // Runner returns probe output with an undeclared application database
    const runner = makePassRunner({
      "dark-db": "postgres\ntemplate0\ntemplate1\ngamechangers_prod",
    });

    const results = await auditVm(vm, app, runner);

    const darkDbResult = results.find((r) => r.id === "dark-db");
    expect(darkDbResult).toBeDefined();
    expect(darkDbResult!.status).toBe("fail");
  });

  test("3c. auditVm with declared dbBackend=dblab + DB in probe → dark-db passes (DB is declared)", async () => {
    const vm = makeVm();
    const app = makeApp(vm.id, {
      kind: "node",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });

    const runner = makePassRunner({
      "dark-db": "postgres\ntemplate0\ntemplate1\ngamechangers",
    });

    const results = await auditVm(vm, app, runner);

    const darkDbResult = results.find((r) => r.id === "dark-db");
    expect(darkDbResult).toBeDefined();
    expect(darkDbResult!.status).toBe("pass");
  });

  test("3d. auditVm: dark-db probe error → unknown (fail-safe, does not crash sweep)", async () => {
    const vm = makeVm();
    const app = makeApp(vm.id, { kind: "node" });

    // Runner returns error output for dark-db probe
    const runner = makePassRunner({
      "dark-db": "could not connect to server: Connection refused",
    });

    // Should not throw
    const results = await auditVm(vm, app, runner);

    const darkDbResult = results.find((r) => r.id === "dark-db");
    expect(darkDbResult).toBeDefined();
    expect(darkDbResult!.status).toBe("unknown");
  });

  test("3e. dark-db probe is part of the SAME single-SSH batch (not a separate connection)", async () => {
    const vm = makeVm();
    const app = makeApp(vm.id, { kind: "node" });

    let callCount = 0;
    const countingRunner: RemoteRunner = (_vm, script) => {
      callCount++;
      // Check the dark-db probe is present in the batched script
      expect(script).toContain("dark-db");
      // Return minimal output
      const ids: string[] = [];
      const re = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(script)) !== null) ids.push(m[1]!);
      const stdout = ids.map((id) => `<<<SAMOHOST_AUDIT:${id}>>>\npostgres\ntemplate0\ntemplate1`).join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };

    await auditVm(vm, app, countingRunner);

    // MUST be exactly ONE SSH call (single-connection invariant)
    expect(callCount).toBe(1);
  });

  test("3f. fleet-doctor JSON includes dark-db check result per VM", async () => {
    const vm = makeVm({ name: "gamechangers-vm" });
    const app = makeApp(vm.id, { kind: "node", dbBackend: "none" });
    store.upsert(vm);
    appStore.upsert(app);

    // Dark DB present in probe output
    const runner = makePassRunner({
      "dark-db": "postgres\ntemplate0\ntemplate1\ngamechangers_prod",
    });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      runner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "gamechangers-vm");
    expect(vmResult).toBeDefined();
    const darkDbCheck = vmResult.checks?.find((c: { id: string }) => c.id === "dark-db");
    expect(darkDbCheck).toBeDefined();
    expect(darkDbCheck.status).toBe("fail");
    // failing VM must be counted in failingVms
    expect(report.failingVms).toBeGreaterThan(0);
  });

  test("3g. fleet-doctor: no dark DB → dark-db=pass, not counted in failingVms", async () => {
    const vm = makeVm({ name: "clean-vm" });
    const app = makeApp(vm.id, { kind: "node" });
    store.upsert(vm);
    appStore.upsert(app);

    const runner = makePassRunner({
      "dark-db": "postgres\ntemplate0\ntemplate1",
    });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      runner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "clean-vm");
    expect(vmResult).toBeDefined();
    const darkDbCheck = vmResult.checks?.find((c: { id: string }) => c.id === "dark-db");
    expect(darkDbCheck).toBeDefined();
    expect(darkDbCheck.status).toBe("pass");
    expect(report.failingVms).toBe(0);
  });
});

// ===========================================================================
// CHECK 1 INTEGRATION: static-with-DB drift in fleet-doctor
// ===========================================================================

describe("4. static-with-DB drift integration in fleet-doctor", () => {

  test("4a. fleet-doctor JSON includes static-db-drift per-VM finding for drifted static app", async () => {
    const vm = makeVm({ name: "gamechangers-vm" });
    // kind=static with a migrateCmd — the gamechangers scenario
    const app = makeApp(vm.id, {
      kind: "static",
      migrateCmd: "bun run db:migrate",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });
    store.upsert(vm);
    appStore.upsert(app);

    const runner = makePassRunner({ "dark-db": "postgres\ntemplate0\ntemplate1" });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      runner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "gamechangers-vm");
    expect(vmResult).toBeDefined();

    // static-db-drift check must appear in per-VM checks
    const driftCheck = vmResult.checks?.find((c: { id: string }) => c.id === "static-db-drift");
    expect(driftCheck).toBeDefined();
    expect(driftCheck.status).toBe("fail");

    // Must be counted in failingVms
    expect(report.failingVms).toBeGreaterThan(0);
  });

  test("4b. fleet-doctor: clean static app → static-db-drift=pass, not counted in failingVms", async () => {
    const vm = makeVm({ name: "clean-static-vm" });
    const app = makeApp(vm.id, { kind: "static" }); // no DB fields
    store.upsert(vm);
    appStore.upsert(app);

    const runner = makePassRunner({ "dark-db": "postgres\ntemplate0\ntemplate1" });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      runner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "clean-static-vm");
    expect(vmResult).toBeDefined();

    const driftCheck = vmResult.checks?.find((c: { id: string }) => c.id === "static-db-drift");
    expect(driftCheck).toBeDefined();
    expect(driftCheck.status).toBe("pass");
    expect(report.failingVms).toBe(0);
  });

  test("4c. fleet-doctor: node+DB app → static-db-drift=pass (node+DB is correct)", async () => {
    const vm = makeVm({ name: "node-db-vm" });
    const app = makeApp(vm.id, {
      kind: "node",
      migrateCmd: "bun run migrate",
      dbBackend: "dblab",
      databaseUrlEnv: "DATABASE_URL",
    });
    store.upsert(vm);
    appStore.upsert(app);

    const runner = makePassRunner({
      "dark-db": "postgres\ntemplate0\ntemplate1\ngamechangers",
      "rls-nonsuperuser": "f",
      "pg-localhost": "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
    });

    let outStr = "";
    await runFleetDoctor(
      { json: true },
      store,
      appStore,
      (s) => { outStr += s; },
      () => {},
      runner,
    );

    const report = JSON.parse(outStr);
    const vmResult = report.vms.find((v: { vmName: string }) => v.vmName === "node-db-vm");
    expect(vmResult).toBeDefined();

    const driftCheck = vmResult.checks?.find((c: { id: string }) => c.id === "static-db-drift");
    expect(driftCheck).toBeDefined();
    expect(driftCheck.status).toBe("pass");
  });
});
