#!/usr/bin/env python3
# ruff: noqa
"""TEST-13 [covers: ITEM-1] — `da/result` is a POPULATION-axis table, declared in this package.

`de/result` was the obvious candidate and is the WRONG one: it declares `axes: [{name: gene}]` and
`entity_axis: gene`, and its stated purpose is being "the gene-axis analog of a
`metadata-column`". A DA row is a neighbourhood or a cluster. Reusing it would lie about the axis
and misroute the serving path — the artifact would be served as if its entries were genes.

Paired with TEST-11/TEST-12, which assert a PRODUCED artifact really carries what this declaration
promises. A declaration nothing is checked against is a wish.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"
_OPEN_KINDS = _PKG.parent / "open-kinds" / "manifest.yaml"


def _manifest():
    return yaml.safe_load(_MANIFEST.read_text())


def _da_result():
    doc = _manifest()
    return next(d for d in doc["contributes"]["datatypes"] if d["id"] == "da/result")


def test_the_kind_is_declared_inside_this_package_not_in_open_kinds():
    """Declaring it locally is what keeps the release from coupling to a shared manifest
    (DEC-2). `scripts/check-derived-vocabulary.sh` derives its forbidden vocabulary from every
    package's `contributes.datatypes[].id`, so the id is guarded either way."""
    assert _da_result()["id"] == "da/result"
    open_kinds = yaml.safe_load(_OPEN_KINDS.read_text())
    assert not any(d["id"] == "da/result" for d in open_kinds["contributes"]["datatypes"]), (
        "`da/result` must not also be declared in open-kinds — one id, one declaration")


def test_it_is_a_population_axis_table_with_an_explicit_entity_axis():
    dt = _da_result()
    assert {a["name"] for a in dt["axes"]} == {"population"}
    assert dt["entity_axis"] == "population"
    assert dt["extends"] == "tabular"
    assert dt["is_abstract"] is False
    assert dt["storage"]["layout"]["kind"] == "columnar_table"
    assert dt["storage"]["format"] == "zarr"


def test_it_declares_neglog10p_and_never_a_raw_p():
    """G1 — an f32 `p` underflows to 0 below ~1e-45, which destroys the ranking among exactly the
    top hits a reader looks at first."""
    table = next(a for a in _da_result()["arrays"] if a["name"] == "table")
    members = {attr["name"] for attr in table["attrs"]}
    assert "neglog10p" in members
    assert "pval" not in members and "p" not in members and "pvalue" not in members


def test_it_declares_every_member_the_acceptance_bar_names():
    table = next(a for a in _da_result()["arrays"] if a["name"] == "table")
    members = {attr["name"] for attr in table["attrs"]}
    assert {"logFC", "neglog10p", "padj", "spatial_fdr", "neglog10_significance", "n_cells",
            "mean_prop_1", "mean_prop_2", "n_samples_1", "n_samples_2", "score"} == members
    for attr in table["attrs"]:
        assert attr["dtype"] == "f32"
    assert table["dims"] == [{"axis": "population"}]
    assert table["layout"]["kind"] == "columnar_table"


def test_member_names_carry_no_single_cell_domain_vocabulary():
    """Domain-neutral names keep the app-builtin domain-strip lint green — the same rule
    `de/result` follows."""
    table = next(a for a in _da_result()["arrays"] if a["name"] == "table")
    banned = ("gene", "cell_type", "leiden", "umap", "scanpy", "barcode")
    for attr in table["attrs"]:
        low = attr["name"].lower()
        assert not any(b in low for b in banned), attr["name"]


def test_the_produced_artifact_declares_the_same_entity_axis(clusters_run):
    """The declaration is only worth something if a producer honours it."""
    from da_fixtures import population_dataset, EXTERNAL

    pops, conds, samps = population_dataset(n_per_sample=120, samples_per_side=3)
    run = clusters_run()
    run.add_column(pops, slot="population", name="leiden")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    entry = run.da_entries()[0]
    assert entry["datatype"] == "da/result"
    assert entry["layout"] == "columnar-table"
    cyto = run.da_cyto(entry)
    assert cyto["da"]["entity_axis"] == "population"
    assert entry["meta"]["entity_axis"] == "population"
    assert entry["meta"]["axis"] == "populations"
    # the population key member is present and names the levels
    assert sorted(set(run.da_column(entry, "population"))) == sorted(set(pops))


def test_the_frozen_lattice_array_did_not_come_back_and_da_result_is_still_declared():
    """TEST-10 — the two legs of `test_da_result_joins_the_lattice_with_NO_core_edit_at_all`
    that are NOT about any branch's diff.

    They are properties of the TREE: the shared golden must not re-freeze the contributed
    set, and this package must still declare the datatype the derivation reads. They shared
    a body with a branch-diff assertion, so gating that assertion would have taken them
    behind the gate with it — on a branch that can no longer be constructed, i.e. into
    running nowhere.

    ## The claim this docstring used to make was false, and the correction matters

    It said these legs "were reachable only on this package's introducing branch" and that
    the split "ADDS two assertions to every run rather than removing any". On `origin/main`
    the enclosing test was UNGATED, so both legs already ran on every branch — measured, not
    inferred: `pytest ::test_da_result_joins_the_lattice_with_NO_core_edit_at_all` on a clean
    `origin/main` worktree reports `.`, a pass, not a skip. The split is coverage-NEUTRAL: it
    prevents a loss the same commit would otherwise cause. Presenting a prevented loss as a
    gain is exactly the unmeasured claim `docs/design/derived-guards.md` asks to be measured,
    and a blind audit caught it.

    Asserting the ABSENCE of the `lattice` key is deliberate — a test that merely stopped
    reading it would pass whether or not the frozen array came back, which is the vacuous
    shape this suite refuses. The repo root is walked from `__file__` rather than resolved
    through `zero_core_guard.repo_root()`: that function SKIPS outside a git checkout, which
    is right for a branch-diff guard and wrong here — its own docstring states the rule ("a
    TREE-scoped assertion must not route through this function at all, or it silently stops
    asserting in a tarball for no reason"), and a blind audit found this test doing exactly
    that.
    """
    import json

    root = _PKG.parents[2]
    golden = root / "src-app/server/src/modules/datatype/tests/lattice_golden.json"
    doc = json.loads(golden.read_text())

    assert "lattice" not in doc, (
        "the frozen `lattice` array is back in the shared golden. It was deleted upstream in "
        "favour of a derivation over every package's declared datatypes, and its own `_comment` "
        "says it must not return — so a package appending to it is re-freezing what was "
        "deliberately unfrozen.")

    manifest = (Path(__file__).resolve().parent.parent / "manifest.yaml").read_text()
    assert "id: da/result" in manifest, (
        "`da/result` is no longer declared in this package's manifest, which is the only place "
        "the upstream derivation can read it from")
