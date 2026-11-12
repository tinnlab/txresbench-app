#!/usr/bin/env python3
# ruff: noqa
"""demo-analysis — TxResBench synthetic-demo sandbox compute processor.

A deterministic, INPUT-FREE analysis for driving the workbench launch → run →
review e2e flow on a FRESH project (NO seeded input artifacts). It generates
synthetic per-entity data internally (N=500 entities by default) and emits ONE
artifact so the run finalize ingests a real catalog row into the workstore and
the result-review surfaces it.

  * ``demo_table`` — a two-column Zarr table (role=artifact) written by
    ``txr_zarr.Table``: a string entity id and a categorical group label sharing
    one axis, one row per synthetic entity (ITEM-4/26; it was a JSON
    ``{columns, rows}`` blob the client had to parse whole before painting).
    Typed as a UNIVERSAL ROOT rather than a contributed datatype — see
    ``DT_DEMO_TABLE`` for why a file in a reserved framework package may not name
    one (INV-5) and what that costs.

IGNORES any input (reads no ``/inputs`` slots — works with an empty inputs dir).
Reads OPTIONAL ``/inputs/params.json``:
  * ``resolution`` (number) — higher ⇒ finer clustering ⇒ more clusters. The
    synthetic cluster count is ``clamp(round(resolution * 10), 2, 20)``.
  * ``n_cells`` (int, optional) — synthetic cell count (default 500, capped).
  * ``seed`` (int, optional) — makes the synthetic assignment reproducible.
An absent file / absent / oddly-typed params degrade to the defaults (no error).

Roots overridable via ``TXR_INPUTS_DIR`` / ``TXR_OUTPUTS_DIR``. Progress →
``$TXR_PROGRESS_FIFO``. Completes in well under 15s (pure stdlib + numpy on 500
rows).
"""
import json
import os
import sys
from pathlib import Path

# Single-thread the numeric stack BEFORE numpy import: the sandbox caps PIDs, and
# the BLAS/OpenMP thread pools otherwise exhaust it (`pthread_create: Resource
# temporarily unavailable`). Also makes the compute deterministic.
for _v in (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
):
    os.environ.setdefault(_v, "1")

import numpy as np

# The shared output-format library (`_lib`, DEC-7) — staged into `/code` alongside
# every Python entry, same as `align` / `colsummary`.
import txr_zarr

# ─────────────────────────── shared compute runtime ───────────────────────────
# (datatype id, storage_layout string) — it must resolve in the registry, must not
# be abstract, and the layout must equal the one its datatype declares, or the
# workstore ingest's `validate_artifact_typing` rejects the artifact (422).
#
# It is a UNIVERSAL ROOT (`datatype/builtin.rs`), not a contributed one, and that is
# forced rather than chosen: this file lives in the RESERVED `_helpers` package, which
# contributes no datatype and is scanned by `scripts/check-derived-vocabulary.sh`, so
# naming another package's contributed datatype id here is an INV-5 leak — framework
# code speaking a domain it must not know. It previously declared a contributed
# single-cell datatype, which the guard did not see only because its scanned surface
# stopped at the sibling `_lib`.
#
# `data/opaque` is the concrete opaque leaf (the `data` ROOT is abstract and ingest
# refuses an artifact declared directly of an abstract type); same declaration
# `anndata-import` and `annotation-integrate` use for their non-domain outputs. The
# layout string is only ever compared at ingest — ITEM-7 dropped the `storage_layout`
# COLUMN, so nothing downstream reads it — and the artifact's real decode contract is
# the `structure` below, which says exactly what the bytes are (`zarr_v3` / `table`).
#
# COST, stated: a root datatype declares no capabilities, so this artifact is not
# picked up by a capability-filtered channel the way a contributed domain type would
# be. The deeper fix is to re-home this demo into a CONTRIBUTED package, where domain
# vocabulary is legitimate; that move owns server tables this package does not.
DT_DEMO_TABLE = ("data/opaque", "opaque")

# The run-local handle for the single emitted output (`manifest.json` entry `id`, and
# the directory it lands in). A LABEL, not a type: it is part of the artifact's natural
# key and shows in the result surface, and nothing branches on its value.
OUTPUT_ID = "demo_table"

# Guard rails on the synthetic sizes so a hostile/odd params.json can't blow up
# the run (keeps it deterministic + fast, <15s).
DEFAULT_N_CELLS = 500
MAX_N_CELLS = 50_000
MIN_CLUSTERS = 2
MAX_CLUSTERS = 20


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
    p = read_json(inputs_dir / "params.json", {})
    return p if isinstance(p, dict) else {}


def as_number(val, default):
    """Best-effort numeric coercion; any non-number (absent/None/str/junk) →
    default. Tolerates the 'any params' contract without raising."""
    try:
        if isinstance(val, bool):  # bool is an int subclass — treat as absent
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


_PROGRESS_FD = [-1]  # persistent FIFO write fd (index 0), lazily opened


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


def write_manifest(outputs_dir, entries):
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and
    `meta` (what they MEAN) are producer declarations with NO default on either side of
    the wire — artifact-model ITEM-5/6 — so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


def main():
    _inputs_dir, outputs_dir = io_dirs()
    # NOTE: input is deliberately IGNORED (no `/inputs` slots read) — the demo
    # generates its own synthetic data so it runs on a fresh, empty project.
    p = params(_inputs_dir)

    seed = int(as_number(p.get("seed"), 0))
    rng = np.random.default_rng(seed)

    resolution = as_number(p.get("resolution"), 0.6)
    # Clamp resolution into the FE field's advertised [0.1, 2] range, then derive
    # the synthetic cluster count deterministically: higher resolution ⇒ finer ⇒
    # more clusters (matches the analysis' `resolution` doc: "higher = finer").
    resolution = min(max(resolution, 0.1), 2.0)
    n_clusters = int(round(resolution * 10))
    n_clusters = min(max(n_clusters, MIN_CLUSTERS), MAX_CLUSTERS)

    n_cells = int(as_number(p.get("n_cells"), DEFAULT_N_CELLS))
    n_cells = min(max(n_cells, 1), MAX_N_CELLS)

    progress("generating", 25, f"{n_cells} cells, {n_clusters} clusters")

    # Deterministic synthetic clustering: assign each cell to a cluster. A mild
    # Zipf-ish weighting makes cluster sizes uneven (realistic), all seeded so the
    # same (seed, resolution, n_cells) reproduces the same labels.
    weights = 1.0 / (1.0 + np.arange(n_clusters, dtype=float))
    weights /= weights.sum()
    labels = rng.choice(n_clusters, size=n_cells, p=weights)

    progress("writing-table", 75, f"{OUTPUT_ID}.zarr")
    # ITEM-4/26: ONE artifact directory holding the two columns that share the `cells`
    # axis — a string entity id and a categorical group label. This was a JSON
    # `{columns, rows}` blob the client had to parse whole before painting anything.
    cluster_levels = [str(i) for i in range(n_clusters)]
    rel = f"{OUTPUT_ID}.zarr"
    with txr_zarr.Table(outputs_dir / rel, axis="cells", n=n_cells) as t:
        t.string("cell", [f"cell_{i}" for i in range(n_cells)])
        t.categorical("cluster", codes=labels, levels=cluster_levels)
        structure = t.close()

    entries = [output_entry(
        OUTPUT_ID, DT_DEMO_TABLE, rel, "artifact",
        structure=structure,
        # No `kind`: the display vocabulary `kind` belongs to (`colsummary` /
        # `txr_columns.KIND_*` — a legend or a colormap) describes ONE COLUMN, and this
        # artifact is a two-column table, so no value of it would be true here. It used
        # to hold a contributed datatype id, which was neither that vocabulary nor
        # anything a consumer reads (nothing resolves `meta.kind`; `meta.is_axis_index`
        # is the only key any consumer keys on) — a domain literal in framework code
        # (INV-5) with no reader to justify it.
        meta={"axis": "cells", "n": n_cells, "levels": cluster_levels,
              "resolution": resolution, "seed": seed},
    )]
    write_manifest(outputs_dir, entries)

    # Distinct cluster labels actually assigned (a size-1 tail cluster may get 0
    # cells at tiny n_cells — report what's real).
    n_used = int(np.unique(labels).size)
    progress("done", 100, f"{n_cells} cells → {n_used} clusters")
    print(
        f"demo-analysis: {n_cells} synthetic cells, {n_used} clusters "
        f"(resolution={resolution}, seed={seed})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
