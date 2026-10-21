#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate the `clustering` analyses stand on (Stage-A ITEM-2/6/7/9).

`clustering.cluster` (and, in Stage B, the descriptive-markers pass) share their whole
compute plumbing — the thread + NUMBA_CPU_NAME pin, the `/inputs`/`/outputs` wire
contract, slot resolution, the staged-artifact reader, the ceiling gate, `progress`/`fail`,
the manifest writer and the `report/qc` shape — so it lives ONCE here rather than in
drifting copies. The entry declares `helpers: [compute/_shared.py]` so the runner stages
this sibling into `/code` alongside the entry, where `import _shared` resolves off
`sys.path[0]`. The suites reach it the same way (the entry runs as a script).

INV-8 — the determinism environment is pinned at the very TOP of this module, BEFORE the
first `import numpy`, so every consumer that imports `_shared` first has the numeric stack
single-threaded and machine-identity-fixed before numpy/scipy/scanpy/numba/leidenalg ever
load. The server pins three (`OMP_/OPENBLAS_/MKL_`, `sandbox/sandbox.rs`); the other three
(`NUMEXPR_/VECLIB_/NUMBA_`) are the processor's to pin — pynndescent/UMAP/numba are
numba-parallel and, unpinned, both burn the CPU-seconds budget AND make the kNN /
Leiden labels non-reproducible run-to-run. `NUMBA_CPU_NAME=generic` fixes the numba
codegen target so two DIFFERENT machines emit the same code path (scanpy #2014). Every pin
is `setdefault`, so a genuine server-set value is never overridden.
"""
import os

# ── INV-8: pin the determinism environment before numpy/numba load ────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")
# The cross-machine codegen identity (scanpy #2014 / doc-10 §A.9): without it numba
# specialises to the build host's CPU and a re-run on a different microarchitecture can
# reorder floating-point reductions, moving a borderline cell across a cluster boundary.
os.environ.setdefault("NUMBA_CPU_NAME", "generic")


def resolved_determinism_env():
    """The determinism env as this process ACTUALLY sees it AFTER the pin — read out of the
    running compute (recorded into the report) so a test proves the child env, never the
    source text (INV-8 / TEST-8). The six thread vars plus `NUMBA_CPU_NAME`."""
    out = {v: os.environ.get(v) for v in THREAD_ENV_VARS}
    out["NUMBA_CPU_NAME"] = os.environ.get("NUMBA_CPU_NAME")
    return out


import cyto_deps
import json
import sys
from pathlib import Path

import numpy as np


# ── datatypes emitted (id, layout) — the SHAPE ingest validates ───────────────────
# A cluster label IS a categorical per-cell column (owner DEC-9(c) / INV-2): it is a
# `metadata-column`, NOT an exclusive `clustering` datatype the colour-by cannot read.
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")


# ── the Normal-class envelope (INV-10 / DEC-8) ─────────────────────────────────────
#
# Clustering's ceiling is the deployment's ALREADY-configurable sandbox ceiling (DEC-8);
# Stage-0 adds no settings surface. The Normal class is 4 GiB / 2 cores / 600 CPU-s
# (doc-10 §B.4.1, pinned in `sandbox/settings.rs`). These constants are the compute-side
# BELT to the form's braces: the compute is reachable by an agent/MCP call that never
# rendered the form, so it re-checks from the DECLARED embedding structure before any read.
#
# The two seams below only ever LOWER a budget, never lift a real limit — they exist so a
# refusal can be exercised without a 4 GiB fixture.
_MEM_BUDGET_BYTES = int(os.environ.get("CLUSTERING_MEMORY_BUDGET_BYTES", str(4 * 1024**3)))
_CPU_SECS_BUDGET = float(os.environ.get("CLUSTERING_CPU_SECS_BUDGET", "600"))

#: Bytes resident per embedding cell: the dense `float32` row (`n_dims × 4`) PLUS the kNN
#: graph scanpy materialises over the cells (a sparse `float32` adjacency at ~`k` nnz per
#: cell, index+datum = 8 bytes). Sized from the DECLARED embedding shape — never a read.
_BYTES_PER_DIM = 4
#: Bytes the kNN adjacency costs PER NEIGHBOUR PER CELL (uint32 index + float32 weight). The
#: graph has ~`n_neighbors` nnz per cell, so the labels-path memory estimate scales with the
#: ACTUAL `n_neighbors` the run honours — NOT a hardcoded k=15 (F4). A run with
#: `n_neighbors=50` builds a graph ~3.3× larger than a k=15 estimate; hardcoding 15 would
#: underestimate the labels-path peak by that factor and let it slip the pre-read gate.
_KNN_BYTES_PER_NEIGHBOUR_PER_CELL = 8

#: CPU-seconds a labels-only clustering fit is estimated to cost per MILLION CELLS: the
#: kNN build + the Leiden partition, both cells-dominated (the embedding is already
#: low-dimensional, so genes/nnz do not enter). A coarse, HONEST upper-ish bound tuned so a
#: real single-dataset run sits well inside 600 CPU-s and only a genuinely oversized
#: embedding trips it. Counts stored values, i.e. PARALLELISM against the CPU budget, not
#: wall clock.
_CPU_SECS_PER_MILLION_CELLS = float(os.environ.get("CLUSTERING_CPU_SECS_PER_MCELL", "40.0"))

#: The neighbour-path switch (INV-6). scanpy 1.11 `Neighbors._handle_transformer`
#: (transformer=None, knn=True) takes the EXACT brute-force `KNeighborsTransformer` only when
#: the "shortcut" holds: `(metric == "euclidean" and n_obs < 8192) or n_obs < 4096`. So the
#: exact→approximate switch is METRIC-DEPENDENT — 8192 for euclidean, 4096 for every other
#: metric — and it is a STRICT `<` (at exactly the threshold, pynndescent runs). Recording a
#: flat 8192 with a `<=` (the pre-fix behaviour) misreported `neighbour_path="exact"` for a
#: cosine/manhattan run in the 4096..8191 band (and at exactly 8192 euclidean) while scanpy
#: actually ran approximate — the field INV-6 exists to record truthfully then lied (P1).
#: Verified against scanpy's real `_handle_transformer` decision at the boundaries.
NEIGHBOUR_EXACT_MAX_CELLS_EUCLIDEAN = 8192
NEIGHBOUR_EXACT_MAX_CELLS_NONEUCLIDEAN = 4096


def neighbour_exact_switch_cells(metric):
    """The cell count at/above which scanpy takes the APPROXIMATE (pynndescent) kNN path for
    THIS metric — 8192 for euclidean, 4096 otherwise (scanpy `_handle_transformer`, INV-6)."""
    return (NEIGHBOUR_EXACT_MAX_CELLS_EUCLIDEAN if str(metric) == "euclidean"
            else NEIGHBOUR_EXACT_MAX_CELLS_NONEUCLIDEAN)


def neighbour_path(n_cells, metric):
    """`"exact"` below the metric's switch, `"approximate"` at/above it. scanpy uses a STRICT
    `<` (n_obs < threshold is exact), so exactly-threshold cells run approximate (INV-6)."""
    return ("exact" if int(n_cells) < neighbour_exact_switch_cells(metric)
            else "approximate")

#: The viable-cell floor (DEC-6, owner-approved 2026-08-21): below this the run is refused
#: honestly rather than fabricating cells or fitting a partition on too few (INV-12).
VIABLE_CELL_THRESHOLD = 10


_PREFIX = ["clustering"]


def set_prefix(prefix):
    """Set the diagnostic prefix so a caller and the test harness can tell OUR named
    refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors cell-filter.py / embedding's _shared) ──────────────
def io_dirs():
    inp = Path(os.environ.get("CYTO_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("CYTO_OUTPUTS_DIR", "/outputs"))
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
    """`slot → [host path, …]` in DECLARATION ORDER, resolved by SLOT out of
    `inputs.json` (ITEM-2) — never by filename suffix (the runner names mounts `in0`/…)."""
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


# ── progress + manifest (mirrors cell-filter.py) ───────────────────────────────────
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
    fifo = os.environ.get("CYTO_PROGRESS_FIFO")
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
    # #80 — append this run's ENVIRONMENT RECORD (the resolved version of every library
    # this entry declares) before the manifest is written, and refuse the run if the
    # environment does not satisfy the declaration. Placed here, on the one path every
    # successful run takes, so recording is structural rather than remembered: a compute
    # cannot emit its outputs without also emitting what produced them.
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(outputs_dir, entries, DT_REPORT_QC)
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and `meta`
    (what they MEAN) are producer declarations with NO default on either side of the wire,
    so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


# ── reading a staged artifact (format from the declaration, cell-filter idiom) ─────
#
# A staged artifact says what it is: a `cyto_zarr` store stamps the producer-declared
# `structure` into its group `zarr.json` under `attributes.cyto`. That declaration is the
# format contract; a filename is not.
def artifact_structure(path):
    """The producer-DECLARED `structure` of a staged artifact, or ``None`` when the path is
    not a `cyto_zarr` store."""
    meta = Path(path) / "zarr.json"
    if not meta.is_file():
        return None
    try:
        doc = json.loads(meta.read_text())
    except (OSError, ValueError):
        return None
    cyto = (doc.get("attributes") or {}).get("cyto")
    return cyto if isinstance(cyto, dict) else None


def read_embedding_structure(path, slot):
    """The DECLARED structure of an `embedding` artifact — WITHOUT reading a byte of the
    matrix. Returns `(structure, member_name, n_rows, n_dims)`. This is what the ceiling
    gate reads before any read (INV-10). Refuses a NON-embedding / 2-D-layout input BY NAME
    (INV-11 — cluster on the reduced embedding, never a 2-D UMAP/t-SNE layout)."""
    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration in "
            "a group `zarr.json` — an `embedding` artifact is a dense 2-D cyto_zarr store"
        )
    arrays = structure.get("arrays") or []
    dense = [a for a in arrays if isinstance(a, dict) and len(a.get("shape") or []) == 2]
    if not dense:
        fail(
            f"input on slot {slot!r} at {path.name!r} declares no dense 2-D array — "
            "clustering rebuilds the kNN graph from the embedding matrix (the PCA/latent "
            "representation), which is a 2-D `(cells × dims)` member (INV-11)"
        )
    member = dense[0]
    shape = member.get("shape") or []
    n_rows, n_dims = int(shape[0]), int(shape[1])
    # INV-11: refuse a 2-D LAYOUT (a UMAP/t-SNE picture) as the graph source. A layout is a
    # lossy 2-D summary for the eye; the kNN graph must be rebuilt on the reduced space.
    member_kind = str((member.get("meta") or {}).get("kind") or member.get("kind") or "")
    declared_kind = str(structure.get("kind") or "")
    if n_dims <= 2 or member_kind in ("layout", "umap", "tsne") or declared_kind in (
            "layout", "umap", "tsne"):
        fail(
            f"input on slot {slot!r} declares a {n_dims}-D "
            f"{member_kind or declared_kind or 'layout'!r} representation; clustering refuses "
            "to build the kNN graph on a 2-D layout (UMAP/t-SNE) and requires the reduced "
            "embedding (PCA/latent, ≥3 dims) it was laid out FROM (INV-11)."
        )
    return structure, member["name"], n_rows, n_dims


def read_embedding_matrix(path, member):
    """Read the dense `(n_cells × n_dims)` embedding member as a float32 numpy array."""
    import cyto_zarr_read

    return np.asarray(cyto_zarr_read.read_array(Path(path), member), dtype=np.float32)


# ── reading the OPTIONAL expression matrix for the descriptive-markers pass (Stage B) ─
#
# The markers pass (`_markers.compute_markers`) needs the cells × genes expression matrix,
# which the labels-only clustering path never reads (doc 10 §5.2 — clustering's input is the
# embedding, not the counts). The `expression` slot is OPTIONAL: bound → descriptive markers
# are folded into the report; absent → the report records markers were skipped (no counts).
#: A dense value carried per stored nonzero of the expression CSC (uint32 index + float32
#: datum = 8 B) — the size the markers READ materialises. Sized from the DECLARED `nnz`.
_CSC_BYTES_PER_NNZ = 8

#: Bytes resident PER NNZ at the markers pass's TRUE PEAK (F1). `compute_markers` does NOT
#: hold one copy: it reads the CSC trio (`_CSC_BYTES_PER_NNZ` resident), THEN builds
#: `sp.csc_matrix(data, indices, indptr).tocsr()` (`_markers.py:161`) — scipy casts the
#: uint32 `indices` to its int32 index dtype (a copy) and `.tocsr()` allocates a full second
#: CSR (int32 indices + float32 data = 8 B/nnz) while the read trio is still referenced (it
#: is reused later by `_dense_gene_column`) — and then runs `normalize_total` + `log1p` over
#: the AnnData-wrapped CSR. So the real peak is ~3 concurrent copies: the retained read trio
#: (8) + the scipy index-cast + `.tocsr()` CSR copy (8) + the AnnData X / normalize-log1p
#: intermediate (8) ≈ 24 B/nnz. Sizing the gate at ONE copy (nnz×8) let a matrix pass the
#: pre-read gate at 1× then get SIGKILLed mid-`.tocsr()` — the "signal kill after the refusal
#: passed" INV-10's load-bearing guarantee forbids. The gate refuses on the TRUE PEAK
#: (mirrors embedding's `_PEAK_BYTES_PER_NNZ`).
_MARKERS_PEAK_BYTES_PER_NNZ = 8 + 8 + 8  # read trio + scipy-cast/tocsr CSR + normalize/AnnData


def read_expression_structure(path, slot):
    """The DECLARED structure of an `expression` artifact — WITHOUT reading a nonzero. Returns
    `(structure, n_cells, n_genes, nnz)`. Refuses a non-CSC input BY NAME. This is what the
    markers MEMORY gate (INV-10, markers clause) reads before any CSC read."""
    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"expression input on slot {slot!r} at {path.name!r} carries no `structure` "
            "declaration in a group `zarr.json` — a `single-cell/expression` artifact is a "
            "multifile CSC Zarr store"
        )
    kind = structure.get("kind")
    if kind != "sparse_csc":
        fail(
            f"expression input on slot {slot!r} at {path.name!r} declares kind {kind!r}; the "
            "descriptive-markers pass reads a `sparse_csc` cells × genes expression matrix"
        )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"expression input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    n_cells, n_genes = int(shape[0]), int(shape[1])
    nnz = int(structure.get("nnz", 0))
    return structure, n_cells, n_genes, nnz


def markers_memory_refuse_if_over(nnz):
    """INV-10 (markers clause) — refuse the markers pass BEFORE reading the CSC when the
    declared expression read would blow the memory envelope, naming the memory ceiling and a
    REACHABLE lever (doc 10 §B.4 — the markers pass is the one that hits the CSC read wall, so
    the memory ceiling, not the time ceiling, is what it re-checks).

    Refuses on the TRUE PEAK (`nnz × _MARKERS_PEAK_BYTES_PER_NNZ`, F1), not the one-copy read
    estimate: `compute_markers` holds ~3 concurrent copies of the matrix (the CSC read trio,
    the `.tocsr()` CSR copy, and the normalize/log1p intermediate), so gating on one copy let
    a matrix pass at 1× then get OOM-SIGKILLed mid-`.tocsr()`. Never an OOM-kill mid-read."""
    resident = int(nnz) * _CSC_BYTES_PER_NNZ          # ONE copy — reported for inspection
    peak = int(nnz) * _MARKERS_PEAK_BYTES_PER_NNZ     # the TRUE peak the gate refuses on (F1)
    if peak > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the expression matrix: the descriptive-markers pass "
            f"needs about {peak / 1024**3:.2f} GiB resident at PEAK (nnz={int(nnz):,} × "
            f"{_MARKERS_PEAK_BYTES_PER_NNZ} bytes across the ~3 concurrent copies held during "
            "the pass — the CSC read trio, the `.tocsr()` CSR copy, and the normalize/log1p "
            f"intermediate), over the MEMORY ceiling of {_MEM_BUDGET_BYTES / 1024**3:.2f} GiB "
            "for the Normal resource class. The lever that moves this ceiling is a smaller "
            "single dataset (fewer cells/genes), or raising the deployment's sandbox memory "
            "limit (the admin resource-class ceiling); the run is refused rather than left to "
            "be OOM-killed mid-read."
        )
    return {"expression_nnz": int(nnz), "estimated_resident_bytes": resident,
            "estimated_peak_bytes": peak, "peak_bytes_per_nnz": _MARKERS_PEAK_BYTES_PER_NNZ,
            "memory_budget_bytes": _MEM_BUDGET_BYTES}


def read_expression_csc(path):
    """Read the expression CSC trio `(indptr, indices, data)` — the columns are the genes."""
    import cyto_csc

    return cyto_csc.read_csc(Path(path))


def embedding_identity(structure, content_hash):
    """The identity of the embedding being partitioned (INV-13): its correction method
    (pca|harmony|scvi|unattested), the row-space digest it is aligned to, and the staged
    artifact's content-hash. `method` is read from the producer's `attributes.cyto` when it
    stamped one (EA-reduce records `method`/`correction`); ABSENT is `unattested`, never
    silently "pca" — inventing a provenance is the inference INV-2 forbids."""
    method = structure.get("method")
    if not method:
        # EA-reduce records the correction/method on the member meta or the group; fall
        # back across both, then to the honest `unattested`.
        arrays = structure.get("arrays") or []
        for a in arrays:
            m = (a.get("meta") or {}) if isinstance(a, dict) else {}
            if m.get("method"):
                method = m["method"]
                break
    return {
        "method": str(method) if method else "unattested",
        "correction": structure.get("correction", "unattested"),
        "aligned_to": structure.get("aligned_to"),
        "content_hash": content_hash,
    }


# ── the ceiling gate (INV-10 / DEC-8) ──────────────────────────────────────────────
def ceiling_refuse_if_over(n_cells, n_dims, n_neighbors=15):
    """Refuse BEFORE any embedding read when the run exceeds the Normal-class envelope,
    with the arithmetic and WHICH ceiling (memory vs time) named (INV-10).

    Sizes from the DECLARED embedding shape + the ACTUAL `n_neighbors` (F4 — the kNN graph
    has ~`n_neighbors` nnz per cell, so a run with `n_neighbors=50` is estimated ~3.3× larger
    than a hardcoded k=15 would suggest). No read. Parallelism is counted against the
    CPU-seconds budget, not wall clock. Never subsamples, never attempts-and-times-out.
    """
    knn_bytes_per_cell = int(n_neighbors) * _KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    resident = n_cells * (n_dims * _BYTES_PER_DIM + knn_bytes_per_cell)
    cpu_secs = (n_cells / 1_000_000.0) * _CPU_SECS_PER_MILLION_CELLS

    if resident > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the embedding: this run needs about "
            f"{resident / 1024**3:.2f} GiB resident (n_cells={n_cells:,} × "
            f"({n_dims} dims × {_BYTES_PER_DIM} + kNN graph {knn_bytes_per_cell} bytes per "
            f"cell at n_neighbors={int(n_neighbors)})), over the MEMORY ceiling of "
            f"{_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Normal resource class. The lever "
            "that moves this ceiling is a smaller single dataset (fewer cells), or raising "
            "the deployment's sandbox memory limit (the admin resource-class ceiling); the "
            "run is refused rather than left to be OOM-killed mid-fit."
        )
    if cpu_secs > _CPU_SECS_BUDGET:
        fail(
            "refusing before reading the embedding: this run is estimated at about "
            f"{cpu_secs:.0f} CPU-seconds (n_cells={n_cells:,}), over the TIME ceiling of "
            f"{_CPU_SECS_BUDGET:.0f} CPU-seconds for the Normal resource class. CPU-seconds "
            "count parallelism, not wall clock. The lever that moves this ceiling is the "
            "admin `timeout_secs` sandbox setting, or a smaller single dataset; the run is "
            "refused rather than left to die to SIGXCPU."
        )
    return {"n_cells": n_cells, "n_dims": n_dims, "n_neighbors": int(n_neighbors),
            "knn_bytes_per_cell": knn_bytes_per_cell,
            "estimated_resident_bytes": resident, "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}


# ── stamp the clustering provenance into the produced column's attributes.cyto ─────
def stamp_clustering_provenance(store_path, provenance):
    """Merge a `clustering` provenance tag into the produced `metadata-column` store's group
    `attributes.cyto` (INV-2 / owner DEC-9(c)).

    `write_metadata_column` writes the decode `structure` into `attributes.cyto`; this adds
    the clustering-provenance sub-key ALONGSIDE it (`attributes.cyto.clustering = {...}`) so
    the artifact is identifiable as clustering-produced WITHOUT an exclusive datatype — it
    stays a categorical `metadata-column` the shipped colour-by `Groups` slice reads for
    free. This is the same declaration channel (`attributes.cyto`) cell-filter's producer
    stamp uses; it is a package-local post-write merge, so no framework `_lib` edit is made.
    """
    p = Path(store_path) / "zarr.json"
    doc = json.loads(p.read_text())
    attrs = doc.setdefault("attributes", {})
    cyto = attrs.setdefault("cyto", {})
    cyto["clustering"] = provenance
    p.write_text(json.dumps(doc, indent=2))
    return provenance
