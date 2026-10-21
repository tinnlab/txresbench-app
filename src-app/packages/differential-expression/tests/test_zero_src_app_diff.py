#!/usr/bin/env python3
# ruff: noqa
"""TEST-22 [covers: ITEM-15] — on the branch that INTRODUCES this package, a
`git diff origin/main` over `src-app/` outside the package is EXACTLY the DEC-9
allow-set + the pytest.ini registration line; and the package adds no render source.

## Scope — TEST-6 (fix/zero-core-derived), docs/design/derived-guards.md §3

The two DIFF-scoped assertions here are assertions about a branch, so they are gated on
`zero_core_guard.require_introducing_branch`: they run only on the branch whose
`manifest.yaml` ADD introduced this package, and SKIP elsewhere with a stated reason.
Without that gate they re-executed on every later branch and asserted that branch's
diff was also confined to this package — false for every branch after this one.

`test_package_declares_no_render_source` is the exception, and it moved the OTHER way
(see its docstring): "this package ships no UI source" is a property of the TREE, not
of a diff, so it is now asserted over the package directory on EVERY branch. That is
strictly stronger than the diff form it replaces, which could only ever see a `.tsx`
in the window of the branch that added it.
"""
import sys
from pathlib import Path

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when a suite is run with a narrower
# rootdir than the canonical `cd src-app/packages && python3 -m pytest`.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))


from zero_core_guard import (  # noqa: E402
    infra_exempt,
    package_of,
    package_prefix,
    require_introducing_branch,
    require_introducing_file,
)


# The DEC-9 allow-set — the ONLY sanctioned non-package src-app edits.
#
# `src-app/server/src/modules/datatype/tests/lattice_golden.json` USED to be listed
# here. It was removed by fix/zero-core-derived: that entry existed only because the
# golden froze an exact type count, so contributing a datatype forced an edit under
# `src-app/server/src/` — the very thing this guard exists to forbid. The golden now
# DERIVES the lattice from the package manifests, so nothing forces that edit and the
# exemption has nothing left to excuse. A dead allowlist entry is not free: it is a
# standing permission for exactly the change this test is here to catch.
SANCTIONED = {
    "src-app/packages/pytest.ini",
    "src-app/packages/open-kinds/manifest.yaml",
    "src-app/env-rootfs/single-cell/Dockerfile",
    "src-app/server/tests/workstore/open_kinds_serve_test.rs",
}

_RENDER_SOURCE_SUFFIXES = (".tsx", ".jsx")


def test_only_the_package_and_the_sanctioned_set_changed():
    root, pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the guard's scope
        if p.startswith(package_prefix(pkg)) or infra_exempt(p, root):
            continue
        assert p in SANCTIONED, f"unexpected non-package src-app change (DEC-9): {p}"


def test_package_declares_no_render_source():
    """TEST-14 — the package ships no `.tsx`/`.jsx`, asserted over the TREE, not a diff.

    This was `test_package_adds_no_render_source`, which scanned the branch diff for a
    render source added under the package prefix. That could only ever fire during the
    one branch that added such a file: a `.tsx` merged to main was invisible to it from
    the next commit onward, which is the wrong way round for an invariant about what the
    package IS. Reading the directory asserts the same property permanently, on every
    branch, and needs no diff — so it is deliberately NOT gated on the introducing
    branch.
    """
    # Resolved from THIS FILE, not from git. `repo_root()` skips when the tree is not a
    # git checkout, which is right for a diff-scoped guard and wrong for this one: a tree
    # assertion has no reason to stop asserting in a source tarball. (Round-1 audit.)
    pkg_dir = Path(__file__).resolve().parents[1]
    assert pkg_dir.is_dir(), f"the package directory is missing: {pkg_dir}"
    files = [p for p in pkg_dir.rglob("*") if p.is_file()]
    # ANTI-VACUITY ANCHOR, BY NAME rather than by count — the idiom
    # `scripts/check-kinds-zero-core.sh` adopted when it replaced `MIN_FILES=8`: a count
    # cannot say WHICH path stopped resolving, and it rots on every legitimate change. The
    # package's own manifest is the file whose EXISTENCE defines the package, so a walk that
    # did not see it is pointed somewhere wrong, whatever its size.
    assert pkg_dir / "manifest.yaml" in files, (
        f"the render-source scan did not see {pkg_dir}/manifest.yaml — the walk is pointed "
        f"at the wrong directory or collapsed, so the assertion below would pass having "
        f"checked nothing (walked {len(files)} file(s))"
    )
    offenders = sorted(
        str(p.relative_to(pkg_dir))
        for p in files
        if p.suffix in _RENDER_SOURCE_SUFFIXES
    )
    assert offenders == [], f"the package ships render source: {offenders}"


# The advanced-contrast cut's OWN add-only marker: the vendored criteria kernel, which
# that branch (and only that branch) added. See `test_advanced_contrast_is_package_only`.
_ADVANCED_CONTRAST_MARKER = "compute/_criteria.py"

#: The same marker as a repo-relative path — one spelling, so the guard and the control below
#: cannot come to mean different files.
ADVANCED_CONTRAST_MARKER_PATH = (
    f"{package_prefix(package_of(__file__))}{_ADVANCED_CONTRAST_MARKER}"
)


def test_the_arming_marker_names_a_real_file():
    """UNGATED. A marker that names nothing is a guard switched off, not a branch skipped.

    `require_introducing_file` takes its marker as a free string — the one input it does not
    derive — so a rename of the vendored criteria kernel silently and permanently disarms the
    advanced-contrast guard below, and the skip it prints looks exactly like the ordinary
    not-my-branch case. A blind audit demonstrated that on the two other marker-keyed guards
    in this tree; this control is what stops it here.
    """
    root = Path(__file__).resolve().parents[4]
    assert (root / ADVANCED_CONTRAST_MARKER_PATH).is_file(), (
        f"the arming marker `{ADVANCED_CONTRAST_MARKER_PATH}` names no file in this tree, so "
        f"`test_advanced_contrast_is_package_only` can never run again on any branch.")


def test_advanced_contrast_is_package_only():
    """DE v0.2 (advanced contrast) is package-ONLY — STRICTER than v1's SANCTIONED allow-set.

    v1 extended the `de/result` datatype + the env-rootfs; this cut changes NO datatype,
    rootfs, or server file (the criteria kernel is numpy-only + vendored verbatim). Assert
    the diff vs main OUTSIDE the package is EMPTY (TEST-10 / BASE.md).

    ## Why this one does NOT use the package's manifest as its marker (round-1 audit)

    Its subject is the ADVANCED-CONTRAST branch, not the branch that introduced the
    package — and those are two different branches. Verified from history: the manifest was
    added in `0114f3a3` ("de(package): differential-expression declarative package") and
    this assertion first appears in `b6de4c12` ("de-adv …"), with the criteria kernel added
    in `9c59529c`. Gating it on the manifest ADD would have been strictly worse than not
    gating it at all: it could never run on the branch it describes, AND on the manifest-ADD
    branch it would FAIL, because that branch legitimately touches `packages/pytest.ini`
    outside the package while this assertion permits no allow-set whatsoever. Mutually
    unsatisfiable with its sibling above, i.e. inert forever — `derived-guards.md` §5's
    "deleting the assertion", reached by mis-derivation rather than by deletion.

    So it carries its OWN add-only marker, derived the same way: the branch that ADDED the
    vendored criteria kernel is the advanced-contrast branch.
    """
    pkg = package_of(__file__)
    marker = ADVANCED_CONTRAST_MARKER_PATH
    # Delegated to the shared marker-keyed gate rather than open-coded. This was the FOURTH
    # copy of that body in the tree (`spatial-import-xenium`'s two and `_helpers`' one were
    # the others), which is how the git plumbing `zero_core_guard` replaced got triplicated
    # and diverged in the first place — and it is the copy the repo-wide sweep found, which
    # is what a sweep is for. Behaviour and premise are unchanged; the skip reason keeps this
    # guard's own sentence through `reason=`, so a `-rs` summary still says WHICH branch this
    # assertion belongs to and why it is not the package's introducing one.
    root, changed = require_introducing_file(
        marker, __file__,
        reason="This assertion describes the ADVANCED-CONTRAST branch's diff, not the one "
               "that introduced the package; those are two different branches.")
    outside = [p for p in changed
               if p.startswith("src-app/") and not p.startswith(package_prefix(pkg))
               and not infra_exempt(p, root)]
    assert outside == [], f"advanced contrast must be package-only; non-package changes: {outside}"
