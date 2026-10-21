#!/usr/bin/env python3
# ruff: noqa
"""The WRITE-TIME half of #152 — the four `[FIELD-NOW]` fields (#174) and #176's codec.

These are the assertions that would go red if the DESIGN's promise were violated, not
merely if the code changed. The distinction matters: a test written against the
implementation cannot fail on "implementation != design". So, for example, TEST-6 does not
assert that `measured_entity_label` returns a particular string — it asserts the PROPERTY
the field exists for: the label is a function of the declaration and not of the row count.
"""
import importlib.util
import inspect
import sys
from pathlib import Path

import numpy as np
import pytest

_PACKAGES = Path(__file__).resolve().parents[2]
_MODULE = _PACKAGES / "spatial-types" / "compute" / "spatial_declarations.py"


def _load_module():
    """Load the contract by PATH, the way the sandbox runner stages a compute entry.

    A dotted import is not available: the package directory is `spatial-types`, which is
    not an identifier — the same reason every other suite here loads its entry with
    importlib.
    """
    spec = importlib.util.spec_from_file_location("spatial_declarations", _MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules["spatial_declarations"] = module
    spec.loader.exec_module(module)
    return module


sd = _load_module()


# ── TEST-6 [acceptance] [invariant: INV-3] ───────────────────────────────────────────
def test_measured_entity_is_required_and_validated():
    """TEST-6 [acceptance] [invariant: INV-3] — the declaration is required and closed."""
    entity = sd.measured_entity(kind="bin", platform="visium-hd", resolution_um=8)
    assert entity == {"kind": "bin", "platform": "visium-hd", "resolution_um": 8.0}

    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="voxel", platform="visium-hd")
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="cell", platform="")
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="bin", platform="stereo-seq", resolution_um=0)
    # A PARTIAL segmentation block is refused: "cellpose, parameters unknown" reads as
    # recorded provenance while answering none of the questions provenance is for.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="cell", platform="xenium",
                           segmentation={"method": "xenium-expansion"})

    # The two cases §15.1 was actually written for. Leaving the sub-fields merely OPTIONAL
    # made the field satisfiable in exactly the situations it exists to fix: two Visium HD
    # bin sets declaring identically, and two Xenium expansions declaring identically AND
    # having equal row counts. Neither value is ever unknown at write time.
    with pytest.raises(sd.SpatialDeclarationError) as no_pitch:
        sd.measured_entity(kind="bin", platform="visium-hd")
    assert "resolution_um" in str(no_pitch.value)
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="spot", platform="visium")
    with pytest.raises(sd.SpatialDeclarationError) as no_seg:
        sd.measured_entity(kind="cell", platform="xenium")
    assert "segmentation" in str(no_seg.value)
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="nucleus", platform="visium-hd")

    # A bool is refused rather than coerced: `True` is a perfectly good `float(1.0)`, so a
    # typo'd flag would otherwise land as a 1 µm pitch — plausible and silently wrong.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="bin", platform="p", resolution_um=True)
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity(kind="bin", platform="p", resolution_um=float("inf"))


def test_the_label_derives_from_the_declaration_and_never_from_the_row_count():
    """TEST-6 [acceptance] [invariant: INV-3] — the promise, stated as two properties.

    Today a user tells an 8 µm bin set from a 16 µm one BY ROW COUNT, and cannot tell a
    5 µm-expansion cell set from a 15 µm one AT ALL (their row counts are equal). Both
    halves are asserted, using the real Visium HD row counts.
    """
    # 1. The row count CANNOT reach the label, asserted structurally rather than mimed.
    #    An earlier form of this test bound two Visium HD row counts to locals and then
    #    compared them to each other — the numbers were never passed to anything, so the
    #    "not from the row count" claim could not have failed however the function was
    #    written. The real property is that `n` is not an input at all.
    params = list(inspect.signature(sd.measured_entity_label).parameters)
    assert params == ["entity"], (
        f"the label takes {params}; it must take the DECLARATION and nothing else, or "
        "'derived from the declaration, never from the row count' is unenforceable"
    )
    eight_um = sd.measured_entity(kind="bin", platform="visium-hd", resolution_um=8)
    assert sd.measured_entity_label(eight_um) == sd.measured_entity_label(
        sd.measured_entity(kind="bin", platform="visium-hd", resolution_um=8)
    )

    # 2. The SAME row count, different declarations ⇒ DIFFERENT labels. This is the case
    #    that is unrecoverable from the bytes: a 5 µm and a 15 µm expansion produce the
    #    same number of cells and differ in every one of them.
    five = sd.measured_entity(
        kind="cell", platform="xenium",
        segmentation={"method": "xenium-expansion", "params": {"expansion_um": 5},
                      "software_version": "xenium-4.0.0.19"},
    )
    fifteen = sd.measured_entity(
        kind="cell", platform="xenium",
        segmentation={"method": "xenium-expansion", "params": {"expansion_um": 15},
                      "software_version": "xenium-4.0.0.19"},
    )
    assert sd.measured_entity_label(five) != sd.measured_entity_label(fifteen)

    # 3. And the resolution group is distinguishable without reading any row count.
    sixteen = sd.measured_entity(kind="bin", platform="visium-hd", resolution_um=16)
    assert sd.measured_entity_label(eight_um) != sd.measured_entity_label(sixteen)

    # 4. The SOFTWARE VERSION reaches the label too. §15.1's motivating case is "the exact
    #    change 10x made between analysis-software versions, which alters every cell in the
    #    dataset" — same method, same params, different version, different cells. A label
    #    that rendered only method+params would give those two artifacts one name, which is
    #    this field's failure mode reintroduced one level down.
    v2 = sd.measured_entity(
        kind="cell", platform="xenium",
        segmentation={"method": "cellpose", "params": {"diameter_um": 30},
                      "software_version": "xenium-2.0.0"},
    )
    v3 = sd.measured_entity(
        kind="cell", platform="xenium",
        segmentation={"method": "cellpose", "params": {"diameter_um": 30},
                      "software_version": "xenium-3.1.0"},
    )
    assert sd.measured_entity_label(v2) != sd.measured_entity_label(v3)

    # 4. There is no path that produces a label from nothing.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.measured_entity_label({})


# ── TEST-7 [acceptance] [invariant: INV-4] ───────────────────────────────────────────
def test_a_consumer_refuses_partial_positioning_rather_than_defaulting():
    """TEST-7 [acceptance] [invariant: INV-4] — absence is absence.

    Slide-tags positions only a subset of nuclei, and no platform guarantees every entity
    is placed. A consumer that cannot represent an absent position must REFUSE. Defaulting
    — a centroid, a zero, "the ones we have" — turns a stated gap into invented data that
    is indistinguishable from measurement downstream.
    """
    complete = sd.positioning(partial=False)
    sd.require_full_positioning(complete, consumer="neighbourhood-graph")  # no raise

    partial = sd.positioning(partial=True, confidence_column="pos_conf")
    with pytest.raises(sd.SpatialDeclarationError) as excinfo:
        sd.require_full_positioning(partial, consumer="neighbourhood-graph")
    message = str(excinfo.value)
    assert "neighbourhood-graph" in message and "pos_conf" in message

    # UNKNOWN is not COMPLETE: an artifact with no declaration at all is refused too,
    # rather than being read as "presumably fine".
    with pytest.raises(sd.SpatialDeclarationError):
        sd.require_full_positioning({}, consumer="neighbourhood-graph")

    # `partial` has no default and no truthy coercion — "1" is not a declaration.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.positioning(partial=1)


# ── TEST-8 [acceptance] [invariant: INV-2] ───────────────────────────────────────────
def _coords_kwargs():
    return {
        "axis": "cells",
        "space": sd.coordinate_space(
            space="V19L01-041-A1", unit="micrometre",
            to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        ),
        "entity": sd.measured_entity(kind="spot", platform="visium", resolution_um=55),
        "placement": sd.positioning(partial=False),
        # `section` is the fourth `[FIELD-NOW]` field and carries the SAME "free now,
        # unrecoverable later" rationale as the other three, so it is required rather than
        # being the one of the four a producer may silently skip.
        "series": sd.section(sample_id="donor-04-blockA", index=0),
    }


def test_a_three_component_coordinates_artifact_is_refused_at_write_time(tmp_path):
    """TEST-8 [acceptance] [invariant: INV-2] — the always-2-D writer rule, enforced.

    THE FAILURE MODE IS NOT AN ERROR — IT IS SILENT INVISIBILITY, which is why a rule
    without a test regresses into exactly the bug it prevents. The shipped Coordinates
    section selects `source: { capabilities: [plottable-xy], dims: 2 }` and the matcher
    compares the declared component count for EXACT EQUALITY, failing closed. An honest
    `(n x 3)` artifact — the natural encoding for Xenium/MERSCOPE/CosMx/STARmap — would
    therefore never appear in the UI, with no message anywhere and every gate green.

    The refusal must also happen BEFORE any bytes: a rejected write leaves no directory,
    no partial store, and nothing for a later reader to half-decode.
    """
    three = np.arange(30, dtype="float64").reshape(10, 3)
    with pytest.raises(sd.SpatialDeclarationError) as excinfo:
        sd.write_spatial_coordinates(tmp_path, "coords-3d.zarr", three, **_coords_kwargs())
    message = str(excinfo.value)
    assert "exactly 2 components" in message
    assert "SILENTLY INVISIBLE" in message, (
        "the refusal must name the mechanism; a bare shape complaint teaches the next "
        "producer to reshape rather than to move z to a sibling column"
    )
    assert not (tmp_path / "coords-3d.zarr").exists(), (
        "the refusal must precede the writer — a partial store is worse than no store"
    )

    # …and the honest 2-D form writes.
    two = np.asarray(three[:, :2], dtype="float64")
    structure, meta = sd.write_spatial_coordinates(
        tmp_path, "coords.zarr", two, **_coords_kwargs()
    )
    assert (tmp_path / "coords.zarr").is_dir()
    assert meta["n_dims"] == 2
    assert meta["coordinate_space"] == "V19L01-041-A1"
    assert meta["measured_entity"]["kind"] == "spot"
    assert meta["measured_entity_label"] == sd.measured_entity_label(meta["measured_entity"])
    assert meta["positioning"] == {"partial": False}
    assert structure["axis"] == "cells"

    # A 1-D array is not coordinates either.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.write_spatial_coordinates(
            tmp_path, "coords-1d.zarr", np.arange(10, dtype="float64"), **_coords_kwargs()
        )


def test_z_travels_as_a_declared_sibling_column_and_a_zero_fill_is_refused():
    """TEST-8 (cont.) [acceptance] [invariant: INV-2] — the other half of the rule.

    z is a sibling metadata-column with a DECLARED kind (`physical` micrometres or `index`
    z-plane), or it is absent. Never `z = 0` for a 2-D platform: a zero fill is a 2-D
    platform wearing a third dimension, and a later reader cannot tell it from a
    measurement.
    """
    assert sd.z_column(name="z_um", kind="physical", values=[1.5, 2.5]) == {
        "name": "z_um", "kind": "physical",
    }
    assert sd.z_column(name="z_plane", kind="index", values=[0, 1, 2])["kind"] == "index"

    with pytest.raises(sd.SpatialDeclarationError):
        sd.z_column(name="z_um", kind="depth", values=[1.0])

    # `values` is REQUIRED. The rule is a property OF THE VALUES, so a declaration made
    # without them enforces nothing — leaving them optional made the zero-fill refusal
    # opt-in, and a producer that simply never passed them was unaffected by the rule.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.z_column(name="z_um", kind="physical", values=None)
    with pytest.raises(sd.SpatialDeclarationError):
        sd.z_column(name="z_um", kind="physical", values=[])

    for kind in ("physical", "index"):
        with pytest.raises(sd.SpatialDeclarationError) as excinfo:
            sd.z_column(name="z_um", kind=kind, values=[0, 0, 0, 0])
        assert "omit the column" in str(excinfo.value)


# ── TEST-9 [acceptance] [invariant: INV-5] ───────────────────────────────────────────
def test_section_is_recorded_and_its_transform_is_refused():
    """TEST-9 [acceptance] [invariant: INV-5] — record the section, refuse the transform.

    `coordinate_space` names ONE frame and cannot express several sections of one sample
    intended to align into a volume, so the section is recorded now (free at write time,
    unrecoverable later). The section-to-section TRANSFORM is deliberately not designed:
    serial-section registration is frequently non-linear, so an affine would encode a
    false precision. Refusing the key — rather than merely not defining it — is what stops
    a producer smuggling one in as a free-form extra field.
    """
    assert sd.section(sample_id="donor-04-blockA", index=3) == {
        "sample_id": "donor-04-blockA", "index": 3,
    }
    assert sd.section(sample_id="donor-04-blockA", index=3, z_offset_um=30)["z_offset_um"] == 30.0

    for key in ("affine", "transform", "to_section", "registration", "warp"):
        with pytest.raises(sd.SpatialDeclarationError) as excinfo:
            sd.section(sample_id="s", index=0, **{key: [1, 0, 0, 0, 1, 0]})
        assert "non-linear" in str(excinfo.value)

    with pytest.raises(sd.SpatialDeclarationError):
        sd.section(sample_id="s", index="third")
    with pytest.raises(sd.SpatialDeclarationError):
        sd.section(sample_id="", index=0)


# ── #176 TEST-7 (and #152's TEST-10, whose function this extends) ────────────────────
#
# TEST IDs ARE PER-FEATURE NAMESPACES and this file already carries #152's. Its own TEST-7
# and TEST-8 are the partial-positioning refusal and the always-2-D writer rule, which have
# nothing to do with #176 — so every #176 id in this file is written `#176 TEST-N`, never
# bare. An earlier revision left #176's TEST-7 and TEST-8 both pointing at this ONE
# function (coverage inflation: two enumerated ids, one exercised assertion) and labelled a
# new function "TEST-7 (cont.)" where the file's real TEST-7 is something else entirely.
def test_the_image_cap_is_a_parameter_and_lossy_compression_is_refused():
    """#176 TEST-7 [covers: ITEM-1] · also #152 TEST-10 [acceptance] [invariant: INV-10].

    The cap is a PARAMETER with a 0.5 µm/pixel default, not a constant: hard-coding a
    coarser value to save storage risks a "why does the tissue look mushy" complaint that
    cannot be fixed without re-importing. And lossless only — downsampling produces fewer,
    larger pixels each a real average of real measurements, while lossy compression keeps
    the pixel count and INVENTS the values.
    """
    grid = {"width": 4000, "height": 3000}
    default = sd.display_derivative_provenance(
        original_resolution_um=0.2125, original_extent=grid,
        original_source="morphology.ome.tif",
        codec="deflate", tifffile_version="2026.3.3",
    )
    assert default["resolution_cap_um"] == 0.5, "the default cap moved"

    # THE ACHIEVED RESOLUTION, NEVER THE CAP (#176). ceil(0.5 / 0.2125) = 3, so the pixels
    # land at 0.6375 um/pixel. This assertion used to read `== 0.5`, i.e. it asserted the
    # CAP — a resolution the emitted pixels do not have. It was green only because the
    # branch was unreachable: #155's producer refused a finer-than-cap source rather than
    # downsampling it. #176 makes it reachable, and asserting the cap here is exactly the
    # defect #176 exists to remove.
    assert default["downsample_factor"] == 3
    assert default["applied_resolution_um"] == pytest.approx(0.6375, rel=1e-12)
    assert default["applied_resolution_um"] != default["resolution_cap_um"], (
        "the applied resolution is the cap — an integer factor overshoots, so the cap is a "
        "number the pixels do not have"
    )
    assert default["applied_resolution_um"] >= default["resolution_cap_um"], (
        "the cap is a NO-FINER-THAN bound and the result is finer than it"
    )
    assert default["downsampled"] is True
    assert default["is_display_derivative"] is True and default["lossless"] is True
    assert default["original_resolution_um"] == 0.2125
    assert default["original_extent"] == grid
    assert default["original_source"] == "morphology.ome.tif"
    # The emitted grid is the source grid floor-divided by the factor — the ragged edge is
    # DROPPED, never padded, because padding would invent a measurement.
    assert default["emitted_extent"] == {"width": 1333, "height": 1000}
    assert default["writer_version"] == "2026.3.3"

    # It is a parameter: another value is accepted, which is what makes a per-platform
    # tune possible without a schema change. At a 1.0 cap the same source needs ceil(1.0 /
    # 0.2125) = 5, landing at 1.0625.
    tuned = sd.display_derivative_provenance(
        original_resolution_um=0.2125, original_extent=grid,
        original_source="morphology.ome.tif",
        codec="lzw", tifffile_version="2026.3.3", resolution_cap_um=1.0,
    )
    assert tuned["resolution_cap_um"] == 1.0 and tuned["downsample_factor"] == 5
    assert tuned["applied_resolution_um"] == pytest.approx(1.0625, rel=1e-12)

    # A source ALREADY coarser than the cap passes through and is NOT upsampled. Visium's
    # tissue image is exactly this case.
    passthrough = sd.display_derivative_provenance(
        original_resolution_um=2.0, original_extent=grid,
        original_source="tissue_hires_image.png",
        codec="deflate", tifffile_version="2026.3.3",
    )
    assert passthrough["downsample_factor"] == 1
    assert passthrough["applied_resolution_um"] == 2.0
    assert passthrough["downsampled"] is False
    assert passthrough["emitted_extent"] == grid, "a pass-through resized the grid"

    # A source sitting AT the cap is a pass-through. `original == cap` alone does NOT
    # exercise the epsilon — `x / x` is exactly 1.0 in IEEE-754, so `ceil` gives 1 with or
    # without it and that case proves nothing about the constant. The load-bearing case is a
    # source a HAIR UNDER the cap: the true ratio is then just above 1.0 and an unguarded
    # `ceil` returns 2, HALVING an image that was within a part in 10^12 of meeting the cap.
    at_cap = sd.display_derivative_provenance(
        original_resolution_um=0.5, original_extent=grid,
        original_source="x.tif", codec="deflate", tifffile_version="2026.3.3",
    )
    assert at_cap["downsample_factor"] == 1 and at_cap["downsampled"] is False

    a_hair_under = 0.5 * (1 - 1e-12)
    assert 0.5 / a_hair_under > 1.0, (
        "this fixture no longer produces a ratio above 1.0, so it cannot exercise the "
        "epsilon and the assertion below is vacuous"
    )
    assert sd.downsample_factor(a_hair_under, 0.5) == 1, (
        "a source within a part in 10^12 of the cap was DOWNSAMPLED BY 2 — "
        "`_CAP_RATIO_EPSILON` is not being applied"
    )
    # …and the epsilon is narrow enough not to swallow a genuine sub-factor.
    assert sd.downsample_factor(0.5 * (1 - 1e-3), 0.5) == 2

    # A SUBNORMAL source resolution makes `cap / original` overflow to `inf`. Refused as
    # this module's own error type, because `OverflowError` is caught by no handler on the
    # producer's path and one damaged vendor number would abort the WHOLE import.
    for subnormal in (1e-320, 5e-324, 1e-310):
        with pytest.raises(sd.SpatialDeclarationError):
            sd.downsample_factor(subnormal, 0.5)
        with pytest.raises(sd.SpatialDeclarationError):
            sd.display_derivative_provenance(
                original_resolution_um=subnormal, original_extent=grid,
                original_source="x.tif", codec="deflate", tifffile_version="2026.3.3",
            )

    # The SOURCE GRID is required, on `z_column`'s stated precedent: a producer has the
    # array at write time, and an optional grid would make the one pixel-anchored
    # reconciliation leg opt-in.
    with pytest.raises(TypeError):
        sd.display_derivative_provenance(
            original_resolution_um=0.2125, original_source="x.tif",
            codec="deflate", tifffile_version="2026.3.3",
        )
    # And so is the pointer to where the original is PRESERVED (INV-2) — a display
    # derivative with no recoverable source is the failure this field exists to prevent.
    with pytest.raises(TypeError):
        sd.display_derivative_provenance(
            original_resolution_um=0.2125, original_extent=grid,
            codec="deflate", tifffile_version="2026.3.3",
        )
    # A factor so large the grid falls under one pixel is REFUSED by name.
    with pytest.raises(sd.SpatialDeclarationError) as excinfo:
        sd.display_derivative_provenance(
            original_resolution_um=0.001, original_extent={"width": 40, "height": 30},
            original_source="x.tif", codec="deflate", tifffile_version="2026.3.3",
        )
    assert "not an image" in str(excinfo.value)


def test_176_the_lossless_codec_refusals_are_inherited_and_not_weakened():
    """#176 TEST-8 [covers: ITEM-1] — #155's codec policy, on the downsampling path.

    A DISTINCT function rather than more assertions inside #176 TEST-7, because two
    enumerated test ids sharing one exercised assertion is coverage inflation: the tree
    would report two proofs where there is one.

    #176 changes what `display_derivative_provenance` DERIVES; it must change nothing about
    what that function REFUSES. Every lossy spelling and every unrecognised codec is still
    refused, now with a real downsample in the block — because "lossless" for a display
    derivative means four separable things and the codec is the one #155 already closed.
    """
    grid = {"width": 4000, "height": 3000}

    def build(**over):
        kwargs = dict(original_resolution_um=0.2125, original_extent=grid,
                      original_source="x.tif", codec="deflate",
                      tifffile_version="2026.3.3")
        kwargs.update(over)
        return sd.display_derivative_provenance(**kwargs)

    # The control: the block this is refusing variants of really does downsample, so the
    # refusals below are being made on the path #176 introduced and not on a pass-through.
    assert build()["downsampled"] is True

    for codec in ("jpeg", "JPEG", "jpg", "jpeg2000", "jp2", "webp", "avif"):
        with pytest.raises(sd.SpatialDeclarationError) as excinfo:
            build(codec=codec)
        assert "lossy" in str(excinfo.value)

    # An unrecognised codec cannot be ASSERTED lossless, so it is refused rather than
    # assumed — the same "absence is absence" rule one level up.
    with pytest.raises(sd.SpatialDeclarationError):
        build(codec="mystery")
    # Provenance without the writer version cannot answer "which tifffile made this".
    with pytest.raises(sd.SpatialDeclarationError):
        build(tifffile_version="")
    # Both lossless spellings are still accepted, so this is a policy and not a ban.
    assert build(codec="lzw")["codec"] == "lzw"
    assert build(codec="DEFLATE")["codec"] == "deflate"


def test_the_coordinate_space_declaration_refuses_an_unusable_shape():
    """TEST-9 (cont.) — the §6.6 block a consumer places the artifact with."""
    space = sd.coordinate_space(
        space="V19L01-041-A1", unit="pixel", to_space=[2.0, 0, 0, 0, 2.0, 0],
        extent={"width": 2000, "height": 2000},
    )
    assert space["extent"] == {"width": 2000, "height": 2000}
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinate_space(space="s", unit="metre", to_space=[1, 0, 0, 0, 1, 0])
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0])


_META_BLOCKS = ("space", "entity", "placement", "series")


def test_the_coordinates_meta_requires_all_four_unrecoverable_declarations():
    """TEST-6/7/9 (cont.) — none of the four is optional, because none is recoverable."""
    kwargs = _coords_kwargs()
    args = {k: kwargs[k] for k in _META_BLOCKS}
    assert sd.coordinates_meta(**args)["measured_entity_label"]
    for missing in _META_BLOCKS:
        broken = dict(args)
        broken[missing] = {}
        with pytest.raises(sd.SpatialDeclarationError):
            sd.coordinates_meta(**broken)
    # …and omitting `series` entirely is a TypeError from the signature, not a silent skip.
    with pytest.raises(TypeError):
        sd.coordinates_meta(space=args["space"], entity=args["entity"],
                            placement=args["placement"])


def test_every_rule_the_constructors_state_is_enforced_on_the_WRITE_path():
    """TEST-6/7/9 (cont.) [acceptance] [invariant: INV-3, INV-4, INV-5] — a raw dict cannot
    walk past the constructors.

    The constructors are where the vocabulary is closed, the sub-blocks are made complete
    and a section→section transform is refused by name — but a producer reaches the
    artifact through `coordinates_meta`, and a PRESENCE check there enforces none of it.
    With one, every rule above was decorative on the only path that writes: `kind:
    "voxel"` passed the closed vocabulary, `partial: 0` was read as COMPLETE by
    `require_full_positioning`, and a `transform` key rode into `meta["section"]` verbatim
    — the exact smuggling the module claims to have closed.
    """
    kwargs = _coords_kwargs()
    base = {k: kwargs[k] for k in _META_BLOCKS}

    # The closed `measured_entity` vocabulary really is closed here.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinates_meta(**{**base, "entity": {"kind": "voxel", "platform": "made-up"}})

    # `partial` is not coerced: a falsy non-bool must not read as "complete".
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinates_meta(**{**base, "placement": {"partial": 0}})

    # THE ONE THAT MATTERS MOST: a section→section transform cannot ride in as an extra.
    for key in ("affine", "transform", "to_section", "warp"):
        with pytest.raises(sd.SpatialDeclarationError) as excinfo:
            sd.coordinates_meta(**{
                **base,
                "series": {"sample_id": "s", "index": 0, key: [1, 0, 0, 0, 1, 0]},
            })
        assert "non-linear" in str(excinfo.value) or "not the shape" in str(excinfo.value)

    # A raw `space` dict cannot clobber the writer's own meta keys either.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinates_meta(**{**base, "space": {"kind": "clobbered", "name": "x"}})

    # And the honest form still assembles, with the section recorded.
    meta = sd.coordinates_meta(**base)
    assert meta["section"] == {"sample_id": "donor-04-blockA", "index": 0}
    assert meta["positioning"] == {"partial": False}


# ── TEST-15 [acceptance] [invariant: INV-12] ─────────────────────────────────────────
def test_a_pixel_space_carries_its_micron_scale_or_a_consumer_refuses():
    """TEST-15 [acceptance] [invariant: INV-12] — the scale a PIXEL space cannot otherwise
    carry, and the refusal that stops one being invented.

    A `unit: "pixel"` space says where things are relative to each other and nothing about
    how big they are. The spatial neighbour graph roughly two thirds of spatial analyses
    are built on takes a radius in MICRONS, so a radius applied to pixel coordinates with
    no scale is a radius in an arbitrary unit — and every neighbourhood, colocalization and
    spatially-variable-gene result computed from it inherits that, silently. The vendor
    ships the number (Visium's `scalefactors_json.json`, already opened for the affine), so
    it is free at write time and unrecoverable afterwards.

    The property asserted is NOT "the field exists". It is: an unknown scale stays
    expressible, and a consumer that needs microns REFUSES instead of assuming 1.0.
    """
    scaled = sd.coordinate_space(
        space="V19L01-041-A1", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        microns_per_pixel=0.65,
    )
    assert scaled["microns_per_pixel"] == 0.65
    assert sd.require_micron_scale(scaled, consumer="neighbour-graph") == 0.65

    # A micrometre space needs no scale, BY DEFINITION — and stating one there is refused
    # rather than ignored, so a consumer cannot apply it twice.
    microns = sd.coordinate_space(space="s", unit="micrometre", to_space=[1, 0, 0, 0, 1, 0])
    assert "microns_per_pixel" not in microns
    assert sd.require_micron_scale(microns, consumer="neighbour-graph") == 1.0
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinate_space(space="s", unit="micrometre", to_space=[1, 0, 0, 0, 1, 0],
                            microns_per_pixel=1.0)

    # AN UNKNOWN SCALE IS EXPRESSIBLE — the declaration is accepted without it…
    unscaled = sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0, 0, 1, 0])
    assert "microns_per_pixel" not in unscaled, "absence must stay absence, not become 1.0"

    # …and it is the CONSUMER that stops. This is the half that makes the field mean
    # something: without it, "no scale" and "a scale of 1.0" are the same downstream.
    with pytest.raises(sd.SpatialDeclarationError) as excinfo:
        sd.require_micron_scale(unscaled, consumer="neighbour-graph")
    message = str(excinfo.value)
    assert "neighbour-graph" in message and "1.0" in message

    # A space with no declaration at all is refused too: unknown is not microns.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.require_micron_scale({}, consumer="neighbour-graph")

    # And the scale is never coerced out of a bool or a non-number.
    for bad in (True, "0.65", None if False else float("inf")):
        with pytest.raises(sd.SpatialDeclarationError):
            sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
                                microns_per_pixel=bad)


def test_the_micron_scale_survives_into_the_artifact_meta():
    """TEST-15 (cont.) — the scale reaches the artifact, not just the constructor.

    `coordinates_meta` re-validates each block through its constructor, so this also pins
    that the re-validation round-trips the field rather than dropping it — a silent drop
    would leave every artifact unscaled while the producer believed it had declared one.
    """
    kwargs = _coords_kwargs()
    scaled = sd.coordinate_space(
        space="V19L01-041-A1", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        microns_per_pixel=0.65,
    )
    meta = sd.coordinates_meta(
        space=scaled, entity=kwargs["entity"], placement=kwargs["placement"],
        series=kwargs["series"],
    )
    assert meta["microns_per_pixel"] == 0.65
    assert sd.require_micron_scale(meta, consumer="neighbour-graph") == 0.65


# ── TEST-11 — `image_meta` (#155) ────────────────────────────────────────────────────


def _image_space(**overrides):
    kwargs = {"space": "V19L01-041-A1", "unit": "pixel",
              "to_space": [5, 0, 0, 0, 5, 0],
              "extent": {"width": 300, "height": 180}}
    kwargs.update(overrides)
    return sd.coordinate_space(**kwargs)


def test_image_meta_requires_an_extent_because_an_affine_alone_cannot_place_a_raster():
    """TEST-11 [covers: ITEM-7] — the one rule `coordinate_space` does not itself impose.

    §6.6 marks `extent` "rasters only", so `coordinate_space()` leaves it optional — which
    is right for the COORDINATES artifact and wrong for the image. An affine says where the
    image's origin lands and nothing about how far it extends, so without the extent a
    consumer cannot compute the covered region or lay two images out against each other.
    It is known at write time and unrecoverable afterwards, which is the same test every
    other field in this module has to pass.
    """
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.image_meta(space=sd.coordinate_space(
            space="s", unit="pixel", to_space=[5, 0, 0, 0, 5, 0]
        ))
    assert "extent" in str(exc.value)
    assert sd.image_meta(space=_image_space())["extent"] == {"width": 300, "height": 180}


def test_image_meta_revalidates_its_space_rather_than_trusting_the_dict():
    """TEST-11 (cont.) — the `_revalidated` discipline, on the path that actually writes.

    A producer reaches the artifact through `image_meta`, not through `coordinate_space`.
    If this only checked that keys were present, a hand-built dict could carry a 4-element
    affine or a nonsense unit straight into the artifact — i.e. every rule the constructor
    states, enforced nowhere that matters.
    """
    for broken in (
        {"coordinate_space": "s", "unit": "furlong", "to_space": [5, 0, 0, 0, 5, 0],
         "extent": {"width": 3, "height": 2}},
        {"coordinate_space": "s", "unit": "pixel", "to_space": [5, 0, 0],
         "extent": {"width": 3, "height": 2}},
        {"coordinate_space": "  ", "unit": "pixel", "to_space": [5, 0, 0, 0, 5, 0],
         "extent": {"width": 3, "height": 2}},
        {"coordinate_space": "s", "unit": "pixel", "to_space": [5, 0, 0, 0, 5, 0],
         "extent": {"width": 0, "height": 2}},
        {"coordinate_space": "s", "unit": "pixel", "to_space": [5, 0, 0, 0, 5, 0],
         "extent": ["width", "height"]},
    ):
        with pytest.raises(sd.SpatialDeclarationError):
            sd.image_meta(space=broken)


def test_image_meta_closes_the_role_vocabulary():
    """TEST-11 (cont.) — an open role string would stop being comparable.

    Same reasoning as `MEASURED_ENTITY_KINDS`: a run legitimately carries several images,
    and a consumer asking "which one do I display?" must not have to pattern-match a
    free-form string two producers spell differently.
    """
    assert sd.image_meta(space=_image_space(), role="display")["role"] == "display"
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.image_meta(space=_image_space(), role="primary")
    assert "vocabulary" in str(exc.value)
    assert "role" not in sd.image_meta(space=_image_space())


def test_image_meta_refuses_a_derivative_whose_derived_fields_were_hand_edited():
    """TEST-11 (cont.) — the check a presence test could not make.

    `display_derivative_provenance` DERIVES `is_display_derivative`, `applied_resolution_um`,
    `downsampled` and `lossless` from its inputs; they are not producer-settable. So
    `image_meta` rebuilds the block from its own recorded inputs and demands a match — which
    is what makes a `lossless: True` riding on a lossy codec unreachable rather than merely
    discouraged.
    """
    good = sd.display_derivative_provenance(
        original_resolution_um=3.7, original_extent={"width": 300, "height": 180},
        original_source="tissue_hires_image.png",
        codec="deflate", tifffile_version="2026.3.3",
    )
    assert sd.image_meta(space=_image_space(),
                         derivative=good)["display_derivative"] == good

    tampered = dict(good, downsampled=True)
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.image_meta(space=_image_space(), derivative=tampered)
    assert "not producer-settable" in str(exc.value)

    lying = dict(good, codec="jpeg")
    with pytest.raises(sd.SpatialDeclarationError):
        sd.image_meta(space=_image_space(), derivative=lying)

    with pytest.raises(sd.SpatialDeclarationError):
        sd.image_meta(space=_image_space(), derivative={"codec": "deflate"})

    # #176's two new derived fields are refused the same way — they are the ones that say
    # how much the pixels shrank, so a hand-edit here is a downsample nobody performed.
    for field, value in (("downsample_factor", 2), ("emitted_extent",
                                                    {"width": 1, "height": 1}),
                         ("applied_resolution_um", 0.5)):
        with pytest.raises(sd.SpatialDeclarationError):
            sd.image_meta(space=_image_space(), derivative=dict(good, **{field: value}))

    # `source` and the derivative's `original_source` name the SAME fact — the vendor file
    # these pixels came from — so two independent strings must not be allowed to disagree.
    # A reader following either one to the retained bundle would otherwise reach a different
    # file.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.image_meta(space=_image_space(), derivative=good,
                      source="tissue_lowres_image.png")
    assert "same fact" in str(exc.value)
    agreed = sd.image_meta(space=_image_space(), derivative=good,
                           source="tissue_hires_image.png")
    assert agreed["source"] == agreed["display_derivative"]["original_source"]


def test_require_original_reference_reaches_the_preserved_original_or_refuses():
    """#176 TEST-2 (unit half) [covers: ITEM-7] — INV-2's consumer side, both halves.

    A `spatial/image` is a display derivative: its pixels may be an average the importer
    computed. A consumer that needs the instrument's own measurements must be able to find
    them — and must be REFUSED rather than handed the derived raster when nothing says where
    they are. Same rule, and the same reason, as `require_micron_scale`.
    """
    derivative = sd.display_derivative_provenance(
        original_resolution_um=0.2, original_extent={"width": 4000, "height": 3000},
        original_source="morphology.ome.tif",
        codec="deflate", tifffile_version="2026.3.3",
    )
    meta = sd.image_meta(space=_image_space(), derivative=derivative,
                         source="morphology.ome.tif")
    ref = sd.require_original_reference(meta, consumer="an intensity readout")
    assert ref["member"] == "morphology.ome.tif"
    assert ref["extent"] == {"width": 4000, "height": 3000}
    assert ref["resolution_um"] == 0.2
    assert ref["downsample_factor"] == 3
    # The reference describes the ORIGINAL, never the emitted raster — if these were the
    # same numbers the function would be answering the wrong question.
    assert ref["extent"] != derivative["emitted_extent"]
    assert ref["resolution_um"] != derivative["applied_resolution_um"]

    # An image with NO provenance is one whose resolution could never be evaluated. Its
    # pixels ARE the vendor's, but this refuses to say so: "unknown" is not "untouched",
    # and conflating them is how a fabricated claim gets made.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_original_reference(sd.image_meta(space=_image_space()),
                                      consumer="an intensity readout")
    assert "an intensity readout" in str(exc.value)
    for junk in (None, {}, {"display_derivative": None}, "not-a-mapping"):
        with pytest.raises(sd.SpatialDeclarationError):
            sd.require_original_reference(junk, consumer="an intensity readout")


def test_the_placement_payload_round_trips_and_absence_stays_absence():
    """TEST-11 (cont.) — the byte channel's codec, both directions.

    `encode_placement`/`decode_placement` are what let a SANDBOXED consumer read a
    declaration that the manifest `meta` cannot carry to it. The refusal half matters as
    much as the round trip: an image with no payload must yield `None` and make
    `require_placement` stop, never an assumed identity affine.
    """
    meta = sd.image_meta(space=_image_space(microns_per_pixel=3.7))
    encoded = sd.encode_placement(meta)
    assert encoded.startswith(sd.OME_PLACEMENT_PREFIX)

    xml = (
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        f"<Image><Description>{encoded}</Description></Image></OME>"
    )
    decoded = sd.decode_placement(xml)
    for key in ("coordinate_space", "unit", "to_space", "extent", "microns_per_pixel"):
        assert decoded[key] == meta[key]

    for empty in ("", "   ", "<not-xml", '<OME xmlns="x"><Image/></OME>'):
        assert sd.decode_placement(empty) is None
        with pytest.raises(sd.SpatialDeclarationError):
            sd.require_placement(empty, consumer="a spatial analysis")

    # A payload that cannot place anything is refused at ENCODE time, so a half-built
    # declaration never reaches the bytes in the first place.
    with pytest.raises(sd.SpatialDeclarationError):
        sd.encode_placement({"unit": "pixel"})
