/**
 * Atomic local state store (SPEC §5).
 *
 * State is a single JSON document at `~/.samohost/state.json` (override via the
 * `SAMOHOST_STATE` env var or the constructor `path` arg — the latter is used
 * by tests). Writes are crash-safe: serialize → write `.tmp` → fsync → rename
 * over the real file, keeping the previous version as `.bak`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { VmRecord } from "../types.ts";

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
  private readonly tmpPath: string;
  private readonly bakPath: string;

  constructor(path?: string) {
    this.path = path ?? defaultStatePath();
    this.tmpPath = `${this.path}.tmp`;
    this.bakPath = `${this.path}.bak`;
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
    if (existsSync(this.path)) {
      const parsed = tryParse(readFileSync(this.path, "utf8"));
      if (parsed) return parsed;
      // Primary corrupt — attempt backup recovery.
      if (existsSync(this.bakPath)) {
        const bak = tryParse(readFileSync(this.bakPath, "utf8"));
        if (bak) return bak;
      }
      throw new Error(`state file is corrupt and unrecoverable: ${this.path}`);
    }
    // No primary file — try backup (recovery after a crash mid-rename).
    if (existsSync(this.bakPath)) {
      const bak = tryParse(readFileSync(this.bakPath, "utf8"));
      if (bak) return bak;
    }
    return structuredClone(EMPTY);
  }

  /**
   * Atomic write: ensure dir → back up current → write tmp (fsync) → rename.
   * The current file is copied to `.bak` *before* we touch the primary, so an
   * interrupted write leaves either the old primary or a recoverable `.bak`.
   */
  private write(state: StateFile): void {
    mkdirSync(dirname(this.path), { recursive: true });

    if (existsSync(this.path)) {
      copyFileSync(this.path, this.bakPath);
    }

    const data = JSON.stringify(state, null, 2) + "\n";
    const fd = openSync(this.tmpPath, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpPath, this.path);
  }
}

function tryParse(text: string): StateFile | undefined {
  try {
    const obj = JSON.parse(text) as unknown;
    if (
      obj !== null &&
      typeof obj === "object" &&
      "records" in obj &&
      Array.isArray((obj as { records: unknown }).records)
    ) {
      return obj as StateFile;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
