#!/usr/bin/env python3
# ruff: noqa
"""TEST-14 + TEST-15 — the `graph/attributed` artifact is CONFORMANT and fully declared.

TEST-14 pins the output DECLARATION: the datatype/layout pair ingest validates, the CSC
orientation and the `node`/`node` axis pair the kind declares, and the side-channel that
carries what one artifact's single `structure.kind` cannot.

TEST-15 runs the REAL post-ingest gate — `conformance.conform_outputs`, the same function
the platform's verification job calls — over the emitted bytes and the producer's own
declaration. That is what "lands end-to-end through ingest and the conformance gate" means
in an executable form, rather than by inspection.

Mutation: name a side-channel key inside the writer-owned set -> the writer refuses the
whole call. Emit CSR without transposing to CSC -> the declared orientation disagrees with
the bytes. Drop the node labels -> the ordered-labels assertion fails, and the matrix
becomes a set of numbers with no way back to the levels they describe.
"""
import numpy as np
import pytest

from trajectory_generators import branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")
conformance = pytest.importorskip("conformance")


@pytest.fixture(scope="module")
def fixture():
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), branch


@pytest.fixture
def run(paga_run, fixture):
    emb, branch = fixture
    r = paga_run()
    r.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    r.add_partition(branch, name="branch")
    r.run_ok({"n_neighbors": 15})
    return r


def test_the_output_declares_the_open_kind_and_the_layout_ingest_validates(run):
    entry = run.entry("graph/attributed")
    # the pair `validate_artifact_typing` checks: the datatype must resolve in the live
    # registry, must not be abstract, and its layout must equal the declared storage layout.
    assert entry["datatype"] == "graph/attributed"
    assert entry["layout"] == "chunked-sparse"
    assert entry["role"] == "artifact"
    assert entry["meta"]["kind"] == "abstracted-graph"


def test_the_store_is_a_csc_matrix_over_ONE_axis_named_twice(run):
    structure = run.graph_structure()
    assert structure["kind"] == "sparse_csc"
    # Both dims name the SAME axis — which is exactly what the declared kind says an
    # adjacency is, and is legal because the writer carries the axis names through verbatim.
    assert structure["axes"] == ["node", "node"]
    n = len(structure["nodes"])
    assert structure["shape"] == [n, n]


def test_the_side_channel_carries_what_one_structure_kind_cannot(run):
    """One artifact carries ONE `structure.kind`, so a columnar table of edges and nodes
    cannot co-locate with the CSC store. They ride the caller-named declaration channel —
    the same channel the gene-set kind uses for its per-set metadata."""
    structure = run.graph_structure()

    # the tree, with its orientation intact.
    assert isinstance(structure["tree_edges"], list)
    # the per-node attributes, including the count the library exposes only as an
    # undocumented side effect of the call.
    nodes = structure["nodes"]
    assert [n["label"] for n in nodes] == ["A", "B", "trunk"]
    assert all(isinstance(n["n_cells"], int) and n["n_cells"] > 0 for n in nodes)
    assert all(isinstance(n["degree"], int) for n in nodes)
    assert [n["index"] for n in nodes] == list(range(len(nodes)))

    # the run's own identity, so a consumer holding nothing but the store learns it.
    paga = structure["paga"]
    assert paga["model"] == "v1.2"
    assert paga["node_order"].startswith("categorical level order")
    assert "not a probability" in paga["statistic"].lower() or \
           "NOT a probability" in paga["statistic"]


def test_the_side_channel_keys_are_outside_the_writer_owned_set(run):
    """The writer REFUSES a caller that redeclares the decode contract of bytes it did not
    write, so the channel's key names are part of the contract rather than free choice."""
    import txr_csc

    structure = run.graph_structure()
    ours = {"paga", "nodes", "tree_edges"}
    assert ours <= set(structure)
    assert not (ours & set(txr_csc._WRITER_OWNED_STRUCTURE_KEYS)), (
        "a side-channel key collides with the writer's own decode contract")


def test_both_copies_of_the_declaration_agree(run):
    """The manifest entry's `structure` and the store's group stamp are two copies of one
    declaration; the conformance gate fails on them disagreeing, so they are written from
    one dict rather than assembled twice."""
    assert run.entry("graph/attributed")["structure"] == run.graph_structure()


def test_the_emitted_artifacts_pass_the_real_post_ingest_conformance_gate(run):
    """TEST-15 — the gate's OWN implementation, over the bytes that landed."""
    violations = conformance.conform_outputs(run.outputs_dir)
    assert violations == [], f"conformance violations: {violations}"


def test_a_declared_but_EMPTY_level_is_excluded_and_the_exclusion_is_recorded(paga_run,
                                                                             fixture):
    """TEST-31 — a level the column DECLARES but no cell carries is not a node of anything.

    It matters more than it looks: the statistic's expected-value denominator for any pair
    involving an empty group is zero, and that is precisely the branch which substitutes a
    connectivity of 1 — so carrying an empty level through risks a SPURIOUS MAXIMAL EDGE,
    the most misleading value the matrix can hold. Excluded, and the exclusion is recorded
    rather than done silently.
    """
    import pandas as pd

    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))

    # a column declaring FOUR levels, one of which no cell carries.
    mount = run._mount(None)
    dest = run.inputs_dir / mount
    values = [str(v) for v in branch]
    series = pd.Series(pd.Categorical(values, categories=["A", "B", "ghost", "trunk"]))
    import txr_columns
    txr_columns.write_metadata_column(dest.parent, dest.name, "branch", series,
                                       axis="cells")
    run._declare("partition", mount)
    run.run_ok({"n_neighbors": 15})

    assert run.node_labels() == ["A", "B", "trunk"], "the empty level became a node"
    adjacency = run.adjacency()
    assert adjacency.shape == (3, 3)
    assert adjacency.max() < 1.0, (
        "a connectivity of exactly 1 appeared — the empty-group denominator branch")

    partition = run.report()["partition"]
    assert partition["levels_dropped_as_empty"] == ["ghost"]
    assert partition["declared_levels"] == ["A", "B", "ghost", "trunk"]
