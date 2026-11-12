#!/usr/bin/env python3
"""Re-emit the `spatial-image-*.ome.tif` fixtures through the SHIPPED writer (#259).

`src-app/libs/viz/src/viz-core/spatial/fixtures/spatial-image-{hires,lowres,greyscale}.ome.tif`
are samples of what `ome_writer.write_ome_tiff` puts on disk. #227 changed what that is —
every `writer.write` call now passes `tile=(512, 512)`, so the emitted layout went from
full-width STRIPS to 512x512 TILES at every pyramid level — and the committed corpus was
frozen before that, so it stopped sampling the producer. This script is what re-syncs it,
and it lives at a permanent committed path because the previous recipe did not: it was
recorded in a `.lifecycle/` file that the merge strip deleted, which is the reason two of
these files were not re-derivable from this tree at all.

## What it re-derives, and what it carries forward

Each fixture is re-emitted from ITSELF. The script opens the committed artifact and takes
three things out of it verbatim:

  * the level-0 pixel array (the writer is lossless, so this is the producer's own raster —
    asserted below to survive the round trip bit for bit);
  * the `txr` placement payload the file's OME `<Description>` carries, decoded with the
    producer's own `spatial_declarations.decode_placement`;
  * the OME `PhysicalSizeX` the file declares, handed back as `image_microns_per_pixel`.

Everything else — the tiling, the pyramid, the codec, every TIFF tag — is re-derived by
today's `write_ome_tiff`. So the diff between the old bytes and the new ones is exactly
what the WRITER's code decides, and nothing the CALLER supplies moves.

That split is the point, and it is not incidental tidiness. The fixture directory's README
records that these files' producer magnitudes are deliberately FROZEN at their pre-#222
values under #222's fix-forward-only ruling, and `scripts/check-viz-producer-magnitudes.mjs`
enforces that against these very bytes. A regeneration that ran the importer end to end
would re-derive the micron scale too (measured: `PhysicalSizeX` 3.7356857014116684 ->
4.4149012834865164 on the hires image), i.e. it would silently overturn that ruling as a
side effect of a layout refresh. Carrying the scale out of the artifact instead means this
script CANNOT move a producer magnitude, whatever the importer does later.

## Reproducibility, and the staleness gate

Deterministic in everything except one thing: `tifffile` stamps a fresh `urn:uuid` into the
OME-XML on every write, so two runs differ in ~36 bytes of that attribute and are otherwise
byte-identical. Because each fixture is re-emitted from itself and the writer is lossless,
the script is also idempotent in pixels: a second run reads back the raster it just wrote.

`--check` therefore makes TWO comparisons, and the second is the one that matters:

  * fresh-vs-fresh — two emits into a temp dir, UUID-blanked, must be identical. This is the
    reproducibility claim.
  * **fresh-vs-COMMITTED** — the fresh emit, UUID-blanked, must equal the committed fixture.
    This is the STALENESS GATE, and without it `--check` could not detect the exact condition
    it exists for. An earlier cut compared only the two temp files and asserted
    `tile == ome_writer.TILE` — a value that MOVES WITH THE WRITER — so a writer whose `TILE`,
    codec or pyramid rule changed left `--check` green with the corpus stale, which is #259 all
    over again one level up.

    Its failure mode is the useful one: it goes red on the day the producer changes, in the
    package whose suite runs it, naming the fixture and telling you to re-run without `--check`.

    python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py           # rewrite in place
    python3 src-app/libs/viz/scripts/make-emitted-image-fixtures.py --check   # reproducible AND not stale

`unsupported-jpeg2000.ome.tif` is NOT handled here and that is deliberate — see `--jpeg2000`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import tifffile

HERE = Path(__file__).resolve()
REPO = HERE.parents[4]
FIXTURES = HERE.parents[1] / "src" / "viz-core" / "spatial" / "fixtures"
WRITER_DIR = REPO / "src-app" / "packages" / "spatial-types" / "compute"
sys.path.insert(0, str(WRITER_DIR))

import ome_writer as OW          # noqa: E402
import spatial_declarations as SD  # noqa: E402

#: The writer-emitted fixtures. Every one of these is `write_ome_tiff` output and nothing else.
EMITTED = ("spatial-image-hires.ome.tif",
           "spatial-image-lowres.ome.tif",
           "spatial-image-greyscale.ome.tif")

#: The STRIPPED control — the pre-#227 emit of `spatial-image-hires.ome.tif`, kept.
#:
#: Once the three files above became tiled there was no fixture left in this directory that a
#: successful read could go through with `TileWidth` absent — the four remaining stripped files
#: are all shapes the reader REFUSES (non-halving, mixed codec, multi-plane, planar), so none of
#: them reaches a decode. That is a real loss of coverage and not a bookkeeping one: OME-TIFFs in
#: the wild are routinely stripped, and `docs/design/ome-tiff-tile-layout.md` §5 makes keeping
#: one a standing rule ("a reader that only handles the layout its own writer emits is a reader
#: that breaks on the first third-party OME-TIFF").
#:
#: This script does not WRITE it, and could not: `write_ome_tiff` has passed `tile=` at every
#: call site since #227, so the shipped writer can no longer produce a stripped file at all.
#: The control is the artifact this system emitted BEFORE that change, preserved verbatim:
#:
#:     git show 4cb70f45:src-app/libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif \
#:       > src-app/libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires-stripped.ome.tif
#:
#: which is a stricter provenance than a generator can offer — no `urn:uuid` caveat, no
#: re-derivation, byte-identical to what the importer put on disk. It carries the SAME PIXELS as
#: the regenerated `spatial-image-hires.ome.tif`, which is what makes the pair a controlled
#: experiment for the cost claim rather than two unrelated files: same image, two layouts.
STRIPPED_CONTROL = "spatial-image-hires-stripped.ome.tif"


def _physical_size_x(ome_xml: str):
    """The OME `PhysicalSizeX` the file declares, or `None`.

    Read as a STRING first and only then parsed, so the value that goes back in is the one
    that came out — this is the frozen producer magnitude the whole carry-forward exists to
    protect, and a reformat of it is a silent edit of a guarded number.
    """
    match = re.search(r'PhysicalSizeX="([^"]+)"', ome_xml or "")
    return float(match.group(1)) if match else None


def _read(path: Path):
    with tifffile.TiffFile(str(path)) as tf:
        arr = tf.series[0].levels[0].asarray()
        placement = SD.decode_placement(tf.ome_metadata)
        scale = _physical_size_x(tf.ome_metadata)
    if placement is None or not isinstance(placement, dict):
        raise SystemExit(f"{path.name}: carries no readable `txr` placement; refusing to guess one")
    return arr, placement, scale


def _emit(dest: Path, arr, placement, scale):
    OW.write_ome_tiff(dest, arr, placement=placement, image_microns_per_pixel=scale)


def _assert_emitted(path: Path, source_arr, source_scale):
    """Every claim this script makes about its own output, checked against the bytes."""
    with tifffile.TiffFile(str(path)) as tf:
        levels = tf.series[0].levels
        for index, level in enumerate(levels):
            page = level.pages[0]
            tile = (page.tags.get("TileWidth"), page.tags.get("TileLength"))
            if not page.is_tiled or tile[0] is None or tile[1] is None:
                raise SystemExit(f"{path.name}: level {index} is not TILED — #227 requires tile= on every write")
            if (tile[0].value, tile[1].value) != OW.TILE:
                raise SystemExit(f"{path.name}: level {index} tile is {(tile[0].value, tile[1].value)}, not {OW.TILE}")
            if page.tags.get("RowsPerStrip") is not None:
                raise SystemExit(f"{path.name}: level {index} still carries RowsPerStrip")
        back = levels[0].asarray()
        scale = _physical_size_x(tf.ome_metadata)
    if not np.array_equal(back, source_arr):
        raise SystemExit(f"{path.name}: the round trip is NOT lossless")
    if scale != source_scale:
        raise SystemExit(f"{path.name}: PhysicalSizeX moved {source_scale} -> {scale}; the frozen "
                         "producer magnitude must be carried forward, never re-derived")


def _uuid_blind(path: Path) -> str:
    """A digest of the file with the OME `UUID` attribute blanked.

    `tifffile` stamps a fresh `urn:uuid` per write, so raw bytes are never equal across runs.
    Blanking exactly that attribute — and nothing else — is what turns "the same file" into a
    checkable claim rather than a hand-wave.
    """
    raw = path.read_bytes()
    return hashlib.sha256(re.sub(rb'urn:uuid:[0-9a-fA-F-]{36}', b'urn:uuid:' + b'0' * 36, raw)).hexdigest()


def regenerate(check_only: bool) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="ome-fixture-refresh-"))
    try:
        for name in EMITTED:
            committed = FIXTURES / name
            arr, placement, scale = _read(committed)
            first = tmp / name
            _emit(first, arr, placement, scale)
            _assert_emitted(first, arr, scale)
            second = tmp / ("second-" + name)
            _emit(second, arr, placement, scale)
            same = _uuid_blind(first) == _uuid_blind(second)
            fresh = _uuid_blind(first) == _uuid_blind(committed)
            # Every figure labelled with the file it describes. An earlier cut printed
            # "<committed size> -> <fresh size> B, tiled <TILE> at every level", where the
            # size on the left was the COMMITTED file and the tile was the FRESH one — so a
            # stale 512-tiled corpus against a 256-tiled writer printed "tiled 256x256 at
            # every level" over a committed file that is nothing of the kind.
            print(f"{name}: committed {committed.stat().st_size} B -> fresh emit "
                  f"{first.stat().st_size} B (fresh: tiled {OW.TILE[0]}x{OW.TILE[1]} at every "
                  f"level, PhysicalSizeX={scale}), reproducible-modulo-uuid={same}, "
                  f"committed-matches-writer={fresh}")
            if not same:
                raise SystemExit(f"{name}: two runs differ by more than the OME UUID")
            if check_only and not fresh:
                raise SystemExit(
                    f"{name}: STALE. The committed fixture is not what today's writer emits for "
                    "these pixels, this placement and this OME pixel pitch. Re-run this script "
                    "without --check to refresh it, then re-read fixtures/README.md — a layout "
                    "change moves the byte bounds the reader suites assert."
                )
            if not check_only:
                shutil.copyfile(first, committed)

        control = FIXTURES / STRIPPED_CONTROL
        if not control.exists():
            raise SystemExit(f"{STRIPPED_CONTROL} is missing — see its note above for how to restore it")
        with tifffile.TiffFile(str(control)) as tf:
            rows = [level.pages[0].tags["RowsPerStrip"].value for level in tf.series[0].levels]
            if any(level.pages[0].is_tiled for level in tf.series[0].levels):
                raise SystemExit(f"{STRIPPED_CONTROL} is TILED; the control must be stripped")
            control_pixels = tf.series[0].levels[0].asarray()
        hires_pixels = _read(FIXTURES / "spatial-image-hires.ome.tif")[0]
        if not np.array_equal(control_pixels, hires_pixels):
            raise SystemExit(f"{STRIPPED_CONTROL} no longer carries the same pixels as the tiled artifact")
        print(f"{STRIPPED_CONTROL}: {control.stat().st_size} B, STRIPPED (RowsPerStrip={rows}), "
              "same pixels as spatial-image-hires.ome.tif — not written here, see its note")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("check only — nothing written" if check_only else f"written to {FIXTURES}")
    return 0


# ── the pixel oracle ────────────────────────────────────────────────────────────────────────
#
# `pixel-oracle.json` is the INDEPENDENT decoder in `omeTiffPyramid.test.ts`: digests produced
# by `tifffile` (a different decoder, in a different language) over the same fixtures, and the
# only thing in that suite that can tell "the loader decoded the right pixels" from "the loader
# decoded pixels self-consistently". It was hand-maintained, which is the same failure mode as
# the fixtures themselves — so `--oracle` derives EVERY entry from the committed bytes. Nothing
# in that file is transcribed any more: the byte offsets are read out of the TIFF directory and
# the file sizes off disk, so a fixture and its oracle cannot drift apart.

#: `(key prefix, fixture, level, tile x, tile y)` for every decoded-tile digest.
ORACLE_TILES = (
    ("hires_level0_tile_x1_y2_512", "spatial-image-hires.ome.tif", 0, 1, 2),
    ("greyscale_level0_tile_x0_y0_512", "spatial-image-greyscale.ome.tif", 0, 0, 0),
    ("tiled_level0_tile_x0_y0_512", "tiled-deflate.ome.tif", 0, 0, 0),
    # The stripped control's own row, at the SAME tile as the tiled artifact's row above. Its
    # value is necessarily that row's — that is the point of the pair — but it is computed
    # independently here rather than aliased, so "the layout moved the bytes and moved no pixel"
    # is checked by `tifffile` and not merely asserted by the reader against itself.
    ("hires_stripped_level0_tile_x1_y2_512", STRIPPED_CONTROL, 0, 1, 2),
    # ── THE THIRD-PARTY PAIR (#322) ────────────────────────────────────────────────────────
    # `third-party-stripped.ome.tif` is the corpus's stripped OME-TIFF from a writer this
    # project does NOT control (Pillow — see `make-third-party-stripped-fixture.py`), and it
    # carries the level-0 raster of `spatial-image-lowres.ome.tif`, which OUR writer emitted.
    # Both rows are computed here, independently, from two DIFFERENT FILES: their equality is
    # then a measurement of the corpus rather than an alias, exactly as the stripped control's
    # row above is. That is what lets `omeTiffPyramid.test.ts` state "the same pixels survive
    # two unrelated writers" without the reader agreeing with itself.
    #
    # `unsupported-jpeg2000.ome.tif` is deliberately NOT here for the same reason it is not
    # regenerated (see `--jpeg2000`); this file is, because it decodes.
    # Both are entered as WHOLE-LEVEL rasters below rather than as tiles, and the reason is
    # measured: this image is 420 px wide, so EVERY 512-edge tile of it overhangs. `_oracle_tile`
    # zero-pads an overhang (which is what `tifffile` sees) while the reader clips it (which is
    # what `ImageWidth` declares), so a padded tile digest could never equal a read one and the
    # assertion would be about the padding convention instead of about the pixels.
)

TILE_EDGE = 512


def _oracle_tile(path: Path, level: int, x: int, y: int, edge: int = TILE_EDGE):
    """The `edge x edge` tile at `(x, y)` of `level`, zero-padded at the image's far edges.

    The padding matches what the reader hands deck.gl: `ImageWidth`/`ImageLength` declare the
    true extent, so a tile that overhangs comes back full-size with the overhang zeroed.
    """
    plane = tifffile.imread(str(path), level=level)
    out = np.zeros((edge, edge) + plane.shape[2:], dtype=plane.dtype)
    patch = plane[y * edge:min(y * edge + edge, plane.shape[0]),
                  x * edge:min(x * edge + edge, plane.shape[1])]
    out[:patch.shape[0], :patch.shape[1]] = patch
    return out


def _digest(array) -> str:
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def build_oracle() -> dict:
    """Every entry of `pixel-oracle.json`, derived from the committed fixtures."""
    oracle: dict = {}
    for key, name, level, x, y in ORACLE_TILES:
        tile = _oracle_tile(FIXTURES / name, level, x, y)
        oracle[key] = _digest(tile)
        oracle[key.rsplit("_", 1)[0].replace("_512", "") + "_shape"] = list(tile.shape)
    level2 = tifffile.imread(str(FIXTURES / "spatial-image-hires.ome.tif"), level=2)
    oracle["hires_level2_raster"] = _digest(level2)
    oracle["hires_level2_shape"] = list(level2.shape)
    oracle["tifffile_version"] = tifffile.__version__
    oracle["hires_level0_tile_x0_y0_512_sum"] = int(
        _oracle_tile(FIXTURES / "spatial-image-hires.ome.tif", 0, 0, 0).astype(np.int64).sum())
    # The STORED length of the two level-0 tiles the suites request, read out of the artifact's
    # own `TileByteCounts`. This is what makes "one tile, one range request" expressible as an
    # EQUALITY in the unit tier and as a tight bound in the e2e tier, at any artifact size — the
    # bounds it replaces were multiples of a full-width band and could not bind (#259).
    with tifffile.TiffFile(str(FIXTURES / "spatial-image-hires.ome.tif")) as tf:
        page = tf.series[0].levels[0].pages[0]
        across = -(-page.imagewidth // page.tilewidth)
        counts = page.tags["TileByteCounts"].value
        oracle["hires_level0_tile_x0_y0_stored_bytes"] = int(counts[0])
        # …and WHERE it lives, so the wire tier can identify the tile's ranged GET by offset
        # rather than only by length — a length is not an identity.
        oracle["hires_level0_tile_x0_y0_offset"] = int(page.tags["TileOffsets"].value[0])
        # Tile (1, 2) — the one `omeTiffPyramid.test.ts`'s #259 TEST-5 asks for. That test
        # recomputes this from the directory ITSELF and then asserts the two agree, which is
        # what binds the oracle to the bytes at RUN time rather than at generation time.
        oracle["hires_level0_tile_x1_y2_stored_bytes"] = int(counts[2 * across + 1])
        # The COARSEST level's whole stored size. The render path serves that level for a
        # fit-to-viewport camera, so "the render read the overview plus a tile or two" is
        # expressible against the artifact instead of as a fraction of the object.
        coarsest = tf.series[0].levels[-1].pages[0]
        oracle["hires_coarsest_level_stored_bytes"] = int(sum(coarsest.tags["TileByteCounts"].value))
        # Everything in the file that is NOT pixel payload: the TIFF header, the OME-XML, and
        # every level's directory. It is what an OPEN has to read, and it is derived here so the
        # e2e specs' open budget stops being a hand-transcribed measurement -- the one species of
        # un-anchored number this whole branch exists to remove, which an earlier cut of those
        # specs reintroduced as `2 * 5_508` in three files at once.
        # EVERY page of every level, not `pages[0]`. A multi-page level (a planar or
        # multi-channel emit) would otherwise have its other pages' payload counted as
        # "non-pixel", inflating the term and silently loosening the three e2e budgets that
        # are stated in it. This writer emits one page per level today, so the walk is written
        # for a shape it does not currently produce; the `raise` below guards a DIFFERENT
        # property (a level carrying neither tag) and is not a check on the page count.
        # `omeTiffPyramid.test.ts`'s #259 TEST-5 re-derives the same figure over IFD 0 +
        # SubIFDs only, i.e. one page per level, and will go red if that assumption ever breaks
        # — which is the intended way to find out.
        pixels = 0
        for level in tf.series[0].levels:
            for page in level.pages:
                counts = page.tags.get("TileByteCounts") or page.tags.get("StripByteCounts")
                if counts is None:
                    raise SystemExit("a level of spatial-image-hires.ome.tif carries neither "
                                     "TileByteCounts nor StripByteCounts; the non-pixel "
                                     "derivation cannot be trusted")
                pixels += sum(counts.value)
        oracle["hires_non_pixel_bytes"] = int((FIXTURES / "spatial-image-hires.ome.tif").stat().st_size - pixels)
    with tifffile.TiffFile(str(FIXTURES / "unsupported-jpeg2000.ome.tif")) as tf:
        oracle["jpeg2000_first_subifd_offset"] = int(tf.pages[0].tags["SubIFDs"].value[0])
    oracle["jpeg2000_byte_length"] = (FIXTURES / "unsupported-jpeg2000.ome.tif").stat().st_size
    oracle["short_file_byte_length"] = (FIXTURES / "short-not-a-tiff.bin").stat().st_size
    # ── the third-party fixture's IDENTITY and its STRIP GEOMETRY (#322) ────────────────────
    # Its byte length is the identity anchor, the same role `jpeg2000_byte_length` plays: a
    # digest assertion means nothing if the file under it was swapped. The two geometry values
    # are read out of the file's OWN directory by `tifffile`, so `omeTiffPyramid.test.ts` can
    # cross-check what GEOTIFF reads off the same tags against what a second, unrelated TIFF
    # parser reads — and can DERIVE its expected strip count from the file instead of
    # hardcoding one. A number typed into a test is a number that survives the file changing.
    third_party = FIXTURES / "third-party-stripped.ome.tif"
    for key, name in (("third_party_stripped_level0_raster", third_party.name),
                      ("lowres_level0_raster", "spatial-image-lowres.ome.tif")):
        raster = tifffile.imread(str(FIXTURES / name), level=0)
        oracle[key] = _digest(raster)
        oracle[key + "_shape"] = list(raster.shape)
    oracle["third_party_stripped_byte_length"] = third_party.stat().st_size
    with tifffile.TiffFile(str(third_party)) as tf:
        page = tf.pages[0]
        oracle["third_party_stripped_rows_per_strip"] = int(page.tags["RowsPerStrip"].value)
        oracle["third_party_stripped_strip_count"] = len(page.tags["StripByteCounts"].value)
    # ── THE FOREIGN-AUTHORED OME-XML FIXTURE (#346) ────────────────────────────────────────
    # `bioformats-tubhiswt.ome.tif` is committed VERBATIM from the OME sample tree under CC BY
    # 4.0 (see `scripts/fetch-vendor-ome-fixture.py` for the URL, the licence and the credit).
    # NOTHING in this repository produced a byte of it, which is exactly why it can carry an
    # `<OME>` document this project did not author — the property #322 could not have, because
    # Pillow will not write OME-XML and our generator hand-authored that file's document.
    #
    # A FILE DIGEST, not only a byte length, and that is the difference between this row and the
    # third-party rows above. Those files are REGENERATED by a committed script, so their recipe
    # is the identity and a length is enough of an anchor beside it. This one is DOWNLOADED: its
    # identity IS its bytes, there is nothing to re-derive it from, and a same-length substitution
    # (a re-encode at the same size, a sibling plane of the same set) is exactly the swap the
    # anchor has to refuse. `#346 TEST-1` asserts both before it asserts anything else.
    vendor = FIXTURES / "bioformats-tubhiswt.ome.tif"
    oracle["vendor_ome_xml_byte_length"] = vendor.stat().st_size
    oracle["vendor_ome_xml_sha256"] = hashlib.sha256(vendor.read_bytes()).hexdigest()
    with tifffile.TiffFile(str(vendor)) as tf:
        page = tf.pages[0]
        oracle["vendor_ome_xml_rows_per_strip"] = int(page.tags["RowsPerStrip"].value)
        oracle["vendor_ome_xml_strip_count"] = len(page.tags["StripByteCounts"].value)
        # ── `page.asarray()`, DELIBERATELY, AND NOT `tifffile.imread(..., level=0)` ─────────
        # Every other raster row above goes through `tifffile.imread`, which resolves the OME
        # SERIES. On this file that means PARSING the `<OME>` document, reading `SizeC="2"` and
        # two `<TiffData>` elements naming `tubhiswt_C0.ome.tif` and `tubhiswt_C1.ome.tif`, and
        # returning a `(2, 512, 512)` array with the sibling file's plane ZEROED — because this
        # directory holds C0 and not C1.
        #
        # That is the fixture's own subject seen from the other side, and it is worth stating
        # here rather than only in the test: an OME-XML-AWARE decoder answers the DOCUMENT, and
        # `loadOmeTiffPyramid`, which never parses OME-XML, answers the CONTAINER. The oracle
        # must anchor what the READER can be right about, so it digests the ONE IFD this file
        # actually holds. Digesting the series would bake a zero-filled plane and a warning into
        # the corpus and would compare the reader against a plane upstream never put here.
        raster = page.asarray()
        oracle["vendor_ome_xml_level0_raster"] = _digest(raster)
        oracle["vendor_ome_xml_level0_raster_shape"] = list(raster.shape)
    return oracle


def write_oracle(check_only: bool) -> int:
    """Re-derive `pixel-oracle.json`. With `--check`, DISAGREEMENT IS A NON-ZERO EXIT.

    An earlier cut printed the moved entries and returned 0 unconditionally, so
    `--oracle --check` could not fail and the suite leg that runs it was green by construction —
    a check that reports and does not refuse, which is the exact shape this branch exists to
    remove. `check_only` now gates the exit code as well as the write.
    """
    path = FIXTURES / "pixel-oracle.json"
    current = json.loads(path.read_text())
    fresh = build_oracle()
    moved = [k for k in sorted(set(current) | set(fresh))
             if current.get(k) != fresh.get(k)]
    for key in moved:
        print(f"  {key}: {current.get(key)!r} -> {fresh.get(key)!r}")
    print(f"{len(moved)} entry/entries move" if moved else "every entry already agrees")
    if check_only:
        if moved:
            print(
                "pixel-oracle.json is STALE against the committed fixtures. Re-run this script "
                "with --oracle (no --check) to re-derive it, and re-read every bound that "
                "consumes a moved entry: the e2e byte budgets are stated in these quantities."
            )
            return 1
        return 0
    path.write_text(json.dumps(fresh, indent=2, sort_keys=True) + "\n")
    print(f"written to {path}")
    return 0


def jpeg2000_note() -> int:
    """Why `unsupported-jpeg2000.ome.tif` is not regenerated — and its recipe, DERIVED.

    #259 filed this fixture's recipe as lost with `.lifecycle/`. A recipe printed from memory
    would be the same defect in a new place, so every parameter below is read out of the
    committed file rather than recalled: an earlier draft of this text said `uint8` for a file
    that is `uint16`, which is exactly what a recalled recipe is worth.
    """
    path = FIXTURES / "unsupported-jpeg2000.ome.tif"
    with tifffile.TiffFile(str(path)) as tf:
        page = tf.pages[0]
        levels = tf.series[0].levels
        dtype, shape = page.dtype, (page.imagelength, page.imagewidth)
        tile = (page.tags["TileLength"].value, page.tags["TileWidth"].value)
        compression = int(page.tags["Compression"].value)
        photometric = str(page.photometric).rsplit(".", 1)[-1].lower()
    print(f"""\
`unsupported-jpeg2000.ome.tif` is deliberately NOT regenerated, for two reasons that both have
to be false before it should be:

1. It is not writer output and cannot be. `write_ome_tiff` REFUSES a lossy codec
   (`spatial_declarations.LOSSY_CODECS`), which is exactly the property the fixture exists to
   exercise -- it stands for a raw VENDOR file reaching the reader, never for one of ours. #227
   changed `write_ome_tiff`; it cannot have changed a file that function refuses to produce.
2. It was already TILED at {tile[1]}x{tile[0]} before #227, so there is no stripped-vs-tiled
   drift in it to correct.

Re-cutting it WOULD move `pixel-oracle.json`'s `jpeg2000_first_subifd_offset` and
`jpeg2000_byte_length`, which are pure byte offsets into these bytes, and the JPEG-2000
encoder's output is not stable across `imagecodecs` versions the way the deflate path is. Since
the file is not a producer sample, that trade buys nothing.

The recipe, every parameter READ OUT OF THE COMMITTED FILE just now rather than recalled:

    import numpy as np, tifffile
    base = <{dtype} raster of shape {shape}>          # {len(levels)} level(s) in the committed file
    with tifffile.TiffWriter(dest, ome=True) as w:
        w.write(base, photometric="{photometric}", tile={tile},
                compression={compression}, subifds={len(levels) - 1})   # {compression} = JPEG-2000
        for level in <the halvings>:
            w.write(level, photometric="{photometric}", tile={tile},
                    compression={compression}, subfiletype=1)

`imagecodecs` supplies the encoder `tifffile` reaches for at that compression id.""")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="re-emit to a temp dir and prove reproducibility; write nothing")
    parser.add_argument("--jpeg2000", action="store_true",
                        help="print why unsupported-jpeg2000.ome.tif is not regenerated, and its recipe")
    parser.add_argument("--oracle", action="store_true",
                        help="re-derive pixel-oracle.json from the committed fixtures (honours --check)")
    args = parser.parse_args()
    if args.jpeg2000:
        return jpeg2000_note()
    if args.oracle:
        return write_oracle(args.check)
    return regenerate(args.check)


if __name__ == "__main__":
    raise SystemExit(main())
