#!/usr/bin/env python3
"""Every module a STAGED helper imports must itself be staged.

## Why this exists

`_helpers/alignment.py` gained `import cyto_columns` (from `_lib`) with the C4 missing-level
mechanism. That is a SUPPORTED direction — `PY_HELPER_FILES` stages every helper FLAT into
one `/code` directory, so the `_helpers`/`_lib` split is a source-tree lifecycle distinction
and not an import boundary — and the sandbox resolved it correctly on the first real run.

But it broke a test that executed `alignment.py` with only `_helpers` importable, and it
broke it in the shape `BASE.md` H17 names: **a path that works because whole package roots
happen to be importable.** The runtime was right and the test's model of it was wrong.

So the rule is written where a runner can honour it (the `PY_HELPER_FILES` comment) AND
checked here, because a rule in a comment is one the next cross-package import will not read.

## What it checks, and what it deliberately does not

It reads the STAGING TABLE out of the Rust source — the table is DATA, not prose, and a
hand-maintained Python copy of it would be a second source of truth that goes stale silently
(the failure this repo has paid for repeatedly). The scrape carries a vacuity guard: an empty
table would approve every import in the tree.

It does NOT check that the import graph is acyclic or layered. That is a design question this
test has no opinion on; what it enforces is only that a staged module cannot import something
the sandbox will not give it — which is `ModuleNotFoundError` at process start, surfacing as
an opaque job failure with no hint of the cause.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest

PACKAGES = Path(__file__).resolve().parents[2]
STAGING_TABLE = (
    PACKAGES.parent / "server" / "src" / "modules" / "sandbox" / "processors" / "mod.rs"
)


def staged_modules() -> dict[str, Path]:
    """`{module name: source path}` for every entry in `PY_HELPER_FILES`."""
    source = STAGING_TABLE.read_text()
    block = re.search(r"pub const PY_HELPER_FILES[^=]*=\s*&\[(.*?)\n\];", source, re.S)
    assert block, f"could not find PY_HELPER_FILES in {STAGING_TABLE}"
    entries = re.findall(
        r'\(\s*"([^"]+\.py)"\s*,\s*(RESERVED_\w+_PACKAGE)\s*,\s*"([^"]+\.py)"\s*,?\s*\)',
        block.group(1),
    )
    # VACUITY GUARD: an empty scrape would approve every import in the tree.
    assert len(entries) >= 5, f"only {len(entries)} staged entries scraped: {entries}"
    package_dir = {"RESERVED_HELPER_PACKAGE": "_helpers", "RESERVED_LIB_PACKAGE": "_lib"}
    out = {}
    for staged_name, package_const, rel in entries:
        directory = package_dir.get(package_const)
        assert directory, f"unknown reserved package {package_const!r}"
        out[Path(staged_name).stem] = PACKAGES / directory / rel
    return out


STAGED = staged_modules()


def top_level_imports(path: Path) -> set[str]:
    """Module names imported at MODULE SCOPE — the ones that must resolve at process start.

    Function-local imports are deliberately excluded: they resolve when called, and a helper
    that imports something lazily inside a branch nothing takes is not a staging failure.
    """
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in tree.body:                       # module scope ONLY
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


@pytest.mark.parametrize("module", sorted(STAGED))
def test_a_staged_helper_imports_only_STDLIB_or_other_STAGED_modules(module):
    path = STAGED[module]
    if not path.is_file():                       # pragma: no cover - table names a missing file
        pytest.fail(f"{module} is staged from {path}, which does not exist")
    unresolved = {
        name
        for name in top_level_imports(path)
        if name not in STAGED
        and name not in sys.stdlib_module_names
        and name not in {"numpy", "pandas", "zarr", "scipy", "anndata", "pyarrow", "h5py"}
    }
    assert not unresolved, (
        f"{path.name} imports {sorted(unresolved)} at module scope, which `PY_HELPER_FILES` "
        "does not stage. In the sandbox that is `ModuleNotFoundError` at process start — an "
        "opaque job failure with no hint of the cause. Add it to the staging table, or do "
        "not import it."
    )


def test_the_C4_cross_package_import_is_the_case_this_guards():
    """The specific import that motivated this, asserted so the guard is not vacuous.

    `_helpers/alignment.py` importing `_lib/cyto_columns` is the supported direction — one
    definition of the missing-level collision rule rather than two that can diverge. If this
    ever stops being true the guard above still holds, but this says which case taught it.
    """
    assert "cyto_columns" in top_level_imports(STAGED["alignment"]), (
        "alignment.py no longer imports cyto_columns — if the collision rule was COPIED "
        "back, two implementations can diverge and a source's own NA and the unified NA "
        "resolve differently"
    )
    assert "cyto_columns" in STAGED, "cyto_columns is not staged, so that import cannot work"
