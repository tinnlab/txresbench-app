#!/usr/bin/env python3
# ruff: noqa
"""The six feature classes a Xenium matrix carries, and the one that must NOT be emitted.

A Visium `filtered_feature_bc_matrix.h5` holds ONE feature class. A Xenium
`cell_feature_matrix.h5` holds six — Gene Expression plus five control/codeword classes,
plus Protein Expression on an XOA 4 protein run. That difference is the reason this file
exists: a single undifferentiated store would put Negative Control Codewords into every
normalisation and every user's gene list, and would put a mean-intensity protein metric
into a datatype that MEANS integer UMI counts.

Everything here is asserted against what LANDED in the store and against an INDEPENDENTLY
built scipy matrix — never against the importer's own return value, and never against
another copy of the importer's own logic.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

import cyto_zarr_read as CZR  # noqa: E402

#: The class §15.5 says "must be divided out" before it means anything, and which this
#: importer therefore refuses to emit as counts (DEC-11 / INV-9).
PROTEIN = "Protein Expression"
GENE_EXPRESSION = "Gene Expression"


def _imported(tmp_path_factory, bundle, slug):
    out = tmp_path_factory.mktemp(slug)
    module, entries = XF.run_over(bundle, out)
    report = json.loads((out / "xenium-import-report.json").read_text())
    return {"out": out, "entries": entries, "module": module, "bundle": bundle,
            "report": report}


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PRIME, "classes-prime")


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PROTEIN, "classes-protein")


def _raw_matrix(bundle):
    """The vendor's `/matrix` group, read RAW — the independent reference.

    Deliberately not routed through anything this package ships: a comparison against the
    importer's own reader would only prove the reader agrees with itself.
    """
    import h5py

    with h5py.File(Path(bundle) / "cell_feature_matrix.h5", "r") as f:
        g = f["matrix"]
        shape = [int(x) for x in g["shape"][:]]
        return {
            "attrs": dict(f.attrs),
            "shape": shape,
            "data": g["data"][:],
            "indices": g["indices"][:],
            "indptr": g["indptr"][:],
            "feature_ids": [b.decode() for b in g["features"]["id"][:]],
            "feature_names": [b.decode() for b in g["features"]["name"][:]],
            "feature_types": [b.decode() for b in g["features"]["feature_type"][:]],
        }


def _class_columns(raw):
    """`feature_type -> ascending feature indices`, from the raw file."""
    out = {}
    for index, ftype in enumerate(raw["feature_types"]):
        out.setdefault(ftype, []).append(index)
    return out


def _counts_entries(entries):
    return [e for e in entries if e["datatype"] == "single-cell/counts"]


# ── TEST-9 [acceptance] [invariant: INV-9] — protein is refused, and named ───────────


def test_the_protein_fixture_really_carries_protein_and_a_scaling_factor():
    """TEST-9 [acceptance] [invariant: INV-9] — the substrate the refusal is measured on.

    Asserted first and separately. If the fixture ever stopped carrying Protein Expression,
    every assertion below about protein being absent would pass VACUOUSLY — "no protein was
    emitted" is trivially true of a bundle with no protein in it.
    """
    raw = _raw_matrix(XF.PROTEIN)
    by_class = _class_columns(raw)
    assert PROTEIN in by_class, (
        "the protein fixture must really carry Protein Expression features, or the "
        "refusal this file exists to prove is being measured against nothing"
    )
    assert len(by_class[PROTEIN]) == 4
    assert int(raw["attrs"]["protein_scaling_factor"]) == 10, (
        "§15.5: protein rides in the same matrix with a root attribute "
        "`protein_scaling_factor = 10` that must be divided out — that attribute is the "
        "evidence the values are not counts"
    )


def test_no_emitted_artifact_carries_a_protein_feature(protein):
    """TEST-9 [acceptance] [invariant: INV-9] — the negative half.

    §15.5 records that Xenium protein rides in the SAME matrix as the genes and carries a
    `protein_scaling_factor` that "must be divided out". Emitting it unscaled fabricates
    counts; emitting it scaled still puts a MEAN_PER_CELL_STAIN metric into a kind that
    promises integer UMI counts, and `qc.10x` would compute a total-UMI figure from it.

    Checked in three places, because one artifact carrying it would be enough: every
    emitted counts store's gene axis, the `gene_id`/`gene_symbol` columns, and the
    `feature_type` column.
    """
    raw = _raw_matrix(XF.PROTEIN)
    by_class = _class_columns(raw)
    protein_ids = {raw["feature_ids"][i] for i in by_class[PROTEIN]}
    protein_names = {raw["feature_names"][i] for i in by_class[PROTEIN]}
    assert protein_ids, "guarded by the fixture test above"

    # 1. no emitted store's gene axis holds one. Read from the store's OWN declared width
    # and the class the entry names, then cross-checked against the raw file's ids.
    for e in _counts_entries(protein["entries"]):
        ftype = e["meta"]["feature_type"]
        assert ftype != PROTEIN, f"{e['id']} is a Protein Expression store"
        ids = {raw["feature_ids"][i] for i in by_class[ftype]}
        assert not (ids & protein_ids), (
            f"{e['id']}'s feature class {ftype!r} overlaps the protein ids"
        )

    # 2. neither gene-axis key column holds one.
    gene_ids = list(CZR.read_column(str(protein["out"] / "axis/gene_id.zarr")))
    gene_symbols = list(CZR.read_column(str(protein["out"] / "axis/gene_symbol.zarr")))
    assert not (set(gene_ids) & protein_ids), (
        "the gene_id axis column carries a protein feature id"
    )
    assert not (set(gene_symbols) & protein_names), (
        "the gene_symbol column carries a protein feature name"
    )

    # 3. the feature_type column never says Protein Expression.
    feature_types = list(CZR.read_column(str(protein["out"] / "axis/feature_type.zarr")))
    assert PROTEIN not in set(feature_types)


def test_every_gene_expression_feature_IS_present(protein):
    """TEST-9 [acceptance] [invariant: INV-9] — THE DISCRIMINATING ARM.

    Without this, "no protein was emitted" would also pass for an importer that emitted
    NOTHING, or that dropped the whole matrix. The invariant is that protein specifically
    is withheld while the genes specifically are not.
    """
    raw = _raw_matrix(XF.PROTEIN)
    by_class = _class_columns(raw)
    expected = [raw["feature_ids"][i] for i in by_class[GENE_EXPRESSION]]
    assert len(expected) == 405, "the fixture's Gene Expression class, asserted not assumed"

    gene_ids = list(CZR.read_column(str(protein["out"] / "axis/gene_id.zarr")))
    assert gene_ids == expected, (
        "the primary store's gene axis must be EXACTLY the Gene Expression class, in the "
        "vendor's own order"
    )


def test_the_report_names_the_protein_exclusion_with_its_reason(protein):
    """TEST-9 [acceptance] [invariant: INV-9] — a deliberate drop is NAMED (INV-10's shape).

    A silent drop and a deliberate one are indistinguishable from the artifacts alone. The
    report is the channel that separates them, so the reason has to actually be in it —
    including the scaling factor, which is the specific fact that makes the values not
    counts.
    """
    entry = protein["report"]["feature_classes"][PROTEIN]
    assert entry["disposition"] == "dropped from the expression matrix"
    assert entry["n_features"] == 4
    reason = entry["reason"]
    assert "protein_scaling_factor" in reason
    assert "10" in reason
    assert "counts" in reason.lower()
    assert "output_id" not in entry, (
        "a class that was not emitted must not name an output id"
    )


def test_the_prime_bundle_has_no_protein_class_at_all(prime):
    """TEST-9 [acceptance] [invariant: INV-9] — the other real bundle, for contrast.

    XOA 3 predates Xenium protein (§15.5: "protein arrived in XOA 4.0"). The report must
    therefore NOT invent a `Protein Expression` entry for it — absence of a class is
    absence, not a zero row.
    """
    assert PROTEIN not in prime["report"]["feature_classes"]


# ── TEST-13 — the split matches an independently built matrix, exactly ───────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_every_emitted_class_store_matches_an_independent_scipy_build(case, prime, protein):
    """TEST-13 — the bytes, against a matrix this package did not build.

    10x stores CSC over (features x cells). The importer reads that as CSR over
    (cells x features) and writes CSC over (cells x genes) restricted to one class. Here the
    same thing is derived from the RAW datasets through scipy and compared term for term:
    `indptr` differences (the per-gene nnz), `indices` (which cells) and `data` (the values).

    Not a shape or nnz check. A transposition, a wrong class slice or an off-by-one column
    selection all preserve nnz, and only the term-by-term comparison sees them.
    """
    import scipy.sparse as sp

    ctx = {"prime": prime, "protein": protein}[case]
    raw = _raw_matrix(ctx["bundle"])
    by_class = _class_columns(raw)
    n_features, n_cells = raw["shape"][0], raw["shape"][1]
    full = sp.csc_matrix((raw["data"], raw["indices"], raw["indptr"]),
                         shape=(n_features, n_cells))

    emitted = _counts_entries(ctx["entries"])
    assert len(emitted) == 1, (
        "EXACTLY ONE `single-cell/counts` store, always — design §6.5: \"Negative controls "
        "are dropped from the expression matrix … That is a QC input, not expression.\" "
        f"Emitted: {[e['id'] for e in emitted]}. A second store would carry the same "
        "datatype every shipped `subtypes_of: single-cell/expression` selector resolves, so "
        "a user would be offered decoding failures as though they were a gene panel."
    )
    assert emitted[0]["meta"]["feature_type"] == "Gene Expression"
    assert len(by_class) >= 4, (
        "the premise: this bundle really does carry several feature classes, so 'only one "
        "store' is a decision the importer made rather than a property of the fixture"
    )
    for e in emitted:
        ftype = e["meta"]["feature_type"]
        columns = by_class[ftype]
        expected = full[columns, :].T.tocsc()          # cells x genes

        root = str(ctx["out"] / e["path"])
        indptr = CZR.read_array(root, "indptr")
        indices = CZR.read_array(root, "indices")
        data = CZR.read_array(root, "data")

        assert list(e["structure"]["shape"]) == [n_cells, len(columns)], (
            f"{e['id']} declares shape {e['structure']['shape']}"
        )
        assert np.array_equal(np.diff(indptr), np.diff(expected.indptr)), (
            f"{e['id']}: the per-gene nnz differs from an independent build"
        )
        assert np.array_equal(indices.astype(np.int64),
                              expected.indices.astype(np.int64)), (
            f"{e['id']}: the row (cell) indices differ from an independent build"
        )
        assert np.array_equal(data.astype(np.float64),
                              expected.data.astype(np.float64)), (
            f"{e['id']}: the values differ from an independent build"
        )


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_one_counts_store_declares_NO_modality(case, prime, protein):
    """TEST-13 — renamed to what it can actually check since the §6.5 drop landed.

    It used to be `test_each_non_primary_store_declares_its_modality`, and a blind
    tests-quality audit pointed out that with EXACTLY ONE store its whole `else` branch —
    every assertion its name was about — became unreachable, so it inflated the coverage
    count with a claim the shipped behaviour never exercises.

    What remains is a real and load-bearing property: `h5ad_import` writes
    `structure_extra={"modality": …}` when it SPLITS a matrix, and this importer does not
    split. A modality key here would make the dataset's expression matrix look like one
    projection among several — and would be the fossil of the very behaviour §6.5 removed.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    stores = _counts_entries(ctx["entries"])
    assert len(stores) == 1
    entry = stores[0]
    assert entry["id"] == "expression"
    assert entry["meta"]["feature_type"] == GENE_EXPRESSION
    assert entry["structure"].get("modality") is None, (
        "the one matrix must not declare a modality — it is the dataset's expression "
        "matrix, not one projection among several, and a modality key here would be the "
        "fossil of the split §6.5 removed"
    )
@pytest.mark.parametrize("case", ["prime", "protein"])
def test_every_class_but_gene_expression_is_dropped_with_a_reason(case, prime, protein):
    """TEST-13 — the §6.5 rule, on both real bundles.

    An earlier cut of this importer followed the HOUSE rule for a multimodal h5ad ("EVERY
    distinct feature type becomes its own modality; NONE discarded") and emitted six
    `single-cell/counts` stores. That rule is right for CITE-seq, where every class is a
    real measurement of a real analyte, and the design gives Xenium a DIFFERENT one because
    its extra classes are decoding failures: 8,096 `Unassigned Codeword` features on the
    real XOA-3 bundle would have been offered to clustering and differential expression as a
    gene panel.

    So the drop is asserted class by class, with the forwarding address each one names.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    classes = ctx["report"]["feature_classes"]
    emitted = [name for name, info in classes.items()
               if info["disposition"] == "emitted as the counts matrix"]
    assert emitted == ["Gene Expression"], f"emitted: {emitted}"

    dropped = {name: info for name, info in classes.items() if name != "Gene Expression"}
    assert len(dropped) >= 4, (
        f"only {len(dropped)} class(es) dropped on {case}; the premise of this test is that "
        "a real Xenium matrix carries several"
    )
    for name, info in dropped.items():
        assert info["disposition"] == "dropped from the expression matrix", name
        assert info["reason"].strip(), f"{name} was dropped with no reason"
        assert "output_id" not in info, f"{name} was not emitted but names an output id"
        assert info["n_features"] > 0, f"{name} claims zero features"

    # And the total is conserved: every feature in the file is accounted for by exactly one
    # class, so a class silently vanishing from the report would show up here.
    raw = _raw_matrix(ctx["bundle"])
    assert sum(info["n_features"] for info in classes.values()) == raw["shape"][0]


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_dropped_control_totals_are_still_emitted_per_cell(case, prime, protein):
    """TEST-13 — nothing a user acts on was lost, asserted rather than asserted-in-prose.

    The per-FEATURE control counts are deferred (§6.5 puts them in the transcripts points
    table, which is #164). The PER-CELL total for every control class is what a Xenium user
    actually judges decoding quality with, and it is emitted straight from the vendor's own
    `cells.csv.gz` — so this checks that the report's forwarding address resolves to a real
    artifact rather than to a promise.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    ids = {e["id"] for e in ctx["entries"]}
    named = 0
    for name, info in ctx["report"]["feature_classes"].items():
        column = info.get("per_cell_column")
        if not column:
            continue
        named += 1
        assert f"metadata-column:{column}" in ids, (
            f"{name} forwards to {column!r}, which is not an emitted artifact"
        )
    assert named >= 4, (
        f"only {named} dropped class(es) name a per-cell column on {case}; a drop with no "
        "forwarding address reads as data loss"
    )
