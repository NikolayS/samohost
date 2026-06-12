/**
 * Preview-env state store (SPEC-DELTA §4 "env command family").
 *
 * Envs live in their own document (`~/.samohost/envs.json`, override via the
 * `SAMOHOST_ENVS` env var or the constructor `path` arg used by tests), sharing
 * the crash-safe write contract of `./atomic.ts` with the VM and app stores.
 *
 * Envs are keyed by `id`; the natural identity is (vmId, appName, branch) —
 * one env per branch per app per VM.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvRecord } from "../types.ts";
import { docPaths, readDoc, writeDoc, type DocPaths } from "./atomic.ts";

interface EnvsFile {
  version: 1;
  envs: EnvRecord[];
}

const EMPTY: EnvsFile = { version: 1, envs: [] };

/** Resolve the default envs path: SAMOHOST_ENVS env, else ~/.samohost/envs.json. */
export function defaultEnvsPath(): string {
  const fromEnv = process.env["SAMOHOST_ENVS"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".samohost", "envs.json");
}

export class EnvStore {
  readonly path: string;
  private readonly paths: DocPaths;

  constructor(path?: string) {
    this.path = path ?? defaultEnvsPath();
    this.paths = docPaths(this.path);
  }

  /** All env records (empty array if no file yet). */
  list(): EnvRecord[] {
    return this.read().envs;
  }

  /** Envs on one VM, optionally narrowed to one app. */
  listFor(vmId: string, appName?: string): EnvRecord[] {
    return this.read().envs.filter(
      (e) => e.vmId === vmId && (appName === undefined || e.appName === appName),
    );
  }

  /** A single env by (vmId, appName, branch) — the natural identity. */
  get(vmId: string, appName: string, branch: string): EnvRecord | undefined {
    return this.read().envs.find(
      (e) => e.vmId === vmId && e.appName === appName && e.branch === branch,
    );
  }

  /**
   * Insert or replace an env. Identity is (vmId, appName, branch): an existing
   * record for the same triple is replaced preserving its id. Returns the
   * stored record.
   */
  upsert(record: EnvRecord): EnvRecord {
    const state = this.read();
    const idx = state.envs.findIndex(
      (e) =>
        e.vmId === record.vmId &&
        e.appName === record.appName &&
        e.branch === record.branch,
    );
    if (idx >= 0) {
      const stored: EnvRecord = { ...record, id: state.envs[idx]!.id };
      state.envs[idx] = stored;
      this.write(state);
      return stored;
    }
    state.envs.push(record);
    this.write(state);
    return record;
  }

  /** Remove an env by (vmId, appName, branch). True if a record was removed. */
  remove(vmId: string, appName: string, branch: string): boolean {
    const state = this.read();
    const before = state.envs.length;
    state.envs = state.envs.filter(
      (e) =>
        !(e.vmId === vmId && e.appName === appName && e.branch === branch),
    );
    const removed = state.envs.length !== before;
    if (removed) this.write(state);
    return removed;
  }

  private read(): EnvsFile {
    return readDoc(this.paths, validateEnvsFile, () => structuredClone(EMPTY));
  }

  private write(state: EnvsFile): void {
    writeDoc(this.paths, state);
  }
}

function validateEnvsFile(obj: unknown): EnvsFile | undefined {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "envs" in obj &&
    Array.isArray((obj as { envs: unknown }).envs)
  ) {
    return obj as EnvsFile;
  }
  return undefined;
}
