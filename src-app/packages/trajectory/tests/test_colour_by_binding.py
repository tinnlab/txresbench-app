#!/usr/bin/env python3
# ruff: noqa
"""TEST-25 — the pseudotime column colours the existing layout FOR FREE.

The executable form of the claim that per-cell pseudotime is an obs-axis column on an
EXISTING kind rather than part of the graph. Because it is, the shipped colour-by section
already lists it — with no viz code in this package, no new widget, and no app diff.

Asserted at the ARTIFACT level against the REAL shipped view file, not against a copy of its
values: the binding is read out of the shipped yaml, so if that section ever narrows what it
offers, this fails here rather than the column silently disappearing from the UI.

The comparison is EXACT because the resolver filters datatype with strict inequality — a
near-miss datatype string is not "close", it is absent.

Mutation: emit the pseudotime as a layout-bearing kind -> the datatype no longer equals what
the section binds. Write the column as anything but a float -> the summary kind stops being
the one listed under the continuous heading.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")
pytest.importorskip("scanpy")
pytest.importorskip("igraph")

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

_COLOUR_BY = (Path(__file__).resolve().parents[2] / "single-cell-viz" / "ui"
              / "colour-by.yaml")


def _colour_by_binding():
    """The (datatype, {kinds}) the shipped colour-by slice binds, read from the real file."""
    doc = yaml.safe_load(_COLOUR_BY.read_text())
    found = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("source") == "row_space_columns":
                args = node.get("args") or {}
                found["datatype"] = args.get("datatype")
                found["kinds"] = {k.get("kind") for k in (args.get("kinds") or [])}
                found["headings"] = {k.get("kind"): k.get("heading")
                                     for k in (args.get("kinds") or [])}
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return found


@pytest.fixture(scope="module")
def binding():
    return _colour_by_binding()


def test_the_shipped_section_really_does_bind_a_continuous_column(binding):
    """The premise the whole free-colouring claim rests on. If this changes, the claim is
    false and everything below is measuring the wrong thing."""
    assert _COLOUR_BY.is_file(), f"the shipped section is missing: {_COLOUR_BY}"
    assert binding.get("datatype") == "metadata-column"
    assert "continuous" in binding.get("kinds", set())
    # …and it lands under a heading meant for values rather than groups.
    assert binding["headings"]["continuous"] == "Values"


def test_the_produced_pseudotime_matches_the_shipped_binding_EXACTLY(dpt_run, binding):
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    emb = embed(counts)
    n = emb.shape[0]

    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_partition(branch, slot="root_column", name="branch")
    run.add_keys(barcodes(n))
    run.run_ok({"root_mode": "root_cluster", "root_level": "trunk"})

    entry = run.entry("metadata-column")
    # EXACT-match: the resolver filters on strict inequality, so the produced datatype string
    # must equal the bound one verbatim.
    assert entry["datatype"] == binding["datatype"] == "metadata-column"
    assert entry["meta"]["kind"] == "continuous"
    assert entry["meta"]["kind"] in binding["kinds"]


def test_the_column_is_obs_aligned_so_it_lands_on_the_same_points_as_the_layout(dpt_run):
    """A colouring is only free if the values line up with the points being coloured, so the
    column declares WHICH row space it belongs to rather than only which axis LABEL."""
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    emb = embed(counts)
    n = emb.shape[0]
    digest = cells_digest(n)

    run = dpt_run()
    run.add_embedding(emb, aligned_to=digest)
    run.add_partition(branch, slot="root_column", name="branch")
    run.run_ok({"root_mode": "root_cluster", "root_level": "trunk"})

    structure = run.entry("metadata-column")["structure"]
    assert structure["axis"] == "cells"
    assert structure.get("aligned_to") == digest, (
        "the column does not carry the row-space identity of the embedding it was computed "
        "from, so a consumer cannot tell whether it may be painted on a given set of points")


def test_the_graph_is_NOT_offered_as_a_colouring(dpt_run, paga_run, binding):
    """The other half of the output-kind decision: the abstracted graph is deliberately a
    different kind, so it does NOT appear in a per-cell colour list. Its nodes are levels of
    a partition, not cells, and offering it there would be a category error."""
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    emb = embed(counts)

    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({})

    assert run.entry("graph/attributed")["datatype"] != binding["datatype"]
    assert not run.entries("metadata-column"), (
        "the graph analysis emitted a per-cell column — its output is a node-axis graph, and "
        "per-cell pseudotime is the OTHER analysis' job")
