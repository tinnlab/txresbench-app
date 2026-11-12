#!/usr/bin/env python3
# ruff: noqa
"""#296/#297/#298 — an image failure costs ONE image, and a BUG still costs the developer.

Both importers guard the whole per-image body with one tuple —
`(ome_writer.ImageConversionError, SD.SpatialDeclarationError, OSError)` — so that "no input
can abort the import". #292's escape sweep found three families still reaching past it, and
they are the same invariant with one shared mechanism:

  * **#296** `read_plane`'s `_PROGRAMMING_ERRORS` deny-list RE-RAISED six types the module had
    already measured arriving from DATA;
  * **#297** `write_ome_tiff` converted neither `MemoryError` nor an encode-time `tifffile`
    failure, though `read_image` and `downsample` deliberately do;
  * **#298** four smaller sites — an unwrapped re-open, deferred imports outside their `try`,
    `_reconcile_scale`'s unvalidated types, and a handler that raised while handling.

**The shape deliberately absent from this file is "it raises".** On `e0276408` every input
here DID raise; that is the defect. A test asserting an exception occurred is green against
the broken code and proves nothing. Every assertion instead names the TYPE against the tuple
PARSED OUT OF THE CALLERS' OWN SOURCE, names the original exception type in the message an
operator reads, or MUTATES the mechanism and requires the mutant to be caught.

Everything is parametrized over EVERY package shipping a `compute/ome_writer.py`, discovered
by glob. TEST-13 asserts those copies are byte-identical, so given that assert the behavioural
parametrization is redundant — it is kept as defence in depth for the reason the sibling suites
give: the byte guard is what would be narrowed or deleted first, and a behavioural assertion
survives its removal.

See `docs/design/image-failure-provenance-refusal.md`.
"""
import ast
import builtins
import contextlib
import hashlib
import importlib.util
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import image_boundary_guards as IBG  # noqa: E402

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports under a narrower rootdir.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from zero_core_guard import require_introducing_file  # noqa: E402

#: The path whose ADDITION arms the INV-6 comparison. Named once, so the guard and the control
#: below cannot point at different strings.
_ARMING_MARKER = "src-app/packages/spatial-types/tests/test_image_failure_provenance.py"


def test_the_arming_marker_names_a_real_file():
    """UNGATED. A marker that names nothing is a guard switched off, not a branch skipped.

    `require_introducing_file` takes its marker as a free string — the ONE thing it does not
    derive — so a typo, a rename or a deliberate edit disarms the assertion it gates,
    permanently, and the skip looks exactly like a branch whose premise merely does not hold.
    Its own docstring requires every caller to ship this line, and the three other
    marker-keyed modules in this tree do; this one did not. Measured: dropping ONE character
    from the marker left the whole file green with four silent skips.

    The invariant is sound by construction — the marker is a path the introducing branch ADDS,
    so on every later branch it is a file that EXISTS. Asserting nothing about any branch, this
    runs everywhere.
    """
    assert (_REPO / _ARMING_MARKER).is_file(), (
        f"the arming marker `{_ARMING_MARKER}` names no file in this tree, so the INV-6 "
        "byte-parity comparison can never run again on any branch — and would go on reporting "
        "a skip that says its premise merely does not hold.")

_PACKAGES = Path(__file__).resolve().parents[2]
_REPO = _PACKAGES.parents[1]
_SOURCE_PKG = _PACKAGES / "spatial-types"

#: `tifffile` stamps a fresh random UUID into the OME-XML on every write, so it is the one
#: thing that legally differs between two runs of identical code. Normalised away wherever two
#: emissions are compared as bytes.
_UUID_BYTES = re.compile(rb"urn:uuid:[0-9a-fA-F-]+")

#: Staged into `sys.modules` under their bare names and restored afterwards — three sibling
#: packages ship files of these names, and leaving one installed is how a suite ends up
#: asserting about another package's file. Copied from `test_ome_dtype_refusal.py`.
_STAGED = ("spatial_declarations", "ome_writer")

_H, _W = 60, 44


# ── staging (mirrors `test_ome_dtype_refusal.py`) ───────────────────────────────────


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
    """`compute/ome_writer.py` by PATH, with its own sibling `spatial_declarations`."""
    with _restoring_sys_modules():
        SD = _exec_by_path(
            "spatial_declarations", package_dir / "compute" / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", package_dir / "compute" / "ome_writer.py")
        yield OW, SD


def _shipped_writers():
    return tuple(sorted(p.parents[1] for p in _PACKAGES.glob("*/compute/ome_writer.py")))


SHIPPED = _shipped_writers()
IDS = [p.name for p in SHIPPED]


def _callers():
    return [path for path in sorted(_PACKAGES.glob("*/compute/import_*.py"))
            if "ome_writer.write_ome_tiff" in path.read_text()]


def _importer_guard_tuple(OW, SD):
    """The exception tuple BOTH importers actually wrote, resolved to real classes.

    THIS IS THE POINT OF THE WHOLE FILE. What makes a refusal cost one image rather than the
    import is that the raised type appears in the `except (...)` tuple the CALLER wrote — so
    the tuple is read out of the callers' source, never hardcoded here. A hardcoded copy stops
    testing that the moment a caller edits its line, which is the failure it exists to catch.
    """
    callers = _callers()
    assert len(callers) >= 2, (
        f"expected both importers to call `write_ome_tiff`, found {[str(c) for c in callers]}")
    tuples = {}
    for caller in callers:
        # BY `ast`, NOT BY REGEX — see `IBG.importer_guard_names`.
        tuples[caller.name] = IBG.importer_guard_names(caller.read_text())
    assert len(set(tuples.values())) == 1, (
        f"the importers guard DIFFERENT exception tuples: {tuples}. A refusal caught by one "
        "importer and not the other is not 'in the taxonomy the guards catch'.")
    resolved = []
    for name in next(iter(tuples.values())):
        if name.startswith("ome_writer."):
            resolved.append(getattr(OW, name.split(".", 1)[1]))
        elif name.startswith("SD."):
            resolved.append(getattr(SD, name.split(".", 1)[1]))
        else:
            resolved.append(getattr(builtins, name))
    assert all(isinstance(cls, type) for cls in resolved), resolved
    # A FLOOR, because everything else in this suite RESOLVES this tuple from the source and
    # then follows it wherever it goes. Measured: removing `OSError` from the per-image guard
    # in BOTH importers — which makes an unreadable image file abort the whole import —
    # produced exactly ONE failure in the whole tree, and none of it from this branch's tests.
    # Deriving the tuple is what keeps it honest about what the callers wrote; the floor is
    # what keeps "what they wrote" from silently shrinking.
    floor = {OW.ImageConversionError, SD.SpatialDeclarationError, OSError}
    assert floor <= set(resolved), (
        f"the importers' per-image guard has NARROWED to {sorted(c.__name__ for c in resolved)}; "
        f"it must still name at least {sorted(c.__name__ for c in floor)}. Dropping one of "
        "those does not make a test fail — every assertion in this suite reads the tuple out "
        "of the callers' source and would simply follow it down.")
    return tuple(resolved)


def _placement(SD, arr):
    return SD.image_meta(space=SD.coordinate_space(
        space="t", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
        extent={"width": int(arr.shape[1]), "height": int(arr.shape[0])}))


def _plane(dtype="uint16", samples=None):
    shape = (_H, _W) if samples is None else (_H, _W, samples)
    weights = (7, 13, 29)[: len(shape)]
    value = np.zeros(shape, dtype=np.int64)
    for axis, (length, weight) in enumerate(zip(shape, weights)):
        ramp = np.arange(length, dtype=np.int64) * weight
        value += ramp.reshape([-1 if i == axis else 1 for i in range(len(shape))])
    return (value % 251).astype(np.dtype(dtype))


# ── TEST-4 — the discriminator itself ───────────────────────────────────────────────


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_discriminator_answers_by_the_raising_site_not_by_the_type(package_dir):
    """TEST-4 — `raised_in_own_code` / `image_failure_is_a_bug`, on REAL tracebacks.

    Every case below is produced by RUNNING code, never by hand-assembling a traceback: the
    whole claim is about what the interpreter records as the innermost frame, so a faked
    traceback would be testing the fake. The same exception TYPE appears on both sides — that
    is the point, and it is what four attempts at partitioning the type space could not do.
    """
    with _staged_writer(package_dir) as (OW, _SD):
        here = __file__

        # A `TypeError` OURS...
        #
        # Rebound to a second name INSIDE each block on purpose: Python DELETES the `as`
        # target at the end of an `except` clause, so `mine` would be unbound out here — and
        # this test is entirely about the traceback each one carries.
        try:
            None + 1
        except Exception as caught:
            mine = caught
        # ...and a `TypeError` the library raised, from the SAME statement's point of view.
        # `json.loads` because it is PURE PYTHON — a C-extension frame is invisible to a
        # traceback and would be attributed to this file, which is the stated limitation the
        # `MemoryError` carve-out exists for and is not what this leg is measuring.
        try:
            json.loads(None)
        except Exception as caught:
            theirs = caught

        assert type(mine) is type(theirs) is TypeError, (
            f"this test's premise needs both to be TypeError; got {type(mine)}, {type(theirs)}")
        assert OW.raised_in_own_code(mine, here) is True, (
            "an exception raised by a line in this file must be attributed to this file")
        assert OW.raised_in_own_code(theirs, here) is False, (
            "an exception raised inside a library must NOT be attributed to the caller — "
            f"innermost frame was {theirs.__traceback__.tb_frame.f_code.co_filename}")
        assert OW.image_failure_is_a_bug(mine, here) is True
        assert OW.image_failure_is_a_bug(theirs, here) is False

        # `MemoryError` — converted whatever the site, on `read_image`'s own argument.
        try:
            raise MemoryError("a 170-megapixel plane")
        except Exception as caught:
            exhausted = caught
        assert OW.raised_in_own_code(exhausted, here) is True, (
            "the site rule still SEES it here; the carve-out is a deliberate exception to the "
            "rule, not a consequence of it")
        assert OW.image_failure_is_a_bug(exhausted, here) is False, (
            "resource exhaustion decoding or encoding ONE image is input-caused and "
            "recoverable — `read_image`'s policy comment settles this")

        # A deliberate refusal is already in the importers' taxonomy.
        try:
            raise OW.ImageConversionError("a deliberate refusal")
        except Exception as caught:
            refusal = caught
        assert OW.image_failure_is_a_bug(refusal, here) is False

        # An exception with NO traceback cannot be attributed; unattributable is treated as
        # data, which is the direction that costs one image rather than the import.
        assert OW.raised_in_own_code(ValueError("never raised"), here) is False
        assert OW.image_failure_is_a_bug(ValueError("never raised"), here) is False


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_discriminator_is_not_fooled_by_a_symlinked_or_relative_module_path(package_dir):
    """TEST-4 — the same file named two ways is the same file.

    `co_filename` is whatever string the compiler was given. A boundary passing `__file__`
    from a differently-spelled path — a relative launch, a symlinked worktree — must still be
    recognised as itself, or the propagate arm silently stops firing and every bug becomes a
    skipped image. Realpath is what makes that true, and this is its regression pin.
    """
    with _staged_writer(package_dir) as (OW, _SD):
        try:
            raise KeyError("mine")
        except Exception as caught:
            mine = caught
        # THREE REAL SECOND SPELLINGS, not one synthetic detour. The first version of this
        # test only built an up-and-back-down `..` path while its docstring claimed symlink and
        # relative-path coverage it did not have.
        here = Path(__file__).resolve()

        # (a) a `..` detour
        detour = str(here.parent / ".." / here.parent.name / here.name)
        assert detour != __file__, "this leg needs two spellings of one path"
        assert OW.raised_in_own_code(mine, detour) is True

        # (b) a real SYMLINK to this file, from a directory that is not this one
        with tempfile.TemporaryDirectory() as scratch:
            link = Path(scratch) / "linked_test_file.py"
            try:
                link.symlink_to(here)
            except (OSError, NotImplementedError):      # a filesystem that cannot symlink
                pytest.skip("this filesystem does not support symlinks — an environment fact")
            assert OW.raised_in_own_code(mine, str(link)) is True, (
                "a symlinked worktree spells the same file two ways; `realpath` is what has "
                "to collapse them, and without it the propagate arm silently stops firing")

        # (c) a RELATIVE path, resolved against the current working directory
        import os as os_module
        saved_cwd = os_module.getcwd()
        try:
            os_module.chdir(here.parent)
            assert OW.raised_in_own_code(mine, here.name) is True
            # ...and the honest other half: the SAME relative spelling from a DIFFERENT working
            # directory does not match. That is the residue this design records, and the failure
            # direction is CONVERT — one image lost, never a data error propagated as a bug.
            os_module.chdir(here.parent.parent)
            assert OW.raised_in_own_code(mine, here.name) is False
        finally:
            os_module.chdir(saved_cwd)


# ── TEST-7 — the message names the type an operator must act on ─────────────────────


#: Injected into the encode and required to come back NAMED. Each is a real escape #297 or the
#: residue sweep measured, and each has a DISTINCTIVE `__name__` — `struct.error.__name__` is
#: the substring-trivial `"error"`, so it is asserted through the `"(<Name>: "` shape below
#: rather than by bare containment.
_ENCODE_FAILURES = ("MemoryError", "ValueError", "TiffFileError", "struct.error")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("spelling", _ENCODE_FAILURES, ids=_ENCODE_FAILURES)
def test_the_converted_refusal_names_the_original_exception_type(
        package_dir, spelling, tmp_path):
    """TEST-7 (INV-4) — a resource problem must not read like a data problem.

    This is the property `read_image`'s own comment claims for its arm: `images_not_emitted`
    NAMES the exception type "so an operator sees a resource problem rather than a data one".
    A refusal a user cannot act on is a crash with better manners.

    Asserted through the `"(<Name>: "` shape rather than by bare containment, because
    `struct.error.__name__` is `"error"` and a containment check on that string passes on
    almost any English sentence — the boilerplate-passes-the-test defect #292 hit and wrote
    down.
    """
    import tifffile

    with _staged_writer(package_dir) as (OW, SD):
        guarded = _importer_guard_tuple(OW, SD)
        arr = _plane()
        exc = {"MemoryError": MemoryError("simulated"),
               "ValueError": ValueError("tifffile refused this array"),
               "TiffFileError": tifffile.TiffFileError("corrupt"),
               "struct.error": struct.error("bad pack")}[spelling]

        saved = tifffile.TiffWriter.write

        def boom(*args, **kwargs):
            raise exc

        tifffile.TiffWriter.write = boom
        try:
            with pytest.raises(guarded) as raised:
                OW.write_ome_tiff(tmp_path / f"{spelling}.ome.tif", arr,
                                  placement=_placement(SD, arr))
        finally:
            tifffile.TiffWriter.write = saved

        message = str(raised.value)
        assert f"({type(exc).__name__}: " in message, (
            f"the refusal must name the original exception type as `({type(exc).__name__}: "
            f"...)`; got {message!r}")
        assert not list(tmp_path.glob("*.partial")), (
            f"the staging file survived a converted failure: {list(tmp_path.glob('*.partial'))}")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_a_memoryerror_in_the_contiguous_copy_is_converted_and_named(package_dir, tmp_path):
    """TEST-7 (INV-4) — #297's OTHER leg: the allocation, which was outside every `try`.

    `np.ascontiguousarray` allocates a whole second plane and sat outside every handler, while
    `downsample`'s docstring — eleven hundred lines away in the same file — states that "the
    reshape and the reduction ALLOCATE, so a large plane can raise `MemoryError` here" and
    converts it on purpose. The identical reasoning reached the opposite behaviour.
    """
    with _staged_writer(package_dir) as (OW, SD):
        guarded = _importer_guard_tuple(OW, SD)
        arr = _plane()
        saved = np.ascontiguousarray

        def boom(*args, **kwargs):
            raise MemoryError("simulated: the contiguous copy did not fit")

        np.ascontiguousarray = boom
        try:
            with pytest.raises(guarded) as raised:
                OW.write_ome_tiff(tmp_path / "alloc.ome.tif", arr,
                                  placement=_placement(SD, arr))
        finally:
            np.ascontiguousarray = saved
        assert "(MemoryError: " in str(raised.value), str(raised.value)


# ── TEST-10 — every deferred import is inside a converting `try` ────────────────────


#: The functions that run INSIDE the importers' per-image guard and defer an import. A
#: deferred import outside its `try` raised `ImportError`, which is in neither importer's
#: guard tuple, so a `pillow`/`tifffile` missing from the analysis rootfs cost the matrix, the
#: coordinates, the columns and the report over one image (#298 E2).
_DEFERRING_FUNCTIONS = ("read_image", "downsample", "write_ome_tiff", "tifffile_version")


def _imports_outside_a_try(source, function_name):
    tree = ast.parse(source)
    target = next((n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name == function_name), None)
    if target is None:
        return [f"there is no `{function_name}` here to check"]
    inside = set()
    for node in ast.walk(target):
        if isinstance(node, ast.Try):
            for stmt in node.body:
                for inner in ast.walk(stmt):
                    if isinstance(inner, (ast.Import, ast.ImportFrom)):
                        inside.add(id(inner))
    return [f"{function_name}:{n.lineno} `{ast.unparse(n)}`"
            for n in ast.walk(target)
            if isinstance(n, (ast.Import, ast.ImportFrom)) and id(n) not in inside]


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_no_deferred_import_sits_outside_the_try_that_converts_around_it(package_dir):
    """TEST-10 — #298 E2, structurally.

    The rootfs pins `numpy`, `tifffile` and `pillow`, so this is unlikely — and the whole
    point of a per-image guard is that the unlikely input costs one image too.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    offenders = []
    for function_name in _DEFERRING_FUNCTIONS:
        offenders += _imports_outside_a_try(source, function_name)
    assert not offenders, (
        f"{package_dir.name}'s `ome_writer.py` defers an import outside the `try` that "
        f"converts around it: {offenders}. `ImportError` is in neither importer's guard "
        "tuple, so it costs the whole import rather than one image (#298 E2).")


def test_no_deferred_import_in_read_plane_sits_outside_its_try():
    """TEST-10 — the same check for `xenium_image.read_plane`, which is not vendored."""
    path = _PACKAGES / "spatial-import-xenium" / "compute" / "xenium_image.py"
    offenders = _imports_outside_a_try(path.read_text(), "read_plane")
    assert not offenders, (
        f"`xenium_image.read_plane` defers an import outside its converting `try`: {offenders}")


#: THE ONE ABSENCE FIXTURE, shared with the visium suite via `image_boundary_guards`. It used
#: to live here, and the copy in the other suite kept shape (2) for a round after this one
#: replaced it — see that function's docstring for what shape (2) got wrong and what it cost.
_module_really_absent = IBG.module_really_absent


def test_the_absent_module_fixture_reproduces_a_real_missing_module(tmp_path):
    """TEST-10 — the control for the control, asserting the thing that actually matters.

    A fixture that fails to deprive anything makes every leg below pass while proving nothing.
    But the subtler requirement — and the one two earlier fixtures got wrong — is WHERE the
    exception is attributed: the mechanism reads the innermost traceback frame, so a fixture
    that raises from the TEST file exercises the opposite case from the one it claims to.

    So this asserts the frame is a SEPARATE module's import line, not this file's. An earlier
    control asserted `co_filename == __file__`, which the broken fixture satisfied because the
    blocker lived here.
    """
    boundary = Path(tmp_path) / "a_boundary_module.py"
    boundary.write_text("def touch():\n    import tifffile\n    return tifffile\n")
    module = _exec_source_as(boundary.read_text(), boundary, "a_boundary_module")

    with _module_really_absent("tifffile"):
        with pytest.raises(ModuleNotFoundError) as raised:
            module.touch()
    assert raised.value.name == "tifffile", (
        f"a real missing module reports its own name; got {raised.value.name!r}")
    tb = raised.value.__traceback__
    while tb.tb_next is not None:
        tb = tb.tb_next
    assert tb.tb_frame.f_code.co_filename == str(boundary), (
        "a missing module must be attributed to the IMPORTING module's own line. It was "
        f"attributed to {tb.tb_frame.f_code.co_filename} — if that is this test file, the "
        "fixture is raising from its own frame and every leg below is exercising the opposite "
        "case from the one it claims to.")
    import tifffile  # noqa: F401 — and it comes back afterwards


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("entry", ["write_ome_tiff", "tifffile_version", "downsample"],
                         ids=["write_ome_tiff", "tifffile_version", "downsample"])
def test_an_unimportable_library_costs_one_image_in_the_importers_taxonomy(
        package_dir, entry, tmp_path):
    """TEST-10 — the BEHAVIOURAL half, at EVERY boundary that defers an import.

    The `ast` check above proves PLACEMENT; only this proves conversion. All three entry points
    are driven, because the first version of this test exercised `write_ome_tiff` alone — the
    one function that then had a dedicated `except ImportError` — while `tifffile_version` and
    `read_plane` were both re-raising, and `import_visium` calls `tifffile_version` inside its
    guarded body BEFORE `write_ome_tiff`, on a PNG, so nothing has imported `tifffile` yet.
    That is a real, reachable, whole-import abort that the narrower test could not see.
    """
    with _staged_writer(package_dir) as (OW, SD):
        guarded = _importer_guard_tuple(OW, SD)
        arr = _plane()
        placement = _placement(SD, arr)
        calls = {
            "write_ome_tiff": lambda: OW.write_ome_tiff(
                tmp_path / "noimport.ome.tif", arr, placement=placement),
            "tifffile_version": lambda: OW.tifffile_version(),
            "downsample": lambda: OW.downsample(arr, 2),
        }
        with _module_really_absent("tifffile" if entry != "downsample" else "numpy"):
            with pytest.raises(guarded) as raised:
                calls[entry]()
        assert "ModuleNotFoundError" in str(raised.value) or "ImportError" in str(raised.value), (
            f"the refusal must NAME the import failure so an operator sees a HOST problem "
            f"rather than a damaged bundle; got {str(raised.value)!r}")


def test_an_unimportable_library_costs_one_image_in_read_plane_too():
    """TEST-10 — `xenium_image.read_plane`, which is not vendored and has its own copy of this.

    Its comment claimed the fix and the site rule then undid it: `importlib` raises a missing
    module on the `import` statement's own line, so the innermost frame was `xenium_image.py`
    and the handler re-raised. Driven here rather than asserted.
    """
    with _restoring_sys_modules():
        compute = _PACKAGES / "spatial-import-xenium" / "compute"
        SD = _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")
        XI = _exec_by_path("xenium_image_noimport", compute / "xenium_image.py")
        guarded = _importer_guard_tuple(OW, SD)
        with _module_really_absent("tifffile"):
            with pytest.raises(guarded) as raised:
                XI.read_plane(Path("/nonexistent/whatever.ome.tif"))
        assert "ModuleNotFoundError" in str(raised.value) or "ImportError" in str(raised.value), (
            f"got {str(raised.value)!r}")


# ── TEST-8 (INV-2) — a bug in the WRITER's own code still propagates ────────────────
#
# The mutation proof for INV-2 covered `read_plane` alone. A blind audit installed a mutant
# that made `write_ome_tiff` swallow EVERY bug and all three suites passed with zero failures:
# the only red was the guard test complaining that its literal `str.replace` text no longer
# matched, which is not detection. These are the missing behavioural half.

#: A bug introduced into `write_ome_tiff`'s OWN code, at each of the three regions this branch
#: wrapped. Each raises from a line in `ome_writer.py`, so each must PROPAGATE — a genuine
#: logic bug must never come back to a user as a skipped image with the import reporting
#: success (INV-2, `docs/design/ome-tiff-dtype-refusal.md` INV-4).
_A_TYPO = "_a_name_this_module_does_not_define"

#: A bug introduced into `write_ome_tiff`'s OWN code, at each of the three regions this branch
#: wrapped. Each is a `NameError`, which the INTERPRETER raises at the offending line, so the
#: innermost frame is unambiguously `ome_writer.py` — that is what makes these a test of the
#: propagate arm rather than of numpy's internals. (An earlier draft used
#: `np.ascontiguousarrayy`. numpy 2.x resolves an unknown module attribute through its own
#: `__getattr__`, so that `AttributeError` is raised inside `numpy/__init__.py` and the site
#: rule CORRECTLY converts it — the mutant was testing numpy, not this file.)
#:
#: Each anchor is a UNIQUE two-line span for a reason: `"        import numpy as np\n"` is a
#: SUBSTRING of the twelve-space import in `read_image`'s PIL branch, so replacing it produced
#: a syntactically broken module rather than a mutant.
_WRITER_BUG_MUTANTS = {
    "in-the-import-block": (
        "        import numpy as np\n        import tifffile\n",
        f"        import numpy as np\n        import tifffile\n        _ = {_A_TYPO}\n"),
    "in-the-allocation-block": (
        "        arr = np.ascontiguousarray(arr)\n",
        f"        arr = np.ascontiguousarray(arr)\n        _ = {_A_TYPO}\n"),
    "in-the-encode-block": (
        "        os.replace(staging, dest)\n",
        f"        _ = {_A_TYPO}\n        os.replace(staging, dest)\n"),
}


@pytest.mark.parametrize("bug", sorted(_WRITER_BUG_MUTANTS), ids=sorted(_WRITER_BUG_MUTANTS))
def test_a_bug_in_the_writers_own_code_still_propagates(bug, tmp_path):
    """TEST-8 (INV-2) — the propagate arm of `write_ome_tiff`, MUTATION-proved.

    One mutant per region this branch wrapped: the deferred-import block, the contiguous-copy
    block and the encode block. Each introduces a fault in `ome_writer.py`'s OWN code, so each
    must come out of the function UNCONVERTED.

    The CONTROL is in this test: the un-mutated source, executed the same way, must EMIT —
    otherwise "it raised" would be satisfied by a broken exec harness rather than by the bug.
    """
    path = _SOURCE_PKG / "compute" / "ome_writer.py"
    shipped = path.read_text()
    with _restoring_sys_modules():
        SD = _exec_by_path("spatial_declarations",
                           _SOURCE_PKG / "compute" / "spatial_declarations.py")
        arr = _plane()
        placement = _placement(SD, arr)

        control = _exec_source_as(shipped, path, "ome_writer")
        control.write_ome_tiff(tmp_path / "control.ome.tif", arr, placement=placement)

        old, new = _WRITER_BUG_MUTANTS[bug]
        mutated_source = shipped.replace(old, new)
        assert mutated_source != shipped, (
            f"the {bug!r} mutation matched nothing in the shipped `ome_writer.py`, so the "
            "propagate arm was never challenged. Re-derive it from the current source.")
        mutant = _exec_source_as(mutated_source, path, "ome_writer")
        with pytest.raises(Exception) as raised:
            mutant.write_ome_tiff(tmp_path / f"{bug}.ome.tif", arr, placement=placement)
        assert not isinstance(raised.value, mutant.ImageConversionError), (
            f"a bug {bug} was CONVERTED into {raised.value!r}. A genuine logic bug in the "
            "writer must not come back to a user as a skipped image while the import reports "
            "SUCCESS — that is `read_image`'s attempt-1 failure, and INV-4 forbids it.")
        assert isinstance(raised.value, NameError), (
            f"expected the mutant's own NameError, got "
            f"{type(raised.value).__name__}: {raised.value}")


def _exec_source_as(source, path, name):
    """`source` executed under `path`'s `__file__` — the value the site rule compares against.

    Running a mutant under a temp filename would make every mutant look like third-party code
    and turn these tests green for the wrong reason.
    """
    import types

    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


# ── TEST-11 — `_reconcile_scale` refuses in its OWN taxonomy ────────────────────────


#: Each is a HAND-BUILT `display_derivative`/placement that reached arithmetic in
#: `_reconcile_scale` and raised a bare `TypeError` or a second `KeyError` — neither of which
#: is `SpatialDeclarationError`, neither of which either importer catches (#298 E3).
_HAND_BUILT_PLACEMENTS = {
    "original_extent-is-not-a-mapping": ("original_extent", "not a mapping"),
    "original_extent-missing-width": ("original_extent", {"height": _H}),
    "original_extent-width-is-a-string": ("original_extent", {"width": "44", "height": _H}),
    "applied_resolution_um-is-not-a-number": ("applied_resolution_um", "0.5"),
    "to_space-element-is-not-a-number": ("to_space", ["1.0", 0, 0, 0, 1.0, 0]),
}


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("case", sorted(_HAND_BUILT_PLACEMENTS), ids=sorted(_HAND_BUILT_PLACEMENTS))
def test_a_hand_built_placement_is_refused_in_the_importers_taxonomy(package_dir, case):
    """TEST-11 — #298 E3, on the caller shape this function's own docstring exists for.

    UNREACHABLE THROUGH EITHER IMPORTER TODAY — both build the block through `SD.image_meta` —
    and that is exactly why it is recorded: this function's docstring says it exists for the
    case where "the pixels and the declaration are both in scope", which is the hand-built
    caller. The `except KeyError` already in the function covers only the four TOP-LEVEL keys
    and the `downsample_factor` validation covers only the factor; these were the values left.
    """
    with _staged_writer(package_dir) as (OW, SD):
        guarded = _importer_guard_tuple(OW, SD)
        arr = _plane()
        factor = 1
        derivative = {
            "downsample_factor": factor,
            "applied_resolution_um": 0.5,
            "emitted_extent": {"width": _W, "height": _H},
            "original_extent": {"width": _W, "height": _H},
        }
        # THE FLAT SHAPE `SD.image_meta` PRODUCES — `coordinate_space` is the space's ID
        # string and `microns_per_pixel` sits at the top level. Built by hand here because
        # that is the caller `_reconcile_scale`'s own docstring exists for; a nested guess at
        # this shape would be refused for the wrong reason and prove nothing.
        placement = {
            "coordinate_space": "t",
            "unit": "pixel",
            "microns_per_pixel": 0.5,
            "to_space": [1.0, 0, 0, 0, 1.0, 0],
            "extent": {"width": _W, "height": _H},
            "display_derivative": derivative,
        }
        key, value = _HAND_BUILT_PLACEMENTS[case]
        if key == "to_space":
            placement["to_space"] = value
        else:
            derivative[key] = value

        # The CONTROL — the same placement with NOTHING broken — is its own test below
        # (`..._control_reconciles_when_nothing_is_broken`), so "it raised" here cannot be
        # satisfied by a placement `_reconcile_scale` rejects for an unrelated reason.
        with pytest.raises(guarded) as raised:
            OW._reconcile_scale(placement, arr, 0.5)
        assert isinstance(raised.value, SD.SpatialDeclarationError), (
            f"a bad DECLARATION must be refused in the declaration taxonomy, not as a bare "
            f"{type(raised.value).__name__}: {raised.value}")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_hand_built_placement_control_reconciles_when_nothing_is_broken(package_dir):
    """TEST-11 — the control for TEST-11.

    Without it, every leg above would be satisfied by a placement `_reconcile_scale` rejects
    for a reason that has nothing to do with the value under test.
    """
    with _staged_writer(package_dir) as (OW, SD):
        arr = _plane()
        placement = {
            "coordinate_space": "t",
            "unit": "pixel",
            "microns_per_pixel": 0.5,
            "to_space": [1.0, 0, 0, 0, 1.0, 0],
            "extent": {"width": _W, "height": _H},
            "display_derivative": {
                "downsample_factor": 1,
                "applied_resolution_um": 0.5,
                "emitted_extent": {"width": _W, "height": _H},
                "original_extent": {"width": _W, "height": _H},
            },
        }
        OW._reconcile_scale(placement, arr, 0.5)   # must not raise


# ── TEST-15 — no deny-list or allow-list of exception TYPES was reintroduced ────────


#: THE ONE GUARD, shared with `test_ome_dtype_refusal`. There were two of it — a strong one
#: applied to `write_ome_tiff` alone and a weak one applied to five boundaries, eighteen
#: identical lines apart — and the copy applied broadly was the one that checked least, which
#: is how two boundaries came to be guarded by nothing. See `image_boundary_guards` for the two
#: POLICIES it now enforces and why they are opposite and both correct.
_NAMED_REFUSALS = IBG.NAMED_REFUSALS
_SITE_RULE = IBG.SITE_RULE


@pytest.mark.parametrize("boundary", IBG.BOUNDARIES,
                         ids=lambda b: f"{b[0]}:{b[2]}" if isinstance(b, tuple) else str(b))
def test_no_boundary_filters_on_the_exception_type(boundary):
    """TEST-15 (INV-3) — the discriminator is the SITE, and no filter may creep back.

    `_PROGRAMMING_ERRORS` was attempt 2 reintroduced in a sibling file a year after attempt 2
    was measured wrong, and nothing in the tree could see it happen. This is what would have —
    now over EVERY boundary, each under its declared policy, including the one in an IMPORTER
    that both predecessors of this test omitted.
    """
    package, filename, function_name, policy = boundary
    source = (_PACKAGES / package / "compute" / filename).read_text()
    offenders = IBG.boundary_offenders(source, function_name, policy)
    assert not offenders, (
        f"{package}/{filename} violates its `{policy}` policy: {offenders}. Only "
        f"{sorted(_NAMED_REFUSALS)} may be caught by name. A deny-list of bug types and an "
        "allow-list of decoder errors are attempts 2 and 3 of `read_image`'s own four-attempt "
        f"history, and both were measured wrong (#296, INV-3).")


#: Every spelling of the deleted deny-list a blind audit either DEMONSTRATED walking past an
#: earlier version of this guard, or that a maintainer would plausibly reach for next.
_DENY_LIST_SPELLINGS = {
    "inline-tuple": (
        "    except Exception as exc:\n",
        "    except (AttributeError, TypeError, KeyError, IndexError, ZeroDivisionError,\n"
        "            NameError):\n        raise\n    except Exception as exc:\n"),
    "narrowed-inline-tuple": (
        "    except Exception as exc:\n",
        "    except (AttributeError, NameError, KeyError):\n"
        "        raise\n    except Exception as exc:\n"),
    "module-level-constant": (
        "import re\n",
        "import re\n_PROGRAMMING_ERRORS = (AttributeError, TypeError, KeyError, IndexError,\n"
        "                       ZeroDivisionError, NameError)\n"),
    "annotated-constant": (
        "import re\n",
        "import re\n_PROGRAMMING_ERRORS: tuple = (AttributeError, TypeError, KeyError,\n"
        "                              IndexError, ZeroDivisionError, NameError)\n"),
    "single-named-bug-type": (
        "    except Exception as exc:\n",
        "    except AttributeError:\n        raise\n    except Exception as exc:\n"),
    "allow-list-of-decoder-errors": (
        "    except Exception as exc:\n",
        "    except (ValueError, ZeroDivisionError) as exc:\n"
        "        raise ome_writer.ImageConversionError('decoder')\n"
        "    except Exception as exc:\n"),
}


@pytest.mark.parametrize("spelling", sorted(_DENY_LIST_SPELLINGS), ids=sorted(_DENY_LIST_SPELLINGS))
def test_the_type_filter_guard_catches_every_spelling_of_the_deny_list(spelling):
    """TEST-15 (INV-3) — the guard, mutated six ways, and required to be RED on each.

    A structural guard that has never been shown to fire is a guard nobody has tested — and
    this one HAD a hole: an earlier version looked for the deleted constant's NAME, so the same
    deny-list written inline walked past it, and with the tuple narrowed to types no test drives
    from data the whole suite stayed green. Two of the six below are that demonstrated evasion;
    the other four are the shapes a maintainer reaches for next.
    """
    path = _PACKAGES / "spatial-import-xenium" / "compute" / "xenium_image.py"
    shipped = path.read_text()
    assert not IBG.boundary_offenders(shipped, "read_plane", IBG.POLICY_SITE_RULE), (
        "the SHIPPED source already has offenders, so these mutants prove nothing")
    old, new = _DENY_LIST_SPELLINGS[spelling]
    mutated = shipped.replace(old, new, 1)
    assert mutated != shipped, (
        f"the {spelling!r} mutation matched nothing in the shipped source, so the guard was "
        "never actually challenged. Re-derive it from the current source.")
    if spelling in ("module-level-constant", "annotated-constant"):
        mutated = mutated.replace(
            "    except Exception as exc:\n",
            "    except _PROGRAMMING_ERRORS:\n        raise\n    except Exception as exc:\n",
            1)
    assert IBG.boundary_offenders(mutated, "read_plane", IBG.POLICY_SITE_RULE), (
        f"the {spelling!r} deny-list was reintroduced into `read_plane` and this guard did not "
        "notice, which is precisely the year-long silence #296 records.")


#: Every way to satisfy the site-rule shape's LETTER while destroying its point, plus the one a
#: later audit found the guard blind to entirely: passing the WRONG FILE, which makes the
#: predicate answer False for everything while the handler still reads as guarded.
_SITE_RULE_EVASIONS = {
    "absent": ("        if image_failure_is_a_bug(exc, __file__):\n            raise\n", ""),
    "never-obeyed": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if image_failure_is_a_bug(exc, __file__):\n            pass\n"),
    "inverted": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if image_failure_is_a_bug(exc, __file__):\n            pass\n"
        "        else:\n            raise\n"),
    "negated": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if not image_failure_is_a_bug(exc, __file__):\n            raise\n"),
    "dead-condition": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if False and image_failure_is_a_bug(exc, __file__):\n            raise\n"),
    "nested-out-of-reach": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if not isinstance(exc, BaseException):\n"
        "            if image_failure_is_a_bug(exc, __file__):\n                raise\n"),
    "converts-instead-of-propagating": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if image_failure_is_a_bug(exc, __file__):\n"
        "            raise ImageConversionError('a bug, reported as a skipped image')\n"),
    "wrong-file-argument": (
        "        if image_failure_is_a_bug(exc, __file__):\n            raise\n",
        "        if image_failure_is_a_bug(exc, 'spatial_declarations.py'):\n            raise\n"),
}


@pytest.mark.parametrize("evasion", sorted(_SITE_RULE_EVASIONS), ids=sorted(_SITE_RULE_EVASIONS))
def test_the_site_rule_shape_is_not_satisfied_by_naming_the_discriminator(evasion):
    """TEST-8 (INV-2) — eight ways to fake the guard, each required RED.

    A guard that admits a CONDITION is worth exactly what it costs to evade, and this one was
    evaded four ways on the shipped source by one blind audit and a fifth (`wrong-file-argument`)
    by another: the guard validated the callee NAME and never looked at the arguments, so every
    call could be rewritten to pass a sibling module's path — which makes the predicate answer
    False for everything while the handler still READS as guarded.
    """
    path = _SOURCE_PKG / "compute" / "ome_writer.py"
    shipped = path.read_text()
    assert not IBG.boundary_offenders(shipped, "write_ome_tiff", IBG.POLICY_SITE_RULE), (
        "the SHIPPED source already has offenders, so these mutants prove nothing")
    old, new = _SITE_RULE_EVASIONS[evasion]
    mutated = shipped.replace(old, new)
    assert mutated != shipped, (
        f"the {evasion!r} mutation matched nothing in the shipped source, so the guard was "
        "never challenged. Re-derive it from the current handler.")
    assert IBG.boundary_offenders(mutated, "write_ome_tiff", IBG.POLICY_SITE_RULE), (
        f"the {evasion!r} evasion passed the guard. A broad handler that does not both ASK "
        f"`{IBG.SITE_RULE}(exc, __file__)` and RE-RAISE on it swallows a genuine logic bug and "
        "reports it to the user as a skipped image, which is what this guard refuses.")


def test_the_coverage_policy_boundaries_are_not_forced_into_the_site_rule_shape():
    """TEST-15 — the two policies are OPPOSITE and both are correct.

    `read_image` and `downsample` convert everything unconditionally. That is attempt 4 of
    `read_image`'s own history and its justification is COVERAGE — every decode branch is
    exercised, so a typo goes red before it can reach a user as a bad image. A guard that
    demanded the site-rule shape everywhere would order that reverted; one that accepted
    `except Exception` everywhere is the weak guard this replaced. The policy is data, and this
    is the control proving the two arms of it actually differ.
    """
    source = (_SOURCE_PKG / "compute" / "ome_writer.py").read_text()
    for function_name in ("read_image", "downsample"):
        assert not IBG.boundary_offenders(source, function_name, IBG.POLICY_COVERAGE), (
            f"`{function_name}` is a COVERAGE-policy boundary and must be admitted as it is")
        assert IBG.boundary_offenders(source, function_name, IBG.POLICY_SITE_RULE), (
            f"`{function_name}` passed the SITE-RULE policy, so the two policies do not "
            "actually differ and declaring them separately buys nothing")


# ── TEST-13 — the vendored copies and the manifest versions ─────────────────────────


@pytest.mark.parametrize("filename", ["ome_writer.py", "spatial_declarations.py"])
def test_every_shipped_copy_is_byte_identical(filename):
    """TEST-13 (INV-5) — a vendored file that drifts is a second implementation.

    A FLOOR of three is asserted alongside the identity, because an identity assertion over
    one surviving copy is vacuously true — that is how a package silently stops being covered.
    """
    copies = sorted(_PACKAGES.glob(f"*/compute/{filename}"))
    assert len(copies) >= 3, (
        f"expected at least three packages shipping `compute/{filename}`, found "
        f"{[str(c) for c in copies]}. A copy that VANISHED is a package that stopped being "
        "covered by every test in this file.")
    digests = {}
    for path in copies:
        digests.setdefault(hashlib.sha256(path.read_bytes()).hexdigest(), []).append(
            path.parents[1].name)
    assert len(digests) == 1, (
        f"the vendored `{filename}` copies have DRIFTED: {digests}. The canonical copy is "
        f"`spatial-types/compute/{filename}`; re-vendor it into the others.")


# TEST-13's version-bump half lives in `test_ome_dtype_refusal.py`, NOT here. This file had a
# VERBATIM COPY of it, which was two defects at once: a second expression of one rule that can
# drift from the first (both parametrize over the same `SHIPPED` glob, so the copy covered
# nothing extra), and a second module reading git history — which is what
# `_lib/test_zero_core_guard.py` caught. The shipped one is exempted there BY NAME, with the
# self-limiting argument written down; duplicating it would have meant duplicating the pardon.


# ── TEST-14 — THE RESIDUE SWEEP, EXECUTED ───────────────────────────────────────────
#
# #292's value was the SWEEP, not the patch: it found 64 escaping `(dtype, S)` pairs where the
# issue had reported one family. So the enumeration of what still escapes is written here as a
# TEST rather than as prose, because prose records what a sweep FOUND and a test is what keeps
# it true. MEASURED on this branch and on `e0276408`, with the same battery:
#
#            inputs   escaped on e0276408   escaped on this branch
#   decode     672     28 (ZeroDivisionError 23, TypeError 4, IndexError 1)      0
#   encode      66     44 (11 distinct types, at all four third-party call sites) 0
#
# The decode escapes are exactly the three types #296 names, and every one of them aborted the
# whole import: the matrix, the coordinates, the columns and the report, over one damaged file.


def _sweep_source_tiff(tmp_path):
    """A small real TIFF whose bytes the decode sweep mutates."""
    import tifffile

    path = Path(tmp_path) / "sweep-source.tif"
    tifffile.imwrite(str(path), _plane()[:16, :20], photometric="minisblack", ome=False)
    return path


#: How far into the file the decode sweep mutates. The header, the IFD and every tag of a
#: `tifffile`-written plane live inside this; past it is pixel data, where a flipped byte
#: changes a measurement rather than a structure and cannot make the reader fail.
_SWEEP_PREFIX_BYTES = 300


def test_no_mutated_or_truncated_tiff_escapes_the_importers_guards(tmp_path):
    """TEST-14 (INV-1) — the DECODE residue, swept rather than reasoned about.

    Every byte of the header/IFD region is set to `0x00` and to `0xFF`, and the file is
    truncated at every length up to 64 bytes plus five larger ones, and each mutant is driven
    through the REAL `read_plane`. An escape is a failure whose type is not in the tuple both
    importers wrote — which is to say, an input that costs the whole import.

    THE CONTROL IS THE COUNT. A sweep in which nothing succeeded and nothing failed would
    trivially report zero escapes, so the outcome tally is asserted to contain BOTH successful
    reads and refusals — the sweep has to be doing something.
    """
    sys.path.insert(0, str(_PACKAGES / "spatial-import-xenium" / "compute"))
    with _restoring_sys_modules():
        SD = _exec_by_path("spatial_declarations",
                           _PACKAGES / "spatial-import-xenium" / "compute" / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer",
                           _PACKAGES / "spatial-import-xenium" / "compute" / "ome_writer.py")
        XI = _exec_by_path("xenium_image_swept",
                           _PACKAGES / "spatial-import-xenium" / "compute" / "xenium_image.py")
        guarded = _importer_guard_tuple(OW, SD)

        source = _sweep_source_tiff(tmp_path)
        raw = source.read_bytes()
        target = Path(tmp_path) / "mutant.tif"
        escapes, refused, succeeded = [], 0, 0

        def drive(label):
            nonlocal refused, succeeded
            try:
                XI.read_plane(target)
                succeeded += 1
            except guarded:
                refused += 1
            except BaseException as exc:      # noqa: BLE001 — the sweep's whole purpose
                escapes.append(f"{label}: {type(exc).__name__}: {str(exc)[:80]}")

        for offset in range(min(len(raw), _SWEEP_PREFIX_BYTES)):
            for value in (0x00, 0xFF):
                mutant = bytearray(raw)
                mutant[offset] = value
                target.write_bytes(bytes(mutant))
                drive(f"byte {offset} := {value:#04x}")
        for length in list(range(0, 64)) + [100, 200, 1000, 4096, len(raw) // 2]:
            target.write_bytes(raw[:length])
            drive(f"truncated to {length}")
        for label, data in (("empty", b""), ("plain text", b"hello world" * 10),
                            ("png magic", b"\x89PNG\r\n\x1a\n" + b"\0" * 100)):
            target.write_bytes(data)
            drive(label)

    assert succeeded and refused, (
        f"the sweep neither read anything ({succeeded}) nor refused anything ({refused}), so "
        "'zero escapes' is vacuous — the mutation region is probably wrong")
    assert not escapes, (
        f"{len(escapes)} decode inputs ESCAPED both importers' guards, so each costs the "
        "matrix, the coordinates, the columns and the report rather than one image. First "
        f"ten:\n  " + "\n  ".join(escapes[:10]))


#: Every third-party call `write_ome_tiff` makes, and a spread of what each could raise. The
#: types are not an allow-list the code consults — that is the point — they are the sweep's
#: input, chosen to cover the families #297 names (`MemoryError`, a bare `ValueError`,
#: `struct.error`), the families #292 measured (`OmeXmlError`'s neighbours `KeyError` and
#: `ValueError`), and the six the deleted deny-list re-raised.
_ENCODE_SITES = ("np.ascontiguousarray", "TiffWriter", "TiffWriter.write", "os.replace")
_ENCODE_INJECTIONS = ("MemoryError", "ValueError", "struct.error", "TiffFileError", "KeyError",
                      "IndexError", "ZeroDivisionError", "RecursionError", "AttributeError",
                      "TypeError", "RuntimeError", "OSError")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
@pytest.mark.parametrize("site", _ENCODE_SITES, ids=_ENCODE_SITES)
@pytest.mark.parametrize("injection", _ENCODE_INJECTIONS, ids=_ENCODE_INJECTIONS)
def test_no_library_failure_at_any_encode_site_escapes_the_importers_guards(
        package_dir, site, injection, tmp_path):
    """TEST-14 (INV-1) — the ENCODE residue, at every third-party call the writer makes.

    MEASURED: 44 of these 48 (4 sites x 12 types) aborted the whole import on `e0276408`. The
    four that did not are the `OSError` legs, which the importers already guarded. The sweep is
    over the SITE as well as the type, because #292's lesson is that one input escapes in
    several families from several frames — enumerating types at one site is what left 44 open.
    (The design doc's larger battery of 66 adds thirteen hostile arrays and five codecs; those
    are covered by the dtype and codec suites and are not re-run here.)

    THE ASSERTION IS THE OUTCOME, NOT MERELY THE TUPLE. `pytest.raises(guarded)` alone cannot
    tell a conversion from a pass-through, which is precisely what the `OSError` legs are for —
    so each leg says which it expects: an injected type already in the guard tuple must arrive
    UNCHANGED (converting it would hide a taxonomy the importers were handling correctly), and
    every other type must arrive as an `ImageConversionError` that NAMES it.
    """
    import os as os_module
    import tifffile

    exceptions = {
        "MemoryError": MemoryError, "ValueError": ValueError, "struct.error": struct.error,
        "TiffFileError": tifffile.TiffFileError, "KeyError": KeyError, "IndexError": IndexError,
        "ZeroDivisionError": ZeroDivisionError, "RecursionError": RecursionError,
        "AttributeError": AttributeError, "TypeError": TypeError, "RuntimeError": RuntimeError,
        "OSError": OSError,
    }
    exc = exceptions[injection]("simulated by the residue sweep")
    targets = {
        "np.ascontiguousarray": (np, "ascontiguousarray"),
        "TiffWriter": (tifffile, "TiffWriter"),
        "TiffWriter.write": (tifffile.TiffWriter, "write"),
        "os.replace": (os_module, "replace"),
    }
    obj, attr = targets[site]

    with _staged_writer(package_dir) as (OW, SD):
        guarded = _importer_guard_tuple(OW, SD)
        arr = _plane()
        placement = _placement(SD, arr)
        saved = getattr(obj, attr)

        def boom(*args, **kwargs):
            raise exc

        setattr(obj, attr, boom)
        try:
            with pytest.raises(guarded) as raised:
                OW.write_ome_tiff(tmp_path / "swept.ome.tif", arr, placement=placement)
        finally:
            setattr(obj, attr, saved)

        # THE OUTCOME, NOT MERELY THE TUPLE. `pytest.raises(guarded)` alone cannot tell a
        # conversion from a pass-through, so each leg says which it got and both are checked.
        # An injected type ALREADY in the guard tuple may legitimately arrive either way — it
        # passes through when this function's own frame raised it (`os.replace`) and is
        # converted when the library did — so its leg asserts the disjunction explicitly
        # rather than pretending only one arm is correct. Everything else must be CONVERTED
        # and must NAME the original type, which is the assertion INV-4 rests on.
        converted = isinstance(raised.value, OW.ImageConversionError)
        if converted:
            assert f"({type(exc).__name__}: " in str(raised.value), (
                f"an injected {injection} at {site} was converted WITHOUT naming the original "
                f"type, so an operator cannot tell a resource problem from a data one. Got "
                f"{str(raised.value)!r}")
        else:
            assert raised.value is exc, (
                f"an injected {injection} at {site} was neither converted nor passed through "
                f"unchanged; it became {raised.value!r}, which is in the guard tuple for some "
                "third reason")
            assert isinstance(exc, guarded), (
                f"an injected {injection} at {site} passed through unconverted, and it is NOT "
                "one of the types the importers already guard — it only reached the tuple by "
                "coincidence")


# ── TEST-16 — nothing that emitted before emits anything different ──────────────────


def _writer_from_origin_main(tmp_dir):
    """`origin/main`'s own `ome_writer.py`, exec'd by path beside this branch's declarations.

    Comparing against the BASE's code rather than against a recorded digest: a digest would
    need regenerating on any unrelated `tifffile` upgrade and would prove nothing about what
    THIS branch did. `spatial_declarations.py` is untouched by this branch (asserted below), so
    one copy legitimately serves both writers and the only variable is `ome_writer.py`.
    """
    rel = "src-app/packages/spatial-types/compute"
    unchanged = subprocess.run(
        ["git", "diff", "--name-only", "origin/main...", "--", f"{rel}/spatial_declarations.py"],
        cwd=_REPO, capture_output=True, text=True, timeout=60).stdout.strip()
    assert not unchanged, (
        "`spatial_declarations.py` changed on this branch, so a single shared copy no longer "
        "isolates `ome_writer.py` as the only variable in this comparison")
    base = subprocess.run(["git", "show", f"origin/main:{rel}/ome_writer.py"],
                          cwd=_REPO, capture_output=True, text=True, timeout=30)
    assert base.returncode == 0, base.stderr
    path = Path(tmp_dir) / "ome_writer_origin_main.py"
    path.write_text(base.stdout)
    return _exec_by_path("ome_writer", path)


def _emit_or_refusal(writer, SD, directory, dtype, samples, tag):
    """`("emitted", <normalised bytes>)` or `("refused:<Type>", <message>)`.

    Refusals are compared too, and by TYPE rather than by message: the byte comparison alone
    would stop covering any dtype either writer declines, and "this branch turned a refusal
    into an emission" is an INV-6 violation from the other side.
    """
    arr = _plane(dtype, samples)
    dest = Path(directory) / f"{tag}-{dtype}-{samples}.ome.tif"
    try:
        writer.write_ome_tiff(dest, arr, placement=_placement(SD, arr))
    except (writer.ImageConversionError, SD.SpatialDeclarationError, OSError) as exc:
        return f"refused:{type(exc).__name__}", str(exc)
    return "emitted", _UUID_BYTES.sub(b"", dest.read_bytes())


@pytest.mark.parametrize("samples", [None, 1, 3, 4], ids=["2d", "s1", "rgb", "rgba"])
def test_every_expressible_dtype_emits_exactly_what_origin_main_emitted(samples, tmp_path):
    """TEST-16 (INV-6) — the change refuses failures; it moves nothing that worked.

    Every dtype OME-XML can express, at every readable sample count, emitted by BOTH writers
    and compared as BYTES. The `urn:uuid` `tifffile` stamps freshly on every write is the one
    thing that legally differs between two runs of identical code and is normalised away.

    This is the executable form of "no committed fixture, golden or expected-hash needs
    regenerating", and it is measured against `origin/main` itself rather than asserted.
    """
    # THE SCOPE GATE, because this test asks a question about a COMMIT RANGE. On `main` the
    # comparison is `origin/main`'s writer against itself — vacuously true — and on every later
    # unrelated branch it is the same vacuous pass wearing a green tick. `derived-guards.md` §3
    # names that class, and `_lib/test_zero_core_guard.py` caught this module for it.
    #
    # `require_introducing_file` keyed on THIS FILE: the branch that ADDS it is the branch
    # whose writer this claim is about, which is exactly INV-6's scope — "this change moves
    # nothing that previously worked" is a one-time proof about one change, not a standing
    # property of the tree.
    require_introducing_file(
        _ARMING_MARKER, __file__,
        reason="INV-6 compares THIS branch's writer against its base; on any other branch "
               "the two are the same file and the comparison is vacuous")

    with tempfile.TemporaryDirectory() as scratch:
        with _restoring_sys_modules():
            SD = _exec_by_path("spatial_declarations",
                               _SOURCE_PKG / "compute" / "spatial_declarations.py")
            base_writer = _writer_from_origin_main(scratch)
            expressible = sorted(base_writer.OME_EXPRESSIBLE_DTYPES)
            readable = set(SD.READABLE_SAMPLE_COUNTS) if hasattr(SD, "READABLE_SAMPLE_COUNTS") \
                else set(base_writer.READABLE_SAMPLE_COUNTS)
            if samples is not None and samples not in readable:
                pytest.skip(f"S={samples} is not a readable sample count here")
            base_outcome = {d: _emit_or_refusal(base_writer, SD, scratch, d, samples, "base")
                            for d in expressible}

        with _staged_writer(_SOURCE_PKG) as (OW, SD):
            branch_outcome = {d: _emit_or_refusal(OW, SD, tmp_path, d, samples, "branch")
                              for d in expressible}

    # BOTH halves, or the comparison is only about the dtypes that happen to emit. `bool` at
    # S>1 is REFUSED by both (the bilevel-with-samples arm), and a comparison that skipped it
    # would stop noticing if this branch changed a REFUSAL into an emission — which would be
    # the same INV-6 violation from the other side.
    differing = [f"{d}: base={base_outcome[d][0]} branch={branch_outcome[d][0]}"
                 for d in expressible if base_outcome[d][0] != branch_outcome[d][0]]
    assert not differing, (
        f"these dtypes behave DIFFERENTLY from `origin/main`'s writer at S={samples}: "
        f"{differing}. This change converts failures that used to abort the import; it moves "
        "nothing that previously worked and refuses nothing new (INV-6).")
    moved = [d for d in expressible
             if base_outcome[d][0] == "emitted" and base_outcome[d][1] != branch_outcome[d][1]]
    assert not moved, (
        f"these dtypes emit DIFFERENT BYTES than `origin/main`'s writer at S={samples}: "
        f"{moved}. Every artifact this repo has committed is one of these shapes.")
    assert any(o[0] == "emitted" for o in base_outcome.values()), (
        f"nothing emitted at S={samples} on either side, so this comparison is vacuous")


def test_no_shipped_source_still_describes_these_escapes_as_open():
    """TEST-15 (a PROSE LINT, not an invariant proof) — an accepted design that describes a
    fixed defect as open is worse than silence.

    SAID PLAINLY BECAUSE IT WAS OVERSTATED ONCE: no CODE change can turn this red, and it
    passes unchanged against `origin/main`. INV-3 rests entirely on the structural guard above
    and its six mutants; this leg guards the COMMENTS, which is a real and separate hazard, but
    counting it as evidence for the invariant would be coverage inflation.

    This branch rewrites load-bearing comments in all three
    `ome_writer.py` copies and in both importers, and every one of those files is inside
    `test_ome_dtype_refusal`'s `_GAP_PROSE_FILES`. So a new comment saying a `TiffFileError`
    "still escapes" would describe a defect this branch just closed and would turn that
    shipped guard red. The same patterns are re-run here, over the files this branch edits, so
    the constraint is visible from the change rather than discovered from a sibling suite's
    failure.

    A reader who believes an out-of-date comment re-files the issue or, worse, re-introduces
    the gap on the belief that it was deliberate — which is precisely how `_PROGRAMMING_ERRORS`
    came back as attempt 2 a year after attempt 2 was measured wrong.
    """
    # NARROWED, because the broad form is a FALSE POSITIVE on this branch's own vocabulary:
    # "A bug in this file still propagates" is an accurate description of the shipped mechanism
    # and matched `still propagates?\b`, turning this red with a message accusing the author of
    # describing a closed defect as open. The escape verbs only mean "the defect is open" when
    # they are about something escaping PAST a guard, so the patterns say that.
    patterns = (r"still escapes? (?:past|the|both|either)\b",
                r"still propagates? (?:past|out of|into|to the importer)\b",
                r"continues to escape\b",
                r"remains? (?:open|unguarded|unclosed)\b",
                r"is (?:still )?in NEITHER importer's guard\b")
    files = [d / "compute" / "ome_writer.py" for d in SHIPPED]
    files += _callers()
    files.append(_PACKAGES / "spatial-import-xenium" / "compute" / "xenium_image.py")
    offenders = []
    for path in files:
        if not path.is_file():
            continue
        text = path.read_text()
        for pattern in patterns:
            for hit in re.finditer(pattern, text, re.IGNORECASE):
                line = text.count("\n", 0, hit.start()) + 1
                offenders.append(f"{path.relative_to(_REPO)}:{line}: {hit.group(0)!r}")
    assert not offenders, (
        "these describe an image-guard escape as STILL OPEN, which stopped being true when "
        "this change landed:\n  " + "\n  ".join(offenders))


# ── TEST-15 (INV-3) — the CARVE-OUTS, which the `except`-clause guards cannot see ───
#
# `_type_filter_offenders` and `_broad_handler_offenders` both inspect `except` HANDLER TYPES.
# `_SITE_RULE_IS_BLIND_TO` is a module constant consulted inside `image_failure_is_a_bug`, so
# it is invisible to both — and it is the one place an allow-list of exception types can be
# reintroduced. A blind audit put `read_image`'s attempt-3 allow-list into it verbatim
# (`+ ZeroDivisionError, IndexError, ValueError`) and all 1381 tests stayed GREEN.
#
# Two guards close that, and the SECOND is the one that matters: a structural pin says what the
# tuple is, and a behavioural battery says what widening it would COST.

#: Exactly the carve-outs `docs/design/image-failure-provenance-refusal.md` §2 declares, with
#: the measurement each rests on. Adding a third here without adding it to the design — and
#: without a measurement — is the failure this pin exists to stop.
_DECLARED_CARVE_OUTS = ("MemoryError", "ImportError")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_carve_outs_are_exactly_the_two_the_design_declares(package_dir):
    """TEST-15 (INV-3) — the site rule's blind spots are DECLARED, not accumulated.

    A carve-out is a place where the mechanism decides on the exception TYPE, which is the
    thing INV-3 forbids everywhere else. Two are justified because the frame the interpreter
    records is provably not the raising site (a C extension; an import statement). A third
    would be attempt 3 growing back, and nothing else in the suite would notice.
    """
    with _staged_writer(package_dir) as (OW, _SD):
        names = tuple(t.__name__ for t in OW._SITE_RULE_IS_BLIND_TO)
        assert names == _DECLARED_CARVE_OUTS, (
            f"{package_dir.name}'s `_SITE_RULE_IS_BLIND_TO` is {names}, not "
            f"{_DECLARED_CARVE_OUTS}. Every entry is a type the mechanism decides on WITHOUT "
            "looking at the raising site, so each needs its own measurement and its own line "
            "in the design's §2. If a third is genuinely warranted, add it there first.")


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_declared_libraries_are_exactly_the_ones_the_boundaries_import(package_dir):
    """TEST-15 (INV-3) — the module-name allow-list is DERIVED, not remembered.

    The `ImportError` carve-out is narrowed to the libraries these boundaries actually defer an
    import of, because an `ImportError` naming anything else is this tree asking for a module it
    never declared — a typo, a bug, and something that must NOT be laundered into an accusation
    about the host. That narrowing is only honest if the list matches the source, so it is
    re-derived from the source here by `ast` rather than trusted.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    tree = ast.parse(source)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in _DEFERRING_FUNCTIONS:
            for inner in ast.walk(node):
                if isinstance(inner, ast.Import):
                    imported |= {a.name.split(".")[0] for a in inner.names}
                elif isinstance(inner, ast.ImportFrom) and inner.module:
                    imported.add(inner.module.split(".")[0])
    with _staged_writer(package_dir) as (OW, _SD):
        declared = set(OW._DECLARED_LIBRARIES)
    assert imported == declared, (
        f"{package_dir.name}'s `_DECLARED_LIBRARIES` is {sorted(declared)} but its boundaries "
        f"import {sorted(imported)}.\n"
        f"  missing from the list (an `ImportError` for these is treated as a BUG and aborts "
        f"the whole import — #298 E2 coming back): {sorted(imported - declared)}\n"
        f"  in the list but imported by no boundary (the carve-out is WIDER than the code, "
        f"which is how an allow-list silently grows): {sorted(declared - imported)}\n"
        "This is an EQUALITY on purpose. It was a subset check, and under a subset check "
        "adding a bogus name to the constant left every test green — measured.")


#: An own-code bug of each type a widened carve-out would swallow. Every one is raised by the
#: INTERPRETER at the offending line — no library frame is involved — so every one must
#: PROPAGATE. This is what makes `_SITE_RULE_IS_BLIND_TO` un-widenable without a red test: put
#: `ZeroDivisionError` in that tuple and the first leg here goes red, which is exactly what did
#: NOT happen when a blind audit tried it.
_OWN_CODE_BUGS = {
    "ZeroDivisionError": "_ = 1 // 0",
    "IndexError": "_ = [][0]",
    "ValueError": "_ = int('not a number')",
    "KeyError": "_ = {}['nope']",
    "TypeError": "_ = None + 1",
    "AttributeError": "_ = (1).nonexistent_attribute",
    "RuntimeError": "raise RuntimeError('a simulated bug in this file')",
    "OSError": "raise OSError('a simulated bug in this file')",
    "RecursionError": "raise RecursionError('a simulated bug in this file')",
}


@pytest.mark.parametrize("bug", sorted(_OWN_CODE_BUGS), ids=sorted(_OWN_CODE_BUGS))
def test_an_own_code_bug_of_any_type_still_propagates_out_of_the_writer(bug, tmp_path):
    """TEST-15/TEST-8 (INV-2, INV-3) — the carve-out tuple, guarded BEHAVIOURALLY.

    The structural pin above says what the tuple IS; this says what widening it would COST.
    Nine types, each raised by a line in `write_ome_tiff`'s own encode block, each required to
    come out UNCONVERTED. `OSError` and `RecursionError` are in the battery deliberately even
    though `OSError` is in the importers' guard tuple: the claim is not "it reaches the
    importer", it is "the mechanism did not decide this was a bad image".
    """
    path = _SOURCE_PKG / "compute" / "ome_writer.py"
    shipped = path.read_text()
    anchor = "        os.replace(staging, dest)\n"
    assert shipped.count(anchor) == 1, (
        f"the anchor matched {shipped.count(anchor)} times — it is an ordinary code line, so a "
        "reindent or a reorder breaks it. Re-derive it from the current source rather than "
        "loosening it; a mutation that matches nothing tests nothing.")
    with _restoring_sys_modules():
        SD = _exec_by_path("spatial_declarations",
                           _SOURCE_PKG / "compute" / "spatial_declarations.py")
        arr = _plane()
        placement = _placement(SD, arr)

        control = _exec_source_as(shipped, path, "ome_writer")
        control.write_ome_tiff(tmp_path / "control.ome.tif", arr, placement=placement)

        mutant = _exec_source_as(
            shipped.replace(anchor, f"        {_OWN_CODE_BUGS[bug]}\n{anchor}"),
            path, "ome_writer")
        with pytest.raises(Exception) as raised:
            mutant.write_ome_tiff(tmp_path / f"{bug}.ome.tif", arr, placement=placement)
        assert not isinstance(raised.value, mutant.ImageConversionError), (
            f"a {bug} raised by a line in `ome_writer.py` was CONVERTED into "
            f"{raised.value!r}. Either a carve-out has been widened to cover it, or the "
            "propagate arm has been weakened — both launder a genuine logic bug into a "
            "skipped image while the import reports SUCCESS (INV-2, INV-3).")
        assert type(raised.value).__name__ == bug, (
            f"expected {bug}, got {type(raised.value).__name__}: {raised.value}")


@pytest.mark.parametrize("bug", sorted(_OWN_CODE_BUGS), ids=sorted(_OWN_CODE_BUGS))
def test_an_own_code_bug_of_any_type_still_propagates_out_of_read_plane(bug, tmp_path):
    """TEST-15/TEST-3 (INV-2, INV-3) — the same battery at the DECODE boundary.

    `xenium_image.py` is not vendored and carries its own copy of the handler, so it needs its
    own battery: a carve-out widened in `ome_writer` is consulted by BOTH boundaries, and a
    guard that only covers one of them proves half the property.
    """
    compute = _PACKAGES / "spatial-import-xenium" / "compute"
    path = compute / "xenium_image.py"
    shipped = path.read_text()
    anchor = "            names = channel_names(xml)\n"
    assert shipped.count(anchor) == 1, (
        f"the anchor matched {shipped.count(anchor)} times — re-derive it from the current "
        "source; a mutation that matches nothing tests nothing.")
    with _restoring_sys_modules():
        _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")

        import tifffile
        fixture = Path(tmp_path) / "plane.ome.tif"
        tifffile.imwrite(str(fixture), _plane()[:16, :20],
                         photometric="minisblack", ome=False)

        control = _exec_source_as(shipped, path, "xenium_image_control")
        control.read_plane(fixture)          # the un-mutated control must READ it

        mutant = _exec_source_as(
            shipped.replace(anchor, f"{anchor}            {_OWN_CODE_BUGS[bug]}\n"),
            path, "xenium_image_mutant")
        with pytest.raises(Exception) as raised:
            mutant.read_plane(fixture)
        assert not isinstance(raised.value, OW.ImageConversionError), (
            f"a {bug} raised by a line in `xenium_image.py` was CONVERTED into "
            f"{raised.value!r} — a defect in this file laundered into an accusation about the "
            "vendor's file, which is the exact outcome the deleted deny-list existed to stop.")
        assert type(raised.value).__name__ == bug, (
            f"expected {bug}, got {type(raised.value).__name__}: {raised.value}")


#: A typo in THIS TREE's own import statement, at each boundary that defers one. Distinct from
#: a declared library being absent, and the distinction is the whole point of
#: `_DECLARED_LIBRARIES`: without it, renaming `import tifffile` to `import tiffile_typo` came
#: back to the user as a skipped image with the import reporting SUCCESS, while `origin/main`
#: aborted loudly — the carve-out was a REGRESSION against the invariant it sits under.
_IMPORT_TYPOS = {
    "read_plane": (
        "spatial-import-xenium", "xenium_image.py",
        "        import tifffile\n", "        import tiffile_typo as tifffile\n"),
    "write_ome_tiff": (
        "spatial-types", "ome_writer.py",
        "        import numpy as np\n        import tifffile\n",
        "        import numpy as np\n        import tifffile_TYPO as tifffile\n"),
    # ADDED after a blind audit put `except ImportError` into `tifffile_version` in all three
    # copies and got a green 886-test suite: the typo battery covered two of the four
    # site-rule boundaries, and the two it missed are the two whose broad arms this branch
    # ADDED — which is to say, the newest code had the least behavioural coverage.
    "tifffile_version": (
        "spatial-types", "ome_writer.py",
        "        import tifffile\n\n        return str(tifffile.__version__)\n",
        "        import tifffile_TYPO as tifffile\n\n        return str(tifffile.__version__)\n"),
}


@pytest.mark.parametrize("boundary", sorted(_IMPORT_TYPOS), ids=sorted(_IMPORT_TYPOS))
def test_a_typo_in_our_own_import_still_propagates(boundary, tmp_path):
    """TEST-15 (INV-2) — the `ImportError` carve-out must not launder a typo.

    A DECLARED dependency absent from the analysis rootfs is an environment fact and costs one
    image (`test_an_unimportable_library_costs_one_image_in_the_importers_taxonomy`). A module
    name this tree never declared is a typo in this tree, and it must abort exactly as it did
    before — otherwise the fix for #298 E2 has bought an environment case at the price of the
    bug case, which is the trade INV-2 forbids.
    """
    package, filename, old, new = _IMPORT_TYPOS[boundary]
    compute = _PACKAGES / package / "compute"
    path = compute / filename
    shipped = path.read_text()
    assert shipped.count(old) == 1, (
        f"the {boundary!r} import anchor matched {shipped.count(old)} times — re-derive it")
    with _restoring_sys_modules():
        SD = _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")
        mutant = _exec_source_as(shipped.replace(old, new), path, f"{boundary}_typo")
        if boundary == "read_plane":
            call = lambda: mutant.read_plane(Path(tmp_path) / "whatever.ome.tif")
        elif boundary == "tifffile_version":
            call = mutant.tifffile_version
            OW = mutant          # its own refusal class, since the mutant IS `ome_writer`
        else:
            arr = _plane()
            call = lambda: mutant.write_ome_tiff(
                Path(tmp_path) / "typo.ome.tif", arr, placement=_placement(SD, arr))
            OW = mutant          # SAME REASON, and this leg was missed when the other got it:
                                 # `_exec_source_as` gives the mutant its OWN
                                 # `ImageConversionError`, so an `isinstance` against the
                                 # STAGED module's class is always False and the FIRST
                                 # assertion below was dead.
                                 #
                                 # THE LEG WAS NOT BLIND, and an earlier version of this
                                 # comment claimed it was ("measured on a laundering mutant: it
                                 # passed"). Re-measured: the laundering mutant went RED anyway,
                                 # at the `isinstance(..., ImportError)` assertion — because
                                 # `ImageConversionError` subclasses `RuntimeError`. Only the
                                 # first assertion was dead. The rebind is still right; the
                                 # claim about what it caught was not.
        with pytest.raises(Exception) as raised:
            call()
        # `OW` IS REBOUND TO THE MUTANT where the mutant IS `ome_writer`, because a module
        # exec'd afresh defines its OWN `ImageConversionError` class — an `isinstance` against
        # the staged module's class is then always False and the assertion is DEAD.
        assert not isinstance(raised.value, OW.ImageConversionError), (
            f"a typo'd import name in {filename} was CONVERTED into {raised.value!r}. The "
            "user is told their bundle could not be read; the import reports SUCCESS; and the "
            "defect is in this tree. `origin/main` aborted on this, so converting it is a "
            "REGRESSION, not a fix.")
        assert isinstance(raised.value, ImportError), (
            f"expected the typo's own ImportError, got {type(raised.value).__name__}")


# ── TEST-10 (INV-1/INV-2) — all four shapes an import failure can take ──────────────


@contextlib.contextmanager
def _library_present_but_broken(name, body):
    """`import <name>` succeeds in finding the module and its BODY raises `body`.

    A DIFFERENT failure from a missing module, and the distinction is what the second carve-out
    turns on: a broken library raises from ITS OWN file, so the site rule sees a library frame,
    while a missing one is attributed to the importing line. Reproduced with a real package on
    `sys.path` rather than a mock, because the whole question is which FILE the interpreter
    records.
    """
    with tempfile.TemporaryDirectory() as scratch:
        package = Path(scratch) / name
        package.mkdir()
        (package / "__init__.py").write_text(body)
        saved = {k: v for k, v in sys.modules.items()
                 if k == name or k.startswith(name + ".")}
        for key in saved:
            del sys.modules[key]
        sys.path.insert(0, scratch)
        try:
            yield
        finally:
            sys.path.remove(scratch)
            for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
                del sys.modules[key]
            sys.modules.update(saved)


#: The four shapes an import failure takes at a boundary, and where each must land. The first
#: version of the `ImportError` carve-out asked `exc.name` BEFORE the site rule and got two of
#: these four wrong — both by propagating a bare `ImportError`, which is in neither importer's
#: guard tuple, so both aborted the whole import from inside the fix for #298 E2.
_IMPORT_FAILURE_SHAPES = {
    # (how it fails, must it propagate?)
    "missing-declared-library": ("missing", False),
    "present-but-broken-library": ("broken-no-name", False),
    "broken-library-missing-a-transitive-dep": ("broken-transitive", False),
    "typo-in-our-own-import-name": ("typo", True),
}


@pytest.mark.parametrize("shape", sorted(_IMPORT_FAILURE_SHAPES), ids=sorted(_IMPORT_FAILURE_SHAPES))
def test_every_shape_of_import_failure_lands_where_it_should(shape, tmp_path):
    """TEST-10 (INV-1, INV-2) — the carve-out is narrow in ONE direction only.

    | raised in | `exc.name` | verdict |
    |---|---|---|
    | OUR frame | a declared library | the rootfs lacks a pinned library — CONVERT, one image |
    | OUR frame | anything else | a typo in this tree — PROPAGATE |
    | a LIBRARY's frame | anything, including `None` | that library is broken — CONVERT |

    The two `broken-*` rows are the ones a `name`-first ordering got wrong, and neither is
    exotic: Pillow signals a mismatched `_imaging` extension with a hand-constructed
    `ImportError` (so `exc.name` is `None`), and a library missing a TRANSITIVE dependency
    reports that dependency's name, which a list of DECLARED libraries structurally cannot
    contain.
    """
    how, must_propagate = _IMPORT_FAILURE_SHAPES[shape]
    compute = _PACKAGES / "spatial-import-xenium" / "compute"
    path = compute / "xenium_image.py"
    shipped = path.read_text()

    with _restoring_sys_modules():
        _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")
        source = shipped
        context = contextlib.nullcontext()
        if how == "missing":
            context = _module_really_absent("tifffile")
        elif how == "broken-no-name":
            context = _library_present_but_broken(
                "tifffile",
                "raise ImportError('The _imaging extension was built for another version')")
        elif how == "broken-transitive":
            context = _library_present_but_broken(
                "tifffile", "import a_transitive_dep_the_rootfs_lacks")
        else:
            source = shipped.replace("        import tifffile\n",
                                     "        import tiffile_typo as tifffile\n")
            assert source != shipped, "the typo anchor matched nothing — re-derive it"

        mutant = _exec_source_as(source, path, f"xenium_image_{how}")
        with context:
            with pytest.raises(Exception) as raised:
                mutant.read_plane(Path(tmp_path) / "whatever.ome.tif")

        converted = isinstance(raised.value, OW.ImageConversionError)
        if must_propagate:
            assert not converted, (
                f"a {shape} was CONVERTED into {raised.value!r}. The user is told their bundle "
                "could not be read, the import reports SUCCESS, and the defect is in this "
                "tree — a REGRESSION against the base, which aborted loudly.")
            assert isinstance(raised.value, ImportError), type(raised.value).__name__
        else:
            assert converted, (
                f"a {shape} PROPAGATED as {type(raised.value).__name__}, which is in neither "
                "importer's guard tuple, so it costs the matrix, the coordinates, the columns "
                "and the report over a HOST problem. That is #298 E2, re-opened.")
            assert "Error" in str(raised.value), str(raised.value)


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_both_refusal_taxonomies_pass_through_every_broad_arm(package_dir):
    """TEST-15 (INV-3) — `SpatialDeclarationError` is re-raised, not retyped.

    `ImageConversionError` was special-cased at every broad arm from the start;
    `SpatialDeclarationError` — the OTHER member of the tuple both importers guard — was not, so
    an SD refusal reaching one would be converted and lose the distinction between "the producer
    declared something impossible" and "the image was bad". Both importers still catch it either
    way, which is why this was latent rather than reachable; it is one cross-module call away
    from mattering, and asserting the handler shape costs nothing.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    tree = ast.parse(source)
    target = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == "write_ome_tiff")
    broad, passthrough = 0, 0
    for handler in (n for n in ast.walk(target) if isinstance(n, ast.ExceptHandler)):
        if handler.type is None:
            continue
        names = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
        leaves = {ast.unparse(n).rsplit(".", 1)[-1] for n in names}
        if leaves == {"Exception"}:
            broad += 1
        if {"ImageConversionError", "SpatialDeclarationError"} <= leaves:
            passthrough += 1
    assert broad >= 1, f"{package_dir.name}'s `write_ome_tiff` has no broad arm to guard"
    assert passthrough == broad, (
        f"{package_dir.name}'s `write_ome_tiff` has {broad} broad arm(s) but only "
        f"{passthrough} that re-raise BOTH refusal taxonomies ahead of them. A "
        "`SpatialDeclarationError` reaching a broad arm would be retyped into an "
        "`ImageConversionError` and lose what it was telling the producer.")


def test_the_staging_cleanup_never_replaces_the_refusal_it_cleans_up_after(tmp_path):
    """TEST-7 (INV-4) — a `finally` must not eat the message the operator needs.

    `staging.unlink()` sat unguarded in a `finally`, so a failure to REMOVE the stub raised INTO
    the in-flight exception: a precise refusal came back as a bare `PermissionError` with the
    real message demoted to `__context__` — and the stub was left behind anyway, so nothing was
    bought.

    THE FAILURE MUST HAPPEN INSIDE THE `TiffWriter` BLOCK, which is the only place the staging
    file exists. An earlier draft of this test used an `int64` array, whose refusal fires at the
    dtype guard — BEFORE the staging `try` is entered — so the `finally` never ran and the test
    passed against the unguarded code. That is the vacuous-control failure this suite keeps
    finding in other people's tests; it is recorded here because it was in one of mine.
    """
    import tifffile

    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _plane()
        placement = _placement(SD, arr)
        real_write, real_unlink = tifffile.TiffWriter.write, Path.unlink

        def refusing_write(*args, **kwargs):
            raise ValueError("tifffile refused this array")

        def refusing_unlink(self, *args, **kwargs):
            raise PermissionError("the output directory is read-only")

        tifffile.TiffWriter.write = refusing_write
        Path.unlink = refusing_unlink
        try:
            with pytest.raises(Exception) as raised:
                OW.write_ome_tiff(tmp_path / "masked.ome.tif", arr, placement=placement)
        finally:
            tifffile.TiffWriter.write, Path.unlink = real_write, real_unlink

        assert isinstance(raised.value, OW.ImageConversionError), (
            f"the cleanup replaced the refusal with its own failure: the operator is told "
            f"about a permission problem instead of what the writer refused. Got "
            f"{type(raised.value).__name__}: {raised.value}")
        assert "(ValueError: " in str(raised.value), str(raised.value)


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_every_boundary_import_is_a_plain_declared_module(package_dir):
    """TEST-10 (INV-1/INV-2) — the construction that removes an unresolvable ambiguity.

    The `ImportError` carve-out compares the ROOT PACKAGE of `exc.name`, because a
    half-installed wheel reports a DOTTED name (`PIL.Image`) and comparing the whole string made
    an environment fact propagate and abort the import. Comparing the root would ALSO convert a
    typo'd SUBMODULE of a declared package (`import tifffile.no_such_sub`) — and that case is
    genuinely indistinguishable from the half-installed wheel, from inside the exception.

    So it is removed by CONSTRUCTION rather than decided wrongly: no boundary here imports a
    submodule or a dotted name, and this is what keeps that true. If one ever needs to, the
    carve-out has to be revisited at the same time — which is the point of failing here rather
    than silently laundering a typo.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text()
    tree = ast.parse(source)
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.FunctionDef) and node.name in _DEFERRING_FUNCTIONS):
            continue
        for inner in ast.walk(node):
            if isinstance(inner, ast.Import):
                offenders += [f"{node.name}:{inner.lineno} `import {a.name}`"
                              for a in inner.names if "." in a.name]
            elif isinstance(inner, ast.ImportFrom):
                if inner.level or not inner.module or "." in inner.module:
                    offenders.append(f"{node.name}:{inner.lineno} "
                                     f"`from {'.' * (inner.level or 0)}{inner.module} import ...`")
    assert not offenders, (
        f"{package_dir.name} imports a dotted or relative module at a boundary: {offenders}. "
        "The `ImportError` carve-out compares the ROOT package of `exc.name`, so such an "
        "import makes a typo in it indistinguishable from a half-installed wheel and it would "
        "be laundered into a skipped image. Revisit `image_failure_is_a_bug` before adding one.")


#: The two shapes an import can fail in when the MODULE IS PRESENT, and where each must land.
#: `from X import Y` raises a plain `ImportError` whose `.name` is the PACKAGE — so before this
#: was narrowed, `from PIL import Imagee` matched the declared list and a typo of ours came back
#: as a skipped image with the import reporting SUCCESS. The tree has exactly this import shape.
_PRESENT_MODULE_IMPORT_FAILURES = {
    "from-declared-import-a-typo": (
        "        from tifffile import TiffFileeee as tifffile\n", True),
    "dotted-submodule-of-a-declared-package": (
        "        import tifffile.no_such_submodule\n        import tifffile\n", False),
    "dotted-submodule-of-an-undeclared-package": (
        "        import no_such_package.sub\n        import tifffile\n", True),
}


@pytest.mark.parametrize("shape", sorted(_PRESENT_MODULE_IMPORT_FAILURES),
                         ids=sorted(_PRESENT_MODULE_IMPORT_FAILURES))
def test_an_import_failure_of_a_PRESENT_module_lands_where_it_should(shape, tmp_path):
    """TEST-10 (INV-2) — `exc.name` is the PACKAGE, not the missing name.

    The carve-out's first narrowing asked only "is `exc.name` a declared library". That is the
    right question for a module that is ABSENT and the wrong one for a name missing from a
    module that is PRESENT: the latter raises a plain `ImportError` (not
    `ModuleNotFoundError`) and reports the package. So the rule is now BOTH — the exception
    class says whether the module was there, and the root of the name says whose it was.
    """
    replacement, must_propagate = _PRESENT_MODULE_IMPORT_FAILURES[shape]
    compute = _PACKAGES / "spatial-import-xenium" / "compute"
    path = compute / "xenium_image.py"
    shipped = path.read_text()
    anchor = "        import tifffile\n"
    assert shipped.count(anchor) == 1, "the import anchor moved — re-derive it"

    with _restoring_sys_modules():
        _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")
        mutant = _exec_source_as(shipped.replace(anchor, replacement), path,
                                 f"xenium_image_{shape}")
        with pytest.raises(Exception) as raised:
            mutant.read_plane(Path(tmp_path) / "whatever.ome.tif")

    converted = isinstance(raised.value, OW.ImageConversionError)
    if must_propagate:
        assert not converted, (
            f"a {shape} was CONVERTED into {raised.value!r} — a defect in this tree reported "
            "to the user as a skipped image while the import claims SUCCESS.")
    else:
        assert converted, (
            f"a {shape} PROPAGATED as {type(raised.value).__name__}, which is in neither "
            "importer's guard tuple. A half-installed wheel is an ENVIRONMENT fact and costs "
            "one image; this shape is indistinguishable from one.")


# ── TEST-8/TEST-15 (INV-2) — EVERY site-rule boundary, pinned BEHAVIOURALLY ─────────
#
# Two of the six were pinned by nothing. Deleting `if image_failure_is_a_bug(exc, __file__):
# raise` from `ome_writer.tifffile_version` (all three copies) AND from
# `import_xenium.emit_image`'s second-open block left the whole spatial suite GREEN, because:
# the STRONG `ast` guard runs only over `write_ome_tiff`; the broad guard waves any
# `except Exception` through; `import_xenium.py` was in neither list; and the behavioural
# batteries targeted only `write_ome_tiff` and `read_plane`.
#
# The remedy is the one the loop's own rules prescribe when findings concentrate on guards:
# replace the syntactic predicate with a test that asserts the BEHAVIOUR it stood in for. Each
# boundary below gets a real own-code bug and must propagate it.

#: `(package, file, function, anchor-to-insert-after, how to call it)`. The anchor is a UNIQUE
#: line inside the guarded `try`, so the mutant raises from that boundary's own frame.
_SITE_RULE_BOUNDARIES = {
    "ome_writer.tifffile_version": (
        "spatial-types", "ome_writer.py",
        "        import tifffile\n\n        return str(tifffile.__version__)\n",
        "        import tifffile\n\n        _ = {typo}\n        return str(tifffile.__version__)\n"),
    "xenium_image.read_plane": (
        "spatial-import-xenium", "xenium_image.py",
        "            names = channel_names(xml)\n",
        "            names = channel_names(xml)\n            _ = {typo}\n"),
    "import_xenium.emit_image-reopen": (
        "spatial-import-xenium", "import_xenium.py",
        "            import tifffile\n\n            with tifffile.TiffFile(str(path)) as handle:\n",
        "            import tifffile\n\n            _ = {typo}\n"
        "            with tifffile.TiffFile(str(path)) as handle:\n"),
}


@pytest.mark.parametrize("boundary", sorted(_SITE_RULE_BOUNDARIES), ids=sorted(_SITE_RULE_BOUNDARIES))
def test_every_site_rule_boundary_still_propagates_its_own_bugs(boundary, tmp_path):
    """TEST-8 (INV-2) — the propagate arm of EVERY boundary, not just the two that had tests.

    `write_ome_tiff`'s three regions have their own battery; these are the rest. A `NameError`
    is inserted into each boundary's guarded body — raised by the INTERPRETER at the offending
    line, so the innermost frame is unambiguously that file — and must come out unconverted.

    `import_xenium.emit_image` is here because it is a site-rule boundary that lives in an
    IMPORTER rather than in `ome_writer.py`, and every structural guard in this suite globs
    `*/compute/ome_writer.py` or names `xenium_image.py`. A boundary in neither list is a
    boundary nothing checks.
    """
    package, filename, anchor, template = _SITE_RULE_BOUNDARIES[boundary]
    compute = _PACKAGES / package / "compute"
    path = compute / filename
    shipped = path.read_text()
    assert shipped.count(anchor) == 1, (
        f"the {boundary!r} anchor matched {shipped.count(anchor)} times in {filename}. It is an "
        "ordinary code span, so a reindent or a reorder breaks it — re-derive it from the "
        "current source rather than loosening it.")
    typo = "_a_name_this_module_does_not_define"
    mutated = shipped.replace(anchor, template.format(typo=typo))
    assert mutated != shipped

    with _restoring_sys_modules():
        SD = _exec_by_path("spatial_declarations", compute / "spatial_declarations.py")
        OW = _exec_by_path("ome_writer", compute / "ome_writer.py")
        if boundary == "ome_writer.tifffile_version":
            mutant = _exec_source_as(mutated, path, "ome_writer")
            call = mutant.tifffile_version
            refusal = mutant.ImageConversionError
        elif boundary == "xenium_image.read_plane":
            import tifffile
            fixture = Path(tmp_path) / "plane.ome.tif"
            tifffile.imwrite(str(fixture), _plane()[:16, :20],
                             photometric="minisblack", ome=False)
            mutant = _exec_source_as(mutated, path, "xenium_image_boundary")
            call = lambda: mutant.read_plane(fixture)
            refusal = OW.ImageConversionError
        else:
            # The importer's own boundary. Compiled and its ONE guarded block exercised
            # directly: importing the whole entry module would need the sandbox's staged
            # `/code` layout, and the claim under test is about this block, not about staging.
            #
            # THE CONTROL RUNS FIRST AND MUST NOT RAISE. Without it this leg was VACUOUS: the
            # namespace was missing `SD`, so evaluating the handler's own `except (...)` tuple
            # raised `NameError` — which satisfied both assertions below and made the test pass
            # WITH THE GUARD DELETED. Measured. A control that proves the extracted block runs
            # is the only thing that distinguishes "the mutant propagated" from "the harness
            # was broken in a way that looks like propagation".
            _import_xenium_reopen_block(shipped, path, tmp_path, OW, SD)()
            call = _import_xenium_reopen_block(mutated, path, tmp_path, OW, SD)
            refusal = OW.ImageConversionError

        with pytest.raises(Exception) as raised:
            call()
        assert not isinstance(raised.value, refusal), (
            f"a bug in {boundary}'s own code was CONVERTED into {raised.value!r}. That "
            "boundary would report a defect in this tree to the user as a skipped image while "
            "the import claims SUCCESS — the #296 defect, at a boundary nothing was checking.")
        assert isinstance(raised.value, NameError), (
            f"expected the mutant's NameError, got {type(raised.value).__name__}")


def _import_xenium_reopen_block(source, path, tmp_path, OW, SD):
    """The `emit_image` second-open block, extracted from `source` and made callable.

    `import_xenium.py` imports six sibling modules that only exist under the sandbox's staged
    `/code` layout, so the module cannot simply be exec'd here. The block under test is
    self-contained — a deferred `import tifffile`, one open, one pure parser — so it is lifted
    verbatim, with its handler, and run against a real file. Lifting it VERBATIM is what keeps
    this a test of the shipped text rather than of a paraphrase: the extraction asserts the
    handler it found still contains the site-rule call.
    """
    import textwrap

    start = source.index("        try:\n            # THE ONLY UNWRAPPED THIRD-PARTY CALL")
    end = source.index("        stated_scales, disagreement", start)
    block = textwrap.dedent(source[start:end])
    assert _SITE_RULE in block, (
        "the extracted `emit_image` block no longer contains the site-rule call, so this test "
        "would pass for the wrong reason — re-derive the extraction bounds")

    import tifffile
    fixture = Path(tmp_path) / "reopen.ome.tif"
    tifffile.imwrite(str(fixture), _plane()[:16, :20], photometric="minisblack", ome=False)
    # EVERY NAME THE BLOCK REFERENCES. A missing one makes the handler itself raise, which
    # looks exactly like the propagation this test is trying to observe.
    namespace = {"ome_writer": OW, "SD": SD, "path": fixture,
                 "ome_physical_size": lambda xml: (None, None),
                 "__file__": str(path)}
    # EVERY FREE NAME THE BLOCK ACTUALLY REFERENCES, derived from it. Asserting that four
    # literals written into the dict two lines above are in the dict proves nothing; the point
    # is that the BLOCK has nothing unbound, because an unbound name makes the handler itself
    # raise and that looks exactly like the propagation this test observes.
    parsed = ast.parse(block)
    referenced = {n.id for n in ast.walk(parsed)
                  if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    bound = {n.id for n in ast.walk(parsed)
             if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    bound |= {n.name for n in ast.walk(parsed)
              if isinstance(n, ast.ExceptHandler) and n.name}
    for n in ast.walk(parsed):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            bound |= {(a.asname or a.name).split(".")[0] for a in n.names}
    # `_A_TYPO` is the mutation ITSELF — a deliberately undefined name, which is the whole
    # point of the mutant — so it is the one free name this check must not object to.
    missing = {n for n in referenced - bound - {_A_TYPO}
               if n not in namespace and not hasattr(builtins, n)}
    assert not missing, (
        f"the extracted block references {sorted(missing)}, which the namespace does not "
        "bind. An unbound name makes the handler raise while handling, which is "
        "indistinguishable from the propagation this test exists to observe.")
    return lambda: exec(compile(block, str(path), "exec"), dict(namespace))


@pytest.mark.parametrize("package_dir", SHIPPED, ids=IDS)
def test_the_declared_boundary_list_covers_every_function_that_looks_like_one(package_dir):
    """TEST-15 (INV-3) — a boundary in no list is a boundary nothing checks.

    `IBG`'s own module docstring says why a hand-maintained boundary list is dangerous — it
    is exactly how `emit_image`'s second-open block came to be guarded by nothing. Nothing
    checked the LIST, though: adding a plausible new function to `ome_writer.py` (a
    `read_image_thumbnail` with a bare `except Exception: return None`) passed the whole
    suite. This derives the set structurally and demands the declaration match, so a new
    boundary must be CLASSIFIED — site-rule or coverage — before it can ship.

    THIS TEST IS ALSO WHAT CAUGHT THE HAND-LIST GOING STALE, and it could only do so because
    it parametrizes over a GLOB while the list did not: `spatial-import-visium-hd` (#313)
    shipped a fourth byte-identical `ome_writer.py` whose four boundaries were in no row, and
    this leg went red for that package alone. `IBG.BOUNDARIES` now derives its package
    dimension from the same glob, so the two cannot disagree again — and the comparison below
    stays a real one, because `declared` comes from `IBG.OME_WRITER_POLICIES` (the human
    classification) while `looks_like` comes from the file's own `ast`.
    """
    source = (package_dir / "compute" / "ome_writer.py").read_text(encoding="utf-8")
    looks_like = IBG.declared_boundary_functions(source, "ome_writer.py")
    declared = {fn for pkg, fname, fn, _policy in IBG.BOUNDARIES
                if pkg == package_dir.name and fname == "ome_writer.py"}
    assert looks_like == declared, (
        f"{package_dir.name}/compute/ome_writer.py has functions that catch broadly but are "
        f"not classified in `IBG.BOUNDARIES`:\n"
        f"  undeclared (nothing guards these): {sorted(looks_like - declared)}\n"
        f"  declared but no longer a boundary: {sorted(declared - looks_like)}\n"
        "Add each to BOUNDARIES with its policy — `POLICY_SITE_RULE` if a bug in its own code "
        "must propagate, `POLICY_COVERAGE` if its broad catch is justified by every branch "
        "being tested (that is `read_image`'s attempt 4, and it is a claim about the TESTS).")


#: One unclassified boundary per DETECTION CLAUSE. The battery used to hold only the first —
#: the shape the pre-rewrite derivation already caught — so all three later clauses shipped
#: unpinned and a blind audit reverted the whole rewrite with every suite green. Each entry is
#: a plausible new function appended to the shipped `ome_writer.py`.
_UNCLASSIFIED_BOUNDARIES = {
    "plain-except-Exception": (
        "\n\ndef read_image_thumbnail(path):\n"
        "    try:\n        return read_image(path)\n"
        "    except Exception:\n        return None\n"),
    "except-BaseException": (
        "\n\ndef read_image_thumbnail(path):\n"
        "    try:\n        return read_image(path)\n"
        "    except BaseException:\n        return None\n"),
    "deferred-import-with-a-narrow-except": (
        "\n\ndef read_image_metadata(path):\n"
        "    try:\n        import tifffile\n"
        "        return tifffile.TiffFile(str(path)).pages[0].tags\n"
        "    except OSError:\n        return None\n"),
    "module-level-Exception-alias": (
        "\n_BROAD = Exception\n\n\ndef read_image_thumbnail(path):\n"
        "    try:\n        return read_image(path)\n"
        "    except _BROAD:\n        return None\n"),
    "module-level-alias-as-a-tuple": (
        "\n_BROAD = (Exception,)\n\n\ndef read_image_thumbnail(path):\n"
        "    try:\n        return read_image(path)\n"
        "    except _BROAD:\n        return None\n"),
    "annotated-module-level-alias": (
        "\n_BROAD: type = Exception\n\n\ndef read_image_thumbnail(path):\n"
        "    try:\n        return read_image(path)\n"
        "    except _BROAD:\n        return None\n"),
}


@pytest.mark.parametrize("shape", sorted(_UNCLASSIFIED_BOUNDARIES), ids=sorted(_UNCLASSIFIED_BOUNDARIES))
def test_the_boundary_derivation_notices_a_new_unclassified_boundary(shape):
    """TEST-15 — the completeness check, mutated ONCE PER CLAUSE, and required RED on each.

    The first two are shapes a blind audit added to all three copies and got a green suite for.
    The last two are the ones that walked past the FIRST alias detector: a tuple alias is the
    idiomatic way to write a shared handler type, and the annotated spelling is one this very
    file already enumerates as a maintainer's next reach in `_DENY_LIST_SPELLINGS`.
    """
    source = (_SOURCE_PKG / "compute" / "ome_writer.py").read_text()
    declared = {fn for pkg, fname, fn, _p in IBG.BOUNDARIES
                if pkg == "spatial-types" and fname == "ome_writer.py"}
    assert IBG.declared_boundary_functions(source, "ome_writer.py") == declared, (
        "the shipped source already disagrees with the declaration, so these mutants prove "
        "nothing")
    mutated = source + _UNCLASSIFIED_BOUNDARIES[shape]
    found = IBG.declared_boundary_functions(mutated, "ome_writer.py") - declared
    assert found, (
        f"a new boundary spelled {shape!r} was added and the derivation did not see it, so "
        "`BOUNDARIES` can silently fall behind the code — which is exactly how "
        "`emit_image`'s second-open block came to be guarded by nothing.")


def test_the_declared_boundary_list_covers_every_declared_files_boundaries():
    """TEST-15 (INV-3) — the completeness check, for the rows that are still ENUMERATED.

    The `ome_writer.py` half above is derived over a glob, so a new PACKAGE cannot fall out
    of it. `IBG.EXTRA_BOUNDARIES` is the residue that genuinely cannot be derived — one row,
    `xenium_image.read_plane`, in a package-private helper module — and its own comment states
    what makes it complete. This is the half of that statement a machine can hold: a NEW
    boundary appearing in an already-declared file must still be classified.

    Without it the enumerated row was checked in one direction only. `boundary_offenders`
    reports a declared function that has VANISHED (it returns "there is no `X` in this source
    to check"), but nothing at all noticed a function ARRIVING beside it — which is the
    direction the hand-list failed in every previous time.
    """
    for package, filename, _function, _policy in IBG.EXTRA_BOUNDARIES:
        path = _PACKAGES / package / "compute" / filename
        source = path.read_text(encoding="utf-8")
        looks_like = IBG.declared_boundary_functions(source, filename)
        declared = {fn for pkg, fname, fn, _p in IBG.BOUNDARIES
                    if pkg == package and fname == filename}
        assert looks_like == declared, (
            f"{package}/compute/{filename} has functions that catch broadly but are not "
            f"classified in `IBG.EXTRA_BOUNDARIES`:\n"
            f"  undeclared (nothing guards these): {sorted(looks_like - declared)}\n"
            f"  declared but no longer a boundary: {sorted(declared - looks_like)}\n"
            "Add each with its policy, or move the file under a derivation that spans it.")


#: A FICTIONAL sibling package, shaped exactly like a spatial importer and belonging to no
#: branch. Its whole purpose is to be a package `IBG.BOUNDARIES` was never told about.
_FICTIONAL_PACKAGE = "spatial-import-fictional"

#: The smallest importer that is one: a per-image `try` whose body calls `write_ome_tiff`.
#: Deliberately NOT named `emit_image`/`emit_images` — a derivation that recognised it by
#: name would be an enumeration wearing a regex.
_FICTIONAL_IMPORTER = '''
import ome_writer


def write_every_plane(planes, out):
    for plane in planes:
        try:
            ome_writer.write_ome_tiff(plane, out)
        except (ome_writer.ImageConversionError, OSError) as exc:
            skipped.append(exc)
'''


def test_a_fictional_new_package_is_covered_without_editing_any_list(tmp_path):
    """TEST-15 — the MECHANISM, not the instance (#303/#324, third and fourth occurrence).

    Every previous repair of this class added rows. A row-adding repair is green the day it
    lands and stale the day the NEXT package lands, which is precisely what happened: the
    hand-list was written when three packages shipped `ome_writer.py`, `spatial-import-visium-hd`
    made it four, and four boundaries plus one importer guard were declared by nothing with the
    whole suite green apart from one glob-parametrized leg.

    So the proof that the mechanism is fixed cannot be "the four missing rows are there now".
    It is this: a package that exists in NO list, that no branch has ever mentioned, and whose
    importer's boundary function is deliberately named nothing any real importer is named,
    is covered the moment its directory exists. Nobody edits anything.
    """
    packages = tmp_path / "packages"
    # The real tree, so the derivation's floors are satisfied by real files rather than by a
    # fixture that could drift from them.
    for real in IBG.ome_writer_copies():
        target = packages / real.parents[1].name / "compute"
        target.mkdir(parents=True, exist_ok=True)
        (target / "ome_writer.py").write_text(real.read_text(encoding="utf-8"), encoding="utf-8")
    for real in IBG.image_emitting_importers():
        target = packages / real.parents[1].name / "compute"
        target.mkdir(parents=True, exist_ok=True)
        (target / real.name).write_text(real.read_text(encoding="utf-8"), encoding="utf-8")
    for package, filename, _fn, _policy in IBG.EXTRA_BOUNDARIES:
        real = _PACKAGES / package / "compute" / filename
        target = packages / package / "compute"
        target.mkdir(parents=True, exist_ok=True)
        (target / filename).write_text(real.read_text(encoding="utf-8"), encoding="utf-8")

    before = IBG.derive_boundaries(packages)
    assert not [row for row in before if row[0] == _FICTIONAL_PACKAGE], (
        "the fictional package is already in the derived set before it exists, so the "
        "comparison below proves nothing")

    # THE MUTATION: one new package directory. No list is touched.
    fictional = packages / _FICTIONAL_PACKAGE / "compute"
    fictional.mkdir(parents=True)
    (fictional / "ome_writer.py").write_text(
        (_SOURCE_PKG / "compute" / "ome_writer.py").read_text(encoding="utf-8"),
        encoding="utf-8")
    (fictional / "import_fictional.py").write_text(_FICTIONAL_IMPORTER, encoding="utf-8")

    after = IBG.derive_boundaries(packages)
    new = {row for row in after} - {row for row in before}
    assert {(fname, fn, policy) for _pkg, fname, fn, policy in new} == {
        ("ome_writer.py", "write_ome_tiff", IBG.POLICY_SITE_RULE),
        ("ome_writer.py", "tifffile_version", IBG.POLICY_SITE_RULE),
        ("ome_writer.py", "read_image", IBG.POLICY_COVERAGE),
        ("ome_writer.py", "downsample", IBG.POLICY_COVERAGE),
        ("import_fictional.py", "write_every_plane", IBG.IMPORTER_POLICY),
    }, (
        f"a whole new package shipping an `ome_writer.py` and an image-emitting importer "
        f"appeared and the derivation produced {sorted(new)}. `BOUNDARIES` is back to being a "
        "snapshot: it would go stale in silence the next time a package lands, which is the "
        "#303/#324 class this repair exists to end.")
    assert all(row[0] == _FICTIONAL_PACKAGE for row in new), sorted(new)


def test_raised_in_own_code_refuses_an_argument_it_cannot_compare(tmp_path):
    """TEST-4 (INV-2) — a bad `module_file` must FAIL, not answer "not a bug".

    Every misuse used to fail in the SWALLOW direction: `os.path.realpath` throws `TypeError`
    on a non-path and the handler caught it, so a caller's argument bug became "this image is
    fine, convert it" — the laundering this predicate exists to prevent, one level up.

    `bytes` is the subtle one and is refused deliberately: `realpath(b"/x")` returns `bytes`
    while `co_filename` is always `str`, so a bytes path passed the old type check and then
    compared unequal to EVERYTHING, answering False for every input.
    """
    with _staged_writer(_SOURCE_PKG) as (OW, _SD):
        try:
            raise KeyError("mine")
        except Exception as caught:
            exc = caught
        assert OW.raised_in_own_code(exc, __file__) is True
        assert OW.raised_in_own_code(exc, Path(__file__)) is True, (
            "an `os.PathLike` is a legitimate spelling and must still work")
        for bad in (None, OW, 42, __file__.encode()):
            with pytest.raises(TypeError) as raised:
                OW.raised_in_own_code(exc, bad)
            assert "module_file" in str(raised.value), str(raised.value)


def test_tifffile_version_re_raises_both_refusal_taxonomies(tmp_path):
    """TEST-10 (INV-3) — the pass-through this round added, pinned.

    `tifffile_version` had a broad arm and no pass-through at all, so a deliberate refusal from
    inside it would have been retyped. Not reachable (its `try` holds one import and one
    attribute read) and asserted anyway, because "not reachable today" is what every latent
    finding on this branch said before something moved.
    """
    source = (_SOURCE_PKG / "compute" / "ome_writer.py").read_text()
    offenders = IBG.boundary_offenders(source, "tifffile_version", IBG.POLICY_SITE_RULE)
    assert not offenders, offenders
    tree = ast.parse(source)
    target = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == "tifffile_version")
    passthrough = [
        h for h in ast.walk(target) if isinstance(h, ast.ExceptHandler) and h.type is not None
        and {"ImageConversionError", "SpatialDeclarationError"} <=
        {ast.unparse(n).rsplit(".", 1)[-1]
         for n in (h.type.elts if isinstance(h.type, ast.Tuple) else [h.type])}]
    assert passthrough, (
        "`tifffile_version` has a broad arm and no handler re-raising BOTH refusal taxonomies "
        "ahead of it, so a deliberate refusal reaching it would be retyped into an "
        "`ImageConversionError` and lose what it was telling the producer.")


#: `_reconcile_scale`'s `original_extent`, and where each value must land. The pre-round inline
#: rule and `SD._extent` disagreed THREE ways, and calling the constructor's rule without
#: comparing its result back introduced a fourth: `44.9` silently truncated to `44` and shipped
#: `44.9` into the artifact's own declaration.
_ORIGINAL_EXTENTS = {
    "integers": ({"width": 44, "height": 60}, False),
    # ACCEPTED, and deliberately: `44.0` IS `44` — the comparison below is by VALUE, so nothing
    # is truncated and the block that reaches disk carries the int. The inline rule this
    # replaced refused it on an `isinstance` check, which is stricter than the constructor the
    # refusal message tells the caller to use, and being stricter than your own advice is the
    # disagreement this consolidation exists to remove.
    "float-that-is-whole": ({"width": 44.0, "height": 60}, False),
    # REFUSED, and this is the case that matters: `44.9` normalises to `44`, so merely calling
    # `_extent` and rebinding let it pass leg 2 on the 44 and ship `44.9` in the declaration.
    "float-that-truncates": ({"width": 44.9, "height": 60}, True),
    "a-stray-key": ({"width": 44, "height": 60, "depth": 1}, True),
    "a-list": ([44, 60], True),
    "missing-height": ({"width": 44}, True),
    "zero-width": ({"width": 0, "height": 60}, True),
}


@pytest.mark.parametrize("case", sorted(_ORIGINAL_EXTENTS), ids=sorted(_ORIGINAL_EXTENTS))
def test_the_source_grid_is_validated_by_the_constructors_own_rule(case, tmp_path):
    """TEST-11 (INV-3) — one rule for what a pixel grid IS, and the block that reaches disk is
    the one that was validated.

    `_reconcile_scale`'s refusal message tells the caller to build the block with
    `display_derivative_provenance()`, so the rule that decides has to be the one that
    constructor uses — otherwise the advice is wrong. Calling `SD._extent` gets that, and it
    NORMALISES (`int(_number(...))`, i.e. truncates), so its result is compared back: a
    `{"width": 44.9}` block otherwise passed leg 2 on the truncated `44` and shipped `44.9`
    into the artifact's `txr` payload, where the rule it replaced had refused it.
    """
    value, must_refuse = _ORIGINAL_EXTENTS[case]
    with _staged_writer(_SOURCE_PKG) as (OW, SD):
        arr = _plane()
        placement = {
            "coordinate_space": "t", "unit": "pixel", "microns_per_pixel": 0.5,
            "to_space": [1.0, 0, 0, 0, 1.0, 0],
            "extent": {"width": _W, "height": _H},
            "display_derivative": {
                "downsample_factor": 1,
                "applied_resolution_um": 0.5,
                "emitted_extent": {"width": _W, "height": _H},
                "original_extent": value,
            },
        }
        if must_refuse:
            with pytest.raises(SD.SpatialDeclarationError):
                OW._reconcile_scale(placement, arr, 0.5)
        else:
            OW._reconcile_scale(placement, arr, 0.5)   # the control: it must NOT raise
