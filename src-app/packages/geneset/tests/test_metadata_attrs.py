# ruff: noqa
"""TEST-5 [acceptance] [INV-5] — the freeze producer emits kind/origin/data_driven per set, beyond
name/description, matching the declared geneset/collection metadata schema (GS-INV-12). Also
TEST-4-substance [INV-4]: each set's kind (celltype-markers | signatures) is recorded."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gs_fixtures import run_freeze, collection_entry, structure_of

DRAFT = {
    "name": "PBMC markers",
    "default_kind": "celltype-markers",
    "sets": [
        {"name": "T cells", "kind": "celltype-markers", "genes": ["CD3D", "CD3E", "IL7R"], "origin": "manual"},
        {"name": "Hypoxia", "kind": "signatures", "genes": ["VEGFA", "HIF1A"], "origin": "imported:gmt", "data_driven": True},
    ],
}


def test_metadata_carries_kind_origin_data_driven(tmp_path):
    out, manifest = run_freeze(tmp_path, DRAFT)
    entry = collection_entry(manifest)
    assert entry["datatype"] == "geneset/collection"
    assert entry["layout"] == "chunked-sparse"
    struct = structure_of(out, entry)
    sets = struct["sets"]
    assert len(sets) == 2
    for s in sets:
        # The three GS-INV-12 attrs beyond name/description/collection.
        for key in ("name", "description", "kind", "origin", "data_driven"):
            assert key in s, f"set metadata missing {key!r}: {s}"
    by_name = {s["name"]: s for s in sets}
    # INV-4: kind recorded per set.
    assert by_name["T cells"]["kind"] == "celltype-markers"
    assert by_name["Hypoxia"]["kind"] == "signatures"
    # INV-3: origin + data_driven recorded; the data-driven set is flagged.
    assert by_name["T cells"]["origin"] == "manual"
    assert by_name["T cells"]["data_driven"] is False
    assert by_name["Hypoxia"]["origin"] == "imported:gmt"
    assert by_name["Hypoxia"]["data_driven"] is True


def test_kind_defaults_to_collection_default(tmp_path):
    draft = {"name": "C", "default_kind": "signatures", "sets": [{"name": "S1", "genes": ["A", "B"]}]}
    out, manifest = run_freeze(tmp_path, draft)
    struct = structure_of(out, collection_entry(manifest))
    assert struct["sets"][0]["kind"] == "signatures", "a set with no kind inherits default_kind"
    assert struct["sets"][0]["origin"] == "manual", "a set with no origin defaults to manual"
