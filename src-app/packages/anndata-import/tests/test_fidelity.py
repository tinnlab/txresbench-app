#!/usr/bin/env python3
"""Fidelity test suite for the h5ad / 10x → Zarr converter (ITEM-19; read-back
re-anchored by ITEM-27).

These tests are the scientific-accuracy gate for the anndata-import extension.
They enforce the § Output-specification invariants (INV-1..9) from
``.lifecycle/anndata-h5ad/PLAN.md`` by RUNNING the real converter off-sandbox
(via its ``CYTO_INPUTS_DIR`` / ``CYTO_OUTPUTS_DIR`` seam) and reading its outputs
back.

**What ITEM-27 changed here, precisely.** The read-back used to go through
``tiledbsoma``: a `to_anndata` round-trip of the store the converter wrote. That
store is deleted — it was the TRANSPOSE BUFFER the CSC matrix was streamed back out
of, not a second output — so these invariants are now checked against the artifacts
the converter ships: the CSC Zarr matrix, the per-axis entity indexes, and the obs/var
metadata columns.

Two invariants genuinely changed shape rather than changing reader, and both are
stated in the tests that own them rather than quietly dropped:

  * **INV-2 (dtype)** — the SOMA store preserved the SOURCE dtype; the CSC has always
    stored `float32`. So "an int source stays integer" becomes "the integers survive
    float32 exactly AND the source width is recorded in `meta.source_dtype`". That is a
    real, checkable claim about a real, recorded fact — not the old one weakened.
  * **INV-8 (golden round-trip)** — `to_anndata` reconstructed the WHOLE AnnData,
    including `layers` / `raw` / `uns` / `obsp`, which the design deliberately stops
    storing. The round-trip is therefore over what IS shipped (X + obs + var + both
    label axes), and the test asserts explicitly that the dropped components are still
    RECORDED in `dataset-metadata` — so their absence is a documented fact rather than
    an unnoticed one.

Fixtures are small (~1.2k cells) so the whole suite is fast.

Run with: ``pytest test_fidelity.py`` (needs ``anndata`` + ``scipy`` in the venv).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# Hard deps — skip cleanly (rather than error at collection) if the scientific
# stack is not installed in the running interpreter.
np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")
ad = pytest.importorskip("anndata")


# ─────────────────────────── converter under test ────────────────────────────

_HERE = Path(__file__).resolve().parent
# The shared sandbox scripts dir (where `colsummary.py` lives). In-sandbox the runner
# stages it alongside the entry script; off-sandbox the harness must put it on the
# subprocess PYTHONPATH (the entry script self-inserts only its OWN co-located dir).
_SCRIPTS_DIR = _HERE.parents[1] / "_helpers"
# The shared OUTPUT-FORMAT library (`_lib`: `cyto_zarr` / `cyto_columns`, DEC-7). The
# sandbox runner stages it into `/code` next to the `_helpers` modules, so the
# subprocess needs it on PYTHONPATH or the converter dies at import.
_LIB_DIR = _HERE.parents[1] / "_lib"
# Prefer the co-located compute copy (the extension-folder layout the plan moves
# to); fall back to the canonical server scripts path where the script lives today.
_SCRIPT_CANDIDATES = [
    # Co-located with the manifest (matches `run.entry: compute/h5ad_import.py`).
    _HERE.parent / "compute" / "h5ad_import.py",
]
SCRIPT = next((p for p in _SCRIPT_CANDIDATES if p.exists()), _SCRIPT_CANDIDATES[-1])

EXPRESSION_REL = "expression"   # the converter's CSC Zarr matrix output path

sys.path.insert(0, str(_LIB_DIR))
import cyto_csc            # noqa: E402  — the `_lib` CSC reader (producer-side only)
import cyto_zarr           # noqa: E402  — the writer, for the misalignment fixture below
import cyto_zarr_read      # noqa: E402


# ─────────────────────────────── run harness ─────────────────────────────────

@pytest.fixture
def run_converter(tmp_path):
    """Return a callable ``run(adata) -> (manifest, outputs_dir)`` that drives the
    REAL converter script off-sandbox.

    It writes ``adata`` to ``inputs/data.h5ad``, points ``CYTO_INPUTS_DIR`` /
    ``CYTO_OUTPUTS_DIR`` at temp dirs (the ONLY seam that runs the real script
    outside bwrap), runs ``python h5ad_import.py`` as a subprocess, asserts a
    clean exit 0, and returns the parsed ``outputs/manifest.json`` plus the
    outputs directory Path.
    """
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

    return run


# ───────────────────────────── read-back helpers ─────────────────────────────

def read_expression_csc(outputs_dir: Path, rel: str = EXPRESSION_REL):
    """The converter's CSC matrix, decoded from its Zarr store into a scipy CSC —
    through the same shard container a client decodes."""
    stray = [p.name for p in outputs_dir.iterdir() if p.name.endswith(".soma")]
    assert not stray, f"a SOMA store survives in the outputs: {stray}"
    base = outputs_dir / rel
    assert (base / "zarr.json").exists(), f"no CSC Zarr store at {base}"
    indptr, indices, data = cyto_csc.read_csc(base)
    structure = json.loads((base / "zarr.json").read_text())["attributes"]["cyto"]
    return sp.csc_matrix(
        (data, indices.astype(np.int64), indptr),
        shape=(int(structure["shape"][0]), len(indptr) - 1),
    )


def read_column_artifact(outputs_dir: Path, rel: str):
    """One metadata-column artifact's VALUES (labels for a categorical/string column,
    the numeric array otherwise)."""
    path = outputs_dir / rel
    assert path.exists(), f"no metadata-column artifact at {path}"
    return list(cyto_zarr_read.read_column(path))


def read_labels(outputs_dir: Path, axis: str):
    """The per-axis entity keys: `cells` → barcodes, `genes` → gene labels."""
    return read_column_artifact(outputs_dir, f"metadata/{axis}_index.zarr")


def load_dataset_metadata(outputs_dir: Path) -> dict:
    """The harvested ``dataset-metadata.json`` the FW-8 finalize hook consumes."""
    return json.loads((outputs_dir / "dataset-metadata.json").read_text())


def embedding_entries(manifest: dict) -> list[dict]:
    return [e for e in manifest["outputs"] if e.get("datatype") == "embedding"]


# ─────────────────────────────── fixtures/data ───────────────────────────────

N_OBS = 1200
N_VARS = 300


def _obs_var_index(adata):
    adata.obs_names = [f"cell_{i}" for i in range(adata.n_obs)]
    adata.var_names = [f"gene_{j}" for j in range(adata.n_vars)]
    return adata


def make_int_csr_adata(seed: int = 0, n_obs: int = N_OBS, n_vars: int = N_VARS):
    """A known **int32 CSR** count matrix — deterministic positive integers."""
    rng = np.random.default_rng(seed)
    mask = rng.random((n_obs, n_vars)) < 0.1
    vals = rng.integers(1, 500, size=(n_obs, n_vars))
    dense = (mask * vals).astype(np.int32)
    X = sp.csr_matrix(dense)
    X.eliminate_zeros()
    a = ad.AnnData(X=X)
    return _obs_var_index(a)


def make_lognorm_adata(seed: int = 1, n_obs: int = N_OBS, n_vars: int = N_VARS):
    """A **log-normalized float** matrix: non-integer values all < 10 (must be
    classified as NOT raw counts, and never force-cast to int)."""
    rng = np.random.default_rng(seed)
    mask = rng.random((n_obs, n_vars)) < 0.1
    counts = rng.integers(1, 300, size=(n_obs, n_vars))
    # log1p of a normalized count → non-integer, compressed to a small range.
    dense = (np.log1p(counts.astype(np.float32) / 10.0) * mask).astype(np.float32)
    assert dense.max() < 10.0
    X = sp.csr_matrix(dense)
    X.eliminate_zeros()
    a = ad.AnnData(X=X)
    return _obs_var_index(a)


def make_embeddings_adata(with_obsm: bool = True):
    """Int-counts adata with obsm ``X_umap`` (2-D) + ``X_pca`` (10-D), or none."""
    a = make_int_csr_adata(seed=2)
    if with_obsm:
        rng = np.random.default_rng(3)
        a.obsm["X_umap"] = rng.standard_normal((a.n_obs, 2)).astype(np.float32)
        a.obsm["X_pca"] = rng.standard_normal((a.n_obs, 10)).astype(np.float32)
    return a


def make_10x_like_adata():
    """Int-counts adata carrying the 10x var annotations that must survive:
    ``var['gene_ids']`` (Ensembl) + ``var['feature_types']`` (modality)."""
    import pandas as pd

    a = make_int_csr_adata(seed=4)
    n = a.n_vars
    a.var["gene_ids"] = [f"ENSG{100000000 + j:09d}" for j in range(n)]
    # A mix of modalities so the feature_types breakdown is non-trivial.
    ftypes = ["Gene Expression"] * (n - 5) + ["Antibody Capture"] * 5
    a.var["feature_types"] = pd.Categorical(ftypes)
    return a


# ──────────────────────────────────── tests ──────────────────────────────────

def test_inv1_inv2_value_and_dtype_fidelity(run_converter):
    """INV-1 (value/nnz) + INV-2 (dtype): a known int32 CSR reaches the emitted CSC
    with identical nnz, an identical nonzero-value multiset (exact for int), and its
    SOURCE WIDTH recorded.

    INV-2 changed shape with the SOMA store (see the module docstring): the store was
    what carried the source dtype, and the CSC has always stored `float32`. So the two
    halves of "no force-cast" are checked directly — the integer values survive float32
    EXACTLY (no rounding, no truncation), and `meta.source_dtype` still names the width
    they came in at. A silent widening or narrowing fails the first; losing the
    provenance fails the second."""
    adata = make_int_csr_adata()
    src = adata.X.tocsr()
    src.eliminate_zeros()
    src_nnz = int(src.nnz)
    src_vals = np.sort(np.asarray(src.data))

    manifest, outputs_dir = run_converter(adata)
    csc = read_expression_csc(outputs_dir)

    # INV-1: nnz preserved.
    assert csc.nnz == src_nnz

    # INV-1: nonzero value multiset preserved exactly (int → exact equality through
    # float32, which is lossless for counts far past anything a sequencer emits).
    got_vals = np.sort(np.asarray(csc.data, dtype=np.float64))
    assert got_vals.shape[0] == src_vals.shape[0]
    np.testing.assert_array_equal(got_vals, src_vals.astype(np.float64))
    assert np.array_equal(got_vals, np.round(got_vals)), "integers came back non-integral"

    # INV-2: the source width is recorded rather than inferred or lost.
    expr = [e for e in manifest["outputs"] if e["id"] == "expression"][0]
    assert expr["meta"]["source_dtype"] == "int32", expr["meta"]
    assert expr["structure"]["data"]["dtype"] == "float32", "the store declares its width"


def test_inv3_shape_and_label_fidelity(run_converter):
    """INV-3: n_obs / n_vars preserved, and obs_names / var_names preserved AND
    consistent with matrix order — read back from the per-axis entity-index artifacts
    (`cells_index` / `genes_index`), which is where the labels now live."""
    adata = make_int_csr_adata()
    _manifest, outputs_dir = run_converter(adata)

    csc = read_expression_csc(outputs_dir)
    assert csc.shape == (adata.n_obs, adata.n_vars)
    assert read_labels(outputs_dir, "cells") == list(map(str, adata.obs_names))
    assert read_labels(outputs_dir, "genes") == list(map(str, adata.var_names))
    # Order-consistency is the load-bearing half: label i must describe ROW/COLUMN i.
    # A permuted index would still pass a set comparison, so compare a real column.
    src = adata.X.tocsc()
    for j in (0, adata.n_vars // 2, adata.n_vars - 1):
        np.testing.assert_array_equal(
            np.asarray(csc[:, j].todense()).ravel().astype(np.int64),
            np.asarray(src[:, j].todense()).ravel().astype(np.int64),
        )


def test_inv5_embedding_completeness_present(run_converter):
    """INV-5: an adata with obsm ``X_umap`` (2-D) + ``X_pca`` (10-D) yields
    EXACTLY 2 ``embedding`` outputs, labeled UMAP + PCA."""
    adata = make_embeddings_adata(with_obsm=True)
    manifest, _outputs_dir = run_converter(adata)

    embs = embedding_entries(manifest)
    assert len(embs) == 2, f"expected 2 embeddings, got {[e['id'] for e in embs]}"
    assert {e.get("label") for e in embs} == {"UMAP", "PCA"}

    # Each carries its source_key + n_dims in meta (harvested descriptor).
    by_key = {e["meta"]["source_key"]: e["meta"] for e in embs}
    assert by_key["X_umap"]["n_dims"] == 2
    assert by_key["X_pca"]["n_dims"] == 10


def test_inv5_embedding_completeness_absent(run_converter):
    """INV-5 (zero case): an adata with NO obsm yields ZERO embedding outputs
    (cardinality ``many`` legitimately = 0)."""
    adata = make_embeddings_adata(with_obsm=False)
    manifest, outputs_dir = run_converter(adata)

    assert len(embedding_entries(manifest)) == 0
    assert load_dataset_metadata(outputs_dir)["n_embeddings"] == 0


def test_inv6_integer_counts_labeled_raw(run_converter):
    """INV-6: an integer-counts matrix is classified ``x_state == "raw_counts"``."""
    adata = make_int_csr_adata()
    _manifest, outputs_dir = run_converter(adata)

    meta = load_dataset_metadata(outputs_dir)
    assert meta["x_state"] == "raw_counts"
    assert meta["count_source"] == "X"


def test_inv6_lognorm_not_labeled_raw_and_not_cast(run_converter):
    """INV-6: a log-normalized float matrix is NEVER labeled raw counts, and the
    stored matrix is NOT force-cast to int (values stay float, byte-close)."""
    adata = make_lognorm_adata()
    src = adata.X.tocsr()
    src.eliminate_zeros()
    src_vals = np.sort(np.asarray(src.data, dtype=np.float64))

    _manifest, outputs_dir = run_converter(adata)

    meta = load_dataset_metadata(outputs_dir)
    assert meta["x_state"] != "raw_counts", meta["x_state"]
    # No integer count source was fabricated from a float matrix.
    assert meta["count_source"] is None

    # NOT force-cast: the values stay non-integral and are preserved. The legacy
    # `as.integer` bug would show up as a column of whole numbers.
    csc = read_expression_csc(outputs_dir)
    got_vals = np.sort(np.asarray(csc.data, dtype=np.float64))
    assert got_vals.shape[0] == src_vals.shape[0]
    assert not np.allclose(got_vals, np.round(got_vals)), (
        "float matrix was cast to integer (the legacy as.integer bug)"
    )
    np.testing.assert_allclose(got_vals, src_vals, rtol=1e-6, atol=1e-6)


def test_inv7_10x_gene_ids_and_feature_types_preserved(run_converter):
    """INV-7: ``var['gene_ids']`` + ``var['feature_types']`` survive — recorded in the
    harvested metadata AND readable back, value-for-value.

    These lived ONLY in the SOMA var frame until ITEM-27. Deleting the store without
    replacing them would have dropped every GENE annotation while keeping every CELL
    one — a silent, asymmetric data loss — so `var` columns are now emitted as
    axis=genes `metadata-column` artifacts, exactly like `obs` columns, and read back
    as such here."""
    adata = make_10x_like_adata()
    _manifest, outputs_dir = run_converter(adata)

    # Recorded in metadata: gene-id presence + feature_types breakdown.
    meta = load_dataset_metadata(outputs_dir)
    assert meta["has_gene_ids"] is True
    assert meta["feature_types"] == {
        "Gene Expression": adata.n_vars - 5,
        "Antibody Capture": 5,
    }
    var_col_names = {c["name"] for c in meta["var_columns"]}
    assert {"gene_ids", "feature_types"} <= var_col_names

    # Readable back: both columns ship as artifacts, value-for-value and in var order.
    assert read_column_artifact(outputs_dir, "metadata/var/gene_ids.zarr") == list(
        map(str, adata.var["gene_ids"])
    )
    assert read_column_artifact(outputs_dir, "metadata/var/feature_types.zarr") == list(
        map(str, adata.var["feature_types"])
    )
    # …and they are declared on the GENES axis, so a consumer can align them.
    var_entries = {
        e["label"]: e for e in _manifest["outputs"]
        if e.get("datatype") == "metadata-column" and e.get("axis") == "genes"
    }
    assert {"gene_ids", "feature_types"} <= set(var_entries)


def test_inv8_golden_round_trip(run_converter):
    """INV-8: the SHIPPED artifacts reconstruct the source — X value-for-value, both
    label axes, and every obs/var column.

    This used to be `to_anndata`, which reconstructed the WHOLE AnnData including
    `layers` / `raw` / `uns` / `obsp`. Those are not stored any more; that is the
    design's accepted scope, not an accident, so the test asserts the round-trip over
    what IS shipped and — in the same breath — that the dropped components are still
    RECORDED in `dataset-metadata`. An unrecorded loss and a recorded one are very
    different facts, and only the second is a decision."""
    import pandas as pd

    adata = make_int_csr_adata()
    adata.obs["cluster"] = pd.Categorical(
        ["a" if i % 3 else "b" for i in range(adata.n_obs)]
    )
    adata.var["gene_ids"] = [f"ENSG{j:09d}" for j in range(adata.n_vars)]
    # Deliberately present, deliberately NOT round-tripped — see below.
    adata.layers["counts"] = adata.X.copy()
    adata.uns["provenance"] = {"pipeline": "test"}

    manifest, outputs_dir = run_converter(adata)

    csc = read_expression_csc(outputs_dir)
    assert csc.shape == adata.shape
    np.testing.assert_array_equal(
        np.asarray(csc.todense()).astype(np.int64),
        np.asarray(adata.X.todense()).astype(np.int64),
    )
    assert read_labels(outputs_dir, "cells") == list(map(str, adata.obs_names))
    assert read_labels(outputs_dir, "genes") == list(map(str, adata.var_names))
    assert read_column_artifact(outputs_dir, "metadata/cluster.zarr") == list(
        map(str, adata.obs["cluster"])
    )
    assert read_column_artifact(outputs_dir, "metadata/var/gene_ids.zarr") == list(
        map(str, adata.var["gene_ids"])
    )

    # The REDUCED scope, pinned: `layers` / `uns` are no longer stored, and are
    # recorded as having existed. If a future change starts shipping them, this is the
    # test that has to be updated deliberately rather than the loss being re-discovered.
    meta = load_dataset_metadata(outputs_dir)
    assert meta["layers"] == ["counts"]
    assert "provenance" in meta["uns_keys"]
    shipped = {e["path"] for e in manifest["outputs"]}
    assert not any(p.startswith("layers") for p in shipped)


# ── INV-3 / ITEM-19: the axis IDENTITY a real run emits, and the gate that checks it ──


def _key_declaring_outputs(manifest, axis):
    """Every output of a run whose `structure` names a key member on `axis`."""
    return [
        e for e in manifest["outputs"]
        if (e["structure"] or {}).get("key")
        and ((e["structure"] or {}).get("axis") or e.get("axis")) == axis
    ]


def test_a_real_run_emits_a_key_sequence_digest_on_every_key_artifact(run_converter):
    """INV-3's producer half, on the artifacts the shipped importer actually writes.

    An axis IS its key artifact and its identity is that artifact's `content_hash` — which
    INGEST mints, downstream of here, so no writer can declare it. What a producer CAN
    declare is what makes its bytes identifiable as an axis: WHICH member carries the
    ordered keys (`structure.key`) and WHAT they digest to (`structure.key_sequence_digest`).

    Before this, neither was emitted by any shipped processor: `cells_index` reached the
    catalog carrying `meta.is_axis_index` plus an axis LABEL and nothing else, so the
    label was the only thing distinguishing it from another dataset's cells axis — and
    ITEM-19's whole apparatus, which gates on `structure.key`, ran over nothing.
    """
    import conformance

    manifest, outputs_dir = run_converter(make_int_csr_adata())
    by_id = {e["id"]: e for e in manifest["outputs"]}

    for out_id, axis in (("cells_index", "cells"), ("genes_index", "genes")):
        entry = by_id[out_id]
        assert entry["meta"]["is_axis_index"] is True, (
            f"{out_id} must still SAY it is the axis — that declaration is what the "
            "server's resolver matches on"
        )
        structure = entry["structure"]
        assert structure["key"] == "values", f"{out_id} declares which member holds the keys"
        assert structure["key_sequence_digest"] == conformance.key_sequence_digest(
            read_labels(outputs_dir, axis)
        ), f"{out_id}'s declared digest is the digest of the keys it actually stored"

        # The gate's own verdict, from the BYTES, over the real artifact.
        assert conformance.conform_artifact(
            outputs_dir / entry["path"], structure, full=True
        ) == [], f"{out_id} does not conform"


def test_the_alignment_check_runs_across_a_real_run_and_bites(run_converter):
    """ITEM-19's CROSS-artifact half, wired to something that exists.

    The check compares the key sequences of every output that named the same axis AND a
    key member. It needs at least two such outputs on one axis to compare anything at all,
    which no run produced while nothing emitted `structure.key`. A real import now emits
    two on the `cells` axis — `cells_index` and the `cell_id` column, both written from
    `obs_names` — so the check has a real pair to hold to each other.

    Non-vacuity is asserted, not assumed: the clean run reports no misalignment, and then
    ONE of the pair is replaced with the same barcodes in reverse order — a permutation,
    so every shape/dtype/length/byte-level check still passes — and the run-level report
    names both artifacts as disagreeing.
    """
    import conformance

    manifest, outputs_dir = run_converter(make_int_csr_adata())

    pair = _key_declaring_outputs(manifest, "cells")
    ids = sorted(e["id"] for e in pair)
    assert len(pair) >= 2, (
        "the alignment check compares key sequences ACROSS outputs, so a run with fewer "
        f"than two key-declaring outputs on the `cells` axis exercises nothing: {ids}"
    )
    assert "cells_index" in ids

    misaligned = [
        v for _labels, v in conformance.conform_manifest(outputs_dir, manifest)
        if "declared to share one axis" in v or "actually digests to" in v
    ]
    assert misaligned == [], f"a clean run must align: {misaligned}"

    # Replace ONE member of the pair with the reversed key sequence.
    victim = next(e for e in pair if e["id"] != "cells_index")
    keys = read_labels(outputs_dir, "cells")
    scrambled = outputs_dir / "scrambled.zarr"
    with cyto_zarr.Table(scrambled, axis="cells", n=len(keys), key="values") as t:
        t.string("values", keys[::-1])
        t.close()
    target = outputs_dir / victim["path"] / victim["structure"]["key"]
    shutil.rmtree(target)
    shutil.copytree(scrambled / "values", target)

    report = conformance.conform_manifest(outputs_dir, manifest)

    # (a) The PER-ARTIFACT half: the tampered artifact's own declaration no longer matches
    #     its bytes, and the violation is attributed to it by name.
    per_artifact = [(l, v) for l, v in report if "actually digests to" in v]
    assert [l for l, _ in per_artifact] == [[victim["id"]]], (
        "the declared-vs-stored digest check must name the ONE artifact whose bytes "
        f"stopped matching what it declared: {[(l, v) for l, v in report]}"
    )

    # (b) The CROSS-artifact half: the two outputs claiming the `cells` axis no longer
    #     hold the same ordered key sequence, and BOTH are named (neither is "the wrong
    #     one" — they disagree with each other).
    cross = [(l, v) for l, v in report if "declared to share one axis" in v]
    assert cross, (
        "two artifacts on one axis now hold the barcodes in DIFFERENT orders and the "
        f"run-level alignment check said nothing: {[v for _l, v in report]}"
    )
    labels, violation = cross[0]
    assert violation.startswith("axis 'cells'"), violation
    assert set(labels) >= {"cells_index", victim["id"]}, (
        f"the report must name WHICH artifacts disagree, got {labels}"
    )


# ── ITEM-15 / ITEM-53 — what an emitted artifact says about the row space it belongs to ──


def make_grouped_var_adata():
    """A 10x-like adata whose var also carries the GROUPING column the multi-modal combine
    stages (`read_h5mu_to_combined`'s `vf["modality"] = name`).

    Built as a var column rather than by running the combine because that is precisely what
    `main()` reads: the combine's whole output to this code path IS a staged `.h5ad` with a
    `modality` var column, and the emit loop is generic over `adata.var.columns`."""
    a = make_10x_like_adata()
    n = a.n_vars
    a.var["modality"] = ["rna"] * (n - 5) + ["prot"] * 5
    return a


def test_item15_every_emitted_artifact_names_the_row_space_it_belongs_to(run_converter):
    """The declaration, end to end through the REAL converter (ITEM-15).

    `structure.axis` is a LABEL — every dataset in a project spells its rows `cells` — so a
    consumer reading the catalog cannot tell whether a column may be painted on a given set
    of points. `aligned_to` names the axis's ordered KEY SEQUENCE by its digest, and the
    digest asserted against here is the one the axis's own key artifact declared in the SAME
    run, which is what makes the claim checkable rather than decorative.
    """
    # Every emitted SHAPE at once — an embedding, an obs column, a var column — because a
    # loop that only ever saw one of them would pass while the other two went undeclared.
    adata = make_embeddings_adata()
    adata.obs["total_counts"] = np.asarray(adata.X.sum(axis=1)).ravel()
    adata.var["gene_ids"] = [f"ENSG{100000000 + j:09d}" for j in range(adata.n_vars)]
    manifest, _outputs_dir = run_converter(adata)
    outputs = manifest["outputs"]
    by_id = {e["id"]: e for e in outputs}

    axis_digest = {
        axis: by_id[f"{axis}_index"]["structure"]["key_sequence_digest"]
        for axis in ("cells", "genes")
    }
    # The two axes are DIFFERENT row spaces; an assertion that could not tell them apart
    # would pass with every column declaring the same thing.
    assert axis_digest["cells"] != axis_digest["genes"]

    declared = 0
    for entry in outputs:
        structure = entry.get("structure") or {}
        axis = structure.get("axis") or entry.get("axis")
        if axis not in axis_digest or structure.get("key"):
            continue  # a matrix names two axes; a key artifact is aligned to itself
        assert structure.get("aligned_to") == axis_digest[axis], (
            f"{entry['id']} on the {axis!r} axis declares "
            f"{structure.get('aligned_to')!r}, not this run's {axis} key sequence"
        )
        declared += 1
    # The negative control: a loop over an empty set proves nothing. Both axes and all
    # three shapes must have been examined.
    assert declared >= 4, f"only {declared} artifacts were examined"
    assert {structure_axis for structure_axis in (
        (e.get("structure") or {}).get("axis") for e in outputs
        if (e.get("structure") or {}).get("aligned_to")
    )} == {"cells", "genes"}
    kinds = {e["datatype"] for e in outputs
             if (e.get("structure") or {}).get("aligned_to")}
    assert {"embedding", "metadata-column"} <= kinds, kinds


def test_item2_every_aligned_artifact_declares_which_rows_not_only_which_axis(run_converter):
    """ITEM-2's PRODUCER side, end to end through the REAL converter.

    `aligned_to` says WHICH AXIS. It does not say WHICH ROWS of it, and on the declarations
    alone a population of 6,000 selected out of 1,000,000 is indistinguishable from the parent.
    An import selects out of nothing — it re-emits the file — so every artifact it writes is
    the `full` case, which is the cheapest declaration in the vocabulary and the commonest.

    Declaring it is not decoration: a `full` membership carries `n_members`, and `n_members`
    is the DENOMINATOR the consumer's *"describes N of M rows"* is measured against. The
    legacy scalar (read as `full` with no count) supplies no denominator, so before this the
    figure could not be posed on any real project.
    """
    adata = make_embeddings_adata()
    adata.obs["total_counts"] = np.asarray(adata.X.sum(axis=1)).ravel()
    adata.var["gene_ids"] = [f"ENSG{100000000 + j:09d}" for j in range(adata.n_vars)]
    manifest, _outputs_dir = run_converter(adata)
    outputs = manifest["outputs"]
    by_id = {e["id"]: e for e in outputs}
    axis_digest = {
        axis: by_id[f"{axis}_index"]["structure"]["key_sequence_digest"]
        for axis in ("cells", "genes")
    }
    n_of = {"cells": adata.n_obs, "genes": adata.n_vars}

    declared = 0
    kinds = set()
    axes_seen = set()
    for entry in outputs:
        structure = entry.get("structure") or {}
        if not structure.get("aligned_to"):
            continue
        axis = structure.get("axis")
        memberships = structure.get("memberships")
        # ONE entry, and it is the WHOLE entry — asserted as an equality rather than by
        # picking keys off it, so an implementation that emitted the identity and dropped
        # `n_members` (the only part the consumer needs that the scalar did not already
        # carry) fails here rather than passing a shape check.
        assert memberships == [{
            "axis": axis,
            "aligned_to": axis_digest[axis],
            "kind": "full",
            "n_members": n_of[axis],
        }], f"{entry['id']} declares {memberships!r}"
        # …and the two spellings AGREE. A run in which they disagreed would be well-formed
        # on both readings and wrong on one.
        assert structure["aligned_to"] == memberships[0]["aligned_to"], entry["id"]
        declared += 1
        kinds.add(entry["datatype"])
        axes_seen.add(axis)
    # A loop over an empty set proves nothing: both axes and both emitted shapes.
    assert declared >= 4, f"only {declared} artifacts were examined"
    assert axes_seen == {"cells", "genes"}, axes_seen
    assert {"embedding", "metadata-column"} <= kinds, kinds


def test_item2_a_key_artifact_declares_no_membership_either(run_converter):
    """The artifacts that ARE the axis stay silent, for the reason they always did.

    A key artifact is aligned to itself; declaring a membership on itself alongside its own
    `key_sequence_digest` is the same contradiction `Table.close` refuses `aligned_to` for.
    Asserted because the natural way to add the producer declaration — stamp it on every
    emitted artifact — turns this run into a refusal at the writer, and it is exactly the
    kind of thing that gets fixed by weakening the writer.
    """
    manifest, _outputs_dir = run_converter(make_int_csr_adata())
    keyed = [e for e in manifest["outputs"] if (e.get("structure") or {}).get("key")]
    assert {e["id"] for e in keyed} == {"cells_index", "genes_index",
                                        "metadata-column:cell_id"}
    for entry in keyed:
        assert "memberships" not in entry["structure"], entry["id"]


def test_item15_a_key_artifact_declares_no_alignment_because_it_IS_one(run_converter):
    """The two artifacts that CARRY the cells axis's keys declare `key_sequence_digest` and
    no `aligned_to` — they are aligned to themselves, and declaring both is the
    contradiction the writer refuses."""
    manifest, _outputs_dir = run_converter(make_int_csr_adata())
    keyed = [e for e in manifest["outputs"] if (e.get("structure") or {}).get("key")]
    assert {e["id"] for e in keyed} == {"cells_index", "genes_index",
                                        "metadata-column:cell_id"}
    for entry in keyed:
        assert "aligned_to" not in entry["structure"], entry["id"]


def test_item53_the_grouping_column_declares_itself(run_converter):
    """TEST-66 — `meta.groups_entries: true` on the var column that groups the genes axis's
    entries, and on NOTHING else.

    The `meta.is_axis_index` precedent, for the same reason: the producer SAYS what the
    column is for, so the viewer asks an axis's columns *"does any of you group these
    entries?"* and never learns what the values mean. The exclusivity half is the load-
    bearing one — a flag on every column would make the viewer's question unanswerable, and
    it is what would break if the emit loop grew a heuristic.
    """
    manifest, _outputs_dir = run_converter(make_grouped_var_adata())
    grouping = {e["id"] for e in manifest["outputs"]
                if (e.get("meta") or {}).get("groups_entries") is True}
    assert grouping == {"metadata-column:var:modality"}, grouping

    # …and it is an ORDINARY column otherwise: same axis, same datatype, same alignment as
    # its neighbours, readable value-for-value. A grouping column that had to be special
    # would be a second kind of artifact.
    entry = next(e for e in manifest["outputs"]
                 if e["id"] == "metadata-column:var:modality")
    assert entry["axis"] == "genes" and entry["datatype"] == "metadata-column"
    assert entry["meta"].get("is_axis_index") is not True


def test_item53_an_import_with_no_grouping_column_declares_none(run_converter):
    """The negative control, and the ordinary case: a single-modality file has no grouping
    column at all, so nothing claims to be one — which is what makes the viewer's
    collapse-when-trivial rule (one group ⇒ no headings) the default rather than a special
    case."""
    manifest, _outputs_dir = run_converter(make_10x_like_adata())
    assert not [e for e in manifest["outputs"]
                if (e.get("meta") or {}).get("groups_entries")]
