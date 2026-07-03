/**
 * Tests for the `samohost domain` command runners.
 *
 * All network + SSH effects are injected via DomainDeps.
 * CF responses use the real prod-shaped CustomHostname fixture.
 * State stores are backed by temp dirs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDomainAdd,
  runDomainCheck,
  runDomainList,
  runDomainRm,
  type DomainDeps,
  type DomainAddInput,
  type DomainCheckInput,
  type DomainListInput,
  type DomainRmInput,
  type ControlPlaneScriptRunner,
} from "../src/commands/domain.ts";
import { DomainStore } from "../src/state/domains.ts";
import { AppStore } from "../src/state/apps.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, DomainRecord, VmRecord } from "../src/types.ts";
import type { CustomHostname } from "../src/dns/cloudflare.ts";

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

let dir: string;
let statePath: string;
let appsPath: string;
let domainsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-domain-cmd-"));
  statePath = join(dir, "state.json");
  appsPath = join(dir, "apps.json");
  domainsPath = join(dir, "domains.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXED_UUID = "uuid-test-1234";
const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");

const VM: VmRecord = {
  id: "vm-abc",
  provider: "hetzner",
  providerId: "server-1",
  name: "my-vm",
  ip: "1.2.3.4",
  sshKeyPath: "/home/user/.ssh/id_ed25519",
  sshPort: 2223,
  sshUser: "samo",
  hostKeyFingerprint: "SHA256:aaabbbccc",
  region: "nbg1",
  type: "cx22",
  modules: [],
  lifecycleState: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const APP: AppRecord = {
  id: "app-abc",
  vmId: "vm-abc",
  name: "field-record",
  repo: "Tanya301/field-record-1",
  branch: "main",
  appDir: "/opt/field-record/app",
  buildCmd: "npm run build",
  healthUrl: "http://localhost:3000/api/version",
  serviceUnit: "field-record",
  mainHost: "field-record-1.samo.team",
};

// Real-shaped fixture from the CF custom hostnames API
const CH_PENDING: CustomHostname = {
  id: "ch-abc123",
  hostname: "myapp.com",
  status: "pending",
  ssl: {
    id: "ssl-xyz",
    status: "pending_validation",
    method: "http",
    validation_records: [
      {
        http_url: "http://myapp.com/.well-known/pki-validation/abc.txt",
        http_body: "dummytoken123",
      },
    ],
  },
  ownership_verification: {
    type: "txt",
    name: "_cf-custom-hostname.myapp.com",
    value: "ownership-token-abc",
  },
  verification_errors: [],
};

const CH_ACTIVE: CustomHostname = {
  id: "ch-abc123",
  hostname: "myapp.com",
  status: "active",
  ssl: {
    id: "ssl-xyz",
    status: "active",
    method: "http",
    validation_records: [],
  },
};

// Prod-shaped fixture for txt DCV (what CF returns when method=txt).
// dcv_delegation_records only appears when method=txt; the cname_target
// is the value the operator must set for _acme-challenge.<fqdn>.
const CH_PENDING_TXT: CustomHostname = {
  id: "ch-abc123",
  hostname: "myapp.com",
  status: "pending",
  ssl: {
    id: "ssl-xyz",
    status: "pending_validation",
    method: "txt",
    validation_records: [],
    dcv_delegation_records: [
      {
        cname: "_acme-challenge.myapp.com",
        cname_target: "abc123.dcv.cloudflare.com",
      },
    ],
  },
  ownership_verification: {
    type: "txt",
    name: "_cf-custom-hostname.myapp.com",
    value: "ownership-token-abc",
  },
  verification_errors: [],
};

function makeDeps(overrides: Partial<DomainDeps> = {}): DomainDeps {
  return {
    cf: undefined,
    remote: async (_vm, _script) => ({ code: 0, stdout: "ok", stderr: "" }),
    controlPlane: async (_script) => ({ code: 0, stdout: "ok", stderr: "" }),
    resolveCname: async (_fqdn) => ["cname.samo.team"],
    now: () => FIXED_NOW,
    uuid: () => FIXED_UUID,
    ...overrides,
  };
}

function makeStores() {
  const vmStore = new StateStore(statePath);
  vmStore.upsert(VM);
  const appStore = new AppStore(appsPath);
  appStore.upsert(APP);
  const domainStore = new DomainStore(domainsPath);
  return { vmStore, appStore, domainStore };
}

// Capture stdout/stderr
function makeOutput() {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const out = (s: string) => { outLines.push(s); };
  const err = (s: string) => { errLines.push(s); };
  return { outLines, errLines, out, err };
}

// ---------------------------------------------------------------------------
// runDomainAdd
// ---------------------------------------------------------------------------

describe("runDomainAdd", () => {
  test("adds a domain: creates CF hostname, persists DomainRecord, prints DNS instructions", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines, errLines, out, err } = makeOutput();

    // CF mock: create returns a pending custom hostname
    const cfMock = {
      createCustomHostname: async (hostname: string, _method?: "http" | "txt") => {
        expect(hostname).toBe("myapp.com");
        return CH_PENDING;
      },
      getCustomHostname: async (_id: string) => CH_PENDING,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (_id: string) => ({ id: "ch-abc123" }),
    };

    const input: DomainAddInput = {
      app: "field-record",
      fqdn: "myapp.com",
      dcv: "http",
    };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ cf: cfMock }),
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);

    // DomainRecord persisted
    const stored = domainStore.get("myapp.com");
    expect(stored).toBeDefined();
    expect(stored!.fqdn).toBe("myapp.com");
    expect(stored!.appName).toBe("field-record");
    expect(stored!.vmId).toBe("vm-abc");
    expect(stored!.customHostnameId).toBe("ch-abc123");
    expect(stored!.hostnameStatus).toBe("pending");
    expect(stored!.sslStatus).toBe("pending_validation");
    expect(stored!.createdAt).toBe(FIXED_NOW.toISOString());

    // DNS instructions printed
    const allOut = outLines.join("\n");
    expect(allOut).toContain("cname.samo.team");
    expect(allOut).toContain("myapp.com");
  });

  test("degrades gracefully when CF token is absent (cf: undefined)", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines, errLines, out, err } = makeOutput();

    const input: DomainAddInput = {
      app: "field-record",
      fqdn: "myapp.com",
      dcv: "http",
    };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ cf: undefined }),
      out,
      err,
    );

    expect(code).toBe(0);

    // Warn about missing token
    const allErr = errLines.join("\n");
    expect(allErr).toContain("CLOUDFLARE_SAMOTEAM");

    // Record still persisted (without CF ids)
    const stored = domainStore.get("myapp.com");
    expect(stored).toBeDefined();
    expect(stored!.customHostnameId).toBeUndefined();

    // DNS instructions still printed
    const allOut = outLines.join("\n");
    expect(allOut).toContain("cname.samo.team");
  });

  test("errors when app name is not found", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines: _out, errLines, out, err } = makeOutput();

    const input: DomainAddInput = {
      app: "nonexistent-app",
      fqdn: "myapp.com",
      dcv: "http",
    };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps(),
      out,
      err,
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("nonexistent-app");
  });

  test("errors when fqdn is invalid", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines: _out, errLines, out, err } = makeOutput();

    const input: DomainAddInput = {
      app: "field-record",
      fqdn: "not a domain!!",
      dcv: "http",
    };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps(),
      out,
      err,
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("invalid");
  });

  test("emits JSON report with --json flag", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines, errLines, out, err } = makeOutput();

    const cfMock = {
      createCustomHostname: async () => CH_PENDING,
      getCustomHostname: async (_id: string) => CH_PENDING,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (_id: string) => ({ id: "ch-abc123" }),
    };

    const input: DomainAddInput = {
      app: "field-record",
      fqdn: "myapp.com",
      dcv: "http",
    };
    const code = await runDomainAdd(
      input,
      { json: true },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ cf: cfMock }),
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);
    const report = JSON.parse(outLines.join(""));
    expect(report.fqdn).toBe("myapp.com");
    expect(report.appName).toBe("field-record");
    expect(report.customHostnameId).toBe("ch-abc123");
  });

  test("calls controlPlane runner with the control-plane Caddy routing snippet", async () => {
    // Root-cause fix: domain add must write a Caddy block on the CONTROL PLANE
    // (not just on the app VM) because CF-for-SaaS routes custom-hostname traffic
    // to the control-plane origin (cname.samo.team → 91.99.233.145), so the CP
    // Caddy must have a block routing <custom-domain> → <app VM ip:80>.
    const { vmStore, appStore, domainStore } = makeStores();
    const { out, err } = makeOutput();

    let cpScriptReceived: string | undefined;
    const controlPlane: ControlPlaneScriptRunner = async (script) => {
      cpScriptReceived = script;
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const input: DomainAddInput = { app: "field-record", fqdn: "myapp.com", dcv: "http" };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ controlPlane }),
      out,
      err,
    );

    expect(code).toBe(0);
    // controlPlane runner MUST have been called
    expect(cpScriptReceived).toBeDefined();
    // Script must route myapp.com on the control plane
    expect(cpScriptReceived).toContain("myapp.com");
    // Script must proxy to the app VM IP (1.2.3.4 from VM fixture)
    expect(cpScriptReceived).toContain("1.2.3.4");
    // Script must reload Caddy
    expect(cpScriptReceived).toContain("systemctl reload caddy");
    // Script must NOT use 'caddy validate' (hardened-VM NOPASSWD bug)
    expect(cpScriptReceived).not.toContain("caddy validate");
  });

  test("errors when controlPlane runner fails", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { errLines, out, err } = makeOutput();

    const controlPlane: ControlPlaneScriptRunner = async (_script) => ({
      code: 1,
      stdout: "",
      stderr: "permission denied",
    });

    const input: DomainAddInput = { app: "field-record", fqdn: "myapp.com", dcv: "http" };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ controlPlane }),
      out,
      err,
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("control-plane");
  });

  test("txt DCV: DNS instructions include ownership TXT and DCV delegation CNAME", async () => {
    // Root-cause fix for #114: when method=txt the CF response carries
    // dcv_delegation_records[].{cname, cname_target}.  The operator must set:
    //   1. Ownership TXT: _cf-custom-hostname.<fqdn> = <value>   (always present)
    //   2. DCV delegation CNAME: _acme-challenge.<fqdn> → <cname_target>  (txt only)
    //   3. Routing CNAME: <fqdn> → cname.samo.team
    // Without the delegation CNAME the cert never issues even with method=txt.
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines, errLines, out, err } = makeOutput();

    const cfMock = {
      createCustomHostname: async (_hostname: string, _method?: "http" | "txt") => CH_PENDING_TXT,
      getCustomHostname: async (_id: string) => CH_PENDING_TXT,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (_id: string) => ({ id: "ch-abc123" }),
    };

    const input: DomainAddInput = {
      app: "field-record",
      fqdn: "myapp.com",
      dcv: "txt",
    };
    const code = await runDomainAdd(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ cf: cfMock }),
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);

    const allOut = outLines.join("\n");

    // Ownership TXT record must be emitted
    expect(allOut).toContain("_cf-custom-hostname.myapp.com");
    expect(allOut).toContain("ownership-token-abc");

    // DCV delegation CNAME must be emitted (key new requirement for txt DCV)
    expect(allOut).toContain("_acme-challenge.myapp.com");
    expect(allOut).toContain("abc123.dcv.cloudflare.com");

    // Routing CNAME must still be emitted
    expect(allOut).toContain("cname.samo.team");
  });
});

// ---------------------------------------------------------------------------
// runDomainCheck
// ---------------------------------------------------------------------------

describe("runDomainCheck", () => {
  function seedDomain(domainStore: DomainStore, overrides: Partial<DomainRecord> = {}) {
    const rec: DomainRecord = {
      id: FIXED_UUID,
      fqdn: "myapp.com",
      appName: "field-record",
      vmId: "vm-abc",
      customHostnameId: "ch-abc123",
      hostnameStatus: "pending",
      sslStatus: "pending_validation",
      createdAt: FIXED_NOW.toISOString(),
      ...overrides,
    };
    domainStore.upsert(rec);
    return rec;
  }

  test("reports pending status when CF not yet active", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    seedDomain(domainStore);
    const { outLines, errLines, out, err } = makeOutput();

    const cfMock = {
      createCustomHostname: async () => CH_PENDING,
      getCustomHostname: async (_id: string) => CH_PENDING,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (_id: string) => ({ id: "ch-abc123" }),
    };

    const input: DomainCheckInput = { fqdn: "myapp.com" };
    const code = await runDomainCheck(
      input,
      { json: false },
      domainStore,
      makeDeps({ cf: cfMock }),
      out,
      err,
    );

    // Returns 1 when SSL is not yet active
    expect(code).toBe(1);
    const allOut = outLines.join("\n");
    expect(allOut).toContain("pending");
    expect(errLines).toHaveLength(0);

    // Status refreshed in store
    const updated = domainStore.get("myapp.com");
    expect(updated?.sslStatus).toBe("pending_validation");
    expect(updated?.hostnameStatus).toBe("pending");
  });

  test("returns exit 0 when both CF hostname and SSL are active", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    seedDomain(domainStore);
    const { outLines, errLines: _errLines, out, err } = makeOutput();

    const cfMock = {
      createCustomHostname: async () => CH_ACTIVE,
      getCustomHostname: async (_id: string) => CH_ACTIVE,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (_id: string) => ({ id: "ch-abc123" }),
    };

    const input: DomainCheckInput = { fqdn: "myapp.com" };
    const code = await runDomainCheck(
      input,
      { json: false },
      domainStore,
      makeDeps({
        cf: cfMock,
        resolveCname: async () => ["cname.samo.team"],
      }),
      out,
      err,
    );

    expect(code).toBe(0);
    const allOut = outLines.join("\n");
    expect(allOut).toContain("active");

    // Status refreshed
    const updated = domainStore.get("myapp.com");
    expect(updated?.sslStatus).toBe("active");
    expect(updated?.hostnameStatus).toBe("active");
  });

  test("errors when fqdn not in state", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    const { outLines: _out, errLines, out, err } = makeOutput();

    const input: DomainCheckInput = { fqdn: "unknown.com" };
    const code = await runDomainCheck(
      input,
      { json: false },
      domainStore,
      makeDeps(),
      out,
      err,
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("unknown.com");
  });
});

// ---------------------------------------------------------------------------
// runDomainList
// ---------------------------------------------------------------------------

describe("runDomainList", () => {
  test("lists all domains in text mode", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    const d1: DomainRecord = {
      id: "d1",
      fqdn: "app1.com",
      appName: "field-record",
      vmId: "vm-abc",
      customHostnameId: "ch-1",
      hostnameStatus: "active",
      sslStatus: "active",
      createdAt: FIXED_NOW.toISOString(),
    };
    const d2: DomainRecord = {
      id: "d2",
      fqdn: "app2.com",
      appName: "field-record",
      vmId: "vm-abc",
      hostnameStatus: "pending",
      sslStatus: "pending_validation",
      createdAt: FIXED_NOW.toISOString(),
    };
    domainStore.upsert(d1);
    domainStore.upsert(d2);

    const { outLines, errLines, out, err } = makeOutput();
    const input: DomainListInput = {};
    const code = await runDomainList(
      input,
      { json: false },
      domainStore,
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);
    const allOut = outLines.join("\n");
    expect(allOut).toContain("app1.com");
    expect(allOut).toContain("app2.com");
  });

  test("filters by --app", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    domainStore.upsert({
      id: "d1",
      fqdn: "app1.com",
      appName: "field-record",
      vmId: "vm-abc",
      createdAt: FIXED_NOW.toISOString(),
    });
    domainStore.upsert({
      id: "d2",
      fqdn: "shop.com",
      appName: "shop-app",
      vmId: "vm-abc",
      createdAt: FIXED_NOW.toISOString(),
    });

    const { outLines, errLines, out, err } = makeOutput();
    const input: DomainListInput = { app: "field-record" };
    const code = await runDomainList(
      input,
      { json: false },
      domainStore,
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);
    const allOut = outLines.join("\n");
    expect(allOut).toContain("app1.com");
    expect(allOut).not.toContain("shop.com");
  });

  test("emits JSON array with --json", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    domainStore.upsert({
      id: "d1",
      fqdn: "myapp.com",
      appName: "field-record",
      vmId: "vm-abc",
      createdAt: FIXED_NOW.toISOString(),
    });

    const { outLines, errLines, out, err } = makeOutput();
    const input: DomainListInput = {};
    const code = await runDomainList(
      input,
      { json: true },
      domainStore,
      out,
      err,
    );

    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);
    const arr = JSON.parse(outLines.join("")) as DomainRecord[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]!.fqdn).toBe("myapp.com");
  });

  test("empty list prints nothing and exits 0", async () => {
    const { vmStore: _vm, appStore: _app, domainStore } = makeStores();
    const { outLines, errLines, out, err } = makeOutput();
    const code = await runDomainList(
      {},
      { json: false },
      domainStore,
      out,
      err,
    );
    expect(code).toBe(0);
    expect(errLines).toHaveLength(0);
    expect(outLines.join("").trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runDomainRm
// ---------------------------------------------------------------------------

describe("runDomainRm", () => {
  function seedDomain(domainStore: DomainStore) {
    const rec: DomainRecord = {
      id: FIXED_UUID,
      fqdn: "myapp.com",
      appName: "field-record",
      vmId: "vm-abc",
      customHostnameId: "ch-abc123",
      hostnameStatus: "active",
      sslStatus: "active",
      createdAt: FIXED_NOW.toISOString(),
    };
    domainStore.upsert(rec);
  }

  test("removes domain: deletes CF hostname, pushes vhost-remove script, removes record", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    seedDomain(domainStore);
    const { outLines, errLines, out, err } = makeOutput();

    let cfDeleteCalled = false;
    let remoteCalled = false;

    const cfMock = {
      createCustomHostname: async () => CH_ACTIVE,
      getCustomHostname: async (_id: string) => CH_ACTIVE,
      listCustomHostnames: async () => [] as CustomHostname[],
      deleteCustomHostname: async (id: string) => {
        cfDeleteCalled = true;
        expect(id).toBe("ch-abc123");
        return { id };
      },
    };

    const input: DomainRmInput = { fqdn: "myapp.com", yes: true };
    const code = await runDomainRm(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({
        cf: cfMock,
        remote: async (_vm, _script) => {
          remoteCalled = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
      out,
      err,
    );

    expect(code).toBe(0);
    expect(cfDeleteCalled).toBe(true);
    expect(remoteCalled).toBe(true);
    expect(errLines).toHaveLength(0);
    expect(outLines.join("\n")).toContain("myapp.com");

    // Record removed from store
    expect(domainStore.get("myapp.com")).toBeUndefined();
  });

  test("calls controlPlane runner to remove the control-plane routing snippet on rm", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    seedDomain(domainStore);
    const { out, err } = makeOutput();

    let cpRemoveScriptReceived: string | undefined;
    const controlPlane: ControlPlaneScriptRunner = async (script) => {
      cpRemoveScriptReceived = script;
      return { code: 0, stdout: "ok", stderr: "" };
    };

    const input: DomainRmInput = { fqdn: "myapp.com", yes: true };
    const code = await runDomainRm(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ controlPlane }),
      out,
      err,
    );

    expect(code).toBe(0);
    // controlPlane runner MUST have been called for removal
    expect(cpRemoveScriptReceived).toBeDefined();
    expect(cpRemoveScriptReceived).toContain("myapp.com");
    expect(cpRemoveScriptReceived).toContain("systemctl reload caddy");
    // State removed
    expect(domainStore.get("myapp.com")).toBeUndefined();
  });

  test("degrades gracefully when CF is absent (no delete call)", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    seedDomain(domainStore);
    const { outLines, errLines, out, err } = makeOutput();

    const input: DomainRmInput = { fqdn: "myapp.com", yes: true };
    const code = await runDomainRm(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps({ cf: undefined }),
      out,
      err,
    );

    expect(code).toBe(0);
    // Record still removed
    expect(domainStore.get("myapp.com")).toBeUndefined();
    // Warn about missing CF
    expect(errLines.join("\n")).toContain("CLOUDFLARE_SAMOTEAM");
    expect(outLines.join("\n")).toContain("myapp.com");
  });

  test("errors when fqdn not in state", async () => {
    const { vmStore, appStore, domainStore } = makeStores();
    const { outLines: _out, errLines, out, err } = makeOutput();

    const input: DomainRmInput = { fqdn: "notexist.com", yes: true };
    const code = await runDomainRm(
      input,
      { json: false },
      vmStore,
      appStore,
      domainStore,
      makeDeps(),
      out,
      err,
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("notexist.com");
  });
});
