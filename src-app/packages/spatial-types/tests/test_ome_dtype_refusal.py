#!/usr/bin/env python3
# ruff: noqa
"""#292 — a dtype OME-XML cannot express costs ONE image, not the import.

`write_ome_tiff` has exactly two refusal taxonomies, and they were chosen so that a bad image
costs one image rather than the import. Both importers guard exactly those (plus `OSError`)
around the whole per-image body. A dtype OME-XML has no `PixelType` for was in NEITHER, so it
propagated past both guards and aborted the entire import — the matrix, the coordinates, the
columns and the report, over one unusual vendor image.

**The shape deliberately absent from this file is "it raises".** On `301cd345` these inputs DID
raise — `tifffile.OmeXmlError` for one family, a bare `KeyError` for another — so a test that
asserts an exception was raised is GREEN against the broken writer and proves nothing. That is
the exact failure mode #292, #266 and #274 are all about. So every assertion here does one of
three things instead:

  * names the TYPE, checked against the `except (...)` tuple PARSED OUT OF THE CALLERS' OWN
    SOURCE (`_importer_guard_tuple`) rather than hardcoded — because what makes a refusal cost
    one image is that the type appears in the tuple the caller actually wrote;
  * names the DTYPE in the message, because a refusal a user cannot act on is a crash with
    better manners;
  * asserts THE OTHER ARTIFACTS STILL LANDED — which for this file means the writer still emits
    everything it emitted before, and for the end-to-end half lives in
    `spatial-import-xenium/tests/test_image_robustness.py` (TEST-9/10/11).

Everything is parametrized over EVERY package that ships a `compute/ome_writer.py`, discovered by
glob. TEST-8 asserts those copies are byte-identical, so GIVEN that assert the behavioural
parametrization is redundant and one mutation kills all three legs — it is kept as defence in
depth for the reason the sibling suite gives: the byte guard is the thing that would be narrowed
or deleted first, and a behavioural assertion survives its removal.
"""
import ast
import builtins
import contextlib
import hashlib
import importlib.util
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import image_boundary_guards as IBG  # noqa: E402

_PACKAGES = Path(__file__).resolve().parents[2]
_REPO = _PACKAGES.parents[1]
_SOURCE_PKG = _PACKAGES / "spatial-types"

#: `tifffile` stamps a fresh random UUID into the OME-XML on every write, so it is the one
#: thing that legally differs between two runs of identical code. Normalised away wherever two
#: emissions are compared as bytes. Copied from `test_ome_sample_classification.py`.
_UUID_BYTES = re.compile(rb"urn:uuid:[0-9a-fA-F-]+")

#: The bare names staged into `sys.modules`, restored afterwards. Three sibling packages ship
#: files of these names and several of their suites read the bare name at test time without
#: re-staging, so leaving one copy installed under the bare name is how a suite ends up
#: asserting about another package's file. Copied from `test_ome_sample_classification.py`.
_STAGED = ("spatial_declarations", "ome_writer")

#: NON-SQUARE on purpose — on a square image a swapped width/height pair is indistinguishable
#: from a correct one — and small, because the exhaustive sweep writes a few hundred files.
_H, _W = 60, 44

def _available(*names):
    """Those of `names` this platform's numpy actually has.

    `float128`/`complex256` are x86-64 extended-precision aliases and do not exist everywhere.
    Filtered HERE, at collection time, rather than skipped inside a test: a platform without
    them has nothing to assert, while a runtime skip would put a permanently-yellow leg in a
    suite whose whole point is that no input escapes.
    """
    out = []
    for name in names:
        try:
            np.dtype(name)
        except TypeError:  # pragma: no cover — platform-dependent
            continue
        out.append(name)
    return tuple(out)


#: The dtypes #292 names, plus the two the sweep added. Every one of these escaped BOTH guards
#: on `301cd345` as `tifffile.OmeXmlError`.
_FAMILY_A = _available("int64", "uint64", "float16", "float128", "complex256")
assert "int64" in _FAMILY_A and "float16" in _FAMILY_A, (
    "the two dtypes #292 names by number are unavailable, so this suite would pass vacuously")

#: The family #292 did NOT know about: these die one frame earlier, inside `TiffWriter.write`'s
#: `sampleformat = {'u':1,'i':2,'f':3,'c':6}[datadtype.kind]` lookup, as a bare `KeyError`.
#: Fixing family A and leaving these is the defect one dimension over, and it is why the repair
#: is a guard on the dtype rather than an `except` on the library's exception type.
_FAMILY_B = ("datetime64[s]", "timedelta64[s]", "U4", "S4", "O", [("a", "u1"), ("b", "u1")])

#: The number of distinct dtypes the sweep must reach, measured today (27 on numpy 2.2.6).
#: A floor, never an equality: numpy ADDING a dtype should not turn this red.
_SWEEP_FLOOR = 27

#: PRESENT-TENSE descriptions of the #292 gap. Every one of these was true before this change
#: and is false after it. A single literal (`"still escapes"`) was the first version of this
#: check and was defeated by any rewording — measured: inserting "still propagates past both
#: importers guards ... This gap remains OPEN" into a checked document left the test green.
_STALE_GAP_PATTERNS = (
    r"still escapes?\b",
    r"still propagates?\b",
    r"continues to escape\b",
    r"remains? (?:open|unguarded|unclosed)\b",
    r"is (?:still )?in NEITHER importer's guard\b",
)

#: Where that prose can live. The three shipped copies, BOTH importers (they carry the guard
#: comments), and the sample-classification design whose INV-5 named the gap.
#:
#: `docs/design/ome-tiff-dtype-refusal.md` is DELIBERATELY NOT scanned, and this is the honest
#: limit of this test: that document NARRATES the defect in the past tense to explain the fix,
#: so any pattern strong enough to catch a stale claim there also catches its history section.
#: A test that cannot distinguish "this is broken" from "this was broken" must not be pointed
#: at the document whose job is to say the second.
def _gap_prose_files():
    files = [d / "compute" / "ome_writer.py" for d in SHIPPED]
    files += list(_PACKAGES.glob("*/compute/import_*.py"))
    files.append(_REPO / "docs" / "design" / "ome-tiff-sample-classification.md")
    return tuple(files)


#: `numpy.dtype(...).name` -> the OME `PixelType` the emitted file must declare.
_OME_PIXEL_TYPE = {
    "int8": "int8", "int16": "int16", "int32": "int32",
    "uint8": "uint8", "uint16": "uint16", "uint32": "uint32",
    "float32": "float", "float64": "double",
    "complex64": "complex", "complex128": "double-complex",
    "bool": "bit",
}


# ── staging (mirrors `test_ome_sample_classification.py`) ────────────────────────────


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
    for is a courtesy, not a guarantee. A FLOOR is asserted separately (TEST-8).
    """
    return tuple(sorted(p.parents[1] for p in _PACKAGES.glob("*/compute/ome_writer.py")))


SHIPPED = _shipped_writers()
IDS = [p.name for p in SHIPPED]
_GAP_PROSE_FILES = _gap_prose_files()


def _callers():
    """Every `compute/import_*.py` that calls `ome_writer.write_ome_tiff`."""
    return [path for path in sorted(_PACKAGES.glob("*/compute/import_*.py"))
            if "ome_writer.write_ome_tiff" in path.read_text()]


def _importer_guard_tuple(OW, SD):
    """The exception tuple BOTH importers actually wrote, resolved to real classes.

    THIS IS THE POINT OF THE WHOLE FILE. `issubclass(..., RuntimeError)` is not the claim; what
    makes a refusal cost one image instead of the whole import is that the raised type appears
    in the `except (...)` tuple the CALLER wrote. So the tuple is read out of the callers'
    source and the names are resolved against the modules those callers bind them to — never
    hardcoded here, where it could agree with a writer that had drifted from its callers.
    """
    callers = _callers()
    assert len(callers) >= 2, (
        "expected both importers to call `ome_writer.write_ome_tiff`, found "
        f"{[str(path) for path in callers]}")
    tuples = {}
    for caller in callers:
        # BY `ast`, NOT BY REGEX — see `IBG.importer_guard_names`. The regex matched the FIRST
        # `except (...)` naming `ImageConversionError`, which stopped being unambiguous the
        # moment a second such handler (a pass-through) appeared in `import_xenium.emit_image`:
        # it then resolved the WRONG tuple, silently dropped `OSError` from it, and reported
        # that the two importers guard different taxonomies.
        tuples[caller.name] = IBG.importer_guard_names(caller.read_text())
    # The two importers must guard the SAME taxonomy. If they ever diverge, "the refusal is in
    # the taxonomy the guards catch" stops being one sentence and this file's parametrization
    # would silently be asserting about whichever caller happened to sort first.
    assert len(set(tuples.values())) == 1, (
        f"the importers guard DIFFERENT exception tuples: {tuples}. A refusal that is caught by "
        "one importer and not the other is not 'in the taxonomy the guards catch'.")
    resolved = []
    for name in next(iter(tuples.values())):
        if name.startswith("ome_writer."):
            resolved.append(getattr(OW, name.split(".", 1)[1]))
        elif name.startswith("SD."):
            resolved.append(getattr(SD, name.split(".", 1)[1]))
        else:
            resolved.append(getattr(builtins, name))
    assert all(isinstance(cls, type) for cls in resolved), (
        f"could not resolve every name in the importers' guard tuple to a class: {resolved}")
    return tuple(resolved)


def _placement(SD, arr):
    """The minimum legal placement for `arr` — the shape every image test here builds."""
    return SD.image_meta(space=SD.coordinate_space(
        space="t", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        extent={"width": int(arr.shape[1]), "height": int(arr.shape[0])}))


def _shaped(dtype, samples):
    """An `(H, W)` or `(H, W, S)` array of `dtype` with values that differ along every axis."""
    shape = (_H, _W) if samples is None else (_H, _W, samples)
    weights = (7, 13, 29)[: len(shape)]
    value = np.zeros(shape, dtype=np.int64)
    for axis, (length, weight) in enumerate(zip(shape, weights)):
        ramp = np.arange(length, dtype=np.int64) * weight
        value += ramp.reshape([-1 if i == axis else 1 for i in range(len(shape))])
    return (value % 251).astype(np.dtype(dtype))


def _emit(OW, SD, dest, arr):
    return OW.write_ome_tiff(dest, arr, placement=_placement(SD, arr))


def _ome_pixel_type(path):
    """The `<Pixels Type=...>` the emitted file's own OME-XML declares."""
    import tifffile
    with tifffile.TiffFile(str(path)) as handle:
        xml = handle.ome_metadata
    assert xml, f"{path} carries no OME-XML at all"
    pixels = re.search(r"<Pixels[^>]*>", xml)
    assert pixels, f"{path}'s OME-XML has no <Pixels> element:\n{xml[:400]}"
    found = re.search(r'Type="([^"]*)"', pixels.group(0))
    assert found, f"{path}'s <Pixels> declares no Type: {pixels.group(0)}"
    return found.group(1)


# ── TEST-1 — the NAMED taxonomy, not the library's exception ─────────────────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("dtype", _FAMILY_A)
@pytest.mark.parametrize("samples", (None, 1, 3, 4), ids=["2d", "s1", "s3", "s4"])
def test_a_dtype_ome_xml_cannot_express_is_refused_in_the_importers_own_taxonomy(
        package_dir, dtype, samples, tmp_path):
    """TEST-1 (INV-1) — the type is in the tuple the CALLERS wrote, and is not the library's.

    Driven from a REAL numpy array of the failing dtype through the REAL `write_ome_tiff` — not
    a mock of the exception, and not a stub writer. On `301cd345` every one of these 20
    combinations left this function as `tifffile.OmeXmlError`, whose `__mro__` is
    `(OmeXmlError, Exception, BaseException, object)` — not `RuntimeError`, not `ValueError`,
    not `OSError` — so it was in neither importer's `except` tuple and aborted the whole import.
    """
    import tifffile
    arr = _shaped(dtype, samples)
    with _staged_writer(package_dir) as (OW, SD):
        guards = _importer_guard_tuple(OW, SD)
        with pytest.raises(BaseException) as caught:
            _emit(OW, SD, tmp_path / "refused.ome.tif", arr)
    exc = caught.value
    assert not isinstance(exc, tifffile.OmeXmlError), (
        f"a {dtype} image STILL leaves write_ome_tiff as tifffile.OmeXmlError. That type is in "
        "neither importer's except tuple, so it costs the WHOLE import — the matrix, the "
        "coordinates, the columns and the report — over one image. This is #292 unfixed."
    )
    assert not type(exc) is KeyError, (
        f"a {dtype} image leaves write_ome_tiff as a bare KeyError (family B — tifffile's "
        "`sampleformat` lookup, one frame earlier than the OmeXmlError). Also in neither "
        "guard, also costs the whole import."
    )
    assert isinstance(exc, guards), (
        f"a {dtype} image raised {type(exc).__module__}.{type(exc).__name__}, which is NOT in "
        f"the tuple the importers themselves guard ({[c.__name__ for c in guards]}). Read out "
        f"of their source, not hardcoded here. Message was: {exc}"
    )
    # WHICH MECHANISM REFUSED, not merely that something did. Without this the test is
    # satisfied by the BACKSTOP as readily as by the guard, and every claim the module makes
    # about the guard — "checked BEFORE A BYTE IS WRITTEN", "BEFORE `pyramid_levels`, so a
    # doomed emission does not build a pyramid it will discard" — is untested: a mutant whose
    # guard covers only the non-numeric kinds, letting every dtype #292 NAMES fall through to
    # the backstop, wrote the whole plane to disk and then discarded it, and the entire suite
    # stayed green.
    #
    # `__cause__` is the observable that separates them, and it is not a proxy: the backstop
    # is `raise ImageConversionError(...) from exc`, so a refusal that came through it ALWAYS
    # carries the `tifffile.OmeXmlError` it converted, and the up-front guard — which raises
    # with no active exception — always carries `None`.
    assert exc.__cause__ is None, (
        f"a {dtype} image was refused by the BACKSTOP (__cause__ is "
        f"{type(exc.__cause__).__name__}), not by the up-front dtype guard. The refusal type "
        "is right, so the import still survives — but `TiffWriter` was entered and the plane "
        "was written and discarded before the refusal, which is exactly what the guard exists "
        "to prevent and what its own comments claim it does."
    )


# ── TEST-2 — the refusal NAMES THE DTYPE ────────────────────────────────────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("dtype", _FAMILY_A)
def test_the_refusal_names_the_dtype_and_what_ome_xml_supports(package_dir, dtype, tmp_path):
    """TEST-2 (INV-3) — a user can act on it.

    "Refused" is not enough: the person holding the bundle has to learn WHICH dtype was refused
    and WHAT to convert it to, or the message is a crash with better manners. Asserted on the
    message text because that text is what reaches the report's `images_not_emitted` line
    verbatim (`f"{basename}: not emitted — {type(exc).__name__}: {exc}"`).
    """
    arr = _shaped(dtype, None)
    with _staged_writer(package_dir) as (OW, SD):
        with pytest.raises(OW.ImageConversionError) as caught:
            _emit(OW, SD, tmp_path / "refused.ome.tif", arr)
        supported = OW.OME_EXPRESSIBLE_DTYPES
    message = str(caught.value)
    # The QUOTED form — the `{arr.dtype.name!r}` interpolation. The supported-dtype list in
    # the same message is comma-joined and unquoted, so it cannot satisfy this for any dtype;
    # only the interpolation can. A bare substring check was the vacuous version: while the
    # message illustrated its own argument with literal dtype names, 9 of these 15 legs passed
    # with the interpolation deleted outright.
    assert repr(np.dtype(dtype).name) in message, (
        f"the refusal does not name the dtype as {np.dtype(dtype).name!r} — the report line a "
        f"user reads does not say what to fix, or says it only in boilerplate. Message was: "
        f"{message}")
    # WORD-BOUNDARY matching, not `in`. `int8` is a substring of `uint8`, `int16` of `uint16`
    # and `int32` of `uint32`, so a plain `name not in message` reports nothing missing when a
    # message drops all three signed names and keeps the unsigned ones — measured: the whole
    # suite stayed green while the user-facing advice silently lost three of the eleven dtypes
    # it exists to list.
    missing = [name for name in supported
               if not re.search(r"\b" + re.escape(name) + r"\b", message)]
    assert not missing, (
        f"the refusal does not name {missing} among the dtypes OME-XML CAN express, so a user "
        f"is told what is wrong and not what to do about it. Message was: {message}")


# ── TEST-3 — the EXHAUSTIVE sweep: nothing escapes ──────────────────────────────────


def _every_numpy_dtype():
    """Every distinct scalar dtype numpy offers, plus the non-scalar kinds family B is made of.

    Deduped by `.name` because `np.sctypeDict` is mostly aliases. This is the assertion that
    makes "family B is closed too" a MEASUREMENT rather than a claim, and it is what would
    catch a `tifffile` upgrade that narrowed its own PixelType table.
    """
    seen, out = set(), []
    # `_FAMILY_A` is fed in EXPLICITLY, not left to `np.sctypeDict`. numpy has been pruning
    # that dict for several releases; if it shrank, this sweep would stay non-empty (family B
    # is appended separately) and go green having tested only the family it hardcodes. The
    # named dtypes #292 is about must be in the sweep by name.
    for candidate in list(_FAMILY_A) + list(np.sctypeDict.values()) + list(_FAMILY_B):
        try:
            dt = np.dtype(candidate)
        except (TypeError, ValueError):  # pragma: no cover — abstract entries
            continue
        if dt.str in seen:
            continue
        seen.add(dt.str)
        out.append(dt)
    return out


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (None, 1, 3, 4), ids=["2d", "s1", "s3", "s4"])
def test_no_numpy_dtype_at_all_escapes_the_importers_guards(package_dir, samples, tmp_path):
    """TEST-3 (INV-1) — the whole dtype space, not the five that were reported.

    #292 named `OmeXmlError`. Sweeping the whole space found a SECOND family raised from a
    different frame as a different type, and fixing one while leaving the other is the shape
    that issue is about. So the assertion is universal: for EVERY dtype numpy can produce, at
    every sample count the writer admits, `write_ome_tiff` either EMITS or raises inside the
    tuple the importers guard. Nothing else. No third outcome.
    """
    escapes, late, swept, unbuildable = [], [], 0, []
    with _staged_writer(package_dir) as (OW, SD):
        guards = _importer_guard_tuple(OW, SD)
        for index, dt in enumerate(_every_numpy_dtype()):
            try:
                arr = _shaped(dt, samples)
            except (TypeError, ValueError) as exc:  # a dtype `_shaped` cannot construct
                unbuildable.append(f"{dt.name} ({type(exc).__name__})")
                continue
            swept += 1
            try:
                _emit(OW, SD, tmp_path / f"sweep-{index}.ome.tif", arr)
            except Exception as exc:  # noqa: BLE001 — the sweep must OBSERVE what escapes
                if not isinstance(exc, guards):
                    escapes.append(
                        f"{dt.name} S={samples}: "
                        f"{type(exc).__module__}.{type(exc).__name__}: {str(exc)[:80]}")
                elif exc.__cause__ is not None:
                    late.append(f"{dt.name} S={samples}: via {type(exc.__cause__).__name__}")
    assert not escapes, (
        f"{len(escapes)} dtype(s) still escape the tuple both importers guard "
        f"({[c.__name__ for c in guards]}), so each costs the WHOLE import rather than one "
        "image:\n  " + "\n  ".join(escapes))
    # A FLOOR on how much was actually swept. The `continue` above is the only way a dtype can
    # leave this sweep, and it is SILENT: a numpy change that made a dtype unconstructible
    # would shrink the coverage of the one test that proves nothing escapes, with no signal at
    # all. Measured today: 27 dtypes, 0 unbuildable. Same reasoning as TEST-8's `>= 3` floor.
    assert swept >= _SWEEP_FLOOR, (
        f"the sweep only reached {swept} dtypes (floor {_SWEEP_FLOOR}); "
        f"{len(unbuildable)} could not be constructed: {unbuildable}. This test's whole claim "
        "is that NOTHING escapes, and a shrinking sweep weakens it invisibly.")
    # AND the guard, not the backstop, is what refused. See TEST-1's `__cause__` assertion for
    # why this is the load-bearing distinction; here it is what makes the module's claim that
    # "nothing reaches the backstop by the dtype route today" a MEASUREMENT over the whole
    # dtype space rather than an assertion about the five dtypes #292 happened to name.
    assert not late, (
        "these were refused by the BACKSTOP rather than by the up-front dtype guard, i.e. the "
        "plane was written and discarded before the refusal:\n  " + "\n  ".join(late))


# ── TEST-4 — the allowlist mirrors the library, and cannot drift from it ────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_allowlist_is_exactly_what_the_installed_tifffile_can_express(package_dir):
    """TEST-4 — re-derived from the library, not remembered.

    `OME_EXPRESSIBLE_DTYPES` is a MIRROR of a table inside a pinned third-party library. A
    mirror that is only ever compared against a copy of itself is not a mirror. So the set is
    re-derived by driving every candidate dtype through the installed `tifffile`'s own OME-XML
    assembler and recording which it accepts — and if the library's table ever moves, this goes
    red and names the direction it moved in, which is the whole reason the named backstop in
    `write_ome_tiff` exists.
    """
    import tifffile
    from tifffile.tifffile import OmeXml

    accepted = set()
    for dt in _every_numpy_dtype():
        xml = OmeXml()
        try:
            xml.addimage(dt, (_H, _W), (1, 1, 1, _H, _W, 1), axes="YX")
        except Exception:  # noqa: BLE001 — anything at all means "not expressible"
            continue
        accepted.add(dt.name)
    with _staged_writer(package_dir) as (OW, _SD):
        declared = set(OW.OME_EXPRESSIBLE_DTYPES)
    assert declared == accepted, (
        f"`OME_EXPRESSIBLE_DTYPES` has drifted from tifffile {tifffile.__version__}'s own "
        f"PixelType table.\n  declared but NOT accepted (these will now reach the named "
        f"backstop instead of the guard): {sorted(declared - accepted)}\n  accepted but NOT "
        f"declared (these are being refused although they would emit fine): "
        f"{sorted(accepted - declared)}")


# ── TEST-5 — every expressible dtype STILL EMITS, unchanged ─────────────────────────


#: `(dtype, samples)` PAIRS rather than a cross-product: `bool` at `S > 1` is refused by the
#: PRE-EXISTING #266 bilevel guard, so it is not generated here at all. Generating it and then
#: skipping it would leave a permanently-yellow leg in a suite about what does and does not
#: emit; TEST-5b asserts that refusal directly instead.
#: `S == 1` (the RESHAPE arm) and `S == 4` (the `extrasamples` arm) are included as well as
#: the two shipped shapes: an earlier version covered only `{None, 3}`, which left the two
#: arms #266 added untested by the invariant that says nothing moved.
_EMITTING = tuple((dtype, samples)
                  for dtype in sorted(_OME_PIXEL_TYPE)
                  for samples in ((None, 1) if dtype == "bool" else (None, 1, 3, 4)))


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("dtype,samples", _EMITTING,
                         ids=[f"{d}-{'2d' if s is None else 's%d' % s}" for d, s in _EMITTING])
def test_every_expressible_dtype_still_emits_the_pixels_it_was_given(
        package_dir, dtype, samples, tmp_path):
    """TEST-5 (INV-6) — the refusal moves NOTHING that previously worked.

    A guard that closes a crash by also refusing eleven working dtypes is not a fix. Each of the
    eleven OME-expressible dtypes is emitted through the real writer and read back: the file
    must exist, its `<Pixels Type=...>` must be the OME name for that dtype, and level 0 must
    equal the input bit-for-bit.

    `bool` at `S == 3` is not GENERATED here (see `_EMITTING`) and is asserted separately by
    TEST-5b — it is refused by the PRE-EXISTING bilevel-with-samples guard from #266, and that
    separation is the executable form of DEC-5's claim that the new dtype guard is placed so it
    does not shadow it.
    """
    import tifffile
    arr = _shaped(dtype, samples)
    with _staged_writer(package_dir) as (OW, SD):
        dest = _emit(OW, SD, tmp_path / "emitted.ome.tif", arr)
    assert Path(dest).is_file(), f"a {dtype} S={samples} image was not emitted at all"
    assert _ome_pixel_type(dest) == _OME_PIXEL_TYPE[dtype], (
        f"a {dtype} image declares PixelType {_ome_pixel_type(dest)!r}, expected "
        f"{_OME_PIXEL_TYPE[dtype]!r} — the header describes different pixels from the ones "
        "written")
    read_back = tifffile.imread(str(dest))
    expected = arr.reshape(arr.shape[:2]) if samples == 1 else arr
    assert read_back.shape == expected.shape and np.array_equal(read_back, expected), (
        f"a {dtype} S={samples} image did not round-trip: wrote {expected.shape} "
        f"{expected.dtype}, read {read_back.shape} {read_back.dtype}")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("samples", (3, 4), ids=["s3", "s4"])
def test_the_new_dtype_guard_does_not_shadow_the_bilevel_refusal(package_dir, samples, tmp_path):
    """TEST-5b — `bool` is OME-expressible, so the more specific message must still win.

    `bool` IS in the allowlist (OME `PixelType="bit"`), which is why it reaches the #266
    bilevel-with-samples guard at all. If `bool` had been left OUT of the allowlist "to be
    safe", a bilevel RGBA image would now be told "OME-XML has no PixelType for bool" — which
    is false, and points the user at the wrong fix.

    **What this test does NOT prove, stated because an earlier docstring claimed it did:** it
    says nothing about WHERE the dtype guard sits. `bool` is expressible, so the guard is a
    no-op for it wherever it is placed — moving the guard above `_sample_layout` leaves this
    test green. TEST-5c is the one that pins the ordering.
    """
    arr = _shaped("bool", samples)
    with _staged_writer(package_dir) as (OW, SD):
        with pytest.raises(OW.ImageConversionError) as caught:
            _emit(OW, SD, tmp_path / "bilevel.ome.tif", arr)
    message = str(caught.value)
    assert "BILEVEL" in message, (
        f"a bool S={samples} image is no longer refused by the #266 bilevel guard — the new "
        f"dtype guard has shadowed it and the user gets the wrong diagnosis. Message: {message}")
    assert "PixelType" not in message, (
        f"a bool image is being refused as dtype-inexpressible, which is FALSE (OME has "
        f"PixelType='bit'). Message: {message}")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("dtype", ("int64", "float16"))
@pytest.mark.parametrize("samples", (2, 5, 7), ids=["s2", "s5", "s7"])
def test_an_unreadable_sample_count_is_diagnosed_before_an_unexpressible_dtype(
        package_dir, dtype, samples, tmp_path):
    """TEST-5c — the ORDERING the module's comment insists on, made executable.

    `write_ome_tiff` says "HERE, and not one line earlier or later" about where the dtype
    guard sits: AFTER `_sample_layout`, so the SHAPE refusals keep priority and their more
    specific messages. That claim was asserted in a comment and tested by nothing — moving the
    guard above `_sample_layout` in all three copies left the entire suite green.

    This is the input that distinguishes the two placements: an array that is wrong BOTH ways.
    A `(60, 44, 7)` `int64` plane has an unreadable sample count AND an inexpressible dtype,
    and the sample count is the thing the user has to fix first — an image exported with seven
    channels is not going to become importable by being re-cast to `int32`. With the guard
    moved up, the user is told about the dtype and re-exports at `uint16`, still with seven
    samples, and is refused again for a reason they were never told.
    """
    arr = _shaped(dtype, samples)
    with _staged_writer(package_dir) as (OW, SD):
        with pytest.raises(OW.ImageConversionError) as caught:
            _emit(OW, SD, tmp_path / "both-wrong.ome.tif", arr)
    message = str(caught.value)
    assert "samples per pixel" in message, (
        f"a {dtype} array with {samples} samples was diagnosed as a DTYPE problem before its "
        f"sample count — the dtype guard has been placed ahead of `_sample_layout` and now "
        f"shadows the more specific refusal. Message: {message}")
    assert "PixelType" not in message, (
        f"the dtype refusal fired for a {samples}-sample array; the sample-count refusal must "
        f"win. Message: {message}")


class _RemoveDtypeGuard(ast.NodeTransformer):
    """Delete the `if arr.dtype.name not in OME_EXPRESSIBLE_DTYPES: raise ...` statement.

    `remove=False` still WALKS the whole tree and still unparses; it just declines the
    deletion. That is deliberate and is what makes TEST-5d's identity leg an oracle rather
    than a tautology — if this transformer ever grew a second, unintended rewrite, that
    rewrite would land on the identity derivation too and the oracle would go red. Lifted
    from `test_ome_sample_classification.py::_RevertClassification`.
    """

    def __init__(self, remove):
        self.remove = remove
        self.hits = 0

    def visit_If(self, node):
        test = node.test
        if (isinstance(test, ast.Compare) and len(test.ops) == 1
                and isinstance(test.ops[0], ast.NotIn)
                and ast.unparse(test.comparators[0]) == "OME_EXPRESSIBLE_DTYPES"):
            self.hits += 1
            if self.remove:
                return None
        return self.generic_visit(node)


def _writer_without_the_guard(package_dir, *, remove):
    """`ome_writer.py` re-executed, optionally with the dtype guard excised.

    Not a hand-written copy of the writer. It is THE writer, re-executed with one statement
    removed, so the control cannot drift from production in any other keyword.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    transformer = _RemoveDtypeGuard(remove)
    tree = transformer.visit(ast.parse(source))
    ast.fix_missing_locations(tree)
    assert transformer.hits == 1, (
        f"the surgery found {transformer.hits} dtype-guard statement(s), not exactly 1. A "
        "surgery that matched nothing produces a control identical to production, and every "
        "comparison against it then passes for the wrong reason.")
    SD = _exec_by_path(
        "spatial_declarations", package_dir / "compute" / "spatial_declarations.py")
    module = importlib.util.module_from_spec(
        importlib.util.spec_from_loader("ome_writer", loader=None))
    module.__file__ = str(package_dir / "compute" / "ome_writer.py")
    sys.modules["ome_writer"] = module
    exec(compile(ast.parse(ast.unparse(tree)), module.__file__, "exec"), module.__dict__)
    return module, SD


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("dtype,samples", _EMITTING,
                         ids=[f"{d}-{'2d' if s is None else 's%d' % s}" for d, s in _EMITTING])
def test_an_expressible_dtype_emits_exactly_the_bytes_it_emitted_before(
        package_dir, dtype, samples, tmp_path):
    """TEST-5d (INV-6) — "EXACTLY THE BYTES", which is what the invariant actually says.

    TEST-5 asserts the file exists, declares the right PixelType and round-trips its pixels.
    That is necessary and it is NOT what INV-6 promises: "Every dtype OME-XML CAN express
    still emits exactly the bytes it emitted before." A round-trip is blind to a moved tag, a
    changed compression level, a dropped `PhysicalSize`, or a pyramid level that stopped being
    written — all of which would leave the pixels intact.

    The control is HEAD's own source with ONLY the dtype guard excised, so what is compared is
    "with the guard" against "without it" and nothing else. The `urn:uuid` tifffile stamps
    freshly on every write is normalised away — it is the one thing that legally differs
    between two runs of identical code.

    True by construction (the guard raises or does nothing), and asserted anyway: "true by
    construction" is the reasoning this repo's own history calls a guess.
    """
    arr = _shaped(dtype, samples)
    with _restoring_sys_modules():
        OW, SD = _writer_without_the_guard(package_dir, remove=True)
        before = _emit(OW, SD, tmp_path / "control.ome.tif", arr).read_bytes()
    with _staged_writer(package_dir) as (OW, SD):
        after = _emit(OW, SD, tmp_path / "production.ome.tif", arr).read_bytes()
    assert _UUID_BYTES.sub(b"", before) == _UUID_BYTES.sub(b"", after), (
        f"a {dtype} S={samples} image no longer emits the bytes it emitted before the dtype "
        f"guard was added ({len(before)} -> {len(after)} bytes). INV-6 says this change moves "
        "NOTHING that previously worked, and every committed emitted artifact in this tree is "
        "one of these dtypes.")


def test_the_guard_removal_surgery_is_behaviour_preserving_with_the_removal_off():
    """TEST-5e — the ORACLE on TEST-5d's control machinery.

    A botched parse/unparse would make every comparison in TEST-5d meaningless while leaving
    it green. So the SAME transformer and the SAME unparse are run with `remove=False`, and
    the result must emit bytes indistinguishable from production's. If the transformer ever
    grows an unintended second rewrite, it lands here too and this goes red.
    """
    arr = _shaped("uint8", 3)
    package_dir = _SOURCE_PKG
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        with _restoring_sys_modules():
            OW, SD = _writer_without_the_guard(package_dir, remove=False)
            identity = _emit(OW, SD, tmp / "identity.ome.tif", arr).read_bytes()
        with _staged_writer(package_dir) as (OW, SD):
            production = _emit(OW, SD, tmp / "production.ome.tif", arr).read_bytes()
    assert _UUID_BYTES.sub(b"", identity) == _UUID_BYTES.sub(b"", production), (
        "the ast round-trip alone changes the emitted bytes, so TEST-5d's control is not a "
        "control and its comparisons prove nothing.")


# ── TEST-6 — the named backstop works, driven by a REAL OmeXmlError ─────────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_named_backstop_converts_a_real_omexmlerror(package_dir, tmp_path):
    """TEST-6 — proven with the library actually raising, not with a mocked exception type.

    The control is the guard SWITCHED OFF: `OME_EXPRESSIBLE_DTYPES` is widened to admit `int64`
    on the staged module, so a real `int64` array reaches the real `TiffWriter` and the real
    `tifffile` raises the real `OmeXmlError` from `__exit__` -> `close()` -> `addimage`. That is
    the pre-fix behaviour reproduced exactly, and it does two jobs at once: it proves the
    backstop converts, and it proves the GUARD is what is doing the work in TEST-1 (widen it,
    and the old failure comes straight back).
    """
    import tifffile
    arr = _shaped("int64", None)
    with _staged_writer(package_dir) as (OW, SD):
        guards = _importer_guard_tuple(OW, SD)
        OW.OME_EXPRESSIBLE_DTYPES = frozenset(OW.OME_EXPRESSIBLE_DTYPES | {"int64"})
        with pytest.raises(BaseException) as caught:
            _emit(OW, SD, tmp_path / "backstop.ome.tif", arr)
    exc = caught.value
    assert isinstance(exc, guards), (
        f"with the dtype guard widened, the real tifffile.OmeXmlError escaped as "
        f"{type(exc).__module__}.{type(exc).__name__} — the named backstop did not convert it, "
        "so a tifffile upgrade that narrowed its PixelType table would silently re-open #292")
    assert isinstance(exc.__cause__, tifffile.OmeXmlError), (
        f"the backstop dropped the cause ({exc.__cause__!r}); the original library message is "
        "the only thing that says WHICH constraint the library refused on")
    # THE BACKSTOP'S OWN WORDS, not the library's. The converted message embeds `{exc}`, and
    # tifffile's own text is "data type 'int64' not supported" — so a bare `"int64" in str(exc)`
    # is satisfied by the dependency's string and stays green with the backstop's own dtype
    # interpolation deleted entirely. Asserted on the part of the sentence only this module
    # writes.
    message = str(exc)
    library_text = str(exc.__cause__)
    assert message.replace(library_text, "").count("int64") >= 1, (
        "the backstop's message names the dtype ONLY by quoting tifffile's error text, so the "
        f"assertion would pass with the backstop's own interpolation removed. Message: {message}")
    assert "int64" in message and str(arr.shape) in message, (
        f"the backstop does not report the array it was given: {message}")


# ── TEST-7 — the refusal stays NAMED ────────────────────────────────────────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_write_ome_tiff_never_catches_broadly(package_dir):
    """TEST-7 (INV-4) — no UNCONDITIONAL `except Exception` around image emission, ever.

    A bare `except Exception` would satisfy the letter of "a bad image costs one image, not the
    import" and destroy the reason the taxonomies exist: a genuine logic bug in this function
    would come back to the user as a skipped image with the import reporting SUCCESS. That is
    `read_image`'s attempt-1 failure, written down in its own four-attempt history, and its
    conclusion is that the answer to an untested branch is COVERAGE (TEST-3 above), not a wider
    filter.

    THE GUARD ITSELF NOW LIVES IN `image_boundary_guards`, shared with
    `test_image_failure_provenance`, which applies it to every boundary under its declared
    policy. There were two copies of it — this strong one over `write_ome_tiff` alone, and a
    weak one over five boundaries — and the copy applied broadly was the one that checked
    least, which is how `tifffile_version` and `import_xenium.emit_image` ended up guarded by
    nothing. The evasion mutants live there too; this stays as the #292-side entry point,
    because #292's INV-4 is what it enforces.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    offenders = IBG.boundary_offenders(source, "write_ome_tiff", IBG.POLICY_SITE_RULE)
    assert not offenders, (
        f"{package_dir.name}'s `write_ome_tiff` catches broadly: {offenders}. A refusal must "
        f"stay NAMED — only {sorted(IBG.NAMED_REFUSALS)} may be caught by name, and a broad "
        f"`except Exception` only when its body asks `{IBG.SITE_RULE}(exc, __file__)` and "
        "re-raises on it, so a genuine logic bug still propagates instead of being reported to "
        "the user as a skipped image (#292 INV-4, #297).")


# ── TEST-8 — the vendored copies are byte-identical ─────────────────────────────────


def test_every_shipped_ome_writer_is_byte_identical():
    """TEST-8 (INV-5) — a vendored file that drifts is a second implementation.

    A FLOOR of three is asserted alongside the identity, because an identity assertion over one
    surviving copy is vacuously true — that is how a package silently stops being covered.
    """
    assert len(SHIPPED) >= 3, (
        f"expected at least three packages shipping `compute/ome_writer.py`, found {IDS}. A "
        "copy that VANISHED is a package that stopped being covered by every test in this file.")
    digests = {}
    for package_dir in SHIPPED:
        blob = (package_dir / "compute" / "ome_writer.py").read_bytes()
        digests.setdefault(hashlib.sha256(blob).hexdigest(), []).append(package_dir.name)
    assert len(digests) == 1, (
        f"the vendored `ome_writer.py` copies have DRIFTED: {digests}. The canonical copy is "
        "`spatial-types/compute/ome_writer.py`; re-vendor it into the others.")


# ── TEST-12 — the docs do not still describe the gap as open ────────────────────────


def test_no_shipped_source_or_design_doc_still_states_the_gap_as_open():
    """TEST-12 — an accepted design that describes a fixed defect as open is worse than silence.

    `write_ome_tiff`'s docstring and `docs/design/ome-tiff-sample-classification.md` §4 both
    stated, correctly at the time, that a dtype OME-XML cannot express "still escapes" as
    `tifffile.OmeXmlError`. Both are false as of this change. Pinned because a reader who
    believes an out-of-date design will re-file the same issue or, worse, re-introduce the gap
    on the belief that it was deliberate.
    """
    offenders = []
    for path in _GAP_PROSE_FILES:
        if not path.is_file():
            continue
        text = path.read_text()
        for pattern in _STALE_GAP_PATTERNS:
            for hit in re.finditer(pattern, text, re.IGNORECASE):
                line = text.count("\n", 0, hit.start()) + 1
                offenders.append(f"{path.relative_to(_REPO)}:{line}: {hit.group(0)!r}")
    assert not offenders, (
        "these describe the #292 dtype gap as STILL OPEN, which stopped being true when this "
        "change landed. A reader who believes an out-of-date design will re-file the issue "
        "or, worse, re-introduce the gap believing it was deliberate:\n  "
        + "\n  ".join(offenders))


# ── TEST-13 — the seed version moved with the contents ─────────────────────────────


def _manifest_version(text):
    found = re.search(r"^version:\s*(\S+)\s*$", text, re.MULTILINE)
    return found.group(1) if found else None


def test_a_vendoring_package_whose_files_changed_also_moved_its_manifest_version():
    """TEST-13 — the extract-cache trap, for ALL THREE packages and not just the one remembered.

    `src-app/packages/` is embedded into the server binary as a seed and extracted on first run;
    reconciliation is keyed on `manifest.yaml`'s `version`, so an already-provisioned deployment
    at an UNCHANGED version skips re-extraction and keeps executing the OLD kernel. A change
    vendored into three packages therefore needs three bumps, and bumping only the package that
    "owns" the change is the exact miss this closes.

    Scoped as an IMPLICATION — *if* a package's tracked files differ from `origin/main`, *then*
    its version must differ too. That is what keeps it merge-stable: once this branch is on
    main there is no diff, the premise is false, and the test passes vacuously instead of
    turning into a permanent red on main the way an unscoped base-diff guard does.
    """
    try:
        subprocess.run(["git", "rev-parse", "--verify", "origin/main"], cwd=_REPO,
                       check=True, capture_output=True, text=True, encoding="utf-8",
                       timeout=30)
    except (OSError, subprocess.SubprocessError):
        pytest.skip("no `origin/main` ref available in this checkout — an environment fact")
    unbumped = []
    for package_dir in SHIPPED:
        rel = package_dir.relative_to(_REPO).as_posix()
        # `origin/main...` (three dots) — the MERGE BASE, not the tip. With two dots, an
        # unrelated landing on main that touched one of these packages makes the premise true
        # for the wrong reason and demands a bump this branch never needed.
        changed = subprocess.run(
            ["git", "diff", "--name-only", "origin/main...", "--", rel],
            cwd=_REPO, capture_output=True, text=True, encoding="utf-8",
            timeout=60).stdout.strip()
        if not changed:
            continue
        merge_base = subprocess.run(
            ["git", "merge-base", "origin/main", "HEAD"],
            cwd=_REPO, capture_output=True, text=True, encoding="utf-8",
            timeout=30).stdout.strip() or "origin/main"
        base = subprocess.run(
            ["git", "show", f"{merge_base}:{rel}/manifest.yaml"],
            cwd=_REPO, capture_output=True, text=True, encoding="utf-8", timeout=30)
        if base.returncode != 0:
            continue  # a package that did not exist at the base has no version to move from
        was = _manifest_version(base.stdout)
        now = _manifest_version((package_dir / "manifest.yaml").read_text(encoding="utf-8"))
        if was is not None and was == now:
            unbumped.append(f"{package_dir.name}: files changed but version stayed {now}")
    assert not unbumped, (
        "a seed package changed without a `manifest.yaml` version bump, so an already-"
        "provisioned deployment would skip re-extraction and keep running the OLD package:\n  "
        + "\n  ".join(unbumped))
