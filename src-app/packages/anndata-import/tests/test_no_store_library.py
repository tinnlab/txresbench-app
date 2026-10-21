"""TEST-38 [artifact-model ITEM-27] — this package no longer speaks the store library.

WHAT THIS ASSERTS
-----------------
1. `compute/h5ad_import.py` contains no EXECUTABLE reference to the TileDB-SOMA
   library, nor to the two `tiledbsoma.io` entry points that wrote the store.
2. The replacement is actually wired in (`cyto_csc` + `write_expression_csc`), so
   the check cannot pass by the script having been emptied.
3. `manifest.yaml` no longer DECLARES the retired output type, and still declares
   the CSC matrix it does produce.

WHY IT LIVES HERE AND NOT IN THE APP'S RUST SUITE
-------------------------------------------------
It used to live in `server/tests/dataset/mod.rs`, where it read these two files by
hardcoded path out of the app's integration suite. The subject is this PACKAGE's own
source: the app can neither cause nor prevent an `import tiledbsoma` here, and INV-5
("the core is DOMAIN-AGNOSTIC") means the app's test tree must not know that a package
by this name, or a library by that one, exists. `src-app/packages/**` is the
contributed domain AS DATA, and a package testing its own domain is exactly what a
contributed package is for.

It is still GATED, in the same `just check` run it was before: `just check` calls
`just check-py`, which runs `python3 -m pytest -q` over this whole tree.

The runtime half of TEST-38 (a real import emits a Zarr CSC and leaves no store
directory on disk) stays in the app suite, where it belongs — it is a statement about
what the SERVER catalogs — and is rootfs-gated there.

The forbidden names are spelled here because a test asserting a name is ABSENT has to
contain it. That is why the app's tree is the wrong home for the assertion and this one
is the right home: here the vocabulary is the subject, not a leak.
"""

import io
import os
import tokenize

_PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT = os.path.join(_PKG, "compute", "h5ad_import.py")
_MANIFEST = os.path.join(_PKG, "manifest.yaml")

# Executable references that would mean the transpose BUFFER is back on the critical
# path. `from_h5ad(` / `from_anndata(` are the `tiledbsoma.io` writers; `store.soma`
# is the local handle the old code read back out of.
BANNED = (
    "import tiledbsoma",
    "tiledbsoma.io",
    "from_h5ad(",
    "from_anndata(",
    "store.soma",
)


def _executable_source(path):
    """`path`'s source with COMMENTS and TRIPLE-QUOTED strings removed.

    The module's prose still has to be able to explain what was deleted and why —
    forbidding the WORD everywhere would force that history to be erased along with
    the dependency — so only executable text is searched. Tokenising (rather than
    splitting on `#`) is exact: a `#` inside a string literal cannot truncate a line,
    and a docstring cannot be mistaken for an import. Ordinary single-quoted string
    literals are DELIBERATELY kept: a `"tiledbsoma"` passed to `importlib` would be a
    live reference, and dropping every string would make this laxer than it must be.
    """
    with open(path, "rb") as fh:
        src = fh.read().decode("utf-8")
    # Lines are edited IN PLACE (removed spans become spaces) rather than re-joined
    # from tokens: `store.soma`, `tiledbsoma.io` and `def write_expression_csc` are
    # each MORE THAN ONE token, so a token join would split every one of them and the
    # searches below would silently never match anything.
    lines = src.splitlines(keepends=True)
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        drop = tok.type == tokenize.COMMENT or (
            tok.type == tokenize.STRING
            and tok.string.lstrip("rbfuRBFU")[:3] in ('"""', "'''")
        )
        if not drop:
            continue
        (r0, c0), (r1, c1) = tok.start, tok.end
        for row in range(r0, r1 + 1):
            line = lines[row - 1]
            start = c0 if row == r0 else 0
            end = c1 if row == r1 else len(line.rstrip("\n"))
            lines[row - 1] = line[:start] + " " * (end - start) + line[end:]
    return "".join(lines)


def test_the_import_script_has_no_executable_store_library_reference():
    code = _executable_source(_SCRIPT)
    for banned in BANNED:
        assert banned not in code, (
            "`%s` is still executable in %s — ITEM-27 replaced the transpose buffer "
            "with the streaming counting sort in `cyto_csc`, so any live reference "
            "means the buffer is back on the critical path"
            % (banned, os.path.basename(_SCRIPT))
        )


def test_the_streaming_transpose_replacement_is_wired_in():
    # The positive control for the test above: an EMPTIED script would satisfy every
    # absence assertion, so the replacement has to be present for those to mean anything.
    code = _executable_source(_SCRIPT)
    assert "cyto_csc" in code, (
        "%s must use the streaming transpose (`cyto_csc`) it was moved to"
        % os.path.basename(_SCRIPT)
    )
    assert "def write_expression_csc" in code, (
        "the CSC Zarr writer that replaced `stream_csc_from_soma` is missing"
    )


def test_the_manifest_no_longer_declares_the_retired_output():
    with open(_MANIFEST, "r", encoding="utf-8") as fh:
        declarations = [
            line.strip() for line in fh if not line.strip().startswith("#")
        ]
    assert not any("single-cell/soma" in line for line in declarations), (
        "the manifest still declares `single-cell/soma` — `/extensions` would "
        "advertise an output no run produces"
    )
    assert any("single-cell/expression" in line for line in declarations), (
        "the manifest must still declare the CSC matrix it does produce"
    )
