#!/usr/bin/env python3
# ruff: noqa
"""C3 [correctness] — the NB-GLM estimates a PER-GENE dispersion (doc-13 §6.1 row 4), never the
old mis-calibrating FIXED alpha=1.0. Two genes with clearly different overdispersion get two
different fitted dispersions, and neither is 1.0. The fixed-alpha mutation makes them equal."""
import numpy as np
import pytest

import _methods as METH


def _counts():
    import pandas as pd
    # 8 pseudobulk rows. g_low ≈ Poisson (Var ≈ mean ⇒ alpha ≈ 0); g_high heavily overdispersed
    # (Var ≫ mean ⇒ large alpha).
    return pd.DataFrame(
        {"g_low":  [20, 21, 19, 20, 20, 21, 19, 20],
         "g_high": [1, 80, 2, 120, 0, 60, 3, 150]},
        index=[f"pb{i}" for i in range(8)])


def test_dispersion_is_per_gene_not_fixed_one():
    disp = METH.estimate_nb_dispersions(_counts())
    assert disp["g_low"] != disp["g_high"]
    assert disp["g_high"] > disp["g_low"]            # more overdispersion ⇒ larger alpha
    assert disp["g_low"] != 1.0 and disp["g_high"] != 1.0  # NOT the discarded fixed value


def test_run_nb_glm_records_a_distinct_per_gene_alpha():
    pytest.importorskip("statsmodels")
    import pandas as pd
    counts = _counts()
    design = pd.DataFrame({"group": ["g0", "g0", "g0", "g0", "g1", "g1", "g1", "g1"],
                           "sample": [f"s{i}" for i in range(8)]}, index=counts.index)

    def _fail(m):
        raise RuntimeError(m)

    out = METH._run_nb_glm(counts, design, ("g0", "g1"), fail=_fail)
    # every gene carries the alpha the GLM actually used — a fixed-alpha mutation drops this key
    # (KeyError) or makes the two equal.
    a_low, a_high = out["g_low"]["alpha"], out["g_high"]["alpha"]
    assert a_low != a_high
    assert a_low != 1.0 and a_high != 1.0
    assert a_high > a_low
