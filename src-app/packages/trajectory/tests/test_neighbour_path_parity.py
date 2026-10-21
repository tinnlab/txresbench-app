#!/usr/bin/env python3
# ruff: noqa
"""TEST-12 + TEST-13 — the VENDORED neighbour-path switch, pinned twice over.

The platform confines an entry's staged helpers to its OWN package, so a cross-package
import of the sibling's copy is impossible without moving the kernel into the shared
framework library — an app edit that would break the very invariant this package exists to
demonstrate. So the switch is vendored BYTE-FOR-BYTE, exactly as the sibling reducer vendors
the filter package's predicate kernel.

Vendoring is only safe if the copy is CHECKED rather than claimed, so it is pinned twice:

  TEST-12 — the source text is `inspect.getsource`-identical to the original's. A hand-edit
            of either copy is a failing test rather than a silent divergence.
  TEST-13 — BOTH copies agree with the library's OWN transformer decision at every metric
            and size boundary. This is the check that would survive even if both copies
            drifted together, because its oracle is outside our tree entirely.

Mutation: hand-edit the vendored span -> TEST-12 fails immediately and names the function.
Revert either copy to a flat metric-blind threshold -> TEST-13's boundary sweep fails, and
the negative control proves the sweep is not vacuously satisfiable by any monotone rule.
"""
import importlib.util
import inspect
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
ad = pytest.importorskip("anndata")
pytest.importorskip("scanpy")

_PACKAGES = Path(__file__).resolve().parents[2]
_OURS = _PACKAGES / "trajectory" / "compute" / "_shared.py"
_THEIRS = _PACKAGES / "clustering" / "compute" / "_shared.py"


def _load(path, name):
    sys.path.insert(0, str(path.parent))
    sys.path.insert(0, str(_PACKAGES / "_lib"))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def ours():
    return _load(_OURS, "trajectory_shared_parity")


@pytest.fixture(scope="module")
def theirs():
    if not _THEIRS.is_file():
        pytest.skip("the package this kernel was vendored from is not in this tree")
    return _load(_THEIRS, "clustering_shared_parity")


# ── TEST-12 — the SOURCE is byte-identical ────────────────────────────────────────────
@pytest.mark.parametrize("fn", ["neighbour_path", "neighbour_exact_switch_cells"])
def test_vendored_source_is_byte_identical_to_the_original(fn, ours, theirs):
    assert inspect.getsource(getattr(ours, fn)) == inspect.getsource(getattr(theirs, fn)), (
        f"the vendored `{fn}` has drifted from the copy it was taken from — it is vendored "
        "VERBATIM, so regenerate it rather than hand-editing either side")


def test_vendored_threshold_constants_match(ours, theirs):
    assert (ours.NEIGHBOUR_EXACT_MAX_CELLS_EUCLIDEAN
            == theirs.NEIGHBOUR_EXACT_MAX_CELLS_EUCLIDEAN == 8192)
    assert (ours.NEIGHBOUR_EXACT_MAX_CELLS_NONEUCLIDEAN
            == theirs.NEIGHBOUR_EXACT_MAX_CELLS_NONEUCLIDEAN == 4096)


# ── TEST-13 — BOTH copies agree with the library's OWN decision ───────────────────────
def _library_real_path(n_obs, metric):
    """The library's ACTUAL exact/approximate choice at (n_obs, metric): ask it for the
    transformer it would use and classify the instance. Its real switch, not a re-derivation
    of it."""
    from scanpy.neighbors import Neighbors

    a = ad.AnnData(X=np.zeros((n_obs, 1), dtype=np.float32))
    a.obsm["X_e"] = np.zeros((n_obs, 5), dtype=np.float32)
    nb = Neighbors(a)
    kwds = {"n_neighbors": 15, "metric": metric, "metric_params": {}, "random_state": 0}
    _method, transformer, _shortcut = nb._handle_transformer("umap", None, knn=True,
                                                             kwds=kwds)
    return "exact" if type(transformer).__name__ == "KNeighborsTransformer" else "approximate"


#: The boundaries where a metric-blind rule diverges from the real switch.
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
def test_the_vendored_switch_matches_the_librarys_real_decision(n_obs, metric, ours):
    assert ours.neighbour_path(n_obs, metric) == _library_real_path(n_obs, metric), (
        f"the recorded path disagrees with the library at n_obs={n_obs}, metric={metric!r}")


def test_a_flat_metric_blind_rule_would_misreport_a_boundary():
    """The negative control. Without it the sweep above would be satisfied by any monotone
    rule, and the whole point is that the real switch is METRIC-DEPENDENT and strict."""
    def flat_rule(n_cells, metric):
        return "exact" if n_cells <= 8192 else "approximate"

    disagreements = [(n, m) for (n, m) in _POINTS
                     if flat_rule(n, m) != _library_real_path(n, m)]
    assert disagreements, (
        "the flat rule agrees with the library everywhere in this sweep, so the sweep has no "
        "teeth — add a boundary where they differ")
    assert (5000, "manhattan") in disagreements
    assert (8192, "euclidean") in disagreements
