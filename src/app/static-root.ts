import type { AppSpec } from "../types.ts";

/**
 * Validate the optional directory, relative to a static app checkout, that
 * Caddy serves. Runtime realpath containment checks separately defend against
 * symlink escapes in the checked-out repository.
 */
export function validateStaticRoot(
  staticRoot: string | undefined,
  kind: AppSpec["kind"],
): string | undefined {
  if (staticRoot === undefined) return undefined;
  if (kind !== "static") {
    throw new Error("staticRoot is only valid when kind is 'static'");
  }
  if (staticRoot.length === 0) {
    throw new Error("staticRoot must not be empty");
  }
  if (staticRoot.startsWith("/") || staticRoot.endsWith("/")) {
    throw new Error("staticRoot must be a normalized repo-relative path");
  }

  const segments = staticRoot.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      !/^[A-Za-z0-9._-]+$/.test(segment)
    )
  ) {
    throw new Error(
      "staticRoot must contain only normalized path segments using letters, numbers, '.', '_', or '-'",
    );
  }
  return staticRoot;
}

/** Revalidate records at every script-builder boundary (state can be edited). */
export function staticRootOf(app: Pick<AppSpec, "kind" | "staticRoot">): string | undefined {
  return validateStaticRoot(app.staticRoot, app.kind);
}

/** Stable, app-owned metadata paths shared by tagged deploys and domain add. */
export function staticReleaseStatePaths(appDir: string): {
  releasesDir: string;
  activeState: string;
  activeRoute: string;
} {
  const normalized = appDir.replace(/\/+$/, "");
  const appBase = normalized.split("/").slice(0, -1).join("/");
  const releasesDir = `${appBase}/releases`;
  return {
    releasesDir,
    activeState: `${releasesDir}/.samohost-active-static.json`,
    activeRoute: `${releasesDir}/.samohost-active-static.caddy`,
  };
}

/**
 * Bash helper shared by every static Caddy activation path. It rejects both
 * symlinks used as components of staticRoot and symlinks anywhere below the
 * resolved served directory. Callers run it after checkout and again as close
 * as possible to Caddy staging/reload to narrow the unavoidable TOCTOU window.
 */
export function staticTreeGuardFnLines(): string[] {
  return [
    "samohost_assert_static_tree_safe() {",
    '  local checkout_real="$1" static_real="$2" relative="$3"',
    '  local current="$checkout_real" segment first_link',
    "  local -a segments=()",
    '  if [[ -n "$relative" ]]; then',
    "    IFS='/' read -r -a segments <<< \"$relative\"",
    '    for segment in "${segments[@]}"; do',
    '      current="$current/$segment"',
    '      if [[ -L "$current" ]]; then',
    '        echo "staticRoot path contains a symlink; refusing Caddy activation" >&2',
    "        return 1",
    "      fi",
    "    done",
    "  fi",
    '  if ! first_link=$(/usr/bin/find -P "$static_real" -type l -print -quit); then',
    '    echo "cannot inspect staticRoot for symlinks; refusing Caddy activation" >&2',
    "    return 1",
    "  fi",
    '  if [[ -n "$first_link" ]]; then',
    '    echo "staticRoot tree contains a symlink; refusing Caddy activation" >&2',
    "    return 1",
    "  fi",
    "}",
  ];
}
