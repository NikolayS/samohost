/**
 * Provider port (SPEC §4): the narrow seam every cloud backend implements so
 * the orchestrator stays provider-agnostic. v0.1 ships the Hetzner adapter;
 * AWS is deferred (SPEC-DELTA — provision is Hetzner-only for now).
 */

/** Label every samohost-created resource carries (SPEC §2 orphan discovery). */
export const MANAGED_BY_LABEL = "managed-by";
export const MANAGED_BY_VALUE = "samohost";
/** Label carrying the local VmRecord uuid, written at create time. */
export const SAMOHOST_ID_LABEL = "samohost-id";

/** Common error taxonomy (SPEC §5 provider error normalization). */
export type ProviderErrorKind =
  | "auth"
  | "quota"
  | "notFound"
  | "rate"
  | "transient"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  /** Human-readable, ALWAYS credential-redacted. */
  message: string;
}

/** Provider-agnostic server lifecycle status (subset the orchestrator needs). */
export type ServerStatus =
  | "initializing"
  | "starting"
  | "running"
  | "stopping"
  | "off"
  | "deleting"
  | "unknown";

/** Request to create one server. `userData` is the rendered cloud-init YAML. */
export interface CreateServerSpec {
  name: string;
  serverType: string;
  image: string;
  location: string;
  userData: string;
  labels: Record<string, string>;
}

/** Normalized view of a provider server resource. */
export interface ServerInfo {
  /** Provider-native id, stringified (Hetzner numeric id, EC2 instance id). */
  providerId: string;
  name: string;
  status: ServerStatus;
  /** Public IPv4 address, or null if not (yet) assigned. */
  ipv4: string | null;
  labels: Record<string, string>;
  /** Ids of attached volumes (surfaced — never deleted — by `destroy`). */
  volumeIds: string[];
}

/** Details of one attached volume (for destroy-time surfacing). */
export interface VolumeInfo {
  id: string;
  name: string;
  sizeGb: number;
}

/**
 * The provider port. Implementations throw their own error types; callers
 * funnel anything thrown through `normalizeError` to get the common taxonomy.
 */
export interface ProviderPort {
  create(spec: CreateServerSpec): Promise<ServerInfo>;
  get(id: string): Promise<ServerInfo>;
  /** Only samohost-managed servers (label `managed-by=samohost`). */
  list(): Promise<ServerInfo[]>;
  destroy(id: string): Promise<void>;
  /** Volumes attached to a server — reported by destroy, NEVER auto-deleted. */
  listVolumes(serverId: string): Promise<VolumeInfo[]>;
  normalizeError(e: unknown): ProviderError;
}
