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
 *     CRITICAL for non-static apps: dbName is REQUIRED and EXPLICIT — never
 *     derived from app.name. Static apps skip the DB and base-env sections.
 *
 *     Then the app's own login role (`<dbName>_app` by default): created
 *     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS with a
 *     password generated on the host; CONNECT on the app's database is
 *     revoked from PUBLIC and granted to that role.
 *
 *  e. Env files (600, appUser-owned; see src/app/db-layout.ts). Split layout:
 *     the runtime env file has APP_DATABASE_URL (the app role), NODE_ENV,
 *     PORT (from healthUrl), HOST, COOKIE_SECRET and TRUSTED_PROXIES; the
 *     migrate env file has DATABASE_URL (the owner role) and
 *     SEED_OWNER_LOGIN/PASSWORD. Legacy layout: one env file with the
 *     superuser DATABASE_URL and all of the above. Both are written through
 *     a temporary file in a root-owned directory and renamed into place.
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
import {
  staticReleaseStatePaths,
  staticRootOf,
  staticTreeGuardFnLines,
} from "./static-root.ts";
import {
  assertLinuxAppUser,
  assertOptionalLinuxAppUser,
  linuxAppUserError,
} from "./linux-user.ts";
import { staticMainVhostLines } from "./heal-script.ts";
import { migrateEnvFileOf, releaseEnvFileOf, splitLayoutPathError } from "./db-layout.ts";
import { isIP } from "node:net";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the host bootstrap script (PR-A1 OS prep + PR-A2 DB/env/clone).
 *
 * `appUser` is always required. `dbName` is required for non-static apps and
 * invalid for static apps. All other fields are optional with documented defaults.
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
   * Invalid for static apps (`app.kind === 'static'`): static sites have no
   * database, so static calls must omit this field.
   */
  dbName?: string;

  /**
   * Source-restricted firewall options for the generated bootstrap script.
   *
   * Static apps always receive a firewall section and default to direct
   * Cloudflare `:443` ingress. Passing `allowCfHttps: false` preserves an
   * explicitly control-plane-only topology. Node apps receive this section only
   * when options are supplied; `runAppBootstrap` does that for `cp-http80` and
   * emits only the single-source `:80` rule.
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
   * The app's own non-superuser login role (the user in APP_DATABASE_URL).
   * Default `<dbName>_app`. The bootstrap creates it with a password
   * generated on the server (openssl rand) and writes that password into the
   * env file. A re-run keeps the password already in the env file.
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
  assertLinuxAppUser(opts.appUser);
  assertOptionalLinuxAppUser(app.appUser);
  const staticRoot = staticRootOf(app);
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
  if (isStatic && opts.dbName !== undefined) {
    throw new Error(
      "buildHostBootstrapScript: dbName is not valid for static apps; static bootstrap creates no database",
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
  // dbName and the role names are embedded in SQL and in the root-run shell
  // script. Accept only lowercase PostgreSQL identifiers that need no quoting,
  // short enough that "<dbName>_owner" still fits in 63 bytes.
  if (dbName !== undefined && !/^[a-z_][a-z0-9_]{0,47}$/.test(dbName)) {
    throw new Error(
      `buildHostBootstrapScript: invalid dbName ${JSON.stringify(dbName)}: ` +
        "expected ^[a-z_][a-z0-9_]{0,47}$ (a lowercase PostgreSQL identifier)",
    );
  }
  const rlsUrlVar = app.rlsUrlVar ?? "APP_DATABASE_URL";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rlsUrlVar)) {
    throw new Error(`buildHostBootstrapScript: invalid rlsUrlVar ${JSON.stringify(rlsUrlVar)}`);
  }
  const appDbRole = opts.appDbRole ?? `${dbName ?? app.name}_app`;
  if (!isStatic && !/^[a-z_][a-z0-9_]{0,62}$/.test(appDbRole)) {
    throw new Error(
      `buildHostBootstrapScript: invalid appDbRole ${JSON.stringify(appDbRole)}: ` +
        "expected ^[a-z_][a-z0-9_]{0,62}$",
    );
  }
  if (
    !isStatic &&
    (!appDbRole.startsWith(`${dbName}_`) ||
      appDbRole === `${dbName}_owner` ||
      appDbRole === "postgres" ||
      appDbRole.startsWith("pg_"))
  ) {
    throw new Error(
      `buildHostBootstrapScript: invalid appDbRole ${JSON.stringify(appDbRole)}: ` +
        `it must start with "${dbName}_" and must not be "${dbName}_owner", "postgres" or a pg_ name`,
    );
  }
  // Session settings fed to psql before any statement that carries a
  // password, so the statement text never reaches the PostgreSQL log (same
  // lines as src/env/script.ts uses for preview roles).
  const noLogSqlArgs =
    `"SET log_statement TO 'none';" "SET log_min_duration_statement TO -1;" "SET log_min_error_statement TO 'panic';"`;
  // psql as postgres inside the app's database: the database owner role can
  // set the database's search_path, so pin it to pg_catalog.
  const psqlInAppDb = (db: string): string =>
    `sudo -u postgres env PGOPTIONS='-c search_path=pg_catalog' psql -p 5432 -d ${sq(db)}`;
  // Split layout (src/app/db-layout.ts): the migration role owns the app's
  // database; the migrate env file sits next to the runtime env file.
  const ownerDbRole = `${dbName ?? app.name}_owner`;
  const migrateEnvFile = isStatic ? "" : migrateEnvFileOf(envFile);
  const releaseEnvFile = isStatic ? "" : releaseEnvFileOf(envFile);
  // New env layout only: the service runs as a separate runtime user under a
  // hardened unit, and the deploy user's sudo rules name exact files. The
  // name must be a valid Linux user name, and the app name must be plain
  // enough to sit in a sudo rule and a sudo regular expression unescaped.
  const runtimeUser = `${app.name}-run`;
  const runtimeUserUsable =
    !isStatic && linuxAppUserError(runtimeUser) === undefined && /^[a-z0-9][a-z0-9_.-]*$/.test(app.name);
  const uploadsDir = `${appBase}/uploads`;
  const mainVhostFile = `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
  // Same name as the heal script's staging file (src/app/heal-script.ts).
  const healStagedVhostFile = `/etc/caddy/sites.d/.samohost-heal-next-00-main-${app.name}.caddy`;
  // No sudo rule for preview vhost files (/etc/caddy/sites.d/<app>-<label>.caddy):
  // that name pattern overlaps between apps whose names share a prefix, and
  // previews of new-layout apps are not designed yet (host-prep refuses them).
  const seedOwnerLogin = opts.seedOwnerLogin ?? "owner";
  // cp-http80: the control plane is the only proxy in front of this server's
  // Caddy (the firewall opens :80 to it alone). The app trusts its
  // X-Forwarded-For entries (TRUSTED_PROXIES), Caddy keeps them
  // (trusted_proxies in the main vhost).
  const trustedProxy = !isStatic && app.mainListen === "cp-http80"
    ? opts.firewallOpts?.controlPlaneIp
    : undefined;
  if (trustedProxy !== undefined) {
    const [address = "", prefix, extra] = trustedProxy.split("/");
    const max = isIP(address) === 4 ? 32 : 128;
    if (isIP(address) === 0 || extra !== undefined || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) >= 1 && Number(prefix) <= max))) {
      throw new Error(`buildHostBootstrapScript: invalid controlPlaneIp ${JSON.stringify(trustedProxy)}`);
    }
  }
  // The app's TCP peer is Caddy on loopback (Caddy dials localhost:<port>;
  // the app listens on 127.0.0.1 in the split layout and on 0.0.0.0 in the
  // legacy one, where Go tries 127.0.0.1), and Caddy's peer is the control plane.
  const trustedProxiesEnvLines = trustedProxy !== undefined ? [`TRUSTED_PROXIES=127.0.0.1,${trustedProxy}`] : [];
  const staticReleaseState = staticReleaseStatePaths(app.appDir);
  const staticReleaseTagFormat = app.releaseTagFormat ?? "";

  const lines: string[] = [];
  const staticBranchVhostLines: string[] = [];
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
    ...(isStatic && !isStaticReleaseChannel && app.mainHost !== undefined
      ? [...staticTreeGuardFnLines(), ""]
      : []),
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
    `# Root writes and chmods the token file in a folder the deploy user may own:`,
    `# refuse symbolic links at the folder and at the file.`,
    `if [[ -L ${sq(appBase)} ]]; then echo ${sq(`ERROR: ${appBase} is a symbolic link; refusing to write the token file through it`)} >&2; exit 1; fi`,
    `mkdir -p ${sq(appBase)}`,
    `if [[ -L "$TOKEN_FILE" ]]; then echo "ERROR: $TOKEN_FILE is a symbolic link; refusing to write or chmod it as root" >&2; exit 1; fi`,
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

  // ---- section 3b: env layout (node apps) -----------------------------------
  if (!isStatic) {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §3b. Env layout. Decides §4, §5, §5c, §6, §7, §9, §10, §11 and §12.`,
      `# ---------------------------------------------------------------------------`,
      "",
      `ENV_FILE=${sq(envFile)}`,
      `# Env layout: see src/app/db-layout.ts. An app bootstrapped before the`,
      `# split layout has the superuser DATABASE_URL in its runtime env file and`,
      `# no migrate env file: it keeps that legacy layout unchanged. Every other`,
      `# app gets the split layout: no superuser address in any env file, a`,
      `# migration role that owns only this database, and a migrate env file`,
      `# that only the deploy's migrate step loads.`,
      `MIGRATE_ENV_FILE=${sq(migrateEnvFile)}`,
      `# Root reads and writes these files in the app user's directory: refuse`,
      `# symbolic links, which could point root at any file.`,
      `for _f in "$ENV_FILE" "$MIGRATE_ENV_FILE"; do`,
      `  if [[ -L "$_f" ]]; then echo "ERROR: $_f is a symbolic link; refusing to read or write it as root" >&2; exit 1; fi`,
      `done`,
      `# Root-owned marker, written once an app has the split layout: deleting the`,
      `# migrate env file or planting a superuser address does not bring back the`,
      `# legacy path (which sets the superuser password from the env file).`,
      `SAMOHOST_LAYOUT_MARKER=${sq(`/var/lib/samohost/db-layout/${app.name}`)}`,
      `if [[ -f "$SAMOHOST_LAYOUT_MARKER" ]] && [[ "$(cat "$SAMOHOST_LAYOUT_MARKER")" == split ]]; then`,
      `  SAMOHOST_DB_LAYOUT=split`,
      `# Any DATABASE_URL line in an existing env file, whatever its scheme or`,
      `# user, keeps the legacy layout: a re-run never converts a legacy server.`,
      `elif [[ -f "$ENV_FILE" ]] && grep -q '^DATABASE_URL=' "$ENV_FILE" && [[ ! -e "$MIGRATE_ENV_FILE" ]]; then`,
      `  SAMOHOST_DB_LAYOUT=legacy`,
      `  echo "postgres: legacy env layout (DATABASE_URL in $ENV_FILE) kept unchanged"`,
      `else`,
      `  SAMOHOST_DB_LAYOUT=split`,
      `fi`,
      `# Legacy layout: §10 sets the postgres role's password from the env file's`,
      `# DATABASE_URL. Check it here, before any change to the server, so that a`,
      `# value samohost did not write stops the run with nothing changed.`,
      `if [[ "$SAMOHOST_DB_LAYOUT" == legacy && -f "$ENV_FILE" ]]; then`,
      `  PG_SUPER_PW="$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*//postgres:([^@]*)@.*#\\1#')"`,
      `  if [[ ! "$PG_SUPER_PW" =~ ^[0-9a-f]+$ ]]; then`,
      `    echo "ERROR: DATABASE_URL in $ENV_FILE is not a postgres superuser address with a hex password as samohost writes it; bootstrap changed nothing. Correct that line, then run bootstrap again." >&2`,
      `    exit 1`,
      `  fi`,
      `fi`,
      "",
    );
    // Host-prep (src/env/script.ts) gives the operator user wildcard sudo
    // rules for previews, which new-layout apps do not support yet. It refuses
    // such servers; this covers host-prep that ran before the first bootstrap.
    push(
      `if [[ "$SAMOHOST_DB_LAYOUT" == split && -e ${sq(`/etc/sudoers.d/samohost-env-${app.name}`)} ]]; then`,
      `  echo ${sq(`ERROR: /etc/sudoers.d/samohost-env-${app.name} (preview rules from host-prep) exists; the new layout does not support previews yet. Remove that file after checking that no preview of ${app.name} is in use, then run bootstrap again.`)} >&2`,
      `  exit 1`,
      `fi`,
      "",
    );
    // The new layout limits the deploy user to the rules in ${sudoersFile}.
    // Another sudoers.d file that names the user (rule, Defaults:<user>, alias
    // member, %<user>) would give it more; stop and name the file.
    push(
      `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
      `  for _f in /etc/sudoers.d/*; do`,
      `    if [[ ! -f "$_f" || "$_f" == ${sq(sudoersFile)} ]]; then continue; fi`,
      `    if grep -Eq ${sq(`^[^#]*(^|[[:space:],=():!%])${appUser}([[:space:],=():]|$)`)} "$_f"; then`,
      `      echo "ERROR: $_f names the deploy user ${appUser}; a new-layout app needs a deploy user that no other sudo rule names. Use another deploy user for this app, or remove ${appUser} from that file." >&2`,
      `      exit 1`,
      `    fi`,
      `  done`,
      `fi`,
      "",
    );
    // §5 makes appBase root-owned and the env files sit next to the env file:
    // other paths are refused in the split layout (the legacy layout continues).
    const pathError = splitLayoutPathError(appBase, envFile, appDir);
    if (pathError !== undefined) {
      push(
        `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
        `  echo ${sq(`ERROR: ${pathError}`)} >&2`,
        `  exit 1`,
        `fi`,
        "",
      );
    }
  }

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
    ...(runtimeUserUsable
      ? [
          `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
          `  # split layout: root does not write into the deploy user's home. Refuse`,
          `  # links, keep an existing file, and write a missing one as the user.`,
          `  for _p in ${sq(`/home/${appUser}/.ssh`)} ${sq(`/home/${appUser}/.ssh/authorized_keys`)}; do`,
          `    if [[ -L "$_p" ]]; then echo "ERROR: $_p is a symbolic link" >&2; exit 1; fi`,
          `  done`,
          `  if [[ -e ${sq(`/home/${appUser}/.ssh/authorized_keys`)} ]]; then`,
          `    echo "Kept the existing /home/${appUser}/.ssh/authorized_keys"`,
          `  else`,
          `    sudo -u ${sq(appUser)} install -d -m 700 ${sq(`/home/${appUser}/.ssh`)}`,
          `    sudo -u ${sq(appUser)} sh -c 'umask 077 && cat > "$1"' sh ${sq(`/home/${appUser}/.ssh/authorized_keys`)} < "\${OPERATOR_KEYS}"`,
          `    echo "Copied \${OPERATOR_KEYS} -> /home/${appUser}/.ssh/authorized_keys (as ${appUser})"`,
          `  fi`,
          `else`,
        ]
      : []),
    `  install -d -m 700 -o ${sq(appUser)} -g ${sq(appUser)} "/home/${appUser}/.ssh"`,
    `  install -m 600 -o ${sq(appUser)} -g ${sq(appUser)} "\${OPERATOR_KEYS}" \\`,
    `    "/home/${appUser}/.ssh/authorized_keys"`,
    `  echo "Copied \${OPERATOR_KEYS} -> /home/${appUser}/.ssh/authorized_keys"`,
    ...(runtimeUserUsable ? [`fi`] : []),
    `else`,
    `  echo "WARNING: no operator authorized_keys found; skipping key copy." >&2`,
    `fi`,
    "",
  );

  // ---- section 5: /opt/<app> layout -----------------------------------------
  // Split layout: appBase is root-owned, so the deploy user cannot create,
  // rename or replace entries next to the files root writes and systemd
  // reads (env files, migrate.env, release.env, git-safe.conf, the token
  // file). The deploy user owns only the checkout; uploads belongs to the
  // runtime user (§5c).
  const oldLayoutLines = [
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(appBase)}`,
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(`${appBase}/uploads`)}`,
    `install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(appDir)}`,
  ];
  push(
    `# ---------------------------------------------------------------------------`,
    `# §5. /opt/${app.name} directory layout (appBase, uploads, appDir).`,
    `# ---------------------------------------------------------------------------`,
    "",
    ...(runtimeUserUsable
      ? [
          `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
          `  # appBase root-owned; its parent is root-owned, so the name cannot be swapped.`,
          `  if [[ -L ${sq(appBase)} ]]; then echo "ERROR: ${appBase} is a symbolic link" >&2; exit 1; fi`,
          `  install -d -m 755 -o root -g root ${sq(appBase)}`,
          `  chown -h root:root ${sq(appBase)}`,
          `  chmod 755 ${sq(appBase)}`,
          `  # From here only root can change entries in ${appBase}. Refuse links that`,
          `  # an earlier deploy user may have left, before root follows any name.`,
          `  for _p in ${sq(`${appBase}/uploads`)} ${sq(appDir)} ${sq(tokenFile)} ${sq(gitSafeConf)}; do`,
          `    if [[ -L "$_p" ]]; then echo "ERROR: $_p is a symbolic link" >&2; exit 1; fi`,
          `  done`,
          `  if [[ -L ${sq(releaseEnvFile)} ]]; then rm -f ${sq(releaseEnvFile)}; fi`,
          `  # uploads is created in §5c for the runtime user, never for the deploy user.`,
          `  install -d -m 755 -o ${sq(appUser)} -g ${sq(appUser)} ${sq(appDir)}`,
          `else`,
          ...oldLayoutLines.map((l) => `  ${l}`),
          `fi`,
        ]
      : oldLayoutLines),
    `echo "Layout: ${appBase}/ (uploads/, app checkout at ${appDir})"`,
    "",
  );

  // ---- section 5c: runtime user (node apps) ---------------------------------
  if (!isStatic) {
    push(
      `# ---------------------------------------------------------------------------`,
      `# §5c. Runtime user ${sq(runtimeUser)} (split layout only). The service runs as`,
      `#      this user: no sudo rules, no login shell, not in the deploy user's`,
      `#      group. It reads the release (world-readable files in the checkout);`,
      `#      it writes only ${uploadsDir}. systemd reads the env files for it.`,
      `# ---------------------------------------------------------------------------`,
      "",
      `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
      ...(runtimeUserUsable
        ? [
            `  if id ${sq(runtimeUser)} >/dev/null 2>&1; then`,
            `    echo "User ${sq(runtimeUser)} already exists — skipping useradd."`,
            `  else`,
            `    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${sq(runtimeUser)}`,
            `  fi`,
            `  usermod --shell /usr/sbin/nologin ${sq(runtimeUser)}`,
            `  # chmod follows symbolic links: refuse one at the uploads folder.`,
            `  if [[ -L ${sq(uploadsDir)} ]]; then echo "ERROR: ${uploadsDir} is a symbolic link" >&2; exit 1; fi`,
            `  gpasswd -d ${sq(runtimeUser)} ${sq(appUser)} >/dev/null 2>&1 || true`,
            `  if [[ -d ${sq(uploadsDir)} ]]; then`,
            `    # An older bootstrap gave this folder to the deploy user. Change the owner`,
            `    # without following links, and skip files with more than one hard link:`,
            `    # such a file may be another file of the server.`,
            `    find ${sq(uploadsDir)} ! -type d -links +1 -exec printf 'WARNING: owner not changed (more than one hard link): %s\\n' {} + >&2`,
            `    find ${sq(uploadsDir)} \\( -type d -o -links 1 \\) -exec chown -h ${sq(`${runtimeUser}:${runtimeUser}`)} {} +`,
            `    chmod 750 ${sq(uploadsDir)}`,
            `  else`,
            `    install -d -m 750 -o ${sq(runtimeUser)} -g ${sq(runtimeUser)} ${sq(uploadsDir)}`,
            `  fi`,
            `  echo "Runtime user: ${runtimeUser} (writes only ${uploadsDir})"`,
          ]
        : [
            `  echo "ERROR: the runtime user name ${runtimeUser} is not a valid Linux user name (^[a-z_][a-z0-9_-]{0,31}$); use a shorter app name" >&2`,
            `  exit 1`,
          ]),
      `fi`,
      "",
    );
  }

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
      ...(runtimeUserUsable
        ? [
            `# split layout: exact file names for the main vhost, the heal staging file`,
            `# and release.env. No wildcard, preview, journalctl, daemon-reload or psql`,
            `# grant: the deploy and heal scripts do not use them (logs and doctor run`,
            `# as the operator user; previews of these apps are not designed yet).`,
            `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
            `cat > ${sq(sudoersFile)} <<'SAMOHOST_SPLIT_SUDOERS'`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable ${unit}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${unit}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${unit}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${unit}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee ${mainVhostFile}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee ${healStagedVhostFile}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/mv -- ${healStagedVhostFile} ${mainVhostFile}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/rm -f ${healStagedVhostFile}`,
            `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee ${releaseEnvFile}`,
            "SAMOHOST_SPLIT_SUDOERS",
            "else",
          ]
        : []),
      `cat > ${sq(sudoersFile)} <<SUDOERS`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${unit}`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy`,
      `${appUser} ALL=(postgres) NOPASSWD: /usr/bin/psql`,
      `${appUser} ALL=(root) NOPASSWD: /usr/bin/journalctl *`,
      "SUDOERS",
      ...(runtimeUserUsable ? ["fi"] : []),
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
    ...(runtimeUserUsable
      ? [
          `# split layout: the service runs as ${runtimeUser} with systemd hardening.`,
          `# systemd reads the EnvironmentFile= files before it drops to that user.`,
          `# MemoryDenyWriteExecute is not set: Node's JIT needs writable code pages.`,
          `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
          `cat > /etc/systemd/system/${unit}.service <<'SAMOHOST_SPLIT_UNIT'`,
          "[Unit]",
          `Description=${app.name} main service`,
          "After=network.target postgresql.service",
          "",
          "[Service]",
          `User=${runtimeUser}`,
          `Group=${runtimeUser}`,
          `WorkingDirectory=${appDir}`,
          `EnvironmentFile=${envFile}`,
          `EnvironmentFile=-${releaseEnvFile}`,
          `ExecStart=${execStart}`,
          "Restart=always",
          "NoNewPrivileges=yes",
          "ProtectSystem=strict",
          "ProtectHome=yes",
          "PrivateTmp=yes",
          "PrivateDevices=yes",
          "ProtectKernelTunables=yes",
          "ProtectKernelModules=yes",
          "ProtectControlGroups=yes",
          "ProtectProc=invisible",
          "RestrictSUIDSGID=yes",
          // AF_NETLINK: Node's os.networkInterfaces() throws without it.
          "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
          "CapabilityBoundingSet=",
          "LockPersonality=yes",
          "MemoryMax=50%",
          "TasksMax=256",
          `ReadWritePaths=${uploadsDir}`,
          `InaccessiblePaths=${[migrateEnvFile, tokenFile, gitSafeConf, `${appDir}/.git`, `${appDir}/.npmrc`].map((x) => `-${x}`).join(" ")}`,
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "SAMOHOST_SPLIT_UNIT",
          "else",
        ]
      : []),
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
    `EnvironmentFile=-${releaseEnvFile}`,
    `ExecStart=${execStart}`,
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    ...(runtimeUserUsable ? ["fi"] : []),
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
  // Caddy's admin API on a unix socket in the caddy user's home, for servers
  // where a new-layout bootstrap ran. Caddy creates the socket with mode 0200
  // by default, and connecting needs write permission on it, so only the
  // caddy user and root can use it. The default is TCP localhost:2019, which
  // every local process, the app included, can use to load a new Caddy
  // config. `systemctl reload caddy` runs `caddy reload` as caddy, which
  // sends the config to the admin address the config names.
  const caddyAdminSocket = "/var/lib/caddy/admin.sock";
  const caddyAdminRe = `^[[:space:]]*admin[[:space:]]+unix/${caddyAdminSocket.replaceAll(".", "[.]")}([[:space:]]|$)`;
  const caddyfileHeaderSocket = tlsMode === "local"
    ? ["# Caddy global options (local TLS — no ACME).", "{", "  local_certs", `  admin unix/${caddyAdminSocket}`, "}"]
    : ["# Caddy global options (ACME TLS — default).", "{", `  admin unix/${caddyAdminSocket}`, "}"];
  // Write the canonical base file, with the admin socket line when chosen.
  const writeBaseCaddyfile = (indent: string): string[] => [
    `${indent}if [[ "$SAMOHOST_CADDY_ADMIN_SOCKET" == 1 ]]; then`,
    `${indent}cat > /etc/caddy/Caddyfile <<'CADDYFILE'`,
    ...caddyfileHeaderSocket,
    "",
    "import sites.d/*.caddy",
    "CADDYFILE",
    `${indent}else`,
    `${indent}cat > /etc/caddy/Caddyfile <<'CADDYFILE'`,
    ...caddyfileHeader,
    "",
    "import sites.d/*.caddy",
    "CADDYFILE",
    `${indent}fi`,
  ];

  push(
    `# ---------------------------------------------------------------------------`,
    `# §9. Caddy base Caddyfile (import sites.d/*.caddy; tls=${tlsMode}).`,
    `#     caddy validate runs before reload (catches syntax errors early).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `mkdir -p /etc/caddy/sites.d`,
    "",
    `# Admin API: a server where a new-layout bootstrap ran keeps it on`,
    `# ${caddyAdminSocket}, so no bootstrap of any app moves it back to TCP.`,
    `SAMOHOST_CADDY_ADMIN_SOCKET=0`,
    `if ${!isStatic ? `[[ "\${SAMOHOST_DB_LAYOUT:-}" == split ]] || ` : ""}grep -Eq '${caddyAdminRe}' /etc/caddy/Caddyfile 2>/dev/null || grep -qsx split /var/lib/samohost/db-layout/*; then`,
    `  SAMOHOST_CADDY_ADMIN_SOCKET=1`,
    `fi`,
    `SAMOHOST_CADDYFILE_PREV="$(mktemp)"`,
    `if [[ -f /etc/caddy/Caddyfile ]]; then cp /etc/caddy/Caddyfile "$SAMOHOST_CADDYFILE_PREV"; fi`,
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
      ...writeBaseCaddyfile("  "),
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
      ...writeBaseCaddyfile(""),
      "",
    );
  }
  push(
    `# The switch from TCP to the socket: the running Caddy does not listen on`,
    `# the new address yet, so reload fails and Caddy is restarted.`,
    `SAMOHOST_CADDY_ADMIN_SWITCH=0`,
    `if grep -Eq '${caddyAdminRe}' /etc/caddy/Caddyfile && ! grep -Eq '${caddyAdminRe}' "$SAMOHOST_CADDYFILE_PREV"; then`,
    `  SAMOHOST_CADDY_ADMIN_SWITCH=1`,
    `fi`,
    `caddy validate --config /etc/caddy/Caddyfile`,
    `/usr/bin/systemctl enable caddy`,
    `if [[ "$SAMOHOST_CADDY_ADMIN_SWITCH" == 1 ]]; then`,
    `  # A failed restart must reach the restore below, not stop the script.`,
    `  /usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy || true`,
    `  # One reload over the socket: deploy and heal reload Caddy this way.`,
    `  if ! /usr/bin/systemctl is-active --quiet caddy || ! /usr/bin/systemctl reload caddy; then`,
    `    echo "ERROR: caddy is not running or does not accept a reload over the admin socket ${caddyAdminSocket} after the admin socket change; restoring the previous Caddyfile. The admin socket needs Caddy 2.5.1 or later ('caddy version' shows the installed version)." >&2`,
    `    if [[ -s "$SAMOHOST_CADDYFILE_PREV" ]]; then cp "$SAMOHOST_CADDYFILE_PREV" /etc/caddy/Caddyfile; fi`,
    `    /usr/bin/systemctl restart caddy || true`,
    `    rm -f "$SAMOHOST_CADDYFILE_PREV"`,
    `    exit 1`,
    `  fi`,
    `else`,
    `  /usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy`,
    `fi`,
    `rm -f "$SAMOHOST_CADDYFILE_PREV"`,
    `echo "Caddy: Caddyfile ${isStaticReleaseChannel ? "ready" : "written"} (tls=${tlsMode}), validated, reloaded."`,
    "",
  );

  // ---- static branch-channel: production Caddy file_server vhost block ------
  // A fresh branch-channel host may bootstrap from appDir. After the first
  // health-proven detached deploy, however, the deploy-owned structured state
  // and route are authoritative. Bootstrap validates and preserves that exact
  // main vhost byte-for-byte; it never switches production back to appDir.
  if (isStatic && !isStaticReleaseChannel && app.mainHost !== undefined) {
    const caddySitePath = `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
    const siteAddress = app.mainListen === "cp-http80"
      ? `http://${app.mainHost}`
      : app.mainHost;
    staticBranchVhostLines.push(
      `# ---------------------------------------------------------------------------`,
      `# §9b. Production Caddy file_server vhost for ${sq(app.mainHost)}.`,
      `#      Fresh host: canonical ${sq(staticRoot ?? "repository root")} under appDir.`,
      `#      Post-deploy: validate and preserve the exact health-proven detached route.`,
      `#      Missing/corrupt deploy state fails closed; never switch back to appDir.`,
      `# ---------------------------------------------------------------------------`,
      "",
      `SAMOHOST_STATIC_ROOT=${sq(staticRoot ?? "")}`,
      `SAMOHOST_RELEASE_TAG_FORMAT=${sq(staticReleaseTagFormat)}`,
      `SAMOHOST_RELEASES_DIR=${sq(staticReleaseState.releasesDir)}`,
      `SAMOHOST_ACTIVE_STATE=${sq(staticReleaseState.activeState)}`,
      `SAMOHOST_ACTIVE_ROUTE=${sq(staticReleaseState.activeRoute)}`,
      `SAMOHOST_MAIN_VHOST=${sq(caddySitePath)}`,
      'SAMOHOST_BOOTSTRAP_VALUES=""',
      'SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE=""',
      'SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=""',
      'samohost_cleanup_bootstrap_static_route() {',
      '  [[ -z "$SAMOHOST_BOOTSTRAP_VALUES" ]] || rm -f "$SAMOHOST_BOOTSTRAP_VALUES"',
      '  [[ -z "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" ]] || rm -f "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE"',
      '  [[ -z "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" ]] || rm -f "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN"',
      '}',
      'trap samohost_cleanup_bootstrap_static_route EXIT',
      '',
      'if [[ -e "$SAMOHOST_ACTIVE_STATE" || -e "$SAMOHOST_ACTIVE_ROUTE" ]]; then',
      '  [[ -f "$SAMOHOST_ACTIVE_STATE" && ! -L "$SAMOHOST_ACTIVE_STATE" && -r "$SAMOHOST_ACTIVE_STATE" && -f "$SAMOHOST_ACTIVE_ROUTE" && ! -L "$SAMOHOST_ACTIVE_ROUTE" && -r "$SAMOHOST_ACTIVE_ROUTE" ]] || { echo "active static deployment state/route is incomplete or unsafe; refusing bootstrap route change" >&2; exit 1; }',
      '  SAMOHOST_BOOTSTRAP_VALUES=$(mktemp)',
      `  if ! python3 - "$SAMOHOST_ACTIVE_STATE" ${sq(app.name)} "$SAMOHOST_STATIC_ROOT" "$SAMOHOST_RELEASE_TAG_FORMAT" > "$SAMOHOST_BOOTSTRAP_VALUES" <<'PY'`,
      'import datetime',
      'import json',
      'import re',
      'import sys',
      '',
      'path, expected_app, expected_root, expected_format_raw = sys.argv[1:]',
      'expected_format = expected_format_raw or None',
      "with open(path, encoding='utf-8') as source:",
      '    state = json.load(source)',
      "if state.get('schema') != 1 or state.get('appName') != expected_app or state.get('staticRoot') != expected_root or state.get('releaseTagFormat') != expected_format:",
      "    raise SystemExit('active static deployment state does not match this app')",
      "sha = state.get('sha')",
      "tag = state.get('tag')",
      "release_dir = state.get('releaseDir')",
      "if not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{7,40}', sha) is None:",
      "    raise SystemExit('active static deployment state has an invalid sha')",
      "if not isinstance(tag, str) or not tag or len(tag) > 255 or any(ord(ch) < 32 for ch in tag):",
      "    raise SystemExit('active static deployment state has an invalid tag')",
      "if expected_format == 'date':",
      "    match = re.fullmatch(r'v([0-9]{8})[.]([1-9][0-9]*)', tag)",
      "    if match is None:",
      "        raise SystemExit('active static deployment state has an invalid dated tag')",
      "    datetime.datetime.strptime(match.group(1), '%Y%m%d')",
      "if not isinstance(release_dir, str) or not release_dir.startswith('/') or any(ord(ch) < 32 for ch in release_dir):",
      "    raise SystemExit('active static deployment state has an invalid releaseDir')",
      'for value in (release_dir, sha, tag):',
      "    sys.stdout.buffer.write(value.encode('utf-8') + b'\\0')",
      'PY',
      '  then',
      '    exit 1',
      '  fi',
      '  SAMOHOST_BOOTSTRAP_ACTIVE_VALUES=()',
      '  mapfile -d "" -t SAMOHOST_BOOTSTRAP_ACTIVE_VALUES < "$SAMOHOST_BOOTSTRAP_VALUES"',
      '  [[ "${#SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[@]}" == "3" ]] || { echo "active static deployment state is incomplete" >&2; exit 1; }',
      '  SAMOHOST_ACTIVE_RELEASE_RAW="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[0]}"',
      '  SAMOHOST_ACTIVE_SHA="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[1]}"',
      '  SAMOHOST_ACTIVE_TAG="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[2]}"',
      '  SAMOHOST_RELEASES_REAL=$(realpath -e "$SAMOHOST_RELEASES_DIR") || { echo "static releases directory is missing" >&2; exit 1; }',
      '  [[ ! -L "$SAMOHOST_ACTIVE_RELEASE_RAW" ]] || { echo "active static deployment path is a symlink" >&2; exit 1; }',
      '  SAMOHOST_CHECKOUT_REAL=$(realpath -e "$SAMOHOST_ACTIVE_RELEASE_RAW") || { echo "active static deployment directory is missing" >&2; exit 1; }',
      '  [[ "$SAMOHOST_ACTIVE_RELEASE_RAW" == "$SAMOHOST_CHECKOUT_REAL" ]] || { echo "active static deployment path is not canonical" >&2; exit 1; }',
      '  case "$SAMOHOST_CHECKOUT_REAL" in "$SAMOHOST_RELEASES_REAL"/*) ;; *) echo "active static deployment escapes releases directory" >&2; exit 1 ;; esac',
      '  [[ "$(git -C "$SAMOHOST_CHECKOUT_REAL" -c safe.directory="$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD)" == "$SAMOHOST_ACTIVE_SHA" ]] || { echo "active static deployment checkout does not match recorded sha" >&2; exit 1; }',
      '  if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL"; fi',
      '  SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "active staticRoot does not exist" >&2; exit 1; }',
      '  case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "active staticRoot escapes deployment checkout" >&2; exit 1 ;; esac',
      '  [[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "active staticRoot must contain index.html" >&2; exit 1; }',
      '  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"',
      '  python3 - "$SAMOHOST_STATIC_DIR/version.json" "$SAMOHOST_ACTIVE_SHA" "$SAMOHOST_ACTIVE_TAG" <<\'PY\'',
      'import json',
      'import sys',
      "with open(sys.argv[1], encoding='utf-8') as source:",
      '    identity = json.load(source)',
      "expected = {'version': sys.argv[3], 'tag': sys.argv[3], 'sha': sys.argv[2], 'environment': 'production'}",
      'if identity != expected:',
      "    raise SystemExit('active static deployment identity does not match state')",
      'PY',
      '  SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE=$(mktemp)',
      '  printf \'root * "%s"\\ntry_files {path} {path}/ =404\\nfile_server\\nencode gzip\\n\' "$SAMOHOST_STATIC_DIR" > "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE"',
      '  cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" "$SAMOHOST_ACTIVE_ROUTE" || { echo "active static route does not match structured deployment state" >&2; exit 1; }',
      '  SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=$(mktemp)',
      '  cat > "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" <<CADDY_SITE',
      // staticMainVhostLines() is the shared three-way contract (deploy == heal == bootstrap).
      // Provenance header is line 1; cmp check at the next line requires byte-identity.
      ...staticMainVhostLines(
        siteAddress,
        "${SAMOHOST_CHECKOUT_REAL}",
        "${SAMOHOST_STATIC_DIR}",
        app.mainListen !== "cp-http80",
        app.name,
      ),
      'CADDY_SITE',
      '  [[ -f "$SAMOHOST_MAIN_VHOST" && ! -L "$SAMOHOST_MAIN_VHOST" ]] || { echo "active static main vhost is missing or unsafe; refusing bootstrap route change" >&2; exit 1; }',
      '  cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST" || { echo "active static main vhost diverges from structured deployment state; refusing bootstrap route change" >&2; exit 1; }',
      '  SAMOHOST_BOOTSTRAP_FINGERPRINT=$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" "$SAMOHOST_MAIN_VHOST" | sha256sum | awk \'{print $1}\')',
      '  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"',
      '  [[ "$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" "$SAMOHOST_MAIN_VHOST" | sha256sum | awk \'{print $1}\')" == "$SAMOHOST_BOOTSTRAP_FINGERPRINT" ]] || { echo "active static deployment changed during bootstrap; retry" >&2; exit 1; }',
      '  echo "Caddy: health-proven static deployment route validated and preserved byte-for-byte."',
      'else',
      '  if grep -Fqs -- "import \\"$SAMOHOST_ACTIVE_ROUTE\\"" /etc/caddy/sites.d/10-domain-*.caddy 2>/dev/null; then',
      '    echo "managed custom domain references missing active static deployment state; refusing bootstrap route change" >&2',
      '    exit 1',
      '  fi',
      '  SAMOHOST_CHECKOUT_REAL=$(realpath -e "$APP_DIR") || { echo "static checkout is missing" >&2; exit 1; }',
      '  if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$APP_DIR/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$APP_DIR"; fi',
      '  SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "staticRoot does not exist: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
      '  case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "staticRoot escapes the checkout: $SAMOHOST_STATIC_ROOT" >&2; exit 1 ;; esac',
      '  [[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "staticRoot must contain index.html: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
      '  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"',
      '  SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=$(mktemp)',
      '  cat > "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" <<CADDY_SITE',
      `${siteAddress} {`,
      `\troot * "\${SAMOHOST_STATIC_DIR}"`,
      `\ttry_files {path} {path}/ =404`,
      `\tfile_server`,
      `\tencode gzip`,
      ...(app.mainListen === "cp-http80" ? [] : [`\ttls internal`]),
      `}`,
      'CADDY_SITE',
      '  chmod 0644 "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN"',
      '  if [[ -e "$SAMOHOST_MAIN_VHOST" ]]; then',
      '    [[ -f "$SAMOHOST_MAIN_VHOST" && ! -L "$SAMOHOST_MAIN_VHOST" ]] && cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST" || { echo "main static vhost exists without authorized active state and is not the canonical fresh route; refusing bootstrap route change" >&2; exit 1; }',
      '  else',
      '    /usr/bin/mv -f "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST"',
      '    SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=""',
      '  fi',
      '  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"',
      '  echo "Caddy: canonical fresh static route ready; no health-proven detached deployment exists yet."',
      'fi',
      `caddy validate --config /etc/caddy/Caddyfile`,
      `/usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy`,
      'samohost_cleanup_bootstrap_static_route',
      'trap - EXIT',
      "",
    );
  }

  // ---- source-restricted firewall rules ------------------------------------
  // Static apps default to direct CF ingress on :443. Any cp-http80 app (static
  // or node) may additionally open :80 only to the recorded control-plane IP.
  // Explicit allowCfHttps=false is preserved for control-plane-only static apps.
  // This mirrors buildFirewallLines from env/script.ts — reused here so the
  // same CF-range-fetch logic is not duplicated.
  if (isStatic || opts.firewallOpts !== undefined) {
    const fwLines = buildFirewallLines(isStatic, appUser, {
      ...opts.firewallOpts,
      allowCfHttps: opts.firewallOpts?.allowCfHttps ?? isStatic,
    });
    push(
      `# ---------------------------------------------------------------------------`,
      `# §9c. Firewall (source-restricted; world-open ufw allow NEVER emitted).`,
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
    `# ENV_FILE, MIGRATE_ENV_FILE and SAMOHOST_DB_LAYOUT are set in §3b.`,
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
    `if [[ "$SAMOHOST_DB_LAYOUT" == legacy ]]; then`,
    `# Superuser password: PG_SUPER_PW was read from the env file's DATABASE_URL`,
    `# and checked in §3b, before any change to the server.`,
    `echo "postgres: reusing existing superuser password from $ENV_FILE"`,
    `# Set/rotate the postgres role password to match (idempotent).`,
    `# The whole SQL — INCLUDING the quoted literal — is fed via STDIN so the`,
    `# cleartext password never lands in argv / the process table.`,
    `# Dollar-quoting neutralizes any quote chars in the random hex value.`,
    // Dollar-quoting: \$pgpw\$...\$pgpw\$ — fed via STDIN so cleartext never lands in argv.
    // \$pgpw\$ in the generated bash script: backslash-escaped so bash treats $ as literal.
    // Use string concatenation + explicit escapes to prevent TS template-literal expansion.
    `printf '%s\\n' ${noLogSqlArgs} \\`,
    "  \"ALTER ROLE postgres PASSWORD \\$pgpw\\$${PG_SUPER_PW}\\$pgpw\\$;\" \\",
    `  | sudo -u postgres psql -p 5432 -q >/dev/null`,
    `echo "postgres: superuser password set (value not logged)"`,
    `fi`,
    "",
    `# Migration role ${ownerDbRole} (split layout): owns the app's database and`,
    `# nothing else. Not a superuser, so a migration cannot reach other`,
    `# databases' objects or run programs on the server (COPY ... TO PROGRAM).`,
    `# Its password is kept in the migrate env file and reused on re-runs.`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
    `  OWNER_DB_ROLE=${sq(ownerDbRole)}`,
    `  OWNER_DB_PW=""`,
    `  if [[ -f "$MIGRATE_ENV_FILE" ]] && grep -q "^DATABASE_URL=postgresql://\${OWNER_DB_ROLE}:" "$MIGRATE_ENV_FILE"; then`,
    `    OWNER_DB_PW="$(grep '^DATABASE_URL=' "$MIGRATE_ENV_FILE" | head -1 | sed -E 's#^[^=]*=postgresql://[^:]*:([^@]*)@.*#\\1#')"`,
    `  fi`,
    `  if [[ "$OWNER_DB_PW" =~ ^[0-9a-f]+$ ]]; then`,
    `    echo "postgres: reusing the existing password of role $OWNER_DB_ROLE from $MIGRATE_ENV_FILE"`,
    `  else`,
    `    OWNER_DB_PW="$(openssl rand -hex 24)"`,
    `    echo "postgres: generated a new password for role $OWNER_DB_ROLE (value only in $MIGRATE_ENV_FILE)"`,
    `  fi`,
    `  printf '%s\\n' ${noLogSqlArgs} \\`,
    "    \"DO \\$samohost\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_DB_ROLE}') THEN EXECUTE format('CREATE ROLE %I', '${OWNER_DB_ROLE}'); END IF; END \\$samohost\\$;\" \\",
    "    \"ALTER ROLE ${OWNER_DB_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \\$pgpw\\$${OWNER_DB_PW}\\$pgpw\\$;\" \\",
    `    | sudo -u postgres psql -p 5432 -q -v ON_ERROR_STOP=1 >/dev/null`,
    `  echo "postgres: role $OWNER_DB_ROLE ready (login, no superuser) [password not logged]"`,
    `fi`,
    "",
    `# createdb ${dbName} (idempotent: guarded by pg_database check)`,
    `if ! sudo -u postgres psql -p 5432 -qAtc \\`,
    `    "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1; then`,
    `  if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
    `    sudo -u postgres createdb -p 5432 -O "$OWNER_DB_ROLE" ${sq(dbName)}`,
    `  else`,
    `  sudo -u postgres createdb -p 5432 ${sq(dbName)}`,
    `  fi`,
    `  echo "postgres: created database ${dbName}"`,
    `else`,
    `  echo "postgres: database ${dbName} already exists"`,
    `fi`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
    `  printf '%s\\n' \\`,
    `    "SELECT format('ALTER DATABASE %I OWNER TO %I', '${dbName}', '\${OWNER_DB_ROLE}') \\\\gexec" \\`,
    `    "SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', '${dbName}') \\\\gexec" \\`,
    `    "SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', '${dbName}', '\${OWNER_DB_ROLE}') \\\\gexec" \\`,
    `    | sudo -u postgres psql -p 5432 -q -v ON_ERROR_STOP=1 >/dev/null`,
    `  # Tables created earlier by another role (for example by the superuser in`,
    `  # the legacy layout) stay owned by that role; migrations as $OWNER_DB_ROLE`,
    `  # cannot alter them until an operator changes their owner.`,
    `  SAMOHOST_FOREIGN_OWNED="$(${psqlInAppDb(dbName)} -qAtc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE n.nspname OPERATOR(pg_catalog.=) 'public' AND c.relowner OPERATOR(pg_catalog.<>) (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) '\${OWNER_DB_ROLE}')" 2>/dev/null || echo 0)"`,
    `  if [[ "\${SAMOHOST_FOREIGN_OWNED:-0}" =~ ^[1-9] ]]; then`,
    `    echo "WARNING: \${SAMOHOST_FOREIGN_OWNED} object(s) in schema public of ${dbName} are not owned by $OWNER_DB_ROLE; migrations cannot alter them" >&2`,
    `  fi`,
    `fi`,
    "",
    `# App role ${appDbRole}: the non-superuser login role the running app uses`,
    `# (${rlsUrlVar}). Its password is generated here once and kept in the env`,
    `# file; a re-run reuses that password, so a working password is never`,
    `# rotated. A ${rlsUrlVar} that names a different role was set up by hand`,
    `# or by an older tool: that line and that role are left unchanged.`,
    `# The SQL, including the password, reaches psql on stdin only.`,
    `APP_DB_ROLE=${sq(appDbRole)}`,
    `APP_DB_LINE=""`,
    `APP_DB_PW=""`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^${rlsUrlVar}=' "$ENV_FILE" \\`,
    `   && ! grep -q '^${rlsUrlVar}=postgresql://[^:@/]*:app_password@' "$ENV_FILE"; then`,
    `  APP_DB_LINE="$(grep '^${rlsUrlVar}=' "$ENV_FILE" | head -1)"`,
    `fi`,
    `if [[ -n "$APP_DB_LINE" ]]; then`,
    `  APP_DB_PW="$(printf '%s' "$APP_DB_LINE" | sed -E 's#^[^=]*=postgresql://[^:]*:([^@]*)@.*#\\1#')"`,
    `fi`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == legacy ]]; then`,
    `  # In the legacy layout the app role would get no table rights: no role is`,
    `  # created and the ${rlsUrlVar} line (also the placeholder) is kept as it is.`,
    ...(rlsUrlVar === "DATABASE_URL"
      ? [`  APP_DB_LINE=""`]
      : [`  APP_DB_LINE="$(grep '^${rlsUrlVar}=' "$ENV_FILE" | head -1 || true)"`]),
    `  echo "postgres: legacy layout: ${rlsUrlVar} in $ENV_FILE kept as it is; no app role created"`,
    `elif [[ -n "$APP_DB_LINE" && ( "$APP_DB_LINE" != "${rlsUrlVar}=postgresql://\${APP_DB_ROLE}:"* || ! "$APP_DB_PW" =~ ^[0-9a-f]+$ ) ]]; then`,
    `  echo "postgres: ${rlsUrlVar} in $ENV_FILE was not written by samohost; leaving it and its role unchanged"`,
    `else`,
    `  if [[ -n "$APP_DB_LINE" ]]; then`,
    `    echo "postgres: reusing the existing password of role $APP_DB_ROLE from $ENV_FILE"`,
    `  else`,
    `    APP_DB_PW="$(openssl rand -hex 24)"`,
    `    echo "postgres: generated a new password for role $APP_DB_ROLE (value only in $ENV_FILE)"`,
    `  fi`,
    `  printf '%s\\n' ${noLogSqlArgs} \\`,
    "    \"DO \\$samohost\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_DB_ROLE}') THEN EXECUTE format('CREATE ROLE %I', '${APP_DB_ROLE}'); END IF; END \\$samohost\\$;\" \\",
    "    \"ALTER ROLE ${APP_DB_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \\$pgpw\\$${APP_DB_PW}\\$pgpw\\$;\" \\",
    `    "SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', '${dbName}') \\\\gexec" \\`,
    `    "SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', '${dbName}', '\${APP_DB_ROLE}') \\\\gexec" \\`,
    `    | sudo -u postgres psql -p 5432 -q -v ON_ERROR_STOP=1 >/dev/null`,
    `  APP_DB_LINE="${rlsUrlVar}=postgresql://\${APP_DB_ROLE}:\${APP_DB_PW}@127.0.0.1:5432/${dbName}"`,
    `  echo "postgres: role $APP_DB_ROLE ready (login, no superuser, CONNECT on ${dbName} only) [password not logged]"`,
    `fi`,
    `unset APP_DB_PW`,
    "",
    `# Rights of the role in ${rlsUrlVar} (the samohost app role or a role set up`,
    `# by hand): CONNECT on ${dbName} in both layouts, so the REVOKE from PUBLIC`,
    `# above does not lock out a preserved role. Split layout only: the migration`,
    `# role owns schema public (PostgreSQL 15+ gives CREATE on it only to its`,
    `# owner), and the app role gets data rights on the tables and sequences`,
    `# that the migration role creates now (default privileges) and that exist.`,
    `APP_DB_GRANTEE="$(printf '%s' "$APP_DB_LINE" | sed -E 's#^[^=]*=postgresql://([^:@/?]*).*#\\1#')"`,
    `if [[ ! "$APP_DB_GRANTEE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then`,
    `  if [[ -n "$APP_DB_LINE" ]]; then echo "WARNING: the role in ${rlsUrlVar} is not a plain lowercase name; it gets no grants" >&2; fi`,
    `  APP_DB_GRANTEE=""`,
    `fi`,
    `if [[ -n "$APP_DB_GRANTEE" ]]; then`,
    `  printf '%s\\n' \\`,
    `    "SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', '${dbName}', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    | sudo -u postgres psql -p 5432 -q -v ON_ERROR_STOP=1 >/dev/null`,
    `fi`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
    `  printf '%s\\n' \\`,
    `    "SELECT format('ALTER SCHEMA public OWNER TO %I', '\${OWNER_DB_ROLE}') \\\\gexec" \\`,
    `    "SELECT format('GRANT USAGE ON SCHEMA public TO %I', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', '\${OWNER_DB_ROLE}', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', '\${OWNER_DB_ROLE}', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    "SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    "SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' \\\\gexec" \\`,
    `    "SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations FROM %I', rolname) FROM pg_catalog.pg_roles WHERE rolname = '\${APP_DB_GRANTEE}' AND pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL \\\\gexec" \\`,
    `    | ${psqlInAppDb(dbName)} -q -v ON_ERROR_STOP=1 >/dev/null`,
    `  echo "postgres: schema public of ${dbName} owned by $OWNER_DB_ROLE; data rights for \${APP_DB_GRANTEE:-no app role}"`,
    `fi`,
    "",
  );

  // ---- section 11 (PR-A2-e): base env file seeding -------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §11. Base env file seeding (PR-A2-e): ${envFile}`,
    `#      600, ${appUser}-owned. Split layout: ${rlsUrlVar} (role ${appDbRole}) in the`,
    `#      runtime env file; DATABASE_URL (role ${ownerDbRole}) and SEED_OWNER_* in`,
    `#      ${migrateEnvFile}. Legacy layout: one file with the superuser DATABASE_URL.`,
    `#      Written in a root-owned temporary directory, then renamed into place.`,
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
    `if [[ "$SAMOHOST_DB_LAYOUT" == split ]] && [[ -f "$MIGRATE_ENV_FILE" ]] && grep -q '^SEED_OWNER_PASSWORD=' "$MIGRATE_ENV_FILE"; then`,
    `  SEED_PW="$(grep '^SEED_OWNER_PASSWORD=' "$MIGRATE_ENV_FILE" | head -1 | cut -d= -f2-)"`,
    `fi`,
    "",
    `# Cookie secret: generate once; reuse if already present.`,
    `if [[ -f "$ENV_FILE" ]] && grep -q '^COOKIE_SECRET=' "$ENV_FILE"; then`,
    `  COOKIE_SECRET="$(grep '^COOKIE_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"`,
    `else`,
    `  COOKIE_SECRET="$(openssl rand -hex 32)"`,
    `fi`,
    "",
    `# ${rlsUrlVar}: APP_DB_LINE was set in §10 (the app role and its password).`,
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
    `# Root-owned temporary directory next to the app directory (same file`,
    `# system), so the rename below replaces the target name without following it.`,
    `SAMOHOST_WRITE_DIR="$(mktemp -d ${sq(`${dirname(dirname(envFile))}/.samohost-bootstrap.XXXXXX`)})"`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == legacy ]]; then`,
    `cat > "$SAMOHOST_WRITE_DIR/env" <<ENVEOF`,
    `# ${app.name} env file — generated by samohost host-bootstrap. chmod 600, ${appUser}-owned.`,
    `# NEVER commit. DATABASE_URL is the superuser (migrations/seed only).`,
    `# ${rlsUrlVar} is the app's own non-superuser role.`,
    `# PG_BACKEND is intentionally NOT set here — it is set in ${unit}.service Environment=.`,
    `DATABASE_URL=postgresql://postgres:\${PG_SUPER_PW}@127.0.0.1:5432/${dbName}`,
    `\${APP_DB_LINE}`,
    `NODE_ENV=production`,
    `PORT=${appPort}`,
    `HOST=0.0.0.0`,
    `COOKIE_SECRET=\${COOKIE_SECRET}`,
    ...trustedProxiesEnvLines,
    `SEED_OWNER_LOGIN=${seedOwnerLogin}`,
    `SEED_OWNER_PASSWORD=\${SEED_PW}`,
    `ENVEOF`,
    `else`,
    `cat > "$SAMOHOST_WRITE_DIR/env" <<ENVEOF`,
    `# ${app.name} runtime env file — generated by samohost host-bootstrap. chmod 600, ${appUser}-owned.`,
    `# Loaded by ${unit}.service. NEVER commit. No superuser or migration address:`,
    `# ${rlsUrlVar} is the app's own non-superuser role. HOST is loopback: Caddy on`,
    `# this server is the app's only client.`,
    `\${APP_DB_LINE}`,
    `NODE_ENV=production`,
    `PORT=${appPort}`,
    `HOST=127.0.0.1`,
    `COOKIE_SECRET=\${COOKIE_SECRET}`,
    ...trustedProxiesEnvLines,
    `ENVEOF`,
    `cat > "$SAMOHOST_WRITE_DIR/migrate" <<MIGRATEEOF`,
    `# ${app.name} migrate env file — generated by samohost host-bootstrap. chmod 600, ${appUser}-owned.`,
    `# Loaded only by the deploy's migrate step. NEVER commit.`,
    `# DATABASE_URL is the migration role (owner of ${dbName} only, not a superuser).`,
    `DATABASE_URL=postgresql://\${OWNER_DB_ROLE}:\${OWNER_DB_PW}@127.0.0.1:5432/${dbName}`,
    `SEED_OWNER_LOGIN=${seedOwnerLogin}`,
    `SEED_OWNER_PASSWORD=\${SEED_PW}`,
    `MIGRATEEOF`,
    `chown ${sq(appUser)}:${sq(appUser)} "$SAMOHOST_WRITE_DIR/migrate"`,
    `chmod 600 "$SAMOHOST_WRITE_DIR/migrate"`,
    `unset OWNER_DB_PW`,
    `fi`,
    `[[ -n "\${PRESERVE}" ]] && printf '%s' "\${PRESERVE}" >> "$SAMOHOST_WRITE_DIR/env"`,
    `chown ${sq(appUser)}:${sq(appUser)} "$SAMOHOST_WRITE_DIR/env"`,
    `chmod 600 "$SAMOHOST_WRITE_DIR/env"`,
    `for _f in "$ENV_FILE" "$MIGRATE_ENV_FILE"; do`,
    `  if [[ -L "$_f" ]]; then echo "ERROR: $_f is a symbolic link; refusing to replace it" >&2; rm -rf "$SAMOHOST_WRITE_DIR"; exit 1; fi`,
    `done`,
    `mv -fT "$SAMOHOST_WRITE_DIR/env" "$ENV_FILE"`,
    `echo "$ENV_FILE: written (600, ${appUser}). [secret values not logged]"`,
    `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then`,
    `  mv -fT "$SAMOHOST_WRITE_DIR/migrate" "$MIGRATE_ENV_FILE"`,
    `  echo "$MIGRATE_ENV_FILE: written (600, ${appUser}). [secret values not logged]"`,
    `  mkdir -p /var/lib/samohost/db-layout`,
    `  printf 'split\\n' > "$SAMOHOST_LAYOUT_MARKER"`,
    `fi`,
    `rmdir "$SAMOHOST_WRITE_DIR"`,
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
    ...(runtimeUserUsable
      ? [
          `# split layout: the service runs as ${runtimeUser}, which reads the checkout`,
          `# through the world-read bit. §11 left umask 077 for the env files.`,
          `if [[ "$SAMOHOST_DB_LAYOUT" == split ]]; then umask 022; fi`,
        ]
      : []),
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
    ...(runtimeUserUsable
      ? [
          `# split layout: open up files an earlier clone left owner-only. Runs as the`,
          `# deploy user, who owns them; skips .git and does not follow links.`,
          `if [[ "$SAMOHOST_DB_LAYOUT" == split && -d "$APP_DIR" && ! -L "$APP_DIR" ]]; then`,
          `  sudo -u ${sq(appUser)} find "$APP_DIR" -path "$APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} +`,
          `fi`,
        ]
      : []),
    "",
  );

  // A static branch-channel route is activated only after §12 has produced a
  // checkout and the runtime realpath containment guard above can inspect it.
  if (staticBranchVhostLines.length > 0) {
    push(...staticBranchVhostLines);
  }

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
