/**
 * Deploy in the build model (new layout with the root-owned step script on
 * the server): the deploy user fetches and resets the checkout, then runs
 * install, build, migrate, release and seed through `sudo <step script>`.
 * It runs no npm or app command itself. Rollback switches the release link
 * back. Without the step script the deploy keeps its previous behaviour.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDeployScript } from "../src/app/script.ts";
import { parseDeployOutcome } from "../src/app/parse.ts";
import { nodeApp } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const SHA = "5555555555555555555555555555555555555555";
const STEP = "/usr/local/lib/samohost/apps/shop/step";

function setup(o: { healthCode?: string; failStep?: string; withStep?: boolean; previousRelease?: boolean; seed?: boolean; stdinScript?: boolean; deployLocked?: boolean } = {}) {
  const sb = makeDeploySandbox({ healthCode: o.healthCode ?? "200" });
  writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:0a0b@127.0.0.1:5432/shop\n");
  writeFileSync(sb.migrateEnvFile, "DATABASE_URL=postgresql://shop_owner:0c0d@127.0.0.1:5432/shop\n");
  const stepLog = join(sb.dir, "steps.log");
  const step = join(sb.dir, "step");
  if (o.withStep !== false) {
    writeFileSync(step, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$1" >> ${JSON.stringify(stepLog)}`,
      // Repository code in a step could read its stdin.
      "cat >/dev/null",
      ...(o.failStep !== undefined ? [`if [[ "$1" == ${o.failStep} ]]; then exit 1; fi`] : []),
      // release and rollback as the real step script does them.
      `if [[ "$1" == release ]]; then mkdir -p ${JSON.stringify(join(sb.dir, "releases", "new"))}; if [[ -L ${JSON.stringify(join(sb.dir, "current"))} ]]; then ln -sfn "$(readlink ${JSON.stringify(join(sb.dir, "current"))})" ${JSON.stringify(join(sb.dir, "previous"))}; else rm -f ${JSON.stringify(join(sb.dir, "previous"))}; fi; rm -f ${JSON.stringify(join(sb.dir, "current"))}; ln -s releases/new ${JSON.stringify(join(sb.dir, "current"))}; fi`,
      `if [[ "$1" == rollback ]]; then if [[ ! -L ${JSON.stringify(join(sb.dir, "previous"))} ]]; then rm -f ${JSON.stringify(join(sb.dir, "current"))}; exit 3; fi; ln -sfn "$(readlink ${JSON.stringify(join(sb.dir, "previous"))})" ${JSON.stringify(join(sb.dir, "current"))}; fi`,
      "exit 0",
    ].join("\n") + "\n");
    chmodSync(step, 0o755);
  }
  if (o.previousRelease) {
    mkdirSync(join(sb.dir, "releases", "old"), { recursive: true });
    symlinkSync("releases/old", join(sb.dir, "current"));
  }
  if (o.deployLocked) writeFileSync(join(sb.dir, "deploy-locked"), "");
  const app = nodeApp({ appDir: sb.appDir, envFile: sb.envFile, ...(o.seed ? { seedCmd: "npm run seed" } : {}) });
  const text = buildDeployScript(app, { sha: SHA, tag: "v20261123.1" }).replaceAll(STEP, step);
  // The deploy script reaches the server on stdin (`bash -s`).
  const res = o.stdinScript
    ? (() => {
        const r = spawnSync("bash", ["-s"], { input: text, encoding: "utf8", env: { PATH: `${join(sb.dir, "bin")}:/usr/bin:/bin`, HOME: sb.dir } });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      })()
    : sb.run(text);
  const steps = existsSync(stepLog) ? readFileSync(stepLog, "utf8").trim().split("\n") : [];
  const sudo = existsSync(sb.sudoLog) ? readFileSync(sb.sudoLog, "utf8") : "";
  return { sb, res, steps, sudo, text };
}

describe("deploy: build model", () => {
  test("healthy deploy: the steps in order, no npm run by the deploy user, cleanup at the end", () => {
    const r = setup({ previousRelease: true });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "cleanup"]);
      expect(r.sb.npmCalls()).toEqual([]);
      expect(r.sudo).toContain("/usr/bin/systemctl restart shop");
      expect(r.res.stdout).toContain("<<<SAMOHOST_PHASE:release:ok>>>");
    } finally {
      r.sb.cleanup();
    }
  });

  test("release.env is written before install, so the build sees the release tag", () => {
    const r = setup();
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      const lines = r.sudo.split("\n");
      const tee = lines.findIndex((l) => l.startsWith("/usr/bin/tee ") && l.endsWith("release.env"));
      const install = lines.findIndex((l) => l.endsWith("/step install"));
      expect(tee).toBeGreaterThanOrEqual(0);
      expect(tee).toBeLessThan(install);
      expect(readFileSync(join(r.sb.dir, "release.env"), "utf8")).toBe(`SAMO_RELEASE_TAG=v20261123.1\nSAMO_RELEASE_SHA=${SHA}\n`);
    } finally {
      r.sb.cleanup();
    }
  });

  test("build fails with a previous release: no release switch, no restart, release.env restored", () => {
    const r = setup({ failStep: "build", previousRelease: true });
    try {
      expect(r.res.status).toBe(1);
      expect(r.steps).toEqual(["install", "build", "cleanup"]);
      expect(r.sudo).not.toContain("systemctl restart");
      expect(r.res.stdout).toContain("<<<SAMOHOST_PHASE:rollback:ok>>>");
      expect(readFileSync(join(r.sb.dir, "release.env"), "utf8")).toBe("");
    } finally {
      r.sb.cleanup();
    }
  });

  test("health fails after the release: the step script switches current back, the service restarts", () => {
    const r = setup({ healthCode: "500", previousRelease: true });
    try {
      expect(r.res.status).toBe(1);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "rollback", "cleanup"]);
      expect(r.sudo.split("\n").filter((l) => l === "/usr/bin/systemctl restart shop").length).toBe(2);
    } finally {
      r.sb.cleanup();
    }
  });

  test("script on stdin (bash -s): a step that reads its stdin cannot consume the rest of the deploy script", () => {
    const r = setup({ stdinScript: true, previousRelease: true });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "cleanup"]);
      expect(r.res.stdout).toContain("<<<SAMOHOST_PHASE:health:ok>>>");
    } finally {
      r.sb.cleanup();
    }
  });

  test("a second deploy of the app while one runs: fails fast, runs no step and no cleanup, records nothing", () => {
    const r = setup({ deployLocked: true, previousRelease: true });
    try {
      expect(r.res.status).toBe(1);
      expect(r.steps).toEqual([]);
      expect(r.res.stdout).toContain("<<<SAMOHOST_PHASE:lock:fail>>>");
      expect(r.res.stderr).toContain("another deploy of shop is running on this server");
      expect(r.res.stdout).not.toContain("SAMOHOST_PHASE:fetch");
      expect(r.text).toContain('exec 8>>"${HOME:?}/.samohost-deploy-shop.lock"');
    } finally {
      r.sb.cleanup();
    }
  });

  test("first deploy (no previous release) fails after the release: current removed, the service stopped (still enabled); outcome 'stopped'", () => {
    const r = setup({ healthCode: "500" });
    try {
      expect(r.res.status).toBe(1);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "rollback", "cleanup"]);
      const sudo = r.sudo.split("\n");
      expect(sudo.filter((l) => l === "/usr/bin/systemctl restart shop").length).toBe(1);
      expect(sudo).toContain("/usr/bin/systemctl stop shop");
      expect(sudo.some((l) => l.includes("disable"))).toBe(false);
      expect(existsSync(join(r.sb.dir, "current"))).toBe(false);
      expect(r.res.stdout).toContain("<<<SAMOHOST_PHASE:stop:ok>>>");
      expect(r.res.stderr).toContain("there is no previous release to roll back to; current was removed and the service shop was stopped");
      expect(r.res.stderr).not.toContain("step rollback failed");
      expect(parseDeployOutcome(r.res.stdout + r.res.stderr).outcome).toBe("stopped");
    } finally {
      r.sb.cleanup();
    }
  });

  test("health fails and the step rollback fails (previous release missing): the service is stopped", () => {
    const r = setup({ healthCode: "500", previousRelease: true, failStep: "rollback" });
    try {
      expect(r.res.status).toBe(1);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "rollback", "cleanup"]);
      expect(r.sudo.split("\n")).toContain("/usr/bin/systemctl stop shop");
      expect(r.res.stderr).toContain("step rollback failed (exit 1); the service shop was stopped; current still names the failed release");
      expect(r.res.stderr).not.toContain("no previous release");
      expect(parseDeployOutcome(r.res.stdout + r.res.stderr).outcome).toBe("stopped");
    } finally {
      r.sb.cleanup();
    }
  });

  test("seed runs through the step script after a healthy deploy", () => {
    const r = setup({ seed: true });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.steps).toEqual(["install", "build", "migrate", "release", "seed", "cleanup"]);
    } finally {
      r.sb.cleanup();
    }
  });

  test("the checkout is made readable for the build user before install", () => {
    const { text, sb } = setup();
    try {
      const repair = text.indexOf('find "$SAMOHOST_APP_DIR" -path "$SAMOHOST_APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} +');
      const install = text.indexOf('sudo "$SAMOHOST_STEP" install </dev/null');
      expect(repair).toBeGreaterThan(0);
      expect(repair).toBeLessThan(install);
    } finally {
      sb.cleanup();
    }
  });

  test("no step script on the server (older new-layout bootstrap): npm runs as before, no step calls", () => {
    const r = setup({ withStep: false });
    try {
      expect(r.res.status, r.res.stderr).toBe(0);
      expect(r.steps).toEqual([]);
      expect(r.sb.npmCalls().map((c) => c.args)).toContain("ci --include=dev");
    } finally {
      r.sb.cleanup();
    }
  });
});
