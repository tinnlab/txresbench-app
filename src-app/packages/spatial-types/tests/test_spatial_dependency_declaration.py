#!/usr/bin/env python3
# ruff: noqa
"""#181 — the image-IO libraries the spatial kinds stand on are DECLARED, not transitive.

`differential-expression/tests/test_rootfs_deps.py` is the GENERAL gate: it reads the pin
file and asserts every pinned distribution is covered by the Dockerfile's smoke-import
line, so these two are covered by construction the moment they are pinned. This file is the
branch's own ACCEPTANCE proof of the specific claim #181 makes — that the libraries the
spatial importer will run on are inside the build-time gate rather than outside it — and it
lives beside the types that motivated the declaration.

The failure it prevents is not hypothetical and not loud: `tifffile` and `imagecodecs`
were ALREADY in the shipped image, as transitives of scikit-image/squidpy, and were named
in no recipe. An unrelated dependency bump that dropped either one would have surfaced
first as a USER'S import failing inside a sandbox, with no build-time signal anywhere.
"""
import re
from pathlib import Path

import env_pins

_PACKAGES = Path(__file__).resolve().parents[2]
_ENV = _PACKAGES.parent / "env-rootfs" / "single-cell"
_PINS = _ENV / "requirements.txt"
_DOCKERFILE = _ENV / "Dockerfile"

#: The two #181 names, with the module each must be smoke-imported by. `imagecodecs` is
#: not decoration: it supplies the deflate/LZW codecs tifffile calls out to, and lossless
#: compression is the codec policy #176 mandates for a tissue image.
_REQUIRED = {"tifffile": "tifffile", "imagecodecs": "imagecodecs"}


def _pins():
    """`{distribution: (version, import_module)}` — TEST-P15, the build gate's own parse.

    This used to `splitlines()` / `partition("#")` / `split("==")` the pin file itself, with
    a docstring claiming it parsed "the way the shipped gate and the Rust build gate both
    parse it". It did not, and nothing could have told it so: `str.splitlines()` breaks a
    line on U+001C/1D/1E where Rust's `str::lines()` does not, so this reader and the gate
    could count different pins from the same bytes. #192's round-4 audit demonstrated
    exactly that in the sibling guard — one `U+001C` made the gate read a comment (the
    package absent, never installed) while the python side counted it and stayed green.

    This was #215. It is closed by deletion, not by adding a precondition to a parser that
    stayed a parser: the gate exports its parse and this reads it
    (`docs/design/pin-file-single-parse.md`).
    """
    return {
        p["raw_name"]: (p["version"], p["import"])
        for p in env_pins.pins(_ENV.name, env_root=_ENV.parent)
    }


def _smoke_imports():
    line = next(
        l for l in _DOCKERFILE.read_text(encoding="utf-8").splitlines()
        if "python -c" in l and "import" in l
    )
    return {tok.strip() for tok in line.split("import", 1)[1].split(";")[0].split(",")}


def test_the_image_io_libraries_are_declared_and_smoke_imported():
    """TEST-11 [acceptance] [invariant: INV-11] — both halves of #80's mechanism.

    Half one: an EXACT pin in the file the Rust build gate resolves every declared
    `run.dependencies[]` against, so a package declaring a library that is absent (or a
    range these pins fall outside) fails `cargo check` rather than a user's sandbox job.

    Half two: the import name on the Dockerfile's build-time smoke line, so an install the
    image does not actually provide fails the IMAGE BUILD. "An install the smoke line does
    not verify silently ships absent."
    """
    pins = _pins()
    smoke = _smoke_imports()
    for dist, module in _REQUIRED.items():
        assert dist in pins, (
            f"`{dist}` is not declared in {_PINS.name}. #154 builds on it, and building a "
            "shipped feature on an undeclared transitive is exactly the failure #80 exists "
            "to prevent."
        )
        version, declared_module = pins[dist]
        assert re.match(r"^\d+(\.\d+)+$", version), (
            f"`{dist}` must be pinned to a concrete version, got {version!r} — a range "
            "does not fix reproducibility, since two builds a month apart still land on "
            "different versions inside it"
        )
        assert declared_module == module, (
            f"`{dist}` needs `# import={module}` — the distribution name is not the import "
            "name, and the smoke line is checked against this token"
        )
        assert module in smoke, (
            f"`{dist}` is pinned but `{module}` is NOT on the build-time smoke-import line"
        )


def test_pillow_stays_undeclared_only_while_nothing_imports_it():
    """TEST-11 (cont.) [acceptance] [invariant: INV-11] — the `pillow` disposition, as a
    LIVE check rather than a note somebody has to remember.

    #181 conditions pillow's declaration on "if any path imports it directly", and today
    none does — so it is deliberately not pinned: it is in the image as a transitive, and
    the pin file's own review standard refuses an unconsumed pin without a named consumer
    (the TileDB-SOMA lesson: installed, smoke-tested and shipped for nobody).

    The condition is checked instead of assumed. The day a package imports `PIL` — #176's
    below-cap PNG pass-through is the path that will — this test goes RED and the
    declaration is forced, which is the only version of "we'll remember to add it later"
    that actually works.

    Read it as a TRIPWIRE, not as coverage: today `importers` is empty, so only the `else`
    branch runs and all it proves is that pillow is not pinned. The interesting half is
    unexercised until a consumer lands, and that is the point at which it starts earning
    its keep.
    """
    importers = []
    for py in _PACKAGES.rglob("*.py"):
        if "/tests/" in str(py):
            continue
        text = py.read_text(encoding="utf-8", errors="ignore")
        if re.search(r"^\s*(import\s+PIL|from\s+PIL\b)", text, re.MULTILINE):
            importers.append(str(py.relative_to(_PACKAGES)))

    pins = _pins()
    if importers:
        assert "pillow" in pins, (
            f"{importers} import PIL directly, so `pillow` must now be declared in "
            f"{_PINS.name} with an `# import=PIL` token and added to the smoke line — the "
            "condition #181 attached to it is now met"
        )
        assert "PIL" in _smoke_imports()
    else:
        assert "pillow" not in pins, (
            "`pillow` is pinned but nothing imports it directly. Either the consumer "
            "landed (then this branch of the test should be the one running) or the pin "
            "is unconsumed and should be removed."
        )


def test_this_suite_reads_the_exported_parse_and_not_the_pin_file(monkeypatch):
    """TEST-P15 (#214 / #215) — this reader has STOPPED PARSING, proved behaviourally.

    Replaces the exported parse with a sentinel the pin file does not contain. A consumer
    of the artefact returns it; a residual parser returns what is on disk. #215 filed this
    module's `splitlines()`/`partition("#")`/`split("==")` reader as an unfixed exposure —
    this is what closes it, and this is what proves it closed.
    """
    sentinel = [
        {
            "name": "sentinel-pkg",
            "raw_name": "sentinel-pkg",
            "version": "9.9.9",
            "import": "sentinel_pkg",
            "line": 1,
        }
    ]
    monkeypatch.setattr(env_pins, "pins", lambda *a, **k: sentinel)
    assert _pins() == {"sentinel-pkg": ("9.9.9", "sentinel_pkg")}
    monkeypatch.undo()

    # CONTROL — unpatched it returns the real recipe, so the assertion above is not
    # satisfied by a function that returns whatever it is handed and nothing else.
    real = _pins()
    assert len(real) >= 20, f"only {len(real)} pin(s) from the exported parse"
    for name in _REQUIRED:
        assert name in real, f"{name} must still be pinned"
