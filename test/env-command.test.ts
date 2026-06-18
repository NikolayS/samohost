import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import {
  deriveTarget,
  runEnvPlan,
  runEnvCreate,
  runEnvList,
  runEnvDestroy,
  type EnvExecDeps,
} from "../src/commands/env.ts";
import { DEFAULT_POOL } from "../src/env/ports.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-1111",
    provider: "hetzner",
    providerId: "137236481",
    name: "samo-we-field-record",
    ip: "178.105.246.151",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "agent",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function appRec(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1111",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
const CREATE_OK = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");
const DESTROY_OK = ["unit-stop", "vhost-remove", "db-drop", "dir-remove"]
  .flatMap((p) => [M(p, "start"), M(p, "ok")])
  .join("\n");

function fakeDeps(output: string, capture?: string[]): EnvExecDeps {
  let n = 0;
  return {
    remote: (_vm, script) => {
      capture?.push(script);
      return Promise.resolve({ code: 0, stdout: output, stderr: "" });
    },
    now: () => new Date("2026-06-11T12:00:00.000Z"),
    uuid: () => `uuid-${++n}`,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseArgs env", () => {
  test("plan with branch and db backend", () => {
    const cmd = parseArgs([
      "env", "plan", "samo-we-field-record", "field-record-1",
      "--branch", "feat/x", "--db", "template",
    ]);
    if (cmd.kind !== "env-plan") throw new Error("expected env-plan");
    expect(cmd.input.branch).toBe("feat/x");
    expect(cmd.input.db).toBe("template");
    expect(cmd.input.previewDomain).toBe("samo.cat"); // #117 default
    expect(cmd.input.hostPrep).toBe(false);
  });

  test("plan --host-prep needs no branch; bare plan does", () => {
    const cmd = parseArgs(["env", "plan", "vm", "app", "--host-prep"]);
    if (cmd.kind !== "env-plan") throw new Error("expected env-plan");
    expect(cmd.input.hostPrep).toBe(true);
    expect(() => parseArgs(["env", "plan", "vm", "app"])).toThrow(/--branch/);
  });

  test("create defaults to dblab; rejects bad --db", () => {
    const cmd = parseArgs(["env", "create", "vm", "app", "--branch", "b"]);
    if (cmd.kind !== "env-create") throw new Error("expected env-create");
    expect(cmd.input.db).toBe("dblab");
    expect(() =>
      parseArgs(["env", "create", "vm", "app", "--branch", "b", "--db", "wat"]),
    ).toThrow(/invalid --db/);
  });

  test("list takes <vm> and optional --app", () => {
    const cmd = parseArgs(["env", "list", "vm", "--app", "field-record-1", "--json"]);
    if (cmd.kind !== "env-list") throw new Error("expected env-list");
    expect(cmd.input).toEqual({ vm: "vm", app: "field-record-1" });
    expect(cmd.json).toBe(true);
  });

  test("destroy requires --branch", () => {
    expect(() => parseArgs(["env", "destroy", "vm", "app"])).toThrow(/--branch/);
  });

  test("unknown subcommand throws", () => {
    expect(() => parseArgs(["env", "wat"])).toThrow(/unknown env subcommand/);
    expect(() => parseArgs(["env"])).toThrow(/requires a subcommand/);
  });

  test("create and plan parse --template-db (#11 finding 6)", () => {
    const c = parseArgs([
      "env", "create", "vm", "app", "--branch", "b",
      "--db", "template", "--template-db", "my_tpl",
    ]);
    if (c.kind !== "env-create") throw new Error("expected env-create");
    expect(c.input.templateDb).toBe("my_tpl");

    const p = parseArgs([
      "env", "plan", "vm", "app", "--branch", "b",
      "--db", "template", "--template-db", "my_tpl",
    ]);
    if (p.kind !== "env-plan") throw new Error("expected env-plan");
    expect(p.input.templateDb).toBe("my_tpl");
  });
});

// ---------------------------------------------------------------------------
// deriveTarget
// ---------------------------------------------------------------------------

describe("deriveTarget", () => {
  test("issue #117 shape: field-record-1-feat-x.samo.cat on the first free port", () => {
    const t = deriveTarget(appRec(), "feat/x", "dblab", "samo.cat", []);
    if ("error" in t) throw new Error(t.error);
    expect(t.name).toBe("field-record-1-feat-x");
    expect(t.vhost).toBe("field-record-1-feat-x.samo.cat");
    expect(t.port).toBe(3100);
    expect(t.dbName).toBe("field-record-1-feat-x");
  });

  test("template backend db name is underscored", () => {
    const t = deriveTarget(appRec(), "feat/x", "template", "samo.cat", []);
    if ("error" in t) throw new Error(t.error);
    expect(t.dbName).toBe("field_record_1_feat_x");
  });

  test("ports skip those used by existing envs", () => {
    const existing = [
      { port: 3100 }, { port: 3101 },
    ] as never[];
    const t = deriveTarget(appRec(), "feat/y", "none", "samo.cat", existing);
    if ("error" in t) throw new Error(t.error);
    expect(t.port).toBe(3102);
  });

  test("--template-db flows into the target (#11 finding 6)", () => {
    const t = deriveTarget(
      appRec(), "feat/x", "template", "samo.cat", [], DEFAULT_POOL, "my_tpl",
    );
    if ("error" in t) throw new Error(t.error);
    expect(t.templateDb).toBe("my_tpl");
    // Absent flag keeps the convention default (templateDb unset → script derives).
    const d = deriveTarget(appRec(), "feat/x", "template", "samo.cat", []);
    if ("error" in d) throw new Error(d.error);
    expect(d.templateDb).toBeUndefined();
  });

  // Regression: a JS caller (e.g. an ad-hoc driver reading a nonexistent
  // `app.previewDomain` field) once passed the value `undefined` straight
  // through, rendering the literal vhost `field-record-main.undefined` into a
  // live Caddy snippet (field-record-1#117, *.samo.cat → HTTP 525). deriveTarget
  // must NEVER emit a vhost containing an invalid preview domain — it fails
  // closed with an error instead.
  test("rejects an undefined preview domain (never emits .undefined vhost)", () => {
    // Simulate the JS-side `undefined` that bypasses the TS string type.
    const t = deriveTarget(
      appRec(), "main", "dblab", undefined as unknown as string, [],
    );
    expect("error" in t).toBe(true);
    if ("error" in t) expect(t.error).toMatch(/preview domain/i);
  });

  test("rejects an empty / malformed preview domain", () => {
    for (const bad of ["", "undefined", "no-dot", "-bad.samo.cat", ".samo.cat"]) {
      const t = deriveTarget(appRec(), "main", "dblab", bad, []);
      expect("error" in t).toBe(true);
    }
  });

  test("accepts a well-formed preview domain", () => {
    const t = deriveTarget(appRec(), "main", "dblab", "samo.cat", []);
    if ("error" in t) throw new Error(t.error);
    expect(t.vhost).toBe("field-record-1-main.samo.cat");
    expect(t.vhost).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Commands (offline, temp stores, fake remote)
// ---------------------------------------------------------------------------

describe("env commands", () => {
  let dir: string;
  let vmStore: StateStore;
  let appStore: AppStore;
  let envStore: EnvStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-env-"));
    vmStore = new StateStore(join(dir, "state.json"));
    appStore = new AppStore(join(dir, "apps.json"));
    envStore = new EnvStore(join(dir, "envs.json"));
    vmStore.upsert(vm());
    appStore.upsert(appRec());
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("plan prints the create script offline (no remote, no state writes)", () => {
    const c = capture();
    const code = runEnvPlan(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat", destroy: false, hostPrep: false },
      { json: false }, vmStore, appStore, envStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("field-record-1-feat-x.samo.cat");
    expect(c.o).toContain("dblab clone create");
    expect(envStore.list()).toEqual([]); // plan never writes state
  });

  test("plan --destroy and --host-prep print the other scripts", () => {
    const base = { vm: "samo-we-field-record", app: "field-record-1",
      db: "dblab" as const, previewDomain: "samo.cat" };
    const c1 = capture();
    runEnvPlan({ ...base, branch: "feat/x", destroy: true, hostPrep: false },
      { json: false }, vmStore, appStore, envStore, c1.out, c1.err);
    expect(c1.o).toContain("env-destroy script");

    const c2 = capture();
    runEnvPlan({ ...base, destroy: false, hostPrep: true },
      { json: false }, vmStore, appStore, envStore, c2.out, c2.err);
    expect(c2.o).toContain("host-prep");
    expect(c2.o).toContain("sudoers");
  });

  test("create records the env on success and reports the vhost", async () => {
    const scripts: string[] = [];
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(CREATE_OK, scripts), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("git clone");
    const rec = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(rec?.name).toBe("field-record-1-feat-x");
    expect(rec?.port).toBe(3100);
    expect(rec?.vhost).toBe("field-record-1-feat-x.samo.cat");
    expect(c.o).toContain("https://field-record-1-feat-x.samo.cat");
  });

  test("create failure still records the env (pinned name/port) and exits 1", async () => {
    const failOut = [M("clone", "start"), M("clone", "ok"), M("build", "start"), M("build", "fail")].join("\n");
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(failOut), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(envStore.get("vm-1111", "field-record-1", "feat/x")).toBeDefined();
    expect(c.e).toContain("re-run create");
  });

  test("re-create after failure reuses the recorded name/port (idempotent)", async () => {
    const failOut = [M("clone", "start"), M("clone", "fail")].join("\n");
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, fakeDeps(failOut),
      capture().out, capture().err,
    );
    const first = envStore.get("vm-1111", "field-record-1", "feat/x");
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: true }, vmStore, appStore, envStore, fakeDeps(CREATE_OK),
      c.out, c.err,
    );
    expect(code).toBe(0);
    const second = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(second?.id).toBe(first!.id);
    expect(second?.port).toBe(first!.port);
    expect(second?.name).toBe(first!.name);
  });

  test("create with --template-db persists it and pins it into the script (#11)", async () => {
    const scripts: string[] = [];
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "template", previewDomain: "samo.cat", templateDb: "my_tpl" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(CREATE_OK, scripts), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(scripts[0]).toContain("SAMOHOST_TEMPLATE_DB='my_tpl'");
    const rec = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(rec?.templateDb).toBe("my_tpl");
    // Re-create (and destroy) reuse the PERSISTED template db, not the flag.
    const scripts2: string[] = [];
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "template", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(CREATE_OK, scripts2), capture().out, capture().err,
    );
    expect(scripts2[0]).toContain("SAMOHOST_TEMPLATE_DB='my_tpl'");
  });

  test("second branch gets the next port; list shows both", async () => {
    for (const b of ["feat/x", "feat/y"]) {
      await runEnvCreate(
        { vm: "samo-we-field-record", app: "field-record-1", branch: b,
          db: "dblab", previewDomain: "samo.cat" },
        { json: false }, vmStore, appStore, envStore, fakeDeps(CREATE_OK),
        capture().out, capture().err,
      );
    }
    expect(envStore.get("vm-1111", "field-record-1", "feat/y")?.port).toBe(3101);

    const c = capture();
    const code = runEnvList(
      { vm: "samo-we-field-record" }, { json: false }, vmStore, envStore, c.out, c.err,
    );
    expect(code).toBe(0);
    expect(c.o).toContain("feat/x");
    expect(c.o).toContain("feat/y");
    expect(c.o).toContain("3101");
  });

  // -------------------------------------------------------------------------
  // Live-bound port skip (squatter robustness — complement to #71's fail-closed)
  //
  // Root context: a CI runner's Playwright e2e server permanently binds
  // 0.0.0.0:3100 (INSIDE the 3100-3199 preview pool) on the shared
  // field-record VM. allocatePort sees only STORE-recorded ports, so it would
  // hand out 3100, the preview unit dies with EADDRINUSE, and #71 fails it
  // CLOSED (URL goes dark). The reliability complement: probe the host's live
  // listeners and allocate the lowest pool port that is neither store-recorded
  // NOR live-bound — so the preview just lands on the next free port (3101).
  // -------------------------------------------------------------------------
  function fakeDepsWithProbe(
    output: string,
    inUse: readonly number[],
    scripts?: string[],
  ): EnvExecDeps {
    let n = 0;
    return {
      remote: (_vm, script) => {
        scripts?.push(script);
        return Promise.resolve({ code: 0, stdout: output, stderr: "" });
      },
      now: () => new Date("2026-06-11T12:00:00.000Z"),
      uuid: () => `uuid-${++n}`,
      // Live in-use ports on the target VM (parsed from `ss -ltnH`).
      inUsePorts: () => Promise.resolve(inUse),
    };
  }

  test("create skips a live-bound (squatted) pool port and picks the next free one", async () => {
    const scripts: string[] = [];
    const c = capture();
    // 3100 is store-FREE but held by a CI runner's e2e server on the host.
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, [3100], scripts), c.out, c.err,
    );
    expect(code).toBe(0);
    const rec = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(rec?.port).toBe(3101); // skipped the squatter at 3100
    // The generated create script must target the FREE port, not 3100.
    expect(scripts[0]).toContain("3101");
    expect(scripts[0]).not.toMatch(/SAMOHOST_PORT='?3100'?/);
  });

  test("create allocates 3100 when the host has no squatter (probe returns [])", async () => {
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, []), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/x")?.port).toBe(3100);
  });

  test("re-create keeps its OWN recorded port even if that port is live-bound (idempotent)", async () => {
    // First create lands on 3100 (no squatter).
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, []), capture().out, capture().err,
    );
    const first = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(first?.port).toBe(3100);

    // Re-create: 3100 now shows as live-bound (it's OUR OWN running unit).
    // The env must REUSE its recorded port, not flee to 3101.
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, [3100]), c.out, c.err,
    );
    expect(code).toBe(0);
    const second = envStore.get("vm-1111", "field-record-1", "feat/x");
    expect(second?.id).toBe(first!.id);
    expect(second?.port).toBe(3100);
  });

  test("pool exhaustion (store + live-bound together fill the pool) errors clearly", async () => {
    // Record one env at 3100, then claim every OTHER pool port as live-bound.
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, []), capture().out, capture().err,
    );
    const liveRest = Array.from(
      { length: DEFAULT_POOL.size - 1 },
      (_, i) => DEFAULT_POOL.base + 1 + i,
    ); // 3101..3199
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/z",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDepsWithProbe(CREATE_OK, liveRest), c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toMatch(/port pool exhausted/i);
  });

  test("create still succeeds when no inUsePorts probe is wired (back-compat)", async () => {
    // Existing fixtures build deps WITHOUT inUsePorts; behaviour is unchanged.
    const c = capture();
    const code = await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(CREATE_OK), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/x")?.port).toBe(3100);
  });

  test("destroy removes the record on success, keeps it on failure", async () => {
    await runEnvCreate(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x",
        db: "dblab", previewDomain: "samo.cat" },
      { json: false }, vmStore, appStore, envStore, fakeDeps(CREATE_OK),
      capture().out, capture().err,
    );

    // Failed destroy (dropped connection): record kept.
    const cFail = capture();
    let code = await runEnvDestroy(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(M("unit-stop", "start")), cFail.out, cFail.err,
    );
    expect(code).toBe(1);
    expect(envStore.get("vm-1111", "field-record-1", "feat/x")).toBeDefined();

    // Successful destroy: record removed.
    const c = capture();
    code = await runEnvDestroy(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "feat/x" },
      { json: false }, vmStore, appStore, envStore,
      fakeDeps(DESTROY_OK), c.out, c.err,
    );
    expect(code).toBe(0);
    expect(envStore.get("vm-1111", "field-record-1", "feat/x")).toBeUndefined();
  });

  test("destroy of an unrecorded env fails cleanly", async () => {
    const c = capture();
    const code = await runEnvDestroy(
      { vm: "samo-we-field-record", app: "field-record-1", branch: "nope" },
      { json: false }, vmStore, appStore, envStore, fakeDeps(DESTROY_OK),
      c.out, c.err,
    );
    expect(code).toBe(1);
    expect(c.e).toContain("no env recorded");
  });

  test("unknown vm/app fail cleanly", () => {
    const c = capture();
    expect(
      runEnvList({ vm: "nope" }, { json: false }, vmStore, envStore, c.out, c.err),
    ).toBe(1);
    const c2 = capture();
    expect(
      runEnvPlan(
        { vm: "samo-we-field-record", app: "nope", branch: "b", db: "none",
          previewDomain: "samo.cat", destroy: false, hostPrep: false },
        { json: false }, vmStore, appStore, envStore, c2.out, c2.err,
      ),
    ).toBe(1);
    expect(c2.e).toContain("app not found");
  });
});
