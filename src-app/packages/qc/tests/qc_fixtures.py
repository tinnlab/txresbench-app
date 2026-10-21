#!/usr/bin/env python3
# ruff: noqa
"""Staging + read-back helpers for the `qc` off-sandbox run harness.

They live HERE rather than in `conftest.py` on purpose: the rootdir
`packages/conftest.py` is also imported under the module name `conftest`, so a test
doing `from conftest import …` resolves to whichever of the two got imported first — an
import-order accident. The `qc_run` FIXTURE stays in `conftest.py` (that is what pytest
collects); the plain helpers are imported from this module by name.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
_HELPERS_DIR = _PROCESSORS / "_helpers"
_LIB_DIR = _PROCESSORS / "_lib"

SCRIPT = _PKG / "compute" / "qc-10x.py"

sys.path.insert(0, str(_LIB_DIR))
import cyto_columns  # noqa: E402
import cyto_csc  # noqa: E402
import cyto_zarr_read  # noqa: E402


def write_csc_store(dest: Path, dense) -> dict:
    """A `single-cell/expression` artifact: the CSC Zarr store the importer emits.

    `dense` is a cells x genes array (or a scipy sparse matrix). Returns the
    producer-declared `structure` (also stamped into the store's group `zarr.json`,
    which is where a reader learns the encoding — no filename involved)."""
    mat = dense if sp.issparse(dense) else sp.csr_matrix(np.asarray(dense, dtype=np.float32))
    mat = mat.tocsr()
    mat.eliminate_zeros()
    return cyto_csc.write_csc_zarr(
        cyto_csc.ArraySource(mat), dest, axes=("cells", "genes")
    )


def write_column_store(dest: Path, name: str, values, *, axis: str):
    """A `metadata-column` artifact (the shape a gene-names / axis-index input has)."""
    import pandas as pd

    return cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, pd.Series(list(values)), axis=axis
    )


class QcRun:
    """One staged `/inputs` + `/outputs` pair for a single qc-10x invocation."""

    def __init__(self, base: Path):
        self.base = base
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    # ── staging ──────────────────────────────────────────────────────────────
    def _mount(self, mount: str | None) -> str:
        if mount is not None:
            return mount
        # DELIBERATELY suffix-free: `in0` tells a reader nothing about the format.
        name = f"in{self._n}"
        self._n += 1
        return name

    def _declare(self, slot: str, mount: str, kind: str) -> None:
        self._entries.append(
            {
                "slot": slot,
                "kind": kind,
                "content_hash": f"sha256:{'0' * 64}",
                "sandbox_path": f"/inputs/{mount}",
            }
        )

    def add_matrix(self, dense, *, slot: str = "matrices", mount: str | None = None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_csc_store(dest, dense)
        self._declare(slot, mount, "artifact-prefix")
        return dest

    def add_column(self, values, *, slot: str, axis: str = "genes",
                   name: str = "values", mount: str | None = None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_column_store(dest, name, values, axis=axis)
        self._declare(slot, mount, "artifact-prefix")
        return dest

    def add_gene_names(self, n_genes: int, *, prefix: str = "G", mount: str | None = None) -> Path:
        """A throwaway `gene_names` artifact of `n_genes` distinct labels.

        EVERY metric is a gene-SET question now (the two former builtins are ordinary `.*`
        rows), so every run that emits a column binds one of these per matrix. The labels
        themselves are meaningless — a test that cares which genes match stages its own
        symbols with `add_column`; this is for the runs whose metric is `.*`.
        """
        return self.add_column(
            [f"{prefix}{i}" for i in range(n_genes)],
            slot="gene_names", axis="genes", name="feature_name", mount=mount,
        )

    def add_stray(self, name: str, body: bytes = b"not a real artifact") -> Path:
        """A file in `/inputs` that inputs.json does NOT declare. Nothing may read it."""
        p = self.inputs_dir / name
        p.write_bytes(body)
        return p

    def add_stray_matrix(self, name: str, dense) -> Path:
        """An UNDECLARED matrix store under a name an old glob would have matched."""
        dest = self.inputs_dir / name
        write_csc_store(dest, dense)
        return dest

    # ── run ──────────────────────────────────────────────────────────────────
    def run(self, params: dict | None = None, *, declare_inputs: bool = True):
        if declare_inputs:
            (self.inputs_dir / "inputs.json").write_text(
                json.dumps({"inputs": self._entries}, indent=2)
            )
        else:
            (self.inputs_dir / "inputs.json").write_text(json.dumps({"inputs": []}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))

        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS_DIR), str(_LIB_DIR),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
        env["CYTO_INPUTS_DIR"] = str(self.inputs_dir)
        env["CYTO_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("CYTO_PROGRESS_FIFO", None)
        return subprocess.run(
            [sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True
        )

    @staticmethod
    def diagnostics(proc) -> str:
        """ONLY the compute's own diagnostic lines.

        Asserting a slot name against raw `stderr` is a false-positive trap: pytest's
        `tmp_path` embeds the TEST NAME, so a test called
        `…missing_gene_names_input…` sees "gene_names" inside every traceback that
        happens to print a path. `test_a_missing_gene_names_input_never_silently_reports_zero`
        passed that way against the UNFIXED script. Diagnostics are prefixed."""
        return "\n".join(
            l for l in proc.stderr.splitlines() if l.startswith("qc-10x:")
        )

    def run_ok(self, params: dict | None = None):
        proc = self.run(params)
        assert proc.returncode == 0, (
            f"qc-10x exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
        return proc

    # ── read-back ────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def obs(self) -> dict:
        return json.loads((self.outputs_dir / "obs.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "qc-report.json").read_text())

    def emitted_columns(self) -> list[str]:
        """The metric column names the run emitted (from obs.json, excluding `id`)."""
        return [c for c in self.obs()["columns"] if c != "id"]

    def column_values(self, display: str) -> list[float]:
        return list(self.obs()["obs"][display])

    def metadata_column_ids(self) -> list[str]:
        return [
            e["id"]
            for e in self.manifest()["outputs"]
            if e.get("datatype") == "metadata-column"
        ]


# ─────────────────────────── shared synthetic data ────────────────────────────


def counts_matrix(n_cells: int, n_genes: int, seed: int = 0):
    """A deterministic dense count matrix with no all-zero cell (so a pct is defined)."""
    rng = np.random.default_rng(seed)
    dense = rng.integers(0, 12, size=(n_cells, n_genes)).astype(np.float32)
    dense[:, 0] = rng.integers(1, 9, size=n_cells)  # every cell has some signal
    return dense


def pct_on(dense, gene_mask) -> np.ndarray:
    """The `pct_counts_<var>` oracle: 100 * counts on the flagged genes / total."""
    d = np.asarray(dense, dtype=float)
    total = d.sum(axis=1)
    on = d[:, np.asarray(gene_mask, dtype=bool)].sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(total > 0, 100.0 * on / total, 0.0)
