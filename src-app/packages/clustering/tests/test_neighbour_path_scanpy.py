#!/usr/bin/env python3
# ruff: noqa
"""TEST-P1 [regression] [invariant: INV-6] — the recorded `neighbour_path` reflects what
scanpy ACTUALLY runs, proven against scanpy's real switch (not a self-consistent constant).

`neighbour_path` used to be derived from a flat `n_cells <= 8192`. But scanpy 1.11
`Neighbors._handle_transformer` (transformer=None, knn=True) takes the EXACT brute-force
`KNeighborsTransformer` only when `(metric == "euclidean" and n_obs < 8192) or n_obs < 4096`
— so the exact→approximate switch is METRIC-DEPENDENT (8192 euclidean, 4096 otherwise) and
STRICT `<`. A ~5000-cell cosine/manhattan run therefore recorded `"exact"` while pynndescent
actually ran, and a run at exactly 8192 euclidean recorded `"exact"` while scanpy ran
approximate — the field INV-6 exists to record truthfully lied.

The ORACLE here is scanpy's OWN `_handle_transformer`, which returns the transformer instance
scanpy will use — the real decision, not a re-derivation. The fix's `S.neighbour_path` is
asserted to agree with it at every boundary.

Mutation: revert `neighbour_path` to a flat `"exact" if n_cells <= 8192 else "approximate"`
→ it disagrees with scanpy at (>=4096, non-euclidean) and at (8192, euclidean) → the unit
test's boundary sweep FAILS; and the e2e records `"exact"` where scanpy ran approximate → the
e2e FAILS.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

from clustering_fixtures import cells_digest, three_blob_embedding

np = pytest.importorskip("numpy")
ad = pytest.importorskip("anndata")
pytest.importorskip("scanpy")

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"


def _load_shared():
    sys.path.insert(0, str(_COMPUTE))
    sys.path.insert(0, str(_COMPUTE.parent.parent / "_lib"))
    spec = importlib.util.spec_from_file_location("clustering_shared_nbr", _COMPUTE / "_shared.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _scanpy_real_path(n_obs, metric):
    """scanpy's ACTUAL exact/approximate decision at (n_obs, metric): call its own
    `_handle_transformer` and classify the returned transformer instance. An exact brute-force
    `KNeighborsTransformer` ⇒ "exact"; a `PyNNDescentTransformer` ⇒ "approximate". This is
    scanpy's real switch, not a re-derivation of it."""
    from scanpy.neighbors import Neighbors

    a = ad.AnnData(X=np.zeros((n_obs, 1), dtype=np.float32))
    a.obsm["X_e"] = np.zeros((n_obs, 5), dtype=np.float32)
    nb = Neighbors(a)
    kwds = {"n_neighbors": 15, "metric": metric, "metric_params": {}, "random_state": 0}
    _method, transformer, _shortcut = nb._handle_transformer("umap", None, knn=True, kwds=kwds)
    name = type(transformer).__name__
    return "exact" if name == "KNeighborsTransformer" else "approximate"


# The boundary points that separate the metric-dependent switches; includes the exact
# thresholds where a flat-8192 `<=` rule diverges from scanpy.
_POINTS = [
    (90, "euclidean"), (90, "cosine"),
    (4095, "euclidean"), (4095, "manhattan"),
    (4096, "euclidean"), (4096, "manhattan"), (4096, "cosine"),
    (5000, "euclidean"), (5000, "manhattan"),
    (8191, "euclidean"), (8191, "cosine"),
    (8192, "euclidean"),
    (8193, "euclidean"),
]


@pytest.mark.parametrize("n_obs,metric", _POINTS)
def test_neighbour_path_matches_scanpys_real_switch(n_obs, metric):
    S = _load_shared()
    assert S.neighbour_path(n_obs, metric) == _scanpy_real_path(n_obs, metric), (
        f"recorded path disagrees with scanpy at n_obs={n_obs}, metric={metric!r}")


def test_flat_8192_rule_would_misreport_at_least_one_boundary():
    """Negative control — the OLD flat `<= 8192` rule (metric-blind) is shown to DISAGREE with
    scanpy at ≥1 boundary, so the sweep above has teeth (it is not vacuously satisfiable by any
    monotone rule)."""
    def old_rule(n_cells, metric):
        return "exact" if n_cells <= 8192 else "approximate"
    disagreements = [(n, m) for (n, m) in _POINTS
                     if old_rule(n, m) != _scanpy_real_path(n, m)]
    # e.g. (5000,'manhattan'): old→exact, scanpy→approximate; (8192,'euclidean') likewise.
    assert disagreements, "the old rule must diverge from scanpy somewhere for the sweep to bite"
    assert (5000, "manhattan") in disagreements
    assert (8192, "euclidean") in disagreements


def test_e2e_non_euclidean_over_4096_records_the_approximate_path_scanpy_ran(cluster_run):
    """End-to-end: a manhattan run just OVER the non-euclidean switch (4096) records
    `neighbour_path == "approximate"` — what scanpy actually ran — where the old flat-8192 rule
    recorded `"exact"`. 4098 = 3 × 1366 cells, the minimal three-blob fixture over 4096."""
    n_per = 1366  # 3 × 1366 = 4098 > 4096
    assert _scanpy_real_path(3 * n_per, "manhattan") == "approximate"  # scanpy's real answer

    run = cluster_run()
    run.add_embedding(three_blob_embedding(n_per, 10, seed=0),
                      aligned_to=cells_digest(3 * n_per))
    run.run_ok({"resolution": 1.0, "metric": "manhattan"})
    report = run.report()
    assert report["n_cells"] == 4098
    assert report["parameters"]["neighbour_path"] == "approximate"
    # the recorded switch point is the metric-appropriate one (4096, not 8192).
    assert report["parameters"]["neighbour_path_switch_cells"] == 4096
    assert run.label_group_cyto()["clustering"]["neighbour_path"] == "approximate"
