#!/usr/bin/env python3
"""Reader 2 of the criteria-coercion parity runner: the COMMITTED kernel.

Loads `src-app/testdata/criteria-coercion-corpus.json`, imports the real
`packages/cell-filter/compute/cell-filter.py` by path (no re-implementation —
the point of the corpus is that every reader is the SHIPPING code), and prints
one JSON document to stdout:

    {"<case id>": {"list": [bool, ...], "object": [bool, ...]}, ...}

TWO obs flavours per case, because `criteria_keep_mask`'s range branch dispatches
on `np.asarray(col).dtype.kind`: a python list of bools becomes numpy `bool_`
(the `astype(float)` fast path) while the SAME column read out of a pandas
object/nullable column becomes `dtype=object` (the per-cell `_value_float` path).
`main` snapshots `np.asarray(adata.obs[c])`, so BOTH are reachable from real
data — and if the two branches disagree, the committed mask depends on a dtype
the recorded recipe cannot see. So the runner requires both to match.

Run standalone:  python3 scripts/coercion-parity-kernel.py
"""
import importlib.util
import json
import os
import sys

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CORPUS = os.path.join(_ROOT, "src-app", "testdata", "criteria-coercion-corpus.json")
_PROCESSORS = os.path.join(_ROOT, "src-app", "packages")
_KERNEL = os.path.join(_PROCESSORS, "cell-filter", "compute", "cell-filter.py")

# The sandbox runner assembles ONE `/code` dir per job: the entry script plus the app's
# cross-cutting modules — the `_helpers` compute helpers and the `_lib` output-format
# library (`cyto_columns` / `cyto_zarr`, DEC-7). A compute script therefore says
# `import cyto_columns` at MODULE SCOPE, so anything that loads it by path has to stage
# the same names or it dies with `ModuleNotFoundError` before the first mask is computed.
# `src-app/packages/conftest.py` does exactly this for the pytest suites; this script is
# the one by-path loader that runs OUTSIDE pytest, so it does its own.
#
# Not hypothetical: commit 2751dac5 added `import cyto_columns` to cell-filter.py and this
# reader went dead (`just check-coercion` → exit 2) for the rest of the branch, taking the
# three-reader parity property with it, while `just check-py` stayed green on conftest's
# wiring. The failure is LOUD when the gate runs; `just check` runs it.
for _name in ("_helpers", "_lib"):
    _p = os.path.join(_PROCESSORS, _name)
    if _p not in sys.path:
        sys.path.insert(0, _p)


def load_kernel():
    spec = importlib.util.spec_from_file_location("cell_filter_corpus", _KERNEL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_SPECIALS = {"inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}


def decode(v):
    """The corpus' `{"$special": …}` escape → the real python value. JSON cannot
    carry a non-finite float, and a non-finite obs cell is entirely ordinary in a
    QC metric column, so the corpus spells them explicitly."""
    if isinstance(v, dict) and set(v) == {"$special"}:
        return _SPECIALS[v["$special"]]
    if isinstance(v, list):
        return [decode(x) for x in v]
    return v


def masks_for(cf, case):
    obs = {k: [decode(x) for x in v] for k, v in case["obs"].items()}
    n = max((len(v) for v in obs.values()), default=0)
    out = {}
    for flavour in ("list", "object"):
        cols = (
            obs
            if flavour == "list"
            else {k: np.array(v, dtype=object) for k, v in obs.items()}
        )
        m = cf.criteria_keep_mask(case["criteria"], cols, n_cells=n)
        out[flavour] = [bool(x) for x in np.asarray(m).tolist()]
    return out


def main():
    cf = load_kernel()
    corpus = json.load(open(_CORPUS, encoding="utf-8"))
    print(json.dumps({c["id"]: masks_for(cf, c) for c in corpus["cases"]}))


if __name__ == "__main__":
    sys.exit(main())
