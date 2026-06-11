import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-store-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(id: string, overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id,
    provider: "hetzner",
    providerId: `srv-${id}`,
    name: `vm-${id}`,
    ip: "203.0.113.10",
    sshKeyPath: "/home/u/.ssh/id_ed25519.pub",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("StateStore", () => {
  test("upsert then read back atomically", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a"));
    expect(existsSync(statePath)).toBe(true);

    const reread = new StateStore(statePath);
    const got = reread.get("a");
    expect(got?.id).toBe("a");
    expect(got?.providerId).toBe("srv-a");
    // no leftover tmp file
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });

  test("list/get/remove behave correctly", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a"));
    store.upsert(rec("b"));
    expect(store.list().map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(store.get("missing")).toBeUndefined();

    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    expect(store.list().map((r) => r.id)).toEqual(["b"]);
  });

  test("upsert replaces existing record and bumps updatedAt", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a", { lifecycleState: "creating" }));
    const updated = store.upsert(rec("a", { lifecycleState: "ready" }));
    expect(store.list().length).toBe(1);
    expect(store.get("a")?.lifecycleState).toBe("ready");
    expect(updated.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("keeps a .bak of the previous version on write", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a")); // first write, no prior file → no bak yet
    store.upsert(rec("b")); // second write → bak of the one-record version
    expect(existsSync(`${statePath}.bak`)).toBe(true);
    const bak = JSON.parse(readFileSync(`${statePath}.bak`, "utf8"));
    expect(bak.records.map((r: VmRecord) => r.id)).toEqual(["a"]);
  });

  test("recovers from .bak when the primary is corrupt", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a"));
    store.upsert(rec("b")); // creates a valid .bak (records: [a])

    // Corrupt the primary file.
    writeFileSync(statePath, "{ this is not json", "utf8");

    const recovered = new StateStore(statePath);
    const ids = recovered.list().map((r) => r.id);
    expect(ids).toEqual(["a"]); // came from .bak
  });

  test("recovers from .bak when the primary is missing (crash mid-rename)", () => {
    const store = new StateStore(statePath);
    store.upsert(rec("a"));
    store.upsert(rec("b"));

    // Simulate a crash AFTER .bak was written but BEFORE rename completed:
    // primary is gone, only .bak (records: [a]) and a stray .tmp remain.
    rmSync(statePath);
    writeFileSync(`${statePath}.tmp`, "partial garbage not yet renamed", "utf8");

    const recovered = new StateStore(statePath);
    const ids = recovered.list().map((r) => r.id);
    expect(ids).toEqual(["a"]); // old state intact, .tmp ignored
  });

  test("write path uses tmp+rename: prior state intact until rename", () => {
    // Verify the contract by inspecting that a completed write left a clean
    // primary and a recoverable bak, with no half-written primary.
    const store = new StateStore(statePath);
    store.upsert(rec("a"));
    store.upsert(rec("b"));
    // primary parses cleanly
    const primary = JSON.parse(readFileSync(statePath, "utf8"));
    expect(primary.records.map((r: VmRecord) => r.id).sort()).toEqual([
      "a",
      "b",
    ]);
    // bak holds the immediately-prior good version
    const bak = JSON.parse(readFileSync(`${statePath}.bak`, "utf8"));
    expect(bak.records.map((r: VmRecord) => r.id)).toEqual(["a"]);
  });

  test("empty store lists nothing", () => {
    const store = new StateStore(statePath);
    expect(store.list()).toEqual([]);
  });
});
