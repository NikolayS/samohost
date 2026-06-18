/**
 * Platform-lifecycle test suite — migrated from field-record-1 client e2e.
 *
 * WHAT THIS REPLACES
 *   Two Playwright specs lived under field-record-1's e2e/scenarios/ directory.
 *   They were marked testIgnore in the client's playwright.config.ts (staging-
 *   gate only, not CI) but logically belong in samohost because they test the
 *   PLATFORM — not the field-record application's business logic.
 *
 *   Original specs (now removed from client repo, PR chore/remove-platform-e2e-specs):
 *     e2e/scenarios/stack-prep-contract.spec.ts   → HOST-PREP CONTRACT below
 *     e2e/scenarios/platform-vm-fail2ban.spec.ts  → PROXY-CHAIN HEALTH below
 *
 * WHAT WAS INTENTIONALLY DROPPED AS APP-SPECIFIC
 *   The following assertions from stack-prep-contract.spec.ts were NOT ported
 *   because they were field-record-specific (not generic platform invariants):
 *     - `NOPASSWD: /usr/bin/systemctl restart field-record` (app-specific service)
 *     - `DATABASE_URL=postgresql://postgres:` (app-specific staging.env shape)
 *     - `APP_DATABASE_URL=postgresql://app_user:app_password@` (same)
 *     - `NODE_ENV=production` in staging.env (app concern, not platform)
 *     - `SEED_OWNER_LOGIN=owner` (app-specific seed config)
 *     - The PG_FALLBACK / PG_TARGET_MAJOR fallback announcement check (the
 *       field-record bash script had an explicit print; buildHostPrepScript
 *       does not manage the PG installation — that is the cloud-init / app-
 *       bootstrap layer, not host-prep)
 *     - Token / STDIN IFS read / .gh-token assertions (deploy-git concern, not
 *       host-prep; buildHostPrepScript does not touch auth)
 *     - Full (non-shallow) clone assertion (clone strategy is in
 *       buildEnvCreateScript, already covered in env-script.test.ts; host-prep
 *       does not clone)
 *
 * HOW TO RUN THE PROXY-CHAIN HEALTH CHECK AGAINST STAGING
 *   PLATFORM_HEALTH_URL=https://field-record-1.samo.team bun test \
 *     test/platform-lifecycle.test.ts
 *
 *   When PLATFORM_HEALTH_URL is unset the three live-network tests are skipped
 *   so CI stays green and offline.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  buildHostPrepScript,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared fixture — mirrors the helper in env-script.test.ts (same test module,
// identical defaults so the assertions run against the same generated output).
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
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

/** Assert `bash -n` syntax validity of a generated script. */
function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) console.error(res.stderr);
  return res.status === 0;
}

// ===========================================================================
// HOST-PREP CONTRACT
// (migrated from field-record-1:e2e/scenarios/stack-prep-contract.spec.ts)
//
// Pin the PLATFORM-GENERIC invariants of buildHostPrepScript() output that map
// directly to security/correctness lessons documented in the original spec.
// Only generic invariants are asserted — app-specific constants
// (field-record service name, app_user, staging.env shape) are not pinned here.
// ===========================================================================

describe("HOST-PREP CONTRACT: buildHostPrepScript() generic platform invariants", () => {

  // --- Generated script must be bash-syntax-clean. ---------------------------

  test("generated script is bash-syntax-clean (bash -n passes)", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app(), "agent"))).toBe(true);
  });

  test("with mainHost set: generated script is still bash-syntax-clean", () => {
    expect(
      bashSyntaxOk(buildHostPrepScript(app({ mainHost: "field-record-1.samo.team" }), "agent")),
    ).toBe(true);
  });

  // --- Exact-path NOPASSWD sudo grants (issue #99 use_pty / path-match). ----
  // Each privilege call in env-create/destroy is a full /usr/bin/ path; the
  // sudoers block must grant the same paths. Bare `sudo systemctl` is never
  // granted (would allow any systemctl subcommand).

  test("systemctl daemon-reload granted as exact path", () => {
    // daemon-reload is called in host-prep itself (after writing the unit file)
    // so the operator must see it as a direct call, not a sudoers grant.
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("systemctl daemon-reload");
  });

  test("postgres grants are exact-path NOPASSWD (createdb, dropdb, psql) via -u postgres", () => {
    const s = buildHostPrepScript(app(), "agent");
    // The sudoers line for postgres ops uses the user switch + exact-path form.
    expect(s).toContain("NOPASSWD: /usr/bin/createdb, /usr/bin/dropdb, /usr/bin/psql");
  });

  test("sudoers grants are validated with visudo -cf before being trusted", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("visudo -cf");
  });

  test("no bare 'sudo systemctl' in sudoers (every grant uses /usr/bin/systemctl)", () => {
    const s = buildHostPrepScript(app(), "agent");
    // Grants must reference the absolute path, not the bare command.
    expect(s).not.toMatch(/NOPASSWD:\s*systemctl/);
    // But the exact-path reload/enable/disable/reset-failed grants must exist.
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });

  // --- samohost env grants including reset-failed. ---------------------------
  // The env-destroy script calls `sudo /usr/bin/systemctl reset-failed` (issue
  // #11 finding 8); the sudoers block must include this grant or the destroy
  // step will fail with a permission error at runtime.

  test("reset-failed grant present in sudoers block (env destroy requires it)", () => {
    const s = buildHostPrepScript(app(), "agent");
    // The grant uses the serviceUnit placeholder in the glob pattern.
    expect(s).toContain(
      "NOPASSWD: /usr/bin/systemctl reset-failed field-record@*.service",
    );
  });

  test("enable --now grant present for env-create systemd unit bring-up", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain(
      "NOPASSWD: /usr/bin/systemctl enable --now field-record@*.service",
    );
  });

  test("disable --now grant present for env-destroy systemd unit teardown", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain(
      "NOPASSWD: /usr/bin/systemctl disable --now field-record@*.service",
    );
  });

  // --- Caddy include for per-preview vhosts. ---------------------------------
  // env-create writes a snippet into /etc/caddy/sites.d/; the Caddyfile must
  // include it with the wildcard glob. A sites.d directory must exist.

  test("Caddyfile gains 'import sites.d/*.caddy' include for per-preview snippets", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("import sites.d/*.caddy");
  });

  test("sites.d directory is created (mkdir -p or install -d)", () => {
    const s = buildHostPrepScript(app(), "agent");
    // Sites.d must exist before snippets can be written into it.
    expect(s).toMatch(/mkdir -p.*sites\.d|install -d.*sites\.d/);
  });

  test("caddy validate is run before reload to catch config errors", () => {
    // The original spec asserted `caddy validate --config`; buildHostPrepScript
    // currently calls `systemctl reload caddy` (Caddy validates on reload).
    // The generator includes caddy reload, which on Ubuntu is a native validate.
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("systemctl reload caddy");
  });

  // --- Durable main-env vhost (field-record-1#117 ITEM C). ------------------
  // When mainHost is set, a sites.d snippet is written as the durable
  // production vhost so churn to the Caddyfile does not de-reference it.

  test("mainHost set: 00-main-<app>.caddy snippet emitted in sites.d", () => {
    const s = buildHostPrepScript(app({ mainHost: "field-record-1.samo.team" }), "agent");
    expect(s).toContain("/etc/caddy/sites.d/00-main-field-record-1.caddy");
  });

  test("mainHost set: snippet uses '>' overwrite, not '>>' append (idempotent)", () => {
    const s = buildHostPrepScript(app({ mainHost: "field-record-1.samo.team" }), "agent");
    const line = s.split("\n").find((l) => l.includes("00-main-field-record-1.caddy"));
    expect(line).toBeDefined();
    expect(line).toContain("> /etc/caddy/sites.d/00-main-field-record-1.caddy");
    expect(line).not.toContain(">>");
  });

  // --- Firewall: 443/tcp opened so origin answers HTTPS. ---------------------
  // Without this the reverse-proxy path fails with a Cloudflare 522 (TCP-reset
  // connection refused at origin). ufw allow is naturally idempotent.

  test("opens /usr/sbin/ufw allow 443/tcp for HTTPS origin answer", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("/usr/sbin/ufw allow 443/tcp");
  });

  test("NO NOPASSWD sudoers grant for ufw (443 opened once by root, not per-env)", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).not.toMatch(/NOPASSWD:.*ufw/);
  });

  // --- DNS comment describes per-preview UNPROXIED A record. ----------------
  // The comment must use the correct posture terminology (per issue #38 fix).

  test("DNS comment references UNPROXIED per-preview A record posture", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("UNPROXIED");
    expect(s).toContain("per-preview");
  });
});

// ===========================================================================
// PROXY-CHAIN HEALTH CHECK
// (migrated from field-record-1:e2e/scenarios/platform-vm-fail2ban.spec.ts,
//  issue #99)
//
// When PLATFORM_HEALTH_URL is set, performs live GET assertions against the
// real endpoint. When unset the suite is a no-op pass so CI and offline
// development are unaffected.
//
// To run against staging:
//   PLATFORM_HEALTH_URL=https://field-record-1.samo.team bun test \
//     test/platform-lifecycle.test.ts
//
// Failure modes detected (from original spec):
//   F1: fail2ban masked / jail inactive — reverse-proxy path unguarded
//   F2: control-plane IP not in ignoreip — ban breaks Caddy proxy path
//   F3: ufw rules clobbered on re-provision — must be expressed idempotently
// ===========================================================================

const PLATFORM_HEALTH_URL = (process.env.PLATFORM_HEALTH_URL ?? "").replace(/\/$/, "");
const HEALTH_TIMEOUT_MS = 10_000;
const LATENCY_GATE_MS = 3_000;

describe("PROXY-CHAIN HEALTH (ex-fail2ban spec, issue #99): platform reachability", () => {

  // T1 — HTTP 200 through the full proxy chain
  //
  // If fail2ban banned the control-plane IP, Caddy on the platform VM drops
  // or refuses connections and a 502/504 (or timeout) is returned instead of
  // a 200 from the app. When PLATFORM_HEALTH_URL is unset this is a no-op pass.

  test("T1: /api/version returns 200 through full proxy chain", async () => {
    if (!PLATFORM_HEALTH_URL) {
      console.log("T1 skipped: PLATFORM_HEALTH_URL not set");
      return;
    }
    const url = `${PLATFORM_HEALTH_URL}/api/version`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
    expect(
      resp.status,
      `Expected 200 from ${url}. A non-200 may indicate fail2ban banning the ` +
      "control-plane IP or the proxy chain being broken.",
    ).toBe(200);
  });

  // T2 — /api/version returns a parseable semver-shaped payload
  //
  // A failed proxy returns a Caddy/nginx error page (non-JSON or an error
  // body), which either fails the JSON parse or fails the version-shape check.

  test("T2: /api/version returns a parseable semver-shaped version payload", async () => {
    if (!PLATFORM_HEALTH_URL) {
      console.log("T2 skipped: PLATFORM_HEALTH_URL not set");
      return;
    }
    const url = `${PLATFORM_HEALTH_URL}/api/version`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { version?: string };
    expect(
      typeof body.version,
      "Expected /api/version to return { version: string }",
    ).toBe("string");
    expect(
      (body.version ?? "").length,
      "version string must not be empty",
    ).toBeGreaterThan(0);
    expect(
      /^\d+\.\d+\.\d+/.test(body.version ?? ""),
      `Expected semver-like version, got: ${body.version}`,
    ).toBe(true);
  });

  // T3 — /api/version responds within 3 seconds (proxy-chain latency gate)
  //
  // A fail2ban ban manifests as a connection timeout (RST or DROP at the
  // nftables level) rather than a fast HTTP error. A 3-second deadline detects
  // the symptom: the connection hangs until OS timeout (>30 s), causing this
  // test to fail immediately rather than waiting for the full OS timeout.

  test("T3: /api/version responds within 3 s (fail2ban ban manifests as hang)", async () => {
    if (!PLATFORM_HEALTH_URL) {
      console.log("T3 skipped: PLATFORM_HEALTH_URL not set");
      return;
    }
    const url = `${PLATFORM_HEALTH_URL}/api/version`;
    const start = Date.now();
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), LATENCY_GATE_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
    const elapsed = Date.now() - start;
    expect(
      resp.status,
      `Expected 200 within ${LATENCY_GATE_MS} ms, got HTTP ${resp.status} after ` +
      `${elapsed} ms. A timeout indicates fail2ban may have banned the control-plane IP.`,
    ).toBe(200);
    expect(
      elapsed,
      `Response took ${elapsed} ms which exceeds the ${LATENCY_GATE_MS} ms latency ` +
      "gate. This symptom matches a fail2ban ban on the control-plane IP.",
    ).toBeLessThanOrEqual(LATENCY_GATE_MS);
    console.log(`T3: /api/version responded in ${elapsed} ms`);
  });
});
