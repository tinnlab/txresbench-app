#!/usr/bin/env python3
# ruff: noqa
"""The bin-control view's shape — a valid declarative view whose bin options are DERIVED.

The whole user-facing surface of this change is `ui/import-hd.yaml`, interpreted by the
shipped workbench renderer. The thing that can go wrong is not a rendering bug, it is a
DECLARATION that names something which does not exist — or, the silent one, a bin picker
whose options are ENUMERATED in the file instead of derived from the container's
declaration.

── The honest limit of this file ───────────────────────────────────────────────────────
The parse-level vocabulary of this view — widget kinds, effect ops, `$`-references,
permissions, and the run action's `appliesTo` slots — is covered by the shipped
`processorViewSpecs.test.ts` (under `src-app/ui/src/modules/workbench/core/spec/`), which
globs every `packages/*/ui/*.yaml`, runs the REAL `parseViewSpec`, and asserts the run
action binds every required `appliesTo` slot and names only slots the compute resolves.
This file does NOT re-implement that gate, and it deliberately does not enumerate the
engine's vocabulary: `WIDGET_KINDS` is OPEN (extension kinds join via `registerWidget`),
so a stricter-than-the-engine list here would manufacture a false failure. What this file
adds that the gate cannot see is the PACKAGE-SPECIFIC structural contract: the bin
options are DERIVED from the container's declaration rather than enumerated, the view's
default ties to the compute's `DEFAULT_BIN_UM`, and the manifest names this view file.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_UI = _PKG / "ui"
_VIEW = _UI / "import-hd.yaml"
_MANIFEST = _PKG / "manifest.yaml"


def _spec():
    return yaml.safe_load(_VIEW.read_text(encoding="utf-8"))


def _manifest():
    return yaml.safe_load(_MANIFEST.read_text(encoding="utf-8"))


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def test_the_bin_options_are_derived_from_the_container_not_enumerated():
    """The discriminating assertion: the bin picker's options are a `$data.` reference to the
    `container_members` slice, and NO `options:` key anywhere in the file holds a literal
    list. A literal `[2,8,16]` in the yaml would drift the moment the container's declaration
    changed — the coupling the container derivation exists to keep. Structural, so a future
    enumerated shape is caught too."""
    spec = _spec()
    for node in _walk(spec):
        if "options" in node:
            value = node["options"]
            assert isinstance(value, str) and value.startswith("$"), (
                f"an `options:` value is a literal list ({value!r}) — the offer must be a "
                f"`$`-reference, never enumerated")
    bin_picker = next(w for w in spec["widgets"] if w["id"] == "binPicker")
    assert bin_picker["options"] == "$data.bins"
    assert spec["data"]["bins"]["source"] == "container_members"
    assert spec["data"]["bins"]["args"]["datatype"] == "spatial/visium-hd-bundle"


def test_the_bin_default_is_null_and_the_ALERT_states_the_compute_default():
    """The SHIPPED contract (issue #361): the declarative select is string-valued at the kit
    level, so the setter action must declare its param type as `string` — a regression to
    `number` would diverge from what the picker actually sends. The state default is NULL:
    an untouched form sends NO bin, so the compute takes its own `DEFAULT_BIN_UM` and
    records `chose_by == "default"` — prefill would make every launch look like a deliberate
    choice. The default is then tied to the compute's `DEFAULT_BIN_UM` by READING both: the
    `defaultBinNote` alert's stated default and the importer's own constant cannot drift
    apart."""
    spec = _spec()
    assert spec["state"]["bin"]["default"] is None, (
        f"bin default must be null (an untouched form sends no bin), got "
        f"{spec['state']['bin']['default']!r}")
    setter = next(a for a in spec["actions"] if a["id"] == "hd.setBin")
    assert setter["params"]["value"] == "string"
    # The ALERT's stated default and the compute's `DEFAULT_BIN_UM` are READ from their own
    # sources and compared — a change on either side fails here rather than drifting.
    alert = next(w for w in spec["widgets"] if w["id"] == "defaultBinNote")
    match = re.search(r"(\d+) um default", alert["text"])
    assert match, "the defaultBinNote alert must state the default as '<N> um default'"
    compute_src = (_PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    compute_match = re.search(r"^DEFAULT_BIN_UM\s*=\s*(\d+)", compute_src, re.MULTILINE)
    assert compute_match, "the compute must declare `DEFAULT_BIN_UM` as a module constant"
    assert match.group(1) == compute_match.group(1), (
        f"the alert's stated default {match.group(1)!r} drifted from the compute's "
        f"DEFAULT_BIN_UM {compute_match.group(1)!r}")


def test_the_manifest_names_this_view_file_and_it_exists():
    """The manifest's `ui:` list names this file, and the file exists on disk.

    This is the package-side half of the fail-CLOSED load rule: a `ui:` entry naming a file
    that is absent is a LOAD ERROR for the analysis' whole pane
    (`src-app/ui/src/modules/workbench/core/runtime/loadProcessors.ts:181-211`). The test
    asserts the two facts the rule needs — the manifest names the file and the file is
    there — rather than re-implementing the loader."""
    manifest = _manifest()
    analysis = manifest["contributes"]["analyses"][0]
    assert "ui/import-hd.yaml" in analysis["ui"]
    assert _VIEW.is_file()
