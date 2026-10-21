#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 — ABSENCE IS ABSENCE, and the RAW-COUNT GATE. The R lane's half of two refusals
the python lane already holds.

── Why this file exists, and it is not a hypothetical ─────────────────────────────────────
Both tests here were written to close a MEASURED gap. A mutation battery over this branch
ran twelve single-target mutations of the shipped R code; ten were caught by the existing
suite and two were not:

    M8   `if (any_scored)` -> `if (TRUE)`   — emit the CALL column even when NOTHING was
                                              scored, i.e. fabricate an all-`singlet`
                                              answer to a question the method could not
                                              answer.                          MISSED
    M10  the raw-count gate's `if (non_integer > 0)` -> `if (FALSE)` — accept a NORMALIZED
                                              matrix and score it anyway.      MISSED

Neither is an exotic defect. They are the two most dangerous things this analysis can do,
because both produce a COMPLETE, WELL-FORMED, CONFIDENT result that passes every structural
check: the columns are the right length, the right dtype, the right levels, and they
conform. Nothing downstream can tell the difference. They were missed for the ordinary
reason — every other fixture in the suite is a healthy raw-count matrix on which everything
scores, so no test ever reached either branch.

That is the "ask what your fixtures cannot express" failure in its usual shape: the battery
was not blind because the tests were weak, it was blind because every fixture was HEALTHY
by construction. This file supplies the two unhealthy ones.

── The rule these two share ───────────────────────────────────────────────────────────────
A method that cannot answer must SAY SO, not answer anyway. The python lane states it as
its INV-3 ("no threshold determined ⇒ the call artifact is omitted entirely"), and its
`test_absence.py` is this file's model. The R lane's mechanism is different — scDblFinder
picks its own threshold, so the way it fails to answer is that no population could be
scored at all — but the obligation is identical, and so is the failure mode if it is
dropped.
"""
import numpy as np
import pytest

from doublet_fixtures import (ScdblfinderRun, counts_matrix, counts_with_doublets,
                              require_r_env, structured_counts)


@pytest.fixture(autouse=True)
def _needs_r():
    require_r_env()


# ── 1. ABSENCE IS ABSENCE (closes M8) ─────────────────────────────────────────────────

def test_when_NOTHING_could_be_scored_the_call_column_is_OMITTED_not_fabricated():
    """The mutation this test exists for turns `if (any_scored)` into `if (TRUE)`, which
    writes a full-length CALL column on a run where the method scored nothing. Every cell
    reads `not_evaluated`... or, on a different day and a different code path, `singlet`.
    Either way the artifact asserts a per-cell answer that was never computed, and a
    downstream `cell.filter` keep-singlets criterion over it would silently keep everything.

    The construction: a sample column whose every level is BELOW `MIN_CELLS_PER_BATCH`, so
    every level is a named refusal and no level is scored. That is a real state a user can
    reach — a many-sample plate with thin lanes — not a contrived one.

    What is asserted is the ABSENCE of an artifact, which is a claim that needs the positive
    control beside it or it passes vacuously on a run that simply failed. So this also
    asserts the run SUCCEEDED, the score column IS present and full-length, the report says
    `call_emitted: false`, and every level carries its own refusal reason. Absence of the
    call column with presence of everything else is the only shape that passes.
    """
    # 6 levels x 20 cells = 120 cells, every level below the 30-cell minimum.
    n_per, n_levels = 20, 6
    counts = structured_counts(n_per_group=n_per * 2, n_genes=120, n_groups=n_levels // 2,
                               seed=0)[: n_per * n_levels]
    labels = [f"lane{i // n_per}" for i in range(n_per * n_levels)]

    run = ScdblfinderRun(pytest.importorskip("pathlib").Path(
        __import__("tempfile").mkdtemp(prefix="scdbl-absence-")))
    run.add_matrix(counts)
    run.add_column(__import__("pandas").Categorical(labels), slot="batch")
    proc = run.run_ok({"seed": "0", "batch_column": "lane"})

    report = run.report()
    # The POSITIVE CONTROL: the run really ran and really produced its other artifacts.
    assert proc.returncode == 0
    assert report["n_cells"] == n_per * n_levels
    assert run.entry("_score") is not None, "the score column is still emitted"
    assert len(run.scores()) == n_per * n_levels

    # …every level refused, by name, with a reason.
    assert report["n_batches"] == n_levels
    assert report["n_evaluated"] == 0
    for rec in report["batches"]:
        assert rec["scored"] is False, rec
        assert "refusal" in rec and str(MIN := 30) in rec["refusal"], rec

    # …and THE CALL COLUMN IS ABSENT. Not present-and-empty, not present-and-all-singlet.
    assert report["call_emitted"] is False
    assert run.entry("_call") is None, (
        "a CALL column was emitted on a run that scored nothing — that is a confident "
        "per-cell answer to a question the method could not answer, and it is exactly the "
        "state this test exists to forbid")
    assert not list(run.outputs_dir.glob("metadata/*_call.zarr"))

    # …and the scores are NaN throughout, so the score column does not fabricate either.
    assert np.isnan(run.scores()).all()


def test_the_ordinary_run_DOES_emit_a_call_column():
    """TEST-27 — The control that stops the test above from passing for the wrong reason.

    "The call column is absent" is satisfied by a compute that never emits one at all. This
    is the same fixture shape that the rest of the suite uses, and here the column MUST be
    present — so the absence above is a response to the input rather than a property of the
    entry.
    """
    counts, _n_real = counts_with_doublets(n_per_group=60, n_genes=150, n_groups=3,
                                           n_doublets=12, seed=0)
    run = ScdblfinderRun(pytest.importorskip("pathlib").Path(
        __import__("tempfile").mkdtemp(prefix="scdbl-present-")))
    run.add_matrix(counts)
    run.run_ok({"seed": "0"})
    assert run.report()["call_emitted"] is True
    assert run.entry("_call") is not None
    assert set(run.calls()) & {"singlet", "doublet"}


# ── 2. THE RAW-COUNT GATE (closes M10) ────────────────────────────────────────────────

def test_a_NORMALIZED_matrix_is_refused_by_name_not_silently_scored():
    """TEST-28 — The mutation this test exists for disables the raw-count gate, and the result is the
    worst kind of wrong: scDblFinder normalizes and selects features INTERNALLY, so handing
    it already-normalized data does not fail — it produces a complete, plausible,
    meaningless score for every cell.

    The gate is re-checked FROM THE STORED VALUES rather than from the artifact's declared
    subtype or from the form, because an agent/MCP call reaches this compute without ever
    rendering a form, and `appliesTo`'s `excludes` is a launcher-side filter, not a compute
    contract.

    The refusal must NAME the problem — a bare non-zero exit would leave a user staring at
    an R traceback from inside a sandbox.
    """
    counts = counts_matrix(80, 120, seed=0)
    # Normalized, the way a real normalize step leaves it: non-integer stored values.
    normalized = counts / (counts.sum(axis=1, keepdims=True) + 1.0) * 1e4

    run = ScdblfinderRun(pytest.importorskip("pathlib").Path(
        __import__("tempfile").mkdtemp(prefix="scdbl-norm-")))
    run.add_matrix(normalized)
    proc = run.run({"seed": "0"})

    assert proc.returncode != 0, (
        "a NORMALIZED matrix was accepted and scored. scDblFinder normalizes internally, so "
        "this does not fail loudly — it produces meaningless scores for every cell, which "
        "is why the gate exists.\n" + proc.stdout + proc.stderr)
    msg = proc.stderr
    assert "raw" in msg.lower(), msg
    assert "non-integer" in msg.lower() or "not raw counts" in msg.lower(), msg
    # …and nothing was written: a refused run leaves no manifest.
    assert not (run.outputs_dir / "manifest.json").exists()


def test_a_matrix_with_negative_values_is_refused_by_name():
    """TEST-29 — The other half of the same gate. Scaled (z-scored) data is the common way a matrix
    acquires negatives, and it is even further from raw counts than normalized data is."""
    counts = counts_matrix(80, 120, seed=1)
    scaled = counts - counts.mean(axis=0, keepdims=True)

    run = ScdblfinderRun(pytest.importorskip("pathlib").Path(
        __import__("tempfile").mkdtemp(prefix="scdbl-neg-")))
    run.add_matrix(scaled)
    proc = run.run({"seed": "0"})

    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "negative" in proc.stderr.lower(), proc.stderr
    assert "raw" in proc.stderr.lower(), proc.stderr
    assert not (run.outputs_dir / "manifest.json").exists()


def test_the_gate_does_NOT_refuse_ordinary_raw_counts():
    """TEST-30 — The control for both refusals above.

    A gate that refused everything would satisfy the two tests above perfectly, and this
    analysis would be dead. Integer-valued counts — including a matrix with plenty of
    zeros, which is what a real sparse store looks like — must pass through it untouched.
    """
    counts, _n_real = counts_with_doublets(n_per_group=60, n_genes=150, n_groups=3,
                                           n_doublets=12, seed=2)
    assert (counts == np.round(counts)).all(), "the fixture must really be integer-valued"
    run = ScdblfinderRun(pytest.importorskip("pathlib").Path(
        __import__("tempfile").mkdtemp(prefix="scdbl-raw-")))
    run.add_matrix(counts)
    proc = run.run_ok({"seed": "0"})
    assert proc.returncode == 0
    assert (run.outputs_dir / "manifest.json").exists()
