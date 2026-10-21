#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 [acceptance] [invariant: INV-DA-5] [covers: ITEM-15]

Adding a differential-abundance analysis is DATA, not app code — and this test is what keeps that
claim true rather than aspirational.

## The one deviation, named rather than absorbed

The epic's invariant reads "`src-app` diff outside the package: one line in
`src-app/packages/pytest.ini`. Nothing else." The shipped diff is that line PLUS five appended
lines in `src-app/server/src/modules/datatype/tests/lattice_golden.json`.

That second file is a Rust↔TS golden PARITY FIXTURE whose test asserts
`DatatypeRegistry::build_from_embedded().len()` equals its own `lattice` array's length. Any new
contributed datatype moves that count; with `da/result` in place the committed 26-entry golden
fails `left: 27, right: 26`. It was confirmed by RUNNING the test, not by reading it. Since the
epic REQUIRES the new `da/result` kind (#84), there is no version of this feature that leaves that
fixture untouched — it is a mechanical regen, it adds no behaviour, and it is the same edit
`differential-expression`'s own DEC-9 allow-set already sanctions (that package's `SANCTIONED` set
names this very file). It is recorded in `DECISIONS.md` as DEC-3 and reported to the owner.

The SUBSTANCE of the invariant is what this test pins, and it is intact: no new server module, no
new chart kind, no rootfs edit, no `open-kinds` edit, no permission, no migration, no render
source. The allow-set below is EXACT, so the deviation cannot quietly grow.
── WHY THIS FILE NOW ROUTES THROUGH `zero_core_guard` (#238/#268/#282/#299) ─────────
Every assertion in this module describes THIS BRANCH'S DIFF (or, for the working-tree leg,
this branch's uncommitted state). Read on the branch that introduced this package they say
exactly the right thing. Read on `main` they re-execute against whatever branch happens to
be running them, so they were vacuously true on `main` and RED on every later branch that
touched any `src-app/` file outside `differential-abundance/` — including branches whose
entire diff sat inside a third, unrelated package. Reproduced on clean `origin/main` with a
single appended comment line in `src-app/packages/qc/manifest.yaml`.

The repair is the one `docs/design/derived-guards.md` §3 prescribes and that EIGHT other
modules in this tree already called on `origin/main` (measured, by AST call site — an earlier
draft said "twelve", counting imports and prose):
`zero_core_guard.require_introducing_branch` derives WHICH branch
the assertion belongs to from the diff itself — add-only, keyed on this package's own
`manifest.yaml` appearing among the ADDED paths — and SKIPS visibly everywhere else with a
stated reason. A skip is a skip, never a pass.

Nothing is weakened to achieve it. `SANCTIONED` and `FORBIDDEN_PREFIXES` are unchanged, no
`src-app/packages/` prefix skip was added, and no assertion was deleted — §5 names all three
as explicitly not the repair. One assertion is STRENGTHENED in reach rather than reduced:
`test_da_result_joins_the_lattice_with_NO_core_edit_at_all` mixed a branch-diff leg with two
legs that are true of the TREE regardless of branch, so those two are lifted into
`test_the_frozen_lattice_array_did_not_come_back_and_da_result_is_still_declared` (TEST-10),
which runs UNGATED on every branch — they used to be reachable only on this package's own
introducing branch's run, and now they are not.
"""
import subprocess
import sys
from pathlib import Path

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when it is run with a narrower rootdir than
# the canonical `cd src-app/packages && python3 -m pytest` — which is exactly what
# `_lib/test_zero_core_guard.py` does when it stages this guard into a synthetic checkout.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    package_of,
    package_prefix,
    require_introducing_branch,
)

#: DERIVED from this module's own location rather than typed in, so the guard cannot be
#: scoped to a package other than the one it lives in (`derived-guards.md` INV-1).
_PKG_PREFIX = package_prefix(package_of(__file__))

#: The ONLY sanctioned non-package `src-app` paths. EXACT — a third entry is a design change that
#: has to be argued for, not a diff that slipped in.
SANCTIONED = {
    "src-app/packages/pytest.ini",
    # The MODEL-COVERAGE register, which upstream added while this branch was out of date. It is
    # a committed, COMPLETE list: a new producer with a row-bearing output, or a datatype resting
    # on an axis no dataset anchors, goes red until somebody states a disposition for it. This
    # package is both, so joining it is mandatory rather than optional — and it is pure data,
    # under `packages/`, with no code change anywhere. Note what LEFT this set: the branch used
    # to sanction an edit to `datatype/tests/lattice_golden.json`, and no longer touches it at
    # all (see `test_da_result_joins_the_lattice_with_NO_core_edit_at_all`).
    "src-app/packages/_lib/model_coverage_exempt.json",
}

#: Surfaces the epic names explicitly as must-not-change.
FORBIDDEN_PREFIXES = (
    "src-app/libs/viz/",            # the chart-kind list is CLOSED; we reuse `volcano` (#124)
    "src-app/env-rootfs/",          # no new dependency (#83)
    "src-app/packages/open-kinds/", # `da/result` is declared in THIS package (#84)
    "src-app/ui/src/",              # the feature adds no render source at all
    "src-app/desktop/",
)


# `_repo_root` / `_merge_base` / `_changed` used to live here, re-deriving the repo root,
# the base ref and the merge base by hand. That plumbing is now
# `zero_core_guard.repo_root` / `base_ref` / `diff_point` / `changed_paths`, which is the
# same code with the same merge-base semantics this module's own docstring argued for (the
# moving `origin/main` tip made these guards "fail over commits the branch has nothing to
# do with" after main moved 58 commits) — plus the two strengthenings that copy never had:
# a broken diff ASSERTS instead of returning an empty list, and an unresolvable base ref
# raises instead of skipping.


def test_the_only_non_package_src_app_changes_are_the_sanctioned_two():
    _root, _pkg, changed = require_introducing_branch(__file__)
    unexpected = []
    for p in changed:
        if not p.startswith("src-app/"):
            continue                       # docs + .lifecycle are outside the guard's scope
        if p.startswith(_PKG_PREFIX):
            continue
        if p not in SANCTIONED:
            unexpected.append(p)
    assert unexpected == [], (
        f"unexpected non-package src-app changes: {unexpected}. Adding an analysis is supposed to "
        f"be pure data; the sanctioned set is exactly {sorted(SANCTIONED)} (see DEC-3).")


def test_the_WORKING_TREE_carries_no_unsanctioned_non_package_src_app_change():
    """The committed-diff check above is the guard; this is the half that stops a change becoming
    committed in the first place.

    `_changed` reads `git diff <merge-base>...HEAD`, so it sees COMMITTED state only. That is the
    right scope for the invariant — but it means an untracked or unstaged file under `src-app/` is
    invisible until someone runs `git add -A`, at which point it is already in the history. This
    checks the same allow-list one step earlier.

    ── WHAT IT DOES *NOT* COVER, stated because the first version of this docstring got it wrong ──
    It would NOT have caught this feature's own `git add -A` incident. That was a review agent's
    mutation of two files INSIDE `src-app/packages/differential-abundance/`, which this guard and
    its committed-diff sibling both allow by design — the package is where this feature's changes
    belong. What caught that was a behavioural guard on the value being mutated
    (`test_neither_entry_refills_a_masked_p_family_value`), which is the only kind of check that
    could. This guard covers a different and narrower thing: a NON-package `src-app` file sitting
    in the working tree before anyone commits it.

    It is also deliberately UNSCOPED to this branch's own edits: any in-flight change anywhere
    under `src-app/` outside this package reddens it. In a worktree where someone is editing a
    sibling package that is a false positive, and the trade is accepted — the canonical runner is
    a single-branch processor gate, and a guard that ignored "someone else's" edit could not tell
    that from this branch's own.

    ── AND THAT IS WHY IT IS GATED (#299, and the objection answered) ───────────────────
    A blind audit argued this one should NOT be gated: it reads `git status`, i.e. the working
    tree, not a commit range, and `docs/design/derived-guards.md` §3 is written about branch
    DIFFS — so gating a test whose marker already exists on `origin/main` deletes it rather
    than scoping it. The objection is right about the MECHANISM and wrong about the SUBJECT,
    and the subject is what §3 turns on: *"Some properties are properties of a CHANGE, not of
    the code."* "No unsanctioned non-package `src-app` file exists in the working tree" is a
    property of the authoring session that introduced this package. Read on `main` it asks
    every later developer's tree to be confined to a package they are not working on, and it
    was MEASURED doing exactly that — it reddened on the branch that wrote this paragraph, for
    an uncommitted edit to `_lib`, mid-edit. The paragraph above accepted that cost when there
    was no mechanism to scope it; there is one now.

    Gating it would leave the body unreachable, which is the defect one layer up (#274/#286),
    so it does not go unproven: `_lib/test_zero_core_guard.py::
    test_the_working_tree_guard_still_REFUSES_an_unsanctioned_path` drives it with the porcelain
    it must refuse.
    """
    root, _pkg, _changed = require_introducing_branch(__file__)
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all", "--", "src-app/"],
                         cwd=root, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    offending = []
    for line in out.stdout.splitlines():
        path = line[3:].strip()
        # A rename reports `old -> new`, and BOTH sides count — keeping only the destination
        # reports a `git mv` of an unsanctioned server file INTO this package as clean, and the
        # committed-diff sibling cannot back it up (`git diff --name-only` also reports only the
        # destination for a rename).
        # Quotes are stripped PER CANDIDATE, after the split. Stripping them from the whole line
        # first leaves the inner quotes of a git-quoted rename (`"old" -> "new"`) embedded, so the
        # destination candidate keeps a leading `"`, fails `startswith("src-app/")`, and is
        # silently dropped — the exact half this both-sides handling was added to stop dropping.
        # `core.quotePath` is on by default, so any non-ASCII or special character takes it.
        raw = path.split(" -> ") if " -> " in path else [path]
        candidates = [c.strip().strip('"') for c in raw]
        for candidate in candidates:
            if not candidate.startswith("src-app/"):
                continue
            if candidate.startswith(_PKG_PREFIX) or candidate in SANCTIONED:
                continue
            offending.append(candidate)
    assert offending == [], (
        f"the WORKING TREE carries unsanctioned non-package src-app change(s): {offending}. "
        "They are not in the history yet — which is the point of catching them here, before a "
        "`git add -A` puts them there.")


def test_the_forbidden_surfaces_are_untouched():
    _root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        for prefix in FORBIDDEN_PREFIXES:
            assert not p.startswith(prefix), (
                f"{p} is under {prefix!r}, which this feature must not touch")


def test_the_package_adds_no_render_source():
    _root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if p.startswith(_PKG_PREFIX):
            assert not p.endswith((".tsx", ".jsx", ".ts")), (
                f"the package added a render/TS source: {p}. Every surface it adds is a "
                "declarative view spec interpreted by the shipped renderer.")


def test_da_result_joins_the_lattice_with_NO_core_edit_at_all():
    """The stronger property that REPLACED the one this test used to assert.

    History, because deleting the old assertion without it would read as a guard weakened to go
    green. This package used to APPEND `da/result` to a frozen `lattice` array in
    `datatype/tests/lattice_golden.json`, and this test pinned that edit to exactly one entry.
    Upstream has since DELETED that array — the lattice is now derived from every package's
    declared `contributes.datatypes[].id`, and the golden's own `_comment` says the array "MUST
    NOT COME BACK". So the edit this test policed is not merely unnecessary now, it is
    forbidden, and the branch's whole DEC-3 justification for touching a file under
    `src-app/server/src/` has evaporated with it.

    What replaces it is strictly STRONGER, and is what INV-3 wanted in the first place:
    `da/result` must reach the registry with zero edits outside this package.

    Only the DIFF leg lives here now. The two tree-scoped legs moved to
    `test_da_result_datatype.py::test_the_frozen_lattice_array_did_not_come_back_and_da_result_is_still_declared`,
    which is ungated and therefore runs on every branch rather than on this package's own —
    and lives beside the rest of `da/result`'s declaration tests, which is where an assertion
    about that datatype's declaration belongs.
    """
    _root, _pkg, changed = require_introducing_branch(__file__)
    core = sorted(p for p in changed if p.startswith("src-app/server/src/"))
    assert core == [], (
        f"this branch edits {len(core)} file(s) under `src-app/server/src/`: {core}. Registering "
        "a datatype now costs zero core edits, so any such change is a design decision to be "
        "argued for rather than a diff that slipped in.")

