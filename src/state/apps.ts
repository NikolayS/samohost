/**
 * App state store (SPEC-DELTA §3 "app module").
 *
 * Apps live in a SEPARATE document from VMs (`~/.samohost/apps.json`, override
 * via the `SAMOHOST_APPS` env var or the constructor `path` arg used by tests),
 * so the VM lifecycle store and the deploy bookkeeping evolve independently. The
 * crash-safe write contract is shared with {@link StateStore} via `./atomic.ts`.
 *
 * Apps are keyed by `id`, but the natural identity is (vmId, name): an app name
 * is unique per VM. {@link AppStore.get} resolves by that pair.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AppRecord } from "../types.ts";
import { docPaths, readDoc, writeDoc, type DocPaths } from "./atomic.ts";

interface AppsFile {
  version: 1;
  apps: AppRecord[];
}

const EMPTY: AppsFile = { version: 1, apps: [] };

/** Resolve the default apps path: SAMOHOST_APPS env, else ~/.samohost/apps.json. */
export function defaultAppsPath(): string {
  const fromEnv = process.env["SAMOHOST_APPS"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".samohost", "apps.json");
}

export class AppStore {
  readonly path: string;
  private readonly paths: DocPaths;

  constructor(path?: string) {
    this.path = path ?? defaultAppsPath();
    this.paths = docPaths(this.path);
  }

  /** All app records (empty array if no file yet). */
  list(): AppRecord[] {
    return this.read().apps;
  }

  /** A single app by (vmId, name) — the natural per-VM identity. */
  get(vmId: string, name: string): AppRecord | undefined {
    return this.read().apps.find((a) => a.vmId === vmId && a.name === name);
  }

  /** A single app by id, or undefined. */
  getById(id: string): AppRecord | undefined {
    return this.read().apps.find((a) => a.id === id);
  }

  /**
   * Insert or replace an app. Identity is (vmId, name): if a record with the
   * same pair exists it is replaced (preserving its id), otherwise the supplied
   * record is appended. Returns the stored record.
   */
  upsert(record: AppRecord): AppRecord {
    const state = this.read();
    const idx = state.apps.findIndex(
      (a) => a.vmId === record.vmId && a.name === record.name,
    );
    if (idx >= 0) {
      const stored: AppRecord = { ...record, id: state.apps[idx]!.id };
      state.apps[idx] = stored;
      this.write(state);
      return stored;
    }
    state.apps.push(record);
    this.write(state);
    return record;
  }

  /** Remove an app by (vmId, name). Returns true if a record was removed. */
  remove(vmId: string, name: string): boolean {
    const state = this.read();
    const before = state.apps.length;
    state.apps = state.apps.filter(
      (a) => !(a.vmId === vmId && a.name === name),
    );
    const removed = state.apps.length !== before;
    if (removed) this.write(state);
    return removed;
  }

  private read(): AppsFile {
    return readDoc(this.paths, validateAppsFile, () => structuredClone(EMPTY));
  }

  private write(state: AppsFile): void {
    writeDoc(this.paths, state);
  }
}

function validateAppsFile(obj: unknown): AppsFile | undefined {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "apps" in obj &&
    Array.isArray((obj as { apps: unknown }).apps)
  ) {
    return obj as AppsFile;
  }
  return undefined;
}
