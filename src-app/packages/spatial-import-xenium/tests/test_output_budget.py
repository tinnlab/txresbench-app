#!/usr/bin/env python3
# ruff: noqa
"""The artifact fan-out is BOUNDED, and bounded by the right things.

Design §8.2:

    **`MAX_OUTPUTS = 512` bounds the artifact fan-out.** … any design that emits per-tile
    or per-gene artifacts is dead on arrival. Recorded so nobody proposes "one artifact per
    pyramid level".

A count under the cap is the weak half of that and would pass for an importer that scaled
with the gene count on a small fixture. The half with teeth is the SHAPE of the count: it
must be a function of how many feature classes the vendor shipped, and of nothing else —
not the gene count, not the pyramid depth, not the image's pixel count.

The two real fixtures are what make that measurable. They differ by 26x in feature count
(13,780 vs 520) and by pyramid depth, and their entry counts must differ by exactly the
number of emitted feature classes.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

#: `src-app/server/src/modules/sandbox/outputs.rs` — the hard cap on `manifest.json`
#: entries, past which a run FAILS. Spelled here rather than imported because it is a
#: server-side Rust constant and this is a python suite; §8.2 quotes the same number.
MAX_OUTPUTS = 512

#: The headroom this importer is expected to keep. A run at 500 entries would satisfy the
#: cap and still be one vendor release from failing, so the assertion is against a budget,
#: not against the ceiling.
BUDGET = MAX_OUTPUTS // 4


def _imported(tmp_path_factory, bundle, slug):
    out = tmp_path_factory.mktemp(slug)
    module, entries = XF.run_over(bundle, out)
    return {"out": out, "entries": entries, "module": module, "bundle": bundle,
            "report": json.loads((out / "xenium-import-report.json").read_text())}


@pytest.fixture(scope="module")
def prime(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PRIME, "budget-prime")


@pytest.fixture(scope="module")
def protein(tmp_path_factory):
    return _imported(tmp_path_factory, XF.PROTEIN, "budget-protein")


#: The one disposition that means a `single-cell/counts` store exists. Matched POSITIVELY
#: rather than by excluding a drop spelling: an inverted match silently reclassifies every
#: future disposition as "emitted", which is how this helper read six emitted classes while
#: five of them had been dropped.
EMITTED_DISPOSITION = "emitted as the counts matrix"


def _emitted_classes(ctx):
    return sorted(
        name for name, info in ctx["report"]["feature_classes"].items()
        if info["disposition"] == EMITTED_DISPOSITION
    )


def _per_cell_columns(ctx):
    return sorted(e["id"] for e in ctx["entries"]
                  if e["datatype"] == "metadata-column" and e["axis"] == "cells")


# ── the weak half: under the cap ─────────────────────────────────────────────────────


@pytest.mark.parametrize("case", ["prime", "protein"])
def test_the_manifest_stays_well_inside_the_output_cap(case, prime, protein):
    """TEST-7 [acceptance] [invariant: INV-7] — the count, with headroom."""
    ctx = {"prime": prime, "protein": protein}[case]
    n = len(ctx["entries"])
    assert 0 < n <= BUDGET, (
        f"{n} entries against a {MAX_OUTPUTS}-entry cap; this importer is expected to stay "
        f"inside {BUDGET} so a vendor adding a feature class cannot push it over"
    )


# ── the half with teeth: the count's SHAPE ───────────────────────────────────────────


def test_the_two_fixtures_really_differ_in_gene_count_and_pyramid_depth(prime, protein):
    """TEST-7 [acceptance] [invariant: INV-7] — the substrate the next test rests on.

    If the two fixtures ever converged on feature count or image size, the scaling
    assertion below would still pass while proving nothing.
    """
    import tifffile

    prime_features = prime["report"]["n_features_in_matrix"]
    protein_features = protein["report"]["n_features_in_matrix"]
    assert prime_features == 13780 and protein_features == 520, (
        f"the fixtures' feature counts are {prime_features} and {protein_features}"
    )
    assert prime_features > 20 * protein_features, (
        "the two fixtures must differ by more than an order of magnitude in feature count, "
        "or 'the entry count does not scale with genes' is not being tested"
    )

    depths = {}
    for name, ctx in (("prime", prime), ("protein", protein)):
        image = [e for e in ctx["entries"] if e["datatype"] == "spatial/image"]
        assert len(image) == 1
        with tifffile.TiffFile(str(ctx["out"] / image[0]["path"])) as handle:
            depths[name] = len(handle.series[0].levels)
    assert depths["prime"] != depths["protein"], (
        f"the two emitted images must have different pyramid depths ({depths}) or 'the "
        "entry count does not scale with pyramid levels' is not being tested"
    )


def test_the_entry_count_scales_with_feature_classes_and_with_nothing_else(prime, protein):
    """TEST-7 [acceptance] [invariant: INV-7] — the exact identity.

    26x the features and a different pyramid depth must buy exactly ZERO extra artifacts.
    The only legitimate difference between the two manifests is that the protein bundle has
    one feature class this importer refuses to emit.

    The decomposition is asserted alongside the identity so that a future divergence names
    itself instead of showing up as an arithmetic coincidence.
    """
    prime_classes = _emitted_classes(prime)
    protein_classes = _emitted_classes(protein)
    assert prime_classes == protein_classes == ["Gene Expression"], (
        f"emitted classes: prime {prime_classes}, protein {protein_classes}. Since §6.5's "
        "drop rule landed, EXACTLY ONE class is emitted whatever the bundle carries — "
        "which makes this identity stronger than it was: the two manifests must now be the "
        "SAME SIZE, not merely differ by their class counts."
    )

    # The parts that must NOT differ, named so a change in one is legible.
    assert _per_cell_columns(prime) == _per_cell_columns(protein), (
        "the two bundles must emit the same per-cell columns; if a vendor column is absent "
        "from one fixture the identity below would still hold by accident"
    )
    for datatype in ("spatial/coordinates", "spatial/image", "report/qc", "report/html"):
        assert (len([e for e in prime["entries"] if e["datatype"] == datatype])
                == len([e for e in protein["entries"] if e["datatype"] == datatype]))

    # THE IDENTITY, now in its strongest form: 26x the features, a different pyramid depth,
    # a different XOA version and a different feature-class mix buy exactly ZERO extra
    # artifacts. If anything in this importer scales with the input, this is where it shows.
    assert len(prime["entries"]) == len(protein["entries"]), (
        f"prime emitted {len(prime['entries'])} entries and protein "
        f"{len(protein['entries'])}. The two bundles differ in feature count, pyramid "
        "depth, XOA version and class mix; the manifest size must depend on NONE of them."
    )
    assert {e["id"] for e in prime["entries"]} == {e["id"] for e in protein["entries"]}, (
        "and the entry IDS must match, not merely the count — an equal count reached by "
        "swapping one artifact for another would satisfy the line above"
    )


def test_every_pyramid_level_lives_inside_the_one_emitted_ome_tiff(prime, protein):
    """TEST-7 [acceptance] [invariant: INV-7] — "nobody proposes one artifact per level".

    The pyramid is real (a viewer needs it to range-read a large image at all) and it is
    SUB-IFDs inside a single file, not N artifacts. Both halves are asserted: more than one
    level exists, and exactly one `spatial/image` entry does.
    """
    import tifffile

    for name, ctx in (("prime", prime), ("protein", protein)):
        images = [e for e in ctx["entries"] if e["datatype"] == "spatial/image"]
        assert len(images) == 1, f"{name} emitted {len(images)} spatial/image artifacts"
        with tifffile.TiffFile(str(ctx["out"] / images[0]["path"])) as handle:
            levels = len(handle.series[0].levels)
        assert levels > 1, (
            f"{name}'s emitted image has {levels} level(s); a pyramid is what makes a large "
            "image range-readable, and its absence would push the pressure back toward "
            "per-level artifacts"
        )
