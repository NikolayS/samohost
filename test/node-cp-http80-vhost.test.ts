/**
 * Main vhost of a node app behind the control plane (`mainListen = "cp-http80"`).
 *
 * The control plane reaches the app server on port 80 only. The vhost must be
 * `http://<host>:80` (no certificate, no redirect to HTTPS), host-prep and
 * `app heal` must render the same bytes (each refuses to replace a file that
 * differs from its own render), and Caddy must keep the X-Forwarded-For value
 * sent by the control plane (reverse_proxy `trusted_proxies`). The app's
 * runtime env file gets TRUSTED_PROXIES with the same address.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHostPrepScript } from "../src/env/script.ts";
import { buildConfigHealScript } from "../src/app/heal-script.ts";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { planFromApp, renderVhost } from "../src/caddy/render.ts";
import { dbSection, makeSandbox, nodeApp, nodeOpts, runSection, sandboxScript } from "./bootstrap-db-harness.ts";

const CP = "192.0.2.10";

function cpApp() {
  return nodeApp({ mainHost: "shop.example.com", mainListen: "cp-http80", appUser: "shop" });
}

function heredoc(script: string, opener: RegExp, terminator: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => opener.test(l));
  expect(start, `heredoc opener ${opener}`).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf(terminator, start + 1);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).join("\n");
}

describe("renderVhost — trusted proxies", () => {
  test("cp-http80 vhost with trusted proxies keeps the visitor address from the control plane", () => {
    const text = renderVhost(planFromApp(cpApp(), { trustedProxies: [CP] }));
    expect(text.split("\n")[1]).toBe("http://shop.example.com:80 {");
    expect(text).toContain(`\treverse_proxy localhost:3100 {\n\t\ttrusted_proxies ${CP}\n\t}\n`);
    expect(text).not.toContain("tls internal");
  });

  test("without trusted proxies the bare directive is unchanged", () => {
    const text = renderVhost(planFromApp(cpApp()));
    expect(text).toContain("\treverse_proxy localhost:3100\n");
    expect(text).not.toContain("trusted_proxies");
  });

  test("invalid trusted proxy entries are rejected", () => {
    expect(() => planFromApp(cpApp(), { trustedProxies: ["192.0.2.10 evil"] })).toThrow(/trusted proxy/);
    expect(() => planFromApp(cpApp(), { trustedProxies: ["192.0.2.0/33"] })).toThrow(/trusted proxy/);
  });
});

describe("host-prep and heal render one main vhost for node cp-http80 apps", () => {
  test("host-prep stages exactly the heal render", () => {
    const app = cpApp();
    const hostPrep = buildHostPrepScript(app, "samo", { mainVhostTrustedProxy: CP });
    const heal = buildConfigHealScript(app, { controlPlaneIp: CP });
    const staged = heredoc(hostPrep, /^cat > \/etc\/caddy\/sites\.d\/\.staged-00-main-shop\.caddy <<'CADDY'$/, "CADDY");
    const healed = heredoc(heal, /<<'SAMOHOST_MAIN_VHOST_CONTENT'$/, "SAMOHOST_MAIN_VHOST_CONTENT");
    expect(staged).toBe(healed);
    expect(staged + "\n").toBe(renderVhost(planFromApp(app, { trustedProxies: [CP] })));
    expect(staged).toContain("http://shop.example.com:80 {");
    expect(staged).toContain(`trusted_proxies ${CP}`);
  });

  test("host-prep no longer writes the bare-host form that makes Caddy request a certificate", () => {
    const hostPrep = buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP });
    // The bare-host form appears only as the previous form the guard replaces.
    const staged = heredoc(hostPrep, /^cat > \/etc\/caddy\/sites\.d\/\.staged-00-main-shop\.caddy <<'CADDY'$/, "CADDY");
    expect(staged).not.toContain("shop.example.com {\n\treverse_proxy localhost:3100\n}");
    expect(hostPrep).not.toContain("\nshop.example.com {\n\treverse_proxy localhost:3100\n}\nCADDY");
  });

  test("the trusted proxy does not add a firewall rule in host-prep", () => {
    const hostPrep = buildHostPrepScript(cpApp(), "samo", { mainVhostTrustedProxy: CP });
    expect(hostPrep).not.toContain(`from '${CP}' to any port 80`);
  });

  test("a node app without cp-http80 keeps the previous host-prep vhost", () => {
    const app = nodeApp({ mainHost: "shop.example.com" });
    const hostPrep = buildHostPrepScript(app, "samo", { mainVhostTrustedProxy: CP });
    expect(hostPrep).toContain("shop.example.com {\n\treverse_proxy localhost:3100\n}\nCADDY");
  });
});

describe("bootstrap — TRUSTED_PROXIES in the runtime env file", () => {
  test("cp-http80 node app: runtime env file trusts the control-plane address", () => {
    const sb = makeSandbox();
    try {
      const script = sandboxScript(join(sb.dir, "staging.env"), cpApp(), { firewallOpts: { controlPlaneIp: CP } });
      expect(runSection(sb, dbSection(script)).status).toBe(0);
      // The app's TCP peer is Caddy on loopback (it dials localhost and the app
      // listens on 0.0.0.0), then the control plane.
      expect(readFileSync(join(sb.dir, "staging.env"), "utf8")).toMatch(new RegExp(`^TRUSTED_PROXIES=127\\.0\\.0\\.1,${CP.replace(/\./g, "\\.")}$`, "m"));
      expect(readFileSync(join(sb.dir, "migrate.env"), "utf8")).not.toContain("TRUSTED_PROXIES");
    } finally {
      sb.cleanup();
    }
  });

  test("invalid control-plane address is rejected", () => {
    expect(() =>
      buildHostBootstrapScript(cpApp(), nodeOpts({ firewallOpts: { controlPlaneIp: "192.0.2.10;id" } })),
    ).toThrow(/controlPlaneIp/);
  });
});

describe("favicon fallback route of a cp-http80 node vhost", () => {
  test("its reverse_proxy keeps the same trusted_proxies as the default route", async () => {
    const { planFromApp, renderVhost, mainVhostTrustedProxies } = await import("../src/caddy/render.ts");
    const app = nodeApp({ mainHost: "shop.example.com", mainListen: "cp-http80" });
    const text = renderVhost(planFromApp(app, { trustedProxies: mainVhostTrustedProxies(app, CP) }));
    const lines = text.split("\n");
    const fav = lines.findIndex((l) => l.includes("handle @samohost_favicon"));
    expect(fav).toBeGreaterThan(0);
    expect(lines[fav + 1]).toBe("\t\treverse_proxy localhost:3100 {");
    expect(lines[fav + 2]).toBe(`\t\t\ttrusted_proxies ${CP}`);
    expect(text.split(`trusted_proxies ${CP}`).length - 1).toBe(2);
  });

  test("without trusted proxies the favicon route is unchanged", async () => {
    const { faviconVhostLinesNode } = await import("../src/caddy/favicon.ts");
    expect(faviconVhostLinesNode("shop", 3100)[2]).toBe("\t\treverse_proxy localhost:3100 {");
    expect(faviconVhostLinesNode("shop", 3100)[3]).toBe("\t\t\t@fav404 status 404");
  });
});
