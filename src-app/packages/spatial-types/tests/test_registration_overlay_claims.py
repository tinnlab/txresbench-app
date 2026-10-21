#!/usr/bin/env python3
# ruff: noqa
"""#302 — the shared modules' registration-overlay claims are FALSE, and this pins them.

GitHub issue #302: two SHARED modules under `spatial-types/compute/` carry prose claims
that have gone false, and the prose itself cannot be corrected on this branch:

  (A) `ome_writer.py`'s `_reconcile_scale` docstring and `spatial_declarations.py`'s
      `image_meta` docstring both say "#156's registration overlay is the only real
      check". A registration overlay now exists for ALL THREE producers — Visium (#156),
      Xenium (#301) and Visium HD (#313) — each wired in and emitting a report artifact,
      so the phrase is false wherever it appears.
  (B) `ome_writer.py`'s `_reconcile_scale` docstring says "`spatial-import-xenium` does
      that cross-check and refuses the image on a disagreement". #269 removed the
      refusal: `stated_scale_agreement()` now returns `(stated_scales, warning_or_None)`
      and the call site appends the warning to `pending_warnings`; the image is emitted.

## Why the prose could not be corrected HERE before #432, and what this guard is instead

The two modules are vendored BYTE-IDENTICALLY into all three importer packages, and the
copies are pinned by a web of checks — none of them a single 4-way comparison:
`test_ome_dtype_refusal.py::test_every_shipped_ome_writer_is_byte_identical` hashes ALL
FOUR `ome_writer.py` copies with sha256 and asserts one digest; xenium's
`test_vendored_contract.py` sha256-hashes source-vs-copies for BOTH shared modules;
visium-hd's compares `read_bytes()` for both; visium's compares `read_bytes()` for
`spatial_declarations.py` ONLY. Measured: a prose-only docstring edit to
`spatial-types/compute/ome_writer.py` alone turned 6 of 7 checked targets red —
including this package's own suite and `scripts/check-processor-seed-versions.sh` — with
only visium's vendored-contract test staying green. Editing the source alone reds this
package's own suite; fixing the prose requires an atomic four-package commit, which this
branch's ownership does not permit. That is a reported finding, not this guard's job.
The re-vendor was tracked as OPEN issue #432 (the claims were adjudicated in #302); THIS
branch lands that atomic four-package correction — the canonical modules and their three
vendored copies are re-vendored byte-identically, the retired sentences sit beside their
retirement markers (see below), and the allowlist shrinks to empty in the same commit.
The one hole recorded below — nothing else enforced that #432 stays open — is therefore
closed by the branch rather than by the guard, and the ratchet stays honest in the other
direction: a revert returns the claims as LIVE carriers and the `unlisted` half of
TEST-3 reddens, naming the files to re-list. The tests that certify the correction are
TEST-1, TEST-2, TEST-3 and TEST-4 in this file (below) — TEST-23 is TESTS.md's ID for
TEST-3's utf-8-explicit `_scan()` read, exercised inside TEST-3 — plus the byte-identity,
vendored-contract, manifest-bump and script guards listed in the added comment at
`STILL_CARRIED`.

This guard is the DURABLE half: it makes the staleness ASSERTABLE. It proves the two
claims are false — Layer 1 by DERIVING the overlay coverage, Layer 2 by checking that
`stated_scale_agreement` raises nothing about the data — and it pins where the claims
still live — Layer 3, a whole-tree scan against a shrinking allowlist, with Layer 4's
negative control holding the matcher honest. When the four-package fix lands, the
corrected files quote the claims beside a retirement marker — recognized whether it
trails or precedes the claim, because the marker window is symmetric — so they stop
carrying LIVE claims and the allowlist half fails, naming every entry to delete in one
run.

## The scan's true scope, stated so it is not over-read

The Layer 3 scan is `src-app/packages/*/compute/*.py` ONLY — not `tests/`, `libs/` or
`docs/`. The nearest thing to a retirement of this exact sentence OUTSIDE that scope is
`spatial-import-xenium/tests/test_scale_referent.py` (the "used to end" retirement of
the #156 sentence), and it does NOT match: line 924 quotes "#156's registration overlay
is the only real check, because the only remaining evidence is whether the cells land
on the tissue a human can see." — a THIRD continuation ("because the only remaining
evidence…"), neither the "and #176's TEST-11 measures the gap…" continuation nor the
full-stop variant in `RETIRED_CLAIMS`. So it would not match even if `tests/` were in
scope; the operative reason is the different continuation, not that it is a retirement.
The eight `STILL_CARRIED` entries are the LIVE carriers, not all carriers. An
allowlist's honest description is its holes.

## How the ratchet survives this repo's own correction idiom

The correction this codebase actually writes does NOT delete the sentence — it QUOTES it
and marks it as retired: `test_scale_referent.py` writes "The sentence here used to
end: …", `import_xenium.py` writes "0.4.0 REFUSED above a hard-coded `1e-6`" and "that
paragraph is corrected rather than removed, because a disclosure of absence and its
retirement are the same claim in two directions". So a corrected `ome_writer.py` would
STILL contain the verbatim claim string, and a matcher that counted any occurrence would
keep the allowlist green forever. Two mechanisms close that:

  * The claims are TERMINATED with their real continuations, so a corrected sentence
    stops matching: `ome_writer.py`'s claim (A) continues "…, and #176's TEST-11 measures
    the gap rather than pretending it is shut." while `spatial_declarations.py`'s ends
    with a full stop — two variants, recorded per file in `STILL_CARRIED`.
  * An occurrence adjacent to a retirement marker is classified as a
    `retired-quotation`, not a live carrier. The marker window is SYMMETRIC — this repo
    writes its retirements in both directions, `test_scale_referent.py` putting "used to
    end" BEFORE the quote and `import_xenium.py` putting "corrected rather than removed"
    AFTER it — and a marker only counts when a QUOTATION sits between it and the claim,
    so the "this assertion used to read X" sense of `used to read`/`used to say` cannot
    disarm a neighbouring live claim. Only LIVE occurrences are carriers, so when the fix
    lands the allowlist half fails and names the exact entries to delete.

## What this guard does NOT cover, stated so it is not over-read

* It CANNOT correct the prose. That needs the atomic four-package re-vendor (#432), and
  this branch is forbidden from touching the importer packages. It only proves the claims
  are FALSE and pins where they still live; it does not reword anything and it does not
  assert that corrected sentences exist.
* `WITHOUT_OVERLAY` — the set of writer-shipping packages with no `registration_qc.py` —
  is asserted EMPTY: every package that vendors `compute/ome_writer.py` must ship
  `compute/registration_qc.py`, and at least one of its `compute/import_*.py` files must
  CALL it. A producer without an overlay is EXACTLY the case the retired claim was
  written for, so if one is added deliberately the claim's correction must be revisited
  and this assertion updated on purpose — not silently.
* The retired-claim scan is a cheap tripwire on known-false sentences, not a semantic
  matcher. A REWORDED restatement that shares no phrase with `RETIRED_CLAIMS` is not
  caught — a past-tense rewording does NOT trip it. What trips it is QUOTING a retired
  claim verbatim, which is what an engineer writing the correction is likely to do; the
  fix when one trips is to add the file to `STILL_CARRIED` with a reason, or reword the
  quote.
* The allowlist is per FILE, so a second copy inside an allowlisted file is not caught
  (the same limit `staleClaims.test.ts` documents for its own). What the scan buys is
  protection against the claims spreading to a NEW file, and the ratchet that forces
  the allowlist to shrink when the four-package fix lands.
"""
import ast
import re
from pathlib import Path

_PACKAGES = Path(__file__).resolve().parents[2]

#: The canonical package — the one this test file lives in — derived from the file's own
#: location, never hardcoded (R9): `_vendors()` excludes it because it is the SOURCE of
#: the shared modules, not a consumer.
_CANONICAL = Path(__file__).resolve().parents[1].name

#: The claim sentences #302 names, TERMINATED with their real continuations (R1b). Each
#: is a PHRASE of at least six words (asserted in TEST-3) — short fragments are what
#: makes a prose scanner fire on ordinary English. Claim (A) continues DIFFERENTLY in
#: the two modules, so it is recorded as two variants: `ome_writer.py`'s sentence runs
#: on "…, and #176's TEST-11 measures the gap rather than pretending it is shut." while
#: `spatial_declarations.py`'s ends with a full stop. Terminating the claims is what
#: makes a corrected sentence stop matching: the correction this repo writes QUOTES the
#: old sentence, and an unterminated prefix would keep matching the quote forever.
RETIRED_CLAIMS = (
    "#156's registration overlay is the only real check, and #176's TEST-11 measures the "
    "gap rather than pretending it is shut.",
    "#156's registration overlay is the only real check.",
    "`spatial-import-xenium` does that cross-check and refuses the image on a "
    "disagreement.",
)

#: The retirement markers this repo actually writes (R1a): `test_scale_referent.py`
#: "The sentence here used to end: …", `import_xenium.py` "0.4.0 REFUSED above a
#: hard-coded `1e-6`" and "that paragraph is corrected rather than removed, because a
#: disclosure of absence and its retirement are the same claim in two directions", and
#: the "used to say"/"used to read" spellings scattered through the tree. The last two
#: are WEAK markers on their own: they appear in-tree predominantly in the "this
#: assertion used to read X" sense, which is retirement-adjacent but not by itself a
#: retirement of THESE claims — which is why a marker only counts when a QUOTATION sits
#: between it and the claim (see `_marker_adjacent_to_quote`). An occurrence of a
#: retired claim whose symmetric window contains one of these, adjacent to a quotation,
#: is the CORRECTION, not the defect. Matched case-insensitively, so "0.4.0 refused"
#: covers "0.4.0 REFUSED".
_RETIREMENT_MARKERS = (
    "used to end",
    "used to say",
    "used to read",
    "corrected rather than removed",
    "0.4.0 refused",
)

#: The ONLY files allowed to carry a retired claim as a LIVE assertion, as paths
#: relative to `_PACKAGES`. The guard's DESIGNED end-state is the empty dict: the
#: #432 four-package correction (committed with this shrink) re-vendors the corrected
#: `ome_writer.py` and `spatial_declarations.py` into all three importers, so every
#: occurrence of a retired claim now sits beside its retirement marker and a quotation
#: and is classified `retired-quotation` by `_live_claims_in`, not a live carrier. The
#: eight entries that used to live here (both modules x four packages, each reason
#: naming #432 and #302) were deleted in the same commit as this branch's re-vendor:
#: each of those eight occurrences is now a quoted retirement, so the `stale` half of
#: TEST-3 would name every one — the shrink the ratchet was built for. An empty
#: allowlist is not a licence: if a live occurrence ever returns (a revert, a
#: rewording in a new package), the `unlisted` half of TEST-3 reddens and names the
#: file to re-list.
STILL_CARRIED = {}

# Phase-5 TEST-N binding (feature registration-overlay-claims, issue #432). Every ID a
# PASS is ever recorded for must be EARNED by this branch (A11), not inherited from
# another feature's use of the same per-feature namespace. The IDs below name the tests
# whose DECLARED files this branch does not modify, so they ride these added lines. Each
# entry names the test's file and what THIS branch did (past tense) — the full binding
# (node names, asserted claims) lives in `.lifecycle/registration-overlay-claims/TESTS.md`:
#   TEST-5   spatial-types/tests/test_ome_dtype_refusal.py — this branch re-vendored the
#            writer into all four packages
#   TEST-6   spatial-types/tests/test_image_failure_provenance.py — this branch re-vendored
#            both shared modules
#   TEST-7   spatial-types/tests/test_ome_sample_classification.py — this branch re-vendored
#            the writer; every shipping copy stayed covered
#   TEST-8   spatial-import-xenium/tests/test_vendored_contract.py — this branch re-vendored
#            the shared modules source-faithfully
#   TEST-9   spatial-import-visium/tests/test_vendored_contract.py — this branch re-vendored
#            `spatial_declarations.py`
#   TEST-10  spatial-import-visium-hd/tests/test_vendored_contract.py — this branch
#            re-vendored the pair and left the three `registration_qc.py` files
#            deliberately NOT identical (INV-5)
#   TEST-11  spatial-import-visium-hd/tests/test_no_closed_issue_pointers.py — this branch
#            re-vendored the pair without changing the frozen deferral set
#   TEST-12  spatial-import-visium-hd/tests/test_package_registration.py — this branch
#            bumped HD's manifest and recorded #432 in `tests/issue_states.json`
#   TEST-14  spatial-import-xenium/tests/test_refusal_design_contract.py — this branch
#            appended xenium's manifest entry above `version:`
#   TEST-15  spatial-import-xenium/tests/test_coordinate_space_identity.py — this branch
#            appended xenium's manifest entry
#   TEST-16  scripts/check-processor-seed-versions.sh — this branch moved all four manifests
#   TEST-17  scripts/check-manifest-version-claims.sh — this branch's four chosen numbers
#            went uncontested against origin/main and every unmerged ref
#   TEST-18  spatial-import-xenium/tests/test_placement_judgement_disclosure.py — this
#            branch's bump left the #301 disclosure sites intact
#   TEST-19  spatial-import-xenium/tests/test_package_registration.py — this branch's
#            manifests satisfied the declared seed-version floors (see TESTS.md)
#   TEST-20  spatial-import-visium/tests/test_hostile_vendor_text.py — this branch moved
#            visium past the body that shipped the defect and left the #330 history entry
#            intact
#   TEST-21  spatial-import-visium-hd/tests/test_no_closed_issue_pointers.py — this branch
#            added 269, 301 and 432 to the dated issue-state snapshot
#   TEST-22  spatial-import-visium-hd/tests/test_package_registration.py — this branch's
#            manifest entry survives a hostile locale read (LC_ALL=C)
# TEST-1, TEST-2, TEST-3 and TEST-4 live in this file (the four test functions below);
# TEST-23 is TESTS.md's ID for TEST-3's utf-8-explicit `_scan()` read, exercised inside
# TEST-3, not a distinct test. TEST-13's declared file
# (`spatial-import-visium/tests/test_refusal_escaping.py`) is modified by this branch —
# the pin moved with the bump — so it matches arm two.

#: Comment markers stripped by `_normalize`, mirroring `normalizeClaimText` in
#: `libs/viz/src/viz-core/spatial/staleClaims.test.ts`. Unanchored there and here: the
#: `#` of an issue reference is stripped on BOTH sides of every comparison, so matching
#: is symmetric and a wrapped copy still reads the same.
_MARKER = re.compile(r"\s*(?:\/\/+|#+|>+|\*)\s*")


def _normalize(text):
    """Collapse a source file to one line of comparable prose.

    Newlines, comment markers (`//`, `#`, `>`, `*`) and runs of whitespace all become a
    single space, so a sentence wrapped across a docstring or comment boundary reads the
    same as one that was not. Mirrors `normalizeClaimText` in
    `libs/viz/src/viz-core/spatial/staleClaims.test.ts` — this is what lets a phrase match
    across a wrapped docstring line, which is the shape both claims have.
    """
    text = re.sub(r"[\r\n]+", " ", text)
    text = _MARKER.sub(" ", text)
    return re.sub(r"\s+", " ", text)


#: The bounded window of NORMALIZED text examined on BOTH sides of each claim
#: occurrence. Sized from the data, not a literal: the longest retired claim normalizes
#: to 121 characters, and a single marker retiring two claims in one breath can sit up
#: to one claim-length plus a short separator from the second claim — so the window is
#: the longest claim plus a 40-character margin. The window is SYMMETRIC because this
#: repo writes its retirement markers on both sides of the text they retire:
#: `test_scale_referent.py` puts "used to end" BEFORE the quote, `import_xenium.py`
#: puts "corrected rather than removed" AFTER it. A larger window would let a
#: retirement marker elsewhere in the file mask a live claim, which is the failure
#: direction this guard exists to prevent.
_RETIREMENT_MARGIN = 40
_RETIREMENT_WINDOW = max(len(_normalize(claim)) for claim in RETIRED_CLAIMS) \
    + _RETIREMENT_MARGIN


def _claims_in(text):
    """Every retired claim present in `text`, after normalization.

    This is the RAW matcher: a quoted retirement still contains the claim verbatim, so
    it is still "present". Whether an occurrence is a LIVE carrier is the job of
    `_live_claims_in`.
    """
    normalized = _normalize(text)
    return tuple(claim for claim in RETIRED_CLAIMS
                 if normalized.find(_normalize(claim)) != -1)


def _marker_adjacent_to_quote(normalized, marker_pos, marker_len, claim_pos, claim_len):
    """True when a quote character sits between the marker and the claim occurrence.

    A marker only counts as a retirement marker when it is ADJACENT TO A QUOTATION — a
    quote character between the marker and the claim. This is what stops the "this
    assertion used to read X" sense of `used to read`/`used to say` (which appears in
    this tree in a completely unrelated sense, e.g. `import_xenium.py`'s "Every rung
    used to read the vendor string RAW") from disarming a neighbouring live claim: that
    sense has no quote between the marker and the claim.
    """
    if marker_pos + marker_len <= claim_pos:
        between = normalized[marker_pos + marker_len:claim_pos]
    elif claim_pos + claim_len <= marker_pos:
        between = normalized[claim_pos + claim_len:marker_pos]
    else:
        return False
    return any(quote in between for quote in "\"'`")


def _retirement_marker_in_window(normalized, claim_pos, claim_len):
    """True when a retirement marker sits in the symmetric window around the claim,
    adjacent to a quotation.

    The window is `_RETIREMENT_WINDOW` normalized characters on EACH side of the claim
    occurrence — forward as well as back, because this repo writes its retirements in
    both directions. A marker found in the window counts only when a quotation sits
    between it and the claim (`_marker_adjacent_to_quote`).
    """
    start = max(0, claim_pos - _RETIREMENT_WINDOW)
    end = min(len(normalized), claim_pos + claim_len + _RETIREMENT_WINDOW)
    window = normalized[start:end]
    for marker in _RETIREMENT_MARKERS:
        mpos = 0
        while True:
            mpos = window.lower().find(marker, mpos)
            if mpos == -1:
                break
            if _marker_adjacent_to_quote(normalized, start + mpos, len(marker),
                                         claim_pos, claim_len):
                return True
            mpos += len(marker)
    return False


def _live_claims_in(text):
    """The retired claims `text` carries as LIVE assertions, not quoted retirements.

    For each claim, every occurrence is examined: the SYMMETRIC window of NORMALIZED
    text around it is checked for a retirement marker adjacent to a quotation. If ANY
    occurrence is not retired, the claim is a live carrier; if every occurrence is a
    quoted retirement, it is not. This is what lets the allowlist SHRINK when the
    four-package fix lands: the corrected file still contains the verbatim string, but
    only as a retirement, so it stops being a carrier.
    """
    normalized = _normalize(text)
    live = []
    for claim in RETIRED_CLAIMS:
        needle = _normalize(claim)
        pos = 0
        is_live = False
        while True:
            pos = normalized.find(needle, pos)
            if pos == -1:
                break
            if not _retirement_marker_in_window(normalized, pos, len(needle)):
                is_live = True
                break
            pos += len(needle)
        if is_live:
            live.append(claim)
    return tuple(live)


# ── Layer 1 — the overlay coverage that makes claim (A) false ─────────────────────


#: The shared module whose consumers this guard derives, and the overlay that falsifies
#: the claim about it.
_WRITER_REL = Path("compute") / "ome_writer.py"
_OVERLAY_REL = Path("compute") / "registration_qc.py"


def _vendors():
    """Every package shipping `compute/ome_writer.py`, excluding the canonical package.

    These are the real CONSUMERS of the shared module — the packages that vendored a
    byte-identical copy. Derived by glob, never enumerated, so a fourth producer is
    covered the day it ships. The canonical package is derived from this test file's own
    location (it lives inside it), never hardcoded.
    """
    return tuple(sorted(
        path.parent.parent for path in _PACKAGES.glob(f"*/{_WRITER_REL}")
        if path.parent.parent.name != _CANONICAL
    ))


def _with_overlay(vendors):
    """Those of `vendors` that also ship `compute/registration_qc.py`."""
    return tuple(sorted(p for p in vendors if (p / _OVERLAY_REL).is_file()))


def _without_overlay(vendors):
    """`vendors - with_overlay` — the honest hole, empty today and reported every run."""
    return tuple(sorted(p for p in vendors if not (p / _OVERLAY_REL).is_file()))


def _importer_files(vendor):
    """The `compute/import_*.py` file(s) of `vendor`, derived by glob, never enumerated."""
    return tuple(sorted(vendor.glob("compute/import_*.py")))


def _registration_qc_calls(text):
    """Every Call in `text` that invokes the imported `registration_qc` module's
    `registration_qc` function, as `(lineno, module_name)`.

    Resolves the import first: `import registration_qc` binds the module under its own
    name, `import registration_qc as RQC` binds it under the alias. A Call whose
    function is `<module_name>.registration_qc` is the overlay actually RUNNING — an
    import alone is necessary, not sufficient. Parsed with `ast` rather than
    substring-matched, so a commented-out import or a string-embedded call does not
    count as wired in.
    """
    tree = ast.parse(text)
    module_name = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "registration_qc":
                    module_name = alias.asname or "registration_qc"
    if module_name is None:
        return []
    return [
        (node.lineno, module_name)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == module_name
        and node.func.attr == "registration_qc"
    ]


# ── TEST-1 — Layer 1: the overlay coverage is DERIVED, never hardcoded ────────────


def test_layer1_overlay_coverage_is_derived():
    """TEST-1 [acceptance] — claim (A) is false because MORE THAN ONE producer has an overlay.

    The evidence is DERIVED, never hardcoded: `vendors` is every package shipping
    `compute/ome_writer.py` (the real consumers of the shared module), `with_overlay` is
    those that also ship `compute/registration_qc.py`, and `without_overlay` is the
    difference. The liveness floor comes FIRST, because an identity assertion over an
    empty set is vacuously true — which is how these guards die. Then `without_overlay`
    is asserted EMPTY: a producer that ships the writer but no overlay is exactly the
    case the retired claim was written for, so if one is added deliberately the claim's
    correction must be revisited and this assertion updated on purpose — not silently.
    And the overlay is asserted RUNNING, not merely present: at least one of each
    producer's `compute/import_*.py` files (derived by glob, never enumerated) must CALL
    `registration_qc.registration_qc(...)`. Importing is necessary, not sufficient — an
    imported-but-never-called overlay is a dead file, and claim (A) becomes true again
    if the call goes. "At least one", not "every": splitting an importer into a second
    `import_*.py` module is a legitimate refactor, and the overlay is wired in as long
    as one of the package's importers runs it.
    """
    vendors = _vendors()
    assert len(vendors) >= 3, (
        f"only {len(vendors)} package(s) ship `{_WRITER_REL.as_posix()}`: "
        f"{[p.name for p in vendors]}. A copy that VANISHED is a package that silently "
        "stopped being covered — an identity assertion over an empty set is vacuously "
        "true, which is how these guards die."
    )
    with_overlay = _with_overlay(vendors)
    without_overlay = _without_overlay(vendors)
    assert len(with_overlay) >= 2, (
        f"only {len(with_overlay)} of {len(vendors)} producers ship a registration "
        f"overlay ({[p.name for p in with_overlay]}); missing one: "
        f"{[p.name for p in without_overlay]}. While more than one producer has an "
        "overlay, the phrase \"#156's registration overlay is the only real check\" is "
        "false wherever it appears."
    )
    assert not without_overlay, (
        "these producers ship `compute/ome_writer.py` but no `compute/registration_qc.py`: "
        f"{[p.name for p in without_overlay]}. A producer without an overlay is EXACTLY "
        "the case the retired claim was written for — \"#156's registration overlay is "
        "the only real check\" is true again for that producer. If one is added "
        "deliberately, the claim's correction must be revisited and this assertion "
        "updated on purpose, not silently."
    )
    for vendor in vendors:
        importers = _importer_files(vendor)
        assert importers, (
            f"{vendor.name} ships `compute/ome_writer.py` but no `compute/import_*.py` "
            "file — there is no importer to wire the overlay into."
        )
        assert any(
            _registration_qc_calls(importer.read_text(encoding="utf-8"))
            for importer in importers
        ), (
            f"none of {vendor.name}'s `compute/import_*.py` files CALL "
            "`registration_qc.registration_qc(...)` — an imported-but-never-called "
            "overlay is a dead file, and claim (A) becomes true again if the call "
            "goes. Importing is necessary, not sufficient: the overlay only checks "
            "anything when it actually runs."
        )
    print(f"\nVENDORS={[p.name for p in vendors]} "
          f"WITH_OVERLAY={[p.name for p in with_overlay]} "
          f"WITHOUT_OVERLAY={[p.name for p in without_overlay]}")


# ── Layer 2 — `stated_scale_agreement` no longer refuses the image ────────────────


_XENIUM_IMPORT = _PACKAGES / "spatial-import-xenium" / "compute" / "import_xenium.py"


def _xenium_tree():
    """The parsed `import_xenium.py` AST, read with `encoding="utf-8"`."""
    return ast.parse(_XENIUM_IMPORT.read_text(encoding="utf-8"))


def _module_level_functions(tree):
    """`{name: FunctionDef}` for every module-level function in `tree`."""
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _stated_scale_agreement_node(tree):
    """The `FunctionDef` for `stated_scale_agreement`, or None if it moved."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                and node.name == "stated_scale_agreement":
            return node
    return None


def _raises_in(node):
    """Every `raise` node under `node`, INCLUDING inside nested function definitions.

    A nested `def` is still part of the scanned body, and a `raise` there is still a
    refusal — skipping it would let a refusal moved into a helper evade the guard.
    """
    found = []
    stack = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        if isinstance(current, ast.Raise):
            found.append(current)
        stack.extend(ast.iter_child_nodes(current))
    return found


def _called_names(node):
    """Every plain name called as a function inside `node`."""
    return {
        child.func.id
        for child in ast.walk(node)
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
    }


def _raises_including_callees(node, module_funcs):
    """Every `raise` under `node` (nested defs included) plus one level of module-level
    callees called from within `node`.

    A refusal moved into a MODULE-LEVEL helper (`def _refuse(msg): raise ...` at module
    level, called from inside the scanned function) would otherwise leave no `ast.Raise`
    in the FunctionDef. One level of indirection is enough — a callee's own callees are
    not followed, and that bound is the residue.
    """
    found = _raises_in(node)
    for name in _called_names(node):
        callee = module_funcs.get(name)
        if callee is not None and callee is not node:
            found.extend(_raises_in(callee))
    return found


def _raise_message(node):
    """The message text of a `raise X(...)` node, or '' when it cannot be read.

    Only plain string constants and f-string literal parts are read; a message built from
    a variable or a call answers '' — which is not the documented caller-contract raise.
    """
    if not isinstance(node.exc, ast.Call):
        return ""
    parts = []
    for arg in node.exc.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            parts.append(arg.value)
        elif isinstance(arg, ast.JoinedStr):
            for value in arg.values:
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    parts.append(value.value)
    return " ".join(parts)


def _enclosing_function(tree, node):
    """The `FunctionDef`/`AsyncFunctionDef` in `tree` that contains `node`, or None.

    None means the node sits at MODULE level — the call was hoisted out of its function.
    """
    for candidate in ast.walk(tree):
        if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(candidate):
                if child is node:
                    return candidate
    return None


def _stated_scale_agreement_call(tree):
    """The `(assign, second_name, enclosing)` at the call site, or None if it moved.

    `assign` is the `Assign` whose value is the call to `stated_scale_agreement`;
    `second_name` is the name bound to its second return value (currently
    `disagreement`); `enclosing` is the function that contains the call, or None if the
    call was hoisted to module level. The call site is where a regression would actually
    re-add the refusal — the function body alone cannot see `if refuse: raise`.
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        if not (isinstance(value, ast.Call)
                and isinstance(value.func, ast.Name)
                and value.func.id == "stated_scale_agreement"):
            continue
        targets = node.targets
        if not (len(targets) == 1
                and isinstance(targets[0], ast.Tuple)
                and len(targets[0].elts) == 2
                and isinstance(targets[0].elts[1], ast.Name)):
            continue
        return node, targets[0].elts[1].id, _enclosing_function(tree, node)
    return None


def _raises_after(enclosing, call_stmt, module_funcs, tainted):
    """Every `raise` on a path after `call_stmt` in `enclosing`, including nested defs
    and module-level callees whose CALL is tainted.

    "After" is source order: a statement that appears after the call in the enclosing
    function's body executes after the call on every path that reaches it. A `raise`
    inside a nested `def` defined after the call is included (the def can be called
    later). A module-level callee called after the call is included ONLY when its call
    is tainted — an argument references a name tainted by the call's bound values —
    because an untainted callee's internal raises are not evidence about claim (B):
    `emit_image` calls `coverage_note` and `output_entry` after the call, and a routine
    assertion added to either is not a refusal of the image on a disagreement.
    """
    found = [
        node for node in ast.walk(enclosing)
        if isinstance(node, ast.Raise) and node.lineno > call_stmt.lineno
    ]
    for node in ast.walk(enclosing):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.lineno > call_stmt.lineno):
            callee = module_funcs.get(node.func.id)
            if callee is not None and _call_is_tainted(node, tainted):
                found.extend(_raises_in(callee))
    return found


def _parent_map(node):
    """`{child: parent}` for every node under `node`."""
    parents = {}
    stack = [node]
    while stack:
        current = stack.pop()
        for child in ast.iter_child_nodes(current):
            parents[child] = current
            stack.append(child)
    return parents


def _enclosing_blocks(node, func):
    """The `(block, index)` pairs enclosing `node` within `func`, innermost first.

    `block` is a statement list (a `body`/`orelse`/`finalbody`/`handlers` list) and
    `index` is the position in it of the statement containing `node`. Walking up from
    `node` through its ancestors, every ancestor that is a direct member of a block is
    recorded.
    """
    parents = _parent_map(func)
    result = []
    current = node
    while current is not func:
        parent = parents[current]
        for attr in ("body", "orelse", "finalbody", "handlers"):
            block = getattr(parent, attr, None)
            if isinstance(block, list) and current in block:
                result.append((block, block.index(current)))
                break
        current = parent
    return result


def _return_follows(node, func):
    """True when a NON-FINAL `return` follows `node` on the same path within `func`.

    The final return of the function is the SUCCESS return (the image was emitted); a
    return that follows an append to the not-emitted collection is a REFUSAL return only
    when it is not that success return. Walks `node` outward through its enclosing
    blocks: at each level, if the statement containing `node` is followed by a `Return`
    in the same block, a return follows `node` — whether the append is directly before
    the return or inside a nested block that is the last statement before it.
    """
    final = func.body[-1] if func.body and isinstance(func.body[-1], ast.Return) else None
    for block, index in _enclosing_blocks(node, func):
        for stmt in block[index + 1:]:
            if isinstance(stmt, ast.Return) and stmt is not final:
                return True
    return False


def _not_emitted_name(func):
    """The name of the not-emitted collection in `func`, derived, or None.

    The not-emitted collection is the name that (a) is a target of `.append(...)` calls,
    (b) appears in a `return` tuple, and (c) has at least one append followed by a
    non-final return — the refusal shape. Derived rather than hardcoded so a rename of
    `skipped` does not silently disable the guard.
    """
    appended = {
        node.func.value.id
        for node in ast.walk(func)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and node.func.attr == "append" and isinstance(node.func.value, ast.Name)
    }
    returned = set()
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and isinstance(node.value, ast.Tuple):
            for elt in node.value.elts:
                if isinstance(elt, ast.Name):
                    returned.add(elt.id)
    for name in sorted(appended & returned):
        for node in ast.walk(func):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "append"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == name
                    and _return_follows(node, func)):
                return name
    return None


def _refusal_sites(func, not_emitted):
    """Every refusal site in `func`: raises, and appends to `not_emitted` followed by a
    non-final return.

    A refusal site is a place where the function refuses to emit the image. In this
    function's idiom that is `skipped.append(...)` followed by `return entries, skipped,
    warnings` — the not-emitted collection — plus every `raise`. Nested defs are
    included: a refusal moved into a helper defined inside the function is still a
    refusal.
    """
    sites = []
    for node in ast.walk(func):
        if isinstance(node, ast.Raise):
            sites.append(node)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and node.func.attr == "append"
              and isinstance(node.func.value, ast.Name)
              and node.func.value.id == not_emitted
              and _return_follows(node, func)):
            sites.append(node)
    return sites


def _references_tainted(node, tainted):
    """True when `node` references any name in `tainted`."""
    return any(isinstance(n, ast.Name) and n.id in tainted for n in ast.walk(node))


def _bound_names(target):
    """The names bound by an assignment target, recursively."""
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names = set()
        for elt in target.elts:
            names |= _bound_names(elt)
        return names
    return set()


def _tainted_names_after(func, call_stmt):
    """The names tainted by the call's bound values, transitively, after `call_stmt`.

    Starts with the names bound by the `stated_scale_agreement(...)` assignment
    (`stated_scales`, `disagreement`), then propagates to a fixed point: any name
    assigned from an expression that references a tainted name becomes tainted. This
    closes the `refuse_it = disagreement is not None` bypass: the derived name is
    tainted because its initializer references a tainted name.
    """
    tainted = set()
    for target in call_stmt.targets:
        if isinstance(target, ast.Tuple):
            for elt in target.elts:
                if isinstance(elt, ast.Name):
                    tainted.add(elt.id)
        elif isinstance(target, ast.Name):
            tainted.add(target.id)
    changed = True
    while changed:
        changed = False
        for node in ast.walk(func):
            if getattr(node, "lineno", -1) <= call_stmt.lineno:
                continue
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                value = node.value
                if value is not None and _references_tainted(value, tainted):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        for name in _bound_names(target):
                            if name not in tainted:
                                tainted.add(name)
                                changed = True
            elif isinstance(node, ast.AugAssign):
                if _references_tainted(node.value, tainted):
                    for name in _bound_names(node.target):
                        if name not in tainted:
                            tainted.add(name)
                            changed = True
            elif isinstance(node, ast.For):
                if _references_tainted(node.iter, tainted):
                    for name in _bound_names(node.target):
                        if name not in tainted:
                            tainted.add(name)
                            changed = True
            elif isinstance(node, ast.With):
                for item in node.items:
                    if (item.optional_vars is not None
                            and _references_tainted(item.context_expr, tainted)):
                        for name in _bound_names(item.optional_vars):
                            if name not in tainted:
                                tainted.add(name)
                                changed = True
    return tainted


def _enclosing_conditions(node, func):
    """The tests of every `If`/`While`/`For`/`IfExp` enclosing `node` within `func`."""
    parents = _parent_map(func)
    conditions = []
    current = node
    while current is not func:
        parent = parents[current]
        if isinstance(parent, ast.If) and parent.test is not current:
            conditions.append(parent.test)
        elif isinstance(parent, ast.While) and parent.test is not current:
            conditions.append(parent.test)
        elif isinstance(parent, ast.For) and parent.iter is not current:
            conditions.append(parent.iter)
        elif isinstance(parent, ast.IfExp) and parent.test is not current:
            conditions.append(parent.test)
        current = parent
    return conditions


def _refusal_is_tainted(site, tainted, func):
    """True when a refusal site's CONDITION or PAYLOAD references a tainted name.

    The payload is the exception expression of a `raise`, or the append call itself; the
    conditions are the tests of every `If`/`While`/`For`/`IfExp` enclosing the site. A
    refusal whose condition or payload references a tainted name is a refusal of the
    image on the two-vendor-statement disagreement.
    """
    payload = site.exc if isinstance(site, ast.Raise) else site
    if payload is not None and _references_tainted(payload, tainted):
        return True
    return any(_references_tainted(cond, tainted)
               for cond in _enclosing_conditions(site, func))


def _tainted_refusals_after(func, call_stmt, not_emitted, tainted):
    """Refusal sites after `call_stmt` whose condition or payload references a tainted
    name."""
    return [
        site for site in _refusal_sites(func, not_emitted)
        if getattr(site, "lineno", -1) > call_stmt.lineno
        and _refusal_is_tainted(site, tainted, func)
    ]


def _call_is_tainted(call, tainted):
    """True when any argument of `call` references a name in `tainted`."""
    return any(_references_tainted(arg, tainted) for arg in call.args) or any(
        _references_tainted(kw.value, tainted) for kw in call.keywords)


#: The refusal-site count in `emit_image` (`import_xenium.py`), measured ONCE on this
#: branch: three append-to-not-emitted-then-return sites (lines 2607-2612, 2639-2646,
#: 2764-2765) and three raises (lines 2671, 2676, 2677) = 6. This is the ratchet that
#: catches a refusal the taint analysis cannot see (B1b): a refusal that launders the
#: value through something the taint analysis does not track changes this count.
_EMIT_IMAGE_REFUSAL_SITES = 6


def _records_warning(node):
    """True when `node` records a warning to a warnings collection.

    A call to `.append(...)`/`.extend(...)` whose receiver is a name that reads as a
    warnings collection (contains "warning"), or a call whose name mentions
    "warning"/"record". Tightened from "any `.append`/`.extend`": appending to the wrong
    list is not recording the disagreement.
    """
    stack = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        if isinstance(current, ast.Call):
            func = current.func
            if isinstance(func, ast.Attribute) and func.attr in ("append", "extend"):
                receiver = func.value
                if isinstance(receiver, ast.Name) and "warning" in receiver.id.lower():
                    return True
            name = func.attr if isinstance(func, ast.Attribute) else (
                func.id if isinstance(func, ast.Name) else "")
            if "warning" in name.lower() or "record" in name.lower():
                return True
        stack.extend(ast.iter_child_nodes(current))
    return False


def _records_disagreement_after(enclosing, call_stmt, second_name):
    """True when some statement after `call_stmt` both references `second_name` and
    records a warning to a warnings collection.

    This is the name-independent form of the old "the guarded block records a warning":
    the disagreement result is not dropped unhandled, and it is recorded as a warning
    rather than merely referenced.
    """
    for node in ast.walk(enclosing):
        if getattr(node, "lineno", -1) <= call_stmt.lineno:
            continue
        if not any(isinstance(n, ast.Name) and n.id == second_name
                   for n in ast.walk(node)):
            continue
        if _records_warning(node):
            return True
    return False


# ── TEST-2 — Layer 2: the cross-check raises nothing about the data ───────────────


def test_layer2_stated_scale_agreement_no_longer_refuses():
    """TEST-2 [acceptance] — claim (B) is false because the cross-check no longer refuses.

    #269 removed the refusal: `stated_scale_agreement()` returns `(stated_scales,
    warning_or_None)` and the call site appends the warning to `pending_warnings`; the
    image is emitted. The machine-checkable form of "it no longer refuses" is that the
    function's own body contains no `raise` about the DATA.

    The function's own docstring documents the single exception: "it raises nothing
    ABOUT THE DATA. The single exception is a `ValueError` for a `pixel_size` that is
    not a scale at all, which is a caller contract violation rather than something the
    bundle said." So the check is not "no `raise` at all" — that would be FALSE, and a
    guard that requires a false sentence is the failure this whole file exists to
    prevent. It is: every `raise` in the function must be that documented caller-contract
    `ValueError`, identified by its message naming the caller-contract case ("not a
    scale"). A raise that refuses the image on a DISAGREEMENT is not that raise, and
    fails here.

    The body scan does NOT skip nested function definitions — a refusal moved into a
    helper defined inside the function would otherwise evade it — and it follows ONE
    level of module-level callees: a `def _refuse(msg): raise ...` at module level,
    called from inside the scanned function, leaves no `ast.Raise` in the FunctionDef.
    One level of indirection is enough; a callee's own callees are not followed, and
    that bound is the residue.

    The function body is only half the story: the realistic regression is at the CALL
    SITE — `stated_scales, disagreement = stated_scale_agreement(...)` followed by
    `if disagreement is not None: pending_warnings.append(...)`. A refusal re-added
    there would make claim (B) true again while the function body stayed clean. But
    `raise` is NOT this function's refusal primitive: `emit_image` refuses images by
    appending to the not-emitted collection (`skipped`) and returning — the refusal
    sites are `skipped.append(...)` + `return entries, skipped, warnings`, plus the
    raises in the exception handler. So the call-site check is THREE complementary
    mechanisms:

      * TAINT (B1a): the names the call binds (`stated_scales`, `disagreement`) are
        tainted, and taint propagates transitively through assignments — so a derived
        name (`refuse_it = disagreement is not None`) is tainted too. Then no REFUSAL
        after the call — a `raise`, or an append to the not-emitted collection followed
        by a return — may have a CONDITION or PAYLOAD that references a tainted name.
        The not-emitted collection's name is DERIVED from the function, not hardcoded.
      * COUNT (B1b): the refusal sites in the enclosing function are counted and pinned
        to a constant measured on this branch. Taint cannot see a refusal that launders
        the value through something it does not track; the count can.
      * RAISES (B2): no `raise` on any path after the call, in a nested def, or in a
        module-level callee whose CALL is tainted. An untainted callee's internal raises
        are not evidence about claim (B) — `emit_image` calls `coverage_note` and
        `output_entry` after the call, and a routine assertion added to either is not a
        refusal of the image on a disagreement.

    And the disagreement result is still recorded: some statement after the call both
    references the second bound name and records a warning to a warnings collection, so
    a result that is bound but never handled fails here.

    If the function or the call site is NOT FOUND, this FAILS rather than skips — a skip
    here is a vacuous guard. If the call was hoisted to module level (no enclosing
    function), this FAILS with that message rather than raising a `TypeError`.
    """
    tree = _xenium_tree()
    module_funcs = _module_level_functions(tree)

    func = _stated_scale_agreement_node(tree)
    assert func is not None, (
        "`stated_scale_agreement` was not found in "
        f"`{_XENIUM_IMPORT.relative_to(_PACKAGES).as_posix()}`. The referent of this "
        "check was renamed or moved, so either update this guard or the claim it is "
        "anchoring may have changed meaning."
    )
    raises = _raises_including_callees(func, module_funcs)
    for node in raises:
        is_caller_contract = (
            isinstance(node.exc, ast.Call)
            and isinstance(node.exc.func, ast.Name)
            and node.exc.func.id == "ValueError"
            and "not a scale" in _raise_message(node)
        )
        assert is_caller_contract, (
            f"line {node.lineno}: `stated_scale_agreement` contains a `raise` that is "
            "not the documented caller-contract `ValueError` (a `pixel_size` that is not "
            "a scale). The function's own docstring says it 'raises nothing ABOUT THE "
            "DATA'; the single exception is that caller-contract guard. Any other raise "
            "— in the function, in a nested `def`, or in a module-level helper it calls "
            "— is a refusal of the image on a disagreement, which is exactly what claim "
            "(B) says and what #269 removed."
        )

    # The call site: where a regression would actually re-add the refusal.
    call = _stated_scale_agreement_call(tree)
    assert call is not None, (
        "the call site `stated_scales, disagreement = stated_scale_agreement(...)` was "
        "not found in `import_xenium.py`. The referent of this check was renamed or "
        "moved, so either update this guard or the claim it is anchoring may have "
        "changed meaning."
    )
    _assign, second_name, enclosing = call
    assert enclosing is not None, (
        "the call site `stated_scales, disagreement = stated_scale_agreement(...)` is at "
        "MODULE level in `import_xenium.py` — the call was hoisted out of its function, "
        "so there is no enclosing body to check for a refusal. Either update this guard "
        "or the claim it is anchoring may have changed meaning."
    )

    # The disagreement result is still recorded as a warning, not dropped and not
    # refused. This is the name-independent form of the old "guarded block records a
    # warning": a result that is bound but never handled fails here.
    assert _records_disagreement_after(enclosing, _assign, second_name), (
        f"nothing after the call records the `{second_name}` result as a warning — the "
        "disagreement is either dropped unhandled or recorded somewhere this guard "
        "cannot see. #269's shape is `if disagreement is not None: "
        "pending_warnings.append(...)`; a call site that neither raises nor records is a "
        "different regression, and this guard cannot see it."
    )

    # B1(a): TAINT. The names the call binds are tainted, transitively; no refusal after
    # the call may reference a tainted name in its condition or payload.
    not_emitted = _not_emitted_name(enclosing)
    assert not_emitted is not None, (
        "could not derive the not-emitted collection's name in `emit_image` "
        f"(`{_XENIUM_IMPORT.relative_to(_PACKAGES).as_posix()}`) — no name is both a "
        "target of `.append(...)` calls and returned in a tuple with an append followed "
        "by a non-final return. The refusal-shape check cannot run without it; either "
        "update this guard or the function's refusal idiom has changed."
    )
    tainted = _tainted_names_after(enclosing, _assign)
    tainted_refusals = _tainted_refusals_after(enclosing, _assign, not_emitted, tainted)
    assert not tainted_refusals, (
        "a refusal after the call to `stated_scale_agreement` is tainted by the call's "
        f"bound values (line(s) {sorted({r.lineno for r in tainted_refusals})}): a "
        "`raise`, or an append to the not-emitted collection followed by a return, whose "
        "condition or payload references `stated_scales`, `disagreement`, or a name "
        "derived from them. That is a refusal of the image on the two-vendor-statement "
        "disagreement — exactly what claim (B) says and what #269 removed."
    )

    # B1(b): COUNT. The refusal sites are pinned to a constant measured on this branch,
    # so a refusal that launders the value through something the taint analysis does not
    # track still changes the count.
    sites = _refusal_sites(enclosing, not_emitted)
    assert len(sites) == _EMIT_IMAGE_REFUSAL_SITES, (
        f"a NEW refusal path appeared in `emit_image`: {len(sites)} refusal sites "
        "(append-to-not-emitted-then-return plus raise), expected "
        f"{_EMIT_IMAGE_REFUSAL_SITES}. If it is legitimate, update this constant "
        "deliberately; if it refuses on the two-vendor-statement disagreement, claim "
        "(B) is true again and #269 has been reverted."
    )

    # B2: no raise on any path after the call — directly, in a nested def, or in a
    # module-level callee whose CALL is tainted.
    after_raises = _raises_after(enclosing, _assign, module_funcs, tainted)
    assert not after_raises, (
        "a `raise` appears on a path AFTER the call to `stated_scale_agreement` in "
        f"`{_XENIUM_IMPORT.relative_to(_PACKAGES).as_posix()}` (line(s) "
        f"{sorted({r.lineno for r in after_raises})}), or inside a module-level callee "
        "whose call is tainted by the call's bound values. #269 removed the refusal: "
        "the call site appends the disagreement to `pending_warnings` and the image is "
        "emitted. A raise here is a refusal on a path after the cross-check — if it "
        "refuses on the two-vendor-statement disagreement, claim (B) is true again and "
        "#269 has been reverted."
    )


# ── Layer 3 — the retired-claim scan, with a shrinking allowlist ──────────────────


def _scan():
    """`(scanned, offenders)` over every `src-app/packages/*/compute/*.py`.

    `scanned` is the set of package-relative paths read; `offenders` maps each path that
    carries a retired claim as a LIVE assertion to the claims it carries. A QUOTED
    RETIREMENT — a claim occurrence adjacent to a retirement marker, which is the shape
    this repo's corrections actually take — is not a carrier. Every read names
    `encoding="utf-8"` EXPLICITLY (#339): a locale-default read raises under `LC_ALL=C`,
    and an `except UnicodeDecodeError: continue` then silently skips the very files being
    guarded — so there is no such handler here at all.
    """
    scanned = set()
    offenders = {}
    for path in sorted(_PACKAGES.glob("*/compute/*.py")):
        rel = path.relative_to(_PACKAGES).as_posix()
        scanned.add(rel)
        found = _live_claims_in(path.read_text(encoding="utf-8"))
        if found:
            offenders[rel] = found
    return scanned, offenders


# ── TEST-3 — Layer 3: no claim outside the allowlist, and the allowlist shrinks ────


def test_layer3_retired_claims_scan():
    """TEST-3 [acceptance] — no LIVE claim survives OUTSIDE the allowlist, and the
    allowlist cannot outlive the claims.

    The scan root is the WHOLE of `src-app/packages/*/compute/*.py`, by glob — not a
    hardcoded list of the files this guard already knows about. A guard that enumerates
    today's sites cannot see tomorrow's; a whole-tree scan is what caught the copy a
    per-package guard was blind to (#321).

    Two directions, and the second is the load-bearing one:

      (i) no file OUTSIDE `STILL_CARRIED` carries any retired claim as a LIVE assertion —
          this catches the claim spreading to a new module;
      (ii) EVERY allowlist entry still exists AND still carries a LIVE claim — so when
          the atomic four-package fix lands, this test fails and names EVERY entry to
          delete in one run (the failures are aggregated, the way the `unlisted` half
          does, rather than stopping at the first). That is the ratchet that makes the
          allowlist SHRINK.

    "LIVE" is the load-bearing word: a corrected file still QUOTES the retired sentence
    (this repo's correction idiom is "used to end" / "corrected rather than removed"),
    and a quoted retirement is not a carrier — see `_live_claims_in`. Without that
    distinction, the ratchet would be defeated by the very fix it exists to detect.
    """
    scanned, offenders = _scan()

    # The corpus floor comes first: a scan that walks nothing passes every absence check
    # ever written. Pinned near the measured corpus (53 files today), the way
    # `test_ome_dtype_refusal.py` pins `len(SHIPPED) >= 3` against a real 4.
    assert len(scanned) >= 40, (
        f"only {len(scanned)} files scanned under {_PACKAGES}/*/compute/; expected at "
        "least 40 (the tree measures 53). A shrunken corpus is how an absence check goes "
        "vacuously green — the scan going blind to most of the tree is the failure being "
        "guarded."
    )
    print(f"\nscanned {len(scanned)} files under {_PACKAGES}/*/compute/; "
          f"{len(offenders)} carry a retired claim as a live assertion")

    # (i) no file outside the allowlist carries any LIVE claim.
    unlisted = {rel: claims for rel, claims in offenders.items() if rel not in STILL_CARRIED}
    assert not unlisted, (
        "these files carry a retired claim as a LIVE assertion but are not in "
        "STILL_CARRIED — the claim has spread to a new module, or a carrier was fixed "
        "and its entry not deleted:\n  "
        + "\n  ".join(f"{rel}: {claims}" for rel, claims in sorted(unlisted.items()))
    )

    # (ii) every allowlist entry still exists AND still carries a LIVE claim. Aggregated
    # so one run names EVERY entry to delete, the way the `unlisted` half does.
    stale = []
    for rel, reason in STILL_CARRIED.items():
        full = _PACKAGES / rel
        if not full.is_file():
            stale.append(f"{rel}: the file is GONE — delete its entry from STILL_CARRIED")
        elif rel not in offenders:
            stale.append(
                f"{rel}: no longer carries a LIVE claim — delete its entry from "
                "STILL_CARRIED"
            )
    assert not stale, (
        "the allowlist has entries that no longer carry a live claim — the atomic "
        "four-package fix landed, or a carrier was corrected and its entry not "
        "deleted:\n  "
        + "\n  ".join(stale)
    )

    # Each retired claim is a PHRASE of at least six words: short fragments are what
    # makes a prose scanner fire on ordinary English.
    for claim in RETIRED_CLAIMS:
        assert len(claim.split()) >= 6, (
            f"retired claim {claim!r} is only {len(claim.split())} words; short fragments "
            "are what makes a prose scanner fire on ordinary English"
        )

    # Every allowlist reason names #432 — the OPEN issue that owns the atomic
    # four-package re-vendor — and keeps #302 alongside as the history of the
    # adjudication, so a reader can see which issue each hole is.
    for rel, reason in STILL_CARRIED.items():
        assert "#432" in reason, (
            f"the STILL_CARRIED reason for {rel} does not name #432: {reason!r}"
        )
        assert "#302" in reason, (
            f"the STILL_CARRIED reason for {rel} dropped #302, the issue that "
            f"adjudicated the claims: {reason!r}"
        )


# ── Layer 4 — the negative control, and its complement ────────────────────────────


#: Ordinary English that must NOT trip the matcher. Three prose scanners in this repo
#: have fired on ordinary English in the past, so the matcher is run DIRECTLY over these
#: and must report zero matches. Each is a near-miss for one of the retired claims —
#: several state the TRUE, post-#269/post-#301 version using as many of the claim's
#: words as possible, which is exactly what this guard must not forbid. The last two are
#: the reverse-failure control for R6: the REAL current sentence from
#: `import_xenium.py` ("remains", not "is") and the qualified-true continuation a
#: visium correction would naturally write — both must stay quiet.
BENIGN = (
    "The writer refuses the image when the dtype is unsupported.",
    "This is the only real check we have for tile layout, and it is not enough.",
    "#156's registration overlay is now one of three, and each measures a different referent.",
    "A disagreement is reported, not refused; the image is still emitted.",
    # Two of this guard's own:
    "The registration overlay is one of three, and each measures a different referent.",
    "`spatial-import-xenium` reports the disagreement as a warning, and the image is still emitted.",
    # The REAL current sentence from `import_xenium.py` (R6), copied exactly:
    "§7.5's registration overlay remains the only real check on the affine itself — AND "
    "IT NOW EXISTS FOR THIS PRODUCER (#301).",
    # The qualified-true continuation a visium correction would naturally write (R6):
    "#156's registration overlay is the only real check on the affine itself, and it now "
    "exists for all three producers",
)


# ── TEST-4 — Layer 4: the matcher stays quiet on English, and fires on the claim ───


def test_layer4_negative_control():
    """TEST-4 [acceptance] — the matcher stays quiet on ordinary English, and fires on
    the real thing.

    Without the complement, a matcher that matches NOTHING passes the negative control
    forever — so a string that DOES contain a retired claim verbatim must be reported.
    The retirement classification (R1a) is pinned here too: a QUOTED RETIREMENT is still
    "present" to the raw matcher but is NOT a live carrier, while a bare claim is.
    """
    for sentence in BENIGN:
        found = _claims_in(sentence)
        assert not found, (
            f"the matcher fired on ordinary English: {sentence!r} matched {found}. A "
            "prose scanner that fires on ordinary English is a scanner people route "
            "around."
        )

    # The complement: each retired claim, present verbatim, IS reported — including
    # LINE-WRAPPED across a docstring boundary at every word boundary, which is the
    # shape both claims have and the reason `_normalize` exists.
    for claim in RETIRED_CLAIMS:
        found = _claims_in(f"prefix {claim} suffix")
        assert claim in found, (
            f"the matcher did not report {claim!r} when it was present verbatim — the "
            "negative control above would pass vacuously if the matcher matched nothing"
        )
        words = claim.split(" ")
        for at in range(1, len(words)):
            wrapped = " ".join(words[:at]) + "\n    " + " ".join(words[at:])
            assert claim in _claims_in(wrapped), (
                f"the matcher did not report {claim!r} wrapped across a line after word "
                f"{at} — the normalization this guard exists for is not working"
            )

    # The retirement classification: a QUOTED RETIREMENT is not a live carrier, and a
    # bare claim is. This is the control that keeps the R1a classification honest —
    # without it, a classifier that called everything "retired" would pass forever.
    retired = (
        "The sentence here used to end: '#156's registration overlay is the only real "
        "check, and #176's TEST-11 measures the gap rather than pretending it is shut.'"
    )
    assert _claims_in(retired), (
        "the retirement quotation no longer contains the claim verbatim — the control "
        "is not exercising the classifier"
    )
    assert _live_claims_in(retired) == (), (
        "a QUOTED RETIREMENT was classified as a live carrier — the correction idiom "
        "this repo actually writes ('used to end', 'corrected rather than removed') "
        "would keep the allowlist green forever"
    )
    assert _live_claims_in(f"prefix {RETIRED_CLAIMS[0]} suffix") == (RETIRED_CLAIMS[0],), (
        "a bare claim was not classified as live — the retirement classification is "
        "swallowing real carriers"
    )

    # B3: the marker can TRAIL the claim — this repo writes its retirements in both
    # directions (`import_xenium.py` puts "corrected rather than removed" AFTER the text
    # it retires). A backward-only window would classify this as live, the file would
    # stay an offender, and the allowlist would never shrink.
    trailing = (
        "'#156's registration overlay is the only real check, and #176's TEST-11 "
        "measures the gap rather than pretending it is shut.' — that paragraph is "
        "corrected rather than removed, because a disclosure of absence and its "
        "retirement are the same claim in two directions."
    )
    assert _live_claims_in(trailing) == (), (
        "a retirement whose marker TRAILS the claim was classified as a live carrier — "
        "the marker window is not symmetric, and a corrected `ome_writer.py` written in "
        "the `import_xenium.py` shape would keep the allowlist green forever"
    )

    # B4: a marker WITHOUT a quotation between it and the claim does not disarm it — the
    # "this assertion used to read X" sense is not a retirement of this claim, and a
    # `compute/*.py` writing such a sentence before a genuine live claim must not slip
    # past the `unlisted` half silently.
    unquoted = (
        "Every rung used to read the vendor string RAW, and #156's registration overlay "
        "is the only real check, and #176's TEST-11 measures the gap rather than "
        "pretending it is shut."
    )
    assert _live_claims_in(unquoted) == (RETIRED_CLAIMS[0],), (
        "a marker without a quotation between it and the claim disarmed a live claim — "
        "the 'this assertion used to read X' sense of `used to read`/`used to say` "
        "would let a neighbouring live claim slip past the `unlisted` half silently"
    )
