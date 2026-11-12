#!/usr/bin/env python3
"""Write the parity fixture's SOURCE and STORED stores with the REAL writer.

    PYTHONPATH=src-app/packages/_lib python3 generate.py <this-dir>

## Why this exists

The parity fixture's `stored/` side used to be an uncompressed, unsharded column built by
hand in Rust. That was recorded as a test-scope limitation — "not the shuffle+gzip+sharded
form the Python writer emits" — and passed over, and it hid a design defect for rounds: the
gather only ever worked on the one encoding no producer writes.

So both stores here are written by `txr_zarr`, the same writer production uses, in the same
chain: `sharding_indexed[ bytes, (numcodecs.shuffle,) gzip ]`.

  * `stored/`      — the control column, values in order, at the writer's DEFAULT geometry
                     (inner chunk 4096), i.e. exactly what a real 10-element column is.
  * `source/`      — the same values SHUFFLED, default geometry. The gather reads this and a
                     non-identity row vector puts the order back; an identity permutation
                     would pass even against a gather that ignored its vector.
  * `source_multi/`— the shuffled values again at `inner_chunk=4`, so the decode crosses
                     several inner chunks and more than one shard. Same real chain, smaller
                     geometry: it exercises the shard-index arithmetic that a 10-element
                     single-chunk column cannot reach.
"""
import shutil
import sys
from pathlib import Path

VALUES = [10.5, 20.25, 30.125, 40.0, 50.5, 60.25, 70.125, 80.0, 90.5, 100.25]
# Not the identity, and not sorted: `SHUFFLE[i]` is the output row that source row i holds.
SHUFFLE = [7, 1, 5, 3, 6, 0, 4, 2, 9, 8]


def write(root: Path, name: str, values, **kw):
    import txr_zarr as cz
    d = root / name
    if d.exists():
        shutil.rmtree(d)
    with cz.Table(d, axis="entries", n=len(values), key=None) as t:
        t.numeric("values", values, dtype="float32", **kw)
    return d


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    out.mkdir(parents=True, exist_ok=True)
    source_vals = [VALUES[i] for i in SHUFFLE]
    write(out, "stored", VALUES)
    write(out, "source", source_vals)
    write(out, "source_multi", source_vals, inner_chunk=4)
    for d in ("stored", "source", "source_multi"):
        n = sum(1 for _ in (out / d).rglob("*") if _.is_file())
        print(f"wrote {out/d} ({n} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
