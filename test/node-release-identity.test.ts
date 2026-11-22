/**
 * Release identity of a node deploy.
 *
 * The build must receive SAMO_RELEASE_TAG and SAMO_RELEASE_SHA (the client
 * app template writes dist/build-info.json from them, and /version.json reads
 * that file), and each deploy writes them into the release env file that the
 * systemd unit loads, restoring the previous file on rollback.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const SHA = "3333333333333333333333333333333333333333";
const TAG = "v20261122.1";

describe("node deploy — release identity (executed with stubs)", () => {
  test("install and build receive the tag and sha; the release env file has them", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, "APP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
      const script = buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA, tag: TAG });
      const res = sb.run(script);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const build = sb.npmCalls().find((c) => c.args === "run build")!;
      expect(build.env.SAMO_RELEASE_TAG).toBe(TAG);
      expect(build.env.SAMO_RELEASE_SHA).toBe(SHA);
      expect(readFileSync(join(sb.dir, "release.env"), "utf8")).toBe(
        `SAMO_RELEASE_TAG=${TAG}\nSAMO_RELEASE_SHA=${SHA}\n`,
      );
    } finally {
      sb.cleanup();
    }
  });

  test("a deploy without a tag exports an empty tag and the sha", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA }));
      expect(res.status).toBe(0);
      const build = sb.npmCalls().find((c) => c.args === "run build")!;
      expect(build.env.SAMO_RELEASE_TAG).toBe("");
      expect(build.env.SAMO_RELEASE_SHA).toBe(SHA);
    } finally {
      sb.cleanup();
    }
  });

  test("failed health check: rollback restores the previous release env file", () => {
    const sb = makeDeploySandbox({ healthCode: "500" });
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
      const previous = "SAMO_RELEASE_TAG=v20261121.1\nSAMO_RELEASE_SHA=4444444444444444444444444444444444444444\n";
      writeFileSync(join(sb.dir, "release.env"), previous);
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA, tag: TAG }));
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:rollback:");
      expect(readFileSync(join(sb.dir, "release.env"), "utf8")).toBe(previous);
    } finally {
      sb.cleanup();
    }
  });

  test("failed health check on the first deploy removes the release env file it wrote", () => {
    const sb = makeDeploySandbox({ healthCode: "500" });
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:pw@127.0.0.1:5432/shop\n");
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: SHA, tag: TAG }));
      expect(res.status).toBe(1);
      expect(existsSync(join(sb.dir, "release.env"))).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  test("a tag that is not a plain tag name is refused for node deploys", () => {
    expect(() => buildDeployScript(nodeApp(), { sha: SHA, tag: "v1\nX=1" })).toThrow(/release tag/);
  });
});

describe("bootstrap — the unit loads the release env file", () => {
  test("optional second EnvironmentFile next to the runtime env file", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script).toContain("EnvironmentFile=/opt/shop/staging.env\nEnvironmentFile=-/opt/shop/release.env\n");
  });
});
