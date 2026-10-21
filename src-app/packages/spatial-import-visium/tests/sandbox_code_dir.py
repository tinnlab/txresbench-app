#!/usr/bin/env python3
# ruff: noqa
"""Build the `/code` directory a real sandboxed compute gets — parsed from the SHIPPED Rust.

## Why this exists, and what it corrects

A reachability measurement is only worth what its model of the sandbox is worth. The
existing measurement in `test_sandbox_reachability.py` (#155) set `PYTHONPATH` to the
package's `compute/` plus `_lib`. **Production does neither of those things.**

* `sandbox.rs` launches under `--clearenv`, so `PYTHONPATH` is not merely unset — the
  whole environment is wiped before any `--setenv`.
* `runner.rs::stage_and_launch` writes a **FLAT `/code` directory**: the entry script
  under its canonical filename, plus every module in `resolved.helpers`, all side by side.
  It then runs `python3 /code/entry.py`, and `sys.path[0]` is that directory. There is no
  package structure, no `compute/` subdirectory, and no `_lib` on the path — the modules
  from `_lib` are COPIES sitting flat beside the entry.

The difference is not cosmetic. A `PYTHONPATH` model puts whole DIRECTORIES on the path,
so a reader that imported some module the platform does not actually stage would resolve
fine in the test and die with `ModuleNotFoundError` at process start in production —
which reaches the server as an opaque job failure with no hint of the cause. Modelling
the flat dir makes that a red test instead.

## What is staged, and where the list comes from

Two sources, both read from the shipped tree rather than restated here:

1. **`PY_HELPER_FILES`** (`src-app/server/src/modules/sandbox/processors/mod.rs`) — the
   app's cross-cutting modules staged alongside EVERY Python entry. Parsed out of the Rust
   const so that a module added to or removed from that table changes this harness without
   anyone remembering to. Deliberately NOT a hardcoded list: a hardcoded list is a second
   spelling of a fact the platform already owns, and the two would drift.
2. **the package's own `run.helpers`** — the intra-package siblings a manifest entry
   declares. This is how `spatial_declarations.py` reaches a compute at all.

`conformance.py` is deliberately NOT staged: it is entry-scoped to the reserved
verification entry (`RESERVED_ENTRY_HELPERS`) precisely so the framework's gate is not
importable from inside the process it judges. A harness that staged it would be modelling
a sandbox the tree does not ship.

## The parser refuses to match nothing

If the Rust table is renamed, moved or restructured, [`py_helper_files`] RAISES. A parser
that quietly returned `[]` would leave the `/code` dir with only the entry in it, and the
consumer subprocess would then fail for a reason that has nothing to do with what the test
is measuring — or, worse, pass, because a consumer needing no helper would still run. The
same discipline `inputs_json_fields_from_rust` uses on `struct InputsJsonEntry`.
"""
import re
import shutil
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
SERVER = PACKAGES.parent / "server"
_PROCESSORS_RS = SERVER / "src" / "modules" / "sandbox" / "processors" / "mod.rs"

#: The reserved package ids the Rust const refers to by symbol. Read from the same file so
#: a rename shows up here as a raise rather than as a silently-empty stage.
_RESERVED_SYMBOLS = ("RESERVED_HELPER_PACKAGE", "RESERVED_LIB_PACKAGE")


def _reserved_package_dirs():
    """`{symbol: package-directory-name}` for the reserved packages, read from the Rust."""
    source = _PROCESSORS_RS.read_text()
    out = {}
    for symbol in _RESERVED_SYMBOLS:
        match = re.search(rf'{symbol}\s*:\s*&str\s*=\s*"([^"]+)"', source)
        if not match:
            raise AssertionError(
                f"could not read `{symbol}` out of {_PROCESSORS_RS} — it was renamed or "
                "moved, so this harness no longer models the shipped staging"
            )
        out[symbol] = match.group(1)
    return out


def py_helper_files():
    """`[(staged_name, package_dir, rel_path)]` — the GLOBAL helper table, from the Rust.

    Parses the body of `pub const PY_HELPER_FILES` and returns one triple per entry, with
    the reserved-package SYMBOLS resolved to real directory names. Raises rather than
    returning an empty list when the const cannot be found or yields no entries — see the
    module docstring.
    """
    source = _PROCESSORS_RS.read_text()
    match = re.search(
        # `\n\s*\];` — NOT `\n\];`. With the bare form an INDENTED closing `];` (a
        # rustfmt change, or a nested one) is not matched, the non-greedy body runs on
        # into the NEXT const, and entries from a table that is not this one get staged.
        # Measured: a decoy `const OTHER` after an indented `];` was parsed as live.
        r"pub const PY_HELPER_FILES:\s*&\[\(&str, &str, &str\)\]\s*=\s*&\[(.*?)\n\s*\];",
        source, re.S,
    )
    if not match:
        raise AssertionError(
            f"could not find `pub const PY_HELPER_FILES` in {_PROCESSORS_RS} — it was "
            "renamed, moved or re-typed, so this harness is no longer anchored to the "
            "shipped staging table"
        )
    body = match.group(1)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)   # block comments
    body = re.sub(r"//[^\n]*", "", body)                 # line comments
    if "#[" in body:
        # REFUSE rather than guess. A `#[cfg(...)]` inside the table means some entries are
        # staged only under some build configurations, and this parser has no notion of
        # which. Stripping the attribute and keeping the entry would stage a module
        # production does not; dropping the attribute's entry would need a model of the
        # cfg. Neither is a guess worth making silently, and the whole posture of this
        # module is that a harness which mis-models `/code` is worse than one that stops.
        raise AssertionError(
            "`PY_HELPER_FILES` now contains a `#[...]` attribute, so some entries are "
            "conditionally staged. This parser models an unconditional table and will not "
            "guess which arm a real job gets — teach it the condition, or stop using it."
        )

    symbols = _reserved_package_dirs()
    entries = []
    for staged, package, rel in re.findall(
        r'\(\s*"([^"]+)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\s*,\s*"([^"]+)"\s*,?\s*\)',
        body,
    ):
        package = package.strip('"')
        if package not in symbols and not (PACKAGES / package).is_dir():
            # NOT `symbols.get(package, package)`. That fell back to the raw Rust SYMBOL
            # as a directory name, `stage_code_dir`'s `is_file()` then found nothing, and
            # the helper was silently not staged — precisely the "the /code dir holds only
            # the entry and the measurement is about something else" failure this module
            # says it exists to prevent, arriving through the quiet door.
            raise AssertionError(
                f"`PY_HELPER_FILES` names package {package!r}, which is neither a symbol "
                f"this parser resolves ({sorted(symbols)}) nor a directory under "
                f"{PACKAGES}. A new reserved-package symbol was added to the Rust; teach "
                "`_RESERVED_SYMBOLS` about it rather than staging nothing for it."
            )
        entries.append((staged, symbols.get(package, package), rel))
    if not entries:
        raise AssertionError(
            "parsed ZERO entries out of `PY_HELPER_FILES`. A check that quietly matches "
            "nothing is the failure mode this parser exists to avoid: the staged `/code` "
            "dir would hold only the entry script and the measurement would be about "
            f"something else entirely.\nbody was:\n{match.group(1)[:400]}"
        )
    return entries


def declared_helpers(package_dir):
    r"""The intra-package sibling modules a package's `manifest.yaml` declares under `run.helpers`.

    A deliberately small YAML read rather than a dependency on a YAML parser being
    installed in every environment this suite runs in. Returns a sorted, de-duplicated
    list of package-relative paths (the manifest spells them `compute/<name>.py`; staging
    flattens them to their basename).

    ## Three bugs this shape had, all of which returned `[]` SILENTLY

    Measured against hand-built manifests, not reasoned about:

    * `^(\s*)helpers:` — `\s` **spans newlines**, so with blank lines before the key the
      captured indent included them and computed LARGER than the real item indent; the
      loop broke on the first item. `re.finditer` picks the leftmost match, so this was
      deterministic, not luck. Fixed with `[ \t]`.
    * list items at the SAME indent as the key (valid YAML) broke immediately on the
      `<= indent` test. Now accepted.
    * the scan was not scoped to `run:`, so every `helpers:` in the file was unioned —
      including a `verify:` entry's, which is exactly the entry-scoped staging this
      module's own docstring argues must NOT be modelled as global.

    And the outcome of all three was the failure the module header names: a `/code` dir
    with no `spatial_declarations.py`, and a subprocess dying of `ModuleNotFoundError` for
    a reason with nothing to do with what the test measures. So an empty result now
    RAISES.
    """
    text = (Path(package_dir) / "manifest.yaml").read_text(encoding="utf-8")
    lines = text.splitlines()

    def indent_of(line):
        return len(line) - len(line.lstrip())

    names = set()
    for i, line in enumerate(lines):
        if not re.match(r"^[ \t]*helpers:[ \t]*(#.*)?$", line):
            continue
        # SCOPED TO `run:` — walk back to the nearest enclosing key at a smaller indent
        # and require it to be `run:`. A `verify:`/`gate:` block's helpers are staged for
        # THAT entry only, and unioning them here would model a sandbox the tree does not
        # ship.
        key_indent = indent_of(line)
        owner = None
        for prev in range(i - 1, -1, -1):
            candidate = lines[prev]
            if not candidate.strip() or candidate.strip().startswith("#"):
                continue
            if indent_of(candidate) < key_indent:
                owner = candidate.strip().rstrip(":")
                break
        if owner != "run":
            continue
        for follow in lines[i + 1:]:
            stripped = follow.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if not stripped.startswith("- "):
                break
            if indent_of(follow) < key_indent:
                break
            names.add(stripped[2:].strip().strip("\"'"))
    if not names:
        raise AssertionError(
            f"parsed ZERO `run.helpers` entries out of {package_dir}/manifest.yaml. A "
            "package whose compute imports a sibling declares it there, so an empty "
            "result means either the manifest changed shape or this reader is wrong — "
            "and either way the modelled `/code` dir would be missing the module the "
            "measurement depends on."
        )
    return sorted(names)


def stage_code_dir(dest, package_dir, entry_source, *, entry_name="entry.py"):
    """Assemble the FLAT `/code` dir a real compute is launched with, and return it.

    `entry_source` is the Python source of the consumer to run. Everything else is copied
    from the shipped tree: every `PY_HELPER_FILES` module, then the package's own declared
    `run.helpers`. Flat, side by side, exactly as `stage_and_launch` writes them.
    """
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for staged_name, package, rel in py_helper_files():
        src = PACKAGES / package / rel
        if not src.is_file():
            # RAISE, matching `declared_helpers`' path below. The `if src.is_file()` this
            # replaces was the module's own discipline applied to the parser and not to
            # the stager: a module the platform stages and this harness cannot find means
            # the /code model is wrong, and a smaller /code dir must not pass quietly.
            raise AssertionError(
                f"`PY_HELPER_FILES` stages {staged_name!r} from {src}, which does not "
                "exist. Production would stage it; this harness cannot, so the modelled "
                "/code dir is not the one a real compute gets."
            )
        shutil.copyfile(src, dest / staged_name)
    for rel in declared_helpers(package_dir):
        src = Path(package_dir) / rel
        if not src.is_file():
            raise AssertionError(
                f"the manifest declares `run.helpers` entry {rel!r} but {src} does not "
                "exist — production would stage nothing for it and the entry would die "
                "with ModuleNotFoundError at process start"
            )
        # FLAT, by BASENAME: `/code` has no subdirectories, which is why a compute says
        # `import spatial_declarations` and not `from compute import ...`.
        shutil.copyfile(src, dest / Path(rel).name)
    (dest / entry_name).write_text(entry_source)
    return dest
