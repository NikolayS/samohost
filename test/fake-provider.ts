/**
 * In-memory fake implementing the Provider port (SPEC §6: "Integration:
 * provision→list→status→destroy against an in-memory fake provider").
 *
 * Shape note (tests-mock-prod-shape): this fake implements the SAME
 * `ProviderPort` interface the Hetzner adapter implements, and its error
 * objects are normalized through the same `{kind, message}` taxonomy, so
 * orchestrator tests exercise the exact seam production uses.
 */

import type {
  CreateServerSpec,
  ProviderError,
  ProviderErrorKind,
  ProviderPort,
  ServerInfo,
  ServerStatus,
  VolumeInfo,
} from "../src/providers/types.ts";

export class FakeProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "FakeProviderError";
    this.kind = kind;
  }
}

export class FakeProvider implements ProviderPort {
  /** Captured create specs (golden user_data assertions read these). */
  readonly createCalls: CreateServerSpec[] = [];
  /** When set (incl. null), create() and get() report this ipv4 (samorev #2). */
  forceIpv4: string | null | undefined = undefined;
  readonly destroyCalls: string[] = [];
  servers = new Map<string, ServerInfo>();
  volumesByServer = new Map<string, VolumeInfo[]>();

  /** Statuses returned by successive get() calls; the last value repeats. */
  statusSequence: ServerStatus[] = ["running"];
  private getCount = 0;

  /** When set, create() throws it (after recording the call). */
  failCreateWith?: FakeProviderError;
  /** When set, destroy() throws it once, then succeeds on retry. */
  failDestroyOnceWith?: FakeProviderError;
  /** Hook invoked DURING create (before it resolves) — crash-safety probes. */
  onCreate?: (spec: CreateServerSpec) => void;

  private nextId = 9001;

  async create(spec: CreateServerSpec): Promise<ServerInfo> {
    this.createCalls.push(spec);
    this.onCreate?.(spec);
    if (this.failCreateWith) throw this.failCreateWith;
    const id = String(this.nextId++);
    const info: ServerInfo = {
      providerId: id,
      name: spec.name,
      status: "initializing",
      ipv4: this.forceIpv4 !== undefined ? this.forceIpv4 : "192.0.2.55",
      labels: { ...spec.labels },
      volumeIds: (this.volumesByServer.get(id) ?? []).map((v) => v.id),
    };
    this.servers.set(id, info);
    return info;
  }

  async get(id: string): Promise<ServerInfo> {
    const info = this.servers.get(id);
    if (!info) throw new FakeProviderError("notFound", `server ${id} not found`);
    const idx = Math.min(this.getCount, this.statusSequence.length - 1);
    this.getCount += 1;
    const ipv4 = this.forceIpv4 !== undefined ? this.forceIpv4 : info.ipv4;
    return { ...info, ipv4, status: this.statusSequence[idx]! };
  }

  async list(): Promise<ServerInfo[]> {
    return [...this.servers.values()];
  }

  async destroy(id: string): Promise<void> {
    this.destroyCalls.push(id);
    if (this.failDestroyOnceWith) {
      const e = this.failDestroyOnceWith;
      this.failDestroyOnceWith = undefined;
      throw e;
    }
    if (!this.servers.has(id)) {
      throw new FakeProviderError("notFound", `server ${id} not found`);
    }
    this.servers.delete(id);
  }

  async listVolumes(serverId: string): Promise<VolumeInfo[]> {
    if (!this.servers.has(serverId)) {
      throw new FakeProviderError("notFound", `server ${serverId} not found`);
    }
    return this.volumesByServer.get(serverId) ?? [];
  }

  normalizeError(e: unknown): ProviderError {
    if (e instanceof FakeProviderError) {
      return { kind: e.kind, message: e.message };
    }
    return { kind: "unknown", message: String(e) };
  }
}
