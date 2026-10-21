#!/usr/bin/env python3
# ruff: noqa
"""Correction-provenance acceptance (DEC-5, the reduce-side of INV-1 / ITEM-25).

Our PCA latent carries `correction: "none"` on its `meta`, never claiming a batch
correction it did not perform; and it is emitted as an `embedding`, NEVER an
expression-matrix datatype (INV-1). An imported latent of unknown provenance is
`unattested` (never defaulted to "not corrected") — read back through visualize.

(The full reduce→harmony→visualize provenance HOP is Stage-D's TEST-30; here we pin the
three correction states this stage produces.)
"""
import numpy as np

from embedding_fixtures import counts_matrix


def test_the_pca_latent_is_an_embedding_marked_correction_none(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(50, 30, seed=0))
    run.run_ok({"n_hvg": 12, "n_pcs": 6})

    emb_entry = run.embedding_entry()
    # emitted as an `embedding`, never an expression matrix (INV-1).
    assert emb_entry["datatype"] == "embedding"
    # DEC-5: our PCA is NOT batch-corrected.
    assert emb_entry["meta"]["correction"] == "none"
    assert emb_entry["meta"]["derived_from"] == "expression"
    assert run.report()["correction"] == "none"


def test_an_imported_latent_of_unknown_provenance_is_unattested(visualize_run):
    # a foreign latent (built like anndata-import would, NOT by our reducer) carries no
    # correction declaration → visualize must report `unattested`, not "none".
    rng = np.random.default_rng(0)
    run = visualize_run()
    run.add_embedding(rng.standard_normal((70, 8)).astype(np.float32),
                      name="X_scVI", method="scvi")
    run.run_ok({"method": "umap", "seed": 0})
    assert run.report()["correction"] == "unattested"
