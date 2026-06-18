import { describe, expect, test } from "bun:test";
import {
  allocatePort,
  DEFAULT_POOL,
  parseListeningPorts,
} from "../src/env/ports.ts";

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

describe("parseListeningPorts", () => {
  // Real `ss -ltnH` output columns: State Recv-Q Send-Q Local-Address:Port
  // Peer-Address:Port [Process]. -H suppresses the header.
  test("extracts the port from an IPv4 wildcard listener (0.0.0.0)", () => {
    const out = "LISTEN 0      128          0.0.0.0:3100       0.0.0.0:*";
    expect(parseListeningPorts(out).has(3100)).toBe(true);
  });

  test("extracts ports for the address forms #71 matches", () => {
    // 0.0.0.0, 127.0.0.1, [::], [::1], and bare * — the squatter forms a
    // preview unit would collide with (EADDRINUSE).
    const out = [
      "LISTEN 0 128   0.0.0.0:3100   0.0.0.0:*",
      "LISTEN 0 128 127.0.0.1:3101   0.0.0.0:*",
      "LISTEN 0 128      [::]:3102      [::]:*",
      "LISTEN 0 128     [::1]:3103      [::]:*",
      "LISTEN 0 128         *:3104          *:*",
    ].join("\n");
    const ports = parseListeningPorts(out);
    expect([...ports].sort((a, b) => a - b)).toEqual([
      3100, 3101, 3102, 3103, 3104,
    ]);
  });

  test("ignores the peer-address column (only the local listen port counts)", () => {
    // A peer like 1.2.3.4:3100 must NOT be read as a bound local port.
    const out = "LISTEN 0 128 127.0.0.1:5432   1.2.3.4:3100";
    const ports = parseListeningPorts(out);
    expect(ports.has(5432)).toBe(true);
    expect(ports.has(3100)).toBe(false);
  });

  test("empty / blank output yields no ports", () => {
    expect(parseListeningPorts("").size).toBe(0);
    expect(parseListeningPorts("\n   \n").size).toBe(0);
  });
});

describe("allocatePort skips live-bound ports (squatter robustness)", () => {
  test("a squatted pool port is skipped; allocation picks the next free one", () => {
    // 3100 is store-free but held by a CI runner's Playwright server.
    expect(allocatePort([3100])).toBe(3101);
  });

  test("store-recorded AND live-bound ports are both skipped", () => {
    // 3100 store-recorded (our env), 3101 live-bound squatter → 3102.
    expect(allocatePort([3100, 3101])).toBe(3102);
  });

  test("pool exhaustion still errors clearly even when squatters fill the gaps", () => {
    const all = Array.from(
      { length: DEFAULT_POOL.size },
      (_, i) => DEFAULT_POOL.base + i,
    );
    expect(allocatePort(all)).toBeUndefined();
  });
});
