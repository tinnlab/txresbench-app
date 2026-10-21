#!/usr/bin/env python3
# ruff: noqa
"""THE MUTATION BATTERY (#176 TEST-10) — proving the scale guards by running, not reading.

A guard that has never been observed to go RED is a guard nobody has evidence for. This
file breaks the SHIPPED producer, one edit at a time, and requires the system to notice —
and, where it does not notice, records that as the measurement rather than hiding it.

## Three outcomes, and the third is the point

| outcome | meaning |
|---|---|
| `refused-by-the-writer` | the producer's own reconciliation refused; no artifact was written |
| `caught-by-a-test-only` | a valid-looking artifact was written and a TEST in this suite is the only thing that catches it |
| `invisible` | nothing in this system can tell |

Every mutation declares which outcome it expects, and a mutation that lands in a DIFFERENT
class than declared fails this test — in either direction. So a guard that stops catching
something moves this file, and so does one that starts catching something (which means the
recorded blind-spot list is stale and the honest documentation elsewhere is now wrong).

## Why a subprocess per mutation

`visium_fixtures.load_compute()` installs the compute modules under the FIXED bare names
`spatial_declarations` / `ome_writer` / `spatial_import_visium_entry`, reproducing the
sandbox's single `/code` directory. Loading a MUTATED copy under those same names would
leave the mutation in `sys.modules` for whatever runs next — the "passed alone, failed
in-suite" failure this epic has already paid for once. A subprocess cannot do that. It also
gets the environment right for free: `PYTHONPATH` is the package's `compute/` plus `_lib`,
which is exactly what a real compute is staged with.
"""
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

REFUSED = "refused-by-the-writer"
TEST_ONLY = "caught-by-a-test-only"
INVISIBLE = "invisible"

#: Each mutation: a name, the file to edit, the exact text to replace, its replacement, the
#: outcome expected, and WHY that outcome is the right one to expect.
#:
#: The `old` strings are load-bearing: an anchor that stops matching means the producer was
#: refactored out from under this battery, and the harness fails loudly rather than silently
#: running an unmutated copy and reporting a clean sweep. That is the single most likely way
#: a file like this rots into a no-op.
MUTATIONS = (
    dict(
        name="affine-drops-the-factor",
        file="import_visium.py",
        old="to_space=ome_writer.emitted_affine(scalef, factor),",
        new="to_space=ome_writer.inverse_scalefactor_affine(scalef),",
        expect=REFUSED,
        why="the pixels are downsampled and the affine still maps them at 1/scalefactor, "
            "so every spot drawn on the image lands `factor` times too close to the origin",
    ),
    dict(
        name="pixels-are-never-resampled",
        file="import_visium.py",
        old="                  arr = ome_writer.downsample(arr, factor)",
        new="                  arr = arr",
        expect=REFUSED,
        why="the provenance records a downsample that did not happen — the emitted grid is "
            "the source grid while `emitted_extent` says otherwise",
    ),
    dict(
        name="ome-header-keeps-the-pre-downsample-pitch",
        file="import_visium.py",
        old="              image_microns_per_pixel=emitted_um_per_px,",
        new="              image_microns_per_pixel=image_um_per_px,",
        expect=REFUSED,
        why="a generic OME reader, which reads only PhysicalSizeX/Y, would measure "
            "everything wrong by exactly the downsample factor",
    ),
    dict(
        name="applied-resolution-is-the-cap",
        file="spatial_declarations.py",
        old="    applied = applied_resolution(original, factor)",
        new="    applied = original if factor == 1 else cap",
        expect=REFUSED,
        why="this is the #155 shape #176 exists to correct: an integer factor overshoots "
            "the cap, so recording the cap states a resolution the pixels do not have",
    ),
    dict(
        name="emitted-grid-off-by-one",
        file="spatial_declarations.py",
        old='    emitted = {"width": source_grid["width"] // factor,\n'
            '               "height": source_grid["height"] // factor}',
        new='    emitted = {"width": source_grid["width"] // (factor + 1),\n'
            '               "height": source_grid["height"] // (factor + 1)}',
        expect=REFUSED,
        why="the recorded grid stops being the source grid divided by the recorded factor",
    ),
    dict(
        name="original-extent-records-the-emitted-grid",
        file="spatial_declarations.py",
        old='        "original_extent": source_grid,',
        new='        "original_extent": emitted,',
        expect=REFUSED,
        why="the ONE recorded fact anchored to a pixel count stops describing the source, "
            "so a consumer cannot tell how much was dropped and `require_original_reference` "
            "hands back the derived grid as the original's",
    ),
    dict(
        name="wrong-vendor-source-recorded",
        file="import_visium.py",
        old="                  original_source=basename,",
        new='                  original_source="tissue_lowres_image.png",',
        expect=REFUSED,
        why="a reader following the pointer to the retained bundle would reach a different "
            "file than the pixels came from",
    ),
    dict(
        name="factor-rounds-down-and-misses-the-cap",
        file="spatial_declarations.py",
        old="    return max(1, int(math.ceil(ratio - _CAP_RATIO_EPSILON)))",
        new="    return max(1, int(math.floor(ratio - _CAP_RATIO_EPSILON)))",
        expect=REFUSED,
        why="a floored factor leaves the image FINER than the declared cap, and every OTHER "
            "guard still agrees with it — the affine, the grid and the OME header are all "
            "consistent with the wrong factor. Only the explicit cap-satisfaction check in "
            "`display_derivative_provenance` sees it, and that check exists BECAUSE this "
            "mutation was invisible without it",
    ),
    dict(
        name="affine-gains-a-block-centre-translation",
        file="ome_writer.py",
        old="    return [base[0] * factor, 0.0, 0.0, 0.0, base[4] * factor, 0.0]",
        new="    off = base[0] * (factor - 1) / 2.0\n"
            "    return [base[0] * factor, 0.0, off, 0.0, base[4] * factor, off]",
        expect=TEST_ONLY,
        why="THE SECOND WRITER BLIND SPOT. A whole-image half-block shift, under the "
            "CORNER convention `ImageWorldBounds` uses. It survives the ENTIRE scale "
            "reconciliation: leg 3 multiplies `to_space[0]` and never reads "
            "`to_space[2]`/`[5]`, so the affine, the grid, the OME header and the recorded "
            "resolution all still agree, and `_reconcile_scale` lists the translation among "
            "the things it cannot check. Only TEST-13, which pins the convention by name, "
            "catches it — the geometric round trip cannot, because a centroid of saturated "
            "blocks measures the convention against itself",
    ),
    dict(
        name="cap-ratio-epsilon-removed",
        file="spatial_declarations.py",
        old="_CAP_RATIO_EPSILON = 1e-9",
        new="_CAP_RATIO_EPSILON = 0.0",
        expect=INVISIBLE,
        why="INVISIBLE ON THIS FIXTURE, and that is the honest classification rather than a "
            "gap. The epsilon only decides the boundary case (a source a hair UNDER the cap "
            "in float terms, which without it is halved for no reason); this bundle sits at "
            "ratio 2.5, nowhere near it, so the mutation changes nothing here and the "
            "battery genuinely cannot see it. What pins the epsilon is the unit test that "
            "feeds `cap * (1 - 1e-12)` — recorded here so that the constant is not left "
            "looking guarded by a battery that does not touch it",
    ),
    dict(
        name="decimate-instead-of-averaging",
        file="ome_writer.py",
        old="        mean = blocks.mean(axis=(1, 3))",
        new="        mean = clipped[::factor, ::factor]",
        expect=TEST_ONLY,
        why="THE BLIND SPOT OF THE SCALE GUARDS. Same shape, same extent, same factor, same "
            "affine, same provenance, same OME header — every reconciliation leg agrees, and "
            "the artifact is written. Only TEST-4, which recomputes the box mean from the "
            "vendor file and compares the bytes, can tell. This is why INV-3 needs its own "
            "test and cannot ride on the scale reconciliation",
    ),
    dict(
        name="truncate-instead-of-rounding",
        file="ome_writer.py",
        old="        return np.rint(mean).astype(arr.dtype)",
        new="        return mean.astype(arr.dtype)",
        expect=TEST_ONLY,
        why="every emitted pixel biased darker by up to one count, compounding across "
            "pyramid levels. Invisible to every geometric check for the same reason "
            "decimation is: the pixel VALUES are not part of any declaration",
    ),
)


def _verifier_source():
    """The script each subprocess runs: import the mutated compute, import, report."""
    return textwrap.dedent(
        '''
        import importlib.util, json, sys
        from pathlib import Path

        compute, bundle, out = (Path(a) for a in sys.argv[1:4])

        def load(name, path):
            spec = importlib.util.spec_from_file_location(name, path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            return mod

        verdict = {"emitted": False, "skipped": [], "checks": {}, "aborted": None,
                   "factor": None}
        try:
            load("spatial_declarations", compute / "spatial_declarations.py")
            OW = load("ome_writer", compute / "ome_writer.py")
            SD = sys.modules["spatial_declarations"]
            entry = load("entry", compute / "import_visium.py")
            entries = entry.run_import(bundle, out)
        except BaseException as exc:                      # noqa: BLE001
            verdict["aborted"] = f"{type(exc).__name__}: {exc}"
            print(json.dumps(verdict))
            raise SystemExit(0)

        report = json.loads((out / "visium-import-report.json").read_text())
        verdict["skipped"] = report["images_not_emitted"]
        hires = [e for e in entries if e["id"] == "spatial-image-hires"]
        verdict["emitted"] = bool(hires)
        if not hires:
            print(json.dumps(verdict))
            raise SystemExit(0)
        verdict["factor"] = (hires[0]["meta"].get("display_derivative") or {}).get(
            "downsample_factor")

        # THE ARTIFACT WAS WRITTEN. Now run the checks the suite itself makes, so a
        # mutation that survives the producer is classified by WHICH test would catch it.
        import numpy as np, tifffile
        from PIL import Image

        meta = hires[0]["meta"]
        prov = meta.get("display_derivative") or {}
        with tifffile.TiffFile(out / hires[0]["path"]) as tf:
            pixels = tf.series[0].levels[0].asarray()
        with Image.open(bundle / "spatial" / "tissue_hires_image.png") as im:
            src = np.asarray(im.convert("RGB"))

        c = verdict["checks"]
        try:
            factor = prov["downsample_factor"]
            c["grid"] = (meta["extent"] == {"width": pixels.shape[1],
                                            "height": pixels.shape[0]}
                         and prov["emitted_extent"] == meta["extent"])
            c["affine"] = abs(meta["to_space"][0] * meta["microns_per_pixel"]
                              - prov["applied_resolution_um"]) < 1e-9
            c["cap"] = prov["applied_resolution_um"] >= prov["resolution_cap_um"]
            c["source"] = prov["original_source"] == "tissue_hires_image.png"
            c["original_extent"] = prov["original_extent"] == {"width": src.shape[1],
                                                               "height": src.shape[0]}
            h, w = src.shape[0] // factor, src.shape[1] // factor
            blocks = src[: h * factor, : w * factor].reshape(
                h, factor, w, factor, src.shape[2])
            expected = np.rint(blocks.mean(axis=(1, 3))).astype(src.dtype)
            c["boxmean"] = bool(np.array_equal(pixels, expected))
            # THE GEOMETRIC ROUND TRIP — a coarse check that the FACTOR is folded into
            # the affine at all, and nothing finer.
            #
            # It is explicitly NOT the check for the affine's TRANSLATION term, which an
            # earlier version of this comment claimed. At a tolerance the marker centroid
            # can actually support (one emitted pixel), a half-block offset passes; at a
            # tolerance tight enough to catch one, the SHIPPED convention fails and the
            # rejected one passes. The centroid is not a precise enough instrument to
            # arbitrate half a pixel. `convention` below is what catches a translation, by
            # name, and TEST-3 pins the exact fingerprint of both conventions.
            bright = np.argwhere(pixels[:, :, 0] == 255)
            if bright.size:
                row, col = bright.mean(axis=0)
                a, b, tx, cc, d, ty = meta["to_space"]
                placed = (a * col + b * row + tx, cc * col + d * row + ty)
                truth = (4900, 2700)
                # ONE emitted pixel — all the centroid supports. This leg's job is to catch
                # a DROPPED FACTOR, which misses by `factor`x and is nowhere near this
                # bound; the pixel-anchor convention is `convention`'s job, not this one's.
                tol = 1.0 * a
                c["geometry"] = bool(abs(placed[0] - truth[0]) <= tol
                                     and abs(placed[1] - truth[1]) <= tol)
            else:
                c["geometry"] = False
            # THE PIXEL-ANCHOR CONVENTION, checked by name because no measurement here can
            # arbitrate it: a centroid of saturated blocks measures the convention against
            # itself. CORNER means the affine is a pure scale — `ImageWorldBounds` anchors
            # world coordinates at pixel CORNERS and `affineMatrix.ts` composes this affine
            # as a whole-image modelMatrix over them, so a translation shifts the image.
            c["convention"] = bool(meta["to_space"][2] == 0.0
                                   and meta["to_space"][5] == 0.0)
            # numpy scalars are not JSON-serializable, and this verdict crosses a process
            # boundary as JSON. Coerced HERE rather than at the reader, so a check that
            # returns a numpy bool fails loudly at the source instead of silently.
            c = {k: (bool(v) if isinstance(v, (bool, np.bool_)) else v)
                 for k, v in c.items()}
            verdict["checks"] = c
        except BaseException as exc:                      # noqa: BLE001
            c["error"] = f"{type(exc).__name__}: {exc}"
        print(json.dumps(verdict))
        '''
    )


def _run(compute_dir, bundle, out, script):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(compute_dir), str(VF.PKG.parent / "_lib")])
    proc = subprocess.run(
        [sys.executable, str(script), str(compute_dir), str(bundle), str(out)],
        capture_output=True, text=True, env=env, timeout=600,
    )
    assert proc.returncode == 0, f"the verifier itself crashed:\n{proc.stderr}"
    tail = [line for line in proc.stdout.strip().splitlines() if line.startswith("{")]
    assert tail, f"the verifier printed no verdict:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(tail[-1])


def _classify(verdict):
    if verdict["aborted"]:
        return REFUSED
    if not verdict["emitted"]:
        return REFUSED
    checks = verdict["checks"]
    if "error" in checks or not all(v for k, v in checks.items() if k != "error"):
        return TEST_ONLY
    return INVISIBLE


@pytest.fixture(scope="module")
def battery(tmp_path_factory):
    """A pristine copy of `compute/` and one fine bundle, shared by every mutation."""
    root = tmp_path_factory.mktemp("mutation-battery")
    script = root / "verify.py"
    script.write_text(_verifier_source())
    bundle = VF.make_fine_imaged(root / "src")
    return {"root": root, "script": script, "bundle": bundle}


def _mutated_compute(battery, mutation, index):
    compute = battery["root"] / f"compute-{index}"
    shutil.copytree(VF.PKG / "compute", compute,
                    ignore=shutil.ignore_patterns("__pycache__"))
    target = compute / mutation["file"]
    text = target.read_text()
    assert mutation["old"] in text, (
        f"{mutation['name']}: the anchor is no longer in {mutation['file']}. The producer "
        "was refactored out from under this battery, which would otherwise have run an "
        "UNMUTATED copy and reported a clean sweep."
    )
    assert text.count(mutation["old"]) == 1, (
        f"{mutation['name']}: the anchor appears {text.count(mutation['old'])} times, so "
        "the mutation is not the single edit it claims to be"
    )
    target.write_text(text.replace(mutation["old"], mutation["new"]))
    return compute


def test_the_unmutated_producer_is_the_positive_control(battery):
    """TEST-10 (control) [covers: ITEM-11] — every check GREEN before any is broken.

    Without this, a harness that silently failed to run the producer at all would report
    every mutation as "refused" and the battery would be a clean sweep proving nothing.
    """
    compute = battery["root"] / "compute-control"
    shutil.copytree(VF.PKG / "compute", compute,
                    ignore=shutil.ignore_patterns("__pycache__"))
    verdict = _run(compute, battery["bundle"], battery["root"] / "out-control",
                   battery["script"])
    assert verdict["aborted"] is None, verdict
    assert verdict["emitted"] is True, verdict
    assert verdict["checks"] and all(verdict["checks"].values()), verdict
    # …and the battery is exercising the DOWNSAMPLE path, not a pass-through. Every check
    # in the verifier is satisfied identically at factor 1 (a 1x1 box mean is the identity),
    # so without this the control cannot tell "the battery works" from "the fixture went
    # coarse and every mutation below is being applied to dead code".
    assert verdict["factor"] > 1, (
        f"the control ran at factor {verdict['factor']} — the fixture did not downsample, "
        "so every mutation in this battery is being applied to a branch that never runs"
    )
    assert _classify(verdict) == INVISIBLE, (
        "the control classifies as something other than 'nothing wrong', so the classifier "
        "cannot distinguish a healthy producer from a broken one"
    )


@pytest.mark.parametrize("index,mutation",
                         list(enumerate(MUTATIONS)),
                         ids=[m["name"] for m in MUTATIONS])
def test_each_mutation_lands_in_the_class_it_declares(battery, index, mutation):
    """TEST-10 [covers: ITEM-11] — the guard is load-bearing, or the blind spot is real.

    Asserted in BOTH directions. A mutation expected to be `refused-by-the-writer` that is
    not means the reconciliation is decorative. A mutation expected to be
    `caught-by-a-test-only` that IS refused means the recorded blind spot has closed and
    the honest documentation in `ome_writer._reconcile_scale`, `image_meta` and TEST-11 is
    now overclaiming in the other direction — which is also a defect, and also moves this
    file.
    """
    compute = _mutated_compute(battery, mutation, index)
    verdict = _run(compute, battery["bundle"], battery["root"] / f"out-{index}",
                   battery["script"])
    actual = _classify(verdict)
    assert actual == mutation["expect"], (
        f"{mutation['name']}: expected {mutation['expect']}, got {actual}.\n"
        f"why it matters: {mutation['why']}\n"
        f"verdict: {json.dumps(verdict, indent=2)}"
    )
    if actual == REFUSED:
        # …and the refusal REACHED THE USER rather than vanishing: either the whole import
        # aborted (which would itself be an INV-6 violation and is asserted against below)
        # or the image is named in the report a human reads.
        assert verdict["aborted"] is None, (
            f"{mutation['name']}: the mutation ABORTED the import "
            f"({verdict['aborted']}) instead of costing one image — INV-6 says losing one "
            "image must never cost the matrix, the coordinates, the columns and the report"
        )
        assert any("tissue_hires_image.png" in note for note in verdict["skipped"]), (
            f"{mutation['name']}: the image was dropped in SILENCE: {verdict['skipped']}"
        )


def test_what_the_writer_cannot_see_is_measured_by_running(battery):
    """TEST-10 (cont.) [covers: ITEM-11, ITEM-12] — the SHAPE of the writer's blind spots.

    **This test RUNS the producer.** An earlier version compared two hardcoded literals
    against the `MUTATIONS` table defined in this same file — it took the `battery` fixture
    and never used it, and no change to `compute/` could turn it red. A claim about what
    the writer can see, evidenced by a table asserting what the writer can see, is
    circular; every classification below is derived from a real subprocess run.

    ## The claim, corrected by measurement

    The first version of this test claimed the writer's blind spots were EXACTLY the
    pixel-value mutations — that anything touching a DECLARED NUMBER would be refused. The
    battery falsified that. `write_ome_tiff`'s reconciliation compares declarations against
    each other and against `arr.shape`, so it is blind to anything that appears in NEITHER:

    * **pixel VALUES** — decimation and truncation produce the same shape, extent, factor,
      affine and header. Closed by TEST-4, which reads the bytes.
    * **the affine's TRANSLATION** — leg 3 multiplies `to_space[0]` and never reads
      `to_space[2]`/`[5]`, so an offset ADDED to the shipped corner-convention affine leaves
      every leg agreeing. Closed by TEST-13 and by this file's `convention` check, both of
      which pin it BY NAME, and by TEST-3's exact fingerprint — NOT by the geometric round
      trip, whose tolerance the centroid cannot make tight enough to see half a block
      (DEC-14).

    Both are things no declaration in the artifact CONTAINS, which is the honest shape of
    the rule. The corrected version is recorded here rather than the tidier one, because
    the tidier one was false.
    """
    outcomes = {}
    for name in ("decimate-instead-of-averaging", "truncate-instead-of-rounding",
                 "affine-gains-a-block-centre-translation", "emitted-grid-off-by-one"):
        index = next(i for i, m in enumerate(MUTATIONS) if m["name"] == name)
        compute = _mutated_compute(battery, MUTATIONS[index], f"blind-{index}")
        outcomes[name] = _classify(
            _run(compute, battery["bundle"], battery["root"] / f"blind-out-{index}",
                 battery["script"])
        )

    # The two PIXEL-VALUE mutations are written without complaint: same shape, same extent,
    # same factor, same affine, same provenance, same OME header.
    assert outcomes["decimate-instead-of-averaging"] == TEST_ONLY, outcomes
    assert outcomes["truncate-instead-of-rounding"] == TEST_ONLY, outcomes
    # …and so is the TRANSLATION mutation, which is a declared number the reconciliation
    # never reads. This is the leg that falsified the tidier claim.
    assert outcomes["affine-gains-a-block-centre-translation"] == TEST_ONLY, outcomes
    # The CONTROL: a declared number the reconciliation DOES read is refused before a byte
    # is written. Without it the three results above are indistinguishable from "the
    # battery refuses nothing".
    assert outcomes["emitted-grid-off-by-one"] == REFUSED, outcomes

    # And the declared table agrees with what was just measured, so it cannot drift away
    # from the behaviour it documents.
    declared = {m["name"]: m["expect"] for m in MUTATIONS}
    assert {k: declared[k] for k in outcomes} == outcomes, (declared, outcomes)

    # Every writer blind spot in the table is closed by SOMETHING in this suite — none is
    # left `invisible` except the one that is honestly out of the battery's reach (the
    # boundary-only epsilon), and the genuinely uncloseable case (a wrong vendor micron
    # scale) is not a mutation of our code at all, which is why it is TEST-11's subject.
    unreachable = {m["name"] for m in MUTATIONS if m["expect"] == INVISIBLE}
    assert unreachable == {"cap-ratio-epsilon-removed"}, unreachable
