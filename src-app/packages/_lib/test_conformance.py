#!/usr/bin/env python3
# ruff: noqa
"""TEST-25 / TEST-4b — the FRAMEWORK-OWNED conformance gate (ITEM-18) and the
producer-side `key_sequence_digest` (ITEM-19).

Two claims are under test here and they are different in kind.

The first is ordinary: the gate catches artifacts whose bytes and declaration disagree.
Every case below corrupts ONE thing about a REAL artifact written by the REAL writer —
truncate a shard, edit a declared dtype, delete a member, lie about nnz — and asserts the
gate names it. A gate built by writing a broken artifact by hand would only prove that the
hand-written thing is broken.

The second claim is structural and is the reason ITEM-18 exists at all (D27: "author-written
tests are the weak link — the same agent writes the bug and the test that certifies it").
The gate has to be UNWEAKENABLE by the processor author. That is not a promise this file
can make by asserting good intentions; it is a property of there being no key, argument or
environment variable to weaken. `test_no_declared_opt_out_weakens_the_gate` goes through
every shape an opt-out could plausibly take and shows each one is inert, and
`test_the_gate_is_not_reachable_from_the_processors_own_process` pins the placement that
makes DEC-8's "invoked by the ingest path, not by the processor" true rather than aspired to.

## The `depth` parametrization — why a violation test asserts BOTH arms

A violation test used to be written `conform_artifact(root, structure)`, i.e. at the BOUNDED
depth, which production never takes (`gate` / `conform_manifest` / `conform_outputs` /
`verify_conformance.py` are all `full=True`). ~30 substantive tests — nnz, dtype, length,
geometry, levels, offsets, digests — therefore proved rejection only on the arm nobody runs.
That is the same shape as the defect they were written to catch: hardening the arm production
does not take. Measured, the faults they inject are in fact rejected at both depths, so this
was never a live hole — but "we measured it once" is not a property, and `full` is already
branched on in two places (`_shard_plan`, and `_conform_sparse_csc`'s row-ordering check), so a
future check CAN become depth-sensitive.

So a substantive violation test takes `depth` and passes `full=depth`:

    @pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
    def test_a_thing_is_rejected(tmp_path, depth):
        ...
        violations = conformance.conform_artifact(root, structure, full=depth)

27 tests do. The property it buys: a check that becomes depth-sensitive fails LOUDLY at
whichever arm loses it — `if full and …` fails the `[bounded]` cell, and `if not full and …`
(the direction that would silently drop a check from production) fails the `[full]` cell. Both
were verified by injection, not assumed.

**Write a new violation test this way.** The exceptions are the handful of tests whose SUBJECT
is the depth contract itself (`..._passes_at_both_depths`,
`test_the_bounded_depth_really_samples...`, `test_the_full_depth_detects_everything...`,
`test_a_blanked_shard_index_slot...`, `test_a_matrix_with_unsorted_row_ids_is_rejected_at_full_depth`,
`test_the_real_writers_chunk_keys_are_accepted`): those name both arms explicitly in one body,
because the pairing IS the assertion, and a `depth` parameter would restate one arm and hide it.
"""
import ast
import importlib.util
import itertools
import json
import os
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import conformance
import cyto_csc
import cyto_zarr as cz
import cyto_zarr_read


# ── fixtures: REAL artifacts from the REAL writers ───────────────────────────────


def a_table(root, n=5000):
    """A table with one member of each kind, written the way a processor writes one."""
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32")
        t.categorical("group", codes=[i % 3 for i in range(n)], levels=["a", "b", "c", "d"])
        t.string("label", [f"row-{i:05d}" for i in range(n)])
        return t.close()


def a_matrix(root, n_rows=40, n_cols=6):
    """A CSC matrix from the real transpose: entity `r` carries column `r % n_cols`."""
    dense = np.zeros((n_rows, n_cols), dtype=np.float32)
    for r in range(n_rows):
        dense[r, r % n_cols] = float(r % n_cols) + 1.0
    return cyto_csc.write_csc_zarr(cyto_csc.ArraySource(dense), root, axes=("rows", "columns"))


def declare_levels(root, structure, col, levels):
    """Re-declare a categorical member's level set COHERENTLY across all three copies.

    A categorical's set now lives in three places with two shapes: the member's stamped
    `attributes.cyto.levels` (the list, and the only copy any reader resolves through),
    and the row's `levels_digest` + `n_levels` (the digest and the count). A test that
    edits one of them is testing the drift check, not whatever it meant to test — so a
    test that wants to change WHAT IS DECLARED changes all three, here.

    Returns nothing; mutates `structure` in place and rewrites the member's zarr.json. The
    caller still `restamp`s if it wants the group stamp to agree.
    """
    structure["columns"][col]["levels_digest"] = cz.key_sequence_digest(levels)
    structure["columns"][col]["n_levels"] = len(levels)
    member = Path(root) / structure["columns"][col]["path"] / "zarr.json"
    node = json.loads(member.read_text())
    node["attributes"]["cyto"]["levels"] = levels
    member.write_text(json.dumps(node, indent=2, ensure_ascii=False))


def restamp(root, structure):
    """Rewrite the group's stamped declaration so a test that edits the RETURNED structure
    is testing the check it means to, not tripping the group/row drift check first."""
    node = json.loads((Path(root) / "zarr.json").read_text())
    node["attributes"]["cyto"] = structure
    (Path(root) / "zarr.json").write_text(json.dumps(node, indent=2, ensure_ascii=False))


# ── DEC-8 property 2: the gate runs OUTSIDE the processor's process ─────────────


#: The server's globally-staged helper table (`PY_HELPER_FILES` in
#: `sandbox/processors/mod.rs`) — the modules copied into EVERY Python entry's `/code`
#: dir, i.e. every module that runs inside the processor's own process. Read out of the
#: Rust source rather than typed here so the guard below cannot fall behind the table it
#: is guarding: a module added there is guarded on the next run, and a module RENAMED
#: there fails `test_the_staged_module_table_is_read_not_guessed` instead of quietly
#: dropping out of the scan.
_SERVER_PROCESSORS_RS = (
    Path(__file__).resolve().parents[2]
    / "server/src/modules/sandbox/processors/mod.rs"
)


def _staged_module_files():
    """`{staged_name: absolute path}` for every globally-staged Python helper.

    Parses the `PY_HELPER_FILES` table's `("<staged>.py", <PACKAGE_CONST>, "<rel>")` rows
    and resolves each against the reserved package it names.
    """
    assert _SERVER_PROCESSORS_RS.is_file(), (
        f"the staged-module table is not at {_SERVER_PROCESSORS_RS} — this guard derives "
        "its scan list from that table and must fail loudly rather than scan nothing"
    )
    source = _SERVER_PROCESSORS_RS.read_text()
    body = source.split("pub const PY_HELPER_FILES", 1)[1].split("];", 1)[0]
    packages = {"RESERVED_HELPER_PACKAGE": "_helpers", "RESERVED_LIB_PACKAGE": "_lib"}
    processors_root = Path(__file__).resolve().parents[1]
    out = {}
    for staged, package, rel in re.findall(
        r'"([^"]+\.py)"\s*,\s*(RESERVED_\w+)\s*,\s*"([^"]+)"', body
    ):
        out[staged] = processors_root / packages[package] / rel
    return out


def test_the_staged_module_table_is_read_not_guessed():
    """The guard below is only as good as the list it walks, so the list is derived.

    A hardcoded list is the failure this test exists to prevent: the previous version
    named four modules while the server staged SIX, so `align.py` and `colsummary.py`
    could import the gate and nothing would notice. Parsing the table means the scan
    covers whatever is staged today; these assertions are the tripwire for the parse
    itself silently returning nothing.
    """
    staged = _staged_module_files()
    assert len(staged) >= 6, f"the staged table parsed to {sorted(staged)}"
    for expected in ("cyto_zarr.py", "cyto_csc.py", "align.py", "colsummary.py"):
        assert expected in staged, f"{expected} missing from the parsed table: {sorted(staged)}"
    for name, path in staged.items():
        assert path.is_file(), f"staged module {name} does not resolve to {path}"


def _imports_conformance(source):
    """Every way `source` pulls the gate into its own process, by PARSING it.

    A substring scan for `"import conformance"` is what this replaces, and it leaked in
    both directions: `from conformance import gate` does not contain that substring, and
    `importlib.import_module("conformance")` contains neither half. The AST sees all
    three shapes and sees no false positive in prose or a comment, which is what the old
    scan's comment-stripping was fumbling toward.
    """
    hits = []
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            hits += [a.name for a in node.names if a.name.split(".")[0] == "conformance"]
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".")[0] == "conformance":
                hits.append(node.module)
        elif isinstance(node, ast.Call):
            # `importlib.import_module("conformance")` / `__import__("conformance")`.
            fn = node.func
            name = getattr(fn, "attr", None) or getattr(fn, "id", None)
            if name in ("import_module", "__import__") and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    if arg.value.split(".")[0] == "conformance":
                        hits.append(arg.value)
    return hits


def test_the_gate_is_not_reachable_from_the_processors_own_process():
    """The placement claim, asserted on the code rather than promised in a comment.

    Every module in the server's `PY_HELPER_FILES` table is staged into the sandbox
    `/code` dir, so whatever it imports runs AS the processor. A gate there would be a
    gate the processor's own process executes — the arrangement DEC-8 rules out — and it
    would additionally die with `ModuleNotFoundError` at job start, because `/code` is
    assembled from that table alone and this module is deliberately not in it.

    So the rule is: no staged module imports this one. That is what makes "invoked by the
    ingest path, not by the processor" a fact about the import graph instead of an
    intention — provided the scan sees every staged module (it derives the list) and every
    import shape (it parses rather than greps). Both of those were holes.
    """
    staged = _staged_module_files()
    for name, path in sorted(staged.items()):
        hits = _imports_conformance(path.read_text())
        assert not hits, (
            f"{name} is staged into the sandbox `/code` dir and imports {hits} — that puts "
            "the framework gate inside the process it is meant to judge (DEC-8), and it "
            "will not even resolve there unless the staging table is changed too"
        )


#: The server's ENTRY-SCOPED staging table (`RESERVED_ENTRY_HELPERS`) — the one route by
#: which the gate is legitimately reachable, and therefore the one exemption below. Parsed
#: out of the Rust source for the same reason the table above is: an exemption typed by hand
#: is an exemption that outlives its reason.
def _reserved_entry_code_refs():
    """`{code_ref}` for every entry the server stages a reserved helper into."""
    source = _SERVER_PROCESSORS_RS.read_text()
    body = source.split("const RESERVED_ENTRY_HELPERS", 1)[1].split("];", 1)[0]
    # `(CODE_REF_CONST_or_literal, "staged.py", PACKAGE_CONST, "rel")`
    consts = dict(
        re.findall(r'pub const (\w+): &str = "([^"]+)"', source)
    )
    refs = set()
    for ref in re.findall(r"\(\s*([A-Za-z_][\w]*|\"[^\"]+\")\s*,", body):
        refs.add(consts.get(ref, ref.strip('"')))
    assert refs, "the entry-scoped staging table parsed to nothing"
    return refs


def _files_that_run_as_a_processor():
    """Every shipped `.py` that can end up executing INSIDE a processor's own process.

    DEFAULT-DENY: the whole processors tree, minus a derived exemption set. The previous
    scan enumerated only the modules in `PY_HELPER_FILES`, which is a strict subset — it
    never opened an ENTRY script. An entry that imports the gate is a processor reaching
    the gate just as surely as a staged helper that does, and it was unguarded on both
    sides (the Rust twin built its module set from the same table, so the NAME
    `conformance` appeared in neither scan).

    The exemptions, each with its reason:

    * `conformance.py` — the gate itself.
    * every `code_ref` in `RESERVED_ENTRY_HELPERS` — the verification entry, which is
      staged the gate deliberately and exists to run it (DEC-12). Derived from the table,
      so it cannot become a stale blanket for some other file.
    * pytest files (`test_*.py`, `conftest.py`, anything under a `tests/` dir) — run by
      pytest ON THE HOST, never staged into a `/code` dir, and the gate's own tests must
      obviously be able to import it.
    """
    processors_root = Path(__file__).resolve().parents[1]
    exempt_refs = _reserved_entry_code_refs()
    out = {}
    for path in sorted(processors_root.rglob("*.py")):
        rel = path.relative_to(processors_root)
        parts = rel.parts
        if any(p == "tests" for p in parts):
            continue
        if path.name.startswith("test_") or path.name == "conftest.py":
            continue
        if path.name == "conformance.py":
            continue
        # A reserved code_ref is package-relative (`verify_conformance.py`), so compare
        # against the path WITHOUT its package segment.
        if "/".join(parts[1:]) in exempt_refs:
            continue
        out[str(rel)] = path
    assert out, "the processor-tree scan found no files — it would pass everything"
    return out


def test_no_file_that_runs_as_a_processor_imports_the_gate():
    """The placement claim, widened to every route a processor can reach the gate BY.

    `test_the_gate_is_not_reachable_from_the_processors_own_process` above asserts it for
    the globally-staged helpers. This asserts it for the whole shipped tree, so an ENTRY
    script — or a package sibling, or a module nothing has staged yet — cannot import the
    gate and stay green.
    """
    for rel, path in sorted(_files_that_run_as_a_processor().items()):
        hits = _imports_conformance(path.read_text())
        assert not hits, (
            f"{rel} runs as (or inside) a processor and imports {hits} — a processor "
            "cannot be allowed to call the gate that judges it (DEC-8). The ONE entry "
            "that may is the verification entry, which the server stages the gate for "
            "explicitly (RESERVED_ENTRY_HELPERS)"
        )


def test_the_widened_scan_actually_reaches_entry_scripts():
    """NON-VACUITY for the widening: the scan opens entries, not just staged helpers.

    The failure mode this guards is the one it replaces — a scan whose file set silently
    shrinks back to the staged table and keeps reporting green. So: the set must contain
    files that are NOT in `PY_HELPER_FILES`, must contain at least one `compute/` entry,
    and must NOT contain the two things that would make it fail for the wrong reason.
    """
    scanned = _files_that_run_as_a_processor()
    staged_names = set(_staged_module_files())
    assert any(Path(rel).name not in staged_names for rel in scanned), (
        f"the scan sees only staged helpers: {sorted(scanned)}"
    )
    assert any("compute/" in rel.replace("\\", "/") for rel in scanned), (
        f"the scan opened no `compute/` entry script: {sorted(scanned)}"
    )
    assert not any(Path(rel).name == "conformance.py" for rel in scanned)
    assert not any(Path(rel).name == "verify_conformance.py" for rel in scanned), (
        "the verification entry must be exempt — it exists to RUN the gate"
    )
    # …and the exemption is the DERIVED one, not a hand-typed name.
    assert "verify_conformance.py" in _reserved_entry_code_refs()


def test_the_widened_scan_would_catch_an_entry_that_reached_the_gate(tmp_path):
    """The scan is default-deny, so prove the CLASSIFIER admits a would-be offender.

    A file dropped where a processor entry lives is scanned; one under `tests/` is not.
    Asserted on the classifier's own rules rather than by writing into the shipped tree.
    """
    root = tmp_path / "processors"
    (root / "somepkg" / "compute").mkdir(parents=True)
    (root / "somepkg" / "tests").mkdir()
    entry = root / "somepkg" / "compute" / "entry.py"
    entry.write_text("from conformance import gate\n")
    (root / "somepkg" / "tests" / "test_x.py").write_text("import conformance\n")
    # The classifier's rules, applied to this tree the same way the real scan applies them.
    admitted = {
        str(p.relative_to(root))
        for p in sorted(root.rglob("*.py"))
        if "tests" not in p.relative_to(root).parts
        and not p.name.startswith("test_")
        and p.name != "conftest.py"
        and p.name != "conformance.py"
        and "/".join(p.relative_to(root).parts[1:]) not in _reserved_entry_code_refs()
    }
    assert admitted == {"somepkg/compute/entry.py"}
    assert _imports_conformance(entry.read_text()), "and the admitted file's import is seen"


@pytest.mark.parametrize(
    "line",
    [
        "import conformance",
        "import conformance as _c",
        "from conformance import gate",
        "from conformance import gate as g",
        "import conformance.something",
        "import importlib; importlib.import_module('conformance')",
        '__import__("conformance")',
    ],
)
def test_the_placement_guard_catches_every_import_shape(tmp_path, line):
    """NEGATIVE CONTROL on the guard itself, which is the part that was broken.

    The guard is a scan, and a scan that misses the shape an author actually writes is
    worse than none — it reports green over the exact arrangement it exists to forbid.
    Each shape below is one a real edit would produce; `from conformance import gate` and
    the `import_module` form both slipped past the substring scan this replaces.
    """
    assert _imports_conformance(line), f"the guard does not see `{line}`"


def test_the_placement_guard_does_not_fire_on_prose():
    """…and the other direction: naming the module in a docstring or comment is not an
    import, and a guard that failed on it would push authors to stop documenting the rule
    (every staged module's header discusses `conformance` today)."""
    prose = '"""conformance is deliberately not imported here."""\n# import conformance\n'
    assert _imports_conformance(prose) == []


def test_a_broken_artifact_is_caught_after_the_fact(tmp_path):
    """The gate does not need to be in the writer to catch a writer that went wrong.

    Something eats a member between the last write and ingest; the emitted artifact cannot
    be read. `gate()` over the emitted directory is what turns that into a loud failure
    instead of an artifact row pointing at bytes nobody can decode.
    """
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="rows", n=8) as t:
        t.numeric("value", np.arange(8, dtype=np.float32), dtype="float32")
        structure = t.close()
    (root / "value" / "c" / "0").unlink()
    with pytest.raises(conformance.ConformanceError, match="does not decode"):
        conformance.gate(root, structure)

def test_a_conforming_artifact_passes_at_both_depths(tmp_path):
    structure = a_table(tmp_path / "t.zarr")
    assert conformance.conform_artifact(tmp_path / "t.zarr", structure, full=False) == []
    assert conformance.conform_artifact(tmp_path / "t.zarr", structure, full=True) == []
    matrix = a_matrix(tmp_path / "m.zarr")
    assert conformance.conform_artifact(tmp_path / "m.zarr", matrix, full=False) == []
    assert conformance.conform_artifact(tmp_path / "m.zarr", matrix, full=True) == []
    # …and at both depths for real, over a MULTI-SHARD member. Everything above lands in
    # ONE shard (`shard_chunks` derives the count from `n`, capped), so `_shard_plan` returns
    # every shard for `full=False` too and the array is read whole — the two calls decode the
    # same bytes and "both depths" is one depth asserted twice. The fixture below is the
    # one that actually splits.
    multi = a_multi_shard_table(tmp_path / "many.zarr")
    assert conformance.conform_artifact(tmp_path / "many.zarr", multi, full=False) == []
    assert conformance.conform_artifact(tmp_path / "many.zarr", multi, full=True) == []


# ── the bounded depth: it must actually be bounded, and actually decode ──────────


def a_multi_shard_table(root, n=200, inner_chunk=16, chunks_per_shard=2):
    """A table whose members span MANY shards, so `full=False` genuinely samples.

    `SAMPLE_SHARDS = 2` and `shard_rows = inner_chunk * chunks_per_shard = 32`, so
    `n=200` is 7 shards: the bounded depth reads shards 0 and 6 and skips 1..5. The
    geometry is DECLARED explicitly (DEC-5 allows exactly that), which is also what a
    producer writing a >16.8M-element member reaches by a different route.
    """
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32",
                  inner_chunk=inner_chunk, chunks_per_shard=chunks_per_shard)
        t.categorical("group", codes=[i % 3 for i in range(n)], levels=["a", "b", "c"],
                      inner_chunk=inner_chunk, chunks_per_shard=chunks_per_shard)
        return t.close()


def test_the_bounded_depth_really_samples_and_the_full_depth_really_does_not(tmp_path):
    """The two halves of the `full=` contract, on a member that spans 7 shards.

    Neither half was covered: with the derived geometry every fixture fits in ONE shard,
    so `_decode_shards` — the entire sampling implementation — never executed, and the
    "bounded is bounded" claim rested on code no test had ever run.

    * corrupt shard 0 ⇒ the BOUNDED depth catches it, so the sample decodes real bytes
      rather than being a no-op that returns `[]` for everything.
    * corrupt a MIDDLE shard ⇒ the bounded depth misses it and `full=True` catches it,
      which is the only way to show the two depths differ at all. If both caught it, the
      bounded path is not bounded; if neither did, it is not decoding.
    """
    root = tmp_path / "many.zarr"
    structure = a_multi_shard_table(root)
    shards = sorted((root / "value" / "c").iterdir(), key=lambda p: int(p.name))
    assert len(shards) >= 4, f"the fixture must span several shards, got {len(shards)}"

    # (a) A MIDDLE shard: bounded reads only the first and the last, so it must miss.
    middle = shards[len(shards) // 2]
    saved = middle.read_bytes()
    middle.write_bytes(saved[:-64])
    assert conformance.conform_artifact(root, structure, full=False) == [], (
        "the bounded depth read a middle shard — then it is not bounded, and the "
        "`full=` distinction this module documents does not exist"
    )
    assert any(
        "does not decode" in v
        for v in conformance.conform_artifact(root, structure, full=True)
    ), "the full depth must decode every shard"
    middle.write_bytes(saved)

    # (b) The FIRST shard: bounded must catch it, or the sample is decoding nothing.
    first = shards[0]
    first.write_bytes(first.read_bytes()[:-64])
    assert any(
        "does not decode" in v for v in conformance.conform_artifact(root, structure, full=False)
    ), "the bounded depth must decode the shards it does sample"


def test_the_sampled_values_are_the_stored_ones_not_padding(tmp_path):
    """The sample feeds a value check (a categorical's code range), so it must carry the
    array's own values and nothing else.

    A chunk is ALWAYS `chunk_shape` elements — `ArrayWriter._emit` pads the tail with
    `fill_value` and `shape` is what bounds a reader — and the sampling path concatenated
    whole decoded chunks. So for any member whose length is not a multiple of the inner
    chunk, the sample carried values the array does not contain, and a range check over it
    was judging padding. Asserted as an exact equality because "it caught the violation
    anyway" would pass with the padding still in.

    Through `_decode(..., full=False)` — the function the gate itself calls — rather than
    through a test-only wrapper. It used to call `_decode_sample`, whose body was the
    expression `_decode` already inlines and whose only caller in the tree was this line: a
    second spelling of the one container reader, kept alive by the test that used it.
    """
    root = tmp_path / "tail.zarr"
    n = 199  # NOT a multiple of the 16-row inner chunk: the last chunk is padded
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(1, n + 1, dtype=np.float32), dtype="float32",
                  inner_chunk=16, chunks_per_shard=2)
        structure = t.close()

    meta = cyto_zarr_read.read_meta(root, "value")
    shard_rows = int(meta["chunk_grid"]["configuration"]["chunk_shape"][0])
    assert shard_rows == 32 and n > shard_rows * conformance.SAMPLE_SHARDS

    got, decode_errors = conformance._decode(root, "value", meta, full=False)
    assert decode_errors == [], decode_errors
    whole = cyto_zarr_read.read_array(root, "value")
    last = (n - 1) // shard_rows
    expected = np.concatenate(
        [whole[0:shard_rows], whole[last * shard_rows : n]]
    )
    assert got.tolist() == expected.tolist(), (
        "the bounded sample is not the stored rows of the first and last shard — a tail "
        f"padded with fill_value leaked in. got {len(got)} values, expected {len(expected)}"
    )


# ── the two depths must not DISAGREE, and the index checksum must be checked ─────
#
# The module documents that `full=` "only ever makes the check stricter". It did not, and it
# was wrong in the direction that matters: `full=True` — the ONLY depth production uses
# (`conform_outputs`, `verify_conformance.py`, `gate`) — went through
# `cyto_zarr_read.read_array`, which implements the Zarr rule "absent chunk ⇒ fill_value",
# while the bounded depth went through this module's own strict walker. So the weaker arm was
# the live one. Each test below pins one half of the fix.


def a_shard_body(root, member, shard=0):
    return (Path(root) / member / "c" / str(shard))


def edit_shard_index(path, per_shard, mutate, *, repair_crc=True):
    """Rewrite one shard's chunk index through `mutate(index)`, in place.

    `repair_crc=True` recomputes the trailer checksum, which is what isolates a test of the
    INDEX SEMANTICS from a test of the checksum: without it, every index edit would be
    caught by the crc32c check and the semantic checks below would never be exercised.
    """
    body = bytearray(path.read_bytes())
    trailer = per_shard * 16 + 4
    start, end = len(body) - trailer, len(body) - 4
    index = np.frombuffer(bytes(body[start:end]), dtype="<u8").copy().reshape(per_shard, 2)
    mutate(index)
    body[start:end] = index.tobytes()
    if repair_crc:
        body[end:] = cz.crc32c(index.tobytes()).to_bytes(4, "little")
    path.write_bytes(bytes(body))

def test_a_blanked_shard_index_slot_is_rejected_at_the_depth_PRODUCTION_uses(tmp_path):
    """A chunk marked EMPTY inside the array's declared shape — the case the FULL depth
    passed while the bounded depth caught it.

    The two arms did not share a container reader. `read_array` (what `full=True` called)
    honours the Zarr fill-value rule for an absent chunk, which is correct for a reader and
    wrong for a gate: `cyto_zarr` emits every chunk that covers logical rows, so an empty
    slot inside `shape` is a corrupt store. The consumer read below is what the artifact
    actually means to anybody downstream — a run of zeroes in the middle of the column —
    and the gate said `[]` about it.

    Both depths are asserted, in both directions: the bounded one still catches it (so this
    is not a test that passes by making everything fail), and the full one now does too.
    """
    root = tmp_path / "blank.zarr"
    n = 18
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(1, n + 1, dtype=np.int32), dtype="int32",
                  inner_chunk=4, chunks_per_shard=2)
        structure = t.close()

    meta = cyto_zarr_read.read_meta(root, "value")
    per_shard = 2
    assert int(meta["chunk_grid"]["configuration"]["chunk_shape"][0]) == 8

    # POSITIVE CONTROL: intact, both depths clean. Otherwise the assertions below could be
    # satisfied by a gate that rejects this fixture for an unrelated reason.
    assert conformance.conform_artifact(root, structure, full=False) == []
    assert conformance.conform_artifact(root, structure, full=True) == []

    edit_shard_index(
        a_shard_body(root, "value"), per_shard,
        lambda idx: idx.__setitem__(1, (cyto_zarr_read.EMPTY, cyto_zarr_read.EMPTY)),
    )

    # What a consumer now reads: rows 4..7 are fill_value, not the stored values.
    got = cyto_zarr_read.read_array(root, "value").tolist()
    assert got[:8] == [1, 2, 3, 4, 0, 0, 0, 0], (
        f"the fixture must actually corrupt the values a consumer sees, got {got}"
    )

    for full in (False, True):
        violations = conformance.conform_artifact(root, structure, full=full)
        assert any("marked empty but covers rows" in v for v in violations), (
            f"full={full}: a chunk marked EMPTY inside the array's shape must be a "
            f"violation — a reader silently substitutes fill_value for those rows. "
            f"Got {violations}"
        )


def test_a_shard_index_that_fails_its_crc32c_is_rejected(tmp_path):
    """The checksum the FORMAT writes for exactly this, which the gate was discarding.

    `cyto_zarr` writes `crc32c` over each shard's chunk index (`index_codecs: [bytes,
    crc32c]`) because the index is the one part of a shard whose corruption is otherwise
    SILENT: a flipped byte in a compressed chunk fails to gunzip, loudly, but a flipped byte
    in an OFFSET yields a completely successful decode of the wrong bytes. Neither depth
    checked it.

    Swapping two index slots is the minimal demonstration — every chunk still decodes, every
    length still matches, the row count still adds up, and the member's values come back
    transposed.
    """
    root = tmp_path / "crc.zarr"
    n = 18
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(1, n + 1, dtype=np.int32), dtype="int32",
                  inner_chunk=4, chunks_per_shard=2)
        structure = t.close()
    assert conformance.conform_artifact(root, structure, full=True) == []

    # `repair_crc=False`: the stored checksum is now the one for the ORIGINAL index, which
    # is precisely the state a flipped offset byte leaves behind.
    edit_shard_index(
        a_shard_body(root, "value"), 2,
        lambda idx: idx.__setitem__(slice(None), idx[::-1]),
        repair_crc=False,
    )
    got = cyto_zarr_read.read_array(root, "value").tolist()
    assert got[:8] == [5, 6, 7, 8, 1, 2, 3, 4], (
        f"the fixture must produce a VALID read of the WRONG bytes, got {got}"
    )
    for full in (False, True):
        violations = conformance.conform_artifact(root, structure, full=full)
        assert any("crc32c" in v for v in violations), (
            f"full={full}: the shard index must be verified against its own checksum — "
            f"the format writes it so a mis-addressed chunk is detectable. Got {violations}"
        )


#: Each entry corrupts the FIRST shard of a member — the one shard BOTH depths read — in a
#: different way. Used by the monotonicity test below, which asserts that anything the
#: bounded depth can detect the exhaustive depth detects too.
FIRST_SHARD_CORRUPTIONS = [
    ("truncated", lambda p, per: p.write_bytes(p.read_bytes()[:-4])),
    ("index-truncated", lambda p, per: p.write_bytes(p.read_bytes()[: per * 16 // 2])),
    ("slot-blanked", lambda p, per: edit_shard_index(
        p, per, lambda idx: idx.__setitem__(0, (cyto_zarr_read.EMPTY, cyto_zarr_read.EMPTY)))),
    ("slots-swapped-stale-crc", lambda p, per: edit_shard_index(
        p, per, lambda idx: idx.__setitem__(slice(None), idx[::-1]), repair_crc=False)),
    ("zero-length-chunk", lambda p, per: edit_shard_index(
        p, per, lambda idx: idx.__setitem__(0, (int(idx[0][0]), 0)))),
    ("offset-past-the-body", lambda p, per: edit_shard_index(
        p, per, lambda idx: idx.__setitem__(0, (1 << 40, int(idx[0][1]))))),
    ("chunk-bytes-mangled", lambda p, per: p.write_bytes(
        b"\x00" * 8 + p.read_bytes()[8:])),
]


@pytest.mark.parametrize("name,corrupt", FIRST_SHARD_CORRUPTIONS, ids=[c[0] for c in FIRST_SHARD_CORRUPTIONS])
def test_the_full_depth_detects_everything_the_bounded_depth_does(tmp_path, name, corrupt):
    """The MONOTONICITY the module docstring claims, asserted instead of asserted-about.

    The claim is "`full=` only ever makes the check stricter". It was false — and a false
    invariant in a docstring is worse than none, because it is the reason nobody looked at
    the arm that was weaker. It is now true by construction (`_shard_plan` returns every
    shard for `full=True` and a SUBSET of that same list otherwise, and `_decode_shards`
    applies identical checks either way), and this test is the mechanical check on it:

        bounded reports a violation  ⇒  full reports one too

    Each case corrupts the FIRST shard, which both depths read, so every case is one both
    depths have the opportunity to catch. A case only `full` can catch (a MIDDLE shard) is
    covered by `test_the_bounded_depth_really_samples_and_the_full_depth_really_does_not`.
    """
    root = tmp_path / f"mono-{name}.zarr"
    structure = a_multi_shard_table(root)
    meta = cyto_zarr_read.read_meta(root, "value")
    per_shard = int(meta["chunk_grid"]["configuration"]["chunk_shape"][0]) // \
        int(meta["codecs"][0]["configuration"]["chunk_shape"][0])

    # The shard SETS are in a subset relation — the structural reason the implication holds.
    bounded_plan = conformance._shard_plan(meta, full=False)
    full_plan = conformance._shard_plan(meta, full=True)
    assert set(bounded_plan) <= set(full_plan) and len(full_plan) > len(bounded_plan), (
        f"bounded {bounded_plan} must be a strict subset of full {full_plan} on this fixture"
    )

    assert conformance.conform_artifact(root, structure, full=False) == []
    corrupt(a_shard_body(root, "value"), per_shard)

    bounded = conformance.conform_artifact(root, structure, full=False)
    exhaustive = conformance.conform_artifact(root, structure, full=True)
    assert bounded, f"{name}: the corruption must be visible to the bounded depth at all"
    assert exhaustive, (
        f"{name}: the BOUNDED depth reported {bounded} and the exhaustive depth reported "
        "nothing. `full=` is documented to only ever make the check stricter, and "
        "production only ever runs the exhaustive depth — so a corruption the sample "
        "catches and the full pass misses is a gate that is green on the one arm it uses"
    )


# ── TEST-25: a non-conforming artifact is REJECTED ──────────────────────────────

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_truncated_shard_is_rejected(tmp_path, depth):
    root = tmp_path / "t.zarr"
    structure = a_table(root)
    shard = root / "value" / "c" / "0"
    shard.write_bytes(shard.read_bytes()[:-64])  # eats the index trailer
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("does not decode" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_declared_dtype_that_is_not_the_stored_one_is_rejected(tmp_path, depth):
    root = tmp_path / "t.zarr"
    structure = a_table(root)
    structure["columns"][0]["dtype"] = "float64"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("declared 'float64' but stored as 'float32'" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_declared_length_that_is_not_the_stored_one_is_rejected(tmp_path, depth):
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=100)
    structure["n"] = 101
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("but the axis declares 101" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_missing_member_is_rejected(tmp_path, depth):
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=100)
    for path in sorted((root / "group").rglob("*"), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
    (root / "group").rmdir()
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("has no zarr.json on disk" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_member_less_table_is_rejected(tmp_path, depth):
    """The silent-empty class, at the producer side. An artifact with nothing in it reads
    as an empty result to every consumer downstream; INV-2 says absence is an error."""
    root = tmp_path / "empty.zarr"
    cz.write_group(root, {"cyto": {"encoding": "zarr_v3", "kind": "table",
                                   "axis": "rows", "n": 0, "columns": [], "arrays": []}})
    violations = conformance.conform_artifact(
        root, {"encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 0,
               "columns": [], "arrays": []}, full=depth
    )
    assert any("declares no members" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_categorical_code_outside_its_declared_levels_is_rejected(tmp_path, depth):
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=100)
    # Shrink the DECLARED level set below a code that is actually stored. This is the
    # failure mode a consumer sees as `categories[code] === undefined` — a blank legend
    # entry rather than an error.
    declare_levels(root, structure, 1, ["a"])
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("outside its 1 declared levels" in v for v in violations), violations
    # And it is THAT check firing, not the digest drift check catching an incoherent
    # edit: the shrink above re-declared all three copies, so they agree with each other
    # and disagree only with the stored CODES — which is the failure mode under test.
    assert not any("levels_digest" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_declaration_that_drifted_from_the_stamped_one_is_rejected(tmp_path, depth):
    """The group's `zarr.json` and the artifact row carry the SAME declaration. Two copies
    that can drift means a client reading the store URL and a client reading the row decode
    differently — silently, and only for some artifacts."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=100)
    structure["axis"] = "somethingelse"
    violations = conformance.conform_artifact(root, structure, full=depth)  # NOT restamped
    assert any("differs from the returned `structure`" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_declared_geometry_that_is_not_the_stored_grid_is_rejected(tmp_path, depth):
    """The ITEM-35 regression, caught at the artifact level: a declaration claiming one
    shard over a store that holds 306."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=100)
    structure["columns"][0]["chunks_per_shard"] = 4096
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("chunks a shard but the stored grid" in v for v in violations), violations


# ── the CLASS, not instance N+1: an ABSENT member declaration ───────────────────
#
# Three producer-authored opt-outs were found and closed ONE AT A TIME — `encoding:
# "opaque"`, an omitted `structure.key`, an omitted `values_digest` — before the shape they
# share was named. The shape was mechanical: `_conform_member` read every member key with
# `.get()`, so omitting a key did not FAIL a check, it SKIPPED one, and each omission had to
# be discovered before it could be refused.
#
# These tests are over the class. `ABSENT_MEMBER_KEYS` is the measured matrix of what used
# to pass in SILENCE; the two tests after it are the structural half — they fail if the
# required/optional tables ever fall behind the writers, which is what stops this becoming
# another list somebody has to remember to extend.


def a_2d_table(root, n=64, width=3):
    """A table carrying a 2-D member, i.e. one that lands in `structure.arrays`.

    `a_table` has none, so `arrays` members would otherwise be unexercised by the
    classification test below — and a 2-D member is exactly where a shape/geometry
    declaration has an extra degree of freedom to be wrong in.
    """
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("xy", np.zeros((n, width), dtype=np.float32), dtype="float32")
        return t.close()


#: `(member path, the key to omit)` — every key whose absence the gate must refuse, over
#: `a_table`'s one-member-of-each-kind fixture. Measured BEFORE the fix (`full=True`,
#: restamped): every row here returned `[]`, except the two string-member rows a bespoke
#: check already owned (`values_digest`) — kept in the matrix so the class-level check is
#: asserted to cover them too rather than being assumed to.
ABSENT_MEMBER_KEYS = [
    ("value", "kind"),
    ("value", "dtype"),
    ("value", "shape"),
    ("value", "inner_chunk"),
    ("value", "chunks_per_shard"),
    ("value", "shards"),
    ("group", "kind"),
    ("group", "levels_digest"),
    ("group", "n_levels"),
    ("group", "ordered"),
    ("label", "dtype"),
    ("label", "shape"),
    ("label", "layout"),
    ("label", "offsets"),
    ("label", "values"),
    ("label", "n_bytes"),
    ("label", "values_digest"),
]


@pytest.mark.parametrize("member_path,key", ABSENT_MEMBER_KEYS)
def test_omitting_any_required_member_key_is_refused(tmp_path, member_path, key):
    """Absence is an error (INV-2), for EVERY required key, not for the ones found so far.

    Each case carries its own positive control: the untouched artifact conforms, so a green
    result here cannot come from a fixture that was already broken.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "positive control: the intact artifact must conform, or this case proves nothing"
    )
    member = next(
        m for m in structure["columns"] + structure["arrays"] if m["path"] == member_path
    )
    assert key in member, (
        f"the writer no longer emits member key {key!r} on {member_path!r} — then the "
        "matrix is stale, and `_REQUIRED_MEMBER_KEYS` requires something nothing writes"
    )
    member.pop(key)
    # Restamped, so the group/row drift check cannot answer for the member check: the point
    # is that a producer omitting the key CONSISTENTLY (in both copies, which is what a
    # producer emitting a thinner declaration actually does) is still refused.
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(key in v for v in violations), (
        f"omitting member key {key!r} on {member_path!r} was SILENT — a declaration a "
        "producer may omit in order to be checked less is an opt-out (DEC-8). Got "
        f"{violations}"
    )


def test_the_key_tables_classify_every_key_the_writers_emit(tmp_path):
    """The N+1 proof: a key added to a writer is classified, or this fails.

    Both directions, because either one alone rots:

    * every key the REAL writers emit is either required or EXPLICITLY optional — so a new
      member key cannot ride along as something the gate has no opinion about;
    * every key the gate REQUIRES is actually emitted — so the table cannot demand
      something no writer writes, which would refuse every conforming artifact.

    Run over all three member kinds, a 2-D `arrays` member, and `cyto_csc`'s trio (whose
    members carry no `name`/`axis` at all, which is why those two are optional).
    """
    table = a_table(tmp_path / "t.zarr", n=64)
    two_d = a_2d_table(tmp_path / "xy.zarr")
    matrix = a_matrix(tmp_path / "m.zarr")
    members = (
        table["columns"] + table["arrays"]
        + two_d["columns"] + two_d["arrays"]
        + [matrix[role] for role in ("indptr", "indices", "data")]
    )
    assert len(members) >= 7, members
    for member in members:
        kind = member["kind"]
        assert kind in conformance._MEMBER_KINDS, member
        required = set(conformance._REQUIRED_MEMBER_KEYS[kind])
        classified = required | set(conformance._OPTIONAL_MEMBER_KEYS)
        unclassified = sorted(set(member) - classified)
        assert not unclassified, (
            f"the writers emit member key(s) {unclassified} on a {kind} member that the "
            "gate neither requires nor knows to be optional. Add each to "
            "`_REQUIRED_MEMBER_KEYS` with the comparison it enables, or to "
            "`_OPTIONAL_MEMBER_KEYS` with the reason its absence cannot weaken the gate"
        )
        missing = sorted(k for k in required if member.get(k) is None)
        assert not missing, (
            f"the gate requires {missing} on a {kind} member but the writer does not emit "
            "it — a required key nothing writes refuses every conforming artifact"
        )


def test_every_explicitly_optional_member_key_carries_its_reason():
    """Explicit optionality is INV-2-legal; SILENT optionality is what was not.

    The difference is the reason, so an empty one would make the table a bare allow-list —
    the shape that let five keys be optional-by-accident in the first place.
    """
    for key, reason in conformance._OPTIONAL_MEMBER_KEYS.items():
        assert isinstance(reason, str) and len(reason.strip()) > 20, (
            f"optional member key {key!r} carries no reason ({reason!r}) — a key is "
            "optional because of something, and that something is what a reviewer checks"
        )


def test_an_unknown_member_key_is_reported_rather_than_riding_along(tmp_path):
    """A key in neither table is a declaration nothing checks — which is how the required
    table would have quietly stopped being exhaustive."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    structure["columns"][0]["wombat"] = 1
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("wombat" in v and "neither requires nor knows" in v for v in violations), (
        violations
    )


def test_a_member_kind_this_suite_does_not_implement_is_refused_by_name(tmp_path):
    """An unimplemented `kind` used to be checked AS IF it were numeric — which is what
    made the categorical→numeric downgrade (dropping the level-set check) a viable
    omission rather than a contradiction."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    structure["columns"][0]["kind"] = "wombat"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("declares kind 'wombat'" in v for v in violations), violations


# ── …and the same class keyed on TYPE rather than on absence ───────────────────
#
# The tables above make a key's ABSENCE a violation and left its TYPE to the producer, which
# is the same lever with the value left in place: `shape: 200` is PRESENT, so the presence
# loop passes it, and every use of it then sat behind an `isinstance(…, list)` guard that a
# scalar silently switched OFF — including the ONLY check pinning a string group's stamped
# `attributes.cyto.n`. The oracle is the first test below; `WRONG_FORM_SUBSTITUTES` is the
# class-level matrix (every required key × every kind × every JSON type it is not); and
# `test_the_real_writers_declarations_are_in_their_declared_forms` is the control that stops
# the new rule doing the one thing worse than the hole — refusing conforming artifacts.


def one_output_manifest(outputs, label, path, structure):
    """A real `outputs/manifest.json` declaring ONE artifact — the production entry's input.

    These cases go through `conform_outputs` rather than `conform_artifact` deliberately:
    the malformed-declaration arm used to end in a `TypeError` for the fixed-width kinds,
    and it is `conform_manifest` (only reachable through this entry) that turns a raise into
    a verdict. Checking the same thing one layer in would have hidden which of the two arms
    a cell landed in.
    """
    (outputs / "manifest.json").write_text(json.dumps({"outputs": [
        {"id": label, "path": path, "structure": structure},
    ]}))


def a_string_only_table(root, n=200):
    """A table whose single member is a string GROUP — the kind the oracle is about."""
    with cz.Table(root, axis="rows", n=n) as t:
        t.string("label", [f"row-{i:05d}" for i in range(n)])
        return t.close()


#: The full violation the gate must report for the oracle, character for character.
#:
#: Asserted by EQUALITY, and spelled out here rather than rebuilt from the module's own
#: table, because a coarse shared code lets an unrelated rejection masquerade as the fix:
#: this same artifact was already refused with a `TypeError` on the NUMERIC kinds, and a
#: test asserting only "something was reported" would have passed against the crash arm
#: while the string kind stayed silent.
ORACLE_SCALAR_SHAPE_VIOLATION = (
    'labels: member "label" (string) declares shape=200, which is not a non-empty list of '
    "integers — a required key in the wrong form is not a check that runs looser, it is a "
    "check that cannot run at all: every comparison this gate makes with `shape` reads it "
    "as a non-empty list of integers, so a value that is not one either crashes that "
    "comparison or is skipped by the guard written to survive it (INV-2: the type is part "
    "of what is required; DEC-8: no producer-authored declaration may make the gate look "
    "less hard)"
)


def test_the_ORACLE_a_SCALAR_shape_leaves_a_string_groups_STAMP_unpinned(tmp_path):
    """THE MEASUREMENT: `shape: 200` returned `[]` for an artifact whose stamp says `n=999`.

    A string member's `shape` is the ONLY thing pinning `<member>/zarr.json`'s
    `attributes.cyto.n` — the row's counterpart of the length a store-URL consumer allocates
    for. That comparison was written `isinstance(declared_shape, list) and declared_shape`,
    so declaring the row's `shape` as a SCALAR did not fail the check, it removed it: the
    producer's stamp could then say anything. Measured through this same production entry
    before the fix: `[]`, and `gate_outputs` did not raise, over 200 real strings stamped
    `n=999`.

    `zarrReader.openSplitStringColumn` reads that stamp and throws on exactly this metadata,
    so the gate was green-lighting an artifact the shipped client refuses to open — the same
    argument that decided `_UnderivableGrid`.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    root = outputs / "t.zarr"
    structure = a_string_only_table(root, n=200)
    one_output_manifest(outputs, "labels", "t.zarr", structure)
    assert conformance.conform_outputs(outputs) == [], (
        "positive control: the intact artifact must conform, or this case proves nothing"
    )

    # The producer's stamp lies about the length. Nothing else is touched: the bytes, the
    # offsets, the group stamp and the row are all the writer's own.
    node = json.loads((root / "label" / "zarr.json").read_text())
    node["attributes"]["cyto"]["n"] = 999
    (root / "label" / "zarr.json").write_text(json.dumps(node, indent=2))

    # In the form the writer emits it, the row pins the stamp and the lie is named.
    assert conformance.conform_outputs(outputs) == [
        'labels: string member "label" is stamped n=999 but declared shape [200] in the '
        "artifact row"
    ], "positive control: the check the scalar switches off must exist in the first place"

    # The SAME length, declared as a scalar. This is the whole finding.
    member = next(m for m in structure["columns"] if m["path"] == "label")
    member["shape"] = 200
    restamp(root, structure)
    one_output_manifest(outputs, "labels", "t.zarr", structure)
    assert conformance.conform_outputs(outputs) == [ORACLE_SCALAR_SHAPE_VIOLATION]
    with pytest.raises(conformance.ConformanceError):
        conformance.gate_outputs(outputs)


def test_the_SAME_wrong_value_is_refused_in_the_form_the_gate_could_not_READ(tmp_path):
    """One value, two forms: `[999]` was refused twice over and `999` was not refused at all.

    This is what makes the fault a producer-authored OPT-OUT rather than a typo. Both of a
    string member's `shape` checks — against the stamped `n` and against the axis — read the
    key through the same `isinstance` guard, so the wrong length written as a LIST is named
    by both of them, and the identical wrong length written as a SCALAR was named by
    neither. Nothing about the value changed; only whether the gate could read it.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    root = outputs / "t.zarr"
    structure = a_string_only_table(root, n=200)
    member = next(m for m in structure["columns"] if m["path"] == "label")

    member["shape"] = [999]
    restamp(root, structure)
    one_output_manifest(outputs, "x", "t.zarr", structure)
    assert conformance.conform_outputs(outputs) == [
        'x: string member "label" is stamped n=200 but declared shape [999] in the '
        "artifact row",
        'x: string member "label" declares shape [999] but its axis declares 200 rows',
    ], "the wrong length in a form the gate can read is refused by BOTH checks"

    member["shape"] = 999
    restamp(root, structure)
    one_output_manifest(outputs, "x", "t.zarr", structure)
    violations = conformance.conform_outputs(outputs)
    assert violations == [
        ORACLE_SCALAR_SHAPE_VIOLATION.replace("labels: ", "x: ").replace(
            "shape=200", "shape=999"
        )
    ], f"the same wrong length in a form it cannot read must not go quiet. Got {violations}"


def test_every_required_member_key_declares_the_FORM_it_is_required_in():
    """The N+1 guard on the new table: a required key with no form is a key with no type.

    Both directions, like the required/optional pair it sits beside — a required key with no
    entry in `_MEMBER_KEY_FORMS` would be back to "present is enough", and a form for a key
    nothing requires is a rule with no subject.
    """
    required = {k for keys in conformance._REQUIRED_MEMBER_KEYS.values() for k in keys}
    forms = set(conformance._MEMBER_KEY_FORMS)
    assert required == forms, (
        f"required-but-formless: {sorted(required - forms)}; form-but-not-required: "
        f"{sorted(forms - required)}. A required key's TYPE is part of what is required, "
        "and it is declared in `_MEMBER_KEY_FORMS` for every kind at once"
    )
    for key, entry in conformance._MEMBER_KEY_FORMS.items():
        phrase, predicate = entry
        assert isinstance(phrase, str) and len(phrase.strip()) > 3, (key, phrase)
        assert callable(predicate), (key, predicate)


#: `(id, value)` — every JSON type a producer can write, as a substitute for a required key's
#: value. JSON is the whole vocabulary on purpose: the declaration reaches the gate through
#: `manifest.json`, so a tuple or a `numpy` scalar is not a shape a producer can even express,
#: and a matrix over types the wire cannot carry would be testing this file's imagination.
WRONG_FORM_SUBSTITUTES = [
    ("int", 200),
    ("float", 200.5),
    ("str", "200"),
    ("true", True),
    ("false", False),
    ("object", {"0": 200}),
    ("empty-list", []),
    ("empty-object", {}),
    ("empty-str", ""),
    ("list-of-str", ["200"]),
    ("list-of-float", [200.0]),
    ("nested-list", [[200]]),
]

#: The substitutes that are a LEGAL form for a given key, and are therefore NOT cells of the
#: matrix below: they are the wrong VALUE, which is a different check's job (`n_bytes: 200`
#: is an integer, and the payload-length comparison is what refuses it).
#:
#: Written out here rather than derived by calling the module's own predicate, so that the
#: matrix cannot be silently emptied by weakening one: the test asserts this table and
#: `_MEMBER_KEY_FORMS` agree in BOTH directions, so a predicate that started accepting
#: everything fails here instead of quietly reducing the matrix to nothing.
WELL_FORMED_SUBSTITUTES = {
    "dtype": {"str"},
    "layout": {"str"},
    "offsets": {"str"},
    "values": {"str"},
    "values_digest": {"str"},
    "inner_chunk": {"int"},
    "chunks_per_shard": {"int"},
    "shards": {"int"},
    "n_bytes": {"int"},
    "shape": set(),
    "levels_digest": {"str"},
    "n_levels": {"int"},
    "ordered": {"true", "false"},
}


def test_a_required_member_key_in_the_WRONG_FORM_is_refused_for_EVERY_key_and_kind(tmp_path):
    """THE CLASS: every required key × every kind × every JSON type it is not.

    Measured against the code as it stood, through this same production entry: **62 cells
    were SILENT** — 11 of the string member's `shape` (a scalar, a float, a string, either
    boolean, an object, an empty list, an empty object, an empty string, a list of strings,
    a list of floats), 12 of its `dtype`, 16 falsy `dtype`s on the fixed-width kinds (`""`,
    `[]`, `{}`, `false`, whose comparison was guarded by truthiness), 10 `bool`-as-count
    (`chunks_per_shard: true`, `shards: true`, read as 1 by `int()`), 2 float extents, and
    one substitution that was not a fault at all. A further 171 cells were refused only by a
    `TypeError` escaping into `conform_manifest`, which reports the raise INSTEAD of every
    finding made so far — refused, but by the arm that loses the cause.

    Each cell asserts the violation that names THIS key and THIS value, not merely that
    something was reported: the crash arm and the drift checks reject several of these cells
    for unrelated reasons, and a coarse assertion would have passed on them while the string
    kind stayed silent. Both depths, because a check that becomes depth-sensitive must fail
    at whichever arm loses it.

    The counts are asserted and reported: a matrix that stopped covering anything (a
    substitute list emptied, a member fixture renamed) would otherwise pass while testing
    nothing.
    """
    assert set(WELL_FORMED_SUBSTITUTES) == set(conformance._MEMBER_KEY_FORMS), (
        "this test's exclusion table and the gate's form table name different keys"
    )
    for key, (_phrase, well_formed) in conformance._MEMBER_KEY_FORMS.items():
        legal = {sub_id for sub_id, value in WRONG_FORM_SUBSTITUTES if well_formed(value)}
        assert legal == WELL_FORMED_SUBSTITUTES[key], (
            f"the gate now considers {sorted(legal)} a legal form for {key!r} but this "
            f"test excludes {sorted(WELL_FORMED_SUBSTITUTES[key])} — a predicate that "
            "started accepting more would otherwise shrink the matrix instead of failing"
        )

    outputs = tmp_path / "outputs"
    outputs.mkdir()
    table = a_table(outputs / "t.zarr", n=64)
    matrix = a_matrix(outputs / "m.zarr")
    fixtures = [("t.zarr", table, table["columns"] + table["arrays"])]
    fixtures.append(("m.zarr", matrix, [matrix[r] for r in ("indptr", "indices", "data")]))

    silent = []
    masqueraded = []
    checked = 0
    kinds = set()
    keys = set()
    for path, structure, members in fixtures:
        root = outputs / path
        for member in members:
            kind = member["kind"]
            for key in conformance._REQUIRED_MEMBER_KEYS[kind]:
                original = member[key]
                for sub_id, value in WRONG_FORM_SUBSTITUTES:
                    if sub_id in WELL_FORMED_SUBSTITUTES[key]:
                        continue
                    member[key] = value
                    restamp(root, structure)
                    one_output_manifest(outputs, "a", path, structure)
                    for full in (False, True):
                        got = conformance.conform_outputs(outputs, full=full)
                        cell = f"{member['path']}({kind}).{key}={sub_id}[full={full}]"
                        if not got:
                            silent.append(cell)
                        elif not any(
                            f"declares {key}={value!r}, which is not " in v for v in got
                        ):
                            masqueraded.append((cell, got))
                        checked += 1
                    kinds.add(kind)
                    keys.add(key)
                member[key] = original

    assert not silent, (
        f"{len(silent)} of {checked} wrong-form cell(s) were SILENT: {silent[:12]} — a "
        "required key whose TYPE a producer chooses is the same opt-out as one whose "
        "presence they choose (INV-2, DEC-8)"
    )
    assert not masqueraded, (
        f"{len(masqueraded)} of {checked} cell(s) were refused by something OTHER than the "
        f"form rule (the first: {masqueraded[:2]}) — an unrelated rejection standing in for "
        "this one is how the string kind stayed silent while the numeric kinds crashed"
    )
    assert checked == 780, (
        f"the matrix covered {checked} cell(s) over kinds {sorted(kinds)} and keys "
        f"{sorted(keys)} — 390 cells × 2 depths is the measured size, and a matrix that "
        "silently stopped covering anything would pass every assertion above"
    )
    assert kinds == set(conformance._MEMBER_KINDS), sorted(kinds)
    assert keys == set(conformance._MEMBER_KEY_FORMS), sorted(keys)


def test_the_real_writers_declarations_are_in_their_declared_FORMS(tmp_path):
    """THE NEGATIVE CONTROL for the form rule, and the one that decides whether it may ship.

    A type rule that is wrong about the type REFUSES CONFORMING ARTIFACTS, which is worse
    than the hole it closes. So every required key of every member of every artifact shape
    the real writers emit — including the degenerate ones a form could plausibly get wrong
    (`n=0`, where `shards` and `n_bytes` are `0`; an all-empty string column; an empty level
    set) — is asserted to satisfy its own form, and the whole set is asserted to still
    conform end to end.

    The counts are asserted so a control that stopped controlling anything fails here.
    """
    checked = 0
    stores = 0
    for n in (0, 1, 7, 64, 200):
        root = tmp_path / f"t{n}.zarr"
        with cz.Table(root, axis="rows", n=n) as t:
            t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32")
            t.numeric("xy", np.zeros((n, 3), dtype=np.float32), dtype="float32")
            t.numeric("small", np.arange(n, dtype=np.float32), dtype="float32",
                      inner_chunk=16, chunks_per_shard=2)
            t.categorical("group", codes=[i % 3 for i in range(n)], levels=["a", "b", "c"])
            t.categorical("none", codes=[], levels=[]) if n == 0 else None
            t.string("label", [f"r{i}" for i in range(n)])
            t.string("blank", ["" for _ in range(n)])
            structures = [t.close()]
        structures.append(a_matrix(tmp_path / f"m{n}.zarr", n_rows=max(n, 1), n_cols=3))
        for structure in structures:
            stores += 1
            members = (
                list(structure.get("columns") or []) + list(structure.get("arrays") or [])
                + [structure[r] for r in ("indptr", "indices", "data") if r in structure]
            )
            assert members, structure
            for member in members:
                for key in conformance._REQUIRED_MEMBER_KEYS[member["kind"]]:
                    phrase, well_formed = conformance._MEMBER_KEY_FORMS[key]
                    assert well_formed(member[key]), (
                        f"the writer emits {key}={member[key]!r} on a {member['kind']} "
                        f"member and the gate requires {phrase} — a form rule that refuses "
                        "a conforming artifact is worse than the hole it closes"
                    )
                    checked += 1
        assert conformance.conform_artifact(root, structures[0], full=True) == []
        assert conformance.conform_artifact(
            tmp_path / f"m{n}.zarr", structures[1], full=True
        ) == []
    assert stores == 10, stores
    assert checked >= 200, (
        f"only {checked} declared key(s) across {stores} store(s) — a control this thin "
        "would pass with the forms arbitrarily wrong"
    )


def test_an_EMPTY_level_set_cannot_switch_off_the_code_range_check(tmp_path):
    """The same class, one guard over: `if levels and values.size` read an empty set as absent.

    Measured before the fix: `levels: []` written into ALL THREE copies (the row, the group
    stamp and the member's own stamp) over 60 stored codes returned `[]` — every code is
    outside a set of no levels, and the check that says so was guarded by truthiness rather
    than by presence.

    Its own negative control is the second half: an empty level set IS a real artifact
    (`Table.categorical(codes=[], levels=[])` at `n=0` writes one), which is why the form for
    `levels` is "a list" and not "a non-empty list" — the fix belongs at the comparison, not
    at the requirement.
    """
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="rows", n=60) as t:
        t.categorical("group", codes=[i % 3 for i in range(60)], levels=["a", "b", "c"])
        structure = t.close()
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "positive control: the intact artifact must conform"
    )
    # All three copies again, coherently (`declare_levels` does the row's digest+count and
    # the member's stamped list): the point is an empty DECLARATION over stored codes, not
    # an incoherent one, which the digest check would catch first and for another reason.
    declare_levels(root, structure, 0, [])
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("outside its 0 declared levels" in v for v in violations), (
        f"an empty level set holds no code, so every stored code is outside it. Got "
        f"{violations}"
    )

    empty = tmp_path / "e.zarr"
    with cz.Table(empty, axis="rows", n=0) as t:
        t.categorical("group", codes=[], levels=[])
        empty_structure = t.close()
    assert empty_structure["columns"][0]["n_levels"] == 0
    assert empty_structure["columns"][0]["levels_digest"] == cz.key_sequence_digest([])
    assert conformance.conform_artifact(empty, empty_structure, full=True) == [], (
        "an empty level set over no values is a conforming artifact the real writer emits — "
        "refusing it would be the form rule doing the one thing worse than the hole"
    )


def test_a_member_dropped_from_the_declaration_is_refused(tmp_path):
    """The cheapest opt-out of all: omit the member ENTRY.

    Omitting a member KEY made one check shallower; omitting the whole entry removed every
    check on those bytes — dtype, shape, geometry, codes, decode — while the bytes sat in
    the store exactly as before. No byte-level check can see it (nothing about the bytes
    changed), so the only thing that can is asking the store what it holds.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    structure["columns"] = [c for c in structure["columns"] if c["path"] != "group"]
    restamp(root, structure)
    assert (root / "group" / "zarr.json").is_file(), "the member's bytes must still be there"
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("does not name" in v and "group" in v for v in violations), violations


#: Every member of `a_table`, i.e. one of each kind. The point of parametrizing over the
#: KIND is that the two checks below must not have a per-kind arm at all: the string kind
#: having its own arm is exactly how a deleted `zarr.json` went unreported for it while being
#: refused for the other two.
MEMBER_KINDS_IN_A_TABLE = [("value", "numeric"), ("group", "categorical"), ("label", "string")]


@pytest.mark.parametrize("member_path,kind", MEMBER_KINDS_IN_A_TABLE)
def test_a_declared_node_the_store_does_not_hold_is_refused(tmp_path, member_path, kind):
    """The OTHER direction of the coverage set difference, for EVERY kind.

    `_conform_node_coverage` compared `stored ⊄ declared` only, so a DECLARED node with
    nothing behind it was left entirely to the per-member checks — which had a per-kind arm:
    `_conform_member` read the member's own `zarr.json` after the `kind == "string"` fork, so
    for a string member nobody read it and nobody reported it. Measured against the pre-fix
    module: deleting `<member>/zarr.json` produced 1 violation for `value` (numeric) and 1
    for `group` (categorical) and **0** for `label` (string).

    A set difference has two sides. Checking one of them is what made a per-kind exception
    expressible in the first place, so the fix is the other side — which cannot have a
    per-kind arm, because it never looks at a kind.

    Both violations are asserted by identity, not by count: the member-level one (a declared
    member whose node is unreadable) and the artifact-level one (the declaration names a node
    the store does not hold). A coarse "something is wrong with this artifact" would let an
    unrelated rejection stand in for either.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    # NEGATIVE CONTROL: the untouched artifact conforms, so a report below cannot come from
    # a fixture that was already broken or from a check that fires unconditionally.
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: the intact artifact must conform, or this case proves nothing"
    )
    node = root / member_path / "zarr.json"
    assert node.is_file()
    node.unlink()

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        f'declared member "{member_path}" has no zarr.json on disk' == v for v in violations
    ), (
        f"a declared {kind} member whose own zarr.json is GONE must be named as such — this "
        f"was silent for the string kind. Got {violations}"
    )
    assert any(
        "the declaration names node(s)" in v and f"'{member_path}'" in v for v in violations
    ), (
        "the declared-but-not-stored direction of the coverage check must name the node, "
        f"independently of the member's kind. Got {violations}"
    )


def test_a_conforming_artifact_declares_exactly_the_nodes_it_stores(tmp_path):
    """NEGATIVE CONTROL for both directions of the coverage check, over both encodings.

    Without it, a `_conform_node_coverage` that reported one direction unconditionally would
    satisfy every test above. The CSC trio is included because its members are declared under
    `structure.indptr/indices/data` rather than in `columns`, i.e. by a different code path in
    `_declared_member_nodes`.
    """
    table = a_table(tmp_path / "t.zarr", n=64)
    matrix = a_matrix(tmp_path / "m.zarr")
    strings = a_string_table(tmp_path / "s.zarr", ["a", "bb", ""])
    for root, structure in (
        (tmp_path / "t.zarr", table), (tmp_path / "m.zarr", matrix), (tmp_path / "s.zarr", strings)
    ):
        assert conformance._conform_node_coverage(root, structure) == [], (
            f"{root.name}: a store written by the real writer holds exactly the nodes its "
            "declaration names, in both directions"
        )
        assert conformance.conform_artifact(root, structure, full=True) == []


def test_a_file_hidden_in_a_members_chunk_directory_is_refused(tmp_path):
    """The `c/` dir was the one place in a store where bytes were neither declared nor read.

    The node walk deliberately does not recurse into a member's chunk directory — it holds
    shard FILES, not nodes — but it used to `continue` past it, which is a different thing
    from checking it. So `<member>/c/evil` was declared by nothing, read by nothing, and
    reported by nothing: measured `[]` on the pre-fix module. A `c/` dir now has to hold what
    it is for, which is chunks of ONE member named by chunk index.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: the intact artifact conforms"
    )
    (root / "value" / "c" / "evil").write_bytes(b"bytes nobody declared")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        "under a chunk directory that no chunk key can name" in v and "value/c/evil" in v
        for v in violations
    ), violations


def test_a_node_hidden_in_a_members_chunk_directory_is_refused(tmp_path):
    """The same hiding place, used for a whole NODE rather than a loose file.

    Worse than the file: the walk that would have found an undeclared node is the very walk
    that skipped `c/`, so a complete member could sit at `<member>/c/sneaky/` with its own
    `zarr.json` and the coverage check — the thing whose entire job is to ask the store what
    it holds — never saw it. Also `[]` before the fix.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    hidden = root / "value" / "c" / "sneaky"
    hidden.mkdir(parents=True)
    (hidden / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group", "attributes": {}})
    )

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        "under a chunk directory that no chunk key can name" in v and "value/c/sneaky" in v
        for v in violations
    ), violations

def test_the_real_writers_chunk_keys_are_accepted(tmp_path):
    """NEGATIVE CONTROL for the two above: the chunk-key rule must accept what is WRITTEN.

    A rule that refused a real store's chunk names would refuse every conforming artifact, so
    both chunk-key shapes `cyto_zarr` emits are exercised — the flat `c/<shard>` of a 1-D
    member and the nested `c/<shard>/0` of a 2-D one — plus a member with more than one shard,
    at both depths.
    """
    root = tmp_path / "xy.zarr"
    structure = a_2d_table(root, n=64, width=3)
    assert (root / "xy" / "c" / "0" / "0").is_file(), (
        "the 2-D chunk key is nested, and this test is about that shape"
    )
    assert conformance.conform_artifact(root, structure, full=True) == []

    multi = tmp_path / "many.zarr"
    many = a_multi_shard_table(multi, n=200, inner_chunk=16, chunks_per_shard=2)
    assert len(list((multi / "value" / "c").iterdir())) > 1, "more than one shard file"
    assert conformance.conform_artifact(multi, many, full=False) == []
    assert conformance.conform_artifact(multi, many, full=True) == []


# ── the chunk plane, held to the declared GRID and not merely to a NAME ──────────
#
# The name rule above (`_CHUNK_KEY_RE`) shipped as the second half of a rule the module
# called TOTAL — "every file is some node's `zarr.json` or a chunk under that node's `c/`".
# It was not total: it asked whether an entry is SHAPED like a chunk key and never whether
# the declared array HAS that chunk, so any numerically-named entry under any node's `c/`
# was accepted. Every case below was MEASURED SILENT (`[]`) against the real
# `conform_artifact` with the name rule in place and no grid rule.
#
# Each asserts the EXACT violation string. A substring like "chunk" or a shared coarse code
# would let an unrelated rejection (a decode failure, a coverage finding) stand in for the
# one under test — which has already happened on this branch — and these tests exist
# precisely to distinguish "this is not a chunk key" from "this is not a chunk THIS member
# has".


#: The out-of-grid violation, spelled out HERE rather than imported from `conformance`.
#: A test that builds its expectation with the module's own message builder asserts only
#: that the module agrees with itself; this is an independent copy, so a wording change on
#: the production side fails loudly instead of following along.
def ungridded_message(label, grid, *paths):
    n = len(paths)
    return (
        f"the store holds {n} entr{'y' if n == 1 else 'ies'} under \"{label}\"'s chunk plane "
        f"that no cell of its chunk grid names: {sorted(paths)} — \"{label}\" has {grid}. "
        "Being NAMED like a chunk key does not make an entry a chunk: bytes at a key the "
        "grid does not name are bytes no reader ever fetches and no check in this suite "
        "reads (DEC-8)"
    )


def a_grid_of(dims):
    """The grid an array node declares, as the violation names it (`1`, `7`, `1×1`)."""
    return (
        f"a chunk grid of {dims}, and a `c/` dir holds exactly the shard file of each of "
        "its cells"
    )


#: A GROUP has no index space at all, so this is NOT "an empty grid" — it is the absence of
#: one. The artifact root and a string member's parent are both groups, and both took bytes.
NO_CHUNK_GRID = (
    "no chunk grid at all — it is a GROUP, not an array, so no key under it can name a chunk"
)


def test_a_chunk_index_beyond_the_declared_grid_is_refused(tmp_path):
    """`value/c/7` on a member whose grid holds ONE chunk. Measured `[]`.

    The plainest form of the hole: a perfectly-shaped chunk key for a chunk that does not
    exist. `a_table(n=200)` writes `value` at `inner_chunk=4096`, `chunks_per_shard=1` — one
    shard, so `c/0` and nothing else — and `c/7` is bytes no reader will ever fetch, because
    `cyto_zarr_read.read_array` computes the same `ceil(shape/chunk_shape)` this rule does and
    stops at 0.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: the intact artifact conforms"
    )
    assert sorted(p.name for p in (root / "value" / "c").iterdir()) == ["0"], (
        "the fixture must have exactly one shard, or 'beyond the grid' means nothing"
    )
    (root / "value" / "c" / "7").write_bytes(b"bytes at a chunk that does not exist")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("1"), "value/c/7") in violations, violations


def test_an_absurd_chunk_index_is_refused(tmp_path):
    """`value/c/00000000123456789` — still "numeric", and silent under the name rule.

    Two faults in one key, and the rule refuses it for either: the index is past the end of
    every grid this writer can produce, AND the spelling is not one a reader BUILDS. The key
    space is the set of strings `f"{s}"` produces, so `007` is a file beside the real `7` that
    nothing will open — canonical decimal is part of the key, not a formatting preference.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    (root / "value" / "c" / "00000000123456789").write_bytes(b"x")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message(
        "value", a_grid_of("1"), "value/c/00000000123456789"
    ) in violations, violations


def test_a_non_canonical_spelling_of_a_REAL_chunk_index_is_refused(tmp_path):
    """`c/007` where `c/7` is a genuine shard — the same class with the range arm removed.

    Worth its own case because it is the one shape that the range check alone would let
    through: the index IS in the grid. It is still not a chunk, because the reader fetches
    `f"{s}"` and never `007`, so the file is unreadable-by-construction bytes sitting beside
    the real one. On the 7-shard fixture, `7` is out of range and `006` is in it, so `006` is
    the honest probe.
    """
    root = tmp_path / "many.zarr"
    structure = a_multi_shard_table(root, n=200, inner_chunk=16, chunks_per_shard=2)
    assert (root / "value" / "c" / "6").is_file(), "chunk 6 is a REAL shard of this fixture"
    (root / "value" / "c" / "006").write_bytes(b"a shard nothing will ever open")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("7"), "value/c/006") in violations, violations


def test_megabytes_parked_at_a_plausible_chunk_key_are_refused(tmp_path):
    """5 MiB of random bytes at `value/c/1`. Measured `[]`.

    Same rule as the case above, stated in the units that make the cost concrete: the hole
    was not a stray marker file, it was unbounded storage. Random bytes so the payload cannot
    be mistaken for anything a codec would accept — nothing decodes them because nothing
    reads them.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    (root / "value" / "c" / "1").write_bytes(os.urandom(5 << 20))
    assert (root / "value" / "c" / "1").stat().st_size == 5 << 20

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("1"), "value/c/1") in violations, violations


@pytest.mark.parametrize("node,rel", [
    ("the artifact root", "c/0"),
    ("label", "label/c/0"),
])
def test_a_chunk_plane_under_a_GROUP_node_is_refused(tmp_path, node, rel):
    """A group owns no chunks, so EVERY key under a `c/` it acquired is undeclared bytes.

    `test_a_chunk_plane_under_no_node_is_refused` covers `junk/c/0`, where the parent is not a
    node at all. These two are the case it does not reach: the parent IS a node, so the chunk
    rule ran — and a name rule had nothing to say, because `0` is exactly what a shard file is
    called. Both were measured `[]`. The artifact root and a string member's parent are the
    two groups every store has.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    planted = root / rel
    planted.parent.mkdir(parents=True, exist_ok=True)
    planted.write_bytes(b"a plausible-looking shard under a node that owns no chunks")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message(node, NO_CHUNK_GRID, rel) in violations, violations


def test_a_second_dimension_index_beyond_a_2D_members_width_is_refused(tmp_path):
    """`xy/c/0/1` — a 2-D member is chunked along ROWS only, so the width is ONE chunk.

    The dimensionality is where a grid rule is easiest to get wrong, and getting it wrong in
    this direction would accept an entire extra plane of files per member. `a_2d_table` is
    `shape [64, 3]` at `chunk_shape [4096, 3]`, i.e. a 1×1 grid whose only key is `0/0`.
    """
    root = tmp_path / "xy.zarr"
    structure = a_2d_table(root, n=64, width=3)
    assert (root / "xy" / "c" / "0" / "0").is_file(), "the only cell of a 1×1 grid"
    (root / "xy" / "c" / "0" / "1").write_bytes(b"a second column-chunk that cannot exist")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("xy", a_grid_of("1×1"), "xy/c/0/1") in violations, violations


def test_a_hidden_node_deeper_in_the_chunk_plane_is_refused(tmp_path):
    """`value/c/9/9/zarr.json` — the `c/sneaky` hiding place, respelled in digits.

    The name rule caught it, but only at the LEAF (`zarr.json` is not numeric), after
    descending two levels of a key space that does not exist. The grid rule refuses it at the
    first component and does not descend: there is nothing below a key the grid does not name,
    and one violation per hiding place is what an author needs to remove it.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    hidden = root / "value" / "c" / "9" / "9"
    hidden.mkdir(parents=True)
    (hidden / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group", "attributes": {}})
    )

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("1"), "value/c/9") in violations, violations


def test_a_shard_file_replaced_by_a_DIRECTORY_of_the_same_name_is_refused(tmp_path):
    """A cell of the grid is a FILE. A directory wearing a legal key's name is not a chunk.

    The one hiding place an in-range check alone would still leave open: `value/c/3` IS a cell
    of this member's 7-chunk grid, so the index arm has nothing to say, and everything under
    it inherits a legal prefix. The decoder reports the shard it can no longer read — that is
    the other half of the contract working (in-grid cells are READ, everything else is
    REPORTED), so this asserts the grid finding specifically rather than merely that the gate
    is unhappy.
    """
    root = tmp_path / "many.zarr"
    structure = a_multi_shard_table(root, n=200, inner_chunk=16, chunks_per_shard=2)
    shard = root / "value" / "c" / "3"
    assert shard.is_file(), "chunk 3 is a REAL shard of this fixture"
    shard.unlink()
    shard.mkdir()
    (shard / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group", "attributes": {}})
    )

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("7"), "value/c/3") in violations, violations


def test_bytes_parked_in_two_chunk_planes_are_refused_by_the_PRODUCTION_entry(tmp_path):
    """6 MiB across two members, through `conform_outputs` — the entry a run actually takes.

    Every case above calls `conform_artifact` directly. This one goes through the whole
    production path (`conform_outputs` → `conform_manifest` → `conform_artifact`, `full=True`)
    because that is the composition that returned `[]` while 6 MiB of undeclared bytes sat in
    the emitted artifact, and a hole is only closed at the depth a run reaches it.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    root = outputs / "good.zarr"
    structure = a_table(root, n=200)
    (outputs / "manifest.json").write_text(
        json.dumps({"outputs": [{"id": "good", "path": "good.zarr", "structure": structure}]})
    )
    assert conformance.conform_outputs(outputs) == [], "negative control: the run passes"

    (root / "value" / "c" / "3").write_bytes(os.urandom(3 << 20))
    (root / "group" / "c" / "4").write_bytes(os.urandom(3 << 20))

    violations = conformance.conform_outputs(outputs)
    assert f"good: {ungridded_message('value', a_grid_of('1'), 'value/c/3')}" in violations, (
        violations
    )
    assert f"good: {ungridded_message('group', a_grid_of('1'), 'group/c/4')}" in violations, (
        violations
    )


# ── an UNDERIVABLE grid: the answer that used to switch the grid rule OFF ───────────────
#
# The previous version of this section held ONE test,
# `test_an_underivable_grid_is_not_an_escape_hatch`, and it passed for the wrong reason. It
# exercised a single shape (`"{ this is not json"`) and generalised from it to the class,
# and that shape is one of the SIX that are independently refused (`_read_member_node`
# reports an unparseable document). Three of the nine were not, because the checks the
# docstring named read `shape` and `chunk_shape[0]` and nothing else. So the test certified
# the very hole it was written to exclude — a shipped bug with a passing test asserting it.
#
# What replaces it enumerates the shapes from the MODULE (every `_UnderivableGrid`
# construction site, traced) rather than from an author's list, which is the only version of
# "every shape" that a later edit cannot quietly shrink.


#: The fixed tail of [`conformance._underivable_grid_violation`]. Split out because two of
#: the shapes below carry an OS/JSON exception message inside the reason, so their assertion
#: is head-and-tail while the other seven are full equality.
UNDERIVABLE_TAIL = (
    " — so nothing bounds which chunk keys it HAS, and every byte under it would be held to "
    "a name rule alone. A node whose declaration yields no grid is MALFORMED, not exempt: "
    "`zarrReader`'s `#assertRowChunked` throws on exactly this metadata, so these are bytes "
    "the shipped client cannot open and no check in this suite bounds (DEC-8)"
)


def underivable_head(label, reason):
    """The part of the violation that names the node and why its document yields no grid."""
    return f'"{label}" holds a chunk plane but its own `zarr.json` {reason}'


def underivable_message(label, reason):
    """The WHOLE violation, for the shapes whose reason is deterministic."""
    return underivable_head(label, reason) + UNDERIVABLE_TAIL


def edit_meta(node_dir, edit):
    """Apply `edit` in place to a node's parsed `zarr.json` and write it back."""
    path = Path(node_dir) / "zarr.json"
    meta = json.loads(path.read_text())
    edit(meta)
    path.write_text(json.dumps(meta))


def write_meta_text(text):
    """A mutator that replaces a node's whole `zarr.json` with `text`."""
    return lambda node_dir: (Path(node_dir) / "zarr.json").write_text(text)


def make_meta_unreadable(node_dir):
    """A `zarr.json` that is still a FILE — so the walk treats the dir as a node — and cannot
    be read. A directory in its place would not do: `_store_nodes` decides node-ness with
    `is_file()`, so that shape never reaches the read at all."""
    os.chmod(Path(node_dir) / "zarr.json", 0o000)


def add_a_chunk_dimension(meta):
    """THE ORACLE'S MUTATION: a 1-D `shape` against a 2-D `chunk_shape`.

    Nothing else in the gate looks at the arity. `_conform_member` compares `shape` to the
    row and it still matches; `_conform_geometry` and `_shard_count` read `chunk_shape[0]`
    and it still matches; `_read_member_node` parses the document fine. So before the fix
    this was the one edit that left the grid underivable and EVERY other check satisfied.
    """
    cfg = meta["chunk_grid"]["configuration"]
    cfg["chunk_shape"] = list(cfg["chunk_shape"]) + [4096]


#: The reason `a_table(n=200)`'s `value` member gives after `add_a_chunk_dimension`. Written
#: out rather than read back from the module, so the assertion below is equality against a
#: literal and not the module agreeing with itself.
ARITY_REASON = (
    "declares a 1-dimensional `shape` [200] against a 2-dimensional `chunk_shape` "
    "[4096, 4096]"
)


#: The prefix `_raise_as_violation` gives an artifact whose check did not finish. Three of the
#: shapes below crash a member check BEFORE `_conform_node_coverage` runs (`meta["shape"][0]`
#: on an empty `shape`, and so on), and `conform_manifest` replaces that artifact's whole
#: verdict with this one line — so the grid violation is produced and then discarded. Those
#: rows are marked `aborts=True` and assert the crash arm explicitly rather than being
#: excused with an `or`: if a future edit moves one of the other six onto this arm, the
#: message stops reaching the verdict and this table is what says so.
ABORTED_PREFIX = "the gate could not finish reading these bytes: "


#: `(id, node, mutate, reason, aborts)` — EVERY shape of node metadata that leaves
#: `_chunk_grid` unable to derive a grid. One row per `_UnderivableGrid` construction site in
#: the module; `test_the_underivable_shape_table_covers_EVERY_construction_site` proves the
#: correspondence by tracing which sites these rows actually reach, so a row that stops
#: reaching one — or a tenth site added later — fails rather than shrinking the class
#: silently.
#:
#: `reason` is the whole reason where it is deterministic, and its leading deterministic part
#: where the module quotes an OS or JSON error inside it.
#:
#: Measured BEFORE the fix, through `conform_outputs` with bytes parked at `value/c/999`:
#: `arity-mismatch`, `extent-is-not-an-integer` (a FLOAT extent) and `step-is-not-an-integer`
#: (a STRING step) returned `[]` — three of the nine. The other six were refused by some
#: unrelated check, and generalising from ONE of those six to the whole class is exactly what
#: the deleted `test_an_underivable_grid_is_not_an_escape_hatch` did.
#:
#: The three rows here are the shape axis of that measurement. Its OTHER axis — the same
#: arity mismatch on every node kind, 1-D and 2-D, in both directions — is the kind sweeps
#: below; 11 (shape, node) cells were silent in total.
#:
#: `unreadable-document` (`make_meta_unreadable`, mode 000) is the FIRST row, and it is the
#: one that condemns an artifact for a PERMISSIONS setting rather than for its bytes. That
#: is a known, deliberate over-condemnation — see the RECORDED LIMITATION block in
#: `conformance.py` (above `ManifestReport`) for the two withdrawn attempts to route it
#: elsewhere. It stays in this table because it is a real `_UnderivableGrid` construction
#: site, and this table's whole job is to hold one row per site.
UNDERIVABLE_GRID_CASES = [
    ("unreadable-document", "value", make_meta_unreadable, "is not readable (", False),
    ("not-JSON", "value", write_meta_text("{ this is not json"),
     "is not parseable as JSON (", False),
    ("not-a-JSON-object", "value", write_meta_text('["not", "a", "document"]'),
     "is not a JSON object (it is a list)", False),
    ("shape-is-not-a-list", "value",
     lambda d: edit_meta(d, lambda m: m.__setitem__("shape", 200)),
     "declares no `shape` list (it declares 200)", True),
    ("chunk_shape-is-not-a-list", "value",
     lambda d: edit_meta(d, lambda m: m["chunk_grid"]["configuration"].pop("chunk_shape")),
     "declares no `chunk_grid.configuration.chunk_shape` list (it declares None)", True),
    ("shape-is-empty", "value", lambda d: edit_meta(d, lambda m: m.__setitem__("shape", [])),
     "declares an empty `shape`, which spans no index at all", True),
    ("arity-mismatch", "value", lambda d: edit_meta(d, add_a_chunk_dimension),
     ARITY_REASON, False),
    ("extent-is-not-an-integer", "value",
     lambda d: edit_meta(d, lambda m: m.__setitem__("shape", [200.0])),
     "declares a `shape` extent that is not a non-negative integer (200.0)", False),
    ("step-is-not-an-integer", "value",
     lambda d: edit_meta(d, lambda m: m["chunk_grid"]["configuration"].__setitem__(
         "chunk_shape", ["4096"])),
     "declares a `chunk_shape` step that is not a positive integer ('4096')", False),
]


def an_output_with_a_table(tmp_path, n=200):
    """`(outputs dir, artifact root, structure)` — an artifact reachable through the
    PRODUCTION entry.

    `conform_outputs` + a real `manifest.json` is the composition a run actually takes, and
    it is the composition at which the oracle measured `[]`.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    root = outputs / "good.zarr"
    structure = a_table(root, n=n)
    (outputs / "manifest.json").write_text(
        json.dumps({"outputs": [{"id": "good", "path": "good.zarr", "structure": structure}]})
    )
    return outputs, root, structure


@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
@pytest.mark.parametrize("case_id,node,mutate,reason,aborts", UNDERIVABLE_GRID_CASES,
                         ids=[c[0] for c in UNDERIVABLE_GRID_CASES])
def test_every_underivable_grid_shape_is_REFUSED(tmp_path, case_id, node, mutate, reason,
                                                 aborts, depth):
    """A grid the module cannot derive is a VIOLATION, for every shape that produces one.

    This is the fix for "absence selects a shallower check", applied to the function that was
    itself written to close that class. `None` meant "no answer", "no answer" switched the
    grid rule OFF, and what was left — the NAME rule — accepts any numerically-named entry.
    So an artifact whose member declared a grid nothing could derive got the pre-grid gate
    back, silently, and 12 MB rode in behind it.

    There is now no third answer to select. A node holding a chunk plane its own document
    cannot describe is refused for BEING that, which is also what the shipped reader does:
    `zarrReader`'s `#assertRowChunked` throws `zarr.json: chunk_grid chunk_shape has rank N,
    array has rank M` on the arity case, so the old verdict green-lit an artifact no client
    could open.

    Three assertions per shape, and the first is the one that makes this a class test rather
    than nine anecdotes:

    1. `_conform_node_coverage` — the production function that owns the store walk — reports
       the underivable-grid violation BY MESSAGE, for every shape. A shape refused by some
       unrelated check would fail here, which is the flaw in the test this replaces.
    2. `conform_outputs` refuses the artifact, at BOTH depths. No escape hatch.
    3. the message reaches that verdict, except on the three shapes that crash a member check
       first — which `aborts` states rather than tolerates.
    """
    outputs, root, structure = an_output_with_a_table(tmp_path)
    assert conformance.conform_outputs(outputs, full=depth) == [], (
        "negative control: the artifact conforms before the mutation"
    )

    mutate(root / node)
    grid = conformance._node_chunk_grid(root / node)
    assert isinstance(grid, conformance._UnderivableGrid), (
        f"{case_id}: this row must actually produce an underivable grid, or it tests "
        f"nothing. Got {grid!r} (for `unreadable-document`, running as root would do this)"
    )
    (root / node / "c" / "999").write_bytes(b"bytes riding in behind a grid nobody derived")

    head = underivable_head(node, reason)
    coverage = conformance._conform_node_coverage(root, structure)
    assert any(v.startswith(head) and v.endswith(UNDERIVABLE_TAIL) for v in coverage), (
        f"{case_id}: the grid rule must REPORT this shape, not be skipped for it. "
        f"Expected a violation starting {head!r}; got {coverage}"
    )

    violations = conformance.conform_outputs(outputs, full=depth)
    assert violations, f"{case_id}: an underivable grid must never produce a clean verdict"
    if aborts:
        assert len(violations) == 1 and violations[0].startswith(f"good: {ABORTED_PREFIX}"), (
            f"{case_id}: marked as crashing a member check first, so `conform_manifest` "
            f"replaces this artifact's whole verdict with one crash line. Got {violations}"
        )
    else:
        assert any(
            v.startswith(f"good: {head}") and v.endswith(UNDERIVABLE_TAIL) for v in violations
        ), f"{case_id}: expected a violation starting {head!r}. Got {violations}"


@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_the_ORACLE_12MB_behind_an_arity_mismatched_grid_is_refused(tmp_path, depth):
    """THE MEASUREMENT, as a test: 12,003,461 bytes at `value/c/999` + `c/1000`, through the
    production entry, with a real `manifest.json`. Verdict before the fix: `[]`.

    Kept separate from the shape sweep above, and separately named, because this is the
    finding rather than an instance of a class: the arity case is the one shape that no other
    check in the gate can see, at the byte volume that makes what the hole was worth
    concrete. The whole violation is asserted by EQUALITY — the exact node, the exact reason,
    the exact tail — so a later edit that broadens the message into something vaguer, or
    reports a different node, fails here.
    """
    outputs, root, _structure = an_output_with_a_table(tmp_path)
    assert conformance.conform_outputs(outputs, full=depth) == []

    edit_meta(root / "value", add_a_chunk_dimension)
    (root / "value" / "c" / "999").write_bytes(os.urandom(12_003_461))
    (root / "value" / "c" / "1000").write_bytes(os.urandom(4096))
    assert (root / "value" / "c" / "999").stat().st_size == 12_003_461

    violations = conformance.conform_outputs(outputs, full=depth)
    assert violations == [f"good: {underivable_message('value', ARITY_REASON)}"], violations


#: Every TABLE node an arity mismatch was measured silent on (the CSC trio and a 2-D member
#: are the two tests after this one). `value` is 1-D numeric, `group` is categorical, and
#: `label`'s two legs are the nodes whose ROW carries no geometry at all — the case a grid
#: rule keyed on the declaration instead of on the node's own document could not have covered.
ARITY_TABLE_NODES = ["value", "group", "label/offsets", "label/values"]


@pytest.mark.parametrize("node", ARITY_TABLE_NODES)
@pytest.mark.parametrize("longer", ["chunk_shape", "shape"])
def test_an_arity_mismatch_is_refused_on_every_node_kind_and_BOTH_directions(
    tmp_path, node, longer
):
    """The mismatch is a disagreement between two lists, so it has two directions.

    Measured against the pre-fix code: extending `chunk_shape` was SILENT on all four nodes
    (and on the CSC trio and a 2-D member — the two tests below), while extending `shape` was
    refused everywhere, by the row's `shape` comparison where there is one and by the decode
    where there is not. That asymmetry is exactly why the direction is swept rather than
    assumed: half the matrix happened to be caught by an unrelated check, and picking the
    wrong half is how a test certifies a hole. Only the underivable-grid violation covers all
    eight cells, and this asserts it on each.
    """
    outputs, root, _structure = an_output_with_a_table(tmp_path)
    assert conformance.conform_outputs(outputs) == []

    def widen(meta):
        if longer == "chunk_shape":
            add_a_chunk_dimension(meta)
        else:
            meta["shape"] = list(meta["shape"]) + [3]

    edit_meta(root / node, widen)
    (root / node / "c" / "999").write_bytes(b"bytes behind an arity mismatch")

    violations = conformance.conform_outputs(outputs)
    head = f'good: "{node}" holds a chunk plane but its own `zarr.json` declares a '
    assert any(v.startswith(head) and v.endswith(UNDERIVABLE_TAIL) for v in violations), (
        f"{node}/{longer}: got {violations}"
    )


@pytest.mark.parametrize("member", ["indptr", "indices", "data"])
def test_an_arity_mismatch_is_refused_on_every_CSC_member(tmp_path, member):
    """The sparse shape, whose three members have three different lengths and no row geometry.

    `_conform_sparse_csc` is a different composition from `_conform_table` and reaches
    `_conform_node_coverage` by its own route, so "refused for a table member" does not imply
    "refused here" — and all three were measured silent.
    """
    root = tmp_path / "m.zarr"
    structure = a_matrix(root)
    assert conformance.conform_artifact(root, structure, full=True) == []

    edit_meta(root / member, add_a_chunk_dimension)
    (root / member / "c" / "999").write_bytes(b"bytes behind an arity mismatch")

    violations = conformance.conform_artifact(root, structure, full=True)
    head = f'"{member}" holds a chunk plane but its own `zarr.json` declares a '
    assert any(v.startswith(head) and v.endswith(UNDERIVABLE_TAIL) for v in violations), (
        violations
    )


def test_an_arity_mismatch_is_refused_on_a_2D_member(tmp_path):
    """A 2-D member, where the mismatch is `[64, 3]` against a 3-D `chunk_shape`.

    The 1-D cases could all be satisfied by a rule that only ever compared `len(shape)` to 1.
    """
    root = tmp_path / "xy.zarr"
    structure = a_2d_table(root)
    assert conformance.conform_artifact(root, structure, full=True) == []

    edit_meta(root / "xy", add_a_chunk_dimension)
    (root / "xy" / "c" / "0" / "9").write_bytes(b"bytes behind an arity mismatch")

    violations = conformance.conform_artifact(root, structure, full=True)
    head = '"xy" holds a chunk plane but its own `zarr.json` declares a 2-dimensional `shape`'
    assert any(v.startswith(head) and v.endswith(UNDERIVABLE_TAIL) for v in violations), (
        violations
    )


def test_an_underivable_grid_is_refused_even_with_an_EMPTY_chunk_plane(tmp_path):
    """The refusal is about the NODE, not about what happens to be parked under it.

    An `n=0` member writes no shard and a real, empty `c/` — a legal shape the sweep below
    covers — so conditioning the refusal on having found entries would leave exactly that
    member free to declare a grid nothing can derive. It is emitted before the chunk walk
    runs, for that reason.
    """
    root = tmp_path / "empty.zarr"
    with cz.Table(root, axis="rows", n=0) as t:
        t.numeric("value", np.zeros(0, dtype=np.float32), dtype="float32")
        structure = t.close()
    assert conformance.conform_artifact(root, structure, full=True) == []
    assert list((root / "value" / "c").iterdir()) == [], "the fixture's chunk plane is empty"

    edit_meta(root / "value", add_a_chunk_dimension)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        v.startswith('"value" holds a chunk plane but its own `zarr.json` declares a ')
        and v.endswith(UNDERIVABLE_TAIL)
        for v in violations
    ), violations


def underivable_grid_sites():
    """Every LINE in `conformance.py` that constructs an `_UnderivableGrid`, read from the
    module's own source. The list of shapes is the module's, not this file's."""
    tree = ast.parse(Path(conformance.__file__).read_text())
    return {
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_UnderivableGrid"
    }


def test_the_underivable_shape_table_covers_EVERY_construction_site(tmp_path, monkeypatch):
    """THE GUARD ON THE SWEEP ABOVE, and the actual fix for the certifying test.

    The test this replaces exercised ONE shape and generalised to the class. A hand-written
    list is the same defect with more rows: it is the author's idea of "every shape", and
    nothing fails when the module grows a tenth.

    So the shapes are read from the MODULE. Every `_UnderivableGrid(...)` call site is
    collected from the source by `ast`, every row of `UNDERIVABLE_GRID_CASES` is run with the
    constructor traced, and the two sets must be EQUAL — not a subset either way. A new
    refusal shape added to `_chunk_grid` with no row here fails; a row that stops reaching
    the site it was written for fails too, rather than silently becoming a duplicate of
    another.
    """
    sites = underivable_grid_sites()
    assert len(sites) == len(UNDERIVABLE_GRID_CASES), (
        f"{len(sites)} construction site(s) in the module, {len(UNDERIVABLE_GRID_CASES)} "
        "row(s) here — every shape gets its own row"
    )

    reached = {}
    original = conformance._UnderivableGrid.__init__

    def record(self, reason):
        reached[sys._getframe(1).f_lineno] = reason
        original(self, reason)

    monkeypatch.setattr(conformance._UnderivableGrid, "__init__", record)

    for case_id, node, mutate, _reason, _aborts in UNDERIVABLE_GRID_CASES:
        root = tmp_path / f"{case_id}.zarr"
        a_table(root, n=200)
        mutate(root / node)
        before = set(reached)
        grid = conformance._node_chunk_grid(root / node)
        assert isinstance(grid, conformance._UnderivableGrid), (case_id, grid)
        # Exactly one NEW site per row. Every refusal returns immediately, so a row that
        # lands on a site an earlier row already covered is a duplicate wearing two names —
        # which is how a table of nine rows comes to test eight shapes.
        assert set(reached) - before, (
            f"{case_id} reached no NEW construction site — it duplicates an earlier row. "
            f"Reached so far: {sorted(reached)}"
        )

    assert set(reached) == sites, (
        f"construction sites in the module: {sorted(sites)}; sites the table reaches: "
        f"{sorted(reached.items())}. Every shape the module can refuse must have a row"
    )


def test_the_underivable_site_scan_actually_finds_the_sites(tmp_path):
    """The scan above is only a guard if it can SEE a site — a scanner that matched nothing
    would make the coverage assertion vacuously true in both directions at once.

    So it is run against a source that has a known extra one.
    """
    real = underivable_grid_sites()
    # Tied to the TABLE rather than to a literal, in both directions: the class has been 8
    # and is 9 (the "is not readable" site was deleted by the doctrine commit and restored by
    # the revert that withdrew it — see the note on `UNDERIVABLE_GRID_CASES`, whose first row
    # is that site). A floor written as a number goes stale exactly when the class changes,
    # which is when it has to hold; the `>= 8` is a floor on the SCANNER, not on the class.
    assert len(real) == len(UNDERIVABLE_GRID_CASES) >= 8, (sorted(real), UNDERIVABLE_GRID_CASES)

    extended = tmp_path / "extended.py"
    extended.write_text(
        Path(conformance.__file__).read_text()
        + "\n\ndef _a_tenth_shape():\n    return _UnderivableGrid('invented for this test')\n"
    )
    tree = ast.parse(extended.read_text())
    found = {
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_UnderivableGrid"
    }
    assert real < found and len(found) == len(real) + 1, (sorted(found), sorted(real))


def test_a_group_node_still_answers_NO_CHUNK_PLANE_rather_than_underivable(tmp_path):
    """The one 'no grid' answer that is a FACT and not a refusal, pinned so the fix above
    cannot swallow it.

    A group owns no index space, which is a statement about its KIND — every conforming store
    has two of them (the artifact root and a string member's parent), and turning that into a
    violation would refuse every artifact there is. The distinction the fix rests on is
    exactly this one, so it is asserted rather than left to the class hierarchy.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    for group in (root, root / "label"):
        meta = json.loads((group / "zarr.json").read_text())
        assert meta.get("shape") is None and meta.get("chunk_grid") is None
        assert conformance._chunk_grid(meta) is conformance._NO_CHUNK_PLANE, group

    # …and a group that acquired a chunk plane is still reported as a GROUP, not as a node
    # with an underivable grid: the message tells the author it owns no chunks at all.
    (root / "label" / "c").mkdir()
    (root / "label" / "c" / "0").write_bytes(b"a plausible shard under a group")
    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("label", NO_CHUNK_GRID, "label/c/0") in violations, violations


def test_a_truncated_chunk_walk_returns_no_answer_not_a_partial_one(tmp_path):
    """The bound, at the function whose contract it is.

    `_chunk_dir_violations` returns `None` for the count when it stops early, and the caller
    withholds the node SET so coverage is skipped rather than compared against a truncated
    one — the same convention both walks already follow. What the bound must NOT do is unfind
    what it already found: the entries classified before it was reached are still returned,
    because a bound is a statement about the walk, not about those bytes.
    """
    root = tmp_path / "many.zarr"
    structure = a_multi_shard_table(root, n=200, inner_chunk=16, chunks_per_shard=2)
    cdir = root / "value" / "c"
    (cdir / "7").write_bytes(b"one past the grid")
    (cdir / "8").write_bytes(b"two past the grid")

    # Enter the walk with room for every entry but the LAST, so `7` is classified and `8`
    # trips the bound. Derived from the directory rather than typed, so a writer change moves
    # it instead of quietly turning this into a test of an untruncated walk.
    entries = sorted(cdir.iterdir())
    assert [p.name for p in entries] == [str(i) for i in range(9)], entries
    seen, strays, ungridded, unreadable = conformance._chunk_dir_violations(
        root, cdir, conformance._CHUNK_WALK_LIMIT - (len(entries) - 1), [7]
    )
    assert seen is None, "a truncated walk reports no count, not a partial one"
    assert strays == []
    assert unreadable == [], "nothing here is unreadable; a bound is not an I/O fault"
    assert ungridded == ["value/c/7"], (
        f"a bound reached does not unfind what was already found. Got {ungridded}"
    )

    violations = conformance.conform_artifact(root, structure, full=True)
    assert ungridded_message("value", a_grid_of("7"), "value/c/7", "value/c/8") in violations, (
        "unbounded, BOTH out-of-grid entries are named by one violation"
    )


#: `n` values the writer/derivation sweep covers. Dense from 0 (an EMPTY array writes no
#: shard at all and its `c/` is a real, empty directory) through 69, which crosses the
#: small-geometry shard boundary (`inner_chunk=16 * chunks_per_shard=2` = 32 rows) twice;
#: then every boundary of the DEFAULT geometry up to 8193, where `shard_chunks` derives
#: `chunks_per_shard` from `n` itself and the arithmetic changes shape.
GRID_SWEEP_NS = sorted(set(
    list(range(0, 70))
    + [95, 96, 97, 127, 128, 129, 255, 256, 257, 4095, 4096, 4097, 8191, 8192, 8193]
))

#: The explicitly-declared geometry arm of the sweep. It matters because the DERIVED default
#: (`shard_chunks`) puts every array up to ~16.8M elements in ONE shard, so a sweep of the
#: default alone would never produce a multi-cell grid and would pass with the per-dimension
#: arithmetic arbitrarily wrong.
GRID_SWEEP_SMALL_GEOMETRY = {"inner_chunk": 16, "chunks_per_shard": 2}


def chunk_grid_cells(root, member):
    """Every chunk key `conformance._chunk_grid` says the member HAS, as store-relative keys.

    The cross-product is materialized HERE and never in the module: the gate classifies one
    entry at a time against the grid precisely so it never has to hold the key set, and a
    test is the only place that can afford to.
    """
    grid = conformance._chunk_grid(cyto_zarr_read.read_meta(root, member))
    assert isinstance(grid, list), f"{member}: an array node must have a derivable grid"
    return {"/".join(str(i) for i in cell)
            for cell in itertools.product(*[range(d) for d in grid])}


def chunk_files_on_disk(root, member):
    """Every chunk key the WRITER actually emitted, read off the filesystem."""
    cdir = Path(root) / member / "c"
    return {str(p.relative_to(cdir)).replace("\\", "/")
            for p in cdir.rglob("*") if p.is_file()}


def test_the_derived_grid_is_EXACTLY_the_real_writers_chunk_key_set(tmp_path):
    """THE NEGATIVE CONTROL, and the one that decides whether this rule may ship at all.

    A grid rule that is wrong about the grid REFUSES CONFORMING ARTIFACTS, which is worse
    than the hole it closes. So the derivation is not merely asserted to be quiet — it is
    compared, set against set, with what the writer put on disk, at every `n` in
    `GRID_SWEEP_NS` × two geometries × the four member shapes a store has (1-D, 2-D, and a
    string member's two legs, whose row declaration carries no geometry at all), plus the CSC
    trio. Symmetric difference must be empty in BOTH directions: a derived key with no file
    would be a rule that refuses a real store, and a file with no derived key is the hole.

    The counts are asserted and reported so the control cannot silently stop controlling
    anything — a sweep that wrote nothing would otherwise pass with the rule arbitrarily
    wrong.
    """
    compared = 0
    chunk_files = 0
    for n in GRID_SWEEP_NS:
        for tag, geometry in (("default", {}), ("small", GRID_SWEEP_SMALL_GEOMETRY)):
            root = tmp_path / f"n{n}-{tag}.zarr"
            with cz.Table(root, axis="rows", n=n) as t:
                t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32", **geometry)
                t.numeric("xy", np.zeros((n, 3), dtype=np.float32), dtype="float32", **geometry)
                t.string("label", [f"r{i}" for i in range(n)])
                structure = t.close()
            for member in ("value", "xy", "label/offsets", "label/values"):
                derived = chunk_grid_cells(root, member)
                stored = chunk_files_on_disk(root, member)
                assert derived == stored, (
                    f"n={n} ({tag}) {member}: the derived grid and the writer's own chunk "
                    f"files disagree on {sorted(derived ^ stored)[:8]}"
                )
                compared += 1
                chunk_files += len(stored)
            assert conformance.conform_artifact(root, structure, full=True) == [], (
                f"n={n} ({tag}): a conforming artifact must stay conforming"
            )
            shutil.rmtree(root)
    assert compared == len(GRID_SWEEP_NS) * 2 * 4, compared
    assert chunk_files >= 900, (
        f"only {chunk_files} chunk file(s) across {compared} member(s) — a control that "
        "compares almost no files controls almost nothing"
    )


def test_the_derived_grid_is_EXACTLY_the_writers_chunk_key_set_for_the_CSC_trio(tmp_path):
    """The same control on the sparse shape, whose three members have three DIFFERENT lengths.

    `indptr` is `n_cols + 1`, `indices` and `data` are both `nnz`, and none of the three
    carries a `name` or an `axis` in its row. If a grid derivation were quietly keyed on the
    artifact's row count rather than on each member's own metadata, this is the fixture that
    catches it.
    """
    compared = 0
    chunk_files = 0
    for n_rows in (1, 2, 40, 300, 4097):
        root = tmp_path / f"m{n_rows}.zarr"
        dense = np.zeros((n_rows, 6), dtype=np.float32)
        for r in range(n_rows):
            dense[r, r % 6] = float(r % 6) + 1.0
        structure = cyto_csc.write_csc_zarr(
            cyto_csc.ArraySource(dense), root, axes=("rows", "columns")
        )
        for member in ("indptr", "indices", "data"):
            derived = chunk_grid_cells(root, member)
            stored = chunk_files_on_disk(root, member)
            assert derived == stored, (
                f"n_rows={n_rows} {member}: derived {sorted(derived)} vs stored "
                f"{sorted(stored)}"
            )
            compared += 1
            chunk_files += len(stored)
        assert conformance.conform_artifact(root, structure, full=True) == []
    assert compared == 15 and chunk_files >= 15, (compared, chunk_files)


#: `(relative path to plant a file at, what kind of hiding place it is)`. Every one of these
#: produced NO violation before the file-coverage rule: the walk collected DIRS holding a
#: `zarr.json` and never looked at a file, so `c/` was one instance of "somewhere the walk does
#: not look" and the class was "the walk looks for nodes, and bytes are files".
UNACCOUNTED_FILES = [
    ("evil", "the artifact root"),
    ("value/evil", "inside a member node's own directory"),
    ("junk/evil", "under a directory that is not a node at all"),
    ("label/evil", "inside a string member's group directory"),
    ("label/offsets/evil", "inside a string member's leg node"),
    ("value/c.bak", "beside the chunk dir, under a name the chunk rule never sees"),
]


@pytest.mark.parametrize("rel,where", UNACCOUNTED_FILES)
def test_a_file_no_node_accounts_for_is_refused(tmp_path, rel, where):
    """An artifact's file set is fully determined, so the rule is TOTAL rather than a list.

    Every file in an artifact is some node's `zarr.json` or a chunk under that node's `c/`.
    There is no third kind — so bytes at any other path are bytes no declaration describes and
    no check in this suite reads, which is the same undeclared-bytes fault as a member dropped
    from `columns`, one level finer.

    Safe against the production staging path, verified on the Rust side rather than assumed:
    `sandbox::inputs::stage_prefix_members` creates a FRESH per-artifact dir and hardlinks in
    exactly the members of that artifact's own manifest (`Stager::report` only logs), so a
    staged tree contains the artifact and nothing else. And it is load-bearing rather than
    tautological, because the member manifest and `structure.columns` are DIFFERENT lists: a
    file can be a staged manifest member while nothing in the declaration accounts for it.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: the intact artifact must conform, or this case proves nothing"
    )
    planted = root / rel
    planted.parent.mkdir(parents=True, exist_ok=True)
    planted.write_bytes(b"bytes nobody declared")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("that no node accounts for" in v and rel in v for v in violations), (
        f"a file planted {where} ({rel}) was not reported — bytes in an artifact that no node "
        f"accounts for are bytes nothing in this suite reads. Got {violations}"
    )


def test_a_chunk_plane_under_no_node_is_refused(tmp_path):
    """`c/0` is a perfectly-formed chunk key. Under a dir that is not a node, it is not a chunk.

    The chunk-key rule alone would accept these bytes — the name is exactly what a real shard
    file is called — so the parent has to be a node for the dir to be a chunk plane at all.
    Otherwise `junk/c/0` is a hiding place whose contents pass the naming check.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    (root / "junk" / "c").mkdir(parents=True)
    (root / "junk" / "c" / "0").write_bytes(b"a plausible-looking shard")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("that no node accounts for" in v and "junk/c" in v for v in violations), (
        f"a chunk plane belongs to a member; under a non-node there is no member for these "
        f"bytes to be the chunks OF. Got {violations}"
    )


def test_a_conforming_artifacts_WHOLE_FILE_SET_is_accepted(tmp_path):
    """NEGATIVE CONTROL for the total rule, and the one that stops it being a liability.

    A total rule over files is only safe if it accepts every file the real writers emit, so
    this walks the actual file set of all four artifact shapes — a table with one member of each
    kind, a 2-D `arrays` member, a multi-shard member, and the CSC trio — and asserts the gate
    is silent about every one of them. The file count is asserted non-trivial first: a control
    over an artifact with three files would pass with the rule badly wrong.
    """
    shapes = {
        "t.zarr": a_table(tmp_path / "t.zarr", n=64),
        "xy.zarr": a_2d_table(tmp_path / "xy.zarr"),
        "many.zarr": a_multi_shard_table(tmp_path / "many.zarr"),
        "m.zarr": a_matrix(tmp_path / "m.zarr"),
        "s.zarr": a_string_table(tmp_path / "s.zarr", ["a", "bb", "", "ünïcode"]),
    }
    # Measured, not guessed: 10 / 3 / 17 / 7 / 6 = 43 files for these five shapes. The floors
    # are one short of the measurement so a writer change shows up as a fixture failure here
    # rather than as a control that silently stopped controlling anything.
    total = 0
    for name, structure in shapes.items():
        root = tmp_path / name
        files = [p for p in root.rglob("*") if p.is_file()]
        assert len(files) >= 3, f"{name}: {len(files)} file(s) is too few to control anything"
        total += len(files)
        stored, violations = conformance._store_nodes(root)
        assert stored is not None and violations == [], (
            f"{name}: the real writer's own file set must be accepted in full — a total rule "
            f"that refuses a conforming artifact is worse than no rule. Got {violations}"
        )
        assert conformance.conform_artifact(root, structure, full=True) == []
    assert total >= 42, f"only {total} files across all five shapes — the control is thin"


def test_an_empty_directory_is_not_reported_because_it_holds_no_bytes(tmp_path):
    """The rule is about FILES, deliberately.

    An empty directory tree carries nothing for a declaration to be missing about, and
    reporting it would make the gate fail artifacts over filesystem residue rather than over
    bytes. Stated as a test so the choice is visible rather than incidental.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    (root / "empty" / "deeper").mkdir(parents=True)
    assert conformance.conform_artifact(root, structure, full=True) == []


def test_the_file_rule_is_rooted_at_the_ARTIFACT_not_at_the_inputs_dir(tmp_path):
    """The production boundary the total rule could get wrong, pinned.

    In production the gate is handed `/inputs` and each entry's `path` names a per-artifact
    subpath (`jobs::conformance`), while `/inputs` ITSELF holds two derived siblings —
    `sandbox::inputs::DERIVED_INPUT_FILES` = `params.json` + `inputs.json` — plus, on the CLI
    route, `manifest.json`. Those are one level UP from any artifact and are not artifact bytes.
    A file rule rooted at `/inputs` instead of at the artifact dir would report all three as
    unaccounted on EVERY run, which is a gate that fails every conforming batch.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    structure = a_table(outputs / "good.zarr", n=64)
    (outputs / "manifest.json").write_text(
        json.dumps({"outputs": [{"id": "good", "path": "good.zarr", "structure": structure}]})
    )
    # The two derived siblings the sandbox binds at `/inputs/`, beside the artifact dir.
    (outputs / "params.json").write_text(json.dumps({"outputs": []}))
    (outputs / "inputs.json").write_text(json.dumps({}))

    assert conformance.conform_outputs(outputs) == [], (
        "the derived `/inputs` siblings are not artifact bytes; a rule that reports them "
        "fails every production run"
    )


@pytest.mark.parametrize("limit_name,fixture", [
    ("_NODE_WALK_LIMIT", "t.zarr"),
    ("_CHUNK_WALK_LIMIT", "many.zarr"),
])
def test_a_walk_that_hits_its_bound_is_REPORTED_not_passed(tmp_path, monkeypatch, limit_name,
                                                          fixture):
    """"Too many entries to enumerate" must never read as "everything is accounted for".

    Both walks are bounded, and a bound is where a coverage claim quietly becomes vacuous: the
    walk stops early, the sets it compares are partial, and the difference comes out empty. So
    exceeding either bound returns NO node set at all (`None`) and a violation, and the coverage
    comparison is skipped rather than run against a truncated answer.
    """
    root = tmp_path / fixture
    structure = (
        a_table(root, n=200) if fixture == "t.zarr" else a_multi_shard_table(root)
    )
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: unbounded, this artifact conforms"
    )
    monkeypatch.setattr(conformance, limit_name, 1)

    stored, violations = conformance._store_nodes(root)
    assert stored is None, (
        f"{limit_name}: a truncated walk must return no node set — returning a partial one "
        "makes `declared - stored` report phantom missing nodes and `stored - declared` miss "
        "real ones"
    )
    assert any("unverified rather than accepted" in v for v in violations), violations
    assert conformance._conform_node_coverage(root, structure) == violations, (
        "the coverage check must surface the bound instead of comparing partial sets"
    )
    assert conformance.conform_artifact(root, structure, full=True), (
        "a gate that cannot finish looking must not return a clean verdict"
    )


# ── a directory the walk cannot OPEN is the same statement as a bound reached ────


def unenumerable(path):
    """`path` at mode 0o111 — searchable, so every stat below it still works, but not
    LISTABLE. Restores 0o755 on the way out so pytest can clean the tmp tree up.

    The precondition is asserted rather than skipped: run as root, `iterdir()` succeeds and
    every assertion below would pass for the wrong reason, and a test that quietly stops
    testing is the failure this whole file exists to prevent.
    """
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        os.chmod(path, 0o111)
        try:
            try:
                sorted(Path(path).iterdir())
            except OSError:
                pass
            else:
                raise AssertionError(
                    f"{path} at mode 0o111 is still listable — this process can read any "
                    "directory (running as root?), so the fault under test cannot occur and "
                    "the assertions below would hold vacuously"
                )
            yield
        finally:
            os.chmod(path, 0o755)

    return _ctx()


def a_store_with_a_subtree_at(tmp_path, hide_in):
    """A conforming `zarr_v3` table with an undeclared node + an unaccounted file parked
    under `hide_in`. Drives the two STORE walks (`_store_nodes`, `_chunk_dir_violations`)."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    hidden = root / hide_in
    hidden.mkdir(parents=True, exist_ok=True)
    (hidden / "evil.bin").write_bytes(b"\x00" * 32)
    (hidden / "ghost").mkdir()
    (hidden / "ghost" / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group"})
    )
    return root, structure, hidden


def an_opaque_store_hiding_its_node_document(tmp_path):
    """A real Zarr store DECLARED `opaque`, whose only `zarr.json` sits one directory down.

    Drives the third walk — [`conformance._bytes_are_not_a_store`], the DEC-8 anti-bypass
    check. This is the shape that survived the round which fixed the other two: that walk
    used `Path.rglob("*")`, whose recursion swallows `PermissionError` inside pathlib, so
    the check could not see the node document that refutes the declaration and the artifact
    went out INDETERMINATE — statuses untouched, still serving.
    """
    root = tmp_path / "t.opaque"
    hidden = root / "sub"
    hidden.mkdir(parents=True)
    (hidden / "zarr.json").write_text(json.dumps({"zarr_format": 3, "node_type": "group"}))
    structure = {"encoding": "opaque", "media_type": "application/octet-stream"}
    return root, structure, hidden


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(lambda p: a_store_with_a_subtree_at(p, "hidden"), id="node-walk"),
        pytest.param(lambda p: a_store_with_a_subtree_at(p, "value/c"), id="chunk-walk"),
        pytest.param(an_opaque_store_hiding_its_node_document, id="opaque-anti-bypass-walk"),
    ],
)
def test_a_directory_the_walk_cannot_enumerate_is_reported_not_skipped(tmp_path, build):
    """All THREE WALK sites, which were the three places in this module where an OS fault on
    an enumeration did not become a violation.

    A swallowed directory is not "one skipped directory": a walk is how coverage is
    established, so it contributed no node, no unaccounted file, no chunk entry — and, at the
    third site, no `zarr.json` to the check that refutes an `opaque` declaration. The store
    then came back CLEAN. Measured through `verify_conformance.main()` before each fix:

    * the two store walks — this artifact at 0o755 exits 1 naming what is hidden; at 0o111 it
      exited **0** with `violations: {}` and a full receipt.
    * the anti-bypass walk — at 0o755 `violations: {<aid>: ["… the bytes are a Zarr store
      …"]}` (→ `status='failed'`); at 0o111 AND 0o000 `violations: {}`, `checked: []`,
      `evidence: {}` (→ `GateOutcome::Indeterminate`, statuses untouched).

    A false condemnation is visible and recoverable; both of those were false passes.

    Parametrized over all three sites because a fix to some of them is exactly the asymmetry
    the doctrine withdrawal existed to remove — one rule, no branch that disagrees. The third
    case is in this list because it was NOT: the first fix shipped with a source scanner over
    `except OSError` bodies, and the third swallow had no handler for it to see.
    """
    root, structure, hidden = build(tmp_path)

    readable = conformance.conform_artifact(root, structure, full=True)
    assert readable, (
        "negative control: with the directory READABLE this artifact is already refused, so "
        "an empty answer below would mean the mode changed the verdict rather than the mode "
        "being missed"
    )

    with unenumerable(hidden):
        violations = conformance.conform_artifact(root, structure, full=True)
        assert violations, (
            "a directory the gate could not open must not read as an empty one — an "
            f"unreadable {hidden.name}/ came back clean, which is a green verdict over bytes "
            "nothing enumerated"
        )
        assert any("could not enumerate" in v for v in violations), violations


def test_an_unenumerable_directory_is_refused_for_being_unenumerable(tmp_path):
    """…and not for what happened to be inside it.

    The rule is "we could not look", so it cannot depend on the contents: an EMPTY directory
    at mode 0o111 is refused exactly like one hiding an undeclared node, because from the
    walk's side those two are the same observation. A version that only condemned when
    something was found would be unimplementable — finding it is the thing the mode prevents.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    empty = root / "empty"
    empty.mkdir()
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: an EMPTY directory holds no bytes, so a readable one is not a "
        "violation — see `test_an_empty_directory_is_not_reported_because_it_holds_no_bytes`"
    )

    with unenumerable(empty):
        violations = conformance.conform_artifact(root, structure, full=True)
        assert any("could not enumerate" in v for v in violations), violations
        stored, _ = conformance._store_nodes(root)
        assert stored is None, (
            "the node SET must be withheld too: a subtree the walk could not enumerate makes "
            "the set partial for the same reason a tripped bound does, and comparing a "
            "partial set with the declaration reports phantom missing nodes in one direction "
            "and misses real undeclared ones in the other"
        )


def oserror_handlers(source):
    """`{lineno: [statement type names]}` for every `except OSError…` in `source`."""
    out = {}
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.ExceptHandler) or node.type is None:
            continue
        names = [
            n.id
            for n in ast.walk(node.type)
            if isinstance(n, ast.Name)
        ]
        if "OSError" in names:
            out[node.lineno] = [type(s).__name__ for s in node.body]
    return out


def test_no_OSError_handler_in_the_module_discards_the_fault(tmp_path):
    """The tripwire under the RECORDED LIMITATION block's central sentence.

    That block asserts every `except OSError` here renders the fault as a violation. It was
    written as a description of the code and was false of three of the nine clauses, and a
    sentence is not a mechanism — the divergence stood in prose until an audit measured it.

    ## What this does NOT catch, stated because it already missed one

    It fails a handler whose body is nothing but `continue`/`pass`, which is the exact shape
    two of the three swallows had. It is a tripwire on one spelling, not a proof:

    * `except OSError: entries = []` evades it — a different body, same silence.
    * **A swallow with no handler at all evades it completely.** That is not hypothetical: it
      is how the THIRD site survived the round this scanner shipped in. `_bytes_are_not_a_
      store` enumerated with `Path.rglob`, whose recursion catches `PermissionError` inside
      pathlib, so there was no `except OSError` in this module for this function to scan and
      its empty answer meant nothing about that site.
      `test_no_recursive_enumeration_hides_its_own_errors` is the companion for that class,
      and it has its own list of what IT cannot see.

    This repo has paid twice for treating a source scanner as a proof, and the paragraph above
    is the third instalment. The PROOF is the three behavioural cases above, which assert the
    VERDICT rather than the syntax; this only makes the cheapest regression loud, and it is
    checked against a source with a known swallow so it cannot pass by matching nothing.
    """
    source = Path(conformance.__file__).read_text()
    handlers = oserror_handlers(source)
    assert len(handlers) >= 8, (
        f"only {len(handlers)} `except OSError` clause(s) found — the scanner has stopped "
        "seeing the module it is meant to guard"
    )
    swallows = {
        line: body
        for line, body in handlers.items()
        if set(body) <= {"Continue", "Pass"}
    }
    assert swallows == {}, (
        f"`except OSError` clause(s) at {sorted(swallows)} discard the fault. An unreadable "
        "subtree then reads as an empty one, which is a CLEAN verdict over bytes nothing "
        "looked at — see `_unreadable_dir_violations` for the measurement"
    )

    planted = source + (
        "\n\ndef _a_planted_swallow(p):\n"
        "    try:\n        return sorted(p.iterdir())\n"
        "    except OSError:\n        pass\n"
    )
    assert any(
        set(body) <= {"Continue", "Pass"} for body in oserror_handlers(planted).values()
    ), "the scanner cannot see a swallow, so its empty answer above means nothing"


#: Recursive enumerations that report NOTHING when a directory cannot be listed. `rglob` /
#: `glob` / `iglob` have no error hook at all; `os.walk` and `Path.walk` have one and default
#: it to "ignore". The value is the keyword that makes the errors visible, or `None` when the
#: interface offers none and the call is therefore banned outright.
SILENT_RECURSIVE_ENUMERATORS = {
    "rglob": None,
    "glob": None,
    "iglob": None,
    "walk": "onerror",
}


def silent_recursive_enumerations(source):
    """`[(lineno, name)]` for every call in `source` to a recursive enumerator that cannot
    report a directory it failed to list.

    `os.walk(..., onerror=f)` and `Path.walk(..., on_error=f)` are NOT reported: passing the
    hook is exactly the act of making the fault visible, which is what the rule asks for.
    """
    out = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.attr if isinstance(func, ast.Attribute)
            else func.id if isinstance(func, ast.Name)
            else None
        )
        if name not in SILENT_RECURSIVE_ENUMERATORS:
            continue
        hook = SILENT_RECURSIVE_ENUMERATORS[name]
        if hook is not None and any(
            kw.arg in (hook, "on_error") for kw in node.keywords
        ):
            continue
        out.append((node.lineno, name))
    return out


def test_no_recursive_enumeration_hides_its_own_errors():
    """The companion tripwire for the swallow that has NO handler to scan.

    `test_no_OSError_handler_in_the_module_discards_the_fault` walks `except OSError` BODIES.
    That is structurally blind to a fault caught inside the standard library, and the blind
    spot was occupied: `_bytes_are_not_a_store` — the DEC-8 anti-bypass check, the one thing
    standing between an `opaque` declaration and a real Zarr store — enumerated with
    `Path.rglob("*")`, whose recursion catches `PermissionError` internally. Measured through
    the real `verify_conformance.main()` on an `opaque`-declared store whose only `zarr.json`
    sat at `sub/zarr.json`, varying only that mode: `0o755` → condemned; `0o111` and `0o000` →
    `violations: {}`, `checked: []`, `evidence: {}`, i.e. `GateOutcome::Indeterminate` with
    every row keeping the status ingest gave it. One `chmod` on a subdirectory of a
    processor's own output turned a condemnation into unverified-and-still-serving.

    So this bans the CALL rather than looking for a handler: within this module, an
    enumeration that recurses must be one whose failures are visible. `iterdir` qualifies —
    it RAISES, which is why all three walks now use it.

    ## What this does NOT catch — read this before trusting an empty answer

    It is a name-and-keyword scan of one file's AST, and it proves nothing beyond that:

    * **Only these names** (`SILENT_RECURSIVE_ENUMERATORS`). A recursive enumerator reached
      by any other spelling — `shutil` internals, `os.fwalk`, `scandir` recursion in a helper
      module, a third-party walker, `getattr(p, "rgl" + "ob")` — is invisible here.
    * **Only this module.** `cyto_zarr_read` and the processor entries are not scanned.
    * **It does not check that the errors are USED.** `os.walk(onerror=lambda e: None)`
      passes this and swallows exactly as hard; the keyword is a shape, not a semantics.
    * **It says nothing about whether a banned call would actually fail open.** An `rglob`
      over a tree the gate does not draw conclusions from is harmless and would still fail
      here. That is deliberate — the rule is cheap to obey — but it means a failure is a
      prompt to look, not a proof of a bug.

    The PROOF is `test_a_directory_the_walk_cannot_enumerate_is_reported_not_skipped`, which
    asserts the VERDICT at all three walk sites. This makes the cheapest regression loud.
    """
    source = Path(conformance.__file__).read_text()
    found = silent_recursive_enumerations(source)
    assert found == [], (
        f"{found} — a recursive enumeration whose errors are invisible. A directory it "
        "cannot list is SKIPPED, so an unreadable subtree reads as an empty one and the "
        "walk's coverage claim covers bytes nothing enumerated. Enumerate with `iterdir` "
        "(which raises) and report the fault via `_unreadable_dir_violations`, as all three "
        "walks do — see `_bytes_are_not_a_store` for the measurement"
    )

    planted = source + (
        "\n\ndef _a_planted_silent_walk(p):\n"
        "    return [x for x in p.rglob('*')]\n"
        "\n\ndef _a_planted_silent_oswalk(p):\n"
        "    return list(os.walk(p))\n"
    )
    planted_names = {name for _, name in silent_recursive_enumerations(planted)}
    assert planted_names == {"rglob", "walk"}, (
        f"the scanner saw {planted_names} in a source with a planted `rglob` AND a planted "
        "bare `os.walk`, so its empty answer above means nothing"
    )

    hooked = source + (
        "\n\ndef _a_planted_reporting_walk(p, sink):\n"
        "    return list(os.walk(p, onerror=sink))\n"
    )
    assert silent_recursive_enumerations(hooked) == [], (
        "an `os.walk` that IS given an error hook must not be reported — a scanner that "
        "cannot be satisfied is one authors route around"
    )


def test_a_declared_shard_count_that_is_not_the_stored_one_is_rejected(tmp_path):
    """`shards` is required, therefore compared — a required key the gate does not check
    would be a presence ritual."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    structure["columns"][0]["shards"] = 99
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("declares 99 shard(s)" in v for v in violations), violations


def test_a_string_member_that_lies_about_its_payload_length_is_refused(tmp_path):
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    label = next(c for c in structure["columns"] if c["path"] == "label")
    label["n_bytes"] = int(label["n_bytes"]) + 1
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("declares n_bytes" in v for v in violations), violations


# ── the SECOND copy of a member's declaration (the group's was the only one checked) ──
#
# `_conform_group_attributes` compares the GROUP's stamped `attributes.cyto` against the
# row's `structure` because "two copies that can drift is exactly the class of bug this
# suite exists for". `write_array` stamps a THIRD copy per MEMBER and nothing compared it —
# so the same argument, one level down, was unmade.


def test_a_members_own_stamped_declaration_is_cross_checked(tmp_path):
    """The oracle: corrupt ONLY `<member>/zarr.json`, and the store-URL consumer diverges.

    Nothing else is touched — the artifact row, the group stamp and every byte are exactly
    as written — so no check that reads the row, the group or the bytes can see this. What
    sees it is a consumer holding nothing but the `/data` URL, which is a first-class client
    per §0.3 and whose reference implementation is `cyto_zarr_read.read_column`. Both legs
    below assert the DIVERGENCE first (the fault is real, not hypothetical) and then that
    the gate names it.
    """
    # LEG A — the stamped level set. The consumer resolves codes through the STAMP, so it
    # reads a different label for every row while `structure` says otherwise.
    root = tmp_path / "levels.zarr"
    structure = a_table(root, n=64)
    node = json.loads((root / "group" / "zarr.json").read_text())
    # The set the row's `levels_digest` was computed over — captured BEFORE the
    # corruption, because the row no longer restates the list and this oracle is
    # precisely about the stamp diverging from what the row declares.
    row_levels = list(node["attributes"]["cyto"]["levels"])
    node["attributes"]["cyto"]["levels"] = ["x", "y", "z", "w"]
    (root / "group" / "zarr.json").write_text(json.dumps(node, indent=2))
    decoded = cyto_zarr_read.read_column(root, "group")
    assert set(decoded) & {"x", "y", "z"} and not set(decoded) & set(row_levels), (
        f"the oracle failed: the store-URL consumer read {sorted(set(decoded))}, which does "
        "not diverge from the row's level set — then this test is not about a real fault"
    )
    violations = conformance.conform_artifact(root, structure, full=True)
    # The row declares the set by digest, so the divergence is named by the digest check
    # rather than by an inline list comparison. Same oracle, same detection, different
    # witness — assert the check that now owns it, not merely that SOMETHING fired.
    assert any("levels_digest" in v for v in violations), violations

    # LEG B — the stamped `kind`. `read_column` stops resolving labels at all and hands the
    # consumer the RAW CODES, which is silently-wrong data of a different type.
    root = tmp_path / "kind.zarr"
    structure = a_table(root, n=64)
    node = json.loads((root / "group" / "zarr.json").read_text())
    node["attributes"]["cyto"]["kind"] = "numeric"
    (root / "group" / "zarr.json").write_text(json.dumps(node, indent=2))
    decoded = cyto_zarr_read.read_column(root, "group")
    assert isinstance(decoded, np.ndarray), (
        "the oracle failed: the store-URL consumer still resolved labels, so the stamped "
        f"`kind` is not load-bearing for it (got {type(decoded).__name__})"
    )
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("stamped kind='numeric'" in v for v in violations), violations


def test_a_member_with_no_stamped_declaration_of_its_own_is_refused(tmp_path):
    """A member node with no `attributes.cyto` is one a store-URL consumer cannot decode —
    the same absence-selects-a-shallower-check shape, one level down."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    node = json.loads((root / "value" / "zarr.json").read_text())
    node["attributes"] = {}
    (root / "value" / "zarr.json").write_text(json.dumps(node, indent=2))
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("carries no `attributes.cyto`" in v for v in violations), violations


def test_a_categorical_stamp_that_drops_its_levels_is_refused(tmp_path):
    """Dropping `levels` from the stamp is not a DISAGREEMENT the field-by-field comparison
    can see — there is nothing left to disagree with — so it is required explicitly."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    node = json.loads((root / "group" / "zarr.json").read_text())
    node["attributes"]["cyto"].pop("levels")
    (root / "group" / "zarr.json").write_text(json.dumps(node, indent=2))
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("stamps no `levels`" in v for v in violations), violations


# ── the class, ONE MORE LEVEL DOWN: a key absent from the STORED STAMP ──────────
#
# `_REQUIRED_MEMBER_KEYS` retired "absence selects a shallower check" for the keys of the
# member's ROW declaration. It did not retire the class — it moved it one level down, into the
# member's own `zarr.json`, where the comparison loop still read each key with `in` and
# `continue`d when the stamp did not carry it. Two of the stamped keys (`levels`, `ordered`)
# had a bespoke `if` guarding them, which is what closing a class for the instances somebody
# thought of looks like: the LOAD-BEARING key, `kind`, was not one of them.
#
# Measured against the pre-fix module (HEAD, `full=True`), over `a_table`'s one-member-of-each-
# kind fixture: 8 of the 10 stamp-key absences below were SILENT. The two that were not are
# the two with the bespoke `if`. They stay in the matrix so the table-driven check is asserted
# to cover them rather than assumed to.


def stamp_of(root, member_path):
    """The member's OWN stamped declaration, read off disk."""
    return json.loads((Path(root) / member_path / "zarr.json").read_text())["attributes"]["cyto"]


def drop_from_stamp(root, member_path, key):
    """Pop ONE key out of a member's own `attributes.cyto` and leave everything else alone.

    Not `restamp`: this edits the member's stamp, which is the copy of the declaration a
    store-URL consumer reads. The row and the GROUP stamp stay exactly as the writer wrote
    them, so no other check in the suite can answer for this one.
    """
    path = Path(root) / member_path / "zarr.json"
    node = json.loads(path.read_text())
    assert key in node["attributes"]["cyto"], (
        f"the writer no longer stamps {key!r} on {member_path!r} — then the matrix is stale, "
        "and `_REQUIRED_STAMPED_KEYS` requires something nothing writes"
    )
    node["attributes"]["cyto"].pop(key)
    path.write_text(json.dumps(node, indent=2))


#: `(member path, stamped key)` — every key of a member's OWN stamp whose absence the gate
#: must refuse, over `a_table`. `SILENT` marks the eight that produced NO violation at all
#: before the fix (measured, not assumed); `levels`/`ordered` are the two a bespoke `if`
#: already covered.
ABSENT_STAMPED_KEYS = [
    ("value", "kind"),      # SILENT
    ("value", "name"),      # SILENT
    ("group", "kind"),      # SILENT — the oracle below
    # The STAMP still carries the level LIST — it is the copy every reader resolves
    # through, and the copy `_conform_levels_digest` hashes. Only the ROW moved to
    # `levels_digest` + `n_levels`.
    ("group", "levels"),
    ("group", "ordered"),
    ("group", "name"),      # SILENT
    ("label", "kind"),      # SILENT
    ("label", "layout"),    # SILENT
    ("label", "n"),         # SILENT
    ("label", "name"),      # SILENT
]


@pytest.mark.parametrize("member_path,key", ABSENT_STAMPED_KEYS)
def test_omitting_any_key_of_a_members_own_stamp_is_refused(tmp_path, member_path, key):
    """Absence is an error (INV-2) at the STAMP level too — 8 of these 10 were silent.

    Each case carries its own negative control: the untouched artifact conforms, so a green
    result here cannot come from a fixture that was already broken.

    The assertion is on the key by NAME, so a cell cannot be satisfied by an unrelated
    rejection of the same artifact.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=200)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "negative control: the intact artifact must conform, or this case proves nothing"
    )
    drop_from_stamp(root, member_path, key)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(f"`{key}`" in v and member_path in v for v in violations), (
        f"dropping {key!r} from {member_path!r}'s OWN zarr.json was SILENT — the stamp is the "
        "only declaration a store-URL consumer can read, so a key absent there is an opt-out "
        f"(DEC-8). 8 of these 10 cells were silent before the fix; all 10 must be refused now. "
        f"Got {violations}"
    )


def test_a_categorical_stamp_that_drops_ONLY_its_kind_is_refused(tmp_path):
    """THE ORACLE the round-2 fix left open. Nothing but `attributes.cyto.kind` is touched.

    `levels` is still stamped, `ordered` is still stamped, the row is untouched, the group
    stamp is untouched, every byte is untouched. The two bespoke `if`s that guarded
    `levels`/`ordered` therefore see nothing wrong, the field-by-field comparison `continue`s
    past a key that is not there, and the pre-fix gate reported `[]`.

    What the fault IS: `cyto_zarr_read.read_column` — §0.3's first-class store-URL client and
    the reference implementation of it — resolves codes through the level set only when the
    STAMP says `categorical`. With `kind` gone it returns the raw `uint8` codes, so the
    consumer gets `[0, 1, 2, …]` where the declaration says `['a', 'b', 'c']`: not a missing
    label, a different type carrying different values. The divergence is asserted FIRST, so
    this is a test about a real fault rather than about a rule.
    """
    root = tmp_path / "kind-only.zarr"
    structure = a_table(root, n=64)
    row = next(c for c in structure["columns"] if c["path"] == "group")

    # NEGATIVE CONTROL: before the mutation, the consumer reads labels and the gate is silent
    # for the right reason.
    assert cyto_zarr_read.read_column(root, "group")[:3] == ["a", "b", "c"]
    assert conformance.conform_artifact(root, structure, full=True) == []

    drop_from_stamp(root, "group", "kind")
    assert cz.key_sequence_digest(stamp_of(root, "group")["levels"]) == row["levels_digest"], (
        "only `kind` may be gone — with `levels` also missing this would be the case the old "
        "bespoke `if` already caught, and the test would prove nothing new. (The row declares "
        "the set by digest, so agreement is checked the way the gate checks it.)"
    )

    decoded = cyto_zarr_read.read_column(root, "group")
    assert isinstance(decoded, np.ndarray), (
        "the oracle failed: the store-URL consumer still resolved labels, so a stamped `kind` "
        f"that is ABSENT is not load-bearing for it (got {type(decoded).__name__})"
    )
    assert set(int(c) for c in decoded[:3]) == {0, 1, 2}, (
        f"the consumer must be handing back raw CODES, not labels: {decoded[:3]!r}"
    )

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        'member "group" is declared categorical but its own zarr.json stamps no `kind`' in v
        for v in violations
    ), (
        "popping ONLY `kind` out of a categorical member's stamp must be refused BY NAME — a "
        "coarse rejection would let an unrelated fault stand in for this one. Got "
        f"{violations}"
    )


def test_a_stamped_key_in_neither_table_is_reported_rather_than_riding_along(tmp_path):
    """The stamp tables are exhaustive the same way the row tables are.

    Without this, `_REQUIRED_STAMPED_KEYS` is a list somebody has to remember to extend — and
    "somebody remembers" is precisely what failed between the row-level fix and this one.
    """
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    path = root / "value" / "zarr.json"
    node = json.loads(path.read_text())
    node["attributes"]["cyto"]["wombat"] = 1
    path.write_text(json.dumps(node, indent=2))
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        "wombat" in v and "neither requires nor knows to be optional" in v for v in violations
    ), violations


def test_the_stamp_tables_classify_every_stamped_key_the_writers_emit(tmp_path):
    """The N+1 proof for the STAMP, both directions — the twin of the row-level version.

    * every key the REAL writers stamp is either required for that kind or EXPLICITLY
      optional, so a new stamped key cannot ride along as something the gate has no opinion
      about;
    * every key the gate REQUIRES of a kind's stamp is actually stamped by the writer for that
      kind, so the table cannot demand something nothing writes — which would refuse every
      conforming artifact.

    Run over all three kinds, a 2-D `arrays` member and `cyto_csc`'s trio (whose members stamp
    a `role`, and stamp a `name` their row does not carry).
    """
    table_root, matrix_root, xy_root = (
        tmp_path / "t.zarr", tmp_path / "m.zarr", tmp_path / "xy.zarr"
    )
    table = a_table(table_root, n=64)
    two_d = a_2d_table(xy_root)
    matrix = a_matrix(matrix_root)
    members = (
        [(table_root, m) for m in table["columns"] + table["arrays"]]
        + [(xy_root, m) for m in two_d["columns"] + two_d["arrays"]]
        + [(matrix_root, matrix[role]) for role in ("indptr", "indices", "data")]
    )
    assert len(members) >= 7, members
    seen_kinds = set()
    for root, member in members:
        kind = member["kind"]
        seen_kinds.add(kind)
        stamped = stamp_of(root, member["path"])
        required = conformance._REQUIRED_STAMPED_KEYS[kind]
        classified = set(required) | set(conformance._OPTIONAL_STAMPED_KEYS)
        unclassified = sorted(set(stamped) - classified)
        assert not unclassified, (
            f"the writers stamp {unclassified} on a {kind} member's own zarr.json, which the "
            "gate neither requires nor knows to be optional. Add each to "
            "`_REQUIRED_STAMPED_KEYS` with what a store-URL consumer decodes with it, or to "
            "`_OPTIONAL_STAMPED_KEYS` with the reason its absence cannot weaken the gate"
        )
        missing = sorted(k for k in required if k not in stamped)
        assert not missing, (
            f"the gate requires {missing} in a {kind} member's stamp but the writer does not "
            "stamp it — a required key nothing writes refuses every conforming artifact"
        )
    assert seen_kinds == set(conformance._MEMBER_KINDS), (
        f"every implemented kind must be exercised here, not {sorted(seen_kinds)} — an "
        "unexercised kind's required set is unchecked in both directions"
    )


def test_every_required_stamped_key_names_what_a_consumer_decodes_with_it():
    """A required key the gate cannot say a consumer NEEDS is a presence ritual.

    It is also load-bearing mechanically: the reason string IS the "is this required" signal
    passed to `_stamped_key_violations`, so an empty one would silently demote the key back to
    optional — the exact failure mode this whole section exists to retire.
    """
    assert set(conformance._REQUIRED_STAMPED_KEYS) == set(conformance._MEMBER_KINDS), (
        "every kind this suite implements must have a required-stamp set. The lookup falls "
        "back to `_STAMP_FLOOR` for a kind it cannot resolve, which is right for an "
        "unimplemented kind and SILENTLY WEAKER for an implemented one — so a fourth kind "
        "added to `_MEMBER_KINDS` without an entry here would be checked against the floor "
        "instead of against its own stamp"
    )
    for kind, keys in conformance._REQUIRED_STAMPED_KEYS.items():
        assert keys, f"{kind}: a kind whose stamp requires nothing is a kind with no stamp check"
        for key, reason in keys.items():
            assert isinstance(reason, str) and len(reason.strip()) > 20, (
                f"required stamped key {kind}.{key!r} carries no reason ({reason!r}) — and a "
                "falsey reason does not merely read badly, it makes the key OPTIONAL"
            )
    assert conformance._STAMP_FLOOR and all(
        isinstance(r, str) and r.strip() for r in conformance._STAMP_FLOOR.values()
    ), (
        "the floor applies when the kind cannot be resolved; empty, it would make an "
        "unresolvable kind require nothing of its stamp"
    )


def test_every_explicitly_optional_stamped_key_carries_its_reason():
    """Explicit optionality is INV-2-legal; SILENT optionality is what was not — and at the
    stamp level EVERY key was silently optional until now."""
    for key, reason in conformance._OPTIONAL_STAMPED_KEYS.items():
        assert isinstance(reason, str) and len(reason.strip()) > 20, (
            f"optional stamped key {key!r} carries no reason ({reason!r}) — a key is optional "
            "because of something, and that something is what a reviewer checks"
        )


def test_a_csc_member_stamping_a_name_its_row_does_not_carry_is_legal(tmp_path):
    """NEGATIVE CONTROL for the asymmetry rule: one copy may legitimately carry more.

    A stamped key whose ROW counterpart is absent is not a violation when the row is
    explicitly allowed to omit it — `cyto_csc`'s trio stamps `name` (and `role`) while its row
    declaration carries neither, by design (`_OPTIONAL_MEMBER_KEYS` says why). Without this
    test, "the two copies must agree" could have been implemented as "the two copies must have
    the same keys", which would refuse every CSC artifact ever written.
    """
    root = tmp_path / "m.zarr"
    matrix = a_matrix(root)
    for role in ("indptr", "indices", "data"):
        member = matrix[role]
        stamped = stamp_of(root, member["path"])
        assert stamped["name"] and "name" not in member, (
            f"{role}: the fixture must actually be asymmetric for this control to mean "
            f"anything (stamp {sorted(stamped)}, row {sorted(member)})"
        )
        assert stamped["role"] == role and "role" not in member
    assert conformance.conform_artifact(root, matrix, full=True) == []


# ── the string member: the offsets are the whole safety property ────────────────
#
# `_conform_string_member` was entirely uncovered — neutering its body left the suite
# green — while being the check that stands between a consumer and a read past the end of
# a buffer. Each case below corrupts ONE thing about a REAL string member.


def a_string_table(root, values):
    with cz.Table(root, axis="rows", n=len(values)) as t:
        t.string("label", values)
        return t.close()


def rewrite_member(root, path, arr, *, dimension_names):
    """Rewrite one member's bytes through the REAL writer, so the container stays valid
    and the corruption is the VALUE, not the encoding."""
    return cz.write_array(root, path, arr, dimension_names=dimension_names)

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_with_non_monotonic_offsets_is_rejected(tmp_path, depth):
    """Offsets that go backwards make `payload[offsets[i]:offsets[i+1]]` an empty slice
    at best and a nonsense one at worst — the consumer sees blank labels, not an error."""
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    offsets = np.asarray(cyto_zarr_read.read_array(root, "label/offsets"), dtype=np.uint32)
    offsets[5], offsets[6] = offsets[6], offsets[5]
    rewrite_member(root, "label/offsets", offsets, dimension_names=["rows+1"])
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("non-monotonic offsets" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_whose_offsets_do_not_span_the_payload_is_rejected(tmp_path, depth):
    """The last offset IS the payload length. A short one silently truncates the final
    string; a long one indexes past the end of the buffer."""
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    offsets = np.asarray(cyto_zarr_read.read_array(root, "label/offsets"), dtype=np.uint32)
    offsets[-1] -= 3
    rewrite_member(root, "label/offsets", offsets, dimension_names=["rows+1"])
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("but its payload holds" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_that_does_not_start_at_zero_is_rejected(tmp_path, depth):
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    offsets = np.asarray(cyto_zarr_read.read_array(root, "label/offsets"), dtype=np.uint32)
    offsets[0] = 1
    rewrite_member(root, "label/offsets", offsets, dimension_names=["rows+1"])
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("starts at offset 1, not 0" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_with_the_wrong_offset_count_is_rejected(tmp_path, depth):
    """`n` values need `n + 1` offsets. One fewer and the last value has no end."""
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    offsets = np.asarray(cyto_zarr_read.read_array(root, "label/offsets"), dtype=np.uint32)
    rewrite_member(root, "label/offsets", offsets[:-1], dimension_names=["rows+1"])
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("offsets for 20 values (expected 21)" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_whose_payload_is_not_utf8_is_rejected(tmp_path, depth):
    """`.decode("utf-8")` in a consumer is where this surfaces otherwise — deep inside
    somebody else's loop, naming no member."""
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    payload = np.asarray(cyto_zarr_read.read_array(root, "label/values"), dtype=np.uint8)
    payload[0] = 0xFF  # never a valid UTF-8 lead byte
    rewrite_member(root, "label/values", payload, dimension_names=["utf8_bytes"])
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("is not valid UTF-8" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_string_member_missing_its_pair_is_rejected(tmp_path, depth):
    root = tmp_path / "s.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(20)])
    for path in sorted((root / "label" / "offsets").rglob("*"), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
    (root / "label" / "offsets").rmdir()
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("missing its offsets/values pair" in v for v in violations), violations


def test_a_conforming_string_member_produces_no_violation(tmp_path):
    """POSITIVE CONTROL for the six above: without it, a `_conform_string_member` that
    returned a violation unconditionally would pass every one of them."""
    root = tmp_path / "s.zarr"
    values = ["", "a", "unicode: ✓ →", "row-3" * 40]
    structure = a_string_table(root, values)
    assert conformance.conform_artifact(root, structure, full=True) == []
    assert cyto_zarr_read.read_strings(root, "label") == values


# ── the string RE-SPLIT: what the bytes genuinely cannot pin ─────────────────────
#
# Every check above is about the offsets being WELL-FORMED. None of them is about the
# offsets being the RIGHT ones, and those are different questions: the same payload under a
# different well-formed split is a different column, and the gate returned `[]` for it.
# `key_sequence_digest` caught it, but an artifact has at most ONE `key` member, so every
# other string column was unchecked — which is what the three tests below close.


def resplit(root, member, new_offsets):
    """Replace a string member's offsets with `new_offsets`, through the real writer."""
    rewrite_member(root, f"{member}/offsets", np.asarray(new_offsets, dtype=np.uint32),
                   dimension_names=["rows+1"])


def test_the_writer_declares_a_values_digest_for_EVERY_string_member(tmp_path):
    """The producer half. Not only for a `key=` member — for every string member.

    The digest apparatus already existed and was reachable exactly once per artifact
    (`Table(key=…)`), so the artifact's other string columns had nothing declared about
    their value sequences at all. This asserts the declaration is emitted unconditionally
    and is the digest of the values the member actually stores.
    """
    values = ["ab", "c", "", "é"]
    root = tmp_path / "declared.zarr"
    structure = a_string_table(root, values)
    member = structure["columns"][0]
    assert member["values_digest"] == conformance.key_sequence_digest(values), (
        "the writer declares WHAT the offsets split the payload into, over the values "
        "going IN — the far side of the encoder from where the gate recomputes it"
    )
    assert conformance.conform_artifact(root, structure, full=True) == []


def test_a_boundary_preserving_string_resplit_is_rejected(tmp_path):
    """THE DEFECT. `["ab","c"]` re-split as `["a","bc"]` — every value changed, every
    structural check still satisfied.

    Offsets `[0,2,3]` → `[0,1,3]` over the payload `abc`: starts at 0, strictly ascending,
    ends at the payload length, and the payload decodes as UTF-8 as a whole. All four
    checks the gate had, passed. `read_strings` returns different values for every row and
    the run's log said "OK — verified".

    Nothing about the BYTES can distinguish the two splits, which is why the fix is a
    declaration (`values_digest`) rather than another byte-level check.
    """
    root = tmp_path / "resplit.zarr"
    structure = a_string_table(root, ["ab", "c"])
    assert conformance.conform_artifact(root, structure, full=True) == []

    resplit(root, "label", [0, 1, 3])

    # Every structural property still holds — the corruption is invisible to all of them.
    offsets = cyto_zarr_read.read_array(root, "label/offsets")
    payload = cyto_zarr_read.read_array(root, "label/values").tobytes()
    assert int(offsets[0]) == 0 and int(offsets[-1]) == len(payload)
    assert list(np.diff(offsets.astype(np.int64))) == [1, 2]
    payload.decode("utf-8")  # the whole payload is perfectly valid UTF-8

    assert cyto_zarr_read.read_strings(root, "label") == ["a", "bc"], (
        "the fixture must actually change what every consumer reads"
    )
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("values_digest" in v for v in violations), (
        "a boundary-preserving re-split changes every value in the column while satisfying "
        f"start-0 / monotonic / ends-at-payload / decodes-as-UTF-8. Got {violations}"
    )


def test_an_offset_that_splits_a_utf8_codepoint_is_rejected(tmp_path):
    """The mechanically-detectable half: a value boundary landing on a continuation byte.

    `["é","x"]` at offsets `[0,1,3]`. The payload decodes as a whole, so the whole-payload
    check says nothing — and EVERY consumer raises `UnicodeDecodeError`, because `é` is two
    bytes and the split lands between them. This needs no declaration: a byte matching
    `0b10xxxxxx` is never the start of a codepoint.
    """
    root = tmp_path / "cont.zarr"
    structure = a_string_table(root, ["é", "x"])
    assert conformance.conform_artifact(root, structure, full=True) == []

    resplit(root, "label", [0, 1, 3])
    cyto_zarr_read.read_array(root, "label/values").tobytes().decode("utf-8")  # still valid
    with pytest.raises(UnicodeDecodeError):
        cyto_zarr_read.read_strings(root, "label")

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("split a UTF-8 codepoint" in v for v in violations), (
        f"an offset landing mid-codepoint makes every consumer throw. Got {violations}"
    )


def test_a_string_member_that_declares_no_values_digest_is_rejected(tmp_path):
    """The ABSENCE of the declaration is the opt-out, so it is a violation.

    This is the `encoding: "opaque"` lesson applied to a key nobody writes rather than a
    key with a value: if omitting `values_digest` merely skipped the re-split check, a
    producer would disable it by writing nothing, which is the cheapest opt-out there is.
    """
    root = tmp_path / "undeclared.zarr"
    structure = a_string_table(root, [f"row-{i}" for i in range(8)])
    assert conformance.conform_artifact(root, structure, full=True) == []

    del structure["columns"][0]["values_digest"]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("declares no `values_digest`" in v for v in violations), (
        "a string member whose value sequence is never declared cannot be checked for a "
        f"re-split, so the omission itself must be refused. Got {violations}"
    )


def test_a_non_key_string_column_is_covered_the_same_as_a_key_one(tmp_path):
    """The gap this closes, stated as the difference it makes.

    `key_sequence_digest` already caught the re-split — for the ONE member an artifact may
    name as its `key`. So the hole was not "the digest idea is missing", it was "the digest
    covers one column in N". Here the SAME corruption is applied to a table's key column and
    to a plain column, and both are refused.
    """
    keys = [f"k-{i}" for i in range(4)]
    labels = ["ab", "c", "d", "e"]
    root = tmp_path / "both.zarr"
    with cz.Table(root, axis="rows", n=4, key="key") as t:
        t.string("key", keys)
        t.string("label", labels)
        structure = t.close()
    assert conformance.conform_artifact(root, structure, full=True) == []

    # The plain column, re-split. `structure.key` names the OTHER member, so ITEM-19's
    # digest has nothing to say about this one.
    resplit(root, "label", [0, 1, 3, 4, 5])
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any('"label"' in v and "values_digest" in v for v in violations), (
        f"a non-key string column must be covered too. Got {violations}"
    )
    assert not any("key_sequence_digest" in v for v in violations), (
        "…and the key member, which was not touched, must not be implicated"
    )

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_an_unknown_encoding_or_kind_is_rejected_by_name(tmp_path, depth):
    assert conformance.conform_artifact(tmp_path, {"encoding": "parquet"}, full=depth) == [
        'unknown encoding \'parquet\' — this suite implements "zarr_v3" and "opaque"'
    ]
    got = conformance.conform_artifact(tmp_path, {"encoding": "zarr_v3", "kind": "raw_csc_trio"}, full=depth)
    assert len(got) == 1 and "raw_csc_trio" in got[0] and "sparse_csc" in got[0]


# ── TEST-25 (sparse): the cross-member arithmetic ────────────────────────────────

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_matrix_that_lies_about_its_nnz_is_rejected(tmp_path, depth):
    root = tmp_path / "m.zarr"
    structure = a_matrix(root)
    structure["nnz"] = structure["nnz"] + 1
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("nnz is declared" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_matrix_whose_pointer_array_is_the_wrong_length_is_rejected(tmp_path, depth):
    root = tmp_path / "m.zarr"
    structure = a_matrix(root, n_cols=6)
    structure["shape"] = [structure["shape"][0], 99]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("for 99 declared columns" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_matrix_whose_row_ids_exceed_its_declared_rows_is_rejected(tmp_path, depth):
    root = tmp_path / "m.zarr"
    structure = a_matrix(root, n_rows=40)
    structure["shape"] = [4, structure["shape"][1]]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("in a matrix declared 4 rows deep" in v for v in violations), violations


def test_a_matrix_with_unsorted_row_ids_is_rejected_at_full_depth(tmp_path):
    """Row ids ascend within a column. A consumer that binary-searches a column is
    silently wrong on unsorted input, so this is checked — but only at FULL depth, because
    it is the one check that is O(nnz)."""
    root = tmp_path / "m.zarr"
    structure = a_matrix(root, n_rows=40, n_cols=4)
    indices_path = structure["indices"]["path"]
    # Rewrite `indices` with its first column's rows reversed, through the real writer so
    # the container stays valid and it is the ORDER that is wrong, nothing else.
    ind = np.asarray(cyto_zarr_read.read_array(root, indices_path), dtype=np.uint32)
    ptr = np.asarray(cyto_zarr_read.read_array(root, structure["indptr"]["path"]))
    lo, hi = int(ptr[0]), int(ptr[1])
    assert hi - lo > 1, "the fixture's first column must hold more than one entry"
    ind[lo:hi] = ind[lo:hi][::-1]
    entry = cz.write_array(
        root, indices_path, ind, inner_chunk=structure["indices"]["inner_chunk"],
        chunks_per_shard=structure["indices"]["chunks_per_shard"], dimension_names=["nnz"],
        attributes={"cyto": {"kind": "numeric", "name": "indices", "role": "indices"}},
    )
    structure["indices"] = entry
    restamp(root, structure)
    assert conformance.conform_artifact(root, structure, full=False) == [], "bounded depth is bounded"
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("not strictly ascending" in v for v in violations), violations


# ── `opaque` is VERIFIED, not trusted — the producer-authored opt-out ───────────
#
# `encoding: "opaque"` selects the branch that checks no member structure. That is right
# for an HTML report and wrong for everything else, and NOTHING used to check which one
# it was: a producer wrote five words into its own `structure` and every byte-level check
# in the module was skipped for that artifact. `test_no_declared_opt_out_weakens_the_gate`
# below tries every opt-out shape that LOOKS like a switch; this section is the one that
# does not look like a switch and was the real hole (DEC-8: "the processor author can
# neither write nor weaken it").

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_declaring_a_real_zarr_store_opaque_does_not_disable_the_gate(tmp_path, depth):
    """THE BYPASS, end to end: a genuinely broken Zarr artifact relabelled `opaque`.

    The fixture is the same known-broken store the opt-out test uses. Declared honestly
    it is condemned; declared `opaque` — with a perfectly well-formed media type, which is
    all the old check asked for — it used to pass clean, which is a processor author
    switching the gate off for its own output. Both the honest and the relabelled
    declaration must now be violations, and the relabelled one must be condemned FOR the
    relabelling, so this cannot be satisfied by a gate that fails everything.
    """
    root = tmp_path / "broken.zarr"
    honest = a_table(root, n=64)
    (root / "value" / "c" / "0").unlink()
    assert conformance.conform_artifact(root, honest, full=depth), "the fixture must be broken"

    relabelled = {"encoding": "opaque", "media_type": "application/octet-stream"}
    violations = conformance.conform_artifact(root, relabelled, full=depth)
    assert violations, (
        "declaring `opaque` over a Zarr store disabled every byte-level check — that is "
        "an opt-out the processor author writes, which DEC-8 says cannot exist"
    )
    assert any("the bytes are a Zarr store" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_declaring_a_CONFORMING_zarr_store_opaque_is_also_refused(tmp_path, depth):
    """The negative control on the check above: it fires on the DECLARATION, not on the
    artifact being broken.

    A perfectly good store mislabelled `opaque` is still a false declaration — and it is
    the shape a bypass would actually take, since a producer hiding a broken artifact and
    one hiding a fine one write the identical manifest.
    """
    root = tmp_path / "fine.zarr"
    honest = a_table(root, n=64)
    assert conformance.conform_artifact(root, honest, full=True) == []
    violations = conformance.conform_artifact(
        root, {"encoding": "opaque", "media_type": "application/octet-stream"}, full=depth
    )
    assert any("the bytes are a Zarr store" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_genuinely_opaque_artifact_still_passes(tmp_path, depth):
    """POSITIVE CONTROL — `opaque` stays declarable.

    The point of the checks above is to make the claim falsifiable, not to make it
    unusable: an HTML report, a JSON blob and an arbitrary binary blob are all legitimate
    opaque artifacts and none of them may be condemned. Without this, "the gate rejects
    opaque bypasses" would be satisfied by a gate that rejects `opaque` outright.
    """
    (tmp_path / "report.html").write_text("<html><body>ok</body></html>")
    assert conformance.conform_artifact(
        tmp_path / "report.html", {"encoding": "opaque", "media_type": "text/html"}, full=depth
    ) == []
    (tmp_path / "summary.json").write_text(json.dumps({"cells": 5}))
    assert conformance.conform_artifact(
        tmp_path / "summary.json",
        {"encoding": "opaque", "media_type": "application/json"}, full=depth,
    ) == []
    (tmp_path / "blob.bin").write_bytes(bytes(range(256)))
    assert conformance.conform_artifact(
        tmp_path / "blob.bin",
        {"encoding": "opaque", "media_type": "application/octet-stream"}, full=depth,
    ) == []
    # A multi-file opaque artifact (a report with assets) is fine too — what is refused
    # is a DIRECTORY THAT IS A STORE, not a directory.
    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text("<html>x</html>")
    (site / "assets" / "style.css").write_text("body{}")
    assert conformance.conform_artifact(
        site, {"encoding": "opaque", "media_type": "text/html"}, full=depth
    ) == []

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_an_opaque_declaration_that_also_declares_structure_is_refused(tmp_path, depth):
    """Having it both ways: an `opaque` structure that still carries `columns`/`n`/`kind`
    is a `zarr_v3` declaration with one field edited, which is exactly how a relabelling
    is authored in practice."""
    root = tmp_path / "t.zarr"
    structure = a_table(root, n=64)
    hybrid = dict(structure)
    hybrid["encoding"] = "opaque"
    hybrid["media_type"] = "application/octet-stream"
    violations = conformance.conform_artifact(root, hybrid, full=depth)
    assert any("says the bytes both have and have no member structure" in v
               for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
@pytest.mark.parametrize("media_type", ["x", "", "application", "  ", "text/"])
def test_an_opaque_media_type_that_is_not_a_media_type_is_refused(tmp_path, media_type, depth):
    """A presence check accepts any truthy string, so `media_type: "x"` satisfied INV-2
    on paper while declaring nothing a consumer can act on."""
    (tmp_path / "blob.bin").write_bytes(b"bytes")
    violations = conformance.conform_artifact(
        tmp_path / "blob.bin", {"encoding": "opaque", "media_type": media_type}, full=depth
    )
    assert violations, f"{media_type!r} was accepted as a media type"

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_opaque_bytes_that_contradict_their_declared_media_type_are_refused(tmp_path, depth):
    """Where a media type IS decidable, it is decided. Guessing at `application/pdf` would
    be a gate inventing facts; JSON that does not parse is not a guess."""
    (tmp_path / "not.json").write_bytes(b"{ this is not json")
    violations = conformance.conform_artifact(
        tmp_path / "not.json", {"encoding": "opaque", "media_type": "application/json"}, full=depth
    )
    assert any("the bytes are not JSON" in v for v in violations), violations

    (tmp_path / "not.txt").write_bytes(b"\xff\xfe\x00binary")
    violations = conformance.conform_artifact(
        tmp_path / "not.txt", {"encoding": "opaque", "media_type": "text/plain"}, full=depth
    )
    assert any("not valid UTF-8 text" in v for v in violations), violations

    # …and a producer that NAMES a non-UTF-8 charset is taken at its word: this module
    # ships no transcoder, and failing an honestly-declared latin-1 CSV would be the gate
    # asserting something it cannot check.
    (tmp_path / "latin.csv").write_bytes(b"caf\xe9,1\n")
    assert conformance.conform_artifact(
        tmp_path / "latin.csv",
        {"encoding": "opaque", "media_type": "text/csv; charset=iso-8859-1"}, full=depth,
    ) == []

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_missing_opaque_bytes_are_still_refused(tmp_path, depth):
    violations = conformance.conform_artifact(
        tmp_path / "absent.bin",
        {"encoding": "opaque", "media_type": "application/octet-stream"}, full=depth,
    )
    assert any("declared bytes are missing" in v for v in violations), violations

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_a_structure_that_names_no_encoding_is_not_a_declaration(tmp_path, depth):
    """The `{}` case, resolved in ONE direction at BOTH layers.

    `{}` used to be accepted by `workstore::ingest` (a manifest entry could declare it)
    and condemned here as `unknown encoding None`, and no test ingested one and then ran
    the gate, so the contradiction sat unnoticed. It is resolved as NOT a declaration:
    nothing in `{}` says what the bytes are, so there is nothing to check them against,
    and calling it "nothing to declare" would put a second opt-out beside the `opaque`
    one above. `workstore::ingest` now refuses it at the manifest — see the Rust-side
    `test3_a_manifest_declaring_an_encodingless_structure_is_refused`, which pins the two
    layers to the same answer.
    """
    (tmp_path / "blob.bin").write_bytes(b"bytes")
    for structure in ({}, {"media_type": "text/html"}, {"encoding": None}):
        violations = conformance.conform_artifact(tmp_path / "blob.bin", structure, full=depth)
        assert any("declares no `encoding`" in v for v in violations), (structure, violations)


# ── the OMISSION opt-out: a DEFAULT that selects the weaker depth ───────────────
#
# `conform_artifact` used to declare `full=False`, so a caller that did not mention the depth
# got the arm that reads a SAMPLE of the bytes. That is the same class the two sections above
# retire — absence selecting the shallower check — expressed as a parameter default instead of
# as a `.get()` or a `continue`:
#
#   row-declaration key absent  ->  `.get()`   ->  the check was SKIPPED
#   stored-stamp key absent     ->  `continue` ->  the comparison was SKIPPED
#   `full=` absent              ->  default    ->  the SAMPLE depth was selected
#
# The protection before this was that every existing caller happened to pass `full=True` — a
# property of the CALLERS, which holds only until somebody adds one. The two tests below make
# it a property of the FUNCTION, and of every signature in the module.


def test_omitting_the_depth_is_a_TypeError_not_a_quiet_downgrade():
    """`conform_artifact` cannot be called without saying which depth it is.

    The strongest form of "absence is not a shallower check": absence is not expressible. This
    is the same judgement `test_no_declared_opt_out_weakens_the_gate` leg 4 makes about a
    writer kwarg — the fault is raised where the author writes it, not where the artifact is
    used.
    """
    with pytest.raises(TypeError):
        conformance.conform_artifact(Path("/nonexistent"), {"encoding": "zarr_v3"})
    # …and both explicit spellings still work, so this is a required argument rather than a
    # removed feature.
    for depth in (False, True):
        assert conformance.conform_artifact(
            Path("/nonexistent"), {"encoding": "opaque", "media_type": "text/html"}, full=depth
        ), "an absent artifact is still a violation at either depth"


def test_no_omission_can_select_a_weaker_depth():
    """THE RULE, over every signature in the module — the N+1 guard on this very fix.

    A `full` parameter is either REQUIRED (omission is a `TypeError`) or defaults to `True`
    (omission selects the whole gate). What it may never do is default to `False`, because that
    is an opt-out spelled as a convenience: the caller writes nothing and gets less checking.

    Asserted over `inspect.signature` rather than over a hand-listed set of functions, so a new
    `full`-taking function — public or private — is covered the moment it exists. Two
    directions, because either alone rots: the rule holds for every `full` found, and `full` is
    actually found (a scan that matched nothing would pass vacuously).
    """
    import inspect

    checked = {}
    for name, obj in vars(conformance).items():
        if not inspect.isfunction(obj) or obj.__module__ != conformance.__name__:
            continue
        param = inspect.signature(obj).parameters.get("full")
        if param is None:
            continue
        checked[name] = param
        assert param.kind is inspect.Parameter.KEYWORD_ONLY, (
            f"{name}: `full` must be keyword-only — a positional depth can be rebound by "
            "inserting a parameter before it, silently and without touching any call site"
        )
        assert param.default is inspect.Parameter.empty or param.default is True, (
            f"{name}: `full` defaults to {param.default!r}. A depth default may only point "
            "STRICT: either require it (omission is a TypeError) or default to True (omission "
            "selects the whole gate). Defaulting to False means a caller who writes nothing is "
            "checked less, which is the absence-selects-a-shallower-check class this module "
            "retires everywhere else"
        )
    assert len(checked) >= 9, (
        f"only {len(checked)} `full`-taking function(s) found ({sorted(checked)}) — the scan "
        "must be finding the module's depth-taking functions, or it passes vacuously"
    )
    assert checked["conform_artifact"].default is inspect.Parameter.empty, (
        "`conform_artifact` is the entry a new caller reaches for first, and it is the one that "
        "used to default to the weak arm; it must be REQUIRED, not merely non-False"
    )
    for entry in ("conform_manifest", "conform_outputs", "gate_outputs"):
        assert checked[entry].default is True, (
            f"{entry} is invoked without a depth on real paths (the CLI, a test harness), so "
            "its default is load-bearing and must be the strict one"
        )


# ── TEST-25: the STRUCTURAL claim — no opt-out exists ───────────────────────────


OPT_OUT_SHAPES = [
    {"conformance": {"enabled": False}},
    {"conformance": "skip"},
    {"skip_conformance": True},
    {"contributes": {"conformance": {"enabled": False}}},
    {"tests": {"conformance": "off"}},
    {"gate": None},
]


def test_no_declared_opt_out_weakens_the_gate(tmp_path):
    """DEC-8's structural claim, exercised rather than asserted.

    A processor gets to write two things: its `manifest.yaml` and its own code. So the
    opt-out, if one existed, would have to live in one of them — a manifest key, a keyword
    argument to a writer, an environment variable it exports, or a field it adds to its own
    `manifest.json` output entry. Each is tried below against a KNOWN-BROKEN artifact; the
    gate has to reject it every time, identically.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    root = outputs / "broken.zarr"
    structure = a_table(root, n=64)
    (root / "value" / "c" / "0").unlink()  # now genuinely non-conforming

    def violations_now(entry_extra=None):
        entry = {"id": "out", "datatype": "x", "path": "broken.zarr", "structure": structure}
        entry.update(entry_extra or {})
        (outputs / "manifest.json").write_text(json.dumps({"outputs": [entry]}))
        return conformance.conform_outputs(outputs)

    baseline = violations_now()
    assert baseline, "the fixture must actually be broken or this test proves nothing"

    # 1. A manifest.yaml key. `conform_outputs` never opens the package manifest at all —
    #    it takes an outputs DIRECTORY — so there is nowhere for the key to be read from.
    package = tmp_path / "a-processor"
    package.mkdir()
    for shape in OPT_OUT_SHAPES:
        body = "\n".join(f"{k}: {json.dumps(v)}" for k, v in shape.items())
        (package / "manifest.yaml").write_text(f"id: a-processor\n{body}\n")
        assert violations_now() == baseline, f"manifest.yaml {shape!r} changed the gate"

    # 2. A field on the processor's OWN manifest.json output entry — the one document the
    #    gate does read. Unknown keys ride through untouched; none of them is consulted.
    for shape in OPT_OUT_SHAPES:
        assert violations_now(shape) == baseline, f"manifest.json {shape!r} changed the gate"

    # 3. An environment variable. Nothing in the module reads `os.environ`.
    saved = {k: os.environ.get(k) for k in
             ("CYTO_SKIP_CONFORMANCE", "CONFORMANCE", "CYTO_CONFORMANCE", "SKIP_CONFORMANCE")}
    try:
        for k in saved:
            os.environ[k] = "0"
        assert violations_now() == baseline, "an environment variable changed the gate"
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    # 4. A keyword argument to the writer. There is no parameter to bind, so this is a
    #    TypeError at the call — the strongest of the four, because it fails at the point
    #    the author writes it rather than at the point the artifact is used.
    for kwarg in ("conformance", "gate", "skip_conformance", "validate"):
        with pytest.raises(TypeError):
            cz.Table(tmp_path / "x.zarr", axis="rows", n=1, **{kwarg: False})
    for kwarg in ("conformance", "gate", "skip_conformance"):
        with pytest.raises(TypeError):
            cyto_csc.write_csc_zarr(
                cyto_csc.ArraySource(np.eye(2, dtype=np.float32)),
                tmp_path / "y.zarr", **{kwarg: False}
            )

    # 5. And `gate` itself takes no depth/severity dial — there are exactly two positional
    #    arguments and nothing else to bind.
    with pytest.raises(TypeError):
        conformance.gate(root, structure, full=False)

    # 6. The two parameters the gate DOES take beyond the declaration — `meta=` (the row's
    #    other producer declaration) and `evidence=` (the work tally) — are checked for the
    #    same property, because a parameter that can lower the bar is an opt-out whatever it
    #    was added for. `meta` is only ever READ to find an additional contradiction
    #    (`is_axis_index` without a key), so no value of it may remove a violation.
    baseline_artifact = conformance.conform_artifact(root, structure, full=True)
    assert baseline_artifact, "the fixture must be broken for this leg to mean anything"
    for meta in (None, {}, {"is_axis_index": False}, {"is_axis_index": True},
                 {"skip_conformance": True}, {"conformance": {"enabled": False}},
                 "not-even-an-object", 0):
        got = conformance.conform_artifact(root, structure, full=True, meta=meta)
        assert set(baseline_artifact) <= set(got), (
            f"meta={meta!r} REMOVED a violation — `meta` may only ever add one "
            f"(baseline {baseline_artifact}, got {got})"
        )
    assert conformance.conform_artifact(
        root, structure, full=True, evidence=conformance.Evidence()
    ) == baseline_artifact, "passing an evidence sink must not change the verdict"


def test_a_receipt_is_never_earned_without_bytes():
    """`Evidence`'s API SHAPE carries the invariant, over every verb, including the next one.

    `checks > 0` is claimed — in this module, in `verify_conformance.py` and twice in
    `jobs::conformance.rs` — to mean "at least one read of this artifact's bytes
    completed". It has now been false twice, both times because ONE verb could be satisfied
    by something that is not a read: first `note` ("a declaration-level comparison
    happened"), then `enumerated`, which took the number of entries a directory LISTING had
    seen and let a directory-shaped `opaque` artifact reach `checks: 1, read_bytes: 0`,
    `violations: {}`, exit 0 — a green verdict over an artifact nothing opened.

    So this does not test the three verbs that exist. It drives EVERY public verb on the
    class generically, which is the only shape that can fail on a verb added later: the
    previous two fixes each pinned the shape in front of them and the class re-entered one
    level down. A verb that counts entries, nodes, members, comparisons or anything else
    that is not bytes fails leg 2 the day it is written.

    Both legs matter. Leg 1 is "nothing in ⇒ nothing recorded" (an empty read establishes
    nothing). Leg 2 is the load-bearing one: whatever DID move `checks` must have moved
    `read_bytes` or `decoded_bytes` with it, since those are the two counters that can only
    come from bytes arriving. `shards`/`chunks` are act counts and deliberately do NOT
    satisfy leg 2 — counting acts is exactly how both regressions were spelled.
    """
    verbs = [
        name
        for name in dir(conformance.Evidence)
        if not name.startswith("_") and name != "as_dict"
        and callable(getattr(conformance.Evidence, name))
    ]
    # The negative control: a driver that silently matched nothing would pass vacuously.
    assert len(verbs) >= 3, f"the driver found no verbs to exercise: {verbs}"

    for name in verbs:
        # Leg 1 — the "no bytes" argument, in both spellings a verb can take.
        for nothing in (b"", 0):
            e = conformance.Evidence()
            try:
                getattr(e, name)(nothing)
            except TypeError:
                continue
            assert e.as_dict() == {
                "checks": 0, "shards": 0, "chunks": 0, "decoded_bytes": 0, "read_bytes": 0
            }, f"`Evidence.{name}({nothing!r})` recorded work for a read that returned nothing: {e}"

        # Leg 2 — 16 bytes of SOMETHING, however this verb spells it.
        e = conformance.Evidence()
        for something in (b"\x00" * 16, 16):
            try:
                getattr(e, name)(something)
            except TypeError:
                continue
            break
        else:  # pragma: no cover - a verb taking neither bytes nor a count
            raise AssertionError(
                f"`Evidence.{name}` takes neither bytes nor a byte count, so what it "
                "counts is not bytes — see this test's docstring"
            )
        got = e.as_dict()
        assert got["checks"] > 0, f"`Evidence.{name}` recorded a read without raising `checks`: {got}"
        assert got["read_bytes"] + got["decoded_bytes"] > 0, (
            f"`Evidence.{name}` raised `checks` to {got['checks']} with no bytes behind it "
            f"({got}) — `checks > 0` is asserted in four places to mean 'this artifact's "
            "bytes were read', and a verb that counts anything else makes it false"
        )


def test_conform_outputs_gates_a_whole_run(tmp_path):
    """The verification-processor entry point: a directory and a manifest, nothing else."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    good = a_table(outputs / "good.zarr", n=64)
    bad = a_table(outputs / "bad.zarr", n=64)
    (outputs / "bad.zarr" / "value" / "c" / "0").unlink()
    (outputs / "manifest.json").write_text(json.dumps({"outputs": [
        {"id": "good", "path": "good.zarr", "structure": good},
        {"id": "bad", "path": "bad.zarr", "structure": bad},
    ]}))
    violations = conformance.conform_outputs(outputs)
    assert violations and all(v.startswith("bad:") for v in violations), violations
    with pytest.raises(conformance.ConformanceError):
        conformance.gate_outputs(outputs)
    assert conformance.main([str(outputs)]) == 1

    (outputs / "manifest.json").write_text(json.dumps({"outputs": [
        {"id": "good", "path": "good.zarr", "structure": good},
    ]}))
    assert conformance.main([str(outputs)]) == 0


def test_conform_manifest_attributes_every_violation_and_stays_in_step_with_the_report(tmp_path):
    """DEC-12's production caller needs to know WHICH artifact to mark failed.

    `conform_outputs` returns a flat list of strings; "something in this run is broken"
    cannot flip one `artifacts.status`. `conform_manifest` is the same pass with the
    attribution kept, and the two are asserted to agree here — a caller can never end up
    checking something different from, or less than, the CLI.

    The cross-artifact axis case is the one that needs saying out loud: two artifacts that
    disagree about an axis implicate EACH OTHER, so both labels are named. Picking one
    would be the gate inventing a culprit.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    good = a_table(outputs / "good.zarr", n=64)
    bad = a_table(outputs / "bad.zarr", n=64)
    (outputs / "bad.zarr" / "value" / "c" / "0").unlink()
    manifest = {"outputs": [
        {"id": "good", "path": "good.zarr", "structure": good},
        {"id": "bad", "path": "bad.zarr", "structure": bad},
        {"id": "undeclared", "path": "nope.zarr"},
    ]}
    (outputs / "manifest.json").write_text(json.dumps(manifest))

    attributed = conformance.conform_manifest(outputs, manifest)
    flat = conformance.conform_outputs(outputs)
    assert [v for _labels, v in attributed] == flat, (
        "the attributed pass and the flat report must be the SAME pass — otherwise the "
        "production gate and `python3 -m conformance` check different things"
    )

    by_label = {}
    for labels, violation in attributed:
        for label in labels:
            by_label.setdefault(label, []).append(violation)
    assert "bad" in by_label and by_label["bad"], "the broken artifact is named"
    assert "undeclared" in by_label, "a declaration-shape fault is attributed to its entry"
    assert "good" not in by_label, (
        "the conforming artifact carries no violation — otherwise attribution is useless: "
        "the caller would fail everything in the batch"
    )

    # The alignment case: two artifacts on one axis with different key sequences. Both
    # are implicated by the SAME violation.
    aligned_dir = tmp_path / "aligned"
    aligned_dir.mkdir()
    keys = [f"k-{i:04d}" for i in range(30)]
    entries = []
    for name, values in (("first", keys), ("second", keys[::-1])):
        with cz.Table(aligned_dir / f"{name}.zarr", axis="rows", n=len(values), key="key") as t:
            t.string("key", values)
            entries.append({"id": name, "path": f"{name}.zarr", "structure": t.close()})
    pairs = conformance.conform_manifest(aligned_dir, {"outputs": entries})
    axis_pairs = [(labels, v) for labels, v in pairs if "different key sequences" in v]
    assert len(axis_pairs) == 1, pairs
    assert sorted(axis_pairs[0][0]) == ["first", "second"], (
        "a misalignment implicates every artifact in the group, not an arbitrary one"
    )


def test_an_output_that_declares_no_structure_is_rejected(tmp_path):
    """ITEM-5/INV-2 at the manifest level: `structure` is NOT NULL with no default, so an
    entry without one is a partial row, not an artifact whose layout is obvious."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    a_table(outputs / "t.zarr", n=32)
    (outputs / "manifest.json").write_text(
        json.dumps({"outputs": [{"id": "t", "path": "t.zarr"}]})
    )
    violations = conformance.conform_outputs(outputs)
    assert any("declares no `structure`" in v for v in violations), violations


# ── TEST-4b — ITEM-19: key_sequence_digest ──────────────────────────────────────


def test_the_digest_is_order_sensitive(tmp_path):
    """The whole property. Two arrays with identical CONTENTS in a different ORDER describe
    different alignments — row 3 means a different entity in each — so a digest that could
    not tell them apart would certify the exact failure it exists to catch."""
    keys = ["k-0001", "k-0002", "k-0003"]
    assert conformance.key_sequence_digest(keys) == conformance.key_sequence_digest(list(keys))
    assert conformance.key_sequence_digest(keys) != conformance.key_sequence_digest(keys[::-1])
    swapped = [keys[1], keys[0], keys[2]]
    assert conformance.key_sequence_digest(keys) != conformance.key_sequence_digest(swapped)


def test_the_digest_cannot_be_fooled_by_resplitting(tmp_path):
    """`["ab","c"]` and `["a","bc"]` concatenate to the same bytes and are DIFFERENT key
    sequences — a length-prefix-free digest would call them equal."""
    assert conformance.key_sequence_digest(["ab", "c"]) != conformance.key_sequence_digest(["a", "bc"])
    assert conformance.key_sequence_digest(["a", ""]) != conformance.key_sequence_digest(["a"])
    # Integer keys hash canonically, so width does not change identity.
    assert conformance.key_sequence_digest(np.arange(4, dtype=np.int32).tolist()) == \
        conformance.key_sequence_digest(np.arange(4, dtype=np.int64).tolist())
    with pytest.raises(TypeError, match="no canonical spelling"):
        conformance.key_sequence_digest([1.5])

@pytest.mark.parametrize("depth", [False, True], ids=["bounded", "full"])
def test_the_producer_declares_the_digest_and_the_gate_recomputes_it_from_the_bytes(tmp_path, depth):
    """ITEM-19's two halves, and why it takes two.

    A key artifact DECLARES what its ordered key sequence is (`key_sequence_digest`, over
    the values it stores) and the gate RECOMPUTES that digest from the bytes that landed,
    refusing a disagreement. The declaration is the producer's half of INV-3 — the thing
    that gives a key artifact an identity that is not its LABEL, given that the identity
    the server keys on (`content_hash`) is minted downstream by ingest and so cannot be
    declared. The recomputation is what makes the declaration worth anything.

    The two are taken on OPPOSITE SIDES of the encoder on purpose. A producer that read
    its own file back would digest whatever the encoder wrote and agree with the gate no
    matter what happened to the values on the way out; digesting the values going IN is
    what turns "the bytes digest to whatever the bytes digest to" into a real comparison.

    This test previously asserted the reverse — that the writer emits NO digest — which
    left `structure.key` naming a member with nothing said about it, the `declared !=
    recomputed` branch unreachable, and every key artifact identified by its label alone.
    """
    keys = [f"k-{i:04d}" for i in range(200)]
    root = tmp_path / "keys.zarr"
    with cz.Table(root, axis="rows", n=len(keys), key="key") as t:
        t.string("key", keys)
        structure = t.close()
    assert structure["key"] == "key", "the writer declares WHICH member"
    assert structure["key_sequence_digest"] == conformance.key_sequence_digest(keys), (
        "…and WHAT that member's ordered keys are — the producer-computable half of the "
        "axis's identity"
    )

    # The gate's verdict comes from the BYTES, and here it agrees: a full round-trip
    # through the encoder preserved the key sequence.
    recomputed = conformance.key_sequence_digest_of_member(root, "key")
    assert recomputed == structure["key_sequence_digest"]
    assert conformance.conform_artifact(root, structure, full=True) == []

    # A declaration is CHECKED, never trusted. Here it claims the reversed sequence,
    # which is what a mis-ordered write would have produced.
    structure["key_sequence_digest"] = conformance.key_sequence_digest(keys[::-1])
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("describe different key sequences" in v for v in violations), violations

    # …and the converse is a violation too: naming a key member while declaring nothing
    # about it leaves the artifact identified by its label alone, which is what INV-3
    # forbids. This was previously ACCEPTED — the digest was optional, so nothing ever
    # compared the producer's intent against the store's contents.
    del structure["key_sequence_digest"]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=depth)
    assert any("declares no `key_sequence_digest`" in v for v in violations), violations

    # …and a digest with no key member to check it against is unverifiable, so it is refused
    # rather than accepted on trust.
    orphan = {"encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 1,
              "columns": [], "arrays": [], "key_sequence_digest": recomputed}
    assert any("unverifiable" in v for v in conformance.conform_artifact(root, orphan, full=depth))


def test_an_encoder_that_reorders_the_keys_is_caught_by_the_declaration(tmp_path):
    """The failure the DECLARATION exists for — and which nothing could catch before it.

    The producer digests the sequence it MEANT to store; the gate digests what the store
    actually holds. Swap the stored member for one holding the same keys in a different
    order — the shape, dtype, length and every byte-level check still pass, because a
    permutation is a perfectly well-formed array — and the only thing that notices is the
    disagreement between intent and content. With no declared digest (the previous
    contract) there was nothing to disagree WITH, so this artifact conformed.
    """
    keys = [f"k-{i:04d}" for i in range(64)]
    good = tmp_path / "good.zarr"
    scrambled = tmp_path / "scrambled.zarr"
    with cz.Table(good, axis="rows", n=len(keys), key="key") as t:
        t.string("key", keys)
        structure = t.close()
    with cz.Table(scrambled, axis="rows", n=len(keys), key="key") as t:
        t.string("key", keys[::-1])
        t.close()
    assert conformance.conform_artifact(good, structure, full=True) == []

    # The encoder "wrote" the reversed order while the producer declared the forward one.
    shutil.rmtree(good / "key")
    shutil.copytree(scrambled / "key", good / "key")

    violations = conformance.conform_artifact(good, structure, full=True)
    assert any("describe different key sequences" in v for v in violations), violations


def test_a_key_that_is_not_a_member_is_refused_at_write_time(tmp_path):
    """Declaring a key member that was never written is a producer bug the writer can catch
    on its own — it needs no bytes to know the name is not one of its members."""
    t = cz.Table(tmp_path / "k.zarr", axis="rows", n=2, key="absent")
    t.numeric("value", np.arange(2, dtype=np.float32), dtype="float32")
    with pytest.raises(ValueError, match="not a member of this table"):
        t.close()


def test_artifacts_whose_key_sequences_disagree_are_rejected(tmp_path):
    """The alignment check itself: three artifacts declaring ONE axis, two of which agree.

    The report has to name WHICH disagree — "something is misaligned" across a run of a
    dozen outputs is not actionable.
    """
    keys = [f"k-{i:04d}" for i in range(50)]
    for name, values in (("a", keys), ("b", keys), ("c", keys[::-1])):
        with cz.Table(tmp_path / f"{name}.zarr", axis="rows", n=len(values), key="key") as t:
            t.string("key", values)

    aligned = [(n, tmp_path / f"{n}.zarr", "key") for n in ("a", "b")]
    assert conformance.axis_alignment_violations(aligned) == []

    all_three = aligned + [("c", tmp_path / "c.zarr", "key")]
    violations = conformance.axis_alignment_violations(all_three)
    assert len(violations) == 1
    assert "2 different key sequences" in violations[0]
    assert "a, b" in violations[0] and "c" in violations[0]


def test_conform_outputs_runs_the_alignment_check_across_a_run(tmp_path):
    """Where the digest actually bites: a run emitting several artifacts on one axis."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    keys = [f"k-{i:04d}" for i in range(30)]
    entries = []
    for name, values in (("first", keys), ("second", keys[::-1])):
        with cz.Table(outputs / f"{name}.zarr", axis="rows", n=len(values), key="key") as t:
            t.string("key", values)
            structure = t.close()
        entries.append({"id": name, "path": f"{name}.zarr", "structure": structure})
    (outputs / "manifest.json").write_text(json.dumps({"outputs": entries}))

    violations = conformance.conform_outputs(outputs)
    assert any("different key sequences" in v for v in violations), violations
    assert any(v.startswith("axis 'rows'") for v in violations), violations


# ── the OTHER opt-out: omitting `structure.key` ─────────────────────────────────
#
# `opaque` was a key whose VALUE selected a shallower branch. This is a key whose ABSENCE
# does. `_conform_key` returned `[]` with no key, and `conform_manifest` only put an
# artifact into its axis's alignment group when a key was present — so a producer switched
# off both the digest check AND §0.3's cross-artifact misalignment check by writing NOTHING.
# Closed the way `opaque` was: the omission is falsified against the artifact's own other
# declaration, `meta.is_axis_index: true` (the predicate the server resolves axes by),
# rather than forbidden.


def an_axis_artifact(root, keys, *, key="values"):
    with cz.Table(root, axis="cells", n=len(keys), key=key) as t:
        t.string("values", keys)
        return t.close()


def strip_key(root, structure):
    """Remove BOTH halves of the key declaration and restamp, so the group/row drift check
    does not fire first. This is exactly what a producer omitting `holds_axis_keys` emits."""
    structure = dict(structure)
    structure.pop("key", None)
    structure.pop("key_sequence_digest", None)
    restamp(root, structure)
    return structure


def test_an_artifact_that_says_it_IS_the_axis_must_name_its_key_member(tmp_path):
    """`meta.is_axis_index: true` + no `structure.key` is a self-contradicting declaration.

    `is_axis_index` is the predicate `CatalogRepository::list_dataset_axis_index_candidates`
    resolves an axis by, i.e. the artifact volunteering to be the row every aligned artifact
    in the dataset is aligned AGAINST. An artifact that is an axis while declining to say
    what its ordered key sequence is has no identity but its label — the thing INV-3 forbids
    — and it is exactly the shape that used to pass silently.

    The NEGATIVE CONTROL is half the test: the identical artifact WITHOUT `is_axis_index` is
    accepted, because a positional column genuinely has no key member and refusing it would
    be the inference INV-2 forbids.
    """
    keys = [f"cell-{i}" for i in range(6)]
    root = tmp_path / "idx.zarr"
    structure = an_axis_artifact(root, keys)
    axis_meta = {"is_axis_index": True, "name": "cells_index"}

    # POSITIVE CONTROL: with both halves declared, an axis artifact conforms.
    assert conformance.conform_artifact(root, structure, full=True, meta=axis_meta) == []

    stripped = strip_key(root, structure)
    violations = conformance.conform_artifact(root, stripped, full=True, meta=axis_meta)
    assert any("is_axis_index" in v and "names no `key` member" in v for v in violations), (
        "an artifact declaring it IS the axis while naming no key member must be refused — "
        f"omitting the key is how a producer left the alignment check. Got {violations}"
    )

    # NEGATIVE CONTROL: the same bytes, same stripped structure, no `is_axis_index`.
    for meta in (None, {}, {"is_axis_index": False}, {"name": "total_counts"}):
        assert conformance.conform_artifact(root, stripped, full=True, meta=meta) == [], (
            f"a column that does not claim to be the axis must still pass with meta={meta!r}"
            " — a positional artifact has no key member and inventing one would be inference"
        )


def test_omitting_the_key_cannot_take_an_axis_artifact_out_of_the_alignment_GROUP(tmp_path):
    """The cross-artifact half, through the production entry.

    Two artifacts both declaring `meta.is_axis_index: true` for the `cells` axis, holding the
    barcodes in DIFFERENT orders. With `structure.key` declared, `conform_manifest` compares
    them and names both. Strip the key from both — a permutation is a perfectly well-formed
    array, so every shape/dtype/length/byte-level check still passes — and the whole
    comparison used to vanish, reporting `[]`.

    Asserted on the REPORT rather than on a helper, because the escape was in the grouping
    (`if key and axis`), not in the comparison.
    """
    keys = [f"cell-{i}" for i in range(6)]
    out = tmp_path / "outputs"
    out.mkdir()
    forward = an_axis_artifact(out / "a.zarr", keys)
    reverse = an_axis_artifact(out / "b.zarr", keys[::-1])
    manifest = {"outputs": [
        {"id": "cells_index", "path": "a.zarr", "structure": forward,
         "meta": {"is_axis_index": True}},
        {"id": "other_index", "path": "b.zarr", "structure": reverse,
         "meta": {"is_axis_index": True}},
    ]}

    # POSITIVE CONTROL: declared keys ⇒ the misalignment is named, both artifacts implicated.
    report = conformance.conform_manifest(out, manifest)
    cross = [(labels, v) for labels, v in report if "different key sequences" in v]
    assert len(cross) == 1 and sorted(cross[0][0]) == ["cells_index", "other_index"], report

    # THE OPT-OUT: strip the key from both. Nothing else about either artifact changes.
    manifest["outputs"][0]["structure"] = strip_key(out / "a.zarr", forward)
    manifest["outputs"][1]["structure"] = strip_key(out / "b.zarr", reverse)
    report = conformance.conform_manifest(out, manifest)
    assert report, (
        "two artifacts each declaring they ARE the `cells` axis, holding the barcodes in "
        "different orders, and the gate said nothing — omitting `structure.key` removed "
        "both of them from the alignment group, which is the mechanism for catching "
        "row-order misalignment (DEC-8: no producer-authored field may make the gate check "
        "less)"
    )
    named = {label for labels, _ in report for label in labels}
    assert named == {"cells_index", "other_index"}, (
        f"both artifacts must be named, got {[(l, v) for l, v in report]}"
    )


def test_the_gate_never_reads_member_bytes_through_the_convenience_reader(tmp_path, monkeypatch):
    """The module header's ONE-container-reader claim, asserted instead of documented.

    The header says "the gate never calls `read_array` for member bytes", and the reason it
    matters is stated right there: `cyto_zarr_read` implements the Zarr rule that an absent
    chunk is `fill_value`, which is correct for a READER and exactly wrong for a gate — it
    turns a blanked shard-index slot into a silent run of zeroes (and, on an offsets array,
    into a silent re-split). The claim was FALSE for one live path:
    `key_sequence_digest_of_member` went through `read_column`, and it is reached from
    `_conform_key` and `axis_alignment_violations` — both production.

    Asserted by making the convenience reader RAISE and then running the production entry
    over every artifact shape that has a key member, an aligned pair, a table and a matrix.
    A source scan for the string `read_array` would pass while an indirect call still
    happened; this fails on the CALL.
    """
    out = tmp_path / "outputs"
    out.mkdir()
    keys = [f"cell-{i}" for i in range(6)]
    forward = an_axis_artifact(out / "a.zarr", keys)
    also = an_axis_artifact(out / "b.zarr", keys)
    table = a_table(out / "t.zarr", n=64)
    matrix = a_matrix(out / "m.zarr")

    def refuse(*args, **kwargs):
        raise AssertionError(
            "the gate reached cyto_zarr_read.read_array for member bytes — the fill-value "
            "rule that reader implements is the weaker arm the module header rules out"
        )

    monkeypatch.setattr(cyto_zarr_read, "read_array", refuse)
    manifest = {"outputs": [
        {"id": "a", "path": "a.zarr", "structure": forward, "meta": {"is_axis_index": True}},
        {"id": "b", "path": "b.zarr", "structure": also, "meta": {"is_axis_index": True}},
        {"id": "t", "path": "t.zarr", "structure": table},
        {"id": "m", "path": "m.zarr", "structure": matrix},
    ]}
    report = conformance.conform_manifest(out, manifest)
    assert list(report) == [], report
    # And the digest is still the producer's digest — rerouting the read must not change
    # WHAT is digested, only how it is read.
    assert conformance.key_sequence_digest_of_member(out / "a.zarr", "values") == (
        forward["key_sequence_digest"]
    )


def test_a_key_member_that_is_not_a_declared_member_is_refused(tmp_path):
    """`structure.key` naming something no member declares would have the digest taken over
    bytes no other check in this suite ever looked at."""
    keys = [f"cell-{i}" for i in range(4)]
    root = tmp_path / "stray.zarr"
    structure = an_axis_artifact(root, keys)
    structure["key"] = "not_a_member"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("no declared member has that path" in v for v in violations), violations


# ── the two server-side manifest caps, held against each other ──────────────────


#: `sandbox/outputs.rs` — the server's manifest caps. Read out of the Rust source rather
#: than restated here for the same reason `_SERVER_PROCESSORS_RS` is: a constant typed in
#: two languages drifts, and the copy in the test is the one that goes stale silently.
_SERVER_OUTPUTS_RS = (
    Path(__file__).resolve().parents[2] / "server/src/modules/sandbox/outputs.rs"
)


def _load_helper(name):
    """Import a module from the sibling `_helpers` package by path."""
    path = Path(__file__).resolve().parents[1] / "_helpers" / f"{name}.py"
    assert path.is_file(), f"{name} is not at {path}"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _server_cap(name):
    """One `pub const <name>: <ty> = <expr>;` from `outputs.rs`, evaluated."""
    assert _SERVER_OUTPUTS_RS.is_file(), (
        f"the manifest caps are not at {_SERVER_OUTPUTS_RS} — this guard derives its "
        "budget from them and must fail loudly rather than assert against a guess"
    )
    m = re.search(
        rf"pub const {name}:\s*\w+\s*=\s*([0-9_ *+]+);", _SERVER_OUTPUTS_RS.read_text()
    )
    assert m, f"`pub const {name}` not found in {_SERVER_OUTPUTS_RS}"
    return int(eval(m.group(1).replace("_", "")))  # noqa: S307 — digits/operators only


def test_the_two_manifest_caps_are_consistent(tmp_path):
    """`MAX_OUTPUTS` entries must FIT in `MAX_MANIFEST_BYTES`.

    The two caps were chosen independently and contradicted each other: 512 outputs ×
    the largest entry the writers emitted (4,842 B, of which 3,800 was a 200-category
    display preview) is 2.4 MB against a 1 MiB manifest cap. So a manifest could satisfy
    the entry-count cap and still be refused by the size cap — and nothing compared them,
    in either language.

    That is the gap this whole class fell through. `MAX_MANIFEST_BYTES` had NO test at
    all (its sibling `MAX_OUTPUTS` had a careful boundary test with a positive control),
    the producer tests asserted manifest CONTENT but never its size, and the Rust tests
    fed `load_produced_outputs` hand-built manifests — so producer-scale × consumer-cap
    was a seam no test crossed. A real 3.5k × 35k import hit it: 2.1 MB, run failed.

    The budget is `MAX_MANIFEST_BYTES / MAX_OUTPUTS`, per entry. Asserting it against
    entries from the REAL writer (not a hand-built fixture) is the point — that is the
    combination that was untested.
    """
    # `colsummary` lives in `_helpers`, which is not on this package's test path — load
    # it by path so the worst-case entry is summarized by the REAL helper the processors
    # use, not by a hand-built stand-in that could drift from it.
    colsummary = _load_helper("colsummary")

    max_outputs = _server_cap("MAX_OUTPUTS")
    max_bytes = _server_cap("MAX_MANIFEST_BYTES")
    budget = max_bytes // max_outputs

    # The worst entry the writers can emit: a categorical whose level set is far past
    # anything a preview keeps, with long labels, over a large axis (so every count in
    # the entry is at its widest decimal form).
    root = tmp_path / "worst.zarr"
    n = 1_000_000
    levels = [f"a-quite-long-category-label-number-{i:06d}" for i in range(60_000)]
    with cz.Table(root, axis="rows", n=n) as t:
        t.categorical("values", codes=[i % len(levels) for i in range(n)], levels=levels)
        structure = t.close()

    # The summary rides the ENTRY, not the member — that is where the real writers put
    # it (`structure.columns[0]` carries no `meta` in a produced manifest), and building
    # it on both would inflate this budget with a duplication production never emits.
    meta = colsummary.summarize_column(
        pd.Series(pd.Categorical([levels[i % len(levels)] for i in range(2000)],
                                 categories=levels)),
        "worst",
    )
    entry = {
        "id": "metadata-column:worst", "datatype": "metadata-column",
        "path": "metadata/worst.zarr", "layout": "chunked-1d", "role": "artifact",
        "structure": structure, "meta": meta,
        "label": "worst case", "axis": "rows",
    }
    size = len(json.dumps(entry, separators=(",", ":")))
    assert size <= budget, (
        f"the worst entry the writers emit is {size:,} B but {max_outputs} of them must "
        f"fit {max_bytes:,} B — {budget:,} B each. `MAX_OUTPUTS` and `MAX_MANIFEST_BYTES` "
        f"are inconsistent: a run can satisfy one cap and be refused by the other, which "
        f"is a producer-side failure the producer cannot see. Shrink what rides an entry "
        f"(the level set is already a digest; the category preview is capped by both "
        f"`MAX_SUMMARY_CATEGORIES` and `MAX_SUMMARY_CATEGORIES_BYTES`) or reconcile the "
        f"two constants."
    )
    assert max_outputs * size <= max_bytes, "a full manifest of worst entries must fit"

    # NEGATIVE CONTROL: the budget is not vacuous — an entry that inlines what this
    # design removed (the level set) must BLOW it, or the assertion above would pass no
    # matter what the writers did.
    bloated = dict(entry, structure=dict(structure, columns=[
        dict(structure["columns"][0], levels=levels)
    ]))
    assert len(json.dumps(bloated, separators=(",", ":"))) > budget, (
        "inlining the level set must exceed the per-entry budget — if it does not, this "
        "test cannot distinguish the fix from the bug it replaced"
    )


# ── ITEM-15/ITEM-16 — `structure.aligned_to`, verified against the bytes ──────────
#
# The declaration `key_sequence_digest` makes from the KEY artifact's side, made from the
# other one: a column carrying no keys of its own names the row space its values line up
# with. Like every producer declaration in this format it is CHECKED, not trusted — here,
# against the key sequences the run's own key artifacts stored.


def a_column_aligned_to(root, digest, *, axis="cells", n=6):
    with cz.Table(root, axis=axis, n=n, aligned_to=digest) as t:
        t.numeric("values", np.arange(n, dtype="float32"), dtype="float32")
        return t.close()


def test_a_declared_alignment_is_checked_against_the_run_s_own_key_sequence(tmp_path):
    """TEST-24 — the value `axis_alignment_violations` used to compute and discard.

    The gate already digested every key member to compare them with each other; ITEM-16 is
    that same digest, compared against what a NON-key artifact claims. Both directions are
    asserted in one run so neither can pass by the gate simply saying nothing.
    """
    out = tmp_path / "outputs"
    out.mkdir()
    keys = [f"cell-{i}" for i in range(6)]
    index = an_axis_artifact(out / "idx.zarr", keys)
    truthful = a_column_aligned_to(out / "ok.zarr", index["key_sequence_digest"])
    lying = a_column_aligned_to(out / "bad.zarr", cz.key_sequence_digest(keys[::-1]))

    manifest = {"outputs": [
        {"id": "cells_index", "path": "idx.zarr", "structure": index,
         "meta": {"is_axis_index": True}},
        {"id": "score", "path": "ok.zarr", "structure": truthful},
        {"id": "other_score", "path": "bad.zarr", "structure": lying},
    ]}
    report = conformance.conform_manifest(out, manifest)
    named = {label for labels, _ in report for label in labels}
    assert named == {"other_score"}, (
        "exactly the artifact whose declared alignment is not the key sequence this run "
        f"stored must be condemned — got {[(l, v) for l, v in report]}"
    )
    assert any("not the key sequence" in v for _labels, v in report), report


def test_an_alignment_declared_against_an_axis_this_run_did_not_emit_is_not_condemned(tmp_path):
    """The deliberate silence, asserted so it cannot be tightened by accident.

    A run that adds columns to an axis it did not create cannot check its own claim from
    inside itself. Condemning what cannot be examined would make the declaration unusable
    for exactly the producers ITEM-15 wants to adopt it, and the claim is still refutable
    later — by the offering predicate, against the real axis.
    """
    out = tmp_path / "outputs"
    out.mkdir()
    orphan = a_column_aligned_to(out / "col.zarr", cz.key_sequence_digest(["a", "b", "c"]))
    manifest = {"outputs": [{"id": "score", "path": "col.zarr", "structure": orphan}]}
    assert conformance.conform_manifest(out, manifest) == []


def test_an_alignment_that_is_not_a_digest_is_refused_without_reading_a_byte(tmp_path):
    """The shape half, on the path where the writer's own guard was never in play — a
    hand-built manifest entry or a re-encoder. A label or the keys themselves would
    otherwise sail through every check in this suite and surface only as a picker that
    quietly offers nothing."""
    root = tmp_path / "col.zarr"
    structure = a_column_aligned_to(root, cz.key_sequence_digest(["a"] * 6))
    for bad in ("cells", "", ["cell-0", "cell-1"], 7, "A" * 64):
        forged = dict(structure)
        forged["aligned_to"] = bad
        restamp(root, forged)
        violations = conformance.conform_artifact(root, forged, full=True)
        assert any("not a `key_sequence_digest`" in v for v in violations), (bad, violations)

    # An explicit `null` is ABSENCE, not a malformed digest — the one spelling of "I am not
    # declaring this" JSON can carry beside omitting the key, and reading it as a violation
    # would condemn a producer for saying nothing in a slightly different way.
    absent = dict(structure)
    absent["aligned_to"] = None
    restamp(root, absent)
    assert conformance.conform_artifact(root, absent, full=True) == []


def test_an_artifact_carrying_the_keys_cannot_declare_a_different_alignment(tmp_path):
    """One producer, two sentences, contradicting each other — decidable with no bytes read,
    so it is named as a self-contradiction rather than reported as a disagreement with the
    run."""
    root = tmp_path / "idx.zarr"
    structure = an_axis_artifact(root, [f"cell-{i}" for i in range(6)])
    forged = dict(structure)
    forged["aligned_to"] = cz.key_sequence_digest(["z"])
    restamp(root, forged)
    violations = conformance.conform_artifact(root, forged, full=True)
    assert any("cannot disagree" in v for v in violations), violations

    # NEGATIVE CONTROL: the same artifact declaring its OWN digest is redundant, not wrong.
    agreeing = dict(structure)
    agreeing["aligned_to"] = structure["key_sequence_digest"]
    restamp(root, agreeing)
    assert conformance.conform_artifact(root, agreeing, full=True) == []


def test_an_absent_alignment_is_absent_and_the_gate_says_nothing(tmp_path):
    """The migration state, pinned: today's artifacts declare no `aligned_to` and must go on
    conforming. A gate that required it would condemn every artifact in every existing
    project — the viewer's answer to the absence is a marker (A3), not a refusal."""
    out = tmp_path / "outputs"
    out.mkdir()
    keys = [f"cell-{i}" for i in range(6)]
    index = an_axis_artifact(out / "idx.zarr", keys)
    with cz.Table(out / "plain.zarr", axis="cells", n=6) as t:
        t.numeric("values", np.arange(6, dtype="float32"), dtype="float32")
        plain = t.close()
    assert "aligned_to" not in plain
    manifest = {"outputs": [
        {"id": "cells_index", "path": "idx.zarr", "structure": index,
         "meta": {"is_axis_index": True}},
        {"id": "score", "path": "plain.zarr", "structure": plain},
    ]}
    assert conformance.conform_manifest(out, manifest) == []


# ── ITEM-53 — `meta.groups_entries`, the column that declares its own role ────────


def test_a_grouping_declaration_is_read_by_one_predicate(tmp_path):
    """`declares_groups_entries` is the `declares_axis_index` shape, and for the same
    reason: two spellings of a predicate is how the two halves of a paired declaration
    drift apart."""
    assert conformance.declares_groups_entries({"groups_entries": True}) is True
    for meta in (None, {}, {"groups_entries": False}, {"groups_entries": "true"},
                 {"groups_entries": 1}, {"name": "modality"}):
        assert conformance.declares_groups_entries(meta) is False, meta


def test_a_grouping_claim_the_viewer_could_not_act_on_is_refused(tmp_path):
    """Both unfalsifiable shapes, from the producer's own two declarations.

    WHICH grouping is correct is a domain fact this framework file must not know (INV-5), so
    the gate checks the shape of the claim and nothing else — which is why the positive
    control below (an ordinary categorical column claiming it) passes with the grouping
    values being arbitrary strings.
    """
    root = tmp_path / "col.zarr"
    with cz.Table(root, axis="genes", n=3) as t:
        t.string("values", ["alpha", "beta", "alpha"])
        structure = t.close()

    ok = {"name": "grouping", "kind": "categorical", "groups_entries": True}
    assert conformance.conform_artifact(root, structure, full=True, meta=ok) == []

    on_the_index = dict(ok, is_axis_index=True)
    assert any("IS its axis's entries" in v for v in
               conformance.conform_artifact(root, structure, full=True, meta=on_the_index))

    continuous = {"name": "score", "kind": "continuous", "groups_entries": True}
    assert any("discrete levels" in v for v in
               conformance.conform_artifact(root, structure, full=True, meta=continuous))

    keyed = an_axis_artifact(tmp_path / "idx.zarr", ["a", "b", "c"])
    assert any("every key is its own group" in v for v in
               conformance.conform_artifact(tmp_path / "idx.zarr", keyed, full=True, meta=ok))
