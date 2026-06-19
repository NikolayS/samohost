import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  buildCiCleanupScript,
  buildRunnerHostPrepScript,
  DEFAULT_CI_PORTS,
  DEFAULT_HOOK_PATH,
  DEFAULT_RUNNER_HOME,
} from "../src/ci/runner-hook.ts";

/** Every generated script must at least be valid bash (`bash -n`). */
function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) {
    // Surface the parse error in the test failure output.
    console.error(res.stderr);
  }
  return res.status === 0;
}

function prep(o: Partial<Parameters<typeof buildRunnerHostPrepScript>[0]> = {}) {
  return buildRunnerHostPrepScript({
    sshUser: "agent",
    runnerHome: DEFAULT_RUNNER_HOME,
    hookDir: DEFAULT_HOOK_PATH,
    ciPorts: [...DEFAULT_CI_PORTS],
    ...o,
  });
}

describe("buildCiCleanupScript", () => {
  test("is valid bash", () => {
    expect(bashSyntaxOk(buildCiCleanupScript({ ciPorts: [3100] }))).toBe(true);
    expect(bashSyntaxOk(buildCiCleanupScript({ ciPorts: [3100, 3200] }))).toBe(
      true,
    );
  });

  test("deterministic: same inputs, byte-identical output", () => {
    expect(buildCiCleanupScript({ ciPorts: [3100] })).toBe(
      buildCiCleanupScript({ ciPorts: [3100] }),
    );
  });

  test("cleanup tolerates 'already gone' — set -uo pipefail, NOT set -e/-euo", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    expect(s).toContain("set -uo pipefail");
    expect(s).not.toContain("set -euo");
    // The shell directive (a line that IS a `set ...`, not a comment mentioning
    // one) must never enable errexit — a cleanup tolerates "already gone".
    const setLines = s
      .split("\n")
      .filter((l) => /^\s*set\s/.test(l));
    expect(setLines).toEqual(["set -uo pipefail"]);
    for (const l of setLines) expect(l).not.toMatch(/set -e\b/);
  });

  test("targets the CI port 3100 by default", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    expect(s).toContain("3100");
  });

  test("extra ports are included", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100, 3105] });
    expect(s).toContain("3100");
    expect(s).toContain("3105");
  });

  test("NEVER references fuser or lsof (the runner host lacks them)", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    expect(s).not.toMatch(/\b(fuser|lsof)\b/);
  });

  test("finds the listening PID with ss (no fuser/lsof), /proc/net/tcp fallback", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    expect(s).toContain("ss -ltnpH");
    expect(s).toContain("/proc/net/tcp");
  });

  test("every kill tolerates failure (|| true) and escalates kill -9", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    const killLines = s
      .split("\n")
      .filter((l) => /\bkill\b/.test(l) && !l.trim().startsWith("#"));
    expect(killLines.length).toBeGreaterThan(0);
    for (const l of killLines) expect(l).toMatch(/\|\|\s*true/);
    expect(s).toContain("kill -9");
  });

  test("reaps orphan CI webServers by signature but is GUARDED against the prod unit/User", () => {
    const s = buildCiCleanupScript({ ciPorts: [3100] });
    expect(s).toContain("pgrep -f");
    // The guard: never kill processes under the production app's systemd
    // unit/cgroup or the app's User — only strays.
    expect(s.toLowerCase()).toMatch(/cgroup|system\.slice|user/);
  });
});

describe("buildRunnerHostPrepScript", () => {
  test("is valid bash", () => {
    expect(bashSyntaxOk(prep())).toBe(true);
  });

  test("deterministic: same inputs, byte-identical output", () => {
    expect(prep()).toBe(prep());
  });

  test("installs the cleanup hook at the hook path with mode 0755", () => {
    const s = prep();
    expect(s).toContain("install -m 0755");
    expect(s).toContain(DEFAULT_HOOK_PATH);
  });

  test("embeds the cleanup script content (no fuser/lsof leaks through)", () => {
    const s = prep();
    expect(s).toContain("ss -ltnpH");
    expect(s).not.toMatch(/\b(fuser|lsof)\b/);
  });

  test("sets the runner job hooks idempotently in ${runnerHome}/.env", () => {
    const s = prep();
    expect(s).toContain("ACTIONS_RUNNER_HOOK_JOB_STARTED");
    expect(s).toContain("ACTIONS_RUNNER_HOOK_JOB_COMPLETED");
    // STARTED is written pointing at the installed hook path: the printf line
    // names the var and emits the hook path as its value.
    expect(s).toMatch(
      new RegExp(
        `printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\\\\n' '${DEFAULT_HOOK_PATH}'`,
      ),
    );
    // Idempotent write into the runner .env (grep -q ... || printf >>).
    expect(s).toContain(`${DEFAULT_RUNNER_HOME}/.env`);
    expect(s).toContain("grep -q '^ACTIONS_RUNNER_HOOK_JOB_STARTED='");
    expect(s).toMatch(/grep -q[\s\S]*?\|\|[\s\S]*?printf[\s\S]*?>>/);
  });

  test("render-only: samohost does not restart the runner — it prints operator follow-up", () => {
    const s = prep();
    // The script must NOT itself run a live restart; it tells the operator to.
    expect(s).not.toMatch(/^\s*systemctl restart/m);
    expect(s.toLowerCase()).toContain("restart");
  });

  test("exact-path sudo only; any sudoers grant is validated with visudo -cf", () => {
    const s = prep();
    if (/sudoers/.test(s)) {
      expect(s).toContain("visudo -cf");
    }
    // No bare `sudo systemctl` (issue #99 exact-path lesson).
    expect(s).not.toMatch(/sudo systemctl/);
  });

  test("honors custom ci ports and runner home", () => {
    const s = buildRunnerHostPrepScript({
      sshUser: "ghrunner",
      runnerHome: "/srv/runner",
      hookDir: "/opt/samohost-ci/clean-ci-ports.sh",
      ciPorts: [3100, 4000],
    });
    expect(s).toContain("/srv/runner/.env");
    expect(s).toContain("3100");
    expect(s).toContain("4000");
  });
});
