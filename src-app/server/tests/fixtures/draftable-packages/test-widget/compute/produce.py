#!/usr/bin/env python3
# ruff: noqa
"""TEST-ONLY freeze producer for the draftable-entity acceptance tests.

The freeze runner (`drafts::freeze::build_freeze_producer_params`) enqueues an analysis
run whose `params` bag IS the opaque `draft.data`; the sandbox harness writes that bag to
`/inputs/params.json`. This script reads it and mints ONE immutable opaque artifact under
`/outputs`, plus the `/outputs/manifest.json` the ingest sink consumes.

Contract mirrored from the shipped packages' `_shared.py` (`io_dirs`, `params`,
`write_manifest`, `output_entry`, `CYTO_OUTPUTS_DIR`), but inlined + STDLIB-ONLY so the
producer needs no staged helpers and no scientific stack — any rootfs with `python3` runs it.

Two properties the acceptance tests rest on:
  * the output datatype is `data/opaque` (a CONCRETE core builtin the running server's
    datatype registry already knows) with `layout: opaque` + `structure.encoding: opaque`,
    so `workstore::ingest`'s typing + structure validation accept it (INV: an opaque blob
    makes no member-structure claim);
  * the payload EMBEDS the draft body, so editing the draft ({"n":1} -> {"n":2}) and
    re-freezing forks NEW bytes -> a NEW content-addressed artifact (INV-2).
"""
import json
import os
from pathlib import Path

inputs_dir = Path(os.environ.get("CYTO_INPUTS_DIR", "/inputs"))
outputs_dir = Path(os.environ.get("CYTO_OUTPUTS_DIR", "/outputs"))
outputs_dir.mkdir(parents=True, exist_ok=True)

# The opaque draft body (whatever JSON the draft carries). Absent/garbled -> {}.
try:
    body = json.loads((inputs_dir / "params.json").read_text())
except (FileNotFoundError, ValueError):
    body = {}

# ONE immutable output: the frozen snapshot of the draft body. Deterministic bytes for a
# given body (sort_keys) so re-freezing the SAME body is byte-identical, while a DIFFERENT
# body forks different bytes -> a different content_hash -> a new artifact (INV-2).
payload = json.dumps({"frozen": body}, sort_keys=True).encode("utf-8")
(outputs_dir / "frozen-widget.json").write_bytes(payload)

manifest = {
    "outputs": [
        {
            "id": "frozen-widget",
            "datatype": "data/opaque",
            "path": "frozen-widget.json",
            "layout": "opaque",
            "role": "artifact",
            # `structure` must be an object NAMING a non-empty `encoding` (ingest's
            # validate_declared_structure refuses `{}`); `opaque` is the encoding for
            # bytes with no member structure — the conformance gate accepts it.
            "structure": {"encoding": "opaque", "media_type": "application/json"},
            "meta": {"produced_by": "test.widget.freeze"},
        }
    ]
}
(outputs_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
print("test.widget.freeze: minted frozen-widget opaque artifact", flush=True)
