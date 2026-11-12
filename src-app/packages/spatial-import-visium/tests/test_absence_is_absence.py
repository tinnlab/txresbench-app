#!/usr/bin/env python3
# ruff: noqa
"""What the importer does NOT emit, asserted by ENUMERATION.

An over-emitting importer and a correct one produce the same green test whenever the
assertions are "X exists". The only way to check a deliberate absence is to enumerate the
whole emitted set and compare it — which is what this file does, twice: once for the
identity of the outputs (INV-5) and once for their COUNT under a changed input size
(INV-10).
"""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

#: The COMPLETE emitted set, by output id. Every addition to this list is a deliberate
#: act, and every deletion from it is caught. `txr_deps`' run-environment record is
#: appended by `write_manifest`, not by `run_import`, so it is not in this set.
EXPECTED_OUTPUTS = {
    "expression",
    "metadata-column:barcode",
    "metadata-column:gene_id",
    "metadata-column:gene_symbol",
    "spatial-coordinates",
    "metadata-column:in_tissue",
    "metadata-column:array_row",
    "metadata-column:array_col",
    "metadata-column:platform",
    "metadata-column:measurement_unit",
    "metadata-column:spatial_x",
    "metadata-column:spatial_y",
    "visium-import-report",
    "visium-import-summary",
    # #155. The vendor subset ships `tissue_hires_image.png` and no lowres, so exactly ONE
    # image artifact appears here. That is the point of the set being exact: the count is
    # one per PRESENT vendor image, and a bundle carrying both yields two (asserted in
    # `test_spatial_image.py::test_two_images_at_different_scalefactors_...`).
    "spatial-image-hires",
}

#: `MAX_OUTPUTS` in the platform's own output handling. The importer must sit far under
#: it, and — the part that matters — must sit under it INDEPENDENTLY of the input's size.
MAX_OUTPUTS = 512


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    out = tmp_path_factory.mktemp("visium-absence")
    module, entries = VF.run_over(VF.FIXTURE, out)
    return {"out": out, "entries": entries, "module": module}


def test_the_emitted_set_is_exactly_the_declared_one(imported):
    """TEST-5 [acceptance] [invariant: INV-5] — absence is absence.

    The design drops five inputs, each with a reason: the raw (unfiltered) matrix doubles
    storage for ambient signal; the vendor's own `analysis/` is a vendor's analysis, not
    our provenance; the BAM and `molecule_info.h5` are tens of GB with no datatype to land
    in; `web_summary.html` / `metrics_summary.csv` are the vendor's report, whose CONTENTS
    are summarised and whose VERSION FIELDS are lifted into provenance; and the two
    diagnostic JPEGs are "diagnostics, not data" — embedded in the report, never emitted.
    """
    ids = {e["id"] for e in imported["entries"]}
    assert ids == EXPECTED_OUTPUTS, (
        f"unexpected: {sorted(ids - EXPECTED_OUTPUTS)}; missing: "
        f"{sorted(EXPECTED_OUTPUTS - ids)}"
    )
    # (No per-name substring loop here. Set EQUALITY above already forbids every dropped
    # input by construction — a loop restating nine of them read as an independent check and
    # was not one: no mutation ever reached it, because the equality fires first.)
    #
    # #155 landed the image, so the scope boundary that used to be asserted here ("no
    # spatial/image") is inverted rather than deleted: EXACTLY ONE image, because the
    # vendor subset carries exactly one image file. The diagnostics stay excluded — they
    # are "diagnostics, not data" and are still embedded in the report, never emitted, and
    # that is the distinction this equality is really guarding.
    images = [e for e in imported["entries"] if e["datatype"] == "spatial/image"]
    assert len(images) == 1, f"expected one image artifact, got {[e['id'] for e in images]}"
    # (No diagnostics loop here, for the reason the comment above already gives: the set
    # EQUALITY fires first, so a loop asserting `aligned_fiducials.jpg` never became an
    # artifact is unreachable by any mutation. Adding an image path is exactly when that
    # temptation arises; the equality already covers it.)


def test_the_vendor_diagnostics_appear_only_inside_the_report(imported):
    """TEST-5 (cont.) — "embed them in the report HTML instead of emitting artifacts"."""
    out = imported["out"]
    html = (Path(out) / "visium-import-summary.html").read_text()
    assert html.count("data:image/jpeg;base64,") == 2, (
        "the two vendor diagnostics must be INLINE in the report; the fixture ships both"
    )
    for name in ("aligned_fiducials.jpg", "detected_tissue_image.jpg"):
        assert name in html
        assert not (Path(out) / name).exists(), f"{name} was written as an output file"
    # The structured half a machine reads, in the same document.
    assert 'id="visium-import-summary"' in html or "visium-import-summary" in html


def test_a_diagnostic_over_the_inline_cap_is_omitted_and_said_so(imported, tmp_path):
    """The cap is not silent.

    A vendor JPEG can be several megabytes; inlining it unbounded would make the report
    the largest artifact the import produces. The refusal to inline must SAY it refused —
    a report that quietly renders one image where the bundle had two is indistinguishable
    from a bundle that only had one.
    """
    module = imported["module"]
    big = tmp_path / "huge.jpg"
    big.write_bytes(b"\xff\xd8" + b"\x00" * (module.DIAGNOSTIC_INLINE_CAP_BYTES + 1))
    assert module.inline_diagnostic(big) is None
    small = tmp_path / "small.jpg"
    small.write_bytes((VF.FIXTURE / "spatial" / "aligned_fiducials.jpg").read_bytes())
    assert module.inline_diagnostic(small).startswith("data:image/jpeg;base64,")
    assert module.inline_diagnostic(tmp_path / "nope.jpg") is None

    report = {"kind": "k", "coordinate_space": "s", "n_spots": 1, "n_genes": 1,
              "measured_entity_label": "l", "microns_per_pixel_source": "vendor",
              "provenance": {}, "diagnostics_omitted": ["huge.jpg"]}
    html = module.render_report_html(report, {})
    assert "huge.jpg" in html and "inline cap" in html


def test_the_importer_WIRES_the_cap_to_the_report_not_merely_the_two_halves(tmp_path):
    """The leg the two unit checks above cannot reach: that `run_import` connects them.

    Proving `inline_diagnostic` declines over the cap, and separately that the renderer
    prints a notice for a hand-built list, leaves the producer's own bookkeeping unasserted —
    so a run could silently render ONE image where the bundle had TWO, which the docstring
    itself says is "indistinguishable from a bundle that only had one". This drives a real
    bundle whose diagnostic IS over the cap and reads the emitted report.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    over_cap = bundle / "spatial" / "aligned_fiducials.jpg"
    over_cap.write_bytes(b"\xff\xd8" + b"\x00" * (module.DIAGNOSTIC_INLINE_CAP_BYTES + 1))

    module.run_import(bundle, tmp_path / "out")
    report = json.loads((tmp_path / "out" / "visium-import-report.json").read_text())
    assert report["diagnostics_omitted"] == ["aligned_fiducials.jpg"], (
        "the over-cap diagnostic was dropped SILENTLY — the report shows one image where the "
        "bundle had two and says nothing"
    )
    html = (tmp_path / "out" / "visium-import-summary.html").read_text()
    assert html.count("data:image/jpeg;base64,") == 1
    assert "aligned_fiducials.jpg" in html and "inline cap" in html


def test_the_fan_out_is_bounded_and_independent_of_the_input_size(tmp_path):
    """TEST-10 [acceptance] [invariant: INV-10] — no per-row, per-gene or per-tile artifact.

    The bound the design states is `MAX_OUTPUTS = 512`, but "14 < 512 on this fixture" is
    a property of the fixture, not of the importer. The checkable statement is that the
    count does not MOVE when the input's size does — which is what rules out a per-gene or
    per-tile fan-out, the failure mode that only shows up on a real dataset.
    """
    _m, big = VF.run_over(VF.FIXTURE, tmp_path / "big")
    small_bundle = VF.make_resized(tmp_path, n_spots=30, n_genes=40)
    _m, small = VF.run_over(small_bundle, tmp_path / "small")

    assert len(big) == len(small) == len(EXPECTED_OUTPUTS)
    assert len(big) < MAX_OUTPUTS // 8, (
        f"{len(big)} outputs leaves too little headroom under MAX_OUTPUTS={MAX_OUTPUTS}"
    )
    assert {e["id"] for e in big} == {e["id"] for e in small}
    # …and the two really were different sizes, or the test proved nothing.
    big_report = json.loads((tmp_path / "big" / "visium-import-report.json").read_text())
    small_report = json.loads((tmp_path / "small" / "visium-import-report.json").read_text())
    assert big_report["n_spots"] > small_report["n_spots"]
    assert big_report["n_genes"] > small_report["n_genes"]


# TEST-1 (#359): the HD refusal's runtime pin — pointer + true platform-gap content,
# and NO issue number in the emitted message (per TESTS.md).
def test_visium_hd_is_refused_by_name_rather_than_partly_imported(tmp_path):
    """A platform this importer does not read is refused, not approximated.

    Visium HD emits several bin resolutions from one run under identically-named files.
    Picking one would produce a dataset that looks complete and silently is one arbitrary
    resolution of several — so the refusal names the platform, keeps the true gap
    content, and points the reader at the HD importer instead of at an issue.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    (bundle / "binned_outputs" / "square_008um").mkdir(parents=True)
    (bundle / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5").write_bytes(b"")
    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_members(bundle)
    message = str(exc.value)
    # The corrected destination (INV-2): the pointer at the HD importer, never an issue.
    assert "Import Visium HD (Space Ranger binned_outputs)" in message
    # The true platform-gap content survived (INV-3).
    assert "hide the platform gap rather than close it" in message
    assert "identically-named files" in message and "basename member matching" in message
    # No issue number at all (INV-1): the corrected message defers to nothing.
    assert re.search(r"#\s*\d+", message) is None, f"the refusal names an issue: {message}"
    assert "#160" not in message


def test_an_incomplete_bundle_is_refused_rather_than_half_imported(tmp_path):
    """A missing member is a refusal, not a partial import.

    Coordinates with no matrix to align to are not a smaller success; they are an artifact
    whose `aligned_to` points at a row space that does not exist in this dataset.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    (bundle / "filtered_feature_bc_matrix.h5").unlink()
    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_members(bundle)
    assert "filtered feature-barcode matrix" in str(exc.value)


def test_a_barcode_with_no_position_is_refused_rather_than_placed(tmp_path):
    """Absence is absence, on the row that matters most.

    A spot with no position cannot be given one. Writing a placeholder coordinate would
    put those spots somewhere real-looking on the tissue — a picture that is wrong in a
    way no downstream check can see.
    """
    import csv

    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    path = bundle / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(path.open(newline="")))
    dropped = rows[0:1] + rows[2:]  # remove one real spot's row
    with path.open("w", newline="") as fh:
        csv.writer(fh).writerows(dropped)
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, tmp_path / "out")
    assert "no row in" in str(exc.value) and "placeholder" in str(exc.value)
