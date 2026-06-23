/**
 * test/env-idle-access-log.test.ts — RED-phase tests for:
 *   1. readAccessLogMaxTs() — prod-shaped Caddy JSON access log parser
 *   2. EnvIdleGcDeps — dependency interface with injected readAccessLogMaxTs
 *   3. trigger --idle-gc pass — stamps lastAccess from access log, then reaps
 *
 * Caddy JSON access log format (format json):
 *   Each line is a JSON object. The key field for idle detection is `ts` (Unix
 *   epoch float, seconds.fraction). Real log lines captured from Caddy v2:
 *     {"level":"info","ts":1750694400.123,"logger":"http.log.access.log0",
 *      "msg":"handled request","request":{"remote_ip":"1.2.3.4","remote_port":"55000",
 *      "proto":"HTTP/1.1","method":"GET","host":"field-record-1-feat-idle.samo.cat",
 *      "uri":"/","headers":{"User-Agent":["curl/7.88.1"]},"tls":{}},
 *      "bytes_read":0,"user_id":"","duration":0.002,"size":0,
 *      "status":200,"resp_headers":{}}
 *
 * Tests use deterministic fixtures, never hit the network.
 */

import { describe, expect, test } from "bun:test";
import {
  parseAccessLogMaxTs,
  readAccessLogMaxTs,
  type EnvIdleGcDeps,
} from "../src/commands/env-idle.ts";
import { parseArgs } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// Prod-shaped Caddy JSON access log fixtures
// ---------------------------------------------------------------------------

/** Three real-shaped Caddy log lines; ts values are Unix epoch floats. */
const FIXTURE_THREE_LINES = [
  JSON.stringify({
    level: "info",
    ts: 1750694400.123,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "1.2.3.4",
      remote_port: "55000",
      proto: "HTTP/1.1",
      method: "GET",
      host: "field-record-1-feat-idle.samo.cat",
      uri: "/",
      headers: { "User-Agent": ["curl/7.88.1"] },
      tls: {},
    },
    bytes_read: 0,
    user_id: "",
    duration: 0.002,
    size: 0,
    status: 200,
    resp_headers: {},
  }),
  JSON.stringify({
    level: "info",
    ts: 1750694500.456,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "1.2.3.4",
      remote_port: "55001",
      proto: "HTTP/1.1",
      method: "GET",
      host: "field-record-1-feat-idle.samo.cat",
      uri: "/api/version",
      headers: {},
      tls: {},
    },
    bytes_read: 0,
    user_id: "",
    duration: 0.001,
    size: 128,
    status: 200,
    resp_headers: {},
  }),
  JSON.stringify({
    level: "info",
    ts: 1750694600.789,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "5.6.7.8",
      remote_port: "55002",
      proto: "HTTP/2.0",
      method: "POST",
      host: "field-record-1-feat-idle.samo.cat",
      uri: "/api/login",
      headers: {},
      tls: {},
    },
    bytes_read: 200,
    user_id: "",
    duration: 0.015,
    size: 64,
    status: 200,
    resp_headers: {},
  }),
].join("\n");

/** Single-line log. */
const FIXTURE_SINGLE_LINE = JSON.stringify({
  level: "info",
  ts: 1750694999.0,
  logger: "http.log.access.log0",
  msg: "handled request",
  request: { host: "field-record-1-feat-idle.samo.cat" },
  status: 200,
});

/** Log with a trailing newline (Caddy appends \n per line). */
const FIXTURE_TRAILING_NEWLINE = FIXTURE_THREE_LINES + "\n";

/** Malformed line mixed in with valid lines. */
const FIXTURE_WITH_MALFORMED = [
  JSON.stringify({ level: "info", ts: 1750694400.0, msg: "handled request", request: {} }),
  "not json at all",
  JSON.stringify({ level: "info", ts: 1750694800.0, msg: "handled request", request: {} }),
  '{"broken": json',
].join("\n");

/** Empty log — the env was just created and has no traffic yet. */
const FIXTURE_EMPTY = "";

/** Lines that have no ts field (e.g. Caddy startup log). */
const FIXTURE_NO_TS = [
  JSON.stringify({ level: "info", msg: "serving initial configuration" }),
  JSON.stringify({ level: "info", ts: 1750694400.5, msg: "handled request", request: {} }),
].join("\n");

// ---------------------------------------------------------------------------
// 1. parseAccessLogMaxTs() — pure parser, no SSH
// ---------------------------------------------------------------------------

describe("parseAccessLogMaxTs — prod-shaped Caddy JSON log", () => {
  test("returns max ts (float epoch) from three log lines", () => {
    // The max ts in FIXTURE_THREE_LINES is 1750694600.789
    const result = parseAccessLogMaxTs(FIXTURE_THREE_LINES);
    expect(result).not.toBeNull();
    // Must equal the largest ts value in the fixture
    expect(result).toBe(1750694600.789);
  });

  test("returns the single ts from a one-line log", () => {
    const result = parseAccessLogMaxTs(FIXTURE_SINGLE_LINE);
    expect(result).not.toBeNull();
    expect(result).toBe(1750694999.0);
  });

  test("handles trailing newline (Caddy appends \\n per line)", () => {
    const result = parseAccessLogMaxTs(FIXTURE_TRAILING_NEWLINE);
    expect(result).not.toBeNull();
    expect(result).toBe(1750694600.789);
  });

  test("skips malformed lines and returns max from valid ones", () => {
    // Valid lines have ts 1750694400.0 and 1750694800.0 — max is .800
    const result = parseAccessLogMaxTs(FIXTURE_WITH_MALFORMED);
    expect(result).not.toBeNull();
    expect(result).toBe(1750694800.0);
  });

  test("returns null when the log is empty (no traffic yet)", () => {
    const result = parseAccessLogMaxTs(FIXTURE_EMPTY);
    expect(result).toBeNull();
  });

  test("skips lines without a ts field, returns max from lines that do have one", () => {
    // FIXTURE_NO_TS has one line without ts, one with ts=1750694400.5
    const result = parseAccessLogMaxTs(FIXTURE_NO_TS);
    expect(result).not.toBeNull();
    expect(result).toBe(1750694400.5);
  });

  test("ts values are Unix epoch floats, NOT integers (precision preserved)", () => {
    const line = JSON.stringify({ ts: 1750694600.789, msg: "x", request: {} });
    const result = parseAccessLogMaxTs(line);
    // Must be a float, not truncated to integer
    expect(result).toBe(1750694600.789);
    expect(Number.isInteger(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. readAccessLogMaxTs() — injectable SSH-based reader
// ---------------------------------------------------------------------------

describe("readAccessLogMaxTs — injectable SSH-based reader", () => {
  test("calls readRemoteLog with correct log path and returns max ts as epoch seconds", async () => {
    // readAccessLogMaxTs takes a deps object with readRemoteLog(path) => string
    // and an env name, returns the max ts epoch seconds (float) or null.
    const calls: string[] = [];
    const deps: EnvIdleGcDeps = {
      readRemoteLog: async (logPath: string) => {
        calls.push(logPath);
        return FIXTURE_THREE_LINES;
      },
    };
    const result = await readAccessLogMaxTs("field-record-1-feat-idle", deps);
    // Must have called readRemoteLog with the per-env log path
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/var/log/caddy/field-record-1-feat-idle.log");
    // Must return the max ts
    expect(result).toBe(1750694600.789);
  });

  test("returns null when the remote log is empty", async () => {
    const deps: EnvIdleGcDeps = {
      readRemoteLog: async (_path: string) => FIXTURE_EMPTY,
    };
    const result = await readAccessLogMaxTs("field-record-1-feat-idle", deps);
    expect(result).toBeNull();
  });

  test("returns null when readRemoteLog throws (SSH error, file absent)", async () => {
    const deps: EnvIdleGcDeps = {
      readRemoteLog: async (_path: string) => {
        throw new Error("ssh: connect to host 10.0.0.1 port 2223: Connection refused");
      },
    };
    // Must not throw — return null so the GC pass can fall back to createdAt
    const result = await readAccessLogMaxTs("field-record-1-feat-idle", deps);
    expect(result).toBeNull();
  });

  test("constructs log path as /var/log/caddy/<env-name>.log", async () => {
    const captured: string[] = [];
    const deps: EnvIdleGcDeps = {
      readRemoteLog: async (p: string) => { captured.push(p); return ""; },
    };
    await readAccessLogMaxTs("my-app-feat-branch", deps);
    expect(captured[0]).toBe("/var/log/caddy/my-app-feat-branch.log");
  });
});

// ---------------------------------------------------------------------------
// 3. EnvIdleGcDeps interface shape
// ---------------------------------------------------------------------------

describe("EnvIdleGcDeps interface", () => {
  test("accepts a deps object with readRemoteLog method", () => {
    // TypeScript compile check: if EnvIdleGcDeps doesn't have readRemoteLog, tsc fails.
    const deps: EnvIdleGcDeps = {
      readRemoteLog: async (_path: string) => "",
    };
    expect(typeof deps.readRemoteLog).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 4. trigger --idle-gc CLI flag is parsed
// ---------------------------------------------------------------------------

describe("CLI parser — trigger run --idle-gc", () => {
  test("parseArgs accepts --idle-gc flag for trigger run", () => {
    const cmd = parseArgs(["trigger", "run", "--idle-gc"]);
    expect(cmd.kind).toBe("trigger-run");
    if (cmd.kind === "trigger-run") {
      // The parsed input must have idleGc: true
      expect((cmd.input as { idleGc?: boolean }).idleGc).toBe(true);
    }
  });

  test("parseArgs: trigger run without --idle-gc has idleGc absent or false", () => {
    const cmd = parseArgs(["trigger", "run"]);
    expect(cmd.kind).toBe("trigger-run");
    if (cmd.kind === "trigger-run") {
      const input = cmd.input as { idleGc?: boolean };
      expect(input.idleGc === undefined || input.idleGc === false).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. trigger idle-gc pass stamps lastAccess then reaps
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriggerRun, type TriggerRunInput, type TriggerDeps } from "../src/commands/trigger.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-idle-trigger-1",
    provider: "hetzner",
    providerId: "777",
    name: "samo-we-idle-trigger",
    ip: "10.0.0.2",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "C".repeat(43),
    region: "fsn1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-idle-trigger-1",
    vmId: "vm-idle-trigger-1",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

function makeEnv(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-idle-trigger-abc",
    vmId: "vm-idle-trigger-1",
    appName: "field-record-1",
    branch: "feat/idle-trigger-test",
    name: "field-record-1-feat-idle-trigger-test",
    port: 3201,
    vhost: "field-record-1-feat-idle-trigger-test.samo.cat",
    dbBackend: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function makeTriggerDeps(
  override: Partial<TriggerDeps> = {},
): TriggerDeps {
  return {
    resolveRef: async (_repo: string, _branch: string) => "deadbeef123456",
    deploy: async () => 0,
    fetch: globalThis.fetch,
    now: () => new Date("2026-06-23T12:00:00.000Z"),
    ...override,
  };
}

describe("trigger run --idle-gc pass stamps lastAccess from access log then reaps", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-idle-trigger-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("idle-gc pass reads access log and stamps lastAccess on the EnvRecord", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    // The env has no lastAccess set yet
    const env = makeEnv({ createdAt: "2026-01-01T00:00:00.000Z" });
    envStore.upsert(env);

    // The access log has a recent ts (10 min ago relative to now=12:00)
    const now = new Date("2026-06-23T12:00:00.000Z");
    const accessTs = new Date(now.getTime() - 10 * 60 * 1000).getTime() / 1000; // epoch seconds float
    const logLine = JSON.stringify({
      level: "info",
      ts: accessTs,
      msg: "handled request",
      request: { host: env.vhost },
    });

    let readCalled = 0;
    const deps = makeTriggerDeps({
      now: () => now,
      envStore,
      // The idle-gc dep reads the access log via readAccessLogMaxTs
      idleGc: async (
        _vmId: string,
        _opts: { reap: boolean; envStore: EnvStore; readRemoteLog: EnvIdleGcDeps["readRemoteLog"] },
      ) => {
        readCalled++;
        // Simulate what the real idleGc dep does:
        // 1. For each env, call readAccessLogMaxTs to get max ts
        // 2. Stamp lastAccess from that ts
        // 3. Check if idle > threshold; if so, reap
        const rec = envStore.get(env.vmId, env.appName, env.branch);
        if (rec !== undefined) {
          const tsEpochSec = parseAccessLogMaxTs(logLine);
          if (tsEpochSec !== null) {
            const iso = new Date(tsEpochSec * 1000).toISOString();
            envStore.upsert({ ...rec, lastAccess: iso });
          }
        }
        return { candidates: 0, reaped: 0, pruned: 0 };
      },
    });

    const input: TriggerRunInput = {
      vm: vm.name,
      dryRun: true,
      idleGc: true,
    };

    const c = { o: "", e: "" };
    await runTriggerRun(
      input, { json: false }, vmStore, appStore, deps,
      (s) => { c.o += s + "\n"; },
      (s) => { c.e += s + "\n"; },
    );

    // The idle-gc dep must have been called
    expect(readCalled).toBeGreaterThan(0);

    // lastAccess must now be stamped on the env record
    const updated = envStore.get(env.vmId, env.appName, env.branch);
    expect(updated).toBeDefined();
    expect(updated!.lastAccess).toBeDefined();
    // The stamped time should correspond to accessTs (±1s tolerance for float conversion)
    const stampedMs = new Date(updated!.lastAccess!).getTime();
    const expectedMs = accessTs * 1000;
    expect(Math.abs(stampedMs - expectedMs)).toBeLessThan(1000);
  });

  test("idle-gc pass in warn-only mode (no --idle-reap) does not call destroyEnv", async () => {
    const vm = makeVm();
    vmStore.upsert(vm);
    const app = makeApp();
    appStore.upsert(app);

    const now = new Date("2026-06-23T12:00:00.000Z");
    // env was last accessed 90 min ago → idle
    const lastAccess = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
    const env = makeEnv({ lastAccess });
    envStore.upsert(env);

    let destroyCalled = 0;
    const deps = makeTriggerDeps({
      now: () => now,
      envStore,
      idleGc: async (
        _vmId: string,
        opts: { reap: boolean },
      ) => {
        // warn-only: reap must be false when SAMOHOST_IDLE_REAP is not set
        expect(opts.reap).toBe(false);
        destroyCalled += opts.reap ? 1 : 0;
        return { candidates: 1, reaped: 0, pruned: 0 };
      },
    });

    const input: TriggerRunInput = {
      vm: vm.name,
      dryRun: false,
      idleGc: true,
      // No idleReap flag → warn-only
    };

    const c = { o: "", e: "" };
    await runTriggerRun(
      input, { json: false }, vmStore, appStore, deps,
      (s) => { c.o += s + "\n"; },
      (s) => { c.e += s + "\n"; },
    );

    // destroyEnv must not have been called (warn-only mode)
    expect(destroyCalled).toBe(0);
  });
});

import { afterEach, beforeEach } from "bun:test";
