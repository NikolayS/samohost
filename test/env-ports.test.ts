import { describe, expect, test } from "bun:test";
import { allocatePort, DEFAULT_POOL } from "../src/env/ports.ts";

describe("allocatePort", () => {
  test("empty pool usage returns the base port", () => {
    expect(allocatePort([])).toBe(DEFAULT_POOL.base);
  });

  test("lowest free port wins (deterministic)", () => {
    const b = DEFAULT_POOL.base;
    expect(allocatePort([b, b + 1, b + 3])).toBe(b + 2);
  });

  test("ports outside the pool are ignored", () => {
    expect(allocatePort([3000, 80, 443])).toBe(DEFAULT_POOL.base);
  });

  test("CI port 3100 is never handed out (reserved for the shared runner)", () => {
    // Allocate every port in the pool; 3100 (the Playwright CI webServer port
    // on the shared self-hosted runner) must never appear.
    const handed = new Set<number>();
    const used: number[] = [];
    for (let i = 0; i < DEFAULT_POOL.size + 1; i++) {
      const p = allocatePort(used);
      if (p === undefined) break;
      handed.add(p);
      used.push(p);
    }
    expect(handed.has(3100)).toBe(false);
  });

  test("exhausted pool returns undefined", () => {
    const all = Array.from(
      { length: DEFAULT_POOL.size },
      (_, i) => DEFAULT_POOL.base + i,
    );
    expect(allocatePort(all)).toBeUndefined();
  });

  test("custom pool respected", () => {
    expect(allocatePort([4000], { base: 4000, size: 2 })).toBe(4001);
    expect(allocatePort([4000, 4001], { base: 4000, size: 2 })).toBeUndefined();
  });

  test("default pool stays clear of production port 3000", () => {
    expect(DEFAULT_POOL.base).toBeGreaterThan(3000);
  });
});
