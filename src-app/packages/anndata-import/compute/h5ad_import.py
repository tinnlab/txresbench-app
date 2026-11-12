#!/usr/bin/env python3
# ruff: noqa
"""h5ad_import — TxResBench sandbox compute processor (ITEM-7/8/9).

The comprehensive **h5ad / 10x → Zarr** converter. Reads an uploaded AnnData
``.h5ad`` OR a 10x CellRanger matrix (``.h5`` / ``.mtx`` trio / archive), detects
a genuine count matrix WITHOUT ever force-casting (DEC-11), and re-emits the
object as typed, role-tagged workstore outputs (§ Output spec):

  * ``expression``       — the count matrix as a CSC (gene-major) **Zarr v3** store
                           (``indptr``/``indices``/``data``), produced by the
                           streaming counting-sort transpose in ``txr_csc``
                           (role=artifact). Emitted PER MODALITY when
                           ``var['feature_types']`` names more than one.
  * ``embedding``×N      — one per ``obsm`` ≥2-D numeric key (X_umap/X_pca/…/novel),
                           the exact array values, obs-aligned, dense ``.zarr``,
                           each carrying a harvested ``label`` + ``meta`` (role=artifact).
  * ``metadata-column``×N — one per ``obs`` column (axis=cells) and one per ``var``
                           column (axis=genes), plus the per-axis entity indexes,
                           dtype-preserving (role=artifact).
  * ``dataset-metadata`` — the harvested dataset summary JSON the FW-8 finalize
                           hook reads into ``datasets.metadata`` (role=intermediate).
  * ``inspect``          — a human-readable ``report/html`` summary (role=intermediate).

**The TileDB-SOMA output is gone** (ITEM-27). It was never a second product: the
CSC trio was read back OUT of the store it had just been written to, so SOMA was a
TRANSPOSE BUFFER on the critical path — 86 % of import wall clock on the measured
150k × 32k case. ``txr_csc`` does the transpose directly, out-of-core, and writes
Zarr, so every output this processor emits is now one format the browser reads with
no dependencies. What went with it: the store was also the dtype-exact archive, so
an integer count matrix's SOURCE dtype now survives as
``expression.meta.source_dtype`` rather than in the stored values, which are
``float32`` exactly as the previous CSC projection's were.

Counts correctness (the single most important scientific rule, DEC-11 / RESEARCH
§2.1): the count source follows the precedence ``layers['counts']`` → ``raw.X`` →
``X``, choosing the first that passes an integer/non-negative gate; the chosen
``count_source`` + classified ``x_state`` are recorded. A non-integer matrix is
converted losslessly but NEVER labeled as raw counts. No force-cast, no silent loss.

Run feedback (DEC-12 / ITEM-24): besides the fine ``phase|pct|message`` progress
lines, this emits biologist-facing MILESTONES + data-determined FINDINGS to
``$TXR_PROGRESS_FIFO`` as ``milestone|<id>|<status>[|<detail-json>]`` lines
(status ∈ ``started|done|failed``). Milestone ids (declared, ordered):
``read`` → ``detect-counts`` → ``convert`` → ``embeddings`` → ``metadata`` →
``summarize``; each carries the structured finding it discovered at runtime.

The run contract (``sandbox/outputs.rs``): read ``/inputs/<slot>`` +
``/inputs/inputs.json`` + ``/inputs/params.json``; write ``/outputs/<file>`` +
``/outputs/manifest.json`` = ``{"outputs":[{id,datatype,path,layout,role,label?,meta?}]}``.
The ``/inputs`` and ``/outputs`` roots are overridable via ``TXR_INPUTS_DIR`` /
``TXR_OUTPUTS_DIR`` (unset in the sandbox → the fixed ``/inputs`` / ``/outputs``
binds) — the ONLY seam that lets the harness drive the REAL script off-sandbox.
"""
import gzip
import txr_deps
import json
import os
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

# Single-thread the numeric stack BEFORE numpy/scipy/scanpy import: the sandbox
# caps PIDs, and the BLAS/OpenMP/numba thread pools otherwise exhaust it
# (`pthread_create: Resource temporarily unavailable` → SIGABRT). Also makes the
# compute deterministic (reproducible-run friendly).
for _v in (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
):
    os.environ.setdefault(_v, "1")

import numpy as np
import scipy.sparse as sp

# Shared sibling helper (ITEM-21 / DEC-25): the COMPACT per-column viz summary that
# rides each metadata-column's catalog `meta`. REUSED, never reimplemented (the task
# contract). Unlike the io/milestone boilerplate below (inlined per-script), this is a
# genuine shared module: the sandbox runner stages `colsummary.py` alongside this entry
# script, and the off-sandbox harness/pytest puts the scripts dir on `sys.path`. The
# self-dir insert covers the sandbox-staged case; the harness inserts the scripts dir.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
import txr_columns  # the shared `_lib` output-format adapter (DEC-7)
import txr_csc  # the shared `_lib` out-of-core CSR→CSC transpose (ITEM-27)
from colsummary import summarize_column  # noqa: E402

# Slice-6 multi-modal ingest CORRECTNESS kernels (INV-10..17), co-located sibling. Pure
# (numpy/pandas/scipy only), cited to research/MULTIMODAL_*.md. See its module docstring.
import multimodal as mm  # noqa: E402

# ─────────────────────────── shared compute runtime ───────────────────────────
# Inlined (not imported) as small per-script I/O boilerplate that is intentionally
# kept identical across the builtins' compute scripts. (The runner binds the whole
# /code dir and stages the shared PY_HELPERS — e.g. `colsummary.py` above — so a
# genuine shared module CAN be imported; this block just isn't worth centralizing.)

# P2 datatype vocabulary → (datatype id, storage-layout string) the outputs
# manifest must declare (`datatype/builtin.rs`, `StorageLayout::as_str`).
# The CSC-sparse gene-expression matrix (cells × genes), written as a Zarr v3 group of
# three sharded members — `indptr` (int64, n_vars+1), `indices` (uint32 cell rows),
# `data` (float32) — by `txr_csc.write_csc_zarr`. Since ITEM-27 deleted the SOMA
# store this is THE count matrix, not a projection of one, so it carries `role=artifact`
# rather than the viz-only `intermediate` it had while an archive existed beside it.
DT_EXPRESSION = ("single-cell/expression", "chunked-sparse")
# Per-modality matrix datatypes (Slice-6 ITEM-18): RNA is not privileged (INV-8). A modality
# output is typed by `mm.modality_datatype(modality)` → one of these ids; the layout is the same
# CSC-sparse projection. The GENERIC `single-cell/modality` covers arbitrary named modalities
# (crispr/custom/hto/…). `single-cell/multimodal` is the CONTAINER linking them (INV-9).
DT_MODALITY_LAYOUT = "chunked-sparse"
DT_MULTIMODAL_CONTAINER = ("single-cell/multimodal", "opaque")
DT_EMBEDDING = ("embedding", "chunked-dense")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_HTML = ("report/html", "opaque")
# The harvested dataset-metadata JSON is consumed by the finalize hook (keyed on
# the output id `dataset-metadata`); it rides the CONCRETE opaque leaf `data/opaque`
# — the abstract `data` ROOT can never directly type an artifact (workstore ingest
# rejects abstract datatypes), so the opaque catch-all is `data/opaque`.
DT_DATA = ("data/opaque", "opaque")

# ── streaming ingest (MEASURED) ───────────────────────────────────────────────
# The converter NEVER holds the whole matrix in RAM, and after ITEM-27 that is true
# of every stage rather than true by delegation to a store:
#   * detect-counts scans the h5ad stored-value datasets in chunks (h5py);
#   * metadata/embeddings read from a BACKED handle (X is never loaded);
#   * the CSC expression matrix is produced by `txr_csc`'s BANDED counting-sort
#     transpose, whose peak is bounded by its declared `nnz_cap` (env
#     `TXR_TRANSPOSE_NNZ_CAP`), not by the matrix.
# Measured on a 40k × 20k / 39.0M-nnz fixture: 9.5 s and 0.72 GB peak, against
# 14.8 s and 1.76 GB for the `from_h5ad` + read-back-out-of-SOMA path it replaces.
# The full-load fallback that the old `uns`/X-absent edge cases dropped into is
# gone too — a promoted layer or `raw.X` now streams like `/X` does.


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


def load_inputs_index(inputs_dir):
    """slot → host path, resolved from inputs.json (`sandbox_path` = /inputs/<sub>).

    Falls back to globbing the inputs dir when inputs.json is absent (the harness
    may just drop a file in place)."""
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        sp_path = e.get("sandbox_path", "") or ""
        if sp_path.startswith("/inputs/"):
            sub = sp_path[len("/inputs/") :]
        else:
            sub = Path(sp_path).name or e.get("slot", "")
        slots[e["slot"]] = inputs_dir / sub
    return slots


def resolve_slot(slots, inputs_dir, prefer, patterns):
    """Pick an input by slot-name preference, else the first declared, else glob."""
    for name in prefer:
        if name in slots and Path(slots[name]).exists():
            return Path(slots[name])
    for p in slots.values():
        if Path(p).exists():
            return Path(p)
    for pat in patterns:
        hits = sorted(inputs_dir.glob(pat))
        if hits:
            return hits[0]
    return None


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


_PROGRESS_FD = [-1]  # persistent FIFO write fd (index 0), lazily opened


def _fifo_write(line):
    """Write one framed line to the progress FIFO (shared by progress + milestone).

    Persistent write fd: opened once, reused, closed at process exit — one
    continuous stream to the runner's FIFO drain (streaming.rs), no per-frame
    reopen churn. Retry the open if the reader was not ready on frame 1."""
    fifo = os.environ.get("TXR_PROGRESS_FIFO")
    if not fifo:
        return
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


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")  # keep message in field 3
        parts.append(str(message))
    line = "|".join(parts)
    _fifo_write(line)
    print("progress:", line, file=sys.stderr, flush=True)


# The declared, ordered biologist milestones (ITEM-24 / DEC-12). The UI renders
# this full checklist up-front (upcoming steps greyed); the script emits
# transitions + data-determined findings against these ids.
MILESTONE_IDS = (
    "read", "detect-counts", "convert", "expression", "embeddings", "metadata",
    "summarize", "spatial-images",
)
_CURRENT_MILESTONE = [None]  # for failure-path emission


def milestone(mid, status, detail=None):
    """Emit a biologist-facing milestone transition (ITEM-24 / DEC-12):
    ``milestone|<id>|<status>[|<detail-json>]``, status ∈ started|done|failed.
    The optional ``detail`` is the structured, data-determined FINDING the code
    discovered at runtime (these findings ARE the ITEM-9 harvested metadata,
    surfaced incrementally). Shares the progress FIFO stream."""
    if status == "started":
        _CURRENT_MILESTONE[0] = mid
    parts = ["milestone", str(mid), str(status)]
    if detail is not None:
        parts.append(json.dumps(detail, default=_jsonable, separators=(",", ":")))
    line = "|".join(parts)
    _fifo_write(line)
    print("milestone:", line, file=sys.stderr, flush=True)
    if status in ("done", "failed"):
        _CURRENT_MILESTONE[0] = None


#: The `(datatype, layout)` this package emits its run-environment record as (#80).
#: Declared here because the package knows its own output type; the shared recorder
#: in `_lib` is app-core and may not name a contributed domain's vocabulary.
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")


def write_manifest(outputs_dir, entries):
    # #80 — append this run's ENVIRONMENT RECORD (the resolved version of every library
    # this entry declares) before the manifest is written, and refuse the run if the
    # environment does not satisfy the declaration. Placed here, on the one path every
    # successful run takes, so recording is structural rather than remembered: a compute
    # cannot emit its outputs without also emitting what produced them.
    # The datatype is THIS package's, passed in: `txr_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    txr_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    # Compact, not `indent=2`. Only the server reads this file, and pretty-printing
    # it doubled its size (a real import measured 1.06 MB of content as a 2.12 MB
    # file) against the 1 MiB cap in `outputs.rs`. Whitespace is not metadata.
    (outputs_dir / "manifest.json").write_text(
        json.dumps({"outputs": entries}, separators=(",", ":"))
    )


def output_entry(id, datatype_layout, path, role, label=None, meta=None, axis=None,
                 hidden=False, *, structure):
    """Build one `/outputs/manifest.json` entry. `label` (ITEM-11) is the harvested
    per-instance descriptor — omitted when absent. `axis` (ITEM-7) tags a per-entity
    output with its datatype AXIS name (`cells`/`genes`/…) — omitted for non-axis
    outputs; readers default when absent. `hidden` (ITEM-20) drops the artifact from
    the catalog listing (still fetchable by id) — used for a byproduct the user
    shouldn't see first-class (e.g. the dataset-metadata JSON).

    `structure` (HOW to decode the bytes) and `meta` (what they MEAN) are producer
    declarations with NO default on either side of the wire (artifact-model ITEM-5/6),
    so both are written into every entry — `meta` as an explicit `null` when absent."""
    dt, layout = datatype_layout
    entry = {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
             "structure": structure, "meta": meta}
    if label is not None:
        entry["label"] = label
    if axis is not None:
        entry["axis"] = axis
    if hidden:
        entry["hidden"] = True
    return entry


def _jsonable(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def write_metadata_column(outputs_dir, rel_dir, name, series, axis,
                          holds_axis_keys=False, aligned_to=None, membership=None):
    """A single per-entity metadata column as a Zarr artifact DIRECTORY (ITEM-26).

    Was a single-file JSON carrying every value as a Python literal — a 150k-cell
    column cost ~2 MB of text the client parsed in full before it could paint. The
    shared `txr_columns` adapter now picks the encoding from the column's pandas dtype
    (declared categorical → codes + the declared level set, integer → an exact-width
    integer array, float → float with native NaN, anything else → arrow strings) and
    returns the two producer declarations the manifest entry carries.

    `axis` is positional-or-keyword and has NO default, here or in `txr_columns`. It used
    to default to `"cells"` in both, and the pair was worse than either alone: the manifest
    entry each caller builds declares `axis=` explicitly anyway, so the `structure.axis`
    and the entry's `axis` came from two different places and could silently disagree. Now
    every call site names it once, and `txr_columns` — framework code that must know no
    domain (INV-5) — names it never.
    """
    return txr_columns.write_metadata_column(outputs_dir, rel_dir, name, series, axis=axis,
                                              holds_axis_keys=holds_axis_keys,
                                              aligned_to=aligned_to, membership=membership)


def axis_key_series(adata):
    """The ordered ENTITY KEYS of this file's two axes, as the pair `(cells, genes)`.

    ONE definition, because it is read twice for two different reasons and the two must not
    drift: the axis-index artifacts are WRITTEN from it, and every other artifact this run
    emits declares `aligned_to = <its digest>` (ITEM-15). If the second ever digested a
    different sequence from the first, every column would declare an alignment to a row
    space that does not exist, and the failure would be silent everywhere except a picker
    that quietly offers nothing.

    B5/INV-17: the genes axis SERVES the true per-modality label — `var['feature_name']` when
    the multi-modal combine set it (a name reused across modalities keeps its real name, NOT
    the storage-disambiguated `CD3-1` combined index), else `var_names` verbatim (single-modal
    path byte-identical, DEC-23).
    """
    import pandas as pd

    genes = pd.Series(
        (adata.var["feature_name"] if "feature_name" in adata.var.columns
         else pd.Series(adata.var_names)).astype(str)
    )
    return pd.Series(adata.obs_names.astype(str)), genes


def write_expression_csc(source, outputs_dir, rel_dir, *, columns=None, counts=None,
                         modality=None):
    """Write the CSC gene-expression matrix at `<outputs_dir>/<rel_dir>` as Zarr.

    ITEM-26/27 — this was the LAST output still written as raw little-endian bins
    (`indptr` i64 / `indices` u32 / `data` f32). It stayed raw not by oversight but
    because it is the one output never materialized in memory, and the batch
    `txr_zarr` writer took a whole array; ITEM-28's incremental shard writer removed
    that constraint, so the processor now emits ONE format everywhere.

    `columns` selects + re-indexes the output columns for a per-modality split;
    `counts` lets several modality splits of ONE matrix share a single counting pass
    instead of re-histogramming the whole matrix per modality. Returns
    `(structure, n_cols, nnz)`.

    `modality` — the split's key — is DECLARED INTO THE STRUCTURE, not just into the
    manifest row's `meta`. The two are not interchangeable: `meta` is a catalog column and
    `/inputs/inputs.json` carries `{slot, kind, content_hash, sandbox_path}`, so a compute
    reading a STAGED matrix never sees it. `structure` is stamped into the store's own
    `zarr.json`, which travels with the bytes — and it is the channel `qc-10x.py`
    (`artifact_structure` → `modality_keys`) PREFERS for exactly that reason. Stamping it
    here is what lets a multi-matrix run derive its column prefixes from the artifacts
    instead of from a positional `params.matrix_modalities` relay nothing can verify.

    `None` (the single-modality path) stamps NOTHING, which is not an oversight: with one
    matrix an absent key means "no prefix" — the pre-multimodal behaviour — so stamping a
    key there would silently rename every column of every ordinary import.
    """
    structure = txr_csc.write_csc_zarr(
        source, outputs_dir / rel_dir, columns=columns, counts=counts,
        axes=("cells", "genes"),
        structure_extra={"modality": modality} if modality else None,
    )
    return structure, int(structure["shape"][1]), int(structure["nnz"])


def sanitize_col_name(name):
    keep = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(name))
    return keep or "col"


# ───────────────────────────── converter helpers ──────────────────────────────

# Well-known embedding keys → (human label, method). Novel keys (X_scVI, X_phate…)
# are harvested generically by stripping the leading `X_`.
_EMB_LABELS = {
    "X_umap": ("UMAP", "umap"),
    "X_pca": ("PCA", "pca"),
    "X_tsne": ("tSNE", "tsne"),
    "X_diffmap": ("Diffmap", "diffmap"),
    "X_draw_graph_fa": ("ForceAtlas2", "draw_graph_fa"),
    "X_phate": ("PHATE", "phate"),
}


def embedding_label_method(key):
    if key in _EMB_LABELS:
        return _EMB_LABELS[key]
    base = key[2:] if key.lower().startswith("x_") else key
    label = base.upper() if base.islower() and len(base) <= 5 else base
    return (label or key, base.lower() or key.lower())


# The in-memory `_values_sample` / `is_integer_nonneg` / `detect_count_source` trio
# lived here until ITEM-27. They were the count-source gate for the one path that
# read the whole AnnData into RAM — the X-absent / spatial-`uns` fallback `from_h5ad`
# forced. That fallback is gone (the transpose reads any h5 matrix node directly), so
# the STREAMING pair `_is_counts` / `_classify_sample` below is the only gate left,
# and it is the one the converter actually runs.


# ───────────────── h5ad sparse layout — read the FORMAT, not one spelling ─────
#
# An h5ad sparse matrix group has been spelled more than one way over the format's
# life (modern ``encoding-type``/``shape``, h5sparse-era ``h5sparse_format``/
# ``h5sparse_shape``, and hand-written with neither), and a reader that knows only the
# CURRENT spelling rejects files ``anndata`` itself still opens. That is not an exotic
# corner FOR THIS PROCESSOR in particular: ``pbmc3k_raw.h5ad`` — the canonical scanpy
# tutorial input, and the app suite's own conversion fixture — is an h5sparse-era file,
# so the whole real-file import path was dead for the oldest and most widely circulated
# shape of the format this processor is named after.
#
# ALL OF THAT NOW LIVES IN ``txr_csc``, once. Read its "h5ad sparse layout" block for
# the format table and for the two things it deliberately does NOT infer (an undeclared
# SHAPE, and the orientation of a SQUARE undeclared store — half of those guesses hand
# back the transpose as science, and nothing downstream can tell).
#
# THIS MODULE USED TO CARRY A SECOND COPY of that resolution — ~70 lines of helpers
# plus a re-implemented sparse branch — on the stated grounds that
# ``txr_csc.source_for_h5`` "resolves by the MODERN spelling alone" and that an
# h5sparse-era ``/X`` "dies there with a bare ``KeyError: 'shape'``". Commit
# ``2a15e681`` made both false: the engine reads either spelling for orientation AND
# for shape, and an h5sparse-era CSC group resolves cleanly. The justification having
# expired, the copy went with it — two copies of a refusal whose whole job is to stop a
# silent transpose is the drift hazard, not the safeguard (they had already drifted in
# their message wording). The names below stay so this module's own call sites and the
# layout tests keep addressing the reader they belong to.

h5_attr_text = txr_csc.h5_attr_text
h5_sparse_format = txr_csc.h5_sparse_format
h5_matrix_shape = txr_csc.h5_matrix_shape
SPARSE_FORMAT_ATTRS = txr_csc.SPARSE_FORMAT_ATTRS
SPARSE_SHAPE_ATTRS = txr_csc.SPARSE_SHAPE_ATTRS
SPARSE_MEMBERS = txr_csc.SPARSE_MEMBERS
#: A `txr_csc` transpose source for an h5ad matrix node, across format versions.
#: Dense, sparse, under-declared and not-a-matrix all resolve — or fail loud — in the
#: engine; see its `source_for_h5`.
source_for_h5_matrix = txr_csc.source_for_h5


# ─────────────────────── streaming (never-load-the-matrix) ────────────────────

def _h5_matrix_data(f, path):
    """Resolve an h5ad matrix node to its stored-VALUE dataset without loading it.
    Returns ``(data_dset, nnz_or_None, shape_or_None)`` or ``None`` if absent. A
    sparse group (``data``/``indices``/``indptr``) → its ``data`` dataset (nnz =
    ``len(data)``); a dense dataset → the dataset itself (nnz counted lazily by the
    caller). ``path`` is an h5ad group path: ``"X"`` / ``"layers/counts"`` /
    ``"raw/X"``.

    The shape comes from `h5_matrix_shape`, so it reads every format version — and is
    ``None``, not ``(0, 0)``, when the file declares none. It used to default to
    ``(0, 0)``, which is a shape a caller can compute a density from."""
    import h5py

    if path not in f:
        return None
    node = f[path]
    if isinstance(node, h5py.Dataset):
        return node, None, tuple(int(x) for x in node.shape)
    if "data" in node:
        return node["data"], int(node["data"].size), h5_matrix_shape(node)
    return None


def _scan_data(dset, sample_cap=4_000_000, chunk=8_000_000):
    """Stream a matrix's stored-value dataset (sparse 1-D ``data`` or dense N-D) and
    return ``(n_values, dtype, min_all, sample, nnz_all)`` WITHOUT loading it whole.
    ``min_all`` = the true minimum over ALL finite values (the negativity gate);
    ``sample`` = the first ``sample_cap`` finite values as float (integrality +
    min/max classification), mirroring the old in-memory ``_values_sample`` head-cap;
    ``nnz_all`` = the TRUE count of nonzero values over the WHOLE dataset (not the
    head-capped sample — used for dense-X nnz). ``min_all``/``sample`` are ``None``
    for object/undecodable dtypes."""
    dtype = dset.dtype
    if dtype == object:
        return int(np.prod(dset.shape)), dtype, None, None, 0
    shape = tuple(int(x) for x in dset.shape)
    n = int(np.prod(shape)) if shape else 0
    if n == 0:
        return 0, dtype, None, np.zeros(0, dtype=float), 0
    min_all = np.inf
    nnz_all = 0
    sample_parts, have = [], 0

    def _fold(block):
        nonlocal min_all, have, nnz_all
        b = np.asarray(block, dtype=float).ravel()
        nnz_all += int(np.count_nonzero(b))  # TRUE nonzero count over ALL values (dense nnz)
        fin = b[np.isfinite(b)]
        if fin.size:
            m = float(fin.min())
            if m < min_all:
                min_all = m
        if have < sample_cap:
            take = b[: sample_cap - have]
            sample_parts.append(take)
            have += int(take.size)

    if len(shape) == 1:
        for i in range(0, n, chunk):
            _fold(dset[i : i + chunk])
    else:  # dense 2-D — iterate row blocks
        ncol = max(1, shape[1])
        rblk = max(1, chunk // ncol)
        for r in range(0, shape[0], rblk):
            _fold(dset[r : r + rblk])
    sample = np.concatenate(sample_parts) if sample_parts else np.zeros(0, dtype=float)
    return n, dtype, (None if not np.isfinite(min_all) else min_all), sample, nnz_all


def _classify_sample(min_all, sample):
    """x_state from a streamed (min_all, sample) — the classify_x_state contract on
    streamed inputs: scaled (any negative) | raw_counts (integral) | log_normalized
    (max ≤ 15) | normalized | unknown."""
    if sample is None or sample.size == 0:
        return "unknown"
    fin = sample[np.isfinite(sample)]
    if fin.size == 0:
        return "unknown"
    mn = min_all if min_all is not None else float(fin.min())
    mx = float(fin.max())
    is_int = bool(np.allclose(fin, np.round(fin)))
    if mn < 0.0:
        return "scaled"
    if is_int:
        return "raw_counts"
    if mx <= 15.0:
        return "log_normalized"
    return "normalized"


def _is_counts(min_all, sample):
    """is_integer_nonneg on streamed inputs: min over ALL ≥ 0 AND integral sample."""
    if sample is None or sample.size == 0:
        return False
    fin = sample[np.isfinite(sample)]
    if fin.size == 0:
        return False
    if min_all is not None and min_all < 0.0:
        return False
    return bool(np.allclose(fin, np.round(fin)))


def detect_counts_streaming(f):
    """h5py streaming equivalent of ``detect_count_source`` + ``classify_x_state``,
    reading only the ``data`` arrays in chunks. Returns
    ``(count_source, count_path, x_state, x_present, x_layer, nnz, dtype, x_path)``.

    Count-source precedence: ``layers['counts']`` → ``raw.X`` → ``X`` (first passing
    the integer/non-negative gate).

    ``x_path`` is the h5ad path of the matrix that BECOMES X — ``"X"`` when it exists,
    otherwise the promoted counts layer / ``raw/X`` / first layer, and ``None`` when
    the file carries no matrix at all. It used to be a hint (``x_layer_for_soma``)
    telling ``tiledbsoma.io.from_h5ad`` which layer to write, with the X-absent case
    falling back to a WHOLE-FILE in-memory read because `from_h5ad` could only source
    ``/X``. The transpose reads whatever h5 node it is given, so the promotion is now
    just a different path and the fallback is gone (ITEM-27). ``x_layer`` still names
    the promoted LAYER, because that is a recorded finding."""
    candidates = []
    if "layers/counts" in f:
        candidates.append(("layers:counts", "layers/counts"))
    if f.get("raw") is not None and "raw/X" in f:
        candidates.append(("raw.X", "raw/X"))
    if "X" in f:
        candidates.append(("X", "X"))

    count_source = count_path = None
    for src, path in candidates:
        ref = _h5_matrix_data(f, path)
        if ref is None:
            continue
        _, dtype, min_all, sample, _ = _scan_data(ref[0])
        if _is_counts(min_all, sample):
            count_source, count_path = src, path
            break

    x_in_file = "X" in f
    x_present = x_in_file
    x_layer = None  # names the promoted LAYER, when a layer is what became X
    x_path = "X" if x_in_file else None
    if x_in_file:
        xref = _h5_matrix_data(f, "X")
        n, dtype, min_all, sample, nnz_all = _scan_data(xref[0])
        # sparse → stored count (len(data)); dense → the TRUE streamed nonzero count
        # (NOT count_nonzero of the head-capped sample, which undercounts >4M dense).
        nnz = xref[1] if xref[1] is not None else nnz_all
        x_state = _classify_sample(min_all, sample)
    else:
        # X ABSENT → promote, in count-source precedence: the gated count source
        # (`layers:counts` → `raw.X` — `count_path` is never `X` here since /X is
        # absent), else the first layer. This is the matrix the transpose will read, so
        # x_state/nnz/x_from_layer describe exactly what gets written.
        promote = count_path
        if promote is None and "layers" in f and len(f["layers"].keys()) > 0:
            promote = f"layers/{next(iter(f['layers'].keys()))}"
        pref = _h5_matrix_data(f, promote) if promote is not None else None
        if pref is not None:
            n, dtype, min_all, sample, nnz_all = _scan_data(pref[0])
            nnz = pref[1] if pref[1] is not None else nnz_all
            x_state = _classify_sample(min_all, sample)
            x_present = True
            x_path = promote
            if promote.startswith("layers/"):
                x_layer = promote.split("/", 1)[1]
        else:
            nnz, dtype, x_state = 0, None, "unknown"
    return count_source, count_path, x_state, x_present, x_layer, int(nnz), dtype, x_path


def detect_species(adata):
    """Species from gene-id / symbol prefixes (RESEARCH §2.2/§2.3) — never assume
    human. ENSG → human, ENSMUSG → mouse; else symbol case (MT- human / mt- mouse)."""
    ids = []
    if "gene_ids" in adata.var.columns:
        ids = [str(x) for x in adata.var["gene_ids"].astype(str)[:200]]
    names = [str(x) for x in adata.var_names[:200]]
    probe = " ".join(ids + names)
    if "ENSMUSG" in probe:
        return "mouse"
    if "ENSG0" in probe or "ENSG00" in probe:
        return "human"
    up = [n for n in names if n.startswith("MT-") or n.startswith(("RPS", "RPL"))]
    lo = [n for n in names if n.startswith("mt-") or n.startswith(("Rps", "Rpl"))]
    if up and not lo:
        return "human"
    if lo and not up:
        return "mouse"
    return "unknown"


def detect_gene_id_kind(adata):
    """ensembl | symbol | mixed — inspect the var index (RESEARCH §2.3)."""
    names = [str(x) for x in adata.var_names[:500]]
    if not names:
        return "unknown"
    ens = sum(1 for n in names if n.startswith(("ENSG", "ENSMUSG", "ENS")) and any(c.isdigit() for c in n))
    frac = ens / len(names)
    if frac >= 0.8:
        return "ensembl"
    if frac <= 0.2:
        return "symbol"
    return "mixed"


def col_descriptor(name, series):
    """{name, dtype, kind, n_categories?} for a dataframe column (INV-4 summary)."""
    import pandas as pd

    s = pd.Series(series)
    d = {"name": str(name), "dtype": str(s.dtype)}
    if isinstance(s.dtype, pd.CategoricalDtype):
        d["kind"] = "categorical"
        d["n_categories"] = int(len(s.cat.categories))
    elif s.dtype == bool:
        d["kind"] = "bool"
    elif s.dtype == object:
        d["kind"] = "string"
    elif str(s.dtype).startswith(("Int", "UInt", "Float", "boolean")):
        d["kind"] = "nullable"
    else:
        d["kind"] = "numeric"
    return d


# obsm keys that are per-cell FEATURE MATRICES (multimodal measurements), NOT
# low-dimensional projections — labeling these "embedding" is a mislabel. Matched
# case-insensitively as substrings (protein/ADT/antibody/CITE/HTO/hashing/… ).
_NON_EMBEDDING_OBSM = ("protein", "adt", "antibody", "cite", "hto", "hashing", "citeseq")


def obsm_role(key, arr, n_obs):
    """Classify an obsm key: spatial | embedding | other (RESEARCH §1.4 / §4)."""
    k = str(key).lower()
    if k == "spatial":
        return "spatial"
    # A multimodal feature matrix (CITE-seq ADT / HTO / protein) is per-cell but is
    # NOT a projection — keep it out of the embeddings harvest.
    if any(tok in k for tok in _NON_EMBEDDING_OBSM):
        return "other"
    a = arr if sp.issparse(arr) else np.asarray(arr)
    ndim = getattr(a, "ndim", 1)
    shape = getattr(a, "shape", ())
    if ndim >= 2 and len(shape) >= 2 and shape[0] == n_obs and shape[1] >= 2:
        try:
            probe = np.asarray(a[:1].todense() if sp.issparse(a) else a[:1])
            if np.issubdtype(probe.dtype, np.number):
                return "embedding"
        except Exception:
            return "other"
    return "other"


def write_embedding(outputs_dir, rel_dir, arr, method=None, aligned_to=None, name=None,
                    membership=None):
    """Write a dense (n_obs × n_dims) embedding as a Zarr artifact directory (ITEM-26).

    Downcast to float32 for the viz artifact (the source dtype stays exact in the
    lossless store). The previous writer reached for `zarr-python` and silently fell
    back to a `.npy` when the import failed — two formats for one output, one of which
    the browser cannot read. `txr_columns` writes the same sharded v3 store every
    other output uses, with no optional dependency and therefore no fallback. Returns
    `(structure, meta)`."""
    mat = np.asarray(arr.todense() if sp.issparse(arr) else arr)
    # `axis` / `name` / `kind` are all declared HERE. `txr_columns` used to default them
    # to `"cells"` / `"embedding"` / `"embedding"`, i.e. a framework library naming this
    # processor's domain (INV-5) and inventing declarations for it (INV-2). This processor
    # is the one entitled to say them: its obs axis IS `cells`, and the member the
    # coordinates land in is the one the viz reader looks for.
    # `name` is the artifact's DISPLAY name, and it must NAME THIS EMBEDDING — not its
    # datatype. It defaulted to the literal `"embedding"`, so a dataset holding X_umap, X_pca
    # and X_tsne published three artifacts whose declared names were byte-identical: the
    # picker offered three rows all reading `embedding`, could not tell them apart, and fell
    # back to suffixing each with eight characters of its content hash. The hash was the
    # SYMPTOM. The producer is the only party that knows these are UMAP, PCA and t-SNE, it
    # already derives exactly those words (`embedding_label_method`), and it was throwing them
    # away here. `kind` stays the datatype word — that one IS a kind, and nothing displays it.
    return txr_columns.write_embedding(outputs_dir, rel_dir, mat, axis="cells",
                                        name=(name or "embedding"), kind="embedding",
                                        method=method, aligned_to=aligned_to,
                                        membership=membership)


def write_inspect_html(outputs_dir, rel_path, meta):
    """A minimal, self-contained `report/html` summary of the harvested metadata
    (opaque, served as-is). The structured JSON is embedded for the inspector."""
    dest = outputs_dir / rel_path
    rows = []

    def row(k, v):
        rows.append(f"<tr><th style='text-align:left;padding:2px 12px 2px 0'>{k}</th><td>{v}</td></tr>")

    density = meta.get("density")
    row("Source format", meta.get("source_format"))
    row("Cells × genes", f"{meta.get('n_obs')} × {meta.get('n_vars')}")
    row("Non-zeros (nnz)", meta.get("nnz"))
    row("Density", f"{density:.4g}" if isinstance(density, float) else density)
    row("X state", meta.get("x_state"))
    row("Count source", meta.get("count_source"))
    row("Species", meta.get("species"))
    row("Gene-id kind", meta.get("gene_id_kind"))
    row("obs columns", len(meta.get("obs_columns", [])))
    row("var columns", len(meta.get("var_columns", [])))
    row("Layers", ", ".join(meta.get("layers", [])) or "—")
    row("Embeddings", f"{meta.get('n_embeddings')}: " + (", ".join(meta.get("embedding_keys", [])) or "—"))
    row("Spatial", "yes" if meta.get("has_spatial") else "no")
    embedded = json.dumps(meta, default=_jsonable)
    html = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>AnnData import summary</title></head><body>"
        "<h2>AnnData / 10x import summary</h2>"
        "<table style='font:14px/1.5 system-ui,sans-serif'>" + "".join(rows) + "</table>"
        f"<script type='application/json' id='dataset-metadata'>{embedded}</script>"
        "</body></html>"
    )
    dest.write_text(html)


# ───────────────────────────────── loaders ────────────────────────────────────

def _find_mtx_dir(root):
    for p in Path(root).rglob("matrix.mtx*"):
        return p.parent
    return None


def _trio_role(name):
    """Classify a 10x trio member by filename SUFFIX → ``matrix|barcodes|features``
    (``None`` for anything else). Suffix-based so a host-staged member keeps its role
    under an arbitrary prefix (the server binds a multi-file dataset's files as
    ``<ordinal>_<basename>`` — `0_matrix.mtx.gz`, `1_barcodes.tsv.gz`, …)."""
    n = name.lower()
    if n.endswith((".mtx", ".mtx.gz")):
        return "matrix"
    if n.endswith(("barcodes.tsv", "barcodes.tsv.gz")):
        return "barcodes"
    if n.endswith(("features.tsv", "features.tsv.gz", "genes.tsv", "genes.tsv.gz")):
        return "features"
    return None


def _read_head_line(path):
    op = gzip.open if str(path).lower().endswith(".gz") else open
    with op(path, "rt", errors="replace") as f:
        return f.readline().rstrip("\n")


def _copy_as(src, dest, want_gz):
    """Materialize `src` at `dest`, transcoding gzip↔plain when the destination's
    canonical name demands a different compression. Same-compression → a symlink
    (no byte copy: a real `matrix.mtx.gz` can be hundreds of MB)."""
    src_gz = str(src).lower().endswith(".gz")
    if src_gz == want_gz:
        try:
            os.symlink(os.path.abspath(str(src)), str(dest))
            return
        except OSError:
            pass  # fall through to a byte copy (no symlink support / cross-device)
        with open(src, "rb") as fin, open(dest, "wb") as fout:
            for chunk in iter(lambda: fin.read(1 << 20), b""):
                fout.write(chunk)
        return
    fin = gzip.open(src, "rb") if src_gz else open(src, "rb")
    fout = gzip.open(dest, "wb") if want_gz else open(dest, "wb")
    with fin, fout:
        for chunk in iter(lambda: fin.read(1 << 20), b""):
            fout.write(chunk)


def _stage_10x_trio(dirpath):
    """Return a directory holding the 10x trio under the CANONICAL names
    ``scanpy.read_10x_mtx`` requires, or ``None`` when `dirpath` already is one (or
    isn't a trio at all — let scanpy raise its own error).

    Why this exists: the server binds a multi-file (Manifest) dataset's files at
    ``/inputs/<ordinal>_<basename>``, so the canonical trio arrives as
    ``0_matrix.mtx.gz`` / ``1_barcodes.tsv.gz`` / ``2_features.tsv.gz`` — names
    ``read_10x_mtx`` cannot see (it globs the fixed `matrix.mtx[.gz]` /
    `barcodes.tsv[.gz]` / `features.tsv[.gz]` names). Everything is staged into a
    temp dir, symlinked when possible.

    scanpy couples LAYOUT to COMPRESSION (a gz dir is read as Cell Ranger v3 →
    3-column `features.tsv.gz`; a plain dir as legacy v2 → 2-column `genes.tsv`), so
    the staged layout is chosen from the gene file's actual COLUMN COUNT, and each
    member is transcoded to match."""
    dirpath = Path(dirpath)
    found = {}
    try:
        entries = sorted(p for p in dirpath.iterdir() if p.is_file())
    except OSError:
        return None
    for p in entries:
        role = _trio_role(p.name)
        if role is not None and role not in found:
            found[role] = p
    if len(found) < 3:
        return None  # not a trio (or an incomplete one) — not ours to fix

    n_cols = len(_read_head_line(found["features"]).split("\t"))
    v3 = n_cols >= 3
    names = (
        {"matrix": "matrix.mtx.gz", "barcodes": "barcodes.tsv.gz", "features": "features.tsv.gz"}
        if v3
        else {"matrix": "matrix.mtx", "barcodes": "barcodes.tsv", "features": "genes.tsv"}
    )
    # Already canonical + already consistently compressed → read in place.
    if all(found[role].name == names[role] for role in names):
        return None

    staged = Path(tempfile.mkdtemp(prefix="h5ad_import_10x_"))
    for role, canonical in names.items():
        _copy_as(found[role], staged / canonical, want_gz=canonical.endswith(".gz"))
    return staged


def _read_10x_dir(dirpath, sc):
    """``read_10x_mtx`` over a directory, canonicalizing the trio's member names first."""
    staged = _stage_10x_trio(dirpath)
    target = staged if staged is not None else Path(dirpath)
    return sc.read_10x_mtx(str(target), var_names="gene_symbols", make_unique=True, gex_only=False)


def _extract_archive(src):
    tmp = tempfile.mkdtemp(prefix="h5ad_import_")
    name = Path(src).name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(src) as zf:
            zf.extractall(tmp)  # noqa: S202 (trusted, host-materialized input)
    else:
        with tarfile.open(src) as tf:
            tf.extractall(tmp)  # noqa: S202
    return tmp


def load_anndata(src, file_type, sc, ad):
    """Robust read of a 10x matrix / h5ad into an in-memory AnnData. Handles:
    h5ad (dense/CSR/CSC, X=None→layers, legacy tolerance), 10x `.h5` (v2+v3), a
    10x mtx directory (matrix.mtx[.gz] + features/genes.tsv + barcodes.tsv), and a
    `.zip`/`.tar.gz` bundle wrapping such a directory. Returns
    ``(adata, source_format)`` where source_format ∈ {h5ad, 10x_h5, 10x_mtx}.
    Dispatch on schema where possible, extension as the fallback (RESEARCH §1.9)."""
    src = Path(src)
    ft = (file_type or "auto").lower()
    name = src.name.lower()

    def is_h5ad():
        return ft in ("h5ad", "anndata", "single-cell/anndata") or name.endswith(".h5ad")

    def is_archive():
        return ft in ("archive", "zip", "tar", "targz") or name.endswith((".zip", ".tar.gz", ".tgz", ".tar"))

    def is_10x_h5():
        return ft in ("10x_h5", "h5") or (name.endswith(".h5") and not name.endswith(".h5ad"))

    # An .h5 could be either h5ad or 10x — dispatch on the HDF5 root schema.
    if name.endswith(".h5") and not name.endswith(".h5ad") and ft in ("", "auto"):
        try:
            import h5py

            with h5py.File(src, "r") as f:
                enc = f.attrs.get("encoding-type")
                if enc in (b"anndata", "anndata"):
                    return ad.read_h5ad(src), "h5ad"
        except Exception:
            pass

    if is_h5ad():
        return ad.read_h5ad(src), "h5ad"
    if is_10x_h5():
        # B3 (INV-15, 10x multiome): `read_10x_h5(gex_only=False)` reads ALL feature types
        # (incl. `Peaks`) and PRESERVES the per-peak `var['interval']` coords embedded in the
        # 10x `.h5` feature metadata — those flow through the feature_types split + the ATAC
        # `extract_atac_linkage`. The FRAGMENTS file (`atac_fragments.tsv.gz` + `.tbi`) is a
        # SIBLING file NOT embedded in the `.h5`; muon auto-detects it only when it sits next
        # to the `.h5` on disk. A sandbox ingest receives a SINGLE uploaded file, so the
        # fragments linkage is DEFERRED for the bare-`.h5` path (it requires co-uploading the
        # fragments file as a supporting input — future wiring). Fragments ARE preserved on the
        # `.h5mu` path (which carries `uns['atac']['files']`, see read_h5mu_to_combined/B2).
        # `var_names_make_unique()` here is WITHIN this single combined 10x matrix (one measurement
        # of features), NOT a cross-modality rename — 10x var ids are already modality-partitioned
        # by `feature_types`, so this only disambiguates a genuine within-file duplicate.
        adata = sc.read_10x_h5(str(src), gex_only=False)
        adata.var_names_make_unique()
        return adata, "10x_h5"
    if src.is_dir():
        return _read_10x_dir(src, sc), "10x_mtx"
    if is_archive():
        tmp = _extract_archive(src)
        mtx_dir = _find_mtx_dir(tmp)
        if mtx_dir is None:
            raise RuntimeError(f"no 10x matrix dir (matrix.mtx*) found inside {src.name}")
        return _read_10x_dir(mtx_dir, sc), "10x_mtx"
    if name.endswith((".mtx", ".mtx.gz")):
        # The trio's SIBLINGS live next to the matrix — the server stages them as
        # `<ordinal>_<basename>`, so canonicalize before handing the dir to scanpy.
        return _read_10x_dir(src.parent, sc), "10x_mtx"
    # Last resort: try h5ad.
    return ad.read_h5ad(src), "h5ad"


# ───────────────────────────────── processor ─────────────────────────────────

def _looks_like_h5ad(src, file_type):
    """True iff `src` should be read directly as an .h5ad (so the streamed path runs
    on it) — by declared type, `.h5ad` extension, or an anndata-schema `.h5`."""
    ft = (file_type or "auto").lower()
    name = Path(src).name.lower()
    if ft in ("h5ad", "anndata", "single-cell/anndata") or name.endswith(".h5ad"):
        return True
    if name.endswith(".h5") and not name.endswith(".h5ad") and ft in ("", "auto"):
        try:
            import h5py

            with h5py.File(src, "r") as f:
                if f.attrs.get("encoding-type") in (b"anndata", "anndata"):
                    return True
        except Exception:
            pass
    return False


GROUPING_VAR_COLUMNS = ("modality",)
"""The var columns this importer emits that GROUP the entries of the genes axis (ITEM-53).

Named once, here, beside `read_h5mu_to_combined`'s `vf["modality"] = name` which is what
writes it — so the emit loop stamps `meta.groups_entries: true` on whichever columns this
package actually authored for that purpose, rather than the loop carrying a spelling of its
own that a rename would leave behind.

INV-16 — *"the column declares itself"*. The declaration goes on the COLUMN, and the viewer
asks an axis's columns *"does any of you group these entries?"*, so the viewer never learns
what a modality is: this constant is the only place in the system where the two words meet,
and it is inside the package that produces the data. A single-modality file has no such
column at all, which is why the viewer's collapse-when-trivial rule (one group ⇒ no headings)
is the ordinary case rather than a special one.
"""


def _make_unique_within(names):
    """Append `-1`/`-2`/… to duplicate names (mirrors anndata's `var_names_make_unique`), applied
    WITHIN ONE modality's var only (INV-17 / B5). A name legitimately reused ACROSS modalities
    (RNA `CD3` vs ADT `CD3`) is therefore NOT renamed — only a genuine within-modality collision is
    disambiguated. [research: MULTIMODAL_representation.md §(c) "Per-modality var"; cite_protein §6.6]"""
    seen: dict = {}
    out = []
    for n in (str(x) for x in names):
        if n in seen:
            seen[n] += 1
            out.append(f"{n}-{seen[n]}")
        else:
            seen[n] = 0
            out.append(n)
    return out


def read_h5mu_to_combined(src, ad, outputs_dir, params_dict):
    """Read a `.h5mu` MuData container (INV-9, ITEM-19) into a SINGLE combined AnnData staged as
    a temp `.h5ad`, so the existing per-modality `feature_types` split machinery ingests it.

    Correctness: modalities are read FIRST-CLASS + NAMED (`mm.read_h5mu_modalities`, mudata-free);
    barcodes are aligned by the UNION and the HARD-FAIL barcode guard is applied (INV-12/13,
    DEC-26 — an explicit `barcodeOverride` param proceeds on the INTERSECTION); RAW counts are
    verified per modality (INV-11) and never normalized; a `feature_types` var column carries each
    modality's provenance so the downstream split re-separates them (per-modality var domain, not a
    flattened matrix — the container structure is reconstructed from `feature_types`). Isotype rows
    are flagged (INV-14). Returns ``(h5ad_path, 'h5mu', staged_tmp, container_meta)``.
    [research: MULTIMODAL_representation.md §(a)/§(c); MULTIMODAL_cite_protein.md; MULTIMODAL_atac_spatial_formats.md §3.2]"""
    import anndata as _ad
    import pandas as pd
    import scipy.sparse as _sp

    mods, order = mm.read_h5mu_modalities(str(src))
    # Barcode alignment + guard (INV-12/13/DEC-26). Override proceeds on the intersection.
    override = bool(params_dict.get("barcodeOverride", False))
    align = mm.align_barcodes(
        {name: [str(x) for x in mods[name].obs_names] for name in order},
        allow_override=override,
    )
    axis = align.union if align.mode != "intersection-override" else align.intersection
    # Assemble the combined matrix over the SHARED cells axis. A cell absent in a modality gets
    # NO row (its columns stay zero only because it was never observed there — that is the sparse
    # ABSENCE, not a fabricated zero-fill value; the container obs is the union/intersection axis).
    parts, var_frames, is_iso = [], [], []
    combined_uns: dict = {}   # B2/INV-15: carry per-modality uns (esp. atac fragments) through.
    spatial_obsm = None       # B4/INV-16: union-aligned obsm['spatial'] coords.
    for name in order:
        a = mods[name]
        # Verify raw counts (INV-11) — refuse a normalized/scaled modality written as raw.
        X = a.X
        vals = X.data if _sp.issparse(X) else np.asarray(X).ravel()
        mm.assert_not_normalized(name, vals)
        ridx = align.row_index[name]  # result-cell -> source row (-1 = absent)
        Xc = X.tocsr() if _sp.issparse(X) else _sp.csr_matrix(np.asarray(X))
        rows = []
        for j in ridx:
            rows.append(Xc[int(j)] if j >= 0 else _sp.csr_matrix((1, Xc.shape[1]), dtype=Xc.dtype))
        parts.append(_sp.vstack(rows).tocsr() if rows else _sp.csr_matrix((0, Xc.shape[1])))
        vf = a.var.copy()
        # INV-17 (B5): `feature_name` is the AUTHORITATIVE per-modality label — uniqueness enforced
        # WITHIN this modality only, NEVER across modalities. So a name reused across modalities
        # (RNA `CD3` vs ADT `CD3`) keeps `feature_name == 'CD3'` for BOTH (no `CD3-1` mislabel), and
        # `main()` SERVES `feature_name` (see the genes_index emit). The combined matrix INDEX is made
        # globally unique afterwards ONLY for the staged `.h5ad`'s var-index requirement (storage
        # detail), never surfaced as the modality's feature label. [research: MULTIMODAL_representation.md §(c)
        # "Per-modality var"; cite_protein §6.6]
        orig_names = [str(x) for x in vf.index]
        vf["feature_name"] = _make_unique_within(orig_names)
        if "feature_types" not in vf.columns:
            vf["feature_types"] = name  # provenance so the split re-separates modalities
        vf["modality"] = name
        # Isotype flag for a protein modality (INV-14) — TAG, never drop.
        iso = mm.detect_isotype_controls(orig_names)
        vf["is_isotype_control"] = iso
        var_frames.append(vf)
        is_iso.append(iso)
        # B2/INV-15: preserve each modality's uns forward so the non-derivable ATAC fragments
        # linkage (`mods['atac'].uns['atac']['files']`) + spatial `uns['spatial']` survive the
        # combine (main()'s extract_atac_linkage / extract_spatial read them off the staged h5ad).
        # Shallow-merge; the modality-specific keys ('atac'/'spatial') don't collide across mods.
        m_uns = getattr(a, "uns", None)
        if hasattr(m_uns, "items"):
            for k, v in m_uns.items():
                combined_uns.setdefault(str(k), v)
        # B4/INV-16: union-align this modality's obsm['spatial'] coords onto the shared axis (an
        # absent cell → NaN, never a fabricated 0). main()'s extract_spatial then finds 'spatial'.
        m_obsm = getattr(a, "obsm", None)
        if spatial_obsm is None and m_obsm is not None and "spatial" in m_obsm:
            coords = np.asarray(m_obsm["spatial"], dtype=float)
            ncoord = int(coords.shape[1]) if coords.ndim == 2 else 1
            aligned = np.full((len(axis), ncoord), np.nan, dtype=float)
            for out_i, src_row in enumerate(ridx):
                if src_row >= 0:
                    aligned[out_i] = coords[int(src_row)]
            spatial_obsm = aligned
    Xall = _sp.hstack(parts).tocsr() if parts else _sp.csr_matrix((len(axis), 0))
    var_all = pd.concat(var_frames, axis=0)
    var_all.index = [str(x) for x in var_all.index]
    combined = _ad.AnnData(
        X=Xall,
        obs=pd.DataFrame(index=[str(b) for b in axis]),
        var=var_all,
    )
    # Make the combined INDEX globally unique for the staged `.h5ad`'s key requirement ONLY — this
    # is a storage detail (a cross-modality reused name becomes `CD3`/`CD3-1` in the index). The
    # TRUE per-modality label lives in `var['feature_name']` (within-modality-unique, B5/INV-17) and
    # is what `main()` serves — so the science NEVER sees the storage-disambiguated `CD3-1`.
    combined.var_names_make_unique()
    if combined_uns:
        combined.uns = combined_uns
    if spatial_obsm is not None:
        combined.obsm["spatial"] = spatial_obsm
    container_meta = {
        "container": "MuData",
        "modalities": list(order),
        "barcode_mode": align.mode,
        "n_union": align.n_union,
        "n_intersection": len(align.intersection),
        "isotype_controls": int(sum(int(m.sum()) for m in is_iso)),
    }
    fd, tmp_path = tempfile.mkstemp(prefix=".stage-h5mu-", suffix=".h5ad", dir=str(outputs_dir))
    os.close(fd)
    tmp = Path(tmp_path)
    combined.write_h5ad(tmp)
    del combined
    return tmp, "h5mu", tmp, container_meta


def ensure_h5ad(src, file_type, ad, outputs_dir, params_dict=None):
    """Resolve any supported input to a STREAMABLE `.h5ad` path — returns
    ``(h5ad_path, source_format, staged_tmp_or_None, container_meta_or_None)``. An `.h5ad` (or
    anndata-schema `.h5`) passes through UNTOUCHED so the backed/streamed path reads it directly.
    A `.h5mu` MuData container is read multi-modally (barcode-guarded) into a combined temp `.h5ad`
    (INV-9..14). A 10x `.h5` / mtx dir / archive is read ONCE (scanpy, in-memory) and re-serialized
    to a temp `.h5ad` so the SAME streamed transpose runs. 10x inputs are
    single-sample scale; a future manual `.mtx` coordinate-streamer removes even that
    one in-memory pass. The temp is written INSIDE `outputs_dir` (the ONLY
    guaranteed-writable mount — the sandbox rootfs `/` and `outputs_dir.parent` are
    READ-ONLY) and returned so the caller unlinks it after the outputs are written."""
    if params_dict is None:
        params_dict = {}
    # `.h5mu` MuData container → multi-modal read + barcode guard (Slice 6, ITEM-19).
    if mm.is_h5mu(src):
        return read_h5mu_to_combined(src, ad, outputs_dir, params_dict)
    if _looks_like_h5ad(src, file_type):
        return Path(src), "h5ad", None, None
    import scanpy as sc  # DEFERRED: only the 10x/archive path needs scanpy (heavy import)

    adata, fmt = load_anndata(src, file_type, sc, ad)  # non-h5ad → in-memory read
    fd, tmp_path = tempfile.mkstemp(prefix=".stage-", suffix=".h5ad", dir=str(outputs_dir))
    os.close(fd)
    tmp = Path(tmp_path)
    adata.write_h5ad(tmp)
    del adata
    return tmp, fmt, tmp, None


def _emit_spatial_output(entries, outputs_dir, spatial_plan):
    """INV-16 (B4): emit the aligned spatial trio (coords_key + image + affine) as a standalone
    artifact WHENEVER a spatial library/coords are present — for a SINGLE-modal Visium `.h5ad`
    (one feature_type → the else branch) as well as a multi-modal container. Routes into the
    EXISTING `imageUnderlay()` data source (no new viz kind). Returns True iff emitted.
    [research: MULTIMODAL_atac_spatial_formats.md §2.2-3; VIZ_REQUIREMENTS.md §4g]"""
    if not spatial_plan:
        return False
    (outputs_dir / "spatial.json").write_text(json.dumps(spatial_plan, default=_jsonable))
    entries.append(
        output_entry("spatial", DT_DATA, "spatial.json", "artifact",
                     label="Spatial coords + image affine", meta=spatial_plan,
                     structure=txr_columns.opaque("application/json"))
    )
    return True


def main():
    import anndata as ad

    inputs_dir, outputs_dir = io_dirs()
    p = params(inputs_dir)
    slots = load_inputs_index(inputs_dir)
    src = resolve_slot(
        slots,
        inputs_dir,
        prefer=("dataset", "anndata", "matrix", "expression", "input", "h5ad"),
        # `*matrix.mtx*` (not `matrix.mtx*`): the server stages a multi-file dataset's
        # members as `<ordinal>_<basename>`, so the matrix arrives as `0_matrix.mtx.gz`.
        patterns=("*.h5ad", "*.h5", "*.zip", "*.tar.gz", "*.tgz", "*matrix.mtx*"),
    )
    if src is None:
        print("h5ad_import: no h5ad/10x input found under /inputs", file=sys.stderr)
        sys.exit(2)

    # ── read (resolve to a STREAMABLE .h5ad; NEVER full-load the matrix) ───────
    milestone("read", "started")
    progress("reading", 5, f"read {src.name}")
    src_h5ad, source_format, _staged_tmp, _container_meta = ensure_h5ad(
        src, p.get("fileType"), ad, outputs_dir, params_dict=p
    )
    # BACKED open: obs/var/obsm/uns/layers metadata load; X stays on disk (h5py-backed),
    # so this + everything below is bounded by metadata, not the matrix.
    adata = ad.read_h5ad(src_h5ad, backed="r")
    # Uniqueness is a recorded FINDING (RESEARCH §1.4) — do NOT silently mutate.
    obs_names_unique = bool(adata.obs_names.is_unique)
    var_names_unique = bool(adata.var_names.is_unique)
    n_obs, n_vars = int(adata.n_obs), int(adata.n_vars)
    milestone("read", "done", {"cells": n_obs, "genes": n_vars})
    progress("read", 20, f"{n_obs} cells x {n_vars} genes")

    # ── detect-counts — h5py STREAMING scan (chunked; never loads a matrix, DEC-11) ──
    milestone("detect-counts", "started")
    progress("detect", 30, "counts-source detection")
    import h5py

    with h5py.File(src_h5ad, "r") as _f:
        (count_source, _count_path, x_state, x_present,
         x_layer, nnz, x_dtype, x_path) = detect_counts_streaming(_f)
    # X-absent → a layer was promoted; record which one as a finding, never force-cast.
    x_from_layer = None
    if x_layer is not None:
        x_from_layer = (
            count_source
            if (count_source or "").startswith("layers")
            else f"layers:{x_layer}"
        )
    milestone("detect-counts", "done", {"x_state": x_state, "count_source": count_source})
    density = round(nnz / (n_obs * n_vars), 8) if (n_obs and n_vars) else 0.0

    # ── convert — the COUNTING pass of the out-of-core transpose (ITEM-27) ──────
    # There is no intermediate store any more. `txr_csc` reads the h5ad matrix node
    # directly and counts each column's stored values; the counts become `indptr` and
    # are REUSED across every per-modality split below, so a multi-modal file is
    # histogrammed once rather than once per modality.
    milestone("convert", "started")
    progress("converting", 45, "counting the matrix (streamed)")
    entries = []
    # ── the two ROW SPACES this run writes into, by IDENTITY (ITEM-15) ────────────
    # Computed HERE, before the first artifact is emitted, because `aligned_to` is a
    # declaration each artifact carries at write time and the embeddings below are written
    # long before the axis-index columns that ARE the axes. It is the digest of the same
    # ordered key sequence those columns store — `axis_key_digest` shares their coercion —
    # and the equality is ASSERTED where they are written rather than assumed here.
    cells_keys, genes_keys = axis_key_series(adata)
    # The COERCED key strings, once — the sequence the key member will actually store. Both
    # the digest below and the `derived_from` evidence beside it read the SAME list, so the
    # writer's refusal compares two things that cannot drift apart. Digesting the raw series
    # here would agree with the stored one on ordinary data and disagree silently on anything
    # the writer had to coerce.
    axis_keys = {
        "cells": txr_columns.axis_key_sequence(cells_keys),
        "genes": txr_columns.axis_key_sequence(genes_keys),
    }
    aligned_to = {
        "cells": txr_columns.axis_key_digest(cells_keys),
        "genes": txr_columns.axis_key_digest(genes_keys),
    }
    # ── WHICH ROWS, not just WHICH AXIS (ITEM-2's producer side) ─────────────────────────
    #
    # Everything this run emits describes EVERY entry of the axis it declares — an import
    # re-emits the file, it does not select out of it — so the membership is the `full` case
    # for every artifact below. That is the cheapest declaration in the vocabulary and the
    # commonest one, and declaring it is what turns the consumer's *"describes N of M rows"*
    # from a capability into a sentence a real project prints: a `full` membership carries
    # `n_members`, which is the DENOMINATOR the figure is measured against, and the legacy
    # scalar `aligned_to` (which is read as `full` with no count) does not.
    #
    # `members: None` says the whole axis. `derived_from` is the evidence the writer digests
    # and compares against `aligned_to`; it is REQUIRED, and it is what makes this a checked
    # statement rather than a repeated claim.
    membership_of = {
        axis: {"aligned_to": aligned_to[axis], "derived_from": axis_keys[axis], "members": None}
        for axis in ("cells", "genes")
    }
    x_counts = None
    x_shape = None
    if x_present and x_path is not None:
        with h5py.File(src_h5ad, "r") as _f:
            _src = source_for_h5_matrix(_f[x_path])
            x_shape = _src.shape
            x_counts = _src.column_counts()
    milestone("convert", "done", {
        "source": x_path, "cells": n_obs,
        "columns": int(x_shape[1]) if x_shape else 0, "nnz": int(nnz),
    })

    # ── CSC gene-expression matrix — Zarr, written by the streaming transpose.
    #    Emitted PER-MODALITY when var['feature_types'] has >1 modality (the real
    #    per-modality split, not just a count); one artifact otherwise. Since ITEM-27
    #    deleted the SOMA store this IS the count matrix on disk. ──
    # INV-16 (B4): the spatial trio is computed ONCE, independent of modality count, so a
    # single-feature-type Visium `.h5ad` (which falls to the single-modal else branch below)
    # ALSO emits coords + image + affine — not just the multi-modal branch.
    spatial_plan = mm.extract_spatial(adata.uns, list(adata.obsm.keys()))

    # The h5ad stays OPEN across every modality: each split is another banded pass over
    # the SAME matrix node, sharing the one column histogram computed above.
    x_file = h5py.File(src_h5ad, "r") if (x_present and x_path is not None) else None
    x_source = source_for_h5_matrix(x_file[x_path]) if x_file is not None else None
    if x_source is not None:
        ft_col = (
            adata.var["feature_types"].astype(str)
            if "feature_types" in adata.var.columns
            # A promoted `raw/X` can be WIDER than `adata.var`, in which case the var
            # frame cannot index the matrix's columns and a per-modality split would
            # silently mis-assign features. One artifact, and the width is recorded.
            and int(x_source.shape[1]) == n_vars
            else None
        )
        modalities = sorted(ft_col.unique().tolist()) if ft_col is not None else []
        if len(modalities) > 1:
            # MULTI-MODAL (10x combined OR `.h5mu`): emit each modality as a FIRST-CLASS,
            # per-modality-typed output under a CONTAINER (INV-7/8/9) — RNA is NOT privileged
            # (each modality's datatype via `mm.modality_datatype`), none dropped, none folded.
            # The container output links them (INV-9: a container of `.mod` matrices, not a
            # flattened matrix). [research: MULTIMODAL_representation.md §(b); cite_protein §1.2]
            iso_col = (
                adata.var["is_isotype_control"].astype(bool).values
                if "is_isotype_control" in adata.var.columns
                else None
            )
            modality_links = []
            for ft_string in modalities:
                mod_key = mm.classify_feature_type(ft_string)
                cols = np.where(ft_col.values == ft_string)[0]
                rel = f"expression/{sanitize_col_name(mod_key)}"
                csc_structure, ncols, csc_nnz = write_expression_csc(
                    x_source, outputs_dir, rel, columns=cols, counts=x_counts,
                    # The SAME key `meta` below carries — one fact, two channels, and only
                    # this one crosses into a sandbox with the staged bytes.
                    modality=mod_key,
                )
                dt_id = mm.modality_datatype(mod_key)
                meta = {
                    "modality": mod_key,
                    "measurement": mm.measurement_name(mod_key),
                    "feature_types": str(ft_string),  # raw 10x provenance (INV-17)
                    "n_vars": ncols,
                    "nnz": csc_nnz,
                    # The SOMA store used to be the dtype-exact archive beside this
                    # projection; it is gone, so the SOURCE width is recorded here
                    # rather than lost in the float32 the store declares (ITEM-27).
                    "source_dtype": (str(x_dtype) if x_dtype is not None else None),
                    "x_state": x_state,
                    "count_source": count_source,
                }
                # INV-14: count isotype controls retained in this (protein) modality. Flag comes
                # from the `.h5mu` path's `is_isotype_control` var column, else computed inline
                # from the modality's var names (heuristic — surfaced, never used to DROP).
                if mod_key in ("prot", "adt"):
                    if iso_col is not None:
                        iso_here = iso_col[cols]
                    else:
                        iso_here = mm.detect_isotype_controls([str(adata.var_names[i]) for i in cols])
                    meta["isotype_controls"] = int(np.asarray(iso_here).sum())
                # INV-15: ATAC peak modality carries var['interval'] coords + fragments linkage.
                if mod_key == "atac":
                    meta["atac"] = mm.extract_atac_linkage(adata.var.iloc[cols], adata.uns)
                entries.append(
                    output_entry(
                        f"expression:{mod_key}", (dt_id, DT_MODALITY_LAYOUT), rel, "artifact",
                        label=f"{mod_key} ({ft_string})",
                        meta=meta,
                        structure=csc_structure,
                    )
                )
                modality_links.append({"modality": mod_key, "datatype": dt_id, "output": f"expression:{mod_key}"})
            # The multi-modal CONTAINER (INV-9): links the per-modality matrices + shared cells axis.
            container = {
                "container": "MuData",
                "modalities": [m["modality"] for m in modality_links],
                "links": modality_links,
                "shared_cells": int(n_obs),
                "cells_index": "cells_index",  # the shared obs axis (union) served once
            }
            if _container_meta:
                container.update({k: _container_meta[k] for k in ("barcode_mode", "n_union", "n_intersection") if k in _container_meta})
            if spatial_plan:
                container["spatial"] = spatial_plan
            # B6 (INV-8/9): surface the FAITHFUL MuData→measurement mapping this ingest
            # computes (modality→measurement, one shared obs UNION domain), via the shared
            # `plan_soma_write` kernel — so the machinery is a LIVE production caller, not
            # test-only dead code. It is now a NAMING map only: ITEM-27 deleted the store it
            # was once a write plan for, and the physical data plane is the per-modality CSC
            # Zarr above (which is a genuine per-modality split, not a flattened matrix). It
            # is kept because `$data.modality.<name>` still resolves through the measurement
            # label. [research: MULTIMODAL_representation.md §(b)]
            shared_cells = [str(b) for b in adata.obs_names]
            _plan = mm.plan_soma_write(
                mm.BarcodeAlignment(
                    union=shared_cells, intersection=shared_cells, present_mask={}, mode="identical",
                ),
                [m["modality"] for m in modality_links],
            )
            container["measurement_plan"] = {
                "measurements": _plan.measurements,
                "measurement_of": _plan.modality_of,
                "raw_layer": _plan.raw_layer,
                "physical_write": "per-modality CSC Zarr; no intermediate store (ITEM-27)",
            }
            (outputs_dir / "container.json").write_text(json.dumps(container, default=_jsonable))
            entries.append(
                output_entry(
                    "multimodal-container", DT_MULTIMODAL_CONTAINER, "container.json", "artifact",
                    label="Multi-modal container", meta=container,
                    structure=txr_columns.opaque("application/json"),
                )
            )
            milestone("expression", "done", {"modalities": len(modalities), "split": [m["modality"] for m in modality_links]})
        else:
            csc_structure, ncols, csc_nnz = write_expression_csc(
                x_source, outputs_dir, "expression", counts=x_counts
            )
            entries.append(
                output_entry(
                    "expression", DT_EXPRESSION, "expression", "artifact",
                    label="Expression (CSC)",
                    meta={"n_vars": ncols, "nnz": csc_nnz,
                          # See the per-modality note: with the SOMA archive deleted,
                          # the source dtype survives HERE or nowhere.
                          "source_dtype": (str(x_dtype) if x_dtype is not None else None),
                          "x_state": x_state, "count_source": count_source},
                    structure=csc_structure,
                )
            )
            milestone("expression", "done", {"n_vars": ncols, "nnz": csc_nnz})
    if x_file is not None:
        x_file.close()

    # INV-16 (B4): emit the spatial trio for BOTH branches — a single-modal Visium `.h5ad` (the
    # common case) yields coords + image + affine here, not only a multi-modal container.
    if _emit_spatial_output(entries, outputs_dir, spatial_plan):
        milestone("spatial", "done", {"library": spatial_plan.get("library"), "image_key": spatial_plan.get("image_key")})

    # ── embeddings (0..N; one per ≥2-D numeric obsm key, spatial excluded) ─────
    milestone("embeddings", "started")
    progress("embeddings", 62, "harvest obsm embeddings")
    emb_keys = []
    emb_labels = []
    obsm_descriptors = []
    for key in list(adata.obsm.keys()):
        arr = adata.obsm[key]
        role = obsm_role(key, arr, n_obs)
        a = np.asarray(arr.todense() if sp.issparse(arr) else arr)
        n_dims = int(a.shape[1]) if a.ndim >= 2 else 1
        obsm_descriptors.append({"key": str(key), "n_dims": n_dims, "role": role})
        if role != "embedding":
            continue
        label, method = embedding_label_method(str(key))
        rel = f"embeddings/{sanitize_col_name(key)}.zarr"
        emb_structure, emb_meta = write_embedding(outputs_dir, rel, arr, method=method,
                                                  aligned_to=aligned_to["cells"], name=label,
                                                  membership=membership_of["cells"])
        emb_meta["source_key"] = str(key)
        entries.append(
            output_entry(
                f"embedding:{key}", DT_EMBEDDING, rel, "artifact",
                label=label, meta=emb_meta, structure=emb_structure,
            )
        )
        emb_keys.append(str(key))
        emb_labels.append(label)
    milestone("embeddings", "done", {"count": len(emb_keys), "names": emb_labels})

    # ── metadata (obs + var columns → metadata-columns; harvested dataset summary) ─
    milestone("metadata", "started")
    progress("metadata", 78, "obs + var columns + harvested summary")
    import pandas as pd

    # ── per-axis ENTITY-INDEX columns (ITEM-10 — the shared axis-index contract) ──
    #   Per DECLARED axis, ONE metadata-column whose VALUES ARE the axis's entity keys:
    #     cells → barcodes (`adata.obs_names`), genes → gene ids (`adata.var_names`).
    #   Contract (relied on by the coordinator's Rust + the annotation-integrate
    #   converter, DEC-7): the entry is `axis`-tagged and its `meta` is the compact
    #   colsummary PLUS `is_axis_index: true`. THAT PAIR IS THE CONTRACT — the server
    #   resolves an axis index with `meta @> '{"is_axis_index": true}'` AND
    #   `structure->>'axis'` (`list_dataset_axis_index_candidates`), and the integrate
    #   converter reads the axis out of `structure.axis`. The output `id` happens to be
    #   spelled `"<axis>_index"` and NOTHING keys on that spelling.
    #
    #   This comment said the `id` was the contract key and that the shape was
    #   "load-bearing — do not rename" until 2026-07-29. It was false, and it was worse
    #   than false: INV-3 is that an axis IS its key artifact, identified by
    #   `content_hash`, with its name only a label — so a comment instructing the next
    #   author to PRESERVE a name-as-contract is how that defect kept coming back (it was
    #   re-fixed in seven layers). `annotation_integrate._axis_name_from_index`, which
    #   derived the axis by stripping `_index` off a label, was one of those returns.
    #   The integrate converter aligns against this index artifact's Zarr STORE, not a
    #   single file (ITEM-26).
    #
    #   INV-3/ITEM-19: `holds_axis_keys=True` is the OTHER half. `meta.is_axis_index`
    #   says this artifact IS the axis; `holds_axis_keys` makes the writer declare WHICH
    #   member carries the axis's ordered keys and WHAT they digest to
    #   (`structure.key` + `structure.key_sequence_digest`). Without it a key artifact
    #   arrives at the catalog with nothing identifying it but its label, which is what
    #   INV-3 forbids — and the framework gate's cross-artifact alignment check has no
    #   key member to run over, so the alignment guarantee never executes either.
    # B5/INV-17 and the two axes' key sequences: `axis_key_series` is the ONE definition,
    # already read above to derive `aligned_to` before the first artifact was written.
    genes_series = genes_keys
    for axis_name, out_id, series in (
        ("cells", "cells_index", cells_keys),
        ("genes", "genes_index", genes_series),
    ):
        rel = f"metadata/{out_id}.zarr"
        structure, stored = write_metadata_column(outputs_dir, rel, out_id, series, axis=axis_name,
                                                  holds_axis_keys=True)
        # THE ASSERTION THAT MAKES `aligned_to` SAFE (ITEM-15). Every other artifact in this
        # run declared its alignment from `axis_key_digest`, ANTICIPATING what this key
        # artifact would store; this is the one point where the anticipation meets the
        # authority. They can only differ if the writer's coercion changed under
        # `axis_key_digest`, and then every declaration already emitted names a row space
        # that does not exist — so the run fails here rather than shipping a project whose
        # columns are all quietly unofferable.
        if structure["key_sequence_digest"] != aligned_to[axis_name]:
            raise RuntimeError(
                f"the {axis_name!r} axis stored a key sequence digesting to "
                f"{structure['key_sequence_digest'][:12]}… but this run already declared "
                f"aligned_to={aligned_to[axis_name][:12]}… on its other artifacts — "
                "`txr_columns.axis_key_digest` no longer anticipates what the writer stores"
            )
        summary = summarize_column(series, out_id)
        summary["is_axis_index"] = True
        summary["stored"] = stored
        entries.append(
            output_entry(out_id, DT_METADATA_COLUMN, rel, "artifact",
                         label=out_id, axis=axis_name, meta=summary, structure=structure)
        )

    # The cell-id (barcode) index is ALSO emitted under its historical id (genuine
    # per-cell metadata; kept for back-compat — `cells_index` above is the canonical
    # cells-axis index). Every metadata-column now carries the compact viz summary
    # (ITEM-21 / DEC-25) in its `meta` so viz reads legend/range without the body.
    cell_id_series = pd.Series(adata.obs_names.astype(str))
    # Its values ARE the cells axis's keys (same `obs_names` the `cells_index` above is
    # written from), so it declares them — `holds_axis_keys` is a claim about the VALUES,
    # not about being the axis, and this column deliberately carries no `is_axis_index`.
    # Declaring it is what makes ITEM-19's CROSS-artifact check bite on a real run: two
    # artifacts on the `cells` axis both naming a key member must digest to the same
    # ordered sequence, so the day these two stop agreeing the run fails instead of
    # shipping two silently different cell orders under one label.
    # No `aligned_to`: this column CARRIES the cells axis's keys, so it declares them
    # (`holds_axis_keys=True`) and is aligned to itself. Declaring both would be the
    # contradiction `Table.close` refuses — and the digest it emits is what the gate's
    # cross-artifact check compares against anyway.
    structure, stored = write_metadata_column(
        outputs_dir, "metadata/cell_id.zarr", "cell_id", cell_id_series, "cells",
        holds_axis_keys=True)
    cell_id_summary = summarize_column(cell_id_series, "cell_id")
    cell_id_summary["stored"] = stored
    entries.append(
        output_entry("metadata-column:cell_id", DT_METADATA_COLUMN, "metadata/cell_id.zarr", "artifact",
                     label="cell_id", axis="cells", meta=cell_id_summary, structure=structure)
    )
    obs_descriptors = []
    for col in list(adata.obs.columns):
        rel = f"metadata/{sanitize_col_name(col)}.zarr"
        structure, stored = write_metadata_column(outputs_dir, rel, str(col), adata.obs[col],
                                                  "cells", aligned_to=aligned_to["cells"],
                                                  membership=membership_of["cells"])
        summary = summarize_column(adata.obs[col], str(col))
        summary["stored"] = stored
        entries.append(
            output_entry(f"metadata-column:{col}", DT_METADATA_COLUMN, rel, "artifact",
                         label=str(col), axis="cells", meta=summary, structure=structure)
        )
        obs_descriptors.append(col_descriptor(col, adata.obs[col]))

    # ── per-GENE (var) annotation columns ─────────────────────────────────────
    # The `var` frame's VALUES — `gene_ids`, `feature_types`, `highly_variable`, … —
    # used to survive only inside the SOMA store, so ITEM-27's deletion would have
    # silently dropped every gene annotation while keeping the cell ones. They are the
    # same kind of thing as an obs column, so they are emitted the same way, tagged with
    # the `genes` axis. NAMESPACED under `metadata/var/` because an obs column and a var
    # column can share a name (`n_counts` is the classic) and would otherwise collide on
    # one path. (`layers` / `raw` / `uns` / `obsp` do NOT survive the store's deletion —
    # that is the design's accepted scope, and `dataset-metadata` records that they
    # existed.)
    var_descriptors = []
    for col in list(adata.var.columns):
        rel = f"metadata/var/{sanitize_col_name(col)}.zarr"
        structure, stored = write_metadata_column(
            outputs_dir, rel, str(col), adata.var[col], axis="genes",
            aligned_to=aligned_to["genes"], membership=membership_of["genes"])
        summary = summarize_column(adata.var[col], str(col))
        summary["stored"] = stored
        # ITEM-53 — the column says what it is FOR. One declaration, three uses downstream
        # (group headings, the per-row qualifier when two entries share a displayed name,
        # and the emitted cell title); the viewer resolves whichever column says yes and
        # never learns what the values mean.
        if str(col) in GROUPING_VAR_COLUMNS:
            summary["groups_entries"] = True
        entries.append(
            output_entry(f"metadata-column:var:{col}", DT_METADATA_COLUMN, rel, "artifact",
                         label=str(col), axis="genes", meta=summary, structure=structure)
        )
        var_descriptors.append(col_descriptor(col, adata.var[col]))

    # feature_types breakdown (10x multi-modal; RESEARCH §1.11).
    feature_types = None
    if "feature_types" in adata.var.columns:
        vc = adata.var["feature_types"].astype(str).value_counts()
        feature_types = {str(k): int(v) for k, v in vc.items()}

    has_spatial = ("spatial" in adata.obsm) or ("spatial" in adata.uns)
    spatial_libraries = None
    if isinstance(adata.uns.get("spatial"), dict):
        spatial_libraries = [str(k) for k in adata.uns["spatial"].keys()]

    raw_n_vars = int(adata.raw.n_vars) if adata.raw is not None else None

    dataset_metadata = {
        "source_format": source_format,
        "n_obs": n_obs,
        "n_vars": n_vars,
        "nnz": int(nnz),
        "density": float(density),
        "x_state": x_state,
        "count_source": count_source,
        "x_from_layer": x_from_layer,
        "has_raw": adata.raw is not None,
        "raw_n_vars": raw_n_vars,
        "obs_columns": obs_descriptors,
        "var_columns": var_descriptors,
        "layers": [str(k) for k in adata.layers.keys()],
        "obsm": obsm_descriptors,
        "uns_keys": [str(k) for k in adata.uns.keys()],
        "gene_id_kind": detect_gene_id_kind(adata),
        "has_gene_ids": "gene_ids" in adata.var.columns,
        "species": detect_species(adata),
        "feature_types": feature_types,
        "obs_names_unique": obs_names_unique,
        "var_names_unique": var_names_unique,
        "uniqueness": {"obs_names_unique": obs_names_unique, "var_names_unique": var_names_unique},
        "n_embeddings": len(emb_keys),
        "embedding_keys": emb_keys,
        "has_spatial": bool(has_spatial),
        "spatial_libraries": spatial_libraries,
    }
    (outputs_dir / "dataset-metadata.json").write_text(
        json.dumps(dataset_metadata, indent=2, default=_jsonable)
    )
    entries.append(
        # HIDDEN (ITEM-20): this JSON is harvested into `datasets.metadata` by the
        # finalize hook, so it must not also clutter the catalog as a first-class
        # artifact — still persisted + fetchable by id, just filtered from the list.
        output_entry("dataset-metadata", DT_DATA, "dataset-metadata.json", "intermediate",
                     label="Dataset metadata", hidden=True,
                     structure=txr_columns.opaque("application/json"))
    )
    milestone("metadata", "done", {"obs_columns": len(obs_descriptors),
                                  "var_columns": len(var_descriptors)})

    # ── summarize (inspect report + manifest) ──────────────────────────────────
    milestone("summarize", "started")
    progress("summarize", 92, "inspect report")
    write_inspect_html(outputs_dir, "inspect.html", dataset_metadata)
    entries.append(
        output_entry("inspect", DT_REPORT_HTML, "inspect.html", "intermediate",
                     label="Import summary", structure=txr_columns.opaque("text/html"))
    )

    # Drop the staged 10x→h5ad temp (if any) so it isn't collected as an artifact
    # or left in the workspace. Best-effort; /outputs is discarded on failure anyway.
    if _staged_tmp is not None:
        _staged_tmp.unlink(missing_ok=True)

    write_manifest(outputs_dir, entries)
    milestone("summarize", "done", {"outputs": len(entries), "embeddings": len(emb_keys)})
    progress("done", 100, f"{len(entries)} outputs")
    print(
        f"h5ad_import: {source_format} {n_obs}x{n_vars} "
        f"(x_state={x_state}, count_source={count_source}) "
        f"→ {len(entries)} outputs, {len(emb_keys)} embeddings",
        file=sys.stderr,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — surface a clear job failure (RESEARCH §2.5)
        # Fail the in-flight milestone so the biologist stepper shows WHERE it broke.
        cur = _CURRENT_MILESTONE[0]
        if cur is not None:
            milestone(cur, "failed", {"error": str(e)})
        print(f"h5ad_import: FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
