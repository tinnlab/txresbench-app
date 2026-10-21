# OME-TIFF sample classification — what `photometric` must be told about `(H, W, S)` (#266)

**Status:** accepted. **Owner:** the writer (`spatial-types/compute/ome_writer.py`, #155/#176/#162).
**Reported by:** the blind audit of #227, which measured the cost and filed it rather than
absorbing it — `docs/design/ome-tiff-tile-layout.md` §5 says in as many words that
*"a defect in ... `photometric` handling ... is a separate issue"*. This is that issue.

## 1. What the writer promises

`write_ome_tiff` is, in its own words, *"the one place in this system where the EMITTED PIXELS
and the DECLARATION that describes them are both in scope"*. Everything else sees one or the
other. The extent assert and `_reconcile_scale` already close two halves of that promise: the
placement's extent must equal the pixels', and the declared micron scale must equal the emitted
one.

There is a third half, and nothing was checking it. `tifffile` does not read `SizeX`/`SizeY`/
`SizeC` off the array — it derives them from what the **caller declares the last axes mean**.
The array is `(rows, cols, ...)`; whether that trailing axis is *samples of one pixel* or
*separate planes of an image stack* is not in the array, it is in `photometric` and
`planarconfig`. Get that wrong and the file carries pixels that round-trip perfectly under a
header that describes a different image.

## 2. The defect

```python
photometric = "rgb" if arr.ndim == 3 and arr.shape[2] == 3 else "minisblack"
```

`read_image` accepts any TIFF series whose axes are `YX` or **`YXS`**, and
`xenium_image.read_plane` accepts `YXS` too. **`YXS` does not mean `S == 3`.** An RGBA or a
2-sample vendor TIFF is `YXS` with `S == 4` or `S == 2`; a `(H, W, 1)` series is `YXS` with
`S == 1`. Every one of those falls through to `minisblack` with no `planarconfig`, and
`tifffile`'s `photometricsamples == 1` branch then reads `width = shape[-1]`,
`length = shape[-2]` — i.e. it takes the **sample axis for X** and the remaining rows for
separate planes.

Measured through the real `write_ome_tiff` at `(900, 700, S)` uint8, `PYRAMID_MIN_SIDE=256`,
`TILE=(512,512)`, `deflate`:

| input | emitted `SizeX` × `SizeY` × `SizeC` | truth | file size |
|---|---|---|---|
| `(900, 700)`    | 700 × 900 × 1 | correct | 779,887 B |
| `(900, 700, 1)` | **1 × 700 × 900** | 700 × 900 × 1 | 3,034,945 B |
| `(900, 700, 2)` | **2 × 700 × 900** | 700 × 900 × 2 | 4,004,613 B |
| `(900, 700, 3)` | 700 × 900 × 3 | correct | 2,328,718 B |
| `(900, 700, 4)` | **4 × 700 × 900** | 700 × 900 × 4 | 5,765,799 B |
| `(900, 700, 5)` | **5 × 700 × 900** | 700 × 900 × 5 | 6,628,259 B |

The issue reports `S ∈ {2, 4}`. **`S == 1` is broken by the same expression and the issue title
excludes it** — `(H, W, 1)` is not "effectively greyscale" to `tifffile`, because with `ome=True`
the trailing-1 squeeze that the `shaped` format applies is not reached, so the one sample becomes
X and the 900 rows become 900 channels. It is the same defect and is fixed here, not deferred.

The pixels round-trip (`asarray()` returns the input), so nothing errors and no test notices.
The extent assert cannot catch it: it compares the placement against `extent_of(arr)`, which
reads `arr.shape[:2]` and is *correct*. The disagreement is between the array and what
`tifffile` was told to make of it — a quantity neither side of that assert holds.

#227's tiling amplifies the cost, because each of those mis-shaped `S × 700` "planes" is now
padded to a whole 512 × 512 tile. **Two different size numbers get quoted for `(900, 700, 4)`
and they are not the same comparison**, so both are labelled rather than left to look like a
contradiction:

* **591,903 B → 2,821,109 B (4.77×)** is #266's own measurement, of the MIS-CLASSIFIED file,
  stripped (pre-#227) versus tiled (post-#227). It is what #227's tiling added *on top of* the
  misclassification.
* **5,765,799 B** is the row in the table above: the mis-classified file as this module emits it
  today (tiled, `PYRAMID_MIN_SIDE = 256`, deflate, pyramid included). Classifying it correctly
  brings it to **3,104,538 B (1.86×)** — that is what this change saves.

Either way `(H, W, S)` with `S ∉ {1, 3}` is the one input class where tiling is expensive, and
it is expensive *because* the classification is wrong, not because tiling is.

## 3. The fix, and the constraints on it

The naive repair (`"rgb" if S == 3 else "minisblack"`) leaves `S ∈ {1, 2, 4, 5, …}` exactly as
wrong as before. The rule must classify by **what the trailing axis IS**, and every arm must be
grounded in `tifffile`'s own contract rather than in what looks right for the common case.

`tifffile`'s contract, read from the installed source (`tifffile/tifffile.py`, 2025.5.10) and
confirmed by round-tripping every arm:

* `photometricsamples = TIFF.PHOTOMETRIC_SAMPLES[photometric]` — 3 for `RGB`, 1 for
  `MINISBLACK`.
* With `photometricsamples > 1` (i.e. `rgb`), fewer than 3 trailing samples raises
  `ValueError: not enough samples for PHOTOMETRIC.RGB` — so **3 is a hard floor**. There is NO
  ceiling: `imwrite((300, 220, 5), photometric='rgb')` succeeds and writes `SamplesPerPixel=5`
  with two unspecified extras, and an earlier draft of this section claimed otherwise. What
  `samples_set = {photometricsamples, 4}  # allow common alpha` actually decides, with
  `planarconfig=None`, is CONTIG vs SEPARATE — i.e. **4 is the one count beyond 3 that
  `tifffile` recognises as an RGB image by construction**, which is why the pair below is
  `{3, 4}`. (It also matters that `imwrite((4, 5, 2), photometric='rgb')` silently goes
  SEPARATE — another reason not to reach `rgb` with a count it was not built for.)
* With `photometricsamples == 1` and `planarconfig` **unset**, the final `else` branch takes
  `width = shape[-1]`, `length = shape[-2]` — this is the defect above.
* With `photometricsamples == 1` and `planarconfig='contig'` **explicitly set** on an array of
  `ndim > 2`, the `elif planarconfig and len(shape) > 2` branch takes
  `contig_samples = shape[-1]`, `width = shape[-2]`, `length = shape[-3]` and
  `extrasamples = samples - 1`. This is the standard TIFF spelling of *"S interleaved samples,
  no colour interpretation claimed"*, and the parameter docs say so: *"If this parameter is set,
  extra samples are used to store grayscale images."*
* `planarconfig='contig'` on a `(H, W, 1)` array raises
  `ValueError: PLANARCONFIG.CONTIG does not match StoredShape(... contig_samples=1 ...)` — so
  one sample cannot be expressed as an interleaved stack. It has to be a plain 2-D plane.
* `extrasamples` values are written to the ExtraSamples tag; `UNSPECIFIED` = 0,
  `UNASSALPHA` = 2. `tifffile` itself defaults RGB-with-one-extra to `UNASSALPHA`
  (*"Unassociated alpha channel"*, the `elif photometric == RGB and
  storedshape.extrasamples == 1` arm) — the declaration below states it explicitly rather than
  inheriting a default.

That yields exactly one rule, with no case left to fall through:

| `arr` | `photometric` | `extrasamples` | why |
|---|---|---|---|
| `ndim == 2` | `minisblack` | — | one sample, one plane. Unchanged. |
| `S == 1` | `minisblack` | — | reshaped to `(H, W)` first: one sample IS a plain plane, and `contig` is *refused* by `tifffile` for it. |
| `S == 3` | `rgb` | — | three interleaved samples is what RGB means. Unchanged. |
| `S == 4` | `rgb` | `('unassalpha',)` | TIFF 6.0's RGBA; and the reader's `isInterleaved` rule needs it (below). |
| other `S` | **REFUSED** | | outside the reader's contract — see *What this system emits* below. |
| `S < 1` | **REFUSED** | | a zero-sample array is not an image; `tifffile`'s own failure for it is the unrelated *"truncate can only be used with imagej or shaped formats"*, which no importer guard catches. |
| `ndim` ∉ {2,3} | **REFUSED** | | not a plane, with or without samples. See below — an earlier draft of this row was factually wrong about what `origin/main` did. |
| bilevel, `S > 1` | **REFUSED** | | `tifffile` cannot write it losslessly — see below. |

Measured through the real `write_ome_tiff` after the change: every EMITTED row declares
`SizeX=700 SizeY=900 SizeC=S` and decodes back bit-for-bit equal to the input, across
`uint8`/`uint16`/`int16`/`int32`/`float32`/`float64`. The two broken-and-now-fixed rows shrink:
`S=1` 3,034,945 → 779,887 B, `S=4` 5,765,799 → 3,104,538 B.

**There is deliberately no `planarconfig` in that table.** An earlier cut of this design had an
`other S ≥ 2 → minisblack + planarconfig="contig"` arm, which is how TIFF spells "S interleaved
samples, no colour claimed" and which emits a perfectly truthful header for any `S`. It was
removed for the reason in the next section — and once removed, `planarconfig` is `None` on every
surviving arm, so the parameter was dropped rather than threaded through two call sites as a
constant `None` that no test could ever fail on.

### What this system EMITS, and why a correct header is not sufficient

The first cut of this fix classified `S == 2` and `S ≥ 5` correctly and emitted them. Two
independent blind audit angles measured the same consequence, and it reverses the decision:

* On `origin/main`, a `(300, 220, 2)` array emitted **300 top-level IFDs**, so
  `omeTiffPyramid.ts`'s `getImageCount() > 1` guard threw `MultiPlaneImageUnsupportedError` —
  a refusal **by name**.
* Classified correctly it is **1 IFD, `SamplesPerPixel=2`, `PlanarConfiguration=1`**. Both of
  that loader's refusals now pass; its interleave rule is `samples === 3 || samples === 4`, so
  `interleaved` is false, the source is declared `[1, height, width]` over an interleaved
  raster, and `TiffPixelSource._readRasters` returns `raster[0]`. **Sample 0 is rendered as the
  whole image and nothing says so.**

A loud refusal traded for a silent partial render is a worse artifact than the one #266 filed,
however correct its header. And the contract being broken is written down in the reader itself,
one paragraph above the guard: *"Every image this system EMITS is a single plane (interleaved
RGB or one greyscale sample), so this refusal names a raw vendor file reaching the reader, not
one of our artifacts."* That is a sentence about the WRITER. So the writer honours it: the
sample counts outside `{1, 3, 4}` are refused here, by name, where the refusal costs one image
and appears in `images_not_emitted`. #266 says the same: *"Refusing is defensible and probably
right ... the refusal names it and someone decides deliberately."*

Lifting it is **#288** (teach the reader), at which point `READABLE_SAMPLE_COUNTS` is the one
line to change and the header logic is already correct for it.

### Why `S == 4` is `rgb` and not an uninterpreted stack

This is the one EMITTED arm where two defensible answers exist, and the choice is made on
evidence rather than on which reads better. An array cannot distinguish RGBA from four
interleaved fluorescence channels — `read_image` and `read_plane` both discard the source's
`PhotometricInterpretation` and `ExtraSamples` (**#289**). So the tie is broken by the consumer
this system actually ships: `libs/viz/.../omeTiffPyramid.ts` implements Viv's `isInterleaved`
rule — `const interleaved = samples === 3 || samples === 4` — and renders those through a
BitmapLayer **using the file's `PhotometricInterpretation`**. Declaring `MINISBLACK` with
`SamplesPerPixel = 4` therefore hands our own reader an interleaved source whose photometric
contradicts it. `rgb` is the path that reader is built for, the spelling `tifffile` explicitly
admits, and what TIFF 6.0 means by a 4-sample RGB image. The residual is recorded rather than
hidden: a genuine 4-channel interleaved image has its 4th channel composited as alpha, and
closing that is #289.

### What `origin/main` did with `ndim > 3`, measured rather than assumed

An earlier draft of this design justified the `ndim` guard by claiming a 4-D array "was
classified `rgb` off `shape[2]`" and "died as a bare `ValueError`". **Both halves were wrong**,
and the correction is kept rather than quietly swapped in, because getting a plausible-sounding
claim wrong is the exact failure this whole issue is about.

The pre-fix expression is `arr.ndim == 3 and arr.shape[2] == 3`. A 4-D array fails the FIRST
conjunct, so it was classified `minisblack` — and `tifffile` then wrote a complete, silently
mis-headed file:

```
(60, 44, 1, 3)   ->  axes=ZCYX,   SizeX=3 SizeY=1 SizeC=44 SizeZ=60
(2, 3, 4, 5, 6)  ->  axes=TZCYX,  SizeX=6 SizeY=5 SizeC=4 SizeZ=3 SizeT=2
```

That is the same defect §2 describes, one dimension further out — a **stronger** reason for the
guard than the one first written down, not a weaker one. `ndim < 2` is the other half and does
die uncaught: a bare `IndexError` from `arr.shape[2]`, which is in neither importer's `except`
tuple and therefore costs the whole import rather than one image.

### Why a bilevel array with more than one sample is refused

`tifffile` sets `bilevel` from the dtype (`datadtype.char == '?'`) and then packs each tile with
`packbits`, which is wrong once `contig_samples > 1`. Measured with the guard temporarily lifted,
on a fair-coin `default_rng(266)` bool array — **the input is named because an earlier draft of
this paragraph quoted three counts against one denominator**, which cannot be right for three
different sample counts, and a number nobody can reproduce is not a measurement:

| input | samples that decode back CHANGED |
|---|---|
| `(300, 220, 3)` bool | 90,632 of 198,000 (45.8%) |
| `(300, 220, 4)` bool | 123,821 of 264,000 (46.9%) |
| `(1100, 900, 3)` bool | 1,361,386 of 2,970,000 (45.8%) |
| `(1100, 900, 4)` bool | 1,855,822 of 3,960,000 (46.9%) |

Only `S ∈ {3, 4}` appears because those are the only counts that can REACH this guard —
everything else is refused earlier by the sample-count rule. Every other dtype tried
(`uint8`/`uint16`/`int16`/`int32`/`float32`/`float64`) round-trips exactly at every `S`.

This is not bookkeeping. `read_image`'s own docstring names BILEVEL (`bool`) as a dtype its TIFF
branch returns, `read_plane` hands a `YXS` plane through with no dtype conversion, and
`origin/main` PRESERVED those pixels — under a wrong header, but losslessly — for `S` in
`{1, 2, 4, 5}`. Classifying them correctly without this guard would trade a mis-declared
lossless file for a correctly-declared lossy one, which is a worse artifact than the one #266
filed. (`S == 3` bool was already corrupt on `origin/main`; the same guard closes that.)

## 4. Invariants

These are the promises this change may not reframe.

- **INV-1** — The emitted OME-XML's `SizeX`, `SizeY` and `SizeC` must equal the true image
  width, height and sample count of the array that was written. A file may not carry pixels
  that round-trip under a header that describes a different image.
- **INV-2** — `YXS` does not mean `S == 3`. Every sample count `read_image` and
  `read_plane` can deliver reaches an explicit arm — emitted or refused; none falls through to
  a default that was written for another arm.
- **INV-3** — The pixels are unchanged by the classification: what is decoded back out of the
  emitted file equals what was handed in, bit-for-bit, at level 0.
- **INV-4** — Level 0 and every pyramid level below it are classified identically, for the
  reason #227 gives for `tile=`: a file that describes itself one way at level 0 and another
  below it forces a consumer to branch per level to read one image.
- **INV-5** — An input whose SAMPLE-AXIS CLASSIFICATION this writer cannot emit correctly and
  usefully is REFUSED BY NAME, in the taxonomy the importers' guards catch, never guessed at —
  the rule `read_image`'s own axis-order check already states: *"Refusing rather than guessing."*
  "Correctly" covers the shape (`ndim`, `S < 1`) and the one dtype that interacts with the
  sample axis (bilevel with `S > 1`); "usefully" covers a sample count this system's own reader
  would silently render as sample 0.
  **Scoped deliberately to the sample axis. The gap that left was named rather than implied,
  and has since been CLOSED by #292** — recorded here rather than left stale, because an
  accepted design that still describes a fixed defect as open is worse than one that never
  mentioned it. As shipped by this change, a dtype OME-XML cannot express at all (`int64`,
  `uint64`, `float16`, …) still escaped `write_ome_tiff` as `tifffile.OmeXmlError`, which
  subclasses `Exception` directly and WAS in neither importer's guard, so it cost the whole
  import; this change SHRANK that set (an audit counted 35 escaping input classes on
  `origin/main` against 20 here) but did not close it, and INV-5 was worded so as not to claim
  otherwise. #292 closes it at the writer boundary with an explicit `OME_EXPRESSIBLE_DTYPES`
  allowlist — and measured, while doing so, that the escaping set was 64 `(dtype, S)` pairs over 16
  dtypes in THREE exception families, rather than the 20 counted here: the
  non-numeric dtype kinds died one frame earlier as a bare `KeyError` from `tifffile`'s
  `sampleformat` lookup, and the unsized `void` earlier still as a bare `ValueError`, which is
  why that fix is a guard on the dtype and not an `except` on the exception this paragraph
  names. See `docs/design/ome-tiff-dtype-refusal.md`.

INV-3 and INV-5 are lifted from `ome_writer.py`'s own docstrings; INV-1 and INV-2 from #266;
INV-4 from `docs/design/ome-tiff-tile-layout.md` INV-2, applied to the same two `writer.write`
calls.

## 5. What this change is NOT

**It is not a change to the shipped shapes.** `(H, W)` and `(H, W, 3)` are classified exactly as
before — same `photometric`, no `planarconfig`, no `extrasamples` — and emit byte-identical files
modulo the fresh `urn:uuid` `tifffile` stamps on every write, at a single-level AND a multi-level
size, across dtypes. Independently re-verified against `origin/main`'s actual writer by a blind
audit: 10 dtypes × 6 sizes × both shapes = 120 uuid-normalised byte comparisons, all identical,
with exactly one deviation — the `bool` `(H, W, 3)` this design names below.

**The honest scope of TEST-6, which is what makes that claim executable:** its control is HEAD's
own source with ONLY the classification assignment reverted, so it proves *the classification
change* does not move those bytes. It is blind by construction to any OTHER byte-moving edit in
the same diff — demonstrated: changing `TILE` to `(256, 256)` leaves it green. That is the right
scope for this change (nothing else in the diff touches the write path) and it is stated so the
test is not read as proving more than it does. The one qualification, stated
rather than buried: a `bool` `(H, W, 3)` is now refused instead of emitted — it was already
emitting corrupt pixels on `origin/main`, no fixture is bilevel, and refusing a corrupt emission
is a fix rather than a regression.

**It is not a reader change.** `libs/viz/.../omeTiffPyramid.ts` is owned elsewhere (#276) and is
not touched. Its `isInterleaved` rule cannot read `S == 2` or `S ≥ 5` however they are written;
that gap is filed as **#288** rather than absorbed here — the same discipline #227 applied to
*this* defect. Until it is closed, the writer refuses those counts rather than emitting artifacts
that reader would half-render.

**It does not make an `S ∉ {1,3,4}` image importable.** Such an image is NOT emitted, and is
NAMED in `images_not_emitted` with the reason. That is a deliberate, recorded reduction in what
gets written versus the first cut of this fix — and versus `origin/main` it is not a reduction at
all, because what `origin/main` wrote for those inputs was a file declaring `SizeX = S`.

**It is not a change to `read_image`'s or `read_plane`'s accepted axis orders**, to the codec, to
the pyramid, to the tile size, or to `BIGTIFF_THRESHOLD_BYTES`. The `nbytes`-based BigTIFF
estimate is *closer* to the truth after this change (the mis-shaped path inflated on-disk size
~3.3× over `arr.nbytes`), but the threshold itself is not re-derived here.

## 6. Verification standard

The failure mode this defect belongs to is *"the file opens, so no test noticed"*. A test that
asserts only that `write_ome_tiff` returns without raising **passes against the broken code** and
is therefore no check at all.

So acceptance is: round-trip every EMITTED case (2-D, `S ∈ {1, 3, 4}`, across `uint8` and
`uint16`) through the real `write_ome_tiff`, parse the emitted OME-XML, and assert
`SizeX`/`SizeY`/`SizeC` against the input shape — plus that the decoded pixels equal the input;
and for every REFUSED case (`S ∈ {2, 5, 6, 8}`, `S < 1`, `ndim ∉ {2,3}`, bilevel with `S > 1`),
assert the refusal is an `ImageConversionError` that NAMES the offending property and leaves
nothing on disk. Each assertion goes RED against `origin/main`, and that is demonstrated by
re-deriving `origin/main`'s expression from this module's own source rather than claimed.

The control that demonstration rests on is itself held to an oracle: the same AST transformer
and the same unparse run on BOTH paths, so a derivation with the revert OFF must emit bytes
indistinguishable from production's. Guarding the surgery behind an `if` would make that oracle
compare `ast.parse(source)` against `source` — true by construction of CPython, and blind to
anything the transformer does. Measured: with it so guarded, a transformer that also stripped
`tile=` left the oracle GREEN.

`ome_writer.py` is vendored byte-identically into `spatial-import-visium` and
`spatial-import-xenium`; the change lands in `spatial-types` and is re-copied, and all three
`manifest.yaml` versions move — a **minor** bump, because the emitted OME-XML is behaviour and
an already-provisioned deployment skips re-extraction at an unchanged version.
