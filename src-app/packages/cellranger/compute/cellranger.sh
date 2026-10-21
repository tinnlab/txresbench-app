#!/usr/bin/env bash
# cellranger — CytoAnalyst sandbox compute glue (ITEM-13, DESIGN §2). A `bash`
# language entry (ITEM-5b): a thin CLI-wrapper that drives the `cellranger count`
# binary present in the rootfs as a child process, then writes the typed
# `/outputs/manifest.json` over its native `outs/`. bwrap+seccomp confine syscalls/
# fs/network; they do NOT restrict which rootfs binaries the entry may exec — this
# is how a sandbox runs Cell Ranger. arch:['x86_64'] gates it to x86_64 backends
# (Cell Ranger has no arm64 build; DEC-29 — never emulated).
#
# Run contract (identical to the python processors, `sandbox/outputs.rs`): read
# `/inputs/<slot>` + `/inputs/params.json`; write `/outputs/<file>` +
# `/outputs/manifest.json` = {"outputs":[{id,datatype,path,layout,role}]}. Progress
# lines `phase|pct|message` go to $CYTO_PROGRESS_FIFO. Roots overridable via
# CYTO_INPUTS_DIR / CYTO_OUTPUTS_DIR (unset in the sandbox → the fixed binds).
set -euo pipefail

INPUTS_DIR="${CYTO_INPUTS_DIR:-/inputs}"
OUTPUTS_DIR="${CYTO_OUTPUTS_DIR:-/outputs}"
# The reference transcriptome rides an admin-allowlisted read-only reference mount
# (GAP-3b / DEC-11), NOT materialize_inputs — a genome is large + shared.
REFERENCE_ROOT="${CYTO_REFERENCE_ROOT:-/refdata}"
mkdir -p "$OUTPUTS_DIR"

progress() {
  local line="$1"
  if [ -n "${CYTO_PROGRESS_FIFO:-}" ] && [ -p "$CYTO_PROGRESS_FIFO" ]; then
    printf '%s\n' "$line" >"$CYTO_PROGRESS_FIFO" 2>/dev/null || true
  fi
  printf 'progress: %s\n' "$line" >&2
}

# --- read params (jq if present; else defaults) ---
PARAMS_JSON="$INPUTS_DIR/params.json"
jqget() { # key default
  if command -v jq >/dev/null 2>&1 && [ -f "$PARAMS_JSON" ]; then
    jq -r --arg d "$2" ".$1 // \$d" "$PARAMS_JSON" 2>/dev/null || printf '%s' "$2"
  else
    printf '%s' "$2"
  fi
}
REFERENCE="$(jqget reference refdata-gex-GRCh38-2024-A)"
CHEMISTRY="$(jqget chemistry auto)"
EXPECTED_CELLS="$(jqget expected_cells 3000)"
INCLUDE_INTRONS="$(jqget include_introns true)"
CREATE_BAM="$(jqget create_bam false)"

# --- resolve inputs BY SLOT (the same contract the python computes read) ---
#
# `/inputs/inputs.json` maps slot → mount, and it is the whole contract: the runner names
# each mount from the ARTIFACT it is staging (`derive_artifact_mount_name`), so a `fastqs`
# lane set lands at `/inputs/fastqs` (a DIRECTORY — `sequence/fastq` declares
# `file_layout: manifest`), and a second lane set bound to the same slot lands at
# `/inputs/fastqs_1` (`unique_mount_name` disambiguates). `--fastqs` takes a
# comma-separated list of directories, so every binding of the slot is joined.
#
# This used to be `--fastqs "$INPUTS_DIR"` — Cell Ranger pointed at `/inputs` itself.
# `--fastqs` does not recurse, so it scanned a directory holding `inputs.json`,
# `params.json` and the `fastqs/` SUBDIRECTORY, and matched no `*_S*_L*_R*_001.fastq.gz`
# at all. It was also unable to say WHICH mount it meant, which is why the view↔compute
# seam (`core/spec/processorViewSpecs.test.ts` arm B) read this compute as resolving no
# slots — the guard fired on a compute that genuinely resolved none.
slot_paths() { # slot-name… → every existing /inputs mount bound to the first named slot
  if ! command -v jq >/dev/null 2>&1 || [ ! -f "$INPUTS_DIR/inputs.json" ]; then
    return 0
  fi
  for name in "$@"; do
    local found
    found="$(jq -r --arg s "$name" \
      '[.inputs[]? | select(.slot == $s) | .sandbox_path | sub("^/inputs/"; "")] | .[]' \
      "$INPUTS_DIR/inputs.json" 2>/dev/null)" || continue
    local out=""
    while IFS= read -r sub; do
      [ -n "$sub" ] || continue
      [ -e "$INPUTS_DIR/$sub" ] || continue
      out="$out$INPUTS_DIR/$sub"$'\n'
    done <<<"$found"
    if [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
  done
  return 0
}

# Every directory holding this run's reads, comma-joined for `--fastqs`. A binding that
# staged as a FILE contributes its PARENT directory (Cell Ranger scans directories).
FASTQ_DIRS=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  d="$p"; [ -d "$d" ] || d="$(dirname "$p")"
  case ",$FASTQ_DIRS," in *",$d,"*) continue ;; esac
  FASTQ_DIRS="${FASTQ_DIRS:+$FASTQ_DIRS,}$d"
done <<<"$(slot_paths "fastqs")"

# No jq / no inputs.json ⇒ fall back to today's whole-`/inputs` behaviour rather than
# refusing a run this script cannot describe. An EMPTY resolution with jq present is a
# real error (the slot was never bound), and saying so beats Cell Ranger's "no input
# FASTQs" ten minutes later.
if [ -z "$FASTQ_DIRS" ]; then
  if command -v jq >/dev/null 2>&1 && [ -f "$INPUTS_DIR/inputs.json" ]; then
    echo "cellranger: no input bound to the 'fastqs' slot (see $INPUTS_DIR/inputs.json)" >&2
    exit 5
  fi
  FASTQ_DIRS="$INPUTS_DIR"
fi

REF_PATH="$REFERENCE_ROOT/$REFERENCE"
RUN_ID="cellranger_run"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cellranger.XXXXXX")"

progress "reading|5|resolving fastqs + reference"
if [ ! -d "$REF_PATH" ]; then
  echo "cellranger: reference transcriptome not found at $REF_PATH (mount a reference via an allowlisted reference mount)" >&2
  exit 3
fi

# --clearenv wipes PATH-adjacent vars; cellranger must be on PATH in the rootfs.
if ! command -v cellranger >/dev/null 2>&1; then
  echo "cellranger: the 'cellranger' binary is not present in the rootfs (add it to the rootfs Dockerfile + bump ROOTFS_SCHEMA_VERSION)" >&2
  exit 4
fi

BAM_FLAG="false"; [ "$CREATE_BAM" = "true" ] && BAM_FLAG="true"
INTRON_FLAG="true"; [ "$INCLUDE_INTRONS" = "false" ] && INTRON_FLAG="false"

progress "aligning|30|cellranger count"
cellranger count \
  --id "$RUN_ID" \
  --transcriptome "$REF_PATH" \
  --fastqs "$FASTQ_DIRS" \
  --expect-cells "$EXPECTED_CELLS" \
  --chemistry "$CHEMISTRY" \
  --include-introns "$INTRON_FLAG" \
  --create-bam "$BAM_FLAG" \
  --output-dir "$WORK/$RUN_ID" 1>&2

OUTS="$WORK/$RUN_ID/outs"
progress "writing-outputs|85|staging typed outputs"

# The filtered feature-barcode matrix (.h5) → typed expression artifact.
ENTRIES='['
if [ -f "$OUTS/filtered_feature_bc_matrix.h5" ]; then
  cp "$OUTS/filtered_feature_bc_matrix.h5" "$OUTPUTS_DIR/expression.h5"
  ENTRIES="$ENTRIES{\"id\":\"expression\",\"datatype\":\"single-cell/expression\",\"path\":\"expression.h5\",\"layout\":\"chunked-sparse\",\"role\":\"artifact\"}"
fi
# The web summary → typed report/html artifact.
if [ -f "$OUTS/web_summary.html" ]; then
  cp "$OUTS/web_summary.html" "$OUTPUTS_DIR/web_summary.html"
  [ "$ENTRIES" != '[' ] && ENTRIES="$ENTRIES,"
  ENTRIES="$ENTRIES{\"id\":\"report\",\"datatype\":\"report/html\",\"path\":\"web_summary.html\",\"layout\":\"opaque\",\"role\":\"artifact\"}"
fi
ENTRIES="$ENTRIES]"

cat >"$OUTPUTS_DIR/manifest.json" <<EOF
{"outputs": $ENTRIES}
EOF

progress "done|100|cellranger count complete"
echo "cellranger: count complete → $OUTPUTS_DIR" >&2
