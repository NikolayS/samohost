/**
 * Multi-service spec synthesis helper (PR: multi-service app spec model).
 *
 * `servicesOf(app)` is the ONLY way consumers should access an app's service
 * topology. It normalises both legacy and multi-service apps into the same
 * shape so every downstream consumer (renderer, preview, prod host-prep) is
 * written once against ServiceSpec/RouteSpec regardless of manifest vintage.
 *
 * Back-compat backbone: legacy AppRecords carry NO `services` field. `servicesOf`
 * synthesizes the equivalent single-service shape on the fly, keeping the
 * produced value byte-identical to what a multi-service manifest would declare
 * for the same app.
 *
 * Synthesis rules for a legacy app (app.services === undefined):
 *   services = [{
 *     name:      "web",
 *     unit:      app.serviceUnit,
 *     listeners: [{
 *       name:       "web",
 *       port:       <derived from app.healthUrl>,
 *       portEnv:    "PORT",
 *       healthPath: "/",
 *     }],
 *   }]
 *   routes          = []
 *   defaultListener = "web"
 *
 * For a multi-service app (app.services is set), the declared
 * services/routes/defaultListener are returned as-is without mutation.
 */

import type { AppSpec, ListenerSpec, RouteSpec, ServiceSpec } from "../types.ts";

// ---------------------------------------------------------------------------
// Port derivation (mirrors mainEnvPort in env/script.ts — replicated here to
// avoid a cross-module import; bootstrap.ts does the same for the same reason)
// ---------------------------------------------------------------------------

/**
 * Derive the listen port from an AppSpec's healthUrl.
 * - Explicit port in the URL → use it.
 * - https:// with no port → 443.
 * - http://  with no port → 80.
 * Throws on unparseable URL (fail-closed: never synthesize a service pointing
 * at an unknown port).
 */
function portFromHealthUrl(healthUrl: string): number {
  let u: URL;
  try {
    u = new URL(healthUrl);
  } catch {
    throw new Error(
      `servicesOf: cannot derive port for legacy app: ` +
        `unparseable healthUrl ${JSON.stringify(healthUrl)}`,
    );
  }
  if (u.port !== "") return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ServicesView {
  services: ServiceSpec[];
  routes: RouteSpec[];
  defaultListener: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the normalised service topology for `app`.
 *
 * - If `app.services` is absent: synthesize the legacy single-"web"-service shape.
 * - If `app.services` is present: return the declared services/routes/defaultListener.
 *
 * Never mutates `app`. Safe to call multiple times; returns equal (but not
 * necessarily reference-equal) values on every call for a legacy app.
 */
export function servicesOf(app: AppSpec): ServicesView {
  if (app.services !== undefined) {
    // Fix 6b: for multi-service apps, defaultListener MUST resolve to a declared
    // listener. The old code fabricated a fallback:
    //   app.defaultListener ?? app.services[0]?.listeners[0]?.name ?? "web"
    // This silently swallowed a validation gap (app registered without
    // defaultListener, or with a dangling name). Now we throw so the operator
    // sees the problem at call time rather than getting a mysterious Caddy error.
    if (app.defaultListener === undefined) {
      throw new Error(
        `servicesOf: multi-service app "${app.name}" has no defaultListener declared — ` +
          `re-register with a valid defaultListener that matches a declared listener name`,
      );
    }
    const allListenerNames = new Set<string>(
      app.services.flatMap((s) => s.listeners.map((l) => l.name)),
    );
    if (!allListenerNames.has(app.defaultListener)) {
      throw new Error(
        `servicesOf: multi-service app "${app.name}" defaultListener "${app.defaultListener}" ` +
          `does not match any declared listener ` +
          `(known: ${[...allListenerNames].join(", ") || "(none)"}) — ` +
          `re-register with a valid defaultListener`,
      );
    }
    return {
      services: app.services,
      routes: app.routes ?? [],
      defaultListener: app.defaultListener,
    };
  }

  // Legacy: synthesize the single-service shape.
  const port = portFromHealthUrl(app.healthUrl);
  const listener: ListenerSpec = {
    name: "web",
    port,
    portEnv: "PORT",
    healthPath: "/",
  };
  const service: ServiceSpec = {
    name: "web",
    unit: app.serviceUnit,
    listeners: [listener],
  };

  return {
    services: [service],
    routes: [],
    defaultListener: "web",
  };
}
