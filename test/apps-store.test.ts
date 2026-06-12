import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../src/state/apps.ts";
import type { AppRecord } from "../src/types.ts";

let dir: string;
let appsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samohost-apps-"));
  appsPath = join(dir, "apps.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function app(
  vmId: string,
  name: string,
  overrides: Partial<AppRecord> = {},
): AppRecord {
  return {
    id: `app-${vmId}-${name}`,
    vmId,
    name,
    repo: "owner/repo",
    branch: "main",
    appDir: `/opt/${name}/app`,
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: name,
    ...overrides,
  };
}

describe("AppStore", () => {
  test("upsert then get by (vmId, name)", () => {
    const store = new AppStore(appsPath);
    store.upsert(app("vm-a", "field-record"));
    expect(existsSync(appsPath)).toBe(true);

    const reread = new AppStore(appsPath);
    const got = reread.get("vm-a", "field-record");
    expect(got?.id).toBe("app-vm-a-field-record");
    expect(reread.get("vm-a", "other")).toBeUndefined();
    expect(reread.get("vm-b", "field-record")).toBeUndefined();
  });

  test("same app name on different VMs are distinct records", () => {
    const store = new AppStore(appsPath);
    store.upsert(app("vm-a", "field-record", { deployedSha: "aaa" }));
    store.upsert(app("vm-b", "field-record", { deployedSha: "bbb" }));
    expect(store.list().length).toBe(2);
    expect(store.get("vm-a", "field-record")?.deployedSha).toBe("aaa");
    expect(store.get("vm-b", "field-record")?.deployedSha).toBe("bbb");
  });

  test("upsert replaces by (vmId, name) preserving id", () => {
    const store = new AppStore(appsPath);
    const first = store.upsert(app("vm-a", "fr", { deployedSha: "old" }));
    const second = store.upsert(
      app("vm-a", "fr", { id: "DIFFERENT-ID", deployedSha: "new" }),
    );
    expect(store.list().length).toBe(1);
    // id of the existing record is preserved, not overwritten.
    expect(second.id).toBe(first.id);
    expect(store.get("vm-a", "fr")?.deployedSha).toBe("new");
  });

  test("remove by (vmId, name)", () => {
    const store = new AppStore(appsPath);
    store.upsert(app("vm-a", "fr"));
    expect(store.remove("vm-a", "fr")).toBe(true);
    expect(store.remove("vm-a", "fr")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("crash-safe: keeps a .bak and recovers from corrupt primary", () => {
    const store = new AppStore(appsPath);
    store.upsert(app("vm-a", "one"));
    store.upsert(app("vm-a", "two")); // second write → bak of one-record version
    expect(existsSync(`${appsPath}.bak`)).toBe(true);

    writeFileSync(appsPath, "{ not json", "utf8");
    const recovered = new AppStore(appsPath);
    expect(recovered.list().map((a) => a.name)).toEqual(["one"]);
  });

  test("empty store lists nothing; no tmp leftover after write", () => {
    const store = new AppStore(appsPath);
    expect(store.list()).toEqual([]);
    store.upsert(app("vm-a", "fr"));
    expect(existsSync(`${appsPath}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(appsPath, "utf8"));
    expect(parsed.apps.length).toBe(1);
  });
});
