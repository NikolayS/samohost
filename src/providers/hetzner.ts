/**
 * Hetzner Cloud adapter (SPEC §4: "Hetzner = direct fetch HTTP calls").
 *
 * Credential handling (SPEC §5): the API token is read from `HCLOUD_TOKEN` at
 * CALL time — never at construction, never persisted, never logged. Every
 * normalized error message is scrubbed of the live token value before it can
 * reach a log, a state file, or a terminal.
 *
 * SSH keys are deliberately cloud-init-only: the hardening baseline plants the
 * operator's public key for the non-root admin user, root login and password
 * auth are disabled, so a Hetzner-side ssh-key resource would only add a
 * second resource lifecycle for zero security gain. (The `root_password`
 * Hetzner returns when no ssh_keys are passed is ignored and never surfaced.)
 *
 * Delete protection is NEVER enabled: samohost VMs are cattle and `destroy`
 * must always succeed without a protection-removal dance.
 */

import type {
  CreateServerSpec,
  ProviderError,
  ProviderPort,
  ServerInfo,
  ServerStatus,
  VolumeInfo,
} from "./types.ts";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from "./types.ts";

export const HETZNER_BASE_URL = "https://api.hetzner.cloud/v1";

/** Raised for any non-2xx Hetzner API response (and a missing token). */
export class HetznerApiError extends Error {
  /** HTTP status (0 = no HTTP exchange happened, e.g. missing token). */
  readonly status: number;
  /** Hetzner error code from the response body, if present. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "HetznerApiError";
    this.status = status;
    this.code = code;
  }
}

export interface HetznerDeps {
  /** Injected fetch — tests pass a mock; prod passes globalThis.fetch. */
  fetch: typeof fetch;
  /** Override for tests / API mocking; default {@link HETZNER_BASE_URL}. */
  baseUrl?: string;
}

const STATUS_MAP: Record<string, ServerStatus> = {
  initializing: "initializing",
  starting: "starting",
  running: "running",
  stopping: "stopping",
  off: "off",
  deleting: "deleting",
};

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net?: { ipv4?: { ip?: string } | null } | null;
  labels?: Record<string, string>;
  volumes?: number[];
}

export class HetznerProvider implements ProviderPort {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(deps: HetznerDeps) {
    this.fetchFn = deps.fetch;
    this.baseUrl = deps.baseUrl ?? HETZNER_BASE_URL;
  }

  async create(spec: CreateServerSpec): Promise<ServerInfo> {
    const body = await this.request("POST", "/servers", {
      name: spec.name,
      server_type: spec.serverType,
      image: spec.image,
      location: spec.location,
      user_data: spec.userData,
      labels: spec.labels,
      start_after_create: true,
      // NOTE: no `ssh_keys` (cloud-init-only key delivery — see module doc),
      // no `protection` (delete protection must never be enabled).
    });
    // The response also carries `root_password` (we pass no ssh_keys). It is
    // intentionally not read: the baseline disables root + password auth.
    return mapServer((body as { server: HetznerServer }).server);
  }

  async get(id: string): Promise<ServerInfo> {
    const body = await this.request("GET", `/servers/${id}`);
    return mapServer((body as { server: HetznerServer }).server);
  }

  async list(): Promise<ServerInfo[]> {
    const selector = encodeURIComponent(
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    );
    const body = await this.request(
      "GET",
      `/servers?label_selector=${selector}`,
    );
    return (body as { servers: HetznerServer[] }).servers.map(mapServer);
  }

  async destroy(id: string): Promise<void> {
    await this.request("DELETE", `/servers/${id}`);
  }

  async listVolumes(serverId: string): Promise<VolumeInfo[]> {
    const info = await this.get(serverId);
    const volumes: VolumeInfo[] = [];
    for (const vid of info.volumeIds) {
      const body = await this.request("GET", `/volumes/${vid}`);
      const v = (body as { volume: { id: number; name: string; size: number } })
        .volume;
      volumes.push({ id: String(v.id), name: v.name, sizeGb: v.size });
    }
    return volumes;
  }

  normalizeError(e: unknown): ProviderError {
    if (e instanceof HetznerApiError) {
      return { kind: kindFor(e), message: redactToken(e.message) };
    }
    if (e instanceof TypeError) {
      // fetch network failures (DNS, connect, TLS) surface as TypeError.
      return { kind: "transient", message: redactToken(e.message) };
    }
    if (e instanceof Error) {
      return { kind: "unknown", message: redactToken(e.message) };
    }
    return { kind: "unknown", message: redactToken(String(e)) };
  }

  /** One authenticated API exchange. Token resolved here, at call time. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = process.env["HCLOUD_TOKEN"];
    if (token === undefined || token.length === 0) {
      throw new HetznerApiError(
        "HCLOUD_TOKEN is not set — export the Hetzner Cloud API token in the " +
          "environment (it is read at call time and never persisted)",
        0,
        "token-missing",
      );
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const apiError = (parsed as { error?: { code?: string; message?: string } })
        .error;
      throw new HetznerApiError(
        `Hetzner API ${method} ${path} failed (HTTP ${res.status})` +
          (apiError?.code ? ` [${apiError.code}]` : "") +
          (apiError?.message ? `: ${apiError.message}` : ""),
        res.status,
        apiError?.code,
      );
    }
    return parsed;
  }
}

function mapServer(s: HetznerServer): ServerInfo {
  return {
    providerId: String(s.id),
    name: s.name,
    status: STATUS_MAP[s.status] ?? "unknown",
    ipv4: s.public_net?.ipv4?.ip ?? null,
    labels: s.labels ?? {},
    volumeIds: (s.volumes ?? []).map(String),
  };
}

/** Map a Hetzner error to the common taxonomy. Body code beats HTTP status. */
function kindFor(e: HetznerApiError): ProviderError["kind"] {
  if (e.code === "resource_limit_exceeded") return "quota";
  if (e.code === "token-missing") return "auth";
  if (e.status === 401 || e.status === 403) return "auth";
  if (e.status === 404) return "notFound";
  if (e.status === 429) return "rate";
  if (e.status >= 500) return "transient";
  return "unknown";
}

/** Scrub the live token value (if any) out of a message before it escapes. */
function redactToken(message: string): string {
  const token = process.env["HCLOUD_TOKEN"];
  if (token === undefined || token.length === 0) return message;
  return message.split(token).join("[REDACTED]");
}
