#!/usr/bin/env python3
# ruff: noqa
"""The `aggregation` column — a metric row states its OWN reducer, denominator included.

Every QC metric used to mean exactly one thing: ``100 × Σ(matching genes) / total counts``.
That aggregation was never stated. It was not configurable, not shown, and the emitted
column name (``pct_counts_<name>``) was the only place it surfaced — after the run. So
``pct_mito = 0`` meant either "no mitochondrial reads" or "the regex matched nothing", and
nothing distinguished them.

`aggregation` is a CLOSED SET OF FOUR, and each is a COMPLETE definition INCLUDING its
denominator — there is no separate "as a percentage" flag:

    sum[c]        = Σ_{g∈set} X[c,g]
    mean[c]       = Σ_{g∈set} X[c,g] / |set|            ← DEC-2: |set|, NOT |detected|
    count[c]      = |{ g∈set : X[c,g] > 0 }|
    percentage[c] = 100 · Σ_{g∈set} X[c,g] / Σ_{all g} X[c,g]

A shared "as % of total" flag would imply ONE denominator, and each reducer's natural
percentage has a different one (sum → % of the cell's total counts; count → % of the genes
IN THE SET that were detected; mean → nothing coherent). A flat vocabulary of four keeps
each denominator inside its own definition and makes no meaningless combination
expressible.

The fixture is deliberately TINY and hand-checkable — five genes, three cells, small whole
numbers — because the point of these cases is that a reader can verify the expected values
by eye rather than by re-running the implementation under a different name. It is
synthesized here rather than read off a live project on purpose: three stamp defects in
`_lib/cyto_columns.py` (integer-categorical levels stringified into the level set; `bool`
stamped `kind: numeric`; pandas nullable `boolean` double-stamped) mean a real project's
artifacts cannot be trusted as an oracle for anything.
"""
from __future__ import annotations

import importlib.util
import os

import numpy as np
import pytest

from qc_fixtures import QcRun  # noqa: F401  (imported for its side-effect-free helpers)

_QC_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, "compute", "qc-10x.py")
)


def _load_qc():
    spec = importlib.util.spec_from_file_location("qc10x_aggregation", _QC_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


qc = _load_qc()


# ─────────────────────────── the hand-checkable fixture ───────────────────────────
#
# Genes 0 and 1 are the SET (`^SET_`); genes 2..4 are outside it. Every number below is a
# small whole number so the four expected columns can be read straight off the rows.
#
#            SET_A  SET_B  OTHER_1  OTHER_2  OTHER_3 | set Σ  total | detected in set
#   cell 0 [   4      6      10        0        0  ] |   10     20  |  2
#   cell 1 [   3      0       0        0        7  ] |    3     10  |  1
#   cell 2 [   0      0       5        5        0  ] |    0     10  |  0
#
#   sum        = [10,   3,  0]
#   mean       = [ 5, 1.5,  0]     (Σ ÷ |set| = Σ ÷ 2 — DEC-2)
#   count      = [ 2,   1,  0]
#   percentage = [50,  30,  0]     (100 × set Σ ÷ total)
GENES = ["SET_A", "SET_B", "OTHER_1", "OTHER_2", "OTHER_3"]
SET_PATTERN = r"^SET_"
COUNTS = np.array(
    [
        [4.0, 6.0, 10.0, 0.0, 0.0],
        [3.0, 0.0, 0.0, 0.0, 7.0],
        [0.0, 0.0, 5.0, 5.0, 0.0],
    ],
    dtype=np.float32,
)

EXPECTED = {
    "sum": [10.0, 3.0, 0.0],
    "mean": [5.0, 1.5, 0.0],
    "count": [2.0, 1.0, 0.0],
    "percentage": [50.0, 30.0, 0.0],
}


def _staged(qc_run, metrics, *, counts=COUNTS, genes=GENES):
    """One run over the fixture with `metrics` as the whole `qc_metrics` list."""
    r = qc_run()
    matrix = r.add_matrix(counts)
    r.add_column(genes, slot="gene_names", axis="genes", name="feature_name")
    return r, matrix


# ═══════════════════════ ACCEPTANCE 1 — the four, hand-computed ═══════════════════════


@pytest.mark.parametrize("aggregation", sorted(EXPECTED))
def test_each_aggregation_produces_its_hand_computed_column(qc_run, aggregation):
    """One row per aggregation over the SAME gene set, checked against numbers a reader
    can verify from the fixture table above without running anything."""
    r, _ = _staged(qc_run, [{"name": "m", "pattern": SET_PATTERN, "aggregation": aggregation}])
    r.run_ok({"qc_metrics": [{"name": "m", "pattern": SET_PATTERN, "aggregation": aggregation}]})
    assert r.emitted_columns() == ["m"], r.emitted_columns()
    np.testing.assert_allclose(r.column_values("m"), EXPECTED[aggregation], rtol=1e-6)


def test_the_four_are_computed_side_by_side_in_one_run(qc_run):
    """All four over ONE gene set in ONE run — so a reducer that quietly reused another's
    denominator (the defect the flat vocabulary exists to prevent) shows up as two columns
    that agree when they must not."""
    rows = [
        {"name": f"set_{a}", "pattern": SET_PATTERN, "aggregation": a} for a in sorted(EXPECTED)
    ]
    r, _ = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    for a in EXPECTED:
        np.testing.assert_allclose(r.column_values(f"set_{a}"), EXPECTED[a], rtol=1e-6)
    # …and no two of them are the same column of numbers.
    seen = [tuple(r.column_values(f"set_{a}")) for a in sorted(EXPECTED)]
    assert len(set(seen)) == len(seen), f"two aggregations produced identical columns: {seen}"


def test_an_empty_gene_set_is_zero_everywhere_not_a_division_blowup(qc_run):
    """A pattern that matches NO gene leaves |set| = 0. `mean` must not divide by it, and
    none of the four may emit NaN/inf — a metric column carrying `nan` is unplottable and
    unfilterable, which is a worse answer than 0 for an empty set."""
    rows = [
        {"name": f"none_{a}", "pattern": "^NOTHING_MATCHES_", "aggregation": a}
        for a in sorted(EXPECTED)
    ]
    r, _ = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    for a in EXPECTED:
        values = np.asarray(r.column_values(f"none_{a}"), dtype=float)
        assert np.all(np.isfinite(values)), f"{a} on an empty set produced {values}"
        np.testing.assert_allclose(values, [0.0, 0.0, 0.0])


def test_percentage_of_a_zero_count_cell_is_zero(qc_run):
    """The percentage denominator is the cell's TOTAL counts, so a cell with no counts at
    all has a zero denominator. It reads 0 % (a zero-count cell has 0 % of anything), which
    is what the removed `nan_to_num` produced — pinned so the reducers' rewrite kept it."""
    counts = COUNTS.copy()
    counts[2, :] = 0.0
    rows = [{"name": "pct", "pattern": SET_PATTERN, "aggregation": "percentage"}]
    r, _ = _staged(qc_run, rows, counts=counts)
    r.run_ok({"qc_metrics": rows})
    assert r.column_values("pct")[2] == 0.0


# ═════════════════ ACCEPTANCE 2 — the DELETED builtin path, reproduced ═════════════════
#
# `total_counts` and `n_genes_by_counts` used to be name-matched against a hardcoded
# `BUILTIN_METRIC_NAMES`, carried no pattern, and could not be edited — a special case with
# its own parse path (`parse_builtin_metrics`) and its own UI treatment. Under the
# aggregation vocabulary they are ORDINARY rows: `sum` over all genes and `count` over all
# genes.
#
# The claim that matters is that removing the special case did not change the NUMBERS. So
# the two kernels below are the deleted implementation, copied VERBATIM from
# `qc-10x.py` before this change, applied to the same staged store, and compared directly
# against the emitted ordinary-row columns. A pair of independent expectations
# ("new == handwritten oracle" and, elsewhere, "old == handwritten oracle") would not be
# the same claim: it would prove each matches a third thing rather than each other.


def _deleted_builtin_total_counts(n_cells, indices, data):
    """VERBATIM the deleted `csc_total_counts` builtin kernel."""
    return np.bincount(
        np.asarray(indices, dtype=np.intp),
        weights=np.asarray(data, dtype=float),
        minlength=n_cells,
    )[:n_cells]


def _deleted_builtin_n_genes_by_counts(n_cells, indices, data):
    """VERBATIM the deleted `csc_n_genes_by_counts` builtin kernel."""
    positive = np.asarray(data) > 0
    return np.bincount(np.asarray(indices, dtype=np.intp)[positive], minlength=n_cells)[
        :n_cells
    ].astype(float)


def _csc_trio(store):
    import cyto_csc

    indptr, indices, data = cyto_csc.read_csc(store)
    return np.asarray(indptr), np.asarray(indices), np.asarray(data)


def test_total_counts_as_an_ordinary_row_equals_the_deleted_builtin(qc_run):
    rows = [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]
    r, matrix = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    _indptr, indices, data = _csc_trio(matrix)
    np.testing.assert_array_equal(
        np.asarray(r.column_values("total_counts"), dtype=float),
        _deleted_builtin_total_counts(COUNTS.shape[0], indices, data),
        err_msg=(
            "`total_counts` produced as an ordinary `sum` over `.*` differs from what the "
            "deleted builtin path produced for the same input — the special case was removed "
            "AND the results moved, which is not the change that was made"
        ),
    )


def test_n_genes_as_an_ordinary_row_equals_the_deleted_builtin(qc_run):
    rows = [{"name": "n_genes", "pattern": ".*", "aggregation": "count"}]
    r, matrix = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    _indptr, indices, data = _csc_trio(matrix)
    np.testing.assert_array_equal(
        np.asarray(r.column_values("n_genes"), dtype=float),
        _deleted_builtin_n_genes_by_counts(COUNTS.shape[0], indices, data),
        err_msg=(
            "`n_genes` produced as an ordinary `count` over `.*` differs from what the deleted "
            "builtin path produced for the same input"
        ),
    )


def test_the_equality_above_is_discriminating(qc_run):
    """NEGATIVE CONTROL for the two comparisons above. They would also pass if BOTH sides
    were trivially zero, or if `sum` and `count` were the same reducer. This pins that the
    deleted kernels return two DIFFERENT, non-degenerate columns on this fixture — so an
    equality against them is a real constraint."""
    r, matrix = _staged(qc_run, [{"name": "x", "pattern": SET_PATTERN, "aggregation": "sum"}])
    r.run_ok({"qc_metrics": [{"name": "x", "pattern": SET_PATTERN, "aggregation": "sum"}]})
    _indptr, indices, data = _csc_trio(matrix)
    totals = _deleted_builtin_total_counts(COUNTS.shape[0], indices, data)
    genes = _deleted_builtin_n_genes_by_counts(COUNTS.shape[0], indices, data)
    np.testing.assert_array_equal(totals, [20.0, 10.0, 10.0])
    np.testing.assert_array_equal(genes, [3.0, 2.0, 2.0])


# ═══════════════════ DEC-2 — the mean denominator is |set|, not |detected| ═══════════════


def test_mean_divides_by_the_SET_size_not_the_detected_count(qc_run):
    """`Σ / |set|` counts undetected genes as zeros; `Σ / |{detected}|` does not, and they
    give different numbers. `|set|` is chosen because "the mean expression of my
    housekeeping set" conventionally includes the zeros — a gene that is off is
    information, not a missing value — and because the alternative is expressible as `sum`
    ÷ `count` from two rows, whereas the reverse is not.

    Cell 1 is the discriminator: ONE of the set's TWO genes is detected, carrying 3.
      Σ / |set|      = 3 / 2 = 1.5   ← what this spec means by `mean`
      Σ / |detected| = 3 / 1 = 3.0   ← the other defensible reading
    """
    rows = [{"name": "m", "pattern": SET_PATTERN, "aggregation": "mean"}]
    r, _ = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    values = r.column_values("m")
    assert values[1] == pytest.approx(1.5), (
        f"mean[cell 1] is {values[1]} — 3.0 would mean the denominator is the DETECTED count "
        "(1 gene) rather than the set size (2 genes)"
    )
    assert values[1] != pytest.approx(3.0)


def test_the_other_denominator_is_reachable_as_sum_over_count(qc_run):
    """The reason `|set|` is the safe choice, as an executable fact: a user who wants the
    detected-only mean can build it from two rows (`sum` ÷ `count`), so nothing is lost.
    The reverse — recovering `Σ / |set|` from a detected-only mean — needs |set|, which no
    emitted column carries."""
    rows = [
        {"name": "s", "pattern": SET_PATTERN, "aggregation": "sum"},
        {"name": "n", "pattern": SET_PATTERN, "aggregation": "count"},
    ]
    r, _ = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    s = np.asarray(r.column_values("s"), dtype=float)
    n = np.asarray(r.column_values("n"), dtype=float)
    detected_mean = np.divide(s, n, out=np.zeros_like(s), where=n > 0)
    np.testing.assert_allclose(detected_mean, [5.0, 3.0, 0.0])


# ═══════════════════ ACCEPTANCE 3 — DEC-4, an unknown aggregation is FATAL ══════════════
#
# `parse_qc_metrics` must refuse a row whose `aggregation` is absent or outside the closed
# set, NAMING the row. It must NOT fall back to `percentage` for compatibility: a silent
# default is exactly how the current invisible aggregation arose, and re-introducing one
# under the banner of migration would re-introduce the defect.


@pytest.mark.parametrize(
    "entry",
    [
        {"name": "no_agg", "pattern": SET_PATTERN},                       # absent
        {"name": "no_agg", "pattern": SET_PATTERN, "aggregation": None},  # explicit null
        {"name": "no_agg", "pattern": SET_PATTERN, "aggregation": ""},    # empty
        {"name": "no_agg", "pattern": SET_PATTERN, "aggregation": "median"},   # outside the set
        {"name": "no_agg", "pattern": SET_PATTERN, "aggregation": "SUM"},      # wrong case
        {"name": "no_agg", "pattern": SET_PATTERN, "aggregation": "percent"},  # near-miss
        # the pre-aggregation shape: a stale row from before this column existed.
        {"id": "m_total", "name": "total_counts", "builtin": True},
    ],
)
def test_an_absent_or_unknown_aggregation_is_refused(entry):
    with pytest.raises(qc.InvalidAggregation) as excinfo:
        qc.parse_qc_metrics({"qc_metrics": [entry]}, [])
    assert "no_agg" in str(excinfo.value) or "total_counts" in str(excinfo.value), (
        f"the refusal does not name the offending row: {excinfo.value}"
    )


def test_the_refusal_names_the_closed_set():
    """A refusal that does not say what IS accepted makes the user guess."""
    with pytest.raises(qc.InvalidAggregation) as excinfo:
        qc.parse_qc_metrics({"qc_metrics": [{"name": "x", "pattern": "^A", "aggregation": "median"}]}, [])
    message = str(excinfo.value)
    for accepted in ("sum", "mean", "count", "percentage"):
        assert accepted in message, f"the refusal does not name {accepted!r}: {message}"


def test_an_unknown_aggregation_is_NOT_defaulted_to_percentage(qc_run):
    """The compatibility shim that must not exist. Were an unknown aggregation defaulted,
    this row would emit `50, 30, 0` (the percentage column) and the run would succeed."""
    rows = [{"name": "m", "pattern": SET_PATTERN, "aggregation": "median"}]
    r, _ = _staged(qc_run, rows)
    proc = r.run({"qc_metrics": rows})
    assert proc.returncode != 0, (
        "an unknown aggregation was silently answered:\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )
    diag = r.diagnostics(proc)
    assert "median" in diag and "m" in diag, f"the diagnostic does not name the row: {diag!r}"
    assert not (r.outputs_dir / "obs.json").exists(), "a refused run still wrote obs.json"


def test_missing_aggregation_is_a_valueerror_subclass():
    """`InvalidAggregation` extends `ValueError`, so an existing `except ValueError` around
    the metric helpers still catches it (the same relationship `MissingGenePattern` has)."""
    assert issubclass(qc.InvalidAggregation, ValueError)


def test_the_shipped_default_set_carries_an_aggregation_on_every_row():
    """`DEFAULT_QC_METRICS` is what `parse_qc_metrics` uses when `params.json` omits the
    key, so a default row missing an aggregation would make the omitted-params run refuse
    itself."""
    parsed = qc.parse_qc_metrics({}, [])
    assert parsed, "the default set parsed to nothing"
    for m in parsed:
        assert m["aggregation"] in qc.AGGREGATIONS, m


# ═══════════════════════ DEC-1 — the column name is the row's name ═════════════════════


def test_the_emitted_column_name_is_the_metrics_name_verbatim(qc_run):
    """No decoration. With four aggregations the old `pct_counts_<name>` decoration would
    have to VARY by aggregation (`sum_`/`mean_`/`count_`/`pct_`), which is a rule the user
    has to learn in order to predict their own output. The `name` cell IS the column."""
    rows = [
        {"name": "pct_mito", "pattern": SET_PATTERN, "aggregation": "percentage"},
        {"name": "housekeeping_mean", "pattern": SET_PATTERN, "aggregation": "mean"},
    ]
    r, _ = _staged(qc_run, rows)
    r.run_ok({"qc_metrics": rows})
    assert r.emitted_columns() == ["pct_mito", "housekeeping_mean"], r.emitted_columns()
    # …and specifically NOT the old decoration.
    for col in r.emitted_columns():
        assert not col.startswith("pct_counts_"), col


def test_the_modality_prefix_still_applies_to_the_verbatim_name(qc_run):
    """DEC-1 is about the DECORATION the compute invented, not about the per-matrix prefix,
    which comes from the answering matrix's own declaration (INV-6/INV-8)."""
    r = qc_run()
    r.add_matrix(COUNTS)
    r.add_matrix(COUNTS)
    r.add_column(GENES, slot="gene_names", axis="genes", name="feature_name")
    r.add_column(GENES, slot="gene_names", axis="genes", name="feature_name")
    rows = [{"name": "pct_mito", "pattern": SET_PATTERN, "aggregation": "percentage"}]
    r.run_ok({"qc_metrics": rows, "matrix_modalities": ["rna", "hto"]})
    assert r.emitted_columns() == ["rna:pct_mito", "hto:pct_mito"], r.emitted_columns()


def test_two_rows_with_the_SAME_name_are_refused(qc_run):
    """With the name becoming the column verbatim, two rows sharing a name would write one
    column labelled as two — the same class as the modality-key collision `modality_keys`
    already refuses. It used to de-dup silently to the first occurrence, which under the
    old decoration merely dropped a duplicate `pct_counts_x`; now it would drop a row whose
    aggregation differs from the one that survived."""
    rows = [
        {"name": "x", "pattern": SET_PATTERN, "aggregation": "sum"},
        {"name": "x", "pattern": SET_PATTERN, "aggregation": "count"},
    ]
    with pytest.raises(qc.DuplicateMetricName) as excinfo:
        qc.parse_qc_metrics({"qc_metrics": rows}, [])
    assert "x" in str(excinfo.value)


def test_a_duplicate_name_fails_the_real_run(qc_run):
    rows = [
        {"name": "x", "pattern": SET_PATTERN, "aggregation": "sum"},
        {"name": "x", "pattern": SET_PATTERN, "aggregation": "count"},
    ]
    r, _ = _staged(qc_run, rows)
    proc = r.run({"qc_metrics": rows})
    assert proc.returncode != 0, f"{proc.stdout}\n{proc.stderr}"
    assert "x" in r.diagnostics(proc), r.diagnostics(proc)
    assert not (r.outputs_dir / "obs.json").exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
