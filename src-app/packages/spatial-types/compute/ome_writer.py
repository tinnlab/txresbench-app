#!/usr/bin/env python3
# ruff: noqa
"""ome_writer — the OME-TIFF half of the placement contract (#155/#176/#162, epic #151).

An importer reads the vendor bundle; this module turns whatever image the vendor shipped
into the ONE image format this system reads, and refuses the ways of writing it that would
quietly destroy the measurement.

## Why this file lives in `spatial-types` (#162)

It is the EXECUTABLE OTHER HALF of the contract `spatial_declarations.py` declares beside
it: that module defines `coordinate_space`, `image_meta`, `display_derivative_provenance`
and the `OME_PLACEMENT_PREFIX` encoding; this one is the only code that writes those
declarations into bytes and is therefore the only place the pixels and the declaration are
both in scope. It shipped inside `spatial-import-visium` when Visium was the only importer;
a second importer (#162, Xenium) needs the identical code, and `run.helpers` is confined to
a package's own tree, so each importer VENDORS a byte-identical copy from here — the same
idiom by which `spatial-import-visium` already vendors `spatial_declarations.py`. Making a
leaf importer the source of truth for a sibling importer would be the wrong dependency
direction; this is the fix for that, not a relocation for its own sake.

`spatial-import-xenium/tests/test_vendored_contract.py` byte-compares every copy against
this one. A vendored file that drifts is a second implementation wearing the first's name.

## The unit of the space is NOT assumed to be pixels (#162)

Visium's coordinate space is a full-resolution PIXEL frame; Xenium's is MICROMETRES. Both
are legal `coordinate_space` units and the difference reaches exactly one place in this
module — the scale reconciliation in `_reconcile_scale`, which resolves the space's scale
through `SD.require_micron_scale` rather than reading one key. See the comment there; it
was a real defect, not a hypothetical one.

## Why an OME-TIFF is emitted even when the vendor shipped a PNG

Visium's `tissue_hires_image.png` is ~2000 px and a PNG reader would open it fine. The
reason to convert anyway is not this file, it is every other file: Viv reads pyramidal
OME-TIFF over HTTP range requests, which is *"the only way a multi-GB image is viewable at
all"* (§6.3/§8.2), and a Xenium morphology image is exactly that. Emitting OME-TIFF
unconditionally means there is **one image path and one reader** instead of a two-path
branch every consumer, renderer and test carries forever. A small image is a single-level
pyramid — a legal OME-TIFF and the trivial case of the same reader.

## Why `deflate` and not `lzw` (DEC-2)

Both are in `LOSSLESS_CODECS`. Only `deflate` works on the host that runs `just check-py`:
`tifffile` dispatches LZW to `imagecodecs`, which is pinned in the rootfs and NOT installed
on the host, while deflate needs only stdlib `zlib`. Choosing LZW would put this module's
whole suite behind the one gate that has to run it — the same trap `manifest.yaml` cites
for declining `squidpy`.

## The display derivative (#176)

A `spatial/image` is a DISPLAY DERIVATIVE. A source finer than the declared resolution cap
is DOWNSAMPLED to meet it — by an integer-factor box mean, so every emitted pixel is the
real average of a whole block of real measurements — and a source already coarser than the
cap passes through untouched. #155 shipped the pass-through leg and REFUSED the other,
naming this issue in the refusal; that refusal is now the downsample it named.

**"Lossless" here means four separable things, and the fourth is the one that ships wrong:**

1. the **original is preserved** — it is not re-emitted, it stays in the retained upload
   bundle (`spatial/visium-bundle`: *"the vendor's own image files stay recoverable"* —
   and for Visium that source is itself 10x's downscale, not the instrument's pixels), and
   `spatial_declarations.require_original_reference` is the reach;
2. the **codec** is lossless — `LOSSY_CODECS` refused, unchanged from #155;
3. every emitted pixel is a **real average of real measurements** — a box mean, never
   decimation (which discards three of four) and never interpolation (which invents values
   between source pixels, the same line lossy compression crosses);
4. the **declared resolution describes the EMITTED pixels**. A downsampled image whose
   declared scale still describes the original passes every shape, type and conformance
   check this system has, and every downstream micron measurement silently scales wrong.
   `write_ome_tiff`'s reconciliation is what closes it, because that function is the one
   place the pixels and the declaration are both in scope.

The rendering pyramid is a separate thing from the display derivative and is unchanged:
level 0 is always what this artifact IS, bit-for-bit, and the halvings below it are a
viewer's overview.
"""
import os
from pathlib import Path

import spatial_declarations as SD

#: The one codec this module writes (DEC-2). Not a knob: the only other admissible value
#: is the one that cannot be tested on the host that gates this code.
CODEC = "deflate"

#: Stop halving when the next level's SHORTER side would fall below this. A pyramid exists
#: so a viewer can fetch a cheap overview instead of the whole plane; levels below roughly
#: one screen tile buy nothing and cost an IFD each. A source already at or under this
#: yields a single-level file — the trivial pyramid, still a legal OME-TIFF.
PYRAMID_MIN_SIDE = 256

#: The TILE the pixels are written in, for EVERY level (#227). Not decoration and not a
#: knob: with no `tile=`, `tifffile` writes a STRIPPED TIFF, and a strip is FULL IMAGE
#: WIDTH by construction. A viewer fetching one viewport over HTTP range requests then
#: pays `imageWidth x stripHeight` instead of `tile x tile`, however narrow the viewport
#: is — measured on a real emitted artifact at `RowsPerStrip=62`, 30 full-width strips, and
#: measured on the wire by the reader (#158) at 14 ranged GETs for one 512x512 level-0
#: tile, nine of them consecutive full-width strips. That is ~2.7x on a small committed
#: fixture and ~80x on a whole-slide image, which is the case this module's own docstring
#: says the OME-TIFF exists for ("Viv reads pyramidal OME-TIFF over HTTP range requests").
#: A pyramid alone does not deliver that promise: the pyramid picks the right RESOLUTION
#: and the tiling picks the right REGION.
#:
#: #321 AMENDMENT — "nine", corrected from "ten" (#259 found it; #333 is why it lands with
#: the `libs/viz` allowlist edit). Editing another issue's recorded measurement has to be
#: VISIBLE and has to be CHECKABLE, so it is both. The decomposition is read straight out of
#: the artifact #158 measured, which is kept byte-identical as
#: `spatial-image-hires-stripped.ome.tif` (167,778 B, `RowsPerStrip=62`, 30 strips): a
#: 512-row band spans NINE of its 62-row strips — at y=0 they sum to 36,383 B — and every
#: full band on that file (y = 0, 512, 1024) spans nine (36,383 / 36,390 / 36,444 B), so the
#: correction does not depend on which tile #158 read. 41,891 − 36,383 = 5,508 over
#: 14 − 9 = 5 GETs, which is exactly what an OPEN of this file costs on the shipped loader.
#: Ten would be 40,439 B, leaving a 1,452-byte 4-GET open that no measurement of this reader
#: produces — and nine is forced geometrically anyway, since seven strips cover 434 rows and
#: eight cover 496, neither of which reaches a 512-row band.
#:
#: The number above is not maintained by hand. `docs/design/ome-tiff-tile-layout.md` §2
#: carries the same amendment, and `spatial-types/tests/test_wire_measurement_strip_count.py`
#: DERIVES the count from that fixture's own tags and from `TILE` below, then requires every
#: copy of this sentence anywhere under `src-app/packages/` to state the word it derived.
#:
#: WHY 512 AND NOT 256 OR 1024. `tifffile` requires both dimensions to be multiples of 16,
#: which admits all three — so the constraint does not choose. The CONSUMER's request size
#: does. The reader (`omeTiffPyramid.ts`) hands deck.gl a `TiffPixelSource` built with
#: `DEFAULT_OME_TIFF_LIMITS.tileSize = 512`, so every tile the viewer asks for is 512x512.
#: Matching that edge exactly means one requested tile is ONE TIFF tile and therefore ONE
#: ranged read. At 256 the same request becomes four ranged reads and four decodes for the
#: same pixels; at 1024 it fetches four times the pixels the viewport needs. 1024 also
#: quadruples what a sub-tile level pads, and `PYRAMID_MIN_SIDE = 256` guarantees such
#: levels exist in every pyramid.
#:
#: NOTE, because the obvious-sounding version of this argument is FALSE: the reader does
#: NOT derive its tile size from this file. It deliberately bypasses Viv's `loadOmeTiff`
#: (whose `prevPowerOf2(min(TileWidth, TileLength))` reads `RowsPerStrip` on a stripped
#: file and lands on 32) and supplies 512 itself. So 512 here is not "agreeing with a value
#: the reader computes"; it is agreeing with the value the reader REQUESTS.
#:
#: A LEVEL SMALLER THAN ONE TILE IS FINE AND IS THE COMMON CASE. `tifffile` pads the last
#: tile; `ImageWidth`/`ImageLength` still declare the true extent, so no reader sees the
#: pad, and the round trip stays bit-for-bit. What the pad COSTS is measured rather than
#: waved at, against a stripped control that is this exact call minus `tile=` (the same
#: control `spatial-types/tests/test_ome_tile_layout.py` measures against, keyword for
#: keyword — an earlier version of this comment quoted numbers taken against a control that
#: was missing the OME `Description`, so every stripped baseline was ~150 bytes short and
#: every ratio inflated):
#:
#:     100x80 RGB noise        25,064 ->     26,684  (1.07x)
#:     100x80 RGB smooth        1,440 ->      2,354  (1.64x)
#:     3x3   RGB                1,084 ->      1,906  (1.76x)  <- worst case, +822 BYTES
#:     200x200 RGB smooth       2,372 ->      3,448  (1.45x)
#:     600x600 RGB smooth      12,142 ->     14,440  (1.19x)
#:     2000x2000 RGB noise 15,310,700 -> 15,324,324  (1.00x)
#:     2000x2000 RGB smooth   132,056 ->     92,854  (0.70x)  <- tiling WINS by 30%
#:
#: Two things that table says and a single number cannot. The RATIO is worst where the
#: payload is tiny, so the ABSOLUTE cost stays under ~1 KB there; and at the sizes this
#: module exists for the overhead is within a percent, or negative. Which way it goes at a
#: given size depends on the DATA — how well the codec does per tile versus per strip — not
#: on the size alone. This is a measured range, not a rule.
TILE = (512, 512)

#: Above this many bytes of pixel data the file is written as BigTIFF. Classic TIFF
#: addresses with 32-bit offsets, and the installed `tifffile` has its own >4 GiB guard
#: COMMENTED OUT ("to allow image data beyond 4GB in classic TIFF"), so overflowing it
#: produces corrupt offsets rather than an error. 2 GiB rather than 4 is HEADROOM, not
#: arithmetic: the comparison at the call site already sums the base plane AND every
#: pyramid level, so the levels are not being allowed for twice — the margin covers the
#: IFDs, the OME-XML and compression that fails to shrink an already-noisy plane. Named
#: rather than inline so the
#: threshold is testable without materialising gigabytes.
BIGTIFF_THRESHOLD_BYTES = 2 * 1024 ** 3

#: The dtypes OME-XML can express, keyed on `numpy.dtype(...).name` (#292). Not a policy
#: choice and not a taste: this is OME's `PixelType` vocabulary, and it is a MIRROR of the
#: table inside the installed `tifffile` (`OmeXml.addimage`, tifffile.py:15970-15981 at the
#: pinned 2025.5.10), read out of the library rather than remembered. `test_ome_dtype_refusal`
#: re-derives it by driving each candidate through the installed library, so the mirror cannot
#: drift from the table it mirrors.
#:
#: WHY THIS IS A GUARD AND NOT A `try`. A dtype outside this set does not fail in ONE way, and
#: that is the whole reason #292 could not be closed by translating an exception. MEASURED on
#: `301cd345` by sweeping every dtype in `np.sctypeDict` (deduped by `dt.str`) plus the six
#: non-numeric constructions, at `S` in `{None,1,2,3,4,5}`, through this function. **64
#: escaping `(dtype, S)` pairs, over 16 distinct dtype spellings, in THREE families with three
#: different exception types raised from three different frames:**
#:
#:   family A  int64, uint64, float16, float128, complex256                   5 dtypes, 20 pairs
#:             -> `TiffWriter.__exit__` -> `close()` -> `_write_image_description()`
#:                -> `OmeXml.addimage`, at the PixelType table this constant mirrors
#:             -> `tifffile.OmeXmlError: data type 'int64' not supported`
#:   family B  bytes, bytes32, datetime64, datetime64[s], object, str,
#:             str128, timedelta64, timedelta64[s], void16                   10 dtypes, 40 pairs
#:             -> ONE FRAME EARLIER, in `TiffWriter.write`, at
#:                `sampleformat = {'u':1,'i':2,'f':3,'c':6}[datadtype.kind]`
#:             -> a bare `KeyError: 'V'` (or 'S'/'U'/'O'/'M'/'m')
#:   family C  void (the UNSIZED `V0`, itemsize 0)                             1 dtype,  4 pairs
#:             -> `TiffWriter.write` again, but earlier still, on the zero-data path
#:             -> a bare `ValueError: truncate can only be used with imagej or shaped formats`
#:                — the SAME message the `S < 1` refusal below cites, reached by a zero
#:                ITEMSIZE instead of a zero sample count
#:
#: All 64 are at `S` in `{None,1,3,4}`; `S` in `{2,5}` is already refused by
#: `READABLE_SAMPLE_COUNTS` before any of this is reached.
#:
#: `OmeXmlError.__mro__` is `(OmeXmlError, Exception, BaseException, object)`, `KeyError` is a
#: `LookupError` and `ValueError` is not `SpatialDeclarationError` — NONE of the three is
#: `ImageConversionError`, `SpatialDeclarationError` or `OSError`, so every one of the 64
#: escaped both importers' per-image guards and cost the WHOLE import: the matrix, the
#: coordinates, the columns and the report, over one unusual vendor image. Catching
#: `OmeXmlError` would have closed family A's 20 and left the other 44 — the same defect one
#: dimension over, which is what #292 was filed about in the first place. ONE predicate on the
#: dtype closes all three, before a byte is written, without knowing anything about which
#: exception the library happens to raise.
#:
#: The array is REFUSED, never CAST. An `int64` plane is usually `int32`-representable and a
#: `float16` always is, so a widening cast would keep the image — and would silently change the
#: dtype a consumer reads back, which is the defect #266 filed; it is also not universally
#: lossless (an `int64` above `2**31 - 1` does not fit `int32`, `float128` does not fit
#: `float64`). A conversion that is exact for some inputs and lossy for others, with nothing in
#: the artifact saying which, is what `LOSSY_CODECS` already refuses. See `docs/design/ome-tiff-dtype-refusal.md` §3.
#:
#: `bool` IS in this set (OME `PixelType="bit"`), so this guard does not shadow the more
#: specific bilevel-with-samples refusal in `_sample_layout`. `complex64`/`complex128` are in it
#: because OME has `complex`/`double-complex` and they were MEASURED emitting successfully —
#: refusing a working input would be a new regression, not a bug fix (#288 owns narrowing).
OME_EXPRESSIBLE_DTYPES = frozenset((
    "int8", "int16", "int32",
    "uint8", "uint16", "uint32",
    "float32", "float64",
    "complex64", "complex128",
    "bool",
))

#: Read for conversion. `tifffile` cannot decode a PNG (verified: it raises
#: `TiffFileError`), which is why `pillow` is a declared dependency of this package and
#: pinned in `env-rootfs/single-cell/requirements.txt`.
_PIL_SUFFIXES = (".png", ".jpg", ".jpeg")
_TIFF_SUFFIXES = (".tif", ".tiff")

class ImageConversionError(RuntimeError):
    """A refusal from the image path. Names what was wrong and what to do about it."""


# ── WHAT SEPARATES A BUG FROM A BAD IMAGE: the RAISING SITE, not the exception TYPE ──
#
# Every image boundary in this tree owes its caller one promise — a bad image costs ONE
# image, never the import — and owes its MAINTAINER the opposite one: a bug in this tree's
# own code must NOT come back to the user as "images_not_emitted: not a readable image"
# while the import reports SUCCESS. Both are real; they were mutation-proved a year apart.
#
# Four attempts to satisfy both by partitioning the exception TYPE space are recorded in
# `read_image`'s policy comment below, and three of them failed for the same reason: the
# type does not carry the information. MEASURED at `e0276408` against the pinned
# `tifffile` 2025.5.10, by RUNNING each case rather than reasoning about it:
#
#   input                                   exception            INNERMOST frame
#   a TIFF with `ImageWidth` zeroed         ZeroDivisionError    tifffile.py:4855
#   a TIFF with `ImageLength` zeroed        ZeroDivisionError    tifffile.py:4855
#   `pages[i]` past the end of a series     IndexError           tifffile.py:12535
#   MUTANT `series.axess`                   AttributeError       xenium_image.py (own frame)
#   MUTANT `_channel_index(names, pages, .)` TypeError           xenium_image.py (own frame)
#   MUTANT `selection["channel_nmae"]`      KeyError             xenium_image.py (own frame)
#   MUTANT `pagez[index]`                   NameError            xenium_image.py (own frame)
#
# The four MUTANT rows carry no line number ON PURPOSE. They were cited as :173/:128/:192/:196
# and every one went stale the first time this file's comments grew — the reader then checks a
# line that says something else and stops trusting the half of the table that IS exact (the
# `tifffile.py` citations are pinned to the installed 2025.5.10 and were re-verified). What
# matters about a mutant is the FILE, which is the whole claim; the mutants themselves are
# executable and live in `_READ_PLANE_BUG_MUTANTS`.
#
# `TypeError` appears on both sides of that table and so does every other type worth
# listing. The SITE does not: every bug is raised by a line in the boundary's own file and
# every measured data failure is raised inside the library the boundary called. So the
# question these predicates ask is the one all four attempts were approximating — DID OUR
# CODE RAISE THIS, OR DID WE HAND A LIBRARY SOMETHING IT REFUSED?
#
# This is NOT a fifth exception filter, and it does not contradict `downsample`'s
# conclusion that "no exception filter separates a bad input from a bug". That sentence is
# still true and is the reason this is not one: it does not look at the type at all.
#
# WHERE IT IS WRONG, stated rather than discovered, because both directions matter:
#
#   1. A C-EXTENSION FRAME IS INVISIBLE to a Python traceback. A `MemoryError` raised
#      inside `numpy.ascontiguousarray` is attributed to the CALLING Python line — ours.
#      That is why `MemoryError` is a declared carve-out below rather than left to the site
#      rule, on the argument `read_image` already wrote down: resource exhaustion decoding
#      or encoding ONE image is "an input-caused abort wearing a resource-shaped exception".
#   2. A BUG OF OURS THAT A PURE-PYTHON LIBRARY RAISES FOR US — handing `tifffile` a
#      wrong-typed argument — is attributed to the library and is CONVERTED. That is a real
#      misclassification and it is the direction this errs, deliberately. The two costs are
#      not symmetric: a misclassified bug is reported to the operator BY EXCEPTION TYPE AND
#      MESSAGE in `images_not_emitted` and costs one image, while a misclassified data error
#      costs the matrix, the coordinates, the columns and the report over one vendor file.
#      It is also the direction attempt 4 chose, and it carries attempt 4's remedy:
#      COVERAGE. Every propagate case is mutation-proved and every convert case is swept.
#
# See `docs/design/image-failure-provenance-refusal.md` §2 (#296/#297/#298).

#: EXACTLY THE MODULES THIS FILE'S BOUNDARIES IMPORT, as `importlib` reports them in
#: `ImportError.name`. A `ModuleNotFoundError` naming one of these — or a submodule of one — is
#: an ENVIRONMENT fact: the analysis rootfs does not have what the recipe pins. It must cost
#: ONE image. Anything else raised on one of our own `import` lines is this tree asking for a
#: module it does not import, which is a BUG, and it propagates.
#:
#: DERIVED, NOT DECLARED, and the distinction is a correction. This used to say "every one is
#: DECLARED in the packages' manifests", which is FALSE per package: `spatial-import-visium`'s
#: manifest says `imagecodecs` is *"deliberately NOT declared"* and `spatial-import-xenium`'s
#: says the same of `pillow` — and this file is vendored BYTE-IDENTICALLY into all three, so no
#: single constant can mirror three different manifests. What it can mirror, and now does, is
#: the set of modules THIS FILE imports at a boundary, re-derived from the source by `ast` in
#: `test_the_declared_libraries_are_exactly_the_ones_the_boundaries_import` — an EQUALITY, not
#: a subset, so the list cannot silently widen. `imagecodecs` is gone from it for that reason:
#: no boundary here imports it, it is reached from inside `tifffile`'s own frames, and the site
#: rule already handles it correctly there.
#:
#: WHY THIS LIST EXISTS AT ALL, and why it is not a fourth exception filter in disguise. It is
#: an allow-list of MODULE NAMES, not of exception types, and the difference is that a module
#: name is KNOWABLE from the source. Without it the `ImportError` carve-out below was measured
#: LAUNDERING A REAL BUG: renaming `import tifffile` to `import tiffile_typo` came back to the
#: user as "could not be decoded (ModuleNotFoundError: No module named 'tiffile_typo')" with
#: the import reporting SUCCESS — on `origin/main` that same typo aborted loudly, so the
#: carve-out was a REGRESSION against the very invariant it sits under (INV-2).
_DECLARED_LIBRARIES = frozenset({"numpy", "tifffile", "PIL"})

#: THE TWO FAILURES THE SITE RULE IS BLIND TO. Neither is a filter standing in for the rule —
#: each is a case where the frame the interpreter records is provably NOT the place the failure
#: came from — and BOTH are declared
#: in `docs/design/image-failure-provenance-refusal.md` §2, which is the only place either may
#: be added or widened:
#:
#: THEY ARE NOT SYMMETRIC, and an earlier header claimed they were ("converted whatever the
#: innermost frame says"). `MemoryError` IS converted whatever the frame says. `ImportError` is
#: not: since FIX_ROUND-3 the frame decides it completely and it can PROPAGATE — see
#: `image_failure_is_a_bug`, which is where the whole `ImportError` rule lives and which is why
#: that type never reaches the tuple lookup at all.
#:
#:   `MemoryError`  — raised by a C extension (`numpy`, the codecs) and therefore attributed
#:                    to OUR calling line. `read_image`'s history measured a real input-caused
#:                    instance: a 170-megapixel 16-bit RGBA image is UNDER PIL's bomb threshold
#:                    and still allocates ~1.4 GB, which is "an input-caused abort wearing a
#:                    resource-shaped exception". MEASURED again here under `RLIMIT_AS`: the
#:                    traceback is ONE frame deep and that frame is the caller's.
#:   `ImportError`  — `importlib` raises a MISSING module on the `import` statement's own line,
#:                    so a deferred `import tifffile` inside a boundary is attributed to the
#:                    boundary. MEASURED, and it is why moving those imports inside their `try`
#:                    (#298 E2) did nothing on its own: the site rule then re-raised them and
#:                    the abort was unchanged. **NARROWED TO `_DECLARED_LIBRARIES` above** — see
#:                    that constant for the bug this carve-out was laundering before it was.
#:                    (A library that is present but BROKEN raises whatever its module body
#:                    raises, from ITS OWN file, so the site rule already handles that half.)
#:
#: `RecursionError` is DELIBERATELY not here — `_PROPAGATE = (MemoryError, RecursionError)`
#: was attempt 3 and was deleted by `6f2ee131`; only the halves with a measurement return.
#: NOTHING ELSE MAY JOIN THEM WITHOUT A MEASUREMENT AND A DESIGN EDIT: this tuple is the one
#: place in the mechanism where an allow-list of exception types could be reintroduced, which
#: is `read_image`'s attempt 3 exactly, so it carries its own guard
#: (`test_the_carve_outs_are_exactly_the_two_the_design_declares`) and its own behavioural
#: mutants rather than resting on the `except`-clause guards, which cannot see it.
_SITE_RULE_IS_BLIND_TO = (MemoryError, ImportError)


def raised_in_own_code(exc, module_file):
    """Did a line IN `module_file` raise `exc`, or did a library `module_file` called?

    The INNERMOST traceback frame is the raising site — the outermost is merely whoever was
    on the stack. An exception with no traceback at all cannot be attributed, and answers
    `False`: an unattributable failure is treated as data, which is the direction that costs
    one image rather than the whole import.

    ## HOW TO CALL IT, and every way of getting it wrong

    Call it from inside an `except` block, passing the `__file__` of the module whose own code
    the guarded `try` can reach — nothing else. That is a real constraint and it used to fail
    SILENTLY in the swallow direction, which is the worst possible direction for a predicate
    whose whole job is to stop a bug being swallowed:

        no traceback (called outside an `except`)   -> False  — cannot attribute; still False,
                                                               and DOCUMENTED as the one
                                                               deliberate unattributable case
        the WRONG file (a sibling module's)         -> False  — was silent; still returns a
                                                               verdict, because a path that
                                                               exists is not detectably wrong
        a module OBJECT instead of a path           -> TypeError — was False
        `None`                                      -> TypeError — was False
        a `bytes` path                              -> TypeError — was False for EVERY input,
                                                               because `realpath(bytes)` is
                                                               `bytes` and `co_filename` is
                                                               always `str`

    The last two now RAISE. `os.path.realpath` throws `TypeError` on a non-path, and catching
    that turned a caller's argument bug into "this image is fine, convert it" — the exact
    laundering this predicate exists to prevent, one level up. `OSError` is still swallowed
    (a path on a dead mount is not the caller's fault and has no better answer than "not
    ours"); `TypeError` and `ValueError` are not.

    The remaining silent case — passing a sibling module's `__file__`, or reaching code in a
    sibling module from inside the guarded body — is limitation 4 of
    `docs/design/image-failure-provenance-refusal.md` §2. No guarded body calls across modules
    today; nothing detects it if one starts.
    """
    # `bytes` IS DELIBERATELY NOT ACCEPTED. `os.path.realpath(b"/x")` returns `bytes`, and
    # `co_filename` is always `str`, so a bytes path passes a type check and then compares
    # unequal to EVERYTHING — answering "not a bug" for every input, which is the silent
    # swallow this check exists to turn into a loud failure.
    if not isinstance(module_file, (str, os.PathLike)):
        raise TypeError(
            f"`module_file` must be the boundary's own `__file__` as `str` or `os.PathLike`, "
            f"got {type(module_file).__name__}. Answering False for a bad argument would "
            "convert a genuine bug into a skipped image, which is what this predicate exists "
            "to stop — and `bytes` is refused for exactly that reason, not by oversight: it "
            "would realpath to `bytes` and compare unequal to every `co_filename`.")
    tb = getattr(exc, "__traceback__", None)
    if tb is None:
        return False
    while tb.tb_next is not None:
        tb = tb.tb_next
    try:
        raised_by = os.path.realpath(tb.tb_frame.f_code.co_filename)
        boundary = os.path.realpath(module_file)
    except OSError:
        return False
    return raised_by == boundary


def image_failure_is_a_bug(exc, module_file):
    """Must `exc` PROPAGATE out of the image boundary in `module_file`?

    `True` only for a failure this tree's own code raised. A deliberate
    `ImageConversionError` is already in the importers' taxonomy and is re-raised by the
    boundary's own `except ImageConversionError: raise` clause ahead of this, so it answers
    `False` here too — this predicate decides one thing and one thing only: bug, or image.
    """
    if isinstance(exc, ImageConversionError):
        return False

    # THE SITE RULE IS ASKED FIRST, and the `ImportError` carve-out narrows only its "ours"
    # answer. Ordering these the other way round — the shape this handler had for one round —
    # short-circuits the site rule in exactly the case the carve-out was never about, and it
    # was MEASURED re-opening #298 E2: a library that is PRESENT BUT BROKEN raises from its own
    # module body, with `exc.name` either `None` (Pillow's mismatched-`_imaging` signal is a
    # hand-constructed `ImportError`) or the name of a TRANSITIVE dependency that
    # `_DECLARED_LIBRARIES` structurally cannot list. Both then read as "not a declared library"
    # and propagated a bare `ImportError` out of every boundary, aborting the whole import.
    #
    # Asked in this order, each of the four shapes lands where it should:
    #
    #   raised in OUR frame, name IS declared    -> the rootfs lacks a pinned library: CONVERT
    #   raised in OUR frame, name is NOT declared -> a typo in this tree: PROPAGATE
    #   raised in a LIBRARY's frame               -> that library is broken: CONVERT
    #   raised in a LIBRARY's frame, name None    -> same: CONVERT
    own = raised_in_own_code(exc, module_file)
    if isinstance(exc, ImportError):
        # `importlib` attributes a MISSING module to the `import` statement's own line, which
        # is the ONLY reason this carve-out exists — so it applies to the own-frame answer and
        # to nothing else. Two further narrowings, each closing a measured laundering:
        #
        # `ModuleNotFoundError`, NOT `ImportError`. A module that is ABSENT raises the former;
        # a NAME missing from a module that is PRESENT raises the latter, and its `.name` is
        # the PACKAGE, not the missing attribute — so `from PIL import Imagee` reported
        # `name='PIL'`, matched this list, and a typo of ours came back as a skipped image.
        # A `from X import Y` failure where X is present therefore PROPAGATES: the rootfs pins
        # exact versions, so a declared library that is present and lacks a name this file asks
        # for is a build defect or our typo, and neither is the vendor's file.
        #
        # THE ROOT PACKAGE, not the dotted name. A half-installed wheel reports
        # `name='PIL.Image'`, which never matched the list, so an environment fact PROPAGATED
        # and aborted the whole import — #298 E2, re-opened. Comparing the root closes that.
        # It would also convert a typo'd SUBMODULE of a declared package, which is genuinely
        # indistinguishable from a half-installed wheel — so that ambiguity is removed by
        # CONSTRUCTION instead: `test_every_boundary_import_is_a_plain_declared_module` refuses
        # a dotted or submodule import at any boundary, and there are none.
        if not isinstance(exc, ModuleNotFoundError):
            return own
        root = (getattr(exc, "name", None) or "").split(".")[0]
        return own and root not in _DECLARED_LIBRARIES
    if isinstance(exc, _SITE_RULE_IS_BLIND_TO):
        # THE DECLARED CARVE-OUT LIST, CONSULTED — not merely documented. An earlier round
        # replaced this lookup with an inline `isinstance(exc, MemoryError)` and left the tuple
        # in place with three comments and a design section still claiming it governed the
        # mechanism. It governed nothing: widening it to attempt 3's allow-list left all
        # eighteen own-code-bug legs GREEN, because the behavioural battery those comments
        # pointed at was no longer downstream of the constant. `ImportError` is handled above
        # and never reaches here, which is why it is the only member with its own branch.
        return False
    return own


# ── HOW read_image REPORTS FAILURE, and the four attempts it took ────────────────────
#
# EVERY failure to turn a file into an array leaves this function as
# `ImageConversionError`. Nothing else escapes. The caller's per-image guard therefore
# needs exactly one `except`, and the hard invariant holds: **no input can abort the
# import** (INV-6 — losing one image must never cost the matrix, the coordinates, the
# columns and the report).
#
# This is the FOURTH shape of this policy. The history is kept because each attempt failed
# in a way the next one had to learn:
#
#   1. `except Exception` — correct for the invariant, but a typo inside this function
#      then read as "not a readable image", so a bug on an UNTESTED branch silently cost
#      the user that image.
#   2. a DENY-list of bug types (`AttributeError, TypeError, NameError`) — a guess about
#      which bugs exist; it still swallowed `MemoryError`.
#   3. an ALLOW-list of decoder errors — measured, and still closed over the inputs that
#      had been measured. Two REAL inputs escaped and aborted the whole import: a genuine
#      182-megapixel PNG (`DecompressionBombError` subclasses `Exception` directly, and a
#      15000x15000 slide scan is 225 Mpx) and a TIFF with a zeroed dimension tag
#      (`ZeroDivisionError` inside `tifffile.detect_series`).
#   4. `except Exception`, plus TESTS that cover every decode branch — this one.
#
# Attempt 3 also briefly re-raised `(MemoryError, RecursionError)` on the theory that
# resource exhaustion is "not about the file". It is: PIL's bomb check only fires above
# 179 Mpx, so a 170-megapixel 16-bit RGBA image is UNDER the threshold and still allocates
# ~1.4 GB, which is a `MemoryError` in a memory-capped sandbox — an input-caused abort
# wearing a resource-shaped exception. A `MemoryError` decoding ONE image is recoverable:
# the allocation is freed, the image is skipped, `images_not_emitted` NAMES the exception
# type so an operator sees a resource problem rather than a data one, and the rest of the
# import completes. `KeyboardInterrupt` and `SystemExit` derive from `BaseException`, not
# `Exception`, so Ctrl-C still works.
#
# The code-bug concern from attempt 1 is real and is answered where it belongs: every
# decode branch this function has is exercised by a test (grayscale, RGB, 16-bit, palette,
# RGBA, TIFF), so a typo on any of them goes red. An untested branch is a coverage gap,
# and the fix for a coverage gap is coverage — not an exception filter that has now been
# wrong three different ways.
#
# That conclusion held, and #296 showed what it did NOT settle: `xenium_image.read_plane`
# had attempt 2's deny-list without attempt 4's coverage argument, so the two halves of one
# contract disagreed in two files. The answer, added above as
# `image_failure_is_a_bug`, is not a fifth filter — it does not look at the exception type
# at all. It asks the only question the four attempts were approximating, which is whether
# OUR code raised the failure or a library did. `except Exception` here is unchanged and
# still correct: this function's own branches are covered, and the discriminator is what
# lets the boundaries that are NOT allowed to swallow a bug keep that promise by name.


def read_image(path):
    """A vendor image as an `(H, W)` or `(H, W, C)` array.

    ## The DTYPE is not constrained, and callers must not assume it is

    This used to say "`uint8`/`uint16`", which is true of everything the PIL branch can
    return (`convert("RGB")`/`L`/`I;16`) and is NOT true of the TIFF branch: that one
    validates the AXIS ORDER and nothing else, so a float, signed or BILEVEL (`bool`) TIFF
    comes back with its own dtype. `downsample` is built on that fact and the two contracts
    disagreed in the same file, which is how a bool plane reached a float code path.

    Every `ImageConversionError` raised here names WHAT is wrong and NOT which file: the
    caller already prefixes the basename, and having both produced
    "tissue_hires_image.png: tissue_hires_image.png: not a readable image (...)" in the
    report a user reads.

    Dispatches on suffix rather than sniffing: the vendor bundle's member names are
    declared by `spatial/visium-bundle`, so the extension is contract, not a guess.
    """
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in _TIFF_SUFFIXES:
        # REFUSE anything that is not a plain 2-D plane, optionally with samples.
        #
        # `tifffile.imread` happily returns `(C, H, W)` for a multi-page or
        # `planarconfig='separate'` TIFF, and NOTHING downstream would notice: `extent_of`
        # would report `{width: H, height: C}` and `_halved` would average CHANNEL against
        # ROW. That is the transposition §7.3 rule 5 names, arriving through the axis order
        # instead of through a swapped subscript — and it is one `VENDOR_IMAGES` row away,
        # because `cytassist_image.tiff` and the Xenium morphology image are both TIFFs.
        # So the axis order is checked against what the file itself declares, and an
        # unexpected one is refused rather than guessed at.
        # Every decode failure leaves this function as `ImageConversionError`; only a
        # DELIBERATE `ImageConversionError` passes through, via the `except ...: raise` clause
        # below. (This sentence used to name a `_PROPAGATE` constant. That constant was REAL —
        # `_PROPAGATE = (MemoryError, RecursionError)`, added by #155 FIX_ROUND-8 and REMOVED
        # by `6f2ee131` "coverage replaces the exception filter", which is attempt 3 in the
        # history above. The comment outlived the mechanism, so a reader auditing this
        # taxonomy went looking for a filter that is deliberately gone — and its removal is
        # the very thing attempt 4 rests on. Recorded in #298.) The taxonomy is fixed HERE, at
        # the one place that knows what went wrong, so the caller needs a single `except`.
        try:
            # INSIDE the `try`, not above it (#298 E2): outside, a `tifffile` missing or
            # broken in the analysis rootfs raised `ImportError`, which is in neither
            # importer's guard tuple and cost the whole import rather than one image. It is
            # a decode failure like any other and leaves here as `ImageConversionError`.
            import tifffile

            with tifffile.TiffFile(str(path)) as handle:
                if not handle.series:
                    raise ImageConversionError(
                        "this TIFF contains no image series"
                    )
                series = handle.series[0]
                axes = str(series.axes)
                if axes not in ("YX", "YXS"):
                    raise ImageConversionError(
                        f"this TIFF's axis order is {axes!r}, and this "
                        "importer reads only a single 2-D plane ('YX') or a plane with "
                        "samples ('YXS'). A multi-page or planar-separate image arrives "
                        "as (C, H, W), which would be read as a transposed plane and "
                        "silently misplace every pixel. Refusing rather than guessing."
                    )
                arr = series.asarray()
        except ImageConversionError:
            # A DELIBERATE REFUSAL, not a damaged file. It is re-raised ahead of the
            # normaliser because `ImageConversionError` subclasses `RuntimeError` and
            # would otherwise be caught by `except Exception` and double-wrapped as
            # "not a readable TIFF (ImageConversionError: ... axis order ...)" — making
            # a refusal read exactly like corruption. This line was briefly deleted as
            # unreachable while the handler was an allow-list; restoring `except
            # Exception` made it load-bearing again, and the test caught it.
            raise
        except Exception as exc:
            raise ImageConversionError(
                f"not a readable TIFF ({type(exc).__name__}: {exc})"
            ) from exc
    elif suffix in _PIL_SUFFIXES:
        try:
            # BOTH imports inside the `try`, for the reason the TIFF branch gives above:
            # `pillow` is pinned in the rootfs, and the whole point of a per-image guard is
            # that the unlikely input costs one image too.
            import numpy as np
            from PIL import Image

            with Image.open(path) as im:
                # `RGB`/`L` only. A palette or `RGBA` image would otherwise reach the
                # writer with a channel count OME cannot describe as a plain photometric.
                im = im.convert("RGB" if im.mode not in ("L", "I;16") else im.mode)
                arr = np.asarray(im)
        except Exception as exc:
            raise ImageConversionError(
                f"not a readable image ({type(exc).__name__}: {exc})"
            ) from exc
    else:
        raise ImageConversionError(
            f"unsupported image extension {suffix!r}; this importer reads "
            f"{list(_PIL_SUFFIXES + _TIFF_SUFFIXES)}"
        )
    if arr.ndim not in (2, 3):
        raise ImageConversionError(
            f"expected a 2-D or 3-D image array, got ndim={arr.ndim}"
        )
    return arr


def extent_of(arr):
    """`{width, height}` for an image array — §6.6's raster extent.

    A numpy image is `(rows, cols) = (height, width)`, and §6.6's extent is
    `{width, height}`. That transposition is the single most likely bug in this file, and
    it is the reason INV-7 demands a NON-SQUARE fixture: on a square image a swapped pair
    is indistinguishable from a correct one.
    """
    return {"width": int(arr.shape[1]), "height": int(arr.shape[0])}


def inverse_scalefactor_affine(scalef):
    """`to_space` for an image the vendor scaled by `scalef` — the INVERSE (INV-2).

    `[1/s, 0, 0, 0, 1/s, 0]`, mapping THIS image's pixels INTO the full-resolution frame.

    The in-tree `multimodal.py:423-429` `visium_affine(s)` returns the FORWARD
    `[s,0,0,0,s,0]`, which maps full-res INTO the image. Both are 2x3 row-major and they
    differ by one reciprocal, so a mix-up is invisible to every type and shape check and
    silently misplaces every spot by a factor of `1/s²`. §7.3 calls it *"a one-line
    difference that is wrong for a year if nobody writes it down."* This is it, written
    down. The inverse is the direction that COMPOSES: N images at N scalefactors, one
    space, every pair placeable.
    """
    s = SD._number(scalef, "scalefactor")
    inv = 1.0 / s
    return [inv, 0.0, 0.0, 0.0, inv, 0.0]


def emitted_affine(scalef, factor):
    """`to_space` for the pixels this artifact ACTUALLY CONTAINS (#176).

    `[factor/s, 0, 0, 0, factor/s, 0]`. `factor == 1` is exactly
    [`inverse_scalefactor_affine`] and is asserted to be, so the two cannot drift apart.

    ## This is the half of a downsample that is invisible to every other check

    Downsampling the pixels and leaving the affine alone produces an artifact that is
    internally plausible in every way a type, shape or conformance check can see — the file
    opens, the extent matches the pixels, the affine is a well-formed 2x3 — and is
    misregistered by exactly `factor`. A spot drawn on it lands `factor` times too close to
    the origin. Nothing errors.

    The derivation: a source pixel `p` maps into the space by `p / s` (#155's
    inverse-scalefactor rule). After a box mean by `factor`, emitted pixel `q` covers source
    pixels `q*factor .. q*factor+factor-1`, so `q` maps to `q * factor / s`. Equivalently —
    and this is the form the reconciliation checks — `to_space[0] *
    space.microns_per_pixel` is the physical size of ONE EMITTED PIXEL, which must be the
    `applied_resolution_um` the provenance records.

    ## THE PIXEL-ANCHOR CONVENTION, and why there is NO translation term

    This is a real choice and it was got wrong once in this issue, so it is written down.

    A downsample raises a question `factor == 1` never asks: does an emitted index denote
    its pixel's CORNER or its CENTRE? Emitted pixel `q` covers source `[q*f, (q+1)*f)`,
    whose corner is `q*f` and whose centre is `q*f + (f-1)/2`. The two differ by a
    translation of `(factor-1)/(2s)` full-resolution units — 5 px on this repo's fixture at
    factor 3 — and at `factor == 1` they COINCIDE, which is why no pre-existing test, and
    no vendor number, can distinguish them.

    **CORNER is chosen, i.e. no translation, because that is what this tree's only raster
    placement model already means.** `viz-core/spatial/imageTiles.ts` defines
    `ImageWorldBounds` as *"the world coordinates of the image's pixel corners …
    `left`/`right` are the world x at pixel x=0 / x=width"*, and
    `viz-core/data/affineMatrix.ts` composes a `to_space`-shaped affine as a deck.gl
    `modelMatrix` applied OVER those bounds. In that composition the affine's translation is
    a WHOLE-IMAGE world offset, so adding `(factor-1)/(2s)` there would SHIFT the image by
    half a block rather than centre it — introducing exactly the defect it looks like it
    removes.

    A centre-anchored translation was briefly added here, on the argument that the vendor's
    `pxl_*_in_fullres` are spot CENTRES. That argument does not carry: those are POINT
    coordinates in a continuous frame, and they say nothing about how a raster's integer
    index is anchored. The marker round trip cannot settle it either — it locates a centroid
    of saturated emitted indices and compares it to a full-resolution point, so it measures
    a convention against itself; on the fixture it moves the x error from -2.5 to +2.5 and
    only improves y.

    **Nothing in this repo can currently falsify either convention: `to_space` has no
    consumer in any Rust or TypeScript file yet** (#158 builds the loader, #159 wires the
    DataSource). Corner is therefore the conservative choice — it is consistent with
    `ImageWorldBounds`, it is what #155 ships, and it keeps the emitted affine a pure scale
    like every other affine in the epic. **#158/#159 must confirm it against a real
    renderer, and the alternative is recorded rather than lost.**
    """
    if not isinstance(factor, int) or isinstance(factor, bool) or factor < 1:
        raise ImageConversionError(
            f"downsample factor {factor!r} must be an integer >= 1"
        )
    base = inverse_scalefactor_affine(scalef)
    return [base[0] * factor, 0.0, 0.0, 0.0, base[4] * factor, 0.0]


def downsample_plan(original_resolution_um, cap_um, extent):
    """What to do with a source at `original_resolution_um` — `(factor, applied_um, extent)`.

    Replaces #155's `refuse_if_finer_than_cap`, which existed only because this item did not
    exist yet: its refusal text said *"emitting it would require real downsampling — which
    this importer does not do (#176 owns it)"*. It does now.

    `factor == 1` is the pass-through, which is every image in a standard Visium bundle
    (~3.7 µm/pixel against a 0.5 µm/pixel cap — 7x COARSER). A finer source gets the smallest
    integer factor that meets the cap; the arithmetic and the reasons live in
    `spatial_declarations.downsample_factor`.

    The returned `applied_um` is the ACHIEVED resolution (`original * factor`), never the
    cap — an integer factor generally overshoots, and recording the cap would be a resolution
    the emitted pixels do not have.

    Raises `SD.SpatialDeclarationError` (which `emit_images` already catches, so it costs one
    image and not the import) when the factor would leave the grid under one pixel.
    """
    grid = SD._extent(extent, "downsample_plan.extent")
    factor = SD.downsample_factor(original_resolution_um, cap_um)
    # ONE derivation of `applied_resolution_um`, shared with
    # `display_derivative_provenance`, because leg 4 of the reconciliation requires the two
    # to be equal and two spellings of one formula is how they stop being.
    applied = SD.applied_resolution(original_resolution_um, factor)
    emitted = {"width": grid["width"] // factor, "height": grid["height"] // factor}
    if emitted["width"] < 1 or emitted["height"] < 1:
        raise SD.SpatialDeclarationError(
            f"a {grid['width']}x{grid['height']} source needs a downsample factor of "
            f"{factor} to reach the {SD._number(cap_um, 'cap'):g} um/pixel cap, which leaves "
            f"{emitted['width']}x{emitted['height']} pixels — not an image."
        )
    return factor, applied, emitted


def downsample(arr, factor):
    """`arr` reduced by an integer `factor`, by BOX MEAN — averaging, never decimation.

    Decimation (`arr[::f, ::f]`) would be cheaper and is what most quick pyramids do, but
    it throws away all but one of every `f x f` measurements and makes a thin bright feature
    blink in and out as the viewer changes zoom. Averaging is what #176 means by
    downsampling: *"fewer, larger pixels, each a real average of real measurements"* — as
    opposed to lossy compression, which keeps the pixel count and invents the values.

    A ragged final strip is dropped rather than replicated: replicating would invent a
    measurement. This is why the emitted extent is a FLOOR division, and
    `display_derivative_provenance` derives it the same way.

    **How much is dropped, stated honestly.** #155's wording here was "an odd final
    row/column ... one edge pixel", which was true at its only factor (2) and is NOT true in
    general: at factor `f` this discards up to `f-1` rows AND up to `f-1` columns of real,
    measured tissue. That is a real if small loss from an artifact whose claim is that every
    emitted pixel is a real average of real measurements, so the producer REPORTS the
    dropped strip rather than leaving the reader to derive it from the two grids.

    ## One resampler, two callers

    Both the display derivative (`factor` from the resolution cap) and each rendering pyramid
    level (`factor == 2`) go through here. They were separate once and that is exactly how a
    tree ends up averaging in one place and decimating in the other; #155's pyramid box-mean
    test is the regression control that `factor == 2` still behaves identically.

    ## Why every failure leaves here as `ImageConversionError`

    The reshape and the reduction ALLOCATE, so a large plane can raise `MemoryError` here —
    and `MemoryError` is not in `emit_images`' `except` tuple, so an uncaught one would abort
    the whole import and cost the matrix, the coordinates, the columns and the report over a
    single image. The taxonomy is fixed here, at the one place that knows what went wrong,
    exactly as `read_image` does, and for the conclusion `read_image` paid four attempts to
    reach: `tifffile` raises `TypeError` on malformed tags while a legitimate image raises
    `MemoryError`, so **no exception filter separates a bad input from a bug** — the
    separation belongs in coverage, and every branch here is covered.

    That sentence is still true and is precisely why `image_failure_is_a_bug` is not a
    filter: it partitions by the RAISING SITE, never by the type. This function does not
    need it — every branch here is covered and `except Exception` is the right answer for a
    function that small — and it is named here so a reader comparing the two boundaries sees
    that they agree rather than guessing that one of them was missed (#296).
    """
    if not isinstance(factor, int) or isinstance(factor, bool) or factor < 1:
        raise ImageConversionError(
            f"downsample factor {factor!r} must be an integer >= 1; a fractional factor "
            "needs interpolation, which invents values between source pixels"
        )
    if factor == 1:
        return arr
    try:
        # INSIDE the converting `try` (#298 E2) — see `read_image`'s TIFF branch.
        import numpy as np

        h, w = arr.shape[0] // factor, arr.shape[1] // factor
        if h < 1 or w < 1:
            raise ImageConversionError(
                f"downsampling {arr.shape[1]}x{arr.shape[0]} pixels by {factor} leaves "
                f"{w}x{h} — not an image"
            )
        clipped = arr[: h * factor, : w * factor]
        if clipped.ndim == 2:
            blocks = clipped.reshape(h, factor, w, factor)
        else:
            blocks = clipped.reshape(h, factor, w, factor, clipped.shape[2])
        mean = blocks.mean(axis=(1, 3))
        # ROUND for a dtype that cannot hold a fraction; keep the mean for one that can.
        #
        # `astype` alone TRUNCATES an integer result, which biases it darker by up to one
        # count and compounds across pyramid levels — that is why the rounding is here.
        #
        # But rounding a FLOAT plane QUANTIZES real data: a float32 image in [0,1] would
        # collapse to {0.0, 1.0}. That was harmless while this function only built preview
        # pyramid levels from the uint8/uint16 PNGs `read_image` decodes; #176 routes the
        # EMITTED level-0 pixels through the same line, and `read_image`'s TIFF branch
        # checks only the AXIS ORDER, never the dtype.
        #
        # NOT REACHABLE FROM ANY SHIPPED PATH TODAY, and saying so matters. `VENDOR_IMAGES`
        # is the two Visium PNGs, and the PIL branch converts every one of them to RGB/L/
        # I;16 — so no float or bool array can arrive through the importer as it stands. An
        # earlier version of this comment claimed "the multi-GB Xenium image this module
        # exists for" reaches here, which is doubly wrong: nothing reaches the TIFF branch
        # yet, and design §8.2 says a 5-50 GB OME-TIFF "exceeds the 8 GiB per-file ingest
        # cap and is unstageable" anyway. The branch is kept because the dtypes are a
        # property of `read_image`'s CONTRACT rather than of today's callers, and because
        # the bool case below was a live wrong answer the moment anything did arrive — but
        # it is exercised only by this module's unit tests, not by the producer.
        #
        # ## BOOL IS NOT A FLOAT, AND THE FIRST CUT OF THIS BRANCH GOT IT WRONG
        #
        # `np.issubdtype(np.bool_, np.integer)` is **False**, so a bilevel/mask TIFF took
        # the float branch, where `mean.astype(bool)` is a LOGICAL OR: any single set pixel
        # in the block saturates the output, and it compounds per level. Measured through
        # `pyramid_levels` on a 2%-set mask: 8.6% → 32.4% → 75.0% → **100%** by level 4 —
        # a solid-white overview — where the rounded majority gives 0% at every level. It compounds per
        # level and it directly falsifies the report's own "every emitted pixel is the mean
        # of a real block of real measurements".
        #
        # So the branch keys on whether the dtype can REPRESENT a fraction, which is the
        # property that actually matters, rather than on `integer`, which happens to
        # exclude the one non-float dtype that also cannot.
        if np.issubdtype(arr.dtype, np.inexact):
            return mean.astype(arr.dtype)
        return np.rint(mean).astype(arr.dtype)
    except ImageConversionError:
        raise
    except Exception as exc:
        raise ImageConversionError(
            f"could not downsample by {factor} ({type(exc).__name__}: {exc})"
        ) from exc


def pyramid_levels(arr, *, min_side=PYRAMID_MIN_SIDE):
    """The sub-resolution levels BELOW `arr` — possibly none.

    Level 0 (`arr` itself) is not included and is never resampled: the full-resolution
    plane in the emitted file is the source, bit-for-bit. Returns `[]` for a source
    already at or below `min_side`, which is the single-level (trivial) pyramid.
    """
    levels = []
    current = arr
    while min(current.shape[0], current.shape[1]) // 2 >= min_side:
        current = downsample(current, 2)
        levels.append(current)
    return levels


#: Relative tolerance for the scale reconciliation. The quantities compared are computed by
#: different multiplication ORDERS from the same float64 inputs, so they agree to ~1e-16 when
#: correct; 1e-9 is comfortably above that and far below the smallest error worth catching (a
#: dropped factor is off by an integer >= 2, i.e. by 100% or more). Deliberately not `==`:
#: exact equality here would go red on round-off and be relaxed to nothing by the next person.
_SCALE_RTOL = 1e-9


def _reconcile_scale(placement, arr, image_microns_per_pixel):
    """THE SCALE-AFTER-DOWNSAMPLE CHECK (#176). Raises, or returns None.

    Called from `write_ome_tiff`, which is the one place in this system where the EMITTED
    PIXELS and the DECLARATION that describes them are both in scope — the same reason the
    extent assert lives there (#155). Every other layer sees one or the other.

    The defect this exists to catch does not error, does not change a type, does not change a
    shape, and passes `conform_outputs`: an image downsampled by `factor` whose declared scale
    still describes the source. Every downstream micron measurement — every neighbour-graph
    radius, every colocalization distance, every spatially-variable-gene bandwidth — is then
    wrong by exactly `factor`, with a plausible number at the end and nothing anywhere saying
    so. It is the same shape as the forward-vs-inverse affine mix-up §7.3 calls "a one-line
    difference that is wrong for a year if nobody writes it down".

    Four facts describe the same pixel pitch and they are computed by four different routes:

    | fact | route |
    |---|---|
    | `arr.shape` | the pixels themselves |
    | `derivative.emitted_extent` | `original_extent // downsample_factor` |
    | `to_space[0] * require_micron_scale(space)` | the affine and the SPACE's scale (`1.0` for a micrometre space, the declared `microns_per_pixel` for a pixel one) |
    | `image_microns_per_pixel` | what goes into OME `PhysicalSizeX/Y` |

    Dropping the factor from any ONE of them is a real, reachable mistake — they are set on
    four different lines of `emit_images` — and each drop makes exactly one row disagree.

    ## What this does NOT check, stated so it is not over-read

    It reconciles the artifact with ITSELF. Four things it cannot see:

    * whether `original_resolution_um` ever described the source. That number comes from the
      vendor — Visium's `spot_diameter_fullres`, Xenium's `experiment.xenium` `pixel_size` —
      and if the vendor's is wrong then every row above agrees and the whole artifact is
      uniformly, invisibly misscaled. "#156's registration overlay is the only real check,
      and #176's TEST-11 measures the gap rather than pretending it is shut." — that
      paragraph is corrected rather than removed, because a disclosure of absence and its
      retirement are the same claim in two directions. A registration overlay now exists for
      ALL THREE producers — Visium (#156), Xenium (#301) and Visium HD (#313) — and they
      measure DIFFERENT REFERENTS, because what lies outside the artifact is a property of
      the PLATFORM: Visium's scores the spot lattice against the slide's manufactured 100 µm
      glass pitch and the vendor's own `in_tissue` call; Xenium's has neither, so it scores
      the cell centres placed through the declared `to_space` against a signal mask derived
      from the morphology pixels (`SIGNAL_LIFT_FLOOR = 0.4`); Visium HD's scores the bin
      lattice pitch against the VENDOR-DECLARED `bin_size_um` — one notch weaker, by its own
      accounting, because that is not a manufactured glass constant (a `bin_size_um` wrong in
      the same proportion as `microns_per_pixel` would pass there and would not pass on
      Visium). Xenium also states the scale TWICE, in two files written by two parts of the
      vendor pipeline (`experiment.xenium`'s `pixel_size` and the morphology TIFF's own
      OME-XML `PhysicalSizeX/Y`), so a SINGLE-SOURCE error is catchable by the producer
      before it reaches this function. "`spatial-import-xenium` does that cross-check and
      refuses the image on a disagreement." — that sentence is corrected rather than removed,
      because a disclosure of absence and its retirement are the same claim in two
      directions. #269 removed the refusal: `stated_scale_agreement` measures the TWO vendor
      statements and returns `(stated_scales, warning_or_None)`, the call site appends the
      warning to `pending_warnings`, and the image is EMITTED with both raw numbers and
      `applied_source` recorded; when the two statements disagree, the Xenium overlay scores
      both placements side by side. The residue is measured rather than closed: a vendor
      wrong the SAME way in both statements, by a uniform error under about 2%, still passes
      everything internal, and the overlay is what NARROWED the hole rather than closed it:
      a 2% misscale already scores signal-lift 0.303, BELOW the 0.4 floor, so about 2% is
      the boundary and the unresolved band lies strictly under it (a 1.5x error scores
      0.000);
    * whether the emitted pixels are a box MEAN of the source rather than a DECIMATION of
      it — same shape, same extent, same factor, same affine. Closed by coverage (TEST-4),
      because pixel VALUES appear in no declaration this function can compare against;
    * whether `original_extent` is the source's real grid. Leg 2 is a FLOOR division, so
      widths 399, 400 and 401 all satisfy it at factor 3 (each floors to 133) — the source array is out of scope
      by the time this runs, so nothing here can close it. It is correct BY CONSTRUCTION at
      the one producer call site, which takes `extent_of(arr)` before resampling;
    * the TRANSLATION term of the affine. Leg 3 multiplies `to_space[0]`, so a wrong or
      missing `to_space[2]`/`[5]` passes every leg — which is exactly how a half-block
      registration shift survived this function and had to be caught by a geometric round
      trip instead (see `emitted_affine`).
    """
    if not isinstance(placement, dict):
        return
    derivative = placement.get("display_derivative")
    # THE SPACE'S SCALE, RESOLVED BY UNIT — not read out of one key (#162).
    #
    # This used to be `placement.get("microns_per_pixel")`, which is correct for a PIXEL
    # space and unsatisfiable for a MICROMETRE one: `SD.coordinate_space` REFUSES
    # `microns_per_pixel` for `unit="micrometre"` ("the coordinates are already in
    # microns"), while leg 3 below RAISES when it is absent. The two shared rules
    # contradicted each other, so no micron-space image could ever carry display-derivative
    # provenance — and every Xenium image is 0.2125 um/pixel against the 0.5 um/pixel cap,
    # i.e. ALWAYS downsampled, i.e. ALWAYS carrying one.
    #
    # `SD.require_micron_scale` is the helper written for exactly this question: it answers
    # `1.0` for a micrometre space BY DEFINITION and the declared `microns_per_pixel` for a
    # pixel space. So for every Visium placement this resolves to the identical number it
    # read before, and for a micrometre space leg 3 becomes `to_space[0] * 1.0`, which is
    # the physical size of one emitted pixel by definition of the unit.
    #
    # The `except` keeps the ABSENT case landing on the existing refusal below, verbatim,
    # rather than on `require_micron_scale`'s own (differently-worded) message — this
    # function's error text is asserted by shipped tests and generalising the check must not
    # move it.
    try:
        space_scale = SD.require_micron_scale(
            placement, consumer="the display-derivative scale reconciliation"
        )
    except SD.SpatialDeclarationError:
        space_scale = None

    # The two absence cases must agree with each other, or "no provenance" becomes a way to
    # skip this check. An image is emitted WITHOUT provenance only when its resolution could
    # not be evaluated at all (the bundle declared no micron scale, INV-5) — and in that case
    # there is no `microns_per_pixel` and no OME `PhysicalSize*` either.
    if derivative is None:
        if image_microns_per_pixel is not None:
            raise SD.SpatialDeclarationError(
                "this image is being written with an OME PhysicalSize of "
                f"{image_microns_per_pixel!r} but carries NO display-derivative provenance. "
                "A producer that knows the pixel pitch knows the resolution, so the block "
                "should exist; emitting the header without it would put a scale in the "
                "bytes that nothing in the declaration can be reconciled against."
            )
        return
    if not isinstance(derivative, dict):
        raise SD.SpatialDeclarationError(
            f"`display_derivative` must be a mapping, got {derivative!r}"
        )
    try:
        factor = derivative["downsample_factor"]
        applied = derivative["applied_resolution_um"]
        emitted = derivative["emitted_extent"]
        source_grid = derivative["original_extent"]
    except KeyError as exc:
        raise SD.SpatialDeclarationError(
            f"`display_derivative` is missing {exc}; build it with "
            "`display_derivative_provenance()` rather than by hand"
        ) from None
    # The factor is VALIDATED before it is divided by. This function's own docstring says it
    # re-derives precisely because "a hand-built or constructor-bypassing block reaches this
    # function without ever passing through `display_derivative_provenance`'s own
    # derivation" — and for such a block a factor of 0 raised `ZeroDivisionError` and a
    # non-numeric one raised `TypeError`. Neither is `SpatialDeclarationError`, neither is
    # caught by `emit_images`, and either would abort the whole import from inside the one
    # function whose entire job is to refuse a bad declaration cleanly. The `KeyError` path
    # immediately above was already converted; these were the two that were not.
    if not isinstance(factor, int) or isinstance(factor, bool) or factor < 1:
        raise SD.SpatialDeclarationError(
            f"`display_derivative.downsample_factor` is {factor!r}; it must be an integer "
            ">= 1 (1 means the image passed through untouched)"
        )
    # THE OTHER THREE VALUES THIS FUNCTION DIVIDES, MULTIPLIES AND SUBTRACTS BY, validated
    # for the SAME reason and by the same argument as the factor above (#298 E3). The
    # `except KeyError` a few lines up covers only the four TOP-LEVEL keys, so a
    # `original_extent` that is not a mapping raised `TypeError` at `source_grid["width"]`,
    # one missing `width`/`height` raised a second `KeyError` that nothing converted, and a
    # non-numeric `applied_resolution_um` or `to_space` element raised `TypeError` at the
    # arithmetic in legs 3 and 4. None of those three is `SpatialDeclarationError`, none is
    # caught by either importer, and each aborted the whole import from inside the one
    # function whose entire job is to refuse a bad declaration CLEANLY.
    #
    # Reachable through a HAND-BUILT placement, which this function's own docstring says is
    # the case it exists for: both importers build the block through `SD.image_meta`, so
    # they are guarded by construction, and this is the regression pin on that construction.
    # THE CONSTRUCTOR'S OWN RULE, CALLED — not a second expression of it. This block used to
    # re-derive "is it a mapping with integer width and height", and the two versions already
    # disagreed in three directions: `SD._extent` accepts `44.0` and this refused it, this
    # accepted a width of `0` and `SD._extent` refuses it, this accepted a stray `depth` key
    # and `SD._extent` refuses it. The refusal message a few lines up tells the caller to
    # "build it with `display_derivative_provenance()`", so the rule that decides must be the
    # one that constructor uses, or the advice is wrong.
    #
    # AND THE RESULT IS COMPARED BACK, WHICH IS THE HALF THAT WAS MISSING. `_extent` NORMALISES
    # — it is `int(_number(...))`, so it TRUNCATES — and merely rebinding its return let a
    # `{"width": 44.9}` block pass leg 2 on the truncated 44 and then ship `44.9` into the
    # artifact's own `cyto` payload, where the inline rule had refused it. Measured end to end.
    # `display_derivative_provenance` STORES what `_extent` returns, so a constructor-built
    # block is unchanged by this comparison and only a hand-built one can trip it — which is
    # the caller this function exists for.
    normalised = SD._extent(source_grid, "display_derivative.original_extent")
    if normalised != source_grid:
        raise SD.SpatialDeclarationError(
            f"`display_derivative.original_extent` is {source_grid!r}, which is not already a "
            f"pixel grid — it normalises to {normalised!r}. A pixel count is an integer, and "
            "silently truncating one here would put a number in the artifact's declaration "
            "that no reader could reconcile against the grid it describes. Build it with "
            "`display_derivative_provenance()` rather than by hand."
        )
    source_grid = normalised
    applied = SD._number(applied, "display_derivative.applied_resolution_um")

    # LEG 1 — the provenance describes THESE pixels. This is the pixel-anchored leg: it
    # compares a declared number against `arr.shape` itself.
    if emitted != extent_of(arr):
        raise SD.SpatialDeclarationError(
            f"the display derivative says the emitted grid is {emitted!r} but the array "
            f"being written is {extent_of(arr)!r}. Either the pixels were not downsampled "
            "and the provenance says they were, or they were downsampled by a different "
            "factor than the one recorded."
        )
    # LEG 2 — the recorded factor really is the ratio of the two grids. Transitively, with
    # leg 1, this pins the EMITTED PIXEL COUNT to `original_extent // downsample_factor`.
    # Re-derived here rather than trusted, because a hand-built or constructor-bypassing
    # block reaches this function without ever passing through
    # `display_derivative_provenance`'s own derivation.
    expected = {"width": source_grid["width"] // factor,
                "height": source_grid["height"] // factor}
    if expected != emitted:
        raise SD.SpatialDeclarationError(
            f"the display derivative records a {normalised!r} source at factor {factor}, "
            f"which is {expected!r} emitted pixels, but it declares {emitted!r}."
        )
    # LEG 3 — the AFFINE absorbed the factor. `to_space[0] * microns_per_pixel` is the
    # physical size of one emitted pixel derived from the placement alone; it must be the
    # resolution the provenance claims. Downsample the pixels and leave the affine at
    # `1/scalefactor` and this is the ONLY thing in the system that notices.
    if space_scale is None:
        raise SD.SpatialDeclarationError(
            "this image carries display-derivative provenance but its coordinate space "
            "declares no `microns_per_pixel`, so the affine's implied pixel pitch cannot be "
            "reconciled against the recorded resolution. The provenance is derivable only "
            "FROM the space's scale, so a block without one is incoherent."
        )
    affine = placement.get("to_space") or []
    if len(affine) != 6:
        raise SD.SpatialDeclarationError(
            f"the placement's `to_space` is not a 2x3 affine: {affine!r}"
        )
    # A single `applied_resolution_um` IS an isotropy claim, so BOTH axes are checked against
    # it. Anisotropic emitted pixels would need two recorded resolutions, and this check is
    # where that would have to be revisited rather than quietly relaxed.
    for axis, index in (("X", 0), ("Y", 4)):
        # THE ELEMENT TYPES, not just `len(affine) == 6` (#298 E3). The length check above
        # admits `["1.0", 0, 0, 0, 1.0, 0]`, whose multiplication below raised a bare
        # `TypeError` that neither importer catches.
        # `allow_zero=True`, matching `SD.coordinate_space`, which builds every one of these
        # six elements the same way. An affine COEFFICIENT is not a measurement: zero and
        # negative are legal spellings (a flip, a degenerate axis), and refusing them here
        # would state a rule the constructor does not have. Such an affine still fails the
        # tolerance comparison below, which is the check that actually owns that question.
        element = SD._number(affine[index], f"the placement's `to_space[{index}]`",
                             allow_zero=True)
        implied = element * space_scale
        if abs(implied - applied) > _SCALE_RTOL * max(abs(applied), abs(implied)):
            raise SD.SpatialDeclarationError(
                f"the affine implies {implied!r} um per emitted pixel on {axis} "
                f"(to_space[{index}]={element!r} x microns_per_pixel={space_scale!r}) "
                f"but the display derivative records applied_resolution_um={applied!r}. "
                "A downsampled image whose declared scale still describes the ORIGINAL is "
                "worse than no downsampling: every downstream micron measurement silently "
                f"scales wrong by the factor ({factor}). Fold the factor into the affine, or "
                "record the resolution the emitted pixels actually have."
            )
    # LEG 4 — the OME header agrees. `PhysicalSizeX/Y` is what a generic OME reader — one
    # that knows nothing about the `cyto` payload — measures with, so a pre-downsample value
    # here misscales every non-CytoAnalyst tool by exactly the factor.
    if image_microns_per_pixel is None:
        raise SD.SpatialDeclarationError(
            "this image carries display-derivative provenance but is being written with no "
            "OME PhysicalSize. A generic OME reader would then have no scale at all for an "
            "image whose scale is known and recorded."
        )
    ome_scale = SD._number(image_microns_per_pixel, "image_microns_per_pixel")
    if abs(ome_scale - applied) > _SCALE_RTOL * max(abs(applied), abs(ome_scale)):
        raise SD.SpatialDeclarationError(
            f"OME PhysicalSizeX/Y would be written as {ome_scale!r} um while the display "
            f"derivative records applied_resolution_um={applied!r}. These describe the same "
            "pixels through two different readers; the OME header is what a generic reader "
            "measures with, so a pre-downsample value here misscales every tool outside this "
            f"system by exactly the downsample factor ({factor})."
        )


#: The sample counts this system can emit, and it is NOT a preference — it is the READER's
#: documented contract, quoted from `libs/viz/src/viz-core/spatial/omeTiffPyramid.ts`'s
#: `MultiPlaneImageUnsupportedError`:
#:
#:     This loader reads ONE plane — an interleaved RGB/RGBA image or a single-sample
#:     greyscale image — and refuses rather than return a pyramid whose declared channel axis
#:     it cannot honour, which would render every channel with the first one's pixels and
#:     report nothing.
#:
#: and, in the same block, the sentence that names WHY the writer is the one that has to hold
#: this shut: *"Every image this system EMITS is a single plane (interleaved RGB or one
#: greyscale sample), so this refusal names a raw vendor file reaching the reader, not one of
#: our artifacts."* That sentence is a claim about THIS FUNCTION. Emitting a 2-sample or
#: 6-sample artifact falsifies it, and falsifies it SILENTLY: the reader's two refusals
#: (`getImageCount() > 1` and `PlanarConfiguration == 2`) both pass for such a file, its
#: `interleaved` rule is `samples === 3 || samples === 4`, so the source is declared
#: `[1, height, width]` over an interleaved raster and `TiffPixelSource._readRasters` takes
#: `raster[0]` — sample 0 rendered as the whole image, with nothing saying so.
#:
#: MEASURED, because the direction of the trade is the whole argument. On `origin/main` a
#: `(300, 220, 2)` array emitted **300 top-level IFDs**, so the reader threw
#: `MultiPlaneImageUnsupportedError` BY NAME. Classifying it correctly collapses that to 1 IFD
#: with `SamplesPerPixel=2, PlanarConfiguration=1` — a truthful OME header that this system's
#: own viewer then renders wrong in silence. Trading a loud refusal for a silent partial render
#: is a worse artifact than the one #266 filed, however correct its header is, so the sample
#: counts outside the reader's contract are refused HERE, where the refusal costs one image and
#: is NAMED in `images_not_emitted`. #266 itself says so: *"Refusing is defensible and probably
#: right ... the refusal names it and someone decides deliberately."*
#:
#: Lifting this is #288 (teach the reader) — at which point this tuple is the one line to
#: change, and the OME header the rest of this function emits is already correct for it.
READABLE_SAMPLE_COUNTS = (1, 3, 4)


def _sample_layout(arr):
    """`(arr, photometric, extrasamples)` — the ONE thing `tifffile` is told about the axes.

    `tifffile` does not read `SizeX`/`SizeY`/`SizeC` off the array. It DERIVES them from what
    the caller declares the trailing axes MEAN, and the array does not carry that: whether the
    last axis of an `(H, W, S)` is *samples of one pixel* or *separate planes of a stack* is a
    statement the writer makes, not a fact numpy holds. Getting it wrong produces a file whose
    pixels round-trip perfectly under a header describing a different image — which is exactly
    what this function exists to stop, and what #266 measured.

    ## The expression this replaces, and why the obvious repair is not enough

        photometric = "rgb" if arr.ndim == 3 and arr.shape[2] == 3 else "minisblack"

    `read_image` accepts any TIFF series whose axes are `YX` or `YXS`, and
    `xenium_image.read_plane` accepts `YXS` too. **`YXS` DOES NOT MEAN `S == 3`.** An RGBA or a
    2-sample vendor TIFF is `YXS` with `S == 4` or `S == 2`; a single-sample series is `YXS` with
    `S == 1`. Every one of those fell through to `minisblack` with no `planarconfig`, and
    `tifffile`'s `photometricsamples == 1` branch then reads `width = shape[-1]`,
    `length = shape[-2]` — taking the SAMPLE AXIS FOR X and the rows for separate planes.
    Measured through this function at `(900, 700, 4)` uint8, the emitted OME-XML said
    `SizeX="4" SizeY="700" SizeC="900"`, and #227's tiling then padded each of those 900
    mis-shaped 4x700 "planes" to a whole 512x512 tile. Two different size numbers get quoted for
    that and they are NOT the same comparison, so both are labelled here: #266 measured the
    MIS-CLASSIFIED file stripped-vs-tiled (591,903 -> 2,821,109 B, 4.77x — the cost #227's tiling
    added ON TOP of the misclassification), while classifying it correctly is what this change
    saves (5,765,799 -> 3,104,538 B, 1.86x, at this module's own `TILE`/`PYRAMID_MIN_SIDE`/
    deflate settings).

    Note the issue title says `S` not in `{1, 3}`; **`S == 1` is broken by the same expression**
    and is fixed here rather than deferred. With `ome=True` the trailing-1 squeeze that
    `tifffile`'s `shaped` format applies is not reached, so `(H, W, 1)` emitted
    `SizeX=1 SizeY=W SizeC=H`.

    So the repair cannot be another equality on one dimension. Each arm below is grounded in a
    specific, verified statement of `tifffile`'s contract (read from its source and its parameter
    docs at 2025.5.10, and round-tripped) or of the READER's, and there is no fall-through:

    IN BRANCH ORDER, because the order is load-bearing — an earlier draft listed it by
    "interestingness" and thereby implied a row that cannot be reached (a bilevel `(H, W, 2)`
    gets the SAMPLE-COUNT message, never the bilevel one, because the count is tested first):

    | # | `arr` | photometric | extrasamples | the fact it rests on |
    |---|---|---|---|---|
    | 1 | `ndim` not 2 or 3 | REFUSED | | not a plane, with or without samples. |
    | 2 | `ndim == 2` | `minisblack` | - | one sample, one plane. Unchanged. |
    | 3 | `S < 1` | REFUSED | | a zero-sample array is not an image. |
    | 4 | `S == 1` | `minisblack` | - | reshaped to `(H, W)` FIRST — see below. |
    | 5 | `S` not in `READABLE_SAMPLE_COUNTS` | REFUSED | | see that constant. |
    | 6 | bilevel (`S` is now 3 or 4) | REFUSED | | `tifffile` cannot write it losslessly. |
    | 7 | `S == 3` | `rgb` | - | three interleaved samples is what RGB means. Unchanged. |
    | 8 | `S == 4` | `rgb` | `("unassalpha",)` | TIFF 6.0's RGBA; see the `S == 4` note. |

    **There is no `planarconfig` here, and its absence is the point.** An earlier cut of this
    function returned one, because the arm it was for — `minisblack` + `planarconfig="contig"`,
    which is how TIFF spells "S interleaved samples, no colour claimed" — is what would let this
    writer emit ANY sample count with a truthful header. That arm is gone (see
    `READABLE_SAMPLE_COUNTS`: emitting it would be a correct header this system's own reader
    renders as sample 0), and with it gone `planarconfig` is `None` on every remaining arm.
    A parameter that is provably always `None`, threaded through two call sites and asserted by
    a test that cannot go red, is dead code wearing a contract; it was removed rather than kept
    "for later". `tifffile` infers CONTIG for all three live arms anyway. The knowledge is kept
    HERE, in prose, because it is what #288 needs and prose cannot rot into a false green.

    **Why `rgb`, and why exactly 3 and 4.**
    `photometricsamples = TIFF.PHOTOMETRIC_SAMPLES[photometric]` is 3 for RGB, and `tifffile`
    RAISES `not enough samples for PHOTOMETRIC.RGB` below that — so 3 is a hard floor. It does
    NOT impose a ceiling: `imwrite((300, 220, 5), photometric='rgb')` succeeds and writes
    `SamplesPerPixel=5` with two unspecified extras. What `tifffile` uses 4 for is narrower and
    is the reason the pair is `{3, 4}` here: with `planarconfig=None` it decides CONTIG vs
    SEPARATE by testing the trailing axis against `samples_set = {photometricsamples, 4}`, whose
    own comment reads *"allow common alpha"* — i.e. 4 is the one sample count beyond 3 that
    `tifffile` recognises as an RGB image by construction. Beyond that the ceiling is the
    READER's (`READABLE_SAMPLE_COUNTS`), not `tifffile`'s, and it is stated as such rather than
    attributed to the wrong layer.

    **Why `S == 1` is RESHAPED rather than given a planarconfig.** `tifffile` leaves no third
    option: `planarconfig="contig"` on `(H, W, 1)` raises
    `PLANARCONFIG.CONTIG does not match StoredShape(... contig_samples=1 ...)`, and leaving it
    unset is the defect. One sample per pixel IS a plain plane, so that is what is written. The
    reshape is a view and happens before anything downstream sees the array — `pyramid_levels`
    is the consumer that REQUIRES the ordering (a 3-D level under a 2-D level 0 would be two
    different images in one file); `extent_of` reads `shape[:2]` and `_reconcile_scale` reads
    the extent, so for those two the ordering is tidiness rather than a constraint, and saying
    which is which is the difference between a stated reason and a plausible one.

    **Why `S == 4` is `rgb` and not an uninterpreted stack — the one arm with two defensible
    answers.** An `(H, W, 4)` could be RGBA or four interleaved fluorescence channels, and
    NOTHING here can tell: `read_image` and `read_plane` both discard the source's
    `PhotometricInterpretation` and `ExtraSamples` (#289). So the tie is broken by the consumer
    this system actually ships. `libs/viz/src/viz-core/spatial/omeTiffPyramid.ts` implements
    Viv's `isInterleaved` rule — `const interleaved = samples === 3 || samples === 4` — and
    renders those through a BitmapLayer USING THE FILE'S `PhotometricInterpretation`. Declaring
    `MINISBLACK` with `SamplesPerPixel = 4` would hand our own reader an interleaved source
    whose photometric contradicts it. The residual is recorded rather than hidden: a genuine
    4-channel interleaved image would have its 4th channel composited as alpha; closing that is
    #289.

    The `unassalpha` is passed EXPLICITLY even though `tifffile`'s default for RGB-with-one-extra
    already writes it (`elif photometric == RGB and storedshape.extrasamples == 1:`, commented
    *"Unassociated alpha channel"*). Stated honestly: this is therefore an EQUIVALENT mutant —
    deleting the keyword emits identical bytes today and no test can go red on it. It is here to
    pin a semantic claim a reader COMPOSITES with at the one call site that decides it, against a
    future `tifffile` changing its default, not because it changes anything now.

    **Why a bilevel array with more than one sample is REFUSED.** `tifffile` sets `bilevel` from
    the dtype (`datadtype.char == '?'`) and then packs each tile with `packbits`, which is wrong
    once `contig_samples > 1`. Measured through this function with the guard temporarily lifted,
    on a fair-coin `default_rng(266)` bool array — the input is named because an earlier draft of
    this paragraph quoted three counts against ONE denominator, which cannot be right for three
    different sample counts, and a number nobody can reproduce is not a measurement:

        (300, 220, 3)    90,632 of   198,000 samples differ  (45.8%)
        (300, 220, 4)   123,821 of   264,000                 (46.9%)
        (1100, 900, 3) 1,361,386 of 2,970,000                (45.8%)
        (1100, 900, 4) 1,855,822 of 3,960,000                (46.9%)

    Only `S` in `{3, 4}` is listed because those are the only counts that can REACH this guard:
    everything else is already refused above by `READABLE_SAMPLE_COUNTS`. Every other dtype tried
    (uint8, uint16, int16, int32, float32, float64) round-trips exactly at every `S`.

    This refusal is NOT bookkeeping: `read_image`'s own docstring names BILEVEL (`bool`) as a
    dtype its TIFF branch returns, `read_plane` hands a `YXS` plane through with no dtype
    conversion, and `origin/main` preserved those pixels — under a wrong header, but losslessly
    — for `S` in `{1, 2, 4, 5}`. So classifying them correctly WITHOUT this guard would trade a
    mis-declared lossless file for a correctly-declared lossy one, and a correct header over
    destroyed pixels is a worse artifact than the one #266 filed. (`S == 3` bool was ALREADY
    corrupt on `origin/main`, at every size tried from 1x1 to 2048x1024; this closes that too.)

    Whatever is returned is applied to LEVEL 0 AND EVERY PYRAMID LEVEL, for the reason #227
    gives for `tile=`: a file that describes itself one way at level 0 and another below it makes
    a consumer branch per level to read one image.
    """
    if arr.ndim not in (2, 3):
        # The same refusal `read_image` makes for an axis order it does not know, made here
        # because `write_ome_tiff` is reachable without going through `read_image` and this
        # helper's promise is that NO shape falls through.
        #
        # MEASURED on `origin/main` rather than asserted, and the first draft of this comment
        # got it wrong in a way worth leaving a scar for: it claimed a 4-D array "came back
        # `rgb`" and "dies as a bare ValueError". Neither is true. The pre-fix expression is
        # `arr.ndim == 3 and arr.shape[2] == 3`, so a 4-D array fails the FIRST conjunct and
        # was classified `minisblack` — and `tifffile` then wrote a complete, silently
        # mis-headed file: `(60, 44, 1, 3)` emitted `axes=ZCYX`, `SizeX=3 SizeY=1 SizeC=44
        # SizeZ=60`, and `(2, 3, 4, 5, 6)` emitted `TZCYX`. That is the SAME defect #266 is
        # about, one dimension further out, and it is a stronger reason for this guard than the
        # one first written down. `ndim < 2` is the other half and does die uncaught: a bare
        # `IndexError` from `arr.shape[2]`, which is not in either importer's `emit_images`
        # guard and so costs the whole import rather than one image.
        raise ImageConversionError(
            f"this image array is {arr.ndim}-dimensional ({arr.shape!r}); this writer emits a "
            "2-D plane, optionally with a trailing axis of interleaved samples. Any other "
            "shape would have to be guessed at, and a guessed axis silently transposes or "
            "channel-averages the image."
        )
    if arr.ndim == 2:
        return arr, "minisblack", None

    samples = int(arr.shape[2])
    if samples < 1:
        # Not hypothetical politeness: on `origin/main` this shape reaches `tifffile` and comes
        # back as `ValueError: truncate can only be used with imagej or shaped formats`, which
        # names nothing a user can act on AND is not in either importer's `emit_images` guard,
        # so it would abort the whole import over one image.
        raise ImageConversionError(
            f"this image array is {arr.shape!r} — its sample axis is empty, so there is no "
            "pixel to write. A raster with zero samples per pixel is not an image, and there "
            "is no photometric interpretation that describes one."
        )
    if samples == 1:
        return arr.reshape(arr.shape[:2]), "minisblack", None
    if samples not in READABLE_SAMPLE_COUNTS:
        raise ImageConversionError(
            f"this image has {samples} samples per pixel. This importer writes an image with 1 "
            "(greyscale), 3 (RGB) or 4 (RGBA) samples per pixel, and the viewer can only "
            f"display those, so a {samples}-sample image would be shown as its FIRST sample "
            "alone with nothing saying so. It is left out rather than shown wrong. If the "
            "samples are separate channels, export them as separate single-channel images and "
            "import those; if one of them is the image and the rest are masks, export that one. "
            "Widening this is tracked as #288."
        )
    if arr.dtype.char == "?":
        # `tifffile` keys `bilevel` on exactly this (`datadtype.char == '?'`) and then packs
        # each tile with `packbits`, which is wrong once there is more than one sample per
        # pixel. Measured: ~46% of samples decode back changed. Refused rather than emitted,
        # because a correct header over destroyed pixels is worse than no artifact at all.
        raise ImageConversionError(
            f"this image is BILEVEL (dtype {arr.dtype!r}) with {samples} samples per pixel, and "
            "the installed tifffile cannot write that losslessly — it packs each tile as if "
            "there were one sample, and roughly half the samples decode back changed. A "
            "bilevel plane with ONE sample is written normally; convert this one to uint8 if "
            "the extra samples are meant to be kept."
        )
    if samples == 3:
        return arr, "rgb", None
    return arr, "rgb", ("unassalpha",)


def write_ome_tiff(dest, arr, *, placement, codec=CODEC,
                   image_microns_per_pixel=None, min_side=PYRAMID_MIN_SIDE):
    """Write `arr` to `dest` as a pyramidal, lossless OME-TIFF carrying `placement`.

    `placement` is an `image_meta()` result; its placement subset is mirrored into the
    file's own OME-XML (see `spatial_declarations.encode_placement`) because that is the
    ONLY channel that reaches a sandboxed consumer for an `opaque` kind — the manifest
    entry's `meta` is a catalog column the sandbox never sees, and this artifact has no
    `zarr.json` to stamp a `structure` into (INV-8 forbids one).

    ## TWO different scales live in this file, and they are not the same number

    `image_microns_per_pixel` is the physical size of a pixel IN THIS IMAGE, and it is what
    goes into OME `PhysicalSizeX/Y` — those are OME's own semantics and a generic OME
    reader is entitled to them. The `cyto` payload's `microns_per_pixel` is a different
    quantity: the scale of the COORDINATE SPACE, which is the same for every artifact
    placed in it. On a Visium hires image the two differ by 5x and on the lowres image by
    16.7x.

    They are deliberately NOT unified, because each is right for its own reader, and the
    parameter is named `image_microns_per_pixel` rather than `microns_per_pixel` so a call
    site cannot pass one where the other belongs — the two used to share a name eleven
    lines apart in `emit_images`, which is the "one-line difference that is wrong for a
    year" shape this module's own docs warn about.

    A consumer converting IMAGE pixels to microns wants `PhysicalSize*`; a consumer
    converting SPACE coordinates to microns wants the payload, and should go through
    `require_micron_scale`. When the scale is unknown the OME fields are OMITTED ENTIRELY —
    never defaulted to 1.0, which would be indistinguishable from a measured scale.

    ## THIS FUNCTION CAN REFUSE, and the caller has to be ready for it (#266)

    Named here rather than left inside the private `_sample_layout`, because it is a change to
    what CALLERS must handle and a contract a caller cannot discover from the signature.

    Raises `ImageConversionError` — the taxonomy `read_image` and `downsample` already use, and
    the one both importers' image guards already catch, so a refusal costs ONE image and never
    the import — when the array is not something this system can emit correctly AND usefully:

      * `ndim` is not 2 or 3 (not a plane, with or without a sample axis);
      * the sample axis is empty (`S < 1`);
      * `S` is outside `READABLE_SAMPLE_COUNTS` — see that constant: such a file would have a
        CORRECT header and still be rendered as sample 0 by this system's own viewer;
      * the array is BILEVEL (`bool`) with more than one sample, which the installed `tifffile`
        cannot write losslessly;
      * the DTYPE is one OME-XML has no `PixelType` for (`int64`, `uint64`, `float16`,
        `float128`, `complex256`, and every non-numeric kind) — see `OME_EXPRESSIBLE_DTYPES`
        and #292.

    Raises `SD.SpatialDeclarationError` — as before — for a lossy/undeclared codec, an extent
    that disagrees with the pixels, or a scale that disagrees with the downsample factor.

    ## The dtype gap #266's INV-5 named is CLOSED, and it was bigger than reported (#292)

    This paragraph used to record an open hole: a dtype OME-XML cannot express escaped as
    `tifffile.OmeXmlError`, which subclasses `Exception` directly, sits in NEITHER importer's
    guard, and therefore cost the WHOLE import — the matrix, the coordinates, the columns and
    the report — over one unusual vendor image. Reproduced end to end through the real Xenium
    importer before it was fixed: a plain `int64` morphology TIFF made `run_import` die with
    `OmeXmlError: data type 'int64' not supported` and write zero artifacts.

    Measuring it to fix it found TWO MORE families the issue did not know about, and that is
    why the repair is a guard on the dtype rather than an `except` on that exception. The
    non-numeric kinds (`datetime64`, `str_`, `object`, a sized `void`, ...) die ONE FRAME
    EARLIER, inside `TiffWriter.write`'s `sampleformat` lookup, as a bare `KeyError`; the
    UNSIZED `void` dies earlier still, as a bare `ValueError`. Measured on `301cd345`:
    **64 escaping `(dtype, S)` pairs over 16 dtypes**, of which `OmeXmlError` accounts for
    only 20 — so catching it would have closed 20 and left 44, the same defect one dimension
    over. `OME_EXPRESSIBLE_DTYPES` carries the full table.

    What is deliberately NOT done here: the array is never CAST to a representable dtype (that
    silently changes what a consumer reads back and is not lossless in general), the check is
    not moved to `read_image`/`read_plane` (the constraint is OME's, and this function is
    reachable without either), and neither importer's `except` tuple is widened (that would
    spread `tifffile`'s exception taxonomy into every consumer of this function, forever).
    """
    try:
        # DEFERRED, AND INSIDE A CONVERTING `try` (#298 E2). These two sat outside every
        # handler, so a `numpy`/`tifffile` missing or broken in the analysis rootfs raised
        # `ImportError` — in neither importer's guard tuple — and cost the matrix, the
        # coordinates, the columns and the report rather than one image. The `ImportError`
        # rule lives entirely inside `image_failure_is_a_bug`; there is deliberately no
        # `except ImportError` here, and an earlier draft of this comment said there was.
        import numpy as np
        import tifffile
    except (ImageConversionError, SD.SpatialDeclarationError):
        raise
    except Exception as exc:
        # NOT `except ImportError` — that was this handler's first shape and it covered only
        # half of what its own comment claimed. A library that is MISSING raises `ImportError`;
        # one that is present but BROKEN raises whatever its module body raises, which is not
        # an `ImportError` and escaped entirely. The standard boundary shape covers both: the
        # broken half by the site rule (the module body's own file is the innermost frame), the
        # missing half by the `ImportError` carve-out above.
        if image_failure_is_a_bug(exc, __file__):
            raise
        raise ImageConversionError(
            f"the image could not be written because a library this writer needs is not "
            f"importable in this environment ({type(exc).__name__}: {exc}). Every other "
            "artifact in this import is unaffected."
        ) from exc

    name = str(codec).lower()
    if name in SD.LOSSY_CODECS:
        raise SD.SpatialDeclarationError(
            f"codec={codec!r} is lossy and is refused for a tissue image. Downsampling and "
            "lossy compression are not the same thing: downsampling produces fewer, larger "
            "pixels, each a real average of real measurements, while lossy compression "
            "keeps the pixel count and invents the values. Someone will eventually zoom a "
            "region and read intensity off it, and JPEG ringing around a high-contrast "
            f"edge looks exactly like biology. Use one of {list(SD.LOSSLESS_CODECS)}."
        )
    if name not in SD.LOSSLESS_CODECS:
        raise SD.SpatialDeclarationError(
            f"codec={codec!r} is not a declared lossless codec "
            f"{list(SD.LOSSLESS_CODECS)}; an unrecognised codec cannot be asserted to be "
            "lossless"
        )

    # THE CONTIGUOUS COPY ALLOCATES A WHOLE SECOND PLANE, and until #297 it did so outside
    # every handler. `read_image` and `downsample` both convert a `MemoryError` here on
    # purpose, and `downsample`'s docstring writes down why: "The reshape and the reduction
    # ALLOCATE, so a large plane can raise `MemoryError` here — and `MemoryError` is not in
    # `emit_images`' `except` tuple". Every word of that applied to WRITING the same plane,
    # more so, since this function goes on to hold the array, this copy AND the whole pyramid
    # at once — and the module's stated motivating input is the multi-GB Xenium morphology
    # image. The identical reasoning reached the opposite behaviour eleven hundred lines
    # apart in one file; it no longer does.
    #
    # WHAT THIS ARM ACTUALLY CONVERTS, stated rather than implied. `np.ascontiguousarray` is a
    # C function, so EVERY exception it raises is attributed to the line below — the site rule
    # cannot see inside it. In practice this arm therefore converts exactly the carve-out
    # types (`MemoryError`, which is the whole of #297's first leg), and a `ValueError` or
    # `TypeError` from a ragged or non-array argument PROPAGATES. That is the right answer for
    # those two: `arr` reaches here from `read_image` or `read_plane`, both of which return a
    # real `ndarray`, so a ragged one is a CALLER's bug and not a vendor's file.
    try:
        arr = np.ascontiguousarray(arr)
    except (ImageConversionError, SD.SpatialDeclarationError):
        # BOTH refusal taxonomies pass through, not just one. `ImageConversionError` was
        # special-cased here from the start; `SpatialDeclarationError` — the other member of
        # the tuple both importers guard — was not, so an SD refusal reaching a broad arm would
        # be retyped and lose the distinction between "the producer declared something
        # impossible" and "the image was bad". Not reachable from any of these blocks today
        # (none of them calls into `spatial_declarations`), and one cross-module call away.
        raise
    except Exception as exc:
        if image_failure_is_a_bug(exc, __file__):
            raise
        # EVERY VALUE IN THIS MESSAGE IS READ DEFENSIVELY. `arr` is whatever the caller
        # passed — this is the FIRST statement that touches it — so a bare `arr.shape` here
        # would raise `AttributeError` out of the handler and replace the refusal with an
        # abort, which is the #298 E4 defect one file over.
        raise ImageConversionError(
            f"this image's pixels could not be laid out for writing "
            f"({type(exc).__name__}: {exc}). The array is "
            f"{getattr(arr, 'shape', None)!r} of "
            f"{getattr(getattr(arr, 'dtype', None), 'name', None)!r}, needing "
            f"{getattr(arr, 'nbytes', None)!r} more bytes as a contiguous copy. A resource "
            "failure here costs THIS image and nothing else; every other artifact in this "
            "import is unaffected."
        ) from exc

    # WHAT THE TRAILING AXIS MEANS, decided ONCE and before anything else reads the array.
    #
    # Here rather than beside the `writer.write` calls because the `S == 1` arm RESHAPES: the
    # extent assert below, `_reconcile_scale`, `pyramid_levels` and `downsample` must all see the
    # same array this function is about to declare, not the one that was handed in. See #266.
    arr, photometric, extrasamples = _sample_layout(arr)

    # THE DTYPE OME-XML CAN EXPRESS, checked BEFORE A BYTE IS WRITTEN (#292).
    #
    # HERE, and not one line earlier or later, for two reasons. AFTER `_sample_layout`, so the
    # SHAPE refusals keep priority and their more specific messages: a `(60, 44, 7)` `int64`
    # array should be told about its seven samples, which is the thing it has to fix first.
    # BEFORE `pyramid_levels`, so a doomed emission does not build a pyramid it will discard.
    #
    # See `OME_EXPRESSIBLE_DTYPES` for the measurement this closes and for why it is a guard on
    # the dtype rather than an `except` on the library's exception: the same input escaped in
    # TWO families, from two different frames, as two unrelated types, and only one of them was
    # an `OmeXmlError`.
    if arr.dtype.name not in OME_EXPRESSIBLE_DTYPES:
        # NO DTYPE NAME APPEARS AS A LITERAL IN THIS MESSAGE. The earlier draft illustrated the
        # cast argument with "(int64 -> int32, float16 -> float32)", which made the test that
        # asserts "the refusal names the dtype" pass on the BOILERPLATE for three of the five
        # dtypes it covers — the message could stop interpolating `arr.dtype.name` entirely and
        # nine of fifteen legs stayed green. A message whose examples are the same strings the
        # test looks for cannot be checked by that test.
        raise ImageConversionError(
            f"this image's pixels are {arr.dtype.name!r}, and OME-XML has no PixelType that can "
            f"express it. An OME-TIFF can carry "
            f"{', '.join(sorted(OME_EXPRESSIBLE_DTYPES))} and nothing else, so this image is "
            "left out rather than written under a header that describes different pixels. It is "
            "NOT converted for you: a widening cast would keep the image and silently change "
            "the numbers a consumer reads back, and it is not even lossless in general — the "
            "widest integer, float and complex dtypes do not fit any narrower one OME can "
            "express. Re-export this image in one of the listed dtypes, choosing the cast "
            "yourself so the choice is recorded where you made it. Every other artifact in "
            "this import is unaffected."
        )

    # THE ONE PLACE BOTH FACTS ARE IN SCOPE, so the one place they can be reconciled.
    #
    # This function writes the pixels (from which tifffile derives OME `SizeX`/`SizeY`) AND
    # the `cyto` payload (from `placement`), and nothing else ever sees both. `image_meta`'s
    # re-validation structurally CANNOT catch a transposed extent — it re-runs
    # `coordinate_space`, which checks the extent's SHAPE and has no pixels to compare it
    # against. Without this assert a file can carry two contradictory extents and hand a
    # sandboxed consumer the wrong one, which is precisely the failure §7.3 rule 5 calls
    # "the single most likely bug".
    declared_extent = placement.get("extent") if isinstance(placement, dict) else None
    if declared_extent != extent_of(arr):
        raise SD.SpatialDeclarationError(
            f"the placement declares extent {declared_extent!r} but the pixel array is "
            f"{extent_of(arr)!r}. A numpy image is (rows, cols) = (height, width) and "
            "§6.6's extent is {width, height}; these disagreeing means the artifact would "
            "state one size in its OME header and another in its own declaration."
        )
    _reconcile_scale(placement, arr, image_microns_per_pixel)

    metadata = {"Description": SD.encode_placement(placement)}
    if image_microns_per_pixel is not None:
        scale = SD._number(image_microns_per_pixel, "image_microns_per_pixel")
        metadata.update({
            "PhysicalSizeX": scale, "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": scale, "PhysicalSizeYUnit": "µm",
        })

    levels = pyramid_levels(arr, min_side=min_side)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # BigTIFF once the plane approaches classic TIFF's 32-bit offset ceiling. The installed
    # `tifffile` has its own >4 GiB guard commented out, so the classic container does NOT
    # error on overflow — it writes corrupt offsets. The module's stated motivation is the
    # multi-GB Xenium morphology image, so the ceiling is real rather than theoretical, and
    # 2 GiB is the threshold because the pyramid levels add ~1/3 on top of the plane.
    big = (arr.nbytes + sum(l.nbytes for l in levels)) > BIGTIFF_THRESHOLD_BYTES

    # Written to a TEMP path and moved into place only on success. `TiffWriter` creates the
    # file up front, so an exception mid-write otherwise leaves a truncated `.ome.tif`
    # sitting where a reader would find it — and `emit_images` would carry on to the next
    # image, ending with a committed artifact beside an orphaned stub.
    staging = dest.with_name(dest.name + ".partial")
    try:
        # `except tifffile.OmeXmlError` — ONE NAMED TYPE, and deliberately not one character
        # broader — see `docs/design/ome-tiff-dtype-refusal.md` §3. It is a BACKSTOP, not the fix: `OME_EXPRESSIBLE_DTYPES` above
        # already refuses every dtype this library cannot express, and the exhaustive sweep in
        # `test_ome_dtype_refusal` proves nothing reaches here by that route today. What it
        # buys is that the guard above MIRRORS A TABLE INSIDE A PINNED THIRD-PARTY LIBRARY: a
        # `tifffile` upgrade that narrowed that table would silently re-open the gap #292 was
        # filed for, and `OmeXmlError` also carries that library's own non-dtype refusals
        # ("ImageDepth not supported", "empty arrays not supported", "N dimensions not
        # supported") for a shape this module admits and a future version does not.
        #
        # WHAT IT IS NOT is `except Exception`. That would satisfy the letter of "a bad image
        # costs one image, not the import" and destroy the reason the two taxonomies exist: a
        # genuine logic bug in this function would come back to the user as a skipped image
        # with the import reporting success. `read_image`'s own four-attempt history (above)
        # settles that argument — the answer to an untested branch is coverage, not a wider
        # filter — and `test_ome_dtype_refusal` parses this function with `ast` and fails if a
        # bare or `Exception`-shaped handler is ever introduced into it.
        with tifffile.TiffWriter(str(staging), ome=True, bigtiff=big) as writer:
            # `tile=TILE` on BOTH writes, and the two must not drift apart (#227): a file
            # tiled at level 0 and stripped below it reports a different layout per level,
            # so a consumer would have to branch per level to read one image.
            writer.write(arr, photometric=photometric, extrasamples=extrasamples,
                         compression=name, tile=TILE,
                         subifds=len(levels) or None, metadata=metadata)
            for level in levels:
                # `subfiletype=1` marks a REDUCED-resolution image, which is what makes
                # these pyramid levels of the same series rather than separate images.
                # The SAME classification as level 0 (#266 / #227): `photometric` and
                # `extrasamples` travel with `tile=` for the identical reason — a file that
                # describes itself one way at level 0 and another below it forces a consumer to
                # branch per level to read one image.
                writer.write(level, photometric=photometric, extrasamples=extrasamples,
                             compression=name, tile=TILE, subfiletype=1)
        os.replace(staging, dest)
    except tifffile.OmeXmlError as exc:
        # THE MESSAGE STATES WHAT HAPPENED AND DOES NOT DIAGNOSE WHY. An earlier draft said
        # this refusal "means the installed tifffile refuses something OME_EXPRESSIBLE_DTYPES
        # admits — the two have drifted", which is only one of the reasons it can fire.
        # `OmeXmlError` is raised from ~14 sites in `tifffile`, and most of them are about the
        # CALLER's arguments rather than the dtype: "dimension order not supported", "metadata
        # Size{ax} does not match", "metadata Pixels Type does not match array dtype", "more
        # than 8 dimensions". Several of those are reachable from a bug in the `metadata` dict
        # THIS function builds. Naming a cause the exception does not establish would send a
        # reader hunting a library drift that never happened, so the message reports the
        # library's own words and the array it was given, and stops there.
        raise ImageConversionError(
            f"this image's pixels are {arr.dtype.name!r} at {arr.shape!r} and could not be "
            f"described in OME-XML. The writer refused with {type(exc).__name__}: {exc}. An "
            f"OME-TIFF can carry {', '.join(sorted(OME_EXPRESSIBLE_DTYPES))}. This image is "
            "left out; every other artifact in this import is unaffected."
        ) from exc
    except (ImageConversionError, SD.SpatialDeclarationError):
        # A DELIBERATE REFUSAL from inside the block, re-raised AHEAD of the site rule for the
        # reason `read_image` states for its own: this type subclasses `RuntimeError`, so the
        # arm below would catch it and double-wrap a refusal into something that reads like
        # corruption. Not reachable from the statements in the block today; kept because the
        # arm below is what makes it load-bearing the moment one moves.
        raise
    except Exception as exc:
        # THE ENCODE, AND EVERY ALLOCATION IT MAKES (#297). `writer.write` compresses, which
        # allocates, and `tifffile` refuses some arrays with a bare `ValueError` or a
        # `struct.error` that the dtype and shape guards above do not pre-empt. None of those
        # is in either importer's guard tuple, so each cost the WHOLE import over one image.
        #
        # NOT `except Exception` on its own — that is the thing INV-4 forbids, and the `ast`
        # guard in `test_ome_dtype_refusal` enforces it. What makes this arm named is the
        # line below it: a failure raised by a line in THIS file is a bug in this file and
        # PROPAGATES, and only a failure raised inside the library we handed the array to is
        # converted. The named `OmeXmlError` arm above keeps its own more specific message
        # and its own test; this is the backstop underneath it.
        if image_failure_is_a_bug(exc, __file__):
            raise
        raise ImageConversionError(
            f"this image's pixels are {arr.dtype.name!r} at {arr.shape!r} and could not be "
            f"encoded ({type(exc).__name__}: {exc}). The exception TYPE is named here on "
            "purpose: a resource failure and a data failure need different answers from an "
            "operator, and only the type distinguishes them. This image is left out; every "
            "other artifact in this import is unaffected."
        ) from exc
    finally:
        # `os.replace` is atomic, so reaching here with the staging file still present
        # means the write raised. Leave nothing behind either way.
        #
        # THE CLEANUP MUST NOT REPLACE THE REFUSAL IT IS CLEANING UP AFTER. An unguarded
        # `unlink()` in a `finally` raises INTO the in-flight exception, so a read-only output
        # directory turned a precise "this image's pixels are 'int64' and OME-XML has no
        # PixelType for it" into a bare `PermissionError` — with the refusal demoted to
        # `__context__` — AND left the stub behind anyway. Measured. The refusal is the thing
        # the operator can act on, so it wins; an orphaned `.partial` is not an artifact any
        # reader would mistake for one, and the `os.replace` above is what guarantees no
        # half-written file ever appears at `dest`.
        try:
            staging.unlink(missing_ok=True)
        except OSError:
            pass
    return dest


def tifffile_version():
    """The writer version stamped into the display-derivative provenance.

    Called from inside both importers' guarded per-image bodies, so an `ImportError` here
    cost the whole import rather than one image until #298 E2.
    """
    try:
        import tifffile

        return str(tifffile.__version__)
    except (ImageConversionError, SD.SpatialDeclarationError):
        raise
    except Exception as exc:
        if image_failure_is_a_bug(exc, __file__):
            raise
        raise ImageConversionError(
            f"the writer version could not be read because `tifffile` is not importable in "
            f"this environment ({type(exc).__name__}: {exc}). Every other artifact in this "
            "import is unaffected."
        ) from exc
