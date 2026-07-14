import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildControlPlaneMainRouteReconcileScript,
  controlPlaneMainRouteFingerprint,
  controlPlaneMainRoutePath,
  needsControlPlaneMainRoute,
  renderControlPlaneMainRoute,
} from "../src/caddy/control-plane.ts";
import {
  buildProjectMainRouteBeginScript,
  buildProjectMainRouteCommitScript,
  buildProjectMainRoutePrepareScript,
  buildProjectMainRouteRollbackScript,
} from "../src/caddy/project-main.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";
import { buildDeployScript } from "../src/app/script.ts";

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-friends-1111",
    vmId: "vm-gregg-1111",
    name: "friends-of-twin-peaks",
    kind: "static",
    repo: "NikolayS/friends-of-twin-peaks",
    branch: "main",
    appDir: "/opt/friends-of-twin-peaks/app/dist",
    buildCmd: "npm run build",
    healthUrl: "http://127.0.0.1/version.json",
    serviceUnit: "friends-of-twin-peaks",
    mainHost: "friends-of-twin-peaks.samo.team",
    mainListen: "cp-http80",
    ...overrides,
  };
}

function vm(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-gregg-1111",
    provider: "hetzner",
    providerId: "123",
    name: "gregg-sites",
    ip: "167.233.128.162",
    sshKeyPath: "/home/samo/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    region: "fsn1",
    type: "cx33",
    modules: [],
    lifecycleState: "ready",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("control-plane production mainHost routing", () => {
  test("explicit cp-http80 renders the exact TLS -> app VM:80 chain", () => {
    const rendered = renderControlPlaneMainRoute(app(), vm());
    expect(rendered).toContain("friends-of-twin-peaks.samo.team {");
    expect(rendered).toContain("\ttls internal");
    expect(rendered).toContain("\treverse_proxy 167.233.128.162:80 {");
    expect(rendered).toContain(
      "\t\theader_up Host friends-of-twin-peaks.samo.team",
    );
    expect(rendered).toContain("\t\theader_up X-Real-IP {remote_host}");
    expect(rendered).not.toContain("file_server");
  });

  test("only explicit cp-http80 apps opt into central routing", () => {
    expect(needsControlPlaneMainRoute(app())).toBe(true);
    expect(needsControlPlaneMainRoute(app({ mainListen: "tls" }))).toBe(false);
    expect(needsControlPlaneMainRoute(app({ mainListen: undefined }))).toBe(false);
    expect(needsControlPlaneMainRoute(app({ mainHost: undefined }))).toBe(false);
  });

  test("two apps on one VM own independent stable files", () => {
    const friends = app();
    const gregg = app({
      id: "app-gregg-2222",
      name: "gregg-brandalise",
      mainHost: "gregg-brandalise.samo.team",
    });
    expect(controlPlaneMainRoutePath(friends)).not.toBe(
      controlPlaneMainRoutePath(gregg),
    );
    expect(controlPlaneMainRoutePath(friends)).toContain(
      "05-samohost-main-friends-of-twin-peaks-",
    );

    // A manifest update retains AppRecord.id, so it atomically replaces the
    // same file instead of leaving the old hostname routed.
    expect(
      controlPlaneMainRoutePath(
        app({ mainHost: "friends-new.samo.team", name: "friends-renamed" }),
      ),
    ).not.toBe(controlPlaneMainRoutePath(friends));
    expect(
      controlPlaneMainRoutePath(app({ mainHost: "friends-new.samo.team" })),
    ).toBe(controlPlaneMainRoutePath(friends));
  });

  test("routing fingerprint covers host, mode, and VM IP", () => {
    const base = controlPlaneMainRouteFingerprint(app(), vm());
    expect(
      controlPlaneMainRouteFingerprint(
        app({ mainHost: "gregg-brandalise.samo.team" }),
        vm(),
      ),
    ).not.toBe(base);
    expect(
      controlPlaneMainRouteFingerprint(app(), vm({ ip: "167.233.128.163" })),
    ).not.toBe(base);
    expect(
      controlPlaneMainRouteFingerprint(app({ mainListen: "tls" }), vm()),
    ).not.toBe(base);
    expect(controlPlaneMainRouteFingerprint(app(), vm())).toBe(base);
  });

  test("fails closed on invalid host and VM IP", () => {
    expect(() =>
      renderControlPlaneMainRoute(app({ mainHost: "bad host" }), vm()),
    ).toThrow(/invalid mainHost/);
    expect(() => renderControlPlaneMainRoute(app(), vm({ ip: "not-an-ip" }))).toThrow(
      /invalid VM IP/,
    );
  });

  test("apply script stages atomically, validates before reload, and rolls back", () => {
    const script = buildControlPlaneMainRouteReconcileScript(app(), vm());
    expect(script).toContain("install -m 0644");
    expect(script).toContain('mv -f "${SNIPPET}.new" "$SNIPPET"');
    expect(script.indexOf("caddy validate")).toBeLessThan(
      script.lastIndexOf("systemctl reload caddy"),
    );
    expect(script).toContain('mv -f "$BACKUP" "$SNIPPET"');
    expect(script).toContain("COMMITTED=0");
    expect(script).toContain("trap rollback EXIT HUP INT TERM");
    expect(script).toContain("already exists outside samohost");
    expect(script).not.toContain("tee -a");
    expect(script).not.toContain(">> /etc/caddy/Caddyfile");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  test("tls/unhosted reconciliation removes only the stable managed file", () => {
    const managedPath = controlPlaneMainRoutePath(app());
    const script = buildControlPlaneMainRouteReconcileScript(
      app({ mainListen: "tls" }),
      vm(),
    );
    expect(script).toContain(managedPath);
    expect(script).toContain('rm -f "$SNIPPET"');
    expect(script).toContain("caddy validate");
    expect(script).toContain("systemctl reload caddy");
    expect(script).toContain("absent (no-op)");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  test("project-VM transaction scripts are bash-clean and keep rollback state", () => {
    const fingerprint = controlPlaneMainRouteFingerprint(app(), vm());
    const scripts = [
      buildProjectMainRouteBeginScript(app(), fingerprint),
      buildProjectMainRoutePrepareScript(app(), fingerprint),
      buildProjectMainRouteRollbackScript(app(), fingerprint),
      buildProjectMainRouteCommitScript(app(), fingerprint),
      buildProjectMainRoutePrepareScript(
        app({ mainListen: "tls" }),
        controlPlaneMainRouteFingerprint(app({ mainListen: "tls" }), vm()),
      ),
      buildProjectMainRoutePrepareScript(
        app({ mainHost: undefined, mainListen: undefined }),
        controlPlaneMainRouteFingerprint(
          app({ mainHost: undefined, mainListen: undefined }),
          vm(),
        ),
      ),
    ];
    for (const script of scripts) {
      expect(spawnSync("bash", ["-n"], { input: script }).status, script).toBe(0);
    }
    expect(scripts[1]).toContain("project main route prepared and healthy");
    expect(scripts[2]).toContain("restore_previous");
    expect(scripts[2]).toContain("restored project route is not healthy");
  });

  test("release-static project transaction scripts snapshot and restore the base Caddyfile", () => {
    const releaseApp = app({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    const fingerprint = controlPlaneMainRouteFingerprint(releaseApp, vm());
    const scripts = [
      buildProjectMainRouteBeginScript(releaseApp, fingerprint),
      buildProjectMainRoutePrepareScript(releaseApp, fingerprint),
      buildProjectMainRouteRollbackScript(releaseApp, fingerprint),
      buildProjectMainRouteCommitScript(releaseApp, fingerprint),
    ];
    for (const script of scripts) {
      expect(spawnSync("bash", ["-n"], { input: script }).status, script).toBe(0);
    }
    expect(scripts[0]).toContain('cat -- "$CADDYFILE" > "$TXN/base.caddy"');
    expect(scripts[1]).toContain("restore_base_files");
    expect(scripts[2]).toContain("/etc/caddy/.samohost-next-Caddyfile");
  });

  test("static deploy with routing drift keeps the old vhost beside a transition", () => {
    const script = buildDeployScript(app(), {
      sha: "a".repeat(40),
      deferStaticCleanup: true,
    });
    expect(spawnSync("bash", ["-n"], { input: script }).status, script).toBe(0);
    expect(script).toContain("SAMOHOST_OLD_ROUTE_ADDRESS");
    expect(script).toContain("01-samohost-transition-");
    expect(script).toContain("Prior release cleanup is deferred");
  });

  test("rendered route passes the installed Caddy validator", () => {
    const caddy = spawnSync("caddy", ["version"], { encoding: "utf8" });
    if (caddy.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "samohost-cp-route-"));
    try {
      const config = join(dir, "Caddyfile");
      writeFileSync(config, renderControlPlaneMainRoute(app(), vm()) + "\n");
      const validated = spawnSync(
        "caddy",
        ["validate", "--config", config],
        { encoding: "utf8" },
      );
      expect(validated.status, validated.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
