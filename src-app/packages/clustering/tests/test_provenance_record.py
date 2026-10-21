#!/usr/bin/env python3
# ruff: noqa
"""The §Provenance record-set acceptance anchors.

TEST-5  [acceptance] [invariant: INV-5] [covers: ITEM-6] — the full §Provenance record set
        is present AND a second run from the recorded fields reproduces identical labels.
TEST-6  [acceptance] [invariant: INV-6] [covers: ITEM-2] — the recorded neighbour path is
        `exact` below and `approximate` at/above the 8192-cell switch; always present.
TEST-7  [acceptance] [invariant: INV-7] [covers: ITEM-6] — metric + n_neighbors are recorded
        and the record labels the metric as "recorded, not recommended".
TEST-13 [acceptance] [invariant: INV-13] [covers: ITEM-11] — the report records the
        partitioned embedding's method + content-hash and stamps the identity as
        non-quantitative; a corrected-vs-uncorrected embedding is legible from the report.
TEST-14 [acceptance] [invariant: INV-14] [covers: ITEM-12] — n_neighbors is recorded at its
        fixed default and resolution is the tuned dial; not jointly swept.
TEST-21 [acceptance] [invariant: INV-21] [covers: ITEM-12] — the report records the
        operating resolution as a reported parameter with a stated justification, never a
        discovered "true" k.
"""
from clustering_fixtures import cells_digest, three_blob_embedding

_REQUIRED_TAG_FIELDS = (
    "method", "flavor", "objective", "n_iterations", "directed", "resolution",
    "resolution_objective", "seed", "n_neighbors", "metric", "neighbour_path", "n_pcs",
    "n_clusters", "embedding", "determinism_env",
)


def test_full_provenance_record_set_is_present_and_reproduces_labels(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(40, 10, seed=0), method="pca",
                      aligned_to=cells_digest(120))
    run.run_ok({"resolution": 1.0, "n_neighbors": 15, "metric": "euclidean", "seed": 5})

    tag = run.label_group_cyto()["clustering"]
    for f in _REQUIRED_TAG_FIELDS:
        assert f in tag, f
    # library versions (leidenalg / python-igraph / scanpy) are recorded in the report.
    versions = run.report()["library_versions"]
    for lib in ("scanpy", "igraph", "numpy", "scipy"):
        assert lib in versions
    # embedding identity (method + content-hash + aligned_to) is recorded.
    emb = tag["embedding"]
    assert emb["method"] == "pca" and emb["content_hash"] and emb["aligned_to"]

    # INV-5 — a second run FROM THE RECORDED FIELDS reproduces identical labels.
    run2 = cluster_run()
    run2.add_embedding(three_blob_embedding(40, 10, seed=0), method="pca",
                       aligned_to=cells_digest(120))
    run2.run_ok({"resolution": tag["resolution"], "n_neighbors": tag["n_neighbors"],
                 "metric": tag["metric"], "seed": tag["seed"]})
    assert run.labels() == run2.labels()


def test_neighbour_path_is_exact_below_the_switch_and_recorded(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})
    report = run.report()
    # 90 cells < 8192 → exact; the field is present with the recorded switch point.
    assert report["parameters"]["neighbour_path"] == "exact"
    assert report["parameters"]["neighbour_path_switch_cells"] == 8192
    assert run.label_group_cyto()["clustering"]["neighbour_path"] == "exact"


def test_neighbour_path_is_approximate_at_or_above_the_switch_and_recorded(cluster_run):
    """INV-6 (the APPROXIMATE side — the second of TEST-6's two fixture sizes). Stage-A
    exercised only the EXACT branch (< 8192 cells) and pinned the 8192 constant; this drives
    the APPROXIMATE branch with a REAL fixture AT/ABOVE the switch, so the recorded
    `neighbour_path == "approximate"` is exercised end-to-end (no seam — the 8192 constant
    stays genuinely pinned). 8193 cells = the minimal fixture strictly over the switch.

    Mutation: flip the `<=`/`>` in the neighbour-path ternary, or hardcode `"exact"`, and the
    recorded path no longer reads `"approximate"` at 8193 cells → this test FAILS.
    """
    n_per = 2731  # 3 × 2731 = 8193 > 8192
    run = cluster_run()
    run.add_embedding(three_blob_embedding(n_per, 10, seed=0),
                      aligned_to=cells_digest(3 * n_per))
    run.run_ok({"resolution": 1.0})
    report = run.report()
    assert report["n_cells"] == 8193
    # 8193 ≥ 8192 → approximate; the switch point is the same pinned constant.
    assert report["parameters"]["neighbour_path"] == "approximate"
    assert report["parameters"]["neighbour_path_switch_cells"] == 8192
    assert run.label_group_cyto()["clustering"]["neighbour_path"] == "approximate"


def test_metric_and_n_neighbors_recorded_as_choice_not_recommendation(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0, "n_neighbors": 15, "metric": "euclidean"})
    params = run.report()["parameters"]
    assert params["metric"] == "euclidean"
    assert params["n_neighbors"] == 15
    assert "recorded, not recommended" in params["metric_is"]  # INV-7


def test_report_records_which_embedding_and_stamps_non_quantitative(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), method="harmony",
                      correction="harmony", aligned_to=cells_digest(90),
                      content_hash="sha256:" + "c" * 64)
    run.run_ok({"resolution": 1.0})
    report = run.report()
    emb = report["embedding_partitioned"]
    # INV-13 — WHICH embedding (method + content-hash) is legible, and a corrected embedding
    # is recorded as such (a cluster that is really a batch is legible).
    assert emb["method"] == "harmony"
    assert emb["correction"] == "harmony"
    assert emb["content_hash"] == "sha256:" + "c" * 64
    assert "not a quantitative claim" in report["cluster_identity_is"]


def test_n_neighbors_fixed_resolution_tuned_not_jointly_swept(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0, "n_neighbors": 15})
    params = run.report()["parameters"]
    # INV-14 — n_neighbors is FIXED (recorded), resolution is the tuned dial.
    assert "fixed" in params["n_neighbors_is"]
    assert "resolution" in params["n_neighbors_is"]


def test_operating_resolution_is_a_reported_parameter_never_a_discovered_k(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})
    params = run.report()["parameters"]
    # INV-21 — a reported operating parameter, not a discovered "true" number of clusters.
    assert params["resolution"] == 1.0
    assert "reported operating parameter" in params["resolution_is"]
    assert "not a discovered" in params["resolution_is"]
