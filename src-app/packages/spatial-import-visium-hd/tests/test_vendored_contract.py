#!/usr/bin/env python3
# ruff: noqa
"""TEST-20 — four vendored files are BYTE-IDENTICAL, and one deliberately is NOT.

This package vendors FOUR files it did not write, for two different reasons:

* `compute/spatial_declarations.py` and `compute/ome_writer.py` are the write-time contract
  and the OME-TIFF writer, copied from `spatial-types`. The platform confines `run.helpers`
  to a package's OWN tree, so vendoring is the idiom here rather than an exception — three
  packages already do it — and the manifest's own `run.helpers` comment names this file as
  what holds the copies honest.
* `tests/visium_hd_refusal_sites.py` and `tests/sandbox_code_dir.py` are the two STRUCTURAL HARNESSES
  #336 and #211 established, copied from `spatial-import-visium/tests/`. DEC-4 exists for
  precisely this: the refusal class is named `VisiumImportError` — the sibling's name, in a
  different module — SO THAT the 777-line AST guard can be vendored byte-identically instead
  of forked over one string. A forked structural guard is the "second implementation wearing
  the first one's name" that this file exists to refuse.

## Why the comparison is BYTES and not behaviour

A behavioural comparison passes for a copy that drifted in a refusal message, a comment or a
docstring — and those are exactly where these four modules' rules live. `spatial_declarations`
is READ by producers to know what they may declare; `visium_hd_refusal_sites`' docstrings carry the
measured record of the twelve defeats its classifier was hardened against. A copy that agrees
on every call and disagrees on every sentence is a fork nobody labelled.

## And the file that must NOT match

`compute/registration_qc.py` is this package's OWN (DEC-5). The last test in this file asserts
that it differs from BOTH siblings' copies, so a future maintainer reading "vendored contract"
at the top of this file cannot conclude the difference is a drift to be "fixed".
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402

#: `(vendored copy, source of truth)` for every file this package carries verbatim.
#:
#: The two `compute/` entries are staged into `/code` by `run.helpers`; the two `tests/`
#: entries never leave this directory. Both kinds are listed together because the property is
#: the same one and stating it twice invites the two statements to drift.
VENDORED = {
    "compute/spatial_declarations.py": (
        HF.PKG / "compute" / "spatial_declarations.py",
        HF.PACKAGES / "spatial-types" / "compute" / "spatial_declarations.py",
    ),
    "compute/ome_writer.py": (
        HF.PKG / "compute" / "ome_writer.py",
        HF.PACKAGES / "spatial-types" / "compute" / "ome_writer.py",
    ),
    "tests/visium_hd_refusal_sites.py": (
        HF.PKG / "tests" / "visium_hd_refusal_sites.py",
        HF.PACKAGES / "spatial-import-visium" / "tests" / "visium_refusal_sites.py",
    ),
    "tests/sandbox_code_dir.py": (
        HF.PKG / "tests" / "sandbox_code_dir.py",
        HF.PACKAGES / "spatial-import-visium" / "tests" / "sandbox_code_dir.py",
    ),
}

#: This package's OWN registration QC, and the two copies it is NOT a copy of.
REGISTRATION_QC = HF.PKG / "compute" / "registration_qc.py"
SIBLING_REGISTRATION_QC = {
    "spatial-import-visium": HF.PACKAGES / "spatial-import-visium" / "compute" / "registration_qc.py",
    "spatial-import-xenium": HF.PACKAGES / "spatial-import-xenium" / "compute" / "registration_qc.py",
}


@pytest.mark.parametrize("relative", sorted(VENDORED))
def test_TEST_20_the_vendored_file_is_BYTE_IDENTICAL_to_its_source_of_truth(relative):
    """TEST-20 — the whole justification for vendoring rests on this one comparison.

    Compared as BYTES. A behavioural comparison would pass for a copy that had drifted in a
    comment, a refusal message or a docstring, and for all four of these files that is where
    the rules actually are: a producer reads `spatial_declarations`' docstrings to know what it
    may declare, and `visium_hd_refusal_sites`' docstrings carry the measured record of every defeat its
    classifier was hardened against. Two files that agree on every call and disagree on every
    sentence are a fork wearing the original's name.

    What this would catch: someone "fixing" a lint in the vendored copy, or teaching the
    vendored AST guard about one shape this module happens to use. Either leaves a rule
    enforced in one place and not the other with nothing anywhere saying so.
    """
    vendored, source_of_truth = VENDORED[relative]
    assert source_of_truth.exists(), (
        f"the source of truth for {relative} ({source_of_truth}) is gone; a vendored copy "
        "with nothing to compare against is just a fork"
    )
    assert vendored.exists(), f"{relative} is not present in this package at all"
    assert vendored.read_bytes() == source_of_truth.read_bytes(), (
        f"`{relative}` has drifted from {source_of_truth}. Re-copy it; do not edit it here. "
        "If the change is genuinely needed, make it at the source of truth and re-vendor "
        "every copy in the same commit."
    )


def test_TEST_20_the_byte_comparison_can_actually_FAIL():
    """TEST-20 — the positive control: `read_bytes() == read_bytes()` must not be vacuous.

    Every assertion above is an equality between two files that are equal today. If the
    comparison were made against the file itself — a copy/paste slip in the [`VENDORED`]
    table is enough — every row would pass forever and this whole module would measure
    nothing. So the table is asserted to name two DISTINCT paths per row, and the comparison
    operator is exercised on a pair that is known to differ.
    """
    for relative, (vendored, source_of_truth) in sorted(VENDORED.items()):
        assert vendored.resolve() != source_of_truth.resolve(), (
            f"{relative} compares a file against ITSELF, so its row cannot fail"
        )

    # The operator itself, on a pair that really differs — `registration_qc.py` against a
    # vendored file. If `read_bytes()` comparison could not distinguish two files, this fails.
    assert REGISTRATION_QC.read_bytes() != VENDORED["compute/ome_writer.py"][0].read_bytes()


def test_TEST_20_the_importer_resolves_the_VENDORED_helpers_not_spatial_types_originals():
    """TEST-20 — the staging the manifest declares, exercised rather than assumed.

    `run.helpers` stages the COPY beside the entry, so in `/code` the bare name
    `spatial_declarations` has exactly one file to resolve to. A pytest process is not that
    dir: FOUR copies of `spatial_declarations.py` and THREE of `ome_writer.py` live in this
    tree, and whichever suite ran first would otherwise own the bare name for the whole
    session. `hd_fixtures.load_compute` reproduces `/code` by loading each helper from its own
    PATH; this asserts the reproduction actually landed.

    What it would catch: a `load_compute` that fell back to `sys.path`, or a suite ordering in
    which `spatial-types`' own tests ran first. Either way every assertion in every other file
    in this directory would be about a module this package does not ship.
    """
    module = HF.load_compute()
    assert Path(module.SD.__file__).resolve() == VENDORED["compute/spatial_declarations.py"][0].resolve(), (
        f"the importer resolved `spatial_declarations` to {module.SD.__file__}, not to this "
        "package's vendored copy — every declaration assertion in this suite would be about "
        "another package's module"
    )
    assert Path(module.ome_writer.__file__).resolve() == VENDORED["compute/ome_writer.py"][0].resolve(), (
        f"the importer resolved `ome_writer` to {module.ome_writer.__file__}, not to this "
        "package's vendored copy"
    )
    # ...and the THIRD helper, which is the one that is NOT a copy. A session that resolved
    # this bare name to the Visium module would silently test the 100 um slide-pitch referent
    # instead of this module's bin-pitch one — `hd_fixtures.load_compute`'s docstring names
    # exactly that hazard, and this is the assertion that makes it visible.
    assert Path(module.registration_qc.__file__).resolve() == REGISTRATION_QC.resolve(), (
        f"the importer resolved `registration_qc` to {module.registration_qc.__file__}, not "
        "to this package's own copy — the scale check's referent would be the Visium slide's "
        "100 um spot pitch rather than this bundle's bin lattice pitch"
    )


def test_TEST_20_registration_qc_is_DELIBERATELY_not_byte_identical_to_either_sibling():
    """TEST-20 / DEC-5 — the difference is the design, not a drift. Do not "fix" it.

    DEC-5: *"this package's OWN, adapted from `spatial-import-visium`'s copy. Its header says
    so explicitly, and there is deliberately NO byte-compare test for it."* The basis is that
    the two existing copies (Visium's 1236 lines and Xenium's 1563) ALREADY differ from each
    other, because the referent the scale check measures against is per-platform: for HD it is
    the BIN LATTICE PITCH, which Visium does not have and whose copy hardcodes the slide's
    `SLIDE_SPOT_PITCH_UM = 100.0` instead.

    So this test asserts the NEGATIVE, and it is here rather than absent for one reason: this
    file's title is "the vendored contract", and a maintainer who reads the three passing
    byte-compares above and then finds a fourth `registration_qc.py` in `compute/` has every
    reason to think a byte-compare was forgotten. Adding one would assert an identity that is
    FALSE BY DESIGN; monkey-patching the pitch constant onto a vendored copy would leave the
    emitted block saying `referent: "visium-slide-spot-pitch"` about a measurement taken
    against a bin grid — fabricated provenance in the one channel #257 added so that a reader
    would not have to derive provenance.

    What this would catch: exactly that "fix" — someone re-vendoring the sibling's copy over
    this one to make the directory look consistent.
    """
    ours = REGISTRATION_QC.read_bytes()
    for package, sibling in sorted(SIBLING_REGISTRATION_QC.items()):
        assert sibling.exists(), (
            f"{sibling} is gone, so 'ours differs from theirs' is no longer a measurable "
            "claim — re-read DEC-5 before deleting this assertion"
        )
        assert ours != sibling.read_bytes(), (
            f"`compute/registration_qc.py` is now byte-identical to {package}'s copy. That is "
            "not a repair, it is a regression: the referent this module checks against is the "
            "BIN LATTICE PITCH and the sibling's is a hardcoded 100 um slide spot pitch, so "
            "the emitted `registration` block would now state a referent it did not measure. "
            "See DECISIONS.md DEC-5."
        )

    # And the difference is SUBSTANTIVE, not a stray byte: this module names the bin lattice
    # as its referent and does NOT carry the sibling's slide-pitch constant. Without this leg
    # the assertion above would be satisfied by a one-character comment change.
    text = REGISTRATION_QC.read_text(encoding="utf-8")
    assert "SLIDE_SPOT_PITCH_UM" not in text, (
        "this package's registration QC now carries the sibling's slide-pitch constant — the "
        "referent it measures against is the bin lattice, not a Visium slide (DEC-5)"
    )
    assert "bin" in text.lower(), (
        "this package's registration QC no longer mentions the bin lattice at all, so the "
        "'it differs from the siblings' assertion above is satisfied by a difference that is "
        "not the one DEC-5 is about"
    )
