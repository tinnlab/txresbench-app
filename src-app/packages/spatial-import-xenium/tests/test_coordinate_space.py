#!/usr/bin/env python3
# ruff: noqa
"""The coordinate space a Xenium import declares — MICROMETRES, and no invented scale.

This is the headline divergence from Visium and the one that changes the shape of the whole
importer. Visium stores full-resolution PIXELS and must derive a `microns_per_pixel` from
`spot_diameter_fullres`; Xenium's coordinates are already micrometres, so there is no pixel
frame and no scale to get wrong.

The test that matters here is not "the field is absent" — a passive read cannot tell an
absence that was DECLINED from one that was FORGOTTEN. It is that stating the field is
REFUSED, which is the half of INV-2 only a mutation can see.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-space")
    module, entries = XF.run_over(XF.PRIME, out)
    return {"out": out, "entries": entries, "module": module}


def test_the_space_is_micrometres_at_identity_with_no_invented_scale(imported):
    """TEST-3 [acceptance] [invariant: INV-2] — the declaration itself."""
    meta = XF.entry(imported["entries"], "spatial-coordinates")["meta"]
    assert meta["unit"] == "micrometre", (
        "Xenium reports x_centroid/y_centroid in micrometres; declaring `pixel` would be a "
        "unit error that no shape or type check can see"
    )
    assert meta["to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], (
        "the coordinates map into their OWN space by the identity, and each image declares "
        "its own affine INTO this frame — the direction that composes"
    )
    assert "microns_per_pixel" not in meta, (
        "there is no pixel size for a micrometre space, and there is NO DEFAULT OF 1.0"
    )
    assert meta["coordinate_space"].startswith("xenium:")


def test_require_micron_scale_answers_one_by_definition(imported):
    """TEST-3 — the consumer-facing consequence, which is the whole point of INV-2.

    A neighbour-graph radius in micrometres resolves correctly on this artifact with nothing
    having been fabricated. On a Visium bundle whose vendor scale is missing, the same call
    REFUSES — that contrast is asserted here so "1.0" is understood as the unit's own
    definition and not as the forbidden default.
    """
    import spatial_declarations as SD

    meta = XF.entry(imported["entries"], "spatial-coordinates")["meta"]
    assert SD.require_micron_scale(meta, consumer="a neighbour graph") == 1.0

    # THE CONTRAST: a PIXEL space with no declared scale refuses, and that refusal is the
    # behaviour "1.0 by definition" must not be confused with.
    pixel_space = SD.coordinate_space(space="v:1", unit="pixel",
                                      to_space=[1, 0, 0, 0, 1, 0])
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.require_micron_scale(pixel_space, consumer="a neighbour graph")
    assert "Refusing rather than assuming 1.0" in str(exc.value)


def test_stating_a_pixel_scale_on_this_space_is_REFUSED_not_ignored(imported):
    """TEST-3 — THE MUTATION ARM, and the only one that can falsify INV-2.

    "The key is absent" passes whether the producer declined it or never thought of it. What
    INV-2 actually promises is that the declaration REFUSES an invented scale, so a
    consumer cannot be handed one to apply twice. Flip that off and this goes red; nothing
    else in the suite would.
    """
    import spatial_declarations as SD

    meta = XF.entry(imported["entries"], "spatial-coordinates")["meta"]
    kwargs = {"space": meta["coordinate_space"], "unit": meta["unit"],
              "to_space": meta["to_space"], "microns_per_pixel": 0.2125}
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.coordinate_space(**kwargs)
    assert "meaningless for unit" in str(exc.value)
    assert "apply it twice" in str(exc.value)


def test_the_image_shares_the_coordinates_space_and_declares_no_scale_either(imported):
    """TEST-3 — the same rule on the other artifact.

    Both artifacts declare the SAME `coordinate_space`, so they are placeable against each
    other; neither carries a `microns_per_pixel`, because the space has no pixels. The
    image's own pitch is not lost — it IS `to_space[0]`, directly, because the space's unit
    is the micrometre.
    """
    coord = XF.entry(imported["entries"], "spatial-coordinates")["meta"]
    image = XF.entry(imported["entries"], "spatial-image-morphology")["meta"]
    assert image["coordinate_space"] == coord["coordinate_space"]
    assert image["unit"] == "micrometre"
    assert "microns_per_pixel" not in image
    assert image["to_space"][0] == image["display_derivative"]["applied_resolution_um"], (
        "in a micrometre space the affine's scale term IS the emitted pixel pitch — one "
        "number instead of two that can drift apart, which is a real simplification over "
        "the pixel-space case rather than an accident"
    )


def test_the_unit_note_says_out_loud_why_there_is_no_scale(imported):
    """TEST-3 — absence explained in the artifact, not only in a design document.

    A reader coming from the Visium shape will look for `microns_per_pixel_source` and find
    nothing. Silence there is how somebody concludes the importer forgot.
    """
    meta = XF.entry(imported["entries"], "spatial-coordinates")["meta"]
    assert "microns_per_pixel_source" not in meta
    assert "already micrometres" in meta["unit_note"]
    assert "1.0 by definition" in meta["unit_note"]


# ── TEST-15 (#211) — the SECOND producer gets it too, without asking ─────────────────


def test_the_declarations_reach_the_stores_bytes_for_this_importer_as_well(imported):
    """TEST-15 — two independent producers, neither of which passes a new argument.

    This is the leg that distinguishes "the WRITER mirrors the declarations" from "one
    importer happens to". `spatial.import-xenium` was not edited to request the mirror —
    only to move `coordinate_space_source` into the block that describes the space — and
    its coordinates store carries the declarations anyway.

    The Xenium case also covers the shape Visium cannot: a MICROMETRE space, where
    `microns_per_pixel` is absent by category rather than by accident and
    `require_micron_scale` answers 1.0 BY DEFINITION. A consumer reading this store must
    get that 1.0 from the declared UNIT, never from a default — which is why the unit is
    asserted from the store copy rather than from the row.
    """
    import json

    SD = imported["module"].SD
    entry = XF.entry(imported["entries"], "spatial-coordinates")
    store = imported["out"] / entry["path"]

    stamped = json.loads((store / "zarr.json").read_text())["attributes"]["cyto"]
    assert stamped == entry["structure"]

    block = SD.require_spatial_declarations(store, consumer="a neighbourhood analysis")
    assert block["declares"] == SD.SPATIAL_DECLARATION_TOKEN
    assert block["unit"] == "micrometre"
    assert "microns_per_pixel" not in block
    assert "microns_per_pixel_source" not in block, (
        "a micrometre space named a leg that produced a pixel scale — there is no such leg"
    )
    # EVERY key the block carries is compared against the catalog row, not a chosen five.
    # Nothing mechanically pins `meta` against `structure['cyto_spatial']` — they agree
    # only because one dict at one call site builds both — and the divergence pattern
    # (`coord_meta.update({...})` after the writer returns) is already in this importer.
    # A subset comparison would have let a post-hoc `coord_meta["unit"] = ...` sail past
    # while the UI and the sandbox disagreed about the same coordinate space.
    shared = [k for k in block if k != "declares"]
    assert len(shared) >= 8, f"only {shared} to compare; the block shrank"
    for key in shared:
        assert block[key] == entry["meta"][key], (
            f"{key} differs between the store copy a sandboxed consumer reads and the "
            "catalog row the UI reads"
        )

    # ...AND THE OTHER DIRECTION. Iterating the store copy alone is blind to a key present
    # in `meta` and absent from the block — and the divergence pattern the comment above
    # names (`coord_meta.update({...})` after the writer returns) ADDS keys to `meta`,
    # which is exactly the direction a one-sided loop cannot see. Every declaration key in
    # `meta` must be in the block; anything else must be a producer-only catalog fact,
    # named here so a NEW one is a decision rather than a silent divergence.
    # Xenium's own producer-only set. `spot_diameter_fullres` and `method` were in an
    # earlier spelling of this list and CANNOT appear in a Xenium row — an allow-list with
    # dead entries quietly permits whatever those names later come to mean.
    PRODUCER_ONLY = {"name", "kind", "axis", "n", "n_dims",
                     "platform", "provenance", "component_columns", "unit_note"}
    dead = sorted(PRODUCER_ONLY - set(entry["meta"]))
    assert dead == [], f"{dead} are allow-listed and not emitted — a dead exemption"
    leaked = sorted(set(entry["meta"]) - set(shared) - PRODUCER_ONLY)
    assert leaked == [], (
        f"{leaked} are in the catalog row and NOT in the store block, and are not "
        "declared producer-only facts — so a sandboxed consumer and the UI now disagree "
        "about what this artifact declares"
    )

    # 1.0 BY DEFINITION, read out of the declared unit in the store — and the control that
    # it is the unit doing the work: strip the unit and the same call REFUSES.
    assert SD.require_micron_scale(block, consumer="a neighbourhood analysis") == 1.0
    stripped = {k: v for k, v in block.items() if k != "unit"}
    with pytest.raises(SD.SpatialDeclarationError):
        SD.require_micron_scale(stripped, consumer="a neighbourhood analysis")

    # the importer asks for nothing: the mirror is the writer's property
    source = (XF.PKG / "compute" / "import_xenium.py").read_text()
    assert "mirror_declarations_into_store" not in source
