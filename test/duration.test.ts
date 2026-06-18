/**
 * Tests for parseDuration util (src/util/duration.ts).
 * RED phase: these tests are written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/util/duration.ts";

describe("parseDuration", () => {
  // Happy path: seconds
  test("45s → 45000ms", () => {
    expect(parseDuration("45s")).toBe(45_000);
  });

  test("1s → 1000ms", () => {
    expect(parseDuration("1s")).toBe(1_000);
  });

  // Happy path: minutes
  test("30m → 1800000ms", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
  });

  test("1m → 60000ms", () => {
    expect(parseDuration("1m")).toBe(60_000);
  });

  // Happy path: hours
  test("168h → 604800000ms", () => {
    expect(parseDuration("168h")).toBe(168 * 3600 * 1000);
  });

  test("1h → 3600000ms", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  // Happy path: days
  test("7d → 604800000ms", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 3600 * 1000);
  });

  test("1d → 86400000ms", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  // Reject zero
  test("0d → undefined", () => {
    expect(parseDuration("0d")).toBeUndefined();
  });

  test("0s → undefined", () => {
    expect(parseDuration("0s")).toBeUndefined();
  });

  test("0h → undefined", () => {
    expect(parseDuration("0h")).toBeUndefined();
  });

  // Reject negatives (plain negative strings)
  test("-1d → undefined", () => {
    expect(parseDuration("-1d")).toBeUndefined();
  });

  test("-7h → undefined", () => {
    expect(parseDuration("-7h")).toBeUndefined();
  });

  // Reject bare numbers (no unit)
  test("3600 (bare number) → undefined", () => {
    expect(parseDuration("3600")).toBeUndefined();
  });

  test("7 (bare number) → undefined", () => {
    expect(parseDuration("7")).toBeUndefined();
  });

  // Reject spaces
  test("'7 d' (space) → undefined", () => {
    expect(parseDuration("7 d")).toBeUndefined();
  });

  test("' 7d' (leading space) → undefined", () => {
    expect(parseDuration(" 7d")).toBeUndefined();
  });

  // Case-strict: uppercase units not accepted
  test("7D (uppercase) → undefined", () => {
    expect(parseDuration("7D")).toBeUndefined();
  });

  test("7H (uppercase) → undefined", () => {
    expect(parseDuration("7H")).toBeUndefined();
  });

  test("7M (uppercase) → undefined", () => {
    expect(parseDuration("7M")).toBeUndefined();
  });

  test("7S (uppercase) → undefined", () => {
    expect(parseDuration("7S")).toBeUndefined();
  });

  // Reject floats
  test("1.5d → undefined", () => {
    expect(parseDuration("1.5d")).toBeUndefined();
  });

  // Reject unknown units
  test("7w (unknown unit) → undefined", () => {
    expect(parseDuration("7w")).toBeUndefined();
  });

  test("7ms (not a valid unit) → undefined", () => {
    expect(parseDuration("7ms")).toBeUndefined();
  });

  // Reject empty string
  test("'' (empty) → undefined", () => {
    expect(parseDuration("")).toBeUndefined();
  });

  // Reject just unit letter
  test("'d' (just unit) → undefined", () => {
    expect(parseDuration("d")).toBeUndefined();
  });
});
