# `viz-core/spatial/fixtures` — REAL OME-TIFF bytes

These are not hand-made TIFFs — every one is some real writer's output, and the loader under test
is the only thing between these bytes and a rendered tile, so a synthetic fixture would test the
loader against a file the system never produces. But "some real writer" is four different
provenances, and the difference is the whole subject of #322 and #346, so the counts are given
rather than implied. Of the 22 `.ome.tif` files here, measured:

| whose bytes | how many | which |
|---|---|---|
| **`ome_writer.write_ome_tiff`** — the shipped writer, this system's own output | **4** | `spatial-image-{hires,lowres,greyscale}.ome.tif`, re-emitted by `make-emitted-image-fixtures.py`, plus `spatial-image-hires-stripped.ome.tif`, its pre-#227 emit. The `hires`/`lowres` pair is the literal output of running the real Visium importer **as of #154/#155/#176** |
| **`tifffile.TiffWriter` directly** — the same library the shipped writer writes through, at the same version, with different keywords, so these are that LIBRARY's output rather than this system's | **16** | the ten `samples-per-pixel-*.ome.tif`, which `make-sample-count-fixtures.py` writes; plus the four malformed ones, `tiled-deflate.ome.tif` and `unsupported-jpeg2000.ome.tif`, whose WRITER is measured (the `Software = tifffile.py` stamp) but whose CALL SITE is not in this tree — no committed script generates them, and the jpeg2000 recipe is the one #259 filed as lost. Which of them our own scripts drove is therefore an open question for six of the sixteen |
| **a writer this project neither ships nor controls, over OUR pixels and OUR hand-written OME-XML** | **1** | `third-party-stripped.ome.tif` (#322) — our own raster, laid out by Pillow's bundled libtiff. Pillow will not author OME-XML, so that document is our generator's string handed over as tag 270 |
| **upstream's bytes END TO END, including the `<OME>` document** | **1** | `bioformats-tubhiswt.ome.tif` (#346) — the OME Consortium's own sample, saved verbatim under CC BY 4.0, written by `OME Bio-Formats 5.2.0-m4` over a real Nikon/Bio-Rad acquisition. Nothing here produced a byte of it. Full provenance, licence and credit in **The foreign-document fixture** below |

⚠️ **This paragraph used to claim that EVERY file here came off the shipped writer, and that was
false three ways.** (Paraphrased rather than quoted on purpose: the sentence is on
`staleClaims.test.ts`'s `CLAIMS_RETIRED_BY_322` list, which forbids it in every scanned root, and a
retraction that reproduced it verbatim would need an allowlist entry — a hole this one does not
need.) It was false because 16 of the 21 files that existed then are `tifffile.TiffWriter` output
rather than `write_ome_tiff` output; because two rows of the table below described their files as ones this
system did not write, contradicting it outright; and because those same two rows overclaimed in the
other direction — measured while #322 landed, `tiled-deflate.ome.tif` and
`unsupported-jpeg2000.ome.tif` both carry `Software = tifffile.py` and a `Creator="tifffile.py …"`
stamp, so they are that LIBRARY's output driven from a different call site, not a third party's.
Before #322 there was no file here from a writer outside that library at all, which is precisely
the gap §5 had filed as open.

`#322 TEST-2` enforces the corrected rule mechanically rather than leaving it as this paragraph: it
runs three producer stamps over every `.ome.tif` in this directory and asserts, for each one, that
the files it is ABSENT from are exactly the files it discriminates. What that buys is stated
honestly beside it — only one of the three (the `Software` TIFF tag) probes the writer rather than
the OME-XML text, so it is one measurement with two weaker companions, not three independent ones.

⚠️ **#322 asserted the AND across those three, and #346 measured that as unsound.** The third
scanned for `urn:uuid:` as a `tifffile` signature; it is the OME-TIFF specification's own document
identifier, Bio-Formats writes one, and `bioformats-tubhiswt.ome.tif` therefore carries it. So 21
of the 22 files here carry `urn:uuid:` and the only one that does not is
`third-party-stripped.ome.tif`, whose document our own generator hand-composed — which means that
predicate never probed a writer at all. Each predicate now states the set it really discriminates,
and the writer-probing one is asserted separately against the whole foreign list. **A measurement
it made on #322's own guard** at the end of the `bioformats-tubhiswt.ome.tif` section says it
again, where the file that made it is described.

## Two different things are frozen here, and only one of them is

Read this section before touching a byte in this directory. Its whole subject is a distinction
that a single word ("frozen") hides:

* **The LAYOUT tracks the writer.** These files are samples of what `ome_writer.write_ome_tiff`
  puts on disk, and a sample that has stopped resembling the producer is not a fixture. #227
  made the writer pass `tile=(512, 512)` at every `writer.write` call site, so the emitted
  layout went from full-width STRIPS to 512×512 TILES at every pyramid level, and #259
  regenerated `spatial-image-{hires,lowres,greyscale}.ome.tif` through the shipped writer so
  they sample that. `scripts/make-emitted-image-fixtures.py` is how, and it is a permanent
  committed path precisely so this is a re-run and not archaeology.
* **The producer MAGNITUDES do not.** They are held at their pre-#222 values under #222's
  fix-forward-only ruling, and that is what the two tables below are about.

The generator is built around exactly that split. It re-emits each fixture THROUGH the shipped
writer while carrying three things forward out of the artifact verbatim — its level-0 raster,
its decoded `cyto` placement, and its OME `PhysicalSizeX`, handed back as
`image_microns_per_pixel`. Everything the writer's CODE decides is re-derived; nothing the
CALLER supplies moves. So a regeneration cannot move a producer magnitude, whatever the
importer does later, and `check-viz-producer-magnitudes.mjs` stays green across one by
construction rather than by remembering to check.

Measured, comparing a generator run against a live importer run of the same bundle (the
importer run driven by `spatial-import-visium/tests/test_spatial_image.py` into a temp dir):
every TIFF tag, every `TileOffsets` count and every `TileByteCounts` sum is IDENTICAL at all
three levels, and the level-0 rasters are `array_equal`. Nothing structural moves, which is the
claim.

What differs is the OME-XML, in three ways worth separating because only one of them has a
size:

* the producer magnitudes — `PhysicalSizeX/Y` and the `cyto` payload's `microns_per_pixel`,
  `original_resolution_um` and `applied_resolution_um` — all of which #222 moved and all of
  which happen to be **length-neutral** (18 characters before and after);
* the `urn:uuid` `tifffile` stamps per write, also length-neutral;
* one key #222 ADDED, `,"microns_per_pixel_source":"derived-from-spot-diameter"` — which is
  **exactly 56 bytes**, and is therefore the whole of the net size delta between the two files.

## The MAGNITUDES are FROZEN pre-#222 output, and that is deliberate

⚠️ **Running the importer end to end no longer reproduces these numbers.** #222 corrected the
[producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
Visium micron scale's numerator from the 55 µm *capture* spot to the 65 µm *rendered* spot —
the circle `spot_diameter_fullres` actually measures — which moves every micron magnitude
*derived from* `spot_diameter_fullres` by `65/55 = +18.18%`. (A vendor-**stated**
`microns_per_pixel`, which `micron_scale()` takes verbatim when a bundle carries one, is
unaffected. This bundle does not carry one.) The bundle's own inputs, read from the producer's
committed copy [producer-magnitude: spot_diameter_fullres]:
`spot_diameter_fullres = 73.61433`, `tissue_hires_scalef = 0.2`, `tissue_lowres_scalef = 0.06`.

**These fixtures — the pre-#222 emit.** Every value below is checked against the committed
fixture's own bytes; a regen that is not accompanied by a correction here goes red.

| declared value | these fixtures (pre-#222) |
|---|---|
| *checked against* | the fixture bytes [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um] [frozen-magnitude: spatial-image-lowres.original_resolution_um] [frozen-magnitude: spatial-image-hires.to_space[0]] |
| space `microns_per_pixel` | `0.7471371402823337` (= the 55 µm capture spot over `spot_diameter_fullres`) |
| hires `original_resolution_um` | `3.7356857014116684` (= that scale over `tissue_hires_scalef`) |
| lowres `original_resolution_um` | `12.452285671372229` (= that scale over `tissue_lowres_scalef`) |
| hires `to_space[0]` | `5.0` (= `1/tissue_hires_scalef`) |

**The importer today — the post-#222 derivation.** Every value below is DERIVED at check time by
executing the importer, so it cannot go stale; if it disagrees with what is written here, the
gate says so and prints what the producer now implies.

| declared value | the importer today (post-#222) |
|---|---|
| *checked against* | the live derivation [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM] [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um] [producer-magnitude: spatial-image-lowres.original_resolution_um] [producer-magnitude: spatial-image-hires.to_space[0]] |
| space `microns_per_pixel` | `0.8829802566973034` (= the 65 µm rendered spot over `spot_diameter_fullres`) |
| hires `original_resolution_um` | `4.4149012834865164` (= that scale over `tissue_hires_scalef`) |
| lowres `original_resolution_um` | `14.716337611621723` (= that scale over `tissue_lowres_scalef`) |
| hires `to_space[0]` | `5.0` — **unchanged**, it is `1/tissue_hires_scalef` |

The two tables are deliberately separate rather than two columns of one. A tag's scope is the
run of lines it heads, so with one table both eras sat in one scope and the gate could not tell
which column claimed which — swapping the columns, which is exactly the #222 defect, stayed
green. Split, each era's values sit under only its own tag.

Read straight out of the committed TIFF bytes — both axes of both images, so a regenerated
image reddens whichever one moved:
[frozen-magnitude: spatial-image-hires.PhysicalSizeX] [frozen-magnitude: spatial-image-hires.PhysicalSizeY]
the hires TIFF's OME-XML carries the same pre-#222 pitch as `PhysicalSizeX="3.7356857014116684"`
(and `PhysicalSizeY` the same, since the writer emits square pixels);
[frozen-magnitude: spatial-image-lowres.PhysicalSizeX] [frozen-magnitude: spatial-image-lowres.PhysicalSizeY]
the lowres TIFF carries `PhysicalSizeX="12.452285671372229"`, likewise on both axes.

They are kept at the pre-#222 values on purpose, under #222's fix-forward-only ruling:
already-emitted artifacts keep the numbers they were emitted with. The stale magnitudes cost the
loader tests nothing, because nothing on the viz placement path can read a micron scale — the
signatures do not accept one (`omeTiffModelMatrix(toSpace)`, `imagePlacementMatrix(toSpace)`,
`omeTiffUnderlayMeta(pyramid, toSpace, space)`). A regen would move the two `.ome.tif` files'
bytes (their OME-XML carries `PhysicalSizeX`) and `emitted-manifest-entries.json`. It would NOT
move `pixel-oracle.json`, whose entries are digests of *decoded raster arrays* plus byte offsets
into the jpeg2000 / short-file fixtures — no pixel changes.

`coordinateBinding.test.ts`'s `#258 TEST-5` block asserts all four rows of the first column, so
this README and `emitted-manifest-entries.json` cannot drift apart silently.

**Both columns of that table are now checked mechanically, and so are the `.ome.tif` bytes**
(#277). `scripts/check-viz-producer-magnitudes.mjs` — run by this package's own suite, and
therefore by `just check-packages` — derives the right-hand column by EXECUTING the importer
over that package's committed `scalefactors_json.json`, and reads the left-hand column out of
`emitted-manifest-entries.json` **and the OME-XML inside each `*.ome.tif`**. Swapping in a
regenerated TIFF while leaving the manifest alone used to leave the suite green (the loader
never parses `PhysicalSizeX` — `loadOmeTiffPyramid` takes `micronsPerPixel` from its caller);
it now reddens the guard, because the guard reads the image bytes directly rather than through
the loader. Each quoted magnitude in this directory carries a `[producer-magnitude: ...]` or
`[frozen-magnitude: ...]` tag naming which side it claims, and an untagged one is a hard
failure — so a new quote cannot enter unchecked either.

| file | what it is | shape |
|---|---|---|
| `spatial-image-hires.ome.tif` | a real emitted `spatial/image` artifact | classic TIFF · DEFLATE · **interleaved RGB** (`SamplesPerPixel=3`, `PlanarConfiguration=1`, `PhotometricInterpretation=2`) · `uint8` · **3 levels via SubIFDs** 1400×1800 → 700×900 → 350×450 · **TILED 512² at every level** (`TileWidth`/`TileLength`, no `RowsPerStrip` anywhere) — #227's layout |
| `spatial-image-hires-stripped.ome.tif` | **the SAME artifact as it was emitted BEFORE #227**, kept verbatim | byte-identical to what the importer put on disk at `4cb70f45`: **STRIPPED** (`RowsPerStrip=62`, 30 full-width strips, no `TileWidth`), otherwise the same pixels, the same placement and the same OME magnitudes as the row above. Not generated and not re-encoded — `git show 4cb70f45:…/spatial-image-hires.ome.tif`. It is here for two reasons that are both permanent: `docs/design/ome-tiff-tile-layout.md` §5 keeps a stripped file in the corpus on purpose ("a reader that only handles the layout its own writer emits is a reader that breaks on the first third-party OME-TIFF"), and being the SAME IMAGE in the other layout makes the pair a controlled experiment for the cost claim. Measured on it, for one 512×512 level-0 tile: **36,444 bytes over 9 ranged reads stripped, 11,120 bytes over 1 read tiled** |
| `third-party-stripped.ome.tif` | **the corpus's THIRD-PARTY stripped OME-TIFF (#322)** — the same image as `spatial-image-lowres.ome.tif`, written by a writer this project does not control | classic TIFF · **Adobe DEFLATE** (`Compression = 8`, not the `32946` our writer emits) · interleaved RGB (`SamplesPerPixel=3`, `PlanarConfiguration=1`, `PhotometricInterpretation=2`) · `uint8` · **single level** 420×540 · **STRIPPED at `RowsPerStrip = 40`**, i.e. 14 strips whose LAST ONE IS SHORT · a tag set of ELEVEN tags — the STRIP tags where our writer has the TILE tags, and **no `Software`, no `XResolution`/`YResolution`, no `ResolutionUnit`**, the four tags our writer stamps on everything it emits — a layout this codebase has never produced. It is READ SUCCESSFULLY: `#322 TEST-1` resolves one 512-row viewport tile to thirteen of those strips, against ONE ranged read for the same tile of our own tiled copy, and the two tiles are equal pixel for pixel; the INDEPENDENT-decoder anchor is on the whole level-0 raster (`tifffile` digests, computed from this file and from `spatial-image-lowres.ome.tif` separately and equal), not on the tile — the Reproducibility note below says why a tile digest could not be the anchor here. See **The third-party fixture** below for exactly which bytes are whose |
| `bioformats-tubhiswt.ome.tif` | **the corpus's OME-TIFF whose `<OME>` DOCUMENT nothing of ours authored (#346)** — upstream's bytes end to end, committed verbatim from the OME sample tree under **CC BY 4.0** | classic TIFF · **UNCOMPRESSED** (`Compression = 1` — the arm of `DECODABLE_COMPRESSION` no committed byte reached before it) · `SamplesPerPixel = 1`, MINISBLACK, `uint8` · **single level** 512×512 · **STRIPPED at `RowsPerStrip = 1`**, i.e. 512 single-row strips, the corpus's extreme layout: one 512-row viewport tile resolves to **512 ranged reads** against `third-party-stripped.ome.tif`'s 13 and our own tiled emit's 1 · SIXTEEN tags, including **`SampleFormat`, which no other file here carries at all**, and `Software = "OME Bio-Formats 5.2.0-m4"`, a third writer family beside `tifffile` and Pillow · an `<OME>` document carrying `<Instrument>`/`<Microscope Manufacturer="Nikon">`/`<Detector>`/`<Objective>`/`<Experimenter>`/`<Plane>`, `DimensionOrder="XYZTC"` and multi-file `<TiffData>`+`<UUID FileName=…>` — every one of those absent from the other 21 files, measured. It is READ SUCCESSFULLY: `#346 TEST-1` decodes its whole level-0 raster against a `tifffile` digest of the same bytes, and because the image is exactly one tile edge square the TILE digest is anchored against that oracle directly — which #322's 420 px-wide fixture could not do. See **The foreign-document fixture** below |
| `spatial-image-lowres.ome.tif` | the same import's low-res image | **single level** 420×540 — the design's "a small image becomes a single-level pyramid, the trivial case of this reader" · tiled 512², i.e. a 1×2 tile grid whose every tile overhangs the image, so `tifffile` pads and the reader never sees the pad (`ImageWidth`/`ImageLength` declare the true extent). That padding case is the common one #227's own note calls out |
| `spatial-image-greyscale.ome.tif` | the shipped writer over a single-plane `uint16` array — the shape a Xenium morphology emit has | MINISBLACK · `SamplesPerPixel=1` · `uint16` · 2 levels 768×1024 → 384×512 · tiled 512² |
| `tiled-deflate.ome.tif` | **not written by this system's WRITER, but not from a third-party writer either (#322)** — the reader's third-party-tiling case, at a tile edge that is not ours. It carries `Software = tifffile.py`, so it is `ome_writer.py`'s own library driven with different keywords; the file whose WRITER is foreign is `third-party-stripped.ome.tif` | MINISBLACK · `uint8` · 2 levels 1024×1024 → 512×512 · **tiled 256²**, so one 512×512 request is four TIFF tiles rather than one. Predates #227 and is unaffected by it; documented here because it was not before |
| `unsupported-jpeg2000.ome.tif` | **the codec we refuse.** `Compression = 34712`, `uint16` MINISBLACK, 2 levels 1024×1024 → 512×512, **tiled 256²** (an earlier version of this row said 64², which the bytes never supported) | the Xenium *input* codec (#162). Never something this system emits — `LOSSY_CODECS` refuses it at write (`spatial_declarations.py:101`) — so meeting this CODEC means meeting a vendor file. Its BYTES are not a vendor's, and #322 measured that rather than leaving it implied: it too carries `Software = tifffile.py`, so what stands in for a vendor here is the codec, not the writer. geotiff.js has no decoder for it. |
| `samples-per-pixel-1.ome.tif` | the `SamplesPerPixel` family (#288), sample `s` of pixel `(x,y)` = `(37s + 5x + 3y) mod 251` | MINISBLACK · `SamplesPerPixel=1` · `uint8` · 2 levels 300×200 → 150×100 · tiled 512² · DEFLATE |
| `samples-per-pixel-2.ome.tif` | **the count the reader used to render as sample 0** | MINISBLACK · `SamplesPerPixel=2`, `PlanarConfiguration=1`, `ExtraSamples=[UNSPECIFIED]` — the header #288's repro names |
| `samples-per-pixel-3.ome.tif` | the interleaved-RGB control | RGB · `SamplesPerPixel=3` |
| `samples-per-pixel-4.ome.tif` | the interleaved-RGBA control | RGB · `SamplesPerPixel=4`, `ExtraSamples=[UNASSALPHA]` |
| `samples-per-pixel-5.ome.tif` | **the other count the reader used to render as sample 0** | MINISBLACK · `SamplesPerPixel=5`, four `UNSPECIFIED` extras |
| `samples-per-pixel-10.ome.tif` | **AT the ceiling, inclusive** — must open and render ten distinct channels. Without it the whole 6..10 band is unguarded: refusing it, or reinstating the #288 defect for it, each left the package green | MINISBLACK · `SamplesPerPixel=10`, nine `UNSPECIFIED` extras |
| `samples-per-pixel-11.ome.tif` | **over the renderer's channel ceiling** — the `SampleCountUnsupportedError` case (Viv's `MAX_CHANNELS` is 10) | MINISBLACK · `SamplesPerPixel=11`, ten `UNSPECIFIED` extras |
| `samples-per-pixel-mixed-bits.ome.tif` | **DELIBERATELY malformed** — the real `S=5` file with one tag value rewritten to `BitsPerSample = (8,16,8,8,8)`, located by `tifffile`'s own `valueoffset`. No writer emits a mixed `BitsPerSample`; this is what proves the reader REACHES its uniform-format guard rather than merely defining it | otherwise byte-identical to `samples-per-pixel-5.ome.tif` |
| `samples-per-pixel-planar-sublevel.ome.tif` | **DELIBERATELY malformed** — `PlanarConfiguration` CONTIG at level 0, SEPARATE on its SubIFD. Committed because the claim it replaces ("a shape `tifffile` will not write") was measured false | one top-level IFD, one SubIFD, the two disagreeing |
| `samples-per-pixel-mismatched-levels.ome.tif` | **DELIBERATELY malformed** — `SamplesPerPixel=2` at level 0, `1` on its SubIFD. No writer emits it; it exists because the reader validated the sample count on IFD 0 only, so such a file opened cleanly and then failed per tile with geotiff's bare `RangeError: Invalid sample index` | one top-level IFD, one SubIFD, the two disagreeing |
| `malformed-non-halving.ome.tif` | **DELIBERATELY malformed** — a two-level file whose second level is 600×450 against a 800×600 base, i.e. not the previous one halved. `NonHalvingPyramidError`'s fixture | STRIPPED · the reader REFUSES it at open |
| `mixed-codec-levels.ome.tif` | **DELIBERATELY malformed** — level 0 deflate, the reduced level JPEG-2000. It exists because checking IFD 0 alone would let such a file open cleanly and then fail per tile from inside the render loop | STRIPPED · refused at open |
| `multi-plane-channels.ome.tif` | **DELIBERATELY malformed** — channels as separate top-level IFDs rather than samples of one plane. `MultiPlaneImageUnsupportedError`'s fixture | STRIPPED · refused at open |
| `planar-rgb.ome.tif` | **DELIBERATELY malformed** — `PlanarConfiguration = 2` with `SamplesPerPixel = 3`. Without the refusal the source would advertise 3 channels and answer every one of them with plane 0 | STRIPPED · refused at open |
| `short-not-a-tiff.bin` | **512 bytes of non-TIFF.** geotiff opens EVERY file by reading a fixed 1024-byte window at offset 0, so a file shorter than that is over-asked on its very first read — and the byte plane answers an over-ask with a **416**, not a short body. This is the one fixture that exercises the header-window clamp. Its length is pinned in `pixel-oracle.json` | not a TIFF at all |
| `vendor-spot-positions.json` | the vendor's own 160 Visium spot positions in full-resolution pixels, for the overlay/registration suites | not an image |
| `emitted-manifest-entries.json` | the two image entries from the same run's real `manifest.json` | carries the real `structure` (`{"encoding":"opaque","media_type":"image/tiff; application=ome"}`) and the real `meta` placement, so a test can assert the loader's numbers against the producer's own declaration instead of against itself |

## Regenerating

```bash
python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py            # rewrite in place
python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py --check    # prove reproducible
python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py --oracle   # re-derive pixel-oracle.json
python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py --jpeg2000 # why THAT one is not regenerated
```

A permanent, committed generator (#259) — the same discipline as the `samples-per-pixel-<S>`
family below, and for the same reason it is stated there. It calls the shipped
`ome_writer.write_ome_tiff` rather than re-implementing it, and it ASSERTS every header it
produces: every level tiled at `ome_writer.TILE`, no `RowsPerStrip` anywhere, the level-0 raster
round-tripping bit for bit, and `PhysicalSizeX` unmoved. It refuses to write otherwise.

It re-emits each fixture FROM ITSELF, which is what keeps the layout and the magnitudes on
separate tracks (see the top of this file). Because the writer is lossless, that also makes it
idempotent in pixels: a second run reads back the raster it just wrote.

⚠️ **Not byte-reproducible, for one reason and only one.** `tifffile` stamps a fresh `urn:uuid`
into the OME-XML on every write, so two runs differ in ~36 bytes of that attribute and are
otherwise identical. `--check` proves exactly that, by re-emitting twice and diffing with the
UUID blanked. Normalizing it would mean post-processing bytes the writer produced, which is what
these fixtures exist NOT to do — but it means "the fixtures changed" carries no signal in a diff,
and a regeneration should be a deliberate act.

`pixel-oracle.json` is derived too, by `--oracle`, and no longer hand-maintained. Every entry
comes out of the committed bytes: the decoded-tile digests from `tifffile`, the stored tile
lengths from the artifact's own `TileByteCounts`, the JPEG-2000 SubIFD offset from its TIFF
directory, the file lengths off disk. Nothing in it is transcribed, so a fixture and its oracle
cannot drift apart. Re-running it after #259's regeneration moved NO decoded-pixel digest — the
layout moved the bytes and moved no pixel, which is #227's claim, re-checked here rather than
cited.

### What is NOT regenerated, and why

`unsupported-jpeg2000.ome.tif` is left alone deliberately. `write_ome_tiff` REFUSES a lossy
codec (`spatial_declarations.LOSSY_CODECS`), so it is not writer output and cannot be — the
fixture stands for a raw VENDOR file reaching the reader, which is the whole property it
exercises. #227 changed `write_ome_tiff`; it cannot have changed a file that function will not
produce. Independently, the committed bytes are already tiled, so there is no stripped-vs-tiled
drift in it to correct. Its `pixel-oracle.json` entries are therefore stable byte offsets, and
re-cutting it would cost them that stability for nothing — the JPEG-2000 encoder's output is not
stable across `imagecodecs` versions the way the deflate path is. Its recipe, which #259 filed as
lost with `.lifecycle/`, is recovered and printed by `--jpeg2000`.

`spatial-image-hires-stripped.ome.tif` is not generated either, and could not be: the shipped
writer has passed `tile=` at every call site since #227 and can no longer produce a stripped
file at all. It is restored by one command, which is a stricter provenance than any generator —
no `urn:uuid` caveat, byte-identical to what the importer put on disk:

```bash
git show 4cb70f45:src-app/libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif \
  > src-app/libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires-stripped.ome.tif
```

### Un-freezing the MAGNITUDES is a different act, and this is what it costs

The generator above cannot do it — that is the point of it. Re-deriving the magnitudes means
running the importer end to end, which is a decision to un-freeze, not a refresh:

```bash
cd src-app/packages
python3 -m pytest spatial-import-visium/tests/test_spatial_image.py -q --basetemp=<a temp dir>
# the emitted images and the `datatype == "spatial/image"` manifest entries are under
#   <that temp dir>/imaged-out0/
```

Rewriting `emitted-manifest-entries.json` to the post-#222 column reddens exactly three suites,
measured rather than guessed:

- `coordinateBinding.test.ts` — the `#258 TEST-5` provenance block
- `spotOverlayRegistration.test.ts` — its `microns_per_pixel` value
- [frozen-magnitude: spatial-image-hires.original_resolution_um]
  `omeTiffPyramid.test.ts` — its hand-copied `physicalSizeX = 3.7356857014116684`, whose ratio
  against the artifact's `microns_per_pixel` would stop being 5 (the frozen pitch over today's
  scale is not the ratio the assertion pins). The magnitude is deliberately not restated here:
  it is a cross-era quantity, its only content is "no longer 5", and an unexplained five-digit
  literal is the exact shape a rotted magnitude has

Also update the per-file magnitudes quoted in the `viz-core/spatial` module headers. Those are
no longer unguarded (#277): they carry `[frozen-magnitude: ...]` tags checked against these
bytes, so a change without the corresponding prose correction fails
`scripts/check-viz-producer-magnitudes.mjs` and names each stale line. Run
`node scripts/check-viz-producer-magnitudes.mjs` afterwards and let it enumerate the work.
`pixel-oracle.json` does **not** need updating for a magnitude change (see above).

## The third-party fixture — `third-party-stripped.ome.tif` (#322)

```bash
python3 src-app/libs/viz/scripts/make-third-party-stripped-fixture.py           # rewrite in place
python3 src-app/libs/viz/scripts/make-third-party-stripped-fixture.py --check   # reproducible AND not stale
```

A permanent, committed generator, for the same reason the two above are: a binary fixture whose
origin is unrecorded is a liability, and #259 found exactly one of those here (the jpeg2000
file's recipe, filed as lost with a stripped `.lifecycle/` artifact). `#322 TEST-3` runs
`--check` from this package's own suite, so the recipe is a re-run rather than archaeology and
stays that way.

### Which bytes are whose — read this before citing the fixture

The provenance IS the value of this file, so an overclaim about it would defeat the point. The
split is exact:

* **Pillow produced the TIFF.** The header, the IFD, every tag with its type/count/value layout,
  the strip geometry (`RowsPerStrip`, `StripOffsets`, `StripByteCounts`) and the DEFLATE-
  compressed strip payloads. Nothing in this repo's producer path imports Pillow, and
  `ome_writer.py` has never emitted any of these bytes.

  More precisely, because "Pillow" is one word for two code paths and the artifact says which:
  `PIL/TiffImagePlugin.py`'s `_save` sets `libtiff = WRITE_LIBTIFF or compression != "raw"`, so a
  COMPRESSED write — this one — goes to the **libtiff Pillow bundles** (4.7.1 here) rather than to
  Pillow's pure-Python IFD writer. `StripOffsets[0] = 8` with the IFD at the END of the file is
  libtiff's data-first layout, not the pure-Python path's. That is further from this project
  rather than nearer — `docs/design/ome-tiff-tile-layout.md` §5 named `libtiff` itself as one of
  the acceptable writers — but a provenance note has to name the right codebase.
* **This repo produced two INPUTS Pillow was handed.** The PIXELS — the level-0 raster of the
  committed `spatial-image-lowres.ome.tif`, i.e. our own emitted artifact's raster, read back out
  of it and passed through unchanged — and the TEXT of the OME-XML string. Pillow will not author
  OME-XML, so the `<OME>` document is **hand-written** for this fixture and handed to Pillow as
  tag 270; Pillow then writes that tag as it writes every other. The document carries no
  `urn:uuid`, no `Creator="tifffile…"` and no `cyto-spatial/1` placement payload, and its
  `Creator` names both halves of this split so the artifact carries its own story even separated
  from this file.
* **Nothing in it was produced by `ome_writer.write_ome_tiff`.**

⚠️ **And what a passing test on it therefore does NOT prove.** `loadOmeTiffPyramid` never parses
OME-XML at all (`omeTiffPyramid.ts` says so in its header, and `physicalSizeOf` takes a
caller-supplied fallback). So this fixture exercises the reader against a foreign TIFF **tag
layout** and a foreign **strip geometry** — which is what `docs/design/ome-tiff-tile-layout.md`
§5's rationale is about — and says nothing whatever about parsing a vendor's OME-XML, because
there is no OME-XML parsing to exercise. The DOCUMENT half is `bioformats-tubhiswt.ome.tif`'s job
(#346), two sections down; §5 recorded it as the remaining half of #322 until that landed.

### Why Pillow, and why not the obvious alternatives

`tiffcp`, `tiffinfo`, `bfconvert`, ImageMagick's `convert` and `vips` are not installed in this
environment and no system package can be added. `tifffile` IS installed — and is exactly the
library `ome_writer.py` writes through, so a fixture written with it would be our own writer's
output at a different call site, which is the one thing this file may not be. `imageio`'s TIFF
plugins delegate to `tifffile` or to Pillow, so they buy an import and no independence. Pillow is
a real, widely deployed, independent TIFF writer, and the tag layout it produces here is one this
codebase has never emitted.

### Why these numbers

`RowsPerStrip = 40` over a 540-row image is 14 strips whose LAST ONE IS SHORT, so the partial
final strip is exercised rather than assumed — the generator REFUSES to write a geometry whose
strip height divides the image height. 40 is deliberately none of the values already in this
corpus (not the writer's `TILE` of 512, not the pre-#227 emit's 62, not `tiled-deflate.ome.tif`'s
256), so nothing can pass here by coinciding with another fixture. DEFLATE is Pillow's
`tiff_deflate`, which emits `Compression = 8` — in the reader's decodable allowlist but a
different tag value from the `32946` our writer emits, so this is also the first committed file
that exercises that arm against real bytes. Uncompressed would have cost ~680 KB against 15 KB.

Single level, no `SubIFDs` — a limitation of the writer, and NOT one of the things that makes this
file foreign (`spatial-image-lowres.ome.tif`, our own emit and the source of these pixels, is
single-level too). Pillow cannot write SubIFDs at all, and its multi-page mode writes SEPARATE
TOP-LEVEL IFDs, which this reader refuses by name (`MultiPlaneImageUnsupportedError`). A single-level file is legal on the reader's
own terms and `spatial-image-lowres.ome.tif` is already one. Byte-surgering SubIFDs in was
rejected: the moment the tag layout is hand-edited it stops being Pillow's, which is the one
property this fixture exists to have. So the SubIFD walk on a stripped layout stays covered by
`spatial-image-hires-stripped.ome.tif` (#259 TEST-3 decodes its coarsest level); it is simply not
this file's job.

### Reproducibility

Deterministic, and with no `urn:uuid` caveat — that stamp is `tifffile`'s, and this file is not
`tifffile`'s. Two runs in one environment are byte-identical, so `--check` compares fresh-vs-fresh
AND fresh-vs-COMMITTED and a diff in these bytes carries real signal, unlike the two families
above.

It is NOT version-independent: the bundled libtiff's and zlib's DEFLATE output are theirs to
change. The committed bytes were produced under **Pillow 12.2.0 / libtiff 4.7.1 / zlib 1.2.11**,
recorded in the generator as `RECORDED_PILLOW`/`RECORDED_LIBTIFF`/`RECORDED_ZLIB` and printed
alongside the RUNNING versions whenever `--check` finds a byte difference, so a toolchain drift
reads as a toolchain drift instead of as corruption. libtiff is recorded separately and
deliberately: it is the library that actually lays the bytes down, and `zlib.ZLIB_VERSION` is
CPython's compile-time zlib rather than necessarily the one libtiff links (they coincide here), so
a libtiff-only bump would otherwise print two IDENTICAL version pairs and send the reader looking
for a moved raster. That is deliberately a hard failure and not a skip, on the rule
`make-emitted-image-fixtures.py --check` already runs under.

`pixel-oracle.json` is not written here, and the entries it carries for this file are WHOLE-LEVEL
rasters rather than tiles, for a measured reason: this image is 420 px wide, so EVERY 512-edge tile
of it overhangs, and the oracle's tile helper zero-pads an overhang (what `tifffile` is asked for)
while the reader clips it to `ImageWidth` (what the file declares). A padded tile digest could
therefore never equal a read one, and asserting it would have been an assertion about the padding
convention rather than about the pixels.

This fixture's entries — its byte length, its
`RowsPerStrip`, its strip count and its level-0 raster digest, plus the same digest computed
independently from `spatial-image-lowres.ome.tif` — are derived by `tifffile` in
`make-emitted-image-fixtures.py --oracle`, so the oracle stays a single, purely `tifffile`-derived
artifact and no Pillow version leaks into it. Their EQUALITY is the corpus measurement `#322
TEST-1` rests on: the same pixels through two unrelated writers.

## The foreign-document fixture — `bioformats-tubhiswt.ome.tif` (#346)

```bash
python3 src-app/libs/viz/scripts/fetch-vendor-ome-fixture.py --check   # offline: identity + headers
python3 src-app/libs/viz/scripts/fetch-vendor-ome-fixture.py --fetch   # network: re-download and diff
```

### PROVENANCE — every byte is upstream's

| | |
|---|---|
| **source** | <https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/tubhiswt-2D/tubhiswt_C0.ome.tif> |
| **licence** | **Creative Commons Attribution 4.0 International (CC BY 4.0)** — <https://creativecommons.org/licenses/by/4.0/> |
| **licence stated at** | `.../tubhiswt-2D/readme.txt`, full text at `.../tubhiswt-2D/COPYING` |
| **credit** | *"Sample OME-TIFF files (c) by the OME Consortium"* |
| **retrieved** | 2026-09-09 (fetched twice from a clean path, byte-identical) |
| **sha256** | `a1d99f0651baad26a6b5004c115a9c3f4e33d3d6e0b279b34cabbbe88d813ef2` |
| **bytes** | 269,568 |

CC BY 4.0 permits redistribution, including commercially, on attribution — which is why this
directory may hold the file, and why the credit line above is here rather than only in a commit
message. The digest and the byte length are ALSO in `pixel-oracle.json`
(`vendor_ome_xml_sha256`, `vendor_ome_xml_byte_length`) and in the script, deliberately in three
places: the script refuses a bad file, the oracle refuses a stale oracle, and `#346 TEST-1` asserts
both before it asserts anything else.

**Nothing in this repository produced any byte of it.** Not generated, not converted, not trimmed,
not re-encoded — and that is load-bearing rather than tidy. The whole property this file exists to
carry is an `<OME>` document composed OUTSIDE this project; the moment one of our tools rewrites it
to make it smaller, that document is ours again and the file is worth nothing. It is the one
fixture here that has no generator, and the one for which that is correct: for a downloaded
artifact the recipe is a URL and the check is a checksum, which is exactly what the script is, and
what `#346 TEST-3` runs.

### What it adds that the rest of the corpus cannot

#322's `third-party-stripped.ome.tif` closed the WRITER half of
`docs/design/ome-tiff-tile-layout.md` §5 — a foreign tag layout and a foreign strip geometry — and
its own provenance note is explicit that it could not close the other one: Pillow will not author
OME-XML, so that file's `<OME>` block is our generator's hand-written string. Measured against the
directory, this file is the first and only one carrying each of:

* **an `<OME>` document written by software outside this project** — `Creator="OME Bio-Formats
  5.2.0-m4"`, over a real acquisition, with `<Instrument>` /
  `<Microscope Manufacturer="Nikon" Model="Eclipse TE300">` / `<Laser>` / `<Detector>` /
  `<Objective>` / `<Experimenter>`, `<Plane TheC/TheZ/TheT>`, `DimensionOrder="XYZTC"`, and
  `<TiffData>` elements whose `<UUID FileName=…>` children name **two files**. `#346 TEST-2` scans
  each marker over every `.ome.tif` in this directory and asserts the carrying set is exactly this
  one file — so the claim is a measurement, not a list, and a marker that started appearing
  elsewhere reddens as loudly as one that vanished;
* **`Compression = 1`** — uncompressed. That arm of the reader's `DECODABLE_COMPRESSION` allowlist
  has been there since #158 and, until this file, no committed byte reached it;
* **`RowsPerStrip = 1`** — 512 single-row strips. One 512-row viewport tile therefore resolves to
  **512 ranged reads**, against 13 for #322's fixture and 1 for our own tiled emit of a comparable
  image. The corpus's extreme of the layout §5 keeps a fixture for;
* **a `SampleFormat` tag.** #322 measured tag 339 as *"absent from EVERY fixture in this corpus"*
  and declined to project it for that reason. True then; false now, and `#346 TEST-1` re-measures
  it over the directory rather than restating it. It matters because `assertUniformSampleFormat`
  has a whole arm for that tag — its length must equal `SamplesPerPixel` — which until now ran only
  against hand-built directories;
* **`Software = "OME Bio-Formats 5.2.0-m4"`** — a third writer family beside `tifffile` and Pillow,
  and a stronger statement than #322's fixture makes: that one has no `Software` tag at all.

### The DOCUMENT and the CONTAINER disagree, and that is the point

The `<OME>` document declares `SizeC="2"` and two `<TiffData>` elements naming
`tubhiswt_C0.ome.tif` and `tubhiswt_C1.ome.tif`. This directory holds C0. So:

* `tifffile.imread` — an **OME-XML-aware** decoder — parses the document, goes looking for the
  sibling file, does not find it, and returns a `(2, 512, 512)` array with the second plane
  **zeroed**, after logging a `FileNotFoundError`;
* `loadOmeTiffPyramid`, which never parses OME-XML, returns the ONE plane the container holds and
  reports ONE channel.

`#346 TEST-2` pins that divergence directly, deriving `SizeC` and both filenames from the file's
own bytes rather than typing them. It is the single most useful thing a foreign document can buy
while there is still no parser in the module: if an OME-XML path were ever wired in without
handling multi-file `<TiffData>`, that test goes red — it would report two channels, the second of
them a plane this file does not contain. For the same reason the oracle digests the **page**, not
the series: digesting the series would bake a half-zero array and a warning into the corpus.

### What this is NOT, and what was searched for

**Bio-Formats is the OME reference implementation, not an instrument vendor's own writer.** The
pixels and the instrument metadata are a real acquisition's; the container is Bio-Formats'. #346
names *"a Bio-Formats export"* as one of the shapes it wants, and this is that one. A file written
by an INSTRUMENT'S OWN OME-TIFF writer — a 10x Xenium morphology TIFF is the standing example
— is a further step and is not in this directory.

What was checked while looking for one, so the next attempt starts from the answers rather than
from the search:

| where | licence | verdict |
|---|---|---|
| `downloads.openmicroscopy.org/images/OME-TIFF/2016-06/` — `tubhiswt-*`, `bioformats-artificial`, `companion`, `binaryonly`, `modulo`, `plate-companion`, `MitoCheck`, `sub-resolutions` | **CC BY 4.0**, stated per directory in `readme.txt` with the full text in `COPYING` | **usable.** Redistribution permitted with attribution |
| the same tree's `BBBC017/` | **CC BY-NC-SA 3.0** | **rejected — non-commercial.** Worth knowing that sibling directories under one root are NOT uniformly licensed; check the `readme.txt` beside any file before adding another one |
| `sub-resolutions/{Brightfield,Fluorescence,EM,Z-stack}` — real Leica SCN, PerkinElmer Vectra, EM and confocal scans, converted by `bfconvert` **with real `SubIFDs` pyramids** | CC BY 4.0 | **usable but unusable HERE at 225 MB – 2.6 GB.** A trimmed derivative is the only way in at fixture size, and trimming means one of our own tools rewriting the file — which destroys the one property it would be committed for. That trade is why this corpus takes a 269 KB single-level file whose every byte is upstream's over a small derivative of a big one, and it is also why the corpus still has no foreign PYRAMID |
| `downloads.openmicroscopy.org/images/Micro-Manager/1.4.22/thomas/test/` — **written by Micro-Manager itself**, i.e. by ACQUISITION SOFTWARE rather than by the OME reference toolkit, with an OME-XML in the older `2015-01` namespace | CC BY 4.0 (Thomas Julou) | **usable, licence-clean, and REFUSED BY THE READER.** These are the closest thing on that server to an instrument-authored document, and both viable files are Micro-Manager `MMStack`s: measured, `test2_stack/MMStack_Pos0` has **4** top-level IFDs and `test_stack/test_stack_MMStack_Pos0` has **8**, and `loadOmeTiffPyramid` refuses both by name — `MultiPlaneImageUnsupportedError: this OME-TIFF holds 4 image plane(s)`. (Named without their `.ome.tif` suffix on purpose: `#259 TEST-7` requires every such name in this file to be a file ON DISK, and these are upstream's, not this directory's — the guard caught exactly that when this row was first written.) This directory already holds four fixtures the reader refuses; a fifth adds nothing, which is why the file that landed is the one that is READ. They are the strongest candidates the day the reader learns multi-plane files, and they are 2.8 MB each in the working tree |
| 10x Genomics public datasets (the Xenium morphology TIFF) | **not established** | **rejected on TWO independent grounds, and the second one matters more than the licence.** (a) Their terms pages sit behind a bot wall (HTTP 429 from a shell, a "Security Checkpoint" shell from a browser agent, archive.org blocked), so no grant of REDISTRIBUTION was confirmed. Several indexed dataset pages report CC BY 4.0 and there is third-party repackaging precedent, and the restrictive 10x language found applies to SOFTWARE rather than to datasets — suggestive, not sufficient, and a committed binary needs sufficient. (b) **A Xenium morphology TIFF is not vendor-WRITTEN.** Measured on the smallest one located (216 MB, `morphology_mip`; `morphology_focus` 221 MB; `morphology` 2.1 GB — all BigTIFF): its OME-XML carries `Creator="tifffile.py 2021.4.8"`. The vendor identity is `<Microscope Manufacturer="10x Genomics" Model="Xenium"/>` INSIDE a document written by the same library `ome_writer.py` writes through. So the example #346 names would have failed this corpus's own provenance test for the same reason `tiled-deflate.ome.tif` and `unsupported-jpeg2000.ome.tif` did |
| Zenodo / figshare | — | **not exhausted.** Unreachable from this environment; a genuinely open avenue rather than a cleared one |

⚠️ **Presence on the OME download server is NOT a licence grant, and the grant is per contributor
directory rather than per format.** Measured across that server: `Leica-XLEF/` (all 16 dataset
directories), `MetaXpress/`, `ScanR/`, `gateway_tests/`, `u-track/`, several sub-directories under
otherwise-licensed formats (`CellSens/evident`, `CV7000/cpg0016`, `InCell2000/INMAC384-*`,
`ND2/imagesc-92810`, `PerkinElmer-Operetta/59548` and `/59549`) and the loose files at the `DV/`
root carry **no `readme.txt`, no `COPYING` and no `LICENSE` anywhere in the tree** — so nothing
grants redistribution for any of them. `/images/Micro-Manager/` and `/images/Olympus-OIR/` 404 on
`readme.txt` at their own level; the grant is one or two directories down. Confirm the NEAREST
`readme.txt` plus `COPYING` before taking anything from there, the way this file records them
above.

**THE CONCLUSION OF THAT SEARCH, STATED AS A RESULT AND NOT AS A FAILURE.** Two independent
exhaustive crawls — the whole `downloads.openmicroscopy.org` tree (52 top-level directories,
~478k files) plus Zenodo, IDR, `tifffile`, `bioio`, QuPath, Fiji, the Allen Institute and
OpenSlide — put the combination **"an instrument-or-acquisition-software's own writer" + "one
top-level IFD" + "fixture-sized"** at an EMPTY SET. Exactly eight `.ome.*` files exist on that
server outside the `OME-TIFF/` and `OME-XML/` trees; three are `bfconvert` output
(`Creator="OME Bio-Formats 5.2.0-DEV"`) and five are Micro-Manager's, and every one of the five is
multi-IFD or hundreds of megabytes. Every single-IFD OME-TIFF located anywhere was written by
Bio-Formats. No CC0 OME-TIFF was found at all: OpenSlide's CC0 files are real vendor artifacts but
are SVS/NDPI/MRXS/CZI, never OME-TIFF, and its Leica set is labelled `distributable`, which is an
undocumented non-licence rather than CC0 whatever a search result says. So this fixture is not a
compromise reached early — it is the best member of a set that was enumerated.

**And the sibling is deliberately NOT committed.** `tubhiswt_C1` is the same size, the same
licence and one directory away, and committing it would resolve the document's second
`<TiffData>` — which would remove the divergence `#346 TEST-2` exists to pin, and double the
fixture's cost to remove a property. The dangling reference is not a defect here; it is the
measurement. `loadOmeTiffPyramid` never follows it, because it never reads the document at all.

The shape of the reader narrows the search more than the licence does, and it is worth recording
why so few real files qualify: a multichannel acquisition stores its channels as **separate
top-level IFDs**, which `loadOmeTiffPyramid` refuses by name (`MultiPlaneImageUnsupportedError`).
So "a foreign OME-TIFF" and "a foreign OME-TIFF this reader READS" are different searches, and
four fixtures here are already shapes the reader refuses — another refusal would have added
nothing. This file was chosen for the second search: one IFD, `SamplesPerPixel = 1`, a codec on the
allowlist. Its being one file of a MULTI-FILE set is what makes its document interesting rather
than a problem.

### Two things in the document that a reader of this file should know about

**It embeds a real personal email address** (the `<Experimenter Email=…>` element) and a named
person's affiliation. That is upstream's artifact as published by the OME Consortium under CC BY
4.0, and it is one of the things the verbatim rule costs: redacting it would mean editing the
document, which destroys the only property the file is committed for. It is recorded here rather
than discovered later. If that trade is judged wrong, the fix is to drop the fixture and reopen
the search, not to edit the bytes.

**Its `<Detector Manufacturer="Hamamatzu">` is misspelled.** Upstream's typo, in the file. Do not
"fix" it — and do not write an assertion that depends on the correct spelling.

### One thing found here and NOT fixed: the document is not ASCII

Measured while building the mutation battery for `#346 TEST-1..TEST-3`. The first attempt at the
"someone regenerates this through our own library" mutation **could not write the file at all**:

```
ValueError: TIFF strings must be 7-bit ASCII
```

`tifffile` refuses a non-ASCII TIFF string, and this document carries one —
`WorkingDistanceUnit="µm"` on the `<Objective>` element. So the most likely regression cannot even
preserve the document, quite apart from the five tests that catch it. (The battery's recorded row
is that mutation run again with the one character replaced, so it measures the tests rather than
the encoder.)

That is worth recording rather than only noticing, because it is the first REAL vendor-authored
text in this tree and it lands squarely in the class #329/#330 is about: vendor strings that our
own writers cannot encode. Nothing here connects the two — this byte sits inside a binary
`.ome.tif` that no text guard scans, and the reader never decodes the description at all. It is
noted as an observation about the corpus, not as a claim that anything is checked.

### A measurement it made on #322's own guard

`#322 TEST-2` ran three "producer stamps" and asserted the AND across them, on the stated
understanding that they were near-perfectly correlated. One of the three scanned for `urn:uuid:`
as a `tifffile` signature. **It is not one.** `urn:uuid:` is the OME-TIFF specification's own
document identifier and Bio-Formats writes one, so 21 of the 22 committed `.ome.tif` here carry it
and the ONLY one that does not is `third-party-stripped.ome.tif` — whose document our own generator
hand-composed without one. That predicate never probed a writer.

It is kept rather than deleted (it still fires on a hand-swapped description in #322's fixture),
but `#322 TEST-2` now gives each predicate the set it actually discriminates instead of an AND
across three, and asserts separately that the one stamp which DOES probe a writer — the `Software`
TIFF tag, stamped by the code that lays the bytes down — is absent from exactly the files in
`FOREIGN_WRITER_FIXTURES`.

## The `samples-per-pixel-<S>` family (#288)

```bash
python3 src-app/libs/viz/scripts/make-sample-count-fixtures.py
```

A permanent, committed generator, for the reason above. It is deterministic (a closed form, no
RNG), it CALLS the shipped writer's own `_sample_layout` for the counts that writer emits
(`READABLE_SAMPLE_COUNTS == (1, 3, 4)`) so those three cannot drift from what the importer
writes, and it ASSERTS every header it produces rather than trusting the keywords it passed.

For `S ∈ {2, 5, 11}` the writer REFUSES (#266), so there is nothing to call. Those three use the
arm `ome_writer._sample_layout`'s own docstring documents as the one that would emit them if that
refusal were lifted — `minisblack` + `planarconfig="contig"`, *"how TIFF spells 'S interleaved
samples, no colour claimed'"* — and `docs/design/ome-tiff-sample-classification.md` §3 states
`tifffile`'s contract for it. **Committing these bytes does not lift #266's refusal**; it is what
lets the READER be taught first, which is the ordering #288 states.

The one writer parameter the generator overrides is `min_side` (256 → 64), so a 300×200 base
still carries a real `SubIFDs` pyramid at a few kilobytes. That changes the number of LEVELS,
never the classification.

The pixels are `(37s + 5x + 3y) mod 251` as `uint8`, re-derived independently in
`sampleCountFixture.ts` — 251 is prime and coprime with 37/5/3, so sample 0 substituted for
sample `c` differs in EVERY pixel and a partial render cannot pass as a near-miss. Level 1 is the
writer's 2×2 box mean, rounded half-to-even (`np.rint`, NOT `Math.round`).

These files carry no OME `PhysicalSizeX/Y` and no placement, so they are outside
`check-viz-producer-magnitudes.mjs`'s claim surface entirely — regenerating them cannot move a
producer magnitude.

⚠️ **The generator is not byte-reproducible.** `tifffile` stamps a fresh `urn:uuid` into the
OME-XML on every write, so a re-run rewrites all committed binaries for ~10 bytes each. That is
cosmetic and is left alone — normalizing it would mean post-processing bytes the writer produced,
which is what this family exists NOT to do — but it means "the fixtures changed" carries no signal
in a diff, and a regeneration should be a deliberate act, as this directory's frozen-fixture rule
already says.
