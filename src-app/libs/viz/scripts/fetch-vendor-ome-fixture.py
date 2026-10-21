#!/usr/bin/env python3
"""Verify (and, with `--fetch`, re-obtain) `bioformats-tubhiswt.ome.tif` — the corpus's OME-TIFF
whose OME-XML document this project did not author (#346).

## What gap this closes, and what it does NOT

#322 committed `third-party-stripped.ome.tif`: OUR OWN raster, laid out by a writer we do not
control (the libtiff Pillow bundles). That closed one half of
`docs/design/ome-tiff-tile-layout.md` §5's rationale — the reader is provably not confined to its
own writer's TAG LAYOUT or STRIP GEOMETRY — and #322 said, in three places, exactly what it left
open: the `<OME>` document in that file is HAND-AUTHORED by our own generator, because Pillow will
not write OME-XML. So nothing in the corpus carried an OME-XML document composed by software
outside this project.

This file does. Its `<OME>` block was written by **OME Bio-Formats 5.2.0-m4** over a real
instrument acquisition, and it carries the elements a round trip of ours has no call site for:
`<Instrument>` / `<Microscope Manufacturer="Nikon" Model="Eclipse TE300">`, `<Detector>`,
`<Objective>`, `<Experimenter>`, `<Plane TheC=… TheZ=… TheT=…>`, `DimensionOrder="XYZTC"`, and
`<TiffData>` elements whose `<UUID FileName=…>` children point at TWO FILES — one of which is not
this one.

**And the honest limit, stated first because it is the thing most easily over-read.**
`loadOmeTiffPyramid` does not parse OME-XML at all. So committing this file does not make any
OME-XML PARSER pass a test — there is no parser. What it does is three separate, checkable things:

  1. it puts a foreign-authored `<OME>` document in the corpus, so the directory's provenance
     claim finally covers one, and a future XML path has real vendor text to be written against;
  2. it is a TIFF CONTAINER shape no writer of ours emits — `Compression = 1` (uncompressed, an
     arm of `DECODABLE_COMPRESSION` that until now no committed byte reached), `RowsPerStrip = 1`
     (512 single-row strips, so one 512-row viewport tile resolves to 512 ranged reads), a
     `SampleFormat` tag (which NO other file in this corpus carries), and
     `Software = "OME Bio-Formats 5.2.0-m4"` — a third writer family beside `tifffile` and Pillow;
  3. it MEASURES one of #322's own provenance predicates as unsound. `#322 TEST-2` scanned for
     `urn:uuid:` as a "written through tifffile" stamp. Bio-Formats emits `urn:uuid:` too — it is
     the OME-TIFF specification's own convention, not a library's signature — so that predicate
     never probed the writer. `#322 TEST-2` now says so and gives each predicate its own expected
     set instead of an AND across three "corroborating" ones.

**It is NOT an instrument-vendor's own writer.** Bio-Formats is the OME reference implementation,
not Nikon's or Bio-Rad's software; the PIXELS and the instrument metadata are a real acquisition's,
the CONTAINER is Bio-Formats'. #346 lists "a Bio-Formats export" as one of the shapes it wants, and
this is that. A file written by an instrument's own OME-TIFF writer (a 10x Xenium
morphology TIFF, say) is a further step and is recorded as such in `fixtures/README.md`.

## PROVENANCE — every byte is upstream's

**Nothing in this repository produced any byte of this file.** It is not generated, not converted,
not trimmed and not re-encoded: it is the upstream artifact, saved verbatim. That is deliberate and
is the whole reason it can carry the claim above — the moment our tools rewrite it to make it
smaller, the OME-XML becomes ours again and the file stops being what it is committed for. Its
269,568 bytes are the price of that, and the corpus already carries a 167,778-byte fixture.

  source     https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/tubhiswt-2D/tubhiswt_C0.ome.tif
  licence    Creative Commons Attribution 4.0 International (CC BY 4.0)
             https://creativecommons.org/licenses/by/4.0/
             stated at .../tubhiswt-2D/readme.txt, full text at .../tubhiswt-2D/COPYING
  credit     "Sample OME-TIFF files (c) by the OME Consortium", CC BY 4.0
  retrieved  2026-09-09 (fetched twice, byte-identical)
  sha256     a1d99f0651baad26a6b5004c115a9c3f4e33d3d6e0b279b34cabbbe88d813ef2
  bytes      269568

CC BY 4.0 permits redistribution, including commercially, with attribution — which is why this
directory can hold the file at all, and why `fixtures/README.md` carries the credit line above.
Sibling sets under the same tree are NOT all equally licensed: `BBBC017/` is CC BY-NC-SA 3.0
(non-commercial), and was rejected for that reason. Check the `readme.txt` beside any file before
adding another one from there.

## Why THIS file out of that tree

The reader accepts a narrow shape, and most real OME-TIFFs miss it: a multichannel acquisition
stores its channels as separate top-level IFDs, which `loadOmeTiffPyramid` refuses by name
(`MultiPlaneImageUnsupportedError`). `tubhiswt_C0.ome.tif` is one plane of a MULTI-FILE OME-TIFF
set — the `<OME>` document declares `SizeC="2"` and names both files, while this file holds exactly
one IFD — so the reader opens it and reports ONE channel, from the container, not the document.
That divergence is itself a shape no round trip of ours produces, and `#346 TEST-2` pins it.

The pyramidal sets in the same tree (`sub-resolutions/Brightfield/Leica-1.ome.tiff` and friends,
real Leica/Vectra scans with real `SubIFDs`) are 225 MB to 2.6 GB and there is no way to shrink one
without our own tools rewriting it. That trade is recorded in `fixtures/README.md` rather than
taken silently.

## Why there is no generator, and what stands in for one

This directory's rule is that a committed binary whose recipe is not in the tree is a liability
(#259 found exactly one of those). For a DOWNLOADED artifact the recipe is a URL and the check is a
checksum, so that is what this script is:

    python3 src-app/libs/viz/scripts/fetch-vendor-ome-fixture.py --check   # offline: identity + headers
    python3 src-app/libs/viz/scripts/fetch-vendor-ome-fixture.py --fetch   # network: re-download and diff

`--check` is offline and is what `#346 TEST-3` runs from the suite: it re-derives the committed
file's sha256 and byte length against the values recorded above, and re-asserts every header the
fixture is committed FOR — the tag set, `Compression`, `RowsPerStrip`, the strip count, the
`SampleFormat` tag, `SamplesPerPixel`, the `Software` stamp, and the OME-XML elements. So an
accidental re-encode, a trim, or a swap fails here and NAMES what moved, instead of failing as an
opaque digest mismatch three files away.

`--fetch` needs the network and is therefore NOT run by the suite; it re-downloads from the URL
above into a temporary directory and compares byte for byte. If upstream ever replaces the file,
that is what says so.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
import urllib.request
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / "src" / "viz-core" / "spatial" / "fixtures"
FIXTURE = FIXTURES / "bioformats-tubhiswt.ome.tif"

#: Where the committed bytes came from, verbatim.
SOURCE_URL = (
    "https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/"
    "tubhiswt-2D/tubhiswt_C0.ome.tif"
)
LICENCE = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)"
CREDIT = "Sample OME-TIFF files (c) by the OME Consortium"
RETRIEVED = "2026-09-09"

#: The identity anchor. A header assertion over a file that was swapped underneath it is an
#: assertion about nothing, so these two come FIRST and every other check below is downstream of
#: them. They are also mirrored into `pixel-oracle.json` by `make-emitted-image-fixtures.py
#: --oracle`, which is what `omeTiffPyramid.test.ts` reads — two independent copies on purpose:
#: this one refuses a bad file, that one refuses a stale oracle.
EXPECTED_SHA256 = "a1d99f0651baad26a6b5004c115a9c3f4e33d3d6e0b279b34cabbbe88d813ef2"
EXPECTED_BYTES = 269568

#: The TIFF tags upstream's IFD carries, by code, sorted. Sixteen — and the three that matter for
#: what this fixture is committed for are 259 (`Compression = 1`, uncompressed), 278
#: (`RowsPerStrip = 1`) and **339 (`SampleFormat`), which no other file in this corpus carries at
#: all**. 305 (`Software`) is here too and names Bio-Formats, which is the one predicate in
#: `#322 TEST-2` that actually probes a writer.
EXPECTED_TAGS = (
    256,  # ImageWidth
    257,  # ImageLength
    258,  # BitsPerSample
    259,  # Compression
    262,  # PhotometricInterpretation
    270,  # ImageDescription (the OME-XML)
    273,  # StripOffsets
    277,  # SamplesPerPixel
    278,  # RowsPerStrip
    279,  # StripByteCounts
    282,  # XResolution
    283,  # YResolution
    284,  # PlanarConfiguration
    296,  # ResolutionUnit
    305,  # Software
    339,  # SampleFormat
)

#: Scalar header values, read back through `tifffile` — a decoder independent of the `geotiff`
#: one the reader uses, so the two disagreeing is signal rather than a shared bug.
EXPECTED_HEADERS = {
    "ImageWidth": 512,
    "ImageLength": 512,
    "SamplesPerPixel": 1,
    "BitsPerSample": 8,
    "SampleFormat": 1,
    "Compression": 1,  # NONE. No other committed fixture reaches this arm of the allowlist.
    "PhotometricInterpretation": 1,  # MINISBLACK
    "PlanarConfiguration": 1,
    "RowsPerStrip": 1,
}

#: 512 rows at one row per strip. Derived below from the headers rather than trusted from here —
#: this value exists so the DERIVATION has something to disagree with.
EXPECTED_STRIPS = 512

#: The writer's own stamp (tag 305). Upstream NUL-terminates it; the comparison strips that.
EXPECTED_SOFTWARE = "OME Bio-Formats 5.2.0-m4"

#: Substrings of the OME-XML that make this document one THIS PROJECT DID NOT AUTHOR. Each is
#: absent from every other `.ome.tif` in the directory — measured, and `#346 TEST-2` re-measures
#: it over the directory so the claim cannot rot into a list.
EXPECTED_XML = (
    '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"',
    'Creator="OME Bio-Formats 5.2.0-m4"',
    "<Instrument ",
    '<Microscope Manufacturer="Nikon" Model="Eclipse TE300"',
    "<Detector ",
    "<Objective ",
    "<Experimenter ",
    'DimensionOrder="XYZTC"',
    'SizeC="2"',  # …while the file holds ONE IFD. See the module docstring.
    "<TiffData ",
    '<UUID FileName="tubhiswt_C0.ome.tif">',
    '<UUID FileName="tubhiswt_C1.ome.tif">',  # a file that is NOT this one
    "<Plane ",
)

#: What must NOT be in it: our own producer's payload, and the `tifffile` stamps every other
#: committed fixture but one carries. A regeneration through `ome_writer.write_ome_tiff` or raw
#: `tifffile.TiffWriter` is the cheap way to lose this fixture's whole value while leaving a
#: plausible OME-TIFF in place, and these are what refuse it.
FORBIDDEN_XML = ('Creator="tifffile', "cyto-spatial/1")


def _fail(problems: list[str]) -> int:
    for problem in problems:
        print(f"  ✗ {problem}")
    print(
        f"\n{len(problems)} problem(s). {FIXTURE.name} is committed VERBATIM from\n"
        f"  {SOURCE_URL}\n"
        "and nothing in this repository may rewrite it — re-encoding it, trimming it or "
        "regenerating it through our own writer destroys the one property it exists for (an "
        "OME-XML document this project did not author). Restore it with `--fetch`, or with "
        "`git checkout` against a commit that has it."
    )
    return 1


def check() -> int:
    """Identity first, then every header the fixture is committed for. Offline."""
    if not FIXTURE.exists():
        return _fail([f"{FIXTURE} is missing"])

    problems: list[str] = []
    raw = FIXTURE.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    # ── IDENTITY, before anything derived from the bytes ────────────────────────────────────
    if len(raw) != EXPECTED_BYTES:
        problems.append(f"byte length is {len(raw)}, recorded {EXPECTED_BYTES}")
    if digest != EXPECTED_SHA256:
        problems.append(f"sha256 is {digest}, recorded {EXPECTED_SHA256}")
    if problems:
        # Header checks on bytes that are not this file's report the wrong cause, so stop here.
        return _fail(problems)

    import tifffile  # imported late: `--fetch` and a bare `--help` must not need it

    with tifffile.TiffFile(str(FIXTURE)) as handle:
        if len(handle.pages) != 1:
            problems.append(
                f"{len(handle.pages)} top-level IFDs, expected 1 — the reader REFUSES more "
                "than one (MultiPlaneImageUnsupportedError), so a file with two would no "
                "longer be read successfully, which is half of what this fixture is for"
            )
        page = handle.pages[0]
        tags = tuple(sorted(tag.code for tag in page.tags.values()))
        if tags != EXPECTED_TAGS:
            problems.append(f"tag set is {tags}, recorded {EXPECTED_TAGS}")
        for name, expected in EXPECTED_HEADERS.items():
            if name not in page.tags:
                problems.append(f"{name} is absent; recorded {expected!r}")
                continue
            value = page.tags[name].value
            # `BitsPerSample` / `SampleFormat` are per-sample and `tifffile` hands back a scalar
            # for a one-sample file; both shapes are compared against the same scalar.
            if isinstance(value, tuple) and len(value) == 1:
                value = value[0]
            if int(value) != expected:
                problems.append(f"{name} is {int(value)!r}, recorded {expected!r}")
        # The strip count DERIVED from the file's own two tags, then compared with what the
        # directory actually holds AND with the recorded value. Three ways to disagree.
        if "RowsPerStrip" in page.tags and "ImageLength" in page.tags:
            rows = int(page.tags["RowsPerStrip"].value)
            height = int(page.tags["ImageLength"].value)
            derived = -(-height // rows)
            stored = len(page.tags["StripByteCounts"].value)
            if derived != stored or derived != EXPECTED_STRIPS:
                problems.append(
                    f"strip count: ceil({height}/{rows}) = {derived}, StripByteCounts holds "
                    f"{stored}, recorded {EXPECTED_STRIPS}"
                )
        software = str(page.tags["Software"].value).rstrip("\x00") if "Software" in page.tags else None
        if software != EXPECTED_SOFTWARE:
            problems.append(f"Software is {software!r}, recorded {EXPECTED_SOFTWARE!r}")
        # …and the raster really decodes, so "the headers are right" is not the whole claim.
        #
        # ── `pages[0].asarray()`, NOT `handle.asarray()`, AND THAT IS THE FIXTURE'S POINT ────
        # `tifffile.TiffFile.asarray()` (and `tifffile.imread`) resolve the OME **series**: they
        # PARSE the `<OME>` document, see `SizeC="2"` and two `<TiffData>` elements naming
        # `tubhiswt_C0.ome.tif` and `tubhiswt_C1.ome.tif`, go looking for the sibling file, and —
        # since this directory holds only C0 — return a `(2, 512, 512)` array with the second
        # plane ZEROED, after logging a `FileNotFoundError` warning.
        #
        # That is a live demonstration of the divergence this fixture exists to carry, from a
        # decoder that is not ours: an OME-XML-AWARE reader answers the DOCUMENT (two channels,
        # one of them missing), and `loadOmeTiffPyramid` — which never parses OME-XML — answers
        # the CONTAINER (one channel, all of it present). `#346 TEST-2` pins our side of it.
        #
        # So the oracle and this check both read the PAGE, which is the one IFD this file really
        # holds; anything else would be asserting over a plane upstream did not put here.
        plane = page.asarray()
        if plane.shape != (512, 512) or plane.dtype.name != "uint8":
            problems.append(f"raster is {plane.shape} {plane.dtype}, expected (512, 512) uint8")
        elif not plane.any():
            problems.append("raster decodes to all zeros")

    # ── THE OME-XML, scanned as BYTES ───────────────────────────────────────────────────────
    # As bytes and not as decoded text: the document sits in a binary file beside raw strip
    # payloads, so decoding the whole thing as text is both wasteful and locale-shaped.
    for marker in EXPECTED_XML:
        if marker.encode() not in raw:
            problems.append(f"OME-XML does not contain {marker!r}")
    for marker in FORBIDDEN_XML:
        if marker.encode() in raw:
            problems.append(
                f"OME-XML contains {marker!r} — this file has been rewritten by one of our own "
                "writers, which destroys the property it is committed for"
            )

    if problems:
        return _fail(problems)
    print(
        f"{FIXTURE.name}: {len(raw)} bytes, sha256 {digest}\n"
        f"  {len(EXPECTED_TAGS)} tags, Compression=1 (none), RowsPerStrip=1 "
        f"({EXPECTED_STRIPS} strips), SampleFormat present, Software={EXPECTED_SOFTWARE!r}\n"
        f"  OME-XML carries all {len(EXPECTED_XML)} foreign-author markers and none of the "
        f"{len(FORBIDDEN_XML)} producer stamps\n"
        f"  source {SOURCE_URL}\n"
        f"  {LICENCE} — {CREDIT}, retrieved {RETRIEVED}"
    )
    return 0


def fetch() -> int:
    """Re-download from `SOURCE_URL` and compare with the committed bytes. Needs the network."""
    print(f"GET {SOURCE_URL}")
    with tempfile.TemporaryDirectory() as workdir:
        landed = Path(workdir) / "upstream.ome.tif"
        with urllib.request.urlopen(SOURCE_URL, timeout=180) as response:
            landed.write_bytes(response.read())
        raw = landed.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        print(f"  {len(raw)} bytes, sha256 {digest}")
        if digest != EXPECTED_SHA256 or len(raw) != EXPECTED_BYTES:
            print(
                "UPSTREAM HAS MOVED. The committed fixture records "
                f"{EXPECTED_BYTES} bytes / {EXPECTED_SHA256}.\n"
                "Do NOT overwrite the committed file on this basis alone: its digest is quoted "
                "in `pixel-oracle.json`, in `fixtures/README.md` and in `#346 TEST-1`'s identity "
                "anchor, and a replacement upstream artifact is a new fixture with a new "
                "provenance row, not a silent update."
            )
            return 1
        if FIXTURE.exists() and FIXTURE.read_bytes() == raw:
            print(f"{FIXTURE.name} is byte-identical to upstream.")
            return 0
        FIXTURE.write_bytes(raw)
        print(f"written to {FIXTURE} (run --check next)")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--fetch",
        action="store_true",
        help="re-download from the recorded URL and compare (needs the network)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed bytes and headers (offline; the default)",
    )
    args = parser.parse_args()
    if args.fetch:
        return fetch()
    return check()


if __name__ == "__main__":
    sys.exit(main())
