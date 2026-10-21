#!/usr/bin/env python3
# ruff: noqa
"""#163 — the ragged-array claim, tested at the claim rather than around it.

TEST-1 [acceptance] [invariant: INV-1], TEST-2 [acceptance] [invariant: INV-2],
TEST-5 [acceptance] [invariant: INV-5], TEST-18 [covers: ITEM-15].

## What is actually under test

Design §6.4's headline, verbatim:

    any ragged per-entity structure can be encoded as a long table plus per-entity offset
    metadata-columns, with **zero framework change**.

The second half is the half that can fail, and it is the half a naive test would skip. An
encoding test alone passes just as happily on a tree where `_lib/conformance.py` grew two
`_AUX_ROLES` entries to make the artifact legal — which is precisely the cost §6.4 claims
to avoid. So TEST-1 asserts BOTH: the ragged set round-trips through the framework's own
conformance gate, AND the framework's bytes are identical to `origin/main`.

## Why the subject is real vendor data

Measured over the two real full-size Xenium bundles available: 99.98% of cells have exactly
13 vertices. A fixture built by sampling them uniformly is #75's failure exactly — every
case identical, the ragged path never exercised — so the fixture builder takes the RAREST
lengths first and the 6-, 7- and 8-vertex cells are in it. Asserted below, not assumed.
"""
import sys
from pathlib import Path

import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

_PACKAGES = Path(__file__).resolve().parents[2]
# A TREE-scoped root, resolved by walking up from this file. Deliberately NOT
# `zero_core_guard.repo_root()`: that function SKIPS outside a git checkout, which is the
# right behaviour for a branch-diff guard and exactly wrong for a tree assertion — its own
# docstring says so ("a TREE-scoped assertion must not route through this function at all").
_REPO_ROOT = _PACKAGES.parents[1]
# `_REPO` used to live here, resolved by a `parents[N]` walk and handed to `subprocess`
# for the two branch-diff legs. Those legs now go through `zero_core_guard`, which resolves
# the checkout root with `git rev-parse --show-toplevel` and SKIPS honestly outside a git
# checkout rather than pointing a diff at a directory that may not be the repository.
_LIB = _PACKAGES / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import require_introducing_file  # noqa: E402

#: The marker that arms the two BRANCH-DIFF guards in this module — the producer module
#: #163 introduces, and the file whose existence IS the new producer. It is deliberately
#: NOT this package's `manifest.yaml`: #162 added that, so a manifest-keyed gate would skip
#: on the one branch these guards describe, and a guard that can no longer fail at all is a
#: worse defect than the one being repaired (`derived-guards.md` §1). This is the same
#: marker the sibling guard in this directory (`test_zero_src_app_diff_boundaries.py`)
#: already uses for the same branch, read from that module rather than re-spelled, so the
#: two cannot drift about which branch they belong to.
from test_zero_src_app_diff_boundaries import INTRODUCED  # noqa: E402


@pytest.fixture(scope="module")
def encoded():
    """The REAL vendor lung polygons, through the REAL shipped encoder."""
    BD = XF.load_boundaries_module()
    rings, order = XF.expected_rings(XF.REAL_LUNG_BOUNDARIES)
    enc = BD.read_boundaries(XF.REAL_LUNG_BOUNDARIES, order)
    return {"BD": BD, "rings": rings, "order": order, "encoded": enc,
            "entity": enc["entity"], "x": enc["x"], "y": enc["y"],
            "start": enc["start"], "count": enc["count"], "stats": enc["stats"]}


def _write_through_the_shipped_writer(encoded, tmp_path):
    """`BD.write_boundaries` — the REAL writer, never a re-spelling of it here.

    The first cut of this file built its own `cyto_zarr.Table` with the member names typed
    out again as literals. That proved `cyto_zarr` can write three members with those names;
    it proved nothing about the producer, and renaming `BD.X_MEMBER` left the entire suite
    green — while `boundaries.py` claimed in a comment that a drift from the declaration
    would go red. A blind audit found it. Driving the shipped writer is what makes the
    member-name and dtype assertions below actual producer-conformance checks.
    """
    BD = XF.load_boundaries_module()
    SD = XF._load_by_path("spatial_declarations",
                          XF.PKG / "compute" / "spatial_declarations.py")
    space = SD.coordinate_space(space="fixture-space", unit="micrometre",
                                to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0])
    structure, _meta = BD.write_boundaries(
        tmp_path, "spatial/boundaries.zarr", encoded,
        space=space, series=SD.section(sample_id="fixture", index=0),
    )
    return structure


#: The LANDED declaration this producer conforms to. ONE spelling of that path in this
#: module, so `_declared_kind()` and `DECLARATION_PREFIX` below cannot come to name two
#: different packages — which is exactly what a blind audit produced by repointing a
#: hand-written prefix at `qc/` while the reader kept reading `spatial-types`.
DECLARATION_MANIFEST = _PACKAGES / "spatial-types" / "manifest.yaml"


def _declared_kind():
    """`spatial/boundaries` as the LANDED manifest declares it — read, never hardcoded."""
    doc = yaml.safe_load(DECLARATION_MANIFEST.read_text())
    for dt in doc["contributes"]["datatypes"]:
        if dt["id"] == "spatial/boundaries":
            return dt
    raise AssertionError("`spatial/boundaries` is not declared in spatial-types")


# ───────────────────────────── TEST-1 (INV-1) ────────────────────────────────────────


def test_a_ragged_polygon_set_encodes_with_zero_framework_change(encoded, tmp_path):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-6, ITEM-15].

    §6.4: *"any ragged per-entity structure can be encoded as a long table plus per-entity
    offset metadata-columns, with zero framework change."*

    Three legs, and the invariant needs all three:

      1. the subject really is RAGGED (if every cell had the same vertex count the claim
         would be untested — this is the #75 anti-vacuity leg);
      2. the encoded store passes the FRAMEWORK'S OWN gate, `conformance.conform_artifact`,
         with zero findings — not a hand-rolled check of the shape this test just built;
      3. **the three framework modules the encoding runs through, and the landed
         declaration, are byte-identical to `origin/main`.** Stated exactly, because the
         first wording said "the framework is BYTE-IDENTICAL" and that is FALSE on this
         branch as written — `_lib/manifest.yaml` and `_lib/model_coverage_exempt.json` DO
         move here (a producer-register row the model-coverage guard demands), and a blind
         angle caught the docstring overclaiming while the test was green. What INV-1's
         "zero framework change" actually means is that the ENCODING needed no framework
         edit: no `_AUX_ROLES` entry, no writer change, no conformance change, no change to
         the declaration. Flip this leg off and the test would still pass on a tree where
         `_AUX_ROLES` grew the two entries §6.4 exists to avoid.
    """
    import conformance
    import cyto_zarr

    counts = encoded["count"]
    present = counts[counts > 0]
    assert present.min() < present.max(), (
        "the fixture is not ragged — every cell has the same vertex count, so the claim "
        "under test is not exercised at all"
    )
    assert int(present.min()) <= 8, (
        f"the fixture's shortest polygon has {int(present.min())} vertices; the rare short "
        "rings are what the ragged path is FOR, and a fixture without them is blind by "
        "construction (the #75 lesson)"
    )

    structure = _write_through_the_shipped_writer(encoded["encoded"], tmp_path)
    dest = tmp_path / "spatial" / "boundaries.zarr"

    findings = conformance.conform_artifact(dest, structure, full=True)
    assert findings == [], (
        "the framework's own conformance gate refused the long vertex table:\n"
        + "\n".join(f"  - {f}" for f in findings)
    )

    # TEST-11 — this test stays UNGATED and runs on every branch. Only leg 3 moved.
    # LEG 3 used to sit here. It is now `test_the_encoding_needed_no_framework_edit` below,
    # for the reason #265 gives: it is the only leg of this test that is about a BRANCH DIFF
    # rather than about the encoding, so it is the only leg that has to be scoped to the
    # branch that can prove it. Legs 1, 2 and the `aux` assertion below are properties of the
    # SHIPPED ENCODER and run on every branch, unchanged.

    # The `inspect.getsource(conformance)` check that used to sit here is GONE: it was
    # fully subsumed by the byte-identity diff of that same file, and a second assertion
    # over the same bytes is coverage inflation, not coverage.
    assert "aux" not in structure, (
        f"the emitted table declares `aux` members ({structure.get('aux')}). §6.4's whole "
        "finding is that the ragged shape needs NO aux member and therefore no "
        "`_AUX_ROLES` edit; declaring one puts that edit back on the critical path."
    )


#: The framework files whose bytes INV-1's "with zero framework change" is a claim ABOUT.
#: An ENUMERATION on purpose, never a prefix: `_lib/` also carries `manifest.yaml` and
#: `model_coverage_exempt.json`, which #163 DOES move, so a prefix rule would either forbid
#: those (falsely) or silently pardon a real `conformance.py` edit riding alongside them.
FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH = (
    "src-app/packages/_lib/conformance.py",
    "src-app/packages/_lib/cyto_zarr.py",
    "src-app/packages/_lib/cyto_columns.py",
    "src-app/packages/spatial-types/manifest.yaml",
)

#: The landed declaration this producer conforms TO, never the other way round (DEC-12) —
#: DERIVED from the manifest `_declared_kind()` actually reads, so the guard and the thing it
#: guards cannot name two different packages. A blind audit repointed the hand-written prefix
#: at `qc/` and every test stayed green: the guard then claimed a completely different
#: package while its control only checked that the directory exists.
DECLARATION_PREFIX = (
    DECLARATION_MANIFEST.parent.relative_to(_REPO_ROOT).as_posix() + "/"
)


def _framework_files_that_moved(changed):
    """Which of the framework files this encoding runs through appear in `changed`."""
    return [q for q in FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH if q in changed]


def _declaration_paths_that_moved(changed):
    """Which paths under the landed declaration appear in `changed`."""
    return sorted(q for q in changed if q.startswith(DECLARATION_PREFIX))


def test_the_two_branch_scoped_subjects_are_real_paths_and_the_predicates_are_not_VACUOUS():
    """TEST-11 [acceptance] [invariant: INV-3] — the control the two gated guards below need.

    ## Why this exists, stated plainly

    `compute/boundaries.py` and `spatial-types/manifest.yaml` both already exist on
    `origin/main`, so `--diff-filter=A` can never contain the marker again: the arming
    shape for the two guards below is not constructible on any branch cut from main. That
    is correct scoping (`derived-guards.md` §3) and it has a cost the first cut of this
    change did not pay — those two assertion BODIES then run nowhere at all, and a blind
    audit proved it by pointing `FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH[0]` at a file
    that does not exist and setting the declaration prefix to a package that does not
    exist. Both mutations left the whole suite green. A guard that can no longer fail is a
    worse defect than the false red it replaced (#274/#286), and "self-limiting" must not
    become "self-disabling" — §6's INV-4 says a self-limiting guard still fails loudly
    where its premise holds.

    So this test runs UNGATED, on every branch, and pins the two things the gate cannot:
    the subjects are REAL paths in this tree, and each predicate actually reports a path it
    is supposed to report and stays quiet about one it is not. It does not re-assert the
    branch property — that is the gated guards' job, and asserting it here would be the
    unscoped defect all over again.
    """
    assert FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH, (
        "the framework file list is EMPTY, so `test_the_encoding_needed_no_framework_edit` "
        "ranges over nothing and cannot fail for any branch. Its sibling in "
        "`test_rootfs_unchanged.py` asserted this from the start; a blind audit found this "
        "one did not, and emptying the tuple left the whole suite green."
    )
    for rel in FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH:
        assert (_REPO_ROOT / rel).is_file(), (
            f"`{rel}` is named as a framework file INV-1's claim is about, but no such "
            f"file exists. A subject that names nothing cannot be violated, so the guard "
            f"below would pass on a branch that edited the real file."
        )
    assert (_REPO_ROOT / DECLARATION_PREFIX).is_dir(), (
        f"`{DECLARATION_PREFIX}` is named as the landed declaration but is not a directory "
        f"in this tree; the guard below would then pass whatever a branch did to it."
    )

    # Each predicate reports what it must, and only what it must.
    for rel in FRAMEWORK_FILES_THE_ENCODING_RUNS_THROUGH:
        assert _framework_files_that_moved([rel]) == [rel]
    assert _framework_files_that_moved(["src-app/packages/qc/manifest.yaml"]) == []
    assert _framework_files_that_moved([]) == []

    inside = f"{DECLARATION_PREFIX}manifest.yaml"
    assert _declaration_paths_that_moved([inside]) == [inside]
    assert _declaration_paths_that_moved(["src-app/packages/spatial-types-other/x.py"]) == []
    assert _declaration_paths_that_moved([]) == []


def test_the_encoding_needed_no_framework_edit():
    """TEST-1 leg 3 [acceptance] [invariant: INV-1] — the half of the claim that is a DIFF.

    §6.4's headline is *"…can be encoded as a long table plus per-entity offset
    metadata-columns, with **zero framework change**"*, and the second half is the half a
    naive test would skip: the encoding legs above pass just as happily on a tree where
    `_lib/conformance.py` grew two `_AUX_ROLES` entries to make the artifact legal, which is
    precisely the cost §6.4 claims to avoid.

    ── WHY IT IS SCOPED, AND WHY THE MARKER IS `compute/boundaries.py` (#265) ────────────
    "Zero framework change" is a statement about ONE BRANCH's diff. Unscoped it re-executed
    on every later branch and asserted that stranger's diff also left `spatial-types/` and
    those three `_lib` modules alone — so every branch touching the OME-TIFF writer, whose
    source of truth #162 deliberately promoted INTO `spatial-types/`, went red on a guard
    about a claim it was not making. Worse, `check-processor-seed-versions.sh` REQUIRES a
    `spatial-types/manifest.yaml` version bump the moment any file in that package moves, so
    the two shipped gates were mutually unsatisfiable for such a branch — one demanded the
    manifest move and the other forbade it.

    The marker is `compute/boundaries.py`, not this package's `manifest.yaml`: #162 added the
    manifest, so a manifest-keyed gate would skip on #163's branch and this assertion would
    never run at all. Self-limiting must not become self-disabling (#274/#286).

    It is also re-pointed from `git diff origin/main` (two dots — the MOVING TIP) to the
    merge base, which is what every other guard in this tree compares against and what this
    package's siblings already record paying for: measuring against a moving ref made guards
    "fail over commits the branch has nothing to do with" after main moved 58 commits.

    ONE THING IS TRADED, and it is recorded rather than claimed away. The two-dot form
    compared the WORKING TREE, so it also failed on an UNCOMMITTED edit; `changed_paths` is
    `merge-base…HEAD`, i.e. committed-only. An earlier draft of this paragraph said "the
    assertion itself is unweakened", which overstated, and a blind audit said so. The trade is
    accepted because the working-tree reach came bundled with the moving-tip comparison that
    made this guard unsatisfiable for any branch touching the writer, and because the merge-base
    form is what every other guard in this tree uses. The allow-set is unchanged and no path
    left the subject — the reach over COMMITTED state is identical.
    """
    _root, changed = require_introducing_file(INTRODUCED, __file__)
    assert _framework_files_that_moved(changed) == [], (
        f"{_framework_files_that_moved(changed)} moved on this branch. INV-1's claim is "
        "'with ZERO framework change'; an encoding that needed the framework moved is a "
        "different claim, and this branch would be reporting a result it did not get."
    )


# ───────────────────────────── TEST-2 (INV-2) ────────────────────────────────────────


def test_the_offsets_are_metadata_columns_and_the_slice_recovers_the_vendors_own_polygon(
        encoded, tmp_path):
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-7].

    §6.4: *"Emit `boundary_vertex_start` and `boundary_vertex_count` as ordinary
    `metadata-column` artifacts … which are 1-D over `cells`, carry `aligned_to`, and are
    conformance-checked like every other column. A consumer reads `[start, start+count)`
    out of the vertex table."*

    Both halves are asserted, and the CONSUMER half is asserted against the vendor's own
    decimal text rather than against the encoder's output: for every cell, the slice must
    hold exactly the vertices the vendor wrote for that cell, in the vendor's own order, at
    the declared `float32`. An off-by-one, a cumulative-`indptr` mistake, or a stable-sort
    regression each turn this red.
    """
    import conformance
    import cyto_columns
    import pandas as pd

    BD, rings, order = encoded["BD"], encoded["rings"], encoded["order"]
    start, count = encoded["start"], encoded["count"]
    keys = pd.Series([str(k) for k in order])
    aligned_to = cyto_columns.axis_key_digest(keys)

    written = {}
    for name, values in ((BD.START_COLUMN, start), (BD.COUNT_COLUMN, count)):
        rel = f"metadata/{name}.zarr"
        structure, meta = cyto_columns.write_metadata_column(
            tmp_path, rel, name, pd.Series(np.asarray(values, dtype=np.int64)),
            axis="cells", aligned_to=aligned_to,
        )
        written[name] = (structure, meta, tmp_path / rel)

    for name, (structure, _meta, path) in written.items():
        assert structure["axis"] == "cells", (
            f"{name} declares axis {structure['axis']!r}; §6.4 says the offsets are 1-D "
            "over the ENTITY axis, which is what makes them ordinary columns"
        )
        assert structure["aligned_to"] == aligned_to, (
            f"{name} carries no/`{structure.get('aligned_to')}` `aligned_to` — the design "
            "names carrying it as one of the three properties that make these ordinary"
        )
        assert len(structure["columns"]) == 1, (
            f"{name} has {len(structure['columns'])} members; a `metadata-column` holds one"
        )
        findings = conformance.conform_artifact(path, structure, full=True)
        assert findings == [], (
            f"{name} did not pass the framework's gate — the design's claim is that these "
            f"are 'conformance-checked like every other column':\n{findings}"
        )
        assert "aux" not in structure, (
            f"{name} was written as an aux member; the design's whole point is that it is "
            "NOT one"
        )

    # THE CONSUMER HALF — `[start, start + count)`, against the VENDOR'S OWN TEXT.
    x, y = encoded["x"], encoded["y"]
    checked = 0
    for i, cid in enumerate(order):
        s, k = int(start[i]), int(count[i])
        expected = rings[cid]
        assert k == len(expected), (
            f"cell {cid!r}: count says {k} vertices, the vendor wrote {len(expected)}"
        )
        got_x, got_y = x[s:s + k], y[s:s + k]
        want_x = np.asarray([float(vx) for vx, _ in expected], dtype=np.float32)
        want_y = np.asarray([float(vy) for _, vy in expected], dtype=np.float32)
        assert np.array_equal(got_x, want_x) and np.array_equal(got_y, want_y), (
            f"cell {cid!r}: `[start, start+count)` does not hold the vendor's own vertices "
            f"in the vendor's own order.\n  got  x={got_x[:4]} y={got_y[:4]}\n"
            f"  want x={want_x[:4]} y={want_y[:4]}"
        )
        checked += 1
    assert checked >= 100, f"only {checked} cells checked — the loop found no subject"


# ───────────────────────────── TEST-5 (INV-5) ────────────────────────────────────────


def test_the_emitted_table_is_the_declared_kind_in_long_format(encoded, tmp_path):
    """TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-6, ITEM-15].

    §6.4: *"Polygon boundaries in long format — one row per vertex, ordered within each
    entity — over a `vertex` axis. Per-entity slices are addressed through sibling offset
    columns on the entity axis, so no ragged-array structure is required."*

    The shape is read OUT OF THE LANDED DECLARATION rather than restated here, so a
    producer that drifted from `spatial-types/manifest.yaml` goes red instead of a
    hardcoded copy of the drift going green.
    """
    declared = _declared_kind()
    assert [a["name"] for a in declared["axes"]] == ["vertex"]
    assert declared["entity_axis"] == "vertex"
    assert declared["storage"]["layout"]["kind"] == "columnar_table"
    declared_attrs = {a["name"]: a["dtype"] for a in declared["arrays"][0]["attrs"]}

    structure = _write_through_the_shipped_writer(encoded["encoded"], tmp_path)

    assert structure["axis"] == "vertex"
    assert structure["n"] == int(encoded["entity"].shape[0])
    BD = XF.load_boundaries_module()
    assert {BD.ENTITY_INDEX_MEMBER, BD.X_MEMBER, BD.Y_MEMBER} == set(declared_attrs), (
        f"the producer's member constants {(BD.ENTITY_INDEX_MEMBER, BD.X_MEMBER, BD.Y_MEMBER)}"
        f" are not the declaration's attrs {sorted(declared_attrs)} — a rename on either side"
    )
    emitted = {c["path"]: c["dtype"] for c in structure["columns"]}
    assert set(emitted) == set(declared_attrs), (
        f"the store's members {sorted(emitted)} are not the declared attrs "
        f"{sorted(declared_attrs)}"
    )
    for name, dtype in declared_attrs.items():
        want = {"i64": "int64", "f32": "float32"}.get(dtype, dtype)
        assert emitted[name] == want, (
            f"member {name!r} is {emitted[name]}, the declaration says {dtype} ({want})"
        )

    # LONG FORMAT, ORDERED WITHIN EACH ENTITY — the two properties that make the offsets a
    # SLICE rather than a gather, asserted directly on the emitted column.
    entity = encoded["entity"]
    assert entity.shape[0] == sum(len(v) for v in encoded["rings"].values()), (
        "the table does not hold one row per vertex"
    )
    assert np.all(np.diff(entity) >= 0), (
        "entity_index is not non-decreasing, so a cell's vertices are not contiguous and "
        "`[start, start+count)` is not the cell's polygon"
    )
    starts = encoded["start"]
    assert np.all(np.diff(starts) >= 0), "the offsets are not monotonic"
    assert int(starts[-1] + encoded["count"][-1]) == entity.shape[0], (
        "the last entity's slice does not end at the table length — the offsets and the "
        "table disagree about how many vertices there are"
    )


# ───────────────────────────── TEST-18 (ITEM-15) ─────────────────────────────────────


def test_the_landed_declaration_was_not_moved_to_fit_the_producer():
    """TEST-18 [covers: ITEM-15] — `spatial-types` is untouched, version included.

    DEC-12: the producer conforms to the declaration, never the other way round. If this
    branch had needed `spatial/boundaries` to change, design §6.4's landed form would be
    wrong and that is a REPORTABLE finding — so it is a test rather than a note, and a
    silent manifest edit cannot pass it.

    ── SCOPED, FOR THE REASON IN #265 ───────────────────────────────────────────────────
    "This branch did not move the declaration" is a claim about ONE branch. Unscoped it
    asserted it of every later branch, and `spatial-types/compute/ome_writer.py` is the
    SOURCE OF TRUTH for the OME-TIFF writer (#162 promoted it there so both importers vendor
    from one place) — so every fix to the writer necessarily edits `spatial-types/` and
    reddened this. #227 (`tile=(512,512)`) is the first that structurally could not land
    while it stood. The premise is now derived from the diff (the ADD of
    `compute/boundaries.py`, #163's producer) and the guard skips visibly everywhere else.
    The comparison also moves from the two-dot moving `origin/main` tip to the merge base,
    which trades working-tree reach for committed-only reach — stated in
    `test_the_encoding_needed_no_framework_edit` above and not repeated here. Over committed
    state the assertion is unchanged: on #163's branch it still refuses the ENTIRE directory.
    """
    _root, changed = require_introducing_file(INTRODUCED, __file__)
    moved = _declaration_paths_that_moved(changed)
    assert moved == [], (
        f"this branch edited `{DECLARATION_PREFIX}`: {moved}. The declaration landed in "
        "#152 and is what every downstream consumer reads; a producer moving its own "
        "contract is exactly the reframing the design source exists to prevent.")
