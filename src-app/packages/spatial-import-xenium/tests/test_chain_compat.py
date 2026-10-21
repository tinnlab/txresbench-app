#!/usr/bin/env python3
# ruff: noqa
"""INV-4, the whole epic's bet, asserted for the SECOND vendor.

Design §9:

    the expression matrix is emitted as an ordinary `single-cell/counts` `sparse_csc` store
    over the `cells × genes` axes. Every shipped consumer selects on
    `subtypes_of: single-cell/expression` … and refuses by
    `structure.kind != "sparse_csc"`. … **Nothing needs to know it is spatial.**

#157 proved that property for Visium by running the chain. This file proves it for Xenium
by reading the SHIPPED manifests as data — every selector is evaluated against what the
tree actually declares, never against a hand-written expectation of it — and by reading the
emitted store's own bytes for the second, structural half of the sentence.

**Why this test is not a tautology.** It is written against the DESIGN's promise, not
against this importer's behaviour: it derives the `extends` graph from the shipped
`single-cell-types/manifest.yaml` rather than hardcoding `counts -> expression`, and it
discovers the consumers by evaluating their own narrowings rather than naming the ones that
happen to work. If this importer emitted its matrix under a spatial-specific datatype, or
on a `spots` axis, or in any structure kind but `sparse_csc`, every one of these assertions
would go red — which is precisely what "implementation ≠ design" should do.
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

PACKAGES = XF.PKG.parent

#: What this importer emits for the PRIMARY matrix. Read from the manifest below as well;
#: named here so a mismatch between the manifest and the compute is itself a failure.
XENIUM_OUTPUT_DATATYPE = "single-cell/counts"

#: The packages that make up the spatial arm. Excluded when DISCOVERING consumers, because
#: an importer selecting its own bundle is not evidence that a general-purpose analysis
#: would accept the matrix.
#: Packages excluded when DISCOVERING downstream consumers — an importer resolving its own
#: bundle is not evidence that a general-purpose analysis accepts the matrix.
#:
#: DERIVED, because this was the THIRD hand-written copy of one fact (the others are in
#: `_helpers` and in this package's registration test) and a blind audit showed the failure
#: mode is a silent false GREEN: a fourth importer absent from a literal set is counted as a
#: general-purpose consumer and inflates the `MIN_CONSUMERS` floor. A package that
#: CONTRIBUTES a `spatial/*` datatype, or whose analysis binds one, is the spatial arm — a
#: fact the manifests already state.
def _spatial_arm(packages_dir):
    import yaml

    arm = set()
    for manifest in sorted(packages_dir.glob("*/manifest.yaml")):
        doc = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
        contributes = doc.get("contributes") or {}
        if any(str(dt.get("id", "")).startswith("spatial/")
               for dt in (contributes.get("datatypes") or [])):
            arm.add(manifest.parent.name)
            continue
        for analysis in contributes.get("analyses") or []:
            for slot in analysis.get("appliesTo") or []:
                for key in ("type_id", "subtypes_of"):
                    if str(slot.get(key) or "").startswith("spatial/"):
                        arm.add(manifest.parent.name)
    return arm


SPATIAL_ARM = _spatial_arm(PACKAGES)

#: A floor, not a list. Discovery that silently found nothing would make every assertion
#: below vacuous, and §9 names five consumers by hand.
MIN_CONSUMERS = 3


def _manifests():
    return {p.parent.name: (yaml.safe_load(p.read_text(encoding="utf-8")) or {})
            for p in sorted(PACKAGES.glob("*/manifest.yaml"))}


def _datatype_graph(manifests):
    """`datatype id -> {extends, entity_axis, axes, package}` across EVERY package.

    Built across the whole tree on purpose: `single-cell/counts` is declared in
    `single-cell-types` and the spatial kinds in `spatial-types`, so a per-package view
    could not resolve either chain and would answer the question by accident.
    """
    graph = {}
    for pkg, doc in manifests.items():
        for datatype in (doc.get("contributes") or {}).get("datatypes") or []:
            graph[datatype["id"]] = {
                "extends": datatype.get("extends"),
                "entity_axis": datatype.get("entity_axis"),
                "axes": [a.get("name") for a in (datatype.get("axes") or [])],
                "package": pkg,
            }
    return graph


def _ancestry(graph, datatype):
    """`[datatype, parent, grandparent, …]`, refusing a cycle rather than looping."""
    chain, seen, current = [], set(), datatype
    while current is not None:
        assert current not in seen, f"cycle in the `extends` graph at {current!r}"
        seen.add(current)
        chain.append(current)
        node = graph.get(current)
        if node is None:
            break
        current = node["extends"]
    return chain


def _resolving_consumers(manifests, graph, datatype):
    """Every `(package, analysis, slot)` whose OWN narrowing would resolve `datatype`.

    Evaluated the way the platform does: a slot resolves when its `subtypes_of` is on the
    datatype's ancestry (or its `type_id` is the datatype itself) AND nothing on that
    ancestry is in its `excludes`.
    """
    ancestry = set(_ancestry(graph, datatype))
    out = []
    for pkg, doc in manifests.items():
        if pkg in SPATIAL_ARM:
            continue
        for analysis in (doc.get("contributes") or {}).get("analyses") or []:
            for slot in analysis.get("appliesTo") or []:
                selector = slot.get("subtypes_of")
                type_id = slot.get("type_id")
                matches = (selector in ancestry) if selector else (type_id == datatype)
                if not matches:
                    continue
                if set(slot.get("excludes") or []) & ancestry:
                    continue
                out.append((pkg, analysis["id"], slot.get("slot")))
    return sorted(out)


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    out = tmp_path_factory.mktemp("chain-xenium")
    module, entries = XF.run_over(XF.PRIME, out)
    import json
    report = json.loads((out / "xenium-import-report.json").read_text(encoding="utf-8"))
    return {"out": out, "entries": entries, "module": module, "report": report}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    """The SECOND real bundle. Added when the cardinality leg landed: a datatype-count
    invariant asserted on one fixture is asserted on one feature-class mix."""
    out = tmp_path_factory.mktemp("chain-xenium-protein")
    module, entries = XF.run_over(XF.PROTEIN, out)
    import json
    report = json.loads((out / "xenium-import-report.json").read_text(encoding="utf-8"))
    return {"out": out, "entries": entries, "module": module, "report": report}


# ── the datatype half ────────────────────────────────────────────────────────────────


def test_the_importer_declares_the_ordinary_counts_datatype():
    """TEST-1 [acceptance] [invariant: INV-4] — the one line the whole mechanism rests on.

    §9: "the expression matrix is emitted as an ordinary `single-cell/counts` … store".
    Asserted against the shipped manifest, so a future change to a spatial-specific
    datatype fails here rather than three analyses downstream.
    """
    manifests = _manifests()
    analyses = (manifests["spatial-import-xenium"].get("contributes") or {})["analyses"]
    xenium = [a for a in analyses if a["id"] == "spatial.import-xenium"]
    assert len(xenium) == 1
    produces = xenium[0].get("produces") or []
    assert XENIUM_OUTPUT_DATATYPE in produces, (
        f"spatial.import-xenium no longer produces {XENIUM_OUTPUT_DATATYPE!r}; the whole "
        "backwards-compatibility mechanism is that one line"
    )
    assert not [p for p in produces if p.startswith("spatial/") and "counts" in p], (
        "no spatial-specific expression datatype may be produced — that is exactly the "
        "fork §9 forbids"
    )


def test_the_counts_datatype_reaches_expression_through_the_shipped_extends_graph():
    """TEST-1 [acceptance] [invariant: INV-4] — the chain, DERIVED not assumed.

    The `counts -> expression` link is read out of `single-cell-types/manifest.yaml`, so
    this fails if somebody re-parents the datatype — which would make every shipped
    `subtypes_of: single-cell/expression` selector miss a matrix that still looks fine.
    """
    graph = _datatype_graph(_manifests())
    assert graph[XENIUM_OUTPUT_DATATYPE]["package"] == "single-cell-types", (
        "the counts datatype must still be the shared one, not a spatial redeclaration"
    )
    ancestry = _ancestry(graph, XENIUM_OUTPUT_DATATYPE)
    assert "single-cell/expression" in ancestry, (
        f"{XENIUM_OUTPUT_DATATYPE} no longer extends single-cell/expression "
        f"(chain: {ancestry})"
    )


def test_the_entity_axis_is_cells_and_no_spatial_axis_was_invented():
    """TEST-1 [acceptance] [invariant: INV-4] — §9's first named constraint.

    "**No `spots` axis.** The entity axis must remain `cells` … Inventing a spatial-specific
    axis would make every `subtypes_of: single-cell/expression` selector miss, and would
    fork `metadata-column` (whose axis is `cells`)."

    §6.1 settles it for this platform in particular: "A Visium spot barcode *is* a barcode;
    a Xenium segmented cell *is* a cell."
    """
    graph = _datatype_graph(_manifests())
    node = graph[XENIUM_OUTPUT_DATATYPE]
    assert node["entity_axis"] == "cells", (
        f"the counts datatype's entity axis is {node['entity_axis']!r}"
    )
    assert node["axes"] == ["cells", "genes"], (
        f"the counts datatype declares axes {node['axes']}"
    )
    for invented in ("spots", "spot", "beads", "bins"):
        assert invented not in node["axes"]


def test_at_least_three_shipped_consumers_resolve_the_xenium_matrix():
    """TEST-1 [acceptance] [invariant: INV-4] — "Nothing needs to know it is spatial."

    Consumers are DISCOVERED by evaluating their own shipped narrowings, not enumerated, so
    this measures the property rather than a list somebody kept up to date. The floor is
    what stops a silent parsing failure from making the test vacuous, and the named five are
    checked on top of it because §9 names them.
    """
    manifests = _manifests()
    graph = _datatype_graph(manifests)
    resolved = _resolving_consumers(manifests, graph, XENIUM_OUTPUT_DATATYPE)
    assert len(resolved) >= MIN_CONSUMERS, (
        f"only {resolved} resolve {XENIUM_OUTPUT_DATATYPE}; discovery found fewer than the "
        f"{MIN_CONSUMERS} this test needs to mean anything"
    )
    named = {(pkg, analysis) for pkg, analysis, _ in resolved}
    for expected in (("qc", "qc.10x"), ("cell-filter", "cell.filter"),
                     ("embedding", "embedding.reduce"),
                     ("differential-expression", "de.compare"),
                     ("differential-expression", "de.markers")):
        assert expected in named, (
            f"{expected[1]} no longer resolves the counts matrix — §9 names it as one of "
            f"the shipped consumers this property is about. Resolved: {sorted(named)}"
        )


def test_no_consumer_excludes_anything_on_the_matrixs_ancestry():
    """TEST-1 [acceptance] [invariant: INV-4] — the exclusion half, checked separately.

    A selector can resolve a datatype and then an `excludes` entry can drop it again, which
    looks identical from the `subtypes_of` line alone. Three of the five consumers really do
    carry exclusions (`single-cell/normalized`, `single-cell/protein`, `single-cell/atac`),
    so this is a live condition and not a formality — and it is one more reason the protein
    features are not emitted under this datatype.
    """
    manifests = _manifests()
    graph = _datatype_graph(manifests)
    ancestry = set(_ancestry(graph, XENIUM_OUTPUT_DATATYPE))

    saw_exclusions = False
    for pkg, doc in manifests.items():
        if pkg in SPATIAL_ARM:
            continue
        for analysis in (doc.get("contributes") or {}).get("analyses") or []:
            for slot in analysis.get("appliesTo") or []:
                if slot.get("subtypes_of") not in ancestry:
                    continue
                excludes = set(slot.get("excludes") or [])
                saw_exclusions = saw_exclusions or bool(excludes)
                assert not (excludes & ancestry), (
                    f"{analysis['id']} slot {slot.get('slot')!r} excludes "
                    f"{sorted(excludes & ancestry)}, which is on the matrix's own ancestry"
                )
    assert saw_exclusions, (
        "no consumer in the tree declares any exclusion — this assertion would then be "
        "vacuous, and the shipped tree is known to carry three"
    )


# ── the structural half, from the emitted bytes ─────────────────────────────────────


def test_the_emitted_store_is_the_shape_every_consumer_refuses_without(imported):
    """TEST-1 [acceptance] [invariant: INV-4] — "…and refuses by structure.kind".

    A datatype match alone is not enough. §9's sentence has a second clause about the STORE,
    which is a property of the bytes and not of the manifest, so it is read from a real
    import of a real bundle.
    """
    entry = XF.entry(imported["entries"], "expression")
    assert entry["datatype"] == XENIUM_OUTPUT_DATATYPE
    structure = entry["structure"]
    assert structure["kind"] == "sparse_csc", (
        f"the emitted store is {structure['kind']!r}; every shipped consumer refuses "
        "anything but sparse_csc before reading a byte"
    )
    assert structure["axes"] == ["cells", "genes"], (
        f"the store declares axes {structure['axes']}"
    )
    assert structure.get("nnz") is not None, (
        "the store declares no `nnz`; three of the five consumers refuse BY NAME on a "
        "missing nnz, so its absence would break them with a valid-looking matrix"
    )
    assert entry["meta"]["platform"] == "xenium", (
        "the matrix may CARRY the fact that it is spatial — what INV-4 forbids is any "
        "consumer having to KNOW it"
    )


def test_nothing_in_the_emitted_matrix_declaration_is_spatial_specific(imported):
    """TEST-1 [acceptance] [invariant: INV-4] — the falsifier, stated as an absence.

    The store's own `structure` is what a consumer dispatches on. If a spatial axis, a
    spatial datatype or a spatial structure kind had leaked into it, every assertion above
    could still pass while the matrix stopped being ordinary.
    """
    entry = XF.entry(imported["entries"], "expression")
    blob = repr(entry["structure"])
    assert "spatial" not in blob, (
        f"the emitted matrix's structure names something spatial: {blob[:400]}"
    )
    assert entry["structure"]["axes"] == ["cells", "genes"]


def test_exactly_ONE_artifact_carries_the_datatype_every_consumer_resolves(imported, protein):
    """TEST-1 [acceptance] [invariant: INV-4] — the leg this file was BLIND to.

    Every other assertion here reads the primary `expression` entry. That was enough while
    one store existed and useless the moment a second did: an earlier cut emitted six
    `single-cell/counts` artifacts — one per vendor feature class, including 8,096
    `Unassigned Codeword` features — and this file certified "nothing needs to know it is
    spatial" while five pseudo-expression matrices were exposed to every consumer it had
    just finished enumerating. The datatype is the whole mechanism of INV-4, so its
    CARDINALITY is part of the invariant, not an implementation detail.

    Design §6.5 is the rule: "Negative controls are dropped from the expression matrix and
    kept in the points table flagged … That is a QC input, not expression."
    """
    for name, ctx in (("prime", imported), ("protein", protein)):
        counts = [e for e in ctx["entries"] if e["datatype"] == "single-cell/counts"]
        assert len(counts) == 1, (
            f"{name} emitted {len(counts)} `single-cell/counts` artifacts "
            f"({[e['id'] for e in counts]}). Every shipped `subtypes_of: "
            "single-cell/expression` selector resolves each one identically, so a second "
            "store is a second thing a user is offered to cluster and DE."
        )
        assert counts[0]["id"] == "expression"
        assert counts[0]["meta"]["feature_type"] == "Gene Expression"
        # The premise, so this cannot pass on a bundle that simply had one class.
        assert len(ctx["report"]["feature_classes"]) >= 5, (
            f"{name}'s matrix must really carry several feature classes for the "
            "cardinality above to be a decision rather than an accident"
        )
