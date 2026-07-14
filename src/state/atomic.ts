/**
 * Shared process-crash-safe JSON document helpers (SPEC §5).
 *
 * Both the VM {@link StateStore} and the {@link AppStore} persist a single JSON
 * document and need the same process-crash contract: serialize → copy current to
 * `.bak` → write `.tmp` (fsync) → atomic rename over the primary, recovering
 * from `.bak` if the primary is missing/corrupt. This module factors that out so
 * the two stores can't drift apart. This is not a power-loss durability claim:
 * the containing directory is not fsynced after rename.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Paths derived from a primary document path. */
export interface DocPaths {
  path: string;
  tmpPath: string;
  bakPath: string;
}

/** Derive `.tmp`/`.bak` sidecar paths for a primary document path. */
export function docPaths(path: string): DocPaths {
  return { path, tmpPath: `${path}.tmp`, bakPath: `${path}.bak` };
}

/**
 * Read + validate a JSON document, recovering from `.bak` if the primary is
 * corrupt or missing. Returns `fallback` (a fresh value) when neither exists.
 * `validate` returns the typed value on success or `undefined` if the parsed
 * JSON is not a well-formed document of the expected shape.
 */
export function readDoc<T>(
  paths: DocPaths,
  validate: (raw: unknown) => T | undefined,
  fallback: () => T,
): T {
  const tryParse = (text: string): T | undefined => {
    try {
      return validate(JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  };

  if (existsSync(paths.path)) {
    const parsed = tryParse(readFileSync(paths.path, "utf8"));
    if (parsed) return parsed;
    if (existsSync(paths.bakPath)) {
      const bak = tryParse(readFileSync(paths.bakPath, "utf8"));
      if (bak) return bak;
    }
    throw new Error(`state file is corrupt and unrecoverable: ${paths.path}`);
  }
  if (existsSync(paths.bakPath)) {
    const bak = tryParse(readFileSync(paths.bakPath, "utf8"));
    if (bak) return bak;
  }
  return fallback();
}

/**
 * Process-crash-safe atomic write: ensure dir → back up current primary to `.bak`
 * → write `.tmp` (fsync) → rename over the primary. An interrupted write
 * leaves either the old primary or a recoverable `.bak`.
 */
export function writeDoc(paths: DocPaths, value: unknown): void {
  mkdirSync(dirname(paths.path), { recursive: true });

  if (existsSync(paths.path)) {
    copyFileSync(paths.path, paths.bakPath);
  }

  const data = JSON.stringify(value, null, 2) + "\n";
  const fd = openSync(paths.tmpPath, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(paths.tmpPath, paths.path);
}
