#!/usr/bin/env python3
# ruff: noqa
"""The two DECLARATION RESIDUES of #270/#271 — #319 and #320.

One rule, two places it was not fully applied: *emit what was verified, disclose what was
inferred, never let an inference occupy a field a consumer reads as vendor fact.*

* **#319** — `xenium_image._channel_index` resolved the `CYX` channel by matching a regex over the
  WHOLE OME-XML against `series.pages` positionally. That alignment holds only for a
  single-`<Image>` document, and it is broken a second way even there, because the regex drops the
  UNNAMED channels instead of holding their place.
* **#320** — `section.sample_id` accepted `region_name` whenever the vendor wrote anything at all,
  so every bundle that left the field at the generic word `region` declared itself section 0 of one
  shared sample.

## The discipline these tests are held to

Every fix is pinned by a **disagreement with the pre-change body**, not by asserting the new value
alone — the shape `test_unverified_declarations.py` established, for the reason it gives: asserting
the new value cannot tell a fix from a coincidence. Each mutation test asserts FIRST that the old
body reproduces the defect on that fixture, so the comparison can never be vacuous, and the old
body is a SOURCE MUTATION of the shipped file rather than a re-implementation of it — so a revert
makes the two identical and the test reddens.

Both #319 fixtures are the REAL vendor pixels with a rewritten OME document, and both #320 fixtures
are the REAL vendor `experiment.xenium` with one key changed: the only variable between a case and
its control is the thing under test.
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


# ── OME documents, hand-written so the binding under test is the variable ────────────

#: The emitted grid. Small enough to write in a test, real enough to import.
_H, _W = 96, 128

_OME_HEAD = ('<?xml version="1.0" encoding="UTF-8"?>'
             '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">')


def _image(image_id, pixels_id, *, size_c, first_ifd, channels):
    return (f'<Image ID="{image_id}"><Pixels ID="{pixels_id}" DimensionOrder="XYCZT" '
            f'Type="uint16" SizeX="{_W}" SizeY="{_H}" SizeC="{size_c}" SizeZ="1" SizeT="1">'
            f'{channels}<TiffData IFD="{first_ifd}" PlaneCount="{size_c}"/></Pixels></Image>')


def _named(channel_id, name):
    return f'<Channel ID="{channel_id}" Name="{name}" SamplesPerPixel="1"/>'


def _unnamed(channel_id):
    return f'<Channel ID="{channel_id}" SamplesPerPixel="1"/>'


#: The two `CYX` documents, each named for the QUESTION it puts to the binding, and each shaped so
#: exactly ONE clause of `series_channel_names` refuses it:
#:
#: | document | images | channel tags | pages | the ONLY clause that refuses it |
#: |---|---|---|---|---|
#: | `two_images` | 2 | 2 unnamed + 1 named | 2 | the `<Image>` clause — #319's own measured case |
#: | `tag_count`  | 1 | 1 named | 3 | the tag-count clause — one image, but tag 0 says nothing about pages 1-2 |
#: | `aligned`    | 1 | 3 (first UNNAMED) | 3 | none — this is the shape the binding accepts |
def _cyx_documents():
    return {
        # #319 VERBATIM: the emitted series' two channels are UNNAMED and a SECOND image declares
        # `DAPI`. A whole-document scan hands back `['DAPI']` and calls it this series' channel 0.
        "two_images": (_OME_HEAD
                       + _image("Image:0", "Pixels:0", size_c=2, first_ifd=0,
                                channels=_unnamed("Channel:0:0") + _unnamed("Channel:0:1"))
                       + _image("Image:1", "Pixels:1", size_c=1, first_ifd=2,
                                channels=_named("Channel:1:0", "DAPI"))
                       + "</OME>"),
        # ONE image, so the `<Image>` clause passes it. Its single tag cannot say anything about
        # pages 1 and 2, and `names[0]` would be page 0's name only by luck.
        "tag_count": (_OME_HEAD
                      + _image("Image:0", "Pixels:0", size_c=3, first_ifd=0,
                               channels=_named("Channel:0:0", "DAPI"))
                      + "</OME>"),
        # THE QUIET MISALIGNMENT, and the fixture the `<Image>` clause alone cannot catch: one
        # image, three channels, three pages — but channel 0 is UNNAMED, so the whole-document
        # regex returns `['18S', 'DAPI']` and `names[1] == 'DAPI'` points at PAGE 1.
        "aligned": (_OME_HEAD
                    + _image("Image:0", "Pixels:0", size_c=3, first_ifd=0,
                             channels=_unnamed("Channel:0:0")
                             + _named("Channel:0:1", "18S")
                             + _named("Channel:0:2", "DAPI"))
                    + "</OME>"),
    }


def _vendor_planes(count):
    """`count` DISTINCT planes of REAL vendor pixels, cropped — never synthesised noise.

    Distinct is load-bearing: the byte oracles below compare the emitted pixels against ONE page's,
    and identical pages would satisfy that comparison for every possible selection.
    """
    import tifffile

    with tifffile.TiffFile(str(XF.PRIME / "morphology.ome.tif")) as handle:
        pages = handle.series[0].pages
        planes = [pages[i % len(pages)].asarray()[:_H, :_W].copy() for i in range(count)]
    for i, plane in enumerate(planes):
        # A per-plane marker on top of the vendor pixels, so "which page was emitted" is a
        # one-pixel question even where two source planes happen to agree.
        plane[0, 0] = 40 + i
    return planes


def _write_cyx(path, document, *, pages_in_series, extra_pages=0):
    import tifffile

    planes = _vendor_planes(pages_in_series + extra_pages)
    with tifffile.TiffWriter(str(path)) as writer:
        writer.write(np.stack(planes[:pages_in_series]), photometric="minisblack",
                     description=document, metadata=None)
        for plane in planes[pages_in_series:]:
            writer.write(plane, photometric="minisblack", metadata=None)
    return path, planes


def _cyx_fixture(tmp_path, which):
    documents = _cyx_documents()
    pages, extra = {"two_images": (2, 1), "tag_count": (3, 0), "aligned": (3, 0)}[which]
    path, planes = _write_cyx(Path(tmp_path) / f"{which}.ome.tif", documents[which],
                              pages_in_series=pages, extra_pages=extra)
    return path, planes


# ── #319 ─────────────────────────────────────────────────────────────────────────────

def test_the_bound_list_is_the_emitted_series_own_channels_and_each_clause_has_its_own_fixture():
    """TEST-1 (ITEM-1) — `series_channel_names`, clause by clause.

    A clause whose only fixture another clause already refuses is not a guard, it is decoration —
    the lesson `sole_declared_channel`'s own docstring records. So each document below is refused
    by EXACTLY ONE clause and accepted by the others, and that is asserted rather than assumed.
    """
    import xenium_image as XI

    documents = _cyx_documents()

    # The `<Image>` clause, alone: two images, and the tag count (3) is not the page count anyway —
    # so it is checked against a page count that makes the OTHER clause pass.
    assert XI.series_channel_names(documents["two_images"], 3) == [], (
        "a document declaring TWO `<Image>` elements cannot bind names to the emitted series — "
        "that is #319's whole case")

    # The tag-count clause, alone: ONE image (so the first clause passes), one tag, three pages.
    assert XI.series_channel_names(documents["tag_count"], 3) == [], (
        "one `<Image>` is not enough: a single `<Channel>` tag says nothing about pages 1-2, and "
        "`names[0]` would be page 0's name only by luck")
    # ... and the SAME document binds when the series really does have one page, which is what
    # makes the clause a count check rather than a blanket refusal.
    assert XI.series_channel_names(documents["tag_count"], 1) == ["DAPI"]

    # THE COUNT IS A COUNT, NOT A LOWER BOUND. A blind tests-quality angle weakened
    # `len(tags) != page_count` to `len(tags) < page_count` and the whole suite stayed GREEN: no
    # fixture had MORE channel tags than pages. Binding then succeeds and `available` is emitted
    # LONGER than the series, which is the same over-claim #319 exists to remove.
    too_many = (_OME_HEAD + _image("Image:0", "Pixels:0", size_c=4, first_ifd=0,
                                   channels=_named("Channel:0:0", "18S")
                                   + _named("Channel:0:1", "GFP")
                                   + _named("Channel:0:2", "DAPI")
                                   + _named("Channel:0:3", "PD-1")) + "</OME>")
    assert XI.series_channel_names(too_many, 3) == [], (
        "four declared channels cannot be bound to a three-page series in either direction — the "
        "clause is an EQUALITY, and a document that declares more channels than the series has "
        "pages is exactly as unbindable as one that declares fewer")
    assert XI.series_channel_names(too_many, 4) == ["18S", "GFP", "DAPI", "PD-1"]

    # The accepted shape — and the empty entry HOLDS ITS PLACE, which is the second half of #319.
    assert XI.series_channel_names(documents["aligned"], 3) == ["", "18S", "DAPI"], (
        "an unnamed channel must occupy its index; dropping it takes every later channel's index "
        "with it")

    # The whole-document regex disagrees, and that disagreement IS the defect.
    assert XI.channel_names(documents["aligned"]) == ["18S", "DAPI"]

    # The audited readers, not a fresh regex: a commented-out channel is not a declaration and a
    # `<ChannelRef>` is not a `<Channel>`.
    commented = documents["aligned"].replace(
        _named("Channel:0:1", "18S"), "<!-- " + _named("Channel:0:1", "OldStain") + " -->")
    assert XI.series_channel_names(commented, 3) == [], (
        "a commented-out `<Channel>` must not be COUNTED as a declaration either — counting it "
        "would bind three tags to three pages and label page 1 with a disabled stain")
    assert XI.series_channel_names("", 3) == [] and XI.series_channel_names(None, 3) == []


def test_a_multi_image_document_never_labels_the_emitted_plane_with_another_images_stain(tmp_path):
    """TEST-2 [acceptance] (INV-1) — #319's own measurement, and the byte oracle beside it.

    MEASURED on `origin/main` @ 778eddc3, on exactly this file:

        {'axes': 'CYX', 'axis': 'C', 'index': 0, 'of': 2, 'rule': 'channel-name-match',
         'channel_name': 'DAPI', 'available': ['DAPI']}

    Three false statements at once — a stain belonging to `Image:1`, a `rule` asserting a match
    happened, and an `available` list of one for a two-channel series.

    The second half is what makes this an acceptance test for INV-1 rather than a dict comparison:
    the emitted PIXELS must still be `Image:0` page 0. The claim is refused; the image is not.
    """
    import xenium_image as XI

    path, planes = _cyx_fixture(tmp_path, "two_images")
    plane, selection = XI.read_plane(path)

    assert selection["axes"] == "CYX" and selection["of"] == 2, selection
    assert "channel_name" not in selection, (
        f"the emitted plane is labelled with a stain the document declares on ANOTHER image: "
        f"{selection}")
    assert "available" not in selection, (
        "`available` promises 'the channels of THIS SERIES, index-aligned with its pages' — the "
        f"one thing that could not be established here: {selection}")
    assert selection["rule"] == "first-channel", selection
    # The refusal is STATED, with its evidence, in the vocabulary #270/#271 shipped.
    assert selection["channel_name_rule"] == "unverified-channel", selection
    assert selection["declared_channels"] == ["DAPI"], selection

    assert np.array_equal(plane, planes[0]), (
        "the CLAIM was to be refused, not the image — the emitted pixels must still be the "
        "series' first page")


def test_an_unnamed_channel_holds_its_index_so_the_named_one_is_found_where_it_really_is(tmp_path):
    """TEST-3 (ITEM-2) — the quieter half of #319, which the `<Image>` clause cannot catch.

    One `<Image>`, three channels, three pages: the document is perfectly well-formed and the
    whole-document alignment still fails, because `_CHANNEL_NAME_RE` only matches a `<Channel>`
    that CARRIES a name. `['18S', 'DAPI']` puts DAPI at index 1; it is really page 2.

    This is also the positive control for the whole fix: the binding must still ANSWER where it
    holds, or "no wrong stain is emitted" would be satisfied by emitting no stain ever.
    """
    import xenium_image as XI

    path, planes = _cyx_fixture(tmp_path, "aligned")
    plane, selection = XI.read_plane(path)

    assert selection["index"] == 2, (
        f"DAPI is channel 2 of this series; {selection['index']} is where the whole-document list "
        "puts it after the unnamed channel is dropped")
    assert selection["rule"] == "channel-name-match" and selection["channel_name"] == "DAPI"
    assert selection["available"] == ["", "18S", "DAPI"], (
        f"`available` must be the bound list entire, empty entries included: {selection}")
    assert "channel_name_rule" not in selection, (
        "the binding HELD, so there is no refusal to disclose — `rule` already says how the "
        f"channel was chosen: {selection}")
    assert np.array_equal(plane, planes[2]), "the declared channel's own pixels must be emitted"


def test_one_image_is_not_enough_when_its_tags_cannot_cover_the_pages(tmp_path):
    """TEST-21 (ITEM-2) — the tag-count clause, end to end rather than as a unit.

    A single `<Image>` declaring ONE named channel over a THREE-page series. The `<Image>` clause
    passes it, so without the count clause `names[0] == 'DAPI'` would label page 0 — a name the
    document attaches to a channel it never says is page 0's.
    """
    import xenium_image as XI

    path, planes = _cyx_fixture(tmp_path, "tag_count")
    plane, selection = XI.read_plane(path)

    assert "channel_name" not in selection and "available" not in selection, selection
    assert selection["rule"] == "first-channel", selection
    assert selection["channel_name_rule"] == "unverified-channel", selection
    assert selection["declared_channels"] == ["DAPI"], selection
    assert np.array_equal(plane, planes[0])


#: The binding, backed out as a SOURCE mutation of the shipped file — so the mutant is the real
#: module with the #319 fix removed, and a revert makes it identical to what ships.
_PRE_CHANGE_BINDING = (
    "                series_names = series_channel_names(xml, len(pages))\n",
    "                series_names = channel_names(xml)\n",
)


def _shipped_with_the_binding_backed_out():
    path = XF.PKG / "compute" / "xenium_image.py"
    source = path.read_text()
    old, new = _PRE_CHANGE_BINDING
    assert source.count(old) == 1, (
        f"the mutation anchor matched {source.count(old)} times. If it matched ZERO, the most "
        "likely cause is that the #319 fix has been REVERTED out of `xenium_image.py` — THAT is "
        "the regression this test exists for, not a stale anchor. A mutation that matches nothing "
        "tests nothing.")
    module = types.ModuleType("xenium_image_pre_change_319")
    module.__file__ = str(path)
    exec(compile(source.replace(old, new), str(path), "exec"), module.__dict__)
    return module


@pytest.mark.parametrize("which, defect_name, defect_index", [
    # The mutant the OLD body misses is stated per row: what it emitted, and where it emitted from.
    ("two_images", "DAPI", 0),   # another image's stain, on an unnamed channel's pixels
    ("tag_count", "DAPI", 0),    # a name that covers 1 of 3 pages, asserted for page 0
    ("aligned", "DAPI", 1),      # the right stain, the WRONG PAGE — index 1 instead of 2
])
def test_the_pre_change_binding_and_the_shipped_one_must_DISAGREE(
        which, defect_name, defect_index, tmp_path):
    """TEST-4 (ITEM-2, ITEM-3) — the regression pin for #319, stated as a disagreement.

    Each row names a mutant the PRE-CHANGE body misses and the new one catches:

    * `two_images` — the old body reports `channel-name-match` / `DAPI` / `available: ['DAPI']`
      for a two-channel series whose own channels are unnamed, and emits page 0's pixels. This is
      the issue's literal measurement.
    * `tag_count` — one `<Image>`, so #271's own clause would have accepted it; the old body
      attaches a name that covers one of three pages to page 0.
    * `aligned` — the one row where the old body emits the RIGHT NAME on the WRONG PIXELS. Nothing
      in the artifact could tell: `index`, `rule`, `channel_name` and `available` are all
      self-consistent and all describe page 1 while DAPI is page 2. A fixture with no unnamed
      channel cannot pin this clause, which is why `aligned` exists.

    The first assertion in each pair is the load-bearing one: it proves the fixture discriminates.
    """
    import xenium_image as XI

    path, planes = _cyx_fixture(tmp_path, which)

    plane, shipped = XI.read_plane(path)
    old_plane, pre_change = _shipped_with_the_binding_backed_out().read_plane(path)

    assert pre_change.get("channel_name") == defect_name, (
        f"the pre-change body did not reproduce the defect on the {which!r} fixture "
        f"({pre_change}) — then this fixture does not discriminate and the comparison below is "
        "vacuous")
    assert pre_change["index"] == defect_index, pre_change
    assert np.array_equal(old_plane, planes[defect_index]), (
        "the pre-change body must also EMIT the page it declares, or the fixture is not "
        "reproducing the defect the issue measured")

    assert (shipped.get("channel_name"), shipped["index"]) != \
           (pre_change.get("channel_name"), pre_change["index"]), (
        "the shipped code and the pre-change code make the SAME claim on a fixture built to tell "
        f"them apart — the fix is not in effect. Both said {shipped.get('channel_name')!r} at "
        f"index {shipped['index']}")
    assert shipped.get("available") != pre_change.get("available"), (
        f"`available` is unchanged by the fix on {which!r}: {shipped.get('available')!r}")


def test_the_real_twelve_file_CYX_bundle_still_names_its_channel(tmp_path):
    """TEST-5 (ITEM-2) — the control on REAL vendor bytes, which refuses a fix that just stops.

    The protein bundle's `morphology_focus/` document declares ONE `<Image>` with TWELVE
    `<Channel>` elements over twelve pages, so the binding holds and every #270-era assertion about
    this bundle must be untouched. A fix that made `series_channel_names` return `[]` more often
    than it must would pass every assertion above and fail here.
    """
    import xenium_image as XI
    import tifffile

    source = XF.PROTEIN / "morphology_focus" / "ch0000_dapi.ome.tif"
    with tifffile.TiffFile(str(source)) as handle:
        page_count = len(handle.series[0].pages)
        bound = XI.series_channel_names(handle.ome_metadata or "", page_count)

    assert page_count == 12, page_count
    assert len(bound) == 12 and bound[0] == "DAPI", (
        f"the real bundle's own document must BIND — it declares one image and twelve channels: "
        f"{bound}")

    _plane, selection = XI.read_plane(source)
    assert selection["rule"] == "channel-name-match", selection
    assert selection["channel_name"] == "DAPI" and selection["index"] == 0, selection
    assert len(selection["available"]) == 12, selection
    assert "PD-L1" in selection["available"] and "VISTA" in selection["available"], selection
    assert "channel_name_rule" not in selection, selection


# ── #320 ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key, value, expected", [
    # TRUE — the value is only the subject of its own key. Four of these are the four fields the
    # shipped `xenium-prime-outs` bundle actually carries, which is the evidence DEC-4 rests on.
    ("region_name", "region", True),
    ("slide_id", "slide", True),
    ("run_name", "run", True),
    ("cassette_name", "cassette", True),
    ("region_name", "Region", True),          # case is a spelling, not a statement
    ("region_name", "  region  ", True),      # so is surrounding whitespace
    ("panel_label", "panel", True),           # a key this importer never asks about
    # ROWS ADDED AT FIX_ROUND-1, each pinning a statement a blind tests-quality angle MUTATED with
    # the whole suite staying green. Every one of them names the mutation it kills.
    ("REGION_NAME", "region", True),          # `key…lower()` -> `key…` : every other row's key is
                                              # already lower-case, so the KEY-side fold was untested
    ("x_label_id", "x_label", True),          # the loop's `break` deleted: without it `_label` is
                                              # stripped too and the subject becomes `x`
    ("", "", False),                          # `if not text: return False` deleted: an empty value
                                              # then equals an empty subject and answers True
    # FALSE — every one of these IDENTIFIES something, and the rule must not reach any of them.
    ("region_name", "region_2", False),
    ("region_name", "posterior region", False),
    ("region_name", "regions", False),
    ("region_name", "hKidney_sample", False),  # the protein bundle's real value
    ("slide_id", "Slide_1", False),            # the protein bundle's real value
    ("region_name", "name", False),            # the SUFFIX is not the subject
    # ITEM-12 / DEC-12, from the blind design-conformance audit: a value that repeats its ENTIRE
    # key identifies exactly as much as one that repeats the subject, and the design's one-sentence
    # justification covers both. This row answered False before the audit, and the first version
    # would have emitted `sample_id: "region_name"` with `sample_id_source: "region_name"`.
    ("region_name", "region_name", True),
    ("slide_id", "slide_id", True),
    # #323 added `_uuid` to `_NON_IDENTIFYING_KEY_SUFFIXES` when this rule was asked of
    # `roi_uuid` for the first time. Same derivation as the other three suffixes — the key is
    # the subject plus the KIND of thing it holds — and the FALSE row is the control that the
    # extension did not make the rule blunt enough to swallow a real uuid.
    ("roi_uuid", "roi", True),
    ("cassette_uuid", "cassette", True),
    ("roi_uuid", "roi_uuid", True),
    ("roi_uuid", "d4c2d423-83ed-4e44-8dfd-a0072bcc3afc", False),
    # NOT THIS PREDICATE'S QUESTION — `_VENDOR_PLACEHOLDERS` owns "the vendor said nothing".
    ("region_name", "", False),
    ("region_name", "   ", False),
    ("region_name", None, False),
    ("region_name", 7, False),
    (None, "region", False),
])
def test_a_value_that_is_only_its_own_field_name_identifies_nothing(key, value, expected):
    """TEST-6 (ITEM-4) — the predicate, including the rows it must NOT reach.

    The rule is DERIVED FROM THE KEY, which is what makes it not a denylist: `panel_label` is a
    field this importer never asks about and the same call answers it. The false rows are the
    guard against bluntness — `region_2`, `posterior region` and `regions` all CONTAIN the generic
    word and all identify a region, so a substring rule would swallow them.
    """
    module = XF.load_compute()
    assert module.non_identifying_vendor_label(key, value) is expected, (
        f"non_identifying_vendor_label({key!r}, {value!r}) must be {expected}")


def test_section_sample_id_has_three_legs_and_says_which_one_answered():
    """TEST-7 (ITEM-5) — the three legs and their sources, at the seam.

    The two fallback legs share a VALUE and differ in SOURCE on purpose: a consumer needs
    uniqueness from the value, and a human needs to know which of the two happened — in one case
    the provenance block still carries `region_name`, in the other it carries nothing.
    """
    module = XF.load_compute()
    space = "xenium:some-roi-uuid"

    assert module.section_sample_id({"region_name": "hKidney_sample"}, space) == \
        ("hKidney_sample", "region_name")
    assert module.section_sample_id({"region_name": "region"}, space) == \
        (f"unverified-sample:{space}", "non-identifying-region-name")
    assert module.section_sample_id({"region_name": "Region"}, space)[1] == \
        "non-identifying-region-name"
    assert module.section_sample_id({}, space) == \
        (f"unverified-sample:{space}", "no-vendor-sample-statement")
    assert module.section_sample_id({"region_name": "unknown"}, space)[1] == \
        "no-vendor-sample-statement", (
        "a PLACEHOLDER is still 'the vendor said nothing' — #320 must not retype #270's leg")
    # The blast radius stayed on the field that needed it: the closed placeholder list and the
    # provenance block are untouched, so `region` is still RECORDED as what the vendor wrote.
    assert "region" not in module._VENDOR_PLACEHOLDERS, module._VENDOR_PLACEHOLDERS
    assert module.vendor_provenance({"region_name": "region"}, {})["region_name"] == "region"


def _staged(tmp_path, name, **overrides):
    """A copy of `xenium-prime-outs` with `experiment.xenium` keys overridden (or popped on None)."""
    root = XF.stage_bundle(tmp_path, name=name)
    path = root / "experiment.xenium"
    doc = json.loads(path.read_text())
    for key, value in overrides.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value
    path.write_text(json.dumps(doc))
    return root


#: ONE spelling, in the shared fixture module (#323). Both suites had this byte-identically and
#: a third would have copied it; the module under test carries the argument against a second
#: spelling in its own docstrings.
_imported = XF.imported


def test_two_bundles_that_left_the_generic_region_name_are_not_one_sample(tmp_path):
    """TEST-8 [acceptance] (INV-4) — #320's own measurement, END TO END through `run_import`.

    MEASURED on `origin/main` @ 778eddc3, on exactly these two staged copies:

        bundle a: region_name='region' roi_uuid=…0000 -> sample_id='region' space='xenium:…0000'
        bundle b: region_name='region' roi_uuid=…0001 -> sample_id='region' space='xenium:…0001'
        SAME sample_id, SAME index (0), DIFFERENT coordinate_space

    Two unrelated experiments declaring themselves *section 0 of sample `region`*. The fixture is
    the shipped bundle with ONE key changed, so `region_name` is the vendor's own value.

    The third bundle is the control that stops this passing by refusing everything: a real name is
    still emitted verbatim, from the same code path, in the same run.
    """
    ids, sources = [], []
    for suffix, roi in (("a", "aaaaaaaa-0000-0000-0000-000000000000"),
                        ("b", "bbbbbbbb-0000-0000-0000-000000000001")):
        root = _staged(tmp_path, f"generic-{suffix}", roi_uuid=roi)
        assert json.loads((root / "experiment.xenium").read_text())["region_name"] == "region", (
            "the shipped fixture must still carry the generic `region_name`, or this test is "
            "measuring something else")
        meta, report = _imported(tmp_path, root, f"generic-{suffix}")
        ids.append(meta["section"]["sample_id"])
        sources.append(report["section"]["sample_id_source"])
        assert meta["section"]["index"] == 0, meta["section"]
        assert report["provenance"]["region_name"] == "region", (
            "the vendor's own string must NOT be lost — it is the evidence a human needs in "
            f"order to see why the sample id was namespaced: {report['provenance']}")

    assert ids[0] != ids[1], (
        "two unrelated experiments were declared to be sections of ONE sample. Both got "
        f"{ids[0]!r}")
    assert all(i.startswith("unverified-sample:") for i in ids), ids
    assert sources == ["non-identifying-region-name"] * 2, sources

    real = _staged(tmp_path, "real-name", region_name="region_7")
    meta, report = _imported(tmp_path, real, "real-name")
    assert meta["section"]["sample_id"] == "region_7", (
        "a real region name that merely CONTAINS the generic word must still be emitted verbatim "
        f"— otherwise the rule is a substring match, not the self-naming-field rule: {meta['section']}")
    assert report["section"]["sample_id_source"] == "region_name", report["section"]


def test_the_missed_collision_this_rule_accepts_is_visible_and_recoverable(tmp_path):
    """TEST-9 [acceptance] (INV-3) — the cost of the #320 rule, and the two properties that price it.

    REWRITTEN at FIX_ROUND-1. The first version asserted that two bundles with no `roi_uuid` get
    different coordinate spaces, and the blind design-conformance audit showed that assertion was
    satisfied by the TEST's own choice of two differently-named tmp directories rather than by the
    change — the same code fails it when both bundles are staged under one basename. A test that
    supplies the property it is asserting cannot tell a fix from a fixture.

    INV-3 is `coordinate_space_id`'s own rule — *"a MISSED collision is visible and recoverable
    while a FALSE collision is silent wrong data"* — and this branch deliberately BUYS a missed
    collision: a sample genuinely named `region` is not grouped. This asserts the two properties
    that make that price acceptable, and both are properties of the CODE:

    * **visible** — the report carries the operator's own string (`provenance.region_name`) AND the
      reason the field was not used as an identity (`sample_id_source`), so a human can see exactly
      what happened rather than finding an unexplained id;
    * **recoverable** — rename the region to anything that identifies it and THE SAME TWO BUNDLES
      group again under one `sample_id`. That is what a false collision is not: nobody can
      un-declare two unrelated tissues to be one sample after the fact.
    """
    missed = []
    for suffix, roi in (("a", "eeeeeeee-0000-0000-0000-00000000000a"),
                        ("b", "eeeeeeee-0000-0000-0000-00000000000b")):
        root = _staged(tmp_path, f"missed-{suffix}", roi_uuid=roi, region_name="region")
        meta, report = _imported(tmp_path, root, f"missed-{suffix}")
        missed.append(meta["section"]["sample_id"])
        # VISIBLE, both halves in one report.
        assert report["provenance"]["region_name"] == "region", report["provenance"]
        assert report["section"]["sample_id_source"] == "non-identifying-region-name", \
            report["section"]

    assert missed[0] != missed[1], (
        "the MISS is the accepted cost; a shared id here would be the FALSE collision instead")

    # RECOVERABLE — the SAME two bundles, one field renamed, group again. Same roi_uuids, so the
    # only variable is the operator's answer.
    grouped = []
    for suffix, roi in (("a", "eeeeeeee-0000-0000-0000-00000000000a"),
                        ("b", "eeeeeeee-0000-0000-0000-00000000000b")):
        root = _staged(tmp_path, f"named-{suffix}", roi_uuid=roi, region_name="donor-04-blockA")
        meta, report = _imported(tmp_path, root, f"named-{suffix}")
        grouped.append(meta["section"]["sample_id"])
        assert report["section"]["sample_id_source"] == "region_name", report["section"]

    assert grouped == ["donor-04-blockA", "donor-04-blockA"], (
        "renaming the region must RESTORE the grouping — otherwise the missed collision is not "
        f"recoverable and INV-3's trade does not hold: {grouped}")


def test_the_coordinate_space_ladder_is_unchanged_and_323_is_the_executable_record():
    """TEST-17 (ITEM-6) — INVERTED at #323 [TEST-5 (ITEM-9) of `coordinate-space-identity`].

    ## What this test was, and why it is not deleted

    An earlier version of the #319/#320 branch gated `coordinate_space_id`'s `slide_id+region_name`
    rung with the new predicate, so a prime-shaped bundle with no `roi_uuid` would fall past
    `xenium:slide_region`. The round-1 audit measured what it fell TO, and the gate was withdrawn
    (that branch's DEC-7 CORRECTION): `bundle-directory-name` is the sandbox MOUNT NAME — derived
    from the SLOT by `sandbox/spec.rs`, so plausibly the constant `bundle` for every Xenium import
    — and where it is the user's own directory, `outs` is XOA's own output directory name. The gate
    moved a bundle from a value shared by prime-shaped runs to one shared by ALL runs.

    So this test asserted that the ladder answered exactly what `origin/main` answered, INCLUDING
    the rows that were wrong, and its own body said *"if the ladder was FIXED, delete this row and
    close #323"*. **#323 landed and the row is inverted rather than deleted.** An assertion that
    changes SIDES is worth more than one that disappears: the file that recorded the residue is the
    file that records its closure, and a revert of #323 reddens HERE, where the reader is already
    looking, rather than only in a suite added later.

    ## What it asserts now

    The two control rows are kept VERBATIM — a real `roi_uuid` and a real `slide_id`+`region_name`
    still answer from the vendor, which is what stops the inversion being satisfied by a ladder that
    refuses everything. Each #323 row now asserts the distinctness it used to assert the absence of.
    And the mount-name rung is asserted structurally GONE: `bundle_root` is not a parameter of the
    function any more, so no later edit can reintroduce a directory-derived rung without changing
    the signature this line reads.
    """
    module = XF.load_compute()
    # Two unrelated runs: different cell ids AND different centroids, the two halves the derived
    # rung digests (a blind angle showed the ids alone are not enough — nothing validates the
    # vendor's id format, so two different measurements can carry the same generic ids).
    ids_a, ids_b = ["aaaadpbp-1", "aaaadpbq-1"], ["ffkpbaba-1", "ffkpbabb-1", "ffkpbabc-1"]
    pos_a = np.asarray([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    pos_b = np.asarray([[5.0, 6.0], [7.0, 8.0], [9.0, 10.0]], dtype=np.float32)

    # Rung 1, working as designed — UNCHANGED, and the control for everything below.
    assert module.coordinate_space_id({"roi_uuid": "c55618d8"}, ids_a, pos_a) == \
        ("xenium:c55618d8", "roi_uuid")
    # Rung 2, working as designed — the RUNG is unchanged and the FRAMING moved at #328 (DEC-2):
    # the two components are length-prefixed inside a reserved namespace, because
    # `f"xenium:{slide}_{region}"` answered ONE frame for `Slide_1_HeartBlock`/`R2` and
    # `Slide_1`/`HeartBlock_R2` — two unrelated runs, both fully identifying.
    assert module.coordinate_space_id({"slide_id": "Slide_1", "region_name": "hKidney_sample"},
                                      ids_a, pos_a) == (
        "xenium:slide_id+region_name:7:Slide_1|14:hKidney_sample|", "slide_id+region_name")
    # ── #323's rows. Every one of these WAS two unrelated runs sharing one frame. ─────
    for experiment in ({"roi_uuid": "unknown"},
                       {"slide_id": "unknown", "region_name": "unknown"},
                       {}):
        space_a = module.coordinate_space_id(experiment, ids_a, pos_a)
        space_b = module.coordinate_space_id(experiment, ids_b, pos_b)
        assert space_a[0] != space_b[0], (
            f"#323 has REGRESSED for {experiment!r}: two unrelated runs are declared to share one "
            f"coordinate frame again, both {space_a[0]!r}")
        assert space_a[1] == space_b[1] and space_a[1] in (
            module.NON_IDENTIFYING_SPACE_SOURCE, module.NO_VENDOR_SPACE_SOURCE), space_a
        # ... and the sample id, which quotes the space id, inherits the distinctness.
        assert module.section_sample_id(experiment, space_a[0])[0] != \
            module.section_sample_id(experiment, space_b[0])[0], experiment

    # THE DIRECTORY-NAME RUNG IS GONE, structurally. It used to answer `xenium:bundle` for a
    # slot-mounted input and `xenium:outs` for two unrelated user downloads; the mount path is no
    # longer something this function can see at all.
    params = list(inspect.signature(module.coordinate_space_id).parameters)
    assert params == ["experiment", "cell_ids", "positions"], (
        "the mount-derived rung came back — `bundle_root` is a parameter again, and #323 is that a "
        f"run's coordinate identity must not be a function of where it was mounted: {params}")
    assert '"bundle-directory-name"' not in (XF.PKG / "compute" / "import_xenium.py").read_text(), (
        "`bundle-directory-name` is emitted as a `coordinate_space_source` again")


#: The `origin/main` body of `section_sample_id`'s leg 1, backed out as a SOURCE mutation of the
#: shipped file — so the mutant is the real module with the fix removed, and a revert makes it
#: identical to what ships.
#:
#: THE ANCHOR MOVED TWICE AT #323, and both times because this pin did its job: it went red, and
#: its failure message correctly said "the most likely cause is that the #320 fix has been
#: REVERTED". It had not been; leg 1 had grown two guards it did not have —
#:   * a `region_name` may not forge the `unverified-sample:` prefix (a blind security angle
#:     measured an attacker copying a victim's derived sample id into that field and being
#:     declared a section of the victim's sample), and
#:   * a `region_name` must be a STRING (DEC-15; a blind design-conformance angle measured two
#:     unrelated runs stating `region_name: 0` both declaring themselves section 0 of sample "0").
#: The REPLACEMENT is `origin/main`'s leg 1 verbatim — read the raw key through `vendor_statement`
#: + `_text` and return whatever is non-empty — so the mutant is unchanged in meaning, and the
#: whole of #320's fix plus #323's two additions are what it backs out.
#:
#: There is NO `coordinate_space_id` mutation here, and the reason moved with #323: when #320 wrote
#: this, that function was byte-identical to `origin/main` (DEC-7 CORRECTION) and there was nothing
#: to back out. #323 rewrote it, and its mutation pin lives with it in
#: `test_coordinate_space_identity.py`; TEST-17 above asserts its ladder, inverted.
_PRE_CHANGE_SAMPLE_ID = (
    '''    identifying = vendor_frame_label(experiment, "region_name") or ""
    if identifying and not identifying.lower().startswith(UNVERIFIED_SAMPLE_PREFIX):
        return identifying, "region_name"''',
    '''    stated0 = vendor_statement(experiment.get("region_name"))
    region0 = ("" if stated0 is None else _text(stated0) or "").strip()
    if region0:
        return region0, "region_name"''',
)


def _shipped_with_the_320_fix_backed_out():
    path = XF.PKG / "compute" / "import_xenium.py"
    source = path.read_text()
    old, new = _PRE_CHANGE_SAMPLE_ID
    assert source.count(old) == 1, (
        f"the mutation anchor matched {source.count(old)} times. If it matched ZERO, the most "
        "likely cause is that the #320 fix has been REVERTED out of `import_xenium.py` — THAT "
        "is the regression this test exists for, not a stale anchor.")
    module = types.ModuleType("import_xenium_pre_change_320")
    module.__file__ = str(path)
    exec(compile(source.replace(old, new), str(path), "exec"), module.__dict__)
    return module


def test_the_pre_change_sample_id_body_and_the_shipped_one_must_DISAGREE():
    """TEST-10 (ITEM-5) — the regression pin for #320, on the REAL fixture's own values.

    The mutant the old body misses: the shipped `xenium-prime-outs` `experiment.xenium`, UNMODIFIED.
    `origin/main` answers `("region", "region_name")` — a positive claim that the vendor stated this
    sample, for a value every such bundle shares — and NO pre-existing assertion in this package
    caught it. `origin/main` was green on it, which is why #320 was filed rather than fixed there.

    The `coordinate_space_id` half this test used to carry is GONE, and the reason CHANGED under
    it: #320 removed it because that function was byte-identical to `origin/main` (its DEC-7
    CORRECTION), so a mutation of it would have been a mutation of nothing. **#323 rewrote it and
    changed its signature**, so that is no longer true — the mutation pin for it lives in
    `test_coordinate_space_identity.py` (`_shipped_with_the_323_fix_backed_out`), and TEST-17 above
    asserts the ladder as an inverted characterization. This sentence is corrected rather than
    deleted because a blind angle found the old one still standing here, telling the next reader
    that a function this branch rewrote was untouched.
    """
    module = XF.load_compute()
    pre_change = _shipped_with_the_320_fix_backed_out()
    experiment = XF.experiment(XF.PRIME)
    space = "xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"

    assert pre_change.section_sample_id(experiment, space) == ("region", "region_name"), (
        "the pre-change body did not reproduce the defect on the shipped bundle — then the "
        "comparison below is vacuous")
    assert module.section_sample_id(experiment, space) != \
        pre_change.section_sample_id(experiment, space), (
        "the shipped body and `origin/main`'s agree on the input built to tell them apart")

    # THE WHOLE-KEY SPELLING TOO (ITEM-12): the same disagreement, on the input the first version
    # of the predicate answered exactly as `origin/main` did.
    whole_key = dict(experiment, region_name="region_name")
    assert pre_change.section_sample_id(whole_key, space) == ("region_name", "region_name")
    assert module.section_sample_id(whole_key, space)[1] == "non-identifying-region-name"

    # LEG 1 WAS NEVER THE DEFECT: a real vendor statement must still make the two bodies AGREE.
    stated = dict(experiment, region_name="hKidney_sample")
    assert module.section_sample_id(stated, space) == pre_change.section_sample_id(stated, space)


# ── the two things the code change alone does not carry ──────────────────────────────

def test_the_design_note_and_the_shipped_code_do_not_disagree():
    """TEST-13 (ITEM-8) — the note is cited BY the code and names only tokens the code emits.

    A design note that drifts into fiction is worse than none: the next reader plans against it.
    So every source/rule token its tables name is required to exist in the compute, and the compute
    is required to cite the note by path — the same "wired, not merely present" question the
    lifecycle asks of a deliverable.
    """
    note = (XF.PKG.parents[2] / "docs" / "design" / "xenium-declaration-residues.md")
    assert note.is_file(), f"the design note this branch plans against is missing: {note}"
    text = note.read_text()

    entry = (XF.PKG / "compute" / "import_xenium.py").read_text()
    image = (XF.PKG / "compute" / "xenium_image.py").read_text()

    for token in ("region_name", "non-identifying-region-name", "no-vendor-sample-statement",
                  "bundle-directory-name", "slide_id+region_name",
                  # #323's vocabulary [TEST-11 (ITEM-7, ITEM-13) of `coordinate-space-identity`].
                  # `bundle-directory-name` stays in this list on purpose: the rung is REMOVED, and
                  # both documents still have to NAME it as removed, because a reader who meets
                  # `xenium:outs` in an old dataset needs to find out what produced it.
                  "unverified-space:", "unverified-space-no-vendor-statement",
                  "unverified-space-non-identifying-labels"):
        assert token in text and token in entry, (
            f"{token!r} is named by the note or the code and not by the other")

    # ...and the WITHDRAWN-ERA sentence is gone from the compute. #320's `section_sample_id` said
    # in so many words that three shapes on `origin/main` give two unrelated runs one space; #323
    # closed all three, so a module still carrying that sentence would be describing behaviour it
    # no longer has — the same drift this test exists to catch, one document over.
    # ...and the THREE KNOWN SPELLINGS of "the last rung is a directory name" may not come back
    # anywhere in this package. A blind angle found two such sentences in
    # `test_unverified_declarations.py` after #323 landed, in docstrings this guard could not see
    # because it only read the note and the two compute files.
    #
    # STATED AS WHAT IT IS: a tripwire on the spellings that actually existed, not a proof that no
    # such sentence can be written — a second blind angle correctly pointed out that the first
    # version of this comment claimed the latter. A syntactic guard over a semantic property has an
    # unbounded evasion space; this one is a floor under a known regression, and the real defence
    # is that `bundle_root` is not a parameter any more (asserted structurally above).
    for path in sorted((XF.PKG / "tests").glob("test_*.py")) + \
            sorted((XF.PKG / "compute").glob("*.py")):
        body = path.read_text()
        # ASSEMBLED AT RUNTIME so this guard does not match its OWN source. Writing the phrase
        # as a literal here put it in `body` for this very file and the guard failed on itself;
        # excluding this file would have been the other answer and is worse, because a stale
        # sentence in the drift guard is exactly as misleading as one anywhere else.
        for head in ("IS the upload directory", "itself the upload directory",
                     "to the directory name a user"):
            stale = head + ("'s name" if head.endswith("directory") else " chose")
            assert stale not in body, (
                f"{path.name} carries one of the three spellings this guard knows for 'the "
                "coordinate-space fallback is a directory name'. #323 removed that rung and "
                "`bundle_root` with it, so such a sentence has to be written as history or "
                "corrected")

    assert "unchanged here (DEC-7 CORRECTION)" not in entry, (
        "`section_sample_id` still claims `coordinate_space_id` is unchanged from `origin/main` "
        "and that its three collision shapes are live. #323 closed them; if the fix was REVERTED, "
        "the coordinate-space suite is red above and this line is the second witness")
    for token in ("unverified-channel", "first-channel", "channel-name-match",
                  "declared_channels", "series_channel_names"):
        assert token in text and token in image, (
            f"{token!r} is named by the note or the code and not by the other")

    assert "docs/design/xenium-declaration-residues.md" in entry + image, (
        "neither compute file cites the design note, so nothing points a reader at it")


def test_no_consumer_read_field_holds_an_inference_and_every_refusal_is_disclosed(tmp_path):
    """TEST-14 [acceptance] (INV-2) — both defects at once, through the REAL import.

    INV-2 is a property of the ARTIFACT, not of two helpers, so this drives `run_import` over one
    bundle carrying BOTH failures — a multi-`<Image>` `CYX` morphology image and the generic
    `region_name` — and asks of every field a consumer reads as a vendor fact: is it absent (or
    namespaced), and is the refusal STATED rather than left as a bare absence?

    The morphology image is the constructed OME written over the staged bundle's own
    `morphology_focus` file, so `experiment.xenium`'s pointer is unchanged and the importer reaches
    it by its normal path rather than by a test hook.
    """
    root = _staged(tmp_path, "both-defects", roi_uuid="cccccccc-0000-0000-0000-000000000002")
    focus = root / "morphology_focus" / "morphology_focus_0000.ome.tif"
    assert focus.is_file(), focus
    _write_cyx(focus, _cyx_documents()["two_images"], pages_in_series=2, extra_pages=1)

    meta, report = _imported(tmp_path, root, "both-defects")

    # #320 — the identity field.
    assert meta["section"]["sample_id"].startswith("unverified-sample:"), meta["section"]
    assert report["section"]["sample_id_source"] == "non-identifying-region-name", report["section"]
    assert report["provenance"]["region_name"] == "region", report["provenance"]

    # #319 — the stain field, as it reaches the artifact and the report.
    assert len(report["images"]) == 1, report["images"]
    selection = report["images"][0]["plane_selection"]
    assert selection["axes"] == "CYX", (
        f"the constructed morphology image did not reach the importer's CYX arm: {selection}")
    assert "channel_name" not in selection and "available" not in selection, selection
    assert selection["channel_name_rule"] == "unverified-channel", selection
    assert selection["declared_channels"] == ["DAPI"], selection

    # AND THE PAIRING IS SELF-CONSISTENT: every refusal above carries its own record of WHY, so a
    # reader never has to infer that an absence was deliberate.
    assert set(report["section"]) >= {"sample_id", "sample_id_source"}, report["section"]
    assert "Sample id source" in (root.parent / "both-defects-outs" /
                                  "xenium-import-summary.html").read_text(), (
        "the human-facing report must carry the source beside the value, not only the JSON")


# ── FIX_ROUND-1: the clause the blind design-conformance audit added (ITEM-11) ───────

#: A `<Channel>` in a `<StructuredAnnotations><XMLAnnotation><Value>` block. Legal OME, and how a
#: Bio-Formats-class converter preserves a file's ORIGINAL metadata — so the stain it names is one
#: a converter RETIRED, which `sole_declared_channel`'s own docstring calls "the one name most
#: certainly not this plane's".
_ANNOTATION_CHANNEL = ('<StructuredAnnotations><XMLAnnotation ID="Annotation:0"><Value>'
                       '<Channel ID="Legacy:0" Name="DAPI"/>'
                       '</Value></XMLAnnotation></StructuredAnnotations>')

#: ONE `<Image>`, TWO channels of its own, THREE pages — and one stray annotation channel. The
#: stray tag does two things at once, which is why no earlier fixture could catch it: it RESTORES
#: the count (2 + 1 == 3) so the tag-count clause passes, and it SHIFTS every position so
#: `names[0]` is the retired stain rather than the emitted page's.
_ANNOTATED_CYX = (_OME_HEAD + _ANNOTATION_CHANNEL
                  + _image("Image:0", "Pixels:0", size_c=3, first_ifd=0,
                           channels=_named("Channel:0:0", "18S") + _named("Channel:0:1", "GFP"))
                  + "</OME>")


#: `series_channel_names` with the image-span clause backed out, as a SOURCE mutation.
_PRE_ROUND1_SPAN = (
    '    span = sole_pixels_span(_XML_NOISE_RE.sub(" ", ome_xml or ""))\n'
    '    if not span:\n'
    '        return []\n'
    '    tags = _start_tags(span, "Channel")\n',
    '    xml = _XML_NOISE_RE.sub(" ", ome_xml or "")\n'
    '    if len(_start_tags(xml, "Image")) != 1:\n'
    '        return []\n'
    '    tags = _start_tags(xml, "Channel")\n',
)

#: The `<Pixels>` LEVEL of the span, backed out to round-1's `<Image>` level.
_PRE_ROUND2_PIXELS = (
    '    return _sole_element_span(_sole_element_span(xml, "Image"), "Pixels")\n',
    '    return _sole_element_span(xml, "Image")\n',
)

#: `sole_declared_channel`'s fourth clause, backed out the same way.
_PRE_ROUND1_SOLE = (
    '    if len(_start_tags(sole_pixels_span(xml), "Channel")) != 1:\n'
    '        return ""\n'
    '    return _tag_name(tags[0])\n',
    '    return _tag_name(tags[0])\n',
)


def _shipped_with_the_span_clause_backed_out(*mutations):
    path = XF.PKG / "compute" / "xenium_image.py"
    source = path.read_text()
    for old, new in mutations:
        assert source.count(old) == 1, (
            f"the mutation anchor matched {source.count(old)} times. If it matched ZERO, the most "
            "likely cause is that the image-span clause has been REVERTED out of "
            "`xenium_image.py` — THAT is the regression this test exists for.")
        source = source.replace(old, new)
    module = types.ModuleType("xenium_image_pre_round1")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def test_a_channel_declared_outside_the_image_binds_nothing(tmp_path):
    """TEST-16 (ITEM-11) — the clause the first version of this branch was missing.

    MEASURED on the first version of this fix, on exactly this document:

        {'axes': 'CYX', 'axis': 'C', 'index': 0, 'of': 3, 'rule': 'channel-name-match',
         'channel_name': 'DAPI', 'available': ['DAPI', '18S', 'GFP']}

    while the emitted pixels are page 0, which the image itself declares to be `18S`. That is #319's
    own three false statements, reproduced AFTER #319's fix — because the tag count was read over
    the whole document rather than inside the one `<Image>`.

    The mutation half is what makes this a pin rather than an assertion about today's code: the
    shipped module and the shipped module with the span clause backed out must DISAGREE.
    """
    import xenium_image as XI

    path, planes = _write_cyx(Path(tmp_path) / "annotated.ome.tif", _ANNOTATED_CYX,
                              pages_in_series=3)

    assert XI.series_channel_names(_ANNOTATED_CYX, 3) == [], (
        "a `<Channel>` inside `<StructuredAnnotations>` is not one of this image's channels; "
        "counting it both restores the count and shifts every position")
    # The clause is a SCOPE check, not a blanket refusal: strip the annotation and the same
    # document binds its own two channels against a two-page series.
    two_channel_doc = _ANNOTATED_CYX.replace(_ANNOTATION_CHANNEL, "")
    assert XI.series_channel_names(two_channel_doc, 2) == ["18S", "GFP"]

    plane, shipped = XI.read_plane(path)
    assert "channel_name" not in shipped and "available" not in shipped, shipped
    assert shipped["rule"] == "first-channel", shipped
    assert shipped["channel_name_rule"] == "unverified-channel", shipped
    # The DISCLOSURE list is deliberately the whole document's — it answers "what does the document
    # say", which is a different question from "which of them is this plane's".
    assert shipped["declared_channels"] == ["DAPI", "18S", "GFP"], shipped
    assert np.array_equal(plane, planes[0])

    _old_plane, pre_round1 = _shipped_with_the_span_clause_backed_out(
        _PRE_ROUND1_SPAN).read_plane(path)
    assert pre_round1.get("channel_name") == "DAPI" and pre_round1["rule"] == "channel-name-match", (
        f"the pre-round-1 body did not reproduce the defect ({pre_round1}) — then this fixture "
        "does not discriminate and the comparison below is vacuous")
    assert pre_round1.get("available") == ["DAPI", "18S", "GFP"], pre_round1
    assert shipped.get("channel_name") != pre_round1.get("channel_name"), (
        "the shipped code and the pre-round-1 code name the same channel on a fixture built to "
        "tell them apart")


def test_the_sole_declared_channel_clause_is_scoped_and_STRICTLY_NARROWING():
    """TEST-18 (ITEM-11) — the same hole in #271's own function, and the proof the fix only refuses.

    MEASURED on clean `origin/main` @ 778eddc3: a document whose ONE `<Image>` declares NO channel
    of its own, plus that same annotation `<Channel Name="DAPI"/>`, returned `'DAPI'` — asserted as
    the VERIFIED stain of the emitted plane, with `channel_name_rule: "sole-declared-channel"`.
    Exactly one image, exactly one named channel tag: all three of #271's clauses pass it.

    The second half is the one that makes this safe to ship inside a #319 branch: the new clause is
    an AND on top of the existing three, so for EVERY other document the shipped function and the
    pre-change function must AGREE. A fix to #271's function that changed #271's verdicts would be
    a different change than the one recorded in DEC-11.
    """
    import xenium_image as XI

    pre_change = _shipped_with_the_span_clause_backed_out(_PRE_ROUND1_SOLE)

    hole = (_OME_HEAD + _ANNOTATION_CHANNEL
            + _image("Image:0", "Pixels:0", size_c=1, first_ifd=0, channels="") + "</OME>")
    assert pre_change.sole_declared_channel(hole) == "DAPI", (
        "the pre-change body did not reproduce the defect — then the comparison below is vacuous")
    assert XI.sole_declared_channel(hole) == "", (
        "a converter's RETIRED legacy stain is being declared as this plane's verified channel")

    # STRICTLY NARROWING: same verdict on everything else, including both real vendor documents.
    import tifffile

    others = [
        _OME_HEAD + _image("Image:0", "Pixels:0", size_c=1, first_ifd=0,
                           channels=_named("Channel:0:0", "AlphaSMA/Vimentin")) + "</OME>",
        _OME_HEAD + _image("Image:0", "Pixels:0", size_c=1, first_ifd=0,
                           channels=_unnamed("Channel:0:0")) + "</OME>",
        _ANNOTATED_CYX,
        _ANNOTATED_CYX.replace(_ANNOTATION_CHANNEL, ""),
        "", None,
    ]
    for source in (XF.PRIME / "morphology_focus" / "morphology_focus_0000.ome.tif",
                   XF.PRIME / "morphology.ome.tif",
                   XF.PROTEIN / "morphology_focus" / "ch0000_dapi.ome.tif"):
        with tifffile.TiffFile(str(source)) as handle:
            others.append(handle.ome_metadata or "")

    for document in others:
        assert XI.sole_declared_channel(document) == pre_change.sole_declared_channel(document), (
            "the new clause changed a verdict it was not supposed to reach — it must only ever "
            f"REFUSE more: {document[:120] if document else document!r}")


def test_a_region_name_that_repeats_its_whole_key_is_not_a_sample_either(tmp_path):
    """TEST-19 (ITEM-12) — DEC-12, end to end rather than at the predicate.

    `region_name: "region_name"` identifies exactly as much as `region_name: "region"` — nothing —
    and the first version of the rule answered False for it, which would have put the string
    `"region_name"` in `section.sample_id` with `sample_id_source: "region_name"`: an inference
    occupying the field the whole rule exists to guard.
    """
    root = _staged(tmp_path, "whole-key", region_name="region_name",
                   roi_uuid="dddddddd-0000-0000-0000-000000000003")
    meta, report = _imported(tmp_path, root, "whole-key")
    assert meta["section"]["sample_id"] == \
        f"unverified-sample:{meta['coordinate_space']}", meta["section"]
    assert report["section"]["sample_id_source"] == "non-identifying-region-name", report["section"]
    assert report["provenance"]["region_name"] == "region_name", report["provenance"]


def test_the_unverified_channel_warning_does_not_assert_about_the_document(tmp_path):
    """TEST-20 (ITEM-13) — the disclosure sentence must not itself carry an unverified claim.

    #271's warning said *"nothing in it ties one of them to the plane that was emitted"*. That is a
    statement ABOUT THE DOCUMENT, and it is false for the shape this branch newly routes into that
    warning: a one-`<Image>`, one-`<Channel>` OME whose positional/ID convention does tie that
    channel to channel 0. Refusing is still right — the importer cannot VERIFY the tie against a
    3-page series — but the sentence whose entire purpose is not to assert unverified things must
    not assert one.
    """
    root = _staged(tmp_path, "warning-prose", roi_uuid="ffffffff-0000-0000-0000-000000000004")
    focus = root / "morphology_focus" / "morphology_focus_0000.ome.tif"
    _write_cyx(focus, _cyx_documents()["tag_count"], pages_in_series=3)

    _meta, report = _imported(tmp_path, root, "warning-prose")
    said = [w for w in report["image_warnings"] if "NO STAIN IS DECLARED" in w]
    assert len(said) == 1, report["image_warnings"]
    assert "could not VERIFY which of them" in said[0], said[0]
    assert "nothing in it ties one of them" not in said[0], (
        "the disclosure asserts about the document a thing this importer did not check")
    # The refusal is still SAID, with its evidence — the fix is to the claim, not to the disclosure.
    assert "DAPI" in said[0] and "1 channel(s)" in said[0], said[0]


#: The SOLE-ELEMENT clause, backed out of `_sole_element_span` as a SOURCE mutation — "exactly one"
#: weakened to "at least one", which makes both the `<Image>` and the `<Pixels>` level take the
#: first they find. It lives THERE rather than inline in `series_channel_names`, which is why a
#: blind tests-quality angle could delete the old inline clause and see only ONE unit assertion
#: redden.
_PRE_ROUND1_ONE_IMAGE = (
    '    if len(tags) != 1 or tags[0].group(0).rstrip().endswith("/>"):\n'
    '        return ""\n',
    '    if not tags or tags[0].group(0).rstrip().endswith("/>"):\n'
    '        return ""\n',
)


def test_the_one_image_clause_is_pinned_END_TO_END_and_not_only_as_a_unit(tmp_path):
    """TEST-23 (ITEM-1, ITEM-11) — the headline clause, pinned by the headline fixture.

    A blind tests-quality angle deleted the one-`<Image>` clause and re-ran the whole package
    suite: exactly ONE assertion reddened, a unit call inside TEST-1 that passes `page_count=3`
    specifically to isolate the clause. TEST-2, TEST-4 and TEST-14 — the multi-image fixture's
    end-to-end pins — all stayed green, because that fixture is ALSO refused by the tag-count
    clause and so cannot tell the two apart.

    This drives the real `read_plane` over the multi-image file against a module whose one-image
    clause is weakened to "at least one image", which is what makes the span fall back to the FIRST
    image — and then `Image:0`'s two unnamed channels bind to its two pages, `available` comes back
    as `['', '']`, and the artifact claims a channel list for a series whose channel list the
    document does not establish. The shipped module must not.
    """
    import xenium_image as XI

    path, planes = _cyx_fixture(tmp_path, "two_images")

    _plane, shipped = XI.read_plane(path)
    _old_plane, pre_round1 = _shipped_with_the_span_clause_backed_out(
        _PRE_ROUND1_ONE_IMAGE).read_plane(path)

    assert pre_round1.get("available") == ["", ""], (
        f"the weakened clause did not reproduce the over-claim ({pre_round1}) — then this fixture "
        "does not discriminate and the comparison below is vacuous")
    assert "available" not in shipped, (
        "a two-`<Image>` document establishes no channel list for the emitted series, so there is "
        f"nothing for `available` to be: {shipped}")
    assert shipped.get("available") != pre_round1.get("available")
    assert shipped["channel_name_rule"] == "unverified-channel", shipped


def test_the_filename_leg_still_answers_when_the_OME_binding_does_not(tmp_path):
    """TEST-22 (ITEM-2, ITEM-3) — the outcome the design note calls load-bearing, asserted.

    `docs/design/xenium-declaration-residues.md` §1.3 states that `_channel_index`'s FILENAME leg is
    untouched by #319 and still answers when the OME binding fails, because it reads the file NAME —
    an independent source, and the one that leg exists for (*"a bundle whose `Channel@Name`s a
    converter stripped"*). A blind tests-quality angle found that claim had NO test: every
    failed-binding fixture happened to carry a filename the leg cannot match.

    So the multi-`<Image>` document is written under XOA 4's own naming, `ch0001_dapi.ome.tif`. The
    two facts must BOTH hold, and they are different kinds of fact:

    * the filename verified the INDEX -> `index: 1`, `rule: "filename-match"` (not `first-channel`);
    * the OME verified NO NAME -> no `channel_name`, no `available`, and the refusal disclosed.

    A `filename-match` rule sitting beside an `unverified-channel` disclosure is not a contradiction:
    `rule` describes how the PLANE was selected and `channel_name_rule` describes what the DOCUMENT
    could be read as declaring, which is the separation `declare_channel`'s docstring already draws.
    """
    import xenium_image as XI

    documents = _cyx_documents()
    path, planes = _write_cyx(Path(tmp_path) / "ch0001_dapi.ome.tif", documents["two_images"],
                              pages_in_series=2, extra_pages=1)

    plane, selection = XI.read_plane(path)

    assert selection["rule"] == "filename-match" and selection["index"] == 1, (
        "the filename names channel 0001 and the stain; that is an independent verified source and "
        f"#319 must not have taken it away: {selection}")
    assert np.array_equal(plane, planes[1]), (
        "the filename leg must EMIT the page it declares — declaring index 1 and emitting page 0 "
        "is the defect its own docstring says the branch exists to prevent")
    assert "channel_name" not in selection and "available" not in selection, (
        f"the OME binding failed, so no stain and no channel list may be asserted: {selection}")
    assert selection["channel_name_rule"] == "unverified-channel", selection
    assert selection["declared_channels"] == ["DAPI"], selection


# ── FIX_ROUND-2: the level the round-1 clause was taken at (ITEM-14) ─────────────────

#: THE SAME annotation block, moved ONE LEVEL IN — after `</Pixels>`, still inside `<Image>`.
#: `<Channel>`'s parent in OME is `<Pixels>`, so a scope check taken at `<Image>` leaves exactly
#: this much room, and a blind design-conformance angle walked into it.
def _nested_annotation_cyx(*, channels):
    return (_OME_HEAD
            + '<Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint16" '
            + f'SizeX="{_W}" SizeY="{_H}" SizeC="3" SizeZ="1" SizeT="1">{channels}'
            + '<TiffData IFD="0" PlaneCount="3"/></Pixels>'
            + _ANNOTATION_CHANNEL
            + '</Image></OME>')


def test_a_channel_declared_inside_the_image_but_outside_its_pixels_binds_nothing(tmp_path):
    """TEST-24 (ITEM-14) — the round-1 fix was at the wrong nesting level, and this is the pin.

    Round 1 scoped the channel tags to the single `<Image>`. A blind design-conformance angle moved
    the SAME `<StructuredAnnotations>` block after `</Pixels>` and both defects came back at full
    strength. MEASURED against that round-1 body, on exactly this document:

        {'axes': 'CYX', 'axis': 'C', 'index': 2, 'of': 3, 'rule': 'channel-name-match',
         'channel_name': 'DAPI', 'available': ['18S', 'GFP', 'DAPI']}

    — a converter's RETIRED stain asserted as this plane's, at an index the image declares no
    channel for, with `available` one entry LONGER than the image's own channel list. And the same
    shape with the image declaring no channel of its own made `sole_declared_channel` answer
    `'DAPI'` as a VERIFIED stain, i.e. #271's own defect revived after its round-1 fourth clause.

    The mutation is the round-1 body itself (`<Image>` span instead of `<Pixels>` span), so this
    test reddens the moment anyone takes the scope check back out to the wrong element.
    """
    import xenium_image as XI

    document = _nested_annotation_cyx(
        channels=_named("Channel:0:0", "18S") + _named("Channel:0:1", "GFP"))
    path, planes = _write_cyx(Path(tmp_path) / "nested.ome.tif", document, pages_in_series=3)

    assert XI.series_channel_names(document, 3) == [], (
        "`<Channel>`'s parent is `<Pixels>`, not `<Image>` — an annotation block sitting between "
        "`</Pixels>` and `</Image>` is still not a declaration about this series' channels")

    _plane, shipped = XI.read_plane(path)
    _old_plane, pre_round2 = _shipped_with_the_span_clause_backed_out(
        _PRE_ROUND2_PIXELS).read_plane(path)

    assert (pre_round2.get("channel_name"), pre_round2["index"]) == ("DAPI", 2), (
        f"the round-1 body did not reproduce the defect ({pre_round2}) — then this fixture does "
        "not discriminate and the comparisons below are vacuous")
    assert pre_round2.get("available") == ["18S", "GFP", "DAPI"], pre_round2

    assert "channel_name" not in shipped and "available" not in shipped, shipped
    assert shipped["rule"] == "first-channel" and shipped["index"] == 0, shipped
    assert shipped["channel_name_rule"] == "unverified-channel", shipped
    assert np.array_equal(_plane, planes[0])

    # ... and #271's own function, on the same shape.
    hole = _nested_annotation_cyx(channels="")
    pre_round2_module = _shipped_with_the_span_clause_backed_out(_PRE_ROUND2_PIXELS)
    assert pre_round2_module.sole_declared_channel(hole) == "DAPI", (
        "the round-1 body did not revive #271's defect here — then the assertion below is vacuous")
    assert XI.sole_declared_channel(hole) == "", (
        "a retired legacy stain is being declared as this plane's verified channel again")


@pytest.mark.parametrize("label, document, expected", [
    ("the accepted shape",
     '<OME><Image ID="I"><Pixels ID="P"><Channel Name="DAPI"/></Pixels></Image></OME>',
     '<Channel Name="DAPI"/>'),
    ("namespace prefixes, both ends",
     '<ome:OME><ome:Image ID="I"><ome:Pixels ID="P"><ome:Channel Name="DAPI"/>'
     '</ome:Pixels></ome:Image></ome:OME>', '<ome:Channel Name="DAPI"/>'),
    ("whitespace in the end tags",
     '<OME><Image ID="I"><Pixels ID="P"><Channel Name="DAPI"/></Pixels ></Image\n></OME>',
     '<Channel Name="DAPI"/>'),
    # ── every degenerate shape must fail CLOSED, because both callers read "" as
    # ── "containment could not be established" and then refuse.
    ("two images", '<OME><Image><Pixels><Channel/></Pixels></Image>'
                   '<Image><Pixels><Channel/></Pixels></Image></OME>', ""),
    ("two pixels in one image", '<OME><Image><Pixels><Channel/></Pixels>'
                                '<Pixels><Channel/></Pixels></Image></OME>', ""),
    ("no image at all", '<OME><Plate/></OME>', ""),
    ("no pixels in the image", '<OME><Image ID="I"><Channel Name="DAPI"/></Image></OME>', ""),
    ("self-closing image", '<OME><Image ID="I"/><Pixels><Channel/></Pixels></OME>', ""),
    ("self-closing pixels", '<OME><Image ID="I"><Pixels ID="P"/></Image></OME>', ""),
    ("image never closed", '<OME><Image ID="I"><Pixels ID="P"><Channel/></Pixels></OME>', ""),
    ("pixels never closed", '<OME><Image ID="I"><Pixels ID="P"><Channel/></Image></OME>', ""),
    # ── REFERENCES are not declarations, at either level.
    ("ImageRef is not an Image", '<OME><ImageRef ID="R"/><Image ID="I"><Pixels ID="P">'
                                 '<Channel Name="DAPI"/></Pixels></Image></OME>',
     '<Channel Name="DAPI"/>'),
    ("ImagingEnvironment is not an Image", '<OME><Image ID="I"><Pixels ID="P">'
                                           '<Channel Name="DAPI"/></Pixels>'
                                           '<ImagingEnvironment Temperature="20"/>'
                                           '</Image></OME>', '<Channel Name="DAPI"/>'),
    ("empty and absent", "", ""),
])
def test_the_span_primitive_fails_closed_on_every_degenerate_shape(label, document, expected):
    """TEST-25 (ITEM-14) — `sole_pixels_span` itself, which nothing called directly before.

    A blind design-conformance angle pointed out that the function two audit rounds converged on
    had no direct test: its stated failure modes were verified by hand and asserted nowhere. Every
    row here is a shape the two callers must read as "containment could not be established", and
    the three positive rows are what stop that being satisfied by a function that always says `""`.
    """
    import xenium_image as XI

    assert XI.sole_pixels_span(document).strip() == expected, label


def test_the_rule_never_manufactures_a_collision_across_the_whole_region_name_matrix(tmp_path):
    """TEST-9b [acceptance] (INV-3) — the error-direction rule as an INDEPENDENT probe.

    A blind design-conformance angle found the rewritten TEST-9 sound but REDUNDANT: every mutant
    it killed, TEST-8 killed too, so INV-3 had an acceptance test that was a restatement of INV-4's
    rather than a probe of the missed-vs-false-collision rule itself.

    INV-3 is a rule about DIRECTION, so this asserts the direction over a matrix rather than a pair.
    Six `region_name` values, two unrelated bundles each (distinct `roi_uuid`s), and one law:

        two bundles share a `sample_id` IF AND ONLY IF they share an IDENTIFYING region name.

    The "only if" half is the FALSE collisions this branch removes. The "if" half is the direction
    it must not overshoot — a rule that namespaced everything would satisfy "no false collision"
    perfectly and destroy every real grouping, and no assertion in TEST-8 or TEST-9 refuses that on
    its own. Both halves are checked on the same run, over the same code path.
    """
    identifying = {"hKidney_sample", "region_7", "donor-04-blockA"}
    values = ["region", "Region", "region_name", "hKidney_sample", "region_7", "donor-04-blockA"]

    ids = {}
    for v, value in enumerate(values):
        pair = []
        for r, suffix in enumerate(("a", "b")):
            # DISTINCT roi_uuids in every cell — the runs are UNRELATED, which is the whole
            # premise. A shared uuid here would make the two bundles one experiment and the
            # matrix would be asserting nothing.
            name = f"matrix-{v}-{suffix}"
            root = _staged(tmp_path, name, region_name=value,
                           roi_uuid=f"0a0a0a0a-0000-0000-0000-{v:08d}{r:04d}")
            meta, _report = _imported(tmp_path, root, name)
            pair.append(meta["section"]["sample_id"])
        assert pair[0] != "" and pair[1] != ""
        ids[value] = pair

    for value, (first, second) in ids.items():
        if value in identifying:
            assert first == second == value, (
                f"{value!r} IDENTIFIES a region, so two sections of it must group under one sample "
                f"id — a rule that namespaced everything would pass every no-collision assertion "
                f"and destroy this: {first!r} vs {second!r}")
        else:
            assert first != second, (
                f"{value!r} identifies nothing, so two unrelated runs must not share a sample id: "
                f"both got {first!r}")
            assert first.startswith("unverified-sample:"), first

    # ACROSS values, too: no non-identifying value may collide with any other bundle at all.
    non_identifying_ids = [i for v, pair in ids.items() if v not in identifying for i in pair]
    assert len(set(non_identifying_ids)) == len(non_identifying_ids), (
        f"two bundles with DIFFERENT non-identifying region names still collided: "
        f"{sorted(non_identifying_ids)}")


def test_the_residue_this_branch_did_NOT_fix_is_measured_here_and_not_only_described(tmp_path):
    """TEST-26 (ITEM-15) — INVERTED at #323 [TEST-4 [acceptance] (INV-4) of `coordinate-space-identity`].

    ## What this test was

    An earlier draft of the design note said *"INV-4 is upheld for the field this branch owns"*, and
    `section_sample_id`'s inline comment said two unrelated runs *"cannot"* declare themselves
    sections of one sample. Two blind angles measured otherwise, both sentences were corrected, and
    because a corrected sentence is worth nothing on its own the three shapes were DRIVEN here: in
    every row two unrelated bundles ended up as *section 0 of one sample*, and in every row the
    cause was `coordinate_space_id` — filed as **#323**.

    ## What it asserts now

    #323 landed. `section_sample_id`'s leg STRUCTURE is what #320 shipped — its two additions since (a
    `region_name` may not forge the `unverified-sample:` prefix, and it must be a STRING) apply
    #323's own rules to the twin identity field and are recorded at DEC-15/DEC-17; what changed for
    the rows below is
    the half it INHERITS, which is exactly what this test was written to measure. So the same three
    shapes are still driven end to end through `run_import`, and each now asserts that two unrelated
    bundles get a DIFFERENT `coordinate_space` **and** a DIFFERENT `section.sample_id`, with
    `section.index` and `sample_id_source` unchanged — INV-4 upheld on every shape #320 recorded it
    AT-RISK for, rather than "for the field this branch owns". **Not OUTRIGHT**: #328 is a fourth
    shape #323's own audit found and did not close, so the compute, the design note and
    DESIGN_FIDELITY all say AT-RISK, and a blind angle found this docstring still saying otherwise
    after all three had been corrected.

    Two things keep the inversion honest:

    * the runs are made unrelated in the MATRIX (`XF.restage_cell_ids`), not only in
      `experiment.xenium`. Two staged copies of one fixture are the same measurement, and after
      #323 they correctly share a frame — asserting a collision there would be asserting something
      true, and the last row does exactly that as its own control.
    * the design note must still NAME each of the three before-values, so the residue cannot be
      quietly dropped from the record on the way to claiming it fixed.
    """
    rows = []

    # (1) a placeholder ROI uuid — rung 1 used to answer it RAW, so both runs got `xenium:unknown`.
    rows.append(("roi_uuid='unknown'", "xenium:unknown", "non-identifying-region-name",
                 {"roi_uuid": "unknown"}))
    # (2) the shipped prime shape with no ROI uuid — rung 2 used to answer `xenium:slide_region`.
    rows.append(("prime-shaped, no roi_uuid", "xenium:slide_region",
                 "non-identifying-region-name", {"roi_uuid": None}))
    # (3) nothing stated — rung 3 used to answer the sandbox SLOT name, `xenium:bundle`, for every
    #     import in the deployment.
    rows.append(("nothing stated, slot-mounted", "xenium:bundle",
                 "no-vendor-sample-statement",
                 {"roi_uuid": None, "slide_id": None, "region_name": None}))

    note = (XF.PKG.parents[2] / "docs" / "design" / "xenium-declaration-residues.md").read_text()

    for label, before_space, expected_source, overrides in rows:
        ids, spaces = [], []
        for n, suffix in enumerate(("-runA", "-runB")):
            name = f"{label[:6]}-{n}"
            # BOTH mounted under the same basename, which is what the removed rung read.
            parent = tmp_path / f"mount-{label[:6]}-{n}"
            parent.mkdir()
            root = XF.stage_bundle(parent, name="bundle")
            path = root / "experiment.xenium"
            doc = json.loads(path.read_text())
            for key, value in overrides.items():
                if value is None:
                    doc.pop(key, None)
                else:
                    doc[key] = value
            path.write_text(json.dumps(doc))
            XF.restage_cell_ids(root, suffix)

            meta, report = _imported(tmp_path, root, name)
            ids.append(meta["section"]["sample_id"])
            spaces.append(meta["coordinate_space"])
            assert meta["section"]["index"] == 0, meta["section"]
            assert report["section"]["sample_id_source"] == expected_source, (
                label, report["section"])

        assert spaces[0] != spaces[1], (
            f"#323 has REGRESSED for {label!r}: two unrelated bundles share one coordinate frame "
            f"again, both {spaces[0]!r} (it used to be {before_space!r})")
        assert ids[0] != ids[1], (
            f"{label!r}: two unrelated bundles are declared sections of ONE sample again — INV-4. "
            f"Both {ids[0]!r}")
        assert all(i.startswith("unverified-sample:") for i in ids), ids
        assert all(s != before_space for s in spaces), (label, spaces)
        # THE DESIGN NOTE MUST STILL NAME THIS ROW. §3.6 tabulates each before-value against what
        # replaced it; a note that stops naming them has dropped the record of what was fixed.
        assert f"`{before_space}`" in note, (
            f"design §3.6 no longer names the {label!r} residue ({before_space}) — the before/after "
            "table is the record that these three shapes were real, and it is what makes the "
            "inversion above legible to the next reader")

    assert "INV-4 is upheld for the field this branch owns" not in note, (
        "that sentence was the UNDERSTATEMENT #320 had to make — the three shapes below are closed "
        "now, so it must not come back as a description of this behaviour")
    # ...AND THE OVERSTATEMENT MUST NOT COME BACK EITHER. A blind angle found this test still
    # asserting "INV-4 is upheld OUTRIGHT" after the compute and the design note had both been
    # corrected to say the opposite — #328 is a fourth shape and it is open. A guard that refuses
    # only the understatement leaves the tree free to drift the other way.
    assert "#328" in note, (
        "the design note must keep naming #328 beside INV-4; without it a reader takes the three "
        "shapes closed here for the whole invariant")

    # THE CONTROL, and it is the half that stops the three rows above passing for the wrong reason:
    # two bundles that are the SAME MEASUREMENT must still share a frame. A ladder that minted a
    # fresh id per CALL would satisfy every distinctness assertion above and destroy the one
    # property `coordinate_space`'s design names as its whole mechanism — *"the only thing that
    # makes two imports of ONE slide collide correctly"*.
    same = []
    for n in (0, 1):
        parent = tmp_path / f"same-{n}"
        parent.mkdir()
        root = XF.stage_bundle(parent, name="bundle")
        path = root / "experiment.xenium"
        doc = json.loads(path.read_text())
        for key in ("roi_uuid", "slide_id", "region_name"):
            doc.pop(key, None)
        path.write_text(json.dumps(doc))
        meta, _report = _imported(tmp_path, root, f"same-{n}")
        same.append(meta["coordinate_space"])
    assert same[0] == same[1], (
        "two imports of the SAME bundle must be ONE coordinate frame — a per-call minted id would "
        f"pass every assertion above and break this: {same}")
