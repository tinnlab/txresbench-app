#!/usr/bin/env python3
# ruff: noqa
"""The bundle is UNTRUSTED INPUT, and these are the three ways it got to lie.

Every assertion here pins a defect a blind error-handling round REPRODUCED against the real
fixtures. They are grouped because they share one shape: `experiment.xenium` and
`cells.csv.gz` are vendor-authored files that this importer reads, and reading them was
treated as reading our own data.

Damage is always done to a COPY. The committed fixtures are never modified.
"""
import gzip
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import txr_zarr_read as CZR  # noqa: E402


def _copy(tmp_path, name, src=None):
    dest = tmp_path / name
    shutil.copytree(src or XF.PRIME, dest)
    return dest


def _set_experiment(bundle, **fields):
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text())
    doc.update(fields)
    path.write_text(json.dumps(doc))


def _rewrite_cells(bundle, header, rows):
    with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
        fh.write(",".join(header) + "\n")
        for row in rows:
            fh.write(",".join(row) + "\n")


def _report(out):
    return json.loads((Path(out) / "xenium-import-report.json").read_text())


# ── TEST-26: the vendor file steers a filesystem read ────────────────────────────────


@pytest.mark.parametrize("escape", [
    "../outside/foreign.ome.tif",
    "../../outside/foreign.ome.tif",
    "morphology_focus/../../outside/foreign.ome.tif",
])
def test_an_image_path_that_escapes_the_bundle_is_REFUSED(escape, tmp_path):
    """TEST-26 — `experiment.xenium` names its own images, and it is untrusted.

    Reproduced by a blind audit before this guard existed: pointing
    `morphology_focus_filepath` two levels above the bundle made this importer open,
    decode, DOWNSAMPLE and EMIT a foreign image as the dataset's own `spatial/image` — with
    `meta.source` and `display_derivative.original_source` recording the escaping path and
    the report warning claiming it was "preserved in the uploaded bundle".

    A REAL image is planted outside, so the refusal cannot be passing for the trivial reason
    that the path does not resolve to anything.
    """
    bundle = _copy(tmp_path, "escape")
    outside = tmp_path / "outside"
    outside.mkdir()
    shutil.copy(XF.PRIME / "morphology_focus" / "morphology_focus_0000.ome.tif",
                outside / "foreign.ome.tif")
    assert (outside / "foreign.ome.tif").is_file(), "the planted file must be real"

    _set_experiment(bundle, images={"morphology_focus_filepath": escape})
    out = tmp_path / f"out-{abs(hash(escape))}"
    _, entries = XF.run_over(bundle, out)

    assert not [e for e in entries if e["datatype"] == "spatial/image"], (
        f"an image OUTSIDE the bundle was emitted through {escape!r}"
    )
    reasons = " ".join(_report(out)["images_not_emitted"])
    assert "OUTSIDE this bundle" in reasons
    # And the import is otherwise unharmed — a hostile path costs the image, not the data.
    assert [e for e in entries if e["datatype"] == "spatial/coordinates"]


def test_an_ABSOLUTE_image_path_is_refused(tmp_path):
    """TEST-26 — the escape that needs no `..` at all.

    `Path(root) / "/etc/passwd"` is `/etc/passwd`: pathlib DISCARDS the left operand when
    the right is absolute. So an absolute path is not a harder case than `..`, it is an
    easier one, and it was equally unguarded. The audit also observed the refusal message
    echoing the decoder's error — which embeds the target's leading bytes — making it a
    probing oracle; the refusal below never reaches a decoder at all.
    """
    bundle = _copy(tmp_path, "absolute")
    planted = tmp_path / "absolute-target.ome.tif"
    shutil.copy(XF.PRIME / "morphology_focus" / "morphology_focus_0000.ome.tif", planted)

    _set_experiment(bundle, images={"morphology_focus_filepath": str(planted)})
    out = tmp_path / "out-absolute"
    _, entries = XF.run_over(bundle, out)

    assert not [e for e in entries if e["datatype"] == "spatial/image"]
    reasons = " ".join(_report(out)["images_not_emitted"])
    assert "OUTSIDE this bundle" in reasons
    assert "absolute-target" not in "".join(
        json.dumps(e["meta"]) for e in entries if e["meta"]
    ), "no artifact may record a path outside the bundle"


def test_the_containment_check_still_ADMITS_every_legitimate_path(tmp_path):
    """TEST-26 — THE CONTROL. A guard that refuses everything is not a guard.

    Both real bundles import their images through this check on every other test in the
    package, and the two legitimate shapes are asserted directly here: a nested path and a
    `./`-prefixed one.
    """
    module = XF.load_compute()
    root = XF.PRIME
    assert module.within_bundle(root, "morphology_focus/morphology_focus_0000.ome.tif")
    assert module.within_bundle(root, "./morphology.ome.tif")
    assert module.within_bundle(root, "morphology_focus/../morphology.ome.tif"), (
        "a `..` that stays INSIDE the bundle is legitimate and must be admitted — the rule "
        "is containment, not a syntactic ban on the characters"
    )
    assert module.within_bundle(root, "../outside.tif") is None
    assert module.within_bundle(root, "/etc/passwd") is None


# ── TEST-27: a duplicate header silently emitted the wrong column ────────────────────


def test_a_duplicate_header_name_REFUSES_rather_than_picking(tmp_path):
    """TEST-27 — the data-loss defect, reproduced then closed.

    A blind audit renamed `cell_area` to `x_centroid` — a plausible spreadsheet round trip —
    and this importer reported a FULLY SUCCESSFUL import whose `spatial_x` was the cell AREA
    for every cell, with the real centroid discarded, the `cell_area` column silently gone
    and no note anywhere. `{name: i for ...}` is last-occurrence-wins.

    Every other duplicate-versus-guess case in this importer refuses; this one picked.
    """
    bundle = _copy(tmp_path, "dup-header")
    header, rows = XF.cells_table(XF.PRIME)
    clashed = [("x_centroid" if name == "cell_area" else name) for name in header]
    _rewrite_cells(bundle, clashed, rows)

    module = XF.load_compute()
    with pytest.raises(module.XeniumImportError) as exc:
        module.run_import(bundle, tmp_path / "out-dup")
    assert "repeats" in str(exc.value) and "x_centroid" in str(exc.value)


def test_a_duplicate_the_importer_does_NOT_read_is_not_refused(tmp_path):
    """TEST-27 — THE CONTROL, and it is what stops this becoming a nuisance.

    The rule is about columns whose value this importer USES. A vendor repeating a column
    nobody here reads is not ambiguity that can reach an artifact, and refusing it would be
    a guard that fires on files it has no stake in.
    """
    bundle = _copy(tmp_path, "dup-unread")
    header, rows = XF.cells_table(XF.PRIME)
    extended = header + ["nucleus_count_2", "nucleus_count_2"]
    _rewrite_cells(bundle, extended, [row + ["1", "1"] for row in rows])

    out = tmp_path / "out-dup-unread"
    _, entries = XF.run_over(bundle, out)
    assert [e for e in entries if e["datatype"] == "spatial/coordinates"]


# ── TEST-28: NaN and Infinity are not positions ──────────────────────────────────────


@pytest.mark.parametrize("value", ["nan", "NaN", "Infinity", "-Infinity", "1e300"])
def test_a_non_finite_centroid_REFUSES(value, tmp_path):
    """TEST-28 — `float()` parses all of these, and they all imported clean.

    The only symptom anywhere was a coverage note reading "the cells extend to nan x 392.2
    um" — which blames the IMAGE and sends the user to the registration overlay for a defect
    in the cells table. `1e300` is in the list because it is FINITE as a float64 and
    overflows float32 to `inf` at the cast, which is the same defect one conversion later.
    """
    bundle = _copy(tmp_path, f"nonfinite-{abs(hash(value))}")
    header, rows = XF.cells_table(XF.PRIME)
    ix = header.index("x_centroid")
    damaged = [list(row) for row in rows]
    damaged[3][ix] = value
    _rewrite_cells(bundle, header, damaged)

    module = XF.load_compute()
    with pytest.raises(module.XeniumImportError) as exc:
        module.run_import(bundle, tmp_path / f"out-{abs(hash(value))}")
    message = str(exc.value)
    assert "non-finite" in message
    assert "x_centroid" in message
    assert "matrix row" in message, "the refusal must locate the offending cell"


def test_the_real_bundles_have_no_non_finite_positions(tmp_path):
    """TEST-28 — THE CONTROL. The guard must not be refusing real data.

    Asserted against the artifacts rather than the inputs, so it also covers the float32
    cast the importer performs.
    """
    for bundle in (XF.PRIME, XF.PROTEIN):
        out = tmp_path / f"finite-{bundle.name}"
        XF.run_over(bundle, out)
        arr = CZR.read_array(out / "spatial/coordinates.zarr", "coordinates")
        assert np.all(np.isfinite(arr))


# ── the matrix reads that had no refusal of their own ────────────────────────────────


def test_a_damaged_matrix_file_gets_a_NAMED_refusal_not_a_traceback(tmp_path):
    """TEST-29 — the most ordinary upload damage there is.

    `h5py.File` was called unguarded, so a truncated `.h5` exited 1 with a traceback about
    `stored_eof` and no hint what to do — while the two sibling read paths in the same file
    both wrap their open in a named refusal.
    """
    module = XF.load_compute()
    for name, payload in (
        ("truncated", (XF.PRIME / "cell_feature_matrix.h5").read_bytes()[:4096]),
        ("empty", b""),
        ("not-hdf5", b"this is not an HDF5 file" * 100),
    ):
        bundle = _copy(tmp_path, f"h5-{name}")
        (bundle / "cell_feature_matrix.h5").write_bytes(payload)
        with pytest.raises(module.XeniumImportError) as exc:
            module.run_import(bundle, tmp_path / f"out-h5-{name}")
        assert "could not be opened as an HDF5 file" in str(exc.value)


def test_a_matrix_missing_a_member_names_WHICH_member(tmp_path):
    """TEST-29 — the five datasets read after the `/matrix` guard had no guard of their own.

    Deleting any one produced a bare `KeyError: "Unable to synchronously open object ..."`.
    """
    import h5py

    module = XF.load_compute()
    for member in ("shape", "barcodes", "features/name"):
        bundle = _copy(tmp_path, f"h5-missing-{member.replace('/', '-')}")
        with h5py.File(bundle / "cell_feature_matrix.h5", "a") as f:
            del f[f"matrix/{member}"]
        with pytest.raises(module.XeniumImportError) as exc:
            module.run_import(bundle, tmp_path / f"out-missing-{member.replace('/', '-')}")
        assert "is missing" in str(exc.value) and member in str(exc.value)


# ── #323 / TEST-17: the matrix's own barcodes are untrusted bytes ────────────────────

def test_barcodes_that_are_not_valid_utf8_are_REFUSED_BY_NAME(tmp_path):
    """TEST-17 (#323) — a crash-instead-of-refusal a blind security angle reached from an upload.

    `/matrix/barcodes` is vendor-written bytes and this importer decoded it STRICTLY with no guard,
    so an h5 carrying one invalid byte exited `main()` with a `UnicodeDecodeError` TRACEBACK — the
    exact shape this file exists for, on the one vendor file it had not been applied to.

    The decode stays STRICT and that is the point: a barcode is the key `cells.csv.gz` is joined
    on, so `errors="replace"` would silently mangle it and pair a cell's transcripts with another
    cell's position — a picture of the tissue with the values shuffled, which is worse than a
    refusal. What changed is only the failure MODE.

    The CONTROL is the shipped bundle itself, which imports unchanged: a guard that refused every
    bundle would satisfy the first assertion and be useless.
    """
    import h5py

    bundle = _copy(tmp_path, "bad-barcodes")
    with h5py.File(bundle / "cell_feature_matrix.h5", "a") as handle:
        group = handle["matrix"]
        old = [bytes(b) for b in group["barcodes"][:]]
        del group["barcodes"]
        group.create_dataset(
            "barcodes",
            data=np.array([b"\xff\xfe" + o for o in old], dtype="S"),
        )

    module = XF.load_compute()
    with pytest.raises(module.XeniumImportError) as excinfo:
        module.run_import(bundle, tmp_path / "bad-out")
    message = str(excinfo.value)
    assert "not valid UTF-8" in message, message
    assert "join" in message, (
        "the refusal must say WHY a loose decode is not an option — a cell id is the key the "
        f"cells table is joined on: {message}")
    # THE DATASET AND THE ROW, which is what this file's own convention asks of a per-row refusal
    # ("`cells.csv.gz` line N"; "first at matrix row {first}, cell {id!r}"). A blind angle showed
    # both were unpinned: the index could be replaced by a constant and the label by the wrong
    # path with the whole package green. "position 0" in a codec's message is a byte offset inside
    # ONE value, which is not a row an operator can go and look at.
    assert "/matrix/barcodes" in message, message
    assert "entry 0" in message, (
        f"the refusal must name WHICH entry, not just that one of them is bad: {message}")

    # THE CONTROL: the same code path on the untouched vendor bundle still imports.
    _module, entries = XF.run_over(_copy(tmp_path, "clean-barcodes"), tmp_path / "clean-out")
    assert XF.entry(entries, "spatial-coordinates")["meta"]["coordinate_space"].startswith("xenium:")


def test_a_matrix_with_no_cell_identity_at_all_is_REFUSED_rather_than_given_a_frame(tmp_path):
    """TEST-19 (#323) — the derived rung's own refusal, driven through `run_import`.

    Every other assertion about `unverified_space_id`'s two refusals calls the helper directly, so
    nothing pinned the claim its docstring makes about REACHABILITY — and that claim had already
    been wrong once (an earlier version said the whole leg was defensive). A blind angle drove it
    and found the ordinary all-blank shape refused EARLIER, by the duplicate-cell-id guard; what
    reaches the derived rung is the asymmetric shape below.

    Both refusals are correct and the ORDER is correct — the more specific message wins — so this
    asserts the pair rather than one of them: whichever guard answers, the bundle is REFUSED BY
    NAME and never given a frame derived from nothing, which is the design's actual claim.
    """
    import gzip, csv
    import h5py

    module = XF.load_compute()

    def _blank_barcodes(bundle, cells_rows):
        with h5py.File(bundle / "cell_feature_matrix.h5", "a") as handle:
            group = handle["matrix"]
            n = len(group["barcodes"][:])
            del group["barcodes"]
            group.create_dataset("barcodes", data=np.array([b""] * n, dtype="S1"))
        with gzip.open(bundle / "cells.csv.gz", "rt", newline="") as fh:
            rows = list(csv.reader(fh))
        index = [c.strip() for c in rows[0]].index("cell_id")
        kept = rows[1:1 + cells_rows]
        for row in kept:
            row[index] = ""
        with gzip.open(bundle / "cells.csv.gz", "wt", newline="") as fh:
            csv.writer(fh).writerows([rows[0]] + kept)
        return bundle

    # The ORDINARY shape: N blank barcodes against N blank cells rows. The duplicate-id guard is
    # the one that answers, and it is the better message.
    ordinary = _blank_barcodes(_copy(tmp_path, "blank-all"), 23)
    _set_experiment(ordinary, roi_uuid="", slide_id="", region_name="")
    with pytest.raises(module.XeniumImportError) as ordinary_exc:
        module.run_import(ordinary, tmp_path / "blank-all-out")
    assert "more than once" in str(ordinary_exc.value), str(ordinary_exc.value)

    # The ASYMMETRIC shape, which is what actually reaches the derived rung — and the frame keys
    # have to go too, or rung 1 answers from the fixture's own `roi_uuid` and the derived rung is
    # never consulted. That is itself the design's claim working: the refusal is about deriving an
    # identity from NOTHING, so a bundle that states one is unaffected by it.
    asymmetric = _blank_barcodes(_copy(tmp_path, "blank-one"), 1)
    _set_experiment(asymmetric, roi_uuid="", slide_id="", region_name="")
    with pytest.raises(module.XeniumImportError) as asymmetric_exc:
        module.run_import(asymmetric, tmp_path / "blank-one-out")
    message = str(asymmetric_exc.value)
    assert "no cell identity" in message, message
    assert "coordinate_space_source" in message, (
        "the refusal must point the operator at the field that says WHICH of the two cases they "
        f"are in — a placeholder they can replace, or nothing to replace: {message}")

    # THE CONTROL, and it is the design's claim rather than a formality: the SAME broken matrix
    # imports when the vendor states a frame identity, because this refusal is about deriving one
    # from nothing.
    stated = _blank_barcodes(_copy(tmp_path, "blank-stated"), 1)
    _set_experiment(stated, roi_uuid="d4c2d423-83ed-4e44-8dfd-a0072bcc3afc")
    _module, entries = XF.run_over(stated, tmp_path / "blank-stated-out")
    assert XF.entry(entries, "spatial-coordinates")["meta"]["coordinate_space"] == \
        "xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc"


def test_every_untrusted_h5_string_dataset_is_refused_by_name_not_just_the_barcodes(tmp_path):
    """TEST-20 (#323) — FOUR call sites, four refusals; a guard on one of four is a guard on none.

    The first version of this guard wrapped `/matrix/barcodes` alone, with a comment claiming "the
    one place the bytes are read". A blind error-handling angle found the other three
    (`/matrix/features/{id,name,feature_type}`) still bare, and a blind tests-quality angle then
    showed the FIX was untested: the three feature call sites could be reverted to the pre-branch
    bare comprehensions with the whole package green, while the compute docstring, the design note
    and the manifest changelog all claimed four.

    Each dataset is corrupted on its own copy of the bundle, so a guard that answered for the wrong
    one would show up as the wrong dataset name in the message.
    """
    import h5py

    module = XF.load_compute()
    for path in ("barcodes", "features/id", "features/name", "features/feature_type"):
        bundle = _copy(tmp_path, f"bad-{path.replace('/', '-')}")
        with h5py.File(bundle / "cell_feature_matrix.h5", "a") as handle:
            group = handle["matrix"]
            parent, _, leaf = path.rpartition("/")
            node = group[parent] if parent else group
            old = [bytes(b) for b in node[leaf][:]]
            del node[leaf]
            node.create_dataset(
                leaf, data=np.array([old[0]] + [b"\xff\xfe" + o for o in old[1:]], dtype="S"))

        with pytest.raises(module.XeniumImportError) as excinfo:
            module.run_import(bundle, tmp_path / f"out-{path.replace('/', '-')}")
        message = str(excinfo.value)
        assert "not valid UTF-8" in message, (path, message)
        assert f"/matrix/{path}" in message, (
            f"the refusal names the wrong dataset — a reader cannot find the bad value: {message}")
        assert "entry 1" in message, (
            f"the corrupted entry is index 1 (entry 0 is left intact on purpose): {message}")


def test_an_h5_string_dataset_that_is_not_a_list_of_values_is_refused_by_name(tmp_path):
    """TEST-21 (#323) — the two failure modes the up-front presence sweep lets through.

    `"barcodes" in group` is true for a rank-0 (scalar) dataset AND for a GROUP of that name, so
    neither is caught by the `absent` check — and the `[:]` read then raises `ValueError` and
    `TypeError` respectively, out of `main()`, which catches only `XeniumImportError`. A blind
    angle found both, and a second found the fix for them unpinned.
    """
    import h5py

    module = XF.load_compute()

    scalar = _copy(tmp_path, "scalar-barcodes")
    with h5py.File(scalar / "cell_feature_matrix.h5", "a") as handle:
        del handle["matrix"]["barcodes"]
        handle["matrix"].create_dataset("barcodes", data=np.bytes_(b"only"))
    with pytest.raises(module.XeniumImportError) as excinfo:
        module.run_import(scalar, tmp_path / "scalar-out")
    assert "cannot be read as a list of values" in str(excinfo.value), str(excinfo.value)
    assert "/matrix/barcodes" in str(excinfo.value), str(excinfo.value)

    grouped = _copy(tmp_path, "group-barcodes")
    with h5py.File(grouped / "cell_feature_matrix.h5", "a") as handle:
        del handle["matrix"]["barcodes"]
        handle["matrix"].create_group("barcodes")
    with pytest.raises(module.XeniumImportError) as excinfo:
        module.run_import(grouped, tmp_path / "group-out")
    assert "cannot be read as a list of values" in str(excinfo.value), str(excinfo.value)


def test_a_non_bytes_barcode_dataset_is_decoded_by_the_arm_that_exists_for_it(tmp_path):
    """TEST-22 (#323) — the non-`bytes` arm of the decode helper, REACHED for real this time.

    The first version of this test staged a variable-length UTF-8 dataset on the theory that h5py
    hands those back as `str`. A blind angle measured that premise and it is FALSE on the installed
    h5py: `Dataset[:]` yields `bytes` for an `S`-typed AND for a vlen-utf8 dataset, so the test
    covered nothing and the arm stayed dead — the round that added it claimed a coverage it did not
    buy. That is worth more than the arm: a test written from a belief about a library, not from a
    measurement of it, is the same false-pass family as a hollow assertion.

    An INT-typed dataset is what actually reaches the arm (`Dataset[:]` yields `numpy.int64`), so
    that is what this stages — with `cells.csv.gz`'s ids rewritten to the same decimal strings, so
    the join still succeeds and the assertion is about the DECODE rather than about the join.
    """
    import h5py

    module = XF.load_compute()
    bundle = _copy(tmp_path, "int-barcodes")
    with h5py.File(bundle / "cell_feature_matrix.h5", "a") as handle:
        group = handle["matrix"]
        count = len(group["barcodes"][:])
        del group["barcodes"]
        group.create_dataset("barcodes", data=np.arange(count, dtype=np.int64))
    ordinals = iter([str(i) for i in range(count)])
    XF._rewrite_cells_column(bundle, "cell_id", lambda _v: next(ordinals))

    _module, entries = XF.run_over(bundle, tmp_path / "int-out")
    coords = XF.entry(entries, "spatial-coordinates")["meta"]
    assert coords["n"] == count, coords
    # The decode is what makes the join possible at all — an undecoded `numpy.int64` would not
    # match `cells.csv.gz`'s `"0"`, and the import would refuse. Reaching a successful import over
    # an int-typed barcode dataset IS the arm running.
    assert coords["coordinate_space"].startswith("xenium:"), coords


# ── #329: vendor text this importer cannot write ─────────────────────────────────────
#
# `experiment.xenium` is attacker-controlled JSON and `json.loads` ACCEPTS a `"\ud800"` escape
# out of a PURE-ASCII file. The resulting `str` reaches
# `spatial_declarations.mirror_declarations_into_store`'s `write_text(..., encoding="utf-8")` and
# raised `UnicodeEncodeError` — which `main()` does not catch — AFTER the coordinate store was on
# disk. These assertions pin the refusal, the empty outputs tree, the neighbouring fields, and the
# control that stops the guard from becoming "refuse all non-ASCII".
#
# Every one of them stages a COPY of the real prime bundle and drives the SHIPPED `run_import`.

#: The lone high surrogate #329 reports, written into the vendor file as a pure-ASCII escape.
_LONE_SURROGATE = "\ud800"


def _poison_experiment(bundle, **fields):
    """Rewrite `experiment.xenium` with `fields` and assert the FILE ITSELF stays pure ASCII.

    The assertion is the point of the helper. The defect is not "a bundle with weird bytes in it"
    — such a file would fail the read with a `UnicodeDecodeError` that `read_experiment` already
    converts into a named refusal. It is a file every byte of which is ASCII, carrying a `\\udXXX`
    escape that `json.loads` turns into a character no encoder can write.
    """
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text())
    doc.update(fields)
    path.write_text(json.dumps(doc, ensure_ascii=True), encoding="ascii")
    raw = path.read_bytes()
    assert all(b < 128 for b in raw), "the staged vendor file must itself be pure ASCII"
    assert b"\\ud8" in raw or b"\\udf" in raw or b"\\udc" in raw, raw[:200]
    return path


def _flatten(value):
    """Every scalar inside `value`, at every depth — a 2-D `|S` attribute is a list OF LISTS.

    A one-level flatten was the first version, and a blind angle pointed out it would make TEST-7's
    own premise assertion fail spuriously on a 2-D attribute: `_is_unwritable(a_list)` is falsy, so
    the premise would read "this input is fine" about an input that is not. Latent rather than live
    (the parametrisations are all <=1-D), and one function to close.
    """
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(_flatten(item))
        return out
    return [value]


def _is_unwritable(value):
    """True when this exact object is one this importer could not write — the tests' own premise.

    Deliberately NOT the module's predicate: a test that asked the guard whether its own input was
    bad would be asking the thing under test to grade its own paper.
    """
    if isinstance(value, bytes):
        try:
            value.decode("utf-8")
        except UnicodeDecodeError:
            return True
        return False
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            return True
    return False


#: The environment that really does give a CPython 3.10 subprocess a non-UTF-8 preferred encoding
#: on this host: `PYTHONUTF8=0` turns PEP 540 off, `PYTHONCOERCECLOCALE=0` turns PEP 538's C->C.UTF-8
#: coercion off, and `LC_ALL=C`/`LANG=C` then yield `ANSI_X3.4-1968`. All four are needed; drop any
#: one and the subprocess is back in UTF-8 and the test proves nothing — which is why every script
#: run through [`_run_under_ascii_locale`] ASSERTS the encoding it got before doing anything else.
_ASCII_LOCALE_ENV = {"PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C", "LANG": "C"}

#: The preamble that turns "the env was applied" from an assumption into a failure.
_ASSERT_NOT_UTF8 = (
    "import locale, sys\n"
    "assert locale.getpreferredencoding(False).lower() not in ('utf-8', 'utf8'), (\n"
    "    'this subprocess must NOT be in a UTF-8 locale, or it proves nothing: '\n"
    "    + locale.getpreferredencoding(False))\n"
)


def _run_under_ascii_locale(script, *args, cwd, extra_env=None):
    """Run `script` in a subprocess whose preferred encoding is NOT UTF-8.

    Factored out because TEST-13 and TEST-14 were rebuilding the same env dict, the same preamble
    and the same `sys.path` insert — the duplication this file's other helpers (`_copy`,
    `_set_experiment`, `_report`, `_outputs_tree`) exist to avoid.

    `timeout=` is passed, matching `test_boundaries_env_pin.py`'s subprocess convention: a hung
    child should fail the suite, not hang it.
    """
    import os
    import subprocess

    env = dict(os.environ, **_ASCII_LOCALE_ENV)
    env["PYTHONPATH"] = f"{XF.PKG / 'compute'}:{XF.PKG.parent / '_lib'}"
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-c", _ASSERT_NOT_UTF8 + script, *[str(a) for a in args]],
        capture_output=True, env=env, cwd=str(cwd), timeout=1800,
    )


def _outputs_tree(out):
    """Every path under `out`, relative — the FILESYSTEM answer to 'what survived?'."""
    out = Path(out)
    if not out.exists():
        return []
    return sorted(p.relative_to(out).as_posix() for p in out.rglob("*"))


def test_TEST_1_a_lone_surrogate_in_roi_uuid_is_a_NAMED_REFUSAL_not_a_traceback(tmp_path):
    """TEST-1 [acceptance INV-1] — #329's exact reported repro, measured before and after.

    MEASURED on `origin/main` @ `a2a6f728` over this exact input:

        *** UNCAUGHT UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800'
            in position 978: surrogates not allowed
          import_xenium.py         run_import
          spatial_declarations.py  write_spatial_coordinates
          spatial_declarations.py  mirror_declarations_into_store -> node.write_text(...)

    `main()` catches only `XeniumImportError`, so that was a traceback and exit 1. The assertion
    below is on the exception TYPE, which is what decides whether the user gets a refusal or a
    stack trace — and it names `UnicodeEncodeError` explicitly so a future body that merely moves
    the crash cannot pass.
    """
    bundle = _copy(tmp_path, "surrogate-roi-uuid")
    _poison_experiment(bundle, roi_uuid=_LONE_SURROGATE + "BAD")
    out = tmp_path / "out-roi-uuid"

    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)

    exc = caught.value
    assert not isinstance(exc, UnicodeEncodeError), (
        "the reported defect, unfixed: the writer aborted instead of the reader refusing"
    )
    assert type(exc).__name__ == "XeniumImportError", type(exc).__name__
    assert "roi_uuid" in str(exc), str(exc)
    assert "experiment.xenium" in str(exc), str(exc)


def test_TEST_2_a_refused_bundle_leaves_NO_partial_store_on_disk(tmp_path):
    """TEST-2 [acceptance INV-2] — asked of the FILESYSTEM, not of the exception type.

    This is the half of #329 that makes it worse than a crash. MEASURED on `origin/main` over the
    same input: the run died with `spatial/coordinates.zarr` already written (6 members:
    `zarr.json`, `coordinates/zarr.json`, `coordinates/c/0/0`, ...), alongside `expression.zarr`,
    `cell_id.zarr` and the column stores, and with NO `manifest.json` — the same shape #301
    recorded for `ENOSPC`.

    So the assertion walks the tree rather than trusting that a refusal implies an absence.
    """
    bundle = _copy(tmp_path, "surrogate-no-partial")
    _poison_experiment(bundle, roi_uuid=_LONE_SURROGATE + "BAD")
    out = tmp_path / "out-no-partial"
    out.mkdir()

    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)
    assert type(caught.value).__name__ == "XeniumImportError"

    survivors = _outputs_tree(out)
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"
    assert not (out / "spatial" / "coordinates.zarr").exists()
    assert list(out.rglob("zarr.json")) == []
    assert not (out / "xenium-import-report.json").exists()
    assert not (out / "manifest.json").exists()


#: Every neighbouring input the SAME parse feeds. `roi_uuid` is #329's headline; these are the
#: fields a fix sized to the report would have left open. Measured on `origin/main`, ONE FIELD AT A
#: TIME (a batch measurement got this wrong and both blind angles caught it), each of these lands in
#: exactly one of three states, and the marks below say which:
#:   (crash)  an uncaught `UnicodeEncodeError` with a half-written store;
#:   (poison) the import COMPLETES and ships the surrogate into `xenium-import-report.json` and
#:            `xenium-import-summary.html` as a `\ud800` escape, which `serde_json` — the crate the
#:            server parses that file with — refuses ("unexpected end of hex escape");
#:   (clean)  the import completes and NOTHING under `/outputs` carries the escape: nothing reads
#:            that field onto an artifact. These were harmless before and are refused now, which is
#:            the disclosed cost of guarding at the boundary (design note §1.2b).
#: `panel_name` is both — it crashes AND leaves a poisoned report.
_NEIGHBOURING_FIELDS = [
    ("slide_id", {"slide_id": _LONE_SURROGATE + "SLIDE"}),  # (poison)
    ("region_name", {"region_name": _LONE_SURROGATE + "REGION"}),  # (crash)
    ("run_name", {"run_name": _LONE_SURROGATE + "RUN"}),  # (poison)
    ("analysis_sw_version", {"analysis_sw_version": _LONE_SURROGATE + "3.0.0.15"}),  # (crash)
    ("panel_name", {"panel_name": _LONE_SURROGATE + "Panel"}),  # (crash AND poison)
    ("experiment_uuid", {"experiment_uuid": _LONE_SURROGATE + "EU"}),  # (poison)
    ("analysis_uuid", {"analysis_uuid": _LONE_SURROGATE + "AU"}),  # (poison)
    ("instrument_sn", {"instrument_sn": _LONE_SURROGATE + "SN"}),  # (poison)
    ("segmentation_method", {"segmentation_method": _LONE_SURROGATE + "seg"}),  # (clean)
    # NESTED, under a mapping this importer reads (`experiment.get("images")`).
    ("images.nested", {"images": {"morphology_focus_filepath": "morphology_focus",
                                  "vendor_note": _LONE_SURROGATE + "x"}}),
    # A hostile KEY, not a value: `json.dumps` writes it into the same artifact bytes.
    ("hostile-key", {_LONE_SURROGATE + "key": "value"}),
    # A TRAILING LOW surrogate, so the guard cannot be "the string starts with one".
    ("trailing-low-surrogate", {"run_name": "RUN\udfff"}),
]


@pytest.mark.parametrize("label,fields", _NEIGHBOURING_FIELDS,
                         ids=[label for label, _ in _NEIGHBOURING_FIELDS])
def test_TEST_3_the_rule_is_the_same_for_every_field_the_parse_feeds(label, fields, tmp_path):
    """TEST-3 [acceptance INV-3] — the rule applied at the BOUNDARY, so no field is one fewer.

    #329's own argument for where the fix goes is that `vendor_provenance` carries the same string
    to the artifact as the identity path does — so an identity-path guard would leave the crash in
    place while making the report look defended. This is that argument as an executable: a guard
    narrowed to `roi_uuid`, to the identity path, to top-level values, or to leading surrogates
    turns one of these red.
    """
    bundle = _copy(tmp_path, f"neighbour-{label}")
    _poison_experiment(bundle, **fields)
    out = tmp_path / f"out-neighbour-{label}"
    out.mkdir()

    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)
    exc = caught.value
    assert not isinstance(exc, UnicodeEncodeError), f"{label}: still the raw writer abort"
    assert type(exc).__name__ == "XeniumImportError", f"{label}: {type(exc).__name__}: {exc}"
    assert _outputs_tree(out) == [], f"{label}: a refused import left artifacts behind"


def test_TEST_4_the_value_is_REFUSED_and_never_repaired(tmp_path):
    """TEST-4 [acceptance INV-4] — the design note's §2 decision, as behaviour rather than as prose.

    Sanitising is the tempting alternative and it is the wrong one: a replaced character inside a
    `region_name` is a silently altered sample identity, emitted under a `sample_id_source` that
    says the vendor stated it — the false collision #320 exists to remove. The proof that this
    branch did NOT take that route is that the bundle produces NOTHING: not a repaired value, not
    a `U+FFFD`, not a truncation, not a stripped variant, not an artifact of any kind.
    """
    bundle = _copy(tmp_path, "refused-not-repaired")
    _poison_experiment(bundle, region_name=_LONE_SURROGATE + "REGION")
    out = tmp_path / "out-refused-not-repaired"
    out.mkdir()

    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)
    exc = caught.value
    assert type(exc).__name__ == "XeniumImportError", type(exc).__name__

    # Nothing was written at all, so there is no artifact in which a repaired value could hide.
    assert _outputs_tree(out) == []
    # And the refusal SHOWS the reader what was refused, escaped rather than replaced.
    assert "region_name" in str(exc)
    assert "\\ud800" in str(exc), str(exc)
    assert "�" not in str(exc), "the refusal must not itself substitute a character"


def test_TEST_5_the_refusal_is_printable_by_the_reporter_that_prints_it(tmp_path):
    """TEST-5 [acceptance INV-5] — the refusal a REAL BUNDLE produces is safe to emit.

    ## What this adds over TEST-10, stated because a blind angle asked

    TEST-10 is the thorough one: it drives `refuse_unencodable_vendor_text` DIRECTLY over hostile
    keys, huge values and astral amplification, and it is what actually kills a mutation of the
    message renderer. This one is narrower on purpose — it runs the WHOLE shipped import over a
    REAL vendor bundle and asserts the property on whatever refusal that path really produces. The
    two answer different questions: TEST-10 asks "is the renderer sound?", this asks "is the
    renderer the thing the production path uses?". A renderer that was sound and unwired would
    pass TEST-10 and fail here.

    ## The rationale this test used to give was FALSE, and is corrected rather than deleted

    It used to argue that a raw surrogate in the message would raise `UnicodeEncodeError` at
    `main()`'s own `print`. A blind angle measured that and it is wrong: CPython gives `sys.stderr`
    `errors="backslashreplace"` unconditionally, so that `print` never raises — under `LC_ALL=C`
    and `PYTHONIOENCODING=ascii:strict` alike. The real reasons the message must be ASCII are in
    `refuse_unencodable_vendor_text`'s docstring (it is re-encoded and re-rendered downstream, and
    the path trail is an injection surface). The strict-stream loop below is kept as a
    demonstration that the property holds under any reporter, not as evidence for the old claim.
    """
    import io

    bundle = _copy(tmp_path, "printable-refusal")
    _poison_experiment(bundle, roi_uuid=_LONE_SURROGATE + "BAD")

    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, tmp_path / "out-printable")
    exc = caught.value
    assert type(exc).__name__ == "XeniumImportError"

    message = str(exc)
    assert message.isascii(), message
    message.encode("utf-8")  # would raise on a surrogate

    for encoding in ("utf-8", "ascii"):
        stream = io.TextIOWrapper(io.BytesIO(), encoding=encoding, errors="strict")
        print(f"spatial.import-xenium: {exc}", file=stream, flush=True)  # main()'s own statement
        stream.flush()


def test_TEST_6_real_non_ascii_and_a_real_astral_character_still_IMPORT(tmp_path):
    """TEST-6 — the control that stops this becoming "refuse all non-ASCII".

    Two things a real vendor file can legitimately carry and this importer must still accept:

    * ordinary non-ASCII text (`µ`, `ä`) — encodable, and already reaching the artifact through
      `ensure_ascii=False` in `mirror_declarations_into_store`, which was written for exactly this;
    * an ASTRAL character, which in a JSON file is written as a surrogate PAIR escape
      (`"\\ud83e\\uddec"`). `json.loads` assembles the pair into the single codepoint U+1F9EC,
      which encodes to UTF-8 perfectly. A codepoint-range guard over `U+D800..U+DFFF` applied to
      the FILE would refuse it; the guard this branch ships tests the assembled `str` by encoding
      it, so it cannot.

    Without this test the guard could be "reject anything that is not ASCII" and every other
    assertion here would still pass.
    """
    bundle = _copy(tmp_path, "legit-unicode")
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text())
    doc["region_name"] = "Mus musculus µm Gewächs"
    doc["run_name"] = "run \U0001f9ec"
    path.write_text(json.dumps(doc, ensure_ascii=True), encoding="ascii")
    assert all(b < 128 for b in path.read_bytes()), "the vendor file is still pure ASCII"
    assert b"\\ud83e\\uddec" in path.read_bytes(), "the astral char is a surrogate PAIR escape"

    out = tmp_path / "out-legit-unicode"
    _module, entries = XF.run_over(bundle, out)

    report = _report(out)
    assert report["provenance"]["region_name"] == "Mus musculus µm Gewächs", report["provenance"]
    assert report["provenance"]["run_name"] == "run \U0001f9ec", report["provenance"]
    # And it survived into the STORE's own bytes, which is the write that used to abort.
    stamped = (out / "spatial" / "coordinates.zarr" / "zarr.json").read_text(encoding="utf-8")
    assert "Gewächs" in stamped
    assert XF.entry(entries, "spatial-coordinates")["meta"]["n"] > 0


#: The three shapes an h5 root attribute can carry unwritable text in, and what h5py hands back
#: for each. The FIXED-LENGTH one is what the committed real fixture actually uses
#: (`array([b'0000000_0000000'], dtype='|S15')`), and it is the shape the first version of this
#: test did NOT cover — it poisoned only the `utf-8` string dtype, which the vendor does not write.
#: Both blind audit angles found that independently; this list is the repair.
_H5_ATTR_SHAPES = [
    # (label, how to write it, what h5py returns)
    ("utf8-str-dtype", lambda h: h.attrs.create(
        "library_ids", b"\xff\xfeBAD", dtype=__import__("h5py").string_dtype("utf-8"))),
    ("fixed-length-bytes", lambda h: h.attrs.create("library_ids", np.bytes_(b"\xff\xfeBAD"))),
    ("fixed-length-bytes-array", lambda h: h.attrs.create(
        "library_ids", np.array([b"ok", b"\xff\xfeBAD"], dtype="|S8"))),
]


@pytest.mark.parametrize("label,write_attr", _H5_ATTR_SHAPES,
                         ids=[label for label, _ in _H5_ATTR_SHAPES])
def test_TEST_7_an_unwritable_h5_ROOT_attribute_is_refused_at_its_own_boundary(
        label, write_attr, tmp_path):
    """TEST-7 — the SECOND parse boundary, and the same rule at it.

    `h5py` decodes a UTF-8-typed string attribute with `surrogateescape`, so a root attribute
    holding bytes that are not valid UTF-8 comes back as lone surrogates in `U+DC80..U+DCFF` —
    the same unwritable `str`, arriving by a different door. `run_import` does
    `attrs = dict(h5.attrs)` and hands it to `vendor_provenance` as `matrix_attrs`.

    MEASURED on `origin/main` with `library_ids = b"\\xff\\xfeBAD"` on the FILE root:

        ROOT attr 'library_ids' -> '\\udcff\\udcfeBAD'
        -> NO REFUSAL — import completed
           provenance.matrix_library_id='\\udcff\\udcfeBAD'

    i.e. a job that reported SUCCESS and shipped an `xenium-import-report.json` that `serde_json`
    refuses. #323 closed the sibling on `/matrix/barcodes`; the root attributes were the half it
    did not cover.

    The attribute is written on the FILE root, not on `/matrix`, because that is where
    `run_import` reads it from — a test that poisoned `/matrix` would pass while covering nothing.

    ## Why this is parametrized over three SHAPES, and why that is the load-bearing part

    h5py hands back a different Python type per attribute dtype, and only ONE of them is a `str`:

    * a `utf-8` string dtype -> `'\udcff\udcfeBAD'`, a surrogate-escaped `str`;
    * a fixed-length `|S` dtype -> `b'\xff\xfeBAD'`, raw `bytes`;
    * an array of `|S` -> a `numpy.ndarray` of those bytes.

    **The committed real fixture uses the SECOND** — `array([b'0000000_0000000'], dtype='|S15')` —
    so a guard that only inspects `str` misses the only shape the vendor actually writes, while a
    test that poisons only the first stays green over it. That is exactly what happened: the first
    revision of this test covered `utf-8` alone, and both blind audit angles measured the same
    escape independently. Before the `bytes` arm existed, `b"\xff\xfeBAD"`, `b"\xfe\xffBAD"` and
    `b"\x80\x81BAD"` ALL imported cleanly and ALL emitted
    `provenance.matrix_library_id = '\ufffd\ufffdBAD'` — three vendor byte strings collapsing into
    one identifier, sanitised, which is the one outcome the design refuses to produce.
    """
    import h5py

    bundle = _copy(tmp_path, f"h5-root-attr-{label}")
    with h5py.File(bundle / "cell_feature_matrix.h5", "r+") as handle:
        write_attr(handle)
    with h5py.File(bundle / "cell_feature_matrix.h5", "r") as handle:
        got = handle.attrs["library_ids"]
        # The premise, asserted rather than assumed: whatever shape this is, it must be one the
        # importer cannot write. Otherwise the test proves nothing about the guard.
        assert any(_is_unwritable(c) for c in _flatten(got)), (label, repr(got))

    out = tmp_path / f"out-h5-root-attr-{label}"
    out.mkdir()
    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)
    exc = caught.value
    assert type(exc).__name__ == "XeniumImportError", f"{type(exc).__name__}: {exc}"
    assert "cell_feature_matrix.h5" in str(exc), str(exc)
    assert "library_ids" in str(exc), str(exc)
    assert str(exc).isascii(), str(exc)
    assert _outputs_tree(out) == [], "the second boundary must also precede every write"
    # THE DIAGNOSIS MATCHES THE SHAPE. Nothing else asserts this, so without it the two arms of
    # `refuse_unencodable_vendor_text` could report each other's message and every test stay green
    # (a blind angle measured exactly that: making both diagnoses identical left 45 tests passing).
    # It also happens to be what makes the refusal useful — "a lone surrogate" and "bytes that are
    # not valid UTF-8" call for different things from whoever produced the file.
    if label == "utf8-str-dtype":
        assert "LONE SURROGATE" in str(exc), str(exc)
    else:
        assert "BYTES THAT ARE NOT VALID UTF-8" in str(exc), str(exc)


def test_TEST_8_the_package_manifest_version_moved_past_the_body_that_shipped_the_defect():
    """TEST-8 — `check-processor-seed-versions.sh`'s rule, asserted from the package's own suite.

    `0.9.6` is the version that shipped the unguarded `read_experiment`. A later edit to this
    package's `compute/` that forgets the bump republishes a changed processor under a version a
    consumer has already cached — the collision the manifest's own comment records happening five
    consecutive times on this repo's processor manifests.

    **Honest limit, stated because a blind angle measured it:** this assertion passes with the
    entire #329 guard reverted. It is a PACKAGING check, not a behavioural one, and it is not
    evidence that anything works — the behaviour is TEST-1..TEST-7's job. It is kept because the
    version rule is real and is otherwise enforced only by a repo-level script this package's own
    suite cannot see.
    """
    manifest = (XF.PKG / "manifest.yaml").read_text(encoding="utf-8")
    declared = [ln.split(":", 1)[1].strip() for ln in manifest.splitlines()
                if ln.startswith("version:")]
    assert len(declared) == 1, declared
    parts = tuple(int(x) for x in declared[0].split("."))
    assert parts > (0, 9, 6), f"manifest version {declared[0]} did not move past 0.9.6"


def test_TEST_9_the_named_design_and_the_shipped_guard_still_describe_each_other():
    """TEST-9 — the design note held against the CODE, in both directions.

    The first version of this test only grepped the note for four phrases, so it passed with the
    entire #329 guard reverted to `origin/main`'s body — a blind angle measured exactly that. A
    note-only assertion cannot notice that the code stopped implementing the note, which is the one
    thing a design-conformance guard is for.

    So this binds the two: the note must still state the decision (REFUSE, not sanitise) and still
    name both boundaries, AND the shipped module must still contain the predicate and CALL it at
    two sites. Revert the guard and this goes red on the code half; flip the decision to
    sanitisation and it goes red on the note half.
    """
    note = XF.PKG.parents[2] / "docs" / "design" / "vendor-text-encodability-refusal.md"
    assert note.is_file(), note
    text = note.read_text(encoding="utf-8")

    # --- the note still states what the code does ---
    assert "REFUSE, and refuse at the parse boundary" in text
    # ONE phrase, not an OR. The alternative used to be "refused rather than repaired", which is
    # the wording of the CODE'S REFUSAL MESSAGE and appears nowhere in the note -- so pasting the
    # message into the note would have satisfied this without §2's decision being stated at all.
    assert "Refuse, do not sanitise" in text
    assert "experiment.xenium" in text
    assert "h5 root attributes" in text or "h5 ROOT attributes" in text
    # the out-of-scope sibling stays named as out of scope rather than quietly forgotten
    assert "spatial-import-visium" in text

    # --- and the code still does it ---
    #
    # BY AST, not by substring. The first version of this half counted occurrences of the call's
    # TEXT and checked that the two named functions were DEFINED. A blind angle defeated both in
    # one move: moving `read_experiment`'s guard call verbatim into a never-called function left
    # every textual check satisfied and TEST-9 green with the first parse boundary entirely
    # unguarded. A text count is also formatting-sensitive — joining the call onto one line made
    # it accuse the module of having lost a boundary — and it hardcoded the number 2, so a
    # legitimate third boundary would have been reported as "add the boundary to the note".
    #
    # So: parse the module, find the functions the note names, and assert the call is INSIDE each
    # one's body. That is the claim, and it is now the assertion.
    import ast as _ast

    source = (XF.PKG / "compute" / "import_xenium.py").read_text(encoding="utf-8")
    tree = _ast.parse(source)
    defined = {n.name for n in _ast.walk(tree) if isinstance(n, _ast.FunctionDef)}
    assert "unencodable_vendor_text" in defined, "the predicate the note describes is gone"
    assert "refuse_unencodable_vendor_text" in defined

    def _module_functions(tree):
        return [n.name for n in _ast.iter_child_nodes(tree)
                if isinstance(n, _ast.FunctionDef)]

    def _calls(tree, func_name, target):
        """Is `target` called from `func_name`'s OWN body — not from a nested def inside it?

        `ast.walk` descends into nested `FunctionDef`s, and that is not a nitpick: the exact
        mutation this test exists to catch is the guard call moved verbatim into a never-called
        inner function. Under a plain `walk` that mutation left this test GREEN with the first
        parse boundary entirely unguarded, which is the same false pass, one layer down, as the
        substring version it replaced. So the descent stops at every nested scope.
        """
        def reached(node):
            for child in _ast.iter_child_nodes(node):
                if isinstance(child, (_ast.FunctionDef, _ast.AsyncFunctionDef,
                                      _ast.Lambda, _ast.ClassDef)):
                    continue                      # a nested scope is not this function's body
                if (isinstance(child, _ast.Call)
                        and isinstance(child.func, _ast.Name)
                        and child.func.id == target):
                    return True
                if reached(child):
                    return True
            return False

        for node in _ast.walk(tree):
            if isinstance(node, _ast.FunctionDef) and node.name == func_name:
                return reached(node)
        return False

    def _calls_the_guard(tree, func_name):
        return _calls(tree, func_name, "refuse_unencodable_vendor_text")

    # REACHABILITY, not syntactic containment. Extracting the call into a real module-level helper
    # that the boundary then calls is a behaviour-preserving refactor, and the first version of
    # this assertion called it "the module stopped guarding a boundary" — a false alarm whose
    # message asserted semantics while the check tested shape. So a boundary counts as guarded if
    # it calls the guard directly OR calls a module-level function that does.
    direct = {name for name in _module_functions(tree) if _calls_the_guard(tree, name)}
    reaching = set(direct)
    for _ in range(3):                       # a shallow fixed point; the module has no deep chains
        grew = {name for name in _module_functions(tree)
                if any(_calls(tree, name, target) for target in reaching)}
        if grew <= reaching:
            break
        reaching |= grew

    guarded = sorted(f for f in ("read_experiment", "run_import") if f in reaching)
    assert guarded == ["read_experiment", "run_import"], (
        "the note names two guarded parse boundaries -- `experiment.xenium` (read_experiment) and "
        f"the h5 root attributes (run_import) -- and the guard is reachable from {guarded}. "
        "Either the module stopped guarding a boundary, or the note stopped naming one; they may "
        "not drift."
    )
    # ...AND THE COUNT, which fails CLOSED on a THIRD boundary. An earlier revision dropped this
    # on the grounds that it "named the wrong remedy" for a legitimate third boundary. That was the
    # check working: a new parse boundary is exactly the moment someone must decide whether the
    # design note names it, and silence there is how the next boundary ships unguarded and
    # undocumented. It is kept, with a message that says what to do.
    call_sites = sum(1 for node in _ast.walk(tree)
                     if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name)
                     and node.func.id == "refuse_unencodable_vendor_text")
    assert call_sites == 2, (
        f"the guard is called at {call_sites} sites; the design note names TWO parse boundaries. "
        "If you added a third, that is fine and welcome -- add it to the note's section 1 and "
        "section 3 and bump this number in the same commit, so the two cannot drift."
    )


#: Every shape a vendor can give the two things a refusal interpolates. These ran in a bare `for`
#: loop, which hides every case after the first failure, so they are parametrised.
_UNSAFE_MESSAGE_INPUTS = [
    ("ansi-crlf-key", {"\x1b[2J\x1b[31mFATAL\x07\nspatial.import-xenium: import SUCCEEDED\r":
                       _LONE_SURROGATE + "BAD"}),
    ("non-ascii-key", {"Gewächs": _LONE_SURROGATE + "BAD"}),
    ("non-ascii-nested-key", {"images": {"nöte": _LONE_SURROGATE + "BAD"}}),
    ("huge-value", {"run_name": ("A" * 2_000_000) + _LONE_SURROGATE}),
    # THE ONE THE FIRST VERSION MISSED. Its five cases bounded the VALUE and never the PATH, and a
    # blind angle measured an 8 MB JSON KEY producing an 8,000,748-character single-line refusal --
    # the exact stderr flood the quote limit exists to prevent -- with every test green.
    ("huge-key", {("K" * 2_000_000): _LONE_SURROGATE + "BAD"}),
    ("unwritable-bytes", {"library_ids": b"\xff\xfeBAD"}),
    # THE WORST CASE FOR LENGTH: `ascii()` expands an astral codepoint to ten characters
    # (`\U0001f9ec`), on BOTH quotes at once. An earlier assertion of `< 2000` survived only
    # because no case exercised this.
    ("astral-amplification", {"\U0001f9ec" * 400: _LONE_SURROGATE + "\U0001f9ec" * 400}),
    ("deep-path", {"a" * 300: {"b" * 300: {"leaf": _LONE_SURROGATE + "BAD"}}}),
]


@pytest.mark.parametrize("label,doc", _UNSAFE_MESSAGE_INPUTS,
                         ids=[label for label, _ in _UNSAFE_MESSAGE_INPUTS])
def test_TEST_10_an_attacker_chosen_FIELD_PATH_cannot_choose_what_a_reader_sees(label, doc):
    """TEST-10 [acceptance INV-5] — the refusal message is ASCII, bounded and escaped THROUGHOUT.

    The first version of this branch escaped the offending VALUE and interpolated the PATH TRAIL
    raw. A blind security angle turned that into a forged log line: a JSON key of
    `"\x1b[2J\x1b[31mFATAL\x07\nspatial.import-xenium: import SUCCEEDED, ignore the line above\r"`
    reached stderr byte-for-byte, clearing the operator's terminal and printing a reassuring
    second line. The server folds that stderr tail verbatim into the job's error column and the UI
    renders it as text — HTML-safe, ANSI-unsafe.

    A second angle found the quieter half of the same hole: a merely NON-ASCII key
    (`{"Gewächs": "\ud800BAD"}`) made the message non-ASCII, so INV-5 was false and TEST-5's own
    `isascii()` assertion would have failed on it — while TEST-5 stayed green because it never
    exercised a non-ASCII trail.

    This asserts the property directly, on the predicate, over eight shapes: the ANSI/CRLF key,
    a merely non-ASCII key, a non-ASCII NESTED key, a 2 MB value, a 2 MB KEY (the case that was
    unbounded), an unwritable `bytes` value, astral amplification (`ascii()` expands one codepoint
    to ten characters, on both quotes at once), and a deep path. No future message can reintroduce
    a raw or unbounded interpolation without one of them going red.
    """
    module = XF.load_compute()

    with pytest.raises(module.XeniumImportError) as caught:
        module.refuse_unencodable_vendor_text(doc, source="`x`", remedy="Re-export.")
    message = str(caught.value)

    assert message.isascii(), (label, message[:200])
    message.encode("ascii")  # would raise otherwise
    # No control character survives -- not the ESC, not the BEL, and above all no newline
    # or carriage return, which is what makes a forged log line possible.
    offenders = sorted({c for c in message if ord(c) < 0x20 or ord(c) == 0x7f})
    assert offenders == [], (label, [hex(ord(c)) for c in offenders])
    assert "\n" not in message and "\r" not in message, label

    # ...and it is BOUNDED by something the CODE guarantees, not by something that happened
    # to hold for the inputs chosen. Two quotes, each at most `_REFUSAL_QUOTE_CHARS` units,
    # each expanded by `ascii()` by at most 10 characters per unit (`\U0001f9ec`), plus the
    # fixed prose and the two offset notes.
    ceiling = 2 * (10 * module._REFUSAL_QUOTE_CHARS + 120) + 1200
    assert len(message) <= ceiling, (label, len(message), ceiling)
    # (An `assert len(message) < 4000` used to sit here. `ceiling` evaluates to 3840, so it could
    # never fire while the line above held — dead by arithmetic. Removed rather than kept as
    # reassurance: the measured maximum across these cases is ~3.1 KB, and the bound that matters
    # is the one derived from the module's own constant.)


def test_TEST_15_the_quote_is_about_the_OFFENCE_not_about_the_start_of_the_value():
    """TEST-15 [acceptance INV-5] — a refusal may not show innocent text and call it the problem.

    Its own TEST-ID rather than a second function under TEST-10's, because every other TEST-N in
    this file is one function and multiplicity is expressed by parametrisation.
    """
    module = XF.load_compute()

    # THE QUOTE IS ABOUT THE OFFENCE, not about the start of the value. A blind angle measured a
    # 212-character `run_name` whose surrogate sits past position 120: the message quoted 120
    # perfectly ordinary characters and then asserted "That is a LONE SURROGATE" — showing the
    # reader something innocent and calling it the problem.
    late = {"run_name": ("0" * 200) + _LONE_SURROGATE + "TAIL"}
    with pytest.raises(module.XeniumImportError) as caught:
        module.refuse_unencodable_vendor_text(late, source="`x`", remedy="Re-export.")
    message = str(caught.value)
    assert "\\ud800" in message, message[:400]
    assert "the offending unit is at 200" in message, message[:400]
    assert "of 205" in message, message[:400]

    # ...and a long PATH keeps its LEAF, which is the part it exists to name.
    deep = {"z" * 400: {"the_actual_field": _LONE_SURROGATE + "BAD"}}
    with pytest.raises(module.XeniumImportError) as caught:
        module.refuse_unencodable_vendor_text(deep, source="`x`", remedy="Re-export.")
    assert "the_actual_field" in str(caught.value), str(caught.value)[:400]


def test_TEST_11_deeply_nested_vendor_json_is_a_named_refusal_not_a_traceback(tmp_path):
    """TEST-11 [acceptance INV-1] — the last state in which INV-1 was still false.

    `json.loads` raises `RecursionError` on a document nested past roughly 990 levels, out of a
    file that is PURE ASCII. `RecursionError` subclasses neither `OSError` nor `ValueError`, so it
    passed straight through `read_experiment`'s `except` tuple, and `main()` catches only
    `XeniumImportError` — a traceback and exit 1, at the exact boundary INV-1 is stated for. Both
    blind angles reproduced it independently.

    Both also measured that the GUARD's own walk is not the weak link: `json.loads` fails first at
    every depth, so this test is about the parse, not about the walker.
    """
    bundle = _copy(tmp_path, "deep-nesting")
    path = bundle / "experiment.xenium"
    # The nesting is spliced in as TEXT. Building it as a Python object and `json.dumps`-ing it
    # would recurse in the TEST, which proves nothing about the importer -- and is exactly the
    # trap: the first version of this test died in its own fixture setup.
    depth = 2000
    body = path.read_text().rstrip()
    assert body.endswith("}")
    path.write_text(
        body[:-1] + ', "deep": ' + "[" * depth + "]" * depth + "}",
        encoding="ascii",
    )
    assert all(b < 128 for b in path.read_bytes()), "the staged vendor file is pure ASCII"
    # The premise, asserted: this document really is one `json.loads` cannot parse.
    with pytest.raises(RecursionError):
        json.loads(path.read_text())

    out = tmp_path / "out-deep-nesting"
    out.mkdir()
    with pytest.raises(Exception) as caught:
        XF.run_over(bundle, out)
    exc = caught.value
    assert not isinstance(exc, RecursionError), "the reported defect, unfixed"
    assert type(exc).__name__ == "XeniumImportError", f"{type(exc).__name__}: {exc}"
    assert "experiment.xenium" in str(exc), str(exc)
    assert _outputs_tree(out) == []


def test_TEST_12_a_legitimate_h5_root_attribute_in_the_vendors_own_shape_still_IMPORTS(tmp_path):
    """TEST-12 — the control for the `bytes` arm, on the shape the real bundle actually ships.

    TEST-7 proves invalid bytes are refused. Without this, "refuse every `bytes` attribute" would
    pass it. The committed prime fixture's own `library_ids` is `|S15` fixed-length bytes, so it is
    also the one test that pins the FIXTURE'S SHAPE: rewrite the fixture's attribute as a `utf-8`
    string dtype and this goes red alone, which is what keeps TEST-7's `fixed-length-bytes`
    parametrisation about the shape it claims.

    ## The import and the report are RUN here, not asserted about

    An earlier revision of this test claimed the value "must keep importing and keep reaching the
    report verbatim" and then only called the predicate on a dict it built itself. A blind angle
    measured the gap: mangling, truncating or deleting `provenance.matrix_library_id` left the
    whole file green. Claiming a leg and not walking it is the phantom-leg defect, so the leg is
    walked.
    """
    import h5py

    with h5py.File(XF.PRIME / "cell_feature_matrix.h5", "r") as handle:
        raw = handle.attrs["library_ids"]
    # the premise: the real fixture really does use the bytes shape
    listed = _flatten(raw)
    assert listed and all(isinstance(x, bytes) for x in listed), repr(raw)

    module = XF.load_compute()
    # the guard says nothing about it, because it is valid UTF-8
    assert module.unencodable_vendor_text({"library_ids": raw}) is None
    # ...and so is every scalar inside it, checked one at a time so a passing whole cannot hide a
    # failing part.
    for item in listed:
        assert module.unencodable_vendor_text(item) is None, repr(item)

    # AND THE WHOLE IMPORT RUNS, and the value arrives in the report unchanged.
    out = tmp_path / "out-legit-bytes-attr"
    XF.run_over(XF.PRIME, out)
    prov = _report(out)["provenance"]
    expected = ", ".join(x.decode("utf-8") for x in listed)
    assert prov["matrix_library_id"] == expected, (prov.get("matrix_library_id"), expected)
    assert prov["matrix_library_id"] == XF.PLACEHOLDER_LIBRARY_ID, prov["matrix_library_id"]
    module.refuse_unencodable_vendor_text({"library_ids": raw}, source="`x`", remedy="")


def test_TEST_13_the_vendor_document_is_decoded_as_utf8_whatever_the_LOCALE_says(tmp_path):
    """TEST-13 [design note §1.3/§2] — the guard's PREMISE, pinned instead of assumed.

    `read_experiment` decodes with an explicit `encoding="utf-8"`. Without it, `read_text()` uses
    the LOCALE default.

    ## What that actually costs — corrected, because the first version of this docstring was wrong

    It claimed the missing keyword would let "the same bytes decode into different, perfectly
    encodable characters, and a mojibake identity ship instead of a refusal". A blind angle
    measured it and that is not what happens: under an ASCII locale `read_text()` raises
    `UnicodeDecodeError`, which subclasses `ValueError` and is already in `read_experiment`'s
    `except` tuple, so the run ends in a clean named `XeniumImportError` with no partial store.
    Nothing is silently mis-decoded.

    The real cost is AVAILABILITY, and it is worth a keyword on its own: on a C-locale machine, a
    legitimate bundle carrying ordinary non-ASCII vendor text (`µm`, `Gewächs`) becomes
    UNIMPORTABLE, and the refusal blames the vendor's file for the machine's locale. That is the
    same class as the write-side defect TEST-14 pins, one direction over.

    The locale is forced ASCII in a SUBPROCESS
    (`PYTHONUTF8=0 PYTHONCOERCECLOCALE=0 LC_ALL=C`, which really does yield
    `getpreferredencoding() == 'ANSI_X3.4-1968'`), and a bundle carrying legitimate non-ASCII
    vendor text must still read back verbatim. Drop the `encoding=` and the subprocess exits
    non-zero with that refusal, so this test goes red — verified.
    """
    bundle = _copy(tmp_path, "locale-read")
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["region_name"] = "Mus musculus µm Gewächs"
    # Written as UTF-8 BYTES, not as an ASCII escape: the point is the DECODE.
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    assert any(b > 127 for b in path.read_bytes()), "the file must carry real non-ASCII bytes"

    run = _run_under_ascii_locale(
        "import sys\n"
        "from pathlib import Path\n"
        f"sys.path.insert(0, {str(XF.PKG / 'tests')!r})\n"
        "import xenium_fixtures as XF\n"
        "print(ascii(XF.load_compute().read_experiment(Path(sys.argv[1]))['region_name']))\n",
        path, cwd=tmp_path,
    )
    assert run.returncode == 0, run.stderr.decode("utf-8", "backslashreplace")[-2000:]
    assert "Mus musculus \\xb5m Gew\\xe4chs" in run.stdout.decode("ascii"), run.stdout


def test_TEST_14_an_ordinary_bundle_imports_under_an_ASCII_LOCALE(tmp_path):
    """TEST-14 [acceptance INV-1] [design note §4b] — #329's failure shape at a THIRD site.

    Found while building TEST-13, and it is not about hostile input at all. This module wrote its
    `manifest.json`, its report and its summary with `write_text(...)` and NO encoding, i.e. the
    LOCALE default. MEASURED under `LC_ALL=C` on an ORDINARY bundle:

        UnicodeEncodeError: 'ascii' codec can't encode character '\\u2014' in position 232
          import_xenium.py  run_import
          pathlib.py        write_text          <- xenium-import-summary.html
        store on disk: True | outputs entries: 184

    `\\u2014` is an EM DASH IN THIS MODULE'S OWN PROSE. So the job died with an uncaught
    `UnicodeEncodeError` and exit 1, after 184 paths were written, on a clean vendor bundle,
    because of the machine's locale -- #329's exact shape, reached without an attacker. The
    declaration mirror's own comment predicted it: "a non-ASCII library id would abort the writer
    under an ASCII locale".

    The fix is three `encoding="utf-8"` keywords. This is what holds them there.
    """
    inputs = tmp_path / "in"
    inputs.mkdir()
    outputs = tmp_path / "out"
    outputs.mkdir()
    shutil.copytree(XF.PRIME, inputs / "bundle")
    (inputs / "inputs.json").write_text(json.dumps(
        {"inputs": [{"slot": "bundle", "kind": "dir", "content_hash": "x",
                     "sandbox_path": "/inputs/bundle"}]}), encoding="utf-8")
    (inputs / "params.json").write_text("{}", encoding="utf-8")

    # `runpy` on the SHIPPED ENTRY FILE, which is how the sandbox invokes it -- rather than an
    # `exec(compile(open(...)))` spelling this file would be the only user of.
    run = _run_under_ascii_locale(
        "import runpy\n"
        f"runpy.run_path({str(XF.PKG / 'compute' / 'import_xenium.py')!r}, "
        "run_name='__main__')\n",
        cwd=outputs,
        extra_env={"TXR_INPUTS_DIR": str(inputs), "TXR_OUTPUTS_DIR": str(outputs)},
    )
    err = run.stderr.decode("utf-8", "backslashreplace")
    assert "UnicodeEncodeError" not in err, err[-2500:]
    assert run.returncode == 0, err[-2500:]
    assert (outputs / "manifest.json").is_file()
    assert (outputs / "xenium-import-summary.html").is_file()
    assert (outputs / "spatial" / "coordinates.zarr").is_dir()

    # THE PREMISE, asserted. All of this test's teeth come from the summary containing non-ASCII
    # text: rewrite `render_report_html`'s prose to plain ASCII -- a plausible edit in a module
    # that elsewhere argues its refusal text must be ASCII -- and the write it exists to hold
    # becomes untestable while this test stays green. That is the phantom-leg shape TEST-12's own
    # docstring names, so it is closed here rather than left implied.
    summary = (outputs / "xenium-import-summary.html").read_bytes()
    assert any(b > 127 for b in summary), (
        "the summary is now pure ASCII, so this test no longer exercises the locale-encoded write "
        "it exists to hold. Either restore the non-ASCII prose or replace this test with one that "
        "writes non-ASCII vendor text into the summary deliberately."
    )
