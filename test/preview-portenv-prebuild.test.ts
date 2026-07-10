/**
 * preview-portenv-prebuild — per-listener portEnv shell vars available BEFORE
 * the build phase in env-create scripts.
 *
 * ROOT CAUSE (isolation leak): a multi-service app's buildCmd can reference
 * $APP_API_PORT (etc.) to point assets at the per-env sidecar, but those vars
 * were ONLY written to .env in the envfile phase — AFTER build. So the build
 * ran without knowing its own per-env API port.
 *
 * FIX: in buildEnvCreateScript, emit per-listener portEnv assignments from the
 * portMap BEFORE the build phase (immediately after the header globals block).
 * Values MUST equal what the envfile phase later writes to .env — single source
 * of truth is portMap.get(listener.name) ?? t.port.
 *
 * Test IDs:
 *   ppb-ms-1  multi-service: every portEnv assigned before build:start marker
 *   ppb-ms-2  multi-service: pre-build values match envfile-phase .env writes
 *   ppb-ms-3  multi-service: build phase can execute referencing portEnv vars
 *   ppb-ss-1  single-service (legacy): PORT assigned before build:start marker
 *   ppb-ss-2  single-service: pre-build PORT value matches envfile-phase write
 *   ppb-ss-3  single-service: PORT no-regression — envfile strip-append unchanged
 *   ppb-bash  generated scripts are valid bash (multi and single)
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  buildEnvCreateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures — prod-accurate shapes
// ---------------------------------------------------------------------------

/** Legacy single-service app (no `services` field). */
function legacyApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1111",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

/**
 * Multi-service app: web (PORT), ws-hub (WS_HUB_PORT), api (APP_API_PORT).
 * The buildCmd references APP_API_PORT to exercise the isolation-leak use-case:
 * a build asset that must know its per-env sidecar URL at build time.
 */
function multiApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-2",
    vmId: "vm-1111",
    name: "samograph",
    repo: "acme/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "APP_API_ORIGIN=http://127.0.0.1:${APP_API_PORT} npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "samograph",
    services: [
      {
        name: "web",
        unit: "samograph",
        listeners: [
          { name: "web", port: 3000, portEnv: "PORT", healthPath: "/" },
        ],
      },
      {
        name: "ws-hub",
        unit: "samograph-ws-hub",
        listeners: [
          { name: "ws-hub", port: 8888, portEnv: "WS_HUB_PORT", healthPath: "/health" },
        ],
      },
      {
        name: "api",
        unit: "samograph-api",
        listeners: [
          { name: "api", port: 9000, portEnv: "APP_API_PORT" }, // no healthPath
        ],
      },
    ],
    routes: [
      { matchPath: "/api*", to: "api" },
    ],
    defaultListener: "web",
    ...o,
  };
}

function legacyTarget(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "field-record-1-feat-x",
    branch: "feat/x",
    port: 3100,
    vhost: "field-record-1-feat-x.samo.cat",
    dbBackend: "none",
    ...o,
  };
}

function multiTarget(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "samograph-feat-x",
    branch: "feat/x",
    port: 3100,
    ports: { web: 3100, "ws-hub": 3101, api: 3102 },
    vhost: "samograph-feat-x.samo.cat",
    dbBackend: "none",
    ...o,
  };
}

/** Bash syntax check. */
function bashOk(script: string): boolean {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return r.status === 0;
}

/** Canonical "before build" boundary — the build-phase start marker. */
const BUILD_MARKER = "<<<SAMOHOST_PHASE:build:start>>>";

/**
 * Extract portEnv → allocatedPort from the envfile strip-then-append lines.
 *
 * The envfile phase emits (for each listener, in the &&-chain):
 *   printf 'PORTENV=PORT\n' >> "$SAMOHOST_ENV_DIR/.env"
 *
 * We read those to get the single source of truth for what the .env will carry.
 */
function extractEnvfilePortValues(script: string): Map<string, number> {
  const result = new Map<string, number>();
  // Matches: printf 'PORTENV=DIGITS\n'
  // In the generated bash string, \n is a literal backslash-n.
  const re = /printf\s+'([A-Z_][A-Z0-9_]*)=(\d+)\\n'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    result.set(m[1]!, parseInt(m[2]!, 10));
  }
  return result;
}

/**
 * Check that a bare-assignment line `VARNAME='VALUE'` appears in the script
 * section — using a line-anchored regex so SAMOHOST_PORT='3100' does NOT
 * falsely satisfy a check for PORT='3100'.
 */
function hasBareAssignment(section: string, varName: string, value: string): boolean {
  const re = new RegExp(`^${varName}='${value}'$`, "m");
  return re.test(section);
}

// ---------------------------------------------------------------------------
// ppb-ms: multi-service portEnv before build
// ---------------------------------------------------------------------------

describe("ppb-ms: multi-service portEnv shell vars before build phase", () => {
  test("ppb-ms-1: every listener portEnv has a bare assignment before build:start marker", () => {
    const script = buildEnvCreateScript(multiApp(), multiTarget());
    const buildPos = script.indexOf(BUILD_MARKER);

    expect(buildPos).toBeGreaterThan(-1);

    const preBuild = script.slice(0, buildPos);

    // Each portEnv must appear as a standalone assignment line before build.
    // hasBareAssignment uses /^VARNAME='value'$/m so SAMOHOST_PORT='3100' does
    // NOT satisfy PORT='3100'.
    expect(hasBareAssignment(preBuild, "PORT", "3100")).toBe(true);
    expect(hasBareAssignment(preBuild, "WS_HUB_PORT", "3101")).toBe(true);
    expect(hasBareAssignment(preBuild, "APP_API_PORT", "3102")).toBe(true);
  });

  test("ppb-ms-2: pre-build portEnv values are equal to envfile-phase .env writes (single source of truth)", () => {
    const script = buildEnvCreateScript(multiApp(), multiTarget());
    const buildPos = script.indexOf(BUILD_MARKER);
    expect(buildPos).toBeGreaterThan(-1);

    const preBuild = script.slice(0, buildPos);

    // Extract what the envfile phase writes to .env.
    const envfileVals = extractEnvfilePortValues(script);
    expect(envfileVals.size).toBeGreaterThan(0);

    // For every portEnv that envfile writes, the pre-build header must carry
    // the exact same numeric value as a bare assignment.
    for (const [portEnv, port] of envfileVals) {
      expect(hasBareAssignment(preBuild, portEnv, String(port))).toBe(true);
    }
  });

  test("ppb-ms-3: build phase can reference APP_API_PORT as a shell var (extract-and-exec)", () => {
    // Verifies the isolation-leak is closed: $APP_API_PORT is set before the
    // build phase marker, so a buildCmd like
    //   APP_API_ORIGIN=http://127.0.0.1:${APP_API_PORT} npm run build
    // gets the per-env port (3102), not the default 9000.
    //
    // We extract the bare-assignment lines from the pre-build header and run
    // them in a minimal bash probe that echoes $APP_API_PORT.
    const script = buildEnvCreateScript(multiApp(), multiTarget());
    const buildPos = script.indexOf(BUILD_MARKER);
    expect(buildPos).toBeGreaterThan(-1);

    const preBuild = script.slice(0, buildPos);

    // Collect all bare-assignment lines (VARNAME='VALUE').
    const assignmentLines = preBuild
      .split("\n")
      .filter((l) => /^[A-Z_][A-Z0-9_]*='[^']*'$/.test(l.trim()));

    const probe = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ...assignmentLines,
      'echo "APP_API_PORT=${APP_API_PORT}"',
    ].join("\n");

    const res = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toContain("APP_API_PORT=3102");
  });
});

// ---------------------------------------------------------------------------
// ppb-ss: single-service (legacy) portEnv before build
// ---------------------------------------------------------------------------

describe("ppb-ss: single-service (legacy) PORT before build phase", () => {
  test("ppb-ss-1: PORT has a bare assignment before build:start marker (legacy app)", () => {
    const script = buildEnvCreateScript(legacyApp(), legacyTarget());
    const buildPos = script.indexOf(BUILD_MARKER);
    expect(buildPos).toBeGreaterThan(-1);

    const preBuild = script.slice(0, buildPos);

    // Legacy synthesizes portEnv="PORT" from healthUrl with t.port (3100).
    // Must be a standalone line, not part of SAMOHOST_PORT='3100'.
    expect(hasBareAssignment(preBuild, "PORT", "3100")).toBe(true);
  });

  test("ppb-ss-2: pre-build PORT value matches the envfile-phase PORT write", () => {
    const script = buildEnvCreateScript(legacyApp(), legacyTarget());
    const buildPos = script.indexOf(BUILD_MARKER);
    expect(buildPos).toBeGreaterThan(-1);

    const preBuild = script.slice(0, buildPos);
    const envfileVals = extractEnvfilePortValues(script);

    // Legacy envfile writes exactly one portEnv: PORT=<t.port>.
    const envfilePort = envfileVals.get("PORT");
    expect(envfilePort).toBeDefined();

    // Pre-build must carry the same value as a bare assignment.
    expect(hasBareAssignment(preBuild, "PORT", String(envfilePort))).toBe(true);
  });

  test("ppb-ss-3: legacy envfile strip-then-append for PORT is still present (no regression)", () => {
    // The envfile phase must STILL strip-then-append PORT for the legacy app
    // (operator template may carry stale prod PORT=3000; allocated preview port
    // must win in .env). Emitting PORT in the pre-build header must not remove
    // or skip the envfile strip-then-append.
    const script = buildEnvCreateScript(legacyApp(), legacyTarget());

    // Envfile strip: grep -vE '^PORT=' strips stale prod value from template.
    // The generated line is: grep -vE '^PORT=' (with sq-quoting of the pattern).
    expect(script).toContain("'^PORT='");

    // Envfile append: printf 'PORT=3100\n' appends the allocated preview port.
    // The \n in the printf arg is a literal backslash-n (bash single-quoted string).
    expect(script).toContain("'PORT=3100\\n'");
  });
});

// ---------------------------------------------------------------------------
// ppb-bash: bash validity
// ---------------------------------------------------------------------------

describe("ppb-bash: generated scripts are valid bash (with portEnv injection)", () => {
  test("ppb-bash-1: multi-service create script is valid bash", () => {
    expect(bashOk(buildEnvCreateScript(multiApp(), multiTarget()))).toBe(true);
  });

  test("ppb-bash-2: legacy create script is valid bash", () => {
    expect(bashOk(buildEnvCreateScript(legacyApp(), legacyTarget()))).toBe(true);
  });
});
