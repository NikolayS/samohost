/**
 * Batched audit execution: ALL probes for one audit run are bundled into a
 * single remote bash script, delimited per check, and parsed apart locally.
 *
 * One audit = ONE SSH connection. This is a hard requirement, not an
 * optimization: hardened hosts rate-limit SSH at the kernel level (xt_recent
 * hitcounts on the SSH port) and per-check connections produce exactly the
 * rapid-SYN burst that gets an operator IP banned (see ssh/runner.ts and the
 * ConnectionBudget there).
 */

import type { AuditCheck } from "../types.ts";

export const AUDIT_DELIM_PREFIX = "<<<SAMOHOST_AUDIT:";
export const AUDIT_DELIM_SUFFIX = ">>>";

function delimiterLine(id: string): string {
  return `${AUDIT_DELIM_PREFIX}${id}${AUDIT_DELIM_SUFFIX}`;
}

/**
 * Render the combined audit script. Each probe is wrapped so its failure
 * (non-zero exit, missing binary, permission denied) cannot abort the rest of
 * the script; stderr is folded into the section so permission errors are
 * visible in the per-check output. The script always exits 0 — pass/fail is
 * decided locally by matching each section against the check's `expect`.
 */
export function buildAuditScript(checks: AuditCheck[]): string {
  const lines: string[] = ["set -u", ""];
  for (const check of checks) {
    lines.push(`echo ${JSON.stringify(delimiterLine(check.id))}`);
    lines.push(`{ ${check.probeCommand} ; } 2>&1 || true`);
  }
  lines.push("exit 0");
  return lines.join("\n") + "\n";
}

/**
 * Split combined audit output back into per-check sections.
 *
 * Tolerates: noise before the first delimiter (discarded — e.g. MOTD or shell
 * warnings), checks whose section is missing entirely (absent from the map),
 * and trailing output (kept with the last seen check).
 */
export function parseAuditOutput(
  stdout: string,
  checks: AuditCheck[],
): Map<string, string> {
  const ids = new Set(checks.map((c) => c.id));
  const sections = new Map<string, string>();
  let current: string | undefined;
  let buf: string[] = [];

  const flush = () => {
    if (current !== undefined) sections.set(current, buf.join("\n").trim());
    buf = [];
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith(AUDIT_DELIM_PREFIX) &&
      trimmed.endsWith(AUDIT_DELIM_SUFFIX)
    ) {
      const id = trimmed.slice(
        AUDIT_DELIM_PREFIX.length,
        trimmed.length - AUDIT_DELIM_SUFFIX.length,
      );
      if (ids.has(id)) {
        flush();
        current = id;
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return sections;
}
