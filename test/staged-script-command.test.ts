import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("keeps the staged script private without leaking its umask into execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-staged-script-"));
    try {
      const script = [
        "#!/bin/bash",
        "set -euo pipefail",
        "umask",
        'stat -c %a "$0"',
        'mkdir "$DIR/d"',
        'echo hi > "$DIR/d/f"',
      ].join("\n");

      const result = spawnSync(
        "bash",
        ["-c", `umask 022; ${REMOTE_STAGED_SCRIPT_COMMAND}`],
        {
          encoding: "utf8",
          input: script,
          env: { ...process.env, DIR: dir },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["0022", "700"]);
      expect(statSync(join(dir, "d")).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir, "d", "f")).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
