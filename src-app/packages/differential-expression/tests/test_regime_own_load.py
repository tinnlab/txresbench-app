#!/usr/bin/env python3
# ruff: noqa
"""TEST-4 [covers: ITEM-4, ITEM-6, ITEM-7] — `de_fixtures.import_own("_regime")` bypasses
a pre-seeded decoy in `sys.modules`.

The latent `_regime` collision `differential-abundance/tests/da_modules.py`'s own docstring
names as still open: DE and DA both ship a `compute/_regime.py`, and a bare `import _regime`
in a shared pytest session resolves to whichever copy won the sys.path race. This proves
`import_own` loads DE's OWN `compute/_regime.py` under its namespaced key even when the flat
name is poisoned with a decoy, and leaves the flat name untouched — so this test itself never
leaks state into later tests in the same session.
"""
import sys
import types
from pathlib import Path

from de_fixtures import import_own


def test_import_own_regime_bypasses_a_preseeded_decoy():
    decoy = types.ModuleType("_regime")
    assert not hasattr(decoy, "classify")
    prior = sys.modules.get("_regime")
    sys.modules["_regime"] = decoy
    try:
        regime = import_own("_regime")
        # DE's OWN classifier (differential-expression/compute/_regime.py), not the decoy.
        assert callable(regime.classify)
        # ...and it is literally DE's own file: differential-abundance's copy is byte-identical,
        # so `callable(...)` alone cannot tell the two apart — only the resolved `__file__` can
        # prove which package's copy was loaded.
        assert Path(regime.__file__).resolve() == (
            Path(__file__).resolve().parents[1] / "compute" / "_regime.py")
        # the flat name is untouched: still the decoy, never overwritten by the load.
        assert sys.modules["_regime"] is decoy
    finally:
        if prior is None:
            sys.modules.pop("_regime", None)
        else:
            sys.modules["_regime"] = prior
