#!/usr/bin/env python3
# ruff: noqa
"""The vendored write-time contract: byte-identical, and actually ENFORCING.

`compute/spatial_declarations.py` is a VERBATIM copy of `spatial-types`' module. The
platform confines `run.helpers` to a package's own tree, so vendoring is the idiom rather
than an exception — but a vendored file that drifts is a second implementation wearing the
first one's name, and every rule the original states would then be enforced in one place
and not the other with nothing saying so.

#155 note — this file also carries `spatial-image-space`'s **TEST-16**. The byte-identity
assertion below is what holds the `image_meta()` / `encode_placement()` addition honest:
that contract was added to `spatial-types` and re-vendored here, and #211's own record
names this byte-identity constraint as the reason #154 could NOT change the shared
contract unilaterally. (TEST ids are a per-feature namespace and #154's TEST-16 is a
different test in this same directory — this line is #155's citation, deliberately
explicit so the two are not confused.)
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

SOURCE_OF_TRUTH = (
    VF.PKG.parent / "spatial-types" / "compute" / "spatial_declarations.py"
)
VENDORED = VF.PKG / "compute" / "spatial_declarations.py"


def test_the_vendored_module_is_byte_identical_to_its_source_of_truth():
    """TEST-12 — the whole justification for vendoring rests on this.

    Compared as BYTES, not as behaviour: a behavioural comparison would pass for a copy
    that had drifted in a comment, a refusal message or a docstring — and those are where
    this module's rules actually live, since a producer reads them to know what it may
    declare.
    """
    assert SOURCE_OF_TRUTH.exists(), (
        "the source of truth is gone; a vendored copy with nothing to compare against is "
        "just a fork"
    )
    assert VENDORED.read_bytes() == SOURCE_OF_TRUTH.read_bytes(), (
        "the vendored copy has drifted from `spatial-types/compute/"
        "spatial_declarations.py`. Re-copy it; do not edit it here."
    )


def test_the_importer_resolves_the_vendored_copy_and_not_the_original():
    """The staging the manifest declares, exercised.

    `run.helpers` stages the copy BESIDE the entry. If the suite resolved
    `spatial_declarations` to `spatial-types`' original instead, every assertion below
    would be about a module this package does not ship.
    """
    module = VF.load_compute()
    assert Path(module.SD.__file__).resolve() == VENDORED.resolve()


# ── TEST-3: the always-2-D writer rule ───────────────────────────────────────────────


@pytest.mark.parametrize("n_components", [1, 3, 4])
def test_the_writer_refuses_anything_but_two_components(tmp_path, n_components):
    """TEST-3 [acceptance] [invariant: INV-3] — a producer ALWAYS emits (n x 2).

    Enforced at WRITE time because the alternative is not an error: the shipped
    Coordinates section selects on `dims: 2` by exact equality and FAILS CLOSED, so an
    (n x 3) artifact would be silently invisible in the UI with every gate green.

    Driven through the importer's OWN `SD` handle rather than through a separately
    imported library, so it is the module this package actually ships that is being
    tested.
    """
    module = VF.load_compute()
    SD = module.SD
    dest = tmp_path / "coords.zarr"
    arr = np.zeros((7, n_components), dtype=np.float32)
    with pytest.raises(SD.SpatialDeclarationError) as exc:
        SD.write_spatial_coordinates(
            tmp_path, "coords.zarr", arr, axis="cells",
            space=SD.coordinate_space(space="visium:x", unit="pixel",
                                      to_space=[1, 0, 0, 0, 1, 0]),
            entity=SD.measured_entity(kind="spot", platform="visium", resolution_um=55),
            placement=SD.positioning(partial=False),
            series=SD.section(sample_id="s", index=0),
        )
    assert "exactly 2 components" in str(exc.value) or "(n x 2)" in str(exc.value)
    assert not dest.exists(), (
        "a rejected array left a directory behind — the refusal must happen BEFORE the "
        "framework writer is called, so a later reader finds nothing rather than a "
        "partial store"
    )


def test_the_importer_emits_no_z_column_for_a_platform_that_has_no_z(tmp_path):
    """TEST-3 (cont.) — "never write `z = 0` for a 2-D platform".

    The design's rule is unconditional, and the tempting failure is a zero fill: it makes
    every artifact uniformly 3-D and is indistinguishable, later, from a measurement. The
    contract makes that unreachable (an all-zero z is refused outright); this asserts the
    importer takes the other branch — it declares nothing at all.
    """
    module = VF.load_compute()
    _m, entries = VF.run_over(VF.FIXTURE, tmp_path / "out")
    meta = VF.entry_by_id(entries, "spatial-coordinates")["meta"]
    assert "z_column" not in meta

    with pytest.raises(module.SD.SpatialDeclarationError):
        module.SD.z_column(name="z", kind="physical", values=np.zeros(5))


def test_the_emitted_member_is_two_dimensional_in_the_bytes(tmp_path):
    """TEST-3 (cont.) — read back, because the declaration is not the artifact."""
    _m, entries = VF.run_over(VF.FIXTURE, tmp_path / "out")
    entry = VF.entry_by_id(entries, "spatial-coordinates")
    members = entry["structure"].get("arrays") or entry["structure"].get("columns")
    assert len(members) == 1, (
        "a coordinates artifact declares exactly ONE member; the `dims: 2` narrowing "
        "reads a single member's own shape and answers nothing for a multi-member table"
    )
    assert members[0]["shape"][1] == 2
    values = VF.read_member(tmp_path / "out", "spatial/coordinates.zarr", members[0]["path"])
    assert values.ndim == 2 and values.shape[1] == 2
