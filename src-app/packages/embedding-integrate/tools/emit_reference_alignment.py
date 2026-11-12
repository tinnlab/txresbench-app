#!/usr/bin/env python3
# ruff: noqa
"""Emit a REAL alignment artifact, for a consumer's cross-seam test.

    python3 emit_reference_alignment.py <output-dir> [--mode strict|authority]
                                                     [--authority ds-b]

Writes `<output-dir>/alignment.zarr`, `<output-dir>/alignment_summary.json` and
`<output-dir>/manifest.json`.

## Why this exists rather than a checked-in fixture

A consumer testing against a fixture SOMEONE ELSE HAND-BUILT in the producer's dialect is
testing its own reading of that dialect, not the format. Both sides then agree with
themselves and stay green while the seam is broken — which is exactly what happened here:
the reader's recipe parser expected a single source with one row-vector artifact, the
producer emits segments over N datasets, every test on both sides passed, and nothing ever
put one side's output in front of the other's input.

So this script does NOT construct an artifact. It stages two real source datasets with the
real `txr_zarr.Table` writer, then **invokes `compute/embedding_integrate.py` as a
subprocess**, exactly as the sandbox runner does. What lands in `<output-dir>` is whatever
the producer actually writes today; if the producer changes, this changes with it, and a
consumer pinned to the old shape goes red — which is the point.

## The vocabulary is DELIBERATELY DOMAIN-FREE

`code` / `alias` / `row_key` / `group` / `g1..g4` — not `symbol` / `ensembl_id` / `barcode` /
`celltype` / `T,B,NK,Mono`.

`embedding-integrate` is a single-cell package and is entitled to domain vocabulary in its
own tree (its test suite still uses it). **This file is the exception, because what it emits
does not stay in this tree**: the reference artifacts are consumed by core's `zarrReader`
parity tests and live under `ui/src/core/workstore/__fixtures__/`, where core's
domain-freedom rule applies and `lint-no-domain-in-builtin` scans them. A consumer cannot
fix that by editing the fixture — regenerating restores whatever this emitter writes — so
the vocabulary has to be neutral HERE.

That is also the honest shape for a reference fixture: the alignment engine is domain-free by
construction (`ALIGNMENT_AXIS = "unified_entities"`, and the engine "never knows which" axis
it aligned), so a reference artifact demonstrating the FORMAT has no business asserting a
domain either.

**Renaming must not collapse a distinction this fixture exists to demonstrate**, and the
label choice below is constrained by three of them at once — see `SOURCES`. `check_fixture`
re-derives all three from the emitted bytes on every run rather than trusting that a future
rename preserved them.

## The fixture it emits

Two datasets, chosen so the output is not degenerate:

* entity axis `code` = A, B, C shared; `C` carries a DIFFERENT `alias` per source, so it is a
  CONFLICTING pair — under the default `strict` it is dropped, under `authority` it is kept
  and labelled from the named dataset. A consumer that never sees a conflict cannot tell the
  two modes apart.
* row counts DIFFER (2 and 3), so an off-by-one in segment arithmetic is visible.
* declared **ds-b first**, while the segment ARRAY serialises sorted by dataset id — so
  array order and `declared_order` DISAGREE. A consumer that iterates the array instead of
  sorting on `declared_order` gets the wrong ranges, and therefore the wrong DATASET.

**The default used to declare `ds-a` first, which sorts first too — so the two orders
AGREED and the reference artifact was the exact accidental-rightness trap it claims to
avoid.** A consumer pinning against it could iterate the array, be wrong, and pass. That is
not hypothetical: a reader shipped exactly that defect, and it survived review because its
own seam fixture also had ds-a declared first and sorting first. A reference fixture whose
orderings coincide is that blind spot at its source, so the disagreeing case is now the
DEFAULT rather than an opt-in flag.

Pass `--agreeing` for the degenerate case (ds-a declared first) if you specifically want to
check behaviour when the two orders coincide. Do not use it as a general fixture.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGES = HERE.parents[1]
PRODUCER = HERE.parent / "compute" / "embedding_integrate.py"

SOURCES = [
    ("ds-a", {
        "codes": ["A", "B", "C"],
        "alias": ["E1", "E2", "E3"],
        "rows": ["a-0", "a-1"],
        # ── THESE LABELS CARRY TWO PROPERTIES AT ONCE. Do not "tidy" them. ──────
        #
        # 1. MUTUAL EXCLUSIVITY. `g1` is ds-a's alone and `g3`/`g4` are ds-b's alone, so
        #    NEITHER source's vocabulary contains the other's. That is what makes
        #    `authority` drop a level whichever dataset is named, and therefore what makes
        #    the `-1` absence code reachable from a reference artifact at all.
        #
        #    It was once `["T", "B"]`, a strict SUBSET of ds-b's levels, so naming ds-b as
        #    the authority dropped nothing and the emitted lookups contained no `-1`. Two
        #    stages implement that sentinel; a reference fixture that cannot produce it
        #    leaves both of them testing a value no artifact carries.
        #
        # 2. DECLARED ORDER ≠ OBSERVATION ORDER. Stored categorical codes index the SORTED
        #    level set (pandas' order), while observation gives first-appearance order. Here
        #    `["g2", "g1"]` is observed but `["g1", "g2"]` is stored, so the two differ and
        #    the producer's declared-code-space branch is actually exercised. A rename to
        #    ascending labels would silently make them coincide — which is exactly what the
        #    domain→neutral rename could have done had the labels been picked carelessly
        #    (`T→g1, Mono→g2` reads fine and destroys the property).
        #
        # `check_fixture` re-derives BOTH from the emitted bytes, so a future rename that
        # breaks either one exits non-zero instead of shipping a degenerate reference.
        "groups": ["g2", "g1"],
    }),
    ("ds-b", {
        "codes": ["A", "B", "C"],
        # C disagrees — the conflicting pair.
        "alias": ["E1", "E2", "E7"],
        "rows": ["b-0", "b-1", "b-2"],
        "groups": ["g3", "g4", "g2"],
    }),
]

#: A THREE-source fixture, and the reason it exists is a coincidence TWO sources cannot
#: escape (raised by stage 2 as the sixth instance of the class).
#:
#: MEASURED FIRST, because the request as posed was not constructible. `meta.sources` order,
#: `params.dataset_ids` order, each segment's `source_index` and its `declared_order` are
#: **one permutation by construction** — `load_grid` builds the sources list by enumerating
#: the relayed ids, `alignment_metadata` projects `meta.sources` from that same list, and
#: `build_segments` takes BOTH `source_index` and `declared_order` from `enumerate(sources)`
#: with one segment per source. No fixture can make them disagree without breaking the
#: producer, so a fourth fixture asserting they differ would have been asserting a fiction.
#:
#: What IS a real degeneracy, and what this fixture fixes: with two sources the segment
#: permutation is `[1, 0]`, which is **its own inverse**. A consumer that inverts the
#: mapping — reads `segment_dataset` as "source i's segment is at position i" rather than
#: "the segment at position i belongs to source `segment_dataset[i]`" — is wrong, and
#: passes against every two-source fixture in this tool. Three sources with a non-involutive
#: permutation is the smallest arrangement that can tell those two readings apart.
#:
#: `--three-sources` emits it; exit 6 refuses it if the permutation ever becomes self-inverse.
SOURCES3 = [
    ("ds-a", {"codes": ["A", "B", "C"], "alias": ["E1", "E2", "E3"],
              "rows": ["a-0", "a-1"], "groups": ["g2", "g1"]}),
    ("ds-b", {"codes": ["A", "B", "C"], "alias": ["E1", "E2", "E7"],
              "rows": ["b-0", "b-1", "b-2"], "groups": ["g3", "g4", "g2"]}),
    ("ds-c", {"codes": ["A", "B", "C"], "alias": ["E1", "E2", "E3"],
              "rows": ["c-0"], "groups": ["g1"]}),
]


def stage(inputs_dir, sources):
    """Write the sources AND the REAL `/inputs` wire.

    `{slot, kind, content_hash, sandbox_path}` (`InputsJsonEntry`, `inputs.rs:63-69`) —
    there is no `dataset_id` field on the wire, and an earlier version invented one.

    **ONE ARTIFACT PER COLUMN**, written through `txr_columns.write_metadata_column` — the
    function INGEST uses. A real `metadata-column` store has a single member always called
    `values` and carries its display name nowhere, so the grid's coordinates ride the SLOT
    NAMES (`entity:<i>:<col>`, `level:<i>:<col>`); `rows` is one ordinary slot with one
    binding per dataset, in order. The previous shape — one mount holding `entities.zarr` +
    `rows.zarr` — is one no artifact can present and no runner can stage.

    **Mount names are deliberately NOT dataset ids.** The runner derives a mount from the
    SLOT and the encoding and disambiguates positionally. Naming them after datasets — which
    this fixture used to do — makes `dataset_id == basename(sandbox_path)`, so a consumer
    reading the mount name and one reading the relayed id are INDISTINGUISHABLE against it.
    That coincidence is why a producer reading the wrong channel survived four audit rounds.

    Returns `(index, dataset_ids, content_hashes)` for the caller's params.
    """
    sys.path[:0] = [str(PACKAGES / "_lib"), str(PACKAGES / "_helpers")]
    import txr_columns
    import pandas as pd

    index, used = {"inputs": []}, set()
    dataset_ids, hashes = [], {}

    def bind(slot, name, series, *, axis, holds_axis_keys=False, aligned_to=None,
             content_hash):
        stem = "".join(c if (c.isascii() and (c.isalnum() or c in "._-")) else "_"
                       for c in slot.strip()).lstrip(".")[:100]
        mount = f"{stem}.zarr"
        if mount in used:
            n = 1
            while f"{stem}_{n}.zarr" in used:
                n += 1
            mount = f"{stem}_{n}.zarr"
        used.add(mount)
        txr_columns.write_metadata_column(
            inputs_dir, mount, name, pd.Series(series), axis=axis,
            holds_axis_keys=holds_axis_keys, aligned_to=aligned_to)
        index["inputs"].append({
            "slot": slot,
            "kind": "artifact",
            "content_hash": content_hash,
            "sandbox_path": f"/inputs/{mount}",
        })
        # SELF-CHECK: the fixture must never drift back into degeneracy.
        if mount.removesuffix(".zarr") in dataset_ids or mount in dataset_ids:
            sys.stderr.write(
                f"mount {mount!r} equals a dataset id — a consumer reading the mount name "
                "is then indistinguishable from one reading the relayed id, and this "
                "fixture cannot detect a producer reading the wrong channel.\n"
            )
            raise SystemExit(4)

    for position, (dataset_id, spec) in enumerate(sources):
        dataset_ids.append(dataset_id)
        entity_digest = txr_columns.axis_key_digest(pd.Series(spec["codes"]))
        bind(f"entity:{position}:code", "code", spec["codes"], axis="entities",
             holds_axis_keys=True, content_hash=f"sha256:{dataset_id}-code")
        if spec.get("alias") is not None:
            bind(f"entity:{position}:alias", "alias", spec["alias"],
                 axis="entities", aligned_to=entity_digest,
                 content_hash=f"sha256:{dataset_id}-alias")
        rows_hash = f"sha256:{dataset_id}-rows"
        bind("rows", "row_key", spec["rows"], axis="rows", holds_axis_keys=True,
             content_hash=rows_hash)
        hashes[dataset_id] = rows_hash
        row_digest = txr_columns.axis_key_digest(pd.Series(spec["rows"]))
        # `dtype="category"` so the levels are stored SORTED (pandas' own order), which is
        # what makes the declared code space differ from observation order — the property
        # `--preflight`'s exit-3 self-check verifies rather than assumes.
        bind(f"level:{position}:group", "group",
             pd.Series(spec["groups"], dtype="category"), axis="rows",
             aligned_to=row_digest, content_hash=f"sha256:{dataset_id}-group")

    (inputs_dir / "inputs.json").write_text(json.dumps(index, indent=2))
    return index, dataset_ids, hashes


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out", type=Path)
    ap.add_argument("--mode", choices=("strict", "authority"), default="strict")
    ap.add_argument("--authority", default=None)
    ap.add_argument(
        "--agreeing", action="store_true",
        help="declare ds-a first, so array order and declared_order COINCIDE. The "
             "degenerate case: a consumer that ignores declared_order passes against it.",
    )
    ap.add_argument(
        "--three-sources", action="store_true",
        help="emit the THREE-source fixture whose segment permutation is not its own "
             "inverse — the case two sources cannot express (see SOURCES3).",
    )
    ap.add_argument(
        "--preflight", action="store_true",
        help="also emit join_quality.json from the REAL preflight, over a fixture whose "
             "`sources` OUTNUMBER its `candidates` — the asymmetric case a consumer that "
             "zips array-valued keys into one table decodes as null rows.",
    )
    args = ap.parse_args()

    out = args.out.resolve()
    inputs = out / "inputs"
    outputs = out / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)

    # DISAGREEING by default — see the module docstring.
    if args.three_sources:
        # Declared c, a, b — so the segment permutation (sorted by dataset id) is a
        # 3-cycle rather than a swap, and therefore differs from its own inverse.
        sources = [SOURCES3[2], SOURCES3[0], SOURCES3[1]]
    else:
        sources = SOURCES if args.agreeing else list(reversed(SOURCES))
    _index, dataset_ids, hashes = stage(inputs, sources)
    # No `level_columns`: the fused set IS the bound `level:` slots.
    params = {"key": "code", "mode": args.mode,
              "dataset_ids": dataset_ids, "dataset_content_hashes": hashes}
    if args.authority:
        params["authority"] = args.authority
    (inputs / "params.json").write_text(json.dumps(params, indent=2))

    env = dict(os.environ)
    env["TXR_INPUTS_DIR"] = str(inputs)
    env["TXR_OUTPUTS_DIR"] = str(outputs)
    env["PYTHONPATH"] = os.pathsep.join([
        str(PACKAGES / "_helpers"), str(PACKAGES / "_lib"), env.get("PYTHONPATH", "")
    ])
    # THE REAL PRODUCER, as a subprocess — not an import, and not a reconstruction.
    proc = subprocess.run([sys.executable, str(PRODUCER)], env=env,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        return proc.returncode

    if args.preflight:
        # A SEPARATE fixture, deliberately: the two sources here share exactly ONE candidate
        # key, so `sources` (2) outnumbers `candidates` (1). A fixture whose lengths happen
        # to match decodes correctly under a reader that zips every array-valued key into
        # one table, and would pass against exactly the bug this is for.
        pf_in = out / "preflight-inputs"
        pf_out = out / "preflight-outputs"
        pf_in.mkdir(parents=True, exist_ok=True)
        pf_out.mkdir(parents=True, exist_ok=True)
        _pf_index, pf_ids, pf_hashes = stage(pf_in, [
            ("ds-a", {"codes": ["A", "B", "C"], "alias": ["E1", "E2", "E3"],
                      "rows": ["a-0"], "groups": ["g2"]}),
            # `ensembl_id` is ABSENT here, so `symbol` is the only SHARED column and the
            # candidate list has one entry against two sources.
            ("ds-b", {"codes": ["A", "B", "C"], "alias": None,
                      "rows": ["b-0"], "groups": ["g2"]}),
        ])
        (pf_in / "params.json").write_text(json.dumps(
            {"dataset_ids": pf_ids, "dataset_content_hashes": pf_hashes}, indent=2))
        pf_env = dict(env)
        pf_env["TXR_INPUTS_DIR"] = str(pf_in)
        pf_env["TXR_OUTPUTS_DIR"] = str(pf_out)
        pf_env["PYTHONPATH"] = os.pathsep.join(
            [str(HERE.parent / "compute"), pf_env["PYTHONPATH"]]
        )
        pf = subprocess.run(
            [sys.executable, str(HERE.parent / "compute" / "join_quality_preflight.py")],
            env=pf_env, capture_output=True, text=True,
        )
        if pf.returncode != 0:
            sys.stderr.write(pf.stdout + pf.stderr)
            return pf.returncode
        payload = json.loads((pf_out / "join_quality.json").read_text())
        print(f"wrote {pf_out}/join_quality.json  "
              f"(sources={len(payload['sources'])}, candidates={len(payload['candidates'])})")

    manifest = json.loads((outputs / "manifest.json").read_text())

    # SELF-CHECK: the artifact must actually have the property this tool documents. The
    # previous default did not, and nothing noticed because nothing executed the tool.
    if args.mode == "authority":
        # SELF-CHECK: an authority artifact must actually EXERCISE the absence code, or it
        # is a reference for a contract value it cannot carry.
        sys.path[:0] = [str(PACKAGES / "_lib")]
        import txr_zarr_read as _r

        root = outputs / "alignment.zarr"
        # SINCE C4 the absence code is the vocabulary's DECLARED absence label, not `-1`.
        # This check kept its PURPOSE — a reference artifact must actually exercise the
        # absence path — and changed what it looks for. Looking for a negative code would
        # now be looking for a value the producer can no longer emit, which is a self-check
        # that can never pass rather than one that guards anything.
        attrs = json.loads((root / "zarr.json").read_text())["attributes"]["txr_alignment"]
        missing = {c: lv for c, lv in attrs["missing_levels"].items() if lv is not None}
        if not missing:
            sys.stderr.write(
                "emitted an --authority artifact that declares NO missing level: the named "
                "authority's vocabulary already covers every other source's levels, so "
                "nothing was dropped. A consumer pinning against this cannot exercise the "
                "absence path it is required to implement.\n"
            )
            return 3
        absent_codes = {c: attrs["unified_levels"][c].index(lv) for c, lv in missing.items()}
        used = [
            code
            for member in _r.structure(root)["aux"]
            if member["role"] == "alignment_level_lookup"
            for code in _r.read_array(root, member["path"]).tolist()
            if code in absent_codes.values()
        ]
        if not used:
            sys.stderr.write(
                f"a missing level is DECLARED {missing} but no stored lookup maps any source "
                "code to it, so the absence path is unreachable from this artifact.\n"
            )
            return 3
        negatives = [
            code
            for member in _r.structure(root)["aux"]
            if member["role"] == "alignment_level_lookup"
            for code in _r.read_array(root, member["path"]).tolist()
            if code < 0
        ]
        if negatives:
            sys.stderr.write(
                f"a stored lookup contains a NEGATIVE code {sorted(set(negatives))}. Since "
                "C4 every code is an in-range index into the unified vocabulary; a negative "
                "one is refused by the serve path with a 400 for the entire column.\n"
            )
            return 3

    if not args.agreeing:
        sys.path[:0] = [str(PACKAGES / "_lib")]
        import txr_zarr_read

        root = outputs / "alignment.zarr"
        order = txr_zarr_read.read_array(root, "segment_order").tolist()
        start = txr_zarr_read.read_array(root, "segment_start").tolist()
        if order == sorted(order) or start == sorted(start):
            sys.stderr.write(
                f"emitted a reference artifact whose segment_order={order} and "
                f"segment_start={start} are ASCENDING across the array — array order and "
                "declared_order agree, so a consumer that iterates the array instead of "
                "sorting on declared_order passes against this fixture. That is the trap "
                "this tool exists to avoid.\n"
            )
            return 2

    # SELF-CHECK 5 — the DECLARED-vs-OBSERVED level order, from the emitted bytes.
    #
    # New with the domain→neutral rename, and the rename is exactly why it exists: the old
    # labels (`T`/`Mono`) happened to sort differently from their observation order, so the
    # property held by luck. A neutral rename can destroy it without touching a line of
    # logic — `T→g1, Mono→g2` reads perfectly and makes stored order == observed order,
    # after which the producer's declared-code-space branch is untested and the reference
    # artifact cannot demonstrate it. Derived from the STORE, not from `SOURCES`, so it
    # cannot be satisfied by a list that no longer describes what was written.
    sys.path[:0] = [str(PACKAGES / "_lib")]
    import txr_zarr_read as _rr

    declared = json.loads(
        (outputs / "alignment.zarr" / "zarr.json").read_text()
    )["attributes"]["txr_alignment"]["unified_levels"]
    staged_orders = []
    for entry in json.loads((inputs / "inputs.json").read_text())["inputs"]:
        if not entry["slot"].startswith("level:"):
            continue
        store = inputs / Path(entry["sandbox_path"]).name
        staged_orders.append(
            list(_rr.read_meta(store, "values")["attributes"]["txr"]["levels"])
        )
    if not staged_orders:
        sys.stderr.write("no `level:` binding was staged — nothing declares a code space.\n")
        return 5
    observed = [list(dict.fromkeys(spec["groups"])) for _id, spec in sources]
    if all(stored == obs for stored, obs in zip(staged_orders, observed)):
        sys.stderr.write(
            f"every source STORED its levels in observation order (stored={staged_orders}, "
            f"observed={observed}) — the declared-code-space branch is not exercised, so a "
            "consumer pinning against this fixture cannot tell a producer that honours the "
            "declared order from one that infers it from the labels it saw.\n"
        )
        return 5
    if not declared:
        sys.stderr.write("the emitted artifact declares no unified level vocabulary.\n")
        return 5

    # SELF-CHECK 6 — the segment permutation must not be its OWN INVERSE.
    #
    # Raised by stage 2 (the sixth instance of the coincidence class). With two sources the
    # permutation is [1, 0], which is involutive: a consumer that inverts the mapping reads
    # every segment's dataset correctly anyway, so no two-source fixture can distinguish the
    # right reading from the inverted one. `--three-sources` exists to break that, and this
    # refuses the fixture if a future edit ever makes it self-inverse again.
    #
    # Derived from the emitted BYTES, not from SOURCES3, so a change to the declaration
    # order cannot satisfy it while the artifact says otherwise.
    if args.three_sources:
        seg_dataset = _rr.read_array(outputs / "alignment.zarr", "segment_dataset").tolist()
        perm = [int(x) for x in seg_dataset]
        if sorted(perm) != list(range(len(perm))):
            sys.stderr.write(f"segment_dataset {perm} is not a permutation of its sources.\n")
            return 6
        inverse = [perm.index(i) for i in range(len(perm))]
        if perm == inverse:
            sys.stderr.write(
                f"the segment permutation {perm} is its OWN INVERSE, so a consumer that "
                "inverts the segment->source mapping passes against this fixture — which is "
                "the degeneracy --three-sources exists to remove.\n"
            )
            return 6

    print(f"wrote {outputs}")
    for entry in manifest["outputs"]:
        print(f"  {entry['id']:20s} {entry['datatype']:20s} {entry['path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
