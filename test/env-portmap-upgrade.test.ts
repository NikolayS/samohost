import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnvCreate, runEnvPlan, type EnvExecDeps } from "../src/commands/env.ts";
import { DEFAULT_POOL } from "../src/env/ports.ts";
import { buildEnvCreateScript, targetFromRecord } from "../src/env/script.ts";
import { StateStore } from "../src/state/store.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import type { AppRecord, EnvRecord, VmRecord } from "../src/types.ts";

const app: AppRecord = {
  id: "app", vmId: "vm", name: "example", repo: "example/app", branch: "main",
  appDir: "/opt/example/app", buildCmd: "true", healthUrl: "http://localhost:3000/",
  serviceUnit: "example-web", databaseUrlEnv: "DATABASE_URL", defaultListener: "web",
  services: [
    { name: "web", unit: "example-web", execStart: "/opt/example/start-web",
      listeners: [
        { name: "web", port: 3000, portEnv: "WEB_PORT", healthPath: "/" },
        { name: "api", port: 3001, portEnv: "API_PORT", healthPath: "/health" },
      ] },
    { name: "hub", unit: "example-hub", execStart: "/opt/example/start-hub",
      listeners: [{ name: "hub", port: 3002, portEnv: "HUB_PORT", healthPath: "/health" }] },
  ],
};
const existing: EnvRecord = {
  id: "existing", vmId: "vm", appName: "example", name: "example-feature", branch: "feature",
  port: 3120, vhost: "example-feature.samo.cat", dbBackend: "dblab", dbName: "existing-clone",
  createdAt: "2026-01-01T00:00:00.000Z", lastDeployedSha: "old-sha",
};
const input = { vm: "vm", app: "example", branch: "feature", db: "dblab" as const, previewDomain: "samo.cat" };
const ok = ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]
  .flatMap(p => [`<<<SAMOHOST_PHASE:${p}:start>>>`, `<<<SAMOHOST_PHASE:${p}:ok>>>`]).join("\n");

describe("recreating previews whose recorded listener map is incomplete", () => {
  let dir: string, vms: StateStore, apps: AppStore, envs: EnvStore;
  let scripts: string[], errors: string[], probes: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-portmap-"));
    vms = new StateStore(join(dir, "vms.json")); apps = new AppStore(join(dir, "apps.json"));
    envs = new EnvStore(join(dir, "envs.json"));
    vms.upsert({ id: "vm", name: "vm", lifecycleState: "adopted" } as VmRecord);
    apps.upsert(app); envs.upsert(existing); scripts = []; errors = []; probes = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function deps(ports: readonly number[] = [], output = ok): EnvExecDeps {
    return {
      remote: async (_vm, script) => { scripts.push(script); return { code: 0, stdout: output, stderr: "" }; },
      now: () => new Date("2026-01-02T00:00:00.000Z"), uuid: () => "unexpected-new-id",
      inUsePorts: async () => { probes++; return ports; },
    };
  }
  const create = (d: EnvExecDeps) => runEnvCreate(input, { json: true }, vms, apps, envs, d, () => {}, s => errors.push(s));

  test("completes a scalar record without moving its primary port or colliding with stored/live ports", async () => {
    envs.upsert({ ...existing, id: "other", name: "example-other", branch: "other", port: 3100, ports: { web: 3100, api: 3101 } });
    expect(await create(deps([3102, 3120]))).toBe(0);
    const record = envs.get("vm", "example", "feature")!;
    expect(record.ports).toEqual({ web: 3120, api: 3103, hub: 3104 });
    expect(record.id).toBe(existing.id); expect(record.port).toBe(3120);
    expect(record.dbName).toBe("existing-clone"); expect(record.createdAt).toBe(existing.createdAt);
    expect(probes).toBe(1);
    expect(scripts[0]).toContain("WEB_PORT=3120");
    expect(scripts[0]).toContain("API_PORT=3103"); expect(scripts[0]).toContain("HUB_PORT=3104");
  });

  test("preserves existing partial assignments while allocating only the missing listener", async () => {
    envs.upsert({ ...existing, ports: { web: 3120, api: 3125 } });
    expect(await create(deps([3120, 3125]))).toBe(0);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual({ web: 3120, api: 3125, hub: 3100 });
  });

  test("anchors the primary port to the declared default listener, even when it is not first", async () => {
    apps.upsert({ ...app, defaultListener: "api" });
    expect(await create(deps())).toBe(0);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual({ api: 3120, web: 3100, hub: 3101 });
  });

  test("a valid listener named constructor gets an owned numeric assignment", async () => {
    const topology = structuredClone(app);
    topology.services![0]!.listeners[1]!.name = "constructor";
    apps.upsert(topology);
    expect(await create(deps())).toBe(0);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual({ web: 3120, constructor: 3100, hub: 3101 });
  });

  test("a complete map keeps every port and does not need a new allocation probe", async () => {
    const ports = { web: 3120, api: 3121, hub: 3122 }; envs.upsert({ ...existing, ports });
    const d = deps(); d.inUsePorts = async () => { throw new Error("must not probe"); };
    expect(await create(d)).toBe(0);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual(ports);
  });

  test("failed creation pins the completed map for a retry and clears the deployed SHA", async () => {
    expect(await create(deps([], "<<<SAMOHOST_PHASE:db:failed>>>"))).toBe(1);
    const failed = envs.get("vm", "example", "feature")!;
    expect(failed.ports).toEqual({ web: 3120, api: 3100, hub: 3101 });
    expect(failed.lastDeployedSha).toBeUndefined();
    const d = deps(); d.inUsePorts = async () => { throw new Error("must reuse pinned map"); };
    expect(await create(d)).toBe(0);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual(failed.ports);
  });

  test("probe failure leaves the old record unchanged and sends no script", async () => {
    const d = deps(); d.inUsePorts = async () => { throw new Error("probe unavailable"); };
    expect(await create(d)).toBe(1);
    expect(errors.join(" ")).toContain("could not probe");
    expect(scripts).toEqual([]); expect(envs.get("vm", "example", "feature")).toEqual(existing);
  });

  test("pool exhaustion leaves the old record unchanged and sends no script", async () => {
    const occupied = Array.from({ length: DEFAULT_POOL.size }, (_, i) => DEFAULT_POOL.base + i);
    expect(await create(deps(occupied))).toBe(1);
    expect(errors.join(" ")).toContain("port pool exhausted");
    expect(scripts).toEqual([]); expect(envs.get("vm", "example", "feature")).toEqual(existing);
  });

  test("a recorded collision with another environment is not silently reassigned", async () => {
    envs.upsert({ ...existing, id: "other", name: "example-other", branch: "other", port: 3120 });
    expect(await create(deps())).toBe(1);
    expect(errors.join(" ")).toContain("conflicts with another recorded environment");
    expect(scripts).toEqual([]); expect(envs.get("vm", "example", "feature")).toEqual(existing);
  });

  test.each([
    { web: 3120, api: 3120, hub: 3122 },
    { web: 3121, api: 3122, hub: 3123 },
    { web: 3120, api: 0, hub: 3122 },
  ])("invalid recorded assignments fail without changing the record: %j", async ports => {
    envs.upsert({ ...existing, ports });
    expect(await create(deps())).toBe(1);
    expect(errors.join(" ")).toMatch(/port/i); expect(scripts).toEqual([]);
    expect(envs.get("vm", "example", "feature")!.ports).toEqual(ports);
  });

  test("offline create planning completes the map without writing state", () => {
    let script = "";
    expect(runEnvPlan({ ...input, hostPrep: false, destroy: false }, { json: false }, vms, apps, envs,
      s => script = s, s => errors.push(s))).toBe(0);
    expect(script).toContain("WEB_PORT=3120");
    expect(script).toContain("API_PORT=3100"); expect(script).toContain("HUB_PORT=3101");
    expect(envs.get("vm", "example", "feature")).toEqual(existing);
  });

  const invalidRenderMaps: (Record<string, number> | undefined)[] = [
    undefined, { web: 3120 }, { web: 3120, api: 3120, hub: 3122 },
  ];
  test.each(invalidRenderMaps)(
    "the script renderer rejects missing or colliding listener assignments: %j", ports => {
      expect(() => buildEnvCreateScript(app, targetFromRecord({ ...existing, ports }))).toThrow(/listener.*port/i);
    },
  );
});
