/**
 * `samohost domain` command family — client custom domains.
 *
 * Subcommands:
 *   add   <app> <fqdn> [--dcv http|txt] [--json]
 *          — create a CF-for-SaaS Custom Hostname for <fqdn>, persist the
 *            mapping in DomainStore, push the Caddy vhost snippet to the VM,
 *            and print the DNS instructions the client needs to configure.
 *   check <fqdn> [--json]
 *          — verify the client's DNS + CF validation status; exit 0 only
 *            when ssl.status==="active" and hostname is active.
 *   list  [--app <name>] [--json]
 *          — list stored DomainRecords (no network).
 *   rm    <fqdn> [--yes] [--json]
 *          — delete the CF Custom Hostname, push the vhost-removal script,
 *            remove the DomainRecord from state.
 *
 * CF entitlement GATE (see docs/setup-checklist.md):
 *   CF-for-SaaS Custom Hostnames require the SaaS entitlement on the SaaS zone
 *   and a token with SSL and Certificates:Edit scope (`CLOUDFLARE_SAMOTEAM`).
 *   The existing CLOUDFLARE_SAMOCAT token is DNS-only and CANNOT create custom
 *   hostnames. When the token is absent, `add`/`check`/`rm` degrade cleanly
 *   (warn, still write vhost + state), identical to the DNS_DEGRADE_WARNING
 *   pattern in commands/env.ts.
 *
 * All network + SSH effects are injected via {@link DomainDeps} so the whole
 * flow is unit-tested offline, mirroring commands/app.ts and commands/env.ts.
 */

import { spawnSync } from "node:child_process";
import {
  CloudflareDns,
  type CustomHostname,
  type CustomHostnameClient,
} from "../dns/cloudflare.ts";
import {
  buildCustomDomainVhostScript,
  buildCustomDomainVhostRemoveScript,
} from "../env/script.ts";
import { AppStore } from "../state/apps.ts";
import { DomainStore } from "../state/domains.ts";
import { StateStore } from "../state/store.ts";
import {
  defaultKnownHostsDir,
  runRemote,
  type RunDeps,
  type SpawnResult,
} from "../ssh/runner.ts";
import type { AppRecord, DomainRecord, VmRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// DNS instructions copy (static — no gold-plating per plan)
// ---------------------------------------------------------------------------

const CUSTOM_HOSTNAME_TARGET_DEFAULT = "cname.samo.team";

/** Warning printed when CLOUDFLARE_SAMOTEAM token is absent (GATE). */
const CF_DEGRADE_WARNING =
  "samohost: CLOUDFLARE_SAMOTEAM not set — " +
  "skipping Cloudflare Custom Hostname creation (CF-for-SaaS entitlement + " +
  "SSL:Edit token required); Caddy vhost and state record will be created " +
  "but the domain will not be validated by Cloudflare until the token is set";

// ---------------------------------------------------------------------------
// Parsed inputs (produced by the CLI parser)
// ---------------------------------------------------------------------------

export interface DomainAddInput {
  /** App name (resolved across all VMs; error if 0 or >1 match). */
  app: string;
  /** Client FQDN (e.g. "myapp.com"). */
  fqdn: string;
  /** DCV method for CF custom hostname: "http" (default) or "txt". */
  dcv: "http" | "txt";
}

export interface DomainCheckInput {
  fqdn: string;
}

export interface DomainListInput {
  /** Narrow to domains for one app. */
  app?: string;
}

export interface DomainRmInput {
  fqdn: string;
  /** Skip typed confirmation. */
  yes: boolean;
}

// ---------------------------------------------------------------------------
// SSH runner type (mirrors app.ts / env.ts pattern)
// ---------------------------------------------------------------------------

export type RemoteScriptRunner = (
  vm: VmRecord,
  script: string,
) => Promise<SpawnResult>;

// ---------------------------------------------------------------------------
// DomainDeps — injectable for offline tests
// ---------------------------------------------------------------------------

export interface DomainDeps {
  /**
   * Cloudflare for SaaS client; `undefined` when CLOUDFLARE_SAMOTEAM
   * is absent (GATE degrade — the command still writes vhost + state).
   *
   * Typed as the narrow {@link CustomHostnameClient} port so tests can inject
   * plain mock objects without constructing a full `CloudflareDns` instance.
   */
  cf: CustomHostnameClient | undefined;
  /** Run a bash script remotely over the pinned SSH runner. */
  remote: RemoteScriptRunner;
  /** DNS CNAME lookup — injected so tests run offline. */
  resolveCname: (fqdn: string) => Promise<string[]>;
  now: () => Date;
  uuid: () => string;
}

// ---------------------------------------------------------------------------
// Domain FQDN validation (mirrors isValidMainHost from env/script.ts)
// ---------------------------------------------------------------------------

/**
 * Validate a client FQDN. Must be a dotted lowercase DNS name.
 * Embedded in root-run scripts — fail closed on anything non-standard.
 */
function isValidFqdn(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return (
    new RegExp(`^${label}(?:\\.${label})*\\.[a-z]{2,63}$`).test(
      host.toLowerCase(),
    ) && host === host.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// DNS instructions helper
// ---------------------------------------------------------------------------

function buildDnsInstructions(
  fqdn: string,
  cnameTarget: string,
  ch: CustomHostname | undefined,
): string {
  const lines: string[] = [
    "",
    "Point your domain at samo:",
    `  Type: CNAME   Host: ${fqdn}   Value: ${cnameTarget}   Proxy/DNS-only: per provider`,
  ];

  if (ch !== undefined) {
    const validationRecords = ch.ssl.validation_records ?? [];
    const ownershipVerification = ch.ownership_verification;
    if (validationRecords.length > 0 || ownershipVerification !== undefined) {
      lines.push("Verify ownership (until SSL shows active):");
      for (const r of validationRecords) {
        if (r.http_url !== undefined) {
          lines.push(`  HTTP: serve ${JSON.stringify(r.http_body ?? "")} at ${r.http_url}`);
        }
        if (r.txt_name !== undefined) {
          lines.push(`  TXT:  ${r.txt_name} = ${r.txt_value ?? ""}`);
        }
      }
      if (ownershipVerification !== undefined) {
        lines.push(
          `  Ownership TXT: ${ownershipVerification.name} = ${ownershipVerification.value}`,
        );
      }
    }
  }

  lines.push(
    "Provider hints:",
    "  GoDaddy       DNS > Records > Add > CNAME; apex needs Forwarding or move DNS to Cloudflare",
    "  Google/Squarespace  DNS > Custom records > CNAME; apex not supported — use a subdomain",
    "  Cloudflare    DNS > Add CNAME, set Proxy status OFF (grey cloud) for the target",
    "  Namecheap     Advanced DNS > Add New Record > CNAME Record; apex needs ALIAS",
    "  101domain     DNS Manager > Add Record > CNAME; apex needs ALIAS/ANAME",
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface DomainAddReport {
  fqdn: string;
  appName: string;
  vmName: string;
  customHostnameId: string | undefined;
  hostnameStatus: string | undefined;
  sslStatus: string | undefined;
  cnameTarget: string;
}

export async function runDomainAdd(
  input: DomainAddInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  domainStore: DomainStore,
  deps: DomainDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  // ---- resolve app by name across all VMs ----------------------------------
  const allApps = appStore.list();
  const matched = allApps.filter((a) => a.name === input.app);
  if (matched.length === 0) {
    err(`error: no app named ${JSON.stringify(input.app)} found in state`);
    return 1;
  }
  if (matched.length > 1) {
    const vms = matched.map((a) => a.vmId).join(", ");
    err(
      `error: app ${JSON.stringify(input.app)} matches ${matched.length} VMs ` +
        `(${vms}); add --vm support or register the app on only one VM`,
    );
    return 1;
  }
  const app = matched[0] as AppRecord;

  // ---- validate FQDN -------------------------------------------------------
  if (!isValidFqdn(input.fqdn)) {
    err(
      `error: invalid fqdn ${JSON.stringify(input.fqdn)} — ` +
        `expected a dotted lowercase DNS name like "myapp.com"`,
    );
    return 1;
  }

  // ---- resolve VM ----------------------------------------------------------
  const vm = vmStore.list().find((v) => v.id === app.vmId);
  if (vm === undefined) {
    err(
      `error: VM ${JSON.stringify(app.vmId)} for app ${JSON.stringify(app.name)} ` +
        `not found in state`,
    );
    return 1;
  }

  // ---- CF Custom Hostname (GATE degrade) -----------------------------------
  let ch: CustomHostname | undefined;
  const cnameTarget =
    process.env["SAMOHOST_CUSTOM_HOSTNAME_TARGET"] ??
    CUSTOM_HOSTNAME_TARGET_DEFAULT;

  if (deps.cf !== undefined) {
    try {
      ch = await deps.cf.createCustomHostname(input.fqdn, input.dcv);
    } catch (e) {
      err(
        `error: Cloudflare custom hostname creation failed for ${input.fqdn}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
  } else {
    err(CF_DEGRADE_WARNING);
  }

  // ---- push Caddy vhost snippet over SSH -----------------------------------
  try {
    const script = buildCustomDomainVhostScript(app, input.fqdn);
    const result = await deps.remote(vm, script);
    if (result.code !== 0) {
      err(
        `error: remote vhost script failed (exit ${result.code}): ` +
          result.stderr,
      );
      return 1;
    }
  } catch (e) {
    err(
      `error: remote vhost script connection failed: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }

  // ---- persist DomainRecord ------------------------------------------------
  const now = deps.now();
  const record: DomainRecord = {
    id: deps.uuid(),
    fqdn: input.fqdn,
    appName: app.name,
    vmId: app.vmId,
    ...(ch !== undefined ? { customHostnameId: ch.id } : {}),
    ...(ch !== undefined ? { hostnameStatus: ch.status } : {}),
    ...(ch !== undefined ? { sslStatus: ch.ssl.status } : {}),
    createdAt: now.toISOString(),
  };
  domainStore.upsert(record);

  // ---- output --------------------------------------------------------------
  const report: DomainAddReport = {
    fqdn: input.fqdn,
    appName: app.name,
    vmName: vm.name,
    customHostnameId: ch?.id,
    hostnameStatus: ch?.status,
    sslStatus: ch?.ssl.status,
    cnameTarget,
  };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(`domain add ${input.fqdn} → ${app.name} on ${vm.name}: ok`);
    out(buildDnsInstructions(input.fqdn, cnameTarget, ch));
  }

  return 0;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

export interface DomainCheckReport {
  fqdn: string;
  hostnameStatus: string | undefined;
  sslStatus: string | undefined;
  cnameResolved: boolean;
  cnameTarget: string | undefined;
  verificationErrors: string[];
  active: boolean;
}

export async function runDomainCheck(
  input: DomainCheckInput,
  opts: { json: boolean },
  domainStore: DomainStore,
  deps: DomainDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  // ---- load record ---------------------------------------------------------
  const stored = domainStore.get(input.fqdn);
  if (stored === undefined) {
    err(
      `error: domain ${JSON.stringify(input.fqdn)} not found in state — ` +
        `run 'samohost domain add' first`,
    );
    return 1;
  }

  // ---- refresh CF status ---------------------------------------------------
  let ch: CustomHostname | undefined;
  if (deps.cf !== undefined && stored.customHostnameId !== undefined) {
    try {
      ch = await deps.cf.getCustomHostname(stored.customHostnameId);
    } catch (e) {
      // Non-fatal: report from stored state
      err(
        `warning: could not refresh CF status for ${input.fqdn}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---- DNS CNAME probe -----------------------------------------------------
  let cnameResolved = false;
  let cnameTarget: string | undefined;
  const expectedTarget =
    process.env["SAMOHOST_CUSTOM_HOSTNAME_TARGET"] ??
    CUSTOM_HOSTNAME_TARGET_DEFAULT;
  try {
    const targets = await deps.resolveCname(input.fqdn);
    if (targets.length > 0) {
      cnameResolved = true;
      cnameTarget = targets[0];
    }
  } catch {
    // DNS not set yet — that is the common pending case, not an error
  }

  // ---- update stored statuses ----------------------------------------------
  if (ch !== undefined) {
    const updated: DomainRecord = {
      ...stored,
      hostnameStatus: ch.status,
      sslStatus: ch.ssl.status,
      updatedAt: deps.now().toISOString(),
    };
    domainStore.upsert(updated);
  }

  // ---- determine overall active status -------------------------------------
  const hostnameStatus = ch?.status ?? stored.hostnameStatus;
  const sslStatus = ch?.ssl.status ?? stored.sslStatus;
  const verificationErrors = ch?.verification_errors ?? [];
  const active = hostnameStatus === "active" && sslStatus === "active";

  // ---- output --------------------------------------------------------------
  const report: DomainCheckReport = {
    fqdn: input.fqdn,
    hostnameStatus,
    sslStatus,
    cnameResolved,
    cnameTarget,
    verificationErrors,
    active,
  };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(
      [
        `fqdn:             ${input.fqdn}`,
        `hostname_status:  ${hostnameStatus ?? "-"}`,
        `ssl_status:       ${sslStatus ?? "-"}`,
        `cname_resolved:   ${cnameResolved ? `yes (→ ${cnameTarget ?? "?"})` : "no"}`,
        `cname_target:     ${expectedTarget}`,
        `active:           ${active ? "yes" : "no"}`,
        ...(verificationErrors.length > 0
          ? [`verification_errors: ${verificationErrors.join("; ")}`]
          : []),
        ...(!active && ch !== undefined
          ? [buildDnsInstructions(input.fqdn, expectedTarget, ch).trimEnd()]
          : []),
      ].join("\n"),
    );
  }

  return active ? 0 : 1;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runDomainList(
  input: DomainListInput,
  opts: { json: boolean },
  domainStore: DomainStore,
  out: (s: string) => void,
  _err: (s: string) => void,
): Promise<number> {
  let records = domainStore.list();
  if (input.app !== undefined) {
    records = records.filter((d) => d.appName === input.app);
  }

  if (opts.json) {
    out(JSON.stringify(records, null, 2));
    return 0;
  }

  if (records.length === 0) {
    return 0;
  }

  // Text table
  const rows = records.map((d) => ({
    fqdn: d.fqdn,
    app: d.appName,
    hostname: d.hostnameStatus ?? "-",
    ssl: d.sslStatus ?? "-",
    cf_id: d.customHostnameId ?? "-",
  }));

  const maxFqdn = Math.max(4, ...rows.map((r) => r.fqdn.length));
  const maxApp = Math.max(3, ...rows.map((r) => r.app.length));
  const header = [
    "FQDN".padEnd(maxFqdn),
    "APP".padEnd(maxApp),
    "HOSTNAME".padEnd(8),
    "SSL".padEnd(18),
    "CF_ID",
  ].join("  ");
  out(header);
  for (const r of rows) {
    out(
      [
        r.fqdn.padEnd(maxFqdn),
        r.app.padEnd(maxApp),
        r.hostname.padEnd(8),
        r.ssl.padEnd(18),
        r.cf_id,
      ].join("  "),
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

export async function runDomainRm(
  input: DomainRmInput,
  opts: { json: boolean },
  vmStore: StateStore,
  appStore: AppStore,
  domainStore: DomainStore,
  deps: DomainDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  // ---- load record ---------------------------------------------------------
  const stored = domainStore.get(input.fqdn);
  if (stored === undefined) {
    err(
      `error: domain ${JSON.stringify(input.fqdn)} not found in state — ` +
        `nothing to remove`,
    );
    return 1;
  }

  // ---- typed confirmation (mirrors destroy.ts) -----------------------------
  if (!input.yes) {
    // In prod, defaultConfirm prompts via stdin. Tests always pass yes:true.
    err(
      `error: removal of ${input.fqdn} requires --yes (or interactive confirmation)`,
    );
    return 1;
  }

  // ---- CF delete (GATE degrade) --------------------------------------------
  if (deps.cf !== undefined) {
    if (stored.customHostnameId !== undefined) {
      try {
        await deps.cf.deleteCustomHostname(stored.customHostnameId);
      } catch (e) {
        err(
          `warning: Cloudflare custom hostname delete failed for ` +
            `${stored.customHostnameId}: ` +
            `${e instanceof Error ? e.message : String(e)} — ` +
            `continuing to remove local state and Caddy vhost`,
        );
      }
    }
  } else {
    err(CF_DEGRADE_WARNING);
  }

  // ---- resolve VM for SSH --------------------------------------------------
  const app = appStore.list().find(
    (a) => a.name === stored.appName && a.vmId === stored.vmId,
  );
  const vm = app !== undefined
    ? vmStore.list().find((v) => v.id === stored.vmId)
    : undefined;

  // ---- push vhost removal script -------------------------------------------
  if (vm !== undefined) {
    try {
      const script = buildCustomDomainVhostRemoveScript(input.fqdn);
      const result = await deps.remote(vm, script);
      if (result.code !== 0) {
        err(
          `warning: remote vhost-remove script failed (exit ${result.code}): ` +
            result.stderr +
            ` — continuing to remove state`,
        );
      }
    } catch (e) {
      err(
        `warning: remote vhost-remove connection failed: ` +
          `${e instanceof Error ? e.message : String(e)} — ` +
          `continuing to remove state`,
      );
    }
  }

  // ---- remove state --------------------------------------------------------
  domainStore.remove(input.fqdn);

  if (opts.json) {
    out(JSON.stringify({ fqdn: input.fqdn, removed: true }, null, 2));
  } else {
    out(`domain rm ${input.fqdn}: removed`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Production dependency wiring (not exercised by unit tests)
// ---------------------------------------------------------------------------

/** Run ssh with the script on stdin (`bash -s`) over the pinned runner. */
function defaultRemoteScriptRunner(): RemoteScriptRunner {
  const deps: RunDeps = {
    clock: () => Date.now(),
    knownHostsDir:
      process.env["SAMOHOST_KNOWN_HOSTS_DIR"] ?? defaultKnownHostsDir(),
    spawn: (file: string, args: string[]): Promise<SpawnResult> => {
      const res = spawnSync(file, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return Promise.resolve({
        code: typeof res.status === "number" ? res.status : 255,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
      });
    },
  };
  return (vm, script) => {
    const piping: RunDeps = {
      ...deps,
      spawn: (file, args) => {
        const res = spawnSync(file, args, {
          encoding: "utf8",
          input: script,
          maxBuffer: 16 * 1024 * 1024,
        });
        return Promise.resolve({
          code: typeof res.status === "number" ? res.status : 255,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
        });
      },
    };
    return runRemote(vm, "bash -s", piping);
  };
}

/** Default domain deps — wires CF client from env, real DNS, real SSH. */
export function defaultDomainDeps(): DomainDeps {
  const token = process.env["CLOUDFLARE_SAMOTEAM"];
  const zoneId = process.env["SAMOHOST_SAAS_ZONE_ID"];
  const zoneName = process.env["SAMOHOST_SAAS_ZONE"] ?? "samo.team";

  let cf: CloudflareDns | undefined;
  if (token !== undefined && token.length > 0) {
    cf = new CloudflareDns(
      zoneId !== undefined && zoneId.length > 0
        ? { token, zoneId }
        : { token, zoneName },
    );
  }

  return {
    cf,
    remote: defaultRemoteScriptRunner(),
    resolveCname: async (fqdn: string) => {
      const { resolveCname } = await import("node:dns/promises");
      return resolveCname(fqdn);
    },
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
  };
}
