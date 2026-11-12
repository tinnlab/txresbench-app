#!/usr/bin/env python3
# ruff: noqa
"""geneset.collection.freeze — the draftable FREEZE producer (doc 17 §E.2/§E.3, GS-INV-1/5/12).

The freeze runner (`drafts::freeze::build_freeze_producer_params`) enqueues this analysis with a
`params` bag that IS the opaque `draft.data`; the sandbox harness writes it to
`/inputs/params.json`. This reads it and mints ONE immutable `geneset/collection` artifact under
`/outputs` + the `/outputs/manifest.json` the ingest sink consumes.

`draft.data` shape (package-owned, opaque to core):
    { "name": str,
      "default_kind": "celltype-markers" | "signatures",
      "sets": [ { "name": str, "kind"?: str, "genes": [str],
                  "origin"?: str, "data_driven"?: bool, "description"?: str } ] }

The artifact is the `(gene x geneset)` MEMBERSHIP incidence, written as a CSC Zarr store
(`geneset/collection`'s top-level `chunked-sparse` layout — the only layout ingest types this
datatype against). The per-set metadata (name/description/collection + kind/origin/data_driven,
GS-INV-12) and the gene-axis ids ride in the artifact's producer-declared `structure` (the
sanctioned `structure_extra`/`stamp_txr_attributes` channel, same as DE's `de:` attrs) — a
single-store artifact carries everything the frozen view + a consumer reads without a second
store (the platform routes each store on ONE `structure.kind`; a combined membership+table store
is unsupported — see .lifecycle IMPL_NOTES). See doc 17 §E.1.

Determinism (GS-INV-1): the sets are canonicalized (trim, dedupe genes preserving first-seen
order) and the gene axis is the first-seen union, so identical `draft.data` -> byte-identical
outputs -> a stable content-hash; a different body forks a new content-addressed artifact.
Machine inferences (`data_driven`) land in the structured metadata, NEVER composed into the
human `description` (GS-INV-14).
"""
import _shared

_shared.set_prefix("geneset.collection.freeze")

import numpy as np

import txr_csc

# The membership entry's (datatype, storage-layout). `geneset/collection`'s top-level layout is
# `chunked-sparse`, so the membership CSC is the entry ingest types as `geneset/collection`.
DT_GENESET_COLLECTION = ("geneset/collection", "chunked-sparse")

DEFAULT_KINDS = ("celltype-markers", "signatures")


def _token(v):
    return str(v).strip() if v is not None else ""


def _canonical_sets(raw_sets, default_kind):
    """Trim + dedupe each set's tokens; drop nameless sets; assign a UNIQUE `geneset_id`
    (the set name, suffixed on collision). Deterministic given the input order."""
    sets = []
    used_ids = set()
    for s in raw_sets if isinstance(raw_sets, list) else []:
        if not isinstance(s, dict):
            continue
        name = _token(s.get("name"))
        if not name:
            continue  # a nameless set is dropped, never silently kept
        seen = set()
        genes = []
        for g in s.get("genes") or []:
            g = _token(g)
            if g and g not in seen:
                seen.add(g)
                genes.append(g)
        kind = _token(s.get("kind")) or default_kind
        origin = _token(s.get("origin")) or "manual"
        data_driven = bool(s.get("data_driven", False))
        # GS-INV-14: machine inferences (data_driven) go in the structured attrs, never in the
        # human description; the description is carried verbatim (empty by default).
        description = str(s.get("description") or "")
        # Assign a UNIQUE geneset_id. `used_ids` is the set of EVERY id already assigned
        # (not just first-seen base names), so a collision with an explicitly suffixed name
        # is also resolved: two sets named `foo` + a third named `foo-2` yield ids
        # [foo, foo-2, foo-3] (never a duplicate `foo-2`), keeping the geneset axis unique.
        gid = name
        n = 1
        while gid in used_ids:
            n += 1
            gid = f"{name}-{n}"
        used_ids.add(gid)
        sets.append({
            "geneset_id": gid,
            "name": name,
            "description": description,
            "kind": kind,
            "origin": origin,
            "data_driven": data_driven,
            "genes": genes,
            "n_genes": len(genes),
        })
    return sets


def main():
    inp, out = _shared.io_dirs()
    data = _shared.params(inp)
    if not isinstance(data, dict):
        _shared.fail("draft data is not an object — cannot freeze a collection")

    collection_name = _token(data.get("name")) or "Untitled collection"
    default_kind = _token(data.get("default_kind")) or DEFAULT_KINDS[0]
    if default_kind not in DEFAULT_KINDS:
        default_kind = DEFAULT_KINDS[0]

    _shared.progress("freeze", 10, "canonicalizing collection")
    sets = _canonical_sets(data.get("sets"), default_kind)

    # The gene axis: the first-seen UNION of every set's genes (deterministic).
    gene_index = {}
    genes_axis = []
    for s in sets:
        for g in s["genes"]:
            if g not in gene_index:
                gene_index[g] = len(genes_axis)
                genes_axis.append(g)
    n_gene = len(genes_axis)
    n_set = len(sets)

    _shared.progress("freeze", 55, f"building {n_set} sets x {n_gene} genes membership")
    # Dense (gene x geneset) incidence — small by construction (a curated collection). The
    # writer transposes row-major -> CSC (a geneset column is contiguous, matching the datatype).
    mat = np.zeros((n_gene, n_set), dtype=np.float32)
    for j, s in enumerate(sets):
        for g in s["genes"]:
            mat[gene_index[g], j] = 1.0

    structure_extra = {
        "collection": collection_name,
        "default_kind": default_kind,
        "genes": genes_axis,
        "geneset_ids": [s["geneset_id"] for s in sets],
        # The per-set metadata record (GS-INV-12) the frozen view + doc-14 read off the artifact.
        "sets": sets,
        "provenance": {"produced_by": "geneset.collection.freeze"},
    }

    _shared.progress("freeze", 80, "writing membership store")
    structure = txr_csc.write_csc_zarr(
        txr_csc.ArraySource(mat),
        out / "membership.zarr",
        axes=("gene", "geneset"),
        structure_extra=structure_extra,
    )

    entry = _shared.output_entry(
        "collection",
        DT_GENESET_COLLECTION,
        "membership.zarr",
        "artifact",
        structure=structure,
        meta={
            "name": collection_name,
            "n_sets": n_set,
            "n_genes": n_gene,
            "produced_by": "geneset.collection.freeze",
        },
    )
    _shared.write_manifest(out, [entry])
    _shared.progress("freeze", 100, "frozen")
    print(
        f"geneset.collection.freeze: minted geneset/collection ({n_set} sets, {n_gene} genes)",
        flush=True,
    )


if __name__ == "__main__":
    main()
