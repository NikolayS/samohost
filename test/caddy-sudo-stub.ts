/**
 * A `sudo` stub for executed script tests: drops -n and -u <user> and runs the
 * command; /usr/bin/caddy runs the `caddy` stub found on PATH. Root-run
 * scripts validate Caddy's config as the caddy user (src/caddy/validate.ts).
 */
export const CADDY_SUDO_STUB = [
  "#!/usr/bin/env bash",
  'while [[ $# -gt 0 ]]; do case "$1" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done',
  'c="$1"; shift; if [[ "$c" == /usr/bin/caddy ]]; then c=caddy; fi',
  'exec "$c" "$@"',
  "",
].join("\n");
