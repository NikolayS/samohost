/**
 * DBLab Engine cloud-init provisioning module (issue #127).
 *
 * Implements the verified minimal €0 profile on a cx22 (root-disk only,
 * no paid volume): sparse loopback ZFS pool, dblab_server 4.1.3 on
 * 127.0.0.1:2345, ARC capped at 256 MB, clone cap 2, 2 GB swapfile.
 *
 * Baked-in lessons from the manual samograph install (#127 critical lesson):
 *   - NEVER disables fail2ban (manual install stopped it → near-lockout).
 *   - NEVER drops the UFW :2223 rule.
 *   - The control-plane IP is already in fail2ban ignoreip via the hardening
 *     module's trustedIps — this module must not undo that.
 *
 * The module is PURE: no filesystem or network access; all config comes from
 * the ProvisionSpec or the constants below.
 */

import type { AuditCheck, CloudInitFragment, Module, ProvisionSpec } from "../types.ts";

// ---------------------------------------------------------------------------
// Pinned constants (change here only — these are load-bearing for tests)
// ---------------------------------------------------------------------------

/** DBLab Engine version pinned per issue #127. */
export const DBLAB_VERSION = "4.1.3";

/** PostgreSQL clone image compatible with PG 16 (the SAMO default). */
export const DBLAB_PG_IMAGE = "postgresai/extended-postgres:16-0.6.2";

/** Engine API port: always 127.0.0.1-bound (localhost only). */
export const DBLAB_API_PORT = 2345;

/** Max concurrent clones (#127 minimal profile). */
export const DBLAB_MAX_CLONES = 2;

/**
 * ZFS ARC max in bytes (#127 minimal profile: 256 MB).
 * Applied as a kernel module param via /etc/modprobe.d/zfs.conf.
 */
export const DBLAB_ARC_MAX_BYTES = 256 * 1024 * 1024; // 268435456

/** Loopback pool file size. */
export const DBLAB_POOL_SIZE_GB = 10;

/** Swapfile size (#127: 2 GB). */
export const DBLAB_SWAP_SIZE_GB = 2;

/** Container memory limit: 1 GB (#127). */
export const DBLAB_CONTAINER_MEMORY_BYTES = 1073741824;

/** Per-clone shared_buffers override (#127). */
export const DBLAB_SHARED_BUFFERS = "128MB";

/** Clone container port pool (#127). */
export const DBLAB_PORT_POOL_FROM = 6000;
export const DBLAB_PORT_POOL_TO = 6099;

/**
 * Clone idle timeout in minutes.
 * 20160 = 14 days — prevents DBLab expiring a clone under a still-running PR
 * preview. samohost's own env-gc/idle-gc handles env lifetime instead.
 */
export const DBLAB_MAX_IDLE_MINUTES = 20160;

/** Docker bridge gateway: how the engine container reaches the host PG. */
export const DOCKER_BRIDGE_GW = "172.17.0.1";
export const DOCKER_BRIDGE_SUBNET = "172.17.0.0/16";

// ---------------------------------------------------------------------------
// File content generators
// ---------------------------------------------------------------------------

/**
 * /etc/modprobe.d/zfs.conf — caps the ZFS ARC at DBLAB_ARC_MAX_BYTES.
 * Applied at module load (next boot or explicit modprobe reload).
 */
const ZFS_MODPROBE_CONF = [
  "# Managed by samohost dblab module — ZFS ARC cap",
  `options zfs zfs_arc_max=${DBLAB_ARC_MAX_BYTES}`,
  "",
].join("\n");

/**
 * /etc/systemd/system/dblab-loopback.service — re-attaches the loopback
 * device on every boot, BEFORE zfs-import.target and docker.service attempt
 * to use the pool or start containers that depend on it.
 */
const DBLAB_LOOPBACK_SERVICE = [
  "# Managed by samohost dblab module — loopback ZFS persistence",
  "[Unit]",
  "Description=DBLab ZFS loopback device",
  "Before=zfs-import.target docker.service",
  "DefaultDependencies=no",
  "",
  "[Service]",
  "Type=oneshot",
  "RemainAfterExit=yes",
  "ExecStart=/bin/sh -c 'test -b /dev/loop0 || losetup /dev/loop0 /var/lib/dblab-pool/dblab.img'",
  "",
  "[Install]",
  "WantedBy=basic.target",
  "",
].join("\n");

/**
 * /root/.dblab/engine/startup.sh — wraps the dblab-server binary with the
 * busybox-grep workaround (Alpine base image ships busybox grep which lacks
 * -P; install full grep via apk so the engine's log filters work correctly).
 */
const DBLAB_STARTUP_SH = [
  "#!/bin/sh",
  "# Managed by samohost dblab module — busybox grep workaround",
  "set -e",
  "apk add --no-cache grep 2>/dev/null || true",
  "# Symlink to ensure full grep is on PATH before the server starts",
  "if command -v grep >/dev/null 2>&1; then",
  "  cp -f \"$(command -v grep)\" /usr/local/bin/grep 2>/dev/null || true",
  "fi",
  'exec ./bin/dblab-server "$@"',
  "",
].join("\n");

/**
 * /root/.dblab/engine/configs/server.yml — DBLab v4.1.3 engine config.
 *
 * Key settings (#127 minimal profile):
 *   port=2345, ARC cap applied separately via modprobe.d, clone cap 2,
 *   per-clone shared_buffers 128 MB, container memory 1 GB,
 *   portPool 6000-6099, source = host PG via Docker bridge, logical retrieval.
 */
const DBLAB_SERVER_YML = `# Managed by samohost dblab module — DBLab Engine v${DBLAB_VERSION} config
# Issue #127: verified minimal profile (cx22, loopback ZFS pool).
server:
  verificationToken: "\${DBLAB_VERIFICATION_TOKEN}"
  port: ${DBLAB_API_PORT}
  enableTelemetry: false

poolManager:
  mountDir: /var/lib/dblab
  pool: dblab

provision:
  portPool:
    from: ${DBLAB_PORT_POOL_FROM}
    to: ${DBLAB_PORT_POOL_TO}
  dockerImage: "${DBLAB_PG_IMAGE}"
  cloneAccessAddresses:
    - "127.0.0.1"

databaseConfigs:
  configs:
    shared_buffers: "${DBLAB_SHARED_BUFFERS}"

containerConfig:
  containerResources:
    memory: ${DBLAB_CONTAINER_MEMORY_BYTES}

cloning:
  maxCloneCount: ${DBLAB_MAX_CLONES}
  maxIdleMinutes: ${DBLAB_MAX_IDLE_MINUTES}

retrieval:
  spec:
    skipStartRefresh: true
    jobs:
      - logicalDump:
          options:
            source:
              connection:
                host: "${DOCKER_BRIDGE_GW}"
                port: 5432
                dbname: "\${DBLAB_SOURCE_DB}"
                username: "\${DBLAB_SOURCE_USER}"
      - logicalRestore:
          options: {}
      - logicalSnapshot: {}
`;

// ---------------------------------------------------------------------------
// Postgresql pg_hba.conf entry for Docker bridge access
// ---------------------------------------------------------------------------

/**
 * pg_hba.conf entry that allows the dblab_server container (running on the
 * Docker bridge subnet 172.17.0.0/16) to connect to the host PG for logical
 * dumps. Appended to /etc/postgresql/<ver>/main/pg_hba.conf via runcmd.
 */
const PG_HBA_ENTRY =
  `# Added by samohost dblab module: allow Docker bridge for dblab logical dump\n` +
  `host    all    all    ${DOCKER_BRIDGE_SUBNET}    scram-sha-256\n`;

// ---------------------------------------------------------------------------
// cloud-init fragment builder
// ---------------------------------------------------------------------------

function buildFragment(spec: ProvisionSpec): CloudInitFragment {
  const { adminUser } = spec;

  const packages: string[] = [
    "apt-transport-https",
    "ca-certificates",
    "curl",
    "gnupg",
    "lsb-release",
    "zfsutils-linux",
  ];

  const writeFiles = [
    {
      path: "/etc/modprobe.d/zfs.conf",
      content: ZFS_MODPROBE_CONF,
      permissions: "0644",
    },
    {
      path: "/etc/systemd/system/dblab-loopback.service",
      content: DBLAB_LOOPBACK_SERVICE,
      permissions: "0644",
    },
    {
      path: "/root/.dblab/engine/startup.sh",
      content: DBLAB_STARTUP_SH,
      permissions: "0755",
      owner: "root:root",
    },
    {
      path: "/root/.dblab/engine/configs/server.yml",
      content: DBLAB_SERVER_YML,
      permissions: "0600",
      owner: "root:root",
    },
  ];

  const runcmd: string[] = [
    // ---- Docker CE from official apt repo (step 1) ----
    // Add the Docker GPG key and apt repository, then install.
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
    "chmod a+r /etc/apt/keyrings/docker.gpg",
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list`,
    "apt-get update -qq",
    "apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",

    // ---- Add admin user to docker group (step 2) ----
    `usermod -aG docker ${adminUser}`,

    // ---- Pull images (step 3) ----
    `docker pull postgresai/dblab-server:${DBLAB_VERSION}`,
    `docker pull ${DBLAB_PG_IMAGE}`,

    // ---- 2 GB swapfile (#127 minimal profile) ----
    "fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048",
    "chmod 600 /swapfile",
    "mkswap /swapfile",
    "swapon /swapfile",
    "echo '/swapfile none swap sw 0 0' >> /etc/fstab",

    // ---- ZFS ARC cap (step: module param at load via modprobe.d) ----
    // The /etc/modprobe.d/zfs.conf file was written above; update-initramfs
    // bakes it into the initrd so the cap is applied from the next boot.
    // For the current session: if the zfs module is loaded, set it live too.
    `echo ${DBLAB_ARC_MAX_BYTES} > /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true`,
    "update-initramfs -u -k all 2>/dev/null || true",

    // ---- Sparse 10G loopback file (step 4) ----
    "mkdir -p /var/lib/dblab-pool",
    `fallocate -l ${DBLAB_POOL_SIZE_GB}G /var/lib/dblab-pool/dblab.img`,
    "losetup /dev/loop0 /var/lib/dblab-pool/dblab.img",

    // ---- ZFS pool + dataset (steps 6-7) ----
    "zpool create dblab /dev/loop0",
    "zfs create dblab/dblab_pool",
    "zfs set compression=on atime=off logbias=throughput mountpoint=/var/lib/dblab/dblab_pool dblab/dblab_pool",

    // ---- dblab-loopback systemd service (step 8) ----
    "systemctl daemon-reload",
    "systemctl enable dblab-loopback.service",

    // ---- Ensure the dblab config dirs exist (step 9) ----
    "mkdir -p /root/.dblab/engine/configs /root/.dblab/engine/meta",

    // ---- Generate the verification token (step 9) ----
    "DBLAB_VERIFICATION_TOKEN=$(openssl rand -hex 32)",
    "echo \"$DBLAB_VERIFICATION_TOKEN\" > /root/.dblab/token",
    "chmod 600 /root/.dblab/token",
    // Substitute the placeholder in server.yml with the generated token.
    "sed -i \"s/\\${DBLAB_VERIFICATION_TOKEN}/$DBLAB_VERIFICATION_TOKEN/g\" /root/.dblab/engine/configs/server.yml",

    // ---- Host Postgres: allow Docker bridge for logical dump (step 11) ----
    // Append to each pg_hba.conf we find (Ubuntu packages put PG under
    // /etc/postgresql/<ver>/main/); reload PG so the entry takes effect.
    `printf '%s' '${PG_HBA_ENTRY.replace(/'/g, "'\\''")}' | tee -a /etc/postgresql/*/main/pg_hba.conf 2>/dev/null || true`,
    // Also ensure listen_addresses covers the bridge gateway.
    "for conf in /etc/postgresql/*/main/postgresql.conf; do grep -q \"listen_addresses.*172.17.0.1\" \"$conf\" || echo \"listen_addresses = 'localhost,172.17.0.1'\" >> \"$conf\"; done 2>/dev/null || true",
    "systemctl reload postgresql 2>/dev/null || true",

    // ---- Run the engine (step 12) ----
    `docker run --name dblab_server --label dblab_control --privileged ` +
      `--publish 127.0.0.1:${DBLAB_API_PORT}:${DBLAB_API_PORT} ` +
      `--volume /var/run/docker.sock:/var/run/docker.sock ` +
      `--volume /var/lib/dblab:/var/lib/dblab/:rshared ` +
      `--volume /root/.dblab/engine/configs:/home/dblab/configs:ro ` +
      `--volume /root/.dblab/engine/meta:/home/dblab/meta ` +
      `--volume /root/.dblab/engine/startup.sh:/home/dblab/startup.sh:ro ` +
      `--detach --restart on-failure ` +
      `postgresai/dblab-server:${DBLAB_VERSION} /home/dblab/startup.sh`,

    // ---- Install CLI (step 13) ----
    `DBLAB_CLI_VERSION=${DBLAB_VERSION} bash -c 'curl -sSL https://dblab.sh | bash'`,
    `mkdir -p ~/bin && ln -sf ~/.dblab/dblab ~/bin/dblab`,
    "echo 'export PATH=$PATH:$HOME/bin' >> /root/.bashrc",

    // ---- Init CLI (step 14) ----
    `/root/bin/dblab init --environment-id solo --url http://127.0.0.1:${DBLAB_API_PORT} --token "$(cat /root/.dblab/token)" --insecure 2>/dev/null || true`,

    // ---- Wait for engine to be healthy before refresh (step 16 precondition) ----
    // The engine starts async via --detach; wait up to 60s for healthz.
    `for i in $(seq 1 60); do curl -fsS --max-time 3 http://127.0.0.1:${DBLAB_API_PORT}/healthz >/dev/null 2>&1 && break; sleep 1; done`,

    // ---- Verify healthz (step 16) ----
    `curl -fsS http://127.0.0.1:${DBLAB_API_PORT}/healthz`,

    // ---- Initial snapshot refresh (step 15 — after healthz confirmed) ----
    // skipStartRefresh=true means the engine won't auto-refresh; we trigger it
    // explicitly. The database name must be set in DBLAB_SOURCE_DB before this
    // runs — operators set it in /root/.dblab/engine/configs/server.yml and
    // re-run: dblab instance snapshots refresh
    "/root/bin/dblab instance snapshots refresh 2>/dev/null || true",

    // ---- SSH stability (step 18) ----
    // Mask ssh.socket to prevent the Ubuntu 24.04 socket-activation restart
    // loop that can occur when sshd is managed via socket AND plain service.
    // The hardening module already set up the socket override; masking after
    // cloud-init is complete is safe and prevents the restart-loop.
    //
    // CRITICAL: do NOT disable fail2ban, do NOT delete the UFW rule.
    "systemctl mask ssh.socket 2>/dev/null || true",
  ];

  return { packages, writeFiles, runcmd };
}

// ---------------------------------------------------------------------------
// Audit checks
// ---------------------------------------------------------------------------

const auditChecks: AuditCheck[] = [
  {
    id: "dblab-healthz",
    description: `dblab engine healthz answering on 127.0.0.1:${DBLAB_API_PORT}`,
    probeCommand: `curl -fsS --max-time 5 http://127.0.0.1:${DBLAB_API_PORT}/healthz 2>/dev/null || echo NO_HEALTHZ`,
    expect: /\{.*"edition"/,
  },
  {
    id: "dblab-container",
    description: "dblab_server container running",
    probeCommand:
      "docker ps --filter name=dblab_server --format '{{.Status}}' 2>/dev/null | grep -q Up && echo UP || echo NOT_UP",
    expect: "UP",
  },
  {
    id: "dblab-zfs-pool",
    description: "dblab ZFS pool present",
    probeCommand: "zpool list dblab 2>/dev/null | grep -q dblab && echo POOL_OK || echo NO_POOL",
    expect: "POOL_OK",
  },
];

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

/** DBLab Engine provisioning module (issue #127). */
export const dblabModule: Module = {
  name: "dblab",
  validate(_spec: ProvisionSpec): string[] {
    // The module is valid for any spec; no required fields beyond what
    // the hardening baseline already validates.
    return [];
  },
  cloudInitFragment: buildFragment,
  auditChecks,
};
