/**
 * TDD RED tests — samorev blocker fixes for PR #141.
 *
 * These tests pin the NEW behaviors required to address samorev's blockers:
 *
 * BLOCKER 1(a): ALL service unit templates (not just the primary) get
 *   EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env in host-prep.
 * BLOCKER 1(b): env-create PREFLIGHT — when app.secrets is non-empty, check
 *   the live unit templates contain the secrets EnvironmentFile line; emit
 *   secrets-preflight:fail + actionable message if absent.
 * BLOCKER 2: Sudoers root-oracle — no user-controlled glob that can match a
 *   path separator; replaced by a single exact-path helper grant.
 *   Helper validates env-name (charset only, rejects path/glob chars).
 * BLOCKER 3: mkdir grant mismatch — subsumed by the helper.
 * BLOCKER 4: Secrets phase fail marker — secrets phase wrapped in phaseBlock
 *   so failures emit secrets:fail and do not silently abort.
 * ALSO: destroy cleans /var/lib/samohost/envs/<name>/; rotate skips stopped
 *   envs; smol-toml bumped in the RED commit is reverted.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEnvCreateScript,
  buildEnvDestroyScript,
  buildHostPrepScript,
  buildSecretsRotateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures (same shapes as env-secrets.test.ts)
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-blk-1",
    vmId: "vm-blk-1",
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

// ---------------------------------------------------------------------------
// BLOCKER 1(a): ALL service unit templates get EnvironmentFile
// ---------------------------------------------------------------------------

describe("BLOCKER 1(a): buildHostPrepScript — ALL services get EnvironmentFile", () => {
  test("multi-service app: each distinct service unit has its own @.service template", () => {
    const multiApp = app({
      secrets: ["SESSION_SECRET"],
      services: [
        {
          name: "web",
          unit: "acme-web",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
        },
        {
          name: "worker",
          unit: "acme-worker",
          listeners: [{ name: "worker", port: 3002, portEnv: "WORKER_PORT", healthPath: "/health" }],
        },
      ],
      defaultListener: "web",
    });
    const s = buildHostPrepScript(multiApp, "samo");
    // Both unit templates must appear
    expect(s).toContain("acme-web@.service");
    expect(s).toContain("acme-worker@.service");
  });

  test("multi-service app: ALL service unit templates carry the secrets EnvironmentFile line", () => {
    const multiApp = app({
      secrets: ["SESSION_SECRET"],
      services: [
        {
          name: "web",
          unit: "acme-web",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
        },
        {
          name: "worker",
          unit: "acme-worker",
          listeners: [{ name: "worker", port: 3002, portEnv: "WORKER_PORT", healthPath: "/health" }],
        },
      ],
      defaultListener: "web",
    });
    const s = buildHostPrepScript(multiApp, "samo");
    const matches = (s.match(/EnvironmentFile=\/var\/lib\/samohost\/envs\/%i\/secrets\.env/g) ?? []).length;
    // Both templates must have the line — exactly 2 occurrences
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  test("single-service app with secrets still produces exactly ONE template", () => {
    const singleApp = app({ secrets: ["SESSION_SECRET"] });
    const s = buildHostPrepScript(singleApp, "samo");
    // Legacy single-service: one template for app.serviceUnit
    const templateMatches = (s.match(/cat > \/etc\/systemd\/system\/.*@\.service/g) ?? []).length;
    expect(templateMatches).toBe(1);
    // Must still have the secrets EnvironmentFile line once
    expect(s).toContain("EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1(b): env-create preflight — fail loud when template missing
// ---------------------------------------------------------------------------

describe("BLOCKER 1(b): buildEnvCreateScript — secrets-preflight phase", () => {
  test("env-create with secrets emits a secrets-preflight:start marker", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    expect(s).toContain("secrets-preflight:start");
  });

  test("env-create with secrets emits a secrets-preflight:fail marker on missing template", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    expect(s).toContain("secrets-preflight:fail");
  });

  test("env-create preflight checks the unit template path on the host", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // The preflight must reference the systemd unit template file
    expect(s).toMatch(/\/etc\/systemd\/system\/.*@\.service/);
  });

  test("env-create preflight includes an actionable message pointing to host-prep", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // Actionable: user can fix by re-running host-prep
    expect(s).toMatch(/host-prep|env plan/);
  });

  test("legacy app (no secrets) has no secrets-preflight phase", () => {
    const s = buildEnvCreateScript(app({ secrets: undefined }), target());
    expect(s).not.toContain("secrets-preflight");
  });

  test("env-create preflight checks ALL service unit templates for multi-service apps", () => {
    const multiApp = app({
      secrets: ["SESSION_SECRET"],
      services: [
        {
          name: "web",
          unit: "acme-web",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
        },
        {
          name: "worker",
          unit: "acme-worker",
          listeners: [{ name: "worker", port: 3002, portEnv: "WORKER_PORT", healthPath: "/health" }],
        },
      ],
      defaultListener: "web",
    });
    const s = buildEnvCreateScript(multiApp, target());
    // Both unit template paths must appear in the preflight check
    expect(s).toContain("acme-web@.service");
    expect(s).toContain("acme-worker@.service");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 2: Sudoers root-oracle — helper replaces glob grants
// ---------------------------------------------------------------------------

describe("BLOCKER 2: buildHostPrepScript — no separator-matching glob in sudoers", () => {
  test("sudoers block has NO raw grep grant with a user-controlled glob", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    // Old bad pattern: /usr/bin/grep -qE * /var/lib/samohost/envs/*/secrets.env
    // The * before /var/lib could match any arg including /etc/shadow
    expect(s).not.toMatch(/NOPASSWD:.*\/usr\/bin\/grep.*\*.*secrets/);
  });

  test("sudoers block has NO raw tee -a grant with a glob path for secrets", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    // Old bad pattern: /usr/bin/tee -a /var/lib/samohost/envs/*/secrets.env
    expect(s).not.toMatch(/NOPASSWD:.*\/usr\/bin\/tee.*\/var\/lib\/samohost\/envs\/\*/);
  });

  test("sudoers block has NO mkdir grant with wrong exact args (BLOCKER 3 subsumed)", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    // Old bad pattern: /usr/bin/mkdir -p /var/lib/samohost/envs  (wrong: scripts call with <name> appended)
    expect(s).not.toMatch(/NOPASSWD:.*\/usr\/bin\/mkdir -p \/var\/lib\/samohost\/envs$/m);
  });

  test("sudoers uses the samohost-secrets helper for all secrets operations", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    // Must reference the helper in sudoers
    expect(s).toMatch(/NOPASSWD:.*\/usr\/local\/sbin\/samohost-secrets/);
  });

  test("host-prep installs the helper script at /usr/local/sbin/samohost-secrets", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    expect(s).toContain("/usr/local/sbin/samohost-secrets");
    // The script must be written (cat > ... or similar)
    expect(s).toMatch(/> \/usr\/local\/sbin\/samohost-secrets|install.*samohost-secrets/);
  });

  test("helper script validates env-name and rejects path separator chars", () => {
    const s = buildHostPrepScript(app({ secrets: ["SESSION_SECRET"] }), "samo");
    // The embedded helper must reject env names with path chars
    // Look for the regex validation pattern in the helper
    expect(s).toMatch(/\^a-z0-9.*-|ENV_NAME.*=~|regex.*env/i);
  });

  test("DB-backed apps without app secrets retain only the clone-credential helper grant", () => {
    const s = buildHostPrepScript(app({ secrets: [] }), "samo");
    // Every effective envDbVars URL receives a generated clone-only password,
    // so the exact-path helper is still required even with secrets=[].
    expect(s).toMatch(/NOPASSWD: \/usr\/local\/sbin\/samohost-secrets/);
    // App-secret loading remains absent from the systemd unit.
    expect(s).not.toContain("EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 4: Secrets phase fail marker
// ---------------------------------------------------------------------------

describe("BLOCKER 4: buildEnvCreateScript — secrets phase emits fail marker", () => {
  test("secrets phase contains a secrets:fail marker on failure path", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    expect(s).toContain("secrets:fail");
  });

  test("secrets phase is wrapped so it can succeed or fail explicitly (not just early-exit)", () => {
    const s = buildEnvCreateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // Both ok and fail markers must be present
    expect(s).toContain("secrets:ok");
    expect(s).toContain("secrets:fail");
  });
});

// ---------------------------------------------------------------------------
// ALSO: Destroy cleans /var/lib/samohost/envs/<name>/
// ---------------------------------------------------------------------------

describe("ALSO: buildEnvDestroyScript — cleans secrets dir", () => {
  test("destroy script cleans /var/lib/samohost/envs/<env-name>/ for apps with secrets", () => {
    const s = buildEnvDestroyScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target({ name: "acme-app-feat-x" }),
    );
    // Must reference the env-specific secrets dir or use the helper clean action
    expect(s).toMatch(/samohost-secrets.*clean|rm.*-rf.*samohost\/envs\/acme-app-feat-x/);
  });

  test("destroy cleans the identity secrets dir even without declared app secrets", () => {
    const s = buildEnvDestroyScript(app({ secrets: undefined }), target());
    // DBLab clone-role credentials use the same per-env secrets file, so an
    // absent app.secrets declaration is not proof that the directory is empty.
    expect(s).toContain("samohost-secrets clean 'acme-app-feat-x'");
    expect(s).toContain("clean \"$SAMOHOST_ENV_NAME\" 'env-user-v2'");
  });
});

// ---------------------------------------------------------------------------
// ALSO: Rotate skips stopped envs
// ---------------------------------------------------------------------------

describe("ALSO: buildSecretsRotateScript — skip stopped units", () => {
  test("rotate script does NOT unconditionally enable --now at top level", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"], serviceUnit: "acme-app" }),
      target({ name: "acme-app-feat-x" }),
    );
    const lines = s.split("\n");
    // Any enable --now line for the unit must be indented (inside a conditional)
    const unconditionalEnables = lines.filter(
      (l) => /^sudo \/usr\/bin\/systemctl enable --now/.test(l)
        && l.includes("acme-app@acme-app-feat-x"),
    );
    expect(unconditionalEnables).toHaveLength(0);
  });

  test("rotate only restarts units that are is-active before rotation", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"], serviceUnit: "acme-app" }),
      target({ name: "acme-app-feat-x" }),
    );
    // Must check is-active before any restart operation
    expect(s).toContain("is-active");
    // enable --now must appear only inside indented (conditional) blocks
    const lines = s.split("\n");
    let insideActive = 0;
    let unconditional = 0;
    for (const line of lines) {
      if (/if systemctl is-active/.test(line)) insideActive++;
      if (line === "fi") insideActive = Math.max(0, insideActive - 1);
      if (insideActive === 0 && /sudo.*systemctl enable --now/.test(line)
          && line.includes("acme-app@acme-app-feat-x")) {
        unconditional++;
      }
    }
    expect(unconditional).toBe(0);
  });

  test("rotate uses helper rotate action instead of raw sudo tee/grep", () => {
    const s = buildSecretsRotateScript(
      app({ secrets: ["SESSION_SECRET"] }),
      target(),
    );
    // Route through helper OR verify no raw sudo tee -a with glob
    // (Either helper-based or fixed direct approach is acceptable,
    // as long as no wildcard grant remains)
    expect(s).not.toMatch(/sudo \/usr\/bin\/tee -a \/var\/lib\/samohost\/envs\/\*/);
  });
});

// ---------------------------------------------------------------------------
// ALSO: smol-toml reverted to ^1.6.1
// ---------------------------------------------------------------------------

describe("ALSO: smol-toml dependency revert", () => {
  test("package.json smol-toml is ^1.6.1 (unexplained bump to ^1.7.0 reverted)", () => {
    const pkgPath = join(import.meta.dir, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["smol-toml"]).toBe("^1.6.1");
  });
});
