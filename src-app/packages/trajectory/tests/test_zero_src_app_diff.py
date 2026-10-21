#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [acceptance] [invariant: INV-6] — adding an analysis needs ZERO app changes.

The executable form of the architecture claim this package exists to demonstrate: an
analysis is a pure DATA package, so the branch diff must contain no application code at all.

The sanctioned set is written as a LITERAL, one path per line with the reason it is there,
so widening it is a visible diff someone has to justify rather than a tolerance that quietly
grows. Three of the six are the cost the research spike predicted for being the first
producer of a previously-unproduced open kind; the rest are mechanical consequences.

Being honest about what this proves: the zero-app-edit guarantee is NOT perfectly clean for
the first producer of a previously-unproduced kind. A guard whose entire purpose was to
notice that event did notice it, and the required work was to record the decision it was
waiting for. That is the guard working, not the architecture failing — and it is why the
exceptions are enumerated here instead of the assertion being softened.

Mutation: on the introducing branch, touch any file under the app's UI or server source that
`infra_exempt` does not cover (below) -> the first test fails. Add a seventh app file without
recording it -> the second test fails and names the path.

## Scope — fix/trajectory-zero-core-guard, docs/design/derived-guards.md §3

This copy was cut before `fix/zero-core-derived` (`eee5935a`) repaired the sibling guards and
merged after it (`8212894b`), so it shipped in the OLD shape: it carried its own git plumbing
and asserted a property of whatever branch happened to be checked out. That is the exact
defect the repair existed to remove, reintroduced — measurably so, since it is what reddens
`_lib/test_zero_core_guard.py`'s TEST-11 pair on `main`.

The two DIFF-scoped assertions here are assertions about a branch, so they are now gated on
`zero_core_guard.require_introducing_branch`: they run only on the branch whose
`manifest.yaml` ADD introduced this package, and SKIP elsewhere with a stated reason naming
the package. The sanctioned set below is UNCHANGED — the same six paths, with the same
recorded reasons.

## WHAT ELSE CHANGED, stated rather than smuggled

Adopting the shared helper is NOT a pure re-scoping, and this file does not get to claim it
is: both assertion bodies gained an `infra_exempt(p, root)` early-continue, which the old
private copy had no equivalent of. That is a real relaxation of what the guard refuses, in
BOTH directions the helper defines it (`_lib/zero_core_guard.py`):

  * `GENERATED_CLIENT_ARTIFACTS` — TEN paths, all under `src-app/ui/`, exempt on ANY branch.
    So on the introducing branch a change to e.g. `src-app/ui/openapi/openapi.json` no longer
    fails the first test, even though that test's own prose forbids `src-app/ui/`. The reason
    is the one every gate in this repository applies: those files are regenerated
    deterministically from reviewed Rust source by a golden-tested generator, so a diff in
    them restates a change already reviewed at its source.
  * `DEPENDENCY_CONTRACT_INFRA` (+ its two prefixes) — nine named `src-app/server/src/` files
    plus `src-app/packages/` and `src-app/server/tests/`, exempt ONLY on a branch that ADDS an
    `src-app/env-rootfs/*/requirements.txt` (#80). Add-only on purpose: a pin BUMP does not
    re-arm it. Trajectory's own introducing branch added no such file, so this arm was inert
    on the one branch this guard describes.

It is adopted rather than reimplemented because the four sibling guards all filter through it
and the point of `_lib/zero_core_guard.py` is that a fourth copy needs no fifth variant. It is
written down here because a widening a reader cannot see is exactly what
`docs/design/derived-guards.md` §5 refuses, and because the SANCTIONED literal below cannot
show it: `infra_exempt` is a different mechanism in a different file.

`test_the_sanctioned_set_is_not_quietly_larger_than_it_claims` is deliberately NOT gated
(DEC-2): it reads no git at all, so it is a property of a module constant rather than of a
diff, and routing it through the gate would make it inert on every branch but one — the
same tree-vs-diff distinction `differential-expression`'s copy records for its
render-source test.

## Where this file's proof lives, and whose numbering the ids belong to

The end-to-end proof of both halves lives one level up and finds THIS FILE by GLOB
(`src-app/packages/*/tests/test_zero_src_app_diff.py`), so it covers this package with no
edit there — and two of the three were RED on `origin/main` because of this file.

The `TEST-n` ids below are `fix/trajectory-zero-core-guard`'s OWN lifecycle numbering
(`.lifecycle/trajectory-zero-core-guard/TESTS.md`). They are NOT `_lib`'s: that file has its
own, different `TEST-n` scheme from `fix/zero-core-derived`, in which TEST-1 is the add-only
marker suite and both shipped-guard tests live under a TEST-11 header. Following an id across
that boundary lands a reader on the wrong test — a round-1 audit finding — so each line names
the FUNCTION as well, and the function is what is authoritative:

  * TEST-1 [invariant: INV-1] — `_lib/test_zero_core_guard.py::test_the_owning_package_is_derived_from_the_modules_own_path`
    (in `_lib`'s own TEST-3 block), with `::test_the_guard_module_spells_no_shipped_package_name`
  * TEST-2 [invariant: INV-2] — `_lib/test_zero_core_guard.py::test_the_shipped_guards_skip_on_a_branch_introducing_another_package`
    (in `_lib`'s own TEST-11 block) — RED on `origin/main`; this rewrite is what greens it
  * TEST-3 [invariant: INV-4] — `_lib/test_zero_core_guard.py::test_the_shipped_guards_still_FAIL_on_their_own_introducing_branch`
    (in `_lib`'s own TEST-11 block) — RED on `origin/main`; this rewrite is what greens it
  * TEST-4 — `test_the_sanctioned_set_is_not_quietly_larger_than_it_claims`, below, in this file.

Be clear about what that binding is and is not: TEST-1/2/3 assert in a file this branch does
NOT modify. They are not inherited from a stranger — this module is literally their subject,
by glob — but their assertion text was authored by `fix/zero-core-derived`, and a reader
checking this branch's work should read it there.
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
    package_prefix,
    require_introducing_branch,
)


#: The ONLY app files this branch is entitled to change, each with the reason it is here.
#: Package-specific and deliberately NOT shared: a union across packages would grant every
#: package every other package's exemptions, which is the prefix-exemption failure in a new
#: costume.
SANCTIONED_NON_PACKAGE = {
    # `testpaths` is an ENUMERATION — a suite not listed here is collected by NOTHING, so
    # the append lands in the same commit that creates the directory.
    "src-app/packages/pytest.ini",
    # The producer register is complete and asserted in BOTH directions, so a new producer
    # of a row-bearing datatype goes red until somebody records what it states. Being the
    # first producer of the open kind also settles the lattice entry that said, verbatim,
    # "Remove this entry when the first producer lands, and decide it then."
    "src-app/packages/_lib/model_coverage_exempt.json",
    # A MECHANICAL consequence of the line above: the seed-version guard globs every
    # package manifest including the framework library's, so changing a file inside it
    # requires moving that package's version forward.
    "src-app/packages/_lib/manifest.yaml",
    # The guard's stated REASON became false the moment a producer landed (its assertion did
    # not). Correcting the reason without weakening the assertion is a test-only change.
    "src-app/server/tests/model_coverage/mod.rs",
    # The exported methods document is the out-of-app trust deliverable, and for THIS
    # analysis the root — and the fact that it determines the whole answer — IS the result.
    # Asserting it on the RENDERED bytes is a case added to an already-exercised suite
    # (`provenance/rest_test.rs` and `export_test.rs` both unzip a bundle and read
    # `methods.md`), not a new surface. This was descoped once on the incorrect premise that
    # it needed one; see DEC-17.
    "src-app/server/tests/provenance/trajectory_methods_test.rs",
    # …and the one line registering the module above.
    "src-app/server/tests/provenance/mod.rs",
}


def test_no_app_ui_or_server_source_changed():
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue
        if infra_exempt(p, root):
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
        if p not in SANCTIONED_NON_PACKAGE:
            unexpected.append(p)
    assert not unexpected, (
        "unexpected non-package src-app change — app file(s) outside the package and "
        "outside the sanctioned set changed:\n  "
        + "\n  ".join(unexpected)
        + "\n\nEach exception is enumerated in this test WITH its reason. Adding one is a "
          "decision to record, not a set to widen.")


def test_the_sanctioned_set_is_not_quietly_larger_than_it_claims():
    """TEST-4 — a vacuity floor on the exceptions themselves.

    The set is the whole point of this file, so its SIZE is pinned: appending a path has to
    change this number, which is exactly the moment somebody should be asked why. It has
    moved twice, and both moves are recorded — once for a version bump the seed guard forces
    (DEC-11), once for the rendered-narration test (DEC-17). Neither is under the app's UI or
    server SOURCE trees, which the loop below refuses outright and which no decision can
    sanction here.

    Deliberately NOT gated on the introducing branch (DEC-2). It reads no git: it is an
    assertion about a literal in this module, and it must keep asserting on every branch.

    ITS LIMIT, stated because the first draft overstated it. This covers the LITERAL and
    nothing else: it proves the introducing-branch repair did not narrow or widen
    `SANCTIONED_NON_PACKAGE`. It is structurally blind to `infra_exempt`, which is where
    that repair's actual widening lives (module docstring, "WHAT ELSE CHANGED") — a
    `src-app/ui/openapi/openapi.json` edit passes both diff tests and this one. A vacuity
    floor that advertised coverage it does not have would be the vacuous-green failure it
    exists to prevent, wearing this file's own costume.
    """
    assert len(SANCTIONED_NON_PACKAGE) == 6
    for p in SANCTIONED_NON_PACKAGE:
        assert p.startswith("src-app/"), p
        assert not p.startswith("src-app/ui/"), (
            f"{p} is under the app UI tree — that can never be sanctioned here")
        assert not p.startswith("src-app/server/src/"), (
            f"{p} is server production source — that can never be sanctioned here")
