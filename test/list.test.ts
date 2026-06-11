import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { runList } from "../src/commands/list.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

function rec(id: string, o: Partial<VmRecord> = {}): VmRecord {
  return {
    id,
    provider: "hetzner",
    providerId: `srv-${id}`,
    name: `vm-${id}`,
    ip: "203.0.113.10",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

describe("parseArgs list", () => {
  test("bare list", () => {
    const cmd = parseArgs(["list"]);
    if (cmd.kind !== "list") throw new Error("expected list");
    expect(cmd.json).toBe(false);
  });
  test("list --json", () => {
    const cmd = parseArgs(["list", "--json"]);
    if (cmd.kind !== "list") throw new Error("expected list");
    expect(cmd.json).toBe(true);
  });
  test("unknown list flag throws", () => {
    expect(() => parseArgs(["list", "--bogus"])).toThrow();
  });
});

describe("runList", () => {
  let dir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-list-"));
    store = new StateStore(join(dir, "state.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function capture() {
    let out = "";
    let err = "";
    return {
      out: (s: string) => (out += s + "\n"),
      err: (s: string) => (err += s + "\n"),
      get o() {
        return out;
      },
      get e() {
        return err;
      },
    };
  }

  test("empty state → friendly message, exit 0", () => {
    const c = capture();
    const code = runList({ json: false }, store, c.out, c.err);
    expect(code).toBe(0);
    expect(c.o.toLowerCase()).toContain("no");
  });

  test("table lists name/provider/ip/sshPort/lifecycleState", () => {
    store.upsert(rec("a", { name: "alpha", ip: "1.2.3.4", sshPort: 22 }));
    store.upsert(rec("b", { name: "beta", lifecycleState: "ready" }));
    const c = capture();
    const code = runList({ json: false }, store, c.out, c.err);
    expect(code).toBe(0);
    expect(c.o).toContain("alpha");
    expect(c.o).toContain("beta");
    expect(c.o).toContain("hetzner");
    expect(c.o).toContain("1.2.3.4");
    expect(c.o).toContain("adopted");
    expect(c.o).toContain("ready");
  });

  test("--json emits raw records array", () => {
    store.upsert(rec("a", { name: "alpha" }));
    const c = capture();
    const code = runList({ json: true }, store, c.out, c.err);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("alpha");
    expect(parsed[0].hostKeyFingerprint).toBeDefined();
  });

  test("--json on empty state → []", () => {
    const c = capture();
    const code = runList({ json: true }, store, c.out, c.err);
    expect(code).toBe(0);
    expect(JSON.parse(c.o)).toEqual([]);
  });
});
