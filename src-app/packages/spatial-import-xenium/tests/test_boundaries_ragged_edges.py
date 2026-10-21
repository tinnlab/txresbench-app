#!/usr/bin/env python3
# ruff: noqa
"""#163 — the ragged cases REAL DATA CANNOT EXPRESS. TEST-8 [covers: ITEM-8, ITEM-14].

## Why this file exists at all

Measured over both real full-size Xenium bundles: 6..13 vertices per cell, **99.98% of
cells at exactly 13**, every ring closed, every run contiguous, zero orphans, zero cells
without a boundary. That is a narrow band, and a suite built only on it is #75's defect
reproduced exactly — there, every generator multiplied a base of 400, so no fixture ever
held a zero on one contrast side, and the sharpest defect survived nine audit rounds
because it was invisible BY CONSTRUCTION.

The analogues for ragged geometry are obvious once named, so they are named and built:

  * a **one-vertex** polygon (a degenerate segmentation) — real min is 6;
  * a **zero-vertex** cell — real bundles have none;
  * a polygon that **does not close** — real bundles close 463,663 of 463,663 rings;
  * **non-contiguous** vertex runs for one cell — real runs are contiguous;
  * an **empty** boundaries table;
  * offsets whose **last entry does not reach the table length**.

Every one is constructed here. None of them can be sampled.
"""
import sys
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


@pytest.fixture(scope="module")
def BD():
    return XF.load_boundaries_module()


def test_a_single_vertex_polygon_survives_as_a_single_vertex(BD):
    """A degenerate segmentation is DATA, not an error — it is what the vendor measured."""
    e = BD.assemble(["a", "b", "b"], np.array([1.0, 2.0, 3.0]),
                    np.array([4.0, 5.0, 6.0]), ["a", "b"])
    assert list(e["count"]) == [1, 2]
    assert list(e["start"]) == [0, 1]
    assert e["stats"]["n_single_vertex_entities"] == 1
    assert e["stats"]["min_vertices"] == 1
    # `[start, start+count)` is still the polygon, at k == 1.
    assert e["x"][0:1].tolist() == [1.0] and e["y"][0:1].tolist() == [4.0]
    # A 1-vertex ring is NOT counted as a ring for the closure statistic: "last == first"
    # is trivially true for one vertex and would silently inflate the closed fraction.
    assert e["stats"]["rings_with_at_least_two_vertices"] == 1


def test_an_entirely_empty_boundaries_table_is_total_rather_than_a_crash(BD):
    e = BD.assemble([], np.array([]), np.array([]), ["a", "b"])
    assert e["entity"].shape[0] == 0 and e["x"].shape[0] == 0
    assert list(e["count"]) == [0, 0]
    assert list(e["start"]) == [0, 0]
    assert e["stats"]["n_vertices"] == 0
    assert e["stats"]["n_entities_with_boundary"] == 0
    assert e["stats"]["min_vertices"] == 0
    assert e["bbox"] is None


def test_an_unclosed_polygon_is_stored_AS_WRITTEN_and_the_convention_is_declared(BD):
    """DEC-6 — the producer never closes or opens a ring.

    Both real bundles close every ring, so a producer that quietly appended a closing
    vertex would be indistinguishable from one that did not, on every real input. It is
    distinguishable HERE, and the statistic is what a consumer reads instead of guessing.
    """
    # ring `a` closes (3 == 3); ring `b` does not.
    ids = ["a", "a", "a", "b", "b"]
    xs = np.array([1.0, 2.0, 1.0, 7.0, 8.0])
    ys = np.array([1.0, 2.0, 1.0, 7.0, 9.0])
    e = BD.assemble(ids, xs, ys, ["a", "b"])
    assert list(e["count"]) == [3, 2], "a vertex was added or dropped"
    assert e["x"].tolist() == [1.0, 2.0, 1.0, 7.0, 8.0], (
        "the producer changed the vendor's vertices — it must never close or open a ring"
    )
    assert e["stats"]["closure"] == "vendor-as-written"
    assert e["stats"]["rings_closed"] == 1
    assert e["stats"]["rings_with_at_least_two_vertices"] == 2


def test_the_closure_statistic_is_computed_at_FULL_precision_not_at_float32(BD):
    """TEST-26 [covers: ITEM-8]. `rings_closed` is surfaced as a MEASURED fact, so it must be measured exactly.

    The first cut compared the NARROWED float32 endpoints, so two distinct float64 endpoints
    that collide under f32 counted as a closed ring — and at micron scale f32 resolves only
    ~1e-3 um, so it over-reported closure on exactly the real data it describes. The ring
    below is open in float64 and closed in float32.
    """
    xs = np.array([1000000.0, 1000500.0, 1000000.00001])
    ys = np.array([1.0, 2.0, 1.0])
    assert np.float32(xs[0]) == np.float32(xs[2]), "the fixture is not the f32-collision case"
    assert xs[0] != xs[2]
    e = BD.assemble(["a", "a", "a"], xs, ys, ["a"])
    assert e["stats"]["rings_closed"] == 0, (
        "an OPEN ring was reported closed — the statistic is being read off the float32 "
        "store rather than the vendor's own values"
    )


def test_non_contiguous_vertex_runs_are_grouped_not_truncated(BD):
    """Real runs are contiguous. This importer must not DEPEND on that.

    A vendor release that interleaved runs would, under a contiguity assumption, silently
    hand every cell a fraction of its polygon — a picture of the tissue that looks right.
    """
    ids = ["a", "b", "a", "b", "a"]
    xs = np.array([1.0, 10.0, 2.0, 20.0, 3.0])
    ys = np.array([1.0, 10.0, 2.0, 20.0, 3.0])
    e = BD.assemble(ids, xs, ys, ["a", "b"])
    assert list(e["count"]) == [3, 2], "an interleaved run was truncated"
    # Grouped AND stable: within each cell the vendor's own order survives.
    assert e["x"][0:3].tolist() == [1.0, 2.0, 3.0]
    assert e["x"][3:5].tolist() == [10.0, 20.0]
    assert np.all(np.diff(e["entity"]) >= 0)


def test_the_offsets_recover_every_cells_polygon_from_the_VENDORS_OWN_TEXT(BD):
    """The offsets invariant, asserted against an INDEPENDENT source.

    The first cut of this test asserted `sum(count) == n`, `start + count <= n`,
    `start[-1] + count[-1] == n` and `start[1:] == (start+count)[:-1]` — every one of which is
    an ALGEBRAIC IDENTITY of `bincount`/`cumsum`, true for any input and for any
    implementation. Both blind angles found that it could not fail, while its docstring
    claimed to be exactly the "offsets whose last entry does not equal the table length"
    case. Looping an identity over three fixtures adds no signal.

    What CAN fail is a comparison against something the implementation did not produce: the
    vendor's own decimal text, in the vendor's own order, per cell. A grouping bug, an
    unstable sort, an off-by-one in `start`, or a dropped row each turn this red — and none
    of them can be satisfied by the arithmetic being self-consistent.
    """
    for fixture in (XF.REAL_LUNG_BOUNDARIES, XF.REAL_BREAST_BOUNDARIES,
                    XF.PRIME_STAGED_BOUNDARIES):
        rings, order = XF.expected_rings(fixture)
        e = BD.read_boundaries(fixture, order)
        start, count, x, y = e["start"], e["count"], e["x"], e["y"]
        assert e["stats"]["n_vertices_not_written"] == 0, (
            f"{fixture.name}: rows were dropped, so this comparison would be against a "
            "different set than the vendor's"
        )
        for i, cid in enumerate(order):
            want = rings[cid]
            s, k = int(start[i]), int(count[i])
            assert k == len(want), f"{fixture.name} {cid}: {k} vertices, vendor wrote {len(want)}"
            got_x = x[s:s + k].tolist()
            got_y = y[s:s + k].tolist()
            assert got_x == [float(np.float32(vx)) for vx, _ in want], (
                f"{fixture.name} {cid}: the slice is not the vendor's own x, in order"
            )
            assert got_y == [float(np.float32(vy)) for _, vy in want], (
                f"{fixture.name} {cid}: the slice is not the vendor's own y, in order"
            )


def test_an_offsets_pair_that_does_NOT_reach_the_table_length_is_detectable(BD, tmp_path):
    """The brief's named case — driven through the SHIPPED WRITER, which the last cut claimed
    and did not do.

    Two cuts of this test were hollow. The first asserted an identity of `bincount`/`cumsum`.
    The second SAID it would feed "the shipped writer an `encode` result whose count has been
    corrupted past the table length" and then did list arithmetic on a test-local copy —
    a blind angle pointed out that no production code beyond `assemble` participated, so the
    docstring was a false claim about its own body.

    This corrupts the encode result, writes it with `write_boundaries`, and reads the store's
    DECLARED `n` back. The pair and the table then disagree, and the one line a consumer must
    write — `start + count <= n` — is what detects it. That line is exercised against a real
    emitted structure, not against a local array.
    """
    SD = XF._load_by_path("spatial_declarations",
                          XF.PKG / "compute" / "spatial_declarations.py")
    e = BD.assemble(["a", "a", "b"], np.arange(3, dtype=float),
                    np.arange(3, dtype=float), ["a", "b"])
    n = int(e["entity"].shape[0])
    assert int(e["start"][-1] + e["count"][-1]) == n

    e["count"] = e["count"].copy()
    e["count"][-1] += 5
    space = SD.coordinate_space(space="fixture", unit="micrometre",
                                to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0])
    structure, _meta = BD.write_boundaries(
        tmp_path, "spatial/boundaries.zarr", e,
        space=space, series=SD.section(sample_id="fixture", index=0))

    declared_n = int(structure["n"])
    assert declared_n == n, "the writer wrote the corrupted count into the table's own length"
    over = [i for i in range(len(e["count"]))
            if int(e["start"][i] + e["count"][i]) > declared_n]
    assert over == [1], (
        "the `start + count <= n` guard does not flag the corrupted pair against the store's "
        "OWN declared length — a consumer that trusts the slice's length instead sees a "
        "short polygon and no error"
    )


def test_a_cells_axis_with_a_repeated_key_refuses(BD):
    """A caller bug, refused loudly rather than silently attributing to the last one."""
    with pytest.raises(BD.BoundariesError) as exc:
        BD.assemble(["a"], np.zeros(1), np.zeros(1), ["a", "a"])
    assert "repeated key" in str(exc.value)


def test_a_non_numeric_vertex_column_refuses_by_name(BD, tmp_path):
    """TEST-28 [covers: ITEM-4]. The third column got the validation the first two had, and the first cut's did not.

    `cell_id`'s dtype was refused by name while `vertex_x`/`vertex_y` were unchecked, so a
    STRING coordinate column was silently PARSED and a non-numeric one raised a bare numpy
    `ValueError` — neither a `BoundariesError`, so neither reached the user as a message.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    bad = tmp_path / "string_coords.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([b"a"], type=pa.binary()),
                             "vertex_x": pa.array(["1.5"]),
                             "vertex_y": pa.array([2.0])}), bad)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(bad, ["a"])
    assert "vertex_x" in str(exc.value) and "not a number" in str(exc.value)


def test_a_RING_SPLIT_ACROSS_TWO_BATCHES_keeps_its_true_first_and_last(BD, tmp_path,
                                                                      monkeypatch):
    """TEST-22 [covers: ITEM-4, ITEM-8]. The whole streaming rework was UNCOVERED — no test read more than one batch.

    A blind angle grepped the suite: `BATCH_ROWS` appeared exactly once, in a test that
    raised before `iter_batches` was reached. So the cross-batch bookkeeping the rework
    exists for — `first_xy` set once per entity, `last_xy` overwritten, the running counters,
    the multi-chunk concatenate — was proven by nothing. This reads a ring that STRADDLES a
    batch boundary and checks the ring's endpoints are the file's first and last for that
    cell, not the batch's.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    # cell `a` spans rows 0..5, cell `b` rows 6..9, at BATCH_ROWS=3 -> 4 batches.
    ids = [b"a"] * 6 + [b"b"] * 4
    xs = [1.0, 2.0, 3.0, 4.0, 5.0, 1.0, 70.0, 80.0, 90.0, 70.0]
    ys = [1.0, 2.0, 3.0, 4.0, 5.0, 1.0, 70.0, 80.0, 90.0, 70.0]
    path = tmp_path / "split.parquet"
    pq.write_table(pa.table({"cell_id": pa.array(ids, type=pa.binary()),
                             "vertex_x": pa.array(xs), "vertex_y": pa.array(ys)}),
                   path, row_group_size=3)
    monkeypatch.setattr(BD, "BATCH_ROWS", 3)

    e = BD.read_boundaries(path, ["a", "b"])
    assert list(e["count"]) == [6, 4], "a run was lost at a batch boundary"
    assert list(e["start"]) == [0, 6]
    assert e["x"].tolist() == xs, "the vendor's own order did not survive the batching"
    # BOTH rings close in the FILE, and only a cross-batch first/last can see it: `a`'s
    # first vertex is in batch 1 and its last is in batch 2.
    assert e["stats"]["rings_closed"] == 2, (
        "a ring that straddles a batch boundary lost its true endpoints — `first_xy` is "
        "being overwritten per batch, or `last_xy` is not"
    )
    assert e["stats"]["n_vertices"] == 10


def test_a_file_that_is_ALL_unmatched_EXCEPT_for_a_null_still_refuses_as_the_wrong_file(BD):
    """The refusal compared the wrong two counters, so one null disabled it.

    `seen_rows` counts every decoded row including nulls; `unmatched_total` counts only
    non-null ids absent from the axis. Comparing those two meant a single null anywhere in an
    otherwise entirely-foreign file took the vaguer empty-result path instead of the accurate
    "wrong file for this bundle". Found blind and reproduced.
    """
    with pytest.raises(BD.BoundariesError) as exc:
        BD.assemble(["ghost", "ghost", None], np.zeros(3), np.zeros(3), ["a", "b"])
    assert "the wrong file for this bundle" in str(exc.value)


# ONE banned list, used by BOTH note assertions below. Two lists drifted apart once already:
# TEST-1's had "tolerance" and TEST-3's did not, so a tolerance could be re-added to the prose
# of the partial and degenerate branches (which only TEST-3 reaches) and stay green.
_NO_RULING_IN_PROSE = ("5x", "consistent", "verdict", "tolerance", "band")


# The FACTS the artifact supports, per case: does the vertex extent intersect the centroid
# extent at all, and does it CONTAIN it. No verdict column — there is no verdict any more.
@pytest.mark.parametrize("case,vertex,centroid,overlaps,contained", [
    # A correctly placed segmentation: the polygons surround their own centroids.
    ("well-placed",      (-1, 11, -1, 11), (0, 10, 0, 10), True,  True),
    ("identical",        (0, 10, 0, 10),   (0, 10, 0, 10), True,  True),
    # THE §7.3 FAILURES a plain box intersection reports as agreement. CONTAINMENT separates
    # two of the three: a y-flip about the origin merely TOUCHES at y=0, and an x/y transpose
    # on non-square tissue INTERSECTS — neither contains. The third (a uniform scale error)
    # DOES contain, and is pinned by its own test below as the case the facts cannot separate.
    ("y-flip-touching",  (-10, 0, -10, 0), (0, 10, 0, 10), True,  False),
    ("xy-transpose",     (0, 20, 0, 90),   (0, 90, 0, 20),  True,  False),
    ("1000x-scale",      (0, 10000, 0, 10000), (0, 10, 0, 10), True, True),
    # And the loud cases.
    ("disjoint-x",       (11, 20, 0, 10),  (0, 10, 0, 10),  False, False),
    ("disjoint-y",       (0, 10, 11, 20),  (0, 10, 0, 10),  False, False),
])
def test_the_coverage_report_carries_FACTS_AND_NO_PLACEMENT_VERDICT(BD, case, vertex,
                                                                    centroid, overlaps,
                                                                    contained):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-4] (#247).

    §7.5, verbatim: *"Nothing in the conformance gate can check an affine (§12.2). The
    compensating control is a rendered overlay in the `report/qc`."* The placement JUDGEMENT
    belongs to that overlay — it has an external referent. This producer has only the
    artifact's own extents, so it reports what those support and rules on nothing.

    AND FOR THIS PRODUCER THE OVERLAY NOW EXISTS (#301). This docstring has carried two
    earlier positions: #247's, that "the placement JUDGEMENT is that overlay's (#156)"; and
    #291's, that #156 built the overlay for `spatial-import-visium` only and is closed, so
    Xenium boundary placement was judged by nothing at either end. #301 built one here —
    `spatial-import-xenium/compute/registration_qc.py`, staged and emitted as a `report/qc`
    artifact — so the judgement lands somewhere again, and this docstring says where.

    WHAT DOES NOT CHANGE HERE, AND IT IS THE WHOLE POINT OF THIS TEST: the coverage block
    still reports FACTS and rules on nothing. The overlay is a separate module, with a
    separate referent, reporting a separate number; it is not a licence to fold a verdict
    back into `coverage_against`, which is exactly the move #247 removed. The key set below
    is asserted EXACTLY for that reason, and the existence of a downstream judge makes it
    MORE important rather than less: "something else checks it now" is the most natural
    argument for smuggling a hint in here, and it is not a good one. See
    `test_placement_judgement_disclosure.py` for the overlay's own assertions.

    An earlier cut folded the facts plus a hard-coded 5x scale band into a `consistent`
    boolean that reached `meta` and the user-facing report as though it were declared. The
    key set is asserted EXACTLY, in every branch, so no verdict can come back under any name:
    a re-added key fails this immediately.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    got = BD.coverage_against(bbox(vertex), bbox(centroid))
    assert set(got) == {"vertex_bbox", "centroid_bbox", "overlaps", "centroids_contained",
                        "extent_ratios", "note"}, (
        f"{case}: the coverage report carries a key beyond the facts and the note — a "
        f"producer-side placement verdict is back in the artifact: {sorted(got)}"
    )
    assert got["overlaps"] is overlaps, f"{case}: overlaps — {got['note']}"
    assert got["centroids_contained"] is contained, f"{case}: contained — {got['note']}"
    # AND THE NOTE IS PART OF THE ARTIFACT. A verdict removed from the key set and re-added
    # as prose is the same defect in a font a schema cannot see, so the one field that
    # carries free text is held to the same rule in every branch.
    for banned in _NO_RULING_IN_PROSE:
        assert banned not in got["note"].lower(), (
            f"{case}: the note rules where the key set does not: {got['note']}"
        )


def test_NO_SCALE_BAND_governs_the_report_only_the_RAW_RATIO_is_reported(BD):
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-1, ITEM-2] (#247).

    §7.3, verbatim: *"the design rule is: declare the space, never the scale factor alone."*
    The removed `_SCALE_HINT_MAX = 5.0` was the opposite move — a scale tolerance this
    importer invented, bounding a quantity (segmentation extent ÷ centroid extent) that is a
    function of cell density and border margin, neither measured anywhere and with no
    published value to adopt.

    So this asserts the ABSENCE of a band behaviourally rather than by grepping for the
    constant: a 1000x pair and a 1.2x pair are reported IDENTICALLY on both facts, and differ
    only in the number a reader can judge. Re-introduce any band — 5x, 50x, 1000x — and the
    booleans or the notes diverge and this goes red. The 1000x case being fact-invisible HERE
    is the honest limit stated in #247's DEC-5 — *"caught by nothing"* — which #291 recorded
    as UNQUALIFIED on the Xenium path, because #156's overlay (the mitigation #247 named) was
    built for `spatial-import-visium` only.

    #301 QUALIFIED IT AGAIN, and the correction belongs here rather than only in the module
    that made it: this producer now has that external referent. The polygons and the
    centroids are stamped with the SAME space object by the same writer call, so a 1000x pair
    is a 1000x error on the centres too, and `compute/registration_qc.py` places those
    centres on the morphology image and scores them against its pixels — measured, a 2x
    misscale takes the signal lift from 0.608 to 0.000. What is still caught by nothing is
    narrower and is named rather than dropped: a uniform error under about 2%, and a polygon
    set correctly SCALED but wrongly SHAPED, which the overlay does not draw. This function
    still reports the raw ratio for exactly those.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    centroid = bbox((0, 10, 0, 10))
    # RATIO POINTS ACROSS NINE DECADES, and the note pinned by its OWN words. Sampling can
    # only refute a band it straddles: a two-point cut (1.2x and 1000x) passed with a
    # re-added `r > 1.1` branch, because both points sat above it. A point just above 1.0
    # catches any band above 1.0001x; requiring the benign WORDING catches a band below it;
    # and the decades between are what catch a band placed anywhere up to 1e9x. A band
    # threshold ABOVE 1e9x would still survive, which is stated rather than papered over —
    # the assertion is what these probes can honestly support.
    probes = {
        "1.0001x": bbox((-0.0005, 10.0005, -0.0005, 10.0005)),
        "1.2x": bbox((-1, 11, -1, 11)),
        "5.5x": bbox((-22.5, 32.5, -22.5, 32.5)),
        "1000x": bbox((0, 10000, 0, 10000)),
        "1e6x": bbox((0, 10 ** 7, 0, 10 ** 7)),
        "1e9x": bbox((0, 10 ** 10, 0, 10 ** 10)),
    }
    got = {name: BD.coverage_against(box, centroid) for name, box in probes.items()}
    for name, one in got.items():
        assert one["overlaps"] is True, name
        assert one["centroids_contained"] is True, name
        assert "lies inside the polygon extent" in one["note"], (
            f"{name}: a pair that contains its centroids is described as something else — "
            f"a band is judging the ratio: {one['note']}"
        )
    # THE CONTROL IS THE OTHER NOTES AGAINST THE WELL-PLACED ONE — comparing the well-placed
    # note to itself would be an always-true arm dressed as a check.
    assert len({one["note"] for one in got.values()}) == 1, (
        "pairs from 1.0001x to 1e9x are not described identically, so something is still "
        f"judging the ratio: { {n: o['note'] for n, o in got.items()} }"
    )
    assert got["1.0001x"]["extent_ratios"] == [1.0001, 1.0001]
    assert got["1.2x"]["extent_ratios"] == [1.2, 1.2]
    assert got["1000x"]["extent_ratios"] == [1000.0, 1000.0], (
        "the raw ratio is the ONLY thing that distinguishes a 1000x scale error here; "
        "losing it leaves a reader nothing to judge"
    )
    assert got["1e9x"]["extent_ratios"] == [1e9, 1e9]


@pytest.mark.parametrize("case,vertex,centroid,without,expected", [
    # (the note each pair must get, by NAME — the precedence is the assertion)
    ("degenerate-identical",   (5, 5, 5, 5),         (5, 5, 5, 5),     0, "degenerate"),
    ("degenerate-vertex-only", (0, 10, 0, 10),       (5, 5, 5, 5),     0, "degenerate"),
    ("partial-set",            (0, 10, 0, 10),       (0, 100, 0, 100), 7, "partial"),
    ("complete-and-placed",    (-1, 11, -1, 11),     (0, 10, 0, 10),   0, "benign"),
    ("no-overlap",             (11, 20, 0, 10),      (0, 10, 0, 10),   0, "no-overlap"),
    ("not-contained",          (-10, 0, -10, 0),     (0, 10, 0, 10),   0, "not-contained"),
    ("xy-transpose",           (0, 20, 0, 90),       (0, 90, 0, 20),   0, "not-contained"),
    # THE TWO COMBINATIONS THAT BROKE THE PRECEDENCE, and were absent from the first cut of
    # this list — which is why it passed while the note was wrong. A partial set explains a
    # CONTAINMENT failure and a degenerate centroid extent explains a MISSING RATIO; neither
    # explains two extents that do not intersect at all, and answering one with "§15.3 makes
    # partial coverage a declared legitimate state, not a defect" is a reassurance about the
    # exact failure §7.3 says must not stay silent.
    ("partial-AND-disjoint",   (11, 20, 0, 10),      (0, 10, 0, 10),   7, "no-overlap"),
    ("degenerate-AND-disjoint", (0, 10, 20, 30),     (5, 5, 5, 5),     0, "no-overlap"),
    # AND THE TWO THE PARTIAL BRANCH OUTRANKS. Without them `elif partial:` could be narrowed
    # to `elif partial and not degenerate:` or `elif partial and not contains:` and stay
    # green — a partial bundle would then be described as degenerate, or as correctly placed,
    # by a branch nothing exercises.
    # ONE is the boundary of "the bundle stated a count", and it is a count `run_import`
    # produces on every bundle with a single unsegmented cell. Without this row the `> 0`
    # test could be `> 1` and a real bundle would be told it stated nothing.
    ("partial-count-of-one",   (-10, 0, -10, 0),     (0, 10, 0, 10),   1, "partial"),
    ("partial-AND-degenerate", (0, 10, 0, 10),       (5, 5, 5, 5),     7, "partial"),
    ("partial-AND-contained",  (0, 10, 0, 10),       (2, 8, 2, 8),     7, "partial"),
    # A NEGATIVE count is not a count: it is neither partial nor complete, and the two halves
    # of the decision must land on the same side of it (see `coverage_is_reportable`).
    ("negative-count",         (-10, 0, -10, 0),     (0, 10, 0, 10),  -5, "partial"),
    ("unreadable-count",       (-10, 0, -10, 0),     (0, 10, 0, 10),  "", "partial"),
    # THREE MORE SHAPES A STORED REPORT CAN CARRY AND A BUNDLE CANNOT MEAN. `inf` survives a
    # JSON round-trip (`json.loads` parses the bare token) and `int()` answers it with an
    # OverflowError, which is not a ValueError; 2.9 cells is not a count and rounding it
    # would quote the rounding back at the reader as the bundle's own number; and a JSON
    # `true` is `int(True) == 1`, i.e. a plausible-looking count invented from a boolean.
    ("infinite-count",         (-10, 0, -10, 0),     (0, 10, 0, 10), float("inf"), "partial"),
    ("fractional-count",       (-10, 0, -10, 0),     (0, 10, 0, 10), 2.9, "partial"),
    ("boolean-count",          (-10, 0, -10, 0),     (0, 10, 0, 10), True, "partial"),
    # AND THE ONE THAT IS NOT A ValueError. `int(Decimal("Infinity"))` raises OverflowError,
    # which a `(TypeError, ValueError)` guard does not catch — and a report loaded with
    # `json.loads(..., parse_float=Decimal)` carries exactly this. An uncaught raise here
    # costs the whole summary, not this section.
    ("decimal-infinite-count", (-10, 0, -10, 0),     (0, 10, 0, 10),
     Decimal("Infinity"), "partial"),
    # ONE AXIS A POINT IS NOT A DEGENERATE PAIR. A single-column tissue has a real y ratio
    # and no x ratio, and calling that "degenerate" would print "neither axis has a defined
    # extent ratio" beside an artifact field that carries one.
    ("half-degenerate-x",      (0, 10, 0, 10),       (5, 5, 0, 10),    0, "benign"),
])
def test_the_note_is_DERIVED_FROM_THE_FACTS_and_invents_no_tolerance(BD, case, vertex,
                                                                     centroid, without,
                                                                     expected):
    """TEST-3 [covers: ITEM-2] (#247). The prose a human reads must say only what was measured.

    Every branch is named and pinned, because the note's PRECEDENCE is what decides which
    true sentence a reader gets. A DEGENERATE centroid extent has no ratio at all (an earlier
    cut answered "DIFFER IN SCALE BY MORE THAN 5x" for two IDENTICAL boxes, and a later one
    called a real polygon box degenerate because its centroids were one point). A PARTIAL
    polygon set has no containment expectation (§15.3 declares it legitimate). Neither of
    those explains a NON-OVERLAP, so a non-overlap outranks both.

    And no branch may re-acquire a ruling: no note carries a verdict word or a tolerance.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    got = BD.coverage_against(bbox(vertex), bbox(centroid), entities_without_boundary=without)
    note = got["note"]
    for banned in _NO_RULING_IN_PROSE:
        assert banned not in note.lower(), (
            f"{case}: the note carries {banned!r} — a judgement, not a measurement: {note}"
        )

    # WHICH note, by its own words. Each marker appears in exactly one branch.
    markers = {
        "degenerate": "a single position (a degenerate extent)",
        "partial": "§15.3 makes partial coverage a declared legitimate state",
        "benign": "lies inside the polygon extent",
        "no-overlap": "DOES NOT OVERLAP THE CENTROID EXTENT AT ALL",
        "not-contained": "NOT INSIDE THE POLYGON EXTENT",
    }
    assert markers[expected] in note, f"{case}: expected the {expected} note, got: {note}"
    for name, marker in markers.items():
        # NO CARVE-OUT. The first cut exempted the benign case from the not-contained marker.
        # Honestly stated: removing it changes nothing today (the two wordings differ in
        # case, so the exemption never fired) — it is removed because an exemption that
        # cannot be exercised is a hole waiting for the day a note is reworded into it, not
        # because it was hiding a live defect.
        if name != expected:
            assert marker not in note, f"{case}: the {name} note leaked in: {note}"

    # §7.3 is cited on exactly the two FACT failures, and on nothing else.
    loud = expected in ("no-overlap", "not-contained")
    assert ("§7.3" in note) is loud, f"{case}: the note does not match the facts — {note}"
    assert loud is (got["overlaps"] is False
                    or (got["centroids_contained"] is False and without == 0)), (
        f"{case}: the note's loudness and the facts disagree — {note}"
    )
    if expected == "partial":
        # A REAL COUNT IS QUOTED; A NON-COUNT IS NAMED AS ONE. `-5` and `""` are
        # not-complete, so they take this branch — but they are not numbers of cells, and a
        # note that says "-5 of this bundle's cells have no polygon" describes no bundle.
        if isinstance(without, int) and not isinstance(without, bool) and without > 0:
            assert f"{without} of this bundle's cells have no polygon" in note, (
                f"{case}: the partial note must quote the DECLARED count"
            )
        else:
            assert "does not state how many" in note, (
                f"{case}: an unusable count is described as if it were a real one: {note}"
            )
            # (`""` is a substring of everything, so only a non-empty value can be looked for)
            assert not str(without) or str(without) not in note, (
                f"{case}: the unusable value is quoted back at the reader: {note}"
            )
    if expected == "degenerate":
        # A point denominator yields no ratio on EITHER axis — undefined, not large — and the
        # slot is kept so [x, y] stays addressable by position.
        assert got["extent_ratios"] == [None, None], (
            f"{case}: a zero-span axis did not keep its slot: {got['extent_ratios']}"
        )
        assert "neither axis" in note, f"{case}: the note does not say what is undefined"
    if case == "half-degenerate-x":
        # THE SLOT, AND ONLY THE SLOT. This is the case the positional list exists for, and
        # it is the one a both-axes-degenerate fixture cannot exercise: drop the `None` and
        # the y ratio slides into x's place, silently, in the artifact AND in the summary.
        assert got["extent_ratios"] == [None, 1.0], (
            f"the undefined x axis did not keep its slot: {got['extent_ratios']}"
        )
    # And nothing non-finite reaches the manifest's JSON.
    import json
    json.dumps(got, allow_nan=False)


@pytest.mark.parametrize("case,vertex,centroid,without,reportable", [
    ("well-placed",             (-1, 11, -1, 11), (0, 10, 0, 10),   0,    False),
    ("1000x-scale",             (0, 10000, 0, 10000), (0, 10, 0, 10), 0,  False),
    ("not-contained",           (-10, 0, -10, 0), (0, 10, 0, 10),   0,    True),
    ("not-contained-partial",   (0, 10, 0, 10),   (0, 100, 0, 100), 7,    False),
    ("not-contained-unknown",   (0, 10, 0, 10),   (0, 100, 0, 100), None, False),
    ("no-overlap",              (11, 20, 0, 10),  (0, 10, 0, 10),   0,    True),
    ("no-overlap-partial",      (11, 20, 0, 10),  (0, 10, 0, 10),   7,    True),
    ("no-overlap-unknown",      (11, 20, 0, 10),  (0, 10, 0, 10),   None, True),
    ("degenerate",              (0, 10, 0, 10),   (5, 5, 5, 5),     0,    False),
    ("negative-count",          (-10, 0, -10, 0), (0, 10, 0, 10),   -5,   False),
    ("unreadable-count",        (-10, 0, -10, 0), (0, 10, 0, 10),   "",   False),
    ("unreadable-list-count",   (-10, 0, -10, 0), (0, 10, 0, 10),   [],   False),
    ("infinite-count",          (-10, 0, -10, 0), (0, 10, 0, 10), float("inf"), False),
    ("decimal-infinite-count",  (-10, 0, -10, 0), (0, 10, 0, 10),
     Decimal("Infinity"), False),
    ("half-degenerate-loud",    (0, 10, 0, 10),   (5, 5, -5, 20),   0,    True),
])
def test_ONE_derivation_decides_both_the_note_and_whether_a_human_sees_it(BD, case, vertex,
                                                                          centroid, without,
                                                                          reportable):
    """TEST-7 [covers: ITEM-2, ITEM-3] (#247). The producer and the report may not disagree.

    The note's precedence and the renderer's "is this worth showing" condition were two
    independent derivations of the same question, and they diverged: for a disjoint pair on a
    partial bundle the producer chose the partial note and the renderer showed it, so the
    summary answered the §7.3 failure with "not a defect". `coverage_is_reportable` is now the
    single derivation, and this asserts the two halves stay coupled — a reportable pair always
    gets a §7.3 note, and a §7.3 note is always reportable.

    `without=None` is the "unknown is not complete" case: a caller with no count must not have
    a containment failure reported as a defect (§15.3 — do not infer a declared state from a
    null), while a NON-OVERLAP is reportable whatever the count says. An unreadable count
    (`""`, and a negative one) lands on the same side as an absent one, and — this is the
    coupling — the PRODUCER puts those on the same side too, so the note stops being loud
    exactly where the report stops showing it.

    The coupling is asserted in BOTH directions wherever the count is a real one: a reportable
    pair carries §7.3, and a §7.3 note is reportable. The converse holds only for a KNOWN
    count, which is the deliberate §15.3 exemption rather than a gap — an unknown count leaves
    a containment failure unreported ON PURPOSE, and that row is pinned here.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    # THE PRODUCER IS HANDED THE SAME VALUE THE PREDICATE IS. The first cut passed `0` to the
    # producer for the unknown cases, which is precisely the substitution that hid the
    # asymmetry it claimed to test: the predicate tolerated `""` while the producer raised on
    # it. Nothing is normalised here any more.
    got = BD.coverage_against(bbox(vertex), bbox(centroid),
                              entities_without_boundary=without)
    known = BD.coverage_is_reportable(
        {"overlaps": True, "centroids_contained": False}, entities_without_boundary=without
    ) or without == 0
    assert BD.coverage_is_reportable(got, entities_without_boundary=without) is reportable, (
        f"{case}: reportability disagrees with the case — {got['note']}"
    )
    if reportable:
        assert "§7.3" in got["note"], (
            f"{case}: a reportable pair is shown a note that does not name the failure it "
            f"is reporting — {got['note']}"
        )
    elif known:
        # THE CONVERSE, where it is meant to hold: with a count the report can read, a note
        # that names the §7.3 failure must be one a human is shown. (With an unknown or
        # unreadable count it must NOT — §15.3 — and the `not-contained-unknown` and
        # `unreadable-count` rows above are exactly those cases.)
        assert "§7.3" not in got["note"], (
            f"{case}: the note names the §7.3 failure but the report stays silent — the two "
            f"halves of the decision have come apart again: {got['note']}"
        )
    assert BD.coverage_is_reportable(None, entities_without_boundary=without) is False
    assert BD.coverage_is_reportable({}, entities_without_boundary=without) is False


def test_no_NON_FINITE_ratio_can_reach_the_manifests_json(BD):
    """`inf / inf` is NaN, and `r != float("inf")` let it through into `json.dumps`.

    A manifest entry that is not valid JSON is an artifact nothing can read.
    """
    import json
    huge = {"x_min": float("-inf"), "x_max": float("inf"),
            "y_min": float("-inf"), "y_max": float("inf")}
    got = BD.coverage_against(huge, huge)
    json.dumps(got, allow_nan=False)
    assert got["extent_ratios"] == [None, None]


def test_the_coverage_predicate_is_absent_rather_than_guessed_when_a_bbox_is_missing(BD):
    """An empty polygon set has no extent, and a note about nothing is worse than none."""
    assert BD.coverage_against(None, {"x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1}) is None
    assert BD.coverage_against({"x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1}, None) is None
