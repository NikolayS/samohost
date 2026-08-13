/**
 * recipe-umami.test.ts — RED → GREEN TDD for the "recipe umami-site" command.
 *
 * RED commit: all assertions are written; src/commands/recipe-umami.ts does not
 * exist yet, so every import below fails and every test fails.
 *
 * GREEN commit: implement src/commands/recipe-umami.ts and wire it into
 * src/cli.ts, then add the template + docs files.
 *
 * Coverage:
 *   - rendered manifest parses via parseSamohostToml with ok:true
 *   - two distinct slugs yield distinct name/dbName/appUser/port/host
 *   - healthUrl ends with /api/heartbeat
 *   - dbBackend === "none" and previewDbBackend === "none"
 *   - rendered TOML contains no "releaseTagPattern"
 *   - CLI parse: "recipe umami-site" produces a ParsedRecipeUmamiSite kind
 *   - CLI parse: missing required flags throw UsageError
 */

import { describe, expect, test } from "bun:test";
import { parseSamohostToml } from "../src/manifest/toml.ts";
import {
  renderUmamiManifest,
  type UmamiSiteInput,
} from "../src/commands/recipe-umami.ts";
import { parseArgs, UsageError } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<UmamiSiteInput> = {}): UmamiSiteInput {
  return {
    vm: "samo-we-acme",
    slug: "acme",
    host: "analytics.acme.com",
    port: 3100,
    umamiRepo: "samo-agent/umami-deploy",
    umamiRef: "v3",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderUmamiManifest — template rendering
// ---------------------------------------------------------------------------

describe("renderUmamiManifest — rendered manifest parses ok", () => {
  test("rendered TOML parses via parseSamohostToml with ok=true", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) {
      throw new Error(
        "expected ok=true; errors: " + result.errors.join(", "),
      );
    }
    expect(result.ok).toBe(true);
  });

  test("name is 'umami-<slug>'", () => {
    const rendered = renderUmamiManifest(baseInput({ slug: "acme" }));
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.name).toBe("umami-acme");
  });

  test("healthUrl ends with /api/heartbeat", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.healthUrl.endsWith("/api/heartbeat")).toBe(true);
  });

  test("healthUrl uses the supplied port", () => {
    const rendered = renderUmamiManifest(baseInput({ port: 3200 }));
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.healthUrl).toContain("3200");
  });

  test("dbBackend is 'none'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.dbBackend).toBe("none");
  });

  test("previewDbBackend is 'none'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.previewDbBackend).toBe("none");
  });

  test("rendered TOML contains no 'releaseTagPattern'", () => {
    const rendered = renderUmamiManifest(baseInput());
    expect(rendered).not.toContain("releaseTagPattern");
  });

  test("mainHost is the supplied host", () => {
    const rendered = renderUmamiManifest(baseInput({ host: "analytics.acme.com" }));
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.mainHost).toBe("analytics.acme.com");
  });

  test("mainListen is 'cp-http80'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.mainListen).toBe("cp-http80");
  });

  test("databaseUrlEnv is 'DATABASE_URL'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.databaseUrlEnv).toBe("DATABASE_URL");
  });

  test("envDbVars contains 'DATABASE_URL'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.envDbVars).toEqual(expect.arrayContaining(["DATABASE_URL"]));
  });

  test("buildCmd is '/usr/bin/true'", () => {
    const rendered = renderUmamiManifest(baseInput());
    const result = parseSamohostToml(rendered);
    if (!result.ok) throw new Error(result.errors.join(", "));
    expect(result.app.buildCmd).toBe("/usr/bin/true");
  });
});

// ---------------------------------------------------------------------------
// Two distinct slugs → distinct identifiers
// ---------------------------------------------------------------------------

describe("renderUmamiManifest — two slugs yield distinct identifiers", () => {
  test("distinct name fields", () => {
    const r1 = renderUmamiManifest(baseInput({ slug: "alpha", port: 3101 }));
    const r2 = renderUmamiManifest(baseInput({ slug: "beta", port: 3102, host: "analytics.beta.com" }));
    const p1 = parseSamohostToml(r1);
    const p2 = parseSamohostToml(r2);
    if (!p1.ok) throw new Error(p1.errors.join(", "));
    if (!p2.ok) throw new Error(p2.errors.join(", "));
    expect(p1.app.name).not.toBe(p2.app.name);
    expect(p1.app.name).toBe("umami-alpha");
    expect(p2.app.name).toBe("umami-beta");
  });

  test("distinct serviceUnit fields", () => {
    const r1 = renderUmamiManifest(baseInput({ slug: "alpha", port: 3101 }));
    const r2 = renderUmamiManifest(baseInput({ slug: "beta", port: 3102, host: "analytics.beta.com" }));
    const p1 = parseSamohostToml(r1);
    const p2 = parseSamohostToml(r2);
    if (!p1.ok) throw new Error(p1.errors.join(", "));
    if (!p2.ok) throw new Error(p2.errors.join(", "));
    expect(p1.app.serviceUnit).not.toBe(p2.app.serviceUnit);
  });

  test("distinct healthUrl (distinct ports)", () => {
    const r1 = renderUmamiManifest(baseInput({ slug: "alpha", port: 3101 }));
    const r2 = renderUmamiManifest(baseInput({ slug: "beta", port: 3102, host: "analytics.beta.com" }));
    const p1 = parseSamohostToml(r1);
    const p2 = parseSamohostToml(r2);
    if (!p1.ok) throw new Error(p1.errors.join(", "));
    if (!p2.ok) throw new Error(p2.errors.join(", "));
    expect(p1.app.healthUrl).not.toBe(p2.app.healthUrl);
  });

  test("distinct mainHost", () => {
    const r1 = renderUmamiManifest(baseInput({ slug: "alpha", host: "analytics.alpha.com", port: 3101 }));
    const r2 = renderUmamiManifest(baseInput({ slug: "beta", host: "analytics.beta.com", port: 3102 }));
    const p1 = parseSamohostToml(r1);
    const p2 = parseSamohostToml(r2);
    if (!p1.ok) throw new Error(p1.errors.join(", "));
    if (!p2.ok) throw new Error(p2.errors.join(", "));
    expect(p1.app.mainHost).toBe("analytics.alpha.com");
    expect(p2.app.mainHost).toBe("analytics.beta.com");
  });
});

// ---------------------------------------------------------------------------
// CLI parse: "recipe umami-site" subcommand
// ---------------------------------------------------------------------------

describe("parseArgs — recipe umami-site subcommand", () => {
  const validArgs = [
    "recipe",
    "umami-site",
    "--vm", "samo-we-acme",
    "--site", "acme",
    "--host", "analytics.acme.com",
    "--port", "3100",
    "--umami-repo", "samo-agent/umami-deploy",
    "--umami-ref", "v3",
  ];

  test("parses to kind='recipe-umami-site'", () => {
    const cmd = parseArgs(validArgs);
    expect(cmd.kind).toBe("recipe-umami-site");
  });

  test("input.slug is the --site value", () => {
    const cmd = parseArgs(validArgs);
    if (cmd.kind !== "recipe-umami-site") throw new Error("wrong kind");
    expect(cmd.input.slug).toBe("acme");
  });

  test("input.host is the --host value", () => {
    const cmd = parseArgs(validArgs);
    if (cmd.kind !== "recipe-umami-site") throw new Error("wrong kind");
    expect(cmd.input.host).toBe("analytics.acme.com");
  });

  test("input.port is the numeric --port value", () => {
    const cmd = parseArgs(validArgs);
    if (cmd.kind !== "recipe-umami-site") throw new Error("wrong kind");
    expect(cmd.input.port).toBe(3100);
  });

  test("--umami-ref defaults to 'v3' when omitted", () => {
    const argsNoRef = validArgs.filter((a, i) => a !== "--umami-ref" && validArgs[i - 1] !== "--umami-ref");
    const cmd = parseArgs(argsNoRef);
    if (cmd.kind !== "recipe-umami-site") throw new Error("wrong kind");
    expect(cmd.input.umamiRef).toBe("v3");
  });

  test("missing --vm throws UsageError", () => {
    const args = validArgs.filter((a, i) => a !== "--vm" && validArgs[i - 1] !== "--vm");
    expect(() => parseArgs(args)).toThrow(UsageError);
  });

  test("missing --site throws UsageError", () => {
    const args = validArgs.filter((a, i) => a !== "--site" && validArgs[i - 1] !== "--site");
    expect(() => parseArgs(args)).toThrow(UsageError);
  });

  test("missing --host throws UsageError", () => {
    const args = validArgs.filter((a, i) => a !== "--host" && validArgs[i - 1] !== "--host");
    expect(() => parseArgs(args)).toThrow(UsageError);
  });

  test("missing --port throws UsageError", () => {
    const args = validArgs.filter((a, i) => a !== "--port" && validArgs[i - 1] !== "--port");
    expect(() => parseArgs(args)).toThrow(UsageError);
  });

  test("missing --umami-repo throws UsageError", () => {
    const args = validArgs.filter((a, i) => a !== "--umami-repo" && validArgs[i - 1] !== "--umami-repo");
    expect(() => parseArgs(args)).toThrow(UsageError);
  });
});
