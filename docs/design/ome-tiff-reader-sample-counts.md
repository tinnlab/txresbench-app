# OME-TIFF reader sample counts — what `omeTiffPyramid` must do with `SamplesPerPixel` (#288)

**Status:** accepted. **Owner:** the reader (`src-app/libs/viz/src/viz-core/spatial/omeTiffPyramid.ts`).
**Derived from:** `docs/design/ome-tiff-sample-classification.md` §3 — *"What this system EMITS,
and why a correct header is not sufficient"* — and its **INV-5**, which is the invariant this
document exists to discharge. That design says, in as many words, what closes it:

> Lifting it is **#288** (teach the reader), at which point `READABLE_SAMPLE_COUNTS` is the one
> line to change and the header logic is already correct for it.

This document is the reader half. It also carries a second, unrelated-looking item that is the
same defect class one layer up — a *prose* claim that was true when written and is now false
(#294) — because the mechanism that stops it recurring belongs in the same package.

## 1. What the reader promises

`omeTiffPyramid.ts` states its own contract beside the guard that enforces it
(`MultiPlaneImageUnsupportedError`):

> Refused by NAME rather than read partially, and that is the whole point of it existing. The
> pyramid this loader returns declares a channel axis, and `buildRasterImageLayers` derives one
> selection per channel from it; a loader that returned a source whose declared channel count it
> cannot honour would render channel 1 with channel 0's pixels — the same "right pixels, wrong
> meaning" class the halving guard refuses, and strictly worse than the codec refusal beside it,
> because nothing would say so.

Two of its three guards honour that. `getImageCount() > 1` and `PlanarConfiguration == 2` both
refuse by name. The third — the interleave rule — does not refuse at all.

## 2. The defect, measured

`const interleaved = samples === 3 || samples === 4` is Viv's `isInterleaved`, and the values
`{3, 4}` are hard-coded inside `@vivjs/loaders` at every site that matters:
`TiffPixelSource._readRasters` (which decides `interleave:` and then takes `raster[0]`),
`getImageSize` (which slices the shape `-3` or `-2`), and four branches of `@vivjs/layers`
(BitmapLayer vs XRLayer). A trailing sample axis of 2 or 5 is *false* to all of them.

So for `SamplesPerPixel ∉ {3, 4}` the loader declares `[1, height, width]` and Viv returns
`raster[0]`. Measured on `origin/main` at `20ff18e5`, over the six committed
`samples-per-pixel-<S>.ome.tif` fixtures (`300x200`, two levels, DEFLATE, tiled 512x512),
through the real `loadOmeTiffPyramid` and a real `getRaster`/`getTile`:

| `SamplesPerPixel` | declared `shape` | bytes returned for `{c: 0}` | what is drawn |
|---|---|---|---|
| 1 | `[1,200,300]` | 60,000 | correct — the one plane |
| **2** | `[1,200,300]` | 60,000 | **sample 0, silently** |
| 3 | `[1,200,300,3]` | 180,000 | correct — interleaved RGB |
| 4 | `[1,200,300,4]` | 240,000 | correct — interleaved RGBA |
| **5** | `[1,200,300]` | 60,000 | **sample 0, silently** |
| **11** | `[1,200,300]` | 60,000 | **sample 0, silently** |

The three bad rows are byte-identical to the `S = 1` row: the decoded buffer for `S = 2` and
`S = 5` is exactly `plane(0)`, so a viewer shows a picture that is a plausible greyscale image
of something the file does not claim to be. No refusal, no console warning, no wrong size.

This matters *now* because #266 made those files well-formed. Before it, a `(H, W, 2)` array
emitted 300 top-level IFDs and hit `MultiPlaneImageUnsupportedError` by accident.

## 3. The rule

**The trailing axis is not the only way to spell "N samples".** A file with `SamplesPerPixel = N`
and `PlanarConfiguration = 1` is N samples interleaved in one plane; whether they are *colour* is
a separate statement (`PhotometricInterpretation`). Viv can only render the colour reading of
that — RGB/RGBA through a `BitmapLayer` — but its OTHER path, the per-channel `XRLayer`, renders
an arbitrary channel stack, and the only thing standing between the two is the SHAPE this loader
declares. A source declared `[N, height, width]` with labels `['c','y','x']` takes the XRLayer
path, and `buildRasterImageLayers` already issues one selection per channel from it.

What is missing is a reader that can answer `{c: i}` with **sample i**. Viv's
`TiffPixelSource` cannot: it calls `image.readRasters({interleave})` and takes `raster[0]`, i.e.
sample 0, for every selection. But its `_indexer` is handed the SELECTION, so a per-sample view
of the `GeoTIFFImage` — one whose `readRasters` forces `samples: [i]` — makes the existing
`TiffPixelSource` correct for any N without forking its tile-extent maths, its abort handling or
its `SIGNAL_ABORTED` contract.

That yields one rule, with no case left to fall through:

| `SamplesPerPixel` | shape | labels | channels | render |
|---|---|---|---|---|
| `< 1`, or non-integer | **REFUSED** | | | a zero-sample file is not an image |
| 1 | `[1,h,w]` | `['c','y','x']` | 1 | greyscale plane. **Unchanged.** |
| **2** | `[2,h,w]` | `['c','y','x']` | 2 | per-sample channel stack (XRLayer) |
| 3 | `[1,h,w,3]` | `['c','y','x','_c']` | 1 | interleaved RGB (BitmapLayer). **Unchanged.** |
| 4 | `[1,h,w,4]` | `['c','y','x','_c']` | 1 | interleaved RGBA (BitmapLayer). **Unchanged.** |
| **5 … 10** | `[N,h,w]` | `['c','y','x']` | N | per-sample channel stack (XRLayer) |
| **> 10** | **REFUSED** | | | over the renderer's ceiling — §4 |

Three facts about the file must hold for that rule to be safe, and all three are checked at the
open call rather than discovered per tile — the standard `assertDecodableCodec` already sets:

* **the sample count is the same on every pyramid level.** It was checked on IFD 0 only in the
  first cut, and `sampleView` closes over the level-0 count, so a level declaring fewer samples
  rejected with geotiff's bare `RangeError: Invalid sample index 'k'` — untyped, per tile,
  naming no file, level or channel. Measured on a hand-built `S=2`-over-`S=1` file: it opened
  with no refusal and declared level 1 as `[2, h, w]` over one-sample bytes, i.e. a shape
  contradicting its own bytes, which is INV-2 verbatim. `samples-per-pixel-mismatched-levels.ome.tif`
  is that file, committed.
* **the per-sample format tags are PRESENT, COVER every sample, and AGREE.** `BitsPerSample` and
  `SampleFormat` are per-sample arrays in TIFF 6.0 and geotiff honours them
  (`getArrayForSample(k)` builds channel k's output from `getSampleFormat(k)`/
  `getBitsPerSample(k)`, and `getBytesPerPixel()` sums the whole array for the stride), while the
  source declares ONE `dtype`. **Three** refusals, not two, and each was measured on a real
  fixture with the tag edited:
  * ABSENT `BitsPerSample` → `TypeError: Cannot read properties of undefined`, per tile. geotiff
    has no default for it. An absent `SampleFormat` is exempt — that one it DOES default, to 1 —
    and every committed pyramid level in this package omits it, so the exemption is load-bearing
    rather than a courtesy.
  * A LENGTH that is not `SamplesPerPixel`, in EITHER direction. The length is the pixel STRIDE
    (`getBytesPerPixel()` sums the whole array), so any mismatch decodes wrong pixels. Measured
    against the vendored geotiff by rewriting the tag on a real committed fixture and reading 8
    pixels of row 0, against the family's own closed form `0,5,10,15,20,25,30,35`:
    `BPS=[8,8,8] SPP=1` → `0,15,30,45,…`, silently wrong; `BPS=[8,8] SPP=3` → `0,74,42,10,…`,
    silently wrong, and channel 2 throws `Unsupported data format/bitsPerSample`;
    `BPS=[8,8,8,8] SPP=3` → all three channels wrong and **nothing thrown at all**. That last row
    is why the rule is `!==` and not `<`: a short tag at least fails loudly for the samples it
    does not cover, and a long one does not fail anywhere.
  * MIXED (`[8,16,8,8,8]`) → channel 1 comes back a `Uint16Array` under a source, and a layer via
    `dtype: loader[0].dtype`, saying `Uint8`.

  All three run at EVERY sample count, including 1, 3 and 4 — see §6, which records what that
  means for the rows this table marks "Unchanged". `samples-per-pixel-mixed-bits.ome.tif` is the
  real 5-sample fixture with that one tag's value bytes rewritten (located by `tifffile`'s own
  `valueoffset`, so the patch is not a hand-counted guess): `tifffile` refuses to write a mixed
  `BitsPerSample` outright, so a malformed vendor directory is the only way it arrives, and a
  committed instance is what proves the reader REACHES the guard rather than merely defining it.
  The planar-sub-level arm gets a REAL fixture (`samples-per-pixel-planar-sublevel.ome.tif`)
  rather than a hand-built literal, because the claim that `tifffile` would not write one was
  measured false.
* **no level is `PlanarConfiguration = 2`**, re-checked per level for the same reason as the
  first bullet.

`3` and `4` keep the interleaved BitmapLayer path deliberately. They are the only two counts
`PhotometricInterpretation` gives a colour meaning that Viv implements, the writer emits them as
`rgb`, and routing them through the channel stack instead would replace true colour with an
additive R/G/B composite — a *visible* change to every H&E raster this system ships, in a change
whose entire purpose is the counts that render wrong. The reader's job here is to stop being
silently wrong on 2 and ≥5, not to re-render what is already right.

### Why 2 is DISPLAYED and not refused

A 2-sample vendor TIFF is greyscale plus one extra sample, and the writer emits
`ExtraSamples = [UNSPECIFIED]` for it — the tag value that means *the file does not say what this
sample is*. Displaying it as a second channel shows the operator both samples and lets them turn
either off; refusing shows neither. The one reading that would justify dropping sample 1 is
"it is alpha", and the file explicitly declines to claim that. Where a file DOES claim it —
`S = 4` with `UNASSALPHA` — this design leaves the existing RGBA path alone.

### What this reader still does NOT read: `ExtraSamples` and `PhotometricInterpretation`

Stated as a residual rather than left to be discovered, because it is the reader-side twin of a
gap the writer already carries. The classification above is a function of `SamplesPerPixel`
ALONE. The two tags that say what the samples MEAN are not consulted, so:

* a `SamplesPerPixel = 2` MINISBLACK file whose `ExtraSamples` declares `ASSOCALPHA`/`UNASSALPHA`
  — greyscale plus alpha, a real vendor layout — is read as a 2-channel stack rather than as an
  image plus its alpha. On the pyramid path that is defensible (both samples are shown and either
  can be switched off); on the single-texture path a *varying* alpha would brighten the picture.
  A *constant* alpha, which is the common case, contributes nothing after §5's rule.
* an `RGB` file with `S >= 5` (RGB plus extras) is read as a grey stack rather than as colour.
  Viv's `isInterleaved` is hard-wired to `{3, 4}`, so there is no colour path available for it;
  the alternative to a stack is a refusal, and a stack shows every sample where a refusal shows
  none.

Both are STRICTLY better than what preceded them, which was sample 0 drawn as the whole image.
Closing them means reading `ExtraSamples`/`PhotometricInterpretation` and deciding what a
declared alpha should DO, which is the same question `ome-tiff-sample-classification.md` records
as the residual of its own `S == 4` arm and files as **#289** (*"`read_image` and `read_plane`
both discard the source's `PhotometricInterpretation` and `ExtraSamples`"*). It belongs there,
with the writer half, not bolted onto this one.

## 4. The ceiling is the RENDERER's, and it is Viv's `MAX_CHANNELS`

`@vivjs/constants` fixes `MAX_CHANNELS = 10` (re-exported by `@hms-dbmi/viv`, and **imported**
here rather than restated as a literal — a hard-coded copy of someone else's constant is exactly
the rot the `[frozen-magnitude]` tags in this directory exist to prevent). `@vivjs/layers` throws
`` `${n} channels passed in, but only ${MAX_CHANNELS} are allowed.` `` from
`padContrastLimits` — i.e. from inside deck.gl's render loop, once per tile, with nothing naming
the file. That is the same failure `assertDecodableCodec` exists to move forward: a condition
knowable at OPEN time surfacing per-tile from a render loop.

So `> MAX_CHANNELS` is refused at the open call, by name, naming the count and the ceiling. It is
a real reduction versus "draw sample 0", and it is the honest one: this application cannot render
an 11-channel stack, and saying so is strictly better than showing one channel of it.

**Both sides of that boundary are committed fixtures**, and that is not symmetry for its own
sake: with the family stopping at 5, a blind audit showed that refusing 6..10 instead of
displaying them, AND reinstating the #288 defect for 6..10, each left every test in the package
green. `samples-per-pixel-10.ome.tif` must OPEN and render ten distinct channels;
`samples-per-pixel-11.ome.tif` must be REFUSED. Taking the constant from Viv rather than copying
it means a Viv upgrade that moved the cap reddens one of those two.

The refusal class is **exported** from the package (unlike its sibling
`MultiPlaneImageUnsupportedError`), because a consumer has to be able to tell "this application
cannot render that many channels" from "the artifact could not be opened" — the app's catalog
currently collapses every unclassified refusal into `hasImage: false` plus one `console.warn`,
which is an empty pane with no reason. Classifying it there is an app-side follow-up.

## 5. The single-texture half

`omeTiffUnderlay` is the OTHER render path — the coarsest-level RGBA texture
`DataSource.imageUnderlay()` returns — and it has the same defect from the other end. It reads
`level.getRaster({selection: {c: 0}})` and, for a source it believes is single-channel, windows
that one buffer into grey. Handed a 2- or 5-sample file it would draw sample 0 and call it the
image, exactly as the pyramid path did.

Its own module header already names the case:

> `samples` is the stride, and today it is ALWAYS 1 here — the loader sets `interleaved` only for
> 3 or 4 samples, and both take the colour branch above, so a planar raster is single-sample by
> construction. […] a loader change that admitted a 2-sample interleaved file would make the
> difference real.

This is that change. For a planar source with `channels > 1` the reduction reads EVERY channel,
windows each on its own extremes, and takes the per-pixel MAXIMUM into grey — one plane resident
at a time, because the single-texture cap bounds the OUTPUT and a 10-channel `Uint16` stack at
that cap is ~84 MB of inputs against a 16.8 MB texture, on the call that runs when a project is
opened. Stated as the display decision it is, on the same terms the file already states its
greyscale windowing:

* every sample contributes, so no sample is dropped without a refusal — which is the whole point;
* nothing is invented. A colour assignment (channel 0 → red, …) would be a fabrication about data
  this function has been told nothing about, and the fallback texture is not where a user gets
  per-channel control anyway — `imagePixelSource()` is, and it now serves N real channels;
* **a channel with no structure contributes nothing, rather than 128.** The single-plane branch
  maps a zero-span plane to mid-grey, which is right when that plane IS the image and wrong as a
  contributor to a maximum, where it becomes a FLOOR. Measured on an 8-pixel probe: a ramp
  windowing to `[0,36,73,109,146,182,219,255]` became `[128,128,128,128,146,182,219,255]` beside
  one blank channel — half the picture flattened by a channel carrying no information. One dead
  channel in a 10-plex panel is the norm. An ALL-constant stack still reads mid-grey, so the
  single-plane convention is preserved for the case it was written for.

The channel COUNT comes from the loader (`OmeTiffPyramid.channels`) and the served level's own
`'c'` axis is the CHECK on it, not a second derivation of it — one route to one fact (#214),
because a re-derivation reading 1 where the loader declared 5 would reduce from sample 0 and
report nothing, which is the defect this branch exists to close.

## 6. What this change is NOT

**It is not a writer change.** `READABLE_SAMPLE_COUNTS` stays `(1, 3, 4)` and #266's refusal
stands. Reader and writer are two packages, and #266's refusal is what currently protects users;
lifting it is a one-line follow-up that should ride its own branch, with its own round-trip
evidence, once this reader is on `main`. Deliberately recorded rather than done here.

**It is not a change to what 3- and 4-sample images look like** — but it is not *nothing* for
them either, and the earlier wording ("byte-for-byte the ones that shipped") did not survive the
hardening round, so it is corrected rather than left. Their classification, shape, labels,
channel count and render path are unchanged. What CAN now reach them are two refusals that
reject a malformed file which previously opened:

* a 3- or 4-sample directory that carries NO `BitsPerSample`, or whose
  `BitsPerSample`/`SampleFormat` is not uniform, or is not exactly `SamplesPerPixel` long (a
  legal-ish TIFF with 16-bit colour and an 8-bit alpha is refused);
* a 3- or 4-sample pyramid whose SubIFD omits `SamplesPerPixel`, or declares a different one.

Both are files this reader could not have rendered correctly anyway — the first hands the layer
one sample's bytes under another's declared type, the second fails per tile with an untyped
`RangeError`. Verified: every committed 3/4-sample fixture and both shipped `spatial-image-*`
artifacts are uniform with matching SubIFDs, and the package suite is green.

**It does not make Viv render more than 10 channels.** The ceiling is a vendored constant; this
change surfaces it at the open call instead of in the render loop.

## 7. The prose half (#294)

`spotOverlayRegistration.test.ts` states:

> the shipped vendor `tissue_hires_image.png` is 200x200 […] There is NO committed artifact in
> this repo where a real tissue image and its real spots are geometrically coherent.

#243 falsified that: the fixture is 10x's own 2000x2000 emission and all 160 spots land on it
(`test_image_coherence.py`, `test_registration_qc.py`). The sentence is load-bearing — it is the
STATED JUSTIFICATION for scoring a synthetic marker pixel instead of a real tissue score — so it
is not an ordinary stale comment.

`spatial-import-visium`'s `test_no_stale_claim_that_the_shipped_image_is_incoherent_survives`
already machine-checks the retired sentences, but `CLAIM_SCAN_ROOT` is that package. It cannot
see `libs/viz`, which is why this copy survived #243. The correction is therefore paired with the
same guard, rooted at this package — the prose analogue of what
`scripts/check-viz-producer-magnitudes.mjs` (#277) does for magnitudes.

The guard normalizes whitespace and comment prefixes before matching, because this copy is
LINE-WRAPPED across a `//` boundary and a raw substring scan would have missed it.

**The oracle itself is re-examined, not merely re-justified.** Two reasons survive the retraction
of the false one, and one does not:

1. The synthesized fixture is **non-square** (1400x1800). The coherent vendor image is
   **2000x2000**, i.e. square, and `test_spatial_image.py` says in as many words that it "cannot
   serve here even now that it is real and coherent (#243): it is 2000x2000, i.e. square."
   A square fixture cannot detect a transposed extent.
2. The marker is an **exact** oracle — one known full-resolution coordinate, asserted to 6
   decimal places, with two negative controls that must fail it. A tissue-mask score is
   statistical.
3. What does NOT survive: the claim that no coherent artifact exists. It does.

And the cost of acting on it is measured rather than asserted: the vendor
`tissue_hires_image.png` is 4,343,953 B as PNG, so an emitted DEFLATE OME-TIFF pyramid of it is
several megabytes, against a `libs/viz` fixture directory whose largest member is 167,778 B.
Adding a real-tissue score to this suite means committing a fixture ~30x the size of anything
here, to buy a statistically weaker oracle on a square image. That is #228's call to make with
that budget in hand; this change records the measurement and corrects the record.

## 8. Invariants

- **INV-1** — A sample count this reader cannot render is REFUSED BY NAME, never rendered as
  sample 0.
- **INV-2** — The loader never returns a source whose declared shape contradicts its own bytes.
- **INV-3** — Every sample the file carries is either displayed or named in a refusal; none is
  silently dropped.
- **INV-4** — A claim that was true when written and is now false is a defect, and the retired
  sentences are machine-checked in this package rather than corrected once.

INV-1 is `docs/design/ome-tiff-sample-classification.md` INV-5's second clause — *"usefully
covers a sample count this system's own reader would silently render as sample 0"* — turned
around onto the reader. INV-2 is #288's own diagnosis, verbatim: *"it builds a source whose shape
contradicts its own bytes."* INV-3 generalizes INV-1 to the single-texture path, which #288 does
not mention and which has the same defect. INV-4 is #294's, and #277's for prose.

## 8a. The cost this adds, stated

An N-channel source makes Viv issue N `getTile` calls per deck tile
(`Promise.all(selections.map(getTile))`), and each resolves to a per-sample read of the SAME
compressed tile. Two halves, and only one of them is avoidable:

* **On the TILED path the transport reads were duplicated, and are not any more.** The span
  cache is consulted synchronously and populated only after its `await`, so all N simultaneous
  reads of one span missed — measured at 5 parallel range reads of 1 unique span for one tile of
  the 5-sample fixture. The source now joins a read already in flight for the same span **under
  the same `AbortSignal`**; different signals stay independent, because sharing a promise shares
  its cancellation and one abandoned viewport must not abort a live one's read. (An earlier
  version of this bullet added "each of which also evicted a span an adjacent tile was about to
  reuse" as if it were part of that measurement. It is not: at the default 256-entry cache
  nothing was evicted in that run. Eviction thrash is real but belongs to the SEQUENTIAL path
  below, at cache saturation.)
* **Sharing one buffer between N decodes needed closing, and is closed.** geotiff's
  `RawDecoder.decodeBlock` returns its input and `applyPredictor` accumulates in place, so a
  second decode of a shared span double-applies the differencing for `Compression = 1` with a
  `Predictor` — silently wrong pixels. Already reachable through the span cache; the in-flight
  join made it certain per tile. Every caller now gets its own copy, and what that costs is
  measured rather than waved at as "a memcpy": it is paid PER CALLER, so the sequential
  per-channel scan below pays it once per channel per span — 54,204 bytes copied against 8,781
  fetched on one `loadOmeTiffPyramid` + `omeTiffUnderlay` of the 10-sample fixture, 6.2x. The
  narrower alternative (copy only for `Compression = 1` with a `Predictor`) is refused because it
  would require the byte source to know the file's codec, and it is a transport that parses
  nothing.
* **The SINGLE-TEXTURE path reads sequentially, and pays at cache saturation.** Its N channel
  reads are not concurrent, so the join cannot help and the FIFO span cache is all that stands
  between it and N full re-reads. Measured on a 10-sample pyramid whose coarsest level is 400
  strips: 400 transport reads at a 4096-entry cache, **1696 at the shipped 256**, 3424 at 64. It
  does not bite the artifacts this system emits — #227 made every level tiled 512x512 and
  `MAX_UNDERLAY_PIXELS` caps the served level at 2048x2048, i.e. 16 spans against a 256-entry
  cache — and `limits.spanCacheSize` is the caller's knob for a raw vendor file with a small
  `RowsPerStrip`. Reading the channels concurrently would collapse the reads and give back the
  N-planes-resident memory the loop was rewritten to remove; an OOM is not recoverable where a
  slow open is.
* **The DECODES are not de-duplicated, and that is inherent.** `PlanarConfiguration = 1` means
  one tile's bytes carry all samples, so extracting sample `k` inflates the whole tile. N
  channels therefore cost N inflations of the same bytes. That is the normal cost of Viv's
  per-channel model — an OME-Zarr channel stack pays it too, one chunk per channel — and paying
  it is what makes the samples visible at all. It bounds this design rather than breaking it:
  the alternative was showing one of them.

The module header's "geotiff asks for a strip or a tile, and that span, exactly, becomes one
range request" still holds per SPAN; it is the number of requests per TILE that this qualifies.

## 9. Verification standard

The failure mode is *"it renders, so no test noticed"*. A test that asserts a layer was
constructed, or that `loadOmeTiffPyramid` resolved, **passes against the broken code** and is
therefore no check at all. So:

* **Fixtures at `SamplesPerPixel ∈ {1, 2, 3, 4, 5}` plus one over the ceiling**, all written by
  the shipped writer's own classification where it has one (`_sample_layout` is CALLED, not
  copied), and header-asserted at generation time. A suite that only exercises 3 and 4 passes
  against `origin/main`.
* **Pixel content, per channel.** Each fixture's sample `s` is the closed form
  `(37s + 5x + 3y) mod 251`, which the test re-derives independently; every declared channel of
  every fixture must decode to its OWN sample, through both `getRaster` and `getTile`. 251 is
  prime and coprime with 37/5/3, so sample 0 substituted for sample `c` differs in EVERY pixel.
* **Refusals by name, from the real entry point.** `loadOmeTiffPyramid` over the committed
  11-sample file, asserting the error class NAME and that the message names both the count and
  the ceiling — not a direct call to a guard function.
* **The pre-fix behaviour as an explicit control.** For the 2- and 5-sample files the suite
  asserts the decoded channel data is NOT `plane(0)` — i.e. it re-runs the exact defect and
  requires it to fail.
* **The stale-claim guard's own negative control.** The scanner is run over a synthetic string
  containing a retired sentence and must report it, so a guard that silently matches nothing
  cannot pass. SPECIFICITY is checked against a corpus of adversarial paraphrases — sentences
  stating the TRUE, post-#243 version of a retired claim in as many of its words as possible —
  which must produce zero hits, and the corpus carries a near-miss for EVERY entry, which it did
  not when this sentence was first written: three entries had none, and replacing one of them
  with the three-word fragment `the 200x200 frame` left every test green. (An earlier form of that check dropped
  each claim's last word and required it to stop matching; that is a tautology, since a substring
  match cannot find a longer string inside a shorter one, and it is recorded here because this
  document specified it for one round.) The scan is rooted from the test file's own location
  rather than `process.cwd()` — a run from the repo root would otherwise re-scope the whole guard
  while still reporting green — and covers `docs/design` as well as the package, REQUIRED rather
  than best-effort and counted separately, because this document is exactly the kind of place a
  retired claim gets restated, and because an optional second root with one combined liveness
  bound is the same silent re-scoping in another spelling.
* **Both sides of the ceiling, and every guard the change adds.** A committed file AT the ceiling
  that must open and render, one above it that must be refused, and a deliberately malformed
  mismatched-levels file. Each of the four refusals the single-texture reduction added is
  exercised on the synthetic pyramid this package already keeps for "the shapes no fixture has",
  because a blind audit mutated all four to `false` and the whole package stayed green.
