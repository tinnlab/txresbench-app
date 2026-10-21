#!/usr/bin/env python3
# ruff: noqa
"""ABSENCE IS ABSENCE — every deliberate drop is named, and nothing is fabricated.

Design §7.2's rule for what a Visium import drops: "**Dropped, deliberately, and each with a
reason** (INV-3: **absence is absence, never a fabricated value**)." The Xenium bundle has
more to drop than the Visium one — a z the vendor never states, a protein modality that is
not counts, a pyramid we recompute rather than reuse, and two whole artifact families that
belong to #163/#164 — so the rule does more work here.

The tests that matter are the ones a passive read cannot pass: it is not enough that a `z`
column is absent, because a producer that never thought about z looks identical to one that
declined it. So the number a z could have been FABRICATED FROM — `z_step_size`, which both
real bundles state — is asserted to appear nowhere.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    out = tmp_path_factory.mktemp("absence-prime")
    module, entries = XF.run_over(XF.PRIME, out)
    report = json.loads((Path(out) / "xenium-import-report.json").read_text())
    return {"out": out, "entries": entries, "report": report, "bundle": XF.PRIME}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    out = tmp_path_factory.mktemp("absence-protein")
    module, entries = XF.run_over(XF.PROTEIN, out)
    report = json.loads((Path(out) / "xenium-import-report.json").read_text())
    return {"out": out, "entries": entries, "report": report, "bundle": XF.PROTEIN}


# ── the z that was never measured ────────────────────────────────────────────────────


def test_the_coordinates_are_exactly_two_components(prime):
    """TEST-2 [acceptance] [invariant: INV-1] — a producer ALWAYS emits (n x 2).

    The failure this prevents is SILENT INVISIBILITY, not an error: the shipped Coordinates
    section selects on `dims: 2` with exact equality and fails closed, so an honest (n x 3)
    artifact would simply never appear, with every gate green.
    """
    entry = XF.entry(prime["entries"], "spatial-coordinates")
    arr = CZR.read_array(prime["out"] / "spatial/coordinates.zarr", "coordinates")
    assert arr.ndim == 2 and arr.shape[1] == 2
    assert entry["meta"]["n_dims"] == 2


def test_no_z_column_is_emitted_in_any_form(prime, protein):
    """TEST-2 — the negative, across every channel a z could have arrived through."""
    for ctx in (prime, protein):
        meta = XF.entry(ctx["entries"], "spatial-coordinates")["meta"]
        assert "z_column" not in meta, (
            "the sibling-column declaration must be absent, not present-and-null"
        )
        ids = {e["id"] for e in ctx["entries"]}
        for forbidden in ("metadata-column:z", "metadata-column:z_centroid",
                          "metadata-column:spatial_z", "metadata-column:z_location"):
            assert forbidden not in ids

        # AND THE VALUE CHECK, because a blacklist of four names is a blacklist of four
        # names. A blind mutation emitted the identical fabrication under the name `z_um`
        # and this whole file stayed green — the claim is about a VALUE that was invented,
        # so the assertion has to be about values. Every per-cell numeric column the
        # importer emits is read back and compared against the one number a z could have
        # been fabricated FROM.
        step = XF.experiment(ctx["bundle"])["z_step_size"]
        for entry in ctx["entries"]:
            if entry["datatype"] != "metadata-column" or entry.get("axis") != "cells":
                continue
            values = CZR.read_column(ctx["out"] / entry["path"])
            values = np.asarray(values)
            if values.dtype.kind not in "fiu":
                continue
            assert not (values.size and np.all(values == step)), (
                f"{entry['id']} is a constant column equal to `z_step_size` ({step}). "
                "That is a fabricated z wearing a different name — the rule is about the "
                "value, not about the four spellings the line above happens to list."
            )


def test_z_step_size_is_stated_by_the_vendor_and_used_by_NOTHING(prime, protein):
    """TEST-2 — THE DISCRIMINATING ARM, and the reason this file exists.

    Both real bundles state `z_step_size: 3.0`. It describes the spacing of the IMAGE's
    focal planes, not a cell position — so it is exactly the number a producer would reach
    for to synthesise a z, and exactly the fabrication INV-1 forbids ("never write z = 0 for
    a 2-D platform" generalises to "never write a z you did not measure").

    Asserting that a z column is absent proves nothing about intent. Asserting that the ONE
    available source for a fabricated z appears in NO coordinate or column artifact is the
    check with teeth: it goes red the moment somebody helpfully derives one.
    """
    for ctx, bundle in ((prime, XF.PRIME), (protein, XF.PROTEIN)):
        step = XF.experiment(bundle)["z_step_size"]
        assert step == 3.0, "the premise: the vendor really does state a z step"

        for entry in ctx["entries"]:
            if entry["datatype"] not in ("spatial/coordinates", "metadata-column"):
                continue
            blob = json.dumps(entry["meta"])
            assert "z_step_size" not in blob, (
                f"{entry['id']} carries the vendor's z step; a position artifact that "
                "records it is one edit away from deriving a z from it"
            )
        arr = CZR.read_array(ctx["out"] / "spatial/coordinates.zarr", "coordinates")
        assert not np.any(arr == step), (
            "and no coordinate value equals it, which is the crude form of the same check"
        )
        assert "z_note" in ctx["report"], (
            "the absence must be SAID, in the artifact a human reads — otherwise a reader "
            "cannot tell a declined z from a forgotten one"
        )
        assert "z_step_size" in ctx["report"]["z_note"], (
            "and the note must name the number it declined to use"
        )


# ── every other deliberate drop ──────────────────────────────────────────────────────


def test_every_drop_is_named_with_a_reason(protein):
    """TEST-10 [acceptance] [invariant: INV-10] — §7.2's rule, applied to this bundle.

    A drop with no reason in the report is indistinguishable from a bug, and the reader who
    finds it three analyses later has no way to tell.
    """
    report = protein["report"]

    protein_class = report["feature_classes"]["Protein Expression"]
    assert protein_class["disposition"] == "dropped from the expression matrix"
    assert protein_class["n_features"] > 0, "the premise: there really are protein features"
    assert "protein_scaling_factor" in protein_class["reason"]
    assert "not integer UMI counts" in protein_class["reason"]

    # EVERY control class is dropped too (design §6.5), and each names both its reason and
    # the per-cell column that carries its total — a drop with no forwarding address reads
    # as data loss even when nothing measurable was lost.
    controls = {name: info for name, info in report["feature_classes"].items()
                if info["disposition"] == "dropped from the expression matrix"
                and name != "Protein Expression"}
    assert controls, "the premise: the real bundle carries control classes"
    for name, info in controls.items():
        assert "QC input, not expression" in info["reason"], name
        assert info["per_cell_column"], (
            f"{name} names no per-cell column; the class total IS emitted and the report "
            "must say where"
        )
        assert f"metadata-column:{info['per_cell_column']}" in \
            {e["id"] for e in protein["entries"]}, (
            f"{name} points at {info['per_cell_column']!r}, which is not an emitted column"
        )

    assert "z_note" in report
    assert report["scale_referent"]["does_not_close"], (
        "even the LIMIT of the scale check is named — a limitation recorded only in a "
        "design document is one the reader of the data never sees"
    )


def test_the_vendor_pyramid_is_not_reused_and_the_recomputation_is_declared(prime):
    """TEST-10 — the drop that is easiest to mistake for an oversight.

    The vendor SHIPS a 5-level pyramid whose level 1 has the same grid a factor-2 box mean
    would produce. It is deliberately not reused: `display_derivative_provenance` states
    that every emitted pixel is "the mean of a real block of real measurements", and 10x
    does not document the kernel behind its own levels. Emitting a vendor level under that
    provenance would make the claim FALSE. So level 0 is read and the box mean is ours.
    """
    import tifffile

    source = XF.PRIME / "morphology_focus" / "morphology_focus_0000.ome.tif"
    with tifffile.TiffFile(str(source)) as handle:
        assert len(handle.series[0].levels) == 5, (
            "the premise: the vendor really does ship a pyramid we are declining to reuse"
        )

    derivative = XF.entry(prime["entries"], "spatial-image-morphology")["meta"][
        "display_derivative"
    ]
    assert derivative["lossless"] is True
    assert derivative["downsample_factor"] == 3, (
        "and the factor is #176's rule (ceil(0.5 / 0.2125) = 3), NOT a vendor level index — "
        "level 1 would have been factor 2 and is the tempting shortcut this declines"
    )
    assert derivative["original_source"].endswith("morphology_focus_0000.ome.tif")


def test_nothing_absent_is_written_as_a_placeholder(prime, protein):
    """TEST-10 — the positive form of the rule: no fabricated values anywhere.

    A dropped fact written as `"unknown"`, `null` or `0` is worse than an absent key,
    because a reader cannot tell our placeholder from the vendor's answer.
    """
    for ctx in (prime, protein):
        for entry in ctx["entries"]:
            meta = entry["meta"] or {}
            provenance = meta.get("provenance")
            if provenance:
                for key, value in provenance.items():
                    assert value is not None, f"{entry['id']}.provenance.{key} is null"
                    if key == "matrix_library_id":
                        # DELIBERATELY exempt: this key exists to RECORD the placeholder the
                        # Visium rule would have used as identity, and its uselessness is
                        # DEC-7's evidence. Dropping it would hide the finding.
                        continue
                    assert str(value).strip().lower() not in (
                        "unknown", "n/a", "na", "none", "null", "-", ""
                    ), (
                        f"{entry['id']}.provenance.{key} is a placeholder, not the "
                        "vendor's answer. The vendor writing \"N/A\" in a field does not "
                        "make it a fact; absence is absence."
                    )

        # No emitted numeric per-cell column is entirely zero — the shape a fabricated
        # column takes. (Control columns can be legitimately all-zero on a tiny bundle, so
        # the check is restricted to the positional ones, which never are.)
        for name in ("spatial_x", "spatial_y"):
            values = CZR.read_array(ctx["out"] / f"metadata/{name}.zarr", "values")
            assert np.any(values != 0), f"{name} is entirely zero"


def test_the_out_of_scope_vendor_members_are_left_in_the_bundle_untouched(prime):
    """TEST-10 — #163 and #164's data is DROPPED HERE, deliberately, and stays recoverable.

    The container's own description promises the bundle is retained so "the vendor's own
    images, cell boundaries and transcript table stay recoverable". This asserts the
    importer emits nothing from them rather than half-importing them.
    """
    # TEST-14 [covers: ITEM-11] — NARROWED by #163, not deleted.
    #
    # `spatial/boundaries` left this list because #163 built the producer: when a bundle
    # carries a `cell_boundaries.parquet` it is now imported, as a long vertex table plus
    # two offset columns. The `prime` fixture has NO such file, so on THIS bundle the
    # importer still emits nothing from it — which is what the assertion below now says,
    # and it is a stronger statement than the old one: it holds because of the
    # absence-is-absence path rather than because the capability does not exist.
    #
    # `spatial/transcripts` (#164) is still unbuilt and stays in the forbidden set, as does
    # `nucleus_boundaries` — a second boundary ROLE is not distinguishable from the first
    # in the declaration as it stands, so emitting one would be a claim the type cannot
    # carry.
    ids = {e["id"] for e in prime["entries"]}
    for forbidden in ("spatial-transcripts", "transcripts", "nucleus-boundaries"):
        assert forbidden not in ids
    assert not [e for e in prime["entries"]
                if e["datatype"] == "spatial/transcripts"]
    assert "spatial-boundaries" not in ids, (
        "the prime bundle has no `cell_boundaries.parquet`, so a boundaries artifact here "
        "would have been synthesised from nothing"
    )
    assert not [e for e in prime["entries"] if e["datatype"] == "spatial/boundaries"]
    assert not list(XF.PRIME.rglob("cell_boundaries.*")), (
        "this assertion's premise moved: the fixture gained a boundaries file, so 'no "
        "boundaries artifact' now proves the importer is broken rather than that the "
        "bundle has none"
    )
    # And the files really are in the bundle this import did not consume.
    assert (XF.PRIME / "cell_feature_matrix.h5").exists()
