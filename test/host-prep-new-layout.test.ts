/**
 * Previews of new-layout node apps are not designed yet, and host-prep
 * grants the operator user broad sudo rules for previews. Host-prep stops
 * before any change when the server shows the new layout (layout marker,
 * migrate.env, or the runtime user <app>-run). Bootstrap stops in the new
 * layout when host-prep rules for the app already exist (host-prep ran on a
 * fresh server first). Static apps and legacy-layout apps are not affected.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { buildHostPrepScript } from "../src/env/script.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

const HEADING = "# 0. New-layout node apps: no previews yet.";

function refusalBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(HEADING);
  expect(start, "refusal heading").toBeGreaterThan(0);
  const end = lines.findIndex((l, i) => i > start && l === "");
  return lines.slice(start, end).join("\n");
}

type Server = { marker?: string; migrateEnv?: boolean; runtimeUser?: boolean; envBody?: string };

function runRefusal(server: Server) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-prep-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), `#!/usr/bin/env bash\n[[ "$2" == shop-run ]] && exit ${server.runtimeUser ? 0 : 1}\nexit 1\n`);
    chmodSync(join(bin, "id"), 0o755);
    const base = join(dir, "opt-shop");
    const state = join(dir, "var-lib-samohost");
    mkdirSync(base);
    mkdirSync(join(state, "db-layout"), { recursive: true });
    if (server.marker !== undefined) writeFileSync(join(state, "db-layout", "shop"), server.marker);
    if (server.migrateEnv) writeFileSync(join(base, "migrate.env"), "DATABASE_URL=x\n");
    if (server.envBody !== undefined) writeFileSync(join(base, "staging.env"), server.envBody);
    const block = refusalBlock(buildHostPrepScript(nodeApp(), "samo"))
      .replaceAll("/opt/shop", base)
      .replaceAll("/var/lib/samohost", state);
    return spawnSync("bash", ["-c", `set -euo pipefail\n${block}\necho PASSED`], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("host-prep: new-layout node apps", () => {
  test("the check is the first step, before Caddy, sudoers and firewall changes", () => {
    const text = buildHostPrepScript(nodeApp(), "samo");
    const at = text.indexOf(HEADING);
    expect(at).toBeGreaterThan(text.indexOf("set -euo pipefail"));
    for (const later of ["mkdir -p /etc/caddy/sites.d", "/etc/sudoers.d/", "ufw "]) {
      const i = text.indexOf(later);
      if (i >= 0) expect(at).toBeLessThan(i);
    }
  });

  test("split layout marker: refused with a clear message", () => {
    const res = runRefusal({ marker: "split\n" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("new layout");
    expect(res.stderr).toContain("previews");
    expect(res.stdout).not.toContain("PASSED");
  });

  test("migrate.env present: refused", () => {
    expect(runRefusal({ migrateEnv: true }).status).toBe(1);
  });

  test("runtime user present: refused", () => {
    expect(runRefusal({ runtimeUser: true }).status).toBe(1);
  });

  test("legacy server (superuser DATABASE_URL, no migrate.env, no runtime user): continues", () => {
    const res = runRefusal({ envBody: "DATABASE_URL=postgresql://postgres:ab@127.0.0.1:5432/shop\n" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("PASSED");
  });

  test("server without any of the three signs: continues", () => {
    expect(runRefusal({}).status).toBe(0);
  });

  test("static apps: no check", () => {
    const text = buildHostPrepScript({ ...nodeApp(), kind: "static" as const }, "samo");
    expect(text).not.toContain(HEADING);
  });
});

describe("bootstrap: host-prep rules already present", () => {
  function run3b(layout: "split" | "legacy", withHostPrepRules: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "samohost-prep-boot-"));
    try {
      if (withHostPrepRules) writeFileSync(join(dir, "samohost-env-shop"), "# rules\n");
      const text = buildHostBootstrapScript(nodeApp(), nodeOpts());
      const lines = text.split("\n");
      const start = lines.findIndex((l) => l.startsWith("# §3b."));
      const end = lines.findIndex((l, i) => i > start && l.startsWith("# §4."));
      const body = lines
        .slice(start, end - 1)
        .join("\n")
        .replace(/^(\s*)SAMOHOST_DB_LAYOUT=\w+$/gm, `$1SAMOHOST_DB_LAYOUT=${layout}`)
        .replaceAll("/etc/sudoers.d/", `${dir}/`);
      return spawnSync("bash", ["-c", `set -euo pipefail\n${body}\necho PASSED`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("split layout with host-prep rules for the app: stops", () => {
    const res = run3b("split", true);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("samohost-env-shop");
  });

  test("split layout without host-prep rules, legacy layout with them: continues", () => {
    expect(run3b("split", false).status).toBe(0);
    expect(run3b("legacy", true).status).toBe(0);
  });
});
