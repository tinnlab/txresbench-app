#!/usr/bin/env python3
# ruff: noqa
"""The coordinate-space declaration: what one row IS, and how big a pixel is.

Two invariants live here. `measured_entity` (INV-4) is entity IDENTITY and is
unrecoverable from the bytes once artifacts exist. The micron scale (INV-6) is the one
number that turns a picture into a measurement — and the one a producer is most tempted
to invent.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


@pytest.fixture(scope="module")
def coord_meta(tmp_path_factory):
    out = tmp_path_factory.mktemp("visium-space")
    _module, entries = VF.run_over(VF.FIXTURE, out)
    return VF.entry_by_id(entries, "spatial-coordinates")["meta"]


# ── TEST-4: a spot is not a cell ─────────────────────────────────────────────────────


def test_one_row_is_declared_a_spot_with_its_resolution(coord_meta):
    """TEST-4 [acceptance] [invariant: INV-4] — `measured_entity`, stamped at write time.

    A Visium spot holds 1-10 cells. Calling it a `cell` is a SCIENTIFIC error, not a
    naming one, and the design's fix is to record what one row is rather than to rename
    the axis (`cells` is reused deliberately, so that every existing analysis keeps
    working).
    """
    assert coord_meta["measured_entity"] == {
        "kind": "spot", "platform": "visium", "resolution_um": 55.0
    }
    assert coord_meta["measured_entity_label"] == "55 µm spot · visium"
    assert coord_meta["positioning"] == {"partial": False}
    assert set(coord_meta["section"]) == {"sample_id", "index"}
    assert coord_meta["section"]["sample_id"] == VF.FIXTURE_LIBRARY_ID


def test_declaring_a_visium_row_as_a_cell_is_unreachable():
    """TEST-4 (cont.) — the design's promise, not the code's behaviour.

    Asserting only that THIS importer says `spot` would leave `cell` one edit away. The
    stronger, checkable statement is that the write-time contract makes the wrong answer
    unreachable for an assay like this one: a segmented entity must declare the
    segmentation that produced it, and an unsegmented capture-spot assay has none to give.
    """
    module = VF.load_compute()
    SD = module.SD
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.measured_entity(kind="cell", platform="visium")
    assert "segmentation" in str(exc.value)
    with pytest.raises(SD.SpatialDeclarationError):
        SD.measured_entity(kind="spot", platform="visium")  # no resolution_um
    with pytest.raises(SD.SpatialDeclarationError):
        SD.measured_entity(kind="voxel", platform="visium", resolution_um=55)


def test_the_space_id_is_derived_from_the_vendor_library_id_and_is_stable(tmp_path):
    """The space id is a CONVENTION, so producer discipline is the whole mechanism.

    Two imports of ONE slide must land in ONE frame, or a second image and a second
    section have nothing to place themselves against. A minted id would make every import
    a new, unrelatable frame — and nothing downstream could tell.
    """
    first = tmp_path / "a"
    second = tmp_path / "b"
    _m, entries_a = VF.run_over(VF.FIXTURE, first)
    _m, entries_b = VF.run_over(VF.FIXTURE, second)
    a = VF.entry_by_id(entries_a, "spatial-coordinates")["meta"]
    b = VF.entry_by_id(entries_b, "spatial-coordinates")["meta"]
    assert a["coordinate_space"] == b["coordinate_space"] == f"visium:{VF.FIXTURE_LIBRARY_ID}"
    assert a["coordinate_space_source"] == "library_id"


def test_the_fallback_space_id_is_derived_too_and_is_never_minted(tmp_path):
    """The leg reached when the matrix declares no library id — which had no test at all.

    Making the fallback mint a fresh UUID per import passed the whole suite, and that is the
    outcome the design names by hand: *"a minted id would make every import a new,
    unrelatable frame — and nothing downstream could tell."* Two imports of ONE bundle must
    agree, and the id must be DERIVED from something the bundle carries.

    ## WHAT #327 CHANGED HERE, and what it deliberately did not

    The claim — DERIVED, never minted, two imports of one bundle agreeing — is unchanged and is
    still the first two assertions. WHAT it is derived FROM moved: it was
    `Path(bundle_root).name`, the sandbox MOUNT name, which is plausibly the constant `bundle`
    for every artifact-backed Visium import in a deployment and is `outs` for every user upload
    that kept Space Ranger's own directory name. So two UNRELATED bundles were landing in ONE
    frame, which is the defect this test's own last assertion was written to forbid and could
    not see, because the fixture renamed the two directories apart by hand.

    It is now a digest of the run's own measurement, and this test is correspondingly
    STRENGTHENED rather than merely re-pointed: the two directories are given the SAME name, so
    a fallback that still read the mount would go red here, and the id is asserted not to
    contain it at all.
    """
    import h5py

    module = VF.load_compute()
    # BOTH bundles are called `outs`, which is what `make_variant`'s callers used to rename apart:
    # the id under test must not be a function of the directory, so the fixture stops helping it.
    bundle = VF.make_variant(tmp_path / "a").rename(tmp_path / "a" / "outs")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as f:
        del f.attrs["library_ids"]

    metas = []
    for run in ("a", "b"):
        _m, entries = VF.run_over(bundle, tmp_path / f"out-{run}")
        metas.append(VF.entry_by_id(entries, "spatial-coordinates")["meta"])

    assert metas[0]["coordinate_space"] == metas[1]["coordinate_space"], (
        "two imports of ONE bundle landed in two different frames — the id is minted, not "
        "derived, so a second image and a second section have nothing to place themselves "
        "against"
    )
    assert metas[0]["coordinate_space_source"] == module.NO_VENDOR_SPACE_SOURCE
    assert metas[0]["coordinate_space"].startswith(
        f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), (
        "the fallback must SAY it is unverified, in its own value, in a namespace no vendor "
        f"string can occupy: {metas[0]['coordinate_space']}")
    assert "outs" not in metas[0]["coordinate_space"], (
        "the frame id still carries the bundle directory's name — a run's coordinate identity "
        "must not be a function of where it happened to be mounted (#327)")

    # …and it is a DIFFERENT frame from another, UNRELATED bundle's — measured with the two
    # directories deliberately identically named, which is the case `visium:outs` collided on.
    other = VF.stage_bundle(tmp_path / "b")
    VF.set_library_id(other, None)
    VF.restage_barcodes(other, "-OTHER")
    _m, other_entries = VF.run_over(other, tmp_path / "out-other")
    assert (VF.entry_by_id(other_entries, "spatial-coordinates")["meta"]["coordinate_space"]
            != metas[0]["coordinate_space"])


# ── TEST-6: never fabricate a scale ──────────────────────────────────────────────────


def test_a_vendor_stated_micron_scale_is_used_verbatim(tmp_path):
    """TEST-6 leg (a) [acceptance] [invariant: INV-6] — the vendor states it."""
    stated = dict(VF.scalefactors())
    stated["microns_per_pixel"] = 0.5041
    bundle = VF.make_variant(tmp_path, scalefactors_text=json.dumps(stated))
    _m, entries = VF.run_over(bundle, tmp_path / "out")
    meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert meta["microns_per_pixel"] == 0.5041
    assert meta["microns_per_pixel_source"] == "vendor"


def test_a_missing_micron_scale_is_derived_from_the_vendor_number_and_its_circle(coord_meta):
    """TEST-6 leg (b) [acceptance] [invariant: INV-6] — the REAL, common case.

    Measured, not assumed: no standard Visium bundle observed (Space Ranger 1.1.0, 1.3.0,
    2.0.0) ships `microns_per_pixel` — the field is a Visium HD / newer-Space-Ranger
    addition. The derivation is the vendor's own measurement, in pixels, of a circle, over
    the physical size of THAT circle. Since #222 the numerator is
    `VISIUM_RENDERED_SPOT_DIAMETER_UM` — a repo constant, cited to Seurat and CellChat and
    corroborated by this bundle's own two files, and NOT a vendor-stated number, which is why
    this docstring no longer says "two vendor-stated numbers". The leg used is RECORDED, so a
    stated number and a derived one stay distinguishable.
    """
    scalefactors = VF.scalefactors()
    assert "microns_per_pixel" not in scalefactors, (
        "the fixture now states a scale, so this leg no longer exercises the derivation"
    )
    assert coord_meta["microns_per_pixel_source"] == "derived-from-spot-diameter", (
        "the leg used must be RECORDED — it is the only thing that keeps a vendor-stated "
        "number and a producer-derived one distinguishable downstream"
    )
    assert coord_meta["spot_diameter_fullres"] == scalefactors["spot_diameter_fullres"]
    # THIS ASSERTION USED TO BE THE #222 DEFECT, WRITTEN DOWN. It read
    # `microns_per_pixel == resolution_um / spot_diameter_fullres`, reading `resolution_um`
    # off the artifact so as not to re-spell the importer's arithmetic — and in doing so it
    # pinned the one thing that was wrong: that the scale's numerator and the declared
    # capture resolution are the same number. They are not. See TEST-1 below, which asserts
    # the SPLIT rather than the conflation.
    #
    # What survives here unchanged is the part that never depended on which constant is
    # right: a sanity check on the number itself. A Visium capture area is 6.5 mm across, so
    # a plausible full-resolution image is a few thousand pixels wide at sub-micron
    # resolution. A scale of 1.0 (the fabrication this rule forbids) would put the capture
    # area at ~10 metres.
    assert 0.1 < coord_meta["microns_per_pixel"] < 5.0


def test_a_vendor_scale_that_DISAGREES_with_the_derivation_still_wins(tmp_path):
    """Leg 1 beats leg 2 — asserted where the two answers DIFFER.

    The vendor-stated test above uses a value close to nothing in particular, so it cannot
    tell "the vendor's number was used" from "the derivation happened to agree". Here the
    stated number is deliberately far from what the spot diameter would give, so only one of
    the two can be the answer.
    """
    module = VF.load_compute()
    scalefactors = dict(VF.scalefactors())
    derived = (module.VISIUM_RENDERED_SPOT_DIAMETER_UM
               / float(scalefactors["spot_diameter_fullres"]))
    stated = derived * 4.0
    scalefactors["microns_per_pixel"] = stated
    bundle = VF.make_variant(tmp_path, scalefactors_text=json.dumps(scalefactors))
    _m, entries = VF.run_over(bundle, tmp_path / "out")
    meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert meta["microns_per_pixel"] == pytest.approx(stated)
    assert meta["microns_per_pixel"] != pytest.approx(derived)
    assert meta["microns_per_pixel_source"] == "vendor"


def test_a_consumer_can_tell_a_DERIVED_scale_from_a_STATED_one(tmp_path):
    """The property the whole `microns_per_pixel_source` field exists for.

    `require_micron_scale` reads the scale and nothing else, so on its own it cannot tell a
    measured number from a derived one — which is a real limitation of the shared contract
    (recorded for the owner). What this importer CAN guarantee is that the distinction is
    present in the same mapping a consumer is handed, so a consumer that cares is able to
    ask. This asserts that it is, on both legs.
    """
    stated = dict(VF.scalefactors())
    stated["microns_per_pixel"] = 0.5041
    vendor_bundle = VF.make_variant(tmp_path / "v", scalefactors_text=json.dumps(stated))
    _m, vendor_entries = VF.run_over(vendor_bundle, tmp_path / "out-v")
    _m, derived_entries = VF.run_over(VF.FIXTURE, tmp_path / "out-d")

    vendor_meta = VF.entry_by_id(vendor_entries, "spatial-coordinates")["meta"]
    derived_meta = VF.entry_by_id(derived_entries, "spatial-coordinates")["meta"]
    assert vendor_meta["microns_per_pixel_source"] != derived_meta["microns_per_pixel_source"]
    for meta in (vendor_meta, derived_meta):
        # The marker rides in the SAME dict as the scale, which is the dict a consumer passes
        # to `require_micron_scale` — so the distinction is reachable at the point of use and
        # not stranded in a different channel.
        module = VF.load_compute()
        assert module.SD.require_micron_scale(meta, consumer="t") == meta["microns_per_pixel"]
        assert meta["microns_per_pixel_source"] in ("vendor", "derived-from-spot-diameter")


def test_an_unreadable_scalefactors_file_declares_no_scale_and_a_consumer_refuses(tmp_path):
    """TEST-6 leg (c) [acceptance] [invariant: INV-6] — absence stays absence.

    The import still SUCCEEDS: the coordinates are correct in pixels and the bundle is
    still worth having. What it must not do is answer the micron question anyway. The
    proof is on the CONSUMER side, because that is where the fabrication would do its
    damage — `require_micron_scale` is the call a neighbour-graph radius makes, and it
    must raise rather than return 1.0.
    """
    bundle = VF.make_variant(tmp_path, drop_scalefactors=True)
    module, entries = VF.run_over(bundle, tmp_path / "out")
    meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]

    assert "microns_per_pixel" not in meta, (
        "a bundle with no readable scale declared one anyway — a fabricated scale is "
        "indistinguishable from a measured one downstream"
    )
    assert meta["microns_per_pixel_source"] == "unavailable"
    assert meta["unit"] == "pixel"

    with pytest.raises(module.SD.SpatialDeclarationError) as exc:
        module.SD.require_micron_scale(meta, consumer="spatial.neighbours")
    assert "1.0" in str(exc.value) or "assuming" in str(exc.value)

    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert "scale_note" in report, (
        "the report must SAY the scale is absent; a silently missing scale is how a user "
        "finds out three analyses later that nothing can measure a distance"
    )
    assert "microns_per_pixel" not in report


def test_a_scale_of_zero_or_a_string_is_refused_rather_than_believed(tmp_path):
    """The vendor field is data from a file, so it is treated as untrusted.

    A `0` or a `"0.5"` would each be believed by a naive `if key in doc` read; the first
    makes every micron distance infinite, the second raises somewhere far away. Both fall
    through to the derivation, which is a number this importer can stand behind.
    """
    for bad in (0, -1, "0.5", True, None):
        stated = dict(VF.scalefactors())
        stated["microns_per_pixel"] = bad
        bundle = VF.make_variant(tmp_path / f"v{bad!r}", scalefactors_text=json.dumps(stated))
        _m, entries = VF.run_over(bundle, tmp_path / f"o{bad!r}")
        meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
        assert meta["microns_per_pixel_source"] == "derived-from-spot-diameter", (
            f"microns_per_pixel={bad!r} was taken as a stated scale"
        )


# ── TEST-7 (#211) — the re-homing changed WHERE the value is built, not the row ──────


#: The coordinates entry's `meta` top-level keys, stated EXHAUSTIVELY rather than as a
#: subset. A subset check (`expected <= actual`) would pass if the re-homing had dropped
#: nothing and ADDED something, and a `>=` check would pass if it had dropped a key the
#: client reads. The catalog row is a shipped contract — the UI's Coordinates picker reads
#: `component_columns`, the methods narrator reads `provenance` — so the assertion that
#: matters is equality.
EXPECTED_COORDINATES_META_KEYS = {
    # from `cyto_columns.write_embedding`
    "name", "kind", "axis", "n", "n_dims",
    # from `coordinate_space()` — the two `*_source` keys moved INTO this block (#211)
    "coordinate_space", "unit", "to_space", "microns_per_pixel",
    "microns_per_pixel_source", "coordinate_space_source",
    # the rest of `coordinates_meta()`
    "measured_entity", "measured_entity_label", "positioning", "section",
    # the producer's own catalog/display facts, which stay in `meta` only
    "platform", "provenance", "component_columns", "spot_diameter_fullres",
}


def test_the_emitted_catalog_row_is_unchanged_by_the_provenance_re_homing(coord_meta):
    """TEST-7 — ITEM-5 moved where the value is BUILT, not where it is READ.

    `microns_per_pixel_source` and `coordinate_space_source` used to be assigned onto
    `meta` after `write_spatial_coordinates` returned. They are now declared inside
    `coordinate_space(...)`, which `coordinates_meta` merges FLAT into the same `meta` —
    so the emitted row must be identical key-for-key. If it is not, the re-homing silently
    changed a shipped contract while making a sandboxed consumer happy, which is a worse
    trade than the one it was making.
    """
    assert set(coord_meta) == EXPECTED_COORDINATES_META_KEYS, (
        "added: " + repr(sorted(set(coord_meta) - EXPECTED_COORDINATES_META_KEYS))
        + "  dropped: " + repr(sorted(EXPECTED_COORDINATES_META_KEYS - set(coord_meta)))
    )
    # and the values are the real derivation's, not a placeholder that happens to be a str
    assert coord_meta["microns_per_pixel_source"]
    assert coord_meta["coordinate_space_source"]
    assert isinstance(coord_meta["microns_per_pixel"], float)


def test_no_declaration_key_is_in_the_catalog_row_and_missing_from_the_store_block(
        coord_meta, tmp_path_factory):
    """TEST-7 (cont.) — the direction a store-side loop cannot see.

    The xenium suite grew this check first, and it belongs HERE more: Visium is the
    importer that actually runs `coord_meta.update({...})` after the writer returns, so
    it is the one where the divergence pattern is live. A loop over the STORE copy is
    blind to a key present in `meta` and absent from the block — and `update` ADDS keys to
    `meta`, which is exactly that direction.

    The allow-list is the point of the test: every key in it is a deliberate producer-only
    catalog fact, so a NEW one is a decision somebody makes here rather than a divergence
    nobody notices.
    """
    import json as _json

    out = tmp_path_factory.mktemp("visium-leak")
    _module, entries = VF.run_over(VF.FIXTURE, out)
    entry = VF.entry_by_id(entries, "spatial-coordinates")
    block = _json.loads((out / entry["path"] / "zarr.json").read_text()
                        )["attributes"]["cyto"]["cyto_spatial"]
    shared = {k for k in block if k != "declares"}

    #: Producer-only, and each for a stated reason. `platform` duplicates
    #: `measured_entity.platform`, which DOES reach; `provenance` is the vendor-pipeline
    #: attestation the methods narrator reads; `component_columns` is #183's declaration
    #: for the client's Coordinates picker (and the only channel that survives a filter);
    #: `spot_diameter_fullres` is a vendor pixel span, while the physical size an analysis
    #: wants is `measured_entity.resolution_um`. The rest are the framework writer's own.
    PRODUCER_ONLY = {"name", "kind", "axis", "n", "n_dims",
                     "platform", "provenance", "component_columns",
                     "spot_diameter_fullres"}
    leaked = sorted(set(coord_meta) - shared - PRODUCER_ONLY)
    assert leaked == [], (
        f"{leaked} are in the catalog row and NOT in the store block, and are not declared "
        "producer-only facts — a sandboxed consumer and the UI now disagree about what "
        "this artifact declares"
    )
    # and the allow-list must not rot: every name in it is really in this row
    dead = sorted(PRODUCER_ONLY - set(coord_meta))
    assert dead == [], f"{dead} are allow-listed and not emitted — a dead exemption"


# ── TEST-14 (#211) — the mirror is the WRITER's property, not the producer's ─────────


def test_the_real_importer_gets_the_declarations_into_the_stores_bytes(tmp_path_factory):
    """TEST-14 — the shipped `spatial.import-visium` run, unmodified, mirrors the block.

    The issue rejected "have each producer stamp them" because *"it is opt-in, so a
    producer that forgets is silently unreadable — the same shape as the bug"*. This is the
    assertion that the accepted option is NOT that: the importer passes no new argument
    and asks for nothing, and the block is in its store anyway, because the enforced writer
    puts it there.
    """
    import json as _json

    out = tmp_path_factory.mktemp("visium-mirror")
    _module, entries = VF.run_over(VF.FIXTURE, out)
    entry = VF.entry_by_id(entries, "spatial-coordinates")
    store = out / entry["path"]

    stamped = _json.loads((store / "zarr.json").read_text())["attributes"]["cyto"]
    assert stamped == entry["structure"], "the store copy and the row copy disagree"

    SD = VF.load_compute().SD
    block = SD.require_spatial_declarations(store, consumer="a spatial analysis")
    assert block["declares"] == SD.SPATIAL_DECLARATION_TOKEN
    for key in ("coordinate_space", "unit", "to_space", "microns_per_pixel",
                "microns_per_pixel_source", "coordinate_space_source",
                "measured_entity", "measured_entity_label", "positioning", "section"):
        assert block[key] == entry["meta"][key], key

    # the importer's own source is not the place the mirror is requested from
    source = (VF.PKG / "compute" / "import_visium.py").read_text()
    assert "mirror_declarations_into_store" not in source, (
        "the importer calls the mirror itself, which makes it opt-in — the property this "
        "test exists to assert is that the WRITER does it for every producer"
    )


# ═════════════════════════════════════════════════════════════════════════════════════
# #222 — THE SPLIT. Two circles, two constants, and the assertion that keeps them apart.
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_capture_footprint_and_the_scale_numerator_are_two_different_constants(
    coord_meta,
):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-2, ITEM-3] — #222.

    ## What went wrong, in one line

    One constant named `VISIUM_SPOT_DIAMETER_UM` was used as BOTH the numerator of the
    micron scale AND the declared `measured_entity.resolution_um`. Those are two different
    circles: `spot_diameter_fullres` is the circle Space Ranger writes FOR RENDERING (65 um),
    and the capture footprint transcripts came from is 55 um. Dividing 55 by a measurement
    of the 65 um circle made every micron-denominated Visium result 15.4% LOW (1 - 55/65).
    (The issue headlines 15.6%; that is the old scale's error against the slide's 100 um pitch
    on the committed bundle — 15.573% — a bundle-specific number, not the constant's effect.)

    ## Why the last assertion is the whole test

    Asserting only "the scale is 65/diameter" would go green again the moment someone
    re-merged the two constants into one value of 65 — which would fix the scale and
    silently corrupt the declared resolution, the exact trap #222's ruling names. So the
    load-bearing assertion is the INEQUALITY: the scale is NOT the declared resolution over
    the same denominator. That is the statement that cannot be satisfied by any single
    constant, whichever value it takes.
    """
    module = VF.load_compute()
    scalefactors = VF.scalefactors()
    diameter_px = float(scalefactors["spot_diameter_fullres"])

    # 1. Two constants, distinctly named, and the ambiguous one is GONE — a missed call
    #    site is now a NameError at import rather than a silent 15.6% error.
    assert module.VISIUM_CAPTURE_SPOT_DIAMETER_UM == 55.0
    assert module.VISIUM_RENDERED_SPOT_DIAMETER_UM == 65.0
    assert not hasattr(module, "VISIUM_SPOT_DIAMETER_UM"), (
        "the ambiguous name is back; it is the name, not the value, that caused #222"
    )

    # 2. The capture footprint is what the artifact DECLARES as its resolution. Unchanged
    #    by #222, and it must stay unchanged: it is the area transcripts came from.
    resolution_um = coord_meta["measured_entity"]["resolution_um"]
    assert resolution_um == module.VISIUM_CAPTURE_SPOT_DIAMETER_UM == 55.0
    assert coord_meta["measured_entity_label"] == "55 µm spot · visium"

    # 3. The RENDERED circle is what the scale divides, because it is the circle
    #    `spot_diameter_fullres` measures.
    assert coord_meta["microns_per_pixel"] == pytest.approx(
        module.VISIUM_RENDERED_SPOT_DIAMETER_UM / diameter_px
    )

    # 4. THE ASSERTION THAT GOES RED IF ANYONE RE-MERGES THEM. Not a restatement of 2 and
    #    3: it fails for a single shared constant at 55.0 (the old defect), at 65.0 (the
    #    plausible over-correction that would corrupt `resolution_um`), and at any other
    #    value, because no single number can be both sides of it.
    assert coord_meta["microns_per_pixel"] != pytest.approx(resolution_um / diameter_px), (
        "the micron scale is once again the declared capture resolution over "
        "`spot_diameter_fullres` — the two constants have been re-merged and either the "
        "scale or the declared resolution is now wrong (#222)"
    )

    # 5. And the direction is the one #222 measured: the fix RAISED um/pixel by exactly
    #    65/55 = +18.18%, because the old numerator was too small (equivalently, the old
    #    value was 1 - 55/65 = 15.4% low). Stated as a ratio so the number is legible.
    assert coord_meta["microns_per_pixel"] / (resolution_um / diameter_px) == pytest.approx(
        65.0 / 55.0, rel=1e-9
    )
