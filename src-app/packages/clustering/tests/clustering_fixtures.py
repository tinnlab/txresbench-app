#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the `clustering` compute (DEC-10 / TEST-26).

Drives the REAL `compute/cluster.py` as a SUBPROCESS through the only seam that runs it
outside bwrap (`CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`), with `_lib` on `PYTHONPATH` exactly
as the sandbox stages `/code`. Every input is declared in `/inputs/inputs.json` (the
`render_inputs_json` wire shape) with a MEANINGLESS `in0`/`in1` mount name, so a compute
that resolves by filename suffix cannot pass (mirrors `embedding/tests/embedding_fixtures.py`).

Test-input strategy (DEC-10): no package produces an `embedding` on this branch (EA-reduce is
still building), so the e2e clusters a FIXTURE `embedding` artifact written via the real
`cyto_zarr` (`write_embedding`), modelling EA-reduce's output — including the `method` /
`aligned_to` provenance the real reducer stamps, so INV-13 has a real identity to record.

Helpers live HERE (not in `conftest.py`) so `from clustering_fixtures import …` never
collides with the rootdir `packages/conftest.py`.
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

CLUSTER = _COMPUTE / "cluster.py"

sys.path.insert(0, str(_LIB_DIR))
import cyto_columns  # noqa: E402
import cyto_csc  # noqa: E402
import cyto_zarr  # noqa: E402
import cyto_zarr_read  # noqa: E402


def cells_digest(n: int) -> str:
    """The `key_sequence_digest` a `cells` axis of `n` barcodes declares — a real digest to
    stamp as an embedding's `aligned_to` (a bare 64-hex string, not a label)."""
    return cyto_zarr.key_sequence_digest([f"cell-{i}" for i in range(n)])


# ── staging helpers ────────────────────────────────────────────────────────────────
def _stamp_cyto_attributes_like_ea(dest: Path, structure: dict, **kv) -> dict:
    """Mirror EA-reduce's REAL producer stamp, `embedding/compute/_shared.py::
    stamp_cyto_attributes` (on `feat/embedding-analysis-stage0`), BYTE-for-byte in shape:
    set each non-None key on the in-memory `structure`, then OVERWRITE the store's group
    `attributes.cyto` with that full structure — so `method`/`correction` land as TOP-LEVEL
    `attributes.cyto` keys (NOT merely on the manifest-entry `meta`). This is where the real
    producer records them since its EA phase-7 F2 fix; clustering's `embedding_identity`
    reads exactly there. `None` values are skipped so an absent bit stays absent (honest)."""
    for k, v in kv.items():
        if v is not None:
            structure[k] = v
    zj = dest / "zarr.json"
    doc = json.loads(zj.read_text())
    attrs = doc.get("attributes")
    if not isinstance(attrs, dict):
        attrs = {}
        doc["attributes"] = attrs
    attrs["cyto"] = structure
    zj.write_text(json.dumps(doc, indent=2))
    return structure


def write_embedding_store(dest: Path, arr, *, name="X_pca", method="pca",
                          correction="none", aligned_to=None,
                          provenance_channel="attributes_cyto") -> dict:
    """A fixture `embedding` artifact (as EA-reduce would emit it).

    `provenance_channel` selects HOW the producer recorded `method`/`correction`:

      * ``"attributes_cyto"`` (default, EA-REAL) — after the real `write_embedding`, stamp
        `method`/`correction` into the store's group `attributes.cyto` exactly as EA-reduce's
        `stamp_cyto_attributes` does (top-level cyto keys). This is the real producer contract
        the clustering INV-13 read is proven against.
      * ``"meta_only"`` — the PRE-EA-phase-7 producer: `write_embedding` records `method` ONLY
        on its returned manifest-entry `meta` (`cyto_columns.py`), leaving `attributes.cyto`
        WITHOUT `method`/`correction`. A store-URL reader (clustering) then sees no method →
        records the honest `unattested`. Used to prove the seam is a REAL read of the
        producer's `attributes.cyto`, not a fixture authored to the reader.
    """
    structure, meta = cyto_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32),
        axis="cells", name=name, kind="embedding", method=method, aligned_to=aligned_to)
    if provenance_channel == "attributes_cyto":
        _stamp_cyto_attributes_like_ea(dest, structure, method=method, correction=correction)
    elif provenance_channel == "meta_only":
        pass  # method lives only on `meta` (as write_embedding leaves it) — NOT in attributes.cyto
    else:
        raise ValueError(f"unknown provenance_channel {provenance_channel!r}")
    return structure


def write_expression_store(dest: Path, matrix) -> dict:
    """A fixture `single-cell/expression` artifact — a cells × genes CSC Zarr store, exactly
    what an importer emits (`kind: sparse_csc`). The descriptive-markers pass reads this."""
    import scipy.sparse as sp

    m = sp.csr_matrix(np.asarray(matrix, dtype=np.float32))
    structure = cyto_csc.write_csc_zarr(cyto_csc.ArraySource(m), dest, axes=("cells", "genes"))
    return structure


def write_layout_store(dest: Path, arr, *, name="X_umap") -> dict:
    """A fixture 2-D LAYOUT artifact (a UMAP/t-SNE picture) — the thing INV-11 forbids as a
    clustering graph source. Written as a 2-column embedding member tagged as a layout."""
    structure, _meta = cyto_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32)[:, :2],
        axis="cells", name=name, kind="embedding", method="umap")
    zj = dest / "zarr.json"
    doc = json.loads(zj.read_text())
    doc.setdefault("attributes", {}).setdefault("cyto", {})["kind"] = "layout"
    zj.write_text(json.dumps(doc, indent=2))
    return structure


class ClusterRun:
    def __init__(self, base: Path):
        self.base = base
        self.script = CLUSTER
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

    def add_embedding(self, arr, *, slot="embedding", name="X_pca", method="pca",
                      correction="none", aligned_to=None, content_hash=None,
                      mount=None, provenance_channel="attributes_cyto") -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_embedding_store(dest, arr, name=name, method=method, correction=correction,
                              aligned_to=aligned_to, provenance_channel=provenance_channel)
        self._declare(slot, mount, content_hash)
        return dest

    def add_expression(self, matrix, *, slot="expression", content_hash=None,
                       mount=None) -> Path:
        """Bind a cells × genes CSC expression matrix on the OPTIONAL `expression` slot — the
        descriptive-markers pass reads it (Stage B)."""
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_expression_store(dest, matrix)
        self._declare(slot, mount, content_hash)
        return dest

    def add_layout(self, arr, *, slot="embedding", name="X_umap", mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_layout_store(dest, arr, name=name)
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
        env["CYTO_INPUTS_DIR"] = str(self.inputs_dir)
        env["CYTO_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("CYTO_PROGRESS_FIFO", None)
        for k, v in (env_extra or {}).items():
            if v is None:
                env.pop(str(k), None)  # UNSET (absent), not empty-string
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

    def diagnostics(self, proc) -> str:
        return "\n".join(l for l in proc.stderr.splitlines()
                         if l.startswith("clustering.cluster:"))

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "clustering-report.json").read_text())

    def markers(self) -> dict:
        """The `markers` section of the run report (the descriptive-markers pass, Stage B)."""
        return self.report()["markers"]

    def label_entry(self) -> dict:
        return next(e for e in self.manifest()["outputs"]
                    if e["datatype"] == "metadata-column")

    def label_store(self) -> Path:
        return self.outputs_dir / self.label_entry()["path"]

    def label_group_cyto(self) -> dict:
        """The produced column store's group `attributes.cyto` (where the clustering
        provenance tag is stamped)."""
        doc = json.loads((self.label_store() / "zarr.json").read_text())
        return (doc.get("attributes") or {}).get("cyto") or {}

    def labels(self) -> list:
        """The per-cell cluster labels, codes resolved through the declared level set."""
        return list(cyto_zarr_read.read_column(self.label_store(), "values"))

    def progress_phases(self, proc) -> list[str]:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]


# ── synthetic data ─────────────────────────────────────────────────────────────────
def three_blob_embedding(n_per: int = 40, n_dims: int = 10, seed: int = 0):
    """A deterministic embedding with THREE well-separated Gaussian blobs — Leiden recovers
    a stable ~3-cluster partition on it."""
    rng = np.random.default_rng(seed)
    blobs = [
        rng.normal(0.0, 1.0, (n_per, n_dims)),
        rng.normal(8.0, 1.0, (n_per, n_dims)),
        rng.normal(-8.0, 1.0, (n_per, n_dims)),
    ]
    return np.vstack(blobs).astype(np.float32)


def three_blob_expression(n_per: int = 40, n_genes: int = 30, seed: int = 1):
    """A deterministic cells × genes count matrix ALIGNED to `three_blob_embedding(n_per)` —
    the first three gene BLOCKS are each over-expressed in one of the three blobs, so the
    descriptive markers recover a legible per-cluster ranking. Integer-ish counts, non-
    negative (a real expression matrix), so log-normalisation + a rank test are meaningful."""
    rng = np.random.default_rng(seed)
    n_cells = 3 * n_per
    base = rng.poisson(1.0, size=(n_cells, n_genes)).astype(np.float32)
    block = max(1, n_genes // 3)
    for b in range(3):
        rows = slice(b * n_per, (b + 1) * n_per)
        cols = slice(b * block, (b + 1) * block)
        base[rows, cols] += rng.poisson(20.0, size=(n_per, block)).astype(np.float32)
    return base
