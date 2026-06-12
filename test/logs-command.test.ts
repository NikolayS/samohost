import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError, type ParsedCommand } from "../src/cli.ts";
import {
  buildLogsCommand,
  resolveLogsUnit,
  runLogs,
  DEFAULT_LOG_LINES,
} from "../src/commands/logs.ts";
import type { SshSessionDeps } from "../src/commands/ssh.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// Fixtures match the prod shapes persisted by adopt/provision (VmRecord) and
// `app register` (AppRecord = AppSpec + {id, vmId}) — see src/types.ts.
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

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "11111111-2222-3333-4444-555555555555",
    name: "field-record",
    repo: "owner/field-record",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://127.0.0.1:3000/api/version",
    serviceUnit: "field-record",
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

describe("parseArgs logs", () => {
  test("defaults: lines 100, no follow, no unit", () => {
    const cmd = parseArgs(["logs", "samo-field"]) as Extract<
      ParsedCommand,
      { kind: "logs" }
    >;
    expect(cmd.kind).toBe("logs");
    expect(cmd.input.target).toBe("samo-field");
    expect(cmd.input.unit).toBeUndefined();
    expect(cmd.input.lines).toBe(DEFAULT_LOG_LINES);
    expect(cmd.input.follow).toBe(false);
  });

  test("--unit, --lines, --follow", () => {
    const cmd = parseArgs([
      "logs", "samo-field", "--unit", "caddy", "--lines", "50", "--follow",
    ]) as Extract<ParsedCommand, { kind: "logs" }>;
    expect(cmd.input.unit).toBe("caddy");
    expect(cmd.input.lines).toBe(50);
    expect(cmd.input.follow).toBe(true);
  });

  test("missing vm is a usage error", () => {
    expect(() => parseArgs(["logs"])).toThrow(UsageError);
  });

  test("non-integer --lines is a usage error", () => {
    expect(() => parseArgs(["logs", "v", "--lines", "ten"])).toThrow(
      UsageError,
    );
  });

  test("non-positive --lines is a usage error", () => {
    expect(() => parseArgs(["logs", "v", "--lines", "0"])).toThrow(UsageError);
  });

  test("unknown flag is a usage error", () => {
    expect(() => parseArgs(["logs", "v", "--json"])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// buildLogsCommand — the exact granted sudo invocation (full path; the
// hardened hosts grant NOPASSWD on /usr/bin/journalctl, full path required)
// ---------------------------------------------------------------------------

describe("buildLogsCommand", () => {
  test("plain: sudo /usr/bin/journalctl -u <unit> -n <lines>", () => {
    expect(buildLogsCommand("field-record", 100, false)).toBe(
      "sudo /usr/bin/journalctl -u field-record -n 100",
    );
  });

  test("--follow appends -f", () => {
    expect(buildLogsCommand("caddy", 50, true)).toBe(
      "sudo /usr/bin/journalctl -u caddy -n 50 -f",
    );
  });

  test("template-instance unit names pass through", () => {
    expect(buildLogsCommand("field-record-env@feat-x.service", 10, false)).toBe(
      "sudo /usr/bin/journalctl -u field-record-env@feat-x.service -n 10",
    );
  });

  test("a unit name with shell metacharacters is rejected", () => {
    expect(() => buildLogsCommand("evil; rm -rf /", 10, false)).toThrow();
    expect(() => buildLogsCommand("a unit", 10, false)).toThrow();
    expect(() => buildLogsCommand("$(id)", 10, false)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveLogsUnit — single-app default, multi-app requires --unit
// ---------------------------------------------------------------------------

describe("resolveLogsUnit", () => {
  test("explicit --unit always wins", () => {
    expect(resolveLogsUnit([app()], "caddy")).toBe("caddy");
  });

  test("exactly one registered app: defaults to its serviceUnit", () => {
    expect(resolveLogsUnit([app({ serviceUnit: "field-record" })])).toBe(
      "field-record",
    );
  });

  test("zero apps: requires --unit", () => {
    expect(() => resolveLogsUnit([])).toThrow(/--unit/);
  });

  test("multiple apps: requires --unit and names the candidates", () => {
    const apps = [
      app({ id: "a1", name: "one", serviceUnit: "one" }),
      app({ id: "a2", name: "two", serviceUnit: "two" }),
    ];
    try {
      resolveLogsUnit(apps);
      throw new Error("expected resolveLogsUnit to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("--unit");
      expect(msg).toContain("one");
      expect(msg).toContain("two");
    }
  });
});

// ---------------------------------------------------------------------------
// runLogs — resolve vm + unit, spawn the pinned ssh with the journal command
// ---------------------------------------------------------------------------

describe("runLogs", () => {
  let dir: string;
  let store: StateStore;
  let apps: AppStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-logscmd-"));
    store = new StateStore(join(dir, "state.json"));
    apps = new AppStore(join(dir, "apps.json"));
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
    const code = await runLogs(
      { target: "nope", lines: 100, follow: false },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("VM not found in state: nope");
    expect(calls.length).toBe(0);
  });

  test("single registered app: journal command defaults to its serviceUnit", async () => {
    const v = vm();
    store.upsert(v);
    apps.upsert(app({ vmId: v.id, serviceUnit: "field-record" }));
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runLogs(
      { target: "samo-field", lines: 100, follow: false },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.file).toBe("ssh");
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
      "sudo /usr/bin/journalctl -u field-record -n 100",
    );
    expect(calls[0]!.args).toContain("StrictHostKeyChecking=yes");
  });

  test("apps on OTHER VMs do not count toward the single-app default", async () => {
    const v = vm();
    store.upsert(v);
    apps.upsert(app({ vmId: v.id, serviceUnit: "field-record" }));
    apps.upsert(app({ id: "x", vmId: "other-vm", name: "other", serviceUnit: "other" }));
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runLogs(
      { target: "samo-field", lines: 100, follow: false },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
      "sudo /usr/bin/journalctl -u field-record -n 100",
    );
  });

  test("multiple apps on the VM and no --unit: exit 1 naming candidates", async () => {
    const v = vm();
    store.upsert(v);
    apps.upsert(app({ vmId: v.id, name: "one", serviceUnit: "one" }));
    apps.upsert(app({ id: "a2", vmId: v.id, name: "two", serviceUnit: "two" }));
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runLogs(
      { target: "samo-field", lines: 100, follow: false },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(calls.length).toBe(0);
    expect(c.e).toContain("--unit");
    expect(c.e).toContain("one");
    expect(c.e).toContain("two");
  });

  test("--unit + --lines + --follow build the full command", async () => {
    const v = vm();
    store.upsert(v);
    const { spawn, calls } = fakeSpawn(0);
    const c = capture();
    const code = await runLogs(
      { target: v.id, unit: "caddy", lines: 25, follow: true },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
      "sudo /usr/bin/journalctl -u caddy -n 25 -f",
    );
  });

  test("propagates the ssh exit code", async () => {
    const v = vm();
    store.upsert(v);
    const { spawn } = fakeSpawn(7);
    const c = capture();
    const code = await runLogs(
      { target: v.id, unit: "caddy", lines: 100, follow: false },
      store, apps, deps(spawn), c.out, c.err,
    );
    expect(code).toBe(7);
  });
});
