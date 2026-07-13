/**
 * RED tests for samorev PR #134 parity gaps (five issues).
 *
 * 1. BATCH_TIMEOUT: batch SSH timeout must scale with N items, not fixed 120s.
 * 2. DNS_RETRY: ensurePreviewDns must re-fire for envs lacking lastDeployedSha.
 * 3. PORT_GUARD: Phase-1 port probe must cause fail-closed on squatted port.
 * 4. PREREQ_CONSISTENT: no silent wildcard-degrade when CF token missing.
 * 5a. REPORTING_DERIVETARGET: deriveTarget failure → failed result in summary.
 * 5b. REPORTING_PRLIST: prList failure → distinguishable from zero-open-PRs.
 *
 * Every test in this file MUST FAIL on the current branch (RED) and MUST PASS
 * after the implementation fix (GREEN).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEAL_PROBE_CLONE_BEGIN,
  HEAL_PROBE_CLONE_END,
  HEAL_PROBE_PORTS_BEGIN,
  HEAL_PROBE_PORTS_END,
} from "../src/preview/heal-deps.ts";
import { defaultTriggerDeps, runTriggerRun } from "../src/commands/trigger.ts";
import { DEFAULT_POOL } from "../src/env/ports.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-pg134",
    provider: "hetzner",
    providerId: "888000001",
    name: "samo-we-pgtest",
    ip: "10.0.1.1",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 22,
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
    id: "app-pg134",
    vmId: "vm-pg134",
    name: "pgtest-app",
    repo: "Tanya301/pgtest-1",
    branch: "main",
    appDir: "/opt/pgtest/app",
    buildCmd: "npm run build",
    serviceUnit: "pgtest-app",
    healthUrl: "http://localhost:3000/api/version",
    deployedSha: "fixed-sha-pg134",
    ...o,
  };
}

const fastResolveRef = async (_repo: string, _branch: string): Promise<string> =>
  "fixed-sha-pg134";

function makeEnvRecord(branch: string, o: Partial<EnvRecord> = {}): EnvRecord {
  const safeName = `pgtest-app-${branch.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 63);
  return {
    id: `env-pg-${branch}`,
    vmId: "vm-pg134",
    appName: "pgtest-app",
    branch,
    name: safeName,
    port: DEFAULT_POOL.base,
    vhost: `${safeName}.samo.cat`,
    dbBackend: "none" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function fakeBatchSuccess(itemId: string): string {
  const phases = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"];
  const phaseLines = phases
    .flatMap((p) => [`<<<SAMOHOST_PHASE:${p}:start>>>`, `<<<SAMOHOST_PHASE:${p}:ok>>>`])
    .join("\n");
  return [
    `<<<SAMOHOST_BATCH:START:${itemId}>>>`,
    phaseLines,
    `<<<SAMOHOST_BATCH:END:${itemId}>>>`,
  ].join("\n");
}

function noop(_s: string) {}

// ---------------------------------------------------------------------------
// Shared setup/teardown
// ---------------------------------------------------------------------------

let dir: string;
let vmStore: StateStore;
let appStore: AppStore;
let envStore: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-parity-"));
  vmStore = new StateStore(join(dir, "state.json"));
  appStore = new AppStore(join(dir, "apps.json"));
  envStore = new EnvStore(join(dir, "envs.json"));
  vmStore.upsert(makeVm());
  appStore.upsert(makeApp());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. BATCH TIMEOUT: computeBatchTimeoutMs(N) > 120s for N > 1, proportional
// ---------------------------------------------------------------------------

describe("(1) BATCH_TIMEOUT: SSH timeout scales with N items", () => {
  test("computeBatchTimeoutMs is exported from ssh/batch.ts", async () => {
    // RED: function does not exist yet → import will fail or be undefined
    const mod = await import("../src/ssh/batch.ts");
    expect(typeof (mod as Record<string, unknown>)["computeBatchTimeoutMs"]).toBe("function");
  });

  test("computeBatchTimeoutMs(1) returns positive value", async () => {
    const { computeBatchTimeoutMs } = await import("../src/ssh/batch.ts") as
      { computeBatchTimeoutMs: (n: number) => number };
    expect(computeBatchTimeoutMs(1)).toBeGreaterThan(0);
  });

  test("computeBatchTimeoutMs(5) > 120_000ms (exceeds old fixed timeout)", async () => {
    const { computeBatchTimeoutMs } = await import("../src/ssh/batch.ts") as
      { computeBatchTimeoutMs: (n: number) => number };
    // A 5-item batch cannot fit in the old fixed 120s.
    // After fix: base + 5*per_item > 120s.
    expect(computeBatchTimeoutMs(5)).toBeGreaterThan(120_000);
  });

  test("computeBatchTimeoutMs scales: timeout(5) > timeout(1)", async () => {
    const { computeBatchTimeoutMs } = await import("../src/ssh/batch.ts") as
      { computeBatchTimeoutMs: (n: number) => number };
    const t1 = computeBatchTimeoutMs(1);
    const t5 = computeBatchTimeoutMs(5);
    // Proportional: a 5-item batch gets more time than a 1-item batch.
    expect(t5).toBeGreaterThan(t1);
  });

  test("computeBatchTimeoutMs: timeout(N) grows monotonically", async () => {
    const { computeBatchTimeoutMs } = await import("../src/ssh/batch.ts") as
      { computeBatchTimeoutMs: (n: number) => number };
    expect(computeBatchTimeoutMs(3)).toBeGreaterThan(computeBatchTimeoutMs(2));
    expect(computeBatchTimeoutMs(10)).toBeGreaterThan(computeBatchTimeoutMs(5));
  });
});

// ---------------------------------------------------------------------------
// 2. DNS_RETRY: re-ensure DNS for env without lastDeployedSha (retry path)
// ---------------------------------------------------------------------------

describe("(2) DNS_RETRY: re-ensures DNS when env lacks lastDeployedSha", () => {
  test("ensurePreviewDns called for existing env with no lastDeployedSha", async () => {
    // Plant an env that has NO lastDeployedSha (prior failed cycle: deploy script
    // ran but external probe failed → lastDeployedSha never stamped).
    const branch = "feat/dns-retry-test";
    const headSha = "new-sha-for-retry-cycle";
    const failedEnv = makeEnvRecord(branch, {
      port: DEFAULT_POOL.base,
      vhost: `pgtest-app-feat-dns-retry-test.samo.cat`,
      dbBackend: "dblab",
      dbName: "pgtest-app-feat-dns-retry-test",
      // NO lastDeployedSha — this is the retry scenario
    });
    envStore.upsert(failedEnv);

    const listOpenPrs = async () => [
      { number: 201, headRef: branch, headSha },
    ];

    const itemId = `pr-201-feat-dns-retry-test`;

    const remote = async (_vm: VmRecord, _script: string) => ({
      code: 0,
      stdout: fakeBatchSuccess(itemId),
      stderr: "",
    });

    const dnsCalls: Array<{ vhost: string; ip: string }> = [];
    const ensurePreviewDns = async (vhost: string, ip: string): Promise<void> => {
      dnsCalls.push({ vhost, ip });
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      ensurePreviewDns,
      resolveRef: fastResolveRef,
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore, appStore, deps,
      noop, noop,
    );

    // THE ASSERTION: ensurePreviewDns MUST be called for the retry env.
    // On current code: isNewEnv=false → DNS skipped → dnsCalls=[] → FAIL (RED).
    // After fix: lastDeployedSha=undefined AND not new → DNS is re-ensured → PASS.
    expect(dnsCalls.length).toBeGreaterThan(0);
    expect(dnsCalls[0]?.vhost).toContain("dns-retry-test");
  });

  test("ensurePreviewDns NOT called when lastDeployedSha already matches headSha", async () => {
    // Branch already deployed at the current headSha → unchanged → no DNS call.
    const branch = "feat/already-deployed";
    const headSha = "already-deployed-sha";
    const deployedEnv = makeEnvRecord(branch, {
      port: DEFAULT_POOL.base,
      vhost: `pgtest-app-feat-already-deployed.samo.cat`,
      lastDeployedSha: headSha,  // already up to date
    });
    envStore.upsert(deployedEnv);

    const listOpenPrs = async () => [
      { number: 202, headRef: branch, headSha },
    ];

    const dnsCalls: string[] = [];
    const ensurePreviewDns = async (vhost: string) => { dnsCalls.push(vhost); };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      ensurePreviewDns,
      resolveRef: fastResolveRef,
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore, appStore, deps,
      noop, noop,
    );

    // Already deployed → no needDeploy → no DNS call (correct, unchanged).
    expect(dnsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. PORT_GUARD: Phase-1 live port probe → fail-closed on squatted port
// ---------------------------------------------------------------------------

describe("(3) PORT_GUARD: fail-closed when Phase-1 reveals squatted alloc port", () => {
  test("new PR skipped when Phase-1 probe shows its allocated port is bound", async () => {
    // Plant a dblab env at port 3101 so Phase-1 runs AND deriveTarget picks 3100 next.
    const dblabBranch = "feat/alive-dblab";
    const cloneId = `pgtest-app-${dblabBranch.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 63);
    envStore.upsert({
      id: "env-alive-dblab",
      vmId: "vm-pg134",
      appName: "pgtest-app",
      branch: dblabBranch,
      name: cloneId,
      port: DEFAULT_POOL.base + 1,  // 3101 taken → next free = 3100
      vhost: `${cloneId}.samo.cat`,
      dbBackend: "dblab" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // New PR — deriveTarget would allocate port 3100 (lowest free in store).
    const prBranch = "feat/squatted-alloc";
    const pr = { number: 301, headRef: prBranch, headSha: "squatted-sha-abc123" };
    const listOpenPrs = async () => [pr];

    // Phase-1 probe output: alive clone at 3101, port 3100 squatted by a foreign proc.
    const probeStdout = [
      `${HEAL_PROBE_CLONE_BEGIN}${cloneId}`,
      JSON.stringify({ status: { code: "OK" }, db: { port: DEFAULT_POOL.base + 1 } }),
      `${HEAL_PROBE_CLONE_END}${cloneId}`,
      HEAL_PROBE_PORTS_BEGIN,
      `LISTEN 0 0 0.0.0.0:${DEFAULT_POOL.base} 0.0.0.0:*`,   // squatter at 3100
      `LISTEN 0 0 0.0.0.0:${DEFAULT_POOL.base + 1} 0.0.0.0:*`, // our clone at 3101
      HEAL_PROBE_PORTS_END,
    ].join("\n");

    const prItemId = `pr-301-feat-squatted-alloc`;
    const remote = async (_vm: VmRecord, script: string) => {
      if (script.includes(HEAL_PROBE_PORTS_BEGIN)) {
        // Phase-1 probe: return squatter info
        return { code: 0, stdout: probeStdout, stderr: "" };
      }
      // Phase-4 batch work: return success for any items
      return { code: 0, stdout: fakeBatchSuccess(prItemId), stderr: "" };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      resolveRef: fastResolveRef,
      ensurePreviewDns: async () => {},  // no-op DNS
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string; prNumber: number; error?: string }> }>;
    };

    // THE ASSERTION: PR #301 must fail-closed (squatted port).
    // On current code: no live port check → port 3100 allocated → batch runs →
    //   fake success → httpProbe ok → action="created" → FAIL (RED).
    // After fix: Phase-1 ports parsed → 3100 is squatted → natural alloc is 3100 →
    //   fail-closed into prEarlyFailures → action="failed" → PASS.
    const prResult = (report.prPreviews ?? [])
      .flatMap((s) => s.results)
      .find((r) => r.prNumber === pr.number);
    expect(prResult).toBeDefined();
    expect(prResult?.action).toBe("failed");
  });

  test("multi-service PR fails when only a secondary allocated listener is bound", async () => {
    appStore.upsert(makeApp({
      services: [
        {
          name: "web",
          unit: "pgtest-app",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
        },
        {
          name: "app-api",
          unit: "pgtest-api",
          listeners: [{ name: "app-api", port: 3001, portEnv: "APP_API_PORT", healthPath: "/health" }],
        },
      ],
      defaultListener: "web",
    }));

    const cloneId = "pgtest-existing-clone";
    envStore.upsert(makeEnvRecord("feat/existing-clone", {
      id: "env-existing-clone",
      name: cloneId,
      port: DEFAULT_POOL.base + 2,
      ports: { web: DEFAULT_POOL.base + 2, "app-api": DEFAULT_POOL.base + 3 },
      dbBackend: "dblab",
      dbName: cloneId,
    }));

    const pr = { number: 303, headRef: "feat/secondary-squatter", headSha: "secondary-sha" };
    const probeStdout = [
      `${HEAL_PROBE_CLONE_BEGIN}${cloneId}`,
      JSON.stringify({ status: { code: "OK" }, db: { port: DEFAULT_POOL.base + 2 } }),
      `${HEAL_PROBE_CLONE_END}${cloneId}`,
      HEAL_PROBE_PORTS_BEGIN,
      // 3100 (the default listener) is free; only 3101 (app-api) is foreign-bound.
      `LISTEN 0 0 0.0.0.0:${DEFAULT_POOL.base + 1} 0.0.0.0:*`,
      `LISTEN 0 0 0.0.0.0:${DEFAULT_POOL.base + 2} 0.0.0.0:*`,
      HEAL_PROBE_PORTS_END,
    ].join("\n");

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs: async () => [pr],
      remote: async (_vm, script) => ({
        code: 0,
        stdout: script.includes(HEAL_PROBE_PORTS_BEGIN) ? probeStdout : "",
        stderr: "",
      }),
      resolveRef: fastResolveRef,
      ensurePreviewDns: async () => {},
      httpProbe: async () => ({ status: 200, ok: true }),
      sleep: async () => {},
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string; error?: string }> }>;
    };
    const result = report.prPreviews?.[0]?.results[0];
    expect(result?.action).toBe("failed");
    expect(result?.error).toContain("listener port 3101");
  });

  test("same-cycle multi-service PRs atomically reserve and persist every listener port", async () => {
    appStore.upsert(makeApp({
      services: [
        {
          name: "web",
          unit: "pgtest-app",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
        },
        {
          name: "app-api",
          unit: "pgtest-api",
          listeners: [{ name: "app-api", port: 3001, portEnv: "APP_API_PORT", healthPath: "/health" }],
        },
      ],
      defaultListener: "web",
    }));

    const prs = [
      { number: 304, headRef: "feat/atomic-one", headSha: "atomic-one-sha" },
      { number: 305, headRef: "feat/atomic-two", headSha: "atomic-two-sha" },
    ];
    const batchStdout = [
      fakeBatchSuccess("pr-304-feat-atomic-one"),
      fakeBatchSuccess("pr-305-feat-atomic-two"),
    ].join("\n");
    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs: async () => prs,
      remote: async () => ({ code: 0, stdout: batchStdout, stderr: "" }),
      resolveRef: fastResolveRef,
      ensurePreviewDns: async () => {},
      httpProbe: async () => ({ status: 200, ok: true }),
      sleep: async () => {},
    });

    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: false },
      vmStore, appStore, deps,
      noop, noop,
    );

    const first = envStore.get("vm-pg134", "pgtest-app", "feat/atomic-one");
    const second = envStore.get("vm-pg134", "pgtest-app", "feat/atomic-two");
    expect(first?.ports).toEqual({ web: 3100, "app-api": 3101 });
    expect(second?.ports).toEqual({ web: 3102, "app-api": 3103 });
    expect(new Set([
      ...Object.values(first?.ports ?? {}),
      ...Object.values(second?.ports ?? {}),
    ]).size).toBe(4);
  });

  test("non-squatted port: PR deploys successfully when Phase-1 port is free", async () => {
    // Port 3100 is free (not in probe output) → PR should succeed.
    const dblabBranch = "feat/healthy-for-free-port";
    const cloneId = `pgtest-app-${dblabBranch.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 63);
    envStore.upsert({
      id: "env-healthy-2",
      vmId: "vm-pg134",
      appName: "pgtest-app",
      branch: dblabBranch,
      name: cloneId,
      port: DEFAULT_POOL.base + 2,  // 3102 taken → 3100 is free
      vhost: `${cloneId}.samo.cat`,
      dbBackend: "dblab" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const prBranch = "feat/free-port-pr";
    const pr = { number: 302, headRef: prBranch, headSha: "free-port-sha-abc" };
    const listOpenPrs = async () => [pr];

    // Probe: clone alive at 3102. Only port 3102 bound (3100 is FREE).
    const probeStdout = [
      `${HEAL_PROBE_CLONE_BEGIN}${cloneId}`,
      JSON.stringify({ status: { code: "OK" }, db: { port: DEFAULT_POOL.base + 2 } }),
      `${HEAL_PROBE_CLONE_END}${cloneId}`,
      HEAL_PROBE_PORTS_BEGIN,
      `LISTEN 0 0 0.0.0.0:${DEFAULT_POOL.base + 2} 0.0.0.0:*`,  // only our clone
      HEAL_PROBE_PORTS_END,
    ].join("\n");

    const prItemId = `pr-302-feat-free-port-pr`;
    const remote = async (_vm: VmRecord, script: string) => {
      if (script.includes(HEAL_PROBE_PORTS_BEGIN)) {
        return { code: 0, stdout: probeStdout, stderr: "" };
      }
      return { code: 0, stdout: fakeBatchSuccess(prItemId), stderr: "" };
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote,
      resolveRef: fastResolveRef,
      ensurePreviewDns: async () => {},
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ results: Array<{ action: string; prNumber: number }> }>;
    };

    // Free port → PR should succeed (created).
    // This test must PASS on both old and new code (no regression for free ports).
    const prResult = (report.prPreviews ?? [])
      .flatMap((s) => s.results)
      .find((r) => r.prNumber === pr.number);
    expect(prResult).toBeDefined();
    expect(prResult?.action).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// 4. PREREQ_CONSISTENT: no silent wildcard-degrade when CF token missing
// ---------------------------------------------------------------------------

describe("(4) PREREQ_CONSISTENT: no silent wildcard-degrade when CF token absent", () => {
  test("new PR fails when CLOUDFLARE_SAMOCAT absent and no ensurePreviewDns injected", async () => {
    const orig = process.env["CLOUDFLARE_SAMOCAT"];
    delete process.env["CLOUDFLARE_SAMOCAT"];

    try {
      const pr = { number: 401, headRef: "feat/no-token-pr", headSha: "no-token-sha" };
      const listOpenPrs = async () => [pr];

      const prItemId = "pr-401-feat-no-token-pr";
      const remote = async (_vm: VmRecord, script: string) => {
        if (script.includes(HEAL_PROBE_PORTS_BEGIN)) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: fakeBatchSuccess(prItemId), stderr: "" };
      };

      // NOTE: ensurePreviewDns is NOT injected → production token-check path.
      const deps = defaultTriggerDeps({
        envStore,
        listOpenPrs,
        remote,
        resolveRef: fastResolveRef,
        // No ensurePreviewDns — exercises the prod CLOUDFLARE_SAMOCAT path.
        httpProbe: async (_url: string) => ({ status: 200, ok: true }),
        sleep: async (_ms: number) => {},
      });

      let outJson = "";
      await runTriggerRun(
        { prPreviews: true, heal: false, dryRun: false },
        { json: true },
        vmStore, appStore, deps,
        (s) => { outJson += s; },
        noop,
      );

      const report = JSON.parse(outJson) as {
        prPreviews?: Array<{ results: Array<{ action: string; prNumber: number }> }>;
      };

      // THE ASSERTION: PR must NOT succeed when the CF token is missing.
      // On current code: no token → wildcard degrade + continue → action="created" → FAIL (RED).
      // After fix: no token → DNS ensure fails → action="failed" → PASS (GREEN).
      const prResult = (report.prPreviews ?? [])
        .flatMap((s) => s.results)
        .find((r) => r.prNumber === pr.number);
      expect(prResult).toBeDefined();
      expect(prResult?.action).not.toBe("created");
      expect(prResult?.action).not.toBe("redeployed");
    } finally {
      if (orig !== undefined) {
        process.env["CLOUDFLARE_SAMOCAT"] = orig;
      }
    }
  });

  test("PR succeeds when CLOUDFLARE_SAMOCAT is set (consistent with startup gate)", async () => {
    // Positive control: when the token IS set (even a dummy value), the DNS step
    // should not block. We inject ensurePreviewDns to avoid real CF API calls.
    const orig = process.env["CLOUDFLARE_SAMOCAT"];
    process.env["CLOUDFLARE_SAMOCAT"] = "dummy-token-for-test";

    try {
      const pr = { number: 402, headRef: "feat/with-token-pr", headSha: "with-token-sha" };
      const listOpenPrs = async () => [pr];
      const prItemId = "pr-402-feat-with-token-pr";

      const dnsCalls: number[] = [];
      const deps = defaultTriggerDeps({
        envStore,
        listOpenPrs,
        remote: async (_vm: VmRecord, _script: string) => ({
          code: 0,
          stdout: fakeBatchSuccess(prItemId),
          stderr: "",
        }),
        resolveRef: fastResolveRef,
        ensurePreviewDns: async () => { dnsCalls.push(1); },
        httpProbe: async (_url: string) => ({ status: 200, ok: true }),
        sleep: async (_ms: number) => {},
      });

      let outJson = "";
      await runTriggerRun(
        { prPreviews: true, heal: false, dryRun: false },
        { json: true },
        vmStore, appStore, deps,
        (s) => { outJson += s; },
        noop,
      );

      const report = JSON.parse(outJson) as {
        prPreviews?: Array<{ results: Array<{ action: string; prNumber: number }> }>;
      };

      const prResult = (report.prPreviews ?? [])
        .flatMap((s) => s.results)
        .find((r) => r.prNumber === pr.number);
      expect(prResult).toBeDefined();
      expect(prResult?.action).toBe("created");
    } finally {
      if (orig !== undefined) {
        process.env["CLOUDFLARE_SAMOCAT"] = orig;
      } else {
        delete process.env["CLOUDFLARE_SAMOCAT"];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5a. REPORTING_DERIVETARGET: deriveTarget failure → failed result in summary
// ---------------------------------------------------------------------------

describe("(5a) REPORTING_DERIVETARGET: deriveTarget error in PrPreviewSummary", () => {
  test("port-pool exhaustion → failed result with real error (not 'item not found')", async () => {
    // Exhaust the port pool by planting 100 envs (DEFAULT_POOL.size = 100).
    for (let i = 0; i < DEFAULT_POOL.size; i++) {
      envStore.upsert({
        id: `env-pool-fill-${i}`,
        vmId: "vm-pg134",
        appName: "pgtest-app",
        branch: `branch-pool-fill-${i}`,
        name: `pgtest-app-branch-pool-fill-${i}`,
        port: DEFAULT_POOL.base + i,
        vhost: `pgtest-app-branch-pool-fill-${i}.samo.cat`,
        dbBackend: "none" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }

    // New PR that cannot get a port (pool exhausted).
    const pr = { number: 501, headRef: "feat/no-port-available", headSha: "no-port-sha" };
    const listOpenPrs = async () => [pr];

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      resolveRef: fastResolveRef,
      ensurePreviewDns: async () => {},
      httpProbe: async (_url: string) => ({ status: 200, ok: true }),
      sleep: async (_ms: number) => {},
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{
        results: Array<{ action: string; prNumber: number; error?: string }>;
      }>;
    };

    // THE ASSERTION 1: the PR must appear in the summary with action="failed".
    // On current code: deriveTarget failure only emits to stderr → no entry in summary
    //   (Phase-6 catches it as "item not found in batch output" — misleading fallback) → MIGHT PASS
    const prResult = (report.prPreviews ?? [])
      .flatMap((s) => s.results)
      .find((r) => r.prNumber === pr.number);
    expect(prResult).toBeDefined();
    expect(prResult?.action).toBe("failed");

    // THE ASSERTION 2: the error must contain the real reason ("pool" or "port" or "exhaust"),
    // NOT the generic "item not found in batch output".
    // On current code: error is "item not found in batch output" → FAIL (RED).
    // After fix: error describes port-pool exhaustion → PASS.
    expect(prResult?.error).not.toContain("item not found in batch output");
    expect(prResult?.error).toMatch(/pool.*exhaust|port.*pool|exhaust.*pool/i);
  });
});

// ---------------------------------------------------------------------------
// 5b. REPORTING_PRLIST: prList failure → listError field in PrPreviewSummary
// ---------------------------------------------------------------------------

describe("(5b) REPORTING_PRLIST: prList failure produces listError field", () => {
  test("PrPreviewSummary has listError when listOpenPrs throws", async () => {
    // Plant a PR-managed env to show the summary exists (not empty report).
    const plantedEnv = makeEnvRecord("feat/plant-pr", {
      prNumber: 600,
      lastDeployedSha: "planted-sha",
    });
    envStore.upsert(plantedEnv);

    // Make listOpenPrs throw (gh CLI failure, 401, network error, etc.).
    const listOpenPrs = async (_repo: string): Promise<never> => {
      throw new Error("gh pr list: HTTP 401 — token expired");
    };

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      resolveRef: fastResolveRef,
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{
        openPrs: number;
        results: unknown[];
        listError?: string;
      }>;
    };

    // THE ASSERTION: summary must have a listError field set.
    // On current code: PrPreviewSummary has no listError field → undefined → FAIL (RED).
    // After fix: listError captures the error message → PASS.
    const summary = report.prPreviews?.[0];
    expect(summary).toBeDefined();
    expect(summary?.listError).toBeDefined();
    expect(summary?.listError).toContain("401");

    // Must also have zero results (not reaped, not created).
    expect(summary?.results).toHaveLength(0);
  });

  test("PrPreviewSummary has NO listError when list succeeds (zero open PRs)", async () => {
    // When the list call returns [] (zero PRs), there should be no listError.
    const listOpenPrs = async () => [];

    const deps = defaultTriggerDeps({
      envStore,
      listOpenPrs,
      remote: async () => ({ code: 0, stdout: "", stderr: "" }),
      resolveRef: fastResolveRef,
    });

    let outJson = "";
    await runTriggerRun(
      { prPreviews: true, heal: false, dryRun: false },
      { json: true },
      vmStore, appStore, deps,
      (s) => { outJson += s; },
      noop,
    );

    const report = JSON.parse(outJson) as {
      prPreviews?: Array<{ openPrs: number; listError?: string }>;
    };

    const summary = report.prPreviews?.[0];
    expect(summary).toBeDefined();
    // No listError when list succeeded (even if zero PRs).
    expect(summary?.listError).toBeUndefined();
    // openPrs = 0 (distinguishable from listError case: openPrs may also be 0
    // on failure but listError is set in that case).
    expect(summary?.openPrs).toBe(0);
  });
});
