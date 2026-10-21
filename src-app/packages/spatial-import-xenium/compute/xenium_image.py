#!/usr/bin/env python3
# ruff: noqa
"""xenium_image — reduce a Xenium morphology OME-TIFF to the ONE 2-D plane the shared
writer accepts, and say WHICH plane it was (#162, epic #151).

`ome_writer.read_image` REFUSES any axis order but `YX` / `YXS`, and it names this exact
case in the refusal it raises:

    "A multi-page or planar-separate image arrives as (C, H, W), which would be read as a
     transposed plane and silently misplace every pixel. Refusing rather than guessing."

That guard is correct and is NOT relaxed. Every Xenium morphology image is one of the
shapes it refuses, so the reduction to a plane happens HERE, in the importer's own package,
before the shared writer is ever called — and the shared reader's contract is untouched.

## What the vendor actually ships (MEASURED, on two real bundles)

| file | axes | shape | levels | codec |
|---|---|---|---|---|
| `morphology_focus/morphology_focus_0000.ome.tif` (XOA 3) | `YX` | 3522 x 5789 | 5 | JPEG-2000 |
| `morphology.ome.tif` | `ZYX` | 11 x 3522 x 5789 | 5 | JPEG-2000 |
| `morphology_focus/ch####_<stain>.ome.tif` (XOA 4 protein) | `CYX` | 12 x 6915 x 2963, across TWELVE FILES | 1 | JPEG-2000 |

Two consequences that are not obvious from the shapes:

* **JPEG-2000 means `imagecodecs`.** `tifffile` raises
  `ValueError: <COMPRESSION.JPEG2000: 34712> requires the 'imagecodecs' package` without
  it. #155 deliberately declined that library for Visium (deflate needs only stdlib
  `zlib`); Xenium cannot. It is already pinned in the rootfs, so declaring it costs no
  image republish — see the package manifest.
* **A multi-file OME with MISSING SIBLINGS SILENTLY ZERO-FILLS.** Measured: delete eleven
  of the twelve `ch####` files and `tifffile` still returns a full `(12, 6915, 2963)`
  array in which eleven channels are entirely zero. It emits a WARNING and raises NOTHING.
  A bundle that lost part of its `morphology_focus/` directory would therefore yield a
  plausible-looking black raster registered against real cells — the exact silent-wrong-data
  shape this arm exists to refuse. So the OME-XML's own file references are checked against
  the filesystem BEFORE any pixel is read.

## Selecting a plane is a CHOICE, so it is declared

Every emitted pixel is a real measurement — this is selection, not fabrication — but WHICH
plane is a decision a reader cannot recover from the bytes. So it rides in
`meta.plane_selection` and in the report:

* `YX` — the plane itself; nothing was chosen.
* `CYX` — the channel whose OME `Channel@Name` matches `dapi` (case-insensitively), else
  channel 0. DAPI is the nuclear stain the vendor's OWN segmentation registers against and
  is the one channel present on every Xenium run, so it is the reference a human overlaying
  cells expects to see.
* `ZYX` — the MIDDLE focal plane. Reached only when a bundle has no `morphology_focus`
  (the vendor's own extended-depth-of-field projection), which is the answer this module
  prefers whenever it exists precisely so this case is rare.

Level 0 only. The vendor ships a pyramid; it is deliberately not reused — see the package
manifest's DEC-9 note. Reading ONE PAGE rather than the whole series is what keeps a
12-channel 6915 x 2963 uint16 stack from being materialised (491 MB) to select 41 MB of it.
"""
import re
from pathlib import Path
from xml.sax.saxutils import unescape

import ome_writer
import spatial_declarations as SD

#: The channel name a `CYX` morphology image is reduced to when it has one. Matched
#: case-insensitively against the OME `Channel@Name` and then against the FILENAME, because
#: XOA writes the stain into both and only the second survives a bundle whose OME-XML a
#: converter rewrote.
PREFERRED_CHANNEL = "dapi"

#: The axis orders this module knows how to reduce. Anything else is refused rather than
#: guessed at, on exactly the reasoning `ome_writer.read_image` states for its own list.
KNOWN_AXES = ("YX", "YXS", "CYX", "ZYX")

_UUID_FILENAME_RE = re.compile(r"<UUID[^>]*FileName=\"([^\"]+)\"")
_CHANNEL_NAME_RE = re.compile(r"<Channel[^>]*Name=\"([^\"]*)\"")


def referenced_files(ome_xml):
    """Every sibling file the OME-XML says this image's planes live in.

    Empty for a single-file image. The list is what makes the zero-fill detectable: a
    reader that trusts `tifffile` here gets a full-shaped array with silent holes in it.
    """
    if not ome_xml:
        return []
    seen, out = set(), []
    for name in _UUID_FILENAME_RE.findall(ome_xml):
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def channel_names(ome_xml):
    """The OME `Channel@Name` values, in declaration order. `[]` when there are none.

    A regex over the WHOLE document, which is the property every caller has to hold in mind:
    an OME-XML may declare several `<Image>` elements, each with its own channels, and this
    returns all of them flattened. So `channel_names(xml)[0]` is "the first channel this
    DOCUMENT declares", never "the channel of the plane we emitted" — see
    [`sole_declared_channel`] and [`series_channel_names`], which are the two places that
    distinction is answered.

    **It also drops the UNNAMED channels rather than holding their place**, because the regex
    matches only a `<Channel>` that carries a `Name` at all. So the list is not index-aligned with
    a series' pages even for a single-image document, which is the second half of #319 and the
    reason [`series_channel_names`] counts START TAGS instead of names.

    **After #319 no branch of `read_plane` reads this.** It survives as the honest statement of what
    a whole-document name scan is worth, and because #271's regression pin re-introduces its old
    call site as a source mutation — see the comment at that call site.
    """
    return _CHANNEL_NAME_RE.findall(ome_xml or "")


#: WHAT THE COUNTING BELOW MUST NOT SEE. An XML comment or a CDATA block is not a
#: declaration, and both error directions are real — MEASURED by the blind correctness audit
#: on this branch:
#:
#: * `<!-- <Channel ID="C:0" Name="OldStain"/> -->` beside an image that declares no channel
#:   of its own made the shipped rule emit `OldStain` as the verified stain of the emitted
#:   plane. A stain a converter DISABLED is the one name most certainly not this plane's.
#: * a converter comment that merely MENTIONS `<Image ` inflated the image count and refused
#:   a name the document really did verify.
_XML_NOISE_RE = re.compile(r"<!--.*?-->|<!\[CDATA\[.*?\]\]>", re.DOTALL)

#: `Name="…"` (or `'…'`) ON A START TAG. Two details, each of which was a wrong stain before
#: the audit found it:
#:
#: * `\bName` rather than `Name` — without the word boundary a vendor extension attribute
#:   like `FluorName="GFP"` on an UNNAMED channel was read as that channel's name;
#: * both quote styles, because XML says both are equivalent and a single-quoted document
#:   otherwise reads as "this document names no channel at all", which is a false statement
#:   made INTO the artifact rather than a value merely left out.
_NAME_ATTR_RE = re.compile(r"""\bName\s*=\s*(?:"([^"]*)"|'([^']*)')""")


#: ONE spelling of the start-tag pattern, shared by [`_start_tags`] and [`_sole_element_span`].
#: Two copies of this regex is two places for the `<ChannelRef>`/prefix rules to drift apart.
_START_TAG_TEMPLATE = r"<(?:[A-Za-z_][\w.\-]*:)?{}(?=[\s/>])[^>]*>"

#: The matching END tag. `\s*` because `</Image >` and `</Image\n>` are the same tag.
_END_TAG_TEMPLATE = r"</(?:[A-Za-z_][\w.\-]*:)?{}\s*>"


def _start_tags(xml, element):
    """Every `<element …>` START TAG in `xml`, namespace prefix allowed, references excluded.

    The lookahead is what separates a DECLARATION from a REFERENCE: `<ChannelRef …>` is not a
    `<Channel>` and `<ImageRef …>` is not an `<Image>`, and OME uses both. `<ome:Channel …>`
    IS one — a namespace prefix is a serialization choice, not a different element, and a
    prefixed document was being read as declaring nothing.
    """
    return re.findall(_START_TAG_TEMPLATE.format(element), xml)


def _sole_element_span(xml, element):
    """The XML *inside* the ONE `<element>` in `xml`, or `""` — the containment primitive.

    Positions come from `finditer` rather than from a `str.find` of the matched text: the two
    agree (a start-tag match ends at the first `>`, so it can contain no interior `>`, so an
    earlier identical substring would itself have been the first match — a blind correctness
    angle proved this over 300k adversarial documents with zero mismatches), and taking the
    match's own span means there is no "not found" case to write a branch for that no input can
    reach.

    FAILS CLOSED, in all four degenerate shapes, and every caller reads `""` as *containment
    could not be established*: no such element, several of them, a self-closing `<element/>`
    (which contains nothing), and a document whose end tag is missing.
    """
    tags = list(re.finditer(_START_TAG_TEMPLATE.format(element), xml))
    if len(tags) != 1 or tags[0].group(0).rstrip().endswith("/>"):
        return ""
    end = re.compile(_END_TAG_TEMPLATE.format(element)).search(xml, tags[0].end())
    return "" if end is None else xml[tags[0].end():end.start()]


def _tag_name(tag):
    """The `Name` attribute of one start tag, entity-decoded and stripped, or `""`.

    `unescape` because `Name="CD3 &amp; CD4"` is the XML spelling of the stain `CD3 & CD4`:
    without it the artifact carries the literal `&amp;` sequence and `render_report_html`
    escapes it a second time, so a human reads `CD3 &amp;amp; CD4` in the report. Only the three
    predefined entities are decoded, which is what a stain name realistically carries.
    """
    match = _NAME_ATTR_RE.search(tag)
    if not match:
        return ""
    return unescape(match.group(1) if match.group(1) is not None else match.group(2)).strip()


def sole_pixels_span(xml):
    """`<Channel>`'s REAL parent: the ONE `<Pixels>` inside the ONE `<Image>`, or `""`.

    ## Why this is TWO levels and not one, which cost a whole audit round

    The first fix for #319 scoped the channel tags to the single `<Image>`. A blind
    design-conformance angle then moved the same block ONE LEVEL IN and both defects came back at
    full strength. `<Channel>`'s parent in OME is `<Pixels>`, not `<Image>`, so a
    `<StructuredAnnotations>` block sitting after `</Pixels>` but before `</Image>` is inside the
    image span and is still not a declaration about any channel.

    MEASURED against that first fix — one `<Image>` with two named channels (`18S`/`GFP`) over a
    3-page `CYX` series, plus `<StructuredAnnotations><XMLAnnotation><Value><Channel ID="Legacy:0"
    Name="DAPI"/>…` placed after `</Pixels>`:

        {'index': 2, 'of': 3, 'rule': 'channel-name-match', 'channel_name': 'DAPI',
         'available': ['18S', 'GFP', 'DAPI']}

    — a converter's RETIRED stain asserted as this plane's, at an index the image declares no
    channel for, with `available` one entry longer than the image's own channel list. The same
    shape made `sole_declared_channel` return `'DAPI'` with
    `channel_name_rule: "sole-declared-channel"`, i.e. #271's own defect revived.

    ## The lesson the file should keep

    The first version was not *wrong about the vector* — it refused the same block in every
    schema-valid position — it was wrong about WHERE the containment question lives. A scope
    check has to be taken at the element that actually PARENTS the thing being counted; taking it
    one level out leaves exactly one level of room, and that room is where a converter writes.

    The block in the nested position is not schema-valid OME (`StructuredAnnotations` is a child
    of `OME`), and that is deliberately NOT the reason this refuses it: this module never
    validates, and the justification for the clause is *"how Bio-Formats-class converters preserve
    ORIGINAL metadata"* — converter output, not schema-checked input.

    Fails CLOSED at either level, and the callers read `""` as *the binding was not established*.
    See `docs/design/xenium-declaration-residues.md` §1.2.
    """
    return _sole_element_span(_sole_element_span(xml, "Image"), "Pixels")


def declared_channel_names(ome_xml):
    """Every channel name this document DECLARES, in document order — the disclosure list.

    Distinct from [`channel_names`] on purpose, and the difference is not cosmetic. That
    function is the `CYX` branch's reader, where the list is INDEX-ALIGNED with `series.pages`
    and `_channel_index` subscripts it; its regex is left exactly as it is because changing it
    would change which channel that branch selects, which is outside #271 (DEC-7). This one
    answers a different question — "what does the document say, so a refusal can carry its own
    evidence" — and it is the one that must not count a `<ChannelRef>`, a commented-out
    channel, or an attribute that merely ends in `Name`.
    """
    xml = _XML_NOISE_RE.sub(" ", ome_xml or "")
    return [name for name in (_tag_name(tag) for tag in _start_tags(xml, "Channel")) if name]


def series_channel_names(ome_xml, page_count):
    """The EMITTED series' own channel names, index-aligned with its pages — or `[]` (#319).

    ## The question, and why [`channel_names`] cannot answer it

    `_channel_index` selects a `CYX` channel by subscripting a name list POSITIONALLY against
    `series.pages`. `channel_names` reads the WHOLE document, and its own docstring says what that
    is worth: *"`channel_names(xml)[0]` is 'the first channel this DOCUMENT declares', never 'the
    channel of the plane we emitted'"*. `sole_declared_channel`'s docstring named the consequence
    for this branch and filed it as #319 rather than widening #271's diff — *"a blind audit of this
    branch built a `CYX` file whose emitted image declares two UNNAMED channels and whose second
    image declares `DAPI`, and the branch labelled the emitted plane `DAPI` with
    `rule: "channel-name-match"`."* MEASURED, on exactly that file:

        {'axes': 'CYX', 'axis': 'C', 'index': 0, 'of': 2, 'rule': 'channel-name-match',
         'channel_name': 'DAPI', 'available': ['DAPI']}

    — another image's stain, asserted as this plane's, with a rule claiming a match happened and an
    `available` list of one for a two-channel image.

    ## The binding is THREE facts, and each has its own fixture

    * **exactly one `<Image>` start tag.** Then `handle.series[0]` IS that image and the channels
      INSIDE it are its channels. Same clause, same reasoning, as `sole_declared_channel`'s first.
    * **the tags are read from inside that image's `<Pixels>`** ([`sole_pixels_span`]), not from
      the whole document and not merely from inside the `<Image>`. A `<Channel>` in a
      `<StructuredAnnotations>` block is legal OME, and two successive blind audits measured one
      both restoring the count and shifting every position — first from outside the image, then
      from inside it but outside `<Pixels>`, each reproducing the exact defect #319 was filed for.
      That function carries both measurements and the reason the check belongs at the PARENT
      element.
    * **exactly `page_count` `<Channel>` start tags.** Then tag `i` is page `i`. This is not
      belt-and-braces: it is the clause that catches the QUIETER misalignment, because
      `_CHANNEL_NAME_RE` matches only channels that CARRY a `Name`. MEASURED — a single-image
      3-page series declaring `["", "18S", "DAPI"]` hands the old body the list `["18S", "DAPI"]`,
      so it selects page 1 and labels it `DAPI` while the real DAPI is page 2. A count check is
      what turns "tag `i` is page `i`" from a hope into a read fact.

    Returns one entry PER CHANNEL TAG, in document order, each being that tag's `Name` **or the
    empty string** — the empty entries are the point, since dropping them is the misalignment
    above. `[]` means the binding was not established and NOTHING may be indexed off it.

    Read through `_XML_NOISE_RE` / `_start_tags` / `_tag_name` rather than the raw regex, for the
    reasons those three already carry: a commented-out `<Channel>`, a `<ChannelRef>`, a vendor
    `FluorName="GFP"` and a single-quoted `Name` were each a measured wrong stain before the
    #270/#271 audit corrected them, and this function must not re-acquire any of the four.

    Deliberately CONSERVATIVE, in the direction this file already errs in: a full XML parse could
    bind the channels of `<Image>` 0 in a multi-image document, and this refuses those. A missing
    name is visible and recoverable; a wrong stain is silent wrong data.

    The argument, both measurements and the cost: `docs/design/xenium-declaration-residues.md` §1.
    """
    span = sole_pixels_span(_XML_NOISE_RE.sub(" ", ome_xml or ""))
    if not span:
        return []
    tags = _start_tags(span, "Channel")
    if len(tags) != page_count:
        return []
    return [_tag_name(tag) for tag in tags]


def sole_declared_channel(ome_xml):
    """The channel this XML can be READ AS DECLARING for the emitted plane, or `""`.

    ## The question this answers, and why `channel_names(xml)[0]` does not answer it

    `read_plane` emits ONE plane and declares what it is. For `CYX` there is an INDEX to align
    against — page `i` is channel `i` of the emitted series — which is why `_channel_index`
    may name the channel it selected. For `YX`/`YXS` (one plane) and `ZYX` (focal planes of a
    single channel) there is no such index: the plane belongs to `handle.series[0]`, and a
    name regex reads the whole document. A document that declares two `<Image>` elements — a
    focal stack and a separate projection, say — hands back both images' channels in one flat
    list, and nothing in that list says which `<Image>` a name came from.

    **The `CYX` index was not a complete answer either, and saying otherwise here would have been
    the same defect one paragraph up.** `_channel_index` read that same whole-document list, so a
    multi-`<Image>` document broke its alignment too: a blind audit of #271's branch built a
    `CYX` file whose emitted image declares two UNNAMED channels and whose second image
    declares `DAPI`, and the branch labelled the emitted plane `DAPI` with
    `rule: "channel-name-match"`. That was PRE-EXISTING — the `CYX` branch was textually
    untouched by #271, which names only `:183-186` and `:197-202` — so it was filed as its own
    issue (#319) rather than widened into that diff (its DEC-7). **#319 is now CLOSED**: the `CYX`
    arm reads [`series_channel_names`], which binds the list to the EMITTED series or returns `[]`,
    and refuses the claim through [`disclose_declared_channels`] when it cannot.

    So the association is verified in exactly ONE shape: the document declares **one image**
    and **one channel**, and that channel carries **a name**. Then the emitted plane is that
    image's, that image's channel is that channel, and the name is its name — three facts that
    leave no room for a mismatch. Anything else is a name the importer would be ASSERTING
    rather than reading, which is the claim `_channel_index`'s own docstring refuses one branch
    over: *"the declaration never asserts a stain it did not verify."*

    ## Each clause does work, and each has its OWN fixture

    A clause whose only test uses a shape another clause already catches is not a guard, it is
    decoration — and all three of these SURVIVED a mutation battery on the first attempt,
    which is how they got their own fixtures:

    * **one `<Image>`** — a document with exactly ONE named `<Channel>` belonging to a
      DIFFERENT image than the one whose plane was emitted (`Channel@Name` is optional in OME,
      so an unnamed channel on the emitted image and a named one elsewhere is a legal
      document). The channel clause passes it; only this one refuses it.
    * **one `<Channel>` start tag** — a single image carrying TWO channel elements of which
      only the SECOND is named. Exactly one name in the whole document, so a name-count rule
      passes it, and `names[0]` is then channel 1's name attached to channel 0's pixels.
    * **that tag carries a `Name`** — an unnamed channel makes no claim, so there is nothing
      to verify and nothing to refuse.
    * **the tag is INSIDE that `<Image>`** (added at #319) — a document whose one image declares no
      channel of its own, plus one `<Channel>` in a `<StructuredAnnotations>` block. Exactly one
      image and exactly one named tag, so the three clauses above all pass it, and the name belongs
      to a converter's retired legacy metadata rather than to any image. See [`sole_pixels_span`].

    Deliberately CONSERVATIVE. A full XML parse could verify more documents than this — the
    channels of `<Image>` 0 specifically — and this refuses some names it could have kept.
    That is the error direction the file already errs in: a missing name is visible and
    recoverable, a wrong stain is silent wrong data (§12.2).
    """
    xml = _XML_NOISE_RE.sub(" ", ome_xml or "")
    if len(_start_tags(xml, "Image")) != 1:
        return ""
    tags = _start_tags(xml, "Channel")
    if len(tags) != 1:
        return ""
    # A FOURTH CLAUSE, added at #319 and STRICTLY NARROWING — it can only refuse documents the
    # three above already accepted. The one tag must be INSIDE the one image: a `<Channel>` in a
    # `<StructuredAnnotations>` block is legal OME and is not a declaration about any image's
    # channels. MEASURED on `origin/main`, a document whose one `<Image>` declares no channel of
    # its own plus one annotation `<Channel ID="Legacy:0" Name="DAPI"/>` returned `'DAPI'` as this
    # plane's VERIFIED stain — a stain a converter had retired. See `sole_pixels_span`.
    if len(_start_tags(sole_pixels_span(xml), "Channel")) != 1:
        return ""
    return _tag_name(tags[0])


def declare_channel(selection, ome_xml):
    """Put the emitted plane's channel identity into `selection` — or say it is unverified.

    Mutates and returns `selection`, the way the branches that call it already build it. Three
    outcomes, and the middle one is the one #271 is about:

    * the association is verified -> `channel_name` plus
      `channel_name_rule: "sole-declared-channel"`, so a reader can see WHICH of the three
      answered rather than guessing, exactly as `_channel_index`'s `rule` does;
    * the document names channels but not verifiably this plane's ->
      **no `channel_name`**, `channel_name_rule: "unverified-channel"`, and
      `declared_channels` carrying what the document DOES say. The refusal is stated rather
      than left as an absence, and the evidence for it travels with it;
    * the document names no channel at all -> nothing. Absence stays absence (INV-3); there is
      no refusal to disclose because there was no claim to refuse.

    ## `declared_channels` and `available` are DIFFERENT claims, not two spellings

    The `CYX` branch emits `available` — the channels OF THE EMITTED SERIES, index-aligned
    with its pages, so a reader may pair name `i` with page `i`. This emits
    `declared_channels` — the channels the whole DOCUMENT names, in document order, with no
    pairing to anything. Giving them one name would state a pairing on the `YX`/`ZYX` path
    that is exactly what could not be verified. `channel_name_rule` is likewise separate from
    `rule` because `rule` on these two branches describes PLANE selection
    (`single-plane`/`middle-plane`) while on `CYX` it describes the channel; a second key is
    how the two branches say two different things without either borrowing the other's
    meaning.

    Both the verdict and the evidence come from [`declared_channel_names`]/[`_start_tags`], not
    from [`channel_names`], so outcome 2 and outcome 3 cannot disagree about whether the
    document said anything — a document naming a channel in single quotes used to be verified
    by neither and disclosed by neither, which reported "nothing was claimed" about a document
    that claimed something.
    """
    verified = sole_declared_channel(ome_xml)
    if verified:
        selection["channel_name"] = verified
        selection["channel_name_rule"] = "sole-declared-channel"
        return selection
    return disclose_declared_channels(selection, ome_xml)


def disclose_declared_channels(selection, ome_xml):
    """State the REFUSAL and carry its evidence — outcome 2 of [`declare_channel`], factored out.

    Module level with TWO callers rather than a branch inside `declare_channel`, for the reason
    `import_xenium.vendor_statement`'s docstring records about itself: the second caller is #319's
    `CYX` arm, which reaches the same verdict by a different route (its INDEX binding could not be
    established rather than its sole-channel clause failing), and a second spelling of "say
    `unverified-channel` and show what the document does say" is a second thing to drift.

    `sole-declared-channel` is deliberately NOT reachable from the `CYX` caller: that verdict
    answers a `YX`/`ZYX` question — *the whole image is one named channel* — and a `CYX` series has
    an index, so where its binding HOLDS its verified answer is the `rule` value `_channel_index`
    returns. Nothing here mints a new token; `unverified-channel` and `declared_channels` are the
    vocabulary #270/#271 shipped.

    Absence stays absence (INV-3): a document that names no channel at all gets nothing, because
    there was no claim to refuse.
    """
    declared = declared_channel_names(ome_xml)
    if declared:
        selection["channel_name_rule"] = "unverified-channel"
        selection["declared_channels"] = declared
    return selection


#: XOA 4 writes a multi-file `CYX` morphology set as `ch<NNNN>_<stain>.ome.tif`, one file
#: per channel, and the FILENAME's index is the channel's index in the series.
_CHANNEL_FILENAME_RE = re.compile(r"^ch(\d+)_", re.IGNORECASE)


def _channel_index(names, page_count, path):
    """WHICH channel of a `CYX` image is emitted, and why.

    Name match first, filename second, index 0 last — and the RULE is returned alongside the
    index so the declaration says which of the three answered, rather than leaving a reader
    to guess whether `0` was a match or a fallback.

    ## `names` MUST be the EMITTED SERIES' channel list, not the document's (#319)

    Every leg here subscripts `names` POSITIONALLY against this series' pages, so the caller owes
    this function a list where entry `i` is page `i`. It is called with
    [`series_channel_names`]`(xml, len(pages))`, which returns exactly that or `[]`; it was called
    with [`channel_names`]`(xml)`, which returns the whole DOCUMENT's names flattened and with the
    unnamed ones dropped — and MEASURED, on a two-image document, that made this function report
    `("channel-name-match", "DAPI")` for a plane whose own channel the document leaves unnamed.

    An EMPTY `names` is therefore not "the document named nothing": it is "the binding could not be
    established". Both reach the same last leg — index 0, `first-channel`, no name — which is why
    that leg is written to answer `""` rather than to index anything.

    ## The filename branch parses the index; it does not assume 0

    A multi-file OME returns the WHOLE series whichever of its files was opened, so the
    channel a filename names sits at ITS OWN index, not at 0. Returning 0 here would emit
    channel 0's pixels while declaring the stain from the filename — a plausible-looking
    image labelled as the wrong stain, and worse than no image, since nothing downstream
    could tell. The branch exists precisely for a bundle whose `Channel@Name`s a converter
    stripped, which is exactly the case with no name left to check the answer against.

    Every real XOA 4 bundle observed writes DAPI as `ch0000`, so this was latent rather than
    live — which is the reason to fix it now rather than after a vendor reorders the set.
    """
    for i, name in enumerate(names[:page_count]):
        if PREFERRED_CHANNEL in (name or "").strip().lower():
            return i, "channel-name-match", (name or "").strip()
    stem = Path(path).name
    if PREFERRED_CHANNEL in stem.lower():
        match = _CHANNEL_FILENAME_RE.match(stem)
        index = int(match.group(1)) if match else 0
        if index >= page_count:
            # The filename claims an index this series does not have. Refusing the CLAIM
            # rather than the image: fall through to channel 0 and say `first-channel`, so
            # the declaration never asserts a stain it did not verify.
            return 0, "first-channel", (names[0].strip() if names else "")
        return index, "filename-match", (names[index].strip()
                                         if index < len(names) else "")
    return 0, "first-channel", (names[0].strip() if names else "")


def read_plane(path):
    """`(plane, selection)` — a 2-D (or `YXS`) array and the DECLARATION of what it is.

    Raises `ome_writer.ImageConversionError` for every DECODE failure, so the caller needs the
    one `except` it already has. Nothing here writes; nothing here decides scale.

    That promise used to be false for six exception types, and #296 is the record of it: a
    `_PROGRAMMING_ERRORS` deny-list re-raised `AttributeError`, `TypeError`, `KeyError`,
    `IndexError`, `ZeroDivisionError` and `NameError` as "a bug in this file", and none of the
    six is in either importer's guard tuple, so a damaged vendor file that raised one of them
    cost the WHOLE import. Two of them had already been MEASURED arriving from data by this
    module's sibling (`ome_writer.read_image`'s attempt 3: a zeroed dimension tag raises
    `ZeroDivisionError` inside `tifffile.detect_series`; `tifffile` raises `TypeError` on
    malformed tags). The deny-list's INTENT was right and is kept — a bug in THIS file must not
    be laundered into an accusation about the vendor's file — but the question it asked was
    unanswerable from the type. It now asks the answerable one, at the site: see
    `ome_writer.image_failure_is_a_bug` and `docs/design/image-failure-provenance-refusal.md` §2.
    """
    path = Path(path)
    try:
        # DEFERRED, AND INSIDE THE `try` (#298 E2). Outside it, a `tifffile` missing or broken
        # in the analysis rootfs raised `ImportError` — in neither importer's guard tuple — and
        # cost the matrix, the coordinates, the columns and the report rather than one image.
        # The rootfs pins it, which is exactly why the whole point of a per-image guard is that
        # the UNLIKELY input costs one image too.
        #
        # MOVING IT WAS NOT ENOUGH ON ITS OWN, and the reason is the one thing about the site
        # rule that is easy to get wrong: `importlib` raises a MISSING module on the `import`
        # statement's own line, so the innermost frame is THIS file and the handler below
        # re-raised it exactly as before. `ImportError` is therefore a declared carve-out in
        # `ome_writer._SITE_RULE_IS_BLIND_TO`, alongside `MemoryError`.
        #
        # IT IS THE NARROWEST OF THE TWO CARVE-OUTS, and the narrowing is what keeps a typo in
        # THIS line from being laundered: only a `ModuleNotFoundError` whose root package is one
        # `ome_writer._DECLARED_LIBRARIES` names is converted. So `tifffile` absent from the
        # rootfs costs one image, and `import tiffile_typo` still aborts exactly as it did
        # before. Both constants carry the argument and the measurements.
        import tifffile

        with tifffile.TiffFile(str(path)) as handle:
            if not handle.series:
                raise ome_writer.ImageConversionError("this TIFF contains no image series")
            series = handle.series[0]
            xml = handle.ome_metadata or ""
            # BEFORE any pixel is read. `tifffile` will happily zero-fill what it cannot
            # open, and a black channel is indistinguishable from a dark one.
            missing = [n for n in referenced_files(xml) if not (path.parent / n).exists()]
            if missing:
                raise ome_writer.ImageConversionError(
                    "this is a MULTI-FILE OME-TIFF and "
                    f"{len(missing)} of the {len(referenced_files(xml))} files its own "
                    f"metadata references are absent (first: {missing[:3]}). tifffile does "
                    "not fail on this — it returns a full-sized array with the missing "
                    "planes ZEROED and only a warning — so an image emitted from it would "
                    "be a black raster registered against real cells. Re-upload the bundle "
                    "with the whole `morphology_focus/` directory."
                )
            axes = str(series.axes)
            if axes not in KNOWN_AXES:
                raise ome_writer.ImageConversionError(
                    f"this TIFF's axis order is {axes!r}, which this importer does not know "
                    f"how to reduce to a single plane (it handles {list(KNOWN_AXES)}). "
                    "Guessing which axis is spatial would silently transpose or "
                    "channel-average the image, so it is refused instead."
                )
            # THE WHOLE-DOCUMENT LIST, and after #319 it is read by NO branch below. It is kept
            # at this scope on purpose: #271's regression pin
            # (`test_unverified_declarations.py::test_the_pre_change_channel_body_and_the_shipped_
            # one_must_DISAGREE`) backs that fix out as a SOURCE mutation of this file, replacing
            # the `declare_channel(...)` calls in the `YX` and `ZYX` arms with the
            # `names[0].strip()` body `origin/main` shipped. That name must resolve here or the pin
            # dies with a `NameError` instead of reproducing the defect it exists to reproduce —
            # i.e. removing this line would silently disarm the guard on the fix one issue up.
            names = channel_names(xml)
            pages = series.pages
            # THE PRECONDITION EVERY BRANCH BELOW DIVIDES OR SUBSCRIPTS BY, validated rather
            # than discovered (#296). A series with no pages is a DATA fact — `handle.series`
            # is non-empty, so the emptiness check above passed — and without this the CYX and
            # ZYX arms reach `pages[index]`, which raises `IndexError` from inside `tifffile`
            # (measured: `tifffile.py:12535`). The site rule would convert that correctly, but
            # into "could not be decoded (IndexError: list index out of range)", which tells an
            # operator nothing they can act on. A validated precondition is the difference
            # between a refusal and a converted accident.
            if not len(pages):
                raise ome_writer.ImageConversionError(
                    f"this TIFF declares an image series with axes {str(series.axes)!r} but "
                    "that series contains NO PAGES, so there are no pixels to select a plane "
                    "from. A series with a shape and no pages is a damaged or partially "
                    "written file; re-upload the bundle with the image intact."
                )
            if axes in ("YX", "YXS"):
                selection = {"axes": axes, "rule": "single-plane", "of": 1}
                # #271. This used to be `names[0]` unconditionally, which labels the one
                # emitted plane with the FIRST channel the whole document declares — a stain
                # this branch has no index to check the name against.
                declare_channel(selection, xml)
                plane = series.asarray()
            elif axes == "CYX":
                # #319. This used to pass `names` — the WHOLE document's channel names — to a
                # function that subscripts it positionally against this series' pages. The
                # alignment holds only for a single-`<Image>` document, and MEASURED on a
                # constructed multi-image file it labelled the emitted plane with ANOTHER IMAGE'S
                # stain. `series_channel_names` returns the emitted series' OWN channels or `[]`.
                series_names = series_channel_names(xml, len(pages))
                index, rule, name = _channel_index(series_names, len(pages), path)
                selection = {"axes": axes, "axis": "C", "index": int(index),
                             "of": int(len(pages)), "rule": rule}
                if name:
                    selection["channel_name"] = name
                if series_names:
                    # `available` promises "the channels OF THE EMITTED SERIES, index-aligned with
                    # its pages" (see `declare_channel`). It is emitted ONLY when that binding was
                    # established, and then it is the WHOLE bound list — empty entries included,
                    # because an unnamed channel that vanishes from this list takes every later
                    # channel's index with it.
                    selection["available"] = [n.strip() for n in series_names]
                else:
                    # THE BINDING FAILED. `_channel_index` has already fallen through to channel 0
                    # with `rule: "first-channel"` and no name, which is this file's own precedent
                    # for the case — *"Refusing the CLAIM rather than the image ... so the
                    # declaration never asserts a stain it did not verify."* What is added is that
                    # the refusal is STATED rather than left as an absence, in the vocabulary
                    # #270/#271 shipped, with the document's own channel names travelling as its
                    # evidence.
                    disclose_declared_channels(selection, xml)
                plane = pages[index].asarray()
            else:  # ZYX
                index = len(pages) // 2
                selection = {"axes": axes, "axis": "Z", "index": int(index),
                             "of": int(len(pages)), "rule": "middle-plane"}
                # #271, and the STRONGER half: this value reaches the user-facing HTML report
                # as the parenthetical stain in the "one plane was emitted" warning. A focal
                # stack is Z planes of ONE channel, and which channel that is is not
                # recoverable from a document that declares several.
                declare_channel(selection, xml)
                plane = pages[index].asarray()
    except (ome_writer.ImageConversionError, SD.SpatialDeclarationError):
        # BOTH refusal taxonomies, not just one. `SpatialDeclarationError` is the other member
        # of the tuple both importers guard, and a broad arm that converts it would retype a
        # producer's "you declared something impossible" into "the image was bad". Not
        # reachable from this block today; the sibling boundaries got this and this one was
        # left, under a test whose name claimed it covered every broad arm.
        #
        # A DELIBERATE REFUSAL, re-raised ahead of the normaliser below for the same reason
        # `ome_writer.read_image` does it: this type subclasses RuntimeError and would
        # otherwise be caught and double-wrapped into an unreadable message.
        raise
    except Exception as exc:
        # A BUG IN THIS FILE IS NOT A DAMAGED BUNDLE, AND A DAMAGED BUNDLE IS NOT A BUG — and
        # the exception TYPE cannot tell them apart, which is what #296 is about.
        #
        # The property this arm keeps is the one the deleted deny-list was added for, and it
        # is mutation-proved: an `AttributeError` (`series.axess`), a `TypeError`
        # (`len(pages)` -> `pages`), a `KeyError` (a typo in the selection dict) and a
        # `NameError` (`pagez`) each came back to the USER as "images_not_emitted: not a
        # readable Xenium OME-TIFF (...)", with the import reporting SUCCESS and shipping a
        # dataset with no image — a defect in this code laundered into an accusation about the
        # vendor's file. All four are raised by a line in THIS file, so all four propagate.
        #
        # WHERE THAT SENTENCE STOPS, said plainly because the deleted deny-list DID cover this
        # case and this arm does not. A bug of ours that a LIBRARY raises on our behalf is
        # converted, not propagated — and the concrete instance is a plane-SELECTION bug:
        # `pages[index]` with an index this code computed wrongly raises `IndexError` from
        # inside `tifffile`, so the site rule reads it as the file's fault. MEASURED: mutating
        # `index = len(pages) // 2` to `index = len(pages)` aborts on `origin/main` and here
        # becomes "could not be decoded (IndexError: ...)" with the import reporting SUCCESS.
        # That is limitation 3 of `docs/design/image-failure-provenance-refusal.md` §2, and it
        # is the direction that design errs in ON PURPOSE. The remedy it attaches is the one
        # attempt 4 attached: COVERAGE. Both mutants above are killed by the positive-path
        # tests (`test_the_ZYX_focal_stack_falls_back_and_takes_the_middle_plane` and the
        # `test_spatial_image` / `test_scale_referent` families) — so the property still holds
        # for these two, it is just the TEST SUITE that carries it here and not the mechanism.
        #
        # What the deny-list ALSO did, and could not help doing, was propagate the same types
        # when `tifffile` raised them about the vendor's bytes — a zeroed dimension tag
        # (`ZeroDivisionError`), a malformed tag (`TypeError`), a series shorter than it says
        # (`IndexError`) — and none of those is in either importer's guard tuple, so each cost
        # the matrix, the coordinates, the columns and the report. The site answers both:
        # raised HERE it is ours, raised inside the library it is the file's.
        if ome_writer.image_failure_is_a_bug(exc, __file__):
            raise
        # `tifffile` raises a bare `ValueError` for a missing codec backend, which is the
        # single most likely failure on a host without `imagecodecs` — and it must cost one
        # image, never the import. Every DECODE failure leaves this function as
        # `ImageConversionError` so the caller has one taxonomy. `from exc` rather than
        # `from None`: the cause now carries the library frame that the message's type name
        # only summarises, and it is what a maintainer reads to tell arm 1 from arm 2.
        raise ome_writer.ImageConversionError(
            f"could not be decoded ({type(exc).__name__}: {exc})"
        ) from exc

    if getattr(plane, "ndim", 0) not in (2, 3):
        raise ome_writer.ImageConversionError(
            f"the selected plane is {getattr(plane, 'ndim', None)}-dimensional; a plane is "
            "2-D, or 3-D only when the third axis is interleaved samples"
        )
    return plane, selection
