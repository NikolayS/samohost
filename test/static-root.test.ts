import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateStaticRoot } from "../src/app/static-root.ts";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import { parseArgs } from "../src/cli.ts";
import { buildEnvCreateScript, buildHostPrepScript } from "../src/env/script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
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
    expect(preview).toContain('> "$SAMOHOST_STATIC_DIR/config.js"');
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
});

function runPreviewSandbox(symlinkEscape: boolean): {
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
  if (symlinkEscape) {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "index.html"), "outside\n");
    symlinkSync("../../../outside", join(seed, "dist"));
  } else {
    mkdirSync(join(seed, "dist"));
    writeFileSync(join(seed, "dist", "index.html"), "preview dist\n");
  }
  git(["add", "dist"], seed);
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
    const result = runPreviewSandbox(false);
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

  test("executed preview rejects a staticRoot symlink that escapes checkout", () => {
    const result = runPreviewSandbox(true);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("staticRoot escapes the checkout");
      expect(existsSync(result.snippet)).toBe(false);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });
});
