import { describe, expect, test } from "bun:test";
import { allocatePort, DEFAULT_POOL } from "../src/env/ports.ts";

describe("allocatePort", () => {
  test("empty pool usage returns the base port", () => {
    expect(allocatePort([])).toBe(3100);
  });

  test("lowest free port wins (deterministic)", () => {
    expect(allocatePort([3100, 3101, 3103])).toBe(3102);
  });

  test("ports outside the pool are ignored", () => {
    expect(allocatePort([3000, 80, 443])).toBe(3100);
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
