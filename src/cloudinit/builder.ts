/**
 * Pure, deterministic cloud-init renderer (SPEC §5).
 *
 * `buildCloudInit(spec, modules, params)` produces a byte-identical YAML string
 * for identical inputs. The hardening module is always rendered first; other
 * module fragments follow in the order given. We emit YAML by hand (no library)
 * with explicit key ordering so determinism is provable, and we never read the
 * filesystem or emit secrets — the only injected value is the SSH *public* key.
 */

import type {
  BuildParams,
  CloudInitFragment,
  Module,
  ProvisionSpec,
  WriteFile,
} from "../types.ts";
import { hardeningModule, SSH_PUBKEY_PLACEHOLDER } from "./hardening.ts";

/**
 * Build the full cloud-init document.
 *
 * @param spec    normalized provisioning request
 * @param modules optional extra modules (hardening is prepended automatically)
 * @param params  non-persisted inputs (the SSH public key text)
 */
export function buildCloudInit(
  spec: ProvisionSpec,
  modules: Module[],
  params: BuildParams,
): string {
  // Hardening is always first and never duplicated.
  const ordered: Module[] = [
    hardeningModule,
    ...modules.filter((m) => m.name !== hardeningModule.name),
  ];

  const fragments = ordered.map((m) => m.cloudInitFragment(spec));
  const merged = mergeFragments(fragments);

  // Substitute the public-key placeholder in any file content.
  const pubkey = params.sshPubkey.trim();
  const writeFiles = (merged.writeFiles ?? []).map((f) => ({
    ...f,
    content: f.content.split(SSH_PUBKEY_PLACEHOLDER).join(pubkey),
  }));

  const lines: string[] = ["#cloud-config"];

  // --- top-level keys emitted in a FIXED, sorted order ---

  // apt_reboot_if_required + package_update/upgrade for unattended baseline.
  lines.push("package_update: true");
  lines.push("package_upgrade: true");

  // packages (sorted, de-duplicated)
  const packages = unique(merged.packages ?? []).sort();
  if (packages.length > 0) {
    lines.push("packages:");
    for (const p of packages) lines.push(`  - ${yamlScalar(p)}`);
  }

  // users — the non-root admin user with the SSH key.
  lines.push("users:");
  lines.push("  - default");
  lines.push(`  - name: ${yamlScalar(spec.adminUser)}`);
  lines.push("    groups: sudo");
  lines.push("    shell: /bin/bash");
  lines.push("    sudo: ALL=(ALL) NOPASSWD:ALL");
  lines.push("    lock_passwd: true");
  lines.push("    ssh_authorized_keys:");
  lines.push(`      - ${yamlScalar(pubkey)}`);

  // write_files — sorted by path for determinism.
  if (writeFiles.length > 0) {
    const sorted = [...writeFiles].sort((a, b) => cmp(a.path, b.path));
    lines.push("write_files:");
    for (const f of sorted) emitWriteFile(lines, f);
  }

  // runcmd — preserves intra-module order; concatenated module order is fixed.
  const runcmd = merged.runcmd ?? [];
  if (runcmd.length > 0) {
    lines.push("runcmd:");
    for (const c of runcmd) lines.push(`  - ${yamlScalar(c)}`);
  }

  // Trailing newline for byte-stable, POSIX-friendly output.
  return lines.join("\n") + "\n";
}

/** Concatenate fragments preserving array order; merge known list keys. */
function mergeFragments(fragments: CloudInitFragment[]): CloudInitFragment {
  const packages: string[] = [];
  const writeFiles: WriteFile[] = [];
  const runcmd: string[] = [];
  for (const f of fragments) {
    if (f.packages) packages.push(...f.packages);
    if (f.writeFiles) writeFiles.push(...f.writeFiles);
    if (f.runcmd) runcmd.push(...f.runcmd);
  }
  return { packages, writeFiles, runcmd };
}

function emitWriteFile(lines: string[], f: WriteFile): void {
  lines.push(`  - path: ${yamlScalar(f.path)}`);
  if (f.owner !== undefined) lines.push(`    owner: ${yamlScalar(f.owner)}`);
  if (f.permissions !== undefined) {
    lines.push(`    permissions: ${yamlScalar(f.permissions)}`);
  }
  // Always block-literal for content (deterministic, handles multi-line).
  lines.push("    content: |");
  const body = f.content.replace(/\n$/, "");
  for (const line of body.split("\n")) {
    lines.push(line.length > 0 ? `      ${line}` : "");
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Stable, locale-independent string comparison. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render a scalar safely. We single-quote anything that could be ambiguous in
 * YAML flow context (special chars, leading/trailing space, reserved words).
 */
function yamlScalar(v: string): string {
  if (v.length === 0) return '""';
  const needsQuote =
    /[:#{}\[\],&*!|>'"%@`]/.test(v) ||
    /^[\s-]/.test(v) ||
    /\s$/.test(v) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||
    /^[\d.+-]/.test(v[0]!) && /^[-+]?[\d._]*\.?[\d._]*$/.test(v);
  if (!needsQuote) return v;
  // Single-quote, escaping embedded single quotes by doubling them.
  return `'${v.split("'").join("''")}'`;
}
