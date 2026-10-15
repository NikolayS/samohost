import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { REMOTE_STAGED_SCRIPT_COMMAND } from "../src/ssh/script-command.ts";

describe("REMOTE_STAGED_SCRIPT_COMMAND", () => {
  test("a child that drains stdin cannot swallow later script phases", () => {
    const script = [
      "#!/bin/bash",
      "set -euo pipefail",
      "cat >/dev/null",
      "echo post-build-phase-ran",
    ].join("\n");

    const result = spawnSync("bash", ["-c", REMOTE_STAGED_SCRIPT_COMMAND], {
      encoding: "utf8",
      input: script,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("post-build-phase-ran");
    expect(result.stderr).toBe("");
  });
});
