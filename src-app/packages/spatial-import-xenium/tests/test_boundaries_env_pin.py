#!/usr/bin/env python3
# ruff: noqa
"""#163 — the pinned reader is importable IN THE ENV THE ANALYSIS DECLARES.

TEST-16 [covers: ITEM-3].

## Why the host interpreter is not the subject

`just check-py` runs on the host, and this host happens to have pyarrow 25.0.0. That proves
nothing about a sandboxed job: the analysis declares `env: single-cell`, and what it gets is
the rootfs image. #80's whole point is that a library present at test time and absent at run
time surfaces as a user's job failing with no build-time signal.

So this asserts against the IMAGE — the squashfs the runtime's air-gap seam takes — using
the image's OWN `/opt/venv/bin/python` under `bwrap`, which is the sandbox's own mechanism.
It SKIPS with a stated reason when no image is staged, because a check that quietly passes
without its subject is worse than no check.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

_REPO = Path(__file__).resolve().parents[4]
_CACHE = _REPO / ".txr-cache" / "env-rootfs"


def _staged_image():
    for candidate in sorted(_CACHE.glob("single-cell-schema*-*.squashfs")):
        return candidate
    return None


def test_the_pin_and_the_smoke_line_agree_with_the_declared_dependency():
    """The three places the reader is named must not drift apart.

    The manifest declares a `run.dependencies[]` range; the recipe pins an exact version the
    build gate resolves it against; the Dockerfile's `# txr:env-smoke` line is what proves
    the install actually happened. A pin the smoke line does not verify silently ships absent.
    """
    import yaml

    recipe = _REPO / "src-app" / "env-rootfs" / "single-cell"
    pins = recipe / "requirements.txt"
    dockerfile = recipe / "Dockerfile"
    pin_lines = [l for l in pins.read_text().splitlines()
                 if l.strip() and not l.lstrip().startswith("#") and "pyarrow" in l]
    assert len(pin_lines) == 1, f"expected exactly one pyarrow pin, got {pin_lines}"
    line = pin_lines[0]
    assert line.startswith("pyarrow=="), f"the pin is not an exact pin: {line!r}"
    assert "# import=pyarrow" in line, (
        f"the pin carries no `import=` token: {line!r}. It is the key the smoke-line "
        "correspondence check is made on."
    )
    assert "#163" in line, (
        "#191's convention is that a pin names its consumer ON ITS OWN LINE; this one does "
        f"not: {line!r}"
    )

    smoke = [l for l in dockerfile.read_text().splitlines() if "txr:env-smoke" in l]
    assert smoke, "the Dockerfile lost its `# txr:env-smoke` marker"
    body = dockerfile.read_text().split("# txr:env-smoke", 1)[1].splitlines()[1]
    assert "pyarrow" in body, (
        "the smoke line does not import pyarrow, so the install is unverified at build time"
    )

    doc = yaml.safe_load((XF.PKG / "manifest.yaml").read_text())
    libs = {d["library"] for d in
            doc["contributes"]["analyses"][0]["run"]["dependencies"]}
    assert "pyarrow" in libs, "the analysis does not declare the library it imports"


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bwrap is not on this host")
def test_pyarrow_imports_inside_the_staged_rootfs_image(tmp_path):
    """TEST-16 — proven by RUNNING it in the image, not by reading a dependency graph."""
    image = _staged_image()
    if image is None:
        pytest.skip(
            f"no env rootfs image is staged under {_CACHE} — run `just env-rootfs-local "
            "--env single-cell` (or fetch one). Skipping rather than passing, because "
            "without the image this asserts nothing about the env the analysis runs in."
        )
    if shutil.which("unsquashfs") is None:
        pytest.skip("unsquashfs is not on this host")

    root = tmp_path / "root"
    # THE WHOLE IMAGE, not a path subset. Two partial extracts were tried and each failed
    # in a way that READS LIKE a pyarrow failure and is not one: without `dev`/`proc` bwrap
    # reports `Can't mkdir /dev` under the read-only bind, and a subset that names
    # `opt/venv` still loses the interpreter (`execvp /opt/venv/bin/python: No such file or
    # directory`) because the venv's `bin/python` is a symlink chain out of the filtered
    # set. A green here has to mean "the env the analysis declares has this library", so the
    # subject is the whole image or nothing.
    extract = subprocess.run(
        ["unsquashfs", "-d", str(root), "-q", "-f", str(image)],
        capture_output=True, text=True)
    if extract.returncode != 0:
        pytest.skip(
            f"could not extract {image.name} without root: {extract.stderr[-400:]}"
        )
    # `lexists`, NOT `exists`. `/opt/venv/bin/python` is a symlink to the ABSOLUTE path
    # `/usr/local/bin/python3.11`, which resolves correctly inside the bwrap root and
    # resolves to nothing on the host — so `exists()` is False on a perfectly good extract
    # and this guard SKIPPED a test that would have passed. A precondition check that is
    # wrong in the safe direction still costs the whole claim.
    if not os.path.lexists(root / "opt" / "venv" / "bin" / "python"):
        pytest.skip(
            f"{image.name} was extracted without its venv interpreter — skipping rather "
            "than reporting a missing interpreter as a missing library"
        )

    probe = subprocess.run(
        ["bwrap", "--ro-bind", str(root), "/", "--dev", "/dev", "--proc", "/proc",
         "/opt/venv/bin/python", "-c",
         "import pyarrow, pyarrow.parquet as pq; print(pyarrow.__version__); "
         "print(hasattr(pq, 'ParquetFile'))"],
        capture_output=True, text=True)
    assert probe.returncode == 0, (
        f"`import pyarrow` FAILED inside {image.name} — the analysis declares this library "
        f"and would fail in a user's sandbox:\n{probe.stderr[-2000:]}"
    )
    version, has_parquet = probe.stdout.split()
    assert has_parquet == "True"

    pinned = [l.split("==")[1].split("#")[0].strip()
              for l in (_REPO / "src-app" / "env-rootfs" / "single-cell"
                        / "requirements.txt").read_text().splitlines()
              if l.startswith("pyarrow==")]
    assert version == pinned[0], (
        f"the image carries pyarrow {version} but the recipe pins {pinned[0]} — the pin and "
        "the image have drifted, which is the state a republish exists to end"
    )
