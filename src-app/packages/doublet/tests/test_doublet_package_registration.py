#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 [covers: ITEM-7] — the package is REGISTERED and its manifest has the shape the
build/boot lints accept.

`src-app/packages/pytest.ini`'s `testpaths` is an ENUMERATION, not a glob. `just check-py`
runs a bare `python3 -m pytest` from `src-app/packages`, which honours that line — so a suite
whose directory is not listed there is collected by NOTHING, and the whole package's coverage
is green because it never ran.

That is not hypothetical. `annotation-integrate` was the case in point: its only coverage lived
in `_helpers/tests/test_integrate.py` (the pure core), so the package's own I/O contract had no
suite at all, and artifact-model ITEM-26 shipped a BROKEN live integrate job with every gate
green. The rule that came out of it is that a new `<package>/tests/` directory is added to
`testpaths` in the SAME commit that creates it — which is what the first test below pins, from
this suite, which cannot itself be running unless the line is right in the harness that matters.

The second test pins the id/publisher/version shape `lint_processor_tree` accepts at build and
`check-processor-seed-versions.sh` reads: the seed reconciler keys the extract cache on
`manifest.yaml`'s `version`, so a malformed or missing one is a provisioned deployment quietly
executing a stale kernel.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PYTEST_INI = _PKG.parent / "pytest.ini"
_MANIFEST = _PKG / "manifest.yaml"

# Keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def test_pytest_ini_registers_the_doublet_suite():
    text = _PYTEST_INI.read_text()
    # the enumeration `testpaths` MUST list the package's tests, or nothing collects it.
    testpaths = next(l for l in text.splitlines() if l.strip().startswith("testpaths"))
    assert "doublet/tests" in testpaths, (
        "`doublet/tests` is missing from `src-app/packages/pytest.ini` `testpaths`. "
        "`just check-py` collects only what that line enumerates, so this whole suite would "
        "be green by never running — the annotation-integrate failure mode."
    )


# TEST-54 — enumerated in `.lifecycle/scdblfinder-method/TESTS.md`.
def test_manifest_has_the_shape_the_processor_lint_accepts():
    doc = yaml.safe_load(_MANIFEST.read_text())
    assert doc["id"] == "doublet"
    assert doc["publisher"] == "txr"
    assert doc["apiVersion"] == "1.0"
    # a dotted, non-empty version string — what the seed reconciler compares and what
    # `check-processor-seed-versions.sh` requires to have MOVED when the package's bytes did.
    version = str(doc["version"])
    parts = version.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts), version

    analyses = doc["contributes"]["analyses"]
    # BOTH methods, and this set is EXACT: an analysis appearing here without a line in
    # this file is exactly the silent addition the set is for. It was `{"doublet.detect"}`
    # until #195 added the R lane; a THIRD entry (`doublet.doubletfinder`, #242) is a
    # deliberate edit here, not a diff that slips in.
    assert {a["id"] for a in analyses} == {"doublet.detect", "doublet.scdblfinder"}

    # ── what is TRUE OF BOTH METHODS, and is the reason two can share one package ─────
    #
    # The per-analysis keys below are the ones `cell.filter`, the report and colour-by
    # depend on being the same. `runtime`, `env`, `entry` and `helpers` are NOT here,
    # because they are precisely what differs — see the per-method block after this loop.
    for a in analyses:
        # an analysis id is NAMESPACED under the package id, which is how the extension
        # loader resolves a run request back to a package tree.
        assert a["id"].split(".")[0] == doc["id"], a["id"]
        # no removed keys anywhere on the analysis.
        assert not (set(a) & REMOVED_KEYS), (a["id"], set(a) & REMOVED_KEYS)
        run = a["run"]
        assert run["kind"] == "sandbox", a["id"]
        assert run.get("entry"), a["id"]
        # a valid, declared schedule class + a non-empty appliesTo + declared view files.
        assert a["schedule"]["class"] == "batch", a["id"]
        assert a["appliesTo"] and isinstance(a["appliesTo"], list), a["id"]
        assert a["ui"] and all(str(u).startswith("ui/") for u in a["ui"]), a["id"]
        # THE PROPERTY THE THREE-ANALYSIS SHAPE RESTS ON: identical output kinds, so a
        # downstream consumer takes either method's result unchanged.
        assert a["produces"] == ["metadata-column", "report/qc"], a["id"]
        assert a["consumes"] == ["metadata-column"], a["id"]

    by_id = {a["id"]: a for a in analyses}

    # The Scrublet lane: python, in the DEFAULT image, with NO `env` — which is what makes
    # "a user without the R env still gets doublet detection" true rather than hoped for.
    scrublet = by_id["doublet.detect"]
    assert scrublet["run"]["runtime"] == "python"
    assert "env" not in scrublet, (
        "`doublet.detect` must declare NO `env`: an env-less contribution runs in the "
        "deployment default image with no opt-in, and declaring one would gate the "
        "python method behind an image the R lane introduced")
    assert "compute/_shared.py" in (scrublet["run"].get("helpers") or [])

    # The scDblFinder lane: R, in its own declared image, staging only its OWN helper.
    r = by_id["doublet.scdblfinder"]
    assert r["run"]["runtime"] == "rscript"
    assert r["env"] == "single-cell-r"
    assert r["run"]["entry"].endswith(".R")
    assert r["run"]["helpers"] == ["compute/_wire.R"], (
        "the R entry stages exactly its own wire helper. `stages_app_helpers(Rscript)` is "
        "false, so nothing from `_lib` reaches it and a python helper listed here would "
        "be a declaration the platform silently does not honour")
    # NO `run.dependencies` — see the manifest comment beside the key it governs, and
    # TEST-13, which proves by mutation that declaring one turns the tree red.
    assert not r["run"].get("dependencies"), (
        "the R entry must declare NO `run.dependencies`: the recorder that would enforce "
        "such a contract (`txr_deps.py`) is a python helper an R entry never receives, "
        "and `every_dependency_declaring_entry_reaches_the_recorder` refuses a declaration "
        "with no reachable recorder — with no language exemption")


# ── ITEM-8 / ITEM-9 / ITEM-11 — the three claims that had no in-package assertion ────────

def test_every_declared_view_file_exists_and_parses_and_owns_its_analysis():
    """TEST-65 — ITEM-8. A `ui:` entry naming a missing or unparseable file is a LOAD ERROR,
    not a silently shorter list — the analysis simply vanishes from the workbench, and the
    only symptom is an absence nobody is looking for.

    So every declared path is opened and parsed, and each view is required to declare an `id`
    and a `permission`. The id convention is the one the shipped views follow: the RUN FORM's
    id equals the analysis id, and the readout takes a sibling id under it — which is what
    lets `collect-actions.mjs` namespace `<view.id>::<action.id>` without collisions.

    Delete this and a typo in a `ui:` path ships an analysis that loads for nobody.
    """
    import yaml as _yaml

    doc = _yaml.safe_load(_MANIFEST.read_text())
    seen_ids = set()
    for analysis in doc["contributes"]["analyses"]:
        declared = analysis.get("ui") or []
        assert declared, analysis["id"]
        for rel in declared:
            path = _MANIFEST.parent / rel
            assert path.is_file(), f"{analysis['id']} declares {rel}, which does not exist"
            spec = _yaml.safe_load(path.read_text())
            assert isinstance(spec, dict), rel
            assert spec.get("id"), f"{rel} declares no `id`"
            assert spec.get("permission"), (
                f"{rel} declares no `permission`; `collect-actions.mjs` synthesizes "
                f"`{spec.get('id')}::describe` off it and refuses an unknown one")
            assert spec["id"] not in seen_ids, f"duplicate view id {spec['id']} ({rel})"
            seen_ids.add(spec["id"])
            # Every view id is NAMESPACED UNDER THE PACKAGE, which is what keeps
            # `collect-actions.mjs`'s `<view.id>::<action.id>` unique across the tree. It is
            # NOT namespaced under the analysis: the shipped readout is `doublet.report`,
            # a package-level sibling of `doublet.detect`, and asserting otherwise would
            # have been this test inventing a convention the tree does not follow.
            assert spec["id"].split(".")[0] == doc["id"], (rel, spec["id"], doc["id"])
        # …and the FIRST declared view is the run form, which is what renders on top.
        first = _yaml.safe_load((_MANIFEST.parent / declared[0]).read_text())
        assert first["id"] == analysis["id"], (
            f"{analysis['id']}'s first declared view is {first['id']}, so the readout would "
            f"render above the run form")

        # …and BOTH views are declared. Deleting a non-first entry — the readout — was
        # uncovered: the analysis kept loading, its run form kept rendering, and the results
        # pane simply had nothing in it. `doublet.detect`'s list is protected by the
        # base-commit comparison in `test_scrublet_lane_unchanged.py`, so only the R lane's
        # readout could silently vanish; this closes that.
        assert len(declared) == 2, (
            f"{analysis['id']} declares {len(declared)} view(s): {declared}. Both methods "
            f"ship a run form AND a readout; a missing readout is an analysis that runs and "
            f"shows the user nothing.")
        second = _yaml.safe_load((_MANIFEST.parent / declared[1]).read_text())
        assert second["id"] != analysis["id"], (declared, second["id"])
        assert "report" in second["id"], (
            f"{analysis['id']}'s second view is {second['id']}, which is not a readout")

        # …and the readout has CONTENT that reads the run's report. Pinning the id alone
        # was not coverage: a blind audit gutted `ui/scdblfinder-report.yaml` to `id` +
        # `permission` + `widgets: []` and 81 tests stayed green — which is exactly the
        # state the assertion above says it forbids ("an analysis that runs and shows the
        # user nothing"). It also renamed a duplicate of the RUN FORM to the readout's id
        # and that passed too.
        widgets = second.get("widgets") or []
        assert widgets, f"{declared[1]} declares no widgets — it renders nothing"
        blob = _yaml.dump(second)
        # `$data.report` ONLY. A previous version also accepted the substring `report.`,
        # which any prose ending a sentence with "…the report." satisfies — so a readout
        # reduced to one hardcoded alert and no `data:` block at all passed 81 tests, the
        # same 81 this assertion was written to stop passing. Both real readouts bind
        # `$data.report` on its own, so the disjunct bought nothing but the hole.
        assert "$data.report" in blob, (
            f"{declared[1]} binds nothing from the run's report, so it is not a readout of "
            f"this analysis — it is a page that happens to be named like one")
        # …and it is not the run form wearing the readout's id: a run form declares the
        # matrix picker and the Run action; a readout declares neither.
        assert "run_processor" not in blob, (
            f"{declared[1]} contains the run action, so it is a copy of the run form")


def test_the_r_methods_schedule_class_is_recorded_with_the_measurement_behind_it():
    """TEST-66 — ITEM-9. `schedule.class` was RE-DERIVED for the R method rather than copied
    from the Scrublet lane, whose memory model in `_shared.py` is Scrublet-specific.

    A test cannot honestly re-measure peak RSS on every run — it depends on the box, the
    allocator and what else is resident, so it would be a flake generator; and asserting the
    recorded number against itself would prove nothing. What IS pinned here is that the
    declaration exists, is a valid class, and does not silently become a bare copy: the
    manifest must carry the measured figure BESIDE the declaration, so a future change to the
    class has to confront the measurement rather than inherit a number nobody re-took.

    This is the honest half of ITEM-9, and the limit is stated in TESTS.md rather than
    implied away.
    """
    import re
    import yaml as _yaml

    doc = _yaml.safe_load(_MANIFEST.read_text())
    for analysis in doc["contributes"]["analyses"]:
        assert analysis["schedule"]["class"] in ("interactive", "normal", "batch"), analysis["id"]

    text = _MANIFEST.read_text()
    block = text[text.index("- id: doublet.scdblfinder"):]
    assert "peak RSS" in block, (
        "the R method's schedule class is declared without the measurement it was derived "
        "from; ITEM-9/DEC-11 require it to be measured rather than copied")
    assert re.search(r"\b1,?536 MiB\b", block), (
        "the recorded peak-RSS figure is gone from the manifest — if it was re-measured, "
        "update it here; if it was deleted, the class is now an inherited number")


def test_every_analysis_this_package_contributes_has_a_model_coverage_disposition():
    """TEST-67 — ITEM-11. The model-coverage register is derived in BOTH directions against
    the (producer x row-bearing datatype) pair set, so a producer with no disposition reddens
    the tree — but that check lives in a Rust test, and this package's own suite could not
    see it.

    This is the in-package half: every analysis here that produces a row-bearing datatype
    must have an entry, with a disposition from the CLOSED vocabulary and, for
    `rows-undeclared`, a reason long enough to be an argument rather than a shrug.

    Delete this and adding a third method (`doublet.doubletfinder`, #242) goes green here
    and red somewhere the author is not looking.
    """
    import json
    import yaml as _yaml

    register = json.loads((_MANIFEST.parent.parent / "_lib" /
                           "model_coverage_exempt.json").read_text())
    entries = {(e["producer"], e["datatype"]): e for e in register["producer"]}

    doc = _yaml.safe_load(_MANIFEST.read_text())
    for analysis in doc["contributes"]["analyses"]:
        # `report/qc` has no axis, so it is not row-bearing and needs no entry.
        assert "metadata-column" in analysis["produces"], analysis["id"]
        key = (analysis["id"], "metadata-column")
        assert key in entries, (
            f"{analysis['id']} produces `metadata-column` and has no disposition in "
            f"`_lib/model_coverage_exempt.json`")
        entry = entries[key]
        assert entry["disposition"] in ("rows-declared", "rows-undeclared"), entry
        if entry["disposition"] == "rows-undeclared":
            assert len(entry.get("reason", "")) >= 40, (
                f"{analysis['id']}'s undeclared disposition needs a reason, not a shrug")
