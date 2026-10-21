#!/usr/bin/env python3
# ruff: noqa
"""THE CORRECTNESS CORE — per-sample independence.

TEST-2  [acceptance] [invariant: INV-2] [covers: ITEM-9, ITEM-10] — a batched run equals the
        concat of independent per-sample runs, BIT-FOR-BIT.
TEST-2b [acceptance] [invariant: INV-2] [covers: ITEM-9, ITEM-12] — the batching is NOT a
        no-op: the same matrix unbatched scores differently, and says it was unbatched.
TEST-3  [acceptance] [invariant: INV-2] [covers: ITEM-10] — the rate prior is derived PER
        BATCH from that batch's own cell count, never from the merged total.
TEST-11 [acceptance] [invariant: INV-7] [covers: ITEM-9, ITEM-12, ITEM-16] — DISCLOSURE, NOT
        INFERENCE: an obvious `sample` column is NOT sniffed out, and an unbatched run says so.

── Why this file is the most important one in the package ──────────────────────────────
A doublet is one GEM barcode that captured two cells, and cells from separately captured
libraries CANNOT co-occupy a droplet. Running a doublet caller over a merged multi-sample
matrix therefore does two wrong things at once, and BOTH are invisible in the output:

  1. It scores against the WRONG NEIGHBOURHOOD. Simulated doublets are synthesized by summing
     pairs of OBSERVED cells; merged, those pairs cross samples, inventing profiles no droplet
     could produce, and every real cell is then scored by its density among that fiction.
  2. It derives the WRONG RATE PRIOR. The expected rate scales with cells loaded per lane
     (~0.8% per 1,000 recovered), so a merged 5x10k matrix auto-derives ~40% where the
     per-lane truth is ~7.6%.

The output of a wrong run looks exactly like the output of a right one. Prose cannot defend
that; TEST-2 turns it into a mechanically checkable property, and TEST-2b is what stops a
no-op implementation from passing TEST-2 trivially.
"""
import numpy as np
import pytest

from doublet_fixtures import require_skimage, structured_counts

#: Two samples with genuinely different internal structure, so a merged run and a batched run
#: cannot coincide by accident. Both are comfortably above `MIN_CELLS_PER_BATCH`.
PARAMS = {"n_prin_comps": 10}


def _two_samples(seed_a=1, seed_b=2, n_per_group=40, n_genes=90):
    a = structured_counts(n_per_group, n_genes, n_groups=3, seed=seed_a)
    b = structured_counts(n_per_group, n_genes, n_groups=3, seed=seed_b)
    merged = np.vstack([a, b])
    labels = ["S1"] * a.shape[0] + ["S2"] * b.shape[0]
    return a, b, merged, labels


# ── TEST-2 — no information crosses a batch boundary ────────────────────────────────
def test_a_batched_run_equals_the_concat_of_independent_runs_bit_for_bit(detect_run):
    require_skimage()
    a, b, merged, labels = _two_samples()

    batched = detect_run()
    batched.add_matrix(merged)
    batched.add_column(labels, slot="batch", name="sample")
    batched.run_ok(dict(PARAMS, batch_column="sample"))

    run_a = detect_run()
    run_a.add_matrix(a)
    run_a.run_ok(PARAMS)

    run_b = detect_run()
    run_b.add_matrix(b)
    run_b.run_ok(PARAMS)

    got = batched.scores()
    want = np.concatenate([run_a.scores(), run_b.scores()])

    # BIT-FOR-BIT, not `allclose`. A batch that borrowed even one neighbour from the other
    # sample would move the score in the last bits, and `allclose` would forgive exactly the
    # error this invariant exists to catch.
    assert got.shape == want.shape == (merged.shape[0],)
    assert np.array_equal(got, want), (
        "a batched run's scores differ from the concat of independent per-sample runs; "
        f"max|d| = {float(np.nanmax(np.abs(got - want))):.3e}. Information crossed a batch "
        "boundary."
    )

    # …and each batch's THRESHOLD is that sample's standalone threshold, not a pooled one.
    per_batch = {r["batch"]: r for r in batched.report()["batches"]}
    assert per_batch["S1"]["threshold"] == run_a.report()["batches"][0]["threshold"]
    assert per_batch["S2"]["threshold"] == run_b.report()["batches"][0]["threshold"]

    # the calls follow, so the invariant reaches the artifact a user actually filters on
    assert batched.calls() == run_a.calls() + run_b.calls()


def test_the_reassembly_is_in_input_order_not_batch_order(detect_run):
    """The split/apply/CONCAT half. Levels are visited in sorted order internally, so a
    fixture whose samples are INTERLEAVED (rather than blocked) is the one that catches a
    reassembly that writes results back in scoring order instead of input position."""
    require_skimage()
    a, b, _merged, _labels = _two_samples()
    # interleave: row 0 from A, row 1 from B, row 2 from A, ...
    n = a.shape[0]
    interleaved = np.empty((2 * n, a.shape[1]), dtype=a.dtype)
    interleaved[0::2] = a
    interleaved[1::2] = b
    labels = ["S1" if i % 2 == 0 else "S2" for i in range(2 * n)]

    run = detect_run()
    run.add_matrix(interleaved)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample"))

    run_a = detect_run()
    run_a.add_matrix(a)
    run_a.run_ok(PARAMS)
    run_b = detect_run()
    run_b.add_matrix(b)
    run_b.run_ok(PARAMS)

    got = run.scores()
    assert np.array_equal(got[0::2], run_a.scores()), "sample S1's scores landed off-position"
    assert np.array_equal(got[1::2], run_b.scores()), "sample S2's scores landed off-position"


def test_batch_level_ORDER_cannot_reach_a_score(detect_run):
    """Renaming the levels changes the order they are visited in (levels are iterated
    sorted), and must change nothing. A per-batch RNG or accumulator that leaked across
    iterations would show up here and nowhere else."""
    require_skimage()
    _a, _b, merged, labels = _two_samples()

    first = detect_run()
    first.add_matrix(merged)
    first.add_column(labels, slot="batch", name="sample")
    first.run_ok(dict(PARAMS, batch_column="sample"))

    # `zz` sorts AFTER `aa`, so the two levels are visited in the opposite order
    renamed = ["zz" if v == "S1" else "aa" for v in labels]
    second = detect_run()
    second.add_matrix(merged)
    second.add_column(renamed, slot="batch", name="sample")
    second.run_ok(dict(PARAMS, batch_column="sample"))

    assert np.array_equal(first.scores(), second.scores()), (
        "renaming the batch levels changed the scores — scoring ORDER reached a result"
    )


# ── TEST-2b — the anti-no-op twin ───────────────────────────────────────────────────
def test_the_batching_is_not_a_no_op(detect_run):
    """Without this, a green TEST-2 would ALSO be green for an implementation that ignores
    the batch key entirely — because `concat(scores(A), scores(B))` would then be compared
    against a merged run that happens to equal it only if batching does nothing.

    So: the SAME merged matrix, run UNBATCHED, must score differently for a non-trivial
    fraction of cells, and must record that it was unbatched.
    """
    require_skimage()
    _a, _b, merged, labels = _two_samples()

    batched = detect_run()
    batched.add_matrix(merged)
    batched.add_column(labels, slot="batch", name="sample")
    batched.run_ok(dict(PARAMS, batch_column="sample"))

    unbatched = detect_run()
    unbatched.add_matrix(merged)
    unbatched.run_ok(PARAMS)

    differs = float(np.mean(batched.scores() != unbatched.scores()))
    assert differs > 0.25, (
        f"only {differs:.1%} of cells scored differently between a batched and an unbatched "
        "run of the same merged matrix — the batch key is being ignored"
    )

    report = unbatched.report()
    assert report["batched"] is False
    assert report["n_batches"] == 1
    assert report["batch_column"] is None
    assert report["batches"][0]["batch"] is None


# ── TEST-3 — the rate prior is PER BATCH ────────────────────────────────────────────
def test_the_expected_rate_is_derived_per_batch_not_from_the_merged_total(detect_run):
    """Deliberately UNEQUAL sample sizes, so the merged-total value is distinct from both
    per-batch values and cannot be reached by accident.

    2,000 + 8,000 cells would be the honest fixture and is far too slow for a suite, so the
    sizes are scaled down while keeping the property: the two batches differ from each other
    AND both differ from what the merged total would give.
    """
    require_skimage()
    small = structured_counts(15, 90, n_groups=3, seed=1)    # 45 cells
    large = structured_counts(60, 90, n_groups=3, seed=2)    # 180 cells
    merged = np.vstack([small, large])
    labels = ["small"] * small.shape[0] + ["large"] * large.shape[0]

    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    # a per-1k rate high enough that all three candidate values clear the 0.005 floor, so the
    # clamp cannot flatten the very distinction this test is making
    run.run_ok(dict(PARAMS, batch_column="sample", doublet_rate_per_1k="0.2"))

    per_batch = {r["batch"]: r for r in run.report()["batches"]}
    assert set(per_batch) == {"small", "large"}

    def expected(n):
        return min(max(0.2 * n / 1000.0, 0.005), 0.25)

    assert per_batch["small"]["n_cells"] == 45
    assert per_batch["large"]["n_cells"] == 180
    assert per_batch["small"]["expected_doublet_rate"] == pytest.approx(expected(45))
    assert per_batch["large"]["expected_doublet_rate"] == pytest.approx(expected(180))
    assert per_batch["small"]["rate_source"] == "auto_10x_0.8pct_per_1k"

    # THE POINT: neither equals the value the MERGED total would have produced.
    merged_value = expected(merged.shape[0])
    assert per_batch["small"]["expected_doublet_rate"] != pytest.approx(merged_value)
    assert per_batch["large"]["expected_doublet_rate"] != pytest.approx(merged_value)
    # …and the two batches differ from EACH OTHER, which a single pooled prior could not do.
    assert (per_batch["small"]["expected_doublet_rate"]
            != pytest.approx(per_batch["large"]["expected_doublet_rate"]))


def test_an_explicit_rate_overrides_and_is_recorded_as_the_users(detect_run):
    require_skimage()
    _a, _b, merged, labels = _two_samples()
    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample", expected_doublet_rate="0.09"))

    for record in run.report()["batches"]:
        assert record["expected_doublet_rate"] == pytest.approx(0.09)
        assert record["rate_source"] == "user"


# ── the per-level refusal ───────────────────────────────────────────────────────────
def test_a_batch_level_below_the_minimum_is_a_named_refusal(detect_run):
    """A tiny level must not be a silent NaN and must not be a crash. It is a refusal that
    names the level, its size, the minimum, and the levers."""
    _a, _b, merged, labels = _two_samples()
    # make the last 5 cells their own level — far below MIN_CELLS_PER_BATCH
    labels = list(labels)
    for i in range(len(labels) - 5, len(labels)):
        labels[i] = "tiny"

    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    proc = run.run(dict(PARAMS, batch_column="sample"))

    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "'tiny'" in diag, diag
    assert "5 cell(s)" in diag, diag
    assert "'sample'" in diag, diag
    assert "unbatched" in diag  # one of the named levers
    assert not (run.outputs_dir / "manifest.json").exists()


# ── TEST-11 — DISCLOSURE, NOT INFERENCE ─────────────────────────────────────────────
def test_an_obvious_sample_column_is_NOT_sniffed_out(detect_run):
    """The platform cannot distinguish "one capture" from "a merged multi-sample matrix"
    without inferring intent from a column NAME, and this codebase refuses that class of
    guess (cell-filter 0.10.0 removed a barcode->row-position fallback for exactly this
    reason).

    So: a matrix carrying a column literally named `sample`, bound as an ordinary obs column
    but NOT on the `batch` slot, is scored as ONE population — and the run says so. An
    implementation that helpfully noticed the name would fail here.
    """
    require_skimage()
    _a, _b, merged, labels = _two_samples()

    run = detect_run()
    run.add_matrix(merged)
    # bound as a filter column, NOT on the `batch` slot — the name is as obvious as it gets
    run.add_column(labels, slot="column:sample", name="sample")
    run.run_ok(PARAMS)

    report = run.report()
    assert report["batched"] is False, "a column named `sample` was inferred as a batch key"
    assert report["n_batches"] == 1
    assert report["batch_column"] is None

    # and the scores are the UNBATCHED ones, not the batched ones
    batched = detect_run()
    batched.add_matrix(merged)
    batched.add_column(labels, slot="batch", name="sample")
    batched.run_ok(dict(PARAMS, batch_column="sample"))
    assert not np.array_equal(run.scores(), batched.scores())


def test_the_unbatched_state_is_disclosed_in_the_report_not_merely_absent(detect_run):
    """It must never be possible to obtain a doublet call without the record saying whether
    it was batched. `batched: false` is a POSITIVE statement, and the disclosure spells out
    what it means and when it is wrong."""
    require_skimage()
    _a, _b, merged, _labels = _two_samples()
    run = detect_run()
    run.add_matrix(merged)
    run.run_ok(PARAMS)

    report = run.report()
    assert report["batched"] is False
    disclosure = report["disclosure"]["batching"]
    assert "NOT batched" in disclosure
    assert "single capture" in disclosure
    assert "merged" in disclosure.lower()
    # the batch record is present and displayable rather than a blank row
    assert report["batches"][0]["batch_label"] == "all cells (unbatched)"
    assert report["batch_names"] == ["all cells (unbatched)"]


def test_a_batched_run_names_the_column_in_the_report(detect_run):
    """The other half of disclosure: when it WAS batched, the export must be able to say
    which column was used — which is why the display name travels as a param alongside the
    slot binding (a metadata-column store cannot carry its own name)."""
    require_skimage()
    _a, _b, merged, labels = _two_samples()
    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="donor_id"))

    report = run.report()
    assert report["batched"] is True
    assert report["batch_column"] == "donor_id"
    assert report["n_batches"] == 2
    assert "independently" in report["disclosure"]["batching"]
    assert "donor_id" in report["disclosure"]["batching"]


def test_a_bound_batch_column_with_no_name_warns_rather_than_going_quiet(detect_run):
    """A slot bound with no accompanying `batch_column` param scores correctly but cannot be
    NAMED in the export. That is a weaker disclosure, so it is recorded as a warning rather
    than passing silently."""
    require_skimage()
    _a, _b, merged, labels = _two_samples()
    run = detect_run()
    run.add_matrix(merged)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(PARAMS)  # no batch_column param

    report = run.report()
    assert report["batched"] is True
    assert report["batch_column"] == "batch"
    assert any("cannot name it" in w for w in report["warnings"]), report["warnings"]
