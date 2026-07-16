/**
 * Cache headers shared by every static-site Caddy generator.
 *
 * Fingerprinted files are safe to retain indefinitely because changing their
 * contents changes their URL. Documents and runtime config stay revalidated so
 * deploys and preview markers become visible immediately.
 */
export function staticCacheHeaderLines(indent = "\t"): string[] {
  return [
    `${indent}@samohost_immutable path_regexp (?:^|/)[^/]*[._-][A-Za-z0-9_-]{8,}\\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$`,
    `${indent}header @samohost_immutable Cache-Control "public, max-age=31536000, immutable"`,
    `${indent}@samohost_documents path / */ *.html /config.js /version.json`,
    `${indent}header @samohost_documents Cache-Control "no-cache"`,
  ];
}
