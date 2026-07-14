import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../src/state/apps.ts";
import type { AppRecord } from "../src/types.ts";

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1",
    name: "site",
    repo: "example/site",
    branch: "main",
    appDir: "/opt/site/app",
    buildCmd: "npm run build",
    serviceUnit: "site",
    healthUrl: "http://127.0.0.1:3000/health",
    ...overrides,
  };
}

type CasStore = AppStore & {
  compareAndSwap(expected: AppRecord, replacement: AppRecord): AppRecord;
};

describe("AppStore lock/CAS", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("compareAndSwap writes only when the complete AppRecord is unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "samohost-app-cas-"));
    const store = new AppStore(join(dir, "apps.json"));
    store.upsert(app({ deployedSha: "old" }));
    const expected = store.get("vm-1", "site")!;

    const concurrent = store.upsert({
      ...expected,
      deployedSha: "concurrent-sha",
      releaseTagCursor: "v20260714.2",
      mainHost: "new-site.example.com",
    });

    expect(() => (store as CasStore).compareAndSwap(expected, {
      ...expected,
      deployedSha: "stale-route-sha",
      mainHost: "stale-site.example.com",
    })).toThrow(/changed concurrently/);
    expect(store.get("vm-1", "site")).toEqual(concurrent);

    const saved = (store as CasStore).compareAndSwap(concurrent, {
      ...concurrent,
      lastDeployAt: "2026-07-14T12:00:00.000Z",
    });
    expect(saved.lastDeployAt).toBe("2026-07-14T12:00:00.000Z");
  });

  test("all mutations fail closed while a live local writer owns the lock", () => {
    dir = mkdtempSync(join(tmpdir(), "samohost-app-lock-"));
    const path = join(dir, "apps.json");
    const store = new AppStore(path);
    store.upsert(app());
    writeFileSync(`${path}.lock`, JSON.stringify({
      pid: process.pid,
      token: "another-live-writer",
    }));

    expect(() => store.upsert({ ...app(), deployedSha: "must-not-land" }))
      .toThrow(/locked by live process/);
    expect(store.get("vm-1", "site")?.deployedSha).toBeUndefined();
  });

  test("a lock abandoned by a crashed process is recovered before the atomic write", () => {
    dir = mkdtempSync(join(tmpdir(), "samohost-app-stale-lock-"));
    const path = join(dir, "apps.json");
    const store = new AppStore(path);
    writeFileSync(`${path}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      token: "crashed-writer",
    }));

    store.upsert(app({ deployedSha: "safe" }));

    expect(store.get("vm-1", "site")?.deployedSha).toBe("safe");
    expect(() => readFileSync(`${path}.lock`, "utf8")).toThrow();
  });
});
