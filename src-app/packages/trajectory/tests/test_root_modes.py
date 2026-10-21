#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 — all three root modes resolve, and the rule is PERMUTATION-INVARIANT.

The permutation test is the one that matters. The idiom the ecosystem actually uses — take
whichever cell of the chosen group comes first in the file — is not a rule but an accident:
reorder the rows of the same dataset and it returns a different cell, so the same data
produces a different answer. That is invisible in every ordinary test, because ordinary
tests do not reorder their fixture.

Mutation: resolve the root by first-in-file order -> the permutation test fails (and only
that test would). Drop the tie count -> a tie is broken silently, which is how a
"deterministic" rule stops being one.
"""
import numpy as np
import pytest

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def fixture():
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), true_time, true_branch


# ── the three modes ───────────────────────────────────────────────────────────────────
def test_root_cluster_mode_resolves_a_cell_inside_the_named_level(dpt_run, fixture):
    emb, _tt, branch = fixture
    n = emb.shape[0]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_partition(branch, slot="root_column", name="branch")
    run.add_keys(barcodes(n))
    run.run_ok({"root_mode": "root_cluster", "root_level": "A"})

    root = run.report()["root"]
    assert root["mode"] == "root_cluster"
    assert root["level"] == "A"
    assert branch[root["index"]] == "A", "the resolved root is not in the level it names"
    assert root["n_cells_in_level"] == 150
    assert root["tie_count"] >= 1


def test_diffusion_extreme_mode_honours_the_component_and_the_direction(dpt_run, fixture):
    """Both ends of the same component must give different cells — otherwise the direction
    control is decorative, and the sign ambiguity it exists to expose is still hidden."""
    emb, _tt, _branch = fixture
    n = emb.shape[0]

    lo = dpt_run()
    lo.add_embedding(emb, aligned_to=cells_digest(n))
    lo.add_keys(barcodes(n))
    lo.run_ok({"root_mode": "diffusion_extreme", "root_component": 1,
               "root_direction": "min"})

    hi = dpt_run()
    hi.add_embedding(emb, aligned_to=cells_digest(n))
    hi.add_keys(barcodes(n))
    hi.run_ok({"root_mode": "diffusion_extreme", "root_component": 1,
               "root_direction": "max"})

    assert lo.report()["root"]["index"] != hi.report()["root"]["index"]
    assert lo.report()["root"]["direction"] == "min"
    assert hi.report()["root"]["direction"] == "max"
    # this mode asserts no biology — the data alone fixes the cell once the ends are named.
    assert lo.report()["root"]["is_a_biological_assertion"] is False


def test_barcode_mode_resolves_exactly_the_named_cell(dpt_run, fixture):
    emb, _tt, _branch = fixture
    n = emb.shape[0]
    keys = barcodes(n)
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_keys(keys)
    run.run_ok({"root_mode": "barcode", "root_barcode": keys[42]})

    root = run.report()["root"]
    assert root["index"] == 42
    assert root["barcode"] == keys[42]
    assert root["mode"] == "barcode"


# ── the property the common idiom does not have ───────────────────────────────────────
#: Permutation seeds spanning BOTH cases. 2 and 5 flip the sign of the diffusion component
#: on this fixture (measured: correlation -1.000 against the unpermuted run); 7, 11 and 13 do
#: not. A single hand-picked seed is not a test of permutation invariance — the first version
#: of this test used only seed 7 and passed while the root moved from row 3 to row 144 under
#: seeds 2 and 5, which is exactly the confidently-backwards ordering this package exists to
#: prevent.
_PERMUTATION_SEEDS = [2, 5, 7, 11, 13]


# TEST-30 [acceptance] [invariant: INV-2] — permutation invariance across BOTH cases.
@pytest.mark.parametrize("perm_seed", _PERMUTATION_SEEDS)
def test_the_root_cluster_rule_is_permutation_invariant(dpt_run, fixture, perm_seed):
    """The SAME cell must be chosen after the rows are shuffled — for EVERY seed.

    Two distinct ways this can fail, and the suite must cover both:

      * the ecosystem's usual shortcut takes whichever member of the group is first in the
        file, so any reordering moves the root;
      * the diffusion component's SIGN is arbitrary, so some reorderings come back with the
        component negated and the extremum lands at the opposite end of the population — a
        result that is fully self-consistent and completely backwards.

    The second is invisible to a single-seed test, which is how it survived the first round.
    """
    emb, _tt, branch = fixture
    n = emb.shape[0]
    keys = np.array(barcodes(n))

    straight = dpt_run()
    straight.add_embedding(emb, aligned_to=cells_digest(n))
    straight.add_partition(branch, slot="root_column", name="branch")
    straight.add_keys(list(keys))
    straight.run_ok({"root_mode": "root_cluster", "root_level": "A"})
    chosen = straight.report()["root"]["barcode"]

    # the SAME dataset, rows in a different order.
    order = np.random.default_rng(perm_seed).permutation(n)
    shuffled = dpt_run()
    shuffled.add_embedding(emb[order], aligned_to=cells_digest(n))
    shuffled.add_partition(np.asarray(branch)[order], slot="root_column", name="branch")
    shuffled.add_keys(list(keys[order]))
    shuffled.run_ok({"root_mode": "root_cluster", "root_level": "A"})

    assert shuffled.report()["root"]["barcode"] == chosen, (
        f"under permutation seed {perm_seed} the root moved from {chosen} to "
        f"{shuffled.report()['root']['barcode']} — the rule is not permutation-invariant, so "
        "the same data produces two different answers")


def test_the_permutation_sweep_covers_a_SIGN_FLIPPING_seed(fixture):
    """The premise that gives the sweep its teeth.

    If no seed in the sweep actually negated the component, the parametrisation above would
    be five copies of the same easy case. This drives the diffusion basis directly and
    asserts that at least one seed flips it — so the sweep is known to exercise the hard
    case rather than assumed to.
    """
    import anndata as ad
    import scanpy as sc

    emb, _tt, _branch = fixture
    n = emb.shape[0]

    def component(matrix):
        a = ad.AnnData(X=np.zeros((matrix.shape[0], 1), dtype=np.float32))
        a.obsm["X_e"] = matrix
        sc.pp.neighbors(a, n_neighbors=15, use_rep="X_e", random_state=0)
        sc.tl.diffmap(a, n_comps=15, random_state=0)
        return np.asarray(a.obsm["X_diffmap"])[:, 1]

    base = component(emb)
    flipped = []
    for seed in _PERMUTATION_SEEDS:
        order = np.random.default_rng(seed).permutation(n)
        back = np.argsort(order)
        if float(np.corrcoef(base, component(emb[order])[back])[0, 1]) < 0:
            flipped.append(seed)

    assert flipped, (
        "no seed in the sweep negates the diffusion component, so the parametrisation above "
        "never exercises the sign-flip case it exists for — add seeds until one does")


def test_first_in_file_order_would_NOT_be_permutation_invariant(fixture):
    """The negative control, so the test above is known to be discriminating rather than
    trivially satisfied."""
    _emb, _tt, branch = fixture
    branch = np.asarray(branch)
    keys = np.array(barcodes(branch.size))

    straight_first = keys[np.flatnonzero(branch == "A")[0]]
    rng = np.random.default_rng(7)
    order = rng.permutation(branch.size)
    shuffled_first = keys[order][np.flatnonzero(branch[order] == "A")[0]]

    assert straight_first != shuffled_first, (
        "the shuffle did not move the first-in-file cell, so it cannot demonstrate the "
        "difference between the two rules — reseed the permutation")


# ── refusals specific to the modes ────────────────────────────────────────────────────
def test_the_trivial_diffusion_component_is_refused_with_the_reason(dpt_run, fixture):
    emb, _tt, _branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({"root_mode": "diffusion_extreme", "root_component": 0})

    diagnostics = run.diagnostics(proc)
    assert "trivial steady state" in diagnostics
    assert "carries no ordering" in diagnostics


def test_a_component_beyond_what_was_computed_is_refused_with_a_lever(dpt_run, fixture):
    emb, _tt, _branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({"root_mode": "diffusion_extreme", "root_component": 99,
                          "n_comps": 15})

    diagnostics = run.diagnostics(proc)
    assert "only 15 were" in diagnostics or "were\ncomputed" in diagnostics
    assert "Raise `n_comps`" in diagnostics


def test_an_unknown_root_mode_is_refused_rather_than_defaulted(dpt_run, fixture):
    emb, _tt, _branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({"root_mode": "whatever"})

    assert "unknown root mode" in run.diagnostics(proc)


def test_root_cluster_mode_without_a_level_is_refused(dpt_run, fixture):
    emb, _tt, branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, slot="root_column", name="branch")
    proc = run.run_fails({"root_mode": "root_cluster"})

    diagnostics = run.diagnostics(proc)
    assert "needs a categorical column AND one of its levels" in diagnostics
