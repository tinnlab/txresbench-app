#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 [covers: ITEM-1] — the server-side golden snapshots reflect the NEW 2D per-comparison
`de/result` shape (regenerated, not stale), and no member name carries single-cell domain
vocabulary (strip-lint safe)."""
from pathlib import Path

import json

_SERVER = Path(__file__).resolve().parents[3] / "server"
_LATTICE = _SERVER / "src/modules/datatype/tests/lattice_golden.json"
_SERVE_TEST = _SERVER / "tests/workstore/open_kinds_serve_test.rs"


def test_lattice_golden_keeps_de_result_as_tabular_non_abstract():
    """The shared server-side golden still pins this package's type as a `tabular` subtype.

    RE-POINTED (fix/zero-core-derived). This read `golden["lattice"]`, an array enumerating
    EVERY type in the registry, which was deleted: it made contributing a datatype cost an
    edit to a file under `src-app/server/src/`, mutually unsatisfiable with the zero-core
    invariant this package's own guards assert (docs/design/derived-guards.md §4).

    The claim itself is unchanged and is still pinned in that same shared fixture — as
    `is_a` CASES rather than as a row of a full-set enumeration. Those rows were added by
    the same change precisely so the five contributed types no case table covered did not
    lose their frozen parentage. A case table costs no edit when a NEW datatype is
    contributed, which is the whole point.

    The NEGATIVE row matters as much as the positive one: `extends` is a single value, so
    "is a tabular" alone would still hold if the type were re-rooted under a `tabular`
    ancestor. Asserting a non-parent too is what pins it to `tabular` specifically.
    """
    golden = json.loads(_LATTICE.read_text())
    cases = {(c["sub"], c["sup"]): c["expect"] for c in golden["is_a"]}
    assert cases.get(("de/result", "tabular")) is True, (
        "the shared golden no longer pins `de/result` as a `tabular` subtype"
    )
    assert cases.get(("de/result", "matrix")) is False, (
        "the shared golden no longer pins `de/result` as NOT a `matrix` subtype"
    )

    # `is_abstract` is not expressible as an `is_a` case, so it is asserted against the
    # DECLARATION. WHICH package declares it is DERIVED, not assumed: `de/result` is an
    # open kind and lives in `open-kinds/manifest.yaml`, not in this package's own manifest
    # (a first cut of this repair assumed the latter and failed, correctly). Searching for
    # the declaring manifest means the assertion survives the kind moving packages, and
    # fails loudly if nothing declares it at all.
    import re

    packages = Path(__file__).resolve().parents[2]
    declarers = [
        m
        for m in sorted(packages.glob("*/manifest.yaml"))
        if re.search(r"^\s*-\s*id:\s*de/result\s*$", m.read_text(encoding="utf-8"), re.M)
    ]
    assert len(declarers) == 1, (
        f"expected exactly one package to declare `de/result`, found {declarers}"
    )
    decl = declarers[0].read_text(encoding="utf-8").split("- id: de/result", 1)[1]
    decl = re.split(r"\n\s{4}- id:", decl, maxsplit=1)[0]
    assert re.search(r"^\s*extends:\s*tabular\s*$", decl, re.M), "declared parent moved"
    assert re.search(r"^\s*is_abstract:\s*false\s*$", decl, re.M), "declared as abstract"


def test_serve_test_asserts_the_new_gene_table_shape_not_the_comparison_axis():
    text = _SERVE_TEST.read_text()
    # the stacked `(comparison × gene)` assertions were REGENERATED to the 2D gene table.
    assert 'a.name == "comparison"' in text  # still referenced, but in a NEGATED assertion:
    assert "no longer declares a `comparison` axis" in text
    assert 'de.entity_axis.as_deref(),' in text
    # the dense (gene × comparison) matrix serve exercise is gone (columnar now).
    assert "comparison-1 per-row logFC" not in text
