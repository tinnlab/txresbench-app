#!/usr/bin/env python3
"""The committed Visium fixture's REAL image and REAL spots are mutually coherent (#243).

## What this suite is for

Until #243 there was no committed artifact in this repository where a real tissue image and
its real spots were geometrically coherent. Every image-plus-coordinates fixture was either
a SYNTHESIZED image (pixels generated, geometry controlled — `visium_fixtures.make_imaged`)
or a REAL image whose real spots fell outside it (the shipped bundle). That cost two
separate items their oracle: #228's overlay had to accept a synthetic marker pixel instead
of a tissue score, and #156's registration QC has a circular R2 control for the same reason.

The fixture is now the vendor's own emission and the spots land on it. This suite is what
makes that a CHECKED fact rather than an attachment nobody verifies — a committed file that
nothing asserts about is not a fixture.

## Why the negative control is the important half

"Every spot is inside the image" is trivially satisfiable by a bug: a predicate that never
looks at anything passes it, and so does one whose bounds are wrong in a forgiving
direction. So the same predicate function is also run against
`visium_fixtures.make_downscaled_hires`, which reconstructs the pre-#243 artifact EXACTLY
(the old 200x200 PNG was measured to be a bit-identical BICUBIC 10x downscale of the
vendor's 2000x2000 emission), and it must REJECT it, naming spots that fell out. A leg that
passes on the fixed fixture while the identical call fails on the broken one is evidence;
a leg that only passes is not.

## Why the reads are deliberately not the importer's

`visium_fixtures.hires_coverage` parses the CSV, the JSON and the PNG with `csv`, `json` and
PIL rather than through `import_visium`. The importer's affine is the thing whose PREMISE
this suite checks, so the check may not be assembled out of it — the same rule
`visium_fixtures.expected_xy` follows when it writes the `(x, y)` transpose out in the
opposite direction from the code.

## Numbering

`TEST-7` is absent here on purpose: it belongs to `test_package_registration.py`. The
`TEST-N` ids are a per-feature namespace shared across this package's suites, so the same
number can appear in another file meaning something else — check `TESTS.md` on the branch,
or the docstring, before assuming two `TEST-5`s are related. TEST-10 is placed beside TEST-2
rather than in numeric order because both prove halves of the same invariant.
"""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

#: Beside the bundle, NOT inside it — `visium-outs/` is an emulated Space Ranger `outs/`
#: root and every `visium_fixtures.make_*` helper copytrees it, so a file 10x never emits
#: would be propagated into all four synthetic bundles describing an image they do not have.
PROVENANCE = VF.FIXTURE.parent / "PROVENANCE.json"
HIRES_KEY = "spatial/tissue_hires_image.png"
HIRES = VF.FIXTURE / "spatial" / "tissue_hires_image.png"

#: The committed fixture directory's byte ceiling.
#:
#: The ceiling on `visium-outs/`, in DECIMAL BYTES throughout — every figure below is one
#: unit, deliberately, because two earlier drafts of this constant were wrong by mixing MB
#: and MiB and by measuring the wrong directory.
#:
#:     visium-outs/ today                     4,594,053 B   (sum of FIXTURE.rglob, as TEST-5)
#:     + the vendor's tissue_lowres_image.png   400,112 B   (PROVENANCE.json, not committed)
#:                                          = 4,994,165 B
#:     this ceiling                           4,700,000 B   -> 105,947 B of headroom
#:
#: The number exists to make ONE decision checkable: the vendor's real
#: `tissue_lowres_image.png` is deliberately NOT committed, because it would break
#: `test_absence_is_absence`'s assertion that this bundle emits exactly one image. Since
#: 4,994,165 > 4,700,000, adding it fails HERE as well as there — so the decision cannot be
#: reversed quietly, only argued.
#:
#: That 400,112 is recorded in `tests/fixtures/PROVENANCE.json` under
#: `spatial/tissue_lowres_image.png`, ON PURPOSE: it is the one figure in this derivation
#: that cannot be measured from the tree (the file is not in it), and a number a reader
#: cannot check is a number that rots. `PROVENANCE.json` ships; process notes do not.
#:
#: For scale and not as a bound, the Xenium fixture tree measures ~4.36 MB — deliberately
#: imprecise, because it moves whenever that package's fixtures do and an exact figure here
#: would go stale in silence. (It already did: an earlier exact byte count matched neither
#: revision.)
#:
#: What this does NOT bound, said plainly: git HISTORY. The 4,343,953 B PNG is permanent
#: once committed and no working-tree assertion undoes that. This caps what a future change
#: ADDS, which is the part still in anyone's control.
FIXTURE_BUDGET_BYTES = 4_700_000

#: Claims that were TRUE of the pre-#243 fixture and are FALSE of this one.
#:
#: Exact substrings, not patterns — each is a specific sentence a reader would now be misled
#: by. Kept as a list rather than swept by hand once, because the failure mode being guarded
#: is a stale comment surviving a fixture change, which is what happened to produce #243's
#: situation in the first place: the image was shrunk and everything that described it went
#: on describing the vendor's geometry.
FALSIFIED_CLAIMS = (
    "the image does not even cover the spots it is supposed to sit under",
    "of its 160 spots land on its own image",
    "shipped 200x200 vendor",
    "The RAW vendor fixture PNG is 200x200",
    # NOT also the longer "its `tissue_hires_image.png` is 200x200": that is a strict
    # superstring of this entry and could never fire independently of it.
    "`tissue_hires_image.png` is 200x200",
    "every spot maps outside the 200x200 frame",
    "zero of its spots land on its own image",
)

#: Files the scan does not judge, as paths RELATIVE to `CLAIM_SCAN_ROOT`.
#:
#: Relative rather than by basename so an exemption names exactly one file. A basename
#: exemption silently excuses every same-named file in the package, which is a worse failure
#: than the ambiguity it saves: it would switch a guard off somewhere nobody looked.
#:
#: * `tests/test_image_coherence.py` — this file, which is ABOUT the falsified claims.
#: * `compute/spatial_declarations.py`, `compute/ome_writer.py` — VENDORED copies, held
#:   byte-identical to `spatial-types`' originals ("Re-copy it; do not edit it here"): this
#:   package's own `test_vendored_contract.py` covers `spatial_declarations.py`, and
#:   `spatial-import-xenium`'s covers both by globbing `*/compute/<name>`. Without this
#:   exemption the guards could contradict each other — a banned sentence appearing upstream
#:   would have TEST-6 demand an edit the vendoring guard forbids, and the suite would be
#:   unsatisfiable. Neither file contains any of these strings today.
#:
#:   The cost, stated rather than left implicit: a falsified claim that appears UPSTREAM in
#:   `spatial-types` now propagates into these copies with TEST-6 blind to it. That is the
#:   right trade — the sentence would have to be fixed upstream anyway, and this package
#:   cannot be the one to fix it — but it is a real hole and not a free exemption.
CLAIM_SCAN_EXEMPT = (
    "tests/test_image_coherence.py",
    "compute/spatial_declarations.py",
    "compute/ome_writer.py",
)

#: The spots that pin every bound comparison, as `(barcode, pxl_row, pxl_col)` full-res.
#:
#: Defined ONCE because TEST-9 and TEST-11 both need them and two hand-written copies had
#: already drifted apart (one silently omitted a row) before this was hoisted. At
#: `tissue_hires_scalef` 0.2 on a 2000x2000 image each row lands exactly where one
#: comparison decides, and the expected verdict is in the name:
#:
#:     EXACTLY-ON  ->  10000 * 0.2 == 2000.0 == the extent   -> OUTSIDE (half-open)
#:     LAST-PIXEL  ->   9995 * 0.2 == 1999.0 <  the extent   -> inside
#:     AT-THE-ORIGIN ->            0.0                       -> inside (`>=` is inclusive)
#:     NEGATIVE    ->     -5 * 0.2 ==   -1.0                 -> OUTSIDE
EDGE_PROBE_POSITIONS = (
    ("EDGE-EXACTLY-ON-x-1", 4000, 10000),
    ("EDGE-LAST-PIXEL-x-1", 4000, 9995),
    ("EDGE-EXACTLY-ON-y-1", 10000, 4000),
    ("EDGE-LAST-PIXEL-y-1", 9995, 4000),
    ("EDGE-AT-THE-ORIGIN-1", 0, 0),
    ("EDGE-NEGATIVE-x-1", 4000, -5),
    ("EDGE-NEGATIVE-y-1", -5, 4000),
)

#: The subset of [`EDGE_PROBE_POSITIONS`] that must be reported OUTSIDE. Derived from the
#: names rather than restated, so adding a probe cannot leave a stale expectation behind.
EDGE_PROBES_EXPECTED_OUTSIDE = frozenset(
    barcode for barcode, _row, _col in EDGE_PROBE_POSITIONS
    if barcode.startswith(("EDGE-EXACTLY-ON", "EDGE-NEGATIVE"))
)

#: Where the scan looks: the whole package, RECURSIVELY.
#:
#: The first draft globbed `tests/*.py` non-recursively and a blind audit found two live
#: false statements it could not reach — both in `compute/registration_qc.py`, one of them
#: inside the module docstring's "What this module CANNOT check" section, which is exactly
#: where a reader goes to decide whether a real-tissue control is possible. That is the
#: reasoning path #228 and #156 each got wrong, so a guard that cannot see product code was
#: blind in the one place it most needed to see.
CLAIM_SCAN_ROOT = VF.PKG


@pytest.fixture(scope="module")
def provenance():
    return json.loads(PROVENANCE.read_text())


def test_every_real_spot_lands_on_the_real_image():
    """TEST-1 [acceptance] [invariant: INV-2] [covers: ITEM-1, ITEM-3] — #243, directly.

    Every row of the bundle's own `tissue_positions.csv`, scaled by the bundle's own
    `tissue_hires_scalef`, falls inside the bundle's own `tissue_hires_image.png`. Three
    files from one vendor emission, agreeing.

    This is the assertion that FAILS on `origin/main`, where the same call reports 0 of 160
    inside; `test_the_same_predicate_rejects_the_pre_243_fixture` proves that is still what
    it reports on the broken artifact.
    """
    report = VF.hires_coverage()

    assert report["n_spots"] == 160, (
        "the fixture's positions table changed size; the coherence claim is about THIS "
        f"bundle, so re-derive PROVENANCE.json before touching this number ({report})"
    )
    assert report["outside"] == [], (
        f"{len(report['outside'])} of {report['n_spots']} spots fall outside the committed "
        f"hires image {report['image_size']} at scalef {report['scalef']} — this is exactly "
        f"the #243 defect. First offenders: {report['outside'][:3]}"
    )


def test_the_scalefactor_is_what_makes_it_coherent():
    """TEST-2 [acceptance] [invariant: INV-1] [covers: ITEM-3] — the right scalefactor, applied.

    INV-1 is that Visium ties the down-sampled image to full-res spot coordinates VIA the
    scalefactor, and that you must apply the RIGHT one. A coherence test that passed no
    matter which number it used would not be testing that.

    So this asserts three things that are each false under a different way of getting the
    scalefactor wrong. Note carefully what the WRONG scalefactor does here, because an
    earlier draft of this docstring got it backwards: substituting `tissue_lowres_scalef`
    does NOT push the spots off the image — it collapses them into the top-left quadrant,
    which is INSIDE the bounds and still completely wrong. That is the reason "inside the
    image" is asserted against the image's OWN scalefactor and is not, on its own, the whole
    invariant.
    """
    report = VF.hires_coverage()
    factors = VF.scalefactors()
    width, height = report["image_size"]
    scalef = report["scalef"]

    assert scalef == 0.2, factors
    frame_w, frame_h = report["implied_fullres_frame"]
    assert frame_w >= report["fullres_x"][1] and frame_h >= report["fullres_y"][1], (
        "the image's implied full-resolution frame does not reach the positions' extent; "
        f"frame={(frame_w, frame_h)} positions_max="
        f"{(report['fullres_x'][1], report['fullres_y'][1])}"
    )

    xs_max, ys_max = report["fullres_x"][1], report["fullres_y"][1]

    # 1. Applying NO scalefactor puts the spots off the image. So the coherence above is
    #    produced BY the transform and is not an accident of the image happening to be
    #    bigger than the coordinates.
    assert xs_max > width and ys_max > height, (
        "the raw full-resolution coordinates already fit inside the image, so this fixture "
        "cannot show that applying the scalefactor is what makes them fit"
    )

    # 2. The WRONG scalefactor is a different transform: it implies a different
    #    full-resolution frame, which is the quantity the affine composes with. If the two
    #    scalefactors implied the same frame, "the right one was applied" would be
    #    unfalsifiable on this bundle.
    wrong = factors["tissue_lowres_scalef"]
    assert wrong != scalef
    assert width / wrong != pytest.approx(frame_w), (
        "the lowres scalefactor implies the same full-res frame as the hires one, so this "
        "fixture cannot demonstrate that the RIGHT scalefactor is the one being applied"
    )

    # 3. And the wrong one genuinely mis-places the spots: at 0.06 the whole table lands in
    #    the top-left 521x520 of a 2000x2000 image, i.e. nowhere near the tissue it is
    #    supposed to sit on. Inside the bounds, and still wrong — which is why "inside the
    #    image" is asserted against the image's OWN scalefactor and never against any.
    assert xs_max * wrong < width * 0.5 and ys_max * wrong < height * 0.5, (
        "the lowres scalefactor does not visibly mis-place the spots on this bundle, so "
        "TEST-1's bounds check could pass under either scalefactor"
    )


def test_the_scalefactor_is_read_from_the_bundle_not_assumed(tmp_path):
    """TEST-10 [acceptance] [invariant: INV-1] [covers: ITEM-3] — the OTHER half of INV-1.

    INV-1 has two halves: the right scalefactor must be applied, and it comes FROM
    `scalefactors_json.json`. TEST-2 pins the first. A blind audit showed nothing pinned the
    second: hardcoding `scalef = 0.2` inside `hires_coverage` and never opening the JSON at
    all left all eight coherence tests green. Every bundle in the tree states 0.2, so a
    function that ignores the file is indistinguishable from one that reads it — until a
    bundle states something else.

    So this makes a bundle that states something else. At 0.4 on the same 2000x2000 image
    the implied full-resolution frame halves to 5000, which no longer reaches the spots'
    own extent (max x 6911), and the table falls off the image. A reader that ignored the
    file would still report every spot inside and this test would go red.
    """
    factors = dict(VF.scalefactors())
    factors["tissue_hires_scalef"] = 0.4
    probe = VF.make_geometry_probe(
        tmp_path, image_size=(2000, 2000),
        scalefactors_text=json.dumps(factors), name="restated-scalef",
    )
    report = VF.hires_coverage(probe)

    assert report["scalef"] == 0.4, (
        "hires_coverage did not pick up the bundle's restated scalefactor, so it is not "
        f"reading scalefactors_json.json at all: {report['scalef']}"
    )
    assert report["implied_fullres_frame"] == (5000.0, 5000.0), (
        "2000 / 0.4 is exactly 5000.0 in binary floating point, so this is an exact "
        f"comparison on purpose; getting {report['implied_fullres_frame']} means the frame "
        "is not being derived from the restated scalefactor"
    )
    assert report["n_inside"] < report["n_spots"], (
        "with the scalefactor restated to 0.4 the spots must no longer fit the image; that "
        "they still do means the number is being assumed rather than read"
    )
    # And the committed bundle, unchanged, still reads 0.2 — so the probe changed the
    # BUNDLE, not this function's behaviour.
    assert VF.hires_coverage()["scalef"] == 0.2


def test_the_same_predicate_rejects_the_pre_243_fixture(tmp_path):
    """TEST-3 [acceptance] [invariant: INV-2] [covers: ITEM-4] — the discrimination proof.

    The identical function that reports 0 outside on the committed fixture must report the
    whole table outside on a 10x BICUBIC downscale of it — which is not a hypothetical
    degradation but a byte-exact reconstruction of the artifact this repository carried
    until #243.

    Without this leg, TEST-1 could be green because the predicate is broken. With it, TEST-1
    being green means the fixture is coherent, because the same predicate demonstrably still
    catches the incoherent case.
    """
    broken = VF.make_downscaled_hires(tmp_path)
    report = VF.hires_coverage(broken)

    # The BYTES, not just the dimensions. Five docstrings in this branch call this a
    # byte-exact reconstruction of what shipped; until this line, only `(200, 200)` was
    # pinned, so swapping the resampling filter — or a Pillow/zlib upgrade changing the
    # encoder — would have left every test green while the "negative control" quietly
    # became an approximation of the historical artifact instead of the artifact.
    digest = hashlib.sha256(
        (broken / "spatial" / "tissue_hires_image.png").read_bytes()
    ).hexdigest()
    assert digest == VF.PRE_243_HIRES_SHA256, (
        "make_downscaled_hires no longer reproduces the PNG this repository actually "
        f"shipped before #243 (expected {VF.PRE_243_HIRES_SHA256}, got {digest}). The "
        "negative control is only evidence while it is the real historical artifact"
    )
    assert report["image_size"] == (200, 200), (
        "the reconstruction is not the pre-#243 artifact, so failing on it proves nothing "
        f"about the artifact that actually shipped ({report['image_size']})"
    )
    assert report["scalef"] == 0.2, (
        "the downscale must leave scalefactors_json.json ALONE — restating the scalefactor "
        "would make the shrunk bundle coherent again and destroy the negative control"
    )
    assert report["n_spots"] == 160
    assert report["n_inside"] == 0, (
        "the pre-#243 fixture is being reported as coherent, so the predicate does not "
        f"discriminate and TEST-1's pass is vacuous ({report['n_inside']} inside)"
    )
    assert len(report["outside"]) == 160
    assert all("barcode" in spot for spot in report["outside"]), (
        "the rejection does not name which spots fell out, so a failure would not tell a "
        "reader what is wrong"
    )

    # AND the committed one still passes, in the same test, so the two results are measured
    # by one code path on one run rather than compared across suites.
    assert VF.hires_coverage()["n_inside"] == 160


def test_the_committed_png_is_the_vendor_emission_unmodified(provenance):
    """TEST-4 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-5] — not a crop.

    INV-3: "it must be a genuine vendor emission, not a crop, since cropping breaks the very
    coherence being tested." A crop, a resize or a re-encode all preserve the FILE while
    destroying the property, and all three would leave TEST-1 looking fine only if the
    coordinates happened to survive — which for a crop they would not, and for a resize (the
    #243 defect) they did not.

    ## What this actually defends, stated precisely

    A blind audit was right to push on the first draft of this docstring, which claimed the
    test "compares the tree against the vendor rather than against itself". It does not, and
    no offline test could: `PROVENANCE.json` and the PNG landed in one commit, so updating
    both together passes. That was demonstrated — a lossless re-encode plus a matching
    `sha256`/`bytes` edit goes green.

    So the honest account is two-part.

    * **Geometry is defended outright.** The `(2000, 2000)` literal below is in the TEST, not
      in the JSON, so a crop or a resize cannot be waved through by editing the record — the
      same audit confirmed a 1500x1800 crop with every provenance field updated still goes
      red here. That is the half INV-3 is really about: a crop breaks the coherence.
    * **Byte-identity is a review tripwire, not a proof.** Changing it requires editing a
      recorded vendor digest in a diff, which is visible and arguable, rather than silently
      swapping a file. A pixel-preserving re-encode could pass both — and a pixel-preserving
      re-encode does not break coherence, which is why that residue is acceptable rather
      than papered over. `source_archive_sha256` in `PROVENANCE.json` is what a reviewer
      re-verifies against 10x's published archive; nothing offline can check it for them.
    """
    record = provenance[HIRES_KEY]
    digest = hashlib.sha256(HIRES.read_bytes()).hexdigest()

    assert digest == record["sha256"], (
        "the committed hires image is no longer byte-identical to 10x's published "
        f"emission. If it was resized or cropped to save space, that re-opens #243 — the "
        f"coherence being tested IS the vendor's geometry. expected {record['sha256']}, "
        f"got {digest}"
    )
    assert HIRES.stat().st_size == record["bytes"]

    from PIL import Image

    with Image.open(HIRES) as im:
        assert im.size == (record["width"], record["height"]) == (2000, 2000)
        assert im.mode == record["mode"]

    coherence = record["coherence"]
    assert coherence["spots_inside_image"] == coherence["spots"] == 160, (
        "PROVENANCE.json's own recorded coherence disagrees with the claim this suite "
        "makes; one of the two is stale"
    )
    measured = VF.hires_coverage()
    assert coherence["tissue_hires_scalef"] == measured["scalef"]
    assert tuple(coherence["implied_fullres_frame"]) == measured["implied_fullres_frame"]


def test_the_fixture_states_its_licence_and_stays_within_budget(provenance):
    """TEST-5 [acceptance] [invariant: INV-4] [covers: ITEM-1, ITEM-2] — both constraints, checked.

    INV-4 is a SIZE constraint, and a size constraint nothing measures is a hope. The licence
    is in the same test because both are claims about whether this file is allowed to be in
    the repository at all, and both were prose in a PR description until they were assertions
    here.

    #78 exists in this tree because a redistribution question was left unanswered once. This
    one is answered — CC BY 4.0, stated on this dataset's own page — and the answer is
    carried WITH the bytes, where CC BY's attribution condition actually needs it.
    """
    total = sum(p.stat().st_size for p in VF.FIXTURE.rglob("*") if p.is_file())
    assert total <= FIXTURE_BUDGET_BYTES, (
        f"the committed visium fixture is {total:,} bytes, over the "
        f"{FIXTURE_BUDGET_BYTES:,} ceiling. Adding another vendor image is a DECISION "
        "(see DEC-3, which descoped the lowres image), not a drive-by"
    )

    record = provenance[HIRES_KEY]
    for field in ("source_url", "sha256", "license", "license_url", "license_text",
                  "license_source", "citation", "dataset_page"):
        assert record.get(field), f"PROVENANCE.json records no {field} for {HIRES_KEY}"
    assert record["license"] == "CC BY 4.0"
    assert "creativecommons.org/licenses/by/4.0" in record["license_url"]
    assert "Creative Commons Attribution 4.0 International" in record["license_text"]
    assert record["source_url"].startswith("https://cf.10xgenomics.com/samples/spatial-exp/")
    assert "10x Genomics" in record["citation"]

    for key in ("spatial/tissue_positions.csv", "spatial/scalefactors_json.json"):
        assert provenance[key]["license"] == "CC BY 4.0", (
            f"{key} is redistributed from the same dataset and must carry the same licence"
        )


def test_no_stale_claim_that_the_shipped_image_is_incoherent_survives():
    """TEST-6 [covers: ITEM-6] — the record is corrected, not just the bytes.

    FIVE files in this package described the shipped image as a 200x200 placeholder that
    cannot cover its own spots — four under `tests/` and, carrying two of the sentences
    itself, `compute/registration_qc.py`. (Counted by running this scan against
    `origin/main`, not estimated: an earlier draft of this docstring said "eight suites".)
    Every one of those sentences is now false, and a false comment is worse than no comment:
    the next reader plans around a limitation that no longer exists, which is precisely how
    #228 and #156 each independently accepted a weaker oracle.

    ## What this guard is and is not

    It scans the WHOLE package recursively, `compute/` included. The first draft globbed only
    `tests/*.py` and a blind audit found the two `compute/` statements sitting live and
    unreachable behind it.

    It matches EXACT substrings, which cuts BOTH ways and both are deliberate:

    * it catches a copy of one of these sentences surviving a later edit — the failure mode
      that produced #243's situation, where the image was shrunk and everything describing
      it went on describing the vendor's geometry;
    * it does NOT catch a REWORDED restatement (an earlier draft of this docstring claimed
      "no evasion space", which overstates a substring match);
    * and it DOES fire on a sentence that merely contains one of these strings while being
      true or correctly past-tense — a blind audit demonstrated both. That is a false
      positive in the strict sense and it is accepted: these exact phrasings are retired,
      and the fix when one trips is to reword, which is cheap. A guard that tried to judge
      tense would be the semantic pattern-match this deliberately is not.

    It is a cheap tripwire on known-false sentences, not a behavioural test — the behaviour
    is asserted by TEST-1 through TEST-4 and TEST-8 through TEST-10.
    """
    offenders = []
    for path in sorted(CLAIM_SCAN_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        relative = path.relative_to(CLAIM_SCAN_ROOT).as_posix()
        if relative in CLAIM_SCAN_EXEMPT:
            continue
        text = path.read_text()
        for claim in FALSIFIED_CLAIMS:
            if claim in text:
                offenders.append(f"{relative}: {claim!r}")

    assert offenders == [], (
        "these files still state that the SHIPPED vendor image does not cover its own "
        "spots, which #243 fixed:\n  " + "\n  ".join(offenders)
    )


def test_the_predicate_reads_x_against_width_and_y_against_height(tmp_path):
    """TEST-8 [acceptance] [invariant: INV-2] [covers: ITEM-3] — on a NON-SQUARE frame.

    INV-2 is about a real image and real positions being MUTUALLY consistent, and "mutually"
    has an axis to it: a check that compares x against the height and y against the width
    would report the committed bundle coherent anyway, because that image is 2000x2000 and
    every spot sits at least 200 px from every edge. A blind audit proved this by mutation —
    transposing the two coordinate columns inside `hires_coverage` left all fifty covering
    tests green.

    So the convention is asserted where it can actually fail. After scaling, the bundle's
    spots span x in [220, 1382] and y in [566, 1734]; those ranges do not overlap at the
    top, so a frame of 1500 WIDE by 1800 HIGH contains every spot while its TRANSPOSE,
    1800 wide by 1500 high, does not — 1734 does not fit in 1500.

    One assertion therefore kills both spellings of the bug: swapping the coordinates, and
    swapping the extents. The second half is the control, so "all inside" is not simply what
    a big enough image always yields.
    """
    upright = VF.hires_coverage(VF.make_geometry_probe(tmp_path, image_size=(1500, 1800),
                                                       name="upright"))
    assert upright["image_size"] == (1500, 1800)
    assert upright["outside"] == [], (
        "a 1500x1800 frame does not contain the bundle's spots, which it must unless x is "
        f"being read against the height or the columns are transposed: {upright['outside'][:3]}"
    )

    # THE CONTROL: the same pixels, the extents swapped. If this were also fully inside, the
    # assertion above would be satisfied by any sufficiently large frame and would say
    # nothing about which axis is compared to which.
    sideways = VF.hires_coverage(VF.make_geometry_probe(tmp_path, image_size=(1800, 1500),
                                                        name="sideways"))
    assert sideways["image_size"] == (1800, 1500)
    assert sideways["n_inside"] < sideways["n_spots"], (
        "the transposed frame contains every spot too, so this fixture cannot distinguish "
        "x-against-width from x-against-height"
    )


def test_both_ends_of_the_half_open_bound_are_asserted(tmp_path):
    """TEST-9 [acceptance] [invariant: INV-2] [covers: ITEM-3] — all four comparisons, each able to fail alone.

    `hires_coverage` documents `0 <= x < width` and `0 <= y < height`, matching the
    product's own (`registration_qc.score_registration` uses `(xs >= 0) & (xs < width)`).
    On the committed bundle NONE of the four can fail. Nothing lands within 200 px of a far
    edge (the closest is 266 px), and nothing approaches the origin either — the per-axis
    minima are full-res col 1100 and row 2830, i.e. 220 and 566 after scaling. So `<` and
    `<=`, and `>=` and `>`, agree everywhere on the real data, and each comparison has been
    checked to fail ALONE only because [`EDGE_PROBE_POSITIONS`] puts a spot exactly where it
    decides:

    * `x == width` (10000 * 0.2 == 2000.0 exactly) -> OUTSIDE; `x == width - 1` -> inside;
    * the same pair on y;
    * the origin -> INSIDE, because `>=` is inclusive there;
    * a NEGATIVE coordinate -> OUTSIDE — the case that vanishes entirely if the lower bound
      is dropped, which is the mutation that motivated this test.

    The exactness of `10000 * 0.2 == 2000.0` is not luck: the error is 0.49 ulp and IEEE-754
    mandates correctly-rounded multiplication, so every conforming double platform agrees.
    """
    probe = VF.make_geometry_probe(
        tmp_path, image_size=(2000, 2000),
        extra_positions=EDGE_PROBE_POSITIONS, name="edges",
    )
    report = VF.hires_coverage(probe)
    outside = {spot["barcode"] for spot in report["outside"]}

    assert outside == set(EDGE_PROBES_EXPECTED_OUTSIDE), (
        "the half-open bounds are not being applied as documented. A spot at exactly "
        "`width`/`height` addresses no pixel and must be OUTSIDE; a negative coordinate is "
        "off the image and must be OUTSIDE; the origin and the last pixel must be INSIDE. "
        f"Expected outside = {sorted(EDGE_PROBES_EXPECTED_OUTSIDE)}, got {sorted(outside)}"
    )
    # DERIVED, not written down: the vendor's 160 plus one row per probe, minus the probes
    # that are meant to fall out. A literal here would need re-deriving by hand every time a
    # probe is added, which is how a count assertion turns into a rubber stamp.
    # The crafted rows' OWN properties, which nothing asserted until a blind audit pointed
    # out that reverting either of them left the suite green. Both matter: an array index
    # colliding with a real spot's would make the probe an ambiguous duplicate (the fixture
    # really does hold a spot at array (0, 0), which an earlier draft collided with), and
    # `in_tissue` must be 0 because no vendor tissue call applies to a coordinate this suite
    # invented.
    crafted = {b for b, _r, _c in EDGE_PROBE_POSITIONS}
    rows = VF.positions_table(probe)
    real_indices = {(r["array_row"], r["array_col"])
                    for r in rows if r["barcode"] not in crafted}
    for row in (r for r in rows if r["barcode"] in crafted):
        assert row["in_tissue"] == "0", (
            f"crafted probe {row['barcode']} claims in_tissue=1; these are geometry probes "
            "and carry no vendor tissue call"
        )
        assert (row["array_row"], row["array_col"]) not in real_indices, (
            f"crafted probe {row['barcode']} reuses a real spot's array index "
            f"({row['array_row']}, {row['array_col']}), making it an ambiguous duplicate"
        )

    expected_spots = 160 + len(EDGE_PROBE_POSITIONS)
    assert report["n_spots"] == expected_spots, (
        f"the probe bundle holds {report['n_spots']} rows, not the vendor's 160 plus "
        f"{len(EDGE_PROBE_POSITIONS)} crafted ones — make_geometry_probe wrote the table wrong"
    )
    assert report["n_inside"] == expected_spots - len(EDGE_PROBES_EXPECTED_OUTSIDE)


def test_the_coverage_predicate_agrees_with_the_SHIPPED_one(tmp_path):
    """TEST-11 [acceptance] [invariant: INV-2] [covers: ITEM-3] — the behavioural anchor.

    ## Why this test exists, and why the ones above are not enough

    TEST-8 through TEST-10 check that `hires_coverage` matches a convention written down in
    its own docstring, one comparison at a time. That is the wrong shape of assurance to rest
    on: successive reviews each found one more comparison nobody had pinned, and there was no
    reason to believe that had stopped. A hand-written mirror can be checked forever without
    ever being checked against the thing it mirrors.

    So it is anchored to that thing. `hires_coverage` exists to answer, independently of the
    importer, the question the SHIPPED registration QC answers with `score_registration`:

        inside = (xs >= 0) & (xs < width) & (ys >= 0) & (ys < height)

    This drives that exact production function over the same coordinates and image shapes and
    requires the two to return the same count, on five bundles chosen to exercise every
    comparison at once — the coherent vendor bundle, the pre-#243 artifact where nothing is
    inside, a non-square frame and its transpose, and the probe carrying spots on the origin,
    past the far edge, and at negative coordinates.

    That converts "my helper implements the convention I wrote down" into "my helper and the
    product agree about which spots are on the image". A change to EITHER side's convention
    now turns this red — verified both ways — which the one-comparison-at-a-time tests could
    never do: they would have gone on agreeing with a stale mirror.

    It does not REPLACE them, which was measured rather than assumed. This test compares two
    sides and so cannot see a fault they share: a consistently transposed `image_size` (TEST-8
    catches it), both sides drifting the same way (TEST-9), or a scalefactor this test takes
    from `hires_coverage` itself (TEST-10). All four legs are load-bearing.

    The independence that matters is preserved, and it took a correction to get right: the
    coordinates, the scalefactor and the image extents are all read from the BUNDLE here —
    `scaled_xy` off the CSV and the JSON, the size off the PNG — never out of
    `hires_coverage`'s own report. A draft that took the extents and the scalefactor from the
    report fed both sides the same numbers, so a width/height swap inside `hires_coverage`
    left this green. What the two sides share is the in-frame COMPARISON and nothing else,
    which is exactly the thing being cross-checked.
    """
    import numpy as np
    from PIL import Image

    # `load_compute()` installs the package's `compute/` modules into `sys.modules` BY PATH,
    # reproducing how the sandbox stages `/code`. The bare import below resolves through
    # that, not through `sys.path` — same mechanism `test_sandbox_reachability` uses, and the
    # reason `visium_fixtures.load_compute` exists at all.
    VF.load_compute()
    import registration_qc as RQ

    PRE_243 = "the pre-#243 artifact"
    bundles = {
        "committed vendor bundle": VF.FIXTURE,
        PRE_243: VF.make_downscaled_hires(tmp_path),
        "non-square frame": VF.make_geometry_probe(
            tmp_path, image_size=(1500, 1800), name="agree-upright"),
        "non-square frame, transposed": VF.make_geometry_probe(
            tmp_path, image_size=(1800, 1500), name="agree-sideways"),
        "origin / negative / exactly-on-the-edge spots": VF.make_geometry_probe(
            tmp_path, image_size=(2000, 2000), name="agree-edges",
            extra_positions=EDGE_PROBE_POSITIONS),
    }

    disagreements = []
    for label, bundle in bundles.items():
        mine = VF.hires_coverage(bundle)
        rows = VF.positions_table(bundle)
        # Through `scaled_xy`, not spelled out again here. An earlier draft inlined the
        # `col -> x` / `row -> y` transpose, which made this the THIRD hand-written copy of a
        # convention the branch is trying to pin down to one.
        xs, ys = (np.array(v) for v in VF.scaled_xy(bundle))
        # From the PNG ITSELF, not from `mine["image_size"]`. An earlier draft took both the
        # extents and the scalefactor out of the report under test, which meant a width/height
        # swap or a hardcoded scalefactor inside `hires_coverage` fed BOTH sides the same
        # wrong numbers and this test stayed green — mutation-verified, and squarely against
        # what its own docstring claims. The only thing the two sides may share is the
        # in-frame comparison, because that is what is being cross-checked.
        with Image.open(Path(bundle) / "spatial" / "tissue_hires_image.png") as im:
            width, height = im.size
        # The mask's CONTENT is irrelevant to `spots_inside_image`; only its shape is read,
        # and `score_registration` takes `(height, width)` numpy order — which is itself a
        # transposition this comparison would catch if it were got wrong here.
        theirs = RQ.score_registration(
            np.zeros((height, width), dtype=bool), (xs, ys),
            # `in_tissue` is CSV text, so the flag is the string "1". Every crafted probe row
            # carries "0" (see `make_geometry_probe`) — which is irrelevant here, because
            # `spots_inside_image` is a geometry count and does not consult the labels.
            [r["in_tissue"] == "1" for r in rows],
        )
        if theirs["spots_inside_image"] != mine["n_inside"] or theirs["n_spots"] != mine["n_spots"]:
            disagreements.append(
                f"{label}: shipped says {theirs['spots_inside_image']}/{theirs['n_spots']} "
                f"inside, hires_coverage says {mine['n_inside']}/{mine['n_spots']}"
            )

    assert disagreements == [], (
        "the independent coherence check and the SHIPPED registration QC disagree about "
        "which spots land on the image. One of the two has the wrong in-frame convention, "
        "and every coherence claim in this suite rests on them agreeing:\n  "
        + "\n  ".join(disagreements)
    )

    # AND the set really does contain both answers, so agreement is not agreement on a
    # constant. Two mirrors that both always said "inside" would agree perfectly.
    assert VF.hires_coverage(VF.FIXTURE)["n_inside"] == 160, (
        "the committed bundle no longer has every spot inside its own image, so this test's "
        "agreement is being measured over one answer only"
    )
    assert VF.hires_coverage(bundles[PRE_243])["n_inside"] == 0, (
        "the pre-#243 artifact no longer has every spot OUTSIDE, so both sides of the "
        "comparison could be stuck on the same constant and still agree"
    )
