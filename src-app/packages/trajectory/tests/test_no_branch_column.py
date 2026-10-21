#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 [acceptance] [invariant: INV-7] — branch detection is NOT performed, and it shows.

The design descopes branch detection on the library's OWN documented advice: use this tool
for pseudotime only, and read branching from the abstracted graph. Its splitting criterion
additionally needs a stabilization hack for small branches, which is an admission of
instability in the API surface itself.

Shipping an unstable categorical labelled "lineage branch" is exactly the authoritative-
looking wrongness this epic exists to avoid, so the absence is ASSERTED rather than assumed.

These assertions have real content because the library writes its branch-only products
(`dpt_groups`, `dpt_order`, `dpt_order_indices`) ONLY when branch detection is on — their
absence is therefore evidence about the call we actually made, not a tautology.

Mutation: raise the branch count -> the recorded value assertion fails, and a categorical
column appears in the outputs, failing the "exactly one continuous column" assertion.
"""
import numpy as np
import pytest

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def fixture():
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), true_time, true_branch


@pytest.fixture
def run(dpt_run, fixture):
    emb, _tt, branch = fixture
    n = emb.shape[0]
    r = dpt_run()
    r.add_embedding(emb, aligned_to=cells_digest(n))
    r.add_partition(branch, slot="root_column", name="branch")
    r.add_keys(barcodes(n))
    r.run_ok({"root_mode": "root_cluster", "root_level": "trunk"})
    return r


def test_the_run_records_that_no_branching_was_computed(run):
    report = run.report()
    assert report["n_branchings"] == 0
    # not merely the number — the REASON, so a reader of the record knows it was a decision.
    assert "guidance" in report["n_branchings_is"]
    assert "abstracted graph" in report["n_branchings_is"]
    assert "No branch label is emitted" in report["n_branchings_is"]


def test_the_descope_is_a_constant_not_a_caller_supplied_argument():
    """A default a caller can raise is not a descope. This is pinned as a module constant so
    the decision lives in the code rather than in whatever params happened to be passed."""
    import importlib.util
    from pathlib import Path

    dpt_py = Path(__file__).resolve().parents[1] / "compute" / "dpt.py"
    source = dpt_py.read_text()
    assert "N_BRANCHINGS = 0" in source
    assert "n_branchings=N_BRANCHINGS" in source

    # …and it is NOT READ FROM PARAMS anywhere in the module.
    #
    # This assertion has been wrong twice, in opposite directions, and both mistakes are
    # worth keeping in view:
    #
    #   1. It first searched only the handful of lines between the docstring and the
    #      constant — a region that cannot contain a params read at all — so the very thing
    #      it names would have sailed straight through it.
    #   2. Widening it to the whole source for the QUOTED KEY then made it RED, because the
    #      compute writes that same key into its own report (twice, deliberately: the descope
    #      is recorded in the artifact). A quoted key cannot tell a READ from a WRITE, so that
    #      spelling would break again every time anyone records the decision in an artifact —
    #      punishing exactly the disclosure this package is built around.
    #
    # So it targets the READ: the two ways this compute takes a value from the params bag.
    reads = [f"{fn}({arg}, \"n_branchings\"" for fn in ("_resolve_int", "S.resolve_strict_int")
             for arg in ("p", "params")]
    reads += ['p.get("n_branchings"', "p.get('n_branchings'", 'params["n_branchings"]',
              'p["n_branchings"]']
    for spelling in reads:
        assert spelling not in source, (
            f"the compute READS {spelling!r} from the params bag — a caller-supplied branch "
            "count reached it, and the descope is a default rather than a decision")

    # …and the constant is what the ONE real call site actually receives. Matched on
    # `sc.tl.dpt(adata` rather than `sc.tl.dpt(` so the module docstring's description of the
    # pipeline is not counted as a call — the point is how many times the tool is INVOKED.
    calls = [l for l in source.splitlines() if "sc.tl.dpt(adata" in l]
    assert len(calls) == 1, f"expected one call site, found {len(calls)}: {calls}"
    assert "n_branchings=N_BRANCHINGS" in calls[0]


def test_exactly_one_column_is_emitted_and_it_is_continuous(run):
    columns = run.entries("metadata-column")
    assert len(columns) == 1, (
        f"{len(columns)} columns emitted — a second one would be the branch label this "
        "invariant forbids")
    meta = columns[0]["meta"]
    assert meta["kind"] == "continuous"
    assert meta["stored_dtype"] == "float32"
    # a categorical column would carry a level set; a pseudotime must not.
    assert "n_levels" not in meta
    assert "levels" not in meta


def test_no_branch_product_appears_anywhere_in_the_outputs(run):
    """The library's branch-only products are named explicitly, because their absence is the
    check — they exist ONLY when branch detection ran."""
    import json

    blob = json.dumps(run.report()) + json.dumps(run.manifest())
    for forbidden in ("dpt_groups", "dpt_order", "dpt_order_indices", "dpt_changepoints",
                      "dpt_grouptips"):
        assert forbidden not in blob, (
            f"{forbidden!r} appears in the outputs — branch detection ran")

    # and no artifact file is named for one either.
    paths = [e["path"] for e in run.manifest()["outputs"]]
    assert not any("branch" in p for p in paths), paths


def test_the_disclosure_travels_with_the_result(run):
    """The descope is DISCLOSED on the artifact, not only decided in a design document —
    a reader of the run has to be able to learn that branching was not computed."""
    disclosures = run.report()["disclosures"]
    assert "branch_detection_not_performed" in disclosures
    text = disclosures["branch_detection_not_performed"]
    assert "not performed" in text.lower()
    assert "abstracted graph" in text
