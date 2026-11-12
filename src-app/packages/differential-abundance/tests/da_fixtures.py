#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the DA compute (mirrors `de_fixtures.py` / `clustering_fixtures.py`).

Drives the REAL `compute/clusters.py` / `compute/neighbourhoods.py` as a SUBPROCESS through the
`TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR` seam, with `_lib` on `PYTHONPATH` exactly as the sandbox
stages `/code`. Every input is declared in `/inputs/inputs.json` with a MEANINGLESS `in0`/…
mount name, so a compute that resolves by filename suffix cannot pass.

Helpers live HERE (not in `conftest.py`) so `from da_fixtures import …` never collides with the
rootdir `packages/conftest.py`.
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
_PACKAGES = _PKG.parent
_LIB_DIR = _PACKAGES / "_lib"
_HELPERS_DIR = _PACKAGES / "_helpers"
_COMPUTE = _PKG / "compute"

CLUSTERS = _COMPUTE / "clusters.py"
NEIGHBOURHOODS = _COMPUTE / "neighbourhoods.py"

sys.path.insert(0, str(_LIB_DIR))
import txr_columns  # noqa: E402
import txr_zarr  # noqa: E402
import txr_zarr_read  # noqa: E402


# ── provenance stamps the regime classifier reads (INV-DA-3) ───────────────────────
#: A CONDITION column that positively declares external provenance ⇒ eligible for R1.
EXTERNAL = {"external": True, "provenance": "external"}
#: A column derived from the matrix (a clustering / annotation) ⇒ R2 when CLASSIFIED ON.
#: Population columns carry this in real life, which is exactly why the classifier must NOT be
#: applied to them.
MATRIX_DERIVED = {"clustering": {"method": "leiden", "flavor": "igraph"}}


def write_column_store(dest: Path, values, *, name="col", provenance=None) -> dict:
    """A fixture categorical `metadata-column`. `provenance` (a dict) is stamped into the store's
    group `attributes.txr`."""
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


def write_embedding_store(dest: Path, arr, *, name="X_pca", kind="embedding",
                          method="pca") -> dict:
    """A fixture `embedding` artifact, as `embedding.reduce` emits it. `kind="layout"` (or a 2-D
    array) is what the INV-11 refusal is exercised with."""
    structure, meta = txr_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32),
        axis="cells", name=name, kind=kind, method=method)
    zj = dest / "zarr.json"
    doc = json.loads(zj.read_text())
    txr = doc.setdefault("attributes", {}).setdefault("txr", {})
    txr.update(structure)
    txr["kind"] = kind if kind in ("layout", "umap", "tsne") else txr.get("kind")
    zj.write_text(json.dumps(doc, indent=2))
    return structure


class DaRun:
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

    def add_column(self, values, *, slot, name="col", provenance=None, mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_column_store(dest, values, name=name, provenance=provenance)
        self._declare(slot, mount)
        return dest

    def add_embedding(self, arr, *, slot="embedding", name="X_pca", kind="embedding",
                      mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_embedding_store(dest, arr, name=name, kind=kind)
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
        return json.loads((self.outputs_dir / "da-report.json").read_text())

    def da_entries(self) -> list:
        return [e for e in self.manifest()["outputs"] if e["datatype"] == "da/result"]

    def column_entries(self) -> list:
        return [e for e in self.manifest()["outputs"] if e["datatype"] == "metadata-column"]

    def da_store(self, entry) -> Path:
        return self.outputs_dir / entry["path"]

    def da_txr(self, entry) -> dict:
        doc = json.loads((self.da_store(entry) / "zarr.json").read_text())
        return (doc.get("attributes") or {}).get("txr") or {}

    def da_members(self, entry) -> set:
        """The MEMBERS actually written into a da/result store (the columns present on disk)."""
        st = self.da_txr(entry)
        cols = st.get("columns") or []
        return {c.get("name") or c.get("path") for c in cols if isinstance(c, dict)}

    def da_column(self, entry, member) -> list:
        return list(txr_zarr_read.read_column(self.da_store(entry), member))

    def progress_phases(self, proc) -> list:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]

    def diagnostics(self, proc) -> str:
        return "\n".join(l for l in proc.stderr.splitlines()
                         if l.startswith(("da.clusters:", "da.neighbourhoods:",
                                          "differential-abundance:")))


# ── synthetic per-cell fixtures ────────────────────────────────────────────────────
def population_dataset(*, n_per_sample=200, samples_per_side=3, populations=("A", "B", "C", "D"),
                       shifted="A", shift=2.0, seed=1):
    """Per-cell (population, condition, sample) labels drawn so that ONE population's ABSOLUTE
    abundance is multiplied by `shift` on side `t` while every other population's ABSOLUTE
    abundance is UNCHANGED.

    That is the compositional-confounding shape: because the totals differ, every unchanged
    population's PROPORTION mechanically falls, which is exactly the trap a proportion test walks
    into. Returns `(populations_per_cell, conditions_per_cell, samples_per_cell)`.
    """
    rng = np.random.default_rng(seed)
    pops, conds, samps = [], [], []
    base = {p: float(n_per_sample) / len(populations) for p in populations}
    for side, cond in ((0, "ctrl"), (1, "treat")):
        for r in range(samples_per_side):
            sample = f"s{side}_{r}"
            for p in populations:
                mu = base[p] * (shift if (cond == "treat" and p == shifted) else 1.0)
                n = int(rng.poisson(mu))
                pops.extend([p] * n)
                conds.extend([cond] * n)
                samps.extend([sample] * n)
    return pops, conds, samps


def embedding_dataset(*, n_per_sample=120, samples_per_side=3, n_dims=6, seed=1, shift=2.0):
    """A `(cells × dims)` embedding with THREE well-separated blobs, plus per-cell condition and
    sample labels, where ONE blob's absolute abundance is multiplied by `shift` on the treated
    side. Returns `(X, conditions, samples, blob_labels)`."""
    rng = np.random.default_rng(seed)
    centres = np.zeros((3, n_dims), dtype=np.float32)
    centres[0, 0] = 8.0
    centres[1, 1] = 8.0
    centres[2, 2] = 8.0
    rows, conds, samps, blobs = [], [], [], []
    for side, cond in ((0, "ctrl"), (1, "treat")):
        for r in range(samples_per_side):
            sample = f"s{side}_{r}"
            for b in range(3):
                mu = (n_per_sample / 3.0) * (shift if (cond == "treat" and b == 0) else 1.0)
                n = int(rng.poisson(mu))
                rows.append(rng.normal(size=(n, n_dims)).astype(np.float32) + centres[b])
                conds.extend([cond] * n)
                samps.extend([sample] * n)
                blobs.extend([f"blob{b}"] * n)
    X = np.vstack(rows).astype(np.float32)
    return X, conds, samps, blobs
