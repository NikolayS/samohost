/**
 * Caddy vhost renderer tests (PR: feat(caddy) shared prod+preview vhost renderer).
 *
 * RED commit: tests written, src/caddy/render.ts does not exist yet.
 *
 * Test categories:
 *   Structural (no caddy binary needed):
 *     cv-*  renderVhost output shape, quoting, order
 *   caddy-adapt integration (require caddy binary):
 *     caddy-a1  planFromApp(samographSpec) adapt-equals hand-authored prod fixture
 *     caddy-a2  zero-routes render adapt-equals zero-routes fixture
 *     caddy-a3  route ORDER preserved into adapted JSON route array
 *     caddy-a4  cp-http80 vhost passes caddy validate
 *     caddy-a5  tls-internal vhost passes caddy validate
 *     caddy-a6  path-with-space: ONE double-quoted matcher token (not two)
 *
 * CI gate:
 *   SAMOHOST_REQUIRE_CADDY=1 → hard-fail if caddy binary is absent (never silently skip).
 *   Locally without caddy: caddy-a* tests are skipped via test.skipIf.
 */

import { describe, expect, test } from "bun:test";
import {
  renderVhost,
  planFromApp,
  planFromEnv,
  type VhostPlan,
} from "../src/caddy/render.ts";
import type { AppSpec, EnvRecord } from "../src/types.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Monotonic counter — guarantees unique tmp filenames even when multiple
// adaptJson / validateCaddyfile calls are fired concurrently via Promise.all.
// Date.now() alone is insufficient: concurrent calls within the same ms share
// the same timestamp and collide, causing one caddy process to read a file
// that the other already cleaned up.
// ---------------------------------------------------------------------------

let _tmpSeq = 0;
function tmpSeq(): string {
  return String(++_tmpSeq).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Caddy binary check — hard-fail in CI, skip locally
// ---------------------------------------------------------------------------

const caddyBin = Bun.which("caddy");
const requireCaddy = process.env.SAMOHOST_REQUIRE_CADDY === "1";
if (!caddyBin && requireCaddy) {
  throw new Error(
    "SAMOHOST_REQUIRE_CADDY=1 but caddy binary not found in PATH — " +
      "CI must install Caddy v2.11.4 before running tests",
  );
}
const hasCaddy = !!caddyBin;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureDir = join(__dirname, "fixtures");

/** Live hand-authored prod vhost: /etc/caddy/sites.d/00-main-samograph.caddy */
const samographProdFixture = readFileSync(
  join(fixtureDir, "samograph-main-vhost.caddy"),
  "utf8",
);

/** Zero-routes single-reverse-proxy reference snippet. */
const zeroRoutesFixture = readFileSync(
  join(fixtureDir, "samograph-zero-routes-vhost.caddy"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Samograph AppSpec — mirrors live prod file ports + routes exactly.
//
// DELIBERATE FIXTURE DIFF (PR note): the hand file's comment header contains
// a human summary ("control-plane Caddy (91.99.233.145)"). The renderer emits
// its own provenance header. caddy adapt strips ALL comments before producing
// JSON, so adapt-JSON equality holds despite the header difference.
//
// NO /health route: the prod file 00-main-samograph.caddy has no /health handle
// (that exists only in the preview samograph-main.caddy). planFromApp renders
// PROD PARITY — we do NOT inject a /health route.
// ---------------------------------------------------------------------------

const samographApp: AppSpec = {
  name: "samograph",
  repo: "acme/samograph",
  branch: "main",
  appDir: "/opt/samograph/app",
  buildCmd: "npm run build",
  healthUrl: "http://localhost:3000/health",
  serviceUnit: "samograph",
  mainHost: "samograph.samo.team",
  mainListen: "cp-http80",
  services: [
    {
      name: "web",
      unit: "samograph",
      listeners: [{ name: "web", port: 3000, portEnv: "PORT" }],
    },
    {
      name: "ws-hub",
      unit: "samograph-ws-hub",
      listeners: [{ name: "ws-hub", port: 8888, portEnv: "WS_HUB_PORT" }],
    },
    {
      name: "ingest",
      unit: "samograph-ingest",
      listeners: [{ name: "ingest", port: 8189, portEnv: "INGEST_PORT" }],
    },
  ],
  routes: [
    {
      name: "stream",
      matchRegexp: "^/calls/[^/]+/stream$",
      to: "ws-hub",
    },
    { matchPath: "/webhook*", to: "ingest" },
    {
      name: "transcript",
      matchRegexp: "^/calls/[^/]+/transcript",
      to: "ws-hub",
    },
    { matchPath: "/__dev*", respond: { status: 404, body: "not found" } },
  ],
  defaultListener: "web",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `caddy adapt` on a Caddyfile string and return the parsed JSON. */
async function adaptJson(caddyfile: string): Promise<unknown> {
  const tmpFile = `/tmp/samohost-caddy-adapt-${process.pid}-${tmpSeq()}.caddy`;
  await Bun.write(tmpFile, caddyfile);

  const proc = Bun.spawn(
    ["caddy", "adapt", "--config", tmpFile, "--adapter", "caddyfile"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  // Best-effort cleanup
  try {
    const fs = await import("fs/promises");
    await fs.unlink(tmpFile);
  } catch {
    /* ignore */
  }

  if (exitCode !== 0) {
    throw new Error(
      `caddy adapt failed (exit ${exitCode}): ${stderr}\n` +
        `--- Caddyfile:\n${caddyfile}`,
    );
  }

  return JSON.parse(stdout) as unknown;
}

/** Run `caddy validate` on a Caddyfile string; throws on non-zero exit. */
async function validateCaddyfile(caddyfile: string): Promise<void> {
  const tmpFile = `/tmp/samohost-caddy-validate-${process.pid}-${tmpSeq()}.caddy`;
  await Bun.write(tmpFile, caddyfile);

  const proc = Bun.spawn(
    ["caddy", "validate", "--config", tmpFile, "--adapter", "caddyfile"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  try {
    const fs = await import("fs/promises");
    await fs.unlink(tmpFile);
  } catch {
    /* ignore */
  }

  if (exitCode !== 0) {
    throw new Error(
      `caddy validate failed (exit ${exitCode}): ${stderr}\n` +
        `--- Caddyfile:\n${caddyfile}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Structural tests — no caddy binary required
// ---------------------------------------------------------------------------

describe("renderVhost — structural", () => {
  describe("cv-0: zero routes → single reverse_proxy back-compat", () => {
    test("zero routes emits exactly one reverse_proxy handle", () => {
      const plan: VhostPlan = {
        host: "myapp.samo.cat",
        listen: "tls-internal",
        routes: [],
        defaultPort: 3000,
        logFile: "/var/log/caddy/myapp.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain("reverse_proxy localhost:3000");
      // No path_regexp named matchers
      expect(out).not.toContain("path_regexp");
    });
  });

  describe("cv-1: cp-http80 listen mode", () => {
    test("emits http:// scheme + port 80, no tls internal", () => {
      const plan: VhostPlan = {
        host: "samograph.samo.team",
        listen: "cp-http80",
        routes: [],
        defaultPort: 3000,
        logFile: "/var/log/caddy/samograph-prod.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain("http://samograph.samo.team:80");
      expect(out).not.toContain("tls internal");
    });
  });

  describe("cv-2: tls-internal listen mode", () => {
    test("emits bare host block + tls internal, no http:// prefix", () => {
      const plan: VhostPlan = {
        host: "myapp.samo.cat",
        listen: "tls-internal",
        routes: [],
        defaultPort: 3000,
        logFile: "/var/log/caddy/myapp.log",
      };
      const out = renderVhost(plan);
      // The site address is the bare hostname (no scheme)
      expect(out).toContain("myapp.samo.cat {");
      expect(out).toContain("tls internal");
      expect(out).not.toContain("http://");
    });
  });

  describe("cv-3: route + matcher order preserved", () => {
    test("named matchers declared in spec order, handles emitted in spec order", () => {
      const plan: VhostPlan = {
        host: "test.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            name: "alpha",
            matcher: { regexp: "^/alpha" },
            target: { port: 3001 },
          },
          { matcher: { path: "/beta*" }, target: { port: 3002 } },
          {
            name: "gamma",
            matcher: { regexp: "^/gamma" },
            target: { port: 3003 },
          },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/test.log",
      };
      const out = renderVhost(plan);

      // Named matchers declared before any handle block
      const alphaDecl = out.indexOf("@alpha path_regexp");
      const gammaDecl = out.indexOf("@gamma path_regexp");
      const firstHandle = out.indexOf("handle @");
      expect(alphaDecl).toBeGreaterThan(-1);
      expect(gammaDecl).toBeGreaterThan(alphaDecl);
      expect(firstHandle).toBeGreaterThan(gammaDecl);

      // Handle blocks in spec order
      const handleAlpha = out.indexOf("handle @alpha");
      const handleBeta = out.indexOf('handle "/beta*"');
      const handleGamma = out.indexOf("handle @gamma");
      expect(handleAlpha).toBeLessThan(handleBeta);
      expect(handleBeta).toBeLessThan(handleGamma);
    });
  });

  describe("cv-4: double-quoting of path matchers", () => {
    test("path matcher value is wrapped in double quotes", () => {
      const plan: VhostPlan = {
        host: "test.samo.cat",
        listen: "tls-internal",
        routes: [{ matcher: { path: "/webhook*" }, target: { port: 3001 } }],
        defaultPort: 3000,
        logFile: "/var/log/caddy/test.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain('"/webhook*"');
    });
  });

  describe("cv-5: double-quoting of regexp matchers", () => {
    test("regexp value in named matcher declaration is double-quoted", () => {
      const plan: VhostPlan = {
        host: "test.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            name: "stream",
            matcher: { regexp: "^/calls/[^/]+/stream$" },
            target: { port: 8888 },
          },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/test.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain('"^/calls/[^/]+/stream$"');
    });
  });

  describe("cv-6: double-quoting of respond body", () => {
    test("respond body is wrapped in double quotes", () => {
      const plan: VhostPlan = {
        host: "test.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            matcher: { path: "/__dev*" },
            target: { respond: { status: 404, body: "not found" } },
          },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/test.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain('"not found"');
    });
  });

  describe("cv-7: JSON access log block", () => {
    test("emits log block with plan.logFile and json format", () => {
      const plan: VhostPlan = {
        host: "myapp.samo.cat",
        listen: "tls-internal",
        routes: [],
        defaultPort: 3000,
        logFile: "/var/log/caddy/myapp.log",
      };
      const out = renderVhost(plan);
      expect(out).toContain("log {");
      expect(out).toContain("output file /var/log/caddy/myapp.log");
      expect(out).toContain("format json");
    });
  });

  describe("cv-8: default handle is always LAST (after all route handles)", () => {
    test("default reverse_proxy appears after all named handles", () => {
      const plan: VhostPlan = {
        host: "test.samo.cat",
        listen: "tls-internal",
        routes: [
          { matcher: { path: "/api*" }, target: { port: 4000 } },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/test.log",
      };
      const out = renderVhost(plan);
      const apiHandleIdx = out.indexOf('"/api*"');
      const defaultHandleIdx = out.lastIndexOf("reverse_proxy localhost:3000");
      expect(apiHandleIdx).toBeGreaterThan(-1);
      expect(defaultHandleIdx).toBeGreaterThan(apiHandleIdx);
    });
  });

  describe("cv-9: planFromApp produces correct plan for samograph prod", () => {
    test("host, listen, defaultPort, logFile match expected prod values", () => {
      const plan = planFromApp(samographApp);
      expect(plan.host).toBe("samograph.samo.team");
      expect(plan.listen).toBe("cp-http80");
      expect(plan.defaultPort).toBe(3000);
      expect(plan.logFile).toBe("/var/log/caddy/samograph-prod.log");
    });

    test("routes are converted in spec order (4 routes)", () => {
      const plan = planFromApp(samographApp);
      expect(plan.routes).toHaveLength(4);
    });

    test("route 0 (stream regexp) → name=stream, regexp, port=8888", () => {
      const plan = planFromApp(samographApp);
      const r = plan.routes[0]!;
      expect(r.name).toBe("stream");
      expect(r.matcher).toEqual({ regexp: "^/calls/[^/]+/stream$" });
      expect(r.target).toEqual({ port: 8888 });
    });

    test("route 1 (webhook path) → no name, path=/webhook*, port=8189", () => {
      const plan = planFromApp(samographApp);
      const r = plan.routes[1]!;
      expect(r.name).toBeUndefined();
      expect(r.matcher).toEqual({ path: "/webhook*" });
      expect(r.target).toEqual({ port: 8189 });
    });

    test("route 3 (__dev* path) → respond 404", () => {
      const plan = planFromApp(samographApp);
      const r = plan.routes[3]!;
      expect(r.target).toEqual({ respond: { status: 404, body: "not found" } });
    });
  });

  describe("cv-10: planFromEnv produces correct plan for preview env", () => {
    const previewEnv: EnvRecord = {
      id: "env-preview-1",
      vmId: "vm-1",
      appName: "samograph",
      branch: "main",
      name: "samograph-main",
      port: 3100,
      vhost: "samograph-main.samo.cat",
      dbBackend: "dblab",
      createdAt: new Date().toISOString(),
      ports: {
        web: 3100,
        "ws-hub": 8788,
        ingest: 8089,
      },
    };

    test("host = target.vhost", () => {
      const plan = planFromEnv(samographApp, previewEnv);
      expect(plan.host).toBe("samograph-main.samo.cat");
    });

    test("listen = tls-internal", () => {
      const plan = planFromEnv(samographApp, previewEnv);
      expect(plan.listen).toBe("tls-internal");
    });

    test("defaultPort comes from target.ports[defaultListener]", () => {
      const plan = planFromEnv(samographApp, previewEnv);
      expect(plan.defaultPort).toBe(3100); // web listener
    });

    test("logFile = /var/log/caddy/<env.name>.log", () => {
      const plan = planFromEnv(samographApp, previewEnv);
      expect(plan.logFile).toBe("/var/log/caddy/samograph-main.log");
    });

    test("route ports come from target.ports (preview port allocation)", () => {
      const plan = planFromEnv(samographApp, previewEnv);
      // stream → ws-hub → 8788
      expect(plan.routes[0]!.target).toEqual({ port: 8788 });
      // webhook → ingest → 8089
      expect(plan.routes[1]!.target).toEqual({ port: 8089 });
    });
  });
});

// ---------------------------------------------------------------------------
// caddy-adapt integration tests — skipped locally if caddy absent, hard-fail
// in CI via SAMOHOST_REQUIRE_CADDY=1.
// ---------------------------------------------------------------------------

describe("caddy-adapt integration", () => {
  // caddy-a1: samograph prod parity — the rendered vhost is Caddy-SEMANTICALLY
  // identical to the battle-proven hand-authored prod file.
  //
  // DELIBERATE FIXTURE DIFFS (adjudicated):
  //   - Comment header: fixture has a human-written header; renderer emits
  //     its own provenance header. caddy adapt strips ALL comments → equality holds.
  //   - Quoting: fixture uses unquoted `/webhook*`; renderer double-quotes all
  //     embedded values → `"/webhook*"`. Caddy's parser is quote-transparent for
  //     tokens without whitespace → JSON-equal after adapt.
  //   - No /health route: prod fixture has no /health handle (that exists only in
  //     the preview samograph-main.caddy). planFromApp renders PROD PARITY.
  test.skipIf(!hasCaddy)(
    "caddy-a1: planFromApp(samograph) adapt-equals the hand-authored prod fixture",
    async () => {
      const plan = planFromApp(samographApp);
      const rendered = renderVhost(plan);
      const [adaptedRendered, adaptedFixture] = await Promise.all([
        adaptJson(rendered),
        adaptJson(samographProdFixture),
      ]);
      expect(adaptedRendered).toEqual(adaptedFixture);
    },
  );

  // caddy-b2: zero-routes back-compat — legacy single-service form produces
  // the same adapted JSON as the hand-written zero-routes fixture.
  test.skipIf(!hasCaddy)(
    "caddy-a2: zero-routes render adapt-equals the zero-routes reference fixture",
    async () => {
      const plan: VhostPlan = {
        host: "samograph-zero.samo.cat",
        listen: "tls-internal",
        routes: [],
        defaultPort: 3000,
        logFile: "/var/log/caddy/samograph-zero.log",
      };
      const rendered = renderVhost(plan);
      const [adaptedRendered, adaptedFixture] = await Promise.all([
        adaptJson(rendered),
        adaptJson(zeroRoutesFixture),
      ]);
      expect(adaptedRendered).toEqual(adaptedFixture);
    },
  );

  // caddy-a3: route order is preserved — reordering the spec changes the
  // adapted JSON route array. Proves Caddy's first-match semantics are preserved.
  test.skipIf(!hasCaddy)(
    "caddy-a3: reordering routes in spec changes adapted JSON route order",
    async () => {
      const basePlan: VhostPlan = {
        host: "order-test.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            name: "first",
            matcher: { regexp: "^/alpha" },
            target: { port: 3001 },
          },
          { matcher: { path: "/beta*" }, target: { port: 3002 } },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/order-test.log",
      };
      const swappedPlan: VhostPlan = {
        ...basePlan,
        routes: [
          { matcher: { path: "/beta*" }, target: { port: 3002 } },
          {
            name: "first",
            matcher: { regexp: "^/alpha" },
            target: { port: 3001 },
          },
        ],
      };
      const [adapted1, adapted2] = await Promise.all([
        adaptJson(renderVhost(basePlan)),
        adaptJson(renderVhost(swappedPlan)),
      ]);
      // Route order must differ — NOT equal
      expect(adapted1).not.toEqual(adapted2);
    },
  );

  // caddy-a4 + caddy-a5: caddy validate passes for both listen modes.
  //
  // NOTE on logFile: caddy validate actually tries to open the log file writer
  // (including mkdir of the parent directory). In CI the runner has no
  // permission to create /var/log/caddy/. We use a /tmp/ path for these two
  // tests only — the goal is to prove the STRUCTURE is valid (site address,
  // matchers, handles), not the production log path.
  test.skipIf(!hasCaddy)(
    "caddy-a4: cp-http80 vhost passes caddy validate",
    async () => {
      const plan: VhostPlan = {
        host: "samograph.samo.team",
        listen: "cp-http80",
        routes: [
          {
            name: "stream",
            matcher: { regexp: "^/calls/[^/]+/stream$" },
            target: { port: 8888 },
          },
          { matcher: { path: "/webhook*" }, target: { port: 8189 } },
        ],
        defaultPort: 3000,
        // /tmp/ is writable in CI; /var/log/caddy/ requires root (caddy
        // validate tries to open the log writer, not just parse the config).
        logFile: `/tmp/caddy-validate-test-${process.pid}.log`,
      };
      await validateCaddyfile(renderVhost(plan));
      // If we reach here, validate returned exit 0
      expect(true).toBe(true);
    },
  );

  test.skipIf(!hasCaddy)(
    "caddy-a5: tls-internal vhost passes caddy validate",
    async () => {
      const plan: VhostPlan = {
        host: "myapp.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            name: "api",
            matcher: { regexp: "^/api/" },
            target: { port: 4000 },
          },
        ],
        defaultPort: 3000,
        logFile: `/tmp/caddy-validate-test-${process.pid}.log`,
      };
      await validateCaddyfile(renderVhost(plan));
      expect(true).toBe(true);
    },
  );

  // caddy-a6: path-with-space quoting proof.
  // A path containing a space MUST be double-quoted or Caddy parses it as
  // two separate tokens, breaking the config. Proves the quoting is both
  // present in output AND accepted by caddy adapt as ONE path matcher.
  test.skipIf(!hasCaddy)(
    "caddy-a6: path with space renders as ONE double-quoted matcher (not two tokens)",
    async () => {
      const plan: VhostPlan = {
        host: "quote-test.samo.cat",
        listen: "tls-internal",
        routes: [
          {
            matcher: { path: "/api/path with space*" },
            target: { port: 3001 },
          },
        ],
        defaultPort: 3000,
        logFile: "/var/log/caddy/quote-test.log",
      };
      const rendered = renderVhost(plan);

      // Structural: the quoted form is in the output
      expect(rendered).toContain('"/api/path with space*"');

      // Semantic: caddy adapt succeeds AND the adapted route has exactly ONE
      // path matcher with the full value (not two broken partial paths)
      const adapted = await adaptJson(rendered);

      // Navigate to inner routes inside the host subroute
      // Structure: apps.http.servers.srv0.routes[0].handle[0].routes[...]
      const srv = Object.values(
        (adapted as Record<string, unknown> & {
          apps: { http: { servers: Record<string, unknown> } };
        }).apps.http.servers,
      )[0] as {
        routes: Array<{
          handle: Array<{ routes: Array<{ match?: Array<{ path?: string[] }> }> }>;
        }>;
      };

      const innerRoutes = srv.routes[0]!.handle[0]!.routes;
      // Find the route that has our space-containing path
      const pathRoute = innerRoutes.find(
        (r) =>
          Array.isArray(r.match) &&
          r.match.some(
            (m) =>
              Array.isArray(m.path) &&
              m.path.includes("/api/path with space*"),
          ),
      );
      expect(pathRoute).toBeDefined();
      // Exactly ONE match object with ONE path value
      expect(pathRoute!.match).toHaveLength(1);
      expect(pathRoute!.match![0]!.path).toEqual(["/api/path with space*"]);
    },
  );
});
