#!/usr/bin/env python3
# ruff: noqa
"""#163 — a new KIND costs zero core. TEST-3 [acceptance] [invariant: INV-3], TEST-9.

Design §2.1's heading, verbatim: *"A new **kind** costs zero core Rust — this is proven,
not hoped"*.

## Why this is a SIBLING file and not an edit to `test_zero_src_app_diff.py`

That guard arms only on the branch that ADDS `spatial-import-xenium/manifest.yaml`
(`zero_core_guard.introduces_package` is deliberately add-only, so a version bump cannot
re-arm it). This branch does not add that manifest, so on this branch that guard SKIPS in
full — including its `test_the_env_rootfs_content_lock_did_not_move` leg. Editing #162's
file to make it arm here would break its own premise ("this diff is the one that created
this package") for every future branch; the honest move is a guard with its OWN premise.

The premise here is the same idea one level down: this branch is the one that ADDS
`compute/boundaries.py` — the file whose existence IS the new producer. Everywhere else it
SKIPS visibly, with a reason, never silently passing.

## What #163 changes outside its own package, and why each is not a violation

Named ONE BY ONE, never by prefix — `derived-guards.md` §5: a prefix exemption grants every
future file under it the same pass, so the guard stops describing the change it was
written for.
"""
import sys
from pathlib import Path

_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    GENERATED_CLIENT_ARTIFACTS,
    package_of,
    package_prefix,
    require_introducing_file,
)

#: The marker that arms this guard: the producer module #163 introduces.
INTRODUCED = "src-app/packages/spatial-import-xenium/compute/boundaries.py"

#: A TREE root walked from this file — deliberately NOT `zero_core_guard.repo_root()`, which
#: skips outside a git checkout (right for a branch-diff guard, wrong for a tree assertion).
_REPO_ROOT = Path(__file__).resolve().parents[4]

#: The sanctioned non-package `src-app/` paths for THIS item.
#:
#: * `env-rootfs/single-cell/requirements.txt` — the `pyarrow` pin. The reader cannot exist
#:   without it, and the #80 gate resolves this analysis's declared `run.dependencies[]`
#:   against this file at BUILD time, so an undeclared library fails `cargo check` instead
#:   of a user's job. It is a RECIPE, not core code.
#: * `env-rootfs/single-cell/Dockerfile` — one token on the `# cyto:env-smoke` line, which
#:   `env_image::tests::every_env_recipe_smoke_verifies_every_pinned_import` requires of
#:   every pin: an install the smoke line does not verify silently ships absent.
#: * `env-rootfs/env-pins.generated.json` — MECHANICALLY DERIVED from the pin file by
#:   `just env-pins-regen` (the build gate's own single parse, #214). Not an independent
#:   edit; `env_pins.load()` refuses an artefact whose recorded digest does not match the
#:   pin file's bytes, so it cannot be stale and cannot be forgotten.
#: * `packages/differential-expression/tests/test_rootfs_deps_r.py` — the `(count, sha256)`
#:   content lock over the recipe. It goes RED the moment the recipe moves, which is the
#:   guard working; re-recording it in the same commit with the reason is the remedy that
#:   assertion's own message prescribes. Its load-bearingness is re-proven by mutation in
#:   `.lifecycle/spatial-geometry/MUTATIONS.md`, not assumed.
#: * `packages/differential-expression/manifest.yaml` — the version bump
#:   `scripts/check-processor-seed-versions.sh` requires of any seed package whose files
#:   move. Mechanically implied by the line above.
#: * `packages/_lib/model_coverage_exempt.json` — the producer-register row, plus the LATTICE
#:   entry whose own text said "Remove this entry when the importer lands, and decide it
#:   then". It is DATA the model-coverage guard reads, not code, and it lives under
#:   `packages/` on purpose. The guard fails in BOTH directions
#:   (`every_producer_output_with_a_row_space_is_registered`), so a producer that emits rows
#:   with nobody deciding what it declares goes red — verified by RUNNING it, which named
#:   exactly `spatial.import-xenium x spatial/boundaries`.
#: * `packages/_lib/manifest.yaml` — the version bump the seed-reconciliation guard requires
#:   the moment any file in that package moves. Mechanically implied by the line above.
SANCTIONED_NON_PACKAGE = {
    "src-app/env-rootfs/single-cell/requirements.txt",
    "src-app/env-rootfs/single-cell/Dockerfile",
    "src-app/env-rootfs/env-pins.generated.json",
    "src-app/packages/differential-expression/tests/test_rootfs_deps_r.py",
    "src-app/packages/differential-expression/manifest.yaml",
    "src-app/packages/_lib/model_coverage_exempt.json",
    "src-app/packages/_lib/manifest.yaml",
}


def _armed():
    """This guard's premise, delegated to the shared helper.

    The body used to be open-coded here: `repo_root()`, `INTRODUCED not in added_paths(root)`,
    `pytest.skip(...)`, `changed_paths(root)`. That is exactly how the git plumbing
    `zero_core_guard` replaced got triplicated across three suites and diverged, so it is
    folded into `require_introducing_file` before there is a third copy — `#163`'s sibling
    guard in `test_boundaries_long_table.py` is that would-be third copy and now shares this
    one. Behaviour and skip reason are unchanged.
    """
    return require_introducing_file(INTRODUCED, __file__)


def test_the_arming_marker_names_a_real_file():
    """UNGATED. A marker that names nothing is a guard switched off, not a branch skipped.

    `require_introducing_file` takes its marker as a free string — the one thing it does not
    derive — so a typo, a rename or a deliberate edit here disarms every assertion in this
    module permanently, and the skips look exactly the same. A blind audit proved it: both
    shipped markers repointed at a nonexistent path left eight assertions across three
    modules unarmable and the whole suite green.

    The invariant is sound by construction: the marker is a path the introducing branch ADDS,
    so on every later branch it is a file that EXISTS. Asserting nothing about any branch,
    this runs everywhere.
    """
    assert (_REPO_ROOT / INTRODUCED).is_file(), (
        f"the arming marker `{INTRODUCED}` names no file in this tree, so every guard in "
        f"this module can never run again on any branch — and would go on reporting a skip "
        f"that says its premise merely does not hold."
    )


def test_no_rust_no_typescript_no_ui_workspace_changed():
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-13].

    The strongest form of §2.1's claim, and the one #162 could also make: this branch
    changes NO Rust, NO TypeScript and NO file under `src-app/ui/` or `src-app/desktop/`
    AT ALL. Asserted at the diff rather than described in a report.
    """
    _root, changed = _armed()
    offending = [p for p in changed
                 if p.endswith((".rs", ".ts", ".tsx"))
                 or p.startswith(("src-app/ui/", "src-app/desktop/", "src-app/server/"))]
    assert offending == [], (
        f"core/frontend files changed: {offending}. §2.1's claim is that a new KIND costs "
        "zero core Rust; a branch that had to edit core would be reporting a different "
        "result than the one this epic rests on."
    )


def test_every_non_package_change_is_a_named_exemption():
    """No prefix rules — every path outside this package is named with its reason."""
    _root, changed = _armed()
    mine = package_prefix(package_of(__file__))
    unexpected = [
        p for p in changed
        if p.startswith("src-app/")
        and not p.startswith(mine)
        and p not in SANCTIONED_NON_PACKAGE
        and p not in GENERATED_CLIENT_ARTIFACTS
    ]
    assert unexpected == [], (
        f"unexpected non-package `src-app/` change(s): {unexpected}. Name each one here "
        "with the reason it is not a violation, or do not make it."
    )


def test_every_named_exemption_is_actually_touched():
    """An exemption nothing uses is a standing permission the next branch inherits."""
    root, changed = _armed()
    changed_set = set(changed)
    stale = sorted(p for p in SANCTIONED_NON_PACKAGE
                   if p not in changed_set and (root / p).exists())
    assert stale == [], (
        f"exemption(s) granted for path(s) this branch does not touch: {stale}"
    )


def test_no_openapi_or_generated_client_changed():
    """TEST-9 [covers: ITEM-13] — no route, no DTO, so the regen must be EMPTY."""
    _root, changed = _armed()
    generated = [p for p in changed
                 if p.endswith("openapi.json") or p.endswith("api-client/types.ts")
                 or p in GENERATED_CLIENT_ARTIFACTS]
    assert generated == [], f"generated client surface changed: {generated}"


def test_no_ui_workspace_path_appears_at_all():
    """TEST-9 — the machine-checkable form of "no e2e tier is owed".

    The phase-3 frontend gate computes touched areas from the diff. Asserting the same
    thing here means the plan's claim and the gate's computation cannot silently diverge.
    """
    _root, changed = _armed()
    ui = [p for p in changed
          if p.startswith("src-app/ui/") or p.startswith("src-app/desktop/ui/")]
    assert ui == [], (
        f"a UI workspace path changed: {ui}. This item declares no user-facing surface and "
        "enumerates no e2e test; a UI diff would make both statements false."
    )


def test_the_content_lock_moved_AND_was_re_recorded_in_this_same_commit():
    """The one exemption that is only legitimate WITH its remedy applied.

    #162's own guard asserts `env-rootfs/` is untouched, and its message prescribes exactly
    this when it is: "re-record the digest in the SAME commit, with the reason". This
    asserts the remedy actually happened rather than the exemption merely being claimed.
    """
    root, changed = _armed()
    assert "src-app/env-rootfs/single-cell/requirements.txt" in changed
    lock_file = root / "src-app/packages/differential-expression/tests/test_rootfs_deps_r.py"
    assert "src-app/packages/differential-expression/tests/test_rootfs_deps_r.py" in changed, (
        "the recipe moved and the content lock did not — the lock is red on this branch and "
        "the branch is claiming to be clean"
    )
    body = lock_file.read_text()
    assert "#163" in body, (
        "the re-recorded lock carries no reason naming this item. A digest that moves with "
        "no recorded reason is a value a reviewer cannot check."
    )
