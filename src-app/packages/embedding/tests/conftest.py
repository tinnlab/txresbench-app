#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the `embedding` off-sandbox run harness (ITEM-28) — mirrors
`qc/tests/conftest.py`. The staging/read-back machinery lives in `embedding_fixtures.py`
(imported by name) so `from conftest import …` cannot pick up the rootdir conftest."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embedding_fixtures import ReduceRun, VisualizeRun, seam_available  # noqa: E402


@pytest.fixture
def require_seam():
    """Gate the REAL Harmony test (TEST-33) on the env-rootfs seam. This is a conditional
    on TOOLING AVAILABILITY, not a way to go green: with `TXR_ENV_ROOTFS_SQUASHFS` pointed
    at a rebuilt single-cell rootfs (harmonypy + scikit-misc), it runs for real (DEC-14).
    Only a host without the seam skips — and that skip names exactly what to set."""
    if not seam_available():
        pytest.skip(
            "TEST-33 needs the harmonypy env-rootfs seam: set TXR_ENV_ROOTFS_SQUASHFS to a "
            "rebuilt single-cell rootfs squashfs (harmonypy + scikit-misc) + install bwrap "
            "+ squashfuse. harmonypy ships only in the rootfs, never the host interpreter.")
    return True


@pytest.fixture
def reduce_run(tmp_path):
    counter = {"n": 0}

    def make() -> ReduceRun:
        counter["n"] += 1
        return ReduceRun(tmp_path / f"reduce{counter['n']}")

    return make


@pytest.fixture
def visualize_run(tmp_path):
    counter = {"n": 0}

    def make() -> VisualizeRun:
        counter["n"] += 1
        return VisualizeRun(tmp_path / f"visualize{counter['n']}")

    return make
