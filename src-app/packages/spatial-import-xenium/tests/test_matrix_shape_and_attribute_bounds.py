#!/usr/bin/env python3
# ruff: noqa
r"""#452 and #456: `/matrix/shape` dtype refusals, and the bounded root-attribute walk.

## #452 — `/matrix/shape` with a non-numeric dtype must REFUSE, not traceback

`run_import` reads `/matrix/shape` with `[int(x) for x in np.asarray(group["shape"][:]).tolist()]`
and the `required` presence check above it proves the name EXISTS but never checks its dtype.
Every hostile spelling escaped `main()`'s `except XeniumImportError` as a raw traceback at exit 1
— MEASURED on this branch, through the shipped entrypoint:

| hostile `/matrix/shape` | what raised |
|---|---|
| fixed-length `S` / vlen string dataset | `int(b"<vendor bytes>")` -> `ValueError` |
| float dataset carrying `NaN` | `int(nan)` -> `ValueError` |
| float dataset carrying `inf` / `-inf` | `int(inf)` -> `OverflowError` |
| 2-D dataset | `int([1, 2])` -> `TypeError` |
| scalar dataset | `[:]` -> `ValueError: Illegal slicing argument for scalar dataspace` |
| `/matrix/shape` is a GROUP | `[:]` -> `TypeError: Accessing a group is done with bytes or str, not <class 'slice'>` |

The `inf` / `-inf` rows are the newest: `OverflowError` was added to the read's except tuple
because `int(float('inf'))` raised it and it was previously UNCAUGHT — a `/matrix/shape` of
`np.array([np.inf, 2.0])` escaped `main()`'s `except XeniumImportError` as a raw traceback at
exit 1, the one-character variant of the `NaN` case. The per-row marker asserts the class name
`'OverflowError'`, never CPython's prose.

The arity guard (`len(shape) != 2`) was written for the one-element case and never measured the
dtype case; the guarded read here is the dtype case. Every refusal fires BEFORE the first writer,
so a refused bundle leaves nothing on disk (INV-2), and every refusal is a named
`XeniumImportError` at exit 2 with no `Traceback` on stderr (INV-1).

The same dangling-link class is guarded at the FIRST dereference of the function: `"matrix" in
h5` is True for a `/matrix` that is an `ExternalLink` to a missing file, and `h5["matrix"]`
then raises `KeyError`. That dereference is wrapped and refused by name, like the shape read.

## The `/matrix/shape` pre-read size bound

The read site also refuses a shape dataset whose DECLARED size exceeds the pre-read bounds
BEFORE `shape_ds[:]` is evaluated, from `shape_ds.nbytes` and `shape_ds.size` alone (h5
metadata, no data read). The binding quantity is BYTES — `_MAX_SHAPE_BYTES = 4096` — because
the read's cost is `size x itemsize`: an element cap alone does not bound the work, since a
2-element dataset of `S1073741824` is a 2 GiB read that passes ANY element cap.
`_MAX_SHAPE_ELEMENTS = 1024` sits alongside it as a second, independent check on the element
COUNT for fixed-width dtypes (vlen/object is refused on its dtype alone, before the read, so
the element cap never has to see it). Previously `shape_ds[:]` materialised every element and
`.tolist()` boxed each
one — a hostile 100-million-element shape dataset was an OOM SIGKILL with no refusal, the same
class #456 exists to prevent, one field over. The tests create the dataset SPARSELY
(`create_dataset(shape=..., fillvalue=0)` with chunking) so no dense buffer is ever allocated
and the file on disk stays tiny, and assert the NAMED refusal, never a duration.

The gate is on the DTYPE as well as the size: `Dataset.nbytes` is `dtype.itemsize * size`, and
for a vlen dtype `itemsize` is 8 — the size of a POINTER, not the payload — so a two-element
vlen shape dataset reports `nbytes == 16` and passes ANY byte cap while `[:]` still
materialises the attacker-chosen payloads, and the element cap does not save it because the
per-element size is attacker-chosen. A vlen/object shape dtype (or a compound carrying one) is
therefore refused on its dtype alone, before `[:]`, with a message that says it is not the two
integers rather than that it is too large.

## #456 — the h5 root-attribute walk is BOUNDED

`unencodable_vendor_text`'s `np.ndarray` arm called `.tolist()` unconditionally, which
materialises EVERY element of an array as a Python object before recursing over them. A large
numeric array is an OOM SIGKILL with no message at all — strictly worse than a long line on
stderr. The walk now carries the two bounds the Visium sibling ships:

1. a DTYPE DENY-LIST (`node.dtype.kind in "biufcMm"`) — a numeric array cannot contain
   unwritable text, so walking it does the work the check exists to bound and returns `None`
   every time;
2. a SIZE BOUND (`_MAX_WALKED_ATTRIBUTE_BYTES = 1 << 20`) — a non-numeric array past 1 MiB is
   refused BY NAME, stating the attribute and the byte count.

plus the `np.void` arm (the scalar twin of the compound/opaque dtype hole), which carries the
same size bound as the `ndarray` arm: an opaque scalar is capped at 64 KiB only under default
libver — under `latest` dense attribute storage lifts that cap, so a large opaque scalar is
reachable and `.tolist()` would materialise it.

The tests assert the REFUSAL and the SKIP, never a duration: wall-clock under contention is not a
measurement and it flakes. The arrays are modest — just over the 1 MiB cap — not multi-GB.

Damage is always done to a COPY of the committed fixture; the fixture itself is never modified.
"""
import shutil
import sys
from pathlib import Path

import h5py
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402
from test_refusal_escaping import _assert_safe_to_log  # noqa: E402

MATRIX = "cell_feature_matrix.h5"


def _copy(tmp_path, name):
    dest = Path(tmp_path) / name
    shutil.copytree(XF.PRIME, dest)
    return dest


def _rewrite_shape(bundle, data):
    """Replace `/matrix/shape` with `data` in a staged copy, in place."""
    with h5py.File(bundle / MATRIX, "r+") as handle:
        group = handle["matrix"]
        del group["shape"]
        if isinstance(data, h5py.ExternalLink):
            group["shape"] = data
        else:
            group.create_dataset("shape", data=data)


def _rebuild_with_attr(tmp_path, name, attr_name, attr_value):
    """A staged copy whose h5 is REBUILT with `libver="latest"` so a >64 KB root attribute can
    be written (dense attribute storage lifts HDF5's 64 KB object-header cap), with the `/matrix`
    group and the original root attributes copied byte-for-byte."""
    bundle = _copy(tmp_path, name)
    src = bundle / MATRIX
    rebuilt = bundle / "rebuilt.h5"
    with h5py.File(src, "r") as source, h5py.File(rebuilt, "w", libver="latest") as dest:
        for key, value in source.attrs.items():
            dest.attrs[key] = value
        source.copy("matrix", dest)
        dest.attrs[attr_name] = attr_value
    rebuilt.replace(src)
    return bundle


def _assert_nothing_on_disk(out):
    survivors = sorted(p.relative_to(out).as_posix() for p in out.rglob("*")) if out.exists() else []
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"
    assert not (out / "manifest.json").exists(), "a refused import must not write a manifest"
    assert list(Path(out).rglob("zarr.json")) == [], "a refused import must leave no store"


# ── #452: `/matrix/shape` dtype refusals ────────────────────────────────────────────────


@pytest.mark.parametrize("name,data,exc_class", [
    # A fixed-length `S` dataset whose bytes are NOT numeric: `int(b"abc")` raises ValueError.
    ("fixed-S", np.array([b"abc", b"def"], dtype="S3"), b"'ValueError'"),
    # A vlen string dataset (h5py returns an object array of bytes): the vlen/object pre-read
    # gate refuses it on its DTYPE before the coercion guard is reached, so the marker is the
    # gate's own reason, not an exception class name.
    ("vlen-string", np.array([b"abc", b"def"], dtype=object), b"variable-length"),
    # A float dataset carrying NaN: `int(nan)` raises ValueError.
    ("float-NaN", np.array([np.nan, 2.0]), b"'ValueError'"),
    # A float dataset carrying +inf: `int(inf)` raises OverflowError.
    ("float-inf", np.array([np.inf, 2.0]), b"'OverflowError'"),
    # A float dataset carrying -inf: `int(-inf)` raises OverflowError.
    ("float-neg-inf", np.array([-np.inf, 2.0]), b"'OverflowError'"),
    # A 2-D dataset: `int([1, 2])` raises TypeError.
    ("2-D", np.array([[1, 2], [3, 4]]), b"'TypeError'"),
    # A scalar dataset: the `[:]` read itself raises ValueError inside h5py.
    ("scalar", np.int32(7), b"'ValueError'"),
])
def test_452_a_non_numeric_shape_dtype_is_refused_by_name(tmp_path, name, data, exc_class):
    r"""TEST-452 [acceptance INV-1/INV-2] — every hostile `/matrix/shape` dtype is a NAMED
    refusal, never a traceback, and leaves nothing on disk.

    MEASURED pre-fix through the shipped entrypoint, each row escaped as a raw traceback at
    exit 1 (the exact exception is quoted in the module docstring's table). Post-fix each is
    `rc=2`, no `Traceback` on stderr, the refusal names `/matrix/shape`, says what was found
    there (dtype and shape), and states that a 10x feature-barcode matrix stores it as two
    integers — and the outputs tree is empty.

    The per-row marker asserts the exception CLASS NAME (`'ValueError'` / `'TypeError'`),
    not the third party's message prose: the class name is chosen by this module and stable,
    while CPython's and h5py's wording of the same failure rotates across versions. The
    refusal still embeds the underlying message for an operator; only the ASSERTION is on
    the stable marker. The `vlen-string` row is the exception: the vlen/object pre-read gate
    now refuses it on its DTYPE before the coercion guard is reached, so its marker is the
    gate's own reason (`variable-length`), equally stable and equally chosen by this module.
    """
    bundle = _copy(tmp_path, f"shape-{name}")
    _rewrite_shape(bundle, data)
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"two integers" in row, row[:400]
    assert exc_class in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_hostile_BYTES_shape_dtype_is_refused_and_escaped(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — a `/matrix/shape` carrying HOSTILE BYTES is refused
    and the refusal is ESCAPED, safe to log.

    The dtype refusal interpolates `_quoted_for_refusal(exc, noun='message')`, and CPython's
    `ValueError` message ECHOES the vendor's bytes back (`int(b"\x1b[2J\xff\xfeFATAL")` quotes
    the raw bytes in its message). The AST guard proves the interpolation is funnelled
    STRUCTURALLY, but nothing behavioural exercised the funnel on this path — a future refactor
    that inlines `{exc}` would not be caught by any test here. This leg is that behavioural
    exercise: the raw `\x1b[2J` bytes must NOT reach stderr (the `vendor_markers` leg of
    `_assert_safe_to_log`, the same idiom `test_refusal_escaping.py` uses), the ESCAPED form
    must appear in the quoted value, and the refusal must still name `/matrix/shape`.
    """
    bundle = _copy(tmp_path, "shape-hostile-bytes")
    _rewrite_shape(bundle, np.array([b"\x1b[2J\xff\xfeFATAL", b"x"], dtype="S16"))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=[b"\x1b[2J"])
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"two integers" in row, row[:400]
    assert b"'ValueError'" in row, row[:400]
    # The ESCAPED form is what an operator sees — the raw bytes are gone, the escape is not.
    assert rb"\x1b[2J" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_group_where_shape_should_be_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — `/matrix/shape` is a GROUP, not a dataset.

    MEASURED pre-fix: `TypeError: Accessing a group is done with bytes or str, not <class
    'slice'>` escaped as a raw traceback at exit 1. Post-fix the refusal names the type that
    was found (`'Group'`) and that a 10x feature-barcode matrix stores `/matrix/shape` as two
    integers.
    """
    bundle = _copy(tmp_path, "shape-group")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
        handle["matrix"].create_group("shape")
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"'Group'" in row, row[:400]
    assert b"two integers" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_an_external_link_shape_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — `/matrix/shape` is an EXTERNAL LINK to a
    nonexistent file.

    `"shape" in group` is True for a link (the name exists in the group's namespace), so the
    presence check passes, and `group["shape"]` then raises `KeyError` when the link is
    resolved. MEASURED pre-fix: that `KeyError` escaped as a raw traceback at exit 1. Post-fix
    the refusal names `/matrix/shape` and says it cannot be read.
    """
    bundle = _copy(tmp_path, "shape-external-link")
    _rewrite_shape(bundle, h5py.ExternalLink("does-not-exist.h5", "/whatever"))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"cannot be read" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_the_arity_refusal_is_unchanged(tmp_path):
    r"""TEST-452 [acceptance INV-1] — the existing `len(shape) != 2` arity refusal is a
    SEPARATE leg and must stay exactly as it was.

    A one-element `/matrix/shape` still produces the pre-existing message
    `declares `/matrix/shape` = [...]`, which is not a (features, cells) pair` — the guard
    added here must not have moved it.
    """
    bundle = _copy(tmp_path, "shape-arity")
    _rewrite_shape(bundle, np.array([13780], dtype=np.int32))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"which is not a (features, cells) pair" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_shape_dataset_past_the_pre_read_size_bound_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — a `/matrix/shape` dataset past the pre-read ELEMENT
    bound is refused BY NAME before `[:]` is ever evaluated.

    The read site refuses a shape dataset whose DECLARED element count exceeds
    `_MAX_SHAPE_ELEMENTS` from `shape_ds.size` alone — h5 metadata that reads no data — so a
    hostile many-element shape dataset is refused without the OOM-SIGKILL that `shape_ds[:]` +
    `.tolist()` used to cause (the same class #456 exists to prevent, one field over). The
    dataset is `S1` — 1025 elements, 1025 bytes — so the BYTE bound (`_MAX_SHAPE_BYTES = 4096`)
    does NOT fire and the ELEMENT bound is the one under test: deleting the element cap makes
    this test go red (the dataset would then reach the dtype refusal with a different message).
    The refusal names `/matrix/shape`, states the element count, and fires before the first
    writer, so nothing lands on disk.

    The dataset is created SPARSELY (`create_dataset(shape=(cap + 1,), fillvalue=0)` with
    chunking): h5py writes only the dataset header and allocates no chunk, so no dense buffer
    is ever allocated and the staged h5 stays tiny — the refusal is asserted, never a duration.

    HONEST LIMIT, stated the way the numeric-skip leg declares its vacuity: this test proves a
    MESSAGE, not a bound. With the element guard deleted the import still refuses safely — the
    dataset (1025 bytes) passes the BYTE bound, so `shape_ds[:]` is read and the empty `S1`
    elements reach the dtype refusal with a DIFFERENT message — so this test goes red because
    the WORDING differs, not because anything was unbounded. That is exactly why the mutation
    ladder could not catch the unit bug in this guard: the guard's absence is invisible to this
    leg. What actually pins the bound's existence is the BYTE-bound sibling test, whose
    `S1073741824` dataset would be a 2 GiB read without the guard.
    """
    module = XF.load_compute()
    cap = module._MAX_SHAPE_ELEMENTS
    assert cap == 1024, cap
    bundle = _copy(tmp_path, "shape-over-bound")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
        handle["matrix"].create_dataset("shape", shape=(cap + 1,), dtype="S1",
                                        fillvalue=b"", chunks=(256,))
    h5_size = (bundle / MATRIX).stat().st_size
    assert h5_size < 1 << 20, (
        f"the sparse shape dataset inflated the fixture to {h5_size:,} bytes"
    )
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert f"{cap + 1} elements".encode("utf-8") in row, row[:400]
    assert b"two integers" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_shape_dataset_past_the_pre_read_BYTE_bound_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — a `/matrix/shape` dataset past the pre-read BYTE
    bound is refused BY NAME before `[:]` is ever evaluated.

    The read's cost is `size x itemsize`, so an element cap alone does not bound it: a
    `/matrix/shape` of `shape=(2,), dtype="S1073741824"` is TWO elements — it passes ANY element
    cap — yet `shape_ds[:]` would materialise 2 GiB. The read site therefore also checks
    `shape_ds.nbytes` against `_MAX_SHAPE_BYTES = 4096` (h5 metadata, no data read). This is the
    case an element-only bound MISSED: TWO elements pass ANY element cap, so pre-fix this bundle
    reached `shape_ds[:]` and the 2 GiB read — an OOM SIGKILL under Linux overcommit, not a
    clean `MemoryError`. Post-fix it is a NAMED refusal at rc 2, no `Traceback`, naming
    `/matrix/shape` and stating the byte count, before the first writer — nothing lands on disk.

    The dataset is created SPARSELY (`create_dataset(shape=(2,), dtype="S1073741824",
    chunks=(1,))`): h5py writes only the dataset header and allocates no chunk, so the staged
    h5 stays tiny — the file-size leg is the proof the 2 GiB was never written (a dense
    dataset would be ~2 GiB on disk).
    """
    module = XF.load_compute()
    assert module._MAX_SHAPE_BYTES == 4096, module._MAX_SHAPE_BYTES
    bundle = _copy(tmp_path, "shape-over-byte-bound")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
        handle["matrix"].create_dataset("shape", shape=(2,), dtype="S1073741824", chunks=(1,))
    h5_size = (bundle / MATRIX).stat().st_size
    assert h5_size < 1 << 20, (
        f"the sparse shape dataset inflated the fixture to {h5_size:,} bytes; "
        "a dense (2,)-element S1073741824 array would be ~2 GiB"
    )
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"2147483648 bytes" in row, row[:400]
    assert b"two integers" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_vlen_shape_dtype_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — a VLEN `/matrix/shape` is refused BY NAME on its
    DTYPE, before `[:]` is ever evaluated.

    `Dataset.nbytes` is `dtype.itemsize * size`, and for a vlen dtype `itemsize` is 8 — the size
    of a POINTER, not the payload — so a two-element vlen shape dataset reports `nbytes == 16`
    and passes ANY byte cap while `[:]` still materialises the attacker-chosen payloads, and the
    element cap does not save it because the per-element size is attacker-chosen. The gate is on
    the DTYPE, so a few MB per element is enough to prove it fires — the elements are never read.
    The refusal says the dtype is not the two integers (not that it is "too large"), names
    `/matrix/shape`, and leaves nothing on disk. The staged h5 stays at the few-MB scale of the
    payloads it carries — the point is that it is NOT the 2 GiB the old unguarded read would
    have materialised.
    """
    bundle = _copy(tmp_path, "shape-vlen")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix/shape"]
        handle["matrix"].create_dataset(
            "shape", shape=(2,), dtype=h5py.vlen_dtype(bytes),
            data=[b"x" * (4 << 20), b"y" * (4 << 20)],
        )
    h5_size = (bundle / MATRIX).stat().st_size
    assert h5_size < 64 << 20, (
        f"the vlen shape dataset inflated the fixture to {h5_size:,} bytes"
    )
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix/shape`" in row, row[:400]
    assert b"variable-length" in row, row[:400]
    assert b"two integers" in row, row[:400]
    _assert_nothing_on_disk(out)


@pytest.mark.parametrize("member,label", [
    ("barcodes", "/matrix/barcodes"),
    ("features/id", "/matrix/features/id"),
])
def test_452_a_dangling_external_link_member_is_refused_by_name(tmp_path, member, label):
    r"""TEST-452 [acceptance INV-1/INV-2] — a DANGLING EXTERNAL LINK at a `_decoded_strings`
    member is a NAMED refusal, never a traceback.

    `"barcodes" in group` is True for a link (the name exists in the group's namespace), so the
    presence check passes, and `group["barcodes"]` then raises `KeyError` when the link is
    resolved. MEASURED pre-fix: that `KeyError` escaped as a raw traceback at exit 1 — the same
    hole the shape read's guard already closes, four fields over. Post-fix the refusal names the
    member and says it cannot be read, at rc 2 with no `Traceback` on stderr, and nothing lands
    on disk.
    """
    bundle = _copy(tmp_path, f"member-link-{member.replace('/', '-')}")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        group = handle["matrix"]
        if "/" in member:
            parent, leaf = member.split("/", 1)
            del group[parent][leaf]
            group[parent][leaf] = h5py.ExternalLink("does-not-exist.h5", "/x")
        else:
            del group[member]
            group[member] = h5py.ExternalLink("does-not-exist.h5", "/x")
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert f"`{label}`".encode("utf-8") in row, row[:400]
    assert b"cannot be read" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_452_a_dangling_external_link_at_matrix_is_refused_by_name(tmp_path):
    r"""TEST-452 [acceptance INV-1/INV-2] — `/matrix` itself is a DANGLING EXTERNAL LINK.

    `"matrix" in h5` is True for a link (the name exists in the file's namespace), so the
    presence check passes, and `h5["matrix"]` then raises `KeyError` when the link is resolved.
    MEASURED pre-fix: that `KeyError` escaped as a raw traceback at exit 1 — #452's exact class
    at the FIRST dereference of this function, the parent of the members the existing link test
    guards. Post-fix the refusal names `/matrix` and says it cannot be read, at rc 2 with no
    `Traceback` on stderr, and nothing lands on disk.
    """
    bundle = _copy(tmp_path, "matrix-external-link")
    with h5py.File(bundle / MATRIX, "r+") as handle:
        del handle["matrix"]
        handle["matrix"] = h5py.ExternalLink("does-not-exist.h5", "/x")
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"`/matrix`" in row, row[:400]
    assert b"cannot be read" in row, row[:400]
    _assert_nothing_on_disk(out)


# ── #456: the bounded root-attribute walk ──────────────────────────────────────────────


def test_456_a_large_NUMERIC_root_attribute_is_skipped(tmp_path):
    r"""TEST-456 [acceptance INV-5] — a large NUMERIC root attribute is LEGAL.

    An ACCEPTANCE / LEGAL-OUTCOME test, declared as such: a large numeric root attribute must
    still IMPORT (rc 0, a manifest on disk). It asserts only the OUTCOME, and that outcome is
    identical with and without the #456 fix — the fix changes the WORK done (skip by dtype vs.
    walking 1M elements), not the outcome — so this test would PASS with the fix reverted. A
    declared vacuous test is fine; an undeclared one is a lie.

    LESS VACUOUS THAN DECLARED, and the docstring says so: the attribute is `cap + 1` `int64`
    elements — 8 MiB — so it is ALSO past the byte cap. Deleting only the dtype deny-list
    (keeping the byte cap) turns this test red: the walker would then hit the size bound and
    REFUSE instead of skip. So this leg pins the ORDERING of the two checks — the dtype skip
    must run BEFORE the size bound, or a large numeric array is refused rather than skipped —
    not merely the legal outcome. The DISCRIMINATING test for the skip itself is
    `test_456_the_walk_does_not_materialise_a_numeric_array_attribute` (the `.tolist()` spy);
    that is the real guard. This leg exists to pin the legal outcome, the ordering, and the
    fixture's `cap == 1 << 20` (the attribute is `cap + 1` elements), not to prove the skip.
    """
    module = XF.load_compute()
    cap = module._MAX_WALKED_ATTRIBUTE_BYTES
    assert cap == 1 << 20, cap
    bundle = _rebuild_with_attr(tmp_path, "numeric-skip", "big_numeric",
                                np.zeros(cap + 1, dtype=np.int64))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert (out / "manifest.json").is_file(), "a legal import must write the manifest"


def test_456_a_small_legitimate_NON_numeric_root_attribute_still_imports(tmp_path):
    r"""TEST-456 [acceptance INV-5] — the over-refusal leg: a small, legitimate, NON-numeric
    root attribute must still IMPORT.

    The refusal tests are all cap-relative (`np.zeros(cap + 1, ...)`), so they adapt to any
    cap and cannot see a wrong one; only the constant pins catch a too-tight bound. This leg
    is BEHAVIOURAL: a root attribute of the kind a real vendor writes — a short `|S` string
    array carrying the committed fixtures' own `protein_metric` value — must import cleanly
    (rc 0, a manifest on disk) and must NOT be refused. The array is sized past any absurdly
    tight bound while staying tiny against the design cap, so a bound set below the size of a
    legitimate attribute refuses this import and this test goes red. It deliberately never
    names the constant: it tests the behaviour, not the value.
    """
    bundle = _rebuild_with_attr(tmp_path, "small-text-ok", "vendor_text",
                                np.array([b"MEAN_PER_CELL_STAIN"] * 128, dtype="|S19"))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert (out / "manifest.json").is_file(), "a legal import must write the manifest"


def test_456_a_large_NON_numeric_root_attribute_is_refused_by_name(tmp_path):
    r"""TEST-456 [acceptance INV-1/INV-2] — a large NON-numeric (`S`) root attribute just over
    the 1 MiB cap is refused BY NAME, and nothing lands on disk.

    The refusal names the attribute and states the byte count — the two facts an operator
    needs — and fires before the first writer, so the outputs tree stays empty.
    """
    module = XF.load_compute()
    cap = module._MAX_WALKED_ATTRIBUTE_BYTES
    assert cap == 1 << 20, cap
    bundle = _rebuild_with_attr(tmp_path, "over-bound", "vendor_bulk",
                                np.zeros(cap + 1, dtype="S1"))
    out = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, out)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"vendor_bulk" in row, row[:400]
    assert f"{cap + 1} bytes".encode("utf-8") in row, row[:400]
    assert b"past the" in row, row[:400]
    _assert_nothing_on_disk(out)


def test_456_the_walk_does_not_materialise_a_numeric_array_attribute():
    r"""TEST-456 [acceptance INV-5] — the dtype deny-list means `.tolist()` is never called on
    a numeric array.

    Asserted by OBSERVING WHETHER `.tolist()` IS CALLED, not by timing: a wall-clock assertion
    on a shared machine is a flake, and the property under test is not "it is fast", it is "the
    numeric arm is never entered". A `np.ndarray` subclass is the only way to see that from
    outside, since the call is `node.tolist()`.
    """
    module = XF.load_compute()

    class _Spy(np.ndarray):
        calls = 0

        def tolist(self):
            type(self).calls += 1
            return super().tolist()

    for dtype in (np.int64, np.float64, np.bool_):
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


def test_456_datetime_and_timedelta_arrays_are_skipped_by_the_deny_list():
    r"""TEST-456 [acceptance INV-5] — the `M`/`m` half of the dtype deny-list is exercised.

    The deny-list is `"biufcMm"`: bool, signed and unsigned int, float, complex, datetime64,
    timedelta64. No other test constructs a `datetime64` or `timedelta64` array, so dropping
    `M`/`m` from the deny-list would go completely unnoticed. This test uses the same
    `.tolist()`-counting `np.ndarray` subclass spy as
    `test_456_the_walk_does_not_materialise_a_numeric_array_attribute`: a datetime64 or
    timedelta64 array cannot carry text, so the walk must skip it WITHOUT `.tolist()` ever
    being called. The arrays are small (8 elements), so the size bound cannot be standing in
    for the deny-list.
    """
    module = XF.load_compute()

    class _Spy(np.ndarray):
        calls = 0

        def tolist(self):
            type(self).calls += 1
            return super().tolist()

    for dtype in (np.datetime64, np.timedelta64):
        _Spy.calls = 0
        arr = np.zeros(8, dtype=dtype).view(_Spy)
        assert module.unencodable_vendor_text({"a": arr}) is None
        assert _Spy.calls == 0, f"{dtype} was materialised by the walk"


def test_456_an_over_bound_array_is_refused_by_name():
    r"""TEST-456 [acceptance INV-5] — the walker refuses an array past the cap BY NAME, stating
    the byte count, and an array AT the cap is still walked (the bound cannot be standing in for
    the guard).
    """
    module = XF.load_compute()
    cap = module._MAX_WALKED_ATTRIBUTE_BYTES
    assert cap == 1 << 20, cap

    over = np.zeros(cap + 1, dtype="S1")
    with pytest.raises(module.XeniumImportError) as caught:
        module.unencodable_vendor_text({"vendor_bulk": over})
    msg = str(caught.value)
    assert "vendor_bulk" in msg, msg
    assert f"{cap + 1} bytes" in msg, msg
    assert msg.isascii(), msg

    # THE CONTROL, on both sides of the cap: an attribute AT the cap is still walked and still
    # finds the bad entry, so the bound cannot be standing in for the guard.
    under = np.array([b"ok"] * 8 + [b"\xff\xfeBAD"], dtype="|S8")
    assert under.nbytes <= cap
    hit = module.unencodable_vendor_text({"vendor_bulk": under})
    assert hit is not None and hit[1] == b"\xff\xfeBAD", hit


def test_456_a_np_void_scalar_is_walked():
    r"""TEST-456 [acceptance INV-5] — a SCALAR of the compound/opaque dtype is walked, not
    silently skipped.

    `np.void` is not an `ndarray`, so without its own arm it fell through to `return None` and
    was invisible — the scalar twin of the compound/opaque dtype hole. `.tolist()` gives `bytes`
    for an opaque, which the `bytes` arm then checks.
    """
    module = XF.load_compute()
    hit = module.unencodable_vendor_text({"a": np.void(b"\xff\xfeBAD")})
    assert hit is not None and hit[1] == b"\xff\xfeBAD", hit


def test_456_a_large_np_void_scalar_is_refused_by_name():
    r"""TEST-456 [acceptance INV-1/INV-2] — a large OPAQUE scalar root attribute is refused BY
    NAME, not materialised.

    The `np.void` arm carries the same size bound as the `ndarray` arm: an opaque scalar is
    capped at 64 KiB only under default libver — under `latest` dense attribute storage lifts
    that cap, so a large opaque scalar is reachable and `.tolist()` would materialise it.
    `node.nbytes` is the payload size, so the same cap applies.
    """
    module = XF.load_compute()
    cap = module._MAX_WALKED_ATTRIBUTE_BYTES
    assert cap == 1 << 20, cap
    big = np.void(b"x" * (cap + 1))
    with pytest.raises(module.XeniumImportError) as caught:
        module.unencodable_vendor_text({"vendor_bulk": big})
    msg = str(caught.value)
    assert "vendor_bulk" in msg, msg
    assert f"{cap + 1} bytes" in msg, msg
    assert msg.isascii(), msg
