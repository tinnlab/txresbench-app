#!/usr/bin/env python3
# ruff: noqa
"""TEST-36 (tier: e2e) [covers: ITEM-0a, ITEM-0c] — analysis 2 keys on the DATATYPE, not the
producer.

An IMPORTED `X_scVI`-shaped latent — built via `write_embedding` the way `anndata-import`
does, NOT by our reducer — drives `embedding.visualize` to a 2-D embedding, proving the
`type_id: embedding` chaining key resolves regardless of which producer wrote the latent. Its
provenance is unknown, so the correction bit reads back as `unattested`, never defaulted to
"not corrected".
"""
import numpy as np


def test_a_foreign_imported_latent_drives_visualize_regardless_of_producer(visualize_run):
    rng = np.random.default_rng(0)
    viz = visualize_run()
    # a foreign latent: written like anndata-import emits `X_scVI`, not by embedding.reduce.
    viz.add_embedding(rng.standard_normal((70, 10)).astype(np.float32),
                      name="X_scVI", method="scvi")
    viz.run_ok({"method": "umap", "seed": 0})

    assert viz.embedding_array().shape == (70, 2)
    assert viz.report()["input_dims"] == 10
    assert viz.embedding_entry()["datatype"] == "embedding"
    # unknown provenance → `unattested`, NOT defaulted to "none".
    assert viz.report()["correction"] == "unattested"
