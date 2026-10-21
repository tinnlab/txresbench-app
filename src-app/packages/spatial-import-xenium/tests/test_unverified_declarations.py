#!/usr/bin/env python3
# ruff: noqa
"""An INFERENCE must never occupy a field a consumer reads as a vendor fact (#270, #271).

Two issues, one defect shape, and the tests are built around the one property that
distinguishes a fix from a relabelling: **every assertion here goes RED if the inference comes
back.** The pre-change bodies are kept, executed, and compared against the shipped code on the
one input that tells them apart (`test_..._mutants_...` at the bottom) — so a revert does not
merely fail to improve anything, it makes two artifacts agree that must not agree.

## The fixtures, and why they are shaped this way

The two REAL bundles cannot exercise either defect: both `experiment.xenium` files state a
`region_name`, and both the `YX` and `ZYX` morphology documents declare exactly one `<Image>`
with exactly one named `<Channel>`. That is the whole reason both defects were LATENT — and it
is why the shipped suite stayed green over them. So the fixtures here are the real vendor
PIXELS with a rewritten OME document, and the real vendor `experiment.xenium` with one key
removed: the only variable between a case and its control is the thing under test.
"""
import json
import re
import shutil
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

XF.load_compute()  # installs the vendored helpers under their bare names


# ── OME documents, hand-written so the declaration under test is the variable ─────────
#
# `tifffile` is asked to write OUR description and NOT its own `shaped` sidecar
# (`metadata=None`). Without that the shaped series wins over the OME one and the axes come
# back as `QYX`, which `read_plane` refuses before reaching any branch this file is about —
# a fixture that tests the refusal instead of the selection. Measured, not assumed.
_OME_HEAD = ('<?xml version="1.0" encoding="UTF-8"?>'
             '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">')


def _image_element(image_id, pixels_id, *, size_z, first_ifd, channel):
    """One `<Image>`; `channel` is the raw `<Channel .../>` XML or `""` for none at all."""
    return (f'<Image ID="{image_id}"><Pixels ID="{pixels_id}" DimensionOrder="XYCZT" '
            f'Type="uint16" SizeX="{_W}" SizeY="{_H}" SizeC="1" SizeZ="{size_z}" SizeT="1">'
            f'{channel}<TiffData IFD="{first_ifd}" PlaneCount="{size_z}"/></Pixels></Image>')


def _named(channel_id, name):
    return f'<Channel ID="{channel_id}" Name="{name}" SamplesPerPixel="1"/>'


def _unnamed(channel_id):
    return f'<Channel ID="{channel_id}" SamplesPerPixel="1"/>'


#: The emitted plane's own grid. Small enough to write in a test, real enough to import.
_H, _W = 352, 578

#: The five documents, each named for the QUESTION it puts to the importer — and each shaped
#: so that exactly ONE clause of `sole_declared_channel` can refuse it. That is not tidiness:
#: the first version of this table had `foreign` carry an unnamed `<Channel>` on `Image:0`,
#: which the CHANNEL clause already refuses, and a mutation battery then showed BOTH the
#: `<Image>` clause and the `<Channel>` clause could be deleted with the whole suite still
#: green. A clause whose only fixture another clause already catches is unpinned.
#:
#: | document | images | channel tags | names | the ONLY clause that refuses it |
#: |---|---|---|---|---|
#: | `sole`    | 1 | 1 | 1 | none — this is the verified shape both real bundles have |
#: | `multi`   | 2 | 2 | 2 | #271's literal case (several clauses; it is the ISSUE's case) |
#: | `foreign` | 2 | 1 | 1 | the `<Image>` clause — the one name belongs to the OTHER image |
#: | `stale`   | 1 | 2 | 1 | the `<Channel>` clause — the one name is channel 1's, not channel 0's |
#: | `literal` | 1 | 2 | 2 | the `<Channel>` clause — #271's own shape, and the only fixture whose FIRST tag is named |
#: | `unnamed` | 1 | 1 | 0 | the `Name` clause — nothing was claimed |
def _documents(size_z):
    other = _image_element("Image:1", "Pixels:1", size_z=1, first_ifd=size_z,
                           channel=_named("Channel:1:0", "DAPI"))
    return {
        "sole": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0,
            channel=_named("Channel:0:0", "AlphaSMA/Vimentin")) + "</OME>",
        "multi": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0,
            channel=_named("Channel:0:0", "AlphaSMA/Vimentin")) + other + "</OME>",
        # NO `<Channel>` on the emitted image at all — legal OME (`Channel` is minOccurs=0)
        # and the only way the whole document can carry exactly one name that is not this
        # plane's.
        "foreign": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0, channel="") + other + "</OME>",
        # ONE image, TWO channel elements, only the SECOND named — so the document holds
        # exactly one name and it belongs to channel 1 while the emitted plane is channel 0's.
        "stale": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0,
            channel=_unnamed("Channel:0:0") + _named("Channel:0:1", "DAPI")) + "</OME>",
        # #271's LITERAL shape: ONE `<Image>` declaring SEVERAL named channels. Its `SizeC` says
        # 1 and it carries two `<Channel>` elements, which is an internally inconsistent
        # document — and that is the point: `tags[0]` IS named here, so a rule that refuses only
        # an EMPTY tag list would answer `DAPI` for a plane whose channel the document
        # contradicts itself about. `stale` cannot pin that (its first tag is unnamed, so the
        # `Name` clause catches it first) — measured: without this fixture the tag-count clause
        # survived a mutation battery.
        "literal": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0,
            channel=_named("Channel:0:0", "DAPI") + _named("Channel:0:1", "18S")) + "</OME>",
        "unnamed": _OME_HEAD + _image_element(
            "Image:0", "Pixels:0", size_z=size_z, first_ifd=0,
            channel=_unnamed("Channel:0:0")) + "</OME>",
    }


def _vendor_planes(count):
    """`count` planes of REAL vendor pixels, cropped — never synthesised noise."""
    import tifffile

    source = XF.PRIME / "morphology.ome.tif"
    with tifffile.TiffFile(str(source)) as handle:
        pages = handle.series[0].pages
        planes = [pages[i % len(pages)].asarray()[:_H, :_W] for i in range(count)]
    return np.stack(planes) if count > 1 else planes[0]


def _write_ome(path, document, *, size_z):
    """The pixels + `document`, plus one extra IFD when the document declares a second image."""
    import tifffile

    data = _vendor_planes(size_z)
    with tifffile.TiffWriter(str(path)) as writer:
        writer.write(data, photometric="minisblack", description=document, metadata=None)
        if '<Image ID="Image:1"' in document:
            writer.write(np.zeros((_H, _W), np.uint16), photometric="minisblack",
                         metadata=None)
    return path


@pytest.fixture(scope="module")
def documents():
    return {"ZYX": _documents(3), "YX": _documents(1)}


def _selection(tmp_path, shape, which, documents):
    xenium_image = sys.modules["xenium_image"]
    size_z = 3 if shape == "ZYX" else 1
    path = _write_ome(Path(tmp_path) / f"{shape}-{which}.ome.tif",
                      documents[shape][which], size_z=size_z)
    _plane, selection = xenium_image.read_plane(path)
    assert selection["axes"] == shape, (
        f"the {which!r} fixture came back as {selection['axes']!r}, not {shape!r} — it is "
        "exercising a different branch than the one this test is about")
    return selection


# ── #271 ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("shape", ["ZYX", "YX"])
def test_a_multi_channel_document_never_labels_the_plane_with_channel_zero(
        shape, tmp_path, documents):
    """TEST-1 [acceptance] (INV-1) — a multi-channel document, on both branches.

    The document declares two channels; the emitted plane is one plane of one of them and
    nothing in a whole-document regex says which. The old body wrote `names[0]` here, so the
    artifact asserted a stain it had not verified — and for `ZYX` that string reached a human
    in the HTML report.

    Stated precisely: #271's own example is ONE `<Image>` with several named `<Channel>`s,
    while this fixture puts them in two images. The shipped code answers both identically
    (several clauses refuse it), so this test proves the ISSUE's behaviour — but it is not the
    fixture that pins any single clause, which is what TEST-2 exists for.

    The CONTROL is in this test, not only in a sibling: the same pixels under a document that
    declares ONE image and ONE channel must still be named, or "no channel name" would be
    satisfied by a change that simply stopped naming anything.
    """
    refused = _selection(tmp_path, shape, "multi", documents)
    assert "channel_name" not in refused, (
        "a document declaring two channels cannot say which one this plane is, so naming one "
        f"is an assertion the importer did not verify. Got {refused.get('channel_name')!r}")
    assert refused["channel_name_rule"] == "unverified-channel", (
        f"the refusal must be STATED, not left as an absence: {refused}")
    assert refused["declared_channels"] == ["AlphaSMA/Vimentin", "DAPI"], (
        "what the document DOES say is the evidence for the refusal and travels with it; "
        f"got {refused.get('declared_channels')!r}")

    verified = _selection(tmp_path, shape, "sole", documents)
    assert verified["channel_name"] == "AlphaSMA/Vimentin", (
        "the CONTROL lost its channel name too, so the assertion above proves nothing about "
        f"verification — it would pass with all naming deleted. Got {verified}")
    assert verified["channel_name_rule"] == "sole-declared-channel", verified


@pytest.mark.parametrize("shape", ["ZYX", "YX"])
@pytest.mark.parametrize("which,clause", [("foreign", "<Image> count"),
                                          ("stale", "<Channel> tag count"),
                                          ("literal", "<Channel> tag count")])
def test_one_name_in_the_document_is_not_the_same_as_this_planes_name(
        shape, which, clause, tmp_path, documents):
    """TEST-2 [acceptance] (INV-1) — the two clauses a NAME COUNT alone cannot carry.

    `Channel@Name` is optional in OME, so "the document declares exactly one name" is true of
    documents where that name is emphatically not the emitted plane's:

    * `foreign` — the emitted image declares NO channel and a second image declares `DAPI`.
      Only counting `<Image>` catches it.
    * `stale` — ONE image with TWO channel elements, of which only the second is named. So
      `names[0]` is channel 1's name and the emitted plane is channel 0's pixels: a converter
      that dropped a name, or left a stale one, produces exactly this. Only counting
      `<Channel>` START TAGS catches it.

    Both clauses SURVIVED the first mutation battery on this branch — deletable with the whole
    suite green — because the original fixture for the first one was also refused by the
    second. These are the fixtures that make each clause a guard rather than decoration.
    """
    selection = _selection(tmp_path, shape, which, documents)
    assert "channel_name" not in selection, (
        f"the {clause} clause did not refuse the {which!r} document: the one name it declares "
        f"is not the emitted plane's, and the artifact says {selection.get('channel_name')!r}")
    assert selection["channel_name_rule"] == "unverified-channel", selection
    assert selection["declared_channels"] == (["DAPI", "18S"] if which == "literal"
                                              else ["DAPI"]), selection


@pytest.mark.parametrize("shape", ["ZYX", "YX"])
def test_a_document_that_names_no_channel_makes_no_claim_and_no_refusal(
        shape, tmp_path, documents):
    """TEST-3 (INV-1) — absence stays absence.

    Nothing was claimed, so there is nothing to refuse: no `channel_name`, and no
    `channel_name_rule` either. A refusal recorded here would be the importer reporting on a
    question the document never asked.
    """
    selection = _selection(tmp_path, shape, "unnamed", documents)
    assert "channel_name" not in selection, selection
    assert "channel_name_rule" not in selection, selection
    assert "declared_channels" not in selection, selection


def test_the_rule_is_measured_against_the_REAL_vendor_documents_too():
    """TEST-4 (INV-1) — the shipped fixtures, so "verified" is not only a synthetic shape.

    Both real morphology documents declare one image and one named channel, which is exactly
    why #271 was latent. Asserted here so a vendor file that changes shape — or a rule that
    quietly stops accepting the real ones — is visible as a failure rather than as a silently
    unnamed image.
    """
    import tifffile

    xenium_image = sys.modules["xenium_image"]
    for rel in ("morphology.ome.tif", "morphology_focus/morphology_focus_0000.ome.tif"):
        with tifffile.TiffFile(str(XF.PRIME / rel)) as handle:
            xml = handle.ome_metadata or ""
        assert xenium_image.sole_declared_channel(xml) == "DAPI", (
            f"{rel} is a one-image/one-channel document and its DAPI declaration is "
            "verifiable; refusing it would drop a name the vendor really did state")
    assert xenium_image.sole_declared_channel("") == ""
    assert xenium_image.sole_declared_channel(None) == ""


#: Documents a blind correctness audit built to break the rule, with the answer each MUST get.
#: Every one of the first four produced a WRONG STAIN or a FALSE "nothing was claimed" against
#: the first implementation; they are kept as the record of what the counting must not see.
_HOSTILE_DOCUMENTS = {
    # A `<ChannelRef Name=...>` inside an ROI label is a REFERENCE, not a declaration — and
    # the emitted image's own channel is unnamed. Emitting `DAPI` here reads a stain off an
    # annotation.
    "a ChannelRef in an ROI": (
        '<OME><Image ID="Image:0"><Pixels ID="P:0" SizeC="1"><Channel ID="C:0"/>'
        '<TiffData/></Pixels></Image>'
        '<ROI ID="ROI:0"><Union><Label><ChannelRef ID="C:9" Name="DAPI"/></Label></Union>'
        '</ROI></OME>', "", []),
    # An extension attribute that merely ENDS in `Name` is not `Name`.
    "an attribute ending in Name": (
        '<OME><Image ID="Image:0"><Pixels ID="P:0" SizeC="1">'
        '<Channel ID="C:0" FluorName="GFP"/><TiffData/></Pixels></Image></OME>', "", []),
    # A commented-out channel is a stain a converter DISABLED.
    "a commented-out channel": (
        '<OME><!-- <Channel ID="C:0" Name="OldStain"/> -->'
        '<Image ID="Image:0"><Pixels ID="P:0" SizeC="1"><TiffData/></Pixels></Image></OME>',
        "", []),
    # CDATA is text, not markup.
    "a channel named inside CDATA": (
        '<OME><StructuredAnnotations><XMLAnnotation><Value><![CDATA['
        '<Channel ID="C:0" Name="OldStain"/>]]></Value></XMLAnnotation></StructuredAnnotations>'
        '<Image ID="Image:0"><Pixels ID="P:0" SizeC="1"><TiffData/></Pixels></Image></OME>',
        "", []),
    # A comment that MENTIONS `<Image ` must not inflate the image count and refuse a name the
    # document really does verify — the false-refusal direction of the same defect.
    "a comment mentioning <Image": (
        '<OME><!-- rewritten from <Image ID="Image:7"> by a converter -->'
        '<Image ID="Image:0"><Pixels ID="P:0" SizeC="1"><Channel ID="C:0" Name="DAPI"/>'
        '<TiffData/></Pixels></Image></OME>', "DAPI", ["DAPI"]),
    # Single quotes are XML's other legal attribute delimiter. Reading this as "the document
    # names no channel at all" is a false statement made INTO the artifact.
    "single-quoted attributes": (
        "<OME><Image ID='Image:0'><Pixels ID='P:0' SizeC='1'><Channel ID='C:0' Name='DAPI'/>"
        "<TiffData/></Pixels></Image></OME>", "DAPI", ["DAPI"]),
    # A namespace prefix is a serialization choice, not a different element.
    "namespace-prefixed elements": (
        '<ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<ome:Image ID="Image:0"><ome:Pixels ID="P:0" SizeC="1">'
        '<ome:Channel ID="C:0" Name="DAPI"/><ome:TiffData/></ome:Pixels></ome:Image>'
        '</ome:OME>', "DAPI", ["DAPI"]),
    # `&amp;` is the XML spelling of `&`. Undecoded, the artifact carries the literal
    # `CD3 &amp; CD4` and `render_report_html` escapes it a SECOND time, so the human reads
    # `CD3 &amp;amp; CD4` in the "one plane was emitted" warning.
    "an entity in the name": (
        '<OME><Image ID="Image:0"><Pixels ID="P:0" SizeC="1">'
        '<Channel ID="C:0" Name="CD3 &amp; CD4"/><TiffData/></Pixels></Image></OME>',
        "CD3 & CD4", ["CD3 & CD4"]),
}


@pytest.mark.parametrize("case", sorted(_HOSTILE_DOCUMENTS), ids=sorted(_HOSTILE_DOCUMENTS))
def test_the_counting_sees_declarations_and_not_text_that_looks_like_one(case):
    """TEST-14 [acceptance] (INV-1) — the documents a blind audit used to break the rule.

    Four of these produced a WRONG STAIN against the first implementation — a name lifted from
    an ROI reference, from an extension attribute, from a commented-out element, from CDATA —
    and three produced the opposite error, reporting "this document names no channel at all"
    about a document that names one (single quotes, a namespace prefix) or refusing a verified
    name because a COMMENT mentioned `<Image `.

    Both directions matter and they are asserted together: `expected_sole` is what the
    verification must answer, and `expected_declared` is what the DISCLOSURE must list, so a
    fix that silenced one channel while leaving the other lying would still fail.
    """
    xenium_image = sys.modules["xenium_image"]
    document, expected_sole, expected_declared = _HOSTILE_DOCUMENTS[case]

    assert xenium_image.sole_declared_channel(document) == expected_sole, (
        f"{case}: verification answered "
        f"{xenium_image.sole_declared_channel(document)!r}, expected {expected_sole!r}")
    assert xenium_image.declared_channel_names(document) == expected_declared, (
        f"{case}: the disclosure list is "
        f"{xenium_image.declared_channel_names(document)!r}, expected {expected_declared!r}")

    selection = xenium_image.declare_channel({"axes": "YX"}, document)
    if expected_sole:
        assert selection["channel_name"] == expected_sole, selection
        assert selection["channel_name_rule"] == "sole-declared-channel", selection
    else:
        assert "channel_name" not in selection, selection
        # And outcome 2 vs outcome 3 must agree with the disclosure list: a document that
        # named nothing gets no rule at all, one that named something gets the refusal.
        assert ("channel_name_rule" in selection) == bool(expected_declared), selection


def _stage_zyx_bundle(tmp_path, name, which, documents):
    """The prime bundle with `morphology_focus/` gone and `morphology.ome.tif` rewritten.

    Removing the focus directory is what makes the importer follow `experiment.xenium`'s
    second image pointer — the same fall-back `test_spatial_image.zyx_fallback` uses, so the
    `ZYX` branch is reached through the REAL entry point and not by calling `read_plane`.
    """
    root = XF.stage_bundle(tmp_path, name=name)
    shutil.rmtree(root / "morphology_focus")
    _write_ome(root / "morphology.ome.tif", documents["ZYX"][which], size_z=3)
    return root


def test_the_HTML_report_says_exactly_what_the_ARTIFACT_says(tmp_path, documents):
    """TEST-5 [acceptance] (INV-1) — end to end, through `run_import`, into the page.

    The `ZYX` half of #271 is the stronger one because the string does not stop at the
    manifest: it is rendered into the user-facing "one plane was emitted" warning as the
    parenthetical stain. So both channels are checked in one test — what the artifact
    declares, and what the human is told — and they must agree in BOTH directions:

    * unverified -> no `channel_name` in `plane_selection` AND no parenthetical in the warning;
    * verified   -> the name in `plane_selection` AND the same name in the parenthetical.

    The second half is the control that makes the first mean something: a warning with the
    parenthetical removed altogether would satisfy "no stain in the report" for the wrong
    reason.
    """
    cases = {}
    for which in ("multi", "sole"):
        root = _stage_zyx_bundle(tmp_path, f"report-{which}", which, documents)
        out = tmp_path / f"report-{which}-outs"
        _module, entries = XF.run_over(root, out)
        report = json.loads((out / "xenium-import-report.json").read_text())
        cases[which] = (XF.entry(entries, "spatial-image-morphology")["meta"], report)

    unverified_meta, unverified_report = cases["multi"]
    verified_meta, verified_report = cases["sole"]

    assert "channel_name" not in unverified_meta["plane_selection"], (
        f"the artifact still asserts a stain: {unverified_meta['plane_selection']}")
    assert verified_meta["plane_selection"]["channel_name"] == "AlphaSMA/Vimentin", (
        "the CONTROL bundle lost its name, so this test would pass with all naming removed")

    def _plane_warning(report):
        hits = [w for w in report["image_warnings"] if "ONE was emitted" in w]
        assert len(hits) == 1, (
            f"expected exactly one 'one plane was emitted' warning, got {report['image_warnings']}")
        return hits[0]

    unverified_warning = _plane_warning(unverified_report)
    verified_warning = _plane_warning(verified_report)
    assert "AlphaSMA/Vimentin" not in unverified_warning and "DAPI" not in unverified_warning, (
        "the human is told a stain the artifact refused to declare — the report and the "
        f"artifact must say the same thing. Got: {unverified_warning!r}")
    assert "(AlphaSMA/Vimentin)" in verified_warning, (
        "the verified case must still name the stain in the page, or 'no stain in the "
        f"unverified page' is satisfied by the parenthetical never rendering. Got: "
        f"{verified_warning!r}")

    # AND THE REFUSAL IS SAID, not merely absent. A parenthetical that silently vanishes
    # leaves the reader unable to tell "this importer declines to say" from "this image has
    # no channel" — and #271's title is that this reaches the HTML report, so the report is
    # where the refusal has to land. Asserted in BOTH directions again: the verified run must
    # NOT carry the refusal note.
    def _refusal(report):
        return [w for w in report["image_warnings"] if "NO STAIN IS DECLARED" in w]

    refusals = _refusal(unverified_report)
    assert len(refusals) == 1, (
        "the page never tells the reader a stain was declared and refused; the only record is "
        f"`channel_name_rule`, which is a note only a machine reads. Got: "
        f"{unverified_report['image_warnings']}")
    assert "AlphaSMA/Vimentin" in refusals[0] and "DAPI" in refusals[0], (
        "the refusal must carry its evidence — WHICH channels the document does name — or a "
        f"reader cannot act on it. Got: {refusals[0]!r}")
    assert not _refusal(verified_report), (
        "the verified run must not claim a refusal it did not make: "
        f"{verified_report['image_warnings']}")

    page = (tmp_path / "report-multi-outs" / "xenium-import-summary.html").read_text()
    assert "NO STAIN IS DECLARED" in page, (
        "the refusal reached the JSON and not the page a human opens")


# ── #270 ─────────────────────────────────────────────────────────────────────────────

def _experiment_without(root, *keys):
    path = Path(root) / "experiment.xenium"
    doc = json.loads(path.read_text())
    for key in keys:
        doc.pop(key, None)
    path.write_text(json.dumps(doc))
    return doc


def test_section_sample_id_returns_the_vendor_statement_or_a_disclosed_non_claim():
    """TEST-6 [acceptance] (INV-3) — the derivation, as a `(value, source)` pair.

    §12.3's rule is *"derive it from the vendor's own … rather than minting one"*. Leg 1 is a
    string the vendor wrote and is emitted bare. There is no leg 2 and no leg 3 any more: with
    no vendor sample statement the value is namespaced so that no consumer can read it as one,
    and the source says so in machine form.
    """
    module = XF.load_compute()
    space = "xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"

    stated = module.section_sample_id({"region_name": "hKidney_sample",
                                       "slide_id": "Slide_1"}, space)
    assert stated == ("hKidney_sample", "region_name"), stated

    value, source = module.section_sample_id({"slide_id": "Slide_1"}, space)
    assert source == "no-vendor-sample-statement", source
    assert value != "Slide_1", (
        "the slide id is a SLIDE — one slide carries several regions — so grouping on it "
        "declares two unrelated tissues to be sections of one sample")
    assert value == f"{module.UNVERIFIED_SAMPLE_PREFIX}{space}", value

    # SAID PLAINLY, because the prefix is doing ALL the work here and a reader of this test
    # should not be left thinking otherwise: the coordinate-space id is still INSIDE the value.
    # What changed is that it is no longer readable as a vendor sample statement, and that a
    # consumer grouping on this field can tell. (That id's own last leg WAS the upload
    # directory's basename when this comment was written; #323 replaced it with a value derived
    # from the run's own measurement, so what the prefix now wraps is no longer an accident of
    # how the bundle was mounted.) Removing it is not an option: `section()` requires a non-empty string
    # (#318), and a constant would collide every unstated bundle into one sample.
    directory_space = "xenium:my-download-folder"
    unstated, _src = module.section_sample_id({}, directory_space)
    assert directory_space in unstated, (
        "the space id is expected to remain in the value — it is what keeps two unstated "
        "bundles from colliding; if this changed, DEC-1's reasoning needs revisiting")
    assert unstated.startswith(module.UNVERIFIED_SAMPLE_PREFIX), unstated
    assert unstated != directory_space, (
        "and it must not be READABLE as one: the namespace is the entire discriminator")

    # A vendor writing a number or `null` must not raise out of a declaration builder — the
    # reason this leg reaches for `_text` rather than `or ""`.
    assert module.section_sample_id({"region_name": None}, space)[1] == \
        "no-vendor-sample-statement"

    # INVERTED AT #323, NOT DELETED, and this is the one #270/#271 row whose ANSWER moved.
    # It asserted `({"region_name": 7}, space) == ("7", "region_name")` — a JSON number emitted
    # VERBATIM as the vendor's sample identity. #323's DEC-15 establishes why that cannot stand:
    # both identity predicates are structurally blind to a non-string (`_VENDOR_PLACEHOLDERS` is a
    # string vocabulary and `non_identifying_vendor_label` returns False for a non-string), so a
    # number is an UNFILTERABLE identity. MEASURED end to end by a blind angle: two unrelated runs
    # stating `region_name: 0`, correctly given DIFFERENT coordinate frames by #323, both declared
    # themselves *section 0 of sample "0"* — the FALSE collision this file exists to remove.
    #
    # WHAT THIS ROW IS FOR IS KEPT: it still asserts that a number does not RAISE out of a
    # declaration builder (the original point, and the reason `_text` is here), and that the
    # operator's own value is not lost — the number is still recorded in the provenance block and
    # the report says WHY it was not used as an identity. Only the claim that it IS the vendor's
    # sample statement is gone, and the missed collision that buys is recoverable by quoting it.
    assert module.section_sample_id({"region_name": 7}, space) == \
        (f"{module.UNVERIFIED_SAMPLE_PREFIX}{space}", "non-identifying-region-name")
    assert module.section_sample_id({"region_name": "7"}, space) == ("7", "region_name"), (
        "a QUOTED number is a string the vendor wrote and must still be the sample id — otherwise "
        "the rule is about digits rather than about types, and every numeric-looking real sample "
        "name would be refused")


@pytest.mark.parametrize("placeholder", ["", "   ", "n/a", "N/A", "na", "unknown", "UNKNOWN",
                                         "none", "null", "-"])
def test_a_vendor_placeholder_is_not_a_vendor_sample_statement(placeholder):
    """TEST-15 [acceptance] (INV-1) — the leg that was supposed to be UNCHANGED, and was not.

    The old call site read `provenance["region_name"]`, and `vendor_provenance` had ALREADY
    dropped `_VENDOR_PLACEHOLDERS` through its own predicate — *"a key nobody could fill is
    DROPPED, never written as 'unknown', so a reader cannot mistake our placeholder for the
    vendor's answer"*. The first cut of this branch read `experiment["region_name"]` raw and
    lost that filter, which is worse than the code it replaced: every bundle whose operator
    left the field at `unknown` declared `sample_id: "unknown"` with
    `sample_id_source: "region_name"` — asserting the vendor stated it, in the same report
    whose provenance block had dropped the key for being a placeholder — and any two such
    bundles then declared themselves sections of ONE sample.

    Found by the blind correctness audit, not by this suite. This is the test that would have.
    """
    module = XF.load_compute()
    space = "xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"

    value, source = module.section_sample_id(
        {"region_name": placeholder, "slide_id": "Slide_1"}, space)
    assert source == "no-vendor-sample-statement", (
        f"{placeholder!r} is a placeholder the vendor writes when it has no answer; declaring "
        f"it as a stated sample id is the fabricated value INV-3 refuses. Got {source!r}")
    assert value == f"{module.UNVERIFIED_SAMPLE_PREFIX}{space}", value

    # THE PREDICATE IS THE SAME ONE, not a second spelling: whatever `vendor_provenance`
    # refuses to record, `section_sample_id` refuses to declare.
    assert "region_name" not in module.vendor_provenance(
        {"region_name": placeholder}, {}), placeholder


def test_no_sample_statement_reaches_the_artifact_the_mirror_and_the_page(tmp_path):
    """TEST-7 [acceptance] (INV-2) — the emitted declaration, its store mirror, and the report.

    What this asserts, stated narrowly so the docstring does not claim more than the code
    reaches: that NO INFERENCE occupies §15.4's field, and that the same block reaches all
    three destinations. It does NOT assert that grouping now works — nothing in this branch
    makes §15.4's grouping possible for a Xenium bundle, because the bundle states no sample
    (see the `section_sample_id` docstring and DEC-1). The branch makes the failure honest;
    that is the whole claim.

    The consumer that matters is SANDBOXED and reads the store's `attributes.cyto`, not the
    catalog row — so an assertion against the manifest alone would leave the channel that
    actually matters unchecked. All three copies are read here, plus the boundaries store,
    which is handed the same `series` object.
    """
    # WITH boundaries, deliberately: `BD.write_boundaries` is handed the SAME `series` object
    # and mirrors it into a SECOND store. A test staging the bare bundle would leave that
    # second mirror — one of the two destinations #270 names — unchecked.
    root = XF.stage_bundle(tmp_path, name="no-region",
                           boundaries=XF.PRIME_STAGED_BOUNDARIES)
    doc = _experiment_without(root, "region_name")
    out = tmp_path / "no-region-outs"
    module, entries = XF.run_over(root, out)
    SD = module.SD

    coordinates = XF.entry(entries, "spatial-coordinates")
    section = coordinates["meta"]["section"]
    space_id = coordinates["meta"]["coordinate_space"]

    assert section["sample_id"] != doc["slide_id"], (
        f"the slide id is back in the sample field: {section}")
    assert section["sample_id"] != space_id, (
        f"the bare coordinate-space id is occupying §15.4's field: {section}")
    assert section["sample_id"] == f"unverified-sample:{space_id}", section
    assert section["index"] == 0, section

    mirror = SD.require_spatial_declarations(
        out / coordinates["path"], consumer="a section-grouping analysis")
    assert mirror["section"] == section, (
        "the store's mirror — the copy a sandboxed consumer actually reads — disagrees with "
        f"the catalog row. mirror={mirror.get('section')} row={section}")
    assert mirror["coordinate_space_source"], (
        "the value's namespace points at the coordinate space, so that space's own source "
        "must be in the SAME mirrored block for the pair to be auditable")

    stores = [e for e in entries if "boundaries" in e["id"] and e.get("path")]
    assert stores, f"no boundaries artifact to check the second mirror on: {[e['id'] for e in entries]}"
    for entry in stores:
        boundary_mirror = SD.require_spatial_declarations(
            out / entry["path"], consumer="a section-grouping analysis")
        assert boundary_mirror["section"] == section, boundary_mirror

    report = json.loads((out / "xenium-import-report.json").read_text())
    assert report["section"] == dict(section,
                                     sample_id_source="no-vendor-sample-statement",
                                     index_source="single-region-bundle"), (
        f"the report must mirror the EMITTED block plus BOTH bases — the sample id's and the "
        f"ordinal's; `section()` can carry neither (#318). Got: {report['section']}")
    page = (out / "xenium-import-summary.html").read_text()
    rows = dict(re.findall(r"<th align='left'>(Sample id[^<]*)</th><td>([^<]*)</td>", page))
    assert rows == {"Sample id": section["sample_id"],
                    "Sample id source": "no-vendor-sample-statement"}, (
        f"the page must pair the value with its derivation the way it already does for the "
        f"coordinate space; got {rows}")


def test_two_regions_of_one_slide_are_not_declared_to_be_one_sample(tmp_path):
    """TEST-8 [acceptance] (INV-2) — the FALSE collision the `slide_id` leg created.

    §15.4's field groups *several sections of one sample*. The removed leg 2 grouped on the
    SLIDE, and a slide carries several regions — so two different tissues imaged on one slide
    were declared to be sections of one sample. That is a false collision, the error direction
    `coordinate_space_id`'s own docstring calls the unrecoverable one, and it is silent: both
    artifacts look correct.

    Two bundles, one `slide_id`, two `roi_uuid`s, neither stating a `region_name`. Their
    sample ids must DIFFER, and both must say they are not vendor statements.
    """
    ids = []
    for suffix in ("a", "b"):
        root = XF.stage_bundle(tmp_path, name=f"one-slide-{suffix}")
        path = root / "experiment.xenium"
        doc = json.loads(path.read_text())
        doc.pop("region_name", None)
        doc["slide_id"] = "Slide_1"
        doc["roi_uuid"] = f"00000000-0000-0000-0000-00000000000{suffix and ord(suffix) % 10}"
        path.write_text(json.dumps(doc))
        _module, entries = XF.run_over(root, tmp_path / f"one-slide-{suffix}-outs")
        ids.append(XF.entry(entries, "spatial-coordinates")["meta"]["section"]["sample_id"])

    assert ids[0] != ids[1], (
        "two regions of one slide were declared to be sections of ONE sample — the leg this "
        f"branch removed. Both got {ids[0]!r}")
    assert all(i.startswith("unverified-sample:") for i in ids), ids
    assert "Slide_1" not in ids[0] and "Slide_1" not in ids[1], ids


def test_the_real_bundles_still_declare_the_vendors_own_region_name(tmp_path):
    """TEST-9 (INV-3) / TEST-11 — the control, on both shipped bundles.

    Leg 1 is a vendor statement and is KEPT. A change that namespaced every sample id, or that
    started refusing the real ones, would pass every assertion above; this is what refuses it.

    ## AMENDED BY #320 (its ITEM-7 / DEC-6), and what was and was not changed

    This test originally also asserted `sample_id == "region"` for the PRIME bundle, on the
    reasoning that *"the vendor stated it" is a fact this importer can check, "the vendor stated
    something useful" is not* (#270's DEC-4). #320 was filed against exactly that assertion — its
    body names this test as **"the executable record of the current behaviour"** — because the
    behaviour it records is a FALSE COLLISION: MEASURED on two staged copies of this same bundle
    with different `roi_uuid`s, both declared themselves *section 0 of sample `region`*.

    So the PRIME row moved, and nothing else did. What this test is FOR is unchanged and is now
    carried by three rows rather than one:

    * the PROTEIN bundle's real `hKidney_sample` is still emitted VERBATIM with source
      `region_name` — the row that refuses a fix which namespaces everything;
    * the PRIME bundle now gets a namespaced id with source `non-identifying-region-name`, and its
      `region_name` is still RECORDED in the provenance block, so nothing the vendor wrote is lost;
    * a bundle whose `region_name` merely CONTAINS the generic word (`region_7`) is still emitted
      verbatim — the row that refuses a fix which is merely blunt.

    #320's rule is not #270's DEC-4 denylist: it asks whether the value repeats the name of its own
    field, which is derived from the KEY rather than from a vocabulary of suspicious-looking names.
    See `non_identifying_vendor_label` and `docs/design/xenium-declaration-residues.md` §2.
    """
    out = tmp_path / "control-protein"
    _module, entries = XF.run_over(XF.PROTEIN, out)
    section = XF.entry(entries, "spatial-coordinates")["meta"]["section"]
    assert section == {"sample_id": "hKidney_sample", "index": 0}, section
    report = json.loads((out / "xenium-import-report.json").read_text())
    assert report["section"]["sample_id_source"] == "region_name", report["section"]

    out = tmp_path / "control-prime"
    _module, entries = XF.run_over(XF.PRIME, out)
    section = XF.entry(entries, "spatial-coordinates")["meta"]["section"]
    report = json.loads((out / "xenium-import-report.json").read_text())
    # THE KEY SET, not just the two values — the pre-amendment leg asserted an exact dict and a
    # blind tests-quality angle noticed the amendment dropped that pin for the one bundle whose
    # behaviour actually changed. `section` is what crosses into the sandbox; a third key appearing
    # in it is a contract change nobody asked for.
    assert set(section) == {"sample_id", "index"}, section
    assert section["index"] == 0 and section["sample_id"].startswith("unverified-sample:"), section
    assert report["section"]["sample_id_source"] == "non-identifying-region-name", report["section"]
    assert report["provenance"]["region_name"] == "region", (
        "#320 changed which field the value may OCCUPY, not whether the vendor's string is "
        f"recorded — `_VENDOR_PLACEHOLDERS` is untouched: {report['provenance']}")

    # The third row: a real name that CONTAINS the generic word is a vendor statement and stays one.
    staged = XF.stage_bundle(tmp_path, name="control-real-name")
    path = staged / "experiment.xenium"
    doc = json.loads(path.read_text())
    doc["region_name"] = "region_7"
    path.write_text(json.dumps(doc))
    out = tmp_path / "control-real-name-outs"
    _module, entries = XF.run_over(staged, out)
    section = XF.entry(entries, "spatial-coordinates")["meta"]["section"]
    assert section == {"sample_id": "region_7", "index": 0}, section
    report = json.loads((out / "xenium-import-report.json").read_text())
    assert report["section"]["sample_id_source"] == "region_name", report["section"]


# ── the mutants: each fix must go RED when the defect comes back ─────────────────────

#: The body `origin/main` shipped at `import_xenium.py:2229-2231`, quoted VERBATIM from #270,
#: and — the half that was wrong on the first attempt — fed the value the OLD CALL SITE fed
#: it. It read `provenance`, i.e. the output of `vendor_provenance`, NOT the raw experiment
#: dict. Handing it an experiment dict made the comparison blind to the placeholder filter and
#: is exactly why the defect TEST-15 covers reached the branch at all.
def _pre_change_sample_id(experiment, space_id, module):
    provenance = module.vendor_provenance(experiment, {})
    return (provenance.get("region_name") or provenance.get("slide_id") or space_id)


#: The bodies `origin/main` shipped at `xenium_image.py:183-186` and `:197-202`, as a SOURCE
#: mutation of the shipped file rather than a re-implementation of it — so the mutant is the
#: real module with the fix backed out, and a revert makes it identical to what ships.
_PRE_CHANGE_CHANNEL = (
    ("                declare_channel(selection, xml)\n"
     "                plane = series.asarray()\n"),
    ("                if names:\n"
     "                    selection[\"channel_name\"] = names[0].strip()\n"
     "                plane = series.asarray()\n"),
    ("                declare_channel(selection, xml)\n"
     "                plane = pages[index].asarray()\n"),
    ("                if names:\n"
     "                    selection[\"channel_name\"] = names[0].strip()\n"
     "                plane = pages[index].asarray()\n"),
)


def _shipped_with_the_channel_fix_backed_out():
    path = XF.PKG / "compute" / "xenium_image.py"
    source = path.read_text()
    for old, new in (_PRE_CHANGE_CHANNEL[0:2], _PRE_CHANGE_CHANNEL[2:4]):
        assert source.count(old) == 1, (
            f"the mutation anchor matched {source.count(old)} times. If it matched ZERO, the "
            "most likely cause is that the #271 fix has been REVERTED out of "
            "`xenium_image.py` — THAT is the regression this test exists for, not a stale "
            "anchor. Confirm against `git diff` before touching this string; a mutation that "
            "matches nothing tests nothing.")
        source = source.replace(old, new)
    module = types.ModuleType("xenium_image_pre_change")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


@pytest.mark.parametrize("shape", ["ZYX", "YX"])
@pytest.mark.parametrize("which", ["multi", "foreign", "stale", "literal"])
def test_the_pre_change_channel_body_and_the_shipped_one_must_DISAGREE(
        shape, which, tmp_path, documents):
    """TEST-10 (INV-1) — the regression pin, stated as a disagreement.

    Asserting the new value alone cannot tell a fix from a coincidence. This runs the SHIPPED
    file and the shipped file with the fix textually backed out over the same fixture and
    requires them to differ: the old body names channel 0, the new one names nothing. Back the
    fix out for real and the two become identical, and this test is the thing that reddens.
    """
    xenium_image = sys.modules["xenium_image"]
    size_z = 3 if shape == "ZYX" else 1
    path = _write_ome(Path(tmp_path) / f"mutant-{shape}-{which}.ome.tif",
                      documents[shape][which], size_z=size_z)

    _p, shipped = xenium_image.read_plane(path)
    _q, pre_change = _shipped_with_the_channel_fix_backed_out().read_plane(path)

    defect = {"foreign": "DAPI", "stale": "DAPI", "literal": "DAPI",
              "multi": "AlphaSMA/Vimentin"}[which]
    assert pre_change.get("channel_name") == defect, (
        f"the pre-change body did not reproduce the defect on the {which!r} fixture "
        f"({pre_change}) — then this fixture does not discriminate and the comparison below "
        "is vacuous")
    # THE CHANNEL NAME, not the whole dict. Comparing dicts cannot fail while the shipped
    # body adds `channel_name_rule` at all — it would stay green with the wrong stain still
    # emitted beside the new key, which is the "check that cannot discriminate" shape.
    assert shipped.get("channel_name") != pre_change.get("channel_name"), (
        "the shipped code and the pre-change code name the SAME channel on a fixture built "
        f"to tell them apart — the fix is not in effect. Both said "
        f"{shipped.get('channel_name')!r}")
    assert "channel_name" not in shipped, shipped


def test_the_pre_change_sample_id_body_and_the_shipped_one_must_DISAGREE():
    """TEST-11 (INV-2) — the same pin for #270, on the two legs that were removed.

    Leg 2 (`slide_id`) and leg 3 (the coordinate space id, whose own last leg was the upload
    directory's basename when this was written and is a value derived from the run's own
    measurement since #323) are each given the input that reaches them. The pre-change body must
    return the inference and the shipped one must not — and the strongest half is the first
    assertion in each pair, because it is what proves the fixture discriminates at all.
    """
    module = XF.load_compute()
    space = "xenium:my-download-folder"

    def pre_change(experiment):
        return _pre_change_sample_id(experiment, space, module)

    for label, experiment, old_value in (
            ("the slide-id leg", {"slide_id": "Slide_1"}, "Slide_1"),
            ("the upload-directory leg", {}, space),
            # The placeholder case reaches leg 2 in the OLD body too — `vendor_provenance`
            # drops it — so this is a third disagreement, not a repeat of the first.
            ("the placeholder leg", {"region_name": "unknown", "slide_id": "Slide_1"},
             "Slide_1"),
    ):
        assert pre_change(experiment) == old_value, (
            f"{label}: the pre-change body did not reproduce the defect (got "
            f"{pre_change(experiment)!r}) — then this input does not discriminate and the "
            "comparison below is vacuous")
        assert module.section_sample_id(experiment, space)[0] != pre_change(experiment), (
            f"{label} is back: the shipped body and `origin/main`'s agree on an input built "
            "to tell them apart")

    stated = {"region_name": "hKidney_sample", "slide_id": "Slide_1"}
    assert module.section_sample_id(stated, space)[0] == pre_change(stated), (
        "leg 1 is a VENDOR STATEMENT and was never the defect; the two bodies must still "
        "agree here, or this branch has changed what a stated sample id means")


# ── the two things the code change alone does not carry ──────────────────────────────

def test_the_manifest_bump_covers_the_files_this_branch_changed():
    """TEST-12 (ITEM-6) — the seed cache key, checked against what actually moved.

    [TEST-12 (ITEM-8) of `coordinate-space-identity` — #323 bumps `0.9.5` -> `0.9.6` for a
    change to `compute/import_xenium.py`, which is `run.entry`, and this is the assertion that
    the bump covers it. The assertion itself is #270/#271's and is unchanged.]

    `extensions/embedded.rs` skips re-extraction when the recorded `version` matches, so a
    `compute/` change with no bump leaves an already-provisioned deployment running the OLD
    kernel while the new declaration is nowhere. The bump is only meaningful if the changed
    files are STAGED files: a helper this branch edited but that `run.helpers` does not list
    would never reach `/code` at all — and that half IS answerable here, from the manifest
    alone.

    ## What this test deliberately does NOT assert, and where that assertion lives instead

    "the version MOVED relative to the base" is a question about a COMMIT RANGE, i.e. about
    somebody's branch. A package test cannot ask it honestly: on `main` the comparison is
    vacuous and on every later branch it compares against a moving `origin/main`. A first cut
    did ask it, with a bare `git show origin/main:…`, and
    `_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`
    refused it — correctly, and by name, on the run that would otherwise have shipped it.

    The repo already owns that question in the place that can scope it:
    `just check-processor-versions` -> `scripts/check-processor-seed-versions.sh origin/main`,
    a leg of `just check`. Re-asking it here unscoped would not add coverage; it would add a
    check that is vacuous exactly where it is supposed to bite.
    """
    import yaml

    manifest = yaml.safe_load((XF.PKG / "manifest.yaml").read_text())
    assert str(manifest["version"]).strip(), "the manifest declares no version at all"

    # PARSED, not substring-matched. The manifest carries ~460 lines of prose comments, and a
    # file merely MENTIONED in one of them would satisfy `"- compute/foo.py" in text` while
    # `/code` never staged it.
    analyses = manifest["contributes"]["analyses"]
    assert len(analyses) == 1, f"this package contributes {len(analyses)} analyses now"
    run = analyses[0]["run"]
    staged = set(run.get("helpers") or []) | {run["entry"]}
    for changed in ("compute/import_xenium.py", "compute/xenium_image.py"):
        assert changed in staged, (
            f"{changed} was changed by this branch but is neither `run.entry` nor in "
            f"`run.helpers` ({sorted(staged)}), so the bump ships a file the sandbox never "
            "assembles into `/code`")




def test_the_vendored_contract_still_refuses_the_source_key_this_branch_wanted():
    """TEST-13 (ITEM-7) — the EXECUTABLE record of why DEC-1 is what it is.

    #270 offers two dispositions for `sample_id`: leave it absent, or record a
    `sample_id_source` beside it the way `coordinate_space` does. Neither is reachable — the
    vendored `section()` requires a non-empty `sample_id` and refuses every keyword outside
    `{sample_id, index, z_offset_um}` — and that module is vendored byte-identically into
    three packages, so it is outside this branch's writable surface.

    This asserts the constraint rather than asserting a paragraph about it. The day the shared
    contract grows the field, this test goes RED and points whoever is reading at the follow-up
    issue instead of leaving the workaround in place forever.
    """
    SD = sys.modules["spatial_declarations"]

    with pytest.raises(SD.SpatialDeclarationError) as refused:
        SD.section(sample_id="donor-04-blockA", index=0, sample_id_source="region_name")
    assert "sample_id_source" in str(refused.value), str(refused.value)

    for absent in (None, "", "   "):
        with pytest.raises(SD.SpatialDeclarationError):
            SD.section(sample_id=absent, index=0)

    # And the whole `section` block is REQUIRED by the writer, so "emit no section at all"
    # is not a third way out either.
    import inspect
    assert "series" in inspect.signature(SD.write_spatial_coordinates).parameters
    assert inspect.signature(SD.write_spatial_coordinates).parameters["series"].default \
        is inspect.Parameter.empty, (
        "`series` acquired a default — then absence IS expressible and DEC-1 should be "
        "revisited rather than inherited")


def test_a_placeholder_region_name_does_not_collide_two_bundles_into_one_sample(tmp_path):
    """TEST-16 [acceptance] (INV-2) — the placeholder defect END TO END, in both its forms.

    TEST-15 pins the predicate; this pins what the predicate is FOR. Two bundles, one slide,
    different `roi_uuid`s, both stating `region_name: "unknown"` — the shape an operator
    produces by leaving the field alone:

    * their `sample_id`s must DIFFER, or two unrelated tissues are declared sections of one
      sample (the same false collision as the `slide_id` leg, arriving through leg 1);
    * the report must not CONTRADICT ITSELF: `sample_id_source` may not claim `region_name`
      while the provenance block in the same JSON has dropped that key for being a
      placeholder.
    """
    ids, reports = [], []
    for suffix in ("a", "b"):
        root = XF.stage_bundle(tmp_path, name=f"placeholder-{suffix}")
        path = root / "experiment.xenium"
        doc = json.loads(path.read_text())
        doc["region_name"] = "unknown"
        doc["slide_id"] = "Slide_1"
        doc["roi_uuid"] = f"11111111-1111-1111-1111-11111111111{'0' if suffix == 'a' else '1'}"
        path.write_text(json.dumps(doc))
        out = tmp_path / f"placeholder-{suffix}-outs"
        _module, entries = XF.run_over(root, out)
        ids.append(XF.entry(entries, "spatial-coordinates")["meta"]["section"]["sample_id"])
        reports.append(json.loads((out / "xenium-import-report.json").read_text()))

    assert ids[0] != ids[1], (
        "two bundles that both left `region_name` at the placeholder `unknown` were declared "
        f"to be sections of ONE sample. Both got {ids[0]!r}")
    for report in reports:
        assert report["section"]["sample_id_source"] == "no-vendor-sample-statement", (
            "the report asserts the vendor stated a sample name it did not state: "
            f"{report['section']}")
        assert "region_name" not in report["provenance"], (
            "the provenance block dropped `region_name` as a placeholder while the section "
            "block declared it as the source — one report, two answers")
        assert report["section"]["sample_id"].startswith("unverified-sample:"), report["section"]
