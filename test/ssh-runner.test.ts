import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSshArgs,
  ConnectionBudget,
  BudgetExceededError,
  ensureKnownHosts,
  recordHostKey,
  knownHostsPathFor,
  redact,
  runRemote,
  SshError,
} from "../src/ssh/runner.ts";
import type { VmRecord } from "../src/types.ts";

function vm(overrides: Partial<VmRecord> = {}): VmRecord {
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
    ...overrides,
  };
}

describe("buildSshArgs", () => {
  test("exact argv for a remote command", () => {
    const args = buildSshArgs(vm(), "/usr/bin/systemctl is-active fail2ban", {
      knownHostsDir: "/tmp/kh.d",
      controlDir: "/tmp/cm",
    });
    expect(args).toEqual([
      "-p",
      "2223",
      "-i",
      "/home/op/.ssh/id_ed25519",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/tmp/kh.d/11111111-2222-3333-4444-555555555555",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/tmp/cm/%C",
      "-o",
      "ControlPersist=60s",
      "agent@178.105.246.151",
      "/usr/bin/systemctl is-active fail2ban",
    ]);
  });

  test("the command is passed as a single argv element (no shell splitting)", () => {
    const args = buildSshArgs(vm(), "echo 'a b c' && id", {
      knownHostsDir: "/tmp/kh.d",
      controlDir: "/tmp/cm",
    });
    // last element is the whole command verbatim
    expect(args[args.length - 1]).toBe("echo 'a b c' && id");
  });
});

describe("known_hosts management", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-kh-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ensureKnownHosts creates a per-VM file with a marker, chmod 600", () => {
    const v = vm();
    const p = ensureKnownHosts(v, dir);
    expect(p).toBe(knownHostsPathFor(v, dir));
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain(v.id);
    expect(content).toContain(v.hostKeyFingerprint);
    // 0o600
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("ensureKnownHosts is idempotent (does not clobber recorded keys)", () => {
    const v = vm();
    ensureKnownHosts(v, dir);
    recordHostKey(v, "[178.105.246.151]:2223 ssh-ed25519 AAAAKEYLINE", dir);
    // calling again must preserve the appended key line
    ensureKnownHosts(v, dir);
    const content = readFileSync(knownHostsPathFor(v, dir), "utf8");
    expect(content).toContain("AAAAKEYLINE");
  });

  test("recordHostKey appends the host key line and keeps 600", () => {
    const v = vm();
    ensureKnownHosts(v, dir);
    recordHostKey(v, "[178.105.246.151]:2223 ssh-ed25519 AAAAKEYLINE", dir);
    const p = knownHostsPathFor(v, dir);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("[178.105.246.151]:2223 ssh-ed25519 AAAAKEYLINE");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("ConnectionBudget", () => {
  test("allows 2 attempts, blocks the 3rd within the window", () => {
    let now = 1000;
    const clock = () => now;
    const b = new ConnectionBudget({ clock });
    const id = "vm-x";
    b.consume(id); // 1
    b.consume(id); // 2
    expect(() => b.consume(id)).toThrow(BudgetExceededError);
  });

  test("allows again once the 600s window has slid past", () => {
    let now = 1_000_000;
    const clock = () => now;
    const b = new ConnectionBudget({ clock });
    const id = "vm-y";
    b.consume(id);
    b.consume(id);
    expect(() => b.consume(id)).toThrow(BudgetExceededError);
    // advance just under 600s — still blocked
    now += 599_000;
    expect(() => b.consume(id)).toThrow(BudgetExceededError);
    // cross 600s from the FIRST attempt — first drops out, room for one
    now += 2_000; // total 601s past first
    expect(() => b.consume(id)).not.toThrow();
  });

  test("budget is per-VM", () => {
    let now = 0;
    const b = new ConnectionBudget({ clock: () => now });
    b.consume("a");
    b.consume("a");
    // different VM unaffected
    expect(() => b.consume("b")).not.toThrow();
    expect(() => b.consume("b")).not.toThrow();
    expect(() => b.consume("a")).toThrow(BudgetExceededError);
  });

  test("the error mentions the fail2ban bantime risk (86400)", () => {
    const b = new ConnectionBudget({ clock: () => 0 });
    b.consume("z");
    b.consume("z");
    try {
      b.consume("z");
      throw new Error("expected BudgetExceededError");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as Error).message).toContain("86400");
    }
  });
});

describe("redact", () => {
  test("strips long base64 runs following secret-ish labels", () => {
    const secret = "A1b2C3d4".repeat(6); // 48 chars
    const text = `PASSWORD=${secret} and token: ${secret} ok`;
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("REDACTED");
  });

  test("leaves ordinary text alone", () => {
    const text = "fail2ban is active; ufw status: active";
    expect(redact(text)).toBe(text);
  });
});

describe("runRemote", () => {
  let khDir: string;
  beforeEach(() => {
    khDir = mkdtempSync(join(tmpdir(), "samohost-rr-"));
  });
  afterEach(() => {
    rmSync(khDir, { recursive: true, force: true });
  });

  function fakeSpawn(result: {
    code: number;
    stdout?: string;
    stderr?: string;
  }) {
    const calls: { args: string[] }[] = [];
    const spawn = (_file: string, args: string[]) => {
      calls.push({ args });
      return Promise.resolve({
        code: result.code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    };
    return { spawn, calls };
  }

  test("success: returns code 0 with stdout", async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: "active\n" });
    const res = await runRemote(vm(), "/usr/bin/systemctl is-active fail2ban", {
      spawn,
      clock: () => 0,
      knownHostsDir: khDir,
    });
    expect(res).toEqual({ code: 0, stdout: "active\n", stderr: "" });
    expect(calls.length).toBe(1);
    // command is the final argv element
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
      "/usr/bin/systemctl is-active fail2ban",
    );
  });

  test("exit 255 + Connection refused → typed banned-or-blocked, no retry", async () => {
    const { spawn, calls } = fakeSpawn({
      code: 255,
      stderr: "ssh: connect to host ... port 2223: Connection refused",
    });
    await expect(
      runRemote(vm(), "id", { spawn, clock: () => 0, knownHostsDir: khDir }),
    ).rejects.toMatchObject({ kind: "banned-or-blocked" });
    expect(calls.length).toBe(1); // never retried
  });

  test("exit 255 + Host key verification failed → hostkey-mismatch, no retry", async () => {
    const { spawn, calls } = fakeSpawn({
      code: 255,
      stderr: "Host key verification failed.",
    });
    await expect(
      runRemote(vm(), "id", { spawn, clock: () => 0, knownHostsDir: khDir }),
    ).rejects.toMatchObject({ kind: "hostkey-mismatch" });
    expect(calls.length).toBe(1);
  });

  test("other non-zero exit returns {code,stdout,stderr} (not thrown)", async () => {
    const { spawn } = fakeSpawn({ code: 3, stdout: "", stderr: "boom" });
    const res = await runRemote(vm(), "false", {
      spawn,
      clock: () => 0,
      knownHostsDir: khDir,
    });
    expect(res).toEqual({ code: 3, stdout: "", stderr: "boom" });
  });

  test("budget is consumed: third call in window throws BudgetExceededError", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const deps = { spawn, clock: () => 0, knownHostsDir: khDir };
    const v = vm();
    await runRemote(v, "id", deps);
    await runRemote(v, "id", deps);
    await expect(runRemote(v, "id", deps)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  test("SshError is the thrown type for connection failures", async () => {
    const { spawn } = fakeSpawn({
      code: 255,
      stderr: "Connection refused",
    });
    await expect(
      runRemote(vm(), "id", { spawn, clock: () => 0, knownHostsDir: khDir }),
    ).rejects.toBeInstanceOf(SshError);
  });
});
