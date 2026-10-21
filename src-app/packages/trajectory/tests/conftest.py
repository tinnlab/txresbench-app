#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the `trajectory` off-sandbox run harness — mirrors
`clustering/tests/conftest.py`. The staging/read-back machinery lives in
`trajectory_fixtures.py` (imported by name) so `from conftest import ...` cannot pick up the
rootdir conftest."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trajectory_fixtures import DptRun, PagaRun  # noqa: E402


@pytest.fixture
def paga_run(tmp_path):
    counter = {"n": 0}

    def make() -> PagaRun:
        counter["n"] += 1
        return PagaRun(tmp_path / f"paga{counter['n']}")

    return make


@pytest.fixture
def dpt_run(tmp_path):
    counter = {"n": 0}

    def make() -> DptRun:
        counter["n"] += 1
        return DptRun(tmp_path / f"dpt{counter['n']}")

    return make
