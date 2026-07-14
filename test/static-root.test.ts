import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  staticReleaseStatePaths,
  validateStaticRoot,
} from "../src/app/static-root.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { parseArgs } from "../src/cli.ts";
import {
  buildCustomDomainVhostScript,
  buildEnvCreateScript,
  buildHostPrepScript,
} from "../src/env/script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildDeployScript } from "../src/app/script.ts";
import type { AppRecord } from "../src/types.ts";

function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-root",
    vmId: "vm-static-root",
    name: "astro-site",
    kind: "static",
    repo: "example/astro-site",
    branch: "main",
    appDir: "/opt/astro-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://astro-site.example.com/",
    serviceUnit: "astro-site",
    mainHost: "astro-site.example.com",
    ...overrides,
  };
}

function manifest(extra: string): string {
  return [
    'name = "astro-site"',
    'repo = "example/astro-site"',
    'branch = "main"',
    'appDir = "/opt/astro-site/app"',
    'buildCmd = "npm run build"',
    'healthUrl = "https://astro-site.example.com/"',
    'serviceUnit = "astro-site"',
    extra,
    "",
  ].join("\n");
}

describe("staticRoot schema and path security", () => {
  test("accepts normalized repo-relative output directories", () => {
    expect(validateStaticRoot("dist", "static")).toBe("dist");
    expect(validateStaticRoot(".vercel/output/static", "static")).toBe(
      ".vercel/output/static",
    );
    expect(validateStaticRoot(undefined, undefined)).toBeUndefined();
  });

  test("rejects empty, absolute, traversal, non-normalized, and injectable paths", () => {
    for (const value of [
      "",
      "/dist",
      "../dist",
      "dist/../public",
      ".",
      "dist//public",
      "dist/",
      "dist\\public",
      "dist public",
      "dist\npublic",
      'dist"; touch /tmp/pwned',
    ]) {
      expect(() => validateStaticRoot(value, "static"), value).toThrow();
    }
  });

  test("rejects staticRoot on node/default-kind apps", () => {
    expect(() => validateStaticRoot("dist", "node")).toThrow(/only valid/);
    expect(() => validateStaticRoot("dist", undefined)).toThrow(/only valid/);
  });

  test("TOML parses and persists a valid staticRoot, rejecting traversal and node use", () => {
    const valid = parseSamohostToml(manifest('kind = "static"\nstaticRoot = "dist"'));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.app.staticRoot).toBe("dist");

    const traversal = parseSamohostToml(
      manifest('kind = "static"\nstaticRoot = "../dist"'),
    );
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.errors.join("\n")).toMatch(/staticRoot/);

    const node = parseSamohostToml(manifest('kind = "node"\nstaticRoot = "dist"'));
    expect(node.ok).toBe(false);
    if (!node.ok) expect(node.errors.join("\n")).toMatch(/only valid/);
  });

  test("CLI accepts --static-root for static apps and fails closed otherwise", () => {
    const args = [
      "app", "register", "vm", "--name", "astro-site",
      "--repo", "example/astro-site", "--service-unit", "astro-site",
      "--health-url", "https://astro-site.example.com/",
    ];
    const parsed = parseArgs([...args, "--kind", "static", "--static-root", "dist"]);
    if (parsed.kind !== "app-register") throw new Error("expected app-register");
    expect(parsed.input.staticRoot).toBe("dist");
    expect(() => parseArgs([...args, "--static-root", "dist"])).toThrow(/only valid/);
    expect(() => parseArgs([
      ...args,
      "--kind", "static", "--static-root", "../dist",
    ])).toThrow(/staticRoot/);
  });

  test("preview, host-prep, and bootstrap route dist only after runtime containment checks", () => {
    const app = staticApp({ staticRoot: "dist", mainListen: "cp-http80" });
    const preview = buildEnvCreateScript(app, {
      name: "astro-site-pr-1",
      branch: "feature/one",
      port: 3100,
      vhost: "astro-site-pr-1.samo.cat",
      dbBackend: "none",
    });
    expect(preview).toContain('SAMOHOST_STATIC_ROOT=\'dist\'');
    expect(preview).toContain('root * %s');
    expect(preview).toContain('"$SAMOHOST_VHOST" "$SAMOHOST_STATIC_DIR"');
    expect(preview).toContain('"$SAMOHOST_STATIC_DIR/config.js"');
    expect(preview).toContain("staticRoot escapes the checkout");

    const hostPrep = buildHostPrepScript(app, "samo");
    expect(hostPrep).toContain('root * "${SAMOHOST_STATIC_DIR}"');
    expect(hostPrep).toContain("staticRoot escapes the checkout");

    const bootstrap = buildHostBootstrapScript(app, { appUser: "astro" });
    expect(bootstrap).toContain('root * "${SAMOHOST_STATIC_DIR}"');
    expect(bootstrap).toContain("staticRoot escapes the checkout");
    expect(bootstrap.indexOf("staticRoot escapes the checkout")).toBeGreaterThan(
      bootstrap.indexOf("# §12. Full token-safe repo clone"),
    );
  });

  test("every static activation rechecks the tree immediately around Caddy staging", () => {
    const app = staticApp({ staticRoot: "dist", mainListen: "cp-http80" });
    const guardCall =
      'samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"';

    const preview = buildEnvCreateScript(app, {
      name: "astro-site-pr-1",
      branch: "feature/one",
      port: 3100,
      vhost: "astro-site-pr-1.samo.cat",
      dbBackend: "none",
    });
    const previewConfig = preview.indexOf("SAMOHOST_CONFIG_NEXT=$(mktemp");
    const previewVhostWrite = preview.indexOf("&& printf '%s {", previewConfig);
    expect(preview.lastIndexOf(guardCall, previewConfig)).toBeGreaterThan(-1);
    expect(preview.indexOf(guardCall, previewConfig)).toBeGreaterThan(previewConfig);
    expect(preview.indexOf(guardCall, previewConfig)).toBeLessThan(previewVhostWrite);

    const hostPrep = buildHostPrepScript(app, "samo");
    const hostPrepStage = hostPrep.indexOf("cat > /etc/caddy/sites.d/.staged-00-main-astro-site.caddy");
    const hostPrepApply = hostPrep.indexOf("samohost_apply_main_vhost", hostPrepStage);
    expect(hostPrep.lastIndexOf(guardCall, hostPrepStage)).toBeGreaterThan(-1);
    expect(hostPrep.indexOf(guardCall, hostPrepStage)).toBeLessThan(hostPrepApply);

    const bootstrap = buildHostBootstrapScript(app, { appUser: "astro" });
    const bootstrapStage = bootstrap.lastIndexOf("SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=$(mktemp)");
    const bootstrapApply = bootstrap.indexOf(
      '/usr/bin/mv -f "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST"',
      bootstrapStage,
    );
    const bootstrapValidate = bootstrap.indexOf("caddy validate", bootstrapStage);
    expect(bootstrap.lastIndexOf(guardCall, bootstrapStage)).toBeGreaterThan(-1);
    expect(bootstrapApply).toBeGreaterThan(bootstrapStage);
    expect(bootstrap.indexOf(guardCall, bootstrapStage)).toBeLessThan(bootstrapValidate);

    const deploy = buildDeployScript({
      ...app,
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    }, {
      sha: "abc1234def5678901234567890abcdef12345678",
      tag: "v20260714.1",
    });
    const deployStage = deploy.lastIndexOf("sudo /usr/bin/tee '/etc/caddy/sites.d/.samohost-next-00-main-astro-site.caddy'");
    const deployActivate = deploy.indexOf("sudo /usr/bin/mv --", deployStage);
    const deployReload = deploy.indexOf("sudo /usr/bin/systemctl reload caddy", deployActivate);
    expect(deploy.lastIndexOf(guardCall.replace("CHECKOUT", "CANDIDATE"), deployStage)).toBeGreaterThan(-1);
    expect(deploy.indexOf(guardCall.replace("CHECKOUT", "CANDIDATE"), deployStage)).toBeLessThan(deployActivate);
    expect(deploy.lastIndexOf(guardCall.replace("CHECKOUT", "CANDIDATE"), deployReload)).toBeGreaterThan(deployActivate);
  });
});

type PreviewFixture = "clean" | "root-symlink" | "nested-file-symlink" | "nested-dir-symlink";

function runPreviewSandbox(fixture: PreviewFixture): {
  status: number | null;
  stderr: string;
  dir: string;
  envDir: string;
  snippet: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "samohost-static-root-preview-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const appDir = join(dir, "site", "app");
  const caddyDir = join(dir, "caddy");
  const binDir = join(dir, "bin");
  const envDir = join(dir, "site", "envs", "astro-site-pr-1");
  const snippet = join(caddyDir, "sites.d", "astro-site-pr-1.caddy");

  const git = (args: string[], cwd = dir): void => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };

  mkdirSync(seed);
  git(["init", "--bare", origin]);
  git(["init", "--initial-branch=main"], seed);
  git(["config", "user.name", "Samohost Test"], seed);
  git(["config", "user.email", "samohost@example.invalid"], seed);
  if (fixture === "root-symlink") {
    mkdirSync(join(seed, "real-dist"));
    writeFileSync(join(seed, "real-dist", "index.html"), "symlink target\n");
    symlinkSync("real-dist", join(seed, "dist"));
  } else {
    mkdirSync(join(seed, "dist"));
    writeFileSync(join(seed, "dist", "index.html"), "preview dist\n");
    if (fixture === "nested-file-symlink") {
      mkdirSync(join(seed, "dist", "assets"));
      symlinkSync("../index.html", join(seed, "dist", "assets", "alias.html"));
    }
    if (fixture === "nested-dir-symlink") {
      mkdirSync(join(seed, "dist", "real-assets"));
      writeFileSync(join(seed, "dist", "real-assets", "app.css"), "body {}\n");
      mkdirSync(join(seed, "dist", "nested"));
      symlinkSync("../real-assets", join(seed, "dist", "nested", "assets"));
    }
  }
  git(["add", "."], seed);
  git(["commit", "-m", "fixture"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);
  mkdirSync(join(dir, "site"));
  git(["clone", origin, appDir]);

  mkdirSync(join(caddyDir, "sites.d"), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(binDir, "sudo"), [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "/usr/bin/systemctl" ]]; then exit 0; fi',
    'exec "$@"',
    "",
  ].join("\n"));
  writeFileSync(join(binDir, "curl"), "#!/usr/bin/env bash\nprintf '200'\n");
  writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const command of ["sudo", "curl", "sleep"]) {
    chmodSync(join(binDir, command), 0o755);
  }

  const script = buildEnvCreateScript(staticApp({ appDir, staticRoot: "dist" }), {
    name: "astro-site-pr-1",
    branch: "main",
    port: 3100,
    vhost: "astro-site-pr-1.samo.cat",
    dbBackend: "none",
  }).replaceAll("/etc/caddy", caddyDir);
  const result = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
  });
  return { status: result.status, stderr: result.stderr, dir, envDir, snippet };
}

describe("staticRoot preview sandbox", () => {
  test("executed preview serves dist and writes preview identity inside dist", () => {
    const result = runPreviewSandbox("clean");
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(result.envDir, "dist", "index.html"), "utf8")).toBe(
        "preview dist\n",
      );
      expect(readFileSync(join(result.envDir, "dist", "config.js"), "utf8")).toContain(
        "preview: true",
      );
      expect(existsSync(join(result.envDir, "config.js"))).toBe(false);
      expect(readFileSync(result.snippet, "utf8")).toContain(
        `root * ${join(result.envDir, "dist")}`,
      );
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });

  test("executed preview rejects a staticRoot path symlink before Caddy activation", () => {
    const result = runPreviewSandbox("root-symlink");
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("staticRoot path contains a symlink");
      expect(existsSync(result.snippet)).toBe(false);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });

  for (const fixture of ["nested-file-symlink", "nested-dir-symlink"] as const) {
    test(`executed preview rejects a ${fixture} before Caddy activation`, () => {
      const result = runPreviewSandbox(fixture);
      try {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("staticRoot tree contains a symlink");
        expect(existsSync(result.snippet)).toBe(false);
      } finally {
        rmSync(result.dir, { recursive: true, force: true });
      }
    });
  }
});

type CustomDomainFixture =
  | "clean"
  | "root-symlink"
  | "nested-file-symlink"
  | "reload-failure";

function runCustomDomainSandbox(
  fixture: CustomDomainFixture,
  identity?: { tag: string; releaseTagFormat: string },
): {
  status: number | null;
  stderr: string;
  dir: string;
  appDir: string;
  snippet: string;
  activeRoute: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "samohost-static-root-domain-"));
  const appDir = join(dir, "site", "app");
  const releaseDir = join(dir, "site", "releases", "active-candidate");
  const caddyDir = join(dir, "caddy");
  const binDir = join(dir, "bin");
  const snippet = join(caddyDir, "sites.d", "10-domain-client-example.caddy");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  if (fixture === "root-symlink") {
    mkdirSync(join(releaseDir, "real-dist"));
    writeFileSync(join(releaseDir, "real-dist", "index.html"), "safe\n");
    symlinkSync("real-dist", join(releaseDir, "dist"));
  } else {
    mkdirSync(join(releaseDir, "dist"));
    writeFileSync(join(releaseDir, "dist", "index.html"), "safe\n");
    if (fixture === "nested-file-symlink") {
      symlinkSync("/etc/passwd", join(releaseDir, "dist", "leak.txt"));
    }
  }
  const git = (args: string[]): string => {
    const result = spawnSync("git", args, { cwd: releaseDir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Samohost Test"]);
  git(["config", "user.email", "samohost@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-m", "active candidate"]);
  const sha = git(["rev-parse", "HEAD"]);
  const tag = identity?.tag ?? sha;
  const staticDir = fixture === "root-symlink"
    ? join(releaseDir, "real-dist")
    : join(releaseDir, "dist");
  writeFileSync(join(staticDir, "version.json"), JSON.stringify({
    version: tag,
    tag,
    sha,
    environment: "production",
  }) + "\n");
  const activePaths = staticReleaseStatePaths(appDir);
  writeFileSync(activePaths.activeState, JSON.stringify({
    schema: 1,
    appName: "astro-site",
    sha,
    tag,
    releaseDir,
    staticRoot: "dist",
    releaseTagFormat: identity?.releaseTagFormat ?? null,
  }) + "\n");
  writeFileSync(
    activePaths.activeRoute,
    `root * "${staticDir}"\ntry_files {path} {path}/ =404\nfile_server\nencode gzip\n`,
  );
  mkdirSync(join(caddyDir, "sites.d"), { recursive: true });
  if (fixture === "reload-failure") {
    writeFileSync(snippet, "legacy route\n");
  }
  mkdirSync(binDir);
  writeFileSync(join(binDir, "sudo"), [
    "#!/usr/bin/env bash",
    `if [[ "\${1:-}" == "/usr/bin/systemctl" ]]; then exit ${fixture === "reload-failure" ? "1" : "0"}; fi`,
    'exec "$@"',
    "",
  ].join("\n"));
  chmodSync(join(binDir, "sudo"), 0o755);

  const app = staticApp({
    appDir,
    staticRoot: "dist",
    ...(identity === undefined
      ? {}
      : {
          releaseTagPattern: "v*",
          releaseCiWorkflow: ".github/workflows/ci.yml",
        }),
  });
  if (identity !== undefined) {
    (app as unknown as { releaseTagFormat: string }).releaseTagFormat =
      identity.releaseTagFormat;
  }
  const script = buildCustomDomainVhostScript(app, "client.example")
    .replaceAll("/etc/caddy", caddyDir);
  const result = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    dir,
    appDir,
    snippet,
    activeRoute: activePaths.activeRoute,
  };
}

describe("staticRoot custom-domain sandbox", () => {
  test("serves only the canonical staticRoot on a custom domain", () => {
    const result = runCustomDomainSandbox("clean");
    try {
      expect(result.status, result.stderr).toBe(0);
      const vhost = readFileSync(result.snippet, "utf8");
      expect(vhost).toContain(`import "${result.activeRoute}"`);
      expect(readFileSync(result.activeRoute, "utf8")).toContain(
        `root * "${join(result.dir, "site", "releases", "active-candidate", "dist")}"`,
      );
      expect(vhost).not.toContain(result.appDir);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });

  for (const fixture of ["root-symlink", "nested-file-symlink"] as const) {
    test(`rejects a ${fixture} before writing or activating the custom-domain vhost`, () => {
      const result = runCustomDomainSandbox(fixture);
      try {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          fixture === "root-symlink"
            ? "staticRoot path contains a symlink"
            : "staticRoot tree contains a symlink",
        );
        expect(existsSync(result.snippet)).toBe(false);
      } finally {
        rmSync(result.dir, { recursive: true, force: true });
      }
    });
  }

  test("reload failure restores an existing custom-domain snippet byte-for-byte", () => {
    const result = runCustomDomainSandbox("reload-failure");
    try {
      expect(result.status).toBe(1);
      expect(readFileSync(result.snippet, "utf8")).toBe("legacy route\n");
      expect(
        readdirSync(join(result.dir, "caddy", "sites.d")),
      ).toEqual(["10-domain-client-example.caddy"]);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });

  test("accepts a semver tag when the configured release-tag policy is non-date", () => {
    const result = runCustomDomainSandbox("clean", {
      tag: "v1.2.3",
      releaseTagFormat: "semver",
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(result.snippet, "utf8")).toContain(
        `import "${result.activeRoute}"`,
      );
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });
});
