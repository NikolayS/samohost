#!/usr/bin/env bun
/**
 * Regenerate docs/air-conformance.md from the AIR_DIRECTIVES registry.
 *
 *   bun run scripts/gen-air-conformance.ts
 *
 * The committed doc is CI-enforced to equal this output (see
 * test/air-conformance.test.ts), so the conformance matrix can never silently
 * drift from the enforced registry — the #64 "comparison became a stale doc"
 * failure mode is impossible by construction.
 */

import { renderConformanceDoc } from "../src/cloudinit/air-conformance.ts";

const path = new URL("../docs/air-conformance.md", import.meta.url).pathname;
await Bun.write(path, renderConformanceDoc());
console.log(`wrote ${path}`);
