#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 [e2e] [covers: ITEM-3, ITEM-4, ITEM-5] — the REAL-COMPUTE advanced path as a SUBPROCESS.

The `de_fixtures.DeRun` harness runs `compute/compare.py` as an actual subprocess through the
`/inputs`↔`/outputs` seam (meaningless mount names), so the whole advanced path — criteria masks,
overlap refusal, regime, banded readout — runs for real. Two arms:

  · two DISJOINT all-external criteria groups → a `de/result` (R3 ranked readout here, since no
    inferential wheel is staged off-rootfs; the R1 members arm is covered by test_contrast_regime);
  · an OVERLAPPING criteria pair → the named overlap refusal (INV-A3), pre-compute."""
from de_fixtures import EXTERNAL, group_labels, two_group_expression


def test_advanced_disjoint_produces_de_result(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=5))
    run.add_column(group_labels(30, ("treated", "control")), slot="column:condition",
                   name="condition", provenance=EXTERNAL)
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    proc = run.run_ok({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "condition", "keep": ["treated"]},
                            {"column": "score", "min": "0", "max": "29"}],
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],
    })
    ents = run.de_entries()
    assert len(ents) == 1
    rep = run.report()
    assert rep["regime"] in ("R1", "R2", "R3")
    assert rep["grouping_provenance"]["advanced_contrast"] is True
    # the ranked readout members are always present.
    members = run.de_members(ents[0])
    assert {"gene", "logFC", "pct_1", "pct_2", "n_1", "n_2"} <= members
    # progress ran end-to-end.
    assert "done" in run.progress_phases(proc)


def test_advanced_overlap_drives_named_refusal(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=5))
    run.add_column([str(i) for i in range(60)], slot="column:score", name="score",
                   provenance=EXTERNAL)
    proc = run.run({
        "contrast_mode": "advanced",
        "group1_criteria": [{"column": "score", "min": "0", "max": "35"}],
        "group2_criteria": [{"column": "score", "min": "30", "max": "59"}],
    })
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert diag.startswith("de.compare:") and "in both group1 and group2" in diag
    # shared cells 30..35 inclusive = 6 cells.
    assert "6 cells" in diag, diag
