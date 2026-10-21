#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [acceptance] [invariant: INV-5] [covers: ITEM-19] — the executable anchor for
"adding an analysis needs ZERO src-app changes".

`git diff origin/main...HEAD --name-only` contains NO path under `src-app/ui/` or
`src-app/server/src/`. The only files under `src-app/` outside the new doublet package are
the TWO sanctioned data files enumerated in `SANCTIONED_NON_PACKAGE` below:
`src-app/packages/pytest.ini` (the `testpaths` append) and
`src-app/packages/_lib/model_coverage_exempt.json` (the model-coverage register, which
upstream added while this branch was out of date — see DEC-25). Neither is code.

This WAS the claim the whole method choice rested on: Scrublet was taken over scDblFinder
precisely BECAUSE it is vendored inside scanpy and needs no new dependency, no Dockerfile edit
and no frontend code, and this file said "if this test goes red, that trade was paid for
nothing and the package should have shipped scDblFinder instead."

#195 SHIPPED scDblFinder, and the sentence above is why this docstring is being rewritten
rather than left to read as a warning about a thing that has now happened deliberately. The
trade is not "paid for nothing": the Scrublet lane is UNCHANGED and still needs none of those
things, and a user without the R env still gets doublet detection. What changed is that a
SECOND method now sits beside it, and the zero-src-app claim has to be restated for the tree
as it is rather than quietly widened.

── WHAT THE CLAIM IS NOW, AND THE ONE PLACE IT IS BROKEN ──────────────────────────────────
The FIRST assertion below is unchanged and unweakened: no `src-app/ui/` file and no
`src-app/server/src/` file moves. Adding a method is still not a product-code change — no
server module, no UI component, no route, no permission, no migration, no datatype, no
Dockerfile edit, no dependency.

The SECOND assertion gains a THIRD sanctioned path, and this file's own rule is that a third
entry "is a design change that has to be argued for, not a diff that slipped in." Here is the
argument.

`src-app/server/tests/sandbox/r_walking_skeleton_test.rs` — a Rust TEST file, not product code
— contained an assertion that at most ONE shipped analysis declares an `rscript` runtime.
#194 wrote it, wrote the instruction for retiring it, and named the condition: "the moment a
second lands". Its message is addressed to whoever lands that second analysis: "Before landing
it: give this file an explicit subject (take the analysis id as a parameter, or assert on the
one you mean), then delete this assertion. Do NOT relax it to `.first()`." #195 is that moment
and did exactly that.

There is no in-package way to satisfy an assertion that lives out of package and is about the
TREE. The alternatives are worse: leaving it fails the build, and `.first()` is forbidden by
name in its own message because it would let six tests silently retarget by registry order.

So the deviation is real, it is confined to a test file, and it is RECORDED rather than
absorbed — the same treatment this package gave its own schedule-class deviation from #111,
which its 0.5.0 changelog entry calls "a deviation from the ISSUE and escalated to the epic
owner, not presented as licensed."
── WHY THIS FILE NOW ROUTES THROUGH `zero_core_guard` (#299/#268/#282) ──────────────
Both assertions below describe THIS BRANCH'S DIFF. Read on the branch that introduced this
package they say exactly the right thing. Read on `main` they re-execute against whatever
branch happens to be running them and assert that stranger's diff is also confined to a
package it has nothing to do with — so they were vacuously true on `main` and red on every
later branch that touched any `src-app/` file outside `doublet/`. Measured on clean
`origin/main`: one appended comment line in `src-app/packages/qc/manifest.yaml` reddened
both. Six consecutive branches paid for that (#227, #269, #266, #292, #243, #291), and a
red that fires on every branch carries no information — which is how a real one gets missed.

The repair is the one `docs/design/derived-guards.md` §3 prescribes and that EIGHT other
modules in this tree already called on `origin/main` (measured, by AST call site — an earlier
draft said "twelve", counting imports and prose), NOT a new one:
`zero_core_guard.require_introducing_branch`
derives WHICH branch this assertion belongs to from the diff itself — add-only, keyed on
this package's own `manifest.yaml` appearing among the ADDED paths — and SKIPS visibly
everywhere else with a stated reason. A skip is a skip, never a pass.

Nothing below is weakened to achieve that. `SANCTIONED_NON_PACKAGE` is unchanged, both
assertions are unchanged, and neither the `src-app/packages/` prefix skip nor an allow-set
entry was added — §5 names all three as explicitly not the repair. The both-ways proof is
`_lib/test_zero_core_guard.py`, which now stages THIS module into a synthetic repository and
drives it from both a foreign branch (must skip, visibly) and this package's own introducing
branch with a core edit (must still fail, loudly). TEST-14 is the control experiment that
motivated the change: from clean main, one comment line in an unrelated package's manifest
must leave `just check-py`'s failure set unmoved.
"""
import sys
from pathlib import Path

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when a suite is run with a narrower rootdir
# than the canonical `cd src-app/packages && python3 -m pytest`.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    package_prefix,
    require_introducing_branch,
)


#: The sanctioned non-package `src-app` paths. EXACT — a third entry is a design change that
#: has to be argued for, not a diff that slipped in.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
    # The MODEL-COVERAGE register, which upstream added while this branch was out of date.
    # It is a committed, COMPLETE list, asserted against the derived (producer x row-bearing
    # datatype) pair set in BOTH directions — so a new producer goes red until somebody
    # states a disposition for it. BOTH `doublet.detect` and `doublet.scdblfinder` produce
    # `metadata-column`, so joining it is mandatory rather than optional. It is pure DATA,
    # under `packages/`, with no code change anywhere: no new server module, no UI file, no
    # Dockerfile edit, no dependency. The SUBSTANCE of INV-5 is intact. See DEC-25.
    "src-app/packages/_lib/model_coverage_exempt.json",
    # `_lib`'s own `version:`, which MUST move when any byte under `_lib/` does —
    # `check-processor-seed-versions.sh` is base-relative over the whole package directory,
    # and an unchanged version there keeps a stale `_lib` for the WHOLE tree. It is the
    # mechanical consequence of the line above, not a second decision.
    "src-app/packages/_lib/manifest.yaml",
    # ── THE THIRD PATH, AND THE ONE THAT IS A REAL DEVIATION (#195) ──────────────────
    # A Rust TEST file. #194's `shipped_rscript_analysis()` asserted that at most one
    # shipped analysis declares an `rscript` runtime, and its failure message instructs the
    # author of the SECOND one to give the file an explicit subject and delete the
    # assertion — by name refusing the `.first()` shortcut. This branch is that second
    # analysis. The full argument is in this module's docstring; it is recorded there and
    # escalated rather than presented as licensed.
    "src-app/server/tests/sandbox/r_walking_skeleton_test.rs",
}


# TEST-55 — enumerated in `.lifecycle/scdblfinder-method/TESTS.md`.
def test_no_src_app_ui_or_server_src_changes():
    _root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue
        assert not p.startswith("src-app/ui/"), f"UI file changed (breaks INV-5): {p}"
        assert not p.startswith("src-app/server/src/"), f"server src changed: {p}"


# TEST-56 — enumerated in `.lifecycle/scdblfinder-method/TESTS.md`.
def test_only_doublet_package_and_the_sanctioned_data_files_changed():
    _root, pkg, changed = require_introducing_branch(__file__)
    # `package_prefix(pkg)` rather than the literal `"src-app/packages/doublet/"` this used
    # to spell: the subject is DERIVED from this module's own location, so the guard cannot
    # be scoped to a package other than the one it lives in (`derived-guards.md` INV-1).
    mine = package_prefix(pkg)
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the src-app scope this test guards
        if p.startswith(mine):
            continue
        assert p in SANCTIONED_NON_PACKAGE, (
            f"unexpected non-package src-app change (INV-5 / zero-src-app-edit): {p}")
