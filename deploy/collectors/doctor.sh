#!/usr/bin/env bash
# (a) samo doctor collector — runs `samohost doctor --all --json`, parses the
# fleet report into Prometheus metrics, and drops the raw JSON for a report
# panel. Runs as the state-owning user (testuser): the doctor sweep reads
# ~/.samohost/state.json and SSHes to each VM with that user's key.
#
# Emits:
#   samo_doctor_check{vm,check,group,status}   1=pass, 0=otherwise
#   samo_doctor_vm_probe_error{vm}             1 when a VM was unreachable
#   samo_doctor_fleet_vms_total                VMs attempted
#   samo_doctor_fleet_vms_failing              VMs with ≥1 fail check
#   samo_doctor_fleet_vms_unknown              VMs with ≥1 unknown AND 0 fail (no-sudo)
#   samo_doctor_fleet_vms_error                VMs that were SSH-unreachable
#   samo_doctor_fleet_vms_finding              VMs with suspicious findings
#   samo_doctor_scrape_success                 1 ok, 0 failed this run
#   samo_doctor_last_run_seconds               epoch of this attempt
#   samo_doctor_last_success_seconds           epoch of last GOOD run (preserved)
#
# Defensive: on any failure to obtain valid JSON, the previous last_success is
# carried forward and NO per-check series are emitted (stale-marker semantics),
# so node_exporter keeps serving a well-formed file and staleness is alertable.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SELF_DIR}/lib.sh"

PROM="samo_doctor.prom"
RAWJSON="doctor-latest.json"
DEST="${METRICS_DIR}/${PROM}"
BUN="${SAMO_BUN:-/home/testuser/.bun/bin/bun}"
REPO="${SAMO_HOST_REPO:-/home/testuser/samohost}"

BUF="$(mktemp)"; JTMP="$(mktemp)"
trap 'rm -f "$BUF" "$JTMP"' EXIT
m() { printf '%s\n' "$*" >> "$BUF"; }

NOW="$(date +%s)"
# Preserve last successful timestamp across a failed run.
PREV_SUCCESS="$(awk '/^samo_doctor_last_success_seconds /{print $2}' "$DEST" 2>/dev/null | tail -1)"
PREV_SUCCESS="$(num_or "${PREV_SUCCESS:-0}" 0)"

scrape_success=0
last_success="$PREV_SUCCESS"

# Run the fleet doctor. Exit code 1 is NORMAL (fleet has failing VMs); we care
# only about getting parseable JSON, so ignore the exit status and validate.
timeout 300 "$BUN" run "${REPO}/src/cli.ts" doctor --all --json > "$JTMP" 2>/dev/null || true

if jq -e '.vms' "$JTMP" >/dev/null 2>&1; then
  scrape_success=1
  last_success="$NOW"

  # Raw JSON for the report panel (atomic).
  publish_raw "$RAWJSON" "$JTMP" || true

  m "# HELP samo_doctor_check samohost doctor check outcome (1=pass, 0=fail/unknown/skip; raw state in 'status' label)."
  m "# TYPE samo_doctor_check gauge"
  while IFS=$'\t' read -r vm check group status; do
    [ -z "$vm" ] && continue
    val=0; [ "$status" = "pass" ] && val=1
    m "samo_doctor_check{vm=\"$(esc "$vm")\",check=\"$(esc "$check")\",group=\"$(esc "$group")\",status=\"$(esc "$status")\"} ${val}"
  done < <(jq -r '.vms[] | .vmName as $vm | (.checks // [])[] | [$vm, .id, .group, .status] | @tsv' "$JTMP")

  # Unreachable VMs.
  m "# HELP samo_doctor_vm_probe_error 1 when a VM was unreachable during the sweep."
  m "# TYPE samo_doctor_vm_probe_error gauge"
  while IFS=$'\t' read -r vm; do
    [ -z "$vm" ] && continue
    m "samo_doctor_vm_probe_error{vm=\"$(esc "$vm")\"} 1"
  done < <(jq -r '.vms[] | select(.probeError != null) | .vmName' "$JTMP")

  # Fleet aggregate counters (split: fail / unknown / skip are now distinct).
  IFS=$'\t' read -r tot failv unknv errv findv < <(jq -r '[.totalVms,.failingVms,.unknownVms,.errorVms,.findingVms]|@tsv' "$JTMP")
  m "# HELP samo_doctor_fleet_vms_total VMs attempted in the sweep (ready/adopted)."
  m "# TYPE samo_doctor_fleet_vms_total gauge"
  m "samo_doctor_fleet_vms_total $(num_or "${tot:-0}" 0)"
  m "# HELP samo_doctor_fleet_vms_failing VMs with >=1 actual fail check (excl. core-suspicious)."
  m "# TYPE samo_doctor_fleet_vms_failing gauge"
  m "samo_doctor_fleet_vms_failing $(num_or "${failv:-0}" 0)"
  m "# HELP samo_doctor_fleet_vms_unknown VMs with >=1 unknown check AND 0 fail checks (no-sudo probes)."
  m "# TYPE samo_doctor_fleet_vms_unknown gauge"
  m "samo_doctor_fleet_vms_unknown $(num_or "${unknv:-0}" 0)"
  m "# HELP samo_doctor_fleet_vms_error VMs that were SSH-unreachable during the sweep."
  m "# TYPE samo_doctor_fleet_vms_error gauge"
  m "samo_doctor_fleet_vms_error $(num_or "${errv:-0}" 0)"
  m "# HELP samo_doctor_fleet_vms_finding VMs with >=1 suspicious activity finding."
  m "# TYPE samo_doctor_fleet_vms_finding gauge"
  m "samo_doctor_fleet_vms_finding $(num_or "${findv:-0}" 0)"
fi

m "# HELP samo_doctor_scrape_success 1 if this collector run produced valid data."
m "# TYPE samo_doctor_scrape_success gauge"
m "samo_doctor_scrape_success ${scrape_success}"
m "# TYPE samo_doctor_last_run_seconds gauge"
m "samo_doctor_last_run_seconds ${NOW}"
m "# TYPE samo_doctor_last_success_seconds gauge"
m "samo_doctor_last_success_seconds ${last_success}"

publish "$PROM" "$BUF"
