#!/usr/bin/env python3
# ruff: noqa
"""#163 — what a `cell.filter` does to this artifact. TEST-15 [covers: ITEM-12].

## What is pinned here and what is measured elsewhere

The END-TO-END filter behaviour was MEASURED by running the server's own
`filter_vd_test` harness against a boundaries-shaped artifact; the log and the verdict are
in `.lifecycle/spatial-geometry/FILTER_MEASUREMENT.md`. That run is an experiment rather
than a committed test for one reason: committing it would be an `src-app/server/tests/**`
change, and INV-3's whole claim is that a new kind costs no `src-app` edit. Buying the
regression signal by falsifying the invariant is the wrong trade.

What IS pinned, here, is the pair of facts about the emitted artifact that DETERMINE the
outcome — so a later change cannot move the behaviour without turning something red:

  * `virtual_dataset.rs:1516-1521` (`source_gather_kind`) gathers ANY artifact whose
    structure declares a singular `axis`, and mints the recipe with
    `column_selector: SOURCE_MEMBER` where `SOURCE_MEMBER = "values"` (`:180`, `:1672`);
  * `source_dtype`/`source_kind` (`:422-462`) find that member only by `path == "values"`,
    or by there being EXACTLY ONE column.

So a three-member vertex table has no `values` member and is not a single-column store: the
gathered row selects a member the store does not have, and the serve path answers 404
(`local_fs.rs:300-308`). **That is a loud failure and it is left loud.** Renaming a member
to `values` would silence it and replace it with silent wrong data — `filter_vd_test.rs`
measured exactly that for a 2-D member named `values`, where "the served column has the
right length, the right dtype and holds numbers that are not the coordinates."

The offsets are the half that DOES survive, and `(start, count)` rather than a cumulative
`indptr` is what makes them still correct afterwards (DEC-4).
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("bnd-filter")
    root = XF.stage_bundle(out, boundaries=XF.PRIME_STAGED_BOUNDARIES)
    outputs = out / "outputs"
    outputs.mkdir()
    _module, entries = XF.run_over(root, outputs)
    return {"entries": entries, "outputs": outputs}


def test_the_vertex_table_has_no_member_named_values_and_is_not_single_column(run):
    """The two facts that make the gather a 404 rather than silent wrong data.

    NOT a rename. If a future change makes this table single-member or names a member
    `values`, this goes red — which is the point: that change would convert a loud refusal
    into a served column of the wrong numbers.
    """
    b = XF.entry(run["entries"], "spatial-boundaries")
    members = [c["path"] for c in b["structure"]["columns"]]
    assert "values" not in members, (
        f"a member is named `values` ({members}). `virtual_dataset.rs` hardcodes that name "
        "as its column selector, so this table would be SERVED through a cell mask as a "
        "flat 1-D column of whichever member matched — right length, right dtype, wrong "
        "numbers. A 404 is the correct outcome and must stay reachable."
    )
    assert len(members) == 3, f"expected the declared three members, got {members}"
    assert b["structure"]["axis"] == "vertex", (
        "the table declares no axis or a different one; the axis is what makes the "
        "coincidental-length collision case resolvable at all"
    )


def test_the_offset_columns_are_shaped_exactly_like_every_other_gatherable_column(run):
    """The half that survives, pinned in the shape the gather needs.

    A `metadata-column` store's one member is named `values` and its structure declares
    `axis: cells` — so `source_dtype`/`source_kind` resolve it, the mask's length matches,
    and it is gathered through the mask like any other per-cell column.
    """
    for name in ("boundary_vertex_start", "boundary_vertex_count"):
        col = XF.entry(run["entries"], f"metadata-column:{name}")
        cols = col["structure"]["columns"]
        assert len(cols) == 1, f"{name} is not a single-member store: {cols}"
        assert cols[0]["path"] == "values", (
            f"{name}'s member is {cols[0]['path']!r}, not `values` — it would stop being "
            "gatherable and the surviving half of this artifact would be lost"
        )
        assert col["structure"]["axis"] == "cells"
        assert cols[0]["dtype"] == "int64"


def test_the_offsets_are_start_and_count_not_a_cumulative_indptr(run):
    """DEC-4 — the property that makes the surviving half still CORRECT after a filter.

    A cumulative `indptr` has n+1 entries and each depends on its neighbours, so a filtered
    subset of the cells axis renumbers into nonsense. A self-contained `(start, count)` pair
    keeps naming the right ABSOLUTE range in a vertex table that is passed through unmasked.

    The first cut of this test checked only that the two columns had equal `structure.n` and
    that `meta["offset_columns"]` was a literal dict, and left two imports unused — a blind
    angle called it "the residue of an assertion that was planned and not written". So the
    filter is SIMULATED here on the real emitted bytes: take an arbitrary keep-mask over the
    cells axis, gather the two columns through it the way the VD gather would, and assert
    that every kept cell's `[start, start+count)` still selects the same vertices it did
    before — the property an `indptr` would lose.
    """
    import txr_zarr_read

    outputs = run["outputs"]
    start = np.asarray(txr_zarr_read.read_column(
        outputs / "metadata" / "boundary_vertex_start.zarr", "values"), dtype=np.int64)
    count = np.asarray(txr_zarr_read.read_column(
        outputs / "metadata" / "boundary_vertex_count.zarr", "values"), dtype=np.int64)
    entity = np.asarray(txr_zarr_read.read_array(
        outputs / "spatial" / "boundaries.zarr", "entity_index"), dtype=np.int64)
    x = np.asarray(txr_zarr_read.read_array(
        outputs / "spatial" / "boundaries.zarr", "x"), dtype=np.float32)

    n_cells = start.shape[0]
    assert count.shape[0] == n_cells, (
        "the offsets are not one-per-entity — an `indptr` would be n+1 long, and a consumer "
        "slicing it after a filter would read the wrong range"
    )

    # THE COMPARISON IS AGAINST THE VENDOR'S OWN TEXT, not against the same slice twice.
    #
    # The first cut computed `before[i] = x[start[i]:start[i]+count[i]]` and then compared it
    # to `x[g_start[j]:...]` where `g_start = start[keep]` — so `g_start[j]` IS `start[i]` by
    # the definition of boolean masking and the loop compared a slice with itself. A blind
    # angle ran it over deliberately garbage offsets (`start=9, count=7` everywhere) and it
    # passed. What discriminates a `(start, count)` pair from a renumbered `indptr` is
    # whether the ABSOLUTE range still names the right VENDOR vertices after its neighbours
    # are gone, so the expected values come from outside the artifact entirely.
    rings, order = XF.expected_rings(XF.PRIME_STAGED_BOUNDARIES)
    assert len(order) == n_cells, (
        f"the fixture's {len(order)} cells and the emitted {n_cells} offsets disagree"
    )
    want = {i: [float(np.float32(vx)) for vx, _ in rings[cid]]
            for i, cid in enumerate(order)}

    # THE GATHER, as the VD does it: the two columns are masked; the vertex table is not.
    keep = np.zeros(n_cells, dtype=bool)
    keep[::3] = True
    assert keep.sum() >= 2, "the mask keeps too few cells to prove anything"
    g_start, g_count = start[keep], count[keep]
    kept_ids = [i for i in range(n_cells) if keep[i]]
    assert len(kept_ids) < n_cells, "the mask keeps everything — nothing is being filtered"

    for j, i in enumerate(kept_ids):
        after = x[int(g_start[j]):int(g_start[j] + g_count[j])].tolist()
        assert after == want[i], (
            f"cell {order[i]!r} lost its polygon through the filter: {after} != {want[i]}. "
            "That is what a cumulative indptr would do — (start, count) is what keeps the "
            "absolute range meaningful when its neighbours are gone."
        )

    # AND THE CONTROL that the comparison can fail: an INDPTR-shaped renumbering of the same
    # data, which is what the design rejected, must NOT satisfy it.
    renumbered = np.concatenate(([0], np.cumsum(g_count)[:-1]))
    mismatches = sum(
        1 for j, i in enumerate(kept_ids)
        if x[int(renumbered[j]):int(renumbered[j] + g_count[j])].tolist() != want[i]
    )
    assert mismatches > 0, (
        "renumbering the offsets the way a cumulative indptr would does NOT change what the "
        "slices hold — so this test cannot tell the two encodings apart and proves nothing"
    )

    b = XF.entry(run["entries"], "spatial-boundaries")
    assert b["meta"]["offset_columns"] == {"start": "boundary_vertex_start",
                                          "count": "boundary_vertex_count"}, (
        "the artifact does not declare WHICH columns address it; a consumer would have to "
        "guess the names, and after a filter the vertex table is the only thing that says "
        "how to read it"
    )
    # The vertex table itself is UNCHANGED by the gather — that is why absolute indices work.
    assert entity.shape[0] == x.shape[0]
