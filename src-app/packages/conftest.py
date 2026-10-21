# Import-path wiring shared by EVERY processor test suite.
#
# The sandbox runner assembles ONE `/code` dir per job: the entry script, the package's
# own declared siblings, and the app's cross-cutting modules — the `_helpers` compute
# helpers and the `_lib` OUTPUT-FORMAT library (`cyto_zarr` / `cyto_columns`, DEC-7).
# A compute script therefore says `import cyto_columns` at module scope, and a suite
# that loads that script by path (importlib) has to resolve the same names or it dies
# with `ModuleNotFoundError` before the first assertion.
#
# This conftest mirrors that staging for the suites. It lives at the `packages/` root
# so it covers every package; `_helpers/conftest.py` repeats the same wiring for the
# standalone `_helpers` runner, which anchors its own rootdir.
import os
import sys

_PROCESSORS = os.path.dirname(os.path.abspath(__file__))

for _name in ("_helpers", "_lib", "annotation-integrate"):
    _p = os.path.join(_PROCESSORS, _name)
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ── #80: stage a DEPENDENCY CONTRACT for the suites, the way the sandbox does ─────────
#
# In production the server serializes the entry's declared `run.dependencies[]` into the
# same `/code` dir it stages this module into, and `cyto_deps` reads it from beside
# itself. A pytest process is not a staged `/code` dir — it imports these modules straight
# out of the source tree — so without this, every suite would run with NO contract and the
# reports they assert over would carry an empty `library_versions`. That is not a smaller
# version of production; it is the mechanism switched off by accident, which is exactly
# what a harness must not silently do.
#
# WHAT IS STAGED, and the one honest compromise. The contract is built from the SHIPPED
# manifests — the same declarations the build gate reads — but reduced to the entries this
# machine can actually satisfy. A developer's interpreter is not the analysis environment
# image: it typically has a few of these libraries at other versions and some not at all.
# Enforcing the sandbox's ranges here would turn "your laptop differs from the published
# image" into a wall of red in suites that are testing compute logic, not the environment.
#
# Note precisely what the reduction does and does not weaken. It narrows the SUBJECT SET
# the harness stages; it does not touch the enforcement, which has no off switch and is
# unchanged. Every library that IS staged is really resolved and really range-checked, so
# the suites exercise the real code path, and the full declared contract is enforced where
# it matters — at build time against the recipe (`processor_manifest.rs`) and at run time
# inside the sandbox against the published image.
import json as _json
import tempfile as _tempfile


def _stage_dependency_contract():
    try:
        import cyto_deps as _deps
        from packaging.specifiers import SpecifierSet as _Spec
        from packaging.version import Version as _Ver
        from importlib.metadata import PackageNotFoundError as _NotFound
        from importlib.metadata import version as _dist_version
    except Exception:
        return  # the recorder or its comparator is unavailable; leave the default alone

    declared = {}
    optional_libs = set()
    for _entry in sorted(os.listdir(_PROCESSORS)):
        _mf = os.path.join(_PROCESSORS, _entry, "manifest.yaml")
        if not os.path.isfile(_mf):
            continue
        # A dependency-free YAML scrape: the block is a flat list of
        # `- { library: <name>, version: "<spec>" }` lines, so a regex is enough and the
        # harness gains no parser dependency of its own.
        import re as _re

        # The trailing `[^}]*` is load-bearing: an earlier form required `}` immediately
        # after the version's closing quote, so ANY declaration carrying a third key was
        # silently dropped. The only such declaration in the tree is the `optional: true`
        # one — so the harness staged no optional entry and that whole runtime path was
        # exercised by no python test, which is precisely the "the harness switches the
        # mechanism off by accident" failure this block exists to prevent. It would have
        # recurred for every future declaration that grew a key.
        for _lib, _spec, _rest in _re.findall(
            r"-\s*\{\s*library:\s*([A-Za-z0-9_.\-]+)\s*,\s*version:\s*\"([^\"]+)\"([^}]*)\}",
            open(_mf, encoding="utf-8").read(),
        ):
            # Two packages may declare different ranges for one library. Keep BOTH and
            # stage the entry only when the local version satisfies every one of them —
            # `setdefault` kept whichever package sorted first, which silently checked
            # against another package's wider range.
            declared.setdefault(_lib, []).append(_spec)
            if "optional: true" in _rest:
                optional_libs.add(_lib)

    satisfiable = []
    for _lib, _specs in sorted(declared.items()):
        _entry = {"library": _lib, "version": _specs[0]}
        if _lib in optional_libs:
            _entry["optional"] = True
        try:
            _resolved = _dist_version(_lib)
        except _NotFound:
            # An OPTIONAL declaration is staged even when the library is absent — that is
            # the branch whose whole point is "absence does not refuse", and staging only
            # what resolves would leave it unexercised by every suite.
            if _lib in optional_libs:
                satisfiable.append(_entry)
            continue
        except Exception:
            continue
        try:
            if all(_Ver(_resolved) in _Spec(_s) for _s in _specs):
                satisfiable.append(_entry)
        except Exception:
            continue

    _dir = _tempfile.mkdtemp(prefix="cyto-test-contract-")
    # Removed at interpreter exit: this runs once per pytest invocation, and an unremoved
    # temp dir per run is a slow leak on a machine that runs these suites often.
    import atexit as _atexit
    import shutil as _shutil

    _atexit.register(_shutil.rmtree, _dir, True)
    with open(os.path.join(_dir, _deps.CONTRACT_FILENAME), "w", encoding="utf-8") as _fh:
        _json.dump(satisfiable, _fh)
    _deps.DEFAULT_CODE_DIR = _dir
    # …and for the suites that run a compute entry as a SUBPROCESS, which does not inherit
    # a module attribute set in this process.
    os.environ[_deps.CODE_DIR_ENV] = _dir


_stage_dependency_contract()
