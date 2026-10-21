#!/usr/bin/env python3
# ruff: noqa
"""Staging + read-back machinery for the `spatial.import-visium-hd` suites.

## Why this module is named after its package

Non-`test_*.py` files in a `tests/` dir are imported by BARE NAME, so a `fixtures.py` here
would collide with every other package's copy of the same name — the
`--import-mode=importlib` fix in `packages/pytest.ini` gives path-unique names to
`test_*.py` modules ONLY. `spatial-import-visium/tests/visium_fixtures.py` solved the same
problem the same way; this follows it.

## The fixture is SYNTHESIZED, and that bounds what these suites prove

`tests/fixtures/visium-hd-outs/` is built by the committed `tests/make_fixture.py`. Every
byte is in the vendor's own FORMAT — a 10x-shaped `.h5`, a real parquet positions table, a
real PNG, a real `scalefactors_json.json` — but no real Visium HD bundle was available, so
the CONTENT is generated and what the suites prove is a claim about the format this repo has
DOCUMENTED. `tests/fixtures/PROVENANCE.json` carries the per-claim citations and
`test_fixture_provenance.py` checks that each one still resolves.

This is the same disclosure `spatial-types/tests/README-hd-fixture.md` makes for the HD
LAYOUT fixture, for the same reason, and it is repeated rather than assumed: a reader who
finds a green suite here must not read it as evidence about vendor bytes.

## The TWO staged layouts, both of which the platform really presents

`staged_tree()` gives the path-preserving layout — a `binned_outputs/square_NNNum/` tree, as
an archive upload retains it. `staged_flat()` gives what
`dataset/process.rs::build_dataset_inputs` ACTUALLY writes for a multi-file dataset: twelve
files named `{i}_{basename}` in one flat directory, bound at slots `bundle_{i}`, with the
`square_NNNum/` segment surviving only as that integer. Both are exercised, because an
importer that only ever met the first one would be untested against production.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
PACKAGES = PKG.parent
FIXTURE = PKG / "tests" / "fixtures" / "visium-hd-outs"
COMPUTE = PKG / "compute" / "import_visium_hd.py"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_fixture as MF  # noqa: E402

#: The fixture's own identity, asserted rather than assumed by the end-to-end suite.
FIXTURE_SPACE_RANGER = MF.SOFTWARE_VERSION
FIXTURE_LIBRARY_ID = MF.LIBRARY_ID
FIXTURE_BINS = MF.BINS
FIXTURE_MICRONS_PER_PIXEL = MF.MICRONS_PER_PIXEL


def _load_by_path(name, path):
    """Load one module from an exact PATH, ignoring `sys.path` entirely."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


#: The loaded entry module, cached for the process.
#:
#: CACHED, and that is a correctness fix rather than a speed one. Re-executing the module
#: mints a NEW `VisiumImportError` CLASS each time, so a test that held a module from one call
#: and drove the import through another got a refusal whose class was not the one it was
#: watching for — `pytest.raises(module.VisiumImportError)` simply misses it, and the test
#: fails with the refusal it was asserting for printed in the traceback. Production loads the
#: entry ONCE per job, so one module per process is also the more faithful model.
_COMPUTE_CACHE = []


def load_compute():
    """Import `compute/import_visium_hd.py` the way the sandbox stages it.

    ## Why this binds the helpers BY PATH instead of by `sys.path`

    In production the sandbox assembles ONE `/code` dir holding the entry plus the files
    `run.helpers` declares, so `import spatial_declarations` is unambiguous: there is exactly
    one such file and it is the vendored copy. A pytest process is not that dir. It imports
    out of the source tree, where `spatial-types`, `spatial-import-visium` and
    `spatial-import-xenium` all ship files of the same names — and whichever suite runs first
    wins `sys.modules`, for the whole session.

    That is not hypothetical: the sibling package records it happening, with the effect that
    every assertion in its vendored-contract test would have been about a module it does not
    ship. Here the risk is worse, because there are now FOUR copies of
    `spatial_declarations.py` and THREE of `registration_qc.py` in the tree, and this
    package's `registration_qc.py` is NOT a copy of either sibling's — a session that
    resolved that bare name to the Visium one would silently test the 100 um slide-pitch
    referent instead of this module's bin-pitch one.

    So each helper is loaded from its own path and INSTALLED under the bare name before the
    entry is executed, in dependency order, which reproduces `/code` exactly.
    """
    if _COMPUTE_CACHE:
        return _COMPUTE_CACHE[0]
    _load_by_path("spatial_declarations", PKG / "compute" / "spatial_declarations.py")
    # AFTER `spatial_declarations`: `ome_writer` imports it by bare name, and in `/code` both
    # sit beside the entry. Reproducing the order here is what makes the bare name resolve to
    # this package's copy rather than to whichever sibling ran first.
    _load_by_path("ome_writer", PKG / "compute" / "ome_writer.py")
    _load_by_path("registration_qc", PKG / "compute" / "registration_qc.py")
    _COMPUTE_CACHE.append(_load_by_path("spatial_import_visium_hd_entry", COMPUTE))
    return _COMPUTE_CACHE[0]


def run_over(bundle_root, outputs_dir, *, requested_bin=None, slot_ordinals=None):
    """Drive the REAL compute over `bundle_root`, returning `(module, entries)`.

    This calls the shipped `run_import`, not a re-implementation of it — a test that
    reproduces the importer's logic proves only that the reproduction agrees with itself.
    """
    module = load_compute()
    entries = module.run_import(Path(bundle_root), Path(outputs_dir),
                                requested_bin=requested_bin, slot_ordinals=slot_ordinals)
    return module, entries


def entry_by_id(entries, output_id):
    hits = [e for e in entries if e["id"] == output_id]
    assert len(hits) == 1, f"expected exactly one {output_id!r}, got {len(hits)}"
    return hits[0]


def read_member(outputs_dir, rel_dir, member):
    """Read one member of a written store back as a numpy array.

    Through `_lib`'s OWN reader (`cyto_zarr_read`), which is the reader the platform ships
    for these stores — the writer emits Zarr v3 with the repo's shuffle/codec conventions,
    and a third-party `zarr` at v2 cannot open it. Reading BACK rather than trusting the
    writer's return value is the whole point: these suites assert on the bytes that landed,
    which is what a consumer will see.
    """
    import cyto_zarr_read

    return cyto_zarr_read.read_array(str(Path(outputs_dir) / rel_dir), member)


def read_column(outputs_dir, rel_dir, member="values"):
    """A column artifact as what it MEANS — categorical labels resolved, strings decoded."""
    import cyto_zarr_read

    return cyto_zarr_read.read_column(str(Path(outputs_dir) / rel_dir), member)


def read_values(outputs_dir, rel_dir):
    """The sole `values` member of a 1-D metadata-column store, as what it MEANS.

    Through `read_column` rather than `read_array`: a TEXT column is stored in the split
    arrow layout, so `values` is a GROUP and a raw array read fails on it.
    """
    return read_column(outputs_dir, rel_dir)


def store_declarations(outputs_dir, rel_dir):
    """`attributes.cyto.cyto_spatial` of a written store — the declaration MIRRORED into the
    store's own bytes (#211).

    Read from the STORE ROOT's `zarr.json`, not from a member's, because that is where the
    mirror lives and because it is the copy a SANDBOXED consumer can reach: `meta` never
    crosses into the sandbox, the store's own bytes do. Asserting on this rather than on the
    `meta` dict the writer was handed is what makes an assertion about what a consumer sees.
    """
    doc = json.loads(
        (Path(outputs_dir) / rel_dir / "zarr.json").read_text(encoding="utf-8")
    )
    return doc.get("attributes", {}).get("cyto", {}).get("cyto_spatial", {})


def member_attributes(outputs_dir, rel_dir, member):
    """`attributes.cyto` of one member — the declaration that travels WITH the bytes."""
    doc = json.loads(
        (Path(outputs_dir) / rel_dir / member / "zarr.json").read_text(encoding="utf-8")
    )
    return doc.get("attributes", {}).get("cyto", {})


# ── the bundle and its variants ──────────────────────────────────────────────────────


def staged_tree(tmp_path, **build_kwargs):
    """A PATH-PRESERVING bundle: the `binned_outputs/square_NNNum/` tree, as an archive keeps it.

    Rebuilt from the generator when `build_kwargs` asks for a variant, and COPIED from the
    committed fixture otherwise — so the ordinary case exercises the exact bytes that are
    under version control rather than a fresh build that happens to agree with them.
    """
    dest = Path(tmp_path) / "visium-hd-outs"
    if build_kwargs:
        MF.build(dest, **build_kwargs)
    else:
        shutil.copytree(FIXTURE, dest)
    return dest


def staged_flat(tmp_path, source=None, *, members=None, write_inputs_json=True):
    """The FLATTENED layout a real sandbox gets, built from the DECLARED member list.

    `dataset/process.rs::build_dataset_inputs` binds a multi-file dataset's files at
    `{slot}_{i}` with sandbox subpath `{i}_{basename}`, taking them in `list_files` order —
    which is the DECLARED member order. So this staging reads the member list off the
    compute's own `DECLARED_MEMBERS` and lays the files out at those ordinals.

    Returns `(inputs_dir, {Path: ordinal})`. `members` overrides the member list, which is
    how the ordinal-disagreement test builds a bundle whose staged order lies.
    """
    module = load_compute()
    declared = list(members if members is not None else module.DECLARED_MEMBERS)
    source = Path(source) if source is not None else FIXTURE
    inputs = Path(tmp_path) / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)

    ordinals, entries = {}, []
    for ordinal, member in enumerate(declared):
        src = source / "binned_outputs" / member
        dest = inputs / f"{ordinal}_{Path(member).name}"
        shutil.copyfile(src, dest)
        ordinals[dest] = ordinal
        entries.append({
            "slot": f"bundle_{ordinal}",
            "kind": "dataset-file",
            "sandbox_path": f"/inputs/{dest.name}",
        })
    if write_inputs_json:
        (inputs / "inputs.json").write_text(json.dumps({"inputs": entries}),
                                            encoding="utf-8")
    return inputs, ordinals


#: The environment that really does give a CPython subprocess a non-UTF-8 preferred encoding:
#: `PYTHONUTF8=0` turns PEP 540 off, `PYTHONCOERCECLOCALE=0` turns PEP 538's C -> C.UTF-8
#: coercion off, and `LC_ALL=C`/`LANG=C` then yield `ANSI_X3.4-1968`. All four are needed;
#: drop any one and the subprocess is back in UTF-8 and a locale test proves nothing — which
#: is why the caller asserts the encoding it actually got before believing the result.
ASCII_LOCALE_ENV = {"PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C", "LANG": "C"}


def _entry_invocation(inputs_dir, outputs_dir, env, params):
    """The child environment both entrypoint drivers share.

    ONE spelling of the invocation: a second copy is a driver that answers differently in two
    places, and the two would then differ in exactly the way that makes a refusal test prove
    nothing.
    """
    inputs_dir = Path(inputs_dir)
    inputs_dir.mkdir(parents=True, exist_ok=True)
    (inputs_dir / "params.json").write_text(json.dumps(params or {}), encoding="utf-8")
    if not (inputs_dir / "inputs.json").exists():
        (inputs_dir / "inputs.json").write_text(json.dumps({"inputs": []}), encoding="utf-8")

    child = dict(os.environ)
    child["CYTO_INPUTS_DIR"] = str(inputs_dir)
    child["CYTO_OUTPUTS_DIR"] = str(outputs_dir)
    child["PYTHONPATH"] = os.pathsep.join([str(PKG / "compute"), str(PACKAGES / "_lib")])
    if env:
        child.update(env)
    return [sys.executable, str(COMPUTE)], child


def run_entry(inputs_dir, outputs_dir, *, env=None, params=None, timeout=1800):
    """Run the entry as `main()` does in production — a SUBPROCESS over the `CYTO_*` seam.

    A subprocess and not an in-process call, because `main()`'s refusal path is `sys.exit(2)`
    and because the sandbox runs it exactly this way: one entry file, the declared helpers
    beside it, and `_lib` staged in. Anything this driver can reach, the server can.
    """
    argv, child = _entry_invocation(inputs_dir, outputs_dir, env, params)
    return subprocess.run(argv, capture_output=True, text=True, env=child, timeout=timeout)


def run_entry_bytes(inputs_dir, outputs_dir, *, env=None, params=None, timeout=1800):
    r"""[`run_entry`], with stdout/stderr captured as **BYTES**.

    `text=True` DECODES, and decoding hides exactly the half of the refusal contract that
    matters: a raw `\r` or `\x07` survives into the `str` but is invisible to every assertion
    a reader would naturally write; a raw `\n` becomes an ordinary newline, indistinguishable
    from the message's own — and that raw `\n` IS the attack, because
    `scheduler.rs::drain_logs` reads stderr with `BufReader::lines()` and writes EACH LINE as
    its own `job_logs` row, so a vendor-supplied newline forges a log row.

    The control characters ARE the payload, so the payload must not be decoded away before
    the assertion sees it.
    """
    argv, child = _entry_invocation(inputs_dir, outputs_dir, env, params)
    return subprocess.run(argv, capture_output=True, env=child, timeout=timeout)


def output_paths(outputs_dir):
    """Every path under `outputs_dir`, as the ZERO-PARTIAL-STORE assertion measures it.

    On the FILESYSTEM, not by exception type. A refusal that raised the right class and left
    a half-written `expression.zarr` behind is still a partial store, and the only way to see
    that is to look.
    """
    root = Path(outputs_dir)
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))
