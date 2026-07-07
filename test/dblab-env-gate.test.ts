/**
 * TDD RED commit: env-create dblab honesty gate (#127).
 *
 * env-create for db=dblab MUST:
 *  1. Fail LOUD when the engine is BLOCKED or UNKNOWN.
 *  2. NEVER write an env record when the preflight fails.
 *  3. Proceed normally when the engine is READY.
 *  4. Skip the gate when dblabPreflight is not injected (back-compat).
 *  5. Skip the gate when db != dblab (template / none).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnvCreate, type EnvExecDeps } from "../src/commands/env.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-gate-test",
    provider: "hetzner",
    providerId: "999",
    name: "samo-we-samograph",
    ip: "1.2.3.4",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: ["dblab"],
    lifecycleState: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...o,
  };
}

function appRec(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-gate",
    vmId: "vm-gate-test",
    name: "samograph",
    repo: "Tanya301/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3100/api/version",
    serviceUnit: "samograph",
    dbBackend: "dblab",
    ...o,
  };
}

/** Phase markers that produce an ok outcome from parseEnvOutcome. */
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [
    `<<<SAMOHOST_PHASE:${p}:start>>>`,
    `<<<SAMOHOST_PHASE:${p}:ok>>>`,
  ])
  .join("\n");

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => { out += s + "\n"; },
    err: (s: string) => { err += s + "\n"; },
    get o() { return out; },
    get e() { return err; },
  };
}

// ---------------------------------------------------------------------------
// Per-test isolated stores
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dblab-gate-"));
  vmStore = new StateStore(join(dir, "vms.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
  vmStore.upsert(vm());
  appStore.upsert(appRec());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to build deps with a controlled preflight result
// ---------------------------------------------------------------------------

function makeDeps(
  preflight: "READY" | "BLOCKED" | "UNKNOWN" | "throw" | undefined,
  remoteOutput = CREATE_OK,
): EnvExecDeps {
  let n = 0;
  return {
    remote: () =>
      Promise.resolve({ code: 0, stdout: remoteOutput, stderr: "" }),
    now: () => new Date("2026-07-01T12:00:00.000Z"),
    uuid: () => `uuid-gate-${++n}`,
    ...(preflight !== undefined
      ? {
          dblabPreflight: preflight === "throw"
            ? () => Promise.reject(new Error("probe connection refused"))
            : () => Promise.resolve(preflight as "READY" | "BLOCKED" | "UNKNOWN"),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Gate: BLOCKED
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — engine BLOCKED", () => {
  test("exits 1 when dblabPreflight returns BLOCKED", async () => {
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("BLOCKED"),
      cap.out, cap.err,
    );
    expect(code).toBe(1);
  });

  test("error message names the engine status and the vm", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("BLOCKED"),
      cap.out, cap.err,
    );
    expect(cap.e).toContain("BLOCKED");
    expect(cap.e).toContain("samo-we-samograph");
  });

  test("does NOT write an env record when engine is BLOCKED", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("BLOCKED"),
      cap.out, cap.err,
    );
    const envs = envStore.listFor("vm-gate-test");
    expect(envs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate: UNKNOWN
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — engine UNKNOWN", () => {
  test("exits 1 when dblabPreflight returns UNKNOWN", async () => {
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("UNKNOWN"),
      cap.out, cap.err,
    );
    expect(code).toBe(1);
  });

  test("error message names the engine status", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("UNKNOWN"),
      cap.out, cap.err,
    );
    expect(cap.e).toContain("UNKNOWN");
  });

  test("does NOT write an env record when engine is UNKNOWN", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("UNKNOWN"),
      cap.out, cap.err,
    );
    const envs = envStore.listFor("vm-gate-test");
    expect(envs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate: preflight throws (connection error)
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — preflight throws", () => {
  test("exits 1 when dblabPreflight throws", async () => {
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("throw"),
      cap.out, cap.err,
    );
    expect(code).toBe(1);
  });

  test("error message includes the exception detail", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("throw"),
      cap.out, cap.err,
    );
    expect(cap.e).toContain("probe connection refused");
  });

  test("does NOT write an env record when preflight throws", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("throw"),
      cap.out, cap.err,
    );
    expect(envStore.listFor("vm-gate-test")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate: READY — proceeds normally
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — engine READY", () => {
  test("exits 0 when dblabPreflight returns READY and create succeeds", async () => {
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("READY"),
      cap.out, cap.err,
    );
    expect(code).toBe(0);
  });

  test("writes the env record when engine is READY and create succeeds", async () => {
    const cap = capture();
    await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("READY"),
      cap.out, cap.err,
    );
    const envs = envStore.listFor("vm-gate-test");
    expect(envs).toHaveLength(1);
    expect(envs[0]!.branch).toBe("feat/x");
    expect(envs[0]!.dbBackend).toBe("dblab");
  });
});

// ---------------------------------------------------------------------------
// Back-compat: no dblabPreflight injected
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — back-compat (no preflight injected)", () => {
  test("proceeds without preflight when dblabPreflight is not in deps", async () => {
    // All existing tests that build { remote, now, uuid } must not be broken.
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps(undefined), // no dblabPreflight field
      cap.out, cap.err,
    );
    expect(code).toBe(0);
    expect(envStore.listFor("vm-gate-test")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Gate not triggered for non-dblab backends
// ---------------------------------------------------------------------------

describe("env-create dblab honesty gate — skipped for non-dblab backends", () => {
  test("db=template does not run the gate even if dblabPreflight is BLOCKED", async () => {
    // The preflight is BLOCKED but db=template, so the gate must be skipped.
    appStore.upsert(appRec({ dbBackend: "template" }));
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/y",
        db: "template", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("BLOCKED"),
      cap.out, cap.err,
    );
    // Should proceed to the create script and succeed
    expect(code).toBe(0);
    expect(envStore.listFor("vm-gate-test")).toHaveLength(1);
  });

  test("db=none does not run the gate", async () => {
    appStore.upsert(appRec({ dbBackend: "none" }));
    const cap = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-samograph", app: "samograph", branch: "feat/z",
        db: "none", previewDomain: "samo.cat" },
      { json: false },
      vmStore, appStore, envStore,
      makeDeps("BLOCKED"),
      cap.out, cap.err,
    );
    expect(code).toBe(0);
  });
});
