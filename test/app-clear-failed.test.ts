/**
 * Issue #2 downstream finding: a rollback — even a FALSE one caused by a probe
 * defect (bug 2) — records the good SHA as failedSha, and the known-bad-SHA
 * guard then refuses every redeploy of that SHA until the state file is
 * hand-edited. Runtime-confirmed: after the false rollback, `app deploy` of
 * the healthy main SHA was refused ("matches this app's recorded failedSha").
 *
 * Operator escape hatches under test:
 *   - `samohost app clear-failed <vm> <app>`  — clears failedSha, confirms.
 *   - `samohost app deploy ... --force`       — bypasses the guard, loudly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  runAppRegister,
  runAppDeploy,
  runAppClearFailed,
  type AppDeployDeps,
} from "../src/commands/app.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

function vm(): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

const SHA = "ce9f73c3c2a937f82dfbe2c58228ece3529e3c08";

const HAPPY = [
  "<<<SAMOHOST_PHASE:fetch:start>>>", "<<<SAMOHOST_PHASE:fetch:ok>>>",
  "<<<SAMOHOST_PHASE:build:start>>>", "<<<SAMOHOST_PHASE:build:ok>>>",
  "<<<SAMOHOST_PHASE:restart:start>>>", "<<<SAMOHOST_PHASE:restart:ok>>>",
  "<<<SAMOHOST_PHASE:health:start>>>", "<<<SAMOHOST_PHASE:health:ok>>>",
].join("\n");

function deployDeps(): AppDeployDeps {
  return {
    remote: () => Promise.resolve({ code: 0, stdout: HAPPY, stderr: "" }),
    resolveRef: () => Promise.resolve(SHA),
    fetch: (async () =>
      ({ ok: true, json: async () => ({ workflow_runs: [{ conclusion: "success" }] }) }) as Response) as unknown as typeof fetch,
    now: () => new Date("2026-06-11T12:00:00.000Z"),
    env: { GH_TOKEN: "tok" },
    controlPlaneRoute: () =>
      Promise.resolve({ code: 0, stdout: "route ready", stderr: "" }),
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs app clear-failed / deploy --force", () => {
  test("app clear-failed <vm> <app> parses", () => {
    const cmd = parseArgs(["app", "clear-failed", "vm-x", "field-record"]);
    if (cmd.kind !== "app-clear-failed") {
      throw new Error(`expected app-clear-failed, got ${cmd.kind}`);
    }
    expect(cmd.input).toEqual({ vm: "vm-x", app: "field-record" });
  });

  test("app clear-failed requires <vm> <app>", () => {
    expect(() => parseArgs(["app", "clear-failed", "vm-x"])).toThrow(/<vm> <app>/);
  });

  test("app deploy parses --force", () => {
    const cmd = parseArgs(["app", "deploy", "vm-x", "fr", "--sha", SHA, "--force"]);
    if (cmd.kind !== "app-deploy") throw new Error("expected app-deploy");
    expect(cmd.input.force).toBe(true);
  });

  test("app deploy without --force leaves force falsy", () => {
    const cmd = parseArgs(["app", "deploy", "vm-x", "fr", "--sha", SHA]);
    if (cmd.kind !== "app-deploy") throw new Error("expected app-deploy");
    expect(cmd.input.force ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commands (offline, temp stores)
// ---------------------------------------------------------------------------

describe("failedSha escape hatches", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-clearfailed-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    vmStore.upsert(vm());
    const c = capture();
    const code = runAppRegister(
      {
        vm: "samo-we-field-record",
        name: "field-record",
        repo: "Tanya301/field-record-1",
        branch: "main",
        appDir: "/opt/field-record/app",
        buildCmd: "npm run build",
        serviceUnit: "field-record",
        healthUrl: "http://localhost:3000/api/version",
        rlsNonSuperuser: false,
      },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedFailedSha(): void {
    appStore.upsert({ ...appStore.get("vm-1111", "field-record")!, failedSha: SHA });
  }

  test("clear-failed empties failedSha and confirms with the cleared SHA", () => {
    seedFailedSha();
    const c = capture();
    const code = runAppClearFailed(
      { vm: "samo-we-field-record", app: "field-record" },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("cleared failedSha");
    expect(c.o).toContain(SHA);
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.failedSha).toBeUndefined();
  });

  test("clear-failed with nothing recorded is a no-op with a clear message", () => {
    const c = capture();
    const code = runAppClearFailed(
      { vm: "samo-we-field-record", app: "field-record" },
      { json: false }, vmStore, appStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("no failedSha");
  });

  test("clear-failed fails cleanly for unknown vm/app", () => {
    const c = capture();
    expect(
      runAppClearFailed(
        { vm: "nope", app: "field-record" },
        { json: false }, vmStore, appStore, c.out, c.err,
      ),
    ).toBe(1);
    expect(c.e).toContain("VM not found");
    const c2 = capture();
    expect(
      runAppClearFailed(
        { vm: "samo-we-field-record", app: "nope" },
        { json: false }, vmStore, appStore, c2.out, c2.err,
      ),
    ).toBe(1);
    expect(c2.e).toContain("app not found");
  });

  test("deploy --force bypasses the known-bad-SHA guard, logging loudly", async () => {
    seedFailedSha();
    const c = capture();
    const code = await runAppDeploy(
      {
        vm: "samo-we-field-record", app: "field-record",
        sha: SHA, skipCiGate: false, force: true,
      },
      { json: true }, vmStore, appStore, deployDeps(), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(JSON.parse(c.o).outcome).toBe("deployed");
    // Loud bypass notice naming the guard.
    expect(c.e).toMatch(/--force/);
    expect(c.e).toMatch(/known-bad/);
    // The successful deploy supersedes the stale guard.
    const rec = appStore.get("vm-1111", "field-record");
    expect(rec?.deployedSha).toBe(SHA);
    expect(rec?.failedSha).toBeUndefined();
  });

  test("deploy without --force is still refused on a recorded failedSha", async () => {
    seedFailedSha();
    const c = capture();
    const code = await runAppDeploy(
      {
        vm: "samo-we-field-record", app: "field-record",
        sha: SHA, skipCiGate: false,
      },
      { json: false }, vmStore, appStore, deployDeps(), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("known-bad");
    // The refusal must point the operator at both escape hatches.
    expect(c.e).toContain("clear-failed");
    expect(c.e).toContain("--force");
  });
});
