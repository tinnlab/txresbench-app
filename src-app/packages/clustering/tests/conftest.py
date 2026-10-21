#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the `clustering` off-sandbox run harness — mirrors
`embedding/tests/conftest.py`. The staging/read-back machinery lives in
`clustering_fixtures.py` (imported by name) so `from conftest import …` cannot pick up the
rootdir conftest."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clustering_fixtures import ClusterRun  # noqa: E402


@pytest.fixture
def cluster_run(tmp_path):
    counter = {"n": 0}

    def make() -> ClusterRun:
        counter["n"] += 1
        return ClusterRun(tmp_path / f"cluster{counter['n']}")

    return make
