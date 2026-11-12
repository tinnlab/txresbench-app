#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [acceptance] [invariant: INV-4] — a disconnected graph is NEVER silently finite.

The mechanism, measured rather than assumed: cells outside the root's component get `+inf`,
and the normalisation then divides ONLY by the finite maximum. So a run over two separated
blobs reports a tidy finite range of exactly [0, 1] while describing half the dataset. A
finite-looking range is NOT evidence a run was fine.

The trap that makes this more than a policy question: `txr_columns` counts missing values
with `np.isnan`, and **`np.isnan(inf)` is False**. An infinity handed straight to the writer
is therefore stored as a NOT-missing value — a real number a colour scale renders as the end
of the trajectory. The conversion to NaN has to happen in the compute, before the write.

Both arms the invariant permits are asserted: refuse by name (the default), and the explicit
opt-in that records those cells as missing with the count in the report.

Mutation: drop the inf->NaN conversion -> `n_missing` reads 0 while infinities sit in the
column, and the stored-values assertion below fails. Default to `mark_missing` -> the
refusal test fails. Drop the count from the report -> the reporting assertion fails.
"""
import numpy as np
import pytest

from trajectory_generators import barcodes, cells_digest, two_blob_embedding

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def disconnected():
    return two_blob_embedding(n_per=200, n_dims=8, seed=0)


def _run(dpt_run, emb):
    n = emb.shape[0]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_keys(barcodes(n))
    return run


def test_the_fixture_really_is_disconnected_and_scanpy_really_does_return_infinities(
        disconnected):
    """The premise. Without it, every assertion below could pass over a connected graph.

    This drives the library directly to show the raw behaviour our compute stands in front
    of — including the finite [0, 1] range that makes the failure look like a success.
    """
    import anndata as ad
    import scanpy as sc
    from scipy.sparse.csgraph import connected_components

    emb = disconnected
    a = ad.AnnData(X=np.zeros((emb.shape[0], 1), dtype=np.float32))
    a.obsm["X_e"] = emb
    sc.pp.neighbors(a, n_neighbors=10, use_rep="X_e", random_state=0)
    # Measured on CONNECTIVITIES — the graph the library derives its unreachable mask from,
    # and the one the compute now gates on. The first version of this control measured
    # `distances`, i.e. it controlled a graph the compute had stopped using, which is how a
    # control quietly stops controlling anything.
    n_comp, _ = connected_components(a.obsp["connectivities"], directed=False)
    assert n_comp == 2, f"the fixture is not disconnected (got {n_comp} component(s))"
    # both graphs agree HERE, which is why this fixture cannot by itself discriminate the
    # two; the assertion below is what pins that the compute reads the right one.
    assert connected_components(a.obsp["distances"], directed=False)[0] == 2

    sc.tl.diffmap(a, n_comps=15, random_state=0)
    a.uns["iroot"] = 0
    sc.tl.dpt(a, n_dcs=10, n_branchings=0)
    raw = np.asarray(a.obs["dpt_pseudotime"].values)
    n_inf = int(np.isinf(raw).sum())
    assert n_inf == 200, f"expected 200 unreachable cells, got {n_inf}"
    finite = raw[np.isfinite(raw)]
    # the tidy range that hides the problem.
    assert finite.min() == pytest.approx(0.0) and finite.max() == pytest.approx(1.0)
    # …and the trap, stated as an assertion so it cannot be forgotten.
    assert bool(np.isnan(np.inf)) is False, (
        "np.isnan(inf) is False — which is why an infinity reaching the column writer is "
        "counted as PRESENT, not missing")


def test_the_default_arm_refuses_by_name_and_names_reachable_levers(dpt_run, disconnected):
    run = _run(dpt_run, disconnected)
    proc = run.run_fails({"root_mode": "diffusion_extreme", "n_neighbors": 10})

    diagnostics = run.diagnostics(proc)
    assert "disconnected" in diagnostics
    assert "not reachable from the root" in diagnostics
    # every lever named is one the user can actually pull.
    assert "n_neighbors" in diagnostics
    assert "integrate" in diagnostics
    assert "one connected component" in diagnostics
    assert "mark_missing" in diagnostics
    assert "Traceback" not in diagnostics
    assert not (run.outputs_dir / "manifest.json").exists()


def test_the_opt_in_arm_declares_the_unreachable_cells_missing_and_states_the_count(
        dpt_run, disconnected):
    run = _run(dpt_run, disconnected)
    run.run_ok({"root_mode": "diffusion_extreme", "n_neighbors": 10,
                "on_disconnected": "mark_missing"})

    report = run.report()
    assert report["connectivity"]["graph_connected"] is False
    assert report["connectivity"]["n_components"] == 2
    assert report["connectivity"]["n_unreachable"] == 200
    assert report["connectivity"]["raw_infinities_from_scanpy"] == 200
    assert report["pseudotime"]["n_missing"] == 200

    # the artifact's own declaration agrees with the report.
    meta = run.entry("metadata-column")["meta"]
    assert meta["n_missing"] == 200
    assert meta["kind"] == "continuous"


def test_no_unreachable_cell_holds_a_finite_value_and_no_infinity_is_ever_stored(
        dpt_run, disconnected):
    """The assertion the invariant actually turns on.

    It reads the STORED values back out of the artifact — not the in-memory array — because
    the failure mode is specifically about what survives the write.
    """
    run = _run(dpt_run, disconnected)
    run.run_ok({"root_mode": "diffusion_extreme", "n_neighbors": 10,
                "on_disconnected": "mark_missing"})

    stored = run.pseudotime()
    assert stored.size == 400
    assert not np.isinf(stored).any(), (
        "a raw +inf reached the artifact — a colour scale renders that as the END of the "
        "trajectory, which is the exact misreading this invariant forbids")
    n_missing = int(np.isnan(stored).sum())
    assert n_missing == 200, (
        f"{n_missing} cells are declared missing but 200 are unreachable — an unreachable "
        "cell was given a finite value")
    # the reachable half is a real ordering, so the run is not vacuously "all missing".
    finite = stored[np.isfinite(stored)]
    assert finite.size == 200
    assert finite.min() >= 0.0


def test_the_compute_gates_on_the_graph_the_LIBRARY_masks_from(dpt_run, disconnected):
    """Which graph the component labelling comes from is not cosmetic.

    The library builds its unreachable mask from the CONNECTIVITIES graph. Gating the
    refusal on the distances graph instead would let the two disagree, and a run whose user
    chose `refuse` could then emit a partial ordering while the report claimed every cell
    was reachable — a self-contradictory artifact.

    This fixture's two graphs agree, so it cannot discriminate them by outcome. What it CAN
    do is pin the source, and pin that the compute cross-checks its own prediction against
    the observation instead of trusting either alone.
    """
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "compute" / "dpt.py").read_text()
    assert 'connected_components(\n        adata.obsp["connectivities"]' in source \
        or 'adata.obsp["connectivities"], directed=False' in source, \
        "the component labelling is not read off the connectivities graph"
    assert 'adata.obsp["distances"]' not in source, (
        "the compute still reads the distances graph somewhere — the two can disagree, and "
        "the library masks from connectivities")

    # the belt: the OBSERVED infinity count is checked too, so a disagreement between the
    # prediction and the observation cannot produce a partial ordering under `refuse`.
    assert "if n_inf and on_disconnected == \"refuse\":" in source

    run = _run(dpt_run, disconnected)
    run.run_ok({"root_mode": "diffusion_extreme", "n_neighbors": 10,
                "on_disconnected": "mark_missing"})
    connectivity = run.report()["connectivity"]
    assert connectivity["prediction_matched_observation"] is True
    assert "connectivities graph" in connectivity["components_measured_on"]
