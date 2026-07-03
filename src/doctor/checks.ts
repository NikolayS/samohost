/**
 * DoctorCheck: extends AuditCheck with doctor-specific metadata.
 *
 * The 7 existing hardeningModule.auditChecks are re-tagged as group "core-host"
 * and imported unchanged. Additional probes cover liveness, suspicious-activity
 * detection, and app-database checks.
 *
 * ALL probes are included in ONE buildAuditScript call → ONE SSH connection.
 * App-scoped checks with no app available are rendered as "skip" during
 * output formatting, NOT excluded from the script (avoids a second connection).
 */

import type { AuditCheck } from "../types.ts";
import { hardeningModule } from "../cloudinit/hardening.ts";

export type DoctorGroup = "core-host" | "core-liveness" | "core-suspicious" | "app-db";
export type DoctorKind = "match" | "liveness" | "suspicious";

export interface DoctorCheck extends AuditCheck {
  group: DoctorGroup;
  /** Whether this check requires an app to be meaningful. */
  appScoped?: boolean;
  /**
   * - "match": standard expect-string/regex check (same as AuditCheck).
   * - "liveness": output parsed by parseLivenessOutput() in doctor.ts.
   * - "suspicious": output parsed by parseSuspiciousOutput() — never causes exit 1.
   */
  kind?: DoctorKind;
}

// ---------------------------------------------------------------------------
// Core-host: the 7 existing hardening checks, re-tagged.
// ---------------------------------------------------------------------------

export const coreHostChecks: DoctorCheck[] = hardeningModule.auditChecks.map(
  (ch) => ({ ...ch, group: "core-host" as const }),
);

// ---------------------------------------------------------------------------
// NEW core-host checks (sshd effective config, port exposure, env-file perms,
// git-remote-no-token, unattended-upgrades).
// Note: sshd -T checks are requiresSudo → will yield "unknown" on hosts where
// the login user lacks that nopasswd grant (correct — not fail).
// ---------------------------------------------------------------------------

export const newCoreHostChecks: DoctorCheck[] = [
  {
    id: "permitrootlogin",
    description: "PermitRootLogin effective value is no",
    probeCommand: "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^permitrootlogin '",
    expect: /permitrootlogin no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "passwordauth",
    description: "PasswordAuthentication effective value is no",
    probeCommand: "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^passwordauthentication '",
    expect: /passwordauthentication no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "allowusers",
    description: "AllowUsers is set (non-empty/non-wildcard)",
    probeCommand: "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^allowusers '",
    expect: /allowusers \S+/i,
    requiresSudo: true,
    group: "core-host",
  },
  // --- air-conformance sshd directives (#64): every directive the cloud-init
  // baseline sets gets a matching effective-config probe. sshd -T lowercases
  // all keys, so the expect regexes match the lowercased form. ---
  {
    id: "maxauthtries",
    description: "MaxAuthTries effective value is 3 (air)",
    probeCommand: "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^maxauthtries '",
    expect: /maxauthtries 3/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "clientalive",
    description: "ClientAliveInterval 300 + ClientAliveCountMax 2 (air)",
    probeCommand:
      "sudo /usr/sbin/sshd -T 2>/dev/null | grep -iE '^clientalive(interval|countmax) '",
    // Both lines must be present with the expected values.
    expect: /clientaliveinterval 300[\s\S]*clientalivecountmax 2|clientalivecountmax 2[\s\S]*clientaliveinterval 300/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "x11forwarding",
    description: "X11Forwarding effective value is no (air)",
    probeCommand: "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^x11forwarding '",
    expect: /x11forwarding no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "allowagentforwarding",
    description: "AllowAgentForwarding effective value is no (air)",
    probeCommand:
      "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^allowagentforwarding '",
    expect: /allowagentforwarding no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "permituserenvironment",
    description: "PermitUserEnvironment effective value is no (air)",
    probeCommand:
      "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^permituserenvironment '",
    expect: /permituserenvironment no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "permitemptypasswords",
    description: "PermitEmptyPasswords effective value is no (air)",
    probeCommand:
      "sudo /usr/sbin/sshd -T 2>/dev/null | grep -i '^permitemptypasswords '",
    expect: /permitemptypasswords no/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "root-authorized-keys-empty",
    description: "root's authorized_keys is empty/absent (air)",
    // Print byte size; empty file => 0, absent => stat errors (folded to stderr).
    // requiresSudo: /root is 0700. Non-root user => permission error => unknown.
    probeCommand:
      "sudo stat -c '%s' /root/.ssh/authorized_keys 2>/dev/null || echo 0",
    expect: /^0$/m,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "ufw-limit-ssh",
    description: "UFW rate-limits (LIMIT) the SSH port, not plain ALLOW (air)",
    // ufw status shows "LIMIT" for limited ports. Requires root.
    probeCommand: "sudo /usr/sbin/ufw status 2>/dev/null | grep -i 'limit'",
    expect: /limit/i,
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "web-ports-not-world-open",
    description: "ports 80/443 are not world-open in UFW (Anywhere / 0.0.0.0/0 / ::/0 triggers failure)",
    // Extracts only port 80 and 443 lines from ufw status; evaluated by
    // parseWebPortsNotWorldOpenOutput in doctor.ts — NOT the generic expect path.
    probeCommand: "sudo /usr/sbin/ufw status 2>/dev/null | grep -E '^(80|443)(/|[[:space:]])' || true",
    expect: /^$/, // structural placeholder; dispatch in evaluateDoctorCheck overrides
    requiresSudo: true,
    group: "core-host",
  },
  {
    id: "unattended-upgrades-active",
    description: "unattended-upgrades service is active",
    // is-active needs no sudo
    probeCommand: "systemctl is-active unattended-upgrades",
    expect: /active/,
    group: "core-host",
  },
];

// app-scoped core-host checks — these require an app to be registered.
// The probeCommand templates use placeholders that are substituted in buildDoctorChecks().
export const appScopedCoreHostCheckTemplates: DoctorCheck[] = [
  {
    id: "env-file-perms",
    description: "env file has restrictive permissions (600/640)",
    // TEMPLATE: __ENV_FILE__ is substituted
    probeCommand: "stat -c '%a %U' __ENV_FILE__ 2>/dev/null",
    expect: /^(600|640) /m,
    group: "core-host",
    appScoped: true,
  },
  {
    id: "git-remote-no-token",
    description: "git remote URL contains no embedded token",
    // TEMPLATE: __APP_DIR__ is substituted
    probeCommand: "git -C __APP_DIR__ remote -v 2>/dev/null",
    // Must NOT match URL with embedded credentials (://user:pass@host pattern)
    // We invert: pass = no token found. Handled in evaluation.
    expect: /^(?!.*:\/\/[^/]*:[^/]*@).*/s,
    group: "core-host",
    appScoped: true,
  },
];

// ---------------------------------------------------------------------------
// Core-liveness: port/service liveness checks (kind="liveness").
// ALL use the ss-listeners probe output — no extra connection.
// The ss output is captured in the "ss-listeners" probe.
// ---------------------------------------------------------------------------

/**
 * The ss-listeners probe captures all TCP listener state in one shot.
 * All liveness + pg-localhost checks derive their answers from this one output.
 */
export const SS_LISTENERS_CHECK: DoctorCheck = {
  id: "ss-listeners",
  description: "TCP listener snapshot (ss -ltnH)",
  probeCommand: "ss -ltnH",
  // We never match this directly — it's parsed by liveness/pg-localhost parsers.
  // Set expect to a never-failing regex so evaluate() doesn't false-FAIL.
  expect: /.*/,
  group: "core-liveness",
  kind: "liveness",
};

/**
 * caddy-serving: verify Caddy is listening on expected web ports.
 *
 * Node apps require both :80 (HTTP→HTTPS redirect) and :443 (HTTPS).
 * Static/CF-fronted apps bind only :443; Caddy omits :80 intentionally.
 * parseLivenessOutput("caddy-serving", ..., serveKind) handles the distinction.
 *
 * Probe captures port listeners; evaluation uses ss-listeners output as a
 * fallback (same data, no extra SSH round-trip).
 */
const CADDY_SERVING_CHECK: DoctorCheck = {
  id: "caddy-serving",
  description: "Caddy is serving on expected ports (:443 always; :80 for node apps)",
  // Re-run ss -ltnH; evaluation falls back to ss-listeners section if this
  // section is empty. Single-connection invariant preserved — same command,
  // different named section.
  probeCommand: "ss -ltnH",
  expect: /.*/,
  group: "core-liveness",
  kind: "liveness",
};

export const corelivenessChecks: DoctorCheck[] = [
  SS_LISTENERS_CHECK,
  CADDY_SERVING_CHECK,
  {
    id: "fail2ban-jail",
    description: "fail2ban sshd jail is loaded and enforcing",
    probeCommand: "sudo /usr/bin/fail2ban-client status sshd",
    expect: /Status for the jail:/i,
    requiresSudo: true,
    group: "core-liveness",
    kind: "liveness",
  },
];

// App-scoped liveness: crash-loop detection (requires serviceUnit from app).
export const crashLoopCheckTemplate: DoctorCheck = {
  id: "service-crash-loop",
  description: "service is not crash-looping",
  // TEMPLATE: __SERVICE_UNIT__ is substituted
  probeCommand: "sudo /usr/bin/journalctl -u __SERVICE_UNIT__ -n 50 --no-pager -o cat 2>/dev/null",
  // We parse this with liveness logic, not a simple regex match.
  expect: /.*/,
  requiresSudo: true,
  group: "core-liveness",
  kind: "liveness",
  appScoped: true,
};

// ---------------------------------------------------------------------------
// Core-suspicious: journalctl-based anomaly detection (kind="suspicious").
// These NEVER set exit code 1 — they produce findings[], not failures.
// ---------------------------------------------------------------------------

export const coreSuspiciousChecks: DoctorCheck[] = [
  {
    id: "failed-auth-burst",
    description: "detect failed auth burst (>20 in last 200 journal lines)",
    // Capture raw journal text; the suspicious parser counts matches locally.
    // This avoids piping through grep-ic so the parser can redact before emitting findings.
    probeCommand:
      "sudo /usr/bin/journalctl _SYSTEMD_UNIT=ssh.service -n 200 --no-pager -o cat 2>/dev/null",
    expect: /.*/,
    requiresSudo: true,
    group: "core-suspicious",
    kind: "suspicious",
  },
  {
    id: "sudo-failures",
    description: "detect unexpected sudo authentication failures",
    probeCommand:
      "sudo /usr/bin/journalctl -n 200 --no-pager -o cat 2>/dev/null",
    expect: /.*/,
    requiresSudo: true,
    group: "core-suspicious",
    kind: "suspicious",
  },
  {
    id: "fail2ban-ban-spike",
    description: "detect fail2ban ban spike (Total banned > threshold)",
    probeCommand: "sudo /usr/bin/fail2ban-client status sshd 2>/dev/null",
    expect: /.*/,
    requiresSudo: true,
    group: "core-suspicious",
    kind: "suspicious",
  },
];

// ---------------------------------------------------------------------------
// App-db: database security checks (appScoped=true).
// ---------------------------------------------------------------------------

export const appDbCheckTemplates: DoctorCheck[] = [
  {
    id: "rls-nonsuperuser",
    description: "app DB connection is not a superuser (RLS active)",
    // TEMPLATE: __RLS_URL_VAR__ and __ENV_FILE__ are substituted.
    // Value is never printed — only f/t observed in rolsuper column.
    probeCommand:
      "set -a; . __ENV_FILE__ 2>/dev/null; set +a; psql \"$__RLS_URL_VAR__\" -tAc \"SELECT rolsuper FROM pg_roles WHERE rolname=current_user\" 2>&1",
    expect: /^f$/m,
    group: "app-db",
    appScoped: true,
  },
  {
    id: "pg-localhost",
    description: "Postgres listens on loopback only (not externally exposed)",
    // Uses the ss-listeners output — no extra probe.
    // TEMPLATE: same ss-listeners section used for liveness.
    // We set probeCommand to ss -ltnH again but only pg-localhost parser is applied.
    probeCommand: "ss -ltnH | grep ':5432'",
    expect: /.*/,
    group: "app-db",
    appScoped: true,
    kind: "liveness",
  },
  {
    id: "app-health",
    description: "app health endpoint returns HTTP 200",
    // TEMPLATE: __HEALTH_URL__ is substituted.
    probeCommand: "curl -s -o /dev/null -w '%{http_code}' __HEALTH_URL__ 2>/dev/null",
    expect: "200",
    group: "app-db",
    appScoped: true,
  },
];

// ---------------------------------------------------------------------------
// buildDoctorChecks: produce the full DoctorCheck[] with per-app substitutions.
// ---------------------------------------------------------------------------

export interface AppParams {
  appDir: string;
  envFile: string;
  serviceUnit: string;
  healthUrl: string;
  rlsUrlVar: string;
}

/**
 * Build the full DoctorCheck[] by substituting app-specific values into
 * template probeCommands. When appParams is undefined, app-scoped checks
 * are still included (for single-connection invariant), but will be scored
 * as "skip" during evaluation.
 */
export function buildDoctorChecks(
  sshPort: number,
  appParams: AppParams | undefined,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. Core-host: hardening checks (unchanged).
  checks.push(...coreHostChecks);

  // 2. New core-host checks.
  checks.push(...newCoreHostChecks);

  // only-intended-ports: parameterized by sshPort + expected public ports.
  // FAIL if any non-loopback listener is on a port outside {sshPort, 80, 443}.
  // Parsed locally from the ss-listeners probe output (not a separate connection).
  checks.push({
    id: "only-intended-ports",
    description: `no unexpected non-loopback listeners (allowed: ${sshPort}, 80, 443)`,
    // We re-use ss -ltnH output; this probe is a no-op (parsed from ss-listeners).
    // Loopback exclusion covers the full 127.0.0.0/8 range (not just 127.0.0.1):
    //   - 127.x.x.x[%iface]:  matches systemd-resolved on 127.0.0.53/127.0.0.54
    //     The [^:]* after the octet group absorbs the optional %lo interface suffix
    //     that ss appends (e.g. "127.0.0.53%lo:53").
    //   - [::1]:               IPv6 loopback
    //   - [::ffff:127.x.x.x]: IPv4-mapped loopback in IPv6
    //   - 172.(16-31).x.x:    RFC1918 docker bridge range (172.16.0.0/12)
    probeCommand: `ss -ltnH | grep -vE '127\\.[0-9]+\\.[0-9]+\\.[0-9]+[^:]*:|\\[::1\\]:|\\[::ffff:127\\.[0-9]+\\.[0-9]+\\.[0-9]+\\]:|172\\.(1[6-9]|2[0-9]|3[01])\\.[0-9]+\\.[0-9]+:' | awk '{print $4}' | grep -vE ':${sshPort}$|:80$|:443$' || true`,
    expect: /^$/, // empty output = no unexpected listeners = pass
    group: "core-host",
    kind: "match",
  });

  // 3. App-scoped core-host checks (template substitution).
  if (appParams) {
    for (const tmpl of appScopedCoreHostCheckTemplates) {
      checks.push({
        ...tmpl,
        probeCommand: tmpl.probeCommand
          .replace(/__ENV_FILE__/g, appParams.envFile)
          .replace(/__APP_DIR__/g, appParams.appDir),
      });
    }
  } else {
    // Include template checks with placeholder commands so they appear in the
    // script (satisfies single-connection invariant) but will be scored as skip.
    checks.push(...appScopedCoreHostCheckTemplates);
  }

  // 4. Core-liveness: ss-listeners + fail2ban-jail.
  checks.push(...corelivenessChecks);

  // 5. App-scoped liveness: crash-loop (template substitution).
  if (appParams) {
    checks.push({
      ...crashLoopCheckTemplate,
      probeCommand: crashLoopCheckTemplate.probeCommand.replace(
        /__SERVICE_UNIT__/g,
        appParams.serviceUnit,
      ),
    });
  } else {
    checks.push(crashLoopCheckTemplate);
  }

  // 6. Core-suspicious.
  checks.push(...coreSuspiciousChecks);

  // 7. App-db (template substitution).
  if (appParams) {
    for (const tmpl of appDbCheckTemplates) {
      checks.push({
        ...tmpl,
        probeCommand: tmpl.probeCommand
          .replace(/__ENV_FILE__/g, appParams.envFile)
          .replace(/__RLS_URL_VAR__/g, appParams.rlsUrlVar)
          .replace(/__HEALTH_URL__/g, appParams.healthUrl),
      });
    }
  } else {
    checks.push(...appDbCheckTemplates);
  }

  return checks;
}
