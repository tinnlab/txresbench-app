#!/usr/bin/env python3
# ruff: noqa
"""Provenance and identity — the two things unrecoverable from the bytes afterwards.

"The vendor pipeline is a **processing step we did not run**, and the honest position is
that its version is as load-bearing as any of our own parameters … Record all of it, and
record **which segmentation produced the entities**, because for imaging platforms that is
the dominant determinant of every downstream result." (§7.4)

Both fixtures are asserted, and they are different XOA MAJOR versions, so a reader that
happened to hardcode one version's key layout goes red rather than green.
"""
import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

PACKAGES = XF.PKG.parent


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-prime-prov")
    module, entries = XF.run_over(XF.PRIME, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PRIME}


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    out = tmp_path_factory.mktemp("xenium-protein-prov")
    module, entries = XF.run_over(XF.PROTEIN, out)
    return {"out": out, "entries": entries, "module": module, "bundle": XF.PROTEIN}


def _report(ctx):
    return json.loads((ctx["out"] / "xenium-import-report.json").read_text())


# ── TEST-6 [acceptance] [invariant: INV-6] ───────────────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_vendor_pipeline_reaches_both_the_artifact_and_the_report(case, prime, protein):
    """TEST-6 [acceptance] [invariant: INV-6] — recorded, verbatim, in both channels.

    The vendor's EXACT strings, compared against `experiment.xenium` itself rather than
    against constants — a test that hardcoded "xenium-3.0.0.15" would still pass if the
    importer wrote a hardcoded version of its own.

    Both channels are asserted because they serve different readers: `meta` travels with the
    artifact into every downstream declaration, and the report is what a human opens. #211
    records that `meta` reaches no sandboxed consumer, so neither is redundant.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    experiment = XF.experiment(ctx["bundle"])
    provenance = XF.entry(ctx["entries"], "expression")["meta"]["provenance"]
    reported = _report(ctx)["provenance"]

    expected = {
        "pipeline": experiment["analysis_sw_version"],
        "instrument_software": experiment["instrument_sw_version"],
        "chemistry": experiment["chemistry_version"],
        "panel": experiment["panel_name"],
        "panel_organism": experiment["panel_organism"],
    }
    for key, value in expected.items():
        assert provenance[key] == value, f"{key} must be the vendor's own string"
        assert reported[key] == value, f"{key} missing from the report a human reads"

    # The run's identity, so two imports of one slide are relatable and two of different
    # slides are not.
    assert provenance["roi_uuid"] == experiment["roi_uuid"]
    assert provenance["experiment_uuid"] == experiment["experiment_uuid"]


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_segmentation_that_produced_the_entities_is_recorded(case, prime, protein):
    """TEST-6 [acceptance] [invariant: INV-6] — "record WHICH segmentation produced the entities".

    §7.4 singles this out: for imaging platforms it is "the dominant determinant of every
    downstream result", and 10x changed the default nucleus expansion from 15 um to 5 um
    between versions, which alters every cell in the dataset.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    experiment = XF.experiment(ctx["bundle"])
    header, rows = XF.cells_table(ctx["bundle"])
    vendor_methods = sorted({r[header.index("segmentation_method")] for r in rows})

    for output_id in ("expression", "spatial-coordinates"):
        segmentation = XF.entry(ctx["entries"], output_id)["meta"]["measured_entity"]["segmentation"]
        assert segmentation["software_version"] == experiment["analysis_sw_version"], (
            "the segmentation's version is the XOA version that produced it — without it a "
            "5 um and a 15 um expansion are indistinguishable"
        )
        assert segmentation["params"]["methods"] == vendor_methods, (
            "every method the vendor's own per-cell column states must be recorded"
        )
    assert sorted(_report(ctx)["segmentation_methods"]) == vendor_methods


#: Compared LOWERCASED and STRIPPED — which is the whole correction here.
#:
#: This tuple used to be matched case-SENSITIVELY as `("unknown", "n/a", "NA")`, and the
#: real protein bundle writes `panel_design_id: "N/A"`. So with the importer's placeholder
#: filter mutated OFF, that value reached `meta.provenance` and THIS TEST STAYED GREEN —
#: only the sibling `test_absence_is_absence.py`, which lowercases first, went red. An
#: acceptance-tagged assertion that cannot see the exact spelling the real vendor data
#: carries proves nothing about the invariant it names.
_PLACEHOLDER_SPELLINGS = ("", "unknown", "n/a", "na", "none", "null", "-")

#: The one key deliberately EXEMPT: recording the placeholder 10x writes into `library_ids`
#: is the evidence for deriving the coordinate space from `roi_uuid` instead, so dropping it
#: would hide the finding rather than honour the rule.
_PLACEHOLDER_EXEMPT = ("matrix_library_id",)


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_absence_stays_absence_in_provenance(case, prime, protein):
    """TEST-6 [acceptance] [invariant: INV-6] — no key is filled with a placeholder.

    A field nobody could fill is DROPPED, never written as "unknown", so a reader cannot
    mistake our placeholder for the vendor's answer — and the vendor writing "N/A" in a
    field does not make it a fact either.
    """
    ctx = {"prime": prime, "protein": protein}[case]
    provenance = XF.entry(ctx["entries"], "expression")["meta"]["provenance"]
    for key, value in provenance.items():
        assert value is not None, f"provenance[{key!r}] is null; drop the key instead"
        if key in _PLACEHOLDER_EXEMPT:
            continue
        assert str(value).strip().lower() not in _PLACEHOLDER_SPELLINGS, (
            f"provenance[{key!r}] is {value!r}, a placeholder; drop the key instead"
        )


def test_the_placeholder_check_can_actually_see_the_real_vendor_spelling(prime, protein):
    """TEST-6 — THE CONTROL for the assertion above, because it had none and was hollow.

    The check is only worth anything if the spelling the vendor really uses is inside the
    set it compares against. Asserted directly against `experiment.xenium` rather than
    against a remembered list: if 10x starts writing a different placeholder, this goes red
    at the fixture rather than silently widening the hole above.
    """
    module = XF.load_compute()

    # SCANNED OVER THE KEYS THE IMPORTER ACTUALLY COPIES, not over every key in the file,
    # and asserted ONCE over BOTH fixtures rather than per fixture.
    #
    # Both corrections come from the same measurement. The looser form passed on the prime
    # bundle by finding `panel_predesigned_id: ""` and `segmentation_stain: ""` — neither of
    # which is in `PROVENANCE_KEYS` — so it certified an assertion that had nothing to
    # reject there; both placeholder mutations fail ONLY on [protein]. And parametrising it
    # per fixture would now leave the prime arm with two honest options, a vacuous pass or a
    # skip, when the truth is simply that ONE of the two real bundles exercises the rule and
    # that is enough. A skip is not a pass and a vacuous pass is worse, so the claim is
    # stated at the level it is actually true at: the vendor's real spelling, somewhere in
    # the committed fixtures, is inside the set the check compares against.
    copied = [source for source, _out in module.PROVENANCE_KEYS] + [
        "experiment_uuid", "roi_uuid", "analysis_uuid"
    ]
    exercised = {}
    for name, ctx in (("prime", prime), ("protein", protein)):
        experiment = XF.experiment(ctx["bundle"])
        hits = {experiment[k].strip() for k in copied
                if isinstance(experiment.get(k), str)
                and experiment[k].strip().lower() in _PLACEHOLDER_SPELLINGS}
        if hits:
            exercised[name] = hits

    assert exercised, (
        "NEITHER committed fixture writes a placeholder in any key this importer copies, so "
        "`test_absence_stays_absence_in_provenance` has nothing to reject on either bundle "
        "and is vacuous. Either 10x changed its spelling — update `_PLACEHOLDER_SPELLINGS` "
        "from the real files — or the fixtures were reduced past the case they were "
        "committed for."
    )
    assert "protein" in exercised and "N/A" in exercised["protein"], (
        "the specific spelling this whole correction exists for is the protein bundle's "
        f"`panel_design_id: \"N/A\"`. Found: {exercised}"
    )
    for hits in exercised.values():
        for spelling in hits:
            assert spelling.strip().lower() in _PLACEHOLDER_SPELLINGS


def test_no_second_provenance_channel_was_invented():
    """TEST-6 [acceptance] [invariant: INV-6] — "Do not invent a second provenance channel."

    The Xenium importer's coordinates ENTRY must introduce no top-level manifest key the
    shipped Visium one lacks. `meta` CONTENTS legitimately differ (different platform,
    different fields); the entry SHAPE may not, because that shape is the wire between a
    producer and the server and a new key there is a new channel by definition.

    ## Why the Visium half runs in a SUBPROCESS

    Loading both computes in one pytest process is precisely the `sys.modules` bare-name
    hazard `xenium_fixtures.load_compute`'s docstring describes: both packages ship a
    `spatial_declarations.py` and an `ome_writer.py`, and whichever loads first wins the
    bare name for the whole session. Importing the Visium entry here would therefore either
    poison this suite's `SD` or be poisoned by it, and the failure would be a silent
    cross-package binding rather than an error. A subprocess has its own `sys.modules`.
    """
    script = textwrap.dedent(
        """
        import json, sys, tempfile
        sys.path.insert(0, "_lib")
        sys.path.insert(0, "_helpers")
        sys.path.insert(0, "spatial-import-visium/tests")
        import visium_fixtures as VF
        _, entries = VF.run_over(VF.FIXTURE, tempfile.mkdtemp())
        entry = [e for e in entries if e["id"] == "spatial-coordinates"][0]
        print("KEYS=" + json.dumps(sorted(entry.keys())))
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=str(PACKAGES),
        capture_output=True, text=True, timeout=900,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    line = [l for l in result.stdout.splitlines() if l.startswith("KEYS=")]
    assert len(line) == 1, result.stdout[-2000:]
    visium_keys = set(json.loads(line[0][len("KEYS="):]))
    assert visium_keys, "the subprocess produced no keys — the comparison would be vacuous"

    import tempfile

    _, entries = XF.run_over(XF.PRIME, tempfile.mkdtemp())
    xenium_keys = set(XF.entry(entries, "spatial-coordinates").keys())
    assert xenium_keys <= visium_keys, (
        f"the Xenium coordinates entry introduces {sorted(xenium_keys - visium_keys)}, "
        "which the shipped Visium entry does not have — that is a second channel"
    )


# ── TEST-22: the coordinate space id ─────────────────────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_coordinate_space_is_derived_from_the_roi_uuid(case, prime, protein):
    """TEST-22 — identity comes from ACQUISITION, not from the analysis or the matrix."""
    ctx = {"prime": prime, "protein": protein}[case]
    experiment = XF.experiment(ctx["bundle"])
    meta = XF.entry(ctx["entries"], "spatial-coordinates")["meta"]

    assert meta["coordinate_space"] == f"xenium:{experiment['roi_uuid']}"
    assert meta["coordinate_space_source"] == "roi_uuid"
    assert experiment["experiment_uuid"] not in meta["coordinate_space"], (
        "experiment_uuid changes on every re-analysis, so a space derived from it would "
        "mint an unrelatable second frame for the same physical slide"
    )
    # The image must land in that same frame, or the two artifacts are not placeable.
    assert XF.entry(ctx["entries"], "spatial-image-morphology")["meta"]["coordinate_space"] \
        == meta["coordinate_space"]


def test_two_different_bundles_get_two_different_spaces(prime, protein):
    """TEST-22 — a FALSE collision is silent wrong data; this is what forbids it."""
    a = XF.entry(prime["entries"], "spatial-coordinates")["meta"]["coordinate_space"]
    b = XF.entry(protein["entries"], "spatial-coordinates")["meta"]["coordinate_space"]
    assert a != b, (
        "two unrelated experiments must not share a coordinate space — one tissue's image "
        "would be declared to sit in the other tissue's frame"
    )


def test_the_visium_rule_would_have_collided_these_two_bundles():
    """TEST-22 — the counterfactual that gives DEC-7 teeth.

    Asserting "we used roi_uuid" only says what the code does. This asserts why: applying
    the SHIPPED Visium rule — derive the space from the matrix's `library_ids` — to these two
    real bundles produces the SAME id for both, because Xenium writes a placeholder there.
    If a future bundle ever carries real library ids this goes red, and the decision can be
    revisited on evidence rather than on memory.
    """
    import h5py

    ids = []
    for bundle in (XF.PRIME, XF.PROTEIN):
        with h5py.File(bundle / "cell_feature_matrix.h5", "r") as f:
            raw = f.attrs["library_ids"]
        value = raw[0] if hasattr(raw, "__len__") and not isinstance(raw, (str, bytes)) else raw
        library = value.decode() if isinstance(value, bytes) else str(value)
        # The Visium rule, spelled out: `f"{platform}:{library_id}"`.
        ids.append(f"xenium:{library}")

    assert ids[0] == ids[1] == f"xenium:{XF.PLACEHOLDER_LIBRARY_ID}", (
        "the Visium rule must collide on these bundles — that collision is the measurement "
        "DEC-7 rests on"
    )


def test_the_fallback_ladder_gets_less_specific_never_more(tmp_path):
    """TEST-22 — each rung named, and the rung is RECORDED so a reader can tell them apart.

    A missed collision (two frames that should be one) is visible and recoverable; a false
    collision is silent wrong data. So the ladder never widens: it goes from an acquisition
    uuid, to slide+region, to a value derived from the run's own measured content.

    RE-POINTED AT #323 [TEST-9 (ITEM-11) of `coordinate-space-identity`]. The third rung used to be
    `Path(bundle_root).name`, and this test asserted it — with a directory called
    `some-user-folder`, which made the rung look discriminating. It is not: that name is the
    SANDBOX MOUNT NAME, derived from the SLOT, so it is plausibly the constant `bundle` for every
    Xenium import in a deployment, and where it is the user's own directory `outs` is XOA's own
    output directory name. The rung the ladder fell to was the rung most likely to be SHARED, which
    inverted this test's own title. The title is now TRUE rather than aspirational, and the rung is
    a digest of the vendor's own cell ids that no other run can produce.
    """
    module = XF.load_compute()
    experiment = XF.experiment(XF.PROTEIN)
    cell_ids = XF.matrix_cell_ids(XF.PROTEIN)
    positions = XF.matrix_positions(XF.PROTEIN)

    space, source = module.coordinate_space_id(experiment, cell_ids, positions)
    assert (space, source) == (f"xenium:{experiment['roi_uuid']}", "roi_uuid")

    without_roi = {k: v for k, v in experiment.items() if k != "roi_uuid"}
    space, source = module.coordinate_space_id(without_roi, cell_ids, positions)
    assert source == "slide_id+region_name"
    # #328: the framing is INJECTIVE — the two components are length-prefixed inside a namespace
    # no vendor value may open with, because `f"xenium:{slide}_{region}"` collapsed
    # `Slide_1_HeartBlock`/`R2` and `Slide_1`/`HeartBlock_R2` into ONE frame. Spelled as a literal
    # rather than as the importer's own expression: a test that re-derives the value it is checking
    # proves only that the reproduction agrees with itself.
    assert space == "xenium:slide_id+region_name:7:Slide_1|14:hKidney_sample|"
    assert (experiment["slide_id"], experiment["region_name"]) == ("Slide_1", "hKidney_sample"), (
        "the fixture's own labels moved, so the literal above is no longer this bundle's rung 2")

    bare = {k: v for k, v in without_roi.items()
            if k not in ("slide_id", "region_name")}
    space, source = module.coordinate_space_id(bare, cell_ids, positions)
    assert source == module.NO_VENDOR_SPACE_SOURCE
    assert space == f"xenium:{module.unverified_space_id(cell_ids, positions)}"
    # MORE specific, not less: the rung it replaced answered the same value for every run mounted
    # under the same basename, and this one answers a different value for a different run.
    assert space != module.coordinate_space_id(
        bare, XF.matrix_cell_ids(XF.PRIME), XF.matrix_positions(XF.PRIME))[0], (
        "the bottom rung must distinguish two unrelated bundles — that is the whole of #323")


def test_the_full_import_records_the_fallback_it_actually_used(tmp_path):
    """TEST-22 — the ladder, exercised through the REAL import rather than the helper alone.

    A unit test of `coordinate_space_id` proves the function; it does not prove the importer
    calls it, or that the rung it chose reaches the artifact. This drives the whole import
    over a bundle whose `roi_uuid` has been removed.
    """
    bundle = tmp_path / "no-roi"
    shutil.copytree(XF.PROTEIN, bundle)
    experiment = json.loads((bundle / "experiment.xenium").read_text())
    experiment.pop("roi_uuid")
    (bundle / "experiment.xenium").write_text(json.dumps(experiment))

    _, entries = XF.run_over(bundle, tmp_path / "out")
    meta = XF.entry(entries, "spatial-coordinates")["meta"]
    # [TEST-10 (ITEM-11, ITEM-5) of `coordinate-space-identity`] — the ladder change has to reach
    # the ARTIFACT, not only the helper, and rung 2 with two REAL vendor values is unmoved by #323.
    assert meta["coordinate_space_source"] == "slide_id+region_name"
    # #328 moved this VALUE (DEC-2) and not the rung: two real vendor labels still answer rung 2,
    # now framed injectively. It is the one shipped id-format change on this branch and it is
    # asserted end to end, on the artifact, rather than only on the helper.
    assert meta["coordinate_space"] == "xenium:slide_id+region_name:7:Slide_1|14:hKidney_sample|"
