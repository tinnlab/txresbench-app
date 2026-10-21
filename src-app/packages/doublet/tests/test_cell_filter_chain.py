#!/usr/bin/env python3
# ruff: noqa
"""TEST-19 [covers: ITEM-20] — THE `cell.filter` CHAIN, with `cell-filter` UNCHANGED.

The research spike verified at three levels that no edge needs building:

  1. MANIFEST — `cell-filter` already declares `consumes: [metadata-column]`, and its own
     comment says that key exists precisely so "an annotator (QC) chains to it in the graph".
     A second annotator producing `metadata-column` chains identically.
  2. VIEW — `cell-filter/ui/cell-filter.yaml` sources its criterion-column picker from
     `axis_columns` over the cells axis of the selected dataset, NOT from a QC report: "every
     imported obs column AND every column any run put on the axis, in one set." A landed
     doublet column therefore appears in the picker the moment the run completes.
  3. COMPUTE — `criteria_keep_mask` already handles both branches a doublet column can take.

This file is where those three predictions are DEMONSTRATED rather than asserted, by driving
`cell-filter`'s REAL kernel over a REAL doublet run's landed values — with zero diff to the
`cell-filter` package (which `test_zero_src_app_diff.py` independently guarantees).

── The branch that gets its own test, and why ──────────────────────────────────────────
`_is_categorical_criterion` infers range-vs-keep-set from the criterion's SHAPE, because the
real UI path never sets `control`. A categorical criterion falling into the RANGE branch is a
shipped, FIXED defect whose symptom was silently keeping ALL cells — a filter that appears to
work and removes nothing. A regression there would be silent again, so the keep-set branch is
exercised with no `control` key set, exactly as the UI emits it.
"""
import importlib.util
from pathlib import Path

import numpy as np
import pytest

yaml = pytest.importorskip("yaml")

from doublet_fixtures import counts_with_doublets, require_skimage, structured_counts

_PKG = Path(__file__).resolve().parents[1]
_PACKAGES = _PKG.parent
_CF = _PACKAGES / "cell-filter"
_CF_SCRIPT = _CF / "compute" / "cell-filter.py"

PARAMS = {"n_prin_comps": 10}


def _load_cellfilter():
    spec = importlib.util.spec_from_file_location("cellfilter_chain_ref", str(_CF_SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CF = _load_cellfilter()


#: BOTH shipped methods. Every chain assertion below runs against each of them.
#:
#: This fixture used to be the python lane alone, and #195 nearly shipped with it that way:
#: the R lane's claim to be consumable by `cell.filter` rested on the two lanes declaring
#: the same output KINDS, which is necessary and not sufficient — two `metadata-column`s can
#: agree on kind and still disagree about axis, length, ordering or the level vocabulary,
#: any of which breaks a consumer just as thoroughly. A blind audit pointed out that the one
#: file whose whole job is to demonstrate this chain was still only demonstrating it for one
#: method. Parametrizing it is what turns "the kinds match" into "the real kernel really
#: filters the real bytes", for both.
LANES = ("doublet.detect", "doublet.scdblfinder")


@pytest.fixture(scope="module", params=LANES)
def landed(request, tmp_path_factory):
    """ONE real doublet run — of EACH method — whose landed values every assertion filters on."""
    from doublet_fixtures import DetectRun, ScdblfinderRun, require_r_env

    counts, _n_real = counts_with_doublets(seed=0)
    if request.param == "doublet.detect":
        require_skimage()
        run = DetectRun(tmp_path_factory.mktemp("chain-py"))
        params = PARAMS
    else:
        require_r_env()
        run = ScdblfinderRun(tmp_path_factory.mktemp("chain-r"))
        # The R lane shares only the parameters BOTH methods accept. Today `PARAMS` holds
        # a Scrublet-only key (`n_prin_comps`) and nothing else, so this filter is currently
        # equivalent to `{}` — stated because an earlier version of this comment listed
        # `threshold` and `criteria` as the things being stripped, and `PARAMS` contains
        # neither. The filter stays because `PARAMS` is shared and will grow.
        _SHARED = ("seed", "label", "expected_doublet_rate", "doublet_rate_per_1k")
        params = {k: v for k, v in PARAMS.items() if k in _SHARED}
    run.add_matrix(counts)
    run.run_ok(params)
    run.lane = request.param
    return run


# ── 1. the manifest edge already exists ─────────────────────────────────────────────
def test_cell_filter_already_consumes_metadata_column():
    doc = yaml.safe_load((_CF / "manifest.yaml").read_text())
    analysis = doc["contributes"]["analyses"][0]
    assert analysis["id"] == "cell.filter"
    assert "metadata-column" in analysis["consumes"], (
        "the chain rests on cell.filter declaring metadata-column as a consumed datatype")


def test_doublet_produces_exactly_what_cell_filter_consumes():
    """TEST-51 — EVERY method in the package, not `analyses[0]`.

    Reading one positional entry was correct while the package shipped one analysis and
    silently stopped covering the tree the moment a second landed — the same
    "one spec, several meanings" failure a positional read always has. It is now keyed by
    id, and the id set is asserted, so a third method (`doublet.doubletfinder`) fails here
    until someone states what it produces rather than inheriting a green result.
    """
    doublet = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    by_id = {a["id"]: a for a in doublet["contributes"]["analyses"]}
    assert set(by_id) == set(LANES), sorted(by_id)
    consumed = set(yaml.safe_load((_CF / "manifest.yaml").read_text())
                   ["contributes"]["analyses"][0]["consumes"])
    for analysis_id in LANES:
        produced = set(by_id[analysis_id]["produces"])
        assert consumed & produced == {"metadata-column"}, (analysis_id, produced, consumed)


# ── 2. the view picker sources the AXIS, not a report ───────────────────────────────
def test_cell_filters_criterion_picker_sources_the_cells_axis():
    """If the picker were sourced from a QC report, a doublet column would never appear in
    it and the chain would need real work. It is sourced from `axis_columns` over the cells
    axis, so any column any run put there is offered."""
    view = yaml.safe_load((_CF / "ui" / "cell-filter.yaml").read_text())
    sources = {name: slice_["args"] for name, slice_ in view["data"].items()
               if isinstance(slice_, dict) and slice_.get("source") == "axis_columns"}
    assert sources, "cell-filter's view no longer reads axis_columns"
    assert any(args.get("axis") == "cells" for args in sources.values()), sources


# ── 3. both criterion branches, over REAL landed values ────────────────────────────
# TEST-52 — enumerated in `.lifecycle/scdblfinder-method/TESTS.md`.
def test_a_range_criterion_on_the_score_produces_the_expected_keep_mask(landed):
    scores = landed.scores()
    obs = {"doublet_score": list(scores)}
    # THE CUT IS DERIVED FROM THIS LANE'S OWN DISTRIBUTION, not a shared literal.
    #
    # It used to be a fixed `0.2`, which discriminated for the Scrublet lane and — once this
    # fixture was parametrized over both methods — kept ALL 132 cells for the R lane, whose
    # scores on this fixture all sit below it. The assertion below then passed while testing
    # nothing, and only tightening `<=` to `<` revealed it. The two methods produce scores on
    # different scales; a literal that means "some cells" for one of them is a coin flip for
    # the other, and a criterion that keeps everything is exactly the silent failure this
    # file exists to catch.
    cut = float(np.median(scores))
    criteria = [{"column": "doublet_score", "max": repr(cut)}]

    mask = np.asarray(CF.criteria_keep_mask(criteria, obs, n_cells=len(scores)), dtype=bool)
    expected = np.asarray([np.isfinite(s) and s <= cut for s in scores], dtype=bool)
    assert np.array_equal(mask, expected)
    # …and it is doing REAL WORK rather than keeping everything. `<=` here would be
    # satisfied by a criterion that kept every cell — which is precisely the silent failure
    # its categorical sibling below uses `<` to exclude. Flagged by a blind audit as the one
    # place these two tests disagreed about their own standard.
    assert 0 < int(mask.sum()) < len(scores), (
        f"the range criterion kept {int(mask.sum())} of {len(scores)} cells, so it is not "
        "discriminating and this test would pass with the filter disabled")


def test_a_categorical_keepset_on_the_call_produces_the_expected_keep_mask(landed):
    """TEST-53 — The branch whose regression is silent. NO `control` key is set — exactly what the real
    UI path emits — so `_is_categorical_criterion` has to infer it from the shape."""
    calls = landed.calls()
    obs = {"doublet_call": list(calls)}
    criterion = {"column": "doublet_call", "keep": ["singlet"]}
    assert "control" not in criterion

    assert CF._is_categorical_criterion(criterion) is True, (
        "a keep-set criterion was read as a range — this is the shipped defect that silently "
        "kept ALL cells")

    mask = np.asarray(CF.criteria_keep_mask([criterion], obs, n_cells=len(calls)), dtype=bool)
    expected = np.asarray([c == "singlet" for c in calls], dtype=bool)
    assert np.array_equal(mask, expected)

    # …and it removed the called doublets rather than keeping everything (the defect's tell)
    n_doublets = sum(1 for c in calls if c == "doublet")
    assert n_doublets > 0, "the fixture called no doublets, so this test proves nothing"
    assert int(mask.sum()) == len(calls) - n_doublets
    assert int(mask.sum()) < len(calls)


def test_the_two_branches_disagree_so_the_inference_is_load_bearing(landed):
    """If a keep-set silently took the RANGE branch it would impose no constraint and keep
    every cell. Asserting that the categorical result differs from an all-true mask is what
    makes the branch inference observable."""
    calls = landed.calls()
    obs = {"doublet_call": list(calls)}
    keepset = np.asarray(
        CF.criteria_keep_mask([{"column": "doublet_call", "keep": ["singlet"]}], obs,
                              n_cells=len(calls)), dtype=bool)
    assert not keepset.all(), (
        "the keep-set kept every cell, which is exactly what the range-branch defect looked "
        "like")


def test_a_not_evaluated_cell_is_excluded_by_a_keep_singlets_criterion(detect_run):
    """The payoff of the third level: filtering to `singlet` drops cells that were never
    evaluated, instead of silently keeping them because a bool `False` meant two things."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=3)
    n = dense.shape[0]
    run = detect_run()
    run.add_matrix(dense)
    run.add_column([1.0] * (n - 20) + [0.0] * 20, slot="column:qc", name="qc")
    run.run_ok(dict(PARAMS, criteria=[{"column": "qc", "min": "0.5"}]))

    calls = run.calls()
    assert set(calls[n - 20:]) == {"not_evaluated"}
    mask = np.asarray(
        CF.criteria_keep_mask([{"column": "doublet_call", "keep": ["singlet"]}],
                              {"doublet_call": list(calls)}, n_cells=n), dtype=bool)
    assert not mask[n - 20:].any(), (
        "a cell the method never evaluated survived a keep-singlets filter")


def test_a_nan_score_is_excluded_by_a_range_criterion_not_passed_through(detect_run):
    """`criteria_keep_mask` applies `np.isfinite`, so a NaN score is DROPPED rather than
    passing a numeric threshold — the inverse of the legacy NA-passes defect. Worth pinning
    here because this package deliberately emits NaN for a cell it did not evaluate."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=4)
    n = dense.shape[0]
    run = detect_run()
    run.add_matrix(dense)
    run.add_column([1.0] * (n - 20) + [0.0] * 20, slot="column:qc", name="qc")
    run.run_ok(dict(PARAMS, criteria=[{"column": "qc", "min": "0.5"}]))

    scores = run.scores()
    assert np.isnan(scores[n - 20:]).all()
    mask = np.asarray(
        CF.criteria_keep_mask([{"column": "doublet_score", "min": "0", "max": "1"}],
                              {"doublet_score": list(scores)}, n_cells=n), dtype=bool)
    assert not mask[n - 20:].any(), "a NaN score passed a numeric threshold"
    assert mask[: n - 20].all()
