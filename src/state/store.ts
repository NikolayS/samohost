/**
 * Atomic local state store (SPEC §5).
 *
 * State is a single JSON document at `~/.samohost/state.json` (override via the
 * `SAMOHOST_STATE` env var or the constructor `path` arg — the latter is used
 * by tests). Writes are crash-safe: serialize → write `.tmp` → fsync → rename
 * over the real file, keeping the previous version as `.bak`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { VmRecord } from "../types.ts";
import { docPaths, readDoc, writeDoc, type DocPaths } from "./atomic.ts";

interface StateFile {
  version: 1;
  records: VmRecord[];
}

const EMPTY: StateFile = { version: 1, records: [] };

/** Resolve the default state path: SAMOHOST_STATE env, else ~/.samohost/state.json. */
export function defaultStatePath(): string {
  const fromEnv = process.env["SAMOHOST_STATE"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".samohost", "state.json");
}

export class StateStore {
  readonly path: string;
  private readonly paths: DocPaths;

  constructor(path?: string) {
    this.path = path ?? defaultStatePath();
    this.paths = docPaths(this.path);
  }

  /** All records (empty array if no state file yet). */
  list(): VmRecord[] {
    return this.read().records;
  }

  /** A single record by id, or undefined. */
  get(id: string): VmRecord | undefined {
    return this.read().records.find((r) => r.id === id);
  }

  /** Insert or replace a record by id, bumping `updatedAt`. */
  upsert(record: VmRecord): VmRecord {
    const state = this.read();
    const stamped: VmRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    const idx = state.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) state.records[idx] = stamped;
    else state.records.push(stamped);
    this.write(state);
    return stamped;
  }

  /** Remove a record by id. Returns true if a record was removed. */
  remove(id: string): boolean {
    const state = this.read();
    const before = state.records.length;
    state.records = state.records.filter((r) => r.id !== id);
    const removed = state.records.length !== before;
    if (removed) this.write(state);
    return removed;
  }

  /** Read current state, recovering from `.bak` if the primary is corrupt. */
  private read(): StateFile {
    return readDoc(this.paths, validateStateFile, () => structuredClone(EMPTY));
  }

  /** Crash-safe write via the shared atomic helper (tmp + fsync + rename). */
  private write(state: StateFile): void {
    writeDoc(this.paths, state);
  }
}

function validateStateFile(obj: unknown): StateFile | undefined {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "records" in obj &&
    Array.isArray((obj as { records: unknown }).records)
  ) {
    return obj as StateFile;
  }
  return undefined;
}
