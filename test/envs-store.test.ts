import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvStore } from "../src/state/envs.ts";
import type { EnvRecord } from "../src/types.ts";

function env(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-1",
    vmId: "vm-1111",
    appName: "field-record-1",
    branch: "feat/x",
    name: "field-record-1-feat-x",
    port: 3100,
    vhost: "field-record-1-feat-x.samo.cat",
    dbBackend: "dblab",
    dbName: "field-record-1-feat-x",
    createdAt: "2026-06-11T00:00:00.000Z",
    ...o,
  };
}

describe("EnvStore", () => {
  let dir: string;
  let store: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-envs-"));
    store = new EnvStore(join(dir, "envs.json"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("empty store lists nothing", () => {
    expect(store.list()).toEqual([]);
  });

  test("upsert + get by (vmId, appName, branch)", () => {
    store.upsert(env());
    expect(store.get("vm-1111", "field-record-1", "feat/x")?.port).toBe(3100);
    expect(store.get("vm-1111", "field-record-1", "feat/y")).toBeUndefined();
  });

  test("upsert same triple replaces, preserving id", () => {
    store.upsert(env({ id: "env-orig" }));
    const stored = store.upsert(env({ id: "env-new", port: 3101 }));
    expect(stored.id).toBe("env-orig");
    expect(store.list()).toHaveLength(1);
    expect(store.get("vm-1111", "field-record-1", "feat/x")?.port).toBe(3101);
  });

  test("listFor narrows by vm and optionally app", () => {
    store.upsert(env());
    store.upsert(env({ id: "e2", branch: "feat/y", name: "n2", port: 3101 }));
    store.upsert(env({ id: "e3", appName: "other", branch: "z", name: "n3", port: 3102 }));
    store.upsert(env({ id: "e4", vmId: "vm-2222", branch: "w", name: "n4" }));
    expect(store.listFor("vm-1111")).toHaveLength(3);
    expect(store.listFor("vm-1111", "field-record-1")).toHaveLength(2);
  });

  test("remove by triple", () => {
    store.upsert(env());
    expect(store.remove("vm-1111", "field-record-1", "feat/x")).toBe(true);
    expect(store.remove("vm-1111", "field-record-1", "feat/x")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("persists across instances (same path)", () => {
    store.upsert(env());
    const reopened = new EnvStore(store.path);
    expect(reopened.get("vm-1111", "field-record-1", "feat/x")).toBeDefined();
  });
});
