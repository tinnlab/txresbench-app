#!/usr/bin/env python3
# ruff: noqa
"""join-quality PREFLIGHT — measure the candidate join keys, before one is chosen.

## Why this exists as its own run

The owner settled (DEC-20) that join quality is measured **automatically on key selection**,
not behind a control the user must know to press. The form therefore needs the numbers
without asking a human for anything — and the `data:` source vocabulary a view can bind is a
CLOSED dispatch table (`job.result`, `axis_columns`, `row_space_columns`, `axis_entries`,
`axis_entry_values`, `axis_entry_rows`, `pane_frame`, `column_values`) with no
compute-on-demand kind in it. There is no way for a form to ask the backend to compute
something inline.

So this is the shape that fits WITHOUT inventing a source kind: a cheap run whose output the
form reads through `job.result`. It adds no mechanism; it exposes the ITEM-1 engine that
already exists as its own artifact.

## What it returns, and the one field that is not optional

Per candidate key: `matched` / `conflicting` / `duplicated` — the three the design draws —
plus `missing` and **`joinable`**. `joinable` is the one a picker may not skip: the
highest-`matched` candidate **can be `joinable: false`**, because two blank values in one
source make the join impossible (`align` refuses them as `duplicate key ''`). A picker that
rendered only the three counts would let a user select the best-looking key and meet the
refusal afterwards.

## Cost — measured, not asserted

It reads ONLY the `entity:<i>:<column>` bindings — never the `rows:` axis index, never a
`level:` column, never a matrix: join quality is a function of the small identifier columns
alone, and ITEM-1's constraint (INV-11) is that the answer be reachable without fetching a
body. The suite measures a real run at realistic cardinality and pins a ceiling, so "cheap
enough to run on every key change" is a number in a test rather than a claim in a docstring.

`load_grid(with_rows=False, with_levels=False)` is what makes that true, and it is the same
loader the producer uses — so the cheapness is a call-site ARGUMENT rather than a second
loader that could quietly start reading more.
"""
import cyto_deps
import json
import sys

import alignment as engine

# The same I/O idioms the producer uses. Imported rather than re-implemented so the two
# entry points of one package cannot drift about what `/inputs` means.
from embedding_integrate import io_dirs, load_grid, read_json


def load_entity_sources(inputs_dir, params):
    """`[SourceTable, …]` carrying ONLY the entity columns — the cheap half.

    ONE definition, shared with the producer: `load_grid`. The two entry points of this
    package resolved `/inputs` through two separate loaders before, which is how they could
    disagree about what a binding means while each agreed with itself — the same shape as
    every other defect this branch has paid for. The sibling import exists precisely so
    there is one answer (`manifest.yaml` declares `helpers: [compute/embedding_integrate.py]`
    for this entry, without which the import is a `ModuleNotFoundError` at process start).

    `with_rows=False` / `with_levels=False` is the cheap half, and it is a COST decision with
    a test behind it: join quality is a function of the small entity columns alone (ITEM-1 /
    INV-11), and reading the row axis would multiply it by the cell count — the dimension
    that is large. `SourceTable` keeps `row_keys=None` as a real "cannot be checked" state,
    so this is a legitimate partial source rather than one with a fabricated axis.

    The `rows:` bindings are consequently NOT read here, which also means the
    `dataset_content_hashes` cross-check does not run on this path — `cross_check_relay`
    skips when no row axis is bound. That is honest rather than convenient: the preflight
    reports per-key COUNTS and never records an identity anywhere, so a mis-ordered relay
    mislabels a row of the picker rather than attributing one dataset's rows to another. The
    producer, which does record identities, binds the row axis and does run the check.
    """
    return load_grid(inputs_dir, params, with_rows=False, with_levels=False)


def rank_candidates(candidates):
    """Best-first, with `joinable` sorting AHEAD of `matched`.

    Extracted and named so the claim is directly testable. Constructing a REAL fixture in
    which an unjoinable key out-matches a joinable one is close to impossible — both of the
    things that make a key unjoinable (a duplicate, or two blanks) also remove that key from
    `matched`, so the two counts move together. That is a happy property of the data, not a
    reason to leave the ordering unpinned: the rule has to hold for inputs the fixtures
    cannot reach, and a unit test over candidate rows can express exactly that case.

    Ties break on `key` so the order is total and stable rather than dependent on the
    dict order the engine happened to produce.
    """
    return sorted(
        candidates,
        key=lambda c: (not c.get("joinable", False), -int(c.get("matched", 0)), c["key"]),
    )


#: The `(datatype, layout)` this package emits its run-environment record as (#80).
#: Declared here because the package knows its own output type; the shared recorder
#: in `_lib` is app-core and may not name a contributed domain's vocabulary.
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")


def main():
    inputs_dir, out_dir = io_dirs()
    params = read_json(inputs_dir / "params.json", {})
    normalize = list(params.get("normalize") or [])
    # `keys` is optional: absent means "every column all sources share", which is what the
    # picker wants on first open — it has not chosen anything yet.
    keys = params.get("keys")

    sources = load_entity_sources(inputs_dir, params)
    report = engine.join_quality(
        sources, keys=list(keys) if keys else None, normalize=normalize
    )

    payload = {
        "kind": "join_quality",
        "sources": report["sources"],
        "normalize": report["normalize"],
        # Ordered best-first so a picker can render the list as it arrives. `joinable`
        # sorts FIRST, ahead of `matched`, so an unusable key can never head the list
        # however well it matches — the ordering encodes the refusal rather than leaving a
        # renderer to remember it.
        "candidates": rank_candidates(report["candidates"]),
    }
    rel = "join_quality.json"
    (out_dir / rel).write_text(json.dumps(payload, indent=2))
    entries = {
        "outputs": [{
            "id": "join-quality",
            "datatype": "data/opaque",
            "path": rel,
            "layout": "opaque",
            "role": "intermediate",
            "structure": {"encoding": "opaque", "media_type": "application/json"},
            "meta": None,
            # ── NOT HIDDEN, AND THE PREVIOUS REASONING WAS MEASURABLY FALSE ──────────
            #
            # This said: "Hidden: it is a per-form measurement, not something a user selects
            # from a picker. The FORM reads it through `job.result`, which does not require
            # the artifact to be listed anywhere."
            #
            # The second sentence is wrong. `job.result` resolves through
            # `data.artifacts.query({type})` -> `listArtifacts` -> the workstore listing, and
            # that handler ends with an UNCONDITIONAL `items.retain(|a| !a.hidden)`
            # (`workstore/data_api.rs`). There is no `include_hidden` anywhere in the server
            # or the UI - zero occurrences. So a hidden result is invisible to `job.result`.
            #
            # The consequence was total: the identifier table resolved `empty` forever, so
            # `$state.key` could never be set, so `checks.joinKeyUnset` always failed, so the
            # form's Run button was PERMANENTLY DISABLED. The feature could not be used at all.
            #
            # It survived review because the listing filter is a Rust `retain` AFTER the
            # query, so every SQL-shaped search for a hidden predicate came back empty and was
            # read as "the listing does not exclude hidden rows". A negative result from a
            # search that could not have matched is not evidence.
            #
            # `role: intermediate` is what actually expresses "not a user-facing output"; it
            # is kept, and it does not affect listing.
            "hidden": False,
        }]
    }
    # #80 — this entry DECLARES a dependency contract, so it must also record the
    # environment it resolved against. It writes its manifest inline rather than through
    # a shared `write_manifest`, which is exactly how it became the one declaring entry
    # the recording hook did not reach: the hook lives in the shared writers, and this
    # entry has none. Called explicitly here, on the same line the outputs are committed.
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(out_dir, entries["outputs"], DT_RUN_ENVIRONMENT)
    (out_dir / "manifest.json").write_text(json.dumps(entries, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
