/**
 * Node deploy: a failed install, build or migrate rolls back to the previous
 * release when one exists (dist/ present before the deploy).
 *
 * The service was not restarted at that point and still runs the previous
 * release. Rollback restores the git checkout and dist/ (from dist.prev/, made
 * before install and build) and checks health without a restart, so the
 * previous release is also what a later restart starts. A first deploy (no
 * dist/ before it) keeps the plain failure. Migrations that ran are not undone.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import { nodeApp } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const PREVIOUS = "1111111111111111111111111111111111111111";
const TARGET = "5555555555555555555555555555555555555555";

function setup(failNpm: string, withPreviousRelease: boolean) {
  const sb = makeDeploySandbox({ headSha: PREVIOUS, failNpm });
  writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
  if (withPreviousRelease) {
    mkdirSync(join(sb.appDir, "dist"));
    writeFileSync(join(sb.appDir, "dist", "release.txt"), "previous\n");
  }
  const script = buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET, tag: "v20261122.2" });
  return { sb, script };
}

function lastReset(gitLog: string): string | undefined {
  return gitLog.split("\n").filter((l) => l.startsWith("reset --hard ")).pop();
}

describe("node deploy — rollback when install, build or migrate fails", () => {
  for (const failing of ["ci --include=dev", "run build", "run migrate"]) {
    test(`failed '${failing}' with a previous release: checkout and dist/ return to it, no restart`, () => {
      const { sb, script } = setup(failing, true);
      try {
        const res = sb.run(script);
        expect(res.status).toBe(1);
        expect(res.stdout).toContain("<<<SAMOHOST_PHASE:rollback:ok>>>");
        expect(lastReset(readFileSync(sb.gitLog, "utf8"))).toBe(`reset --hard ${PREVIOUS}`);
        expect(readFileSync(join(sb.appDir, "dist", "release.txt"), "utf8")).toBe("previous\n");
        // The running service was never stopped; rollback does not restart it.
        expect(existsSync(sb.sudoLog) ? readFileSync(sb.sudoLog, "utf8") : "").not.toContain("systemctl restart");
        // No release env file is written before the restart phase.
        expect(existsSync(join(sb.dir, "release.env"))).toBe(false);
      } finally {
        sb.cleanup();
      }
    });
  }

  test("a build that deleted dist/ and failed leaves a startable dist/ (restored from dist.prev/)", () => {
    const { sb, script } = setup("run build", true);
    try {
      sb.run(script);
      expect(existsSync(join(sb.appDir, "dist", "release.txt"))).toBe(true);
      expect(sb.npmCalls().some((c) => c.args === "run migrate")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  test("first deploy (no dist/ before it): plain failure, no rollback", () => {
    const { sb, script } = setup("run build", false);
    try {
      const res = sb.run(script);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:build:fail>>>");
      expect(res.stdout).not.toContain("<<<SAMOHOST_PHASE:rollback:");
      expect(lastReset(readFileSync(sb.gitLog, "utf8"))).toBe(`reset --hard ${TARGET}`);
    } finally {
      sb.cleanup();
    }
  });

  test("failed health check after a successful build still restarts the restored release", () => {
    const sb = makeDeploySandbox({ headSha: PREVIOUS, healthCode: "500" });
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
      mkdirSync(join(sb.appDir, "dist"));
      writeFileSync(join(sb.appDir, "dist", "release.txt"), "previous\n");
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(res.status).toBe(1);
      const restarts = readFileSync(sb.sudoLog, "utf8").split("\n").filter((l) => l.includes("systemctl restart"));
      expect(restarts.length).toBe(2); // the deploy's restart and the rollback's restart
      expect(readFileSync(join(sb.appDir, "dist", "release.txt"), "utf8")).toBe("previous\n");
    } finally {
      sb.cleanup();
    }
  });
});
