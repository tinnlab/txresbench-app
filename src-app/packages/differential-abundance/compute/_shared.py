#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate BOTH DA analyses stand on (mirrors clustering/_shared.py and
differential-expression/_shared.py).

`da.clusters` and `da.neighbourhoods` share their whole plumbing — the six-thread + numba
determinism pin, the `/inputs`/`/outputs` wire contract, slot resolution BY SLOT, the
`metadata-column` reader, the embedding reader with the INV-11 2-D-layout refusal, the
Normal-class ceiling gate, `progress`/`fail`, the manifest writer, the per-comparison `da/result`
population-table writer and the run `da-report` shape — so it lives ONCE here. Each analysis
declares `helpers: [compute/_shared.py, …]` so the runner stages this sibling into `/code` beside
the entry, where `import _shared` resolves off `sys.path[0]`.

The determinism environment is pinned at the very TOP of this module, BEFORE the first
`import numpy`, so every consumer that imports `_shared` first has the numeric stack
single-threaded and machine-identity-fixed before numpy/scipy/scanpy/numba ever load. This is
load-bearing for DA in a way it is not for DE: `make_nhoods` draws index cells with a seeded RNG
and dedups the refined set, so `n_nhoods` ITSELF is seed-dependent (INV-DA / #92).
"""
import os

# ── pin the determinism environment before numpy/numba load ────────────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")
os.environ.setdefault("NUMBA_CPU_NAME", "generic")


def resolved_determinism_env():
    """The determinism env as this process ACTUALLY sees it AFTER the pin — read out of the
    running compute (recorded into the report) so a test proves the child env, never source
    text. The six thread vars plus `NUMBA_CPU_NAME`."""
    out = {v: os.environ.get(v) for v in THREAD_ENV_VARS}
    out["NUMBA_CPU_NAME"] = os.environ.get("NUMBA_CPU_NAME")
    return out


import json
import sys
from pathlib import Path

import numpy as np

import txr_columns
import txr_deps


# ── datatypes emitted (id, artifact-row layout) — the SHAPE ingest validates ───────
# A DA result is a POPULATION-axis annotation TABLE (`columnar-table`) — the population-axis
# analogue of a `metadata-column`. ONE comparison = ONE `da/result`; there is NO `comparison`
# axis, exactly as `de/result` was reshaped (DEC-13 over there).
DT_DA_RESULT = ("da/result", "columnar-table")
DT_METADATA_COLUMN = ("metadata-column", "columnar-table")
DT_REPORT_QC = ("report/qc", "opaque")


# ── the Normal-class envelope ──────────────────────────────────────────────────────
# The DA ceiling is the deployment's ALREADY-configurable sandbox ceiling. The Normal class is
# 4 GiB / 2 cores / 600 CPU-s, matching every sibling. These are the compute-side BELT to the
# form's braces: an agent/MCP call that never rendered the form reaches the compute, so it
# re-checks from the DECLARED embedding structure BEFORE any read. The env seams below only ever
# LOWER a budget — they exist so a refusal can be exercised without a 4 GiB fixture.
_MEM_BUDGET_BYTES = int(os.environ.get("DA_MEMORY_BUDGET_BYTES", str(4 * 1024**3)))
_CPU_SECS_BUDGET = float(os.environ.get("DA_CPU_SECS_BUDGET", "600"))

#: Bytes resident per embedding cell PER DIMENSION. THREE concurrent dense float32 copies, not
#: one: the caller's `X`, plus the two `X.copy()` calls `_nhoods.build_knn` makes when it wraps the
#: embedding in an AnnData (`X=` and `obsm["X_da"]=`). Budgeting a single copy is how a run passes
#: the pre-read gate and is then OOM-killed mid-build, which is the one outcome this gate exists to
#: prevent.
_BYTES_PER_DIM = 4 * 3
#: Bytes the kNN structures cost PER NEIGHBOUR PER CELL. scanpy materialises TWO sparse
#: `(cells × cells)` matrices with ~k nnz per row — `connectivities` and `distances` — each an
#: index (int32/int64) plus a float32/float64 datum. `_nhoods.binarise` then makes a THIRD
#: full-size CSR copy of the connectivity graph with float64 data (int32 index + float64 datum =
#: 12 bytes per stored neighbour), which the prop-scaled membership term below does NOT cover:
#: the binarised graph is the WHOLE graph, and only the column subset taken from it is scaled by
#: `prop`. 8 + 8 + 12 = 28.
#:
#: This is a better bound than the one it replaced and it is still a BOUND, not an inventory:
#: scanpy also materialises dense `(n_cells × k)` index/distance intermediates while assembling
#: the sparse graphs, and `make_nhoods` takes a CSR row slice of the distances. Both are smaller
#: than the terms above and both are transient, but the estimate is deliberately described as
#: incomplete rather than as exact — a gate that claims to know the peak, and does not, is how a
#: run passes it and is then OOM-killed.
_KNN_BYTES_PER_NEIGHBOUR_PER_CELL = 28
#: Bytes per neighbour per cell for the boolean neighbourhood-membership matrix. It is a COLUMN
#: SUBSET of the binarised kNN graph (one column per refined index cell), so its nnz is
#: `prop · k · n_cells` at most; sized at the full k here and scaled by `prop` at the call site.
_NHOOD_BYTES_PER_NEIGHBOUR_PER_CELL = 8

#: CPU-seconds an nhood-path DA run is estimated to cost per MILLION CELLS — the kNN build plus
#: the per-neighbourhood refinement, both cells-dominated. A coarse, honest upper-ish bound tuned
#: so a real single-dataset run sits well inside 600 CPU-s and only a genuinely oversized
#: embedding trips it. Counts stored values (PARALLELISM against the CPU budget), not wall clock.
_CPU_SECS_PER_MILLION_CELLS = float(os.environ.get("DA_CPU_SECS_PER_MCELL", "45.0"))

#: The viable-cell floor. Below this there is nothing to build a neighbourhood graph over, and
#: the run is refused honestly rather than fitting one on too few cells.
MIN_VIABLE_CELLS = 10


#: The design frame's own key for the tested coefficient. A covariate carrying this NAME would be
#: splatted over it — `{"condition": …, **covariates}` — silently replacing the tested values with
#: the covariate's and putting the term in the design formula twice. Lives HERE, not copied into
#: each entry, because it is a rule BOTH analyses follow and a copy is a rule one of them can lose.
CONDITION_KEY = "condition"


def refuse_covariate_named_like_the_condition(sample_covariates, fail):
    if CONDITION_KEY in sample_covariates:
        fail(
            f"refusing to test: a covariate column is named {CONDITION_KEY!r}, which is the design "
            "frame's own key for the tested coefficient — binding it as a covariate would REPLACE "
            "the condition's values with the covariate's and put the term in the formula twice. "
            "Rename that column, or deselect it as a covariate. (If it IS the condition column, it "
            "is already in the model and must not be added again.)"
        )


#: Characters an output label may contribute to a store PATH. Everything else is replaced.
#:
#: `.` is DELIBERATELY NOT in this set. Allowing it and stripping leading dots leaves `..` alive
#: in the middle of a longer label (`../../a/../b` reduces to `a_.._b`), which is harmless as a
#: single segment but is a traversal component sitting in a path for no reason at all — the label
#: never needs a dot, because the writer appends `.zarr` itself. Excluding it makes "no `..` can
#: appear" true by construction rather than by an argument about where the dots ended up.
_LABEL_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


def safe_label(raw, *, default="abundance", limit=64):
    """A user-supplied output label, reduced to something that can only ever be ONE path segment.

    The label is a free-text control the user types, and it reaches `outputs/columns/<label>.zarr`.
    A label containing `/` or `..` would put the artifact somewhere the run does not own — the
    same traversal `txr_zarr.Table._claim` refuses for a member NAME, at the one level above it.
    So it is reduced here rather than trusted: every character outside the conservative set above
    becomes `_`, runs of `_` collapse, and the result is trimmed and capped. An empty or
    fully-unsafe label falls back to the default rather than producing an empty path segment.
    """
    import re

    text = "" if raw is None else str(raw)
    cleaned = "".join(c if c in _LABEL_SAFE else "_" for c in text)
    cleaned = re.sub(r"_{2,}", "_", cleaned).strip("_-")[:limit]
    return cleaned or default


_PREFIX = ["differential-abundance"]


def set_prefix(prefix):
    """Set the diagnostic prefix (`da.clusters` / `da.neighbourhoods`) so a caller and the test
    harness can tell OUR named refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors clustering/_shared, differential-expression/_shared) ─
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
    """`slot → [{path, content_hash}, …]` in DECLARATION ORDER, resolved by SLOT out of
    `inputs.json` — never by filename suffix (the runner names mounts `in0`/…)."""
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
        slots.setdefault(str(slot), []).append(
            {"path": inputs_dir / sub, "content_hash": e.get("content_hash")})
    return slots


def slot_entries(slots, *names):
    for name in names:
        found = [e for e in slots.get(name, []) if Path(e["path"]).exists()]
        if found:
            return found
    return []


def slot_entry(slots, *names):
    found = slot_entries(slots, *names)
    return found[0] if found else None


#: Covariate columns arrive one per `covariate:<name>` slot — the slot NAME carries the column
#: name because a `metadata-column` store cannot carry its own display name. Same idiom
#: `cell-filter` and `de.compare` use for their criteria columns.
COVARIATE_SLOT_PREFIX = "covariate:"


def read_covariate_columns(slots, n_cells):
    """`{name: values}` for every `covariate:<name>` slot bound by the run, length-checked
    against the cells axis. Order is the DECLARATION order the runner recorded."""
    out = {}
    for slot, entries in slots.items():
        s = str(slot)
        if not s.startswith(COVARIATE_SLOT_PREFIX) or not entries:
            continue
        name = s[len(COVARIATE_SLOT_PREFIX):]
        vals = read_column_values(entries[0]["path"], s)
        if len(vals) != n_cells:
            fail(f"the covariate column {name!r} holds {len(vals)} values but the run's cells "
                 f"axis declares {n_cells} — not the same cells axis")
        out[name] = vals
    return out


# ── progress + manifest (mirrors clustering/_shared) ───────────────────────────────
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
    # The environment record rides out with the outputs, through the ONE point every successful
    # run passes. That placement is what makes the dependency contract WIRED rather than merely
    # available: a compute cannot emit its outputs without also emitting the record of the
    # environment that produced them, and `server/.../provenance/recorder.rs` lifts it by output
    # id. Round R1 found this package holding the BUILD-time half of #80 (`run.dependencies[]`)
    # and none of the run-time half — the only compute package in the tree in that state.
    #
    # The datatype is passed IN, not named by `txr_deps`: that module is app-core and may not
    # name a package's datatypes.
    txr_deps.augment(outputs_dir, entries, DT_REPORT_QC)
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


def stamp_txr_attributes(store_dir, structure, **kv):
    """Merge extra provenance keys into an ALREADY-WRITTEN txr_zarr store's group
    `attributes.txr` AND the in-memory `structure`, keeping the two IDENTICAL (the
    conformance gate requires a store-URL reader and an artifact-row reader to decode
    identically). `None` values are skipped so an absent bit stays absent (honest)."""
    for k, v in kv.items():
        if v is not None:
            structure[k] = v
    meta = Path(store_dir) / "zarr.json"
    doc = json.loads(meta.read_text())
    attrs = doc.get("attributes")
    if not isinstance(attrs, dict):
        attrs = {}
        doc["attributes"] = attrs
    attrs["txr"] = structure
    meta.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return structure


# ── reading a staged artifact (format from the declaration) ────────────────────────
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


def read_embedding_structure(path, slot):
    """The DECLARED structure of an `embedding` artifact — WITHOUT reading a byte of the matrix.
    Returns `(structure, member_name, n_rows, n_dims)`. This is what the ceiling gate reads
    before any read. Refuses a NON-embedding / 2-D-LAYOUT input BY NAME (INV-11): a UMAP/t-SNE
    layout is a lossy 2-D picture for the eye, and building neighbourhoods on it would make the
    "regions" an artefact of the drawing rather than of the data. Exactly the refusal
    `clustering.cluster` and `embedding.visualize` already take on the same edge."""
    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration in a "
            "group `zarr.json` — an `embedding` artifact is a dense 2-D txr_zarr store"
        )
    arrays = structure.get("arrays") or []
    dense = [a for a in arrays if isinstance(a, dict) and len(a.get("shape") or []) == 2]
    if not dense:
        fail(
            f"input on slot {slot!r} at {path.name!r} declares no dense 2-D array — the "
            "neighbourhood pass rebuilds the kNN graph from the embedding matrix (the "
            "PCA/latent representation), which is a 2-D `(cells × dims)` member (INV-11)"
        )
    member = dense[0]
    shape = member.get("shape") or []
    n_rows, n_dims = int(shape[0]), int(shape[1])
    member_kind = str((member.get("meta") or {}).get("kind") or member.get("kind") or "")
    declared_kind = str(structure.get("kind") or "")
    if n_dims <= 2 or member_kind in ("layout", "umap", "tsne") or declared_kind in (
            "layout", "umap", "tsne"):
        fail(
            f"input on slot {slot!r} declares a {n_dims}-D "
            f"{member_kind or declared_kind or 'layout'!r} representation; da.neighbourhoods "
            "refuses to build the neighbourhood graph on a 2-D layout (UMAP/t-SNE) and requires "
            "the reduced embedding (PCA/latent, ≥3 dims) it was laid out FROM (INV-11). A "
            "neighbourhood discovered on a picture is an artefact of the drawing."
        )
    return structure, member["name"], n_rows, n_dims


def read_embedding_matrix(path, member):
    """Read the dense `(n_cells × n_dims)` embedding member as a float32 numpy array."""
    import txr_zarr_read

    return np.asarray(txr_zarr_read.read_array(Path(path), member), dtype=np.float32)


def read_column_values(path, slot):
    """A `metadata-column` artifact → its VALUES as a list of `str` (population / condition /
    sample labels). Native dtype is coerced to text so a categorical grouping reads uniformly."""
    import txr_zarr_read

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"column input on slot {slot!r} at {path.name!r} carries no `structure` declaration "
            "— it is not a txr_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path") or columns[0].get("name")
    values = txr_zarr_read.read_column(path, member or "values")
    if hasattr(values, "tolist"):
        values = values.tolist()
    return [("" if v is None else str(v)) for v in values]


def column_provenance(path):
    """A column's `attributes.txr` provenance dict (the regime classifier's input). Returns the
    whole dict (it may carry a `clustering`/annotation/prediction sub-key, or an `external` bit)
    or `{}` when the column declares none.

    ── WHICH COLUMN THIS IS ASKED OF, AND WHY IT MATTERS (INV-DA-3) ───────────────────────────
    In `de.compare` the grouping column is BOTH the thing that defines the groups AND the thing
    being tested, so one `classify` call covers everything. IN DIFFERENTIAL ABUNDANCE THEY
    SEPARATE: the POPULATION defines the ROWS of the count matrix, and the CONDITION defines the
    TESTED COEFFICIENT. The regime is therefore classified on the CONDITION (plus the sample
    column for replication) and NEVER on the population.

    That is not a convenience. DA populations are matrix-derived BY CONSTRUCTION — there is no
    such thing as differential abundance over populations that were not derived from the matrix
    — so classifying on the population would return R2 for every run that could ever exist and
    the feature would never write a p-value. It is also not the double-dipping `de.compare`'s
    INV-2 guards against, because the population boundaries were drawn CONDITION-BLIND: the
    clustering never saw the condition label, so the null distribution of the abundance statistic
    is not distorted by the selection. What IS affected is the INTERPRETATION — a cluster is an
    arbitrary partition, so a cluster-level result is sensitive to the clustering resolution,
    which `da.clusters` discloses and `da.neighbourhoods` avoids by being resolution-free.

    The residual, honest risk: if the population labels WERE derived with knowledge of the
    condition (clustering after condition-aware integration; an annotation transferred from a
    condition-matched reference) then the selection IS circular. That cannot be detected reliably
    from `attributes.txr` today, so it is a STATED LIMITATION in `methods.md` rather than a fake
    guard — inventing a detector we cannot make sound would be worse than disclosing the gap.
    """
    return artifact_structure(path) or {}


# ── the ceiling gate ───────────────────────────────────────────────────────────────
def ceiling_refuse_if_over(n_cells, n_dims, *, n_neighbors=15, prop=0.1):
    """Refuse BEFORE any read when the run's declared work would blow the Normal-class envelope,
    naming WHICH ceiling (memory vs time) and a REACHABLE lever. Sized from the DECLARED
    embedding shape and the ACTUAL `n_neighbors`/`prop` the run honours — never a hardcoded k.

    The refusal deliberately does NOT name a `batch` resource class: this package ships no
    per-run class control, so naming one would point the reader at an escape hatch that does not
    exist (the same F2 correction `clustering` already carries)."""
    n_cells = int(n_cells)
    n_dims = int(n_dims)
    k = int(n_neighbors)
    knn_bytes_per_cell = k * _KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    nhood_bytes_per_cell = int(round(k * float(prop))) * _NHOOD_BYTES_PER_NEIGHBOUR_PER_CELL
    resident = n_cells * (n_dims * _BYTES_PER_DIM + knn_bytes_per_cell + nhood_bytes_per_cell)
    cpu_secs = (n_cells / 1_000_000.0) * _CPU_SECS_PER_MILLION_CELLS
    if resident > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the embedding: this run needs about "
            f"{resident / 1024**3:.2f} GiB resident ({n_cells:,} cells × ({n_dims} dims × "
            f"{_BYTES_PER_DIM} + kNN graph {knn_bytes_per_cell} + neighbourhood membership "
            f"{nhood_bytes_per_cell} bytes per cell at n_neighbors={k}, prop={prop})), over the "
            f"MEMORY ceiling of {_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Normal resource "
            "class. The levers that move this are a smaller embedding (fewer cells), a smaller "
            "`k`, or raising the deployment's sandbox memory limit; the run is refused rather "
            "than left to be OOM-killed mid-build."
        )
    if cpu_secs > _CPU_SECS_BUDGET:
        fail(
            "refusing before reading the embedding: this run is estimated at about "
            f"{cpu_secs:.0f} CPU-seconds ({n_cells:,} cells), over the TIME ceiling of "
            f"{_CPU_SECS_BUDGET:.0f} CPU-seconds for the Normal resource class. CPU-seconds "
            "count parallelism, not wall clock. The levers that move this are the admin "
            "`timeout_secs` sandbox setting or a smaller embedding; the run is refused rather "
            "than left to die to SIGXCPU."
        )
    return {"n_cells": n_cells, "n_dims": n_dims, "n_neighbors": k, "prop": float(prop),
            "knn_bytes_per_cell": knn_bytes_per_cell,
            "nhood_bytes_per_cell": nhood_bytes_per_cell,
            "estimated_resident_bytes": resident, "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}


# ── the per-comparison `da/result` population-table writer ─────────────────────────
#
# ABSENCE IS ABSENCE. `columns` holds the members ACTUALLY written for this comparison: the
# caller OMITS `neglog10p`/`padj`/`spatial_fdr` in R2/R3, so they are not written at all — not
# zero, not one, not NaN-filled. `spatial_fdr` is additionally omitted by `da.clusters` in EVERY
# regime (clusters are disjoint, so a connectivity weight over them would be meaningless, and
# emitting a meaningless column is worse than omitting it — INV-DA-4).
#
# `neglog10p` is stored, NEVER a raw `p`: an f32 p underflows to 0 below ~1e-45, which destroys
# the ranking among exactly the top hits a reader looks at first.
def write_da_result(outputs_dir, rel_dir, name, population_ids, columns, *, regime,
                    multiplicity_family, aligned_to=None, extra_attrs=None):
    """Write ONE comparison's DA result as a population-axis annotation table (`da/result`).

    Returns `(structure, meta)` — the two declarations the manifest entry carries.
    """
    import txr_zarr

    n = len(population_ids)
    dest = outputs_dir / rel_dir
    written = []
    with txr_zarr.Table(dest, axis="populations", n=n, key="population",
                         aligned_to=aligned_to) as t:
        t.string("population", [str(p) for p in population_ids])
        for member, arr in columns.items():
            a = np.asarray(arr, dtype=np.float64)
            if a.shape[0] != n:
                fail(f"da/result member {member!r} has {a.shape[0]} values but the population "
                     f"axis declares {n}")
            t.numeric(member, a, dtype="float64")
            written.append(member)
        structure = t.close()
    meta = {"name": name, "axis": "populations", "n": n, "regime": regime,
            "multiplicity_family": multiplicity_family, "members": written,
            "entity_axis": "population"}
    attrs = {"regime": regime, "multiplicity_family": multiplicity_family,
             "entity_axis": "population", "pvalues_written": "neglog10p" in written,
             "spatial_fdr_written": "spatial_fdr" in written}
    if extra_attrs:
        attrs.update(extra_attrs)
    stamp_txr_attributes(dest, structure, da=attrs)
    meta["da"] = attrs
    return structure, meta


def regime_note_for(regime_module, regime, fit_record):
    """The regime's canonical note — REPLACED by the real reason when the run was DOWNGRADED.

    ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
    An R1 run whose fit yields no usable p-value is downgraded to R3, and `regime_note(R3)` then
    stamps R3's fixed text: "there is only one sample per side". For a downgraded run that is
    FALSE, and it is stamped into the artifact and the report right next to `samples_per_side: 2`
    and `n_samples_1/2: 2 2`, which say the opposite. A reader gets two contradictory statements
    from the same record and the true reason is buried in `fit.downgrade_reason`.

    Round R2 found this. `_regime.py` is VENDORED byte-identical from `differential-expression`
    and pinned by a parity test, so the fix cannot live there — a downgrade is this package's
    concept, not the shared classifier's. It lives here, at the call site, which is also where the
    reason actually is.
    """
    note = regime_module.regime_note(regime)
    reason = (fit_record or {}).get("downgrade_reason")
    if not reason:
        return note
    return (
        f"Downgraded to {regime} AFTER fitting — the grouping is external and the design was "
        f"replicated, so this is NOT the unreplicated case the {regime} note otherwise describes. "
        f"{reason}"
    )


def library_versions():
    """The RESOLVED version of every library this entry DECLARED — from `txr_deps` (#80).

    ── WHY THIS IS NOT A HAND-WRITTEN LIST ───────────────────────────────────────────────────
    It was one, and `_lib/txr_deps.py` exists because four packages each had the same one. Its
    docstring names the three defects every copy shared, and this copy had all three: the library
    list was typed out separately from the libraries the code imports (so it drifted — round R1
    found `da.clusters` reaching `scanpy`, `anndata` and `sklearn` through `__import__` here while
    declaring none of them); an unreadable version was recorded as `None` rather than refused (so
    an absent library read as "unknown" and the run continued); and nothing compared the recorded
    version to anything (so recording it changed no outcome).

    `txr_deps` fixes all three by construction: the subject set is the DECLARED contract — the
    same `run.dependencies[]` the build gate reads — an unreadable version REFUSES, and every
    version is checked against its declared range. It reads distribution metadata rather than
    `__version__`, which is being removed (this function's own `__import__` was emitting
    `FutureWarning: __version__ is deprecated` on every run).

    Memoized in `txr_deps`, so this and the manifest-write hook resolve once and cannot disagree.
    """
    return txr_deps.resolve_and_check()["libraries"]
