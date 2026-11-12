#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the DA off-sandbox run harness (mirrors clustering/tests/conftest.py)."""
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PACKAGES = _PKG.parent
# The compute dir (`_regime`/`_kernel`/`_nhoods`/`_shared`) + `_lib` on the path, so a unit test
# can `import _kernel` and the compute's own `import txr_columns` resolves — the same staging the
# sandbox does into `/code`.
for _p in (str(_HERE), str(_PKG / "compute"), str(_PACKAGES / "_lib")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from da_fixtures import DaRun, CLUSTERS, NEIGHBOURHOODS  # noqa: E402


@pytest.fixture
def clusters_run(tmp_path):
    counter = {"n": 0}

    def make() -> DaRun:
        counter["n"] += 1
        return DaRun(tmp_path / f"clusters{counter['n']}", CLUSTERS)

    return make


@pytest.fixture
def neighbourhoods_run(tmp_path):
    counter = {"n": 0}

    def make() -> DaRun:
        counter["n"] += 1
        return DaRun(tmp_path / f"nhoods{counter['n']}", NEIGHBOURHOODS)

    return make
