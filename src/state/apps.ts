/**
 * App state store (SPEC-DELTA §3 "app module").
 *
 * Apps live in a SEPARATE document from VMs (`~/.samohost/apps.json`, override
 * via the `SAMOHOST_APPS` env var or the constructor `path` arg used by tests),
 * so the VM lifecycle store and the deploy bookkeeping evolve independently. The
 * process-crash-safe write contract is shared with {@link StateStore} via
 * `./atomic.ts`. It does not claim power-loss durability: the containing
 * directory is not fsynced after rename.
 *
 * Apps are keyed by `id`, but the natural identity is (vmId, name): an app name
 * is unique per VM. {@link AppStore.get} resolves by that pair.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

interface LockOwner {
  pid: number;
  token: string;
  path: string;
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
  private readonly lockPrefix: string;
  private readonly legacyLockPath: string;

  constructor(path?: string) {
    this.path = path ?? defaultAppsPath();
    this.paths = docPaths(this.path);
    this.lockPrefix = `${basename(this.path)}.lock.`;
    this.legacyLockPath = `${this.path}.lock`;
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

  /** Insert only when (vmId, name) is absent. */
  create(record: AppRecord): AppRecord {
    assertOptionalLinuxAppUser(record.appUser);
    return this.withMutationLock(() => {
      const state = this.read();
      if (state.apps.some(
        (app) => app.vmId === record.vmId && app.name === record.name,
      )) {
        throw new AppStoreConflictError(record.vmId, record.name);
      }
      state.apps.push(record);
      this.write(state);
      return record;
    });
  }

  /**
   * Backward-compatible insert alias. Existing records are never replaced;
   * callers performing read-modify-write must use {@link compareAndSwap}.
   */
  upsert(record: AppRecord): AppRecord {
    return this.create(record);
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

  private withMutationLock<T>(fn: () => T): T {
    const owner = this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock(owner);
    }
  }

  private acquireLock(): LockOwner {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    // Fail closed across upgrades. The old shared lock name cannot be safely
    // reclaimed without risking deletion of a replacement owner.
    if (existsSync(this.legacyLockPath)) {
      throw new AppStoreLockedError(this.path);
    }
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      path: "",
    };
    owner.path = join(
      directory,
      `${this.lockPrefix}${owner.pid}.${owner.token}`,
    );

    const fd = openSync(owner.path, "wx", 0o600);
    closeSync(fd);
    try {
      for (const name of readdirSync(directory)) {
        if (!name.startsWith(this.lockPrefix)) continue;
        const contenderPath = join(directory, name);
        if (contenderPath === owner.path) continue;

        const suffix = name.slice(this.lockPrefix.length);
        const separator = suffix.indexOf(".");
        const pid = separator > 0 ? Number(suffix.slice(0, separator)) : NaN;
        const token = separator > 0 ? suffix.slice(separator + 1) : "";
        if (!Number.isSafeInteger(pid) || pid <= 0 || token.length === 0) {
          throw new AppStoreLockedError(this.path);
        }
        if (isProcessAlive(pid)) {
          throw new AppStoreLockedError(this.path, pid);
        }

        // Every contender path contains a random token and is never reused.
        // Removing this exact dead owner's path therefore cannot unlink a
        // replacement lock created by another reclaimer.
        removeUniqueLock(contenderPath);
      }
      return owner;
    } catch (error) {
      removeUniqueLock(owner.path);
      throw error;
    }
  }

  private releaseLock(owner: LockOwner): void {
    removeUniqueLock(owner.path);
  }

  private read(): AppsFile {
    return readDoc(this.paths, validateAppsFile, () => structuredClone(EMPTY));
  }

  private write(state: AppsFile): void {
    writeDoc(this.paths, state);
  }
}

function removeUniqueLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
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
