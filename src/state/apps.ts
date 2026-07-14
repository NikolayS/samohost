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

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppRecord } from "../types.ts";
import {
  assertOptionalLinuxAppUser,
  linuxAppUserError,
} from "../app/linux-user.ts";
import { docPaths, readDoc, writeDoc, type DocPaths } from "./atomic.ts";

interface AppsFile {
  version: 1;
  apps: AppRecord[];
}

const EMPTY: AppsFile = { version: 1, apps: [] };
const INVALID_LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  token: string;
}

/** A compare-and-swap failed because another writer changed the AppRecord. */
export class AppStoreConflictError extends Error {
  constructor(vmId: string, name: string) {
    super(`app state changed concurrently for ${vmId}/${name}; refusing stale write`);
    this.name = "AppStoreConflictError";
  }
}

/** A live local samohost process currently owns the apps document lock. */
export class AppStoreLockedError extends Error {
  constructor(path: string, pid?: number) {
    super(
      pid === undefined
        ? `app state is locked by another local writer: ${path}`
        : `app state is locked by live process ${pid}: ${path}`,
    );
    this.name = "AppStoreLockedError";
  }
}

/** Resolve the default apps path: SAMOHOST_APPS env, else ~/.samohost/apps.json. */
export function defaultAppsPath(): string {
  const fromEnv = process.env["SAMOHOST_APPS"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".samohost", "apps.json");
}

export class AppStore {
  readonly path: string;
  private readonly paths: DocPaths;
  private readonly lockPath: string;

  constructor(path?: string) {
    this.path = path ?? defaultAppsPath();
    this.paths = docPaths(this.path);
    this.lockPath = `${this.path}.lock`;
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
    assertOptionalLinuxAppUser(record.appUser);
    return this.withMutationLock(() => this.upsertUnlocked(record));
  }

  /**
   * Atomically replace `expected` only if the complete persisted AppRecord is
   * still byte-for-byte equivalent to that snapshot. This is the state-stamp
   * primitive for long-running deploy/routing work: remote work happens
   * without holding a filesystem lease, then its bookkeeping either commits
   * against the unchanged snapshot or fails closed without erasing a newer
   * SHA, release cursor, fingerprint, or configuration update.
   */
  compareAndSwap(expected: AppRecord, replacement: AppRecord): AppRecord {
    assertOptionalLinuxAppUser(replacement.appUser);
    if (
      replacement.id !== expected.id ||
      replacement.vmId !== expected.vmId ||
      replacement.name !== expected.name
    ) {
      throw new Error("AppStore compareAndSwap cannot change app identity");
    }

    return this.withMutationLock(() => {
      const state = this.read();
      const idx = state.apps.findIndex(
        (app) => app.vmId === expected.vmId && app.name === expected.name,
      );
      if (idx < 0 || !isDeepStrictEqual(state.apps[idx], expected)) {
        throw new AppStoreConflictError(expected.vmId, expected.name);
      }
      state.apps[idx] = replacement;
      this.write(state);
      return replacement;
    });
  }

  /** Remove an app by (vmId, name). Returns true if a record was removed. */
  remove(vmId: string, name: string): boolean {
    return this.withMutationLock(() => {
      const state = this.read();
      const before = state.apps.length;
      state.apps = state.apps.filter(
        (a) => !(a.vmId === vmId && a.name === name),
      );
      const removed = state.apps.length !== before;
      if (removed) this.write(state);
      return removed;
    });
  }

  private upsertUnlocked(record: AppRecord): AppRecord {
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

  private withMutationLock<T>(fn: () => T): T {
    const owner = this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock(owner);
    }
  }

  private acquireLock(): LockOwner {
    mkdirSync(dirname(this.path), { recursive: true });
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeSync(fd, JSON.stringify(owner) + "\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return owner;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }

      const existing = this.readLockOwner();
      if (existing !== undefined) {
        if (isProcessAlive(existing.pid)) {
          throw new AppStoreLockedError(this.path, existing.pid);
        }
        this.removeStaleLock();
        continue;
      }

      // A newly-created lock can briefly be empty while its owner writes and
      // fsyncs the metadata. Never steal it during that window. An invalid
      // lock older than the grace period is an abandoned pre-metadata crash.
      let oldEnough = false;
      try {
        oldEnough = Date.now() - statSync(this.lockPath).mtimeMs >= INVALID_LOCK_STALE_MS;
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (!oldEnough) throw new AppStoreLockedError(this.path);
      this.removeStaleLock();
    }

    throw new AppStoreLockedError(this.path);
  }

  private readLockOwner(): LockOwner | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.lockPath, "utf8")) as unknown;
      if (
        raw !== null &&
        typeof raw === "object" &&
        "pid" in raw &&
        Number.isSafeInteger((raw as { pid: unknown }).pid) &&
        (raw as { pid: number }).pid > 0 &&
        "token" in raw &&
        typeof (raw as { token: unknown }).token === "string" &&
        (raw as { token: string }).token.length > 0
      ) {
        return raw as LockOwner;
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
    }
    return undefined;
  }

  private removeStaleLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  private releaseLock(owner: LockOwner): void {
    const current = this.readLockOwner();
    if (current?.token !== owner.token || current.pid !== owner.pid) return;
    this.removeStaleLock();
  }

  private read(): AppsFile {
    return readDoc(this.paths, validateAppsFile, () => structuredClone(EMPTY));
  }

  private write(state: AppsFile): void {
    writeDoc(this.paths, state);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function validateAppsFile(obj: unknown): AppsFile | undefined {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "apps" in obj &&
    Array.isArray((obj as { apps: unknown }).apps) &&
    (obj as { apps: unknown[] }).apps.every((app) => {
      if (app === null || typeof app !== "object") return false;
      const appUser = (app as { appUser?: unknown }).appUser;
      return appUser === undefined || linuxAppUserError(appUser) === undefined;
    })
  ) {
    return obj as AppsFile;
  }
  return undefined;
}
