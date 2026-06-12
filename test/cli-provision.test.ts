/**
 * CLI parsing for `provision` and `destroy` (SPEC §4 CLI layer).
 *
 * Pure parser tests — no command execution, no network, no filesystem
 * (the --ssh-key path is resolved later, by the provision command itself).
 */

import { describe, expect, test } from "bun:test";
import { main, parseArgs, UsageError } from "../src/cli.ts";

function parse(argv: string[]) {
  return parseArgs(argv, () => "unused");
}

describe("parseArgs provision", () => {
  const BASE = [
    "provision",
    "--provider",
    "hetzner",
    "--region",
    "nbg1",
    "--type",
    "cx22",
    "--name",
    "vm1",
    "--ssh-key",
    "~/.ssh/id_ed25519",
  ];

  test("parses the full happy path with defaults", () => {
    const cmd = parse(BASE);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.provider).toBe("hetzner");
    expect(cmd.spec.region).toBe("nbg1");
    expect(cmd.spec.type).toBe("cx22");
    expect(cmd.spec.name).toBe("vm1");
    expect(cmd.sshKey).toBe("~/.ssh/id_ed25519");
    // Hardened defaults match preview/builder conventions.
    expect(cmd.spec.sshPort).toBe(2223);
    expect(cmd.spec.adminUser).toBe("samo");
    expect(cmd.spec.timeoutSec).toBe(600);
    expect(cmd.spec.modules).toEqual([]);
    expect(cmd.spec.trustedIps).toEqual([]);
    expect(cmd.json).toBe(false);
  });

  test("optional flags: --timeout, --ssh-port, --admin-user, --module, --trusted-ip, --json", () => {
    const cmd = parse([
      ...BASE,
      "--timeout",
      "120",
      "--ssh-port",
      "2200",
      "--admin-user",
      "ops",
      "--module",
      "postgres",
      "--trusted-ip",
      "203.0.113.7",
      "--json",
    ]);
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.timeoutSec).toBe(120);
    expect(cmd.spec.sshPort).toBe(2200);
    expect(cmd.spec.adminUser).toBe("ops");
    expect(cmd.spec.modules).toEqual(["postgres"]);
    expect(cmd.spec.trustedIps).toEqual(["203.0.113.7"]);
    expect(cmd.json).toBe(true);
  });

  test("--name defaults to samohost-<provider>", () => {
    const cmd = parse(BASE.filter((a, i) => !(a === "--name" || BASE[i - 1] === "--name")));
    if (cmd.kind !== "provision") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.spec.name).toBe("samohost-hetzner");
  });

  for (const missing of ["--provider", "--region", "--type", "--ssh-key"]) {
    test(`${missing} is required`, () => {
      const argv = BASE.filter(
        (a, i) => !(a === missing || BASE[i - 1] === missing),
      );
      expect(() => parse(argv)).toThrow(UsageError);
    });
  }

  test("--provider aws is rejected as deferred (Hetzner-only v0.1 provision)", () => {
    const argv = BASE.map((a) => (a === "hetzner" ? "aws" : a));
    expect(() => parse(argv)).toThrow(/deferred|hetzner/i);
  });

  test("unknown flags are usage errors", () => {
    expect(() => parse([...BASE, "--frobnicate"])).toThrow(UsageError);
  });
});

describe("parseArgs destroy", () => {
  test("destroy <vm> with defaults", () => {
    const cmd = parse(["destroy", "vm1"]);
    if (cmd.kind !== "destroy") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.input.target).toBe("vm1");
    expect(cmd.input.yes).toBe(false);
    expect(cmd.json).toBe(false);
  });

  test("--yes and --json", () => {
    const cmd = parse(["destroy", "vm1", "--yes", "--json"]);
    if (cmd.kind !== "destroy") throw new Error(`kind: ${cmd.kind}`);
    expect(cmd.input.yes).toBe(true);
    expect(cmd.json).toBe(true);
  });

  test("requires a target and rejects extras", () => {
    expect(() => parse(["destroy"])).toThrow(UsageError);
    expect(() => parse(["destroy", "a", "b"])).toThrow(UsageError);
    expect(() => parse(["destroy", "vm1", "--what"])).toThrow(UsageError);
  });
});

describe("help text", () => {
  test("documents provision and destroy", async () => {
    const out: string[] = [];
    const code = await main(["--help"], (s) => out.push(s), () => {});
    expect(code).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("samohost provision --provider hetzner");
    expect(help).toContain("--ssh-key");
    expect(help).toContain("samohost destroy <vm");
    expect(help).toContain("--yes");
  });
});
