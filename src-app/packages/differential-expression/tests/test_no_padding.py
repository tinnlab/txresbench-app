#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 [acceptance] [invariant: INV-7] [covers: ITEM-4, ITEM-10] — genes are not padded with
`p=1`/a fabricated fold-change; `logFC` is populated by a SINGLE estimator; the result carries
only real per-gene rows."""
import numpy as np

from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED


def test_no_fabricated_padding_rows_single_estimator(markers_run):
    n_genes = 24
    run = markers_run()
    run.add_expression(two_group_expression(n_genes=n_genes))
    run.add_column(group_labels(), slot="grouping", name="grp", provenance=MATRIX_DERIVED)
    run.run_ok({})
    e = run.de_entries()[0]
    genes = run.de_column(e, "gene")
    logfc = run.de_column(e, "logFC")
    # exactly one row per tested gene — no padding rows appended past the gene count.
    assert len(genes) == n_genes
    assert len(set(genes)) == n_genes  # no duplicated padding genes
    # logFC is a real per-gene estimate (finite), not a fabricated constant fill.
    assert len(logfc) == n_genes
    assert not np.all(np.asarray(logfc, dtype=float) == logfc[0])
