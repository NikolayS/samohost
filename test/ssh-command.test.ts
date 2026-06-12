import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError, type ParsedCommand } from "../src/cli.ts";
import {
  buildSshSessionArgs,
  runSsh,
  type SshSessionDeps,
} from "../src/commands/ssh.ts";
import { buildSshArgs, knownHostsPathFor } from "../src/ssh/runner.ts";
import { StateStore } from "../src/state/store.ts";
import type { VmRecord } from "../src/types.ts";

// VmRecord fixture matches the prod shape (src/types.ts VmRecord; same shape
// the adopt/provision paths persist — see ssh-runner.test.ts).
function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    provider: "hetzner",
    providerId: "srv-1",
    name: "samo-field",
    ip: "178.105.246.151",
    sshKeyPath: "/home/op/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs ssh", () => {
  test("interactive: ssh <vm>", () => {
    const cmd = parseArgs(["ssh", "samo-field"]) as Extract<
      ParsedCommand,
      { kind: "ssh" }
    >;
    expect(cmd.kind).toBe("ssh");
    expect(cmd.input.target).toBe("samo-field");
    expect(cmd.input.remoteCommand).toBeUndefined();
  });

  test("remote command: everything after -- is the command, verbatim", () => {
    const cmd = parseArgs([
      "ssh", "samo-field", "--", "uptime", "-p",
    ]) as Extract<ParsedCommand, { kind: "ssh" }>;
    expect(cmd.kind).toBe("ssh");
    expect(cmd.input.target).toBe("samo-field");
    expect(cmd.input.remoteCommand).toBe("uptime -p");
  });

  test("flags after -- are NOT parsed as samohost flags", () => {
    const cmd = parseArgs([
      "ssh", "samo-field", "--", "ls", "--json",
    ]) as Extract<ParsedCommand, { kind: "ssh" }>;
    expect(cmd.input.remoteCommand).toBe("ls --json");
  });

  test("missing vm is a usage error", () => {
    expect(() => parseArgs(["ssh"])).toThrow(UsageError);
  });

  test("empty command after -- is a usage error", () => {
    expect(() => parseArgs(["ssh", "samo-field", "--"])).toThrow(UsageError);
  });

  test("unknown flag before -- is a usage error", () => {
    expect(() => parseArgs(["ssh", "samo-field", "--bogus"])).toThrow(
      UsageError,
    );
  });

  test("extra positional is a usage error", () => {
    expect(() => parseArgs(["ssh", "a", "b"])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// buildSshSessionArgs — pinned argv, identical machinery to runRemote
// ---------------------------------------------------------------------------

describe("buildSshSessionArgs", () => {
  const opts = { knownHostsDir: "/tmp/kh.d", controlDir: "/tmp/cm" };

  test("with a remote command: exactly buildSshArgs (pin/port/user/key reused)", () => {
    expect(buildSshSessionArgs(vm(), "uptime -p", opts)).toEqual(
      buildSshArgs(vm(), "uptime -p", opts),
    );
  });

  test("interactive: buildSshArgs minus the trailing command element", () => {
    const args = buildSshSessionArgs(vm(), undefined, opts);
    const withCmd = buildSshArgs(vm(), "x", opts);
    expect(args).toEqual(withCmd.slice(0, -1));
    // destination is the final element; the pin is present
    expect(args[args.length - 1]).toBe("agent@178.105.246.151");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(
      "UserKnownHostsFile=/tmp/kh.d/11111111-2222-3333-4444-555555555555",
    );
    expect(args).toContain("2223");
    expect(args).toContain("/home/op/.ssh/id_ed25519");
  });
});

// ---------------------------------------------------------------------------
// runSsh — resolve from state, ensure known_hosts, spawn with the terminal
// ---------------------------------------------------------------------------

describe("runSsh", () => {
  let dir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-sshcmd-"));
    store = new StateStore(join(dir, "state.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSpawn(code: number) {
    const calls: { file: string; args: string[] }[] = [];
    const spawn = (file: string, args: string[]) => {
      calls.push({ file, args });
      return Promise.resolve(code);
    };
    return { spawn, calls };
  }

  function deps(spawn: SshSessionDeps["spawn"]): SshSessionDeps {
    return { spawn, knownHostsDir: join(dir, "kh.d") };
  }

  test("unknown vm: error + exit 1, never spawns", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runSsh(
      { target: "nope" }, store, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found in state: nope");
    expect(calls.length).toBe(0);
  });

  test("resolves by name, spawns ssh with the pinned interactive argv", async () => {
    const v = vm();
    store.upsert(v);
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runSsh(
      { target: "samo-field" }, store, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.file).toBe("ssh");
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
      "agent@178.105.246.151",
    );
    expect(calls[0]!.args).toContain("StrictHostKeyChecking=yes");
    // per-VM known_hosts file was ensured before connecting
    expect(existsSync(knownHostsPathFor(v, join(dir, "kh.d")))).toBe(true);
  });

  test("resolves by id and runs the trailing command as one argv element", async () => {
    const v = vm();
    store.upsert(v);
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runSsh(
      { target: v.id, remoteCommand: "uptime -p" },
      store, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe("uptime -p");
  });

  test("propagates the ssh exit code", async () => {
    store.upsert(vm());
    const { spawn } = fakeSpawn(130);
    const c = capture();
    const code = await runSsh(
      { target: "samo-field" }, store, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(130);
  });
});
