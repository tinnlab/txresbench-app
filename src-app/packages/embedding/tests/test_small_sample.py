#!/usr/bin/env python3
# ruff: noqa
"""TEST-19 [acceptance] [invariant: INV-2] [covers: ITEM-15, ITEM-17c] — small-sample.

No code path synthesizes a cell; a run whose POST-FILTER surviving cells fall below the
viable threshold (10, DEC-6) is refused, and the refusal names the count and the threshold.
"""
from embedding_fixtures import counts_matrix


def test_below_threshold_cell_count_is_refused_no_cell_synthesized(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(8, 20, seed=0))  # 8 < 10
    proc = run.run({"n_hvg": 10, "n_pcs": 3, "seed": 0})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "viable threshold" in diag.lower()
    assert "10" in diag                       # names the threshold
    assert "8 cell" in diag                    # names the surviving count
    assert "synthesiz" in diag.lower()         # states no cell is invented
    assert not (run.outputs_dir / "manifest.json").exists()


def test_exactly_at_threshold_is_allowed(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(10, 20, seed=1))  # 10 == threshold → allowed
    run.run_ok({"n_hvg": 8, "n_pcs": 3, "seed": 0})
    assert run.report()["surviving_cells"] == 10
