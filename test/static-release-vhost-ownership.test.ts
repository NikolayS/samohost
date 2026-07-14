import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildHostPrepScript } from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

function staticApp(releaseChannel: boolean): AppRecord {
  return {
    id: "app-static-release",
    vmId: "vm-static-release",
    name: "release-site",
    kind: "static",
    repo: "example/release-site",
    branch: "main",
    appDir: "/opt/release-site/app",
    buildCmd: "true",
    healthUrl: "http://127.0.0.1/",
    serviceUnit: "release-site",
    mainHost: "release-site.example.com",
    mainListen: "cp-http80",
    ...(releaseChannel
      ? {
        releaseTagPattern: "v*",
        releaseTagFormat: "date" as const,
        releaseCiWorkflow: ".github/workflows/ci.yml",
      }
      : {}),
  };
}

function bootstrapCaddySection(app: AppRecord): string {
  const script = buildHostBootstrapScript(app, { appUser: "agent" });
  const start = script.indexOf("# §9. Caddy base Caddyfile");
  const end = script.indexOf("# §9c. Firewall", start);
  if (start < 0 || end < 0) throw new Error("bootstrap Caddy section not found");
  return script.slice(start, end);
}

function hostPrepCaddySection(app: AppRecord, forceMainVhost: boolean): string {
  const script = buildHostPrepScript(app, "agent", {
    allowCfHttps: false,
    forceMainVhost,
  });
  const start = script.indexOf("# 1. Caddy:");
  const end = script.indexOf("\ninstall -d -m 755", start);
  if (start < 0 || end < 0) throw new Error("host-prep Caddy section not found");
  return script.slice(start, end);
}

function executeCaddySection(section: string, caddyDir: string, binDir: string): void {
  const sandboxed = section
    .replaceAll("/etc/caddy", caddyDir)
    .replaceAll("/usr/bin/systemctl", "systemctl");
  const result = spawnSync("bash", ["-s"], {
    input: `set -euo pipefail\n${sandboxed}\n`,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
  });
  if (result.status !== 0) {
    throw new Error(
      `sandboxed Caddy section failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

describe("static release-channel production vhost ownership", () => {
  test("regression: setup generators never render the mutable appDir production route", () => {
    const release = staticApp(true);
    const releaseScripts = [
      buildHostBootstrapScript(release, { appUser: "agent" }),
      buildHostPrepScript(release, "agent", { forceMainVhost: false }),
      buildHostPrepScript(release, "agent", { forceMainVhost: true }),
    ];
    for (const script of releaseScripts) {
      expect(script).not.toContain("root * /opt/release-site/app");
    }
    for (const script of releaseScripts.slice(1)) {
      expect(script).not.toContain("00-main-release-site.caddy");
      expect(script).toContain(
        "/usr/bin/tee /etc/caddy/.samohost-next-Caddyfile",
      );
      expect(script).toContain(
        "/usr/bin/mv -- /etc/caddy/.samohost-next-Caddyfile /etc/caddy/Caddyfile",
      );
      expect(script).toContain(
        "/usr/bin/rm -f /etc/caddy/.samohost-next-Caddyfile",
      );
    }
    expect(releaseScripts[0]).toContain("samohost-static-route-release-site");
    expect(releaseScripts[0]).not.toContain(
      "agent ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy",
    );
    expect(releaseScripts[0]).toContain("SAMOHOST_CADDY_INSTALLED_NOW=0");
    expect(releaseScripts[0]).toContain("SAMOHOST_CADDY_INSTALLED_NOW=1");

    // Branch-channel static apps bootstrap a canonical fresh route. After the
    // first healthy detached deploy, structured active state owns that route.
    const branch = staticApp(false);
    expect(buildHostBootstrapScript(branch, { appUser: "agent" })).toContain(
      "/etc/caddy/sites.d/00-main-release-site.caddy",
    );
    expect(buildHostPrepScript(branch, "agent")).toContain(
      "/etc/caddy/sites.d/00-main-release-site.caddy",
    );
  });

  test("executed setup creates no production vhost before the first release tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-release-vhost-empty-"));
    try {
      const caddyDir = join(dir, "caddy");
      const sitesDir = join(caddyDir, "sites.d");
      const binDir = join(dir, "bin");
      mkdirSync(sitesDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(caddyDir, "Caddyfile"), [
        ":80 {",
        "\troot * /usr/share/caddy",
        "\tfile_server",
        "}",
        "",
      ].join("\n"));
      writeFileSync(join(binDir, "caddy"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(binDir, "caddy"), 0o755);
      chmodSync(join(binDir, "systemctl"), 0o755);

      const app = staticApp(true);
      executeCaddySection(
        `SAMOHOST_CADDY_INSTALLED_NOW=1\n${bootstrapCaddySection(app)}`,
        caddyDir,
        binDir,
      );
      expect(readFileSync(join(caddyDir, "Caddyfile"), "utf8")).toBe([
        "# Caddy global options (ACME TLS — default).",
        "",
        "import sites.d/*.caddy",
        "",
      ].join("\n"));
      executeCaddySection(hostPrepCaddySection(app, false), caddyDir, binDir);
      executeCaddySection(hostPrepCaddySection(app, true), caddyDir, binDir);

      expect(existsSync(join(sitesDir, "00-main-release-site.caddy"))).toBe(false);
      expect(readdirSync(sitesDir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repeated setup preserves a GC-style legacy base route and one valid import", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-release-vhost-legacy-"));
    try {
      const caddyDir = join(dir, "caddy");
      const sitesDir = join(caddyDir, "sites.d");
      const binDir = join(dir, "bin");
      mkdirSync(sitesDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const legacyBase = [
        ":80 {",
        "\troot * /opt/release-site/site",
        "\ttry_files {path} /index.html",
        "\tfile_server",
        "}",
        "",
        "import sites.d/*.caddy # samohost",
        "",
      ].join("\n");
      const baseFile = join(caddyDir, "Caddyfile");
      writeFileSync(baseFile, legacyBase);
      writeFileSync(join(binDir, "caddy"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(binDir, "caddy"), 0o755);
      chmodSync(join(binDir, "systemctl"), 0o755);

      const app = staticApp(true);
      executeCaddySection(bootstrapCaddySection(app), caddyDir, binDir);
      executeCaddySection(bootstrapCaddySection(app), caddyDir, binDir);
      executeCaddySection(hostPrepCaddySection(app, true), caddyDir, binDir);

      const after = readFileSync(baseFile, "utf8");
      expect(after).toBe(legacyBase);
      expect(after.match(/^\s*import\s+(?:\/etc\/caddy\/)?sites\.d\/\*\.caddy(?:\s*#.*)?$/gm))
        .toHaveLength(1);
      expect(readdirSync(sitesDir)).toEqual([]);

      const validation = spawnSync("caddy", ["validate", "--config", baseFile], {
        encoding: "utf8",
      });
      expect(validation.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed bootstrap and forced host-prep preserve an activated versioned route byte-for-byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-release-vhost-live-"));
    try {
      const caddyDir = join(dir, "caddy");
      const sitesDir = join(caddyDir, "sites.d");
      const binDir = join(dir, "bin");
      mkdirSync(sitesDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(caddyDir, "Caddyfile"), "import sites.d/*.caddy\n");
      writeFileSync(join(binDir, "caddy"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(binDir, "caddy"), 0o755);
      chmodSync(join(binDir, "systemctl"), 0o755);

      const livePath = join(sitesDir, "00-main-release-site.caddy");
      const versionedRoute = [
        "http://release-site.example.com {",
        "\troot * \"/opt/release-site/releases/abc123.candidate.safe\"",
        "\ttry_files {path} /index.html",
        "\tfile_server",
        "\tencode gzip",
        "}",
        "",
      ].join("\n");
      writeFileSync(livePath, versionedRoute);

      const app = staticApp(true);
      executeCaddySection(bootstrapCaddySection(app), caddyDir, binDir);
      expect(readFileSync(livePath, "utf8")).toBe(versionedRoute);
      executeCaddySection(hostPrepCaddySection(app, false), caddyDir, binDir);
      expect(readFileSync(livePath, "utf8")).toBe(versionedRoute);
      executeCaddySection(hostPrepCaddySection(app, true), caddyDir, binDir);
      expect(readFileSync(livePath, "utf8")).toBe(versionedRoute);

      expect(readdirSync(sitesDir).filter((name) =>
        name.includes("staged") || name.includes(".bak."),
      )).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
