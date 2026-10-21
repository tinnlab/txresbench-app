#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate BOTH `embedding` analyses stand on (ITEM-0b / ITEM-13).

`embedding.reduce` and `embedding.visualize` share their whole compute plumbing — the
six-variable thread pin, the `/inputs`/`/outputs` wire contract, slot resolution, the
CSC-matrix reader, the ceiling gate, `progress`/`fail`, the manifest writer and the
`report/qc` shape — so it lives ONCE here rather than in two drifting copies. Each entry
declares `helpers: [compute/_shared.py]` so the runner stages this sibling into `/code`
alongside the entry, where `import _shared` resolves off `sys.path[0]` (the entry's own
directory). The suites reach it the same way — the entry runs as a script, so its folder
is `sys.path[0]`.

INV-11 — the SIX thread variables are pinned at the very TOP of this module, BEFORE the
first `import numpy`, so every consumer that imports `_shared` first (both entries do)
has the numeric stack single-threaded before numpy/scipy/scanpy/numba ever load. The
server pins three (`OMP_/OPENBLAS_/MKL_`, `sandbox/sandbox.rs`); the other three
(`NUMEXPR_/VECLIB_/NUMBA_`) are the processor's to pin — pynndescent/UMAP/numba are
numba-parallel and, unpinned, burn the 600 CPU-s budget in ~half the wall clock and die
to `SIGXCPU`. `setdefault` means a genuine server-set value is never overridden.
"""
import os

# ── INV-11: pin all SIX before numpy loads ────────────────────────────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")


def resolved_thread_env():
    """The SIX thread vars as this process actually sees them AFTER the pin — read out of
    the running compute (recorded into the report) so a test proves the child env, never
    the source text (INV-11 / TEST-15)."""
    return {v: os.environ.get(v) for v in THREAD_ENV_VARS}


import json
import sys
from pathlib import Path

import numpy as np

# The shared output-format library (`_lib`, staged into `/code`). `cyto_columns` imports
# pandas lazily, so importing it here keeps the module's floor at numpy + stdlib.
import cyto_deps
import cyto_columns


# ── datatypes emitted (id, layout) — the SHAPE ingest validates ───────────────────
DT_EMBEDDING = ("embedding", "chunked-dense")
DT_REPORT_QC = ("report/qc", "opaque")


# ── Harmony batch correction (ITEM-20a / INV-22) ───────────────────────────────────
#: The harmonypy version the single-cell env rootfs PINS
#: (`env-rootfs/single-cell/Dockerfile`). Recorded into every Harmony run's report and
#: matched against the resolved `harmonypy.__version__` so a version drift is visible.
#: INV-22: "Pin the version and pass parameters explicitly."
HARMONYPY_PIN = "2.0.0"


def harmonypy_pin():
    """The harmonypy version THIS ANALYSIS DECLARES, read from the staged contract (#80).

    The constant above used to be the only statement of the pin on this side, duplicating
    the one in the environment recipe with nothing connecting them — so the two could
    disagree silently, and the report would then record a "pin" that pinned nothing. The
    declaration in this package's manifest is now the single statement of that intent: the
    BUILD gate checks it against the recipe, `cyto_deps` checks the RESOLVED version
    against it, and this reads the same text for the report and the refusal message.

    Falls back to the constant when no contract is staged — a unit test importing this
    module outside a sandbox `/code` has no contract, and refusing there would make the
    module untestable rather than safer. In a real run the contract is always staged.
    """
    return _harmonypy_spec()[1]


def harmonypy_requirement():
    """The DECLARED requirement as a human-readable clause — `==2.0.0` today, or the range
    text if the declaration is ever widened.

    Split from [`harmonypy_pin`] because the two callers want different things and
    conflating them is how a range gets rendered as a pin. The refusal message and the
    report's disclosure want "what this analysis requires", which may or may not be a
    single version; the pin comparison wants a version or nothing.
    """
    exact, text = _harmonypy_spec()
    return f"=={text}" if exact else text


def _harmonypy_spec():
    """`(is_exact, text)` for the declared harmonypy requirement.

    `text` is the bare version when the declaration is exact, and the raw specifier set
    otherwise. Callers decide how to render it; nothing here disguises one as the other.
    """
    for dep in cyto_deps.load_contract():
        if cyto_deps.normalize_name(dep["library"]) != "harmonypy":
            continue
        spec = dep["version"].strip()
        # Only an EXACT declaration is a pin. Returning the raw range from a function
        # whose callers format it as `harmonypy=={...}` produced `harmonypy==>=2.0,<3` —
        # a nonsense string that reads as a fact — which is why the exactness travels
        # WITH the text instead of being re-derived by each caller.
        if spec.startswith("=="):
            return True, spec[2:].strip()
        return False, spec
    return True, HARMONYPY_PIN

#: The default Harmony `theta` (correction strength). Passed EXPLICITLY, never left to
#: harmonypy's version-unstable default (0.0.10 uses `theta=1`, R harmony `theta=2`).
#: We pass R harmony's `theta=2` explicitly; the seam can lower it for tests.
HARMONY_DEFAULT_THETA = 2.0


def import_harmonypy():
    """The harmonypy module, or `None` when it is unavailable (ITEM-20b). Never raises —
    the caller turns `None` into the package's NAMED refusal, so an absent rootfs pin can
    never surface as a raw `ImportError` mid-pipeline.

    `EMBEDDING_FORCE_HARMONYPY_ABSENT=1` forces the absent branch so the named-refusal path
    (TEST-34) is exercised DETERMINISTICALLY even where harmonypy IS installed. Like the
    ceiling seams it can only ever DISABLE a capability, never grant one, so it is safe to
    honour in any build.
    """
    if os.environ.get("EMBEDDING_FORCE_HARMONYPY_ABSENT") == "1":
        return None
    try:
        import harmonypy
        return harmonypy
    except Exception:
        return None


def run_harmony(harmony_mod, x_pca, batch_values, seed):
    """Batch-correct the cells×PCs `x_pca` against a single within-dataset covariate via
    harmonypy, returning `(Z_corrected[cells×PCs] float32, explicit_params, version)`.

    INV-22 — EVERY parameter is passed EXPLICITLY, `theta` FIRST, so harmonypy's
    version-unstable defaults never leak in. The resolved `harmonypy.__version__` is
    returned so the report can record it and a test can match it to the Dockerfile pin.
    """
    import numpy as _np
    import pandas as _pd

    meta = _pd.DataFrame({"_batch": [str(v) for v in batch_values]})
    # EXPLICIT Harmony parameters — `theta` FIRST (INV-22). A dict (insertion-ordered) so
    # the report shows theta leading and the whole set is inspectable.
    params = {
        "theta": float(os.environ.get("EMBEDDING_HARMONY_THETA", HARMONY_DEFAULT_THETA)),
        "vars_use": ["_batch"],
        "max_iter_harmony": int(os.environ.get("EMBEDDING_HARMONY_MAX_ITER", "10")),
        "random_state": int(seed),
    }
    data_mat = _np.ascontiguousarray(_np.asarray(x_pca, dtype=_np.float64))
    ho = harmony_mod.run_harmony(
        data_mat,
        meta,
        params["vars_use"],
        theta=params["theta"],
        max_iter_harmony=params["max_iter_harmony"],
        random_state=params["random_state"],
    )
    z = _np.asarray(ho.Z_corr, dtype=_np.float32)
    # Z_corr is cells×PCs; transpose defensively if a build returns PCs×cells.
    if z.shape[0] != data_mat.shape[0] and z.shape[1] == data_mat.shape[0]:
        z = z.T
    # The RESOLVED version, from the installed distribution's metadata — the same source
    # the run-wide environment record uses, so one report cannot carry two different
    # answers for one library. This used to be `getattr(mod, "__version__", None)`, the
    # attribute the stack's own libraries now emit a deprecation warning for and which a
    # module may define inconsistently with what is actually installed.
    from importlib.metadata import PackageNotFoundError, version as _dist_version

    try:
        version = _dist_version("harmonypy")
    except PackageNotFoundError:
        version = None
    return z, params, version


# ── the Normal-class envelope (INV-8 / DEC-3 / DEC-10) ─────────────────────────────
#
# The reduce ceiling is the deployment's ALREADY-configurable sandbox ceiling (DEC-10);
# Stage 0 adds no settings surface. The Normal class is 4 GiB / 2 cores / 600 CPU-s
# (doc-09 §B.4.1, pinned in `sandbox/settings.rs`). These constants are the compute-side
# BELT to the form's braces (ITEM-16): the compute is reachable by an agent/MCP call that
# never rendered the form, so it re-checks from the DECLARED structure before any read.
#
# The two seams below are debug-only in spirit (they only ever LOWER a budget, never lift
# a real limit) — they exist so a refusal can be exercised without a 4 GiB fixture.
_MEM_BUDGET_BYTES = int(os.environ.get("EMBEDDING_MEMORY_BUDGET_BYTES", str(4 * 1024**3)))
_CPU_SECS_BUDGET = float(os.environ.get("EMBEDDING_CPU_SECS_BUDGET", "600"))

#: Bytes resident per stored value FOR ONE COPY: `uint32` index (4) + `float32` datum (4) = 8
#: (`cyto_csc.INDICES_DTYPE`/`DATA_DTYPE`). This is the arithmetic INV-8/ITEM-16 name in
#: the refusal, read from the declared `nnz` — never from a matrix read.
_BYTES_PER_NNZ = 8

#: Bytes resident per stored value AT PEAK (P1). The reduce pipeline holds ~3 concurrent
#: copies of the stored values during the fit, not one: the CSC read buffer `mat`
#: (8 B/nnz — still bound while the AnnData is built, reduce.py:287-288), the AnnData CSR
#: `X` (float32: uint32 index + float32 datum = 8 B/nnz), and the `counts` layer HVG
#: accumulates on (float64 since F1's INV-10 fix: uint32 index + float64 datum = 12 B/nnz),
#: before scanpy seurat_v3 / the HVG-subset copy. Sizing the ceiling at ONE copy (nnz×8) let
#: a matrix just under 4 GiB pass the pre-read gate and then get OOM-killed mid-fit — exactly
#: what DEC-4/INV-9 promise to prevent. The gate therefore refuses on the true PEAK.
_PEAK_BYTES_PER_NNZ = 8 + 8 + 12  # csc(8) + csr X(8) + float64 counts(12) = 28
#: CPU-seconds an nnz-proportional embedding fit is estimated to cost. A coarse, HONEST
#: upper-ish bound (normalize + HVG + a PCA over the stored values), tuned so a real
#: single-dataset run sits well inside 600 CPU-s and only a genuinely oversized matrix
#: trips it. It counts stored values, i.e. PARALLELISM against the CPU budget (INV-8), not
#: wall clock.
_CPU_SECS_PER_MILLION_NNZ = float(os.environ.get("EMBEDDING_CPU_SECS_PER_MNNZ", "0.30"))


_PREFIX = ["embedding"]


def set_prefix(prefix):
    """Set the diagnostic prefix (`embedding.reduce` / `embedding.visualize`) so a caller
    and the test harness can tell OUR named refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors qc-10x.py) ─────────────────────────────────────────
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
    `inputs.json` (ITEM-13) — never by filename suffix (the runner names mounts `in0`/…)."""
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


# ── progress + manifest (mirrors qc-10x.py) ────────────────────────────────────────
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


def stamp_cyto_attributes(store_dir, structure, **kv):
    """Merge extra provenance keys into an ALREADY-WRITTEN cyto_zarr store's group
    `attributes.cyto` AND the in-memory `structure` dict, keeping the two IDENTICAL (ITEM-25 / F2).

    `write_embedding` (`_lib`, off-limits) stamps the STRUCTURE into `attributes.cyto` at
    `close()`; but the provenance bits the PRODUCER decides — the `correction` attestation and
    the `method` — are only known to the caller and used to live solely in the manifest-entry
    `meta`, so a DOWNSTREAM reader that opens the artifact (`embedding.visualize`, and the
    clustering package) saw `attributes.cyto.correction == None` and coerced it to
    `unattested`, silently downgrading a real Harmony correction. This post-write stamp merges
    those keys into BOTH the on-disk `attributes.cyto` and the `structure` the manifest entry
    carries, so the bit SURVIVES the reduce→visualize hop AND the two declarations stay
    byte-equal (the conformance gate `_conform_group_attributes` requires it — a store-URL
    reader and an artifact-row reader must decode identically). Never edits `_lib`; `None`
    values are skipped so an absent bit stays absent (honest, not defaulted)."""
    for k, v in kv.items():
        if v is not None:
            structure[k] = v
    meta = Path(store_dir) / "zarr.json"
    doc = json.loads(meta.read_text())
    attrs = doc.get("attributes")
    if not isinstance(attrs, dict):
        attrs = {}
        doc["attributes"] = attrs
    # write the FULL updated structure back as attributes.cyto so disk == entry structure.
    attrs["cyto"] = structure
    meta.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return structure


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


# ── reading a staged artifact (mirrors qc-10x.py) ──────────────────────────────────
def artifact_structure(path):
    meta = Path(path) / "zarr.json"
    if not meta.is_file():
        return None
    try:
        doc = json.loads(meta.read_text())
    except (OSError, ValueError):
        return None
    cyto = (doc.get("attributes") or {}).get("cyto")
    return cyto if isinstance(cyto, dict) else None


def read_matrix_structure(path, slot):
    """The DECLARED structure of a `single-cell/expression` CSC store — WITHOUT reading a
    byte of the matrix. This is what the ceiling gate reads (`nnz`/`shape`) before any
    read (INV-8/ITEM-16). Refuses a non-CSC / shapeless input BY NAME."""
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
            f"{structure.get('kind')!r}; embedding.reduce reads a `sparse_csc` count matrix"
        )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    return structure


def read_matrix_csc(path, structure):
    """Read the CSC trio and build a scipy `csc_matrix` of shape (n_cells, n_genes).

    A `single-cell/expression` store is CSC over the GENES axis (`axes: [cells, genes]`),
    so `indptr` cuts by gene/column and `indices` holds cell/row ids — exactly what a
    scipy CSC wants (`(data, indices, indptr)`, `shape=(n_cells, n_genes)`)."""
    import cyto_csc
    import scipy.sparse as sp

    indptr, indices, data = cyto_csc.read_csc(Path(path))
    n_cells, n_genes = int(structure["shape"][0]), int(structure["shape"][1])
    mat = sp.csc_matrix(
        (np.asarray(data), np.asarray(indices), np.asarray(indptr)),
        shape=(n_cells, n_genes),
    )
    return mat


def read_column_native(path, slot):
    """A `metadata-column` artifact → its VALUES in their NATIVE meaning (categorical labels,
    strings, or a numpy numeric array — `cyto_zarr_read.read_column`'s own contract). Used by
    the inline filter so a numeric obs column keeps its dtype and the `criteria_keep_mask`
    range branch takes the numeric fast path, exactly as `cell-filter` reads `adata.obs`."""
    import cyto_zarr_read

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration — "
            "it is not a cyto_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path")
    return cyto_zarr_read.read_column(path, member or "values")


def read_column_values(path, slot):
    """A `metadata-column` artifact → its VALUES as a list of `str` (batch / cell-index)."""
    values = read_column_native(path, slot)
    if hasattr(values, "tolist"):
        values = values.tolist()
    return [("" if v is None else str(v)) for v in values]


# ── the inline metadata filter's obs columns (ITEM-2b/2c/2d / ITEM-14a) ─────────────
#: The slot-name PREFIX that binds ONE cells-axis obs column the filter criteria may
#: reference — the exact convention `cell-filter` uses (`cell-filter.py::COLUMN_SLOT_PREFIX`).
#: A `metadata-column` store keeps its values under the constant member `values` and cannot
#: carry its own name, so the name arrives with the BINDING (`column:<name>`), never a second
#: params channel that could fall out of step with the mounts.
COLUMN_SLOT_PREFIX = "column:"


def collect_filter_columns(slots, n_cells):
    """The `{column_name: values}` obs dict for the inline filter, read from every
    `column:<name>` slot (ITEM-2d). Mirrors `cell-filter.py::main`'s obs-collection: a
    mount-collision refusal (two distinct slots sanitized to one mount would silently read
    the same column) and a per-column length check against the declared cell count. The
    values are NATIVE (dtype preserved) so the shared `criteria_keep_mask` sees exactly what
    `cell-filter` sees off `adata.obs`."""
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
                f"filter columns bound at slots {seen_mounts[mount]!r} and {slot!r} collide on "
                f"one mount ({Path(path).name!r}) — the later stage overwrote the earlier, so "
                "both columns would read the same values"
            )
        seen_mounts[mount] = slot
        values = read_column_native(path, slot)
        if len(values) != n_cells:
            fail(
                f"the filter column bound at slot {slot!r} holds {len(values)} values but the "
                f"matrix declares {n_cells} cells — they are not the same cells axis"
            )
        obs[name] = values
    return obs


# ── the ceiling gate (INV-8 / INV-9 / ITEM-16 / DEC-4) ─────────────────────────────
def ceiling_refuse_if_over(structure, *, n_cells_after=None):
    """Refuse BEFORE any matrix read when the run exceeds the Normal-class envelope,
    with the arithmetic and WHICH ceiling (memory vs time) named (DEC-4/INV-9).

    Sizes from the DECLARED `nnz` (`resident = nnz × 8`, ITEM-16) — no read. Parallelism
    is counted against the CPU-seconds budget, not wall clock (INV-8). Never subsamples,
    never attempts-and-times-out.
    """
    # P2 — fail CLOSED when `nnz` is absent: a missing declared `nnz` used to read as 0, so
    # `resident=0` and BOTH gates passed trivially and the (possibly huge) matrix was read
    # anyway, silently defeating the pre-read ceiling (DEC-4). Refuse BY NAME instead.
    if structure.get("nnz") is None:
        fail(
            "refusing before reading the matrix: the input's declared structure carries no "
            "`nnz`, so the pre-read memory/time ceiling (DEC-4/INV-8) cannot be sized. The run "
            "fails closed by name rather than reading a matrix of unknown size (a missing nnz "
            "must not silently disable the ceiling)."
        )
    nnz = int(structure.get("nnz"))
    resident = nnz * _BYTES_PER_NNZ            # ONE copy — reported for inspection
    peak = nnz * _PEAK_BYTES_PER_NNZ           # the TRUE peak the gate refuses on (P1)
    cpu_secs = (nnz / 1_000_000.0) * _CPU_SECS_PER_MILLION_NNZ

    if peak > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the matrix: this run needs about "
            f"{peak / 1024**3:.2f} GiB resident at PEAK (nnz={nnz:,} × {_PEAK_BYTES_PER_NNZ} "
            "bytes across the ~3 concurrent copies held during the fit — the CSC read buffer, "
            "the CSR X, and the float64 counts layer HVG accumulates on), over the MEMORY "
            f"ceiling of {_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Normal resource class. "
            "The lever that moves this ceiling is the single-dataset size (fewer cells/genes), "
            "or raising the deployment's sandbox memory limit; the run is refused rather "
            "than left to be OOM-killed mid-fit."
        )
    if cpu_secs > _CPU_SECS_BUDGET:
        fail(
            "refusing before reading the matrix: this run is estimated at about "
            f"{cpu_secs:.0f} CPU-seconds (nnz={nnz:,}), over the TIME ceiling of "
            f"{_CPU_SECS_BUDGET:.0f} CPU-seconds for the Normal resource class. CPU-seconds "
            "count parallelism, not wall clock. The lever that moves this ceiling is the "
            "single-dataset size, or raising the deployment's sandbox cpu-seconds limit; "
            "the run is refused rather than left to die to SIGXCPU."
        )
    return {"nnz": nnz, "estimated_resident_bytes": resident,
            "estimated_peak_bytes": peak, "peak_bytes_per_nnz": _PEAK_BYTES_PER_NNZ,
            "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}
