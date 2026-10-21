# OME-TIFF tile layout — why the emitted artifact must be TILED (#227)

**Status:** accepted. **Owner:** the writer (`spatial-types/compute/ome_writer.py`, #155/#176/#162).
**Reported by:** #158, which measured the cost on the wire and filed it rather than absorbing it.

## 1. What the writer promises

`ome_writer.py`'s own module docstring states the reason a `spatial/image` is emitted as an
OME-TIFF at all, even when the vendor shipped a PNG:

> Viv reads pyramidal OME-TIFF over HTTP range requests, which is *"the only way a multi-GB
> image is viewable at all"* (§6.3/§8.2).

That promise is about **range requests**. A pyramid alone does not deliver it: the pyramid
picks the right *resolution*, and the intra-level layout picks the right *region*. Emitting a
pyramid over a layout a viewer cannot address regionally satisfies the letter of "pyramidal
OME-TIFF" while defeating the sentence it was written for.

`docs/research/data-processing/01-file-formats.md` §22 records the same substrate choice from
the format side: OME-TIFF is "multi-page/pyramidal" and is "how spatial **morphology images**
ship".

## 2. The defect

`write_ome_tiff` called `tifffile`'s `writer.write(...)` with **no `tile=` argument**. With no
`tile=`, `tifffile` emits a **stripped** TIFF. Measured on a real emitted artifact:
`RowsPerStrip=62`, 30 full-width strips.

> A tiled TIFF lets a viewer fetch `tileSize × tileSize`. A stripped one forces
> `imageWidth × stripHeight` — **the full width of the image, every time**, no matter how
> narrow the viewport.

#158 measured it on the wire against a real backend: a single 512×512 level-0 tile cost
**14 ranged GETs, 41,891 of 167,778 bytes**, of which **nine were consecutive full-width
strips** [#259: corrected from "ten"; the arithmetic is below]. The model says that is
`imageWidth / tileSize` = 1400 / 512 = **~2.7×** on today's small committed fixture and
**~80× on a whole-slide image** — the case spatial imaging exists for. (2.7 is the PREDICTION, not an observation. Measured
tile-for-tile at the unit tier, on the same tile of the same image in both layouts, it is
**3.28×** — §6 says why it sits above the model. A whole-transaction ratio is lower, because both
transactions include the same open, and it is deliberately not quoted as a headline: the open is
not what the layout changes, and this document's own closing rule is that figures from different
tiers must not be quoted across each other.)

> **#259 amendment — "nine", corrected from "ten".** Editing another issue's recorded
> measurement needs to be visible and needs to be checkable, so both. The decomposition is read
> straight out of the artifact #158 measured, which is kept byte-identical as
> `spatial-image-hires-stripped.ome.tif`: a 512-row band spans **nine** of its 62-row strips —
> at y=0 they sum to 36,383 B — and every full band on this file (y = 0, 512, 1024) spans nine,
> so the correction does not depend on which tile #158 read. 41,891 − 36,383 = **5,508 over
> 14 − 9 = 5 GETs**, which is exactly what an OPEN of this file costs, measured on the shipped
> loader (and the same 5,508 / 5 for the tiled artifact — the open reads the header, the
> OME-XML and the level directories, which the two layouts share). Ten strips would be 40,439 B,
> leaving a 1,452-byte, 4-GET open that no measurement of this reader produces.
>
> **Five copies of the old sentence survived here, and #321 has corrected them.**
> `spatial-types/compute/ome_writer.py`, `spatial-import-{visium,xenium}/compute/ome_writer.py`
> and `spatial-types/tests/test_ome_tile_layout.py` (×2) all read "ten of them consecutive
> full-width strips" until then. Everything under `src-app/packages/` was outside #259's scope —
> a package edit forces a version bump, and #300 records those colliding on four consecutive
> branches — so #259 filed them as **#321** rather than touching them, and #321 landed all five
> in one change together with the single `CORRECTED_BY_259_ALLOWED` deletion #333 showed they
> require. The number is no longer maintained by hand:
> `src-app/packages/spatial-types/tests/test_wire_measurement_strip_count.py` DERIVES it from
> this same artifact's own tags and holds every copy of the sentence anywhere under
> `src-app/packages/` to what it derived.

A second, quieter cost rides along, and it is worth stating precisely because the
loose version of it is false. Viv's own `loadOmeTiff` derives a tile size as
`prevPowerOf2(min(getTileWidth(), getTileHeight()))`, and on a stripped TIFF
`getTileHeight()` **is** `RowsPerStrip` — 62 on the real file, which floors to **32**, about
2000 deck tiles for one full-resolution viewport. The client does **not** suffer that,
because it deliberately does not call `loadOmeTiff`: `omeTiffPyramid.ts` builds its own
`TiffPixelSource` with `DEFAULT_OME_TIFF_LIMITS.tileSize = 512` and never reads a tile size
out of the file at all (`tiledOfDirectory` is, in its own words, reported and not acted on).
So the stripped layout did not corrupt the reader's tile size; it made the reader unable to
trust the file for it.

## 3. The fix, and the constraints on it

Pass a tile size to every `writer.write` call in `write_ome_tiff`:

> **Both this and the pyramid levels below it should be tiled consistently.**

Three constraints bound the choice and the implementation:

- **`tifffile` requires tile dimensions to be multiples of 16.**
- **512 is the size, not 256 or 1024.** It must agree with the tile size the reader
  *requests* — `DEFAULT_OME_TIFF_LIMITS.tileSize = 512`, which is what deck.gl asks each
  level's `PixelSource` for. Matching that edge exactly makes one requested tile ONE TIFF
  tile and therefore ONE ranged read. At 256 the same request becomes four ranged reads and
  four decodes for the same pixels; at 1024 it fetches four times the pixels the viewport
  needs, and it quadruples what a sub-tile level pads. **Note what this argument is NOT**:
  the reader does not derive a tile size from the file (see §2), so this is agreement with a
  value the reader REQUESTS, not with a value it computes.
- **A level smaller than one tile must still be written and still be readable.**
  `PYRAMID_MIN_SIDE` is 256, so the coarsest pyramid level is routinely *smaller than one
  tile*; and level 0 itself is smaller than a tile for a Visium lowres image or any small
  fixture. `tifffile` pads such a level to a whole tile — the padding is not pixel data, the
  declared `ImageWidth`/`ImageLength` are unchanged, and the round-trip must remain exact.
  What that costs is measured — against a stripped control that is the production call minus
  `tile=`, keyword for keyword — and the table is in `ome_writer.py`'s `TILE` comment.
  **Read it as the stripped-vs-tiled NET, not as "the pad".** #259 separated the terms at the
  committed corpus's coarsest level (350×450): padded 512² tile 13,442 B, one unpadded stream
  12,714 B, two 249-row strips 13,246 B — so the pad is +728, the two-stream split is +532, and
  the observable delta is 196. The table's own rows say the same thing more loudly: a row where
  tiling WINS by 30% cannot be the pad, because padding only ever adds pixels. What that row is
  is the third term, the codec's per-tile versus per-scanline context, which the closing sentence
  of this bullet already names. (`ome_writer.py`'s copy of the table is under `src-app/packages/`
  and outside #259's scope; this is the reading, not a correction of the numbers.)
  Its shape: the RATIO is worst where the payload is tiny (a 3×3 RGB image, 1,084 → 1,906
  bytes, 1.76×) so the ABSOLUTE cost stays under ~1 KB there; at the sizes this module
  exists for the overhead is within a percent (2000×2000 RGB noise, 1.00×) or negative
  (2000×2000 RGB gradient, 132,056 → 92,854, tiling wins 30%). **Which way it goes depends
  on the DATA, not on the size alone** — how well the codec does per tile versus per strip.
  This is a measured range, not a rule.

## 4. Invariants

These are the promises this change may not reframe.

- **INV-1** — A tiled TIFF lets a viewer fetch `tileSize × tileSize`. A stripped one forces
  `imageWidth × stripHeight` — the full width of the image, every time, no matter how narrow
  the viewport.
- **INV-2** — Both this and the pyramid levels below it should be tiled consistently.
- **INV-3** — A small image is a single-level pyramid — a legal OME-TIFF and the trivial case
  of the same reader.
- **INV-4** — Level 0 is always what this artifact IS, bit-for-bit, and the halvings below it
  are a viewer's overview.

INV-3 and INV-4 are lifted verbatim from `ome_writer.py`'s module docstring; INV-1 and INV-2
from #227.

## 5. What this change is NOT

It is not a reader change. `omeTiffPyramid.ts` already handles stripped **and** tiled and is
tested against both (`tiledOfDirectory`, the `tiled-deflate.ome.tif` fixture), so nothing on
the client is blocked by, or needs to move with, this fix. **A stripped fixture stays in the
corpus on purpose: a reader that only handles the layout its own writer emits is a reader that
breaks on the first third-party OME-TIFF.** Refreshing that corpus, and the comments in it that
assert the writer emits stripped bytes, was tracked separately as **#259**.

**DONE, and here is what #259 settled about this paragraph.** When this section was written the
sentence above read "**the** stripped fixtures in `libs/viz/.../spatial/fixtures/` stay stripped
on purpose". It named no file, and at the time that phrase covered seven of them: the three
emitted-image samples plus the four malformed ones. #259 regenerated the three emitted samples
through the shipped writer, so they are now tiled. What stays is the invariant's INTENT, not
those files, and it is carried by `spatial-image-hires-stripped.ome.tif` — the pre-#227 emit of
the hires artifact, kept verbatim, which is the same image in the other layout.

That distinction has to be drawn because of what the remaining four are. Measured after the
refresh, `malformed-non-halving`, `mixed-codec-levels`, `multi-plane-channels` and `planar-rgb`
are still stripped and are ALL shapes the reader REFUSES at open — so without the one control no
successful read would go through a stripped file at all, and the sentence would have been
satisfied on paper by four files the decoder never reaches.

**AND THE WRITER HALF OF THE RESIDUAL GAP IS CLOSED — #322.** The heading is qualified on purpose:
this section previously calibrated the work as "a stripped OME-TIFF of OUR OWN pixels written by
`bfconvert`, `libtiff` or ImageJ is not written by this system, raises no licensing question, and
closes most of the gap; a real vendor file closes the rest", and that calibration still stands. The
writer list is quoted rather than paraphrased on purpose: `libtiff` is in it, and what #322
actually shipped is a file written by the libtiff Pillow bundles — so the section that authorized
the approach has to keep naming it, or the three files that cite this sentence point at a list this
very edit deleted. What follows delivers the first half; the paragraph headed "What #322 did NOT close"
below says what the second is and that it is still open. What this paragraph used to admit, and it was true when
written: the one stripped file a successful read reached was a file THIS SYSTEM wrote, before
#227, so the control proved the reader is not confined to its writer's CURRENT layout and proved
nothing about a writer outside this project — which is the invariant's own stated rationale. That
is no longer the state of the corpus. `third-party-stripped.ome.tif` is committed beside it: a
stripped OME-TIFF whose header, IFD, every tag, strip geometry and compressed payloads were laid
out by **Pillow — specifically, by the libtiff 4.7.1 it bundles**, since `TiffImagePlugin._save`
routes a compressed write there rather than to its own pure-Python IFD writer. Either way it is a
writer this project neither ships nor controls, and it is READ SUCCESSFULLY.
`#322 TEST-1` opens it, reports it stripped, resolves one 512-row viewport tile to the run of
40-row strips that writer chose (thirteen ranged reads against the one the same tile costs in our own
writer's copy), and decodes pixels an INDEPENDENT decoder confirms are the same pixels our writer
stored TILED in `spatial-image-lowres.ome.tif`. Same image, two unrelated writers, one digest.

Note what "third-party" has to mean there, because the obvious reading makes the gap look harder
to close than it is. The invariant is about **a writer we do not control**, not about someone
else's copyrighted pixels. So the fixture carries OUR OWN committed raster and puts a different
writer between it and the disk: no licensing question arises, and what it exercises is exactly
what the rationale is about — a tag layout and a strip geometry this codebase never produced.
Both sides of that were measured rather than remembered: the fixture carries the eleven tags
`256 257 258 259 262 270 273 277 278 279 284`, and `spatial-image-hires.ome.tif` carries
`256 257 258 259 262 270 277 282 283 284 296 305 322 323 324 325 330` — so this file has the STRIP
tags where ours has the TILE tags, and lacks `Software`, `XResolution`/`YResolution` and
`ResolutionUnit`, four tags our writer stamps on everything. (Two things deliberately NOT on that
list, both because an earlier draft had them and both were false: `SampleFormat`, which NEITHER OF
THOSE TWO writers emits — #346 later landed a file that does, and it is the only one in the corpus
that does, but tag 339 still cannot separate `third-party-stripped.ome.tif` from our own emits,
which is what this list is for — and `SubIFDs`, which our own single-level
`spatial-image-lowres.ome.tif` also lacks.)
Its geometry is `RowsPerStrip = 40` with a short final strip.

**And a measurement that makes the point sharper than this section previously did.** Before #322,
EVERY committed `.ome.tif` in that directory came off ONE writer — including the two the
directory's README describes as not ours. `tiled-deflate.ome.tif` ("a tiled file this system did
not write") and `unsupported-jpeg2000.ome.tif` (its stand-in for a raw vendor file) both carry
`Software = tifffile.py` and a `Creator="tifffile.py …"` OME-XML stamp: the same library
`ome_writer.py` writes through, at the same version, driven with different keywords. So the
corpus's existing "not written by this system" rows were, at most, about the CALL SITE — and for
those two the call site is not in this tree either: no committed script generates them, and #259
filed the jpeg2000 recipe as lost. What is MEASURED about them is the writer, and the writer is
ours. `#322 TEST-2` is that measurement made permanent rather than repeated: it runs three
producer stamps over the whole directory and asserts that the files flipping all three are exactly
the ones named in its `FOREIGN_WRITER_FIXTURES` list.

The regression it exists for, named accurately because an earlier draft of this paragraph named one
that cannot happen. It is NOT "regenerate the fixture through `ome_writer.py`" — that function has
passed `tile=` at every call site since #227, so it produces a TILED file, and `#322 TEST-1` is
what reports it first — at its byte-length identity anchor, then its `TileWidth` assertion ten
lines later. (Both tests run and both go red; the point is which failure names the cause.) It is a re-emit through raw `tifffile.TiffWriter`, the path
`make-sample-count-fixtures.py` and the four malformed fixtures already use, which reproduces this
file's stripped geometry exactly. Measured: doing that — same pixels, same `RowsPerStrip`, same
OME-XML text — leaves a file that still looks stripped, and reddens `#322 TEST-1`, `TEST-2`,
`TEST-3` and `#259 TEST-13`.

And what three stamps do NOT buy, since a count reads like corroboration: only the first (the
`Software` TIFF tag) probes the WRITER. The other two scan the OME-XML text, which for this fixture
our own generator composed, so the effective strength is the strongest single predicate rather than
three independent measurements.

**What #322 did NOT close, stated so the next reader does not over-read it.** Two things, and
neither is hidden in the fixture's provenance. `loadOmeTiffPyramid` does not parse OME-XML at
all, so this exercises a foreign TIFF tag layout and a foreign strip geometry and says nothing
about a vendor's OME-XML — there is no OME-XML parsing to say anything about; Pillow will not
author OME-XML either, so that document is hand-authored and handed to Pillow as tag 270, and
`fixtures/README.md` records exactly which bytes are whose. The second was that no committed file
carried an `<OME>` document composed OUTSIDE this project at all. That was always the second half
of the two ways to close this, and with the first half committed it was an improvement rather
than a blocker.

**AND THE DOCUMENT HALF IS NOW CLOSED TOO — #346.** `bioformats-tubhiswt.ome.tif` is committed
beside the other two: **upstream's bytes end to end**, taken verbatim from the OME sample tree
under **CC BY 4.0** (*"Sample OME-TIFF files (c) by the OME Consortium"*), 269,568 bytes, sha256
`a1d99f06…`. Nothing in this repository produced a byte of it — not generated, not converted, not
trimmed, not re-encoded — which is the only way it can carry the property it is here for: an
`<OME>` document written by `OME Bio-Formats 5.2.0-m4` over a real acquisition, carrying
`<Instrument>` with `<Microscope Manufacturer="Nikon" Model="Eclipse TE300">`, `<Detector>`,
`<Objective>`, `<Experimenter>`, `<Plane>`, `DimensionOrder="XYZTC"` and multi-file `<TiffData>`
elements whose `<UUID FileName=…>` children name two files. Measured over the directory, each of
those is absent from all twenty-one other `.ome.tif` here. Its CONTAINER is foreign in ways #322's
is not, and all three are firsts for this corpus: `Compression = 1` (uncompressed — an arm of
`DECODABLE_COMPRESSION` that no committed byte had ever reached), `RowsPerStrip = 1` (512
single-row strips, so one 512-row viewport tile resolves to 512 ranged reads against #322's
thirteen and our own tiled emit's one), and a `SampleFormat` tag. It is READ SUCCESSFULLY, and
`#346 TEST-1..TEST-3` pin it.

The verbatim rule is load-bearing rather than tidy, and it is what fixed the choice of file. The
pyramidal sets in the same tree — real Leica and Vectra scans with real `SubIFDs` — are 225 MB to
2.6 GB, and trimming one to fixture size means one of OUR tools rewriting it, at which point the
OME-XML is ours again and the file stops being what it would have been committed for. So the
corpus takes a 269 KB single-level file whose every byte is upstream's over a small derivative of
a big one.

**And what #346 did NOT close, on the same rule.** `loadOmeTiffPyramid` still does not parse
OME-XML, so committing a foreign document does not make a PARSER pass anything; what `#346 TEST-2`
can and does check without one is that the document is foreign (measured over the directory) and
that where the document and the container DISAGREE — it declares `SizeC="2"` across two files,
this file holds one IFD — the reader answers the container. And Bio-Formats is the OME reference
implementation, not an instrument vendor's own writer: the pixels and the instrument metadata are
a real acquisition's, the container is Bio-Formats'. A file written by an instrument's own OME-TIFF
writer is a further step; `fixtures/README.md` records what was searched, what the licences say,
and why this is the file that landed.

**A measurement #346 made on #322's own guard, recorded because it corrects it.** `#322 TEST-2`
ran three "producer stamps" and asserted the AND across them. One of the three scanned for
`urn:uuid:` as a `tifffile` signature. It is not one — it is the OME-TIFF specification's own
document identifier, and Bio-Formats writes one, so 21 of the 22 committed files now carry it and
the only one that does not is `third-party-stripped.ome.tif`, whose document our own generator
hand-composed. That predicate never probed a writer. `#322 TEST-2` now gives each predicate the
set it really discriminates and asserts separately that the one stamp that DOES probe a writer —
the `Software` tag — is absent from exactly the foreign fixtures.

It is also not a change to the pyramid, the codec, or `photometric` handling. Those are
separate decisions with their own rationale in `ome_writer.py`; a defect in any of them is a
separate issue.

## 6. Verification standard

#227 asks for two things, and both are answered here rather than one.

**1. The bytes move, so anything pinning them must be re-recorded — and the lock proven
still load-bearing.** The inventory of every pin is the deliverable, and the honest answer is
that outside #158's reader corpus (§5, #259) there is nothing: no Python fixture, no
`PROVENANCE.json`, nothing in Rust. That the emitted bytes really do move — and that nothing
else moves with them — is asserted executably rather than assumed: the production artifact
and a same-pixels stripped control decode to identical pixels at every level while locating
those pixels through disjoint `Tile*` / `Strip*` tag sets.

**Be precise about what the second half of that requirement can mean here.** "Append a line →
confirm red → restore" exercises a *content lock*, and with an empty inventory there is no
content lock on this branch to exercise — that requirement is satisfied vacuously, and saying
so is better than relabelling something else as having met it. What IS done, and is offered
as the equivalent proof for the guard this branch ADDS rather than for a lock it inherits, is
a mutation battery: six mutations of the writer (both writes untiled, the pyramid write only,
256, 1024, one vendored copy left behind, the tile inlined at one call site) each turn the new
suite RED, and the tree is restored clean afterwards. The battery is recorded with the exact
set of tests each mutation reddens, so a mutation the suite MISSES is visible rather than
absent.

**2. Measure the wire again, not just the tag.** #158's evidence was a request trace, not a
claim about `TiffWriter`'s arguments. What is done here is to read the emitted file back and
count the ranged reads a 512×512 viewport costs from the file's OWN `TileByteCounts` /
`StripByteCounts`, against a stripped control — reporting both the bytes that cross the wire
and the pixels the reader is forced to drag in. Measured: 1 span / 262,153 bytes tiled versus
4 spans / 1,048,619 bytes stripped on a 2048-wide image, a 4.00x saving, exactly the
`imageWidth / tileSize` the defect predicts.

**Stated honestly, this is a model of the wire and not a live request trace.** No HTTP range
read is issued on this branch. The instrument for a live trace exists
(`ui/tests/e2e/workstore/*.spec.ts` counts real ranged GETs) but it runs against #158's
committed fixture corpus, which is still stripped — so a live re-measure is blocked on #259
and is named there rather than claimed here. A test asserting only "the file still opens"
would pass against the unfixed code, which makes it no check at all; a byte-count model read
out of the artifact is strictly weaker than a request trace and strictly stronger than that.

**#259 TOOK THE TILED HALF OF THAT TRACE, and the model held. Be precise about which half.**

*On the wire, tiled* — `ome-tiff-range-read.spec.ts` against the refreshed corpus, real ranged
GETs out of a real browser: **16,568 bytes over 6 GETs** for an open plus one 512×512 level-0
tile, of which the tile is **11,060 bytes in exactly ONE ranged GET** — `TileByteCounts[0]` to
the byte. That TILE leg is what the spec asserts, and it is the half of this section's demand a
byte figure alone does not meet: one ranged GET, of exactly `TileByteCounts[0]` bytes, at exactly
`TileOffsets[0]`. The transaction TOTAL is asserted only as a budget, and the 6 is the good-run
figure and is not asserted at all: that spec's `beforeLoader` baseline is a snapshot, so a catalog-probe tail is sometimes
attributed to the loader (measured 5,508 B / 5 GETs and 7,556 B / 7 GETs for the open across
runs). No such race can move the tile leg.

*On the wire, stripped* — **measured, and the figure needs its decomposition or it misleads.**
The number was taken by temporarily substituting the stripped artifact for the emitted one and
re-running the render specs: **18,754 B over 7 GETs stripped against 18,950 B over 6 GETs
tiled** — the stripped run is *cheaper in bytes*. It is quoted here so nobody finds it and reads
it as a counter-example to INV-1, and the reason it is not one is arithmetic, not hand-waving:

    TILED     5,508 B / 5 reads (open)  +  13,442 B / 1 read   (coarsest level)  = 18,950 / 6
    STRIPPED  5,508 B / 5 reads (open)  +  13,246 B / 2 reads  (coarsest level)  = 18,754 / 7

**Neither run fetches a full-resolution tile at all.** Those specs drive a fit-to-viewport camera,
so the whole transaction is an open plus the COARSEST level, which is 350×450 — one padded
512×512 tile in the tiled file, exactly 450 rows in two strips (`RowsPerStrip = 249`) in the
stripped one.

**The 196 is a NET of two effects, and calling it "the pad" is wrong by 3.7×.** That matters
because the only reason to quote a figure like this is that someone will check it. Re-encoding
the same level-2 pixels at the fixture's own codec settings reproduces the committed byte counts
exactly and separates them:

    one padded 512×512 tile      13,442 B   ( = the committed TileByteCounts )
    one UNPADDED stream          12,714 B   ( neither file stores this; it is the reference )
    two strips, 249 + 201 rows   13,246 B   ( = the committed StripByteCounts, 7,272 + 5,974 )

The pad costs **+728** and splitting one deflate stream into two costs **+532**. 196 is what is
left. (§3's third constraint is the same subject and its table is NOT the pad's measurement — it
reports whole-file tiled-minus-stripped deltas, i.e. this same net plus the codec's per-tile
versus per-scanline term. §3 now says so; this is the only place the pad itself is separated.)

**And INV-1 makes no prediction about this level.** The tiled run does cost one fewer request,
but at 350 pixels wide a full-width strip and a 512-wide tile cover the same width: what saves the
request is `RowsPerStrip` granularity (249 < 450), not regional addressability. INV-1 is a claim
about a full-resolution VIEWPORT TILE, and that is what §6's other two tiers measure. Recruiting
it for a case it does not cover would be the same move this section exists to disown. What #158's
own wire figure for the stripped corpus was is in §2.

**Still not a wire measurement of the stripped artifact, and the earlier disclosure of that
stands.** No committed spec loads `spatial-image-hires-stripped.ome.tif`; the figures above were
taken by temporarily substituting it and re-running the render specs, on a transport whose open
this section already records as varying run to run. What IS asserted is the in-process
reproduction: `omeTiffPyramid.test.ts` (#259 TEST-4) drives the shipped loader over both artifacts
and pins all six numbers of the table — both opens and both level costs. The manual substitution
is how the figure was found; the unit tier is what keeps it true; neither is a request trace of
the stripped artifact.

*In process, both layouts, same image* — `omeTiffPyramid.test.ts` (#259 TEST-4), over an
in-memory `ByteRangeSource` rather than HTTP. On level-0 tile (1, 2) of the 1400-wide hires
image: **36,444 bytes over 9 reads stripped, 11,120 bytes over 1 read tiled** — 3.28× the bytes
and 9× the requests, against the `imageWidth / tileSize` = 1400 / 512 = 2.73 this section
predicts. It sits above the prediction because a strip read also drags the rows of the
partially-covered strips at each end of the band, which the model does not account for.

The three sets of figures are different tiles on different transports and must not be quoted
across each other — the wire tier reads tile (0, 0) and the unit tier tile (1, 2), and an earlier
draft of this paragraph presented the unit tier's numbers as the wire's.
