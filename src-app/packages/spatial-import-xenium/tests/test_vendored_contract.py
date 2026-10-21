#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 — the vendored copies are BYTE-IDENTICAL to their source of truth.

`run.helpers` is confined to a package's own tree, so a second importer that needs the same
write-time contract must VENDOR it. That is the established idiom, not an exception —
`spatial-import-visium` vendors `spatial_declarations.py` and `embedding` vendors
`cell-filter`'s predicate kernel the same way. But a vendored file that DRIFTS is a second
implementation wearing the first one's name: the same import, the same symbols, different
behaviour, and no gate anywhere would notice.

#162 promoted `ome_writer.py` into `spatial-types` for exactly this reason. Before, its home
was `spatial-import-visium` — which would have made a leaf importer the source of truth for
a sibling importer. Now `spatial-types/compute/` holds both halves of the contract
(`spatial_declarations.py` declares it, `ome_writer.py` writes it) and BOTH importers vendor
from there.

Five files, one digest each, compared against the source.
"""
import hashlib
import sys
from pathlib import Path

import pytest

PACKAGES = Path(__file__).resolve().parents[2]

#: `spatial-types/compute/` is the SOURCE OF TRUTH for both files. Stated as data so the
#: direction of the dependency is readable at a glance and cannot be inverted by an edit.
SOURCE = PACKAGES / "spatial-types" / "compute"

#: Every copy, by the package that ships it. `spatial-import-visium` is included
#: deliberately: this branch changed the file it vendors, and a test that only checked THIS
#: package's copies would let the sibling silently fall behind — which is the exact drift
#: the promotion was meant to make impossible.
#: The names `spatial-types/compute/` is the source of truth for. The CONSUMERS are
#: DERIVED, never listed — a blind extensibility audit proved why: with a hand-written
#: register, it added a THIRD package carrying deliberately-drifted copies of both helpers
#: and every vendored-contract test in the tree stayed GREEN. A guarantee that a new
#: consumer has to volunteer for is not a guarantee; it is a courtesy.
SHARED_NAMES = ("spatial_declarations.py", "ome_writer.py")


def copies_of(name):
    """Every package that ships a file of this name under `compute/`, except the source.

    Globbed, so a fourth copy needs no edit here — the derivation `_lib/zero_core_guard.py`
    already demonstrates for the sibling guard.
    """
    return tuple(sorted(
        path for path in PACKAGES.glob(f"*/compute/{name}")
        if path.parents[1].name != "spatial-types"
    ))


COPIES = {name: copies_of(name) for name in SHARED_NAMES}


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", sorted(COPIES))
def test_every_vendored_copy_is_byte_identical_to_the_source_of_truth(name):
    source = SOURCE / name
    assert source.exists(), (
        f"{source} is the declared source of truth and must exist — if the file moved, "
        "this test is where the move gets reviewed"
    )
    expected = _digest(source)
    for copy in COPIES[name]:
        assert copy.exists(), f"{copy} is declared as a vendored copy but is absent"
        assert _digest(copy) == expected, (
            f"{copy} has DRIFTED from {source}. A vendored file that drifts is a second "
            "implementation wearing the first one's name: same import, same symbols, "
            "different behaviour, and nothing else in this tree would notice. Re-copy from "
            "the source, or move the change INTO the source so every consumer gets it."
        )


def test_the_source_of_truth_is_spatial_types_and_not_a_leaf_importer():
    """TEST-16 — the DIRECTION of the dependency, asserted rather than assumed.

    Byte-identity alone is symmetric: it would pass just as happily with the arrow pointing
    the wrong way, at `spatial-import-visium`. The reason the promotion happened is that a
    leaf importer must not be the source of truth for a sibling, and that is a claim about
    which file is canonical, which no digest can express. So it is asserted structurally:
    the canonical copy lives in the package that declares the contract, and BOTH importers
    are consumers of it.
    """
    assert SOURCE.parent.name == "spatial-types"
    assert (SOURCE / "spatial_declarations.py").exists(), (
        "the declaration and its writer must live TOGETHER — they are two halves of one "
        "contract and splitting them across packages is what created the drift risk"
    )
    consumers = {p.parents[1].name for copies in COPIES.values() for p in copies}
    # A FLOOR plus a derivation, not an equality. The two known consumers must be there —
    # a copy that VANISHED is a package that stopped being covered — but a third is
    # discovered by the glob and covered automatically, which is the whole point of
    # deriving the register rather than writing it down.
    assert {"spatial-import-visium", "spatial-import-xenium"} <= consumers, (
        f"a known consumer stopped shipping a vendored copy; consumers are "
        f"{sorted(consumers)}"
    )


def test_every_vendored_file_is_declared_as_a_run_helper():
    """TEST-16 — a vendored file nothing stages is dead weight the sandbox never sees.

    The copy on disk and the `run.helpers` declaration are two separate facts, and a file
    present but undeclared would import fine under pytest (which puts the package on the
    path) and fail at RUNTIME in the sandbox, where only declared helpers are staged.
    """
    import yaml

    for package in ("spatial-import-visium", "spatial-import-xenium"):
        doc = yaml.safe_load((PACKAGES / package / "manifest.yaml").read_text())
        declared = set()
        for analysis in doc["contributes"]["analyses"]:
            declared.update(analysis["run"].get("helpers") or [])
        for name in COPIES:
            rel = f"compute/{name}"
            assert rel in declared, (
                f"{package} ships {rel} but does not declare it under `run.helpers`; the "
                "sandbox stages ONLY declared helpers, so this would fail at runtime while "
                "passing every test that runs out of the source tree"
            )


def test_the_xenium_only_helper_is_not_vendored_from_anywhere():
    """TEST-16 — the complement: `xenium_image.py` is this package's OWN.

    It is domain code nobody else has a copy of (the reduction of a Xenium morphology stack
    to one plane), so it must NOT appear under `spatial-types/compute/` — a helper promoted
    to the shared package acquires a contract and a second consumer, and this one has
    neither.
    """
    own = PACKAGES / "spatial-import-xenium" / "compute" / "xenium_image.py"
    assert own.exists()
    assert not (SOURCE / "xenium_image.py").exists(), (
        "xenium_image.py has been promoted to spatial-types. If a second consumer really "
        "appeared, add it to COPIES above; if not, this is a promotion with no consumer, "
        "which puts a vendor's specifics into the shared vocabulary package."
    )
    assert not (PACKAGES / "spatial-import-visium" / "compute" / "xenium_image.py").exists()


# ── TEST-9 (#211) — the new symbols resolve from the VENDORED copy ───────────────────


def test_the_mirror_channel_resolves_from_the_copy_each_importer_actually_imports():
    """TEST-9 [acceptance] [invariant: INV-5] — byte-identity, then the symbols, per copy.

    The digest test above proves the bytes match. It does NOT prove that the module an
    importer actually loads carries the new channel — a test that imported the canonical
    `spatial-types` copy (which happens to be resolvable from this pytest process) would go
    green while every shipped importer ran against a stale vendored file. #211 is precisely
    a change to the contract that is vendored, so the symbols are checked in EACH copy, by
    loading it from ITS OWN PATH.

    Loaded by path with a per-copy module name so the three loads cannot alias each other
    through `sys.modules` — which would collapse three assertions into one.
    """
    import importlib.util

    # BYTE-IDENTITY FIRST. This test carries the `[invariant: INV-5]` tag, and INV-5 is
    # about the bytes — symbol presence alone would stay green for a drifted copy that
    # merely still defines the names. The digest is re-asserted here so the tag is earned
    # by the test that bears it rather than by a sibling.
    source_digest = _digest(SOURCE / "spatial_declarations.py")
    for copy in COPIES["spatial_declarations.py"]:
        assert _digest(copy) == source_digest, f"{copy} has drifted"

    required = (
        "SPATIAL_DECLARATION_TOKEN", "STRUCTURE_DECLARATION_KEY",
        "mirror_declarations_into_store", "read_spatial_declarations",
        "require_spatial_declarations",
    )
    paths = [SOURCE / "spatial_declarations.py", *COPIES["spatial_declarations.py"]]
    assert len(paths) >= 3, f"expected the source plus both importers, got {paths}"

    for index, path in enumerate(paths):
        spec = importlib.util.spec_from_file_location(f"_vendored_probe_{index}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for symbol in required:
            assert hasattr(module, symbol), (
                f"{path} carries no {symbol!r} — this copy predates the sandbox-reachable "
                "declaration channel (#211), so an importer loading it would emit "
                "artifacts a sandboxed analysis still cannot read"
            )
        assert module.OME_PLACEMENT_PREFIX == module.SPATIAL_DECLARATION_TOKEN + " "
