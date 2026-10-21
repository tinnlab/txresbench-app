#!/usr/bin/env python3
"""Generate the COMMITTED minimal 10x Cell Ranger trio fixture (`mtx_trio/`).

The dataset test-suite's `mtx_trio_convert_test` needs a REAL 10x trio
(`matrix.mtx.gz` + `barcodes.tsv.gz` + `features.tsv.gz`) so the on-ingest
converter can actually RUN — synthetic gzip bytes only ever prove the
grouping/typing/enqueue half.

Provenance: the trio is a deterministic SUBSAMPLE of the real, already-pinned
`pbmc3k_raw.h5ad` fixture (`fetch.sh pbmc3k`,
sha256 89a96f1beaa2dd83a687666d3f19a4513ac27a2a2d12581fcd77afed7ea653a1) — real
10x barcodes, real Ensembl gene ids, real integer UMI counts. Nothing is invented.

Selection (deterministic, no RNG):
  * cells — the FIRST `--cells` barcodes in the h5ad's own obs order;
  * genes — within those cells, the `--genes` genes with the highest total count,
    ties broken by ascending var index, then re-sorted into original var order.

Output is the canonical Cell Ranger v3 layout:
  matrix.mtx.gz    MatrixMarket `coordinate integer general`, genes × cells
  barcodes.tsv.gz  one barcode per line (matrix columns)
  features.tsv.gz  `gene_id\tgene_name\tGene Expression` (matrix rows)

Usage (needs scanpy/anndata + scipy):

    python3 src-app/server/tests/dataset/fixtures/make_mtx_trio.py \
        --source src-app/server/tests/dataset/fixtures/pbmc3k_raw.h5ad

Regenerating with the same source + defaults reproduces the committed bytes
byte-for-byte (gzip mtime is pinned to 0).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
from pathlib import Path

import anndata as ad
import numpy as np
import scipy.sparse as sp
from scipy.io import mmwrite

PBMC3K_SHA256 = "89a96f1beaa2dd83a687666d3f19a4513ac27a2a2d12581fcd77afed7ea653a1"
FEATURE_TYPE = "Gene Expression"


def gzip_bytes(payload: bytes) -> bytes:
    """Deterministic gzip: fixed mtime + no embedded filename."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(payload)
    return buf.getvalue()


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(here / "pbmc3k_raw.h5ad"),
                    help="pbmc3k_raw.h5ad (fetch.sh pbmc3k)")
    ap.add_argument("--out", default=str(here / "mtx_trio"))
    ap.add_argument("--cells", type=int, default=50)
    ap.add_argument("--genes", type=int, default=100)
    args = ap.parse_args()

    src = Path(args.source)
    if not src.is_file():
        raise SystemExit(
            f"source h5ad not found: {src}\n"
            f"run `bash {here / 'fetch.sh'} pbmc3k` first"
        )
    got = hashlib.sha256(src.read_bytes()).hexdigest()
    if got != PBMC3K_SHA256:
        raise SystemExit(f"source sha256 mismatch: expected {PBMC3K_SHA256}, got {got}")

    adata = ad.read_h5ad(src)
    n_cells = min(args.cells, adata.n_obs)

    # Cells: the first N barcodes, in the file's own order.
    cell_idx = np.arange(n_cells)
    X = sp.csr_matrix(adata.X[cell_idx, :])

    # Genes: highest total count within those cells; ties → lower var index.
    totals = np.asarray(X.sum(axis=0)).ravel()
    order = np.lexsort((np.arange(totals.size), -totals))
    gene_idx = np.sort(order[: args.genes])

    sub = X[:, gene_idx]
    # 10x ships integer UMI counts; pbmc3k_raw stores them as float32 — assert
    # integrality, then cast losslessly (never a force-cast).
    dense_vals = sub.data
    if not np.all(np.equal(np.mod(dense_vals, 1), 0)):
        raise SystemExit("source values are not integral — refusing to cast")
    counts = sp.coo_matrix(sub.astype(np.int32).T)  # genes × cells (Cell Ranger layout)

    if counts.shape[0] != len(gene_idx) or counts.shape[1] != n_cells:
        raise SystemExit(f"unexpected shape {counts.shape}")
    per_cell = np.asarray(counts.sum(axis=0)).ravel()
    if int(per_cell.min()) <= 0:
        raise SystemExit("a selected cell has zero counts across the selected genes")
    per_gene = np.asarray(counts.sum(axis=1)).ravel()
    if int(per_gene.min()) <= 0:
        raise SystemExit("a selected gene has zero counts across the selected cells")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    buf = io.BytesIO()
    mmwrite(buf, counts, field="integer", symmetry="general")
    (out / "matrix.mtx.gz").write_bytes(gzip_bytes(buf.getvalue()))

    barcodes = "".join(f"{b}\n" for b in adata.obs_names[cell_idx].astype(str))
    (out / "barcodes.tsv.gz").write_bytes(gzip_bytes(barcodes.encode()))

    symbols = adata.var_names[gene_idx].astype(str)
    ids = adata.var["gene_ids"].to_numpy()[gene_idx].astype(str)
    features = "".join(f"{i}\t{s}\t{FEATURE_TYPE}\n" for i, s in zip(ids, symbols))
    (out / "features.tsv.gz").write_bytes(gzip_bytes(features.encode()))

    total = 0
    for name in ("matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"):
        p = out / name
        size = p.stat().st_size
        total += size
        print(f"{name:18} {size:>8} bytes  sha256:{hashlib.sha256(p.read_bytes()).hexdigest()}")
    print(f"{'TOTAL':18} {total:>8} bytes")
    print(f"dims: {counts.shape[0]} genes x {counts.shape[1]} cells, nnz={counts.nnz}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
