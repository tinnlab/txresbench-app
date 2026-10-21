#!/usr/bin/env python3
# ruff: noqa
"""TEST-27 [acceptance] [invariant: INV-12] [covers: ITEM-16, ITEM-4, ITEM-7] — the method
registry: ≥2 methods per analysis, catalog-sourced enum, code-only 3rd-method extension."""
import _methods as METH


def _fail(msg):
    raise AssertionError(msg)


def test_each_analysis_registers_at_least_two_methods():
    marker_keys = {m["key"] for m in METH.marker_catalog()}
    compare_keys = {m["key"] for m in METH.compare_catalog()}
    assert {"wilcoxon", "t-test"} <= marker_keys and len(marker_keys) >= 2
    assert {"pydeseq2", "nb_glm"} <= compare_keys and len(compare_keys) >= 2


def test_registries_are_separate_products_not_one_dropdown():
    # INV-12 — the method choice stays WITHIN a product; a single list spanning both is the
    # legacy category error. The two catalogs share NO keys.
    marker_keys = {m["key"] for m in METH.marker_catalog()}
    compare_keys = {m["key"] for m in METH.compare_catalog()}
    assert marker_keys.isdisjoint(compare_keys)


def test_resolve_dispatches_the_selected_method():
    assert METH.resolve_marker_method("t-test", _fail)["scanpy_method"] == "t-test"
    assert METH.resolve_marker_method(None, _fail)["key"] == METH.MARKER_DEFAULT
    assert METH.resolve_compare_method("nb_glm", _fail)["key"] == "nb_glm"


def test_unknown_method_is_refused_by_name_not_silently_defaulted():
    seen = {}

    def capture(msg):
        seen["msg"] = msg
        raise RuntimeError(msg)

    import pytest
    with pytest.raises(RuntimeError):
        METH.resolve_marker_method("not-a-method", capture)
    assert "not-a-method" in seen["msg"]


def test_a_fake_third_catalog_entry_is_dispatchable_code_only():
    # INV-12 — adding a method is a code-only catalog() entry: register a fake 3rd marker method
    # and it is immediately in the catalog AND dispatchable, with NO manifest/datatype/view edit.
    METH.register_marker_method("fake3", label="Fake", description="test", scanpy_method="wilcoxon")
    try:
        assert "fake3" in {m["key"] for m in METH.marker_catalog()}
        assert METH.resolve_marker_method("fake3", _fail)["scanpy_method"] == "wilcoxon"
    finally:
        METH._MARKER_METHODS.pop("fake3", None)
