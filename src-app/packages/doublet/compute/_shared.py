#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate `doublet.detect` stands on.

Mirrors the SAME SUBSTRATE as `embedding/compute/_shared.py` - the six-variable thread pin,
the `/inputs`/`/outputs` wire contract, slot resolution, the CSC-matrix reader, a pre-read
ceiling gate, `progress`/`fail`, the manifest writer and the column-reading helpers - but not
function-for-function: this module adds `column_missing_level`, `is_missing_label`,
`import_threshold_backend`, `_peak_bytes` and `_stricter_only`, omits embedding's Harmony
helpers and `stamp_txr_attributes`, and its `ceiling_refuse_if_over` has a different
signature and a materially different memory model. The
entry declares `helpers: [compute/_shared.py]` so the runner stages this sibling into
`/code` alongside it, where `import _shared` resolves off `sys.path[0]` (the entry's own
directory). The suite reaches it the same way — the entry runs as a script, so its folder is
`sys.path[0]`.

THE SIX thread variables are pinned at the very TOP of this module, BEFORE the first
`import numpy`, so every consumer that imports `_shared` first (the entry does) has the
numeric stack single-threaded before numpy/scipy/scanpy/sklearn ever load. The server pins
three (`OMP_/OPENBLAS_/MKL_`, `sandbox/sandbox.rs`); the other three (`NUMEXPR_/VECLIB_/
NUMBA_`) are the processor's to pin. `setdefault` means a genuine server-set value is never
overridden. Single-threading is also what makes the reference-parity tolerance (1e-9) a
statement about our wiring rather than about BLAS reassociation.
"""
import os

# ── pin all SIX before numpy loads ────────────────────────────────────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")


def resolved_thread_env():
    """The SIX thread vars as this process actually sees them AFTER the pin — read out of
    the RUNNING compute and recorded into the report, so a test proves the child env rather
    than the source text."""
    return {v: os.environ.get(v) for v in THREAD_ENV_VARS}


import json
import sys
from pathlib import Path

import numpy as np

# The shared output-format library (`_lib`, staged into `/code`). `txr_columns` imports
# pandas lazily, so importing it here keeps this module's floor at numpy + stdlib.
import txr_columns


# ── datatypes emitted (id, layout) — the SHAPE ingest validates ───────────────────
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")


_PREFIX = ["doublet"]


def set_prefix(prefix):
    """Set the diagnostic prefix so a caller and the test harness can tell OUR named
    refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors qc-10x.py / embedding/_shared.py) ──────────────────
def io_dirs():
    inp = Path(os.environ.get("TXR_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("TXR_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


def load_inputs_index(inputs_dir):
    """`slot -> [host path, ...]` in DECLARATION ORDER, resolved by SLOT out of
    `inputs.json` — never by filename suffix (the runner names mounts `in0`/`in1`)."""
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        slot = e.get("slot")
        if not slot:
            continue
        sp_path = e.get("sandbox_path", "") or ""
        sub = sp_path[len("/inputs/"):] if sp_path.startswith("/inputs/") else Path(sp_path).name
        if not sub:
            continue
        slots.setdefault(str(slot), []).append(inputs_dir / sub)
    return slots


def slot_paths(slots, *names):
    for name in names:
        found = [Path(p) for p in slots.get(name, []) if Path(p).exists()]
        if found:
            return found
    return []


def slot_path(slots, *names):
    found = slot_paths(slots, *names)
    return found[0] if found else None


# ── progress + manifest ────────────────────────────────────────────────────────────
_PROGRESS_FD = [-1]


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")
        parts.append(str(message))
    line = "|".join(parts)
    fifo = os.environ.get("TXR_PROGRESS_FIFO")
    if fifo:
        if _PROGRESS_FD[0] < 0:
            try:
                _PROGRESS_FD[0] = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError:
                _PROGRESS_FD[0] = -1
        if _PROGRESS_FD[0] >= 0:
            try:
                os.write(_PROGRESS_FD[0], (line + "\n").encode())
            except OSError:
                try:
                    os.close(_PROGRESS_FD[0])
                except OSError:
                    pass
                _PROGRESS_FD[0] = -1
    print("progress:", line, file=sys.stderr, flush=True)


def write_manifest(outputs_dir, entries):
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


# ── reading a staged artifact ──────────────────────────────────────────────────────
def artifact_structure(path):
    meta = Path(path) / "zarr.json"
    if not meta.is_file():
        return None
    try:
        doc = json.loads(meta.read_text())
    except (OSError, ValueError):
        return None
    txr = (doc.get("attributes") or {}).get("txr")
    return txr if isinstance(txr, dict) else None


def read_matrix_structure(path, slot):
    """The DECLARED structure of a `single-cell/expression` CSC store — WITHOUT reading a
    byte of the matrix. This is what the ceiling gate reads (`nnz`/`shape`) before any read.
    Refuses a non-CSC / shapeless input BY NAME."""
    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration "
            "in a group `zarr.json` — a `single-cell/expression` artifact is a multifile "
            "CSC Zarr store"
        )
    if structure.get("kind") != "sparse_csc":
        fail(
            f"input on slot {slot!r} at {path.name!r} declares kind "
            f"{structure.get('kind')!r}; doublet.detect reads a `sparse_csc` count matrix"
        )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    # The ELEMENTS are validated too, not just the length. The ceiling gate sizes the run
    # from `shape[0]`, and an unvalidated element is three different failures: `None` or a
    # string raises an UNNAMED TypeError/ValueError out of a gate whose whole contract is to
    # fail closed by name; a negative makes the peak estimate negative, so the memory gate
    # passes trivially; and a float is silently truncated, which is the same substitution the
    # parameter coercers refuse. `nnz` already had this treatment; `shape` did not.
    dims = []
    for i, value in enumerate(shape):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            fail(
                f"input on slot {slot!r} declares shape[{i}] = {value!r}, which is not a "
                "count — the pre-read ceiling is sized from it, so the run fails closed by "
                "name rather than sizing itself from a value it cannot read"
            )
        if isinstance(value, float) and value != int(value):
            fail(f"input on slot {slot!r} declares a fractional shape[{i}] = {value!r}")
        if int(value) < 0:
            fail(f"input on slot {slot!r} declares a negative shape[{i}] = {value!r}")
        dims.append(int(value))
    structure = dict(structure, shape=dims)
    return structure


def read_matrix_csc(path, structure):
    """Read the CSC trio and build a scipy `csc_matrix` of shape (n_cells, n_genes).

    A `single-cell/expression` store is CSC over the GENES axis (`axes: [cells, genes]`), so
    `indptr` cuts by gene/column and `indices` holds cell/row ids — exactly what a scipy CSC
    wants (`(data, indices, indptr)`, `shape=(n_cells, n_genes)`)."""
    import txr_csc
    import scipy.sparse as sp

    indptr, indices, data = txr_csc.read_csc(Path(path))
    n_cells, n_genes = int(structure["shape"][0]), int(structure["shape"][1])

    # The ceiling gate sized this run from the DECLARED `nnz`. That declaration is now
    # checked against what actually arrived: a store declaring `nnz: 1` while holding 500M
    # stored values would sail through the pre-read gate and then be read in full, which
    # defeats the gate as completely as a missing `nnz` would. `sp.csc_matrix` runs
    # `check_format(full_check=False)` and does not bound-check indices either, so an
    # out-of-range row id would surface later as a confusing slicing error rather than here.
    actual_nnz = int(np.asarray(data).size)
    declared_nnz = int(structure.get("nnz", -1))
    if declared_nnz >= 0 and actual_nnz != declared_nnz:
        fail(
            f"the input matrix declares nnz={declared_nnz:,} but holds {actual_nnz:,} stored "
            "values. The pre-read memory/time ceiling was sized from the DECLARATION, so a "
            "disagreement means the run was admitted on a false statement of its own size. "
            "Refused rather than continuing on a matrix whose budget was never checked."
        )
    idx = np.asarray(indices)
    if idx.size and (int(idx.min()) < 0 or int(idx.max()) >= n_cells):
        fail(
            f"the input matrix declares {n_cells:,} cells but carries a row index outside "
            f"[0, {n_cells - 1}] (min={int(idx.min())}, max={int(idx.max())}). Refused rather "
            "than reading values into the wrong cells."
        )
    return sp.csc_matrix(
        (np.asarray(data), idx, np.asarray(indptr)),
        shape=(n_cells, n_genes),
    )


def read_column_native(path, slot):
    """A `metadata-column` artifact -> its VALUES in their NATIVE meaning (categorical
    labels, strings, or a numpy numeric array). Used by the inline filter so a numeric obs
    column keeps its dtype and the `criteria_keep_mask` range branch takes the numeric fast
    path, exactly as `cell-filter` reads `adata.obs`."""
    import txr_zarr_read

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration — "
            "it is not a txr_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path")
    return txr_zarr_read.read_column(path, member or "values")


def read_column_values(path, slot):
    """A `metadata-column` artifact -> its VALUES as a list of `str` (batch / cell keys)."""
    values = read_column_native(path, slot)
    if hasattr(values, "tolist"):
        values = values.tolist()
    return [("" if v is None else str(v)) for v in values]


def column_missing_level(path):
    """The label a CATEGORICAL column artifact invented for its MISSING values, or `None`.

    This exists because "missing" has two spellings on the wire and only one of them is
    blank. `txr_columns.write_metadata_column`'s STRING branch writes a missing value as
    `""`; its CATEGORICAL branch instead invents a real declared level — `_missing_level`,
    `"NA"` unless that collides — and stamps its name so a reader can tell it apart from a
    genuine category that happens to be spelled "NA".

    A caller that only checks for blanks therefore misses every missing value in a
    categorical column, which is the ONLY shape a categorical picker can bind. Read the
    stamp, do not guess the label.
    """
    structure = artifact_structure(path)
    if not isinstance(structure, dict):
        return None
    # The stamp lives on the COLUMN ENTRY in the group's declared structure — `txr_zarr`
    # writes it there and NOT onto the member array's own `attributes.txr`, so a lookup on
    # the array node is dead code. Select the entry the SAME way `read_column_native` selects
    # the member whose values we read (`structure["key"]`, else the sole column, else
    # `"values"`); scanning for "the first column that has one" would, on a multi-member
    # table, name a missing level belonging to a different column than the values came from.
    columns = [c for c in (structure.get("columns") or []) if isinstance(c, dict)]
    member = structure.get("key")
    if not member:
        member = columns[0].get("path") if len(columns) == 1 else "values"
    for column in columns:
        if column.get("path") == member and column.get("missing_level"):
            return str(column["missing_level"])
    return None


#: The EXACT string forms a missing value arrives as, matched CASE-SENSITIVELY.
#:
#: `txr_columns._as_strings` maps `None` and float-`NaN` to `""`, so a blank covers those.
#: What it does NOT map is `pd.NA` (object dtype), which becomes the literal `"<NA>"`, and
#: `pd.NaT` (datetime), which becomes `"NaT"` — and both of those columns are stamped
#: `kind: categorical`, so the sample picker offers them and they carry no `missing_level`
#: for the stamp reader to find. `"nan"` is the read-back form of a float column's nulls;
#: that column is stamped `continuous` and the picker does NOT offer it, but a raw
#: jobs-API launch can still bind one, so it is covered.
#:
#: CASE-SENSITIVE, AND THAT IS THE WHOLE POINT. An earlier version matched case-insensitively
#: over `{"<na>", "nan", "nat", "none", "null"}` and refused real datasets:
#:
#:   * **`NAT`** is Normal Adjacent Tissue, a standard sample label in tumour scRNA-seq. A
#:     merged `Tumor` / `NAT` matrix is *precisely* the multi-sample case this analysis
#:     exists for, and it was rejected outright.
#:   * **`None`** is an ordinary no-treatment arm; **`NULL`** is a real surname and a real
#:     cohort label. Neither is even reachable as a missing value — `_as_strings` maps a
#:     Python `None` to `""` — so they were pure false positives.
#:
#: The only lever such a refusal offers is "rename your sample", i.e. corrupt your own
#: nomenclature to run the analysis — and for a shared cohort that is not an edit the user
#: owns. `NaT` (pandas' own capitalisation) is kept and `NAT` is not; they are different
#: strings and this set now says so.
MISSING_VALUE_SENTINELS = ("<NA>", "NaT", "nan")


def is_missing_label(value, missing_level=None):
    """True when `value` is a MISSING sample key rather than a sample name.

    Case-SENSITIVE against `MISSING_VALUE_SENTINELS`; see the note there for why.
    """
    text = str(value).strip()
    if not text:
        return True
    if missing_level is not None and text == str(missing_level):
        return True
    return text in MISSING_VALUE_SENTINELS


# ── the inline pre-filter's obs columns ────────────────────────────────────────────
#: The slot-name PREFIX that binds ONE cells-axis obs column the filter criteria may
#: reference — the exact convention `cell-filter` and `embedding.reduce` use. A
#: `metadata-column` store keeps its values under the constant member `values` and cannot
#: carry its own name, so the name arrives with the BINDING (`column:<name>`), never a
#: second params channel that could fall out of step with the mounts.
COLUMN_SLOT_PREFIX = "column:"


def collect_filter_columns(slots, n_cells):
    """The `{column_name: values}` obs dict for the inline pre-filter, read from every
    `column:<name>` slot. Mirrors `cell-filter.py::main`'s obs-collection: a mount-collision
    refusal (two distinct slots sanitized to one mount would silently read the same column)
    and a per-column length check against the declared cell count. The values are NATIVE
    (dtype preserved) so the vendored `criteria_keep_mask` sees exactly what `cell-filter`
    sees off `adata.obs`."""
    obs = {}
    seen_mounts = {}
    for slot in sorted(slots):
        if not slot.startswith(COLUMN_SLOT_PREFIX):
            continue
        name = slot[len(COLUMN_SLOT_PREFIX):]
        if not name:
            continue
        path = slot_path(slots, slot)
        if path is None:
            continue
        mount = str(Path(path).resolve())
        if mount in seen_mounts:
            fail(
                f"filter columns bound at slots {seen_mounts[mount]!r} and {slot!r} collide "
                f"on one mount ({Path(path).name!r}) — the later stage overwrote the "
                "earlier, so both columns would read the same values"
            )
        seen_mounts[mount] = slot
        values = read_column_native(path, slot)
        if len(values) != n_cells:
            fail(
                f"the filter column bound at slot {slot!r} holds {len(values)} values but "
                f"the matrix declares {n_cells} cells — they are not the same cells axis"
            )
        obs[name] = values
    return obs


# ── the Batch-class envelope + the pre-read ceiling gate ──────────────────────────
#
# The BATCH class DEFAULTS to 8 GiB (`batch_mem_bytes`, `sandbox/settings.rs`). Three
# qualifications the first version of this comment got wrong, and they matter:
#
#   * these are DB-backed DEFAULTS, not pins — settings.rs calls them "the cache fallback if
#     the DB read fails", and an admin PUT changes them. `_MEM_BUDGET_HARD` below therefore
#     encodes the DEFAULT, not the deployment's actual limit, which the sandbox cannot read;
#     on a deployment configured BELOW 8 GiB this gate is looser than the cgroup. Reported.
#   * `cpu_secs_max` (600) is a BOX-WIDE ceiling, not a per-class field — it is absent from
#     `ResourceProfile` and untouched by `class_defaults`.
#   * `batch_cpu_cores` is 4, but `resolve_caps` clamps against the deployment's `cpu_max`,
#     whose default is "200000 100000" = 2 cores — so on a default deployment `batch`
#     resolves to 8 GiB / 2 cores. Memory doubles over `normal`; cores do not move.
#
# This package declares `schedule: {class: batch}` on a measurement — see the manifest's
# 0.5.0 entry. The constants here are the compute-side BELT to the form's braces: the compute is reachable by an
# agent/MCP call that never rendered the form, so it re-checks from the DECLARED structure
# before any read.
#
# THE ENV SEAMS CAN ONLY EVER LOWER A BUDGET, AND THAT IS ENFORCED, NOT DOCUMENTED. They
# exist so a refusal can be exercised without a 4 GiB fixture; a comment promising
# "lower-only" while `int(os.environ[...])` accepted any value was a promise the code did
# not keep — `DOUBLET_MEMORY_BUDGET_BYTES=99999999999` lifted the memory ceiling above the
# sandbox's real limit, and `DOUBLET_CPU_SECS_PER_MNNZ=0` disabled the time gate outright by
# driving every estimate to zero. Both are now clamped against the hard defaults below, and
# a malformed value is the default rather than an uncaught `ValueError` at import time
# (which would fire before `set_prefix`, so even the failure would be unnamed).
_MEM_BUDGET_HARD = 8 * 1024**3
_CPU_SECS_BUDGET_HARD = 600.0
#: CPU-seconds an nnz-proportional Scrublet run is estimated to cost: normalize + HVG + a
#: PCA over the observed AND the simulated set, then an exact kNN over their union. A
#: coarse, honest upper-ish bound, calibrated so the measured ~4 CPU-s of a 2,700 x 32,738
#: pbmc3k run (nnz ~2.29M) sits far inside 600 CPU-s and only a genuinely oversized matrix
#: trips it. It counts stored values, i.e. PARALLELISM against the CPU budget, not wall clock.
_CPU_SECS_PER_MNNZ_HARD = 3.0


class HistogramRefused(ValueError):
    """A distribution `_histogram` cannot render. Carried out so the caller turns it into the
    package's own named refusal rather than letting a bare traceback reach the user — this
    module's whole contract is "a named refusal, never a library traceback"."""


def _stricter_only(name, hard, cast, *, direction):
    """An env seam that may only make the gate STRICTER, never looser.

    `direction` says which way strict lies for this quantity, and it is passed EXPLICITLY
    rather than inferred from the variable's name — a seam whose safety depends on a string
    comparison against its own key is one rename away from silently inverting.

      * `"shrink"` — a BUDGET (bytes, CPU-seconds). Strict is smaller, so `min`.
      * `"grow"`   — a COST-PER-UNIT estimate. Strict is larger (a bigger estimate trips the
                     budget sooner), so `max`.

    Absent, blank, malformed, non-finite or non-positive ⇒ the hard default. A malformed
    value must not raise here: this runs at import, BEFORE `set_prefix`, so an exception
    would surface as an unnamed traceback.
    """
    assert direction in ("shrink", "grow")
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return hard
    # The guard covers the WHOLE coercion, including the finiteness test: `int(float(
    # "1e999"))` raises OverflowError (not a ValueError), and `np.isfinite` on a Python int
    # above uint64 raises TypeError. Both fire at IMPORT, before `set_prefix`, so an escape
    # here is an unnamed traceback — which is precisely what this seam must never produce.
    try:
        value = cast(raw)
        if not np.isfinite(value) or value <= 0:
            return hard
    except (TypeError, ValueError, OverflowError):
        return hard
    return min(value, hard) if direction == "shrink" else max(value, hard)


_MEM_BUDGET_BYTES = _stricter_only(
    "DOUBLET_MEMORY_BUDGET_BYTES", _MEM_BUDGET_HARD, lambda v: int(float(v)), direction="shrink")
_CPU_SECS_BUDGET = _stricter_only(
    "DOUBLET_CPU_SECS_BUDGET", _CPU_SECS_BUDGET_HARD, float, direction="shrink")
_CPU_SECS_PER_MILLION_NNZ = _stricter_only(
    "DOUBLET_CPU_SECS_PER_MNNZ", _CPU_SECS_PER_MNNZ_HARD, float, direction="grow")

#: Bytes resident per stored value FOR ONE COPY: `uint32` index (4) + `float32` datum (4).
_BYTES_PER_NNZ = 8

# ── the peak-memory model ──────────────────────────────────────────────────────────
#
# MEASURED. `ru_maxrss` of the compute subprocess, single-threaded, on the raw pbmc3k
# fixture. This table is RAW DATA and is the only thing in this block that does not drift:
#
#     cells      nnz     nnz/cell   sim_ratio   peak RSS
#       700    591,747      845        2.0        378 MiB
#     1,400  1,184,471      846        2.0        529 MiB
#     2,700  2,286,884      847        2.0        877 MiB
#     2,700  2,286,884      847        6.0      1,818 MiB
#     2,700    810,640      300        2.0        460 MiB     <- gene-subset, cells held fixed
#     2,700    288,281      107        2.0        333 MiB     <- gene-subset, cells held fixed
#     2,700  2,286,884      847        1.0        639 MiB     <- LOW-RATIO sweep
#     2,700  2,286,884      847        0.5        568 MiB     <- LOW-RATIO sweep
#     2,700  2,286,884      847        0.1        567 MiB     <- LOW-RATIO sweep
#
# The last two matter: holding CELLS fixed and varying GENES is what separates the
# per-stored-value cost from everything that scales with cells. Without them `nnz` and
# `n_cells` are collinear and the coefficients are not identifiable — which is how three
# earlier versions of this model went wrong.
#
# THE PEAK DOES NOT FALL BELOW ITS r=1 LEVEL, and that is why `_peak_bytes` clamps the ratio
# it sizes with. The low-ratio sweep is flat — 567 MiB at r=0.1 and 568 at r=0.5, against 639
# at r=1 — so the cost is dominated there by terms that do not depend on the simulated set at
# all. A model linear in `r` extrapolates BELOW that floor and under-estimates: measured, the
# unclamped form was -16% at 2,700 cells / r=0.1 and -23% at 8,100 cells / r=0.1. That is the
# one direction a pre-read gate must never fail in, and it was reachable from a supported
# parameter value (`SIM_RATIO_MIN = 0.1`) — worse, the refusal message names "a smaller
# `sim_doublet_ratio`" as a lever, which steered users straight into it. Every calibration
# point had been at r in {2, 6}, so nothing pinned the intercept.
#
# THE CONSTANTS ARE CHOSEN TO BOUND THESE POINTS FROM ABOVE, not derived. Earlier versions of
# this comment narrated a derivation ("solving gives 59.7 and 40,497", "the residual per-cell
# term falls out") whose arithmetic did not reproduce from the table — a confident derivation
# story is exactly the thing this package has been repeatedly wrong about, so there is no
# longer one here. The regression fit informed the choice; the shipped requirement is the
# testable one, and `test_doublet_conformance.py` asserts it against every row above:
#
#     `_peak_bytes` NEVER returns less than the measured peak, on any measured point.
#
# CAPACITY figures are deliberately NOT written here. They are a FUNCTION of these constants,
# they have gone stale across a model change three times, and each time they were load-bearing
# for a resource-class decision. They are computed from the shipped constants and asserted by
# `test_the_capacity_figures_follow_from_the_shipped_constants`, which is also where the
# refuse/admit facts live. Read them there; do not restate them.
#
# SIZED PER POPULATION. Each `sc.pp.scrublet` call sees ONE population, so the terms scaling
# with the scored set take the LARGEST LEVEL, not the merged total. Unbatched, the largest
# population IS the whole matrix and nothing changes.
_PEAK_BASE_BYTES = 256 * 1024**2          # interpreter + numpy/scipy/scanpy
#: Per stored value of the WHOLE matrix, live for the run's duration regardless of the split
#: (the CSC read buffer and its `tocsr()` copy). Arithmetic, not fitted: 2 copies x 8 B.
_PEAK_BYTES_PER_NNZ_GLOBAL = 2 * 8
#: Per stored value in the SCORED POPULATION, independent of the simulated set.
_PEAK_BYTES_PER_NNZ_POP = 64
#: Per stored value in the scored population, PER UNIT of `sim_doublet_ratio`.
_PEAK_BYTES_PER_NNZ_PER_SIM = 112
#: Per cell in the scored population, per (1 + sim_doublet_ratio) — the dense Z-scored
#: highly-variable matrix that `pipeline.pca` materializes with `.toarray()`, in FLOAT64.
#:
#: MEASURED DIRECTLY, by instrumenting that call rather than inferring it from a residual:
#: 10,392 / 11,200 / 13,904 B per cell x (1+r) on the three full-gene calibration points
#: (n_hvg = 1,299 / 1,400 / 1,738). An earlier value of 7,500 sat BELOW that floor and was
#: only masked by an oversized nnz term at pbmc3k depth. 14,000 bounds all three.
#:
#: THE HONEST RESIDUAL RISK: scanpy calls `highly_variable_genes` with NO `n_top_genes`
#: (`_scrublet/__init__.py`), so `n_hvg` is data-dependent and unbounded — a gene-rich,
#: HVG-rich library can push this term far higher (a 20k-gene synthetic fixture reached
#: ~50,000 B/cell x (1+r)). It cannot be bounded before the read, which is what this gate is,
#: so it is stated rather than papered over: on such an input the estimate is low and the
#: cgroup, not this gate, is what stops the run.
_PEAK_BYTES_PER_CELL_PER_SIM = 14_000

def _peak_bytes(nnz_total, nnz_pop, n_cells_pop, sim_doublet_ratio):
    """The estimated PEAK resident bytes, from the model documented above.

    `nnz_total` is the whole matrix; `nnz_pop` / `n_cells_pop` are the LARGEST population
    that will be scored (equal to the whole matrix when the run is unbatched).
    """
    # CLAMPED AT 1.0. The measured peak is flat below r~=0.5 and never drops under its r=1
    # level, so sizing linearly in `r` below that under-estimates — see the low-ratio sweep
    # above. Sizing a small-`r` run as though it were r=1 over-estimates, which is the safe
    # direction and the only one available without a second model for that regime.
    r = max(1.0, float(sim_doublet_ratio))
    return int(
        _PEAK_BASE_BYTES
        + nnz_total * _PEAK_BYTES_PER_NNZ_GLOBAL
        + nnz_pop * (_PEAK_BYTES_PER_NNZ_POP + r * _PEAK_BYTES_PER_NNZ_PER_SIM)
        + n_cells_pop * (1.0 + r) * _PEAK_BYTES_PER_CELL_PER_SIM
    )


def ceiling_refuse_if_over(structure, *, sim_doublet_ratio=2.0,
                           largest_population_cells=None):
    """Refuse BEFORE any matrix read when the run exceeds the Batch-class envelope, with
    the arithmetic and WHICH ceiling (memory vs time) named.

    Sizes from the DECLARED `nnz` — no read. Never subsamples, never attempts-and-times-out.
    Fails CLOSED when `nnz` is absent: a missing declared `nnz` read as 0 would make
    `resident = 0`, pass both gates trivially, and read a matrix of unknown size anyway,
    silently defeating the gate.
    """
    declared_nnz = structure.get("nnz")
    if declared_nnz is None:
        fail(
            "refusing before reading the matrix: the input's declared structure carries no "
            "`nnz`, so the pre-read memory/time ceiling cannot be sized. The run fails "
            "closed by name rather than reading a matrix of unknown size (a missing nnz "
            "must not silently disable the ceiling)."
        )
    try:
        nnz = int(declared_nnz)
    except (TypeError, ValueError):
        fail(
            f"refusing before reading the matrix: the input declares `nnz: {declared_nnz!r}`, "
            "which is not a count, so the pre-read ceiling cannot be sized. Fails closed by "
            "name rather than reading a matrix of unknown size."
        )
    if nnz < 0:
        fail(f"refusing before reading the matrix: the input declares a negative `nnz` ({nnz})")

    resident = nnz * _BYTES_PER_NNZ
    n_cells = int(structure["shape"][0])
    # The largest population that will actually be scored. Unbatched (or unknown) it is the
    # whole matrix, so the estimate is unchanged; batched it is the biggest level, and the
    # per-population nnz is pro-rated by its share of the cells.
    # FAIL CLOSED, like `nnz` and `shape` above. Silently clamping a bad value is how a gate
    # stops being one: `largest_population_cells=-5` used to clamp to 1, collapsing the
    # estimate to the base constant so the memory check passed trivially — the exact failure
    # this module refuses for `shape[0]` 300 lines up. Today's only caller cannot produce it,
    # but this is the module's public gate.
    if largest_population_cells is not None:
        if isinstance(largest_population_cells, bool) or not isinstance(
                largest_population_cells, int):
            fail(f"largest_population_cells={largest_population_cells!r} is not a count")
        if largest_population_cells < 1 or largest_population_cells > n_cells:
            fail(
                f"largest_population_cells={largest_population_cells} is outside [1, "
                f"{n_cells}] — the pre-read ceiling would be sized from a population that "
                "cannot exist, so the run fails closed by name"
            )
    pop_cells = int(largest_population_cells) if largest_population_cells else n_cells
    # Pro-rated by the population's SHARE OF THE CELLS, which assumes levels are of similar
    # depth. A small but deeply-sequenced level (a different chemistry, a deeper lane) is the
    # case this under-counts; it is the under-estimating direction, and it is recorded here
    # rather than left for a reader to discover from the arithmetic.
    nnz_pop = int(nnz * (pop_cells / n_cells)) if n_cells else nnz
    peak = _peak_bytes(nnz, nnz_pop, pop_cells, sim_doublet_ratio)
    # CPU scales with the TOTAL work: every population is scored, so the sum over populations
    # is the whole matrix regardless of how it is split.
    cpu_secs = (nnz / 1_000_000.0) * _CPU_SECS_PER_MILLION_NNZ * (1.0 + float(sim_doublet_ratio))

    if peak > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the matrix: this run needs about "
            f"{peak / 1024**3:.2f} GiB resident at PEAK, over the MEMORY ceiling of "
            f"{_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Batch resource class. The "
            f"estimate is {_PEAK_BASE_BYTES // 1024**2} MiB of interpreter and libraries, "
            f"plus {nnz:,} whole-matrix stored values x {_PEAK_BYTES_PER_NNZ_GLOBAL} bytes, "
            f"plus {nnz_pop:,} stored values in the largest scored population x "
            f"({_PEAK_BYTES_PER_NNZ_POP} + {_PEAK_BYTES_PER_NNZ_PER_SIM}*{sim_doublet_ratio}) "
            f"bytes each, plus {pop_cells:,} cells in that population x "
            f"(1 + {sim_doublet_ratio}) x {_PEAK_BYTES_PER_CELL_PER_SIM:,} bytes for the "
            "dense Z-scored highly-variable matrix Scrublet builds over the observed AND "
            "simulated cells. "
            "It is fitted to measured peak RSS of real runs, not counted from the source. "
            "The levers are fewer cells (or an inline pre-filter), a smaller "
            "`sim_doublet_ratio`, or raising the deployment's sandbox memory limit; the run "
            "is refused rather than left to be OOM-killed mid-fit."
        )
    if cpu_secs > _CPU_SECS_BUDGET:
        fail(
            "refusing before reading the matrix: this run is estimated at about "
            f"{cpu_secs:.0f} CPU-seconds (nnz={nnz:,}), over the TIME ceiling of "
            f"{_CPU_SECS_BUDGET:.0f} CPU-seconds for the Batch resource class. "
            "CPU-seconds count parallelism, not wall clock. The lever that moves this "
            "ceiling is the dataset size, or raising the deployment's sandbox cpu-seconds "
            "limit; the run is refused rather than left to die to SIGXCPU."
        )
    return {"nnz": nnz, "estimated_resident_bytes": resident,
            "estimated_peak_bytes": peak,
            "peak_model": {
                "base_bytes": _PEAK_BASE_BYTES,
                "bytes_per_nnz_global": _PEAK_BYTES_PER_NNZ_GLOBAL,
                "bytes_per_nnz_pop": _PEAK_BYTES_PER_NNZ_POP,
                "bytes_per_nnz_per_sim": _PEAK_BYTES_PER_NNZ_PER_SIM,
                "bytes_per_cell_per_sim": _PEAK_BYTES_PER_CELL_PER_SIM,
                "n_cells": n_cells,
                "nnz_pop": nnz_pop,
                "largest_population_cells": pop_cells,
                # A machine-readable claim, so it says what was actually measured.
                "fitted_to": ("measured peak RSS, raw pbmc3k: 700/1,400/2,700 cells at "
                              "sim_ratio 2, 2,700 cells at sim_ratio 6, and 2,700 cells at "
                              "12,000 and 4,000 genes (300 and 107 nnz/cell)"),
            },
            "sim_doublet_ratio": float(sim_doublet_ratio),
            "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}


# ── the automatic-threshold dependency (skimage) ───────────────────────────────────
def import_threshold_backend():
    """`skimage.filters.threshold_minimum`, or `None` when skimage is unavailable.

    Never raises — the caller turns `None` into the package's NAMED refusal, so an absent
    rootfs library can never surface as a raw `ImportError` mid-pipeline. Scrublet's
    AUTOMATIC threshold is the minimum between the two modes of the simulated-score
    histogram, and scanpy computes it with `skimage.filters.threshold_minimum`; an explicit
    `threshold` param needs no backend at all.

    `DOUBLET_FORCE_SKIMAGE_ABSENT=1` forces the absent branch so the named-refusal path is
    exercised DETERMINISTICALLY even where skimage IS installed. Like the ceiling seams it
    can only ever DISABLE a capability, never grant one.
    """
    if os.environ.get("DOUBLET_FORCE_SKIMAGE_ABSENT") == "1":
        return None
    try:
        from skimage.filters import threshold_minimum
        return threshold_minimum
    except Exception:
        return None
