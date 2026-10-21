#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-3, ITEM-5, ITEM-8] — REFERENCE PARITY.

*The emitted `doublet_score` is the reference implementation's output on the same matrix with
the same parameters and the same seed — not a lookalike computed from a different matrix.*

The dominant failure mode of a wrapper is NOT a wrong algorithm; it is the right algorithm
fed the wrong bytes — a transposed store, a normalized layer, an HVG subset, a reordered obs.
A test that only asserts "scores are in [0,1] and some cells are called" passes ALL of those,
which is why it is not the test.

So this stages the canonical RAW fixture as a real CSC artifact, runs the package compute
over the artifact form, independently runs `sc.pp.scrublet` over the AnnData form with the
IDENTICAL explicit parameter set and seed, and compares the two score vectors **joined by
BARCODE** — our side keyed by the barcodes of the `cells_index` artifact we staged, the
reference's side by its own `obs_names`. Both sides agree only if the compute's emitted
column is aligned to the INPUT row order, which is what a reordering bug would break.

── A MEASURED PROPERTY OF THE METHOD, worth stating ─────────────────────────────────────
Scrublet's scores are **row-order dependent**. `scrublet_simulate_doublets` draws pairs of
OBSERVED ROW INDICES from a seeded RNG, so permuting the input cells changes which pairs are
synthesized, changes the simulated population, and changes every cell's score. Measured on
this fixture: a shuffled copy of the same matrix, same parameters, same seed, differs by
~1.1e-2 — six orders of magnitude above this test's tolerance.

That is not a defect and it is not something to work around; it is a fact about the
provenance guarantee. "Same matrix, same parameters, same seed" reproduces a run ONLY
together with the same cell ORDER — which the artifact model gives us for free, because the
cells axis is an ordered key sequence and `structure.aligned_to` pins it. The reference below
is therefore built in the artifact's own row order, and `test_the_barcode_join_is_not_vacuous`
is what keeps the join from being a comparison that could not have failed.
"""
import numpy as np
import pytest

from doublet_fixtures import read_raw_fixture, require_skimage

pytest.importorskip("scanpy")
pytest.importorskip("anndata")

#: The fixture is 2,700 x 32,738; a Scrublet pass over the whole thing is ~4 s, but the CSC
#: round-trip through the harness is the slow part. Sub-setting deterministically by the
#: first N rows/columns keeps the test honest (still real raw pbmc3k counts, still thousands
#: of genes) while keeping the suite quick. The parity claim does not depend on the size.
N_CELLS, N_GENES = 900, 6000

#: EXACTLY the parameters `compute/doublet.py` resolves for this run, spelled out here rather
#: than imported, so the reference call is an INDEPENDENT statement of them. If the compute
#: silently changed one, this file would have to change too — which is the point.
SEED = 0
#: The SHIPPED default. Parity at a rank the product never uses would be parity for a
#: different computation than the one that runs, which is exactly the "right algorithm, wrong
#: bytes" class this test exists to catch — so it matches `compute/doublet.py`'s default.
N_PRIN_COMPS = 30


#: The reference is run in a SUBPROCESS with the six thread variables pinned, exactly as the
#: sandbox runs the compute. This is not ceremony — it is a measured requirement. Run
#: unpinned (as a bare pytest process is), the SAME `sc.pp.scrublet` call on the SAME matrix
#: with the SAME seed returns scores differing by ~9.2e-4 from the pinned run, because the
#: PCA's BLAS threading changes the reassociation. That is six orders of magnitude above this
#: test's tolerance, so an unpinned reference would make parity untestable and would hide
#: whatever real drift it was supposed to catch. It is also the concrete justification for
#: `_shared.py` pinning all six variables before numpy loads.
_REFERENCE_SCRIPT = r"""
import os, sys, json
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS"):
    os.environ.setdefault(_v, "1")
import numpy as np
import scipy.sparse as sp
import anndata as ad
import scanpy as sc

payload = np.load(sys.argv[1], allow_pickle=True)
X = sp.csr_matrix((payload["data"], payload["indices"], payload["indptr"]),
                  shape=tuple(payload["shape"]))
barcodes = [str(b) for b in payload["barcodes"]]
genes = [str(g) for g in payload["genes"]]
rate = float(payload["rate"])
n_prin_comps = int(payload["n_prin_comps"])
seed = int(payload["seed"])

adata = ad.AnnData(X=X)
adata.obs_names = barcodes
adata.var_names = genes
sc.pp.scrublet(
    adata,
    batch_key=None,
    sim_doublet_ratio=2.0,
    expected_doublet_rate=rate,
    stdev_doublet_rate=0.02,
    synthetic_doublet_umi_subsampling=1.0,
    knn_dist_metric="euclidean",
    normalize_variance=True,
    log_transform=False,
    mean_center=True,
    n_prin_comps=n_prin_comps,
    use_approx_neighbors=False,
    get_doublet_neighbor_parents=False,
    n_neighbors=None,
    threshold=None,
    verbose=False,
    copy=False,
    random_state=seed,
)
out = {
    "barcodes": [str(b) for b in adata.obs_names],
    "scores": [float(v) for v in adata.obs["doublet_score"].values],
    "threshold": (float(adata.uns["scrublet"]["threshold"])
                  if "threshold" in adata.uns["scrublet"] else None),
}
with open(sys.argv[2], "w") as fh:
    json.dump(out, fh)
"""


def _reference_scores(tmp_path, X, barcodes, gene_names, *, expected_rate):
    """`{barcode: score}` and the resolved threshold from a DIRECT `sc.pp.scrublet` call.

    Built in the artifact's own row order, because Scrublet's simulated-doublet draw is
    row-order dependent (see the module docstring) — a permuted reference would be a
    DIFFERENT computation, not a re-ordering of the same one. Run in a pinned subprocess for
    the reason recorded above `_REFERENCE_SCRIPT`.
    """
    import json
    import subprocess
    import sys

    import scipy.sparse as sp

    csr = sp.csr_matrix(X)
    npz = tmp_path / "reference-input.npz"
    script = tmp_path / "reference.py"
    out = tmp_path / "reference-output.json"
    np.savez(npz, data=csr.data, indices=csr.indices, indptr=csr.indptr,
             shape=np.asarray(csr.shape), barcodes=np.asarray(barcodes, dtype=object),
             genes=np.asarray(list(gene_names), dtype=object),
             rate=np.asarray(expected_rate), n_prin_comps=np.asarray(N_PRIN_COMPS),
             seed=np.asarray(SEED))
    script.write_text(_REFERENCE_SCRIPT)
    proc = subprocess.run([sys.executable, str(script), str(npz), str(out)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, (
        f"the reference sc.pp.scrublet run failed:\n{proc.stdout}\n{proc.stderr}")
    body = json.loads(out.read_text())
    return dict(zip(body["barcodes"], body["scores"])), body["threshold"]


def test_scores_match_the_reference_implementation_aligned_by_barcode(detect_run, tmp_path):
    require_skimage()
    X, barcodes, gene_names, _types = read_raw_fixture(N_CELLS, N_GENES)

    # The auto rate the compute will derive for this population, computed here independently
    # from the 10x rule so the reference is not just echoing the compute.
    expected_rate = min(max(0.008 * X.shape[0] / 1000.0, 0.005), 0.25)

    run = detect_run()
    run.add_matrix(X)
    run.add_cells_index(barcodes)
    run.run_ok({"n_prin_comps": str(N_PRIN_COMPS), "seed": str(SEED)})

    ours = run.scores()
    assert ours.shape == (X.shape[0],)
    # every cell was scored — a NaN here would silently exclude a cell from the comparison
    assert np.isfinite(ours).all()

    ref, ref_threshold = _reference_scores(tmp_path, X, barcodes, gene_names,
                                           expected_rate=expected_rate)

    # ── the alignment is BY BARCODE ────────────────────────────────────────────────
    ours_by_barcode = dict(zip(barcodes, ours))
    assert set(ours_by_barcode) == set(ref)
    a = np.array([ours_by_barcode[b] for b in barcodes], dtype=np.float64)
    b = np.array([ref[bc] for bc in barcodes], dtype=np.float64)
    delta = float(np.max(np.abs(a - b)))
    assert delta <= 1e-9, (
        f"max |ours - reference| = {delta:.3e} over {len(barcodes)} cells, aligned by "
        "barcode. The thread pins are set, so exact agreement is the expectation and 1e-9 "
        "is slack for BLAS reassociation, not licence for drift."
    )

    # the resolved thresholds agree too — the call, not just the score, is the reference's
    ours_threshold = run.report()["batches"][0]["threshold"]
    assert ours_threshold is not None and ref_threshold is not None
    assert abs(float(ours_threshold) - float(ref_threshold)) <= 1e-9


def test_the_barcode_join_is_not_vacuous(detect_run, tmp_path):
    """The control that makes the parity test above mean something.

    A join is only evidence if a MIS-join would have been caught. If the score vector were
    constant (or near-constant), pairing the wrong barcode with the wrong score would still
    compare equal within 1e-9 and the parity assertion would pass with the alignment
    completely broken. So: take the reference's own map, look it up under a PERMUTED barcode
    order, and require that the result differs from ours by far more than the tolerance.

    This is the answer to "would this test go red if the invariant were violated?" — yes, and
    by ~7 orders of magnitude.
    """
    require_skimage()
    X, barcodes, gene_names, _types = read_raw_fixture(N_CELLS, N_GENES)
    expected_rate = min(max(0.008 * X.shape[0] / 1000.0, 0.005), 0.25)

    run = detect_run()
    run.add_matrix(X)
    run.add_cells_index(barcodes)
    run.run_ok({"n_prin_comps": str(N_PRIN_COMPS), "seed": str(SEED)})
    ours = run.scores()

    ref, _ = _reference_scores(tmp_path, X, barcodes, gene_names,
                               expected_rate=expected_rate)

    rng = np.random.default_rng(12345)
    perm = rng.permutation(len(barcodes))
    mis_joined = np.array([ref[barcodes[i]] for i in perm], dtype=np.float64)
    delta = float(np.max(np.abs(ours - mis_joined)))
    assert delta > 1e-3, (
        f"a deliberately MIS-JOINED comparison differs by only {delta:.3e}, which is inside "
        "the noise this fixture can distinguish — the parity assertion could pass with the "
        "barcode alignment broken, so it is not evidence"
    )


def test_the_compute_refuses_a_normalized_matrix_rather_than_scoring_it(detect_run):
    """Parity is only meaningful if the compute cannot be fed the wrong bytes in the first
    place. Scrublet normalizes internally, so a normalized matrix produces meaningless
    scores — the compute refuses it by name instead of silently scoring it (this is also
    why `pbmc68k_reduced.h5ad`, which is normalized AND scaled, is not this suite's fixture).
    """
    X, barcodes, _gene_names, _types = read_raw_fixture(200, 500)
    normalized = X.astype(np.float64).multiply(1.0 / 7.0)  # non-integer stored values

    run = detect_run()
    run.add_matrix(normalized)
    proc = run.run({"n_prin_comps": "5"})

    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "NOT raw integer counts" in diag, diag
    assert "normalized" in diag.lower()
