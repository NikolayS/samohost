import { describe, expect, test } from "bun:test";
import { checkCiGreen } from "../src/app/cigate.ts";

/** Build a fake fetch that returns the given workflow_runs JSON. */
function fakeFetch(
  runs: Array<{ status?: string; conclusion?: string | null }>,
  opts: { ok?: boolean; capture?: { url?: string; auth?: string } } = {},
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (opts.capture) {
      opts.capture.url = String(url);
      const h = (init?.headers ?? {}) as Record<string, string>;
      opts.capture.auth = h["Authorization"];
    }
    return {
      ok: opts.ok ?? true,
      json: async () => ({ workflow_runs: runs }),
    } as Response;
  }) as unknown as typeof fetch;
}

const REPO = "Tanya301/field-record-1";
const SHA = "abc1234def5678901234567890abcdef12345678";

describe("checkCiGreen decision table", () => {
  test("success → 'success'", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ status: "completed", conclusion: "success" }]),
      env: {},
    });
    expect(r).toBe("success");
  });

  test("failure → 'failure' (refuse), even alongside a success", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
      env: {},
    });
    expect(r).toBe("failure");
  });

  test("cancelled → 'failure' (refuse)", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ status: "completed", conclusion: "cancelled" }]),
      env: {},
    });
    expect(r).toBe("failure");
  });

  test("in_progress (no conclusion) → 'pending'", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ status: "in_progress", conclusion: null }]),
      env: {},
    });
    expect(r).toBe("pending");
  });

  test("pending outranks a sibling success (wait for the in-flight run)", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([
        { status: "completed", conclusion: "success" },
        { status: "queued", conclusion: null },
      ]),
      env: {},
    });
    expect(r).toBe("pending");
  });

  test("no runs → 'none'", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([]),
      env: {},
    });
    expect(r).toBe("none");
  });

  test("non-ok HTTP → 'none' (unverifiable; caller waits)", async () => {
    const r = await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ conclusion: "success" }], { ok: false }),
      env: {},
    });
    expect(r).toBe("none");
  });

  test("transport error → 'none' (never throws)", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await checkCiGreen(REPO, SHA, { fetch: throwing, env: {} });
    expect(r).toBe("none");
  });
});

describe("checkCiGreen token + url", () => {
  test("uses GH_TOKEN as Bearer and targets head_sha", async () => {
    const cap: { url?: string; auth?: string } = {};
    await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ conclusion: "success" }], { capture: cap }),
      env: { GH_TOKEN: "ghp_secret_token_value" },
    });
    expect(cap.auth).toBe("Bearer ghp_secret_token_value");
    expect(cap.url).toContain(`/repos/${REPO}/actions/runs`);
    expect(cap.url).toContain(`head_sha=${SHA}`);
  });

  test("falls back to GITHUB_TOKEN when GH_TOKEN is absent", async () => {
    const cap: { url?: string; auth?: string } = {};
    await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ conclusion: "success" }], { capture: cap }),
      env: { GITHUB_TOKEN: "gho_fallback" },
    });
    expect(cap.auth).toBe("Bearer gho_fallback");
  });

  test("no token → no Authorization header (anonymous)", async () => {
    const cap: { url?: string; auth?: string } = {};
    await checkCiGreen(REPO, SHA, {
      fetch: fakeFetch([{ conclusion: "success" }], { capture: cap }),
      env: {},
    });
    expect(cap.auth).toBeUndefined();
  });
});
