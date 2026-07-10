/**
 * servicesOf() synthesis tests (PR: multi-service spec model).
 *
 * RED commit: tests written, src/app/services.ts does not exist yet.
 *
 * Covers:
 *   - Legacy app (no services field) → synthesized single-service shape,
 *     port derived from healthUrl, byte-identical across two calls.
 *   - Multi-service app (services present) → declared values returned as-is,
 *     no mutation.
 */

import { describe, expect, test } from "bun:test";
import { servicesOf } from "../src/app/services.ts";
import type { AppRecord, ServiceSpec } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function legacyApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-test-1",
    vmId: "vm-1111",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Legacy app synthesis
// ---------------------------------------------------------------------------

describe("servicesOf — legacy app (no services field)", () => {
  test("svc-1: synthesizes a single 'web' service", () => {
    const app = legacyApp();
    const { services } = servicesOf(app);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("web");
  });

  test("svc-2: synthesized service unit matches app.serviceUnit", () => {
    const app = legacyApp();
    const { services } = servicesOf(app);
    expect(services[0]!.unit).toBe("field-record");
  });

  test("svc-3: synthesized listener name is 'web'", () => {
    const app = legacyApp();
    const { services } = servicesOf(app);
    const listener = services[0]!.listeners[0]!;
    expect(listener.name).toBe("web");
  });

  test("svc-4: synthesized listener port is derived from healthUrl (3000)", () => {
    const app = legacyApp(); // healthUrl port = 3000
    const { services } = servicesOf(app);
    const listener = services[0]!.listeners[0]!;
    expect(listener.port).toBe(3000);
  });

  test("svc-5: synthesized listener portEnv is 'PORT'", () => {
    const app = legacyApp();
    const { services } = servicesOf(app);
    const listener = services[0]!.listeners[0]!;
    expect(listener.portEnv).toBe("PORT");
  });

  test("svc-6: synthesized listener healthPath is '/'", () => {
    const app = legacyApp();
    const { services } = servicesOf(app);
    const listener = services[0]!.listeners[0]!;
    expect(listener.healthPath).toBe("/");
  });

  test("svc-7: synthesized routes is an empty array", () => {
    const app = legacyApp();
    const { routes } = servicesOf(app);
    expect(routes).toEqual([]);
  });

  test("svc-8: synthesized defaultListener is 'web'", () => {
    const app = legacyApp();
    const { defaultListener } = servicesOf(app);
    expect(defaultListener).toBe("web");
  });

  test("svc-9: healthUrl with port 8080 → listener port 8080", () => {
    const app = legacyApp({ healthUrl: "http://localhost:8080/health" });
    const { services } = servicesOf(app);
    expect(services[0]!.listeners[0]!.port).toBe(8080);
  });

  test("svc-10: healthUrl with no explicit port (http) → port 80", () => {
    const app = legacyApp({ healthUrl: "http://myapp.example.com/health" });
    const { services } = servicesOf(app);
    expect(services[0]!.listeners[0]!.port).toBe(80);
  });

  test("svc-11: healthUrl with no explicit port (https) → port 443", () => {
    const app = legacyApp({ healthUrl: "https://myapp.example.com/health" });
    const { services } = servicesOf(app);
    expect(services[0]!.listeners[0]!.port).toBe(443);
  });

  test("svc-12: result is byte-identical across two calls (no mutation)", () => {
    const app = legacyApp();
    const first = servicesOf(app);
    const second = servicesOf(app);
    expect(first).toEqual(second);
    // Verify the app object was not mutated
    expect(app.services).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-service app — declared shape returned as-is
// ---------------------------------------------------------------------------

describe("servicesOf — multi-service app (services field present)", () => {
  function multiApp(): AppRecord {
    const services: ServiceSpec[] = [
      {
        name: "web",
        unit: "field-record",
        listeners: [
          { name: "web", port: 3000, portEnv: "PORT", healthPath: "/", routed: true },
        ],
      },
      {
        name: "worker",
        unit: "field-record-worker",
        listeners: [
          { name: "metrics", port: 9100, portEnv: "METRICS_PORT" },
        ],
      },
    ];
    return legacyApp({ services, defaultListener: "web", routes: [] });
  }

  test("svc-ms-1: declared services array returned unchanged", () => {
    const app = multiApp();
    const { services } = servicesOf(app);
    expect(services).toHaveLength(2);
    expect(services[0]!.name).toBe("web");
    expect(services[1]!.name).toBe("worker");
  });

  test("svc-ms-2: declared defaultListener returned unchanged", () => {
    const app = multiApp();
    const { defaultListener } = servicesOf(app);
    expect(defaultListener).toBe("web");
  });

  test("svc-ms-3: declared routes returned unchanged", () => {
    const app = multiApp();
    const { routes } = servicesOf(app);
    expect(routes).toEqual([]);
  });

  test("svc-ms-4: listener fields preserved exactly", () => {
    const app = multiApp();
    const { services } = servicesOf(app);
    const webListener = services[0]!.listeners[0]!;
    expect(webListener.name).toBe("web");
    expect(webListener.port).toBe(3000);
    expect(webListener.portEnv).toBe("PORT");
    expect(webListener.healthPath).toBe("/");
    expect(webListener.routed).toBe(true);
  });

  test("svc-ms-5: no mutation — app object untouched by servicesOf", () => {
    const app = multiApp();
    const originalServices = app.services;
    servicesOf(app);
    // Services reference should be identical (not cloned) and app not mutated
    expect(app.services).toBe(originalServices);
  });
});

// ---------------------------------------------------------------------------
// Fix 6b: servicesOf() MUST THROW (not fabricate) when defaultListener is
// missing or doesn't resolve to a declared listener.
//
// RED: current code fabricates via:
//   app.defaultListener ?? app.services[0]?.listeners[0]?.name ?? "web"
// This silently produces a dangling listener name and never errors.
// GREEN: after fix, servicesOf() throws with a descriptive message.
// ---------------------------------------------------------------------------

describe("servicesOf — throws on unresolvable defaultListener (Fix 6)", () => {
  function multiServiceApp(defaultListener?: string): AppRecord {
    return legacyApp({
      services: [
        {
          name: "web",
          unit: "my-app",
          listeners: [{ name: "web", port: 3000, portEnv: "PORT" }],
        },
      ],
      // If undefined, it's deliberately absent to test the missing case.
      ...(defaultListener !== undefined ? { defaultListener } : {}),
    });
  }

  test("svc-throw-1: defaultListener references nonexistent listener → throws", () => {
    // Currently: fabricates via app.services[0]?.listeners[0]?.name ("web") — no error.
    // After fix: throws because "ghost" is not in the declared listener set.
    const app = multiServiceApp("ghost");
    expect(() => servicesOf(app)).toThrow();
  });

  test("svc-throw-2: multi-service app with no defaultListener field → throws", () => {
    // Currently: fabricates via the fallback chain — returns "web" with no error.
    // After fix: throws because defaultListener is required for multi-service apps.
    const app = multiServiceApp(undefined);
    expect(() => servicesOf(app)).toThrow();
  });

  test("svc-throw-3: throw message describes the problem (not a generic error)", () => {
    const app = multiServiceApp("nonexistent");
    let msg = "";
    try {
      servicesOf(app);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Message must mention the bad listener name so the operator knows what to fix.
    expect(msg.toLowerCase()).toMatch(/nonexistent|defaultlistener|listener/i);
  });
});
