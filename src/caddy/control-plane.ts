/**
 * Durable main-host routing on the samo.team control plane.
 *
 * A project VM whose app declares `mainListen = "cp-http80"` serves plain
 * HTTP on :80.  The public `mainHost` terminates TLS on the control plane, so
 * it also needs a control-plane vhost which proxies to that VM.  App-VM
 * bootstrap/host-prep cannot create this second hop because those scripts run
 * on the project VM.
 *
 * The generated script runs locally wherever the samohost deploy command runs
 * (the production trigger runs on the control plane).  It owns exactly one
 * stable sites.d file per AppRecord id and never edits the parent Caddyfile.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { AppRecord, VmRecord } from "../types.ts";
import { assertSafeAppIdentity } from "../app/identity.ts";

const CADDYFILE = "/etc/caddy/Caddyfile";
const SITES_DIR = "/etc/caddy/sites.d";

export interface ControlPlaneProbeExpectation {
  /** Exact deployed commit identity served by static /version.json. */
  sha: string;
  /** Exact value required in both version and tag. */
  expectedIdentity: string;
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return (
    new RegExp(`^${label}(?:\\.${label})*\\.[a-z]{2,63}$`).test(host) &&
    host === host.toLowerCase()
  );
}

function probePath(app: AppRecord): string {
  if (app.kind === "static") return "/version.json";
  try {
    const parsed = new URL(app.healthUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    throw new Error("invalid app healthUrl for control-plane end-to-end probe");
  }
}

function controlPlaneProbeLines(
  app: AppRecord,
  expectation?: ControlPlaneProbeExpectation,
): string[] {
  const host = app.mainHost!;
  const path = probePath(app);
  if (expectation !== undefined && !/^[0-9a-f]{40}$/.test(expectation.sha)) {
    throw new Error("invalid expected SHA for control-plane end-to-end probe");
  }
  const lines = [
    "# Prove the complete CP TLS -> configured upstream -> project route before commit.",
    "# --resolve keeps DNS local while preserving the production Host header and TLS SNI.",
    "# Caddy's internal CA is intentionally accepted with --insecure, matching origin probes.",
    'PROBE_BODY=$(/usr/bin/mktemp "/tmp/samohost-main-route-probe.XXXXXX")',
    "PROBE_OK=0",
    'PROBE_STATUS="transport-error"',
    "for attempt in $(seq 1 5); do",
    '  : > "$PROBE_BODY"',
    `  if PROBE_STATUS=$(/usr/bin/curl --silent --show-error --insecure --noproxy '*' --proto '=https' --resolve ${sq(`${host}:443:127.0.0.1`)} --output "$PROBE_BODY" --write-out '%{http_code}' --connect-timeout 5 --max-time 10 --max-filesize 1048576 ${sq(`https://${host}${path}`)}); then`,
  ];
  if (app.kind === "static" && expectation !== undefined) {
    lines.push(
      '    if [[ "$PROBE_STATUS" == "200" ]] && /usr/bin/python3 - "$PROBE_BODY" ' +
        `${sq(expectation.sha)} ${sq(expectation.expectedIdentity)} <<'PY'`,
      "import json",
      "import sys",
      "",
      "path, expected_sha, expected_identity = sys.argv[1:]",
      "try:",
      "    with open(path, encoding='utf-8') as source:",
      "        body = json.load(source)",
      "except (OSError, UnicodeError, json.JSONDecodeError):",
      "    raise SystemExit(1)",
      "if not isinstance(body, dict): raise SystemExit(1)",
      "if body.get('version') != expected_identity or body.get('tag') != expected_identity: raise SystemExit(1)",
      "if body.get('sha') != expected_sha or body.get('environment') != 'production': raise SystemExit(1)",
      "PY",
      "    then",
      "      PROBE_OK=1; break",
      "    fi",
    );
  } else {
    lines.push(
      '    if [[ "$PROBE_STATUS" == "200" ]]; then PROBE_OK=1; break; fi',
    );
  }
  lines.push(
    "  else",
    '    PROBE_STATUS="transport-error"',
    "  fi",
    "  sleep 1",
    "done",
    '[[ "$PROBE_OK" == "1" ]] || { echo "error: control-plane end-to-end route probe failed (last status: $PROBE_STATUS)" >&2; exit 1; }',
    'echo "control-plane end-to-end route probe passed"',
  );
  return lines;
}

/** True only for the explicit control-plane-fronted production topology. */
export function needsControlPlaneMainRoute(app: AppRecord): boolean {
  return app.mainHost !== undefined && app.mainListen === "cp-http80";
}

/** Stable, injection-safe path. Re-registering the same app updates one file. */
export function controlPlaneMainRoutePath(app: AppRecord): string {
  assertSafeAppIdentity(app);
  const readable = app.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";
  const key = createHash("sha256").update(app.id).digest("hex").slice(0, 12);
  return `${SITES_DIR}/05-samohost-main-${readable}-${key}.caddy`;
}

/**
 * Fingerprint of the complete desired managed state for one AppRecord.
 *
 * The absent state is fingerprinted too: after a successful removal, a later
 * trigger can distinguish "removal applied" from "route lifecycle never ran".
 */
export function controlPlaneMainRouteFingerprint(
  app: AppRecord,
  vm: VmRecord,
): string {
  assertSafeAppIdentity(app);
  const desired = needsControlPlaneMainRoute(app)
    ? {
        version: 1,
        mode: "cp-http80",
        path: controlPlaneMainRoutePath(app),
        host: app.mainHost,
        upstream: upstream(vm.ip),
      }
    : {
        version: 1,
        mode: "absent",
        path: controlPlaneMainRoutePath(app),
      };
  const project = app.mainHost === undefined
    ? { mode: "absent" }
    : {
        mode: "present",
        kind: app.kind ?? "node",
        staticRoot: app.staticRoot ?? null,
        host: app.mainHost,
        listen: app.mainListen ?? "cp-http80",
        appDir: app.appDir,
        healthUrl: app.healthUrl,
        serviceUnit: app.serviceUnit,
        services: app.services ?? null,
        routes: app.routes ?? null,
        defaultListener: app.defaultListener ?? null,
      };
  return createHash("sha256")
    .update(JSON.stringify({ version: 2, project, controlPlane: desired }))
    .digest("hex");
}

function upstream(ip: string): string {
  const family = isIP(ip);
  if (family === 0) {
    throw new Error(
      `invalid VM IP ${JSON.stringify(ip)} for control-plane main route`,
    );
  }
  return family === 6 ? `[${ip}]:80` : `${ip}:80`;
}

/** Render one exact public-host -> app-VM:80 control-plane route. */
export function renderControlPlaneMainRoute(
  app: AppRecord,
  vm: VmRecord,
): string {
  if (!needsControlPlaneMainRoute(app) || app.mainHost === undefined) {
    throw new Error(
      `app ${JSON.stringify(app.name)} does not declare mainHost + ` +
        `mainListen="cp-http80"`,
    );
  }
  if (!validHost(app.mainHost)) {
    throw new Error(
      `invalid mainHost ${JSON.stringify(app.mainHost)} for control-plane route`,
    );
  }

  const host = app.mainHost;
  return [
    "# Managed by samohost; stable route identity is encoded in the filename.",
    `# Cloudflare -> control plane TLS -> ${vm.ip}:80 (Host: ${host}).`,
    `${host} {`,
    `\ttls internal`,
    `\treverse_proxy ${upstream(vm.ip)} {`,
    `\t\theader_up Host ${host}`,
    `\t\theader_up X-Real-IP {remote_host}`,
    `\t}`,
    `\theader {`,
    `\t\tX-Content-Type-Options nosniff`,
    `\t\tCache-Control "no-cache, no-store, must-revalidate"`,
    `\t}`,
    `}`,
  ].join("\n");
}

function transactionPreamble(path: string): string[] {
  return [
    "set -euo pipefail",
    "umask 077",
    `CADDYFILE=${sq(CADDYFILE)}`,
    `SITES_DIR=${sq(SITES_DIR)}`,
    `SNIPPET=${sq(path)}`,
    'BACKUP="${SNIPPET}.rollback.$$"',
    "HAD_OLD=0",
    "MUTATED=0",
    "COMMITTED=0",
    "rollback() {",
    '  rc="$?"',
    '  if [ "$COMMITTED" -eq 0 ] && [ "$MUTATED" -eq 1 ]; then',
    '    if [ "$HAD_OLD" -eq 1 ] && [ -e "$BACKUP" ]; then',
    '      sudo /usr/bin/mv -f "$BACKUP" "$SNIPPET"',
    "    else",
    '      sudo /usr/bin/rm -f "$SNIPPET" "$BACKUP"',
    "    fi",
    "    # Restore the last validated running configuration after any failed reload.",
    '    if [ -r "$CADDYFILE" ]; then',
    '      sudo /usr/bin/caddy validate --config "$CADDYFILE" >/dev/null 2>&1 || true',
    "      sudo /usr/bin/systemctl reload caddy >/dev/null 2>&1 || true",
    "    fi",
    "  fi",
    '  [ -n "${DESIRED:-}" ] && /usr/bin/rm -f "$DESIRED"',
    '  [ -n "${PROBE_BODY:-}" ] && /usr/bin/rm -f "$PROBE_BODY"',
    '  if [ -e "$BACKUP" ] || [ -e "${SNIPPET}.new" ]; then',
    '    sudo /usr/bin/rm -f "$BACKUP" "${SNIPPET}.new"',
    "  fi",
    '  exit "$rc"',
    "}",
    "trap rollback EXIT HUP INT TERM",
  ];
}

/**
 * Build the local, transactional reconcile script used after a healthy deploy.
 *
 * Apply path: stage -> atomic rename -> validate full config -> reload.  Any
 * validate/reload failure restores the previous snippet and reloads it.
 * Remove path uses the same backup/validate/reload/rollback transaction.
 * A missing route is an idempotent no-op, so TLS-only/unhosted apps continue to
 * deploy safely from operator machines that are not the control plane.
 */
export function buildControlPlaneMainRouteReconcileScript(
  app: AppRecord,
  vm: VmRecord,
  probeExpectation?: ControlPlaneProbeExpectation,
): string {
  const path = controlPlaneMainRoutePath(app);
  const lines = [
    "#!/usr/bin/env bash",
    "# samohost control-plane main-route reconcile",
    ...transactionPreamble(path),
    "",
  ];

  if (!needsControlPlaneMainRoute(app)) {
    return [
      ...lines,
      "# No control-plane route is desired. Remove only this app's managed file.",
      '[ -e "$SNIPPET" ] || { echo "control-plane main route: absent (no-op)"; COMMITTED=1; exit 0; }',
      '[ -r "$CADDYFILE" ] || { echo "error: control-plane Caddyfile is not readable" >&2; exit 1; }',
      "grep -qF 'import sites.d/*.caddy' \"$CADDYFILE\" || { echo \"error: Caddyfile does not import sites.d/*.caddy\" >&2; exit 1; }",
      'sudo /usr/bin/cp -p "$SNIPPET" "$BACKUP"',
      "HAD_OLD=1",
      "MUTATED=1",
      'sudo /usr/bin/rm -f "$SNIPPET"',
      'sudo /usr/bin/caddy validate --config "$CADDYFILE"',
      "sudo /usr/bin/systemctl reload caddy",
      "COMMITTED=1",
      'echo "control-plane main route removed"',
    ].join("\n");
  }

  const body = renderControlPlaneMainRoute(app, vm);
  const host = app.mainHost!;
  return [
    ...lines,
    '[ -r "$CADDYFILE" ] || { echo "error: control-plane Caddyfile is not readable" >&2; exit 1; }',
    "grep -qF 'import sites.d/*.caddy' \"$CADDYFILE\" || { echo \"error: Caddyfile does not import sites.d/*.caddy\" >&2; exit 1; }",
    'sudo /usr/bin/install -d -m 0755 -o root -g root "$SITES_DIR"',
    'DESIRED=$(/usr/bin/mktemp "/tmp/samohost-main-route.XXXXXX")',
    `printf '%s\\n' ${sq(body)} > "$DESIRED"`,
    "",
    "# Do not create an ambiguous duplicate beside a legacy hand-authored route.",
    'if [ ! -e "$SNIPPET" ] && /usr/bin/grep -F -l -- ' + sq(`${host} {`) + ' "$CADDYFILE" "$SITES_DIR"/*.caddy 2>/dev/null | /usr/bin/grep -F -v -x -- "$SNIPPET" >/dev/null; then',
    `  echo ${sq(`error: control-plane main route for ${host} already exists outside samohost's managed file; refusing an ambiguous duplicate`)} >&2`,
    "  exit 1",
    "fi",
    "",
    'if [ -e "$SNIPPET" ] && /usr/bin/cmp -s "$DESIRED" "$SNIPPET"; then',
    '  echo "control-plane main route unchanged; probing through it"',
    "else",
    '  if [ -e "$SNIPPET" ]; then sudo /usr/bin/cp -p "$SNIPPET" "$BACKUP"; HAD_OLD=1; fi',
    "  MUTATED=1",
    '  sudo /usr/bin/install -m 0644 -o root -g root "$DESIRED" "${SNIPPET}.new"',
    '  sudo /usr/bin/mv -f "${SNIPPET}.new" "$SNIPPET"',
    '  sudo /usr/bin/caddy validate --config "$CADDYFILE"',
    "  sudo /usr/bin/systemctl reload caddy",
    "fi",
    ...controlPlaneProbeLines(app, probeExpectation),
    "COMMITTED=1",
    `echo ${sq(`control-plane main route ready: ${host} -> ${upstream(vm.ip)}`)}`,
  ].join("\n");
}
