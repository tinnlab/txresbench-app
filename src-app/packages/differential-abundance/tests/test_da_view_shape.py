#!/usr/bin/env python3
# ruff: noqa
"""TEST-18 [covers: ITEM-10] — the two run forms are valid declarative views over real seams.

The whole user-facing surface of this feature is two `ui/*.yaml` files interpreted by the shipped
workbench renderer; the package adds no render source at all. So the thing that can go wrong is
not a rendering bug, it is a DECLARATION that names something which does not exist: a widget kind
the engine does not ship, an effect op outside the closed trust boundary, a `$`-reference to a
slice nobody declared, or — the silent one — an input slot the compute never resolves, which
launches happily and simply does not bind.

Every vocabulary below is READ OUT OF THE SHIPPED SOURCE (the TS vocabulary file, the compute's
own `*_SLOT` constants, `_kernel.catalog()`), never retyped here, so a change on either side of
the seam fails this test instead of drifting past it.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_UI = _PKG / "ui"
_VOCAB = _PKG.parents[1] / "ui" / "src" / "modules" / "workbench" / "core" / "spec" / "vocabulary.ts"

FORMS = {"clusters": _UI / "clusters.yaml", "neighbourhoods": _UI / "neighbourhoods.yaml"}


def _spec(name):
    return yaml.safe_load(FORMS[name].read_text())


def _ts_list(const):
    """The shipped closed vocabulary, parsed out of `vocabulary.ts`."""
    src = _VOCAB.read_text()
    block = src.split(f"export const {const} = [")[1].split("] as const")[0]
    return {m.group(1) for m in re.finditer(r"'([^']+)'", block)}


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


@pytest.mark.parametrize("name", sorted(FORMS))
def test_every_widget_kind_is_one_the_engine_ships(name):
    kinds = _ts_list("WIDGET_KINDS")
    for w in _spec(name)["widgets"]:
        assert w["kind"] in kinds, f"{name}: unknown widget kind {w['kind']!r}"
        assert w["id"], f"{name}: a widget with no id"


@pytest.mark.parametrize("name", sorted(FORMS))
def test_every_effect_op_is_inside_the_closed_trust_boundary(name):
    ops = _ts_list("EFFECT_OPS")
    for action in _spec(name)["actions"]:
        for effect in action["body"]:
            for key in effect:
                assert key in ops, f"{name}: unknown effect op {key!r}"


@pytest.mark.parametrize("name", sorted(FORMS))
def test_every_dollar_reference_names_a_declared_slice(name):
    spec = _spec(name)
    declared = {ns: set((spec.get(ns) or {}).keys())
                for ns in ("state", "data", "derived", "const")}
    for s in _strings(spec):
        for m in re.finditer(r"\$(state|data|derived|const)\.([A-Za-z_][A-Za-z0-9_]*)", s):
            ns, key = m.group(1), m.group(2)
            assert key in declared[ns], f"{name}: dangling $-reference ${ns}.{key}"


@pytest.mark.parametrize("name", sorted(FORMS))
def test_every_action_referenced_by_a_widget_exists(name):
    spec = _spec(name)
    action_ids = {a["id"] for a in spec["actions"]}
    for w in spec["widgets"]:
        for key in ("onChange", "onClick"):
            if key in w:
                assert w[key] in action_ids, f"{name}: {w['id']} names missing action {w[key]!r}"


def test_the_forms_bind_only_slots_the_compute_actually_resolves():
    """The silent failure this catches: a binding whose slot name the compute never reads launches
    happily, and the run proceeds with that input simply absent."""
    import clusters as CL
    import neighbourhoods as NB

    known = {
        "clusters": {CL.POPULATION_SLOT, CL.CONDITION_SLOT, CL.SAMPLE_SLOT},
        "neighbourhoods": {NB.EMBEDDING_SLOT, NB.CONDITION_SLOT, NB.SAMPLE_SLOT,
                           NB.ANNOTATION_SLOT},
    }
    from da_modules import import_own
    COVARIATE_SLOT_PREFIX = import_own("_shared").COVARIATE_SLOT_PREFIX

    for name, slots in known.items():
        spec = _spec(name)
        run = next(e["run_processor"] for a in spec["actions"] for e in a["body"]
                   if "run_processor" in e)
        for slot in (run.get("inputs") or {}):
            assert slot in slots, f"{name}: literal input slot {slot!r} is not resolved by the compute"
        for binding in run.get("inputs_from") or []:
            slot = binding["slot"]
            if slot.startswith(COVARIATE_SLOT_PREFIX):
                continue                                  # `covariate:<name>`, read by prefix
            assert slot in slots, f"{name}: bound slot {slot!r} is not resolved by the compute"


def test_the_run_actions_target_the_analysis_ids_the_manifest_declares():
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    declared = {a["id"] for a in manifest["contributes"]["analyses"]}
    for name in FORMS:
        spec = _spec(name)
        run = next(e["run_processor"] for a in spec["actions"] for e in a["body"]
                   if "run_processor" in e)
        assert run["id"] in declared, f"{name}: runs unknown analysis {run['id']!r}"


def test_the_design_plumbing_is_reused_not_reinvented():
    """#82 — two analyses inventing two design UXs would be a defect. Both forms must use the SAME
    `catColumns` picker idiom and the SAME `inputs_from` / `obsSources` binding `de.compare` uses."""
    de = (_PKG.parent / "differential-expression" / "ui" / "compare.yaml").read_text()
    assert "columns_of: { obs: \"$data.obs\", only: categorical }" in de or "only: categorical" in de
    for name in sorted(FORMS):
        spec = _spec(name)
        assert spec["derived"]["catColumns"]["columns_of"]["only"] == "categorical"
        assert spec["data"]["obsSources"]["args"]["as"] == "sources"
        run = next(e["run_processor"] for a in spec["actions"] for e in a["body"]
                   if "run_processor" in e)
        bound = {b["slot"]: b["artifact"] for b in run["inputs_from"]}
        assert bound["condition"] == "$data.obsSources[$state.condition]"
        assert bound["sample"] == "$data.obsSources[$state.sample]"


def test_the_method_enum_is_sourced_from_the_kernel_catalog():
    import _kernel as K

    catalog = [m["key"] for m in K.catalog()]
    for name in sorted(FORMS):
        options = [o["value"] for o in _spec(name)["const"]["methods"]]
        assert options == catalog, (
            f"{name}: the method enum {options} has drifted from `_kernel.catalog()` {catalog}")


def test_the_cluster_form_offers_exactly_the_two_declared_normalizations_and_no_proportions():
    import _kernel as K

    options = [o["value"] for o in _spec("clusters")["const"]["normalizations"]]
    assert options == list(K.NORMALIZATIONS)
    labels = " ".join(o["label"] for o in _spec("clusters")["const"]["normalizations"]).lower()
    assert "assumes" in labels, "each normalization option must name the assumption it makes"
    assert "proportion" not in labels


def test_the_neighbourhood_form_never_offers_the_reference_normalization():
    """A neighbourhood is a discovered, seed-dependent region, so there is no stable population to
    name as a constant reference. The form sends `poscounts` and the compute refuses the other."""
    spec = _spec("neighbourhoods")
    assert "normalizations" not in spec["const"]
    run = next(e["run_processor"] for a in spec["actions"] for e in a["body"]
               if "run_processor" in e)
    assert run["params"]["normalization"] == "poscounts"


@pytest.mark.parametrize("name", sorted(FORMS))
def test_the_mandatory_disclosures_are_present_in_the_form_copy(name):
    text = " ".join(_strings(_spec(name))).lower()
    assert "compositional" in text, f"{name}: the compositional trap is not disclosed"
    assert "relative" in text and "spike-in" in text, f"{name}: the absolute-abundance caveat is missing"
    assert "provenance" in text, f"{name}: the regime's basis is not stated"
    assert "unit of replication" in text or "not replicates" in text


def test_the_cluster_form_carries_the_mandatory_resolution_sensitivity_disclosure():
    """INV-DA-3 makes this disclosure mandatory on the cluster-level analysis; the neighbourhood
    form states the complement (that it is resolution-free)."""
    clusters = " ".join(_strings(_spec("clusters"))).lower()
    assert "clustering resolution" in clusters
    assert "find shifting populations" in clusters, (
        "the disclosure must point at the resolution-free complement")
    nhoods = " ".join(_strings(_spec("neighbourhoods"))).lower()
    assert "without choosing a clustering resolution" in nhoods or "resolution" in nhoods


def test_both_forms_reuse_jobs_use_and_introduce_no_permission():
    for name in sorted(FORMS):
        spec = _spec(name)
        assert spec["permission"] == "jobs::use"
        for action in spec["actions"]:
            assert action["permission"] == "jobs::use"


def test_the_two_forms_say_which_question_each_analysis_answers():
    """#109 — 'Both are shipped, and the UI must state which question each answers rather than
    presenting them as two flavours of one thing.'"""
    clusters = " ".join(_strings(_spec("clusters")))
    nhoods = " ".join(_strings(_spec("neighbourhoods")))
    assert "THIS NAMED population" in clusters and "Find shifting populations" in clusters
    assert "ANY REGION" in nhoods and "Compare population abundance" in nhoods
