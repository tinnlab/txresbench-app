#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [acceptance] [invariant: INV-6] — the zero-core anchor, as a DIFF.

**INV-6**, lifted verbatim from `docs/design/spatial-storage-layout.md` §6.7
(ON `main` — restored by #315 (`b34d4371`), reconciled against what shipped; every
quotation below was re-verified against that merged text):

> **Visium HD cannot use this path**: `binned_outputs/square_002um|008um|016um/` each
> contain identically-named files, so every member has three candidates and grouping returns
> `None`. Visium HD therefore needs either a per-bin upload or a directory-aware member
> matcher — filed as a `[shared]` platform item (§13), **not** worked around in the importer.

#160 delivered the directory-aware matcher, in the CORE, as a `[shared]` item. What is left
for this item is the importer — and the invariant's own words say what that importer may
NOT do: work around grouping. So this package consumes what the container already grouped,
teaches the core nothing about 10x, and its entire contribution is a package directory plus
one `pytest.ini` line. That is the claim, and this is the direct statement of it: on the
branch that introduces this package, `git diff <base>...HEAD --name-only` contains no path
under `src-app/ui/` or `src-app/server/`, and the only `src-app/` path outside this package
is the sanctioned one below.

## The guard is DERIVED, not hardcoded to a branch

The three earliest copies of this guard asserted a property of the BRANCH while living in a
PACKAGE, so they were vacuously true on `main` and false on every later branch.
`zero_core_guard.require_introducing_branch` derives WHICH branch the assertion belongs to
from the diff itself (add-only, keyed on this package's own `manifest.yaml` appearing among
the ADDED paths) and SKIPS elsewhere with a stated reason. So this runs IN FULL here — the
branch it describes — and skips visibly everywhere after.
"""
import sys
from pathlib import Path

import pytest

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when a suite is run with a narrower rootdir
# than the canonical `cd src-app/packages && python3 -m pytest`.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    infra_exempt,
    package_prefix,
    require_introducing_branch,
)

#: The sanctioned non-package `src-app/` paths for THIS package's introducing branch.
#: Package-specific and deliberately NOT shared — a union across packages would grant every
#: package every other package's exemptions, which is the prefix-exemption failure in a new
#: costume (`docs/design/derived-guards.md` §5).
#:
#: * `pytest.ini` — the `testpaths` append, and nothing else. That file's own header requires
#:   a new `<package>/tests/` directory to be enumerated in the SAME commit that creates it;
#:   a suite absent from it is collected by NOTHING, and a gate that cannot run is
#:   indistinguishable from a gate that passes.
#:
#: There is deliberately no entry for `env-rootfs/single-cell/requirements.txt`, even though
#: this package declares `pyarrow`: #163 already pinned it there for
#: `spatial-import-xenium`'s boundaries reader, so this package is its SECOND consumer and
#: needs no recipe edit. If a future dependency did need one, it would be named here rather
#: than covered by a prefix.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
}


def test_TEST_6_no_ui_and_no_server_file_changed():
    """TEST-6 [acceptance, INV-6] — nothing under `src-app/ui/`, `src-app/desktop/` or `src-app/server/`.

    A BLANKET assertion with no named exception, which is stronger than the sibling
    packages' version of this guard and is what INV-6 actually promises: #160 already paid
    the core cost, so an importer that needed a second core change would mean the container
    #160 delivered does not express this bundle after all.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/") or infra_exempt(p, root):
            continue
        assert not p.startswith("src-app/ui/"), f"UI file changed (breaks INV-6): {p}"
        assert not p.startswith("src-app/desktop/"), f"desktop file changed (INV-6): {p}"
        assert not p.startswith("src-app/server/"), (
            f"server file changed: {p}. INV-6 says the platform half is #160's and is "
            "already landed; an importer that needs a core edit is working around grouping "
            "rather than consuming it."
        )


def test_TEST_6_only_this_package_and_the_sanctioned_set_changed():
    """TEST-6 [acceptance, INV-6] — everything else under `src-app/` is this package's own tree."""
    root, pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the src-app scope this test guards
        if p.startswith(package_prefix(pkg)) or infra_exempt(p, root):
            continue
        assert p in SANCTIONED_NON_PACKAGE, (
            f"unexpected non-package src-app change (INV-6 zero-core): {p}"
        )


def test_TEST_6_no_rust_or_typescript_file_changed_anywhere():
    """TEST-6 [acceptance, INV-6] — the invariant stated by LANGUAGE as well as by path.

    A second reading of the same promise, and not redundant: the path assertions above are
    about `src-app/`, so a `.rs` under `sdk/` or a `.ts` under `scripts/` would pass them
    while still meaning this contribution is not pure data. INV-6's claim is that the
    importer is DATA — a manifest and Python — and this is the direct form of that.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    offenders = [p for p in changed
                 if p.endswith((".rs", ".ts", ".tsx")) and not infra_exempt(p, root)]
    assert not offenders, (
        f"this branch changes compiled source ({offenders}), so the contribution is not the "
        "pure-data one INV-6 promises"
    )


def test_TEST_6_the_positive_control_the_guard_actually_measured_something():
    """TEST-6 [acceptance, INV-6] — the control, without which every assertion above is vacuous.

    "No file under `src-app/server/` changed" is satisfied by an EMPTY diff, by a guard
    pointed at the wrong base, and by a branch that never got committed. The three
    assertions above would then be green while measuring nothing — which is the exact
    failure shape a `[negative-perm]` e2e without a positive control has, one layer over.

    So: the diff must be non-empty, it must contain this package's own manifest (which is
    what `require_introducing_branch` keys on, restated here as an assertion rather than
    trusted as a side effect), and it must contain the compute entry — because a branch that
    added the manifest and no code would satisfy everything else.
    """
    root, pkg, changed = require_introducing_branch(__file__)
    assert changed, "the diff is EMPTY, so every assertion in this module measured nothing"
    prefix = package_prefix(pkg)
    assert f"{prefix}manifest.yaml" in changed, (
        f"this package's manifest is not in the diff (prefix {prefix!r}); the guard is "
        "looking at the wrong branch or the wrong package"
    )
    assert f"{prefix}compute/import_visium_hd.py" in changed, (
        "the compute entry is not in the diff — a branch that added the manifest and no "
        "importer would pass every other assertion here"
    )
