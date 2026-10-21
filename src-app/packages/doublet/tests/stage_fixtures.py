#!/usr/bin/env python3
# ruff: noqa
"""Stage the RAW-count fixture this package's science tier needs.

    python3 src-app/packages/doublet/tests/stage_fixtures.py

Writes `.cyto-cache/fixtures/pbmc3k_raw.h5ad` — `sc.datasets.pbmc3k()` (2,700 x 32,738 RAW
UMIs) with a `cell_type` obs column carrying the published `louvain` cell-type labels from
`sc.datasets.pbmc3k_processed()`, joined BY BARCODE (the 62 barcodes the processed object
dropped become `unassigned`).

Why a new fixture at all: `.cyto-cache/fixtures/pbmc68k_reduced.h5ad`, the fixture already
in the tree, is **normalized and scaled**. Scrublet does its own total-count normalize, HVG
selection and PCA internally, so feeding it normalized data silently produces meaningless
scores — the compute refuses it outright. A raw-count method needs a raw-count fixture.

Why the labels: the ground-truth validity suite constructs HETEROTYPIC synthetic doublets by
summing pairs of cells drawn from DIFFERENT lineages. That construction needs published cell
types; it is not something the fixture can be asked to guess.

`.cyto-cache/` is gitignored — this is the repo's documented fixture-staging convention
(README.md; the `e2e-processors` recipe exports `CYTO_E2E_FIXTURES` from the same directory).
Downloads land in `.cyto-cache/scanpy-datasets/` rather than scanpy's default `./data`, so a
staging run never leaves an untracked directory in the working tree.
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[3]
FIXTURE_DIR = REPO_ROOT / ".cyto-cache" / "fixtures"
DATASET_DIR = REPO_ROOT / ".cyto-cache" / "scanpy-datasets"
FIXTURE = FIXTURE_DIR / "pbmc3k_raw.h5ad"

EXPECTED_SHAPE = (2700, 32738)
CELL_TYPE_COLUMN = "cell_type"
UNASSIGNED = "unassigned"


def stage(force: bool = False) -> Path:
    import numpy as np
    import pandas as pd
    import scanpy as sc

    if FIXTURE.is_file() and not force:
        print(f"already staged: {FIXTURE}")
        return FIXTURE

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    sc.settings.datasetdir = DATASET_DIR

    raw = sc.datasets.pbmc3k()                 # 2,700 x 32,738 RAW UMIs
    processed = sc.datasets.pbmc3k_processed()  # 2,638 cells with published `louvain` labels

    if tuple(raw.shape) != EXPECTED_SHAPE:
        raise SystemExit(
            f"pbmc3k() returned {tuple(raw.shape)}, expected {EXPECTED_SHAPE} — the upstream "
            "dataset moved; the fixture's declared shape must be updated deliberately, not "
            "silently absorbed"
        )
    values = np.asarray(raw.X.data if hasattr(raw.X, "data") else raw.X)
    if values.size and not np.all(values == np.round(values)):
        raise SystemExit("pbmc3k() did not return integer counts — this fixture must be RAW")

    labels = pd.Series(UNASSIGNED, index=raw.obs_names, dtype=object)
    common = raw.obs_names.intersection(processed.obs_names)
    labels.loc[common] = processed.obs.loc[common, "louvain"].astype(str).values
    raw.obs[CELL_TYPE_COLUMN] = pd.Categorical(labels.values)
    raw.var_names_make_unique()

    raw.write_h5ad(FIXTURE)
    counts = raw.obs[CELL_TYPE_COLUMN].value_counts().to_dict()
    print(f"staged {FIXTURE}  shape={tuple(raw.shape)}  cell_type={counts}")
    return FIXTURE


if __name__ == "__main__":
    stage(force="--force" in sys.argv[1:])
