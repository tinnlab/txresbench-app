#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [acceptance] [invariant: INV-6] [covers: ITEM-1] — the manifest declares only
load/enable/execute facts, contributes NO `datatypes:` block, and forecasts nothing about the
columns it will land.

THE NO-DATATYPES CLAIM IS THE LOAD-BEARING ONE, and it is a claim about two guards that read
the tree rather than about taste. `scripts/check-derived-vocabulary.sh` DERIVES its forbidden
vocabulary from every `contributes.datatypes[].id` in the package tree: the moment this package
declares an id of its own, that string becomes a term the whole repo is then policed against,
and the hand-maintained `datatype/tests/lattice_golden.json` has to grow a row for it in the
same commit or the lattice goes red. A per-cell doublet score IS a continuous
`metadata-column`, the call IS a categorical one, the run report IS a `report/qc` — all three
already exist in `single-cell-types` on the shared `cells` axis. Declaring a new kind would buy
nothing and cost two guards plus a golden, so the absence of the block is the feature and this
test is what keeps it absent when someone "tidies up" by adding one.

The rest is the shape `loadProcessors.ts` + `lint_processor_tree` accept: the exact `produces`
/ `consumes` strings the chaining graph matches on, the SINGULAR `appliesTo` selector (this is
an RNA-count method — see the manifest), a real on-disk entry/helpers/`ui:` set, and none of
the removed keys.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"

# The keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def _load():
    return yaml.safe_load(_MANIFEST.read_text())


def _detect():
    return next(a for a in _load()["contributes"]["analyses"]
                if a["id"] == "doublet.detect")


def test_the_package_contributes_no_datatypes_block_at_all():
    """Not "an empty list", not "a block with no ids" — no key. `check-derived-vocabulary.sh`
    greps the tree for `contributes.datatypes` and folds every `id` under it into the forbidden
    set, so an EMPTY block is still a block the deriver walks and a new id is one edit away.
    The honest state is that this package invents no kind."""
    contributes = _load()["contributes"]
    assert "datatypes" not in contributes, (
        "the doublet package declared a `contributes.datatypes` block. Every id under it is "
        "folded into `scripts/check-derived-vocabulary.sh`'s derived forbidden vocabulary and "
        "needs a matching row in the hand-maintained `datatype/tests/lattice_golden.json`. "
        "A doublet score is a continuous `metadata-column`, the call a categorical one and the "
        "report a `report/qc` — all three already exist in `single-cell-types`."
    )


def test_produces_and_consumes_are_the_exact_chaining_strings():
    """`chaining.ts` matches these by EXACT string, so the list is the edge — a reordering or a
    near-miss spelling silently removes this analysis from the workbench's offer graph."""
    detect = _detect()
    assert detect["produces"] == ["metadata-column", "report/qc"]
    assert detect["consumes"] == ["metadata-column"]


def test_applies_to_is_the_singular_raw_expression_selector():
    """One matrix, one run. `multiple: true` would let a job span the protein and ATAC matrices
    on the same cells axis, which is exactly the wrong answer: this is an RNA-count method and
    ATAC doublets need AMULET. The `excludes` is the raw-count gate — Scrublet normalizes
    internally, so a normalized matrix produces meaningless scores rather than an error."""
    detect = _detect()
    selectors = detect["appliesTo"]
    assert isinstance(selectors, list) and len(selectors) == 1, selectors

    sel = selectors[0]
    assert sel["slot"] == "matrix"
    assert sel["subtypes_of"] == "single-cell/expression"
    assert sel["excludes"] == ["single-cell/normalized"]
    assert sel["auto_bind_sole_candidate"] is True
    assert "multiple" not in sel, (
        "`multiple` appeared on the doublet.detect selector — the analysis is SINGULAR "
        "(one RNA count matrix, one run); protein/ATAC doublets need different methods"
    )


def test_run_block_names_files_that_exist_on_disk():
    """A `run.entry` or `run.helpers` path that does not resolve is a job that fails when the
    sandbox stages `/code`, not at load — so the manifest naming the file is only half of it."""
    run = _detect()["run"]
    assert run["kind"] == "sandbox"
    assert run["runtime"] == "python"
    assert (_PKG / run["entry"]).is_file(), run["entry"]

    helpers = run["helpers"]
    assert helpers, "the entry imports `_shared` (and the vendored `_criteria`) off /code"
    for helper in helpers:
        assert (_PKG / helper).is_file(), f"declared helper does not exist: {helper}"


def test_schedule_class_and_arch():
    detect = _detect()
    assert detect["schedule"]["class"] == "batch"
    assert detect["arch"] == ["x86_64", "aarch64"]
    assert detect["category"] == "qc"


def test_every_declared_view_file_exists():
    """A `ui:` entry naming a missing file is a LOAD ERROR, not a silently shorter pane — so
    the two declared views must both be on disk, package-relative."""
    detect = _detect()
    assert detect["ui"] == ["ui/doublet.yaml", "ui/doublet-report.yaml"]
    for view in detect["ui"]:
        assert str(view).startswith("ui/"), view
        assert (_PKG / view).is_file(), f"declared view does not exist: {view}"


def test_no_removed_keys_anywhere():
    detect = _detect()
    assert not (set(detect) & REMOVED_KEYS), set(detect) & REMOVED_KEYS
    # nested removed keys: run.inputs, schedule.resources.
    assert "inputs" not in (detect.get("run") or {})
    assert "resources" not in (detect.get("schedule") or {})
    # no forecast of produced columns — the landed column's kind is READ from the artifact,
    # which stamps its own `attributes.txr`; a manifest forecast is checked by nothing.
    assert "produces_annotations" not in detect
