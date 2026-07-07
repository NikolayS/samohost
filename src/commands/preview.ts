/**
 * `samohost preview` — offline render of cloud-init (SPEC §3 story 2).
 *
 * Renders the deterministic cloud-init YAML for a spec with ZERO network calls
 * and exits 0. Output is plain YAML, or a JSON envelope with `--json`.
 */

import { buildCloudInit } from "../cloudinit/builder.ts";
import { hardeningModule } from "../cloudinit/hardening.ts";
import { dblabModule } from "../cloudinit/dblab.ts";
import type { Module, ProvisionSpec } from "../types.ts";

/** All optional modules registered by name. Add new modules here. */
const MODULE_REGISTRY: Record<string, Module> = {
  [dblabModule.name]: dblabModule,
};

/** Resolve module names to Module objects. Hardening is implicit in the builder. */
export function resolveModules(names: string[]): {
  modules: Module[];
  errors: string[];
} {
  const errors: string[] = [];
  const modules: Module[] = [];
  for (const name of names) {
    if (name === hardeningModule.name) continue; // implicit, ignore if listed
    const mod = MODULE_REGISTRY[name];
    if (mod === undefined) {
      errors.push(`unknown module: ${name}`);
    } else {
      modules.push(mod);
    }
  }
  return { modules, errors };
}

export interface PreviewResult {
  cloudInit: string;
  validationErrors: string[];
}

/** Pure: produce the preview render + any validation errors for a spec. */
export function renderPreview(
  spec: ProvisionSpec,
  sshPubkey: string,
): PreviewResult {
  const { modules, errors: moduleErrors } = resolveModules(spec.modules);
  const allModules: Module[] = [hardeningModule, ...modules];
  const validationErrors = [
    ...moduleErrors,
    ...allModules.flatMap((m) => m.validate(spec)),
  ];
  const cloudInit = buildCloudInit(spec, modules, { sshPubkey });
  return { cloudInit, validationErrors };
}

/**
 * Run the preview command. Writes to the provided streams and returns an exit
 * code. Performs no network I/O.
 */
export function runPreview(
  spec: ProvisionSpec,
  sshPubkey: string,
  opts: { json: boolean },
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const { cloudInit, validationErrors } = renderPreview(spec, sshPubkey);

  if (validationErrors.length > 0) {
    for (const e of validationErrors) err(`error: ${e}`);
    return 1;
  }

  if (opts.json) {
    out(
      JSON.stringify(
        {
          provider: spec.provider,
          region: spec.region,
          type: spec.type,
          name: spec.name,
          sshPort: spec.sshPort,
          adminUser: spec.adminUser,
          modules: spec.modules,
          trustedIps: spec.trustedIps,
          cloudInit,
        },
        null,
        2,
      ),
    );
  } else {
    out(cloudInit);
  }
  return 0;
}
