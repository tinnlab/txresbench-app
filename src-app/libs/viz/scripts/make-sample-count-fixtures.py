#!/usr/bin/env python3
"""Write the `samples-per-pixel-<S>.ome.tif` family this package's loader tests read (#288).

## Why a script in `libs/viz` and not a recipe in a lifecycle artifact

`src/viz-core/spatial/fixtures/README.md` records that two of its fixtures were written by
"the short script recorded in `.lifecycle/spatial-pixel-source/FIXTURES.md` on the feature
branch". `.lifecycle/` is STRIPPED at merge, so that recipe does not exist on `main` and the
bytes cannot be re-derived by anyone reading the tree. This one lives on a permanent path
for exactly that reason.

## What these files are

The `SamplesPerPixel` family the reader must discriminate: S in {1, 2, 3, 4, 5} plus the
renderer's channel ceiling itself (S = 10, which must OPEN) and one over it (S = 11, which
must be REFUSED). Each is a two-level pyramid (`SubIFDs` + `subfiletype=1`), DEFLATE, tiled
512x512 — the shipped writer's own layout.

S = 10 exists because a blind audit demonstrated the band was unguarded: with the family
stopping at 5, mutating the accept arm to `samples > 5` — i.e. refusing 6..10 instead of
displaying them — and mutating `sampleStack` to `samples <= 5` — i.e. reinstating the exact
#288 defect for 6..10 — BOTH left the whole suite green. One fixture at the inclusive edge
kills both, and it is also what pins the ceiling to Viv's `MAX_CHANNELS` rather than to a
literal.

`samples-per-pixel-mismatched-levels.ome.tif` is the other case that audit found: S = 2 at
level 0 and S = 1 on its SubIFD. It is DELIBERATELY malformed — no writer emits it — and it
exists because the reader validated `SamplesPerPixel` on IFD 0 only, so such a file opened
with no refusal, declared level 1 as `[2, h, w]` over one-sample bytes, and failed per tile
with geotiff's bare `RangeError: Invalid sample index`.

**Every classification decision is the SHIPPED writer's, not this script's.** For the counts
`spatial-types/compute/ome_writer.py` emits (`READABLE_SAMPLE_COUNTS == (1, 3, 4)`) the
`photometric`/`extrasamples`/array-reshape triple is taken by CALLING `_sample_layout`, so
those three fixtures cannot drift from what the importer writes.

For S = 2, 5 and 11 the writer REFUSES (#266), so there is nothing to call. Those files use
the arm that same module documents as the one that would emit them if the refusal were
lifted, quoted from its `_sample_layout` docstring:

    An earlier cut of this function returned one, because the arm it was for —
    `minisblack` + `planarconfig="contig"`, which is how TIFF spells "S interleaved samples,
    no colour claimed" — is what would let this writer emit ANY sample count with a truthful
    header.

and from `docs/design/ome-tiff-sample-classification.md` §3, which states `tifffile`'s
contract for it (`contig_samples = shape[-1]`, `extrasamples = samples - 1`). The emitted
headers are asserted below rather than assumed, and they reproduce #288's own repro line:
`PhotometricInterpretation=MINISBLACK`, `SamplesPerPixel=S`, `PlanarConfiguration=1`,
`ExtraSamples=[UNSPECIFIED, ...]`.

## The pixels

`plane(s)[y][x] == (37*s + 5*x + 3*y) % 251`, uint8 — a closed form the TypeScript test
re-derives independently, so "channel c decoded sample c" is checked against arithmetic
rather than against a digest of whatever the reader happened to return. 251 is prime and
coprime with 37/5/3, so no two samples agree anywhere on the plane: reading sample 0 where
sample c was asked for differs in EVERY pixel, not merely on average.

`min_side` is lowered from the writer's `PYRAMID_MIN_SIDE = 256` to 64 so a 300x200 base
still carries a real `SubIFDs` pyramid; that is the only writer parameter this script
overrides, and it changes the number of levels, never the classification.

Run: `python3 src-app/libs/viz/scripts/make-sample-count-fixtures.py`
"""

import pathlib
import sys

import numpy as np
import tifffile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
WRITER_DIR = REPO / "src-app" / "packages" / "spatial-types" / "compute"
OUT = HERE.parent / "src" / "viz-core" / "spatial" / "fixtures"

sys.path.insert(0, str(WRITER_DIR))
import ome_writer as W  # noqa: E402

WIDTH, HEIGHT = 300, 200
MIN_SIDE = 64
SAMPLE_COUNTS = (1, 2, 3, 4, 5, 10, 11)


def plane(s):
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH]
    return ((37 * s + 5 * x + 3 * y) % 251).astype(np.uint8)


def build(samples):
    return np.stack([plane(s) for s in range(samples)], axis=-1)


def layout(arr, samples):
    """`(array, photometric, extrasamples, planarconfig)` — the writer's, where it has one."""
    if samples in W.READABLE_SAMPLE_COUNTS:
        a, photometric, extrasamples = W._sample_layout(arr)
        return a, photometric, extrasamples, None
    return arr, "minisblack", ("unspecified",) * (samples - 1), "contig"


def write(samples):
    arr = build(samples)
    a, photometric, extrasamples, planarconfig = layout(arr, samples)
    levels = W.pyramid_levels(a, min_side=MIN_SIDE)
    dest = OUT / f"samples-per-pixel-{samples}.ome.tif"
    kw = dict(photometric=photometric, compression=W.CODEC, tile=W.TILE)
    if extrasamples:
        kw["extrasamples"] = extrasamples
    if planarconfig:
        kw["planarconfig"] = planarconfig
    with tifffile.TiffWriter(str(dest), ome=True) as writer:
        writer.write(a, subifds=len(levels) or None, **kw)
        for level in levels:
            writer.write(level, subfiletype=1, **kw)
    return dest, len(levels) + 1


def verify(dest, samples, levels):
    """The header this file actually carries, asserted — never assumed from the keywords.

    `PhotometricInterpretation` and `ExtraSamples` are asserted HERE and nowhere else was true
    of an earlier version of this docstring but not of its code: both were printed and neither
    was checked, so `fixtures/README.md`'s per-row `MINISBLACK` / `RGB` / `[UNASSALPHA]` claims
    rested on nothing. They are checked now, and `omeTiffSampleCounts.test.ts`'s TEST-10 reads
    them back out of the committed bytes so the claim survives without this script being re-run.
    """
    with tifffile.TiffFile(dest) as tf:
        page = tf.pages[0]
        tags = page.tags
        assert len(tf.pages) == 1, f"{dest.name}: {len(tf.pages)} top-level IFDs, expected 1"
        assert tags["SamplesPerPixel"].value == samples, dest.name
        photometric = int(tags["PhotometricInterpretation"].value)
        want_photometric = 2 if samples in (3, 4) else 1  # RGB : MINISBLACK
        assert photometric == want_photometric, (
            f"{dest.name}: PhotometricInterpretation {photometric}, expected {want_photometric}"
        )
        extras = tuple(int(v) for v in tags["ExtraSamples"].value) if "ExtraSamples" in tags else ()
        if samples == 4:
            want_extras = (2,)          # UNASSALPHA — TIFF 6.0's RGBA, the writer's own choice
        elif samples in (1, 3):
            want_extras = ()
        else:
            want_extras = (0,) * (samples - 1)  # UNSPECIFIED: the file declines to say
        assert extras == want_extras, f"{dest.name}: ExtraSamples {extras}, expected {want_extras}"
        # Absent for a single-sample plane; TIFF 6.0 makes it meaningless there and the
        # default is CONTIG, which is what "PlanarConfiguration=1" means for every other row.
        planar = int(tags["PlanarConfiguration"].value) if "PlanarConfiguration" in tags else 1
        assert planar == 1, dest.name
        assert len(tags["SubIFDs"].value) == levels - 1, dest.name
        assert tags["TileWidth"].value == W.TILE[0], dest.name
        # The pixels round-trip, which is what makes the closed form above an oracle.
        got = tf.series[0].levels[0].asarray()
        want = build(samples)
        if samples == 1:
            want = want[:, :, 0]
        assert np.array_equal(got, want), f"{dest.name}: level 0 does not round-trip"
        return {
            "photometric": str(tags["PhotometricInterpretation"].value),
            "extrasamples": (tags["ExtraSamples"].value if "ExtraSamples" in tags else None),
            "shape": page.shape,
        }


def write_mismatched_levels():
    """S = 2 at level 0, S = 1 on its SubIFD — a file no writer emits.

    Hand-built rather than generated by the branch table above, because the WHOLE POINT is a
    level whose sample layout disagrees with level 0's, which every legitimate path forbids
    (`ome_writer.write_ome_tiff` passes the same `photometric`/`extrasamples` to both writes,
    for the reason #227 gives for `tile=`). The reader must refuse it BY NAME at the open call;
    before #288's per-level check it opened cleanly and failed per tile with an untyped
    `RangeError` from inside the render loop.
    """
    level0 = build(2)
    level1 = W.pyramid_levels(level0, min_side=MIN_SIDE)[0][:, :, 0]  # one sample, not two
    dest = OUT / "samples-per-pixel-mismatched-levels.ome.tif"
    with tifffile.TiffWriter(str(dest), ome=True) as writer:
        writer.write(level0, photometric="minisblack", planarconfig="contig",
                     extrasamples=("unspecified",), compression=W.CODEC, tile=W.TILE,
                     subifds=1)
        writer.write(level1, photometric="minisblack", compression=W.CODEC, tile=W.TILE,
                     subfiletype=1)
    with tifffile.TiffFile(dest) as tf:
        assert len(tf.pages) == 1, dest.name
        assert tf.pages[0].tags["SamplesPerPixel"].value == 2, dest.name
        sub = tf.pages[0].tags["SubIFDs"].value
        assert len(sub) == 1, dest.name
    print(f"{dest.name:40s} S=2 at level 0, S=1 at level 1 (DELIBERATELY malformed) "
          f"{dest.stat().st_size} B")


def write_mixed_bits_per_sample():
    """A REAL 5-sample file with ONE field rewritten: `BitsPerSample = (8, 16, 8, 8, 8)`.

    `tifffile` will not write a mixed `BitsPerSample`, and neither will any writer this system
    ships — so the only way to have the reader's `assertUniformSampleFormat` guard exercised
    from the REAL open path, rather than only as a direct call, is to take a real file and
    rewrite that one tag's value bytes in place. Everything else about the file — its IFDs, its
    SubIFD pyramid, its strips, its OME-XML — is the generated 5-sample fixture unchanged.

    This is deliberately NOT "testing the forgery": the input class under test is a malformed
    vendor directory, the forgery IS that class, and the reader must refuse it before a single
    tile is decoded. `tifffile` reports the tag's `valueoffset` for us, so the patch is located
    by the library's own parse rather than by a hand-counted offset.
    """
    source = OUT / f"samples-per-pixel-{5}.ome.tif"
    dest = OUT / "samples-per-pixel-mixed-bits.ome.tif"
    raw = bytearray(source.read_bytes())
    with tifffile.TiffFile(source) as tf:
        tag = tf.pages[0].tags["BitsPerSample"]
        offset, count, byteorder = tag.valueoffset, tag.count, tf.byteorder
    assert count == 5 and tag.dtype == tifffile.DATATYPE.SHORT, "unexpected BitsPerSample layout"
    # sample 1 becomes 16-bit; samples 0 and 2..4 stay 8-bit.
    raw[offset + 2 : offset + 4] = (16).to_bytes(2, "little" if byteorder == "<" else "big")
    dest.write_bytes(bytes(raw))
    with tifffile.TiffFile(dest) as tf:
        got = tuple(int(v) for v in tf.pages[0].tags["BitsPerSample"].value)
    assert got == (8, 16, 8, 8, 8), got
    print(f"{dest.name:40s} BitsPerSample={got} (one field of the real S=5 file, rewritten) "
          f"{dest.stat().st_size} B")


def write_planar_sublevel():
    """S = 2 CONTIG at level 0, S = 2 SEPARATE on its SubIFD — another file no writer emits.

    Committed because the claim it replaces was FALSE. The reader's per-level
    `PlanarConfiguration` arm was pinned by a hand-built literal on the stated ground that a
    planar sub-level is "a shape `tifffile` will not write"; a blind audit wrote one in twelve
    lines. (The other half of that sentence IS true: `tifffile` refuses a mixed `BitsPerSample`
    outright — "not writing extratag 258" — which is why `samples-per-pixel-mixed-bits.ome.tif`
    has to be a byte patch and this one does not.)

    `ome=True` is passed explicitly, like every other file in this family. An earlier version of
    this function omitted it under a justification that was measured FALSE in both halves:
    `tifffile` infers OME mode from the `.ome.tif` suffix anyway (so the OME-XML was never
    absent — the file carried a 659-byte `ImageDescription` either way), and its OME writer does
    NOT reject a series whose levels disagree on planarconfig (writing it with `ome=True` gives a
    byte-identical file modulo the `urn:uuid`).
    """
    level0 = build(2)
    level1 = W.pyramid_levels(level0, min_side=MIN_SIDE)[0]
    dest = OUT / "samples-per-pixel-planar-sublevel.ome.tif"
    with tifffile.TiffWriter(str(dest), ome=True) as writer:
        writer.write(level0, photometric="minisblack", planarconfig="contig",
                     extrasamples=("unspecified",), compression=W.CODEC, tile=W.TILE,
                     subifds=1)
        # `(S, H, W)` is how `tifffile` spells SEPARATE — the same pixels, the other layout.
        writer.write(level1.transpose(2, 0, 1), photometric="minisblack",
                     planarconfig="separate", extrasamples=("unspecified",),
                     compression=W.CODEC, tile=W.TILE, subfiletype=1)
    with tifffile.TiffFile(dest) as tf:
        page = tf.pages[0]
        assert len(tf.pages) == 1, dest.name
        assert page.tags["SamplesPerPixel"].value == 2, dest.name
        assert int(page.tags["PlanarConfiguration"].value) == 1, dest.name
        sub = page.tags["SubIFDs"].value
        assert len(sub) == 1, dest.name
        subpage = tf.series[0].levels[1].pages[0]
        assert int(subpage.tags["PlanarConfiguration"].value) == 2, dest.name
        assert subpage.tags["SamplesPerPixel"].value == 2, dest.name
    print(f"{dest.name:44s} S=2 CONTIG at level 0, S=2 SEPARATE at level 1 "
          f"(DELIBERATELY malformed) {dest.stat().st_size} B")


def main():
    for samples in SAMPLE_COUNTS:
        dest, levels = write(samples)
        info = verify(dest, samples, levels)
        print(f"{dest.name:40s} S={samples:<3d} levels={levels} "
              f"{info['photometric']:26s} extras={info['extrasamples']} "
              f"shape={info['shape']} {dest.stat().st_size} B")
    write_mismatched_levels()
    write_mixed_bits_per_sample()
    write_planar_sublevel()


if __name__ == "__main__":
    main()
