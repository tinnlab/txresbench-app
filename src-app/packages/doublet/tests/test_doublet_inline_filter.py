#!/usr/bin/env python3
# ruff: noqa
"""The inline pre-filter and the `not_evaluated` level.

TEST-4b [acceptance] [invariant: INV-3] [covers: ITEM-14, ITEM-15] — a pre-filtered-out cell
        is `not_evaluated` with a NaN score, never `singlet`; the columns stay full-length in
        input order; and the survivors' scores are IDENTICAL to a run over the pre-subset
        matrix alone (so the excluded cells contributed nothing to the simulation or the kNN).
TEST-13 [acceptance] [invariant: INV-9] [covers: ITEM-13] — the vendored `_criteria.py` is
        source-identical to `cell-filter`'s kernel and agrees with it cell-for-cell on the
        shared coercion corpus.

── Why an inline filter at all ──────────────────────────────────────────────────────────
Best practice is to score the QC-FILTERED matrix — junk cells skew the simulated-doublet
population and the kNN density. TxResBench cannot express that directly, and the reason is
architectural rather than an oversight: `cell.filter` is NON-DESTRUCTIVE. It commits a
per-cell keep-mask COLUMN and never writes a filtered matrix, so there is no
"QC-filtered matrix artifact" for `doublet.detect` to consume. `embedding.reduce` hit exactly
this and answered it with an inline filter over the same `criteria` recipe; this is the same
answer, and deliberately NOT a second dialect.

── Why `not_evaluated` exists ───────────────────────────────────────────────────────────
An excluded cell has no call, and "no call" is not "singlet". A BOOL column could not carry
the distinction: `write_metadata_column`'s bool branch hard-codes `levels: ["false","true"]`,
so `False` would mean both "we looked and it is a singlet" and "we never looked" — the exact
conflation `de/result` refuses when it omits `padj` instead of filling it with 1.
"""
import importlib.util
import inspect
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from doublet_fixtures import load_criteria, require_skimage, structured_counts

_HERE = Path(__file__).resolve().parent
_COMPUTE = _HERE.parent / "compute"
_PACKAGES = _HERE.parents[1]
_SRC_APP = _HERE.parents[2]
_CF_SCRIPT = _PACKAGES / "cell-filter" / "compute" / "cell-filter.py"
_CORPUS = _SRC_APP / "testdata" / "criteria-coercion-corpus.json"

# The VENDORED kernel (doublet/compute/_criteria.py).
sys.path.insert(0, str(_COMPUTE))
DBL = load_criteria()


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


CASES = json.loads(_CORPUS.read_text(encoding="utf-8"))["cases"]


# ── TEST-13 — the vendored kernel cannot silently diverge ───────────────────────────
@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
@pytest.mark.parametrize("flavour", ["list", "object"])
def test_vendored_predicate_matches_cellfilter_on_the_shared_corpus(case, flavour):
    obs = {k: [_decode(x) for x in v] for k, v in case["obs"].items()}
    n = max((len(v) for v in obs.values()), default=0)
    cols = obs if flavour == "list" else {k: np.array(v, dtype=object) for k, v in obs.items()}
    want = case["expect"]
    ours = [bool(x) for x in
            np.asarray(DBL.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    theirs = [bool(x) for x in
              np.asarray(CF.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    assert ours == want, (case["id"], case.get("why"))
    assert ours == theirs, (case["id"], "the vendored kernel diverged from cell-filter")


@pytest.mark.parametrize("fn", [
    "criteria_keep_mask", "_is_categorical_criterion", "_is_spellable_scalar",
    "_value_float", "_trim_column", "_bound_or_none",
])
def test_vendored_kernel_source_is_byte_identical_to_cellfilter(fn):
    """A behavioural drift would already redden the corpus test above; this pins the SOURCE,
    so a hand-edit of the vendored copy — "verbatim, not forked" — is caught directly, and so
    is an upstream change to cell-filter that this copy has not followed."""
    assert inspect.getsource(getattr(DBL, fn)) == inspect.getsource(getattr(CF, fn)), fn


def test_vendored_module_regex_and_ws_constants_match():
    assert DBL._DECIMAL_BOUND.pattern == CF._DECIMAL_BOUND.pattern
    assert DBL._VALUE_WS == CF._VALUE_WS


def test_the_compute_uses_the_vendored_kernel_rather_than_a_local_reimplementation():
    """`wired-and-behaving`: the kernel existing and being source-identical proves nothing if
    the compute does not CALL it. Assert the entry imports it and routes its keep-mask
    through `criteria_keep_mask`."""
    source = (_COMPUTE / "doublet.py").read_text()
    assert "import _criteria as CR" in source
    assert "CR.criteria_keep_mask(criteria, filter_obs" in source
    assert "CR._is_categorical_criterion(c)" in source


# ── TEST-4b — not_evaluated is real ─────────────────────────────────────────────────
def _filtered_fixture():
    """120 cells; the last 20 are excluded by a range criterion on a `qc` column."""
    dense = structured_counts(40, 90, n_groups=3, seed=3)
    n = dense.shape[0]
    keep_n = n - 20
    qc = [1.0] * keep_n + [0.0] * 20
    return dense, qc, keep_n


def test_excluded_cells_are_not_evaluated_with_a_nan_score(detect_run):
    require_skimage()
    dense, qc, keep_n = _filtered_fixture()

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(qc, slot="column:qc", name="qc")
    run.run_ok({"n_prin_comps": 10, "criteria": [{"column": "qc", "min": "0.5"}]})

    scores = run.scores()
    calls = run.calls()

    # FULL LENGTH, in INPUT ORDER — the excluded cells are still there, in their own places
    assert len(scores) == dense.shape[0]
    assert len(calls) == dense.shape[0]

    assert np.isfinite(scores[:keep_n]).all(), "a kept cell has no score"
    assert np.isnan(scores[keep_n:]).all(), "an excluded cell was given a score"

    assert set(calls[keep_n:]) == {"not_evaluated"}, (
        "an excluded cell was called — `not_evaluated` is the only honest answer for a cell "
        "the method never looked at"
    )
    assert "not_evaluated" not in set(calls[:keep_n])
    assert set(calls[:keep_n]) <= {"singlet", "doublet"}


def test_the_survivors_scores_equal_a_run_over_the_presubset_matrix(detect_run):
    """The excluded cells must contribute NOTHING — not to the simulated-doublet population,
    not to the PCA, not to the kNN graph. The only way to prove that is to run the same
    scoring over the subset MATRIX and require bit-for-bit agreement: a filter applied after
    the fit (or a mask applied to a full-matrix result) would differ here."""
    require_skimage()
    dense, qc, keep_n = _filtered_fixture()

    filtered = detect_run()
    filtered.add_matrix(dense)
    filtered.add_column(qc, slot="column:qc", name="qc")
    filtered.run_ok({"n_prin_comps": 10, "criteria": [{"column": "qc", "min": "0.5"}]})

    presubset = detect_run()
    presubset.add_matrix(dense[:keep_n])
    presubset.run_ok({"n_prin_comps": 10})

    assert np.array_equal(filtered.scores()[:keep_n], presubset.scores()), (
        "the survivors' scores differ from a run over the pre-subset matrix — the excluded "
        "cells still influenced the simulation or the neighbourhood"
    )
    assert filtered.calls()[:keep_n] == presubset.calls()


def test_no_third_level_when_nothing_is_excluded(detect_run):
    """`not_evaluated` is not declared speculatively. A run with no pre-filter, where every
    cell was scored, declares exactly two levels — so a consumer reading the level set of an
    ordinary run is not shown a state that never occurs in it."""
    require_skimage()
    dense, qc, _keep_n = _filtered_fixture()

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(qc, slot="column:qc", name="qc")
    run.run_ok({"n_prin_comps": 10})  # column bound, but NO criteria

    report = run.report()
    assert report["prefilter"]["applied"] is False
    assert report["prefilter"]["n_excluded"] == 0
    assert report["call_levels"] == ["singlet", "doublet"]
    assert "not_evaluated" not in set(run.calls())

    entry = run.entry("doublet_call")
    assert entry["meta"]["kind"] == "categorical"
    assert entry["meta"]["n_levels"] == 2


def test_a_categorical_keepset_criterion_works_as_well_as_a_range(detect_run):
    """`_is_categorical_criterion` infers the branch from the criterion's SHAPE, because the
    real UI path never sets `control`. A categorical falling into the range branch is a
    shipped, fixed defect that silently kept ALL cells, so it is exercised explicitly."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=4)
    n = dense.shape[0]
    labels = ["keep"] * (n - 30) + ["drop"] * 30

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(labels, slot="column:tier", name="tier")
    run.run_ok({"n_prin_comps": 10,
                "criteria": [{"column": "tier", "keep": ["keep"]}]})  # no `control` key

    report = run.report()
    column = report["prefilter"]["columns"][0]
    assert column["kind"] == "categorical", (
        "a keep-set criterion was read as a range — this is the branch-inference defect that "
        "silently kept every cell"
    )
    assert column["predicate"] == {"keep": ["keep"]}
    assert report["prefilter"]["n_excluded"] == 30
    assert set(run.calls()[n - 30:]) == {"not_evaluated"}


def test_the_report_records_the_prefilter_exactly_as_applied(detect_run):
    """The exported methods paragraph must not describe a laxer method than the one that
    ran, so the report carries the recipe the mask ACTUALLY used plus the per-column
    predicate and its own kept count."""
    require_skimage()
    dense, qc, keep_n = _filtered_fixture()
    criteria = [{"column": "qc", "min": "0.5"}]

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(qc, slot="column:qc", name="qc")
    run.run_ok({"n_prin_comps": 10, "criteria": criteria})

    prefilter = run.report()["prefilter"]
    assert prefilter["applied"] is True
    assert prefilter["n_input"] == dense.shape[0]
    assert prefilter["n_kept"] == keep_n
    assert prefilter["n_excluded"] == dense.shape[0] - keep_n
    assert prefilter["criteria"] == criteria
    assert prefilter["excluded_any"] is True
    column = prefilter["columns"][0]
    assert column == {
        "column": "qc", "column_raw": None, "kind": "range",
        "predicate": {"min": "0.5", "max": None},
        "present": True, "cells_kept_by_this_column": keep_n,
    }


def test_the_prefilter_runs_BEFORE_the_batch_split(detect_run):
    """Order matters and is arithmetically load-bearing: filtering AFTER the split would
    change each batch's surviving cell count after its rate prior had already been derived,
    so the recorded prior would describe a population that no longer exists.

    Here each sample loses a different number of cells, so the two orderings give different
    per-batch `n_cells` and different priors — and only the filter-first ordering matches the
    cells actually scored.
    """
    require_skimage()
    a = structured_counts(40, 90, n_groups=3, seed=1)   # 120 cells, drop 20 -> 100
    b = structured_counts(40, 90, n_groups=3, seed=2)   # 120 cells, drop 60 -> 60
    merged = np.vstack([a, b])
    labels = ["S1"] * a.shape[0] + ["S2"] * b.shape[0]
    qc = ([1.0] * 100 + [0.0] * 20) + ([1.0] * 60 + [0.0] * 60)

    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.add_column(qc, slot="column:qc", name="qc")
    run.run_ok({"n_prin_comps": 10, "batch_column": "sample",
                "doublet_rate_per_1k": "0.2",
                "criteria": [{"column": "qc", "min": "0.5"}]})

    per_batch = {r["batch"]: r for r in run.report()["batches"]}
    # the SURVIVING counts, not the pre-filter ones
    assert per_batch["S1"]["n_cells"] == 100
    assert per_batch["S2"]["n_cells"] == 60
    assert per_batch["S1"]["expected_doublet_rate"] == pytest.approx(0.2 * 100 / 1000.0)
    assert per_batch["S2"]["expected_doublet_rate"] == pytest.approx(0.2 * 60 / 1000.0)
    # …and the excluded cells are `not_evaluated` in BOTH samples' regions
    calls = run.calls()
    assert set(calls[100:120]) == {"not_evaluated"}
    assert set(calls[180:240]) == {"not_evaluated"}


def test_a_prefilter_that_excludes_everything_is_a_named_refusal(detect_run):
    dense, qc, _keep_n = _filtered_fixture()
    run = detect_run()
    run.add_matrix(dense)
    run.add_column(qc, slot="column:qc", name="qc")
    proc = run.run({"n_prin_comps": 10, "criteria": [{"column": "qc", "min": "99"}]})

    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "excluded ALL" in diag, diag
    assert "not_evaluated" in diag
    assert not (run.outputs_dir / "manifest.json").exists()
