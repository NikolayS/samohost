/** Root-owned, app-bound Caddy mutation helper for static deploys. */

import { assertSafeAppIdentity } from "./identity.ts";
import { staticReleaseStatePaths, staticRootOf } from "./static-root.ts";
import type { AppRecord } from "../types.ts";
import { projectMainRouteTransitionPath } from "../caddy/project-main.ts";

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function staticRouteHelperPath(app: AppRecord): string {
  assertSafeAppIdentity(app);
  return `/usr/local/sbin/samohost-static-route-${app.name}`;
}

export function buildStaticRouteHelper(app: AppRecord): string {
  assertSafeAppIdentity(app);
  if (app.kind !== "static" || app.mainHost === undefined) {
    throw new Error("static route helper requires a hosted static app");
  }
  const state = staticReleaseStatePaths(app.appDir);
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const address = app.mainListen === "cp-http80"
    ? `http://${app.mainHost}`
    : app.mainHost;
  const live = `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
  const transition = projectMainRouteTransitionPath(app);
  const request = `${state.releasesDir}/.samohost-route-action`;
  const stagedMain = `${state.releasesDir}/.samohost-main-next.caddy`;
  const stagedBase = `${state.releasesDir}/.samohost-base-next.caddy`;
  const stagedState = `${state.releasesDir}/.samohost-active-state.next`;
  const stagedRoute = `${state.releasesDir}/.samohost-active-route.next`;
  const rootState = `/var/lib/samohost/static-route-${app.name}`;
  const staticRoot = staticRootOf(app) ?? "";
  const tagFormat = app.releaseTagFormat ?? "";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    '[[ "$#" == "0" ]] || { echo "samohost static route helper accepts no arguments" >&2; exit 64; }',
    `REQUEST=${sq(request)}`,
    `STAGED_MAIN=${sq(stagedMain)}`,
    `STAGED_BASE=${sq(stagedBase)}`,
    `STAGED_STATE=${sq(stagedState)}`,
    `STAGED_ROUTE=${sq(stagedRoute)}`,
    `ACTIVE_STATE=${sq(state.activeState)}`,
    `ACTIVE_ROUTE=${sq(state.activeRoute)}`,
    `LIVE=${sq(live)}`,
    `TRANSITION=${sq(transition)}`,
    "CADDYFILE=/etc/caddy/Caddyfile",
    `ROOT_STATE=${sq(rootState)}`,
    '[[ -f "$REQUEST" && ! -L "$REQUEST" ]] || { echo "missing static route action" >&2; exit 1; }',
    'ACTION=$(cat "$REQUEST")',
    'case "$ACTION" in apply|rollback|commit) ;; *) echo "invalid static route action" >&2; exit 1 ;; esac',
    "snapshot() {",
    '  local path="$1" name="$2"',
    '  if [[ -e "$path" ]]; then [[ -f "$path" && ! -L "$path" ]] || return 1; cp -- "$path" "$ROOT_STATE/$name"; stat -c "%u %g %a" "$path" > "$ROOT_STATE/$name.meta"; printf "present\\n" > "$ROOT_STATE/$name.presence"; else printf "absent\\n" > "$ROOT_STATE/$name.presence"; fi',
    "}",
    "restore() {",
    '  local path="$1" name="$2" presence',
    '  presence=$(cat "$ROOT_STATE/$name.presence")',
    '  if [[ "$presence" == "present" ]]; then read -r uid gid mode < "$ROOT_STATE/$name.meta"; install -o "$uid" -g "$gid" -m "$mode" "$ROOT_STATE/$name" "${path}.next"; mv -f "${path}.next" "$path"; elif [[ "$presence" == "absent" ]]; then rm -f "$path" "${path}.next"; else return 1; fi',
    "}",
    "restore_all() {",
    '  restore "$LIVE" live && restore "$TRANSITION" transition && restore "$CADDYFILE" base && restore "$ACTIVE_STATE" active-state && restore "$ACTIVE_ROUTE" active-route',
    "}",
    'if [[ "$ACTION" == "apply" ]]; then',
    '  [[ ! -e "$ROOT_STATE" ]] || { echo "static route transaction already pending" >&2; exit 1; }',
    '  install -d -m 0700 -o root -g root "$ROOT_STATE"',
    '  snapshot "$LIVE" live && snapshot "$TRANSITION" transition && snapshot "$CADDYFILE" base && snapshot "$ACTIVE_STATE" active-state && snapshot "$ACTIVE_ROUTE" active-route || { rm -rf "$ROOT_STATE"; exit 1; }',
    '  [[ -f "$STAGED_MAIN" && ! -L "$STAGED_MAIN" && -f "$STAGED_STATE" && ! -L "$STAGED_STATE" && -f "$STAGED_ROUTE" && ! -L "$STAGED_ROUTE" ]] || { rm -rf "$ROOT_STATE"; echo "unsafe or missing staged route identity" >&2; exit 1; }',
    '  install -m 0600 "$STAGED_MAIN" "$ROOT_STATE/staged-main" && install -m 0600 "$STAGED_STATE" "$ROOT_STATE/staged-state" && install -m 0600 "$STAGED_ROUTE" "$ROOT_STATE/staged-route" || { rm -rf "$ROOT_STATE"; exit 1; }',
    '  stat -c "%u %g %a" "$STAGED_STATE" > "$ROOT_STATE/staged-state.meta"',
    '  stat -c "%u %g %a" "$STAGED_ROUTE" > "$ROOT_STATE/staged-route.meta"',
    '  ROOT_STAGED_BASE=""',
    '  if [[ -e "$STAGED_BASE" ]]; then [[ -f "$STAGED_BASE" && ! -L "$STAGED_BASE" ]] || { rm -rf "$ROOT_STATE"; echo "unsafe staged base Caddyfile" >&2; exit 1; }; install -m 0600 "$STAGED_BASE" "$ROOT_STATE/staged-base"; ROOT_STAGED_BASE="$ROOT_STATE/staged-base"; fi',
    `  TARGET=$(python3 - "$ROOT_STATE/staged-main" "$ROOT_STAGED_BASE" "$LIVE" "$TRANSITION" "$CADDYFILE" ${sq(app.name)} ${sq(address)} ${sq(appBase)} ${sq(state.releasesDir)} "$ROOT_STATE/staged-state" "$ROOT_STATE/staged-route" ${sq(staticRoot)} ${sq(tagFormat)} <<'PY'`,
    "import datetime, json, os, re, subprocess, sys",
    "(staged_main, staged_base, live, transition, caddyfile, app_name, address, app_base, releases, active_state, active_route, static_root, tag_format) = sys.argv[1:]",
    "for path in (staged_main, active_state, active_route):",
    "    if not os.path.isfile(path) or os.path.islink(path): raise SystemExit(f'unsafe or missing app route state: {path}')",
    "with open(active_state, encoding='utf-8') as source: state = json.load(source)",
    "if state.get('schema') != 1 or state.get('appName') != app_name or state.get('staticRoot') != static_root or (state.get('releaseTagFormat') or '') != tag_format: raise SystemExit('active state is not bound to this app')",
    "sha, tag, release_dir = state.get('sha'), state.get('tag'), state.get('releaseDir')",
    "if not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{7,40}', sha) is None: raise SystemExit('invalid active sha')",
    "if not isinstance(tag, str) or not tag or any(ord(ch) < 32 for ch in tag): raise SystemExit('invalid active tag')",
    "if tag_format == 'date': datetime.datetime.strptime(re.fullmatch(r'v([0-9]{8})[.]([1-9][0-9]*)', tag).group(1), '%Y%m%d')",
    "releases_real = os.path.realpath(releases)",
    "release_real = os.path.realpath(release_dir) if isinstance(release_dir, str) else ''",
    "if release_real != release_dir or not release_real.startswith(releases_real + os.sep): raise SystemExit('release escaped app releases')",
    "if subprocess.check_output(['git', '-c', f'safe.directory={release_real}', '-C', release_real, 'rev-parse', 'HEAD'], text=True).strip() != sha: raise SystemExit('release SHA mismatch')",
    "root_path = os.path.normpath(os.path.join(release_real, static_root))",
    "root = os.path.realpath(root_path)",
    "if root != root_path: raise SystemExit('static root contains a symlink')",
    "if root != release_real and not root.startswith(release_real + os.sep): raise SystemExit('static root escaped release')",
    "if not os.path.isfile(os.path.join(root, 'index.html')): raise SystemExit('static root has no index.html')",
    "for walk_root, dirs, files in os.walk(root, followlinks=False):",
    "    for name in dirs + files:",
    "        if os.path.islink(os.path.join(walk_root, name)): raise SystemExit('static tree contains a symlink')",
    "with open(os.path.join(root, 'version.json'), encoding='utf-8') as source: identity = json.load(source)",
    "if identity != {'version': tag, 'tag': tag, 'sha': sha, 'environment': 'production'}: raise SystemExit('version identity mismatch')",
    "expected_route = f'root * \"{root}\"\\ntry_files {{path}} /index.html\\nfile_server\\nencode gzip\\n'",
    "if open(active_route, encoding='utf-8').read() != expected_route: raise SystemExit('active route mismatch')",
    "tls = '' if address.startswith('http://') else '\\n\\ttls internal'",
    "expected_main = f'{address} {{\\n\\t# samohost-worktree \"{release_real}\"\\n\\troot * \"{root}\"\\n\\ttry_files {{path}} /index.html\\n\\tfile_server\\n\\tencode gzip{tls}\\n}}\\n'",
    "if open(staged_main, encoding='utf-8').read() != expected_main: raise SystemExit('staged main route is not canonical')",
    "target = live",
    "if os.path.isfile(live):",
    "    first = open(live, encoding='utf-8').readline().strip().removesuffix(' {')",
    "    if first != address: target = transition",
    "if os.path.exists(staged_base):",
    "    current = open(caddyfile, encoding='utf-8', newline='').readlines()",
    "    def structural_braces(line):",
    "        braces = []; quote = None; escaped = False",
    "        for index, char in enumerate(line):",
    "            if quote is not None:",
    "                if escaped: escaped = False",
    "                elif char == '\\\\' and quote != '`': escaped = True",
    "                elif char == quote: quote = None",
    "                continue",
    "            if char in ('\"', \"'\", '`'): quote = char",
    "            elif char == '#': break",
    "            elif char in '{}': braces.append((index, char))",
    "        return braces",
    "    depth = 0; start = None; header = None; blocks = []",
    "    for n, line in enumerate(current):",
    "        for i, ch in structural_braces(line):",
    "            if ch == '{':",
    "                if depth == 0: start, header = n, line[:i].strip()",
    "                depth += 1",
    "            elif ch == '}':",
    "                depth -= 1",
    "                if depth < 0: raise SystemExit('unmatched base Caddy brace')",
    "                if depth == 0 and start is not None: blocks.append((start, n + 1, header)); start = None",
    "    if depth != 0: raise SystemExit('unmatched base Caddy brace')",
    "    allowed = {':80', 'http://:80', address, address.removeprefix('http://'), ':443', 'https://:443'}",
    "    root_re = re.compile(r'^\\s*root\\s+\\*\\s+(?:\"([^\"]+)\"|([^\\s#]+))')",
    "    candidates = []",
    "    for begin, end, header in blocks:",
    "        roots = [(m.group(1) or m.group(2)) for line in current[begin:end] if (m := root_re.match(line))]",
    "        if header in allowed and any(r == app_base or r.startswith(app_base.rstrip('/') + '/') for r in roots): candidates.append((begin, end))",
    "    if len(candidates) > 1: raise SystemExit('ambiguous app legacy route')",
    "    expected = current if not candidates else current[:candidates[0][0]] + current[candidates[0][1]:]",
    "    rendered = ''.join(expected)",
    "    if re.search(r'^\\s*import\\s+(?:/etc/caddy/)?sites[.]d/[*][.]caddy', rendered, re.MULTILINE) is None: raise SystemExit('base import missing')",
    "    if open(staged_base, encoding='utf-8', newline='').read() != rendered: raise SystemExit('staged base is not the exact app-only migration')",
    "print(target)",
    "PY",
    "  ) || { restore_all || true; rm -rf \"$ROOT_STATE\"; exit 1; }",
    '  if ! { install -m 0644 "$ROOT_STATE/staged-main" "${TARGET}.next" && mv -f "${TARGET}.next" "$TARGET"; }; then restore_all || true; rm -rf "$ROOT_STATE"; exit 1; fi',
    '  if [[ -n "$ROOT_STAGED_BASE" ]] && ! { install -m 0644 "$ROOT_STAGED_BASE" "${CADDYFILE}.next" && mv -f "${CADDYFILE}.next" "$CADDYFILE"; }; then restore_all || true; rm -rf "$ROOT_STATE"; exit 1; fi',
    '  if ! caddy validate --config "$CADDYFILE" >/dev/null || ! /usr/bin/systemctl reload caddy; then restore_all || true; caddy validate --config "$CADDYFILE" >/dev/null && /usr/bin/systemctl reload caddy || true; rm -rf "$ROOT_STATE"; exit 1; fi',
    'elif [[ "$ACTION" == "rollback" ]]; then',
    '  if [[ ! -d "$ROOT_STATE" ]]; then rm -f "$REQUEST" "$STAGED_MAIN" "$STAGED_BASE" "$STAGED_STATE" "$STAGED_ROUTE"; exit 0; fi',
    '  restore_all',
    '  caddy validate --config "$CADDYFILE" >/dev/null && /usr/bin/systemctl reload caddy',
    '  rm -rf "$ROOT_STATE"',
    "else",
    '  [[ -d "$ROOT_STATE" ]] || { echo "no static route transaction to commit" >&2; exit 1; }',
    '  [[ -f "$ROOT_STATE/staged-state" && -f "$ROOT_STATE/staged-route" ]] || { echo "missing root-owned staged active identity" >&2; exit 1; }',
    '  read -r state_uid state_gid state_mode < "$ROOT_STATE/staged-state.meta"',
    '  read -r route_uid route_gid route_mode < "$ROOT_STATE/staged-route.meta"',
    '  if ! { install -o "$state_uid" -g "$state_gid" -m "$state_mode" "$ROOT_STATE/staged-state" "${ACTIVE_STATE}.next" && install -o "$route_uid" -g "$route_gid" -m "$route_mode" "$ROOT_STATE/staged-route" "${ACTIVE_ROUTE}.next" && mv -f "${ACTIVE_STATE}.next" "$ACTIVE_STATE" && mv -f "${ACTIVE_ROUTE}.next" "$ACTIVE_ROUTE"; }; then restore_all || true; caddy validate --config "$CADDYFILE" >/dev/null && /usr/bin/systemctl reload caddy || true; exit 1; fi',
    '  rm -rf "$ROOT_STATE"',
    "fi",
    'rm -f "$REQUEST" "$STAGED_MAIN" "$STAGED_BASE"',
    'if [[ "$ACTION" != "apply" ]]; then rm -f "$STAGED_STATE" "$STAGED_ROUTE"; fi',
  ].join("\n");
}
