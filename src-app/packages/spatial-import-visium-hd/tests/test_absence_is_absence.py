#!/usr/bin/env python3
# ruff: noqa
"""TEST-5 — ABSENCE IS ABSENCE, never a fabricated value.

**INV-5**, lifted verbatim from `docs/design/spatial-storage-layout.md` §7.2
(ON `main` — restored by #315 (`b34d4371`), reconciled against what shipped; every
quotation below was re-verified against that merged text), where it is the design's own INV-3:

> Dropped, deliberately, and each with a reason (INV-3: **absence is absence, never a
> fabricated value**)

The invariant has a shape that makes it easy to satisfy on paper and hard to satisfy in
practice: a fabricated value is not an error, it is a plausible number in the right field.
`microns_per_pixel: 1.0` is a scale. An identity affine is an affine. A placeholder
coordinate puts a bin somewhere real-looking on the tissue. Every one of them passes every
internal consistency check this importer has.

So each test below asserts the ABSENCE — that the key is not merely null but NOT THERE, that
no artifact was emitted, that the run refused — and pairs it with the positive control that
the same code path produces the value when the vendor really did supply it. Without the
control, "the key is absent" is also satisfied by an importer that never writes it.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import hd_hostile_bundles as HB  # noqa: E402
import make_fixture as MF  # noqa: E402


def _report(out):
    return json.loads((Path(out) / "visium-hd-import-report.json").read_text(encoding="utf-8"))


# ── (1) a bundle that states no micron scale declares NO scale ─────────────────────


def test_TEST_5_no_stated_scale_means_the_KEY_IS_ABSENT_not_null_and_not_one(tmp_path):
    """TEST-5 [acceptance, INV-5] — the scale, which is the one a fabricated value ruins silently.

    `micron_scale` has two legs and no third: the vendor states `microns_per_pixel` or the
    artifact declares NO scale. Never 1.0 — that is a scale, it is wrong by whatever the real
    number is, and every micron-denominated result downstream inherits it with nothing saying
    so. Never `null` either: `spatial_declarations` spells absence by the key not being there,
    and a `null` is a value a reader has to special-case.

    Asserted on the STORE's own mirrored declaration as well as on the manifest row, because
    the store's copy is the one a sandboxed analysis reads (#211) — a key dropped from `meta`
    and left in the mirror would be absent to a catalog and present to an analysis.
    """
    module = HF.load_compute()
    root = HF.staged_tree(
        tmp_path, scalefactor_overrides={8: {"drop": ("microns_per_pixel",)}})
    entries = module.run_import(root, tmp_path / "out")

    report = _report(tmp_path / "out")
    assert "microns_per_pixel" not in report
    assert report["microns_per_pixel_source"] == "unavailable"
    # …and the run SAYS so, in the artifact a human reads. A silently absent scale is how a
    # user discovers three analyses later that nothing can measure a distance.
    assert "scale_note" in report and "NO physical scale" in report["scale_note"]

    coords_meta = HF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert "microns_per_pixel" not in coords_meta, (
        f"the coordinates row carries a scale the vendor did not state: "
        f"{coords_meta.get('microns_per_pixel')!r}")
    declared = HF.store_declarations(tmp_path / "out", "spatial/coordinates.zarr")
    assert "microns_per_pixel" not in declared, (
        "the scale is absent from `meta` but present in the store's mirrored declaration — a "
        "sandboxed analysis would read a number the catalog says does not exist")


def test_TEST_5_the_control_a_stated_scale_really_does_arrive(tmp_path):
    """TEST-5 [acceptance, INV-5] — the positive control for the assertion above.

    "The key is absent" is also satisfied by an importer that never writes it at all, which
    would be a different and worse defect. Same code path, same fixture family, vendor states
    the number: it must be there, verbatim, and sourced to the vendor.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = _report(tmp_path / "out")
    assert report["microns_per_pixel"] == MF.MICRONS_PER_PIXEL
    assert report["microns_per_pixel_source"] == "vendor"
    assert HF.store_declarations(tmp_path / "out", "spatial/coordinates.zarr")[
        "microns_per_pixel"] == MF.MICRONS_PER_PIXEL


@pytest.mark.parametrize("bad_scalef", [None, 0, -1, float("inf"), True, "0.2"],
                         ids=["absent", "zero", "negative", "infinite", "bool", "string"])
def test_TEST_5_an_UNPLACEABLE_image_is_DROPPED_with_a_named_note(bad_scalef, tmp_path):
    """TEST-5 [acceptance, INV-5] — no artifact, and a note saying why.

    §7.3 opens by pointing out that getting the affine wrong "does not error". An identity
    affine is not a missing declaration but a WRONG one — the claim that these pixels are
    already full-resolution pixels — so the image is DROPPED. A dropped image is visibly
    absent; a misplaced one is silently wrong.

    The parametrisation is the interesting part. `0` and `-1` are obvious. `Infinity` is
    accepted by `json.loads`, passes `> 0`, and then `1/inf = 0.0` reaches a declaration
    constructor that refuses zero — a DIFFERENT exception type from the one `emit_images`
    catches, so a naive guard would abort the WHOLE import on one damaged number. `True` is
    an `int` subclass and would read as a scalefactor of 1.0. A string is what a hand-edited
    file produces.
    """
    module = HF.load_compute()
    extra = {} if bad_scalef is None else {"tissue_hires_scalef": bad_scalef}
    drop = ("tissue_hires_scalef",) if bad_scalef is None else ()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"extra": extra, "drop": drop}})
    entries = module.run_import(root, tmp_path / "out")

    report = _report(tmp_path / "out")
    emitted = {e["id"] for e in entries if e["datatype"] == "spatial/image"}
    assert "spatial-image-hires" not in emitted, (
        f"an image with `tissue_hires_scalef` = {bad_scalef!r} was EMITTED; whatever affine it "
        "declares is a claim about where the tissue is")
    assert not (Path(tmp_path) / "out" / "spatial-image-hires.ome.tif").exists()
    notes = [n for n in report["images_not_emitted"] if n.startswith("tissue_hires_image.png:")]
    assert len(notes) == 1, (
        f"the dropped image produced {len(notes)} notes; a silently absent image is what this "
        f"channel exists to prevent: {report['images_not_emitted']!r}")
    # …and the REST of the import survived. Losing one image must never cost the matrix, the
    # coordinates, the columns and the report.
    assert HF.entry_by_id(entries, "expression")
    assert HF.entry_by_id(entries, "spatial-coordinates")


def test_TEST_5_the_control_a_placeable_image_IS_emitted(tmp_path):
    """TEST-5 [acceptance, INV-5] — the control for the drop above.

    Without it, "no `spatial-image-hires` in the entries" is also satisfied by an importer
    that emits no images at all, and the parametrised test above would be green against a
    package with the whole image leg deleted.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    assert HF.entry_by_id(entries, "spatial-image-hires")
    assert (tmp_path / "out" / "spatial-image-hires.ome.tif").is_file()
    assert _report(tmp_path / "out")["images_not_emitted"] == []


def test_TEST_5_a_bin_that_is_not_there_is_REFUSED_not_substituted(tmp_path):
    """TEST-5 [acceptance, INV-5] — a missing bin is not rounded to the nearest one.

    The fabrication here would be helpfulness: the user asked for 4 µm, the bundle has 2 and
    8, and importing 8 "because it is closest" produces a complete, correct-looking dataset at
    a resolution nobody chose — stamped with a `measured_entity` that is perfectly accurate
    about the wrong bin. Refusal is the only honest answer, and the message must name what IS
    available so the user can choose.
    """
    module = HF.load_compute()
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(HF.FIXTURE, tmp_path / "out", requested_bin=4)
    message = str(exc.value)
    for available in MF.BINS:
        assert str(available) in message
    assert HF.output_paths(tmp_path / "out") == []


def test_TEST_5_a_bin_with_no_position_is_REFUSED_not_given_a_placeholder(tmp_path):
    """TEST-5 [acceptance, INV-5] — the join refusal, which is the sharpest case of the rule.

    A square with no position cannot be given one. A placeholder coordinate — `(0, 0)`, the
    centroid, `NaN` — puts that square somewhere on the tissue, and every neighbourhood
    statistic computed afterwards includes it. `NaN` is the subtle one: it looks like absence
    and is a float, so it flows through arithmetic and poisons aggregates rather than being
    rejected.

    So the assertion is not only that the run refused: it is that NOTHING was written, and
    that no emitted coordinate anywhere is a placeholder. The second half is checked on the
    CONTROL run, where the join succeeded — an importer that fabricated on the failure path
    would presumably also fabricate on a partial one.
    """
    module = HF.load_compute()
    bundle = HB.a_positions_file_missing_a_matrix_barcode(tmp_path / "join")
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, tmp_path / "out")
    assert "Absence is absence" in str(exc.value)
    assert HF.output_paths(tmp_path / "out") == []

    # The control: on a complete bundle every coordinate is a real, finite vendor value.
    _module, _entries = HF.run_over(HF.FIXTURE, tmp_path / "good")
    coords = HF.read_member(tmp_path / "good", "spatial/coordinates.zarr", "coordinates")
    assert np.isfinite(coords).all(), "an emitted coordinate is NaN or infinite"
    assert not (coords == 0).all(axis=1).any(), "an emitted coordinate is the (0, 0) placeholder"


def test_TEST_5_an_unreadable_OPTIONAL_member_DEGRADES_and_says_so(tmp_path):
    """TEST-5 [acceptance, INV-5] — the other half of the rule, which is not symmetry.

    `metrics_summary.csv` is an OPTIONAL run-root file with a documented fallback LADDER for
    the sample id, and on the folder-upload arm it is structurally ABSENT because it is not a
    declared member. One unreadable optional file is not a reason to refuse a complete bundle
    — but the degrade has to be VISIBLE, or the report makes a quiet claim about provenance it
    cannot support.

    The specific trap guarded here is `csv.Error`, which is NOT a `ValueError`
    (`_csv.Error.__mro__` is `(_csv.Error, Exception, BaseException, object)`), so a field
    over `csv`'s 131,072-character limit escapes a `(OSError, ValueError)` handler as an
    uncaught traceback. That is the twin the sibling discovered a release after fixing its
    first instance; it is handled here from the start.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    (root / "metrics_summary.csv").write_text(
        '"' + "A" * 200_000 + '",x\n1,2\n', encoding="utf-8")

    entries = module.run_import(root, tmp_path / "out")
    report = _report(tmp_path / "out")
    assert report["provenance"].get("metrics_summary_unreadable") is True, (
        "the damaged optional file degraded SILENTLY — the report claims a provenance it "
        "could not read")
    # The half that came off the MATRIX survives, which is why this degrades rather than refuses.
    assert report["provenance"]["pipeline"] == MF.SOFTWARE_VERSION
    assert report["provenance"]["library_id"] == MF.LIBRARY_ID
    # …and no key was invented to stand in for the ones it could not fill.
    assert "sample_id" not in report["provenance"]
    assert HF.entry_by_id(entries, "spatial-coordinates")


def test_TEST_5_no_provenance_key_is_written_as_a_PLACEHOLDER(tmp_path):
    """TEST-5 [acceptance, INV-5] — "a key nobody could fill is DROPPED, never written as unknown".

    The general form of the rule over the one block that is assembled from several sources.
    A reader must not be able to mistake this importer's placeholder for the vendor's answer,
    so there must be no `null`, no empty string, and no "unknown"/"n/a"/"not recorded" VALUE
    anywhere in `provenance` — the report's own HTML says "not recorded" where a key is
    absent, which is a rendering choice and must not leak back into the data.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    provenance = _report(tmp_path / "out")["provenance"]
    for key, value in provenance.items():
        assert value is not None, f"provenance[{key!r}] is null"
        if isinstance(value, str):
            assert value.strip(), f"provenance[{key!r}] is an empty string"
            assert value.strip().lower() not in {"unknown", "n/a", "na", "none",
                                                 "not recorded", "-"}, (
                f"provenance[{key!r}] is a placeholder standing in for the vendor's answer")
