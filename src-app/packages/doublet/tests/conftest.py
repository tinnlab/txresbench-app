#!/usr/bin/env python3
# ruff: noqa
"""Fixtures for the `doublet` off-sandbox run harness — mirrors `embedding/tests/conftest.py`.
The staging/read-back machinery lives in `doublet_fixtures.py` (imported by name) so
`from conftest import ...` cannot pick up the rootdir conftest.

── Why this package's test modules carry a `test_doublet_` prefix ──────────────────────
The canonical runner is `cd src-app/packages && python3 -m pytest -q` (what `just check-py`
runs), which anchors ONE rootdir over every package. No `tests/` directory here has an
`__init__.py`, so pytest names each test module by its BASENAME alone — and two packages
owning `tests/test_manifest_shape.py` is then an import-file mismatch that ABORTS COLLECTION
FOR THE WHOLE TREE, not just for the second file.

That is already the state of the tree: `clustering`, `differential-expression` and
`embedding` collide with each other on nine basenames today, so `just check-py` fails
collection on `origin/main` with 11 errors before this package exists. Reported as its own
finding; fixing it means renaming files in three packages this branch may not touch.

What this package CAN do is not make it worse, so every module whose natural basename is
already taken elsewhere carries the package name. The suites this package alone owns
(`test_parity`, `test_per_sample`, `test_absence`, `test_ground_truth`, …) keep their plain
names because they collide with nothing. Check before adding one:

    ls */tests/*.py | xargs -n1 basename | sort | uniq -d
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from doublet_fixtures import DetectRun  # noqa: E402


@pytest.fixture
def detect_run(tmp_path):
    counter = {"n": 0}

    def make() -> DetectRun:
        counter["n"] += 1
        return DetectRun(tmp_path / f"detect{counter['n']}")

    return make
