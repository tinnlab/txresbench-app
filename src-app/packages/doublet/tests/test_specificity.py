#!/usr/bin/env python3
"""TEST-26 — the SPECIFICITY control the suite never had, and the gap it exposes.

WHY THIS FILE EXISTS. Every assertion in this package's synthetic tier is shaped like an
EQUALITY: a batched run equals the concat of two standalone runs; the same seed reproduces;
a filtered run's survivors are bit-equal to a run over the pre-subset matrix. Equalities are
scale-free — both sides move together, so they hold just as well when the underlying call is
meaningless as when it is right. Nothing in the always-running tier ever asked *how many*
cells get called, and no synthetic fixture carried a truth label, so no test could.

Measured, on the very fixtures the per-sample correctness core runs on:

    structured_counts(40, 90, n_groups=3, seed=s)  — SINGLETS ONLY, zero doublets by
    construction (it appends nothing; only `counts_with_doublets` appends sums)

        seed=0     0 / 120 called doublet    0.0%
        seed=1    87 / 120 called doublet   72.5%
        seed=2   117 / 120 called doublet   97.5%
        seed=3     8 / 120 called doublet    6.7%
        seed=5     8 / 120 called doublet    6.7%

`test_per_sample.py::_two_samples` is seed=1 + seed=2. The entire per-sample correctness
core — INV-2's isolation and rate-prior proofs — is green on a run that calls ~85% of a
doublet-FREE matrix a doublet, and every one of those tests would stay green if it called
100%.

THE PRODUCT GAP THIS PINS. `threshold_source` is `automatic` on all five runs. Scrublet
found a minimum between two modes of the simulated-score histogram and returned it, so from
the compute's side the fit "converged" — and the compute writes the resulting call column
with full confidence. INV-3 refuses a FABRICATED threshold when none was found; it says
nothing about a threshold that WAS found and is meaningless. That mirror case has no guard,
no disclosure, and no field in the report a reader could use to tell the two apart.

WHAT THESE TESTS DO AND DO NOT CLAIM. They do NOT assert a specificity floor: picking the
called-fraction at which a run becomes untrustworthy is a product decision about what
`doublet.detect` should DO in that regime, and it is escalated, not silently defaulted here
(see DECISIONS DEC-23). They assert the two things that are unambiguous: the regime is
REACHABLE, and the shipped artifact cannot express it. Both go RED the moment a guard,
a warning, or a disclosure field is added — which is the point. This follows the pinning
idiom this package already uses for the narrator's note-dropping defect (TEST-8).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from doublet_fixtures import (DetectRun, load_compute, require_skimage,  # noqa: E402
                              structured_counts)

#: `n_prin_comps=10` — the parameterization every synthetic test in this package uses.
PARAMS = {"n_prin_comps": 10}

#: The two ends of the measured spread, and the fixture the per-sample core actually runs on.
QUIET_SEED, LOUD_SEED = 0, 2


def _run(tmp_path, seed):
    run = DetectRun(tmp_path)
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=seed))
    run.run_ok(PARAMS)
    return run


def _called_fraction(run):
    calls = list(run.calls())
    return calls.count("doublet") / len(calls), len(calls)


# ── the control: the fixture really does contain no doublets ────────────────────────
def test_the_structured_fixture_contains_no_doublets_by_construction():
    """The premise every assertion below rests on, MEASURED rather than asserted from the
    generator's docstring.

    A doublet in this suite is a row that is the exact sum of two other rows —
    `counts_with_doublets` is the only generator that appends any, and it appends them to
    the END of the same base. So the check is: no row of `structured_counts` is the sum of
    two distinct other rows of it. Without this control, a specificity claim below would be
    unfalsifiable — "it called cells that are not doublets" means nothing if some are.
    """
    import numpy as np

    for seed in (QUIET_SEED, LOUD_SEED):
        m = structured_counts(40, 90, n_groups=3, seed=seed)
        # `counts_with_doublets` appends exactly `n_doublets` rows past `n_real`; this
        # generator returns the base alone, so its row count is the untouched block total.
        assert m.shape[0] == 3 * 40, "the generator appended rows it is not supposed to"
        totals = m.sum(axis=1)
        # A summed pair carries the summed library size. The maximum single-cell total is
        # strictly below the minimum achievable pair total, so no row can be a pair sum.
        assert totals.max() < 2 * totals.min(), (
            "a row's library size is large enough to be a sum of two others; the "
            "no-doublets premise is no longer measurable this cheaply")


# ── the finding: the called fraction is unconstrained on doublet-free input ─────────
def test_a_doublet_free_matrix_can_be_called_almost_entirely_doublet(tmp_path_factory):
    """The specificity control the suite never had.

    Both ends are asserted, so this cannot pass by accident in either direction: a tree
    where the caller became conservative everywhere fails the LOUD leg, and one where it
    became indiscriminate everywhere fails the QUIET leg. A single-ended assertion here
    would have been satisfiable by a compute that simply never calls anything.
    """
    require_skimage()
    quiet, _ = _called_fraction(_run(tmp_path_factory.mktemp("quiet"), QUIET_SEED))
    loud, n = _called_fraction(_run(tmp_path_factory.mktemp("loud"), LOUD_SEED))

    assert n == 120
    assert quiet <= 0.05, (
        f"seed={QUIET_SEED} called {quiet:.1%} of a doublet-free matrix; it called ~0% when "
        "this was measured. The spread below is what makes the finding, so a change here "
        "means the finding must be re-measured, not that this bound should move")
    assert loud >= 0.75, (
        f"seed={LOUD_SEED} called {loud:.1%} of a doublet-free matrix; it called 97.5% when "
        "this was measured. If this has DROPPED, something now constrains the automatic "
        "threshold — find out what, and revisit DEC-23 and the pinning test below")
    # …and it is the same generator, the same parameters, and the same code path. Only the
    # seed differs, which is what makes it a property of the method and not of the input.
    # `>=`, not `>`: the two bounds above jointly PERMIT a spread of exactly 0.70, so a
    # strict `>` here would reject a tree that satisfied both of them — a red with no
    # coherent diagnosis. (Measured spread is 0.975, nowhere near either edge.)
    assert loud - quiet >= 0.70


def test_the_report_cannot_distinguish_the_two_runs(tmp_path_factory):
    """THE PIN. Nothing a reader — or the readout, or the exported methods paragraph — can
    see says these two runs are different in kind.

    This is the executable form of the gap. It fails the moment `doublet.detect` grows a
    guard, a warning, a `specificity_warning`, or any field whose value differs between a
    0%-called and a 97.5%-called run. That failure is the intended outcome, not a
    regression: when it fires, delete the pin and assert the new behaviour.
    """
    require_skimage()
    quiet_run = _run(tmp_path_factory.mktemp("q2"), QUIET_SEED)
    loud_run = _run(tmp_path_factory.mktemp("l2"), LOUD_SEED)
    q, l = quiet_run.report(), loud_run.report()

    # Both are `automatic`: Scrublet returned a threshold for the 97.5% run too, so the
    # absence-is-absence machinery (INV-3) never engages. That is the mirror case it does
    # not cover — a threshold that was FOUND and is meaningless, rather than one that was
    # not found and would have been fabricated.
    assert q["threshold_source"] == "automatic"
    assert l["threshold_source"] == "automatic"
    assert q["call_emitted"] is True and l["call_emitted"] is True

    # THE PIN, and it compares VALUES rather than key sets.
    #
    # An earlier version asserted `set(q) == set(l)` and the same for the batch record.
    # Those cannot fail: `report` and each batch record are single dict literals with NO
    # conditional keys, so no behavioural difference between two runs of the same code can
    # change either key set — and a code change that ADDS a key adds it to both runs, so
    # the comparison stays green through exactly the event it was meant to catch. Proven:
    # a mutation adding `report["specificity_note"] = f"called {n} of {m} cells doublet"`,
    # whose VALUE differs between the two runs, left all 527 tests green.
    #
    # So the assertion is over the set of keys whose VALUES differ. Every member below is a
    # count, a threshold, a histogram or a size — arithmetic that follows from the data.
    # None of them is a verdict. A guard, a warning, a `specificity_note` or any other
    # quality signal necessarily differs between a 0%-called and a 97.5%-called run, so it
    # joins this set and this assertion goes RED. That is the door the docstring claims to
    # close, and this is what actually closes it.
    top_differing = {k for k in q if q[k] != l[k]}
    assert top_differing == {"batches", "ceiling", "histogram_by_batch", "n_called",
                             "threshold_by_batch"}, sorted(top_differing)

    batch_differing = {k for k in q["batches"][0] if q["batches"][0][k] != l["batches"][0][k]}
    assert batch_differing == {"n_called", "pct_called", "sim_score_histogram",
                               "threshold"}, sorted(batch_differing)

    # The `warnings` channel specifically: EMPTY on both, measured. An earlier version
    # looped over `l["warnings"]` checking for alarming words — dead code, because the list
    # is empty, so its five assertions never executed. Pinning the emptiness is the honest
    # form: the compute says nothing at all about a run that called 97.5% of the cells.
    assert q["warnings"] == [] and l["warnings"] == [], (
        f"the compute now warns about one of these runs (quiet={q['warnings']!r}, "
        f"loud={l['warnings']!r}); the silence this test pins is over — re-read DEC-23")


def test_the_realised_call_rate_can_exceed_its_own_prior_by_orders_of_magnitude(
        tmp_path_factory):
    """Names the exact quantity a future guard would compare, and shows nothing compares it.

    The compute already derives `expected_doublet_rate` per population — it is recorded in
    the batch record. On the loud run the REALISED call rate exceeds that prior by more than
    two orders of magnitude, and the run succeeds without comment. A guard has everything it
    needs and does not exist; this is not a missing measurement, it is a missing check.
    """
    require_skimage()
    D = load_compute()
    run = _run(tmp_path_factory.mktemp("prior"), LOUD_SEED)
    rec = run.report()["batches"][0]
    realised, _ = _called_fraction(run)

    prior, source = D.resolve_expected_rate(120, rate_per_1k=D.DEFAULT_RATE_PER_1K,
                                            explicit=None)
    assert source == "auto_10x_0.8pct_per_1k"
    # 120 cells * 0.008/1000 = 0.00096, clamped UP to the floor.
    assert prior == pytest.approx(D.RATE_FLOOR)
    assert rec["expected_doublet_rate"] == pytest.approx(prior)

    # At 120 cells the rate is CLAMPED, so the two assertions above hold for any
    # `DEFAULT_RATE_PER_1K` whose raw value falls under the floor — halving it to the
    # HT-chip 0.004 leaves them green while the `source` string still says "0.8pct". So the
    # constant is also pinned where the clamp is NOT active, which is the only place the
    # rate model is observable. Without this, this test names a quantity it cannot see.
    unclamped, _ = D.resolve_expected_rate(2700, rate_per_1k=D.DEFAULT_RATE_PER_1K,
                                           explicit=None)
    assert D.RATE_FLOOR < unclamped < D.RATE_CEILING, "2700 cells must be off both clamps"
    assert unclamped == pytest.approx(0.008 * 2700 / 1000), (
        "the 10x loading rule the `auto_10x_0.8pct_per_1k` label names is no longer what "
        "the compute computes")

    assert realised / prior > 100, (
        f"realised {realised:.3f} vs prior {prior:.3f} — the discrepancy this pins has "
        "changed size; re-measure before adjusting the bound")
    # The run reports success. Both quantities sit in the same record, unrelated.
    assert rec["threshold_source"] == "automatic"
