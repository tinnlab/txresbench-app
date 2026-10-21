#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 [acceptance] [invariant: INV-10] [covers: ITEM-4] — a `maxCells`/downsample cap that
does not downsample is not shipped: no such param exists, and the provenance never records a cap
that was not applied (it records the FULL tested-cell count)."""
from pathlib import Path

from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"
_UI = Path(__file__).resolve().parents[1] / "ui"


def test_no_maxcells_or_downsample_param_exists():
    # the cap is wired or it does not exist — it does not exist here (INV-10 / D1).
    for f in _COMPUTE.glob("*.py"):
        low = f.read_text().lower()
        assert "maxcells" not in low and "downsample" not in low, f.name
    for f in _UI.glob("*.yaml"):
        low = f.read_text().lower()
        assert "maxcells" not in low and "downsample" not in low, f.name


def test_report_records_the_full_tested_cell_count_not_a_phantom_cap(markers_run):
    n_per = 30
    run = markers_run()
    run.add_expression(two_group_expression(n_per=n_per))
    run.add_column(group_labels(n_per=n_per), slot="grouping", name="grp", provenance=MATRIX_DERIVED)
    run.run_ok({})
    assert run.report()["n_cells"] == 2 * n_per  # every cell tested; no unapplied cap recorded
