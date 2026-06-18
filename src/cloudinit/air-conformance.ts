/**
 * air conformance registry — the single, machine-checked source of truth that
 * turns the air ↔ samohost comparison from a stale prose doc into an enforced
 * CI gate (NikolayS/samohost#64).
 *
 * ## Why this file exists
 *
 * Issue #64 root-caused a repeated failure: the air comparison was produced as a
 * one-time document (first wrong, then right) and then went inert — none of its
 * P1 findings were ever enforced, so the cloud-init baseline silently drifted
 * away from air's intent. This registry encodes every air hardening directive as
 * data. A `bun test` golden (test/air-conformance.test.ts) asserts each entry is
 * actually present in the rendered cloud-init baseline (or carries an explicit
 * WAIVED/DIVERGES reason), and FAILS CI if a directive goes missing. The
 * `docs/air-conformance.md` table is generated/checked from this same registry,
 * so the doc can never silently disagree with the code.
 *
 * ## air source (cited)
 *
 * Directives and their intent are grounded in air
 * `infrastructure/001_vm-creation-for-agents.md` (postgres-ai/air, GitLab,
 * visibility per its own public spec). The directive set + values are taken from
 * the grounded re-comparison recorded in NikolayS/samohost#64 (the audit "air
 * conformance audit: gap matrix + root-cause + prevention"), whose matrix was
 * read from both air files in full via authenticated glab on 2026-06-12
 * (re-grounded doc commit 0605563). Per that audit's own rule, a failed air
 * fetch (HTTP 401/403/404 — air's API is auth-gated) must be treated as "fetch
 * blocked", NEVER as "air absent". See docs/air-conformance.md for the
 * re-grounding procedure.
 */

import type { ProvisionSpec } from "../types.ts";
import { buildCloudInit } from "./builder.ts";
import { hardeningModule } from "./hardening.ts";

/** Conformance status of a samohost baseline vs an air directive. */
export type ConformanceStatus = "CONFORMS" | "DIVERGES" | "WAIVED";

/**
 * One air hardening directive that samohost's cloud-init baseline must account
 * for. `CONFORMS` entries carry a `presence` predicate the conformance test runs
 * against the rendered cloud-init; `DIVERGES`/`WAIVED` entries carry a written
 * `reason` and are exempt from the presence assertion (but still enumerated in
 * the doc, so nothing is silently absent).
 */
export interface AirDirective {
  /** Stable id (kebab-case), also used to correlate with a doctor probe. */
  id: string;
  /** air capability description (human-readable, matches #64 matrix wording). */
  description: string;
  /** air source section (file + section) for the doc citation. */
  airSource: string;
  status: ConformanceStatus;
  /**
   * For CONFORMS: a substring (or array of substrings, all required) that MUST
   * appear in the rendered cloud-init for the default spec. The conformance test
   * fails if any required substring is missing. Absent for DIVERGES/WAIVED.
   */
  presence?: string | string[];
  /**
   * Required for DIVERGES and WAIVED: the written justification. air rows may
   * not be silently dropped — a non-CONFORMS row must explain itself.
   */
  reason?: string;
  /**
   * id of the `samohost doctor` probe that verifies this directive live, when
   * one exists. The conformance test asserts every CONFORMS sshd/ufw directive
   * has a matching doctor probe (closes the #64 "doctor checks a subset" gap).
   */
  doctorCheckId?: string;
}

/**
 * The air conformance registry. Ordered to match the #64 matrix. Every CONFORMS
 * directive here is asserted present in the rendered baseline by the conformance
 * test; every DIVERGES/WAIVED directive must carry a reason.
 */
export const AIR_DIRECTIVES: readonly AirDirective[] = [
  {
    id: "ssh-port",
    description: "sshd: custom (non-22) SSH port",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "Port 2223",
    doctorCheckId: "ssh-port",
  },
  {
    id: "permit-root-login",
    description: "sshd: PermitRootLogin no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "PermitRootLogin no",
    doctorCheckId: "permitrootlogin",
  },
  {
    id: "password-authentication",
    description: "sshd: PasswordAuthentication no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "PasswordAuthentication no",
    doctorCheckId: "passwordauth",
  },
  {
    id: "max-auth-tries",
    description: "sshd: MaxAuthTries 3 (cap brute-force attempts per connection)",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "MaxAuthTries 3",
    doctorCheckId: "maxauthtries",
  },
  {
    id: "client-alive",
    description:
      "sshd: ClientAliveInterval 300 + ClientAliveCountMax 2 (drop idle/dead sessions)",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: ["ClientAliveInterval 300", "ClientAliveCountMax 2"],
    doctorCheckId: "clientalive",
  },
  {
    id: "x11-forwarding",
    description: "sshd: X11Forwarding no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "X11Forwarding no",
    doctorCheckId: "x11forwarding",
  },
  {
    id: "allow-agent-forwarding",
    description: "sshd: AllowAgentForwarding no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "AllowAgentForwarding no",
    doctorCheckId: "allowagentforwarding",
  },
  {
    id: "permit-user-environment",
    description: "sshd: PermitUserEnvironment no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "PermitUserEnvironment no",
    doctorCheckId: "permituserenvironment",
  },
  {
    id: "permit-empty-passwords",
    description: "sshd: PermitEmptyPasswords no (defense-in-depth)",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "CONFORMS",
    presence: "PermitEmptyPasswords no",
    doctorCheckId: "permitemptypasswords",
  },
  {
    id: "allow-tcp-forwarding",
    description: "sshd: AllowTcpForwarding no",
    airSource: "001_vm-creation-for-agents.md §SSH hardening",
    status: "DIVERGES",
    reason:
      "samohost previews proxy app traffic through Caddy on the box (no remote " +
      "port-forward dependency), but operators occasionally tunnel to loopback " +
      "Postgres (:5432, which is intentionally loopback-only) for debugging. " +
      "Setting AllowTcpForwarding no would break that legitimate operator flow " +
      "while adding little: PermitRootLogin no + AllowUsers + key-only auth + " +
      "fail2ban already constrain who can forward. Re-evaluate if loopback-PG " +
      "tunneling is dropped. (air #64 matrix row 8, flagged 'eval'.)",
  },
  {
    id: "remove-root-authorized-keys",
    description: "Remove/empty root's authorized_keys at provision",
    airSource: "001_vm-creation-for-agents.md §SSH hardening / user setup",
    status: "CONFORMS",
    // The provision runcmd truncates root's key files; assert the runcmd is present.
    presence: "/root/.ssh/authorized_keys",
    doctorCheckId: "root-authorized-keys-empty",
  },
  {
    id: "ufw-default-deny",
    description: "UFW default-deny incoming",
    airSource: "001_vm-creation-for-agents.md §firewall",
    status: "CONFORMS",
    presence: "ufw default deny incoming",
    doctorCheckId: "ufw-active",
  },
  {
    id: "ufw-limit-ssh",
    description: "UFW rate-limit (limit) the SSH port, not plain allow",
    airSource: "001_vm-creation-for-agents.md §firewall",
    status: "CONFORMS",
    presence: "ufw limit 2223/tcp",
    doctorCheckId: "ufw-limit-ssh",
  },
  {
    id: "fail2ban",
    description: "fail2ban sshd jail (banaction, maxretry, bantime)",
    airSource: "001_vm-creation-for-agents.md §brute-force protection",
    status: "CONFORMS",
    presence: ["[sshd]", "maxretry = 5"],
    doctorCheckId: "fail2ban-active",
  },
  {
    id: "unattended-upgrades",
    description: "unattended-upgrades (automatic security updates)",
    airSource: "001_vm-creation-for-agents.md §updates",
    status: "CONFORMS",
    presence: 'APT::Periodic::Unattended-Upgrade "1";',
    doctorCheckId: "unattended-upgrades-active",
  },
  {
    id: "sysctl-hardening",
    description: "sysctl network hardening (rp_filter, syncookies, redirects)",
    airSource: "001_vm-creation-for-agents.md §sysctl",
    status: "CONFORMS",
    presence: ["net.ipv4.tcp_syncookies = 1", "net.ipv4.conf.all.rp_filter = 1"],
    doctorCheckId: "sysctl-syncookies",
  },
  {
    id: "apparmor",
    description: "AppArmor enabled with profiles in enforce mode",
    airSource: "001_vm-creation-for-agents.md §MAC",
    status: "CONFORMS",
    presence: "aa-enforce",
    doctorCheckId: "apparmor-enforced",
  },
  {
    id: "non-root-sudo-user",
    description: "Non-root sudo user (least-privilege admin)",
    airSource: "001_vm-creation-for-agents.md §user setup",
    status: "CONFORMS",
    presence: "groups: sudo",
  },
  {
    id: "fd-process-limits",
    description: "Raise file-descriptor / process limits (65535) fleet-wide",
    airSource: "001_vm-creation-for-agents.md §1.4 limits",
    status: "WAIVED",
    reason:
      "Not security hardening; air raises ulimits for heavy desktop/dev " +
      "workstation workloads (air 002 Xfce/VNC toolchain). samohost VMs are " +
      "app hosts, not agent workstations; default Ubuntu 24.04 limits are " +
      "adequate at current preview density. Tracked as a P3 in #64; promote to " +
      "CONFORMS with a limits.conf fragment if preview count makes it bite.",
  },
  {
    id: "remote-desktop",
    description: "Remote desktop (Xfce/VNC/noVNC) — air 002 software stack",
    airSource: "002_software-stack.md (whole file)",
    status: "DIVERGES",
    reason:
      "Intentionally out of scope: air 002 provisions an AI-agent GUI " +
      "workstation; samohost provisions headless app-hosting VMs. No GUI, VNC, " +
      "or desktop toolchain is desired or installed. (air #64 matrix row 23.)",
  },
] as const;

/**
 * Render the canonical cloud-init baseline used for conformance assertions: the
 * hardening module only, with the default spec and the fixture pubkey. Deriving
 * it here (rather than re-deriving in the test) keeps the registry, the test and
 * the doc generator reading exactly the same bytes the builder emits.
 */
export function renderBaselineForConformance(): string {
  const spec: ProvisionSpec = {
    provider: "hetzner",
    region: "nbg1",
    type: "cx22",
    name: "air-conformance-baseline",
    sshKeyPath: "/dev/null",
    sshPort: 2223,
    adminUser: "samo",
    modules: [],
    trustedIps: [],
    timeoutSec: 600,
  };
  return buildCloudInit(spec, [hardeningModule], {
    sshPubkey: "ssh-ed25519 AAAACONFORMANCEbaselineKEY samo@conformance",
  });
}

/** Required presence substrings for a CONFORMS directive (normalized to array). */
export function requiredSubstrings(d: AirDirective): string[] {
  if (d.status !== "CONFORMS" || d.presence === undefined) return [];
  return Array.isArray(d.presence) ? d.presence : [d.presence];
}

/**
 * Evaluate one directive against a rendered baseline. Returns the list of
 * missing required substrings (empty == conforming). DIVERGES/WAIVED always
 * return empty (their exemption is the written reason, asserted separately).
 */
export function missingSubstrings(
  d: AirDirective,
  rendered: string,
): string[] {
  return requiredSubstrings(d).filter((s) => !rendered.includes(s));
}

/**
 * Render the docs/air-conformance.md body from the registry. The conformance
 * test compares the committed doc against this output so the doc can never drift
 * from the enforced registry (generated == committed, or CI fails).
 */
export function renderConformanceDoc(): string {
  const lines: string[] = [
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Source of truth: src/cloudinit/air-conformance.ts (AIR_DIRECTIVES).",
    "     Regenerate: `bun run scripts/gen-air-conformance.ts`.",
    "     Enforced by: test/air-conformance.test.ts (CI fails on drift). -->",
    "",
    "# air conformance",
    "",
    "Machine-checked mapping of every [postgres-ai/air](https://gitlab.com/postgres-ai/air)",
    "`infrastructure/` hardening directive to samohost's cloud-init baseline",
    "(`src/cloudinit/hardening.ts`) and `samohost doctor` probes.",
    "",
    "This table is **generated and CI-enforced** from `AIR_DIRECTIVES` in",
    "`src/cloudinit/air-conformance.ts`. `test/air-conformance.test.ts` fails the",
    "build if a `CONFORMS` directive is missing from the rendered cloud-init, if a",
    "`DIVERGES`/`WAIVED` row lacks a written reason, or if a `CONFORMS` sshd/ufw",
    "directive has no matching `doctor` probe. This is the #64 fix: the comparison",
    "is **enforced**, not a doc that goes stale.",
    "",
    "## air source & re-grounding",
    "",
    "Directives are grounded in air `infrastructure/001_vm-creation-for-agents.md`,",
    "via the grounded matrix in **NikolayS/samohost#64** (read from both air files",
    "in full via authenticated `glab` on 2026-06-12). air's GitLab API is",
    "auth-gated: an unauthenticated fetch returns **HTTP 401/403/404**. Per #64's",
    "root-cause, a failed fetch MUST be treated as **\"fetch blocked\"**, never as",
    '"air absent" — the original miss began exactly that way. To re-ground per',
    "release: `glab auth login`, then read the two `infrastructure/*.md` files and",
    "reconcile any new directive into `AIR_DIRECTIVES`.",
    "",
    "## Status legend",
    "",
    "- **CONFORMS** — samohost's cloud-init baseline sets this directive (asserted present by the test).",
    "- **DIVERGES** — samohost intentionally differs; the reason is mandatory and recorded below.",
    "- **WAIVED** — out of scope for samohost's app-host posture; reason mandatory.",
    "",
    "## Conformance matrix",
    "",
    "| air directive | status | samohost baseline / reason | doctor probe |",
    "| --- | --- | --- | --- |",
  ];
  for (const d of AIR_DIRECTIVES) {
    const detail =
      d.status === "CONFORMS"
        ? "`" + requiredSubstrings(d).join("`, `") + "`"
        : d.reason ?? "";
    const probe = d.doctorCheckId ? "`" + d.doctorCheckId + "`" : "—";
    lines.push(
      `| ${d.description} | ${d.status} | ${detail} | ${probe} |`,
    );
  }
  lines.push("");
  lines.push("_air values cited (port 2223, etc.) are from air's own public spec; no secrets._");
  lines.push("");
  return lines.join("\n");
}
