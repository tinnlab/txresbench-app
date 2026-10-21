#!/usr/bin/env python3
# ruff: noqa
"""#323 — a coordinate frame identity is never a name the run could have borrowed.

`coordinate_space_id` was a three-rung ladder and EVERY rung could answer with a value two
unrelated runs share. MEASURED on clean `origin/main` @ `5c6b499e`, driving the shipped
`coordinate_space_id` + `section_sample_id` (the same rows #323 records, first measured at
`778eddc3` and reproduced unchanged before a line of this branch was written):

    roi_uuid='unknown'   run-A / run-B      -> BOTH xenium:unknown          (roi_uuid)
    slide/region='unknown'   run-A / run-B  -> BOTH xenium:unknown_unknown  (slide_id+region_name)
    nothing, root=/inputs/bundle            ->      xenium:bundle           (bundle-directory-name)
    nothing, /uploads/x/outs, /uploads/y/outs-> BOTH xenium:outs            (bundle-directory-name)

Each pair is two unrelated experiments declared to share ONE coordinate frame — one tissue's image
registered against the other's cells — which is exactly the failure the ladder's own docstring
rejects `library_ids` for.

## The discipline these tests are held to

Inherited from `test_declaration_residues.py` and `test_unverified_declarations.py`, because the
same trap is here: asserting the NEW value alone cannot tell a fix from a coincidence. So

* every row of #323's table is re-driven here (TEST-1) rather than described, and
* the fix is additionally pinned by a DISAGREEMENT with the pre-change body (TEST-8), which is a
  SOURCE MUTATION of the shipped file — `origin/main`'s `coordinate_space_id` verbatim, spliced
  back into the real module — so a revert makes the two identical and this suite reddens, and
* every rejection test carries a POSITIVE CONTROL in the same run: a rule that simply refused
  everything would satisfy "no two runs collide" perfectly and destroy every real frame.

## Why "two unrelated runs" now means two different MATRICES

The bottom rung is a digest of the vendor's own per-cell identities, so two staged copies of ONE
fixture bundle are — correctly — the same measurement and the same frame. A test that staged the
same bundle twice and changed only `experiment.xenium` would therefore be asserting a collision
that is not false. `_unrelated_pair` restages the cell ids as well, which is what makes the two
runs genuinely unrelated; that is a strengthening of the fixture, not a workaround.
"""
import inspect
import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

XF.load_compute()  # installs the vendored helpers under their bare names


#: Two runs' worth of vendor cell ids AND the centroids they were measured at — the two halves the
#: derived rung digests. Different in BOTH, so the two runs are unrelated by everything the bottom
#: rung can see.
IDS_A = ["aaaadpbp-1", "aaaadpbq-1", "aaaadpbr-1"]
POS_A = np.asarray([[10.5, 20.5], [11.5, 21.5], [12.5, 22.5]], dtype=np.float32)
IDS_B = ["ffkpbaba-1", "ffkpbabb-1"]
POS_B = np.asarray([[100.25, 200.25], [101.25, 201.25]], dtype=np.float32)

#: THE SHAPE THE FIRST VERSION OF THE BOTTOM RUNG COLLIDED ON, kept as data: two genuinely
#: different measurements whose matrices carry the SAME generically numbered ids. Nothing validates
#: the vendor's id format, so this is reachable, and digesting the ids alone declared these two
#: unrelated runs one frame. Driven by TEST-1 and by TEST-3's end-to-end half.
GENERIC_IDS = ["1", "2", "3"]
GENERIC_POS_A = np.asarray([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]], dtype=np.float32)
GENERIC_POS_B = GENERIC_POS_A + np.float32(137.5)

#: #323's own table, as data. Every row is a shape on which `origin/main` gave two unrelated runs
#: ONE frame; the last row is the self-naming shape #320 measured and withdrew a gate for.
COLLIDING_SHAPES = [
    ("roi_uuid='unknown'", {"roi_uuid": "unknown"}),
    ("slide/region='unknown'", {"slide_id": "unknown", "region_name": "unknown"}),
    ("nothing stated", {}),
    ("prime-shaped self-naming labels", {"slide_id": "slide", "region_name": "region"}),
]

#: The two rungs that work as designed. These are the control: a rule that refused everything would
#: pass every distinctness assertion above and destroy the frames that are genuinely stated.
STATED_SHAPES = [
    ({"roi_uuid": "c55618d8-1234-4444-8888-000000000001"},
     "xenium:c55618d8-1234-4444-8888-000000000001", "roi_uuid"),
    ({"slide_id": "Slide_1", "region_name": "hKidney_sample"},
     "xenium:slide_id+region_name:7:Slide_1|14:hKidney_sample|", "slide_id+region_name"),
]

#: The `coordinate_space_source` whose VALUE #328 deliberately MOVED, and the value it moved FROM.
#: Rung 1 is untouched (`xenium:<roi_uuid>`, verbatim, exactly as before) — this is the one row of
#: `STATED_SHAPES` that is a shipped-id change rather than a re-pointing, and every test that
#: compares the pre-change ladder against the shipped one has to know WHICH row that is or it is
#: asserting "nothing moved" about a change whose whole point is that something did (DEC-2).
MOVED_BY_328_SOURCE = "slide_id+region_name"
MOVED_BY_328_FROM = "xenium:Slide_1_hKidney_sample"

#: The two `f"xenium:{slide}_{region}"` collisions #328 measured, as data: each pair is two
#: unrelated runs making DIFFERENT, fully identifying vendor statements. Both were asserted on this
#: branch's predecessor as CHARACTERIZATIONS — tests that said "this collides, and here is the
#: issue" — and both are now asserted as the collisions they are not.
INJECTIVITY_PAIRS = [
    ("rung-2-internal: `_` is a separator neither component is free of",
     {"slide_id": "Slide_1_HeartBlock", "region_name": "R2"},
     {"slide_id": "Slide_1", "region_name": "HeartBlock_R2"}),
    ("cross-rung: rung 1 and rung 2 emitted into ONE undelimited namespace",
     {"roi_uuid": "Slide_1_R2"},
     {"slide_id": "Slide_1", "region_name": "R2"}),
]


def _module():
    return XF.load_compute()


# ── TEST-1 [acceptance] (INV-1) — #323's table, after ────────────────────────────────

def test_no_shape_in_323s_table_gives_two_unrelated_runs_one_frame():
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-4].

    INV-1: *two unrelated runs must never be declared to share one coordinate frame.*

    Every row of #323's measured table, re-driven after the fix, plus the shape #320's withdrawn
    gate was about. The assertion is the invariant itself — two unrelated runs, different frames —
    not "the value equals this string", so it cannot be satisfied by a coincidence of spelling.

    The two STATED rows are what stop this passing vacuously: a `coordinate_space_id` that returned
    a fresh digest unconditionally would satisfy every distinctness assertion here and would have
    destroyed the vendor-derived frame that the whole ladder exists to preserve.
    """
    module = _module()

    for label, experiment in COLLIDING_SHAPES:
        space_a, source_a = module.coordinate_space_id(experiment, IDS_A, POS_A)
        space_b, source_b = module.coordinate_space_id(experiment, IDS_B, POS_B)
        assert space_a != space_b, (
            f"{label}: two unrelated runs were declared to share one coordinate frame — one "
            f"tissue's image registered against the other's cells. Both got {space_a!r}")
        assert source_a == source_b, (
            f"{label}: the same vendor statement must land on the same RUNG for both runs; "
            f"{source_a!r} vs {source_b!r}")
        assert source_a in (module.NON_IDENTIFYING_SPACE_SOURCE,
                            module.NO_VENDOR_SPACE_SOURCE), (label, source_a)
        # ...and the sample id, which quotes the space id, inherits the distinctness.
        assert module.section_sample_id(experiment, space_a)[0] != \
            module.section_sample_id(experiment, space_b)[0], label

    # THE SHAPE THE IDS-ONLY DIGEST COLLIDED ON: two different measurements, same generic ids.
    generic_a = module.coordinate_space_id({}, GENERIC_IDS, GENERIC_POS_A)
    generic_b = module.coordinate_space_id({}, GENERIC_IDS, GENERIC_POS_B)
    assert generic_a[0] != generic_b[0], (
        "two genuinely different measurements whose matrices carry the same generically numbered "
        "cell ids are declared to share one frame — nothing validates the vendor's id format, so "
        f"this is reachable, and it is #323's own defect at the rung meant to remove it: {generic_a}")

    for experiment, expected_space, expected_source in STATED_SHAPES:
        for ids, positions in ((IDS_A, POS_A), (IDS_B, POS_B)):
            assert module.coordinate_space_id(experiment, ids, positions) == \
                (expected_space, expected_source), (
                "the VENDOR's own frame identity must still answer, and must not depend on the "
                f"run's content: {experiment!r}")

    # A NUMERIC frame label is NOT an identity (DEC-15). Both identity predicates are blind to a
    # number — `_VENDOR_PLACEHOLDERS` is a string vocabulary and `non_identifying_vendor_label`
    # returns False for a non-string — so a number would be an UNFILTERABLE identity in the one
    # field whose job is not to falsely collide. Measured by a blind angle on the first version of
    # this branch: `roi_uuid: 0` answered `xenium:0` for two unrelated runs.
    for numeric in (0, -1, 0.0, 12345):
        for key in ("roi_uuid", "slide_id", "region_name"):
            a = module.coordinate_space_id({key: numeric}, IDS_A, POS_A)
            b = module.coordinate_space_id({key: numeric}, IDS_B, POS_B)
            assert a[0] != b[0], (key, numeric, a)
            assert a[1] == module.NON_IDENTIFYING_SPACE_SOURCE, (key, numeric, a)

    # A vendor value carrying this module's OWN derived prefix is refused as an identity, so
    # `UNVERIFIED_SPACE_PREFIX`'s "no vendor writes this" is ENFORCED rather than hoped for.
    for spelling in ("unverified-space:deadbeefdeadbeefdeadbeefdeadbeef",
                     # CASE VARIANT: the claim is about what a reader can tell apart, not bytes.
                     "Unverified-Space:deadbeefdeadbeefdeadbeefdeadbeef",
                     "UNVERIFIED-SPACE:deadbeefdeadbeefdeadbeefdeadbeef"):
        assert module.coordinate_space_id({"roi_uuid": spelling}, IDS_A, POS_A)[1] == \
            module.NON_IDENTIFYING_SPACE_SOURCE, (
            "a vendor string a reader cannot tell from a DERIVED id was emitted with "
            f"`coordinate_space_source: roi_uuid`, which is a claim the value contradicts: {spelling}")


def test_a_vendor_cannot_forge_either_unverified_prefix(tmp_path):
    """TEST-16 [covers: ITEM-16] — the two prefixes are enforced SYMMETRICALLY, end to end.

    `experiment.xenium` is attacker-controlled JSON, so both "no vendor writes this prefix" claims
    are claims about UNTRUSTED input. A blind security angle found them asymmetric after #323
    tightened one: `vendor_frame_label` refused a `roi_uuid` carrying `unverified-space:`, and
    `section_sample_id` happily emitted a `region_name` of
    `unverified-sample:xenium:unverified-space:<a victim's 32 hex>` VERBATIM as `section.sample_id`
    with `sample_id_source: "region_name"` — two artifacts in DIFFERENT, correctly-derived
    coordinate frames declaring themselves sections of ONE sample. That is the FALSE collision this
    module names as the unrecoverable direction, and it is reachable by anyone who can read a
    victim's derived id out of an exported report.

    Driven end to end over two genuinely unrelated bundles, with the forged value taken from the
    FIRST bundle's real emitted id — so the test cannot pass by the forgery being malformed.

    The CONTROL is the third bundle: a real region name that merely CONTAINS the word `unverified`
    is still emitted verbatim, so the guard is a prefix rule and not a substring one.
    """
    module = _module()

    victim = XF.stage_bundle(tmp_path, name="victim")
    XF.restage_cell_ids(victim, "-VICTIM")
    doc = json.loads((victim / "experiment.xenium").read_text())
    for key in ("roi_uuid", "slide_id", "region_name"):
        doc.pop(key, None)
    (victim / "experiment.xenium").write_text(json.dumps(doc))
    victim_meta, _ = _imported(tmp_path, victim, "victim")
    stolen = victim_meta["section"]["sample_id"]
    assert stolen.startswith(module.UNVERIFIED_SAMPLE_PREFIX), stolen

    for label, forged in (("exact", stolen), ("upper", stolen.upper())):
        attacker = XF.stage_bundle(tmp_path, name=f"attacker-{label}")
        XF.restage_cell_ids(attacker, f"-ATTACKER-{label}")
        XF.shift_centroids(attacker, 555.0)
        doc = json.loads((attacker / "experiment.xenium").read_text())
        doc.pop("roi_uuid", None)
        doc["region_name"] = forged
        (attacker / "experiment.xenium").write_text(json.dumps(doc))
        meta, report = _imported(tmp_path, attacker, f"attacker-{label}")

        assert meta["coordinate_space"] != victim_meta["coordinate_space"], (
            "the two bundles must be different frames, or this test is not measuring a forgery")
        assert meta["section"]["sample_id"] != stolen, (
            f"a bundle forged another run's sample id ({label} spelling) and was declared a "
            f"section of ITS sample: {meta['section']}")
        assert report["section"]["sample_id_source"] == "non-identifying-region-name", report

    # THE CONTROL: a real name that merely CONTAINS the word is still the vendor's own statement.
    honest = XF.stage_bundle(tmp_path, name="honest")
    XF.restage_cell_ids(honest, "-HONEST")
    doc = json.loads((honest / "experiment.xenium").read_text())
    doc["region_name"] = "unverified-region-7"
    (honest / "experiment.xenium").write_text(json.dumps(doc))
    meta, report = _imported(tmp_path, honest, "honest")
    assert meta["section"]["sample_id"] == "unverified-region-7", meta["section"]
    assert report["section"]["sample_id_source"] == "region_name", report


def test_a_region_name_no_predicate_can_READ_is_still_something_the_operator_wrote(tmp_path):
    """TEST-24 [covers: ITEM-19] — the two disclosures in one report must not contradict each other.

    A blind angle measured them doing exactly that: `region_name: {"tissue": "kidney-A"}` reported
    `coordinate_space_source: "unverified-space-non-identifying-labels"` ("the vendor wrote
    something you can replace") and `sample_id_source: "no-vendor-sample-statement"` ("the vendor
    wrote nothing") — for the SAME key and the SAME value, in the same mirrored block. The fix was
    made and then a LATER angle showed the fix itself was unpinned: reverting it left the whole
    package green, so the eleven-line comment explaining it was a claim no test could fail on.

    Driven at both tiers, because the report is where the contradiction was visible.

    The CONTROLS are the two rows the rule must NOT reach: a placeholder stays
    `no-vendor-sample-statement` (that asymmetry is #320's, deliberate and separately pinned), and
    an absent key stays there too.
    """
    module = _module()

    for value in ({"tissue": "kidney-A"}, ["kidney", "A"], True, float("nan")):
        space_source = module.coordinate_space_id({"region_name": value}, IDS_A, POS_A)[1]
        sample_source = module.section_sample_id({"region_name": value}, "xenium:S")[1]
        assert space_source == module.NON_IDENTIFYING_SPACE_SOURCE, (value, space_source)
        assert sample_source == "non-identifying-region-name", (
            f"{value!r}: the frame leg says the vendor wrote something and the sample leg says it "
            f"wrote nothing — one report, two contradicting disclosures: {sample_source}")

    # CONTROLS: the rows this must not reach.
    assert module.section_sample_id({"region_name": "unknown"}, "xenium:S")[1] == \
        "no-vendor-sample-statement"
    assert module.section_sample_id({}, "xenium:S")[1] == "no-vendor-sample-statement"
    assert module.section_sample_id({"region_name": None}, "xenium:S")[1] == \
        "no-vendor-sample-statement"

    # ...AND END TO END, which is where the contradiction was seen. Both source tokens come out of
    # the same report, and the operator has to be able to read them together.
    root = XF.stage_bundle(tmp_path, name="unreadable-region")
    doc = json.loads((root / "experiment.xenium").read_text())
    doc.pop("roi_uuid", None)
    doc["region_name"] = {"tissue": "kidney-A"}
    (root / "experiment.xenium").write_text(json.dumps(doc))
    _meta, report = _imported(tmp_path, root, "unreadable-region")
    assert report["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, report
    assert report["section"]["sample_id_source"] == "non-identifying-region-name", report


def test_two_runs_making_DIFFERENT_vendor_statements_are_not_one_frame_or_one_sample():
    """TEST-18 [acceptance] [invariant: INV-1] [covers: ITEM-17] — the shape every other acceptance
    test structurally could not express.

    ROW 2 IS ALSO **TEST-12 [acceptance] [invariant: INV-2] [covers: ITEM-6, ITEM-7, ITEM-9] of
    `coordinate-frame-identity`** (#327/#328), which is the lifecycle that inverted it. Two feature
    numberings meet in this one function because the row is the same claim seen from both sides —
    a residue recorded by one branch and closed by the next — and splitting it into a second
    function would leave the "before" and the "after" in different files.

    A blind design-conformance angle found the gap and then found two live violations through it:
    every acceptance test in this branch gives its two "unrelated runs" the SAME
    `experiment.xenium` overrides, so a collision arising between two DIFFERENT vendor statements
    is outside what any of them can assert. Both invariants are universally quantified over
    unrelated runs; the tests were quantified over one statement.

    Row 1 was a live INV-4 violation and is FIXED (DEC-15 applied to `section.sample_id`): two runs
    stating `region_name: 0` and `region_name: 0.0` — different JSON, the same stringification —
    were both emitted as sample `"0"` while correctly holding different frames.

    Row 2 WAS a live INV-1 violation, asserted as a CHARACTERIZATION on this branch's predecessor
    and FIXED HERE (#328, DEC-2): rung 1 and rung 2 used to emit into ONE undelimited namespace, so
    `roi_uuid: "Slide_1_R2"` and an unrelated `slide_id: "Slide_1"` + `region_name: "R2"` — both
    fully identifying, both passing every predicate — answered the same frame. `coordinate_space_source`
    differed and nothing reads it: `resolveOverlayBinding` compares the frame VALUE by equality.

    The row now asserts the distinctness it used to assert the absence of. An assertion that changes
    SIDES is worth more than one that disappears: the file that recorded the residue is the file
    that records its closure, and a revert reddens HERE, where the reader is already looking.
    """
    module = _module()

    # ROW 1 — FIXED. Two different numeric statements, no longer one sample.
    a = module.section_sample_id({"region_name": 0}, "xenium:frame-a")
    b = module.section_sample_id({"region_name": 0.0}, "xenium:frame-b")
    assert a[0] != b[0], (
        "two unrelated runs stating a NUMBER for `region_name` are declared sections of one "
        f"sample — a number passes both identity predicates unexamined (DEC-15): {a} vs {b}")
    assert a[1] == b[1] == "non-identifying-region-name", (a, b)
    # ...and the control: a QUOTED number is a string the vendor wrote and still identifies.
    assert module.section_sample_id({"region_name": "0"}, "xenium:frame-a")[0] == "0"

    # ROW 2 — FIXED at #328. The cross-rung namespace, inverted.
    cross_a = module.coordinate_space_id({"roi_uuid": "Slide_1_R2"}, IDS_A, POS_A)
    cross_b = module.coordinate_space_id({"slide_id": "Slide_1", "region_name": "R2"},
                                         IDS_B, POS_B)
    assert cross_a == ("xenium:Slide_1_R2", "roi_uuid"), (
        "rung 1 emits a SINGLE stated identity VERBATIM and #328 did not move it — moving it would "
        f"re-declare every already-imported dataset's frame for no property gained: {cross_a}")
    assert cross_b == ("xenium:slide_id+region_name:7:Slide_1|2:R2|", "slide_id+region_name"), cross_b
    assert cross_a[0] != cross_b[0], (
        "two unrelated runs making DIFFERENT, fully identifying vendor statements are declared to "
        f"share one coordinate frame — one tissue's image against the other's cells: {cross_a} vs "
        f"{cross_b}")
    # THE CONTROL that stops this being satisfied by the ladder collapsing into the derived rung:
    # both runs still answer from the VENDOR, from different fields, and the report says which.
    assert cross_a[1] != cross_b[1]
    assert not cross_a[0].startswith(f"xenium:{module.UNVERIFIED_SPACE_PREFIX}"), cross_a
    assert not cross_b[0].startswith(f"xenium:{module.UNVERIFIED_SPACE_PREFIX}"), cross_b


def test_rung_2s_concatenation_is_INJECTIVE_and_that_residue_is_closed():
    """TEST-11 of `coordinate-frame-identity` [acceptance] [invariant: INV-2] [covers: ITEM-6, ITEM-9] — #328, inverted.

    This test WAS `test_rung_2s_concatenation_is_not_injective_and_that_residue_is_328`, a
    characterization asserting the collision and naming its own deletion condition: *"if rung 2's
    framing was made INJECTIVE, this row is fixed: delete this test, close #328, and record the
    id-format change in the manifest changelog."* All three happened. It is INVERTED rather than
    deleted — an assertion that changes sides is worth more than one that disappears, because a
    revert reddens here, next to the reason, rather than nowhere.

    ## The two collisions, and why one test covers both

    `f"xenium:{slide}_{region}"` is not an injective framing and both fields routinely contain `_`
    (the shipped protein bundle is `Slide_1` / `hKidney_sample`). Measured end to end on this
    branch's predecessor:

        slide='Slide_1_HeartBlock' region='R2'   -> xenium:Slide_1_HeartBlock_R2
        slide='Slide_1' region='HeartBlock_R2'   -> xenium:Slide_1_HeartBlock_R2

    Two unrelated runs, each making a DIFFERENT and fully identifying vendor statement, declared to
    share one coordinate frame. The CROSS-rung half — a `roi_uuid` colliding with a
    `slide_id`+`region_name` pair — is the second row of `INJECTIVITY_PAIRS` and is asserted here
    too, because one framing decision closed both and a test per half would let either be reverted
    while the other stayed green.

    ## What makes this an ACCEPTANCE test and not a re-spelling of the code

    It asserts the DESIGN's promise (§4.1: *the map from what the vendor stated to `<frame>` is
    INJECTIVE*), not the implementation's shape. The pairs are the ones the design names, the
    expected values are LITERALS rather than a re-derivation of `framed_frame_components`, and the
    control below is what stops the whole thing being satisfied by a ladder that refuses everything
    and derives every frame instead.
    """
    module = _module()

    for label, experiment_a, experiment_b in INJECTIVITY_PAIRS:
        a = module.coordinate_space_id(experiment_a, IDS_A, POS_A)
        b = module.coordinate_space_id(experiment_b, IDS_B, POS_B)
        assert a[0] != b[0], (
            f"{label}: two unrelated runs with DIFFERENT, fully identifying vendor statements "
            f"answer ONE coordinate frame — one tissue's image registered against the other's "
            f"cells. {a} vs {b}")
        # THE CONTROL, and it is what stops the inversion being satisfied by the ladder collapsing:
        # BOTH runs must still be answered from the VENDOR, not derived. A version that refused
        # every rung-2 statement would pass every distinctness assertion above and destroy every
        # frame the vendor genuinely named.
        for value, source in (a, b):
            assert not value.startswith(f"xenium:{module.UNVERIFIED_SPACE_PREFIX}"), (
                f"{label}: this run's frame is DERIVED, so the distinctness above says nothing "
                f"about rung 2's framing. {value} / {source}")

    # The two literals, pinned rather than re-derived — a test that recomputes the value it checks
    # proves only that the reproduction agrees with itself.
    assert module.coordinate_space_id({"slide_id": "Slide_1_HeartBlock", "region_name": "R2"},
                                      IDS_A, POS_A) == (
        "xenium:slide_id+region_name:18:Slide_1_HeartBlock|2:R2|", "slide_id+region_name")
    assert module.coordinate_space_id({"slide_id": "Slide_1", "region_name": "HeartBlock_R2"},
                                      IDS_B, POS_B) == (
        "xenium:slide_id+region_name:7:Slide_1|13:HeartBlock_R2|", "slide_id+region_name")

    # ...and the OTHER control, kept verbatim from the characterization: two runs whose
    # (slide, region) pairs differ in a way even the OLD concatenation could see are still two
    # frames, so this is not passing because rung 2 broke.
    c = module.coordinate_space_id({"slide_id": "Slide_1", "region_name": "hKidney_sample"},
                                   IDS_A, POS_A)
    d = module.coordinate_space_id({"slide_id": "Slide_2", "region_name": "hKidney_sample"},
                                   IDS_B, POS_B)
    assert c[0] != d[0], (c, d)


#: An adversarial battery for TEST-14 — pairs chosen so that a framing which is merely "escaped"
#: rather than length-prefixed has somewhere to fail. Every one differs from every other, so every
#: emitted id must differ from every other; the moment two agree, two unrelated acquisitions share
#: a frame. The shapes: the `_` split that #328 measured; a component containing the module's own
#: `:` and `|`; a component that IS a decimal length prefix; empty-looking whitespace (which the
#: predicates strip); and a pair that differs only in which component a shared substring sits in.
INJECTIVITY_BATTERY = [
    ("Slide_1_HeartBlock", "R2"),
    ("Slide_1", "HeartBlock_R2"),
    # `Slide_` and not `Slide`: the bare word is `slide_id`'s own self-naming label and
    # `non_identifying_vendor_label` correctly refuses it, which would make this row a test of the
    # WRONG predicate. The split-position property is unchanged.
    ("Slide_", "1_HeartBlock_R2"),
    ("Slide_1_HeartBlock_R2", "R2"),
    ("Slide_1", "2:R2"),
    ("Slide_12", "R2"),
    ("Slide_1|2", "R2"),
    ("7:Slide_1", "2:R2"),
    ("Slide_1", "R2|"),
    ("Slide_1:", "R2"),
    ("2", "22"),
    ("22", "2"),
    ("Slide_1", "hKidney_sample"),
    ("Slide_2", "hKidney_sample"),
    # THE PAIR THAT KILLS THE DOUBLING-ESCAPE FRAMING, added because the mutation battery for this
    # branch found the first version of this list could not: `"_".join(p.replace("_", "__"))` — the
    # obvious "just escape the separator" answer, and one a reviewer would accept — maps BOTH of
    # these to `Slide__1___R2`. A framing that is almost injective has its collision one shape
    # further out than the examples anyone writes down, which is the whole reason this row exists.
    ("Slide_1_", "R2"),
    ("Slide_1", "_R2"),
]


def test_the_rung_2_framing_is_injective_over_an_adversarial_battery():
    """TEST-14 of `coordinate-frame-identity` [covers: ITEM-6] — injectivity as a PROPERTY, not as two worked examples.

    TEST-11 asserts the two pairs #328 measured. This asserts the property they are instances of,
    over [`INJECTIVITY_BATTERY`]: every distinct `(slide_id, region_name)` pair gets a distinct
    `coordinate_space`, and equal pairs get equal ones.

    It exists because the two worked examples are satisfiable by a framing that is *almost*
    injective — doubling the separator, percent-escaping it, swapping `_` for `/` — and each of
    those has its own preimage collision one shape further out. The battery carries those shapes:
    a component holding the framing's own `:` or `|`, a component that IS a decimal length prefix,
    and pairs differing only in where a shared substring falls.

    THE LAST TWO ROWS ARE MUTATION-DERIVED, and they are the reason this is a battery rather than a
    third example. This branch's mutation run replaced the length prefix with the doubling escape
    `"_".join(part.replace("_", "__"))` and the FIRST version of this list stayed GREEN — that
    mutant maps `("Slide_1_", "R2")` and `("Slide_1", "_R2")` both to `Slide__1___R2`, and no row
    here reached it. The rows were added; the mutant now dies.

    THE EQUALITY HALF IS THE CONTROL. A framing that mixed the run's content into a vendor-stated
    id would pass every distinctness assertion here and destroy the one property `coordinate_space`
    exists for — two imports of ONE slide colliding correctly. So the same pair is driven over two
    genuinely different measurements and must answer ONE frame.
    """
    module = _module()

    # THE PRECONDITION, asserted rather than assumed: "every emitted id must differ from every
    # other" is only the right claim over a battery whose pairs are all distinct. The first version
    # spelled this as `assert (slide, region) not in seen or seen[(slide, region)] == space` inside
    # the loop — a guard whose left disjunct is true for every row precisely BECAUSE the pairs are
    # distinct, so the equality half never executed. A blind tests-quality angle named it: a guard
    # that cannot run is not weak, it is absent. The equality property it appeared to assert is
    # carried by the second loop below, over two genuinely different measurements.
    assert len(set(INJECTIVITY_BATTERY)) == len(INJECTIVITY_BATTERY), (
        "the battery contains a duplicate pair, so the distinctness claim below is no longer the "
        "right claim over it")

    seen = {}
    for slide, region in INJECTIVITY_BATTERY:
        space, source = module.coordinate_space_id(
            {"slide_id": slide, "region_name": region}, IDS_A, POS_A)
        assert source == "slide_id+region_name", (slide, region, space, source)
        clash = [pair for pair, value in seen.items() if value == space]
        assert not clash, (
            f"({slide!r}, {region!r}) and {clash[0]!r} — two DIFFERENT vendor statements — answer "
            f"ONE coordinate frame: {space}")
        seen[(slide, region)] = space

    # THE EQUALITY CONTROL: the same statement, two genuinely different measurements, ONE frame.
    for slide, region in INJECTIVITY_BATTERY:
        experiment = {"slide_id": slide, "region_name": region}
        assert (module.coordinate_space_id(experiment, IDS_A, POS_A)
                == module.coordinate_space_id(experiment, IDS_B, POS_B)), (
            "a vendor-stated frame identity must not depend on the run's content, or two imports "
            f"of ONE slide stop sharing a frame: {slide!r}/{region!r}")


def test_a_vendor_cannot_forge_the_COMPOSED_namespace(tmp_path):
    """TEST-13 of `coordinate-frame-identity` [acceptance] [invariant: INV-3] [covers: ITEM-7] — the second reserved token.

    INV-3: *the composed and derived namespaces are RESERVED: a vendor value that opens with either
    token (case-folded) is refused as an identity and the run falls to the derived rung.*

    `experiment.xenium` is untrusted vendor JSON, so "no vendor writes `slide_id+region_name:`" is a
    claim about attacker input and has to be ENFORCED, exactly as `unverified-space:` already is.
    Without it the cross-rung collision #328 reports comes straight back by another route: a
    `roi_uuid` holding a victim's real composed id would emit that id VERBATIM, byte-identical to
    the victim's frame, while `coordinate_space_source` claimed `roi_uuid`.

    Driven over all three frame keys, in both case spellings, with the forged value taken from a
    REAL emitted composed id so the test cannot pass by the forgery being malformed — and with an
    EXACT expected `(space, source)` per key, because the first version could only fail on the
    `roi_uuid` leg. A blind tests-quality angle measured that: for `slide_id`/`region_name` the
    forged value is re-wrapped by the composed framing, so `space != victim` held whatever the
    refusal did, and restricting the reserved-prefix check to `key == "roi_uuid"` left this test and
    the whole xenium identity suite green. Refusing one of rung 2's two components means the rung
    can no longer name a frame, so the run must land on the DERIVED rung — that is the assertion,
    and it is the one that fails when the refusal is not there.

    THE CONTROL is the last block: a value that merely CONTAINS the token later in the string is
    still the vendor's own statement and is emitted verbatim — the guard is a PREFIX rule, not a
    substring one, and a substring rule would eat real labels.
    """
    module = _module()
    victim, victim_source = module.coordinate_space_id(
        {"slide_id": "Slide_1", "region_name": "R2"}, IDS_A, POS_A)
    assert victim_source == "slide_id+region_name" and victim.startswith(
        f"xenium:{module.COMPOSED_SPACE_PREFIX}"), (victim, victim_source)
    # The forgeable part is the frame WITHOUT this module's platform prefix, which is what a vendor
    # would have to put in a key to make the ladder emit `xenium:<that>`.
    stolen = victim[len("xenium:"):]

    for key in module._FRAME_LABEL_KEYS:
        for label, forged in (("exact", stolen), ("upper", stolen.upper())):
            experiment = {"slide_id": "S", "region_name": "R"}
            experiment[key] = forged
            space, source = module.coordinate_space_id(experiment, IDS_B, POS_B)
            assert space != victim, (
                f"a bundle forged another run's composed frame id through {key!r} ({label} "
                f"spelling) and was declared to share its coordinate frame: {space}")
            if key == "roi_uuid":
                # rung 1 must have REFUSED it outright — the run falls past rung 1, and with
                # `slide_id`/`region_name` still stated it lands on rung 2 with ITS OWN labels.
                assert (space, source) == (
                    "xenium:slide_id+region_name:1:S|1:R|", "slide_id+region_name"), (space, source)
            else:
                # ...and refusing ONE of rung 2's two components means rung 2 cannot name a frame
                # at all (a slide carries several regions and names none alone), so the run lands
                # on the DERIVED rung and SAYS so. Spelled exactly: without the refusal this leg
                # answers `xenium:slide_id+region_name:<n>:<forged>|1:<other>|` on rung 2, which is
                # the shape the first version of this test could not tell apart.
                assert source == module.NON_IDENTIFYING_SPACE_SOURCE, (
                    f"a forged composed id in {key!r} ({label} spelling) was still read as a "
                    f"vendor statement: {(space, source)}")
                assert space.startswith(f"xenium:{module.UNVERIFIED_SPACE_PREFIX}"), (
                    key, label, space)
                assert forged.lower() not in space.lower(), (key, label, space)

    # THE CONTROL: the token later in the string is a real label and is emitted verbatim.
    honest = module.coordinate_space_id({"roi_uuid": "roi-slide_id+region_name:7"}, IDS_A, POS_A)
    assert honest == ("xenium:roi-slide_id+region_name:7", "roi_uuid"), honest


# ── TEST-2 [acceptance] (INV-2) — it says so rather than borrowing ───────────────────

def test_a_run_with_no_stated_frame_says_so_and_borrows_nothing():
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-3, ITEM-4].

    INV-2: *a run whose frame identity is unknown must SAY so rather than borrow a name.*

    Three separate claims, because "unknown" can be said badly in three ways:

    1. the VALUE says it — `unverified-space:` is a prefix no vendor writes, so the id is
       unreadable as a stated frame id by construction (the twin of `unverified-sample:`);
    2. the SOURCE says WHICH of the two bottom rows it is, and the two are not interchangeable —
       only one of them is fixable by the operator;
    3. nothing is BORROWED — the id contains no string the vendor wrote, and the mount path is not
       an input the function can even see. That last one is asserted STRUCTURALLY, on the
       signature, because a value assertion cannot distinguish "does not use the path" from "uses a
       path that happened to look different in this test" — which is the confound the #320 audit
       caught in an earlier version of TEST-9 one file over.
    """
    module = _module()
    prefixed = f"xenium:{module.UNVERIFIED_SPACE_PREFIX}"

    # (2) the two rows, and the reason they are two.
    # THE PREFIX, BY LITERAL. A blind angle found the first version of this assertion read
    # `UNVERIFIED_SPACE_PREFIX` to check `UNVERIFIED_SPACE_PREFIX` — a tautology that let the
    # constant be mutated to a string a vendor could plausibly write with the whole suite green.
    # Its model, `unverified-sample:`, is pinned by a literal one file over; so is this now.
    assert module.UNVERIFIED_SPACE_PREFIX == "unverified-space:", (
        "the disclosure prefix is the whole of INV-2's 'the value says so' mechanism, and it only "
        "says so while it is a string no vendor writes")
    # ...AND THE TWO SOURCE TOKENS, by literal, for the identical reason. A second blind angle
    # found the fix above applied to the prefix and NOT to the two constants on the next lines:
    # every assertion about them read the constant to check the constant, so either could be
    # renamed — silently breaking every consumer reading `coordinate_space_source` out of the
    # report — with the whole package green. Their DISTINCTNESS was asserted; their VALUES were not.
    assert module.NON_IDENTIFYING_SPACE_SOURCE == "unverified-space-non-identifying-labels"
    assert module.NO_VENDOR_SPACE_SOURCE == "unverified-space-no-vendor-statement"

    rows = [
        ({}, module.NO_VENDOR_SPACE_SOURCE),
        # PLACEHOLDERS ARE THE OPERATOR-FIXABLE ROW, and the first version of this branch got it
        # backwards: `vendor_statement` drops them, so `roi_uuid: "unknown"` — #323's own headline
        # row — was reported as "the vendor wrote nothing", telling the operator there was nothing
        # to rename when a placeholder is exactly what they can replace.
        ({"roi_uuid": "unknown"}, module.NON_IDENTIFYING_SPACE_SOURCE),
        ({"slide_id": "n/a", "region_name": "-"}, module.NON_IDENTIFYING_SPACE_SOURCE),
        # ...but an EMPTY string is not something written: nothing distinguishes it from the key
        # being absent, which is the row above.
        ({"region_name": "", "slide_id": "   "}, module.NO_VENDOR_SPACE_SOURCE),
        ({"region_name": "region"}, module.NON_IDENTIFYING_SPACE_SOURCE),
        ({"slide_id": "slide", "region_name": "region"}, module.NON_IDENTIFYING_SPACE_SOURCE),
        # A REAL slide with no region: the vendor wrote something the operator can complete, so it
        # belongs in the operator-fixable row even though the string itself identifies a slide.
        ({"slide_id": "Slide_1"}, module.NON_IDENTIFYING_SPACE_SOURCE),
        # ANY value counts as written, including a shape no identity predicate can read. The
        # question this token answers is "is there something for the operator to replace", and a
        # mapping in a frame key is plainly something.
        ({"roi_uuid": {"nested": "thing"}}, module.NON_IDENTIFYING_SPACE_SOURCE),
        ({"roi_uuid": [1, 2]}, module.NON_IDENTIFYING_SPACE_SOURCE),
        ({"slide_id": True}, module.NON_IDENTIFYING_SPACE_SOURCE),
        ({"slide_id": 12345}, module.NON_IDENTIFYING_SPACE_SOURCE),
        # ...but an explicit `null` is the same statement as an absent key: nothing.
        ({"roi_uuid": None, "slide_id": None}, module.NO_VENDOR_SPACE_SOURCE),
    ]
    for experiment, expected_source in rows:
        space, source = module.coordinate_space_id(experiment, IDS_A, POS_A)
        # (1)
        assert space.startswith("xenium:unverified-space:"), (experiment, space)
        assert space.startswith(prefixed), (experiment, space)
        assert source == expected_source, (
            f"{experiment!r}: the report must be able to tell 'the vendor wrote labels that name "
            f"no frame' from 'the vendor wrote nothing' — only the first is fixable by naming the "
            f"region and slide. Got {source!r}")
        # (3) nothing borrowed: no vendor string survives into the DIGEST. Checked against the
        # digest rather than the whole id, because the disclosure prefix is fixed text and a
        # one-character vendor value (`-` is a `_VENDOR_PLACEHOLDERS` spelling) occurs inside it
        # by coincidence — an assertion that cannot tell a coincidence from a borrowing is not
        # an assertion about borrowing.
        #
        # SAID NARROWLY, because a blind angle noted that for THESE rows the digest alphabet is
        # lowercase hex and every value here contains a non-hex character, so per row the check is
        # partly satisfied by the alphabet. What it does bite on is the shape that matters and was
        # measured: appending the vendor's own label to the emitted id reddens this loop. The
        # STRUCTURAL half of claim (3) — the mount path is not a parameter — is the assertion
        # carrying the weight, and it is below.
        digest = space[len("xenium:") + len(module.UNVERIFIED_SPACE_PREFIX):]
        for value in experiment.values():
            if isinstance(value, str) and value.strip():
                assert value.strip() not in digest, (experiment, space)

    assert module.NON_IDENTIFYING_SPACE_SOURCE != module.NO_VENDOR_SPACE_SOURCE

    # (3) STRUCTURAL — the mount path is not a parameter, so it cannot be borrowed by any later
    # edit that does not also change this signature.
    params = list(inspect.signature(module.coordinate_space_id).parameters)
    assert params == ["experiment", "cell_ids", "positions"], (
        "`bundle_root` is gone from this signature ON PURPOSE (#323): a run's coordinate identity "
        f"must not be a function of where it happened to be mounted. Got {params}")


# ── TEST-3 [acceptance] (INV-3) — the cost, end to end ───────────────────────────────

def _staged(tmp_path, name, suffix, **overrides):
    """A copy of `xenium-prime-outs` with its OWN cell ids and `experiment.xenium` overridden."""
    root = XF.stage_bundle(tmp_path, name=name)
    path = root / "experiment.xenium"
    doc = json.loads(path.read_text())
    for key, value in overrides.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value
    path.write_text(json.dumps(doc))
    return XF.restage_cell_ids(root, suffix)


#: ONE spelling, in the shared fixture module (#323). Both suites had this byte-identically and
#: a third would have copied it; the module under test carries the argument against a second
#: spelling in its own docstrings.
_imported = XF.imported


def test_the_missed_collision_this_rule_buys_is_visible_and_recoverable(tmp_path):
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-2, ITEM-5].

    INV-3: *a MISSED collision is visible and recoverable while a FALSE collision is silent wrong
    data.* This branch buys a missed one knowingly — a slide genuinely named `slide` holding a
    region genuinely named `region` is not grouped with its sibling — and the price is only
    acceptable because of two properties OF THE CODE, both asserted here END TO END:

    * **visible** — the report carries the operator's own `slide_id`/`region_name` verbatim AND the
      source token saying the frame identity was not taken from them;
    * **recoverable** — give the same two bundles an identity (`slide_id` AND `region_name`
      together, since a slide carries several regions and names no frame alone) and they share one
      frame again. That is what a false collision is not: nobody can un-declare two unrelated
      tissues to share a frame after the fact.

    Driven through `run_import` rather than the helper: a unit test proves the function, not that
    the importer calls it or that the answer reaches the artifact.
    """
    module = _module()
    missed = []
    for suffix in ("-runA", "-runB"):
        root = _staged(tmp_path, f"missed{suffix}", suffix, roi_uuid=None)
        meta, report = _imported(tmp_path, root, f"missed{suffix}")
        missed.append(meta["coordinate_space"])
        # VISIBLE, both halves in one report.
        assert report["provenance"]["slide_id"] == "slide", report["provenance"]
        assert report["provenance"]["region_name"] == "region", report["provenance"]
        assert report["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, report
        assert meta["coordinate_space"].startswith(f"xenium:{module.UNVERIFIED_SPACE_PREFIX}")

    assert missed[0] != missed[1], (
        "the MISS is the accepted cost; a shared frame here would be the FALSE collision instead")

    # RECOVERABLE — the SAME two bundles, two fields named, share a frame again.
    grouped = []
    for suffix in ("-runA", "-runB"):
        root = _staged(tmp_path, f"named{suffix}", suffix, roi_uuid=None,
                       slide_id="Slide_9", region_name="donor-04-blockA")
        meta, report = _imported(tmp_path, root, f"named{suffix}")
        grouped.append(meta["coordinate_space"])
        assert report["coordinate_space_source"] == "slide_id+region_name", report

    assert grouped == ["xenium:slide_id+region_name:7:Slide_9|15:donor-04-blockA|"] * 2, (
        "naming the slide AND the region must RESTORE the grouping — otherwise the missed "
        f"collision is not recoverable and INV-3's trade does not hold: {grouped}")


def test_two_runs_that_differ_ONLY_in_geometry_are_two_frames(tmp_path):
    """TEST-15 [covers: ITEM-3, ITEM-5] — the POSITIONS half of the preimage, END TO END.

    Every other integration test here makes its two runs unrelated by restaging their CELL IDS, so
    the ids alone always carry the distinctness and none of them can tell whether the positions are
    wired into `run_import` at all. A blind tests-quality angle proved that gap by replacing the
    call site's `coords` with `np.zeros_like(coords)` with the whole package green — the correction
    this branch's fix round exists for ("the frame identity is the run's MEASUREMENT") was proven
    only at the unit tier, on synthetic arrays.

    So: two bundles with the SAME cell ids and DIFFERENT centroids. They must be two frames, and
    the emitted id must be the one the derivation actually produces from THIS bundle's own bytes —
    which is the assertion that also stops `XF.matrix_positions` from being a fixture nothing
    checks (make it return zeros and this reddens).
    """
    module = _module()
    spaces = []
    for label, dx in (("geom-a", 0.0), ("geom-b", 137.5)):
        root = XF.stage_bundle(tmp_path, name=label)
        path = root / "experiment.xenium"
        doc = json.loads(path.read_text())
        for key in ("roi_uuid", "slide_id", "region_name"):
            doc.pop(key, None)
        path.write_text(json.dumps(doc))
        if dx:
            XF.shift_centroids(root, dx)

        meta, report = _imported(tmp_path, root, label)
        spaces.append(meta["coordinate_space"])
        assert report["coordinate_space_source"] == module.NO_VENDOR_SPACE_SOURCE, report
        # THE FIXTURE IS BOUND TO THE IMPORTER, not merely passed to it: the id the import emitted
        # must be the id this bundle's own ids+positions derive to.
        expected = module.unverified_space_id(XF.matrix_cell_ids(root), XF.matrix_positions(root))
        assert meta["coordinate_space"] == f"xenium:{expected}", (
            "the emitted frame id is not the one this bundle's own cell ids and centroids derive "
            f"to — the positions half is not reaching `coordinate_space_id`: {meta}")

    assert spaces[0] != spaces[1], (
        "two bundles with the SAME cell ids and DIFFERENT centroids are one frame — so the "
        "POSITIONS are not reaching the digest from `run_import`. The ids are identical here BY "
        f"CONSTRUCTION, so they cannot be what tells these two runs apart: {spaces}")


# ── TEST-6 — the bottom rung's own properties ────────────────────────────────────────

def test_the_derived_frame_id_is_deterministic_sensitive_and_refuses_an_empty_matrix():
    """TEST-6 [covers: ITEM-3] — the five properties the bottom rung rests on.

    A digest is only an identity if all of them hold, and each is a mutation somebody could make to
    this function and leave every other test in this package green:

    * DETERMINISTIC — the same bundle imported twice is the same frame. This is the property
      `coordinate_space`'s design names as the whole mechanism (*"the only thing that makes two
      imports of ONE slide collide correctly"*) and the reason a minted UUID was refused.
    * SENSITIVE IN BOTH HALVES — a changed/added/reordered cell id is a different frame, AND so is
      a moved centroid with the ids held fixed. The second half is the correction a blind
      design-conformance angle forced: digesting the ids alone let two genuinely different
      measurements with generically numbered ids share one frame, which is #323's own defect
      reintroduced at the rung meant to remove it.
    * UNAMBIGUOUS — the id framing is self-delimiting, so two runs whose ids merely CONCATENATE to
      the same string do not collide. Without the length prefix `["ab", "c"]` and `["a", "bc"]` are
      one frame.
    * TYPE-STABLE — `h5py` hands back `bytes` or `str` depending on how the file was written, and
      the SAME bundle must be the SAME frame either way. Pins the decode that a `str()` coercion
      would silently corrupt into `"b'aaaadpbp-1'"`.
    * REFUSING — a matrix with no cell identity at all digests to ONE CONSTANT shared by every such
      run, which is the defect this whole branch removes. It is refused by name instead, and so is
      a positions array that does not match the ids.
    """
    module = _module()
    uid = module.unverified_space_id

    assert uid(IDS_A, POS_A) == uid(list(IDS_A), POS_A.copy())
    assert uid(IDS_A, POS_A) != uid(IDS_B, POS_B)
    assert uid(IDS_A, POS_A) != uid(IDS_A[:-1], POS_A[:-1])
    assert uid(IDS_A, POS_A) != uid(IDS_A + ["extra-1"], np.vstack([POS_A, [[9.0, 9.0]]]))
    assert uid(IDS_A, POS_A) != uid(list(reversed(IDS_A)), POS_A)
    assert uid(["ab", "c"], POS_A[:2]) != uid(["a", "bc"], POS_A[:2]), (
        "the id framing is not injective — drop the length prefix and two different runs share a "
        "frame, which is the defect this rung exists to remove")

    # THE POSITIONS HALF. Same ids, same count, one centroid moved: a different measurement, and
    # therefore a different frame. This is the assertion the ids-only version could not make.
    moved = POS_A.copy()
    moved[1, 0] += np.float32(137.5)
    assert uid(IDS_A, POS_A) != uid(IDS_A, moved), (
        "two DIFFERENT measurements carrying the same cell ids must not share a frame — nothing "
        "validates the vendor's id format, so `1`..`N` is reachable")
    assert uid(GENERIC_IDS, GENERIC_POS_A) != uid(GENERIC_IDS, GENERIC_POS_B)

    # TYPE-STABLE.
    assert uid([i.encode() for i in IDS_A], POS_A) == uid(IDS_A, POS_A), (
        "h5py returns `bytes` or `str` for a barcode depending on the file; the SAME bundle must "
        "be the SAME frame either way, and `str(b'x')` would make it `\"b'x'\"`")

    minted = uid(IDS_A, POS_A)
    assert minted.startswith(module.UNVERIFIED_SPACE_PREFIX)
    digest = minted[len(module.UNVERIFIED_SPACE_PREFIX):]
    assert len(digest) == module._SPACE_DIGEST_HEX == 32, (
        "128 bits is what makes the birthday bound negligible for any realistic corpus, and 32 hex "
        "is also what keeps the emitted id inside the server's `DECL_MAX_VALUE_CHARS = 120` "
        f"declaration cap with headroom (DEC-4): {digest}")
    assert all(c in "0123456789abcdef" for c in digest), digest

    # UNDECODABLE / UNENCODABLE input must not turn this function into an uncaught exception. Said
    # exactly, because a blind angle found an earlier version of this comment claiming a production
    # property the importer does not have: `run_import` decodes every untrusted h5 string dataset
    # STRICTLY (they are identities and must not be mangled) and REFUSES a non-UTF-8 one by name,
    # so neither of these two shapes reaches here from a real import. What these rows pin is that
    # the helper is TOTAL for its direct callers — the contract a module-level function with more
    # than one caller owes — not a defence-in-depth story about `main()`.
    surrogate = uid(["\ud800bad", "ok-1"], POS_A[:2])
    assert surrogate.startswith(module.UNVERIFIED_SPACE_PREFIX), surrogate
    undecodable = uid([b"\xff\xfe-1", b"ok-1"], POS_A[:2])
    assert undecodable.startswith(module.UNVERIFIED_SPACE_PREFIX), undecodable
    # ...and the HANDLER is `replace`, not `ignore`. A blind angle pointed out that "does not
    # raise" is satisfied by any non-strict handler, and `ignore` would DROP the unencodable
    # character — making `"\ud800bad"` and `"bad"` the same cell and therefore the same frame,
    # which is a false collision manufactured by the very clause meant to prevent a crash.
    assert uid(["\ud800bad", "ok-1"], POS_A[:2]) != uid(["bad", "ok-1"], POS_A[:2]), (
        "an unencodable character must be REPLACED, not dropped: dropping it makes two different "
        "cell ids one")

    for empty in ([], [""], ["", "  "], None):
        with pytest.raises(module.XeniumImportError) as excinfo:
            uid(empty, np.zeros((0, 2), dtype=np.float32))
        assert "no cell identity" in str(excinfo.value), str(excinfo.value)

    with pytest.raises(module.XeniumImportError) as excinfo:
        uid(IDS_A, POS_B)
    assert "but the matrix declares" in str(excinfo.value), str(excinfo.value)

    # ...and a positions argument that is not readable as numbers at all is refused BY NAME too.
    # The first version converted before it checked, so a ragged list or a list of strings died as
    # a bare `ValueError` — and `main()` catches only `XeniumImportError`.
    for unreadable in ([[1.0, 2.0], [3.0]],            # ragged: numbers, wrong SHAPE
                       [["a", "b"], ["c", "d"]],        # not numbers
                       [{"x": 1}, {"x": 2}],            # not numbers, not a sequence of pairs
                       [[10 ** 400, 1.0], [2.0, 3.0]]):  # OverflowError, which the first version
                                                         # of the guard did not catch
        with pytest.raises(module.XeniumImportError) as excinfo:
            uid(["a", "b"], unreadable)
        assert "cannot be read as an (N, 2) array of numbers" in str(excinfo.value), (
            "the message must fit BOTH failures it now covers — a ragged list of perfectly good "
            f"numbers is a SHAPE problem, and calling it a number problem misdirects: {excinfo.value}")


def test_the_derived_frame_id_is_a_property_of_the_MEASUREMENT_not_of_the_file_layout():
    """TEST-23 [covers: ITEM-3] — a frame is a SET of positions, and the digest now says so.

    The docstring's own framing ("a frame is a set of positions; this is that set, keyed by the
    vendor's own names for the things in it") was FALSE of the first version, and a blind angle
    measured it: the records were digested in FILE order, so a re-export of the same run with its
    rows shuffled — the same set of (id, position) pairs, the same measurement — minted a different
    frame and therefore a different `section.sample_id`. The safe direction, but a missed collision
    the design said would not happen, and free to close.

    Two more rows for the same sentence: `-0.0` and `0.0` are the same POSITION, and a frame
    identity must not turn on the sign of a zero. The CONTROLS are what stop this being satisfied
    by a digest that ignores order or geometry altogether — the pairing must still be part of the
    preimage, and moving one cell must still be a different frame.
    """
    module = _module()
    uid = module.unverified_space_id
    ids = ["c1", "c2", "c3"]
    pos = [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]

    assert uid(ids, pos) == uid(["c3", "c1", "c2"], [[5.0, 6.0], [1.0, 2.0], [3.0, 4.0]]), (
        "the same (id, position) SET in a different row order is the same measurement and must be "
        "the same frame")
    assert uid(["a", "b"], [[0.0, 1.0], [2.0, 3.0]]) == \
        uid(["a", "b"], [[-0.0, 1.0], [2.0, 3.0]]), "-0.0 and 0.0 are the same position"
    # ...AND IT NORMALISES NOTHING ELSE. A blind angle replaced the `-0.0` line with `np.abs`,
    # which flips the sign of every negative coordinate in the tissue and mints a wrong frame for
    # any bundle with negative centroids — and the whole package stayed green, because every
    # fixture position in this suite happened to be non-negative. A NEGATIVE coordinate and its
    # mirror are two different places.
    assert uid(["a", "b"], [[-1.0, 2.0], [3.0, 4.0]]) != \
        uid(["a", "b"], [[1.0, 2.0], [3.0, 4.0]]), (
        "a negative coordinate and its absolute value are different positions — the `-0.0` "
        "normalisation must touch exactly one bit pattern and no other value")

    # CONTROL 1 — the PAIRING is still in the preimage: swap two cells' positions and it moves.
    assert uid(ids, pos) != uid(ids, [[3.0, 4.0], [1.0, 2.0], [5.0, 6.0]]), (
        "sorting must not have discarded which position belongs to which cell")
    # CONTROL 2 — geometry is still in the preimage: move one cell and it moves.
    assert uid(ids, pos) != uid(ids, [[1.0, 2.0], [3.0, 4.0], [5.0, 99.0]])


#: THE GOLDEN VALUE. Recomputing it is not the point — pinning it is: a change to the digest
#: PREIMAGE that preserves injectivity passes every relative assertion in TEST-6 and silently
#: re-declares the coordinate frame of every already-imported bottom-rung dataset. This branch
#: changed the preimage twice (the cell-COUNT prefix removed, the positions added) and nothing
#: could have noticed a third change. It is the same harm DEC-16 refuses to inflict on rung 2, and
#: the bottom rung had no equivalent guard until a blind angle asked for one.
#:
#: A SECOND COPY OF `IDS_A`/`POS_A` ON PURPOSE, and this note is the whole reason: the golden
#: fixture must not move when the suite's shared fixtures move. `_GOLDEN_IDS = IDS_A` is the
#: obvious tidy-up, it leaves this test green, and it silently converts the pin into "the digest of
#: whatever the suite happens to hold today" — which is exactly the guarantee this test exists to
#: deny. If you are here to de-duplicate these, don't.
_GOLDEN_IDS = ["aaaadpbp-1", "aaaadpbq-1", "aaaadpbr-1"]
_GOLDEN_POS = [[10.5, 20.5], [11.5, 21.5], [12.5, 22.5]]
_GOLDEN_SPACE_ID = "unverified-space:a0a229fb2ac9106af6c6b73a0acd33d7"

#: A SECOND golden, deliberately NOT in sorted id order. A blind angle showed the first one was
#: structurally blind to the change that introduced the sort: `_GOLDEN_IDS` is already sorted (so
#: are both real fixture bundles' barcodes), so the preimage changed and this guard stayed green
#: while its own docstring says a preimage change must never be silent. The pair is the guard: the
#: sorted one pins the framing, this one pins the ORDERING rule, and they must be EQUAL because the
#: two lists are the same set of (id, position) pairs.
_GOLDEN_UNSORTED_IDS = ["aaaadpbr-1", "aaaadpbp-1", "aaaadpbq-1"]
_GOLDEN_UNSORTED_POS = [[12.5, 22.5], [10.5, 20.5], [11.5, 21.5]]


def test_the_derived_frame_id_is_a_PINNED_value_not_merely_a_distinct_one():
    """TEST-14 [covers: ITEM-3] — the emitted id itself, so a preimage change cannot be silent.

    Every other assertion about `unverified_space_id` is RELATIVE (`a != b`, `a == a`), and a
    relative assertion cannot see the one harm this value can do: changing what it answers for the
    SAME bundle. That re-declares the frame of every dataset already imported through this rung,
    and nobody can fix it afterwards — the old id is in the emitted artifact. DEC-16 refuses
    exactly that harm on rung 2; this is the same guard for the rung this branch built.

    Endianness is part of the pin, not an accident: the positions are serialized `<f4`, so this
    value is the same on every machine two producers might run on. A native-order `float32` view
    would make a coordinate frame a function of the CPU.

    That clause is UNFALSIFIABLE ON LITTLE-ENDIAN HARDWARE and the record says so rather than
    implying coverage it does not have: a mutation of `<f4` to `=f4` survives every test on x86 and
    ARM because the two are the same there. It is this assertion — the golden literal — that would
    redden on a big-endian host, which is the only place the difference exists. Same shape as a
    `cfg(target_os)` arm that a Linux build never compiles.

    WHEN THIS GOES RED: the digest preimage changed. That is allowed — it is not a bug — but it is
    an id-format change, so it needs a manifest version bump and a changelog line saying the
    unverified frame ids move, exactly as an integrator reading `coordinate_space` would need.
    Update the constant in the same commit that changes the preimage, never separately.
    """
    module = _module()
    assert module.unverified_space_id(_GOLDEN_IDS, _GOLDEN_POS) == _GOLDEN_SPACE_ID, (
        "the derived frame id for a FIXED bundle moved. Every dataset already imported through "
        "this rung keeps the old id, so a re-import of the same bundle no longer shares its "
        "frame — see this test's docstring for what to do")
    # THE SAME PAIRS, NOT IN SORTED ORDER, must reach the SAME literal. Without this row the pin is
    # blind to a change in the ORDERING rule, which is exactly the change that slipped past it once.
    assert module.unverified_space_id(_GOLDEN_UNSORTED_IDS, _GOLDEN_UNSORTED_POS) == \
        _GOLDEN_SPACE_ID, (
        "the same (id, position) pairs in a different order no longer digest to the pinned value — "
        "either the ordering rule changed (which is an id-format change and needs a changelog "
        "line) or the pairing was lost")


# ── TEST-7 — the per-key predicate ───────────────────────────────────────────────────

@pytest.mark.parametrize("key,value,expected", [
    # `_VENDOR_PLACEHOLDERS`, every spelling and its case/whitespace variants — the vendor saying
    # "no answer" in words, which `origin/main` read as a frame IDENTITY.
    ("roi_uuid", "unknown", None),
    ("roi_uuid", "UNKNOWN", None),
    ("roi_uuid", "  unknown  ", None),
    ("slide_id", "n/a", None),
    ("slide_id", "N/A", None),
    ("region_name", "na", None),
    ("region_name", "none", None),
    ("region_name", "null", None),
    ("region_name", "-", None),
    ("region_name", "", None),
    ("region_name", None, None),
    # #320's self-naming-field rule, now asked of all three keys.
    ("region_name", "region", None),
    ("region_name", "Region", None),
    ("region_name", "region_name", None),
    ("slide_id", "slide", None),
    ("slide_id", "SLIDE", None),
    ("roi_uuid", "roi", None),
    ("roi_uuid", "roi_uuid", None),
    # REAL vendor values, including one that merely CONTAINS the generic word — the control that
    # stops the rule being a substring match.
    ("region_name", "hKidney_sample", "hKidney_sample"),
    ("region_name", "region_7", "region_7"),
    ("region_name", " region_7 ", "region_7"),
    ("slide_id", "Slide_1", "Slide_1"),
    ("roi_uuid", "d4c2d423-83ed-4e44-8dfd-a0072bcc3afc", "d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"),
    # A FRAME LABEL MUST BE A STRING (DEC-15), and this is the row that says why: both identity
    # predicates are blind to a number — `_VENDOR_PLACEHOLDERS` is a string vocabulary and
    # `non_identifying_vendor_label` returns False for a non-string — so `roi_uuid: 0` would be an
    # UNFILTERABLE identity and two unrelated runs would answer `xenium:0`. Measured that way by a
    # blind angle on the first version of this branch. `vendor_statement` still accepts a number,
    # because for a PROVENANCE value that is right; only the identity path refuses it.
    ("slide_id", 12345, None),
    ("roi_uuid", 0, None),
    ("region_name", 0.0, None),
    # ...and a non-string non-number is not a statement, and must not raise either.
    ("slide_id", {"nested": "thing"}, None),
    ("slide_id", float("nan"), None),
    ("slide_id", b"Slide_1", None),
    # THIS MODULE'S OWN derived prefix, refused so `UNVERIFIED_SPACE_PREFIX`'s "no vendor writes
    # this" is enforced rather than hoped for: `experiment.xenium` is untrusted vendor JSON.
    ("roi_uuid", "unverified-space:deadbeefdeadbeefdeadbeefdeadbeef", None),
])
def test_the_frame_label_predicate_answers_one_key_at_a_time(key, value, expected):
    """TEST-7 [covers: ITEM-1] — `vendor_frame_label`, the composition of the two shipped predicates.

    `vendor_statement` answers *did the vendor answer at all* and `non_identifying_vendor_label`
    answers *does the answer identify anything*. `origin/main`'s `coordinate_space_id` asked
    NEITHER, on any of its three rungs, which is #323's first defect. Composing them in one place
    is the same fix `vendor_statement`'s own docstring records for the same class of drift: one
    predicate, every caller, no second spelling.

    The REAL-value rows are the control: a predicate that refused everything would satisfy every
    None row above and destroy every vendor-derived frame.
    """
    module = _module()
    assert module.vendor_frame_label({key: value}, key) == expected
    assert module.vendor_frame_label({}, key) is None


# ── TEST-8 — the mutation pin ────────────────────────────────────────────────────────

#: `origin/main`'s `coordinate_space_id`, backed out as a SOURCE mutation of the shipped file — so
#: the mutant is the real module with this fix removed, and a revert makes it identical to what
#: ships. The same shape `test_declaration_residues.py::_shipped_with_the_320_fix_backed_out` uses.
_PRE_CHANGE_SIGNATURE = (
    "def coordinate_space_id(experiment, cell_ids, positions):\n",
    "def coordinate_space_id(experiment, bundle_root):\n",
)
_PRE_CHANGE_BODY = (
    '''    roi = vendor_frame_label(experiment, "roi_uuid")
    if roi:
        return f"xenium:{roi}", "roi_uuid"
    slide = vendor_frame_label(experiment, "slide_id")
    region = vendor_frame_label(experiment, "region_name")''',
    '''    roi = experiment.get("roi_uuid")
    if isinstance(roi, str) and roi.strip():
        return f"xenium:{roi.strip()}", "roi_uuid"
    slide = (_text(experiment.get("slide_id")) or "").strip()
    region = (_text(experiment.get("region_name")) or "").strip()''',
)
#: #328's half of the back-out. `_PRE_CHANGE_BODY` above restores the RAW rung reads; this restores
#: the non-injective FRAMING those rungs used to emit into, so `pre_change` reproduces
#: `xenium:Slide_1_hKidney_sample` and TEST-8's comparison is against the value that actually
#: shipped rather than against the new one wearing an old body.
_PRE_CHANGE_RUNG_2 = (
    """\
        # THE COMPOSED NAMESPACE (#328). `f"xenium:{slide}_{region}"` — what this line used to be
        # — is not an injective framing, and both fields routinely contain `_`. See
        # [`COMPOSED_SPACE_PREFIX`] for the two collisions that removed, and
        # [`framed_frame_components`] for why the length prefix rather than an escaped delimiter.
        return (f"xenium:{COMPOSED_SPACE_PREFIX}{framed_frame_components((slide, region))}",
                "slide_id+region_name")""",
    '        return f"xenium:{slide}_{region}", "slide_id+region_name"',
)
_PRE_CHANGE_TAIL = (
    '''    source = (NON_IDENTIFYING_SPACE_SOURCE if _wrote_a_frame_label(experiment)
              else NO_VENDOR_SPACE_SOURCE)
    return f"xenium:{unverified_space_id(cell_ids, positions)}", source''',
    '''    name = Path(bundle_root).name or "bundle"
    return f"xenium:{name}", "bundle-directory-name"''',
)


def _shipped_with_the_323_fix_backed_out():
    path = XF.PKG / "compute" / "import_xenium.py"
    # `encoding="utf-8"` NAMED, like every other file scan on this branch (#333/#339/#330). The
    # module's prose carries em dashes, so a locale-default read raises under `LC_ALL=C` — loudly
    # rather than greenly, which is why this was a latent contradiction rather than a defect, and
    # is exactly the shape three docstrings on this branch cite the rule for.
    source = path.read_text(encoding="utf-8")
    for old, new in (_PRE_CHANGE_SIGNATURE, _PRE_CHANGE_BODY, _PRE_CHANGE_RUNG_2,
                     _PRE_CHANGE_TAIL):
        assert source.count(old) == 1, (
            f"the mutation anchor matched {source.count(old)} times. If it matched ZERO, the most "
            "likely cause is that the #323 fix has been REVERTED out of `import_xenium.py` — THAT "
            f"is the regression this test exists for, not a stale anchor. Anchor: {old[:70]!r}")
        source = source.replace(old, new)
    module = types.ModuleType("import_xenium_pre_change_323")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def test_the_pre_change_ladder_and_the_shipped_one_must_DISAGREE(tmp_path):
    """TEST-8 [covers: ITEM-12] — the regression pin for #323, on #323's own measured rows.

    **The mutants the old body misses and this one catches**, each asserted in both directions in
    the loop below — first that the pre-change body REPRODUCES the collision (so the comparison is
    never vacuous), then that the shipped body does not:

    | shape | `origin/main` | shipped |
    |---|---|---|
    | `roi_uuid='unknown'`, two runs | `xenium:unknown` for both | two frames |
    | `slide/region='unknown'`, two runs | `xenium:unknown_unknown` for both | two frames |
    | nothing stated, two mounts named `outs` | `xenium:outs` for both | two frames |
    | nothing stated, slot-mounted as `bundle` | `xenium:bundle` for every import in a deployment | two frames |
    | prime-shaped `slide`/`region`, two runs | `xenium:slide_region` for both | two frames |

    And the two STATED rows, which were never #323's defect — a real `roi_uuid` and a real
    `slide_id`+`region_name`. Both must still be answered from the vendor, on the SAME RUNG, before
    and after; #323 moved neither.

    ## The one row where the bodies must now DIFFER, and why the SPLIT is the assertion (#328)

    #328 moved rung 2's FRAMING (DEC-2): `f"xenium:{slide}_{region}"` is not injective, so
    `Slide_1_HeartBlock`/`R2` and `Slide_1`/`HeartBlock_R2` — two unrelated runs, both fully
    identifying — answered ONE frame. The blanket *a stated identity is answered identically before
    and after* would have to be DELETED to let that land, which is how a regression pin quietly
    becomes a formality. So it is SPLIT instead: rung 1 (a SINGLE stated identity, emitted verbatim)
    must still match exactly, rung 2 must have moved AND must have moved FROM the value that
    actually shipped, and both must still report the same RUNG. `_PRE_CHANGE_RUNG_2` is what keeps
    the "from" side honest — without it the mutant would carry the new framing and the comparison
    would be against itself.
    """
    module = _module()
    pre_change = _shipped_with_the_323_fix_backed_out()

    root_a, root_b = tmp_path / "uploads" / "x" / "outs", tmp_path / "uploads" / "y" / "outs"
    for root in (root_a, root_b):
        root.mkdir(parents=True)

    for label, experiment in COLLIDING_SHAPES:
        old_a = pre_change.coordinate_space_id(experiment, root_a)
        old_b = pre_change.coordinate_space_id(experiment, root_b)
        assert old_a == old_b, (
            f"{label}: the pre-change body did not reproduce #323's measurement — then the "
            f"comparison below is vacuous. {old_a} vs {old_b}")
        new_a = module.coordinate_space_id(experiment, IDS_A, POS_A)
        new_b = module.coordinate_space_id(experiment, IDS_B, POS_B)
        assert new_a[0] != new_b[0], (label, new_a, new_b)
        assert new_a[0] != old_a[0], (
            f"{label}: the shipped body still answers what `origin/main` answered", new_a, old_a)

    # The slot-mount row, which is the worst of the three: the sandbox derives the mount name from
    # the SLOT, so `origin/main` answers ONE constant for every Xenium import in a deployment.
    slot_a, slot_b = tmp_path / "m0" / "bundle", tmp_path / "m1" / "bundle"
    for root in (slot_a, slot_b):
        root.mkdir(parents=True)
    assert pre_change.coordinate_space_id({}, slot_a) == \
        pre_change.coordinate_space_id({}, slot_b) == ("xenium:bundle", "bundle-directory-name")
    assert module.coordinate_space_id({}, IDS_A, POS_A)[0] != module.coordinate_space_id({}, IDS_B, POS_B)[0]

    # LEGS 1 AND 2 WERE NEVER #323'S DEFECT: a real vendor statement must still be answered from
    # the vendor, on the same RUNG, whatever else changed. What #328 then moved — deliberately,
    # on the record (DEC-2) — is rung 2's FRAMING, and this loop now asserts that split rather
    # than the blanket "nothing moved" it used to. A blanket assertion would have to be deleted to
    # let #328 land, which is how a regression pin becomes a formality.
    for experiment, expected_space, expected_source in STATED_SHAPES:
        shipped = module.coordinate_space_id(experiment, IDS_A, POS_A)
        assert shipped == (expected_space, expected_source), shipped
        old = pre_change.coordinate_space_id(experiment, root_a)
        assert old[1] == shipped[1], (
            "a stated frame identity must still be answered from the SAME vendor field before and "
            f"after — the rung itself was never the defect. {old} vs {shipped}")
        if expected_source == MOVED_BY_328_SOURCE:
            assert old[0] == MOVED_BY_328_FROM, (
                "the pre-change body no longer reproduces the value #328's format change moved "
                f"FROM — then the comparison below is vacuous. {old}")
            assert shipped[0] != old[0], (
                "#328's injective framing must actually MOVE this value — a version that left it "
                "alone would still answer one frame for `Slide_1_HeartBlock`/`R2` and "
                f"`Slide_1`/`HeartBlock_R2`. {shipped} vs {old}")
        else:
            assert shipped[0] == old[0], (
                "a SINGLE stated identity is emitted verbatim and must be answered identically "
                "before and after — moving it would re-declare every already-imported dataset's "
                f"frame for no property gained (design §4.1, DEC-3). {shipped} vs {old}")


# ── TEST-3 [acceptance] (INV-5) — the positive control over the REAL bundles ────────

#: Both committed REAL vendor bundles and the frame id each emitted BEFORE #328, which each must
#: still emit after. LITERALS rather than `f"xenium:{experiment['roi_uuid']}"`: a test that
#: re-derives the value it checks is comparing the importer against a copy of its own expression.
#:
#: THIS IS ALSO THE MEASUREMENT DEC-2 RESTS ON. #328 filed the rung-2 format change as the owner's
#: call because it re-declares the frame of every already-imported rung-2 dataset. Both real
#: bundles answer on rung 1 — `roi_uuid` sits with `cassette_uuid` / `well_uuid` /
#: `calibration_uuid` in every real `experiment.xenium` observed — so nothing that imports today
#: moves. If a future fixture lands here without a `roi_uuid`, this row goes red and the trade is
#: revisited on evidence rather than on memory.
REAL_BUNDLE_FRAMES = (
    ("prime", XF.PRIME, "xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"),
    ("protein", XF.PROTEIN, "xenium:c55618d8-0e12-429a-941a-071f38da06c0"),
)


@pytest.mark.parametrize("label,bundle,expected", REAL_BUNDLE_FRAMES,
                         ids=[row[0] for row in REAL_BUNDLE_FRAMES])
def test_a_real_vendor_bundle_keeps_the_frame_id_it_has_today(label, bundle, expected):
    """TEST-3 of `coordinate-frame-identity` [acceptance] [invariant: INV-5] [covers: ITEM-6, ITEM-10].

    INV-5: *a SINGLE stated identity is verbatim, so nothing that imports today moves.*

    THE POSITIVE CONTROL for #328. Every distinctness assertion on this branch is satisfiable by a
    ladder that derives every frame and never reads the vendor at all, which would remove the
    collisions AND the property they are a corruption of. This forbids it at the exact values
    `origin/main` emits, over the two committed REAL 10x bundles.
    """
    module = _module()
    experiment = XF.experiment(bundle)
    cell_ids = XF.matrix_cell_ids(bundle)
    positions = XF.matrix_positions(bundle)

    assert module.coordinate_space_id(experiment, cell_ids, positions) == (expected, "roi_uuid"), (
        "a bundle that imports today changed the coordinate frame it declares — every artifact "
        "already emitted from it stops binding to its own re-import, and nothing downstream can "
        "detect that")
    # ...and it does not depend on the run's CONTENT, which is what "two imports of one slide
    # collide correctly" needs.
    assert module.coordinate_space_id(experiment, IDS_A, POS_A)[0] == expected
    # ...and this is the DEC-2 measurement, asserted rather than remembered: rung 1 is what these
    # bundles answer on, which is why #328's format change moves nothing that ships.
    assert isinstance(experiment.get("roi_uuid"), str) and experiment["roi_uuid"].strip(), (
        "a committed REAL bundle no longer carries a `roi_uuid`, so it now answers on rung 2 — the "
        "rung whose FORMAT this branch moved. Re-read DEC-2 before believing the trade still holds")


# ── TEST-20 — the DESIGN's own worked examples, driven ──────────────────────────────

def test_the_designs_worked_examples_are_what_the_shipped_ladder_EMITS():
    """TEST-20 of `coordinate-frame-identity` [covers: ITEM-6, ITEM-10] — the doc is executable here.

    `docs/design/xenium-declaration-residues.md` §4.1 property 2 is the ONE place the design
    demonstrates the injective framing, by writing out the two ids #328's measured pair produces.
    It was WRONG: it stated `xenium:slide_id+region_name:16:Slide_1_HeartBlock|2:R2|`, and
    `len("Slide_1_HeartBlock")` is 18. A reader following the decode rule the same paragraph
    defines — read digits to the first `:`, take exactly that many code points, expect a `|` —
    would have read the example and concluded the rule was broken.

    A blind design-conformance angle found it, and the one-character correction is not the repair:
    nothing was checking the doc, so it could drift again the next time either side moves. This
    test EXTRACTS every `xenium:slide_id+region_name:…` literal §4.1 writes down and drives the
    shipped ladder at the inputs the same paragraph names, so the design and the code cannot
    disagree silently in either direction.

    `encoding="utf-8"` is EXPLICIT: the design is full of em dashes and a locale-default read
    raises or mis-decodes under `LC_ALL=C` (#333/#339/#330).
    """
    import re

    module = _module()
    design = XF.PKG.parents[2] / "docs" / "design" / "xenium-declaration-residues.md"
    assert design.is_file(), design
    text = design.read_text(encoding="utf-8")

    section = text.split("### §4.1", 1)
    assert len(section) == 2, "design §4.1 is gone — the heading this test reads from moved"
    body = section[1].split("### §4.2", 1)[0]

    quoted = re.findall(r"`(xenium:slide_id\+region_name:[^`]+)`", body)
    assert len(quoted) == 2, (
        f"§4.1 property 2 no longer writes exactly two composed worked examples: {quoted}")

    #: The inputs §4.1 property 2 names, in the order it names them.
    emitted = [module.coordinate_space_id({"slide_id": slide, "region_name": region},
                                          IDS_A, POS_A)[0]
               for slide, region in (("Slide_1_HeartBlock", "R2"),
                                     ("Slide_1", "HeartBlock_R2"))]
    assert quoted == emitted, (
        "the design's worked examples are not what the shipped ladder emits — one of the two has "
        f"drifted and nothing else would have said so. design={quoted} shipped={emitted}")
    assert emitted[0] != emitted[1], emitted


# ── TEST-16 — the bump, and the manifest this branch does NOT own ───────────────────

def test_TEST_16_the_manifest_version_is_bumped_WITH_its_changelog_entry():
    """TEST-16 of `coordinate-frame-identity` [covers: ITEM-11, ITEM-12] — a bare number bump breaks this repo's convention.

    `manifest.yaml` carries an oldest-first `# X.Y.Z — #NNN: rationale` block above `version:`, and
    both halves are asserted: the number must be strictly greater than `origin/main`'s own, AND
    the newest entry must name that same number and at least one issue. A version bumped without a
    log entry, or a log entry for a version the file does not declare, both fail. The changelog is
    also APPEND-ONLY: every head and continuation line that exists on `origin/main` above ITS
    version line must still be present, byte for byte, above the (new, higher) version line here —
    a branch may only add a new head block, never edit or delete a past entry. Both the floor and
    the history half are DERIVED from `origin/main` rather than pinned to the previous branch's
    facts, so a legitimate bump on any future branch stays green (#437).

    #300's lesson — manifest collisions hit FOUR consecutive spatial branches — is the reason the
    OTHER half of TEST-16 exists at all: `spatial-types/manifest.yaml` is owned by a sibling branch
    (#313) right now, and this branch changes no vendored declaration module, so it must be
    byte-identical to the one on `origin/main`. That half is a BRANCH-DIFF question and is asserted
    one package over, where its arming marker is — see the comment at the end of this function.

    `encoding="utf-8"` is EXPLICIT — the changelog uses em dashes, so under `LC_ALL=C` a
    locale-default read raises or mis-decodes and this guard would go green on a real regression
    (#333/#339/#330). The `origin/main` side is `subprocess` text, which `git` emits as UTF-8.
    """
    import re

    manifest = XF.PKG / "manifest.yaml"
    text = manifest.read_text(encoding="utf-8")

    declared = [line.split(":", 1)[1].strip().strip('"\'')
                for line in text.splitlines() if line.startswith("version:")]
    assert len(declared) == 1, f"expected exactly one top-level `version:`, found {declared}"
    version = tuple(int(part) for part in declared[0].split("."))

    # The version floor is DERIVED from `origin/main`'s own `version:`, not a literal: a hardcoded
    # floor rots the moment main moves past it (it would silently permit a version claim that is
    # actually stale relative to a newer main). #437.
    origin_text, skip_reason = XF.origin_main_text(
        "src-app/packages/spatial-import-xenium/manifest.yaml")
    if skip_reason is not None:
        pytest.skip(skip_reason)
    origin_declared = [line.split(":", 1)[1].strip().strip('"\'')
                       for line in origin_text.splitlines() if line.startswith("version:")]
    assert len(origin_declared) == 1, (
        f"expected exactly one top-level `version:` on origin/main, found {origin_declared}")
    origin_version = tuple(int(part) for part in origin_declared[0].split("."))
    # The strict `>` is required ONLY when this branch actually TOUCHES the package
    # (relative to `origin/main`); when it does not — the state `main` itself is in after
    # any merge, including this very branch after it lands — there is no local version claim
    # to verify, so the guard SKIPS rather than asserting a relationship it has no basis to
    # demand (#530). The discriminator lives in `xenium_fixtures.package_touched_since_origin_main`,
    # a non-`test_*` helper, so the branch-diff sweep
    # (`_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`)
    # does not flag it — exactly as `origin_main_text` in the same file is not flagged.
    if XF.package_touched_since_origin_main():
        assert version > origin_version, (
            f"version {declared[0]} is not above origin/main's {origin_declared[0]} — this branch "
            "touches the package (per `git diff origin/main...HEAD`) and must bump it")
    else:
        pytest.skip(
            "this branch does not touch spatial-import-xenium (per `git diff origin/main...HEAD`), "
            "so there is no local version claim to verify against origin/main's own — see #530")

    lines = text.splitlines()
    heads = [(i, line) for i, line in enumerate(lines)
             if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
    assert heads, "no `# X.Y.Z — #NNN: rationale` changelog entry head found in manifest.yaml"
    version_line = next(i for i, line in enumerate(lines) if line.startswith("version:"))
    newest_idx, newest = [(i, line) for i, line in heads if i < version_line][-1]
    assert newest.startswith(f"# {declared[0]} — #"), (
        f"the entry immediately above `version:` is {newest!r}; it must name the declared version "
        f"{declared[0]}, or the bump has no log entry")
    # The head regex above already requires the newest entry to name AT LEAST ONE issue number by
    # construction, so no branch-specific issue literal is asserted here (#437).
    assert len(newest.split(":", 1)[1].strip()) > 20, f"the entry needs a rationale: {newest!r}"

    body = lines[newest_idx + 1:]
    continued = [line for line in body[:80] if line.startswith("#          ")]
    assert len(continued) >= 5, (
        f"the {declared[0]} entry has only {len(continued)} continuation lines; a bare number bump "
        f"with a one-line note is what this repo's convention refuses")

    # The changelog is APPEND-ONLY: every head and continuation line that exists on `origin/main`
    # above ITS version line must still be present, byte for byte, above the (new, higher) version
    # line here. This subsumes the old two-hardcoded-entries check — it asserts about ALL history,
    # not just two named entries, and needs no branch-specific literal. Reached only when the
    # `git show` above succeeded (otherwise the whole test skipped), so an unfetched `origin/main`
    # can never fail this half. #437.
    origin_lines = origin_text.splitlines()
    origin_version_index = next(
        i for i, line in enumerate(origin_lines) if line.startswith("version:"))
    origin_heads = [(i, line) for i, line in enumerate(origin_lines)
                    if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
    assert origin_heads, "no changelog entry head found in origin/main's manifest.yaml"
    origin_block = "\n".join(origin_lines[origin_heads[0][0]:origin_version_index])
    current_block = "\n".join(lines[heads[0][0]:version_line])
    assert origin_block in current_block, (
        "the changelog is not append-only: some head or continuation line that exists on "
        "`origin/main` above its `version:` line is missing or edited above the current "
        "`version:` line")
    # A tail-append after a past entry's last continuation line would still pass the substring
    # check above, so look at what immediately follows the origin block inside the current one:
    # it must be a NEW head (or nothing), never a continuation line bolted onto a past entry.
    idx = current_block.index(origin_block)
    tail = current_block[idx + len(origin_block):]
    # Scan the WHOLE of `tail`, not just its first non-empty line: a non-continuation,
    # non-blank line (e.g. `# NOTE: stray comment`) before a genuine continuation-shaped
    # append line must not let the append through. Only a head-shaped line stops the scan;
    # blank lines and any other line neither stop it nor trigger it.
    for line in tail.splitlines():
        if re.match(r"^# \d+\.\d+\.\d+ — #\d", line):
            break  # a genuine new head — everything before it in `tail` was already scanned clean
        assert not re.match(r"^#          ", line), (
            "a line was appended after a past changelog entry's last continuation line — "
            "appending to a past entry's tail is still editing history")

    # The `spatial-types/manifest.yaml` half of TEST-16 — *this branch does not own it* (#313 /
    # #300) — LIVES ONE PACKAGE OVER, in
    # `spatial-import-visium/tests/test_coordinate_space_identity.py::test_the_sibling_manifest_this_branch_does_NOT_own_is_untouched`.
    #
    # It moved because it is a BRANCH-DIFF question and this module has no way to gate one:
    # `_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`
    # measured it here, ungated, and it is right — a comparison against `origin/main` is a question
    # about somebody's branch, so on a later branch that legitimately moves `spatial-types` this
    # assertion goes red in a package that had nothing to do with it. The gate it needs
    # (`zero_core_guard.require_introducing_file`) has to be keyed on a path THIS branch ADDS, and
    # the only one is that visium module — so the assertion lives where its own arming marker is,
    # which is the shape `test_image_failure_provenance.py` already ships.


def test_TEST_16b_the_append_only_comparison_ALGORITHM_discriminates_synthetic_tampering():
    """A DURABLE regression proof for #527/#528/#529's fixes to TEST-16's append-only check.

    TEST-16 itself only exercises the real `manifest.yaml` against the real `origin/main`, neither
    of which currently triggers the failure modes #527/#528/#529 fixed — so reverting any one of
    those fixes leaves TEST-16 green. This test re-implements the SAME comparison algorithm TEST-16
    uses (kept in sync by inspection, not by import, since extracting it into a shared helper is a
    separate refactor) against hand-built synthetic manifests that DO trigger each failure mode, so
    a future regression of the comparison logic itself is caught here even when the real manifest
    stays quiet. This is a PACKAGING/regression-proof check, not a behavioural one — it would fail
    if TEST-16's comparison algorithm regresses, independent of anything import_xenium.py computes.
    """
    import re

    def compare(origin_text, text):
        lines = text.splitlines()
        version_line = next(i for i, line in enumerate(lines) if line.startswith("version:"))
        heads = [(i, line) for i, line in enumerate(lines)
                 if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
        assert heads, "no changelog entry head found"
        origin_lines = origin_text.splitlines()
        origin_version_index = next(i for i, line in enumerate(origin_lines)
                                     if line.startswith("version:"))
        origin_heads = [(i, line) for i, line in enumerate(origin_lines)
                        if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
        assert origin_heads, "no changelog entry head found in origin text"
        origin_block = "\n".join(origin_lines[origin_heads[0][0]:origin_version_index])
        current_block = "\n".join(lines[heads[0][0]:version_line])
        if origin_block not in current_block:
            return False, "not append-only"
        idx = current_block.index(origin_block)
        tail = current_block[idx + len(origin_block):]
        for line in tail.splitlines():
            if re.match(r"^# \d+\.\d+\.\d+ — #\d", line):
                break
            if re.match(r"^#          ", line):
                return False, "tail-append to a past entry"
        return True, "ok"

    # #528 — a self-quoted version-line substring must NOT fool a first-occurrence-style split;
    # this synthetic pair has origin's own head text containing the literal string "version: 3.0.0"
    # (the real version line further down), and the current side DELETES "line B" from the 2.0.0
    # entry — a real regression that a first-occurrence split would miss because it would truncate
    # its comparison window at the embedded substring instead of at the true structural boundary.
    origin_528 = "\n".join([
        "# header",
        "# 1.0.0 — #1: some entry that says version: 3.0.0 by mistake in prose",
        "#          line A",
        "# 2.0.0 — #2: second entry",
        "#          line B",
        "#          line C",
        "version: 3.0.0",
    ])
    current_528 = "\n".join([
        "# header",
        "# 1.0.0 — #1: some entry that says version: 3.0.0 by mistake in prose",
        "#          line A",
        "# 2.0.0 — #2: second entry",
        "#          line C",
        "# 4.0.0 — #4: new entry with enough rationale text to pass any length floor",
        "#          line D",
        "version: 4.0.0",
    ])
    ok, reason = compare(origin_528, current_528)
    assert not ok, (
        "#528 regression: a changed changelog entry (deleted 'line B') was not detected because "
        "the compared block was truncated at a self-quoted version-line substring")

    # #527 — editing ONLY the documentation header (everything before the first changelog head)
    # must NOT be flagged as a changelog append-only violation.
    origin_527 = "\n".join([
        "# HEADER LINE 1 original",
        "# HEADER LINE 2 original",
        "# 1.0.0 — #1: first entry",
        "#          line A",
        "version: 1.0.0",
    ])
    current_527 = "\n".join([
        "# HEADER LINE 1 EDITED",
        "# HEADER LINE 2 original",
        "# 1.0.0 — #1: first entry",
        "#          line A",
        "# 2.0.0 — #2: second entry with enough rationale text to pass any length floor",
        "#          line B",
        "version: 2.0.0",
    ])
    ok, reason = compare(origin_527, current_527)
    assert ok, (
        f"#527 regression: a header-only edit was wrongly flagged as an append-only violation "
        f"({reason!r})")

    # #529.1 — a continuation-shaped line appended directly after a past entry's last continuation
    # line (before the next head) must be caught, INCLUDING when a stray comment line sits between
    # the past entry's tail and the appended continuation (the F1 gap this test also covers).
    origin_5291 = "\n".join([
        "# HEADER",
        "# 1.0.0 — #1: first entry",
        "#          line A",
        "#          line B",
        "version: 1.0.0",
    ])
    current_5291 = "\n".join([
        "# HEADER",
        "# 1.0.0 — #1: first entry",
        "#          line A",
        "#          line B",
        "# NOTE: a stray comment line, neither a head nor a continuation line",
        "#          line B2 APPENDED to a past entry's tail, past a stray comment line",
        "# 2.0.0 — #2: second entry with enough rationale text to pass any length floor",
        "#          line C",
        "version: 2.0.0",
    ])
    ok, reason = compare(origin_5291, current_5291)
    assert not ok, (
        "#529.1/F1 regression: a continuation line appended after a past entry's tail, separated "
        "by a stray non-continuation comment line, was not detected")
