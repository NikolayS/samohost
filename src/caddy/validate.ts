/**
 * Caddy config validation in rendered scripts.
 *
 * `caddy validate` opens each vhost's log file. Run as root, it creates a
 * missing log file owned by root with mode 600, which Caddy (running as the
 * caddy user) then cannot open: the next reload fails. Root-run scripts
 * (host-prep, bootstrap) therefore validate as the caddy user.
 */

/** POSIX single-quoted shell word. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Caddy's validation of the whole configuration, by absolute path. */
export const CADDY_VALIDATE = "/usr/bin/caddy validate --config /etc/caddy/Caddyfile";

/** The validation as the caddy user, for scripts that run as root. */
export const CADDY_VALIDATE_AS_CADDY_FROM_ROOT = `sudo -u caddy ${CADDY_VALIDATE}`;

/**
 * Root-run lines that give an existing /var/log/caddy/<app>-prod.log (the log
 * file the app's main vhost names) to caddy when another user owns it, for
 * example a file an earlier root-run validation created. A symbolic link is
 * left as it is.
 */
export function caddyLogOwnerRepairLines(appName: string): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(appName)) {
    throw new Error(`caddyLogOwnerRepairLines: invalid app name ${JSON.stringify(appName)}`);
  }
  return [
    `SAMOHOST_APP_CADDY_LOG=${sq(`/var/log/caddy/${appName}-prod.log`)}`,
    `if [[ -L "$SAMOHOST_APP_CADDY_LOG" ]]; then`,
    `  echo "WARNING: $SAMOHOST_APP_CADDY_LOG is a symbolic link; left as it is" >&2`,
    `elif [[ -f "$SAMOHOST_APP_CADDY_LOG" ]] && id -u caddy >/dev/null 2>&1 && [[ "$(stat -c %U "$SAMOHOST_APP_CADDY_LOG")" != caddy ]]; then`,
    `  chown caddy:caddy "$SAMOHOST_APP_CADDY_LOG"`,
    `  echo "Caddy: $SAMOHOST_APP_CADDY_LOG given to caddy (Caddy opens it as caddy)"`,
    `fi`,
  ];
}
