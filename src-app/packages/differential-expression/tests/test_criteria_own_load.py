#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 [covers: ITEM-4, ITEM-5, ITEM-7] — `de_fixtures.import_own("_criteria")` bypasses
a pre-seeded decoy in `sys.modules`.

The currently-silent DE-victim-of-embedding collision (DECISIONS.md DEC-2/DEC-3): DE's bare
`import _criteria` used to resolve through the flat namespace to embedding's vendored copy in
a shared pytest session, masked only because the two files are byte-identical today. This
proves `import_own` loads DE's OWN `compute/_criteria.py` under its namespaced key even when
the flat name is poisoned with a decoy, and leaves the flat name untouched — so this test
itself never leaks state into later tests in the same session.
"""
import sys
import types
from pathlib import Path

from de_fixtures import import_own


def test_import_own_criteria_bypasses_a_preseeded_decoy():
    decoy = types.ModuleType("_criteria")
    assert not hasattr(decoy, "criteria_keep_mask")
    prior = sys.modules.get("_criteria")
    sys.modules["_criteria"] = decoy
    try:
        crit = import_own("_criteria")
        # DE's OWN vendored kernel (differential-expression/compute/_criteria.py), not the decoy.
        assert callable(crit.criteria_keep_mask)
        # ...and it is literally DE's own file: embedding's copy is byte-identical except for
        # the module docstring, so `callable(...)` alone cannot tell the two apart — only the
        # resolved `__file__` can prove which package's copy was loaded.
        assert Path(crit.__file__).resolve() == (
            Path(__file__).resolve().parents[1] / "compute" / "_criteria.py")
        # the flat name is untouched: still the decoy, never overwritten by the load.
        assert sys.modules["_criteria"] is decoy
    finally:
        if prior is None:
            sys.modules.pop("_criteria", None)
        else:
            sys.modules["_criteria"] = prior
