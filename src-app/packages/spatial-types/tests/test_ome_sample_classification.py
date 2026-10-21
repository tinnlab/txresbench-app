#!/usr/bin/env python3
# ruff: noqa
"""#266 — the emitted OME-XML describes the image that was actually written.

`write_ome_tiff` classified `photometric` with one equality on one dimension:

    photometric = "rgb" if arr.ndim == 3 and arr.shape[2] == 3 else "minisblack"

`read_image` accepts any TIFF series whose axes are `YX` or `YXS`, and
`xenium_image.read_plane` accepts `YXS` too. **`YXS` does not mean `S == 3`.** For every other
sample count that expression fell through to `minisblack` with no `planarconfig`, and
`tifffile`'s `photometricsamples == 1` branch then reads `width = shape[-1]` — TAKING THE SAMPLE
AXIS FOR X and the rows for separate channel planes. Measured on `(900, 700, 4)` uint8, the
emitted OME-XML said `SizeX="4" SizeY="700" SizeC="900"`.

**The shape deliberately absent from this file is "the file opens".** The pixels ALWAYS
round-tripped — `asarray()` returned the input before the fix and after it — so a test that
asserts no exception, or asserts the decode, PASSES AGAINST THE BROKEN WRITER and is no check at
all. Every assertion here parses the emitted `<Pixels>` element and holds it against the input
SHAPE, which is the quantity that was wrong.

That standard is not self-certified either. TEST-7 re-derives this module's own
`write_ome_tiff` with the classification REVERTED to the pre-fix expression and asserts the
acceptance assertion goes RED against it — so "these tests prove the fix" is a measurement of
the old code rather than a claim about the new. And the surgery that produces that control is
itself held to an oracle (`test_the_identity_derivation_is_indistinguishable_from_production`):
derived with the revert OFF it must emit bytes indistinguishable from production's, which is
what stops a botched unparse from quietly making every comparison meaningless. Both ideas are
lifted from the sibling `test_ome_tile_layout.py`, whose docstring records the four attempts it
took to get a control right.

Everything is parametrized over EVERY package that ships a `compute/ome_writer.py`, discovered
by glob. Stated honestly: TEST-8 in this same file asserts those copies are byte-identical, so
GIVEN that assert the behavioural parametrization is redundant and one mutation kills all three
legs at once. It is kept as defence in depth — the byte guard is the thing that would be
narrowed or deleted first (a guard of that name exists in two other packages and is scoped
differently in each), and a behavioural assertion survives its removal.
"""
import ast
import contextlib
import hashlib
import importlib.util
import re
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import image_boundary_guards as IBG  # noqa: E402

_PACKAGES = Path(__file__).resolve().parents[2]
_SOURCE_PKG = _PACKAGES / "spatial-types"

#: The bare names staged into `sys.modules`, restored afterwards. Three sibling packages ship
#: files of these names and several of their suites read the bare name at test time without
#: re-staging, so leaving one copy installed under the bare name is how a suite ends up
#: asserting about another package's file. Copied from `test_ome_tile_layout.py::_STAGED`.
_STAGED = ("spatial_declarations", "ome_writer")

#: `tifffile` stamps a fresh random UUID into the OME-XML on every write, so it is the one thing
#: that legally differs between two runs of identical code. Normalised away wherever two
#: emissions are compared as bytes.
_UUID_BYTES = re.compile(rb"urn:uuid:[0-9a-fA-F-]+")

#: `origin/main`'s classification, spelled out so the control is READABLE rather than described.
#: The transform below replaces the `_sample_layout` call with exactly this: the old photometric
#: expression, no `planarconfig`, no `extrasamples`, and no `S == 1` reshape — which is the whole
#: of what this branch changed.
_PRE_FIX_ASSIGN = (
    'arr, photometric, extrasamples = ('
    'arr, ("rgb" if arr.ndim == 3 and arr.shape[2] == 3 else "minisblack"), None)'
)

#: A source small enough to keep the suite fast and NON-SQUARE, because on a square image a
#: swapped width/height pair is indistinguishable from a correct one — the reason `extent_of`'s
#: own docstring gives for demanding a non-square fixture.
_H, _W = 300, 220

#: Big enough that `pyramid_levels` builds a real level below level 0 (`PYRAMID_MIN_SIDE = 256`
#: needs a shorter side of at least 512 to halve once), so INV-4 has something to be about.
_PYRAMID_H, _PYRAMID_W = 1100, 900


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

    A dotted import is unavailable (a directory named `spatial-types` is not an identifier) and
    three packages ship a file of this bare name, so loading by path is what guarantees the
    assertions are about the copy a given package SHIPS.
    """
    with _restoring_sys_modules():
        SD = _exec_by_path(
            "spatial_declarations", package_dir / "compute" / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", package_dir / "compute" / "ome_writer.py")
        yield OW, SD


def _shipped_writers():
    """Every package shipping a `compute/ome_writer.py`, DERIVED by glob rather than listed.

    `test_vendored_contract.py` states the reason: a guarantee a new consumer has to volunteer
    for is a courtesy, not a guarantee. A FLOOR is asserted separately (TEST-8) so a copy that
    VANISHED is a package that stopped being covered.
    """
    return tuple(sorted(p.parents[1] for p in _PACKAGES.glob("*/compute/ome_writer.py")))


SHIPPED = _shipped_writers()
IDS = [p.name for p in SHIPPED]


class _RevertClassification(ast.NodeTransformer):
    """Replace `arr, photometric, ... = _sample_layout(arr)` with `origin/main`'s expression.

    `revert=False` still WALKS the whole tree and still unparses; it just declines that one
    substitution. That is deliberate and is what makes TEST-11 an oracle rather than a
    tautology — see `_derive_writer`.
    """

    def __init__(self, revert):
        self.revert = revert
        self.hits = 0

    def visit_Assign(self, node):
        value = node.value
        if (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
                and value.func.id == "_sample_layout"):
            self.hits += 1
            if self.revert:
                return ast.parse(_PRE_FIX_ASSIGN).body[0]
        return self.generic_visit(node)


def _derive_writer(package_dir, *, revert):
    """`ome_writer.py` re-executed, optionally with the classification reverted to pre-fix.

    Not a hand-written copy of the writer. It is THE writer, re-executed with one statement
    swapped — so the control cannot drift from production in any other keyword (the failure mode
    `test_ome_tile_layout.py` paid three attempts to close). `revert=False` is the IDENTITY
    derivation and is the oracle that the surgery machinery itself is behaviour-preserving.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    # BOTH paths go through the SAME transformer and the SAME unparse. If the transformer ever
    # grows a second, unintended rewrite (a `visit_Call` that drops a keyword, say), that
    # rewrite lands on the identity derivation too and TEST-11 goes red. Guarding the surgery
    # behind `if revert:` instead would make TEST-11 compare `ast.parse(source)` against
    # `source` — true by construction of CPython, and blind to anything the transformer does.
    transformer = _RevertClassification(revert)
    tree = transformer.visit(ast.parse(source))
    ast.fix_missing_locations(tree)
    assert transformer.hits == 1, (
        f"the surgery found {transformer.hits} `_sample_layout(...)` assignment(s), not exactly "
        "1. A surgery that matched nothing produces a control identical to production, and "
        "every comparison against it then passes for the wrong reason."
    )
    tree = ast.parse(ast.unparse(tree))
    with _restoring_sys_modules():
        SD = _exec_by_path(
            "spatial_declarations", package_dir / "compute" / "spatial_declarations.py")
        module = importlib.util.module_from_spec(
            importlib.util.spec_from_loader("ome_writer_derived", loader=None))
        module.__file__ = str(package_dir / "compute" / "ome_writer.py")
        sys.modules["ome_writer"] = module
        exec(compile(tree, module.__file__, "exec"), module.__dict__)
        yield_value = (module, SD)
        return yield_value


def _placement(SD, arr):
    """The minimum legal placement for `arr` — the shape every image test here builds."""
    return SD.image_meta(space=SD.coordinate_space(
        space="t", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        extent={"width": int(arr.shape[1]), "height": int(arr.shape[0])},
    ))


def _sample_varying(shape, dtype=np.uint8):
    """Deterministic pixels that DIFFER ALONG EVERY AXIS, samples included.

    A constant plane, or one constant across the sample axis, would round-trip byte-for-byte
    even if the samples were transposed into rows — so the data itself has to distinguish the
    axes for the pixel-equality assertions to mean anything.
    """
    weights = (7, 13, 29)[: len(shape)]
    value = np.zeros(shape, dtype=np.int64)
    for axis, (length, weight) in enumerate(zip(shape, weights)):
        ramp = np.arange(length, dtype=np.int64) * weight
        value += ramp.reshape([-1 if i == axis else 1 for i in range(len(shape))])
    return (value % 251).astype(dtype)


def _pixels(OW, SD, dest, arr):
    return OW.write_ome_tiff(dest, arr, placement=_placement(SD, arr))


def _ome_sizes(path):
    """`(SizeX, SizeY, SizeC)` as the emitted file's own OME-XML declares them.

    Read out of the file, never off the writer's arguments: #158's evidence for the sibling
    issue was a measurement of the artifact, and this one is held to the same standard.
    """
    import tifffile

    with tifffile.TiffFile(str(path)) as handle:
        xml = handle.ome_metadata
    assert xml, f"{path} carries no OME-XML at all"
    pixels = re.search(r"<Pixels[^>]*>", xml)
    assert pixels, f"{path}'s OME-XML has no <Pixels> element:\n{xml[:400]}"
    attrs = pixels.group(0)

    def _attr(name):
        found = re.search(name + r'="([^"]*)"', attrs)
        assert found, f"{path}'s <Pixels> declares no {name}: {attrs}"
        return int(found.group(1))

    return _attr("SizeX"), _attr("SizeY"), _attr("SizeC")


def _normalised_bytes(path):
    return _UUID_BYTES.sub(b"urn:uuid:X", Path(path).read_bytes())


#: Every sample count this writer EMITS, `None` being the plain 2-D plane. `1` and `4` are the
#: arms this branch fixed; `None` and `3` are the SHIPPED shapes and are here as the controls
#: that they did not move.
_SAMPLES = (None, 1, 3, 4)

#: Every sample count this writer REFUSES, and the reason it does is the READER's documented
#: contract, not a preference. See `ome_writer.READABLE_SAMPLE_COUNTS` and TEST-12.
_REFUSED_SAMPLES = (2, 5, 6, 8)

#: The dtypes swept alongside the sample count. `uint8` is what every committed fixture is;
#: `uint16` is what the Xenium morphology plane this module exists for actually is, and a suite
#: that only ever writes `uint8` cannot see a bit-depth interaction at all. `bool` gets its own
#: test (TEST-14) because it is the one dtype `tifffile` cannot write with multiple samples.
_DTYPES = (np.uint8, np.uint16)


def _shaped(samples, h=_H, w=_W):
    return (h, w) if samples is None else (h, w, samples)


def _expected_sizes(samples):
    """`SizeX`/`SizeY`/`SizeC` the OME-XML MUST declare — the truth, derived from the input."""
    return _W, _H, 1 if samples is None else samples


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", _SAMPLES, ids=[str(s) for s in _SAMPLES])
@pytest.mark.parametrize("dtype", _DTYPES, ids=[np.dtype(d).name for d in _DTYPES])
def test_the_emitted_ome_declares_the_true_extent_and_sample_count(
        package_dir, samples, dtype, tmp_path):
    """TEST-1 (INV-1) — `SizeX`/`SizeY`/`SizeC` equal the width, height and samples written.

    The whole defect in one assertion. On `origin/main` this goes RED for `samples` in
    `{1, 2, 4, 5}`: the writer emitted `SizeX=samples`, `SizeY=220`, `SizeC=300` — the sample
    axis mistaken for X, and every row promoted to a channel. TEST-7 demonstrates that redness
    against a control rather than asserting it here.

    Non-square on purpose: at 300x220 a swapped width/height is visible, at 300x300 it is not.
    """
    arr = _sample_varying(_shaped(samples), dtype=dtype)
    with _staged_writer(package_dir) as (OW, SD):
        dest = _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    assert _ome_sizes(dest) == _expected_sizes(samples), (
        f"the emitted OME-XML describes a different image from the {arr.shape} array that was "
        "written. The pixels round-trip either way, so nothing errors — but every OME-aware "
        "consumer reads these three numbers."
    )


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (1, 2, 3, 4, 5, 6, 7, 8))
def test_the_trailing_axis_is_written_as_samples_never_as_channel_planes(
        package_dir, samples, tmp_path):
    """TEST-2 (INV-2) — `YXS` does not mean `S == 3`, swept rather than spot-checked.

    Every sample count gets an EXPLICIT arm; none falls through to a default written for
    another. The observable form of that is the emitted series' axis order: `YX` for one sample
    (which IS a plain plane) and `YXS` for every other count — NEVER `CYX`, which is what
    `tifffile` produces when it is told a `(H, W, S)` is a stack of `H` planes.

    Swept to 8 deliberately. A rule that only holds for the counts someone thought of is the
    same rule that was already here.
    """
    import tifffile

    arr = _sample_varying(_shaped(samples))
    with _staged_writer(package_dir) as (OW, SD):
        if samples not in OW.READABLE_SAMPLE_COUNTS:
            # The other half of the same rule, and the half that would otherwise be untested: a
            # sample count outside the reader's contract is REFUSED, never emitted as a
            # correctly-headed file this system's own viewer renders as sample 0. TEST-12 owns
            # the reasoning; this leg keeps the sweep exhaustive rather than selective.
            with pytest.raises(OW.ImageConversionError):
                _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
            return
        dest = _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    with tifffile.TiffFile(str(dest)) as handle:
        axes = str(handle.series[0].axes)
    assert axes == ("YX" if samples == 1 else "YXS"), (
        f"a {arr.shape} array was written as axes {axes!r}. `CYX` means the sample axis was "
        "read as X and the rows as separate channel planes."
    )
    assert _ome_sizes(dest) == _expected_sizes(samples)


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", _SAMPLES, ids=[str(s) for s in _SAMPLES])
@pytest.mark.parametrize("dtype", _DTYPES, ids=[np.dtype(d).name for d in _DTYPES])
def test_the_classification_moves_the_header_and_never_a_pixel(
        package_dir, samples, dtype, tmp_path):
    """TEST-3 (INV-3) — what decodes back out equals what was handed in, bit-for-bit.

    The control on the fix, not a restatement of the defect: this assertion passed BEFORE the
    change too (which is exactly why nothing noticed), and it must keep passing after. The
    pixels vary along every axis including the sample axis, so a transposition could not
    survive it silently.

    The `(H, W, 1)` input is compared against its `(H, W)` normalisation, because one sample per
    pixel IS a plain plane and that is now what the file says it is.
    """
    arr = _sample_varying(_shaped(samples), dtype=dtype)
    expected = arr.reshape(arr.shape[:2]) if samples == 1 else arr
    with _staged_writer(package_dir) as (OW, SD):
        dest = _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    import tifffile

    with tifffile.TiffFile(str(dest)) as handle:
        decoded = handle.series[0].asarray()
    assert decoded.shape == expected.shape
    assert decoded.dtype == expected.dtype
    assert np.array_equal(decoded, expected), (
        "the emitted pixels differ from the input; a classification change must move the "
        "header and nothing else"
    )


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", _SAMPLES, ids=[str(s) for s in _SAMPLES])
@pytest.mark.parametrize("dtype", _DTYPES, ids=[np.dtype(d).name for d in _DTYPES])
def test_every_pyramid_level_carries_the_same_classification_as_level_zero(
        package_dir, samples, dtype, tmp_path):
    """TEST-4 (INV-4) — one image, one description, at every level.

    #227 put `tile=` on BOTH `writer.write` calls for this reason and said why: a file tiled at
    level 0 and stripped below it reports a different layout per level, so a consumer has to
    branch per level to read one image. `photometric`, `planarconfig` and `extrasamples` travel
    with it or the same thing happens one tag over — a pyramid whose overview is a different
    kind of image from its base.

    Asserted on a source large enough for `pyramid_levels` to actually build a level, and the
    level count is asserted too: with no level below, this test would pass vacuously.

    **What this can and cannot catch, measured.** OMITTING a keyword from the level write is an
    EQUIVALENT mutation — `tifffile` infers the same photometric from a trailing axis of 3 or 4,
    and derives the same ExtraSamples — so this test stays green through it and that is stated
    rather than implied. What it does catch is the level write CONTRADICTING level 0:
    hardcoding `photometric="minisblack"` on the level write turns it RED. INV-4 is the promise
    that no consumer has to branch per level, and a contradiction is the only way to break it
    that `tifffile` will actually let through.
    """
    import tifffile

    arr = _sample_varying(_shaped(samples, _PYRAMID_H, _PYRAMID_W), dtype=dtype)
    with _staged_writer(package_dir) as (OW, SD):
        dest = _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    with tifffile.TiffFile(str(dest)) as handle:
        series = handle.series[0]
        levels = list(series.levels)
        assert len(levels) >= 2, (
            f"{arr.shape} produced {len(levels)} level(s); this test needs a real pyramid or it "
            "asserts nothing about levels"
        )
        pages = [level.pages[0] for level in levels]
        base = pages[0]
        for index, page in enumerate(pages[1:], start=1):
            assert page.photometric == base.photometric, (
                f"level {index} is photometric {page.photometric!r} but level 0 is "
                f"{base.photometric!r}")
            assert page.samplesperpixel == base.samplesperpixel, (
                f"level {index} has {page.samplesperpixel} samples/pixel but level 0 has "
                f"{base.samplesperpixel}")
            assert page.planarconfig == base.planarconfig
            assert tuple(page.extrasamples) == tuple(base.extrasamples)
        sizes = [(page.imagelength, page.imagewidth) for page in pages]
    for above, below in zip(sizes, sizes[1:]):
        assert below == (above[0] // 2, above[1] // 2), (
            f"levels {sizes} are not a halving pyramid")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_a_zero_sample_array_is_refused_by_name(package_dir, tmp_path):
    """TEST-5 (INV-5) — refusing rather than guessing, and refusing in the caught taxonomy.

    `read_image`'s own axis-order check states the rule: *"Refusing rather than guessing."* A
    raster with an empty sample axis has no pixel and no photometric interpretation that
    describes one.

    Two things are asserted, and the second is the one that matters operationally. The message
    must NAME the shape — on `origin/main` this array reaches `tifffile` and returns
    `ValueError: truncate can only be used with imagej or shaped formats`, which tells a user
    nothing. And the type must be `ImageConversionError`, which is what BOTH importers'
    `emit_images` guards catch (`except (ome_writer.ImageConversionError,
    SD.SpatialDeclarationError, OSError)`), so the refusal costs one image and never the whole
    import. A bare `ValueError` escapes those guards.
    """
    arr = np.zeros((_H, _W, 0), dtype=np.uint8)
    with _staged_writer(package_dir) as (OW, SD):
        with pytest.raises(OW.ImageConversionError) as caught:
            _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    message = str(caught.value)
    assert f"({_H}, {_W}, 0)" in message, f"the refusal does not name the shape: {message}"
    assert not list(tmp_path.iterdir()), (
        f"a refused write left {[p.name for p in tmp_path.iterdir()]} behind")
    _assert_caught_by_the_importer_guards()


def _assert_caught_by_the_importer_guards():
    """Both importers' `emit_images` guards must NAME `ome_writer.ImageConversionError`.

    `issubclass(..., RuntimeError)` is what this used to assert, and it is NOT the claim. What
    makes a refusal cost one image instead of the whole import is that the type appears in the
    `except (...)` tuple the CALLER actually wrote — so that tuple is read out of the callers'
    source. Derived by glob rather than listed, for the reason `test_vendored_contract.py`
    gives: a guarantee a new consumer has to volunteer for is a courtesy, not a guarantee.
    """
    callers = [path for path in sorted(_PACKAGES.glob("*/compute/import_*.py"))
               if "ome_writer.write_ome_tiff" in path.read_text()]
    assert len(callers) >= 2, (
        "expected both importers to call `ome_writer.write_ome_tiff`, found "
        f"{[str(path) for path in callers]}")
    for caller in callers:
        # The PER-IMAGE guard, identified by what it GUARDS (it is the handler on the `try`
        # whose body calls `write_ome_tiff`) rather than by being the first `except (...)` in
        # the file — a second such handler now exists in `import_xenium.emit_image` and a
        # positional reader resolves the wrong one.
        #
        # THE ASSERTION IS THE WHOLE TUPLE, not that it contains `ImageConversionError`.
        # `importer_guard_names` only ever returns a handler whose spellings end in that name,
        # so checking for it could not fail; the claim worth making is the one this file's
        # docstring makes — the guard names the taxonomy the writer refuses in.
        guard = set(IBG.importer_guard_names(caller.read_text()))
        assert {"ome_writer.ImageConversionError", "SD.SpatialDeclarationError"} <= guard, (
            f"{caller} calls `write_ome_tiff` but no `except (...)` in it names "
            "`ome_writer.ImageConversionError`, so a refusal from the writer would abort the "
            "whole import instead of costing one image")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (None, 3), ids=["2d", "rgb"])
@pytest.mark.parametrize("size", ((_H, _W), (_PYRAMID_H, _PYRAMID_W)), ids=["flat", "pyramid"])
def test_the_shipped_shapes_emit_the_bytes_they_emitted_before(
        package_dir, samples, size, tmp_path):
    """TEST-6 — the change is a NO-OP for `(H, W)` and `(H, W, 3)`, measured not assumed.

    This is the executable form of "no committed fixture, golden, `PROVENANCE.json` or
    expected-hash needs regenerating". Every emitted artifact committed in this repo is one of
    these two shapes (`spatial-image-hires` / `spatial-image-lowres` are `(H, W, 3)` `YXS` RGB;
    `spatial-image-greyscale` is `(H, W)` `YX` MINISBLACK), so if these two shapes emit the same
    bytes, nothing pinned to them moved.

    Compared against the PRE-FIX classification, not against a recorded digest: a recorded digest
    would need regenerating on any unrelated `tifffile` upgrade and would prove nothing about
    what this branch did. The `urn:uuid` `tifffile` stamps freshly on every write is normalised
    away — it is the one thing that legally differs between two runs of identical code.
    """
    # Both a single-level and a MULTI-LEVEL source, because every emitted artifact this test
    # protects is a pyramid and a single-level comparison would not cover the level writes.
    arr = _sample_varying(_shaped(samples, *size))
    with _staged_writer(package_dir) as (OW, SD):
        production = _pixels(OW, SD, tmp_path / "production.ome.tif", arr)
    control, control_SD = _derive_writer(package_dir, revert=True)
    with _restoring_sys_modules():
        sys.modules["spatial_declarations"] = control_SD
        sys.modules["ome_writer"] = control
        before = _pixels(control, control_SD, tmp_path / "control.ome.tif", arr)
    assert _normalised_bytes(production) == _normalised_bytes(before), (
        f"a {arr.shape} array no longer emits the bytes it emitted before this change. Every "
        "committed emitted artifact in this tree is one of these two shapes, so this moving "
        "means the fixture corpus moved with it."
    )


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (1, 2, 4), ids=["s1", "s2", "s4"])
def test_the_pre_fix_classification_really_did_declare_the_sample_axis_as_x(
        package_dir, samples, tmp_path):
    """TEST-7 — TEST-1's assertion is shown to FAIL against the code this branch replaces.

    Without this, TEST-1 is a claim that the new code is right rather than a proof the old code
    was wrong — and "the file opens" was the shape of assertion that let this defect live. So
    the pre-fix expression is re-derived from this module's own source and run: it must declare
    `SizeX == samples`, i.e. the sample axis as the image width.

    The three counts are the ones the issue and the fix disagree about most: `1` (which the
    issue's own title excludes and which is broken all the same), `2` (a real vendor shape) and
    `4` (RGBA, where #227's tiling amplifies the cost ~4.8x).
    """
    arr = _sample_varying(_shaped(samples))
    control, control_SD = _derive_writer(package_dir, revert=True)
    with _restoring_sys_modules():
        sys.modules["spatial_declarations"] = control_SD
        sys.modules["ome_writer"] = control
        dest = _pixels(control, control_SD, tmp_path / "control.ome.tif", arr)
    size_x, size_y, size_c = _ome_sizes(dest)
    assert (size_x, size_y, size_c) == (samples, _W, _H), (
        "the pre-fix control did NOT reproduce the reported defect, so this suite is comparing "
        f"against something other than `origin/main`'s behaviour (got {(size_x, size_y, size_c)})"
    )
    assert (size_x, size_y, size_c) != _expected_sizes(samples)


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (None, 3), ids=["2d", "rgb"])
@pytest.mark.parametrize("size", ((_H, _W), (_PYRAMID_H, _PYRAMID_W)), ids=["flat", "pyramid"])
def test_the_identity_derivation_is_indistinguishable_from_production(
        package_dir, samples, size, tmp_path):
    """TEST-11 — the ORACLE on TEST-6/TEST-7's control, not a description of the surgery.

    A control produced by editing an AST is only evidence if the editing machinery is
    behaviour-preserving. `test_ome_tile_layout.py` records three attempts that each GUARDED the
    surgery with a DESCRIPTION of it (keyword names, a removed-keyword count) and each was
    evaded. What closes it is an oracle: derive the module a second time with the revert OFF and
    require bytes indistinguishable from production's.

    **This only works because `_derive_writer` runs the SAME transformer and the SAME unparse on
    both paths.** Guarding the surgery behind `if revert:` would make this test compare
    `ast.parse(source)` against `source`, which is true by construction of CPython and blind to
    everything the transformer does — worth naming, because the test would look identical and
    prove nothing. Measured: with the surgery so guarded, a transformer that ALSO stripped
    `tile=TILE` from every call left this test GREEN; running it on both paths turns it RED.
    """
    arr = _sample_varying(_shaped(samples, *size))
    with _staged_writer(package_dir) as (OW, SD):
        production = _pixels(OW, SD, tmp_path / "production.ome.tif", arr)
    identity, identity_SD = _derive_writer(package_dir, revert=False)
    with _restoring_sys_modules():
        sys.modules["spatial_declarations"] = identity_SD
        sys.modules["ome_writer"] = identity
        derived = _pixels(identity, identity_SD, tmp_path / "identity.ome.tif", arr)
    assert _normalised_bytes(production) == _normalised_bytes(derived), (
        "the identity derivation does not reproduce production's bytes, so the AST surgery is "
        "not behaviour-preserving and every comparison against a derived control is void"
    )


def test_every_shipped_copy_of_the_writer_is_covered_here():
    """TEST-8 — a FLOOR under the glob, so a copy that vanished is a package that lost cover.

    Derivation plus a floor, the shape `test_vendored_contract.py` argues for: a third consumer
    is discovered automatically, and the two known ones cannot silently drop out of the
    parametrization. Byte-identity is asserted there; BEHAVIOUR is asserted here, and the second
    is the property the first is a proxy for.
    """
    names = {p.name for p in SHIPPED}
    assert {"spatial-types", "spatial-import-visium", "spatial-import-xenium"} <= names, (
        f"a known consumer of the write-time contract is missing from {sorted(names)}")
    assert _SOURCE_PKG in SHIPPED, "the source of truth must be exercised alongside its copies"
    for package_dir in SHIPPED:
        source = (package_dir / "compute" / "ome_writer.py").read_bytes()
        assert hashlib.sha256(source).hexdigest() == hashlib.sha256(
            (_SOURCE_PKG / "compute" / "ome_writer.py").read_bytes()).hexdigest(), (
            f"{package_dir.name} ships a DRIFTED copy; re-vendor it from spatial-types")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize(
    "samples,photometric,extrasamples",
    [
        (None, 1, ()),
        (1, 1, ()),
        (3, 2, ()),
        (4, 2, (2,)),
    ],
    ids=["2d", "one-sample", "rgb", "rgba"],
)
def test_the_photometric_and_extrasamples_tags_say_what_the_design_says(
        package_dir, samples, photometric, extrasamples, tmp_path):
    """TEST-9 — the tags a reader COMPOSITES with, asserted as values.

    `SizeX`/`SizeY`/`SizeC` being right is necessary; it is not the whole declaration. TIFF tag
    262 (`PhotometricInterpretation`) and tag 338 (`ExtraSamples`) are what tell a reader whether
    the fourth sample is alpha to blend or a channel to ignore, and the wrong value there
    mis-renders an image whose geometry is perfect.

    The expected values, and where each comes from:
      * `S == 3` -> RGB (2), NO extrasamples. Three interleaved samples is what RGB means.
      * `S == 4` -> RGB (2) + exactly one `UNASSALPHA` (2). TIFF 6.0's RGBA; `tifffile` admits 4
        for RGB (*"allow common alpha"*), and this system's own reader
        (`omeTiffPyramid.ts`, `samples === 3 || samples === 4`) renders it through the file's
        photometric.
      * 2-D and `S == 1` -> MINISBLACK (1), spp 1, no extrasamples: a plain plane.

    **What this test does NOT prove, stated rather than implied.** `write_ome_tiff` passes
    `extrasamples=("unassalpha",)` explicitly for `S == 4`, and `tifffile`'s own default for
    RGB-with-one-extra emits the identical tag — so deleting that keyword is an EQUIVALENT
    mutation and this assertion cannot go red on it. That is measured, not assumed. The
    assertion still earns its place: it pins the emitted tag against a `tifffile` whose default
    changes, which is the only thing that could move it.
    """
    import tifffile

    arr = _sample_varying(_shaped(samples))
    with _staged_writer(package_dir) as (OW, SD):
        dest = _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    with tifffile.TiffFile(str(dest)) as handle:
        page = handle.pages[0]
        assert int(page.photometric) == photometric
        assert tuple(int(x) for x in page.extrasamples) == extrasamples
        assert page.samplesperpixel == (1 if samples is None else samples)
        assert int(page.planarconfig) == 1, "the samples must be interleaved, not planar"


@pytest.mark.parametrize(
    "package,floor",
    [
        ("spatial-types", (0, 7, 0)),
        ("spatial-import-visium", (0, 8, 0)),
        ("spatial-import-xenium", (0, 7, 0)),
    ],
)
def test_every_package_carrying_the_changed_writer_moved_its_seed_version(package, floor):
    """TEST-10 — the version bump, because an unchanged version is an unshipped fix.

    `scripts/check-processor-seed-versions.sh` states the consequence: *"An already-provisioned
    deployment SKIPS re-extraction at an unchanged version, so it would keep running the OLD
    package."* All three packages ship the changed `ome_writer.py`, so all three move. MINOR and
    not patch, per that script's own rule (*"patch for a fix, minor for behavior"*): what changed
    is the emitted OME-XML, which is behaviour a consumer observes.

    Written as a RELATION rather than a literal (#273): a later forward bump must not falsify
    it, while a missing or backwards one must. That is not theoretical here — the xenium floor
    moved from 0.6.0 to 0.7.0 mid-branch, because #269 landed on main and took 0.6.0 first. The
    merge-gate's staging merge is what surfaced it, as a CONFLICT on that one line rather than
    as two correct edits producing one identical version that git would merge silently; the same
    collision is recorded twice already in `spatial-import-xenium/tests/test_package_registration.py`.
    """
    manifest = (_PACKAGES / package / "manifest.yaml").read_text().splitlines()
    versions = [line.split(":", 1)[1].strip().strip("'\"")
                for line in manifest if line.startswith("version:")]
    assert len(versions) == 1, (
        f"{package}/manifest.yaml has {len(versions)} top-level `version:` lines; the seed "
        "reconciliation key must be unambiguous")
    parsed = tuple(int(part) for part in versions[0].split("."))
    assert parsed >= floor, (
        f"{package} is at {versions[0]} but ships the #266 writer change, which needs at least "
        f"{'.'.join(str(n) for n in floor)}")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", _REFUSED_SAMPLES, ids=[str(s) for s in _REFUSED_SAMPLES])
def test_a_sample_count_this_system_cannot_read_is_refused_rather_than_emitted(
        package_dir, samples, tmp_path):
    """TEST-12 (INV-5) — the arm where a CORRECT header would still be the wrong artifact.

    This is the finding that reversed a decision, so the reasoning is asserted rather than only
    written down. Classifying a 2-sample or 6-sample array correctly is easy — `minisblack` plus
    `planarconfig="contig"` emits `SizeX`/`SizeY`/`SizeC` all true, and the file gets smaller (by
    how much depends entirely on the data, so no ratio is quoted). It is still the WRONG THING TO
    EMIT, because of what happens next:

      * On `origin/main` a `(300, 220, 2)` array emitted **300 top-level IFDs** (measured), so
        `omeTiffPyramid.ts`'s `getImageCount() > 1` guard threw `MultiPlaneImageUnsupportedError`
        — a refusal BY NAME.
      * Classified correctly it is **1 IFD, `SamplesPerPixel=2`, `PlanarConfiguration=1`**: both
        of that loader's refusals pass, its interleave rule is `samples === 3 || samples === 4`
        so `interleaved` is false, the source is declared `[1, height, width]` over an
        interleaved raster, and `TiffPixelSource._readRasters` takes `raster[0]`. Sample 0 is
        rendered as the whole image and nothing says so.

    A loud refusal traded for a silent partial render is a worse artifact than the one #266
    filed, however correct its header. The reader's own docstring is the contract being honoured
    here: *"Every image this system EMITS is a single plane (interleaved RGB or one greyscale
    sample)"* — a sentence about THIS writer.

    Asserted three ways, because each is load-bearing: the refusal is an `ImageConversionError`
    (the taxonomy both importers' guards catch, so it costs one image and not the import), it
    NAMES the sample count, and it leaves nothing on disk. Lifting it is #288.
    """
    arr = _sample_varying(_shaped(samples))
    with _staged_writer(package_dir) as (OW, SD):
        assert samples not in OW.READABLE_SAMPLE_COUNTS
        with pytest.raises(OW.ImageConversionError) as caught:
            _pixels(OW, SD, tmp_path / "image.ome.tif", arr)
    message = str(caught.value)
    # The substring has to be DISTINCTIVE, not just the digit. `str(samples) in message` was
    # VACUOUS for `samples` of 2 and 8, because the message cites "#288" — mutation-proved: with
    # both `{samples}` interpolations deleted from the refusal, S=5 and S=6 went RED while S=2
    # and S=8 stayed GREEN. A bare digit found anywhere in the prose is not evidence that the
    # message names the sample count.
    assert f"has {samples} samples per pixel" in message, (
        f"the refusal does not name the sample count: {message}")
    assert not list(tmp_path.iterdir()), (
        f"a refused write left {[p.name for p in tmp_path.iterdir()]} behind")
    _assert_caught_by_the_importer_guards()


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("shape", [(5,), (_H, _W, 1, 3), (_H, _W, 3, 1), (2, 3, 4, 5, 6)],
                         ids=["1d", "4d", "4d-shape2-is-3", "5d"])
def test_a_shape_that_is_not_a_plane_is_refused_rather_than_guessed_at(
        package_dir, shape, tmp_path):
    """TEST-13 (INV-5) — no shape falls through, including the ones above 3-D.

    The helper's promise is that EVERY input reaches an explicit arm. What `origin/main` did
    instead is MEASURED, because the first version of this docstring guessed and guessed wrong
    (it said a 4-D array "came back `rgb`" and "dies as a bare ValueError"): the pre-fix
    expression is `arr.ndim == 3 and arr.shape[2] == 3`, so a 4-D array fails the FIRST
    conjunct, is classified `minisblack`, and `tifffile` writes a complete, silently mis-headed
    file —

        (60, 44, 1, 3)  -> axes=ZCYX,  SizeX=3 SizeY=1 SizeC=44 SizeZ=60
        (2, 3, 4, 5, 6) -> axes=TZCYX, SizeX=6 SizeY=5 SizeC=4 SizeZ=3 SizeT=2

    — the same defect #266 is about, one dimension further out. `ndim < 2` is the other half and
    DOES die uncaught: a bare `IndexError` from `arr.shape[2]`, which is in neither importer's
    `except` tuple and so costs the WHOLE import rather than one image — the exact consequence
    the `S < 1` refusal's own comment cites as its reason to exist.

    Not reachable through `read_image`/`read_plane` today — both refuse `ndim not in (2, 3)`
    themselves — which is precisely why it needs a test: an unreachable branch that is wrong is
    a branch that is wrong on the day something reaches it.
    """
    arr = np.zeros(shape, dtype=np.uint8)
    # A placement is required by the signature but never reached: the shape refusal precedes
    # the extent assert, which is the ordering that keeps the message about the SHAPE rather
    # than about a mismatched extent derived from a shape that means nothing.
    placement = {"extent": {"width": 1, "height": 1}}
    with _staged_writer(package_dir) as (OW, SD):
        with pytest.raises(OW.ImageConversionError) as caught:
            OW.write_ome_tiff(tmp_path / "image.ome.tif", arr, placement=placement)
    message = str(caught.value)
    assert f"{len(shape)}-dimensional" in message, (
        f"the refusal does not name the dimensionality: {message}")
    assert not list(tmp_path.iterdir()), "a refused write left a file behind"
    _assert_caught_by_the_importer_guards()


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_a_bilevel_plane_is_written_when_it_can_be_and_refused_when_it_cannot(
        package_dir, tmp_path):
    """TEST-14 (INV-3, INV-5) — the dtype interaction a sample-count-only sweep cannot see.

    `tifffile` sets `bilevel` from the dtype (`datadtype.char == '?'`) and then packs each tile
    with `packbits`, which is wrong once there is more than one sample per pixel. Measured with
    the guard temporarily lifted, on a fair-coin `default_rng(266)` bool array — the input is
    named because an earlier draft quoted three counts against ONE denominator, which cannot be
    right for three different sample counts:

        (300, 220, 3)     90,632 of   198,000 samples differ  (45.8%)
        (300, 220, 4)    123,821 of   264,000                 (46.9%)
        (1100, 900, 3)  1,361,386 of 2,970,000                (45.8%)
        (1100, 900, 4)  1,855,822 of 3,960,000                (46.9%)

    Only `S` in `{3, 4}` is listed because those are the only counts that can REACH the guard —
    everything else is refused earlier by `READABLE_SAMPLE_COUNTS`. The pixels do not come back.

    This is why INV-3 needs a DTYPE axis and not only a sample-count axis. `origin/main`
    PRESERVED those pixels for `S` in `{1, 2, 4, 5}` — under a wrong header, but losslessly — so
    classifying them correctly without this guard would trade a mis-declared lossless file for a
    correctly-declared lossy one. A correct header over destroyed pixels is a worse artifact
    than the one #266 filed. (`S == 3` bool was ALREADY corrupt on `origin/main`, at every size
    tried from 1x1 to 2048x1024; the same guard closes that.)

    Both halves are asserted, because a refusal that swallowed the working case would be its own
    defect: a bilevel 2-D plane and a bilevel `(H, W, 1)` still emit, and still round-trip
    bit-for-bit — `downsample`'s bool branch, and its measured argument for majority-rounding
    over a logical OR, are about exactly those.
    """
    import tifffile

    mask = (_sample_varying((_H, _W)) % 2).astype(bool)
    with _staged_writer(package_dir) as (OW, SD):
        for arr in (mask, mask.reshape(_H, _W, 1)):
            dest = _pixels(OW, SD, tmp_path / "mask.ome.tif", arr)
            with tifffile.TiffFile(str(dest)) as handle:
                decoded = handle.series[0].asarray()
            assert decoded.dtype == np.bool_
            assert np.array_equal(decoded, mask), (
                f"a bilevel {arr.shape} plane must still round-trip bit-for-bit")
            assert _ome_sizes(dest) == (_W, _H, 1)
            dest.unlink()

        for samples in (3, 4):
            multi = np.ascontiguousarray(np.repeat(mask[:, :, None], samples, axis=2))
            with pytest.raises(OW.ImageConversionError) as caught:
                _pixels(OW, SD, tmp_path / "multi.ome.tif", multi)
            message = str(caught.value)
            assert "BILEVEL" in message and str(samples) in message, message
    assert not list(tmp_path.iterdir()), "a refused write left a file behind"
    _assert_caught_by_the_importer_guards()
