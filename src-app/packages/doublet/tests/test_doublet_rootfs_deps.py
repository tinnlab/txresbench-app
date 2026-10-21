#!/usr/bin/env python3
# ruff: noqa
"""TEST-22 [covers: ITEM-25] — the single-cell Dockerfile's build-time smoke-import line names
every library the doublet compute imports at run time, and the package adds NO new dependency.

The class of defect named in the design doc §1.1: an install the smoke line does not verify silently ships absent, and the first
person to find out is a live job. `skimage` is the one that matters here and it is a genuinely
different case from the others — NOTHING PINS IT. It is not in the `uv pip install` list at all;
it arrives as a TRANSITIVE of squidpy, and it is loaded through `lazy_loader`, so even an
over-aggressive trim of the venv can break it without breaking any import the rest of the stack
performs. The doublet compute reaches for it because Scrublet's AUTOMATIC threshold IS
`skimage.filters.threshold_minimum` — so the smoke line naming `skimage` is the ONLY thing
standing between a republished rootfs and every automatic-threshold run refusing.

The second half is the zero-new-dependency argument, stated as a test rather than as prose in
the manifest: Scrublet is VENDORED INSIDE SCANPY (`sc.pp.scrublet`), so a `scrublet` pip package
in this file would mean the whole method choice — taking Scrublet over
scDblFinder — bought nothing. `r-base-core` is asserted absent for the same reason from the
other side: it was deliberately dropped at rootfs schema v5 and its return would mean an R lane
landed, at which point `doublet.scdblfinder` is the better analysis to ship.

The last two tests close the loop at RUN time rather than at Dockerfile-text time: the compute
must REFUSE BY NAME when the backend is missing (never crash on a raw ImportError mid-run, and
never fabricate a threshold), and the refusal must name the reachable lever — an explicit
`threshold`, which needs no backend at all. Both are driven through the compute's own
`DOUBLET_FORCE_SKIMAGE_ABSENT=1` seam so the absent branch is exercised DETERMINISTICALLY on a
host where skimage IS installed.
"""
from pathlib import Path

_DOCKERFILE = (Path(__file__).resolve().parents[3] / "env-rootfs" / "single-cell"
               / "Dockerfile")

#: Every library the doublet compute imports at run time (directly, or through
#: `sc.pp.scrublet`). `skimage` is last because it is the only one nothing else pins.
DEPS = ("scanpy", "numpy", "scipy", "sklearn", "pandas", "skimage")


def _smoke_line(text):
    return next(l for l in text.splitlines()
                if "python -c" in l and "import" in l and "scanpy" in l)


def test_every_runtime_import_is_named_in_the_smoke_import_line():
    text = _DOCKERFILE.read_text()
    assert "uv pip install" in text
    smoke_line = _smoke_line(text)
    for dep in DEPS:
        assert dep in smoke_line, (
            f"`{dep}` is missing from the Dockerfile's build-time smoke-import line. The "
            "doublet compute imports it at run time, so an env that lost it fails a live job "
            "instead of the image build.")


def test_skimage_is_verified_even_though_nothing_installs_it_directly():
    """The point of the previous test, isolated: skimage is a squidpy TRANSITIVE that is never
    named in the install list, so the smoke line is its only guard in the whole file."""
    text = _DOCKERFILE.read_text()
    install_block = text.split("uv pip install", 1)[1].split("\n\n", 1)[0]
    assert "scikit-image" not in install_block, (
        "scikit-image is now installed explicitly — good, but update this test: the smoke line "
        "is no longer its only guard")
    assert "skimage" in _smoke_line(text)


def test_the_dockerfile_installs_no_scrublet_pip_package():
    """Scrublet is vendored inside scanpy (`sc.pp.scrublet`). A pip `scrublet` here would be a
    new dependency, i.e. a Dockerfile edit + a GHCR republish — the exact cost the method
    choice was made to avoid."""
    text = _DOCKERFILE.read_text()
    for line in text.splitlines():
        if "scrublet" in line.lower():
            assert False, f"the Dockerfile mentions scrublet: {line.strip()}"


def test_the_dockerfile_installs_no_r_runtime():
    """`r-base-core` was dropped at rootfs schema v5 with no R runtime lane, which is why
    scDblFinder — an R/Bioconductor method often cited as a stronger caller, and not one of
    the nine methods the Xi & Li 2021 benchmark compared — is not what this package ships. If
    R ever comes back, that trade should be re-argued rather than left standing."""
    text = _DOCKERFILE.read_text()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue  # the schema-v5 note that RECORDS the drop mentions it by name
        assert "r-base-core" not in stripped, f"an R runtime is installed: {stripped}"


def test_the_compute_refuses_by_name_when_the_threshold_backend_is_absent(detect_run):
    """The runtime half. With no skimage and no explicit threshold there is no honest way to
    produce a call, so the compute stops BEFORE reading a byte and says so — naming the missing
    package and the reachable lever. A raw `ImportError` surfacing mid-run from inside scanpy
    would name neither."""
    from doublet_fixtures import structured_counts

    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    proc = run.run({"n_prin_comps": 10},
                   env_extra={"DOUBLET_FORCE_SKIMAGE_ABSENT": "1"})

    assert proc.returncode != 0, "a run with no threshold backend and no explicit threshold succeeded"
    diag = run.diagnostics(proc)
    assert diag, f"the refusal was not emitted under the package prefix:\n{proc.stderr[-2000:]}"
    # it names the PACKAGE the operator has to install…
    assert "scikit-image" in diag, diag
    # …and the LEVER that works without it, right now.
    assert "threshold" in diag, diag
    # a refused run commits nothing.
    assert not (run.outputs_dir / "manifest.json").exists()


def test_an_explicit_threshold_needs_no_backend_at_all(detect_run):
    """The control, and the proof the refusal above is about the AUTOMATIC path only: the SAME
    seam, the same input, plus a `threshold` — and the run succeeds. Without this, a compute
    that simply refused whenever the seam was set would pass the test above."""
    from doublet_fixtures import structured_counts

    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok({"n_prin_comps": 10, "threshold": "0.5"},
               env_extra={"DOUBLET_FORCE_SKIMAGE_ABSENT": "1"})

    assert run.entry("doublet_call") is not None
    report = run.report()
    assert report["threshold_source"] == "user"
    assert report["batches"][0]["threshold"] == 0.5
