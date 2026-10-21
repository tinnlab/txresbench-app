#!/usr/bin/env python3
# ruff: noqa
"""WHAT ONE ROW IS — `measured_entity` on an imaging platform (§15.1).

§15.1 calls this "the highest-value fix" and states the failure precisely: a user "cannot
distinguish a 5 um-expansion Xenium cell set from a 15 um one at all — the exact change 10x
made between XOA versions, which alters every cell in the dataset." Two such runs have the
SAME row count, so nothing else in the system can tell them apart, and the fact is
unrecoverable from the bytes once the artifacts exist.

The discriminating test is therefore not "the block is present" but "two runs that differ
ONLY in expansion distance declare differently, at equal row counts".
"""
import gzip
import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    out = tmp_path_factory.mktemp("entity-prime")
    module, entries = XF.run_over(XF.PRIME, out)
    return {"out": out, "entries": entries}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    out = tmp_path_factory.mktemp("entity-protein")
    module, entries = XF.run_over(XF.PROTEIN, out)
    return {"out": out, "entries": entries}


def test_the_entity_is_a_segmented_cell_on_every_row_bearing_artifact(prime):
    """TEST-4 [acceptance] [invariant: INV-3] — stamped on the MATRIX too, not only the map.

    §15.1's motivating case is a set of sibling MATRICES that differ only in what one row
    is, and the matrix is the artifact every existing analysis actually consumes. An
    importer that stamped only the tissue map would leave the counts saying nothing about
    whether a row is a 55 um spot or a 5 um-expansion cell.
    """
    for output_id in ("expression", "spatial-coordinates"):
        meta = XF.entry(prime["entries"], output_id)["meta"]
        entity = meta["measured_entity"]
        assert entity["kind"] == "cell", (
            "a Xenium row IS a segmented cell — §6.1. (A Visium spot is 1-10 cells and is "
            "declared `spot`; the vocabulary distinguishes them and the label derives from "
            "it, never from the row count.)"
        )
        assert entity["platform"] == "xenium"
        assert set(entity["segmentation"]) == {"method", "params", "software_version"}
        assert entity["segmentation"]["software_version"] == XF.PRIME_XOA
        assert meta["measured_entity_label"]


def test_the_expansion_distance_is_parsed_from_the_vendors_own_string(prime):
    """TEST-4 — the ONE number §15.1 says is decisive, taken from the vendor, not assumed."""
    entity = XF.entry(prime["entries"], "spatial-coordinates")["meta"]["measured_entity"]
    params = entity["segmentation"]["params"]
    assert params["expansion_um"] == 5.0, (
        "the mouse-ileum bundle segments by 5.0 um nucleus expansion and says so in every "
        "row of cells.csv.gz; the importer must read it rather than default it"
    )
    assert params["n_methods"] == 1
    assert params["segmented_cell_nuc_expansion_frac"] == 1.0


def test_two_runs_differing_only_in_expansion_declare_differently_at_equal_row_counts(
    tmp_path,
):
    """TEST-4 — THE DISCRIMINATING ARM. This is the invariant, executed.

    Two bundles identical in every byte except `5.0µm` -> `15.0µm` in the vendor's own
    segmentation string. Same cells, same counts, same positions, same row count — the
    exact pair §15.1 says a user "cannot distinguish at all". If `measured_entity` were
    dropped, or if the expansion were not parsed out of the string, the two declarations
    would be identical and this goes red. Nothing else in the suite would notice.
    """
    def build(name, expansion):
        bundle = tmp_path / name
        shutil.copytree(XF.PRIME, bundle)
        header, rows = XF.cells_table(XF.PRIME)
        seg = header.index("segmentation_method")
        with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
            fh.write(",".join(header) + "\n")
            for row in rows:
                row = list(row)
                row[seg] = f"Segmented by nucleus expansion of {expansion}µm"
                fh.write(",".join(row) + "\n")
        out = tmp_path / f"out-{name}"
        _, entries = XF.run_over(bundle, out)
        return entries

    five = build("five", "5.0")
    fifteen = build("fifteen", "15.0")

    a = XF.entry(five, "spatial-coordinates")["meta"]
    b = XF.entry(fifteen, "spatial-coordinates")["meta"]

    assert a["n"] == b["n"], (
        "the premise: EQUAL row counts, which is why row count cannot be the label"
    )
    assert a["measured_entity"] != b["measured_entity"]
    assert a["measured_entity"]["segmentation"]["params"]["expansion_um"] == 5.0
    assert b["measured_entity"]["segmentation"]["params"]["expansion_um"] == 15.0
    assert a["measured_entity_label"] != b["measured_entity_label"], (
        "and the DERIVED LABEL differs, which is the user-visible half of §15.1 — the label "
        "derives from the declaration, never from the row count"
    )


def test_a_mixed_segmentation_run_is_named_as_a_mixture_not_reduced_to_one_method(protein):
    """TEST-4 — DEC-12, and the finding it records.

    `measured_entity.segmentation.method` is a SINGLE STRING, and XOA >= 3 is not: the real
    kidney bundle segments 358 cells by THREE different methods in one run. Reducing them to
    the most common would be a plausible-looking lie in the one field whose entire purpose
    is identity. The mixture is named, the vendor's own run-level fractions go into
    `params`, and the per-cell truth survives as a column.
    """
    meta = XF.entry(protein["entries"], "spatial-coordinates")["meta"]
    segmentation = meta["measured_entity"]["segmentation"]
    assert segmentation["method"].startswith("mixed: ")
    assert segmentation["params"]["n_methods"] == 3
    assert len(segmentation["params"]["methods"]) == 3
    for method in segmentation["params"]["methods"]:
        assert method in segmentation["method"], (
            "every method present in the run must be NAMED in the declaration; a mixture "
            "that hides one of its parts is the reduction this decision exists to refuse"
        )
    # The vendor's own composition, recorded as numbers rather than as an adjective.
    assert segmentation["params"]["segmented_cell_interior_frac"] > 0
    assert segmentation["params"]["segmented_cell_boundary_frac"] > 0


def test_the_per_cell_segmentation_survives_as_a_column(protein):
    """TEST-4 — the row-level truth the run-level string cannot hold.

    This is what makes a mixed run ANALYSABLE rather than merely labelled: a user can filter
    or colour by segmentation method and see whether a result is an artefact of it.
    """
    out = protein["out"]
    header, rows = XF.cells_table(XF.PROTEIN)
    seg = header.index("segmentation_method")
    cid = header.index("cell_id")
    by_id = {r[cid]: r[seg] for r in rows}
    expected = [by_id[c] for c in XF.matrix_cell_ids(XF.PROTEIN)]

    # `read_column` resolves the column to what it MEANS — the labels for a categorical,
    # the strings for a string column — rather than to its storage codes, which is what an
    # assertion about a processor's output wants.
    decoded = list(CZR.read_column(out / "metadata/segmentation_method.zarr"))
    assert decoded == expected, (
        "every cell's own segmentation method must round-trip IN THE MATRIX's cell order; "
        "this is the row-level truth the single run-level `method` string cannot hold"
    )
    assert len(set(decoded)) == 3, (
        "and the column must actually carry three distinct values — a column that "
        "collapsed to one would satisfy a length check and lose the whole point"
    )
