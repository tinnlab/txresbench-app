#!/usr/bin/env python3
# ruff: noqa
"""TEST-12 [acceptance] [invariant: INV-12] [covers: ITEM-10] — singleton reassignment +
sub-floor flag, total cell count PRESERVED.

Given a partition with a singleton + a sub-floor group, the output preserves the total cell
count (no fabrication, no silent deletion), singletons are reassigned to the nearest cluster
(centroid distance in embedding space), and the reassignment/flag rule is recorded.

The reassignment kernel is exercised directly (a real kNN graph rarely yields a size-1
cluster, so the invariant is pinned on the pure function AND on the e2e count-preservation).
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

from clustering_fixtures import cells_digest, three_blob_embedding

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"


def _load_cluster_module():
    """Load `compute/cluster.py` (which `import _shared` at module top) with `compute/` and
    `_lib` on the path, so its pure kernels are testable in-process."""
    sys.path.insert(0, str(_COMPUTE))
    sys.path.insert(0, str(_COMPUTE.parent.parent / "_lib"))
    spec = importlib.util.spec_from_file_location("clustering_cluster", _COMPUTE / "cluster.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_singleton_is_reassigned_to_nearest_cluster_and_count_preserved():
    mod = _load_cluster_module()
    # two dense clusters (label 0 near origin, label 1 far), plus ONE singleton (label 2)
    # sitting closer to cluster 1's centroid.
    coords = np.array(
        [[0.0, 0.0], [0.1, 0.1], [0.0, 0.2],          # cluster 0
         [10.0, 10.0], [10.1, 9.9], [9.9, 10.2],      # cluster 1
         [9.5, 9.5]], dtype=np.float32)               # singleton (label 2), near cluster 1
    labels = np.array(["0", "0", "0", "1", "1", "1", "2"])
    new, record = mod._reassign_singletons_and_flag(labels, coords, floor=10)

    # count preserved — no fabrication, no deletion.
    assert len(new) == len(labels)
    # the singleton was reassigned to the NEAREST cluster centroid (cluster 1).
    assert new[6] == "1"
    assert "2" not in set(new)  # the singleton label is gone (reassigned, not deleted)
    assert record["n_singletons_reassigned"] == 1
    assert record["singletons_reassigned"][0] == {"from": "2", "to": "1", "cell_index": 6}
    assert record["floor"] == 10


def test_subfloor_clusters_are_flagged_not_deleted():
    mod = _load_cluster_module()
    # a big cluster + a below-floor group of 3 (no singleton).
    coords = np.zeros((13, 2), dtype=np.float32)
    labels = np.array(["0"] * 10 + ["1"] * 3)
    new, record = mod._reassign_singletons_and_flag(labels, coords, floor=10)
    assert len(new) == 13                              # nothing deleted
    flagged = {f["cluster"]: f["n"] for f in record["subfloor_clusters_flagged"]}
    assert flagged.get("1") == 3                       # the sub-floor group is FLAGGED
    assert record["n_singletons_reassigned"] == 0      # a size-3 group is not a singleton


def test_e2e_preserves_the_total_cell_count(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    run.run_ok({"resolution": 1.0})
    # every input cell has exactly one label — no cell fabricated, none dropped.
    assert len(run.labels()) == 120
    assert run.report()["subfloor"]["floor"] == 10
