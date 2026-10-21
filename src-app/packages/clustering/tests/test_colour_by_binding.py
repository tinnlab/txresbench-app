#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 [acceptance] [invariant: INV-16] [covers: ITEM-14] — the produced cluster artifact
matches EXACTLY what the shipped colour-by slice binds, so it is colourable for FREE with
zero src-app diff (owner DEC-9(c)).

Asserted at the artifact/data level (no frontend/e2e): the produced cluster artifact's
`datatype` is `metadata-column` with `kind: categorical`, which is EXACTLY the pair the
shipped `single-cell-viz/ui/colour-by.yaml` `row_space_columns` slice binds
(`datatype: metadata-column` + a `kind: categorical` (Groups) entry), read from the real
view file — and `rowSpaceColumns.ts` filters datatype by EXACT equality, so the column is
listed + colourable with no clustering-specific view code.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

from clustering_fixtures import cells_digest, three_blob_embedding

_COLOUR_BY = (Path(__file__).resolve().parents[2] / "single-cell-viz" / "ui"
              / "colour-by.yaml")


def _colour_by_binding():
    """The (datatype, {kinds}) the shipped colour-by `row_space_columns` slice binds."""
    doc = yaml.safe_load(_COLOUR_BY.read_text())

    found = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("source") == "row_space_columns":
                args = node.get("args") or {}
                found["datatype"] = args.get("datatype")
                found["kinds"] = {k.get("kind") for k in (args.get("kinds") or [])}
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return found


def test_shipped_colour_by_binds_categorical_metadata_column():
    binding = _colour_by_binding()
    # the premise this whole feature rests on (owner DEC-9(c)).
    assert binding.get("datatype") == "metadata-column"
    assert "categorical" in binding.get("kinds", set())


def test_produced_cluster_artifact_matches_the_shipped_binding_exactly(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})

    entry = run.label_entry()
    binding = _colour_by_binding()
    # EXACT-match: the resolver filters `row.datatype !== args.datatype`, so the produced
    # datatype string must equal the bound one verbatim.
    assert entry["datatype"] == binding["datatype"] == "metadata-column"
    # the produced summary kind is `categorical`, which the (Groups) slice reads.
    assert entry["meta"]["kind"] == "categorical"
    assert entry["meta"]["kind"] in binding["kinds"]
