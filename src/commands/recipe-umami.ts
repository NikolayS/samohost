/**
 * recipe-umami.ts — "samohost recipe umami-site" command.
 *
 * Renders a .samohost.toml manifest for a per-site Umami analytics instance,
 * registers it via the existing runAppRegisterFromToml path, and prints the
 * operator steps needed to bring the app live.
 *
 * Design rules (from the task brief):
 *   - Umami is a NODE APP: one AppRecord per site + its own managed Postgres
 *     DB + its own Caddy mainHost vhost. Everything lives on the client VM.
 *   - Build runs OFF-VM: buildCmd="/usr/bin/true" + prebuilt standalone
 *     artifact committed in the deploy repo (same pattern as static sites).
 *   - No releaseTagPattern — upstream Umami tags (v2.x/v3.x) do not match
 *     samohost's date grammar; pin via branch/ref instead.
 *   - dbBackend="none" + previewDbBackend="none": Umami manages its own DB;
 *     samohost preview pipeline skips DB phases.
 *
 * This module is pure orchestration: it renders the manifest template, calls
 * runAppRegisterFromToml (no new infra code), and prints operator steps to
 * stdout.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAppRegisterFromToml } from "./app.ts";
import { StateStore } from "../state/store.ts";
import { AppStore } from "../state/apps.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UmamiSiteInput {
  /** VM name or id the Umami instance will live on. */
  vm: string;
  /** Short site slug (e.g. "acme"). Derives name, dbName, appUser. */
  slug: string;
  /** Public FQDN for the Umami dashboard (e.g. analytics.acme.com). */
  host: string;
  /** TCP port Umami's standalone server will listen on (e.g. 3100). */
  port: number;
  /** GitHub owner/name of the Umami deploy repo (prebuilt standalone). */
  umamiRepo: string;
  /**
   * Git ref/branch to track in the deploy repo.
   * Default: "v3" (current stable Umami release line).
   *
   * NOTE: PG18/Prisma compatibility must be runtime-verified at first deploy.
   * If Prisma refuses to connect to PG18, check the Umami release notes for
   * the minimum required Prisma engine version and pin accordingly.
   */
  umamiRef: string;
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Path to the bundled TOML template (relative to the samohost source tree). */
const TEMPLATE_PATH = new URL(
  "../../templates/recipes/umami/umami-site.samohost.toml.tmpl",
  import.meta.url,
).pathname;

/**
 * Derive a safe Linux app-user name from a slug (max 32 chars, no leading
 * digit, lowercase, hyphen-safe).  Uses "umami-" prefix + first 26 chars of
 * the slug to stay under the 32-char limit.
 */
function deriveAppUser(slug: string): string {
  // Slugs are already lowercase hyphen-safe (validated at parse time).
  // Prefix "umami-" (6 chars) + up to 26 slug chars = max 32.
  return `umami-${slug.slice(0, 26)}`;
}

/**
 * Render the Umami site manifest template with the supplied inputs.
 *
 * Returns a ready-to-parse .samohost.toml string.  The rendered output is
 * written to a temp file and parsed via parseSamohostToml downstream.
 */
export function renderUmamiManifest(input: UmamiSiteInput): string {
  const tmpl = readFileSync(TEMPLATE_PATH, "utf8");
  const name = `umami-${input.slug}`;
  const appUser = deriveAppUser(input.slug);

  return tmpl
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{repo\}\}/g, input.umamiRepo)
    .replace(/\{\{ref\}\}/g, input.umamiRef)
    .replace(/\{\{host\}\}/g, input.host)
    .replace(/\{\{port\}\}/g, String(input.port))
    .replace(/\{\{appUser\}\}/g, appUser);
}

// ---------------------------------------------------------------------------
// Derived identifiers
// ---------------------------------------------------------------------------

/**
 * Postgres database name for this Umami instance.
 * Converts hyphens to underscores so it is a valid PG identifier.
 */
export function deriveDbName(slug: string): string {
  return `umami_${slug.replace(/-/g, "_")}`;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface UmamiRecipeResult {
  exitCode: number;
  /** The rendered manifest text (for debugging). */
  manifest: string;
}

/**
 * Run the "recipe umami-site" command:
 *   1. Render the manifest template.
 *   2. Register the app via runAppRegisterFromToml (writes to the state store).
 *   3. Print operator next-steps to stdout.
 *
 * Uses the same stores as the CLI dispatch layer so state is persisted.
 */
export function runRecipeUmamiSite(
  input: UmamiSiteInput,
  vmStore: StateStore,
  appStore: AppStore,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const manifest = renderUmamiManifest(input);
  const name = `umami-${input.slug}`;
  const dbName = deriveDbName(input.slug);
  const appUser = deriveAppUser(input.slug);

  // Write manifest to a temp file so runAppRegisterFromToml can read it.
  const tmpDir = mkdtempSync(join(tmpdir(), "samo-umami-"));
  const tomlPath = join(tmpDir, ".samohost.toml");
  try {
    writeFileSync(tomlPath, manifest, "utf8");
    const code = runAppRegisterFromToml(
      { vm: input.vm, tomlPath },
      { json: false },
      vmStore,
      appStore,
      out,
      err,
    );
    if (code !== 0) return code;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- Print operator next-steps ------------------------------------------
  out("");
  out("=== Umami site registered — operator next steps ===");
  out("");
  out("1. Bootstrap app (run as root on the VM):");
  out(`   samohost app bootstrap ${input.vm} ${name} \\`);
  out(`     --app-user ${appUser} \\`);
  out(`     --db-name ${dbName}`);
  out("");
  out("2. Add APP_SECRET to the env file (DISTINCT from COOKIE_SECRET):");
  out(`   # On the VM:`);
  out(`   echo "APP_SECRET=$(openssl rand -hex 32)" >> /opt/${name}/staging.env`);
  out(`   # Do NOT reuse COOKIE_SECRET — APP_SECRET must be its own value.`);
  out("");
  out("3. Deploy the app:");
  out(`   samohost app deploy ${input.vm} ${name}`);
  out("");
  out("4. On first login, change the default admin password immediately:");
  out(`   - Open https://${input.host} in a browser`);
  out(`   - Log in with default credentials: admin / umami`);
  out(`   - Navigate to Settings → Profile → Change password`);
  out("");
  out("5. Add the tracking snippet to the target site's <head>:");
  out(`   - In Umami: Settings → Websites → Add Website`);
  out(`   - Copy the <script> tag and add it to the site's HTML`);
  out("");
  out("6. Per-site DB backup:");
  out(`   - The DB '${dbName}' is managed by this app's bootstrap.`);
  out(`   - Include it in your VM-level pg_dump cron or samohost backup policy.`);
  out("");
  out("Gate: this MR must satisfy M1 (green pipeline) + M2 (samorev PASS)");
  out("before client deploy. Do NOT deploy to a live VM until the feature is");
  out("merged and versioned.");

  return 0;
}
