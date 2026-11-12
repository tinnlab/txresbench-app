#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the DE off-sandbox run harness (mirrors clustering/tests/conftest.py)."""
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
# The compute dir (`_regime`/`_methods`/`_pseudobulk`) + `_lib` on the path, so a unit test can
# `import _regime` and the compute's own `import txr_columns` resolves — the same staging the
# sandbox does into `/code`.
for _p in (str(_HERE), str(_PKG / "compute"), str(_PROCESSORS / "_lib")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from de_fixtures import DeRun, MARKERS, COMPARE  # noqa: E402


@pytest.fixture
def markers_run(tmp_path):
    counter = {"n": 0}

    def make() -> DeRun:
        counter["n"] += 1
        return DeRun(tmp_path / f"markers{counter['n']}", MARKERS)

    return make


@pytest.fixture
def compare_run(tmp_path):
    counter = {"n": 0}

    def make() -> DeRun:
        counter["n"] += 1
        return DeRun(tmp_path / f"compare{counter['n']}", COMPARE)

    return make
