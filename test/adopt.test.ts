import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/cli.ts";
import { runAdopt } from "../src/commands/adopt.ts";
import { StateStore } from "../src/state/store.ts";

const FP = "SHA256:" + "A".repeat(43);

const baseFlags = [
  "adopt",
  "--name",
  "samo-field",
  "--ip",
  "178.105.246.151",
  "--ssh-user",
  "agent",
  "--ssh-key",
  "/home/op/.ssh/id_ed25519",
  "--host-key-fingerprint",
  FP,
];

describe("parseArgs adopt", () => {
  test("minimal valid flags → parsed adopt command", () => {
    const cmd = parseArgs([...baseFlags]);
    if (cmd.kind !== "adopt") throw new Error("expected adopt");
    expect(cmd.input.name).toBe("samo-field");
    expect(cmd.input.ip).toBe("178.105.246.151");
    expect(cmd.input.sshPort).toBe(22); // default
    expect(cmd.input.sshUser).toBe("agent");
    expect(cmd.input.sshKey).toBe("/home/op/.ssh/id_ed25519");
    expect(cmd.input.hostKeyFingerprint).toBe(FP);
    expect(cmd.json).toBe(false);
  });

  test("all optional flags parsed", () => {
    const cmd = parseArgs([
      ...baseFlags,
      "--ssh-port",
      "2223",
      "--provider",
      "hetzner",
      "--provider-id",
      "srv-99",
      "--region",
      "nbg1",
      "--type",
      "cx22",
      "--json",
    ]);
    if (cmd.kind !== "adopt") throw new Error("expected adopt");
    expect(cmd.input.sshPort).toBe(2223);
    expect(cmd.input.provider).toBe("hetzner");
    expect(cmd.input.providerId).toBe("srv-99");
    expect(cmd.input.region).toBe("nbg1");
    expect(cmd.input.type).toBe("cx22");
    expect(cmd.json).toBe(true);
  });

  test("missing --name → UsageError", () => {
    const flags = baseFlags.filter(
      (_, i) => baseFlags[i] !== "--name" && baseFlags[i - 1] !== "--name",
    );
    expect(() => parseArgs(flags)).toThrow(/--name/);
  });

  test("missing --host-key-fingerprint → UsageError mentioning out-of-band", () => {
    const idx = baseFlags.indexOf("--host-key-fingerprint");
    const flags = [...baseFlags.slice(0, idx)];
    expect(() => parseArgs(flags)).toThrow(/host-key-fingerprint/);
    try {
      parseArgs(flags);
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain("out-of-band");
    }
  });

  test("missing --ssh-user / --ssh-key / --ip → UsageError", () => {
    for (const f of ["--ssh-user", "--ssh-key", "--ip"]) {
      const idx = baseFlags.indexOf(f);
      const flags = [
        ...baseFlags.slice(0, idx),
        ...baseFlags.slice(idx + 2),
      ];
      expect(() => parseArgs(flags)).toThrow(UsageError);
    }
  });

  test("invalid provider → UsageError", () => {
    expect(() =>
      parseArgs([...baseFlags, "--provider", "gcp"]),
    ).toThrow(/provider/);
  });
});

describe("runAdopt", () => {
  let dir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-adopt-"));
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

  const validInput = {
    name: "samo-field",
    ip: "178.105.246.151",
    sshPort: 2223,
    sshUser: "agent",
    sshKey: "/nonexistent/key",
    hostKeyFingerprint: FP,
  };

  test("happy path: writes an adopted record, prints a line", () => {
    const c = capture();
    const code = runAdopt(validInput, { json: false }, store, c.out, c.err);
    expect(code).toBe(0);
    const recs = store.list();
    expect(recs.length).toBe(1);
    const r = recs[0]!;
    expect(r.lifecycleState).toBe("adopted");
    expect(r.name).toBe("samo-field");
    expect(r.ip).toBe("178.105.246.151");
    expect(r.sshPort).toBe(2223);
    expect(r.sshUser).toBe("agent");
    expect(r.hostKeyFingerprint).toBe(FP);
    // id is a uuid
    expect(r.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(c.o).toContain("samo-field");
  });

  test("--json prints the raw record", () => {
    const c = capture();
    const code = runAdopt(validInput, { json: true }, store, c.out, c.err);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.o);
    expect(parsed.lifecycleState).toBe("adopted");
    expect(parsed.ip).toBe("178.105.246.151");
  });

  test("warns (not fails) when the ssh key file is missing", () => {
    const c = capture();
    const code = runAdopt(validInput, { json: false }, store, c.out, c.err);
    expect(code).toBe(0);
    expect(c.e.toLowerCase()).toContain("warning");
    expect(c.e).toContain("/nonexistent/key");
  });

  test("expands ~ in the ssh key path", () => {
    const c = capture();
    runAdopt(
      { ...validInput, sshKey: "~/.ssh/id_ed25519" },
      { json: false },
      store,
      c.out,
      c.err,
    );
    const r = store.list()[0]!;
    expect(r.sshKeyPath.startsWith("~")).toBe(false);
    expect(r.sshKeyPath).toContain(".ssh/id_ed25519");
  });

  test("rejects an invalid IP", () => {
    const c = capture();
    const code = runAdopt(
      { ...validInput, ip: "999.1.1.1" },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("error:");
    expect(store.list().length).toBe(0);
  });

  test("accepts a valid IPv6 address", () => {
    const c = capture();
    const code = runAdopt(
      { ...validInput, ip: "2001:db8::1" },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(0);
    expect(store.list()[0]!.ip).toBe("2001:db8::1");
  });

  test("rejects an out-of-range port", () => {
    const c = capture();
    expect(
      runAdopt(
        { ...validInput, sshPort: 70000 },
        { json: false },
        store,
        c.out,
        c.err,
      ),
    ).toBe(1);
    expect(
      runAdopt(
        { ...validInput, sshPort: 0 },
        { json: false },
        store,
        c.out,
        c.err,
      ),
    ).toBe(1);
    expect(store.list().length).toBe(0);
  });

  test("rejects a malformed fingerprint", () => {
    const c = capture();
    const code = runAdopt(
      { ...validInput, hostKeyFingerprint: "SHA256:short" },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("error:");
    expect(store.list().length).toBe(0);
  });

  test("rejects an MD5 (non-SHA256) fingerprint", () => {
    const c = capture();
    const code = runAdopt(
      {
        ...validInput,
        hostKeyFingerprint: "MD5:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
      },
      { json: false },
      store,
      c.out,
      c.err,
    );
    expect(code).toBe(1);
    expect(store.list().length).toBe(0);
  });
});
