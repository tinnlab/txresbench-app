#!/usr/bin/env python3
"""Build the `cell_boundaries.parquet` fixtures for #163 — FROM REAL VENDOR BYTES.

## Why this script is committed

The fixtures it writes carry REAL 10x Xenium boundary vertices, lifted verbatim out of two
real vendor `cell_boundaries.csv.gz` files, and this script is the record of exactly which
rows were taken and what was (and was not) done to them. Without it the fixtures are just
opaque bytes making an unverifiable claim about their own provenance.

## The gap this cannot close, stated plainly

**No vendor-AUTHORED `cell_boundaries.parquet` exists on the machine this was built on.**
An exhaustive search found none — the two real full-size Xenium bundles available ship
their boundaries only as `cell_boundaries.csv.gz` (older Xenium Onboard Analysis), and the
two reduced `tiny_outs` bundles checked into this package have no boundaries file at all.
So the VALUES below are the vendor's and the CONTAINER is written here by pyarrow.

Two things narrow that gap rather than pretending it is closed:

  * the vendor's OWN parquet writer is still exercised, elsewhere — `test_boundaries_reader.py`
    points the SAME reader at a real vendor-authored `cells.parquet`
    (`created_by fastparquet-python 1.0.0`, and note its `cell_id` is `binary` in one real
    bundle and `int32` in another), so the reader's dtype handling is proven against vendor
    parquet bytes even though the boundaries fixture is not vendor-written;
  * every vertex value here round-trips its own vendor decimal text, recorded in the
    sidecar `.expected.csv` so `test_boundaries_fixture_provenance.py` can assert it
    without the 40 MB source file.

## What is NOT done to the values

No translation, no rescaling, no re-ordering, no re-closing. The polygons are therefore NOT
co-located with the `xenium-prime-outs` centroids they are keyed to in `prime-staged` —
that fixture exists to drive the importer's plumbing over real ragged shapes, not to be
geometrically coherent (#243 records that no committed fixture in this tree is). The
`real-lung` / `real-breast` fixtures keep the vendor's own ids AND values together and are
the ones the design-invariant tests read.

## Sources (not committed — 40 MB and 21 MB gzipped)

  LUNG  = <root>/human-lung-cancer/unpacked/cell_boundaries.csv.gz
          3,846,353 vertices / 295,883 cells; 6..13 per cell; every ring closed; string ids
  BREAST= <root>/10x-xenium-human-breast-cancer-preview/unpacked/outs/cell_boundaries.csv.gz
          2,181,086 vertices / 167,780 cells; 8..13 per cell; every ring closed; INTEGER ids

Usage:  python3 build_boundaries_fixtures.py --lung <path> --breast <path>
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent


def read_rings(csv_gz: Path):
    """`{cell_id: [(x_text, y_text), …]}` in the vendor's own file order."""
    rings: dict[str, list[tuple[str, str]]] = {}
    order: list[str] = []
    with gzip.open(csv_gz, "rt") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        assert header == ["cell_id", "vertex_x", "vertex_y"], header
        for cid, x, y in reader:
            if cid not in rings:
                rings[cid] = []
                order.append(cid)
            rings[cid].append((x, y))
    return rings, order


def pick(rings, order, *, want=200):
    """Take the RAREST shapes first, then fill — a uniform sample would be all-13s.

    99.98% of real cells have exactly 13 vertices, so a random subset reproduces #75's
    blind-by-construction fixture: every case identical, the ragged path never exercised.
    """
    by_len: dict[int, list[str]] = {}
    for cid in order:
        by_len.setdefault(len(rings[cid]), []).append(cid)
    chosen: list[str] = []
    seen: set[str] = set()
    for n in sorted(by_len):                      # rarest lengths are the short ones
        for cid in by_len[n][: max(1, want // 20)]:
            if cid not in seen:
                seen.add(cid)
                chosen.append(cid)
    for cid in order:                             # then fill in file order
        if len(chosen) >= want:
            break
        if cid not in seen:
            seen.add(cid)
            chosen.append(cid)
    # `seen` is HOISTED. The first cut wrote `c in set(chosen)`, rebuilding a 200-element set
    # once per element of a 295,883-row order — correct, and O(n*m) for no reason.
    return [c for c in order if c in seen]        # keep the vendor's own order


def write_fixture(rings, ids, out: Path, *, id_type: str):
    xs, ys, cids = [], [], []
    for cid in ids:
        for x, y in rings[cid]:
            cids.append(int(cid) if id_type == "int32" else cid)
            xs.append(float(x))
            ys.append(float(y))
    id_col = (
        pa.array(cids, type=pa.int32()) if id_type == "int32"
        else pa.array([c.encode() for c in cids], type=pa.binary())
    )
    table = pa.table(
        {"cell_id": id_col,
         "vertex_x": pa.array(xs, type=pa.float64()),
         "vertex_y": pa.array(ys, type=pa.float64())}
    )
    pq.write_table(table, out, compression="snappy")

    # The sidecar: the vendor's own DECIMAL TEXT, so the provenance test can assert
    # byte-equality without the multi-megabyte source.
    with out.with_suffix(".expected.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["cell_id", "vertex_x", "vertex_y"])
        for cid in ids:
            for x, y in rings[cid]:
                w.writerow([cid, x, y])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lung", required=True, type=Path)
    ap.add_argument("--breast", required=True, type=Path)
    ap.add_argument("--prime-cells", type=Path,
                    default=HERE.parent / "xenium-prime-outs" / "cells.csv.gz")
    args = ap.parse_args()

    lung, lung_order = read_rings(args.lung)
    lung_ids = pick(lung, lung_order, want=200)
    write_fixture(lung, lung_ids, HERE / "real-lung.parquet", id_type="binary")

    breast, breast_order = read_rings(args.breast)
    breast_ids = pick(breast, breast_order, want=120)
    write_fixture(breast, breast_ids, HERE / "real-breast.parquet", id_type="int32")

    # The staged arm: the prime bundle's OWN 23 cell ids, carrying real lung vertices.
    #
    # DONORS ARE CHOSEN FOR RAGGEDNESS, and the first cut's were not. It wrote
    # `[c for c in lung_ids if len(lung[c]) <= 13]`, and 13 IS the real maximum — so the
    # filter was a no-op, the first 23 cells in vendor order were taken, and (99.98% of real
    # cells being 13-vertex) every one of them had exactly 13. `prime-staged.parquet` is the
    # ONLY fixture that goes through the real importer, so the entire end-to-end arm
    # exercised no raggedness at all: #75's blind-by-construction defect, reproduced inside
    # the branch written to avoid it, and found by a blind audit rather than by this file.
    #
    # Donors are now taken SHORTEST-FIRST out of the rare-length pool, so the staged bundle
    # spans the real vendor range and `test_boundaries_fixture_provenance.py` asserts it.
    with gzip.open(args.prime_cells, "rt") as fh:
        reader = csv.reader(fh)
        next(reader)
        prime_ids = [row[0] for row in reader]
    by_length = sorted(lung_ids, key=lambda c: (len(lung[c]), c))
    # Shortest-first for the rare shapes, PLUS the tail, so the staged bundle spans the whole
    # real vendor range (6..13) rather than only its short end. A fixture that is ragged but
    # only among the rare lengths would still never exercise the common case end to end.
    take = len(prime_ids)
    donors = by_length[: take - 4] + by_length[-4:]
    assert len(donors) == take, (len(donors), take)
    assert len({len(lung[c]) for c in donors}) >= 5, (
        "the staged donors are not ragged — the end-to-end arm would exercise one shape"
    )
    assert max(len(lung[c]) for c in donors) == max(len(lung[c]) for c in lung_ids), (
        "the staged donors do not reach the vendor's most common shape"
    )
    staged = {p: lung[d] for p, d in zip(prime_ids, donors)}
    write_fixture(staged, prime_ids, HERE / "prime-staged.parquet", id_type="binary")

    manifest = {
        "real-lung.parquet": {"cells": len(lung_ids),
                              "vertices": sum(len(lung[c]) for c in lung_ids),
                              "cell_id_type": "binary", "source": "human-lung-cancer"},
        "real-breast.parquet": {"cells": len(breast_ids),
                                "vertices": sum(len(breast[c]) for c in breast_ids),
                                "cell_id_type": "int32", "source": "breast-cancer-preview"},
        "prime-staged.parquet": {"cells": len(prime_ids),
                                 "vertices": sum(len(v) for v in staged.values()),
                                 "cell_id_type": "binary",
                                 "source": "xenium-prime-outs ids + human-lung-cancer vertices"},
    }
    (HERE / "PROVENANCE.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
