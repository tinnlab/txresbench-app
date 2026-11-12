#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 [covers: ITEM-21] — the produced doublet columns match EXACTLY what the shipped
colour-by slice binds, so both are colourable for FREE with zero src-app diff.

Asserted at the artifact/data level (no frontend/e2e): the CALL column's `datatype` is
`metadata-column` with `kind: categorical`, which is EXACTLY the pair the shipped
`single-cell-viz/ui/colour-by.yaml` `row_space_columns` slice binds (`datatype:
metadata-column` + a `kind: categorical` (Groups) entry), read from the REAL view file — and
`rowSpaceColumns.ts` filters datatype by EXACT equality, so a near-miss spelling drops the
column out of the catalog with every gate green.

THE CONTINUOUS COLUMN HAS A SECOND WAY TO FAIL, and it is the realistic one. The slice binds
`aligned_to: "$scope.axis"` as well as the datatype, so a column that declares NO `aligned_to`
is not "listed without an alignment mark" — it is not listed at all, because the resolver has
no way to decide it rests on the anchored row space. `aligned_to` is OPTIONAL for a producer
that does not hold the axis's keys (INV-2 forbids inventing one), so the compute can only
declare it when a `cells_index` is bound — which is why the run below binds one and this test
pins the digest through. A doublet score that silently never reaches § Color by is the whole
point of the analysis lost, with no error anywhere.

The last assertion is the other side of the same identity story: the score column carries the
axis's digest in `aligned_to`, but must NOT declare `structure.key_sequence_digest` — that is
the producer's claim that the artifact's own values ARE the axis keys, and a float score column
making it would hand the server a bogus row space to resolve the cells axis to.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

from doublet_fixtures import require_skimage, structured_counts

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
                found["aligned_to"] = args.get("aligned_to")
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return found


def test_shipped_colour_by_binds_categorical_metadata_column():
    binding = _colour_by_binding()
    # the premise this whole feature rests on.
    assert binding.get("datatype") == "metadata-column"
    assert "categorical" in binding.get("kinds", set())
    # …and it binds the ROW SPACE too, which is what makes `aligned_to` load-bearing below.
    assert binding.get("aligned_to"), (
        "the colour-by slice no longer binds `aligned_to` — re-read the resolver before "
        "relaxing the score column's alignment assertion")


def test_produced_call_artifact_matches_the_shipped_binding_exactly(detect_run):
    require_skimage()
    run = detect_run()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run.add_matrix(dense)
    run.run_ok({"n_prin_comps": 10})

    entry = run.entry("doublet_call")
    assert entry is not None, (
        "no call column was produced on an ordinary input — this test needs the automatic "
        "threshold to have been found; see test_absence.py for the deliberate-omission case")

    binding = _colour_by_binding()
    # EXACT-match: the resolver filters `row.datatype !== args.datatype`, so the produced
    # datatype string must equal the bound one verbatim.
    assert entry["datatype"] == binding["datatype"] == "metadata-column"
    # the produced summary kind is `categorical`, which the (Groups) slice reads.
    assert entry["meta"]["kind"] == "categorical"
    assert entry["meta"]["kind"] in binding["kinds"]


def test_produced_score_artifact_is_continuous_and_declares_its_row_space(detect_run):
    """The continuous half, plus the alignment declaration it needs to be OFFERED at all."""
    require_skimage()
    run = detect_run()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run.add_matrix(dense)
    # the cells-axis key artifact — without it the compute honestly declares no `aligned_to`.
    run.add_cells_index([f"cell-{i}" for i in range(dense.shape[0])])
    run.run_ok({"n_prin_comps": 10})

    entry = run.entry("doublet_score")
    assert entry is not None
    binding = _colour_by_binding()

    assert entry["datatype"] == binding["datatype"] == "metadata-column"
    assert entry["meta"]["kind"] == "continuous"
    assert entry["meta"]["kind"] in binding["kinds"]

    structure = entry["structure"]
    # THE ALIGNMENT DECLARATION, stated precisely. An UNDECLARED alignment is
    # `alignmentState` A3, and `rowSpaceColumns.ts` drops only A2 (aligned to a DIFFERENT row
    # space) and A4 (provably disjoint members) — so an A3 column is still OFFERED, marked
    # alignment-not-declared rather than hidden. What `aligned_to` buys is the POSITIVE
    # statement. NOTE the shipped run form does not bind `cells_index`, here or in
    # `embedding.reduce`, so on a form-launched run this is absent by construction; this test
    # drives the slot the way an agent/MCP launch can.
    assert structure.get("aligned_to"), (
        "the score column declares no `aligned_to` even though a `cells_index` was bound — "
        "the colour-by slice binds `aligned_to: $scope.axis`, so the column would never be "
        f"offered on the anchored row space. structure keys: {sorted(structure)}")
    assert isinstance(structure["aligned_to"], str) and len(structure["aligned_to"]) == 64

    # …and it is the digest of the keys we actually bound, not some other axis's.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
    import txr_columns
    import pandas as pd
    expected = txr_columns.axis_key_digest(
        pd.Series([f"cell-{i}" for i in range(dense.shape[0])]))
    assert structure["aligned_to"] == expected

    # The score column carries the axis's identity; it does NOT claim to BE the axis.
    assert "key_sequence_digest" not in structure, (
        "the score column declares `structure.key_sequence_digest`, which is the producer's "
        "claim that its own values ARE the cells-axis keys. They are floats.")
    assert "key" not in structure, structure.get("key")
