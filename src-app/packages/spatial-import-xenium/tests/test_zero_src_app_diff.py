#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [acceptance] [invariant: INV-8] — the zero-`src-app`-change anchor, as a DIFF.

Design §10's claim, verbatim: *"For the Visium foundation: zero `src-app` changes."* The
whole bet of epic #151 is that an importer is PURE DATA — that adding one costs no
production code — and #157 proved the analysis chain runs on a spatially-imported matrix
with zero `src-app` production change. A SECOND importer is the first real test of that
claim, because the first one could have been made to fit by accident.

**This branch's answer, stated up front so the exemptions below are read against it: it
changes NO Rust, NO TypeScript, and NO file under `src-app/ui/` or `src-app/desktop/` AT
ALL.** The Visium branch could not say that — it also landed #183's Option A client fix and
therefore had to name eight frontend files. This one names none, which is the stronger
result and is asserted rather than described.

What it DOES change outside its own package is five paths, each a hand-maintained
ENUMERATION the platform has no way to derive, and each guarded by something that fails
loudly when it is not updated. Named one by one rather than by prefix: `derived-guards.md`
§5 — a prefix exemption grants every future file under it the same pass, so the guard stops
describing the change it was written for.

`zero_core_guard.require_introducing_branch` derives WHICH branch this belongs to from the
diff itself and SKIPS visibly elsewhere with a stated reason, rather than being vacuously
true on `main`.
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
#: * `packages/pytest.ini` — the `testpaths` append. That file's header requires a new
#:   `<package>/tests/` directory to be enumerated in the SAME commit that creates it, and
#:   `just check-py` hard-fails on a suite collected by nothing. Nothing derives it.
#: * `packages/_lib/model_coverage_exempt.json` — the three producer-register rows. The
#:   model-coverage guard asserts its register against the derived (producer x row-bearing
#:   datatype) pair set in BOTH directions, so a new producer goes red until somebody states
#:   what its outputs declare about their rows. The file is DATA the guard reads, and it
#:   lives under `packages/` on purpose (every entry names a datatype and an axis, while
#:   `server/tests/**` is domain-scanned), so contributing a disposition is a data edit.
#: * `packages/_lib/manifest.yaml` — the version bump the seed-reconciliation guard requires
#:   the moment any file in that package moves. Mechanically implied by the line above.
#: * `packages/_helpers/tests/test_visium_chain_zero_src_app.py` — ONE TOKEN, into the
#:   `spatial_arm` set. That guard's always-armed half asserts no shipped analysis narrows
#:   on a `spatial/*` datatype, and this importer legitimately does (it binds
#:   `spatial/xenium-bundle`). The set is the guard's way of distinguishing the spatial arm
#:   from a general-purpose analysis that has quietly grown a spatial dependency; adding a
#:   member is the review it exists to force.
#: * `packages/_helpers/manifest.yaml` — the version bump implied by the line above.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
    "src-app/packages/_lib/model_coverage_exempt.json",
    "src-app/packages/_lib/manifest.yaml",
    "src-app/packages/_helpers/tests/test_visium_chain_zero_src_app.py",
    "src-app/packages/_helpers/manifest.yaml",
}

#: The two SIBLING SPATIAL PACKAGES this branch also moves, and why each is not a violation
#: of INV-8. Both are `packages/` data contributions, not `src-app` production code — but
#: they belong to OTHER features, so they are named separately from this package's own
#: prefix rather than folded into it.
#:
#: * `spatial-types` gains the `spatial/xenium-bundle` upload container (a datatype
#:   declaration, exactly where `spatial/visium-bundle` lives) and `compute/ome_writer.py`,
#:   which is PROMOTED here from `spatial-import-visium` to become the single source of
#:   truth both importers vendor. It is the executable other half of the placement contract
#:   `spatial_declarations.py` already defines, and it now has two consumers.
#: * `spatial-import-visium` changes in exactly two ways: its `compute/ome_writer.py`
#:   becomes the byte-identical vendored copy of the promoted file, and its `version:`
#:   bumps because that file moved. Its own compute, manifest surface and tests are
#:   untouched. The ONE behavioural change is `_reconcile_scale` resolving the space's
#:   scale through `SD.require_micron_scale`, which is identical for every pixel space and
#:   is the only way a micrometre space can carry display-derivative provenance at all.
SIBLING_SPATIAL_PACKAGES = {
    "src-app/packages/spatial-types/manifest.yaml",
    "src-app/packages/spatial-types/compute/ome_writer.py",
    # The sibling's own suite carries a HARD-CODED set of the ids that package contributes,
    # so a sixth datatype is a one-line edit there by construction. Found by RUNNING that
    # suite, not by reading the diff — see `test_the_sibling_suites_this_branch_moves_still_pass`.
    "src-app/packages/spatial-types/tests/test_spatial_types_manifest.py",
    "src-app/packages/spatial-import-visium/manifest.yaml",
    "src-app/packages/spatial-import-visium/compute/ome_writer.py",
}

#: The ONE path under `src-app/server/` this branch touches, and it is a FROZEN GOLDEN —
#: data a Rust test reads, not production code.
#:
#: `lattice_golden.json` records which `is_a` relations the datatype lattice must answer.
#: `spatial/visium-bundle` got its row from #152 and this branch added the matching one.
#:
#: **IT IS NOT REQUIRED, and saying so matters more than the row does.** An earlier version
#: of this comment claimed a datatype without a row "leaves the golden describing a tree
#: that no longer exists". A blind extensibility audit checked and that is false: the four
#: case tables are FLOORS (`datatype/tests/mod.rs` asserts `MIN_IS_A = 33` against 58 rows)
#: and the derivation half re-derives the registry from the manifests, so a contributed
#: datatype with no row is green. This branch's own diff proves it — it added an `is_a` row
#: and NO `layout_kind` row, and the gate passed either way.
#:
#: The row is kept because a frozen case table is more useful with the new type in it than
#: without. But the claim is corrected here rather than left standing, because the old
#: wording would teach the NEXT vendor to make an edit under `src-app/server/` that it does
#: not need — and "a third importer costs zero edits outside `packages/`" is a materially
#: better property than the one this file was asserting.
SERVER_GOLDEN = {
    "src-app/server/src/modules/datatype/tests/lattice_golden.json",
}


def _unexplained(changed, root):
    out = []
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the scope this guard covers
        if p.startswith(package_prefix("spatial-import-xenium")) or infra_exempt(p, root):
            continue
        if p in SANCTIONED_NON_PACKAGE or p in SIBLING_SPATIAL_PACKAGES:
            continue
        if p in SERVER_GOLDEN:
            continue
        out.append(p)
    return out


def test_only_this_package_and_the_named_exemptions_changed():
    root, _pkg, changed = require_introducing_branch(__file__)
    unexplained = _unexplained(changed, root)
    assert unexplained == [], (
        f"unexpected non-package src-app change: {unexplained}. Every path outside this "
        "package must be NAMED in this module — add it with its reason, or move the change "
        "into the package."
    )


def test_no_rust_changed_at_all():
    """INV-8's hardest half, and the one a second importer is the real test of.

    The Visium branch could allow `src-app/server/tests/**`; this one allows nothing. If
    adding a second vendor required a single line of Rust, the epic's central claim — that
    a new kind and a new importer cost zero core — would be false, and that would be the
    headline of this item rather than a footnote.
    """
    _root, _pkg, changed = require_introducing_branch(__file__)
    rust = [p for p in changed if p.endswith(".rs")]
    assert rust == [], (
        f"Rust changed: {rust}. Adding an importer is supposed to cost zero core; if this "
        "branch genuinely needs a Rust change then INV-8 does not hold for a second vendor "
        "and that is the finding, not an exemption to grant."
    )


def test_no_frontend_file_changed_at_all():
    """No `src-app/ui/`, no `src-app/desktop/`. Not "only the named ones" — NONE.

    This is a strictly stronger claim than the Visium sibling makes, and it is why this
    package enumerates no `tier: e2e` test: there is no frontend surface to drive. The
    artifacts render through `sc.viz.coordinates` (a capability-only selector on
    `plottable-xy`) and `sc.viz.colour-by`, both already shipped and already tested.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    frontend = [p for p in changed
                if (p.startswith("src-app/ui/") or p.startswith("src-app/desktop/"))
                and not infra_exempt(p, root)]
    assert frontend == [], (
        f"frontend file(s) changed: {frontend}. A pure-data importer contributes no UI; if "
        "one is needed, it is a separate reviewed change and this package's e2e budget "
        "(currently zero) has to be re-planned."
    )


def test_no_openapi_or_generated_client_changed():
    """No route, no DTO — so the regen must be empty, asserted at the diff rather than
    inferred from "we did not mean to"."""
    _root, _pkg, changed = require_introducing_branch(__file__)
    generated = [p for p in changed
                 if p.endswith("openapi.json") or p.endswith("api-client/types.ts")]
    assert generated == [], f"generated client surface changed: {generated}"


def test_the_env_rootfs_content_lock_did_not_move():
    """The rootfs is UNTOUCHED, which is what makes `imagecodecs` free.

    `differential-expression/tests/test_rootfs_deps_r.py` locks the python recipe to a
    `(count, sha256)` of its bytes. Adding a pin would move it, force a
    `differential-expression` version bump and imply an image republish — and design §10's
    own cost table PREDICTED that Xenium would need exactly that ("one Dockerfile line +
    smoke import + an image republish"). It does not, because `imagecodecs` is already
    pinned and `cells.csv.gz` removes any need for a parquet reader. Asserted so a future
    edit cannot quietly reintroduce the cost.
    """
    _root, _pkg, changed = require_introducing_branch(__file__)
    rootfs = [p for p in changed if p.startswith("src-app/env-rootfs/")]
    assert rootfs == [], (
        f"env-rootfs changed: {rootfs}. That moves the content lock at "
        "differential-expression/tests/test_rootfs_deps_r.py and implies an image "
        "republish; re-record the digest in the SAME commit, with the reason."
    )


def test_every_named_exemption_is_actually_touched():
    """A named exemption that nothing uses is a standing permission nobody reviewed.

    Permissions rot in one direction: a file that stops being touched leaves its exemption
    behind for the next branch to inherit silently. So the list is asserted in BOTH
    directions.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    changed_set = set(changed)
    stale = sorted(
        p for p in (SANCTIONED_NON_PACKAGE | SIBLING_SPATIAL_PACKAGES | SERVER_GOLDEN)
        if p not in changed_set and (root / p).exists()
    )
    assert stale == [], (
        f"exemption(s) granted for path(s) this branch does not touch: {stale}. Remove "
        "them; an unused exemption is a permission the next branch inherits unreviewed."
    )


def test_the_visium_importers_own_compute_is_untouched():
    """The sibling importer's LOGIC does not move, only its vendored helper.

    Stated as its own assertion because it is the half that would be quietest to lose: a
    convenient edit to `import_visium.py` while generalising shared code would be a change
    to a shipped feature, made under this item's review rather than its own.
    """
    _root, _pkg, changed = require_introducing_branch(__file__)
    for forbidden in (
        "src-app/packages/spatial-import-visium/compute/import_visium.py",
        "src-app/packages/spatial-import-visium/compute/spatial_declarations.py",
        "src-app/packages/spatial-types/compute/spatial_declarations.py",
    ):
        assert forbidden not in changed, (
            f"{forbidden} changed — this branch promotes `ome_writer.py` and generalises "
            "ONE function in it; it does not touch the sibling's logic or the declaration "
            "contract."
        )


def test_the_sibling_suites_this_branch_moves_still_pass():
    """THE LEG THIS GUARD WAS MISSING, and the blind audit is what found it.

    Every assertion above reads the DIFF. A diff-scoped guard can tell you that only five
    paths outside this package changed and cannot tell you that one of those changes turned
    another package's suite red — which is exactly what happened: adding a datatype to
    `spatial-types` broke three of its own tests (a hard-coded id set, a missing golden row,
    an unanchored axis key) while every assertion in this file stayed green.

    "Zero `src-app` changes" is a claim about the TREE, not about a path list. So the two
    packages this branch reaches into are RUN, in a subprocess, and their exit code is read
    directly. `just check-py` would eventually catch it, but by then the branch has claimed
    to be pure data in five artifacts and a report.
    """
    import subprocess
    import sys

    root, _pkg, _changed = require_introducing_branch(__file__)
    packages = root / "src-app" / "packages"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "spatial-types/tests",
         "spatial-import-visium/tests/test_package_registration.py", "-q", "--no-header",
         "--junit-xml=/dev/null"],
        cwd=str(packages), capture_output=True, text=True, timeout=1800,
    )
    assert result.returncode == 0, (
        "a package this branch edits has a FAILING suite. That is not a diff problem and no "
        "assertion above can see it — the claim being made is that this contribution is "
        "pure data and costs nothing, and a red sibling suite falsifies it.\n\n"
        f"stdout:\n{result.stdout[-6000:]}\n\nstderr:\n{result.stderr[-2000:]}"
    )
