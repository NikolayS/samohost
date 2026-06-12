/**
 * `samohost destroy` (SPEC §3 story 5, §5 state machine).
 *
 * Covers: typed confirmation (the cost-leak guard), --yes, volume surfacing
 * (reported, NEVER deleted), destroying→destroyed transitions, API-failure
 * consistency (state stays `destroying`, retry completes), notFound treated
 * as already-gone, records without a provider resource, and crash-reclaim of
 * stuck creating/booting records.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleState, VmRecord } from "../src/types.ts";
import { StateStore } from "../src/state/store.ts";
import { runDestroy, type DestroyDeps } from "../src/commands/destroy.ts";
import { FakeProvider, FakeProviderError } from "./fake-provider.ts";

function makeVm(overrides: Partial<VmRecord> = {}): VmRecord {
  const now = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "hetzner",
    providerId: "9001",
    name: "doomed-vm",
    ip: "192.0.2.55",
    sshKeyPath: "/tmp/fixture/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:avywloR+f7SsRsjE1lq97ETMAqBwRNZI3yu+d8I8d7A",
    region: "nbg1",
    type: "cx22",
    modules: [],
    lifecycleState: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface Env {
  store: StateStore;
  fake: FakeProvider;
  out: string[];
  errs: string[];
  deps: (confirmAnswer?: string) => DestroyDeps & { confirmCalls: string[] };
  outFn: (s: string) => void;
  errFn: (s: string) => void;
}

function makeEnv(record: VmRecord | undefined, withServer = true): Env {
  const dir = mkdtempSync(join(tmpdir(), "samohost-destroy-"));
  const store = new StateStore(join(dir, "state.json"));
  const fake = new FakeProvider();
  if (record) {
    store.upsert(record);
    if (withServer && record.providerId) {
      fake.servers.set(record.providerId, {
        providerId: record.providerId,
        name: record.name,
        status: "running",
        ipv4: record.ip,
        labels: {},
        volumeIds: [],
      });
    }
  }
  const out: string[] = [];
  const errs: string[] = [];
  return {
    store,
    fake,
    out,
    errs,
    outFn: (s) => out.push(s),
    errFn: (s) => errs.push(s),
    deps: (confirmAnswer = "") => {
      const confirmCalls: string[] = [];
      return {
        provider: fake,
        store,
        confirm: async (prompt: string) => {
          confirmCalls.push(prompt);
          return confirmAnswer;
        },
        confirmCalls,
      };
    },
  };
}

describe("runDestroy — confirmation", () => {
  test("without --yes, the operator must type the exact VM name", async () => {
    const env = makeEnv(makeVm());
    const deps = env.deps("doomed-vm");
    const code = await runDestroy(
      { target: "doomed-vm", yes: false },
      { json: false },
      deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(deps.confirmCalls.length).toBe(1);
    expect(deps.confirmCalls[0]).toContain("doomed-vm");
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
  });

  test("a wrong confirmation aborts with NO state change and NO API call", async () => {
    const env = makeEnv(makeVm());
    const code = await runDestroy(
      { target: "doomed-vm", yes: false },
      { json: false },
      env.deps("oops-wrong"),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.store.list()[0]!.lifecycleState).toBe("ready");
    expect(env.fake.destroyCalls).toEqual([]);
    expect(env.errs.join("\n")).toContain("doomed-vm");
  });

  test("--yes skips the prompt entirely", async () => {
    const env = makeEnv(makeVm());
    const deps = env.deps("never-used");
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      deps,
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(deps.confirmCalls).toEqual([]);
  });
});

describe("runDestroy — lifecycle + provider", () => {
  test("ready → destroying → destroyed; provider DELETE issued once", async () => {
    const env = makeEnv(makeVm());
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(env.fake.destroyCalls).toEqual(["9001"]);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
    expect(env.out.join("\n")).toContain("destroyed");
  });

  test("target may be the record id as well as the name", async () => {
    const vm = makeVm();
    const env = makeEnv(vm);
    const code = await runDestroy(
      { target: vm.id, yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
  });

  test("attached volumes are SURFACED (id/name/size) and never deleted", async () => {
    const vm = makeVm();
    const env = makeEnv(vm);
    env.fake.volumesByServer.set("9001", [
      { id: "70101", name: "doomed-data", sizeGb: 50 },
    ]);
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    const all = env.out.join("\n") + "\n" + env.errs.join("\n");
    expect(all).toContain("70101");
    expect(all).toContain("doomed-data");
    expect(all).toContain("50");
    expect(all.toLowerCase()).toContain("not deleted");
    // The server delete still went through; nothing else was deleted.
    expect(env.fake.destroyCalls).toEqual(["9001"]);
  });

  test("API failure leaves state=destroying (consistent, retryable); retry completes", async () => {
    const env = makeEnv(makeVm());
    env.fake.failDestroyOnceWith = new FakeProviderError(
      "transient",
      "API temporarily unavailable",
    );
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroying");
    const all = env.errs.join("\n");
    expect(all).toContain("transient");
    expect(all.toLowerCase()).toContain("destroy");

    // Retry from `destroying` succeeds and reaches `destroyed`.
    const retry = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(retry).toBe(0);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
  });

  test("provider notFound = already gone: still transitions to destroyed", async () => {
    const env = makeEnv(makeVm(), /* withServer */ false);
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
  });

  test("a failed record with no provider resource is destroyed without any API call", async () => {
    const env = makeEnv(makeVm({ lifecycleState: "failed", providerId: "" }));
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(0);
    expect(env.fake.destroyCalls).toEqual([]);
    expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
  });

  const RECLAIMABLE: LifecycleState[] = [
    "creating",
    "booting",
    "degraded",
    "adopted",
  ];
  for (const state of RECLAIMABLE) {
    test(`crash-reclaim: destroy is legal from '${state}'`, async () => {
      const env = makeEnv(makeVm({ lifecycleState: state }));
      const code = await runDestroy(
        { target: "doomed-vm", yes: true },
        { json: false },
        env.deps(),
        env.outFn,
        env.errFn,
      );
      expect(code).toBe(0);
      expect(env.store.list()[0]!.lifecycleState).toBe("destroyed");
    });
  }
});

describe("runDestroy — guards", () => {
  test("unknown target → error, exit 1", async () => {
    const env = makeEnv(undefined);
    const code = await runDestroy(
      { target: "no-such-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.errs.join("\n")).toContain("no-such-vm");
  });

  test("an already-destroyed record cannot be destroyed again", async () => {
    const env = makeEnv(makeVm({ lifecycleState: "destroyed" }));
    const code = await runDestroy(
      { target: "doomed-vm", yes: true },
      { json: false },
      env.deps(),
      env.outFn,
      env.errFn,
    );
    expect(code).toBe(1);
    expect(env.fake.destroyCalls).toEqual([]);
    expect(env.errs.join("\n")).toContain("destroyed");
  });
});
