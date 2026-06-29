/**
 * test/doctor.test.ts — Red/Green TDD for `samohost doctor`.
 *
 * Mirrors test/status.test.ts patterns: canned delimited output injected via
 * RemoteRunner, no network, no live VM.
 *
 * E2E / Playwright note: doctor is a headless CLI with no browser surface.
 * A Playwright browser spec is N/A. The E2E requirement is satisfied in the
 * "CLI subprocess e2e" describe block below, which spawns the real CLI binary
 * via Bun.spawn and asserts exit code + stderr (offline, no host needed). This
 * proves the wired binary path end-to-end without a network connection.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runDoctor,
  parseLivenessOutput,
  parseSuspiciousOutput,
  parsePgLocalhostOutput,
  parseWebPortsNotWorldOpenOutput,
} from "../src/commands/doctor.ts";
import { hardeningModule } from "../src/cloudinit/hardening.ts";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import type { VmRecord, AppRecord } from "../src/types.ts";
import type { RemoteRunner } from "../src/commands/status.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rec(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    provider: "hetzner",
    providerId: "99999999",
    name: "test-vm",
    ip: "10.0.0.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function appRec(vmId: string, o: Partial<AppRecord> = {}): AppRecord {
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

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

// Canonical pass bodies for all hardening checks (same as status.test.ts PASS_BODIES).
const CORE_HOST_PASS_BODIES: Record<string, string> = {
  "ssh-port": "port 2223",
  "ufw-active": "Status: active\nDefault: deny (incoming)",
  "fail2ban-active": "active",
  "sysctl-rpfilter": "1",
  "sysctl-syncookies": "1",
  "sysctl-redirects": "0",
  "apparmor-enforced": "12 profiles are in enforce mode.",
};

// Pass bodies for doctor-specific checks — IDs must exactly match buildDoctorChecks() output.
const DOCTOR_PASS_BODIES: Record<string, string> = {
  // new core-host checks
  "permitrootlogin": "permitrootlogin no",
  "passwordauth": "passwordauthentication no",
  "allowusers": "allowusers agent",
  // air-conformance sshd/ufw doctor probes (#64)
  "maxauthtries": "maxauthtries 3",
  "clientalive": "clientaliveinterval 300\nclientalivecountmax 2",
  "x11forwarding": "x11forwarding no",
  "allowagentforwarding": "allowagentforwarding no",
  "permituserenvironment": "permituserenvironment no",
  "permitemptypasswords": "permitemptypasswords no",
  "root-authorized-keys-empty": "0",
  "ufw-limit-ssh": "2223/tcp                   LIMIT       Anywhere",
  "web-ports-not-world-open": "",   // empty = no 80/443 rules = PASS
  "unattended-upgrades-active": "active",
  // only-intended-ports: empty output = no unexpected listeners = pass
  "only-intended-ports": "",
  // app-scoped core-host (placeholder commands — will be skip when no app)
  "env-file-perms": "600 agent",
  "git-remote-no-token": "origin\thttps://github.com/Tanya301/field-record-1 (fetch)",
  // liveness
  "ss-listeners": "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*",
  "fail2ban-jail": "Status for the jail: sshd\n|- Filter\n|  `- Currently failed: 0\n`- Actions\n   `- Total banned: 1",
  // app-scoped liveness (skip when no app)
  "service-crash-loop": "Started field-record.service.",
  // suspicious (never fails; raw journal text — parser counts locally)
  "failed-auth-burst": "Accepted publickey for agent",
  "sudo-failures": "Accepted publickey for agent",
  "fail2ban-ban-spike": "Status for the jail: sshd\n|- Filter\n|  `- Currently failed: 0\n`- Actions\n   `- Total banned: 3",
  // app-db
  "rls-nonsuperuser": "f",
  "pg-localhost": "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
  "app-health": "200",
};

const ALL_PASS_BODIES: Record<string, string> = {
  ...CORE_HOST_PASS_BODIES,
  ...DOCTOR_PASS_BODIES,
};

/**
 * Build delimited output that satisfies ALL doctor checks.
 * Delimiter: <<<SAMOHOST_AUDIT:<id>>> (from AUDIT_DELIM_PREFIX + id + AUDIT_DELIM_SUFFIX).
 */
function allPassDelimited(overrides: Record<string, string> = {}): string {
  const bodies = { ...ALL_PASS_BODIES, ...overrides };
  return Object.entries(bodies)
    .map(([id, body]) => `<<<SAMOHOST_AUDIT:${id}>>>\n${body}`)
    .join("\n");
}

/**
 * Build valid delimited output. The runner intercepts the actual generated script,
 * extracts probe IDs from the embedded echo statements (JSON-quoted delimiters),
 * and returns a response with each check section satisfied.
 */
function makePassRunner(overrides: Record<string, string> = {}): RemoteRunner {
  const bodies = { ...ALL_PASS_BODIES, ...overrides };
  return (_vm, script) => {
    // Extract IDs from the script: buildAuditScript emits echo "<<<SAMOHOST_AUDIT:<id>>>"
    // We match them from the JSON-quoted form in the echo statements.
    const ids: string[] = [];
    const echoRe = /echo\s+"<<<SAMOHOST_AUDIT:([^>]+)>>>"/g;
    let m: RegExpExecArray | null;
    while ((m = echoRe.exec(script)) !== null) {
      ids.push(m[1]!);
    }
    // Fallback: also accept the non-JSON-quoted form.
    if (ids.length === 0) {
      const re2 = /<<<SAMOHOST_AUDIT:([^>]+)>>>/g;
      while ((m = re2.exec(script)) !== null) {
        ids.push(m[1]!);
      }
    }
    // Build output: serve pass bodies for script IDs, fallback to "".
    const sections = ids
      .map((id) => `<<<SAMOHOST_AUDIT:${id}>>>\n${bodies[id] ?? ""}`)
      .join("\n");
    return Promise.resolve({ code: 0, stdout: sections, stderr: "" });
  };
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

let dir: string;
let store: StateStore;
let appStore: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-doctor-"));
  store = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// 1. parseDoctor: target, --infra, --json; missing target throws /requires/;
//    unknown flag throws /unknown/.
// ===========================================================================
describe("1. parseDoctor", () => {
  test("parses target only", () => {
    const cmd = parseArgs(["doctor", "test-vm"]);
    if (cmd.kind !== "doctor") throw new Error("expected doctor");
    expect(cmd.input.target).toBe("test-vm");
    expect(cmd.input.infra).toBe(false);
    expect(cmd.json).toBe(false);
  });

  test("parses --infra and --json", () => {
    const cmd = parseArgs(["doctor", "test-vm", "--infra", "--json"]);
    if (cmd.kind !== "doctor") throw new Error("expected doctor");
    expect(cmd.input.target).toBe("test-vm");
    expect(cmd.input.infra).toBe(true);
    expect(cmd.json).toBe(true);
  });

  test("missing target throws /requires/", () => {
    expect(() => parseArgs(["doctor"])).toThrow(/requires/);
  });

  test("unknown flag throws /unknown/", () => {
    expect(() => parseArgs(["doctor", "vm", "--bogus"])).toThrow(/unknown/);
  });
});

// ===========================================================================
// 2. Single connection: runDoctor with injected RemoteRunner →
//    exactly ONE remote() call, and the script contains every check's probeCommand.
// ===========================================================================
describe("2. Single connection invariant", () => {
  test("exactly ONE remote call for all checks", async () => {
    store.upsert(rec());
    const seen: string[] = [];
    const remote: RemoteRunner = (_vm, cmd) => {
      seen.push(cmd);
      return Promise.resolve({
        code: 0,
        stdout: allPassDelimited(),
        stderr: "",
      });
    };

    const c = capture();
    await runDoctor(
      { target: "test-vm", infra: false },
      { json: false },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );

    // Hard invariant: ONE ssh connection regardless of check count.
    expect(seen.length).toBe(1);

    // The script must contain every hardening probeCommand.
    for (const ch of hardeningModule.auditChecks) {
      expect(seen[0]).toContain(ch.probeCommand);
    }
  });
});

// ===========================================================================
// 3. All-pass canned output → all PASS rows, exit 0.
// ===========================================================================
describe("3. All-pass canned output", () => {
  test("all PASS → exit 0", async () => {
    store.upsert(rec());
    appStore.upsert(appRec("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: false },
      store,
      appStore,
      c.out,
      c.err,
      makePassRunner(),
    );
    expect(code).toBe(0);
    expect(c.o).toContain("PASS");
    expect(c.o).not.toContain("FAIL");
    expect(c.e).toBe("");
  });
});

// ===========================================================================
// 4. A core-host probe mismatch → that row FAIL, exit 1.
// ===========================================================================
describe("4. Core-host probe mismatch → FAIL, exit 1", () => {
  test("sysctl-rpfilter returns 0 → FAIL", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "sysctl-rpfilter": "0" }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "sysctl-rpfilter");
    expect(row.status).toBe("fail");
  });
});

// ===========================================================================
// 5. requiresSudo probe returning permission error → UNKNOWN (not fail), exit 0.
// ===========================================================================
describe("5. requiresSudo → UNKNOWN, exit 0", () => {
  test("permission denied → unknown not fail", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({
          "ufw-active": "ERROR: You need to be root to run this script",
          "apparmor-enforced": "permission denied",
        }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0); // unknown tolerated; only fail exits 1
    const parsed = JSON.parse(c.o);
    const byId = Object.fromEntries(
      parsed.checks.map((r: { id: string; status: string }) => [r.id, r.status]),
    );
    expect(byId["ufw-active"]).toBe("unknown");
    expect(byId["apparmor-enforced"]).toBe("unknown");
  });
});

// ===========================================================================
// 6. Infra mode: with --infra, every app-db (appScoped) check renders SKIP.
// ===========================================================================
describe("6. Infra mode: app-db checks → SKIP", () => {
  test("--infra: all app-scoped checks are skip, exit 0 even if they would fail", async () => {
    store.upsert(rec());
    // Even with an app registered, --infra forces skip on app-db checks
    appStore.upsert(appRec("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        // app-db probes return values that would be "fail" if evaluated
        stdout: allPassDelimited({
          "rls-nonsuperuser": "t", // would be FAIL (superuser)
          "app-health": "500",     // would be FAIL
        }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: true },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0); // app-db skips don't cause exit 1
    const parsed = JSON.parse(c.o);
    expect(parsed.infraMode).toBe(true);
    // All app-scoped checks must be skip
    const appDbChecks = parsed.checks.filter(
      (r: { group: string }) => r.group === "app-db",
    );
    expect(appDbChecks.length).toBeGreaterThan(0);
    for (const row of appDbChecks) {
      expect(row.status).toBe("skip");
    }
  });
});

// ===========================================================================
// 7. Auto-detect: NO app + no :5432 → app-db SKIP; app registered → evaluated;
//    :5432-loopback present (no app) → app-db evaluated.
// ===========================================================================
describe("7. Auto-detect app-db scoping", () => {
  test("no app, no :5432 → app-db checks are skip", async () => {
    store.upsert(rec());
    // No app registered, no :5432 in ss output
    const ssNoPostgres = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*";
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "ss-listeners": ssNoPostgres }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const appDbChecks = parsed.checks.filter(
      (r: { group: string }) => r.group === "app-db",
    );
    for (const row of appDbChecks) {
      expect(row.status).toBe("skip");
    }
  });

  test("app registered → app-db checks evaluated as real pass/fail", async () => {
    store.upsert(rec());
    appStore.upsert(appRec("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    // RLS probe returns 't' (superuser) → should FAIL
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "rls-nonsuperuser": "t" }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(1); // app-db fail → exit 1
    const parsed = JSON.parse(c.o);
    const rlsRow = parsed.checks.find(
      (r: { id: string }) => r.id === "rls-nonsuperuser",
    );
    expect(rlsRow?.status).toBe("fail");
  });

  test(":5432 loopback present, no app registered → app-db checks evaluated", async () => {
    store.upsert(rec());
    // No app but :5432 loopback detected in ss output → evaluate app-db
    const ssWithPostgres =
      "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:5432 0.0.0.0:*";
    // rls-nonsuperuser returns 't' (would be fail), pg-localhost passes
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({
          "ss-listeners": ssWithPostgres,
          "rls-nonsuperuser": "t",
        }),
        stderr: "",
      });
    const c = capture();
    await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    // rls-nonsuperuser should be evaluated (not skip), and would be fail
    const parsed = JSON.parse(c.o);
    const rlsRow = parsed.checks.find(
      (r: { id: string }) => r.id === "rls-nonsuperuser",
    );
    // When no app, rls check can't be fully evaluated (no envFile) → unknown or skip
    // but it should NOT be skip if :5432 detected — it should at least be unknown/fail
    expect(rlsRow?.status).not.toBe("skip");
  });
});

// ===========================================================================
// 8. READ-ONLY: spy AppStore whose upsert/remove throw if called.
//    runDoctor must complete without mutation.
// ===========================================================================
describe("8. Read-only invariant: no state mutation", () => {
  test("runDoctor never calls appStore.upsert or appStore.remove", async () => {
    store.upsert(rec());
    appStore.upsert(appRec("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));

    // Create a spy AppStore that throws if mutating methods are called.
    const spyAppStore = new AppStore(join(dir, "apps.json"));
    const upsertSpy = mock(() => { throw new Error("AppStore.upsert called — doctor must be read-only"); });
    const removeSpy = mock(() => { throw new Error("AppStore.remove called — doctor must be read-only"); });
    spyAppStore.upsert = upsertSpy as unknown as typeof spyAppStore.upsert;
    spyAppStore.remove = removeSpy as unknown as typeof spyAppStore.remove;

    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({ code: 0, stdout: allPassDelimited(), stderr: "" });

    const c = capture();
    // Must NOT throw (upsert/remove not called).
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: false },
      store,
      spyAppStore,
      c.out,
      c.err,
      remote,
    );
    // verify spies were never called
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(code).toBeLessThanOrEqual(1); // 0 or 1, but not an exception
  });
});

// ===========================================================================
// 9. Liveness parser (pure fn): unit "active" but port NOT in ss → fail;
//    port present → pass. Caddy: 80+443 → pass; only 80 → fail.
// ===========================================================================
describe("9. parseLivenessOutput", () => {
  const SS_WITH_SSH = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*";
  const SS_WITH_CADDY = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*";
  const SS_ONLY_80 = "LISTEN 0 128 0.0.0.0:2223 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*";

  test("ssh port present → pass", () => {
    const result = parseLivenessOutput("ssh-port-listening", SS_WITH_SSH, 2223);
    expect(result.status).toBe("pass");
  });

  test("ssh port absent → fail", () => {
    const result = parseLivenessOutput("ssh-port-listening", "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*", 2223);
    expect(result.status).toBe("fail");
  });

  test("caddy 80+443 both listening → pass", () => {
    const result = parseLivenessOutput("caddy-serving", SS_WITH_CADDY, 2223);
    expect(result.status).toBe("pass");
  });

  test("caddy only 80 → fail", () => {
    const result = parseLivenessOutput("caddy-serving", SS_ONLY_80, 2223);
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// 10. Suspicious parser (pure fn): 30 "Failed password" lines → finding;
//     clean text → no finding, status pass.
//     SECRET-REDACTION: token in log → never appears in findings.
// ===========================================================================
describe("10. parseSuspiciousOutput", () => {
  test("30 Failed password lines → finding with count", () => {
    const logText = Array(30).fill("Jun 11 12:00:00 host sshd[1234]: Failed password for invalid user root from 1.2.3.4 port 54321 ssh2").join("\n");
    const result = parseSuspiciousOutput("failed-auth-burst", logText);
    expect(result.status).toBe("pass"); // suspicious → never fail exit-code
    expect(result.findings).toBeDefined();
    expect(result.findings!.length).toBeGreaterThan(0);
    // finding must mention a count
    expect(result.findings![0]).toMatch(/\d+/);
  });

  test("clean text → no findings, status pass", () => {
    const logText = "Jun 11 12:00:00 host sshd[1234]: Accepted publickey for agent";
    const result = parseSuspiciousOutput("failed-auth-burst", logText);
    expect(result.status).toBe("pass");
    expect(!result.findings || result.findings.length === 0).toBe(true);
  });

  test("SECRET-REDACTION: token in log line never appears in findings output", () => {
    const secret = "AKIAabcdefghijklmnopqrstuvwxyz01234567890AAAA"; // 44 chars
    const logText = Array(30).fill(
      `Jun 11 12:00:00 host sshd[1234]: Failed password token=${secret} for root`,
    ).join("\n");
    const result = parseSuspiciousOutput("failed-auth-burst", logText);
    // Secret must NOT appear in any finding
    const allFindings = (result.findings ?? []).join(" ");
    expect(allFindings).not.toContain(secret);
    // Findings must contain only category+count, not raw lines
    expect(allFindings).not.toContain("Failed password token=");
  });
});

// ===========================================================================
// 11. pg-localhost parser: :5432 on 127.0.0.1 → pass; :5432 on 0.0.0.0 → fail.
// ===========================================================================
describe("11. parsePgLocalhostOutput", () => {
  test(":5432 on 127.0.0.1 → pass", () => {
    const ssOutput = "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 128 [::1]:5432 [::]:*";
    const result = parsePgLocalhostOutput(ssOutput);
    expect(result.status).toBe("pass");
  });

  test(":5432 on 0.0.0.0 → fail", () => {
    const ssOutput = "LISTEN 0 128 0.0.0.0:5432 0.0.0.0:*";
    const result = parsePgLocalhostOutput(ssOutput);
    expect(result.status).toBe("fail");
  });

  test(":5432 on loopback only (no external) → pass", () => {
    const ssOutput = "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:80 0.0.0.0:*";
    const result = parsePgLocalhostOutput(ssOutput);
    expect(result.status).toBe("pass");
  });
});

// ===========================================================================
// 12. --json shape: emits checks[] with id/status/group and an infraMode boolean.
// ===========================================================================
describe("12. JSON output shape", () => {
  test("--json emits {record, infraMode, checks:[{id,status,group}]}", async () => {
    store.upsert(rec());
    const c = capture();
    await runDoctor(
      { target: "test-vm", infra: true },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      makePassRunner(),
    );
    const parsed = JSON.parse(c.o);
    expect(parsed).toHaveProperty("record");
    expect(parsed).toHaveProperty("infraMode", true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    for (const chk of parsed.checks) {
      expect(chk).toHaveProperty("id");
      expect(chk).toHaveProperty("status");
      expect(chk).toHaveProperty("group");
    }
  });
});

// ===========================================================================
// 13. air-conformance doctor coverage (#64): the new sshd/ufw directives are
//     probed by doctor AND evaluate to PASS in the all-pass scenario.
// ===========================================================================
describe("13. air-conformance doctor coverage (#64)", () => {
  const AIR_DOCTOR_IDS = [
    "maxauthtries",
    "clientalive",
    "x11forwarding",
    "allowagentforwarding",
    "permituserenvironment",
    "permitemptypasswords",
    "root-authorized-keys-empty",
    "ufw-limit-ssh",
  ];

  test("each new air directive is probed in the single audit script", async () => {
    store.upsert(rec());
    let captured = "";
    const remote: RemoteRunner = (_vm, cmd) => {
      captured = cmd;
      return Promise.resolve({ code: 0, stdout: allPassDelimited(), stderr: "" });
    };
    const c = capture();
    await runDoctor(
      { target: "test-vm", infra: false },
      { json: false },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    for (const id of AIR_DOCTOR_IDS) {
      expect(captured).toContain(`<<<SAMOHOST_AUDIT:${id}>>>`);
    }
  });

  test("all-pass bodies → each new air directive is PASS, exit 0", async () => {
    store.upsert(rec());
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      makePassRunner(),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const byId = Object.fromEntries(
      parsed.checks.map((r: { id: string; status: string }) => [r.id, r.status]),
    );
    for (const id of AIR_DOCTOR_IDS) {
      expect(byId[id], `doctor check ${id} should PASS`).toBe("pass");
    }
  });

  test("a wrong effective value FAILs (e.g. maxauthtries 6) → exit 1", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "maxauthtries": "maxauthtries 6" }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "maxauthtries");
    expect(row.status).toBe("fail");
  });

  test("requiresSudo probe with permission error → UNKNOWN not FAIL", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({
          "maxauthtries": "permission denied",
          "ufw-limit-ssh": "ERROR: You need to be root to run this script",
        }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const byId = Object.fromEntries(
      parsed.checks.map((r: { id: string; status: string }) => [r.id, r.status]),
    );
    expect(byId["maxauthtries"]).toBe("unknown");
    expect(byId["ufw-limit-ssh"]).toBe("unknown");
  });
});

// ===========================================================================
// 14. web-ports-not-world-open check: world-open 80/443 → FAIL; restricted → PASS;
//     absent → PASS; permission error → UNKNOWN.
//     Fixtures are the output of the grep-filtered probeCommand on the remote.
// ===========================================================================
describe("14. web-ports-not-world-open", () => {
  // Section bodies = what `sudo ufw status | grep -E '^(80|443)(/|[[:space:]])'` returns.
  const RED_WORLD_OPEN =
    "80/tcp                     ALLOW       Anywhere\n" +
    "443/tcp (v6)               ALLOW       Anywhere (v6)";
  const RED_RESTRICTED = "80/tcp                     ALLOW       91.99.233.145";

  test("world-open 80 and 443 (v6) → FAIL, exit 1", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "web-ports-not-world-open": RED_WORLD_OPEN }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "web-ports-not-world-open");
    expect(row.status).toBe("fail");
  });

  test("restricted to specific IP → PASS, exit 0", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "web-ports-not-world-open": RED_RESTRICTED }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "web-ports-not-world-open");
    expect(row.status).toBe("pass");
  });

  test("80/443 absent from ufw → PASS, exit 0", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({ "web-ports-not-world-open": "" }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "web-ports-not-world-open");
    expect(row.status).toBe("pass");
  });

  test("permission error → UNKNOWN, exit 0", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = (_vm, _cmd) =>
      Promise.resolve({
        code: 0,
        stdout: allPassDelimited({
          "web-ports-not-world-open": "ERROR: You need to be root to run this script",
        }),
        stderr: "",
      });
    const c = capture();
    const code = await runDoctor(
      { target: "test-vm", infra: false },
      { json: true },
      store,
      appStore,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    const row = parsed.checks.find((r: { id: string }) => r.id === "web-ports-not-world-open");
    expect(row.status).toBe("unknown");
  });

  // Pure-function unit tests for the parser — no runDoctor overhead.
  test("parseWebPortsNotWorldOpenOutput: 0.0.0.0/0 source → fail", () => {
    const result = parseWebPortsNotWorldOpenOutput("80/tcp ALLOW 0.0.0.0/0");
    expect(result.status).toBe("fail");
  });

  test("parseWebPortsNotWorldOpenOutput: ::/0 source → fail", () => {
    const result = parseWebPortsNotWorldOpenOutput("443/tcp (v6) ALLOW ::/0");
    expect(result.status).toBe("fail");
  });

  test("parseWebPortsNotWorldOpenOutput: empty → pass", () => {
    const result = parseWebPortsNotWorldOpenOutput("");
    expect(result.status).toBe("pass");
  });

  // DENY/REJECT action — the rule BLOCKS Anywhere, so the port is NOT world-open.
  test("parseWebPortsNotWorldOpenOutput: DENY from Anywhere → pass (blocks, not open)", () => {
    const result = parseWebPortsNotWorldOpenOutput(
      "80/tcp                     DENY        Anywhere",
    );
    expect(result.status).toBe("pass");
  });

  test("parseWebPortsNotWorldOpenOutput: REJECT from Anywhere (v6) → pass (blocks, not open)", () => {
    const result = parseWebPortsNotWorldOpenOutput(
      "443/tcp                    REJECT      Anywhere (v6)",
    );
    expect(result.status).toBe("pass");
  });

  // LIMIT from Anywhere = rate-limited but still publicly reachable → must still fail.
  test("parseWebPortsNotWorldOpenOutput: LIMIT from Anywhere → fail (rate-limited but still open)", () => {
    const result = parseWebPortsNotWorldOpenOutput(
      "80/tcp                     LIMIT       Anywhere",
    );
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// E2E (CLI subprocess) — satisfies the Playwright/E2E requirement for a CLI.
// No browser involved; this tests the real wired binary path end-to-end.
// ===========================================================================
describe("CLI subprocess e2e", () => {
  test("samohost doctor <nonexistent-vm> exits 1 with 'not found' on stderr", async () => {
    // Playwright browser spec is N/A for a headless CLI (no browser surface).
    // This subprocess test proves the wired binary path end-to-end without a network.
    const proc = Bun.spawn(
      ["bun", "run", "/tmp/samo-doctor-33/src/cli.ts", "doctor", "no-such-vm"],
      {
        env: {
          ...process.env,
          SAMOHOST_STATE: join(dir, "state-empty.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    const stderrText = await new Response(proc.stderr).text();
    expect(proc.exitCode).toBe(1);
    expect(stderrText).toMatch(/not found/i);
  });
});
