# ruff: noqa
"""TEST-11 [ITEM-3, INV-1] — the freeze producer writes a deterministic geneset/collection
(a (gene x geneset) membership CSC + per-set metadata + manifest.json); identical draft data
yields byte-identical bytes (content-hash stable), and canonicalization is applied."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gs_fixtures import run_freeze, collection_entry, structure_of, dir_digest

DRAFT = {
    "name": "PBMC markers",
    "default_kind": "celltype-markers",
    "sets": [
        {"name": "T cells", "genes": ["CD3D", "CD3E", "IL7R", "CD3D"]},  # note the duplicate
        {"name": "B cells", "genes": ["MS4A1", "CD79A"]},
    ],
}


def test_writes_membership_and_manifest(tmp_path):
    out, manifest = run_freeze(tmp_path, DRAFT)
    entry = collection_entry(manifest)
    assert entry["datatype"] == "geneset/collection"
    assert entry["layout"] == "chunked-sparse"
    struct = structure_of(out, entry)
    assert struct["kind"] == "sparse_csc"
    assert struct["axes"] == ["gene", "geneset"]
    # 2 sets; the gene axis is the first-seen UNION, deduped: CD3D,CD3E,IL7R,MS4A1,CD79A = 5.
    assert struct["shape"][1] == 2, "n_geneset"
    assert struct["shape"][0] == 5, "n_gene (deduped union)"
    assert entry["meta"]["n_sets"] == 2
    assert entry["meta"]["n_genes"] == 5


def test_canonicalizes_duplicate_genes(tmp_path):
    out, manifest = run_freeze(tmp_path, DRAFT)
    struct = structure_of(out, collection_entry(manifest))
    tcells = next(s for s in struct["sets"] if s["name"] == "T cells")
    # The duplicate CD3D is de-duplicated (3 genes, not 4).
    assert tcells["genes"] == ["CD3D", "CD3E", "IL7R"]
    assert tcells["n_genes"] == 3


def test_identical_data_is_byte_identical(tmp_path):
    # INV-1: identical draft data -> byte-identical outputs -> a stable content-hash.
    out1, _ = run_freeze(tmp_path / "a", DRAFT)
    out2, _ = run_freeze(tmp_path / "b", DRAFT)
    assert dir_digest(out1) == dir_digest(out2), "the freeze is deterministic (INV-1)"


def test_different_data_forks_different_bytes(tmp_path):
    out1, _ = run_freeze(tmp_path / "a", DRAFT)
    edited = {**DRAFT, "sets": [{"name": "T cells", "genes": ["CD3D", "CD8A"]}, DRAFT["sets"][1]]}
    out2, _ = run_freeze(tmp_path / "b", edited)
    assert dir_digest(out1) != dir_digest(out2), "an edit forks different bytes (INV-1/INV-2)"
