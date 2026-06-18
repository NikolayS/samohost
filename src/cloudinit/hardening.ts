/**
 * Mandatory hardening baseline for Ubuntu 24.04 (SPEC §5).
 *
 * This is a non-removable {@link Module} always prepended by the builder. It
 * encodes a hard-won "secure by default" posture: non-root sudo user, SSH
 * hardening (including the Ubuntu-24.04 socket-activation gotcha), UFW,
 * fail2ban, unattended-upgrades, sysctl hardening, and AppArmor.
 *
 * The placeholder `{{SSH_PUBKEY}}` is substituted by the builder with the
 * operator's *public* key text. This module is pure and never touches the
 * filesystem or network.
 */

import type {
  AuditCheck,
  CloudInitFragment,
  Module,
  ProvisionSpec,
} from "../types.ts";

/** Token the builder replaces with the real SSH public key text. */
export const SSH_PUBKEY_PLACEHOLDER = "{{SSH_PUBKEY}}";

/** Sentinel file written as the final runcmd to mark cloud-init completion. */
export const PROVISION_SENTINEL_PATH = "/var/lib/samohost/provision-complete";

/**
 * Deterministic, stable hash of the spec used as the content of the completion
 * sentinel. Not cryptographic — just a reproducible fingerprint so two
 * identical specs yield identical cloud-init bytes (SPEC §5 determinism).
 */
export function specHash(spec: ProvisionSpec): string {
  const canonical = JSON.stringify({
    provider: spec.provider,
    region: spec.region,
    type: spec.type,
    name: spec.name,
    sshKeyPath: spec.sshKeyPath,
    sshPort: spec.sshPort,
    adminUser: spec.adminUser,
    modules: [...spec.modules].sort(),
    trustedIps: [...spec.trustedIps].sort(),
    timeoutSec: spec.timeoutSec,
  });
  // FNV-1a 32-bit — small, dependency-free, deterministic.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * sshd hardening directives. Values + intent traced to air
 * `infrastructure/001_vm-creation-for-agents.md` via the conformance matrix in
 * NikolayS/samohost#64; each directive is enforced present by
 * test/air-conformance.test.ts (the AIR_DIRECTIVES registry). Changing one here
 * without updating the registry fails CI by design.
 */
const SSHD_CONFIG = (port: number, adminUser: string): string =>
  [
    "# Managed by samohost — hardening baseline (air-conformant; see #64)",
    `Port ${port}`,
    "PasswordAuthentication no",
    "PermitRootLogin no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    // air: cap brute-force attempts per connection (alongside fail2ban + ufw limit).
    "MaxAuthTries 3",
    // air: drop idle/dead sessions — interval 300s, disconnect after 2 missed.
    "ClientAliveInterval 300",
    "ClientAliveCountMax 2",
    // air: refuse empty-password logins (defense-in-depth atop PasswordAuthentication no).
    "PermitEmptyPasswords no",
    "MaxStartups 100:30:200",
    "X11Forwarding no",
    // air: no agent forwarding (limit credential blast radius from the box).
    "AllowAgentForwarding no",
    // air: do not honour ~/.ssh/environment / environment= in authorized_keys.
    "PermitUserEnvironment no",
    `AllowUsers ${adminUser}`,
    "",
  ].join("\n");

/**
 * Ubuntu 24.04 ships socket-activated sshd: `Port` in sshd_config is silently
 * ignored because systemd's ssh.socket owns the listening socket. We MUST
 * override the socket's ListenStream as well. The empty `ListenStream=` resets
 * the inherited (port 22) value before setting our own.
 */
const SSH_SOCKET_OVERRIDE = (port: number): string =>
  [
    "# Managed by samohost — Ubuntu 24.04 socket activation override",
    "[Socket]",
    "ListenStream=",
    `ListenStream=0.0.0.0:${port}`,
    "",
  ].join("\n");

const FAIL2BAN_JAIL = (port: number, ignoreips: string[]): string => {
  const ignore = ["127.0.0.1/8", "::1", ...ignoreips].join(" ");
  return [
    "# Managed by samohost — fail2ban jail",
    "[DEFAULT]",
    "backend = systemd",
    "banaction = nftables-multiport",
    "banaction_allports = nftables-allports",
    `ignoreip = ${ignore}`,
    "bantime = 1h",
    "findtime = 10m",
    "maxretry = 5",
    "",
    "[sshd]",
    "enabled = true",
    `port = ${port}`,
    "filter = sshd",
    "",
  ].join("\n");
};

const SYSCTL_HARDENING = [
  "# Managed by samohost — sysctl network hardening",
  "net.ipv4.conf.all.rp_filter = 1",
  "net.ipv4.conf.default.rp_filter = 1",
  "net.ipv4.conf.all.accept_redirects = 0",
  "net.ipv4.conf.default.accept_redirects = 0",
  "net.ipv6.conf.all.accept_redirects = 0",
  "net.ipv6.conf.default.accept_redirects = 0",
  "net.ipv4.conf.all.send_redirects = 0",
  "net.ipv4.conf.default.send_redirects = 0",
  "net.ipv4.conf.all.accept_source_route = 0",
  "net.ipv6.conf.all.accept_source_route = 0",
  "net.ipv4.tcp_syncookies = 1",
  "net.ipv4.icmp_echo_ignore_broadcasts = 1",
  "",
].join("\n");

const UNATTENDED_UPGRADES = [
  "# Managed by samohost — enable automatic security updates",
  'APT::Periodic::Update-Package-Lists "1";',
  'APT::Periodic::Unattended-Upgrade "1";',
  "",
].join("\n");

function buildFragment(spec: ProvisionSpec): CloudInitFragment {
  const { sshPort, adminUser, trustedIps } = spec;

  const writeFiles: NonNullable<CloudInitFragment["writeFiles"]> = [
    {
      path: "/etc/ssh/sshd_config.d/10-samohost.conf",
      content: SSHD_CONFIG(sshPort, adminUser),
      permissions: "0644",
    },
    {
      path: "/etc/systemd/system/ssh.socket.d/port.conf",
      content: SSH_SOCKET_OVERRIDE(sshPort),
      permissions: "0644",
    },
    {
      path: "/etc/fail2ban/jail.local",
      content: FAIL2BAN_JAIL(sshPort, trustedIps),
      permissions: "0644",
    },
    {
      path: "/etc/sysctl.d/99-samohost.conf",
      content: SYSCTL_HARDENING,
      permissions: "0644",
    },
    {
      path: "/etc/apt/apt.conf.d/20auto-upgrades",
      content: UNATTENDED_UPGRADES,
      permissions: "0644",
    },
  ];

  const runcmd: string[] = [
    // SSH: apply both sshd_config and the socket override.
    "systemctl daemon-reload",
    "systemctl restart ssh.socket",
    "systemctl restart ssh",
    // UFW: default deny incoming; rate-LIMIT the hardened SSH port (air: brute-
    // force damping in addition to fail2ban — `limit` blocks an IP with >6
    // connections in 30s). `allow` would leave SSH unthrottled at the firewall.
    "ufw --force reset",
    "ufw default deny incoming",
    "ufw default allow outgoing",
    `ufw limit ${sshPort}/tcp`,
    "ufw --force enable",
    // fail2ban.
    "systemctl enable --now fail2ban",
    // sysctl.
    "sysctl --system",
    // unattended-upgrades.
    "systemctl enable --now unattended-upgrades",
    // AppArmor enforced.
    "systemctl enable --now apparmor",
    "aa-enforce /etc/apparmor.d/* || true",
    // air: remove/empty root's authorized_keys so no key can log in as root even
    // if PermitRootLogin is ever relaxed. Truncate (not delete) both legacy and
    // .d locations so the empty file is durable state, and lock the dir 0700.
    "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
    "truncate -s 0 /root/.ssh/authorized_keys 2>/dev/null || : > /root/.ssh/authorized_keys",
    "rm -f /root/.ssh/authorized_keys2",
    "chmod 600 /root/.ssh/authorized_keys",
    // Completion sentinel MUST be the final runcmd.
    `mkdir -p ${dirname(PROVISION_SENTINEL_PATH)}`,
    `echo ${specHash(spec)} > ${PROVISION_SENTINEL_PATH}`,
  ];

  return {
    packages: [
      "apparmor",
      "apparmor-utils",
      "fail2ban",
      "nftables",
      "ufw",
      "unattended-upgrades",
    ],
    writeFiles,
    runcmd,
  };
}

/** Minimal POSIX dirname (avoids a node:path import for purity/portability). */
function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

const auditChecks: AuditCheck[] = [
  {
    id: "ssh-port",
    description: "sshd is listening on the hardened port",
    probeCommand: "sshd -T 2>/dev/null | grep '^port '",
    // Concrete port is validated against the spec at audit time; presence here.
    expect: /^port \d+$/m,
    requiresSudo: true,
  },
  {
    id: "ufw-active",
    description: "ufw is active and default-deny incoming",
    probeCommand: "ufw status verbose",
    expect: /Status: active/,
    requiresSudo: true,
  },
  {
    id: "fail2ban-active",
    description: "fail2ban service is running",
    probeCommand: "systemctl is-active fail2ban",
    expect: "active",
  },
  {
    id: "sysctl-rpfilter",
    description: "reverse path filtering enabled",
    probeCommand: "sysctl -n net.ipv4.conf.all.rp_filter",
    expect: "1",
  },
  {
    id: "sysctl-syncookies",
    description: "TCP syncookies enabled",
    probeCommand: "sysctl -n net.ipv4.tcp_syncookies",
    expect: "1",
  },
  {
    id: "sysctl-redirects",
    description: "ICMP redirects disabled",
    probeCommand: "sysctl -n net.ipv4.conf.all.accept_redirects",
    expect: "0",
  },
  {
    id: "apparmor-enforced",
    description: "AppArmor is enabled with profiles in enforce mode",
    probeCommand: "aa-status",
    expect: /profiles are in enforce mode/,
    requiresSudo: true,
  },
];

/** The mandatory hardening module (SPEC §5). Always module index 0. */
export const hardeningModule: Module = {
  name: "hardening",
  validate(spec: ProvisionSpec): string[] {
    const errors: string[] = [];
    if (spec.sshPort < 1 || spec.sshPort > 65535) {
      errors.push(`sshPort out of range: ${spec.sshPort}`);
    }
    if (spec.sshPort === 22) {
      errors.push("sshPort must not be 22 (hardening requires a custom port)");
    }
    if (!/^[a-z_][a-z0-9_-]*$/.test(spec.adminUser)) {
      errors.push(`invalid adminUser: ${spec.adminUser}`);
    }
    if (spec.adminUser === "root") {
      errors.push("adminUser must be a non-root user");
    }
    return errors;
  },
  cloudInitFragment: buildFragment,
  auditChecks,
};
