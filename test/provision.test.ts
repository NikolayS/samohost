/**
 * `samohost provision` orchestrator tests (SPEC §5 state machine, §6 plan).
 *
 * Everything runs against the in-memory FakeProvider implementing the
 * Provider port (plus ONE integration case against the real HetznerProvider
 * with mocked fetch, proving the secret-handling guarantees end-to-end).
 * No network, no real ~/.samohost: state, keys and known_hosts live in a
 * per-test temp dir.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleState, ProvisionSpec, VmRecord } from "../src/types.ts";
import { StateStore } from "../src/state/store.ts";
import { renderPreview } from "../src/commands/preview.ts";
import { PROVISION_SENTINEL_PATH } from "../src/cloudinit/hardening.ts";
import { knownHostsPathFor, type SpawnFn } from "../src/ssh/runner.ts";
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SAMOHOST_ID_LABEL,
} from "../src/providers/types.ts";
import { HetznerProvider } from "../src/providers/hetzner.ts";
import {
  runProvision,
  resolveKeyPair,
  READY_PROBE_COMMAND,
  type ProvisionDeps,
} from "../src/commands/provision.ts";
import { runDestroy } from "../src/commands/destroy.ts";
import { runList } from "../src/commands/list.ts";
import { FakeProvider, FakeProviderError } from "./fake-provider.ts";
import { makeSpec, SAMPLE_PUBKEY } from "./helpers.ts";

const ED_LINE =
  "[192.0.2.55]:2223 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01";
const RSA_LINE =
  "[192.0.2.55]:2223 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABFIXTURErsaBLOBzzzzAAAA0123456789ab";
const ED_FP = "SHA256:avywloR+f7SsRsjE1lq97ETMAqBwRNZI3yu+d8I8d7A";
const SCAN_OUTPUT = `# banner\n${RSA_LINE}\n${ED_LINE}\n`;

/** StateStore that records every persisted lifecycleState (in order). */
class RecordingStore extends StateStore {
  readonly transitions: LifecycleState[] = [];
  override upsert(record: VmRecord): VmRecord {
    this.transitions.push(record.lifecycleState);
    return super.upsert(record);
  }
  /** Distinct consecutive states (ip/fingerprint updates re-persist booting). */
  get stateSequence(): LifecycleState[] {
    return this.transitions.filter((s, i) => i === 0 || s !== this.transitions[i - 1]);
  }
}

interface SpawnScript {
  /** keyscan attempts that fail (connection refused) before succeeding. */
  keyscanFailures?: number;
  /** keyscan never succeeds at all. */
  keyscanNeverUp?: boolean;
  /** ssh sentinel probes that fail before the sentinel appears. */
  sshFailures?: number;
  /** sentinel never appears. */
  sshNeverReady?: boolean;
}

interface TestEnv {
  dir: string;
  privKeyPath: string;
  pubKeyPath: string;
  store: RecordingStore;
  fake: FakeProvider;
  spawnLog: Array<{ file: string; args: string[] }>;
  deps: ProvisionDeps;
  out: string[];
  errs: string[];
  outFn: (s: string) => void;
  errFn: (s: string) => void;
}

function makeEnv(script: SpawnScript = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "samohost-provision-"));
  const privKeyPath = join(dir, "id_ed25519");
  const pubKeyPath = join(dir, "id_ed25519.pub");
  writeFileSync(privKeyPath, "FIXTURE PRIVATE KEY (never read by samohost)\n");
  writeFileSync(pubKeyPath, SAMPLE_PUBKEY + "\n");

  const store = new RecordingStore(join(dir, "state.json"));
  const fake = new FakeProvider();
  fake.statusSequence = ["initializing", "running"];

  const spawnLog: Array<{ file: string; args: string[] }> = [];
  let keyscanCalls = 0;
  let sshCalls = 0;
  const spawn: SpawnFn = async (file, args) => {
    spawnLog.push({ file, args });
    if (file === "ssh-keyscan") {
      keyscanCalls += 1;
      if (script.keyscanNeverUp || keyscanCalls <= (script.keyscanFailures ?? 0)) {
        return { code: 1, stdout: "", stderr: "Connection refused" };
      }
      return { code: 0, stdout: SCAN_OUTPUT, stderr: "" };
    }
    if (file === "ssh") {
      sshCalls += 1;
      if (script.sshNeverReady || sshCalls <= (script.sshFailures ?? 0)) {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "SAMOHOST_PROVISION_COMPLETE\n", stderr: "" };
    }
    throw new Error(`unexpected spawn: ${file}`);
  };

  // Deterministic fake time: sleep() advances the clock.
  let nowMs = 1_000_000;
  const deps: ProvisionDeps = {
    provider: fake,
    store,
    spawn,
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    knownHostsDir: join(dir, "known_hosts.d"),
    controlDir: join(dir, "cm"),
    pollIntervalMs: 1000,
  };

  const out: string[] = [];
  const errs: string[] = [];
  return {
    dir,
    privKeyPath,
    pubKeyPath,
    store,
    fake,
    spawnLog,
    deps,
    out,
    errs,
    outFn: (s) => out.push(s),
    errFn: (s) => errs.push(s),
  };
}

function provisionSpec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return makeSpec({ name: "prov-vm", ...overrides });
}

describe("resolveKeyPair", () => {
  test("a private-key path pairs with its .pub sibling; record points at the PRIVATE key", () => {
    const env = makeEnv();
    const res = resolveKeyPair(env.privKeyPath);
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.pair.privateKeyPath).toBe(env.privKeyPath);
    expect(res.pair.publicKeyPath).toBe(env.pubKeyPath);
    expect(res.pair.publicKey).toBe(SAMPLE_PUBKEY);
  });

  test("a .pub path resolves to the same pair", () => {
    const env = makeEnv();
    const res = resolveKeyPair(env.pubKeyPath);
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.pair.privateKeyPath).toBe(env.privKeyPath);
    expect(res.pair.publicKey).toBe(SAMPLE_PUBKEY);
  });

  test("missing private or public half is an error (the ready gate needs the private key)", () => {
    const env = makeEnv();
    const lonelyPub = join(env.dir, "lonely.pub");
    writeFileSync(lonelyPub, SAMPLE_PUBKEY + "\n");
    const res = resolveKeyPair(lonelyPub);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("private");

    const res2 = resolveKeyPair(join(env.dir, "nope"));
    expect(res2.ok).toBe(false);
  });
});

describe("runProvision — happy path", () => {
  test("persists planned→creating→booting→ready and records ssh/hostkey facts", async () => {
    const env = makeEnv({ keyscanFailures: 1, sshFailures: 1 });
    const spec = provisionSpec();
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );

    expect(code).toBe(0);
    expect(env.store.stateSequence).toEqual([
      "planned",
      "creating",
      "booting",
      "ready",
    ]);

    const rec = env.store.list()[0]!;
    expect(rec.lifecycleState).toBe("ready");
    expect(rec.provider).toBe("hetzner");
    expect(rec.providerId).toBe("9001");
    expect(rec.ip).toBe("192.0.2.55");
    // The record must carry the HARDENED port + baseline non-root user so
    // ssh/status/audit work unchanged against provisioned VMs.
    expect(rec.sshPort).toBe(2223);
    expect(rec.sshUser).toBe("samo");
    // The PRIVATE key path — ssh/runner passes it to `-i`.
    expect(rec.sshKeyPath).toBe(env.privKeyPath);
    // TOFU pin: ed25519 preferred over the rsa line scanned first.
    expect(rec.hostKeyFingerprint).toBe(ED_FP);

    // The ed25519 host key line was planted into the per-VM known_hosts.
    const khPath = knownHostsPathFor(rec, env.deps.knownHostsDir);
    expect(existsSync(khPath)).toBe(true);
    expect(readFileSync(khPath, "utf8")).toContain(ED_LINE);

    expect(env.out.join("\n")).toContain("prov-vm");
  });

  test("create() is called with managed-by/samohost-id labels, ubuntu-24.04 and the spec geometry", async () => {
    const env = makeEnv();
    const spec = provisionSpec({ region: "fsn1", type: "cx32" });
    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const call = env.fake.createCalls[0]!;
    const rec = env.store.list()[0]!;
    expect(call.name).toBe("prov-vm");
    expect(call.serverType).toBe("cx32");
    expect(call.location).toBe("fsn1");
    expect(call.image).toBe("ubuntu-24.04");
    expect(call.labels[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(call.labels[SAMOHOST_ID_LABEL]).toBe(rec.id);
  });

  test("GOLDEN: provision user_data is byte-identical to the preview render", async () => {
    const env = makeEnv();
    const spec = provisionSpec();
    await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const expected = renderPreview(
      { ...spec, sshKeyPath: env.pubKeyPath },
      SAMPLE_PUBKEY,
    ).cloudInit;
    expect(env.fake.createCalls[0]!.userData).toBe(expected);
  });

  test("ready gate ordering: keyscan succeeds BEFORE any pinned ssh probe; probe checks the sentinel", async () => {
    const env = makeEnv({ keyscanFailures: 2, sshFailures: 1 });
    await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );

    const files = env.spawnLog.map((c) => c.file);
    const firstSsh = files.indexOf("ssh");
    const lastKeyscan = files.lastIndexOf("ssh-keyscan");
    expect(firstSsh).toBeGreaterThan(lastKeyscan);

    const keyscan = env.spawnLog.find((c) => c.file === "ssh-keyscan")!;
    expect(keyscan.args).toEqual(["-T", "5", "-p", "2223", "192.0.2.55"]);

    const ssh = env.spawnLog[firstSsh]!;
    expect(ssh.args).toContain("StrictHostKeyChecking=yes");
    expect(ssh.args).toContain("samo@192.0.2.55");
    expect(ssh.args).toContain(env.privKeyPath);
    const command = ssh.args[ssh.args.length - 1]!;
    expect(command).toBe(READY_PROBE_COMMAND);
    expect(command).toContain(PROVISION_SENTINEL_PATH);
    expect(command).toContain("/var/lib/cloud/instance/boot-finished");
  });

  test("--json emits the final record", async () => {
    const env = makeEnv();
    await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: true },
      env.deps,
      env.outFn,
      env.errFn,
    );
    const parsed = JSON.parse(env.out.join("\n")) as VmRecord;
    expect(parsed.lifecycleState).toBe("ready");
    expect(parsed.providerId).toBe("9001");
  });
});

describe("runProvision — failure paths", () => {
  test("validation errors abort BEFORE any state write or provider call", async () => {
    const env = makeEnv();
    const code = await runProvision(
      { spec: provisionSpec({ sshPort: 22 }), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.store.list()).toEqual([]);
    expect(env.fake.createCalls.length).toBe(0);
    expect(env.errs.join("\n")).toContain("22");
  });

  test("a missing private key aborts before any provider call", async () => {
    const env = makeEnv();
    const code = await runProvision(
      { spec: provisionSpec(), sshKey: join(env.dir, "absent") },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.fake.createCalls.length).toBe(0);
  });

  test("API failure: creating→failed persisted, normalized kind surfaced", async () => {
    const env = makeEnv();
    env.fake.failCreateWith = new FakeProviderError(
      "quota",
      "server limit exceeded",
    );
    const code = await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.store.stateSequence).toEqual(["planned", "creating", "failed"]);
    const rec = env.store.list()[0]!;
    expect(rec.lifecycleState).toBe("failed");
    expect(rec.providerId).toBe("");
    const all = env.errs.join("\n");
    expect(all).toContain("quota");
    expect(all).toContain("server limit exceeded");
  });

  test("CRASH SAFETY: the record is already persisted as `creating` while the API call is in flight", async () => {
    const env = makeEnv();
    let observed: LifecycleState | undefined;
    env.fake.onCreate = () => {
      observed = env.store.list()[0]?.lifecycleState;
    };
    await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(observed).toBe("creating");
  });

  test("readiness timeout: booting→degraded, resource recorded + reclaim hint", async () => {
    const env = makeEnv({ keyscanNeverUp: true });
    const code = await runProvision(
      {
        spec: provisionSpec({ timeoutSec: 10 }),
        sshKey: env.privKeyPath,
      },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.store.stateSequence).toEqual([
      "planned",
      "creating",
      "booting",
      "degraded",
    ]);
    const rec = env.store.list()[0]!;
    expect(rec.lifecycleState).toBe("degraded");
    // Orphan-safety: the provider resource stays recorded for reclaim.
    expect(rec.providerId).toBe("9001");
    const all = env.errs.join("\n");
    expect(all).toContain("degraded");
    expect(all).toContain("destroy");
  });

  test("sentinel never appears: degraded, but the host key pin is kept", async () => {
    const env = makeEnv({ sshNeverReady: true });
    const code = await runProvision(
      { spec: provisionSpec({ timeoutSec: 10 }), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    const rec = env.store.list()[0]!;
    expect(rec.lifecycleState).toBe("degraded");
    expect(rec.hostKeyFingerprint).toBe(ED_FP);
  });
});

describe("integration: provision→list→destroy full pass (fake provider)", () => {
  test("the whole lifecycle round-trips through one store", async () => {
    const env = makeEnv();
    const code = await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);

    // list sees the ready VM
    const listOut: string[] = [];
    expect(runList({ json: true }, env.store, (s) => listOut.push(s), () => {})).toBe(0);
    const records = JSON.parse(listOut.join("\n")) as VmRecord[];
    expect(records.length).toBe(1);
    expect(records[0]!.lifecycleState).toBe("ready");

    // destroy reclaims it
    const dCode = await runDestroy(
      { target: "prov-vm", yes: true },
      { json: false },
      { provider: env.fake, store: env.store, confirm: async () => "" },
      env.outFn,
      env.errFn,
    );
    expect(dCode).toBe(0);
    expect(env.fake.destroyCalls).toEqual(["9001"]);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
    expect(env.store.stateSequence.slice(-2)).toEqual([
      "destroying",
      "destroyed",
    ]);
  });
});

describe("integration: HetznerProvider end-to-end — secrets never leak", () => {
  const TOKEN = "hcloudSECRETtokenZZZZ99990000111122223333444455556666";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["HCLOUD_TOKEN"];
    process.env["HCLOUD_TOKEN"] = TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["HCLOUD_TOKEN"];
    else process.env["HCLOUD_TOKEN"] = saved;
  });

  function fixture(name: string): unknown {
    return JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "hetzner", name), "utf8"),
    );
  }

  test("provision via mocked Hetzner fetch: token absent from state, output and errors", async () => {
    const env = makeEnv();
    const queue = [
      { status: 201, body: fixture("create-server.json") },
      { status: 200, body: fixture("get-server-running.json") },
    ];
    const fetchMock = (async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected fetch");
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as unknown as typeof fetch;
    const provider = new HetznerProvider({ fetch: fetchMock });

    const spec = provisionSpec({ name: "samo-test-vm" });
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: true },
      { ...env.deps, provider },
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);

    const rec = env.store.list()[0]!;
    expect(rec.providerId).toBe("4711");
    expect(rec.ip).toBe("192.0.2.10");

    const stateRaw = readFileSync(env.store.path, "utf8");
    const everything = stateRaw + env.out.join("\n") + env.errs.join("\n");
    expect(everything).not.toContain(TOKEN);
    // The Hetzner create response's root_password must not be persisted either.
    expect(everything).not.toContain("FIXTUREonlyRootPw");
  });

  test("auth failure surfaces redacted: the token never reaches stderr", async () => {
    const env = makeEnv();
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: `bad token ${TOKEN}`,
          },
        }),
        { status: 401 },
      )) as unknown as typeof fetch;
    const provider = new HetznerProvider({ fetch: fetchMock });

    const code = await runProvision(
      { spec: provisionSpec(), sshKey: env.privKeyPath },
      { json: false },
      { ...env.deps, provider },
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    const all = env.errs.join("\n") + env.out.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("auth");
    expect(
      readFileSync(env.store.path, "utf8"),
    ).not.toContain(TOKEN);
  });
});

describe("runProvision — samorev PR #14 finding 2 (no-IPv4 guard)", () => {
  test("never reaches ssh gates while the provider reports no IPv4; degrades at deadline", async () => {
    const env = makeEnv();
    env.fake.forceIpv4 = null;
    env.fake.statusSequence = ["running"];
    const spec = provisionSpec();
    const code = await runProvision(
      { spec, sshKey: env.privKeyPath },
      { json: false },
      env.deps,
      env.outFn,
      env.errFn,
    );
    expect(code).not.toBe(0);
    expect(env.store.stateSequence.at(-1)).toBe("degraded");
    expect(env.spawnLog.filter((s) => s.file === "ssh-keyscan").length).toBe(0);
    expect(env.spawnLog.filter((s) => s.file === "ssh").length).toBe(0);
  });
});
