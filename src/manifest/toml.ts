/**
 * .samohost.toml manifest reader (SPEC-DELTA §3 "app module", PR-D).
 *
 * Parses and validates a `.samohost.toml` file that a client repo carries to
 * describe its app and provision parameters. Designed for use with
 * `samohost app register --from-toml <path>`.
 *
 * The manifest schema mirrors {@link AppSpec} field names 1:1 so there is no
 * translation jargon between the TOML and the typed interfaces.
 *
 * Parse idiom: return a `Result` (never throw); collect ALL validation errors
 * before returning (fail-closed, no bail-on-first). Unknown keys are rejected
 * (typo protection).
 *
 * field-record-1#117 (samohost PR-D: .samohost.toml reader + app register --from-toml)
 */

import { parse as parseToml } from "smol-toml";
import type { TomlValueWithoutBigInt } from "smol-toml";
import type { ListenerSpec, ServiceSpec, RouteSpec } from "../types.ts";
import { resolvePreviewDbBackend } from "../preview/db-policy.ts";

/** A plain TOML table returned by smol-toml's `parse()` (no bigint). */
type TomlTableLike = Record<string, TomlValueWithoutBigInt>;

// ---------------------------------------------------------------------------
// Typed manifest shapes (the result of a successful parse)
// ---------------------------------------------------------------------------

/**
 * The `[app]` section of a `.samohost.toml` manifest (top-level keys).
 * Field names are identical to {@link AppSpec} so the map is mechanical.
 */
export interface AppManifest {
  // Required
  name: string;
  repo: string;
  branch: string;
  appDir: string;
  buildCmd: string;
  healthUrl: string;
  serviceUnit: string;
  // Optional
  migrateCmd?: string;
  seedCmd?: string;
  envFile?: string;
  mainHost?: string;
  rlsUrlVar?: string;
  envDbVars?: string[];
  previewEnvAllowlist?: string[];
  previewEnvUnset?: string[];
  /** Maps to assertions.rlsNonSuperuser when true. */
  rlsNonSuperuser?: boolean;
  /**
   * OS user that owns the production app checkout and the envs root.
   * Maps to {@link AppSpec.appUser}. Optional: absent = SSH user (back-compat).
   */
  appUser?: string;
  /**
   * Serve kind: `"node"` (default) or `"static"`. Maps to {@link AppSpec.kind}.
   * Optional: absent means node.
   */
  kind?: "node" | "static";
  /**
   * Persistent DB backend for this app's own production database.
   * `"none"` = app has no database; preview envs skip all DB phases.
   * Maps to {@link AppSpec.dbBackend}.
   */
  dbBackend?: "dblab" | "template" | "none";
  /**
   * Per-app default DB backend for auto-created PR-preview envs.
   * When absent, inherits from dbBackend (none→none, otherwise dblab).
   * Maps to {@link AppSpec.previewDbBackend}.
   */
  previewDbBackend?: "dblab" | "template" | "none";

  // ---- Multi-service spec model (additive; absent = legacy single-service) --
  /** Declared services. Maps to {@link AppSpec.services}. */
  services?: ServiceSpec[];
  /** Caddy routing rules. Maps to {@link AppSpec.routes}. */
  routes?: RouteSpec[];
  /** Default listener name (required when services is set). Maps to {@link AppSpec.defaultListener}. */
  defaultListener?: string;
  /** Production main-host Caddy wiring mode. Maps to {@link AppSpec.mainListen}. */
  mainListen?: "cp-http80" | "tls";
  /**
   * Optional glob pattern (e.g. `"v*"`) for release tags. Maps to
   * {@link AppSpec.releaseTagPattern}. Must be a non-empty string when present.
   *
   * IMPORTANT — accepted + persisted; the tag-gated deploy behavior is a
   * separate, not-yet-shipped feature — prod deploys on main SHA + CI-green
   * regardless of this value.
   */
  releaseTagPattern?: string;

  /**
   * App-level secret env-var NAMES samohost will auto-generate per preview env
   * (PR-B). Each entry must match ^[A-Z_][A-Z0-9_]*$. No duplicates.
   * Absent = no auto-generated secrets. Maps to {@link AppSpec.secrets}.
   */
  secrets?: string[];

  /**
   * Env-var name holding the DB connection URL (e.g. "DATABASE_URL").
   * Must match ^[A-Z_][A-Z0-9_]*$. Required for explicitly DB-backed apps
   * (dbBackend or previewDbBackend set to "dblab" or "template") because PR-C
   * needs to know which var to rewrite. Maps to {@link AppSpec.databaseUrlEnv}.
   */
  databaseUrlEnv?: string;
}

/**
 * The `[provision]` table of a `.samohost.toml` manifest.
 * NOTE: these fields are parsed and exposed but NOT consumed by
 * `app register`. A future `provision --from-toml` will use them.
 * TODO(PR-E): wire provision --from-toml to consume this table.
 */
export interface ProvisionManifest {
  /** Maps to ProvisionSpec.type. */
  serverType?: string;
  /** Maps to ProvisionSpec.region. */
  location?: string;
  /** Maps to ProvisionSpec.labels (string→string). */
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ParseTomlResult =
  | { ok: true; app: AppManifest; provision?: ProvisionManifest }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Allowlists for unknown-key rejection
// ---------------------------------------------------------------------------

const APP_KEYS = new Set<string>([
  "name",
  "repo",
  "branch",
  "appDir",
  "buildCmd",
  "healthUrl",
  "serviceUnit",
  "migrateCmd",
  "seedCmd",
  "envFile",
  "mainHost",
  "rlsUrlVar",
  "envDbVars",
  "previewEnvAllowlist",
  "previewEnvUnset",
  "rlsNonSuperuser",
  // Issue #36: serve kind ("node" | "static")
  "kind",
  // App-level DB backend — 'none' means no database; preview envs skip DB phases.
  "dbBackend",
  // Per-app default DB backend for auto-created PR-preview envs.
  "previewDbBackend",
  // Issue #97: OS user that owns the app checkout + envs root (clone + unit user).
  "appUser",
  // `provision` is the only allowed sub-table at top level
  "provision",
  // Multi-service spec model (additive; absent = legacy single-service)
  "services",
  "routes",
  "defaultListener",
  "mainListen",
  // accepted + persisted; the tag-gated deploy behavior is a separate,
  // not-yet-shipped feature — prod deploys on main SHA + CI-green regardless of this value.
  "releaseTagPattern",
  // PR-B/PR-C: secrets and databaseUrlEnv are schema-only in this PR.
  // Secret generation (PR-B) and DB URL rewriting (PR-C) are separate.
  "secrets",
  "databaseUrlEnv",
]);

const PROVISION_KEYS = new Set<string>([
  "serverType",
  "location",
  "labels",
]);

/** Allowed keys inside a [[services]] entry. */
const SERVICE_KEYS = new Set<string>([
  "name",
  "unit",
  "execStart",
  "listeners",
]);

/** Allowed keys inside a [[services.listeners]] entry. */
const LISTENER_KEYS = new Set<string>([
  "name",
  "port",
  "portEnv",
  "healthPath",
  "routed",
]);

/** Allowed keys inside a [[routes]] entry. */
const ROUTE_KEYS = new Set<string>([
  "name",
  "matchPath",
  "matchRegexp",
  "to",
  "respond",
]);

/** Allowed keys inside a [routes.respond] sub-table. */
const ROUTE_RESPOND_KEYS = new Set<string>([
  "status",
  "body",
]);

/**
 * Validate a string value that will be embedded verbatim into a root-written
 * Caddy JSON config or Caddyfile. Returns null on success, or a human-readable
 * error reason on failure. Fail-closed.
 *
 * Rules (Fix 1+2+7):
 *   1. Must be non-empty printable ASCII [\x20-\x7e] only — rejects control
 *      chars, newline, tab, and any non-ASCII (U+0080+). Current negated-class
 *      admitted U+0085/U+2028/non-ASCII; the positive range closes that gap.
 *   2. Must not contain: double-quote ("), backslash (\), backtick (`).
 *      Double-quote terminates JSON strings; backslash needs double-escaping;
 *      backtick is reserved in some Caddyfile templating contexts.
 *   3. Must not contain "{$" — Caddyfile expands {$VAR} at parse time for
 *      every block the config writer has root privilege over. Embedding
 *      "{$SECRET}" silently injects a live credential value.
 *   4. Every "{" must begin a valid regex quantifier: {n}, {n,}, or {n,m}
 *      (digits only). Bare "{" / "}" and any other brace form (e.g. {word},
 *      {$X}) are rejected. Stripping all valid quantifiers then checking for
 *      residual "{" or "}" implements this in one pass.
 */
function isCaddySafe(s: string): string | null {
  if (s.length === 0) return "empty string";
  // Rule 1: printable ASCII only (0x20 space through 0x7e tilde, inclusive).
  if (!/^[\x20-\x7e]+$/.test(s)) {
    return "contains non-printable or non-ASCII character (only printable ASCII 0x20-0x7e allowed)";
  }
  // Rule 2: banned single characters.
  if (s.includes('"')) return 'contains double-quote (") — terminates JSON string in Caddy config';
  if (s.includes("\\")) return "contains backslash (\\) — requires double-escaping in JSON Caddy config";
  if (s.includes("`")) return "contains backtick (`) — reserved in Caddyfile templating";
  // Rule 3: brace-dollar Caddy env-substitution.
  if (s.includes("{$")) {
    return 'contains "{$" — Caddyfile expands {$VAR} at parse time (env-substitution injection)';
  }
  // Rule 4: all remaining "{" / "}" must be valid regex quantifiers.
  if (s.includes("{") || s.includes("}")) {
    const stripped = s.replace(/\{[0-9]+(,[0-9]*)?\}/g, "");
    if (stripped.includes("{")) {
      return 'contains "{" not part of a valid regex quantifier {n}, {n,}, or {n,m} — bare braces are unsafe in Caddy config';
    }
    if (stripped.includes("}")) {
      return 'contains "}" not part of a valid regex quantifier — bare braces are unsafe in Caddy config';
    }
  }
  return null;
}

/** Route / service / listener name charset: must match [a-z][a-z0-9-]* */
const ROUTE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** portEnv charset: uppercase env-var name ^[A-Z_][A-Z0-9_]*$ */
const PORTENV_RE = /^[A-Z_][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Guard: is this value a plain TOML table (string-keyed object)? */
function isTable(v: TomlValueWithoutBigInt): v is TomlTableLike {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Guard: is this value a TOML array? */
function isArray(v: TomlValueWithoutBigInt): v is TomlValueWithoutBigInt[] {
  return Array.isArray(v);
}

/**
 * Require a field to be present and a string. Appends to `errors` on failure.
 * Returns the string value if valid, undefined otherwise.
 */
function requireString(
  table: TomlTableLike,
  key: string,
  errors: string[],
): string | undefined {
  const v = table[key];
  if (v === undefined) {
    errors.push(`missing required field: ${key}`);
    return undefined;
  }
  if (typeof v !== "string") {
    errors.push(`field ${key} must be a string (got ${typeof v})`);
    return undefined;
  }
  return v;
}

/**
 * Read an optional string field. Appends to `errors` if present but wrong type.
 * Returns the string value if present and valid, undefined otherwise.
 */
function optionalString(
  table: TomlTableLike,
  key: string,
  errors: string[],
): string | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    errors.push(`field ${key} must be a string (got ${typeof v})`);
    return undefined;
  }
  return v;
}

/**
 * Read an optional boolean field. Appends to `errors` if present but wrong type.
 */
function optionalBoolean(
  table: TomlTableLike,
  key: string,
  errors: string[],
): boolean | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    errors.push(`field ${key} must be a boolean (got ${typeof v})`);
    return undefined;
  }
  return v;
}

/**
 * Read an optional string[] field. Validates each element is a string.
 * Appends to `errors` on type mismatch.
 */
function optionalStringArray(
  table: TomlTableLike,
  key: string,
  errors: string[],
): string[] | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (!isArray(v)) {
    errors.push(`field ${key} must be an array of strings (got ${typeof v})`);
    return undefined;
  }
  const result: string[] = [];
  let hasError = false;
  for (let i = 0; i < v.length; i++) {
    const elem = v[i];
    if (typeof elem !== "string") {
      errors.push(
        `field ${key}[${i}] must be a string (got ${typeof elem})`,
      );
      hasError = true;
    } else {
      result.push(elem);
    }
  }
  return hasError ? undefined : result;
}

/**
 * Validate a [provision.labels] sub-table: every value must be a string.
 * Appends to `errors` on type mismatch.
 */
function parseLabels(
  table: TomlTableLike,
  errors: string[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  let hasError = false;
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== "string") {
      errors.push(
        `[provision.labels] key "${k}" must be a string value (got ${typeof v})`,
      );
      hasError = true;
    } else {
      result[k] = v;
    }
  }
  return hasError ? undefined : result;
}

// ---------------------------------------------------------------------------
// Multi-service sub-parsers
// ---------------------------------------------------------------------------

/**
 * Parse a [[services.listeners]] entry. Collects errors into the shared array.
 * Returns undefined on type errors (but continues collecting for all entries).
 */
function parseListenerEntry(
  raw: TomlTableLike,
  serviceIdx: number,
  listenerIdx: number,
  errors: string[],
): ListenerSpec | undefined {
  const prefix = `services[${serviceIdx}].listeners[${listenerIdx}]`;

  // Reject unknown keys
  for (const k of Object.keys(raw)) {
    if (!LISTENER_KEYS.has(k)) {
      errors.push(`unknown ${prefix} key: ${k} (check spelling)`);
    }
  }

  const name = requireString(raw, "name", errors);
  // Fix 3b: listener name must match [a-z][a-z0-9-]* (same as service/route names).
  // They become env identifiers and unit-instance names; bad chars break shell/unit refs.
  if (name !== undefined && !ROUTE_NAME_RE.test(name)) {
    errors.push(
      `${prefix}: listener name "${name}" must match [a-z][a-z0-9-]* ` +
        `(lowercase letter start, then lowercase letters, digits, hyphens only)`,
    );
  }

  // Fix 4: port must be an integer in 1..65535.
  // typeof-only check admits floats (3.5) and out-of-range values (0, -1, 70000).
  const portRaw = raw["port"];
  let port: number | undefined;
  if (portRaw === undefined) {
    errors.push(`${prefix}: missing required field: port`);
  } else if (typeof portRaw !== "number") {
    errors.push(`${prefix}: field port must be a number (got ${typeof portRaw})`);
  } else if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    errors.push(
      `${prefix}: port must be an integer in the range 1-65535 (got ${portRaw})`,
    );
  } else {
    port = portRaw;
  }

  // Fix 3a: portEnv must be a valid env-var name ^[A-Z_][A-Z0-9_]*$.
  // It is written verbatim into systemd unit EnvironmentFile and env files by later PRs.
  const portEnvRaw = raw["portEnv"];
  let portEnv: string | undefined;
  if (portEnvRaw === undefined) {
    errors.push(`${prefix}: missing required field: portEnv`);
  } else if (typeof portEnvRaw !== "string") {
    errors.push(`${prefix}: field portEnv must be a string (got ${typeof portEnvRaw})`);
  } else if (!PORTENV_RE.test(portEnvRaw)) {
    errors.push(
      `${prefix}: portEnv "${portEnvRaw}" must match ^[A-Z_][A-Z0-9_]*$ ` +
        `(uppercase env-var name — it is embedded in env files and systemd units)`,
    );
  } else {
    portEnv = portEnvRaw;
  }

  const healthPathRaw = raw["healthPath"];
  let healthPath: string | undefined;
  if (healthPathRaw !== undefined) {
    if (typeof healthPathRaw !== "string") {
      errors.push(`${prefix}: field healthPath must be a string (got ${typeof healthPathRaw})`);
    } else {
      healthPath = healthPathRaw;
    }
  }

  const routedRaw = raw["routed"];
  let routed: boolean | undefined;
  if (routedRaw !== undefined) {
    if (typeof routedRaw !== "boolean") {
      errors.push(`${prefix}: field routed must be a boolean (got ${typeof routedRaw})`);
    } else {
      routed = routedRaw;
    }
  }

  if (name === undefined || port === undefined || portEnv === undefined) {
    return undefined;
  }

  return {
    name,
    port,
    portEnv,
    ...(healthPath !== undefined ? { healthPath } : {}),
    ...(routed !== undefined ? { routed } : {}),
  };
}

/**
 * Parse a [[services]] entry. Collects errors into the shared array.
 */
function parseServiceEntry(
  raw: TomlTableLike,
  idx: number,
  errors: string[],
): ServiceSpec | undefined {
  const prefix = `services[${idx}]`;

  // Reject unknown keys
  for (const k of Object.keys(raw)) {
    if (!SERVICE_KEYS.has(k)) {
      errors.push(`unknown ${prefix} key: ${k} (check spelling)`);
    }
  }

  const name = requireString(raw, "name", errors);
  // Fix 3b: service name must match [a-z][a-z0-9-]* — it becomes a unit-instance
  // identifier and is referenced by routes; bad chars break route/unit resolution.
  if (name !== undefined && !ROUTE_NAME_RE.test(name)) {
    errors.push(
      `${prefix}: service name "${name}" must match [a-z][a-z0-9-]* ` +
        `(lowercase letter start, then lowercase letters, digits, hyphens only)`,
    );
  }

  const unit = requireString(raw, "unit", errors);
  const execStart = optionalString(raw, "execStart", errors);

  // Parse listeners array
  const rawListeners = raw["listeners"];
  const listeners: ListenerSpec[] = [];
  if (rawListeners === undefined) {
    errors.push(`${prefix}: missing required field: listeners`);
  } else if (!isArray(rawListeners)) {
    errors.push(`${prefix}: field listeners must be an array of tables (got ${typeof rawListeners})`);
  } else {
    for (let li = 0; li < rawListeners.length; li++) {
      const rawL = rawListeners[li];
      if (rawL === undefined || !isTable(rawL)) {
        errors.push(`${prefix}.listeners[${li}] must be a table`);
        continue;
      }
      const listener = parseListenerEntry(rawL, idx, li, errors);
      if (listener !== undefined) listeners.push(listener);
    }
  }

  if (name === undefined || unit === undefined) return undefined;

  return {
    name,
    unit,
    ...(execStart !== undefined ? { execStart } : {}),
    listeners,
  };
}

/**
 * Parse a [[routes]] entry. Collects errors into the shared array.
 * Cross-reference validation (dangling `to`, routed=false targets) happens
 * in the main parser after all services are parsed.
 */
function parseRouteEntry(
  raw: TomlTableLike,
  idx: number,
  errors: string[],
): RouteSpec | undefined {
  const prefix = `routes[${idx}]`;

  // Reject unknown keys
  for (const k of Object.keys(raw)) {
    if (!ROUTE_KEYS.has(k)) {
      errors.push(`unknown ${prefix} key: ${k} (check spelling)`);
    }
  }

  const name = optionalString(raw, "name", errors);

  // Validate name charset when present
  if (name !== undefined && !ROUTE_NAME_RE.test(name)) {
    errors.push(
      `${prefix}: route name "${name}" must match [a-z][a-z0-9-]* ` +
        `(lowercase letter start, then lowercase letters, digits, hyphens only)`,
    );
  }

  const matchPath = optionalString(raw, "matchPath", errors);
  const matchRegexp = optionalString(raw, "matchRegexp", errors);
  const to = optionalString(raw, "to", errors);

  // Parse respond sub-table
  let respond: { status: number; body: string } | undefined;
  const rawRespond = raw["respond"];
  if (rawRespond !== undefined) {
    if (!isTable(rawRespond)) {
      errors.push(`${prefix}.respond must be a table (got ${typeof rawRespond})`);
    } else {
      // Reject unknown respond keys
      for (const k of Object.keys(rawRespond)) {
        if (!ROUTE_RESPOND_KEYS.has(k)) {
          errors.push(`unknown ${prefix}.respond key: ${k} (check spelling)`);
        }
      }
      const statusRaw = rawRespond["status"];
      let status: number | undefined;
      if (statusRaw === undefined) {
        errors.push(`${prefix}.respond: missing required field: status`);
      } else if (typeof statusRaw !== "number") {
        errors.push(`${prefix}.respond: field status must be a number (got ${typeof statusRaw})`);
      } else {
        status = statusRaw;
      }
      const bodyRaw = rawRespond["body"];
      let body: string | undefined;
      if (bodyRaw === undefined) {
        errors.push(`${prefix}.respond: missing required field: body`);
      } else if (typeof bodyRaw !== "string") {
        errors.push(`${prefix}.respond: field body must be a string (got ${typeof bodyRaw})`);
      } else {
        // Fix 2: respond.body is embedded verbatim in root-written Caddy config.
        const bodyErr = isCaddySafe(bodyRaw);
        if (bodyErr !== null) {
          errors.push(
            `${prefix}.respond: body contains unsafe content: ${bodyErr} — ` +
              `values are embedded verbatim in Caddy config`,
          );
        } else {
          body = bodyRaw;
        }
      }
      if (status !== undefined && body !== undefined) {
        respond = { status, body };
      }
    }
  }

  // Exactly one of matchPath | matchRegexp
  const hasMatch = (matchPath !== undefined ? 1 : 0) + (matchRegexp !== undefined ? 1 : 0);
  if (hasMatch === 0) {
    errors.push(`${prefix}: exactly one of matchPath or matchRegexp is required (neither present)`);
  } else if (hasMatch > 1) {
    errors.push(`${prefix}: exactly one of matchPath or matchRegexp is required (both present)`);
  }

  // Exactly one of to | respond
  const hasTarget = (to !== undefined ? 1 : 0) + (respond !== undefined ? 1 : 0);
  if (hasTarget === 0) {
    errors.push(`${prefix}: exactly one of "to" or "respond" is required (neither present)`);
  } else if (hasTarget > 1) {
    errors.push(`${prefix}: exactly one of "to" or "respond" is required (both present)`);
  }

  // Fix 2: matchPath is embedded verbatim in root-written Caddy config; apply the
  // same injection guard as matchRegexp.
  if (matchPath !== undefined) {
    const pathErr = isCaddySafe(matchPath);
    if (pathErr !== null) {
      errors.push(
        `${prefix}: matchPath contains unsafe content: ${pathErr} — ` +
          `values are embedded verbatim in Caddy config`,
      );
    }
  }

  // Fix 1+7: validate regexp — must be Caddy-safe (printable ASCII, no banned chars,
  // no brace injection) AND must compile as a valid JS/RE2 regexp.
  if (matchRegexp !== undefined) {
    const reErr = isCaddySafe(matchRegexp);
    if (reErr !== null) {
      errors.push(
        `${prefix}: matchRegexp contains unsafe content: ${reErr} — ` +
          `values are embedded verbatim in Caddy config`,
      );
    } else {
      try {
        new RegExp(matchRegexp);
      } catch {
        errors.push(`${prefix}: matchRegexp does not compile as a valid regexp: ${matchRegexp}`);
      }
    }
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(matchPath !== undefined ? { matchPath } : {}),
    ...(matchRegexp !== undefined ? { matchRegexp } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(respond !== undefined ? { respond } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse and validate a `.samohost.toml` manifest text.
 *
 * Returns `{ok:true, app, provision?}` on success, or
 * `{ok:false, errors}` with ALL validation errors collected (never bail-on-first).
 * Never throws — TOML parse errors are caught and returned as `{ok:false}`.
 *
 * Unknown top-level keys and unknown `[provision]` keys are rejected (typo
 * protection — a misspelled `helathUrl` fails loudly instead of silently dropping).
 *
 * NOTE: `[provision]` fields are parsed and validated but are NOT consumed by
 * `app register`. They are intended for a future `provision --from-toml` command.
 */
export function parseSamohostToml(text: string): ParseTomlResult {
  // ---- 1. Parse TOML syntax ------------------------------------------------
  let raw: TomlTableLike;
  try {
    // Pass explicit options ({}) to select the TomlTableWithoutBigInt overload.
    raw = parseToml(text, {}) as TomlTableLike;
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`TOML parse error: ${msg}`] };
  }

  const errors: string[] = [];

  // ---- 2. Reject unknown top-level keys ------------------------------------
  for (const key of Object.keys(raw)) {
    if (!APP_KEYS.has(key)) {
      errors.push(`unknown top-level key: ${key} (check spelling)`);
    }
  }

  // ---- 3. Validate required app fields -------------------------------------
  const name = requireString(raw, "name", errors);
  const repo = requireString(raw, "repo", errors);
  const branch = requireString(raw, "branch", errors);
  const appDir = requireString(raw, "appDir", errors);
  const buildCmd = requireString(raw, "buildCmd", errors);
  const healthUrl = requireString(raw, "healthUrl", errors);
  const serviceUnit = requireString(raw, "serviceUnit", errors);

  // ---- 4. Validate optional app fields -------------------------------------
  const migrateCmd = optionalString(raw, "migrateCmd", errors);
  const seedCmd = optionalString(raw, "seedCmd", errors);
  const envFile = optionalString(raw, "envFile", errors);
  const mainHost = optionalString(raw, "mainHost", errors);
  const rlsUrlVar = optionalString(raw, "rlsUrlVar", errors);
  const appUser = optionalString(raw, "appUser", errors);
  const envDbVars = optionalStringArray(raw, "envDbVars", errors);
  const previewEnvAllowlist = optionalStringArray(raw, "previewEnvAllowlist", errors);
  const previewEnvUnset = optionalStringArray(raw, "previewEnvUnset", errors);
  const rlsNonSuperuser = optionalBoolean(raw, "rlsNonSuperuser", errors);

  for (const [field, values] of [
    ["previewEnvAllowlist", previewEnvAllowlist],
    ["previewEnvUnset", previewEnvUnset],
  ] as const) {
    if (values === undefined) continue;
    const seen = new Set<string>();
    for (const value of values) {
      if (!PORTENV_RE.test(value)) {
        errors.push(`${field} entry "${value}" must match ^[A-Z_][A-Z0-9_]*$`);
      } else if (seen.has(value)) {
        errors.push(`duplicate ${field} entry: "${value}"`);
      }
      seen.add(value);
    }
  }

  // issue #36: optional enum field (must be "node" | "static" when present)
  let kind: "node" | "static" | undefined;
  {
    const rawKind = raw["kind"];
    if (rawKind !== undefined) {
      if (typeof rawKind !== "string") {
        errors.push(`field kind must be a string (got ${typeof rawKind})`);
      } else if (rawKind !== "node" && rawKind !== "static") {
        errors.push(`field kind must be "node" or "static" (got "${rawKind}")`);
      } else {
        kind = rawKind;
      }
    }
  }

  // optional enum: dbBackend ("dblab" | "template" | "none")
  const DB_BACKEND_VALUES = ["dblab", "template", "none"] as const;
  type DbBackendValue = "dblab" | "template" | "none";

  let dbBackend: DbBackendValue | undefined;
  {
    const rawDbBackend = raw["dbBackend"];
    if (rawDbBackend !== undefined) {
      if (typeof rawDbBackend !== "string") {
        errors.push(`field dbBackend must be a string (got ${typeof rawDbBackend})`);
      } else if (!(DB_BACKEND_VALUES as readonly string[]).includes(rawDbBackend)) {
        errors.push(`field dbBackend must be "dblab", "template", or "none" (got "${rawDbBackend}")`);
      } else {
        dbBackend = rawDbBackend as DbBackendValue;
      }
    }
  }

  // optional enum: previewDbBackend ("dblab" | "template" | "none")
  let previewDbBackend: DbBackendValue | undefined;
  {
    const rawPreviewDbBackend = raw["previewDbBackend"];
    if (rawPreviewDbBackend !== undefined) {
      if (typeof rawPreviewDbBackend !== "string") {
        errors.push(`field previewDbBackend must be a string (got ${typeof rawPreviewDbBackend})`);
      } else if (!(DB_BACKEND_VALUES as readonly string[]).includes(rawPreviewDbBackend)) {
        errors.push(`field previewDbBackend must be "dblab", "template", or "none" (got "${rawPreviewDbBackend}")`);
      } else {
        previewDbBackend = rawPreviewDbBackend as DbBackendValue;
      }
    }
  }

  // ---- 4b. Validate secrets[] and databaseUrlEnv (PR-B/PR-C schema) --------

  // Parse secrets (optional array of uppercase env-var names, no duplicates).
  let secrets: string[] | undefined;
  {
    const rawSecrets = raw["secrets"];
    if (rawSecrets !== undefined) {
      if (!isArray(rawSecrets)) {
        errors.push(`field secrets must be an array of strings (got ${typeof rawSecrets})`);
      } else {
        const parsed: string[] = [];
        let hasError = false;
        for (let i = 0; i < rawSecrets.length; i++) {
          const elem = rawSecrets[i];
          if (typeof elem !== "string") {
            errors.push(`field secrets[${i}] must be a string (got ${typeof elem})`);
            hasError = true;
          } else if (!PORTENV_RE.test(elem)) {
            errors.push(
              `secrets[${i}] "${elem}" must match ^[A-Z_][A-Z0-9_]*$ ` +
                `(uppercase env-var name — will be generated per preview env)`,
            );
            hasError = true;
          } else {
            parsed.push(elem);
          }
        }
        if (!hasError) {
          // Uniqueness check (only when all entries passed charset validation)
          const seen = new Set<string>();
          for (const s of parsed) {
            if (seen.has(s)) {
              errors.push(
                `duplicate secret name: "${s}" (secret names in secrets[] must be unique)`,
              );
            } else {
              seen.add(s);
            }
          }
          secrets = parsed;
        }
      }
    }
  }

  // Parse databaseUrlEnv (optional string, must be valid env-var name).
  // Track presence separately from value so the DB-backed required-check below
  // only fires when the key is fully absent (not when it is present but invalid).
  const databaseUrlEnvPresent = raw["databaseUrlEnv"] !== undefined;
  let databaseUrlEnv: string | undefined;
  {
    const rawDbUrlEnv = raw["databaseUrlEnv"];
    if (rawDbUrlEnv !== undefined) {
      if (typeof rawDbUrlEnv !== "string") {
        errors.push(
          `field databaseUrlEnv must be a string (got ${typeof rawDbUrlEnv})`,
        );
      } else if (!PORTENV_RE.test(rawDbUrlEnv)) {
        errors.push(
          `databaseUrlEnv "${rawDbUrlEnv}" must match ^[A-Z_][A-Z0-9_]*$ ` +
            `(uppercase env-var name — it holds the DB connection URL to rewrite per env)`,
        );
      } else {
        databaseUrlEnv = rawDbUrlEnv;
      }
    }
  }

  // DB-backed required check: if the app EXPLICITLY declares a non-none DB backend,
  // databaseUrlEnv is required (PR-C will rewrite it per env and must know which var).
  //
  // Predicate mirrors previewDbBackendFor() but uses ONLY explicitly stored values:
  //   explicit previewDbBackend != "none"  →  required
  //   explicit dbBackend != "none", no previewDbBackend  →  required
  //   neither field explicitly set (legacy apps)  →  EXEMPT (default dblab is not stored)
  //
  // This preserves byte-identical AppRecords for legacy manifests that pre-date
  // these fields; only manifests that explicitly declare a DB backend are checked.
  {
    const resolvedPreview = previewDbBackend ?? (dbBackend !== undefined ? dbBackend : undefined);
    // resolvedPreview is undefined only for legacy apps (neither field set) → exempt.
    // Otherwise it carries the explicitly-declared backend value.
    const isExplicitlyDbBacked =
      resolvedPreview !== undefined && resolvedPreview !== "none";

    if (isExplicitlyDbBacked && !databaseUrlEnvPresent) {
      const which = previewDbBackend !== undefined
        ? `previewDbBackend="${previewDbBackend}"`
        : `dbBackend="${dbBackend}"`;
      errors.push(
        `"databaseUrlEnv" is required for DB-backed apps (${which}) — ` +
          `declare which env var holds the DB connection URL so preview env-create can rewrite it per env ` +
          `(e.g. databaseUrlEnv = "DATABASE_URL")`,
      );
    }
  }

  // databaseUrlEnv is the primary-URL compatibility field, while generated
  // DBLab rewiring loops over envDbVars. They must describe one coherent set
  // or the primary URL could keep production credentials.
  if (databaseUrlEnv !== undefined) {
    const effectiveDbVars = new Set(envDbVars ?? ["DATABASE_URL"]);
    if (!effectiveDbVars.has(databaseUrlEnv)) {
      errors.push(
        `databaseUrlEnv "${databaseUrlEnv}" must also be present in envDbVars ` +
          `so every preview DB URL is rewritten with clone-only credentials`,
      );
    }
  }

  // Preview envs execute untrusted branch code. Never copy a production env
  // template wholesale: require an explicit allowlist and ensure every DB URL
  // needed for clone rewiring survives the filter.
  if (kind !== "static" && envFile !== undefined && previewEnvAllowlist === undefined) {
    errors.push(
      `"previewEnvAllowlist" is required for non-static apps with envFile — ` +
        `preview code must not inherit the production environment wholesale`,
    );
  }
  if (previewEnvAllowlist !== undefined) {
    const allowed = new Set(previewEnvAllowlist);
    const requiredDbVars = new Set(envDbVars ?? []);
    if (databaseUrlEnv !== undefined) requiredDbVars.add(databaseUrlEnv);
    for (const name of requiredDbVars) {
      if (!allowed.has(name)) {
        errors.push(`${name} must be present in previewEnvAllowlist because it is a declared preview DB URL`);
      }
    }
    for (const name of previewEnvUnset ?? []) {
      if (requiredDbVars.has(name)) {
        errors.push(`${name} cannot be in previewEnvUnset because it is required for DBLab rewiring`);
      }
    }
  }

  // ---- 5. Validate [provision] table (optional) ----------------------------
  let provision: ProvisionManifest | undefined;
  const rawProvision = raw["provision"];
  if (rawProvision !== undefined) {
    if (!isTable(rawProvision)) {
      errors.push(
        `[provision] must be a table (got ${typeof rawProvision})`,
      );
    } else {
      // Reject unknown [provision] keys
      for (const key of Object.keys(rawProvision)) {
        if (!PROVISION_KEYS.has(key)) {
          errors.push(
            `unknown [provision] key: ${key} (check spelling)`,
          );
        }
      }

      const serverType = optionalString(rawProvision, "serverType", errors);
      const location = optionalString(rawProvision, "location", errors);

      let labels: Record<string, string> | undefined;
      const rawLabels = rawProvision["labels"];
      if (rawLabels !== undefined) {
        if (!isTable(rawLabels)) {
          errors.push(
            `[provision.labels] must be a table (got ${typeof rawLabels})`,
          );
        } else {
          labels = parseLabels(rawLabels, errors);
        }
      }

      provision = {
        ...(serverType !== undefined ? { serverType } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(labels !== undefined ? { labels } : {}),
      };
    }
  }

  // ---- 6. Validate [[services]] (optional) ------------------------------------
  let services: ServiceSpec[] | undefined;
  const rawServices = raw["services"];
  if (rawServices !== undefined) {
    if (!isArray(rawServices)) {
      errors.push(`"services" must be an array of tables (got ${typeof rawServices})`);
    } else {
      const parsed: ServiceSpec[] = [];
      for (let si = 0; si < rawServices.length; si++) {
        const rawS = rawServices[si];
        if (rawS === undefined || !isTable(rawS)) {
          errors.push(`services[${si}] must be a table`);
          continue;
        }
        const svc = parseServiceEntry(rawS, si, errors);
        if (svc !== undefined) parsed.push(svc);
      }

      // Uniqueness: service names
      const svcNames = new Set<string>();
      for (const svc of parsed) {
        if (svcNames.has(svc.name)) {
          errors.push(`duplicate service name: "${svc.name}" (service names must be unique)`);
        } else {
          svcNames.add(svc.name);
        }
      }

      // Uniqueness: listener names (global), ports, portEnv values
      const lsNames = new Set<string>();
      const lsPorts = new Set<number>();
      const lsPortEnvs = new Set<string>();
      for (const svc of parsed) {
        for (const ls of svc.listeners) {
          if (lsNames.has(ls.name)) {
            errors.push(
              `duplicate listener name: "${ls.name}" (listener names must be unique across all services)`,
            );
          } else {
            lsNames.add(ls.name);
          }
          if (lsPorts.has(ls.port)) {
            errors.push(
              `duplicate listener port: ${ls.port} (listener ports must be unique across all services)`,
            );
          } else {
            lsPorts.add(ls.port);
          }
          if (lsPortEnvs.has(ls.portEnv)) {
            errors.push(
              `duplicate listener portEnv: "${ls.portEnv}" (portEnv values must be unique across all services)`,
            );
          } else {
            lsPortEnvs.add(ls.portEnv);
          }
        }
      }

      services = parsed;
    }
  }

  // ---- 7. Validate [[routes]] (optional) --------------------------------------
  let routes: RouteSpec[] | undefined;
  const rawRoutes = raw["routes"];
  if (rawRoutes !== undefined) {
    if (!isArray(rawRoutes)) {
      errors.push(`"routes" must be an array of tables (got ${typeof rawRoutes})`);
    } else {
      const parsed: RouteSpec[] = [];
      for (let ri = 0; ri < rawRoutes.length; ri++) {
        const rawR = rawRoutes[ri];
        if (rawR === undefined || !isTable(rawR)) {
          errors.push(`routes[${ri}] must be a table`);
          continue;
        }
        const route = parseRouteEntry(rawR, ri, errors);
        // Always push even if partially invalid — we want all errors collected
        parsed.push(route ?? {});
      }
      routes = parsed.length > 0 ? parsed : [];
    }
  }

  // ---- 8. Validate service topology (defaultListener, routes cross-refs, Fix 5) ---
  const defaultListener = optionalString(raw, "defaultListener", errors);

  // Fix 5: [[routes]] cannot exist without [[services]] — routes reference listener
  // names and there is no topology to resolve them against. A routes-only manifest
  // would silently produce a dangling "to" reference that later config writers
  // embed verbatim into Caddy, causing a runtime error instead of a fail-closed gate.
  if (routes !== undefined && services === undefined) {
    errors.push(
      `"[[routes]]" declared without "[[services]]" — routes reference listener names ` +
        `and require a declared service topology; add [[services]] or remove [[routes]]`,
    );
  }

  if (services !== undefined) {
    if (defaultListener === undefined) {
      errors.push(
        `"defaultListener" is required when [[services]] is declared — ` +
          `specify the listener name that receives unmatched requests`,
      );
    } else {
      // Collect all listener names for cross-reference validation
      const allListenerNames = new Set<string>(
        services.flatMap((s) => s.listeners.map((l) => l.name)),
      );
      if (!allListenerNames.has(defaultListener)) {
        errors.push(
          `"defaultListener" references listener "${defaultListener}" which does not exist ` +
            `(known listeners: ${[...allListenerNames].join(", ") || "(none)"})`,
        );
      }
    }

    // Cross-reference: validate routes[].to targets
    if (routes !== undefined) {
      const allListenerNames = new Set<string>(
        services.flatMap((s) => s.listeners.map((l) => l.name)),
      );
      // Build a map of listener name → routed flag for the routed=false check
      const routedMap = new Map<string, boolean>();
      for (const svc of services) {
        for (const ls of svc.listeners) {
          routedMap.set(ls.name, ls.routed !== false);
        }
      }
      for (let ri = 0; ri < routes.length; ri++) {
        const route = routes[ri]!;
        if (route.to !== undefined) {
          if (!allListenerNames.has(route.to)) {
            errors.push(
              `routes[${ri}].to references listener "${route.to}" which does not exist ` +
                `(known listeners: ${[...allListenerNames].join(", ") || "(none)"})`,
            );
          } else if (routedMap.get(route.to) === false) {
            errors.push(
              `routes[${ri}].to references listener "${route.to}" which has routed=false ` +
                `— only routable listeners may be route targets`,
            );
          }
        }
      }
    }
  }

  // ---- 9. Validate mainListen (optional enum) ---------------------------------
  let mainListen: "cp-http80" | "tls" | undefined;
  {
    const rawMainListen = raw["mainListen"];
    if (rawMainListen !== undefined) {
      if (typeof rawMainListen !== "string") {
        errors.push(`field mainListen must be a string (got ${typeof rawMainListen})`);
      } else if (rawMainListen !== "cp-http80" && rawMainListen !== "tls") {
        errors.push(
          `field mainListen must be "cp-http80" or "tls" (got "${rawMainListen}")`,
        );
      } else {
        mainListen = rawMainListen;
      }
    }
  }

  // ---- 9b. Validate releaseTagPattern (optional string, must be non-empty) ----
  // accepted + persisted; the tag-gated deploy behavior is a separate,
  // not-yet-shipped feature — prod deploys on main SHA + CI-green regardless of this value.
  let releaseTagPattern: string | undefined;
  {
    const rawRtp = raw["releaseTagPattern"];
    if (rawRtp !== undefined) {
      if (typeof rawRtp !== "string") {
        errors.push(
          `field releaseTagPattern must be a string (got ${typeof rawRtp})`,
        );
      } else if (rawRtp.length === 0) {
        errors.push(
          `field releaseTagPattern must be a non-empty string (e.g. "v*") — empty string is not a valid glob pattern`,
        );
      } else {
        releaseTagPattern = rawRtp;
      }
    }
  }

  // ---- 10. Return result -------------------------------------------------------
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All required fields are strings at this point (requireString returned
  // undefined only if it pushed an error, which would have triggered the
  // early-return above).
  const app: AppManifest = {
    name: name!,
    repo: repo!,
    branch: branch!,
    appDir: appDir!,
    buildCmd: buildCmd!,
    healthUrl: healthUrl!,
    serviceUnit: serviceUnit!,
    ...(migrateCmd !== undefined ? { migrateCmd } : {}),
    ...(seedCmd !== undefined ? { seedCmd } : {}),
    ...(envFile !== undefined ? { envFile } : {}),
    ...(mainHost !== undefined ? { mainHost } : {}),
    ...(rlsUrlVar !== undefined ? { rlsUrlVar } : {}),
    ...(appUser !== undefined ? { appUser } : {}),
    ...(envDbVars !== undefined ? { envDbVars } : {}),
    ...(previewEnvAllowlist !== undefined ? { previewEnvAllowlist } : {}),
    ...(previewEnvUnset !== undefined ? { previewEnvUnset } : {}),
    ...(rlsNonSuperuser !== undefined ? { rlsNonSuperuser } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(dbBackend !== undefined ? { dbBackend } : {}),
    ...(previewDbBackend !== undefined ? { previewDbBackend } : {}),
    ...(services !== undefined ? { services } : {}),
    ...(routes !== undefined ? { routes } : {}),
    ...(defaultListener !== undefined ? { defaultListener } : {}),
    ...(mainListen !== undefined ? { mainListen } : {}),
    ...(releaseTagPattern !== undefined ? { releaseTagPattern } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(databaseUrlEnv !== undefined ? { databaseUrlEnv } : {}),
  };

  try {
    resolvePreviewDbBackend(app);
  } catch (e) {
    return {
      ok: false,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }

  return {
    ok: true,
    app,
    ...(provision !== undefined ? { provision } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared service topology validator (Fix 6)
//
// Used by both the TOML path (parseSamohostToml above) and the programmatic
// path (runAppRegister in src/commands/app.ts) so the same rules apply
// regardless of how an app is registered.
// ---------------------------------------------------------------------------

/**
 * Validate the service topology (services / routes / defaultListener) against
 * the rules that Caddy config writers downstream will assume are enforced:
 *
 * - [[routes]] without [[services]] → error (routes reference listener names).
 * - [[services]] without defaultListener → error (required for request routing).
 * - defaultListener must reference a declared listener name.
 * - routes[].to must reference a declared listener that is not routed=false.
 *
 * Errors are appended to `errors`; the caller decides how to surface them.
 * Factored here so the TOML reader and the programmatic register path apply
 * identical validation.
 */
export function validateServicesTopology(
  services: ServiceSpec[] | undefined,
  routes: RouteSpec[] | undefined,
  defaultListener: string | undefined,
  errors: string[],
): void {
  // Fix 5: routes without services
  if (routes !== undefined && routes.length > 0 && services === undefined) {
    errors.push(
      '"routes" declared without "services" — routes reference listener names ' +
        "and require a declared service topology",
    );
    return; // no point cross-referencing listeners that don't exist
  }

  if (services === undefined) return; // no topology to validate

  // Charset parity with the TOML parse path (Fix 3a/3b parity for the
  // programmatic app-register path). A bad service name breaks the unit-instance
  // reference (`<name>@<env>.service`); a bad listener name produces a
  // malformed shell-var name in the health aggregation (`health_ok_<name>`);
  // a bad portEnv is silently ignored by systemd (only ^[A-Za-z_] names load).
  for (let si = 0; si < services.length; si++) {
    const svc = services[si]!;
    const svcPrefix = `services[${si}]`;
    if (!ROUTE_NAME_RE.test(svc.name)) {
      errors.push(
        `${svcPrefix}: service name "${svc.name}" must match [a-z][a-z0-9-]* ` +
          `(lowercase letter start, then lowercase letters, digits, hyphens only)`,
      );
    }
    for (let li = 0; li < svc.listeners.length; li++) {
      const ls = svc.listeners[li]!;
      const lsPrefix = `${svcPrefix}.listeners[${li}]`;
      if (!ROUTE_NAME_RE.test(ls.name)) {
        errors.push(
          `${lsPrefix}: listener name "${ls.name}" must match [a-z][a-z0-9-]* ` +
            `(lowercase letter start, then lowercase letters, digits, hyphens only)`,
        );
      }
      if (!PORTENV_RE.test(ls.portEnv)) {
        errors.push(
          `${lsPrefix}: portEnv "${ls.portEnv}" must match ^[A-Z_][A-Z0-9_]*$ ` +
            `(uppercase env-var name — it is embedded in env files and systemd units)`,
        );
      }
    }
  }

  // defaultListener required when services is declared
  const allListenerNames = new Set<string>(
    services.flatMap((s) => s.listeners.map((l) => l.name)),
  );

  if (defaultListener === undefined) {
    errors.push(
      '"defaultListener" is required when services is declared — ' +
        "specify the listener name that receives unmatched requests",
    );
  } else if (!allListenerNames.has(defaultListener)) {
    errors.push(
      `"defaultListener" references listener "${defaultListener}" which does not exist ` +
        `(known listeners: ${[...allListenerNames].join(", ") || "(none)"})`,
    );
  }

  // routes[].to cross-reference
  if (routes !== undefined) {
    const routedMap = new Map<string, boolean>();
    for (const svc of services) {
      for (const ls of svc.listeners) {
        routedMap.set(ls.name, ls.routed !== false);
      }
    }
    for (let ri = 0; ri < routes.length; ri++) {
      const route = routes[ri]!;
      if (route.to !== undefined) {
        if (!allListenerNames.has(route.to)) {
          errors.push(
            `routes[${ri}].to references listener "${route.to}" which does not exist ` +
              `(known listeners: ${[...allListenerNames].join(", ") || "(none)"})`,
          );
        } else if (routedMap.get(route.to) === false) {
          errors.push(
            `routes[${ri}].to references listener "${route.to}" which has routed=false ` +
              "— only routable listeners may be route targets",
          );
        }
      }
    }
  }
}
