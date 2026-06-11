/**
 * Branch → DNS-label naming for preview environments (SPEC-DELTA §4).
 *
 * The SOLO plan (Tanya301/field-record-1#117) serves each branch preview at
 *
 *     <app>-<branch-label>.<previewDomain>      e.g. field-record-1-feat-x.samo.cat
 *
 * The leftmost DNS label must be [a-z0-9-], ≤63 chars, and must not start or
 * end with '-'. Git branch names are far looser (case, '/', '_', '.', unicode),
 * so sanitization is lossy — two branches can collapse to one label. We resolve
 * collisions and overflow with a short deterministic hash of the ORIGINAL
 * branch name, so the same branch always maps to the same name (no clock, no
 * randomness — names must be reproducible across runs and machines).
 */

/** Max length of a single DNS label. */
const MAX_LABEL = 63;
/** Hex chars of the fnv1a hash used as a disambiguating suffix. */
const HASH_LEN = 6;

/** FNV-1a 32-bit, hex-encoded. Deterministic, dependency-free. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps everything in uint32).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, HASH_LEN);
}

/**
 * Sanitize a git branch name into a DNS-label fragment: lowercase, every run
 * of non-[a-z0-9] characters becomes a single '-', trimmed of leading/trailing
 * '-'. May return "" (e.g. a branch of only symbols) — callers handle that via
 * the hash suffix in {@link envName}.
 */
export function branchLabel(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compute the env name (= leftmost DNS label, systemd instance name, env dir
 * name) for (app, branch): `<app>-<label>`, with a deterministic `-<hash>`
 * suffix of the ORIGINAL branch appended when
 *
 *   - the label is empty after sanitization,
 *   - the name would exceed 63 chars (label is truncated to make room), or
 *   - `existing` maps this name to a DIFFERENT branch (collision).
 *
 * `existing` is the caller's view of current envs (name → branch). The same
 * (app, branch) pair always yields the same name.
 */
export function envName(
  app: string,
  branch: string,
  existing?: ReadonlyMap<string, string>,
): string {
  const label = branchLabel(branch);
  const hash = fnv1a(branch);

  const withSuffix = (lbl: string): string => {
    // app + '-' + lbl + '-' + hash, truncating lbl so the whole fits.
    const room = MAX_LABEL - app.length - 1 - 1 - HASH_LEN;
    const cut = lbl.slice(0, Math.max(room, 0)).replace(/-+$/g, "");
    return cut.length > 0 ? `${app}-${cut}-${hash}` : `${app}-${hash}`;
  };

  if (label.length === 0) return withSuffix("");

  const plain = `${app}-${label}`;
  if (plain.length > MAX_LABEL) return withSuffix(label);

  const owner = existing?.get(plain);
  if (owner !== undefined && owner !== branch) return withSuffix(label);

  return plain;
}
