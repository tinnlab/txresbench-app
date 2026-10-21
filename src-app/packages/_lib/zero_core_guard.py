#!/usr/bin/env python3
# ruff: noqa
"""Self-limiting scope for the package ZERO-SRC-APP-DIFF guards.

Realizes `docs/design/derived-guards.md` §3 (Corollary A) and §2 (the principle).

## The defect this module exists to remove

Three packages ship a `tests/test_zero_src_app_diff.py` asserting a property of the
BRANCH DIFF, not of the code::

    assert not p.startswith("src-app/server/src/"), f"server src changed: {p}"
    assert p in SANCTIONED_NON_PACKAGE, f"unexpected non-package src-app change: {p}"

Read on the branch that introduced its package, that says exactly the right thing:
*this package was added with zero core edits*. But the diff it reads is
`merge-base(main, HEAD)...HEAD` — the CURRENT branch — so the test re-executes on
every future branch and asserts THAT branch also touched nothing outside a package it
has nothing to do with. Which is false for every subsequent branch. Measured: a
branch adding one file under `src-app/packages/doublet/` reddens six assertions
belonging to three unrelated packages, and the only ways to clear it are to edit
another feature's acceptance tests or to widen an allowlist. Two independent agents
hit this in one week and both, correctly, refused.

## What replaces it, and why it is DERIVED rather than configured

The property is real; only its SCOPE was wrong. So each guard is made inert unless
the current branch is the one that INTRODUCES its own package — and both halves of
that sentence are derived, never typed in:

* **which package is mine** comes from the calling test module's OWN path
  (`src-app/packages/<pkg>/tests/…`), so this module names no package and a fourth
  copy needs no edit here (:func:`package_of`);
* **did this branch introduce it** comes from the diff itself: the package's
  `manifest.yaml` must appear under ``git diff --diff-filter=A``
  (:func:`introduces_package`). The manifest is the right marker because it is the
  file whose EXISTENCE defines the package to the loader — `ExtensionRegistry::scan_dir`
  skips any folder without one — so "the manifest was added" IS "the package was
  introduced".

## The marker is ADD-ONLY, and that is load-bearing

Keying on ``--diff-filter=A`` rather than "the diff touches this manifest" is the same
distinction `_is_dependency_contract_branch` (in the very files this serves) already
reasons out for the #80 exemption: a "touches" key also matches a MODIFICATION, so
every routine maintenance edit — a version bump, a dependency line, a description fix
— would silently re-arm the guard on a branch whose premise does not hold, and the
false-red would be back. An ADD happens exactly once in a package's history.

## A skip is a SKIP

When the premise does not hold the guard calls :func:`pytest.skip` with a reason
naming the package. It never returns quietly, and it never degrades into a pass: a
guard that silently no-ops is the vacuous-green failure this whole design document is
about, wearing a different costume (`derived-guards.md` §1).

## What this module is NOT

It is not an exemption, an allowlist, or a prefix rule. It does not decide whether a
path is ALLOWED — each package keeps its own `SANCTIONED` set and its own assertions,
unchanged, and they run in full on the branch where the premise holds. This decides
only WHETHER the question is being asked of a branch that can answer it.

## Placement

`_lib` is on `sys.path` for every package suite (`src-app/packages/conftest.py`), is
in `pytest.ini`'s `testpaths` as a whole directory, and already carries a framework
module that is deliberately NOT staged into any processor's `/code` (`conformance.py`).
This module is likewise absent from `PY_HELPER_FILES` / `RESERVED_ENTRY_HELPERS` in
`server/src/modules/sandbox/processors/mod.rs`, so it reaches no sandbox — see
`test_zero_core_guard.py::test_the_guard_module_is_not_staged_into_any_sandbox`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

# The two path segments that, in order, precede a package folder. Derived usage only:
# nothing here spells a package NAME.
_PACKAGES_SEGMENTS = ("src-app", "packages")

# A folder that is hidden or `_`-prefixed is not a contributing package —
# `ExtensionRegistry::scan_dir` skips both (loader.rs, the `.`/`_` guards). Mirrored
# here so a helper module inside `_lib` can never be mistaken for its own subject.
_NON_PACKAGE_PREFIXES = (".", "_")


# ── git plumbing (was triplicated across the three suites, and had already diverged) ──
#
# The three copies each carried their own repo-root / base-ref / merge-base / diff walk,
# with different function names, one of them inlined, and a comment in the
# `differential-expression` copy apologising for re-inlining the base-ref resolution
# "rather than [importing it] from a sibling package's test module". This is that
# import.


def _git(root: Path | None, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(root) if root is not None else None,
        capture_output=True,
        text=True,
    )


def repo_root() -> Path:
    """The git checkout root, or SKIP if this is not a git checkout at all.

    Not being in git is the one honest reason a diff-scoped guard cannot run (a source
    tarball, a vendored copy). Anything else — a checkout with no resolvable base — is
    a FAILURE, not a skip: see :func:`base_ref`.

    STATED RELAXATION. Two of the three copies this replaced already skipped here; the
    `differential-expression` copy ASSERTED ("the DEC-9 zero-diff guard must run inside the
    git checkout"). Harmonising on the skip is a net loss of strictness for that package, and
    it is recorded rather than smuggled.

    AMENDED (#299): the word "uniquely" was true when written and is not any more, and a
    blind audit measured it. Three FURTHER call sites that asserted off-git now route through
    this function and therefore skip instead — `differential-abundance`'s
    `test_da_zero_src_app_diff.py` ("the zero-diff guard must run inside the git checkout")
    and `test_rootfs_unchanged.py`, and `spatial-import-xenium`'s
    `test_boundaries_long_table.py` leg 3 (which hard-failed on `diff.returncode`). Same
    trade, same reasoning, four packages instead of one — written down here because this
    module's own rule is that a relaxation is recorded rather than smuggled, and a stale
    "uniquely" is how a recorded loss quietly stops being recorded. It is accepted because
    the alternative punishes a legitimate non-git consumer for a property that is only
    definable against a diff — but note the consequence: a TREE-scoped assertion must not
    route through this function at all, or it silently stops asserting in a tarball for no
    reason. `test_package_declares_no_render_source` was changed to resolve its own path
    from `__file__` for exactly that reason.
    """
    out = _git(None, "rev-parse", "--show-toplevel")
    if out.returncode != 0:
        pytest.skip("not a git checkout — a branch-diff guard has no diff to read")
    return Path(out.stdout.strip())


def base_ref(root: Path) -> str:
    """`origin/main` or `main`, whichever resolves.

    FAILS (does not skip) when neither does. The three copies disagreed here — two
    skipped, one asserted — and the stricter reading is the right one: "I could not
    determine the base" must never become a silent way for the guard to stop asserting
    (`derived-guards.md` §3).
    """
    for ref in ("origin/main", "main"):
        if _git(root, "rev-parse", "--verify", "--quiet", ref).returncode == 0:
            return ref
    raise AssertionError(
        "the zero-src-app-diff guard is inside a git checkout but neither `origin/main` "
        "nor `main` resolves, so it cannot compute the branch diff it asserts over. "
        "That is a broken checkout, not a reason to pass."
    )


def diff_point(root: Path) -> str:
    """The merge base with the base ref (falling back to the ref itself).

    Comparing against the merge base rather than the base TIP is what keeps unrelated
    commits landing on `main` out of this branch's diff.
    """
    mb = _git(root, "merge-base", base_ref(root), "HEAD")
    return mb.stdout.strip() if mb.returncode == 0 else base_ref(root)


def changed_paths(root: Path) -> list[str]:
    """Every path in `merge-base(base, HEAD)...HEAD`."""
    out = _git(root, "diff", "--name-only", f"{diff_point(root)}...HEAD")
    assert out.returncode == 0, out.stderr
    return [p for p in out.stdout.splitlines() if p.strip()]


def added_paths(root: Path) -> list[str]:
    """Every path this branch ADDED (`--diff-filter=A`) — the add-only marker source.

    ASSERTS on a git failure, exactly like :func:`changed_paths`. The first cut returned
    `[]` here, and an audit showed why that was the worst possible choice: this function is
    reached FIRST (through :func:`introduces_package`), so `[]` meant "not the introducing
    branch" meant a `pytest.skip` whose message confidently states a premise the code never
    established. A shallow clone or a force-pushed base (`fatal: no merge base`) would have
    stood the whole guard down while looking exactly like the normal case — which is the
    rule :func:`base_ref` states one function earlier, broken one function later.
    """
    out = _git(
        root, "diff", "--name-only", "--diff-filter=A", f"{diff_point(root)}...HEAD"
    )
    assert out.returncode == 0, (
        "cannot compute this branch's ADDED paths, so the introducing-branch marker is "
        f"undecidable — that is a broken diff, not a reason to skip: {out.stderr.strip()}"
    )
    return [p for p in out.stdout.splitlines() if p.strip()]


# ── deriving the subject: which package owns the calling test module ────────────────


def package_of(test_file: str | Path) -> str:
    """The package id that owns `test_file`, DERIVED from its own location.

    A guard living at `src-app/packages/<pkg>/tests/test_zero_src_app_diff.py` is a
    guard ABOUT `<pkg>` — that is what its own docstring already claims. Reading it off
    the path is what lets this module serve three suites (and any future one) while
    naming none of them.

    Raises rather than guessing for a module outside that layout. A wrong answer here
    would silently gate one package's guard on another package's manifest, which is the
    exact class of quiet mis-scoping this whole change exists to remove.
    """
    parts = Path(test_file).resolve().parts
    # Scan from the RIGHT. An audit found the left-to-right form silently mis-scoped every
    # guard when the CHECKOUT ITSELF lives under a path containing these two segments
    # (`/home/dev/src-app/packages/cytoanalyst/src-app/packages/embedding/...` resolved to
    # `cytoanalyst`), producing a permanent silent skip — the "wrong answer" outcome the
    # docstring promises to raise on rather than guess at. The rightmost match is the one
    # inside the repository.
    for i in range(len(parts) - len(_PACKAGES_SEGMENTS) - 1, -1, -1):
        if parts[i : i + len(_PACKAGES_SEGMENTS)] == _PACKAGES_SEGMENTS:
            pkg = parts[i + len(_PACKAGES_SEGMENTS)]
            if pkg.startswith(_NON_PACKAGE_PREFIXES):
                raise AssertionError(
                    f"`{pkg}` is a hidden/reserved folder, not a contributing package "
                    f"(derived from {test_file}); a zero-src-app-diff guard cannot be "
                    f"scoped to one."
                )
            return pkg
    raise AssertionError(
        f"cannot derive the owning package from `{test_file}`: a zero-src-app-diff "
        f"guard must live under `{'/'.join(_PACKAGES_SEGMENTS)}/<package>/`."
    )


def package_prefix(package: str) -> str:
    """The repo-relative path prefix of a package's own files."""
    return f"{'/'.join(_PACKAGES_SEGMENTS)}/{package}/"


def manifest_path(package: str) -> str:
    """The repo-relative path of a package's manifest — the file that DEFINES it."""
    return f"{package_prefix(package)}manifest.yaml"


def introduces_package(root: Path, package: str) -> bool:
    """Is THIS branch the one that INTRODUCES `package`?

    True iff the branch diff ADDS the package's own `manifest.yaml`. Add-only, on
    purpose — see the module docstring. A branch that MODIFIES the manifest (a version
    bump, a new dependency line) is maintenance, and maintenance must not re-arm a
    guard whose premise is "this diff is the one that created this package".
    """
    return manifest_path(package) in added_paths(root)


def require_introducing_branch(test_file: str | Path) -> tuple[Path, str, list[str]]:
    """Gate a diff-scoped guard on its own premise; SKIP (visibly) when it fails.

    Returns `(repo_root, package, changed_paths)` on the branch that introduces the
    calling module's package, so the caller can go straight on to its assertions —
    which are unchanged, and run in full.

    Everywhere else it raises `Skipped` with a reason naming the package and the marker
    it looked for, so the skip is self-explaining in `pytest -rs` and counted in the
    summary of a plain `-q` run. It is never a pass.
    """
    root = repo_root()
    package = package_of(test_file)
    if not introduces_package(root, package):
        pytest.skip(
            f"not the branch that introduces `{package}` "
            f"(`{manifest_path(package)}` is not among this branch's ADDED paths), so "
            f"this branch's diff is not the one this guard describes. The guard runs in "
            f"full on the introducing branch — see docs/design/derived-guards.md §3."
        )
    return root, package, changed_paths(root)


def require_introducing_file(
    marker: str, test_file: str | Path | None = None, reason: str | None = None
) -> tuple[Path, list[str]]:
    """The MARKER-keyed sibling of :func:`require_introducing_branch`.

    Same premise, same add-only detection, same visible skip. The only difference is what
    marks the subject's introduction: a NAMED repo-relative path this branch ADDED, rather
    than the calling module's own package `manifest.yaml`.

    ## Why a second entry point exists at all, rather than one more manifest key

    Not every branch-diff proof is about a PACKAGE being introduced. #163 introduced a
    PRODUCER inside a package #162 had already landed, so its guards' premise is "this is
    the branch that adds `spatial-import-xenium/compute/boundaries.py`" — the file whose
    existence IS the new producer. Keying those on the package manifest would make them skip
    on the one branch they describe, which is self-limiting becoming SELF-DISABLING: strictly
    worse than the unscoped guard, because a guard that can no longer fail at all reports
    green for a reason unrelated to what it claims (`derived-guards.md` §1).

    So the marker is a PARAMETER: the caller names its own subject, exactly as
    :func:`package_of` lets the caller's own location name its package. (The paragraph above
    names `spatial-import-xenium`'s files while explaining WHY — like the rest of this
    module's prose, and like the three package names its history section already carries.
    What `test_the_guard_module_spells_no_shipped_package_name` forbids, and what remains
    true, is a package name in a string literal the interpreter acts on.)

    ## It is a generalization of code the tree already ran, not a new mechanism

    `spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py` open-coded this as a
    private `_armed()`. That is how the git plumbing this module replaced got triplicated in
    the first place ("was triplicated across the three suites, and had already diverged"), so
    the second copy is folded in here before there is a third.

    `test_file` is optional and purely diagnostic — when given, the skip reason names the
    module whose premise did not hold, which is what makes a `-rs` summary readable when
    several guards skip in one run.

    ## THE MARKER IS THE ONE THING THIS GATE DOES NOT DERIVE, AND CALLERS MUST PIN IT

    `require_introducing_branch` derives its marker from the calling module's own location
    (`manifest_path(package_of(__file__))`), so it cannot be repointed. This one takes the
    marker as a free string, and a blind audit showed what that costs: repointing the two
    shipped markers at a path that does not exist made EIGHT assertions across three modules
    permanently unarmable, with the whole suite green — the defect this module exists to
    remove, reappearing one level up.

    It is NOT checked here, deliberately. "The marker names a real file" is true of the
    repository and false of the minimal synthetic trees `_lib/test_zero_core_guard.py` builds
    to drive the shipped guards, so asserting it here would fail the harness for a reason that
    has nothing to do with any guard. Every caller therefore ships a one-line ungated control
    asserting its own marker names a file — `test_the_arming_marker_names_a_real_file` in each
    of the three marker-keyed modules — which is where the fact is both true and checkable.

    `reason` is APPENDED to the skip message. It exists because folding an open-coded gate in
    here must not silently discard what that copy said: `_helpers`' copy named the invariant
    (INV-7) its skip belongs to, and a de-duplication that drops the one sentence a reader
    needs is a regression wearing tidying's clothes. A blind audit caught exactly that loss.

    Returns `(repo_root, changed_paths)`. It does NOT return a package id: a marker-keyed
    guard's subject is the marker, and deriving a package from the caller's path here would
    invite a caller to assert about a package whose introduction it never checked.
    """
    root = repo_root()
    if marker not in added_paths(root):
        who = f" (`{Path(test_file).name}`)" if test_file is not None else ""
        tail = f" {reason.strip()}" if reason else ""
        pytest.skip(
            f"not the branch that introduces `{marker}`{who} (it is not among this "
            f"branch's ADDED paths), so this branch's diff is not the one this guard "
            f"describes. The guard runs in full on the introducing branch — see "
            f"docs/design/derived-guards.md §3.{tail}"
        )
    return root, changed_paths(root)


# ── the #80 dependency-contract exemption (identical in all three copies) ────────────
#
# Kept here verbatim in behaviour, moved here to stop being maintained in triplicate.
# The reasoning is unchanged and is reproduced because it is the reasoning this whole
# module generalizes: an exemption must not outlive the change it exists for.

#: The MECHANICALLY-GENERATED client artifacts, excluded on ANY branch. Every gate in
#: this repository excludes them by rule: they are regenerated deterministically from
#: reviewed Rust source by a golden-tested generator, so a diff in them restates a
#: change already reviewed at its source rather than being an independent edit.
GENERATED_CLIENT_ARTIFACTS = frozenset(
    {
        "src-app/ui/openapi/openapi.json",
        "src-app/ui/openapi-saas/openapi.json",
        "src-app/ui/src/api-client/types.ts",
        "src-app/ui/src/api-client-saas/types.ts",
        "src-app/ui/src/api-client/permissions.ts",
        "src-app/ui/src/api-client-saas/permissions.ts",
        "src-app/ui/src/api-client/permissionDescriptions.ts",
        "src-app/ui/src/api-client-saas/permissionDescriptions.ts",
        "src-app/ui/src/api-client/apiEndpoints.ts",
        "src-app/ui/src/api-client-saas/apiEndpoints.ts",
    }
)

#: The ONE cross-cutting exemption (#80, the dependency-contract infrastructure). An
#: ENUMERATION, not a prefix: every path is named, so a stray server change on some
#: later branch still fails these guards exactly as before.
DEPENDENCY_CONTRACT_INFRA = frozenset(
    {
        "src-app/env-rootfs/single-cell/requirements.txt",
        "src-app/env-rootfs/single-cell/Dockerfile",
        "src-app/server/src/modules/extensions/types.rs",
        "src-app/server/src/modules/extensions/loader.rs",
        "src-app/server/build_helper/processor_manifest.rs",
        "src-app/server/build.rs",
        "src-app/server/src/modules/sandbox/processors/mod.rs",
        "src-app/server/src/modules/provenance/recorder.rs",
        "src-app/server/src/modules/rootfs/version.rs",
    }
)

#: Two PREFIXES, for the same reason (#80): a cross-cutting branch also touches the
#: shared reserved library every package imports and the server's own test tree.
#: Neither is "this package needing an application change" — `src-app/packages/` is
#: DATA and `src-app/server/tests/` is not product code.
DEPENDENCY_CONTRACT_INFRA_PREFIXES = (
    "src-app/packages/",
    "src-app/server/tests/",
)


def is_dependency_contract_branch(root: Path) -> bool:
    """Is THIS branch the one that INTRODUCES the #80 dependency contract?

    Keyed on the ADD of an env recipe's pin file, for the same add-only reason
    :func:`introduces_package` is: a first cut asked "does the diff touch a
    `requirements.txt`", which also matches a MODIFICATION — so every future pin bump,
    the single most likely edit under `env-rootfs/`, would have silently re-enabled the
    entire relaxation.
    """
    return any(
        p.startswith("src-app/env-rootfs/") and p.endswith("/requirements.txt")
        for p in added_paths(root)
    )


def infra_exempt(path: str, root: Path) -> bool:
    """The shared exemption test used by all three suites."""
    if path in GENERATED_CLIENT_ARTIFACTS:
        return True
    if not is_dependency_contract_branch(root):
        return False
    return path in DEPENDENCY_CONTRACT_INFRA or path.startswith(
        DEPENDENCY_CONTRACT_INFRA_PREFIXES
    )
