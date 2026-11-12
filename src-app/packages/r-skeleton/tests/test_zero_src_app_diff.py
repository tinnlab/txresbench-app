#!/usr/bin/env python3
# ruff: noqa
"""TEST-10 [acceptance] [invariant: INV-4] — the R skeleton's core cost, enumerated.

INV-4 says: **zero `src-app` changes for the PACKAGE half.** The skeleton analysis is
pure package data; the ONE core change E6 is entitled to make is the language-gated
helper staging (E6/ITEM-4, DEC-2), which is a platform gap rather than a package
requirement. This file is that claim in executable form: it reads the BRANCH DIFF and
refuses any `src-app` change outside `src-app/packages/r-skeleton/` that is not
enumerated below WITH its reason.

## Why this file is gated, and on what

It asserts a property of a DIFF, not of the code, so it is scoped by
`_lib/zero_core_guard.require_introducing_branch` — the shared, derived helper
(`docs/design/derived-guards.md` §3): it runs in full on the branch whose
`src-app/packages/r-skeleton/manifest.yaml` appears among the ADDED paths, and SKIPS
elsewhere with a stated reason naming the package. Without that gate this guard would
re-execute on every future branch and assert that THAT branch also touched nothing
outside a package it has nothing to do with — the measured defect the helper exists to
remove.

## Where this copy DIFFERS from its SIX siblings, stated rather than smuggled

The sibling guards refuse `src-app/server/src/` outright. This one cannot, because E6
is entitled to exactly one core edit and refusing it would mean either a red guard or a
silently-widened prefix. So the refusal is kept and the exception is made VISIBLE:

  * `SANCTIONED_CORE` — production-source paths, named ONE AT A TIME, each with the
    ITEM it belongs to. A prefix rule (`.../sandbox/`) would have granted every future
    sandbox edit for free, which is the failure mode the siblings' own docstrings name.
  * The refusal is unchanged for every other path: a second core file, or a different
    one, still fails with `server src changed`.
  * `test_the_sanctioned_sets_are_not_quietly_larger_than_they_claim` pins BOTH sets'
    sizes, so appending a path is a number somebody has to change and justify.

Mutation (run on this branch): delete `processors/mod.rs` from `SANCTIONED_CORE` ->
`test_no_app_ui_or_unsanctioned_server_source_changed` fails naming it. Add any other
`src-app/server/src/` path to the diff -> the same test fails. Add an unsanctioned
`src-app/server/tests/` path -> `test_only_the_package_and_the_sanctioned_set_changed`
fails naming it.
"""
import sys
from pathlib import Path

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when a suite is run with a narrower
# rootdir than the canonical `cd src-app/packages && python3 -m pytest` — which is
# exactly how `_lib/test_zero_core_guard.py` drives this file in its synthetic repo.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    infra_exempt,
    package_prefix,
    require_introducing_branch,
)


#: PRODUCTION SOURCE this branch is entitled to change. Named one path at a time, never
#: by prefix. This is INV-4's "one core change" made checkable.
SANCTIONED_CORE = {
    # E6/ITEM-4 + DEC-2 — the Python-only helper-staging gate. `resolve_entry` stages the
    # app's cross-cutting helpers only `if matches!(language, Language::Python)`, and the
    # manifest-import conformance scan `continue`s on non-Python. E6 turns both from an
    # accident into a STATED, tested contract: an R entry receives its own package's
    # declared `run.helpers` and nothing else. This is a platform gap, not something the
    # skeleton package needs — which is precisely why INV-4 names it as the exception.
    "src-app/server/src/modules/sandbox/processors/mod.rs",
}

#: REPO-ROOT (non-`src-app/`) files this branch is entitled to change. The SIX sibling
#: guards have no equivalent, and that gap is real: they all `continue` on any path that
#: does not start with `src-app/`, so a stray `package-lock.json` mutation — which is
#: exactly what an `npm install` against a partially-checked-out submodule writes — passes
#: every one of them. This branch shipped that mutation and a blind auditor found it,
#: which is why the guard now looks there too.
SANCTIONED_ROOT = {
    # E6/#194 — `just test-sandbox` must hand the tier the PER-ENV air-gap seams. A bare
    # seam serves exactly ONE env, so without this an analysis declaring a NON-DEFAULT env
    # self-skips — and under `TXR_TEST_NO_SKIP=1` a self-skip PANICS, turning the
    # acceptance tier red for a missing setup step rather than a defect.
    "justfile",
}

#: NON-SOURCE app files this branch is entitled to change, each with its reason.
SANCTIONED_NON_PACKAGE = {
    # `testpaths` is an ENUMERATION — a suite not listed there is collected by NOTHING,
    # and `just check-py` hard-fails on an unlisted `*/tests` dir. The append lands in
    # the same commit that creates the directory.
    "src-app/packages/pytest.ini",
    # E6/ITEM-5 — the RESTORED R interpreter probe, plus the one line registering the
    # new integration module below. The probe's own standing comment forbade restoring
    # it until the recipe carried R AND the image existed; E6 is that point.
    "src-app/server/tests/sandbox/mod.rs",
    # E6/ITEM-3/6/7 — the end-to-end integration file: the R run, its provenance digest,
    # the env-refusal arms, and the python non-regression control.
    "src-app/server/tests/sandbox/r_walking_skeleton_test.rs",
}


def test_no_app_ui_or_unsanctioned_server_source_changed():
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue
        if infra_exempt(p, root):
            continue
        if p in SANCTIONED_CORE:
            continue
        assert not p.startswith("src-app/ui/"), (
            f"an app UI file changed, which breaks the zero-app-edit invariant: {p}")
        assert not p.startswith("src-app/desktop/"), (
            f"a desktop app file changed: {p}")
        assert not p.startswith("src-app/server/src/"), (
            f"server src changed: {p}")


def test_only_the_package_and_the_sanctioned_set_changed():
    root, pkg, changed = require_introducing_branch(__file__)
    unexpected = []
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle + docs live outside the scope this test guards
        if p.startswith(package_prefix(pkg)):
            continue
        if infra_exempt(p, root):
            continue
        if p in SANCTIONED_CORE or p in SANCTIONED_NON_PACKAGE:
            continue
        unexpected.append(p)
    assert not unexpected, (
        "unexpected non-package src-app change — app file(s) outside the package and "
        "outside the sanctioned set changed:\n  "
        + "\n  ".join(unexpected)
        + "\n\nEach exception is enumerated in this test WITH its reason. Adding one is a "
          "decision to record, not a set to widen.")


def test_no_unsanctioned_repo_root_file_changed():
    """The blind spot every sibling guard shares — closed HERE, and only here.

    All SIX shipped copies of this guard (clustering, differential-expression, embedding,
    spatial-import-visium, spatial-types, trajectory) filter to `src-app/` and silently
    permit anything else. That is how a `package-lock.json` rewrite — the workspace-link
    deletions `npm install` writes when a git submodule is not checked out — rode along on
    this branch until a blind auditor read the diff. It is a real regression: the dropped
    package supplies binaries the check pipeline resolves through `node_modules/.bin`.

    ## Its honest scope, stated because overstating it would be this file's own failure

    Like its siblings' diff assertions, this runs ONLY on the branch that introduces THIS
    package (`require_introducing_branch`). So the class of defect it catches remains
    undetectable on every other branch, and on main after this one merges. Closing it for
    everyone means the check belongs in `_lib/zero_core_guard.py` (or a repo-level guard)
    where all six copies would inherit it — which is a change to shared infrastructure and
    therefore its own item, not a thing to smuggle into a walking skeleton. Recorded as
    generalizable feedback rather than done here.

    `docs/` and `.lifecycle/` are process records, not product code, and are out of scope
    for a guard about app files.
    """
    _root, _pkg, changed = require_introducing_branch(__file__)
    unexpected = [
        p
        for p in changed
        if not p.startswith(("src-app/", "docs/", ".lifecycle/"))
        and p not in SANCTIONED_ROOT
    ]
    assert not unexpected, (
        "unexpected repo-root change(s) outside the sanctioned set:\n  "
        + "\n  ".join(unexpected)
        + "\n\nIf this is a lockfile or a generated file, it is almost certainly a local "
          "environment artifact rather than an intended edit — check your submodules are "
          "checked out before `npm install`, and revert it.")


def test_the_sanctioned_sets_are_not_quietly_larger_than_they_claim():
    """A vacuity floor on the exceptions themselves.

    The two sets are the whole point of this file, so their SIZES are pinned: appending a
    path has to change a number here, which is the moment somebody should be asked why.

    Deliberately NOT gated on the introducing branch: it reads no git at all — it is an
    assertion about two literals in this module, and it must keep asserting on every
    branch, exactly as the sibling guards' equivalent does.

    Its LIMIT, stated because overstating it would be this file's own failure mode: it
    covers the LITERALS and nothing else. It is structurally blind to `infra_exempt`,
    which is a different mechanism in a different file (`_lib/zero_core_guard.py`) and
    which exempts the ten generated client artifacts on ANY branch.
    """
    assert len(SANCTIONED_CORE) == 1, (
        "INV-4 permits E6 exactly ONE production-source change (the ITEM-4 helper-staging "
        "gap). A second one is a decision to record in DECISIONS.md, not a set to grow.")
    assert len(SANCTIONED_NON_PACKAGE) == 3
    assert len(SANCTIONED_ROOT) == 1
    for p in SANCTIONED_ROOT:
        assert not p.startswith("src-app/"), (
            f"{p} is under src-app/ — it belongs in one of the sets above, where the "
            f"UI/production-source refusals still apply to it")
    for p in SANCTIONED_CORE:
        assert p.startswith("src-app/server/src/"), p
    for p in SANCTIONED_NON_PACKAGE:
        assert p.startswith("src-app/"), p
        assert not p.startswith("src-app/ui/"), (
            f"{p} is under the app UI tree — that can never be sanctioned here")
        assert not p.startswith("src-app/server/src/"), (
            f"{p} is server production source — it belongs in SANCTIONED_CORE, where the "
            f"count above forces it to be justified")
