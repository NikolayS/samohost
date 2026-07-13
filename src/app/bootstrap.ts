/**
 * Pure OS-level host bootstrap script builder (PR-A1 + PR-A2).
 *
 * `buildHostBootstrapScript` turns an {@link AppRecord} + {@link HostBootstrapOptions}
 * into a single self-contained bash program printed for an operator with root to
 * review before applying. It is the generic, idempotent port of
 * field-record-1's `deploy/scratch/stack-prep.sh`, parameterized by the
 * AppRecord — NO field-record hardcoding.
 *
 * ---------------------------------------------------------------------------
 * SCOPE (PR-A1 — OS prep):
 *
 *  1. Runtime installs: Node (via NodeSource), PostgreSQL (via PGDG with
 *     apt-cache fallback and PG_FALLBACK log line), Caddy (official apt repo),
 *     plus git/build-essential/openssl/ca-certificates/curl/gnupg.
 *     Guards: skip if already present (idempotent).
 *
 *  2. App OS user: `useradd --create-home --shell /bin/bash` (NOT adduser —
 *     adduser's chfn dies on the hardened box's expired-password PAM).
 *     Copies operator key from root's (or SUDO_USER's) authorized_keys.
 *
 *  3. /opt/<app> layout: appBase, ${appBase}/uploads, appDir — owned by appUser.
 *
 *  4. Deploy sudoers /etc/sudoers.d/<name>-agent: full-path NOPASSWD grants
 *     for systemctl (daemon-reload, enable, start, stop, restart), psql as
 *     postgres, journalctl *. Validated with `visudo -cf`. Issue #99: every
 *     grant is an EXACT absolute path (Defaults use_pty assumed in effect).
 *
 *  5. MAIN systemd service unit /etc/systemd/system/<serviceUnit>.service.
 *     NOT the template @.service — that is owned by host-prep. Runs
 *     daemon-reload + enable (start deferred to first deploy).
 *
 *  6. sshd AllowUsers 09- drop-in for the app user (sorts before the hardening
 *     baseline's 10-samohost.conf).
 *
 *  7. Caddy base config: /etc/caddy/Caddyfile with `import sites.d/*.caddy`,
 *     mkdir sites.d, `caddy validate` before reload. TLS mode: acme (default)
 *     or local (=> `local_certs` global).
 *
 * ---------------------------------------------------------------------------
 * SCOPE (PR-A2 — DB bootstrap, base env file, token-safe repo clone):
 *
 *  d. DB superuser bootstrap + createdb: enable postgresql, wait-for-ready
 *     loop, set/rotate the `postgres` superuser password generated ON-HOST
 *     with `openssl rand -hex 24` (fed to psql via STDIN with dollar-quoting;
 *     NEVER in argv). Idempotent reuse from existing env file. Then idempotent
 *     `createdb <dbName>` guarded by pg_database SELECT.
 *     CRITICAL: dbName is REQUIRED and EXPLICIT — never derived from app.name.
 *
 *  e. Base env file seeding (600, appUser-owned): DATABASE_URL (superuser),
 *     APP_DATABASE_URL placeholder (app role + 'app_password' — rotated by
 *     deploy.sh on first deploy), NODE_ENV, PORT (from healthUrl), HOST,
 *     COOKIE_SECRET (on-host openssl rand), SEED_OWNER_LOGIN/PASSWORD.
 *     PG_BACKEND is intentionally NOT written here (lives in unit Environment=).
 *     Idempotent: reuses existing pw/secret/DEPLOYED_SHA values.
 *
 *  f. FULL token-safe repo clone: token from FD 3 or pre-placed 600 `.gh-token`
 *     file (NEVER from FD 0/STDIN — the script body is piped there; NEVER in
 *     argv or remote URL). credential.helper reads the token
 *     file BY PATH at runtime. Full clone (no --depth). Clone into app.appDir;
 *     git-safe.conf for dubious-ownership. Idempotent: leaves existing checkout.
 *
 *  §11. Extended self-check table: postgres ready, db present,
 *       staging.env 600, app clone present.
 *
 * ---------------------------------------------------------------------------
 * The builder is PURE: no I/O, no network, fully deterministic.
 * ---------------------------------------------------------------------------
 *
 * @see buildHostPrepScript in src/env/script.ts for the complementary
 *      host-prep (preview template unit, Caddy include wiring, env sudoers).
 */

import type { AppRecord } from "../types.ts";
import { buildFirewallLines, type HostPrepFirewallOpts } from "../env/script.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the host bootstrap script (PR-A1 OS prep + PR-A2 DB/env/clone).
 *
 * `appUser` and `dbName` are REQUIRED. All other fields are optional with
 * documented defaults.
 */
export interface HostBootstrapOptions {
  /**
   * OS user created on the host to own the app and run the systemd service
   * (e.g. "agent"). Required — no sane default because leaking to a wrong
   * user is a privilege-escalation risk.
   */
  appUser: string;

  /**
   * PR-A2 — the database name to create on the host.
   *
   * REQUIRED for non-static apps (`app.kind !== 'static'`). Must be passed
   * explicitly — never derived from app.name (the production DB name is opaque
   * to samohost). The critic flagged: 'field-record-1'.replace(/-/g,'_') =
   * 'field_record_1' but the live box's DB is 'field_record'.
   *
   * Optional for static apps (`app.kind === 'static'`): static sites have no
   * database; passing `dbName` when absent will cause the builder to throw with
   * a clear error for non-static apps. Static calls should simply omit this field.
   */
  dbName?: string;

  /**
   * Firewall options for the generated firewall rules section (static apps only).
   *
   * When set, the bootstrap script includes source-restricted ufw rules:
   *  - `:443` open ONLY to Cloudflare IP ranges (fetched at runtime; default true)
   *  - `:80` open ONLY to the single `controlPlaneIp` (when provided)
   *
   * For non-static apps the firewall section is omitted (the host-prep script
   * owns the firewall for node apps). For static apps a basic CF-direct firewall
   * is always emitted; this option lets callers opt-in to the control-plane :80 rule.
   */
  firewallOpts?: HostPrepFirewallOpts;

  /**
   * Base directory for the app on the host (e.g. /opt/field-record).
   * Default: `/opt/<app.name>`.
   */
  appBase?: string;

  /**
   * Node.js major version to install via NodeSource. Default 22.
   */
  nodeMajor?: number;

  /**
   * PostgreSQL major version to install via PGDG. Default 18. The script
   * includes the PG_FALLBACK apt-cache logic to print the chosen version
   * when the exact major is unavailable (port of stack-prep.sh §2).
   */
  pgMajor?: number;

  /**
   * ExecStart for the MAIN systemd unit. Default "/usr/bin/node dist/server.js".
   */
  execStart?: string;

  /**
   * TLS mode for the Caddy base config. "acme" (default) uses Caddy's ACME
   * HTTP-01/TLS-ALPN; "local" adds a `local_certs` global directive (useful
   * for LAN setups where ACME cannot reach port 80). Port of stack-prep.sh §9.
   */
  tlsMode?: "acme" | "local";

  /**
   * PR-A2 — The app (non-superuser, RLS) database role name written into the
   * APP_DATABASE_URL placeholder. Default "app_user". The placeholder password
   * is the literal 'app_password' — deploy.sh rotates it on first deploy.
   */
  appDbRole?: string;

  /**
   * PR-A2 — The login name written into SEED_OWNER_LOGIN in the env file.
   * Default "owner".
   */
  seedOwnerLogin?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote a string for safe embedding in the generated bash (same byte
 * form as app/script.ts:81 and env/script.ts:392 — never reimplemented
 * divergently). Only interpolates operator-controlled AppRecord values and
 * opts — never secrets.
 */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Derive the main-env listen port from app.healthUrl.
 * Replicates env/script.ts:mainEnvPort() — replicated here to avoid a
 * cross-module import that would create a cycle (bootstrap.ts uses no other
 * env/ types). Fails closed on unparseable URL.
 */
function bootstrapPort(app: AppRecord): number {
  let u: URL;
  try {
    u = new URL(app.healthUrl);
  } catch {
    throw new Error(
      `buildHostBootstrapScript: cannot derive PORT for app '${app.name}': ` +
        `unparseable healthUrl ${JSON.stringify(app.healthUrl)}`,
    );
  }
  if (u.port !== "") return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the host bootstrap script. The result is one self-contained bash
 * program to be reviewed and applied by an operator with root.
 *
 * NOT executed by samohost itself: the operator pipes it to `bash` after
 * review (same contract as `buildHostPrepScript`).
 */
export function buildHostBootstrapScript(
  app: AppRecord,
  opts: HostBootstrapOptions,
): string {
  const isStatic = app.kind === "static";
  const isStaticReleaseChannel = isStatic && app.releaseTagPattern !== undefined;

  // Guard: dbName is required for non-static apps (node apps need a database).
  // Static apps have no database — callers MUST omit dbName for static and
  // MUST supply it for node apps. Failing loudly here prevents a silent
  // undefined-propagation bug that would produce a broken script.
  if (!isStatic && opts.dbName === undefined) {
    throw new Error(
      `buildHostBootstrapScript: dbName is required for non-static apps (app.kind is '${app.kind ?? "node"}', not 'static'). ` +
        `Pass dbName explicitly via HostBootstrapOptions — never derive it from app.name.`,
    );
  }

  const appUser = opts.appUser;
  const dbName = opts.dbName; // required for non-static (guarded above); undefined for static
  const nodeMajor = opts.nodeMajor ?? 22;
  const pgMajor = opts.pgMajor ?? 18;
  const execStart = opts.execStart ?? "/usr/bin/node dist/server.js";
  const tlsMode = opts.tlsMode ?? "acme";
  const appBase = opts.appBase ?? `/opt/${app.name}`;
  const appDir = app.appDir;
  const unit = app.serviceUnit;
  const envFile = app.envFile ?? `${appBase}/staging.env`;
  const sudoersFile = `/etc/sudoers.d/${app.name}-agent`;
  const tokenFile = `${appBase}/.gh-token`;
  const gitSafeConf = `${appBase}/git-safe.conf`;
  const repoUrl = `https://github.com/${app.repo}.git`;
  const appPort = bootstrapPort(app);
  const appDbRole = opts.appDbRole ?? "app_user";
  const seedOwnerLogin = opts.seedOwnerLogin ?? "owner";
  const rlsUrlVar = app.rlsUrlVar ?? "APP_DATABASE_URL";

  const lines: string[] = [];
  const push = (...l: string[]): void => {
    for (const x of l) lines.push(x);
  };

  // ---- header ---------------------------------------------------------------
  push(
    "#!/usr/bin/env bash",
    `# samohost host-bootstrap for app ${sq(app.name)} — OS prep + DB + env + clone (PR-A1/A2).`,
    "# Generated; review before applying. NOT auto-executed by samohost.",
    "# PR-A1 scope: runtimes, OS user, /opt layout, sudoers, MAIN unit,",
    "#   sshd AllowUsers, Caddy base config.",
    "# PR-A2 scope: DB bootstrap, base env file, token-safe repo clone, extended self-check.",
    "# Token handling: read from FD 3 (if attached) or pre-placed 600 file at",
    `#   ${tokenFile}. NEVER from FD 0 (the script body is piped there via 'bash -s'),`,
    "#   NEVER in argv, NEVER in remote URL.",
    "set -euo pipefail",
    "",
  );

  // ---- section 0: read GitHub token from FD 3 or pre-placed file ------------
  //
  // CRITICAL (samohost#80 fresh-VM regression): this script is delivered by
  // PIPING it to `bash -s` over ssh — the ENTIRE program body is on the
  // process's stdin (FD 0). See defaultRemoteScriptRunner in commands/app.ts.
  //
  // An earlier version read the token with `IFS= read -r _tok` (from FD 0).
  // On a fresh VM (no pre-placed token file) that `read` executed and consumed
  // the NEXT LINE OF THE SCRIPT ITSELF off FD 0 — eating the
  // `if [[ -s "$TOKEN_FILE" ]]; then` line and leaving a dangling `else`:
  //   bash: line 31: syntax error near unexpected token 'else'
  // so Caddy + the main unit never installed and every preview 522'd.
  // `bash -n` could never catch it because `bash -n` does not RUN `read`.
  //
  // FIX: read the token ONLY from a dedicated file descriptor (FD 3), NEVER
  // FD 0. With the `bash -s` delivery, FD 3 is not open, so the read is a
  // clean no-op (the script body on FD 0 is untouched) and we fall through to
  // the pre-placed-token-file path. A caller that genuinely wants to inject a
  // token at runtime can attach it on FD 3 (e.g. `bash -s 3< token`), keeping
  // the original STDIN-injection capability without ever cannibalizing FD 0.
  push(
    `# ---------------------------------------------------------------------------`,
    `# §0. GitHub token: read from FD 3 (if attached) or ${sq(tokenFile)} (pre-placed).`,
    `#     This script is piped to 'bash -s' on FD 0, so the token is NEVER read`,
    `#     from FD 0 (that would consume the script body itself — samohost#80).`,
    `#     A caller may attach the token on FD 3 ('bash -s 3< token'); otherwise`,
    `#     the pre-placed 600 file is used. NEVER echoed, logged, or placed in argv.`,
    `# ---------------------------------------------------------------------------`,
    "",
    `TOKEN_FILE=${sq(tokenFile)}`,
    `mkdir -p ${sq(appBase)}`,
    `if [[ ! -s "$TOKEN_FILE" ]]; then`,
    `  # No token file yet: try FD 3 (a dedicated channel — never the FD 0 the`,
    `  # script itself is being read from). If FD 3 is not open the read is a`,
    `  # clean no-op and we fall through to the pre-placed-file path below.`,
    `  _tok=""`,
    `  if { IFS= read -r _tok <&3; } 2>/dev/null; then :; else _tok=""; fi`,
    `  if [[ -n "$_tok" ]]; then`,
    `    ( umask 077; printf '%s' "$_tok" > "$TOKEN_FILE" )`,
    `    unset _tok`,
    `    echo "GitHub token captured from FD 3 -> $TOKEN_FILE (600). [value not logged]"`,
    `  fi`,
    `fi`,
    `if [[ -s "$TOKEN_FILE" ]]; then`,
    `  chmod 600 "$TOKEN_FILE"`,
    `  echo "GitHub token present at $TOKEN_FILE."`,
    `else`,
    `  echo "WARNING: no GitHub token (FD 3 empty and $TOKEN_FILE absent). Clone step will be SKIPPED."`,
    `fi`,
    "",
  );

  // ---- section 1: base packages + NodeSource --------------------------------
  // Static apps skip Node.js: they are served directly by Caddy file_server and
  // need no Node runtime on the host. Base tools (git, curl, gnupg) are still
  // installed because they are used by §12 (clone) and the operator toolchain.
  if (!isStatic) {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §1. Base packages + Node.js ${nodeMajor} (NodeSource) — idempotent guards.`,
      `# ---------------------------------------------------------------------------`,
      "",
      "# 1a. Base tools (idempotent: apt is idempotent on already-installed packages).",
      "apt-get update -qq",
      "apt-get install -y --no-install-recommends \\",
      "  git build-essential openssl ca-certificates curl gnupg",
      "",
      `# 1b. Node.js ${nodeMajor} via NodeSource (skip if already at target major).`,
    `if command -v node >/dev/null 2>&1 \\`,
    `   && [[ "$(node --version 2>/dev/null | cut -d. -f1 | tr -d v)" == "${nodeMajor}" ]]; then`,
    `  echo "Node.js ${nodeMajor} already present — skipping NodeSource install."`,
    "else",
    `  echo "Installing Node.js ${nodeMajor} via NodeSource..."`,
    `  curl -fsSL https://deb.nodesource.com/setup_${nodeMajor}.x | bash -`,
    "  apt-get install -y nodejs",
    "fi",
    `echo "node version: $(node --version)"`,
    "",
  );
  } else {
    // Static §1: base tools only (no NodeSource).
    push(
      `# ---------------------------------------------------------------------------`,
      `# §1. Base packages (static site — Node.js NOT installed; not needed for file_server).`,
      `# ---------------------------------------------------------------------------`,
      "",
      "# Base tools (idempotent: apt is idempotent on already-installed packages).",
      "apt-get update -qq",
      "apt-get install -y --no-install-recommends \\",
      "  git build-essential openssl ca-certificates curl gnupg",
      "",
    );
  }

  // ---- section 2: PostgreSQL via PGDG with PG_FALLBACK ----------------------
  // Static apps skip PostgreSQL entirely: they have no database.
  if (!isStatic) {
  push(
    `# ---------------------------------------------------------------------------`,
    `# §2. PostgreSQL ${pgMajor} via PGDG (idempotent; PG_FALLBACK if major unavailable).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `if command -v psql >/dev/null 2>&1; then`,
    `  echo "PostgreSQL already present — skipping PGDG install."`,
    "else",
    // PG-PAM fix (field-record-1#117, host-bootstrap PG/PAM-chfn fix — found on smoke VM):
    // postgresql-common's postinst calls `adduser --system ... postgres` which
    // internally invokes `chfn` to set GECOS info. On a PAM-password-expired
    // (hardened) box, chfn fails:
    //   "Authentication token is no longer valid; new one required" (exit 82)
    // leaving PG unconfigured → the whole bootstrap aborts (rc 100).
    //
    // The postinst guards its adduser call with:
    //   if ! getent passwd postgres > /dev/null; then adduser ... fi
    // So pre-creating the postgres system user+group with useradd (no adduser,
    // no chfn, no PAM auth) causes the postinst to skip that dangerous path
    // entirely.
    //
    // This mirrors the rationale already applied to the APP user in §4 (useradd,
    // NOT adduser — adduser's chfn dies on the hardened box). Scoped to the PG
    // install block (only runs when PG is not yet installed). Idempotent.
    `  # PG-PAM fix (samohost#117): postgresql-common's postinst runs chfn on the`,
    `  # 'postgres' system user. On a PAM-password-expired (hardened) box, chfn`,
    `  # exits 82 ("Authentication token is no longer valid"), leaving PG unconfigured.`,
    `  # Pre-create the postgres system user+group with useradd (no chfn, no PAM auth)`,
    `  # so the postinst finds the user present and skips that path. Idempotent.`,
    `  # Mirrors §4 (app OS user also uses useradd for the same reason).`,
    `  if ! id postgres >/dev/null 2>&1; then`,
    `    useradd --system --user-group --home-dir /var/lib/postgresql --shell /bin/bash postgres`,
    `  fi`,
    "",
    `  # Add PGDG apt repo.`,
    `  install -d /usr/share/postgresql-common/pgdg`,
    `  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \\`,
    `    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg`,
    `  sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] \\`,
    `    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \\`,
    `    > /etc/apt/sources.list.d/pgdg.list'`,
    `  apt-get update -qq`,
    "",
    `  # Install the requested major; fall back to the latest available if absent.`,
    `  PG_TARGET=${pgMajor}`,
    `  if apt-cache show "postgresql-${pgMajor}" >/dev/null 2>&1; then`,
    `    apt-get install -y "postgresql-${pgMajor}"`,
    `  else`,
    `    # PG_FALLBACK: target major ${pgMajor} not in PGDG for this distro.`,
    `    PG_AVAILABLE="$(apt-cache search '^postgresql-[0-9]+$' \\`,
    `      | awk '{print $1}' | sort -t- -k2 -n | tail -1)"`,
    `    echo "PG_FALLBACK: postgresql-${pgMajor} unavailable; installing \${PG_AVAILABLE} instead."`,
    `    apt-get install -y "\${PG_AVAILABLE}"`,
    `  fi`,
    `  echo "pg_target=${pgMajor} pg_installed=\$(psql --version 2>&1 | head -1)"`,
    "fi",
    "",
  );
  } // end if (!isStatic) for §2

  // ---- section 3: Caddy via official apt repo -------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §3. Caddy via official apt repo (idempotent).`,
    `# ---------------------------------------------------------------------------`,
    "",
    ...(isStaticReleaseChannel ? [`SAMOHOST_CADDY_INSTALLED_NOW=0`] : []),
    `if command -v caddy >/dev/null 2>&1; then`,
    `  echo "Caddy already present — skipping apt install."`,
    "else",
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \\`,
    `    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`,
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \\`,
    `    | tee /etc/apt/sources.list.d/caddy-stable.list`,
    `  apt-get update -qq`,
    `  apt-get install -y caddy`,
    ...(isStaticReleaseChannel ? [`  SAMOHOST_CADDY_INSTALLED_NOW=1`] : []),
    "fi",
    "",
  );

  // ---- section 4: OS user + authorized_keys ---------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §4. App OS user ${sq(appUser)}.`,
    `#     useradd --create-home (not the interactive variant whose chfn step`,
    `#     fails on the hardened box's expired-password PAM configuration).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `if id ${sq(appUser)} >/dev/null 2>&1; then`,
    `  echo "User ${sq(appUser)} already exists — skipping useradd."`,
    "else",
    `  useradd --create-home --shell /bin/bash ${sq(appUser)}`,
    "fi",
    "",
    `# Copy the operator's authorized_keys to the app user so the same SSH key`,
    `# that provisioned the box can also authenticate as ${sq(appUser)}.`,
    `# Prefer SUDO_USER's key (the actual operator); fall back to root's.`,
    `OPERATOR_KEYS=""`,
    `if [[ -n "\${SUDO_USER:-}" ]] && [[ -f "/home/\${SUDO_USER}/.ssh/authorized_keys" ]]; then`,
    `  OPERATOR_KEYS="/home/\${SUDO_USER}/.ssh/authorized_keys"`,
    `elif [[ -f /root/.ssh/authorized_keys ]]; then`,
    `  OPERATOR_KEYS="/root/.ssh/authorized_keys"`,
    `fi`,
    `if [[ -n "\${OPERATOR_KEYS}" ]]; then`,
    `  install -d -m 700 -o ${sq(appUser)} -g ${sq(appUser)} "/home/${appUser}/.ssh"`,
    `  install -m 600 -o ${sq(appUser)} -g ${sq(appUser)} "\${OPERATOR_KEYS}" \\`,
    `    "/home/${appUser}/.ssh/authorized_keys"`,
    `  echo "Copied \${OPERATOR_KEYS} -> /home/${appUser}/.ssh/authorized_keys"`,
    `else`,
    `  echo "WARNING: no operator authorized_keys found; skipping key copy." >&2`,
    `fi`,
    "",
  );

  // ---- section 5: /opt/<app> layout -----------------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §5. /opt/${app.name} directory layout (appBase, uploads, appDir).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(appBase)}`,
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(`${appBase}/uploads`)}`,
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(appDir)}`,
    `echo "Layout: ${appBase}/ (uploads/, app checkout at ${appDir})"`,
    "",
  );

  // ---- section 6: deploy sudoers --------------------------------------------
  // Static apps get a reduced sudoers: no unit-specific grants (the main unit
  // does not exist), no psql grant (no DB). Only daemon-reload and journalctl
  // are retained (daemon-reload is needed for caddy reload; journalctl for logs).
  if (isStatic) {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §6. Deploy sudoers ${sudoersFile} (static app — no unit grants).`,
      `#     Defaults use_pty assumed in effect; every grant is an EXACT full path`,
      `#     (Defaults use_pty + exact-path NOPASSWD — issue #99).`,
      `# ---------------------------------------------------------------------------`,
      "",
      `cat > ${sq(sudoersFile)} <<SUDOERS`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy`,
      ...(isStaticReleaseChannel
        ? [
          `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/.samohost-next-Caddyfile`,
          `${appUser} ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/.samohost-next-Caddyfile /etc/caddy/Caddyfile`,
          `${appUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/.samohost-next-Caddyfile`,
        ]
        : []),
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/journalctl *`,
      "SUDOERS",
      `chmod 440 ${sq(sudoersFile)}`,
      `visudo -cf ${sq(sudoersFile)}`,
      `echo "Sudoers: ${sudoersFile} written and validated (static — no unit grants)."`,
      "",
    );
  } else {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §6. Deploy sudoers ${sudoersFile}`,
      `#     Defaults use_pty assumed in effect; every grant is an EXACT full path`,
      `#     (Defaults use_pty + exact-path NOPASSWD — issue #99).`,
      `#     samohost is push-based (no timer); no timer/path-deploy grants here.`,
      `# ---------------------------------------------------------------------------`,
      "",
      `cat > ${sq(sudoersFile)} <<SUDOERS`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${unit}`,
      `${appUser} ALL=(postgres) NOPASSWD: /usr/bin/psql`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/journalctl *`,
      "SUDOERS",
      `chmod 440 ${sq(sudoersFile)}`,
      `visudo -cf ${sq(sudoersFile)}`,
      `echo "Sudoers: ${sudoersFile} written and validated."`,
      "",
    );
  }

  // ---- section 7: MAIN systemd service unit ---------------------------------
  // Static apps have no systemd unit: Caddy serves the checkout directly via
  // file_server. Skip this section entirely for static apps.
  if (!isStatic) {
  push(
    `# ---------------------------------------------------------------------------`,
    `# §7. MAIN systemd unit /etc/systemd/system/${unit}.service`,
    `#     This is the NON-TEMPLATE unit (host-bootstrap scope). The preview`,
    `#     template unit (the at-service variant) is owned by host-prep.`,
    `#     start is deferred to first deploy (daemon-reload + enable only).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `cat > /etc/systemd/system/${unit}.service <<'UNIT'`,
    "[Unit]",
    `Description=${app.name} main service`,
    "After=network.target postgresql.service",
    "",
    "[Service]",
    `User=${appUser}`,
    `Group=${appUser}`,
    `WorkingDirectory=${appDir}`,
    `EnvironmentFile=${envFile}`,
    `ExecStart=${execStart}`,
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    `/usr/bin/systemctl daemon-reload`,
    `# Enable unit so it starts on reboot; start is deferred to first deploy.`,
    `/usr/bin/systemctl enable ${unit}`,
    `echo "Unit /etc/systemd/system/${unit}.service written, enabled (start deferred to first deploy)."`,
    "",
  );
  } // end if (!isStatic) for §7

  // ---- section 8: sshd AllowUsers 09- drop-in --------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §8. sshd AllowUsers 09- drop-in for ${sq(appUser)}.`,
    `#     Sorts before the hardening baseline 10-samohost.conf. Idempotent.`,
    `# ---------------------------------------------------------------------------`,
    "",
    `SSHD_DROPIN="/etc/ssh/sshd_config.d/09-${app.name}-app-user.conf"`,
    `if grep -q "AllowUsers" "\${SSHD_DROPIN}" 2>/dev/null; then`,
    `  echo "sshd AllowUsers drop-in \${SSHD_DROPIN} already present — skipping."`,
    "else",
    `  printf 'AllowUsers %s\\n' ${sq(appUser)} >> "\${SSHD_DROPIN}"`,
    `  echo "sshd drop-in \${SSHD_DROPIN}: added AllowUsers ${appUser}"`,
    "fi",
    `# Reload sshd to pick up the new AllowUsers entry.`,
    `/usr/bin/systemctl reload ssh || /usr/bin/systemctl reload sshd || true`,
    "",
  );

  // ---- section 9: Caddy base config -----------------------------------------
  const caddyfileHeader = tlsMode === "local"
    ? ["# Caddy global options (local TLS — no ACME).", "{", "  local_certs", "}"]
    : ["# Caddy global options (ACME TLS — default)."];

  push(
    `# ---------------------------------------------------------------------------`,
    `# §9. Caddy base Caddyfile (import sites.d/*.caddy; tls=${tlsMode}).`,
    `#     caddy validate runs before reload (catches syntax errors early).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `mkdir -p /etc/caddy/sites.d`,
    "",
  );
  if (isStaticReleaseChannel) {
    push(
      `# A release-channel static app may already be serving a legacy route`,
      `# directly from this base file. Preserve it byte-for-byte and add only`,
      `# the required import. The first healthy tagged deploy owns retirement.`,
      `if [[ "\${SAMOHOST_CADDY_INSTALLED_NOW:-0}" == "1" || ! -f /etc/caddy/Caddyfile ]]; then`,
      `  # A just-installed package Caddyfile is vendor sample content, not a`,
      `  # legacy production route. Start fresh hosts from the canonical base.`,
      `  cat > /etc/caddy/Caddyfile <<'CADDYFILE'`,
      ...caddyfileHeader,
      "",
      "import sites.d/*.caddy",
      "CADDYFILE",
      `elif grep -Eq '^[[:space:]]*import[[:space:]]+(/etc/caddy/)?sites\\.d/\\*\\.caddy([[:space:]]*(#.*)?)?$' /etc/caddy/Caddyfile; then`,
      `  echo "Caddy: existing sites.d import preserved."`,
      `else`,
      `  printf '\nimport sites.d/*.caddy\n' >> /etc/caddy/Caddyfile`,
      `  echo "Caddy: sites.d import appended without replacing legacy routes."`,
      `fi`,
      "",
    );
  } else {
    push(
      `# Write a minimal-but-valid Caddyfile. Idempotent: overwrite with the`,
      `# deterministic content — no append-drift.`,
      `cat > /etc/caddy/Caddyfile <<'CADDYFILE'`,
      ...caddyfileHeader,
      "",
      "import sites.d/*.caddy",
      "CADDYFILE",
      "",
    );
  }
  push(
    `caddy validate --config /etc/caddy/Caddyfile`,
    `/usr/bin/systemctl enable caddy`,
    `/usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy`,
    `echo "Caddy: Caddyfile ${isStaticReleaseChannel ? "ready" : "written"} (tls=${tlsMode}), validated, reloaded."`,
    "",
  );

  // ---- static branch-channel: production Caddy file_server vhost block ------
  // Branch-channel static apps preserve the legacy bootstrap-owned appDir
  // route. Release-channel static apps MUST NOT create or replace this vhost:
  // only the tag-authorized deploy transaction may atomically activate a
  // versioned candidate. This also makes bootstrap reruns preserve that route.
  if (isStatic && !isStaticReleaseChannel && app.mainHost !== undefined) {
    const caddySitePath = `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
    const siteAddress = app.mainListen === "cp-http80"
      ? `http://${app.mainHost}`
      : app.mainHost;
    push(
      `# ---------------------------------------------------------------------------`,
      `# §9b. Production Caddy file_server vhost for ${sq(app.mainHost)}.`,
      `#      tls internal: CF Full-mode proxying; ACME cannot complete behind CF :443.`,
      `#      file_server: serves the static checkout at ${sq(app.appDir)} directly.`,
      `#      Idempotent: overwrite with deterministic content.`,
      `# ---------------------------------------------------------------------------`,
      "",
      `cat > ${sq(caddySitePath)} <<'CADDY_SITE'`,
      `${siteAddress} {`,
      `  root * ${app.appDir}`,
      `  try_files {path} /index.html`,
      `  file_server`,
      `  encode gzip`,
      ...(app.mainListen === "cp-http80" ? [] : [`  tls internal`]),
      `}`,
      `CADDY_SITE`,
      `caddy validate --config /etc/caddy/Caddyfile`,
      `/usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy`,
      `echo "Caddy: static file_server vhost ${app.mainHost} -> ${app.appDir} written."`,
      "",
    );
  }

  // ---- static-only: firewall rules ------------------------------------------
  // For static apps, emit source-restricted ufw rules. The app is served
  // directly by Caddy on :443 (CF Full-mode origin): only Cloudflare edge IPs
  // may reach :443. Optionally, :80 is opened only to the control-plane IP.
  // This mirrors buildFirewallLines from env/script.ts — reused here so the
  // same CF-range-fetch logic is not duplicated.
  if (isStatic) {
    const fwLines = buildFirewallLines(true, appUser, opts.firewallOpts);
    push(
      `# ---------------------------------------------------------------------------`,
      `# §9c. Firewall (static app — source-restricted; world-open ufw allow NEVER emitted).`,
      `#      Mirrors buildFirewallLines (env/script.ts). CF ranges fetched at run time.`,
      `# ---------------------------------------------------------------------------`,
      "",
      ...fwLines,
      "",
    );
  }

  // ---- section 10 (PR-A2-d): PostgreSQL DB bootstrap ------------------------
  // Static apps skip §10 and §11 entirely: they have no database and no env file.
  if (!isStatic) {
  // The outer guard (~line 221) already throws when !isStatic && dbName===undefined,
  // but TypeScript cannot carry that narrowing through the `const dbName` assignment.
  // This guard is the TS-visible narrowing point: after it dbName is `string`.
  if (dbName === undefined) {
    throw new Error(
      "buildHostBootstrapScript: dbName is required for non-static apps (internal invariant violated)",
    );
  }
  push(
    `# ---------------------------------------------------------------------------`,
    `# §10. DB bootstrap (PR-A2-d): enable postgresql, wait-for-ready,`,
    `#      set/rotate postgres superuser password (on-host openssl rand, STDIN-fed`,
    `#      to psql with dollar-quoting — NEVER in argv/environment), createdb.`,
    `#`,
    `#      CRITICAL: dbName is ${sq(dbName)} — passed explicitly, NEVER derived`,
    `#      from app.name (which could produce a different string via transforms).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `ENV_FILE=${sq(envFile)}`,
    "",
    `# Enable and start postgresql. Try the meta-unit first; fall back to the`,
    `# versioned cluster unit if needed.`,
    `/usr/bin/systemctl enable --now postgresql 2>/dev/null || true`,
    `if ! sudo -u postgres psql -p 5432 -qAtc 'select 1' >/dev/null 2>&1; then`,
    `  pg_ctlcluster "$(pg_lsclusters -h | awk '{print $1}' | head -1)" main start 2>/dev/null || true`,
    `fi`,
    `# Wait up to 30 s for the cluster to accept connections.`,
    `for _ in $(seq 1 30); do`,
    `  sudo -u postgres psql -p 5432 -qAtc 'select 1' >/dev/null 2>&1 && break`,
    `  sleep 1`,
    `done`,
    `sudo -u postgres psql -p 5432 -qAtc 'select 1' >/dev/null 2>&1 \\`,
    `  || { echo "ERROR: PostgreSQL cluster did not come up on 127.0.0.1:5432" >&2; exit 1; }`,
    `echo "postgres: cluster ready on 127.0.0.1:5432"`,
    "",
    `# Superuser password: generate ONCE; persist into the env file only.`,
    `# If the env file already carries a DATABASE_URL, reuse that password`,
    `# (idempotent — safe to re-run after the box is already configured).`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then`,
    `  PG_SUPER_PW="$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*//postgres:([^@]*)@.*#\\1#')"`,
    `  echo "postgres: reusing existing superuser password from $ENV_FILE"`,
    `else`,
    `  PG_SUPER_PW="$(openssl rand -hex 24)"`,
    `  echo "postgres: generated new superuser password (value only in $ENV_FILE)"`,
    `fi`,
    `# Set/rotate the postgres role password to match (idempotent).`,
    `# The whole SQL — INCLUDING the quoted literal — is fed via STDIN so the`,
    `# cleartext password never lands in argv / the process table.`,
    `# Dollar-quoting neutralizes any quote chars in the random hex value.`,
    // Dollar-quoting: \$pgpw\$...\$pgpw\$ — fed via STDIN so cleartext never lands in argv.
    // \$pgpw\$ in the generated bash script: backslash-escaped so bash treats $ as literal.
    // Use string concatenation + explicit escapes to prevent TS template-literal expansion.
    "printf 'ALTER ROLE postgres PASSWORD %s;\\n'" +
      " \"\\$pgpw\\$${PG_SUPER_PW}\\$pgpw\\$\" \\",
    `  | sudo -u postgres psql -p 5432 -q >/dev/null`,
    `echo "postgres: superuser password set (value not logged)"`,
    "",
    `# createdb ${dbName} (idempotent: guarded by pg_database check)`,
    `if ! sudo -u postgres psql -p 5432 -qAtc \\`,
    `    "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1; then`,
    `  sudo -u postgres createdb -p 5432 ${sq(dbName)}`,
    `  echo "postgres: created database ${dbName}"`,
    `else`,
    `  echo "postgres: database ${dbName} already exists"`,
    `fi`,
    "",
  );

  // ---- section 11 (PR-A2-e): base env file seeding -------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §11. Base env file seeding (PR-A2-e): ${envFile}`,
    `#      600, ${appUser}-owned. DATABASE_URL = superuser (migrations/seed only).`,
    `#      ${rlsUrlVar} = ${appDbRole}:app_password placeholder`,
    `#        (deploy.sh rotates the password on the first deploy).`,
    `#      PG_BACKEND is intentionally NOT set here — it lives in the unit's`,
    `#      Environment= directive (stack-prep.sh invariant).`,
    `#      Idempotent: reuses existing secrets across re-runs.`,
    `# ---------------------------------------------------------------------------`,
    "",
    `# Seed password: generate once; reuse if already present.`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^SEED_OWNER_PASSWORD=' "$ENV_FILE"; then`,
    `  SEED_PW="$(grep '^SEED_OWNER_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"`,
    `else`,
    `  SEED_PW="$(openssl rand -hex 8)"`,
    `fi`,
    "",
    `# Cookie secret: generate once; reuse if already present.`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^COOKIE_SECRET=' "$ENV_FILE"; then`,
    `  COOKIE_SECRET="$(grep '^COOKIE_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"`,
    `else`,
    `  COOKIE_SECRET="$(openssl rand -hex 32)"`,
    `fi`,
    "",
    `# Preserve an already-rotated ${rlsUrlVar} across re-runs.`,
    `# The placeholder (${appDbRole}:app_password) is only valid before the first deploy.`,
    `APP_DB_LINE="${rlsUrlVar}=postgresql://${appDbRole}:app_password@127.0.0.1:5432/${dbName}"`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^${rlsUrlVar}=postgresql://${appDbRole}:' "$ENV_FILE" \\`,
    `   && ! grep -q '^${rlsUrlVar}=postgresql://${appDbRole}:app_password@' "$ENV_FILE"; then`,
    `  APP_DB_LINE="$(grep '^${rlsUrlVar}=' "$ENV_FILE" | head -1)"`,
    `  echo "$ENV_FILE: preserving already-rotated ${rlsUrlVar}"`,
    `fi`,
    "",
    `# Preserve deploy bookkeeping vars (DEPLOYED_SHA, DEPLOY_FAILED_SHA) if present.`,
    `PRESERVE=""`,
    `for _k in DEPLOYED_SHA DEPLOY_FAILED_SHA; do`,
    '  if [[ -f "$ENV_FILE" ]] && grep -q "^${_k}=" "$ENV_FILE"; then',
    '    PRESERVE+="$(grep "^${_k}=" "$ENV_FILE" | head -1)"$\'\\n\'',
    `  fi`,
    `done`,
    "",
    `umask 077`,
    `cat > "$ENV_FILE" <<ENVEOF`,
    `# ${app.name} env file — generated by samohost host-bootstrap. chmod 600, ${appUser}-owned.`,
    `# NEVER commit. DATABASE_URL is the superuser (migrations/seed only).`,
    `# ${rlsUrlVar} placeholder is rotated by deploy.sh on the first deploy.`,
    `# PG_BACKEND is intentionally NOT set here — it is set in ${unit}.service Environment=.`,
    `DATABASE_URL=postgresql://postgres:\${PG_SUPER_PW}@127.0.0.1:5432/${dbName}`,
    `\${APP_DB_LINE}`,
    `NODE_ENV=production`,
    `PORT=${appPort}`,
    `HOST=0.0.0.0`,
    `COOKIE_SECRET=\${COOKIE_SECRET}`,
    `SEED_OWNER_LOGIN=${seedOwnerLogin}`,
    `SEED_OWNER_PASSWORD=\${SEED_PW}`,
    `ENVEOF`,
    `[[ -n "\${PRESERVE}" ]] && printf '%s' "\${PRESERVE}" >> "$ENV_FILE"`,
    `chown ${sq(appUser)}:${sq(appUser)} "$ENV_FILE"`,
    `chmod 600 "$ENV_FILE"`,
    `echo "$ENV_FILE: written (600, ${appUser}). [secret values not logged]"`,
    "",
  );
  } // end if (!isStatic) for §10 + §11

  // ---- section 12 (PR-A2-f): full token-safe repo clone --------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §12. Full token-safe repo clone (PR-A2-f).`,
    `#      FULL clone (no --depth — deploys checkout SHAs).`,
    `#      Token is NEVER in argv or the remote URL. The credential helper reads`,
    `#      the token file BY ITS LITERAL PATH at runtime via 'cat ${tokenFile}'`,
    `#      (NOT the unexported $TOKEN_FILE var — empty in git's sudo -u subshell).`,
    `#      git-safe.conf sidesteps GIT_DIR dubious-ownership warnings.`,
    `#      Idempotent: leaves an existing checkout in place.`,
    `# ---------------------------------------------------------------------------`,
    "",
    `GIT_SAFE_CONF=${sq(gitSafeConf)}`,
    `APP_DIR=${sq(appDir)}`,
    `REPO_URL=${sq(repoUrl)}`,
    "",
    `# Write git-safe.conf so the app user can operate in the checkout`,
    `# without GIT_DIR dubious-ownership errors (directory owned by agent/root).`,
    `cat > "$GIT_SAFE_CONF" <<SAFEOF`,
    `[safe]`,
    `    directory = ${appDir}`,
    `SAFEOF`,
    `chown ${sq(appUser)}:${sq(appUser)} "$GIT_SAFE_CONF"`,
    `chmod 644 "$GIT_SAFE_CONF"`,
    "",
    `if [[ -d "$APP_DIR/.git" ]]; then`,
    `  echo "clone: $APP_DIR already a git checkout — leaving in place."`,
    `elif [[ -s "$TOKEN_FILE" ]]; then`,
    `  echo "clone: full clone of ${app.repo} -> $APP_DIR (token via runtime credential helper)"`,
    `  chown ${sq(appUser)}:${sq(appUser)} "$TOKEN_FILE"`,
    `  chmod 600 "$TOKEN_FILE"`,
    `  # The inline credential helper reads the token file BY PATH at runtime.`,
    `  # The token value NEVER appears in argv, the remote URL, or git config.`,
    // Fix (samorev #32): the credential helper value MUST be single-quoted so that
    // $(cat ...) is only evaluated LAZILY when git invokes the helper — not at
    // bash-invocation time (which would expand the token value into git's argv,
    // visible in /proc/<pid>/cmdline). The double-quoted form is the BUG.
    //
    // Fix (fresh-VM, FD-3-fix-exposed): the helper must `cat` the LITERAL
    // token-file path, NOT the bash variable $TOKEN_FILE. TOKEN_FILE is a plain,
    // UNEXPORTED §0 assignment; git runs the credential helper in a fresh subshell
    // under `sudo -u <appUser>` (env stripped), where $TOKEN_FILE is EMPTY → empty
    // password → "Invalid username or token" → private-repo clone fails on a fresh
    // VM. The literal path always resolves and matches the proven persist line just
    // below (and field-record-1 stack-prep.sh).
    `  sudo -u ${sq(appUser)} GIT_CONFIG_GLOBAL="$GIT_SAFE_CONF" git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat ${tokenFile})"; }; f' clone "$REPO_URL" "$APP_DIR"`,
    `  sudo -u ${sq(appUser)} GIT_CONFIG_GLOBAL="$GIT_SAFE_CONF" git -C "$APP_DIR" remote set-url origin "$REPO_URL"`,
    `  echo "clone: complete; origin set to public URL (token only via runtime helper)"`,
    `  # Persist the credential helper in the app user's global gitconfig so LATER`,
    `  # fetches (deploy, env-create clones) authenticate by reading the token file`,
    `  # by path at runtime (no FD 3 / stdin needed on later runs).`,
    `  sudo -u ${sq(appUser)} git config --global \\`,
    `    credential."https://github.com".helper \\`,
    `    '!f() { echo username=x-access-token; echo "password=$(cat ${tokenFile})"; }; f'`,
    `else`,
    `  echo "clone: SKIPPED (no token). Place a 600 token at $TOKEN_FILE and re-run."`,
    `fi`,
    "",
  );

  // ---- section 13: extended self-check PASS/FAIL table (A1 + A2 rows) ------
  // §13 self-check is kind-aware: static apps omit node/pg/unit/db rows.
  if (isStatic) {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §13. Self-check PASS/FAIL table (static app — no node/pg/unit/db rows).`,
      `# ---------------------------------------------------------------------------`,
      "",
      `echo ""`,
      `echo "=== samohost host-bootstrap self-check for ${app.name} (static) ==="`,
      `FAILED=0`,
      "",
      `# Helper: print PASS/FAIL and accumulate failures.`,
      `chk() {`,
      `  local label="$1" ok="$2"`,
      `  if [[ "$ok" == "1" ]]; then`,
      `    printf "  PASS  %s\\n" "$label"`,
      `  else`,
      `    printf "  FAIL  %s\\n" "$label" >&2`,
      `    FAILED=$(( FAILED + 1 ))`,
      `  fi`,
      `}`,
      "",
      `# caddy active (required for file_server)`,
      `caddy_ok=0`,
      `/usr/bin/systemctl is-active caddy >/dev/null 2>&1 && caddy_ok=1 || true`,
      `chk "caddy active" "$caddy_ok"`,
      "",
      `# sudo grant count for ${appUser} (static: expect >=3: daemon-reload + reload caddy + journalctl)`,
      `sudo_count=$(grep -c ${sq(`NOPASSWD`)} ${sq(sudoersFile)} 2>/dev/null || echo 0)`,
      `sudo_ok=0`,
      `if [[ "$sudo_count" -ge 3 ]]; then sudo_ok=1; fi`,
      `chk "sudoers grants count: $sudo_count (expect >=3)" "$sudo_ok"`,
      "",
      `# app clone present`,
      `clone_ok=0`,
      `if [[ -d "$APP_DIR/.git" ]]; then clone_ok=1; fi`,
      `chk "app clone at $APP_DIR/.git" "$clone_ok"`,
      "",
      `echo "==="`,
      `if [[ "$FAILED" -gt 0 ]]; then`,
      `  echo "FAIL: $FAILED check(s) failed. Resolve above before proceeding." >&2`,
      `  exit 1`,
      `fi`,
      `echo "All checks PASS — host bootstrap complete for ${app.name} (static)."`,
      "",
    );
  } else {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §13. Self-check PASS/FAIL table (OS-level + A2 items; exits 1 on FAIL).`,
      `# ---------------------------------------------------------------------------`,
      "",
      `echo ""`,
      `echo "=== samohost host-bootstrap self-check for ${app.name} ==="`,
      `FAILED=0`,
      "",
      `# Helper: print PASS/FAIL and accumulate failures.`,
      `chk() {`,
      `  local label="$1" ok="$2"`,
      `  if [[ "$ok" == "1" ]]; then`,
      `    printf "  PASS  %s\\n" "$label"`,
      `  else`,
      `    printf "  FAIL  %s\\n" "$label" >&2`,
      `    FAILED=$(( FAILED + 1 ))`,
      `  fi`,
      `}`,
      "",
      `# node version`,
      `node_ok=0`,
      `if command -v node >/dev/null 2>&1; then node_ok=1; fi`,
      `chk "node $(node --version 2>/dev/null || echo '(not found)')" "$node_ok"`,
      "",
      `# caddy active`,
      `caddy_ok=0`,
      `/usr/bin/systemctl is-active caddy >/dev/null 2>&1 && caddy_ok=1 || true`,
      `chk "caddy active" "$caddy_ok"`,
      "",
      `# sudo grant count for ${appUser} (expect >=7: daemon-reload + enable/start/stop/restart + psql + journalctl)`,
      `sudo_count=$(grep -c ${sq(`NOPASSWD`)} ${sq(sudoersFile)} 2>/dev/null || echo 0)`,
      `sudo_ok=0`,
      `if [[ "$sudo_count" -ge 7 ]]; then sudo_ok=1; fi`,
      `chk "sudoers grants count: $sudo_count (expect >=7)" "$sudo_ok"`,
      "",
      `# service unit enabled`,
      `unit_ok=0`,
      `/usr/bin/systemctl is-enabled ${sq(unit)} >/dev/null 2>&1 && unit_ok=1 || true`,
      `chk "unit ${unit} enabled" "$unit_ok"`,
      "",
      `# postgres ready (PR-A2)`,
      `pg_ok=0`,
      `sudo -u postgres psql -p 5432 -qAtc 'select 1' >/dev/null 2>&1 && pg_ok=1 || true`,
      `chk "postgres ready on 5432" "$pg_ok"`,
      "",
      `# database present (PR-A2)`,
      `db_ok=0`,
      `sudo -u postgres psql -p 5432 -qAtc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" \\`,
      `  2>/dev/null | grep -q 1 && db_ok=1 || true`,
      `chk "db ${dbName} present" "$db_ok"`,
      "",
      `# staging.env present and 600 (PR-A2)`,
      `env_ok=0`,
      `if [[ -f "$ENV_FILE" ]] && [[ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 0)" == "600" ]]; then`,
      `  env_ok=1`,
      `fi`,
      `chk "staging.env 600 at $ENV_FILE" "$env_ok"`,
      "",
      `# app clone present (PR-A2)`,
      `clone_ok=0`,
      `if [[ -d "$APP_DIR/.git" ]]; then clone_ok=1; fi`,
      `chk "app clone at $APP_DIR/.git" "$clone_ok"`,
      "",
      `echo "==="`,
      `if [[ "$FAILED" -gt 0 ]]; then`,
      `  echo "FAIL: $FAILED check(s) failed. Resolve above before proceeding." >&2`,
      `  exit 1`,
      `fi`,
      `echo "All checks PASS — host bootstrap complete for ${app.name} (db: ${dbName})."`,
      "",
    );
  }

  return lines.join("\n");
}
