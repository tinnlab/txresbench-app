#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate BOTH `trajectory` analyses stand on (ITEM-2/3).

`trajectory.paga` and `trajectory.dpt` share their whole compute plumbing — the thread +
NUMBA_CPU_NAME pin, the `/inputs`/`/outputs` wire contract, slot resolution, the staged-
artifact readers, the ceiling gate, `progress`/`fail`, the manifest writer and the
`report/qc` shape — so it lives ONCE here rather than in drifting copies. Each entry
declares `helpers: [compute/_shared.py, …]` so the runner stages this sibling into `/code`
alongside the entry, where `import _shared` resolves off `sys.path[0]`. The suites reach it
the same way (the entry runs as a script).

The determinism environment is pinned at the very TOP of this module, BEFORE the first
`import numpy`, so every consumer that imports `_shared` first has the numeric stack
single-threaded and machine-identity-fixed before numpy/scipy/scanpy/numba ever load. The
server pins three (`OMP_/OPENBLAS_/MKL_`); the other three (`NUMEXPR_/VECLIB_/NUMBA_`) are
the processor's to pin. `NUMBA_CPU_NAME=generic` fixes the numba codegen target so two
DIFFERENT machines emit the same code path (scanpy #2014). Every pin is `setdefault`, so a
genuine server-set value is never overridden.

This matters more here than for a partition: DPT's answer is a distance along a diffusion
basis, and a reordered floating-point reduction moves every cell's value a little rather
than moving one borderline cell across a boundary.
"""
import math
import os
import sys

# ── pin the determinism environment before numpy/numba load ───────────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")
os.environ.setdefault("NUMBA_CPU_NAME", "generic")


def resolved_determinism_env():
    """The determinism env as this process ACTUALLY sees it AFTER the pin — read out of the
    running compute (recorded into the report) so a test proves the child env, never the
    source text. The six thread vars plus `NUMBA_CPU_NAME`."""
    out = {v: os.environ.get(v) for v in THREAD_ENV_VARS}
    out["NUMBA_CPU_NAME"] = os.environ.get("NUMBA_CPU_NAME")
    return out


import json
from pathlib import Path

import numpy as np


# ── datatypes emitted (id, layout) — the SHAPE ingest validates ───────────────────
#
# The abstracted graph is the already-declared, never-before-produced open kind: a
# `(node × node)` sparse adjacency whose axis is neither of the dataset's own. Per-cell
# pseudotime is NOT part of it — it is an obs-axis column on an existing kind, which is
# what makes it colourable by the shipped section for free.
DT_GRAPH_ATTRIBUTED = ("graph/attributed", "chunked-sparse")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")


# ── the Normal-class envelope ──────────────────────────────────────────────────────
#
# The ceiling is the deployment's ALREADY-configurable sandbox ceiling (DEC-10); this
# package adds no settings surface. The Normal class is 4 GiB / 2 cores / 600 CPU-s. These
# constants are the compute-side BELT to the form's braces: the compute is reachable by an
# agent/MCP call that never rendered the form, so it re-checks from the DECLARED embedding
# structure before any read.
#
# The two seams below only ever LOWER a budget, never lift a real limit — they exist so a
# refusal can be exercised without a 4 GiB fixture.
#: The Normal class's real limits. The env seams below are CLAMPED against these rather than
#: read verbatim: the comment above promises they only ever LOWER a budget, and a seam that
#: could RAISE one would be a way to talk the gate out of a refusal it was right to make.
_MEM_BUDGET_DEFAULT = 4 * 1024**3
_CPU_SECS_BUDGET_DEFAULT = 600.0


def _seam(name, default, *, only="lower"):
    """Read a budget seam, and make the promise above TRUE rather than merely stated.

    Three ways the naive `min(float(env), default)` failed, all measured:

      * **NaN defeats a clamp.** `min(nan, 600.0)` is `nan`, and `x > nan` is False, so
        `TRAJECTORY_CPU_SECS_BUDGET=nan` did not lower the ceiling — it DELETED it, and the
        gate could never fire again. That is precisely the "talk the gate out of a refusal"
        case the clamp was added to prevent, arriving through the clamp itself.
      * **A NaN then poisons the artifact.** `json.dumps` writes a bare `NaN` token, which is
        not valid JSON, so the report becomes unreadable to a strict parser while the run
        reports success.
      * **A malformed value was an import-time traceback.** These are read at module import,
        before the diagnostic prefix is even set, so `TRAJECTORY_MEMORY_BUDGET_BYTES=4GiB`
        could not be a named refusal by construction.

    So a value is honoured only if it parses AND is finite AND moves the gate in the strict
    direction; anything else falls back to the default with a diagnostic.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        print(f"trajectory: ignoring {name}={raw!r} (not a number); using the default",
              file=sys.stderr, flush=True)
        return default
    if not math.isfinite(value):
        print(f"trajectory: ignoring {name}={raw!r} (not finite — it would disable the gate "
              "rather than tighten it); using the default", file=sys.stderr, flush=True)
        return default
    keep = min(value, default) if only == "lower" else max(value, default)
    return type(default)(keep)


_MEM_BUDGET_BYTES = int(_seam("TRAJECTORY_MEMORY_BUDGET_BYTES", _MEM_BUDGET_DEFAULT))
_CPU_SECS_BUDGET = _seam("TRAJECTORY_CPU_SECS_BUDGET", _CPU_SECS_BUDGET_DEFAULT)

#: Bytes resident per cell for the dense `float32` embedding row (`n_dims × 4`).
_BYTES_PER_DIM = 4
#: Bytes the kNN adjacency costs PER NEIGHBOUR PER CELL (uint32 index + float32 weight). The
#: graph has ~`n_neighbors` nnz per cell, so the estimate scales with the ACTUAL
#: `n_neighbors` the run honours rather than a hardcoded k.
#: MEASURED on a live neighbour build rather than reasoned about: the library keeps TWO
#: sparse matrices per run, not one — a float64 `distances` (12 B/nnz at ~14 nnz/cell) and a
#: float32 `connectivities` (8 B/nnz at ~22 nnz/cell) — which is ~23 B per neighbour per
#: cell at k=15, not the 8 an index-plus-weight sketch suggests. Sized at 24. The estimate is
#: still a floor rather than a bound (the approximate-kNN path's transient structures are not
#: modelled), which is why the refusal names a lever rather than promising a guarantee.
_KNN_BYTES_PER_NEIGHBOUR_PER_CELL = 24
#: Bytes per cell for the DIFFUSION MAP basis DPT additionally materialises: `n_comps`
#: float64 eigen-coordinates plus the float32 cast scanpy keeps. Sized from the run's actual
#: `n_comps`, and it is why `trajectory.dpt`'s estimate is strictly larger than a partition's
#: on the same embedding — the diffusion basis is a second dense per-cell matrix.
#: The stored basis is float32-only (the solver's eigenvectors are cast on the way out), but
#: the eigendecomposition holds a float64 workspace of several n-length vectors while it runs.
#: 4 for the stored basis + 8 for the transient workspace per component.
_DIFFMAP_BYTES_PER_COMP_PER_CELL = 4 + 8

#: CPU-seconds per MILLION CELLS. The kNN build dominates, as it does for a partition, but
#: the eigendecomposition behind `tl.diffmap` is a real second cost, so this is set above a
#: labels-only estimate. A coarse, HONEST upper-ish bound: a real single-dataset run sits
#: well inside 600 CPU-s and only a genuinely oversized embedding trips it. Counts stored
#: values, i.e. PARALLELISM against the CPU budget, not wall clock.
_CPU_SECS_PER_MCELL_DEFAULT = 90.0
_CPU_SECS_PER_MILLION_CELLS = _seam("TRAJECTORY_CPU_SECS_PER_MCELL",
                                    _CPU_SECS_PER_MCELL_DEFAULT, only="upper")


# ── BEGIN VENDORED VERBATIM from packages/clustering/compute/_shared.py ────────────
#
# `run.helpers` is confined to a package's OWN tree (`processors/mod.rs::
# confine_under_package` rejects any `..`), so a cross-package import of clustering's
# `_shared` is impossible without moving the kernel into `_lib` — an `src-app` edit that
# would break the zero-src-app-edit invariant this package exists to demonstrate. So the
# switch is VENDORED BYTE-FOR-BYTE, exactly as `embedding/compute/_criteria.py` vendors
# `cell-filter`'s predicate kernel.
#
# Do NOT hand-edit the span below. `tests/test_neighbour_path_parity.py` asserts it is
# `inspect.getsource`-identical to clustering's, and separately asserts BOTH copies agree
# with scanpy's own `_handle_transformer` at every boundary — so a drift in either direction
# is a failing test rather than a silent divergence. The `INV-6` the docstring names is
# CLUSTERING's invariant numbering, preserved because the copy is verbatim.

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

# ── END VENDORED ───────────────────────────────────────────────────────────────────


#: The neighbour metrics this package passes through. A CLOSED set, because the value goes
#: straight to the library and an unknown one dies there with a bare parameter-validation
#: traceback — and this compute is explicitly reachable by an agent call that never rendered
#: the form whose select already constrains it.
METRICS = ("euclidean", "cosine", "correlation", "manhattan")

#: A seed is passed to the library's RNG, which refuses anything outside this range with a
#: bare ValueError. Bounded here so it is a named refusal instead.
MAX_SEED = 2**32 - 1

#: The most levels a partition may have. The graph is DENSE in the node count — the adjacency
#: is materialised n_groups x n_groups, the edge and node tables ride the manifest entry, and
#: that entry is hard-capped at 1 MiB by the ingest path, which FAILS the run after the
#: compute has already exited 0. Measured: ~0.31 KiB of manifest per level, so the cap lands
#: near 3300 levels; the dense allocation reaches tens of GB well before any plausible use.
#: A partition with this many levels is not an abstraction of anything, so it is refused.
MAX_PARTITION_LEVELS = 2000


def resolve_metric(value):
    """The metric, or a named refusal listing the ones that work."""
    metric = str(value or "euclidean")
    if metric not in METRICS:
        fail(
            f"unknown distance metric {metric!r}. This analysis passes the metric straight to "
            "the neighbour graph, and an unknown one fails inside the library with no useful "
            f"message, so it is refused here. Available: {', '.join(METRICS)}."
        )
    return metric


def resolve_seed(value):
    """The seed, or a named refusal — the library's RNG refuses out-of-range values itself,
    with a bare traceback."""
    try:
        seed = int(value)
    except (TypeError, ValueError):
        fail(f"the seed {value!r} is not a whole number; it is recorded with the result, so "
             "it is refused rather than silently replaced.")
    if seed < 0 or seed > MAX_SEED:
        fail(f"the seed {seed} is outside 0..{MAX_SEED}, which is the range the random "
             "number generator accepts. Pick a seed inside it.")
    return seed


def honoured_n_neighbors(adata, requested, neighbors_key="neighbors"):
    """What the library ACTUALLY built, which is not always what was asked for.

    On a small dataset the neighbour builder silently CLAMPS k and logs a warning — measured:
    a request for 9999 on 180 cells builds 91. Recording the request would put a false number
    in the one field this package's own disclosure tells a reader to judge comparability by
    ("not comparable across different `n_neighbors`"). So the honoured value is read back off
    the object and BOTH are recorded.
    """
    try:
        actual = int((adata.uns[neighbors_key]["params"])["n_neighbors"])
    except Exception:
        return int(requested), None
    return actual, (None if actual == int(requested) else int(requested))


def resolve_output_name(value, *, default):
    """The output artifact's name, or a named refusal.

    Unvalidated it flows into the manifest entry id and every downstream label, so a
    traversal-shaped, empty, or unbounded string becomes an artifact identity nobody can
    read back. Conservative on purpose: this names a column or a graph, not a path.
    """
    name = str(value if value not in (None, "") else default).strip()
    if not name:
        fail("the output name is empty; it is the artifact this run commits and the run "
             "invents none.")
    if len(name) > 128:
        fail(f"the output name is {len(name)} characters, over the limit of 128.")
    if any(c in name for c in "/\\") or name in (".", "..") or name.startswith("."):
        fail(f"the output name {name!r} looks like a path rather than a label. It names a "
             "column or a graph; use letters, digits, spaces, dashes or underscores.")
    return name


def resolve_strict_int(value, what):
    """An integer, or a REFUSAL — never a silent fallback to a default.

    The permissive reader elsewhere in this package substitutes the default for anything it
    cannot parse, which is right for a knob that does not steer the answer. It is wrong for
    the root spec: this package's own disclosure says the root determines the entire result,
    so swallowing a typo and ordering from somewhere else is exactly the authoritative-looking
    wrongness the whole design is against.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        fail(f"`{what}` is {value!r}, which is not a whole number. It steers the root, and "
             "the root determines the entire ordering, so it is refused rather than replaced "
             "with a default you did not choose.")


#: The viable-cell floor: below this the run is refused honestly rather than fitting an
#: ordering on too few. A trajectory over a handful of cells is a picture of noise.
VIABLE_CELL_THRESHOLD = 10


_PREFIX = ["trajectory"]


def set_prefix(prefix):
    """Set the diagnostic prefix so a caller and the test harness can tell OUR named
    refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors clustering / embedding's _shared) ──────────────────
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
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and `meta`
    (what they MEAN) are producer declarations with NO default on either side of the wire,
    so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


# ── reading a staged artifact (format from the DECLARATION, never a filename) ──────
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
    gate reads before any read. Refuses a NON-embedding / 2-D-layout input BY NAME: a
    trajectory is built on the reduced representation, never on a 2-D picture of it."""
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
            f"input on slot {slot!r} at {path.name!r} declares no dense 2-D array — the "
            "neighbour graph is rebuilt from the embedding matrix (the PCA/latent "
            "representation), which is a 2-D `(cells × dims)` member"
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
            f"{member_kind or declared_kind or 'layout'!r} representation; the trajectory "
            "refuses to build the neighbour graph on a 2-D layout (UMAP/t-SNE) and requires "
            "the reduced embedding (PCA/latent, >=3 dims) it was laid out FROM. A 2-D layout "
            "is a lossy picture for the eye; a pseudotime computed on it measures the "
            "picture, not the biology."
        )
    return structure, member["name"], n_rows, n_dims


def read_embedding_matrix(path, member):
    """Read the dense `(n_cells × n_dims)` embedding member as a float32 numpy array."""
    import cyto_zarr_read

    return np.asarray(cyto_zarr_read.read_array(Path(path), member), dtype=np.float32)


# ── reading a `metadata-column` input ──────────────────────────────────────────────
#
# Categorical-ness is a per-ARTIFACT property, not a datatype one: `metadata-column`
# declares no dtype and no categorical/continuous split at all, and the producer stamps the
# member's own `attributes.cyto.kind`. So the applicability check keys on the datatype (the
# platform's job) and the CATEGORICAL check is a compute-side named refusal (ours).
def column_member_meta(path, member="values"):
    """The member-level `attributes.cyto` of a column artifact (`kind`, `levels`, …)."""
    p = Path(path) / member / "zarr.json"
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    cyto = (doc.get("attributes") or {}).get("cyto")
    return cyto if isinstance(cyto, dict) else None


def read_categorical_column(path, slot):
    """The labels of a CATEGORICAL `metadata-column` artifact, plus its declared level set.

    Returns `(labels, levels)`. Refuses BY NAME when the bound column is continuous — the
    partition a graph's nodes are drawn from must be a factor, and a continuous column would
    otherwise be silently binned by whatever read it next."""
    import cyto_zarr_read

    meta = column_member_meta(path)
    if meta is None:
        fail(
            f"input on slot {slot!r} at {Path(path).name!r} carries no member declaration — "
            "the partition must be a `metadata-column` artifact written by a producer"
        )
    kind = str(meta.get("kind") or "")
    if kind != "categorical":
        fail(
            f"the column bound on slot {slot!r} declares kind {kind or 'unknown'!r}, but the "
            "abstracted graph's nodes ARE the levels of a partition, so it needs a "
            "CATEGORICAL column. Bind a cluster label (or another factor); a continuous "
            "column is refused rather than binned into groups this analysis would have "
            "invented."
        )
    # The column writer encodes a MISSING categorical by inventing a sentinel level (a
    # non-colliding label, typically "NA") and appending it to the declared set. A reader that
    # only consults the member's own attributes cannot tell that sentinel from a real level:
    # the values come back as the literal string, and it would become a graph node with a
    # connectivity row and a cell count, indistinguishable from a biological group — or a
    # selectable root population. The declaration IS on the store, one level up, in the group
    # structure's per-column record, so it is read rather than guessed.
    missing_level = _declared_missing_level(path)
    if missing_level is not None:
        fail(
            f"the column bound on slot {slot!r} has cells with NO value: its producer encoded "
            f"them as the invented level {missing_level!r}. That sentinel is not a group — "
            "treating it as one would put a node in the graph (or offer a root population) "
            "made entirely of cells nobody labelled. Filter the unlabelled cells out, or "
            "assign them a label, and bind the result."
        )

    levels = [str(x) for x in (meta.get("levels") or [])]
    if not levels:
        fail(
            f"the column bound on slot {slot!r} declares itself categorical but names no "
            "levels, so its values cannot be resolved to groups."
        )

    # The CODES are checked against the declared level set BEFORE they are resolved through
    # it. A store whose codes run past its own declaration is not merely wrong, it is a bare
    # `IndexError` out of the shared reader — a traceback reaching the user from framework
    # code, which is the failure class every refusal in this package exists to replace. Found
    # while building a fixture for the refusal below, which could not be reached until this
    # one existed.
    codes = np.asarray(cyto_zarr_read.read_array(Path(path), "values"))
    if codes.size and int(codes.max()) >= len(levels):
        fail(
            f"the column bound on slot {slot!r} holds a category code "
            f"{int(codes.max())} but declares only {len(levels)} level(s), so at least one "
            "cell refers to a group its own declaration does not define. The artifact is "
            "internally inconsistent; re-emit it from its producer."
        )
    labels = [str(v) for v in cyto_zarr_read.read_column(Path(path), "values")]
    return labels, levels


def _declared_missing_level(path, member="values"):
    """The sentinel label the writer invented for missing values, or ``None``.

    Read from the GROUP structure's per-column record, which is where the writer declares it
    — the member's own attributes carry the level list with the sentinel already folded in,
    and nothing there distinguishes it.
    """
    structure = artifact_structure(path) or {}
    for column in structure.get("columns") or []:
        if isinstance(column, dict) and str(column.get("name") or column.get("path")) == member:
            declared = column.get("missing_level")
            return str(declared) if declared is not None else None
    return None


def declared_row_space(path):
    """The artifact's declared ROW SPACE identity (`aligned_to`), or ``None``.

    `axis` says which LABEL an artifact's values are keyed by; this says which row space —
    and only the second one identifies. Several datasets in one project spell their row axis
    with the same label, so a length match is not an alignment.
    """
    structure = artifact_structure(path) or {}
    value = structure.get("aligned_to")
    return str(value) if value else None


def refuse_misaligned(reference, other, *, slot, what):
    """Refuse BY NAME when two artifacts declare DIFFERENT row spaces.

    Equal length is not alignment. Two artifacts over the same number of cells but different
    populations — two datasets of one size, or two different subsets of one axis — produce a
    completely plausible result built on scrambled labels, with every declaration well-formed
    and nothing to see. Where BOTH sides declare a row space, they are compared; where either
    does not, the absence is honest (a producer that does not hold the axis keys cannot
    declare one) and the run proceeds on the length check alone rather than on an invented
    identity.
    """
    if reference and other and reference != other:
        fail(
            f"the {what} bound on slot {slot!r} declares a DIFFERENT row space from the "
            "embedding, so its values do not describe these cells even though the two are "
            "the same length. A length match is not an alignment: two artifacts over equally "
            "many cells can be over different cells entirely, and the result would be a "
            "plausible answer built on scrambled labels. Bind the column that belongs to this "
            "embedding's dataset."
        )


def read_axis_keys(path, slot):
    """The entity keys (barcodes) of a column artifact whose VALUES are the axis's keys.

    Used only to resolve/report a root by barcode. Returns `None` when nothing is bound —
    absence is a real state the report states honestly, never a fabricated key list."""
    import cyto_zarr_read

    if path is None:
        return None
    try:
        return [str(v) for v in cyto_zarr_read.read_column(Path(path), "values")]
    except Exception:
        fail(
            f"the artifact bound on slot {slot!r} could not be read as a column of axis "
            "keys — bind the cells-axis key column (the one whose values ARE the barcodes)"
        )


# ── the ceiling gate ───────────────────────────────────────────────────────────────
def ceiling_refuse_if_over(n_cells, n_dims, n_neighbors=15, n_comps=0):
    """Refuse BEFORE any embedding read when the run exceeds the Normal-class envelope,
    with the arithmetic and WHICH ceiling (memory vs time) named.

    Sized from the DECLARED embedding shape plus the ACTUAL `n_neighbors` and `n_comps` this
    run honours. No read. Parallelism is counted against the CPU-seconds budget, not wall
    clock. Never subsamples, never attempts-and-times-out.

    `n_comps=0` sizes the graph-only path; a positive `n_comps` adds the diffusion basis the
    pseudotime path materialises, which is a second dense per-cell matrix and is the reason
    the two analyses do not share one number.
    """
    knn_bytes_per_cell = int(n_neighbors) * _KNN_BYTES_PER_NEIGHBOUR_PER_CELL
    diffmap_bytes_per_cell = int(n_comps) * _DIFFMAP_BYTES_PER_COMP_PER_CELL
    resident = n_cells * (n_dims * _BYTES_PER_DIM + knn_bytes_per_cell
                          + diffmap_bytes_per_cell)
    cpu_secs = (n_cells / 1_000_000.0) * _CPU_SECS_PER_MILLION_CELLS

    if resident > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the embedding: this run needs about "
            f"{resident / 1024**3:.2f} GiB resident (n_cells={n_cells:,} x "
            f"({n_dims} dims x {_BYTES_PER_DIM} + kNN graph {knn_bytes_per_cell} + diffusion "
            f"basis {diffmap_bytes_per_cell} bytes per cell, at n_neighbors="
            f"{int(n_neighbors)} and n_comps={int(n_comps)}), over the MEMORY ceiling of "
            f"{_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Normal resource class. The lever "
            "that moves this ceiling is a smaller `n_neighbors` (the graph term above is the "
            "dominant one, and it scales linearly with it), a smaller `n_comps`, a smaller "
            "single dataset, or raising the deployment's sandbox memory limit (the admin "
            "resource-class ceiling); the run is refused rather than left to be OOM-killed "
            "mid-fit."
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
    return {"n_cells": int(n_cells), "n_dims": int(n_dims), "n_neighbors": int(n_neighbors),
            "n_comps": int(n_comps), "knn_bytes_per_cell": knn_bytes_per_cell,
            "diffmap_bytes_per_cell": diffmap_bytes_per_cell,
            "estimated_resident_bytes": int(resident),
            "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}


# ── library versions ───────────────────────────────────────────────────────────────
#
# `importlib.metadata.version()` FIRST, `__version__` only as the fallback. The shipped
# convention across the sibling packages reads `getattr(module, "__version__", None)`, and
# scanpy has DEPRECATED that attribute (it emits a FutureWarning pointing at
# `importlib.metadata`). When it is removed, a `getattr(..., None)` recorder silently
# records `null` for the single most important library in the provenance record, and no test
# catches it because the fallback is a value rather than a failure. Filed as the shared item
# #132; done the right way round here, package-locally, because fixing it in `_lib` would be
# a framework edit this branch is not entitled to make.
#: Import name → distribution name, where they differ.
_DISTRIBUTION_NAMES = {"igraph": "igraph"}


def library_versions(modules=("scanpy", "igraph", "scipy", "numpy", "anndata", "pandas")):
    """Resolved versions of the libraries whose behaviour the result depends on.

    The rootfs pins only one package by explicit house style, so these are only knowable at
    run time — and PAGA's numeric core being stable across a wide scanpy range is a reason to
    RECORD rather than a reason not to care.
    """
    import importlib
    import importlib.metadata as im

    out = {}
    for mod in modules:
        version = None
        try:
            version = im.version(_DISTRIBUTION_NAMES.get(mod, mod))
        except Exception:
            try:
                version = getattr(importlib.import_module(mod), "__version__", None)
            except Exception:
                version = None
        out[mod] = version
    return out


def opaque_report_entry(id, rel, meta):
    """The `report/qc` output entry — one JSON blob per run, declared opaque."""
    import cyto_columns

    return output_entry(id, DT_REPORT_QC, rel, "artifact",
                        structure=cyto_columns.opaque("application/json"), meta=meta)


# ── the disclosures every trajectory run carries ───────────────────────────────────
#
# These are recorded on the artifact itself, not left to the reader. A trajectory that runs
# but is wrong looks authoritative: it produces a smooth, plausible, colourable gradient that
# a reader has no way to distinguish from a correct one. Every one of these is a limitation
# no test in this package can close, which is exactly why they are shipped as text.
DISCLOSURES = {
    "pseudotime_is_not_time": (
        "Pseudotime is an ORDERING, not a time. It is a distance along a graph geodesic in a "
        "diffusion basis: no units, no calibration to developmental time, and no guarantee "
        "of a uniform rate. The foundational assumption — that transcriptomic similarity "
        "implies developmental relation — is an assumption, not an observation."
    ),
    "the_root_determines_everything": (
        "The root fixes the origin AND the direction of the entire ordering. It is one "
        "unvalidated row index with no default and no automatic inference; a different root "
        "is a DIFFERENT RESULT, not a different view of the same result. Choosing a root "
        "cluster is a biological assertion by the user, and this run records which one was "
        "made and the rule that resolved it to a cell."
    ),
    "connectivity_is_not_a_probability": (
        "A PAGA connectivity is a TEST STATISTIC, not a probability and not a confidence: it "
        "is the observed/expected ratio of inter-partition edges under a random-connection "
        "null, HARD-CAPPED AT 1 — which is precisely why it gets misread as a probability. "
        "It is not comparable across different partitions or different `n_neighbors`. scanpy "
        "declines to give a p-value because the null model strongly overestimates the "
        "expected value, and the expected-value denominator is not recoverable from its "
        "output, so it is not reported here rather than being re-derived."
    ),
    "only_as_good_as_the_partition": (
        "The abstracted graph's NODES ARE the partition it was handed. Changing the "
        "clustering resolution changes the topology. The partition is an INPUT, not a "
        "discovery of this analysis."
    ),
    "no_method_tests_that_a_trajectory_EXISTS": (
        "Neither method tests whether a continuum exists in these data. Run on discrete cell "
        "types, both produce a confident-looking ordering of nothing. No test in this "
        "package can close that gap; it is disclosed rather than checked."
    ),
    "the_capability_gap_of_this_method": (
        "What these two analyses do NOT provide, stated because a reader comparing methods "
        "needs it: no fate probabilities and no terminal-state inference, no per-lineage "
        "pseudotime and no lineage weights, no fitted principal curve or graph, and no test "
        "of differential expression along the ordering. A result here is an ordering and an "
        "abstracted topology, and nothing more."
    ),
    "a_numerical_change_is_scheduled_upstream": (
        "The diffusion-distance implementation still includes a stationary-state contribution "
        "that other implementations of the same method omit, and the library's own source "
        "records that this will likely be removed at its next backwards-incompatible release. "
        "Values from this analysis are therefore comparable within a library version and not "
        "necessarily across one, which is why the resolved versions travel with the result."
    ),
    "no_method_is_best_at_this": (
        "The published benchmark of this problem (Saelens et al. 2019, Nat Biotechnol 37:547, "
        "45 methods) found NO universal winner and concluded that the choice should depend "
        "mostly on the dataset's dimensions and the topology being looked for. The abstracted-"
        "graph method scored well on tree-like and complex topologies; simpler topologies have "
        "better-suited methods. Choosing this one is a tradeoff, not a verdict."
    ),
    "branch_detection_not_performed": (
        "Branch detection was NOT performed. scanpy's own guidance is to use its pseudotime "
        "tool only for pseudotime (`n_branchings=0`) and to read branching from the "
        "abstracted graph instead; its splitting criterion additionally needs a "
        "stabilization hack for small branches, which is an admission of instability in the "
        "API surface itself. No branch label is emitted."
    ),
}
