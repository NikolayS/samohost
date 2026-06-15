/**
 * Pure OS-level host bootstrap script builder (PR-A1).
 *
 * `buildHostBootstrapScript` turns an {@link AppRecord} + {@link HostBootstrapOptions}
 * into a single self-contained bash program printed for an operator with root to
 * review before applying. It is the generic, idempotent port of
 * field-record-1's `deploy/scratch/stack-prep.sh`, parameterized by the
 * AppRecord — NO field-record hardcoding.
 *
 * ---------------------------------------------------------------------------
 * SCOPE (PR-A1 — OS prep only):
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
 *  8. Self-check PASS/FAIL table for the OS-level items: node, pg, caddy,
 *     sudo grant count, service unit enabled. Exits non-zero on FAIL.
 *
 * ---------------------------------------------------------------------------
 * NOT IN SCOPE (PR-A2): DB bootstrap, base env file, repo clone.
 *
 * The builder is PURE: no I/O, no network, fully deterministic.
 * ---------------------------------------------------------------------------
 *
 * @see buildHostPrepScript in src/env/script.ts for the complementary
 *      host-prep (preview template unit, Caddy include wiring, env sudoers).
 */

import type { AppRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the host bootstrap script (PR-A1 OS prep).
 *
 * All fields are optional except `appUser` (the OS user created on the host
 * to run the app service). Defaults are applied by the caller before passing.
 */
export interface HostBootstrapOptions {
  /**
   * OS user created on the host to own the app and run the systemd service
   * (e.g. "agent"). Required — no sane default because leaking to a wrong
   * user is a privilege-escalation risk.
   */
  appUser: string;
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
  const appUser = opts.appUser;
  const nodeMajor = opts.nodeMajor ?? 22;
  const pgMajor = opts.pgMajor ?? 18;
  const execStart = opts.execStart ?? "/usr/bin/node dist/server.js";
  const tlsMode = opts.tlsMode ?? "acme";
  const appBase = opts.appBase ?? `/opt/${app.name}`;
  const appDir = app.appDir;
  const unit = app.serviceUnit;
  const envFile = app.envFile ?? `${appBase}/staging.env`;
  const sudoersFile = `/etc/sudoers.d/${app.name}-agent`;

  const lines: string[] = [];
  const push = (...l: string[]): void => {
    for (const x of l) lines.push(x);
  };

  // ---- header ---------------------------------------------------------------
  push(
    "#!/usr/bin/env bash",
    `# samohost host-bootstrap for app ${sq(app.name)} — OS prep (PR-A1).`,
    "# Generated; review before applying. NOT auto-executed by samohost.",
    "# PR-A1 scope: runtimes, OS user, /opt layout, sudoers, MAIN unit,",
    "#   sshd AllowUsers, Caddy base config, self-check table.",
    "# PR-A2 scope (NOT here): DB bootstrap, env file, repo clone.",
    "set -euo pipefail",
    "",
  );

  // ---- section 1: base packages + NodeSource --------------------------------
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

  // ---- section 2: PostgreSQL via PGDG with PG_FALLBACK ----------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §2. PostgreSQL ${pgMajor} via PGDG (idempotent; PG_FALLBACK if major unavailable).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `if command -v psql >/dev/null 2>&1; then`,
    `  echo "PostgreSQL already present — skipping PGDG install."`,
    "else",
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

  // ---- section 3: Caddy via official apt repo -------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §3. Caddy via official apt repo (idempotent).`,
    `# ---------------------------------------------------------------------------`,
    "",
    `if command -v caddy >/dev/null 2>&1; then`,
    `  echo "Caddy already present — skipping apt install."`,
    "else",
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \\`,
    `    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`,
    `  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \\`,
    `    | tee /etc/apt/sources.list.d/caddy-stable.list`,
    `  apt-get update -qq`,
    `  apt-get install -y caddy`,
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

  // ---- section 7: MAIN systemd service unit ---------------------------------
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
    `# Write a minimal-but-valid Caddyfile. Idempotent: overwrite with the`,
    `# deterministic content — no append-drift.`,
    `cat > /etc/caddy/Caddyfile <<'CADDYFILE'`,
    ...caddyfileHeader,
    "",
    "import sites.d/*.caddy",
    "CADDYFILE",
    "",
    `caddy validate --config /etc/caddy/Caddyfile`,
    `/usr/bin/systemctl enable caddy`,
    `/usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy`,
    `echo "Caddy: Caddyfile written (tls=${tlsMode}), validated, reloaded."`,
    "",
  );

  // ---- section 10: self-check PASS/FAIL table --------------------------------
  push(
    `# ---------------------------------------------------------------------------`,
    `# §10. Self-check PASS/FAIL table (OS-level items only; exits 1 on FAIL).`,
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
    `echo "==="`,
    `if [[ "$FAILED" -gt 0 ]]; then`,
    `  echo "FAIL: $FAILED check(s) failed. Resolve above before proceeding." >&2`,
    `  exit 1`,
    `fi`,
    `echo "All checks PASS — host OS bootstrap complete for ${app.name}."`,
    "",
  );

  return lines.join("\n");
}
