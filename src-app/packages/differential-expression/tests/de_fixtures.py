#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the DE compute (mirrors clustering_fixtures.py / DEC-11).

Drives the REAL `compute/markers.py` / `compute/compare.py` as a SUBPROCESS through the
`TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR` seam, with `_lib` on `PYTHONPATH` exactly as the sandbox
stages `/code`. Every input is declared in `/inputs/inputs.json` with a MEANINGLESS `in0`/…
mount name, so a compute that resolves by filename suffix cannot pass.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
_LIB_DIR = _PROCESSORS / "_lib"
_HELPERS_DIR = _PROCESSORS / "_helpers"
_COMPUTE = _PKG / "compute"

MARKERS = _COMPUTE / "markers.py"
COMPARE = _COMPUTE / "compare.py"


def import_own(name):
    """This package's `compute/<name>.py`, under a name no sibling package can collide with.

    Mirrors `differential-abundance/tests/da_modules.py::import_own` (#237) exactly: several
    packages ship a `compute/_criteria.py` / `compute/_regime.py`, and a bare `import _criteria`
    in a shared pytest session resolves through the flat `sys.modules` namespace to whichever
    package's copy won the sys.path race (embedding ships its own vendored `_criteria.py`).
    Loading under the namespaced key `de_own_<name>` makes the resolution unambiguous.
    Deliberately does NOT fall back to the flat `import <name>` on failure, because a silent
    fallback would restore exactly the cross-package ambiguity this helper exists to remove.
    """
    unique = f"de_own_{name}"
    if unique in sys.modules:
        return sys.modules[unique]
    path = _COMPUTE / f"{name}.py"
    if not path.is_file():
        raise ModuleNotFoundError(
            f"differential-expression ships no compute/{name}.py — this helper deliberately does "
            f"NOT fall back to the flat `import {name}`, because a silent fallback would restore "
            "exactly the cross-package ambiguity it exists to remove")
    spec = importlib.util.spec_from_file_location(unique, path)
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec so a self-referential import inside the module resolves to itself.
    sys.modules[unique] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(unique, None)
        raise
    return module


sys.path.insert(0, str(_LIB_DIR))
import txr_columns  # noqa: E402
import txr_csc  # noqa: E402
import txr_zarr  # noqa: E402
import txr_zarr_read  # noqa: E402


def cells_digest(n: int) -> str:
    return txr_zarr.key_sequence_digest([f"cell-{i}" for i in range(n)])


def write_expression_store(dest: Path, matrix, *, datatype=None) -> dict:
    """A fixture `single-cell/expression` CSC store. `datatype` stamps `attributes.txr.datatype`
    so the INV-13 raw-counts refusal can be exercised with a normalized layer."""
    import scipy.sparse as sp
    m = sp.csr_matrix(np.asarray(matrix, dtype=np.float32))
    structure = txr_csc.write_csc_zarr(txr_csc.ArraySource(m), dest, axes=("cells", "genes"))
    if datatype is not None:
        zj = dest / "zarr.json"
        doc = json.loads(zj.read_text())
        txr = doc.setdefault("attributes", {}).setdefault("txr", {})
        txr["datatype"] = datatype
        zj.write_text(json.dumps(doc, indent=2))
    return structure


def write_column_store(dest: Path, values, *, name="col", provenance=None) -> dict:
    """A fixture categorical `metadata-column`. `provenance` (a dict) is stamped into the store's
    group `attributes.txr` — e.g. `{"clustering": {...}}` (matrix-derived ⇒ R2) or
    `{"external": True}` (external ⇒ R1/R3)."""
    import pandas as pd
    series = pd.Categorical([str(v) for v in values])
    structure, meta = txr_columns.write_metadata_column(
        dest.parent, dest.name, name, pd.Series(series), axis="cells")
    if provenance:
        zj = dest / "zarr.json"
        doc = json.loads(zj.read_text())
        txr = doc.setdefault("attributes", {}).setdefault("txr", {})
        txr.update(provenance)
        zj.write_text(json.dumps(doc, indent=2))
    return structure


class DeRun:
    def __init__(self, base: Path, script: Path):
        self.base = base
        self.script = script
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    def _mount(self, mount):
        if mount is not None:
            return mount
        name = f"in{self._n}"
        self._n += 1
        return name

    def _declare(self, slot, mount, content_hash=None):
        self._entries.append({"slot": slot, "kind": "artifact-prefix",
                              "content_hash": content_hash or f"sha256:{'0' * 64}",
                              "sandbox_path": f"/inputs/{mount}"})

    def add_expression(self, matrix, *, slot="expression", datatype=None, mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_expression_store(dest, matrix, datatype=datatype)
        self._declare(slot, mount)
        return dest

    def add_column(self, values, *, slot, name="col", provenance=None, mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_column_store(dest, values, name=name, provenance=provenance)
        self._declare(slot, mount)
        return dest

    def run(self, params=None, *, env_extra=None):
        (self.inputs_dir / "inputs.json").write_text(
            json.dumps({"inputs": self._entries}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS_DIR), str(_LIB_DIR),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["TXR_INPUTS_DIR"] = str(self.inputs_dir)
        env["TXR_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("TXR_PROGRESS_FIFO", None)
        for k, v in (env_extra or {}).items():
            if v is None:
                env.pop(str(k), None)
            else:
                env[str(k)] = str(v)
        return subprocess.run([sys.executable, str(self.script)], env=env,
                              capture_output=True, text=True)

    def run_ok(self, params=None, *, env_extra=None):
        proc = self.run(params, env_extra=env_extra)
        assert proc.returncode == 0, (
            f"{self.script.name} exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "de-report.json").read_text())

    def de_entries(self) -> list:
        return [e for e in self.manifest()["outputs"] if e["datatype"] == "de/result"]

    def de_store(self, entry) -> Path:
        return self.outputs_dir / entry["path"]

    def de_txr(self, entry) -> dict:
        doc = json.loads((self.de_store(entry) / "zarr.json").read_text())
        return (doc.get("attributes") or {}).get("txr") or {}

    def de_members(self, entry) -> set:
        """The MEMBERS actually written into a de/result store (the columns present on disk)."""
        st = self.de_txr(entry)
        cols = st.get("columns") or []
        return {c.get("name") or c.get("path") for c in cols if isinstance(c, dict)}

    def de_column(self, entry, member) -> list:
        return list(txr_zarr_read.read_column(self.de_store(entry), member))

    def progress_phases(self, proc) -> list:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]

    def diagnostics(self, proc) -> str:
        return "\n".join(l for l in proc.stderr.splitlines()
                         if l.startswith(("de.markers:", "de.compare:")))


# ── synthetic data ─────────────────────────────────────────────────────────────────
def two_group_expression(n_per=30, n_genes=24, seed=1, n_groups=2):
    """Counts with the first gene block over-expressed in group 0 — a legible marker signal.
    `n_groups` blocks of `n_per` cells (so a k-group grouping has k*n_per matching cells)."""
    rng = np.random.default_rng(seed)
    n_cells = n_groups * n_per
    base = rng.poisson(1.0, size=(n_cells, n_genes)).astype(np.float32)
    block = max(1, n_genes // 3)
    base[:n_per, :block] += rng.poisson(25.0, size=(n_per, block)).astype(np.float32)
    return base


def group_labels(n_per=30, groups=("g0", "g1")):
    out = []
    for g in groups:
        out += [g] * n_per
    return out


def sample_labels(n_per=30, per_side=2):
    """A sample/replicate label per cell giving `per_side` distinct samples on each of two
    groups (so R1 needs per_side ≥ 2)."""
    out = []
    for g in range(2):
        for i in range(n_per):
            out.append(f"s{g}_{i % per_side}")
    return out


MATRIX_DERIVED = {"clustering": {"method": "leiden", "flavor": "igraph"}}
EXTERNAL = {"external": True, "provenance": "external"}
