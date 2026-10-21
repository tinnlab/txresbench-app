#!/usr/bin/env python3
# ruff: noqa
r"""The bundle is UNTRUSTED INPUT, and it can carry text this importer CANNOT WRITE (#330).

There are TWO doors, and a fix that closes one is not a fix:

* **(a) the h5 ROOT attributes** of `filtered_feature_bc_matrix.h5`. `h5py` decodes a
  UTF-8-typed string attribute with `surrogateescape`, so invalid bytes come back as lone
  surrogates in `U+DC80..U+DCFF` — a `str` no UTF-8 encoder can write; a fixed-length `|S`
  attribute comes back as raw invalid `bytes`, which is the shape the REAL fixture uses for
  `library_ids` (`|S27`).
* **(b) `scalefactors_json.json`**. `json.loads` ACCEPTS a `"\ud800"` escape out of a file that
  is itself PURE ASCII.

Both hand the same unwritable `str` to the same downstream writers. Measured on `origin/main`
@ `d263fac0` over the committed `Visium_Mouse_Olfactory_Bulb` fixture, door (a)'s `str` shape
died with an UNCAUGHT `UnicodeEncodeError`, exit 1 and a traceback, with 59-117 paths already
under `/outputs` and no `manifest.json`; door (a)'s `bytes` shape and ALL of door (b) COMPLETED
and shipped a poisoned or sanitised artifact.

The design is `docs/design/vendor-text-encodability-refusal.md` §6; the invariants it states are
INV-1..INV-6 and each is pinned by an `[acceptance]` test below.

Damage is always done to a COPY. The committed fixtures are never modified.
"""
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


#: The lone surrogate a PURE-ASCII JSON file can smuggle through `json.loads`.
_LONE_SURROGATE = "\ud800"

#: The invalid UTF-8 bytes #330 reports, in the vendor's own attribute shapes.
_BAD_BYTES = b"\xff\xfeSR"


def _copy(tmp_path, name, src=None):
    dest = Path(tmp_path) / name
    shutil.copytree(src or VF.FIXTURE, dest)
    return dest


def _outputs_tree(out):
    """Every path under `out`, relative — the FILESYSTEM answer to 'what survived?'.

    Asked of the filesystem and not of the exception type, because "a refusal was raised" and
    "nothing was written" are different claims and #330 is about the second one.
    """
    out = Path(out)
    if not out.exists():
        return []
    return sorted(p.relative_to(out).as_posix() for p in out.rglob("*"))


def _report(out):
    return json.loads((Path(out) / "visium-import-report.json").read_text(encoding="utf-8"))


#: The three shapes an h5 root attribute can carry unwritable text in, and what h5py hands back
#: for each. The `|S` ARRAY is what the committed real fixture actually uses for `library_ids`
#: (`array([b'Visium_Mouse_Olfactory_Bulb'], dtype='|S27')`), so a `str`-only walk would miss the
#: only shape the vendor really writes for the identity attribute.
_H5_ATTR_SHAPES = [
    ("utf8-str-dtype", lambda h, key: h.attrs.create(
        key, _BAD_BYTES, dtype=__import__("h5py").string_dtype("utf-8"))),
    ("fixed-length-bytes", lambda h, key: h.attrs.create(key, np.bytes_(_BAD_BYTES))),
    ("fixed-length-bytes-array", lambda h, key: h.attrs.create(
        key, np.array([b"ok", _BAD_BYTES], dtype="|S8"))),
]

#: Every attribute `vendor_provenance` reads off the file root. #330 names all three; they are
#: parametrized rather than asserted once and generalized, because a guard narrowed to the
#: reported one (`software_version`) would leave the other two exactly where they were.
_ROOT_ATTRS = ["software_version", "chemistry_description", "library_ids"]


def _poison_h5_root(bundle, attr, write_attr):
    import h5py

    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        write_attr(handle, attr)
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r") as handle:
        return handle.attrs[attr]


def _write_scalefactors(bundle, mutate):
    """Apply `mutate` to the bundle's own scale document and write it back as PURE ASCII.

    `ensure_ascii=True` + `encoding="ascii"` is the point of door (b): the file on disk stays a
    plain ASCII file, and the unwritable string only comes into existence when `json.loads`
    decodes the escape. A test that wrote UTF-8 bytes would be measuring something else.
    """
    path = bundle / "spatial" / "scalefactors_json.json"
    doc = json.loads(path.read_text())
    mutate(doc)
    path.write_text(json.dumps(doc, ensure_ascii=True), encoding="ascii")
    assert all(b < 128 for b in path.read_bytes()), "the vendor file must still be pure ASCII"
    return path


# ── TEST-1 / TEST-2 / TEST-8: the SHIPPED ENTRYPOINT, as the sandbox runs it ─────────


def test_TEST_1_the_shipped_entrypoint_REFUSES_BY_NAME_instead_of_a_traceback(tmp_path):
    """TEST-1 [acceptance INV-1] — #330's exact reported repro, through `main()` itself.

    Everything else here drives `run_import` in-process, which cannot see the half of the defect
    that matters to a user: `main()` catches only `VisiumImportError`, so an unwritable root
    attribute reached the operator as a raw stack trace and exit **1**.

    MEASURED on `origin/main` @ `d263fac0`, `software_version = b"\\xff\\xfeSR"` written under
    `h5py.string_dtype("utf-8")`:

        UnicodeEncodeError: 'utf-8' codec can't encode characters in position
        1171568-1171569: surrogates not allowed          <- UNCAUGHT
        exit 1, traceback on stderr, spatial/coordinates.zarr already on disk

    The assertions below are on the EXIT CODE and on the absence of the word `Traceback` in
    stderr, because those are the two things that decide whether a user gets a refusal or a
    stack trace. A body that merely moved the crash cannot pass.
    """
    bundle = _copy(tmp_path, "entry-refusal")
    _poison_h5_root(bundle, "software_version", _H5_ATTR_SHAPES[0][1])
    outputs = tmp_path / "outputs"

    result = VF.run_entry(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert "UnicodeEncodeError" not in result.stderr, result.stderr[-3000:]
    assert "spatial.import-visium:" in result.stderr, result.stderr[-3000:]
    assert "filtered_feature_bc_matrix.h5" in result.stderr, result.stderr[-3000:]
    assert "software_version" in result.stderr, result.stderr[-3000:]


#: The two doors, each in the shape its own parse really produces, for the tests that must hold
#: at BOTH of them. A fix at one door leaves the other leg of every one of these red.
_BOTH_DOORS = [
    ("h5-root-attribute",
     lambda bundle: _poison_h5_root(bundle, "software_version", _H5_ATTR_SHAPES[0][1])),
    ("scalefactors-json",
     lambda bundle: _write_scalefactors(
         bundle, lambda doc: doc.update({"vendor_note": _LONE_SURROGATE + "BAD"}))),
]


@pytest.mark.parametrize("door,poison", _BOTH_DOORS, ids=[d for d, _ in _BOTH_DOORS])
def test_TEST_2_a_refused_bundle_leaves_NO_partial_store_on_disk(door, poison, tmp_path):
    """TEST-2 [acceptance INV-2] — asked of the FILESYSTEM, not of the exception type.

    This is the half of #330 that makes it worse than a crash, and it is the half the guard's
    PLACEMENT (not its existence) is responsible for. MEASURED on `origin/main` over these exact
    inputs: 117 paths under `/outputs` for the h5 door (59 for `library_ids`, which dies earlier,
    inside the declaration mirror) and 117 for the scalefactors door, with
    `spatial/coordinates.zarr` written and NO `manifest.json`.

    The scalefactors leg is why `read_scalefactors` had to MOVE: at its old call site in the
    coordinate-space block, after the first writer, a refusal would have fired with the
    expression store, both axis stores and every metadata column already on disk. Revert the
    hoist and this test's second parameter goes red while its first stays green — which is
    exactly the "same rule applied to one field fewer" shape it exists to catch.
    """
    bundle = _copy(tmp_path, f"no-partial-{door}")
    poison(bundle)
    outputs = tmp_path / "outputs"

    result = VF.run_entry(bundle, outputs)
    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])

    survivors = _outputs_tree(outputs)
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"
    assert not (outputs / "spatial" / "coordinates.zarr").exists()
    assert list(Path(outputs).rglob("zarr.json")) == []
    assert not (outputs / "visium-import-report.json").exists()
    assert not (outputs / "visium-import-summary.html").exists()
    assert not (outputs / "manifest.json").exists()


def test_TEST_8_an_ORDINARY_bundle_still_imports_under_a_NON_UTF8_LOCALE(tmp_path):
    """TEST-8 [acceptance INV-1] — the traceback that needs no hostile input at all.

    `run_import` wrote `manifest.json`, the report and the summary with `write_text(...)` and NO
    `encoding=`, i.e. the LOCALE default. MEASURED on `origin/main`, on the ORDINARY committed
    fixture, in a subprocess whose preferred encoding is `ANSI_X3.4-1968`:

        UnicodeEncodeError: 'ascii' codec can't encode character '\\u2014' in position 517
          import_visium.py  run_import  ->  visium-import-summary.html
        paths on disk: 117

    `\\u2014` is an em dash in THIS MODULE'S OWN PROSE. So on a machine with a non-UTF-8 locale
    EVERY Visium import died with an uncaught `UnicodeEncodeError` and exit 1 after 117 paths
    were on disk — INV-1 and INV-2 both false, reached by the ENVIRONMENT rather than by an
    attacker, on a bundle with nothing wrong with it.

    The four environment variables are all needed: drop any one and the child is back in UTF-8
    and this test proves nothing. So the encoding the child really got is MEASURED first, in its
    own probe subprocess carrying the identical environment, rather than assumed.
    """
    probe = subprocess.run(
        [sys.executable, "-c",
         "import locale; print(locale.getpreferredencoding(False))"],
        capture_output=True, text=True, env=dict(os.environ, **VF.ASCII_LOCALE_ENV), timeout=300,
    )
    got = probe.stdout.strip().lower()
    assert got not in ("utf-8", "utf8"), (
        f"the ASCII-locale environment did not take on this host (got {got!r}); this test would "
        "prove nothing, so it fails rather than passing vacuously"
    )

    outputs = tmp_path / "outputs"
    result = VF.run_entry(VF.FIXTURE, outputs, env=VF.ASCII_LOCALE_ENV)

    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (outputs / "manifest.json").is_file()
    assert (outputs / "visium-import-summary.html").is_file()
    # And the prose that used to abort the write is really in the emitted bytes.
    body = (outputs / "visium-import-summary.html").read_bytes()
    assert "—".encode("utf-8") in body, "the em dash that used to abort this write is gone"


# ── TEST-3 / TEST-4: ONE predicate, at BOTH boundaries, over every shape ─────────────


@pytest.mark.parametrize("attr", _ROOT_ATTRS)
@pytest.mark.parametrize("shape,write_attr", _H5_ATTR_SHAPES,
                         ids=[s for s, _ in _H5_ATTR_SHAPES])
def test_TEST_3_every_h5_ROOT_attribute_and_every_SHAPE_is_refused(
        attr, shape, write_attr, tmp_path):
    """TEST-3 [acceptance INV-3] — door (a), all three attributes x all three dtypes.

    #330 names three attributes and `vendor_provenance` reads exactly those three. They are
    PARAMETRIZED rather than asserted once and generalized: a guard sized to the reported field
    (`software_version`) would have closed one ninth of this.

    The three SHAPES are the load-bearing half. h5py hands back a different Python type per
    attribute dtype and only ONE of them is a `str`:

    * a `utf-8` string dtype -> `'\\udcff\\udcfeSR'`, a surrogate-escaped `str`;
    * a fixed-length `|S` dtype -> `b'\\xff\\xfeSR'`, raw `bytes`;
    * an ARRAY of `|S` -> a `numpy.ndarray` of those bytes.

    **The committed real fixture stores `library_ids` as the THIRD** —
    `array([b'Visium_Mouse_Olfactory_Bulb'], dtype='|S27')` — so a `str`-only walk misses the
    only shape the vendor actually writes for the identity attribute, while looking guarded.
    MEASURED before the guard: the `str` shape crashed with an uncaught `UnicodeEncodeError`;
    both `bytes` shapes COMPLETED and shipped a sanitised identifier.

    The DIAGNOSIS is asserted against the shape as well. Nothing else here pins it, so without
    this the two arms of `refuse_unencodable_vendor_text` could report each other's message and
    every other assertion stay green.
    """
    bundle = _copy(tmp_path, f"h5-{attr}-{shape}")
    got = _poison_h5_root(bundle, attr, write_attr)
    # The PREMISE, asserted rather than assumed: whatever shape this is, it must be one the
    # importer could not write. Otherwise the test proves nothing about the guard.
    flat = got.tolist() if isinstance(got, np.ndarray) else [got]
    def _unwritable(v):
        try:
            (v.decode("utf-8") if isinstance(v, bytes) else v.encode("utf-8"))
        except (UnicodeDecodeError, UnicodeEncodeError):
            return True
        return False
    assert any(_unwritable(v) for v in flat), (shape, repr(got))

    out = tmp_path / f"out-{attr}-{shape}"
    out.mkdir()
    module = VF.load_compute()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    exc = caught.value

    assert not isinstance(exc, UnicodeEncodeError), (
        f"{attr}/{shape}: the reported defect, unfixed — the writer aborted instead of the "
        "reader refusing"
    )
    assert type(exc).__name__ == "VisiumImportError", f"{type(exc).__name__}: {exc}"
    assert "filtered_feature_bc_matrix.h5" in str(exc), str(exc)
    assert attr in str(exc), str(exc)
    assert _outputs_tree(out) == [], f"{attr}/{shape}: a refused import left artifacts behind"
    if shape == "utf8-str-dtype":
        assert "LONE SURROGATE" in str(exc), str(exc)
    else:
        assert "BYTES THAT ARE NOT VALID UTF-8" in str(exc), str(exc)


#: Door (b)'s mutants. Every one of them COMPLETED on `origin/main`, exit 0, 117 paths, with the
#: escape landing in `visium-import-report.json` (which `serde_json` — the crate the server
#: parses it with — then refuses). None of them crashes, which is why this door is the SILENT one
#: and why it cannot be found by chasing the reported traceback.
_SCALEFACTOR_MUTANTS = [
    ("new-key-value", lambda doc: doc.update({"vendor_note": _LONE_SURROGATE + "BAD"})),
    ("real-key-value", lambda doc: doc.update({"spot_diameter_fullres": _LONE_SURROGATE + "BAD"})),
    ("hostile-key", lambda doc: doc.update({_LONE_SURROGATE + "key": 1})),
    ("nested-in-a-list", lambda doc: doc.update({"notes": ["ok", {"v": _LONE_SURROGATE + "x"}]})),
    ("trailing-low-surrogate", lambda doc: doc.update({"vendor_note": "NOTE\udfff"})),
]


@pytest.mark.parametrize("label,mutate", _SCALEFACTOR_MUTANTS,
                         ids=[label for label, _ in _SCALEFACTOR_MUTANTS])
def test_TEST_4_the_scalefactors_JSON_is_the_SECOND_door_and_is_refused_too(
        label, mutate, tmp_path):
    """TEST-4 [acceptance INV-3] — door (b), from a file that is itself PURE ASCII.

    `read_scalefactors` parses the vendor's scale file with the identical
    `json.loads(Path(path).read_text())` #329 guards on the Xenium side, and `json.loads` ACCEPTS
    a `"\\ud800"` escape. `_write_scalefactors` asserts the bytes on disk are still all < 128, so
    this is genuinely a second door and not a re-statement of door (a): no invalid byte ever
    touches the filesystem, and the unwritable string comes into existence inside `json.loads`.

    The mutants cover a NEW key's value, a REAL vendor key's value, a hostile KEY (`json.dumps`
    writes a key into the same artifact bytes a value goes into), a value NESTED inside a list
    inside a dict, and a TRAILING low surrogate so the guard cannot be "the string starts with
    one". A guard narrowed to top-level values, to `str` keys, or to the fields the module
    happens to read turns one of these red.
    """
    bundle = _copy(tmp_path, f"sf-{label}")
    _write_scalefactors(bundle, mutate)

    out = tmp_path / f"out-sf-{label}"
    out.mkdir()
    module = VF.load_compute()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    exc = caught.value

    assert type(exc).__name__ == "VisiumImportError", f"{type(exc).__name__}: {exc}"
    assert "scalefactors_json.json" in str(exc), str(exc)
    assert _outputs_tree(out) == [], f"{label}: a refused import left artifacts behind"


# ── TEST-5: refused, never repaired ──────────────────────────────────────────────────


def test_TEST_5_three_distinct_hostile_byte_strings_no_longer_COLLIDE(tmp_path):
    """TEST-5 [acceptance INV-4] — the design's REFUSE-not-sanitise decision, as behaviour.

    Sanitising is the tempting alternative and it is not hypothetical on this package: it is what
    `vendor_provenance`'s own `text()` helper does (`v.decode(errors="replace")`), and door (a)'s
    `bytes` arm reaches it. MEASURED on `origin/main`, one import per byte string:

        b'\\xff\\xfeSR'  -> COMPLETED  provenance.library_id = '\\ufffd\\ufffdSR'
        b'\\xfe\\xffSR'  -> COMPLETED  provenance.library_id = '\\ufffd\\ufffdSR'
        b'\\x80\\x81SR'  -> COMPLETED  provenance.library_id = '\\ufffd\\ufffdSR'
        and, since `coordinate_space_id` derives the frame from that value:
        report.coordinate_space = 'visium:\\ufffd\\ufffdSR'   -- for ALL THREE

    ONE sample identity and ONE coordinate frame from THREE slides that are not the same slide.
    `resolveOverlayBinding` compares frame ids by EQUALITY, so those three would have bound to
    each other silently — the #320 false-collision class.

    So the proof that this branch did NOT take that route is threefold: each input now refuses,
    each refusal QUOTES A DISTINCT value (a guard that refused but reported a normalised value
    would be a quieter version of the same collision), and nothing is written at all — there is
    no artifact in which a repaired value could hide.
    """
    module = VF.load_compute()
    messages = []
    for raw in (b"\xff\xfeSR", b"\xfe\xffSR", b"\x80\x81SR"):
        bundle = _copy(tmp_path, f"collide-{raw.hex()}")
        _poison_h5_root(bundle, "library_ids", lambda h, key, r=raw: h.attrs.create(
            key, np.bytes_(r)))
        out = tmp_path / f"out-collide-{raw.hex()}"
        out.mkdir()
        with pytest.raises(Exception) as caught:
            module.run_import(bundle, out)
        assert type(caught.value).__name__ == "VisiumImportError", type(caught.value).__name__
        assert _outputs_tree(out) == [], "a refused import must leave nothing to collide in"
        message = str(caught.value)
        assert "�" not in message, (
            "the refusal must not itself substitute a character — that is the collision, "
            "relocated into the message"
        )
        assert "library_ids" in message, message
        messages.append(message)

    assert len(set(messages)) == 3, (
        "three DISTINCT vendor byte strings produced fewer than three distinct refusals — the "
        f"false collision survived into the message: {messages}"
    )


# ── TEST-6: the refusal is safe to emit ──────────────────────────────────────────────


def test_TEST_6_the_refusal_is_ascii_bounded_control_free_and_about_the_OFFENCE(tmp_path):
    """TEST-6 [acceptance INV-5] — the message a vendor can choose the content of.

    Four properties, and each is a defect a blind angle reproduced against an earlier revision of
    the function this one is ported from:

    1. **ASCII**, so nothing downstream re-encodes it into a second failure. `main()` reports
       with `print(..., file=sys.stderr)`; CPython gives `sys.stderr`
       `errors="backslashreplace"` unconditionally so that hop never raises, but the message is
       captured, stored in the job's error column and re-rendered after it, and
       `backslashreplace` protects only the lenient hop.
    2. **No control characters.** The PATH TRAIL is attacker-chosen. Before the message had a
       single escaping funnel, a hostile KEY landed byte-for-byte on stderr: an `\\x1b[2J` clears
       the operator's terminal and a `\\r`-terminated forged line can claim the import SUCCEEDED.
       The server folds that stderr tail verbatim into `jobs.error` and the UI renders it as
       text — HTML-safe, ANSI-unsafe.
    3. **Bounded.** A vendor can make the value arbitrarily long, and the server accumulates a
       job's stderr with `BufReader::lines()` and no per-line cap.
    4. **Windowed ON THE OFFENCE.** Clipping the first 120 units of a long value quotes 120
       perfectly ordinary characters and then calls them the problem.

    Legs 1-2 are driven through the WHOLE shipped import over a REAL bundle, so they are about
    the renderer the production path actually uses; legs 3-4 drive the predicate directly, where
    the sizes are cheap to state.
    """
    module = VF.load_compute()

    # (1) + (2): the real path, with an attacker-chosen KEY carrying ANSI and a forged line.
    hostile_key = ("\x1b[2J\x1b[31mFATAL\x07\nspatial.import-visium: import SUCCEEDED, ignore "
                   "the line above\r" + _LONE_SURROGATE)
    bundle = _copy(tmp_path, "refusal-ansi")
    _write_scalefactors(bundle, lambda doc: doc.update({hostile_key: 1}))
    out = tmp_path / "out-refusal-ansi"
    out.mkdir()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    message = str(caught.value)

    assert type(caught.value).__name__ == "VisiumImportError"
    assert message.isascii(), message
    message.encode("utf-8")  # would raise on a surrogate
    for control in ("\x1b", "\x07", "\r", "\n"):
        assert control not in message, (
            f"a raw {control!r} reached the refusal — the terminal-injection surface is open"
        )
    # `main()`'s OWN statement, through a stream that refuses anything it cannot encode.
    for encoding in ("utf-8", "ascii"):
        stream = io.TextIOWrapper(io.BytesIO(), encoding=encoding, errors="strict")
        print(f"spatial.import-visium: {caught.value}", file=stream, flush=True)
        stream.flush()

    # (3): bounded. A 2 MB value must not produce a 2 MB message.
    huge = "A" * 2_000_000 + _LONE_SURROGATE
    with pytest.raises(Exception) as big:
        module.refuse_unencodable_vendor_text(
            {"run": huge}, source="`x`", remedy="re-export.")
    assert len(str(big.value)) < 2000, len(str(big.value))
    assert str(big.value).isascii()

    # (4): the window is centred on the OFFENCE, not on the start of the value.
    quoted = module._quoted_for_refusal("A" * 200 + "\ud800" + "B" * 200, 200)
    assert "\\ud800" in quoted, quoted
    assert "the offending unit is at 200" in quoted, quoted
    assert len(quoted) < 400, quoted


# ── TEST-7: THE POSITIVE CONTROL ─────────────────────────────────────────────────────


def test_TEST_7_legitimate_non_ascii_and_an_ASTRAL_character_still_IMPORT(tmp_path):
    """TEST-7 [acceptance INV-6] — the control that stops this becoming "refuse all non-ASCII".

    Two things a real vendor file can legitimately carry and this importer must still accept:

    * ordinary non-ASCII text (`µ`, `ä`) in an h5 root attribute — encodable, and already
      reaching the artifact through `ensure_ascii=False` in the declaration mirror;
    * an ASTRAL character, which in a JSON file is written as a surrogate PAIR escape
      (`"\\ud83e\\uddec"`). `json.loads` assembles the pair into the SINGLE codepoint U+1F9EC
      before any guard sees it, and that encodes to UTF-8 perfectly.

    The astral leg is also why the guard tests the ENCODE. Note the correction it does NOT rest
    on: a `U+D800..U+DFFF` codepoint scan over the assembled `str` would ACCEPT this character
    too (`any(0xD800 <= ord(c) <= 0xDFFF for c in json.loads('"\\ud83e\\uddec"'))` is `False`),
    so "a range check would refuse an astral character" — the reason #329's docstring gives — is
    FALSE. The reason a range check is wrong is that it cannot see the BYTES arm at all.

    Without this test the guard could be "reject anything that is not ASCII" and every other
    assertion in this file would still pass.
    """
    import h5py

    legit_library = "Bulb \U0001f9ec µm Gewächs"
    bundle = _copy(tmp_path, "legit-unicode")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("software_version", "spaceranger-2.0.0 µm Gewächs",
                            dtype=h5py.string_dtype("utf-8"))
        # `library_ids` DELIBERATELY, and not only `software_version`: it is the one vendor
        # string that reaches the coordinate store's own `zarr.json` (through
        # `coordinate_space_id` and `section.sample_id`), which is the write that ABORTED on the
        # hostile version of this test. A control that only reached the report would leave the
        # crashing write unproven.
        handle.attrs.create("library_ids", legit_library, dtype=h5py.string_dtype("utf-8"))
    path = _write_scalefactors(bundle, lambda doc: doc.update({"vendor_note": "run \U0001f9ec"}))
    assert b"\\ud83e\\uddec" in path.read_bytes(), "the astral char must be a surrogate PAIR escape"

    out = tmp_path / "out-legit-unicode"
    _module, entries = VF.run_over(bundle, out)

    report = _report(out)
    assert report["provenance"]["pipeline"] == "spaceranger-2.0.0 µm Gewächs", report["provenance"]
    assert report["provenance"]["library_id"] == legit_library, report["provenance"]
    assert report["scalefactors"]["vendor_note"] == "run \U0001f9ec", report["scalefactors"]
    # And it survived into the STORE's own bytes, which is the write that used to abort.
    stamped = (out / "spatial" / "coordinates.zarr" / "zarr.json").read_text(encoding="utf-8")
    assert f"visium:{legit_library}" in stamped, stamped
    assert "Gewächs" in stamped and "\U0001f9ec" in stamped
    assert VF.entry_by_id(entries, "spatial-coordinates")["meta"]["n"] > 0


# ── TEST-9 / TEST-10: the packaging rule and the design binding ──────────────────────


def test_TEST_9_the_package_manifest_version_moved_past_the_body_that_shipped_the_defect():
    """TEST-9 — `check-processor-seed-versions.sh`'s rule, asserted from the package's own suite.

    `0.10.0` is the version that shipped the unguarded `dict(h5.attrs)` and the unguarded
    `read_scalefactors`. A later edit to this package's `compute/` that forgets the bump
    republishes a changed processor under a version a consumer has already cached.

    **HONEST LIMIT, stated here because it is easy to mistake this for evidence: this assertion
    PASSES WITH THE ENTIRE #330 GUARD REVERTED.** It is a PACKAGING check, not a behavioural one,
    and it proves nothing about whether anything works — that is TEST-1..TEST-8's job. It is kept
    because the version rule is real and is otherwise enforced only by a repo-level script this
    package's own suite cannot see. The changelog half is asserted too, because this manifest
    carries a LOG BLOCK and a bare number bump breaks the convention silently.

    **AMENDED at #336, and the amendment is a WIDENING.** The last assertion used to be
    `"#330" in log[0]`, i.e. *the DECLARED version's entry is #330's*. That is true only until
    the next release of this package, and #336 is it — the assertion went red on a manifest that
    is entirely correct. What it MEANT is asserted instead, in two parts that together cover
    strictly more than the one line did: the declared version's entry must NAME AN ISSUE (so a
    bump still cannot ship without a log entry that says why), and **#330's own `0.11.0` entry
    must still be present** (so this record cannot be dropped or rewritten by a later bump —
    which the old spelling did not check at all, since it only ever looked at whichever entry
    happened to be current).
    """
    import re as _re

    manifest = (VF.PKG / "manifest.yaml").read_text(encoding="utf-8")
    declared = [ln.split(":", 1)[1].strip() for ln in manifest.splitlines()
                if ln.startswith("version:")]
    assert len(declared) == 1, declared
    parts = tuple(int(x) for x in declared[0].split("."))
    assert parts > (0, 10, 0), f"manifest version {declared[0]} did not move past 0.10.0"

    log = [ln for ln in manifest.splitlines() if ln.startswith(f"# {declared[0]} ")]
    assert len(log) == 1, (
        f"no `# {declared[0]} — ...` changelog entry for the declared version; this manifest "
        f"carries a log block and a bare number bump breaks the convention. Found: {log}"
    )
    assert _re.search(r"#\d+", log[0]), (
        f"the {declared[0]} changelog entry names no issue: {log[0]!r}"
    )
    # #330's own entry survives every later bump — this is the record, not a snapshot of "latest".
    guard_entry = [ln for ln in manifest.splitlines() if ln.startswith("# 0.11.0 ")]
    assert len(guard_entry) == 1 and "#330" in guard_entry[0], (
        f"the 0.11.0 changelog entry recording this guard is gone or no longer names #330: "
        f"{guard_entry}"
    )
    assert parts >= (0, 11, 0), f"manifest version {declared[0]} is below the guard's own 0.11.0"


def test_TEST_10_the_named_design_and_the_shipped_guard_still_describe_each_other():
    """TEST-10 — the design note held against the CODE, in BOTH directions.

    A note-only assertion cannot notice that the code stopped implementing the note, which is the
    one thing a design-conformance guard is for — measured on #329, whose first version of this
    test passed with the entire guard reverted.

    So this binds the two. The NOTE must still state the decision (REFUSE, not sanitise) and
    still name BOTH doors; the shipped MODULE must still define the predicate and CALL it at
    exactly TWO sites. Revert the guard and the code half goes red; flip the decision to
    sanitisation and the note half goes red; guard one door and the call-site count goes red.
    """
    note = VF.PKG.parents[2] / "docs" / "design" / "vendor-text-encodability-refusal.md"
    body = note.read_text(encoding="utf-8")
    assert "#330" in body, "the design note does not name this item"
    for phrase in ("REFUSE", "sanitis", "scalefactors_json.json", "root attributes"):
        assert phrase in body, f"the design note no longer states {phrase!r}"

    source = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    assert "def unencodable_vendor_text(" in source
    assert "def refuse_unencodable_vendor_text(" in source
    calls = source.count("refuse_unencodable_vendor_text(\n")
    assert calls == 2, (
        f"the predicate is CALLED at {calls} site(s); #330 has TWO parse boundaries and a guard "
        "at one of them is not a guard"
    )
    # DEC-7, pinned. #329's copy of this docstring justifies "test the encode" with a claim a
    # measurement falsified — that a `U+D800..U+DFFF` range check "would refuse a legitimate
    # astral character". `json.loads` assembles the surrogate PAIR before any guard sees it, so
    # a range scan over the resulting `str` ACCEPTS every astral character (TEST-7 runs that
    # measurement). A true rule kept alive by a false reason is a rule the next reader deletes
    # after checking the reason, so this branch deliberately did not copy the sentence forward
    # and nothing else pins that.
    assert "would also REFUSE a legitimate astral character" not in source, (
        "#329's falsified justification was copied into this module — see DEC-7"
    )
    assert "range scan cannot see the BYTES arm" in source, (
        "the TRUE reason for testing the encode is no longer stated"
    )

    # FIX_ROUND-2, the same rule applied to the prose the blind angles falsified. Each of these
    # was a claim the note or the module made that MEASURED false, or a correction that landed in
    # one place and not another; none of them is caught by any behavioural test, which is
    # precisely why they belong to the design-binding one.
    # Stated POSITIVELY, every one of them. A negative text assertion is defeated by the very
    # correction it is checking for — the first spelling of the block below asserted that the
    # falsified sentence was ABSENT and went red on the paragraph that QUOTES it while correcting
    # it. That is the syntactic-guard antipattern this design argues against, twice caught in this
    # file's own history (DRIFT-1.2), so the rule here is: assert what the prose must SAY.
    assert "§6.9" in body, "the round that fixed round 1's own fixes is not recorded"
    assert "degrade-to-`{}` contract for an UNPARSEABLE file" in body, (
        "§6.3 does not carry the ABSENT correction — an absent scale file is refused by "
        "`locate_members` and never reaches `read_scalefactors`"
    )
    assert "An UNPARSEABLE file is DAMAGED" in source, (
        "`read_scalefactors`' own paragraph does not carry the ABSENT correction"
    )
    assert "(OSError, ValueError, RecursionError)" in source, (
        "the docstring no longer names the narrowing it actually has"
    )
    assert 'node.dtype.kind in "biufcMm"' in source, (
        "the ndarray skip is not the DENY-list: an allow-list re-opens door (a), because `V` is "
        "the STRUCTURED dtype and its fields can be text — see §6.9 and TEST-20"
    )
    assert "_MAX_WALKED_ATTRIBUTE_BYTES" in source, "the work bound is gone"
    # INV-1 and INV-5 must be scoped to the same standard INV-2 is, because §6.8 records
    # reachable violations of both.
    assert "Scoped like INV-2" in body, "INV-1 carries no scope note while §6.8 records three"
    assert "Scoped to the refusals THIS DESIGN adds" in body, "INV-5 carries no scope note"
    # And every §6.8 item that is FILED must name its issue, or "filed" is an unverifiable word.
    for issue in ("#336", "#337", "#338", "#341"):
        assert issue in body, f"§6.8 names no {issue}"


# ── TEST-11 / TEST-12: the controls ──────────────────────────────────────────────────


@pytest.mark.parametrize("root,design_id,spot_um", VF.COMMITTED_BUNDLES,
                         ids=[Path(r).name for r, _, _ in VF.COMMITTED_BUNDLES])
def test_TEST_11_every_committed_real_bundle_still_imports_unchanged(
        root, design_id, spot_um, tmp_path):
    """TEST-11 — THE CONTROL for both the guard AND the hoist. A guard that refuses everything is
    not a guard, and a reordered read that changes its own result is not a hoist.

    All THREE committed real vendor bundles go through the shipped import here, and the report's
    scale block is compared against the bundle's OWN `scalefactors_json.json` parsed
    independently of the importer — which is the direct evidence that moving
    `read_scalefactors` to the top of `run_import` did not change what it returns or what
    consumes it.
    """
    out = tmp_path / f"out-{Path(root).name}"
    _module, entries = VF.run_over(root, out)
    report = _report(out)

    assert report["scalefactors"] == VF.scalefactors(root), (
        "the hoisted scale read no longer agrees with the bundle's own file"
    )
    assert report["slide_design"]["id"] == design_id, report["slide_design"]
    assert report["slide_design"]["rendered_spot_diameter_um"] == spot_um, report["slide_design"]
    assert report["microns_per_pixel"] is not None
    assert report["microns_per_pixel_source"]
    assert VF.entry_by_id(entries, "spatial-coordinates")["meta"]["n"] > 0
    assert (out / "manifest.json").exists() is False, (
        "run_import does not write the manifest; main() does"
    )


def test_TEST_12_a_damaged_scale_file_still_DEGRADES_rather_than_being_refused(tmp_path):
    """TEST-12 — the boundary between DAMAGED (degrade) and MALFORMED (refuse), as behaviour.

    `read_scalefactors`' `{}` is a deliberate contract, stated in its own docstring: "a bundle
    with a damaged scale file is still importable — the coordinates are still correct in pixels
    — it simply DECLARES NO SCALE... What is refused is inventing one." The new raise sits AFTER
    that narrowing precisely so it cannot swallow that leg, and without this test a guard placed
    one line earlier would turn every damaged bundle into a refusal with nothing going red.

    A file that parses CLEANLY and carries unwritable text is the OTHER fact — nothing is
    missing, so nothing is being invented — and TEST-4 covers it.
    """
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path, drop_scalefactors=True)   # writes "{ this is not json"
    text = (bundle / "spatial" / "scalefactors_json.json").read_text()
    assert text == "{ this is not json", text

    assert module.read_scalefactors(bundle / "spatial" / "scalefactors_json.json") == {}

    out = tmp_path / "out-degraded"
    _entries = module.run_import(bundle, out)
    report = _report(out)
    assert report["scalefactors"] == {}
    assert report.get("microns_per_pixel") is None, report.get("microns_per_pixel")
    assert "scale_note" in report, "a bundle that declares no scale must say so"


# ═════════════════ FIX_ROUND-1: what three blind angles found ═══════════════════════
#
# Every test below pins a defect a blind audit REPRODUCED against the first version of this
# branch. They are grouped here rather than folded above so the round they came from stays
# legible.


def test_TEST_13_an_h5_root_attribute_the_importer_NEVER_READS_is_still_refused(tmp_path):
    """TEST-13 [acceptance INV-3] — the "not per field" half of the rule, pinned at DOOR (a).

    The design's central argument for guarding at the boundary rather than at each consumer is
    that WHICH fields are read onto an artifact is a property of TODAY's module, so a rule scoped
    to today's readers silently stops covering a field the day someone reads one more.

    The blind design-conformance angle measured that this argument was **unpinned on door (a)**:
    narrowing the h5 guard to exactly the three attributes `vendor_provenance` reads left the
    ENTIRE package suite green, because `_ROOT_ATTRS` above is exactly that three-element set.
    Door (b) was already pinned (narrowing it to top-level `str` values reddens TEST-4/TEST-6);
    door (a) was not — the same asymmetry the design says it exists to prevent.

    So this poisons an attribute NOTHING in this module reads. Re-narrow the guard to the three
    read attributes and this is the test that goes red.

    **It also states the COST, which is real and is the honest half of the same choice**: a
    bundle carrying an unreadable-by-us root attribute (a checksum, a vendor blob — perfectly
    legal HDF5) that imported before is now REFUSED. That is disclosed in the design note §6.1
    and in the manifest's changelog rather than being left for an integrator to discover.
    """
    import h5py

    bundle = _copy(tmp_path, "unread-attr")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("vendor_blob", np.array([b"\x89PNG\xff\xfe"], dtype="|S10"))
    source = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    assert "vendor_blob" not in source, (
        "this attribute must be one the module NEVER reads, or the test proves nothing"
    )

    out = tmp_path / "out-unread-attr"
    out.mkdir()
    module = VF.load_compute()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    assert type(caught.value).__name__ == "VisiumImportError", type(caught.value).__name__
    assert "vendor_blob" in str(caught.value), str(caught.value)
    assert _outputs_tree(out) == []


#: The three h5 IDENTITY datasets, in the two dtypes h5py returns them in. Each was a raw
#: `UnicodeDecodeError` traceback + exit 1 before FIX_ROUND-1 — INV-1's prohibited outcome, on
#: the same file the root-attribute guard had just walked, in the same `run_import` block.
_IDENTITY_DATASETS = [
    ("barcodes", "matrix/barcodes", "|S18"),
    ("features-id", "matrix/features/id", "|S18"),
    ("features-name", "matrix/features/name", "|S16"),
]


@pytest.mark.parametrize("label,dataset,dtype", _IDENTITY_DATASETS,
                         ids=[label for label, _, _ in _IDENTITY_DATASETS])
def test_TEST_14_an_h5_IDENTITY_dataset_that_is_not_utf8_is_refused_BY_NAME(
        label, dataset, dtype, tmp_path):
    """TEST-14 [acceptance INV-1] — the THIRD door in the same file, found by all three angles.

    `run_import` read these three with a bare `.decode()`. Strict is CORRECT — a barcode is the
    key the positions table is joined on and a feature id is what a gene list is matched against,
    so `errors="replace"` would turn a join FAILURE into a WRONG join — but nothing caught what
    strict raises, and `main()` catches only `VisiumImportError`. MEASURED before FIX_ROUND-1:

        rc=1  paths=0  UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 0

    A traceback and exit 1, which is exactly what #330 reports for the root attributes. INV-2
    survived by ordering alone (these reads precede the first writer); INV-1 did not.

    The refusal must name the DATASET and the ROW, because a codec's "position 0" is a byte
    offset inside one value and is not what an operator needs in order to go and look.
    """
    import h5py

    bundle = _copy(tmp_path, f"identity-{label}")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        # The dtype is ASSERTED rather than carried as a dead parameter. A blind angle found the
        # first version of this list declared `|S16` for `features/id`, which the real fixture
        # writes as `|S18` -- an unread parameter cannot be wrong, which is exactly why it should
        # not be there. Now it pins the shape the test claims to exercise.
        assert handle[dataset].dtype.str.lstrip("|") == dtype.lstrip("|"), (
            dataset, handle[dataset].dtype)
        values = handle[dataset][:]
        values[0] = b"\xff\xfeBAD"
        handle[dataset][:] = values

    out = tmp_path / f"out-identity-{label}"
    out.mkdir()
    module = VF.load_compute()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    exc = caught.value

    assert not isinstance(exc, UnicodeDecodeError), (
        f"{label}: the reported defect, unfixed — a raw decode error instead of a refusal"
    )
    assert type(exc).__name__ == "VisiumImportError", f"{type(exc).__name__}: {exc}"
    assert dataset.split("matrix/")[-1] in str(exc), str(exc)
    assert "entry 0" in str(exc), str(exc)
    assert "IDENTITY" in str(exc), str(exc)
    assert _outputs_tree(out) == []


def test_TEST_19_the_identity_refusal_reaches_the_entrypoint_as_a_clean_exit(tmp_path):
    """TEST-19 [acceptance INV-1] — TEST-14 through `main()`, which is where it mattered.

    TEST-14's legs assert the exception TYPE, in process. This one asserts what a user actually
    receives from the shipped entrypoint: exit 2 and a message, not exit 1 and a stack trace.
    Its own ID rather than a shared one, because a spec file mapping several TEST-IDs onto one
    assertion is coverage inflation and this is a genuinely different assertion.
    """
    import h5py

    bundle = _copy(tmp_path, "identity-entry")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        values = handle["matrix/barcodes"][:]
        values[0] = b"\xff\xfeBAD"
        handle["matrix/barcodes"][:] = values

    outputs = tmp_path / "outputs"
    result = VF.run_entry(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert "UnicodeDecodeError" not in result.stderr, result.stderr[-3000:]
    assert "barcodes" in result.stderr
    assert _outputs_tree(outputs) == []


def test_TEST_15_legitimate_UTF8_vendor_text_reads_the_SAME_under_an_ASCII_LOCALE(tmp_path):
    """TEST-15 [acceptance INV-6] — the READ half of the locale rule, which was missing.

    The first version of this branch gave the three text WRITES an explicit `encoding="utf-8"`
    and left every vendor-document READ on the locale default. A blind angle measured what that
    costs on an ORDINARY bundle carrying legitimate UTF-8:

        scalefactors_json.json  "vendor_note": "spot pitch 100 µm"
            UTF-8 locale : exit 0, scalefactors round-trip, microns_per_pixel = 0.88298...
            ASCII locale : exit 0, scalefactors = {}, microns_per_pixel = null, and a
                           `scale_note` claiming the file "declares neither `microns_per_pixel`
                           nor `spot_diameter_fullres`" -- a FALSE statement about the vendor's
                           document, produced by the machine's locale
        metrics_summary.csv     "Sample ID": "Bulb-µm-01"
            UTF-8 locale : coordinates.zarr/zarr.json  section.sample_id = "Bulb-µm-01"
            ASCII locale : coordinates.zarr/zarr.json  section.sample_id = <the library id>
        tissue_positions.csv    a legitimate UTF-8 column
            UTF-8 locale : exit 0, 119 paths
            ASCII locale : exit 1, TRACEBACK, 51 paths

    i.e. the SAME bundle stamped two different identities into the coordinate store depending on
    `LC_ALL`, and silently reported a different scientific scale. That is §6.2's false-identity
    class produced by the environment rather than by an attacker.

    So this runs ONE bundle through the SHIPPED ENTRYPOINT TWICE — once in the inherited (UTF-8)
    environment and once in the ASCII one — and asserts the two runs agree. Drop any of the three
    `encoding="utf-8"` READ keywords and the two runs diverge.
    """
    import csv as _csv

    probe = subprocess.run(
        [sys.executable, "-c", "import locale; print(locale.getpreferredencoding(False))"],
        capture_output=True, text=True, env=dict(os.environ, **VF.ASCII_LOCALE_ENV), timeout=300,
    )
    assert probe.stdout.strip().lower() not in ("utf-8", "utf8"), probe.stdout

    bundle = _copy(tmp_path, "legit-utf8-reads")
    # (1) the scale document. `ensure_ascii=FALSE` is load-bearing and was WRONG in the first
    #     version of this test: at the default `ensure_ascii=True` the µ lands on disk as the
    #     ASCII escape `\u00b5`, so the file is PURE ASCII, decodes identically under any locale,
    #     and this leg proved nothing about `read_scalefactors`. MEASURED by a blind angle:
    #     dropping that one `encoding="utf-8"` keyword left the ENTIRE package suite green.
    _path = bundle / "spatial" / "scalefactors_json.json"
    doc = json.loads(_path.read_text())
    doc["vendor_note"] = "spot pitch 100 µm"
    _path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    assert any(b > 127 for b in _path.read_bytes()), (
        "the scale file must carry a real non-ASCII BYTE, or the ASCII-locale leg is vacuous"
    )
    # (2) the metrics table -- its `Sample ID` becomes the coordinate store's own identity
    metrics = bundle / "metrics_summary.csv"
    rows = list(_csv.reader(metrics.open(newline="")))
    rows[1][rows[0].index("Sample ID")] = "Bulb-µm-01"
    with metrics.open("w", newline="", encoding="utf-8") as fh:
        _csv.writer(fh).writerows(rows)
    # (3) the positions table -- an EXTRA column, so the barcode join is untouched and the only
    #     thing under test is whether the file decodes.
    positions = bundle / "spatial" / "tissue_positions.csv"
    prows = list(_csv.reader(positions.open(newline="")))
    prows[0].append("vendor_note_µm")
    for row in prows[1:]:
        row.append("Gewächs")
    with positions.open("w", newline="", encoding="utf-8") as fh:
        _csv.writer(fh).writerows(prows)

    seen = {}
    # And the other two files must really carry non-ASCII bytes too, for the same reason.
    assert any(b > 127 for b in metrics.read_bytes()), metrics
    assert any(b > 127 for b in positions.read_bytes()), positions

    for name, env in (("utf8", None), ("ascii", VF.ASCII_LOCALE_ENV)):
        outputs = tmp_path / f"outputs-{name}"
        result = VF.run_entry(bundle, outputs, env=env)
        assert "Traceback" not in result.stderr, (name, result.stderr[-3000:])
        assert result.returncode == 0, (name, result.returncode, result.stderr[-3000:])
        report = _report(outputs)
        stamped = json.loads(
            (outputs / "spatial" / "coordinates.zarr" / "zarr.json").read_text(encoding="utf-8")
        )["attributes"]["cyto"]["cyto_spatial"]
        seen[name] = {
            "vendor_note": report["scalefactors"].get("vendor_note"),
            "microns_per_pixel": report.get("microns_per_pixel"),
            "scale_note": report.get("scale_note"),
            "sample_id": stamped["section"]["sample_id"],
        }

    assert seen["utf8"] == seen["ascii"], (
        f"the same bundle read differently under two locales: {seen}"
    )
    assert seen["utf8"]["vendor_note"] == "spot pitch 100 µm", seen
    assert seen["utf8"]["sample_id"] == "Bulb-µm-01", seen
    assert seen["utf8"]["microns_per_pixel"] is not None, seen
    assert seen["utf8"]["scale_note"] is None, seen


@pytest.mark.parametrize("depth", [992, 20000])
def test_TEST_16_a_scale_file_too_DEEP_for_the_parser_degrades_rather_than_tracebacks(
        depth, tmp_path):
    """TEST-16 [acceptance INV-1] — the refusal-free traceback at the GUARDED door.

    `json.loads` raises `RecursionError` at nesting depth >= 992, on a file that is otherwise
    pure ASCII. `RecursionError` subclasses `RuntimeError`, NOT `ValueError`, so it walked
    straight past `read_scalefactors`' `except (OSError, ValueError)` and out through `main()`,
    which catches only `VisiumImportError`. MEASURED before FIX_ROUND-1: `rc=1`, a raw traceback
    with absolute source paths on stderr.

    A document too deep for the parser is UNPARSEABLE, which is exactly what the degrade-to-`{}`
    arm exists for (DEC-3), so it joins that arm rather than becoming a new refusal. The bundle
    still imports and declares no scale.

    Note this is at DOOR (b) and needs no unwritable character at all — the file below is pure
    ASCII and carries no surrogate.

    ## THE BOUNDARY, and what this does NOT close

    The first version of this test picked depth 20 000 and never touched the threshold, which a
    blind angle called out as hiding the interesting case. It is parametrized on the boundary
    now: **992** is the first depth `json.loads` refuses (in `run_import`'s own stack), and 20 000
    is the far case.

    Depth **991** — one BELOW the threshold — is still a raw traceback: the parse succeeds, the
    encodability walk succeeds (it survives to depth 994 for lists / 996 for dicts), and the
    import then dies in `render_report_html`'s own `json.dumps` with 115 paths on disk. That is
    NOT closed here and is not claimed to be: passing an encodability predicate is not evidence
    that a document is WRITABLE, the margin is two stack frames, and the fix is a depth cap at
    the parse boundary rather than a rescue at the writer. Filed as #338 and recorded in the
    design note §6.8 item 4.
    """
    bundle = _copy(tmp_path, f"deep-scale-{depth}")
    path = bundle / "spatial" / "scalefactors_json.json"
    path.write_text('{"x": ' + "[" * depth + "]" * depth + "}", encoding="ascii")
    assert all(b < 128 for b in path.read_bytes())

    outputs = tmp_path / f"outputs-{depth}"
    result = VF.run_entry(bundle, outputs)

    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    report = _report(outputs)
    assert report["scalefactors"] == {}
    assert "scale_note" in report


def test_TEST_17_the_walk_does_not_MATERIALISE_a_numeric_array_attribute():
    """TEST-17 [acceptance INV-5] — the denial of service THIS BRANCH introduced.

    A blind security angle measured it. `.tolist()` on a numeric ndarray attribute materialises
    every element as a Python object and the walk then recurses per element, building an f-string
    and a tuple each time. With ONE root attribute of `np.arange(100_000_000, dtype=np.int64)` in
    an h5 written with `libver="latest"` (dense attribute storage lifts HDF5's 64 KB
    object-header cap):

        dict(h5.attrs)   2.42 s                                  <- the cost origin/main pays
        THE WALK        44.20 s, maxrss 3162 MB -> 4739 MB       <- the cost this branch added

    In a memory-capped sandbox that is an OOM SIGKILL: no refusal, no message, no exit code this
    module chose — INV-5's "bounded" as a resource property rather than a message-length one.

    Asserted by OBSERVING WHETHER `.tolist()` IS CALLED, not by timing: a wall-clock assertion on
    a shared machine is a flake, and the property under test is not "it is fast", it is "the
    numeric arm is never entered". A `np.ndarray` subclass is the only way to see that from
    outside, since the call is `node.tolist()`.
    """
    module = VF.load_compute()

    class _Spy(np.ndarray):
        calls = 0

        def tolist(self):
            type(self).calls += 1
            return super().tolist()

    for dtype, expect_walked in ((np.int64, False), (np.float64, False), (np.bool_, False)):
        _Spy.calls = 0
        arr = np.zeros(8, dtype=dtype).view(_Spy)
        assert module.unencodable_vendor_text({"a": arr}) is None
        assert _Spy.calls == 0, f"{dtype} was materialised by the walk"

    # THE CONTROL. A text dtype must still be walked, or the short-circuit has eaten the guard.
    _Spy.calls = 0
    text = np.array([b"ok", b"\xff\xfeBAD"], dtype="|S8").view(_Spy)
    hit = module.unencodable_vendor_text({"a": text})
    assert _Spy.calls == 1, "a bytes-dtype array was NOT walked"
    assert hit is not None and hit[1] == b"\xff\xfeBAD", hit
    # And the `<U` and object dtypes h5py can also return.
    assert module.unencodable_vendor_text({"a": np.array(["ok", "\ud800BAD"], dtype="<U8")})
    assert module.unencodable_vendor_text({"a": np.array([b"\xff\xfeBAD"], dtype=object)})


def test_TEST_18_the_refusal_length_is_INDEPENDENT_of_the_offending_value_length():
    """TEST-18 [acceptance INV-5] — the bound, stated as the property rather than as a number.

    TEST-6's third leg asserts `len(message) < 2000` on an all-`A` value. A blind angle pointed
    out that this is not the true bound: `ascii()` expands one astral character to ten, so a
    120-unit window of astral characters yields a ~3.2 kB message and that assertion would be a
    false alarm rather than a real one — it happens to hold only because the value it uses is
    ASCII.

    A blind angle then measured the replacement's own astral leg and found the SAME kind of
    slack: the leg below constructs an astral VALUE with an ASCII path and measures **1,969**
    characters — under 2000, so TEST-6 would not have false-alarmed on it after all. The ~3.2 kB
    figure needs the PATH to be astral too (both windows expanded tenfold), which the sentence
    said ("twice (value + path)") and the code did not do. Both legs are built below now.

    The property that actually matters is that the message does not GROW WITH the vendor's
    input. It is not quite constant, and the difference is worth naming rather than asserting
    away: the message states the offending OFFSET and the value's TRUE LENGTH, so it grows by
    the DIGITS of those numbers — MEASURED, 898 characters for a 10 kB value and 907 for a 10 MB
    one, a 9-character difference for three extra decimal digits in each of three places. That
    is logarithmic in the vendor's input and is the honest bound; a strict-equality assertion
    here would be a false statement about the code that happened to be testable.
    """
    module = VF.load_compute()

    def message(value):
        with pytest.raises(Exception) as caught:
            module.refuse_unencodable_vendor_text(
                {"run": value}, source="`x`", remedy="re-export.")
        return str(caught.value)

    short = message("A" * 10_000 + _LONE_SURROGATE)
    long = message("A" * 10_000_000 + _LONE_SURROGATE)
    # A 1000x longer value buys the attacker only the extra DECIMAL DIGITS of the offsets.
    assert 0 <= len(long) - len(short) <= 32, (len(short), len(long))
    assert len(long) < 2000, len(long)

    # An astral VALUE under an ASCII path: one window expands tenfold. MEASURED at 1,969.
    astral_value = message("\U0001f9ec" * 10_000 + _LONE_SURROGATE)
    assert astral_value.isascii()
    assert 1500 < len(astral_value) < 2500, len(astral_value)

    # An astral VALUE under an astral PATH: BOTH windows expand, which is the ~3.2 kB shape the
    # docstring names and the first version of this test never built. MEASURED at 3,211.
    with pytest.raises(Exception) as caught:
        module.refuse_unencodable_vendor_text(
            {"\U0001f9ec" * 500: "\U0001f9ec" * 10_000 + _LONE_SURROGATE},
            source="`x`", remedy="re-export.")
    astral_both = str(caught.value)
    assert astral_both.isascii()
    assert 2500 < len(astral_both) < 4000, len(astral_both)
    # 120 units x 10 characters per `\U0001f9ec` escape, twice, plus the prose -- and BOUNDED:
    # the value is 10,000 astral characters and the key 500, and neither reaches the message.
    assert len(astral_both) < 5000, len(astral_both)
    # And a hostile PATH cannot grow it either.
    deep = message({"k" * 5_000_000: _LONE_SURROGATE})
    assert len(deep) < 5000, len(deep)


# ═════════════════ FIX_ROUND-2: what round 1's own fixes broke ══════════════════════


#: The two `V`-kind shapes h5py really round-trips, and the reason FIX_ROUND-1's first bound was
#: wrong. `V` is not only the HDF5 OPAQUE dtype: it is also the STRUCTURED/COMPOUND dtype, whose
#: FIELDS can be `S` or `U`. An allow-list of `"SUO"` skipped both.
_COMPOUND_ATTR_SHAPES = [
    ("compound-with-bytes-field", lambda: np.array(
        [(b"\xff\xfeSR", 1)], dtype=[("v", "S8"), ("n", "i4")])),
    ("compound-single-field", lambda: np.array(
        [(b"\xff\xfeSR",)], dtype=[("v", "S8")])),
]


@pytest.mark.parametrize("label,make", _COMPOUND_ATTR_SHAPES,
                         ids=[label for label, _ in _COMPOUND_ATTR_SHAPES])
def test_TEST_20_a_COMPOUND_dtype_root_attribute_is_walked_and_refused(label, make, tmp_path):
    """TEST-20 [acceptance INV-4] — the hole FIX_ROUND-1's own DoS bound opened.

    FIX_ROUND-1 stopped the walk materialising huge numeric attributes with an ALLOW-list,
    `dtype.kind not in "SUO"`, and a comment asserting that "`V` ... is raw binary that no reader
    of this module turns into text". Both halves were wrong, and a blind angle measured the
    consequence END TO END on the committed fixture:

        library_ids = np.array([(b"\\xff\\xfeSR",)], dtype=[("v", "S8")])   # h5py -> kind 'V'
          rc=0  paths=119  provenance.library_id = '\\ufffd\\ufffdSR'
                           coordinate_space      = 'visium:\\ufffd\\ufffdSR'
        b'\\xff\\xfeSR' / b'\\xfe\\xffSR' / b'\\x80\\x81SR'  ->  DISTINCT coordinate spaces: 1

    That is §6.2's false collision, verbatim, on the coordinate-frame identity — re-opened by a
    bound that was supposed to be free, and pinned by nothing (TEST-17 pinned the fix and not the
    hole). `vendor_provenance`'s `text()` is the reader that turns it into text: it walks
    `v.tolist()` and decodes each field with `errors="replace"`.

    The repair is to state the skip as what CANNOT carry text (`biufcMm`) rather than as what can,
    so an unknown or future dtype kind is WALKED. A guard's default has to be to look.

    Asserted on the IDENTITY attribute and end to end, because the in-process predicate check
    alone would not have shown that the value reaches `coordinate_space`.
    """
    import h5py

    bundle = _copy(tmp_path, f"compound-{label}")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("library_ids", make())
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r") as handle:
        got = handle.attrs["library_ids"]
        assert got.dtype.kind == "V", (got.dtype, got)

    out = tmp_path / f"out-compound-{label}"
    out.mkdir()
    module = VF.load_compute()
    with pytest.raises(Exception) as caught:
        module.run_import(bundle, out)
    exc = caught.value
    assert type(exc).__name__ == "VisiumImportError", f"{type(exc).__name__}: {exc}"
    assert "library_ids" in str(exc), str(exc)
    assert "�" not in str(exc), "the refusal must not itself substitute a character"
    assert _outputs_tree(out) == []


def test_TEST_25_a_VOID_SCALAR_attribute_is_walked_too(tmp_path):
    """TEST-25 [acceptance INV-3] — TEST-20's SCALAR twin: `np.void` is not an `ndarray`.

    Enumerated as **TEST-20b** when it was written and renumbered to TEST-25 so every id sits in
    the numeric namespace the A11 citation check greps. Both ids name THIS ONE assertion; there
    is no second test behind the old one.

    A compound or opaque SCALAR is `np.void`, which fails `isinstance(node, np.ndarray)` and so
    fell through the walk's final `return None` — invisible for the same reason the array shape
    was, by a different route. Driven against the predicate directly because h5py does not
    readily hand back a bare `np.void` scalar for a root attribute; the walk's whole claim is
    "whatever the vendor really produces", and a shape reachable only through a different h5
    writer is exactly the kind this module has been bitten by before.
    """
    module = VF.load_compute()
    scalar = np.array([(b"\xff\xfeSR",)], dtype=[("v", "S8")])[0]
    assert isinstance(scalar, np.void) and not isinstance(scalar, np.ndarray), type(scalar)
    hit = module.unencodable_vendor_text({"library_ids": scalar})
    assert hit is not None and hit[1] == b"\xff\xfeSR", hit


def test_TEST_21_an_ABSURDLY_LARGE_text_attribute_is_REFUSED_rather_than_walked(tmp_path):
    """TEST-21 [acceptance INV-5] — the half of the DoS the dtype check does not bound.

    FIX_ROUND-1's dtype check conflated "cannot carry text" with "is cheap". A blind angle
    measured the counter-example: `|S1` is kind `S`, passes every text check, and materialises one
    Python object per element.

        one root attribute of np.zeros(100_000_000, dtype="|S1")   (a 95 MB h5)
          dict(h5.attrs)   0.28 s, maxrss 323 MB    <- the cost origin/main already pays
          THE WALK        28.85 s, maxrss 894 MB    <- and it returns None

    Same order as the `int64` case the dtype check removes, and a WORSE amplification ratio. So
    the bound that actually holds is a SIZE bound, and a root attribute past it is refused BY NAME
    — a root attribute is metadata, and this importer reads three short strings from there.

    Asserted at a size that is over the cap but cheap to build, and paired with the CONTROL that
    an ordinary attribute is nowhere near it: on all three committed real fixtures the largest
    root attribute is 27 bytes, four orders of magnitude under the cap.
    """
    import h5py

    module = VF.load_compute()
    cap = module._MAX_WALKED_ATTRIBUTE_BYTES
    assert cap == 1 << 20, cap

    over = np.zeros(cap + 1, dtype="|S1")
    with pytest.raises(Exception) as caught:
        module.unencodable_vendor_text({"vendor_bulk": over})
    exc = caught.value
    assert type(exc).__name__ == "VisiumImportError", f"{type(exc).__name__}: {exc}"
    assert "vendor_bulk" in str(exc), str(exc)
    assert str(exc).isascii(), str(exc)

    # THE CONTROL, on both sides of the cap: an attribute AT the cap is still walked and still
    # finds the bad entry, so the bound cannot be standing in for the guard.
    under = np.array([b"ok"] * 8 + [b"\xff\xfeBAD"], dtype="|S8")
    assert under.nbytes <= cap
    hit = module.unencodable_vendor_text({"vendor_bulk": under})
    assert hit is not None and hit[1] == b"\xff\xfeBAD", hit

    # And every committed real bundle is nowhere near it.
    for root, _design, _um in VF.COMMITTED_BUNDLES:
        with h5py.File(Path(root) / "filtered_feature_bc_matrix.h5", "r") as handle:
            largest = max(getattr(v, "nbytes", len(str(v))) for v in handle.attrs.values())
        assert largest < cap // 1000, (root, largest)


def test_TEST_22_an_ABSENT_h5_identity_dataset_is_refused_BY_NAME(tmp_path):
    """TEST-22 [acceptance INV-1] — the `KeyError` `decoded_h5_strings` did not name.

    FIX_ROUND-1 added that function with the heading "Every way the read itself can fail", and a
    blind angle measured that it missed one: an h5 with no `/matrix/barcodes` still produced
    `rc=1` and a raw `KeyError: "Unable to synchronously open object"` traceback. The same INV-1
    violation the function was added to remove, inside the function that removed it.
    """
    import h5py

    bundle = _copy(tmp_path, "absent-barcodes")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        del handle["matrix/barcodes"]

    outputs = tmp_path / "outputs"
    result = VF.run_entry(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert "KeyError" not in result.stderr, result.stderr[-3000:]
    assert "barcodes" in result.stderr
    assert _outputs_tree(outputs) == []


def test_TEST_23_a_positions_refusal_now_leaves_NOTHING_ON_DISK(tmp_path):
    """TEST-23 [acceptance INV-2] — the refusal FIX_ROUND-1 added at the wrong place.

    That round gave `read_positions` a NAMED refusal for a positions table that is not valid
    UTF-8, and left the call where it was — 100-odd lines AFTER `write_csc_zarr`. MEASURED by a
    blind angle:

        positions with one 0xff byte, before FIX_ROUND-1 : rc=1  paths=51  Traceback=True
        positions with one 0xff byte, after  FIX_ROUND-1 : rc=2  paths=51  Traceback=False

    The message improved and the 51 paths did not — which made the design's own INV-2 scope note
    ("OTHER, correctly-named refusals still fire after the first writer") false about a refusal
    this design had just added. The honest repair is to move the read, which is what DEC-4 already
    did for `read_scalefactors` and for the same reason.
    """
    bundle = _copy(tmp_path, "positions-not-utf8")
    path = bundle / "spatial" / "tissue_positions.csv"
    raw = bytearray(path.read_bytes())
    raw[len(raw) // 2] = 0xFF
    path.write_bytes(bytes(raw))

    outputs = tmp_path / "outputs"
    result = VF.run_entry(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert "tissue_positions.csv" in result.stderr
    assert _outputs_tree(outputs) == [], (
        "a NAMED refusal this design adds must still leave nothing behind"
    )


def test_TEST_24_a_HEADERLESS_positions_file_with_a_BOM_still_imports(tmp_path):
    """TEST-24 [acceptance INV-6] — the BOM the old comment claimed was already handled.

    FIX_ROUND-1's comment argued AGAINST `utf-8-sig` on the grounds that "the header check below
    already strips a BOM, and it must keep doing so for the HEADERLESS spelling too". A blind
    angle measured that backwards: the header check `lstrip`s the BOM off a TEMPORARY list that
    the headerless branch DISCARDS, and `.strip()` does not remove `U+FEFF` (it is `Cf`, not
    whitespace), so the BOM survived into the barcode and broke the matrix join:

        HEADERED   + BOM ->  barcode 'AAA-1'        rc=0, 119 paths
        HEADERLESS + BOM ->  barcode '\\ufeffAAA-1'   rc=2, 51 paths

    `utf-8-sig` — the option the comment rejected — is exactly what fixes the headerless case, and
    is what `spatial-import-xenium`'s `read_cells_csv` already uses for this reason.
    """
    import csv as _csv

    bundle = _copy(tmp_path, "headerless-bom")
    src = bundle / "spatial" / "tissue_positions.csv"
    rows = list(_csv.reader(src.open(newline="")))
    dest = bundle / "spatial" / "tissue_positions_list.csv"
    with dest.open("w", newline="", encoding="utf-8") as fh:
        _csv.writer(fh).writerows(rows[1:])          # HEADERLESS, the <= 1.x spelling
    dest.write_bytes(b"\xef\xbb\xbf" + dest.read_bytes())   # ... with a BOM
    src.unlink()
    assert dest.read_bytes()[:3] == b"\xef\xbb\xbf"

    outputs = tmp_path / "outputs"
    result = VF.run_entry(bundle, outputs)
    assert "Traceback" not in result.stderr, result.stderr[-3000:]
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    report = _report(outputs)
    assert report["n_spots"] > 0, report
