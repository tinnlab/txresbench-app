#!/usr/bin/env python3
# ruff: noqa
"""`write_csc_zarr(structure_extra=…)` — the caller-named declaration channel, and the one
thing it may NOT do.

## Why the channel exists

A `structure` key is the only producer declaration that travels with the BYTES. The
manifest row's `meta` is a catalog column; a sandboxed consumer holding nothing but a
staged store reads `<store>/zarr.json` → `attributes.cyto`. So a producer with a fact a
downstream job must read has exactly one place to put it, and this is the parameter that
puts it there.

## Why it is constrained in one direction

`_WRITER_OWNED_STRUCTURE_KEYS` is the decode contract the bytes were written against. A
caller able to overwrite one would be re-declaring the layout of bytes it did not write —
`shape`, `nnz`, a member's `path` — and the conformance gate would then be comparing the
bytes against a claim the writer never made. That is the same producer-chooses-how-hard-
the-gate-looks shape `conformance.py` retired three times over, so it is refused at the
writer instead of being discovered downstream.

Both halves are asserted, because only asserting the refusal would pass over a parameter
that does nothing at all, and only asserting the merge would pass over a missing guard.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import cyto_csc


def _write(tmp_path, **kw):
    """A real write through the module's OWN source adapter — no re-implementation of the
    source protocol here, so this suite cannot pass against a stub that has drifted."""
    out = Path(tmp_path) / "store"
    src = cyto_csc.ArraySource(np.array([[1.0, 0.0, 2.0], [0.0, 3.0, 0.0]], dtype=np.float32))
    return src, out, cyto_csc.write_csc_zarr(src, out, axes=("rows", "cols"), **kw)


def _stamped(out: Path):
    doc = json.loads((out / "zarr.json").read_text())
    return (doc.get("attributes") or {}).get("cyto")


def test_a_caller_named_key_reaches_BOTH_copies_of_the_declaration(tmp_path):
    """The merge happens before the stamp, so the row and the store agree — which is the
    equality `conformance._conform_group_attributes` refuses to see broken."""
    _src, out, structure = _write(tmp_path, structure_extra={"modality": "prot"})
    assert structure["modality"] == "prot"
    assert _stamped(out) == structure, "the returned structure and the group stamp diverged"


def test_omitting_it_changes_NOTHING(tmp_path):
    """The negative control: the parameter is additive, so a caller that does not use it
    gets byte-identical output to before it existed."""
    _src, out, structure = _write(tmp_path)
    assert "modality" not in structure
    assert _stamped(out) == structure
    assert set(structure) == {
        "encoding", "kind", "axes", "shape", "nnz", "indptr", "indices", "data",
    }


@pytest.mark.parametrize(
    "key, value",
    [
        ("shape", [99, 99]),          # the matrix's dimensions
        ("nnz", 0),                   # how many values the bytes hold
        ("encoding", "opaque"),       # which arm of the gate reads it AT ALL
        ("kind", "table"),            # which decoder a consumer picks
        ("indptr", {"path": "nope"}), # where a member's bytes are
    ],
)
def test_a_writer_owned_key_is_REFUSED_rather_than_silently_won(tmp_path, key, value):
    """Each of these would make the artifact lie about bytes the caller did not write.
    `encoding: opaque` is the sharpest: it routes the gate to the arm that checks no member
    structure, i.e. it is an opt-out spelled as a declaration — the exact shape
    `conformance.py`'s header records as the knob it had to close."""
    with pytest.raises(ValueError) as exc:
        _write(tmp_path, structure_extra={key: value})
    assert key in str(exc.value)


def test_the_refusal_names_EVERY_offending_key_at_once(tmp_path):
    """One report per call, not one per fix round."""
    with pytest.raises(ValueError) as exc:
        _write(tmp_path, structure_extra={"nnz": 0, "shape": [1, 1], "modality": "rna"})
    message = str(exc.value)
    assert "nnz" in message and "shape" in message
    # …and it does not accuse the legitimate key that shared the call.
    assert "'modality'" not in message
