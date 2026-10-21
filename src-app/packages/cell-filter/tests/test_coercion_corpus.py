"""The COMMITTED kernel's half of the shared criteria-coercion parity corpus, plus the
kernel-only invariants the corpus cannot express (they need an `adata`, which the corpus
— a pure `{criteria, obs}` document read by four readers in three languages — has no way
to carry).

`src-app/testdata/criteria-coercion-corpus.json` is read by FOUR readers:

  1. `provenance/predicate_script.rs::CRITERIA_PRELUDE` (the attested replay script),
     gated by `cargo test … the_emitted_replay_matches_the_shared_coercion_corpus`;
  2. THIS kernel (`criteria_keep_mask`), gated here — and therefore by `just check-py`;
  3. `ui/…/declarative/primitives.ts::keep_mask` (the live preview) and
  4. `libs/workbench-api/…/criteriaPredicate.ts` (the DSL builder), gated by
     `scripts/coercion-parity-ts.mjs`.

`scripts/coercion-parity.mjs` runs all four and requires them to agree cell-for-cell;
each language ALSO gates its own reader here so a regression fails the cheap local gate
without needing the cross-language runner. See
`src-app/testdata/README-coercion-corpus.md` for the ONE coercion rule the corpus
encodes and why each divergence was a real, silent, rc=0 defect.
"""
import importlib.util
import json
import os

import numpy as np
import pandas as pd
import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CF_SCRIPT = os.path.abspath(os.path.join(_HERE, os.pardir, "compute", "cell-filter.py"))
# tests → cell-filter → processors → src-app
_SRC_APP = os.path.abspath(os.path.join(_HERE, *([os.pardir] * 3)))
_CORPUS = os.path.join(_SRC_APP, "testdata", "criteria-coercion-corpus.json")


def _load_cf():
    spec = importlib.util.spec_from_file_location("cell_filter_corpus_pkg", _CF_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cf = _load_cf()

_SPECIALS = {"inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}


def _decode(v):
    """The corpus' ``{"$special": …}`` escape → the real python value. JSON cannot carry
    a non-finite float and a non-finite obs cell is ordinary in a QC metric column."""
    if isinstance(v, dict) and set(v) == {"$special"}:
        return _SPECIALS[v["$special"]]
    if isinstance(v, list):
        return [_decode(x) for x in v]
    return v


def _corpus():
    # NOT `pytest.skip` if absent: the corpus is what makes the attested replay, this
    # committed mask and the live preview ONE rule, so a missing corpus is a failure to
    # verify, never a pass.
    with open(_CORPUS, encoding="utf-8") as fh:
        return json.load(fh)["cases"]


CASES = _corpus()


def test_the_corpus_keeps_its_breadth():
    """ROUND-6 (B2): an EXACT count, not ``>= 80``. A one-directional floor let a case be
    DELETED to hide a divergence (proven by deleting ``H16`` while reintroducing the
    ``_cat_hit`` container defect it guards: the whole gate stayed at rc 0). The
    authoritative guard is the case-ID list in
    ``predicate_script.rs::CORPUS_CASE_IDS``; this is its cheap local twin, so
    ``just check-py`` alone still reddens on a shrink."""
    assert len(CASES) == 127, f"the coercion corpus changed size ({len(CASES)} cases)"
    assert len({c["id"] for c in CASES}) == len(CASES), "duplicate corpus case ids"


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
@pytest.mark.parametrize("flavour", ["list", "object"])
def test_the_committed_mask_matches_the_shared_coercion_corpus(case, flavour):
    """BOTH obs dtype flavours, because `criteria_keep_mask`'s range branch dispatches on
    ``np.asarray(col).dtype.kind``: a python list of bools becomes numpy ``bool_`` (the
    ``astype(float)`` fast path) while the same column read out of a pandas
    object/nullable dtype becomes ``dtype=object`` (the per-cell ``_value_float`` path).
    ``main`` snapshots ``np.asarray(adata.obs[c])``, so BOTH are reachable from real data
    — and before round 4 they answered the exact INVERSE of each other for a boolean
    column (R3-79/R3-131): the committed mask depended on a storage dtype the recorded
    recipe cannot see."""
    obs = {k: [_decode(x) for x in v] for k, v in case["obs"].items()}
    n = max((len(v) for v in obs.values()), default=0)
    cols = obs if flavour == "list" else {k: np.array(v, dtype=object) for k, v in obs.items()}
    mask = cf.criteria_keep_mask(case["criteria"], cols, n_cells=n)
    assert [bool(x) for x in np.asarray(mask).tolist()] == case["expect"], case["why"]


# ── kernel-only invariants (they need a resolved obs FRAME, not just columns) ──
#
# ITEM-24 replaced the `adata` these two drove with `cf.ObsFrame`: the obs columns come
# from `column:<name>` artifacts and the on-the-fly metrics from the CSC matrix artifact
# instead of `sc.pp.calculate_qc_metrics`. The PROPERTY is unchanged and is what they
# still assert — computing a MISSING metric must not disturb a PRESENT one, and the
# committed mask must not depend on criterion ORDER.

GENES = ["MT-CO1", "ACTB", "RPL3"]
#: 3 cells x 3 genes. Cells 0/1 are ~1-2 % mitochondrial, cell 2 is 50 % — and a
#: RECOMPUTED `n_genes_by_counts` would be [3, 3, 2], nowhere near the 999 the frame
#: already carries, so an overwrite is unmistakable.
COUNTS = np.array([[1.0, 50.0, 50.0],
                   [2.0, 60.0, 40.0],
                   [5.0, 5.0, 1.0]], dtype=np.float32)


def _frame():
    import scipy.sparse as sp

    csc = sp.csc_matrix(COUNTS)
    matrix = cf.CscMatrix(
        COUNTS.shape[0], COUNTS.shape[1], csc.indptr, csc.indices, csc.data,
        gene_names=GENES,
    )
    # `n_genes_by_counts` is PRE-EXISTING (a bound `column:` artifact on a real run).
    return cf.ObsFrame(
        COUNTS.shape[0], [f"cell{i}" for i in range(COUNTS.shape[0])],
        {"n_genes_by_counts": np.array([999.0, 999.0, 0.0])}, matrix,
    )


def test_ensure_metric_never_overwrites_a_preexisting_obs_column():
    """R3-78. `sc.pp.calculate_qc_metrics(inplace=True)` recomputed and overwrote
    `total_counts` / `n_genes_by_counts` even when the input already carried them, so
    computing a MISSING metric silently replaced the values the recipe was authored
    against — values the replay ctx (built from the dataset's own obs) still carries.

    RED ON REVERT: delete the ``if metric in frame.obs.columns: return True`` early
    return in `ensure_metric` and add `n_genes_by_counts` to what a `pct_counts_mt`
    request computes; `n_genes_by_counts` comes back [3, 3, 3]."""
    f = _frame()
    assert cf.ensure_metric(f, "pct_counts_mt", r"^MT-", r"^RP[SL]")
    assert list(f.obs["n_genes_by_counts"]) == [999.0, 999.0, 0.0], (
        "computing a MISSING metric must not recompute a PRESENT one"
    )
    # …and it did add the genuinely missing column, from the MATRIX.
    assert "pct_counts_mt" in f.obs.columns
    assert f.obs["pct_counts_mt"].iloc[2] == pytest.approx(100.0 * 5.0 / 11.0)


def test_an_uncomputable_metric_is_a_typed_skip_not_a_fabricated_zero():
    """Without gene LABELS a pattern metric cannot be computed. It must be reported as
    ABSENT (so `criteria_keep_mask` imposes no constraint) rather than written as a
    column of zeros, which a `pct_counts_mt <= 10` criterion would happily keep."""
    f = _frame()
    f.matrix.gene_names = None
    assert cf.ensure_metric(f, "pct_counts_mt", r"^MT-", r"^RP[SL]") is False
    assert "pct_counts_mt" not in f.obs.columns
    # …while a label-free metric is still computable off the same matrix.
    assert cf.ensure_metric(f, "total_counts", r"^MT-", r"^RP[SL]") is True
    assert list(f.obs["total_counts"]) == [101.0, 102.0, 11.0]


def test_the_committed_mask_does_not_depend_on_criterion_ORDER():
    """R3-78, the observable consequence. The recorded predicate is an order-free AND, so
    an order-dependent committed mask can never be replayed from it.

    RED ON REVERT: collapse `resolve_criteria_obs_cols`' two passes into one
    resolve-and-snapshot loop AND let `ensure_metric` overwrite a present column; the two
    orders then disagree."""
    forward = [
        {"column": "n_genes_by_counts", "min": "100"},
        {"column": "pct_counts_mt", "max": "10"},
    ]
    backward = list(reversed(forward))

    def run(criteria):
        f = _frame()
        cols = cf.resolve_criteria_obs_cols(f, criteria, r"^MT-", r"^RP[SL]")
        return [bool(x) for x in cf.criteria_keep_mask(criteria, cols, n_cells=f.n_obs)]

    assert run(forward) == run(backward) == [True, True, False]


# ITEM-9 deleted the `predicate` walker from `thresholds_from_params` — ITEM-4 stopped
# `ui/cell-filter.yaml` sending a `predicate`, and ITEM-9 deleted the predicate DSL from
# the frontend outright, so nothing could reach the branch. The three cases that lived
# here (R3-86 unsupported-node refusal, R3-85 non-numeric-bound refusal, and the
# supported-shape positive control) went with the branch they covered: a test asserting
# behaviour no caller can reach is not coverage. The failure MODE they guarded — a recipe
# silently producing no constraint while the report claims the filter ran — is now
# structurally impossible for a predicate, because there is no predicate path at all.


def test_legacy_threshold_bounds_use_the_ONE_grammar_like_the_criteria_entries():
    """R3-42. A legacy entry passed `min`/`max` through RAW (an int 200 beside a
    criteria-derived float 200.0) inside one report, and main's `float(t["min"])` then
    died on a spelling the criteria path treats as unbounded."""
    out = cf.thresholds_from_params({"thresholds": [{"metric": "q", "min": 1, "max": "0x10"}]})
    assert out == [{"metric": "q", "min": 1.0, "max": None, "sample": None}]
