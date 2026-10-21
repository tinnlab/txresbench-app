#!/usr/bin/env python3
# ruff: noqa
"""Visualize acceptance tests (INV-6 / INV-14).

TEST-13 — the visualize report RECORDS which of the exact/approximate neighbour paths ran
(the 8192-cell switch), present + correct for a below- and above-threshold fixture.
TEST-24 — UMAP ran init="spectral", random_state=<seed>, min_dist/n_neighbors exposed, and
the chosen min_dist is recorded (not silently inherited).
"""
import numpy as np


def _latent(n_obs, n_dims=6, seed=0):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((n_obs, n_dims)).astype(np.float32)


# ── TEST-13 [acceptance] [invariant: INV-6] [covers: ITEM-21] ──────────────────────
def test_the_neighbour_path_exact_vs_approximate_is_recorded(visualize_run):
    # below the switch → EXACT
    below = visualize_run()
    below.add_embedding(_latent(80), name="X_pca")
    below.run_ok({"method": "umap", "seed": 0})
    rep_below = below.report()
    assert rep_below["neighbor_path"] == "exact"
    assert rep_below["neighbor_exact_max"] == 8192

    # at/above the switch → APPROXIMATE (forced via the seam so no 8192-cell fixture).
    above = visualize_run()
    above.add_embedding(_latent(80, seed=1), name="X_pca")
    above.run_ok({"method": "umap", "seed": 0},
                 env_extra={"EMBEDDING_NEIGHBORS_EXACT_MAX": "10"})
    assert above.report()["neighbor_path"] == "approximate"


# ── TEST-24 [acceptance] [invariant: INV-14] [covers: ITEM-22] ─────────────────────
def test_umap_init_spectral_seed_and_recorded_min_dist(visualize_run):
    run = visualize_run()
    run.add_embedding(_latent(90, seed=2), name="X_pca")
    run.run_ok({"method": "umap", "min_dist": 0.3, "n_neighbors": 12, "seed": 5})
    params = run.report()["parameters"]
    assert params["init"] == "spectral"
    assert params["random_state"] == 5
    assert params["min_dist"] == 0.3          # the CHOICE, recorded (not inherited)
    assert params["n_neighbors"] == 12
    # produced a real 2-D embedding.
    assert run.embedding_array().shape == (90, 2)


def test_tsne_is_selectable_and_produces_a_2d_layout(visualize_run):
    run = visualize_run()
    run.add_embedding(_latent(90, seed=3), name="X_pca")
    run.run_ok({"method": "tsne", "seed": 0})
    assert run.report()["method"] == "tsne"
    assert run.embedding_array().shape == (90, 2)
    assert run.report()["parameters"]["protocol"] == "kobak_berens"


# ── the honest report (DEC-8 voice + INV-13 metric caveat) ──────────────────────────
def test_report_carries_the_dec8_honesty_sentence_and_metric_caveat(visualize_run):
    run = visualize_run()
    run.add_embedding(_latent(80, seed=9), name="X_pca")
    run.run_ok({"method": "umap", "metric": "cosine", "seed": 0})
    rep = run.report()

    # DEC-8 — the one calm, always-present standing line, verbatim.
    note = rep["honesty_note"]
    assert "A 2-D embedding is a lossy summary" in note
    assert "not meaningful" in note
    assert "explore structure, not to measure it" in note
    assert rep["note"] == note      # the back-compat alias stays in lockstep

    # INV-13 — the metric is recorded as the CHOICE made, not a recommendation.
    caveat = rep["metric_caveat"]
    assert "cosine" in caveat
    assert "recorded choices" in caveat and "not recommendations" in caveat
    # nowhere does the report claim a choice is correct/recommended.
    blob = repr(rep).lower()
    assert "recommended" not in blob
    assert "correct for your data" in caveat  # the caveat NEGATES a correctness claim
