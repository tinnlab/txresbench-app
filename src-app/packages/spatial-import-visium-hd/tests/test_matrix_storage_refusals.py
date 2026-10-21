#!/usr/bin/env python3
# ruff: noqa
"""TEST-52..71 — `/matrix` members that depend on files outside the bundle are REFUSED BY NAME.

**INV-8** — the refusal fires BEFORE any artifact byte is written, so a refused import
leaves no store, no partial store and nothing for a later reader to find.

**INV-9** — a bundle this importer cannot carry is REFUSED BY NAME — `VisiumImportError` —
never a traceback and never an exit-1.

The bundles live in `hd_hostile_bundles.REFUSALS`, so the generic sweeps (TEST-8 in
`test_zero_partial_store.py`, TEST-9 in `test_refusals.py`) already cover them. What those
sweeps cannot assert is that the refusal names the RIGHT member and the RIGHT storage kind:
a refusal that said only "the matrix is invalid" would pass every byte-level property in
TEST-9 while telling the operator nothing. So each case is asserted here BY CONTENT, on the
bytes that actually reach stderr — the backticked member path, the storage-kind sentence,
rc 2, no traceback, and an empty outputs tree — and the positive control proves the module
refuses these and not everything.

The cases are the MEASURED pre-fix behaviours recorded in the builders' docstrings:
a VIRTUAL dataset over a missing source imported at rc 0 with a WRONG matrix (h5py
silently fills), and EXTERNAL raw storage over a missing `.bin` died inside `_lib` with a
raw traceback and (for `data`) a five-path partial store. `ds.is_virtual` is False for
external storage, so the refusal needs BOTH predicates — which is why the external cases
are asserted as their own tests rather than folded into the virtual ones.

TEST-57..62 pin the member loop's own doors, which FIX_ROUND-1 closed: a missing member,
a broken ExternalLink/SoftLink, an ExternalLink to an EXISTING file outside the bundle
(both as a member and as `/matrix` itself), and a member that is a GROUP (the isinstance
leg, which a mutation ladder proved had zero coverage).

TEST-63..67 pin the STRUCTURAL net FIX_ROUND-2 added beneath the member loop: a SoftLink
CHAIN on `/matrix/data` and on `/matrix` itself, a non-CSC member (`/matrix/barcodes`) as
an ExternalLink to an outside file holding the bundle's own barcodes REVERSED, a nested
member (`/matrix/features/id`) as an ExternalLink, and TEST-67, which CHARACTERISED issue
#461's still-OPEN case — a same-file SoftLink that resolves INSIDE the bundle imported at
rc 0 with a wrong matrix. #507 supersedes #461 with the two-predicate fix (no
`h5py.ExternalLink` anywhere under `/matrix`, and the seven consumed members must be seven
DISTINCT objects), and TEST-67 is now FLIPPED to assert the refusal.

TEST-72..77 pin the #507 fix's two predicates: an ExternalLink pointing BACK into the
bundle's own file is refused wherever it points (M1, M3, M5), and a hard link or a
same-file SoftLink chain that makes two consumed members resolve to ONE object is refused
as "are the SAME object" (M2, M4, M6). TEST-78 is the positive control: an ORDINARY extra
same-file hard link under a name the importer does NOT consume still imports at rc 0,
proving the alias check is scoped to the seven consumed members only. TEST-79 pins the
same alias check against a detour that leaves `/matrix` entirely: a SoftLink on
`/matrix/data` through a top-level `/other_group` ExternalLink back onto `/matrix/indices`
— a chain the structural walk never visits, which the alias check still catches as the
SAME object.

TEST-70..71 pin FIX_ROUND-3a2: HDF5's OWN link-traversal limit escaped the member loop's
guarded read as a raw `RuntimeError` traceback (a DEEP SAME-FILE SoftLink chain, which the
walk's realpath leg cannot refuse), and the walk's coverage of `/matrix/shape` itself (an
ExternalLink to an outside file holding the SAME dimensions, which the earlier shape
cross-check cannot catch).

TEST-81 pins #536: an ABSENT `/matrix/features` is refused as "has no `/matrix/features`
group" — the precise message from the later guarded resolution — rather than folded into
the alias check's "cannot be read". `_refuse_aliased_matrix_members` now treats a
`KeyError` on `group["features"]` as ABSENCE and skips the two `features/*` members,
matching `_matrix_member_identity`'s own convention.

TEST-88..91 pin #539: a `/matrix/features` that RESOLVES to a Dataset instead of a Group —
a plain inline Dataset, a same-file SoftLink to `/matrix/barcodes`, a HARD LINK to
`/matrix/barcodes`, or a COMPOUND-dtype Dataset — is refused BY NAME as "is not a group"
(rc 2, no traceback, zero paths) instead of escaping as a raw `ValueError`/`AttributeError`
traceback at rc 1. TEST-91 is the DISCRIMINATION proof: the compound-dtype spelling is the
one a tuple-widening "fix" (adding `ValueError` to `_matrix_member_identity`'s tuple) leaves
crashing, so it is the canary for the explicit type refusal. TEST-92 pins the sentence
verbatim; TEST-93 is the positive control (a real features GROUP still imports). TEST-94
is the OVER-REFUSAL control: a same-file SoftLink at `/matrix/features` that RESOLVES to a
legitimate features GROUP still imports at rc 0 — the check judges the resolved object, so a
check written on the LINK (refusing any SoftLink there) would be exactly the over-refusal
this control catches. The four
spellings are ONE diagnosis and are allowed to share it in `test_refusals.py`'s
`SHARED_DIAGNOSIS_ALLOWED`, and the four REFUSALS rows they feed join TEST-8/TEST-9's
whole-table sweep.

TEST-95..99 + TEST-101 pin #585, the SAME class one level up: `/matrix` itself resolving to
a Dataset — the boundary `#539` deliberately left open (the unguarded `if member not in
group:` membership test died with a raw `ValueError`
traceback at rc 1 for the 2-D spellings). TEST-95/96/97 are the reach paths (plain inline
2-D Dataset, same-file SoftLink to a Dataset, HARD LINK to a Dataset); TEST-98 is the
MESSAGE-COHERENCE canary — the 1-D spelling, which on the base did NOT crash but was
refused with the FALSE "has no `/matrix/data`" diagnosis, so a catch/tuple-based
alternative fix cannot see it and only the source `isinstance(group, h5py.Group)` puts it
on the true diagnosis. TEST-99 pins the sentence verbatim (with the member-loop's own
false-first-sentence and the generic templates asserted ABSENT — note the TRUE message
itself names "has no `/matrix/data`" as one of the absent members, so the discriminating
marker is the false message's own first sentence, not the bare substring); the GOOD-bundle
positive control is TEST-93 (pre-existing, re-cited above); TEST-101 is the OVER-REFUSAL
control (a same-file SoftLink at `/matrix` that RESOLVES to a legitimate
matrix GROUP still imports at rc 0 — the check judges the resolved object, so a check
written on the LINK would refuse it). The four `matrix-root-*` spellings are ONE diagnosis
and are allowed to share it in `test_refusals.py`'s `SHARED_DIAGNOSIS_ALLOWED`, and the
four REFUSALS rows they feed join TEST-8/TEST-9's whole-table sweep.

TEST-103..110 pin #587, the SIBLING leg of the same boundary: a `/matrix` LINK whose
target does not resolve — the guarded-subscript leg the sibling closes first, which
`group = h5["matrix"]` (outside every try, after the `H5Lexists` presence test and the
ExternalLink leg) let escape as a raw `KeyError` at rc 1. TEST-103 (dangling same-file
SoftLink) and TEST-104 (SoftLink chain ending nowhere) are the two reach paths; TEST-105
pins the EXISTING "is an ExternalLink" sentence for the ExternalLink-to-a-MISSING-file
spelling (measured: already refused at rc 2 — the pin, not a second message); TEST-106 is
the BEHAVIORAL ordering canary (the #585 Dataset-at-`/matrix` bundle must still yield the
is-not-a-group sentence, never the "cannot be read" wrap — `VisiumImportError` IS a
`RuntimeError` subclass, so a widened try or a lost re-raise would swallow the #585
refusal into the new tuple and lie); TEST-107 is the STRUCTURAL ordering canary (`ast` at
the `group = h5["matrix"]` site: minimal try, `except VisiumImportError: raise` first, the
`(KeyError, OSError, TypeError, RuntimeError)` tuple second, the isinstance refusal
OUTSIDE — reddens under BOTH the re-raise-deletion and the try-widening mutations, the
latter's behavioral twin being TEST-106, the former being otherwise invisible); TEST-108
pins the new sentence verbatim; TEST-109 is the over-refusal control for the CHAIN
spelling (a same-file SoftLink chain resolving to a legitimate matrix GROUP still imports
at rc 0). The three new `matrix-root-*` REFUSALS rows feed TEST-8/TEST-9's whole-table
sweep, sharing two diagnoses by design (the two SoftLink rows; the missing-target
ExternalLink with `matrix-external-link-group` — both allowed by name in
`SHARED_DIAGNOSIS_ALLOWED`). RE-CITED by this node (added clauses in their docstrings):
TEST-56 (the good-bundle driver), TEST-61 (the existing `/matrix` ExternalLink pin),
TEST-81 (the #536 absent-features message), TEST-93 (the standing good-bundle control),
TEST-100 (the #585 good-bundle positive control), TEST-101 (the #585 SoftLink-to-GROUP
over-refusal control) and TEST-102 (the #585 hard-link-to-GROUP over-refusal control) —
each is an INV-5 no-over-refusal / no-break control for the #587 leg, and the hard-link
control records that a hard link cannot dangle so it is outside #587's reach.

TEST-110..112 pin #648, the sibling #471 class ported to this module: the ROOT-ATTRIBUTE
read `attrs = dict(h5.attrs)` — the LAST UNGUARDED ATTRIBUTE-MATERIALISATION read in the
matrix block, and the one read of the file's ROOT OBJECT with no guard at all — is now a
named refusal (rc 2, no traceback, zero paths). Residual same-class doors, pre-existing and
OUT of #648's attribute-read scope (recorded in this run's LEDGER B-1 + GH comment, NOT
closed here): the `/matrix/shape` and `/matrix/indptr` guards omit OSError/OverflowError and
the indices data read at `np.asarray(ind_ds[...])` is bare — the same INV-1 class on DATASET
reads. TEST-110 asserts the corrupt-root-attribute
bundle through the shipped entrypoint (with the raw-read re-proof and the byte-change
proof); TEST-111 is the positive control (the UNMUTATED committed fixture still imports at
rc 0 with a real manifest); TEST-112 is the structural AST canary on the new guarded try
(minimal try, `except VisiumImportError: raise` first, the six-name tuple second with the
ValueError/OverflowError rationale, `refuse_unencodable_vendor_text` a sibling AFTER the
try — the A12 load-bearing leg, because deleting the re-raise is behaviorally invisible).
The new `matrix-corrupt-root-attribute` REFUSALS row feeds TEST-8/TEST-9's whole-table
sweep untouched.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import hd_hostile_bundles as HB  # noqa: E402

#: The prefix `main()` prints. Named so an assertion that "the line identifies the
#: analysis" cannot pass on a line that merely contains the word "visium".
PREFIX = b"spatial.import-visium-hd: "


def _staged(tmp_path, bundle):
    """Mount one bundle as the `bundle` slot and return its `/inputs` dir."""
    inputs = tmp_path / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    staged = inputs / Path(bundle).name
    staged.symlink_to(Path(bundle).resolve(), target_is_directory=True)
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": f"/inputs/{staged.name}"}]
    }), encoding="utf-8")
    return inputs


def _refusal_line(stderr_bytes):
    """The ONE non-progress stderr line, as bytes.

    `progress()` writes `progress: …` to stderr on every phase, so a naive "stderr is one
    line" assertion would be about the progress channel rather than about the refusal.
    """
    lines = [ln for ln in stderr_bytes.split(b"\n")
             if ln and not ln.startswith(b"progress: ")]
    assert len(lines) == 1, (
        f"expected exactly one non-progress stderr line, got {len(lines)}: {lines!r}")
    return lines[0]


def _run_refusal(tmp_path, case_id):
    """Drive one registered hostile bundle through the shipped entrypoint.

    Asserts the INV-8/INV-9 floor the generic sweeps assert — rc 2, no traceback, empty
    outputs tree — and returns the refusal line for the content assertions below.
    """
    case = next(row for row in HB.REFUSALS if row[0] == case_id)
    _case_id, build, requested, _what = case
    bundle = build(tmp_path / case_id)
    inputs = _staged(tmp_path, bundle)
    params = {} if requested is None else {"bin_um": requested}

    result = HF.run_entry_bytes(inputs, tmp_path / "out", params=params)

    assert result.returncode == 2, (
        f"{case_id!r} exited {result.returncode}, not 2 — a refusal that escapes "
        f"`main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"{case_id!r} produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the {case_id!r} refusal left paths under /outputs — INV-8's promise is that a "
        "refused import leaves NO store and no partial store")
    return _refusal_line(result.stderr)


def test_TEST_52_a_VIRTUAL_indices_is_refused_BY_NAME(tmp_path):
    """TEST-52 [acceptance, INV-8 + INV-9] — V1: `/matrix/indices` as a VDS over a missing source.

    Pre-fix this imported at rc 0 with every count attributed to gene 0 (the builder's
    docstring records the measurement). The refusal must name the member and the storage
    kind, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "indices-virtual-missing-source")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/indices`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is a VIRTUAL dataset" in line, (
        f"the refusal does not name the storage kind: {line!r}")


def test_TEST_53_a_VIRTUAL_data_is_refused_BY_NAME(tmp_path):
    """TEST-53 [acceptance, INV-8 + INV-9] — V2: `/matrix/data` as a VDS over a missing source.

    Pre-fix this imported at rc 0 with `data` all zero (sum 0.0), structure intact. The
    refusal must name the member and the storage kind, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "data-virtual-missing-source")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is a VIRTUAL dataset" in line, (
        f"the refusal does not name the storage kind: {line!r}")


def test_TEST_54_EXTERNAL_indices_are_refused_BY_NAME(tmp_path):
    """TEST-54 [acceptance, INV-8 + INV-9] — E1: `/matrix/indices` with EXTERNAL raw storage.

    Pre-fix this was a raw `OSError` traceback at rc 1 with zero output paths. `is_virtual`
    is False for external storage, so this is the case that proves the `.external`
    predicate is what sees it.
    """
    line = _run_refusal(tmp_path, "indices-external-missing-bin")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/indices`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is a dataset with EXTERNAL raw storage" in line, (
        f"the refusal does not name the storage kind: {line!r}")


def test_TEST_55_EXTERNAL_data_is_refused_BY_NAME(tmp_path):
    """TEST-55 [acceptance, INV-8 + INV-9] — E2: `/matrix/data` with EXTERNAL raw storage.

    Pre-fix this was a raw `OSError` traceback out of `_lib/cyto_csc.py` at rc 1 with a
    FIVE-PATH PARTIAL STORE on disk — INV-8 and INV-9 broken together. The refusal
    converts that into a named refusal with an empty outputs tree.
    """
    line = _run_refusal(tmp_path, "data-external-missing-bin")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is a dataset with EXTERNAL raw storage" in line, (
        f"the refusal does not name the storage kind: {line!r}")


def test_TEST_56_the_positive_control_a_GOOD_bundle_still_imports(tmp_path):
    """TEST-56 [acceptance] — without this, "refuses these four" is "refuses everything".

    The same driver, the same staging, the committed fixture: rc 0, no refusal line, and a
    manifest on disk. A module that refused every bundle would pass all four tests above.
    TEST-56 is also the #585 good-bundle positive control: the fixture's `/matrix` is a
    real GROUP and imports at rc 0, so a #585 over-refusal of the non-Group boundary
    would redden this test. RE-CITED by the #587 node: the same driver is the #587
    good-bundle control (the guarded subscript must not refuse the fixture's real
    `/matrix` GROUP), so a #587 over-refusal would redden it too.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the control run wrote no manifest.json — the refusal assertions above prove "
        "nothing if the good bundle does not import")


def test_TEST_57_a_MISSING_data_member_is_refused_BY_NAME(tmp_path):
    """TEST-57 [acceptance, INV-8 + INV-9] — `/matrix/data` deleted.

    Pre-fix this was a raw `KeyError` traceback at rc 1 with zero output paths — the
    unguarded `group[member]` ran before the guarded reads that used to name it. The
    refusal must say the member is ABSENT, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-missing-data")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"has no `/matrix/data`" in line, (
        f"the refusal does not say the member is MISSING: {line!r}")


def test_TEST_58_a_BROKEN_ExternalLink_member_is_refused_BY_NAME(tmp_path):
    """TEST-58 [acceptance, INV-8 + INV-9] — `/matrix/indices` as a broken ExternalLink.

    Pre-fix this was a raw `KeyError` traceback at rc 1 with zero output paths. The
    refusal must say the member cannot be READ, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-broken-external-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/indices`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"cannot be read" in line, (
        f"the refusal does not say the member cannot be read: {line!r}")


def test_TEST_59_a_BROKEN_SoftLink_member_is_refused_BY_NAME(tmp_path):
    """TEST-59 [acceptance, INV-8 + INV-9] — `/matrix/data` as a broken SoftLink.

    Pre-fix this was a raw `KeyError` traceback at rc 1 with zero output paths. The
    refusal must say the member cannot be READ, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-broken-soft-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"cannot be read" in line, (
        f"the refusal does not say the member cannot be read: {line!r}")


def test_TEST_60_an_ExternalLink_member_to_an_OUTSIDE_file_is_refused_BY_NAME(tmp_path):
    """TEST-60 [acceptance, INV-8 + INV-9] — `/matrix/data` as an ExternalLink to an EXISTING file.

    Pre-fix this imported at rc 0 with 120 output paths — a full store built from the
    outside file's all-7s values, because `group[member]` follows the link transparently
    and the resolved dataset passed the inline check. The refusal must name the member and
    the link class, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-member")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_61_a_MATRIX_group_that_is_an_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-61 [acceptance, INV-8 + INV-9] — `/matrix` itself as an ExternalLink.

    Pre-fix this imported at rc 0 with 120 output paths — `h5["matrix"]` resolves the link
    transparently and the member loop never sees it. The refusal must name `/matrix` and
    the link class, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-group")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the group it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")
    assert b"link exists but its target cannot be read" not in line, (
        f"the #587 guarded-subscript leg swallowed the ExternalLink diagnosis (#450): "
        f"{line!r}")


def test_TEST_62_a_GROUP_member_is_refused_as_NOT_A_DATASET(tmp_path):
    """TEST-62 [acceptance, INV-8 + INV-9] — `/matrix/indptr` replaced by a GROUP.

    The isinstance leg had ZERO coverage: a mutation ladder proved deleting it changed
    nothing, because a Group member was still refused by the LATER size guard with a
    different message. This test pins the "is not a dataset" marker so deleting the leg
    reddens a named test.
    """
    line = _run_refusal(tmp_path, "matrix-member-is-group")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/indptr`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a dataset" in line, (
        f"the refusal does not use the isinstance marker: {line!r}")


def test_TEST_63_a_SoftLink_CHAIN_data_member_is_refused_BY_NAME(tmp_path):
    """TEST-63 [acceptance, INV-8 + INV-9] — `/matrix/data` -> SoftLink -> ExternalLink.

    Pre-fix this imported at rc 0 with 120 output paths and a store whose `data` is all
    7.0 (sum 4389 = 627 x 7) -- the counts came from the outside file, because
    `group.get(member, getlink=True)` inspects only the member's OWN link while
    `group[member]` resolves the WHOLE chain. The structural walk's realpath comparison
    must name the member and the file it resolves to, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-softlink-chain-data")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/data" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"not this bundle's own matrix file" in line, (
        f"the refusal does not name the realpath defect: {line!r}")


def test_TEST_64_a_SoftLink_CHAIN_matrix_group_is_refused_BY_NAME(tmp_path):
    """TEST-64 [acceptance, INV-8 + INV-9] — `/matrix` -> SoftLink -> ExternalLink.

    Pre-fix this imported at rc 0 with 120 output paths and a full store built from the
    outside matrix's all-7s values -- the ENTIRE matrix group came from outside the
    bundle, because `h5.get("matrix", getlink=True)` catches only a DIRECT ExternalLink.
    The structural walk's top-level realpath comparison must name `/matrix` and the file
    it resolves to, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-softlink-chain-group")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix" in line, (
        f"the refusal does not name the group it refused: {line!r}")
    assert b"not this bundle's own matrix file" in line, (
        f"the refusal does not name the realpath defect: {line!r}")


def test_TEST_65_a_BARCODES_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-65 [acceptance, INV-8 + INV-9] — `/matrix/barcodes` as an ExternalLink.

    THE MOST IMPORTANT ROW: pre-fix this imported at rc 0 with 120 output paths and a
    store whose barcode axis was REVERSED while the counts columns stayed in the bundle's
    original order -- a silently MISLABELED matrix, because the member loop enumerates
    only the CSC triple and the join passes (same SET). The structural walk must name
    `/matrix/barcodes` and the link class, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-barcodes")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/barcodes" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_66_a_FEATURES_ID_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-66 [acceptance, INV-8 + INV-9] — `/matrix/features/id` as an ExternalLink.

    A NESTED member under `/matrix/features`, which the member loop's CSC-triple
    enumeration cannot see. Pre-fix this imported at rc 0 with 120 output paths. The
    structural walk must name `/matrix/features/id` and the link class, and must leave
    nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-features-id")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/features/id" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_67_the_SAME_FILE_alias_461_507_is_now_REFUSED(tmp_path):
    """TEST-67 [acceptance, INV-8 + INV-9] — FLIPPED: #461/#507's same-file SoftLink is now REFUSED.

    Issue #461's case: `/matrix/data` -> SoftLink("/matrix/indices") resolves INSIDE this
    bundle's own matrix file, so the structural walk's realpath test passes it and the
    import used to SUCCEED at rc 0 with a WRONG expression matrix -- the exact user-visible
    outcome #450 exists to eliminate. This test CHARACTERISED that open defect and asserted
    rc 0; #507 supersedes #461 with the two-predicate fix (no ExternalLink anywhere under
    `/matrix`, and the seven consumed members must be seven DISTINCT objects), and the
    alias check now refuses the SoftLink by name: `...'/matrix/data' and '/matrix/indices'
    are the SAME object. ...`. The test is FLIPPED to assert the refusal: rc 2, no
    traceback, an empty outputs tree, and the collision message naming both members.
    """
    bundle = HB.a_matrix_with_a_SAME_FILE_SoftLink_member(tmp_path)
    inputs = _staged(tmp_path, bundle)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the same-file SoftLink alias exited {result.returncode}, not 2 -- #461/#507's "
        f"defect was that it imported at rc 0 with wrong values, and the fix must refuse "
        f"it by name.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the same-file SoftLink alias produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out") == [], (
        "the same-file SoftLink alias refusal left paths under /outputs -- INV-8's promise "
        "is that a refused import leaves NO store and no partial store")
    line = _refusal_line(result.stderr)
    assert line.startswith(PREFIX), line[:200]
    assert b"'/matrix/data'" in line and b"'/matrix/indices'" in line, (
        f"the refusal does not name both aliased members: {line!r}")
    assert b"are the SAME object" in line, (
        f"the refusal does not say the members are the SAME object: {line!r}")


def test_TEST_68_a_COMMITTED_DATATYPE_is_refused_BY_NAME(tmp_path):
    """TEST-68 [acceptance, INV-8 + INV-9] — a committed (named) HDF5 datatype under `/matrix`.

    HDF5 has a THIRD object class inside a group besides datasets and groups: a COMMITTED
    DATATYPE, which h5py returns as `h5py.Datatype` -- it has `.id`, `.file`, `.attrs` and
    NO `.keys()`. Pre-fix the walk's descent branched on `isinstance(obj, h5py.Dataset)`
    and otherwise ASSUMED a Group, so the `.keys()` call sat outside every `try` and this
    bundle died with a raw `AttributeError: 'Datatype' object has no attribute 'keys'`
    traceback at rc 1 with 0 output paths (the builder's docstring records the
    measurement). The refusal must name the path and the object class, and must leave
    nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-committed-datatype")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/a_committed_type" in line, (
        f"the refusal does not name the object it refused: {line!r}")
    assert b"is neither a dataset nor a group" in line, (
        f"the refusal does not name the object class: {line!r}")


def test_TEST_69_a_DEEP_GROUP_NESTING_is_refused_BY_NAME(tmp_path):
    """TEST-69 [acceptance, INV-8 + INV-9] — 3000 nested empty groups under `/matrix`.

    The `seen` set guards CYCLES, not DEPTH: every level is a distinct object, so nothing
    is ever in `seen` and the recursive walk descended one Python frame per level. Pre-fix
    this bundle died with a raw `RecursionError: maximum recursion depth exceeded`
    traceback at rc 1 with 0 output paths (the builder's docstring records the
    measurement). The walk is iterative now and refuses a path deeper than the stated cap
    BY NAME; the refusal must name the offending path's leaf and the depth, and must leave
    nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-deep-group-nesting")
    assert line.startswith(PREFIX), line[:200]
    assert b"level_64" in line, (
        f"the refusal does not name the offending path: {line!r}")
    assert b"is deeper than 64 levels under `/matrix`" in line, (
        f"the refusal does not name the depth cap: {line!r}")


def test_TEST_70_a_DEEP_SAME_FILE_SoftLink_CHAIN_is_refused_BY_NAME(tmp_path):
    """TEST-70 [acceptance, INV-8 + INV-9] — `/matrix/data` as a 51-hop same-file SoftLink chain.

    HDF5 enforces its OWN link-traversal limit and raises `RuntimeError: Special link
    traversal failed (too many links)` when a chain is too long. Pre-fix this escaped the
    member loop's guarded read as a raw `RuntimeError` traceback at rc 1 with 0 output
    paths (the builder's docstring records the measurement). This is a SAME-FILE chain, so
    the structural walk's realpath leg does NOT refuse it -- the refusal must come from the
    guarded read this round widened. The refusal must name the member and say it cannot be
    read, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-deep-softlink-chain-data")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/data`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"cannot be read" in line, (
        f"the refusal does not say the member cannot be read: {line!r}")


def test_TEST_71_a_SHAPE_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-71 [acceptance, INV-8 + INV-9] — `/matrix/shape` as an ExternalLink.

    A ladder showed that an outside `shape` with DIFFERENT dims is refused by an EARLIER
    shape cross-check, so only the SAME-dims variant exercises the structural walk on
    `/matrix/shape` itself. The walk's link inspection must name `/matrix/shape` and the
    link class, and must leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-shape")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/shape" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_72_a_FEATURES_ID_SAME_FILE_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-72 [acceptance, INV-8 + INV-9] — M1: `/matrix/features/id` as an ExternalLink BACK into the bundle's own file.

    The link resolves transparently to the bundle's own `features/name` dataset, so the
    realpath check passes (same file) and `axis/gene_id.zarr` would be built from feature
    NAMES instead of ids. The walk's link inspection must refuse it BY NAME before
    resolving it — an ExternalLink is refused wherever it points, even back into this same
    file.
    """
    line = _run_refusal(tmp_path, "matrix-features-id-same-file-external-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/features/id" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_73_a_FEATURES_ID_HARD_LINK_to_FEATURES_NAME_is_refused_BY_NAME(tmp_path):
    """TEST-73 [acceptance, INV-8 + INV-9] — M2: `/matrix/features/id` as a HARD LINK to `/matrix/features/name`.

    A hard link is INVISIBLE to `getlink=True` — it returns `h5py.HardLink`, exactly what
    an ordinary dataset returns — and the object is in the same file, so the realpath check
    passes too. The alias check must resolve the seven consumed members and require seven
    DISTINCT objects: `/matrix/features/id` and `/matrix/features/name` are the SAME
    object.
    """
    line = _run_refusal(tmp_path, "matrix-features-id-hard-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/features/id" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"are the SAME object" in line, (
        f"the refusal does not say the members are the SAME object: {line!r}")


def test_TEST_74_a_BARCODES_SAME_FILE_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-74 [acceptance, INV-8 + INV-9] — M3: `/matrix/barcodes` as an ExternalLink BACK into the bundle's own file.

    The link resolves transparently to the bundle's own reversed barcodes, so the realpath
    check passes (same file) and the store's barcode axis would be exactly the reverse of
    baseline. The walk's link inspection must refuse it BY NAME before resolving it.
    """
    line = _run_refusal(tmp_path, "matrix-barcodes-same-file-external-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/barcodes" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_75_a_DATA_HARD_LINK_to_INDICES_is_refused_BY_NAME(tmp_path):
    """TEST-75 [acceptance, INV-8 + INV-9] — M4: `/matrix/data` as a HARD LINK to `/matrix/indices`.

    #461/TEST-67's own case restated as a HARD LINK instead of a SoftLink — a different
    bypass mechanism per #507. The hard link resolves to the bundle's own `indices`
    dataset, so the realpath check passes (same file) and the store's `data` would hold
    the feature-id values, not counts. The alias check must refuse it: `/matrix/data` and
    `/matrix/indices` are the SAME object.
    """
    line = _run_refusal(tmp_path, "matrix-data-hard-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/data" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"are the SAME object" in line, (
        f"the refusal does not say the members are the SAME object: {line!r}")


def test_TEST_76_a_DATA_SoftLink_to_a_SAME_FILE_ExternalLink_is_refused_BY_NAME(tmp_path):
    """TEST-76 [acceptance, INV-8 + INV-9] — M5: `/matrix/data` -> SoftLink("/matrix/zz") where `/matrix/zz` is an ExternalLink back into the bundle's own file.

    `data`'s OWN link is a SoftLink, so a check that inspects only the member's own link
    walks straight through, and the chain resolves to the bundle's own `indices` dataset —
    the store's `data` would hold the feature-id values, not counts. The walk inspects
    EVERY key's link before resolving it and must refuse the chain's ExternalLink by name:
    `/matrix/zz` is an ExternalLink.
    """
    line = _run_refusal(tmp_path, "matrix-data-softlink-to-same-file-external-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/zz" in line, (
        f"the refusal does not name the chain's ExternalLink: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")


def test_TEST_77_a_DATA_15_HOP_SAME_FILE_SoftLink_CHAIN_is_refused_BY_NAME(tmp_path):
    """TEST-77 [acceptance, INV-8 + INV-9] — M6: `/matrix/data` as a 15-hop SAME-FILE SoftLink chain ending at `/matrix/indices`.

    The chain is UNDER HDF5's 16-link traversal limit, so it resolves cleanly to the
    bundle's own `indices` dataset — the realpath check passes (same file) and the store's
    `data` would hold the feature-id values, not counts. The alias check must refuse it:
    `/matrix/data` and `/matrix/indices` are the SAME object.
    """
    line = _run_refusal(tmp_path, "matrix-data-15-hop-softlink-chain")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/data" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"are the SAME object" in line, (
        f"the refusal does not say the members are the SAME object: {line!r}")


def test_TEST_78_an_EXTRA_SAME_FILE_HARD_LINK_under_a_name_not_consumed_still_imports(tmp_path):
    """TEST-78 [acceptance] — an ordinary extra same-file hard link still imports at rc 0.

    `/matrix/_scratch` hard-linked to `/matrix/shape` is an alias under a name this
    importer does NOT consume. The alias check is scoped to the seven consumed members
    only, so this must import at rc 0 with a manifest written — proving the check does not
    over-refuse.
    """
    bundle = HB.a_matrix_with_an_EXTRA_SAME_FILE_HARD_LINK_under_a_name_not_consumed(tmp_path)
    inputs = _staged(tmp_path, bundle)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the extra same-file hard link wrote no manifest.json — the alias check must be "
        "scoped to the seven consumed members only")


def test_TEST_79_a_DATA_SoftLink_through_a_SIBLING_GROUP_ExternalLink_to_INDICES_is_refused_BY_NAME(tmp_path):
    """TEST-79 [acceptance, INV-8 + INV-9] — `/matrix/data` -> SoftLink("/other_group/bar") where `/other_group/bar` is an ExternalLink back into the bundle's own file at `/matrix/indices`.

    The detour leaves `/matrix` entirely, so the structural walk
    (`_refuse_outside_matrix_objects`) never visits `/other_group` and its no-ExternalLink
    predicate cannot see this chain. But `_refuse_aliased_matrix_members` resolves
    `/matrix/data` directly via `group["data"]`, which follows the FULL chain — SoftLink
    then ExternalLink — transparently to the real `/matrix/indices` object, and the
    collision is caught: `/matrix/data` and `/matrix/indices` are the SAME object.
    """
    line = _run_refusal(tmp_path, "matrix-data-softlink-through-sibling-group-external-link")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/data" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"/matrix/indices" in line, (
        f"the refusal does not name the colliding member: {line!r}")
    assert b"are the SAME object" in line, (
        f"the refusal does not say the members are the SAME object: {line!r}")


def test_TEST_80_a_BARCODES_ExternalLink_to_a_DIFFERENT_set_is_refused_BY_NAME(tmp_path):
    """TEST-80 [acceptance, INV-8 + INV-9] — #476: `/matrix/barcodes` as an ExternalLink to
    an outside file holding a DIFFERENT barcode set.

    TEST-65's sibling, and the shape #476 is actually about. TEST-65 uses the "reversed"
    trick — the outside file holds the bundle's OWN barcodes, so the join passes (same
    SET) and the structural walk is what catches it. #476 is the OTHER shape: the outside
    file holds the SAME NUMBER of barcodes (so the length cross-check passes) but a
    DIFFERENT SET, so the join fires FIRST and blames `tissue_positions.parquet` for a
    defect that is really an ExternalLink on `/matrix/barcodes`. Pre-fix the refusal named
    the positions file; post-fix the storage check runs before the join and must name
    `/matrix/barcodes` and the link class, and must NOT mention `tissue_positions.parquet`.
    """
    line = _run_refusal(tmp_path, "matrix-external-link-barcodes-different-set")
    assert line.startswith(PREFIX), line[:200]
    assert b"/matrix/barcodes" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not name the link class: {line!r}")
    assert b"tissue_positions.parquet" not in line, (
        f"the refusal blames the positions file for a matrix defect (#476): {line!r}")


def test_TEST_81_an_ABSENT_features_group_is_refused_as_HAS_NO_not_CANNOT_BE_READ(tmp_path):
    """TEST-81 [acceptance, INV-8 + INV-9] — #536: `/matrix/features` ABSENT is "has no", not "cannot be read".

    `_refuse_aliased_matrix_members` used to fold a `KeyError` on `group["features"]` into
    the SAME "cannot be read" refusal as a genuinely unreadable group. #536 splits the
    `except`: a `KeyError` means the group is ABSENT, so the alias check skips the two
    `features/*` members (matching `_matrix_member_identity`'s own convention — absence is
    refused by name elsewhere) and the LATER guarded `features = group["features"]`
    resolution raises the precise "has no `/matrix/features` group" message. The refusal
    must say the group is MISSING, must NOT say it cannot be read, and must leave nothing
    on disk. TEST-81 is unchanged by #585: the `/matrix` type-refusal fires only when the
    RESOLVED `/matrix` object is not a Group, so the later #536 absent-features arm and its
    "has no" message are untouched — TEST-81 still distinguishes absence from wrong type.
    RE-CITED by the #587 node: the guarded-subscript leg fires only when `/matrix` does not
    RESOLVE at all, so the #536 absence arm stays untouched by this node's change too.
    """
    line = _run_refusal(tmp_path, "matrix-no-features")
    assert line.startswith(PREFIX), line[:200]
    assert b"has no `/matrix/features` group" in line, (
        f"the refusal does not say the group is MISSING: {line!r}")
    assert b"cannot be read" not in line, (
        f"the refusal still says the group cannot be read (#536): {line!r}")


# ── TEST-88..93: #539 — `/matrix/features` resolving to a Dataset (not a Group) is refused
#    BY NAME. The generic sweeps (TEST-8/TEST-9 over `HB.REFUSALS`) already cover the four
#    rows; these tests pin the CONTENT — the named member, the true diagnosis, the sentence
#    and, for TEST-91, the discrimination proof that only the explicit type refusal closes
#    the class.


def test_TEST_88_an_INLINE_Dataset_features_is_refused_BY_NAME(tmp_path):
    """TEST-88 [acceptance, INV-8 + INV-9] — #539: `/matrix/features` as a plain inline Dataset.

    `_matrix_member_identity`'s exception tuple was `(OSError, TypeError, RuntimeError)` —
    one exception type short — so `features_group["id"]` on a non-compound Dataset escaped
    as the RAW h5py `ValueError: Field names only allowed for compound types` at rc 1 with
    zero output paths (MEASURED; recorded in the builder's docstring). The refusal must name
    `/matrix/features`, say it is not a group, and leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-features-inline-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/features`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix/features is not a group: {line!r}")
    assert b"Field names only allowed for compound types" not in line, (
        f"the refusal quotes h5py's field-name error instead of the defect (#539): {line!r}")


def test_TEST_89_a_SAME_FILE_SoftLink_features_to_a_Dataset_is_refused_BY_NAME(tmp_path):
    """TEST-89 [acceptance, INV-8 + INV-9] — #539: `/matrix/features` -> SoftLink("/matrix/barcodes").

    The structural walk passes a same-file SoftLink (it is not an ExternalLink, and the
    resolved object is in this bundle's own file), so the alias check's OWN resolution is what
    must refuse it: `group["features"]` follows the link to the barcodes Dataset, and
    `features_group["id"]` raised the same uncaught `ValueError` at rc 1 (MEASURED). The
    refusal must name `/matrix/features`, say it is not a group, and leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-features-softlink-to-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/features`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix/features is not a group: {line!r}")
    assert b"Field names only allowed for compound types" not in line, (
        f"the refusal quotes h5py's field-name error instead of the defect (#539): {line!r}")


def test_TEST_90_a_HARD_LINK_features_to_a_Dataset_is_refused_BY_NAME(tmp_path):
    """TEST-90 [acceptance, INV-8 + INV-9] — #539: `/matrix/features` = HARD LINK to `/matrix/barcodes`.

    A hard link is INVISIBLE to `getlink=True` (it returns `h5py.HardLink`, exactly what an
    ordinary member returns) and the object is in this bundle's own file, so both the walk's
    link inspection and its realpath check pass it; `group["features"]` resolves to the
    barcodes Dataset and `features_group["id"]` raised the same uncaught `ValueError` at
    rc 1 (MEASURED). The refusal must name `/matrix/features`, say it is not a group, and
    leave nothing on disk — the hard-link spelling of the class #507's alias check exists to
    see, one level down.
    """
    line = _run_refusal(tmp_path, "matrix-features-hard-link-to-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/features`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix/features is not a group: {line!r}")
    assert b"Field names only allowed for compound types" not in line, (
        f"the refusal quotes h5py's field-name error instead of the defect (#539): {line!r}")


def test_TEST_91_a_COMPOUND_dtype_Dataset_features_is_refused_BY_NAME(tmp_path):
    """TEST-91 [acceptance, INV-8 + INV-9] — #539 COMPOUND-dtype spelling — THE DISCRIMINATION PROOF.

    `dataset["id"]` on a COMPOUND-dtype Dataset SUCCEEDS (it returns a numpy field array), so
    the crash moves to `h5py.h5o.get_info(obj.id)`, where `obj` is an ndarray:
    `AttributeError: 'numpy.ndarray' object has no attribute 'id'` — also UNCAUGHT (MEASURED:
    rc 1, raw traceback, 0 paths). MEASURED with the issue's suggested minimal fix (adding
    `ValueError` to `_matrix_member_identity`'s tuple): THIS path STILL crashed at rc 1 with
    the same AttributeError — with a `ValueError` interpretation the field subscript does not
    raise at all, so a tuple-widening fix alone does not close the class; extending it to
    `AttributeError` instead produces "object identity cannot be determined ('numpy.ndarray'
    object has no attribute 'id')", a FALSE diagnosis (the Dataset's identity IS determinable;
    the defect is that `/matrix/features` is not a Group). This test is the canary: it
    reddens if the explicit type refusal is ever replaced by tuple widening, and it is why
    the four rows share one diagnosis rather than being four.
    """
    line = _run_refusal(tmp_path, "matrix-features-compound-dtype-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix/features`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix/features is not a group: {line!r}")
    assert b"numpy.ndarray" not in line, (
        f"the refusal leaks the ndarray AttributeError instead of the defect (#539): {line!r}")
    assert b"identity cannot be determined" not in line, (
        f"the refusal uses the false 'identity cannot be determined' template (#539): {line!r}")


#: The verbatim #539 refusal body (after the prefix). Pinned byte-for-byte so a re-wording
#: that stops naming the member, stops saying what it is, or falls back to the generic
#: "cannot be read" template reddens.
_MATRIX_FEATURES_NOT_A_GROUP = (
    b"filtered_feature_bc_matrix.h5's `/matrix/features` is not a group ('Dataset'). A 10x "
    b"feature-barcode matrix stores the feature ids, names and types under `/matrix/features` "
    b"in a GROUP; a `/matrix/features` that is not a group has no `/matrix/features/id` or "
    b"`/matrix/features/name` member to label the columns of its counts matrix with. Refusing "
    b"rather than shipping a wrong matrix."
)


def test_TEST_92_the_features_NOT_A_GROUP_refusal_MESSAGE_is_pinned(tmp_path):
    """TEST-92 [acceptance, INV-8 + INV-9] — the #539 sentence, verbatim (TEST-81 style).

    The sentence must say WHAT the resolved object is — "is not a group ('Dataset')" — and
    never the h5py raw text ("Field names only allowed for compound types") nor the generic
    templates ("cannot be read" / "identity cannot be determined"), all three of which a
    tuple-widening fix produces and all of which are FALSE diagnoses here: the value IS
    readable, the identity IS determinable, and the defect is that `/matrix/features` is not
    the Group a 10x feature-barcode matrix stores its feature ids and names in.
    """
    line = _run_refusal(tmp_path, "matrix-features-inline-dataset")
    assert line == PREFIX + _MATRIX_FEATURES_NOT_A_GROUP, (
        f"the refusal line no longer matches the pinned #539 sentence: {line[:400]!r}")
    for forbidden in (b"Field names only allowed", b"cannot be read",
                      b"identity cannot be determined", b"numpy.ndarray"):
        assert forbidden not in line, (
            f"the pinned message carries {forbidden!r}, which is a FALSE diagnosis (#539): "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the pinned message is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_93_a_real_features_GROUP_still_imports(tmp_path):
    """TEST-93 [acceptance] — THE OVER-REFUSAL GUARD for #539: a legitimate features GROUP is untouched.

    The same driver, the same staging, the committed fixture — whose `/matrix/features` is a
    real Group carrying `id`/`name` datasets: rc 0, a `manifest.json` on disk, and no
    `not a group` line on stderr (exactly what the assertions below check). The new check
    refuses ONLY the resolved non-Group case; without this
    control the four refusals above prove nothing (a module that refused every bundle would
    pass them). TEST-93 is the GOOD-bundle positive control the #585 node still asserts —
    the #585 `/matrix` type-refusal fires above the member checks, so a #585 over-refusal of
    the committed fixture's real `/matrix` GROUP would redden this test. RE-CITED by the
    #587 node: the new guarded-subscript leg (#587) fires above the SAME boundary, so a
    #587 over-refusal of the fixture's real `/matrix` GROUP would redden it too.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert b"not a group" not in result.stderr, (
        "the good bundle was refused as 'not a group' — the #539 check over-refuses: "
        f"{result.stderr[-2000:]!r}")
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the control run wrote no manifest.json — the refusal assertions above prove "
        "nothing if the good bundle does not import")


def test_TEST_94_a_SAME_FILE_SoftLink_features_to_a_GROUP_still_imports(tmp_path):
    """TEST-94 [acceptance] — THE OVER-REFUSAL CONTROL: a SoftLink to a GROUP imports.

    (PLAN-local INV-4: the boundary is `/matrix/features`-is-not-a-Group ONLY. The NUMBER
    INV-4 is taken package-side by `docs/design/spatial-storage-layout.md` §15.1
    (measured_entity) in `test_measured_entity.py`, so this control carries no
    package-visible invariant tag — it is pinned by TESTS.md in this node's own numbering.)

    #539's check is `isinstance(features_group, h5py.Group)` on the RESOLVED object, and
    h5py resolves a SoftLink transparently — so a same-file SoftLink at `/matrix/features`
    that resolves to a legitimate features GROUP must still import at rc 0. The check COULD
    have been written on the link (refusing any SoftLink at `/matrix/features`); this bundle
    is exactly what such a link-level check would refuse, which is what makes it the
    over-refusal control for the resolved-object design. The builder is a CONTROL,
    deliberately NOT an `HB.REFUSALS` row: the importer must ACCEPT this bundle.
    """
    root = HB.a_matrix_whose_FEATURES_is_a_SAME_FILE_SoftLink_to_a_GROUP(tmp_path)
    inputs, _ordinals = HF.staged_flat(tmp_path, root)
    result = HF.run_entry(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert "not a group" not in result.stderr, (
        "the SoftLink-to-Group bundle was refused as 'not a group' — the #539 check "
        "over-refuses a legitimate GROUP reached through a link: "
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out"), (
        "the SoftLink-to-Group control wrote no store — the rc 0 above proves nothing if "
        "the importer produced nothing")


# ── TEST-95..99 + TEST-100..102: #585 — `/matrix` itself resolving to a Dataset (not a
#    Group) is refused BY NAME. The generic sweeps (TEST-8/TEST-9 over `HB.REFUSALS`) already
#    cover the four rows; these tests pin the CONTENT — the named member, the true diagnosis
#    (including the 1-D false-diagnosis canary), the sentence, the resolved-type token on the
#    two link rows, and the INV-4 controls (TEST-100 good-bundle positive control, TEST-101
#    SoftLink-to-GROUP, TEST-102 hard-link-to-GROUP).


def test_TEST_95_an_INLINE_Dataset_matrix_is_refused_BY_NAME(tmp_path):
    """TEST-95 [acceptance, INV-9 + INV-8] — #585: `/matrix` as a plain inline 2-D Dataset.

    `group = h5["matrix"]` was never type-checked; the membership loop's
    `if member not in group:` (the FIRST use) falls through to membership-by-comparison on a
    2-D Dataset — iterated row-wise, each row compared with `==`, and the truth test of the
    resulting array raises `ValueError: The truth value of an array with more than one
    element is ambiguous. Use a.any() or a.all()` at rc 1 with zero output paths (MEASURED;
    recorded in the builder's docstring). The refusal must name `/matrix`, say it is not a
    group, and leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-root-inline-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix is not a group: {line!r}")
    assert b"more than one element is ambiguous" not in line, (
        f"the refusal quotes the membership-test ValueError instead of the defect (#585): {line!r}")


def test_TEST_96_a_SAME_FILE_SoftLink_matrix_to_a_Dataset_is_refused_BY_NAME(tmp_path):
    """TEST-96 [acceptance, INV-9 + INV-8] — #585: `/matrix` -> SoftLink("/zzz_ds").

    The ExternalLink leg (`getlink=True`, refuses `h5py.ExternalLink` only) passes a
    same-file SoftLink, so `group = h5["matrix"]` follows it to the `zzz_ds` Dataset and the
    membership test raised the same uncaught `ValueError` at rc 1 (MEASURED). The refusal
    must name `/matrix`, say it is not a group, and leave nothing on disk — and because the
    message quotes the RESOLVED object's type, it says `'Dataset'`, the truth about what the
    link resolves to.
    """
    line = _run_refusal(tmp_path, "matrix-root-softlink-to-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix is not a group: {line!r}")
    assert b"('Dataset')" in line, (
        f"the refusal does not state what the link RESOLVED to — the issue's "
        f"'must say what the object IS' requirement (#585): {line!r}")
    assert b"more than one element is ambiguous" not in line, (
        f"the refusal quotes the membership-test ValueError instead of the defect (#585): {line!r}")


def test_TEST_97_a_HARD_LINK_matrix_to_a_Dataset_is_refused_BY_NAME(tmp_path):
    """TEST-97 [acceptance, INV-9 + INV-8] — #585: `/matrix` = HARD LINK to `/zzz_ds`.

    A hard link is INVISIBLE to `getlink=True` (it returns `h5py.HardLink`, exactly what an
    ordinary member returns) and the object is in this bundle's own file, so the ExternalLink
    leg passes it; `group = h5["matrix"]` resolves to the `zzz_ds` Dataset and the membership
    test raised the same uncaught `ValueError` at rc 1 (MEASURED). The refusal must name
    `/matrix`, say it is not a group, and leave nothing on disk.
    """
    line = _run_refusal(tmp_path, "matrix-root-hard-link-to-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix is not a group: {line!r}")
    assert b"('Dataset')" in line, (
        f"the refusal does not state what the hard link RESOLVED to — the issue's "
        f"'must say what the object IS' requirement (#585): {line!r}")
    assert b"more than one element is ambiguous" not in line, (
        f"the refusal quotes the membership-test ValueError instead of the defect (#585): {line!r}")


def test_TEST_98_a_ONE_DIMENSIONAL_Dataset_matrix_is_refused_with_the_TRUE_diagnosis(tmp_path):
    """TEST-98 [acceptance, INV-9 + INV-8] — #585 1-D spelling — THE MESSAGE-COHERENCE CANARY.

    A 1-D Dataset does NOT crash the membership test (`"data" in <1-D Dataset>` iterates the
    scalar values and returns False), so on the base the loop took its MISSING-member branch
    and refused with the FALSE diagnosis `filtered_feature_bc_matrix.h5 has no
    `/matrix/data` ...` at rc 2 — pointing the operator at a member that is not the problem
    (MEASURED: rc 2, no traceback, 0 paths, but the wrong offence). This test is the canary:
    it reddens if the type refusal is ever replaced by a catch/tuple-widening alternative,
    because NOTHING raises on this spelling for a catch to see. The refusal must say the
    truth — `/matrix` is not a group — and must NOT be the member-loop's false "has no
    `/matrix/data`" diagnosis. NOTE the discriminator: the TRUE message itself contains the
    words "has no `/matrix/data`" — as one of the members a non-Group `/matrix` is missing —
    so the bare substring cannot tell the two apart. What discriminates is the member-loop's
    OWN first sentence ("…has no `/matrix/data`. A 10x feature-barcode matrix stores … as
    flat datasets under `/matrix`"), which is the false diagnosis verbatim; the equality pin
    below settles it byte-for-byte, and this marker keeps the failure readable.
    """
    line = _run_refusal(tmp_path, "matrix-root-1d-dataset")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is not a group" in line, (
        f"the refusal does not say /matrix is not a group: {line!r}")
    assert b"has no `/matrix/data`. A 10x feature-barcode matrix stores its non-zero values, feature ids and column offsets as flat datasets" not in line, (
        f"the refusal still uses the FALSE 'has no `/matrix/data`' diagnosis for a 1-D "
        f"/matrix (#585 message-coherence half): {line!r}")
    assert line == PREFIX + _MATRIX_ROOT_NOT_A_GROUP, (
        f"the 1-D refusal is not the pinned #585 sentence: {line[:400]!r}")


#: The verbatim #585 refusal body (after the prefix). Pinned byte-for-byte so a re-wording
#: that stops naming the member, stops saying what it is, or falls back to the generic
#: "cannot be read" template — or to the FALSE "has no `/matrix/data`" diagnosis the 1-D
#: spelling used to get — reddens.
_MATRIX_ROOT_NOT_A_GROUP = (
    b"filtered_feature_bc_matrix.h5's `/matrix` is not a group ('Dataset'). A 10x "
    b"feature-barcode matrix stores its non-zero values, feature ids and column offsets "
    b"under `/matrix` in a GROUP; a `/matrix` that is not a group has no `/matrix/data`, "
    b"`/matrix/indices` or `/matrix/indptr` member to read the counts from. Refusing rather "
    b"than shipping a wrong matrix."
)


def test_TEST_99_the_matrix_NOT_A_GROUP_refusal_MESSAGE_is_pinned(tmp_path):
    """TEST-99 [acceptance, INV-9 + INV-8] — the #585 sentence, verbatim (TEST-92 style).

    The sentence must say WHAT the resolved object is — "is not a group ('Dataset')" — and
    never the membership-test's raw comparison text ("The truth value of an array with more
    than one element is ambiguous") nor the generic templates ("cannot be read" / "identity
    cannot be determined"), NOR the false "has no `/matrix/data`" diagnosis that the 1-D
    spelling used to get — all of which a catch/tuple-widening fix produces and all of which
    are FALSE diagnoses here: the values are not absent (the 1-D case) and the defect is that
    `/matrix` is not the Group a 10x feature-barcode matrix stores its counts under.
    """
    line = _run_refusal(tmp_path, "matrix-root-inline-dataset")
    assert line == PREFIX + _MATRIX_ROOT_NOT_A_GROUP, (
        f"the refusal line no longer matches the pinned #585 sentence: {line[:400]!r}")
    # NOTE the false-diagnosis marker is the member-loop's OWN first sentence, not the bare
    # "has no `/matrix/data`" substring — the TRUE message says "has no `/matrix/data`,
    # `/matrix/indices` or `/matrix/indptr` member" as the truthful consequence, so the bare
    # substring appears in both and cannot discriminate.
    for forbidden in (b"has no `/matrix/data`. A 10x feature-barcode matrix stores its non-zero values, feature ids and column offsets as flat datasets",
                      b"cannot be read", b"identity cannot be determined",
                      b"more than one element is ambiguous", b"Cannot compare structured",
                      b"numpy.ndarray"):
        assert forbidden not in line, (
            f"the pinned message carries {forbidden!r}, which is a FALSE diagnosis (#585): "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the pinned message is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


# TEST-100 is the good-bundle positive control for #585 (declared in the phase-3 plan);
# a post-audit attempt to remove it as a byte-duplicate of TEST-93 was reverted because
# the A5 shrink-guard has no recorded-removal channel — ziee-ai/agent-kit#15 (the
# duplicate is harmless; DEC-9 records the reversal).
def test_TEST_100_a_real_matrix_GROUP_still_imports(tmp_path):
    """TEST-100 [acceptance] — THE OVER-REFUSAL GUARD for #585: a legitimate `/matrix` GROUP is untouched.

    The same driver, the same staging, the committed fixture — whose `/matrix` is a real
    Group carrying `data`/`indices`/`indptr`/`barcodes`/`shape`/`features`: rc 0, a
    `manifest.json` on disk, and no `not a group` line on stderr (exactly what the
    assertions below check). The new check refuses ONLY the resolved non-Group case; without
    this control the four refusals above prove nothing (a module that refused every bundle
    would pass them). RE-CITED by the #587 node (added clause): the new guarded-subscript
    leg (#587) fires above the same boundary, so a #587 over-refusal of the fixture's real
    `/matrix` GROUP would redden this test too.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert b"not a group" not in result.stderr, (
        "the good bundle was refused as 'not a group' — the #585 check over-refuses: "
        f"{result.stderr[-2000:]!r}")
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the control run wrote no manifest.json — the refusal assertions above prove "
        "nothing if the good bundle does not import")


def test_TEST_101_a_SAME_FILE_SoftLink_matrix_to_a_GROUP_still_imports(tmp_path):
    """TEST-101 [acceptance] — THE OVER-REFUSAL CONTROL: a SoftLink at `/matrix` to a GROUP imports.

    (PLAN-local INV-4: the boundary is `/matrix`-is-not-a-Group ONLY. The NUMBER INV-4 is
    taken package-side by `docs/design/spatial-storage-layout.md` §15.1 (measured_entity) in
    `test_measured_entity.py`, so this control carries no package-visible invariant tag — it
    is pinned by TESTS.md in this node's own numbering.)

    #585's check is `isinstance(group, h5py.Group)` on the RESOLVED object, and h5py
    resolves a SoftLink transparently — so a same-file SoftLink at `/matrix` that resolves
    to a legitimate matrix GROUP must still import at rc 0. The check COULD have been written
    on the link (refusing any SoftLink at `/matrix`); this bundle is exactly what such a
    link-level check would refuse, which is what makes it the over-refusal control for the
    resolved-object design. MEASURED 2026-09-23 through the shipped entrypoint (pycache
    purged) on both the 0.13.0 base and HEAD: rc 0 with 120 output paths through that seam
    (exact total runner-environment-dependent — a direct CLI run measures 119; no test
    asserts the count) — the control's rc 0 is the invariant to preserve. The builder is a
    CONTROL, deliberately NOT
    an `HB.REFUSALS` row: the importer must ACCEPT this bundle. RE-CITED by the #587 node
    (added clause): the guarded-subscript leg is a LINK-level read, so a #587 check written
    on the link (refusing any SoftLink — or any link that must first be inspected) would
    over-refuse exactly this bundle; the CHAIN spelling of the same control is TEST-109.
    """
    root = HB.a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_to_a_GROUP(tmp_path)
    inputs, _ordinals = HF.staged_flat(tmp_path, root)
    result = HF.run_entry(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert "not a group" not in result.stderr, (
        "the SoftLink-to-Group bundle was refused as 'not a group' — the #585 check "
        "over-refuses a legitimate GROUP reached through a link: "
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out"), (
        "the SoftLink-to-Group control wrote no store — the rc 0 above proves nothing if "
        "the importer produced nothing")


def test_TEST_102_a_HARD_LINK_matrix_to_a_GROUP_still_imports(tmp_path):
    """TEST-102 [acceptance] — THE SECOND OVER-REFUSAL CONTROL: a HARD LINK at `/matrix` to a GROUP imports.

    (PLAN-local INV-4: the boundary is `/matrix`-is-not-a-Group ONLY — see TEST-101 for why
    the number is not a package-visible tag.)

    #585's check is `isinstance(group, h5py.Group)` on the RESOLVED object, and a hard link
    is resolved transparently — so `/matrix` = hard link to a legitimate matrix GROUP must
    still import at rc 0. TEST-101 pins the SoftLink spelling; this test pins the HARD-LINK
    spelling, because a link-level check COULD have been written on the link class (refusing
    any hard link at `/matrix`, invisible to `getlink=True` — exactly like the #507 rows)
    and would over-refuse exactly this legitimate bundle. MEASURED 2026-09-23 through
    the shipped entrypoint (pycache purged) on both the 0.13.0 base and HEAD: rc 0 with 120
    output paths through that seam and a `manifest.json` on disk (exact total
    runner-environment-dependent — a direct CLI run measures 119; no test asserts the
    count) — the control's rc 0 is the invariant to preserve. The builder is a CONTROL,
    deliberately NOT
    an `HB.REFUSALS` row: the importer must ACCEPT this bundle. RE-CITED by the #587 node
    (added clause): a hard link cannot dangle — its target cannot be missing while the name
    exists — so it is OUTSIDE #587's reach by construction; this control records that the
    guarded-subscript leg still resolves it transparently and imports it (it must not
    refuse the link CLASS).
    """
    root = HB.a_matrix_whose_MATRIX_is_a_HARD_LINK_to_a_GROUP(tmp_path)
    inputs, _ordinals = HF.staged_flat(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert b"is not a group" not in result.stderr, (
        "the hard-link-to-Group bundle was refused as 'not a group' — the #585 check "
        "over-refuses a legitimate GROUP reached through a hard link: "
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out"), (
        "the hard-link-to-Group control wrote no store — the rc 0 above proves nothing if "
        "the importer produced nothing")
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the hard-link-to-Group control wrote no manifest.json — the rc 0 above proves "
        "nothing if the importer produced no store")


# ── TEST-103..110: #587 — a `/matrix` LINK whose target does not resolve (the sibling's
#    unreadable-target leg) is refused BY NAME. The generic sweeps (TEST-8/TEST-9 over
#    `HB.REFUSALS`) cover the three new rows; these tests pin the CONTENT — the two reach
#    spellings (dangling one-hop SoftLink, SoftLink chain ending nowhere), the
#    ExternalLink-to-a-MISSING-file pin on the EXISTING sentence, the TWO ORDERING CANARIES
#    (behavioral TEST-106 + structural TEST-107 — `VisiumImportError` IS a `RuntimeError`
#    subclass, so the guarded try must be minimal, re-raise first, and leave the #585
#    isinstance refusal outside), the verbatim message pin, and the chain-to-GROUP
#    over-refusal control.


#: The verbatim #587 refusal body (after the prefix) for the DANGLING SoftLink spelling.
#: Pinned byte-for-byte so a re-wording that stops saying the link exists, stops naming
#: `/matrix`, stops quoting the cause through the funnel, or falls back to the generic
#: templates reddens. The quoted cause is `_quoted_for_refusal(exc, noun='message')` over
#: h5py's measured KeyError: `ascii(str(exc))` — and `str(KeyError(...))` IS the repr of
#: the key, single quotes included — so the funnel output is
#: `"'Unable to synchronously open object (component not found)'"`.
_MATRIX_LINK_UNREADABLE = (
    b"filtered_feature_bc_matrix.h5's `/matrix` link exists but its target cannot be read "
    b"(\"'Unable to synchronously open object (component not found)'\"). A 10x "
    b"feature-barcode matrix stores its non-zero values, feature ids and column offsets "
    b"under `/matrix` INLINE; a link whose target does not resolve is not a matrix this "
    b"importer can carry. Refusing rather than shipping a wrong matrix."
)


def test_TEST_103_a_DANGLING_SAME_FILE_SoftLink_matrix_is_refused_BY_NAME(tmp_path):
    """TEST-103 [acceptance, INV-9 + INV-8 + INV-3] — #587: `/matrix` -> SoftLink("/does_not_exist_anywhere").

    The #587 shape as first reported: the presence test `"matrix" not in h5` is
    `H5Lexists` (TRUE for a dangling link) and the ExternalLink leg passes a SoftLink
    (it refuses only `h5py.ExternalLink` classes), so `group = h5["matrix"]` — outside
    every try — raised h5py's raw `KeyError: 'Unable to synchronously open object
    (component not found)'` at rc 1 with 0 output paths (MEASURED pre-fix; recorded in the
    builder's docstring). The refusal must name `/matrix`, say the link EXISTS but its
    target cannot be read (INV-3), leave nothing on disk (INV-8), and be a named refusal at
    rc 2, not a traceback (INV-9).
    """
    line = _run_refusal(tmp_path, "matrix-root-dangling-softlink")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"link exists but its target cannot be read" in line, (
        f"the refusal does not say the link exists but its target cannot be read: {line!r}")
    assert b"is not a group" not in line, (
        f"the refusal says 'is not a group', which is the FALSE diagnosis for a target "
        f"that does not resolve (#587): {line!r}")


def test_TEST_104_a_SoftLink_CHAIN_ending_nowhere_is_refused_BY_NAME(tmp_path):
    """TEST-104 [acceptance, INV-9 + INV-8 + INV-3] — #587: `/matrix` -> SoftLink("/hop") -> SoftLink("/does_not_exist_anywhere").

    The CHAIN spelling of the reach — the issue names "a link chain ending nowhere". A
    `getlink=True` inspection of `/matrix` sees only the member's OWN link (a SoftLink),
    so the ExternalLink leg passes it and the guarded read is what must name the defect.
    Same diagnosis as TEST-103 by design (the unreadable-target class) — the two rows are
    allowed to share it in `test_refusals.py`'s `SHARED_DIAGNOSIS_ALLOWED` with the WHY
    comment. Pre-fix this was the same raw KeyError traceback at rc 1, 0 output paths
    (MEASURED; recorded in the builder's docstring).
    """
    line = _run_refusal(tmp_path, "matrix-root-softlink-chain-ends-nowhere")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"link exists but its target cannot be read" in line, (
        f"the refusal does not say the link exists but its target cannot be read: {line!r}")


def test_TEST_105_an_ExternalLink_to_a_MISSING_file_pins_the_EXISTING_sentence(tmp_path):
    """TEST-105 [acceptance, INV-5] — #587: `/matrix` = ExternalLink to a MISSING file keeps the EXISTING "is an ExternalLink" refusal.

    `getlink=True` inspects the link WITHOUT following it, so the #450-leg ExternalLink
    refusal fires by name regardless of whether the target file exists. MEASURED on the
    0.14.0 base: rc 2, `filtered_feature_bc_matrix.h5's `/matrix` is an ExternalLink. ...`,
    0 output paths — the spelling was ALREADY claimed by the existing leg, so this test PINs
    the existing sentence and asserts NO second message was added for it (the new #587
    guarded subscript must not wrap an ExternalLink into "link exists but its target
    cannot be read" — that would be a diagnosis about the target when the link CLASS is
    the defect, and it would break the #450 diagnosis).
    """
    line = _run_refusal(tmp_path, "matrix-root-external-link-missing-target")
    assert line.startswith(PREFIX), line[:200]
    assert b"`/matrix`" in line, (
        f"the refusal does not name the member it refused: {line!r}")
    assert b"is an ExternalLink" in line, (
        f"the refusal does not use the EXISTING ExternalLink sentence (#450): {line!r}")
    assert b"link exists but its target cannot be read" not in line, (
        f"the new #587 leg swallowed the ExternalLink diagnosis — a link class is not an "
        f"unreadable-target defect: {line!r}")
    assert line == PREFIX + (
        b"filtered_feature_bc_matrix.h5's `/matrix` is an ExternalLink. A 10x feature-barcode "
        b"matrix stores its non-zero values, feature ids and column offsets INLINE under "
        b"`/matrix`; a group that is a link rather than an inline group is not a matrix this "
        b"importer can carry. Refusing rather than shipping a wrong matrix."
    ), (
        f"the ExternalLink sentence drifted from the pinned #450 bytes: {line[:400]!r}")


def test_TEST_106_the_ORDERING_canary_the_Dataset_bundle_still_yields_IS_NOT_A_GROUP(tmp_path):
    """TEST-106 [acceptance, INV-4] — THE BEHAVIORAL ORDERING CANARY (#587).

    `VisiumImportError` IS a `RuntimeError` subclass. The guarded-subscript try may catch
    the four resolution exceptions and re-wrap them — it must NEVER swallow the #585
    isinstance refusal that follows it and sits OUTSIDE the try: a widened try (or a lost
    `except VisiumImportError: raise`) turns the #585 Dataset-at-`/matrix` bundle into the
    "link exists but its target cannot be read" wrap — a FALSE diagnosis (the target DID
    resolve; it is just not a Group) that would replace the sentence TEST-99 pins. This
    canary drives the `matrix-root-inline-dataset` bundle and asserts the refusal is still
    the byte-pinned `_MATRIX_ROOT_NOT_A_GROUP` sentence and NEVER carries the guarded
    subscript's "cannot be read" wording. (The twin — the structural canary TEST-107 — is
    what catches the re-raise-deletion mutation, which is behaviorally invisible here.)
    """
    line = _run_refusal(tmp_path, "matrix-root-inline-dataset")
    assert line == PREFIX + _MATRIX_ROOT_NOT_A_GROUP, (
        f"the #585 Dataset-at-`/matrix` refusal no longer is the is-not-a-group sentence — "
        f"the new guarded subscript is swallowing the isinstance refusal (the ordering "
        f"trap): {line[:400]!r}")
    assert b"cannot be read" not in line, (
        f"the #585 Dataset case is reported as an unreadable TARGET, a false diagnosis "
        f"(the target resolved; it is just not a Group): {line[:400]!r}")


def test_TEST_107_the_STRUCTURAL_ordering_canary_pins_the_guarded_try_shape(tmp_path):
    """TEST-107 [acceptance, INV-4] — THE STRUCTURAL ORDERING CANARY (#587); `ast` on the shipped compute.

    The try around `group = h5["matrix"]` must (1) have `except VisiumImportError: raise`
    as its FIRST handler (a bare re-raise — the only thing that keeps a designed refusal
    from being re-wrapped by the tuple, which would catch it because `VisiumImportError`
    IS a `RuntimeError`), (2) have a body of EXACTLY that one assignment (minimal extent —
    this both proves the #585 isinstance refusal is OUTSIDE the try and reddens if the try
    is widened), (3) have EXACTLY FOUR plain `ast.Name` elements forming the
    `(KeyError, OSError, TypeError, RuntimeError)` tuple as its SECOND handler (a dotted
    exception — `h5py.Error`, `np.AxisError` — added as a fifth element parses as an
    `ast.Attribute` and reddens both the count and the all-Name check), and (4) keep the
    `if not isinstance(group, h5py.Group)` refusal as a
    SIBLING of the try, not inside it. This is the mandatory leg: mutation A (deleting the
    re-raise clause, minimal try kept) is behaviorally INVISIBLE — nothing in the minimal
    try can raise `VisiumImportError` — so only a structural pin sees it. The scan targets
    the EXECUTABLE `Assign` node (a comment reword cannot satisfy it); there is exactly one
    `group = h5["matrix"]` in the module (grep-verified on the base).
    """
    import ast

    source = HF.COMPUTE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    parent = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    def is_matrix_subscript(node):
        return (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name) and node.value.id == "h5"
                and isinstance(node.slice, ast.Constant) and node.slice.value == "matrix")

    targets = [n for n in ast.walk(tree)
               if (isinstance(n, ast.Assign) and len(n.targets) == 1
                   and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "group"
                   and is_matrix_subscript(n.value))]
    assert len(targets) == 1, (
        f"expected exactly one `group = h5[\"matrix\"]` Assign in the compute, found "
        f"{len(targets)} — the structural canary no longer knows which site to pin")
    assign = targets[0]

    enclosing = parent.get(assign)
    assert isinstance(enclosing, ast.Try), (
        "`group = h5[\"matrix\"]` is NOT inside a `try` — the #587 guarded-subscript leg "
        "has gone missing (a full revert of the compute fix reddens this test)")
    try_node = enclosing

    assert len(try_node.body) == 1 and try_node.body[0] is assign, (
        "the guarded `try` body is not exactly `group = h5[\"matrix\"]` — the try has been "
        "WIDENED, so it can swallow the #585 isinstance refusal into the tuple handler "
        "(MUTATION B) — a widened try is the ordering trap")

    handlers = try_node.handlers
    assert len(handlers) == 2, (
        f"the guarded `try` has {len(handlers)} handlers; the shape is exactly two "
        "(the `except VisiumImportError: raise` first, the four-type tuple second)")

    first = handlers[0]
    assert (isinstance(first.type, ast.Name) and first.type.id == "VisiumImportError"), (
        f"the FIRST handler is {ast.dump(first.type) if first.type else 'bare'}, not "
        "`except VisiumImportError:` — the re-raise clause has been deleted or reordered "
        "(MUTATION A); `VisiumImportError` IS a `RuntimeError`, so with it gone the tuple "
        "would catch a designed refusal and re-wrap it")
    assert (len(first.body) == 1 and isinstance(first.body[0], ast.Raise)
            and first.body[0].exc is None), (
        "the first handler is not a BARE `raise` — an `except VisiumImportError:` that "
        "does something other than re-raise is the same trap one step later")

    second = handlers[1]
    assert isinstance(second.type, ast.Tuple), (
        f"the SECOND handler's type is not a tuple: {ast.dump(second.type)}")
    # The tuple must be EXACTLY the four plain names. A set built only from `ast.Name`
    # elements is fails-open: a DOUBLED exception in dotted form (`h5py.Error`,
    # `np.AxisError`) parses as an `ast.Attribute`, is silently dropped by a Name-filtered
    # comprehension, and leaves the canary green while DEC-3's "the tuple is NOT widened"
    # ruling is broken. So require the exact element count AND that every element is a
    # plain `ast.Name` BEFORE building the caught set.
    assert len(second.type.elts) == 4, (
        f"the guarded subscript catches {len(second.type.elts)} exception types, not "
        "exactly four — a widened handler (an added dotted exception such as `h5py.Error`) "
        "must not slip past the canary")
    assert all(isinstance(elt, ast.Name) for elt in second.type.elts), (
        f"the guarded subscript's tuple carries a non-Name element: {ast.dump(second.type)} "
        "-- `not isinstance(elt, ast.Name)` (a dotted exception such as `h5py.Error` or "
        "`np.AxisError`) must not slip past the canary")
    caught = {elt.id for elt in second.type.elts}
    assert caught == {"KeyError", "OSError", "TypeError", "RuntimeError"}, (
        f"the guarded subscript catches {sorted(caught)}, not exactly "
        "`(KeyError, OSError, TypeError, RuntimeError)` — the reaching exceptions for an "
        "unresolvable target")

    isinstance_nodes = [n for n in ast.walk(tree)
                        if isinstance(n, ast.If)
                        and isinstance(n.test, ast.UnaryOp) and isinstance(n.test.op, ast.Not)
                        and isinstance(n.test.operand, ast.Call)
                        and isinstance(n.test.operand.func, ast.Name)
                        and n.test.operand.func.id == "isinstance"
                        and len(n.test.operand.args) == 2
                        and isinstance(n.test.operand.args[0], ast.Name)
                        and n.test.operand.args[0].id == "group"
                        and isinstance(n.test.operand.args[1], ast.Attribute)
                        and isinstance(n.test.operand.args[1].value, ast.Name)
                        and n.test.operand.args[1].value.id == "h5py"
                        and n.test.operand.args[1].attr == "Group"]
    assert len(isinstance_nodes) == 1, (
        f"the `if not isinstance(group, h5py.Group)` refusal was not found exactly once "
        f"({len(isinstance_nodes)} matches) — the #585 leg has moved or gone")
    anc = isinstance_nodes[0]
    while anc in parent:
        if parent[anc] is try_node:
            raise AssertionError(
                "the #585 `isinstance(group, h5py.Group)` refusal is INSIDE the guarded "
                "try — a widened try (MUTATION B) swallows it into the tuple handler; it "
                "must stay OUTSIDE, a sibling of the try")
        anc = parent[anc]


def test_TEST_108_the_unreadable_target_refusal_MESSAGE_is_pinned(tmp_path):
    """TEST-108 [acceptance, INV-9 + INV-3] — the #587 sentence, verbatim (TEST-99 style).

    The sentence must say the link EXISTS but its target cannot be read, quote the cause
    ONLY through `_quoted_for_refusal(exc, noun='message')` (the funnel the ASTM classifier
    accepts), and never the generic templates ("identity cannot be determined") nor the
    #585 "is not a group" diagnosis — the value DID exist as a link; the defect is that
    its target does not resolve.
    """
    line = _run_refusal(tmp_path, "matrix-root-dangling-softlink")
    assert line == PREFIX + _MATRIX_LINK_UNREADABLE, (
        f"the refusal line no longer matches the pinned #587 sentence: {line[:400]!r}")
    for forbidden in (b"is not a group", b"identity cannot be determined",
                      b"Traceback", b"KeyError:"):
        assert forbidden not in line, (
            f"the pinned message carries {forbidden!r}, which is a FALSE diagnosis or a "
            f"leak (#587): {line[:400]!r}")
    assert line.isascii(), (
        f"the pinned message is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_109_a_SAME_FILE_SoftLink_CHAIN_to_a_GROUP_still_imports(tmp_path):
    """TEST-109 [acceptance, INV-5] — THE OVER-REFUSAL CONTROL for #587, CHAIN spelling.

    `/matrix` -> SoftLink("/hop") -> SoftLink("/matrix_copy") where `matrix_copy` is a
    legitimate matrix GROUP (mutation PROVEN by re-opening: both links are `h5py.SoftLink`s
    and the chain resolves to the Group). The #587 leg is the first thing that looks at
    links at `/matrix`; a check written on the LINK (refusing any SoftLink — or any
    non-resolvable-looking link) would over-refuse exactly this legitimate bundle. TEST-101
    pins the one-hop spelling (re-cited); this test pins the CHAIN spelling — the deepest
    form of the over-refusal — because the fix is about links. The builder is a CONTROL,
    deliberately NOT an `HB.REFUSALS` row: the importer MUST ACCEPT this bundle.
    """
    root = HB.a_matrix_whose_MATRIX_is_a_SAME_FILE_SoftLink_CHAIN_to_a_GROUP(tmp_path)
    inputs, _ordinals = HF.staged_flat(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert b"cannot be read" not in result.stderr, (
        "the chain-to-Group bundle was refused as unreadable — the #587 check "
        "over-refuses a legitimate GROUP reached through a link chain: "
        f"{result.stderr[-2000:]!r}")
    assert HF.output_paths(tmp_path / "out"), (
        "the chain-to-Group control wrote no store — the rc 0 above proves nothing if "
        "the importer produced nothing")
    assert (tmp_path / "out" / "manifest.json").is_file(), (
        "the chain-to-Group control wrote no manifest.json — the rc 0 above proves "
        "nothing if the importer produced no store")


# ── TEST-110..112: #648 — the ROOT-ATTRIBUTE read, the unguarded materialisation. The
#    generic sweeps (TEST-8/TEST-9 over `HB.REFUSALS`) cover the new row; these tests pin
#    the CONTENT — the raw-read re-proof (the unguarded read's own proven outcome), the
#    named refusal through the shipped entrypoint with the 10x identity fact, the
#    unmutated positive control, and the structural AST canary on the new guarded try.


def _assert_unmaterialisable_root_attributes(matrix_path):
    r"""The RAW reader still RAISES on the planted file — the unguarded read's proven outcome.

    This is the structural half of "the mutation is real": through the actual h5py, on the
    actual corrupted file, `dict(h5.attrs)` raises the exact exception the unguarded module
    leaked as a traceback at rc 1 (measured on this base before the fix). A test that only
    asserted the fixed entrypoint's rc 2 could go green with a mutation that never raised
    and never ran.
    """
    import h5py

    with h5py.File(matrix_path, "r") as handle:
        with pytest.raises(OSError) as excinfo:
            dict(handle.attrs)
    # THE `"input buffer"` WORDING ASSERTION IS COUPLED TO HDF5/h5py's error wording ON
    # PURPOSE: the exception CLASS is what `pytest.raises(OSError)` pins, and the wording
    # is only cosmetically asserted so a silently-different failure cannot pass — if h5py
    # ever rewords the error, the class assertion still holds and only this line moves.
    assert "input buffer" in str(excinfo.value), str(excinfo.value)


def test_TEST_110_a_corrupt_ROOT_ATTRIBUTE_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-110 [acceptance INV-1, INV-2] — B12: the matrix file's ROOT ATTRIBUTES cannot be read.

    #648. The LAST UNGUARDED ATTRIBUTE-MATERIALISATION read in this module's matrix block
    — and the one read of the file's ROOT OBJECT with no guard at all: `attrs =
    dict(h5.attrs)` MATERIALISES every root attribute, and a corrupted attribute (here: a
    vlen string whose global-heap object length is overwritten) makes h5py raise while
    materialising. MEASURED pre-fix through the shipped entrypoint on this base:

        rc=1  paths=0
        OSError: Can't synchronously read data (ran off end of input buffer while
                 decoding)
          import_visium_hd.py:3039  run_import  ->  attrs = dict(h5.attrs)

    A raw traceback at exit 1 with absolute source paths — INV-1's prohibited outcome.
    Post-fix the refusal names the member and states the 10x fact:

        filtered_feature_bc_matrix.h5's root attributes cannot be read (...). A 10x
        feature-barcode matrix carries its identity there: `library_ids`,
        `software_version`, `chemistry_description` and `filetype`. A file whose root
        attributes cannot be materialised cannot be named by this importer, and its
        coordinate frame cannot be declared. Check that the matrix file is complete,
        or re-export the Space Ranger `binned_outputs/` bundle. Refusing rather than
        shipping a matrix this importer cannot describe.

    This test asserts all of the #648 proof: (1) the mutation really changed the file
    (bytes differ from the committed fixture), (2) the raw read STILL RAISES through real
    h5py with `OSError` (`_assert_unmaterialisable_root_attributes` — the exact exception
    the unguarded module leaked as a raw traceback at rc 1), (3) the SHIPPED entrypoint
    (`HF.run_entry_bytes`, the `CYTO_INPUTS_DIR`/`CYTO_OUTPUTS_DIR` seam, bundle-slot
    staging as TEST-8 arm 2 does) turns it into the NAMED refusal at the refusal exit code
    2 — never 1, (4) stderr has NO `Traceback` and EXACTLY ONE non-progress row, starting
    `spatial.import-visium-hd: ` and carrying every needle: `root attributes`,
    `cannot be read`, the 10x identity fact `library_ids`, `cannot be materialised` and
    the HD remedy `binned_outputs`, (5) ZERO paths on disk — `HF.output_paths(...) == []`,
    no `manifest.json`, no `expression.zarr` (INV-2's no-store promise, read-before-first-
    writer by ordering). The unmutated positive control is TEST-111; the structural canary
    on the guarded try is TEST-112.
    """
    root = HB.a_matrix_with_a_CORRUPT_root_attribute(tmp_path / "matrix-corrupt-root-attribute")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    # (1) the mutation really changed the file — never a no-op. The corruption itself
    # is an in-place overwrite of 8 bytes, so the comparison is against the committed
    # fixture bytes the copy started from.
    assert matrix.read_bytes() != source.read_bytes(), (
        "the corruption did not change the matrix file's bytes")
    # (2) the raw read still raises through real h5py (the unguarded read's own outcome).
    _assert_unmaterialisable_root_attributes(matrix)

    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")

    # (3)+(4)+(5): named refusal at the refusal exit code, no traceback, one row, ZERO paths.
    assert result.returncode == 2, (
        f"the corrupt-root-attribute bundle exited {result.returncode}, not 2 — a refusal "
        f"that escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-root-attribute bundle produced a TRACEBACK rather than a named "
        f"refusal:\n{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"root attributes", b"cannot be read", b"library_ids",
                   b"cannot be materialised", b"binned_outputs"):
        assert needle in line, (
            f"the refusal does not carry the needle {needle!r} — the message must name the "
            f"offence, the 10x identity fact and the remedy: {line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_111_the_unmutated_fixture_still_imports_through_the_same_run_path(tmp_path):
    r"""TEST-111 [acceptance INV-1] — the positive control: absent is not never-ran (#648).

    The corrupted-bundle test proves the refusal; THIS proves the mutation is what the
    refusal is about. The UNMUTATED committed fixture is driven through the SAME shipped
    entrypoint (`HF.run_entry_bytes`, the `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR` seam,
    the same `HF.staged_tree` + bundle-slot staging as TEST-110) and must import at rc 0
    with a real manifest — the same import that the guard must NOT newly refuse. What
    this positive control reddens on is OVER-REFUSAL of a VALID bundle (an over-broad
    guard would refuse this bundle at rc 2); the structural detection of POSITION or
    MEMBERSHIP widening is TEST-112's AST canary (the try pinned to exactly one
    assignment, the tuple to the six names) — this test is the no-NEW-refusal
    control, not a position/membership probe. The ZERO-PATH content of INV-2 (a refused import leaves
    no store, no partial store and nothing for a later reader to find) is asserted by
    TEST-110; THIS test is the INV-1-side positive control — the VALID path is not newly
    refused — and it is what makes "a refused import leaves no store" mean anything: a
    suite that never runs the entrypoint satisfaces an empty-outputs assertion vacuously.
    """
    root = HF.staged_tree(tmp_path / "ok-bundle")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert b"root attributes" not in result.stderr, (
        f"the good bundle was refused over its root attributes — the #648 check "
        f"over-refuses: {result.stderr[-2000:]!r}")
    assert b"cannot be read" not in result.stderr, (
        f"the good bundle was refused as unreadable — the #648 check over-refuses: "
        f"{result.stderr[-2000:]!r}")
    manifest = json.loads((tmp_path / "out" / "manifest.json").read_text(encoding="utf-8"))
    ids = sorted(e["id"] for e in manifest["outputs"])
    assert ids, "a successful import must produce outputs"
    assert "single-cell/counts" in {e.get("datatype") for e in manifest["outputs"]}, ids
    assert HF.output_paths(tmp_path / "out"), (
        "the control run wrote no store — the rc 0 above proves nothing if the importer "
        "produced nothing")


def test_TEST_112_the_STRUCTURAL_canary_pins_the_new_guarded_attrs_read(tmp_path):
    """TEST-112 [acceptance] — THE STRUCTURAL CANARY on the #648 guarded try (#517); `ast` on the shipped compute.

    The try around `attrs = dict(h5.attrs)` must (1) have `except VisiumImportError: raise`
    as its FIRST handler (a bare re-raise — the only thing that keeps a designed refusal
    being from re-wrapped by the tuple, which would catch it because `VisiumImportError`
    IS a `RuntimeError`), (2) have a body of EXACTLY that one assignment (minimal extent —
    this both proves `refuse_unencodable_vendor_text` is OUTSIDE the try and reddens if the
    try is widened), (3) have EXACTLY SIX plain `ast.Name` elements forming the
    `(KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError)` tuple as its
    SECOND handler — a dotted exception (`h5py.Error`, `np.AxisError`) added as a seventh
    element parses as an `ast.Attribute` and reddens both the count and the all-Name check
    — and (4) keep the `refuse_unencodable_vendor_text(...)` parse boundary as a SIBLING
    AFTER the try, not inside it.

    This is the A12 load-bearing leg: mutation A (deleting the re-raise clause, minimal try
    kept) is behaviorally INVISIBLE — nothing in the one-expression minimal try can raise
    `VisiumImportError` — so only a structural pin sees it. The discipline is the sibling's
    (#517's `test_runtimeerror_guard_ordering.py` re-raise-first structural test, whose
    issue made that guard unfalsifiable-without-it), and HD's own TEST-107 pins the
    `/matrix` guarded subscript the same way; this canary extends it to the attribute read
    because the HD suite has no global re-raise-first walk. MEASURED reddening on this
    branch by scratch mutation (pycache purged): deleting the
    `except VisiumImportError: raise` line from the shipped compute made THIS test FAIL
    with "the guarded `try` has 1 handlers; the shape is exactly two" (the two-handler
    assertion fires first; with it gone the tuple handler would be index 0 and would
    re-wrap a designed refusal); restoring the line made it PASS — the canary is live,
    not decorative. TEST-29's completeness rule is why
    #517 is cited here: the `scan()` sweep covers every `.py` under the package, so this
    citation is what keeps the issue-state snapshot's `517: CLOSED` entry non-stale.
    """
    import ast

    source = HF.COMPUTE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    parent = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    def is_attrs_materialisation(node):
        return (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name) and node.func.id == "dict"
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Attribute)
                and isinstance(node.args[0].value, ast.Name)
                and node.args[0].value.id == "h5"
                and node.args[0].attr == "attrs")

    targets = [n for n in ast.walk(tree)
               if (isinstance(n, ast.Assign) and len(n.targets) == 1
                   and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "attrs"
                   and is_attrs_materialisation(n.value))]
    assert len(targets) == 1, (
        f"expected exactly one `attrs = dict(h5.attrs)` Assign in the compute, found "
        f"{len(targets)} — the structural canary no longer knows which site to pin")
    assign = targets[0]

    enclosing = parent.get(assign)
    assert isinstance(enclosing, ast.Try), (
        "`attrs = dict(h5.attrs)` is NOT inside a `try` — the #648 guarded-read leg "
        "has gone missing (a full revert of the compute fix reddens this test)")
    try_node = enclosing

    assert len(try_node.body) == 1 and try_node.body[0] is assign, (
        "the guarded `try` body is not exactly `attrs = dict(h5.attrs)` — the try has been "
        "WIDENED, so it can swallow the `refuse_unencodable_vendor_text` parse boundary "
        "into the tuple handler (MUTATION B) — a widened try is the ordering trap")

    handlers = try_node.handlers
    assert len(handlers) == 2, (
        f"the guarded `try` has {len(handlers)} handlers; the shape is exactly two "
        "(the `except VisiumImportError: raise` first, the six-type tuple second)")

    first = handlers[0]
    assert (isinstance(first.type, ast.Name) and first.type.id == "VisiumImportError"), (
        f"the FIRST handler is {ast.dump(first.type) if first.type else 'bare'}, not "
        "`except VisiumImportError:` — the re-raise clause has been deleted or reordered "
        "(MUTATION A); `VisiumImportError` IS a `RuntimeError`, so with it gone the tuple "
        "would catch a designed refusal and re-wrap it")
    assert (len(first.body) == 1 and isinstance(first.body[0], ast.Raise)
            and first.body[0].exc is None), (
        "the first handler is not a BARE `raise` — an `except VisiumImportError:` that "
        "does something other than re-raise is the same trap one step later")

    second = handlers[1]
    assert isinstance(second.type, ast.Tuple), (
        f"the SECOND handler's type is not a tuple: {ast.dump(second.type)}")
    # The tuple must be EXACTLY the six plain names, in order. A set built only from
    # `ast.Name` elements is fails-open: a DOUBLED exception in dotted form (`h5py.Error`,
    # `np.AxisError`) parses as an `ast.Attribute`, is silently dropped by a Name-filtered
    # comprehension, and leaves the canary green while the six-name fence is broken. So
    # require the exact element count AND that every element is a plain `ast.Name` BEFORE
    # binding the ordered list.
    assert len(second.type.elts) == 6, (
        f"the guarded read catches {len(second.type.elts)} exception types, not exactly "
        "six — a widened handler (an added dotted exception such as `h5py.Error`) must not "
        "slip past the canary")
    assert all(isinstance(elt, ast.Name) for elt in second.type.elts), (
        f"the guarded read's tuple carries a non-Name element: {ast.dump(second.type)} "
        "-- `not isinstance(elt, ast.Name)` (a dotted exception such as `h5py.Error` or "
        "`np.AxisError`) must not slip past the canary")
    caught = [elt.id for elt in second.type.elts]
    assert caught == ["KeyError", "OSError", "TypeError", "ValueError", "RuntimeError",
                      "OverflowError"], (
        f"the guarded read catches {caught}, not exactly "
        "`(KeyError, OSError, TypeError, ValueError, RuntimeError, OverflowError)` — the "
        "reaching exceptions for an unmaterialisable root attribute, ValueError/OverflowError "
        "included because materialising an attribute allocates `numpy.zeros(shape, dtype)` "
        "from the FILE-DECLARED dataspace dims (the a788ec896 rationale)")

    boundary_calls = [n for n in ast.walk(tree)
                      if (isinstance(n, ast.Call)
                          and isinstance(n.func, ast.Name)
                          and n.func.id == "refuse_unencodable_vendor_text"
                          and len(n.args) >= 1
                          and isinstance(n.args[0], ast.Name)
                          and n.args[0].id == "attrs")]
    # The module has TWO `refuse_unencodable_vendor_text` calls: the scalefactors
    # boundary (`doc`) and THIS parse boundary (`attrs`) — the `attrs`-argument one
    # is the membership line this canary pins.
    assert len(boundary_calls) == 1, (
        f"the root-attributes `refuse_unencodable_vendor_text(attrs, ...)` parse boundary "
        f"was not found exactly once ({len(boundary_calls)} matches) — its membership line "
        f"has moved or gone")
    boundary = boundary_calls[0]
    anc = boundary
    while anc in parent:
        if parent[anc] is try_node:
            raise AssertionError(
                "the `refuse_unencodable_vendor_text` parse boundary is INSIDE the guarded "
                "try — a widened try (MUTATION B) swallows it into the tuple handler; it "
                "must stay OUTSIDE, a sibling AFTER the try")
        anc = parent[anc]
    # The try and the boundary call are STATEMENTS in one `with`-block body; the call
    # node's own parent is its `Expr` statement, and both statements are children of
    # the same body (ast's `iter_child_nodes` flattens statement lists).
    guard_body = parent[try_node]
    assert hasattr(guard_body, "body"), (
        "the guarded try is not a statement of a block with a body — the canary cannot "
        "verify the boundary is its sibling")
    call_stmt = parent[boundary]
    assert isinstance(call_stmt, ast.Expr) and call_stmt in guard_body.body, (
        f"the `refuse_unencodable_vendor_text` call {ast.dump(call_stmt)[:80]} is not a "
        "SIBLING statement of the guarded try")
    assert guard_body.body.index(call_stmt) > guard_body.body.index(try_node), (
        "the `refuse_unencodable_vendor_text` parse boundary must come AFTER the guarded "
        "try — it reads `attrs`, and its semantics must not change")


# ── TEST-113..118: #650 — the four guarded DATASET reads' OSError gap + the one UNGUARDED
#    block scan (+ its guarded twin), closed with the #648/#471 narrow-guard shape. The
#    generic sweeps (TEST-8/TEST-9 over `HB.REFUSALS`) cover the five new rows; these tests
#    pin the CONTENT — the raw-read re-proof per member (the unguarded read's own proven
#    outcome), the named refusal through the shipped entrypoint with the member-named
#    needles, the ZERO-path proof, the absence-claim truthfulness leg, the twin-agreement
#    continuity pin, and the aggregated structural AST canary (the A12 load-bearing half
#    for the behaviourally-invisible mutations).


def _assert_corrupt_member_unreadable(matrix_path, member):
    r"""The RAW reader still RAISES on the planted file — the mutation's structural proof.

    The mirror of `_assert_unmaterialisable_root_attributes` (TEST-110): through the actual
    h5py, on the actual corrupted file, `handle["matrix/<member>"][:]` raises the exact
    exception class the unguarded module leaked as a traceback at rc 1 (measured on this
    base before the fix, per builder docstring). A test that only asserted the fixed
    entrypoint's rc 2 could go green with a mutation that never raised and never ran.
    """
    import h5py

    with h5py.File(matrix_path, "r") as handle:
        with pytest.raises(OSError) as excinfo:
            handle["matrix/" + member][:]
    # THE WORDING ASSERTION IS COUPLED TO HDF5/h5py'S ERROR WORDING ON PURPOSE: the
    # exception CLASS is what `pytest.raises(OSError)` pins, and the wording is only
    # cosmetically asserted so a silently-different failure cannot pass (the same
    # convention TEST-110 states for `input buffer`).
    assert "filter returned failure" in str(excinfo.value), str(excinfo.value)


def test_TEST_113_a_corrupt_SHAPE_chunk_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-113 [acceptance INV-1, INV-2] — #650 site :3088: `/matrix/shape` whose BYTES cannot be read.

    The shape guard's tuple was `(KeyError, ValueError, TypeError, RuntimeError)` — no
    `OSError` — so a dataset whose metadata is fine but whose bytes are undecodable (an
    unavailable filter, a truncated chunk, a checksum failure: here a fletcher32 chunk with
    one flipped byte) escaped `main()`'s `except VisiumImportError`. MEASURED pre-fix
    through the shipped entrypoint on this base:

        rc=1  paths=0
        File "/data/pbya/.../import_visium_hd.py", line 3088, in run_import
            shape = [int(x) for x in np.asarray(group["shape"][:]).tolist()]
        OSError: Can't synchronously read data (filter returned failure during read)

    A raw traceback with absolute source paths — INV-1's prohibited outcome. Post-fix the
    guard (six-name fence, `except VisiumImportError: raise` first — TEST-118 pins the
    shape) turns it into `has no readable \`/matrix/shape\` (OSError: ...)` at the refusal
    exit 2. This test asserts: (1) the mutation really changed the bytes, (2) the raw read
    STILL RAISES OSError (`_assert_corrupt_member_unreadable`), (3) the SHIPPED entrypoint
    exits rc 2 — never 1, (4) stderr has NO `Traceback` and EXACTLY ONE non-progress line
    starting `spatial.import-visium-hd: ` carrying `\`/matrix/shape\`` and `has no
    readable`, (5) ZERO paths on disk (INV-2). The tuple's structural pin is TEST-118; the
    positive control is TEST-111; the whole-table sweeps (TEST-8/TEST-9) cover the
    `matrix-corrupt-shape` row automatically.
    """
    root = HB.a_matrix_with_a_CORRUPT_shape_chunk(tmp_path / "matrix-corrupt-shape")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    assert matrix.read_bytes() != source.read_bytes(), (
        "the chunk corruption did not change the matrix file's bytes")
    _assert_corrupt_member_unreadable(matrix, "shape")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the corrupt-shape bundle exited {result.returncode}, not 2 — a refusal that "
        f"escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-shape bundle produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"`/matrix/shape`", b"has no readable"):
        assert needle in line, (
            f"the refusal does not name the member and the diagnosis {needle!r}: "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_114_a_corrupt_INDPTR_chunk_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-114 [acceptance INV-1, INV-2] — #650 site :3322: `/matrix/indptr` whose BYTES cannot be read.

    The indptr guard's tuple was `(KeyError, ValueError, TypeError, RuntimeError)` — no
    `OSError`/`OverflowError`. The member loop opens the dataset but reads no values
    (identity/dtype/shape only), so the fletcher32-corrupted chunk reaches the VALUE read
    `indptr = np.asarray(group["indptr"][:])` exactly — MEASURED pre-fix: rc 1, raw
    traceback at that line, 0 paths. Post-fix: named refusal at rc 2
    (`has no readable \`/matrix/indptr\` (OSError: ...)`). Same proof set as TEST-113:
    bytes-changed, raw-read re-raise (OSError), entrypoint rc 2, no Traceback, exactly one
    refusal line with `` `/matrix/indptr` `` + `has no readable`, ZERO paths, ASCII.
    """
    root = HB.a_matrix_with_a_CORRUPT_indptr_chunk(tmp_path / "matrix-corrupt-indptr")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    assert matrix.read_bytes() != source.read_bytes(), (
        "the chunk corruption did not change the matrix file's bytes")
    _assert_corrupt_member_unreadable(matrix, "indptr")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the corrupt-indptr bundle exited {result.returncode}, not 2 — a refusal that "
        f"escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-indptr bundle produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"`/matrix/indptr`", b"has no readable"):
        assert needle in line, (
            f"the refusal does not name the member and the diagnosis {needle!r}: "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_115_a_corrupt_BARCODES_chunk_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-115 [acceptance INV-1, INV-2] — #650 site :725: the `decoded_h5_strings` RAW read omits OSError.

    `raw = group[name][:]` ("barcodes") — the read whose `except` tuple was
    `(ValueError, TypeError, RuntimeError)` with OSError missing. MEASURED pre-fix through
    the shipped entrypoint on this base:

        rc=1  paths=0
        File "/data/pbya/.../import_visium_hd.py", line 725, in decoded_h5_strings
            raw = group[name][:]
        OSError: Can't synchronously read data (filter returned failure during read)

    Post-fix the refusal is the NEW `OSError` arm: `\`/matrix/barcodes\` is present but its
    bytes cannot be read (...) Refusing rather than importing a matrix whose identities
    cannot be read.` — it says the member is PRESENT, and the ABSENCE sentence
    `has no \`/matrix/barcodes\`` must be ABSENT from stderr (the sibling's rule: a member
    that exists but cannot be read must never be reported as absent — the sibling's TEST-86
    asserts this exact pair). Also asserts: bytes-changed, raw-read re-raise (OSError),
    entrypoint rc 2, no Traceback, exactly one refusal line, ZERO paths, ASCII.
    """
    root = HB.a_matrix_with_a_CORRUPT_barcodes_chunk(tmp_path / "matrix-corrupt-barcodes")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    assert matrix.read_bytes() != source.read_bytes(), (
        "the chunk corruption did not change the matrix file's bytes")
    _assert_corrupt_member_unreadable(matrix, "barcodes")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the corrupt-barcodes bundle exited {result.returncode}, not 2 — a refusal that "
        f"escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-barcodes bundle produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"`/matrix/barcodes`", b"is present but its bytes cannot be read"):
        assert needle in line, (
            f"the refusal does not name the member and the PRESENT-but-unreadable diagnosis "
            f"{needle!r}: {line[:400]!r}")
    assert b"has no" not in line, (
        f"the refusal claims the member is ABSENT when its bytes cannot be read — the "
        f"sibling's truthfulness rule: {line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_116_a_corrupt_INDICES_chunk_is_a_named_refusal_through_the_entrypoint(tmp_path):
    r"""TEST-116 [acceptance INV-1, INV-2] — #650 site :3510: the UNGUARDED indices block scan.

    `blk = np.asarray(ind_ds[lo:min(lo + step, nnz)])` had NO try at all while its twin
    (`/matrix/data` — the guarded read is at post-edit :3792 in this tree, base :3693) was
    guarded — the asymmetry #650 is about. MEASURED pre-fix
    through the shipped entrypoint on this base, VERBATIM:

        rc=1  paths=0
        Traceback (most recent call last):
          File "/data/pbya/.../import_visium_hd.py", line 4432, in <module>
            main()
          File "/data/pbya/.../import_visium_hd.py", line 4422, in main
            entries = run_import(bundle, outputs_dir, requested_bin=requested,
          File "/data/pbya/.../import_visium_hd.py", line 3510, in run_import
            blk = np.asarray(ind_ds[lo:min(lo + step, nnz)])
          ...
        OSError: Can't synchronously read data (filter returned failure during read)

    A raw traceback with ABSOLUTE source paths — INV-1's prohibited outcome — and 0 paths on
    disk; the IDENTICAL corruption in `/matrix/data` refused by name at rc 2 on the same
    base. Post-fix: the scan is guarded exactly like its twin (six-name fence — TEST-118
    pins both tuples EQUAL), refusing `\`/matrix/indices\` cannot be read (...) at exit 2.
    This test asserts: bytes-changed, raw-read re-raise (OSError), entrypoint rc 2, no
    Traceback, exactly one refusal line with `` `/matrix/indices` `` + `cannot be read`,
    ZERO paths, ASCII — the asymmetry closed.
    """
    root = HB.a_matrix_with_a_CORRUPT_indices_chunk(tmp_path / "matrix-corrupt-indices")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    assert matrix.read_bytes() != source.read_bytes(), (
        "the chunk corruption did not change the matrix file's bytes")
    _assert_corrupt_member_unreadable(matrix, "indices")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the corrupt-indices bundle exited {result.returncode}, not 2 — a refusal that "
        f"escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-indices bundle produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"`/matrix/indices`", b"cannot be read"):
        assert needle in line, (
            f"the refusal does not name the member and the diagnosis {needle!r}: "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_117_the_data_twin_scan_STILL_refuses_the_same_corruption(tmp_path):
    r"""TEST-117 [acceptance INV-1, INV-2] — #650 site (post-edit :3792 / base :3693): the guarded twin still refuses.

    The twin agreement pin: the SAME corruption class in `/matrix/data` was ALREADY a named
    refusal on the base (measured rc 2 — the asymmetry's other half), and the six-name
    widening this node applies must NOT break that. The row/behaviour is deliberately NOT a
    discrimination test for a NEW guard (the twin's OSError arm pre-dates this node; the
    discrimination of the widened tuple is TEST-118's structural assertion) — it pins the
    twins' AGREEMENT in behaviour: both halves of the same matrix, corrupt in the same way,
    each produce ONE named `spatial.import-visium-hd: ` refusal at rc 2 with NOTHING on
    disk. Asserts: bytes-changed, raw-read re-raise (OSError), entrypoint rc 2, no
    Traceback, exactly one refusal line with `` `/matrix/data` `` + `cannot be read`,
    ZERO paths, ASCII.
    """
    root = HB.a_matrix_with_a_CORRUPT_data_chunk(tmp_path / "matrix-corrupt-data")
    matrix = root / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    source = HF.FIXTURE / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5"
    assert matrix.read_bytes() != source.read_bytes(), (
        "the chunk corruption did not change the matrix file's bytes")
    _assert_corrupt_member_unreadable(matrix, "data")
    inputs = _staged(tmp_path, root)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 2, (
        f"the corrupt-data bundle exited {result.returncode}, not 2 — a refusal that "
        f"escapes `main()` reaches the user as a traceback.\nstderr: {result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"the corrupt-data bundle produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")
    line = _refusal_line(result.stderr)
    assert HF.output_paths(tmp_path / "out") == [], (
        f"the refusal left paths under /outputs — INV-2's promise is that a refused import "
        f"leaves NO store and no partial store: {HF.output_paths(tmp_path / 'out')[:12]}")
    assert line.startswith(PREFIX), line[:200]
    for needle in (b"`/matrix/data`", b"cannot be read"):
        assert needle in line, (
            f"the refusal does not name the member and the diagnosis {needle!r}: "
            f"{line[:400]!r}")
    assert line.isascii(), (
        f"the refusal is not ASCII (TEST-9's one-line rule): {line[:200]!r}")


def test_TEST_118_the_STRUCTURAL_canary_pins_ALL_SIX_guarded_dataset_reads(tmp_path):
    """TEST-118 — THE STRUCTURAL CANARY over the six guarded tries #650 touches (#517).

    The TEST-107/TEST-112 discipline EXTENDED to every read this node guards. For each site
    (the shape read, the indptr read, the features resolution, the `decoded_h5_strings` raw
    read, the `indices` block scan and its `data` twin) the try must: (1) exist with a body
    of EXACTLY the one read expression (minimal extent — a widened try reddens, and this is
    what proves every parse boundary is OUTSIDE it), (2) have `except VisiumImportError:
    raise` as handler 0 (a bare re-raise — behaviourally invisible to delete in a
    one-expression try, so only this pin sees mutation A; `VisiumImportError` IS a
    `RuntimeError`, so a widened tuple written first would swallow the package's own named
    refusals), (3) carry EXACTLY the expected plain `ast.Name` elements in order — the
    six-name fence for shape/indptr/both scans, `(OSError, TypeError, RuntimeError)` for
    features, `(TypeError, ValueError, RuntimeError, OverflowError)` plus the separate
    `OSError` handler for raw (a dotted exception parses as `ast.Attribute` and reddens
    both the count and the all-Name check), and (4) keep the parse boundary a SIBLING AFTER
    the try. The twins' tuples are asserted EQUAL by construction, so the two block scans
    cannot diverge again in either direction.

    WHY THE FEATURES SITE IS PINNED STRUCTURALLY: `_refuse_aliased_matrix_members`
    resolves the SAME `group["features"]` before this site with the complete four-name
    tuple, so no entrypoint-observable bundle can currently reach the new arms — the fix
    is the truthfulness correction (RuntimeError no longer reports absence) plus
    defence-in-depth, and exactly like TEST-112's re-raise the only discriminator is the
    AST. The canary cites #517 (the sibling's re-raise-first structural precedent, whose
    issue made that guard unfalsifiable-without-it) — the citation is what keeps the
    issue-state snapshot's `517: CLOSED` entry non-stale under TEST-29's completeness rule
    (the `scan()` sweep covers every `.py` under the package, so the citation is required).
    """
    import ast

    source = HF.COMPUTE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    parent = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    def is_subscript(node, name):
        return (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name) and node.value.id == name
                and isinstance(node.slice, ast.Constant))

    def is_member_slice(node, member):
        # `group["<member>"][:]` — the subscript the whole-member reads use.
        return (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Subscript)
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "group"
                and isinstance(node.value.slice, ast.Constant)
                and node.value.slice.value == member
                and isinstance(node.slice, ast.Slice))

    def is_named_member_slice(node):
        # `group[name][:]` — the parameterised `decoded_h5_strings` read.
        return (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Subscript)
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "group"
                and isinstance(node.value.slice, ast.Name)
                and node.value.slice.id == "name"
                and isinstance(node.slice, ast.Slice))

    def is_asarray_call(node):
        return (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute) and node.func.attr == "asarray")

    def is_dataset_slice_read(node, holder):
        # `holder[lo:min(lo + step, ...)]` — the bounded block reads.
        return (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name) and node.value.id == holder
                and isinstance(node.slice, ast.Slice))

    def find(assign_target, pred):
        out = []
        for node in ast.walk(tree):
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == assign_target and pred(node.value)):
                out.append(node)
        return out

    def contains_shape_read(node):
        for n in ast.walk(node):
            if (is_asarray_call(n) and len(n.args) >= 1
                    and is_member_slice(n.args[0], "shape")):
                return True
        return False

    sites = [
        dict(
            label="`shape = [int(x) for x in np.asarray(group[\"shape\"][:]).tolist()]`",
            nodes=find("shape", lambda v: isinstance(v, ast.ListComp)
                       and contains_shape_read(v)),
            handlers=[("reraise",), ("tuple", ["KeyError", "OSError", "TypeError",
                                               "ValueError", "RuntimeError", "OverflowError"])],
            boundary=lambda n: (isinstance(n, ast.If)
                                and isinstance(n.test, ast.Compare)
                                and isinstance(n.test.left, ast.Call)
                                and isinstance(n.test.left.func, ast.Name)
                                and n.test.left.func.id == "len"
                                and len(n.test.left.args) == 1
                                and isinstance(n.test.left.args[0], ast.Name)
                                and n.test.left.args[0].id == "shape"),
        ),
        dict(
            label="`indptr = np.asarray(group[\"indptr\"][:])`",
            nodes=find("indptr", lambda v: is_asarray_call(v)
                       and len(v.args) >= 1 and is_member_slice(v.args[0], "indptr")),
            handlers=[("reraise",), ("tuple", ["KeyError", "OSError", "TypeError",
                                               "ValueError", "RuntimeError", "OverflowError"])],
            boundary=lambda n: (isinstance(n, ast.If)
                                and isinstance(n.test, ast.Compare)
                                and isinstance(n.test.left, ast.Attribute)
                                and isinstance(n.test.left.value, ast.Name)
                                and n.test.left.value.id == "indptr"
                                and n.test.left.attr == "ndim"),
        ),
        dict(
            label="`features = group[\"features\"]`",
            nodes=find("features", lambda v: is_subscript(v, "group")
                       and v.slice.value == "features"),
            handlers=[("reraise",), ("type", ["KeyError"]),
                      ("tuple", ["OSError", "TypeError", "RuntimeError"])],
            boundary=lambda n: (isinstance(n, ast.Assign) and len(n.targets) == 1
                                and isinstance(n.targets[0], ast.Name)
                                and n.targets[0].id == "gene_ids"
                                and isinstance(n.value, ast.Call)
                                and isinstance(n.value.func, ast.Name)
                                and n.value.func.id == "decoded_h5_strings"
                                and len(n.value.args) >= 1
                                and isinstance(n.value.args[0], ast.Name)
                                and n.value.args[0].id == "features"),
        ),
        dict(
            label="`raw = group[name][:]`",
            nodes=find("raw", lambda v: is_named_member_slice(v)),
            handlers=[("reraise",), ("type", ["KeyError"]),
                      ("tuple", ["TypeError", "ValueError", "RuntimeError", "OverflowError"]),
                      ("type", ["OSError"])],
            boundary=lambda n: (isinstance(n, ast.Assign) and len(n.targets) == 1
                                and isinstance(n.targets[0], ast.Name)
                                and n.targets[0].id == "out"
                                and isinstance(n.value, ast.List)
                                and len(n.value.elts) == 0),
        ),
        dict(
            label="`blk = np.asarray(ind_ds[lo:min(lo + step, nnz)])`",
            nodes=find("blk", lambda v: is_asarray_call(v)
                       and len(v.args) >= 1 and is_dataset_slice_read(v.args[0], "ind_ds")),
            handlers=[("reraise",), ("tuple", ["KeyError", "OSError", "TypeError",
                                               "ValueError", "RuntimeError", "OverflowError"])],
            boundary=lambda n: (isinstance(n, ast.If) and isinstance(n.test, ast.UnaryOp)
                                and isinstance(n.test.op, ast.Not)
                                and isinstance(n.test.operand, ast.Attribute)
                                and isinstance(n.test.operand.value, ast.Name)
                                and n.test.operand.value.id == "blk"
                                and n.test.operand.attr == "size"),
        ),
        dict(
            label="`blk = np.asarray(data_ds[lo:min(lo + step, len(data_ds))])`",
            nodes=find("blk", lambda v: is_asarray_call(v)
                       and len(v.args) >= 1 and is_dataset_slice_read(v.args[0], "data_ds")),
            handlers=[("reraise",), ("tuple", ["KeyError", "OSError", "TypeError",
                                               "ValueError", "RuntimeError", "OverflowError"])],
            boundary=lambda n: (isinstance(n, ast.If)
                                and isinstance(n.test, ast.Attribute)
                                and isinstance(n.test.value, ast.Name)
                                and n.test.value.id == "blk"
                                and n.test.attr == "size"),
        ),
    ]

    for site in sites:
        assert len(site["nodes"]) == 1, (
            f"expected exactly one {site['label']} in the compute, found "
            f"{len(site['nodes'])} — {site['label'][:60]} no longer unique; the canary "
            "cannot tell which site to pin")
        assign = site["nodes"][0]
        enclosing = parent.get(assign)
        assert isinstance(enclosing, ast.Try), (
            f"{site['label']} is NOT inside a `try` — the #650 guarded-read leg has gone "
            "missing (a full revert of the compute fix reddens this test)")
        try_node = enclosing
        assert len(try_node.body) == 1 and try_node.body[0] is assign, (
            f"the guarded `try` body is not exactly {site['label']} — the try has been "
            "WIDENED, so it can swallow the parse boundary into the tuple handler "
            "(MUTATION B)")
        handlers = try_node.handlers
        assert len(handlers) == len(site["handlers"]), (
            f"{site['label']}: guarded `try` has {len(handlers)} handlers; the shape is "
            f"exactly {len(site['handlers'])}")
        for index, (spec, handler) in enumerate(zip(site["handlers"], handlers)):
            if spec[0] == "reraise":
                assert (isinstance(handler.type, ast.Name)
                        and handler.type.id == "VisiumImportError"), (
                    f"{site['label']}: handler {index} is "
                    f"{ast.dump(handler.type) if handler.type else 'bare'}, not "
                    "`except VisiumImportError:` — the re-raise clause has been deleted or "
                    "reordered (MUTATION A); `VisiumImportError` IS a `RuntimeError`, so "
                    "with it gone the tuple would catch a designed refusal and re-wrap it")
                assert (len(handler.body) == 1 and isinstance(handler.body[0], ast.Raise)
                        and handler.body[0].exc is None), (
                    f"{site['label']}: handler {index} is not a BARE `raise`")
            elif spec[0] == "type":
                assert (isinstance(handler.type, ast.Name)
                        and handler.type.id == spec[1][0]), (
                    f"{site['label']}: handler {index} is "
                    f"{ast.dump(handler.type) if handler.type else 'bare'}, not "
                    f"`except {spec[1][0]}:`")
            else:
                assert isinstance(handler.type, ast.Tuple), (
                    f"{site['label']}: handler {index}'s type is not a tuple: "
                    f"{ast.dump(handler.type)}")
                elts = handler.type.elts
                assert len(elts) == len(spec[1]), (
                    f"{site['label']}: the guarded read catches {len(elts)} exception "
                    f"types, not exactly {len(spec[1])} — a widened handler (an added "
                    "dotted exception such as `h5py.Error`) must not slip past the canary")
                assert all(isinstance(e, ast.Name) for e in elts), (
                    f"{site['label']}: the tuple carries a non-Name element: "
                    f"{ast.dump(handler.type)} — a dotted exception such as `h5py.Error` "
                    "must not slip past the canary")
                caught = [e.id for e in elts]
                assert caught == spec[1], (
                    f"{site['label']}: the guarded read catches {caught}, not exactly "
                    f"{spec[1]}")

        # (v) the parse boundary must be a SIBLING AFTER the try, never inside it.
        guard_body = parent[try_node]
        assert hasattr(guard_body, "body"), (
            f"{site['label']}: the guarded try is not a statement of a block with a body")
        after = [st for st in guard_body.body[guard_body.body.index(try_node) + 1:]
                 if site["boundary"](st)]
        assert len(after) == 1, (
            f"{site['label']}: the parse boundary was not found exactly once AFTER the try "
            f"({len(after)} matches) — its membership line has moved, gone, or been pulled "
            "INSIDE the widened try (MUTATION B)")
        assert after[0] not in try_node.body, (
            f"{site['label']}: the parse boundary is INSIDE the guarded try — a widened "
            "try (MUTATION B) swallows it into the tuple handler")

    # The twins' tuples are EQUAL by construction — assert it once more on the two blk
    # sites' handler tuples so the agreement is a property of THIS test's finds, not of a
    # shared literal.
    blk_sites = [s for s in sites if s["label"].startswith("`blk =")]
    assert len(blk_sites) == 2
    tuples = []
    for site in blk_sites:
        handlers = parent.get(site["nodes"][0])
        assert isinstance(handlers, ast.Try)
        snd = handlers.handlers[1]
        assert isinstance(snd.type, ast.Tuple)
        tuples.append([e.id for e in snd.type.elts])
    assert tuples[0] == tuples[1], (
        f"the two block-scan twins disagree: {tuples[0]} vs {tuples[1]} — the twins must "
        "not diverge in either direction")
