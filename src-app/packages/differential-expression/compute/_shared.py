#!/usr/bin/env python3
# ruff: noqa
"""_shared — the compute substrate BOTH DE analyses stand on (mirrors embedding/clustering).

`de.markers` and `de.compare` share their whole compute plumbing — the six-thread + numba
determinism pin, the `/inputs`/`/outputs` wire contract, slot resolution, the banded
gene-major CSC reader (INV-9), the ceiling gate, `progress`/`fail`, the manifest writer, the
per-comparison `de/result` gene-table writer and the run `report/qc` shape — so it lives ONCE
here. Each entry declares `helpers: [compute/_shared.py, …]` so the runner stages this sibling
into `/code` beside the entry, where `import _shared` resolves off `sys.path[0]`.

The determinism environment is pinned at the very TOP of this module, BEFORE the first
`import numpy`, so every consumer that imports `_shared` first has the numeric stack
single-threaded and machine-identity-fixed before numpy/scipy/scanpy/numba ever load.
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

import cyto_deps
import cyto_columns


# ── datatypes emitted (id, artifact-row layout) — the SHAPE ingest validates ───────
# A per-comparison DE result is a gene-axis annotation TABLE (`columnar-table`), the
# gene-axis analog of a `metadata-column`. ONE comparison = ONE 2D `de/result` (DEC-13);
# NO synthetic `comparison` axis.
DT_DE_RESULT = ("de/result", "columnar-table")
DT_REPORT_QC = ("report/qc", "opaque")


# ── the Normal-class envelope (INV-11 / DEC-10) ────────────────────────────────────
# The DE ceiling is the deployment's ALREADY-configurable sandbox ceiling. The Normal class
# is 4 GiB / 2 cores / 600 CPU-s. These are the compute-side BELT to the form's braces: an
# agent/MCP call that never rendered the form reaches the compute, so it re-checks from the
# DECLARED expression structure before any read. The two seams below only ever LOWER a budget.
_MEM_BUDGET_BYTES = int(os.environ.get("DE_MEMORY_BUDGET_BYTES", str(4 * 1024**3)))
_CPU_SECS_BUDGET = float(os.environ.get("DE_CPU_SECS_BUDGET", "600"))

#: A dense value carried per stored nonzero of the expression CSC (uint32 index + float32
#: datum = 8 B) — the size one banded read materialises.
_CSC_BYTES_PER_NNZ = 8

#: Bytes resident PER NNZ at the marker/compare read's TRUE PEAK. The pass reads the CSC trio
#: (8 B/nnz resident), builds a scipy CSR copy (int32 idx + float32 data = 8 B/nnz), and runs
#: normalize_total + log1p over the AnnData-wrapped CSR (another intermediate ≈ 8 B/nnz), so
#: the true peak is ~3 concurrent copies. Sizing the gate at one copy let a matrix pass the
#: pre-read gate then get OOM-SIGKILLed mid-`.tocsr()` — the gate refuses on the TRUE PEAK.
_PEAK_BYTES_PER_NNZ = 8 + 8 + 8

#: CPU-seconds an nnz-proportional DE pass is estimated to cost per MILLION NNZ — a coarse,
#: honest upper-ish bound tuned so a real single-dataset run sits well inside 600 CPU-s and
#: only a genuinely oversized matrix trips it. Counts stored values (PARALLELISM against the
#: CPU budget), not wall clock.
_CPU_SECS_PER_MILLION_NNZ = float(os.environ.get("DE_CPU_SECS_PER_MNNZ", "0.60"))


_PREFIX = ["differential-expression"]


def set_prefix(prefix):
    """Set the diagnostic prefix (`de.markers` / `de.compare`) so a caller and the test
    harness can tell OUR named refusal from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ── io + wire contract (mirrors clustering/_shared) ────────────────────────────────
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
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


def stamp_cyto_attributes(store_dir, structure, **kv):
    """Merge extra provenance keys into an ALREADY-WRITTEN cyto_zarr store's group
    `attributes.cyto` AND the in-memory `structure`, keeping the two IDENTICAL (the
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
    attrs["cyto"] = structure
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
    cyto = (doc.get("attributes") or {}).get("cyto")
    return cyto if isinstance(cyto, dict) else None


#: The datatype ids a normalized/log layer carries — the ones the RAW-COUNTS compare path
#: refuses BY NAME (INV-13 / D4). `de.compare` never silently pseudocounts a normalized layer.
_NON_COUNTS_DATATYPES = ("single-cell/normalized", "single-cell/protein", "single-cell/atac")


def read_expression_structure(path, slot, *, require_raw_counts=False):
    """The DECLARED structure of a `single-cell/expression` artifact — WITHOUT reading a
    nonzero. Returns `(structure, n_cells, n_genes, nnz, gene_names)`. Refuses a non-CSC input
    BY NAME. When `require_raw_counts` (de.compare, INV-13), refuses a normalized/log layer BY
    NAME rather than silently pseudocounting it into the pseudobulk→DESeq2 path (D4)."""
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
            "DE pass reads a `sparse_csc` cells × genes expression matrix"
        )
    if require_raw_counts:
        # INV-13 / D4 — the datatype the producer stamped, when it stamped one. A normalized /
        # log / protein / atac layer is refused BY NAME; the pseudobulk → DESeq2 path needs raw
        # integer counts and never adds a global pseudocount.
        declared_dt = str(structure.get("datatype") or structure.get("layer") or "")
        normalized = bool(structure.get("normalized")) or bool(structure.get("log1p"))
        if declared_dt in _NON_COUNTS_DATATYPES or normalized:
            fail(
                f"refusing the expression input on slot {slot!r}: it declares "
                f"{declared_dt or 'a normalized/log layer'!r}, but de.compare consumes RAW "
                "COUNTS only (INV-13). Pseudobulk sums integer counts and DESeq2 normalizes "
                "internally, so feeding a normalized/log layer would double-normalize; the run "
                "refuses rather than silently adding a pseudocount to a normalized matrix (the "
                "legacy D4 defect). Bind the raw count matrix instead."
            )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"expression input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    n_cells, n_genes = int(shape[0]), int(shape[1])
    nnz = int(structure.get("nnz", 0))
    gene_names = _declared_gene_names(structure, n_genes)
    return structure, n_cells, n_genes, nnz, gene_names


def _declared_gene_names(structure, n_genes):
    """The gene ids off the expression structure's var-axis declaration, or `gene{j}`
    fallbacks. Never invented silently past what the store declares."""
    for key in ("var_names", "gene_names", "genes", "columns_names"):
        v = structure.get(key)
        if isinstance(v, list) and len(v) == n_genes:
            return [str(g) for g in v]
    return [f"gene{j}" for j in range(n_genes)]


def read_expression_csc(path):
    """Read the expression CSC trio `(indptr, indices, data)` — the columns are the genes."""
    import cyto_csc

    return cyto_csc.read_csc(Path(path))


def read_column_values(path, slot):
    """A `metadata-column` artifact → its VALUES as a list of `str` (the grouping / sample
    labels). Native dtype is coerced to text so the categorical grouping reads uniformly."""
    import cyto_zarr_read

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"column input on slot {slot!r} at {path.name!r} carries no `structure` "
            "declaration — it is not a cyto_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path") or columns[0].get("name")
    values = cyto_zarr_read.read_column(path, member or "values")
    if hasattr(values, "tolist"):
        values = values.tolist()
    return [("" if v is None else str(v)) for v in values]


def column_provenance(path):
    """The grouping column's `attributes.cyto` provenance (the regime classifier's input,
    INV-2). Returns the whole `attributes.cyto` dict (may carry a `clustering`/annotation/
    prediction sub-key) or `{}` when the column declares none."""
    return artifact_structure(path) or {}


# ── the ceiling gate (INV-9 / INV-11) ──────────────────────────────────────────────
def ceiling_refuse_if_over(nnz):
    """Refuse BEFORE any CSC read when the run's declared read would blow the Normal-class
    envelope, naming WHICH ceiling (memory vs time) and a REACHABLE lever (INV-9). Refuses on
    the TRUE PEAK (`nnz × _PEAK_BYTES_PER_NNZ`), never a mid-run signal-kill. Sizes from the
    DECLARED `nnz` — no read; parallelism counts against the CPU-seconds budget, not wall clock."""
    if nnz is None:
        fail(
            "refusing before reading the matrix: the input's declared structure carries no "
            "`nnz`, so the pre-read memory/time ceiling cannot be sized. The run fails closed "
            "rather than reading a matrix of unknown size."
        )
    nnz = int(nnz)
    resident = nnz * _CSC_BYTES_PER_NNZ
    peak = nnz * _PEAK_BYTES_PER_NNZ
    cpu_secs = (nnz / 1_000_000.0) * _CPU_SECS_PER_MILLION_NNZ
    if peak > _MEM_BUDGET_BYTES:
        fail(
            "refusing before reading the expression matrix: this run needs about "
            f"{peak / 1024**3:.2f} GiB resident at PEAK (nnz={nnz:,} × {_PEAK_BYTES_PER_NNZ} "
            "bytes across the ~3 concurrent copies held during the pass — the CSC read trio, "
            "the scipy CSR copy, and the normalize/log1p intermediate), over the MEMORY ceiling "
            f"of {_MEM_BUDGET_BYTES / 1024**3:.2f} GiB for the Normal resource class. The lever "
            "that moves this ceiling is a smaller single dataset (fewer cells/genes), or raising "
            "the deployment's sandbox memory limit; the run is refused rather than left to be "
            "OOM-killed mid-read."
        )
    if cpu_secs > _CPU_SECS_BUDGET:
        fail(
            "refusing before reading the expression matrix: this run is estimated at about "
            f"{cpu_secs:.0f} CPU-seconds (nnz={nnz:,}), over the TIME ceiling of "
            f"{_CPU_SECS_BUDGET:.0f} CPU-seconds for the Normal resource class. CPU-seconds "
            "count parallelism, not wall clock. The lever that moves this ceiling is the admin "
            "`timeout_secs` sandbox setting, or a smaller single dataset; the run is refused "
            "rather than left to die to SIGXCPU."
        )
    return {"nnz": nnz, "estimated_resident_bytes": resident, "estimated_peak_bytes": peak,
            "peak_bytes_per_nnz": _PEAK_BYTES_PER_NNZ, "memory_budget_bytes": _MEM_BUDGET_BYTES,
            "estimated_cpu_seconds": cpu_secs, "cpu_seconds_budget": _CPU_SECS_BUDGET}


# ── the per-comparison `de/result` 2D gene-table writer (DEC-13 / INV-3 / INV-8) ────
def write_de_result(outputs_dir, rel_dir, name, gene_names, columns, *, regime,
                    multiplicity_family, aligned_to=None, extra_attrs=None):
    """Write ONE comparison's DE result as a 2D gene-axis annotation table (`de/result`).

    `columns` is a `{member_name: float array}` dict — the members ACTUALLY written for this
    comparison. INV-3 (absence-is-absence): the caller OMITS `neglog10p`/`padj`/`padj_across`
    from `columns` in R2/R3, so they are not written at all (absent, not zero, not one). INV-8:
    `neglog10p` is stored, never a raw `pval` (f32 p underflows to 0 among the top hits). Every
    stat member is a per-gene float over the SAME gene axis; the gene ids are the axis key.

    Returns `(structure, meta)` — the two declarations the manifest entry carries.
    """
    import cyto_zarr

    n = len(gene_names)
    dest = outputs_dir / rel_dir
    written = []
    with cyto_zarr.Table(dest, axis="genes", n=n, key="gene", aligned_to=aligned_to) as t:
        t.string("gene", [str(g) for g in gene_names])
        for member, arr in columns.items():
            a = np.asarray(arr, dtype=np.float64)
            if a.shape[0] != n:
                fail(f"de/result member {member!r} has {a.shape[0]} values but the gene axis "
                     f"declares {n}")
            t.numeric(member, a, dtype="float64")
            written.append(member)
        structure = t.close()
    meta = {"name": name, "axis": "genes", "n": n, "regime": regime,
            "multiplicity_family": multiplicity_family, "members": written,
            "entity_axis": "gene"}
    # regime + multiplicity_family + the p-absence record ride the store's attributes.cyto
    # AND the manifest structure (INV-8 G3/G4) — kept identical by stamp_cyto_attributes.
    attrs = {"regime": regime, "multiplicity_family": multiplicity_family,
             "entity_axis": "gene", "pvalues_written": "neglog10p" in written}
    if extra_attrs:
        attrs.update(extra_attrs)
    stamp_cyto_attributes(dest, structure, de=attrs)
    meta["de"] = attrs
    return structure, meta
