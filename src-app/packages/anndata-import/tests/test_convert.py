#!/usr/bin/env python3
"""Converter-case test suite for the h5ad / 10x → Zarr converter (TEST-9, covers
ITEM-7 / ITEM-8; read-back re-anchored by ITEM-27).

Sibling of ``test_fidelity.py`` — same import mechanism (load the real script from
the server scripts path), same off-sandbox run seam (``CYTO_INPUTS_DIR`` /
``CYTO_OUTPUTS_DIR``), same read-back path. Where ``test_fidelity`` pins the
§ Output-spec invariants on ONE canonical fixture, this file sweeps the converter's
INPUT SHAPES: dense / CSR / CSC X, X=None-with-layer promotion, a log-normalized
(never-force-cast) matrix, the 0-embedding and 2-embedding obsm cardinalities, and a
real 10x MTX trio input.

**These tests used to read back through ``tiledbsoma``.** ITEM-27 deleted that store
— it was the transpose BUFFER the CSC was streamed out of, not a second output — so
every read-back now goes through the artifacts the converter actually ships: the CSC
Zarr matrix, the per-axis entity indexes, and the obs/var metadata columns. That is a
STRICTER anchor, not a weaker one: it reads the bytes a client will read, rather than
a library's own round-trip of its own store.

Run with: ``pytest test_convert.py`` (needs ``anndata`` + ``scipy`` + ``scanpy`` in
the venv).
"""
from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Hard deps — skip cleanly (rather than error at collection) if the scientific
# stack is not installed in the running interpreter.
np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")
sio = pytest.importorskip("scipy.io")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")
sc = pytest.importorskip("scanpy")


# ─────────────────────────── converter under test ────────────────────────────

_HERE = Path(__file__).resolve().parent
# Shared sandbox scripts dir (`colsummary.py`); off-sandbox the harness must put it on
# the subprocess PYTHONPATH (the entry script self-inserts only its own co-located dir).
_SCRIPTS_DIR = _HERE.parents[1] / "_helpers"
# The shared OUTPUT-FORMAT library (`_lib`: `cyto_zarr` / `cyto_columns`, DEC-7). The
# sandbox runner stages it into `/code` next to the `_helpers` modules, so the
# subprocess needs it on PYTHONPATH or the converter dies at import.
_LIB_DIR = _HERE.parents[1] / "_lib"
# The script is co-located with its manifest (matches `run.entry: compute/h5ad_import.py`).
_SCRIPT_CANDIDATES = [
    _HERE.parent / "compute" / "h5ad_import.py",
]
SCRIPT = next((p for p in _SCRIPT_CANDIDATES if p.exists()), _SCRIPT_CANDIDATES[-1])

EXPRESSION_REL = "expression"   # the converter's CSC Zarr matrix output path

sys.path.insert(0, str(_LIB_DIR))
import cyto_csc            # noqa: E402  — the `_lib` CSC reader (producer-side only)
import cyto_zarr_read      # noqa: E402


# ─────────────────────────────── run harness ─────────────────────────────────

def _invoke_converter(inputs_dir: Path, outputs_dir: Path):
    """Run the REAL converter over a populated inputs dir, asserting a clean exit,
    and return ``(manifest, outputs_dir)``."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_SCRIPTS_DIR), str(_LIB_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    env["CYTO_INPUTS_DIR"] = str(inputs_dir)
    env["CYTO_OUTPUTS_DIR"] = str(outputs_dir)
    env.pop("CYTO_PROGRESS_FIFO", None)  # no FIFO reader off-sandbox

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


@pytest.fixture
def run_converter(tmp_path):
    """``run(adata) -> (manifest, outputs_dir)`` — writes ``adata`` to
    ``inputs/data.h5ad`` and drives the real script off-sandbox (mirrors
    ``test_fidelity.run_converter``)."""
    counter = {"n": 0}

    def run(adata):
        counter["n"] += 1
        base = tmp_path / f"run{counter['n']}"
        inputs_dir = base / "inputs"
        outputs_dir = base / "outputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        adata.write_h5ad(inputs_dir / "data.h5ad")
        return _invoke_converter(inputs_dir, outputs_dir)

    return run


@pytest.fixture
def run_converter_mtx(tmp_path):
    """``run(populate) -> (manifest, outputs_dir)`` — ``populate(inputs_dir)`` drops
    a 10x MTX trio (matrix.mtx + barcodes.tsv + features.tsv) into the inputs dir,
    then the real script is driven off-sandbox exactly as for the h5ad path."""
    counter = {"n": 0}

    def run(populate):
        counter["n"] += 1
        base = tmp_path / f"mtx{counter['n']}"
        inputs_dir = base / "inputs"
        outputs_dir = base / "outputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        populate(inputs_dir)
        return _invoke_converter(inputs_dir, outputs_dir)

    return run


# ───────────────────────────── read-back helpers ─────────────────────────────

def assert_no_soma_store(outputs_dir: Path):
    """ITEM-27: nothing SOMA-shaped may be left behind. Asserted here rather than
    assumed, because the failure mode of a half-done deletion is a store that is still
    written and merely unreferenced — i.e. the 86 % cost with none of the use."""
    stray = [p.name for p in outputs_dir.iterdir() if p.name.endswith(".soma")]
    assert not stray, f"a SOMA store survives in the outputs: {stray}"


def read_expression_csc(outputs_dir: Path, rel: str = EXPRESSION_REL, n_rows: int = None):
    """The converter's CSC matrix, decoded from its Zarr store into a scipy CSC.

    Goes through `cyto_csc.read_csc`, i.e. the same shard container a client decodes.
    """
    assert_no_soma_store(outputs_dir)
    base = outputs_dir / rel
    assert (base / "zarr.json").exists(), f"no CSC Zarr store at {base}"
    indptr, indices, data = cyto_csc.read_csc(base)
    structure = json.loads((base / "zarr.json").read_text())["attributes"]["cyto"]
    rows = structure["shape"][0] if n_rows is None else n_rows
    return sp.csc_matrix(
        (data, indices.astype(np.int64), indptr), shape=(int(rows), len(indptr) - 1)
    )


def read_axis_index(outputs_dir: Path, axis: str):
    """The per-axis entity keys (`cells` → barcodes, `genes` → gene labels) from the
    `<axis>_index` metadata-column artifact."""
    return list(cyto_zarr_read.read_column(outputs_dir / "metadata" / f"{axis}_index.zarr"))


def read_var_column(outputs_dir: Path, name: str):
    """One `var` annotation column, from the axis=genes metadata-column artifact the
    converter emits under `metadata/var/`."""
    rel = outputs_dir / "metadata" / "var" / f"{name}.zarr"
    assert rel.exists(), f"no var column artifact for {name!r} at {rel}"
    return list(cyto_zarr_read.read_column(rel))


def reconstruct(outputs_dir: Path, rel: str = EXPRESSION_REL):
    """Everything the converter ships about the matrix, as one object:
    `(dense, cells, genes)`. The successor to the old `to_anndata` golden round-trip —
    same question (does the source come back out?), asked of the SHIPPED bytes."""
    csc = read_expression_csc(outputs_dir, rel)
    return (
        np.asarray(csc.todense()),
        read_axis_index(outputs_dir, "cells"),
        read_axis_index(outputs_dir, "genes"),
    )


def load_dataset_metadata(outputs_dir: Path) -> dict:
    return json.loads((outputs_dir / "dataset-metadata.json").read_text())


def embedding_entries(manifest: dict) -> list[dict]:
    return [e for e in manifest["outputs"] if e.get("datatype") == "embedding"]


def _rt_dense(rt) -> "np.ndarray":
    x = rt.X
    return np.asarray(x.todense() if sp.issparse(x) else x)


# ─────────────────────────────── fixtures/data ───────────────────────────────

N_OBS = 400
N_VARS = 120


def _obs_var_index(adata):
    adata.obs_names = [f"cell_{i}" for i in range(adata.n_obs)]
    adata.var_names = [f"gene_{j}" for j in range(adata.n_vars)]
    return adata


def _int_dense(seed: int = 0, n_obs: int = N_OBS, n_vars: int = N_VARS):
    """A deterministic non-negative int32 dense count matrix."""
    rng = np.random.default_rng(seed)
    mask = rng.random((n_obs, n_vars)) < 0.1
    vals = rng.integers(1, 500, size=(n_obs, n_vars))
    return (mask * vals).astype(np.int32)


def make_int_dense_adata(seed: int = 0):
    a = ad.AnnData(X=_int_dense(seed))
    return _obs_var_index(a)


def make_int_csr_adata(seed: int = 0):
    X = sp.csr_matrix(_int_dense(seed))
    X.eliminate_zeros()
    return _obs_var_index(ad.AnnData(X=X))


def make_int_csc_adata(seed: int = 0):
    X = sp.csc_matrix(_int_dense(seed))
    X.eliminate_zeros()
    return _obs_var_index(ad.AnnData(X=X))


def make_x_none_with_layer_adata(seed: int = 5):
    """X is absent; a genuine integer ``counts`` layer is the only matrix — the
    converter must promote it to X (recorded as ``x_from_layer``)."""
    X = sp.csr_matrix(_int_dense(seed))
    X.eliminate_zeros()
    obs = pd.DataFrame(index=[f"cell_{i}" for i in range(X.shape[0])])
    var = pd.DataFrame(index=[f"gene_{j}" for j in range(X.shape[1])])
    a = ad.AnnData(obs=obs, var=var, layers={"counts": X})
    assert a.X is None
    return a


def make_lognorm_adata(seed: int = 1, n_obs: int = N_OBS, n_vars: int = N_VARS):
    """A log-normalized float matrix: non-integer values all < 10 (classified NOT
    raw counts; never force-cast to int)."""
    rng = np.random.default_rng(seed)
    mask = rng.random((n_obs, n_vars)) < 0.1
    counts = rng.integers(1, 300, size=(n_obs, n_vars))
    dense = (np.log1p(counts.astype(np.float32) / 10.0) * mask).astype(np.float32)
    assert dense.max() < 10.0
    X = sp.csr_matrix(dense)
    X.eliminate_zeros()
    return _obs_var_index(ad.AnnData(X=X))


def make_embeddings_adata(with_obsm: bool = True):
    """Int-counts adata with obsm ``X_umap`` (2-D) + ``X_pca`` (50-D), or none."""
    a = make_int_csr_adata(seed=2)
    if with_obsm:
        rng = np.random.default_rng(3)
        a.obsm["X_umap"] = rng.standard_normal((a.n_obs, 2)).astype(np.float32)
        a.obsm["X_pca"] = rng.standard_normal((a.n_obs, 50)).astype(np.float32)
    return a


def _write_10x_trio(inputs_dir: Path, dense, barcodes, gene_ids, symbols, feature_types):
    """Write a gzipped 10x v3 MTX trio (genes × cells matrix) into ``inputs_dir``."""
    X = sp.csr_matrix(dense.astype(np.int32))
    genes_by_cells = X.T.tocsr()  # 10x convention: features are rows, barcodes cols
    with gzip.open(inputs_dir / "matrix.mtx.gz", "wb") as f:
        sio.mmwrite(f, genes_by_cells)
    with gzip.open(inputs_dir / "barcodes.tsv.gz", "wt") as f:
        f.write("".join(f"{b}\n" for b in barcodes))
    with gzip.open(inputs_dir / "features.tsv.gz", "wt") as f:
        f.write("".join(f"{g}\t{s}\t{t}\n" for g, s, t in zip(gene_ids, symbols, feature_types)))


# ──────────────────────────────────── tests ──────────────────────────────────

def test_dense_x_roundtrips_byte_equal(run_converter):
    """A dense int X comes back value-for-value out of the emitted CSC.

    Dtype note (ITEM-27): the CSC has always stored `float32`, and the SOMA store was
    what kept the SOURCE width. With the store gone the width is RECORDED — the check
    below is that the integers survive float32 exactly AND that `meta.source_dtype`
    still names what they were, which is the honest successor to "the store is
    integer-typed"."""
    adata = make_int_dense_adata()
    src = np.asarray(adata.X)
    manifest, outputs_dir = run_converter(adata)

    dense, _cells, _genes = reconstruct(outputs_dir)
    assert dense.shape == src.shape
    np.testing.assert_array_equal(dense.astype(np.int64), src.astype(np.int64))
    expr = [e for e in manifest["outputs"] if e["id"] == "expression"][0]
    assert expr["meta"]["source_dtype"] == str(src.dtype), (
        "the source width is recorded now that no dtype-exact archive is written"
    )


def test_csr_x_roundtrips_byte_equal(run_converter):
    """A CSR sparse int X: identical nnz + exact nonzero-value multiset + integer
    dtype after round-trip."""
    adata = make_int_csr_adata()
    src = adata.X.tocsr()
    src.eliminate_zeros()
    src_vals = np.sort(np.asarray(src.data))

    manifest, outputs_dir = run_converter(adata)
    csc = read_expression_csc(outputs_dir)

    assert csc.nnz == int(src.nnz)
    got_vals = np.sort(np.asarray(csc.data, dtype=np.float64))
    np.testing.assert_array_equal(got_vals, src_vals.astype(np.float64))
    expr = [e for e in manifest["outputs"] if e["id"] == "expression"][0]
    assert expr["meta"]["source_dtype"] == str(src.dtype)
    # And the densified matrix matches value-for-value.
    np.testing.assert_array_equal(
        np.asarray(csc.todense()).astype(np.int64),
        np.asarray(src.todense()).astype(np.int64),
    )


def test_csc_x_roundtrips_byte_equal(run_converter):
    """A CSC sparse int X converts to a valid store byte-equal to the source."""
    adata = make_int_csc_adata()
    src = np.asarray(adata.X.todense())

    manifest, outputs_dir = run_converter(adata)
    csc = read_expression_csc(outputs_dir)

    assert csc.nnz == int(sp.csr_matrix(adata.X).nnz)
    expr = [e for e in manifest["outputs"] if e["id"] == "expression"][0]
    assert expr["meta"]["source_dtype"] == str(adata.X.dtype)
    np.testing.assert_array_equal(
        np.asarray(csc.todense()).astype(np.int64), src.astype(np.int64)
    )


def test_x_none_with_layer_fallback(run_converter):
    """X=None with a ``counts`` layer: the layer is promoted to X (recorded as
    ``x_from_layer``), the store is populated, and the counts round-trip."""
    adata = make_x_none_with_layer_adata()
    src = np.asarray(adata.layers["counts"].todense())

    _manifest, outputs_dir = run_converter(adata)

    meta = load_dataset_metadata(outputs_dir)
    # The genuine integer counts layer is the promoted source.
    assert meta["x_from_layer"] == "layers:counts"
    assert meta["count_source"] == "layers:counts"
    assert meta["x_state"] == "raw_counts"

    # ITEM-27: the promoted layer STREAMS now. `from_h5ad` could only source `/X`, so
    # this case used to drop into a whole-file in-memory read; the transpose reads
    # whatever h5 node it is handed, so the promotion is just a different path.
    dense, _cells, _genes = reconstruct(outputs_dir)
    assert dense.shape == src.shape
    np.testing.assert_array_equal(dense.astype(np.int64), src.astype(np.int64))


def test_lognorm_not_raw_and_not_force_cast(run_converter):
    """A log-normalized float matrix is NEVER labeled raw counts and is NOT
    force-cast to int — the float values are preserved byte-close."""
    adata = make_lognorm_adata()
    src = adata.X.tocsr()
    src.eliminate_zeros()
    src_vals = np.sort(np.asarray(src.data, dtype=np.float64))

    _manifest, outputs_dir = run_converter(adata)

    meta = load_dataset_metadata(outputs_dir)
    assert meta["x_state"] != "raw_counts", meta["x_state"]
    assert meta["count_source"] is None  # no integer count source fabricated

    csc = read_expression_csc(outputs_dir)
    got_vals = np.sort(np.asarray(csc.data, dtype=np.float64))
    assert got_vals.shape[0] == src_vals.shape[0]
    # Non-integral values survive as non-integral — the legacy `as.integer` bug would
    # show up here as a column of whole numbers.
    assert not np.allclose(got_vals, np.round(got_vals)), (
        "float matrix was cast to integer (the legacy as.integer bug)"
    )
    np.testing.assert_allclose(got_vals, src_vals, rtol=1e-6, atol=1e-6)


def test_no_obsm_zero_embeddings(run_converter):
    """No obsm → ZERO ``embedding`` outputs (cardinality ``many`` = 0)."""
    adata = make_embeddings_adata(with_obsm=False)
    manifest, outputs_dir = run_converter(adata)

    assert len(embedding_entries(manifest)) == 0
    assert load_dataset_metadata(outputs_dir)["n_embeddings"] == 0


def test_two_obsm_two_embeddings(run_converter):
    """obsm ``X_umap`` (2-D) + ``X_pca`` (50-D) → EXACTLY 2 ``embedding`` outputs,
    labeled UMAP + PCA, with correct ``source_key`` + ``n_dims`` meta."""
    adata = make_embeddings_adata(with_obsm=True)
    manifest, _outputs_dir = run_converter(adata)

    embs = embedding_entries(manifest)
    assert len(embs) == 2, f"expected 2 embeddings, got {[e['id'] for e in embs]}"
    assert {e.get("label") for e in embs} == {"UMAP", "PCA"}

    by_key = {e["meta"]["source_key"]: e["meta"] for e in embs}
    assert by_key["X_umap"]["n_dims"] == 2
    assert by_key["X_umap"]["method"] == "umap"
    assert by_key["X_pca"]["n_dims"] == 50
    assert by_key["X_pca"]["method"] == "pca"


def test_10x_mtx_trio_converts_and_preserves_annotations(run_converter_mtx):
    """A 10x MTX trio (matrix.mtx + barcodes.tsv + features.tsv) converts and the
    gene_ids / feature_types / barcodes survive into the SOMA store."""
    n_cells, n_genes = 60, 20
    rng = np.random.default_rng(7)
    dense = ((rng.random((n_cells, n_genes)) < 0.4) * rng.integers(1, 100, (n_cells, n_genes))).astype(np.int32)
    barcodes = [f"AAACCTG{i:05d}-1" for i in range(n_cells)]
    gene_ids = [f"ENSG{100000000 + j:09d}" for j in range(n_genes)]
    symbols = [f"GENE{j}" for j in range(n_genes)]
    feature_types = ["Gene Expression"] * n_genes

    manifest, outputs_dir = run_converter_mtx(
        lambda d: _write_10x_trio(d, dense, barcodes, gene_ids, symbols, feature_types)
    )

    # Converted: a CSC Zarr matrix + a metadata record identifying the 10x MTX source.
    meta = load_dataset_metadata(outputs_dir)
    assert meta["source_format"] == "10x_mtx"
    assert meta["n_obs"] == n_cells
    assert meta["n_vars"] == n_genes
    assert meta["has_gene_ids"] is True
    assert meta["feature_types"] == {"Gene Expression": n_genes}

    # Annotations preserved value-for-value. These lived ONLY in the SOMA var frame
    # until ITEM-27; deleting the store without emitting them would have silently
    # dropped every gene annotation while keeping the cell ones, so they are now
    # axis=genes metadata-column artifacts and are read back as such.
    assert read_var_column(outputs_dir, "gene_ids") == gene_ids
    assert read_var_column(outputs_dir, "feature_types") == feature_types
    got_dense, cells, genes = reconstruct(outputs_dir)
    assert genes == symbols
    assert cells == barcodes

    # Counts survive (int-valued) through the round-trip.
    np.testing.assert_array_equal(got_dense.astype(np.int64), dense.astype(np.int64))


def test_10x_mtx_trio_preserves_non_gex_features(run_converter_mtx):
    """A MIXED-modality 10x MTX trio (Gene Expression + Antibody Capture) must keep
    ALL features — the mtx loader passes ``gex_only=False`` for parity with the
    ``read_10x_h5`` path (regression guard for the dropped-non-GEX-features bug)."""
    n_cells, n_gex, n_ab = 40, 15, 5
    n_genes = n_gex + n_ab
    rng = np.random.default_rng(11)
    dense = ((rng.random((n_cells, n_genes)) < 0.4) * rng.integers(1, 100, (n_cells, n_genes))).astype(np.int32)
    barcodes = [f"AAACCTG{i:05d}-1" for i in range(n_cells)]
    gene_ids = [f"ENSG{100000000 + j:09d}" for j in range(n_gex)] + [f"AB{j:04d}" for j in range(n_ab)]
    symbols = [f"GENE{j}" for j in range(n_gex)] + [f"ADT{j}" for j in range(n_ab)]
    feature_types = ["Gene Expression"] * n_gex + ["Antibody Capture"] * n_ab

    manifest, outputs_dir = run_converter_mtx(
        lambda d: _write_10x_trio(d, dense, barcodes, gene_ids, symbols, feature_types)
    )

    meta = load_dataset_metadata(outputs_dir)
    # Every feature preserved — both modalities present, none silently dropped.
    assert meta["n_vars"] == n_genes
    assert meta["feature_types"] == {"Gene Expression": n_gex, "Antibody Capture": n_ab}

    assert read_var_column(outputs_dir, "feature_types") == feature_types
    assert read_var_column(outputs_dir, "gene_ids") == gene_ids


def test_10x_mtx_trio_converts_from_server_staged_layout(run_converter_mtx):
    """REGRESSION (production path): the server binds a multi-file dataset's files at
    ``/inputs/<ordinal>_<basename>`` + declares them in ``inputs.json`` — so the real
    on-ingest converter sees ``0_matrix.mtx.gz`` / ``1_barcodes.tsv.gz`` /
    ``2_features.tsv.gz``, NOT the canonical names ``read_10x_mtx`` globs for. Every
    other trio test here writes the CANONICAL names, so the production layout was
    never exercised and the real convert failed with ``Did not find file
    …/matrix.mtx.gz``. Same trio, staged the way the server stages it, must convert."""
    n_cells, n_genes = 30, 12
    rng = np.random.default_rng(23)
    dense = ((rng.random((n_cells, n_genes)) < 0.5) * rng.integers(1, 50, (n_cells, n_genes))).astype(np.int32)
    barcodes = [f"AAACCTG{i:05d}-1" for i in range(n_cells)]
    gene_ids = [f"ENSG{100000000 + j:09d}" for j in range(n_genes)]
    symbols = [f"GENE{j}" for j in range(n_genes)]
    feature_types = ["Gene Expression"] * n_genes

    def populate(d: Path):
        _write_10x_trio(d, dense, barcodes, gene_ids, symbols, feature_types)
        # Rename to the server's ordinal-prefixed subpaths + declare the slots exactly
        # as `dataset/process.rs::build_dataset_inputs` does for a 3-file dataset.
        staged = []
        for ordinal, base in enumerate(("matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz")):
            (d / base).rename(d / f"{ordinal}_{base}")
            staged.append({"slot": f"dataset_{ordinal}", "sandbox_path": f"/inputs/{ordinal}_{base}"})
        (d / "inputs.json").write_text(json.dumps({"inputs": staged}))

    _manifest, outputs_dir = run_converter_mtx(populate)

    meta = load_dataset_metadata(outputs_dir)
    assert meta["source_format"] == "10x_mtx"
    assert (meta["n_obs"], meta["n_vars"]) == (n_cells, n_genes)

    got_dense, cells, genes = reconstruct(outputs_dir)
    assert cells == barcodes
    assert genes == symbols
    np.testing.assert_array_equal(got_dense.astype(np.int64), dense.astype(np.int64))


def test_10x_mtx_trio_converts_from_legacy_uncompressed_layout(run_converter_mtx):
    """A legacy (Cell Ranger v2) trio — plain ``matrix.mtx`` + ``genes.tsv`` (2 cols) +
    ``barcodes.tsv``, ordinal-prefixed by the server — is canonicalized to the layout
    scanpy's legacy reader expects, so it converts too."""
    n_cells, n_genes = 20, 8
    rng = np.random.default_rng(29)
    dense = ((rng.random((n_cells, n_genes)) < 0.6) * rng.integers(1, 30, (n_cells, n_genes))).astype(np.int32)
    barcodes = [f"TTTGCAT{i:05d}-1" for i in range(n_cells)]
    gene_ids = [f"ENSG{200000000 + j:09d}" for j in range(n_genes)]
    symbols = [f"LEG{j}" for j in range(n_genes)]

    def populate(d: Path):
        X = sp.csr_matrix(dense.astype(np.int32))
        sio.mmwrite(str(d / "0_matrix.mtx"), X.T.tocsr())
        (d / "1_barcodes.tsv").write_text("".join(f"{b}\n" for b in barcodes))
        (d / "2_genes.tsv").write_text("".join(f"{g}\t{s}\n" for g, s in zip(gene_ids, symbols)))

    _manifest, outputs_dir = run_converter_mtx(populate)

    meta = load_dataset_metadata(outputs_dir)
    assert meta["source_format"] == "10x_mtx"
    assert (meta["n_obs"], meta["n_vars"]) == (n_cells, n_genes)
    _dense, cells, genes = reconstruct(outputs_dir)
    assert cells == barcodes
    assert genes == symbols


def test_spatial_h5ad_with_3d_image_converts_not_crashes(run_converter):
    """A spatial .h5ad carries a 3-D tissue image at uns['spatial'][lib]['images']
    ['hires'].

    This case existed because `tiledbsoma.io` REJECTS ndim>=3 arrays, so a Visium
    file hard-failed the whole conversion unless `uns` was sanitized first — and the
    sanitizer was expensive enough to force a whole-file in-memory read. ITEM-27
    deleted the writer that had the restriction, so the constraint is gone with it;
    the case is kept as a REGRESSION guard, because "the format no longer objects" is
    exactly the kind of claim that quietly stops being true. The matrix must convert
    whole, and the spatial ALIGNMENT PLAN must carry the library, the image key and the
    scale factor derived from `scalefactors`.

    KNOWN GAP, stated rather than hidden: `obsm['spatial']`'s coordinate VALUES used to
    live in the SOMA store's obsm and are not emitted as an artifact of their own, so
    `plan['coords_key']` currently names a key with no shipped bytes behind it. Emitting
    them needs a new output id + datatype + a frontend consumer — a decision of its own
    rather than a consequence of deleting the transpose buffer.
    """
    n_cells, n_genes = 50, 12
    rng = np.random.default_rng(3)
    X = sp.csr_matrix((rng.random((n_cells, n_genes)) < 0.4) * rng.integers(1, 40, (n_cells, n_genes)))
    adata = ad.AnnData(X=X.astype(np.float32))
    adata.obs_names = [f"cell{i}" for i in range(n_cells)]
    adata.var_names = [f"GENE{j}" for j in range(n_genes)]
    coords = rng.random((n_cells, 2)).astype(np.float32) * 1000
    adata.obsm["spatial"] = coords
    # The offending 3-D raster + a scalefactors dict (scalars must survive).
    adata.uns["spatial"] = {
        "libA": {
            "images": {"hires": (rng.random((64, 64, 3)) * 255).astype(np.uint8)},
            "scalefactors": {"tissue_hires_scalef": 0.17, "spot_diameter_fullres": 89.4},
        }
    }

    # Must NOT raise (previously ValueError: only 1D or 2D dense arrays are supported).
    manifest, outputs_dir = run_converter(adata)

    # The matrix converted, whole, despite the raster sitting in `uns`.
    csc = read_expression_csc(outputs_dir)
    assert csc.shape == (n_cells, n_genes)
    np.testing.assert_allclose(
        np.asarray(csc.todense()), np.asarray(X.todense()), rtol=1e-5
    )
    # The spatial trio is emitted, with the coords + scalefactors it needs.
    spatial = [e for e in manifest["outputs"] if e["id"] == "spatial"]
    assert len(spatial) == 1, "the spatial coords + image affine are emitted"
    plan = json.loads((outputs_dir / "spatial.json").read_text())
    assert plan["library"] == "libA"
    assert plan["image_key"] == "hires" and plan["coords_key"] == "spatial"
    assert (plan["height"], plan["width"]) == (64, 64)
    # `tissue_hires_scalef` (0.17) survives as the plan's scale factor + its affine.
    assert abs(float(plan["scale_factor"]) - 0.17) < 1e-6
    assert abs(float(plan["affine"][0]) - 0.17) < 1e-6
    assert abs(float(plan["spot_diameter_fullres"]) - 89.4) < 1e-6


def test_emits_csc_expression_readable_gene_columns(run_converter):
    """The converter emits `expression/` as a CSC **Zarr v3** store (ITEM-27/28):
    `indptr`/`indices`/`data` as three sharded members under one group, decodable by
    the same shard container every other artifact uses. Each gene column decodes to
    the right (cell, value) pairs."""
    n_cells, n_genes = 60, 15
    rng = np.random.default_rng(21)
    dense = ((rng.random((n_cells, n_genes)) < 0.3) * rng.integers(1, 50, (n_cells, n_genes))).astype(np.float32)
    adata = ad.AnnData(X=sp.csr_matrix(dense))
    adata.obs_names = [f"c{i}" for i in range(n_cells)]
    adata.var_names = [f"g{j}" for j in range(n_genes)]

    manifest, outputs_dir = run_converter(adata)

    # The manifest declares a single-cell/expression artifact at `expression`.
    expr = [e for e in manifest["outputs"] if e.get("datatype") == "single-cell/expression"]
    assert len(expr) == 1, "one expression artifact for a single-modality dataset"
    assert expr[0]["path"] == "expression" and expr[0]["layout"] == "chunked-sparse"
    assert expr[0]["structure"]["encoding"] == "zarr_v3", "no raw-bin trio survives"
    assert expr[0]["structure"]["kind"] == "sparse_csc"
    assert expr[0]["structure"]["axes"] == ["cells", "genes"]

    csc = read_expression_csc(outputs_dir)
    assert csc.shape == (n_cells, n_genes)
    # Every gene column's non-zeros match the source, cell-for-cell + value-for-value.
    src = sp.csc_matrix(dense)
    for g in range(n_genes):
        got = csc[:, g].tocoo()
        want = src[:, g].tocoo()
        assert sorted(zip(got.row.tolist(), got.data.tolist())) == \
               sorted(zip(want.row.tolist(), want.data.tolist())), f"gene {g} column mismatch"


def test_emits_per_modality_expression_split(run_converter):
    """A multi-modality var['feature_types'] → ONE per-modality matrix artifact each,
    each holding only that modality's genes. Slice-6 multimodal design (INV-9): the
    modalities are PEER datatypes — RNA → single-cell/expression, Antibody Capture →
    single-cell/protein (NOT a second single-cell/expression)."""
    n_cells, n_gex, n_ab = 40, 12, 4
    rng = np.random.default_rng(22)
    dense = ((rng.random((n_cells, n_gex + n_ab)) < 0.3) * rng.integers(1, 30, (n_cells, n_gex + n_ab))).astype(np.float32)
    adata = ad.AnnData(X=sp.csr_matrix(dense))
    adata.obs_names = [f"c{i}" for i in range(n_cells)]
    adata.var_names = [f"f{j}" for j in range(n_gex + n_ab)]
    adata.var["feature_types"] = ["Gene Expression"] * n_gex + ["Antibody Capture"] * n_ab

    manifest, outputs_dir = run_converter(adata)
    # Collect the per-modality matrix family (peer datatypes, INV-9), keyed by the raw
    # feature_types provenance string carried in meta.
    matrix_dts = {"single-cell/expression", "single-cell/protein", "single-cell/atac", "single-cell/modality"}
    expr = [e for e in manifest["outputs"] if e.get("datatype") in matrix_dts]
    assert len(expr) == 2, "one per-modality matrix artifact per modality"
    by_mod = {e["meta"]["feature_types"]: e for e in expr}
    # RNA is single-cell/expression; the antibody modality is the PEER single-cell/protein.
    assert by_mod["Gene Expression"]["datatype"] == "single-cell/expression"
    assert by_mod["Antibody Capture"]["datatype"] == "single-cell/protein"
    assert by_mod["Gene Expression"]["meta"]["n_vars"] == n_gex
    assert by_mod["Antibody Capture"]["meta"]["n_vars"] == n_ab
    # The Antibody split decodes to exactly the last n_ab columns of the source.
    ab_csc = read_expression_csc(outputs_dir, by_mod["Antibody Capture"]["path"], n_rows=n_cells)
    assert ab_csc.shape == (n_cells, n_ab)
    np.testing.assert_array_equal(
        np.asarray(ab_csc.todense()), dense[:, n_gex:], 
    )


def test_no_soma_store_is_written_and_the_processor_does_not_import_tiledbsoma():
    """TEST-38's producer-side half (ITEM-27): the deletion is COMPLETE.

    A half-done removal leaves the store written and merely unreferenced, which costs
    the full 86 % and buys nothing — and it would be invisible to every other test
    here, since they all assert on what IS emitted. So: no run produces a `.soma`
    path (checked by `assert_no_soma_store` on every read-back above), and the
    processor source no longer mentions the library at all.
    """
    import ast

    tree = ast.parse(SCRIPT.read_text())
    # Parsed, not grepped: the module's PROSE still explains what was deleted and why,
    # and a text scan that forbade the word would force that history to be erased too.
    # What must be absent is executable.
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "tiledbsoma" not in imported, "the processor still imports tiledbsoma"

    called = {
        node.func.attr for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert not called & {"from_h5ad", "from_anndata"}, "a SOMA writer is still called"

    # `stream_csc_from_soma` was the read-back; `_csc_structure` was the raw-bin
    # declaration it fed; the two `uns` helpers existed only to keep `tiledbsoma.io`
    # from rejecting a 3-D raster. All four are retired by the streaming transpose.
    defined = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert not defined & {"stream_csc_from_soma", "_csc_structure", "_uns_keys_safe",
                          "_strip_highdim_uns"}, "a SOMA-only helper survived ITEM-27"
    assert "write_expression_csc" in defined, "the replacement writer is wired in"
