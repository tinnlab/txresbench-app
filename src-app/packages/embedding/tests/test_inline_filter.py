#!/usr/bin/env python3
# ruff: noqa
"""TEST-18 [acceptance] [invariant: INV-12] [covers: ITEM-17b, ITEM-2b, ITEM-14a, ITEM-14b]
— the INLINE metadata filter.

Three claims, each a real, silent-at-rc-0 defect if broken:

  1. INV-12 RE-DERIVE-ON-SUBSET — a filtered single-dataset reduce re-derives its embedding
     on the SURVIVING subset; the coordinates are NOT the corresponding rows sliced out of
     the full-run embedding (a UMAP/PCA of a subset is not a crop of the whole, doc-09 §A.6
     R1). The fit saw only survivors because the matrix was subset AT READ (ITEM-17b).
  2. The predicate is `cell-filter`'s SHIPPED `criteria_keep_mask` — VENDORED VERBATIM
     (DEC-11), not a fourth dialect: this copy and cell-filter's real kernel BOTH agree with
     the shared coercion corpus, cell-for-cell, in both obs dtype flavours; and the vendored
     source is byte-identical to the kernel it copies.
  3. Missing values are EXCLUDED (`np.isfinite`, ITEM-14b) — the inverse of the legacy
     NA→pass defect; an empty / absent criterion is NO CONSTRAINT (ITEM-14a).
"""
import importlib.util
import inspect
import json
import os
from pathlib import Path

import numpy as np
import pytest

# `embedding_fixtures` puts `_lib` on sys.path (cell-filter.py imports `txr_columns`).
from embedding_fixtures import counts_matrix, import_own

_HERE = Path(__file__).resolve().parent          # …/packages/embedding/tests
_PACKAGES = _HERE.parents[1]                      # …/packages
_SRC_APP = _HERE.parents[2]                       # …/src-app
_CF_SCRIPT = _PACKAGES / "cell-filter" / "compute" / "cell-filter.py"
_CORPUS = _SRC_APP / "testdata" / "criteria-coercion-corpus.json"

# The VENDORED kernel (embedding/compute/_criteria.py), loaded under a namespaced
# `sys.modules` key via `import_own` — a bare `import _criteria` would resolve through the
# shared pytest session's flat namespace to whichever package's `_criteria.py` won the
# sys.path race (differential-expression ships its own vendored copy).
EMB = import_own("_criteria")


def _load_cellfilter():
    """cell-filter's REAL `criteria_keep_mask`, imported off-sandbox (the module name has a
    hyphen, so importlib by path — the same way cell-filter's own corpus test loads it)."""
    spec = importlib.util.spec_from_file_location("cellfilter_kernel_ref", str(_CF_SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CF = _load_cellfilter()

_SPECIALS = {"inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}


def _decode(v):
    if isinstance(v, dict) and set(v) == {"$special"}:
        return _SPECIALS[v["$special"]]
    if isinstance(v, list):
        return [_decode(x) for x in v]
    return v


def _corpus_cases():
    with open(_CORPUS, encoding="utf-8") as fh:
        return json.load(fh)["cases"]


CASES = _corpus_cases()


# ── claim 2a — VENDORED kernel == cell-filter's real kernel == corpus, cell-for-cell ──
@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
@pytest.mark.parametrize("flavour", ["list", "object"])
def test_vendored_predicate_matches_cellfilter_on_shared_corpus(case, flavour):
    obs = {k: [_decode(x) for x in v] for k, v in case["obs"].items()}
    n = max((len(v) for v in obs.values()), default=0)
    cols = obs if flavour == "list" else {k: np.array(v, dtype=object) for k, v in obs.items()}
    want = case["expect"]
    emb_mask = [bool(x) for x in np.asarray(EMB.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    cf_mask = [bool(x) for x in np.asarray(CF.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    # the vendored copy matches the corpus AND the real kernel — one dialect, not four
    assert emb_mask == want, (case["id"], case.get("why"))
    assert emb_mask == cf_mask, (case["id"], "vendored kernel diverged from cell-filter")


# ── claim 2b — the vendored SOURCE is byte-identical to the kernel it copies ──────────
@pytest.mark.parametrize("fn", [
    "criteria_keep_mask", "_is_categorical_criterion", "_is_spellable_scalar",
    "_value_float", "_trim_column", "_bound_or_none",
])
def test_vendored_kernel_source_is_byte_identical_to_cellfilter(fn):
    # A behavioural drift would already redden the corpus test above; this pins the SOURCE
    # so a hand-edit of the vendored copy (DEC-11 "verbatim, not forked") is caught directly.
    assert inspect.getsource(getattr(EMB, fn)) == inspect.getsource(getattr(CF, fn)), fn


def test_vendored_module_regex_and_ws_constants_match():
    assert EMB._DECIMAL_BOUND.pattern == CF._DECIMAL_BOUND.pattern
    assert EMB._VALUE_WS == CF._VALUE_WS


# ── claim 1 — INV-12: a filtered reduce RE-DERIVES on the subset, is not a crop ───────
def test_filtered_reduce_rederives_on_subset_not_a_crop(reduce_run):
    dense = counts_matrix(60, 40, seed=5)
    groups = ["A"] * 30 + ["B"] * 30  # cells 0..29 = A, 30..59 = B

    # FULL run: bind the column but pass NO criteria → all 60 cells embedded, in axis order.
    full = reduce_run()
    full.add_matrix(dense)
    full.add_column(groups, slot="column:group")
    full.run_ok({"n_hvg": 20, "n_pcs": 8})
    full_emb = full.embedding_array()
    assert full_emb.shape == (60, 8)
    assert full.report()["filter"]["applied"] is False

    # FILTERED run: keep only group A. The surviving cells are original indices 0..29, so the
    # crop of the full embedding for those cells is `full_emb[:30]`.
    filt = reduce_run()
    filt.add_matrix(dense)
    filt.add_column(groups, slot="column:group")
    filt.run_ok({"n_hvg": 20, "n_pcs": 8, "criteria": [{"column": "group", "keep": ["A"]}]})
    filt_emb = filt.embedding_array()

    # embedded EXACTLY the survivors (no synthesized cell, no dropped survivor)
    assert filt_emb.shape == (30, 8)
    # …and the coordinates are RE-DERIVED, not the sliced rows of the full layout (INV-12):
    # HVG + PCA were re-fit on the 30-cell subset, so the subset's basis is its own.
    crop = full_emb[:30]
    assert not np.allclose(filt_emb, crop, atol=1e-3), (
        "the filtered embedding equals the crop of the full embedding — it was sliced from a "
        "global layout, not re-derived on the subset (INV-12 violated)")


def test_filter_report_records_cells_in_kept_and_exact_predicate(reduce_run):
    # OD-3 / ITEM-24 — per dataset: cells-in, cells-kept, and the EXACT predicate per column.
    dense = counts_matrix(50, 30, seed=6)
    labels = (["T"] * 20) + (["B"] * 15) + (["NK"] * 15)
    run = reduce_run()
    run.add_matrix(dense)
    run.add_column(labels, slot="column:cell_type")
    run.run_ok({"n_hvg": 15, "n_pcs": 6,
                "criteria": [{"column": "cell_type", "keep": ["T", "NK"]}]})
    f = run.report()["filter"]
    assert f["applied"] is True
    assert f["cells_in"] == 50
    assert f["cells_kept"] == 35  # 20 T + 15 NK
    col = next(c for c in f["columns"] if c["column"] == "cell_type")
    assert col["kind"] == "categorical"
    assert col["predicate"] == {"keep": ["T", "NK"]}
    assert col["present"] is True


# ── claim 3 — missing values EXCLUDED; empty/absent criterion is NO CONSTRAINT ────────
def test_missing_values_are_excluded_by_a_range_criterion(reduce_run):
    # ITEM-14b — a NaN in a filtered column is DROPPED (np.isfinite), never NA→pass.
    dense = counts_matrix(40, 25, seed=7)
    score = [float(i) for i in range(40)]
    score[3] = float("nan")
    score[17] = float("nan")   # two non-finite cells inside the [0, 100] band
    run = reduce_run()
    run.add_matrix(dense)
    run.add_column(score, slot="column:score")
    run.run_ok({"n_hvg": 12, "n_pcs": 6,
                "criteria": [{"column": "score", "min": "0", "max": "100"}]})
    f = run.report()["filter"]
    # all 40 scores are within [0,100] EXCEPT the two NaN, which are excluded → 38 kept.
    assert f["cells_in"] == 40
    assert f["cells_kept"] == 38, "a NaN cell passed a numeric threshold (NA→pass defect)"
    assert run.embedding_array().shape[0] == 38


def test_empty_and_absent_criteria_impose_no_constraint(reduce_run):
    # ITEM-14a — an empty keep-set and a criterion on an absent column both keep every cell.
    dense = counts_matrix(30, 20, seed=8)
    run = reduce_run()
    run.add_matrix(dense)
    run.add_column(["A"] * 15 + ["B"] * 15, slot="column:group")
    run.run_ok({"n_hvg": 10, "n_pcs": 5, "criteria": [
        {"column": "group", "keep": []},         # empty keep-set → no constraint
        {"column": "not_a_column", "min": "0"},  # absent column → no constraint
    ]})
    f = run.report()["filter"]
    # criteria present but nothing constrains → not "applied", all cells kept.
    assert f["cells_kept"] == 30
    assert f["applied"] is False
    assert run.embedding_array().shape[0] == 30


def test_below_threshold_survivors_refuse_post_filter(reduce_run):
    # DEC-6 / INV-2 — the small-sample refuse evaluates on POST-FILTER counts.
    dense = counts_matrix(40, 20, seed=9)
    keep_flag = (["keep"] * 5) + (["drop"] * 35)  # only 5 survive, below the threshold of 10
    run = reduce_run()
    run.add_matrix(dense)
    run.add_column(keep_flag, slot="column:sel")
    proc = run.run({"n_hvg": 10, "n_pcs": 4, "criteria": [{"column": "sel", "keep": ["keep"]}]})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "survive the inline filter" in diag and "viable threshold" in diag
