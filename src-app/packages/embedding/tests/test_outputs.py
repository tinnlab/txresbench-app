#!/usr/bin/env python3
# ruff: noqa
"""TEST-38 [covers: ITEM-23, ITEM-26] — the embedding OUTPUT contract.

`write_embedding` emits `DT_EMBEDDING = ("embedding", "chunked-dense")`; the emitted layout
string is what the ingest conformance gate accepts (it maps to the datatype's declared
`storage.layout`), and `aligned_to` / `axis` / `name` / `kind` are all set. The proof that
the layout matches the datatype is behavioural: the framework conformance gate accepts what
the run emitted.
"""
import conformance

from embedding_fixtures import counts_matrix, import_own


def _import_shared():
    return import_own("_shared")


def test_embedding_output_declares_the_datatype_layout_and_all_provenance(reduce_run):
    shared = _import_shared()
    assert shared.DT_EMBEDDING == ("embedding", "chunked-dense")

    run = reduce_run()
    run.add_matrix(counts_matrix(60, 40, seed=0))
    run.add_column([f"c{i}" for i in range(60)], slot="cells_index", axis="cells",
                   name="barcode", holds_axis_keys=True)
    run.run_ok({"n_hvg": 15, "n_pcs": 8})

    entry = run.embedding_entry()
    assert entry["datatype"] == "embedding"
    assert entry["layout"] == "chunked-dense"
    st = entry["structure"]
    assert st.get("axis") == "cells"
    assert st.get("aligned_to")               # ITEM-26 — the source row-space digest
    assert entry["meta"]["name"]              # the zarr member the coordinates decode from
    assert entry["meta"]["kind"] == "embedding"

    # the ingest conformance gate accepts the emitted layout (layout ↔ datatype storage.layout).
    violations = conformance.conform_outputs(run.outputs_dir)
    assert violations == [], violations
