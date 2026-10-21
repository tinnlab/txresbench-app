#!/usr/bin/env python3
# ruff: noqa
"""#227 — the emitted OME-TIFF is TILED, and the proof is a MEASUREMENT of the file.

`write_ome_tiff` used to call `tifffile`'s `writer.write` with no `tile=`, and with no
`tile=` `tifffile` emits a STRIPPED TIFF. A strip is FULL IMAGE WIDTH by construction, so a
viewer fetching one viewport over HTTP range requests paid `imageWidth x stripHeight`
instead of `tile x tile` — however narrow the viewport. Measured on a real emitted artifact:
`RowsPerStrip=62`, 30 full-width strips; measured on the wire by the reader (#158): 14
ranged GETs for one 512x512 level-0 tile, nine of them consecutive full-width strips. ~2.7x
on a small fixture, ~80x on a whole-slide image.

#321 AMENDMENT — "nine", corrected from "ten" (found by #259; landed with #333's `libs/viz`
allowlist edit, because that guard asserts the stale sentence SURVIVES wherever it is
allowlisted). The decomposition is read out of the artifact #158 measured, kept byte-identical
as `spatial-image-hires-stripped.ome.tif` (167,778 B, `RowsPerStrip=62`, 30 strips): a 512-row
band spans NINE of its 62-row strips, at y=0 summing to 36,383 B, and every full band on that
file (y = 0, 512, 1024) spans nine — 36,383 / 36,390 / 36,444 B — so the correction does not
depend on which tile #158 read. 41,891 − 36,383 = 5,508 over 14 − 9 = 5 GETs is exactly this
file's measured open; ten would be 40,439 B and leave a 1,452-byte 4-GET open no measurement
of this reader produces. Seven strips cover 434 rows and eight cover 496, so neither reaches a
512-row band at all. `test_wire_measurement_strip_count.py` DERIVES that count from the
fixture's own tags rather than restating it, and holds every copy of this sentence under
`src-app/packages/` to it.

**Every assertion here reads the EMITTED FILE BACK.** None inspects `TiffWriter`'s
arguments, because #158's evidence was a request trace rather than a claim about arguments
and the fix is held to the same standard. In particular TEST-3 does not assert a tag: it
counts the bytes AND the pixels a ranged reader must drag in for one viewport, from the
file's own `TileByteCounts` / `StripByteCounts`, against a STRIPPED control written the
pre-fix way — so the evidence is a ratio, not a boolean.

The shape deliberately absent from this file is "the file still opens". That assertion
passes against the unfixed writer, which makes it no check at all.

## What the control is, and what a digest comparison here can and cannot prove

The control is not a copy of the writer. It is the writer, re-executed with one keyword
deleted: `_prefix_writer` parses this module's own `ome_writer.py`, removes the `tile=`
keyword from every `writer.write(...)` in `write_ome_tiff`, and execs the result.

That took four attempts, and the sequence is the lesson. (1) A hand-written `tifffile` call
that omitted `metadata=`, so TEST-5's "the bytes moved" assertion passed for the wrong reason.
(2) A guard comparing the copy's keyword NAMES to production's — a value swap left the suite
green while the headline ratio moved 4.00x to 16.00x. (3) The derivation, guarded by "the
surgery removed 2 keywords" — a surgery that ALSO removed `compression` kept the count at 2
and reproduced the identical 16.00x evasion. Each narrowed the evasion space; none closed it,
because each was still a DESCRIPTION of the edit. (4) What closes it is an oracle rather than
a description: the module is derived a second time with the tile filter OFF, and that identity
derivation must emit bytes indistinguishable from production's. Nothing the surgery does —
removing a second keyword, injecting one, an unparser that is not behaviour-preserving — can
survive that, because it is checked against production's own output rather than against a
statement about the edit.

A raw `sha256(file) != sha256(control)` proves NOTHING either way: `tifffile` stamps a fresh
random `UUID` into the OME-XML on every write, so two writes of identical pixels through
identical code already differ. TEST-5 demonstrates that explicitly and then asserts the
thing that is actually structural — the two files' pixel-data location tags are disjoint.
"""
import ast
import contextlib
import re
import types
import hashlib
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

_PACKAGES = Path(__file__).resolve().parents[2]
_SOURCE_PKG = _PACKAGES / "spatial-types"

#: The bare names this suite stages into `sys.modules`. Every one is restored afterwards —
#: three sibling packages ship files of these names and several of their suites read the
#: bare name at test time without re-staging, so leaving one of THIS package's copies (or,
#: worse, a sibling's copy loaded here by parametrization) installed under the bare name is
#: how a suite ends up asserting about another package's file. `doublet/tests/
#: doublet_fixtures.py` snapshots and restores for the same reason.
_STAGED = ("spatial_declarations", "ome_writer", "registration_qc")

#: `tifffile` stamps a fresh random UUID into the OME-XML on every write, so it is the one
#: thing that legally differs between two runs of identical code. Normalised away wherever
#: two emissions are compared.
_UUID = re.compile(r"urn:uuid:[0-9a-fA-F-]+")
_UUID_BYTES = re.compile(rb"urn:uuid:[0-9a-fA-F-]+")


@contextlib.contextmanager
def _restoring_sys_modules():
    saved = {name: sys.modules.get(name) for name in _STAGED}
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _exec_by_path(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def _staged_writer(package_dir):
    """`compute/ome_writer.py` by PATH, with its own sibling `spatial_declarations`.

    The idiom `spatial-import-visium/tests/test_package_registration.py::_load_ome_writer`
    documents: a dotted import is unavailable (a package directory named `spatial-types` is
    not an identifier), and three packages ship a file of this bare name, so loading by path
    is what guarantees the assertions are about the copy a given package SHIPS. The
    save/restore is this suite's own addition — see `_STAGED`.
    """
    with _restoring_sys_modules():
        SD = _exec_by_path(
            "spatial_declarations", package_dir / "compute" / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", package_dir / "compute" / "ome_writer.py")
        yield OW, SD


def _shipped_writers():
    """Every package that ships a `compute/ome_writer.py`, DERIVED by glob.

    Not a hand-written register, for the reason `test_vendored_contract.py` spells out: a
    guarantee a new consumer has to volunteer for is a courtesy, not a guarantee. That test
    asserts the copies are the same BYTES; TEST-1 asserts they all produce the same LAYOUT,
    which is the property a reader actually depends on.
    """
    return tuple(sorted(p.parents[1] for p in _PACKAGES.glob("*/compute/ome_writer.py")))


SHIPPED = _shipped_writers()
IDS = [p.name for p in SHIPPED]


def _placement(SD, arr):
    """The minimum legal placement for `arr` — the shape every image test here builds."""
    height, width = arr.shape[0], arr.shape[1]
    return SD.image_meta(space=SD.coordinate_space(
        space="t", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        extent={"width": width, "height": height},
    ))


def _noise(shape, seed=227, dtype=np.uint8):
    high = 255 if dtype == np.uint8 else 65535
    return np.random.default_rng(seed).integers(0, high, shape, dtype=dtype)


def _emit(OW, SD, dest, arr):
    return OW.write_ome_tiff(dest, arr, placement=_placement(SD, arr))


def _derive_writer(package_dir, *, drop_tile):
    """`ome_writer.py` re-executed with the `tile=` keyword optionally deleted.

    Returns `(module, removed)`. With `drop_tile=False` this is the IDENTITY derivation —
    the same parse/unparse/exec path, no edit — which is what makes the edited one
    checkable (see `_prefix_writer`).

    Two things worth knowing if this ever raises. The module is compiled from `ast.unparse`
    output, so a traceback out of the CONTROL points at line numbers in
    `<pre-#227 ome_writer>` that exist in no file on disk, and the module's comments are
    gone. And it is not registered in `sys.modules` — but the source it executes does
    `import spatial_declarations as SD` at module scope, so it must be called INSIDE
    `_staged_writer(package_dir)`; that precondition is asserted rather than assumed.
    """
    staged = sys.modules.get("spatial_declarations")
    expected = package_dir / "compute" / "spatial_declarations.py"
    assert staged is not None and Path(staged.__file__) == expected, (
        f"`spatial_declarations` is staged from {getattr(staged, '__file__', None)!r}, not "
        f"{expected}. Deriving a control outside its own package's stage binds it to a "
        "sibling's declarations — the failure `_STAGED` above exists to warn about."
    )
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    tree = ast.parse(source)
    function = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "write_ome_tiff"
    )
    removed = 0
    if drop_tile:
        for node in ast.walk(function):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "write"):
                before = len(node.keywords)
                node.keywords = [kw for kw in node.keywords if kw.arg != "tile"]
                removed += before - len(node.keywords)
    module = types.ModuleType("ome_writer_derived")
    module.__dict__["__file__"] = str(package_dir / "compute" / "ome_writer.py")
    exec(compile(ast.unparse(ast.fix_missing_locations(tree)), "<pre-#227 ome_writer>", "exec"),
         module.__dict__)
    return module, removed


def _prefix_writer(package_dir):
    """The writer minus `tile=`, DERIVED from the current source. The control.

    ## Why this is a derivation and not a hand-written copy

    Everything this file measures is measured against "the writer without `tile=`", so what
    that phrase resolves to is the load-bearing part. Three attempts, each broken by a blind
    audit, and the sequence is the point:

      1. a hand-written `tifffile` call that omitted `metadata=` — so the OME-XML differed
         too and TEST-5's "the bytes moved" assertion passed for the wrong reason;
      2. a guard comparing the copy's keyword NAMES against production's — so swapping
         `compression=CODEC` for another value left the suite green while the headline ratio
         moved 4.00x -> 16.00x;
      3. this derivation, guarded only by "the surgery removed 2 keywords" — so a surgery
         that ALSO removed `compression` (count still 2) reproduced the identical 16.00x
         evasion, and one that INJECTED `rowsperstrip=2048` did too.

    Each fix narrowed the evasion space and none closed it, because each was still a
    *description* of the edit. What closes it is not describing the edit at all: derive the
    module TWICE through the identical code path, once with the tile filter off, and require
    the unedited one to emit BYTES INDISTINGUISHABLE FROM PRODUCTION. That pins the whole
    AST transform — every keyword, added or removed, anywhere — against the only oracle that
    cannot be talked around, which is production's own output. `_identity_matches_production`
    below is that check, and it is why `removed` is now a diagnostic rather than the guard.
    """
    return _derive_writer(package_dir, drop_tile=True)


def _identity_matches_production(package_dir, SD, arr, tmp_path):
    """`(ok, detail)` — does the UNEDITED derivation emit what production emits?

    The oracle for the whole derivation. If parse/unparse/exec is not behaviour-preserving,
    or if the surgery function does anything at all beyond deleting `tile=`, the identity
    module's bytes diverge from production's and every measurement in this file is against
    something other than "production minus one argument".

    Compared modulo `tifffile`'s random per-file `UUID`, which is the only thing that legally
    differs between two runs of the same code.
    """
    identity, removed = _derive_writer(package_dir, drop_tile=False)
    if removed:
        return False, f"the identity derivation removed {removed} keyword(s); it must remove none"
    production = sys.modules["ome_writer"]
    a = production.write_ome_tiff(tmp_path / "oracle-prod.ome.tif", arr,
                                 placement=_placement(SD, arr))
    b = identity.write_ome_tiff(tmp_path / "oracle-identity.ome.tif", arr,
                                placement=_placement(SD, arr))
    left = _UUID_BYTES.sub(b"urn:uuid:X", Path(a).read_bytes())
    right = _UUID_BYTES.sub(b"urn:uuid:X", Path(b).read_bytes())
    if left == right:
        return True, "identical"
    return False, (f"{len(left):,} vs {len(right):,} bytes after UUID normalisation — the "
                   "derivation is not behaviour-preserving, so the control it produces is "
                   "not production minus one argument")


def _write_stripped_control(dest, arr, prefix, SD):
    """Emit `arr` through the DERIVED pre-fix writer — the production call minus `tile=`."""
    return prefix.write_ome_tiff(dest, arr, placement=_placement(SD, arr))


def _level_pages(handle):
    """The base page and every pyramid-level page, in resolution order."""
    return [level.pages[0] for level in handle.series[0].levels]


def _tag_names(page):
    return {tag.name for tag in page.tags.values()}


def _viewport_reads(page, x0, y0, width, height):
    """The ranged reads a viewer must issue to render `[x0,y0,width,height]` of `page`.

    Returns `(span_count, byte_total, pixel_total)`, modelled from the page's OWN tags — the
    same thing #158 counted on the wire, computed from the file instead of from a proxy. A
    tiled page answers a viewport with the tiles it overlaps; a stripped page has no
    horizontal subdivision at all, so it answers with WHOLE FULL-WIDTH strips.

    `pixel_total` is the structural half and does not depend on how well the codec did: it
    is the number of PIXELS the reader is forced to drag in. The byte total is what actually
    crosses the wire. Both are reported because the second can flatter a stripped layout on
    compressible data while the first cannot.

    Indices are CLAMPED to the grid. Without the clamp an overhanging viewport silently
    indexes into the next tile ROW (`ty * across + tx` with `tx >= across` is still a valid
    offset into the flat array) and this function returns a plausible wrong number — which,
    in the one place that measures the whole point of the change, is the worst available
    failure mode.
    """
    def span(v0, extent, step, cells):
        """The inclusive `[first, last]` cell range a `[v0, v0+extent)` interval touches.

        CLAMPED AT BOTH ENDS, and empty when the interval misses the axis entirely. Only the
        upper end was clamped at first, which let a viewport hanging off the right edge index
        into the NEXT TILE ROW (`ty * across + tx` with `tx >= across` is still a valid offset
        into the flat count array) and return a plausible wrong number — the worst available
        failure mode in the one function that measures the point of this change. Clamping only
        the upper end also left the two branches DISAGREEING for a viewport wholly outside the
        image: the tiled branch charged one cell, the stripped branch charged none.
        """
        if v0 + extent <= 0 or v0 >= step * cells:
            return range(0)
        first = max(v0, 0) // step
        last = min((min(v0 + extent, step * cells) - 1) // step, cells - 1)
        return range(first, last + 1)

    if page.is_tiled:
        tw, tl = page.tilewidth, page.tilelength
        counts = page.tags["TileByteCounts"].value
        across = -(-page.imagewidth // tw)
        down = -(-page.imagelength // tl)
        cells = [(ty, tx)
                 for ty in span(y0, height, tl, down)
                 for tx in span(x0, width, tw, across)]
        byte_total = int(sum(counts[ty * across + tx] for ty, tx in cells))
        return len(cells), byte_total, len(cells) * tw * tl
    rows = page.rowsperstrip
    counts = page.tags["StripByteCounts"].value
    strips = list(span(y0, height, rows, len(counts)))
    byte_total = int(sum(counts[s] for s in strips))
    return len(strips), byte_total, len(strips) * rows * page.imagewidth


# ── TEST-1 [acceptance] [invariant: INV-1] ───────────────────────────────────────────
@pytest.mark.parametrize("package", SHIPPED, ids=IDS)
def test_every_shipped_copy_of_the_writer_emits_a_tiled_level_zero(package, tmp_path):
    """TEST-1 [acceptance] [invariant: INV-1] — level 0 is TILED at 512x512, in EVERY copy.

    INV-1: *"A tiled TIFF lets a viewer fetch `tileSize x tileSize`. A stripped one forces
    `imageWidth x stripHeight` — the full width of the image, every time, no matter how
    narrow the viewport."* The first half of that promise is unreachable unless the file
    carries `TileWidth`/`TileLength` at all, which is what this asserts, on the file rather
    than on the call.

    **This test's distinct job is the PARAMETRIZATION**, not the assertion: `ome_writer.py`
    is vendored into three packages, and a copy that missed the re-vendor fails here
    BEHAVIOURALLY rather than only on `test_vendored_contract.py`'s digest. TEST-2 owns the
    per-LEVEL claim and runs against the source of truth alone, so the two do not overlap.
    """
    import tifffile

    with _staged_writer(package) as (OW, SD):
        arr = _noise((900, 700, 3))
        dest = _emit(OW, SD, tmp_path / f"{package.name}.ome.tif", arr)

    with tifffile.TiffFile(dest) as handle:
        page = handle.series[0].levels[0].pages[0]
        assert page.is_tiled, (
            f"{package.name} emitted a STRIPPED level 0 (RowsPerStrip="
            f"{page.rowsperstrip}). A strip is full image width, so a viewport costs "
            "imageWidth x stripHeight — the defect #227 exists to close."
        )
        assert (page.tilewidth, page.tilelength) == (512, 512), (
            f"{package.name} tiles level 0 at {(page.tilewidth, page.tilelength)}; the "
            "reader requests 512x512 tiles (DEFAULT_OME_TIFF_LIMITS.tileSize), and any "
            "other edge makes one requested tile more or fewer than one ranged read"
        )
        # The declared extent is the IMAGE's, never the padded tile grid's — 900x700 pads
        # to a 1024x1024 tile grid on disk, and a reader that saw the padded extent would
        # read pad as pixels.
        assert (page.imagelength, page.imagewidth) == (900, 700)


# ── TEST-2 [acceptance] [invariant: INV-2] ───────────────────────────────────────────
def test_every_pyramid_level_is_tiled_the_same_way(tmp_path):
    """TEST-2 [acceptance] [invariant: INV-2] — the levels below level 0 are tiled too.

    INV-2, verbatim: *"Both this and the pyramid levels below it should be tiled
    consistently."* This is the half a level-0-only fix would leave open, and it is not
    cosmetic: `omeTiffPyramid.ts` reads `TileWidth` PER DIRECTORY, so a file tiled at level
    0 and stripped below it reports a different layout per level and a consumer would have
    to branch per level to read one image.

    The 1024x1024 source is chosen so the pyramid reaches 256x256 — a level SMALLER THAN
    ONE TILE, which is the edge case that usually breaks a tiled write and is guaranteed to
    exist in every pyramid by `PYRAMID_MIN_SIDE = 256`.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _noise((1024, 1024, 3))
        assert [tuple(l.shape[:2]) for l in OW.pyramid_levels(arr)] == [(512, 512), (256, 256)], (
            "the fixture does not produce the pyramid this test is about — the "
            "smaller-than-one-tile level is the whole point and must be present"
        )
        dest = _emit(OW, SD, tmp_path / "pyr.ome.tif", arr)

    with tifffile.TiffFile(dest) as handle:
        pages = _level_pages(handle)
        assert [(p.imagelength, p.imagewidth) for p in pages] == [
            (1024, 1024), (512, 512), (256, 256)
        ], "the levels did not land as SubIFDs of one series — the pyramid is not a pyramid"
        for index, page in enumerate(pages):
            assert page.is_tiled, (
                f"level {index} ({page.imagewidth}x{page.imagelength}) is STRIPPED "
                f"(RowsPerStrip={page.rowsperstrip}) while another level is tiled — a "
                "mixed-layout pyramid makes a consumer branch per level"
            )
            assert (page.tilewidth, page.tilelength) == (512, 512), (
                f"level {index} is tiled at {(page.tilewidth, page.tilelength)} rather than "
                "the same 512x512 as every other level"
            )
        # The levels are also marked REDUCEDIMAGE. `subifds=` is what makes them one series;
        # `subfiletype=1` is what says they are a resolution pyramid rather than N unrelated
        # sub-images, and dropping it changed no other assertion in this file, so it is
        # asserted here rather than left to the write call's comment.
        assert [bool(p.subfiletype & 1) for p in pages] == [False, True, True], (
            "the pyramid levels are not marked REDUCEDIMAGE (subfiletype bit 0), so a "
            "generic OME reader cannot tell an overview level from a second image"
        )
        # Anti-vacuity: the last level really IS smaller than one tile on both axes, so the
        # loop above genuinely exercised the padded case rather than three full-tile levels.
        assert pages[-1].imagewidth < pages[-1].tilewidth
        assert pages[-1].imagelength < pages[-1].tilelength


# ── TEST-3 [acceptance] [invariant: INV-1] ───────────────────────────────────────────
def test_one_viewport_costs_one_tile_and_not_a_band_of_full_width_strips(tmp_path):
    """TEST-3 [acceptance] [invariant: INV-1] — the MEASUREMENT, not the tag.

    #158's evidence was a request trace: 14 ranged GETs, 41,891 of 167,778 bytes for one
    512x512 level-0 tile, nine of them consecutive full-width strips (#321 amendment,
    corrected from "ten"; the arithmetic is in this module's docstring and is DERIVED from the
    fixture by `test_wire_measurement_strip_count.py`). The fix is held to the
    same standard here — the reads one 512x512 viewport costs are counted from each file's
    own tags, for the PRODUCTION artifact and for a same-pixels STRIPPED control written the
    pre-fix way.

    Two bounds, deliberately of different kinds:

      * **PIXELS is the structural one and is exact.** The image is 2048 px wide, a strip is
        full width by construction, and the viewport is 512 rows tall, so a stripped read
        drags in at least `2048 x 512` = 4x the `512 x 512` a tiled read needs, whatever
        `RowsPerStrip` `tifffile`'s heuristic picks. Stated plainly: once the control is
        known to be stripped, that inequality FOLLOWS — it is a derivation that documents
        the structural factor, not an independent check, and it is asserted so the factor
        is visible in the file rather than only in this docstring. What IS independent is
        the assertion just below it that the control's strips really do span the full image
        width, which is the property "a strip is full width" actually names.
      * **BYTES is what actually crosses the wire** and depends on how well the codec did.
        The fixture is deliberately incompressible noise, so bytes track pixels here to
        within 0.005% and the 3x floor has ~1.3x of headroom; on smooth data the byte ratio
        falls (measured ~2.8x on a sparse tissue-like fixture) while the PIXEL ratio stays
        at 4x. That is exactly why the pixel figure is the structural one — and why this
        leg's floor is stated against THIS fixture rather than as a claim about the writer.
        Both are PRINTED so a drift shows up in the log rather than being absorbed.

    Against the pre-fix writer both files are the same layout and both ratios are 1.0.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        prefix, removed = _prefix_writer(_SOURCE_PKG)
        assert removed == 2, (
            f"the control was derived by removing {removed} `tile=` argument(s), not the "
            "expected 2. `write_ome_tiff` has exactly two `writer.write(...)` sites — TEST-6 "
            "owns that structural claim and will say so more precisely — and a control that "
            "removed none is a no-op that makes every ratio below 1.0"
        )
        arr = _noise((2048, 2048))
        tiled = _emit(OW, SD, tmp_path / "tiled.ome.tif", arr)
        stripped = _write_stripped_control(tmp_path / "stripped.ome.tif", arr, prefix, SD)

    viewport = (512, 512, 512, 512)  # one tile-aligned 512x512 viewport of level 0
    with tifffile.TiffFile(tiled) as handle:
        tiled_spans, tiled_bytes, tiled_pixels = _viewport_reads(handle.pages[0], *viewport)
    with tifffile.TiffFile(stripped) as handle:
        control = handle.pages[0]
        assert not control.is_tiled, "the control must be STRIPPED or it proves nothing"
        strip_spans, strip_bytes, strip_pixels = _viewport_reads(control, *viewport)
        rows_per_strip = control.rowsperstrip
        control_width = control.imagewidth
        control_strips = len(control.tags["StripByteCounts"].value)

    ratio = strip_bytes / tiled_bytes
    print(
        f"\n#227 viewport cost, one 512x512 level-0 tile of a 2048x2048 image:\n"
        f"  tiled    : {tiled_spans:2d} ranged span(s), {tiled_bytes:>9,} bytes, "
        f"{tiled_pixels:>10,} px\n"
        f"  stripped : {strip_spans:2d} ranged span(s), {strip_bytes:>9,} bytes, "
        f"{strip_pixels:>10,} px (RowsPerStrip={rows_per_strip})\n"
        f"  saved    : {ratio:.2f}x fewer bytes on the wire"
    )
    assert tiled_spans == 1, (
        f"a tile-aligned 512x512 viewport took {tiled_spans} ranged spans; on a 512-tiled "
        "file it is exactly one tile, which is the property that makes the reader's 512 "
        "request map to one range request"
    )
    assert tiled_pixels == 512 * 512
    # The independent half: the control's strips really are FULL IMAGE WIDTH. That is the
    # property "a strip is full width by construction" names, and it is what makes the
    # inequality below a statement about the layout rather than about arithmetic.
    assert control_width == 2048, (
        f"the control's page is {control_width} px wide, not the fixture's 2048 — the "
        "'a strip is the full image width' claim is about THIS width"
    )
    assert control_strips == -(-2048 // rows_per_strip), (
        f"the control has {control_strips} strips for a 2048-row image at "
        f"RowsPerStrip={rows_per_strip}; a strip that is NOT full image width would give a "
        "different count, and every 'the stripped layout drags in the full width' claim in "
        "this file rests on it being full width"
    )
    assert strip_pixels >= 4 * tiled_pixels, (
        f"the stripped control dragged in {strip_pixels:,} px for a viewport the tiled file "
        f"answers in {tiled_pixels:,}. On a 2048-wide image a full-width band 512 rows tall "
        "is 4x the viewport; this follows once the control is stripped, and is asserted so "
        "the structural factor is stated in the file rather than only in the docstring."
    )
    assert ratio > 3.0, (
        f"the stripped layout cost only {ratio:.2f}x the tiled layout for one viewport. "
        "On a 2048-wide image the structural factor is imageWidth/tileSize = 4x; a ratio "
        "near 1.0 means the production file is not actually tiled."
    )


# ── TEST-4 [acceptance] [invariant: INV-3] ───────────────────────────────────────────
@pytest.mark.parametrize("shape,dtype", [
    ((100, 80, 3), np.uint8),
    ((3, 3, 3), np.uint8),
    ((40, 600), np.uint8),
    ((200, 200), np.uint16),
], ids=["sub-tile-rgb", "degenerate", "narrow-grey", "uint16"])
def test_an_image_smaller_than_one_tile_is_still_written_and_still_read(shape, dtype, tmp_path):
    """TEST-4 [acceptance] [invariant: INV-3] — the sub-tile image, as a REQUIREMENT.

    INV-3, verbatim: *"A small image is a single-level pyramid — a legal OME-TIFF and the
    trivial case of the same reader."* An image narrower and/or shorter than one 512 tile is
    the common case, not a curiosity: a Visium lowres image is ~600 px, the committed hires
    fixture is 200x200, and `pyramid_levels` returns `[]` for anything at or under
    `PYRAMID_MIN_SIDE`. `tifffile` pads the single tile; what must remain true is that the
    file declares its TRUE extent, not the padded one, and round-trips bit-for-bit.

    `uint16` is in the matrix because it is the real Xenium morphology dtype — the case the
    module docstring says the OME-TIFF exists for — and every other shape here is `uint8`.

    The size leg is here because the writer's own comment makes a claim about what padding
    costs, and a claim in a comment is not a guarded fact. Measured against the corrected
    stripped control, the four matrix entries come in at 1.07x / 1.76x / 1.05x / 1.02x, and
    the 3x ceiling is where the DEGENERATE case (3x3, where the pad necessarily dominates a
    27-byte payload) crosses at `TILE = (1024, 1024)`. Stated precisely so the docstring
    does not overclaim: this leg discriminates on the degenerate case, not on the common
    one — at 1024 the common sub-tile shapes are still 1.17x / 1.06x / 1.05x — and in every
    mutation where it fires, TEST-1's exact `== (512, 512)` fires first. It is a floor under
    the comment's number, not a primary guard.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        prefix, _removed = _prefix_writer(_SOURCE_PKG)
        arr = _noise(shape, dtype=dtype)
        assert OW.pyramid_levels(arr) == [], "the premise is a single-level (trivial) pyramid"
        dest = _emit(OW, SD, tmp_path / "small.ome.tif", arr)
        control = _write_stripped_control(tmp_path / "small-stripped.ome.tif", arr, prefix, SD)

    with tifffile.TiffFile(dest) as handle:
        assert len(handle.series[0].levels) == 1
        page = handle.pages[0]
        assert page.is_tiled and (page.tilewidth, page.tilelength) == (512, 512)
        assert (page.imagelength, page.imagewidth) == (shape[0], shape[1]), (
            "the file declares the PADDED tile extent instead of the image's own — a "
            "consumer would read pad as pixels"
        )
        assert np.array_equal(handle.series[0].levels[0].asarray(), arr), (
            "a sub-tile image did not round-trip bit-for-bit through a tiled write"
        )

    with tifffile.TiffFile(control) as handle:
        assert not handle.pages[0].is_tiled, (
            "the control this ratio is measured against is itself tiled, so `grew` is 1.0 "
            "by construction and this leg proves nothing"
        )
    tiled_size, control_size = Path(dest).stat().st_size, Path(control).stat().st_size
    grew = tiled_size / control_size
    assert grew < 3.0, (
        f"tiling a {shape} {np.dtype(dtype).name} image grew it {grew:.2f}x over the "
        f"stripped equivalent ({control_size:,} -> {tiled_size:,} bytes). The pad is zeros "
        "under deflate and should stay cheap; a larger tile edge is what makes this bite."
    )


# ── TEST-5 [acceptance] [invariant: INV-4] ───────────────────────────────────────────
def test_the_change_moves_the_layout_and_leaves_every_pixel_identical(tmp_path):
    """TEST-5 [acceptance] [invariant: INV-4] — layout-only, proven both ways.

    INV-4, verbatim: *"Level 0 is always what this artifact IS, bit-for-bit, and the
    halvings below it are a viewer's overview."* Tiling is a change to how the pixels are
    PACKED, and this asserts that is all it is: every level of the production artifact
    equals the writer's own `pyramid_levels` output bit-for-bit, and the production file and
    a same-pixels stripped control decode to IDENTICAL pixels at every level while the two
    files locate those pixels through DISJOINT tag sets.

    **Why the structural claim rather than a digest.** The obvious assertion here would be
    `sha256(tiled) != sha256(stripped)`, and it would be worthless: `tifffile` stamps a
    fresh random `UUID` into the OME-XML on every write, so two writes of identical pixels
    through identical code already differ. That is DEMONSTRATED below rather than asserted
    around, because a hollow check in the one test the fixture dispositions rest on is worse
    than no check.

    What this establishes for those dispositions is the pair of facts that matter: the
    emitted artifact's byte LAYOUT changes (so anything pinning a digest or a byte offset
    must be found and re-recorded), and not one decoded pixel does (so a decoded-pixel
    golden is stable).
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _noise((1024, 900, 3))
        expected = [arr] + list(OW.pyramid_levels(arr))
        tiled = _emit(OW, SD, tmp_path / "tiled.ome.tif", arr)
        again = _emit(OW, SD, tmp_path / "tiled-again.ome.tif", arr)
        prefix, _removed = _prefix_writer(_SOURCE_PKG)
        stripped = _write_stripped_control(tmp_path / "stripped.ome.tif", arr, prefix, SD)

    with tifffile.TiffFile(tiled) as handle:
        assert [p.is_tiled for p in _level_pages(handle)] == [True] * len(expected)
        produced = [level.asarray() for level in handle.series[0].levels]
        tiled_tags = _tag_names(handle.pages[0])
    with tifffile.TiffFile(stripped) as handle:
        assert [p.is_tiled for p in _level_pages(handle)] == [False] * len(expected)
        control = [level.asarray() for level in handle.series[0].levels]
        strip_tags = _tag_names(handle.pages[0])

    assert len(produced) == len(expected) == len(control)
    for index, (got, want, ctrl) in enumerate(zip(produced, expected, control)):
        assert np.array_equal(got, want), (
            f"level {index} of the tiled artifact is not bit-for-bit what the writer's own "
            "pyramid_levels produced"
        )
        assert np.array_equal(got, ctrl), (
            f"level {index} decodes differently from the stripped control — tiling changed "
            "a PIXEL, which it must never do"
        )

    # THE STRUCTURAL CLAIM: the two files locate their pixels through disjoint tag sets.
    assert {"TileOffsets", "TileByteCounts"} <= tiled_tags
    assert not {"StripOffsets", "StripByteCounts", "RowsPerStrip"} & tiled_tags, (
        "the production artifact still carries strip tags — the layout must be one thing"
    )
    assert {"StripOffsets", "StripByteCounts"} <= strip_tags
    assert not {"TileOffsets", "TileByteCounts"} & strip_tags

    # AND the demonstration that a digest comparison here would prove nothing: two writes
    # of the same pixels through the SAME production path already differ, because tifffile
    # stamps a random per-file UUID into the OME-XML.
    first = hashlib.sha256(Path(tiled).read_bytes()).hexdigest()
    second = hashlib.sha256(Path(again).read_bytes()).hexdigest()
    assert first != second, (
        "two production writes of identical pixels produced identical bytes. If tifffile "
        "has become byte-deterministic, a digest comparison against the stripped control "
        "would be meaningful and this test should be strengthened to use one."
    )


# ── TEST-6 ───────────────────────────────────────────────────────────────────────────
def test_the_tile_is_a_named_constant_and_every_write_uses_it():
    """TEST-6 — `TILE` is named, legal, and passed at EVERY `writer.write` call site.

    A STATIC guard, and it earns its place by catching what a behavioural test structurally
    cannot: a reader cannot tell `tile=TILE` from `tile=(512, 512)` re-inlined at ONE of the
    two call sites — which is exactly how the two writes drift apart later. Read with `ast`
    rather than by string search, so a mention in a comment cannot satisfy it.

    The `len(writes) == 2` assertion is deliberate: a THIRD write appearing in this function
    should fail loudly here rather than ship untiled.
    """
    with _staged_writer(_SOURCE_PKG) as (OW, _SD):
        tile = OW.TILE
    assert tile == (512, 512), (
        f"TILE is {tile!r}; the reader requests 512x512 tiles "
        "(DEFAULT_OME_TIFF_LIMITS.tileSize), and any other edge makes one requested tile "
        "more or fewer than one ranged read"
    )
    assert all(side % 16 == 0 for side in tile), (
        "tifffile requires both tile dimensions to be multiples of 16"
    )

    source = (_SOURCE_PKG / "compute" / "ome_writer.py").read_text()
    tree = ast.parse(source)
    function = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "write_ome_tiff"
    )
    writes = [
        node for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute) and node.func.attr == "write"
    ]
    assert len(writes) == 2, (
        f"write_ome_tiff has {len(writes)} `.write(...)` call sites, not the expected two "
        "(level 0 and the pyramid levels) — re-check that each of them still tiles"
    )
    for call in writes:
        keyword = next((kw for kw in call.keywords if kw.arg == "tile"), None)
        assert keyword is not None, (
            f"a `writer.write(...)` at line {call.lineno} passes no `tile=` — tifffile then "
            "emits full-image-width STRIPS for that level (#227)"
        )
        assert isinstance(keyword.value, ast.Name) and keyword.value.id == "TILE", (
            f"the write at line {call.lineno} passes a tile that is not the module's `TILE` "
            "constant; the levels must not be able to drift apart"
        )


# ── TEST-7 ───────────────────────────────────────────────────────────────────────────
def test_the_production_reader_still_walks_a_tiled_pyramid(tmp_path, monkeypatch):
    """TEST-7 — the reader side, RUN rather than reasoned about (B7).

    `registration_qc.read_emitted_plane` is the ONLY Python reader of an EMITTED artifact:
    it re-opens the file from disk, recovers the placement from the OME-XML the artifact
    carries (the one channel that reaches a sandboxed consumer), walks
    `handle.series[0].levels` and picks the coarsest level under `ANALYSIS_PIXEL_BUDGET`.
    `.levels` is exactly the SubIFD machinery `tile=` composes with, so "it is
    layout-agnostic by inspection" is not good enough.

    **`ANALYSIS_PIXEL_BUDGET` is lowered for the duration.** At its shipped 64,000,000 a
    1024x1024 test image is 60x under budget, so the level loop breaks at index 0 and the
    SubIFD descent this test claims to exercise never runs — a phantom leg, not a test.
    Lowering the budget makes the reader DESCEND into the tiled SubIFDs, which is the
    behaviour under test; the production constant is not what is being asserted about.
    """
    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _noise((1024, 1024, 3))
        dest = _emit(OW, SD, tmp_path / "emitted.ome.tif", arr)
        expected_level_2 = OW.pyramid_levels(arr)[1]

        # `registration_qc` does `import spatial_declarations as SD` at module scope, so it
        # must be staged against ITS OWN package's copy. Loading it while spatial-types'
        # copy is installed under that bare name binds visium's reader to another package's
        # declarations — harmless only for as long as the vendored copies stay identical,
        # which is exactly the assumption `_staged_writer`'s docstring says not to make.
        _VISIUM = _PACKAGES / "spatial-import-visium"
        _exec_by_path("spatial_declarations", _VISIUM / "compute" / "spatial_declarations.py")
        registration_qc = _exec_by_path(
            "registration_qc", _VISIUM / "compute" / "registration_qc.py")
        # 256x256 (level 2) is the first level at or under this; 512x512 is 262,144.
        monkeypatch.setattr(registration_qc, "ANALYSIS_PIXEL_BUDGET", 100_000)

        plane, level_scale, info = registration_qc.read_emitted_plane(
            dest, {"width": 1024, "height": 1024}
        )

        assert info["pyramid_level"] == 2, (
            f"the reader stopped at level {info['pyramid_level']}; with the budget lowered "
            "it must DESCEND through the tiled SubIFDs, which is the walk under test"
        )
        assert plane.shape == (256, 256, 3), (
            f"the production reader returned {plane.shape} from a tiled SubIFD"
        )
        assert np.array_equal(plane, expected_level_2), (
            "the reader decoded a tiled SubIFD to something other than the level the "
            "writer put there"
        )
        assert level_scale == (0.25, 0.25)
        assert info["level_extent"] == {"width": 256, "height": 256}
        assert info["persisted_to_space"] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], (
            "the placement did not survive the round trip — the reader recovers it from the "
            "OME-XML this artifact carries, which is the one channel that reaches a "
            "sandboxed consumer, and `persisted_to_space` is None when that read fails"
        )

        # And the declaration itself, read back the way a sandboxed consumer reads it.
        import tifffile

        with tifffile.TiffFile(dest) as handle:
            placement = SD.require_placement(handle.ome_metadata, consumer="this test")
        assert placement["extent"] == {"width": 1024, "height": 1024}


# ── TEST-8 ───────────────────────────────────────────────────────────────────────────
def test_tiling_composes_with_the_bigtiff_container(tmp_path, monkeypatch):
    """TEST-8 — `tile=` on the BigTIFF branch, which no other test here reaches.

    `bigtiff=True` is a different offset-width path in `tifffile`, and `write_ome_tiff`
    selects it from `BIGTIFF_THRESHOLD_BYTES`. Every other test in this file writes a
    classic TIFF, so without this the tiled-BigTIFF combination — the multi-GB Xenium
    morphology image the module's own docstring says the OME-TIFF exists for — would ship
    unexercised. The threshold is lowered rather than materialising gigabytes, which is the
    idiom `spatial-import-visium/tests/test_image_robustness.py` already uses for the
    stripped case — through `monkeypatch`, so the restoration does not depend on
    `_exec_by_path` happening to build a fresh module object per stage.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _noise((1024, 1024, 3))
        # The NEGATIVE CONTROL first, at the shipped threshold. Without it this test's
        # premise — "every other test in this file writes a CLASSIC tiff, so this one adds
        # the BigTIFF path" — is asserted nowhere, and forcing `bigtiff=True` unconditionally
        # in the writer would leave the whole suite green.
        classic = _emit(OW, SD, tmp_path / "classic.ome.tif", arr)
        monkeypatch.setattr(OW, "BIGTIFF_THRESHOLD_BYTES", 1)
        dest = _emit(OW, SD, tmp_path / "big.ome.tif", arr)

    with tifffile.TiffFile(classic) as handle:
        assert not handle.is_bigtiff, (
            "the same array below the threshold already produced a BigTIFF, so this test is "
            "not adding the BigTIFF path to the suite's coverage — it is restating it"
        )
    with tifffile.TiffFile(dest) as handle:
        assert handle.is_bigtiff, "the threshold override did not select the BigTIFF branch"
        pages = _level_pages(handle)
        assert len(pages) == 3
        for index, page in enumerate(pages):
            assert page.is_tiled and (page.tilewidth, page.tilelength) == (512, 512), (
                f"BigTIFF level {index} is not tiled at 512x512"
            )
        assert np.array_equal(handle.series[0].levels[0].asarray(), arr)


# ── TEST-9 ───────────────────────────────────────────────────────────────────────────
def test_the_control_really_is_the_pre_fix_writer(tmp_path):
    """TEST-9 — the control is the production function minus `tile=`, RUN not compared.

    Every ratio in this file is measured against "the pre-fix writer", so what that phrase
    resolves to is load-bearing. Two earlier versions of this test were SYNTACTIC — they
    compared a hand-written control's arguments against production's — and a blind audit
    broke both, the second time by changing a keyword's VALUE while its NAME still matched.
    That is the unbounded-evasion-space shape: each round finds another spelling.

    So the control is no longer DESCRIBED. `_prefix_writer` derives it by deleting the
    `tile=` keyword from the real source and executing it, and this test pins the derivation
    against the only oracle that cannot be talked around — production's own output:

      1. **the identity oracle.** The same derivation is run a second time with the tile
         filter OFF, and its emitted bytes must be indistinguishable from production's
         (modulo tifffile's random per-file `UUID`). This is what pins the WHOLE AST
         transform: a surgery that also removed `compression`, or that injected
         `rowsperstrip=2048`, satisfies a keyword count and fails this.
      2. the surgery removed exactly TWO `tile=` arguments — kept as a DIAGNOSTIC, not as
         the guard, because a count can only see the filter it counts;
      3. the derived writer emits a genuinely STRIPPED pyramid where production emits a
         tiled one, which is the defect #227 describes;
      4. the two agree on decoded pixels at every level, on level count, and on OME-XML
         modulo the UUID. Stated narrowly: this covers `metadata=` and the pixel path, not
         every keyword — the identity oracle in (1) is what covers the rest.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        prefix, removed = _prefix_writer(_SOURCE_PKG)
        assert removed == 2, (
            f"deriving the pre-fix writer removed {removed} `tile=` argument(s), not 2. "
            "Production has exactly two `writer.write(...)` sites (TEST-6 pins that); if "
            "this number moves, the control is no longer 'production minus one argument' "
            "and every measurement in this file is against something else."
        )
        arr = _noise((1024, 900, 3))
        # THE ORACLE. `removed == 2` counts one filter's delta and cannot see a surgery that
        # also removes `compression`, or one that INJECTS `rowsperstrip=2048` — both were
        # demonstrated to move the headline ratio 4.00x -> 16.00x while every assertion in
        # this file stayed green. Running the UNEDITED derivation and requiring its bytes to
        # match production's pins the entire AST transform against production's own output.
        ok, detail = _identity_matches_production(_SOURCE_PKG, SD, arr, tmp_path)
        assert ok, (
            f"the IDENTITY derivation does not reproduce production: {detail}. The control "
            "is built by the same code path with one filter enabled, so if the unedited "
            "path already diverges, the control is not 'production minus one argument' and "
            "every ratio in this file is measured against something else."
        )
        tiled = _emit(OW, SD, tmp_path / "tiled.ome.tif", arr)
        stripped = _write_stripped_control(tmp_path / "stripped.ome.tif", arr, prefix, SD)

    def read(path):
        with tifffile.TiffFile(path) as handle:
            pages = _level_pages(handle)
            return ([p.is_tiled for p in pages],
                    [level.asarray() for level in handle.series[0].levels],
                    handle.ome_metadata)

    tiled_layout, tiled_levels, tiled_xml = read(tiled)
    strip_layout, strip_levels, strip_xml = read(stripped)

    assert tiled_layout == [True, True], "production did not emit a tiled pyramid"
    assert strip_layout == [False, False], (
        "the DERIVED pre-fix writer still emitted a tiled file. Removing `tile=` is what "
        "made tifffile write full-image-width strips before #227; if it no longer does, "
        "this control is not reproducing the defect and nothing in this file is measuring "
        "what it claims to."
    )
    assert len(tiled_levels) == len(strip_levels) == 2
    for index, (got, ctrl) in enumerate(zip(tiled_levels, strip_levels)):
        assert np.array_equal(got, ctrl), (
            f"level {index} differs between production and the pre-fix control — the two "
            "must differ ONLY in layout"
        )

    # The OME-XML must be identical once tifffile's random per-file UUID is normalised.
    # This is what the retired keyword comparison was reaching for (`metadata=` present and
    # equal), stated on the emitted bytes rather than on the writer's source text.
    def normalise(xml):
        return _UUID.sub("urn:uuid:X", xml or "")
    assert normalise(tiled_xml) == normalise(strip_xml), (
        "the production artifact and the pre-fix control carry different OME-XML. The only "
        "difference between them is supposed to be the pixel layout; a metadata difference "
        "means the control is not the same call, and every ratio measured against it is a "
        "comparison with something else."
    )


# ── TEST-10 ──────────────────────────────────────────────────────────────────────────
def test_the_tile_edge_is_pinned_to_the_size_the_reader_actually_requests():
    """TEST-10 — the CROSS-LANGUAGE pin, which is the one claim the whole issue rests on.

    #227's argument for 512 is not "512 is a nice number": it is that **one tile the viewer
    requests should be one TIFF tile and therefore one ranged read**. That argument spans
    two languages. Python asserts `TILE == (512, 512)` (TEST-6) and the reader's own suite
    asserts `DEFAULT_OME_TIFF_LIMITS.tileSize === 512` — and until this test, NOTHING tied
    the two. Change either constant alone and both suites stay green while the entire
    one-tile-one-request property silently breaks. Two blind audit angles named that gap.

    This reads the reader's SOURCE rather than importing it (there is no Python/TS bridge in
    a compute package's test), which is a real coupling and is the point: the writer's tile
    edge is not free to move on its own. If the reader's constant is renamed or relocated,
    this fails LOUDLY with the path, rather than skipping green — a pin that can silently
    stop pinning is not a pin.

    It does NOT reach into the reader to change anything; it only reads a committed product
    path, so it survives the `.lifecycle/` merge strip (rule B6).
    """
    reader = (_PACKAGES.parents[0] / "libs" / "viz" / "src" / "viz-core" / "spatial"
              / "omeTiffPyramid.ts")
    assert reader.is_file(), (
        f"{reader} is gone. It is where the reader declares the tile size it requests, and "
        "#227's whole argument for a 512 tile edge is that the writer matches it. If the "
        "reader moved, this pin has to move with it — deliberately, not by skipping."
    )
    source = reader.read_text()
    anchor = "DEFAULT_OME_TIFF_LIMITS"
    assert anchor in source, f"`{anchor}` is no longer declared in {reader.name}"
    block = source[source.index(anchor):]
    block = block[:block.index("}")]
    match = re.search(r"\btileSize\s*:\s*(\d+)", block)
    assert match, (
        f"could not read `tileSize` out of the reader's `{anchor}` block; the pin cannot "
        "silently stop pinning, so this is a failure rather than a skip"
    )
    requested = int(match.group(1))

    with _staged_writer(_SOURCE_PKG) as (OW, _SD):
        written = OW.TILE
    assert written == (requested, requested), (
        f"the writer tiles at {written} and the reader requests {requested}x{requested} "
        f"({anchor}.tileSize in {reader.name}). #227's argument for the tile edge is that "
        "one requested tile is ONE TIFF tile and therefore one ranged read; with these two "
        "numbers different, one request becomes several reads (or fetches pixels nobody "
        "asked for) and the fix's whole premise is gone. Move BOTH, deliberately, or "
        "neither."
    )


# ── TEST-11 ──────────────────────────────────────────────────────────────────────────
def test_the_measurement_instrument_is_correct_at_the_edges(tmp_path):
    """TEST-11 — `_viewport_reads` itself, on the cases TEST-3 never reaches.

    TEST-3 is the branch's headline measurement and it calls this helper exactly once, with
    a tile-aligned viewport wholly inside a 2048x2048 grid. Every other path through the
    function — overhanging, wholly outside, a width that is not a multiple of the tile, the
    stripped branch — was therefore unexercised, which is how the missing lower-bound clamp
    survived a whole audit round: the instrument was wrong in a direction nothing called.

    A 700x900 image is deliberately NOT a multiple of 512, so the grid is 2x2 with partial
    edge cells and `across`/`down` are actually load-bearing.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        prefix, _removed = _prefix_writer(_SOURCE_PKG)
        arr = _noise((900, 700, 3))
        tiled = _emit(OW, SD, tmp_path / "t.ome.tif", arr)
        stripped = _write_stripped_control(tmp_path / "s.ome.tif", arr, prefix, SD)

    with tifffile.TiffFile(tiled) as handle:
        page = handle.pages[0]
        assert (page.imagewidth, page.imagelength) == (700, 900)
        assert (page.tilewidth, page.tilelength) == (512, 512)  # -> a 2x2 grid, both partial

        # wholly inside the first tile
        assert _viewport_reads(page, 0, 0, 100, 100)[0] == 1
        # spanning the tile boundary on both axes -> all four cells
        assert _viewport_reads(page, 400, 400, 200, 200)[0] == 4
        # OVERHANGING the right edge: the grid has 2 columns, so 1 column is touched, not 2
        assert _viewport_reads(page, 600, 0, 400, 100)[0] == 1
        # OVERHANGING the bottom edge
        assert _viewport_reads(page, 0, 800, 100, 400)[0] == 1
        # WHOLLY OUTSIDE, right and below: nothing is fetched, and the byte total is 0
        assert _viewport_reads(page, 1024, 0, 100, 100) == (0, 0, 0)
        assert _viewport_reads(page, 0, 1024, 100, 100) == (0, 0, 0)
        # a NEGATIVE origin is clamped rather than wrapping to the end of the grid
        assert _viewport_reads(page, -400, -400, 500, 500)[0] == 1
        assert _viewport_reads(page, -1000, -1000, 100, 100) == (0, 0, 0)
        # the whole image is every cell, exactly once
        assert _viewport_reads(page, 0, 0, 700, 900)[0] == 4

    with tifffile.TiffFile(stripped) as handle:
        control = handle.pages[0]
        rows = control.rowsperstrip
        total = len(control.tags["StripByteCounts"].value)
        # The two branches must AGREE about a viewport that misses the image, or the ratio
        # TEST-3 reports is a comparison between two different questions.
        assert _viewport_reads(control, 0, 1024, 100, 100) == (0, 0, 0)
        assert _viewport_reads(control, 0, 0, 700, 900) == (
            total, sum(control.tags["StripByteCounts"].value), total * rows * 700
        )
        assert _viewport_reads(control, 0, 0, 1, 1)[0] == 1
