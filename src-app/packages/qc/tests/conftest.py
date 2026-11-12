#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the `qc` compute (ITEM-17 / ITEM-24) — the FIXTURE only.

Mirrors `anndata-import/tests/test_fidelity.py`: it drives the REAL entry script as a
subprocess through the only seam that runs it outside bwrap (`TXR_INPUTS_DIR` /
`TXR_OUTPUTS_DIR`), with `_lib` + `_helpers` on `PYTHONPATH` exactly as the sandbox
runner stages them into `/code`.

What it does NOT do is stage inputs by NAME. Every input is declared in
`/inputs/inputs.json` as `{slot, kind, content_hash, sandbox_path}` — the same wire
shape `server/src/modules/sandbox/inputs.rs::render_inputs_json` writes — and the mount
name defaults to a MEANINGLESS `in0`/`in1`/… precisely so a compute that resolves by
filename suffix cannot pass. The runner names each mount from the artifact it is
mounting (ITEM-23); the compute's only contract is slot → path.

A matrix input is a MULTIFILE CSC Zarr store (`txr_csc.write_csc_zarr`), which is what
`single-cell/expression` actually is — never an `.h5ad`.

The staging/read-back machinery itself lives in `qc_fixtures.py` — see its header for why.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qc_fixtures import QcRun  # noqa: E402


@pytest.fixture
def qc_run(tmp_path):
    """Return a callable making a fresh `QcRun` (several per test is fine)."""
    counter = {"n": 0}

    def make() -> QcRun:
        counter["n"] += 1
        return QcRun(tmp_path / f"run{counter['n']}")

    return make
