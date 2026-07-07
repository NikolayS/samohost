/**
 * TDD RED — YAML-parse + schema validation for buildServerYml() (#128).
 *
 * The previous tests only did toContain() string checks, which let invalid YAML
 * structure through undetected. This file uses a real YAML parser (js-yaml) to
 * parse the generated server.yml and asserts the exact structural shape that
 * DBLab v4.1.3 requires — scalar vs list types, correct key nesting.
 *
 * Ground truth: /root/.dblab/engine/configs/server.yml on samograph
 * (ssh -p 2223 samo@116.203.249.135), confirmed running DBLab 4.1.3.
 *
 * Bugs that caused "[FATAL] failed to parse config" on the smoke VM:
 *   BUG-1  cloneAccessAddresses emitted as YAML sequence instead of scalar string
 *   BUG-2a retrieval.spec.skipStartRefresh — wrong nesting; must be retrieval.refresh.skipStartRefresh
 *   BUG-2b retrieval.spec.jobs — wrong nesting; flat list must be retrieval.jobs
 *   BUG-3  losetup hardcodes /dev/loop0 (Ubuntu 24.04 + snapd occupy loop0-2)
 *   BUG-4  ${DBLAB_SOURCE_USER} placeholder never substituted → refresh silent-fail
 */

import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import * as DblabModuleNs from "../src/cloudinit/dblab.ts";
import type { Module } from "../src/types.ts";
import { makeSpec } from "./helpers.ts";

const makeDblabModule = (DblabModuleNs as Record<string, unknown>)[
  "makeDblabModule"
] as ((opts: { sourceDb?: string }) => Module) | undefined;

/** Extract the raw server.yml string from a module's cloudInitFragment. */
function extractServerYml(mod: Module): string {
  const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
  const fragment = mod.cloudInitFragment(spec);
  const files = fragment.writeFiles ?? [];
  const file = files.find((f) => f.path.endsWith("server.yml"));
  if (!file) throw new Error("server.yml not found in writeFiles");
  return file.content;
}

/** Parse server.yml content into a typed object, failing the test on YAML error. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseServerYml(content: string): Record<string, any> {
  try {
    const parsed = yaml.load(content);
    if (!parsed || typeof parsed !== "object")
      throw new Error("YAML did not parse to an object");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return parsed as Record<string, any>;
  } catch (e) {
    throw new Error(`server.yml failed to parse as YAML: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// BUG-1: cloneAccessAddresses must be a scalar string, NOT a YAML sequence
// ---------------------------------------------------------------------------
// Working config: cloneAccessAddresses: "127.0.0.1"
// Broken output:  cloneAccessAddresses:\n  - "127.0.0.1"
// DBLab v4.1.3 expects a string; receiving a list causes a parse error.

describe("server.yml — cloneAccessAddresses must be a scalar string (BUG-1)", () => {
  test("parses without error (YAML is structurally valid)", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const content = extractServerYml(makeDblabModule({}));
    expect(() => parseServerYml(content)).not.toThrow();
  });

  test("provision.cloneAccessAddresses is a string, not an array", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    const val = parsed?.provision?.cloneAccessAddresses;
    expect(typeof val).toBe("string");
    expect(Array.isArray(val)).toBe(false);
  });

  test("provision.cloneAccessAddresses equals '127.0.0.1'", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    expect(parsed?.provision?.cloneAccessAddresses).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// BUG-2a: skipStartRefresh belongs at retrieval.refresh.skipStartRefresh
// ---------------------------------------------------------------------------
// Working config:
//   retrieval:
//     refresh:
//       skipStartRefresh: true   ← here
//
// Broken output puts it at retrieval.spec.skipStartRefresh (wrong level).

describe("server.yml — retrieval.refresh.skipStartRefresh nesting (BUG-2a)", () => {
  test("retrieval.refresh exists as an object", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    expect(typeof parsed?.retrieval?.refresh).toBe("object");
    expect(parsed?.retrieval?.refresh).not.toBeNull();
  });

  test("retrieval.refresh.skipStartRefresh is a boolean", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    expect(typeof parsed?.retrieval?.refresh?.skipStartRefresh).toBe("boolean");
  });

  test("skipStartRefresh is NOT at retrieval.spec level (wrong nesting)", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    // retrieval.spec must NOT have skipStartRefresh — that key belongs at retrieval.refresh
    expect(parsed?.retrieval?.spec?.skipStartRefresh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG-2b: retrieval.jobs must be a flat list of strings at retrieval.jobs
// ---------------------------------------------------------------------------
// Working config:
//   retrieval:
//     jobs:
//       - logicalDump        ← plain strings, NOT objects
//       - logicalRestore
//       - logicalSnapshot
//
// Broken output has retrieval.spec.jobs with inline options objects.

describe("server.yml — retrieval.jobs flat list at correct level (BUG-2b)", () => {
  test("retrieval.jobs is an array", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    expect(Array.isArray(parsed?.retrieval?.jobs)).toBe(true);
  });

  test("retrieval.jobs contains exactly [logicalDump, logicalRestore, logicalSnapshot]", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    expect(parsed?.retrieval?.jobs).toEqual([
      "logicalDump",
      "logicalRestore",
      "logicalSnapshot",
    ]);
  });

  test("each entry in retrieval.jobs is a plain string (not an object)", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    const jobs: unknown[] = parsed?.retrieval?.jobs ?? [];
    for (const job of jobs) {
      expect(typeof job).toBe("string");
    }
  });

  test("retrieval.spec.jobs does NOT exist (jobs was under wrong nesting)", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(extractServerYml(makeDblabModule({})));
    // Jobs list must NOT be nested inside spec
    expect(parsed?.retrieval?.spec?.jobs).toBeUndefined();
  });

  test("retrieval.spec.logicalDump.options exists with connection details", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const parsed = parseServerYml(
      extractServerYml(makeDblabModule({ sourceDb: "myapp_template" })),
    );
    const conn = parsed?.retrieval?.spec?.logicalDump?.options?.source?.connection;
    expect(conn).toBeDefined();
    expect(conn?.host).toBe("172.17.0.1");
    expect(conn?.port).toBe(5432);
  });
});

// ---------------------------------------------------------------------------
// BUG-3: losetup must use -f --show, not hardcode /dev/loop0
// ---------------------------------------------------------------------------

describe("cloud-init runcmd — losetup -f --show (BUG-3)", () => {
  test("runcmd contains 'losetup -f --show' (dynamic device allocation)", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
    const fragment = makeDblabModule({}).cloudInitFragment(spec);
    const runcmd = (fragment.runcmd ?? []).join("\n");
    expect(runcmd).toContain("losetup -f --show");
  });

  test("runcmd does NOT hardcode /dev/loop0 for initial losetup attach", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
    const fragment = makeDblabModule({}).cloudInitFragment(spec);
    // The initial losetup command must NOT hardcode loop0
    const losetupLines = (fragment.runcmd ?? []).filter(
      (c) => c.startsWith("losetup") && c.includes("dblab.img"),
    );
    for (const line of losetupLines) {
      expect(line).not.toContain("/dev/loop0");
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-4: ${DBLAB_SOURCE_USER} must be substituted with adminUser from spec
// ---------------------------------------------------------------------------

describe("server.yml — DBLAB_SOURCE_USER substituted (BUG-4)", () => {
  test("username in logicalDump connection does NOT contain literal '${DBLAB_SOURCE_USER}'", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
    const fragment = makeDblabModule({ sourceDb: "myapp_template" }).cloudInitFragment(spec);
    const serverYmlFile = (fragment.writeFiles ?? []).find((f) => f.path.endsWith("server.yml"));
    expect(serverYmlFile).toBeDefined();
    // Must not leave the placeholder literal in the written file
    expect(serverYmlFile!.content).not.toContain("${DBLAB_SOURCE_USER}");
  });

  test("username in logicalDump connection equals the spec adminUser", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const spec = makeSpec({ trustedIps: [], adminUser: "samo" });
    const fragment = makeDblabModule({ sourceDb: "myapp_template" }).cloudInitFragment(spec);
    const serverYmlFile = (fragment.writeFiles ?? []).find((f) => f.path.endsWith("server.yml"));
    const parsed = parseServerYml(serverYmlFile!.content);
    const conn = parsed?.retrieval?.spec?.logicalDump?.options?.source?.connection;
    expect(conn?.username).toBe("samo");
  });

  test("different adminUser values produce different username in server.yml", () => {
    if (!makeDblabModule) throw new Error("makeDblabModule not exported — RED");
    const specA = makeSpec({ adminUser: "alice" });
    const specB = makeSpec({ adminUser: "bob" });
    const modOpts = { sourceDb: "app_template" };
    const fragA = makeDblabModule(modOpts).cloudInitFragment(specA);
    const fragB = makeDblabModule(modOpts).cloudInitFragment(specB);
    const fileA = (fragA.writeFiles ?? []).find((f) => f.path.endsWith("server.yml"))!;
    const fileB = (fragB.writeFiles ?? []).find((f) => f.path.endsWith("server.yml"))!;
    const parsedA = parseServerYml(fileA.content);
    const parsedB = parseServerYml(fileB.content);
    expect(
      parsedA.retrieval?.spec?.logicalDump?.options?.source?.connection?.username,
    ).toBe("alice");
    expect(
      parsedB.retrieval?.spec?.logicalDump?.options?.source?.connection?.username,
    ).toBe("bob");
  });
});
