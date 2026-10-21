# ruff: noqa
"""TEST-9 [acceptance] [INV-9 / GS-INV-14] — machine inferences (`data_driven`) land in the
STRUCTURED metadata attrs, NEVER composed into the human `description` field (the legacy
LLM-cell-type-into-description anti-pattern is excluded)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gs_fixtures import run_freeze, collection_entry, structure_of

DRAFT = {
    "name": "C",
    "default_kind": "celltype-markers",
    "sets": [
        {"name": "NK cells", "kind": "signatures", "genes": ["NKG7", "GNLY"], "origin": "de-derived:abc123", "data_driven": True, "description": ""},
    ],
}


def test_data_driven_never_leaks_into_description(tmp_path):
    out, manifest = run_freeze(tmp_path, DRAFT)
    struct = structure_of(out, collection_entry(manifest))
    s = struct["sets"][0]
    # The inference lives in the structured flag ...
    assert s["data_driven"] is True
    # ... and is NOT composed into the human description (which stays exactly what was authored).
    desc = s["description"].lower()
    assert "data_driven" not in desc
    assert "data-driven" not in desc
    assert "true" not in desc
    assert s["description"] == "", "the description is carried verbatim, never machine-augmented"
