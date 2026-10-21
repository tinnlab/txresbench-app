# ruff: noqa
"""Stage arbitrary datasets and invoke the REAL alignment producer — for CHAIN fixtures.

    python3 stage_and_align.py <out-dir> <spec.json>

`emit_reference_alignment.py` emits one alignment over datasets it hardcodes. A CHAIN needs a
SECOND alignment whose source is the FIRST one's gathered output, and no combination of the
reference emitter's flags can express that: its `SOURCES` are fixed, so no source of any
fixture it emits has the row count of any other fixture's output.

So this script takes the datasets as DATA. What it does not do is construct an artifact — like
the reference emitter, it stages real `cyto_columns` stores and runs
`compute/embedding_integrate.py` as a subprocess. The alignment in `<out-dir>/outputs` is
whatever the producer actually writes today.

**The row values come from the Rust gather, never from Python.** The caller
(`gathered_chain_test.rs`) resolves level *k*'s gathered column through the production
`gather_exec::resolve` and passes the decoded values in `spec.json`. Recomputing them here
would make the fixture agree with itself: a chain test whose intermediate was produced by the
test would pass against a gather that ignored the alignment entirely.

## spec.json

```json
{
  "mode": "strict",
  "datasets": [
    {"dataset_id": "ds-v", "codes": ["A","B"], "alias": ["E1","E2"],
     "rows": ["b-0","b-1"], "groups": ["g3","g4"], "levels": ["g2","g3","g4","g1"]}
  ]
}
```

`levels` is OPTIONAL and is the column's declared category order. Omit it and pandas sorts,
which is right for an ordinary source and WRONG for one staged from a gathered column — see
the comment at the `bind` for `level:<i>:group`.

`datasets` is emitted in the order given — which is the DECLARED order, and the segment array
serialises sorted by dataset id, so a caller wanting the two to disagree declares them out of
sorted order. That is the reference emitter's own default and the property its module docstring
exists to protect; a chain fixture that lost it would be the degenerate case one level up.

Prints the staged `key_sequence_digest` per dataset to stdout as JSON, because the consumer
needs to know what the producer pinned without re-deriving the digest on the other side.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# <repo>/src-app/server/tests/fixtures/chain -> <repo>/src-app/packages
PACKAGES = HERE.parents[3] / "packages"
PRODUCER = PACKAGES / "embedding-integrate" / "compute" / "embedding_integrate.py"


def stage(inputs_dir, datasets):
    """The reference emitter's `stage()`, over caller-supplied datasets.

    Deliberately the same shape: one artifact per column through
    `cyto_columns.write_metadata_column` (the function INGEST uses), mount names derived from
    the SLOT and never equal to a dataset id, and the real `/inputs` wire
    (`{slot, kind, content_hash, sandbox_path}`) with no `dataset_id` field.
    """
    sys.path[:0] = [str(PACKAGES / "_lib"), str(PACKAGES / "_helpers")]
    import cyto_columns
    import pandas as pd

    index, used = {"inputs": []}, set()
    dataset_ids, hashes, digests = [], {}, {}

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
        cyto_columns.write_metadata_column(
            inputs_dir, mount, name, pd.Series(series), axis=axis,
            holds_axis_keys=holds_axis_keys, aligned_to=aligned_to)
        index["inputs"].append({
            "slot": slot, "kind": "artifact",
            "content_hash": content_hash, "sandbox_path": f"/inputs/{mount}",
        })
        # The reference emitter's own degeneracy self-check, carried over: a mount equal to a
        # dataset id makes a consumer reading the mount name indistinguishable from one
        # reading the relayed id.
        if mount.removesuffix(".zarr") in dataset_ids or mount in dataset_ids:
            sys.stderr.write(f"mount {mount!r} equals a dataset id\n")
            raise SystemExit(4)

    for position, spec in enumerate(datasets):
        dataset_id = spec["dataset_id"]
        dataset_ids.append(dataset_id)
        entity_digest = cyto_columns.axis_key_digest(pd.Series(spec["codes"]))
        bind(f"entity:{position}:code", "code", spec["codes"], axis="entities",
             holds_axis_keys=True, content_hash=f"sha256:{dataset_id}-code")
        bind(f"entity:{position}:alias", "alias", spec["alias"], axis="entities",
             aligned_to=entity_digest, content_hash=f"sha256:{dataset_id}-alias")
        rows_hash = f"sha256:{dataset_id}-rows"
        bind("rows", "row_key", spec["rows"], axis="rows", holds_axis_keys=True,
             content_hash=rows_hash)
        hashes[dataset_id] = rows_hash
        row_digest = cyto_columns.axis_key_digest(pd.Series(spec["rows"]))
        digests[dataset_id] = row_digest
        # ── THE VOCABULARY IS DECLARED, NEVER RE-DERIVED (measured, not reasoned) ──
        #
        # `pd.Series(labels, dtype="category")` invents a category order — pandas SORTS.
        # For a dataset staged from a GATHERED column that is wrong, and wrong in the way
        # that reads as right: level 1 serves its codes in ITS unified order (for the
        # reference chain that is `["g2","g3","g4","g1"]`, the union in declared-source
        # order), so a fixture that let pandas re-sort them to `["g1","g2","g3","g4"]`
        # emits a lookup computed against a code space the bytes are not in. Every count
        # matches, every code is in range, and every label is off by one position.
        #
        # Observed exactly that before this branch existed: the 3-deep chain test returned
        # `[g2,g3,g1,g1,g4,g1]` where `[g3,g4,g2,g2,g1,g1]` was due. So `levels` is part of
        # the spec, and a caller staging a gathered column passes the vocabulary that column
        # actually serves.
        groups = spec["groups"]
        if spec.get("levels") is not None:
            missing = sorted(set(groups) - set(spec["levels"]))
            if missing:
                sys.stderr.write(
                    f"{dataset_id}: labels {missing} are outside the declared vocabulary "
                    f"{spec['levels']} — a category the code space cannot express\n")
                raise SystemExit(5)
            groups = pd.Categorical(groups, categories=spec["levels"])
        else:
            groups = pd.Series(groups, dtype="category")
        bind(f"level:{position}:group", "group", pd.Series(groups), axis="rows",
             aligned_to=row_digest, content_hash=f"sha256:{dataset_id}-group")

    (inputs_dir / "inputs.json").write_text(json.dumps(index, indent=2))
    return dataset_ids, hashes, digests


def main():
    if len(sys.argv) != 3:
        sys.stderr.write(__doc__)
        return 2
    out = Path(sys.argv[1]).resolve()
    spec = json.loads(Path(sys.argv[2]).read_text())

    inputs, outputs = out / "inputs", out / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)

    dataset_ids, hashes, digests = stage(inputs, spec["datasets"])
    params = {"key": "code", "mode": spec.get("mode", "strict"),
              "dataset_ids": dataset_ids, "dataset_content_hashes": hashes}
    if spec.get("authority"):
        params["authority"] = spec["authority"]
    (inputs / "params.json").write_text(json.dumps(params, indent=2))

    env = dict(os.environ)
    env["CYTO_INPUTS_DIR"] = str(inputs)
    env["CYTO_OUTPUTS_DIR"] = str(outputs)
    env["PYTHONPATH"] = os.pathsep.join([
        str(PACKAGES / "_helpers"), str(PACKAGES / "_lib"), env.get("PYTHONPATH", "")])
    # THE REAL PRODUCER, as a subprocess — not an import, and not a reconstruction.
    proc = subprocess.run([sys.executable, str(PRODUCER)], env=env,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        return proc.returncode
    print(json.dumps({"key_sequence_digests": digests}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
