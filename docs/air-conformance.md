<!-- GENERATED FILE — do not edit by hand.
     Source of truth: src/cloudinit/air-conformance.ts (AIR_DIRECTIVES).
     Regenerate: `bun run scripts/gen-air-conformance.ts`.
     Enforced by: test/air-conformance.test.ts (CI fails on drift). -->

# air conformance

Machine-checked mapping of every [postgres-ai/air](https://gitlab.com/postgres-ai/air)
`infrastructure/` hardening directive to samohost's cloud-init baseline
(`src/cloudinit/hardening.ts`) and `samohost doctor` probes.

This table is **generated and CI-enforced** from `AIR_DIRECTIVES` in
`src/cloudinit/air-conformance.ts`. `test/air-conformance.test.ts` fails the
build if a `CONFORMS` directive is missing from the rendered cloud-init, if a
`DIVERGES`/`WAIVED` row lacks a written reason, or if a `CONFORMS` sshd/ufw
directive has no matching `doctor` probe. This is the #64 fix: the comparison
is **enforced**, not a doc that goes stale.

## air source & re-grounding

Directives are grounded in air `infrastructure/001_vm-creation-for-agents.md`,
via the grounded matrix in **NikolayS/samohost#64** (read from both air files
in full via authenticated `glab` on 2026-06-12). air's GitLab API is
auth-gated: an unauthenticated fetch returns **HTTP 401/403/404**. Per #64's
root-cause, a failed fetch MUST be treated as **"fetch blocked"**, never as
"air absent" — the original miss began exactly that way. To re-ground per
release: `glab auth login`, then read the two `infrastructure/*.md` files and
reconcile any new directive into `AIR_DIRECTIVES`.

## Status legend

- **CONFORMS** — samohost's cloud-init baseline sets this directive (asserted present by the test).
- **DIVERGES** — samohost intentionally differs; the reason is mandatory and recorded below.
- **WAIVED** — out of scope for samohost's app-host posture; reason mandatory.

## Conformance matrix

| air directive | status | samohost baseline / reason | doctor probe |
| --- | --- | --- | --- |
| sshd: custom (non-22) SSH port | CONFORMS | `Port 2223` | `ssh-port` |
| sshd: PermitRootLogin no | CONFORMS | `PermitRootLogin no` | `permitrootlogin` |
| sshd: PasswordAuthentication no | CONFORMS | `PasswordAuthentication no` | `passwordauth` |
| sshd: MaxAuthTries 3 (cap brute-force attempts per connection) | CONFORMS | `MaxAuthTries 3` | `maxauthtries` |
| sshd: ClientAliveInterval 300 + ClientAliveCountMax 2 (drop idle/dead sessions) | CONFORMS | `ClientAliveInterval 300`, `ClientAliveCountMax 2` | `clientalive` |
| sshd: X11Forwarding no | CONFORMS | `X11Forwarding no` | `x11forwarding` |
| sshd: AllowAgentForwarding no | CONFORMS | `AllowAgentForwarding no` | `allowagentforwarding` |
| sshd: PermitUserEnvironment no | CONFORMS | `PermitUserEnvironment no` | `permituserenvironment` |
| sshd: PermitEmptyPasswords no (defense-in-depth) | CONFORMS | `PermitEmptyPasswords no` | `permitemptypasswords` |
| sshd: AllowTcpForwarding no | DIVERGES | samohost previews proxy app traffic through Caddy on the box (no remote port-forward dependency), but operators occasionally tunnel to loopback Postgres (:5432, which is intentionally loopback-only) for debugging. Setting AllowTcpForwarding no would break that legitimate operator flow while adding little: PermitRootLogin no + AllowUsers + key-only auth + fail2ban already constrain who can forward. Re-evaluate if loopback-PG tunneling is dropped. (air #64 matrix row 8, flagged 'eval'.) | — |
| Remove/empty root's authorized_keys at provision | CONFORMS | `/root/.ssh/authorized_keys` | `root-authorized-keys-empty` |
| UFW default-deny incoming | CONFORMS | `ufw default deny incoming` | `ufw-active` |
| UFW rate-limit (limit) the SSH port, not plain allow | CONFORMS | `ufw limit 2223/tcp` | `ufw-limit-ssh` |
| fail2ban sshd jail (banaction, maxretry, bantime) | CONFORMS | `[sshd]`, `maxretry = 5` | `fail2ban-active` |
| unattended-upgrades (automatic security updates) | CONFORMS | `APT::Periodic::Unattended-Upgrade "1";` | `unattended-upgrades-active` |
| sysctl network hardening (rp_filter, syncookies, redirects) | CONFORMS | `net.ipv4.tcp_syncookies = 1`, `net.ipv4.conf.all.rp_filter = 1` | `sysctl-syncookies` |
| AppArmor enabled with profiles in enforce mode | CONFORMS | `aa-enforce` | `apparmor-enforced` |
| Non-root sudo user (least-privilege admin) | CONFORMS | `groups: sudo` | — |
| Raise file-descriptor / process limits (65535) fleet-wide | WAIVED | Not security hardening; air raises ulimits for heavy desktop/dev workstation workloads (air 002 Xfce/VNC toolchain). samohost VMs are app hosts, not agent workstations; default Ubuntu 24.04 limits are adequate at current preview density. Tracked as a P3 in #64; promote to CONFORMS with a limits.conf fragment if preview count makes it bite. | — |
| Remote desktop (Xfce/VNC/noVNC) — air 002 software stack | DIVERGES | Intentionally out of scope: air 002 provisions an AI-agent GUI workstation; samohost provisions headless app-hosting VMs. No GUI, VNC, or desktop toolchain is desired or installed. (air #64 matrix row 23.) | — |

_air values cited (port 2223, etc.) are from air's own public spec; no secrets._
