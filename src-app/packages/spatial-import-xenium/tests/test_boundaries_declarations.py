#!/usr/bin/env python3
# ruff: noqa
"""#163 — the boundaries land in the SAME declared coordinate space. TEST-12 [covers: ITEM-9].

#228 established that the camera lives in the declared coordinate space and that points are
drawn at raw declared coordinates and never moved. Geometry has to land in that same frame,
or the polygons and the centroids are two pictures of different tissues.

#211 established HOW a declaration reaches a sandboxed consumer: in the artifact's own file
format — `structure['txr_spatial']` in the Zarr store's `attributes.txr`, written at one
enforced call site. `meta` never crosses into the sandbox. This file asserts the two AGREE
rather than asserting each exists: two routes to one fact is the #214 defect class, and the
failure mode is a store whose stamped space quietly diverges from the row's.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("bnd-decl")
    root = XF.stage_bundle(out, boundaries=XF.PRIME_STAGED_BOUNDARIES)
    outputs = out / "outputs"
    outputs.mkdir()
    module, entries = XF.run_over(root, outputs)
    return {"module": module, "entries": entries, "outputs": outputs}


def test_the_boundaries_declare_the_same_space_as_the_coordinates(run):
    """TEST-12 — same space id, same unit, same affine. Not "a" space: THE space."""
    coords = XF.entry(run["entries"], "spatial-coordinates")["meta"]
    bounds = XF.entry(run["entries"], "spatial-boundaries")["meta"]
    for key in ("coordinate_space", "unit", "to_space"):
        assert bounds[key] == coords[key], (
            f"the boundaries declare {key}={bounds.get(key)!r} while the coordinates from "
            f"the same run declare {coords.get(key)!r}. Two frames means the polygons and "
            "the centroids describe different tissue."
        )
    assert bounds["unit"] == "micrometre"
    assert bounds["to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], (
        "Xenium coordinates are already micrometres with an identity affine (#162); a "
        "non-identity affine here would move the polygons off the cells"
    )
    assert "microns_per_pixel" not in bounds, (
        "a micrometre space must not state a pixel scale — a consumer would apply it twice"
    )


def test_the_declaration_is_readable_out_of_the_stores_own_bytes(run):
    """TEST-12 — #211's channel, and the sandboxed consumer's only one.

    `require_spatial_declarations` REFUSES rather than defaulting, so this is a real read.
    """
    SD = sys.modules["spatial_declarations"]
    store = run["outputs"] / "spatial" / "boundaries.zarr"
    assert store.is_dir(), "no boundaries store was written"
    block = SD.require_spatial_declarations(store, consumer="test_boundaries_declarations")
    meta = XF.entry(run["entries"], "spatial-boundaries")["meta"]
    assert block["declares"] == SD.SPATIAL_DECLARATION_TOKEN
    # The block is FLAT — the space's own keys at top level — which is the shape
    # `_validated_declaration_block` rebuilds and refuses anything else. A nested
    # `{"coordinate_space": {...}}` would carry no `unit` and no affine where a consumer
    # looks for them, and the writer refuses it at write time rather than minting an
    # artifact every reader would then refuse forever.
    for key in ("coordinate_space", "unit", "to_space"):
        assert block[key] == meta[key], (
            f"{key} differs between the store copy a SANDBOXED consumer reads and the "
            "catalog row the UI reads"
        )
    assert SD.require_micron_scale(block, consumer="a geometry consumer") == 1.0, (
        "a micrometre space must answer 1.0 BY DEFINITION, from the declared unit"
    )
    assert block["section"] == meta["section"], (
        "the store's stamped section and the manifest row's disagree — the two routes to "
        "one fact have already diverged"
    )
    # `positioning` IS DELIBERATELY ABSENT, for the same reason as `measured_entity` and by
    # the same argument — which the first cut applied to one and not the other. §15.3 defines
    # `partial` as "not every entity has a position", and the value that used to be copied
    # here was built from "Every cell in the matrix has a centroid": a claim about CENTROIDS.
    # A consumer reading `partial: false` off a BOUNDARIES store is told every entity has a
    # POLYGON, which `n_entities_without_boundary > 0` directly contradicts — and
    # `require_full_positioning` REFUSES on partial, so the false value is the one that
    # silently passes.
    assert "positioning" not in block, (
        f"the boundaries store declares positioning={block.get('positioning')!r}, a per-cell "
        "claim about centroids stamped on a vertex-axis artifact"
    )
    assert "positioning" not in meta
    # `measured_entity` is DELIBERATELY ABSENT. Design §15.1 defines that field as "what one
    # row IS", and one row here is a VERTEX — copying the coordinates' `cell` onto a
    # vertex-axis table states something false, and §15.1 says the UI label derives from it.
    # A blind design-conformance angle found the first cut doing exactly that.
    assert "measured_entity" not in block, (
        "the boundaries store declares a measured entity; one row of it is a vertex, not an "
        "entity, and `_validated_declaration_block` does not invent an absent sub-block"
    )
    assert "measured_entity_label" not in meta


def test_the_polygons_are_CHECKED_against_the_centroids_they_share_a_space_with(run):
    """TEST-4 [covers: ITEM-5] (#247). Design §7.3's silent failure mode, measured and reported.

    *"Getting the affine wrong does not error; it draws spots in the wrong place."* The
    sibling `emit_image` is handed `coverage_bounds` from the just-written coordinates and
    produces a `coverage_note`; the first cut of this producer stamped the coordinates' space
    onto the polygons with no check at all.

    A NOTE, not a refusal, and — since #247 — no VERDICT either: the emitted block carries the
    two facts the artifact supports plus the raw ratios, and the `consistent` boolean (whose
    5x scale band this importer had invented) is asserted ABSENT from both the artifact `meta`
    and the report a consumer reads. The placement judgement belongs to §7.5's registration
    overlay, which compares against an external referent — #156 built that overlay for
    `spatial-import-visium` only, which is why #291 recorded that nothing downstream judged
    THIS producer's placement, and #301 built one here, so the overlay now judges THIS
    producer's placement too.

    THE COVERAGE BLOCK ASSERTED HERE IS STILL FACTS-ONLY, and the reason is unchanged by
    that: this block has the artifact's own extents and nothing else, so a verdict from it
    would be a producer-side ruling however the tree's other checks have moved. What HAS
    changed is that it is no longer the whole of what Xenium boundary placement is checked
    by — the overlay in `report/qc` is the other half, and `test_registration_qc.py` is where
    that half is asserted.
    """
    meta = XF.entry(run["entries"], "spatial-boundaries")["meta"]
    coverage = meta["boundary_coverage"]
    assert set(coverage) == {"vertex_bbox", "centroid_bbox", "overlaps", "centroids_contained",
                             "extent_ratios", "note"}, (
        f"the emitted coverage block carries {sorted(coverage)} — a producer-side placement "
        "verdict is back in the artifact's meta (#247)"
    )
    assert set(coverage["vertex_bbox"]) == {"x_min", "x_max", "y_min", "y_max"}
    assert set(coverage["centroid_bbox"]) == {"x_min", "x_max", "y_min", "y_max"}
    # THE COMMITTED FIXTURE IS DELIBERATELY NOT CO-LOCATED — its polygons are real vendor
    # vertices from a DIFFERENT bundle keyed to this bundle's cell ids (see
    # `fixtures/boundaries/build_boundaries_fixtures.py`, "What is NOT done to the values").
    # So both FACTS must be False here, and asserting THAT turns a documented limitation of
    # the fixture into a tested fact instead of a paragraph nobody re-reads. It is strictly
    # stronger than the `consistent is False` it replaces: that boolean was also False for a
    # merely-large ratio, while these two say the extents are apart.
    assert coverage["overlaps"] is False, (
        "the staged fixture's polygons now look co-located with its centroids — either the "
        "fixture became co-located (good, but the builder's own docstring says otherwise) or "
        "the coverage check has stopped measuring anything"
    )
    assert coverage["centroids_contained"] is False, (
        "extents that do not overlap cannot contain one another; a True here means the two "
        "facts are no longer derived from the same boxes"
    )
    # The RAW ratios, unjudged — the number #247 keeps so a reader can judge for themselves.
    assert coverage["extent_ratios"] == [15.5584, 77.7247], (
        f"the extents moved: {coverage['extent_ratios']}. Either the fixture changed or the "
        "ratio is no longer vertex-span over centroid-span per axis."
    )
    assert "§7.3" in coverage["note"]
    report = json.loads((run["outputs"] / "xenium-import-report.json").read_text())
    assert report["boundaries"]["coverage"] == coverage


def test_the_HTML_summary_surfaces_the_boundaries_note_FROM_THE_FACTS(run):
    """TEST-5 [acceptance] [invariant: INV-3] [covers: ITEM-3, ITEM-6] (#247).

    The renderer used to decide by reading `coverage["consistent"] is False` — a derived
    heuristic, part of it an invented 5x band, shown to a user as though it were a declared
    property. It now reads the FACTS, with one exemption that comes straight from §15.3:
    *"Declare it rather than leaving a reader to infer it from nulls."* A partial polygon set
    is DECLARED partial (`n_entities_without_boundary`), and such a set is not expected to
    contain its own centroid extent — so a containment failure there is expected, not
    reportable, and the declaration is what says so.

    Every input below carries NO verdict key at all, so a renderer that reverted to reading
    one would render nothing and fail the first case rather than passing vacuously.
    """
    XI = run["module"]
    base = json.loads((run["outputs"] / "xenium-import-report.json").read_text())
    apart = base["boundaries"]["coverage"]
    assert "consistent" not in apart

    def render(drop=None, **boundaries):
        report = dict(base)
        report["boundaries"] = {**base["boundaries"], **boundaries}
        report["boundaries"].pop(drop, None)
        # THE VISIBLE PAGE ONLY. The whole report is also embedded verbatim in the
        # `application/json` script tag the inspector reads, so every note string is present
        # in the raw HTML whatever the renderer decides — asserting over the full document
        # would pass with this block deleted.
        return XI.render_report_html(report).split("<script", 1)[0]

    contained_false = {**apart, "overlaps": True, "note": "CENTROIDS OUTSIDE (§7.3)"}
    no_overlap = {**apart, "note": "NO OVERLAP AT ALL (§7.3)"}
    benign = {**apart, "overlaps": True, "centroids_contained": True,
              "note": "the centroid extent lies inside the polygon extent"}

    # 1. no overlap at all — the run's own coverage, unmodified. (The positive control: the
    # section renders at all, so "absent" below means "not reported", not "never rendered".)
    html = render()
    assert "<h3>Segmentation boundaries</h3>" in html and "DOES NOT OVERLAP" in html.upper()
    # AND THE MEASUREMENT IS ON THE PAGE, ATTRIBUTED TO ITS AXIS. The note says a reader can
    # judge the ratio; until the ratios were rendered the number existed only inside the
    # embedded JSON payload, and a positional rendering of it put y's number where a reader
    # reads x (the two differ here, so the whole line is pinned, not the two substrings).
    assert ("measured extents — polygon extent / centroid extent: x 15.5584x, y 77.7247x"
            in html), (
        "the visible summary does not show the extent ratios its own note points a reader "
        f"at, or shows them unattributed: {html}"
    )
    # 2. contained: False on a COMPLETE polygon set — reportable.
    html = render(coverage=contained_false, n_entities_without_boundary=0)
    assert "CENTROIDS OUTSIDE" in html
    # 3. the SAME coverage on a DECLARED-PARTIAL set — expected, and therefore silent.
    html = render(coverage=contained_false, n_entities_without_boundary=7)
    assert "CENTROIDS OUTSIDE" not in html and "Segmentation boundaries" not in html, (
        "a declared-partial polygon set is not expected to contain its centroid extent "
        "(§15.3); reporting it is a false alarm on a legitimate import"
    )
    # 3b. UNKNOWN IS NOT COMPLETE. A report carrying no count at all must not have the
    # containment failure read as a defect — §15.3's rule is that a reader does not infer a
    # declared state from a null, and `require_full_positioning` takes the same position.
    html = render(coverage=contained_false, drop="n_entities_without_boundary")
    assert "Segmentation boundaries" not in html, (
        "an ABSENT partial count was defaulted to zero, so an unknown state was reported as "
        "a complete one"
    )
    # 3c. BUT A NON-OVERLAP IS LOUD WHATEVER THE COUNT SAYS: no number of missing polygons
    # explains two extents that do not intersect at all. This is the one input where the
    # renderer's `overlaps` leg is load-bearing — with it deleted, the containment leg is
    # suppressed by the partial count and nothing renders. (The PRODUCER half of the same
    # case — which note a disjoint partial pair gets — is TEST-3's `partial-AND-disjoint`;
    # this case injects its note, so it cannot stand in for that one.)
    for count in (7, None):
        html = render(coverage=no_overlap,
                      **({"drop": "n_entities_without_boundary"} if count is None
                         else {"n_entities_without_boundary": count}))
        assert "NO OVERLAP AT ALL" in html, (
            f"a wholly disjoint extent pair went unreported at n_without={count}"
        )
    # 4. a correctly placed segmentation says nothing at all.
    html = render(coverage=benign, n_entities_without_boundary=0)
    assert "Segmentation boundaries" not in html
    # 4a. A REPORTABLE PAIR WITH NO DEFINED RATIO renders its note and NO measurement line —
    # the guard exists so the summary never prints "measured extents — …:" with nothing after
    # it, which is what a degenerate centroid extent on a disjoint pair produces.
    html = render(coverage={**no_overlap, "extent_ratios": [None, None]},
                  n_entities_without_boundary=0)
    assert "NO OVERLAP AT ALL" in html and "measured extents" not in html
    # 4a-ii. AND ONE DEFINED AXIS IS SHOWN AS ONE DEFINED AXIS, not silently promoted.
    html = render(coverage={**no_overlap, "extent_ratios": [None, 4.0]},
                  n_entities_without_boundary=0)
    assert "x undefined, y 4.0x" in html, (
        f"an axis with no defined ratio is not reported as undefined: {html}"
    )
    # 4a-iii. A RATIO LIST THAT IS NOT A PAIR IS NOT SHOWN. An artifact written before the
    # undefined slot existed carries one ratio for a degenerate axis and nothing says which;
    # labelling it "x" would state a falsehood. A malformed field must likewise not crash the
    # summary a user is trying to read.
    for shape in ([4.0], [1.0, 2.0, 3.0], 5.0, "1.0", {"x": 1.0}, None):
        html = render(coverage={**no_overlap, "extent_ratios": shape},
                      n_entities_without_boundary=0)
        assert "NO OVERLAP AT ALL" in html and "measured extents" not in html, (
            f"extent_ratios={shape!r} was rendered as an axis-attributed measurement"
        )
    # 4a-iv. AND A COVERAGE DICT WITH NO NOTE COSTS THE SECTION, NOT THE WHOLE PAGE.
    # THE THIRD SHAPE IS THE ONE A PRESENCE TEST WOULD MISS. `if "note" in coverage:` passes
    # for a note that is PRESENT and falsy, and then renders the literal `None` as the
    # statement with the measurement beside it — the same failure, from the same stored-report
    # provenance, that this guard exists to stop.
    for shape in ({"overlaps": False},
                  {"overlaps": False, "extent_ratios": [1.0, 2.0]},
                  {"overlaps": False, "note": None, "extent_ratios": [1.0, 2.0]},
                  {"overlaps": False, "note": "", "extent_ratios": [1.0, 2.0]}):
        html = render(coverage=shape, n_entities_without_boundary=0)
        assert "Xenium import summary" in html, "a missing note cost the whole summary"
        assert "Segmentation boundaries" not in html, (
            "the measurement is shown under the boundaries heading with no statement beside "
            f"it — the §7.3 failure is dropped and its number displayed: {html}"
        )
    # 4b. NOR DOES A LARGE RATIO ON A CONTAINED PAIR — the renderer must not re-acquire the
    # scale band the producer just lost. (Case 4 alone would catch this only by accident, and
    # only while the committed fixture's own ratios happen to be large.)
    html = render(coverage={**benign, "extent_ratios": [1000.0, 1000.0]},
                  n_entities_without_boundary=0)
    assert "Segmentation boundaries" not in html, (
        "a ratio is deciding what a human is shown — the band moved into the renderer"
    )
    # 5. and a REFUSAL reason still gets its section, whatever the coverage facts say.
    html = render(coverage=benign, n_entities_without_boundary=0, reason="boundaries refused")
    assert "boundaries refused" in html


def test_NO_CONSUMER_IS_LEFT_EXPECTING_the_removed_verdict_key(run):
    """TEST-6 [covers: ITEM-7] (#247). A removal that leaves a reader expecting the key is worse
    than the invented constant.

    Every emitted surface is swept for a `consistent` KEY — the artifact metas, the JSON report
    a machine reads, and the JSON payload embedded in the HTML summary the inspector reads.
    (The substring alone would not do: `scale_referent.does_not_close` legitimately says
    "internally consistent" in prose, which is a sentence, not a property.)
    """
    def keys_named(node, name, path="$"):
        found = []
        if isinstance(node, dict):
            for k, v in node.items():
                if k == name:
                    found.append(f"{path}.{k}")
                found += keys_named(v, name, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                found += keys_named(v, name, f"{path}[{i}]")
        return found

    # THE SWEEP'S OWN POSITIVE CONTROL: a recursion that stopped working would make all three
    # "absent" assertions below pass vacuously.
    assert keys_named({"a": [{"consistent": 1}], "b": {"c": {"consistent": 2}}},
                      "consistent") == ["$.a[0].consistent", "$.b.c.consistent"], (
        "the key sweep does not find a key that IS present, so its three absences prove "
        "nothing"
    )
    for entry in run["entries"]:
        assert keys_named(entry, "consistent") == [], (
            f"manifest entry {entry.get('id')} still carries a placement verdict"
        )
    report = json.loads((run["outputs"] / "xenium-import-report.json").read_text())
    assert keys_named(report, "consistent") == []

    html = (run["outputs"] / "xenium-import-summary.html").read_text()
    payload = html.split("id='xenium-import-summary'>")[1].rsplit("</script>", 1)[0]
    assert keys_named(json.loads(payload.replace("\\u003c", "<")), "consistent") == []


def test_the_offset_columns_are_stamped_with_the_cells_axis_alignment(run):
    """The offsets are per-CELL, so they carry the cells axis's own digest."""
    coords = XF.entry(run["entries"], "spatial-coordinates")
    for name in ("boundary_vertex_start", "boundary_vertex_count"):
        col = XF.entry(run["entries"], f"metadata-column:{name}")
        assert col["axis"] == "cells"
        assert col["structure"]["axis"] == "cells"
        assert col["structure"]["aligned_to"] == coords["structure"]["aligned_to"], (
            f"{name} is aligned to a different row space than the tissue map it indexes"
        )
        assert col["meta"]["describes"] == "spatial/boundaries"
        # `column_role`, not `role`: that key already carries two vocabularies.
        assert col["meta"]["column_role"] == "boundary-offsets"
        assert "role" not in col["meta"]


def test_the_vertex_table_does_not_claim_a_per_cell_alignment(run):
    """`aligned_to` names the row space a column LINES UP WITH; these rows are vertices.

    Stamping the cells digest on the vertex table would claim a per-cell alignment it does
    not have — one row per vertex is not one row per cell — and every consumer that trusts
    `aligned_to` would then join it wrongly.
    """
    b = XF.entry(run["entries"], "spatial-boundaries")
    assert b["structure"]["axis"] == "vertex"
    assert "aligned_to" not in b["structure"], (
        f"the vertex table declares aligned_to={b['structure'].get('aligned_to')!r}"
    )
    assert b["axis"] == "vertex"
