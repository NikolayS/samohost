/**
 * TDD RED tests: per-env generated secrets (PR-B).
 *
 * Covers:
 *   1. secrets.env generated with exactly the declared names, mode 0600, owned by env user
 *   2. REBUILD REUSE: second run reuses existing values; only missing names are generated
 *   3. Unit template has EnvironmentFile=.../secrets.env — NO inline Environment= secret
 *   4. Leak-regression: generated secret VALUES never appear in rendered systemd unit,
 *      Caddy vhost, apps.json/state, or CLI stdout/env-create output
 *   5. `env secrets rotate` produces new values + restarts units
 *   6. Onboard threads ALL AppSpec fields (retention test for services/routes/secrets/
 *      databaseUrlEnv/releaseTagPattern/mainListen/defaultListener)
 *   7. LEGACY app with empty/no secrets[] → no secrets.env written, unit byte-identical to today
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvCreateScript,
  buildHostPrepScript,
  buildSecretsRotateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import { runOnboard, type OnboardDeps, type OnboardInput } from "../src/commands/onboard.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import { parseArgs } from "../src/cli.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-sec-1",
    vmId: "vm-sec-1",
    name: "acme-app",
    repo: "acme-org/acme-app",
    branch: "main",
    appDir: "/opt/acme-app/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "acme-app",
    appUser: "acme-user",
    ...o,
  };
}

function target(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "acme-app-feat-x",
    branch: "feat/x",
    port: 3100,
    vhost: "acme-app-feat-x.samo.cat",
    dbBackend: "none",
    ...o,
  };
}

/** Bash syntax-check helper (same pattern as env-script.test.ts). */
function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) console.error(res.stderr);
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// 1. env-create with secrets[] — script structure
// ---------------------------------------------------------------------------

describe("buildEnvCreateScript with secrets", () => {
  test("is valid bash when app.secrets is declared", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("values generated on-VM via openssl — env-create calls the helper with secret names", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // Generation delegates to the samohost-secrets helper (installed by host-prep).
    // The helper uses openssl rand -hex 32 on the VM — never in TS or in this script.
    expect(s).toContain("samohost-secrets");
    // Secret names must appear as arguments to the helper call.
    expect(s).toContain("SESSION_SECRET");
    expect(s).toContain("TOKEN_SECRET");
    // No hardcoded 64-char hex (values are never in this generated script).
    expect(s).not.toMatch(/[0-9a-f]{64}/);
  });

  test("env-create passes the env name to the helper (helper creates the secrets dir)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target({ name: "acme-app-feat-x" }),
    );
    // The env name is passed as the first arg to the helper; the helper
    // constructs /var/lib/samohost/envs/<env-name>/ internally.
    expect(s).toContain("samohost-secrets");
    expect(s).toContain("acme-app-feat-x");
  });

  test("creates secrets.env with mode 0600 (handled inside the helper)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // Mode 0600 and ownership are enforced by the helper; env-create passes the
    // env-user as an arg.  The script must reference the helper init action.
    expect(s).toContain("samohost-secrets");
    expect(s).toContain("init");
  });

  test("secrets.env is owned by the env user (appUser passed to helper)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"], appUser: "acme-user" }),
      target(),
    );
    // The appUser must appear in the helper call (second positional arg).
    expect(s).toContain("acme-user");
    expect(s).toContain("samohost-secrets");
  });

  test("REBUILD REUSE: env-create uses 'init' action (helper skips names that already exist)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // The 'init' helper action contains the grep-check-then-generate reuse logic.
    // Verify secret names appear as args; helper is called with 'init'.
    expect(s).toContain("SESSION_SECRET");
    expect(s).toContain("TOKEN_SECRET");
    expect(s).toContain("init");
    // Confirm no unconditional raw generation in this script (would bypass reuse).
    expect(s).not.toMatch(/openssl rand -hex 32/);
  });

  test("secret values are never echoed to stdout (no cat/echo of file contents)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // The script must never cat the secrets file — that would leak all values.
    expect(s).not.toMatch(/cat .*secrets\.env/);
    // Error messages may reference the file PATH but must never pipe/print its CONTENTS.
    // Allow echo of the path (preflight error message) but forbid reading its contents.
    expect(s).not.toMatch(/echo \$\(cat .*secrets/);
    expect(s).not.toMatch(/cat .*secrets.*echo/);
  });

  test("no inline Environment= lines in env-create script for secrets (values must live only in secrets.env)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // systemd inline Environment=NAME=VALUE leaks via `systemctl cat` — forbidden.
    expect(s).not.toMatch(/^Environment=SESSION_SECRET=/m);
    expect(s).not.toMatch(/^Environment=TOKEN_SECRET=/m);
  });

  test("env-create script has a phase marker for secrets generation", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // There must be a phase marker so the caller can parse progress.
    expect(s).toContain("secrets");
  });
});

// ---------------------------------------------------------------------------
// 2. buildHostPrepScript — unit template with EnvironmentFile for secrets
// ---------------------------------------------------------------------------

describe("buildHostPrepScript unit template with secrets", () => {
  test("unit template includes EnvironmentFile for secrets.env when app.secrets is non-empty", () => {
    const s = buildHostPrepScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      "samo",
    );
    expect(s).toContain("EnvironmentFile=");
    expect(s).toContain("secrets.env");
    // Path must use the /var/lib/samohost prefix and the %i instance specifier.
    expect(s).toContain("/var/lib/samohost/envs/%i/secrets.env");
  });

  test("unit template EnvironmentFile for secrets.env uses - prefix (optional) or present alongside .env", () => {
    const s = buildHostPrepScript(
      app({ secrets: ["SESSION_SECRET"] }),
      "samo",
    );
    // The secrets.env EnvironmentFile line in the unit must be listed.
    // Using -/path makes it optional (no unit-start failure for legacy envs).
    const secretsEFLine = s
      .split("\n")
      .find((l) => l.includes("secrets.env") && l.includes("EnvironmentFile"));
    expect(secretsEFLine).toBeDefined();
  });

  test("unit template has NO inline Environment=NAME=VALUE for declared secrets", () => {
    const s = buildHostPrepScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      "samo",
    );
    // The unit template must NEVER have inline Environment= for secret names —
    // that would expose values via `systemctl cat`.
    expect(s).not.toMatch(/^Environment=SESSION_SECRET=/m);
    expect(s).not.toMatch(/^Environment=TOKEN_SECRET=/m);
  });

  test("LEGACY app (no secrets) — unit template byte-identical to baseline (no extra EnvironmentFile)", () => {
    const baseline = buildHostPrepScript(app(), "samo");
    const withEmptySecrets = buildHostPrepScript(app({ secrets: [] }), "samo");
    const withoutSecrets = buildHostPrepScript(app({ secrets: undefined }), "samo");
    // Both empty and absent secrets[] must produce exactly the same output as today.
    expect(withEmptySecrets).toBe(baseline);
    expect(withoutSecrets).toBe(baseline);
    // And the baseline must NOT contain a secrets.env EnvironmentFile line.
    expect(baseline).not.toContain("secrets.env");
  });

  test("unit template is valid bash when secrets are declared", () => {
    const s = buildHostPrepScript(
      app({ secrets: ["SESSION_SECRET"] }),
      "samo",
    );
    expect(bashSyntaxOk(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Leak-regression: secret VALUES never appear outside secrets.env
// ---------------------------------------------------------------------------

describe("leak-regression: secret values are confined to secrets.env", () => {
  test("rendered systemd unit file body in host-prep does NOT contain actual secret values", () => {
    // The unit template is written by host-prep. It must never contain values —
    // only EnvironmentFile= references. An inline Environment=NAME=value leaks
    // via `systemctl cat` (world-readable on any host that uses journald).
    const s = buildHostPrepScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      "samo",
    );
    // There must be no `Environment=SECRET_NAME=<anything>` pattern.
    expect(s).not.toMatch(/Environment=SESSION_SECRET=[^\s]/);
    expect(s).not.toMatch(/Environment=TOKEN_SECRET=[^\s]/);
    // EnvironmentFile= is OK (reference, not value).
    // Verify it IS present (belt-and-suspenders confirming the reference path).
    expect(s).toContain("EnvironmentFile=");
  });

  test("env-create script does not embed any generated secret values inline", () => {
    // The create script generates values ON THE HOST (openssl rand -hex 32).
    // The TS side never touches values — they are generated and written in bash.
    // This test verifies that the generated bash does NOT contain hardcoded hex
    // values that look like generated secrets.
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // No hex string of length 64 (openssl rand -hex 32 output) should appear as a
    // hardcoded value in the TS-generated bash.
    expect(s).not.toMatch(/[0-9a-f]{64}/);
  });

  test("Caddy vhost in env-create does not contain secret names as inline values", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // The Caddy vhost snippet must not include secret env-var values.
    // It should only contain routing directives.
    expect(s).not.toMatch(/SESSION_SECRET=[^\s]/);
    expect(s).not.toMatch(/TOKEN_SECRET=[^\s]/);
  });
});

// ---------------------------------------------------------------------------
// 4. buildSecretsRotateScript
// ---------------------------------------------------------------------------

describe("buildSecretsRotateScript", () => {
  test("is exported from src/env/script.ts", () => {
    // This import at the top of the file already tests this: if it's not
    // exported, the import would fail and all tests in this file would error.
    expect(typeof buildSecretsRotateScript).toBe("function");
  });

  test("is valid bash", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("generates fresh values for ALL declared secret names (no reuse on rotate)", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // Rotate always regenerates — uses the helper 'rotate' action which does
    // rm-then-recreate (no reuse). Values generated on-VM via openssl inside helper.
    expect(s).toContain("SESSION_SECRET");
    expect(s).toContain("TOKEN_SECRET");
    expect(s).toContain("samohost-secrets");
    expect(s).toContain("rotate");
    // No openssl in the rotate script itself (it's inside the helper).
    expect(s).not.toContain("openssl rand -hex 32");
    // No conditional grep-then-skip in the rotate script (no reuse on rotate).
    expect(s).not.toMatch(/grep.*SESSION_SECRET.*secrets\.env.*then.*skip/s);
  });

  test("restarts all env unit instances after writing new secrets", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"], serviceUnit: "acme-app" }),
      target({ name: "acme-app-feat-x" }),
    );
    // Must restart the env's unit(s) — using disable+enable pattern (no bare
    // restart grant exists on adopted hosts).
    expect(s).toContain("acme-app@acme-app-feat-x.service");
    expect(s).toMatch(/systemctl.*disable.*--now|disable.*systemctl/);
    expect(s).toMatch(/systemctl.*enable.*--now|enable.*systemctl/);
  });

  test("uses full-path sudo for systemctl (exact-path grant pattern)", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // Never bare `sudo systemctl` — always `sudo /usr/bin/systemctl`.
    expect(s).not.toMatch(/sudo systemctl /);
    expect(s).toContain("sudo /usr/bin/systemctl");
  });

  test("writes secrets.env with mode 0600 (delegated to helper rotate action)", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // File creation at 0600 is performed by the helper rotate action internally.
    // Verify the rotate script calls the helper with the 'rotate' action.
    expect(s).toContain("samohost-secrets");
    expect(s).toContain("rotate");
  });

  test("no secret values appear in the rotate script (values generated on VM only)", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET", "TOKEN_SECRET"] }),
      target(),
    );
    // The TS-generated bash must never contain hardcoded 64-char hex secrets.
    expect(s).not.toMatch(/[0-9a-f]{64}/);
    // No inline Environment= leaks.
    expect(s).not.toMatch(/Environment=SESSION_SECRET=[^\s]/);
    expect(s).not.toMatch(/Environment=TOKEN_SECRET=[^\s]/);
  });
});

// ---------------------------------------------------------------------------
// 5. env secrets rotate — CLI command wiring
// ---------------------------------------------------------------------------

describe("env secrets rotate CLI", () => {
  test("parseArgs recognizes 'env secrets rotate <vm> <app> <branch>'", () => {
    const cmd = parseArgs(["env", "secrets", "rotate", "my-vm", "my-app", "feat/x"]);
    expect(cmd.kind).toBe("env-secrets-rotate");
    if (cmd.kind === "env-secrets-rotate") {
      expect(cmd.input.vm).toBe("my-vm");
      expect(cmd.input.app).toBe("my-app");
      expect(cmd.input.branch).toBe("feat/x");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Onboard field threading — ALL AppSpec fields must be retained
// ---------------------------------------------------------------------------

describe("onboard threads ALL AppSpec fields into registration", () => {
  let tmpDir: string;
  let vmStore: StateStore;
  let appStore: AppStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "samohost-onboard-threading-"));
    vmStore = new StateStore(join(tmpDir, "state.json"));
    appStore = new AppStore(join(tmpDir, "apps.json"));
    vmStore.upsert({
      id: "vm-thread-1",
      provider: "hetzner",
      providerId: "999010",
      name: "samo-we-acme",
      ip: "10.0.0.1",
      sshKeyPath: "/home/fixture/.ssh/id_ed25519",
      sshPort: 2223,
      sshUser: "agent",
      hostKeyFingerprint: "SHA256:" + "T".repeat(43),
      region: "nbg1",
      type: "cx22",
      modules: [],
      lifecycleState: "adopted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as VmRecord);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const FULL_TOML = `
name        = "acme-app"
repo        = "acme-org/acme-app"
branch      = "main"
appDir      = "/opt/acme-app/app"
buildCmd    = "npm run build"
healthUrl   = "http://127.0.0.1:3000/api/version"
serviceUnit = "acme-app"
releaseTagPattern = "v*"
releaseTagFormat = "date"
releaseCiWorkflow = ".github/workflows/ci.yml"
secrets     = ["SESSION_SECRET", "TOKEN_SECRET"]
databaseUrlEnv = "DATABASE_URL"
defaultListener = "web"
mainListen = "tls"

[[services]]
name = "web"
unit = "acme-app"

[[services.listeners]]
name    = "web"
port    = 3000
portEnv = "PORT"
healthPath = "/api/version"

[[routes]]
matchPath = "/api/*"
to = "web"
`.trim();

  function fakeDeps(): OnboardDeps {
    return {
      fetchRepoFile: async (_repo, path) => {
        if (path === ".samohost.toml") return FULL_TOML;
        return null;
      },
      getDefaultBranch: async () => "main",
      branchExists: async () => true,
      createBranch: async () => {},
      scaffoldFile: async () => {},
      findPr: async () => "https://github.com/acme-org/acme-app/pull/1",
      createPr: async () => "https://github.com/acme-org/acme-app/pull/1",
    };
  }

  test("onboarded app RETAINS secrets and databaseUrlEnv", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-app", vm: "samo-we-acme" };
    const report = await runOnboard(
      input, deps, vmStore, appStore, () => {}, () => {},
    );

    expect(report.appRegistered).toBe(true);
    const rec = appStore.get("vm-thread-1", "acme-app");
    expect(rec).toBeDefined();
    expect(rec!.secrets).toEqual(["SESSION_SECRET", "TOKEN_SECRET"]);
    expect(rec!.databaseUrlEnv).toBe("DATABASE_URL");
  });

  test("onboarded app RETAINS releaseTagPattern", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-app", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-thread-1", "acme-app");
    expect(rec).toBeDefined();
    expect(rec!.releaseTagPattern).toBe("v*");
  });

  test("onboarded app RETAINS services, routes, defaultListener, mainListen", async () => {
    const deps = fakeDeps();
    const input: OnboardInput = { repo: "acme-org/acme-app", vm: "samo-we-acme" };
    await runOnboard(input, deps, vmStore, appStore, () => {}, () => {});

    const rec = appStore.get("vm-thread-1", "acme-app");
    expect(rec).toBeDefined();
    expect(rec!.services).toBeDefined();
    expect(rec!.services?.length).toBe(1);
    expect(rec!.services?.[0]?.name).toBe("web");
    expect(rec!.routes).toBeDefined();
    expect(rec!.routes?.length).toBe(1);
    expect(rec!.defaultListener).toBe("web");
    expect(rec!.mainListen).toBe("tls");
  });
});

// ---------------------------------------------------------------------------
// 7. Legacy app (no secrets[]) — byte-identical behaviour
// ---------------------------------------------------------------------------

describe("legacy app (no secrets) behaviour", () => {
  test("env-create script for legacy app contains no secrets.env reference", () => {
    const s = buildEnvCreateScript(app({ secrets: undefined }), target());
    expect(s).not.toContain("secrets.env");
    expect(s).not.toContain("/var/lib/samohost/envs");
  });

  test("env-create script with empty secrets[] also omits secrets.env", () => {
    const s = buildEnvCreateScript(app({ secrets: [] }), target());
    expect(s).not.toContain("secrets.env");
  });

  test("host-prep unit template for legacy app is byte-identical (no EnvironmentFile for secrets)", () => {
    const legacy = buildHostPrepScript(app({ secrets: undefined }), "samo");
    const emptySecrets = buildHostPrepScript(app({ secrets: [] }), "samo");
    expect(legacy).toBe(emptySecrets);
    expect(legacy).not.toContain("secrets.env");
    expect(legacy).not.toContain("/var/lib/samohost/envs");
  });

  test("env-create script for legacy app is byte-identical to app with secrets: undefined vs secrets: []", () => {
    const s1 = buildEnvCreateScript(app({ secrets: undefined }), target());
    const s2 = buildEnvCreateScript(app({ secrets: [] }), target());
    expect(s1).toBe(s2);
  });
});
