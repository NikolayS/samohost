import { describe, expect, test } from "bun:test";
import { parseEnvOutcome } from "../src/env/parse.ts";

const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;

describe("parseEnvOutcome", () => {
  test("all phases ok → ok", () => {
    const raw = [
      M("clone", "start"), "Cloning...", M("clone", "ok"),
      M("install", "start"), M("install", "ok"),
      M("health", "start"), M("health", "ok"),
    ].join("\n");
    expect(parseEnvOutcome(raw).outcome).toBe("ok");
  });

  test("a fail anywhere → failed", () => {
    const raw = [M("clone", "start"), M("clone", "ok"), M("build", "start"), M("build", "fail")].join("\n");
    expect(parseEnvOutcome(raw).outcome).toBe("failed");
  });

  test("dangling start (connection dropped) → incomplete", () => {
    const raw = [M("clone", "start"), M("clone", "ok"), M("install", "start")].join("\n");
    expect(parseEnvOutcome(raw).outcome).toBe("incomplete");
  });

  test("no markers at all → incomplete", () => {
    expect(parseEnvOutcome("ssh: connection closed").outcome).toBe("incomplete");
  });

  test("unknown phase names in log noise are ignored", () => {
    const raw = [M("bogus", "fail"), M("clone", "start"), M("clone", "ok")].join("\n");
    expect(parseEnvOutcome(raw).outcome).toBe("ok");
  });

  test("destroy phases parse too", () => {
    const raw = [
      M("unit-stop", "start"), M("unit-stop", "ok"),
      M("vhost-remove", "start"), M("vhost-remove", "ok"),
      M("db-drop", "start"), M("db-drop", "ok"),
      M("dir-remove", "start"), M("dir-remove", "ok"),
    ].join("\n");
    expect(parseEnvOutcome(raw).outcome).toBe("ok");
  });
});
