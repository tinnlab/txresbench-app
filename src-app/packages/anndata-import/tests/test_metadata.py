#!/usr/bin/env python3
"""Harvested-metadata test suite for the h5ad / 10x → Zarr converter
(TEST-10, covers ITEM-9).

Sibling of ``test_fidelity.py`` / ``test_convert.py`` — same import mechanism,
same off-sandbox run seam, same read-back. This file pins the ITEM-9 harvested
metadata: the ``dataset-metadata.json`` summary (shape, obs/var column
descriptors, layers / obsm / uns key lists, x_state, species, gene-id kind), the
per-``obs``-column ``metadata-column`` artifacts (dtype-preserving), and the
inspect ``report/html``.

Run with: ``pytest test_metadata.py`` (needs ``anndata`` +
``scipy`` + ``pyarrow`` in the venv).
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
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")
pa = pytest.importorskip("pyarrow")


# ─────────────────────────── converter under test ────────────────────────────

_HERE = Path(__file__).resolve().parent
# Shared sandbox scripts dir (`colsummary.py`); off-sandbox the harness must put it on
# the subprocess PYTHONPATH (the entry script self-inserts only its own co-located dir).
_SCRIPTS_DIR = _HERE.parents[1] / "_helpers"
# The shared OUTPUT-FORMAT library (`_lib`: `txr_zarr` / `txr_columns`, DEC-7). The
# sandbox runner stages it into `/code` next to the `_helpers` modules, so the
# subprocess needs it on PYTHONPATH or the converter dies at import.
_LIB_DIR = _HERE.parents[1] / "_lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))
import txr_zarr_read  # noqa: E402  (the `_lib` reference reader for the emitted Zarr)

_SCRIPT_CANDIDATES = [
    _HERE.parent / "compute" / "h5ad_import.py",
]
SCRIPT = next((p for p in _SCRIPT_CANDIDATES if p.exists()), _SCRIPT_CANDIDATES[-1])


# ─────────────────────────────── run harness ─────────────────────────────────

@pytest.fixture
def run_converter(tmp_path):
    """``run(adata) -> (manifest, outputs_dir)`` — drives the real script
    off-sandbox (mirrors ``test_fidelity.run_converter``)."""
    counter = {"n": 0}

    def run(adata):
        counter["n"] += 1
        base = tmp_path / f"run{counter['n']}"
        inputs_dir = base / "inputs"
        outputs_dir = base / "outputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        outputs_dir.mkdir(parents=True, exist_ok=True)

        adata.write_h5ad(inputs_dir / "data.h5ad")

        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_SCRIPTS_DIR), str(_LIB_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
        env["TXR_INPUTS_DIR"] = str(inputs_dir)
        env["TXR_OUTPUTS_DIR"] = str(outputs_dir)
        env.pop("TXR_PROGRESS_FIFO", None)

        proc = subprocess.run(
            [sys.executable, str(SCRIPT)],
            env=env,
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, (
            f"converter exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
        manifest = json.loads((outputs_dir / "manifest.json").read_text())
        return manifest, outputs_dir

    return run


# ───────────────────────────── read-back helpers ─────────────────────────────

def load_dataset_metadata(outputs_dir: Path) -> dict:
    return json.loads((outputs_dir / "dataset-metadata.json").read_text())


def metadata_column_payloads(manifest: dict, outputs_dir: Path) -> dict:
    """label → `{meta…, values, structure}` for every ``metadata-column`` artifact.

    ITEM-26: a column is a Zarr artifact DIRECTORY now, not a JSON blob. The manifest
    entry's `meta` carries the display facts (`kind`/`dtype`/`n`/`categories`) and the
    values are DECODED FROM THE BYTES via the `_lib` reference reader — so this asserts
    what the store actually holds rather than what a sidecar claims it holds."""
    out = {}
    for e in manifest["outputs"]:
        if e.get("datatype") == "metadata-column":
            payload = dict(e.get("meta") or {})
            payload["values"] = txr_zarr_read.read_column(outputs_dir / e["path"])
            payload["structure"] = e["structure"]
            out[e["label"]] = payload
    return out


def inspect_entry(manifest: dict) -> dict | None:
    for e in manifest["outputs"]:
        if e.get("datatype") == "report/html":
            return e
    return None


# ─────────────────────────────── fixtures/data ───────────────────────────────

N_OBS = 300
N_VARS = 80


def make_rich_adata(seed: int = 0):
    """An int-counts adata carrying a mixed-dtype ``obs`` frame (categorical /
    string / numeric-int / numeric-float / bool), Ensembl ``var_names`` +
    ``gene_ids`` (→ ensembl gene-id kind, human species), a ``highly_variable``
    var flag, two layers, two embeddings, and a couple of ``uns`` keys."""
    rng = np.random.default_rng(seed)
    dense = ((rng.random((N_OBS, N_VARS)) < 0.12) * rng.integers(1, 400, (N_OBS, N_VARS))).astype(np.int32)
    X = sp.csr_matrix(dense)
    X.eliminate_zeros()
    a = ad.AnnData(X=X)

    # Realistic human Ensembl var index (ENSG + 11 digits, i.e. ENSG000…) →
    # gene_id_kind == "ensembl", species == "human" (the detector probes for the
    # ENSG0/ENSG00 prefix that real human gene ids carry).
    a.var_names = [f"ENSG{j:011d}" for j in range(N_VARS)]
    a.obs_names = [f"cell_{i}" for i in range(N_OBS)]

    # obs: one of every dtype family the harvester distinguishes.
    a.obs["cell_type"] = pd.Categorical(
        rng.choice(["Tcell", "Bcell", "NK"], size=N_OBS)
    )
    # An ALL-UNIQUE object column: anndata auto-categorizes low-cardinality string
    # columns on h5ad write, so a genuine object/string column must be high-card.
    a.obs["sample"] = [f"note_{i}" for i in range(N_OBS)]                 # string/object
    a.obs["n_genes"] = rng.integers(200, 5000, size=N_OBS).astype(np.int64)  # numeric int
    a.obs["pct_mito"] = rng.random(N_OBS).astype(np.float64)             # numeric float
    a.obs["is_doublet"] = rng.random(N_OBS) < 0.1                        # bool

    # var: an extra annotation column beyond the Ensembl gene_ids.
    a.var["gene_ids"] = list(a.var_names)
    a.var["highly_variable"] = rng.random(N_VARS) < 0.3

    a.layers["counts"] = X.copy()
    a.layers["spliced"] = X.copy()

    a.obsm["X_umap"] = rng.standard_normal((N_OBS, 2)).astype(np.float32)
    a.obsm["X_pca"] = rng.standard_normal((N_OBS, 10)).astype(np.float32)

    a.uns["schema_version"] = "1.0"
    a.uns["pca"] = {"variance_ratio": [0.2, 0.1]}
    return a


# ──────────────────────────────────── tests ──────────────────────────────────

def test_dataset_metadata_summary(run_converter):
    """The ``dataset-metadata.json`` records the full harvested summary: shape,
    obs/var column descriptors (with dtypes), layers / obsm / uns key lists,
    x_state, species, and gene-id kind."""
    adata = make_rich_adata()
    _manifest, outputs_dir = run_converter(adata)
    meta = load_dataset_metadata(outputs_dir)

    # Shape.
    assert meta["n_obs"] == adata.n_obs
    assert meta["n_vars"] == adata.n_vars

    # obs columns + dtypes: one descriptor per obs column, with kind classification.
    obs_by_name = {c["name"]: c for c in meta["obs_columns"]}
    assert set(obs_by_name) == set(adata.obs.columns)
    assert obs_by_name["cell_type"]["kind"] == "categorical"
    assert obs_by_name["cell_type"]["n_categories"] == 3
    assert obs_by_name["sample"]["kind"] == "string"
    assert obs_by_name["n_genes"]["kind"] == "numeric"
    assert obs_by_name["pct_mito"]["kind"] == "numeric"
    assert obs_by_name["is_doublet"]["kind"] == "bool"
    # dtypes are carried verbatim from pandas.
    for name, col in obs_by_name.items():
        assert col["dtype"] == str(pd.Series(adata.obs[name]).dtype)

    # var columns.
    var_by_name = {c["name"]: c for c in meta["var_columns"]}
    assert {"gene_ids", "highly_variable"} <= set(var_by_name)

    # Key lists.
    assert set(meta["layers"]) == {"counts", "spliced"}
    assert {d["key"] for d in meta["obsm"]} == {"X_umap", "X_pca"}
    assert {"schema_version", "pca"} <= set(meta["uns_keys"])

    # Classifications.
    assert meta["x_state"] == "raw_counts"
    assert meta["species"] == "human"
    assert meta["gene_id_kind"] == "ensembl"
    assert meta["has_gene_ids"] is True
    assert meta["n_embeddings"] == 2


def test_obs_columns_become_metadata_column_artifacts(run_converter):
    """Each categorical / string / numeric obs column becomes a ``metadata-column``
    artifact whose payload preserves the dtype (+ the always-emitted cell_id)."""
    adata = make_rich_adata()
    manifest, outputs_dir = run_converter(adata)
    payloads = metadata_column_payloads(manifest, outputs_dir)

    # The barcode index is always emitted.
    assert "cell_id" in payloads
    assert payloads["cell_id"]["values"] == list(map(str, adata.obs_names))

    # Every obs column produced an artifact.
    assert set(adata.obs.columns) <= set(payloads)

    # Categorical: kind + categories + dtype preserved.
    ct = payloads["cell_type"]
    assert ct["kind"] == "categorical"
    assert ct["dtype"] == "category"
    assert set(ct["categories"]) == set(map(str, adata.obs["cell_type"].cat.categories))
    assert ct["n"] == adata.n_obs
    # …and the DECLARED level set is what the stored codes resolve through.
    assert ct["structure"]["columns"][0]["n_levels"] == len(
        adata.obs["cell_type"].cat.categories
    )
    assert ct["values"] == list(map(str, adata.obs["cell_type"]))

    # String/object: unified metadata-column vocab ({categorical, continuous}) classes a
    # free object column as "categorical" (a high-cardinality legend); the precise pandas
    # dtype "object" is retained in `dtype`. (write_metadata_column, h5ad_import.py.)
    smp = payloads["sample"]
    assert smp["kind"] == "categorical"
    assert smp["dtype"] == "object"
    assert smp["values"] == list(map(str, adata.obs["sample"]))

    # Numeric (int + float): unified vocab kind "continuous", dtype family preserved.
    ng = payloads["n_genes"]
    assert ng["kind"] == "continuous"
    assert ng["dtype"].startswith("int")
    # ITEM-26: an integer column stays an integer ARRAY at its source width — the old
    # JSON form pushed every value through a Python float on the way out.
    assert ng["structure"]["columns"][0]["dtype"].startswith("int")
    np.testing.assert_array_equal(
        np.asarray(ng["values"], dtype=np.int64),
        np.asarray(adata.obs["n_genes"], dtype=np.int64),
    )

    pm = payloads["pct_mito"]
    assert pm["kind"] == "continuous"
    assert pm["dtype"].startswith("float")
    np.testing.assert_allclose(
        np.asarray(pm["values"], dtype=np.float64),
        np.asarray(adata.obs["pct_mito"], dtype=np.float64),
        rtol=1e-6, atol=1e-6,
    )


def test_inspect_report_html_emitted_nonempty(run_converter):
    """The inspect ``report/html`` artifact is emitted, present on disk, non-empty,
    and embeds the harvested metadata."""
    adata = make_rich_adata()
    manifest, outputs_dir = run_converter(adata)

    entry = inspect_entry(manifest)
    assert entry is not None, "no report/html output in manifest"
    assert entry["role"] == "intermediate"

    html_path = outputs_dir / entry["path"]
    assert html_path.exists(), f"inspect report not written at {html_path}"
    html = html_path.read_text()
    assert len(html) > 0
    assert "<html" in html.lower()
    # Human-readable summary carries the shape + the embedded metadata JSON.
    assert f"{adata.n_obs} &times; {adata.n_vars}" in html or f"{adata.n_obs} × {adata.n_vars}" in html
    assert 'id=\'dataset-metadata\'' in html or 'id="dataset-metadata"' in html
    embedded = json.loads(html.split("id='dataset-metadata'>", 1)[1].split("</script>", 1)[0])
    assert embedded["n_obs"] == adata.n_obs
    assert embedded["n_vars"] == adata.n_vars


# ── TEST-60 (visualize-pane ITEM-47) ─────────────────────────────────────────
#
# **AN ANNOTATION IS A COLUMN ON THE ENTRY AXIS — and the viewer needs no concept
# of an annotation at all.**
#
# ITEM-47, verbatim: *"gene symbol, Ensembl id, modality, `is_isotype_control` are
# all `metadata-column` artifacts emitted with `axis="genes"`, exactly as
# `cell_type` is emitted with `axis="cells"`. The annotation picker enumerates them
# with the rule §6 already defines, and the viewer needs no concept of an
# annotation at all."*
#
# ── why the test lives HERE, and not where it was enumerated ─────────────────
#
# TESTS.md declared this at `server/tests/extensions/view_spec_test.rs` (tier:
# integration). That file is a 60-line serde round-trip over the `view_spec`
# manifest field and has no bearing on the claim; nothing in the Rust server
# emits, classifies or enumerates a metadata column. The claim is entirely about
# what the IMPORTER writes — which is Python, and is where ITEM-47's own audit
# verdict looked (`h5ad_import.py`, the obs/var symmetry). A test asserting the
# claim where the claim lives is worth more than one filed where it was guessed;
# the relocation is recorded in TESTS.md rather than done silently.
#
# The assertion is SYMMETRY, not "var columns exist": if the two paths ever stop
# being the same path, an annotation becomes a second kind of thing and the viewer
# would need to learn about it.

def test_var_annotations_are_ordinary_entry_axis_columns(run_converter):
    """obs → `axis="cells"`, var → `axis="genes"`, through ONE emission shape."""
    adata = make_rich_adata()
    manifest, _outputs_dir = run_converter(adata)

    cols = [e for e in manifest["outputs"] if e.get("datatype") == "metadata-column"]
    on_cells = [e for e in cols if e.get("axis") == "cells"]
    on_genes = [e for e in cols if e.get("axis") == "genes"]

    # Positive control on BOTH halves: a symmetry assertion over an empty set is
    # satisfied by emitting nothing at all.
    assert on_cells, "no metadata-column on the cells axis — the symmetry below is vacuous"
    assert on_genes, "no metadata-column on the genes axis — var annotations were dropped"

    # Every declared var column reaches the store as a column on the ENTRY axis,
    # under a namespaced output id (an obs and a var column may share a name).
    gene_labels = {e["label"] for e in on_genes}
    assert set(adata.var.columns) <= gene_labels, (
        f"var columns missing from the genes axis: {set(adata.var.columns) - gene_labels}"
    )
    for e in on_genes:
        if e["label"] in set(adata.var.columns):
            assert e["id"].startswith("metadata-column:var:"), e["id"]

    # THE SYMMETRY. One entry SHAPE for both axes — same datatype, same key set,
    # same producer summary vocabulary. The only thing that differs is which axis
    # the column is on, which is the whole of ITEM-47.
    cell_type = next(e for e in on_cells if e["label"] == "cell_type")
    hv = next(e for e in on_genes if e["label"] == "highly_variable")
    assert cell_type["datatype"] == hv["datatype"] == "metadata-column"
    assert set(cell_type.keys()) == set(hv.keys()), (
        "an obs column and a var column no longer have the same entry shape — "
        "an annotation has become a second kind of thing"
    )
    # The producer SUMMARY is the same vocabulary on both (`kind` is what § Colour by
    # and the annotation picker narrow on — a DECLARATION, not an inference).
    assert "kind" in (cell_type.get("meta") or {})
    assert "kind" in (hv.get("meta") or {})
    # Both declare their alignment to their own axis's key sequence, by the same key.
    assert cell_type["structure"].get("aligned_to")
    assert hv["structure"].get("aligned_to")
    assert cell_type["structure"]["aligned_to"] != hv["structure"]["aligned_to"], (
        "the cells and genes axes digest to the same key sequence — the fixture cannot "
        "tell the two row spaces apart, so this test would pass for the wrong reason"
    )

    # …and NOTHING declares itself an annotation. There is no `annotation` datatype,
    # no `is_annotation` flag, no annotation-shaped entry kind: the concept exists in
    # the reader's head and nowhere in the wire, which is what lets the viewer
    # enumerate gene annotations with the rule it already had for cell columns.
    for e in cols:
        assert "annotation" not in e["datatype"], e["datatype"]
        assert not any("annotation" in str(k).lower() for k in (e.get("meta") or {})), e["label"]
