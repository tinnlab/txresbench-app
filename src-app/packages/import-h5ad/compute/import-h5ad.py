#!/usr/bin/env python3
# ruff: noqa
"""import-h5ad — CytoAnalyst sandbox compute processor (ITEM-9).

Reads an uploaded AnnData ``.h5ad`` dataset and re-emits it as typed workstore
outputs:

  * ``expression``      — the count matrix, single-file ``.h5ad`` (role=artifact)
  * ``metadata-column`` — one per obs column + the cell-id (barcode) index
                          (role=artifact)
  * ``inspect``         — the dataset TYPE-METADATA (obs/var names, shape,
                          layers, obsm, dtype, sparsity) as an inspect JSON the
                          H5adInspector view reads + the host uses to fill
                          ``datasets.metadata`` (role=intermediate)

The run contract (DESIGN §2, ``sandbox/outputs.rs``): read ``/inputs/<slot>`` +
``/inputs/inputs.json`` + ``/inputs/params.json``; write ``/outputs/<file>`` +
``/outputs/manifest.json`` = ``{"outputs":[{id,datatype,path,layout,role}]}``.
Progress lines ``phase|pct|message`` may go to ``$CYTO_PROGRESS_FIFO``.

The ``/inputs`` and ``/outputs`` roots are overridable via ``CYTO_INPUTS_DIR`` /
``CYTO_OUTPUTS_DIR`` (unset in the sandbox → the fixed ``/inputs`` / ``/outputs``
binds) — the ONLY seam that lets the harness drive the REAL script off-sandbox.
"""
import json
import os
import sys
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

# The shared output-format library (`_lib`, DEC-7) — staged into `/code` alongside every
# Python entry, same as `align` / `colsummary`. `cyto_columns` imports pandas lazily.
import cyto_deps
import cyto_columns

# ─────────────────────────── shared compute runtime ───────────────────────────
# Inlined (not imported) because the sandbox stages exactly ONE entry file at
# /code/entry.py (ITEM-5d) — a sibling import would not be staged. Kept identical
# across the three builtins' compute scripts.

# P2 datatype vocabulary → (datatype id, storage-layout string) the outputs
# manifest must declare (`datatype/builtin.rs`, `StorageLayout::as_str`).
DT_EXPRESSION = ("single-cell/expression", "chunked-sparse")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")
DT_REPORT_HTML = ("report/html", "opaque")
DT_EMBEDDING = ("embedding", "chunked-dense")


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


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")  # keep message in field 3
        parts.append(str(message))
    line = "|".join(parts)
    fifo = os.environ.get("CYTO_PROGRESS_FIFO")
    if fifo:
        # Persistent write fd: opened once, reused, closed at process exit — one
        # continuous stream to the runner's FIFO drain (streaming.rs), no per-frame
        # reopen churn. Retry the open if the reader was not ready on frame 1.
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
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    (outputs_dir / "manifest.json").write_text(
        json.dumps({"outputs": entries}, indent=2)
    )


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and
    `meta` (what they MEAN) are producer declarations with NO default on either side of
    the wire — artifact-model ITEM-5/6 — so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


def _jsonable(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


# ───────────────────────────────── processor ─────────────────────────────────

def sanitize_col_name(name):
    keep = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(name))
    return keep or "col"


def main():
    import anndata as ad

    inputs_dir, outputs_dir = io_dirs()
    p = params(inputs_dir)
    slots = load_inputs_index(inputs_dir)
    src = resolve_slot(
        slots,
        inputs_dir,
        prefer=("dataset", "anndata", "expression", "input", "h5ad"),
        patterns=("*.h5ad", "*.h5",),
    )
    if src is None:
        print("import-h5ad: no .h5ad input found under /inputs", file=sys.stderr)
        sys.exit(2)

    progress("reading", 5, f"read_h5ad {src.name}")
    adata = ad.read_h5ad(src)
    n_cells, n_genes = int(adata.n_obs), int(adata.n_vars)
    progress("read", 25, f"{n_cells} cells x {n_genes} genes")

    # Expression matrix (single-file .h5ad, CSC to match the declared
    # `chunked-sparse`/CSC datatype). X kept as-is (counts).
    if sp.issparse(adata.X):
        adata.X = adata.X.tocsc()
    expr_path = "expression.h5ad"
    progress("writing-expression", 45, "expression.h5ad")
    adata.write_h5ad(outputs_dir / expr_path)

    entries = [output_entry(
        "expression", DT_EXPRESSION, expr_path, "artifact",
        # The `.h5ad` passes through untouched — opaque bytes, declared as such.
        structure=cyto_columns.opaque("application/x-hdf5"),
        meta={"kind": "expression", "n_cells": n_cells, "n_genes": n_genes},
    )]

    # obs metadata-columns: the cell-id (barcode) index is ALWAYS emitted (it is
    # genuine per-cell metadata) + one column per obs column.
    import pandas as pd

    progress("metadata", 65, "obs columns")
    structure, meta = cyto_columns.write_metadata_column(
        outputs_dir, "metadata/cell_id.zarr", "cell_id",
        pd.Series(adata.obs_names.astype(str)), axis="cells")
    entries.append(output_entry(
        "metadata-column:cell_id", DT_METADATA_COLUMN, "metadata/cell_id.zarr", "artifact",
        structure=structure, meta=meta))
    for col in list(adata.obs.columns):
        rel = f"metadata/{sanitize_col_name(col)}.zarr"
        structure, meta = cyto_columns.write_metadata_column(
            outputs_dir, rel, str(col), adata.obs[col], axis="cells")
        entries.append(output_entry(
            f"metadata-column:{col}", DT_METADATA_COLUMN, rel, "artifact",
            structure=structure, meta=meta))

    # Dataset TYPE-METADATA (obs/var names, shape, layers, obsm, dtype, sparsity)
    # → the inspect JSON the H5adInspector reads + the host uses for datasets.metadata.
    progress("inspect", 85, "type-metadata")
    Xdt = adata.X.dtype if hasattr(adata.X, "dtype") else None
    inspect = {
        "datatype": "single-cell/anndata",
        "shape": {"cells": n_cells, "genes": n_genes},
        "obs_columns": [str(c) for c in adata.obs.columns],
        "var_columns": [str(c) for c in adata.var.columns],
        "obs_names_preview": [str(x) for x in adata.obs_names[:5]],
        "var_names_preview": [str(x) for x in adata.var_names[:5]],
        "layers": [str(k) for k in adata.layers.keys()],
        "obsm": [str(k) for k in adata.obsm.keys()],
        "varm": [str(k) for k in adata.varm.keys()],
        "uns": [str(k) for k in adata.uns.keys()],
        "X": {
            "dtype": str(Xdt) if Xdt is not None else None,
            "sparse": bool(sp.issparse(adata.X)),
            "format": getattr(adata.X, "format", None) if sp.issparse(adata.X) else "dense",
        },
        "n_metadata_columns": 1 + len(adata.obs.columns),
    }
    (outputs_dir / "inspect.json").write_text(json.dumps(inspect, indent=2, default=_jsonable))
    entries.append(output_entry(
        "inspect", DT_REPORT_HTML, "inspect.json", "intermediate",
        structure=cyto_columns.opaque("application/json"),
        meta={"kind": "inspect", "n_cells": n_cells, "n_genes": n_genes},
    ))

    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{len(entries)} outputs")
    print(f"import-h5ad: {n_cells}x{n_genes} → {len(entries)} outputs", file=sys.stderr)


if __name__ == "__main__":
    main()
