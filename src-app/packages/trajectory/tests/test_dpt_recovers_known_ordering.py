#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 [acceptance] [invariant: INV-2] — the pseudotime recovers a KNOWN ordering.

The correlation is **SIGNED**, and that is the whole point rather than a detail. A perfectly
INVERTED trajectory scores rho = -1, which is maximally wrong — and it would sail straight
through an `abs(rho)` test. Shipping a confidently backwards ordering is the single easiest
way to get this analysis wrong, so this file asserts the sign and then PROVES the sign check
has teeth by scoring the negated answer.

Ground truth comes from a committed GENERATOR (code, not a data blob), so a reader can check
why it is the truth: `true_time` is assigned when each cell is created and the counts are
generated FROM it, so it is not inferred from the thing under test.

Mutation: negate the pseudotime -> the signed assertion fails while `abs(rho)` would pass
(asserted directly below). Use argmax where argmin is specified when resolving the root ->
the root lands at the far end and rho collapses. Shuffle the cell order between the diffusion
map and the write -> the correlation is destroyed.
"""
import numpy as np
import pytest

from trajectory_generators import (barcodes, branching_walk, cells_digest, embed,
                                    embed_continuous)

pytest.importorskip("scanpy")
pytest.importorskip("igraph")
spearmanr = pytest.importorskip("scipy.stats").spearmanr

#: The bar the design sets. Measured headroom on this fixture is ~0.996, so a failure means
#: the pseudotime is wrong rather than the fixture being marginal.
RHO_FLOOR = 0.95


@pytest.fixture(scope="module")
def fixture():
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), true_time, true_branch


def _run_rooted_at_origin(dpt_run, emb, true_time, branch):
    """A run whose root is placed at the TRUE origin — the condition INV-2 states."""
    n = emb.shape[0]
    keys = barcodes(n)
    origin = keys[int(np.argmin(true_time))]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_keys(keys)
    run.run_ok({"root_mode": "barcode", "root_barcode": origin,
                "n_comps": 15, "n_dcs": 10})
    return run, origin


def test_signed_spearman_recovers_the_true_ordering(dpt_run, fixture):
    emb, true_time, branch = fixture
    run, _origin = _run_rooted_at_origin(dpt_run, emb, true_time, branch)
    pt = run.pseudotime()

    rho = spearmanr(pt, true_time).statistic
    assert rho >= RHO_FLOOR, (
        f"signed Spearman rho = {rho:+.4f}, below the {RHO_FLOOR} floor. A NEGATIVE value "
        "here means the ordering is inverted, which is maximally wrong rather than merely "
        "weak.")


def test_an_inverted_answer_is_maximally_wrong_and_abs_would_have_hidden_it(dpt_run,
                                                                           fixture):
    """The negative control that gives the SIGN its teeth.

    This is not hypothetical: it measures the exact quantity an `abs(rho)` test would have
    scored for a perfectly backwards trajectory, and shows it passing.
    """
    emb, true_time, branch = fixture
    run, _origin = _run_rooted_at_origin(dpt_run, emb, true_time, branch)
    pt = run.pseudotime()

    inverted = spearmanr(-pt, true_time).statistic
    assert inverted <= -RHO_FLOOR, "the fixture is too weak to demonstrate the inversion"
    assert abs(inverted) >= RHO_FLOOR, (
        "an abs() test would REJECT the inverted answer on this fixture, so this control "
        "proves nothing — the point is that abs() ACCEPTS it")


def test_the_root_holds_the_minimum_pseudotime(dpt_run, fixture):
    """The sign convention asserted, not assumed: pseudotime is a distance FROM the root, so
    the root is the minimum. If it were not, the ordering would run backwards from it."""
    emb, true_time, branch = fixture
    run, _origin = _run_rooted_at_origin(dpt_run, emb, true_time, branch)
    pt = run.pseudotime()
    root_index = run.report()["root"]["index"]

    assert np.isfinite(pt[root_index])
    assert pt[root_index] == pytest.approx(np.nanmin(pt), abs=1e-6)


def test_the_default_root_cluster_mode_also_recovers_the_ordering(dpt_run, fixture):
    """The mode a real user takes: name the starting POPULATION, not a cell."""
    emb, true_time, branch = fixture
    n = emb.shape[0]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_partition(branch, slot="root_column", name="branch")
    run.add_keys(barcodes(n))
    run.run_ok({"root_mode": "root_cluster", "root_level": "trunk",
                "n_comps": 15, "n_dcs": 10})

    rho = spearmanr(run.pseudotime(), true_time).statistic
    assert rho >= RHO_FLOOR, f"root-cluster mode scored {rho:+.4f}"
    # the run records that this was a user's biological assertion, not a discovery.
    assert run.report()["root"]["is_a_biological_assertion"] is True


# ── the INDEPENDENT fixture — skips LOUDLY, never silently ────────────────────────────
def test_recovers_a_known_ordering_on_an_independently_simulated_dataset(dpt_run):
    """A dataset this repo did not author: 640 cells x 11 genes, simulated from a
    literature-curated Boolean network, carrying known fates and a known branching topology.

    It is a DOWNLOAD, so it skips when unavailable — loudly, with the reason, because a
    skipped test that reads like a passing one is worse than no test.
    """
    sc = pytest.importorskip("scanpy")
    try:
        adata = sc.datasets.krumsiek11()
    except Exception as exc:  # network, cache, upstream layout — all the same to us
        pytest.skip(
            f"krumsiek11 is unavailable ({type(exc).__name__}: {exc}) — the INDEPENDENT "
            "ground-truth check did NOT run. The committed generator still gated this "
            "suite; this leg is the one that would catch a fixture authored to the answer.")

    adata.obs_names_make_unique()
    counts = np.asarray(
        adata.X.todense() if hasattr(adata.X, "todense") else adata.X, dtype=np.float32)
    cell_type = [str(v) for v in adata.obs["cell_type"]]
    assert "progenitor" in set(cell_type), (
        "krumsiek11 no longer carries the progenitor level this test roots at")

    # This matrix is a simulated continuous STATE, not counts, so it takes the direct-PCA
    # path: the library-size + log1p pipeline produces NaN on it (several hundred negative
    # entries), which PCA then refuses.
    emb = embed_continuous(counts, n_comps=10)
    n = emb.shape[0]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_partition(cell_type, slot="root_column", name="cell_type")
    run.add_keys(barcodes(n))
    run.run_ok({"root_mode": "root_cluster", "root_level": "progenitor",
                "n_comps": 15, "n_dcs": 10, "on_disconnected": "mark_missing"})

    pt = run.pseudotime()
    finite = np.isfinite(pt)
    assert finite.sum() > 0
    # The known topology: the progenitor population is the ROOT of the differentiation, so
    # its cells must sit EARLIER than the four terminal fates. That is the ordering claim
    # this dataset can support — it has known fates, not a per-cell true time.
    is_prog = np.array([t == "progenitor" for t in cell_type])
    prog_median = float(np.nanmedian(pt[is_prog & finite]))
    fate_median = float(np.nanmedian(pt[(~is_prog) & finite]))
    assert prog_median < fate_median, (
        f"the progenitor population ({prog_median:.4f}) is not earlier than the terminal "
        f"fates ({fate_median:.4f}) — the recovered ordering disagrees with the known "
        "topology of this simulated network")
