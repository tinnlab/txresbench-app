#!/usr/bin/env python3
# ruff: noqa
"""TEST-27 (ITEM-17, DEC-8) — the gene-name SOURCE is an input, not the axis index.

The shipped defect, measured on a real CELLxGENE dataset (3460 x 35477): `qc-10x.py:462`
did `vn = adata.var_names.astype(str)` — hardcoded. On that dataset the index is ENSEMBL
(`ENSG00000198888`) and the symbols live in a separate genes-axis column
(`var["feature_name"]`), so `^MT-|^mt-` matched ZERO genes and `pct_mito` came out **0
with no error**. A user filtering on `pct_mito < 10` then kept every dying cell.

So the gene-name values are an INPUT (`gene_names`), and this suite fails if that input
is ignored.

The second test is the SILENT-ZERO guard and is deliberately permissive about the
response: with no gene-name values available the run may refuse (naming the slot) or it
may record a warning — but it may NOT emit a `pct_mito` column of zeros as if the answer
were 0%.
"""
from __future__ import annotations

import json

import numpy as np

from qc_fixtures import counts_matrix, pct_on

# The CELLxGENE shape: an ENSEMBL-keyed genes axis whose symbols live elsewhere.
ENSEMBL = [
    "ENSG00000198888",  # MT-ND1
    "ENSG00000075624",  # ACTB
    "ENSG00000198804",  # MT-CO1
    "ENSG00000111640",  # GAPDH
    "ENSG00000198712",  # MT-CO2
]
SYMBOLS = ["MT-ND1", "ACTB", "MT-CO1", "GAPDH", "MT-CO2"]
MITO_MASK = [s.startswith("MT-") for s in SYMBOLS]


def _stage(qc_run, *, with_symbols: bool, metrics=None):
    r = qc_run()
    dense = counts_matrix(6, len(ENSEMBL), seed=21)
    r.add_matrix(dense)
    # The genes AXIS INDEX (ENSEMBL ids) is always present — it is what the old code
    # matched against, and it is what DEC-8 makes the default.
    r.add_column(ENSEMBL, slot="genes_index", axis="genes", name="genes_index")
    if with_symbols:
        r.add_column(SYMBOLS, slot="gene_names", axis="genes", name="feature_name")
    default = [{"name": "pct_mito", "pattern": r"^MT-|^mt-", "aggregation": "percentage"}]
    params = {"qc_metrics": metrics if metrics is not None else default}
    return r, dense, params


def test_pct_mito_is_nonzero_when_the_gene_names_input_supplies_symbols(qc_run):
    """THE regression: with the symbols artifact bound to `gene_names`, the mito pattern
    matches and `pct_mito` is non-zero and numerically correct."""
    r, dense, params = _stage(qc_run, with_symbols=True)
    r.run_ok(params)

    assert r.report()["matched_genes"]["pct_mito"] == 3, r.report()["matched_genes"]
    got = np.asarray(r.column_values("pct_mito"), dtype=float)
    assert got.max() > 0.0, f"pct_mito is identically zero — the gene_names input was ignored: {got}"
    np.testing.assert_allclose(got, pct_on(dense, MITO_MASK), rtol=1e-6)


def test_patterns_match_the_gene_names_values_not_the_axis_index(qc_run):
    """Matching is against the VALUES of the bound artifact. An ENSEMBL-only pattern
    (`^ENSG`) matches nothing once symbols are supplied — proof the axis index is not
    what is being read."""
    r, _dense, _p = _stage(qc_run, with_symbols=True)
    r.run_ok({"qc_metrics": [
        {"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"},
        {"name": "ens", "pattern": r"^ENSG", "aggregation": "percentage"},
    ]})
    matched = r.report()["matched_genes"]
    assert matched["pct_mito"] == 3, matched
    assert matched["ens"] == 0, (
        "a pattern over ENSEMBL ids matched — the compute is still reading the axis index"
    )


def test_a_missing_gene_names_input_never_silently_reports_zero(qc_run):
    """The SILENT-ZERO guard. With no gene-name values available the run must not answer
    "0% mitochondrial". Either response is acceptable; silence is not."""
    r, _dense, params = _stage(qc_run, with_symbols=False)
    proc = r.run(params)

    if proc.returncode != 0:
        assert "gene_names" in r.diagnostics(proc), (
            f"it refused, but without naming the slot:\n{proc.stderr}"
        )
        return

    obs = json.loads((r.outputs_dir / "obs.json").read_text())
    warnings = " ".join(obs.get("warnings", []))
    assert warnings or "pct_mito" in obs["columns"], obs.get("warnings")
    if "pct_mito" in obs["columns"]:
        values = np.asarray(obs["obs"]["pct_mito"], dtype=float)
        assert values.max() > 0.0, (
            "pct_mito was emitted as identically zero with no gene-name values available "
            f"— the silent mis-filter. warnings={obs.get('warnings')}"
        )
    else:
        assert "gene_names" in warnings, (
            "the pattern metric was dropped without saying why: "
            f"warnings={obs.get('warnings')}"
        )


def test_a_whole_gene_set_row_STILL_needs_gene_names(qc_run):
    """A DELIBERATE behaviour change, pinned so it is a decision rather than a discovery.

    This test used to read `test_builtin_metrics_do_not_need_gene_names`: `total_counts` /
    `n_genes_by_counts` were computed directly off the CSC trio, so a run selecting only
    them asked no gene-name question and needed no `gene_names` binding.

    With the builtin special case deleted they are ordinary rows — `sum` and `count` over
    the gene set `.*` — and a gene SET is resolved by matching the row's regex against the
    bound gene-name VALUES. So a run that emits any column now binds `gene_names` per
    matrix. The cost is real and narrow: a matrix whose genes axis carries no text column
    at all can no longer produce a total-counts column.

    The alternative was to special-case `.*` as "needs no names", i.e. a hidden rule about
    one pattern VALUE that the user cannot see and cannot state — the same shape as the
    invisible aggregation this whole change removes. Refusing is the readable answer, and
    it names the slot."""
    r, _dense, _p = _stage(
        qc_run, with_symbols=False,
        metrics=[{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
    )
    proc = r.run({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    assert proc.returncode != 0, (
        "a gene-set row was answered with no gene-name values bound:\n"
        f"{proc.stdout}\n{proc.stderr}"
    )
    assert "gene_names" in r.diagnostics(proc), r.diagnostics(proc)


def test_the_same_row_computes_once_gene_names_are_bound(qc_run):
    """The positive control for the refusal above: bind the symbols and the identical row
    produces the per-cell total."""
    r, dense, _p = _stage(
        qc_run, with_symbols=True,
        metrics=[{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
    )
    r.run_ok({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    np.testing.assert_allclose(r.column_values("total_counts"), dense.sum(axis=1), rtol=1e-6)


# ── the PAIRING, which is where the degrade hid ───────────────────────────────
#
# `gene_names` is list-aligned with `matrices` (entry i is matrix i's symbols). A run that
# cannot pair one to a matrix used to DROP that matrix's pattern metrics with a warning
# recorded inside `obs.json` — better than the zero column it replaced, and still a wrong
# answer with no failure: the user asked for `pct_mito` on both matrices, got it on one, and
# nothing on the path to the screen says so. A dropped column and a column of zeros differ
# only in which lie they tell.
#
# So an unpairable pattern metric is FATAL, and the diagnostic names the slot and the counts.


def _two_matrix_run(qc_run, *, gene_name_counts: int):
    r = qc_run()
    a = counts_matrix(6, len(ENSEMBL), seed=51)
    b = counts_matrix(6, len(ENSEMBL), seed=52)
    r.add_matrix(a)
    r.add_matrix(b)
    for _ in range(gene_name_counts):
        r.add_column(SYMBOLS, slot="gene_names", axis="genes", name="feature_name")
    return r, a, b


def test_a_partial_gene_names_list_is_REFUSED_not_silently_dropped(qc_run):
    """TWO matrices, ONE gene-names artifact. Matrix 1's `pct_mito` is unanswerable, so the
    run must refuse — naming the slot and the two counts — rather than emit matrix 0's
    columns and quietly omit matrix 1's."""
    r, _a, _b = _two_matrix_run(qc_run, gene_name_counts=1)
    proc = r.run({
        "qc_metrics": [{"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"}],
        "matrix_modalities": ["rna", "prot"],
    })
    assert proc.returncode != 0, (
        "a partial `gene_names` list was accepted; matrix 1's pattern metrics were dropped "
        f"with only a warning:\n{proc.stdout}\n{proc.stderr}"
    )
    diag = r.diagnostics(proc)
    assert "gene_names" in diag, diag
    assert "2" in diag and "1" in diag, f"the diagnostic does not name the counts: {diag}"


def test_pattern_metrics_with_NO_gene_names_are_refused(qc_run):
    """The same rule at zero: a run that selected a pattern metric and bound no gene names
    at all cannot answer it. Refuse, don't warn."""
    r, _dense, params = _stage(qc_run, with_symbols=False)
    proc = r.run(params)
    assert proc.returncode != 0, (
        f"a pattern metric with no gene names was answered anyway:\n{proc.stdout}\n{proc.stderr}"
    )
    assert "gene_names" in r.diagnostics(proc), r.diagnostics(proc)


def test_a_FULL_gene_names_list_pairs_each_artifact_to_ITS_matrix(qc_run):
    """The positive control, and the pairing property itself: two matrices, two gene-name
    artifacts with DIFFERENT symbols, and each matrix's `pct_mito` reflects ITS OWN list."""
    r = qc_run()
    a = counts_matrix(6, 3, seed=61)
    b = counts_matrix(6, 3, seed=62)
    r.add_matrix(a)
    r.add_matrix(b)
    # matrix 0: only gene 0 is mitochondrial. matrix 1: only gene 2 is.
    r.add_column(["MT-ND1", "ACTB", "GAPDH"], slot="gene_names", axis="genes", name="feature_name")
    r.add_column(["ACTB", "GAPDH", "MT-CO1"], slot="gene_names", axis="genes", name="feature_name")
    r.run_ok({
        "qc_metrics": [{"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"}],
        "matrix_modalities": ["rna", "prot"],
    })
    np.testing.assert_allclose(
        r.column_values("rna:pct_mito"), pct_on(a, [True, False, False]), rtol=1e-6
    )
    np.testing.assert_allclose(
        r.column_values("prot:pct_mito"), pct_on(b, [False, False, True]), rtol=1e-6
    )


def test_a_gene_names_list_LONGER_than_the_matrices_is_refused(qc_run):
    """The other side of the same misalignment: a stale extra binding means the caller's
    idea of the pairing and the run's disagree. Refuse rather than pair by truncation."""
    r, _a, _b = _two_matrix_run(qc_run, gene_name_counts=3)
    proc = r.run({
        "qc_metrics": [{"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"}],
        "matrix_modalities": ["rna", "prot"],
    })
    assert proc.returncode != 0, proc.stderr
    assert "gene_names" in r.diagnostics(proc), r.diagnostics(proc)
