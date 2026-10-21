#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 [acceptance] [invariant: INV-DA-6] [covers: ITEM-5]

NO NEW DEPENDENCY (#83). The analysis rootfs is a uv venv on Python 3.11, trimmed to ~316 MB,
which deliberately dropped `r-base-core` ("no R processor exists — re-add if one lands"). Every
off-the-shelf differential-abundance library needs something that rootfs cannot carry:

  · `milopy`  — R + edgeR via rpy2, and upstream is archiving it in favour of pertpy
  · `pertpy`  — Python >= 3.12 (a rootfs schema bump and a revalidation of every package) plus
                `flax`/`numpyro`/`ott-jax`, i.e. JAX, hundreds of MB into a 316 MB image
  · `scCODA`  — TensorFlow + tensorflow-probability, last release 0.1.9
  · `DAseq`   — R

So the package is implemented ON the pinned stack. That is not "reimplementing a statistics
library": the statistical engine — a negative-binomial GLM with Wald tests — is ALREADY pinned and
ALREADY in production here (`pydeseq2`, used by `de.compare`). The honest cost of the decision is
that correctness now rests on OUR neighbourhood construction and OUR spatial FDR, which is exactly
why the acceptance battery is behavioural and why the parity tiers exist.
"""
import ast
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports under a narrower rootdir.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

import cyto_deps  # noqa: E402  — `_lib`, reached by the path insert above; a unique flat name
from zero_core_guard import diff_point, require_introducing_branch  # noqa: E402

_PKG = Path(__file__).resolve().parents[1]
# A TREE-scoped root, walked up from this file rather than resolved through
# `zero_core_guard.repo_root()` — that function SKIPS outside a git checkout, which is right
# for a branch-diff guard and wrong for a tree assertion (its own docstring says so).
_REPO_ROOT = _PKG.parents[2]
_COMPUTE = _PKG / "compute"
_DOCKERFILE = _PKG.parents[1] / "env-rootfs" / "single-cell" / "Dockerfile"
_REQUIREMENTS = _PKG.parents[1] / "env-rootfs" / "single-cell" / "requirements.txt"

#: Reference implementations this package is written AGAINST but must never reach for. They may
#: be NAMED in prose — a reader of `_kernel.py` needs to know which implementation the code
#: reproduces — and never in anything the interpreter acts on.
REFERENCE_IMPLEMENTATIONS = ("pertpy", "milopy", "edgeR", "rpy2", "scCODA")

#: Libraries this package must never import from a shipped compute file.
UNINSTALLABLE = ("pertpy", "milopy", "sccoda", "scCODA", "rpy2", "tensorflow", "jax", "flax",
                 "numpyro", "ott")


# `_repo_root()` used to live here. It is `zero_core_guard.repo_root` now, reached through
# `require_introducing_branch`, which returns the root along with the premise it checked —
# so there is no way to read the root without having established whose branch this is.


def test_the_rootfs_dockerfile_is_byte_unchanged():
    """Measured from the MERGE BASE, not from the current `origin/main`.

    The invariant is "THIS BRANCH introduces no rootfs change", which is a statement about what the
    branch did — so the comparison point is where the branch left main, not wherever main has since
    got to. Comparing against the moving ref made this test fail the moment someone landed an
    unrelated edit to that file on main: measured here, `origin/main` moved 58 commits and one of
    them rewrote the Dockerfile's header comment, and this test went red over a change the branch
    had nothing to do with. `_changed()` in the zero-src-app-diff guard already used the merge
    base; the two guards simply disagreed with each other.

    ── SCOPED TO THE BRANCH THAT CAN PROVE IT (the same repair as #238/#268/#282/#299) ──
    Measuring from the merge base fixed WHERE the comparison starts; it did not fix WHOSE
    branch is being asked about. Unscoped, this asserts of EVERY later branch that it too
    introduced no rootfs change — so any branch adding a pin to
    `env-rootfs/single-cell/requirements.txt` goes red on an acceptance test belonging to a
    package it never touched. That is directly contradictory: #80's dependency-contract
    mechanism exists precisely so a later branch CAN declare a pin, and
    `zero_core_guard.is_dependency_contract_branch` is that mechanism's own add-only key.

    `require_introducing_branch` makes the premise explicit and derives it from the diff:
    this runs in full on the branch that ADDS `differential-abundance/manifest.yaml`, and
    skips visibly with a stated reason everywhere else. The module's other tests are
    properties of the SHIPPED TREE (what the compute imports, what the recipe pins) and are
    deliberately left ungated — they run on every branch, as they should. Two of them WERE red
    on `origin/main` @ `45acbdfd` for an unrelated `pyarrow` reason, measured; #305 closed that
    by CLASSIFYING `pyarrow` as the `pandas` pull-in it is, and the sentence is updated here
    rather than left standing, because a recorded red that has since been fixed reads as a
    live one. (Two earlier drafts of this
    sentence gave a COUNT and both were wrong — "twelve", then "six" after this same commit
    added another test and the number was not re-derived. It is left out: a count that has to
    be re-derived by hand on every edit is a fact with a half-life, and nothing here needs
    it.)

    THE COST OF SCOPING, AND WHAT PAYS IT. `differential-abundance/manifest.yaml` already
    exists on `origin/main`, so `--diff-filter=A` can never contain it again: this assertion
    body now runs on no branch at all. That is correct scoping and it is also how a guard
    stops being able to fail (#274/#286) — a blind audit gutted this test to `for rel in ():`
    and the suite stayed green. `test_the_frozen_rootfs_file_list_is_not_vacuous` below is
    the ungated control that closes it."""
    root, _pkg, _changed = require_introducing_branch(__file__)
    for rel in ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE:
        _assert_unchanged_since_merge_base(root, rel)


#: The rootfs files INV-DA-6's "no new dependency" claim is ABOUT — DERIVED from the two
#: paths this module already computes from the package layout twenty lines above, never
#: retyped. A blind audit caught the first cut retyping them: repointing the hand-written
#: tuple at an unrelated file deleted the rootfs from the guard's subject entirely and left
#: the suite green, because the vacuity control below could only check that the names it was
#: given exist. Deriving makes that mutation unwritable (`derived-guards.md` §2).
ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE = tuple(
    p.relative_to(_REPO_ROOT).as_posix() for p in (_DOCKERFILE, _REQUIREMENTS)
)


def test_the_frozen_rootfs_file_list_is_not_vacuous():
    """TEST-12 [acceptance] [invariant: INV-3] — the control for the gated test above.

    UNGATED, on purpose: it asserts nothing about any branch's diff, only that the subject
    the gated assertion ranges over is real. Without it, emptying
    `ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE` — or pointing an entry at a path that does not
    exist — is invisible, because the assertion that would notice is armed on a branch that
    can no longer be constructed. That is the same family as #274: a check whose green is
    unrelated to what it claims to verify.
    """
    assert ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE, (
        "the frozen rootfs file list is empty, so the guard above ranges over nothing and "
        "cannot fail for any branch"
    )
    for rel in ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE:
        assert (_REPO_ROOT / rel).is_file(), (
            f"`{rel}` is named as a file this epic must not move, but no such file exists. "
            f"A subject that names nothing cannot be violated."
        )
        # DOMAIN, not just existence. Non-emptiness plus `is_file()` is satisfied by ANY
        # real path, so replacing the derivation with, say, `("src-app/packages/qc/
        # manifest.yaml",)` deletes the rootfs from this guard's subject entirely and stays
        # green — a blind audit wrote exactly that mutation and it survived. INV-DA-6 is a
        # claim about the ROOTFS RECIPE; a subject outside it is not a narrower claim, it is
        # a different one.
        assert rel.startswith("src-app/env-rootfs/"), (
            f"`{rel}` is not part of the rootfs recipe, so this guard is no longer about "
            f"the thing INV-DA-6 ('no new dependency', #83) is about."
        )

    # …and the subject is BOTH recipe files, cross-checked against the two paths the rest of
    # this module reads the recipe through. `derived-guards.md` §4's own correction: a
    # derivation whose two sides read the same source is a tautology in the direction that
    # source changes, so keep a frozen expectation across exactly that direction. Here the
    # direction is REMOVAL — dropping `requirements.txt` and keeping the Dockerfile leaves a
    # non-empty list of real files inside the right domain, and a blind audit's mutation did
    # exactly that and survived every check above.
    assert set(ROOTFS_FILES_THIS_BRANCH_MUST_NOT_MOVE) == {
        _DOCKERFILE.relative_to(_REPO_ROOT).as_posix(),
        _REQUIREMENTS.relative_to(_REPO_ROOT).as_posix(),
    }, (
        "the guard's subject is no longer both halves of the recipe. #83 pins the DEPENDENCY "
        "SET as well as the image, so a pin file outside the subject means the claim is no "
        "longer the one INV-DA-6 makes."
    )


def test_the_byte_comparison_really_FAILS_when_the_file_moved(tmp_path):
    """TEST-12 (cont.) [acceptance] [invariant: INV-3] — the ASSERTION BODY, executed.

    The gated test above keys on a manifest that already exists on `origin/main`, so its
    arming branch cannot be cut and its body runs on no branch at all. Two blind audits then
    showed, by mutation, that gutting `_assert_unchanged_since_merge_base` to `return` left
    the entire suite green — the vacuity control beside it pins the SUBJECT LIST, not the
    comparison. A guard that can no longer fail is the defect one layer up (#274/#286), and
    it is worse than the false red this change removed.

    So the comparison is driven directly, against a throwaway repository built here: a file
    that did NOT move must pass, and the same file with one appended byte must FAIL, naming
    it. No branch of this repo is involved and nothing about any branch is asserted — this is
    a unit test of the comparison, which is the half the gate makes unreachable.
    """
    import subprocess as sp

    root = tmp_path / "repo"
    (root / "src-app/env-rootfs/single-cell").mkdir(parents=True)
    rel = "src-app/env-rootfs/single-cell/Dockerfile"
    (root / rel).write_text("FROM scratch\n", encoding="utf-8")
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}

    def git(*args):
        r = sp.run(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", *args],
                   cwd=str(root), capture_output=True, text=True, env=env)
        assert r.returncode == 0, f"{args} failed: {r.stderr}"

    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-qm", "seed")
    git("checkout", "-q", "-b", "feat/x")

    # UNCHANGED — the comparison must be quiet.
    _assert_unchanged_since_merge_base(root, rel)

    # MOVED — it must fail, and name the file.
    (root / rel).write_text("FROM scratch\nRUN pip install something\n", encoding="utf-8")
    with pytest.raises(AssertionError) as excinfo:
        _assert_unchanged_since_merge_base(root, rel)
    assert rel in str(excinfo.value), (
        f"the comparison failed without naming the file it is about: {excinfo.value}")

    # DELETED — the case that used to raise an uncaught `FileNotFoundError` instead of the
    # assertion this guard exists to print.
    (root / rel).unlink()
    with pytest.raises(AssertionError) as excinfo:
        _assert_unchanged_since_merge_base(root, rel)
    assert "DELETED" in str(excinfo.value)

    # ADDED on the branch — absent at the merge base, present here. A blind audit found the
    # two arms below UNEXERCISED by the first three legs: every one of them took the
    # `returncode == 0` path, so neutering either arm was invisible. They exist precisely
    # because round 1 got this case backwards (it reported an ADD as "RENAMED or DELETED").
    added_rel = "src-app/env-rootfs/single-cell/requirements.txt"
    (root / added_rel).write_text("numpy==2.0.0\n", encoding="utf-8")
    with pytest.raises(AssertionError) as excinfo:
        _assert_unchanged_since_merge_base(root, added_rel)
    assert "ADDED" in str(excinfo.value), (
        f"a file this branch added must be reported as an ADD, not as a rename or delete: "
        f"{excinfo.value}")

    # GONE AT BOTH — absent at the merge base and absent here. Neither the byte comparison
    # nor the delete arm applies, and a green run would mean "the recipe this guard is about
    # does not exist", which is not something a pass should be able to say.
    (root / added_rel).unlink()
    with pytest.raises(AssertionError) as excinfo:
        _assert_unchanged_since_merge_base(root, added_rel)
    assert "neither" in str(excinfo.value)


def _assert_unchanged_since_merge_base(root, rel):
    """`rel`'s bytes at the MERGE BASE must equal its bytes here.

    `diff_point` is the shared resolution of "where this branch left main" — the same
    function every other guard in this tree uses, and one that RAISES rather than skipping
    when no base ref resolves. The hand-rolled base-ref loop this replaces was the fourth
    copy of that plumbing, in the change whose stated purpose is removing the third.
    """
    point = diff_point(root)
    base = subprocess.run(["git", "show", f"{point}:{rel}"], cwd=root,
                          capture_output=True, text=True)
    here = root / rel
    # Three outcomes, each named. A blind audit found the first cut collapsing them: it read
    # a `git show` failure as "RENAMED or DELETED" when it actually means the file did not
    # exist at the base (i.e. this branch ADDED it), and it let the genuine delete case reach
    # `read_text()` and raise an uncaught `FileNotFoundError` — an ERROR wearing none of the
    # messages this guard exists to print.
    if base.returncode != 0:
        assert not here.exists(), (
            f"`git show {point}:{rel}` failed ({base.stderr.strip()}) but the file exists "
            f"here, so this branch ADDED it. This epic ships with NO new dependency and no "
            f"ROOTFS_SCHEMA_VERSION bump (#83).")
        raise AssertionError(
            f"{rel} exists at neither the merge base nor here — the rootfs recipe this "
            f"guard is about is gone, which is not something a green run should mean.")
    assert here.exists(), (
        f"{rel} was DELETED on this branch. Removing the recipe is a rootfs change like any "
        f"other, and #83 ships none.")
    assert base.stdout == here.read_text(), (
        f"{rel} changed ON THIS BRANCH. This epic ships with NO new dependency and no "
        "ROOTFS_SCHEMA_VERSION bump (#83).")


def test_no_shipped_compute_file_imports_an_uninstallable_library():
    for path in sorted(_COMPUTE.glob("*.py")):
        src = path.read_text()
        for lib in UNINSTALLABLE:
            assert not re.search(rf"^\s*(import\s+{re.escape(lib)}\b|from\s+{re.escape(lib)}\b)",
                                 src, re.M), f"{path.name} imports {lib!r}"


#: The dynamic-import spellings that reach a module without an `import` statement. Both take the
#: module name as their first argument, and both are used in this stack.
_DYNAMIC_IMPORTERS = ("import_module", "__import__")


def _imported_top_level_modules(src, label):
    """Every top-level module name `src` can reach, derived with `ast`.

    NOT a line regex. The version this replaced was
    `re.match(r"\\s*(?:from|import)\\s+([A-Za-z_][A-Za-z0-9_]*)", line)`, which captures only the
    FIRST name on a line — so round R1 walked an undeclared `umap` straight past it four different
    ways: `import numpy as np, umap`, `import numpy as np; import umap`,
    `importlib.import_module("umap")` and `__import__("umap")`. A guard whose evasion is that
    cheap is not a guard, and the failure is the SAME shape as the one that aborted the first fix
    loop: a hand-written pattern standing in for a semantic property.

    `ast` bounds the STATEMENT forms completely (`import a, b` and `import a; import b` are the
    same tree). It does NOT bound the dynamic ones, and the claim that used to stand here — that
    an unresolvable name "is called out as such rather than silently passed" — was FALSE. Round R2
    falsified it with six spellings that each really loaded an undeclared module:

        import_module("skl" + "earn")            a BinOp argument falls off the isinstance chain
        _load = _il.import_module; _load("x")    the callee name is not in _DYNAMIC_IMPORTERS
        from importlib import import_module as _q; _q("x")
        getattr(_il, "import_module")("x")
        exec("import sklearn")
        __builtins__["__import__"]("x")

    THIS FUNCTION IS A TRIPWIRE, NOT THE GUARANTEE, and that is a deliberate stopping point rather
    than an admission of defeat. Writing a seventh and an eighth pattern is precisely what aborted
    this feature's first fix loop on a different guard: a static rule over a general-purpose
    language has an unbounded evasion space, so zero findings is unreachable by construction.

    THE GUARANTEE IS `test_what_da_clusters_actually_imports_matches_what_it_declares` and its
    neighbourhood twin, which run the real entry and read `sys.modules` back. Every spelling above
    — and every one nobody has thought of — puts the module there, because that is what "imported"
    means. This scan stays because it is fast, runs with no subprocess, and names the offending
    line instead of just the module.
    """
    tree = ast.parse(src)
    seen = set()

    def _add(value):
        if isinstance(value, str) and value:
            seen.add(value.split(".")[0])

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:              # `import a, b` — EVERY alias, not the first
                _add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:   # a relative import is local by construction
                _add(node.module)
        elif isinstance(node, ast.Call):
            func = node.func
            name = (func.attr if isinstance(func, ast.Attribute)
                    else func.id if isinstance(func, ast.Name) else None)
            if name not in _DYNAMIC_IMPORTERS or not node.args:
                continue
            arg = node.args[0]
            if isinstance(arg, ast.Constant):
                _add(arg.value)
            elif isinstance(arg, (ast.Tuple, ast.List, ast.Set)):
                for elt in arg.elts:
                    if isinstance(elt, ast.Constant):
                        _add(elt.value)
            elif isinstance(arg, ast.Name):
                # A loop variable. Resolve it from any literal collection iterated in this file —
                # that is the shape `library_versions()` had, and leaving it unresolved is what
                # let `da.clusters` import `scanpy`/`anndata`/`sklearn` while declaring none of
                # them. If it cannot be resolved, say so rather than pass.
                resolved = _names_from_literal_loops(tree, arg.id)
                assert resolved is not None, (
                    f"{label}: a dynamic import is driven by the name {arg.id!r}, which this "
                    "guard cannot resolve to a literal set of module names. Import the library "
                    "with a plain `import` statement, or iterate a literal collection.")
                for value in resolved:
                    _add(value)
    return seen


def _names_from_literal_loops(tree, var):
    """The string constants `var` takes when it is the target of a `for` over a literal."""
    out = []
    found = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.For):
            continue
        if not (isinstance(node.target, ast.Name) and node.target.id == var):
            continue
        if not isinstance(node.iter, (ast.Tuple, ast.List, ast.Set)):
            return None
        found = True
        for elt in node.iter.elts:
            if not isinstance(elt, ast.Constant):
                return None
            out.append(elt.value)
    return out if found else None


def test_every_third_party_module_the_compute_imports_is_DECLARED_and_PINNED():
    """Derived from the tree, never from a hand-list here.

    Since #80 the env's install list lives in `requirements.txt`, not in the Dockerfile, and every
    package declares `run.dependencies[]` which the BUILD GATE resolves against those pins. So the
    check is now two-sided and much stronger than the grep it replaces:

      1. every third-party module the shipped compute imports is DECLARED by the analysis that
         imports it (a new import with no declaration is a new dependency in all but name);
      2. every declared library is PINNED in `requirements.txt`.

    The old version grepped the Dockerfile for names. It passed for months and would have kept
    passing after the pins moved out of that file — the drift a declaration catches and a text
    search does not.
    """
    import yaml

    pinned = {}
    for line in _REQUIREMENTS.read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line or "==" not in line:
            continue
        pinned[line.split("==")[0].strip()] = line.split("==")[1].strip()
    assert pinned, "no pins parsed out of requirements.txt"

    #: import name → distribution name, for the cases where they differ.
    DISTRIBUTION = {"sklearn": "scikit-learn"}
    stdlib = {"os", "sys", "json", "math", "random", "pathlib", "importlib", "inspect", "re",
              "datetime", "argparse", "subprocess", "warnings", "collections", "itertools",
              "functools", "typing", "dataclasses"}
    local = {"_shared", "_regime", "_kernel", "_nhoods", "cyto_columns", "cyto_zarr",
             "cyto_zarr_read", "cyto_csc", "cyto_deps"}

    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    analyses = {a["id"]: a for a in manifest["contributes"]["analyses"]}
    for aid, a in analyses.items():
        declared = {d["library"] for d in a["run"]["dependencies"]}
        # every declared library is really pinned in the env
        for lib in declared:
            assert lib in pinned, f"{aid} declares {lib!r}, which requirements.txt does not pin"
        # …and every module the entry + its helpers import is declared
        files = [a["run"]["entry"], *a["run"].get("helpers", [])]
        seen = set()
        for rel in files:
            seen |= _imported_top_level_modules((_PKG / rel).read_text(), rel)
        for mod in sorted(seen - stdlib - local):
            dist = DISTRIBUTION.get(mod, mod)
            assert dist in declared, (
                f"{aid} imports {mod!r} (distribution {dist!r}) but does not DECLARE it in "
                "run.dependencies — an undeclared import is a new dependency in all but name, "
                "and the build gate cannot check it against the env pins")

        # …and the OTHER direction, which nothing else checks. The Rust build gate
        # (`processor_manifest.rs::lint_declared_dependencies`) only requires declared ⊆ pinned
        # and in range; it has no way to know whether the code uses what it declared. A
        # declaration that is never imported is a false statement about the run in the same
        # provenance record as the true ones, and — now that `cyto_deps` derives its runtime
        # subject set from this declaration — it also makes the run REFUSE on the absence of a
        # library it never wanted.
        imported_dists = {DISTRIBUTION.get(m, m) for m in seen - stdlib - local}
        for lib in sorted(declared - imported_dists):
            raise AssertionError(
                f"{aid} DECLARES {lib!r} in run.dependencies but neither its entry nor any "
                f"declared helper imports it (imports: {sorted(imported_dists)}). Round R1 "
                "demonstrated both halves of this drifting undetected: an undeclared import "
                "riding on a shared line, and two pinned-but-unused declarations added by "
                "mutation. Remove the declaration or import the library.")


def test_pertpy_and_edger_are_only_ever_REFERENCED_never_imported_by_the_compute():
    """They are REFERENCES, used once to generate a committed golden fixture on a host that can
    run them. Nothing in the shipped package, the sandbox or CI EXECUTES them.

    The check is on the IMPORT, not on the string: `_kernel.py` deliberately NAMES
    `pertpy.tools.Milo(solver="pydeseq2")` in its comments, because a reader of that code needs to
    know which reference implementation it is written against. Forbidding the word would push that
    provenance out of the code, which is the opposite of what this package is for."""
    generator = (_PKG / "tools" / "gen_parity_fixtures.py").read_text()
    assert "pertpy" in generator and "edgeR" in generator
    for path in sorted(_COMPUTE.glob("*.py")):
        src = path.read_text()
        for lib in ("pertpy", "rpy2", "milopy"):
            assert not re.search(rf"^\s*(import\s+{lib}\b|from\s+{lib}\b)", src, re.M), (
                f"{path.name} IMPORTS {lib!r}")
        # Every mention must be PROSE — a DOCSTRING or a comment — and never anything the
        # interpreter acts on. Derived with `ast`, not with a "is there a triple quote somewhere
        # behind me" heuristic (true of essentially every line in these files, so it let a mention
        # in executable code through while reading as a guard) and not by exempting every string
        # literal either: `importlib.import_module("pertpy")` is a string literal that runs.
        tree = ast.parse(src)
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(node, clean=False)
                if doc is not None:
                    docstrings.add(doc)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if node.value in docstrings:
                    continue                              # prose
                for lib in REFERENCE_IMPLEMENTATIONS:
                    assert lib not in node.value, (
                        f"{path.name}: the string literal {node.value[:60]!r} names the reference "
                        f"implementation {lib!r} OUTSIDE a docstring — a name the interpreter can "
                        "act on is not prose")
                continue
            # `asname` and `arg` are bindings the interpreter acts on too: `import x as pertpy`
            # and `def f(pertpy=None)` both bind the name, and the first is an IMPORT statement,
            # which is the very construct this guard exists for.
            for field in ("id", "attr", "name", "module", "asname", "arg"):
                token = getattr(node, field, None)
                if isinstance(token, str):
                    for lib in REFERENCE_IMPLEMENTATIONS:
                        assert lib not in token, (
                            f"{path.name}: the identifier {token!r} names the reference "
                            f"implementation {lib!r} in executable code")


def test_the_engine_the_default_uses_is_the_one_de_compare_already_ships():
    """`pydeseq2` is not a new dependency to this repository: `differential-expression` already
    declares it as its default compare method's requirement."""
    de_methods = (_PKG.parent / "differential-expression" / "compute" / "_methods.py").read_text()
    assert 'requires=["pydeseq2"]' in de_methods
    import _kernel as K
    assert K.METHOD_DEFAULT == "pydeseq2"
    assert K.resolve_method("pydeseq2", _raise)["requires"] == ["pydeseq2"]


def _raise(message, code=2):
    raise AssertionError(message)


# ── TEST-53: the BEHAVIOURAL half of INV-DA-6 — what the entry ACTUALLY imports ────────────
#
# Round R2 defeated the `ast` scan above six different ways, all of which really did load an
# undeclared `sklearn` into the entry's interpreter:
#
#     import_module("skl" + "earn")                       _load = _il.import_module; _load("sklearn")
#     from importlib import import_module as _q; _q(...)  exec("import sklearn")
#     getattr(_il, "import_module")("sklearn")            __builtins__["__import__"]("sklearn")
#
# THIS IS THE SAME LESSON THAT ABORTED THE FIRST FIX LOOP, on a different guard: a static rule
# over a general-purpose language has an unbounded evasion space, so each round finds another
# spelling and zero findings is unreachable by construction. Writing a seventh and eighth pattern
# would repeat exactly the mistake the loop was restarted for.
#
# So the GUARANTEE is behavioural: run the real entry and look at what its interpreter actually
# ended up holding. Every spelling above — and every one nobody has thought of — puts the module
# in `sys.modules`, which is what "imported" MEANS. The `ast` scan stays as a cheap, fast tripwire
# with an honest docstring about what it does not catch.
#
# The subject set is the 25 libraries `requirements.txt` pins for this env, keyed by their
# `import=` names. Transitive pull-ins are real (pydeseq2 brings anndata; scanpy brings sklearn,
# umap, numba, igraph), so the assertion is a RATCHET against a committed expected set rather than
# `observed == declared`: a library appearing that nobody expected fails, whoever imported it and
# however.

_IMPORT_PROBE = '''
import atexit, os, sys
_out = os.environ.get("CYTO_TEST_IMPORT_PROBE")
if _out:
    def _dump():
        try:
            with open(_out, "w") as fh:
                fh.write("\\n".join(sorted({m.split(".")[0] for m in list(sys.modules) if m})))
        except Exception:
            pass
    atexit.register(_dump)
'''


def _requirements_import_names():
    """`{import name: distribution}` for every library the env pins."""
    out = {}
    for line in _REQUIREMENTS.read_text().splitlines():
        if "==" not in line or "import=" not in line:
            continue
        dist = line.split("==")[0].strip()
        mod = line.split("import=")[1].split()[0].strip().rstrip(",;")
        out[mod] = dist
    return out


def _modules_the_entry_actually_loaded(run, params):
    import os

    from da_fixtures import _HELPERS_DIR, _LIB_DIR

    probe_dir = run.outputs_dir.parent / "probe_site"
    probe_dir.mkdir(exist_ok=True)
    (probe_dir / "sitecustomize.py").write_text(_IMPORT_PROBE)
    sink = run.outputs_dir.parent / "imported.txt"
    inherited = [p for p in (os.environ.get("PYTHONPATH") or "").split(os.pathsep) if p]
    run.run_ok(params, env_extra={
        "PYTHONPATH": os.pathsep.join(
            [str(probe_dir), str(_HELPERS_DIR), str(_LIB_DIR), *inherited]),
        "CYTO_TEST_IMPORT_PROBE": str(sink),
    })
    assert sink.is_file(), "the import probe never wrote — the sitecustomize hook did not run"
    return {m for m in sink.read_text().split("\n") if m}


#: What each entry's interpreter is EXPECTED to hold, restricted to `requirements.txt` libraries.
#: `direct` is declared in `run.dependencies[]`; `transitive` is pulled in by one of those and is
#: therefore NOT a declaration this package owes. Adding a name here is a deliberate act with a
#: reason attached — that is the whole point of a ratchet.
_EXPECTED_ENV_IMPORTS = {
    "da.clusters": {
        "direct": {"numpy", "pandas", "scipy", "statsmodels"},
        # DECLARED and required, but imported only when that ENGINE is selected. The probe runs
        # `nb_glm` (the arm that exists on every host), so pydeseq2 legitimately does not appear.
        # Its import path is exercised by the pydeseq2 arm of the suite.
        "engine_gated": {"pydeseq2"},
        # `anndata` via pydeseq2; `packaging` via `cyto_deps`, which uses it to resolve the
        # declared version ranges and is pinned in the recipe for exactly that reason.
        # `pyarrow` arrives with `pandas`, which this entry DECLARES (#305). `pandas/compat/
        # pyarrow.py` runs `import pyarrow as pa` at `import pandas` time, guarded by
        # `except ImportError`. MEASURED, not assumed: the stack at the first
        # `find_spec("pyarrow")` inside the REAL run is `compute/clusters.py:208 import pandas`
        # -> `pandas/__init__.py:26` -> `pandas/compat/__init__.py:29` -> `pandas/compat/
        # pyarrow.py:8`. And the entry does not DEPEND on it: TEST-3 RUNS this entry with pyarrow
        # made unimportable and requires it to complete, which is the spelling-independent form of
        # the claim — three static drafts of it were each defeated by a new spelling, so the
        # guarantee is behavioural and the `ast` scan is kept only as a tripwire.
        #
        # Like `PIL` in the sibling entry, this is a widened OBSERVATION of an UNCHANGED run and
        # not a new dependency: `pyarrow` was ALREADY in the shipped image at 25.0.0 as a hard
        # transitive of the already-pinned `spatialdata==0.7.3` (recorded, `unsquashfs`-verified,
        # at `requirements.txt:158-163`), so every DA run has always loaded it. It became visible
        # to this ratchet only when #163 PINNED it, because the subject set here is derived from
        # the `import=` names `requirements.txt` pins and `observed` is filtered through them.
        # (DERIVED FROM, not exactly: `_requirements_import_names()` does not strip comments, so
        # the recipe's grammar comment is ingested as a pin named `<module>`. Filed as #307; it
        # cannot affect this classification, since no module is ever called that.)
        #
        # It stays UNDECLARED, and that is a deliberate refusal rather than an omission: the entry
        # calls no pyarrow API, and `run.dependencies[]` is a RUNTIME REFUSAL contract
        # (`_lib/cyto_deps.py`) — declaring it would make an unused library a hard requirement and
        # newly refuse runs on any image lacking it (#263 says that image exists). The transitive
        # arm one screen below is what keeps that honest, and TEST-6 re-derives the pull-in.
        #
        # ASSERTED ON EVERY RUN by TEST-3, not merely recorded here: both entries are driven with
        # a `sitecustomize` meta-path finder raising `ModuleNotFoundError` for `pyarrow` and must
        # complete. It must be `ModuleNotFoundError` and not a bare `ImportError` — `sklearn`
        # catches only the former, so a bare `ImportError` makes the neighbourhoods entry look
        # like it HARD-requires pyarrow. It does not. That mistake was made once and it inverted
        # the answer, which is why the probe says so at its definition.
        "transitive": {"anndata", "packaging", "pyarrow"},
    },
    "da.neighbourhoods": {
        "direct": {"numpy", "pandas", "scipy", "statsmodels", "scanpy", "sklearn", "anndata"},
        "engine_gated": {"pydeseq2"},
        # All of these arrive with `scanpy`, which this entry declares and needs for the kNN
        # graph: umap/numba/llvmlite (its embedding + JIT stack), igraph/leidenalg (its graph
        # tools), h5py/zarr (its IO backends). Measured, not assumed.
        # `PIL` arrives with scanpy too, via matplotlib. It was ALWAYS being imported; it became
        # visible to this ratchet only when upstream PINNED pillow (#155, the Visium tissue-image
        # PNG decode), because the subject set of this check is exactly the `import=` names
        # `requirements.txt` pins. Measured, not assumed: `import scanpy` on its own leaves both
        # `matplotlib` and `PIL` in `sys.modules`, and `da.clusters` — which does not import
        # scanpy — never loads it. So this is a widened OBSERVATION of an unchanged run, not a
        # new dependency; `pillow` stays undeclared in `run.dependencies[]`, which the transitive
        # arm of this check asserts one screen below.
        # `pyarrow` is the same widened observation as on `da.clusters` (#305) — see the reason
        # recorded there. It reaches THIS entry one step earlier: the stack at the first
        # `find_spec("pyarrow")` in the real run is `compute/_nhoods.py:73 build_knn` ->
        # `anndata/__init__.py:19` -> `anndata/_core/anndata.py:18` -> `pandas/__init__.py:26` ->
        # `pandas/compat/pyarrow.py:8`, i.e. it still terminates in the DECLARED `pandas`. The
        # DECLARED `scikit-learn` reaches it independently at `sklearn/utils/fixes.py:421`, guarded
        # by `except ModuleNotFoundError`. Measured, not assumed; undeclared, deliberately.
        "transitive": {"umap", "numba", "llvmlite", "igraph", "leidenalg", "h5py", "zarr",
                       "packaging", "PIL", "pyarrow"},
    },
}


def _assert_env_imports(run, analysis_id, params):
    import yaml

    pinned = _requirements_import_names()
    loaded = _modules_the_entry_actually_loaded(run, params)
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    a = next(x for x in manifest["contributes"]["analyses"] if x["id"] == analysis_id)
    declared_dists = {d["library"] for d in a["run"]["dependencies"]}

    observed = {m for m in loaded if m in pinned}
    expected = _EXPECTED_ENV_IMPORTS[analysis_id]
    allowed = expected["direct"] | expected["transitive"] | expected["engine_gated"]

    unexpected = observed - allowed
    assert not unexpected, (
        f"{analysis_id} loaded env libraries nobody expected: {sorted(unexpected)} "
        f"(distributions {sorted(pinned[m] for m in unexpected)}). Either the entry gained a "
        "dependency that is not declared in `run.dependencies[]`, or a declared one started "
        "pulling it in. This check reads `sys.modules` of the REAL run, so it does not care how "
        "the import was spelled.")

    # …and every DIRECT expectation must really be reachable, so this cannot rot into a list of
    # names nothing imports any more.
    missing = expected["direct"] - observed
    assert not missing, (
        f"{analysis_id} declares/expects {sorted(missing)} but the real run never loaded them")
    for m in expected["direct"] | expected["engine_gated"]:
        assert pinned[m] in declared_dists, (
            f"{analysis_id} loads {m!r} (distribution {pinned[m]!r}) but does not DECLARE it")
    for m in expected["transitive"]:
        assert pinned[m] not in declared_dists, (
            f"{analysis_id} lists {m!r} as TRANSITIVE but also declares it — move it to `direct`, "
            "or stop declaring a library the entry does not import itself")


#: The DECLARED library set of each entry, RECORDED (#305).
#:
#: WHAT THIS ADDS, STATED NARROWLY, because the first draft of this comment overstated it and a
#: blind audit caught the overstatement. `test_every_third_party_module_the_compute_imports_is_
#: DECLARED_and_PINNED` above ALREADY reddens on a declaration nothing imports, so a gratuitous
#: extra library was never unguarded — the rejected fix for #305 (declaring `pyarrow`) would have
#: gone red there too, and that is worth knowing rather than claiming credit for.
#:
#: What no existing leg sees is the OTHER two moves: a declaration REMOVED (nothing asserts a
#: library is still declared once the compute stops being scanned for it in that direction), and a
#: declaration ADDED TOGETHER WITH the import that justifies it — the shape of every real
#: dependency creep, which every per-library check is designed to wave through. INV-DA-6 is "NO NEW
#: DEPENDENCY (#83)"; a set is the only thing that can express it.
#:
#: A RECORDED set rather than a diff against the merge base, in the same idiom as
#: `_PY_ENV_TREE_LOCK` next door in `differential-expression` and `_MANIFEST_VERSION_LOCK` in
#: `cell-filter`: a diff expires at merge (`merge-base(origin/main, HEAD)` is HEAD itself once this
#: lands), a recorded set does not. Moving it is a one-line diff a reviewer sees.
_DECLARED_LIBRARIES_LOCK = {
    "da.clusters": frozenset({"numpy", "pandas", "pydeseq2", "scipy", "statsmodels"}),
    "da.neighbourhoods": frozenset({"anndata", "numpy", "pandas", "pydeseq2", "scanpy",
                                    "scikit-learn", "scipy", "statsmodels"}),
}

#: Captures the STACK at the first attempt to import `pyarrow`, from inside the real run. It never
#: resolves anything — `find_spec` returns `None`, so the ordinary finders still do their job — and
#: it removes itself after the first hit so a later re-import cannot overwrite the origin.
_ORIGIN_PROBE = '''
import os, sys, traceback
import importlib.abc
_out = os.environ.get("CYTO_TEST_PYARROW_ORIGIN")
if _out:
    class _Trace(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "pyarrow":
                try:
                    with open(_out, "w") as fh:
                        fh.write("\\n".join(f.filename for f in traceback.extract_stack()))
                except Exception:
                    pass
                try:
                    sys.meta_path.remove(self)
                except Exception:
                    pass
            return None
    sys.meta_path.insert(0, _Trace())
'''


#: Makes `pyarrow` UNIMPORTABLE inside a real run, and RECORDS THAT IT DID — the marker is the
#: positive control both sibling probes in this module already carry (`_modules_the_entry_actually_
#: loaded` asserts "the sitecustomize hook did not run"). It is not optional bookkeeping:
#: `site.execsitecustomize` swallows EVERY exception from a `sitecustomize` behind one stderr line,
#: so a probe that failed to install leaves an ordinary, fully-successful run — and "the entry ran
#: fine without pyarrow" would then be true of a run that had pyarrow all along. That vacuity was
#: demonstrated, not imagined: a blind round broke this probe with a one-character edit and the
#: test stayed green.
#:
#: It raises `ModuleNotFoundError` rather than a bare `ImportError` because `sklearn/utils/fixes.py`
#: catches only the former; a bare `ImportError` makes `da.neighbourhoods` look like it HARD-requires
#: pyarrow when it does not. That mistake was made once, during #305, and it inverted the answer.
#:
#: WHERE THIS DIFFERS FROM REAL ABSENCE, since "exactly what absence does" would be too strong.
#: It blocks the IMPORT and nothing else, so two other ways of asking "is pyarrow here?" still
#: answer yes: `importlib.util.find_spec("pyarrow")` RAISES where real absence returns `None`, and
#: `importlib.metadata.version("pyarrow")` still resolves where real absence raises
#: `PackageNotFoundError` (the distribution metadata is untouched). Code doing soft feature
#: detection either way would behave differently here than in a pyarrow-less image. Nothing under
#: `compute/` calls either DIRECTLY, and code that did would be reaching for the library
#: deliberately — which is the thing under test. `compute/_shared.py` does reach
#: `importlib.metadata.version` transitively, through `cyto_deps.resolve_and_check`, but only ever
#: with DECLARED library names, and `pyarrow` is not one — so the divergence is never activated.
#: The difference is real and is written down rather than glossed; the list is "the ones found",
#: not a proof there is no third.
_BLOCK_PROBE = '''
import os, sys
import importlib.abc
_marker = os.environ.get("CYTO_TEST_BLOCK_PYARROW")
if _marker:
    class _Block(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "pyarrow" or fullname.startswith("pyarrow."):
                raise ModuleNotFoundError("No module named %r" % fullname, name=fullname)
            return None
    sys.meta_path.insert(0, _Block())
    with open(_marker, "w") as _fh:
        _fh.write("installed")
'''


def _bind_entry(analysis_id, clusters_run, neighbourhoods_run):
    """A bound, runnable entry plus its params for the `nb_glm` arm.

    Shared by the two tests #305 added (TEST-3 and TEST-6), which both drive BOTH entries. The two
    TEST-53 ratchet legs below still bind inline: they are pre-existing, they are the guards this
    branch must leave byte-unchanged, and refactoring them into this helper would be exactly the
    kind of incidental edit to a load-bearing guard that #274/#286 are about.
    """
    if analysis_id == "da.clusters":
        from da_fixtures import population_dataset, EXTERNAL

        run = clusters_run()
        pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
        run.add_column(pops, slot="population", name="leiden")
        run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
        run.add_column(samps, slot="sample", name="sample")
        return run, {"method": "nb_glm", "group1": "treat", "group2": "ctrl"}

    assert analysis_id == "da.neighbourhoods", (
        f"unknown analysis id {analysis_id!r} — this used to fall through to the neighbourhoods "
        "branch, which BOUND the wrong entry. Both callers happen to die a screen later on "
        "`_declared_libraries()[analysis_id]`, so nothing silently passed; this fails at the "
        "binding instead, where the id is wrong, rather than in an unrelated lookup.")
    from test_neighbourhoods_end_to_end import _bind as _bind_nhoods

    run = neighbourhoods_run()
    _bind_nhoods(run, samples_per_side=3, n_per_sample=200)
    return run, {"method": "nb_glm", "prop": 0.15}


def _run_with_probe(run, params, probe_src, env_extra, *, name):
    """Drive the REAL entry with `probe_src` installed as a `sitecustomize`."""
    from da_fixtures import _HELPERS_DIR, _LIB_DIR

    probe_dir = run.outputs_dir.parent / name
    probe_dir.mkdir(exist_ok=True)
    (probe_dir / "sitecustomize.py").write_text(probe_src)
    inherited = [q for q in (os.environ.get("PYTHONPATH") or "").split(os.pathsep) if q]
    env = dict(env_extra)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(probe_dir), str(_HELPERS_DIR), str(_LIB_DIR), *inherited])
    return run.run(params, env_extra=env)


#: `cyto_deps.OUTPUT_ID` — the reserved id of the per-run environment record that `augment()`
#: appends to EVERY run's manifest. Imported rather than retyped so it cannot drift.
_RUN_ENVIRONMENT_OUTPUT_ID = cyto_deps.OUTPUT_ID


def _declared_libraries():
    """`{analysis id: {library}}` — read from the manifest, never from a hand-list here."""
    import yaml

    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    return {a["id"]: {d["library"] for d in a["run"]["dependencies"]}
            for a in manifest["contributes"]["analyses"]}


@pytest.mark.parametrize("analysis_id", ["da.clusters", "da.neighbourhoods"])
def test_pyarrow_is_NOT_a_declaration_this_package_owes(
        analysis_id, clusters_run, neighbourhoods_run):
    """TEST-3 [acceptance] [invariant: INV-2] of `.lifecycle/da-pyarrow-transitive` (#305).

    `_EXPECTED_ENV_IMPORTS`'s own definition is that `transitive` is "pulled in by one of those
    and is therefore NOT a declaration this package owes". The ratchet asserts the second half on
    a REAL run; this asserts the FIRST half, and the substantive form of it is not "no file
    mentions the word" but **the entry does not DEPEND on the library** — which is what a
    declaration would assert and what `_lib/cyto_deps.py` would then enforce as a refusal.

    ## THIS TEST IS BEHAVIOURAL BECAUSE THREE STATIC DRAFTS OF IT FAILED, and that is the record

    Draft 1 was `"pyarrow" in path.read_text()`. A blind round reddened it with the COMMENT
    `# note: we do not use pyarrow here` — prose mentions are DELIBERATELY permitted in this
    package (`test_pertpy_and_edger_are_only_ever_REFERENCED_never_imported_by_the_compute`).

    Draft 2 was `_imported_top_level_modules` alone. The next blind round walked through it with
    `getattr(importlib, "import_module")("pyarrow")`, which really loads the library.

    Draft 3 added the pertpy test's walk over non-docstring string constants and bound
    identifiers. The next round walked through THAT with five more spellings —
    `import_module("pyar" + "row")`, `import_module("PYARROW".lower())`, a base64 round-trip, a
    `"".join([...])`, and a literal laundered through a function's own `__doc__` — and, in the
    other direction, reddened a PEP-258 attribute docstring, an idiom already in use two packages
    away. Unbounded false negatives AND real false positives.

    That is the exact failure `_imported_top_level_modules`'s own docstring predicts: "a static
    rule over a general-purpose language has an unbounded evasion space, so zero findings is
    unreachable by construction". A fourth predicate would have been the seventh and eighth
    pattern that docstring refuses to write. So the guarantee moved to where it can be bounded.

    ## What the behavioural leg proves that no scan can

    The entry is RUN with `pyarrow` made unimportable and must still COMPLETE. Every spelling
    above, and every one nobody has thought of, has to reach the import system to load the module,
    so on a code path this drives, a hard direct dependency in ANY of them turns this red — no
    enumeration of spellings, and none possible to evade. The shape it deliberately lets through —
    an import our own code GUARDS — is not a dependency either: a package that runs without a
    library owes no declaration for it, which is precisely INV-2.

    ## The bound, stated exactly, because "spelling-independent" alone would be a false claim

    It is PATH-conditional. It proves the property for the arms it drives, which are `nb_glm` and —
    where `pydeseq2` is installed — the DEFAULT engine. A hard import on a branch neither arm
    reaches is invisible to it, and a blind round proved that by putting one on the pydeseq2 arm
    while the probe drove only `nb_glm`. Adding the default arm closes that case WHEREVER
    `pydeseq2` is installed — it is the engine a run gets when `method` is absent, i.e. most real
    runs — and on a host without it the arm skips and the case is not closed there; a path no arm
    reaches remains uncovered, and the `ast` tripwire is what stands there instead — it
    catches the import STATEMENTS and not the dynamic spellings, so the residual gap is a DYNAMIC
    import on an UNEXERCISED path. That is the honest description; #306 tracks widening the
    ratchet's own transitive arm, which is the only mechanism that could close it without another
    predicate.

    On a host without `pydeseq2` the default arm SKIPS and the bound is correspondingly wider —
    `just check-py` validates against HOST dependencies rather than the pinned rootfs (#241), and
    on this repo's host `pydeseq2` is absent. It is present in the image the recipe describes.

    It also promotes the load-bearing fact from prose to assertion. "Both entries complete with
    pyarrow absent" is the whole reason #305 refused to declare it (declaring makes it a runtime
    REFUSAL via `_lib/cyto_deps.py`), and until now that fact was only recorded in a comment.

    ## The static leg stays, as a TRIPWIRE, which is what this module already calls it

    `_imported_top_level_modules` is fast, needs no subprocess, and names the offending FILE
    rather than just reporting a failed run. It is kept for that and labelled honestly. The
    string-constant walk from draft 3 is GONE, and the trade is stated rather than sold as free: it
    did add real false positives (a PEP-258 attribute docstring, an idiom in live use in
    `anndata-import` and `_lib`), and it did catch one thing neither survivor does — a dynamic
    spelling on a path no arm exercises. Two unbounded-evasion rounds are the evidence that keeping
    it would not have closed that; the behavioural leg closes the exercised paths, a bound that
    widens by driving more arms rather than by writing more patterns.

    THE CONTRAST, as prose and deliberately not as an assertion: `spatial-import-xenium` DOES
    import `pyarrow` (`compute/boundaries.py`, #163) and therefore DOES declare it, with a range
    its own code is supported against. A cross-package assertion would fire red on a stranger's
    branch — the unscoped-guard class #299/#238/#265/#268/#282 has just been removed from this
    tree.
    """
    # ── the TRIPWIRE: import STATEMENTS, over the whole compute tree ─────────────────────
    sources = sorted(_COMPUTE.rglob("*.py"))
    # ANTI-VACUITY by DOMAIN rather than by count: "no compute file imports it" is also what an
    # empty walk reports, and a count floor still passes after a file is deleted.
    found = {path.name for path in sources}
    assert {"clusters.py", "neighbourhoods.py"} <= found, (
        f"the compute walk found {sorted(found)} — with the entries missing there is no subject, "
        "and 'no shipped compute file imports pyarrow' is satisfied by looking at nothing")
    importing = sorted(path.name for path in sources
                       if "pyarrow" in _imported_top_level_modules(path.read_text(), path.name))
    assert not importing, (
        f"{importing} IMPORT `pyarrow`, so it is no longer merely a `pandas` pull-in. Three "
        "things move together, or none of them should: take the name out of that entry's "
        "`transitive` set and into `direct`, DECLARE the distribution in that entry's "
        "`run.dependencies[]` with the range this code is supported against (the way "
        "`spatial-import-xenium` declares it for its parquet reader), and re-record "
        "`_DECLARED_LIBRARIES_LOCK`, which will otherwise go red for the declaration you just "
        "added. This walk covers `compute/` as a whole, which BOTH entries share.")

    # ── the GUARANTEE: the entry does not DEPEND on it, whatever the spelling ────────────
    # BOTH ENGINE ARMS, not just the one that runs everywhere. `_kernel.METHOD_DEFAULT` is
    # `pydeseq2`, which is what a run gets when `params.method` is absent — i.e. the arm most real
    # runs take. A blind round put a hard `pyarrow` import on that arm and every guard in this
    # module stayed green, because the probe only ever drove `nb_glm`. An engine-conditional
    # guarantee is not the guarantee this test claims to make.
    #
    # The DEFAULT arm is reached by OMITTING `method`, so it resolves through
    # `_kernel.METHOD_DEFAULT` rather than through a name copied here that could drift from it.
    # It is skipped, visibly, where `pydeseq2` is not installed: this module's own ratchet calls
    # `nb_glm` "the arm that exists on every host", so a hard failure there would be a false red
    # about the host rather than about the package.
    first_run, base_params = _bind_entry(analysis_id, clusters_run, neighbourhoods_run)
    arms = [("nb_glm", dict(base_params, method="nb_glm"), first_run)]
    if importlib.util.find_spec("pydeseq2") is not None:
        arms.append(("DEFAULT engine",
                     {k: v for k, v in base_params.items() if k != "method"}, None))

    for label, params, prepared in arms:
        run = prepared or _bind_entry(analysis_id, clusters_run, neighbourhoods_run)[0]
        marker = run.outputs_dir.parent / "block_probe_installed.txt"
        proc = _run_with_probe(run, params, _BLOCK_PROBE,
                               {"CYTO_TEST_BLOCK_PYARROW": str(marker)}, name="block_site")
        # POSITIVE CONTROL FIRST. `site.execsitecustomize` swallows every exception from a
        # `sitecustomize`, so without this "the run succeeded" is also what a run that never had
        # pyarrow blocked reports — the assertion below would be trivially true.
        assert marker.is_file(), (
            f"the block probe never installed for `{analysis_id}` [{label}] — `sitecustomize` did "
            "not run, or raised (python swallows that behind one stderr line). Nothing about "
            "pyarrow was tested by this run.\n"
            f"--- stderr ---\n{(proc.stderr or '')[-3000:]}")
        if proc.returncode != 0:
            # ATTRIBUTION, before blaming pyarrow: re-run the SAME params UNBLOCKED. If that fails
            # too, the entry is broken for a reason that has nothing to do with this issue, and
            # saying "this package DEPENDS on pyarrow" would be a misdiagnosis pointing the next
            # reader at the one fix (declaring it) that INV-1 and #263 forbid.
            control, _ = _bind_entry(analysis_id, clusters_run, neighbourhoods_run)
            unblocked = control.run(params)
            assert unblocked.returncode != 0, (
                f"`{analysis_id}` [{label}] FAILED with `pyarrow` unimportable and SUCCEEDED with "
                "it present, so this package DEPENDS on it and the `transitive` classification is "
                "wrong: a library the entry cannot run without is one it owes a declaration for. "
                "Move it to `direct`, declare it in `run.dependencies[]` with a supported range, "
                f"and re-record `_DECLARED_LIBRARIES_LOCK`.\n--- blocked stderr ---\n"
                f"{(proc.stderr or '')[-3000:]}")
            raise AssertionError(
                f"`{analysis_id}` [{label}] fails WITH and WITHOUT pyarrow, so this is not a "
                "pyarrow finding — the entry is broken for an unrelated reason and that reason is "
                f"what to fix.\n--- unblocked stderr ---\n{(unblocked.stderr or '')[-3000:]}")
        # …and it must have DONE THE WORK, not merely exited 0. `outputs` being non-empty is NOT
        # that check and a draft of this line got it wrong: `cyto_deps.augment` ALWAYS appends the
        # `run-environment` record, so the list is non-empty for any run that reaches the writer at
        # all. The real subject is an output that is not that record.
        outputs = run.manifest().get("outputs") or []
        produced = [o for o in outputs if o.get("id") != _RUN_ENVIRONMENT_OUTPUT_ID]
        assert produced, (
            f"`{analysis_id}` [{label}] exited 0 with `pyarrow` unimportable but produced no "
            f"output beyond the `{_RUN_ENVIRONMENT_OUTPUT_ID}` record ({outputs}) — the run did "
            "not do its work, so it did not demonstrate the entry can do it without the library")

    # ── and the declaration side of INV-2 ────────────────────────────────────────────────
    declared = _declared_libraries()
    assert set(declared) == {"da.clusters", "da.neighbourhoods"}, (
        f"expected both entries, read {sorted(declared)}")
    libs = declared[analysis_id]
    # ANTI-VACUITY: the same extraction that finds no `pyarrow` must find the library measured to
    # PULL IT IN. An extractor returning `set()` would otherwise pass the line below.
    assert "pandas" in libs, (
        f"{analysis_id} does not declare `pandas` — the premise of the whole classification is "
        "that pyarrow arrives WITH pandas, so this test can no longer mean anything")
    assert "pyarrow" not in libs, (
        f"{analysis_id} DECLARES `pyarrow`, but the entry runs fine without it. "
        "`run.dependencies[]` is a runtime refusal contract (`_lib/cyto_deps.py`): a library "
        "declared here must resolve, in range, in the image the job actually got, or the run is "
        "refused by name. Declaring one the entry does not need buys nothing and refuses runs on "
        "every image that lacks it (#305, #263).")


@pytest.mark.parametrize("analysis_id", ["da.clusters", "da.neighbourhoods"])
def test_the_pyarrow_pull_in_is_MEASURED_and_not_assumed(
        analysis_id, clusters_run, neighbourhoods_run):
    """TEST-6 [acceptance] [invariant: INV-3] of `.lifecycle/da-pyarrow-transitive` (#305).

    The block comments above say `pyarrow` arrives WITH `pandas`, which the entry declares. This
    re-derives that on every run instead of trusting the sentence, and it does so in the place the
    sentence is about — inside the REAL run, not only in a bare interpreter.

    ## Leg 1, the one that matters: the ORIGIN, from inside the real run

    A `sitecustomize` meta-path finder records the stack at the first attempt to import `pyarrow`
    while `da.clusters` executes. Three things are then asserted, and together they are the whole
    determination #305 asked for:

      · `pyarrow` IS imported by the real run. Without this the classification could ROT
        invisibly: the `transitive` arm of `_assert_env_imports` only widens `allowed` and checks
        the name is not declared — unlike the `direct` arm, it never asserts the name was
        OBSERVED, so a `transitive` entry nothing imports any more stays green forever. A blind
        audit demonstrated exactly that by deleting `"pyarrow"` from both sets on a host where the
        library was unimportable and watching the module stay green. This leg is the targeted
        anti-rot for this one name. (The GENERAL missing arm, and the stale `anndata` entry that
        blocks adding it, are #306 — it cannot land here because it goes red on that entry.)
      · the frame that triggered the FIRST import is NOT in this package. That is the difference
        between the check's two named causes, made executable — cause (2), "the entry gained a
        dependency", would put a `differential-abundance/compute/*.py` frame at the bottom of that
        stack. SCOPED HONESTLY, because a blind round showed the unqualified claim was false: this
        sees the FIRST import only. A direct import that lands after `pandas` has already loaded
        the module never reaches `find_spec` at all, so it is invisible here. TEST-3's static legs
        are what cover that case, and that division of labour is stated in TEST-3's docstring.
      · the frame that triggered it belongs to a library this entry DECLARES. That is cause (1),
        positively identified rather than inferred from cause (2)'s absence.

    ## Leg 2 + 3: the bare-interpreter measurement and its control

    Importing ONLY `pandas` in a fresh `sys.executable` — the same interpreter
    `da_fixtures.DaRun.run` drives the entries with — is enough to put `pyarrow` in `sys.modules`.
    The NEGATIVE CONTROL is what stops that meaning nothing: an interpreter that loads `pyarrow`
    for a reason of its own (a `sitecustomize`, a `.pth` file, a vendored hook) would satisfy leg
    2 with `pandas` doing no work at all, so the same subprocess is asked to import only `numpy`
    and must NOT hold it. The control defends THAT scenario specifically — it is not what makes
    leg 2 non-vacuous in general, since leg 2 already goes red on its own if the pandas import is
    removed.

    ## The one place this test cannot reach, said out loud

    On a host whose interpreter has no `pyarrow` at all, this skips. `just check-py` validates
    against HOST dependencies rather than the pinned rootfs (#241), and the shipped image is
    itself behind the recipe (#263), so that host exists. On it, the two `transitive` entries this
    branch adds are inert — not wrong, just unfalsifiable. The skip is loud and says so.
    """
    pytest.importorskip(
        "pyarrow",
        reason="this interpreter has no pyarrow, so the pull-in is not observable here; the "
               "classification it proves is inert (not wrong) on such a host — #241/#263/#306")

    # ── leg 1: the origin, inside the real run — for BOTH entries ────────────────────────
    # Both, because the block comments record a measured stack for each and a test that ran only
    # one of them would leave the other's "measured, not assumed" as prose. The two reach pyarrow
    # by different paths (`pandas` directly; `anndata` -> `pandas`), and this asserts only the
    # property they share: whoever triggered it, it was a DECLARED library and not this package.
    run, params = _bind_entry(analysis_id, clusters_run, neighbourhoods_run)
    sink = run.outputs_dir.parent / "pyarrow_origin.txt"
    proc = _run_with_probe(run, params, _ORIGIN_PROBE,
                           {"CYTO_TEST_PYARROW_ORIGIN": str(sink)}, name="origin_site")
    assert proc.returncode == 0, (
        f"the traced `{analysis_id}` run failed: {(proc.stderr or '')[-3000:]}")
    assert sink.is_file(), (
        f"the real `{analysis_id}` run never imported `pyarrow`, so the name in this entry's "
        "`transitive` set is stale — nothing pulls it in any more. Remove it (and re-check the "
        "sibling entry), rather than leaving a name the ratchet silently allows forever.")

    frames = [line for line in sink.read_text().splitlines() if line]
    assert any(str(_COMPUTE) in f for f in frames), (
        f"the captured stack {frames} contains no frame in this package's compute — the probe "
        "recorded an import from somewhere other than the run under test, so it proves nothing")
    caller = [f for f in frames
              if "<frozen" not in f and "sitecustomize" not in f and "importlib" not in f]
    assert caller, f"every frame in {frames} was import machinery; no triggering frame to judge"
    trigger = caller[-1]
    assert str(_PKG) not in trigger, (
        f"`pyarrow` was imported from {trigger}, which is INSIDE this package. That is the check's "
        "OTHER cause — the entry gained a direct dependency — and it needs the opposite fix: "
        "declare it. See TEST-3's message for the three things that move together.")

    pinned = _requirements_import_names()
    declared_dists = _declared_libraries()[analysis_id]
    declared_imports = {mod for mod, dist in pinned.items() if dist in declared_dists}
    assert declared_imports, "no declared library resolved to an import name — the map is broken"
    puller = sorted(name for name in declared_imports
                    if f"{os.sep}{name}{os.sep}" in trigger or trigger.endswith(f"{os.sep}{name}.py"))
    assert puller, (
        f"`pyarrow` was imported from {trigger}, which belongs to none of the libraries "
        f"`{analysis_id}` declares ({sorted(declared_imports)}). The `transitive` classification "
        "says it is pulled in BY A DECLARED LIBRARY; if something else is pulling it in, that "
        "something is an undeclared dependency and the classification is wrong.")

    # ── legs 2 + 3: the bare-interpreter measurement and its control ─────────────────────
    def _loaded(statement):
        # A unique SENTINEL, not "the last line": the child's stdout is shared with anything the
        # interpreter itself prints, and parsing `splitlines()[-1]` turned a stray trailing write
        # into a silent `False` that would have surfaced as leg 2 claiming pandas had stopped
        # pulling pyarrow in.
        proc = subprocess.run(
            [sys.executable, "-c",
             f"{statement}\nimport sys\nprint('CYTO_PROBE=%s' % ('pyarrow' in sys.modules))"],
            capture_output=True, text=True)
        assert proc.returncode == 0, (
            f"the probe interpreter failed on {statement!r}: {proc.stderr[-2000:]}")
        hits = [line for line in proc.stdout.splitlines() if line.startswith("CYTO_PROBE=")]
        assert len(hits) == 1, (
            f"expected exactly one probe line for {statement!r}, got {hits} out of "
            f"{proc.stdout[-2000:]!r}")
        return hits[0] == "CYTO_PROBE=True"

    assert _loaded("import pandas"), (
        "`import pandas` no longer leaves `pyarrow` in `sys.modules`, so the reason recorded in "
        "`_EXPECTED_ENV_IMPORTS` for classifying it as a `pandas` pull-in has stopped being true. "
        "Re-measure which declared library pulls it in — leg 1 above names the file — or, if "
        "nothing does any more, take `pyarrow` back OUT of both `transitive` sets rather than "
        "leaving a name nothing imports.")
    assert not _loaded("import numpy"), (
        "the control interpreter holds `pyarrow` after importing only `numpy`, so 'pandas pulls "
        "pyarrow in' is not what leg 2 measured — something in this interpreter loads pyarrow "
        "unconditionally and that measurement proves nothing")


def test_neither_entry_gained_a_DEPENDENCY():
    """TEST-4 [acceptance] [invariant: INV-1] of `.lifecycle/da-pyarrow-transitive` (#305).

    INV-DA-6 — "NO NEW DEPENDENCY (#83)" — asserted over the DECLARED SET rather than per-library.
    See `_DECLARED_LIBRARIES_LOCK` above for what that adds over the per-library legs and what it
    does not.

    SCOPED, deliberately: this is the DECLARATION surface only. The other surface a dependency can
    arrive on is the env recipe itself, and it is guarded elsewhere — a byte appended to
    `env-rootfs/single-cell/requirements.txt` reddens
    `differential-expression/tests/test_rootfs_deps_r.py::test_the_python_env_recipe_content_is_
    locked_to_the_bytes_main_ships`, whose `_PY_ENV_TREE_LOCK` records that recipe's content
    digest. Claiming INV-DA-6 "in its whole form" here would be claiming that lock's work.
    """
    # ANTI-VACUITY FIRST, so it is REACHABLE. Behind the comparison loop these two assertions were
    # dead — every mutation reddened the loop before reaching them — and the comment that said
    # they closed a hole was false. They guard the LITERAL, so they must run before it is used.
    assert all(locked for locked in _DECLARED_LIBRARIES_LOCK.values()), (
        "a locked set is empty — an empty lock would 'match' a manifest whose dependencies were "
        "all deleted, which is the removal this test exists to catch")
    assert (_DECLARED_LIBRARIES_LOCK["da.clusters"]
            != _DECLARED_LIBRARIES_LOCK["da.neighbourhoods"]), (
        "the two entries' locked sets are identical — they are not: `da.clusters` takes three "
        "metadata columns and no matrix, so it declares neither `scanpy` nor `scikit-learn`. "
        "Identical halves mean the lock was re-recorded from one entry and pasted over both")

    declared = _declared_libraries()
    assert set(declared) == set(_DECLARED_LIBRARIES_LOCK), (
        f"the manifest declares for {sorted(declared)}, the lock records "
        f"{sorted(_DECLARED_LIBRARIES_LOCK)} — an analysis was added or removed")
    for analysis_id, locked in _DECLARED_LIBRARIES_LOCK.items():
        got = declared[analysis_id]
        assert got == set(locked), (
            f"{analysis_id} declares {sorted(got)}, not the recorded {sorted(locked)}. "
            f"Added: {sorted(got - set(locked))}; removed: {sorted(set(locked) - got)}. "
            "INV-DA-6 is `no new dependency`: this package is implemented ON the pinned stack. "
            "If a dependency genuinely changed, re-record this set in the SAME commit, with the "
            "reason — and check first whether the library is one the compute IMPORTS or one a "
            "declared library merely PULLS IN (#305); the second kind belongs in "
            "`_EXPECTED_ENV_IMPORTS[...]['transitive']` and is not declared at all.")


def test_what_da_clusters_actually_imports_matches_what_it_declares(clusters_run):
    """TEST-53 [invariant: INV-DA-6] — behavioural, on `da.clusters`.

    TEST-1 [acceptance] [invariant: INV-4] of `.lifecycle/da-pyarrow-transitive` (#305): the
    leg that was RED on `origin/main` @ `45acbdfd`. Precisely what moved, since "nothing was
    relaxed" would be too strong a claim: `allowed` gained one name, in the `transitive` arm,
    in the expectation DATA. The MECHANISM is byte-unchanged — the probe, the `sys.modules`
    read of the real run, the requirements-derived subject set, and both anti-rot assertions.
    """
    from da_fixtures import population_dataset, EXTERNAL

    run = clusters_run()
    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    _assert_env_imports(run, "da.clusters",
                        {"method": "nb_glm", "group1": "treat", "group2": "ctrl"})


def test_what_da_neighbourhoods_actually_imports_matches_what_it_declares(neighbourhoods_run):
    """TEST-53 [invariant: INV-DA-6] — behavioural, on `da.neighbourhoods`.

    TEST-2 [acceptance] [invariant: INV-4] of `.lifecycle/da-pyarrow-transitive` (#305) —
    the second of the two legs #305 reported red, on the same terms as TEST-1.
    """
    from test_neighbourhoods_end_to_end import _bind as _bind_nhoods

    run = neighbourhoods_run()
    _bind_nhoods(run, samples_per_side=3, n_per_sample=200)
    _assert_env_imports(run, "da.neighbourhoods", {"method": "nb_glm", "prop": 0.15})
