#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 (cont.) [acceptance] [invariant: INV-1] — the zero-core anchor, as a DIFF.

TEST-1 in `test_spatial_types_manifest.py` proves that no app-core file NAMES a spatial
kind id. That is a proxy. THIS is the direct statement: on the branch that introduces this
package, `git diff origin/main...HEAD --name-only` contains no path under `src-app/ui/`,
and the only `src-app/` paths outside this package are the ones named below.

## Why this file exists now and did not before

The branch's own DEC-19 refused to add a fourth copy of this guard, and the reason was
sound at the time: the three shipped copies asserted a property of the BRANCH while
living in a PACKAGE, so they were vacuously true on `main`, false on every later branch,
and a fourth copy would have enlarged that trap rather than proving anything. Six of their
assertions were red on this branch for exactly that reason.

`fix/zero-core-derived` repaired the class: `zero_core_guard.require_introducing_branch`
derives WHICH branch the assertion belongs to from the diff itself (add-only, keyed on the
package's own `manifest.yaml` appearing among the ADDED paths) and SKIPS elsewhere with a
stated reason rather than failing. The objection is therefore gone, and what is left is a
guard that runs IN FULL on this branch — which is the branch it describes — and skips
visibly everywhere after. Adding it here is the whole point of that repair: the anchor
should be executable on the branch that has to satisfy it.

It also replaces a guard that cannot do this job. `scripts/check-kinds-zero-core.sh` is a
hardcoded denylist of three `open-kinds` ids and never looks for a spatial one (#184), so
its PASS says nothing about this package.
"""
import json
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

#: The sanctioned non-package `src-app/` paths for THIS package's introducing branch.
#: Package-specific and deliberately NOT shared — a union across packages would grant
#: every package every other package's exemptions, which is the prefix-exemption failure
#: in a new costume.
#:
#: * `pytest.ini` — the `testpaths` append. That file's own header requires a new
#:   `<package>/tests/` directory to be enumerated in the SAME commit that creates it; a
#:   suite absent from it is collected by nothing.
#: * `env-rootfs/single-cell/{requirements.txt,Dockerfile}` — #181, which is a DIFFERENT
#:   issue that rides this branch: it declares `tifffile`/`imagecodecs` through #80's pin
#:   + smoke-import mechanism. Sanctioned here because #181 asks for exactly these two
#:   edits and for nothing else; note the `infra_exempt` hook does NOT cover them (it is
#:   keyed on the ADD of a pin file, and #80 already added this one), so they are named.
#: * `_lib/model_coverage_exempt.json` — the STATED disposition for
#:   `spatial/boundaries`' entity axis. `vertex_index` is anchored to no upload boundary,
#:   so `server/tests/model_coverage` demands a recorded reason, exactly as it already
#:   does for `graph/attributed`'s `node`. The alternative was to omit `entity_axis`,
#:   which makes that guard SKIP the type — answering its question by suppressing it.
#:   This file is DATA the guard reads and it lives under `packages/` on purpose (every
#:   entry necessarily names a datatype and an axis, while `server/tests/**` is
#:   domain-scanned), so contributing the disposition is a data edit, not a core one.
#: * `_lib/manifest.yaml` — the version bump the seed-reconciliation guard requires the
#:   moment any file in that package moves. Mechanically implied by the line above.
#:
#: Both are inside `src-app/packages/` and therefore satisfy the zero-core anchor as the
#: design states it; they are named here because they are outside THIS package, which is
#: the stricter question this guard asks. They are bound to this change and nothing else:
#: neither would be touched by a branch that did not add an unanchored entity axis.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
    "src-app/env-rootfs/single-cell/requirements.txt",
    "src-app/env-rootfs/single-cell/Dockerfile",
    "src-app/packages/_lib/model_coverage_exempt.json",
    "src-app/packages/_lib/manifest.yaml",
}

#: The ONE path under `src-app/server/src/` this branch touches, and the only one it is
#: permitted to touch — see `test_the_only_server_src_path_is_the_goldens_case_tables`,
#: which is what actually constrains it. Named as a constant so the two tests below cannot
#: drift about which file they mean.
GOLDEN = "src-app/server/src/modules/datatype/tests/lattice_golden.json"


def test_no_ui_change_and_no_server_src_change_beyond_the_golden():
    """No frontend file, and no server source file except the parity fixture.

    The blanket "nothing under `src-app/server/src/`" the three sibling copies assert is
    NOT weakened here so much as made precise: this branch touches exactly one such path,
    it is a TEST FIXTURE, and the next test pins what may be in it. Stating the exception
    by name — rather than dropping the assertion, or widening it to a prefix — is what
    keeps it bound to the change it exists for (derived-guards §5).
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/") or infra_exempt(p, root):
            continue
        assert not p.startswith("src-app/ui/"), f"UI file changed (breaks INV-1): {p}"
        if p.startswith("src-app/server/src/"):
            assert p == GOLDEN, (
                f"server src changed: {p}. The only sanctioned path is the shared "
                f"Rust/TS parity fixture, and only for its behavioural case tables."
            )


def test_only_this_package_and_the_sanctioned_set_changed():
    """Everything else under `src-app/` is this package's own tree."""
    root, pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the src-app scope this test guards
        if p.startswith(package_prefix(pkg)) or infra_exempt(p, root):
            continue
        if p == GOLDEN:
            continue
        assert p in SANCTIONED_NON_PACKAGE, (
            f"unexpected non-package src-app change (INV-1 zero-core): {p}"
        )


def test_the_only_server_src_path_is_the_goldens_case_tables():
    """The exception above is bounded by WHAT is in the file, not just by its name.

    This is the assertion that makes naming `lattice_golden.json` a sanctioned cost rather
    than a hole. `fix/zero-core-derived` deleted the golden's frozen `lattice` array
    precisely because a frozen count of the contributed SET made adding a datatype cost a
    core edit — mutually unsatisfiable with the zero-core invariant. What legitimately
    remains is the behavioural CASE tables, which `docs/design/derived-guards.md` §4 keeps
    on purpose: they freeze VALUES the derivation structurally cannot (both its sides read
    the same manifests, so a declaration-side change moves them together), and they cost
    an edit per COVERED type, never per added one.

    So: the file may be touched, and the only thing that may be in it is case rows. If a
    future edit reintroduces the frozen set — or adds any other top-level key — the
    exception stops applying and this goes red.
    """
    root, _pkg, changed = require_introducing_branch(__file__)
    if GOLDEN not in changed:
        return  # touching it is permitted, never required

    golden = json.loads((root / GOLDEN).read_text(encoding="utf-8"))
    assert "lattice" not in golden, (
        "the frozen `lattice` array is back in the golden. It was deleted deliberately: "
        "`reg.len() == lattice.len()` made contributing a datatype cost an edit under "
        "`src-app/server/src/`, which is the contradiction this branch reported and that "
        "commit repaired. Re-adding it would make this package's own core edit a real one."
    )
    assert set(golden) <= {"_comment", "is_a", "accepts", "viewers_for", "layout_kind"}, (
        f"the golden grew a top-level key beyond its case tables: {sorted(golden)}. The "
        "sanctioned cost is case rows over the types this package contributes — anything "
        "else under `src-app/server/src/` is a core edit wearing a fixture's name."
    )
