#!/usr/bin/env python3
# ruff: noqa
"""TEST-21 [covers: ITEM-5, ITEM-11, ITEM-12] — the `report/qc` provenance record.

The report is the run's own account of itself, and it is the SINGLE SOURCE of three things:
the readout renders it (rather than restating its sentences), the user judges the
trustworthiness of the call from it, and it is where every parameter and every disclosure has
to be findable after the fact. So its shape is asserted, not assumed.

The simulated-score distribution is the one part that is a genuine scientific artefact rather
than bookkeeping: it is how a user answers "is this bimodal, and therefore is the automatic
threshold trustworthy at all?" It ships as DATA (bin edges + counts + row records) rather than
as a matplotlib PNG from inside the sandbox, which would be an opaque blob the workbench
cannot interact with.
"""
import numpy as np
import pytest

from doublet_fixtures import (counts_with_doublets, load_compute, degenerate_counts, require_skimage,
                              structured_counts)

PARAMS = {"n_prin_comps": 10}


@pytest.fixture(scope="module")
def batched_report(tmp_path_factory):
    require_skimage()
    from doublet_fixtures import DetectRun

    a = structured_counts(40, 90, n_groups=3, seed=1)
    b = structured_counts(40, 90, n_groups=3, seed=2)
    merged = np.vstack([a, b])
    labels = ["S1"] * a.shape[0] + ["S2"] * b.shape[0]

    run = DetectRun(tmp_path_factory.mktemp("report"))
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample"))
    return run


def test_the_report_entry_declares_its_discriminator(batched_report):
    """`kind: doublet-report` is what lets the readout's `job.result` slice pick THIS report
    out of the several `report/qc` artifacts a project accumulates (QC's, clustering's,
    cell-filter's). Without it the readout would render whichever came last."""
    entry = batched_report.entry("doublet-report")
    assert entry["datatype"] == "report/qc"
    assert entry["meta"]["kind"] == "doublet-report"
    body = batched_report.report()
    assert body["kind"] == "doublet-report"
    assert body["analysis"] == "doublet.detect"


def test_the_report_names_the_method_and_cites_it(batched_report):
    body = batched_report.report()
    assert body["method"] == "scrublet"
    assert "Wolock" in body["citation"] and "2019" in body["citation"]
    assert "scanpy" in body["citation"]


def test_the_per_batch_record_carries_everything_the_readout_renders(batched_report):
    body = batched_report.report()
    assert body["batched"] is True
    assert body["n_batches"] == 2
    assert body["batch_column"] == "sample"

    required = {"batch", "batch_label", "n_cells", "n_evaluated", "n_dropped_by_method",
                "expected_doublet_rate", "rate_source", "doublet_rate_per_1k",
                "threshold", "threshold_source", "threshold_reason", "n_called",
                "pct_called", "n_simulated", "sim_score_histogram"}
    for record in body["batches"]:
        assert required <= set(record), required - set(record)
        assert record["n_cells"] == 120
        assert record["threshold_source"] == "automatic"
        assert record["pct_called"] is None or 0.0 <= record["pct_called"] <= 100.0
        assert record["n_simulated"] > 0


def test_the_simulated_score_histogram_is_renderable_data(batched_report):
    """Both encodings are present: the compact arrays, and the ROW records a declarative
    `table` widget can bind to (the core widget vocabulary ships no histogram kind, and a
    canvas series needs a columnar frame that a document report slice is not)."""
    body = batched_report.report()
    for record in body["batches"]:
        histogram = record["sim_score_histogram"]
        assert len(histogram["bin_edges"]) == len(histogram["counts"]) + 1
        assert len(histogram["counts"]) == 40
        assert len(histogram["rows"]) == 40
        assert sum(histogram["counts"]) == histogram["n"] <= record["n_simulated"]

        # The bins cover the data by construction (the range is the data's own, widened to
        # include the threshold), so every finite value is counted.
        assert sum(histogram["counts"]) == histogram["n"]
        assert histogram["n_outside_unit_interval"] == 0
        low, high = histogram["range"]
        assert low <= record["threshold"] <= high, (
            "the threshold is outside the plotted range, so the cut is off the axis")

        first, last = histogram["rows"][0], histogram["rows"][-1]
        assert first["bin_low"] == pytest.approx(low, abs=1e-6)
        assert last["bin_high"] == pytest.approx(high, abs=1e-6)
        assert set(first) == {"bin", "bin_low", "bin_high", "count", "above_threshold",
                              "contains_threshold"}

        # `above_threshold` is the readout's stand-in for a cutline, so it must land where
        # the CALL rule lands. A cell is a doublet iff `score > threshold`, so a bin is
        # "above" iff its LOW edge is already past the cut, and the one bin that STRADDLES
        # the cut is flagged separately rather than being folded into "below" — folding it
        # in drew the cutline up to a full bin-width away from the real one, and a test that
        # only asked "are both values present?" could not see that.
        threshold = record["threshold"]
        assert sum(1 for row in histogram["rows"] if row["contains_threshold"]) == 1
        flags = [row["above_threshold"] for row in histogram["rows"]]
        assert set(flags) == {True, False}, flags


def test_the_flat_lookups_the_readout_binds_agree_with_the_batch_records(batched_report):
    """`batch_names` / `histogram_by_batch` / `threshold_by_batch` are conveniences for the
    view's `$data.report.x[$state.y]` idiom. They are DERIVED from `batches`, so a
    disagreement would mean the readout is rendering something the record does not say."""
    body = batched_report.report()
    assert body["batch_names"] == [r["batch_label"] for r in body["batches"]]
    for record in body["batches"]:
        label = record["batch_label"]
        assert body["histogram_by_batch"][label] == record["sim_score_histogram"]["rows"]
        assert body["threshold_by_batch"][label] == record["threshold"]


def test_the_report_records_every_parameter_and_the_run_environment(batched_report):
    body = batched_report.report()
    assert body["parameters"]["batch_key"] is None
    resolved = body["parameters_resolved"]
    assert resolved["label"] == "doublet"
    assert resolved["seed"] == 0
    assert resolved["doublet_rate_per_1k"] == 0.008
    assert resolved["rate_floor"] == 0.005 and resolved["rate_ceiling"] == 0.25
    assert resolved["min_cells_per_batch"] == 30
    assert body["ceiling"]["nnz"] > 0
    assert body["ceiling"]["memory_budget_bytes"] == 8 * 1024 ** 3  # the Batch class
    assert set(body["thread_pins"].values()) == {"1"}


def test_the_three_disclosures_plus_the_batching_one_are_present(batched_report):
    """The readout surfaces these BY REFERENCE, so the report is the one place they are
    written. A missing key would render an empty alert rather than a loud failure, which is
    why their presence is asserted here."""
    disclosure = batched_report.report()["disclosure"]
    assert set(disclosure) == {"flag_dont_delete", "homotypic", "method_tradeoff", "batching"}
    for key, text in disclosure.items():
        assert isinstance(text, str) and len(text) > 80, key


def test_a_partial_threshold_run_is_named_as_such(detect_run):
    """A batched run where SOME levels resolve a threshold and others do not is a real
    outcome and needs its own name: collapsing it to `automatic` would hide that some cells
    have no call, and collapsing it to `undetermined` would hide that some do."""
    require_skimage()
    good = structured_counts(40, 90, n_groups=3, seed=1)          # threshold findable
    bad = degenerate_counts(30, 90, seed=0)                       # not bimodal
    merged = np.vstack([good, bad])
    labels = ["good"] * good.shape[0] + ["bad"] * bad.shape[0]

    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample"))

    body = run.report()
    per_batch = {r["batch"]: r for r in body["batches"]}
    assert per_batch["good"]["threshold_source"] == "automatic"
    assert per_batch["bad"]["threshold_source"] == "undetermined"
    assert body["threshold_source"] == "partial"

    # the cells of the undetermined level get NO call, the others do
    calls = run.calls()
    assert set(calls[good.shape[0]:]) == {"not_evaluated"}
    assert set(calls[: good.shape[0]]) <= {"singlet", "doublet"}
    assert body["call_emitted"] is True
    assert "not_evaluated" in body["call_levels"]
    assert body["n_called_cells_without_a_call"] == bad.shape[0]


def test_the_call_counts_only_come_from_levels_that_resolved_a_threshold(detect_run):
    require_skimage()
    counts, n_real = counts_with_doublets(seed=0)
    run = detect_run()
    run.add_matrix(counts)
    run.run_ok(PARAMS)

    body = run.report()
    calls = run.calls()
    assert body["n_called"] == sum(1 for c in calls if c == "doublet")
    assert body["n_evaluated"] == int(np.isfinite(run.scores()).sum())
    assert body["n_not_evaluated"] == len(calls) - body["n_evaluated"]


def test_the_report_warns_when_scanpy_drops_cells_rather_than_defaulting_them(detect_run):
    """scanpy's own wrapper applies `filter_cells(min_genes=3)` internally, so a sparse cell
    can come back with no score at all. Those cells must be RECORDED (NaN + `not_evaluated` +
    a warning), never silently defaulted to `singlet`."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=5).copy()
    dense[:6, :] = 0.0
    dense[:6, 0] = 1.0     # one detected gene each — below scanpy's min_genes=3

    run = detect_run()
    run.add_matrix(dense)
    run.run_ok(PARAMS)

    body = run.report()
    dropped = body["batches"][0]["n_dropped_by_method"]
    assert dropped == 6, dropped
    assert np.isnan(run.scores()[:6]).all()
    assert set(run.calls()[:6]) == {"not_evaluated"}
    assert any("filter_cells(min_genes=3)" in w for w in body["warnings"]), body["warnings"]


def test_the_histogram_flag_agrees_with_the_CALL_rule_cell_for_cell(detect_run):
    """`above_threshold` is the readout's stand-in for a cutline, so it has to mean the same
    thing the CALL means — and the only way to check that is against real calls.

    Asserting `above_threshold is (bin_low > threshold)` would re-derive the implementation's
    own formula from the row the implementation wrote: a mirror, green for `>=` and `>`
    alike, because a float threshold never lands exactly on an `i/40` bin edge. So this walks
    the OBSERVED scores instead: every cell whose score falls inside a bin flagged `above`
    must be called `doublet`, and every cell in a bin flagged neither `above` nor
    `contains` must be called `singlet`. The straddling bin is the only one allowed to hold
    both, which is exactly why it is flagged separately.
    """
    require_skimage()
    counts, _n_real = counts_with_doublets(seed=0)
    run = detect_run()
    run.add_matrix(counts)
    run.run_ok(PARAMS)

    record = run.report()["batches"][0]
    threshold = record["threshold"]
    assert threshold is not None
    scores = run.scores()
    calls = run.calls()

    checked_above = checked_below = 0
    for row in record["sim_score_histogram"]["rows"]:
        lo, hi = row["bin_low"], row["bin_high"]
        in_bin = [i for i, s in enumerate(scores) if np.isfinite(s) and lo <= s < hi]
        if not in_bin:
            continue
        if row["above_threshold"]:
            assert all(calls[i] == "doublet" for i in in_bin), (
                f"bin [{lo}, {hi}) is flagged above the cut but holds a cell called singlet — "
                "the readout's cutline and the call rule disagree")
            checked_above += len(in_bin)
        elif not row["contains_threshold"]:
            assert all(calls[i] == "singlet" for i in in_bin), (
                f"bin [{lo}, {hi}) is flagged below the cut but holds a cell called doublet")
            checked_below += len(in_bin)
    # the walk must have exercised BOTH sides, or it proved nothing
    assert checked_above > 0 and checked_below > 0, (checked_above, checked_below)


def test_a_score_EXACTLY_on_the_threshold_is_a_singlet(detect_run):
    """TEST-27 — the BOUNDARY of the call rule, which no other test in this suite can reach.

    Found by a one-target mutation re-verification after the merge: flipping
    `scores > threshold` to `scores >= threshold` in `compute/doublet.py` was NOT caught by
    anything, including the walk directly above. That walk is a real improvement over what
    it replaced — it reads `run.calls()` instead of re-deriving the implementation's own
    formula — but it still cannot see this mutation, because `>` and `>=` differ at exactly
    ONE input: a score equal to the threshold. Every automatic threshold is a float derived
    from a histogram of SIMULATED scores, so no OBSERVED score ever lands on it, and
    "exercised both sides of the cut" is not the same claim as "exercised the cut".

    FIX_ROUND-2 recorded the `above_threshold` defect as fixed on the strength of that walk.
    The fix was genuine and the record overstated it; this is the test that closes the gap.

    The rule is scanpy's (`core.py`): a cell is a doublet iff `score > threshold`, strictly.
    So the boundary cell must come back `singlet`. The only way to put an observed score
    exactly on the cut is to CHOOSE the cut — hence the explicit `threshold` parameter,
    which is also the one user-reachable lever this package documents.
    """
    require_skimage()
    counts, _n_real = counts_with_doublets(seed=0)

    # 1. a normal run, purely to LEARN a real observed score.
    first = detect_run()
    first.add_matrix(counts)
    first.run_ok(PARAMS)
    observed = [s for s in first.scores() if np.isfinite(s)]
    assert observed, "no finite score to place a threshold on"
    # A score with cells strictly on BOTH sides, so the run still exercises the ordinary
    # path and this cannot pass by everything collapsing to one level.
    cut = sorted(observed)[len(observed) // 2]
    assert any(s < cut for s in observed) and any(s > cut for s in observed)

    # 2. re-run with the cut placed exactly on that value.
    second = detect_run()
    second.add_matrix(counts)
    second.run_ok({**PARAMS, "threshold": cut})
    scores, calls = second.scores(), second.calls()
    record = second.report()["batches"][0]
    assert record["threshold"] == cut and record["threshold_source"] == "user", (
        "the explicit threshold did not survive to the record; this test is not placing "
        "the cut where it thinks it is")

    on_cut = [i for i, s in enumerate(scores) if np.isfinite(s) and s == cut]
    assert on_cut, (
        "no cell landed exactly on the chosen cut — the boundary is unexercised and this "
        "test would be vacuous; the scores are not stable across the two runs")
    for i in on_cut:
        assert calls[i] == "singlet", (
            f"cell {i} scores exactly {cut}, the threshold, and was called {calls[i]!r}. "
            "The rule is scanpy's strict `score > threshold`, so it is a SINGLET; a "
            "`>=` here silently reclassifies every boundary cell")

    # The control: the strict sides still behave, so a compute that called nothing (or
    # everything) cannot satisfy the assertion above by accident.
    assert any(calls[i] == "doublet" for i, s in enumerate(scores)
               if np.isfinite(s) and s > cut)
    assert all(calls[i] == "singlet" for i, s in enumerate(scores)
               if np.isfinite(s) and s < cut)


def test_the_histogram_cutline_uses_the_SAME_strict_boundary_as_the_call():
    """TEST-29 — the readout's copy of the call rule's boundary.

    Found by mutating `_histogram`'s `above = blo > t` to `>=` one target at a time: NOTHING
    in the suite went red. TEST-27 closed this boundary on the CALL path and left it open on
    the READOUT path, which carries the same rule in its own arithmetic — the sharper test
    made the asymmetry visible rather than removing it.

    `_histogram` is called directly, because the state is unreachable through a normal run:
    an automatic threshold is a float off the simulated histogram and never lands on a bin
    edge, which is the same reason the cell-for-cell walk above cannot see it either.

    The invariant is stated as a CONTRADICTION rather than as a recomputation of the
    formula: a bin that STRADDLES the cut is not entirely above it, so `above_threshold` and
    `contains_threshold` can never both be true on one row. Asserting `above is (blo > t)`
    would just re-derive the implementation from the row it wrote — the exact mirror this
    file's other tests were rewritten to stop doing.
    """
    values = [0.10, 0.20, 0.30, 0.40, 0.50]

    # The cut placed exactly ON a bin's low edge is the one input at which `>` and `>=`
    # differ. The range is the data's own, so the minimum IS the first bin's low edge.
    h = load_compute()._histogram(values, threshold=min(values))
    rows = h["rows"]
    straddling = [r for r in rows if r["contains_threshold"]]
    assert len(straddling) == 1, "exactly one bin may straddle the cut"

    for r in rows:
        assert not (r["above_threshold"] and r["contains_threshold"]), (
            f"bin {r['bin']} [{r['bin_low']}, {r['bin_high']}) is flagged BOTH entirely "
            "above the cut and straddling it. A bin containing the threshold holds cells on "
            "both sides, so it cannot be entirely above — this is the readout's cutline "
            "claiming a strictness the call rule does not have")

    # Non-vacuity: the cut really is on that bin's low edge, and both flags are exercised
    # somewhere in the table (a table of all-False would satisfy the loop above trivially).
    assert straddling[0]["bin_low"] <= min(values) <= straddling[0]["bin_high"]
    assert any(r["above_threshold"] for r in rows), "no bin is above the cut; nothing tested"
    assert any(not r["above_threshold"] for r in rows)


def test_the_histogram_accounts_for_values_outside_the_unit_interval():
    """`n_outside_unit_interval` is quiescent on every real fixture (Scrublet's simulated
    scores live in [0,1] by construction), so asserting it is 0 on a run cannot fail. Drive
    `_histogram` DIRECTLY with out-of-range values instead — the state the field exists for,
    reachable in production only through a malformed prior."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "compute"))
    from doublet_fixtures import load_compute

    D = load_compute()

    h = D._histogram([-0.5, 0.25, 0.75, 1.5, 2.0], threshold=0.5)
    assert h["n"] == 5
    # every finite value is binned (the range is the data's own) …
    assert sum(h["counts"]) == 5
    assert h["range"] == [-0.5, 2.0]
    # … and the three values that are not valid doublet scores are counted as such, which is
    # the honesty the field exists for: it is an independent statement, not a binning
    # artefact, so it cannot be satisfied by the bins happening to cover the data.
    assert h["n_outside_unit_interval"] == 3

    clean = D._histogram([0.1, 0.2, 0.9], threshold=0.5)
    assert clean["n_outside_unit_interval"] == 0

    # and a threshold of exactly 1.0 — which the form and the compute both accept — must
    # still land in exactly one bin, not in none
    h1 = D._histogram([0.1, 0.9, 1.0], threshold=1.0)
    assert sum(1 for r in h1["rows"] if r["contains_threshold"]) == 1
    h0 = D._histogram([0.1, 0.9], threshold=0.0)
    assert sum(1 for r in h0["rows"] if r["contains_threshold"]) == 1
