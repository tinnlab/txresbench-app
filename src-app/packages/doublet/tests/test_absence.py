#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [acceptance] [invariant: INV-3] [covers: ITEM-6] — ABSENCE IS ABSENCE.

*A call column is emitted only when a threshold was actually determined. Never substitute a
fabricated threshold, and never emit an all-`singlet` column.*

This is not a defensive test against a hypothetical: it is a test against what the shipped
library actually does. Read `scanpy/preprocessing/_scrublet/`:

  * `Scrublet.call_doublets` sets `predicted_doublets_ = None` and never sets `threshold_`
    when `skimage.filters.threshold_minimum` raises (the simulated-score histogram has no
    minimum between two modes because it is not bimodal);
  * `_scrublet_call_doublets` then writes `adata.obs["predicted_doublet"] = False` for EVERY
    cell and omits `uns["scrublet"]["threshold"]`.

So a wrapper that simply forwards scanpy's output ships an all-`singlet` column that reads
as a confident answer to a question the method could not answer. The doctrine this package
follows is `de/result`'s: OMIT `padj` rather than filling it with 1. Here that means the
score column is emitted and the CALL ARTIFACT IS NOT WRITTEN AT ALL.

If flipping this invariant off — forwarding scanpy's all-False column — the assertions below
go red at `entry("doublet_call") is None`.
"""
import numpy as np
import pytest

from doublet_fixtures import (degenerate_counts, require_skimage, structured_counts,
                              unscoreable_counts)


def test_no_call_artifact_when_the_threshold_is_undetermined(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(degenerate_counts(20, 40, seed=0))
    run.run_ok({"n_prin_comps": 5})

    # the SCORE is emitted — the method did produce scores, and they are usable
    assert run.entry("doublet_score") is not None
    scores = run.scores()
    assert np.isfinite(scores).all()

    # …and the CALL artifact is ABSENT. Not present-and-empty, not present-and-all-singlet:
    # absent. A downstream reader cannot mistake "no call" for "no doublets".
    assert run.entry("doublet_call") is None, (
        "a call column was emitted for a run whose threshold was never determined — this is "
        "the fabricated all-singlet answer INV-3 refuses"
    )
    ids = [e["id"] for e in run.entries()]
    assert not any("call" in i for i in ids), ids


def test_the_report_records_the_refusal_and_its_reason(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(degenerate_counts(20, 40, seed=0))
    run.run_ok({"n_prin_comps": 5})
    report = run.report()

    assert report["threshold_source"] == "undetermined"
    assert report["call_emitted"] is False
    assert report["call_column"] is None
    assert report["call_levels"] is None

    batch = report["batches"][0]
    assert batch["threshold"] is None
    assert batch["threshold_source"] == "undetermined"
    reason = batch["threshold_reason"]
    # the reason NAMES the mechanism and the reachable lever, rather than saying "failed"
    assert reason and "bimodal" in reason.lower(), reason
    assert "threshold" in reason.lower()
    assert any("bimodal" in w.lower() for w in report["warnings"]), report["warnings"]


def test_an_explicit_threshold_is_the_reachable_lever(detect_run):
    """The refusal is not a dead end: the SAME degenerate input, given a threshold, produces
    a call — and the report says the threshold came from the user, not from detection."""
    run = detect_run()
    run.add_matrix(degenerate_counts(20, 40, seed=0))
    run.run_ok({"n_prin_comps": 5, "threshold": "0.5"})

    assert run.entry("doublet_call") is not None
    report = run.report()
    assert report["threshold_source"] == "user"
    assert report["batches"][0]["threshold"] == 0.5
    assert report["call_emitted"] is True
    # two levels only — nothing was excluded, so `not_evaluated` is not declared
    assert report["call_levels"] == ["singlet", "doublet"]


def test_a_determined_threshold_still_produces_a_call(detect_run):
    """The control for the two tests above: on an ORDINARY input the automatic threshold IS
    found and the call IS emitted. Without this, an implementation that never emits a call
    would pass the whole file."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok({"n_prin_comps": 10})

    report = run.report()
    assert report["threshold_source"] == "automatic"
    assert report["call_emitted"] is True
    assert run.entry("doublet_call") is not None
    assert report["batches"][0]["threshold"] is not None
    calls = run.calls()
    assert set(calls) <= {"singlet", "doublet"}
    # …and the call actually AGREES with the score and the recorded threshold, so the column
    # is the threshold applied rather than a constant.
    thr = report["batches"][0]["threshold"]
    scores = run.scores()
    expected = ["doublet" if s > thr else "singlet" for s in scores]
    assert calls == expected


def test_a_population_scrublet_cannot_score_is_a_named_refusal(detect_run):
    """A degenerate population makes scanpy raise deep inside its own PCA. That must reach
    the user as OUR refusal naming the population and the levers — never as
    `ValueError: Found array with 0 feature(s)`, which says nothing about which sample failed
    or what to do."""
    run = detect_run()
    run.add_matrix(unscoreable_counts(40, 40))
    proc = run.run({"n_prin_comps": 5})

    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert diag, f"the refusal was not emitted under the package prefix:\n{proc.stderr[-2000:]}"
    assert "Scrublet could not score" in diag
    assert "n_prin_comps" in diag         # a named lever
    # OUR refusal is the LAST thing the user sees, not a traceback frame after it.
    assert proc.stderr.strip().splitlines()[-1].startswith("doublet.detect:"), (
        "a raw traceback surfaced after the named refusal:\n" + proc.stderr[-800:])
    # the manifest.json must NOT exist — a refused run commits nothing
    assert not (run.outputs_dir / "manifest.json").exists()
