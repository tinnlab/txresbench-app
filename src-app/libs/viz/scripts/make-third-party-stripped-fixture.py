#!/usr/bin/env python3
"""Write `third-party-stripped.ome.tif` — the corpus's THIRD-PARTY stripped OME-TIFF (#322).

## What gap this closes

`docs/design/ome-tiff-tile-layout.md` §5 keeps a stripped file in the reader's corpus on a stated
rationale: *"a reader that only handles the layout its own writer emits is a reader that breaks on
the first third-party OME-TIFF."* #259 upheld the reader half with
`spatial-image-hires-stripped.ome.tif` — but that file is THIS SYSTEM's own pre-#227 emit, kept
verbatim, and every OTHER stripped fixture in the directory (`malformed-non-halving`,
`mixed-codec-levels`, `multi-plane-channels`, `planar-rgb`) is a shape the reader REFUSES at open.
So before this file, no successful read went through a stripped OME-TIFF laid out by a writer this
project does not control, which is what the rationale is actually about.

§5 also fixes what "third-party" has to mean: *"The invariant is about a writer we do not control,
not about someone else's copyrighted pixels."* So this script takes OUR OWN committed raster and
puts a DIFFERENT WRITER between it and the disk.

## THE PROVENANCE, STATED EXACTLY — read this before trusting the fixture

An overclaim here would defeat the whole point of the file, so the split is spelled out rather
than implied:

  * **Pillow produced** the TIFF itself: the header, the IFD, every tag with its type/count/value
    layout, the strip geometry (`RowsPerStrip`, `StripOffsets`, `StripByteCounts`) and the
    DEFLATE-compressed strip payloads. Nothing in this repo's producer path imports Pillow, and
    `ome_writer.py` has never emitted any of these bytes.

    Precisely which foreign code laid them down, because "Pillow" is one word for two paths and
    the difference is checkable in the artifact: `PIL/TiffImagePlugin.py`'s `_save` sets
    `libtiff = WRITE_LIBTIFF or compression != "raw"`, so a COMPRESSED write — this one — is
    handed to the **libtiff Pillow bundles** (4.7.1 here, `pillow.libs/libtiff-*.so`) rather than
    to Pillow's own pure-Python IFD writer. The bytes show it: `StripOffsets[0] = 8` with the IFD
    at the END of the file, which is libtiff's data-first layout and not the pure-Python path's.
    That makes the fixture MORE foreign rather than less — `docs/design/ome-tiff-tile-layout.md`
    §5 named `libtiff` itself as one of the acceptable writers — but a paragraph whose whole job
    is that "an overclaim here would defeat the point" must name the right codebase.
  * **This repo produced** two inputs Pillow was handed: the PIXELS — the level-0 raster of the
    committed `spatial-image-lowres.ome.tif`, i.e. our own emitted artifact's raster, read back
    out of it — and the TEXT of the OME-XML string below. Pillow will not author OME-XML, so the
    `<OME>` document is HAND-WRITTEN for this fixture (see `_ome_xml`). It is not `ome_writer`'s
    output and does not resemble it: no `urn:uuid`, no `Creator="tifffile…"`, no `cyto-spatial/1`
    placement payload.
  * **Nothing in this file was produced by `ome_writer.write_ome_tiff`.**

And the honest limit of what a passing test on it proves: `loadOmeTiffPyramid` never parses
OME-XML at all (`omeTiffPyramid.ts` says so in its header, and `physicalSizeOf` takes a
caller-supplied fallback), so this fixture exercises the reader against a foreign TIFF TAG LAYOUT
and a foreign STRIP GEOMETRY. It does not — and cannot — prove anything about parsing a vendor's
OME-XML, because there is no OME-XML parsing to exercise.

## Why Pillow and not something else

`tiffcp`, `tiffinfo`, `bfconvert`, ImageMagick's `convert` and `vips` are not installed and no
system package can be added here. `tifffile` IS installed — and is exactly what
`src-app/packages/spatial-types/compute/ome_writer.py` writes through, so using it would produce
our own writer's output at a different call site, which is the one thing this fixture may not be.
`imageio`'s TIFF plugins delegate to `tifffile` or to Pillow, so they add an import and no
independence. That leaves Pillow, which is a real, widely-deployed, independent TIFF writer.

Measured on its output — both sides measured, because an earlier draft of this paragraph guessed
and got it wrong. The tag CODES this file carries are

    256 257 258 259 262 270 273 277 278 279 284

and `spatial-image-hires.ome.tif`, our own emit, carries

    256 257 258 259 262 270 277 282 283 284 296 305 322 323 324 325 330

so the discriminating difference is: this file has the STRIP tags (273/278/279) and our writer has
the TILE tags (322-325) plus `SubIFDs` (330), `XResolution`/`YResolution` (282/283),
`ResolutionUnit` (296) and `Software` (305). Four tags our writer always stamps and this one has
none of, on a file the reader must nonetheless read.

`SampleFormat` (339) is deliberately NOT in that argument, and this note exists because it was:
neither writer emits it, so its absence discriminates nothing. The reader is explicit that an
absent one is fine (`assertUniformSampleFormat`: "`SampleFormat` genuinely does default (to 1,
unsigned integer), so an absent one stays exempt"). `EXPECTED_TAGS` below still pins it absent, as
part of pinning the WHOLE tag set — that is a shape assertion, not a provenance one.

## The geometry, and why these numbers

`RowsPerStrip = 40` over a 540-row image is 14 strips whose LAST ONE IS SHORT (20 rows), so the
partial-final-strip case is exercised rather than assumed. 40 is deliberately none of the numbers
already in this corpus — not our writer's `TILE = 512`, not the pre-#227 emit's `RowsPerStrip =
62`, not `tiled-deflate.ome.tif`'s 256 — so nothing can pass by coincidence with an existing
fixture. A 512-edge tile request spans 13 of those strips, which is the multi-strip band read the
reader has to get right on a geometry it did not choose.

DEFLATE (`compression='tiff_deflate'`) emits TIFF `Compression = 8`, "Adobe Deflate" — in the
reader's `DECODABLE_COMPRESSION` allowlist, but a DIFFERENT tag value from the `32946` our writer
emits, so this is also the first committed file that exercises that arm. Uncompressed would have
been ~680 KB against 15 KB.

## Reproducibility

Deterministic: two runs in one environment are byte-identical (there is no `urn:uuid` stamp to
blank, unlike `make-emitted-image-fixtures.py`). It is NOT version-independent — the bundled
libtiff's and zlib's DEFLATE output are theirs to change — so the three versions this file was
written under are recorded below, and `--check` prints both the recorded and the running ones when
the bytes disagree, so a toolchain drift reads as a toolchain drift instead of as corruption. That is deliberately a HARD FAILURE and not a skip, on the same rule
`make-emitted-image-fixtures.py --check` already runs under: a gate that quietly no-ops is
indistinguishable from one that passes.

    python3 src-app/libs/viz/scripts/make-third-party-stripped-fixture.py           # rewrite in place
    python3 src-app/libs/viz/scripts/make-third-party-stripped-fixture.py --check   # reproducible AND not stale

`pixel-oracle.json` is NOT written here. Its entries for this fixture are derived by `tifffile` in
`make-emitted-image-fixtures.py --oracle`, so the oracle stays a single, purely `tifffile`-derived
artifact and no Pillow version leaks into it.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np
import PIL
import tifffile
from PIL import Image, features

HERE = Path(__file__).resolve()
REPO = HERE.parents[4]
FIXTURES = HERE.parents[1] / "src" / "viz-core" / "spatial" / "fixtures"

#: The artifact whose LEVEL-0 RASTER this fixture carries — our own emitted image, so the pixels
#: raise no provenance question and the pair is a controlled experiment: the same image through
#: two unrelated writers must decode to the same bytes.
SOURCE = FIXTURES / "spatial-image-lowres.ome.tif"
TARGET = FIXTURES / "third-party-stripped.ome.tif"

#: See the module docstring: 14 strips over 540 rows, the last one short, and a value no other
#: fixture in this corpus uses.
ROWS_PER_STRIP = 40
#: TIFF `Compression = 8`, Adobe Deflate — the allowlist arm our own writer does not emit.
COMPRESSION = "tiff_deflate"
#: TIFF tag numbers, spelled here rather than imported, because the whole point is that this
#: script hands Pillow tag VALUES and Pillow decides the tag LAYOUT.
TAG_IMAGE_DESCRIPTION = 270
TAG_ROWS_PER_STRIP = 278

#: The writer versions the committed bytes were produced under. `--check` reports both these and
#: the running ones when the bytes disagree.
RECORDED_PILLOW = "12.2.0"
RECORDED_ZLIB = "1.2.11"
#: The library that ACTUALLY lays the bytes down for a compressed write (see the docstring), and
#: therefore the one a byte difference is most likely to be about. Recorded separately because
#: `zlib.ZLIB_VERSION` is CPython's compile-time zlib and need not be the one libtiff links —
#: they coincide here, and a `--check` failure that printed only those two could send a reader
#: looking for a moved raster when the cause was a libtiff bump.
RECORDED_LIBTIFF = "4.7.1"

#: EXACTLY the tags Pillow emits for this call — asserted as a SET EQUALITY, not a subset. A
#: subset check would stay green if a future Pillow started stamping `Software` or `SampleFormat`,
#: which is precisely the drift that would make this fixture stop being the shape it is committed
#: for. Sorted TIFF tag codes:
#:   256 ImageWidth · 257 ImageLength · 258 BitsPerSample · 259 Compression
#:   262 PhotometricInterpretation · 270 ImageDescription · 273 StripOffsets
#:   277 SamplesPerPixel · 278 RowsPerStrip · 279 StripByteCounts · 284 PlanarConfiguration
EXPECTED_TAGS = (256, 257, 258, 259, 262, 270, 273, 277, 278, 279, 284)


def _ome_xml(width: int, height: int, samples: int) -> str:
    """The HAND-AUTHORED OME-XML this script hands Pillow as tag 270.

    Pillow will not author OME-XML, and the corpus is a corpus of OME-TIFFs, so the alternative
    was a file named `.ome.tif` that is not one. The document is minimal and says only what is
    true of the bytes Pillow is about to write; every value in it is DERIVED from the raster
    rather than typed, so it cannot drift from the pixels.

    `Creator` names the real provenance — both halves of it — so the artifact carries its own
    story even when separated from this script and from `fixtures/README.md`.
    """
    creator = (
        f"Pillow {PIL.__version__} / libtiff {_libtiff_version()} (TIFF bytes) "
        f"+ hand-authored OME-XML (make-third-party-stripped-fixture.py, #322) "
        f"— NOT written by cytoanalyst's ome_writer.py"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"'
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xsi:schemaLocation="http://www.openmicroscopy.org/Schemas/OME/2016-06'
        ' http://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd"'
        f' Creator="{creator}">'
        '<Image ID="Image:0" Name="third-party-stripped">'
        f'<Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint8" Interleaved="true"'
        f' SignificantBits="8" SizeX="{width}" SizeY="{height}" SizeC="{samples}"'
        ' SizeZ="1" SizeT="1">'
        f'<Channel ID="Channel:0:0" SamplesPerPixel="{samples}"/>'
        '<TiffData IFD="0" PlaneCount="1"/>'
        "</Pixels></Image></OME>"
    )


def _source_raster() -> np.ndarray:
    """The level-0 raster of the committed `spatial-image-lowres.ome.tif`.

    Read with `tifffile`, which is a DECODER here, not the writer: the fixture's independence is
    about which library lays the bytes down, and nothing about this file is laid down by
    `tifffile`.
    """
    if not SOURCE.exists():
        raise SystemExit(f"missing source artifact {SOURCE} — this fixture carries its raster")
    with tifffile.TiffFile(SOURCE) as tf:
        raster = tf.pages[0].asarray()
    if raster.ndim != 3 or raster.shape[2] != 3 or raster.dtype != np.uint8:
        raise SystemExit(
            f"{SOURCE.name} level 0 is {raster.shape} {raster.dtype}; this fixture is committed as "
            "an INTERLEAVED RGB uint8 image (SamplesPerPixel=3), which is the shape the reader "
            "routes through Viv's interleaved path. Re-read fixtures/README.md before changing it."
        )
    return raster


def _emit(path: Path, raster: np.ndarray) -> None:
    """Write the fixture with PILLOW, then ASSERT every header that came back.

    Nothing here trusts the keywords it passed: the file is re-opened and its directory read, the
    same discipline `make-sample-count-fixtures.py` states. It REFUSES to leave a file behind that
    is not the shape this corpus is committing.
    """
    height, width, samples = raster.shape
    # WRITE ASIDE, THEN RENAME. `path` is normally the COMMITTED fixture, so emitting straight
    # to it means the refusal branch below has already destroyed the artifact before it prints
    # "REFUSING to write" — and an exception raised anywhere in the write-then-verify window (a
    # failure inside `save`, an undecodable emit, a scalar `StripByteCounts`, a `TiffFile` that
    # will not open) escapes with no cleanup at all and leaves a partial file in the corpus.
    # `os.replace` on the same filesystem is atomic, so either every guard passed and the new
    # bytes are there, or the committed bytes are untouched — and the whole window is wrapped,
    # so no staging file survives either.
    staging = path.with_name(path.name + ".partial")
    try:
        Image.fromarray(raster).save(
            staging,
            format="TIFF",
            compression=COMPRESSION,
            tiffinfo={
                TAG_ROWS_PER_STRIP: ROWS_PER_STRIP,
                TAG_IMAGE_DESCRIPTION: _ome_xml(width, height, samples),
            },
        )
    except BaseException:
        # The save itself is inside the window too. An earlier cut wrapped only the verification,
        # so a raise DURING the write left a `.partial` in the fixtures directory — harmless (the
        # suffix is invisible to every scan and to the corpus count) but untracked and untidy, and
        # the comment above claimed a narrower exposure than the code had. `BaseException` rather
        # than `Exception` so a Ctrl-C mid-write cleans up too.
        staging.unlink(missing_ok=True)
        raise
    problems: list[str] = []
    try:
        _assert_emitted(staging, raster, problems)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise
    if problems:
        staging.unlink(missing_ok=True)
        raise SystemExit(
            "REFUSING to write " + str(path.name) + " (the committed file is untouched):\n  - "
            + "\n  - ".join(problems)
        )
    os.replace(staging, path)


def _assert_emitted(path: Path, raster: np.ndarray, problems: list[str]) -> None:
    """Every header this fixture is committed for, re-read off the bytes that were just written.

    Nothing here trusts the keywords `_emit` passed. Split out of `_emit` so the write, the
    verification and the atomic rename are three separable steps, and a raise anywhere in the
    middle cannot leave a half-written file where the corpus expects the committed one.
    """
    height, width, samples = raster.shape
    with tifffile.TiffFile(path) as tf:
        if len(tf.pages) != 1:
            problems.append(
                f"{len(tf.pages)} top-level IFDs; the reader refuses >1 by name "
                "(MultiPlaneImageUnsupportedError), so this fixture must be single-page"
            )
        page = tf.pages[0]
        tags = {tag.code: tag.value for tag in page.tags}
        if tuple(sorted(tags)) != EXPECTED_TAGS:
            problems.append(
                f"tag set is {tuple(sorted(tags))}, expected {EXPECTED_TAGS} — the writer's tag "
                "layout moved, and that layout is the property this fixture is committed for"
            )
        if page.is_tiled or 322 in tags or 323 in tags:
            problems.append("the file is TILED; a third-party STRIPPED fixture is the whole point")
        if tags.get(TAG_ROWS_PER_STRIP) != ROWS_PER_STRIP:
            problems.append(f"RowsPerStrip is {tags.get(TAG_ROWS_PER_STRIP)}, expected {ROWS_PER_STRIP}")
        expected_strips = -(-height // ROWS_PER_STRIP)
        actual_strips = len(tags.get(279, ()))
        if actual_strips != expected_strips:
            problems.append(f"{actual_strips} strips, expected {expected_strips}")
        if expected_strips * ROWS_PER_STRIP == height:
            problems.append(
                f"RowsPerStrip {ROWS_PER_STRIP} divides the image height {height} exactly, so the "
                "PARTIAL FINAL STRIP this fixture exists to exercise is absent"
            )
        if int(tags.get(259, 0)) != 8:
            problems.append(f"Compression is {tags.get(259)}, expected 8 (Adobe Deflate)")
        if int(tags.get(277, 0)) != samples or int(tags.get(284, 0)) != 1:
            problems.append(
                f"SamplesPerPixel/PlanarConfiguration are {tags.get(277)}/{tags.get(284)}, "
                f"expected {samples}/1 (interleaved)"
            )
        if int(tags.get(262, -1)) != 2:
            problems.append(f"PhotometricInterpretation is {tags.get(262)}, expected 2 (RGB)")
        if 305 in tags:
            # Dominated by the tag-set equality above and kept anyway, labelled as such: when a
            # future writer starts stamping `Software` the set check fails with a tuple diff, and
            # this line is what says WHY that particular tag matters. It is a message, not an
            # independent guard, and calling it one would be the overclaim this file is written
            # against.
            problems.append(
                "a Software (305) tag is present — our own writer stamps that tag on every file "
                "it emits, and its absence here is part of what makes this one foreign"
            )
        description = tags.get(TAG_IMAGE_DESCRIPTION, "")
        if "<OME" not in description or "tifffile" in description:
            problems.append(
                "ImageDescription is not the hand-authored OME-XML this script writes "
                "(or carries a tifffile stamp, which would mean our own writer produced it)"
            )
        if not np.array_equal(page.asarray(), raster):
            problems.append("the raster did not survive the round trip bit for bit")
        # ── THE LIBTIFF LAYOUT SIGNATURE, CHECKED RATHER THAN ONLY CLAIMED ─────────────────
        # The provenance note says a COMPRESSED write goes through Pillow's bundled libtiff
        # rather than its pure-Python IFD writer, and cites the artifact's DATA-FIRST layout as
        # the evidence. Nothing checked it, and the tag SET cannot: measured, the pure-Python
        # path (`compression="raw"`) emits the SAME eleven tags. What separates them is where
        # the bytes sit — libtiff writes pixel data from offset 8 and puts the IFD after it,
        # while the pure-Python path writes the IFD at 8 and the data after. So the claim is
        # pinned here, in the one place that can see both. Verified by running it: forcing
        # `compression="raw"` refuses with THREE messages — both of these, plus the compression
        # guard, because `raw` is the only way to reach the pure-Python path and it necessarily
        # flips tag 259 too. (An earlier cut of this sentence said "exactly these two", which is
        # the comment-wider-than-its-assertion defect this file is written against, one paragraph
        # below a note saying so.)
        strip_offsets = tags.get(273, ())
        strip_counts = tags.get(279, ())
        if not strip_offsets or int(strip_offsets[0]) != 8:
            problems.append(
                f"StripOffsets[0] is {strip_offsets[0] if strip_offsets else 'absent'}, expected 8 "
                "— the pixel data does not start immediately after the TIFF header, so this was "
                "NOT written by the bundled-libtiff path the provenance note names"
            )
        data_end = int(strip_offsets[-1]) + int(strip_counts[-1]) if strip_offsets else 0
        if page.offset < data_end:
            problems.append(
                f"the IFD is at {page.offset}, before the pixel data ends at {data_end} — that is "
                "Pillow's pure-Python IFD layout, not the data-first layout the bundled libtiff "
                "produces and that fixtures/README.md cites as the evidence for who wrote this"
            )


def _libtiff_version() -> str:
    """ONE spelling of "which libtiff", used by both the artifact's `Creator` and `--check`.

    `PIL.features.version` returns `None` (it does not raise) when the feature is absent or
    unknown, and an earlier cut spelled that `None` in the OME-XML and `"absent"` in the
    `--check` message — two words for one condition, on precisely the diagnostic path
    `RECORDED_LIBTIFF` exists to disambiguate.
    """
    return features.version("libtiff") or "absent"


def _versions() -> str:
    return f"Pillow {PIL.__version__} / libtiff {_libtiff_version()} / zlib {zlib.ZLIB_VERSION}"


def check() -> int:
    """Fresh-vs-fresh (reproducible) AND fresh-vs-COMMITTED (not stale). Exit non-zero on either.

    The second comparison is the one that matters, for the reason
    `make-emitted-image-fixtures.py --check` records: comparing two temp files alone proves the
    script is deterministic and says NOTHING about whether the committed bytes are still what it
    produces.
    """
    if not TARGET.exists():
        print(f"{TARGET.name} is not committed; run this script without --check.", file=sys.stderr)
        return 1
    raster = _source_raster()
    with tempfile.TemporaryDirectory() as tmp:
        first = Path(tmp) / TARGET.name
        second = Path(tmp) / ("second-" + TARGET.name)
        _emit(first, raster)
        _emit(second, raster)
        if first.read_bytes() != second.read_bytes():
            print(
                "two emits in the SAME environment differ — this generator is not deterministic, "
                f"which no version difference explains ({_versions()}).",
                file=sys.stderr,
            )
            return 1
        if first.read_bytes() != TARGET.read_bytes():
            print(
                f"{TARGET.name} is STALE against a fresh emit.\n"
                f"  committed under: Pillow {RECORDED_PILLOW} / libtiff {RECORDED_LIBTIFF} "
                f"/ zlib {RECORDED_ZLIB}\n"
                f"  running now:     {_versions()}\n"
                "If the versions differ, that difference is the likely cause and this is not "
                "corruption: re-run this script WITHOUT --check to re-emit, update "
                "RECORDED_PILLOW/RECORDED_LIBTIFF/RECORDED_ZLIB and the provenance block in "
                "fixtures/README.md, "
                "and re-run `make-emitted-image-fixtures.py --oracle` so the digests follow. If "
                "the versions are the SAME, the source raster or this script moved — read "
                "fixtures/README.md before regenerating.",
                file=sys.stderr,
            )
            return 1
    print(f"{TARGET.name}: reproducible and not stale ({_versions()}).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__ and __doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="prove the generator is deterministic AND that the committed fixture is not stale",
    )
    args = parser.parse_args()
    if args.check:
        return check()
    raster = _source_raster()
    _emit(TARGET, raster)
    print(
        f"wrote {TARGET.relative_to(REPO)} "
        f"({TARGET.stat().st_size} B, {_versions()}) — "
        "now re-run make-emitted-image-fixtures.py --oracle to re-derive its digests."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
