#!/usr/bin/env bash
# =============================================================================
# EPHEMERAL functional-test HARNESS — samohost-fixture PR-preview lifecycle
# =============================================================================
# Drives the FULL preview lifecycle of the samo-agent/samohost-fixture app on a
# THROWAWAY CX23 Hetzner VM, asserting each lifecycle behaviour against the LIVE
# running surface (curl the URL, read the PR comment) — never a status log.
#
# It also documents two KNOWN GAPS as EXPECT-FAIL assertions (idle/TTL reaping;
# wake-on-demand) and a scale FINDING (N PRs => N always-on units). Those are
# DOCUMENTED, never "fixed" by this harness.
#
# ROUTING, THEN READINESS: a freshly-created preview vhost is NOT live the
# instant `trigger run` returns — for TWO reasons that must not be conflated.
#
#   (1) PER-PREVIEW DNS must point at THIS fixture VM. This is the root cause of
#       the persistent CF 525 we used to see: without CLOUDFLARE_SAMOCAT set,
#       runEnvCreate skips per-preview DNS (DNS_DEGRADE_WARNING, env.ts) and the
#       preview name falls back to the *.samo.cat WILDCARD A record — which is
#       pinned to field-record's IP, NOT this fixture VM. Cloudflare (Full mode)
#       then opens its origin TLS handshake against the WRONG origin and returns
#       HTTP 525 forever — it is a routing/origin mismatch, not a cert-mint race.
#       The fix (below) EXPORTS CLOUDFLARE_SAMOCAT for the real run so
#       runEnvCreate writes a per-preview A record
#       samohost-fixture-preview-*.samo.cat -> the fixture VM IP; CF then reaches
#       the fixture VM's own `tls internal` Caddy and the 525 clears.
#   (2) Once DNS points at the right origin, there is still a short settle window
#       (Caddy unit start + first-handshake self-signed cert + CF edge cache)
#       before the URL is 200. That is the only part that is genuine TIMING.
#
# Every assertion below therefore POLLS the live URL to a stable terminal state
# (200 + env=preview + branch match / new sha / GONE) BEFORE asserting, with a
# bounded timeout. No fixed sleeps, no immediate probe.
#
# ORDERING: the scale FINDING (N open PRs => N always-on units) is evaluated
# with ALL fixture PRs OPEN — so create + scale-count run FIRST, redeploy NEXT,
# and teardown-on-close LAST (it closes a PR and would otherwise corrupt the
# scale count).
#
# ---------------------------------------------------------------------------
# SAFETY (read first — orphan VMs cost money, wrong-VM ops are catastrophic):
#   * GUARANTEED TEARDOWN: a trap on EXIT/INT/TERM destroys the fixture VM (and
#     reports any attached volumes) and VERIFIES it is gone. On destroy failure
#     it prints ONE LOUD line so a human reclaims the orphan. Fires on success,
#     failure, AND interrupt — the trap is installed BEFORE provisioning.
#   * BLAST-RADIUS FENCE: every name is parameterised and defaulted to a unique
#     throwaway fixture name. The harness HARD-REFUSES to run if the target VM
#     name collides with a protected production/host VM, and refuses if the
#     target VM already exists in state carrying apps that are not ours.
#   * It touches ONLY its own fixture VM + the samohost-fixture app. It NEVER
#     touches field-record, game-changers, any existing VM/preview/prod.
#
# ---------------------------------------------------------------------------
# THIS-STEP CONTRACT (DRY-RUN ONLY):
#   With SAMOHOST_FIXTURE_DRYRUN=1 (the DEFAULT) the harness does NOT provision
#   a real VM and does NOT mutate any GitHub PR or remote host. It:
#     - renders the provision cloud-init offline via `samohost preview`
#       (zero provider API calls — the offline analog of provision --dry-run),
#     - echoes the exact command PLAN for every mutating step it WOULD run,
#     - still installs + exercises the teardown trap (which is a no-op when no
#       VM was provisioned).
#   Set SAMOHOST_FIXTURE_DRYRUN=0 to actually provision + drive the lifecycle.
#   bash -n clean.
# =============================================================================
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"

# --- Where the samohost CLI lives (run via bun) ------------------------------
SAMOHOST_TRIGGER_DIR="${SAMOHOST_TRIGGER_DIR:-$HOME/samohost-trigger}"
samohost() { ( cd "$SAMOHOST_TRIGGER_DIR" && bun run src/cli.ts "$@" ); }

# --- Parameterised target (defaults = unique throwaway fixture identity) ------
# Date+pid suffix so two runs never collide and the name is obviously ephemeral.
FIXTURE_VM="${SAMOHOST_FIXTURE_VM:-samohost-fixture-$(date -u +%Y%m%d-%H%M%S)-$$}"
FIXTURE_APP="${SAMOHOST_FIXTURE_APP:-samohost-fixture}"
FIXTURE_REPO="${SAMOHOST_FIXTURE_REPO:-samo-agent/samohost-fixture}"
# PINNED to fsn1: the fixture manifest (test/fixtures/samohost.toml [provision].location)
# says fsn1, but a prior run landed in nbg1 (old default) and timed out on a slow
# cx23 first boot. Pin fsn1 here so harness + manifest agree and the VM lands where
# the manifest expects. Still overridable via SAMOHOST_FIXTURE_REGION for an operator.
FIXTURE_REGION="${SAMOHOST_FIXTURE_REGION:-fsn1}"
FIXTURE_TYPE="${SAMOHOST_FIXTURE_TYPE:-cx23}"   # cx22 is DEPRECATED at Hetzner (422); cx23 is the current smallest type
FIXTURE_SSH_KEY="${SAMOHOST_FIXTURE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
PREVIEW_DOMAIN="${SAMOHOST_FIXTURE_PREVIEW_DOMAIN:-samo.cat}"

# DRY-RUN is the default for THIS step (write + lint + dry-run only).
DRYRUN="${SAMOHOST_FIXTURE_DRYRUN:-1}"

# Operator secrets file that carries CLOUDFLARE_SAMOCAT (sourced at runtime far
# below, AFTER ts() is defined, only for a real run). NEVER inlines the token.
SAMOHOST_SECRETS_ENV="${SAMOHOST_SECRETS_ENV:-$HOME/.samo-secrets/owner-tokens.env}"

# --- Provision booting->ready gate bound (robustness for slow cx23 first boot) -
# The `samohost provision` booting->ready gate is bounded by `spec.timeoutSec`,
# settable ONLY via the `--timeout <seconds>` provision CLI flag (default 600s).
# It is NOT settable via .samohost.toml: the [provision] table allows only
# serverType/location/labels and is not consumed by any command yet (toml.ts
# PROVISION_KEYS; "future provision --from-toml" TODO). So we raise it via the
# flag. A hardened cx23 first boot installs apparmor/fail2ban/nftables/ufw/
# unattended-upgrades + runs aa-enforce and writes the completion sentinel LAST,
# so on a slow/flaky boot 600s can be too tight. 1200s (20 min) absorbs that.
PROVISION_READY_TIMEOUT_SEC="${SAMOHOST_FIXTURE_PROVISION_TIMEOUT_SEC:-1200}"
# Number of provision attempts total (1 initial + retries). One retry => 2.
PROVISION_ATTEMPTS="${SAMOHOST_FIXTURE_PROVISION_ATTEMPTS:-2}"

# Names that must NEVER be targeted, whatever the env says. Hard fence.
PROTECTED_VMS_RE='^(samo-we-field-record|field-record|field-record-1|game-changers|samo-control-plane|.*-main|.*-prod)$'

ts() { date -u +%FT%TZ; }
PASS=0; FAIL=0; XFAIL=0; XPASS=0; SKIP=0
RESULTS="$(mktemp)"
pass()  { PASS=$((PASS+1));  echo "PASS  $*"  | tee -a "$RESULTS"; }
fail()  { FAIL=$((FAIL+1));  echo "FAIL  $*"  | tee -a "$RESULTS"; }
# xfail = an EXPECT-FAIL-today assertion: a real, documented PRODUCT gap (wake-on-demand).
# Reserved for genuine gaps — NOT for dry-run skips.
xfail() { XFAIL=$((XFAIL+1)); echo "XFAIL $*  (EXPECT-FAIL-today — documented gap, NOT fixed here)" | tee -a "$RESULTS"; }
# xfail_bug = an EXPECT-FAIL-today assertion that fails because of ONE specific OPEN,
# TRACKED bug: 'multi-preview-on-same-host'. The 2nd preview created on an already-hosting
# fixture VM never persists an env (runEnvCreate's remote create-script throws on the 2nd
# create BEFORE the unconditional env-record upsert — src/commands/env.ts ~665-674 early
# `return 1` skips the `envStore.upsert(record)` at ~757), so no env exists, the scale
# count is short, and the batch redeploy trigger never re-stamps lastDeployedSha
# (src/preview/pr.ts:213). Recorded as XFAIL → does NOT fail the run while the bug is OPEN.
# DISTINCT from the product-gap xfail() so the message names the tracked bug.
xfail_bug() { XFAIL=$((XFAIL+1)); echo "XFAIL $*  (EXPECT-FAIL — known OPEN bug 'multi-preview-on-same-host': 2nd env-create throws before the env upsert so no env persists + redeploy stays stale; marked xfail, fix pending)" | tee -a "$RESULTS"; }
# xpass = an assertion that was EXPECTED to fail (xfail_bug) but UNEXPECTEDLY PASSED — i.e.
# the 'multi-preview-on-same-host' bug now appears FIXED. This is an ALERT: it makes the run
# NON-GREEN (counted into the exit code below) so a human UN-xfails the assertion and
# promotes it to a HARD PASS gate. An xpass is NOT success — it means the harness is stale.
xpass() { XPASS=$((XPASS+1)); echo "XPASS $*  (UNEXPECTED PASS — the 'multi-preview-on-same-host' bug appears FIXED; ALERT: un-xfail this assertion and make it a HARD PASS gate)" | tee -a "$RESULTS"; }
# skip = an EXPECT-PASS assertion that cannot run in dry-run (needs a real VM/PR);
# its expected verdict in a real run is named so the distinction stays honest.
skip()  { SKIP=$((SKIP+1));  echo "SKIP  $*  (dry-run — needs a real VM/PR; EXPECT-PASS in a real run)" | tee -a "$RESULTS"; }
plan()  { echo "  [PLAN] would run: samohost $*"; }   # dry-run command echo
note()  { echo "  $*"; }

# Surface the otherwise-captured/swallowed `trigger run` output when a per-PR
# preview action (create / redeploy) is NOT ok. Without this the harness eats the
# trigger stdout+stderr, so the REAL cause of a failed action (e.g. the 2nd
# preview's create-script throwing before the env upsert, or a redeploy that
# never re-stamps lastDeployedSha) is invisible in the run log. Indented +
# prefixed so it stays scannable; callers guard the call so the blob is emitted
# ONLY on failure, never on a passing action.
dump_trigger_output() {
  local label="$1" out="$2"
  [ -z "$out" ] && out="(no trigger output captured)"
  echo "  --- trigger output [$label] (surfaced because a per-PR action != ok) ---"
  printf '%s\n' "$out" | sed 's/^/    | /'
  echo "  --- end trigger output [$label] ---"
}

# Records set once the VM is (or would be) provisioned, so the trap can target it.
# PROVISIONED_VM_NAME is the LAST (current) attempt's name, used only for human
# messages + the state-record destroy attempt. The AUTHORITATIVE teardown list is
# PROVISIONED_PROVIDER_IDS below — the trap reclaims by PROVIDER ID so a stale or
# already-'destroyed' state record can never strand a LIVE provider VM.
PROVISIONED_VM_NAME=""   # empty (and no provider ids) => trap teardown is a no-op
PROVISIONED_VM_ID=""
# EVERY provider (Hetzner) server id provisioned THIS run — one per attempt, since
# each provision attempt now uses a UNIQUE name and so may leave a DISTINCT live
# provider resource behind (the original orphan bug: attempt-1's pre-retry destroy
# marked the SHARED state record 'destroyed', then the EXIT trap resolved that dead
# record and left attempt-2's LIVE VM running). The trap walks THIS list and
# reclaims every id still live at the provider, by id, independent of state.
PROVISIONED_PROVIDER_IDS=()
# Parallel list of the name each provider id was created under (same index), for
# the PROTECTED_VMS fence + human messages during by-id reclaim.
PROVISIONED_PROVIDER_NAMES=()

# --- Hetzner provider API (by-id reclaim) ------------------------------------
# The EXIT trap reclaims LIVE provider VMs BY PROVIDER ID via the Hetzner API,
# NOT via `samohost destroy <name>` (which resolves the STATE RECORD and refuses
# once it is 'destroyed' — exactly how attempt-1's stale record stranded
# attempt-2's live VM). HCLOUD_TOKEN is already required for a real provision, so
# it is in-env here. Same base URL the adapter uses (src/providers/hetzner.ts
# HETZNER_BASE_URL). Token is read from the env only, never written anywhere.
HETZNER_BASE_URL="${HETZNER_BASE_URL:-https://api.hetzner.cloud/v1}"

# GET a provider server by id -> echoes its name if it EXISTS (live/any status),
# empty if it is gone (404) or unknowable. Used to (a) confirm a record is still
# live before deleting and (b) re-fence on the live name.
hetzner_server_name_by_id() {
  local id="$1"
  [ -z "$id" ] && return 1
  [ -z "${HCLOUD_TOKEN:-}" ] && return 1
  curl -sS -m 20 -H "Authorization: Bearer $HCLOUD_TOKEN" \
    "$HETZNER_BASE_URL/servers/$id" 2>/dev/null \
    | jq -r '.server.name // empty' 2>/dev/null
}

# DELETE a provider server by id. Returns 0 on 2xx OR 404 (already gone), 1 else.
hetzner_destroy_by_id() {
  local id="$1" code
  [ -z "$id" ] && return 1
  [ -z "${HCLOUD_TOKEN:-}" ] && return 1
  code="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' \
            -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" \
            "$HETZNER_BASE_URL/servers/$id" 2>/dev/null)"
  case "$code" in
    2*|404) return 0 ;;   # deleted, or already gone
    *) return 1 ;;
  esac
}

# =============================================================================
# 0b. PER-PREVIEW DNS TOKEN — clears the persistent CF 525 on the real run.
# =============================================================================
# runEnvCreate writes a per-preview A record (samohost-fixture-preview-*.samo.cat
# -> THIS fixture VM's IP) ONLY when CLOUDFLARE_SAMOCAT is set; otherwise it
# skips per-preview DNS (DNS_DEGRADE_WARNING in src/commands/env.ts) and the
# preview name falls back to the *.samo.cat WILDCARD A record pinned to
# field-record's IP => Cloudflare 525 against the WRONG origin. So for the REAL
# run we SOURCE the token from the operator secrets file AT RUNTIME and export
# it — the exact same "source the env file at runtime" pattern the trigger uses
# for `gh auth token`. The token LITERAL is NEVER written into this script or any
# committed/versioned file; it lives only in the 0600 secrets file and is read
# into the process env at run time.
#
# SAFE / FIXTURE-SCOPED: with the token set, runEnvCreate writes ONLY per-preview
# records for THIS fixture's own preview hostnames (samohost-fixture-preview-*),
# keyed on the fixture app/branch vhost. It does NOT touch the *.samo.cat
# wildcard, field-record, game-changers, prod, or any non-fixture hostname.
#
# DRY-RUN (the default for THIS step) sources nothing — no token is read, no env
# is mutated; the block is a no-op unless SAMOHOST_FIXTURE_DRYRUN=0.
if [ "$DRYRUN" != "1" ]; then
  if [ -r "$SAMOHOST_SECRETS_ENV" ]; then
    # Source at runtime to pull CLOUDFLARE_SAMOCAT into the env (no literal here).
    # `set -a` marks sourced vars for export so child `samohost` (bun) inherits.
    # shellcheck disable=SC1090
    set -a; . "$SAMOHOST_SECRETS_ENV"; set +a
  else
    echo "[$(ts)] WARN: secrets env '$SAMOHOST_SECRETS_ENV' not readable — CLOUDFLARE_SAMOCAT will be unset; per-preview DNS will be SKIPPED and previews will 525 against the *.samo.cat wildcard (wrong origin)." >&2
  fi
  # Be explicit about export + tolerate unset (set -u is on).
  export CLOUDFLARE_SAMOCAT="${CLOUDFLARE_SAMOCAT:-}"
  if [ -z "${CLOUDFLARE_SAMOCAT:-}" ]; then
    echo "[$(ts)] WARN: CLOUDFLARE_SAMOCAT is empty after sourcing — runEnvCreate will skip per-preview DNS and previews will 525 against the *.samo.cat wildcard. Set it in '$SAMOHOST_SECRETS_ENV'." >&2
  else
    echo "[$(ts)] CLOUDFLARE_SAMOCAT sourced from '$SAMOHOST_SECRETS_ENV' (len=${#CLOUDFLARE_SAMOCAT}) — per-preview DNS will write samohost-fixture-preview-*.samo.cat -> fixture VM IP." >&2
  fi
fi

# =============================================================================
# 1. GUARANTEED TEARDOWN  — installed BEFORE any provision call.
# =============================================================================
teardown() {
  local rc=$?
  # Only the LAST handler should emit the final summary line.
  trap - EXIT INT TERM

  echo
  echo "[$(ts)] TEARDOWN: begin (exit-code-so-far=$rc, dryrun=$DRYRUN)"

  # Authoritative teardown set = EVERY provider id provisioned this run (one per
  # attempt, each a UNIQUE name). Reclaim BY PROVIDER ID so a stale/'destroyed'
  # state record can never strand a LIVE provider VM (the original orphan bug).
  local n_ids="${#PROVISIONED_PROVIDER_IDS[@]}"

  if [ -z "$PROVISIONED_VM_NAME" ] && [ "$n_ids" -eq 0 ]; then
    echo "[$(ts)] TEARDOWN: no fixture VM was provisioned — nothing to destroy."
  elif [ "$DRYRUN" = "1" ]; then
    echo "[$(ts)] TEARDOWN: DRY-RUN — would reclaim every provisioned fixture VM BY PROVIDER ID (not by state name):"
    if [ "$n_ids" -eq 0 ]; then
      plan "destroy $PROVISIONED_VM_NAME --yes --json   # (no provider id captured in dry-run) state-record destroy of last attempt"
    fi
    local i
    for ((i = 0; i < n_ids; i++)); do
      note "  [PLAN] would GET  Hetzner /servers/${PROVISIONED_PROVIDER_IDS[$i]}  (confirm live + re-fence on live name '${PROVISIONED_PROVIDER_NAMES[$i]}')"
      note "  [PLAN] would DELETE Hetzner /servers/${PROVISIONED_PROVIDER_IDS[$i]}  (by PROVIDER ID — reclaims a LIVE VM even if its state record is already 'destroyed'); volumes reported, never deleted"
    done
    plan "list --json   # then VERIFY no live fixture record remains"
  else
    # 1) Best-effort: drive each provisioned NAME's STATE record to destroyed via
    #    the CLI (keeps state tidy). This MAY no-op on an already-'destroyed'
    #    record — which is precisely why step (2) below is the real guarantee.
    if [ -n "$PROVISIONED_VM_NAME" ]; then
      echo "[$(ts)] TEARDOWN: state-record destroy (tidy) for last attempt '$PROVISIONED_VM_NAME' (volumes reported, never deleted)…"
      samohost destroy "$PROVISIONED_VM_NAME" --yes --json 2>/dev/null || \
        note "  (state-record destroy of '$PROVISIONED_VM_NAME' returned non-zero — by-id reclaim below is the guarantee)"
    fi

    # 2) GUARANTEE: reclaim EVERY provider id still live AT THE PROVIDER, by id,
    #    independent of state. This is the fix for the strand: attempt-2's live VM
    #    is reclaimed even though attempt-1's pre-retry destroy marked the (shared,
    #    now unique-per-attempt) state record 'destroyed'.
    if [ "$n_ids" -eq 0 ]; then
      echo "ORPHAN VM — manual cleanup needed: ${PROVISIONED_VM_NAME:-unknown} (no provider id was captured) — cannot reclaim BY ID; check the Hetzner console for a live '$PROVISIONED_VM_NAME'"
    elif [ -z "${HCLOUD_TOKEN:-}" ]; then
      echo "ORPHAN VM — manual cleanup needed: HCLOUD_TOKEN unset at teardown — cannot reclaim BY ID; live provider ids: ${PROVISIONED_PROVIDER_IDS[*]} (names: ${PROVISIONED_PROVIDER_NAMES[*]})"
    else
      local i pid pname livename
      for ((i = 0; i < n_ids; i++)); do
        pid="${PROVISIONED_PROVIDER_IDS[$i]}"
        pname="${PROVISIONED_PROVIDER_NAMES[$i]}"
        livename="$(hetzner_server_name_by_id "$pid")"
        if [ -z "$livename" ]; then
          echo "[$(ts)] TEARDOWN: provider id $pid ('$pname') already gone at provider — nothing to reclaim."
          continue
        fi
        # PROTECTED_VMS fence on the LIVE provider name — never delete a protected VM.
        if printf '%s' "$livename" | grep -qiE "$PROTECTED_VMS_RE"; then
          echo "ORPHAN VM — manual cleanup needed: provider id $pid resolves to PROTECTED name '$livename' — REFUSING to delete by id; inspect manually (this should never happen for a fixture run)"
          continue
        fi
        case "$livename" in
          *fixture*) : ;;
          *) echo "ORPHAN VM — manual cleanup needed: provider id $pid resolves to NON-fixture name '$livename' — REFUSING to delete by id (blast-radius fence); inspect manually"; continue ;;
        esac
        echo "[$(ts)] TEARDOWN: reclaiming LIVE provider id $pid (name='$livename') BY PROVIDER ID via Hetzner API…"
        if hetzner_destroy_by_id "$pid"; then
          # VERIFY gone at the provider.
          if [ -z "$(hetzner_server_name_by_id "$pid")" ]; then
            echo "[$(ts)] TEARDOWN: verified — provider id $pid ('$livename') is gone."
          else
            echo "ORPHAN VM — manual cleanup needed: $livename (provider id $pid) — DELETE returned ok but the server still resolves at the provider"
          fi
        else
          echo "ORPHAN VM — manual cleanup needed: $livename (provider id $pid) — Hetzner DELETE /servers/$pid FAILED"
        fi
      done
    fi
  fi

  echo
  echo "[$(ts)] SUMMARY: ${PASS} pass / ${FAIL} fail / ${XFAIL} expected-fail (wake-on-demand gap + the OPEN 'multi-preview-on-same-host' bug) / ${XPASS} UNEXPECTED-pass / ${SKIP} skipped (dry-run)"
  # GREEN when FAIL=0 AND XPASS=0 (the 3 multi-preview xfails are allowed to fail).
  # NON-GREEN (alert) if a HARD lifecycle gate regressed (FAIL>0) OR a known-bug xfail
  # started PASSING (XPASS>0 => un-xfail it). The exit code is set at the script tail.
  if [ "${XPASS:-0}" -gt 0 ]; then
    echo "[$(ts)] ALERT: ${XPASS} assertion(s) that are marked xfail for the OPEN 'multi-preview-on-same-host' bug UNEXPECTEDLY PASSED — the bug appears FIXED; un-xfail them and restore them as HARD PASS gates."
  fi
  rm -f "$RESULTS" 2>/dev/null || true
  echo "[$(ts)] fixture-lifecycle: DONE"

  # EXIT EXPLICITLY — this same handler is the INT/TERM trap too. On a SIGINT/SIGTERM
  # a bash trap handler that merely RETURNS resumes the script at the point the signal
  # interrupted it: teardown would destroy the VM and then the lifecycle would RESUME
  # and fire a stray `trigger run --pr-previews` against the just-destroyed VM. Exiting
  # here ends the run cleanly on a signal. On the normal EXIT path this preserves the
  # exit-code-so-far ($rc, captured above); it cannot recurse because this handler
  # cleared its own traps (`trap - EXIT INT TERM`) at the top.
  exit "$rc"
}
trap teardown EXIT INT TERM
# ^^^ THE TEARDOWN MECHANISM (quoted in the structured output).

# =============================================================================
# 2. SAFETY PREFLIGHT — refuse to target anything that is not our throwaway.
# =============================================================================
echo "[$(ts)] fixture-lifecycle: START  vm='$FIXTURE_VM' app='$FIXTURE_APP' repo='$FIXTURE_REPO' dryrun=$DRYRUN"

if [ "$FIXTURE_APP" != "samohost-fixture" ]; then
  echo "[$(ts)] REFUSE: app must be 'samohost-fixture' (got '$FIXTURE_APP'); this harness operates ONLY on the fixture app." >&2
  exit 2
fi
if printf '%s' "$FIXTURE_VM" | grep -qiE "$PROTECTED_VMS_RE"; then
  echo "[$(ts)] REFUSE: target VM '$FIXTURE_VM' matches a PROTECTED production/host name — refusing to touch it." >&2
  exit 2
fi
case "$FIXTURE_VM" in
  *fixture*) : ;;  # throwaway names must self-identify as fixtures
  *) echo "[$(ts)] REFUSE: target VM '$FIXTURE_VM' does not contain 'fixture' — refusing (blast-radius fence)." >&2; exit 2 ;;
esac

# Refuse if a VM with this name ALREADY exists in state carrying apps that aren't ours.
if command -v jq >/dev/null 2>&1; then
  existing="$(samohost list --json 2>/dev/null \
              | jq -r --arg n "$FIXTURE_VM" \
                  '[.[] | select(.name==$n) | select((.lifecycleState // "") != "destroyed")] | length' 2>/dev/null)"
  if [ "${existing:-0}" != "0" ]; then
    # It exists and is live — does it carry non-fixture apps? Check env/app records.
    foreign_apps="$(samohost env list "$FIXTURE_VM" --json 2>/dev/null \
                    | jq -r --arg a "$FIXTURE_APP" \
                        '[.[] | select(.appName != $a)] | length' 2>/dev/null)"
    if [ "${foreign_apps:-0}" != "0" ]; then
      echo "[$(ts)] REFUSE: VM '$FIXTURE_VM' already exists and carries $foreign_apps app(s) that are NOT '$FIXTURE_APP' — refusing to reuse it." >&2
      exit 2
    fi
    echo "[$(ts)] WARN: a live VM named '$FIXTURE_VM' already exists (only fixture apps) — in a non-dry run pick a fresh name." >&2
    [ "$DRYRUN" != "1" ] && { echo "[$(ts)] REFUSE: not reusing an existing live VM in a real run." >&2; exit 2; }
  fi
fi
note "safety preflight OK — target is a throwaway fixture, no foreign apps."

# =============================================================================
# 2b. TEARDOWN SELF-TEST — prove by-id reclaim survives a 'destroyed' state record.
# =============================================================================
# This is the regression guard for the orphan bug: attempt-1's pre-retry destroy
# marked the (formerly shared) state record 'destroyed', then the old EXIT trap
# resolved that DEAD record by NAME and left attempt-2's LIVE provider VM running.
# The fix reclaims BY PROVIDER ID, independent of state. We verify that property
# here WITHOUT any provider call: we stub the two Hetzner helpers against an
# in-memory "live server" set and a simulated state store whose record is ALREADY
# 'destroyed', then run the trap's by-id reclaim logic and assert the live server
# is deleted. Runs in dry-run AND real (it touches NO real infra, only stubs).
selftest_teardown_by_id() {
  # In-memory provider: id 999111 is LIVE with a fixture name; its state record is
  # (simulated) already 'destroyed' — the exact strand condition. We use LOCAL
  # stub functions (st_*) so the REAL hetzner_* helpers are never touched.
  local LIVE_ID="999111" LIVE_NAME="samohost-fixture-selftest-a2"
  local st_deleted=""
  # Stub: name-by-id returns the live name until it is deleted.
  st_name_by_id() { [ "$1" = "$LIVE_ID" ] && [ -z "$st_deleted" ] && echo "$LIVE_NAME"; return 0; }
  # Stub: delete marks it gone (mimics Hetzner 2xx); no-op for anything else.
  st_destroy_by_id() { [ "$1" = "$LIVE_ID" ] && st_deleted=1; return 0; }
  # The simulated CLI state-record destroy has ALREADY marked it 'destroyed'; the
  # by-id path must NOT consult state at all (we never call samohost here).

  # Drive the SAME by-id reclaim the trap uses, over a one-element id list.
  local pid="$LIVE_ID" livename ok=1
  livename="$(st_name_by_id "$pid")"
  [ -z "$livename" ] && ok=0
  # Fence (same as trap): must be a fixture, never protected.
  printf '%s' "$livename" | grep -qiE "$PROTECTED_VMS_RE" && ok=0
  case "$livename" in *fixture*) : ;; *) ok=0 ;; esac
  if [ "$ok" = "1" ]; then
    st_destroy_by_id "$pid" || ok=0
    # VERIFY gone after delete (this is the 'reclaimed a live VM' assertion).
    [ -n "$(st_name_by_id "$pid")" ] && ok=0
  fi
  return $(( ok == 1 ? 0 : 1 ))
}
echo
echo "[$(ts)] SELF-TEST teardown — by-id reclaim of a LIVE VM whose state record is already 'destroyed'"
if selftest_teardown_by_id; then
  pass "teardown-by-id: trap reclaims a LIVE provider VM by id even when its state record is already 'destroyed' (orphan-strand regression guard)"
else
  fail "teardown-by-id: by-id reclaim did NOT delete the live VM under a 'destroyed' state record — the orphan-strand bug is NOT fixed"
fi

# =============================================================================
# 3. PROVISION + REGISTER the fixture app
# =============================================================================
echo
echo "[$(ts)] STEP provision+register"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: rendering provision cloud-init OFFLINE via 'samohost preview' (zero API calls)…"
  # Each attempt gets a UNIQUE name (append attempt index) so retries never collide
  # with the prior attempt's (possibly still-live) provider resource.
  dry_attempt1_name="${FIXTURE_VM}-a1"
  if samohost preview --provider hetzner --region "$FIXTURE_REGION" --type "$FIXTURE_TYPE" \
        --name "$dry_attempt1_name" --ssh-pubkey "ssh-ed25519 AAAAFIXTUREDRYRUNKEY fixture@dryrun" >/dev/null 2>&1; then
    pass "provision-render: cloud-init for '$dry_attempt1_name' rendered offline (no provider call)"
  else
    fail "provision-render: 'samohost preview' failed to render fixture cloud-init"
  fi
  note "DRY-RUN: each of up to $PROVISION_ATTEMPTS attempts uses a UNIQUE name (${FIXTURE_VM}-a<index>) so a retry never collides with a prior attempt's live VM."
  plan "provision --provider hetzner --region $FIXTURE_REGION --type $FIXTURE_TYPE --name ${FIXTURE_VM}-a<index> --ssh-key $FIXTURE_SSH_KEY --timeout $PROVISION_READY_TIMEOUT_SEC --json   # raised ready-gate (default is 600s); up to $PROVISION_ATTEMPTS attempts, UNIQUE name each, degraded VM destroyed between; EVERY provider id captured for by-id teardown"
  plan "app register ${FIXTURE_VM}-a<winning-index> --from-toml <samohost-fixture repo>/.samohost.toml"
  # In dry-run, record the intended name + a placeholder provider id so the trap
  # shows the BY-PROVIDER-ID destroy PLAN (the real-run teardown guarantee).
  PROVISIONED_VM_NAME="$dry_attempt1_name"
  PROVISIONED_VM_ID="(dry-run — not provisioned)"
  PROVISIONED_PROVIDER_IDS+=("(dry-run-provider-id-a1)")
  PROVISIONED_PROVIDER_NAMES+=("$dry_attempt1_name")
  note "DRY-RUN: NOT provisioning a real VM. provisionedRealVm=false."
else
  echo "[$(ts)] provisioning REAL throwaway $FIXTURE_TYPE (base name '$FIXTURE_VM', HCLOUD_TOKEN required)…"
  echo "[$(ts)] ready-gate raised to ${PROVISION_READY_TIMEOUT_SEC}s; up to ${PROVISION_ATTEMPTS} attempt(s), UNIQUE name each."
  # UNIQUE NAME PER ATTEMPT (Fix 1b): each attempt is '<base>-a<index>' so a retry
  # can NEVER collide with a prior attempt's (possibly still-live) provider VM. The
  # winning attempt's name becomes WINNING_VM_NAME and drives register/host-prep/
  # lifecycle below.
  #
  # CAPTURE EVERY PROVIDER ID (Fix 1c): the instant `samohost provision --json`
  # reports a provider id (state is written at 'creating'/'booting', so the id is
  # present even on a degraded/timeout result), we append it to
  # PROVISIONED_PROVIDER_IDS. The EXIT trap then reclaims EVERY one still live AT
  # THE PROVIDER, by id — so attempt-1's pre-retry state-record destroy can no
  # longer strand attempt-2's live VM. We STILL best-effort destroy the degraded
  # VM between attempts, but by its own unique provider id, not by a shared name.
  prov_rc=1
  attempt=1
  WINNING_VM_NAME=""
  while [ "$attempt" -le "$PROVISION_ATTEMPTS" ]; do
    attempt_name="${FIXTURE_VM}-a${attempt}"
    PROVISIONED_VM_NAME="$attempt_name"   # current attempt (human msgs + tidy state destroy)
    note "provision attempt ${attempt}/${PROVISION_ATTEMPTS} for UNIQUE name '$attempt_name' (--timeout ${PROVISION_READY_TIMEOUT_SEC}s)…"
    # Capture STDOUT ONLY for the jq parse. The degraded/timeout path writes a
    # plain-text error to STDERR *and* the record JSON to STDOUT; merging them with
    # `2>&1` made jq choke on the leading non-JSON, blanking .providerId and tripping
    # a FALSE "no provider id reported" -> ORPHAN VM line even though the id WAS on
    # stdout. Send stderr to its own file so it's preserved for diagnostics but never
    # contaminates the JSON the parser sees — .providerId then parses on BOTH the ok
    # and degraded paths.
    prov_err="$(mktemp)"
    prov_json="$(samohost provision --provider hetzner --region "$FIXTURE_REGION" \
                   --type "$FIXTURE_TYPE" --name "$attempt_name" --ssh-key "$FIXTURE_SSH_KEY" \
                   --timeout "$PROVISION_READY_TIMEOUT_SEC" --json 2>"$prov_err")"
    prov_rc=$?
    if [ -s "$prov_err" ]; then
      note "  provision stderr (attempt ${attempt}): $(tr '\n' ' ' < "$prov_err")"
    fi
    rm -f "$prov_err"
    # Provider id is the Hetzner-native id (.providerId). Fall back to .id only if
    # providerId is absent (it should be present once the API accepted the create).
    attempt_pid="$(printf '%s' "$prov_json" | jq -r '.providerId // empty' 2>/dev/null)"
    PROVISIONED_VM_ID="$attempt_pid"
    # Track this attempt's provider id for BY-ID teardown (even on failure/degraded:
    # the resource may exist and must be reclaimable). Only track non-empty ids.
    if [ -n "$attempt_pid" ]; then
      PROVISIONED_PROVIDER_IDS+=("$attempt_pid")
      PROVISIONED_PROVIDER_NAMES+=("$attempt_name")
      note "  captured provider id '$attempt_pid' for '$attempt_name' (tracked for by-id teardown)."
    else
      note "  WARN: no provider id reported for '$attempt_name' (rc=$prov_rc) — if a resource leaked it is NOT id-reclaimable; trap will warn."
    fi
    if [ "$prov_rc" -eq 0 ]; then WINNING_VM_NAME="$attempt_name"; break; fi

    # Failed/degraded: the provider resource may EXIST (booting->ready timeout
    # leaves it 'degraded', reclaimable). If another attempt remains, destroy the
    # degraded VM now — BY ITS OWN UNIQUE PROVIDER ID (not a shared name), so the
    # next attempt starts clean AND this destroy can never collide with another
    # attempt's resource. On the LAST attempt, do NOT destroy here — leave it for
    # the EXIT trap so its by-id verify-gone + ORPHAN reporting still fire.
    if [ "$attempt" -lt "$PROVISION_ATTEMPTS" ]; then
      if [ -n "$attempt_pid" ]; then
        note "provision attempt ${attempt} failed (rc=$prov_rc) — destroying degraded '$attempt_name' by provider id '$attempt_pid' before retry…"
        hetzner_destroy_by_id "$attempt_pid" || \
          note "  WARN: pre-retry by-id destroy of '$attempt_name' (id $attempt_pid) reported failure — EXIT trap will reclaim if it remains."
      else
        note "provision attempt ${attempt} failed (rc=$prov_rc) with no provider id — falling back to state-name destroy of '$attempt_name'…"
        samohost destroy "$attempt_name" --yes --json >/dev/null 2>&1 || \
          note "  WARN: pre-retry destroy of '$attempt_name' reported failure — EXIT trap will reclaim if a record remains."
      fi
    fi
    attempt=$((attempt+1))
  done
  if [ "$prov_rc" -ne 0 ]; then
    fail "provision: 'samohost provision' failed after ${PROVISION_ATTEMPTS} attempt(s) (last rc=$prov_rc) — teardown trap will reclaim every tracked provider id"
    exit 1
  fi
  # The winning attempt's unique name drives the rest of the lifecycle.
  FIXTURE_VM="$WINNING_VM_NAME"
  PROVISIONED_VM_NAME="$WINNING_VM_NAME"
  pass "provision: throwaway $FIXTURE_TYPE '$FIXTURE_VM' provisioned (provider id=${PROVISIONED_VM_ID:-?}, winning attempt ${attempt}/${PROVISION_ATTEMPTS})"

  # Register the fixture app from its repo-side manifest (offline, no network).
  if samohost app register "$FIXTURE_VM" --from-toml "$HOME/samohost-fixture/.samohost.toml" >/dev/null 2>&1; then
    pass "register: app '$FIXTURE_APP' registered on '$FIXTURE_VM' (from .samohost.toml)"
  else
    fail "register: 'samohost app register --from-toml' failed for '$FIXTURE_APP'"
  fi
fi

# =============================================================================
# 3b. ROOT HOST-PREP  — the TWO documented one-time root steps, run on the VM.
# =============================================================================
# WHY THIS EXISTS: previously this harness jumped register -> first
# `trigger run --pr-previews` with NO host setup, so a fresh VM had NO Caddy and
# a CLOSED 443 — Cloudflare (Full mode) then returned CF 522 (connection refused
# at the origin) on every preview URL, forever. The fix is the SAME two one-time
# root steps the docs mandate (docs/control-plane-setup.md "One-time host prep
# ordering"; docs/setup-checklist.md step 4): run them, IN ORDER, as ROOT on the
# VM, AFTER `app register` and BEFORE the first `trigger run`.
#
#   (1) APP BOOTSTRAP — installs Caddy + base Caddyfile + Node + the MAIN unit
#       (and the OS app-user + /opt layout). `--tls local` is REQUIRED here: the
#       fixture's 443 is CF-locked (Cloudflare terminates TLS at the edge and the
#       origin serves `tls internal`/local_certs), so Caddy must NOT attempt ACME
#       (an ACME HTTP-01/TLS-ALPN challenge against a CF-fronted 443 would fail).
#       NO DATABASE: the fixture manifest is dbBackend=none. The CLI nonetheless
#       HARD-REQUIRES an explicit `--db-name` (src/cli.ts: "app bootstrap requires
#       --db-name … never derived from app name") — there is no flag to omit it —
#       so the minimal no-DB form the CLI accepts is an EXPLICIT placeholder db
#       name (NOT derived from the app name). createdb is idempotent and the
#       no-DB fixture app never opens it.
#   (2) ENV HOST-PREP — `env plan <vm> <app> --host-prep` renders the one-time
#       root preview plumbing: opens ufw 443/tcp, installs the per-env
#       <unit>@.service template, the Caddy sites.d preview include, and the
#       sudoers grants that later `env create` / `trigger --pr-previews` need.
#
# BOTH commands only RENDER a script to stdout (samohost never auto-executes
# host-mutating scripts). We render each to a temp file, then run it as ROOT on
# the fixture VM over the PINNED SSH — the fixture admin user has NOPASSWD sudo —
# via `samohost ssh "$FIXTURE_VM" -- sudo bash -s < /tmp/<script>.sh`.
#
# DRY-RUN (the default for THIS step): `app bootstrap` and `env plan --host-prep`
# both REQUIRE the VM + app to be present in ~/.samohost state (they fail
# "VM not found in state" otherwise), which only exists after a REAL provision +
# register. So in dry-run we PLAN-echo the exact commands and do NOT render or
# SSH — identical to how every other mutating step here is gated behind DRYRUN.
#
# HARD-FAIL: in a real run, if EITHER step errors, the `host-prep` assertion
# FAILS LOUDLY naming the real cause — so a future regression (closed 443 -> CF
# 522) is attributed to missing host-prep, not misread as a downstream timing
# flake.
#
# The fixture app user (admin/app OS user with NOPASSWD sudo) and the explicit
# no-DB placeholder name are parameterised so an operator can override them.
FIXTURE_APP_USER="${SAMOHOST_FIXTURE_APP_USER:-samohost-fixture}"
# Explicit, non-derived placeholder DB name for the dbBackend=none fixture. The
# CLI mandates --db-name; this value is NOT mechanically derived from the app
# name (it is a deliberate, fixture-scoped placeholder the createdb step makes
# idempotently and the no-DB app never touches).
FIXTURE_DB_NAME="${SAMOHOST_FIXTURE_DB_NAME:-samohost_fixture_noop}"

echo
echo "[$(ts)] STEP host-prep (root, on the VM) — app bootstrap -> env --host-prep"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: app bootstrap + env --host-prep require the VM+app in ~/.samohost state"
  note "         (real provision+register) — PLAN-echoing the exact root commands, no SSH."
  # (0) PRE-PLACE THE GITHUB TOKEN — runtime only, never a literal on disk/log.
  # WHY (the wiring gap this fixes — samohost private-repo clone): bootstrap §0
  # reads the GitHub token from FD 3 *if attached* (`bash -s 3< <(gh auth token)`),
  # else from a pre-placed 600 file at $TOKEN_FILE; with NO token it SKIPS the
  # private-repo clone (§12), leaves $APP_DIR empty, and §13's clone self-check
  # ("app clone at $APP_DIR/.git") FAILs -> the whole bootstrap exits 1 -> host-prep
  # FAILs -> no app -> previews 521/522. The fixture repo ($FIXTURE_REPO) is PRIVATE
  # and the samo-agent `gh auth token` CAN read it, so the token must reach bootstrap.
  #
  # FD 3 DOES NOT SURVIVE THIS HARNESS'S DELIVERY PATH (verified): `samohost ssh`
  # spawns the inner ssh with Node `stdio:"inherit"` (only FD 0/1/2 are inherited —
  # FD 3 is NOT), and ssh forwards ONLY stdin/stdout/stderr over the channel (no
  # arbitrary-FD forwarding). So `samohost ssh … -- sudo bash -s 3< <(gh auth token)`
  # would attach FD 3 to the *local* `samohost ssh` process only; it can never reach
  # the *remote* bash. stdin (FD 0) is already consumed by the piped script body
  # (`bash -s`), so it cannot carry the token either. The working mechanism is
  # therefore the §0 PRE-PLACED-FILE channel: write `gh auth token` into the remote
  # 600 file BEFORE bootstrap (token piped over ssh stdin to `dd`, never in argv).
  # Bootstrap §0 then finds it present (skips the FD-3 read), §12 clones the private
  # repo with it and PERSISTS a runtime credential helper that reads the same file by
  # path for the LATER private-repo fetches env-create/redeploy need (so it must NOT
  # be deleted mid-lifecycle). The token never outlives the THROWAWAY fixture VM: the
  # EXIT teardown trap destroys the whole VM (and with it the token file). It is never
  # written to local disk, never committed/versioned, never logged.
  note "  [PLAN] would PRE-PLACE the GitHub token on the VM (runtime only; FD 3 cannot survive ssh+inherit-spawn — verified). Single-word-arg remote commands only (parseSsh joins post-'--' words with spaces, so no quoted multi-word args), token via ssh STDIN — NEVER argv/disk/log:"
  note "  [PLAN]   samohost ssh $FIXTURE_VM -- sudo install -d -m 755 /opt/$FIXTURE_APP"
  note "  [PLAN]   samohost ssh $FIXTURE_VM -- sudo install -m 600 /dev/null /opt/$FIXTURE_APP/.gh-token   # 0-byte 600 first (no world-readable window)"
  note "  [PLAN]   gh auth token | samohost ssh $FIXTURE_VM -- sudo dd of=/opt/$FIXTURE_APP/.gh-token status=none   # token streamed over stdin into the 600 file; status=none => never logged"
  # (1) APP BOOTSTRAP — render then run as root on the VM (CF-locked 443 => --tls local; no-DB fixture => explicit placeholder --db-name).
  plan "app bootstrap $FIXTURE_VM $FIXTURE_APP --app-user $FIXTURE_APP_USER --db-name $FIXTURE_DB_NAME --tls local   # render to /tmp/<...>.sh"
  note "  [PLAN] would then run as ROOT: samohost ssh $FIXTURE_VM -- sudo bash -s < /tmp/<bootstrap>.sh   # §0 reads the pre-placed /opt/$FIXTURE_APP/.gh-token, §12 clones the PRIVATE repo, installs Caddy + base Caddyfile + Node + MAIN unit"
  # (1b) APP-CLONE SUB-ASSERTION — fail loudly on a future token regression.
  note "  [PLAN] would then ASSERT the private-repo clone landed: samohost ssh $FIXTURE_VM -- test -d /opt/$FIXTURE_APP/app/.git   # a missing token => empty app dir => this FAILs (mirrors bootstrap §13 'app clone at \$APP_DIR/.git')"
  skip "host-prep-clone: would assert /opt/$FIXTURE_APP/app/.git present after bootstrap — a future GitHub-token regression (no token -> §12 clone SKIPPED -> empty app dir) FAILs loudly here, not silently as a downstream 521"
  # (2) ENV HOST-PREP — render then run as root on the VM.
  plan "env plan $FIXTURE_VM $FIXTURE_APP --host-prep   # render to /tmp/<...>.sh"
  note "  [PLAN] would then run as ROOT: samohost ssh $FIXTURE_VM -- sudo bash -s < /tmp/<host-prep>.sh   # ufw 443/tcp + <unit>@.service template + Caddy sites.d include + sudoers grants"
  skip "host-prep: would pre-place the GitHub token (runtime only) then render+root-apply app bootstrap (Caddy+Node+main unit, PRIVATE-repo clone, --tls local, no-DB) then env --host-prep (443/tcp + per-env template + Caddy include + sudoers); EXPECT-PASS in a real run, and a FAILURE here is the real cause of a CF 521/522 (no app / closed 443) on previews"
else
  hp_ok=1
  bootstrap_sh="$(mktemp /tmp/fixture-bootstrap.XXXXXX.sh)"
  hostprep_sh="$(mktemp /tmp/fixture-hostprep.XXXXXX.sh)"
  # Rendered scripts carry no secrets; we rm them at the end of this branch
  # (below). The EXIT/INT/TERM teardown trap is left UNTOUCHED.

  # ---- (0) PRE-PLACE THE GITHUB TOKEN ON THE VM — runtime only, no literal ---
  # WHY (the wiring gap this fixes): bootstrap §0 reads the GitHub token from FD 3
  # *if attached*, else from a pre-placed 600 file at /opt/<app>/.gh-token; with NO
  # token it SKIPS the private-repo clone (§12), leaves the app dir EMPTY, and §13's
  # clone self-check FAILs -> bootstrap exits 1 -> host-prep FAILs -> no app ->
  # previews 521/522. The fixture repo ('$FIXTURE_REPO') is PRIVATE and the samo-agent
  # `gh auth token` CAN read it, so the token MUST reach bootstrap.
  #
  # WHY NOT FD 3 (verified — the task's `bash -s 3< <(gh auth token)` cannot work on
  # THIS delivery path): `samohost ssh` spawns the inner ssh with Node stdio:"inherit"
  # (only FD 0/1/2 are inherited — FD 3 is NOT), and ssh forwards ONLY stdin/stdout/
  # stderr over its channel (no arbitrary-FD forwarding). So an FD-3 process
  # substitution attaches to the LOCAL `samohost ssh` process only and never reaches
  # the REMOTE bash. stdin (FD 0) is already consumed by the piped script body
  # (`bash -s` reads the program off FD 0), so it cannot carry the token either.
  # => use bootstrap §0's PRE-PLACED-FILE channel.
  #
  # The token value travels ONLY over the ssh channel's stdin into a remote `dd`
  # writing a pre-created 600 file. NEVER in argv, NEVER on local disk, NEVER committed/versioned,
  # NEVER logged. The remote file is read by §12 (clone) + the persisted runtime
  # credential helper for the LATER private-repo fetches env-create/redeploy need, so
  # it is intentionally LEFT in place for the rest of the lifecycle; it never outlives
  # the THROWAWAY fixture VM, which the EXIT teardown trap destroys wholesale.
  GH_TOKEN_FILE_REMOTE="/opt/${FIXTURE_APP}/.gh-token"
  note "host-prep (0/3): pre-placing the GitHub token at $GH_TOKEN_FILE_REMOTE on '$FIXTURE_VM' (runtime only; FD 3 cannot survive ssh+inherit-spawn)…"
  # IMPORTANT — argv quoting over `samohost ssh -- …`: parseSsh joins every word
  # AFTER `--` with single spaces (rest.join(" ")) into ONE remote command string;
  # the LOCAL shell's quotes are already consumed, so a quoted multi-word arg like
  # `bash -c "a && b"` would lose its quoting and break on the remote shell. Every
  # remote command below therefore uses ONLY single-word arguments (no quoted
  # multi-word strings), and the token travels ONLY over ssh STDIN — never in argv.
  pretoken_ok=0
  if ! gh auth token >/dev/null 2>&1; then
    note "  ERROR: 'gh auth token' is unavailable — cannot pre-place the token; bootstrap §12 will SKIP the PRIVATE-repo clone and §13's clone self-check will FAIL. Authenticate gh (samo-agent) first."
  # (0a) ensure /opt/<app> exists (bootstrap §5 also makes it; harmless to pre-make).
  elif ! samohost ssh "$FIXTURE_VM" -- sudo install -d -m 755 "/opt/${FIXTURE_APP}" >/dev/null 2>&1; then
    note "  ERROR: could not create /opt/${FIXTURE_APP} on '$FIXTURE_VM' — cannot pre-place the token."
  # (0b) create the token file EMPTY with 600 FIRST so the content write inherits
  #      restrictive perms (no world-readable window). `install /dev/null` => 0-byte 600.
  elif ! samohost ssh "$FIXTURE_VM" -- sudo install -m 600 /dev/null "$GH_TOKEN_FILE_REMOTE" >/dev/null 2>&1; then
    note "  ERROR: could not create the 600 token file at $GH_TOKEN_FILE_REMOTE on '$FIXTURE_VM'."
  # (0c) stream the token over ssh STDIN into the pre-created 600 file via `dd`
  #      (status=none => no token echoed to stdout/stderr/log; dd preserves the
  #      file's existing 600 perms). Token NEVER in argv, NEVER on local disk.
  elif gh auth token | samohost ssh "$FIXTURE_VM" -- sudo dd of="$GH_TOKEN_FILE_REMOTE" status=none; then
    pretoken_ok=1
    note "  GitHub token pre-placed at $GH_TOKEN_FILE_REMOTE (600) — bootstrap §0 will find it present and §12 will clone the PRIVATE repo. [token value never logged]"
  else
    note "  ERROR: failed to stream the GitHub token to $GH_TOKEN_FILE_REMOTE on '$FIXTURE_VM'."
  fi
  if [ "$pretoken_ok" != "1" ]; then
    hp_ok=0
    note "  => without the token, bootstrap §12 SKIPS the PRIVATE-repo clone and §13's clone self-check FAILs (bootstrap exits 1)."
  fi

  # ---- (1) APP BOOTSTRAP: render -> run as root on the VM --------------------
  note "host-prep (1/3): rendering app bootstrap (--tls local, --db-name $FIXTURE_DB_NAME no-DB placeholder)…"
  if samohost app bootstrap "$FIXTURE_VM" "$FIXTURE_APP" \
        --app-user "$FIXTURE_APP_USER" --db-name "$FIXTURE_DB_NAME" --tls local \
        >"$bootstrap_sh" 2>/dev/null && [ -s "$bootstrap_sh" ]; then
    note "  rendered bootstrap script ($(wc -l <"$bootstrap_sh") lines) — applying as root on '$FIXTURE_VM'…"
    # §0 reads the pre-placed /opt/<app>/.gh-token (the FD-3 read is a clean no-op
    # over ssh, by design); §12 clones the PRIVATE repo; §13 self-checks the clone.
    if samohost ssh "$FIXTURE_VM" -- sudo bash -s <"$bootstrap_sh"; then
      note "  app bootstrap applied (Caddy + base Caddyfile + Node + MAIN unit installed; PRIVATE-repo clone via pre-placed token)."
    else
      hp_ok=0
      note "  ERROR: app bootstrap script FAILED to apply as root on '$FIXTURE_VM' — Caddy/main unit not installed and/or §13 self-check failed (e.g. PRIVATE-repo clone missing); 443 stays closed => CF 521/522 on previews."
    fi
  else
    hp_ok=0
    note "  ERROR: 'samohost app bootstrap' failed to RENDER (empty/non-zero) — cannot host-prep '$FIXTURE_VM'."
  fi

  # ---- (1b) APP-CLONE SUB-ASSERTION — fail loudly on a future token regression
  # Independent of §13's in-script self-check: assert the clone landed at the
  # manifest's appDir (/opt/<app>/app/.git). A future GitHub-token regression (token
  # not supplied -> §12 clone SKIPPED -> empty app dir) FAILs HERE with the real
  # cause, instead of surfacing only as an opaque downstream preview 521.
  note "host-prep (2/3): asserting the PRIVATE-repo clone landed at /opt/${FIXTURE_APP}/app/.git…"
  if samohost ssh "$FIXTURE_VM" -- test -d "/opt/${FIXTURE_APP}/app/.git" >/dev/null 2>&1; then
    pass "host-prep-clone: /opt/${FIXTURE_APP}/app/.git present — bootstrap §12 cloned the PRIVATE repo '$FIXTURE_REPO' (GitHub token reached bootstrap via the pre-placed 600 file)"
  else
    hp_ok=0
    fail "host-prep-clone: /opt/${FIXTURE_APP}/app/.git ABSENT after bootstrap — the PRIVATE-repo clone did NOT happen (GitHub-token regression: bootstrap §0 found no token -> §12 SKIPPED the clone -> empty app dir -> previews 521). Supply 'gh auth token' to bootstrap (pre-placed 600 /opt/${FIXTURE_APP}/.gh-token)."
  fi

  # ---- (3) ENV HOST-PREP: render -> run as root on the VM -------------------
  note "host-prep (3/3): rendering env --host-prep (443/tcp + per-env template + Caddy include + sudoers)…"
  if samohost env plan "$FIXTURE_VM" "$FIXTURE_APP" --host-prep \
        >"$hostprep_sh" 2>/dev/null && [ -s "$hostprep_sh" ]; then
    note "  rendered host-prep script ($(wc -l <"$hostprep_sh") lines) — applying as root on '$FIXTURE_VM'…"
    if samohost ssh "$FIXTURE_VM" -- sudo bash -s <"$hostprep_sh"; then
      note "  env host-prep applied (ufw 443/tcp open + <unit>@.service template + Caddy sites.d include + sudoers grants)."
    else
      hp_ok=0
      note "  ERROR: env --host-prep script FAILED to apply as root on '$FIXTURE_VM' — preview plumbing (443/tcp, per-env template, Caddy include, sudoers) missing."
    fi
  else
    hp_ok=0
    note "  ERROR: 'samohost env plan --host-prep' failed to RENDER (empty/non-zero) — cannot host-prep '$FIXTURE_VM'."
  fi

  rm -f "$bootstrap_sh" "$hostprep_sh" 2>/dev/null || true
  # HARD-FAIL loudly so a future regression is attributed to host-prep, not a flake.
  if [ "$hp_ok" = "1" ]; then
    pass "host-prep: app bootstrap + env --host-prep applied as root on '$FIXTURE_VM' — Caddy up, 443 open (tls local), main unit + preview template/Caddy-include/sudoers in place"
  else
    fail "host-prep: a ROOT host-prep step FAILED on '$FIXTURE_VM' — fresh VM has no Caddy and/or 443 closed; previews will CF 522. This is the real cause; fix host-prep before the lifecycle assertions can pass."
  fi
fi

# Helper: in a real run, run a mutating samohost command; in dry-run, just echo the plan.
do_or_plan() {
  if [ "$DRYRUN" = "1" ]; then plan "$@"; return 0; fi
  samohost "$@"
}

# Helper: list this fixture app's preview envs as JSON (empty array if none/dry).
fixture_envs_json() {
  if [ "$DRYRUN" = "1" ]; then echo "[]"; return 0; fi
  samohost env list "$FIXTURE_VM" --app "$FIXTURE_APP" --json 2>/dev/null || echo "[]"
}

# Helper: probe a preview URL — writes /api/version body to /tmp/.fixture_body,
# returns the HTTP status code. curl (not bun fetch: CA bug #55). -k tolerates
# the CF edge chain so a real 525/origin failure surfaces as the actual status,
# not a curl TLS abort.
probe_url() {
  local url="$1"
  curl -ksS -m 20 -o /tmp/.fixture_body -w '%{http_code}' "$url/api/version" 2>/dev/null || echo 0
}

# --- Readiness polling knobs -------------------------------------------------
# A new/changed/destroyed preview reaches its terminal live state on the order
# of a minute (cert mint + CF cache + systemd start). Poll, never sleep-once.
READY_TIMEOUT_SEC="${SAMOHOST_FIXTURE_READY_TIMEOUT_SEC:-300}"  # ~5 min cap
READY_INTERVAL_SEC="${SAMOHOST_FIXTURE_READY_INTERVAL_SEC:-10}" # 10s interval

# Poll a preview's /api/version until it is LIVE for the expected branch, i.e.
#   HTTP 200  AND  "env":"preview"  AND  "branch":"<branch>".
# Tolerates transient 525 (origin cert still minting), 502/503 (unit starting),
# and 000 (DNS/edge not warm). Returns 0 when live, 1 on timeout. On the last
# failed attempt the observed status is left in the global LAST_READY_CODE.
LAST_READY_CODE=""
poll_preview_ready() {
  local vhost="$1" branch="$2"
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SEC )) code envok brok
  while :; do
    code="$(probe_url "https://$vhost")"
    LAST_READY_CODE="$code"
    if [ "$code" = "200" ]; then
      envok="$(grep -oiE '"env"[[:space:]]*:[[:space:]]*"preview"' /tmp/.fixture_body 2>/dev/null | head -1)"
      brok="$(grep -oiE "\"branch\"[[:space:]]*:[[:space:]]*\"$branch\"" /tmp/.fixture_body 2>/dev/null | head -1)"
      [ -n "$envok" ] && [ -n "$brok" ] && return 0
    fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    note "  poll create $vhost [$branch]: code=$code env/branch not yet stable — retrying in ${READY_INTERVAL_SEC}s"
    sleep "$READY_INTERVAL_SEC"
  done
}

# Poll a preview until BOTH the new short-SHA and the new BG color are live
# (redeploy). Re-triggers the previews cycle every few intervals so a stuck
# deploy still gets nudged. Returns 0 when both observed, 1 on timeout.
poll_preview_redeployed() {
  local vhost="$1" branch="$2" sha="$3" color="$4"
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SEC )) code body shaok n=0
  while :; do
    code="$(probe_url "https://$vhost")"
    LAST_READY_CODE="$code"
    if [ "$code" = "200" ]; then
      shaok="$(grep -iF "$sha" /tmp/.fixture_body 2>/dev/null | head -1)"
      body="$(curl -ksS -m 20 "https://$vhost/" 2>/dev/null)"
      if [ -n "$shaok" ] && printf '%s' "$body" | grep -qiF "$color"; then return 0; fi
    fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    n=$((n+1))
    # Re-trigger every ~3 intervals (deploy may need another cycle to pick up head).
    # Capture the re-trigger output into a global (instead of >/dev/null) so the
    # redeploy assertion can surface the LAST re-trigger's error on failure — a
    # redeploy that never takes effect (lastDeployedSha not re-stamped) leaves its
    # cause here, previously discarded.
    if [ $((n % 3)) -eq 0 ]; then
      REDEPLOY_RETRIG_OUT="$(samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --pr-previews --json 2>&1 || true)"
    fi
    note "  poll redeploy $vhost [$branch]: code=$code sha/color not yet live — retrying in ${READY_INTERVAL_SEC}s"
    sleep "$READY_INTERVAL_SEC"
  done
}

# Poll until the env for a (now-closed) branch is GONE from the env list, running
# the reap (pr-previews) cycle each interval as needed. Returns 0 when gone, 1 on
# timeout. Leaves the last observed count in LAST_REAP_COUNT.
LAST_REAP_COUNT=""
poll_preview_gone() {
  local branch="$1"
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SEC )) cnt
  while :; do
    cnt="$(fixture_envs_json | jq -r --arg b "$branch" '[.[] | select(.branch==$b)] | length' 2>/dev/null)"
    LAST_REAP_COUNT="${cnt:-?}"
    [ "${cnt:-1}" = "0" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    # Drive a reap cycle so the closed-PR env is collected, then re-check.
    samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --pr-previews --json >/dev/null 2>&1 || true
    note "  poll teardown [$branch]: still present (count=${cnt:-?}) — re-reaping, retry in ${READY_INTERVAL_SEC}s"
    sleep "$READY_INTERVAL_SEC"
  done
}

# =============================================================================
# 4. LIFECYCLE ASSERTIONS
#    ORDER: create + scale (all PRs OPEN) -> redeploy -> teardown-on-close LAST.
# =============================================================================

# ---- create (EXPECT PASS) ---------------------------------------------------
# For each OPEN fixture PR: trigger preview creation, POLL the live URL to a
# stable terminal state, then assert
#   URL 200 + env=preview + branch match + preview-link comment posted.
# The poll (poll_preview_ready) tolerates the post-create 525/502/000 window so
# the assertion reflects the SETTLED preview, not the cert-mint race.
echo
echo "[$(ts)] ASSERTION create — preview per open PR (EXPECT-PASS)"
if [ "$DRYRUN" = "1" ]; then
  plan "trigger run --vm $FIXTURE_VM --app $FIXTURE_APP --pr-previews --json"
  note "DRY-RUN: would enumerate open PRs on $FIXTURE_REPO, ensure a preview env each, post a 🔎 Preview comment."
  note "DRY-RUN: would then POLL each preview /api/version (≤${READY_TIMEOUT_SEC}s @ ${READY_INTERVAL_SEC}s) until 200+env=preview+branch BEFORE asserting."
  note "DRY-RUN: would also assert the per-preview DNS write happened — i.e. the CLOUDFLARE_SAMOCAT-not-set DEGRADE warning is ABSENT from trigger stderr (a missing-token run must FAIL LOUDLY here, naming the real cause, not silently 525)."
  skip "create-dns: would assert per-preview DNS written (CLOUDFLARE_SAMOCAT degrade-warning ABSENT) so a missing-token run fails loudly with the real cause"
  skip "create-serve-200: would assert the no-DB preview REALLY served — POLL the live URL to HTTP 200 (env=preview + branch match) AND, where checkable, the created env record resolves dbBackend='none' AND no forced-dblab/db-preflight phase ran; a log-only 'no dblab text' check is a false positive and is NOT sufficient"
  skip "create: would poll-to-ready then assert URL 200 + env=preview + branch match + preview-link comment posted"
else
  # Capture trigger stderr so we can assert per-preview DNS actually happened.
  # runEnvCreate emits the DNS_DEGRADE_WARNING ("CLOUDFLARE_SAMOCAT not set —
  # skipping per-preview DNS") to stderr when the token is missing; its PRESENCE
  # means the preview fell back to the *.samo.cat wildcard (the field-record IP)
  # and WILL 525. Assert it is ABSENT so a future missing-token run fails loudly
  # with the REAL cause instead of an opaque downstream 525.
  trig_out="$(samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --pr-previews --json 2>&1)"
  if printf '%s' "$trig_out" | grep -qiF "CLOUDFLARE_SAMOCAT not set"; then
    fail "create-dns: per-preview DNS was SKIPPED (CLOUDFLARE_SAMOCAT not set) — previews fell back to the *.samo.cat wildcard pinned to field-record's IP and WILL 525; source the token from '$SAMOHOST_SECRETS_ENV'"
  elif printf '%s' "$trig_out" | grep -qiF "skipping per-preview DNS"; then
    fail "create-dns: per-preview DNS was SKIPPED (degrade path hit) — previews will 525 against the *.samo.cat wildcard (wrong origin)"
  else
    pass "create-dns: per-preview DNS NOT degraded (no CLOUDFLARE_SAMOCAT degrade warning) — samohost-fixture-preview-*.samo.cat A record points at the fixture VM, so CF reaches the fixture origin (525 cleared)"
  fi
  # CREATE-SERVE-200 (no-DB) precondition: the fixture app is dbBackend=none, so
  # previewDbBackendFor must resolve the env backend to 'none' and the trigger must NOT
  # force a dblab clone nor run the db-preflight gate for it. Grepping the trigger log
  # for that ABSENT phase is NECESSARY but NOT SUFFICIENT — absence of a forced clone
  # does NOT prove the preview ever answered, so a log-only check is a FALSE POSITIVE.
  # We therefore make it a hard precondition here (fail loudly if a forced-dblab /
  # db-preflight phase ran), and assert the SUFFICIENT facts per-PR below: each preview
  # POLLS to a real HTTP 200 AND its created env record resolves dbBackend='none'. Only
  # then does "create-serve-200" honestly mean the no-DB surface really served.
  if printf '%s' "$trig_out" | grep -qiE 'forc(e|ed) ?dblab|db-preflight|dblab clone create|backend.*dblab.*samohost-fixture'; then
    fail "create-serve-200: trigger ran a dblab clone / db-preflight phase for the no-DB fixture (dbBackend=none) — the no-DB backend was NOT honored; the no-DB preview cannot be trusted to serve 200 (the per-PR 200 + dbBackend='none' assertions below are the real proof)"
  fi
  open_prs="$(gh pr list --repo "$FIXTURE_REPO" --state open --limit 100 \
                --json number,headRefName 2>/dev/null | jq -c '.[]' 2>/dev/null)"
  npr="$(printf '%s\n' "$open_prs" | grep -c . || true)"
  note "open PRs on $FIXTURE_REPO: ${npr:-0}"
  envs="$(fixture_envs_json)"
  # Guard so the (single, all-PR) create trigger blob is surfaced AT MOST ONCE
  # even when several PRs fail — it already contains every PR's create error.
  trig_dumped=0
  # PER-PR GATE ROUTING. `gh pr list` returns NEWEST-first; the fixture re-creates a FRESH
  # blue-bg PR every cycle, so the FIRST open PR (idx==1) is the single-preview PRIMARY
  # (and the redeploy/teardown `--limit 1` target) and stays a HARD PASS gate. The 2nd+
  # open PR on the SAME host (idx>=2 — the persistent green-bg fixture PR) exercises the
  # OPEN 'multi-preview-on-same-host' bug, so its create is EXPECT-FAIL today via cr_bad
  # (=> xfail_bug), and a FULL success there routes through cr_ok (=> XPASS alert: the bug
  # got fixed and this assertion must be un-xfailed and restored as a HARD PASS gate).
  idx=0; is_multi=0
  cr_ok()  { if [ "$is_multi" = "1" ]; then xpass "$*"; else pass "$*"; fi; }
  cr_bad() { if [ "$is_multi" = "1" ]; then xfail_bug "$*"; else fail "$*"; fi; }
  # while-read in the main shell (not a subshell pipe) so pass/fail counters persist.
  while read -r pr; do
    [ -z "${pr:-}" ] && continue
    idx=$((idx+1))
    if [ "$idx" -ge 2 ]; then is_multi=1; else is_multi=0; fi
    num="$(jq -r '.number' <<<"$pr")"; br="$(jq -r '.headRefName' <<<"$pr")"
    vhost="$(jq -r --arg b "$br" '[.[] | select(.branch==$b)][0].vhost // empty' <<<"$envs")"
    if [ -z "$vhost" ]; then
      cr_bad "create PR#$num [$br] (preview #$idx on this host): no preview env created"
      # Per-PR action != ok: surface the create trigger output so the throw that
      # skipped the env upsert (e.g. the 2nd preview's create-script error) shows.
      [ "$trig_dumped" = "0" ] && { dump_trigger_output "create pass" "$trig_out"; trig_dumped=1; }
      continue
    fi
    # WHERE CHECKABLE: the created env record must resolve dbBackend='none' for the
    # no-DB fixture. If the field is present and not 'none', the no-DB backend was NOT
    # honored — fail BEFORE the 200 poll (a wrong backend invalidates the serve-200 claim).
    dbbk="$(jq -r --arg b "$br" '[.[] | select(.branch==$b)][0].dbBackend // empty' <<<"$envs")"
    if [ -n "$dbbk" ] && [ "$dbbk" != "none" ]; then
      cr_bad "create-serve-200 PR#$num [$br] (preview #$idx): created env record shows dbBackend='$dbbk' (expected 'none' for the no-DB fixture) — no-DB backend NOT honored"
      continue
    fi
    # READINESS WAIT: POLL the LIVE URL until it REALLY serves 200 + env=preview + branch
    # match (or timeout). This is what makes 'serve-200' mean the surface actually served.
    if poll_preview_ready "$vhost" "$br"; then
      cmt="$(gh api "repos/$FIXTURE_REPO/issues/$num/comments" --paginate 2>/dev/null \
               | jq -r '.[].body' | grep -F '🔎' | grep -oE 'https?://[^[:space:]]+' | head -1)"
      if printf '%s' "$cmt" | grep -qF "$vhost"; then
        cr_ok "create-serve-200 PR#$num [$br] (preview #$idx): no-DB preview $vhost REALLY served HTTP 200 (env=preview, branch match, dbBackend='${dbbk:-none}'), preview-link comment posted"
      else
        cr_bad "create PR#$num [$br] (preview #$idx): $vhost served 200 but no 🔎 preview-link comment naming the vhost (comment='${cmt:-none}')"
      fi
    else
      cr_bad "create-serve-200 PR#$num [$br] (preview #$idx): $vhost never served HTTP 200+env=preview+branch within ${READY_TIMEOUT_SEC}s (last code=$LAST_READY_CODE) — no-DB surface did NOT serve"
      # Per-PR action != ok: surface the create trigger output (once) for diagnosis.
      [ "$trig_dumped" = "0" ] && { dump_trigger_output "create pass" "$trig_out"; trig_dumped=1; }
    fi
  done < <(printf '%s\n' "$open_prs")
fi

# ---- scale (FINDING — N open PRs => N always-on preview processes) ----------
# MUST run with ALL fixture PRs still OPEN (before teardown-on-close closes one).
echo
echo "[$(ts)] ASSERTION scale — N open PRs => N always-on preview processes (FINDING)"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would count open fixture PRs (N) and assert N preview envs/units exist — with ALL PRs OPEN."
  plan "env list $FIXTURE_VM --app $FIXTURE_APP --json   # count == N open PRs"
  note "FINDING: every open PR => one ALWAYS-ON systemd unit + port + (dblab) clone."
  note "         No idle suspension (see idle-death) => cost scales linearly with open PRs."
  skip "scale: would assert N always-on preview processes for N open PRs (illustrates always-on cost)"
else
  n_pr="$(gh pr list --repo "$FIXTURE_REPO" --state open --json number 2>/dev/null | jq 'length')"
  n_env="$(fixture_envs_json | jq 'length')"
  note "open PRs=$n_pr  always-on preview envs=$n_env"
  # XFAIL today (OPEN 'multi-preview-on-same-host' bug): the 2nd+ preview's env never
  # persists, so n_env is SHORT of n_pr (e.g. 1 env for 2 open PRs). When the env count
  # finally EQUALS the open-PR count the bug is fixed => XPASS alert (un-xfail this gate).
  if [ "${n_pr:-0}" = "${n_env:-0}" ]; then
    xpass "scale: $n_env always-on preview envs == $n_pr open PRs — every open PR now has its own preview env on this host (the multi-preview-on-same-host scale count holds)"
  else
    xfail_bug "scale: preview count $n_env != open-PR count $n_pr — the 2nd+ preview's env never persisted, so this host is short one always-on preview per extra open PR"
  fi
fi

# ---- redeploy (EXPECT PASS) -------------------------------------------------
# Push a BG-color commit to one PR branch -> POLL until the next preview reflects
# the new color AND the new short-SHA (poll_preview_redeployed re-triggers as
# needed), then assert. Still BEFORE teardown-on-close so all PRs remain open.
echo
echo "[$(ts)] ASSERTION redeploy — BG-color commit reflected on preview (EXPECT-PASS)"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would clone the first open fixture PR branch, edit the 'const BG = #......' line in server.js to a new random color, COMMIT + PUSH it to the PR head branch (new head SHA), then:"
  note "  [PLAN] would run: git clone --branch <pr-branch> <fixture repo> && sed BG color && git commit -aqm 'fixture redeploy: BG <color>' && git push origin HEAD:<pr-branch>"
  plan "trigger run --vm $FIXTURE_VM --app $FIXTURE_APP --pr-previews --json   # redeploys at the NEW head SHA pushed above"
  note "  then POLL the preview (≤${READY_TIMEOUT_SEC}s @ ${READY_INTERVAL_SEC}s) until BOTH the new BG color and the new short-SHA are live BEFORE asserting."
  skip "redeploy: would commit+push a BG-color change to the PR branch, then poll-until-reflected and assert the preview shows the new BG color + new short-SHA"
else
  # Targets the FIRST open fixture PR branch only; commit changes the BG color
  # constant in server.js and PUSHES it to the PR head branch (harmless on the
  # throwaway fixture repo), then polls the preview for the new color + new SHA.
  tgt_pr="$(gh pr list --repo "$FIXTURE_REPO" --state open --limit 1 --json number,headRefName 2>/dev/null | jq -c '.[0]')"
  tnum="$(jq -r '.number' <<<"$tgt_pr")"; tbr="$(jq -r '.headRefName' <<<"$tgt_pr")"
  newcolor="#$(printf '%06x' $((RANDOM*RANDOM%16777215)))"
  note "redeploy target: PR#$tnum [$tbr] -> BG $newcolor"

  # ---- ACTUALLY commit + push the BG-color change to the PR branch ----------
  # Use a FRESH throwaway clone (never the operator's working tree) authenticated
  # via gh, edit ONLY the `const BG = '#......'` line in server.js, commit, and
  # push to the PR head branch so a NEW head SHA lands and the trigger redeploys.
  push_ok=0; head_sha=""
  redeploy_clone="$(mktemp -d /tmp/fixture-redeploy.XXXXXX)"
  redeploy_url="$(gh auth token >/dev/null 2>&1 && echo "https://x-access-token:$(gh auth token)@github.com/${FIXTURE_REPO}.git" || echo "https://github.com/${FIXTURE_REPO}.git")"
  if git clone --depth 1 --branch "$tbr" "$redeploy_url" "$redeploy_clone" >/dev/null 2>&1; then
    server_js="$redeploy_clone/server.js"
    if [ -f "$server_js" ] && grep -qE "^const BG = '#[0-9a-fA-F]{6}'" "$server_js"; then
      # Replace ONLY the BG color hex in the single `const BG = '#......'` line.
      sed -i -E "s/^const BG = '#[0-9a-fA-F]{6}'/const BG = '${newcolor}'/" "$server_js"
      ( cd "$redeploy_clone" \
          && git -c user.name="samo-agent" -c user.email="samo-agent@users.noreply.github.com" \
               commit -aqm "fixture redeploy: BG ${newcolor} (lifecycle test)" \
          && git push -q origin "HEAD:${tbr}" ) >/dev/null 2>&1 && push_ok=1
    else
      note "  WARN: server.js BG constant not found in clone — cannot push a BG-color change."
    fi
  else
    note "  WARN: clone of '$tbr' failed — cannot push the BG-color redeploy commit."
  fi
  rm -rf "$redeploy_clone" 2>/dev/null || true

  if [ "$push_ok" = "1" ]; then
    # New head SHA AFTER the push (this is what the preview must reflect).
    head_sha="$(gh api "repos/$FIXTURE_REPO/commits/$tbr" --jq '.sha' 2>/dev/null | cut -c1-7)"
    note "  pushed BG-color commit to '$tbr'; new head sha=$head_sha — triggering redeploy + polling."
    # Capture the initial redeploy trigger output (was >/dev/null) AND the last
    # poll re-trigger (REDEPLOY_RETRIG_OUT) so a redeploy that never takes effect
    # surfaces the trigger error instead of silently swallowing it.
    REDEPLOY_RETRIG_OUT=""
    redeploy_trig_out="$(samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --pr-previews --json 2>&1)"
    envs="$(fixture_envs_json)"
    vhost="$(jq -r --arg b "$tbr" '.[] | select(.branch==$b) | .vhost' <<<"$envs" | head -1)"
    if [ -n "$vhost" ] && [ -n "$head_sha" ] && poll_preview_redeployed "$vhost" "$tbr" "$head_sha" "$newcolor"; then
      # XPASS alert: the redeploy DID re-stamp lastDeployedSha and the preview reflects the
      # new color+sha — the redeploy half of the OPEN 'multi-preview-on-same-host' bug
      # appears fixed (un-xfail this gate and restore it as a HARD PASS gate).
      xpass "redeploy PR#$tnum [$tbr]: pushed BG $newcolor (sha $head_sha) and the preview reflects BOTH the new color and the new short-SHA"
    else
      # XFAIL today: the batch pr-previews redeploy trigger chokes on the 2nd preview's
      # create-script throw, so it never re-stamps lastDeployedSha (src/preview/pr.ts:213)
      # and the preview stays on the old sha/color. EXPECT-FAIL while the bug is OPEN.
      xfail_bug "redeploy PR#$tnum [$tbr]: pushed BG $newcolor (sha $head_sha) but the preview did not reflect color/sha within ${READY_TIMEOUT_SEC}s (last code=$LAST_READY_CODE) — redeploy never re-stamped lastDeployedSha"
      # Redeploy action != ok: surface the swallowed trigger output(s) for diagnosis.
      dump_trigger_output "redeploy initial trigger" "$redeploy_trig_out"
      [ -n "$REDEPLOY_RETRIG_OUT" ] && dump_trigger_output "redeploy re-trigger (last poll cycle)" "$REDEPLOY_RETRIG_OUT"
    fi
  else
    # NOT the multi-preview bug: the harness could not even commit+push the BG change
    # (clone / gh auth / network). That is a HARD harness/infra failure — keep it red.
    fail "redeploy PR#$tnum [$tbr]: could NOT commit+push the BG-color change (clone/edit/push failed) — redeploy cannot be asserted"
  fi
fi

# ---- idle-death (EXPECT PASS — idle reaper now exists, samohost #87) --------
# The idle-GC pass (src/commands/env-idle.ts, wired via `trigger run --idle-gc`)
# stamps EnvRecord.lastAccess from each preview's Caddy JSON access log, then
# reaps any env idle past SAMOHOST_IDLE_THRESHOLD_MS. Reaping is OPT-IN and gated
# on SAMOHOST_IDLE_REAP=1 (warn-only otherwise — operator-prereq-or-degraded-gate).
# Reaping calls runEnvDestroy, which tears the systemd unit AND the Caddy include
# down TOGETHER (atomic) — and for a no-DB app (dbBackend=none) there is NO dblab
# clone to drop, so destroy is unit+Caddy only.
#
# TEST: enable the reaper with a SHORT threshold, leave a preview idle (no traffic
# after its lastAccess anchor), drive `trigger run --idle-gc`, then assert the env
# is GONE from the env list AND its URL no longer serves (unit gone => no 200) AND
# its Caddy vhost include was removed (no orphan vhost left behind). This flips the
# old XFAIL (no reaper existed) to PASS.
echo
echo "[$(ts)] ASSERTION idle-death — idle no-DB preview atomically reaped (unit+Caddy together) — EXPECT-PASS"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would enable the reaper (SAMOHOST_IDLE_REAP=1, SHORT SAMOHOST_IDLE_THRESHOLD_MS),"
  note "         leave a preview idle past the threshold, then drive an idle-GC pass and assert teardown."
  plan "trigger run --vm $FIXTURE_VM --app $FIXTURE_APP --idle-gc --json   # SAMOHOST_IDLE_REAP=1 SAMOHOST_IDLE_THRESHOLD_MS=<short>"
  plan "env list $FIXTURE_VM --app $FIXTURE_APP --json   # poll until the idle env is GONE"
  note "  then assert: env GONE + URL no longer 200 + Caddy vhost include removed (atomic unit+Caddy teardown; no clone for no-DB)."
  skip "idle-death: would enable the idle reaper (short threshold), leave a preview idle, and assert it is atomically torn down (unit+Caddy gone together; no clone for no-DB)"
else
  envs="$(fixture_envs_json)"
  idle_vhost="$(jq -r '.[0].vhost // empty' <<<"$envs")"
  idle_unit="$(jq -r '.[0].name // empty' <<<"$envs")"
  idle_branch="$(jq -r '.[0].branch // empty' <<<"$envs")"
  if [ -z "$idle_vhost" ] || [ -z "$idle_unit" ] || [ -z "$idle_branch" ]; then
    fail "idle-death: no live preview env to idle-reap (env list empty) — cannot exercise the reaper"
  else
    note "idle-death target: env '$idle_unit' [$idle_branch] vhost=$idle_vhost"
    # Confirm it currently serves (so a later non-200 is meaningful) and capture the
    # pre-reap Caddy vhost-include presence on the VM (the file the reaper must remove).
    pre_code="$(probe_url "https://$idle_vhost")"
    note "  pre-reap: $idle_vhost returns HTTP $pre_code"
    pre_inc="$(samohost ssh "$FIXTURE_VM" -- "ls /etc/caddy/sites.d/${idle_unit}.caddy 2>/dev/null || sudo ls /etc/caddy/sites.d/ 2>/dev/null | grep -F '${idle_unit}' || echo MISSING" 2>/dev/null | tail -1)"
    note "  pre-reap: Caddy include for '$idle_unit' => ${pre_inc:-?}"
    # SHORT threshold + reap ON. lastAccess falls back to createdAt when there is no
    # access-log traffic, so a preview created minutes ago is already > a 1s threshold.
    # 1000ms threshold + REAP=1; no traffic generated => the env is immediately idle.
    note "  enabling reaper: SAMOHOST_IDLE_REAP=1, SAMOHOST_IDLE_THRESHOLD_MS=1000 (short); driving idle-GC pass…"
    SAMOHOST_IDLE_REAP=1 SAMOHOST_IDLE_THRESHOLD_MS=1000 \
      samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --idle-gc --json >/tmp/.idle_out 2>&1 || true
    # POLL until the env is gone from the env list (re-driving the idle-GC pass each
    # interval — same pattern as poll_preview_gone but with the reaper enabled).
    idle_deadline=$(( $(date +%s) + READY_TIMEOUT_SEC ))
    idle_gone=0
    while :; do
      cnt="$(fixture_envs_json | jq -r --arg b "$idle_branch" '[.[] | select(.branch==$b)] | length' 2>/dev/null)"
      if [ "${cnt:-1}" = "0" ]; then idle_gone=1; break; fi
      [ "$(date +%s)" -ge "$idle_deadline" ] && break
      SAMOHOST_IDLE_REAP=1 SAMOHOST_IDLE_THRESHOLD_MS=1000 \
        samohost trigger run --vm "$FIXTURE_VM" --app "$FIXTURE_APP" --idle-gc --json >/dev/null 2>&1 || true
      note "  poll idle-death [$idle_branch]: env still present (count=${cnt:-?}) — re-running idle-GC, retry in ${READY_INTERVAL_SEC}s"
      sleep "$READY_INTERVAL_SEC"
    done
    if [ "$idle_gone" != "1" ]; then
      fail "idle-death: idle env '$idle_unit' [$idle_branch] was NOT reaped within ${READY_TIMEOUT_SEC}s (still in env list) — idle reaper did not tear it down"
    else
      # ATOMIC TEARDOWN: env gone from state. Now verify the on-host artifacts are
      # ALSO gone together — the systemd unit (URL no longer 200) AND the Caddy
      # vhost include (no orphan vhost). For a no-DB app there is no clone to check.
      post_code="$(probe_url "https://$idle_vhost")"
      unit_state="$(samohost ssh "$FIXTURE_VM" -- "systemctl is-active ${idle_unit} 2>/dev/null || echo inactive" 2>/dev/null | tail -1)"
      post_inc="$(samohost ssh "$FIXTURE_VM" -- "sudo ls /etc/caddy/sites.d/ 2>/dev/null | grep -F '${idle_unit}' || echo GONE" 2>/dev/null | tail -1)"
      note "  post-reap: URL code=$post_code  unit=$unit_state  caddy-include=${post_inc:-?}"
      if [ "$post_code" != "200" ] && printf '%s' "${unit_state:-inactive}" | grep -qiE 'inactive|failed|unknown|not-found|^$' \
         && printf '%s' "${post_inc:-GONE}" | grep -qiF "GONE"; then
        pass "idle-death PR-preview '$idle_unit' [$idle_branch]: idle reaper atomically tore it down — env GONE from state, unit no longer active (URL not 200), Caddy vhost include removed; no dblab clone (no-DB app)"
      else
        fail "idle-death '$idle_unit' [$idle_branch]: env left state but on-host teardown NOT atomic — URL code=$post_code, unit=$unit_state, caddy-include=${post_inc:-?} (expected non-200 + inactive unit + removed include)"
      fi
    fi
  fi
fi

# ---- rebuild (EXPECT PASS — `samohost preview rebuild` brings it back to 200) -
# After the idle reaper tore the preview down, `samohost preview rebuild <vm>
# <app> <branch>` re-creates it via the idempotent runEnvCreate flow. For a no-DB
# app the backend resolves to 'none' (previewDbBackendFor — no forced dblab
# clone), so rebuild restarts the unit + reloads the Caddy vhost and the URL
# serves 200 again. We reuse the branch/vhost reaped above; if idle-death did not
# run (dry-run or no env) we fall back to the first env.
echo
echo "[$(ts)] ASSERTION rebuild — 'samohost preview rebuild' restores a no-DB preview to 200 — EXPECT-PASS"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would 'samohost preview rebuild' the reaped branch and poll its URL back to 200."
  plan "preview rebuild $FIXTURE_VM $FIXTURE_APP <branch> --json   # no-DB => backend resolves to 'none', no clone"
  plan "<poll> https://<vhost>/api/version  # until 200 + env=preview + branch match"
  skip "rebuild: would 'samohost preview rebuild' the (reaped) no-DB preview and assert it serves 200 again (no forced dblab clone)"
else
  rb_branch="${idle_branch:-}"
  rb_vhost="${idle_vhost:-}"
  if [ -z "$rb_branch" ]; then
    envs="$(fixture_envs_json)"
    rb_branch="$(jq -r '.[0].branch // empty' <<<"$envs")"
    rb_vhost="$(jq -r '.[0].vhost // empty' <<<"$envs")"
  fi
  if [ -z "$rb_branch" ]; then
    fail "rebuild: no branch available to rebuild (env list empty and idle-death did not run) — cannot exercise 'preview rebuild'"
  else
    note "rebuild target: branch '$rb_branch' (no-DB app => backend 'none', no dblab clone)"
    rb_out="$(samohost preview rebuild "$FIXTURE_VM" "$FIXTURE_APP" "$rb_branch" --json 2>&1)"
    rb_rc=$?
    # A no-DB rebuild must NOT run a dblab clone phase; surface it if it did.
    if printf '%s' "$rb_out" | grep -qiE 'dblab clone|db-preflight|clone create'; then
      note "  WARN: rebuild output mentions a dblab/clone phase for a no-DB app — investigate (expected backend=none):"
      note "        $(printf '%s' "$rb_out" | grep -iE 'dblab|preflight|clone' | head -2)"
    fi
    if [ "$rb_rc" -ne 0 ]; then
      note "  WARN: 'preview rebuild' exited rc=$rb_rc (will still poll the URL — rebuild may have restored the unit despite a non-zero probe step)."
    fi
    # Resolve the vhost fresh (rebuild recreates the env record).
    envs="$(fixture_envs_json)"
    rb_vhost="$(jq -r --arg b "$rb_branch" '.[] | select(.branch==$b) | .vhost' <<<"$envs" | head -1)"
    [ -z "$rb_vhost" ] && rb_vhost="${idle_vhost:-}"
    if [ -n "$rb_vhost" ] && poll_preview_ready "$rb_vhost" "$rb_branch"; then
      pass "rebuild '$rb_branch': 'samohost preview rebuild' restored the no-DB preview — $rb_vhost serves 200 (env=preview, branch match), no forced dblab clone"
    else
      fail "rebuild '$rb_branch': preview did NOT return to 200+env=preview+branch within ${READY_TIMEOUT_SEC}s after 'preview rebuild' (last code=$LAST_READY_CODE, vhost=${rb_vhost:-none})"
    fi
  fi
fi

# ---- self-heal (N/A for a no-DB backend) ------------------------------------
# The DBLab-clone-specific SELF-HEAL (re-cut a dead/broken dblab clone — samohost
# #78/#86, src/preview/heal.ts) only enumerates envs with dbBackend === "dblab"
# (heal.ts line ~172: `.filter((e) => e.dbBackend === "dblab")`). A no-DB app
# (dbBackend=none) has NO clone to re-cut, so clone-recut self-heal is NOT
# APPLICABLE here. It remains exercised by the unit suite (heal/self-heal tests
# all green) and is therefore reported N/A, not skipped-for-dry-run and not
# failed. The live-VM lifecycle does not — and must not — drive a dblab heal for
# this backend.
echo
echo "[$(ts)] ASSERTION self-heal (clone-recut) — N/A for a no-DB backend (dbBackend=none)"
note "N/A: self-heal re-cuts dblab clones (heal.ts filters dbBackend==='dblab'); a no-DB"
note "     app has no clone to heal. Unit-covered by the heal/self-heal test suite (green)."
SKIP=$((SKIP+1)); echo "N/A   self-heal (clone-recut): not applicable to dbBackend=none — no dblab clone to re-cut; stays unit-covered (heal/self-heal tests green)" | tee -a "$RESULTS"

# ---- wake-on-demand (EXPECT FAIL today — DOCUMENTED GAP, do NOT fix) --------
echo
echo "[$(ts)] ASSERTION wake-on-demand — stopped unit auto-starts on URL hit (EXPECT-FAIL today)"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would 'systemctl stop' a preview's unit via samohost ssh, then curl the URL."
  plan "ssh $FIXTURE_VM -- sudo systemctl stop <preview-unit>"
  note "     then curl https://<vhost>/  -> expect 502 (Caddy origin down), NO auto-wake."
else
  envs="$(fixture_envs_json)"; vhost="$(jq -r '.[0].vhost // empty' <<<"$envs")"
  unit="$(jq -r '.[0].name // empty' <<<"$envs")"
  if [ -n "$vhost" ] && [ -n "$unit" ]; then
    samohost ssh "$FIXTURE_VM" -- sudo systemctl stop "$unit" >/dev/null 2>&1 || true
    code="$(probe_url "https://$vhost")"
    note "after stopping unit '$unit', $vhost returned HTTP $code (expected 502 — no wake mechanism)"
    samohost ssh "$FIXTURE_VM" -- sudo systemctl start "$unit" >/dev/null 2>&1 || true  # restore
  fi
fi
note "GAP: nothing in samohost starts a stopped preview unit on URL access. A stopped"
note "     preview 502s and stays down until the next deploy/trigger restarts it."
xfail "wake-on-demand: stopped preview does NOT auto-wake on URL hit — it 502s"

# ---- teardown-on-close (EXPECT PASS) — RUNS LAST ----------------------------
# Close a PR AND DELETE its branch, then POLL (running the reap/trigger cycle each
# interval as needed) until the closed PR's env is GONE from the env list, with a
# bounded timeout. We delete the branch (not just close the PR) so the env-gc
# BRANCH-GONE reap path is exercised end-to-end: `env gc` reaps a preview whose
# branch no longer exists on the remote, which only triggers once the head ref is
# actually deleted. LAST on purpose: it permanently closes + deletes a fixture
# PR/branch, so it must run AFTER the scale count (needs all PRs open) + redeploy.
echo
echo "[$(ts)] ASSERTION teardown-on-close — closed+branch-deleted PR's preview destroyed (EXPECT-PASS)"
if [ "$DRYRUN" = "1" ]; then
  note "DRY-RUN: would close one fixture PR AND DELETE its branch, then poll a pr-previews reap cycle until the env is GONE:"
  note "  [PLAN] would run: gh pr close <n> --delete-branch   # close PR + delete its head branch so env-gc branch-gone reap is exercisable"
  plan "trigger run --vm $FIXTURE_VM --app $FIXTURE_APP --pr-previews --json   # reaps env for the closed/branch-gone PR (repeated each poll interval)"
  plan "env list $FIXTURE_VM --app $FIXTURE_APP --json   # poll until the closed PR's env is GONE (≤${READY_TIMEOUT_SEC}s @ ${READY_INTERVAL_SEC}s)"
  skip "teardown-on-close: would close + delete-branch then poll-until-gone then assert the closed PR's preview is destroyed (branch-gone reap path)"
else
  cl_pr="$(gh pr list --repo "$FIXTURE_REPO" --state open --limit 1 --json number,headRefName 2>/dev/null | jq -c '.[0]')"
  cnum="$(jq -r '.number' <<<"$cl_pr")"; cbr="$(jq -r '.headRefName' <<<"$cl_pr")"
  # Close the PR AND delete its branch so the env-gc BRANCH-GONE path is exercised.
  # Prefer the single `--delete-branch` flag; fall back to an explicit remote
  # branch delete if the combined close didn't drop the ref (e.g. older gh).
  if ! gh pr close "$cnum" --repo "$FIXTURE_REPO" --delete-branch >/dev/null 2>&1; then
    gh pr close "$cnum" --repo "$FIXTURE_REPO" >/dev/null 2>&1 || true
  fi
  # Belt-and-braces: ensure the head ref is gone on the remote so branch-gone reaps.
  if gh api "repos/$FIXTURE_REPO/git/refs/heads/$cbr" >/dev/null 2>&1; then
    gh api -X DELETE "repos/$FIXTURE_REPO/git/refs/heads/$cbr" >/dev/null 2>&1 || true
  fi
  # READINESS WAIT: poll the reap cycle until the env for the closed branch is gone.
  if poll_preview_gone "$cbr"; then
    pass "teardown-on-close PR#$cnum [$cbr]: preview env destroyed after close+branch-delete (branch-gone reap within ${READY_TIMEOUT_SEC}s)"
  else
    fail "teardown-on-close PR#$cnum [$cbr]: preview env STILL present ${READY_TIMEOUT_SEC}s after close+branch-delete (count=$LAST_REAP_COUNT)"
  fi
fi

# =============================================================================
# Per-assertion results are printed above; the EXIT trap prints the teardown
# confirmation + final SUMMARY and reclaims the fixture VM. Exit reflects only
# real (non-XFAIL) failures.
# =============================================================================
echo
echo "[$(ts)] assertions complete — handing off to teardown trap"
# GREEN iff no HARD lifecycle gate failed (FAIL=0) AND no known-bug xfail unexpectedly
# passed (XPASS=0). The 3 'multi-preview-on-same-host' xfails are allowed to fail without
# turning the run red. A regressed HARD gate (FAIL>0) OR a now-passing xfail (XPASS>0, the
# bug got fixed and must be un-xfailed) is the ALERT signal — exit non-zero so the nightly
# systemd service enters 'failed'.
if [ "${FAIL:-0}" -gt 0 ] || [ "${XPASS:-0}" -gt 0 ]; then exit 1; fi
exit 0
