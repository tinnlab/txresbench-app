#!/usr/bin/env python3
# ruff: noqa
"""Staging + read-back machinery for the `spatial.import-xenium` suites.

## Why this module is named after its package

Non-`test_*.py` files in a `tests/` dir are imported by BARE NAME, so a `fixtures.py` here
would collide with every other package's copy of the same name — the
`--import-mode=importlib` setting in `packages/pytest.ini` gives path-unique names to
`test_*.py` modules ONLY. `spatial-import-visium` and `embedding` solved the same problem
the same way; this follows them.

## THE FIXTURES ARE REAL VENDOR DATA, AND THERE ARE TWO OF THEM

Both are 10x Genomics "tiny outs" bundles, reduced to the files this importer reads and
otherwise BYTE-FOR-BYTE the vendor's own — no re-encoding, no cropping, no synthesis. A
synthetic fixture would prove only that this parser reads its own writer.

| | `xenium-prime-outs` | `xenium-protein-outs` |
|---|---|---|
| bundle | `Xenium_Prime_Mouse_Ileum_tiny_outs` | `Xenium_V1_Protein_Human_Kidney_tiny_outs` |
| XOA | 3.0.0.15 | 4.0.0.19 |
| cells | 23 | 358 |
| features | 13,780 (6 classes) | 520 (6 classes, incl. Protein Expression) |
| segmentation | ONE method (5.0 um nucleus expansion) | THREE methods in one run |
| `morphology_focus` | `YX`, 5-level pyramid, ONE file | `CYX`, 12 channels across TWELVE files |
| `slide_id`/`region_name` | placeholders (`slide`/`region`) | real (`Slide_1`/`hKidney_sample`) |
| `library_ids` | `0000000_0000000` | `0000000_0000000` (identical — DEC-7's evidence) |

**They disagree on every axis this importer branches on**, which is the point: one bundle
would let a Visium-shaped assumption survive. Both also carry `morphology.ome.tif` (`ZYX`,
11 focal planes) in the prime case, which is the third image shape.
"""
import importlib.util
import json
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
FIXTURES = PKG / "tests" / "fixtures"
PRIME = FIXTURES / "xenium-prime-outs"
PROTEIN = FIXTURES / "xenium-protein-outs"
COMPUTE = PKG / "compute" / "import_xenium.py"

#: The fixtures' own numbers, ASSERTED rather than assumed by `test_producer_end_to_end`.
#: A fixture that quietly changed would disarm the tests that rest on it while every one of
#: them stayed green.
PRIME_XOA = "xenium-3.0.0.15"
PROTEIN_XOA = "xenium-4.0.0.19"
PIXEL_SIZE_UM = 0.2125
#: The placeholder BOTH bundles write, which is why the coordinate space cannot come from it.
PLACEHOLDER_LIBRARY_ID = "0000000_0000000"


def origin_main_text(relpath: str):
    """Return `(text, None)` or `(None, skip_reason)` for `origin/main:<relpath>` via `git show`.

    The ONE shared piece of the #437 structural fix: both manifest-bump guards derive their
    version floor and their append-only history check from `origin/main`'s own manifest text,
    and a second hand-written copy of this plumbing is exactly the "a guard that enumerates
    today's sites is a reminder, not a check" shape (#336) this fix exists to remove. The
    parsing (splitting out the `version:` line, the head regex) stays inline in each test —
    the two tests ask genuinely different questions; only the git-show plumbing is shared.

    `origin/main` may not be fetched in a given checkout — that is a property of the checkout,
    not of the branch — so the caller is expected to `pytest.skip(reason)` when the second
    element is not `None`, never to fail. The skip is NARROW: only a `git show` failure whose
    stderr names an unknown ref (`fatal: invalid object name 'origin/main'.`, or `unknown
    revision` on some git versions) is treated as "not fetched". Any OTHER failure — a typo'd
    relpath, a file moved or renamed on `origin/main` — raises `AssertionError` instead,
    because silently skipping on it would disarm BOTH manifest-bump guards on a one-character
    typo, the exact "guard that can be disarmed by a typo" shape #336 warns against. `git`
    emits the blob as UTF-8 BYTES regardless of
    locale, but the caller must still tell `subprocess` to DECODE those bytes as UTF-8
    (`encoding="utf-8"`): with `text=True` and no `encoding=`, Python decodes the captured
    stdout with the locale's preferred encoding, so under a hostile/ASCII locale (`LC_ALL=C`)
    the em dashes in the changelog raise `UnicodeDecodeError` — the same locale-default
    decode defect class as #333/#339/#330. This is a non-`test_*` helper, so the branch-diff
    sweep
    (`_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`)
    does not flag it — only `test_*` entry points and module-scope reads are offenders, and a
    private helper that reads history is the legitimate shape its own docstring names.
    """
    import subprocess

    # `PKG` is `<repo>/src-app/packages/spatial-import-xenium`, so `parents[2]` is the repo
    # root — the `cwd` `git show` must run from.
    shown = subprocess.run(
        ["git", "show", f"origin/main:{relpath}"],
        cwd=str(PKG.parents[2]), capture_output=True, encoding="utf-8")
    if shown.returncode != 0:
        stderr = shown.stderr.strip()
        # Discriminate by WHAT git said, not by the bare return code. A genuinely
        # unfetched/unknown ref says `fatal: invalid object name 'origin/main'.` (verified on
        # this box; some git versions say `unknown revision`); a valid ref with a bad path
        # says `fatal: path '...' does not exist in 'origin/main'`. Only the FIRST shape is
        # an environment property worth skipping — any other failure (a typo'd relpath, a
        # moved/renamed file) is a bug in this guard's own plumbing and must fail loudly,
        # because a skip would silently disarm BOTH manifest-bump guards (#336).
        if "invalid object name" in stderr or "unknown revision" in stderr:
            return None, f"`origin/main` is not fetched in this checkout: {stderr}"
        raise AssertionError(
            f"`git show origin/main:{relpath}` failed for a reason other than an unfetched "
            f"`origin/main`: {stderr}")
    return shown.stdout, None


def package_touched_since_origin_main() -> bool:
    """Does THIS branch's `HEAD` differ from `origin/main` under this package's directory?

    A `git diff --name-only origin/main...HEAD -- <this package>` call, exactly the shape
    `origin_main_text` above already uses for `git show` — a non-`test_*` helper, so the
    branch-diff sweep (`_lib/test_zero_core_guard.py::
    test_no_package_test_reads_a_branch_diff_without_a_scope_gate`) does not flag it, for the
    same reason `origin_main_text` is not flagged: only `test_*` entry points and module-scope
    reads in a package's OWN test files are offenders, and a private helper that reads history
    is the legitimate shape that sweep's own docstring names. Used by the #530 fix to the
    manifest-bump guards' version floor: the strict `>` is required only when the branch
    genuinely touches the package; when it does not, there is nothing for that half of the
    guard to check, so the caller SKIPS rather than asserting anything about a version
    relationship it has no basis to demand (#530, audit round 2's S1: asserting `>=` in that
    case wrongly reddens a branch that is simply behind `origin/main` and never touched this
    package at all). The `git diff` call passes `encoding="utf-8"` like `origin_main_text`'s
    `git show` — git can emit non-ASCII pathnames, and a locale-default decode would raise
    under `LC_ALL=C`.

    Returns `True`/`False`. Any `git diff` failure OTHER than the ordinary "differences exist"
    outcome raises — this function is only ever called after `origin_main_text` has already
    succeeded without a skip, so `origin/main` is known to be a fetched, valid ref at this
    point, and `git diff` between two valid refs cannot fail for "unknown ref" reasons.
    """
    import subprocess

    # `PKG` is `<repo>/src-app/packages/spatial-import-xenium`, so `parents[2]` is the repo root.
    package_relpath = str(PKG.relative_to(PKG.parents[2]))
    diff_proc = subprocess.run(
        ["git", "diff", "--name-only", "origin/main...HEAD", "--", package_relpath],
        cwd=str(PKG.parents[2]), capture_output=True, encoding="utf-8")
    assert diff_proc.returncode == 0, (
        f"git diff origin/main...HEAD -- {package_relpath} failed unexpectedly: "
        f"rc={diff_proc.returncode} stderr={diff_proc.stderr!r}")
    return bool(diff_proc.stdout.strip())


def _load_by_path(name, path):
    """Load one module from an exact PATH, ignoring `sys.path` entirely."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_compute():
    """Import `compute/import_xenium.py` the way the sandbox stages it.

    ## Why this binds the helpers BY PATH instead of by `sys.path`

    In production the sandbox assembles ONE `/code` dir holding the entry plus the files
    `run.helpers` declares, so `import spatial_declarations` is unambiguous: there is
    exactly one such file and it is the vendored copy. A pytest process is not that dir — it
    imports out of the source tree, where `spatial-types` AND `spatial-import-visium` both
    ship files of the same name, and whichever suite runs first wins `sys.modules` for the
    whole session.

    That is not hypothetical: `spatial-import-visium`'s own fixtures module records hitting
    exactly this, where putting `compute/` on `sys.path` PASSED alone and FAILED under
    `just check-py`, resolving `SD` to another package's copy — so the byte-identity test
    would have been asserting about a module this package does not ship.

    So each vendored copy is loaded from its own path and INSTALLED under the bare name
    before the entry runs, which reproduces `/code` exactly. Order matters: `ome_writer`
    imports `spatial_declarations`, and `xenium_image` imports `ome_writer`.
    """
    _load_by_path("spatial_declarations", PKG / "compute" / "spatial_declarations.py")
    _load_by_path("ome_writer", PKG / "compute" / "ome_writer.py")
    _load_by_path("xenium_image", PKG / "compute" / "xenium_image.py")
    # #163's helper, installed under its bare name for the same reason as the three above:
    # `/code` holds exactly one `boundaries.py` and the entry imports it unqualified.
    _load_by_path("boundaries", PKG / "compute" / "boundaries.py")
    # #301's helper — design §7.5's registration QC overlay. Same reasoning again, and with a
    # sharper edge than the others: `spatial-import-visium` ships a file of this EXACT name,
    # so under `sys.path` resolution whichever suite ran first would win `sys.modules` and
    # this package's entry could end up driving the SIBLING's overlay — which measures a
    # Visium slide's spot pitch and scores against an `in_tissue` flag Xenium does not have.
    # Binding by path is what makes "the module this package ships" the module under test.
    _load_by_path("registration_qc", PKG / "compute" / "registration_qc.py")
    return _load_by_path("spatial_import_xenium_entry", COMPUTE)


def run_over(bundle_root, outputs_dir):
    """Drive the REAL compute over `bundle_root`, returning `(module, entries)`.

    This calls the shipped `run_import`, not a re-implementation of it — a test that
    reproduces the importer's logic proves only that the reproduction agrees with itself.
    """
    module = load_compute()
    entries = module.run_import(Path(bundle_root), Path(outputs_dir))
    return module, entries


def entry(entries, output_id):
    """The one manifest entry with this id, or a clear failure."""
    matches = [e for e in entries if e["id"] == output_id]
    assert len(matches) == 1, (
        f"expected exactly one output id {output_id!r}, found "
        f"{[e['id'] for e in entries]}"
    )
    return matches[0]


def experiment(bundle_root):
    import json
    return json.loads((Path(bundle_root) / "experiment.xenium").read_text())


def cells_table(bundle_root):
    """`cells.csv.gz` as `(header, rows-of-strings)` — the vendor's own text, unparsed."""
    import csv
    import gzip
    with gzip.open(Path(bundle_root) / "cells.csv.gz", "rt", newline="") as fh:
        rows = list(csv.reader(fh))
    return [c.strip() for c in rows[0]], rows[1:]


def expected_xy(bundle_root, cell_ids):
    """The vendor's own centroids, in `cell_ids` order, cast to float32.

    Parsed here from the RAW TEXT so a bit-exactness assertion compares the importer's
    output against the vendor's file rather than against another copy of the importer.
    """
    import numpy as np
    header, rows = cells_table(bundle_root)
    ix, iy, iid = header.index("x_centroid"), header.index("y_centroid"), header.index("cell_id")
    by_id = {r[iid]: r for r in rows}
    xs = np.asarray([float(by_id[c][ix]) for c in cell_ids], dtype=np.float32)
    ys = np.asarray([float(by_id[c][iy]) for c in cell_ids], dtype=np.float32)
    return xs, ys


def matrix_cell_ids(bundle_root):
    import h5py
    with h5py.File(Path(bundle_root) / "cell_feature_matrix.h5", "r") as f:
        return [b.decode() for b in f["matrix/barcodes"][:]]


# ── #163: the boundaries arm ─────────────────────────────────────────────────────────
#
# THE TWO FIXTURE BUNDLES ABOVE HAVE NO BOUNDARIES FILE AT ALL, and that is left exactly
# as it is. Their absence is not a gap this module papers over — it is the case
# `test_boundaries_absence.py` needs (a bundle with no `cell_boundaries.parquet` must emit
# nothing rather than empty artifacts), and every existing test in this package keeps
# running against byte-identical bundles.
#
# The boundaries arm is a STAGED COPY instead: the prime bundle plus one
# `cell_boundaries.parquet` dropped in. That file's vertices are REAL 10x vertex values
# lifted verbatim from a real vendor `cell_boundaries.csv.gz` — see
# `fixtures/boundaries/build_boundaries_fixtures.py` for exactly which rows and what was
# NOT done to them (no translation, no rescaling, no re-closing). What it is NOT is a
# vendor-AUTHORED parquet: none exists on the machine this was built on, and that gap is
# narrowed — not closed — by `test_boundaries_reader.py`, which points the same reader at a
# real vendor-written `cells.parquet`.

BOUNDARY_FIXTURES = FIXTURES / "boundaries"
#: Real vendor vertices under the PRIME bundle's own cell ids, for the end-to-end arm.
PRIME_STAGED_BOUNDARIES = BOUNDARY_FIXTURES / "prime-staged.parquet"
#: Real vendor ids AND vertices, string (`binary`) ids — the design-invariant subject.
REAL_LUNG_BOUNDARIES = BOUNDARY_FIXTURES / "real-lung.parquet"
#: Real vendor ids AND vertices, INTEGER (`int32`) ids — the second vendor rendering.
REAL_BREAST_BOUNDARIES = BOUNDARY_FIXTURES / "real-breast.parquet"


def stage_bundle(tmp_path, source=None, *, boundaries=None, name="staged-outs"):
    """A COPY of a fixture bundle, optionally with a `cell_boundaries.parquet` added.

    Copied rather than mutated in place: a test that writes into `tests/fixtures/` dirties
    tracked vendor bytes for every other suite in the process, and a `Ctrl-C` leaves them
    dirty. The same reasoning `_digest_of` in the rootfs guard spells out.
    """
    import shutil
    root = Path(tmp_path) / name
    shutil.copytree(Path(source or PRIME), root)
    if boundaries is not None:
        shutil.copyfile(Path(boundaries), root / "cell_boundaries.parquet")
    return root


def _rewrite_cells_column(root, column, transform):
    """Rewrite ONE column of a staged bundle's `cells.csv.gz` in place.

    One spelling of the gzip-CSV round trip for the two stagers below, because they had it twice
    and the module they exercise carries the argument against that: *one predicate, every caller,
    no second spelling to drift*. A change to newline handling, quoting or header trimming is now
    one edit, not two.
    """
    import csv
    import gzip

    cells = Path(root) / "cells.csv.gz"
    with gzip.open(cells, "rt", newline="") as fh:
        rows = list(csv.reader(fh))
    index = [c.strip() for c in rows[0]].index(column)
    for row in rows[1:]:
        row[index] = transform(row[index])
    with gzip.open(cells, "wt", newline="") as fh:
        csv.writer(fh).writerows(rows)
    return Path(root)


def imported(tmp_path, root, name):
    """Drive the real import and return `(coordinates meta, report)` — the pair every declaration
    suite reads.

    Module level because two suites had it byte-identically and a third would have copied it: a
    second spelling of "which entry, which report filename" drifts the day either moves.
    """
    import json
    _module, entries = run_over(root, Path(tmp_path) / f"{name}-outs")
    meta = entry(entries, "spatial-coordinates")["meta"]
    report = json.loads((Path(tmp_path) / f"{name}-outs" / "xenium-import-report.json").read_text())
    return meta, report


def shift_centroids(root, dx):
    """Move every centroid by `dx` in x, leaving the CELL IDS untouched (#323).

    The other half of `restage_cell_ids`: two bundles that differ ONLY in geometry. The frame
    identity is derived from the run's MEASUREMENT — the ids and the positions — so a test that
    makes its two runs unrelated by restaging ids alone can never notice whether the positions half
    is wired at all. A blind tests-quality angle proved that gap by replacing the call site's
    `coords` with `np.zeros_like(coords)` with the whole package green.
    """
    return _rewrite_cells_column(root, "x_centroid", lambda v: repr(float(v) + dx))


def matrix_positions(bundle_root):
    """The bundle's own centroids as the importer joins them — `(N, 2)` float32, matrix id order.

    The second half of the derived frame identity (#323): `unverified_space_id` digests the cell
    ids AND the positions, so a unit test that drives it needs the same array `run_import` builds.
    Parsed from the vendor's own text here, exactly as `expected_xy` does, so a test comparing the
    two is comparing against the FILE and not against another copy of the importer.
    """
    import numpy as np
    xs, ys = expected_xy(bundle_root, matrix_cell_ids(bundle_root))
    return np.ascontiguousarray(np.stack([xs, ys], axis=1), dtype=np.float32)


def restage_cell_ids(root, suffix):
    """Give a staged bundle its OWN cell ids, in BOTH files that carry them (#323).

    Two staged copies of one fixture bundle are — correctly — the same measurement, so after #323
    they share a coordinate frame: the ladder's bottom rung is a digest of the vendor's own cell
    ids. A test that wants two UNRELATED runs therefore has to change the thing that makes them
    unrelated, and that is the matrix, not `experiment.xenium`.

    `/matrix/barcodes` and `cells.csv.gz`'s `cell_id` column are JOINED by the importer, so both
    move together or the import refuses. The suffix is injective and applied to every id, so ids
    stay mutually distinct inside the run and differ from the other run's.
    """
    import h5py
    import numpy as np

    root = Path(root)
    with h5py.File(root / "cell_feature_matrix.h5", "a") as handle:
        group = handle["matrix"]
        old = [b.decode() if isinstance(b, bytes) else str(b) for b in group["barcodes"][:]]
        renamed = [f"{o}{suffix}" for o in old]
        del group["barcodes"]
        group.create_dataset("barcodes",
                             data=np.array([r.encode() for r in renamed], dtype="S"))

    return _rewrite_cells_column(root, "cell_id", lambda v: f"{v}{suffix}")


def load_boundaries_module():
    """`compute/boundaries.py`, loaded by PATH for the reason `load_compute` gives.

    Installed under a SUFFIXED name, not the bare `boundaries`, so a test that monkeypatches
    a module constant (the ceiling, say) cannot reach through `sys.modules` and change the
    module the shipped entry imported — the two are separate objects on purpose.
    """
    return _load_by_path("xenium_boundaries_helper", PKG / "compute" / "boundaries.py")


def expected_rings(fixture_parquet):
    """`{cell_id: [(x_text, y_text), …]}` from the fixture's sidecar VENDOR TEXT.

    The sidecar is the vendor's own decimal rendering, written beside each fixture by the
    build script. Reading it here — rather than re-reading the parquet — is what makes a
    bit-exactness assertion compare the importer against the VENDOR rather than against
    another decode of the same file this code just wrote.
    """
    import csv
    rings = {}
    order = []
    with Path(fixture_parquet).with_suffix(".expected.csv").open(newline="") as fh:
        reader = csv.reader(fh)
        next(reader)
        for cid, x, y in reader:
            if cid not in rings:
                rings[cid] = []
                order.append(cid)
            rings[cid].append((x, y))
    return rings, order


# ── #343: the BYTES-capturing entrypoint driver ────────────────────────────────────────
#
# The refusal-escaping suite needs the SHIPPED ENTRY driven exactly as the sandbox drives it,
# with stdout/stderr captured as BYTES. `text=True` decodes, and decoding hides exactly the half
# of #343 that matters: a raw `\r` and a raw `\x07` survive into the `str` but are invisible to
# every assertion a reader would naturally write against a decoded string, and a raw `\n` becomes
# an ordinary newline indistinguishable from the message's own trailing one — and that raw `\n`
# IS the attack: `scheduler.rs::drain_logs` reads the compute's stderr with `BufReader::lines()`
# and writes EACH LINE as its own `job_logs` row, so a vendor-supplied newline forges a log row.
# The control characters ARE the payload, so the payload must not be decoded away before the
# assertion sees it.


def run_entry_bytes(bundle_root, outputs_dir, *, slot="bundle", env=None, timeout=1800):
    r"""Drive the SHIPPED ENTRY over `bundle_root`, capturing stdout/stderr as **BYTES** (#343).

    A subprocess and not an in-process call, because `main()`'s refusal path is `sys.exit(2)`
    and because the sandbox runs it exactly this way. The invocation is the spelling
    `test_hostile_bundle.py` already uses — `runpy.run_path(<compute/import_xenium.py>,
    run_name='__main__')` over the `TXR_INPUTS_DIR`/`TXR_OUTPUTS_DIR` seam — so there is ONE
    shape of the entrypoint in this package, not a second one that answers differently.

    `env` is merged over the inherited environment (after the two `TXR_*` variables and
    `PYTHONPATH` are set). `timeout=` matches this package's subprocess convention: a hung child
    should fail the suite, not hang it.
    """
    import subprocess

    argv, child = _entry_invocation(bundle_root, outputs_dir, slot, env)
    return subprocess.run(argv, capture_output=True, env=child, timeout=timeout)


def _entry_invocation(bundle_root, outputs_dir, slot, env):
    """The `/inputs` staging and the child environment the entrypoint driver uses.

    ONE spelling of the invocation, for the reason the visium sibling gives: a second copy is a
    driver that answers differently in two places, and the two would then differ in exactly the
    way that makes a refusal test prove nothing.
    """
    import os

    inputs = Path(outputs_dir).parent / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    (inputs / "params.json").write_text("{}")
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": slot, "kind": "dir", "content_hash": "x",
                    "sandbox_path": f"/inputs/{Path(bundle_root).name}"}]
    }))
    staged = inputs / Path(bundle_root).name
    if not staged.exists():
        staged.symlink_to(Path(bundle_root).resolve(), target_is_directory=True)

    child = dict(os.environ)
    child["TXR_INPUTS_DIR"] = str(inputs)
    child["TXR_OUTPUTS_DIR"] = str(outputs_dir)
    child["PYTHONPATH"] = os.pathsep.join([str(PKG / "compute"), str(PKG.parent / "_lib")])
    if env:
        child.update(env)
    # The SHIPPED ENTRY via `runpy.run_path(..., run_name='__main__')` — the exact spelling
    # `test_hostile_bundle.py` uses for the sandbox invocation, so this driver and that one
    # cannot drift apart.
    script = (
        "import runpy\n"
        f"runpy.run_path({str(COMPUTE)!r}, run_name='__main__')\n"
    )
    return [sys.executable, "-c", script], child
