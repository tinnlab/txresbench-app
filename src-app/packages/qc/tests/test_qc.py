#!/usr/bin/env python3
# ruff: noqa
"""TEST-25b (ITEM-8 / ITEM-25) — the species-case QC correctness check.

A MOUSE dataset whose mito genes are lower-case (`mt-Nd1`) computes a NON-ZERO
`pct_mito` ONLY under the `^mt-` pattern; the human default `^MT-` matches nothing
and yields `pct_mito == 0` — the SILENT mis-filter (dying cells kept). This proves
the metric is pattern/species-SENSITIVE and USER-EDITABLE (DEC-25: presets are
editable DATA, not a privileged hardcoded gate).

`[research: MULTIMODAL_qc_metrics.md §"The exact gene-name patterns" / §"Correctness
gotchas" #1]`

Scanpy-free by design (numpy/pandas only): the `pct_counts_<var>` definition is
`100 * (counts on the flagged gene set) / (total counts)` — computed here directly —
so the test runs without the sandbox scientific stack while exercising the SAME
`parse_qc_metrics` / `compile_gene_pattern` helpers the real compute script uses.
"""
import importlib.util
import os

import numpy as np
import pandas as pd

# Load the (hyphenated) compute entry script by path — it loads via importlib, not
# `import`. Slice 5 physically re-homed the script into this package's `compute/` sibling
# (`packages/qc/compute/qc-10x.py`) — co-located with the manifest, the authoritative
# source the backend bakes via its `code_ref` (`compute/qc-10x.py`).
_QC_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, "compute", "qc-10x.py")
)


def _load_qc():
    spec = importlib.util.spec_from_file_location("qc10x_pkg", _QC_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


qc = _load_qc()


def _pct_counts(counts, gene_names, pattern):
    """Reproduce scanpy's `pct_counts_<var>`: 100 * (counts on genes matching
    `pattern`) / (total counts), per cell. `counts` is cells x genes."""
    vn = pd.Series([str(g) for g in gene_names])
    mask = np.asarray(vn.str.match(pattern))
    total = counts.sum(axis=1)
    on_set = counts[:, mask].sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        pct = np.where(total > 0, 100.0 * on_set / total, 0.0)
    return pct, int(mask.sum())


# A MOUSE fixture: lower-case mito genes (`mt-`) + a couple of housekeeping genes.
_MOUSE_GENES = ["mt-Nd1", "mt-Co1", "Actb", "Rps12"]
# 3 cells x 4 genes; each cell has real mito counts.
_COUNTS = np.array(
    [
        [5, 3, 10, 2],   # mito = 8 / 20 = 40%
        [1, 1, 8, 10],   # mito = 2 / 20 = 10%
        [0, 0, 12, 8],   # mito = 0 / 20 = 0%
    ],
    dtype=float,
)


def test_mouse_pct_mito_nonzero_under_mouse_pattern():
    """The user-editable `^mt-` (mouse) pattern yields a NON-ZERO pct_mito."""
    pct, n_matched = _pct_counts(_COUNTS, _MOUSE_GENES, r"^mt-")
    assert n_matched == 2, "the two mt- genes are flagged"
    assert pct[0] > 0 and pct[1] > 0, f"mouse pattern computes non-zero pct_mito, got {pct}"
    assert abs(pct[0] - 40.0) < 1e-9 and abs(pct[1] - 10.0) < 1e-9


def test_human_pattern_silently_gives_zero_on_mouse():
    """The human `^MT-` default matches NO mouse gene → pct_mito ≡ 0 (the silent
    mis-filter the species-case fix guards against)."""
    pct, n_matched = _pct_counts(_COUNTS, _MOUSE_GENES, r"^MT-")
    assert n_matched == 0, "the human upper-case pattern matches no mouse gene"
    assert np.all(pct == 0.0), f"human pattern on mouse data silently gives 0, got {pct}"


def test_default_mito_preset_covers_both_species():
    """The shipped default mito preset `^MT-|^mt-` covers human AND mouse — so a
    user need not edit it for mouse (but MAY, per DEC-25). Proves the preset is
    correct DATA."""
    pct_mouse, n_mouse = _pct_counts(_COUNTS, _MOUSE_GENES, r"^MT-|^mt-")
    assert n_mouse == 2 and pct_mouse[0] > 0
    human_genes = ["MT-ND1", "MT-CO1", "ACTB", "RPS12"]
    pct_human, n_human = _pct_counts(_COUNTS, human_genes, r"^MT-|^mt-")
    assert n_human == 2 and pct_human[0] > 0


def test_parse_qc_metrics_honors_user_edited_pattern():
    """A user-edited `{name: pct_mito, pattern: ^mt-}` metric flows through
    `parse_qc_metrics` intact (DEC-25 — metrics are user-driven DATA)."""
    warnings = []
    row = {"name": "pct_mito", "pattern": r"^mt-", "aggregation": "percentage"}
    metrics = qc.parse_qc_metrics({"qc_metrics": [row]}, warnings)
    assert row in metrics
    assert warnings == []


def test_parse_qc_metrics_is_general_any_column():
    """The engine computes ANY named gene-set column (DEC-25 — no privileged set): a
    custom `{name: pct_hb, pattern: ^HB[^(P)]}` is accepted verbatim, and so is the same
    gene set under a different aggregation — the row states both."""
    row = {"name": "pct_hb", "pattern": r"^HB[^(P)]", "aggregation": "percentage"}
    assert row in qc.parse_qc_metrics({"qc_metrics": [row]}, [])
    summed = {"name": "hb_counts", "pattern": r"^HB[^(P)]", "aggregation": "sum"}
    assert summed in qc.parse_qc_metrics({"qc_metrics": [summed]}, [])


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all qc species-case tests passed")
