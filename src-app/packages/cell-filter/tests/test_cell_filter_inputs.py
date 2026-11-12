#!/usr/bin/env python3
# ruff: noqa
"""ITEM-24 — cell-filter's INPUT CONTRACT: by SLOT, decoded by the artifact.

`cell-filter.py` used to find its matrix by GLOB (`expression*.h5ad`, then `*.h5ad`,
then "any slot at all") and read it with `ad.read_h5ad`. Both halves were wrong about
what the input IS: a `single-cell/expression` artifact in a real project is a multifile
**CSC Zarr store**, so the declared `expression.h5ad` mount name would have routed a
Zarr directory into `read_h5ad`, and the glob would happily pick up a stray file the run
never declared.

The contract is now:

  * ``expression``      — REQUIRED. The CSC Zarr count matrix. Supplies the CELL COUNT
                          (the mask's length) and backs on-the-fly metric computation.
  * ``column:<name>``   — 0..N. One per obs column the criteria may reference; the SLOT
                          carries the column's name (a `metadata-column` store declares
                          `kind: table` and a member called `values`, never the column's
                          display name, so the name has to arrive with the binding).
  * ``cells_index``     — OPTIONAL. The cells-axis key artifact → barcodes for the gate /
                          cell-set paths. Absent ⇒ positional ids.
  * ``gene_names``      — OPTIONAL. Gene labels for the legacy `pct_counts_mt` /
                          `pct_counts_ribo` on-the-fly metrics.
  * ``cells``/`cell-set`/… — OPTIONAL, unchanged: a barcode allow-list file.

Every one of them is resolved out of `/inputs/inputs.json`. There is no glob.
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
sp = pytest.importorskip("scipy.sparse")
pd = pytest.importorskip("pandas")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
_HELPERS_DIR = _PROCESSORS / "_helpers"
_LIB_DIR = _PROCESSORS / "_lib"
SCRIPT = _PKG / "compute" / "cell-filter.py"

sys.path.insert(0, str(_LIB_DIR))
import txr_columns  # noqa: E402
import txr_csc  # noqa: E402
import txr_zarr_read  # noqa: E402


class FilterRun:
    """One staged `/inputs` + `/outputs` pair for a single cell-filter invocation."""

    def __init__(self, base: Path):
        self.base = base
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    def _mount(self, mount: str | None) -> str:
        if mount is not None:
            return mount
        name = f"in{self._n}"  # suffix-free ON PURPOSE
        self._n += 1
        return name

    def _declare(self, slot: str, mount: str) -> None:
        self._entries.append({
            "slot": slot, "kind": "artifact-prefix",
            "content_hash": f"sha256:{'0' * 64}",
            "sandbox_path": f"/inputs/{mount}",
        })

    def add_matrix(self, dense, *, slot: str = "expression", mount: str | None = None) -> Path:
        mount = self._mount(mount)
        mat = sp.csr_matrix(np.asarray(dense, dtype=np.float32))
        mat.eliminate_zeros()
        txr_csc.write_csc_zarr(
            txr_csc.ArraySource(mat), self.inputs_dir / mount, axes=("cells", "genes")
        )
        self._declare(slot, mount)
        return self.inputs_dir / mount

    def add_obs_column(self, name: str, values, *, mount: str | None = None) -> Path:
        return self._add_column(f"column:{name}", name, values, "cells", mount)

    def add_column(self, slot: str, name: str, values, *, axis: str = "genes",
                   mount: str | None = None) -> Path:
        return self._add_column(slot, name, values, axis, mount)

    def _add_column(self, slot, name, values, axis, mount) -> Path:
        mount = self._mount(mount)
        txr_columns.write_metadata_column(
            self.inputs_dir, mount, name, pd.Series(list(values)), axis=axis
        )
        self._declare(slot, mount)
        return self.inputs_dir / mount

    def add_file(self, slot: str, text: str, *, mount: str | None = None) -> Path:
        """A plain FILE input (the barcode allow-list slot)."""
        mount = self._mount(mount)
        (self.inputs_dir / mount).write_text(text)
        self._declare(slot, mount)
        return self.inputs_dir / mount

    def add_stray_h5ad(self, name: str, obs: dict) -> Path:
        """An UNDECLARED, genuinely readable `.h5ad` — what the retired glob matched."""
        ad = pytest.importorskip("anndata")
        n = len(next(iter(obs.values())))
        frame = pd.DataFrame(obs, index=[f"stray{i}" for i in range(n)])
        adata = ad.AnnData(X=np.ones((n, 2), dtype="float32"), obs=frame)
        adata.write_h5ad(self.inputs_dir / name)
        return self.inputs_dir / name

    def run(self, params: dict | None = None, *, declare_inputs: bool = True):
        (self.inputs_dir / "inputs.json").write_text(json.dumps(
            {"inputs": self._entries if declare_inputs else []}, indent=2))
        body = {"seed": 0}
        body.update(params or {})
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))

        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS_DIR), str(_LIB_DIR),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["TXR_INPUTS_DIR"] = str(self.inputs_dir)
        env["TXR_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("TXR_PROGRESS_FIFO", None)
        return subprocess.run(
            [sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)

    def run_ok(self, params: dict | None = None):
        proc = self.run(params)
        assert proc.returncode == 0, (
            f"cell-filter exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    @staticmethod
    def diagnostics(proc) -> str:
        """Only the compute's OWN prefixed lines — pytest's `tmp_path` embeds the test
        name, so a raw-stderr substring check would false-positive on a traceback path."""
        return "\n".join(l for l in proc.stderr.splitlines() if l.startswith("cell-filter:"))

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "filter-report.json").read_text())

    def mask(self) -> list[bool]:
        """The committed mask, located through the manifest's own `path`.

        Never `f"{report['mask_column']}.zarr"`: the column NAME is the run's label verbatim
        and the FILENAME is a sanitised component of it, so the two coincide only for the
        plain ASCII labels this file happens to use. Rebuilding one from the other would be a
        helper that passes on every fixture here and is wrong for the first label with a
        space in it."""
        entries = [e for e in json.loads((self.outputs_dir / "manifest.json").read_text())["outputs"]
                   if e["datatype"] == "metadata-column"]
        assert len(entries) == 1, entries
        return [bool(v) for v in
                txr_zarr_read.read_column(self.outputs_dir / entries[0]["path"])]


@pytest.fixture
def filter_run(tmp_path):
    counter = {"n": 0}

    def make() -> FilterRun:
        counter["n"] += 1
        return FilterRun(tmp_path / f"run{counter['n']}")

    return make


COUNTS = np.array(
    [[5.0, 3.0, 0.0],
     [1.0, 0.0, 0.0],
     [8.0, 8.0, 4.0],
     [0.0, 2.0, 1.0]],
    dtype=np.float32,
)


# ── the expression slot is a CSC artifact ─────────────────────────────────────

def test_reads_the_csc_artifact_bound_to_the_expression_slot(filter_run):
    """The declared input is a Zarr store, and the run reads it as one: 4 cells in, the
    criteria applied over the bound obs columns, one keep-mask out."""
    r = filter_run()
    store = r.add_matrix(COUNTS)
    assert (store / "zarr.json").is_file(), "the fixture must be a Zarr store"
    r.add_obs_column("qc_score", [5.0, 50.0, 8.0, 90.0])
    r.run_ok({"criteria": [{"column": "qc_score", "max": "10"}], "label": "strict"})

    assert r.mask() == [True, False, True, False]
    rep = r.report()
    assert (rep["n_cells_in"], rep["n_cells_out"]) == (4, 2)
    assert [t["metric"] for t in rep["thresholds"]] == ["qc_score"]


def test_the_cell_count_comes_from_the_matrix_declaration(filter_run):
    """With NO criteria at all the mask is keep-all over the matrix's DECLARED cells
    axis — so the length is a fact read off the artifact, not inferred from a column."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.run_ok({"criteria": [], "label": "all"})
    assert r.mask() == [True, True, True, True]
    assert r.report()["n_cells_in"] == 4


def test_obs_columns_arrive_as_metadata_column_artifacts_named_by_slot(filter_run):
    """A `metadata-column` store declares `kind: table` and a member called `values` —
    never the column's display name — so the SLOT (`column:<name>`) carries it. Two
    columns, two criteria, one joint mask."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_obs_column("pct_mito", [1.0, 40.0, 2.0, 3.0])
    r.add_obs_column("cell_type", ["T", "B", "T", "NK"])
    r.run_ok({"criteria": [
        {"column": "pct_mito", "max": "10"},
        {"column": "cell_type", "keep": ["T", "NK"]},
    ], "label": "joint"})
    assert r.mask() == [True, False, True, True]
    assert {t["metric"] for t in r.report()["thresholds"]} == {"pct_mito", "cell_type"}


def test_a_criterion_on_an_unbound_column_still_keeps_every_cell(filter_run):
    """Unchanged semantics: an unresolved column imposes no constraint and never
    silently hides the dataset."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.run_ok({"criteria": [{"column": "not_bound", "max": "1"}], "label": "x"})
    assert r.mask() == [True, True, True, True]


def test_a_legacy_metric_is_computed_from_the_matrix_when_no_column_is_bound(filter_run):
    """`total_counts` has no bound column, so it is computed from the CSC store —
    the on-the-fly path, now sourced from the artifact instead of scanpy+AnnData."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.run_ok({"criteria": [{"column": "total_counts", "min": "5"}], "label": "depth"})
    # per-cell sums: 8, 1, 20, 3  → only cells 0 and 2 clear a floor of 5.
    assert r.mask() == [True, False, True, False]


# ── SLOT-only resolution ──────────────────────────────────────────────────────

def test_a_slotted_input_with_no_recognisable_suffix_resolves(filter_run):
    """The mount name is `payload`. Nothing about it says "matrix"."""
    r = filter_run()
    r.add_matrix(COUNTS, mount="payload")
    r.add_obs_column("qc_score", [5.0, 50.0, 8.0, 90.0], mount="qc_payload")
    r.run_ok({"criteria": [{"column": "qc_score", "max": "10"}], "label": "s"})
    assert r.mask() == [True, False, True, False]


def test_a_stray_h5ad_matching_the_retired_glob_is_not_picked_up(filter_run):
    """`/inputs` holds a REAL, readable `expression.h5ad` — exactly what
    `patterns=("expression*.h5ad", "*.h5ad")` matched — and inputs.json declares nothing.
    The run must refuse, naming the slot, rather than filter someone else's cells."""
    r = filter_run()
    r.add_stray_h5ad("expression.h5ad", {"qc_score": [1.0, 2.0, 3.0]})
    proc = r.run({"criteria": [{"column": "qc_score", "max": "10"}], "label": "x"},
                 declare_inputs=False)
    assert proc.returncode != 0, (
        f"a stray file matching the retired glob was read:\n{proc.stdout}\n{proc.stderr}")
    diag = r.diagnostics(proc)
    # "it exited non-zero" is NOT the claim — a reinstated glob also exits non-zero when
    # the file it picked up fails to decode as a Zarr store. The claim is that it never
    # LOOKED: the diagnostic is the unbound-slot one, and the stray is not named in it.
    assert "no input is bound" in diag and "expression" in diag, proc.stderr
    assert "expression.h5ad" not in diag, (
        f"the run reached the stray — it resolved a file inputs.json never declared:\n{diag}")
    assert not (r.outputs_dir / "filter-report.json").exists()


def test_a_declared_slot_wins_over_a_stray_with_a_matching_name(filter_run):
    """The stray has a DIFFERENT cell count, so it cannot alias the declared input."""
    r = filter_run()
    r.add_matrix(COUNTS, mount="in_declared")
    r.add_obs_column("qc_score", [5.0, 50.0, 8.0, 90.0])
    r.add_stray_h5ad("expression.h5ad", {"qc_score": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]})
    r.run_ok({"criteria": [{"column": "qc_score", "max": "10"}], "label": "s"})
    assert r.report()["n_cells_in"] == 4
    assert r.mask() == [True, False, True, False]


def test_two_column_slots_colliding_on_one_mount_are_refused(filter_run):
    """The runner derives a mount name from the SLOT, sanitized to `[A-Za-z0-9._-]`, so
    two DISTINCT column slots can sanitize to ONE name — the later stage overwrites the
    earlier and both columns read the same values, silently. Reproduced exactly as the
    runner would produce it: two stages at one mount."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_obs_column("a:b", [1.0, 2.0, 3.0, 4.0], mount="column_a_b")
    r.add_obs_column("a_b", [9.0, 9.0, 9.0, 9.0], mount="column_a_b")
    proc = r.run({"criteria": [{"column": "a:b", "max": "2"}], "label": "x"})
    assert proc.returncode != 0, (
        f"two column slots collided on one mount and the run answered anyway:\n"
        f"{proc.stdout}\n{proc.stderr}")
    assert "collide" in r.diagnostics(proc), proc.stderr


def test_missing_expression_slot_errors_clearly(filter_run):
    r = filter_run()
    proc = r.run({"criteria": [], "label": "x"}, declare_inputs=False)
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "expression" in r.diagnostics(proc), proc.stderr


def test_an_unrelated_slot_does_not_stand_in_for_expression(filter_run):
    """The retired "any slot will do" fallback: an obs column alone is not the matrix."""
    r = filter_run()
    r.add_obs_column("qc_score", [5.0, 50.0])
    proc = r.run({"criteria": [], "label": "x"})
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "expression" in r.diagnostics(proc), proc.stderr


# ── the optional axis-key + allow-list slots ──────────────────────────────────

def test_cells_index_supplies_the_barcodes_a_gate_resolves_against(filter_run):
    """A brushed gate is a set of BARCODES; they resolve against the cells-axis key
    artifact bound at `cells_index`."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_column("cells_index", "cells_index",
                 ["AAAC-1", "CCCG-1", "GGGG-1", "TTTT-1"], axis="cells")
    r.run_ok({"criteria": [], "label": "gated", "gate": ["CCCG-1", "TTTT-1"]})
    assert r.mask() == [False, True, False, True]
    assert r.report()["cell_set_applied"] is True


def test_a_barcode_allow_list_slot_intersects_the_mask(filter_run):
    """The `cells`/`cell-set`/… allow-list is still a SLOT (four accepted spellings, all
    slot NAMES — `manifest.yaml`'s `methods.allow_list_slots` lists the same four). It is
    a plain FILE, and it intersects with whatever the criteria kept."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_column("cells_index", "cells_index",
                 ["AAAC-1", "CCCG-1", "GGGG-1", "TTTT-1"], axis="cells")
    r.add_file("cell-set", "AAAC-1\nGGGG-1\n")
    r.run_ok({"criteria": [], "label": "allow"})
    assert r.mask() == [True, False, True, False]
    assert r.report()["cell_set_applied"] is True


def test_an_undeclared_barcode_file_is_not_read_as_an_allow_list(filter_run):
    """The allow-list is bound by SLOT: a file sitting in `/inputs` that nobody declared
    must not silently narrow the mask."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_column("cells_index", "cells_index",
                 ["AAAC-1", "CCCG-1", "GGGG-1", "TTTT-1"], axis="cells")
    (r.inputs_dir / "cells").write_text("AAAC-1\n")  # NOT declared in inputs.json
    r.run_ok({"criteria": [], "label": "allow"})
    assert r.mask() == [True, True, True, True]
    assert r.report()["cell_set_applied"] is False


def test_a_gene_names_input_enables_the_legacy_mito_metric(filter_run):
    """`pct_counts_mt` needs gene LABELS; with a `gene_names` artifact bound it is
    computable, and without one it is a typed skip (never a fabricated zero)."""
    r = filter_run()
    r.add_matrix(COUNTS)
    r.add_column("gene_names", "feature_name", ["MT-CO1", "ACTB", "RPL3"], axis="genes")
    # cell sums 8/1/20/3; mito counts 5/1/8/0 → 62.5%, 100%, 40%, 0%
    r.run_ok({"criteria": [{"column": "pct_mito", "max": "50"}], "label": "m"})
    assert r.mask() == [False, False, True, True]


def test_without_gene_names_the_mito_metric_is_a_typed_skip(filter_run):
    r = filter_run()
    r.add_matrix(COUNTS)
    r.run_ok({"criteria": [{"column": "pct_mito", "max": "50"}], "label": "m"})
    assert r.mask() == [True, True, True, True], (
        "an uncomputable metric must impose no constraint, never a fabricated 0%")
