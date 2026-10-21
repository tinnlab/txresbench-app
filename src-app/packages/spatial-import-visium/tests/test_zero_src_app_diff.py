#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 — the zero-core anchor, as a DIFF.

The design's claim is that a new ANALYSIS costs zero `src-app` changes. This branch is
honest about the one place that claim is qualified: it ALSO lands #183's owner-ruled
Option A, which is a client-side defect fix, not part of adding an analysis. So the
assertion is not "no `src-app/ui/` file changed"; it is "the ONLY `src-app/` paths outside
this package are the ones NAMED below, one by one".

Named rather than prefixed on purpose. `docs/design/derived-guards.md` §5: a prefix
exemption grants every future file under it the same pass, so the guard stops describing
the change it was written for. If a later branch needs another `src-app/ui/` file, it has
to come and add it here, which is the review this exemption is standing in for.

`zero_core_guard.require_introducing_branch` derives WHICH branch this assertion belongs
to from the diff itself — add-only, keyed on this package's own `manifest.yaml` appearing
among the ADDED paths — and SKIPS visibly everywhere else with a stated reason, rather
than being vacuously true on `main` and false on every later branch.
"""
import sys
from pathlib import Path

_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    infra_exempt,
    package_prefix,
    require_introducing_branch,
)

#: The sanctioned non-package `src-app/` paths for THIS package's introducing branch.
#: Package-specific and deliberately NOT shared with the sibling copies — a union across
#: packages would grant every package every other package's exemptions.
#:
#: * `packages/pytest.ini` — the `testpaths` append. That file's own header requires a new
#:   `<package>/tests/` directory to be enumerated in the SAME commit that creates it; a
#:   suite absent from it is collected by nothing and no test COUNT can detect that.
#: * `packages/_lib/model_coverage_exempt.json` — the three producer-register rows. This
#:   package is the FIRST producer of `spatial/coordinates`, and the model-coverage guard
#:   asserts its register against the derived pair set in BOTH directions, so a new
#:   row-bearing output goes red until somebody states what it declares about its rows.
#:   The file is DATA the guard reads and it lives under `packages/` on purpose (every
#:   entry necessarily names a datatype and an axis, while `server/tests/**` is
#:   domain-scanned), so contributing a disposition is a data edit, not a core one.
#: * `packages/_lib/manifest.yaml` — the version bump the seed-reconciliation guard
#:   requires the moment any file in that package moves. Mechanically implied by the line
#:   above.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
    "src-app/packages/_lib/model_coverage_exempt.json",
    "src-app/packages/_lib/manifest.yaml",
}

#: The #183 **Option A** completion — the owner-ruled client half of this branch, and the
#: reason this guard does NOT assert a blanket "nothing under `src-app/ui/`".
#:
#: The ruling: a filter virtual dataset's gather is strictly 1-D, so a 2-D coordinates
#: artifact loses its second dimension and points at a member that does not exist. The
#: importer therefore also emits `spatial_x`/`spatial_y` as ordinary 1-D columns — but
#: emitting them is only half of it, because the shipped Coordinates section narrows on
#: `dims: 2` by exact equality and NOTHING in production ever set the two-column
#: `CatalogEntry.components` the viz adapter already reads. Without the files below the
#: import looks finished and the filtered view is blank.
#:
#: The alternative — teaching the gather itself about components — is core Rust, is issue
#: #203, and is explicitly not this branch's. **This branch changes no Rust outside
#: `server/tests/`.**
OPTION_A_UI = {
    # the SELECTION half: a producer's declared component columns answer the `dims: 2`
    # narrowing when the gather has re-minted the structure without a second dimension.
    "src-app/ui/src/modules/workbench/core/runtime/axisSource.ts",
    "src-app/ui/src/modules/workbench/core/runtime/axisSource.test.ts",
    # the RENDER half: the layout entry names its two component columns, which is the one
    # un-built row of D20's own change table.
    "src-app/ui/src/modules/workbench/extensions/data/workbenchDataSource.ts",
    "src-app/ui/src/modules/workbench/extensions/data/workbenchDataSource.test.ts",
    # …and the mapper that has to CARRY the declaration to it. Named separately because it
    # is where the render half was inert: `buildProjectDataSource`'s catalog mapper emitted
    # `{id, datatype, structure}` and dropped `meta`, so the declaration never reached
    # `catalog()` on the real wire — the same drop that had already made the shipped
    # `columnLabel` override unreachable. A unit test of `catalog()` cannot see a mapper
    # that drops a field, which is exactly how that went unnoticed.
    "src-app/ui/src/modules/workbench/extensions/data/projectSources.ts",
    "src-app/ui/src/modules/workbench/extensions/data/projectSources.test.ts",
    # …and the wire->row mapper one layer under it. `ArtifactRow` is core's row type and it
    # carried no `dataset_id`, so the scope the component join runs in could not be read on
    # the OVERVIEW catalog — the only read the canvas performs. Both wire row types already
    # declare the field; nothing here derives or widens anything, it stops being dropped.
    "src-app/ui/src/modules/workbench/extensions/data/dataHost.ts",
    # the doc-comment that claimed core reads exactly THREE things out of `meta`, amended
    # in the same change rather than left false.
    "src-app/ui/src/modules/workbench/core/artifacts/catalog.ts",
    # the browser proof that the two halves are on the runtime path.
    "src-app/ui/tests/e2e/15-visualize/masked-layout-components.spec.ts",
}

#: The ONLY paths under `src-app/server/` this branch touches, and both are TESTS.
#: `filter_vd_test.rs` had no 2-D fixture at all — nothing anywhere had ever put a 2-D
#: artifact through a filter VD, which is why the defect above went unnoticed. The
#: coverage added there documents #203's defect executably; it does not fix it.
SERVER_TESTS_PREFIX = "src-app/server/tests/"


def _unexplained(changed, root):
    out = []
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the scope this guard covers
        if p.startswith(package_prefix("spatial-import-visium")) or infra_exempt(p, root):
            continue
        if p in SANCTIONED_NON_PACKAGE or p in OPTION_A_UI:
            continue
        if p.startswith(SERVER_TESTS_PREFIX):
            continue
        out.append(p)
    return out


def test_only_this_package_and_the_named_exemptions_changed():
    root, _pkg, changed = require_introducing_branch(__file__)
    assert _unexplained(changed, root) == [], (
        f"unexpected non-package src-app change: {_unexplained(changed, root)}. Every path "
        "outside this package must be NAMED in this module — add it with its reason, or "
        "move the change into the package."
    )


def test_no_production_rust_changed():
    """The ruling's own words: "Zero core Rust."

    Stated as its own assertion rather than folded into the one above, because it is the
    half that would be quietest to lose: a single line in `virtual_dataset.rs` would make
    the filtered tissue map work and would also be #203, landed without its own review.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    rust = [p for p in changed if p.endswith(".rs")]
    for p in rust:
        assert p.startswith(SERVER_TESTS_PREFIX), (
            f"server src changed: {p}. Teaching the gather about 2-D members is Option B "
            "(#203); this branch is Option A and changes no Rust outside tests."
        )


def test_every_named_ui_exemption_is_actually_touched():
    """A named exemption that nothing uses is a standing permission nobody reviewed.

    The list above is a set of PERMISSIONS, and permissions rot in one direction: a file
    that stops being touched leaves its exemption behind for the next branch to inherit
    silently. So the list is asserted in BOTH directions — every entry must be a path this
    branch really changed.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    changed_set = set(changed)
    # Only a path that EXISTS and is untouched is stale. A path that is not in the tree at
    # all is not an unreviewed permission — it is a tree that does not contain the file,
    # which is what `_lib/test_zero_core_guard.py`'s synthetic harness stages (it copies
    # this guard module and nothing else). Complaining there would make this guard fail
    # inside the meta-test for a reason that has nothing to do with what it guards.
    stale = sorted(p for p in (OPTION_A_UI | SANCTIONED_NON_PACKAGE)
                   if p not in changed_set and (root / p).exists())
    assert stale == [], (
        f"exemption(s) granted for path(s) this branch does not touch: {stale}. Remove "
        "them; an unused exemption is a permission the next branch inherits unreviewed."
    )


def test_no_other_frontend_area_changed():
    """The blanket the sibling guards assert, kept for everything outside the named set.

    In particular: no declarative view spec, no `viewSpec.ts`, no `ArtifactTypeFilter`.
    The settlement deliberately adds NO vocabulary to the `source:` selector, so
    `single-cell-viz/ui/coordinates.yaml` and the two key-set assertions that hold it shut
    (`extensions/visualize/coordinates.test.ts`) are untouched and stay green.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/ui/") or infra_exempt(p, root):
            continue
        assert p in OPTION_A_UI, f"unexpected frontend file changed: {p}"
    for forbidden in (
        "src-app/packages/single-cell-viz/ui/coordinates.yaml",
        "src-app/ui/src/modules/workbench/core/manifest/viewSpec.ts",
        "src-app/ui/src/modules/workbench/extensions/visualize/coordinates.test.ts",
    ):
        assert forbidden not in changed, (
            f"{forbidden} changed — the settlement is supposed to leave the declarative "
            "selector's vocabulary alone"
        )
