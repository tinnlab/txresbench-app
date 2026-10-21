#!/usr/bin/env python3
# ruff: noqa
r"""TEST-1 [acceptance] [invariant: INV-1, INV-2, INV-3] [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-6] — the HD importer name is DERIVED from HD's manifest every run, never a literal with no pin.

#654's gap, one level up from #359: the `binned_outputs/` refusal's pointer at the HD
importer is a LITERAL in visium's emitted message, and the tests that pin it assert the
literal against visium's own source. If HD renames its analysis — a one-line manifest edit
that HD's own suite would happily accept — visium's refusal starts telling operators to use
an importer that no longer exists under that name, and every test stays green.

THE FIX IS A TEST THAT DERIVES. The emitted message MUST stay a literal: visium cannot read
HD's manifest at import time (the packages are independent contributions; a runtime
cross-package read would be a worse coupling than a stale string). So the test below reads
`spatial-import-visium-hd/manifest.yaml` every run — at a path DERIVED from this file's own
location, never a hardcoded absolute path — and derives the operator-facing needle from the
declared manifest, and asserts the SHIPPED refusal's EMITTED message contains it.

THIS TEST REDDENS BY DESIGN WHEN HD RENAMES. The redness is the signal — it is how this
package learns the pointer went stale — and the fix is then to update visium's message, NOT
to relax this test. Never weaken, skip, delete or baseline-away this test to make the tree
green.

MESSAGE-VS-COMMENT SCOPE (#646). visium's `compute/import_visium.py` carries the SAME name
inside the retirement comment above the refusal (the #160 history note), so a bare "is the
string present in the source file" needle would pass with the emitted message regressed —
satisfied by a comment that is never shown to an operator. The needle is therefore asserted
against `str(exc.value)` of the runtime capture driven through the shipped entrypoint
(`VF.load_compute()` → `module.locate_members(...)`), which is what an operator actually
sees. The comment cannot satisfy it.

EXTRACTION ANTI-VACUITY. The derive MUST succeed or the test fails: the `spatial.import-visium-hd`
analysis entry must exist (available ids are named on failure), its `title:` and the
top-level `name:` must be non-empty strings — and those extraction asserts run BEFORE the
containment assert, so a silent extraction break cannot pass the containment leg vacuously.
NEEDLE CHOICE (DEC-1): the operator-facing needle is the analysis `title:` (analyses are
displayed by `title` in the launcher); the `name:` is derived as the anti-vacuity companion
but a name-only divergence does not redden by design (recorded rule; `name == title` is
deliberately NOT asserted — HD's internal consistency is not this package's to pin).

THE FULL EXPECTED STRING NEVER APPEARS AS A LITERAL HERE. The needle is a variable holding HD's
declared value; the assertion strings name the contract, never the display name, so this
file's own text can neither satisfy nor defeat the check (the TEST-25 / TEST-135 idiom).

EXPLICIT `encoding="utf-8"` on every file read (the repo convention — manifiests carry em
dashes, and a locale-default read under LC_ALL=C would raise or mis-decode).
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


#: The ANALYSIS id the derive matches on (the dotted `id:` in
#: `contributes.analyses` — NOT the top-level package `id:`, which is hyphenated).
#: MUTATION SEAM: a phase-8 discrimination rung breaks this constant and the whole
#: derive leg must redden — it is the one key the extractor reads.
_HD_ANALYSIS_ID = "spatial.import-visium-hd"


#: The package dirs, derived from THIS file's location (mirroring HD TEST-25's derive shape:
#: `Path(__file__).resolve().parents[1]` is this package, and the sibling is one parent up).
_VISIUM_PKG = Path(__file__).resolve().parents[1]
_HD_PKG = _VISIUM_PKG.parent / "spatial-import-visium-hd"
_HD_MANIFEST = _HD_PKG / "manifest.yaml"


def _derive_hd_importer(manifest_text):
    """Derive `(name, analysis_title)` from HD's manifest text.

    Raises `AssertionError` carrying the extracted values / declared ids when the entry is
    missing or a value is not a non-empty string — anti-vacuity: extraction MUST succeed or
    the caller reddens, and the failure states what was actually found. PURE (takes text), so
    the positive-control legs can prove the needle follows the declaration rather than a
    literal.
    """
    doc = yaml.safe_load(manifest_text)
    assert isinstance(doc, dict), "HD manifest did not parse to a mapping"
    name = doc.get("name")
    assert isinstance(name, str) and name.strip(), (
        "HD manifest declares no non-empty top-level `name:` — "
        f"got {name!r}"
    )
    contributes = doc.get("contributes") or {}
    analyses = contributes.get("analyses") or []
    entry = next(
        (a for a in analyses if isinstance(a, dict) and a.get("id") == _HD_ANALYSIS_ID),
        None,
    )
    ids = [a.get("id") for a in analyses if isinstance(a, dict)]
    assert entry is not None, (
        f"HD manifest has no analysis entry with id {_HD_ANALYSIS_ID!r}; "
        f"declared analysis ids: {ids}"
    )
    title = entry.get("title")
    assert isinstance(title, str) and title.strip(), (
        f"the {_HD_ANALYSIS_ID!r} analysis declares no non-empty `title:` — got {title!r}"
    )
    return name, title


def test_TEST_1_the_HD_importer_name_is_derived_and_asserted_in_the_emitted_refusal(tmp_path):
    r"""TEST-1 [acceptance] [invariant: INV-1, INV-2, INV-3] [covers: ITEM-1, ITEM-2, ITEM-3,
    ITEM-6] — REDDENS BY DESIGN when HD renames; see the module docstring for the contract.
    """
    # ── 1. DERIVE (anti-vacuity: extraction asserts run BEFORE the containment assert) ──
    manifest_text = _HD_MANIFEST.read_text(encoding="utf-8")
    hd_name, hd_title = _derive_hd_importer(manifest_text)
    # The needle is the declared analysis title — a VALUE, never a literal here.
    needle = hd_title

    # ── 2. DRIVE THE SHIPPED ENTRYPOINT (what an operator actually sees) ────────────────
    module = VF.load_compute()
    bundle = VF.make_variant(tmp_path)
    (bundle / "binned_outputs" / "square_008um").mkdir(parents=True)
    (bundle / "binned_outputs" / "square_008um" / "filtered_feature_bc_matrix.h5").write_bytes(
        b""
    )
    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_members(bundle)
    message = str(exc.value)

    # ── 3. INV-2: the emitted message carries the DERIVED needle (comment cannot satisfy) ──
    assert needle in message, (
        "the `binned_outputs/` refusal's EMITTED message no longer names the HD importer by "
        f"the name HD's manifest declares: derived title {needle!r}, top-level name "
        f"{hd_name!r} (from {_HD_MANIFEST}); emitted message: {message!r} — this test "
        "REDDENS BY DESIGN when HD renames its analysis title; the fix is to update "
        "visium's message, never to relax this test"
    )

    # ── 4. SHAPE MARKERS: the capture is a genuine HD refusal, and its shape is pinned ──
    # (so a silently-changed message cannot satisfy the containment leg by accident while
    # meaning something else — the needle "matched something" we can still identify).
    assert "is a Visium HD bundle" in message, (
        f"the runtime capture lost the HD-bundle clause: {message!r}"
    )
    assert "hide the platform gap rather than close it" in message, (
        f"the runtime capture lost the platform-gap clause: {message!r}"
    )

    # ── 5. ANTI-VACUITY: the derived name is live too (DEC-1 divergence rule: a name-only
    # divergence does not redden by design; a non-empty name is the extraction floor).
    assert isinstance(hd_name, str) and hd_name.strip(), f"derived name is empty: {hd_name!r}"


def test_TEST_2_the_derive_follows_the_manifest_not_a_baked_literal():
    r"""TEST-2 [covers: ITEM-1, ITEM-6] — POSITIVE CONTROL (TEST-135 idiom).

    A derive pin that silently matched a constant would pass with the manifest edited — the
    exact vacuity #654 files. These legs prove the extractor tracks the DECLARATION: (a) a
    doctored copy whose `title:` is swapped for a sentinel yields the sentinel (the needle is
    read from the text, not baked in); (b) a copy whose analysis `id:` no longer matches the
    key constant RAISES with the available ids (a broken extraction turns the test RED, never
    vacuously green); (c) the real manifest yields non-empty values and the real analysis
    entry exists, asserted against the SAME text the shipped test reads.
    """
    real_text = _HD_MANIFEST.read_text(encoding="utf-8")
    real_name, real_title = _derive_hd_importer(real_text)
    assert isinstance(real_title, str) and real_title.strip(), (
        f"the real HD analysis title came back empty: {real_title!r}"
    )
    assert isinstance(real_name, str) and real_name.strip(), (
        f"the real HD top-level name came back empty: {real_name!r}"
    )

    # (a) sentinel leg — title replacement must be seen
    sentinel = "Sentinel Rename Control Name"
    doctored = real_text.replace("title: " + real_title, "title: " + sentinel, 1)
    assert doctored != real_text, "the doctored title replacement did not apply at all"
    d_name, d_title = _derive_hd_importer(doctored)
    assert d_title == sentinel, (
        f"the derived needle did not follow the doctored declaration: got {d_title!r}, "
        f"expected the sentinel {sentinel!r} — the pin is matching a literal, not the manifest"
    )
    assert d_name == real_name, (
        f"the doctored name leg changed unexpectedly: {d_name!r} vs {real_name!r}"
    )

    # (b) broken-entry leg — a wrong analysis id must redden, with the ids it did find
    broken = real_text.replace("id: " + _HD_ANALYSIS_ID, "id: " + _HD_ANALYSIS_ID + "-x", 1)
    assert broken != real_text, "the doctored id replacement did not apply at all"
    with pytest.raises(AssertionError) as exc:
        _derive_hd_importer(broken)
    assert "declared analysis ids" in str(exc.value), (
        "the broken-extraction failure must name the ids it actually found, not pass "
        f"vacuously: {exc.value}"
    )
