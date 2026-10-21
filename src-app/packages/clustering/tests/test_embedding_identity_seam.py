#!/usr/bin/env python3
# ruff: noqa
"""TEST-P2 [regression] [invariant: INV-13] — the cross-feature embedding-identity seam,
proven against EA-reduce's REAL producer stamp (not a fixture authored to the reader).

Clustering's `embedding_identity` reads the partitioned embedding's `method`/`correction`
from the input store's group `attributes.cyto`. EA-reduce (`feat/embedding-analysis-stage0`)
records exactly there since its own phase-7 F2 fix: `embedding/compute/_shared.py::
stamp_cyto_attributes` sets `method`/`correction` as TOP-LEVEL `attributes.cyto` keys. The
fixture's `provenance_channel="attributes_cyto"` mirrors that mechanism byte-for-byte.

The seam is proven in BOTH directions, so the read is shown to genuinely depend on the
producer's `attributes.cyto` — not to be a fixture shaped to whatever the reader happens to
look at:

  * EA-REAL stamp (`attributes_cyto`) → clustering records the real `method`/`correction`.
  * PRE-EA producer (`meta_only`, `write_embedding` leaves `method` only on the manifest-entry
    `meta`, NOT in `attributes.cyto`) → clustering records the honest `unattested`.

Mutation: stamp the fixture the OLD `meta_only` way in the FIRST test → clustering records
`unattested` → the `== "harmony"` assertion FAILS, proving the recorded identity is a real
read of `attributes.cyto`, not a decoration.
"""
from clustering_fixtures import cells_digest, three_blob_embedding


def test_ea_real_attributes_cyto_stamp_is_read_into_the_identity(cluster_run):
    run = cluster_run()
    # the EA-real channel (default): method/correction land in attributes.cyto as EA-reduce
    # stamps them. A corrected (harmony) embedding must be legible as such (INV-13).
    run.add_embedding(three_blob_embedding(30, 8, seed=0), method="harmony",
                      correction="harmony", aligned_to=cells_digest(90),
                      content_hash="sha256:" + "d" * 64,
                      provenance_channel="attributes_cyto")
    run.run_ok({"resolution": 1.0})

    report = run.report()
    emb = report["embedding_partitioned"]
    assert emb["method"] == "harmony"        # read from attributes.cyto.method (EA-real)
    assert emb["correction"] == "harmony"    # read from attributes.cyto.correction (EA-real)
    assert emb["content_hash"] == "sha256:" + "d" * 64
    # the same identity rides the produced column's provenance tag.
    tag_emb = run.label_group_cyto()["clustering"]["embedding"]
    assert tag_emb["method"] == "harmony" and tag_emb["correction"] == "harmony"


def test_meta_only_producer_records_unattested_proving_the_read_is_of_attributes_cyto(cluster_run):
    """Negative control / the mutation the primary test forbids: a producer that records
    `method` only on the manifest-entry `meta` (the PRE-EA-phase-7 `write_embedding` shape),
    leaving `attributes.cyto` without it. The store-URL reader (clustering) sees no method and
    records the honest `unattested` — proving the identity is a REAL read of `attributes.cyto`,
    and that the fix keeps the fallback defensively honest (never a silent 'pca')."""
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), method="pca", correction="none",
                      aligned_to=cells_digest(90), provenance_channel="meta_only")
    run.run_ok({"resolution": 1.0})

    emb = run.report()["embedding_partitioned"]
    assert emb["method"] == "unattested"        # attributes.cyto carried no method → honest
    assert emb["correction"] == "unattested"
    # aligned_to still comes from write_embedding's own attributes.cyto (the row-space digest),
    # so the identity is not blank — only the producer-provenance bits are unattested.
    assert emb["aligned_to"]
