#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the `trajectory` computes (ITEM-17).

Drives the REAL `compute/paga.py` / `compute/dpt.py` as a SUBPROCESS through the only seam
that runs them outside bwrap (`CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`), with `_lib` on
`PYTHONPATH` exactly as the sandbox stages `/code`. Mirrors
`clustering/tests/clustering_fixtures.py`.

Every input is declared in `/inputs/inputs.json` with a MEANINGLESS `in0`/`in1` mount name,
so a compute that resolved inputs by filename suffix rather than by SLOT could not pass this
suite. That is not decoration: resolving by filename is the shape that works on the fixture
and breaks in the sandbox, where the runner names every mount `inN`.

Helpers live HERE rather than in `conftest.py` so `from trajectory_fixtures import ...`
never collides with the rootdir `packages/conftest.py`.
"""
from __future__ import annotations

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

PAGA = _COMPUTE / "paga.py"
DPT = _COMPUTE / "dpt.py"

sys.path.insert(0, str(_LIB_DIR))
sys.path.insert(0, str(_HERE))
import cyto_columns  # noqa: E402
import cyto_csc  # noqa: E402
import cyto_zarr  # noqa: E402
import cyto_zarr_read  # noqa: E402

from trajectory_generators import barcodes  # noqa: E402


def write_embedding_store(dest: Path, arr, *, name="X_pca", method="pca",
                          aligned_to=None) -> dict:
    """A fixture `embedding` artifact, as the upstream reducer emits one — including the
    `method`/`aligned_to` provenance it stamps into the store's group `attributes.cyto`,
    which is where the compute reads it from."""
    structure, _meta = cyto_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32),
        axis="cells", name=name, kind="embedding", method=method, aligned_to=aligned_to)
    structure["method"] = method
    zj = dest / "zarr.json"
    doc = json.loads(zj.read_text())
    doc.setdefault("attributes", {})["cyto"] = structure
    zj.write_text(json.dumps(doc, indent=2))
    return structure


def write_layout_store(dest: Path, arr, *, name="X_umap") -> dict:
    """A fixture 2-D LAYOUT — the thing the compute must refuse as a graph source."""
    structure, _meta = cyto_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32)[:, :2],
        axis="cells", name=name, kind="embedding", method="umap")
    zj = dest / "zarr.json"
    doc = json.loads(zj.read_text())
    doc.setdefault("attributes", {}).setdefault("cyto", {})["kind"] = "layout"
    zj.write_text(json.dumps(doc, indent=2))
    return structure


def write_categorical_column_store(dest: Path, labels, *, name="leiden", categories=None,
                                   aligned_to=None) -> dict:
    """A fixture CATEGORICAL `metadata-column` — a partition, as the clusterer emits one.

    `categories` declares the level set EXPLICITLY. It exists because always writing
    `sorted(set(values))` made three real branches of the compute unreachable from the suite:
    a level declared but carried by no cell, a label the declaration does not list, and a
    declaration whose order is not sorted — which is the exact input class the node-ordering
    invariant singles out. A fixture that can only produce the easy case cannot test the
    hard one.
    """
    import pandas as pd

    values = [str(v) for v in labels]
    declared = [str(c) for c in categories] if categories is not None else sorted(set(values))
    series = pd.Series(pd.Categorical(values, categories=declared))
    structure, _meta = cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, series, axis="cells", aligned_to=aligned_to)
    return structure


def write_continuous_column_store(dest: Path, values, *, name="score") -> dict:
    """A fixture CONTINUOUS `metadata-column` — what the partition slot must REFUSE."""
    import pandas as pd

    series = pd.Series(np.asarray(values, dtype=np.float32), dtype="float32")
    structure, _meta = cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, series, axis="cells")
    return structure


def write_keys_column_store(dest: Path, keys, *, name="barcode") -> dict:
    """A fixture cells-axis KEY column — the artifact a barcode root is resolved against."""
    import pandas as pd

    structure, _meta = cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, pd.Series([str(k) for k in keys]), axis="cells",
        holds_axis_keys=True)
    return structure


class _Run:
    """One staged run of one compute."""

    SCRIPT: Path = None
    REPORT: str = None

    def __init__(self, base: Path):
        self.base = base
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    # ── staging ────────────────────────────────────────────────────────────────────
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

    def add_embedding(self, arr, *, slot="embedding", name="X_pca", method="pca",
                      aligned_to=None, content_hash=None, mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_embedding_store(dest, arr, name=name, method=method, aligned_to=aligned_to)
        self._declare(slot, mount, content_hash)
        return dest

    def add_layout(self, arr, *, slot="embedding", mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_layout_store(dest, arr)
        self._declare(slot, mount)
        return dest

    def add_partition(self, labels, *, slot="partition", name="leiden", mount=None,
                      categories=None, aligned_to=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_categorical_column_store(dest, labels, name=name, categories=categories,
                                       aligned_to=aligned_to)
        self._declare(slot, mount)
        return dest

    def add_continuous_column(self, values, *, slot="partition", mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_continuous_column_store(dest, values)
        self._declare(slot, mount)
        return dest

    def add_keys(self, keys, *, slot="cell_keys", mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_keys_column_store(dest, keys)
        self._declare(slot, mount)
        return dest

    # ── running ────────────────────────────────────────────────────────────────────
    def run(self, params=None, *, env_extra=None):
        (self.inputs_dir / "inputs.json").write_text(
            json.dumps({"inputs": self._entries}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS_DIR), str(_LIB_DIR), str(_COMPUTE),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["CYTO_INPUTS_DIR"] = str(self.inputs_dir)
        env["CYTO_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("CYTO_PROGRESS_FIFO", None)
        for k, v in (env_extra or {}).items():
            if v is None:
                env.pop(str(k), None)  # UNSET (absent), not empty-string
            else:
                env[str(k)] = str(v)
        return subprocess.run([sys.executable, str(self.SCRIPT)], env=env,
                              capture_output=True, text=True)

    def run_ok(self, params=None, *, env_extra=None):
        proc = self.run(params, env_extra=env_extra)
        assert proc.returncode == 0, (
            f"{self.SCRIPT.name} exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    def run_fails(self, params=None, *, env_extra=None):
        proc = self.run(params, env_extra=env_extra)
        assert proc.returncode != 0, (
            f"{self.SCRIPT.name} unexpectedly SUCCEEDED\n--- stderr ---\n{proc.stderr}")
        return proc

    def diagnostics(self, proc) -> str:
        """Only OUR named refusals — the lines the compute prefixes with its analysis id.
        A library traceback is deliberately excluded, so a test asserting on this cannot be
        satisfied by a stack trace."""
        prefix = self.SCRIPT.stem
        return "\n".join(
            l for l in proc.stderr.splitlines()
            if l.startswith("trajectory.paga:") or l.startswith("trajectory.dpt:"))

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / self.REPORT).read_text())

    def entry(self, datatype: str) -> dict:
        return next(e for e in self.manifest()["outputs"] if e["datatype"] == datatype)

    def entries(self, datatype: str) -> list:
        return [e for e in self.manifest()["outputs"] if e["datatype"] == datatype]

    def store(self, datatype: str) -> Path:
        return self.outputs_dir / self.entry(datatype)["path"]

    def group_cyto(self, datatype: str) -> dict:
        doc = json.loads((self.store(datatype) / "zarr.json").read_text())
        return (doc.get("attributes") or {}).get("cyto") or {}

    def progress_phases(self, proc) -> list:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]


class PagaRun(_Run):
    SCRIPT = PAGA
    REPORT = "trajectory-paga-report.json"

    def adjacency(self):
        """The emitted adjacency, densified — what INV-1 compares against scanpy."""
        import scipy.sparse as sp

        root = self.store("graph/attributed")
        indptr, indices, data = cyto_csc.read_csc(root)
        n = len(indptr) - 1
        m = sp.csc_matrix((np.asarray(data, dtype=np.float64),
                           np.asarray(indices, dtype=np.int64),
                           np.asarray(indptr, dtype=np.int64)), shape=(n, n))
        return np.asarray(m.todense())

    def graph_structure(self) -> dict:
        return self.group_cyto("graph/attributed")

    def node_labels(self) -> list:
        return [n["label"] for n in self.graph_structure()["nodes"]]


class DptRun(_Run):
    SCRIPT = DPT
    REPORT = "trajectory-dpt-report.json"

    def pseudotime(self):
        return np.asarray(cyto_zarr_read.read_column(
            self.store("metadata-column"), "values"), dtype=np.float64)

    def column_bytes(self) -> bytes:
        """Every byte of the emitted column store, concatenated in a stable order — the
        artifact-level identity two determinism runs are compared on."""
        root = self.store("metadata-column")
        out = []
        for p in sorted(root.rglob("*")):
            if p.is_file() and p.name != "zarr.json":
                out.append(p.read_bytes())
        return b"".join(out)
