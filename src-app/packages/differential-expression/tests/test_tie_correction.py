#!/usr/bin/env python3
# ruff: noqa
"""C4 [correctness] — the banded marker Wilcoxon z is TIE-CORRECTED (the zero block is the
dominant tied group, sparsity-aware), and the recorded provenance is HONEST about what ran
(`mann-whitney-u (tie-corrected, banded)`), not a scanpy version it never called. On a
heavy-zero fixture the tie-corrected z differs from the tie-UNcorrected z; the uncorrected-variance
mutation makes them equal."""
import numpy as np
import scipy.stats as sstats
import scipy.sparse as sp

import markers as MK
from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED


def _uncorrected_z(lognorm, codes, g, ng, n_rest):
    """The OLD tie-UNcorrected Mann-Whitney z for group `g` vs rest — the mutation's formula."""
    ranks = sstats.rankdata(lognorm)
    U = float(ranks[codes == g].sum()) - ng * (ng + 1) / 2.0
    mu = ng * n_rest / 2.0
    sigma = np.sqrt(ng * n_rest * (ng + n_rest + 1) / 12.0)
    return (U - mu) / sigma


def test_tie_corrected_z_differs_from_uncorrected_on_heavy_zero_ties():
    # 12 cells × 2 genes, ~75% zeros (a huge tied block) — exactly scRNA's sparsity.
    dense = np.array([
        [0, 0], [0, 0], [3, 0], [0, 0], [5, 0], [0, 0],
        [0, 2], [0, 0], [0, 0], [4, 0], [0, 0], [0, 0]], dtype=np.float32)
    n_cells, n_genes = dense.shape
    csc = sp.csc_matrix(dense)
    lib = MK._library_sizes(csc.indptr, csc.indices, csc.data, n_cells, n_genes)
    codes = np.array([0] * 6 + [1] * 6, dtype=np.intp)
    out = MK._score_bands(csc.indptr, csc.indices, csc.data, n_cells, n_genes,
                          ["g0", "g1"], codes, 2, lib, "wilcoxon")

    # Recompute the (tie-corrected) impl's normalization to compare with the uncorrected formula
    # gene by gene. The scores must DIFFER on this heavy-tie fixture (tie_factor < 1).
    target = 1e4
    norm = np.where(lib > 0, target / lib, 0.0)
    differed = False
    for j in range(n_genes):
        col = np.asarray(dense[:, j], dtype=np.float64)
        lognorm = np.log1p(col * norm)
        ng, n_rest = 6, 6
        corrected = out[0][j]["score"]
        uncorrected = _uncorrected_z(lognorm, codes, 0, ng, n_rest)
        if not np.isclose(corrected, uncorrected):
            differed = True
            # tie correction SHRINKS sigma ⇒ magnifies |z|.
            assert abs(corrected) > abs(uncorrected)
    assert differed, "tie correction changed no score on a heavy-tie fixture"


def test_recorded_method_matches_what_actually_ran(markers_run):
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({"method": "wilcoxon"})
    # the provenance names the banded tie-corrected Mann-Whitney it ran — NOT "wilcoxon"/a scanpy
    # call it never made.
    assert run.report()["method_ran"] == "mann-whitney-u (tie-corrected, banded)"
    de = run.de_txr(run.de_entries()[0])["de"]
    assert de["method_ran"] == "mann-whitney-u (tie-corrected, banded)"
