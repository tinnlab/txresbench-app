#!/usr/bin/env python3
# ruff: noqa
"""Self-tests for `zero_core_guard` — the derived, self-limiting scope shared by the
package zero-src-app-diff guards (docs/design/derived-guards.md §3).

## Why these build synthetic git repositories

The thing under test is a judgement about SOME OTHER BRANCH: "is this branch the one
that introduced package X?" There is exactly one branch in this repository's history
for which the answer is yes, and it is not this one — so asserting the helper against
the repo's own diff could only ever exercise the `False` arm, which is precisely the
arm the old code got right. The interesting cases (an introducing branch, a
maintenance branch that merely modifies the manifest, a branch introducing a DIFFERENT
package) do not exist here and cannot be conjured by reading the tree.

So each test builds a throwaway git repository in a tmpdir with the branch shape it
needs and asks the helper about it. No network, no fixtures on disk, no dependence on
this checkout's own history.
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_LIB = Path(__file__).resolve().parent
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

import zero_core_guard as g  # noqa: E402

REPO = Path(__file__).resolve().parents[3]


# ── synthetic-repository helpers ───────────────────────────────────────────────────


#: Environment that makes the synthetic repositories HERMETIC.
#:
#: Round-1 audit: without this, a developer or CI box with `commit.gpgsign = true` or a
#: global `core.hooksPath` pointing at a failing `pre-commit` fails 8 of these 15 tests —
#: and `core.hooksPath` is not hypothetical here, since this repository's own lifecycle
#: installs hooks. Pinning the config files to /dev/null and supplying identity via the
#: environment removes the whole class rather than the two instances that were measured.
_HERMETIC_GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}

#: `-c` overrides applied to every git call, for the settings a config file cannot be
#: relied on to have neutralised (a repo-local value set by `git init` templates).
_HERMETIC_GIT_FLAGS = ("-c", "commit.gpgsign=false", "-c", "core.hooksPath=")


def _run(cwd: Path, *args: str) -> None:
    if args and args[0] == "git":
        args = ("git", *_HERMETIC_GIT_FLAGS, *args[1:])
    r = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True,
                       env=_HERMETIC_GIT_ENV)
    assert r.returncode == 0, f"{' '.join(args)} failed: {r.stderr}"


def _write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _init_repo(tmp_path: Path) -> Path:
    """A git repo with a `main` branch holding one pre-existing package."""
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    _run(root, "git", "init", "-q", "-b", "main")
    _run(root, "git", "config", "user.email", "t@example.invalid")
    _run(root, "git", "config", "user.name", "t")
    _write(root, "src-app/packages/existing/manifest.yaml", "id: existing\n")
    _write(root, "README.md", "seed\n")
    _run(root, "git", "add", "-A")
    _run(root, "git", "commit", "-qm", "seed")
    return root


def _branch(root: Path, name: str) -> None:
    _run(root, "git", "checkout", "-q", "-b", name)


def _commit(root: Path, msg: str) -> None:
    _run(root, "git", "add", "-A")
    _run(root, "git", "commit", "-qm", msg)


# ── TEST-1 [acceptance] [invariant: INV-2] — the add-only introducing-branch marker ──


def test_introducing_branch_is_detected_by_the_manifest_ADD(tmp_path):
    """TEST-1 — a branch that ADDS `<pkg>/manifest.yaml` IS the introducing branch."""
    root = _init_repo(tmp_path)
    _branch(root, "feat/new-pkg")
    _write(root, "src-app/packages/newpkg/manifest.yaml", "id: newpkg\n")
    _write(root, "src-app/packages/newpkg/compute/run.py", "x = 1\n")
    _commit(root, "add newpkg")
    assert g.introduces_package(root, "newpkg") is True


def test_a_branch_that_only_MODIFIES_the_manifest_is_not_introducing(tmp_path):
    """TEST-1 — the marker is ADD-ONLY: maintenance must never re-arm the guard.

    This is the leg that keying on "the diff touches the manifest" would fail. A
    version bump is the single most likely edit a package's manifest ever receives; if
    that re-armed the guard, every such branch would inherit the false-red this design
    exists to remove.
    """
    root = _init_repo(tmp_path)
    _branch(root, "chore/bump")
    _write(root, "src-app/packages/existing/manifest.yaml", "id: existing\nversion: 2\n")
    _commit(root, "bump existing")
    assert g.introduces_package(root, "existing") is False


def test_introducing_ANOTHER_package_does_not_arm_this_ones_guard(tmp_path):
    """TEST-1 — the marker is per-package, not "some package was added".

    This is the literal defect: the doublet branch introduced `doublet` and thereby
    reddened the guards belonging to `embedding`, `clustering` and
    `differential-expression`.
    """
    root = _init_repo(tmp_path)
    _branch(root, "feat/doublet")
    _write(root, "src-app/packages/doublet/manifest.yaml", "id: doublet\n")
    _write(root, "src-app/packages/doublet/compute/_criteria.py", "x = 1\n")
    _commit(root, "add doublet")
    assert g.introduces_package(root, "doublet") is True
    for foreign in ("existing", "embedding", "clustering"):
        assert g.introduces_package(root, foreign) is False


def test_touching_a_packages_other_files_is_not_introducing_it(tmp_path):
    """TEST-1 — editing a package's compute/tests without adding its manifest."""
    root = _init_repo(tmp_path)
    _branch(root, "fix/existing-compute")
    _write(root, "src-app/packages/existing/compute/run.py", "x = 2\n")
    _commit(root, "touch existing")
    assert g.introduces_package(root, "existing") is False


# ── TEST-2 [acceptance] [invariant: INV-4] — self-limiting is not self-disabling ────


def test_on_the_introducing_branch_a_core_edit_is_still_visible(tmp_path):
    """TEST-2 — the MUTATION leg.

    Where the premise DOES hold, the guard must still see — and therefore still refuse
    — a core edit. If gating had been implemented as an allowlist or an exemption, this
    path would have been filtered out and the test would go red. If the add-only gate
    were deleted entirely, this test would still pass; it is deliberately paired with
    TEST-1, which fails in that case.
    """
    root = _init_repo(tmp_path)
    _branch(root, "feat/new-pkg")
    _write(root, "src-app/packages/newpkg/manifest.yaml", "id: newpkg\n")
    _write(root, "src-app/server/src/modules/sneaky.rs", "// core edit\n")
    _commit(root, "add newpkg + a core edit")

    assert g.introduces_package(root, "newpkg") is True, "premise must hold here"
    changed = g.changed_paths(root)
    assert "src-app/server/src/modules/sneaky.rs" in changed, (
        "the core edit must remain visible to the assertion on the introducing branch — "
        "self-limiting must not become self-disabling"
    )
    assert g.infra_exempt("src-app/server/src/modules/sneaky.rs", root) is False, (
        "no exemption may swallow a core edit on a branch with no #80 marker"
    )


def test_the_80_exemption_is_add_only_too(tmp_path):
    """TEST-2 — the inherited #80 marker keeps its add-only semantics after the move."""
    root = _init_repo(tmp_path)
    _write(root, "src-app/env-rootfs/single-cell/requirements.txt", "numpy==1\n")
    _commit(root, "seed the recipe on main")

    _branch(root, "chore/pin-bump")
    _write(root, "src-app/env-rootfs/single-cell/requirements.txt", "numpy==2\n")
    _commit(root, "bump the pin")
    assert g.is_dependency_contract_branch(root) is False, (
        "a pin BUMP must not resurrect the #80 relaxation"
    )

    _run(root, "git", "checkout", "-q", "main")
    _branch(root, "feat/second-recipe")
    _write(root, "src-app/env-rootfs/other/requirements.txt", "scipy==1\n")
    _commit(root, "add a second recipe")
    assert g.is_dependency_contract_branch(root) is True


# ── TEST-3 [acceptance] [invariant: INV-1] — the subject is DERIVED, not typed in ────


#: The manifest-keyed gate. A marker-keyed guard (`require_introducing_file`) is a
#: DIFFERENT premise and gets its own controls (`test_a_marker_keyed_guard_module_*`):
#: driving it from the manifest-keyed harness would construct an introducing branch its
#: premise does not recognise, and the positive control would read a SKIP as a pass.
_MANIFEST_KEYED_GATE = "require_introducing_branch"


def _called_names(source: str) -> set[str]:
    """Every function name CALLED in `source` — read from the AST, never from the text.

    A whole-file substring scan cannot tell an invocation from a docstring explaining one,
    and every module in this tree explains itself at length. That is not a hypothetical
    here: a blind audit proved BOTH directions of the substring version of this function.
    A guard reverted to fully unscoped stayed in the derived set purely because its prose
    still said `require_introducing_branch`; scrub the prose and it silently LEFT the set —
    i.e. dropping the gate removed the module from the set that is checked for having the
    gate. And the marker-keyed sibling was classified correctly only by the accident of an
    unrelated comment deletion; re-adding a comment naming the manifest gate to that file
    would have re-broken the harness.

    Attribute calls (`g.require_introducing_branch(...)`) count as their attribute name, so
    an import style change cannot silently move a module between classes.
    """
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            names.add(func.id)
        elif isinstance(func, ast.Attribute):
            names.add(func.attr)
    return names


#: Modules that CALL the manifest-keyed gate but cannot be staged into the synthetic
#: harness, with the reason each. An ENUMERATION with a stated reason, never a prefix —
#: and asserted in BOTH directions by `test_the_harness_exclusions_are_all_real`, because
#: an exclusion nothing checks is a permission the next module inherits unreviewed.
_UNSTAGEABLE_GUARD_MODULES = {
    # Not a guard module: all but one of its tests are properties of the shipped tree (what
    # the compute imports, what the recipe pins) and pull in the package's own compute plus a
    # live run fixture. (No count is given: two earlier drafts gave one and both went stale
    # the moment this same change added a test.) Staging it standalone would fail on imports the synthetic tree has
    # no way to provide, and would prove things about the copy rather than the guard.
    # Its ONE gated assertion is covered instead by an ungated vacuity control in that
    # module (`test_the_frozen_rootfs_file_list_is_not_vacuous`).
    "differential-abundance/tests/test_rootfs_unchanged.py",
}


def _shipped_zero_diff_guards() -> list[Path]:
    """Every shipped, MANIFEST-KEYED guard module — derived from CALL SITES, not names.

    ## Two things were wrong with the derivation this replaces (#238/#268/#282/#299)

    1. It globbed `*/tests/test_zero_src_app_diff.py`, which looks derived and is not: it
       derives over the guards that happen to spell the canonical BASENAME. Two shipped
       guards do not — `doublet/tests/test_doublet_zero_src_app_diff.py` and
       `differential-abundance/tests/test_da_zero_src_app_diff.py` — so for as long as
       those two were unscoped, the end-to-end controls below (whose whole job is to catch
       exactly that defect) never saw them. The defect was found by hand, six branches
       later, and filed five times.
    2. The first repair merely WIDENED the glob and filtered on a substring. A blind audit
       showed that still decides membership by filename first, and that the substring half
       is defeated in both directions (see :func:`_called_names`).

    So membership is now: any `<pkg>/tests/*.py` that CALLS the manifest-keyed gate, minus
    the enumerated, reasoned `_UNSTAGEABLE_GUARD_MODULES`. No name pattern at all. A guard
    that drops the gate does not quietly leave the set — it is caught by the sweep, which
    ranges over every package test module rather than over this set.
    """
    found = []
    for path in sorted((REPO / "src-app" / "packages").glob("*/tests/**/*.py")):
        # Relative to the packages root, so the FIRST segment is the package — the
        # left-to-right `parts.index("packages")` this replaces is the exact silent
        # mis-scoping `package_of` documents at length, reappearing in the file that asserts
        # against it (a checkout under `/home/dev/packages/…` resolved the wrong name).
        pkg = path.relative_to(REPO / "src-app" / "packages").parts[0]
        if pkg.startswith(g._NON_PACKAGE_PREFIXES):
            continue  # `_lib`/`_helpers` are not contributing packages — `package_of` refuses them
        rel = path.relative_to(REPO / "src-app" / "packages").as_posix()
        if rel in _UNSTAGEABLE_GUARD_MODULES:
            continue
        if _MANIFEST_KEYED_GATE in _called_names(path.read_text(encoding="utf-8")):
            found.append(path)
    return found


def test_the_owning_package_is_derived_from_the_modules_own_path():
    """TEST-3 — parametrised over the TREE, so a hardcoded name cannot satisfy it.

    Discovering the guards by glob rather than naming three of them is the same
    property being asserted, one level up: if a fourth package ships this guard
    tomorrow, this test covers it with no edit here.
    """
    guards = _shipped_zero_diff_guards()
    assert len(guards) >= _MIN_SHIPPED_GUARDS, (
        f"expected at least {_MIN_SHIPPED_GUARDS} shipped zero-src-app-diff guards to be "
        f"discoverable; found {guards}. A collapsed derivation must FAIL here rather than "
        f"quietly reduce every control below to a no-op (`derived-guards.md` §2's floor)."
    )
    for guard in guards:
        expected = guard.parents[1].name  # <pkg>/tests/<file> -> <pkg>
        assert g.package_of(guard) == expected


#: TEST-8 — the fail-closed floor for the derived set above. `derived-guards.md` §2: *"A
#: floor (a committed minimum count, fail-closed when the derived set collapses) is the
#: correct companion to a derived set, and is not an enumeration: it detects a broken
#: derivation instead of standing in for one."* Same shape as `MIN_PACKAGES` in
#: `scripts/check-processor-seed-versions.sh`.
#:
#: It is set to the CURRENT count, not below it, and that is the point: contributing a
#: package raises the real number and needs no edit here, while a guard silently leaving
#: the set fails. The first cut put it at 8 with a comment claiming that was "above the
#: three the old glob found so a regression to the narrow pattern cannot pass" — the old
#: glob found EIGHT, measured, so the floor was exactly the regression's own count and
#: was decorative for the one failure it named. A blind audit proved that by reverting the
#: glob and watching the floor stay green.
_MIN_SHIPPED_GUARDS = 10


def test_the_harness_exclusions_are_all_real():
    """TEST-8 — `_UNSTAGEABLE_GUARD_MODULES`, asserted in BOTH directions.

    An exclusion nothing checks is a permission the next module inherits unreviewed — the
    rule `test_every_named_exemption_is_actually_touched` already applies to the sanctioned
    path sets in `spatial-import-xenium`. So each entry must (a) still exist and (b) still
    CALL the gate. An entry whose module was deleted, renamed, or has stopped being a gate
    caller is a stale permission, and an entry that never applied is a typo that silently
    removed nothing.
    """
    packages_root = REPO / "src-app" / "packages"
    for rel in sorted(_UNSTAGEABLE_GUARD_MODULES):
        path = packages_root / rel
        assert path.is_file(), (
            f"`{rel}` is excluded from the both-ways harness but does not exist. Remove "
            f"the entry — a stale exclusion is a permission the next module inherits."
        )
        assert _MANIFEST_KEYED_GATE in _called_names(path.read_text(encoding="utf-8")), (
            f"`{rel}` is excluded from the both-ways harness as an unstageable GATE "
            f"CALLER, but it no longer calls `{_MANIFEST_KEYED_GATE}`. Either it stopped "
            f"being a guard (drop the entry) or it stopped being scoped (that is the "
            f"defect this whole module exists to catch)."
        )


def test_every_gate_calling_module_is_either_STAGED_or_explicitly_excluded(tmp_path):
    """Every gate caller is either really staged by the harness, or named with a reason.

    ## Its first cut was tautological, and the fix is WHERE the left side comes from

    It used to recompute `staged` with filters character-identical to its own loop's, so
    `unaccounted` was empty for every possible tree state and a blind audit called it what it
    was: coverage true by construction. The repair is not a different filter — it is to take
    the left side from what `_stage_real_guards` ACTUALLY WRITES. That makes this a test of
    the staging function rather than a restatement of the selection predicate, and it fails if
    staging silently drops a module the derivation selected (a name collision, a write that
    lands in the wrong directory, a package whose two guards overwrite each other).
    """
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    _stage_real_guards(root)
    staged = {
        p.relative_to(root / "src-app/packages").as_posix()
        for p in (root / "src-app/packages").glob("*/tests/**/*.py")
    }

    packages_root = REPO / "src-app" / "packages"
    unaccounted = []
    for path in sorted(packages_root.glob("*/tests/**/*.py")):
        rel = path.relative_to(packages_root).as_posix()
        if rel.split("/")[0].startswith(g._NON_PACKAGE_PREFIXES):
            continue
        if rel in staged or rel in _UNSTAGEABLE_GUARD_MODULES:
            continue
        if _MANIFEST_KEYED_GATE in _called_names(path.read_text(encoding="utf-8")):
            unaccounted.append(rel)
    assert unaccounted == [], (
        f"these modules call `{_MANIFEST_KEYED_GATE}` but the harness does not stage them and "
        f"`_UNSTAGEABLE_GUARD_MODULES` does not name them: {unaccounted}. A gate caller "
        f"nothing exercises has no positive control, so nothing would notice its assertions "
        f"being gutted."
    )
    assert len(staged) >= _MIN_SHIPPED_GUARDS, (
        f"the harness staged {len(staged)} guard module(s), below the floor of "
        f"{_MIN_SHIPPED_GUARDS} — staging dropped modules the derivation selected."
    )




def test_package_of_refuses_a_path_outside_the_package_layout(tmp_path):
    """TEST-3 — it raises rather than guessing; a wrong answer would mis-scope a guard."""
    with pytest.raises(AssertionError):
        g.package_of(tmp_path / "somewhere" / "else" / "test_x.py")


def test_package_of_refuses_a_reserved_folder():
    """TEST-3 — `_lib`/`_helpers` are not contributing packages (`scan_dir` skips them)."""
    with pytest.raises(AssertionError):
        g.package_of(REPO / "src-app/packages/_lib/tests/test_x.py")


def test_the_guard_module_spells_no_shipped_package_name():
    """TEST-3 — INV-1 asserted against the module's own text.

    A single typed-in package name would make `test_the_owning_package_is_derived…`
    pass for one package and fail for the others; this catches the subtler form where a
    name is present but unused.
    """
    # Look ONLY inside string literals that are not docstrings — that is where a hardcode
    # can actually live. Two earlier forms were both wrong, in opposite directions:
    #   * matching the QUOTED token (`"embedding"`) let the realistic shape — a path
    #     literal, `"src-app/packages/embedding/"` — walk straight past (audit, verified
    #     by mutation);
    #   * matching the bare word over comment-stripped text then flagged this module's own
    #     PROSE, which legitimately names a package while explaining a historical decision.
    # An AST walk separates the two exactly, instead of approximating with a regex over
    # the whole file.
    import ast

    tree = ast.parse((_LIB / "zero_core_guard.py").read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    body = "\n".join(
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings
    )
    assert body, "no non-docstring string literals found — the AST walk collapsed"
    # The shipped package folders, derived — not a typed list.
    shipped = {
        p.name
        for p in (REPO / "src-app" / "packages").iterdir()
        if p.is_dir() and (p / "manifest.yaml").is_file() and not p.name.startswith(("_", "."))
    }
    assert shipped, "expected to derive at least one shipped package folder"
    # Match the BARE NAME as a word, not the quoted token. Round-1 audit, verified by
    # mutation: the quoted-token form let `_HARDCODED = "src-app/packages/embedding/"` —
    # the realistic hardcoding shape, a path literal — pass straight through.
    for name in sorted(shipped):
        assert not re.search(rf"(?<![A-Za-z0-9_-]){re.escape(name)}(?![A-Za-z0-9_-])", body), (
            f"zero_core_guard.py spells the package name `{name}` — it must derive it"
        )


# ── TEST-10 — the module reaches no sandbox, and `_lib` still contributes nothing ────


def test_the_guard_module_is_not_staged_into_any_sandbox():
    """TEST-10 — `/code` is assembled from explicit tables; this module is in neither."""
    staging = (REPO / "src-app/server/src/modules/sandbox/processors/mod.rs").read_text(
        encoding="utf-8"
    )
    # HAYSTACK CONTROL. Round-1 audit: an absence assertion needs proof it is reading the
    # file that would contain the thing. If the staging tables move to another module, or
    # are built from a glob, the assertion below would stay green while this module could
    # in fact be staged. These two names are what make "not present" mean "not staged".
    for expected in ("PY_HELPER_FILES", "txr_zarr"):
        assert expected in staging, (
            f"`{expected}` is not in sandbox/processors/mod.rs — the staging tables have "
            f"moved, so the absence assertion below is being made against the wrong file"
        )
    assert "zero_core_guard" not in staging, (
        "zero_core_guard.py must not be staged into any processor's /code dir — it is "
        "test-time framework code, not a runtime helper"
    )


def test_lib_still_contributes_nothing_to_the_registry():
    """TEST-10 — adding a file to `_lib` must not turn it into a contributing package.

    PARSES the manifest. Round-1 audit, verified by mutation: the previous substring form
    (`"contributes: {}" in manifest`) stayed green when that line was commented out AND a
    real `contributes.datatypes` block was appended — i.e. it passed on the text of the
    thing it was asserting the absence of.
    """
    doc = yaml.safe_load((_LIB / "manifest.yaml").read_text(encoding="utf-8")) or {}
    contributes = doc.get("contributes") or {}
    assert contributes == {} or not any(contributes.values()), (
        f"`_lib` is a RESERVED package: `scan_dir` skips `_`-prefixed folders, so anything "
        f"it contributes would be silently dropped. Declared: {contributes!r}"
    )


# ── TEST-12 — the design source cannot silently vanish from under its invariants ────


def test_the_design_source_declares_every_invariant_the_guards_cite():
    """TEST-12 — a LINK-ROT check, and deliberately nothing more.

    It asserts the named design source still exists and still declares INV-1..INV-4, so the
    invariants the guards cite cannot silently lose their home. Round-1 audit, correctly:
    it does NOT check that the invariant TEXT is unchanged, that any guard cites them, or
    that the document says anything sensible — the document could be reduced to four bold
    tokens and stay green. Judging fidelity to the design is the blind design-conformance
    reviewer's job (phase 6), not a substring test's.
    """
    doc = REPO / "docs" / "design" / "derived-guards.md"
    assert doc.is_file(), f"the named design source is missing: {doc}"
    text = doc.read_text(encoding="utf-8")
    for inv in ("INV-1", "INV-2", "INV-3", "INV-4"):
        assert f"**{inv}**" in text, f"{inv} is no longer declared in {doc}"


# ── TEST-11 — the SHIPPED guards, driven from a branch that introduces ANOTHER package ──
#
# This is the defect, end to end, and it can only be observed from a foreign branch. The
# tests above prove the DETECTOR; this one runs the three real guard modules, unmodified,
# inside a synthetic repository whose branch introduces an unrelated package — the exact
# situation in which they previously reddened six assertions belonging to three packages
# nobody had touched.

def _guard_targets() -> list[tuple[str, str]]:
    """`(package, module basename)` for every shipped manifest-keyed guard — DERIVED.

    Round-1 audit: this was a typed tuple of three names, ten lines below a function in
    this same file that already derives the set and whose docstring justifies deriving it
    ("if a fourth package ships this guard tomorrow, this test covers it with no edit
    here"). A fourth package would have got the derived coverage and not the end-to-end
    coverage — INV-1 broken inside the INV-1 test file.

    It now carries the BASENAME too, because the previous version silently assumed every
    guard is called `test_zero_src_app_diff.py`. Two are not, and that assumption is
    precisely how their unscoped copies escaped these controls for five filed issues
    (#238/#268/#282/#299). Deriving the name removes the assumption instead of adding a
    second one.
    """
    return [(p.parents[1].name, p.name) for p in _shipped_zero_diff_guards()]


def _guard_packages() -> list[str]:
    """Just the package ids, for the tests that only need the subject."""
    return [pkg for pkg, _name in _guard_targets()]


def _stage_real_guards(root: Path) -> None:
    """Copy the SHIPPED guard modules + the helper into a synthetic packages tree.

    Each module is staged under its OWN basename. Writing them all to one canonical name
    would collide the moment a package ships two, and would also hide the naming variation
    this harness now exists to cover.
    """
    lib_dst = root / "src-app/packages/_lib"
    lib_dst.mkdir(parents=True, exist_ok=True)
    (lib_dst / "zero_core_guard.py").write_text(
        (_LIB / "zero_core_guard.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (lib_dst / "manifest.yaml").write_text("id: _lib\ncontributes: {}\n", encoding="utf-8")
    for pkg, name in _guard_targets():
        src = REPO / "src-app/packages" / pkg / "tests" / name
        dst_dir = root / "src-app/packages" / pkg / "tests"
        dst_dir.mkdir(parents=True, exist_ok=True)
        (dst_dir / name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        _write(root, f"src-app/packages/{pkg}/manifest.yaml", f"id: {pkg}\n")
    # The REAL `src-app/packages/pytest.ini` carries `addopts = -q --import-mode=importlib`,
    # and `just check-py` runs bare `pytest` from that directory, so it honours it. Mirrored
    # so the harness exercises the guards under the import mode the gate actually uses.
    # NOTE, because a blind audit measured it: no assertion here currently distinguishes the
    # two modes — reverting to a bare `[pytest]` leaves every test green, since `_pytest_in`
    # runs one target per invocation and no basename collision is reachable either way. It is
    # kept as fidelity to the real invocation, not claimed as load-bearing.
    # (`-q` is NOT mirrored: this harness already passes `-q` on the command line, and a
    # second one suppresses the `N skipped` summary the controls below count.)
    _write(root, "src-app/packages/pytest.ini",
           "[pytest]\naddopts = --import-mode=importlib\n")
    # `docs/design/derived-guards.md` is referenced only in a skip message, not read.


def _pytest_in(root: Path, *targets: str) -> subprocess.CompletedProcess:
    """Run pytest inside the synthetic packages tree, ONE MODULE per invocation.

    ## The reason recorded here used to be false, and the correction is the useful part

    It said: *"All three shipped guards share the basename `test_zero_src_app_diff.py` …
    collecting more than one in a single pytest session is an `import file mismatch` …
    on `origin/main` `just check-py` itself fails collection with 11 such errors."*

    Measured on `origin/main`: `pytest --collect-only -q` reports **4411 collected, 0
    errors**; the 38 collection errors appear only with `--override-ini=addopts=` — which
    is exactly what a bare synthetic `[pytest]` file used to do here. `packages/pytest.ini`
    carries `--import-mode=importlib`, under which same-named modules in different
    directories coexist. The "pre-existing condition of this tree" was self-inflicted by
    this fixture. (Eight guards share that basename, not three, and there are ten in total
    across three distinct names — the miscount is the same assumption this change exists
    to remove.)

    One target per invocation is KEPT anyway, for a better reason: each guard's outcome has
    to be attributable to that guard. A single session over ten modules reports one exit
    code and one skip tally, and the controls below assert per-guard behaviour.
    """
    env = dict(os.environ)
    env.pop("PYTEST_ADDOPTS", None)
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-rs", "-p", "no:cacheprovider", *targets],
        cwd=str(root / "src-app/packages"),
        capture_output=True,
        text=True,
        env=env,
    )


# `_gate_call_sites` used to sit here, deriving an expected skip count from the module
# under test. It is gone with the assertion that used it: a count derived from the same
# module the mutation edits moves in lockstep with the mutation, so it could never fail for
# its own subject.



def _skipped_count(pytest_output: str) -> int:
    """The `N skipped` figure from the LAST `-q` summary line, or 0.

    The last, not the first: a staged guard can PASTE another pytest run's summary into an
    assertion message (`spatial-import-xenium`'s guard shells out to pytest), and the first
    match would then be the nested run's tally rather than this one's.
    """
    matches = re.findall(r"(\d+) skipped", pytest_output)
    return int(matches[-1]) if matches else 0


def _gated_test_names(module: Path) -> list[str]:
    """The `test_*` functions in `module` that reach a scope gate — read from its AST.

    The synthetic tree stages a guard MODULE and nothing else, so it cannot satisfy that
    module's UNGATED tests: they legitimately read the real repository (a marker naming a real
    file, a manifest version, a shipped analysis). Running the whole module there made a
    correct ungated control look like a guard failure. Selecting the gated tests by node id
    keeps the harness's subject exactly what it is about — the GATE's behaviour — and leaves
    the tree-scoped assertions to the tree, where they are true and are already run.
    """
    source = module.read_text(encoding="utf-8")
    graph = _call_graph(source)
    return [name for name in sorted(graph)
            if name.startswith("test_") and _reaches(graph, name, set(_SCOPE_GATES))]


def test_the_shipped_guards_skip_on_a_branch_introducing_another_package(tmp_path):
    """TEST-11 — the fix, proven from a branch that is not the one being guarded.

    Reproduces the reported defect's shape: a branch that adds a throwaway package and a
    file inside it. Before the fix this failed six assertions across three unrelated
    packages; the expected outcome now is SKIPPED — visibly, with a reason — and never a
    silent pass, which is why the skip count is asserted rather than just the exit code.
    """
    # TEST-1 [acceptance] [invariant: INV-2] — driven over the WIDENED derived set, so the
    # `doublet` and `differential-abundance` guards this change migrated are covered here
    # with no per-package edit. Before the migration they FAILED on this exact branch shape.
    root = _init_repo(tmp_path)
    _stage_real_guards(root)
    _commit(root, "the three guard packages exist on main")

    _branch(root, "feat/throwaway")
    _write(root, "src-app/packages/zzz-throwaway/manifest.yaml", "id: zzz-throwaway\n")
    _write(root, "src-app/packages/zzz-throwaway/compute/run.py", "x = 1\n")
    # ADVERSARIAL on purpose. Every surface these guards forbid is touched, so a gated
    # assertion that failed to skip would FAIL here rather than pass by luck — which is what
    # makes `returncode == 0` below mean "they all stood down" instead of "none of them
    # happened to fire". The first cut's branch touched only another package, so a guard
    # whose only assertion is about `src-app/ui/` would have passed while fully unscoped.
    _write(root, "src-app/ui/src/modules/stranger.ts", "export const x = 1;\n")
    _write(root, "src-app/server/src/modules/stranger.rs", "// a stranger's core edit\n")
    _commit(root, "add an unrelated package")

    for pkg, name in _guard_targets():
        module = REPO / "src-app/packages" / pkg / "tests" / name
        gated = _gated_test_names(module)
        assert gated, f"`{pkg}/tests/{name}` is in the guard set but gates no test"
        r = _pytest_in(root, *[f"{pkg}/tests/{name}::{fn}" for fn in gated])
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"`{pkg}`'s shipped guard FAILED on a branch that introduces a different "
            f"package — this is the defect:\n{combined}"
        )
        # The skip must be VISIBLE and must say why. A guard that quietly returns is the
        # vacuous-green failure in a different costume (derived-guards.md §1/§3), so the
        # reason string is asserted, not just the exit code.
        assert "skipped" in combined, f"`{pkg}`: expected visible skips, got:\n{combined}"
        assert f"not the branch that introduces `{pkg}`" in combined, (
            f"`{pkg}`'s guard did not report WHY it skipped:\n{combined}"
        )
        # NOT a skip COUNT. The first cut derived an expected count from the module's own
        # AST and asserted `got >= expected`, and a blind audit showed that is structurally
        # blind to the defect it was added for: ungating a test lowers `expected` and `got`
        # in lockstep, so the check can never notice. It is removed rather than adjusted —
        # a check that cannot fail for its own subject is the thing this whole module is
        # about.
        #
        # What carries the weight instead is the SHAPE of the foreign branch above: it
        # touches `src-app/ui/`, `src-app/server/src/` and another package, so ANY gated
        # assertion in these guards that failed to skip would FAIL rather than pass
        # silently, and `returncode == 0` catches it. That is a property of the branch, not
        # of a count derived from the module under test.
        assert _skipped_count(combined) >= 1, (
            f"`{pkg}`: the summary reports no skips at all:\n{combined}"
        )


def test_the_shipped_guards_still_FAIL_on_their_own_introducing_branch(tmp_path):
    """TEST-11 — the positive control, without which the test above is meaningless.

    "The guards did not fail" passes vacuously if the guards no longer assert anything at
    all. So the SAME staged guards, on a branch that genuinely introduces `embedding` AND
    edits server src, must still FAIL — loudly, naming the offending path. This is the
    leg that would go red if self-limiting had been implemented as "always skip", as an
    allowlist, or as a deleted assertion.
    """
    # EVERY shipped guard gets its own control, not just the first one. Round-1 audit,
    # verified by mutation: with only `embedding` driven here, gutting `clustering`'s and
    # `differential-expression`'s assertion bodies to `for p in []` left all 15 self-tests
    # GREEN — the sibling test only asserts `returncode == 0`, which an empty guard
    # satisfies trivially. One control per guard is what makes "they skipped" mean
    # "they would otherwise have asserted".
    # TEST-2 [acceptance] [invariant: INV-3] — one control per guard, including the two the
    # old basename glob could not see. This is the leg that would go red if "self-limiting"
    # had been implemented as "always skip", as an allowlist, or as a deleted assertion.
    for pkg, name in _guard_targets():
        # Keyed on package AND module: membership is "any module that calls the gate", so a
        # package shipping two staged guards is reachable, and `tmp_path / pkg` would raise
        # `FileExistsError` on the second.
        root = _init_repo(tmp_path / f"{pkg}__{name}")
        _stage_real_guards(root)
        # The package must NOT exist on main for its introducing branch to be constructible.
        (root / "src-app/packages" / pkg / "manifest.yaml").unlink()
        _commit(root, f"the guard packages exist on main, except {pkg}")

        _branch(root, f"feat/{pkg}")
        _write(root, f"src-app/packages/{pkg}/manifest.yaml", f"id: {pkg}\n")
        _write(root, "src-app/server/src/modules/sneaky.rs", "// a core edit\n")
        _commit(root, f"introduce {pkg}, with a core edit")

        module = REPO / "src-app/packages" / pkg / "tests" / name
        r = _pytest_in(root, *[f"{pkg}/tests/{name}::{fn}"
                               for fn in _gated_test_names(module)])
        combined = r.stdout + r.stderr
        assert r.returncode != 0, (
            f"`{pkg}`'s guard passed on its OWN introducing branch despite a "
            f"src-app/server/src edit — self-limiting became self-disabling:\n{combined}"
        )
        # The exit code alone is NOT the control. A blind audit found that for
        # `spatial-import-xenium` it is non-zero regardless of whether the gate asserts
        # anything, because that guard's `test_the_sibling_suites_this_branch_moves_still_pass`
        # shells out to files the harness never stages. So the load-bearing leg is the
        # message, and it must name the path that was planted — not merely be a message.
        assert "server src changed" in combined or "unexpected non-package src-app change" in combined, (
            f"`{pkg}`'s guard failed, but not for the reason it exists for:\n{combined}"
        )
        assert "sneaky.rs" in combined, (
            f"`{pkg}`'s guard failed without naming the core file this branch planted, so "
            f"nothing here distinguishes the guard firing from the harness misfiring:\n"
            f"{combined}"
        )


# ── Round-1 audit: behaviour that shipped with NO coverage at all ───────────────────
#
# Each of these is a branch the module introduced or deliberately CHANGED, which nothing
# exercised. The `added_paths` one is the defect itself: a test here would have caught it.


def _orphan_repo(tmp_path: Path) -> Path:
    """A repo whose HEAD and `main` share no history — what a shallow CI clone or a
    force-pushed base looks like to `git diff A...B` (`fatal: no merge base`)."""
    root = _init_repo(tmp_path)
    _run(root, "git", "checkout", "-q", "--orphan", "unrelated")
    _write(root, "other.txt", "x\n")
    _commit(root, "unrelated root commit")
    return root


def test_a_broken_diff_FAILS_rather_than_skipping(tmp_path):
    """The F8 defect, pinned. `added_paths` must not swallow a git failure.

    Before the fix it returned [], which made `introduces_package` False, which made
    `require_introducing_branch` skip with a message asserting a premise it had never
    established — the one path where an infrastructure failure disabled the whole guard
    while looking exactly like the normal non-introducing case.
    """
    root = _orphan_repo(tmp_path)
    with pytest.raises(AssertionError, match="ADDED paths"):
        g.added_paths(root)
    with pytest.raises(AssertionError):
        g.changed_paths(root)


def test_no_resolvable_base_ref_RAISES_rather_than_skipping(tmp_path):
    """`base_ref` is the module's one deliberate strengthening over the copies it replaces
    (two of three used to skip here). It shipped untested."""
    root = tmp_path / "nobase"
    root.mkdir()
    _run(root, "git", "init", "-q", "-b", "somethingelse")
    _write(root, "f.txt", "x\n")
    _commit(root, "only commit")
    with pytest.raises(AssertionError, match="neither `origin/main` nor `main`"):
        g.base_ref(root)


def test_package_of_refuses_a_hidden_folder():
    """`_NON_PACKAGE_PREFIXES` has two entries; only `_` was exercised."""
    with pytest.raises(AssertionError):
        g.package_of(REPO / "src-app/packages/.hidden/tests/test_x.py")


def test_package_of_takes_the_RIGHTMOST_match(tmp_path):
    """A checkout living under a path that itself contains `src-app/packages` must not
    silently mis-scope every guard (the left-to-right scan resolved to the OUTER segment
    and produced a permanent silent skip)."""
    nested = tmp_path / "src-app" / "packages" / "checkout" / "src-app" / "packages"
    target = nested / "embedding-like" / "tests" / "test_zero_src_app_diff.py"
    target.parent.mkdir(parents=True)
    target.write_text("", encoding="utf-8")
    assert g.package_of(target) == "embedding-like"


def test_the_generated_client_artifacts_are_exempt_on_ANY_branch(tmp_path):
    """`infra_exempt`'s unconditional arm — only its False return was ever driven."""
    root = _init_repo(tmp_path)
    for artifact in sorted(g.GENERATED_CLIENT_ARTIFACTS):
        assert g.infra_exempt(artifact, root) is True, artifact
    assert g.infra_exempt("src-app/ui/src/modules/foo/Foo.tsx", root) is False


def test_the_80_exemption_arms_BOTH_its_arms_on_a_dependency_contract_branch(tmp_path):
    """`is_dependency_contract_branch` was tested; what the exemption then DOES was not —
    neither the enumeration arm nor the prefix arm had ever returned True."""
    root = _init_repo(tmp_path)
    _branch(root, "feat/dep-contract")
    _write(root, "src-app/env-rootfs/single-cell/requirements.txt", "numpy==1\n")
    _commit(root, "introduce the dependency contract")
    assert g.is_dependency_contract_branch(root) is True

    # the ENUMERATION arm
    for named in sorted(g.DEPENDENCY_CONTRACT_INFRA):
        assert g.infra_exempt(named, root) is True, named
    # the PREFIX arm
    for prefix in g.DEPENDENCY_CONTRACT_INFRA_PREFIXES:
        assert g.infra_exempt(f"{prefix}something/else.rs", root) is True, prefix
    # …and nothing beyond them: the exemption is an enumeration, not a licence.
    assert g.infra_exempt("src-app/server/src/modules/unrelated.rs", root) is False
    assert g.infra_exempt("src-app/ui/src/modules/foo/Foo.tsx", root) is False


# ── TEST-3..TEST-6 — `require_introducing_file`, the MARKER-keyed gate ──────────────
#
# Same premise as `require_introducing_branch`, keyed on a NAMED added path instead of the
# calling module's package manifest. It exists because not every branch-diff proof is about
# a package being introduced: #163 introduced a PRODUCER inside a package #162 had already
# landed, so a manifest-keyed gate would have skipped on the one branch its guards describe
# — self-limiting becoming self-disabling, which is a worse defect than the unscoped guard
# it replaces. Every leg below is one the manifest-keyed sibling already has; none is new
# behaviour, and that is the point — the two gates must not disagree about their premise.

_MARKER = "src-app/packages/existing/compute/producer.py"


def test_the_marker_keyed_gate_SKIPS_when_the_marker_is_not_added(tmp_path, monkeypatch):
    """TEST-3 — the negative arm, with the reason NAMED.

    A skip is a skip and never a pass, so the reason string is asserted rather than just the
    control flow: a guard that quietly returns is the vacuous-green failure of
    `derived-guards.md` §1 wearing a different costume.
    """
    root = _init_repo(tmp_path)
    _write(root, _MARKER, "x = 1\n")
    _commit(root, "the producer already exists on main")

    _branch(root, "feat/unrelated")
    _write(root, "src-app/packages/existing/compute/producer.py", "x = 2\n")
    _write(root, "src-app/server/src/modules/whatever.rs", "// unrelated\n")
    _commit(root, "a later branch edits it")

    # `repo_root()` resolves the checkout from the PROCESS's cwd, exactly as it does for a
    # real guard module, so the synthetic repo has to be the cwd or this would silently
    # interrogate THIS checkout and answer a question about the wrong branch.
    monkeypatch.chdir(root)
    with pytest.raises(pytest.skip.Exception, match=re.escape(_MARKER)):
        g.require_introducing_file(_MARKER, __file__)


def test_the_marker_keyed_gate_ARMS_and_returns_the_branch_diff(tmp_path, monkeypatch):
    """TEST-4 — the positive arm: on the branch that ADDS the marker it hands back the diff.

    The returned `changed` must contain the branch's OTHER edits, not just the marker —
    otherwise a caller's assertions would range over an empty set and pass vacuously, which
    is the shape this whole module exists to refuse.
    """
    root = _init_repo(tmp_path)
    _branch(root, "feat/introduce-the-producer")
    _write(root, _MARKER, "x = 1\n")
    _write(root, "src-app/server/src/modules/sneaky.rs", "// a core edit\n")
    _commit(root, "introduce the producer, with a core edit")

    monkeypatch.chdir(root)
    got_root, changed = g.require_introducing_file(_MARKER, __file__)
    assert got_root.resolve() == root.resolve()
    assert _MARKER in changed
    assert "src-app/server/src/modules/sneaky.rs" in changed, (
        "the gate armed but handed back a diff missing the branch's core edit — a caller "
        "asserting over that set would report green having examined nothing"
    )


def test_MODIFYING_the_marker_is_not_INTRODUCING_it(tmp_path, monkeypatch):
    """TEST-5 — add-only, the same distinction `introduces_package` makes one level up.

    Keying on "the diff touches the marker" would re-arm the guard on every routine edit to
    the producer — the single most likely future change to that file — and the false red
    would be back on a branch whose premise does not hold. `--diff-filter=A` happens exactly
    once in a path's history.
    """
    root = _init_repo(tmp_path)
    _write(root, _MARKER, "x = 1\n")
    _commit(root, "the producer already exists on main")

    _branch(root, "fix/edit-the-producer")
    _write(root, _MARKER, "x = 1  # a fix\n")
    _commit(root, "modify it")

    monkeypatch.chdir(root)
    with pytest.raises(pytest.skip.Exception):
        g.require_introducing_file(_MARKER, __file__)


def test_the_marker_keyed_gate_FAILS_rather_than_skipping_on_a_broken_diff(tmp_path, monkeypatch):
    """TEST-6 — the F8 defect, asserted at the new entry point.

    "I could not read the diff" must never become a silent stand-down: on a shallow clone or
    a force-pushed base (`fatal: no merge base`) an empty ADDED set is indistinguishable from
    the normal non-introducing case, and the guard would skip with a message stating a
    premise it never established. `added_paths` asserts; this proves the assertion survives
    the composition rather than being swallowed by it.

    A bare `pytest.raises(AssertionError)` could NOT prove that, and a blind audit showed
    why: if the composition does swallow the failure, `require_introducing_file` raises
    `Skipped`, which escapes `pytest.raises` and pytest reports this test as SKIPPED at exit
    0. The test could not go red for its own subject. `Skipped` is therefore caught
    explicitly and converted into a failure — a skip here is the defect, not an outcome.
    """
    root = _orphan_repo(tmp_path)
    monkeypatch.chdir(root)
    try:
        g.require_introducing_file(_MARKER, __file__)
    except pytest.skip.Exception as skipped:  # noqa: F841
        pytest.fail(
            "`require_introducing_file` SKIPPED on a repository with no merge base. That is "
            "the F8 defect: an infrastructure failure standing the guard down while looking "
            "exactly like the ordinary non-introducing case. It must raise."
        )
    except AssertionError as exc:
        assert "ADDED paths" in str(exc), (
            f"it raised, but not about the undecidable diff: {exc}")
    else:
        pytest.fail("`require_introducing_file` returned normally on a broken diff")


def test_a_caller_supplied_reason_reaches_the_skip_message(tmp_path, monkeypatch):
    """TEST-15 — folding an open-coded gate in must not discard what that copy SAID.

    `_helpers/tests/test_visium_chain_zero_src_app.py` open-coded this gate and its skip
    named the invariant (INV-7) the assertion belongs to. The first cut of the delegation
    replaced that with the generic wording and a blind audit caught the loss: a reader of a
    `-rs` summary no longer learned which claim had stood down. A de-duplication that changes
    what the tree tells you is a regression dressed as tidying, so the caller's own sentence
    is passed through — and pinned here, because prose that nothing asserts drifts.
    """
    root = _init_repo(tmp_path)
    _write(root, _MARKER, "x = 1\n")
    _commit(root, "the producer already exists on main")
    _branch(root, "feat/unrelated")
    _write(root, "README.md", "unrelated\n")
    _commit(root, "an unrelated branch")

    monkeypatch.chdir(root)
    with pytest.raises(pytest.skip.Exception) as excinfo:
        g.require_introducing_file(_MARKER, __file__, reason="INV-7 is the claim here.")
    message = str(excinfo.value)
    assert "INV-7 is the claim here." in message, (
        f"the caller's reason did not reach the skip message: {message}")
    assert _MARKER in message, "the marker must still be named alongside the caller's reason"


# ── TEST-9 — the marker-keyed gate driven as a real guard MODULE, both ways ─────────
#
# TEST-1/TEST-2 do this for the manifest-keyed guards by staging the SHIPPED modules. The
# two marker-keyed guards in the tree cannot be staged that way: `test_boundaries_long_table.py`
# needs numpy, yaml, the shipped encoder and the real vendor fixtures, and
# `test_visium_chain_zero_src_app.py` reads the committed visium bundle. Staging a cut-down
# copy of them would prove things about the copy. So the SUBJECT here is the gate as a module
# uses it — the one thing those two files have in common and the one thing this change moved.

_MARKER_KEYED_GUARD = '''\
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from zero_core_guard import require_introducing_file

MARKER = "src-app/packages/existing/compute/producer.py"


def test_no_core_change_rode_in_with_the_producer():
    _root, changed = require_introducing_file(MARKER, __file__)
    core = sorted(p for p in changed if p.startswith("src-app/server/src/"))
    assert core == [], f"server src changed: {core}"
'''


def _stage_marker_keyed_guard(root: Path) -> str:
    """The synthetic guard + the REAL helper, in a synthetic packages tree."""
    lib_dst = root / "src-app/packages/_lib"
    lib_dst.mkdir(parents=True, exist_ok=True)
    (lib_dst / "zero_core_guard.py").write_text(
        (_LIB / "zero_core_guard.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (lib_dst / "manifest.yaml").write_text("id: _lib\ncontributes: {}\n", encoding="utf-8")
    rel = "existing/tests/test_marker_keyed_guard.py"
    _write(root, f"src-app/packages/{rel}", _MARKER_KEYED_GUARD)
    _write(root, "src-app/packages/pytest.ini", "[pytest]\n")
    return rel


def test_a_marker_keyed_guard_module_SKIPS_on_a_branch_that_does_not_add_its_marker(tmp_path):
    """TEST-9 [acceptance] [invariant: INV-2] — the negative control, end to end."""
    root = _init_repo(tmp_path)
    rel = _stage_marker_keyed_guard(root)
    _write(root, _MARKER, "x = 1\n")
    _commit(root, "the producer and the guard exist on main")

    _branch(root, "feat/somebody-elses-work")
    _write(root, "src-app/server/src/modules/theirs.rs", "// their core edit\n")
    _commit(root, "an unrelated branch touches core")

    r = _pytest_in(root, rel)
    combined = r.stdout + r.stderr
    assert r.returncode == 0, (
        f"a marker-keyed guard FAILED on a branch that did not introduce its marker — this "
        f"is the defect, one level down from the package case:\n{combined}"
    )
    assert "skipped" in combined, f"expected a VISIBLE skip, got:\n{combined}"
    assert "not the branch that introduces" in combined and _MARKER in combined, (
        f"the guard did not report WHY it skipped:\n{combined}"
    )


def test_a_marker_keyed_guard_module_still_FAILS_on_the_branch_that_adds_its_marker(tmp_path):
    """TEST-9 [acceptance] [invariant: INV-2] — the positive control.

    Without this, the test above passes just as happily against a gate rewritten to `always
    skip`, an allowlist, or a deleted assertion — the three things `derived-guards.md` §5
    names as NOT the repair.
    """
    root = _init_repo(tmp_path)
    rel = _stage_marker_keyed_guard(root)
    _commit(root, "the guard exists on main; the producer does not")

    _branch(root, "feat/introduce-the-producer")
    _write(root, _MARKER, "x = 1\n")
    _write(root, "src-app/server/src/modules/sneaky.rs", "// a core edit\n")
    _commit(root, "introduce the producer, with a core edit")

    r = _pytest_in(root, rel)
    combined = r.stdout + r.stderr
    assert r.returncode != 0, (
        f"the guard PASSED on its own introducing branch despite a `src-app/server/src` "
        f"edit — self-limiting became self-disabling:\n{combined}"
    )
    assert "server src changed" in combined, (
        f"it failed, but not for the reason it exists for:\n{combined}"
    )


# ── TEST-7 — THE SWEEP: no package test may read git history without a gate ─────────

#: The git subcommands that read HISTORY (as opposed to the working tree or the index).
#: A test that reaches for one of these is asking a question about a COMMIT RANGE, which is
#: a question about somebody's branch — and therefore a question that has to be scoped to
#: the branch that can answer it (`derived-guards.md` §3). `rev-parse`, `status`, `ls-files`
#: and `init` are deliberately absent: they read the tree or resolve a ref, not a range.
_HISTORY_READING_GIT_VERBS = (
    "diff", "merge-base", "show", "cat-file", "log", "rev-list",
    # Added after a blind audit named them as latent gaps: each reads history, none is used
    # by any module in the tree today, and a detector that waits for the first use to be
    # written is a detector that misses it.
    "ls-tree", "blame", "describe", "archive",
)

#: The two gates a history-reading test module must route through.
_SCOPE_GATES = ("require_introducing_branch", "require_introducing_file")

#: The functions in `zero_core_guard` that a caller can reach the branch diff through —
#: DERIVED from that module's own call graph, never listed.
#:
#: A blind audit found the hand-written version incomplete in a way that mattered:
#: `introduces_package`, `is_dependency_contract_branch` and `infra_exempt` all reach the
#: diff and were all absent, so a module written as
#: `root = repo_root(); assert introduces_package(root, "mine")` was unscoped and invisible.
#: That is INV-1 broken inside the INV-1 test file — with the declaration to derive from
#: (`zero_core_guard`'s own source) sitting in the same package. So it is derived: anything
#: that transitively reaches `added_paths` / `changed_paths` / `diff_point` reads history.
#:
#: The two GATES are removed from the result on purpose: reaching the diff THROUGH a gate is
#: the remedy, not the offence.
_DIFF_ROOTS = ("added_paths", "changed_paths", "diff_point")

#: `_git` is the actual boundary — the function that RUNS git. It does not reach the three
#: roots above (they reach IT), so the derivation cannot find it, and a caller that reaches
#: past the public API (`g._git(root, "diff", "--name-only", "origin/main...HEAD")`) was
#: invisible to both detectors. A blind audit planted exactly that as a real unscoped guard.
#: Named rather than derived, because rooting the derivation at `_git` would sweep in
#: `repo_root` and `base_ref` — which run `rev-parse`, not history — and every guard in the
#: tree calls `repo_root`.
_PRIVATE_GIT_RUNNER = "_git"


def _call_graph(source: str) -> dict[str, set[str]]:
    """`{function name: names it calls}` for the top-level functions of `source`.

    Only what a function calls DIRECTLY; :func:`_reaches` closes it transitively. Nested
    functions are attributed to their enclosing top-level function, which is what a caller
    of that function actually gets.
    """
    graph: dict[str, set[str]] = {}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            graph[node.name] = _called_names(ast.unparse(node))
    return graph


def _reaches(graph: dict[str, set[str]], start: str, targets: set[str]) -> bool:
    """Does `start` reach any of `targets` through `graph`? Cycle-safe."""
    seen: set[str] = set()
    stack = [start]
    while stack:
        name = stack.pop()
        if name in targets:
            return True
        if name in seen:
            continue
        seen.add(name)
        stack.extend(graph.get(name, ()))
    return False


def _history_reading_helpers() -> tuple[str, ...]:
    """`zero_core_guard`'s history-reading surface, derived from its own call graph."""
    source = (_LIB / "zero_core_guard.py").read_text(encoding="utf-8")
    graph = _call_graph(source)
    roots = set(_DIFF_ROOTS)
    reaching = {name for name in graph if name in roots or _reaches(graph, name, roots)}
    return tuple(sorted((reaching | {_PRIVATE_GIT_RUNNER}) - set(_SCOPE_GATES)))


_HISTORY_READING_HELPERS = _history_reading_helpers()

#: Modules that read git history and are self-limiting by a DIFFERENT, stated mechanism.
#: An ENUMERATION with a reason each, never a prefix — a prefix would pardon every future
#: file beside them (`derived-guards.md` §5). Each entry answers one question: what stops
#: this module going red on a branch that has nothing to do with it?
_SWEEP_EXCEPTIONS = {
    # Pinned to a FIXED commit (`BASE_REF = "f202f2dd"`) rather than to a moving base, and
    # its subject is `doublet`'s OWN frozen surface — so today it cannot fire on a branch
    # that leaves those four files alone.
    #
    # STATED HONESTLY, because a blind audit corrected the first version of this comment:
    # this is NOT the same property as self-limiting. It compares the WORKING TREE against
    # that commit, so the day any branch lands an edit to one of the four frozen files on
    # `main`, the file is red on `main` and on every unrelated branch after it — the §1
    # falsely-red class, arriving later rather than never. It is exempted here because
    # repairing it is a different change with a different owner (it would have to decide
    # whether that surface is still frozen at all), not because it is safe forever.
    "doublet/tests/test_scrublet_lane_unchanged.py",
    # Self-limiting by IMPLICATION, as its own docstring states: *if* a package's tracked
    # files differ from `origin/main`, *then* its manifest version moved. On a branch that
    # touches nothing the premise is false and it passes; on a branch that does, it demands
    # exactly what `scripts/check-processor-seed-versions.sh` demands anyway. Verified
    # against that module's own text, not assumed.
    "spatial-types/tests/test_ome_dtype_refusal.py",
    # ONE TEST, not the module — `<path>::<test>` narrows the pardon to the function that
    # earns it, so the rest of that module stays swept. Self-limiting by the same implication
    # as the entry above: it reads the changed set only to ask whether THIS branch touched
    # `_helpers` at all, skips visibly when it did not, and otherwise demands exactly the
    # version bump `check-processor-seed-versions.sh` demands. It cannot redden a branch that
    # leaves the package alone, which is the property the sweep exists to require.
    "_helpers/tests/test_visium_chain_zero_src_app.py::test_the_helpers_package_version_moved_forward",
    # ONE TEST, not the module — the same `<path>::<test>` narrowness as the `_helpers` entry
    # above, and for the same stated mechanism. It asks, per shipped `ome_writer.py` vendor,
    # whether THIS branch touched that package at all and `continue`s when it did not, so a
    # branch that leaves `spatial-import-visium`, `spatial-import-xenium` and `spatial-types`
    # alone cannot redden it; a branch that touches one is asked for exactly the version bump
    # `scripts/check-processor-seed-versions.sh` asks of it anyway.
    #
    # RECORDED, because this entry replaces a WRONG repair rather than an ungated guard: it was
    # briefly put behind `require_introducing_file` keyed on its own module path. That path has
    # been on `origin/main` since `6fa8126f`, so `--diff-filter=A` can never match it again and
    # the gate skipped on every branch that could ever be cut — self-limiting becoming
    # SELF-DISABLING, which `require_introducing_file`'s own docstring names as strictly worse
    # than the unscoped guard. The exception keeps the implication LIVE for the next branch that
    # edits a vendored writer, which is the whole point of it.
    "spatial-types/tests/test_wire_measurement_strip_count.py::test_the_changed_packages_also_moved_their_manifest_version",
    # ONE TEST, not the module. Pinned to a FIXED commit (`c34b3a1f`) compared to FIXED constants,
    # so no branch's own diff is its subject — the same shape as the `doublet` entry above. It can
    # redden only a branch that changes `compute/import_visium.py` (its second half requires the
    # branch side to still measure ZERO unprovable interpolations) or `refusal_sites.py` (the
    # guard that decides what these numbers mean). Both reds land on the branch that caused them
    # and the message says what to do; a branch that touches neither cannot redden it.
    #
    # STATED HONESTLY, like the `doublet` entry whose note was corrected for the same reason: a
    # fixed-SHA read is not self-limiting in general. The residue is a shallow clone, where the
    # base commit is unreachable and this fails everywhere. That is deliberate — the alternative
    # is a silent stand-down of the one thing asserting a number that had already gone stale
    # TWICE while it lived in prose.
    #
    # RECORDED for the same reason as the entry above: this replaces a gate keyed on
    # `refusal_sites.py`, which has been on `origin/main` since `aeeea949` and could therefore
    # never arm again.
    "spatial-import-visium/tests/test_refusal_escaping.py::test_TEST_22_the_BASE_measurement_this_branch_claims_is_re_derived_from_git",
    # Its subject is a THROWAWAY repository it builds in `tmp_path`, not this branch: it
    # drives the byte comparison directly — unchanged file passes, moved file fails, deleted
    # file fails — because the gated test that uses that comparison keys on a marker already
    # on `origin/main` and can therefore never arm. Asserting nothing about any branch is
    # precisely why it needs no branch gate, and it is the behavioural proof that the gated
    # assertion body is real (#274/#286).
    "differential-abundance/tests/test_rootfs_unchanged.py::test_the_byte_comparison_really_FAILS_when_the_file_moved",
}

#: Fail-closed floor for the scan set (`derived-guards.md` §2). The tree holds a few hundred
#: package test modules; the floor is far below that so adding or removing suites never edits
#: it, and far above zero so a glob that stops resolving FAILS instead of reporting a clean
#: sweep of nothing — the `MIN_PACKAGES` shape from
#: `scripts/check-processor-seed-versions.sh`. Deliberately not written as an exact count:
#: two comments in this file already went stale that way inside one change.
_MIN_PACKAGE_TEST_MODULES = 100


def _history_reads(source: str) -> set[str]:
    """Everything in `source` that reads git HISTORY, read from its AST.

    Two forms, because the tree spells it two ways and a detector that knows only one
    forbids only the shape nobody writes any more:

    * a list/tuple literal whose first element is `"git"` and which names a history verb —
      the raw `subprocess.run(["git", "diff", ...])` shape the migrated guards used to have;
    * a CALL to one of `zero_core_guard`'s own history-reading helpers — the shape they
      have now.

    An AST walk rather than a regex over the text, for the reason
    `test_the_guard_module_spells_no_shipped_package_name` already learned the hard way: a
    text scan cannot tell an invocation from a docstring explaining one, and every module
    here explains itself at length.
    """
    reads = {f"git {verb}" for verb in _git_literal_history_verbs(source)}
    for name in _called_names(source):
        if name in _HISTORY_READING_HELPERS:
            reads.add(f"zero_core_guard.{name}()")
    return reads


def _git_literal_history_verbs(source: str) -> set[str]:
    """History verbs named inside a `["git", ...]` argument literal in `source`."""
    verbs: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.List, ast.Tuple)) or not node.elts:
            continue
        first = node.elts[0]
        if not (isinstance(first, ast.Constant) and first.value == "git"):
            continue
        for inner in ast.walk(node):
            if isinstance(inner, ast.Constant) and inner.value in _HISTORY_READING_GIT_VERBS:
                verbs.add(inner.value)
    return verbs


def _functions_reading_history_without_a_gate(source: str) -> list[str]:
    """Top-level functions that reach the branch diff without reaching a scope gate.

    Module-level code that reads history is attributed to `<module scope>`, so a read
    outside any function cannot hide.
    """
    graph = _call_graph(source)
    history = set(_HISTORY_READING_HELPERS) | {"__git_literal__"}
    # A `["git", <history verb>, ...]` literal is not a call, so it is injected into the
    # graph as a pseudo-callee of whatever function contains it.
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if _git_literal_history_verbs(ast.unparse(node)):
                graph.setdefault(node.name, set()).add("__git_literal__")

    # Only the ENTRY POINTS are offenders. A private helper that reads history is not itself
    # a defect — `_armed()`, `_changed()` and `_assert_unchanged_since_merge_base` all do,
    # legitimately — because what matters is whether the TEST that reaches the diff also
    # reaches the gate. The graph carries a helper's reads up to its callers, so flagging
    # helpers as well only produces false positives on correctly gated modules.
    offenders = []
    for name in sorted(graph):
        if not name.startswith("test_"):
            continue
        if not _reaches(graph, name, history):
            continue
        if _reaches(graph, name, set(_SCOPE_GATES)):
            continue
        offenders.append(name)

    module_level = ast.parse(source)
    top_calls: set[str] = set()
    for node in module_level.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        top_calls |= _called_names(ast.unparse(node))
        if _git_literal_history_verbs(ast.unparse(node)):
            top_calls.add("__git_literal__")
    if top_calls & history and not (top_calls & set(_SCOPE_GATES)):
        offenders.append("<module scope>")
    return offenders


def test_no_package_test_reads_a_branch_diff_without_a_scope_gate():
    """TEST-7 [acceptance] [invariant: INV-1] — the sweep, as a test rather than as prose.

    #265 and #282 both end by asking for exactly this: *"a repo-wide check for `git diff
    origin/main` inside a test that is not gated by `require_introducing_branch` would find
    #238, these two, and any others."* Filed as prose, that sweep gets done once. As a test
    it is done on every run, and — the part that matters — a FOURTH unscoped copy cannot be
    written. Five issues were filed against three copies of one defect over several months;
    the mechanism that stops the sixth is this, not another issue.

    ## What it asserts, exactly

    For every module under `src-app/packages/<pkg>/tests/`, if it invokes a git subcommand
    that reads HISTORY, it must also name one of the two scope gates. The set of modules is
    derived from the tree with a fail-closed floor; the exceptions are enumerated with the
    stated mechanism that makes each one self-limiting by other means.

    ## Its honest limit, MEASURED rather than guessed at

    This is a FLOOR, not a ceiling, and its evasion space is real and known. A blind audit
    demonstrated every one of these passing while fully unscoped:

        subprocess.run("git diff --name-only origin/main...", shell=True)
        CMD = "git diff --name-only".split(); subprocess.run(CMD)
        subprocess.run(["git"] + ["diff", "--name-only"])
        V = "diff"; subprocess.run(["git", V, "--name-only"])
        os.popen("git diff --name-only")
        from zero_core_guard import changed_paths as _cp   # then `_cp(root)`

        class TestUnscoped:                      # a CLASS-based guard, or a class body:
            def test_x(self): changed_paths(repo_root())

    (`_call_graph` walks top-level `def`s only. `g._git(root, "diff", …)` — reaching past the
    public API to the private runner — WAS in this list and is now closed, because closing it
    was one name in a DERIVED set rather than a new predicate.)

    They are NOT being closed one by one, and that is a decision rather than an oversight.
    This repo's own guard-substitution rule says the remedy for a round spent adding
    predicates to a syntactic guard is never another predicate — it is to assert the
    BEHAVIOUR the guard was standing in for. That is
    `test_every_migrated_guard_still_FAILS_when_its_premise_HOLDS`, which executes each real
    guard against a diff it must refuse and does not care how the guard spells `git`.

    What this sweep still buys, and why it stays: it catches the case that actually happened
    five times. Every unscoped copy in this tree was written by somebody who did not know
    the gate existed, in the obvious spelling, and this refuses that at review time rather
    than six branches later. It found the FOURTH open-coded copy
    (`differential-expression`'s advanced-contrast gate) on its first run.
    """
    tests_root = REPO / "src-app" / "packages"
    # `**`, not one level: a one-level pattern would stop seeing a suite the day someone
    # organises it into `<pkg>/tests/<area>/`, and the floor could not tell that from a
    # smaller tree. There IS one nested module today
    # (`spatial-import-xenium/tests/fixtures/boundaries/build_boundaries_fixtures.py`, a
    # fixture generator that reads no history), so the widening is not hypothetical — an
    # earlier comment here claimed there were none, which a blind audit measured as false.
    modules = sorted(tests_root.glob("*/tests/**/*.py"))
    assert len(modules) >= _MIN_PACKAGE_TEST_MODULES, (
        f"found {len(modules)} package test modules, below the floor of "
        f"{_MIN_PACKAGE_TEST_MODULES}. The layout this scan derives from no longer resolves, "
        f"so this guard was about to report a clean sweep having examined almost nothing."
    )

    offenders = []
    for module in modules:
        rel = module.relative_to(tests_root).as_posix()
        if rel in _SWEEP_EXCEPTIONS:
            continue
        source = module.read_text(encoding="utf-8")
        reads = _history_reads(source)
        if not reads:
            continue
        # FUNCTION-scoped, not file-scoped. Two successive weakenings were found here by
        # blind audit and both are closed by this: a raw substring scan was defeated by ONE
        # COMMENT mentioning the gate, and its AST-call replacement was defeated by ONE DEAD
        # FUNCTION containing a call nothing invokes. What has to be true is narrower and is
        # what the sweep actually means: the function that reads history must itself reach a
        # gate, transitively, inside this module — which is how `_armed()` legitimately
        # gates the tests that call it.
        ungated = _functions_reading_history_without_a_gate(source)
        if not ungated:
            continue
        ungated = [u for u in ungated if f"{rel}::{u}" not in _SWEEP_EXCEPTIONS]
        if not ungated:
            continue
        offenders.append(
            f"{rel} — {', '.join(ungated)} read history ({', '.join(sorted(reads))}) "
            f"without reaching a scope gate")

    assert offenders == [], (
        "these package test modules read git HISTORY without routing through a scope gate:\n"
        + "\n".join(f"  - {o}" for o in offenders)
        + "\n\nA question about a commit range is a question about somebody's BRANCH, and on "
        "`main` that branch is whoever happens to be running the suite — so the assertion is "
        "vacuously true here and false on every later branch (`derived-guards.md` §3). Route "
        "it through `zero_core_guard.require_introducing_branch` (keyed on this package's own "
        "manifest being ADDED) or `require_introducing_file` (keyed on a named added path). "
        "Do NOT widen an allowlist, add a prefix exemption, or delete the assertion — §5 "
        "names all three as not the repair. If the module is self-limiting by some OTHER "
        "stated mechanism, add it to `_SWEEP_EXCEPTIONS` with that mechanism written down."
    )


def test_every_sweep_exception_still_exists_and_still_reads_history():
    """TEST-7 — `_SWEEP_EXCEPTIONS` asserted in BOTH directions.

    An exemption nothing checks is a permission the next module inherits unreviewed, and
    this repo already applies that rule to its sanctioned path sets
    (`test_every_named_exemption_is_actually_touched`). It was missing here: a blind audit
    added two paths that name nothing at all — one to a package that does not exist — and
    the whole suite stayed green, which means the set could rot into a general amnesty
    without anything noticing.

    So each entry must still (a) exist and (b) still read git history. An entry that no
    longer reads history is not an exception any more; it is a pardon for nothing, and
    leaving it there pardons whatever is written at that path next.
    """
    packages_root = REPO / "src-app" / "packages"
    for entry in sorted(_SWEEP_EXCEPTIONS):
        rel, _, func = entry.partition("::")
        path = packages_root / rel
        assert path.is_file(), (
            f"`{entry}` is exempt from the branch-diff sweep but does not exist. Remove the "
            f"entry: a pardon for a path nothing occupies is inherited by whatever is "
            f"written there next."
        )
        source = path.read_text(encoding="utf-8")
        assert _history_reads(source), (
            f"`{entry}` is exempt from the branch-diff sweep but no longer reads git "
            f"history, so the exemption describes nothing. Remove it."
        )
        if func:
            assert f"def {func}(" in source, (
                f"`{entry}` pardons a test `{rel}` does not define — it was renamed or "
                f"deleted, and the pardon now applies to nothing while still reading as a "
                f"reviewed decision.")
            assert func in _functions_reading_history_without_a_gate(source), (
                f"`{entry}` pardons `{func}` for reading history without a gate, but that "
                f"function no longer does. Remove the entry rather than leaving a standing "
                f"permission the next edit inherits.")


def test_the_sweep_would_actually_catch_an_unscoped_guard(tmp_path):
    """TEST-7's positive control — the detector is not vacuous.

    `test_no_package_test_reads_a_branch_diff_without_a_scope_gate` is green on a clean tree
    by construction, and a detector that matched nothing would be green there too. So the
    detector itself is driven against the shape it exists to catch: the exact plumbing the
    doublet and differential-abundance guards carried before this change.
    """
    # (a) the OLD shape — a raw `git diff` literal, which is what all three migrated
    #     guards carried before this change.
    unscoped_raw = (
        "import subprocess\n"
        "def _changed(root):\n"
        "    return subprocess.run(\n"
        '        ["git", "diff", "--name-only", "origin/main...HEAD"],\n'
        "        cwd=root, capture_output=True, text=True).stdout.splitlines()\n"
        "def test_only_my_package_changed():\n"
        "    assert _changed('.') == []\n"
    )
    assert _history_reads(unscoped_raw) == {"git diff"}, (
        "the detector does not see a plain `git diff --name-only` call — it would have "
        "missed all three of the guards this change migrated"
    )
    assert not (set(_SCOPE_GATES) & _called_names(unscoped_raw))

    # (b) the NEW shape — the same unscoped guard written the way this change teaches the
    #     tree to write it. A blind audit built exactly this and the first cut of the sweep
    #     reported 30 passed: the detector forbade only the spelling nobody uses any more.
    unscoped_via_helper = (
        "from zero_core_guard import changed_paths, repo_root\n"
        "def test_only_my_package_changed():\n"
        "    root = repo_root()\n"
        "    for p in changed_paths(root):\n"
        "        assert p.startswith('src-app/packages/mine/')\n"
    )
    assert _history_reads(unscoped_via_helper) == {
        "zero_core_guard.changed_paths()"
    }, "the detector is blind to the helper idiom this very change promotes"
    assert not (set(_SCOPE_GATES) & _called_names(unscoped_via_helper))

    # (c) NAMING the gate is not APPLYING it. One comment line was enough to defeat the
    #     substring form of this check, which is why the gate half is an AST call check.
    prose_only = unscoped_raw.replace(
        "import subprocess\n",
        "import subprocess\n"
        "# Scoping is discussed in zero_core_guard.require_introducing_branch; not used here.\n",
    )
    assert not (set(_SCOPE_GATES) & _called_names(prose_only)), (
        "a module that merely MENTIONS the gate in a comment is being counted as gated — "
        "that is the substring evasion, and it lets the original defect straight through"
    )

    # (d) a genuinely gated module is recognised, or the sweep would be a blanket ban.
    gated = unscoped_raw.replace(
        "def test_only_my_package_changed():\n    assert _changed('.') == []\n",
        "from zero_core_guard import require_introducing_branch\n"
        "def test_only_my_package_changed():\n"
        "    require_introducing_branch(__file__)\n"
        "    assert _changed('.') == []\n",
    )
    assert set(_SCOPE_GATES) & _called_names(gated)

    # (e) it must not fire on the git calls that read the TREE rather than a commit range,
    #     or every module in the tree would be an offender and the sweep would be noise.
    tree_only = (
        "import subprocess\n"
        'subprocess.run(["git", "rev-parse", "--show-toplevel"])\n'
        'subprocess.run(["git", "status", "--porcelain"])\n'
        'subprocess.run(["git", "ls-files", "-z"])\n'
    )
    assert _history_reads(tree_only) == set()


# ══ THE BEHAVIOURAL HARNESS — what replaces adding another predicate ════════════════
#
# Two blind audits reached the same conclusion from opposite directions, and the second
# round tripped this repo's own GUARD-SUBSTITUTION tripwire: 65.9% of the previous round's
# insertions landed on THIS file. The rule for that outcome is explicit — the remedy is
# never another predicate; replace the syntactic guard with a test that asserts the
# BEHAVIOUR it was standing in for.
#
# The behaviour being stood in for is `derived-guards.md` §6 INV-4: *"a self-limiting guard
# still fails loudly on the branch where its premise does hold."* Every guard this change
# migrated keys on a marker that ALREADY EXISTS on `origin/main`, so `--diff-filter=A` can
# never contain it again and the arming branch is not constructible from main. Both
# auditors then showed, by mutation, that each of those assertion BODIES could be replaced
# with a no-op and the whole suite stayed green. Subject-and-predicate controls did not
# close it: they pin the SUBJECT LIST, not the assertion.
#
# So the premise is supplied directly instead of being constructed. `added_paths` is the
# ONLY thing standing between a guard and its assertions, and it is a boundary (git). With
# it forced to "everything was added", every gate arms; with `changed_paths` forced to a
# planted diff, the real assertion body runs against a diff it must refuse. That is the
# guard's actual behaviour, executed, on the real module — not a proxy for it.


class _EverythingWasAdded(list):
    """A changed/added list that reports ANY path as present.

    This is what makes every gate arm without knowing any guard's marker. Deriving each
    marker instead would mean re-deriving, here, the thing each module already decides for
    itself — and getting it wrong would silently arm nothing while looking identical to
    arming everything, which is the failure mode this whole module exists to remove.
    """

    def __contains__(self, item):  # noqa: D105
        return True


#: How a case says "plant one path per entry of the guard's own constant". A blind audit
#: showed one plant per case proves exactly ONE ARM: deleting four of `differential-abundance`'s
#: five `FORBIDDEN_PREFIXES`, or emptying `_helpers`' entire forbidden list, left the whole
#: suite green because the single planted path still tripped what remained. Deriving the plants
#: from the constant the guard itself ranges over makes the coverage follow the guard instead of
#: following a hand-typed list — and shrinking that constant then removes plants, which the
#: `expected_at_least` floor refuses.
class _PerEntryOf:
    """Plant one path per entry of `constant`, formed by `template.format(entry)`."""

    def __init__(self, constant: str, template: str = "{}stranger.txt",
                 expected_at_least: int = 1):
        self.constant = constant
        self.template = template
        self.expected_at_least = expected_at_least

    def plants(self, module) -> list[str]:
        entries = getattr(module, self.constant)
        out = [self.template.format(e) for e in entries]
        assert len(out) >= self.expected_at_least, (
            f"`{self.constant}` holds {len(out)} entr(y|ies), below the floor of "
            f"{self.expected_at_least}. The guard's own subject shrank, so this case now "
            f"proves less than it did — which is the shape a blind audit exploited.")
        return out


#: The guards THIS CHANGE migrated, each with a planted diff its assertion must refuse.
#: A behavioural CASE TABLE, which `derived-guards.md` §4 keeps on purpose: *"Behavioural
#: case tables are not enumerations of the set; they are enumerated cases over it."* The
#: set of guards is derived elsewhere (`_shipped_zero_diff_guards`, the sweep); this names
#: the cases, because "what diff must this particular assertion refuse" is not derivable
#: from the assertion — that is the whole point of asserting it.
#:
#: Both directions are checked by `test_the_migrated_guard_case_table_is_not_stale`: every
#: entry must name a module and a test that exist.
_MIGRATED_GUARD_CASES = [
    ("doublet/tests/test_doublet_zero_src_app_diff.py",
     "test_no_src_app_ui_or_server_src_changes",
     # BOTH arms. A blind audit neutered the `src-app/ui/` arm alone and the suite stayed
     # green, because the server-src plant still tripped the other one.
     ["src-app/server/src/modules/sneaky.rs", "src-app/ui/src/modules/stranger.ts"]),
    ("doublet/tests/test_doublet_zero_src_app_diff.py",
     "test_only_doublet_package_and_the_sanctioned_data_files_changed",
     ["src-app/packages/qc/manifest.yaml"]),
    ("differential-abundance/tests/test_da_zero_src_app_diff.py",
     "test_the_only_non_package_src_app_changes_are_the_sanctioned_two",
     ["src-app/packages/qc/manifest.yaml"]),
    ("differential-abundance/tests/test_da_zero_src_app_diff.py",
     "test_the_forbidden_surfaces_are_untouched",
     _PerEntryOf("FORBIDDEN_PREFIXES", expected_at_least=5)),
    ("differential-abundance/tests/test_da_zero_src_app_diff.py",
     "test_the_package_adds_no_render_source",
     ["src-app/packages/differential-abundance/ui/Widget.tsx"]),
    ("differential-abundance/tests/test_da_zero_src_app_diff.py",
     "test_da_result_joins_the_lattice_with_NO_core_edit_at_all",
     ["src-app/server/src/modules/sneaky.rs"]),
    ("spatial-import-xenium/tests/test_boundaries_long_table.py",
     "test_the_encoding_needed_no_framework_edit",
     _PerEntryOf("FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH", template="{}",
                 expected_at_least=4)),
    ("spatial-import-xenium/tests/test_boundaries_long_table.py",
     "test_the_landed_declaration_was_not_moved_to_fit_the_producer",
     ["src-app/packages/spatial-types/manifest.yaml"]),
    ("_helpers/tests/test_visium_chain_zero_src_app.py",
     "test_no_src_app_path_outside_the_sanctioned_set_changed",
     ["src-app/packages/qc/manifest.yaml"]),
    ("_helpers/tests/test_visium_chain_zero_src_app.py",
     "test_no_production_surface_was_touched",
     _PerEntryOf("FORBIDDEN_PACKAGE_SEGMENTS",
                 template="src-app/packages/qc{}stranger.py", expected_at_least=2)),
    ("_helpers/tests/test_visium_chain_zero_src_app.py",
     "test_no_shipped_analysis_manifest_was_edited",
     ["src-app/packages/qc/manifest.yaml"]),
    ("differential-expression/tests/test_zero_src_app_diff.py",
     "test_advanced_contrast_is_package_only",
     ["src-app/packages/qc/manifest.yaml"]),
    ("differential-expression/tests/test_zero_src_app_diff.py",
     "test_only_the_package_and_the_sanctioned_set_changed",
     ["src-app/packages/qc/manifest.yaml"]),
    # `test_zero_src_app_diff_boundaries.py` — marker-keyed, so no manifest-keyed harness can
    # reach it, and its premise (the ADD of `compute/boundaries.py`) is as unconstructible as
    # every other in this change. A blind audit gutted one of these bodies and the suite
    # stayed green: they were in neither table.
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_no_rust_no_typescript_no_ui_workspace_changed",
     ["src-app/server/src/modules/sneaky.rs"]),
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_every_non_package_change_is_a_named_exemption",
     ["src-app/packages/qc/manifest.yaml"]),
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_no_openapi_or_generated_client_changed",
     ["src-app/ui/openapi/openapi.json"]),
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_no_ui_workspace_path_appears_at_all",
     ["src-app/ui/src/modules/stranger.ts"]),
]


#: Gated tests deliberately NOT in the table, with the reason each is out of reach.
#: Named rather than omitted: a case silently missing from a case table is the same hole
#: as an exemption nobody wrote down.
_MIGRATED_GUARDS_NOT_CASE_TABLED = {
    # Reads `git status` — the WORKING TREE — not the changed set, so a planted diff cannot
    # express its subject. It IS gated (its subject is a property of the introducing session,
    # and it was measured reddening a later developer's tree over an uncommitted edit to a
    # package they were not working on), and its body is proven instead by
    # `test_the_working_tree_guard_still_REFUSES_an_unsanctioned_path` below.
    ("differential-abundance/tests/test_da_zero_src_app_diff.py",
     "test_the_WORKING_TREE_carries_no_unsanctioned_non_package_src_app_change"),
    # Compares FILE BYTES against the merge base rather than reading the changed set, so a
    # planted diff cannot make it fail. Its body is proven directly instead, against a
    # synthetic repository, by `test_rootfs_unchanged.py::test_the_byte_comparison_really_
    # FAILS_when_the_file_moved`.
    ("differential-abundance/tests/test_rootfs_unchanged.py",
     "test_the_rootfs_dockerfile_is_byte_unchanged"),
    # Reads `pytest.ini` and the ADDED set together; with `added_paths` forced to
    # "everything", its subject is not expressible here. Left out rather than faked.
    ("_helpers/tests/test_visium_chain_zero_src_app.py",
     "test_every_test_module_this_branch_adds_is_collected_by_something"),
    # Its assertion is about the exemption LIST rather than the diff: with `changed_paths`
    # planted, every named exemption is untouched, so it fails for the planted set's absence
    # rather than for the plant. Covered instead by the same-shaped test in
    # `test_zero_src_app_diff.py`, which the manifest-keyed end-to-end harness drives.
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_every_named_exemption_is_actually_touched"),
    # Asserts a content lock was RE-RECORDED in the same commit — a property of two files'
    # bytes, not of the changed set, so a planted diff cannot express it.
    ("spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py",
     "test_the_content_lock_moved_AND_was_re_recorded_in_this_same_commit"),
    # Not a branch-diff assertion at all: it inspects the gate's own SKIP MESSAGE to prove
    # this module's INV-7 attribution survived being folded into the shared helper. With the
    # premise forced to hold there is no skip to inspect, which is the case it is written to
    # pass through. Its liveness is proven by dropping `reason=` from the call site, which
    # reddens it directly.
    ("_helpers/tests/test_visium_chain_zero_src_app.py",
     "test_this_modules_skip_still_names_INV_7"),
}
#: The modules whose gated tests this change is responsible for. The case table is checked
#: against THIS list in both directions, so a gated test added to any of them later cannot
#: join the tree with no liveness proof — which is how six of them were missed.
_MIGRATED_GUARD_MODULES = sorted({rel for rel, _n, _p in _MIGRATED_GUARD_CASES}
                                 | {rel for rel, _n in _MIGRATED_GUARDS_NOT_CASE_TABLED})


def _import_guard_module(rel: str):
    """Import a guard module from `src-app/packages/<rel>` under its real name.

    Its own tests directory goes on `sys.path` first, because these modules import sibling
    fixture modules (`xenium_fixtures`) exactly as pytest's collection would.
    """
    import importlib.util

    path = REPO / "src-app" / "packages" / rel
    tests_dir = str(path.parent)
    if tests_dir not in sys.path:
        sys.path.insert(0, tests_dir)
    if str(_LIB) not in sys.path:
        sys.path.insert(0, str(_LIB))
    name = f"_guard_under_test_{rel.replace('/', '_').replace('.', '_')}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "rel,test_name,planted",
    _MIGRATED_GUARD_CASES,
    ids=[f"{rel.split('/')[0]}::{name}" for rel, name, _ in _MIGRATED_GUARD_CASES],
)
def test_every_migrated_guard_still_FAILS_when_its_premise_HOLDS(
    rel, test_name, planted, monkeypatch
):
    """INV-4, executed rather than attested — the GUARD-SUB remedy.

    `derived-guards.md` §6: *"a self-limiting guard still fails loudly on the branch where
    its premise does hold."* Every guard here keys on a marker already present on
    `origin/main`, so that branch cannot be cut any more — and two blind audits proved, by
    mutation, that each assertion body could be turned into a no-op with the suite green.

    This arms the gate at its boundary (`added_paths`) and feeds the assertion a diff it
    must refuse (`changed_paths`), then calls the REAL test function in the REAL module. If
    the body is gutted, weakened to `is not None`, or repointed at a path nothing touches,
    the call stops raising and this goes red. That is the property, not a proxy for it.
    """
    module = _import_guard_module(rel)
    func = getattr(module, test_name)
    plants = planted.plants(module) if isinstance(planted, _PerEntryOf) else list(planted)
    assert plants, f"`{rel}::{test_name}` has no planted diff, so it proves nothing"

    # `repo_root` is patched too, to the REAL repository. Without it the whole harness turns
    # into twelve silent skips in a source tarball — a blind audit ran it outside a git
    # checkout and got `ssssssssssss`, exit 0, from the one mechanism whose entire job is
    # making "this guard can no longer fail" impossible. Nothing here needs git: the diff is
    # supplied, and the guards' tree reads want the real tree.
    monkeypatch.setattr(g, "repo_root", lambda: REPO)
    monkeypatch.setattr(g, "added_paths", lambda root: _EverythingWasAdded())

    # EACH plant independently. One plant per case proves exactly one ARM of a multi-arm
    # guard: with only a server-src path planted, deleting `doublet`'s `src-app/ui/` arm — or
    # four of `differential-abundance`'s five forbidden prefixes — left the suite green.
    for plant in plants:
        monkeypatch.setattr(g, "changed_paths", lambda root, _p=plant: [_p])
        try:
            func()
        except pytest.skip.Exception as skipped:
            pytest.fail(
                f"`{rel}::{test_name}` SKIPPED with its premise forced to hold: {skipped}. A "
                f"guard that stands itself down reports as a skip, and `pytest.raises` does "
                f"not catch a `Skipped` — so this must be an explicit failure or the one "
                f"check that proves the guard can still fail would report green.")
        except AssertionError as exc:
            assert plant in str(exc), (
                f"`{rel}::{test_name}` refused `{plant}` but its message does not name it, so "
                f"nothing distinguishes the guard firing from an unrelated assertion:\n{exc}")
        else:
            pytest.fail(
                f"`{rel}::{test_name}` ACCEPTED `{plant}` with its premise forced to hold. "
                f"That assertion can no longer fail for that path — the defect one layer up "
                f"(#274/#286), and worse than the false red this change removed.")


def test_the_working_tree_guard_still_REFUSES_an_unsanctioned_path(monkeypatch):
    """The one gated guard whose subject is the WORKING TREE, driven at its own boundary.

    A planted `changed_paths` cannot reach it — it shells out to `git status --porcelain` —
    and fabricating a dirty tree in the real checkout would be a side effect on a worktree
    other agents share. So the boundary that is patched is that module's own `subprocess.run`,
    with porcelain it must refuse and porcelain it must accept.

    Without this the assertion is unreachable on every branch, which is the defect one layer
    up (#274/#286) and the reason the round-3 audit was right to object to gating it blind —
    the objection is answered by proving the body, not by leaving the guard unscoped.
    """
    rel = "differential-abundance/tests/test_da_zero_src_app_diff.py"
    module = _import_guard_module(rel)
    func = module.test_the_WORKING_TREE_carries_no_unsanctioned_non_package_src_app_change

    monkeypatch.setattr(g, "repo_root", lambda: REPO)
    monkeypatch.setattr(g, "added_paths", lambda root: _EverythingWasAdded())
    monkeypatch.setattr(g, "changed_paths", lambda root: [])

    class _Porcelain:
        def __init__(self, stdout):
            self.returncode, self.stdout, self.stderr = 0, stdout, ""

    # An unsanctioned non-package path sitting in the tree — it must be refused, by name.
    monkeypatch.setattr(module.subprocess, "run",
                        lambda *a, **k: _Porcelain(" M src-app/server/src/modules/stranger.rs\n"))
    with pytest.raises(AssertionError) as excinfo:
        func()
    assert "src-app/server/src/modules/stranger.rs" in str(excinfo.value)

    # …and a RENAME reports `old -> new`; BOTH sides count, which is a property this module
    # argues for at length and which nothing else exercises.
    monkeypatch.setattr(module.subprocess, "run",
                        lambda *a, **k: _Porcelain(
                            'R  "src-app/server/src/modules/old.rs" -> '
                            '"src-app/packages/differential-abundance/new.rs"\n'))
    with pytest.raises(AssertionError) as excinfo:
        func()
    assert "src-app/server/src/modules/old.rs" in str(excinfo.value), (
        "a `git mv` of an unsanctioned server file INTO this package is reported clean — the "
        "both-sides handling this module documents is not doing anything")

    # A clean tree, and a path inside the package, must both be accepted.
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: _Porcelain(""))
    func()
    monkeypatch.setattr(module.subprocess, "run",
                        lambda *a, **k: _Porcelain(
                            " M src-app/packages/differential-abundance/compute/x.py\n"))
    func()


def test_the_migrated_guard_case_table_is_not_stale():
    """The case table, both ways — a case naming nothing proves nothing.

    Every entry (and every deliberate omission) must name a module and a test that really
    exist, so renaming or deleting a guard test cannot quietly remove its only proof of
    liveness. This is the rule the repo already applies to its sanctioned path sets.
    """
    for rel, test_name, _planted in _MIGRATED_GUARD_CASES:
        path = REPO / "src-app" / "packages" / rel
        assert path.is_file(), f"case table names a module that does not exist: {rel}"
        assert f"def {test_name}(" in path.read_text(encoding="utf-8"), (
            f"case table names `{test_name}`, which `{rel}` does not define — the guard was "
            f"renamed or deleted and its liveness proof went with it")
    for rel, test_name in sorted(_MIGRATED_GUARDS_NOT_CASE_TABLED):
        path = REPO / "src-app" / "packages" / rel
        assert path.is_file(), f"omission list names a module that does not exist: {rel}"
        assert f"def {test_name}(" in path.read_text(encoding="utf-8"), (
            f"omission list names `{test_name}`, which `{rel}` does not define")

    # …AND THE OTHER DIRECTION. The first cut iterated the tables and never the modules, so a
    # gated test could join a migrated module with no liveness proof and nothing would go red
    # — which is exactly how the six guards in `test_zero_src_app_diff_boundaries.py` were
    # missed. Every gated test in every migrated module must be in one table or the other.
    accounted = ({(rel, name) for rel, name, _p in _MIGRATED_GUARD_CASES}
                 | set(_MIGRATED_GUARDS_NOT_CASE_TABLED))
    unaccounted = []
    for rel in _MIGRATED_GUARD_MODULES:
        module = REPO / "src-app" / "packages" / rel
        for name in _gated_test_names(module):
            if (rel, name) not in accounted:
                unaccounted.append(f"{rel}::{name}")
    assert unaccounted == [], (
        f"these gated tests are in neither the case table nor the omission list, so nothing "
        f"proves their assertion bodies are still real: {unaccounted}. Their premise cannot "
        f"hold on any branch cut from main, so a gutted body would be invisible — add a case "
        f"with the diff it must refuse, or an omission with the reason a planted diff cannot "
        f"express its subject.")
