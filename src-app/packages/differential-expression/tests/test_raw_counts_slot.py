#!/usr/bin/env python3
# ruff: noqa
"""TEST-28 [acceptance] [invariant: INV-13] [covers: ITEM-6] — de.compare's expression slot is
typed RAW COUNTS (`subtypes_of` + `excludes`), and the compute REFUSES BY NAME when handed a
normalized/log layer (no silent pseudocount, D4)."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

from de_fixtures import two_group_expression, group_labels, sample_labels, EXTERNAL

_MANIFEST = Path(__file__).resolve().parents[1] / "manifest.yaml"


def test_compare_slot_declares_subtypes_of_and_excludes():
    doc = yaml.safe_load(_MANIFEST.read_text())
    compare = next(a for a in doc["contributes"]["analyses"] if a["id"] == "de.compare")
    slot = next(s for s in compare["appliesTo"] if s.get("slot") == "expression")
    assert slot["subtypes_of"] == "single-cell/expression"
    assert set(slot["excludes"]) == {"single-cell/normalized", "single-cell/protein",
                                     "single-cell/atac"}


def test_compute_refuses_a_normalized_layer_by_name(compare_run):
    run = compare_run()
    run.add_expression(two_group_expression(), datatype="single-cell/normalized")
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=2), slot="sample", name="donor")
    proc = run.run({"group1": "g0", "group2": "g1"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "de.compare:" in msg
    assert "RAW COUNTS" in msg or "raw" in msg.lower()
    assert "normalized" in msg.lower()
