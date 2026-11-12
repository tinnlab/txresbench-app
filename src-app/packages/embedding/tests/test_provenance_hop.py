#!/usr/bin/env python3
# ruff: noqa
"""TEST-30 [acceptance] [invariant: INV-1] [covers: ITEM-20a, ITEM-25] — the correction bit
SURVIVES the reduce→visualize hop (F2).

reduce stamps `correction` (+ `method`) into the embedding ARTIFACT's `attributes.txr`, not
only the manifest-entry meta, so a downstream reader (visualize, and the clustering package)
reads back the real provenance instead of coercing an absent bit to `unattested`. Mutation
this kills: write `correction` only into the manifest meta (drop the `stamp_txr_attributes`
call) → visualize reads `structure.get("correction") == None` → reports `unattested` → the
`== "none"` / `== "harmony"` assertions fail.
"""
import json

import numpy as np

from embedding_fixtures import counts_matrix, import_own, write_embedding_store


def _import_shared():
    return import_own("_shared")


def _store_txr(run, entry) -> dict:
    doc = json.loads((run.outputs_dir / entry["path"] / "zarr.json").read_text())
    return doc["attributes"]["txr"]


def test_pca_correction_none_is_on_the_artifact_and_survives_into_visualize(reduce_run, visualize_run):
    red = reduce_run()
    red.add_matrix(counts_matrix(120, 60, seed=0))
    red.run_ok({"n_hvg": 25, "n_pcs": 15, "seed": 0})
    emb = red.embedding_entry()

    # emitted as an `embedding`, never an expression-matrix datatype (INV-1).
    assert emb["datatype"] == "embedding"
    # F2: the correction bit is stamped onto the ARTIFACT's attributes.txr, not just meta.
    txr = _store_txr(red, emb)
    assert txr.get("correction") == "none"
    assert txr.get("method") == "pca"

    # the bit SURVIVES the hop: visualize reads it back as "none", NOT "unattested".
    viz = visualize_run()
    viz.add_existing_store(red.outputs_dir / emb["path"], slot="embedding")
    viz.run_ok({"method": "umap", "seed": 0})
    assert viz.report()["correction"] == "none"
    # and visualize re-stamps it onward (the next hop / clustering seam reads it too).
    assert _store_txr(viz, viz.embedding_entry()).get("correction") == "none"


def test_a_harmony_correction_bit_reads_back_as_harmony_never_unattested(visualize_run):
    # A real Harmony reduce needs harmonypy (seam-gated, TEST-33). The stamp+read path is
    # proven here with the SHIPPED helper: build a corrected embedding exactly as reduce's
    # harmony path stamps it (correction="harmony"), then feed visualize.
    shared = _import_shared()
    rng = np.random.default_rng(0)
    viz = visualize_run()
    store = viz.add_embedding(rng.standard_normal((80, 8)).astype(np.float32),
                              name="X_harmony", method="harmony")
    # the structure the writer would hand the stamp (here read back off the just-written store).
    structure = json.loads((store / "zarr.json").read_text())["attributes"]["txr"]
    shared.stamp_txr_attributes(store, structure, correction="harmony", method="harmony")

    viz.run_ok({"method": "umap", "seed": 0})
    assert viz.report()["correction"] == "harmony"
    assert _store_txr(viz, viz.embedding_entry()).get("correction") == "harmony"
