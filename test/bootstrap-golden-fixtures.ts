/**
 * Fixtures and helpers for the bootstrap golden tests
 * (test/runtime-user-hardening.test.ts).
 *
 * - bootstrap-node-legacy-sudoers.txt and bootstrap-node-legacy-unit.txt were
 *   rendered from the code before the runtime user change (commit 4477687):
 *   the sudo rules and the unit of a node app that keeps the legacy env
 *   layout must stay byte-identical to them.
 * - bootstrap-static.sh and bootstrap-static-cp-http80.sh are the whole
 *   static bootstrap script as this branch renders it. They were rendered
 *   again by the commits that changed the static script on this branch (the
 *   symbolic-link refusal in §0, the Caddy admin socket, Caddy validation as
 *   the caddy user), so they are not the static script of upstream main.
 */

import type { HostBootstrapOptions } from "../src/app/bootstrap.ts";
import type { AppRecord } from "../src/types.ts";
import { nodeApp, nodeOpts } from "./bootstrap-db-harness.ts";

export function goldenStaticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-0001",
    vmId: "vm-aaaa-0001",
    name: "my-static-site",
    kind: "static",
    repo: "example/my-static-site",
    branch: "main",
    appDir: "/opt/my-static-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://my-static-site.example.com/",
    serviceUnit: "my-static-site",
    mainHost: "my-static-site.example.com",
    ...overrides,
  };
}

export const goldenStaticOpts = { appUser: "agent" } as HostBootstrapOptions;

/** The rendered scripts that are compared with test/fixtures/bootstrap-*.sh. */
export function goldenCases(): Array<{ file: string; app: AppRecord; opts: HostBootstrapOptions }> {
  return [
    { file: "bootstrap-static.sh", app: goldenStaticApp(), opts: goldenStaticOpts },
    {
      file: "bootstrap-static-cp-http80.sh",
      app: goldenStaticApp({ mainListen: "cp-http80" }),
      opts: { ...goldenStaticOpts, firewallOpts: { controlPlaneIp: "192.0.2.10" } } as HostBootstrapOptions,
    },
  ];
}

export const goldenNodeApp = (): AppRecord => nodeApp({ mainHost: "shop.example.com", mainListen: "cp-http80" });
export const goldenNodeOpts = (): HostBootstrapOptions =>
  nodeOpts({ firewallOpts: { controlPlaneIp: "192.0.2.10" } } as Partial<HostBootstrapOptions>);

/**
 * Body of the heredoc that starts on the line ending with `<<${delimiter}`
 * and ends at the line equal to the bare delimiter name.
 */
export function heredocBody(script: string, opener: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.endsWith(opener));
  if (start < 0) throw new Error(`heredoc opener not found: ${opener}`);
  const name = opener.replace(/^<</, "").replace(/'/g, "");
  const end = lines.findIndex((l, i) => i > start && l === name);
  if (end < 0) throw new Error(`heredoc end not found: ${name}`);
  return lines.slice(start + 1, end).join("\n") + "\n";
}
