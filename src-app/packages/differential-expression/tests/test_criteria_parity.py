#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-A1] [covers: ITEM-2] — the VENDORED criteria kernel.

DE's advanced contrast builds each group's mask with `_criteria.criteria_keep_mask`, which
MUST be cell-filter's SHIPPED kernel VENDORED VERBATIM (DEC-A1), not a fourth dialect. Two
machine-enforced claims (each a silent-at-rc-0 defect if broken):

  1. This copy AND cell-filter's REAL kernel BOTH agree with the shared coercion corpus
     (`src-app/testdata/criteria-coercion-corpus.json`), cell-for-cell, in both obs dtype
     flavours (list + object-ndarray). A divergent copy FAILS.
  2. The vendored SOURCE of every kernel function is byte-identical to cell-filter's — so a
     hand-edit of the vendored span (DEC-A1 "verbatim, not forked") is caught directly.

Mirrors `embedding/tests/test_inline_filter.py`'s parity block exactly (DEC-11 precedent).
"""
import importlib.util
import inspect
import json
from pathlib import Path

import numpy as np
import pytest

_HERE = Path(__file__).resolve().parent          # …/packages/differential-expression/tests
_COMPUTE = _HERE.parent / "compute"
_PACKAGES = _HERE.parents[1]                      # …/packages
_SRC_APP = _HERE.parents[2]                       # …/src-app
_CF_SCRIPT = _PACKAGES / "cell-filter" / "compute" / "cell-filter.py"
_CORPUS = _SRC_APP / "testdata" / "criteria-coercion-corpus.json"

# The VENDORED kernel (differential-expression/compute/_criteria.py), loaded under a namespaced
# `sys.modules` key via `de_fixtures.import_own` — a bare `import _criteria` would resolve
# through the shared pytest session's flat namespace to whichever package's `_criteria.py`
# won the sys.path race (embedding ships its own vendored copy).
from de_fixtures import import_own

DE = import_own("_criteria")


def _load_cellfilter():
    """cell-filter's REAL `criteria_keep_mask`, imported off-sandbox (the module name has a
    hyphen, so importlib by path — the same way embedding's parity test loads it)."""
    spec = importlib.util.spec_from_file_location("cellfilter_kernel_ref", str(_CF_SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CF = _load_cellfilter()

_SPECIALS = {"inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}


def _decode(v):
    if isinstance(v, dict) and set(v) == {"$special"}:
        return _SPECIALS[v["$special"]]
    if isinstance(v, list):
        return [_decode(x) for x in v]
    return v


def _corpus_cases():
    with open(_CORPUS, encoding="utf-8") as fh:
        return json.load(fh)["cases"]


CASES = _corpus_cases()


# ── claim 1 — VENDORED kernel == cell-filter's real kernel == corpus, cell-for-cell ──
@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
@pytest.mark.parametrize("flavour", ["list", "object"])
def test_vendored_predicate_matches_cellfilter_on_shared_corpus(case, flavour):
    obs = {k: [_decode(x) for x in v] for k, v in case["obs"].items()}
    n = max((len(v) for v in obs.values()), default=0)
    cols = obs if flavour == "list" else {k: np.array(v, dtype=object) for k, v in obs.items()}
    want = case["expect"]
    de_mask = [bool(x) for x in np.asarray(DE.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    cf_mask = [bool(x) for x in np.asarray(CF.criteria_keep_mask(case["criteria"], cols, n_cells=n)).tolist()]
    # the vendored copy matches the corpus AND the real kernel — one dialect, not two.
    assert de_mask == want, (case["id"], case.get("why"))
    assert de_mask == cf_mask, (case["id"], "vendored kernel diverged from cell-filter")


# ── claim 2 — the vendored SOURCE is byte-identical to the kernel it copies ──────────
@pytest.mark.parametrize("fn", [
    "criteria_keep_mask", "_is_categorical_criterion", "_is_spellable_scalar",
    "_value_float", "_trim_column", "_bound_or_none",
])
def test_vendored_kernel_source_is_byte_identical_to_cellfilter(fn):
    assert inspect.getsource(getattr(DE, fn)) == inspect.getsource(getattr(CF, fn)), fn


def test_vendored_module_regex_and_ws_constants_match():
    assert DE._DECIMAL_BOUND.pattern == CF._DECIMAL_BOUND.pattern
    assert DE._VALUE_WS == CF._VALUE_WS
