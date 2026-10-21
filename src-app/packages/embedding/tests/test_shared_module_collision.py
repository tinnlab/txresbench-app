#!/usr/bin/env python3
# ruff: noqa
"""TEST-1/TEST-2 [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-7] — `import_own` bypasses a
pre-seeded decoy in `sys.modules`.

The whole point of the #567 defect is cross-test `sys.modules` leakage: a bare `import
_shared` / `import _criteria` in a shared pytest session resolves through the flat namespace
to whichever package's copy won the sys.path race. These tests prove
`embedding_fixtures.import_own` loads embedding's OWN module under its namespaced key even
when the flat name is already poisoned with a decoy, and that it leaves the flat name
untouched — so this test itself never leaks state into later tests in the same session
(the exact class of leak it exists to guard against).

TEST-7 [invariant: INV-3] — these decoy-preseed tests are ALSO the executable proof that
`import_own`'s namespaced-key mechanism is load-bearing (INV-3: "the fix must be
independently, mechanically PROVEN enforced"): each test proves the SAME class of regression
the branch's SELF-REVERT PROOF (`.lifecycle/567/TEST_RESULTS.md`) demonstrates via `git
revert`, just via a decoy-seeded `sys.modules` instead of an actual git revert — both are
"poison the mechanism and confirm detection" proofs of the same invariant.
"""
import sys
import types
from pathlib import Path

from embedding_fixtures import import_own


def test_import_own_shared_bypasses_a_preseeded_decoy():
    decoy = types.ModuleType("_shared")
    assert not hasattr(decoy, "DT_EMBEDDING")
    prior = sys.modules.get("_shared")
    sys.modules["_shared"] = decoy
    try:
        shared = import_own("_shared")
        # embedding's OWN module, not the decoy — and not DE's copy either.
        assert shared.DT_EMBEDDING == ("embedding", "chunked-dense")
        # the flat name is untouched: still the decoy, never overwritten by the load.
        assert sys.modules["_shared"] is decoy
    finally:
        if prior is None:
            sys.modules.pop("_shared", None)
        else:
            sys.modules["_shared"] = prior


def test_import_own_criteria_bypasses_a_preseeded_decoy():
    decoy = types.ModuleType("_criteria")
    assert not hasattr(decoy, "criteria_keep_mask")
    prior = sys.modules.get("_criteria")
    sys.modules["_criteria"] = decoy
    try:
        crit = import_own("_criteria")
        # embedding's OWN vendored kernel (compute/_criteria.py), not the decoy.
        assert callable(crit.criteria_keep_mask)
        # ...and it is literally embedding's own file: DE's copy is byte-identical except for
        # the module docstring, so `callable(...)` alone cannot tell the two apart — only the
        # resolved `__file__` can prove which package's copy was loaded.
        assert Path(crit.__file__).resolve() == (
            Path(__file__).resolve().parents[1] / "compute" / "_criteria.py")
        assert sys.modules["_criteria"] is decoy
    finally:
        if prior is None:
            sys.modules.pop("_criteria", None)
        else:
            sys.modules["_criteria"] = prior
