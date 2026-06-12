import { describe, expect, test } from "bun:test";
import {
  deployOutcome,
  parseDeployOutcome,
  parsePhaseStream,
} from "../src/app/parse.ts";

function m(phase: string, status: string): string {
  return `<<<SAMOHOST_PHASE:${phase}:${status}>>>`;
}

describe("parsePhaseStream", () => {
  test("extracts ordered events from clean output", () => {
    const raw = [m("fetch", "start"), m("fetch", "ok"), m("build", "start")].join(
      "\n",
    );
    expect(parsePhaseStream(raw)).toEqual([
      { phase: "fetch", status: "start" },
      { phase: "fetch", status: "ok" },
      { phase: "build", status: "start" },
    ]);
  });

  test("ignores noise and unknown phase names interleaved with markers", () => {
    const raw = [
      "npm WARN deprecated foo@1.0.0",
      m("fetch", "start"),
      "added 412 packages in 9s",
      "<<<SAMOHOST_PHASE:bogusphase:ok>>>", // unknown phase → ignored
      m("fetch", "ok"),
      "some <<<SAMOHOST_PHASE: malformed marker here",
    ].join("\n");
    expect(parsePhaseStream(raw)).toEqual([
      { phase: "fetch", status: "start" },
      { phase: "fetch", status: "ok" },
    ]);
  });

  test("handles markers embedded mid-line", () => {
    const raw = `prefix ${m("restart", "ok")} suffix`;
    expect(parsePhaseStream(raw)).toEqual([{ phase: "restart", status: "ok" }]);
  });
});

describe("deployOutcome", () => {
  test("happy path → 'deployed'", () => {
    const events = parsePhaseStream(
      [
        m("fetch", "start"), m("fetch", "ok"),
        m("checkpoint", "start"), m("checkpoint", "ok"),
        m("checkout", "start"), m("checkout", "ok"),
        m("install", "start"), m("install", "ok"),
        m("build", "start"), m("build", "ok"),
        m("restart", "start"), m("restart", "ok"),
        m("health", "start"), m("health", "ok"),
        m("seed", "start"), m("seed", "ok"),
      ].join("\n"),
    );
    expect(deployOutcome(events)).toBe("deployed");
  });

  test("health fail then rollback ok → 'rolled-back'", () => {
    const events = parsePhaseStream(
      [
        m("build", "start"), m("build", "ok"),
        m("restart", "start"), m("restart", "ok"),
        m("health", "start"), m("health", "fail"),
        m("rollback", "ok"),
      ].join("\n"),
    );
    expect(deployOutcome(events)).toBe("rolled-back");
  });

  test("assert-rls fail then rollback fail → 'rollback-failed'", () => {
    const events = parsePhaseStream(
      [
        m("health", "start"), m("health", "ok"),
        m("assert-rls", "start"), m("assert-rls", "fail"),
        m("rollback", "fail"),
      ].join("\n"),
    );
    expect(deployOutcome(events)).toBe("rollback-failed");
  });

  test("phase fail with NO rollback marker → 'incomplete'", () => {
    const events = parsePhaseStream(
      [m("build", "start"), m("build", "fail")].join("\n"),
    );
    expect(deployOutcome(events)).toBe("incomplete");
  });

  test("stream cut off mid-phase (start, no terminal) → 'incomplete'", () => {
    const events = parsePhaseStream(
      [m("install", "start"), m("install", "ok"), m("build", "start")].join("\n"),
    );
    expect(deployOutcome(events)).toBe("incomplete");
  });

  test("pure garbage → 'deployed' (no failures, no pending starts)", () => {
    // Edge: empty event list means nothing failed and nothing is mid-flight.
    // parseDeployOutcome on raw garbage yields no events.
    const { events, outcome } = parseDeployOutcome("just some build noise\n");
    expect(events).toEqual([]);
    expect(outcome).toBe("deployed");
  });

  test("garbage interleaved with a real rollback is still detected", () => {
    const raw = [
      "npm ERR! build failed",
      m("build", "start"),
      "Error: tsc exited 2",
      m("build", "fail"),
      "rolling back now...",
      m("rollback", "ok"),
      "done",
    ].join("\n");
    expect(parseDeployOutcome(raw).outcome).toBe("rolled-back");
  });
});
