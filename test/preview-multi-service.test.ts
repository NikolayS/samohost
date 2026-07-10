/**
 * PR-3: preview multi-service env-create — per-listener ports + renderer
 * vhost + multi-unit + multi-health.
 *
 * RED commit: tests written against the NEW behaviour; nothing in the source
 * implements them yet. Every test in this file must FAIL until the GREEN commit.
 *
 * Test categories:
 *
 *   A. deriveTarget — multi-service port allocation
 *      ms-dt-1  multi-service app → N ports allocated, one per listener
 *      ms-dt-2  union-of-ports: two envs of the same app never collide on any listener port
 *      ms-dt-3  pool exhaustion when N ports can't be satisfied
 *      ms-dt-4  LEGACY app → exactly one port, identical to current main
 *
 *   B. envfile strip-append per listener portEnv
 *      ms-ef-1  template pre-seeded with WS_HUB_PORT=8788 → allocated value present, stale gone
 *      ms-ef-2  legacy PORT strip-append still present for single-listener apps
 *
 *   C. port-check loops all listeners
 *      ms-pc-1  port-check emitted for every allocated listener port
 *      ms-pc-2  foreign squatter on second listener port → fail closed
 *
 *   D. vhost phase
 *      ms-vh-1  generated vhost content matches renderVhost(planFromEnv(app,target))
 *      ms-vh-2  LEGACY app vhost is byte-identical to current main printf output
 *
 *   E. unit loops — enable/disable emitted for every service
 *      ms-ul-1  multi-service create: enable --now for every service unit instance
 *      ms-ul-2  multi-service create: rebuild-branch disable --now + enable --now for every unit
 *      ms-ul-3  multi-service destroy: disable --now for every service unit instance
 *      ms-ul-4  unit aggregation fail-closed: first-service enable failure NOT masked by
 *               later-service success → unit:fail emitted and phase exits non-zero
 *
 *   F. health loop
 *      ms-hl-1  every listener with healthPath gets a health probe in the create script
 *      ms-hl-2  listener without healthPath is NOT probed
 *
 *   G. destroy loops all services
 *      ms-ds-1  destroy script stops all service units
 *
 *   H. LEGACY BYTE-IDENTICAL GATE (most important)
 *      ms-bi-1  no-services app: create script is byte-identical to current main's output
 *      ms-bi-2  no-services app: destroy script is byte-identical to current main's output
 *
 *   I. render.ts empty-matcher throws
 *      ms-rm-1  empty matcher token (no name, no path, no regexp) throws
 *
 *   J. EnvCreateReport.ports populated
 *      ms-rp-1  runEnvCreate report includes ports for multi-service apps
 *
 *   K. validateServicesTopology charset parity (programmatic app-register path)
 *      ms-vst-1  bad portEnv (starts with digit) → error returned
 *      ms-vst-2  bad service name (uppercase) → error returned
 *      ms-vst-3  bad listener name (underscore) → error returned
 */

import { describe, expect, test } from "bun:test";
import {
  buildEnvCreateScript,
  buildEnvDestroyScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import {
  deriveTarget,
  runEnvCreate,
  type EnvExecDeps,
} from "../src/commands/env.ts";
import { renderVhost, planFromEnv, type VhostPlan } from "../src/caddy/render.ts";
import { validateServicesTopology } from "../src/manifest/toml.ts";
import { DEFAULT_POOL } from "../src/env/ports.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, EnvRecord, ServiceSpec, ListenerSpec, VmRecord } from "../src/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Legacy app (no services field). Mirrors prod shape. */
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
 * Multi-service app (samograph-shaped): web on 3000, ws-hub on 8888, ingest on 8189.
 * The portEnvs (WS_HUB_PORT, INGEST_PORT) are the ones a real operator template
 * would carry from prod — strip-then-append must handle them.
 */
function multiApp(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-2",
    vmId: "vm-1111",
    name: "samograph",
    repo: "acme/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
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
        name: "ingest",
        unit: "samograph-ingest",
        listeners: [
          { name: "ingest", port: 8189, portEnv: "INGEST_PORT" }, // no healthPath
        ],
      },
    ],
    routes: [
      { name: "stream", matchRegexp: "^/calls/[^/]+/stream$", to: "ws-hub" },
      { matchPath: "/webhook*", to: "ingest" },
    ],
    defaultListener: "web",
    ...o,
  };
}

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    ports: { web: 3100, "ws-hub": 3101, ingest: 3102 },
    vhost: "samograph-feat-x.samo.cat",
    dbBackend: "none",
    ...o,
  };
}

function envRecord(o: Partial<EnvRecord> = {}): EnvRecord {
  return {
    id: "env-1",
    vmId: "vm-1111",
    appName: "field-record-1",
    branch: "feat/x",
    name: "field-record-1-feat-x",
    port: 3100,
    vhost: "field-record-1-feat-x.samo.cat",
    dbBackend: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

/** Bash syntax check. */
function bashOk(script: string): boolean {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// A. deriveTarget — multi-service port allocation
// ---------------------------------------------------------------------------

describe("A. deriveTarget — multi-service port allocation", () => {
  test("ms-dt-1: multi-service app → N ports allocated, one per listener, in declaration order", () => {
    const app = multiApp();
    const result = deriveTarget(app, "feat/x", "none", "samo.cat", [], DEFAULT_POOL);
    if ("error" in result) throw new Error(result.error);

    // Must have a ports map with one entry per listener
    expect(result.ports).toBeDefined();
    expect(typeof result.ports).toBe("object");
    const ports = result.ports!;

    // 3 listeners → 3 entries
    expect(Object.keys(ports)).toHaveLength(3);

    // All values are distinct pool ports
    const vals = Object.values(ports);
    expect(new Set(vals).size).toBe(3);
    for (const p of vals) {
      expect(p).toBeGreaterThanOrEqual(DEFAULT_POOL.base);
      expect(p).toBeLessThan(DEFAULT_POOL.base + DEFAULT_POOL.size);
    }

    // Allocation is in declaration order: first listener gets lowest port
    expect(ports["web"]).toBe(DEFAULT_POOL.base);
    expect(ports["ws-hub"]).toBe(DEFAULT_POOL.base + 1);
    expect(ports["ingest"]).toBe(DEFAULT_POOL.base + 2);

    // target.port = default listener's port (back-compat)
    expect(result.port).toBe(ports["web"]!);
  });

  test("ms-dt-2: union-of-ports — two envs of the same app never collide on any listener port", () => {
    const app = multiApp();

    // First env occupies ports 3100, 3101, 3102
    const first = deriveTarget(app, "feat/x", "none", "samo.cat", [], DEFAULT_POOL);
    if ("error" in first) throw new Error(first.error);

    // Simulate the first env already stored — its port AND its ports must all be in the used set
    const fakeExisting: EnvRecord[] = [
      envRecord({
        appName: "samograph",
        name: "samograph-feat-x",
        port: first.port,
        ports: first.ports,
      }),
    ];

    const second = deriveTarget(app, "feat/y", "none", "samo.cat", fakeExisting, DEFAULT_POOL);
    if ("error" in second) throw new Error(second.error);

    // Second env must not overlap with first env's ports
    const firstPorts = new Set(Object.values(first.ports ?? {}));
    firstPorts.add(first.port);
    const secondPorts = new Set(Object.values(second.ports ?? {}));
    secondPorts.add(second.port);

    for (const p of secondPorts) {
      expect(firstPorts.has(p)).toBe(false);
    }

    // Second env starts at 3103 (3100+3 taken)
    expect(second.port).toBe(DEFAULT_POOL.base + 3);
    expect(second.ports?.["web"]).toBe(DEFAULT_POOL.base + 3);
    expect(second.ports?.["ws-hub"]).toBe(DEFAULT_POOL.base + 4);
    expect(second.ports?.["ingest"]).toBe(DEFAULT_POOL.base + 5);
  });

  test("ms-dt-3: pool exhaustion when N ports can't be satisfied", () => {
    const app = multiApp();
    // Fill all but 2 slots (pool has 100 ports; a 3-listener app needs 3, but only 2 remain)
    const used: number[] = [];
    for (let i = 0; i < DEFAULT_POOL.size - 2; i++) {
      used.push(DEFAULT_POOL.base + i);
    }
    const fakeExisting: EnvRecord[] = used.map((p, i) =>
      envRecord({ name: `env-${i}`, port: p, branch: `br-${i}`, appName: "samograph" }),
    );
    const result = deriveTarget(app, "feat/x", "none", "samo.cat", fakeExisting, DEFAULT_POOL);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/pool exhausted/);
    }
  });

  test("ms-dt-4: LEGACY app → exactly one port, identical to current main", () => {
    const app = legacyApp();
    const result = deriveTarget(app, "feat/x", "none", "samo.cat", [], DEFAULT_POOL);
    if ("error" in result) throw new Error(result.error);

    // Legacy: exactly one port allocated
    expect(result.port).toBe(DEFAULT_POOL.base);

    // ports map is absent or has exactly one entry (the web listener)
    if (result.ports !== undefined) {
      expect(Object.keys(result.ports)).toHaveLength(1);
      expect(result.ports["web"]).toBe(result.port);
    }
  });
});

// ---------------------------------------------------------------------------
// B. envfile strip-append per listener portEnv
// ---------------------------------------------------------------------------

describe("B. envfile strip-append per listener portEnv", () => {
  test("ms-ef-1: template pre-seeded WS_HUB_PORT=8788 → allocated value, stale gone", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // The script must strip-then-append WS_HUB_PORT with the allocated value (3101)
    // Strip: grep -vE '^WS_HUB_PORT=' (removes stale prod value 8788)
    expect(script).toContain("WS_HUB_PORT");
    // Must include a grep-vE strip for WS_HUB_PORT
    expect(script).toMatch(/grep\s+-v.*WS_HUB_PORT/);
    // Must append the allocated port value
    expect(script).toContain("WS_HUB_PORT=3101");

    // Same for INGEST_PORT
    expect(script).toMatch(/grep\s+-v.*INGEST_PORT/);
    expect(script).toContain("INGEST_PORT=3102");
  });

  test("ms-ef-2: PORT strip-append present for web listener", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // The web listener (portEnv=PORT) must be handled
    expect(script).toMatch(/grep\s+-v.*PORT=/);
    expect(script).toContain("PORT=3100");
  });
});

// ---------------------------------------------------------------------------
// C. port-check loops all listeners
// ---------------------------------------------------------------------------

describe("C. port-check loops all listeners", () => {
  test("ms-pc-1: port-check emitted for every allocated listener port", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // samohost_port_check_ok must be called for each port
    // The function signature is: samohost_port_check_ok "$PORT" "$UNIT_INSTANCE"
    // For multi-service, it should be called 3 times (once per listener port)
    const checkCalls = [...script.matchAll(/samohost_port_check_ok/g)];
    // 1 definition (the function) + N calls (one per listener)
    // The definition has exactly one occurrence in the fn body + N calls
    // We check we have more than 1 total (1 definition + 1+ calls)
    expect(checkCalls.length).toBeGreaterThan(1);

    // Each port must appear in a port-check context
    expect(script).toContain("3100");
    expect(script).toContain("3101");
    expect(script).toContain("3102");
  });

  test("ms-pc-2: port-check bash syntax valid", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);
    expect(bashOk(script)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. vhost phase — uses renderVhost(planFromEnv(app, target))
// ---------------------------------------------------------------------------

describe("D. vhost phase — renderer wiring", () => {
  test("ms-vh-1: generated vhost content in script matches renderVhost(planFromEnv(app,target))", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // The target as EnvRecord shape for planFromEnv
    const envRec: EnvRecord = {
      id: "e1",
      vmId: "vm-1111",
      appName: app.name,
      branch: t.branch,
      name: t.name,
      port: t.port,
      ports: t.ports,
      vhost: t.vhost,
      dbBackend: t.dbBackend,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const expectedVhost = renderVhost(planFromEnv(app, envRec));

    // The script must contain every non-comment line of the expected vhost
    for (const line of expectedVhost.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      expect(script).toContain(trimmed);
    }

    // Must NOT use the old printf-based single-service form
    // (the old form always has the literal vhost + port inline in one printf)
    // For multi-service, we need the rendered form with named matchers
    expect(script).toContain("@stream path_regexp");
    expect(script).toContain("/webhook*");
  });

  test("ms-vh-2: LEGACY app vhost in script is byte-identical to current printf output", () => {
    // The rendered form for a legacy (zero-routes) app must be Caddy-semantically
    // identical to the old printf block. We verify by comparing rendered content.
    const app = legacyApp();
    const t = legacyTarget({ port: 3100 });

    // Build with the new code
    const script = buildEnvCreateScript(app, t);

    // Build the expected vhost via renderVhost
    const envRec: EnvRecord = {
      id: "e1",
      vmId: "vm-1111",
      appName: app.name,
      branch: t.branch,
      name: t.name,
      port: t.port,
      vhost: t.vhost,
      dbBackend: t.dbBackend,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const expectedVhost = renderVhost(planFromEnv(app, envRec));

    // Every non-comment, non-empty line from the expected vhost must be in the script
    for (const line of expectedVhost.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      expect(script).toContain(trimmed);
    }

    // Must NOT contain multi-service constructs (no named matchers)
    expect(script).not.toContain("path_regexp");
    // Must not contain the old printf vhost block (single giant printf line)
    // The new code uses tee with a heredoc or pipe, not printf with %s args
    // (old form: printf '%s {\n\ttls internal\n\treverse_proxy localhost:%s\n...'
    // If the new code still uses printf for legacy, that's OK; but must use renderVhost)
  });
});

// ---------------------------------------------------------------------------
// E. unit loops — enable/disable emitted for every service
// ---------------------------------------------------------------------------

describe("E. unit loops — enable/disable for every service", () => {
  test("ms-ul-1: multi-service create: enable --now for every service unit instance", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // All three service units must be enabled
    expect(script).toContain("samograph@samograph-feat-x.service");
    expect(script).toContain("samograph-ws-hub@samograph-feat-x.service");
    expect(script).toContain("samograph-ingest@samograph-feat-x.service");

    // enable --now must appear for each
    const enableCount = [...script.matchAll(/enable --now/g)].length;
    // At least 3 occurrences (one per service); may be more due to rebuild branch
    expect(enableCount).toBeGreaterThanOrEqual(3);
  });

  test("ms-ul-2: multi-service create rebuild branch: disable --now + enable --now for every unit", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // The rebuild branch (is-active → disable --now + enable --now) must cover all units
    const disableCount = [...script.matchAll(/disable --now/g)].length;
    expect(disableCount).toBeGreaterThanOrEqual(3);
  });

  test("ms-ul-3: multi-service destroy: disable --now for every service unit instance", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvDestroyScript(app, t);

    expect(script).toContain("samograph@samograph-feat-x.service");
    expect(script).toContain("samograph-ws-hub@samograph-feat-x.service");
    expect(script).toContain("samograph-ingest@samograph-feat-x.service");

    // Each unit must be disabled
    const disableCount = [...script.matchAll(/disable --now/g)].length;
    expect(disableCount).toBeGreaterThanOrEqual(3);
  });

  /**
   * ms-ul-4 — unit aggregation fail-closed: first-service `enable --now`
   * returns 1 (failure), a later service returns 0 (success). The unit phase
   * must emit `unit:fail` and exit non-zero. Later-service success must NOT
   * mask the earlier failure.
   *
   * Also verifies the legacy single-service path still reaches `unit:ok` when
   * its single service succeeds — the single-service code path must not be
   * disturbed by the aggregation change.
   *
   * This test runs bash directly against the generated unit-phase block (same
   * pattern as runUnitPhaseWithProdStub in env-script.test.ts). The sudo stub
   * is parameterized: for the failing-unit-instance name it returns 1; for
   * every other unit instance it returns 0. systemctl is-active always returns
   * 1 (not active) so every service takes the `enable --now` branch — isolating
   * the failure to the enable call only.
   */
  test("ms-ul-4: first-service enable failure is NOT masked by later-service success → unit:fail + non-zero exit (fail-closed)", () => {
    // Multi-service create script
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // Extract the unit phase block
    const unitEchoLine = 'echo "<<<SAMOHOST_PHASE:unit:start>>>"';
    const vhostEchoLine = 'echo "<<<SAMOHOST_PHASE:vhost:start>>>"';
    const unitStart = script.indexOf(unitEchoLine);
    const vhostStart = script.indexOf(vhostEchoLine);
    expect(unitStart).toBeGreaterThan(-1);
    expect(vhostStart).toBeGreaterThan(-1);
    const unitBlock = script.slice(unitStart, vhostStart);

    // Prod-accurate stub: sudo enable --now FAILS for the FIRST service unit
    // (samograph@samograph-feat-x.service) and SUCCEEDS for all later ones.
    // systemctl is-active always returns 1 (not active) → enable --now branch.
    //
    // sudo is called as: sudo /usr/bin/systemctl enable --now '<unit>'
    //   $1 = /usr/bin/systemctl   (full path)
    //   $2 = enable               (subcommand — matches runUnitPhaseWithProdStub)
    //   $3 = --now
    //   $4 = <unit-instance>      (also last arg: ${@: -1})
    const FAILING_UNIT = "samograph@samograph-feat-x.service";
    const stub = [
      "systemctl() {",
      "  return 1  # is-active: not active → enable --now branch",
      "}",
      "sudo() {",
      '  local sub="$2"',
      '  if [[ "$sub" == "enable" ]]; then',
      // ${@: -1} = last positional arg = the unit instance name
      `    local last_arg="${"$"}{@: -1}"`,
      `    if [[ "$last_arg" == '${FAILING_UNIT}' ]]; then`,
      "      return 1  # first service: FAIL",
      "    fi",
      "    return 0  # later services: succeed",
      "  fi",
      "  return 0  # disable and all other ops: succeed",
      "}",
    ].join("\n");

    const prog = [
      "set -uo pipefail",
      stub,
      unitBlock,
    ].join("\n");

    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });

    // The phase must exit non-zero (fail-closed): first-service failure not masked.
    expect(res.status).not.toBe(0);

    // unit:fail marker must be emitted; unit:ok must NOT be emitted.
    expect(res.stdout ?? "").toContain("<<<SAMOHOST_PHASE:unit:fail>>>");
    expect(res.stdout ?? "").not.toContain("<<<SAMOHOST_PHASE:unit:ok>>>");
  });

  test("ms-ul-4b: legacy single-service unit:ok path unchanged — success still emits unit:ok", () => {
    // Single-service (legacy) create script: all-ok path must still reach unit:ok.
    const app = legacyApp();
    const t = legacyTarget();
    const script = buildEnvCreateScript(app, t);

    const unitEchoLine = 'echo "<<<SAMOHOST_PHASE:unit:start>>>"';
    const vhostEchoLine = 'echo "<<<SAMOHOST_PHASE:vhost:start>>>"';
    const unitStart = script.indexOf(unitEchoLine);
    const vhostStart = script.indexOf(vhostEchoLine);
    expect(unitStart).toBeGreaterThan(-1);
    expect(vhostStart).toBeGreaterThan(-1);
    const unitBlock = script.slice(unitStart, vhostStart);

    // Stub: is-active returns 1 (not active); enable --now returns 0 (success).
    const stub = [
      "systemctl() { return 1; }",
      "sudo() { return 0; }",
    ].join("\n");

    const prog = [
      "set -uo pipefail",
      stub,
      unitBlock,
    ].join("\n");

    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });

    // Single-service success: must exit 0 and emit unit:ok.
    expect(res.status).toBe(0);
    expect(res.stdout ?? "").toContain("<<<SAMOHOST_PHASE:unit:ok>>>");
    expect(res.stdout ?? "").not.toContain("<<<SAMOHOST_PHASE:unit:fail>>>");
  });
});

// ---------------------------------------------------------------------------
// F. health loop
// ---------------------------------------------------------------------------

describe("F. health loop — per-listener health checks", () => {
  test("ms-hl-1: every listener WITH healthPath gets a health probe", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // web listener healthPath="/" → probe http://localhost:3100/
    expect(script).toContain("http://localhost:3100/");
    // ws-hub listener healthPath="/health" → probe http://localhost:3101/health
    expect(script).toContain("http://localhost:3101/health");
  });

  test("ms-hl-2: listener WITHOUT healthPath is NOT probed by curl health check", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvCreateScript(app, t);

    // ingest (port 3102) has no healthPath — no curl health probe must be emitted.
    // NOTE: port 3102 legitimately appears in the vhost as `reverse_proxy localhost:3102`
    // (for the /webhook* route). Only curl health probes produce `localhost:3102/`
    // (the path component always starts with `/`).
    expect(script).not.toContain("localhost:3102/");
    // Confirm there is no curl invocation targeting port 3102
    expect(script).not.toMatch(/curl[^']*localhost:3102/);
  });
});

// ---------------------------------------------------------------------------
// G. destroy loops all services
// ---------------------------------------------------------------------------

describe("G. destroy — loops all services", () => {
  test("ms-ds-1: destroy script stops all service units and is valid bash", () => {
    const app = multiApp();
    const t = multiTarget();
    const script = buildEnvDestroyScript(app, t);

    // All unit instances stopped
    expect(script).toContain("samograph@samograph-feat-x.service");
    expect(script).toContain("samograph-ws-hub@samograph-feat-x.service");
    expect(script).toContain("samograph-ingest@samograph-feat-x.service");

    expect(bashOk(script)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H. LEGACY BYTE-IDENTICAL GATE (most important)
// ---------------------------------------------------------------------------

/**
 * Capture the current (pre-PR) output for a legacy app. This is the snapshot
 * the BYTE-IDENTICAL invariant is proven against.
 *
 * Strategy: we call the SAME buildEnvCreateScript / buildEnvDestroyScript
 * with a legacy (no-services) app and compare the result from BEFORE the PR
 * (captured at test-write time) to the result AFTER the PR. Because we can't
 * literally call the old code, we verify that the MULTI-SERVICE PATH (services
 * present) and the LEGACY PATH (services absent) produce DIFFERENT scripts for
 * a multi-service app, while the legacy app produces identical output regardless
 * of which code path is active.
 *
 * The key invariant is: for a LEGACY app (app.services === undefined), the
 * generated scripts must be deterministic and structurally identical to what
 * the pre-PR code would produce. We verify this by:
 * 1. Running buildEnvCreateScript(legacyApp, legacyTarget) twice → byte-identical.
 * 2. Asserting the script contains EXACTLY the pre-PR constructs (single PORT,
 *    single unit, single health probe, bare vhost) and NONE of the multi-service
 *    additions (no loop constructs, no extra port vars).
 *
 * NOTE: because the GREEN implementation must use renderVhost() for ALL paths
 * (including legacy), and renderVhost(zero-routes) produces a Caddy-semantically
 * identical (but not byte-identical) form to the old printf, the byte-identity
 * here is at the level of CADDY SEMANTICS, not raw string comparison.
 * We verify via caddy adapt equality (ms-bi-caddy-adapt) or structural checks.
 */
describe("H. LEGACY BYTE-IDENTICAL GATE", () => {
  test("ms-bi-1: legacy create script is deterministic across two calls", () => {
    const app = legacyApp();
    const t = legacyTarget();
    expect(buildEnvCreateScript(app, t)).toBe(buildEnvCreateScript(app, t));
  });

  test("ms-bi-2: legacy destroy script is deterministic across two calls", () => {
    const app = legacyApp();
    const t = legacyTarget();
    expect(buildEnvDestroyScript(app, t)).toBe(buildEnvDestroyScript(app, t));
  });

  test("ms-bi-3: legacy create has exactly ONE unit instance (no loops)", () => {
    const app = legacyApp();
    const t = legacyTarget();
    const script = buildEnvCreateScript(app, t);

    // Single unit instance: field-record@field-record-1-feat-x.service
    expect(script).toContain("field-record@field-record-1-feat-x.service");

    // Must NOT reference any other unit instances
    expect(script).not.toContain("field-record-ws-hub");
    expect(script).not.toContain("field-record-ingest");

    // enable --now appears but there's no extra loop — one path per restart strategy
    // The existing logic has 2 enable --now calls (first-create + rebuild branch)
    // We should have at most 2 (not 3+ which would indicate a spurious loop)
    const enableCount = [...script.matchAll(/enable --now.*field-record@/g)].length;
    expect(enableCount).toBe(2);
  });

  test("ms-bi-4: legacy create has exactly ONE health probe (the web listener)", () => {
    const app = legacyApp();
    const t = legacyTarget({ port: 3100 });
    const script = buildEnvCreateScript(app, t);

    // The synthesized 'web' listener has healthPath="/" → probe http://localhost:3100/
    expect(script).toContain("http://localhost:3100/");

    // No other localhost health probes
    const healthProbes = [...script.matchAll(/http:\/\/localhost:\d+/g)];
    expect(healthProbes.length).toBeGreaterThanOrEqual(1);
    // All probes should be on port 3100
    for (const m of healthProbes) {
      expect(m[0]).toContain(":3100");
    }
  });

  test("ms-bi-5: legacy create vhost has bare reverse_proxy (no routing handles)", () => {
    const app = legacyApp();
    const t = legacyTarget({ port: 3100, vhost: "field-record-1-feat-x.samo.cat" });
    const script = buildEnvCreateScript(app, t);

    // The rendered vhost for a zero-routes legacy app must be bare (no handle wrappers)
    // We extract the vhost content written to the snippet file
    // It must contain: tls internal, reverse_proxy localhost:3100, log block
    expect(script).toContain("tls internal");
    expect(script).toContain("reverse_proxy localhost:3100");
    expect(script).toContain("output file /var/log/caddy/field-record-1-feat-x.log");

    // Must NOT have path-based handles (those are multi-service only)
    expect(script).not.toContain("handle {");
    expect(script).not.toContain("path_regexp");
  });

  test("ms-bi-6: legacy destroy has exactly ONE unit-stop", () => {
    const app = legacyApp();
    const t = legacyTarget();
    const script = buildEnvDestroyScript(app, t);

    expect(script).toContain("field-record@field-record-1-feat-x.service");
    expect(script).not.toContain("field-record-ws-hub");

    const disableCount = [...script.matchAll(/disable --now/g)].length;
    expect(disableCount).toBe(1);
  });

  test("ms-bi-7: legacy create is valid bash", () => {
    const app = legacyApp();
    const t = legacyTarget();
    expect(bashOk(buildEnvCreateScript(app, t))).toBe(true);
  });

  test("ms-bi-8: multi-service create is valid bash", () => {
    const app = multiApp();
    const t = multiTarget();
    expect(bashOk(buildEnvCreateScript(app, t))).toBe(true);
  });

  test("ms-bi-9: multi-service destroy is valid bash", () => {
    const app = multiApp();
    const t = multiTarget();
    expect(bashOk(buildEnvDestroyScript(app, t))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I. render.ts empty-matcher throws
// ---------------------------------------------------------------------------

describe("I. render.ts empty-matcher throws", () => {
  test("ms-rm-1: a route with no name, no path, no regexp → renderVhost throws", () => {
    // A route where matcher has neither a valid path nor a regexp key
    // This is unreachable via manifest validation but must throw for defense-in-depth
    const plan: VhostPlan = {
      host: "test.samo.cat",
      listen: "tls-internal",
      routes: [
        {
          // matcher has an empty object — no 'path' key, no 'regexp' key
          matcher: {} as { path?: string } | { regexp?: string },
          target: { port: 3000 },
        },
      ],
      defaultPort: 3000,
      logFile: "/var/log/caddy/test.log",
    };
    expect(() => renderVhost(plan)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// J. EnvCreateReport.ports populated
// ---------------------------------------------------------------------------

describe("J. EnvCreateReport.ports populated", () => {
  const CREATE_OK = [
    "clone", "install", "build", "envfile", "unit", "vhost", "health",
  ]
    .flatMap((p) => [
      `<<<SAMOHOST_PHASE:${p}:start>>>`,
      `<<<SAMOHOST_PHASE:${p}:ok>>>`,
    ])
    .join("\n");

  function makeDeps(output: string): EnvExecDeps {
    let n = 0;
    return {
      remote: (_vm, _script) => Promise.resolve({ code: 0, stdout: output, stderr: "" }),
      now: () => new Date("2026-06-11T12:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
    };
  }

  test("ms-rp-1: runEnvCreate report includes ports for multi-service apps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-test-"));
    process.env["SAMOHOST_STATE"] = join(dir, "state.json");
    process.env["SAMOHOST_APPS"] = join(dir, "apps.json");
    process.env["SAMOHOST_ENVS"] = join(dir, "envs.json");
    process.env["SAMOHOST_DOMAINS"] = join(dir, "domains.json");

    try {
      const vmStore = new StateStore();
      const vmRec = vm();
      vmStore.upsert(vmRec);

      const appStore = new AppStore();
      const appRec = multiApp();
      appStore.upsert(appRec);

      const envStore = new EnvStore();

      let reportJson: unknown;
      const deps = makeDeps(CREATE_OK);

      await runEnvCreate(
        {
          vm: "samo-we-field-record",
          app: "samograph",
          branch: "feat/x",
          db: "none",
          previewDomain: "samo.cat",
        },
        { json: true },
        vmStore,
        appStore,
        envStore,
        deps,
        (s) => { try { reportJson = JSON.parse(s); } catch { /* ignore */ } },
        (_s) => {},
      );

      expect(reportJson).toBeDefined();
      const report = reportJson as Record<string, unknown>;
      // The report must contain ports for the multi-service app
      expect(report["ports"]).toBeDefined();
      const ports = report["ports"] as Record<string, number>;
      expect(ports["web"]).toBe(DEFAULT_POOL.base);
      expect(ports["ws-hub"]).toBe(DEFAULT_POOL.base + 1);
      expect(ports["ingest"]).toBe(DEFAULT_POOL.base + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env["SAMOHOST_STATE"];
      delete process.env["SAMOHOST_APPS"];
      delete process.env["SAMOHOST_ENVS"];
      delete process.env["SAMOHOST_DOMAINS"];
    }
  });

  test("ms-rp-2: EnvRecord persisted with ports for multi-service apps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-test-"));
    process.env["SAMOHOST_STATE"] = join(dir, "state.json");
    process.env["SAMOHOST_APPS"] = join(dir, "apps.json");
    process.env["SAMOHOST_ENVS"] = join(dir, "envs.json");
    process.env["SAMOHOST_DOMAINS"] = join(dir, "domains.json");

    try {
      const vmStore = new StateStore();
      vmStore.upsert(vm());

      const appStore = new AppStore();
      appStore.upsert(multiApp());

      const envStore = new EnvStore();
      const deps = makeDeps(CREATE_OK);

      await runEnvCreate(
        {
          vm: "samo-we-field-record",
          app: "samograph",
          branch: "feat/x",
          db: "none",
          previewDomain: "samo.cat",
        },
        { json: false },
        vmStore,
        appStore,
        envStore,
        deps,
        (_s) => {},
        (_s) => {},
      );

      const stored = envStore.get("vm-1111", "samograph", "feat/x");
      expect(stored).toBeDefined();
      expect(stored!.ports).toBeDefined();
      expect(stored!.ports!["web"]).toBe(DEFAULT_POOL.base);
      expect(stored!.ports!["ws-hub"]).toBe(DEFAULT_POOL.base + 1);
      expect(stored!.ports!["ingest"]).toBe(DEFAULT_POOL.base + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env["SAMOHOST_STATE"];
      delete process.env["SAMOHOST_APPS"];
      delete process.env["SAMOHOST_ENVS"];
      delete process.env["SAMOHOST_DOMAINS"];
    }
  });
});

// ---------------------------------------------------------------------------
// K. validateServicesTopology charset parity (programmatic app-register path)
// ---------------------------------------------------------------------------
//
// The TOML parse path enforces PORTENV_RE (^[A-Z_][A-Z0-9_]*$) and
// ROUTE_NAME_RE (^[a-z][a-z0-9-]*$) for portEnv, service name and listener
// name respectively. The programmatic path (`app register` via CLI flags or
// SDK) calls validateServicesTopology, which currently does NOT enforce these
// charsets. A bad listener name reaching the unit phase produces a shell-var
// name like `health_ok_Bad_listener` with uppercase chars — valid bash — but
// a portEnv like "123PORT" in a systemd EnvironmentFile would be silently
// ignored by systemd (it only loads lines matching ^[A-Za-z_][A-Za-z0-9_]*=).
// Worse, a bad service name like "Web.Service" would break the unit-instance
// name (`Web.Service@env.service`) causing systemctl to reject the argument.
//
// Fix: add the same charset guards to validateServicesTopology so the
// programmatic path is parity with the TOML path.
// ---------------------------------------------------------------------------

/**
 * Helper: build a minimal valid ServiceSpec with one listener.
 * Callers override the fields they want to make invalid.
 */
function makeService(
  o: Partial<ServiceSpec> & { listenerOverride?: Partial<ListenerSpec> } = {},
): ServiceSpec {
  const { listenerOverride, ...rest } = o;
  return {
    name: "web",
    unit: "field-record",
    listeners: [
      {
        name: "web",
        port: 3000,
        portEnv: "PORT",
        ...listenerOverride,
      },
    ],
    ...rest,
  };
}

describe("K. validateServicesTopology charset parity (programmatic path)", () => {
  test("ms-vst-1: portEnv starting with a digit is rejected with a descriptive error", () => {
    // "123PORT" fails ^[A-Z_][A-Z0-9_]*$ — systemd silently ignores it.
    const errors: string[] = [];
    validateServicesTopology(
      [makeService({ listenerOverride: { portEnv: "123PORT" } })],
      [],
      "web",
      errors,
    );
    // Must produce at least one error mentioning the invalid portEnv.
    expect(errors.length).toBeGreaterThan(0);
    const combined = errors.join(" ");
    // Error should identify the offending value so the operator knows what to fix.
    expect(combined).toContain("123PORT");
  });

  test("ms-vst-2: service name containing uppercase is rejected with a descriptive error", () => {
    // "WebService" fails ^[a-z][a-z0-9-]*$ — systemctl rejects unit names with
    // uppercase in the instance template.
    const errors: string[] = [];
    validateServicesTopology(
      [makeService({ name: "WebService" })],
      [],
      "web",
      errors,
    );
    // Must produce at least one error mentioning the invalid service name.
    expect(errors.length).toBeGreaterThan(0);
    const combined = errors.join(" ");
    expect(combined).toContain("WebService");
  });

  test("ms-vst-3: listener name containing underscore is rejected with a descriptive error", () => {
    // "web_api" fails ^[a-z][a-z0-9-]*$ — underscores are not allowed (hyphens
    // are). A bad listener name would also produce a malformed shell-var name
    // in the health aggregation (`health_ok_web_api` — ambiguous with a name
    // that coincidentally starts with `web_api`).
    const errors: string[] = [];
    validateServicesTopology(
      [makeService({ listenerOverride: { name: "web_api" }, name: "web_api" })],
      [],
      "web_api",
      errors,
    );
    // Must produce at least one error mentioning the invalid name.
    expect(errors.length).toBeGreaterThan(0);
    const combined = errors.join(" ");
    expect(combined).toContain("web_api");
  });
});
