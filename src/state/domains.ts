/**
 * Domain state store — custom-domain → app mappings.
 *
 * Domains live in a separate document (`~/.samohost/domains.json`, override via
 * the `SAMOHOST_DOMAINS` env var or the constructor `path` arg used by tests).
 * The crash-safe write contract is shared with {@link StateStore} via `./atomic.ts`.
 *
 * Natural identity: `fqdn` (globally unique; one custom hostname per client domain
 * across all apps and VMs). {@link DomainStore.get} resolves by that field.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { DomainRecord } from "../types.ts";
import { docPaths, readDoc, writeDoc, type DocPaths } from "./atomic.ts";

interface DomainsFile {
  version: 1;
  domains: DomainRecord[];
}

const EMPTY: DomainsFile = { version: 1, domains: [] };

/** Resolve the default domains path: SAMOHOST_DOMAINS env, else ~/.samohost/domains.json. */
export function defaultDomainsPath(): string {
  const fromEnv = process.env["SAMOHOST_DOMAINS"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".samohost", "domains.json");
}

export class DomainStore {
  readonly path: string;
  private readonly paths: DocPaths;

  constructor(path?: string) {
    this.path = path ?? defaultDomainsPath();
    this.paths = docPaths(this.path);
  }

  /** All domain records (empty array if no file yet). */
  list(): DomainRecord[] {
    return this.read().domains;
  }

  /** A single domain by fqdn — the natural identity. */
  get(fqdn: string): DomainRecord | undefined {
    return this.read().domains.find((d) => d.fqdn === fqdn);
  }

  /**
   * Insert or replace a domain. Identity is `fqdn`: if a record with the same
   * fqdn exists it is replaced (preserving its id), otherwise the supplied
   * record is appended. Returns the stored record.
   */
  upsert(record: DomainRecord): DomainRecord {
    const state = this.read();
    const idx = state.domains.findIndex((d) => d.fqdn === record.fqdn);
    if (idx >= 0) {
      const stored: DomainRecord = { ...record, id: state.domains[idx]!.id };
      state.domains[idx] = stored;
      this.write(state);
      return stored;
    }
    state.domains.push(record);
    this.write(state);
    return record;
  }

  /** Remove a domain by fqdn. Returns true if a record was removed. */
  remove(fqdn: string): boolean {
    const state = this.read();
    const before = state.domains.length;
    state.domains = state.domains.filter((d) => d.fqdn !== fqdn);
    const removed = state.domains.length !== before;
    if (removed) this.write(state);
    return removed;
  }

  private read(): DomainsFile {
    return readDoc(this.paths, validateDomainsFile, () =>
      structuredClone(EMPTY),
    );
  }

  private write(state: DomainsFile): void {
    writeDoc(this.paths, state);
  }
}

function validateDomainsFile(obj: unknown): DomainsFile | undefined {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "domains" in obj &&
    Array.isArray((obj as { domains: unknown }).domains)
  ) {
    return obj as DomainsFile;
  }
  return undefined;
}
