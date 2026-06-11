/**
 * `samohost list` (SPEC §3 story 4 / SPEC-DELTA §1).
 *
 * Reads local state and prints a table of managed VMs (name / provider / ip /
 * sshPort / lifecycleState), or the raw records with `--json`. Empty state is
 * not an error: print a friendly message and exit 0.
 */

import type { VmRecord } from "../types.ts";
import type { StateStore } from "../state/store.ts";

const COLS = ["NAME", "PROVIDER", "IP", "PORT", "STATE"] as const;

function rowFor(r: VmRecord): string[] {
  return [r.name, r.provider, r.ip, String(r.sshPort), r.lifecycleState];
}

/** Render the records as a left-aligned padded table. */
export function renderTable(records: VmRecord[]): string {
  const rows = records.map(rowFor);
  const widths = COLS.map((c, i) =>
    Math.max(c.length, ...rows.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt([...COLS]), ...rows.map(fmt)].join("\n");
}

export function runList(
  opts: { json: boolean },
  store: StateStore,
  out: (s: string) => void,
  _err: (s: string) => void,
): number {
  const records = store.list();

  if (opts.json) {
    out(JSON.stringify(records, null, 2));
    return 0;
  }

  if (records.length === 0) {
    out("No VMs in state. Use `samohost adopt` or `samohost provision` to add one.");
    return 0;
  }

  out(renderTable(records));
  return 0;
}
