/** Transactional project-VM half of production main-host routing. */

import { createHash } from "node:crypto";
import { assertSafeAppIdentity } from "../app/identity.ts";
import { staticReleaseStatePaths, staticRootOf } from "../app/static-root.ts";
import type { AppRecord } from "../types.ts";
import { planFromApp, renderVhost } from "./render.ts";

const CADDYFILE = "/etc/caddy/Caddyfile";

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertFingerprint(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid ${label} routing fingerprint`);
  }
}

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return new RegExp(`^${label}(?:\\.${label})*\\.[a-z]{2,63}$`).test(host);
}

function healthPath(app: AppRecord): string {
  try {
    const parsed = new URL(app.healthUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    throw new Error("invalid app healthUrl for project main-route health check");
  }
}

function appBase(app: AppRecord): string {
  return app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
}

export function projectMainRoutePath(app: AppRecord): string {
  assertSafeAppIdentity(app);
  return `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
}

function transactionDir(app: AppRecord): string {
  assertSafeAppIdentity(app);
  const key = createHash("sha256").update(app.id).digest("hex").slice(0, 16);
  return `/tmp/samohost-main-route-${key}`;
}

export function projectMainRouteTransitionPath(app: AppRecord): string {
  assertSafeAppIdentity(app);
  const key = createHash("sha256").update(app.id).digest("hex").slice(0, 16);
  return `/etc/caddy/sites.d/01-samohost-transition-${key}.caddy`;
}

function common(app: AppRecord, desiredFingerprint: string): string[] {
  assertSafeAppIdentity(app);
  staticRootOf(app);
  assertFingerprint(desiredFingerprint, "desired");
  const txn = transactionDir(app);
  const active = app.kind === "static"
    ? staticReleaseStatePaths(app.appDir)
    : undefined;
  return [
    "set -euo pipefail",
    "umask 077",
    `LIVE=${sq(projectMainRoutePath(app))}`,
    `TRANSITION=${sq(projectMainRouteTransitionPath(app))}`,
    `CADDYFILE=${sq(CADDYFILE)}`,
    `TXN=${sq(txn)}`,
    'BACKUP="$TXN/previous.caddy"',
    'BASE_BACKUP="$TXN/base.caddy"',
    'PRESENCE="$TXN/presence"',
    'TOKEN="$TXN/token"',
    ...(active === undefined
      ? []
      : [
        `ACTIVE_ROUTE=${sq(active.activeRoute)}`,
        `ACTIVE_STATE=${sq(active.activeState)}`,
        'ACTIVE_ROUTE_BACKUP="$TXN/active-route.caddy"',
        'ACTIVE_STATE_BACKUP="$TXN/active-state.json"',
        'ACTIVE_ROUTE_PRESENCE="$TXN/active-route-presence"',
        'ACTIVE_STATE_PRESENCE="$TXN/active-state-presence"',
      ]),
    `EXPECTED=${sq(desiredFingerprint)}`,
    '[[ ! -L "$TXN" && "$(stat -c %u "$TXN")" == "$(id -u)" && "$(stat -c %a "$TXN")" == "700" ]] || { echo "error: insecure project route transaction directory" >&2; exit 1; }',
    '[[ -d "$TXN" && -f "$TOKEN" && "$(cat "$TOKEN")" == "$EXPECTED" ]] || { echo "error: project route transaction token mismatch" >&2; exit 1; }',
    '[[ -f "$PRESENCE" ]] || { echo "error: project route transaction has no snapshot state" >&2; exit 1; }',
    'case "$(cat "$PRESENCE")" in present) [[ -f "$BACKUP" ]] || { echo "error: project route snapshot is missing" >&2; exit 1; } ;; absent) ;; *) echo "error: invalid project route snapshot state" >&2; exit 1 ;; esac',
    ...(active === undefined
      ? []
      : [
        'case "$(cat "$ACTIVE_ROUTE_PRESENCE")" in present) [[ -f "$ACTIVE_ROUTE_BACKUP" ]] || { echo "error: active static route snapshot is missing" >&2; exit 1; } ;; absent) ;; *) echo "error: invalid active static route snapshot state" >&2; exit 1 ;; esac',
        'case "$(cat "$ACTIVE_STATE_PRESENCE")" in present) [[ -f "$ACTIVE_STATE_BACKUP" ]] || { echo "error: active static state snapshot is missing" >&2; exit 1; } ;; absent) ;; *) echo "error: invalid active static state snapshot state" >&2; exit 1 ;; esac',
      ]),
    ...(app.kind === "static" && app.releaseTagPattern !== undefined
      ? ['[[ -f "$BASE_BACKUP" ]] || { echo "error: project base Caddyfile snapshot is missing" >&2; exit 1; }']
      : []),
  ];
}

/** Snapshot the old project route before a deploy can change it. */
export function buildProjectMainRouteBeginScript(
  app: AppRecord,
  desiredFingerprint: string,
  appliedFingerprint?: string,
): string {
  assertSafeAppIdentity(app);
  assertFingerprint(desiredFingerprint, "desired");
  if (appliedFingerprint !== undefined) {
    assertFingerprint(appliedFingerprint, "applied");
  }
  const txn = transactionDir(app);
  const live = projectMainRoutePath(app);
  const transition = projectMainRouteTransitionPath(app);
  const active = app.kind === "static"
    ? staticReleaseStatePaths(app.appDir)
    : undefined;
  return [
    "#!/usr/bin/env bash",
    "# samohost project main-route transaction begin",
    "set -euo pipefail",
    "umask 077",
    `LIVE=${sq(live)}`,
    `TRANSITION=${sq(transition)}`,
    `CADDYFILE=${sq(CADDYFILE)}`,
    `TXN=${sq(txn)}`,
    ...(active === undefined
      ? []
      : [
        `ACTIVE_ROUTE=${sq(active.activeRoute)}`,
        `ACTIVE_STATE=${sq(active.activeState)}`,
      ]),
    'TOKEN="$TXN/token"',
    `EXPECTED=${sq(desiredFingerprint)}`,
    `APPLIED=${sq(appliedFingerprint ?? "")}`,
    'if [[ -d "$TXN" ]]; then',
    '  [[ ! -L "$TXN" && "$(stat -c %u "$TXN")" == "$(id -u)" && "$(stat -c %a "$TXN")" == "700" ]] || { echo "error: insecure project route transaction directory" >&2; exit 1; }',
    '  [[ -f "$TOKEN" ]] || { echo "error: incomplete project route transaction has no token" >&2; exit 1; }',
    '  EXISTING="$(cat "$TOKEN")"',
    '  if [[ "$EXISTING" == "$EXPECTED" ]]; then',
    '    [[ -f "$TXN/presence" ]] || { echo "error: resumed project route transaction has no snapshot" >&2; exit 1; }',
    '    if [[ "$(cat "$TXN/presence")" == "present" ]]; then [[ -f "$TXN/previous.caddy" ]] || { echo "error: resumed project route snapshot is missing" >&2; exit 1; }; fi',
    ...(active === undefined
      ? []
      : [
        '    [[ -f "$TXN/active-route-presence" && -f "$TXN/active-state-presence" ]] || { echo "error: resumed active static snapshot state is missing" >&2; exit 1; }',
        '    if [[ "$(cat "$TXN/active-route-presence")" == "present" ]]; then [[ -f "$TXN/active-route.caddy" ]] || { echo "error: resumed active static route snapshot is missing" >&2; exit 1; }; fi',
        '    if [[ "$(cat "$TXN/active-state-presence")" == "present" ]]; then [[ -f "$TXN/active-state.json" ]] || { echo "error: resumed active static state snapshot is missing" >&2; exit 1; }; fi',
      ]),
    ...(app.kind === "static" && app.releaseTagPattern !== undefined
      ? ['    [[ -f "$TXN/base.caddy" ]] || { echo "error: resumed base Caddyfile snapshot is missing" >&2; exit 1; }']
      : []),
    '    echo "project route transaction resumed"; exit 0',
    "  fi",
    '  if [[ -n "$APPLIED" && "$EXISTING" == "$APPLIED" ]]; then sudo /usr/bin/rm -f "$TRANSITION"; rm -rf -- "$TXN"; else echo "error: another project route transaction is pending" >&2; exit 1; fi',
    "fi",
    '[[ ! -e "$TRANSITION" ]] || { echo "error: orphaned project route transition file" >&2; exit 1; }',
    "CREATED=0",
    "cleanup_on_error() {",
    '  rc="$?"',
    '  if [[ "$rc" != "0" && "$CREATED" == "1" ]]; then rm -rf -- "$TXN"; fi',
    '  exit "$rc"',
    "}",
    "trap cleanup_on_error EXIT HUP INT TERM",
    'mkdir -m 0700 -- "$TXN"',
    "CREATED=1",
    'printf "%s\\n" "$EXPECTED" > "$TOKEN"',
    ...(app.kind === "static" && app.releaseTagPattern !== undefined
      ? ['cat -- "$CADDYFILE" > "$TXN/base.caddy"']
      : []),
    ...(active === undefined
      ? []
      : [
        'if [[ -f "$ACTIVE_ROUTE" ]]; then cat -- "$ACTIVE_ROUTE" > "$TXN/active-route.caddy"; printf "present\\n" > "$TXN/active-route-presence"; else printf "absent\\n" > "$TXN/active-route-presence"; fi',
        'if [[ -f "$ACTIVE_STATE" ]]; then cat -- "$ACTIVE_STATE" > "$TXN/active-state.json"; printf "present\\n" > "$TXN/active-state-presence"; else printf "absent\\n" > "$TXN/active-state-presence"; fi',
      ]),
    'if [[ -f "$LIVE" ]]; then',
    '  cat -- "$LIVE" > "$TXN/previous.caddy"',
    '  printf "present\\n" > "$TXN/presence"',
    "else",
    '  printf "absent\\n" > "$TXN/presence"',
    "fi",
    "CREATED=0",
    'echo "project route transaction started"',
  ].join("\n");
}

function restoreLines(): string[] {
  return [
    "restore_previous() {",
    "  local restore_ok=1",
    '  local with_base="${1:-false}"',
    '  sudo /usr/bin/rm -f "$TRANSITION" "${LIVE}.next" || restore_ok=0',
    '  if [[ "$(cat "$PRESENCE")" == "present" && -f "$BACKUP" ]]; then',
    '    sudo /usr/bin/tee "${LIVE}.next" >/dev/null < "$BACKUP" || restore_ok=0',
    '    sudo /usr/bin/mv -- "${LIVE}.next" "$LIVE" || restore_ok=0',
    "  else",
    '    sudo /usr/bin/rm -f "$LIVE" || restore_ok=0',
    "  fi",
    '  if [[ "$with_base" == "true" ]]; then restore_base_files || restore_ok=0; fi',
    '  caddy validate --config "$CADDYFILE" >/dev/null || restore_ok=0',
    '  if [[ "$restore_ok" == "1" ]]; then sudo /usr/bin/systemctl reload caddy || restore_ok=0; fi',
    '  [[ "$restore_ok" == "1" ]]',
    "}",
  ];
}

function restoreBaseLines(app: AppRecord): string[] {
  if (app.kind !== "static") {
    return ["restore_base_files() { :; }"];
  }
  return [
    "restore_base_files() {",
    ...(app.releaseTagPattern !== undefined
      ? [
        '  sudo /usr/bin/tee /etc/caddy/.samohost-next-Caddyfile >/dev/null < "$BASE_BACKUP"',
        "  sudo /usr/bin/mv -- /etc/caddy/.samohost-next-Caddyfile /etc/caddy/Caddyfile",
      ]
      : []),
    '  if [[ "$(cat "$ACTIVE_ROUTE_PRESENCE")" == "present" ]]; then install -m 0644 "$ACTIVE_ROUTE_BACKUP" "${ACTIVE_ROUTE}.next" && /usr/bin/mv -f "${ACTIVE_ROUTE}.next" "$ACTIVE_ROUTE"; else rm -f "$ACTIVE_ROUTE" "${ACTIVE_ROUTE}.next"; fi',
    '  if [[ "$(cat "$ACTIVE_STATE_PRESENCE")" == "present" ]]; then install -m 0644 "$ACTIVE_STATE_BACKUP" "${ACTIVE_STATE}.next" && /usr/bin/mv -f "${ACTIVE_STATE}.next" "$ACTIVE_STATE"; else rm -f "$ACTIVE_STATE" "${ACTIVE_STATE}.next"; fi',
    "}",
  ];
}

function previousRouteHealthLines(app: AppRecord): string[] {
  const path = app.kind === "static" ? "/" : healthPath(app);
  return [
    'if [[ "$(cat "$PRESENCE")" == "present" ]]; then',
    '  read -r OLD_SCHEME OLD_HOST < <(python3 - "$BACKUP" <<\'PY\'',
    "import re",
    "import sys",
    "text = open(sys.argv[1], encoding='utf-8').read()",
    "match = re.search(r'^\\s*(?:(http)://)?([a-z0-9.-]+)(?::80)?\\s*\\{', text, re.MULTILINE)",
    "if not match: raise SystemExit('cannot parse prior project route address')",
    "print(('http' if match.group(1) else 'https'), match.group(2))",
    "PY",
    "  )",
    "  old_health=0",
    "  for attempt in $(seq 1 5); do",
    `    code=$(curl -s -k -H "Host: $OLD_HOST" -o /dev/null -w "%{http_code}" --max-time 10 "$OLD_SCHEME://127.0.0.1"${sq(path)} || echo 000)`,
    '    if [[ "$code" == "200" ]]; then old_health=1; break; fi',
    "    sleep 1",
    "  done",
    '  [[ "$old_health" == "1" ]] || { echo "error: restored project route is not healthy" >&2; exit 1; }',
    "fi",
  ];
}

/** Apply and locally health-check the desired project-VM topology. */
export function buildProjectMainRoutePrepareScript(
  app: AppRecord,
  desiredFingerprint: string,
): string {
  assertSafeAppIdentity(app);
  const lines = [
    "#!/usr/bin/env bash",
    "# samohost project main-route transaction prepare",
    ...common(app, desiredFingerprint),
    ...restoreLines(),
    ...restoreBaseLines(app),
    "PREPARED=0",
    "on_exit() {",
    '  rc="$?"',
    '  if [[ "$rc" != "0" && "$PREPARED" != "1" ]]; then',
    '    if [[ -f "$TRANSITION" ]]; then cat -- "$TRANSITION" > "$TXN/current.caddy"; elif [[ -f "$LIVE" ]]; then cat -- "$LIVE" > "$TXN/current.caddy"; else : > "$TXN/current.caddy"; fi',
    "    restore_previous true || true",
    "  fi",
    '  exit "$rc"',
    "}",
    "trap on_exit EXIT HUP INT TERM",
  ];

  if (app.mainHost === undefined) {
    lines.push(
      "restore_previous false",
      ...previousRouteHealthLines(app),
      "PREPARED=1",
      'echo "project main route removal prepared; old route remains healthy until CP commits"',
    );
    return lines.join("\n");
  }
  if (!validHost(app.mainHost)) {
    throw new Error("invalid mainHost for project main route");
  }

  const scheme = app.mainListen === "tls" ? "https" : "http";
  const path = app.kind === "static" ? "/" : healthPath(app);
  lines.push('DESIRED="$TXN/desired.caddy"');

  if (app.kind === "static") {
    const base = appBase(app);
    const staticRoot = staticRootOf(app) ?? "";
    const fallbackRoot = staticRoot === ""
      ? app.appDir
      : `${app.appDir.replace(/\/+$/, "")}/${staticRoot}`;
    lines.push(
      `python3 - "$TRANSITION" "$LIVE" "$BACKUP" "$DESIRED" ${sq(app.mainHost)} ${sq(app.mainListen ?? "cp-http80")} ${sq(fallbackRoot)} ${sq(app.appDir)} ${sq(base)} ${sq(staticRoot)} <<'PY'`,
      "import json",
      "import os",
      "import re",
      "import sys",
      "",
      "transition, live, backup, desired, host, listen, fallback_root, fallback_worktree, app_base, static_root = sys.argv[1:]",
      "root_re = re.compile(r'^\\s*root\\s+\\*\\s+(?:\"([^\"]+)\"|(\\S+))\\s*$', re.MULTILINE)",
      "worktree_re = re.compile(r'^\\s*#\\s*samohost-worktree\\s+\"([^\"]+)\"\\s*$', re.MULTILINE)",
      "root = None",
      "worktree = None",
      "for source in (transition, live, backup):",
      "    if os.path.isfile(source):",
      "        text = open(source, encoding='utf-8').read()",
      "        root_match = root_re.search(text)",
      "        worktree_match = worktree_re.search(text)",
      "        if root_match and root is None: root = root_match.group(1) or root_match.group(2)",
      "        if worktree_match and worktree is None: worktree = worktree_match.group(1)",
      "        if root is not None and worktree is not None: break",
      "if root is None:",
      "    root = fallback_root",
      "if worktree is None:",
      "    suffix = '/' + static_root if static_root else ''",
      "    if suffix and root.endswith(suffix): worktree = root[:-len(suffix)]",
      "    elif not suffix: worktree = root",
      "    else: worktree = fallback_worktree",
      "release_root = app_base.rstrip('/') + '/releases/'",
      "if root != fallback_root and not root.startswith(release_root):",
      "    raise SystemExit('existing static route root is outside the managed app tree')",
      "if worktree != fallback_worktree and not worktree.startswith(release_root):",
      "    raise SystemExit('existing static worktree is outside the managed app tree')",
      "if root != worktree and not root.startswith(worktree.rstrip('/') + '/'):",
      "    raise SystemExit('static route root is outside its worktree')",
      "address = f'http://{host}:80' if listen == 'cp-http80' else host",
      "lines = [address + ' {', '\\t# samohost-worktree ' + json.dumps(worktree), '\\troot * ' + json.dumps(root), '\\ttry_files {path} /index.html', '\\tfile_server', '\\tencode gzip']",
      "if listen == 'tls': lines.append('\\ttls internal')",
      "lines.append('}')",
      "with open(desired, 'w', encoding='utf-8') as output: output.write('\\n'.join(lines) + '\\n')",
      "PY",
    );
  } else {
    const rendered = renderVhost(planFromApp(app));
    lines.push(`printf %s ${sq(rendered)} > "$DESIRED"`);
  }

  lines.push(
    'OLD_ADDRESS=$(python3 - "$BACKUP" "$PRESENCE" <<\'PY\'',
    "import re",
    "import sys",
    "if open(sys.argv[2], encoding='utf-8').read().strip() != 'present': raise SystemExit(0)",
    "text = open(sys.argv[1], encoding='utf-8').read()",
    "match = re.search(r'^\\s*(?:(http)://)?([a-z0-9.-]+)(?::80)?\\s*\\{', text, re.MULTILINE)",
    "if not match: raise SystemExit('cannot parse prior project route address')",
    "print(('http' if match.group(1) else 'https') + '://' + match.group(2))",
    "PY",
    ")",
    `DESIRED_ADDRESS=${sq(`${scheme}://${app.mainHost}`)}`,
    'if [[ -n "$OLD_ADDRESS" && "$OLD_ADDRESS" == "$DESIRED_ADDRESS" ]]; then',
    '  sudo /usr/bin/tee "${LIVE}.next" >/dev/null < "$DESIRED"',
    '  sudo /usr/bin/mv -- "${LIVE}.next" "$LIVE"',
    "else",
    "  restore_previous false",
    '  sudo /usr/bin/tee "$TRANSITION" >/dev/null < "$DESIRED"',
    "fi",
    'caddy validate --config "$CADDYFILE" >/dev/null',
    "sudo /usr/bin/systemctl reload caddy",
    "health_ok=0",
    "for attempt in $(seq 1 5); do",
    `  code=$(curl -s -k -H ${sq(`Host: ${app.mainHost}`)} -o /dev/null -w "%{http_code}" --max-time 10 ${scheme}://127.0.0.1${sq(path)} || echo 000)`,
    '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
    "  sleep 1",
    "done",
    '[[ "$health_ok" == "1" ]] || { echo "error: project main route health check failed" >&2; exit 1; }',
    ...previousRouteHealthLines(app),
    "PREPARED=1",
    'echo "project main route prepared and healthy"',
  );
  return lines.join("\n");
}

function releaseCleanupLines(app: AppRecord, remove: "old" | "new"): string[] {
  if (app.kind !== "static") return [];
  const releases = `${appBase(app)}/releases`;
  const staticRoot = staticRootOf(app) ?? "";
  const currentFile = remove === "old" ? "$BACKUP" : "$TXN/current.caddy";
  const otherFile = remove === "old" ? "$TXN/current.caddy" : "$BACKUP";
  return [
    `RELEASES=${sq(releases)}`,
    `STATIC_ROOT=${sq(staticRoot)}`,
    `REMOVE_WORKTREE=$(sed -n 's/^[[:space:]]*# samohost-worktree "\\(.*\\)"$/\\1/p' "${currentFile}" 2>/dev/null | head -n 1)`,
    `KEEP_WORKTREE=$(sed -n 's/^[[:space:]]*# samohost-worktree "\\(.*\\)"$/\\1/p' "${otherFile}" 2>/dev/null | head -n 1)`,
    `if [[ -z "$REMOVE_WORKTREE" ]]; then REMOVE_WORKTREE=$(sed -n 's/^[[:space:]]*root \\* "\\(.*\\)"$/\\1/p' "${currentFile}" 2>/dev/null | head -n 1); [[ -z "$STATIC_ROOT" || "$REMOVE_WORKTREE" != */"$STATIC_ROOT" ]] || REMOVE_WORKTREE="${'$'}{REMOVE_WORKTREE%/"$STATIC_ROOT"}"; fi`,
    `if [[ -z "$KEEP_WORKTREE" ]]; then KEEP_WORKTREE=$(sed -n 's/^[[:space:]]*root \\* "\\(.*\\)"$/\\1/p' "${otherFile}" 2>/dev/null | head -n 1); [[ -z "$STATIC_ROOT" || "$KEEP_WORKTREE" != */"$STATIC_ROOT" ]] || KEEP_WORKTREE="${'$'}{KEEP_WORKTREE%/"$STATIC_ROOT"}"; fi`,
    'if [[ -n "$REMOVE_WORKTREE" && "$REMOVE_WORKTREE" == "$RELEASES/"* && "$REMOVE_WORKTREE" != "$KEEP_WORKTREE" && -d "$REMOVE_WORKTREE" ]]; then',
    `  git -C ${sq(app.appDir)} worktree remove --force "$REMOVE_WORKTREE" || true`,
    "fi",
    `git -C ${sq(app.appDir)} worktree prune || true`,
  ];
}

/** Restore the snapshot after project prepare or control-plane failure. */
export function buildProjectMainRouteRollbackScript(
  app: AppRecord,
  desiredFingerprint: string,
): string {
  const lines = [
    "#!/usr/bin/env bash",
    "# samohost project main-route transaction rollback",
    ...common(app, desiredFingerprint),
    ...restoreLines(),
    ...restoreBaseLines(app),
    'if [[ ! -f "$TXN/current.caddy" ]]; then if [[ -f "$TRANSITION" ]]; then cat -- "$TRANSITION" > "$TXN/current.caddy"; elif [[ -f "$LIVE" ]]; then cat -- "$LIVE" > "$TXN/current.caddy"; else : > "$TXN/current.caddy"; fi; fi',
    "restore_previous true",
  ];
  {
    const path = app.kind === "static" ? "/" : healthPath(app);
    lines.push(
      'if [[ "$(cat "$PRESENCE")" == "present" ]]; then',
      '  read -r OLD_SCHEME OLD_HOST < <(python3 - "$BACKUP" <<\'PY\'',
      "import re",
      "import sys",
      "text = open(sys.argv[1], encoding='utf-8').read()",
      "match = re.search(r'^\\s*(?:(http)://)?([a-z0-9.-]+)(?::80)?\\s*\\{', text, re.MULTILINE)",
      "if not match: raise SystemExit('cannot parse prior project route address')",
      "print(('http' if match.group(1) else 'https'), match.group(2))",
      "PY",
      "  )",
      "  old_health=0",
      "  for attempt in $(seq 1 5); do",
      `    code=$(curl -s -k -H "Host: $OLD_HOST" -o /dev/null -w "%{http_code}" --max-time 10 "$OLD_SCHEME://127.0.0.1"${sq(path)} || echo 000)`,
      '    if [[ "$code" == "200" ]]; then old_health=1; break; fi',
      "    sleep 1",
      "  done",
      '  [[ "$old_health" == "1" ]] || { echo "error: restored project route is not healthy" >&2; exit 1; }',
      "fi",
    );
  }
  lines.push(
    ...releaseCleanupLines(app, "new"),
    'rm -rf -- "$TXN"',
    'echo "project main route rolled back and healthy"',
  );
  return lines.join("\n");
}

/** Finalize the project transaction after the control-plane hop succeeds. */
export function buildProjectMainRouteCommitScript(
  app: AppRecord,
  desiredFingerprint: string,
): string {
  const lines = [
    "#!/usr/bin/env bash",
    "# samohost project main-route transaction commit",
    ...common(app, desiredFingerprint),
    'if [[ -f "$TRANSITION" ]]; then cat -- "$TRANSITION" > "$TXN/current.caddy"; elif [[ -f "$LIVE" ]]; then cat -- "$LIVE" > "$TXN/current.caddy"; else : > "$TXN/current.caddy"; fi',
  ];
  if (app.mainHost === undefined) {
    lines.push(
      'sudo /usr/bin/rm -f "$LIVE" "$TRANSITION" "${LIVE}.next"',
      'caddy validate --config "$CADDYFILE" >/dev/null',
      "sudo /usr/bin/systemctl reload caddy",
      ...(app.kind === "static"
        ? ['[[ ! -e "$LIVE" ]] || { echo "error: removed project route is still present" >&2; exit 1; }']
        : [
          "health_ok=0",
          "for attempt in $(seq 1 5); do",
          `  code=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 ${sq(app.healthUrl)} || echo 000)`,
          '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
          "  sleep 1",
          "done",
          '[[ "$health_ok" == "1" ]] || { echo "error: project service health check failed after route removal" >&2; exit 1; }',
        ]),
      ': > "$TXN/current.caddy"',
    );
  } else {
    const scheme = app.mainListen === "tls" ? "https" : "http";
    const path = app.kind === "static" ? "/" : healthPath(app);
    lines.push(
      'if [[ -f "$TRANSITION" ]]; then sudo /usr/bin/mv -- "$TRANSITION" "$LIVE"; fi',
      'caddy validate --config "$CADDYFILE" >/dev/null',
      "sudo /usr/bin/systemctl reload caddy",
      "health_ok=0",
      "for attempt in $(seq 1 5); do",
      `  code=$(curl -s -k -H ${sq(`Host: ${app.mainHost}`)} -o /dev/null -w "%{http_code}" --max-time 10 ${scheme}://127.0.0.1${sq(path)} || echo 000)`,
      '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
      "  sleep 1",
      "done",
      '[[ "$health_ok" == "1" ]] || { echo "error: committed project main route is not healthy" >&2; exit 1; }',
    );
  }
  lines.push(
    ...releaseCleanupLines(app, "old"),
    'rm -rf -- "$TXN"',
    'echo "project main route committed and healthy"',
  );
  return lines.join("\n");
}
