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
  /** Maps to assertions.rlsNonSuperuser when true. */
  rlsNonSuperuser?: boolean;
  /**
   * Serve kind: `"node"` (default) or `"static"`. Maps to {@link AppSpec.kind}.
   * Optional: absent means node.
   */
  kind?: "node" | "static";
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
  "rlsNonSuperuser",
  // Issue #36: serve kind ("node" | "static")
  "kind",
  // `provision` is the only allowed sub-table at top level
  "provision",
]);

const PROVISION_KEYS = new Set<string>([
  "serverType",
  "location",
  "labels",
]);

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
  const envDbVars = optionalStringArray(raw, "envDbVars", errors);
  const rlsNonSuperuser = optionalBoolean(raw, "rlsNonSuperuser", errors);

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

  // ---- 6. Return result ----------------------------------------------------
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
    ...(envDbVars !== undefined ? { envDbVars } : {}),
    ...(rlsNonSuperuser !== undefined ? { rlsNonSuperuser } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };

  return {
    ok: true,
    app,
    ...(provision !== undefined ? { provision } : {}),
  };
}
