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
