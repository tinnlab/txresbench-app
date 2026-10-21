#!/usr/bin/env python3
# ruff: noqa
"""The micron scale is per SLIDE DESIGN, and the assay is named in the report (#257).

## What this suite is for

`spatial-import-visium` derives every micron measurement from
`rendered_spot_diameter_um / spot_diameter_fullres`. #222 fixed that numerator at 65 um and
verified it against the slide's manufactured 100 um pitch on one committed vendor bundle.
#257 is the same question one assay over — and the answer turned out to be that the ASSAY is
the wrong key.

10x documents the field itself: it "can vary for different slide designs, ranging from
60-70 um". Measured over 24 real vendor bundles there are three designs, each identified
EXACTLY by `fiducial_diameter_fullres / spot_diameter_fullres` (21/13, 3/2, 7/4) and each
implying a round rendered diameter against the 100 um pitch (65, 70, 60). The full table and
its provenance are in `docs/design/visium-slide-design-scale.md`.

## The shape every load-bearing test here takes

The pin is #222's, once per design: compute the numerator **the importer ACTUALLY APPLIED** —
recovered from the emitted artifact as `microns_per_pixel * spot_diameter_fullres` — and hold
it against the numerator **the vendor's own two files IMPLY**,
`100 um / (measured_pitch_px / spot_diameter_fullres)`. Neither side reads a constant of ours.
That detail is load-bearing and was learned the hard way on #222: a blind audit restored the
defect at the call site and the version of this test that compared against
`module.VISIUM_RENDERED_SPOT_DIAMETER_UM` stayed green.

## Why the DLPFC-shaped case is in here

`test_the_assay_does_not_decide_the_constant` builds a bundle with NO CytAssist signal at all
and the 3/2 ratio. That is not a hypothetical: eight spatialLIBD DLPFC sections are exactly
that — direct-placement Visium, `chemistry_description: "custom"`, from before the CytAssist
instrument existed — and they render at 70 um. It is the executable form of "an assay-keyed
constant is already measured to be wrong", and it is the test that would go red if someone
'simplified' the classifier back to `if cytassist: 70`.
"""
import copy
import csv
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

PKG = VF.PKG
PROVENANCE = VF.FIXTURE.parent / "PROVENANCE.json"

#: Fixture byte budgets, per directory. Same purpose as `test_image_coherence`'s
#: `FIXTURE_BUDGET_BYTES` and set the same way — a little above what is committed today, so
#: adding a vendor IMAGE to one of these is a DECISION that fails a test rather than a
#: drive-by that quietly triples the checkout.
#: Raised deliberately when the positions tables went from 170-row windows to the vendor's
#: COMPLETE tables (4,992 and 14,336 rows). That was not a drive-by: a blind audit measured
#: that a producer switching its numerator on `len(positions) >= 1000` passed this entire
#: suite and the cross-package gate while putting a 21.4% error on every real bundle, because
#: no committed fixture reached the threshold. #243 is the precedent — an undersized image
#: fixture hid an incoherent artifact for months — and the cost is ~700 KB of vendor CSV
#: against a class of defect that no check here could see.
FIXTURE_BUDGETS = {
    VF.CYTASSIST_V4: 260_000,
    VF.CYTASSIST_V5_11MM: 700_000,
}


def modules():
    """`(import_visium, registration_qc)`, loaded the way the sandbox stages them."""
    module = VF.load_compute()
    return module, sys.modules["registration_qc"]


@pytest.fixture(autouse=True)
def _restore_mutated_module_attributes():
    """Put back anything a test moved on the SHIPPED module.

    Several tests here mutate `SLIDE_DESIGNS`, `SLIDE_DESIGN_RATIO_TOLERANCE` and
    `CYTASSIST_SCALEFACTOR_KEY` — that is how the mutation battery measures whether a constant
    is load-bearing — and they left the mutated module in
    `sys.modules['spatial_import_visium_entry']` for the rest of the session.

    Nothing leaked, and a blind audit verified that across eight shuffled seeds of this file
    and three shuffled cross-package runs. But it did not leak for an ACCIDENTAL reason:
    `visium_fixtures.load_compute()` re-execs the file on every call, and every sibling suite
    that reaches into `sys.modules` happens to call it first in the same test. An invariant
    that holds because of a coincidence in someone else's file is one that breaks the day that
    file changes, so this makes it structural. `pytest-randomly` is not installed here, so
    ordering would not have surfaced the regression either.
    """
    # ONLY the entry module — the one name this file's tests actually mutate (a blind audit
    # counted all 15 mutations and every one targets it). An earlier cut also popped
    # `registration_qc`, `ome_writer` and `spatial_declarations`, and that BROKE A SIBLING
    # SUITE order-dependently: several `spatial-import-xenium` tests do a bare
    # `import spatial_declarations` and rely on some earlier suite having installed it,
    # corroborated three ways including a controlled A/B over two trees differing only in this
    # file. Evicting a SHARED name to clean up after mutating a DIFFERENT module is collateral
    # damage.
    staged = ("spatial_import_visium_entry",)
    yield
    # EVICT, do not "restore if it is still the same object". The first cut did the latter and
    # was a NO-OP in exactly the cases it was written for: every mutating test calls
    # `modules()` -> `VF.load_compute()`, which re-execs the file and installs a NEW module
    # object under that name, so the identity check never held. A blind audit instrumented the
    # teardown and measured 34 of 40 teardowns restoring nothing — and caught a corrupted
    # 2-row `SLIDE_DESIGNS` still sitting in `sys.modules` afterwards.
    #
    # Evicting is what actually holds, and it holds for the right reason: `load_compute()`
    # rebuilds every staged name from its file, so the next reader gets the shipped module
    # whatever this test did to the last one. It is also honest about what it cannot do — a
    # reference a test already captured is still mutated; what is guaranteed is that nothing
    # REACHING THROUGH sys.modules can see it.
    for name in staged:
        sys.modules.pop(name, None)


def _import(root, out):
    module, RQ = modules()
    entries = module.run_import(Path(root), Path(out))
    module.write_manifest(Path(out), entries)
    report = json.loads((Path(out) / "visium-import-report.json").read_text())
    return module, RQ, entries, report


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    """Every committed bundle, imported once through the REAL entry point.

    Module-scoped because these are three full imports and nothing here mutates the result;
    each test reads its own bundle's report.
    """
    out = {}
    for root, design_id, rendered in VF.COMMITTED_BUNDLES:
        d = tmp_path_factory.mktemp(root.name)
        module, RQ, entries, report = _import(root, d)
        out[root.name] = {"dir": d, "entries": entries, "report": report,
                          "design_id": design_id, "rendered": rendered, "root": root}
    return out


def same_row_pitch_px(root):
    """The centre-to-centre pitch, BY CONSTRUCTION — the `array_col ± 2` neighbour in the
    same `array_row`.

    A second estimator, and it exists because the first one is not the same measurement.
    `registration_qc.measure_spot_pitch` takes the median NEAREST neighbour, which on a hex
    lattice is the DIAGONAL neighbour; a rendered lattice that is not exactly equilateral puts
    that up to ~0.5% below the pitch (measured: exactly 0 on the V4 subset, 0.53% on the V5
    one). So the nearest-neighbour figure is what the shipped check reports, and this one is
    what a design's constant should be compared against.

    Getting that backwards is how a test tolerance gets fitted: an earlier cut of this file
    compared the constant against the nearest-neighbour figure and needed `rel=0.006` to do
    it — sized, as a blind audit pointed out, around the one fixture with the largest
    estimator gap rather than around any stated bar.
    """
    with open(Path(root) / "spatial" / "tissue_positions.csv", newline="") as fh:
        rows = list(csv.DictReader(fh))
    at = {(int(r["array_row"]), int(r["array_col"])):
          (float(r["pxl_col_in_fullres"]), float(r["pxl_row_in_fullres"])) for r in rows}
    spans = []
    for (ar, ac), (x, y) in at.items():
        other = at.get((ar, ac + 2))
        if other is not None:
            spans.append(math.hypot(x - other[0], y - other[1]))
    assert spans, f"{Path(root).name}: no same-row neighbour pairs in the committed subset"
    return float(np.median(spans))


def vendor_ratio(root):
    """`(measured_pitch_px, spot_diameter_fullres, pitch/diameter)` — from the VENDOR'S OWN
    FILES ONLY, re-derived here rather than read off the importer's report.

    The pitch estimator is the one `registration_qc.measure_spot_pitch` uses (median nearest
    neighbour), reimplemented over the committed CSV so this side of every assertion is a
    property of the bundle and of nothing this branch wrote. `test_the_pin_reads_the_bundle`
    asserts the two agree, which is what proves the reimplementation is faithful.
    """
    spatial = Path(root) / "spatial"
    with open(spatial / "tissue_positions.csv", newline="") as fh:
        rows = list(csv.DictReader(fh))
    pts = np.asarray(
        [[float(r["pxl_col_in_fullres"]), float(r["pxl_row_in_fullres"])] for r in rows]
    )
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)
    np.fill_diagonal(d, np.inf)
    pitch = float(np.median(d.min(axis=1)))
    scalefactors = json.loads((spatial / "scalefactors_json.json").read_text())
    diameter = float(scalefactors["spot_diameter_fullres"])
    return pitch, diameter, pitch / diameter


def _positive(value):
    """A local, deliberately NAIVE re-statement of "is this a usable vendor number".

    Naive on purpose: it must not be `import_visium._positive_finite`, or the parametrised
    cases above would be asserting the predicate against itself. It only has to be right for
    the literals in `_UNIDENTIFIABLE`.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and value > 0
    except OverflowError:
        return False


def make_bundle(tmp_path, source, *, scalefactors=None, extra_files=()):
    """A copy of a committed bundle, with its `scalefactors_json.json` optionally replaced.

    Copying a REAL bundle rather than synthesising one keeps every other member the vendor's
    own, so a test that perturbs one number perturbs exactly that number.
    """
    root = Path(tmp_path) / "bundle"
    shutil.copytree(Path(source), root)
    if scalefactors is not None:
        (root / "spatial" / "scalefactors_json.json").write_text(json.dumps(scalefactors))
    for name, payload in extra_files:
        (root / "spatial" / name).write_bytes(payload)
    return root


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-1 [acceptance] [invariant: INV-4] — the headline: a REAL CytAssist bundle PASSES
# ═════════════════════════════════════════════════════════════════════════════════════


def test_a_real_cytassist_bundle_passes_the_slide_referent_it_used_to_fail(
    imported, tmp_path_factory
):
    """TEST-1 [acceptance] [invariant: INV-4] [covers: ITEM-1, ITEM-4, ITEM-9, ITEM-13].

    INV-4 is the owner's disposition: ACCEPT CytAssist, with a constant gated on a real
    bundle and a citable source. The behavioural statement of that is this one — the
    external referent, which is the only check in this arm that does not look inside the
    artifact, now PASSES on a real CytAssist bundle.

    Both halves are asserted, and the second is what makes the first mean something. A test
    that only said "it passes now" would also pass if someone widened `PITCH_TOLERANCE`, so
    the SAME bundle is imported a second time with the pre-#257 numerator forced back in, and
    that run must FAIL — at the ~7% error #257 predicted from the CellChat thread's ~92 um.
    """
    case = imported[VF.CYTASSIST_V4.name]
    scale = case["report"]["registration_qc"]["scale"]

    assert scale["verdict"] == "pass", (
        f"the CytAssist bundle's scale check says {scale['verdict']}: {scale.get('reason')}"
    )
    assert scale["expected_pitch_um"] == 100.0
    assert scale["measured_pitch_um"] == pytest.approx(100.0, rel=0.01), (
        "the CytAssist bundle's spots, read at the declared scale, are not 100 um apart"
    )
    assert scale["relative_error"] < 0.01

    # ── and the same bundle under the PRE-#257 numerator must FAIL ────────────────────
    # Forced at the constant, not at the table: this reproduces exactly what 0.9.2 did, which
    # was to divide `spot_diameter_fullres` by 65 whatever the slide was.
    module, RQ = modules()
    out = tmp_path_factory.mktemp("cytassist-pre-257")
    flat = tuple(dict(d, rendered_spot_diameter_um=65.0) for d in module.SLIDE_DESIGNS)
    module.SLIDE_DESIGNS = flat
    module.run_import(VF.CYTASSIST_V4, out)
    before = json.loads((out / "visium-import-report.json").read_text())["registration_qc"]
    assert before["scale"]["verdict"] == "fail", (
        "the pre-#257 numerator no longer fails on a CytAssist bundle, so this test can no "
        "longer tell the fix from its absence — either the tolerance moved or the fixture did"
    )
    assert before["scale"]["measured_pitch_um"] == pytest.approx(92.86, abs=1.0), (
        "the pre-#257 error on this bundle is not the ~92 um #257 quotes from "
        "jinworks/CellChat#92; that agreement is what tied the forum report to this fix"
    )
    assert before["scale"]["relative_error"] > 0.05


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-2 [acceptance] [invariant: INV-1] — the constant is a MEASUREMENT, per design
# ═════════════════════════════════════════════════════════════════════════════════════


def test_each_designs_constant_is_what_the_vendors_own_files_imply(imported):
    """TEST-2 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-3, ITEM-9, ITEM-10].

    INV-1 is "whatever number is chosen cites what it IS, not what it fixes". The executable
    form of that is: the numerator the importer applied must equal the numerator the vendor's
    own files imply, on every committed bundle, with no constant of ours on either side.

    LEFT  — `microns_per_pixel * spot_diameter_fullres` is, by construction, the numerator the
            importer divided by. Recovered from the emitted report, so it is what SHIPPED.
    RIGHT — `100 um / (measured_pitch_px / spot_diameter_fullres)`. The pixel scale cancels in
            that ratio, so it is the circle the vendor's two files describe, measured against
            the slide's manufactured pitch.

    Deliberately NOT `applied == module.SLIDE_DESIGNS[i]["rendered_spot_diameter_um"]`. That
    form reads a constant and stays green while the code divides by the wrong one — a blind
    audit demonstrated exactly that against #222's version of this test.

    ## Exactly what each leg is worth, since a blind audit read more into this than it says

    The bundle-derived leg admits ±1%, and that is not slack: it is the estimator gap between
    the nearest-neighbour pitch the importer measures and the true centre-to-centre pitch
    (~0.5% on a rendered hex lattice — `registration_qc.PITCH_TOLERANCE`'s own note derives
    the same figure). The exact leg reads `rendered`, which is a DUPLICATED declaration in
    `visium_fixtures.py` rather than the shipped table, so it is a cross-file agreement check:
    it catches a single-file edit to the shipped constant and would NOT catch someone editing
    both. That is what it is worth; the leg that carries the invariant is the first one, plus
    the same-row corroboration below at 0.4%.
    """
    module, RQ = modules()
    seen = {}
    for root, design_id, rendered in VF.COMMITTED_BUNDLES:
        case = imported[root.name]
        report = case["report"]
        pitch_px, diameter_px, ratio = vendor_ratio(root)

        applied = report["microns_per_pixel"] * diameter_px
        implied = RQ.SLIDE_SPOT_PITCH_UM / ratio
        assert applied == pytest.approx(implied, rel=0.01), (
            f"{root.name}: the importer divided `spot_diameter_fullres` into "
            f"{applied:.3f} um, but the vendor's own two files say that field spans "
            f"{implied:.3f} um (pitch/diameter against the slide's 100 um pitch). The scale "
            "numerator is measuring a different circle from the one the field measures"
        )
        # …and it is the design's stated constant, to a rounding — stated SECOND, because
        # this leg is the corroboration and the leg above is the pin.
        assert applied == pytest.approx(rendered, rel=1e-12), (
            f"{root.name}: the applied numerator {applied} is not the {rendered} um constant "
            f"of design {design_id}"
        )
        # …against the SAME-ROW estimator, which is the centre-to-centre pitch by
        # construction. The bound is DERIVED, not fitted: the worst residual over the three
        # committed bundles is the standard fixture's 0.224%, which is #222's own accepted
        # figure for 65.0 and is a number this branch did not choose. 0.004 is 1.8x that, and
        # 25x tighter than the primary leg above.
        implied_pitch = same_row_pitch_px(root) / diameter_px
        implied_same_row = RQ.SLIDE_SPOT_PITCH_UM / implied_pitch
        assert implied_same_row == pytest.approx(rendered, rel=0.004), (
            f"{root.name}: the vendor's files imply {implied_same_row:.4f} um against the "
            f"centre-to-centre pitch, which is more than 0.4% from the {rendered:g} um "
            f"constant this design ships (#222 accepted 0.224% for 65.0)"
        )
        seen[design_id] = rendered

    # THREE DESIGNS, PAIRWISE DISTINCT. Without this the suite would still pass if every row
    # collapsed onto one value, which is the pre-#257 behaviour it exists to refute.
    assert sorted(seen.values()) == [60.0, 65.0, 70.0], seen
    values = sorted(seen.values())
    for a, b in zip(values, values[1:]):
        assert (b - a) / a > 0.07, (
            f"two shipped designs are only {(b - a) / a * 100:.1f}% apart; at that separation "
            "picking the wrong one would be inside PITCH_TOLERANCE and the external referent "
            "would no longer catch it"
        )


def test_the_pin_reads_the_bundle_and_not_the_code_under_test(imported):
    """TEST-2 (cont.) [covers: ITEM-9, ITEM-10] — the pin's left-hand side is independent.

    `vendor_ratio` reimplements the pitch estimator over the committed CSV. If that
    reimplementation drifted from `registration_qc.measure_spot_pitch`, TEST-2's right-hand
    side would silently stop being the vendor's number. Asserting the two agree is what makes
    the reimplementation a re-derivation rather than a second opinion.
    """
    for root, _design_id, _rendered in VF.COMMITTED_BUNDLES:
        pitch_px, diameter_px, _ratio = vendor_ratio(root)
        reported = imported[root.name]["report"]["registration_qc"]["scale"]
        assert pitch_px == pytest.approx(reported["measured_pitch_px"], rel=1e-9), (
            f"{root.name}: the pitch this test re-derives from the vendor's positions table "
            "disagrees with the one the importer reports"
        )
        assert diameter_px == pytest.approx(
            imported[root.name]["report"]["scalefactors"]["spot_diameter_fullres"], rel=1e-12
        )


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-3 — the classifier, and its headroom
# ═════════════════════════════════════════════════════════════════════════════════════


def test_each_vendor_ratio_selects_its_own_design_and_no_other():
    """TEST-3 [covers: ITEM-1, ITEM-2, ITEM-3] — the discriminator, over the REAL numbers.

    The ratios are read out of the three committed `scalefactors_json.json` files, so this is
    not a test over literals someone typed twice. Each must match its own row inside
    `SLIDE_DESIGN_RATIO_TOLERANCE` and must be OUTSIDE that tolerance for both others by a
    wide margin — the headroom is asserted, not assumed, because a tolerance that quietly
    admitted two rows would make the whole table decorative.
    """
    module, _RQ = modules()
    tol = module.SLIDE_DESIGN_RATIO_TOLERANCE
    assert 0 < tol < 0.01, "the design tolerance has left the band its derivation sits in"

    for root, design_id, rendered in VF.COMMITTED_BUNDLES:
        sf = json.loads((root / "spatial" / "scalefactors_json.json").read_text())
        design = module.slide_design(sf)
        assert design["matched_by"] == "fiducial-spot-ratio", design
        assert design["id"] == design_id, design
        assert design["rendered_spot_diameter_um"] == rendered
        assert design["relative_error"] <= tol

        ratio = sf["fiducial_diameter_fullres"] / sf["spot_diameter_fullres"]
        for row in module.SLIDE_DESIGNS:
            error = abs(ratio - row["fiducial_over_spot"]) / row["fiducial_over_spot"]
            if row["id"] == design_id:
                assert error <= tol
            else:
                assert error > 70 * tol, (
                    f"{root.name}'s ratio {ratio!r} is only {error:.6f} from {row['id']}, "
                    f"which is under 70x the {tol:g} tolerance — the designs are no longer "
                    "cleanly separable and one bundle could be read as another"
                )

    # THE TABLE'S OWN SEPARATION, independent of any fixture. This is the property that lets
    # the tolerance be loose enough to survive a lossy round trip of the vendor's numbers.
    rows = module.SLIDE_DESIGNS
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            gap = abs(a["fiducial_over_spot"] - b["fiducial_over_spot"]) / a["fiducial_over_spot"]
            # 70x, which is the SIGNAL FLOOR the tolerance's own derivation names: the closest
            # two designs (21/13 vs 3/2) are 7.1% apart and the tolerance is 1e-3.
            assert gap > 70 * tol, (
                f"{a['id']} and {b['id']} are {gap:.4f} apart, under 70x the {tol:g} "
                "tolerance — the tolerance's derivation says the closest pair is 7.1% apart, "
                "so either a row moved or the tolerance did"
            )
    assert len({row["id"] for row in rows}) == len(rows), "two design rows share an id"


def test_the_ratios_are_the_exact_rationals_the_vendor_bundles_carry():
    """TEST-3 (cont.) [covers: ITEM-1] — the table's keys are the measured rationals.

    21/13, 3/2 and 7/4. Written as divisions rather than as decimal literals in the module,
    because 21/13 has no exact decimal and a truncated literal is a slow leak. Asserted here
    against the committed bundles' own values so the table cannot be edited to a number no
    vendor file carries.
    """
    module, _RQ = modules()
    expected = {
        "visium-6.5mm-65um-rendered-spot": 21 / 13,
        "visium-6.5mm-70um-rendered-spot": 3 / 2,
        "visium-11mm-60um-rendered-spot": 7 / 4,
    }
    assert {row["id"] for row in module.SLIDE_DESIGNS} == set(expected)
    for row in module.SLIDE_DESIGNS:
        assert row["fiducial_over_spot"] == expected[row["id"]]
        # Every row states WHERE its number came from — INV-1 in the table itself.
        assert row["source"] and len(row["source"]) > 40, row
        assert row["implied_um_measured"], row
        assert row["rendered_spot_diameter_um"] in (60.0, 65.0, 70.0)
        # THE VENDOR SPOT COUNT, which was a dead column until a blind audit measured that
        # deleting it from every row left the suite green. 10x states both figures on the
        # Space Ranger spatial-outputs page — "4,992 rows for Visium slides with a 6.5 mm
        # Capture Area and 14,336 rows for Visium slides with an 11 mm Capture Area" — so the
        # column is checkable against the capture area beside it rather than merely present.
        assert row["vendor_spot_count"] == {"6.5 mm": 4992, "11 mm": 14336}[row["capture_area"]]

    # …and 60/70 really are the endpoints of the range 10x states for this field.
    diameters = [row["rendered_spot_diameter_um"] for row in module.SLIDE_DESIGNS]
    assert min(diameters) == 60.0 and max(diameters) == 70.0, (
        "a design has left the 60-70 um range 10x documents `spot_diameter_fullres` as "
        "spanning; a value outside it needs a new citation, not a new row"
    )


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-4 — the fallback leg says WHICH kind of not-identified it was
# ═════════════════════════════════════════════════════════════════════════════════════


#: `(scalefactors, expected reason fragment, the diameter the record should ECHO)`.
#:
#: The third column is not decoration: without it the `{}` case and the
#: `{"spot_diameter_fullres": 100.0}` case take the same branch and assert byte-identical
#: things, so neither can fail independently of the other — a blind audit measured exactly
#: that, and separately measured that forcing both echo fields to `None` left the suite green.
#: The echo is what tells a reader WHICH of the two numbers the bundle actually had.
_UNIDENTIFIABLE = [
    ({"spot_diameter_fullres": 100.0}, "no usable", 100.0),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": 0.0}, "no usable", 100.0),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": -3.0}, "no usable", 100.0),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": float("inf")},
     "no usable", 100.0),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": True}, "no usable", 100.0),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": "144.6"},
     "no usable", 100.0),
    # A LONG INTEGER LITERAL. `json.loads` yields a Python int too large for a double, and
    # `math.isfinite` RAISES on it — which aborted the whole import on a bundle `origin/main`
    # read cleanly, because pre-#257 nothing read the fiducial field. A blind audit found it.
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": 10 ** 400},
     "no usable", 100.0),
    ({"spot_diameter_fullres": 10 ** 400, "fiducial_diameter_fullres": 150.0},
     "no usable", None),
    ({"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": 250.0}, "matches no", 100.0),
    ({}, "no usable", None),
]


@pytest.mark.parametrize("scalefactors,expect_in_reason,echoed_diameter", _UNIDENTIFIABLE)
def test_an_unidentifiable_slide_design_is_stated_not_silently_standard(
    scalefactors, expect_in_reason, echoed_diameter
):
    """TEST-4 [covers: ITEM-3] — absence and non-match are DIFFERENT facts, and both are said.

    The fallback keeps 65.0 — which is what every bundle got before #257, so it can only be a
    strict improvement on the behaviour it replaces — but "assumed" must never be spelled the
    same way as "identified". A reader who sees a scale verdict has to be able to tell which
    one they are looking at without opening the code.

    The `True` and `"144.6"` cases are not padding: `bool` is an `int` subclass, so an
    unguarded numeric check reads `True` as the diameter 1.0 and produces a ratio; and
    `json.loads` will hand back a string for a quoted number.
    """
    module, _RQ = modules()
    design = module.slide_design(scalefactors)
    assert design["matched_by"] == "assumed-standard"
    assert design["rendered_spot_diameter_um"] == module.VISIUM_RENDERED_SPOT_DIAMETER_UM
    assert design["rendered_spot_diameter_um"] == 65.0
    assert "ASSUMED" in design["reason"]
    assert expect_in_reason in design["reason"]
    # WHICH of the two vendor numbers the bundle actually had, echoed back. This is what makes
    # the eight cases above distinguishable from one another rather than eight spellings of
    # the same assertion.
    assert design["spot_diameter_fullres"] == echoed_diameter
    if not _positive(scalefactors.get("fiducial_diameter_fullres")):
        assert design["fiducial_diameter_fullres"] is None
    if expect_in_reason == "matches no":
        # The reason must carry the ratio it SAW, or the reader cannot tell which design 10x
        # shipped that this importer does not know about.
        assert f"{design['fiducial_over_spot']:.6f}" in design["reason"]
        assert design["nearest_design"] in {row["id"] for row in module.SLIDE_DESIGNS}


def test_an_unidentified_design_still_imports_and_the_report_says_it_was_assumed(tmp_path):
    """TEST-4 (cont.) [covers: ITEM-3, ITEM-7] — the fallback END TO END, not just the helper.

    A unit test of `slide_design` proves the helper; it never proves anything calls it. This
    drives the REAL importer over a real bundle whose fiducial has been removed, and asserts
    the import still succeeds (DEC-7: it must not refuse) and that `assumed-standard` reaches
    the report AND the rendered HTML a human actually opens.
    """
    module, _RQ = modules()
    sf = json.loads((VF.CYTASSIST_V4 / "spatial" / "scalefactors_json.json").read_text())
    sf.pop("fiducial_diameter_fullres")
    root = make_bundle(tmp_path, VF.CYTASSIST_V4, scalefactors=sf)
    out = tmp_path / "out"
    entries = module.run_import(root, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())

    assert report["slide_design"]["matched_by"] == "assumed-standard"
    assert report["microns_per_pixel"] == 65.0 / sf["spot_diameter_fullres"]
    html = (out / "visium-import-summary.html").read_text()
    assert "assumed-standard" in html, (
        "the report a human opens does not say the slide design was assumed"
    )
    # …and the scale check now FAILS and its reason SAYS the assumption is the thing to check.
    scale = report["registration_qc"]["scale"]
    assert scale["verdict"] == "fail"
    assert "ASSUMED" in scale["slide_design_note"]
    assert "check that first" in scale["slide_design_note"]
    # The `assumed-standard` guidance is the sentence the 200-char cap ate in the first cut,
    # so it is asserted in `meta` specifically and not only in the JSON.
    meta = next(e for e in entries if e["id"] == "visium-import-report")["meta"]
    assert any("ASSUMED" in l for l in meta["registration_qc"]), meta["registration_qc"]


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-5 [acceptance] [invariant: INV-2] — the report NAMES the assay
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_report_names_the_assay_it_detected(imported):
    """TEST-5 [acceptance] [invariant: INV-2] [covers: ITEM-5, ITEM-7, ITEM-9].

    INV-2 asks that a CytAssist bundle reach a DELIBERATE outcome — "an import whose report
    says which assay it detected", rather than a v1 import with no mention of CytAssist.

    Both directions are asserted, because a block that always said `visium-cytassist` would
    satisfy the positive half alone and would be a constant, not a classification. And the
    naming is checked in all three channels a reader can reach it through: the report JSON,
    the rendered HTML, and the manifest entry's `meta` (which is what the app shows without
    opening anything).
    """
    cyt = imported[VF.CYTASSIST_V4.name]
    std = imported[VF.FIXTURE.name]

    assert cyt["report"]["assay"]["assay"] == "visium-cytassist"
    assert cyt["report"]["assay"]["decided_by"] == "regist_target_img_scalef"
    assert cyt["report"]["assay"]["signals"]["regist_target_img_scalef"] is True
    assert cyt["report"]["assay"]["signals"]["chemistry_description"] == "Visium V4 Slide"
    assert "regist_target_img_scalef" in cyt["report"]["assay"]["reason"]

    assert std["report"]["assay"]["assay"] == "visium-direct-placement"
    assert std["report"]["assay"]["signals"]["regist_target_img_scalef"] is False

    for case, expected in ((cyt, "visium-cytassist"), (std, "visium-direct-placement")):
        html = (case["dir"] / "visium-import-summary.html").read_text()
        assert "Assay" in html and expected in html, (
            f"the rendered report does not name the assay as {expected}"
        )
        entry = next(e for e in case["entries"] if e["id"] == "visium-import-report")
        assert entry["meta"]["assay"] == expected, (
            "the manifest entry does not carry the assay, so the app shows a registration "
            "verdict with no way to see which assay produced it without opening the JSON"
        )


def test_the_assay_does_not_decide_the_constant(imported, tmp_path):
    """TEST-6 [covers: ITEM-5] — an assay-keyed constant is refuted, by COMMITTED data first.

    This test exists to refuse a simplification that would look reasonable in review:
    `if cytassist: 70 else: 65`. It is refused twice, and the order matters — a blind audit
    pointed out that an earlier cut led with evidence the repository does not hold.

    ## Leg 1 — refuted by a bundle THIS REPOSITORY COMMITS

    `cytassist-v5-11mm-outs` is a real CytAssist bundle (`regist_target_img_scalef` present,
    `chemistry_description: "Visium V5 Slide"`) whose rendered spot circle is **60 µm, not
    70**. So "CytAssist implies 70" is false on committed, licence-recorded, sha256-recorded
    vendor data, with no appeal to anything off-repo. That alone settles that the assay is not
    the key.

    ## Leg 2 — and the assay is not even a key that could be repaired

    Leg 1 leaves open "CytAssist 6.5 mm implies 70, everything else 65". The spatialLIBD DLPFC
    corpus refutes that too: eight direct-placement sections (`chemistry_description: "custom"`,
    `software_version: "4509.5.5"`, no `regist_target_img_scalef`, no CytAssist image — from
    before the CytAssist instrument existed) carry the exact 3/2 ratio and therefore the same
    70 µm circle.

    **That corpus is NOT committed and the numbers below are quoted, not redistributed**,
    which is stated here rather than glossed. Their provenance:

      * dataset: spatialLIBD / Maynard et al. 2021, *Nat Neurosci* 24:425-436, sample 151673;
      * file: `spatial/scalefactors_json.json`,
        sha256 `91c4beb9ca8145855a6a6df0a00eda6541931fc12d82d09cf8f01c9c15179dbc`;
      * its four values are reproduced verbatim below, and its
        `fiducial_diameter_fullres / spot_diameter_fullres` is 1.5 exactly;
      * `docs/design/visium-slide-design-scale.md` §3 lists all eight sections with their
        measured pitches and implied diameters.

    Leg 2 is therefore CORROBORATION whose source a reader can check but whose bytes this
    repository does not carry. Leg 1 is the load-bearing half and it stands on committed data.

    ## Leg 3 — the decider is the key, and the corroboration is not

    The deciding signal alone, with BOTH corroborating signals absent, still yields CytAssist;
    and a corroborating signal that CONTRADICTS is reported as that and does not flip the call.
    """
    module, _RQ = modules()

    # ── LEG 1: committed, and sufficient on its own ───────────────────────────────────
    v5 = imported[VF.CYTASSIST_V5_11MM.name]["report"]
    assert v5["assay"]["assay"] == "visium-cytassist"
    assert v5["slide_design"]["rendered_spot_diameter_um"] == 60.0, (
        "a committed, real CytAssist bundle does not render at 60 um, so this suite has lost "
        "the counter-example that refutes `if cytassist: 70` on repository data alone"
    )
    v4 = imported[VF.CYTASSIST_V4.name]["report"]
    assert v4["assay"]["assay"] == v5["assay"]["assay"]
    assert v4["slide_design"]["rendered_spot_diameter_um"] != (
        v5["slide_design"]["rendered_spot_diameter_um"]
    ), ("two committed bundles of the SAME assay resolve to the SAME numerator, so the assay "
        "would be a serviceable key after all and this test proves nothing")

    # ── LEG 2: quoted, not redistributed — see the docstring for the provenance ───────
    dlpfc_shaped = {
        "spot_diameter_fullres": 96.40082438014726,
        "fiducial_diameter_fullres": 144.6012365702209,
        "tissue_hires_scalef": 0.150015,
        "tissue_lowres_scalef": 0.045004502,
    }
    assert (dlpfc_shaped["fiducial_diameter_fullres"]
            / dlpfc_shaped["spot_diameter_fullres"]) == 1.5, (
        "the quoted spatialLIBD 151673 values no longer give the 3/2 ratio they were quoted "
        "for; one of the two literals has been edited away from the cited file"
    )
    assay = module.detect_assay(dlpfc_shaped, {"cytassist_image": False},
                               {"chemistry": "custom"})
    assert assay["assay"] == "visium-direct-placement"
    design = module.slide_design(dlpfc_shaped)
    assert design["rendered_spot_diameter_um"] == 70.0, (
        "a direct-placement bundle on the 3/2 slide design was given the 65 um constant. That "
        "is the spatialLIBD DLPFC corpus, and it is why #257's constant is keyed on the slide "
        "design and not on the assay"
    )
    assert design["matched_by"] == "fiducial-spot-ratio"

    # …and the mirror: the decider alone is enough, with nothing corroborating it.
    bare_cytassist = dict(dlpfc_shaped, regist_target_img_scalef=0.21)
    assay = module.detect_assay(bare_cytassist, {"cytassist_image": False},
                               {"chemistry": "custom"})
    assert assay["assay"] == "visium-cytassist"
    assert assay["corroborating_signals_contradicting"] == []
    assert set(assay["corroborating_signals_silent"]) == {
        "cytassist_image.tiff", "chemistry_description"
    }
    assert "silent" in assay["corroboration"]

    # A corroborating signal that CONTRADICTS is reported as that, and does not flip the call.
    assay = module.detect_assay(dlpfc_shaped, {"cytassist_image": True},
                               {"chemistry": "Visium V4 Slide"})
    assert assay["assay"] == "visium-direct-placement"
    assert set(assay["corroborating_signals_contradicting"]) == {
        "cytassist_image.tiff", "chemistry_description"
    }
    assert "CONTRADICTED" in assay["corroboration"]


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-7 [acceptance] [invariant: INV-5] — `cytassist_image.tiff` is not silently dropped
# ═════════════════════════════════════════════════════════════════════════════════════


def test_a_cytassist_image_is_reported_as_not_emitted_with_the_reason(tmp_path):
    """TEST-7 [acceptance] [invariant: INV-5] [covers: ITEM-6].

    INV-5: "decided — emitted, or explicitly not, with the reason recorded. Do not leave it
    silent." Before #257 a bundle carrying `cytassist_image.tiff` imported with the file
    mentioned in NO channel at all.

    Both directions, because "the report always says this" is not the same claim as "the
    report says this when there is one": with the file present the entry appears and names
    the file and the reason; with it absent NO entry appears. That difference is exactly what
    distinguishes "we decided not to emit it" from "there was none".
    """
    module, _RQ = modules()

    # A real TIFF header is not needed and is deliberately not used: the whole point is that
    # nothing ever READS this file. If the importer started decoding it, this byte string
    # would make it fail loudly rather than let a decode creep in unnoticed.
    with_image = make_bundle(
        tmp_path / "with", VF.CYTASSIST_V4,
        extra_files=(("cytassist_image.tiff", b"II*\x00 not read by anything"),),
    )
    out = tmp_path / "with-out"
    entries = module.run_import(with_image, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())

    # THE PLUMBING, not just the classifier. `test_the_assay_does_not_decide_the_constant`
    # calls `detect_assay` with a hand-built `{"cytassist_image": ...}` dict, so it proves the
    # decision rule and NOTHING about anything populating that key — a blind audit measured
    # that setting `members["cytassist_image"] = False` in `locate_members` left the whole
    # suite green. This is the end-to-end half: a real file, on disk, in a real import.
    assert report["assay"]["signals"]["cytassist_image.tiff"] is True, (
        "a bundle carrying a real cytassist_image.tiff reports the corroborating signal as "
        "absent, so `locate_members` is not wiring it into `detect_assay` at all"
    )
    # STRICT. The first cut wrote this as a disjunction whose second half was implied by the
    # first AND by the assertion above it, so the strict form never bound — a blind audit
    # caught it. The V4 fixture's chemistry IS `Visium V4 Slide`, so with a real image present
    # NOTHING is silent and nothing contradicts.
    assert report["assay"]["corroborating_signals_silent"] == []
    assert report["assay"]["corroborating_signals_contradicting"] == []

    hits = [n for n in report["images_not_emitted"] if "cytassist_image.tiff" in n]
    assert len(hits) == 1, (
        f"a bundle carrying cytassist_image.tiff reported {report['images_not_emitted']} — "
        "the file has to be named somewhere a reader looking for what is missing will find it"
    )
    note = hits[0]
    assert "not emitted" in note
    assert "no scalefactor" in note, (
        "the note does not say WHY. 'not emitted' with no reason is the same dead end as "
        "saying nothing — the reader still has to go and work out whether it was a bug"
    )
    assert "regist_target_img_scalef" in note and "aligned_tissue_image.jpg" in note, (
        "the note does not say what the one CytAssist-specific scalefactor actually places, "
        "which is the fact a reader needs to check the claim"
    )
    # NOT emitted means NOT emitted: no artifact, and nothing on disk.
    assert not any("cytassist" in e["id"] for e in entries)
    assert not any(e["meta"].get("source") == "cytassist_image.tiff"
                   for e in entries if e.get("meta"))
    assert list(out.glob("**/*cytassist*")) == []

    # ── and with the file ABSENT, the report says nothing about it ────────────────────
    out2 = tmp_path / "without-out"
    entries2 = module.run_import(VF.CYTASSIST_V4, out2)
    module.write_manifest(out2, entries2)
    report2 = json.loads((out2 / "visium-import-report.json").read_text())
    assert not any("cytassist_image.tiff" in n for n in report2["images_not_emitted"]), (
        "the report claims an image was withheld from a bundle that never carried one"
    )
    # …and the corroborating signal reads FALSE there, which is the other half of the pin: a
    # hard-coded `True` would satisfy the assertion above and fail here.
    assert report2["assay"]["signals"]["cytassist_image.tiff"] is False


def test_the_non_placeable_table_is_not_reachable_from_the_emitted_table():
    """TEST-7 (cont.) [covers: ITEM-6] — the two tables cannot both claim one basename.

    `VENDOR_IMAGES` says which scalefactor PLACES an image; `NON_PLACEABLE_VENDOR_IMAGES` says
    nothing does. A basename in both would be a contradiction the code would resolve by
    accident of ordering, and the accident would be silent.
    """
    module, _RQ = modules()
    emitted = {spec["basename"] for spec in module.VENDOR_IMAGES}
    refused = {spec["basename"] for spec in module.NON_PLACEABLE_VENDOR_IMAGES}
    assert emitted.isdisjoint(refused), sorted(emitted & refused)
    assert "cytassist_image.tiff" in refused
    for spec in module.NON_PLACEABLE_VENDOR_IMAGES:
        assert "not emitted" in spec["reason"] and len(spec["reason"]) > 100


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-8 [acceptance] [invariant: INV-3] — standard Visium is UNAFFECTED
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_standard_bundle_is_bit_for_bit_unaffected_by_the_per_design_numerator(imported):
    """TEST-8 [acceptance] [invariant: INV-3] [covers: ITEM-4].

    INV-3, verbatim: "A standard Visium bundle is unaffected: the committed
    `Visium_Mouse_Olfactory_Bulb` fixture still imports, still measures
    `pitch_px / spot_diameter_fullres = 1.535`, and its scale check still passes at 0.22%."

    Every clause is asserted, and the numerator is asserted as an EXACT float rather than
    approximately. That is the strong form on purpose: the design table resolves the standard
    bundle to the same 65.0 object #222 pinned, not to a re-derivation that happens to round
    the same way, so `== 65.0` is a claim this branch is entitled to make and a weaker one
    would let a 1e-8 drift through unnoticed.
    """
    case = imported[VF.FIXTURE.name]
    report = case["report"]
    scale = report["registration_qc"]["scale"]
    pitch_px, diameter_px, ratio = vendor_ratio(VF.FIXTURE)

    assert ratio == pytest.approx(1.53503, abs=1e-5), (
        f"the committed bundle's vendor-internal ratio is {ratio:.5f}; it was 1.53503 when "
        "#222 was fixed and it depends on no constant this repo chose"
    )
    assert scale["measured_pitch_px"] == pytest.approx(113.0, abs=0.5)
    assert report["microns_per_pixel"] * diameter_px == 65.0, (
        "the standard fixture's numerator is no longer EXACTLY the 65.0 #222 pinned"
    )
    assert report["slide_design"]["id"] == "visium-6.5mm-65um-rendered-spot"
    assert report["slide_design"]["matched_by"] == "fiducial-spot-ratio"
    assert report["microns_per_pixel_source"] == "derived-from-spot-diameter"
    assert scale["verdict"] == "pass"
    assert scale["relative_error"] < 0.005, (
        f"the shipped derivation measures {scale['relative_error']:.4%} against the slide's "
        "pitch; #222 left it at ~0.223%"
    )
    assert report["assay"]["assay"] == "visium-direct-placement"


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-9 — the check that fires SAYS what it means
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_scale_checks_reason_names_the_design_on_both_branches(
    imported, tmp_path_factory
):
    """TEST-9 [covers: ITEM-8] — #222's actual lesson, made structural.

    #222's post-mortem was not that a check was missing. The check FIRED, as a `fail` verdict
    in a report, and it cost a human the work of deriving what it meant. The number under test
    is `rendered_spot_diameter_um / spot_diameter_fullres`, so the reason has to name the
    numerator and where it came from — on the PASSING branch too, because that is where a
    reader learns to trust the sentence.
    """
    module, _RQ = modules()
    case = imported[VF.CYTASSIST_V4.name]
    scale = case["report"]["registration_qc"]["scale"]
    assert scale["verdict"] == "pass"
    assert "visium-6.5mm-70um-rendered-spot" in scale["slide_design_note"]
    assert "70 um spot circle" in scale["slide_design_note"]
    assert "fiducial/spot 1.500000" in scale["slide_design_note"]
    assert scale["slide_design"]["id"] == "visium-6.5mm-70um-rendered-spot"

    # ── IN THE CHANNEL THAT ACTUALLY REACHES A HUMAN, AND UNTRUNCATED ────────────────
    # `qc_verdict_lines`' own docstring: `meta` "is the only channel by which this check
    # reaches a human in the shipped app". It caps each reason at QC_META_REASON_CHARS, and
    # the first cut of this branch rode inside `reason` — which pushed the committed fixture's
    # line from 136 characters to 308 and started cutting it off mid-word, taking the
    # `assumed-standard` guidance with it. So the assertion is not "it is somewhere in the
    # report": it is that the note survives the cap, on its own line, in `meta`.
    entry = next(e for e in case["entries"] if e["id"] == "visium-import-report")
    numerator_lines = [l for l in entry["meta"]["registration_qc"]
                       if l.startswith("scale numerator:")]
    assert len(numerator_lines) == 1, entry["meta"]["registration_qc"]
    assert "visium-6.5mm-70um-rendered-spot" in numerator_lines[0]
    assert "70 um spot circle" in numerator_lines[0]
    assert len(numerator_lines[0]) < module.QC_META_REASON_CHARS + 40, (
        "the numerator line is at the cap, so it is being truncated — which is the defect "
        "this line exists to have fixed"
    )
    # …and the MEASUREMENT line is not collateral damage: it must still be whole.
    measurement = next(l for l in entry["meta"]["registration_qc"]
                       if l.startswith("scale vs the slide's spot pitch:"))
    assert measurement.rstrip().endswith("."), (
        f"the measurement line is cut off mid-sentence: {measurement!r}"
    )

    # ── the FAILING branch, which is the one that actually costs someone time ─────────
    module, _RQ = modules()
    out = tmp_path_factory.mktemp("named-fail")
    module.SLIDE_DESIGNS = tuple(
        dict(d, rendered_spot_diameter_um=65.0) for d in module.SLIDE_DESIGNS
    )
    module.run_import(VF.CYTASSIST_V4, out)
    failing = json.loads((out / "visium-import-report.json").read_text())
    fscale = failing["registration_qc"]["scale"]
    assert fscale["verdict"] == "fail"
    assert "visium-6.5mm-70um-rendered-spot" in fscale["slide_design_note"], (
        "the FAILING scale check does not name the slide design whose numerator it applied, "
        "which is the one thing a reader needs in order to act on it"
    )
    assert "65 um spot circle" in fscale["slide_design_note"]


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-10 — the 11 mm design is exercised by a real bundle, not asserted about
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_11mm_slide_design_is_exercised_by_a_real_vendor_bundle(imported):
    """TEST-10 [covers: ITEM-10] — the 60 um constant's own evidence.

    `VENDOR_IMAGES` states this package's own rule about itself: "a row nothing exercises is
    an untested claim." The 7/4 row and its 60 um constant would be exactly that without a
    bundle, and the 11 mm slide is a different capture area with a different vendor spot
    count, not a relabelling of the 6.5 mm one.
    """
    module, _RQ = modules()
    case = imported[VF.CYTASSIST_V5_11MM.name]
    report = case["report"]
    scale = report["registration_qc"]["scale"]

    assert report["slide_design"]["id"] == "visium-11mm-60um-rendered-spot"
    assert report["slide_design"]["capture_area"] == "11 mm"
    assert report["microns_per_pixel"] * report["scalefactors"]["spot_diameter_fullres"] == 60.0
    assert scale["verdict"] == "pass"
    assert scale["measured_pitch_um"] == pytest.approx(100.0, rel=0.01)
    assert report["assay"]["assay"] == "visium-cytassist"
    assert report["assay"]["signals"]["chemistry_description"] == "Visium V5 Slide"
    # The subset came from a 14,336-row vendor table — 10x's own count for an 11 mm capture
    # area — and it straddles the tissue edge, so the join was exercised on both classes.
    # THE VENDOR'S OWN ROW COUNT for an 11 mm capture area, which 10x states on the Space
    # Ranger spatial-outputs page and this design's `vendor_spot_count` column carries. The
    # fixture is the COMPLETE table, not a window — see FIXTURE_BUDGETS for why.
    assert report["n_positions_in_bundle"] == 14336
    assert report["n_positions_in_bundle"] == next(
        r["vendor_spot_count"] for r in module.SLIDE_DESIGNS
        if r["id"] == "visium-11mm-60um-rendered-spot")
    assert 0 < report["n_spots"] < report["n_positions_in_bundle"]

    # 65 um on this design errs the OTHER WAY, which is why one CytAssist constant would not
    # have done: an 11 mm bundle given 65 reads 8% HIGH, not 7% low.
    _pitch, diameter, ratio = vendor_ratio(VF.CYTASSIST_V5_11MM)
    at_65 = _pitch * (65.0 / diameter)
    assert at_65 > 105.0, (
        f"65 um on the 11 mm design gives {at_65:.2f} um, not the >105 um that makes this "
        "design's error the opposite sign to the 6.5 mm CytAssist one"
    )


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-11 — the fixtures state their licence, their source and their budget
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_cytassist_fixtures_state_their_provenance_and_stay_in_budget():
    """TEST-11 [covers: ITEM-11, ITEM-12] — redistribution answered WITH the bytes.

    #78 exists in this tree because a redistribution question was left unanswered once. These
    two directories are 10x's data, so the same answer travels with them — and the numbers
    each fixture is committed FOR are recorded beside it, because a fixture whose reason for
    existing lives only in a commit message is a fixture the next person deletes.
    """
    module, RQ = modules()
    provenance = json.loads(PROVENANCE.read_text())

    for root, design_id, rendered in (
        (VF.CYTASSIST_V4, VF.CYTASSIST_V4_DESIGN_ID, 70.0),
        (VF.CYTASSIST_V5_11MM, VF.CYTASSIST_V5_11MM_DESIGN_ID, 60.0),
    ):
        assert root.is_dir(), f"{root} is not committed"
        total = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        assert total <= FIXTURE_BUDGETS[root], (
            f"{root.name} is {total:,} bytes, over its {FIXTURE_BUDGETS[root]:,} ceiling. "
            "Adding a vendor image to a fixture is a DECISION (DEC-10), not a drive-by"
        )

        key = f"{root.name}/spatial/scalefactors_json.json"
        record = provenance[key]
        for field in ("source_url", "sha256", "license", "license_url", "license_text",
                      "license_source", "citation", "dataset_page", "why_it_is_here"):
            assert record.get(field), f"PROVENANCE.json records no {field} for {key}"
        assert record["license"] == "CC BY 4.0"
        assert "creativecommons.org/licenses/by/4.0" in record["license_url"]
        assert "Creative Commons Attribution 4.0 International" in record["license_text"]
        assert record["source_url"].startswith("https://cf.10xgenomics.com/samples/spatial-exp/")
        assert "10x Genomics" in record["citation"]

        # The RECORD must describe the bytes that are actually here — a provenance file that
        # drifts from its fixture documents a file nobody has.
        import hashlib
        actual = hashlib.sha256((root / "spatial" / "scalefactors_json.json").read_bytes())
        assert record["sha256"] == actual.hexdigest(), (
            f"{key}: PROVENANCE.json's sha256 is not this file's"
        )
        measured = record["measured"]
        sf = json.loads((root / "spatial" / "scalefactors_json.json").read_text())
        assert measured["fiducial_over_spot"] == pytest.approx(
            sf["fiducial_diameter_fullres"] / sf["spot_diameter_fullres"], rel=1e-12
        )
        # BOTH estimators recorded, because they are different measurements — and the
        # same-row one, which is the centre-to-centre pitch by construction, is the one the
        # design's constant is compared against. An earlier PROVENANCE record carried only
        # the nearest-neighbour figure under a name that did not say so, and copied the V4
        # row's "they agree exactly" note onto the V5 row where they are 0.53% apart.
        assert measured["implied_rendered_spot_diameter_um_same_row"] == pytest.approx(
            rendered, rel=0.004
        )
        assert measured["implied_rendered_spot_diameter_um_nearest_neighbour"] == (
            pytest.approx(rendered, rel=0.01)
        )
        # BOTH ESTIMATORS RECOMPUTED, and the nearest-neighbour one through the SHIPPED
        # `measure_spot_pitch` rather than a local restatement. Only `same_row` was recomputed
        # before, and that asymmetry is exactly how a wrong number got into this file and
        # stayed: a throwaway helper that RANDOM-SUBSAMPLES above 6,000 points recorded
        # 363.2988 where the shipped estimator reads 363.0771, and the rel=0.01 band above
        # swallowed the difference. A blind audit caught it. Pinning both at 1e-9 against the
        # code that actually runs is what makes this record evidence rather than a note.
        assert measured["same_row_pitch_px"] == pytest.approx(same_row_pitch_px(root), rel=1e-9)
        with open(root / "spatial" / "tissue_positions.csv", newline="") as fh:
            pts = np.asarray([[float(r["pxl_col_in_fullres"]), float(r["pxl_row_in_fullres"])]
                              for r in csv.DictReader(fh)])
        shipped = RQ.measure_spot_pitch(pts)
        assert measured["median_nearest_neighbour_pitch_px"] == pytest.approx(
            shipped["median_nn_px"], rel=1e-9
        ), ("PROVENANCE records a nearest-neighbour pitch the SHIPPED estimator does not "
            "produce over the committed bytes")
        sf_committed = json.loads(
            (root / "spatial" / "scalefactors_json.json").read_text())
        assert measured["implied_rendered_spot_diameter_um_nearest_neighbour"] == pytest.approx(
            sf_committed["spot_diameter_fullres"] * 100.0 / shipped["median_nn_px"], rel=1e-9
        )
        assert "same_row" in measured["note"] and "nearest" in measured["note"].lower()
        assert design_id in record["why_it_is_here"]

        # …and the subset's own record says which vendor table it came from, which is what
        # ties the `vendor_spot_count` column above to a real file rather than to a doc.
        positions = provenance[f"{root.name}/spatial/tissue_positions.csv"]
        module_row = next(r for r in module.SLIDE_DESIGNS if r["id"] == design_id)
        assert str(module_row["vendor_spot_count"]) in positions["what"], (
            f"{root.name}'s positions record does not name the "
            f"{module_row['vendor_spot_count']}-row vendor table it comes from"
        )
        # …and the committed table really IS that size. The row count is the dimension a
        # blind audit showed a defect can hide in, so it is asserted rather than described.
        assert positions["rows"] == module_row["vendor_spot_count"]
        with open(root / "spatial" / "tissue_positions.csv", newline="") as fh:
            assert sum(1 for _ in csv.DictReader(fh)) == module_row["vendor_spot_count"]

        for member in ("filtered_feature_bc_matrix.h5", "spatial/tissue_positions.csv"):
            assert provenance[f"{root.name}/{member}"]["license"] == "CC BY 4.0", (
                f"{member} is redistributed from the same dataset and must carry the licence"
            )


def test_the_committed_bundle_table_covers_every_shipped_design():
    """TEST-11 (cont.) [covers: ITEM-12] — a design without a bundle is an untested claim.

    This is the guard that makes ITEM-10 impossible to skip on the NEXT design: adding a row
    to `SLIDE_DESIGNS` without committing a bundle for it turns this red.
    """
    module, _RQ = modules()
    shipped = {row["id"] for row in module.SLIDE_DESIGNS}
    covered = {design_id for _root, design_id, _um in VF.COMMITTED_BUNDLES}
    assert shipped == covered, (
        f"slide designs with no committed bundle: {sorted(shipped - covered)}; committed "
        f"bundles for no shipped design: {sorted(covered - shipped)}. A constant with no "
        "vendor bundle behind it is the tuned parameter #176 caught and #222 refused"
    )


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-13 — the slide design reaches the report and the HTML, matched AND assumed
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_report_carries_the_slide_design_and_how_it_was_decided(imported):
    """TEST-13 [covers: ITEM-7] — the provenance of the number, where a human can see it.

    `microns_per_pixel_source` says which LEG produced the scale; it has never said which
    NUMERATOR that leg divided. On a bundle whose design was assumed rather than identified,
    those are different answers, and only one of them tells a reader whether to trust the
    micron measurements.
    """
    module, _RQ = modules()
    for root, design_id, rendered in VF.COMMITTED_BUNDLES:
        case = imported[root.name]
        design = case["report"]["slide_design"]
        assert design["id"] == design_id
        assert design["rendered_spot_diameter_um"] == rendered
        assert design["matched_by"] == "fiducial-spot-ratio"
        assert design["fiducial_over_spot"] > 0

        # THE CITATION MUST BE THE MATCHED ROW'S, not merely non-empty. A blind audit measured
        # that pointing every record at the standard row's citation — so a 70 um bundle's
        # report cited the 65 um evidence — left the suite green. "A row carries its own
        # evidence" is the whole reason the table has a `source` column.
        row = next(r for r in module.SLIDE_DESIGNS if r["id"] == design_id)
        assert design["source"] == row["source"], (
            f"{root.name}'s report cites evidence belonging to a different slide design"
        )
        others = [r["source"] for r in module.SLIDE_DESIGNS if r["id"] != design_id]
        assert design["source"] not in others

        # …and the record carries the ratio it was matched AGAINST, not only the one measured,
        # which is what lets a reader check the match without the table in front of them.
        assert design["fiducial_over_spot_expected"] == row["fiducial_over_spot"]
        assert design["relative_error"] <= module.SLIDE_DESIGN_RATIO_TOLERANCE

        html = (case["dir"] / "visium-import-summary.html").read_text()
        assert "Slide design" in html and design_id in html, (
            f"{root.name}: the rendered report does not name the slide design"
        )
        assert f"{rendered:g} um rendered spot" in html

        entry = next(e for e in case["entries"] if e["id"] == "visium-import-report")
        assert entry["meta"]["slide_design"] == design_id
        assert entry["meta"]["slide_design_matched_by"] == "fiducial-spot-ratio"


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-14 — the mutation battery: every new constant and branch is load-bearing
# ═════════════════════════════════════════════════════════════════════════════════════


def _report_for(module, root, out):
    entries = module.run_import(Path(root), Path(out))
    module.write_manifest(Path(out), entries)
    return json.loads((Path(out) / "visium-import-report.json").read_text())


MUTANTS = (
    # (name, mutate(module), the bundle it is measured on)
    ("v4 rendered diameter 70.0 -> 65.0", VF.CYTASSIST_V4),
    ("v5 rendered diameter 60.0 -> 65.0", VF.CYTASSIST_V5_11MM),
    ("v4 ratio key 3/2 -> 21/13", VF.CYTASSIST_V4),
    ("v5 ratio key 7/4 -> 21/13", VF.CYTASSIST_V5_11MM),
    ("tolerance 1e-3 -> 0.5 (every design collapses onto one row)", VF.CYTASSIST_V5_11MM),
    ("assay decider ignored (always direct placement)", VF.CYTASSIST_V4),
)


@pytest.mark.parametrize("name,root", MUTANTS, ids=[m[0] for m in MUTANTS])
def test_every_new_constant_and_branch_is_pinned_by_something_that_goes_red(
    name, root, tmp_path
):
    """TEST-14 [covers: ITEM-14] — the constants are load-bearing, PROVEN by breaking them.

    A recent branch shipped three new clauses whose only mutation test used a shape the OLD
    code already caught, so all three were unpinned while every suite stayed green. The
    mutants below are all chosen to be INVISIBLE to the pre-#257 body — every one of them is
    a change to something that did not exist before this branch — so a green here cannot be
    inherited from a guard that was already there.

    `.lifecycle/cytassist-calibration/MUTATION.md` records each mutant measured against the
    pre-change body as well.
    """
    module, RQ = modules()
    original = module.SLIDE_DESIGNS
    tolerance_as_shipped = module.SLIDE_DESIGN_RATIO_TOLERANCE

    def rows(**by_id):
        return tuple(dict(d, **by_id.get(d["id"], {})) for d in original)

    if name.startswith("v4 rendered"):
        module.SLIDE_DESIGNS = rows(**{"visium-6.5mm-70um-rendered-spot":
                                       {"rendered_spot_diameter_um": 65.0}})
    elif name.startswith("v5 rendered"):
        module.SLIDE_DESIGNS = rows(**{"visium-11mm-60um-rendered-spot":
                                       {"rendered_spot_diameter_um": 65.0}})
    elif name.startswith("v4 ratio"):
        module.SLIDE_DESIGNS = rows(**{"visium-6.5mm-70um-rendered-spot":
                                       {"fiducial_over_spot": 21 / 13}})
    elif name.startswith("v5 ratio"):
        module.SLIDE_DESIGNS = rows(**{"visium-11mm-60um-rendered-spot":
                                       {"fiducial_over_spot": 21 / 13}})
    elif name.startswith("tolerance"):
        module.SLIDE_DESIGN_RATIO_TOLERANCE = 0.5
    elif name.startswith("assay decider"):
        module.CYTASSIST_SCALEFACTOR_KEY = "a_key_no_bundle_carries"

    report = _report_for(module, root, tmp_path / "out")
    scale = report["registration_qc"]["scale"]

    if name.startswith("assay decider"):
        # The SCALE is untouched — that is the design — so what must go red is the assay.
        assert scale["verdict"] == "pass", (
            "mutating the assay decider changed the micron scale; the two are supposed to be "
            "independent and #257's whole finding is that they must be"
        )
        assert report["assay"]["assay"] == "visium-direct-placement", (
            "the assay decider is not load-bearing: pointing it at a key no bundle carries "
            "still reports CytAssist, so `detect_assay` is deciding on something else"
        )
        return

    if name.startswith("tolerance"):
        # At tol=0.5 the 7/4 ratio is still within 0.5 of BOTH 21/13 and 3/2, so `min()` picks
        # the nearest and the tolerance alone cannot mis-select a REAL bundle. Its teeth are on
        # the NON-MATCH leg: it decides whether a ratio matching nothing is admitted as a
        # match. So that is where the mutant is aimed, and it is asserted as a DIFFERENTIAL —
        # the same input, the same call, two tolerances, two different answers.
        #
        # An earlier cut of this branch wrote the second half as
        # `with pytest.raises(AssertionError): assert x == "assumed-standard"` on the line
        # after asserting `x == "fiducial-spot-ratio"`, which raises tautologically and
        # demonstrated nothing. A blind audit caught it.
        unknown = {"spot_diameter_fullres": 100.0, "fiducial_diameter_fullres": 250.0}
        module.SLIDE_DESIGNS = original

        module.SLIDE_DESIGN_RATIO_TOLERANCE = 0.5
        mutated = module.slide_design(unknown)

        module.SLIDE_DESIGN_RATIO_TOLERANCE = tolerance_as_shipped
        shipped = module.slide_design(unknown)

        assert shipped["matched_by"] == "assumed-standard", (
            "a 2.5 fiducial/spot ratio matches no shipped design and must fall back"
        )
        assert mutated["matched_by"] == "fiducial-spot-ratio", (
            "MUTANT NOT CAUGHT: widening the tolerance 500x did not change what "
            "`slide_design` does with a ratio that matches no design, so the constant is not "
            "load-bearing on the leg its teeth are supposed to be on"
        )
        assert mutated["matched_by"] != shipped["matched_by"]
        assert "ASSUMED" in shipped["reason"] and "ASSUMED" not in mutated["reason"]
        return

    assert scale["verdict"] == "fail", (
        f"MUTANT NOT CAUGHT: `{name}` left the external referent GREEN on {Path(root).name}. "
        "The constant it changed is therefore not pinned by anything, which is exactly the "
        "failure this test exists to prevent"
    )
    assert scale["relative_error"] > 0.05


def test_the_mutation_battery_covers_every_row_and_every_new_constant():
    """TEST-14 (cont.) [covers: ITEM-14] — the battery cannot silently shrink.

    A mutation battery that stops covering a constant is worse than none, because the suite
    still looks thorough. Every design row that is not the standard fallback must appear in
    `MUTANTS` (the 65 um row is the fallback value, mutated by TEST-4's fallback cases
    instead: changing it changes what an UNIDENTIFIED bundle gets, which is what those assert).
    """
    module, _RQ = modules()
    mutated = " ".join(name for name, _root in MUTANTS)
    for row in module.SLIDE_DESIGNS:
        if row["rendered_spot_diameter_um"] == module.VISIUM_RENDERED_SPOT_DIAMETER_UM:
            continue
        tag = f"{row['rendered_spot_diameter_um']:g}.0 -> "
        assert tag in mutated, (
            f"{row['id']} ships a {row['rendered_spot_diameter_um']:g} um constant that no "
            "mutant perturbs, so nothing proves it is load-bearing"
        )
    assert "tolerance" in mutated and "assay decider" in mutated


# ═════════════════════════════════════════════════════════════════════════════════════
# TEST-15 — the manifest version moved
# ═════════════════════════════════════════════════════════════════════════════════════


def test_the_manifest_version_is_at_or_above_the_257_floor():
    """TEST-15 [covers: ITEM-15] — the RELATION, not a literal (#273's lesson).

    #273's post-mortem: a version pin written as a literal goes stale on the very next bump
    and gets deleted rather than re-read. What #257 requires is that the shipped version be at
    or above the one that carries the per-design numerator, because a stale `version` keeps
    the pre-#257 kernel executing while the package's files have changed.
    """
    import re
    text = (PKG / "manifest.yaml").read_text()
    match = re.search(r"^version:\s*([0-9]+)\.([0-9]+)\.([0-9]+)\s*$", text, re.M)
    assert match, "manifest.yaml carries no parseable `version:`"
    version = tuple(int(g) for g in match.groups())
    assert version >= (0, 10, 0), (
        f"the shipped version is {'.'.join(map(str, version))}, below the 0.10.0 that carries "
        "#257's per-slide-design numerator"
    )
    assert "#257" in text, "the changelog does not record why the version moved"


# ═════════════════════════════════════════════════════════════════════════════════════
# Round-1 fixes — each pins a defect a blind audit found in the first implementation
# ═════════════════════════════════════════════════════════════════════════════════════


def test_a_vendor_stated_scale_is_not_reported_as_coming_from_the_design(tmp_path):
    """TEST-16 [covers: ITEM-3, ITEM-7, ITEM-8] — the numerator must be APPLIED to be named.

    `micron_scale`'s leg 1 takes a vendor-STATED `microns_per_pixel` verbatim and divides
    NOTHING. The first cut of this branch appended "the scale numerator is the 70 um rendered
    spot circle of slide design ..." to the check's `reason` regardless, and put the design
    block in the report unqualified — a false provenance statement in the exact channel #257
    added so a reader would not have to derive provenance for themselves. Found by a blind
    audit, which reproduced it by planting `microns_per_pixel` into this fixture.

    The design is still identified and still named — it is a real fact about the slide. What
    the report must not do is claim the scale descends from it when it does not.
    """
    module, _RQ = modules()
    sf = json.loads((VF.CYTASSIST_V4 / "spatial" / "scalefactors_json.json").read_text())
    sf["microns_per_pixel"] = 0.2732
    root = make_bundle(tmp_path, VF.CYTASSIST_V4, scalefactors=sf)
    out = tmp_path / "out"
    entries = module.run_import(root, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())

    assert report["microns_per_pixel_source"] == "vendor"
    assert report["microns_per_pixel"] == 0.2732
    # the design is still identified…
    assert report["slide_design"]["id"] == "visium-6.5mm-70um-rendered-spot"
    assert report["slide_design"]["matched_by"] == "fiducial-spot-ratio"
    # …and the report says, in every channel, that it was NOT what the scale came from.
    assert report["slide_design"]["applied_as_scale_numerator"] is False
    note = report["registration_qc"]["scale"]["slide_design_note"]
    assert "NOT this import's numerator" in note
    assert "the vendor stated `microns_per_pixel`" in note
    assert "It IS this import's scale numerator" not in note, (
        "the scale check still claims a numerator on a run that divided by nothing"
    )
    # …and it reaches the app's `meta` channel, which is where it matters.
    entries_meta = next(e for e in entries if e["id"] == "visium-import-report")["meta"]
    assert any("NOT this import's numerator" in l
               for l in entries_meta["registration_qc"]), entries_meta["registration_qc"]
    html = (out / "visium-import-summary.html").read_text()
    # The HTML row goes through the SAME `_NOT_APPLIED_BECAUSE` table as the QC note, so the
    # two channels cannot say different things about one run — which is what happened when it
    # carried wording of its own ("identified but NOT applied … came from `unavailable`", on
    # an ASSUMED design, printing an enum token as a provenance).
    assert "NOT this import's scale numerator" in html
    assert "the vendor stated `microns_per_pixel` directly" in html
    assert "identified but NOT applied" not in html

    # …and the CONTROL: on the same bundle WITHOUT the vendor key, the design IS applied and
    # the sentence comes back. Without this the assertions above would pass on a build that
    # simply never names a numerator.
    control_out = tmp_path / "control"
    module.write_manifest(control_out, module.run_import(VF.CYTASSIST_V4, control_out))
    control = json.loads((control_out / "visium-import-report.json").read_text())
    assert control["microns_per_pixel_source"] == "derived-from-spot-diameter"
    assert control["slide_design"]["applied_as_scale_numerator"] is True
    assert "It IS this import's scale numerator" in (
        control["registration_qc"]["scale"]["slide_design_note"]
    )
    assert "NOT this import's scale numerator" not in (
        control_out / "visium-import-summary.html"
    ).read_text()


def test_the_cytassist_registration_checkerboard_is_a_reported_diagnostic_not_a_silence(
    tmp_path,
):
    """TEST-17 [covers: ITEM-6] — the OTHER CytAssist-only image, which was left silent.

    `aligned_tissue_image.jpg` is written only on a CytAssist or HD run ("generated when both
    CytAssist and microscope image inputs are provided"). The first cut of this branch handled
    `cytassist_image.tiff` and left this one in no table at all — neither emitted, nor
    refused, nor reported — which is precisely the state INV-5 forbids. A blind audit found it
    by reading this branch's own design doc against this branch's own code.

    It is a DIAGNOSTIC, not a refusal: unlike the CytAssist image it IS placeable, so "no
    scalefactor places it" would have been a false reason. It joins `aligned_fiducials.jpg`
    and `detected_tissue_image.jpg`, which are the same kind of thing, and the existing
    diagnostic machinery then carries it — into the report, never as an artifact (INV-5/§7.2).
    """
    module, _RQ = modules()
    assert "aligned_tissue_image.jpg" in module.DIAGNOSTIC_BASENAMES
    # …and NOT in either image table, which would make it an artifact or a refusal.
    assert "aligned_tissue_image.jpg" not in {s["basename"] for s in module.VENDOR_IMAGES}
    assert "aligned_tissue_image.jpg" not in {
        s["basename"] for s in module.NON_PLACEABLE_VENDOR_IMAGES
    }

    # A 1x1 JPEG — the smallest thing the diagnostic path will actually inline.
    import base64
    jpeg = base64.b64decode(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
    )
    root = make_bundle(tmp_path, VF.CYTASSIST_V4,
                       extra_files=(("aligned_tissue_image.jpg", jpeg),))
    out = tmp_path / "out"
    entries = module.run_import(root, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())
    html = (out / "visium-import-summary.html").read_text()

    # In the report a human reads…
    assert "aligned_tissue_image.jpg" in html, (
        "a CytAssist bundle's registration checkerboard reached no channel at all — which is "
        "the silence INV-5 forbids, one image over from the one it was written about"
    )
    # …and NOT as an artifact.
    assert not any("aligned_tissue" in e["id"] for e in entries)
    assert not any((e.get("meta") or {}).get("source") == "aligned_tissue_image.jpg"
                   for e in entries)
    assert not any("aligned_tissue" in n for n in report["images_not_emitted"]), (
        "the checkerboard is reported as a MISSING image; it is a diagnostic, and conflating "
        "the two is what `images_not_emitted` was split out to stop"
    )

    # …and with it absent, it is mentioned nowhere — absence is absence here too.
    bare_out = tmp_path / "bare"
    module.write_manifest(bare_out, module.run_import(VF.CYTASSIST_V4, bare_out))
    assert "aligned_tissue_image.jpg" not in (
        bare_out / "visium-import-summary.html"
    ).read_text()


def test_the_three_designs_are_consistent_with_one_rendered_fiducial_circle():
    """TEST-18 [covers: ITEM-1] — why the constants are ROUND, in executable form.

    A blind audit put the sharpest question to these constants: the measured means are 65.047,
    69.911 and 60.017, no vendor sentence states 70.0 or 60.0, and the design doc refuses the
    one derivation that would make them exact — so is "roundness" doing the work?

    It is not, and this is the reason. `fiducial_over_spot * rendered_spot_diameter_um` is the
    same number for every design: the rendered FIDUCIAL circle, which is a property of the
    fiducial frame and not of the spot array. Three exact, independent rationals measured on
    24 bundles across five Space Ranger versions admit exactly ONE assignment of diameters
    consistent with a single fiducial circle, and (65, 70, 60) is it. 69.911 would require the
    fiducial to be physically different on the CytAssist 6.5 mm slide than on the other two.

    Asserted as the RELATION, with the shared value read OUT of the table rather than typed —
    so the test says "these three agree", never "they agree with 105", and it cannot be
    satisfied by writing 105 anywhere.
    """
    module, _RQ = modules()
    products = {row["id"]: row["fiducial_over_spot"] * row["rendered_spot_diameter_um"]
                for row in module.SLIDE_DESIGNS}
    assert len(products) >= 3
    shared = list(products.values())[0]
    for design_id, product in products.items():
        assert product == pytest.approx(shared, rel=1e-12), (
            f"{design_id} implies a {product:.6g} um rendered fiducial circle while another "
            f"design implies {shared:.6g}. The three designs no longer agree on one fiducial, "
            "so the reason their diameters are round numbers has gone — and a round number "
            "with no constraint behind it is a fitted parameter"
        )
    # The shared value is a REAL length, not an artefact of everything being zero.
    assert 50.0 < shared < 500.0

    # …and the constraint is TIGHT: perturbing any ONE diameter by 1% must break the AGREEMENT
    # across the table — which is what makes "the unique solution" a claim rather than a
    # phrase. Re-checked by recomputing the whole product set from a perturbed table, not by
    # comparing a perturbed product to itself: the first cut did the latter
    # (`perturbed = shared * 1.01; assert perturbed != approx(shared, rel=1e-3)`), which is a
    # tautology that a blind audit demonstrated passes against a table whose three products
    # are 1.0, 100.0 and 270.0.
    for i in range(len(module.SLIDE_DESIGNS)):
        perturbed_rows = [
            dict(r, rendered_spot_diameter_um=r["rendered_spot_diameter_um"] * 1.01)
            if j == i else r
            for j, r in enumerate(module.SLIDE_DESIGNS)
        ]
        perturbed_products = [r["fiducial_over_spot"] * r["rendered_spot_diameter_um"]
                              for r in perturbed_rows]
        assert len(set(round(x, 9) for x in perturbed_products)) > 1, (
            f"moving row {i}'s diameter by 1% left all three products equal, so the "
            "agreement asserted above is not a constraint on the diameters at all"
        )

    # …and the control that makes THAT meaningful: an inconsistent table must fail the
    # agreement check. Without it, the loop above could pass on a table where nothing agrees.
    garbage = tuple(dict(r, rendered_spot_diameter_um=v)
                    for r, v in zip(module.SLIDE_DESIGNS, (1.0, 100.0, 270.0)))
    garbage_products = [r["fiducial_over_spot"] * r["rendered_spot_diameter_um"]
                        for r in garbage]
    assert len(set(round(x, 9) for x in garbage_products)) > 1


def test_the_assumed_standard_record_names_the_design_its_diameter_belongs_to():
    """TEST-19 [covers: ITEM-3] — the fallback record must be internally consistent.

    The first cut took `id`, `capture_area` and `source` from `SLIDE_DESIGNS[0]` and the
    diameter from the module constant. Those agree today and would stop agreeing the moment a
    row were inserted at the front — which the table explicitly invites — producing a report
    that names one design and quotes another's diameter, with every test green because they
    all assert the VALUE. Found by a blind audit.

    This asserts the BINDING, over a REORDERED table, which is the only shape that can fail.
    """
    module, _RQ = modules()
    absent = {"spot_diameter_fullres": 100.0}

    marked = [d for d in module.SLIDE_DESIGNS if d.get("is_standard_fallback")]
    assert len(marked) == 1, "exactly one design row must declare itself the fallback"
    assert marked[0]["rendered_spot_diameter_um"] == module.VISIUM_RENDERED_SPOT_DIAMETER_UM, (
        "the row that declares itself the fallback does not carry the constant the fallback "
        "is documented to use, so the two have drifted apart silently"
    )
    baseline = module.slide_design(absent)
    named = next(d for d in module.SLIDE_DESIGNS if d["id"] == baseline["id"])
    assert named["rendered_spot_diameter_um"] == baseline["rendered_spot_diameter_um"], (
        "the fallback record names one design and carries another's diameter"
    )
    assert baseline["source"] == named["source"]
    assert baseline["capture_area"] == named["capture_area"]

    # REORDERED: the standard row is no longer first. The record must be unchanged.
    module.SLIDE_DESIGNS = tuple(reversed(module.SLIDE_DESIGNS))
    reordered = module.slide_design(absent)
    for key in ("id", "rendered_spot_diameter_um", "capture_area", "source"):
        assert reordered[key] == baseline[key], (
            f"reordering SLIDE_DESIGNS changed the fallback's {key!r} from "
            f"{baseline[key]!r} to {reordered[key]!r} — the fallback is bound to a POSITION"
        )

    # …and a table with no standard row at all is a refusal, not a silent wrong answer.
    module.SLIDE_DESIGNS = tuple(
        d for d in module.SLIDE_DESIGNS if not d.get("is_standard_fallback")
    )
    with pytest.raises(module.VisiumImportError) as exc:
        module.slide_design(absent)
    assert "is_standard_fallback" in str(exc.value)

    # …and so is a table with TWO of them: an ambiguous fallback is not a fallback.
    module.SLIDE_DESIGNS = tuple(dict(d, is_standard_fallback=True)
                                 for d in module.SLIDE_DESIGNS)
    with pytest.raises(module.VisiumImportError):
        module.slide_design(absent)


def test_a_scalefactors_number_too_large_for_a_double_does_not_abort_the_import(tmp_path):
    """TEST-20 [covers: ITEM-3] — INV-6's negative leg, over the NEW field this branch reads.

    `json.loads` turns a long integer literal into a Python `int` with no float bound, and
    `math.isfinite` RAISES `OverflowError` on one. #257 made `slide_design` read
    `fiducial_diameter_fullres` for the first time, and `slide_design` is called from
    `run_import` outside any handler — so a bundle that `origin/main` imported cleanly
    (nothing read that field before) aborted here with a traceback. A blind audit found it by
    feeding a 400-digit literal to the committed fixture.

    That is a REGRESSION against INV-6's negative leg, which `read_scalefactors` states as
    "a bundle with a damaged scale file is still importable — the coordinates are still
    correct in pixels — it simply DECLARES NO SCALE". This asserts the whole of it: the import
    SUCCEEDS, the design falls back and says so, and the emitted artifacts are still there.

    Both fields are covered, because they are read at different points: the spot diameter also
    reaches `micron_scale`, where an unguarded `isfinite` would abort one function later.
    """
    module, _RQ = modules()
    for field in ("fiducial_diameter_fullres", "spot_diameter_fullres"):
        sf = json.loads((VF.FIXTURE / "spatial" / "scalefactors_json.json").read_text())
        # Written as TEXT, so the file really carries the literal rather than a float that
        # `json.dumps` rounded — the round trip is the thing under test.
        raw = json.dumps(sf)[:-1] + f', "{field}": {10 ** 400}}}'
        root = make_bundle(tmp_path / field, VF.FIXTURE)
        (root / "spatial" / "scalefactors_json.json").write_text(raw)

        out = tmp_path / f"out-{field}"
        entries = module.run_import(root, out)  # must NOT raise
        module.write_manifest(out, entries)
        report = json.loads((out / "visium-import-report.json").read_text())

        assert report["slide_design"]["matched_by"] == "assumed-standard"
        assert "no usable" in report["slide_design"]["reason"]
        assert any(e["id"] == "spatial-coordinates" for e in entries), (
            "the coordinates are still correct in pixels and must still be emitted (INV-6)"
        )
        if field == "spot_diameter_fullres":
            # …and with the diameter unusable there is NO scale at all, which is absence
            # spelled as absence rather than as an invented number.
            assert "microns_per_pixel" not in report
            assert report["microns_per_pixel_source"] == "unavailable"


def test_the_image_failure_boundaries_still_hold_over_the_changed_emit_images(tmp_path):
    """TEST-12 [covers: ITEM-6, ITEM-16] — #296/#297/#298's boundaries, over MY diff.

    ## Why this is a test and not a re-run

    This was enumerated as "re-run `test_image_robustness.py`", and that was wrong twice over.
    A11: a `TEST-N: PASS` has to be earned by a line THIS branch added, and `TEST-12` already
    names a different test in five other features' files in this very package — a bare grep
    would have bound the id to a stranger's assertion. And on the merits, re-running a suite
    written for a different diff proves that diff still passes; what ITEM-16 claims is
    narrower and sharper: the boundaries hold WHERE THIS BRANCH TOUCHED THEM.

    ## What it drives

    One bundle carrying all three cases at once, because the interaction is the point:

      * a `cytassist_image.tiff`, which this branch reports as never-emitted from a loop it
        ADDED immediately above the guarded one;
      * a vendor image that FAILS to read, whose refusal the guarded loop must catch;
      * a vendor image that succeeds.

    The three assertions are the three boundaries the base merge (#296/#297/#298) established:
    a failure costs ONLY its own image; the note names WHICH image (not `UNNAMED_IMAGE`, and
    not a sentence that merely contains the word "basename" — #298 E4); and no note asserting
    an image was EMITTED accompanies one that was not, read from the shipped
    `EMISSION_ASSERTING_PHRASES` tuple rather than from a substring this test chose, so the
    prose and its pin cannot drift apart.
    """
    module, _RQ = modules()
    bundle = VF.make_imaged(tmp_path / "bundle", with_lowres=True)
    (bundle / "spatial" / "cytassist_image.tiff").write_bytes(b"II*\x00 never read")
    (bundle / "spatial" / "broken.tif").write_bytes(b"II*\x00" + b"\x00" * 120)

    # Point ONE vendor row at the corrupt file, exactly as `test_image_robustness` does — the
    # shipped table is PNG-only, so this is how the failing branch is reached at all.
    module.VENDOR_IMAGES = (
        {"basename": "broken.tif", "scalef_key": "tissue_hires_scalef",
         "role": "alignment", "output_id": "spatial-image-broken"},
        {"basename": "tissue_lowres_image.png", "scalef_key": "tissue_lowres_scalef",
         "role": "overview", "output_id": "spatial-image-lowres"},
    )
    out = tmp_path / "out"
    entries = module.run_import(bundle, out)          # must NOT abort
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())

    # 1. THE FAILURE COST ONLY ITS OWN IMAGE — the good one is still emitted, and the matrix,
    #    the coordinates and the columns are all still here.
    ids = {e["id"] for e in entries}
    assert "spatial-image-lowres" in ids, (
        "a corrupt image took the healthy one with it — the per-image guard is gone"
    )
    assert "spatial-image-broken" not in ids
    assert {"expression", "spatial-coordinates", "visium-import-report"} <= ids

    # 2. THE NOTE NAMES WHICH IMAGE, for both kinds of not-emitted.
    not_emitted = report["images_not_emitted"]
    broken = [n for n in not_emitted if n.startswith("broken.tif:")]
    cytassist = [n for n in not_emitted if n.startswith("cytassist_image.tiff:")]
    assert len(broken) == 1, not_emitted
    assert len(cytassist) == 1, not_emitted
    assert module.UNNAMED_IMAGE not in " ".join(not_emitted), (
        "an image whose basename the handler could not read reached the report as the "
        "placeholder — #298 E4, which is the line this branch's new loop sits above"
    )

    # 3. NO NOTE ASSERTING EMISSION ACCOMPANIES AN IMAGE THAT WAS NOT EMITTED. Read from the
    #    shipped tuple, so rewording the prose cannot make this assertion vacuous.
    assert module.EMISSION_ASSERTING_PHRASES
    for phrase in module.EMISSION_ASSERTING_PHRASES:
        for note in report["image_warnings"]:
            if phrase in note:
                assert not note.startswith("broken.tif"), (note, phrase)
                assert not note.startswith("cytassist_image.tiff"), (note, phrase)
        for note in not_emitted:
            assert phrase not in note, (
                f"a not-emitted note claims emission via {phrase!r}: {note!r}"
            )

    # 4. …and the two channels stayed separate: the non-placeable image is NOT a warning about
    #    an image that WAS emitted, and the emitted one is not in the missing set.
    assert not any("cytassist_image.tiff" in n for n in report["image_warnings"])
    assert not any(n.startswith("tissue_lowres_image.png:") for n in not_emitted)


# ═════════════════════════════════════════════════════════════════════════════════════
# Round-2 fixes — three repairs that did not land, plus the fail-open defaults
# ═════════════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "leg,mutate,expect,forbid",
    [
        ("vendor", lambda sf: sf.update(microns_per_pixel=0.2732),
         "the vendor stated `microns_per_pixel`", "no micron scale at all"),
        ("unavailable",
         lambda sf: (sf.pop("spot_diameter_fullres"), sf.pop("fiducial_diameter_fullres")),
         "this bundle declares no micron scale at all", "the vendor stated"),
    ],
)
def test_the_not_applied_explanation_names_the_leg_that_actually_ran(
    leg, mutate, expect, forbid, tmp_path
):
    """TEST-21 [covers: ITEM-3, ITEM-8] — three legs, three sentences, not one for two.

    `applied_as_scale_numerator` is False on `micron_scale`'s leg 1 (the vendor STATED a
    scale) AND on its leg 3 (there is no scale at all), and those are different facts. The
    round-1 repair hard-coded leg 1's sentence and printed it for both, so a bundle that
    declared NO scale was told the vendor had stated one — a false provenance statement in
    the exact channel the repair was made to protect, introduced BY the repair. A blind audit
    measured it end to end, on the report, the artifact `meta` and the HTML alike.

    The same branch also returned EARLY, shadowing the `assumed-standard` sentence, so an
    ASSUMED design was presented as an identified fact. That is asserted separately below.
    """
    module, _RQ = modules()
    sf = json.loads((VF.CYTASSIST_V4 / "spatial" / "scalefactors_json.json").read_text())
    mutate(sf)
    root = make_bundle(tmp_path, VF.CYTASSIST_V4, scalefactors=sf)
    out = tmp_path / "out"
    entries = module.run_import(root, out)
    module.write_manifest(out, entries)
    report = json.loads((out / "visium-import-report.json").read_text())

    assert report["microns_per_pixel_source"] == leg
    assert report["slide_design"]["scale_source"] == leg
    assert report["slide_design"]["applied_as_scale_numerator"] is False
    note = report["registration_qc"]["scale"]["slide_design_note"]
    assert expect in note, note
    assert forbid not in note, (
        f"the {leg} leg is explained with the OTHER leg's sentence: {note!r}"
    )
    # …in every channel, because the defect was visible in all three.
    meta = next(e for e in entries if e["id"] == "visium-import-report")["meta"]
    assert any(expect in l for l in meta["registration_qc"]), meta["registration_qc"]
    assert expect in (out / "visium-import-summary.html").read_text()


def test_an_assumed_design_is_never_presented_as_identified(tmp_path):
    """TEST-22 [covers: ITEM-3, ITEM-8] — the assumption sentence is not shadowed.

    The round-1 repair's `applied is False` branch returned EARLY, before the
    `assumed-standard` branch could run. So a bundle whose design was ASSUMED *and* whose
    scale came from somewhere else was told "The slide design is `visium-6.5mm-65um-...`" as a
    fact, and lost the guidance saying to check the assumption. Both halves at once is the
    only shape that reproduces it, so that is what this drives.
    """
    module, _RQ = modules()
    sf = json.loads((VF.CYTASSIST_V4 / "spatial" / "scalefactors_json.json").read_text())
    sf.pop("spot_diameter_fullres")
    sf.pop("fiducial_diameter_fullres")          # -> design ASSUMED
    root = make_bundle(tmp_path, VF.CYTASSIST_V4, scalefactors=sf)   # -> and leg 3
    out = tmp_path / "out"
    module.write_manifest(out, module.run_import(root, out))
    report = json.loads((out / "visium-import-report.json").read_text())

    design = report["slide_design"]
    assert design["matched_by"] == "assumed-standard"
    assert design["applied_as_scale_numerator"] is False
    note = report["registration_qc"]["scale"]["slide_design_note"]
    assert "ASSUMED" in note and "check that first" in note, (
        "the assumption warning was shadowed by the not-applied branch — which is how an "
        "ASSUMED design comes to be presented as an identified fact"
    )
    assert "NOT this import's numerator" in note
    assert not note.lstrip().startswith("Slide design `"), note


def test_the_slide_design_note_fits_the_channel_that_carries_it():
    """TEST-23 [covers: ITEM-8] — the budget, on every reachable shape.

    This note is truncated at `QC_META_REASON_CHARS` on its way into the artifact `meta`,
    which is the only channel by which this check reaches a human in the shipped app. Two
    successive cuts of it overran that cap and were silently chopped — the first taking the
    measurement with it, the second cutting off the assumption guidance at 380 characters.
    Both were measured, the second by re-running the probe that found the first.

    So the budget is now a constant the code enforces, and this asserts it over every
    combination of the three facts the note composes — including the LONGEST one, which is
    what a spot check on the committed fixtures would miss.
    """
    module, RQ = modules()
    assert RQ.MAX_SLIDE_DESIGN_NOTE_CHARS <= module.QC_META_REASON_CHARS, (
        "the note's own budget is looser than the cap that will truncate it, so staying "
        "inside the budget does not mean surviving the channel"
    )
    longest = max(
        (d["id"] for d in module.SLIDE_DESIGNS), key=len
    )
    row = next(d for d in module.SLIDE_DESIGNS if d["id"] == longest)
    worst = 0
    # THE LEGS ARE DERIVED FROM THE TABLE, not typed here. Enumerating them was the first
    # cut, and a blind audit measured that adding one row to `_NOT_APPLIED_BECAUSE` with a
    # long sentence pushes the note past the budget while this test stays green — which is
    # the same "a row nothing exercises is an untested claim" shape the module comment above
    # that table invites ("a new leg is a row here").
    legs = [(True, "derived-from-spot-diameter")]
    legs += [(False, k) for k in sorted(RQ._NOT_APPLIED_BECAUSE)]
    legs += [(False, "a-source-this-table-does-not-know"), (None, None)]
    assert len(RQ._NOT_APPLIED_BECAUSE) >= 2, "the not-applied table has lost a leg"
    for matched in ("fiducial-spot-ratio", "assumed-standard"):
        for applied, source in legs:
            record = {
                "id": row["id"],
                "rendered_spot_diameter_um": row["rendered_spot_diameter_um"],
                "matched_by": matched,
                "fiducial_over_spot": row["fiducial_over_spot"],
                "applied_as_scale_numerator": applied,
                "scale_source": source,
                "reason": "x" * 400,
            }
            if applied is None:
                record.pop("applied_as_scale_numerator")
                record.pop("scale_source")
            note = RQ._slide_design_clause(record)
            worst = max(worst, len(note.strip()))
            assert len(note.strip()) <= RQ.MAX_SLIDE_DESIGN_NOTE_CHARS, (
                matched, applied, source, len(note), note
            )
            assert "full text in" not in note, (
                "a reachable shape hit the emergency truncation branch, which means the "
                "sentences are no longer short by construction"
            )
    assert worst > 100, "the longest shape is suspiciously short; is the note still composed?"
    # MARGIN, asserted. A blind audit measured the worst reachable shape at 198 of 200 — two
    # characters — so "short by construction" was true and one word from being false, with
    # nothing that would say so. A floor on the headroom is what makes the budget a budget.
    assert RQ.MAX_SLIDE_DESIGN_NOTE_CHARS - worst >= 15, (
        f"the longest reachable note is {worst} of {RQ.MAX_SLIDE_DESIGN_NOTE_CHARS} — under "
        "15 characters of headroom, so any small rewording trips the truncation branch this "
        "test asserts is unreachable. Shorten a sentence or raise the budget deliberately"
    )


def test_a_design_record_that_never_went_through_the_importer_claims_nothing(tmp_path):
    """TEST-24 [covers: ITEM-3, ITEM-8] — the fail-open default, closed.

    `slide_design()` is a PUBLIC entry point — `scripts/check-viz-producer-magnitudes.mjs`
    calls it to derive the numerator — and the records it returns carry no
    `applied_as_scale_numerator` at all; only `run_import` adds it. The round-1 repair tested
    `.get(...) is False`, which reads a MISSING key as "applied" and printed the affirmative
    "It IS this import's scale numerator" for a record that carries no such information. Same
    fail-open default in the HTML row. Both found by a blind audit.

    Absence is now its own answer, in both places.
    """
    module, RQ = modules()
    sf = json.loads((VF.CYTASSIST_V4 / "spatial" / "scalefactors_json.json").read_text())
    bare = module.slide_design(sf)
    assert "applied_as_scale_numerator" not in bare, (
        "`slide_design()` now records application, which would make this test vacuous — "
        "it is `run_import` that knows which leg ran, not the selector"
    )
    note = RQ._slide_design_clause(bare)
    assert "not recorded" in note
    assert "IS this import's scale numerator" not in note
    assert "NOT this import's numerator" not in note

    line = module._report_slide_design_line({"slide_design": bare})
    assert "not recorded" in line
    # …and the CONTROL: a record that DID go through the importer still makes its claim.
    out = tmp_path / "out"
    module.write_manifest(out, module.run_import(VF.CYTASSIST_V4, out))
    real = json.loads((out / "visium-import-report.json").read_text())["slide_design"]
    assert real["applied_as_scale_numerator"] is True
    assert "IS this import's scale numerator" in RQ._slide_design_clause(real)


def test_the_clause_does_not_raise_on_a_vendor_number_too_large_for_a_double():
    """TEST-25 [covers: ITEM-8] — the DEC-7 handler must not be the thing that raises.

    `_slide_design_clause` is called from inside `registration_qc`'s own `except` handler —
    the path that turns any failure into a `not-evaluated` verdict. A raise THERE escapes the
    handler and costs the user the whole import, which is #298 E4's shape one package over.
    Its diameter guard was `isinstance(x, (int, float))`, which admits a Python int too large
    for a double, and the next line formats it with `:g`. A blind audit verified the raise.
    """
    module, RQ = modules()
    for bad in (10 ** 400, float("inf"), float("nan"), None, "70", True, [70.0]):
        record = {"id": "x", "rendered_spot_diameter_um": bad,
                  "matched_by": "fiducial-spot-ratio", "fiducial_over_spot": 1.5,
                  "applied_as_scale_numerator": True}
        assert RQ._slide_design_clause(record) == "", bad     # says nothing, never raises
    # …and a huge fiducial ratio is dropped from the sentence rather than formatted.
    record = {"id": "x", "rendered_spot_diameter_um": 70.0,
              "matched_by": "fiducial-spot-ratio", "fiducial_over_spot": 10 ** 400,
              "applied_as_scale_numerator": True}
    note = RQ._slide_design_clause(record)
    assert "70 um spot circle." in note and "fiducial/spot" not in note

    # An UNHASHABLE `scale_source` is the other raise vector, and it is the one that actually
    # reaches the DEC-7 handler: `_NOT_APPLIED_BECAUSE.get(<list>)` raises `TypeError`.
    assert RQ._slide_design_clause(
        {"id": "x", "rendered_spot_diameter_um": 70.0, "matched_by": "fiducial-spot-ratio",
         "applied_as_scale_numerator": False, "scale_source": []}
    ).endswith("the scale came from elsewhere.")

    # …AND THE HANDLER ITSELF, ENTERED FOR REAL. The first cut of this control passed a huge
    # diameter and asserted the verdict was one of three values — but with `_finite_float` in
    # place that call RETURNS NORMALLY, so the `except` path it named was never entered, and
    # the assertion enumerated every value the verdict can take, so it could not fail. A blind
    # audit measured both. This forces `check_scale` to raise and then asserts DEC-7's actual
    # promise: `registration_qc` returns a `not-evaluated` verdict instead of propagating.
    import unittest.mock as _mock
    with _mock.patch.object(RQ, "measure_spot_pitch",
                            side_effect=RuntimeError("planted, inside check_scale")):
        block, _overlays = RQ.registration_qc(
            coords=np.array([[0.0, 0.0], [113.0, 0.0]]), in_tissue=np.array([True, True]),
            microns_per_pixel=0.88, scale_source="derived-from-spot-diameter",
            image_entries=[], outputs_dir=None, spot_diameter_um=55.0,
            slide_design={"id": "x", "rendered_spot_diameter_um": 70.0,
                          "matched_by": "fiducial-spot-ratio",
                          "applied_as_scale_numerator": False, "scale_source": []},
        )
    assert block["scale"]["verdict"] == "not-evaluated", block["scale"]
    assert "planted, inside check_scale" in block["scale"]["reason"]
    # …and the exception path still carries the design, which is the field a reader has left.
    assert block["scale"]["slide_design"]["id"] == "x"
    assert "70 um spot circle" in block["scale"]["slide_design_note"]


def _resized_bundle(tmp_path, source, target_rows=None, at_least=None):
    """A copy of `source` whose positions table has been WINDOWED to `target_rows` or PADDED
    to at least `at_least` rows.

    TWO PARAMETERS, not one, because "make it this size" is ambiguous for the large direction:
    a single `target_rows` silently WINDOWED the 14,336-row bundle down to 6,000 and then to
    its 85 matrix rows, so both sides of the contrast came out the same size and the test
    failed on its own anti-vacuity guard. `at_least` keeps every real row and only tops up.

    Padding adds rows the matrix does not reference, which is legal and is the shape every
    committed bundle already has (a filtered matrix holds fewer barcodes than the positions
    table). Windowing keeps only rows the matrix DOES reference, because a matrix barcode with
    no position is a refusal this importer states as an invariant.

    So one helper covers both directions, which is what lets the invariant below be asserted
    for every committed design rather than only the one whose fixture happens to be large.
    """
    import h5py

    with open(Path(source) / "spatial" / "tissue_positions.csv", newline="") as fh:
        rows = list(csv.reader(fh))
    header, body = rows[0], rows[1:]
    with h5py.File(Path(source) / "filtered_feature_bc_matrix.h5", "r") as fh:
        matrix_barcodes = {b.decode() for b in fh["matrix/barcodes"][:]}

    if target_rows is not None:
        kept = [r for r in body if r[0] in matrix_barcodes][:target_rows]
    else:
        kept = list(body)
        x = int(float(body[0][4])), int(float(body[0][5]))
        for i in range(max(0, at_least - len(body))):
            # Out of tissue, far from the lattice, with a barcode nothing references — so it
            # cannot change the matrix join, and it is deliberately OFF the spot lattice so it
            # cannot become a nearest neighbour of a real spot and move the measured pitch.
            kept.append([f"PAD{i:06d}-1", "0", "0", "0",
                         str(x[0] + 10_000_000 + i * 1000), str(x[1] + 10_000_000)])

    bundle = make_bundle(tmp_path, source)
    with open(bundle / "spatial" / "tissue_positions.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(kept)
    return bundle, len(kept)


def test_the_numerator_does_not_depend_on_how_many_spots_the_table_has(tmp_path):
    """TEST-26 [covers: ITEM-1, ITEM-3, ITEM-9] — the invariant a windowed fixture cannot see.

    The slide design is a property of the GLASS. The numerator it selects must therefore be
    the same whether the positions table holds 120 rows or 14,336 — and nothing asserted
    that, because every committed fixture used to be a window of about the same size.

    A blind audit turned that into a measured hole: a producer with

        if len(positions["barcode"]) >= 1000:
            design = dict(design, rendered_spot_diameter_um=VISIUM_CAPTURE_SPOT_DIAMETER_UM)

    passed this entire suite AND the cross-package gate while applying 55 µm — #222 restored
    in full, a 21.4% under-estimate — to every real vendor bundle.

    ## Why this ranges over EVERY committed design

    The first cut of this test used one bundle, the 70 µm one, and a SECOND blind audit walked
    straight through the gap: scoping the same mutant to the 65 µm design
    (`... and id.endswith("65um-rendered-spot")`) passed the gate and all 302 package tests
    while putting −15.4% on every real 6.5 mm v1/v2 bundle — the most common one there is.
    The 65 µm fixture is `visium-outs`, which is deliberately a 160-row subset under #243's
    own size budget, so "make every fixture full-size" cannot reach it.

    The fix is not a bigger fixture, it is the right assertion: the size contrast is
    MANUFACTURED per bundle, in both directions, so the invariant holds for every design
    whatever its fixture happens to weigh. Padding rows are out-of-tissue, unreferenced by the
    matrix, and placed far off the lattice so they cannot move the measured pitch.
    """
    module, _RQ = modules()
    for root, design_id, rendered in VF.COMMITTED_BUNDLES:
        small, n_small = _resized_bundle(tmp_path / f"{root.name}-small", root,
                                         target_rows=120)
        large, n_large = _resized_bundle(tmp_path / f"{root.name}-large", root,
                                         at_least=6000)
        assert n_small < 1000 < n_large, (n_small, n_large)

        reports = {}
        for tag, bundle in (("small", small), ("large", large)):
            out = tmp_path / f"{root.name}-{tag}-out"
            module.write_manifest(out, module.run_import(bundle, out))
            reports[tag] = json.loads((out / "visium-import-report.json").read_text())

        s_, l_ = reports["small"], reports["large"]
        assert s_["n_positions_in_bundle"] == n_small
        assert l_["n_positions_in_bundle"] == n_large
        assert s_["slide_design"]["id"] == l_["slide_design"]["id"] == design_id
        assert (s_["slide_design"]["rendered_spot_diameter_um"]
                == l_["slide_design"]["rendered_spot_diameter_um"] == rendered), (
            f"{root.name}: the SAME bundle selects a different rendered spot diameter at "
            f"{n_small} rows than at {n_large} — the numerator is depending on the size of "
            "the positions table, which is not a property of the slide"
        )
        # …and the number that actually shipped, not just the record. `spot_diameter_fullres`
        # is identical across the two runs, so equal scales mean equal numerators.
        assert s_["microns_per_pixel"] == l_["microns_per_pixel"], (
            f"{root.name}: microns_per_pixel moved with the row count"
        )
        assert (s_["scalefactors"]["spot_diameter_fullres"]
                == l_["scalefactors"]["spot_diameter_fullres"])


