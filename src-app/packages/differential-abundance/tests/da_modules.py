#!/usr/bin/env python3
# ruff: noqa
"""Load THIS package's compute modules by PATH, never by their bare flat name.

THE DEFECT THIS CLOSES. Six packages ship a `compute/_shared.py` and two ship a
`compute/_regime.py`. Each package's conftest puts its own `compute/` on `sys.path`, and each
package's compute entry does `import _shared` — which binds the FLAT name `_shared` in
`sys.modules`. In a whole-tree run the first suite to import wins, and every later package
silently gets someone else's module. Alphabetically `clustering` runs first, so
`differential-abundance`'s tests were resolving `_shared` to `clustering/compute/_shared.py`:

    AttributeError: module '_shared' has no attribute 'write_da_result'
    ImportError: cannot import name 'COVARIATE_SLOT_PREFIX' from '_shared'
                 (.../packages/clustering/compute/_shared.py)
    TypeError: ceiling_refuse_if_over() got an unexpected keyword argument 'prop'

Three properties of that failure are worth stating, because they are why this module exists
rather than three local edits:

  * It is ORDER-DEPENDENT. The tests pass in isolation and fail in the whole tree, so
    "I re-ran it on its own and it was fine" does not clear it — that is exactly what an
    order-dependent collision predicts.
  * `--import-mode=importlib` does NOT fix it. That controls how pytest names TEST modules; a
    plain `import _shared` inside a test body still goes through the flat `sys.modules`
    namespace. Measured: both import modes fail identically.
  * The three that failed are not the whole surface. `_regime` collides between
    `differential-abundance` and `differential-expression` and simply has not fired yet, because
    of import order. Patching only the three observed failures would leave a latent identical
    bug whose next appearance is a package-rename away — the same "fix the spelling you thought
    of" trap that this package's own guards were rebuilt to escape.

So the fix is to stop using the ambiguous name at all. `import_own("_shared")` loads
`differential-abundance/compute/_shared.py` under the unique module name
`da_own__shared`, which no other package can claim.

THE `_regime` CASE IS WORSE THAN THE THREE THAT FAILED, AND IS WHY #237 IS A CORRECTNESS ISSUE
RATHER THAN A NAMING INCONVENIENCE. `differential-expression` also ships a `compute/_regime.py`
— it is the file this package's copy is VENDORED FROM — and `tests/test_regime_parity.py` exists
to assert the two are byte-identical. If the flat name resolved to DE's copy, that test would
compare DE against DE and PASS. Not "fail to catch a defect": its success would be CAUSED by the
defect, a byte-parity guard reporting perfect parity at exactly the moment it lost its subject.
Demonstrated directly rather than reasoned about:

    sys.path.insert(0, "differential-expression/compute"); import _regime as FIRST
    sys.path.insert(0, "differential-abundance/compute");  import _regime as DA_would_get
    FIRST is DA_would_get   ->   True

It has not fired only because `differential-abundance` sorts alphabetically before
`differential-expression`, so DA's copy happens to win the flat name. That is one package rename
away from silent. Whoever takes #237 across the other four packages should treat this as the
motivating case: the loud `AttributeError`s are the benign end of this bug, and the quiet
tautology is the dangerous end.

WHAT THIS DOES NOT CHANGE. Production is untouched and must stay untouched: the sandbox stages
ONE package's compute into a flat `/code` dir, where `import _shared` is unambiguous and
correct. This is a test-harness concern only — the ambiguity exists solely because a pytest
process holds every package's `compute/` on one `sys.path` at once.
"""
import importlib.util
import sys
from pathlib import Path

_COMPUTE = Path(__file__).resolve().parent.parent / "compute"


def import_own(name):
    """This package's `compute/<name>.py`, under a name no sibling package can collide with."""
    unique = f"da_own_{name}"
    if unique in sys.modules:
        return sys.modules[unique]
    path = _COMPUTE / f"{name}.py"
    if not path.is_file():
        raise ModuleNotFoundError(
            f"differential-abundance ships no compute/{name}.py — this helper deliberately does "
            f"NOT fall back to the flat `import {name}`, because a silent fallback would restore "
            "exactly the cross-package ambiguity it exists to remove")
    spec = importlib.util.spec_from_file_location(unique, path)
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec so a self-referential import inside the module resolves to itself.
    sys.modules[unique] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(unique, None)
        raise
    return module
