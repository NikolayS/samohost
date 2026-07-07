/**
 * TDD RED — 4 fixes for the dblab provisioning module (#128).
 *
 * Root cause (root-caused + fixed live on samograph, task wdgv5zs85):
 *   The generated server.yml was missing poolManager.preSnapshotSuffix.
 *   Without it DBLab runs "zfs list ... | grep -v ''" and BusyBox grep rejects
 *   an empty pattern (exit 2) → "no available pools" → engine can't see the ZFS
 *   pool → dead, zero clones. Same failure mode as the manual samograph install.
 *
 * Fixes asserted here:
 *   1. server.yml MUST contain poolManager.preSnapshotSuffix: "_pre"
 *   2. poolManager MUST use selectedPool: (not pool: — correct yaml struct tag)
 *   3. logicalDump source dbname MUST be config-driven (not hardcoded as _prod)
 *      — a makeDblabModule({ sourceDb }) factory provides this so preview envs
 *      can connect to <app>_template instead of <app>_prod
 *   4. defaultEnvExecDeps() MUST wire a real dblabPreflight (currently absent →
 *      the env-create honesty gate is inert in production)
 */

import { describe, expect, test } from "bun:test";
import { buildCloudInit } from "../src/cloudinit/builder.ts";
// Import the whole namespace so that un-exported names resolve to undefined
// instead of throwing (Bun throws SyntaxError on missing named exports).
import * as DblabModuleNs from "../src/cloudinit/dblab.ts";
import { defaultEnvExecDeps } from "../src/commands/env.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";
import type { Module } from "../src/types.ts";

const { dblabModule } = DblabModuleNs;
// makeDblabModule will be undefined until the GREEN commit adds the export.
const makeDblabModule = (DblabModuleNs as Record<string, unknown>)["makeDblabModule"] as
  | ((opts: { sourceDb?: string }) => Module)
  | undefined;

const CONTROL_PLANE_IP = "91.99.233.145";

function buildFull(mod: Module = dblabModule): string {
  const spec = makeSpec({ trustedIps: [CONTROL_PLANE_IP] });
  return buildCloudInit(spec, [mod], { sshPubkey: SAMPLE_PUBKEY });
}

// ---------------------------------------------------------------------------
// Fix 1: poolManager.preSnapshotSuffix: "_pre" MUST be present in server.yml
// ---------------------------------------------------------------------------
//
// Without this key, DBLab v4 runs:
//   zfs list -t snapshot -H -o name | grep -v ''
// BusyBox grep (Alpine base image) rejects an empty -v pattern with exit 2.
// DBLab interprets exit 2 as "no available pools" and refuses to serve clones.

describe('dblab module — poolManager.preSnapshotSuffix: "_pre" (BusyBox grep fix)', () => {
  test('server.yml contains preSnapshotSuffix: "_pre"', () => {
    const out = buildFull();
    expect(out).toContain('preSnapshotSuffix: "_pre"');
  });

  test('makeDblabModule() produced config also contains preSnapshotSuffix: "_pre"', () => {
    if (makeDblabModule === undefined) {
      throw new Error("makeDblabModule is not exported yet — RED: missing factory");
    }
    const mod: Module = makeDblabModule({ sourceDb: "test_template" });
    const out = buildFull(mod);
    expect(out).toContain('preSnapshotSuffix: "_pre"');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: poolManager.selectedPool (correct yaml struct tag)
// ---------------------------------------------------------------------------
//
// The wrong tag `pool:` is harmlessly ignored by DBLab — the engine starts but
// never attaches to the ZFS pool. Using `selectedPool:` is the correct tag per
// the DBLab v4.1.3 schema. This is a harmless but correct fix.

describe("dblab module — poolManager.selectedPool struct tag (not pool:)", () => {
  test("server.yml contains selectedPool: dblab", () => {
    const out = buildFull();
    expect(out).toContain("selectedPool: dblab");
  });

  test("server.yml does NOT contain bare 'pool: dblab' (wrong yaml struct tag)", () => {
    const out = buildFull();
    expect(out).not.toContain("pool: dblab");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: source DB config-driven via makeDblabModule factory
// ---------------------------------------------------------------------------
//
// The old code used ${DBLAB_SOURCE_DB} as an unsubstituted placeholder. The
// preview env always needs <app>_template (not <app>_prod) as the source:
//   samograph → samograph_template (preview envs)
//   samograph → samograph_prod (WRONG — direct production DB)
// makeDblabModule({ sourceDb }) bakes the correct DB name into server.yml at
// provisioning time so the engine initializes with the right source on first boot.

describe("dblab module — source DB config-driven via makeDblabModule", () => {
  test("makeDblabModule is a callable function exported from cloudinit/dblab.ts", () => {
    expect(typeof makeDblabModule).toBe("function");
  });

  test("makeDblabModule({ sourceDb: 'samograph_template' }) bakes the DB name into server.yml", () => {
    if (makeDblabModule === undefined) {
      throw new Error("makeDblabModule is not exported yet — RED: missing factory");
    }
    const mod: Module = makeDblabModule({ sourceDb: "samograph_template" });
    const out = buildFull(mod);
    expect(out).toContain("samograph_template");
  });

  test("different sourceDb values produce different server.yml content", () => {
    if (makeDblabModule === undefined) {
      throw new Error("makeDblabModule is not exported yet — RED: missing factory");
    }
    const modA: Module = makeDblabModule({ sourceDb: "app_a_template" });
    const modB: Module = makeDblabModule({ sourceDb: "app_b_prod" });
    const outA = buildFull(modA);
    const outB = buildFull(modB);
    expect(outA).toContain("app_a_template");
    expect(outA).not.toContain("app_b_prod");
    expect(outB).toContain("app_b_prod");
    expect(outB).not.toContain("app_a_template");
  });

  test("default dblabModule does NOT hardcode '_prod' as the source DB dbname", () => {
    const out = buildFull();
    // Must NOT contain a hardcoded <name>_prod pattern in the dbname field.
    // The placeholder is acceptable; a hardcoded _prod is not.
    expect(out).not.toMatch(/dbname:\s*["']?\w+_prod["']?/);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: defaultEnvExecDeps() must wire dblabPreflight to production
// ---------------------------------------------------------------------------
//
// The env-create honesty gate (runEnvCreate dblab path) checks deps.dblabPreflight
// before running the create script. If dblabPreflight is absent (undefined) the
// gate is silently skipped — a db=dblab env-create against a non-running engine
// will write a fake env record, just as samograph's broken path did.
// Fix: wire a real healthz probe in defaultEnvExecDeps() so the gate fires in prod.

describe("defaultEnvExecDeps — dblabPreflight wired to production (#128 fix)", () => {
  test("defaultEnvExecDeps() returns an object with a dblabPreflight function", () => {
    const deps = defaultEnvExecDeps();
    expect(typeof deps.dblabPreflight).toBe("function");
  });

  test("dblabPreflight returns a Promise (shape check — no SSH needed)", () => {
    const deps = defaultEnvExecDeps();
    const fn = deps.dblabPreflight!;
    // Pass a minimal VmRecord; the call will fail (no SSH), but it MUST
    // return a Promise synchronously (not throw). We don't await it.
    const minimalVm = {
      id: "v-test",
      provider: "hetzner" as const,
      providerId: "1",
      name: "test-vm",
      ip: "127.0.0.2",
      sshKeyPath: "/home/user/.ssh/id_ed25519",
      sshPort: 2223,
      sshUser: "samo",
      hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      region: "nbg1",
      type: "cx22",
      modules: ["dblab"],
      lifecycleState: "ready" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = fn(minimalVm);
    // Must return a Promise object (not throw synchronously).
    expect(result).toBeInstanceOf(Promise);
    // Consume the promise to avoid unhandled-rejection noise in test output.
    result.catch(() => {});
  });
});
