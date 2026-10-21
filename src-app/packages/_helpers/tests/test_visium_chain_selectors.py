#!/usr/bin/env python3
# ruff: noqa
"""#157 — the selector half of the backwards-compatibility claim, read as DATA.

`spatial-storage-layout.md` §9 names the exact mechanism the whole epic rests on:

    the expression matrix is emitted as an ordinary `single-cell/counts` `sparse_csc`
    store over the `cells × genes` axes. Every shipped consumer selects on
    `subtypes_of: single-cell/expression` … and refuses by
    `structure.kind != "sparse_csc"`. A Visium spot matrix satisfies both.

`test_visium_chain_compat.py` proves that by RUNNING the chain. This file proves the other
direction — that the chain would be OFFERED at all — by reading the shipped `manifest.yaml`
files as data, resolving the `extends` graph across every package, and evaluating each
consumer's own narrowing against the visium importer's declared output.

**Why both.** Running the computes by hand bypasses the platform's binding: a compute will
happily read any matrix you hand it, so a green chain says nothing about whether the
product would ever offer that matrix to that analysis. And a selector check alone says
nothing about whether the analysis then works. The two halves are not redundant; each is
blind to what the other sees.

Nothing here edits a manifest. That is INV-7, and it is also what makes the assertions
evidence: they are evaluated against the shipped narrowings, not against a hand-written
expectation of them.
"""
import sys
from pathlib import Path

import yaml

# A hard import, not `pytest.importorskip`: a `Skipped` raised at import time silently
# vanishes this whole module, and under `pytest.ini`'s `-q` the run then shows neither a
# dot nor a summary for it. PyYAML is a hard requirement of this tree (the build itself
# parses every `manifest.yaml`), so its absence must be a loud collection ERROR.

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_chain_fixtures as VC  # noqa: E402

PACKAGES = VC.PACKAGES

#: The five shipped consumers §9 names, by (package, analysis id, slot).
#: Enumerated rather than discovered so that a consumer DISAPPEARING from the tree fails
#: this test instead of shrinking it silently.
CHAIN_CONSUMERS = [
    ("qc", "qc.10x", "matrices"),
    ("cell-filter", "cell.filter", "expression"),
    ("embedding", "embedding.reduce", "matrices"),
    ("differential-expression", "de.compare", "expression"),
    ("differential-expression", "de.markers", "expression"),
]

VISIUM_OUTPUT_DATATYPE = "single-cell/counts"


def _manifests() -> dict:
    out = {}
    for path in sorted(PACKAGES.glob("*/manifest.yaml")):
        out[path.parent.name] = yaml.safe_load(path.read_text()) or {}
    return out


def _datatype_graph(manifests: dict) -> dict:
    """`datatype id -> extends`, across EVERY package.

    Built across the whole tree on purpose: `single-cell/counts` is declared in
    `single-cell-types` and `spatial/coordinates` in `spatial-types`, so a per-package view
    could not resolve either chain and would answer the question by accident.
    """
    graph = {}
    for pkg, doc in manifests.items():
        for datatype in (doc.get("contributes") or {}).get("datatypes") or []:
            graph[datatype["id"]] = {
                "extends": datatype.get("extends"),
                "package": pkg,
                "capabilities": list(datatype.get("capabilities") or []),
            }
    return graph


def _ancestry(graph: dict, datatype: str) -> list:
    """`[datatype, parent, grandparent, …]`, refusing a cycle rather than looping."""
    chain, seen = [], set()
    current = datatype
    while current is not None:
        assert current not in seen, f"cycle in the datatype `extends` graph at {current!r}"
        seen.add(current)
        chain.append(current)
        node = graph.get(current)
        if node is None:
            break
        current = node["extends"]
    return chain


def _slot(manifests: dict, pkg: str, analysis_id: str, slot_name: str) -> dict:
    analyses = (manifests[pkg].get("contributes") or {}).get("analyses") or []
    hits = [a for a in analyses if a.get("id") == analysis_id]
    assert len(hits) == 1, f"{pkg} declares {len(hits)} analyses with id {analysis_id!r}"
    slots = [s for s in (hits[0].get("appliesTo") or []) if s.get("slot") == slot_name]
    assert len(slots) == 1, (
        f"{analysis_id} declares {len(slots)} slots named {slot_name!r}; the chain's shape "
        f"has changed and this test must be re-derived rather than relaxed")
    return slots[0]


# ── TEST-9: the positive half ───────────────────────────────────────────────────────


def test_every_chain_consumer_selects_the_visium_matrix_by_its_shipped_selector():
    """TEST-9 [covers: ITEM-5].

    For each of the five consumers §9 names: its matrix slot declares
    `subtypes_of: single-cell/expression`; the visium importer declares
    `produces: single-cell/counts`; `single-cell/counts` reaches
    `single-cell/expression` through the shipped `extends` graph; and the visium datatype
    appears in none of that slot's `excludes`.

    All four conditions, per consumer. Dropping any one of them is how a selector silently
    stops resolving a datatype it used to.
    """
    manifests = _manifests()
    graph = _datatype_graph(manifests)

    visium = (manifests["spatial-import-visium"].get("contributes") or {})["analyses"]
    visium = [a for a in visium if a["id"] == "spatial.import-visium"][0]
    assert VISIUM_OUTPUT_DATATYPE in (visium.get("produces") or []), (
        f"spatial.import-visium no longer produces {VISIUM_OUTPUT_DATATYPE!r}; the whole "
        f"backwards-compatibility mechanism is that one line")

    ancestry = _ancestry(graph, VISIUM_OUTPUT_DATATYPE)
    assert "single-cell/expression" in ancestry, (
        f"{VISIUM_OUTPUT_DATATYPE} no longer extends single-cell/expression "
        f"(chain: {ancestry}) — every shipped selector in the chain would now miss it")

    for pkg, analysis_id, slot_name in CHAIN_CONSUMERS:
        slot = _slot(manifests, pkg, analysis_id, slot_name)
        assert slot.get("subtypes_of") == "single-cell/expression", (
            f"{analysis_id} slot {slot_name!r} selects "
            f"{slot.get('subtypes_of')!r} / type_id {slot.get('type_id')!r}, not "
            f"`subtypes_of: single-cell/expression` — §9's mechanism no longer holds for it")
        excludes = set(slot.get("excludes") or [])
        assert not (set(ancestry) & excludes), (
            f"{analysis_id} slot {slot_name!r} EXCLUDES {sorted(set(ancestry) & excludes)}, "
            f"which is on the visium matrix's own ancestry chain — the selector would "
            f"resolve it and then the exclusion would drop it")


def test_the_visium_matrix_satisfies_the_second_narrowing_every_consumer_applies():
    """TEST-9 [covers: ITEM-5] — the `structure.kind` half of §9's sentence.

    "…and refuses by `structure.kind != "sparse_csc"`." A datatype match alone is not
    enough; the emitted STORE has to be the shape the consumers require, which is a
    property of the bytes and not of the manifest. Read from a real import.
    """
    import tempfile

    with tempfile.TemporaryDirectory(prefix="visium-selector-") as tmp:
        importer = VC.import_visium(Path(tmp))
        entry = VC.expression_entry(importer)
        assert entry["datatype"] == VISIUM_OUTPUT_DATATYPE, (
            f"the emitted matrix is spelled {entry['datatype']!r}")
        structure = VC.structure_of(entry)
        assert structure["kind"] == "sparse_csc"
        assert structure["axes"] == ["cells", "genes"]
        assert structure.get("nnz") is not None, (
            "the store declares no `nnz`; `embedding.reduce` and both DE entries refuse "
            "BY NAME on a missing nnz before reading a byte, so its absence would break "
            "three of the five consumers with a perfectly valid-looking matrix")
        # …and the same declaration is inside the store, which is what a SANDBOXED
        # consumer reads (#211: the manifest-entry `meta` never crosses into the sandbox,
        # but `attributes.cyto` is literally bytes in the zarr store, so it does).
        attributes = VC.store_cyto_attributes(importer.store(entry))
        assert attributes.get("kind") == "sparse_csc"
        assert attributes.get("axes") == ["cells", "genes"]
        assert attributes.get("nnz") == structure["nnz"]


# ── TEST-4 [acceptance] [INV-4]: the negative half ──────────────────────────────────


def test_no_raw_count_gate_would_offer_to_run_on_the_tissue_map():
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-5].

    §9's second constraint: *"**`spatial/coordinates` must not extend
    `single-cell/expression`.** It extends `embedding` (§6.2) — the same argument the
    velocity spike makes for `velocity/field` (*'Every raw-count gate in the tree would
    otherwise offer to run on it'*)."*

    The stated HARM is that the gates would offer to run on it, so the assertion is written
    against the gates' own selectors rather than against the coordinates datatype alone.

    **A divergence from the design that this test records rather than hides:** the shipped
    `spatial-types/manifest.yaml` declares `spatial/coordinates` as `extends: matrix` with
    `capabilities: [obs-aligned, plottable-xy, spatial-coordinates, spatial]` — NOT
    `extends: embedding` as §6.2 says. The invariant's REQUIREMENT ("must not extend
    `single-cell/expression`") holds either way, and is what is asserted here. The
    parenthetical is a different claim, it is not what shipped, and it is asserted
    separately below so that the divergence is visible instead of being quietly absorbed
    by a test that only checked the requirement. It is inert today — nothing in the tree
    selects `subtypes_of: embedding`, and the render path selects on the `plottable-xy`
    CAPABILITY — and it belongs to #152, not to this item.
    """
    manifests = _manifests()
    graph = _datatype_graph(manifests)

    # EVERY spatial datatype, not just the tissue map.
    #
    # Generalised after `#155` landed and the importer began emitting a SECOND spatial
    # artifact (`spatial/image`). The previous version named `spatial/coordinates` alone, so
    # a new spatial type reaching `single-cell/expression` would have been invisible to it —
    # and a new spatial type is exactly what the epic keeps adding. §9's stated harm is about
    # raw-count gates offering to run on things that are not raw counts; nothing in it is
    # specific to coordinates.
    spatial_types = sorted(dt for dt in graph if dt.startswith("spatial/"))
    assert len(spatial_types) >= 2, (
        f"only {spatial_types} declared — this scan is meant to cover the whole spatial "
        f"vocabulary and would be near-vacuous over one type")

    for spatial_type in spatial_types:
        ancestry = _ancestry(graph, spatial_type)
        assert "single-cell/expression" not in ancestry, (
            f"{spatial_type} now reaches single-cell/expression (chain: {ancestry}) — every "
            f"raw-count gate in the tree would offer to run on it")

        for pkg, analysis_id, slot_name in CHAIN_CONSUMERS:
            slot = _slot(manifests, pkg, analysis_id, slot_name)
            selector = slot.get("subtypes_of")
            assert selector not in ancestry, (
                f"{analysis_id} slot {slot_name!r} selects {selector!r}, which is on "
                f"{spatial_type}'s ancestry — it would offer to run on it")
            assert slot.get("type_id") != spatial_type


def test_the_shipped_coordinates_datatype_diverges_from_the_designs_extends_clause():
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-5] — the divergence, pinned.

    Recorded as an executable statement of the tree's ACTUAL shape so that #152's
    departure from §6.2 is a fact somebody chose and can revisit, not an accident nobody
    wrote down. If `spatial/coordinates` is ever changed to `extends: embedding`, this
    test goes red and the reader is pointed at the design clause it then satisfies.
    """
    graph = _datatype_graph(_manifests())
    node = graph["spatial/coordinates"]
    assert node["package"] == "spatial-types"
    assert node["extends"] == "matrix", (
        f"spatial/coordinates now extends {node['extends']!r}. §6.2 of the design says "
        f"`embedding`; the tree shipped `matrix` plus a `plottable-xy` capability. If this "
        f"has been reconciled, re-derive this test against the new shape")
    assert "plottable-xy" in node["capabilities"], (
        "the `plottable-xy` capability is what actually carries the coordinates artifact "
        "into the scatter path in place of the design's `extends: embedding`; losing it "
        "would make the tissue map unrenderable while every `extends` assertion stayed green")
    assert "obs-aligned" in node["capabilities"], (
        "`obs-aligned` is the capability §9's filtering clause (INV-6) is written about")


# ── the entry paths this suite drives are the ones the manifests name ───────────────


def test_the_suite_drives_the_entries_the_shipped_manifests_declare():
    """TEST-9 [covers: ITEM-5] — the harness's entry table is not allowed to drift.

    `visium_chain_fixtures.ENTRIES` hardcodes a path per analysis. If a package moved its
    entry, the suite would keep driving the old file and keep passing — proving something
    about a script the product no longer runs. Checked against `run.entry` in the shipped
    manifests, which is the path the sandbox actually stages.
    """
    manifests = _manifests()
    declared = {}
    for pkg, doc in manifests.items():
        for analysis in (doc.get("contributes") or {}).get("analyses") or []:
            entry = (analysis.get("run") or {}).get("entry")
            if entry:
                declared[analysis["id"]] = PACKAGES / pkg / entry

    for analysis_id, path in VC.ENTRIES.items():
        assert analysis_id in declared, (
            f"{analysis_id} is no longer contributed by any package manifest")
        assert path == declared[analysis_id], (
            f"{analysis_id} is declared at {declared[analysis_id]} but this suite drives "
            f"{path}")
        assert path.is_file(), f"{analysis_id}'s entry {path} does not exist"


# ── TEST-3's declaration-site half (INV-3) ──────────────────────────────────────────


def test_no_package_declares_a_spatial_specific_entity_axis():
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-6] — the other direction.

    `test_visium_chain_compat.py` scans the artifacts a real import EMITS. That cannot see
    an axis added to a `manifest.yaml` but not yet produced by anything — and the axis
    vocabulary is exactly where a `spots` axis would be introduced first, one release
    before any artifact used it. So the declaration site is checked here, over every
    package's declared datatypes, as data.

    `vertex` is permitted: §6.1 of the design introduces it and `spatial/boundaries`
    legitimately declares it as ITS entity axis. What INV-3 forbids is a spatial-specific
    stand-in for `cells` — a per-observation axis that would make every
    `subtypes_of: single-cell/expression` selector miss and fork `metadata-column`.
    """
    forbidden = {"spots", "spot", "bins", "bin", "pixels", "pixel", "beads", "bead"}
    seen_axes = set()
    for pkg, doc in _manifests().items():
        for datatype in (doc.get("contributes") or {}).get("datatypes") or []:
            axes = datatype.get("axes") or []
            for axis in axes:
                name = axis.get("name") if isinstance(axis, dict) else str(axis)
                if not name:
                    continue
                seen_axes.add(name)
                if name == "cells":
                    # §9's constraint is "the entity axis must remain `cells` WITH
                    # `key_label: barcode`". The second half is quoted in both INV-3 test
                    # docstrings and was asserted only indirectly, through the emitted
                    # column — so the DECLARATION site, which is where a spatial-specific
                    # key label would arrive first, was unchecked.
                    # No shorthand escape. `AxisSpec` (server `modules/datatype/types.rs`)
                    # declares `name` and `key_label` as non-optional `String`s with no
                    # serde default and no untagged string variant, so a bare-string axis
                    # entry fails manifest deserialization outright — it cannot reach here,
                    # and if it ever could, the missing key label IS the violation.
                    label = axis.get("key_label") if isinstance(axis, dict) else None
                    assert label == "barcode", (
                        f"{pkg} declares the `cells` axis on {datatype['id']!r} with "
                        f"key_label {label!r}, not 'barcode'. §9's first constraint names "
                        f"both halves, and a spatial-specific key label forks every "
                        f"consumer that joins on it just as surely as a renamed axis would")
                assert name not in forbidden, (
                    f"{pkg} declares an axis named {name!r} on datatype "
                    f"{datatype['id']!r}. §9's first constraint is that the entity axis "
                    f"stays `cells`; a spatial-specific one forks `metadata-column` and "
                    f"makes every shipped `subtypes_of: single-cell/expression` selector "
                    f"miss")
            entity = datatype.get("entity_axis")
            if entity:
                seen_axes.add(str(entity))
                assert str(entity) not in forbidden, (
                    f"{pkg} declares entity_axis {entity!r} on {datatype['id']!r}")
    assert "cells" in seen_axes, (
        f"no package declares a `cells` axis at all ({sorted(seen_axes)}), so the scan "
        f"above read the wrong field and its refusals are vacuous")
