import { describe, expect, test } from "bun:test";
import { main, parseArgs, UsageError } from "../src/cli.ts";

const FAKE_KEY = "ssh-ed25519 AAAATESTKEY user@host";

/** A pubkey-file resolver that doesn't touch the filesystem. */
const fakeResolver = (path: string): string => `KEY-FROM:${path}`;

describe("parseArgs", () => {
  test("no args → help", () => {
    expect(parseArgs([]).kind).toBe("help");
  });

  test("--help / --version", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-h"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
    expect(parseArgs(["-v"]).kind).toBe("version");
  });

  test("preview minimal flags → defaulted ProvisionSpec", () => {
    const cmd = parseArgs(
      [
        "preview",
        "--provider",
        "hetzner",
        "--region",
        "nbg1",
        "--type",
        "cx22",
        "--ssh-pubkey",
        FAKE_KEY,
      ],
      fakeResolver,
    );
    if (cmd.kind !== "preview") throw new Error("expected preview");
    expect(cmd.spec.provider).toBe("hetzner");
    expect(cmd.spec.region).toBe("nbg1");
    expect(cmd.spec.type).toBe("cx22");
    expect(cmd.spec.sshPort).toBe(2223); // default
    expect(cmd.spec.adminUser).toBe("samo"); // default
    expect(cmd.spec.timeoutSec).toBe(600); // default
    expect(cmd.spec.name).toBe("samohost-hetzner"); // derived default
    expect(cmd.spec.modules).toEqual([]);
    expect(cmd.spec.trustedIps).toEqual([]);
    expect(cmd.sshPubkey).toBe(FAKE_KEY);
    expect(cmd.json).toBe(false);
  });

  test("repeatable --module and --trusted-ip, overrides", () => {
    const cmd = parseArgs(
      [
        "preview",
        "--provider",
        "aws",
        "--region",
        "eu-central-1",
        "--type",
        "t3.small",
        "--ssh-pubkey",
        FAKE_KEY,
        "--module",
        "postgres",
        "--module",
        "extra",
        "--trusted-ip",
        "203.0.113.7",
        "--trusted-ip",
        "198.51.100.4",
        "--ssh-port",
        "40022",
        "--admin-user",
        "dana",
        "--name",
        "demo",
        "--timeout",
        "900",
        "--json",
      ],
      fakeResolver,
    );
    if (cmd.kind !== "preview") throw new Error("expected preview");
    expect(cmd.spec.provider).toBe("aws");
    expect(cmd.spec.modules).toEqual(["postgres", "extra"]);
    expect(cmd.spec.trustedIps).toEqual(["203.0.113.7", "198.51.100.4"]);
    expect(cmd.spec.sshPort).toBe(40022);
    expect(cmd.spec.adminUser).toBe("dana");
    expect(cmd.spec.name).toBe("demo");
    expect(cmd.spec.timeoutSec).toBe(900);
    expect(cmd.json).toBe(true);
  });

  test("--ssh-pubkey @file is resolved via the reader", () => {
    const cmd = parseArgs(
      [
        "preview",
        "--provider",
        "hetzner",
        "--region",
        "nbg1",
        "--type",
        "cx22",
        "--ssh-pubkey",
        "@/path/to/key.pub",
      ],
      fakeResolver,
    );
    if (cmd.kind !== "preview") throw new Error("expected preview");
    expect(cmd.sshPubkey).toBe("KEY-FROM:/path/to/key.pub");
    expect(cmd.spec.sshKeyPath).toBe("/path/to/key.pub");
  });

  test("unknown command throws UsageError", () => {
    expect(() => parseArgs(["bogus"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() =>
      parseArgs(
        ["preview", "--provider", "hetzner", "--nope"],
        fakeResolver,
      ),
    ).toThrow(UsageError);
  });

  test("missing required flags throw UsageError", () => {
    expect(() => parseArgs(["preview"], fakeResolver)).toThrow(/provider/);
    expect(() =>
      parseArgs(
        ["preview", "--provider", "hetzner"],
        fakeResolver,
      ),
    ).toThrow(/region/);
  });

  test("invalid provider throws UsageError", () => {
    expect(() =>
      parseArgs(
        [
          "preview",
          "--provider",
          "gcp",
          "--region",
          "x",
          "--type",
          "y",
          "--ssh-pubkey",
          FAKE_KEY,
        ],
        fakeResolver,
      ),
    ).toThrow(/invalid --provider/);
  });

  test("non-integer --ssh-port throws UsageError", () => {
    expect(() =>
      parseArgs(
        [
          "preview",
          "--provider",
          "hetzner",
          "--region",
          "nbg1",
          "--type",
          "cx22",
          "--ssh-pubkey",
          FAKE_KEY,
          "--ssh-port",
          "abc",
        ],
        fakeResolver,
      ),
    ).toThrow(/integer/);
  });
});

describe("main (exit codes & output)", () => {
  async function capture(argv: string[]): Promise<{
    code: number;
    out: string;
    err: string;
  }> {
    let out = "";
    let err = "";
    const code = await main(
      argv,
      (s) => (out += s + "\n"),
      (s) => (err += s + "\n"),
    );
    return { code, out, err };
  }

  test("--version prints version, exit 0", async () => {
    const { code, out } = await capture(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("0.1.0");
  });

  test("--help prints usage, exit 0", async () => {
    const { code, out } = await capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  });

  test("unknown command → exit 2 with help on stderr", async () => {
    const { code, out, err } = await capture(["frobnicate"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("unknown command");
    expect(err).toContain("Usage:");
  });

  test("preview (yaml) → exit 0, renders cloud-init to stdout, no JSON", async () => {
    const { code, out, err } = await capture([
      "preview",
      "--provider",
      "hetzner",
      "--region",
      "nbg1",
      "--type",
      "cx22",
      "--ssh-pubkey",
      FAKE_KEY,
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("#cloud-config");
    expect(out).toContain("Port 2223");
    expect(out).toContain(FAKE_KEY);
  });

  test("preview --json → exit 0, parseable JSON envelope", async () => {
    const { code, out } = await capture([
      "preview",
      "--provider",
      "aws",
      "--region",
      "eu-central-1",
      "--type",
      "t3.small",
      "--ssh-pubkey",
      FAKE_KEY,
      "--trusted-ip",
      "203.0.113.7",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.provider).toBe("aws");
    expect(parsed.region).toBe("eu-central-1");
    expect(parsed.trustedIps).toEqual(["203.0.113.7"]);
    expect(typeof parsed.cloudInit).toBe("string");
    expect(parsed.cloudInit).toContain("#cloud-config");
  });

  test("preview with an unimplemented module → validation error, exit 1", async () => {
    // v0.1 scaffolds the postgres module interface but defers its
    // implementation; preview reports it as an unknown module rather than
    // silently emitting nothing.
    const { code, err } = await capture([
      "preview",
      "--provider",
      "aws",
      "--region",
      "eu-central-1",
      "--type",
      "t3.small",
      "--ssh-pubkey",
      FAKE_KEY,
      "--module",
      "postgres",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("unknown module: postgres");
  });

  test("preview with invalid port (22) → validation error, exit 1", async () => {
    const { code, err } = await capture([
      "preview",
      "--provider",
      "hetzner",
      "--region",
      "nbg1",
      "--type",
      "cx22",
      "--ssh-pubkey",
      FAKE_KEY,
      "--ssh-port",
      "22",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
  });
});

// ---------------------------------------------------------------------------
// parseDomainSearch — UsageError paths and --json flag (Finding 3)
// ---------------------------------------------------------------------------

describe("parseDomainSearch via parseArgs", () => {
  test("missing fqdn throws UsageError", () => {
    expect(() => parseArgs(["domain", "search"])).toThrow(UsageError);
    expect(() => parseArgs(["domain", "search"])).toThrow(
      "domain search requires <fqdn>",
    );
  });

  test("unknown flag throws UsageError", () => {
    expect(() =>
      parseArgs(["domain", "search", "--bad-flag"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["domain", "search", "--bad-flag"]),
    ).toThrow("unknown flag");
  });

  test("extra positional argument throws UsageError", () => {
    expect(() =>
      parseArgs(["domain", "search", "a.com", "b.com"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["domain", "search", "a.com", "b.com"]),
    ).toThrow("unexpected extra argument");
  });

  test("--json flag sets json:true in parsed result", () => {
    const cmd = parseArgs(["domain", "search", "a.com", "--json"]);
    expect(cmd.kind).toBe("domain-search");
    if (cmd.kind === "domain-search") {
      expect(cmd.json).toBe(true);
      expect(cmd.input.fqdn).toBe("a.com");
    }
  });

  test("without --json flag, json is false", () => {
    const cmd = parseArgs(["domain", "search", "example.com"]);
    expect(cmd.kind).toBe("domain-search");
    if (cmd.kind === "domain-search") {
      expect(cmd.json).toBe(false);
      expect(cmd.input.fqdn).toBe("example.com");
    }
  });
});
