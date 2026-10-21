#!/usr/bin/env python3
# ruff: noqa
"""THE SHARED-CODE DEFECT, reproduced RED and then fixed — `_reconcile_scale` and the
micrometre coordinate space (#162, ITEM-3 / DEC-6).

Two rules in shared code were mutually unsatisfiable:

  * `spatial_declarations.coordinate_space` REFUSES `microns_per_pixel` for
    `unit: "micrometre"` — *"the coordinates are already in microns. Stating a scale for a
    space that has none invites a consumer to apply it twice."*
  * `ome_writer._reconcile_scale` read that same key and RAISED when it was absent —
    *"a block without one is incoherent."*

So a micrometre-space image carrying display-derivative provenance could never be written.
That is not a hypothetical corner: EVERY Xenium morphology image is 0.2125 um/pixel against
a 0.5 um/pixel cap, so it is ALWAYS downsampled, so it ALWAYS carries that provenance. The
whole image half of this importer was unreachable through shared code that had only ever
been exercised by a pixel-space producer.

The fix is one substitution: resolve the space's scale through `SD.require_micron_scale`,
the helper written for exactly this question, which answers `1.0` for a micrometre space BY
DEFINITION and the declared `microns_per_pixel` for a pixel space. Leg 3 then reduces to
`to_space[0] == applied_resolution_um`, which is the physical size of one emitted pixel in
the space's own unit.

`test_the_pre_fix_reconciliation_refuses...` below RUNS the pre-fix code, reconstructed from
the shipped source by putting the historical expression back, so this is a red-first proof
rather than an argument.
"""
import re
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

XF.load_compute()          # installs the vendored `spatial_declarations` / `ome_writer`
import ome_writer  # noqa: E402
import spatial_declarations as SD  # noqa: E402


PIXEL_SIZE = 0.2125
FACTOR = 3
APPLIED = PIXEL_SIZE * FACTOR


def _micrometre_placement(factor=FACTOR, extent=(64, 32)):
    """A `spatial/image` placement in a MICROMETRE space, built the only legal way."""
    space = SD.coordinate_space(
        space="xenium:test",
        unit="micrometre",
        to_space=ome_writer.emitted_affine(1.0 / PIXEL_SIZE, factor),
        extent={"width": extent[0], "height": extent[1]},
    )
    derivative = SD.display_derivative_provenance(
        original_resolution_um=PIXEL_SIZE,
        original_extent={"width": extent[0] * factor, "height": extent[1] * factor},
        original_source="morphology_focus/morphology_focus_0000.ome.tif",
        codec=ome_writer.CODEC,
        tifffile_version=ome_writer.tifffile_version(),
        resolution_cap_um=SD.DEFAULT_RESOLUTION_CAP_UM,
    )
    return SD.image_meta(space=space, derivative=derivative, role="display",
                         source="morphology_focus/morphology_focus_0000.ome.tif")


# ── the two rules, and the contradiction between them ────────────────────────────────


def test_a_micrometre_space_cannot_carry_microns_per_pixel_at_all():
    """TEST-19 — premise one, executable.

    The key `_reconcile_scale` used to read is not merely absent from a micrometre
    placement; it is REFUSED. There was no way for a producer to satisfy the old check.
    """
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.coordinate_space(space="xenium:test", unit="micrometre",
                            to_space=[1, 0, 0, 0, 1, 0], microns_per_pixel=PIXEL_SIZE)
    assert "meaningless for unit" in str(exc.value)

    placement = _micrometre_placement()
    assert "microns_per_pixel" not in placement, (
        "premise two: the historical expression `placement.get('microns_per_pixel')` "
        "therefore returns None for every legal micrometre placement"
    )
    assert placement.get("microns_per_pixel") is None
    # And the helper that WAS written for this question has always had the right answer.
    assert SD.require_micron_scale(placement, consumer="a test") == 1.0


def test_the_pre_fix_reconciliation_refuses_a_micrometre_image_RED_FIRST():
    """TEST-19 — the DEFECT, executed rather than argued.

    The shipped `_reconcile_scale` source is taken and the historical expression is put
    back, then run. If this ever stops reproducing (because the function was refactored
    past recognition) the substitution guard below fails loudly rather than the test
    silently passing on a no-op.
    """
    import inspect

    source = textwrap.dedent(inspect.getsource(ome_writer._reconcile_scale))
    pattern = re.compile(
        r"    try:\n        space_scale = SD\.require_micron_scale\(\n.*?\n    except SD\.SpatialDeclarationError:\n        space_scale = None\n",
        re.S,
    )
    pre_fix, n = pattern.subn(
        '    space_scale = placement.get("microns_per_pixel")\n', source
    )
    assert n == 1, (
        "could not reconstruct the pre-fix `_reconcile_scale`: the resolution block has "
        "moved. Re-derive it from git history rather than deleting this test — it is the "
        "only executable record of why the shared helper had to change."
    )
    namespace = {"SD": SD, "extent_of": ome_writer.extent_of,
                 "_SCALE_RTOL": ome_writer._SCALE_RTOL}
    exec(compile(pre_fix, "<pre-fix _reconcile_scale>", "exec"), namespace)

    placement = _micrometre_placement()
    arr = np.zeros((32, 64), dtype=np.uint16)

    with pytest.raises(SD.SpatialDeclarationError) as exc:
        namespace["_reconcile_scale"](placement, arr, APPLIED)
    assert "declares no `microns_per_pixel`" in str(exc.value), (
        "this is the exact refusal every Xenium image would have hit"
    )

    # AND THE FIX: the shipped function accepts the identical placement.
    ome_writer._reconcile_scale(placement, arr, APPLIED)


# ── the fix does not weaken the check ────────────────────────────────────────────────


def test_leg_three_still_catches_a_dropped_factor_in_a_micrometre_space():
    """TEST-19 — the fix must not be a hole.

    The defect leg 3 exists to catch is an image downsampled by `factor` whose affine still
    describes the source. In a micrometre space that is `to_space[0] == pixel_size` while
    the pixels were reduced by 3 — and it must still RAISE, or generalising the check would
    have been a way to delete it.
    """
    placement = _micrometre_placement()
    arr = np.zeros((32, 64), dtype=np.uint16)
    ome_writer._reconcile_scale(placement, arr, APPLIED)         # control: passes

    dropped = dict(placement)
    # The affine left at the SOURCE pitch — the whole failure, one line.
    dropped["to_space"] = [PIXEL_SIZE, 0.0, 0.0, 0.0, PIXEL_SIZE, 0.0]
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        ome_writer._reconcile_scale(dropped, arr, APPLIED)
    assert "silently scales wrong by the factor" in str(exc.value)

    # And an OME header left at the source pitch (leg 4) is caught too.
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        ome_writer._reconcile_scale(placement, arr, PIXEL_SIZE)
    assert "misscales every tool outside this system" in str(exc.value)


def test_a_pixel_space_behaves_exactly_as_before():
    """TEST-19 — the Visium path is bit-identical, including its error text.

    `require_micron_scale` returns the declared `microns_per_pixel` for a pixel space, and
    raises for one without — which the fix converts back to the ORIGINAL refusal message so
    no shipped assertion moves.
    """
    space = SD.coordinate_space(
        space="visium:test", unit="pixel",
        to_space=ome_writer.emitted_affine(0.2, 1),
        extent={"width": 64, "height": 32},
        microns_per_pixel=1.0,
    )
    derivative = SD.display_derivative_provenance(
        original_resolution_um=5.0,
        original_extent={"width": 64, "height": 32},
        original_source="tissue_hires_image.png",
        codec=ome_writer.CODEC,
        tifffile_version=ome_writer.tifffile_version(),
        resolution_cap_um=SD.DEFAULT_RESOLUTION_CAP_UM,
    )
    placement = SD.image_meta(space=space, derivative=derivative, role="display",
                              source="tissue_hires_image.png")
    arr = np.zeros((32, 64), dtype=np.uint16)
    assert placement["microns_per_pixel"] == 1.0
    assert SD.require_micron_scale(placement, consumer="a test") == 1.0
    ome_writer._reconcile_scale(placement, arr, 5.0)

    # A PIXEL space with the scale stripped must still hit the ORIGINAL message, verbatim.
    stripped = dict(placement)
    stripped.pop("microns_per_pixel")
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        ome_writer._reconcile_scale(stripped, arr, 5.0)
    assert "declares no `microns_per_pixel`" in str(exc.value)
    assert "a block without one is incoherent" in str(exc.value), (
        "the refusal text for a pixel space must not have moved — shipped Visium tests "
        "assert on it, and generalising a check is not licence to reword its failures"
    )


def test_the_whole_write_path_accepts_a_micrometre_image(tmp_path):
    """TEST-19 — end to end through the real writer, not just the private leg.

    `write_ome_tiff` is where the pixels and the declaration are both in scope, so this is
    the level the defect actually blocked.
    """
    arr = (np.arange(64 * 32, dtype=np.uint16) % 4096).reshape(32, 64)
    placement = _micrometre_placement()
    dest = ome_writer.write_ome_tiff(tmp_path / "m.ome.tif", arr, placement=placement,
                                     image_microns_per_pixel=APPLIED)
    import tifffile
    with tifffile.TiffFile(str(dest)) as handle:
        xml = handle.ome_metadata or ""
        assert f'PhysicalSizeX="{APPLIED}"' in xml
        decoded = SD.decode_placement(xml)
    assert decoded["unit"] == "micrometre"
    assert "microns_per_pixel" not in decoded
    assert decoded["to_space"][0] == pytest.approx(APPLIED, rel=1e-12)
