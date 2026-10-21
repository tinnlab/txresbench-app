#!/usr/bin/env python3
# ruff: noqa
"""gen_parity_fixtures — the COMMITTED, OUT-OF-BAND generator for the two-tier parity fixtures (#117).

## Read this before trusting `tests/test_parity.py`

Neither reference can run where the product runs, and that is a real limitation rather than a
detail:

  · The TIGHT reference is `pertpy.tools.Milo` with `solver="pydeseq2"`. `pertpy` requires
    Python >= 3.12 and pulls JAX (`flax`/`numpyro`/`ott-jax`); the analysis rootfs is a trimmed
    ~316 MB Python 3.11 venv, and #83 records the decision not to move it.
  · The LOOSE reference is edgeR's quasi-likelihood F-test — the family `miloR` uses. It needs R,
    which the rootfs deliberately dropped ("no R processor exists — re-add if one lands").

So both references are generated HERE, out of band, and only their DERIVED SUMMARY STATISTICS are
committed. This script is committed with them so the recipe is reproducible even though the run is
not in CI, and the fixture carries a provenance record (library versions, parameters, date). The
honest consequence, stated in the test that reads them: **a reference implementation that drifts
upstream will not be noticed automatically.** Re-run this script to refresh.

## What is committed, and why only this

Only derived summary statistics — per index cell: the reference `logFC`, `PValue`,
`SpatialFDR`/adjusted p, plus the `(sample × neighbourhood)` counts and the embedding the
neighbourhoods were built from. No primary biological data is redistributed, which closes the
licensing question by construction (#117 option 1). The embedding is SYNTHETIC and generated here
from a seed, so it carries no licence at all.

## Matching is BY INDEX CELL, so `prop` and `seed` travel with the fixture

The refinement step dedups, which makes `n_nhoods` itself seed-dependent. Without the committed
`prop`/`seed`/`k` the neighbourhoods cannot be matched across implementations and the comparison
is undefined.

## Running it

    # tight tier — a Python >= 3.12 interpreter with pertpy + pydeseq2
    /path/to/py312/bin/python tools/gen_parity_fixtures.py --tight

    # loose tier — an R with edgeR on the library path
    R_LIBS_USER=/path/to/Rlib python3 tools/gen_parity_fixtures.py --loose

Each writes into `tests/fixtures/parity/`. The two halves are independent; a host with only one
of the two toolchains can refresh only that half.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_FIXTURES = _PKG / "tests" / "fixtures" / "parity"

# ── the committed determinism parameters. CHANGING ANY OF THESE INVALIDATES THE FIXTURE ──
N_CELLS = 500
N_DIMS = 8
N_SAMPLES = 8
DATA_SEED = 11
PROP = 0.1
SEED = 0
K = 15
CONTRAST = ("treat", "ctrl")


def synthetic_dataset():
    """The embedding + per-cell labels both references and our pipeline are run on. Synthetic and
    seeded, so nothing licensed is redistributed and the fixture is reproducible from this file."""
    rng = np.random.default_rng(DATA_SEED)
    X = rng.normal(size=(N_CELLS, N_DIMS)).astype(np.float32)
    X[:150, 0] += 5.0                       # one well-separated region…
    samples = [f"s{i % N_SAMPLES}" for i in range(N_CELLS)]
    conditions = ["ctrl" if (i % N_SAMPLES) < N_SAMPLES // 2 else "treat" for i in range(N_CELLS)]
    # …whose treated share is inflated, so the fixture carries a real effect to compare on.
    keep = np.array([not (i < 150 and conditions[i] == "ctrl" and i % 3 == 0)
                     for i in range(N_CELLS)])
    X = X[keep]
    samples = [s for s, k in zip(samples, keep) if k]
    conditions = [c for c, k in zip(conditions, keep) if k]
    return X, samples, conditions


def _fixture_provenance(kind, extra):
    return {
        "kind": kind,
        "generated_by": "src-app/packages/differential-abundance/tools/gen_parity_fixtures.py",
        "generated_at_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataset": "SYNTHETIC — generated from DATA_SEED by this script; no primary data is "
                   "redistributed and no licence applies",
        "parameters": {"n_cells": N_CELLS, "n_dims": N_DIMS, "n_samples": N_SAMPLES,
                       "data_seed": DATA_SEED, "prop": PROP, "seed": SEED, "k": K,
                       "contrast": list(CONTRAST)},
        "limitation": ("generated OUT OF BAND. This reference cannot run in the analysis rootfs, "
                       "in the sandbox or in CI, so an upstream change to it will NOT be noticed "
                       "automatically — re-run this script to refresh."),
        **extra,
    }


# ── TIGHT: pertpy.tools.Milo(solver="pydeseq2"), the same statistical engine we implement ──
def generate_tight(out_dir: Path):
    import anndata as ad
    import importlib.metadata as md
    import pandas as pd
    import scanpy as sc
    from pertpy.tools import Milo

    X, samples, conditions = synthetic_dataset()
    obs = pd.DataFrame({"sample": samples, "cond": conditions},
                       index=[f"c{i}" for i in range(X.shape[0])])
    adata = ad.AnnData(X=X.copy(), obs=obs)
    adata.obsm["X_pca"] = X.copy()
    sc.pp.neighbors(adata, use_rep="X_pca", n_neighbors=K, random_state=SEED)

    milo = Milo()
    mdata = milo.load(adata)
    milo.make_nhoods(mdata["rna"], prop=PROP, seed=SEED)
    mdata = milo.count_nhoods(mdata, sample_col="sample")
    milo.da_nhoods(mdata, design="~cond", solver="pydeseq2")

    cells = mdata["rna"].obs_names
    refined = mdata["rna"].obs["nhood_ixs_refined"] == 1
    index_cells = [int(str(c)[1:]) for c in cells[refined]]
    counts = np.asarray(mdata["milo"].X.todense()).astype(int)      # (samples × nhoods)
    var = mdata["milo"].var

    payload = {
        "provenance": _fixture_provenance("tight", {
            "reference": "pertpy.tools.Milo(solver='pydeseq2')",
            "library_versions": {
                "python": sys.version.split()[0],
                "pertpy": md.version("pertpy"),
                "pydeseq2": md.version("pydeseq2"),
                "scanpy": md.version("scanpy"),
                "anndata": md.version("anndata"),
                "numpy": md.version("numpy"),
                "scipy": md.version("scipy"),
            },
            "note": ("pertpy exposes solver='pydeseq2' only from 1.3.0; 0.10.x/0.11.x offer only "
                     "'edger'/'batchglm' and require rpy2 + edgeR."),
        }),
        "embedding": X.tolist(),
        "samples": samples,
        "conditions": conditions,
        "sample_levels": sorted(set(samples)),
        "index_cells": index_cells,
        "kth_distance": [float(v) for v in var["kth_distance"].values],
        "counts": counts.tolist(),
        "logFC": [float(v) for v in var["logFC"].values],
        "PValue": [float(v) for v in var["PValue"].values],
        "SpatialFDR": [float(v) for v in var["SpatialFDR"].values],
    }
    out = out_dir / "tight_pertpy_pydeseq2.json"
    out.write_text(json.dumps(payload, indent=1))
    print(f"wrote {out} ({len(index_cells)} neighbourhoods)")


# ── LOOSE: edgeR's quasi-likelihood F-test, the family miloR uses ──────────────────
_EDGER_R = r"""
.libPaths(c(Sys.getenv("DA_RLIB"), .libPaths()))
suppressMessages(library(edgeR))
suppressMessages(library(jsonlite))
args <- commandArgs(trailingOnly = TRUE)
payload <- jsonlite::fromJSON(args[1])
counts <- t(payload$counts)                 # edgeR wants (features x samples)
group  <- factor(payload$condition_per_sample, levels = c("ctrl", "treat"))
lib    <- colSums(counts)
design <- model.matrix(~ group)
dge <- DGEList(counts = counts, lib.size = lib)
dge <- calcNormFactors(dge, method = "TMM")
dge <- estimateDisp(dge, design)
fit <- glmQLFit(dge, design, robust = TRUE)
res <- as.data.frame(topTags(glmQLFTest(fit, coef = ncol(design)), sort.by = "none", n = Inf))
cat(jsonlite::toJSON(list(logFC = res$logFC, PValue = res$PValue, FDR = res$FDR,
                          edgeR = as.character(packageVersion("edgeR")),
                          R = R.version.string), auto_unbox = TRUE))
"""


def generate_loose(out_dir: Path, tight_path: Path):
    """Runs edgeR on the SAME neighbourhoods and the SAME `(nhood × sample)` counts the tight
    fixture carries, so the two tiers differ ONLY in the statistical test — which is the whole
    point of having two tiers. Requires R with edgeR and jsonlite on the library path."""
    tight = json.loads(tight_path.read_text())
    per_sample = {}
    for s, c in zip(tight["samples"], tight["conditions"]):
        per_sample[s] = c
    payload = {"counts": tight["counts"],
               "condition_per_sample": [per_sample[s] for s in tight["sample_levels"]]}
    tmp = out_dir / "_edger_input.json"
    tmp.write_text(json.dumps(payload))
    script = out_dir / "_edger.R"
    script.write_text(_EDGER_R)
    proc = subprocess.run(["Rscript", str(script), str(tmp)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"edgeR run failed:\n{proc.stdout}\n{proc.stderr}")
    res = json.loads(proc.stdout)
    tmp.unlink()
    script.unlink()

    out = out_dir / "loose_edger_ql.json"
    out.write_text(json.dumps({
        "provenance": _fixture_provenance("loose", {
            "reference": "edgeR quasi-likelihood F-test (glmQLFit + glmQLFTest, robust=TRUE), "
                         "the family miloR uses",
            "library_versions": {"R": res["R"], "edgeR": res["edgeR"]},
            "note": ("exact numeric parity with edgeR is NOT achievable and is NOT claimed: "
                     "edgeR uses a quasi-likelihood F-test and this package uses PyDESeq2's Wald "
                     "test. The loose tier asserts rank/sign agreement, not equality."),
        }),
        "index_cells": tight["index_cells"],
        "logFC": res["logFC"],
        "PValue": res["PValue"],
        "FDR": res["FDR"],
    }, indent=1))
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tight", action="store_true", help="regenerate the pertpy/pydeseq2 fixture")
    ap.add_argument("--loose", action="store_true", help="regenerate the edgeR fixture")
    ap.add_argument("--out", default=str(_FIXTURES))
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.tight:
        generate_tight(out_dir)
    if args.loose:
        generate_loose(out_dir, out_dir / "tight_pertpy_pydeseq2.json")
    if not (args.tight or args.loose):
        ap.error("choose --tight and/or --loose")


if __name__ == "__main__":
    main()
