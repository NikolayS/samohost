import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { runStatus, type RemoteRunner } from "../src/commands/status.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

function rec(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
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
    ...o,
  };
}

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

describe("parseArgs status", () => {
  test("status target", () => {
    const cmd = parseArgs(["status", "samo-we-field-record"]);
    if (cmd.kind !== "status") throw new Error("expected status");
    expect(cmd.input.target).toBe("samo-we-field-record");
    expect(cmd.input.audit).toBe(false);
    expect(cmd.json).toBe(false);
  });

  test("status target --audit --json", () => {
    const cmd = parseArgs(["status", "vm-1", "--audit", "--json"]);
    if (cmd.kind !== "status") throw new Error("expected status");
    expect(cmd.input).toEqual({ target: "vm-1", audit: true });
    expect(cmd.json).toBe(true);
  });

  test("missing target and unknown flag throw", () => {
    expect(() => parseArgs(["status"])).toThrow(/requires/);
    expect(() => parseArgs(["status", "vm", "--bogus"])).toThrow(/unknown/);
  });
});

describe("runStatus", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-status-"));
    store = new StateStore(join(dir, "state.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("prints a record by name without live audit", async () => {
    store.upsert(rec());
    const c = capture();
    const code = await runStatus(
      { target: "samo-we-field-record", audit: false },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("samo-we-field-record");
    expect(c.o).toContain("agent@178.105.246.151:2223");
    expect(c.e).toBe("");
  });

  test("missing record exits 1", async () => {
    const c = capture();
    const code = await runStatus(
      { target: "missing", audit: false },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("not found");
  });

  test("--audit runs every hardening probe and returns PASS rows", async () => {
    store.upsert(rec());
    const seen: string[] = [];
    const remote: RemoteRunner = (_vm, command) => {
      seen.push(command);
      if (command.includes("sshd -T")) {
        return Promise.resolve({ code: 0, stdout: "port 2223\n", stderr: "" });
      }
      if (command.includes("ufw status")) {
        return Promise.resolve({
          code: 0,
          stdout: "Status: active\nDefault: deny (incoming)\n",
          stderr: "",
        });
      }
      if (command.includes("systemctl is-active fail2ban")) {
        return Promise.resolve({ code: 0, stdout: "active\n", stderr: "" });
      }
      if (command.includes("accept_redirects")) {
        return Promise.resolve({ code: 0, stdout: "0\n", stderr: "" });
      }
      if (command.includes("aa-status")) {
        return Promise.resolve({
          code: 0,
          stdout: "12 profiles are in enforce mode.\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "1\n", stderr: "" });
    };

    const c = capture();
    const code = await runStatus(
      { target: "11111111-2222-3333-4444-555555555555", audit: true },
      { json: false },
      store,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThan(3);
    expect(c.o).toContain("audit:");
    expect(c.o).toContain("PASS");
  });

  test("--audit exits 1 when a probe does not match", async () => {
    store.upsert(rec());
    const remote: RemoteRunner = () =>
      Promise.resolve({ code: 0, stdout: "inactive\n", stderr: "" });
    const c = capture();
    const code = await runStatus(
      { target: "samo-we-field-record", audit: true },
      { json: true },
      store,
      c.out,
      c.err,
      remote,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.o);
    expect(parsed.audit.some((r: { ok: boolean }) => !r.ok)).toBe(true);
  });
});
