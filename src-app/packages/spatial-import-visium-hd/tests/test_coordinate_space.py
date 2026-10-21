#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 / TEST-3 — the two design invariants about the coordinates themselves.

Both are ACCEPTANCE tests: each is written against the DESIGN's promise, not against what
the code happens to do, so each carries a leg that would go RED if the invariant were
violated by an implementation that still passed every internal consistency check.

* **INV-1** — "Coordinates are stored in FULL-RESOLUTION PIXELS, always."
  (`docs/design/spatial-storage-layout.md` §7.3 rule 1, now on `main`
  — restored by #315 (`b34d4371`) and re-verified against that merged text.)
* **INV-3** — "Axis order is a named trap. `tissue_positions.csv` gives `pxl_row_*` (y)
  *before* `pxl_col_*` (x); `obsm['spatial']` convention is `(x, y)`. The importer must
  transpose, and the test for it must assert on a **non-square** fixture — a square image
  passes a transposed affine silently." (§7.3 rule 5.)

The design calls the transpose "the single most likely bug in the whole importer" and says
outright that getting it wrong "does not error". That is why the assertions below are
paired with CONTROLS: a test that only checks the right answer cannot tell a correct
importer from a fixture too symmetric to distinguish one.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402


def _positions_by_barcode(bin_um):
    """The fixture's own parquet, read INDEPENDENTLY of the importer's reader.

    Through `pyarrow` directly rather than through `module.read_positions`: an assertion that
    ran the importer's reader on both sides would compare the reader with itself, which is
    the tautology D2 warns about.
    """
    import pyarrow.parquet as pq

    path = HF.FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" / "tissue_positions.parquet"
    table = pq.read_table(path).to_pydict()
    return {
        bc: (table["pxl_col_in_fullres"][i], table["pxl_row_in_fullres"][i])
        for i, bc in enumerate(table["barcode"])
    }


def _imported(tmp_path, bin_um=None):
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out", requested_bin=bin_um)
    coords = HF.read_member(tmp_path / "out", "spatial/coordinates.zarr", "coordinates")
    barcodes = HF.read_values(tmp_path / "out", "axis/barcode.zarr")
    return module, entries, coords, [str(b) for b in barcodes]


# ── TEST-1: full-resolution pixels, and nothing else ────────────────────────────────


def test_TEST_1_the_coordinates_are_the_vendors_own_FULLRES_pixels(tmp_path):
    """TEST-1 [acceptance, INV-1] — every emitted coordinate IS the vendor's full-res pixel value.

    Compared per BARCODE, not positionally: the filtered matrix holds the in-tissue subset in
    its own order, so a positional comparison would agree with a transposed, shuffled or
    re-sorted importer just as readily.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    expected = _positions_by_barcode(module.DEFAULT_BIN_UM)

    assert len(barcodes) == coords.shape[0]
    for i, bc in enumerate(barcodes):
        x, y = expected[bc]
        assert coords[i, 0] == np.float32(x)
        assert coords[i, 1] == np.float32(y)


def test_TEST_1_no_emitted_coordinate_is_a_SCALED_one(tmp_path):
    """TEST-1 [acceptance, INV-1] — the leg that makes this about the DESIGN and not the code.

    §7.3 rule 1's reason for full-resolution storage is that "storing hires-scaled coordinates
    would bake in a choice of image, and a second image (CytAssist, a post-hoc H&E) would then
    be unplaceable". An importer that multiplied by `tissue_hires_scalef` would still produce
    a self-consistent dataset: the coordinates would agree with the hires image, every
    internal check would pass, and only a SECOND image would ever reveal it.

    So this asserts the negative directly. If flipping the invariant off would not turn a test
    red, the test proves nothing about the invariant.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    scalefactors = json.loads(
        (HF.FIXTURE / "binned_outputs" / f"square_{module.DEFAULT_BIN_UM:03d}um" /
         "spatial" / "scalefactors_json.json").read_text(encoding="utf-8")
    )
    expected = _positions_by_barcode(module.DEFAULT_BIN_UM)
    fullres = np.asarray([expected[b] for b in barcodes], dtype=np.float64)

    for key in ("tissue_hires_scalef", "tissue_lowres_scalef"):
        scaled = fullres * scalefactors[key]
        assert not np.allclose(coords, scaled, rtol=1e-4), (
            f"the emitted coordinates match the vendor's positions scaled by `{key}` — the "
            "coordinates were stored in an IMAGE's frame rather than in the full-resolution "
            "pixel frame, which makes every other image unplaceable"
        )


def test_TEST_1_the_coordinates_declare_the_IDENTITY_affine_in_PIXELS(tmp_path):
    """TEST-1 [acceptance, INV-1] — §7.3 rule 2: the coordinates map into their own space by identity.

    Read out of the STORE's own `attributes.cyto` — the declaration that crosses into a
    sandbox (#211) — and not off the `meta` dict the writer was handed, because it is the
    stored copy a consumer reads.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    declared = HF.store_declarations(tmp_path / "out", "spatial/coordinates.zarr")

    assert declared["unit"] == "pixel"
    assert list(declared["to_space"]) == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    assert declared["coordinate_space"] == HF.entry_by_id(
        entries, "spatial-coordinates")["meta"]["coordinate_space"]


def test_TEST_1_the_micron_scale_is_the_vendors_STATED_number(tmp_path):
    """TEST-1 — DEC-6: HD states `microns_per_pixel`, so this importer never derives one.

    The negative half is the one worth having: the value must NOT equal any quotient of a
    rendered-spot constant over `spot_diameter_fullres`. That derivation is what #222 got
    wrong by 15.4 % on every Visium import and what #257 got wrong per slide design; this
    module contains neither constant, and this assertion is what keeps it that way.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    report = json.loads(
        (tmp_path / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    scalefactors = report["scalefactors"]

    assert report["microns_per_pixel"] == scalefactors["microns_per_pixel"]
    assert report["microns_per_pixel_source"] == "vendor"
    for rendered_um in (55.0, 60.0, 65.0, 70.0):
        derived = rendered_um / scalefactors["spot_diameter_fullres"]
        assert not np.isclose(report["microns_per_pixel"], derived, rtol=1e-9), (
            f"the micron scale equals {rendered_um} / spot_diameter_fullres — this importer "
            "derived a scale instead of reading the one Visium HD states, which is the "
            "defect class (#222/#257) it exists not to have"
        )


# ── TEST-3: the transpose, on a NON-SQUARE fixture, with its control ────────────────


def test_TEST_3_column_0_is_x_and_column_1_is_y(tmp_path):
    """TEST-3 [acceptance, INV-3] — the transpose, asserted against the vendor's own column names.

    `pxl_col_in_fullres` is x and goes in column 0; `pxl_row_in_fullres` is y and goes in
    column 1. The parquet writes them in the other order, which is the trap.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    import pyarrow.parquet as pq

    path = (HF.FIXTURE / "binned_outputs" / f"square_{module.DEFAULT_BIN_UM:03d}um" /
            "spatial" / "tissue_positions.parquet")
    table = pq.read_table(path).to_pydict()
    index = {bc: i for i, bc in enumerate(table["barcode"])}

    for i, bc in enumerate(barcodes):
        j = index[bc]
        assert coords[i, 0] == np.float32(table["pxl_col_in_fullres"][j])
        assert coords[i, 1] == np.float32(table["pxl_row_in_fullres"][j])


def test_TEST_3_the_TRANSPOSED_read_would_be_a_DIFFERENT_array(tmp_path):
    """TEST-3 [acceptance, INV-3] — the CONTROL the design explicitly asks for.

    §7.3 rule 5: "the test for it must assert on a **non-square** fixture — a square image
    passes a transposed affine silently". Without this leg, the assertion above would pass
    unchanged on a fixture whose x and y happened to coincide, and the guard would be
    vacuous while looking rigorous.

    So the transposed array is CONSTRUCTED here and asserted to differ. If a later fixture
    edit made the lattice square, this goes red — which is the point.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    transposed = coords[:, ::-1]
    assert not np.array_equal(coords, transposed), (
        "the emitted coordinates are equal to their own transpose, so this fixture cannot "
        "distinguish a correct importer from a transposed one — the fixture must stay "
        "NON-SQUARE (see `make_fixture.py`'s geometry block and TEST-33)"
    )


def test_TEST_3_the_fixture_is_NON_SQUARE_in_both_the_lattice_and_the_image(tmp_path):
    """TEST-3 — the precondition the control above depends on, asserted where it lives.

    Stated twice on purpose: once as a property of the emitted array (above) and once as a
    property of the FIXTURE (here). The first can be satisfied by accident on a square
    fixture with an asymmetric tissue mask; the second cannot.
    """
    assert MF.FULLRES_W != MF.FULLRES_H
    assert MF.NATIVE_ROWS != MF.NATIVE_COLS
    for bin_um in MF.BINS:
        rows, cols = MF.bin_shape(bin_um)
        assert rows != cols, f"the {bin_um} um lattice is square, which makes TEST-3 vacuous"


def test_TEST_3_the_1D_component_columns_are_BIT_IDENTICAL_to_the_2D_member(tmp_path):
    """TEST-3 — #183 Option A: `spatial_x`/`spatial_y` mirror the 2-D member exactly.

    Bit-identical, not merely close: they are the SAME numbers at the same dtype, and a
    consumer that draws the tissue map from the 1-D siblings after a filter must land the
    bins in the same places as one that reads the 2-D member. A tolerance here would hide a
    transpose in the siblings that the 2-D member does not have.
    """
    module, entries, coords, barcodes = _imported(tmp_path)
    xs = HF.read_values(tmp_path / "out", f"metadata/{module.COMPONENT_X}.zarr")
    ys = HF.read_values(tmp_path / "out", f"metadata/{module.COMPONENT_Y}.zarr")

    assert np.array_equal(np.asarray(xs, dtype=np.float32), coords[:, 0])
    assert np.array_equal(np.asarray(ys, dtype=np.float32), coords[:, 1])

    entry = HF.entry_by_id(entries, "spatial-coordinates")
    assert entry["meta"]["component_columns"] == [module.COMPONENT_X, module.COMPONENT_Y]


# ── TEST-38: what NAMES the coordinate space, and what may never name it ────────────


def _no_library_id(tmp_path, *, keep_metrics=True):
    """A bundle whose matrix declares no `library_ids`, metrics optional.

    Everything else is the good fixture, so the only variable is the run's identity.
    """
    root = HF.staged_tree(tmp_path)
    for bin_um in MF.BINS:
        MF.write_matrix_h5(
            Path(root) / "binned_outputs" / f"square_{bin_um:03d}um"
            / "filtered_feature_bc_matrix.h5",
            bin_um, MF.positions_rows(bin_um),
            attrs={
                "chemistry_description": MF.CHEMISTRY,
                "filetype": "matrix",
                "original_gem_groups": np.array([1]),
                "software_version": MF.SOFTWARE_VERSION,
                "version": np.int64(2),
            },
        )
    if not keep_metrics:
        (Path(root) / "metrics_summary.csv").unlink()
    return root


def test_TEST_38_the_space_falls_back_to_the_metrics_SAMPLE_ID_not_to_a_directory(tmp_path):
    """TEST-38 — the second rung is a fact ABOUT THE RUN, and it is the LAST rung.

    §7.3 rule 2 says the coordinate space is "identified by the library id". When the matrix
    carries none, the only other identity inside the bundle is `metrics_summary.csv`'s
    `Sample ID` — the vendor's own name for the run — so that is the fallback, and the report
    says which rung it used.

    What must NOT happen is the sibling's third rung, the bundle DIRECTORY NAME. In the
    layout a real sandbox presents, a multi-file dataset spreads across `/inputs` itself, so
    that name is the constant `inputs`: every identity-less HD bundle would declare
    `coordinate_space = "visium-hd:inputs"` and two unrelated runs would place themselves in
    ONE frame — a false collision no later reader can detect. That case is refused, and the
    refusal is swept by TEST-8/TEST-9 (`no-run-identity`); this test pins the rung that keeps
    the refusal from firing on a bundle that DOES identify itself.
    """
    module = HF.load_compute()
    root = _no_library_id(tmp_path)
    entries = module.run_import(root, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))

    assert report["coordinate_space_source"] == "metrics-sample-id", (
        f"the space was named by {report['coordinate_space_source']!r} — with no "
        f"`library_ids` the only remaining fact about this run is the metrics `Sample ID`")
    assert report["coordinate_space"] == f"visium-hd:metrics-sample-id:{MF.SAMPLE_ID}", (
        f"the space is {report['coordinate_space']!r}, which is not the vendor's own "
        f"`Sample ID` for this run")
    assert "inputs" not in report["coordinate_space"], (
        "the coordinate space was named after the upload directory; two unrelated bundles "
        "would then declare the same frame")

    coords_meta = HF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert coords_meta["coordinate_space"] == report["coordinate_space"]


def test_TEST_38_the_library_id_still_WINS_when_both_are_present(tmp_path):
    """TEST-38 — the control: the fallback must not have become the rule.

    The good fixture carries both a `library_ids` attribute and a metrics `Sample ID`, and
    they are DIFFERENT strings — so "the library id wins" is a claim this fixture can
    falsify rather than one it satisfies by accident.
    """
    assert MF.LIBRARY_ID != MF.SAMPLE_ID, (
        "the fixture's library id and sample id are the same string, so the precedence "
        "assertion below cannot fail and proves nothing")
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert report["coordinate_space_source"] == "library_id"
    assert report["coordinate_space"] == f"visium-hd:library_id:{MF.LIBRARY_ID}"


def test_TEST_38_an_ABSENT_scale_source_is_the_VENDORED_CONSTANT(tmp_path):
    """TEST-38 — `micron_scale`'s "unavailable" is the CONSTANT, and this is asserted
    STRUCTURALLY because the value cannot tell you.

    ## Why the obvious test is worthless here

    The first version of this test read `expected = SD.SCALE_SOURCE_UNAVAILABLE` out of the
    same live module the compute imports and compared it to what the compute returned. Both
    sides move together, so a hand-copied literal that happens to agree is indistinguishable
    from the constant — and `spatial_declarations.py` defines
    `SCALE_SOURCE_UNAVAILABLE = "unavailable"`, i.e. EXACTLY the literal that was there
    before. A blind audit reverted the fix (`return None, "unavailable"`) and all 362 tests
    stayed green. The docstring's claim that reading it out of the vendored module "cannot go
    green against a stale copy of the name" was precisely backwards: reading it from there is
    what makes it blind.

    ## What is asserted instead

    1. STRUCTURALLY, over the module's own source: the `return` that produces the absent-scale
       source names `SD.SCALE_SOURCE_UNAVAILABLE`, not a string literal. This is the only leg
       that can see the defect, because the defect is invisible in the value.
    2. BEHAVIOURALLY, that the value is still what the contract accepts — so a constant that
       is named but wrong is caught by the other side.
    """
    module = HF.load_compute()
    source = Path(module.__file__).read_text(encoding="utf-8")

    # (1) The structural leg. `micron_scale`'s absent-scale return, read out of the source.
    body = source[source.index("def micron_scale("):]
    body = body[:body.index("\ndef ")]
    returns = [ln.strip() for ln in body.split("\n") if ln.strip().startswith("return None,")]
    assert len(returns) == 1, (
        f"`micron_scale` has {len(returns)} absent-scale return(s); this guard reads exactly "
        f"one: {returns!r}")
    assert "SD.SCALE_SOURCE_UNAVAILABLE" in returns[0], (
        f"`micron_scale` spells its absent-scale source as a LITERAL: {returns[0]!r}. It must "
        f"name `SD.SCALE_SOURCE_UNAVAILABLE`, because the two are the same STRING today and a "
        f"rename in `spatial_declarations` would otherwise surface as a declaration refusal "
        f"at run time on a user's bundle rather than as a red test here.")

    # (2) The behavioural leg — the named constant is still the one the contract takes.
    expected = module.SD.SCALE_SOURCE_UNAVAILABLE
    value, reported = module.micron_scale({"tissue_hires_scalef": 0.2})
    assert value is None and reported == expected

    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"drop": ("microns_per_pixel",)}})
    module.run_import(root, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert report["microns_per_pixel_source"] == expected


def test_TEST_46_the_vendors_SPOT_DIAMETER_rides_the_COORDINATES_artifact(tmp_path):
    """TEST-46 — §7.3 rule 4, which was implemented and pinned by nothing.

    > `spot_diameter_fullres` rides in the coordinates artifact's `meta`.

    An entity is an AREA, not a point: a renderer that does not know its size cannot draw it
    at every zoom, and the only place the size can come from is the vendor's own key. The
    committed fixture really carries it (`spot_diameter_fullres: 80.0`) and the shipped run
    really puts it on the coordinates entry -- so this was never a vacuous branch. MEASURED at
    FIX_ROUND-4: gating the block to `if False and …` made the renderer-facing disc size
    vanish from the artifact and left the ENTIRE package suite green. The only tests that
    mentioned the key asserted about the COPY IN THE REPORT and about the scale NOT being
    derived from it -- never about it reaching the artifact a client reads.

    Three legs, because two of them are what keep the assertion honest:

    1. the value is on the coordinates entry's `meta`, under the VENDOR'S OWN key, and it is
       the vendor's own number rather than anything derived from it;
    2. the fixture is asserted to CARRY the key, so the test cannot pass by measuring an
       absence;
    3. the ABSENCE case (INV-5): a bundle whose scale document states no `spot_diameter_fullres`
       emits NO such key at all -- not `null`, not a default disc size. Without this leg the
       first one is satisfied by an importer that fabricates a diameter.
    """
    scalefactors = json.loads(
        (HF.FIXTURE / "binned_outputs" / "square_008um" / "spatial"
         / "scalefactors_json.json").read_text(encoding="utf-8"))
    assert "spot_diameter_fullres" in scalefactors, (
        "the committed fixture carries no `spot_diameter_fullres`, so this test would pass "
        "on an importer that never emits one")

    _module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    meta = HF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert meta.get("spot_diameter_fullres") == scalefactors["spot_diameter_fullres"], (
        "§7.3 rule 4: the renderer-facing disc size is not on the coordinates artifact, or is "
        f"not the vendor's own number: {meta.get('spot_diameter_fullres')!r} vs "
        f"{scalefactors['spot_diameter_fullres']!r}")

    root = HF.staged_tree(tmp_path / "absent",
                          scalefactor_overrides={8: {"drop": ("spot_diameter_fullres",)}})
    _module2, absent_entries = HF.run_over(root, tmp_path / "out-absent")
    absent_meta = HF.entry_by_id(absent_entries, "spatial-coordinates")["meta"]
    assert "spot_diameter_fullres" not in absent_meta, (
        "INV-5: a bundle that states no spot diameter was given one anyway: "
        f"{absent_meta.get('spot_diameter_fullres')!r}")


# ── TEST-50: the frame identity, after #327/#328 landed on main ────────────────────


#: `(id, the raw `library_ids` attribute, why it is not a frame)`. Every door the sibling's
#: `vendor_frame_label` closed at #327/#328, asked of THIS module's copy.
#:
#: Each row is the FALSE-COLLISION direction: two unrelated runs answering one frame id, which
#: `resolveOverlayBinding` compares by equality and by nothing else — so one tissue's image is
#: silently registered against the other's bins. Nothing in the repo would have gone red on any
#: of them: the sibling's tests are package-scoped, and this module read the identity through
#: the PROVENANCE reader, which stringifies a number and `", "`-joins an array.
NOT_A_FRAME = (
    ("placeholder-unknown", "unknown"),
    ("placeholder-zeroes", "0000000_0000000"),
    ("placeholder-na", "N/A"),
    ("blank", "   "),
    ("non-identifying-subject", "library"),
    ("non-identifying-whole-key", "library_id"),
    ("reserved-derived-namespace", "unverified-space:0123456789abcdef0123456789abcdef"),
    # THE NAMESPACES THIS PACKAGE ACTUALLY WRITES (#377). Before it, the reserved token here
    # was the SIBLING's `slide_id+region_name:` — a namespace nothing writes under `visium-hd:`
    # and a vocabulary this platform has no nouns for, while the two tokens this module DOES
    # emit were reserved by nobody. These two rows are that refusal, re-pointed at the real
    # thing.
    ("reserved-own-library-namespace", "library_id:HD_Colon_01"),
    ("reserved-own-metrics-namespace", "metrics-sample-id:HD_Colon_01"),
    ("reserved-namespace-case-folded", "UNVERIFIED-SPACE:0123456789abcdef"),
    ("reserved-own-namespace-case-folded", "Library_ID:HD_Colon_01"),
)


@pytest.mark.parametrize("case", NOT_A_FRAME, ids=[c[0] for c in NOT_A_FRAME])
def test_TEST_50_a_value_that_IDENTIFIES_NOTHING_is_not_the_frame(case):
    """TEST-50 — `library_ids` must IDENTIFY the run, not merely be present.

    Before this, rung 1 was `_nonblank(provenance["library_id"])`: any non-blank value became
    the coordinate frame every artifact of the run declares. `library_ids: "unknown"` is the
    value #327 MEASURED on the sibling — two unrelated tissues both saying `"unknown"` declared
    to share one frame — and it was live here.

    A reserved namespace is the attacker-input half of the same rule: the `.h5` is untrusted, so
    "no vendor writes `unverified-space:`" is a claim about attacker input and is ENFORCED
    rather than assumed. Case-folded, because the claim is about what a READER can tell apart.
    """
    _case_id, raw = case
    module = HF.load_compute()
    assert module.vendor_frame_label({"library_ids": raw}) is None, (
        f"{raw!r} was accepted as this run's coordinate frame, so two unrelated runs stating "
        "it would place themselves in ONE frame — the false collision this ladder exists to "
        "prevent")


def test_TEST_50_a_MULTI_VALUED_or_NUMERIC_library_id_is_not_ONE_stated_value():
    """TEST-50 — #328's non-injective join, and the unfilterable identity beside it.

    `library_ids` is PLURAL and array-shaped in every real bundle, and the provenance reader
    joins a multi-element array with a bare `", "` — right for the provenance block, which is
    EVIDENCE and must show what the vendor wrote, and WRONG here, because that join is not
    injective: `[b"A", b"B"]` and `[b"A, B"]` are two different vendor statements that both
    became `visium-hd:A, B`. A NUMERIC attribute is the other half: both identity predicates
    are blind to anything but a string, so a number is an UNFILTERABLE identity in the one
    field whose whole job is not to falsely collide.
    """
    import numpy as np

    module = HF.load_compute()

    two = module.vendor_frame_label({"library_ids": np.array([b"A", b"B"])})
    joined = module.vendor_frame_label({"library_ids": np.array([b"A, B"])})
    assert two is None, f"a two-element `library_ids` was read as ONE stated value: {two!r}"
    # The control that makes the first assertion mean something: the JOINED spelling is a real,
    # single, stated value and IS a frame — so the two are told apart rather than both refused.
    assert joined == "A, B", f"the single quoted value stopped being a frame: {joined!r}"

    assert module.vendor_frame_label({"library_ids": np.array([0])}) is None, (
        "a NUMERIC `library_ids` became the frame; both identity predicates are blind to it")
    assert module.vendor_frame_label({"library_ids": np.array([1.5])}) is None
    assert module.vendor_frame_label({}) is None


def test_TEST_50_the_CONTROL_a_real_library_id_is_the_frame_VERBATIM(tmp_path):
    """TEST-50 — the control, without which every assertion above is satisfied by refusing all.

    The vendor's STATEMENT is carried VERBATIM: `vendor_frame_label` returns the string the
    vendor wrote, whole, and the emitted id is that string after its rung's namespace token and
    nothing else — not escaped, not folded, not truncated. Driven through the shipped
    entrypoint, not only through the predicate.

    The TOKEN is #377 and is asserted here too, on the rung the good fixture actually takes: the
    id is `visium-hd:library_id:<value>`, so it cannot equal the id an unrelated run's metrics
    `Sample ID` answers with. TEST-51 is where that cross-rung claim is proved end to end; this
    is the control that the token did not eat the value on the way.
    """
    module = HF.load_compute()
    assert module.vendor_frame_label({"library_ids": MF.LIBRARY_ID}) == MF.LIBRARY_ID
    assert module.vendor_frame_label(
        {"library_ids": np.array([MF.LIBRARY_ID.encode()], dtype="|S32")}) == MF.LIBRARY_ID

    _module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert report["coordinate_space"] == f"visium-hd:library_id:{MF.LIBRARY_ID}", (
        report["coordinate_space"])
    assert report["coordinate_space_source"] == "library_id"


def test_TEST_50_a_non_identifying_library_id_FALLS_THROUGH_rather_than_refusing(tmp_path):
    """TEST-50 — the LADDER still works: rung 1 narrowing must not skip rung 2.

    A bundle whose `library_ids` identifies nothing but whose `metrics_summary.csv` states a
    `Sample ID` still has a frame, and it is the sample id — a MISSED collision at worst,
    recoverable by re-exporting, which is the error direction this module chooses everywhere.
    Narrowing rung 1 into a refusal here would have been the over-correction.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(Path(root) / "binned_outputs" / "square_008um"
                   / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("library_ids", "unknown", dtype=h5py.string_dtype("utf-8"))

    # THE PATH-PRESERVING LAYOUT, because `metrics_summary.csv` is an OPTIONAL RUN-ROOT member
    # and is structurally absent from the flattened staging — so rung 2 only exists on this arm.
    HF.run_over(root, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    assert report["coordinate_space_source"] == "metrics-sample-id", (
        f"a placeholder `library_ids` did not fall to the sample-id rung: "
        f"{report['coordinate_space_source']!r}")
    assert report["coordinate_space"] == f"visium-hd:metrics-sample-id:{MF.SAMPLE_ID}"
    # And the PROVENANCE still says what the vendor wrote — it is EVIDENCE, not identity.
    assert report["provenance"]["library_id"] == "unknown", report["provenance"]


def test_TEST_50_and_with_NO_rung_2_EITHER_the_run_is_REFUSED_not_named_anyway(tmp_path):
    """TEST-50 — the bottom of this module's ladder is a REFUSAL, and the narrowing reaches it.

    On the FLATTENED layout a real sandbox stages, `metrics_summary.csv` is not a declared
    member and is structurally absent, so a placeholder `library_ids` leaves the run with no
    identity at all. This module has no third rung — the sibling's directory-name rung is the
    one #327 DELETED, and this package never had it — so the answer is a refusal, before the
    first writer, with nothing on disk.

    That is what makes narrowing rung 1 here STRICTLY narrowing: #320 measured that gating an
    upper rung while the bottom is still a SHARED value moves bundles onto the wider collision,
    and withdrew the change. A bottom that refuses cannot be shared by anything.
    """
    import h5py

    root = HF.staged_tree(tmp_path)
    with h5py.File(Path(root) / "binned_outputs" / "square_008um"
                   / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("library_ids", "unknown", dtype=h5py.string_dtype("utf-8"))

    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    out = tmp_path / "out-flat"
    result = HF.run_entry(inputs, out)
    assert result.returncode == 2, result.stderr[-1500:]
    assert not list(out.rglob("*")), (
        f"the identity refusal left paths on disk: {sorted(p.name for p in out.rglob('*'))[:5]}")
    assert "Traceback" not in result.stderr
    assert "library_ids" in result.stderr, (
        f"the refusal does not name the field the operator can fix: {result.stderr[-400:]}")


def test_TEST_50_the_key_suffix_rule_MATCHES_the_sibling_it_was_ported_from():
    """TEST-50 — the ported tuple must not drift from the package it was ported from.

    This module carries its OWN copy of the identity predicates, which is this repo's
    established shape for them (`spatial-import-visium` and `spatial-import-xenium` each carry
    one, and neither lives in `spatial-types`). A copy that silently narrows is how the two
    start disagreeing about what identifies a frame, so the equality is asserted rather than
    intended — and it is asserted against the SIBLING'S SOURCE, so widening it there fails
    here on the next run instead of leaving this package quietly behind.
    """
    import ast

    source = (HF.PACKAGES / "spatial-import-visium" / "compute" / "import_visium.py").read_text(
        encoding="utf-8")
    tree = ast.parse(source)
    sibling = None
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "_NON_IDENTIFYING_KEY_SUFFIXES"):
            sibling = ast.literal_eval(node.value)
    assert sibling is not None, (
        "`_NON_IDENTIFYING_KEY_SUFFIXES` is gone from `spatial-import-visium` — this package's "
        "copy is now a rule with no source, and the divergence this test exists to catch has "
        "already happened")
    module = HF.load_compute()
    assert tuple(module._NON_IDENTIFYING_KEY_SUFFIXES) == tuple(sibling), (
        f"this package's key-suffix rule {module._NON_IDENTIFYING_KEY_SUFFIXES} has drifted "
        f"from the sibling's {sibling}")

    for name in ("_VENDOR_PLACEHOLDERS", "RESERVED_SPACE_PREFIXES"):
        their = None
        for node in ast.walk(tree):
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == name):
                their = ast.literal_eval(node.value) if name == "_VENDOR_PLACEHOLDERS" else None
        if their is not None:
            assert tuple(getattr(module, name)) == tuple(their), (
                f"this package's `{name}` has drifted from the sibling's")


# ── TEST-51: the two rungs are two NAMESPACES, so they cannot answer one frame (#377) ──


#: The one string run A states as its `library_ids` and run B states as its metrics `Sample ID`.
#: An operator's own name for a run — which is exactly what BOTH fields hold in practice, and
#: why the two rungs are adjacent in the ladder at all. #377's headline row, verbatim.
COLLIDER = "HD_Colon_01"


def _states_only_a_library_id(tmp_path, value):
    """Run A: `library_ids = value`, and NO `metrics_summary.csv` at all.

    The metrics file is removed rather than merely differing, so run A's whole stated identity
    is the one field — there is no second statement that could be doing the work.
    """
    root = HF.staged_tree(tmp_path)
    for bin_um in MF.BINS:
        MF.write_matrix_h5(
            Path(root) / "binned_outputs" / f"square_{bin_um:03d}um"
            / "filtered_feature_bc_matrix.h5",
            bin_um, MF.positions_rows(bin_um),
            attrs={
                "chemistry_description": MF.CHEMISTRY,
                "filetype": "matrix",
                "library_ids": np.array([value.encode()], dtype="|S64"),
                "original_gem_groups": np.array([1]),
                "software_version": MF.SOFTWARE_VERSION,
                "version": np.int64(2),
            },
        )
    (Path(root) / "metrics_summary.csv").unlink()
    return root


def _states_only_a_metrics_sample_id(tmp_path, value):
    """Run B: no `library_ids` on the matrix, and `metrics_summary.csv` states `Sample ID`."""
    root = _no_library_id(tmp_path)
    metrics = Path(root) / "metrics_summary.csv"
    text = metrics.read_text(encoding="utf-8")
    assert MF.SAMPLE_ID in text, text
    metrics.write_text(text.replace(MF.SAMPLE_ID, value), encoding="utf-8")
    return root


def _space_of(root, out):
    _module, entries = HF.run_over(root, out)
    report = json.loads((Path(out) / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    coords = HF.entry_by_id(entries, "spatial-coordinates")["meta"]["coordinate_space"]
    assert coords == report["coordinate_space"], (coords, report["coordinate_space"])
    return report["coordinate_space"], report["coordinate_space_source"]


def test_TEST_51_a_library_id_and_an_unrelated_runs_SAMPLE_ID_are_TWO_frames(tmp_path):
    """TEST-51 [acceptance, #377] — THE HEADLINE. Two rungs, one string, two frames.

    Driven END TO END through `run_import` over two separately staged bundles, because the
    defect is in the VALUE that reaches the artifact and nothing short of the artifact proves
    it moved:

        run A: library_ids='HD_Colon_01', no metrics_summary  -> rung 1
        run B: no library_ids, Sample ID='HD_Colon_01'        -> rung 2

    Before #377 both answered `visium-hd:HD_Colon_01` and `resolveOverlayBinding`
    (`libs/viz/src/viz-core/spatial/coordinateBinding.ts`) — which compares the frame VALUE by
    equality and by NOTHING ELSE, `coordinate_space_source` included — therefore declared run
    A's image placeable against run B's bins. One tissue registered against another, silently.

    Four legs, and the last two are what stop this passing for the wrong reason:

    1. the two ids DIFFER;
    2. each is its own rung's token followed by the vendor's string, WHOLE — so the fix is a
       namespace and not a mangling, and the operator's own name is still readable in the id;
    3. the two runs really did state the SAME string, asserted directly — without this the test
       passes on two bundles that were never in collision;
    4. the PRE-FIX id both bundles would have emitted is reconstructed and shown to be ONE
       value. That is the collision, exhibited, rather than asserted to be absent.
    """
    module = HF.load_compute()
    a_id, a_source = _space_of(_states_only_a_library_id(tmp_path / "A", COLLIDER),
                               tmp_path / "out-A")
    b_id, b_source = _space_of(_states_only_a_metrics_sample_id(tmp_path / "B", COLLIDER),
                               tmp_path / "out-B")

    assert (a_source, b_source) == ("library_id", "metrics-sample-id"), (a_source, b_source)

    # (1) THE INVARIANT: two unrelated runs are never declared to share one coordinate frame.
    assert a_id != b_id, (
        f"run A's `library_ids` and run B's metrics `Sample ID` — two DIFFERENT vendor "
        f"statements about two unrelated runs — both answered {a_id!r}. That is one tissue's "
        f"image registered against the other's bins, and no later reader can detect it: "
        f"`resolveOverlayBinding` compares the frame value by equality and nothing else.")

    # (2) Each id is its rung's namespace token and then the vendor's string, unaltered.
    assert a_id == f"visium-hd:library_id:{COLLIDER}", a_id
    assert b_id == f"visium-hd:metrics-sample-id:{COLLIDER}", b_id
    assert a_id.endswith(COLLIDER) and b_id.endswith(COLLIDER)

    # (3) The control. The two bundles must genuinely state the SAME string, or leg (1) is
    #     satisfied by two runs that were never in collision to begin with.
    a_report = json.loads((tmp_path / "out-A" / "visium-hd-import-report.json").read_text(
        encoding="utf-8"))
    b_report = json.loads((tmp_path / "out-B" / "visium-hd-import-report.json").read_text(
        encoding="utf-8"))
    assert a_report["provenance"]["library_id"] == COLLIDER, a_report["provenance"]
    assert "sample_id" not in a_report["provenance"], a_report["provenance"]
    assert b_report["provenance"]["sample_id"] == COLLIDER, b_report["provenance"]
    assert "library_id" not in b_report["provenance"], b_report["provenance"]

    # (4) The collision itself, exhibited: strip each rung's token and the two are ONE value —
    #     which is precisely the id both bundles emitted before #377.
    a_bare = a_id[len("visium-hd:") + len(module.LIBRARY_ID_SPACE_PREFIX):]
    b_bare = b_id[len("visium-hd:") + len(module.METRICS_SAMPLE_ID_SPACE_PREFIX):]
    assert a_bare == b_bare == COLLIDER, (a_bare, b_bare)
    assert f"visium-hd:{a_bare}" == f"visium-hd:{b_bare}", (
        "the pre-#377 framing is reconstructed here to show what it answered; if these ever "
        "differ this test has stopped exhibiting the collision it exists to close")


def test_TEST_51_the_rung_TOKENS_are_PREFIX_FREE_and_ARE_the_sources_they_report():
    """TEST-51 — the property the id shape rests on, asserted over the SET.

    A single stated component needs no length prefix — it is the last thing in the id, so the
    suffix after the token IS the value (design §4.1's first property; the sibling's
    `framed_frame_components` is for the MULTI-component case, which this ladder does not have).
    What it does need is a token set in which no token is a PREFIX of another: then the token an
    id opens with is unambiguous and `<token><value>` is injective in `(rung, value)`.

    Asserted over `STATED_SPACE_PREFIXES` rather than over the two strings, because the failure
    this guards is a THIRD rung added later: a rung tokened `library_id:v2:` reads as a
    reasonable name and reintroduces #377 exactly — `library_id:` with the value `v2:X` is the
    same id. And each token is its own `coordinate_space_source` plus `:`, so the id says which
    rung answered it and the two can never drift.
    """
    module = HF.load_compute()
    tokens = tuple(module.STATED_SPACE_PREFIXES)
    assert len(tokens) == len(set(tokens)) and len(tokens) >= 2, tokens

    for one in tokens:
        for other in tokens:
            if one is not other:
                assert not other.startswith(one), (
                    f"{one!r} is a prefix of {other!r}, so an id opening with {other!r} is also "
                    f"a legal {one!r} id and the two rungs can answer one frame — #377")

    sources = (module.LIBRARY_ID_SOURCE, module.METRICS_SAMPLE_ID_SOURCE)
    assert tokens == tuple(f"{s}:" for s in sources), (tokens, sources)

    # The namespaces this module WRITES are the ones the vendor may not forge. Before #377 this
    # tuple held the SIBLING's `slide_id+region_name:` — a token nothing writes under
    # `visium-hd:`, in a vocabulary this platform has no nouns for — and neither token this
    # module actually emits was in it.
    reserved = tuple(module.RESERVED_SPACE_PREFIXES)
    for token in tokens:
        assert token in reserved, (
            f"this module emits ids under {token!r} and refuses no vendor value that opens "
            f"with it: {reserved}")
    assert module.UNVERIFIED_SPACE_PREFIX in reserved, reserved
    assert "slide_id+region_name:" not in reserved, (
        "the sibling's COMPOSED token is back in this package's reserved set; this platform "
        "has no slides and no regions, and the namespaces to guard are the ones it writes")


def test_TEST_51_EVERY_rung_of_the_ladder_emits_under_a_TOKEN_structurally():
    """TEST-51 — the leg that survives a rung this test file has never heard of.

    Every assertion above names the two rungs that exist today, so all of them are satisfied by
    a THIRD rung added tomorrow that returns a bare `f"visium-hd:{value}"` — which is #377,
    reintroduced, with this file green. So the ladder's returns are read out of the module's own
    source and each one is required to name a namespace constant.

    Structural rather than behavioural for the reason `micron_scale`'s TEST-38 leg records: the
    defect is invisible in any single value. A bare rung-3 id is a perfectly well-formed string.
    """
    module = HF.load_compute()
    source = Path(module.__file__).read_text(encoding="utf-8")
    body = source[source.index("def coordinate_space_id("):]
    body = body[:body.index("\ndef ")]
    returns = [ln.strip() for ln in body.split("\n")
               if ln.strip().startswith("return (") or ln.strip().startswith("return f")]
    assert len(returns) == 2, (
        f"`coordinate_space_id` has {len(returns)} value-returning rung(s); this guard reads "
        f"the two the ladder is documented to have: {returns!r}")
    for line in returns:
        assert "PLATFORM_SPACE_PREFIX" in line and "_SPACE_PREFIX}" in line, (
            f"a rung of the ladder emits an id that is not opened by a namespace token: "
            f"{line!r}. Two rungs emitting into one undelimited space is #377: a value at one "
            f"rung equals an id at the other, and nothing downstream can tell.")


def test_TEST_51_a_vendor_value_CANNOT_impersonate_the_OTHER_rung(tmp_path):
    """TEST-51 — the untrusted-input half. The `.h5` is attacker-controlled.

    Two doors, and both must hold, because the reserved-prefix refusal and the token framing
    each close one of them:

    1. a `library_ids` FORGING the other rung's token is refused as an identity outright, and
       the run falls to the rung below rather than emitting a value a reader would attribute to
       `metrics_summary.csv`;
    2. and even a value that were NOT refused could not collide, because rung 1's id opens with
       `library_id:` — so the framing, not only the refusal, is what makes the namespaces
       disjoint. Asserted by driving the ladder directly with a forged value at the rung that
       does not refuse it.
    """
    module = HF.load_compute()

    forged = f"{module.METRICS_SAMPLE_ID_SPACE_PREFIX}{COLLIDER}"
    assert module.vendor_frame_label({"library_ids": forged}) is None, (
        f"{forged!r} was accepted as this run's frame identity, so a hostile `.h5` can emit an "
        f"id a reader attributes to the metrics `Sample ID` rung")

    # The refusal is symmetric — a metrics `Sample ID` forging rung 1's token is refused too,
    # and with no third rung to fall to, the run is REFUSED by name rather than named anyway.
    with pytest.raises(module.VisiumImportError):
        module.coordinate_space_id(
            {"sample_id": f"{module.LIBRARY_ID_SPACE_PREFIX}{COLLIDER}"}, {})

    # Door 2: the FRAMING, not the refusal, is what makes the namespaces disjoint. This value
    # CARRIES rung 1's token and is accepted (the refusal is about what a value OPENS with), and
    # the id it produces still cannot be one rung 1 could ever answer, because rung 1's ids open
    # with `library_id:` and this one opens with `metrics-sample-id:`.
    honest, honest_source = module.coordinate_space_id({"sample_id": COLLIDER}, {})
    carried = f"x:{module.LIBRARY_ID_SPACE_PREFIX}{COLLIDER}"
    impostor, impostor_source = module.coordinate_space_id({"sample_id": carried}, {})
    assert honest_source == impostor_source == "metrics-sample-id"
    assert honest != impostor
    assert not impostor.startswith(f"visium-hd:{module.LIBRARY_ID_SPACE_PREFIX}"), (
        f"a metrics `Sample ID` emitted an id in RUNG 1's namespace: {impostor!r}")
    assert impostor == f"visium-hd:metrics-sample-id:{carried}", impostor
