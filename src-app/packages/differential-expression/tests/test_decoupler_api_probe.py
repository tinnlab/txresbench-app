#!/usr/bin/env python3
# ruff: noqa
"""TEST-14 [covers: ITEM-6] — the pseudobulk helper PROBES the installed decoupler API
(`get_pseudobulk` vs `pp.pseudobulk`) at run time rather than hardcoding one idiom (INV-6)."""
import types

import pytest

import _pseudobulk as PB


def _fail(msg):
    raise RuntimeError(msg)


def _fake_decoupler_old():
    """A decoupler exposing ONLY the <2.0 `get_pseudobulk` idiom."""
    m = types.SimpleNamespace()
    m.get_pseudobulk = lambda *a, **k: None
    return m


def _fake_decoupler_new():
    """A decoupler exposing ONLY the ≥2.0 `pp.pseudobulk` idiom."""
    m = types.SimpleNamespace()
    m.pp = types.SimpleNamespace(pseudobulk=lambda *a, **k: None)
    return m


def test_probe_resolves_the_old_get_pseudobulk_idiom():
    fn, api = PB.resolve_pseudobulk_api(_fake_decoupler_old(), _fail)
    assert api == "get_pseudobulk" and callable(fn)


def test_probe_resolves_the_new_pp_pseudobulk_idiom():
    fn, api = PB.resolve_pseudobulk_api(_fake_decoupler_new(), _fail)
    assert api == "pp.pseudobulk" and callable(fn)


def test_probe_refuses_by_name_when_neither_idiom_is_present():
    empty = types.SimpleNamespace()
    with pytest.raises(RuntimeError):
        PB.resolve_pseudobulk_api(empty, _fail)


def test_aggregate_routes_through_the_probe_and_records_the_api():
    # A fake module exposing only ONE form still aggregates (the addendum API-drift guard).
    import numpy as np
    counts = np.array([[1, 2], [3, 4], [5, 6], [7, 8]])
    samples = ["a", "a", "b", "b"]
    groups = ["g0", "g1", "g0", "g1"]
    rec = PB.aggregate(counts, ["gene0", "gene1"], samples, groups,
                       min_cells=1, dc=_fake_decoupler_new(), fail=_fail)
    assert rec["api"] == "pp.pseudobulk"
    assert rec["unit"] == "pseudobulk"
    assert rec["n_pseudobulks"] == 4  # (a,g0),(a,g1),(b,g0),(b,g1)
