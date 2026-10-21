#!/usr/bin/env python3
# ruff: noqa
"""Can a SANDBOXED consumer actually read the affine? (#155 / #211)

#155 declares a coordinate-space affine. Every spatial analysis that would use it runs in
the sandbox. So "is the declaration reachable from inside the sandbox?" is not a detail —
it decides whether this item is useful or merely correct, and #211 says the answer for
`meta` is NO.

This module MEASURES it rather than restating the issue, because the measurement is the
only thing that distinguishes "we declared it" from "someone can read it".

## What a sandboxed compute can actually see

Two channels, and this test reproduces both from the shipped server code rather than from
the issue text:

* **`inputs.json`** — `InputsJsonEntry` is `{slot, kind, content_hash, sandbox_path}`
  (`src-app/server/src/modules/sandbox/inputs.rs:63-69`). Note this CORRECTS #211, which
  also lists `host_path`: the host path is deliberately excluded from the wire, a contract
  pinned by `inputs_json_is_hash_referenced_and_deterministic` (`:1135, :1152`).
* **the staged bytes** — `stage_prefix_members` (`inputs.rs:848-880`) copies every member
  BYTE-VERBATIM out of the content-addressed pool. For a zarr artifact that includes
  `<store>/zarr.json`, whose `attributes.cyto` carries the producer's `structure`
  (`_lib/cyto_zarr.py:1667-1669`) — the channel `stamp_cyto_attributes` /
  `structure_extra` exists to widen.

The manifest entry's `meta` is in NEITHER. It becomes the `artifacts.meta` jsonb column
(`workstore/ingest.rs:197-208`) and every reader of it — the UI, the HTTP API, the
conformance job — is outside the sandbox.

## Why `spatial/image` cannot use the `structure` escape hatch

Because it has no store. `spatial/image` is `opaque` with `file_layout: single`, and
`conformance._bytes_are_not_a_store` (`conformance.py:1705-1712`) REFUSES an opaque
artifact that contains a `zarr.json` — so there is nothing to stamp. For this kind,
`structure` is exactly as unreachable as `meta`.

What it does have is its own OME-XML, which is part of the staged bytes. That is the
channel #155 uses, and the second half of this module is the proof that it works.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import tifffile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


@pytest.fixture(scope="module")
def produced(tmp_path_factory):
    bundle = VF.make_imaged(tmp_path_factory.mktemp("reach-src"), with_lowres=False)
    out = tmp_path_factory.mktemp("reach-out")
    _module, entries = VF.run_over(bundle, out)
    entry = VF.entry_by_id(entries, "spatial-image-hires")
    return {"entries": entries, "out": out, "entry": entry}


#: The shipped Rust that defines the wire shape. Read by the test below so the
#: measurement is anchored to the platform rather than to this module's own fixture.
_INPUTS_RS = (
    Path(__file__).resolve().parents[3]
    / "server" / "src" / "modules" / "sandbox" / "inputs.rs"
)


def inputs_json_fields_from_rust():
    """The field names `InputsJsonEntry` serializes, parsed from `sandbox/inputs.rs`.

    Deliberately a parse of the STRUCT BODY rather than a substring search of the file: a
    grep for `"meta"` over `inputs.rs` would hit a doc-comment, a log line or an unrelated
    struct, and this project has repeatedly been bitten by static predicates over text that
    a comment defeats. The struct body is bounded and unambiguous, and if the declaration
    moves or is renamed this raises rather than silently returning an empty set — a check
    that quietly matches nothing is the failure mode being guarded against.
    """
    source = _INPUTS_RS.read_text()
    match = re.search(r"struct\s+InputsJsonEntry<'a>\s*\{(.*?)\n\}", source, re.S)
    assert match, (
        f"could not find `struct InputsJsonEntry` in {_INPUTS_RS} — it was renamed or "
        "moved, so this measurement is no longer anchored to the shipped wire format"
    )
    fields = set(re.findall(r"^\s*(\w+)\s*:", match.group(1), re.M))
    assert fields, f"parsed no fields out of InputsJsonEntry:\n{match.group(1)}"
    return fields


def stage_as_sandbox_input(artifact_path, sandbox_root, *, slot="image"):
    """Stage one artifact the way the server does, and return the inputs dir.

    The `inputs.json` shape is `render_inputs_json`'s (`sandbox/inputs.rs:63-91`) — four
    keys, no `meta`, no `datatype`, no `label`, and no `host_path`. It is written by hand
    here because a python test cannot call the Rust, but the hand-written shape is NOT
    trusted: [`inputs_json_fields_from_rust`] parses the shipped struct and the test asserts
    the two agree, so a widened wire format turns this red instead of leaving a fixture
    quietly measuring itself.
    """
    import hashlib

    inputs = Path(sandbox_root) / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    blob = Path(artifact_path).read_bytes()
    staged = inputs / Path(artifact_path).name
    staged.write_bytes(blob)
    (inputs / "params.json").write_text("{}")
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{
            "slot": slot,
            "kind": "spatial/image",
            "content_hash": hashlib.sha256(blob).hexdigest(),
            "sandbox_path": f"/inputs/{staged.name}",
        }]
    }))
    return inputs


# ── TEST-10 [acceptance] [invariant: INV-10] — THE MEASUREMENT ───────────────────────


def test_the_affine_is_absent_from_inputs_json_and_present_in_the_image_bytes(
        produced, tmp_path):
    """TEST-10 [acceptance] [invariant: INV-10] — where the affine really is reachable.

    Both halves matter and neither is sufficient alone. The negative half measures #211:
    nothing a sandboxed consumer reads through the INPUT CHANNEL carries the affine. The
    positive half is #155's answer: it is in the bytes, and a consumer that opens the
    image gets it with no platform change at all.
    """
    entry = produced["entry"]
    affine = entry["meta"]["to_space"]
    # `5.0` — the digits a consumer would have to find SOMEWHERE to place these pixels.
    needle = repr(affine[0])
    assert affine[0] != 1.0, (
        "the fixture's affine is the identity, so 'the affine is absent' would be "
        "indistinguishable from 'the identity happens not to appear' and this "
        "measurement would prove nothing"
    )

    inputs = stage_as_sandbox_input(produced["out"] / entry["path"], tmp_path)

    # ── negative: the input channel carries nothing ──────────────────────────────────
    #
    # The wire shape is read from the SHIPPED RUST STRUCT, not from this test's own
    # fixture. Without that link the negative half is self-confirming: `stage_as_sandbox_input`
    # writes `inputs.json` from a four-key literal, so asserting that literal back proves
    # nothing about the platform, and if `InputsJsonEntry` ever gained a `meta` field this
    # test would stay green while the item's central premise silently stopped being true.
    platform_fields = inputs_json_fields_from_rust()
    wire = json.loads((inputs / "inputs.json").read_text())
    assert set(wire["inputs"][0]) == platform_fields, (
        f"the fixture writes {sorted(set(wire['inputs'][0]))} but the shipped "
        f"`InputsJsonEntry` declares {sorted(platform_fields)} — this measurement is "
        "staging something the server would not"
    )
    assert "meta" not in platform_fields, (
        "`inputs.json` now carries `meta`, so #211's premise no longer holds and this "
        "item's OME-XML channel may no longer be the only way in. Re-read "
        "`sandbox/inputs.rs::render_inputs_json` and re-decide."
    )
    assert "meta" not in wire["inputs"][0]
    assert needle not in (inputs / "inputs.json").read_text()
    assert needle not in (inputs / "params.json").read_text()
    # And there is no store to carry a `structure`: an opaque single-file artifact has no
    # `zarr.json`, which is what closes the `stamp_cyto_attributes` route for this kind.
    assert list(inputs.rglob("zarr.json")) == []

    # ── positive: the BYTES carry it ─────────────────────────────────────────────────
    staged = inputs / Path(entry["path"]).name
    SD = sys.modules["spatial_declarations"]
    with tifffile.TiffFile(staged) as tf:
        placement = SD.require_placement(tf.ome_metadata, consumer="a spatial analysis")
    assert placement["to_space"] == affine
    assert placement["coordinate_space"] == entry["meta"]["coordinate_space"]
    assert placement["extent"] == entry["meta"]["extent"]


def test_a_consumer_with_no_placement_refuses_rather_than_assuming_identity(tmp_path):
    """TEST-10 (cont.) [invariant: INV-10] — the refusal, on the reader side.

    Mirrors `require_micron_scale`'s discipline. An image written by some other tool
    carries no `cyto` payload, and the only safe answer is to stop: assuming the identity
    affine would claim the pixels are already full-resolution space pixels, and if they
    are not, every spot drawn on the image lands in the wrong place with nothing to say so.
    """
    import numpy as np

    SD = VF.load_compute().SD
    plain = tmp_path / "someone-elses.ome.tif"
    tifffile.imwrite(plain, np.zeros((8, 12, 3), dtype=np.uint8), photometric="rgb",
                     ome=True)
    with tifffile.TiffFile(plain) as tf:
        assert SD.decode_placement(tf.ome_metadata) is None
        with pytest.raises(SD.SpatialDeclarationError) as exc:
            SD.require_placement(tf.ome_metadata, consumer="a spatial analysis")
    assert "identity" in str(exc.value).lower()


def test_a_sandboxed_process_holding_only_the_staged_dir_can_recover_the_affine(
        produced, tmp_path):
    """TEST-10 (cont.) — proven by RUNNING a separate process, not by reading a file.

    The measurement above is made by this pytest process, which has the whole repo on its
    path and the producer's `entries` in memory. A sandboxed consumer has neither. So this
    leg starts a SUBPROCESS whose entire world is the staged inputs directory plus the
    vendored declarations module — the same two things `/code` and `/inputs` give a real
    compute — and asks it to place a pixel. If it can, the declaration is genuinely
    reachable; if the only reason the earlier assertions passed was this process's extra
    context, this one goes red.
    """
    entry = produced["entry"]
    inputs = stage_as_sandbox_input(produced["out"] / entry["path"], tmp_path)

    consumer = tmp_path / "consumer.py"
    consumer.write_text(
        "import json, sys, tifffile, spatial_declarations as SD\n"
        "idx = json.load(open(sys.argv[1] + '/inputs.json'))['inputs'][0]\n"
        "path = sys.argv[1] + '/' + idx['sandbox_path'].rsplit('/', 1)[-1]\n"
        "with tifffile.TiffFile(path) as tf:\n"
        "    p = SD.require_placement(tf.ome_metadata, consumer='probe')\n"
        "a, b, tx, c, d, ty = p['to_space']\n"
        "print(json.dumps({'space': p['coordinate_space'],\n"
        "                  'placed': [a * 100 + b * 50 + tx, c * 100 + d * 50 + ty]}))\n"
    )
    env = dict(os.environ)
    # EXACTLY the two paths a real compute gets: the package's own `/code` (entry +
    # declared helpers) and `_lib`. Nothing else — in particular not this test directory.
    env["PYTHONPATH"] = os.pathsep.join([
        str(VF.PKG / "compute"), str(VF.PKG.parent / "_lib"),
    ])
    result = subprocess.run([sys.executable, str(consumer), str(inputs)],
                            capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr[-2000:]

    answer = json.loads(result.stdout)
    assert answer["space"] == entry["meta"]["coordinate_space"]
    a, _b, tx, _c, d, ty = entry["meta"]["to_space"]
    assert answer["placed"] == pytest.approx([a * 100 + tx, d * 50 + ty])


# ── TEST-9 [acceptance] [invariant: INV-6] — the affine is UNVERIFIABLE ──────────────


def test_a_wrong_affine_passes_every_check_this_system_has(produced, tmp_path):
    """TEST-9 [acceptance] [invariant: INV-6] — naming the weakness, executably.

    §12.2 item 2: *"The affine is producer-declared and unverifiable. No gate can check a
    registration. … This is a genuine weakening relative to every other artifact in the
    system, and it should be named in the item that implements it rather than discovered
    later."* This is that naming, as a test rather than a comment — so the day someone
    believes a gate is covering registration, this test says otherwise in their face.

    A deliberately WRONG affine (double the correct scale — every spot would land at twice
    its true distance from the origin) is pushed through the SAME write path the importer
    uses. Everything accepts it: the declaration constructor, the OME writer, the reader,
    and the placement round trip. Nothing anywhere notices.

    The compensating control is #156's rendered registration overlay — a human looking at
    spots on tissue. That is the entire verification story for §7.3, and this test is the
    reason to build it.
    """
    SD = VF.load_compute().SD
    OW = sys.modules["ome_writer"]
    import numpy as np

    correct = produced["entry"]["meta"]["to_space"]
    wrong = [correct[0] * 2, 0.0, 0.0, 0.0, correct[4] * 2, 0.0]

    space = SD.coordinate_space(
        space=produced["entry"]["meta"]["coordinate_space"],
        unit="pixel", to_space=wrong, extent={"width": 300, "height": 180},
    )
    # The constructor takes it: an affine legitimately contains any finite numbers (a
    # flip, a translation), so there is no shape rule that could reject a wrong one.
    meta = SD.image_meta(space=space, role="display", source="tissue.png")
    assert meta["to_space"] == wrong

    dest = OW.write_ome_tiff(tmp_path / "wrong.ome.tif",
                             np.zeros((180, 300, 3), dtype=np.uint8), placement=meta)
    with tifffile.TiffFile(dest) as tf:
        assert tf.is_ome
        assert SD.require_placement(tf.ome_metadata, consumer="probe")["to_space"] == wrong

    # Say the quiet part, as an assertion that can actually fail: nothing on the write
    # path recomputes the affine, so the ONLY difference between this artifact and a
    # correct one is a number no gate reads. `wrong != correct` would be true by
    # construction; what is checkable is that the WRONG value survived every stage
    # intact — declaration, bytes, and read-back — which is what 'unverifiable' means.
    # The wrong artifact is INDISTINGUISHABLE from a correct one by anything mechanical:
    # same structure declaration, same media type, same extent, a valid OME-TIFF either
    # way. Asserted by building the CORRECT artifact through the identical path and
    # comparing everything except the affine itself.
    right_meta = SD.image_meta(
        space=SD.coordinate_space(
            space=produced["entry"]["meta"]["coordinate_space"], unit="pixel",
            to_space=correct, extent={"width": 300, "height": 180},
        ),
        role="display", source="tissue.png",
    )
    right = OW.write_ome_tiff(tmp_path / "right.ome.tif",
                              np.zeros((180, 300, 3), dtype=np.uint8),
                              placement=right_meta)
    assert {k: v for k, v in meta.items() if k != "to_space"} == \
           {k: v for k, v in right_meta.items() if k != "to_space"}, (
        "the wrong-affine artifact differs from the correct one somewhere OTHER than the "
        "affine, so this test is not actually demonstrating that the affine alone is "
        "unchecked"
    )
    with tifffile.TiffFile(right) as tf:
        assert tf.is_ome
        right_placement = SD.require_placement(tf.ome_metadata, consumer="probe")
    with tifffile.TiffFile(dest) as tf:
        wrong_placement = SD.require_placement(tf.ome_metadata, consumer="probe")

    # The two artifacts differ in EXACTLY ONE key, and it is the one no gate reads. Both
    # are valid OME-TIFFs, both carry a well-formed placement, both declare the same space,
    # unit and extent — and one of them puts the tissue in the wrong place.
    differing = {k for k in set(right_placement) | set(wrong_placement)
                 if right_placement.get(k) != wrong_placement.get(k)}
    assert differing == {"to_space"}, (
        f"the two artifacts differ in {sorted(differing)}, not only in the affine, so this "
        "test is not isolating the unverifiable field"
    )
    assert wrong_placement["to_space"] == wrong


# ══════════════════════════════════════════════════════════════════════════════════════
# #211 — THE ZARR HALF. Everything above measures the OME-TIFF channel (#155); everything
# below measures the channel this item creates for the kind that HAS a store.
# ══════════════════════════════════════════════════════════════════════════════════════

import sandbox_code_dir as CODE  # noqa: E402

#: The radius a real spatial analysis takes. Micrometres — which is exactly why the scale
#: has to be reachable, and why a fabricated 1.0 would be a wrong answer rather than an
#: error.
PROBE_RADIUS_UM = 30.0

#: The consumer. Its whole world is `/code` and `/inputs`; it imports by bare module name
#: because that is what a flat `/code` gives it, and it asks for everything through the
#: `require_*` functions rather than reading keys, so a missing declaration STOPS it.
#
#: It also READS THE COORDINATE VALUES, through `cyto_zarr_read` — the platform's own
#: reader, staged globally by `PY_HELPER_FILES`. That is not decoration: without it, the
#: whole global-staging half of the harness would be inert, and a mutation that staged
#: NOTHING from that table left this test green (mutant M6). A real spatial analysis reads
#: positions AND their declared scale, so the probe does both and reports a MEASURED
#: quantity in microns — which is the operation #99 and #109 are actually blocked on.
_CONSUMER = '''
import json, math, os, sys
import cyto_zarr_read
import spatial_declarations as SD

inputs = sys.argv[1]
entry = json.load(open(os.path.join(inputs, "inputs.json")))["inputs"][0]
store = os.path.join(inputs, entry["sandbox_path"].rsplit("/", 1)[-1])

block = SD.require_spatial_declarations(store, consumer="a neighbourhood analysis")
scale = SD.require_micron_scale(block, consumer="a neighbourhood analysis")
# `.get()`, NOT `block["positioning"]`. The contract guarantees a well-formed coordinate
# space and that any sub-block PRESENT is well formed — it does not guarantee that every
# sub-block is there, and `require_full_positioning` names the absent case where a bare
# subscript would raise a KeyError. This is the reference consumer, so it must use the
# form the contract mandates rather than the one that happens to work on this fixture.
SD.require_full_positioning(block.get("positioning"),
                            consumer="a neighbourhood analysis")

# the positions themselves, through the platform reader a real compute uses. The member
# name comes from the framework's OWN declaration in the same `attributes.cyto` the
# spatial block rides in — `arrays`, not `columns`: a 2-D member is an ARRAY and
# `columns` is empty for a coordinates artifact. A coordinates artifact declares exactly
# one array, so taking the sole element is not a positional choice, it is the only
# element there is.
declaration = cyto_zarr_read.structure(store)
arrays = declaration["arrays"]
if len(arrays) != 1:
    raise SystemExit("a coordinates artifact declares one array, got " + str(len(arrays)))
values = cyto_zarr_read.read_array(store, arrays[0]["path"])
span_px = math.hypot(float(values[:, 0].max() - values[:, 0].min()),
                     float(values[:, 1].max() - values[:, 1].min()))

print(json.dumps({
    "space": block["coordinate_space"],
    "unit": block["unit"],
    "scale": scale,
    "scale_source": block.get("microns_per_pixel_source"),
    "space_source": block.get("coordinate_space_source"),
    "entity": block.get("measured_entity"),
    "entity_label": block.get("measured_entity_label"),
    "section": block.get("section"),
    "radius_px": %s / scale,
    "n_rows": int(values.shape[0]),
    "span_um": span_px * scale,
    "sys_path0": sys.path[0],
    "pythonpath": os.environ.get("PYTHONPATH"),
}))
''' % PROBE_RADIUS_UM


def stage_store_as_sandbox_input(store_dir, sandbox_root, *, slot="coordinates"):
    """Stage a MULTI-FILE zarr artifact the way `stage_prefix_members` does.

    Byte-verbatim, member by member, under one directory bound at `/inputs/<name>` —
    `inputs.rs:848-880` hardlinks each member out of the content-addressed pool and writes
    nothing of its own into the directory. Copying is the same bytes; the hardlink is an
    optimisation, not a difference a consumer can observe.
    """
    import hashlib

    inputs = Path(sandbox_root) / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    staged = inputs / Path(store_dir).name
    digest = hashlib.sha256()
    for member in sorted(Path(store_dir).rglob("*")):
        if not member.is_file():
            continue
        rel = member.relative_to(store_dir)
        dest = staged / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        body = member.read_bytes()
        dest.write_bytes(body)
        digest.update(str(rel).encode())
        digest.update(body)
    (inputs / "params.json").write_text(json.dumps({"seed": 0}))
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{
            "slot": slot,
            # the SOURCE kind a multi-file workstore artifact gets (`inputs.rs:746-758`)
            "kind": "artifact-prefix",
            "content_hash": "sha256:" + digest.hexdigest(),
            "sandbox_path": f"/inputs/{staged.name}",
        }]
    }))
    return inputs


def run_consumer(code_dir, inputs_dir, source=_CONSUMER):
    """Run the consumer the way `stage_and_launch` does: `python3 <code>/entry.py`.

    **No `PYTHONPATH`** — production launches under `--clearenv` (`sandbox.rs:101-108`),
    so the environment handed here carries only what the interpreter needs to find its own
    library. `cwd` is the inputs dir rather than the repo, so nothing resolves by accident
    off the source tree, and `sys.path[0]` is the staged `/code` dir exactly as it is in a
    real job.

    `HOME` is the REAL home and that is deliberate, not a leak. In production the analysis
    image ships numpy/tifffile in the interpreter's system `site-packages`; on a developer
    box they are typically in the USER site dir, which Python locates through `HOME`. A
    stricter `HOME` here would model an environment with no scientific stack at all — the
    consumer would die with `ModuleNotFoundError: numpy` and the test would be measuring
    this box's package layout rather than the declaration channel. What must NOT be present
    is `PYTHONPATH`, because that is the thing that would put the SOURCE TREE on the path
    and let the measurement resolve modules the platform does not stage. That is asserted.
    """
    entry = CODE.stage_code_dir(code_dir, VF.PKG, source)
    # The env production actually builds after `--clearenv` (`sandbox.rs:178-211`): PATH,
    # HOME, and — the one that matters here — `LANG`/`LC_ALL=C.UTF-8`. A two-key env was
    # not "stricter than production", it modelled an ASCII-locale process that production
    # is specifically configured NOT to be, which would make a non-ASCII library id fail
    # here and pass in a job. No `PYTHONPATH`: that is the key whose absence is the point,
    # and it is asserted from INSIDE the subprocess (`answer["pythonpath"] is None`),
    # where it can actually fail — asserting it about this dict literal could not.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
           "HOME": os.environ.get("HOME", "/tmp"),
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    return subprocess.run([sys.executable, str(entry / "entry.py"), str(inputs_dir)],
                          capture_output=True, text=True, env=env, cwd=str(inputs_dir))


@pytest.fixture(scope="module")
def coordinates(tmp_path_factory):
    bundle = VF.make_imaged(tmp_path_factory.mktemp("zarr-src"), with_lowres=False)
    out = tmp_path_factory.mktemp("zarr-out")
    _module, entries = VF.run_over(bundle, out)
    entry = VF.entry_by_id(entries, "spatial-coordinates")
    return {"entries": entries, "out": out, "entry": entry,
            "store": out / entry["path"]}


# ── TEST-3 [acceptance] [invariant: INV-2] ──────────────────────────────────────────
def test_a_sandboxed_process_holding_only_the_staged_store_recovers_every_declaration(
        coordinates, tmp_path):
    """TEST-3 [acceptance] [invariant: INV-2] — the reachability proof, by RUNNING it.

    The positive half of #211. A SUBPROCESS whose entire world is a production-shaped flat
    `/code` dir plus a staged inputs dir — no `PYTHONPATH`, no repo on the path, `cwd`
    outside the source tree — reads `inputs.json`, opens the staged store, and recovers the
    coordinate space, the unit, the micron scale AND ITS PROVENANCE, the measured entity,
    the positioning and the section. Then it converts a 30 um radius, which is the actual
    operation #99 and #109 are blocked on.

    The negative half, in the same test so the two cannot drift apart. **Its reach is
    exactly one assertion**, and saying so precisely matters: `stage_store_as_sandbox_input`
    WRITES the `inputs.json` and `params.json` it then inspects, so "the scale's digits are
    not in them" is a fixture-integrity check — it proves this measurement is isolating the
    store channel, and it cannot detect a widened production wire. The assertion that CAN
    is `set(wire["inputs"][0]) == inputs_json_fields_from_rust()`, which parses the shipped
    `struct InputsJsonEntry`: if the platform ever put `meta` on the wire, the field sets
    diverge and this goes red.
    """
    entry = coordinates["entry"]
    meta = entry["meta"]
    scale = meta["microns_per_pixel"]
    assert scale != 1.0, (
        "the fixture's scale is 1.0, so 'the consumer read the declared scale' and 'the "
        "consumer fabricated 1.0' would produce the SAME answer and this test would prove "
        "nothing about INV-1"
    )

    inputs = stage_store_as_sandbox_input(coordinates["store"], tmp_path)

    # ── negative: the platform channels carry nothing ────────────────────────────────
    platform_fields = inputs_json_fields_from_rust()
    wire = json.loads((inputs / "inputs.json").read_text())
    assert set(wire["inputs"][0]) == platform_fields
    assert "meta" not in platform_fields
    for derived in ("inputs.json", "params.json"):
        text = (inputs / derived).read_text()
        assert repr(scale) not in text and str(scale) not in text, (
            f"{derived} carries the scale's digits, so this measurement is not isolating "
            "the store channel"
        )
        assert "measured_entity" not in text and "coordinate_space" not in text

    # ── positive: the STORE carries them, and a real subprocess reads them ───────────
    result = run_consumer(tmp_path / "code", inputs)
    assert result.returncode == 0, result.stderr[-3000:]
    answer = json.loads(result.stdout)

    assert answer["pythonpath"] is None, "the subprocess had a PYTHONPATH; not a sandbox model"
    assert answer["sys_path0"] == str(tmp_path / "code")
    assert answer["space"] == meta["coordinate_space"]
    assert answer["unit"] == meta["unit"]
    assert answer["scale"] == pytest.approx(scale)
    assert answer["scale_source"] == meta["microns_per_pixel_source"]
    assert answer["space_source"] == meta["coordinate_space_source"]
    assert answer["entity"] == meta["measured_entity"]
    assert answer["entity_label"] == meta["measured_entity_label"]
    assert answer["section"] == meta["section"]
    assert answer["radius_px"] == pytest.approx(PROBE_RADIUS_UM / scale)

    # ── and the POSITIONS, read through the platform's own reader ────────────────────
    #
    # Not decoration. Without this leg the global `PY_HELPER_FILES` staging is inert, and a
    # mutation that staged NOTHING from that table left this test green. It is also the
    # honest end of the operation: a spatial analysis wants a MEASURED quantity, and
    # `span_um` is one — positions from the bytes, scale from the declaration, multiplied.
    assert answer["n_rows"] == meta["n"] > 0
    assert answer["span_um"] > 0

    # The expected PIXEL span, computed here from the coordinates on disk — INDEPENDENTLY
    # of the subprocess's answer. The first version derived `span_px` from `span_um` and
    # then asserted `span_px == span_um / scale`, which is `x == x`: it could not fail, and
    # dropping the `* scale` from the consumer left it green.
    import math

    values = VF.read_member(coordinates["out"], entry["path"],
                            coordinates["entry"]["structure"]["arrays"][0]["path"])
    expected_px = math.hypot(float(values[:, 0].max() - values[:, 0].min()),
                             float(values[:, 1].max() - values[:, 1].min()))
    assert expected_px > 0
    assert answer["span_um"] == pytest.approx(expected_px * scale, rel=1e-6), (
        "the measured span does not equal the on-disk pixel span times the DECLARED "
        "scale, so the consumer is not combining the bytes with the declaration"
    )
    # ...and the scale genuinely moves the answer, so a fabricated 1.0 would be a
    # different number rather than the same one.
    assert answer["span_um"] != pytest.approx(expected_px, rel=1e-6)


def test_the_same_sandboxed_consumer_REFUSES_when_the_declaration_is_absent(
        coordinates, tmp_path):
    """TEST-3 (cont.) [invariant: INV-1] — the fail-closed half, in the SAME subprocess.

    The declaration is stripped from the staged store — which is exactly what a consumer
    holds for an artifact written before this change, or for a gathered artifact whose
    `structure` the filter path re-minted. The SAME consumer, unmodified, must exit
    NON-ZERO with a refusal naming itself. It may not print a number.

    This is the leg that makes TEST-3 mean something: without it, TEST-3 would pass with a
    consumer that fabricated every value it printed.
    """
    inputs = stage_store_as_sandbox_input(coordinates["store"], tmp_path)
    staged = inputs / Path(coordinates["store"]).name
    doc = json.loads((staged / "zarr.json").read_text())
    del doc["attributes"]["cyto"]["cyto_spatial"]
    (staged / "zarr.json").write_text(json.dumps(doc, indent=2))

    result = run_consumer(tmp_path / "code", inputs)
    assert result.returncode != 0, (
        "the consumer produced an answer from a store carrying no declaration:\n"
        + result.stdout
    )
    assert result.stdout.strip() == "", "it printed a result before refusing"
    assert "a neighbourhood analysis" in result.stderr
    assert "1.0" not in result.stdout


# ── TEST-8 [acceptance] [invariant: INV-4] ──────────────────────────────────────────
def test_the_opaque_image_gains_no_second_route_to_the_coordinate_space(
        produced, coordinates, tmp_path):
    """TEST-8 [acceptance] [invariant: INV-4] — one route per fact, per kind.

    #211's own correction records the general rule: *a format that carries its own
    metadata is readable where a platform-level `meta` field is not.* The image already
    satisfies it through OME-XML, so it gets NOTHING here — a second route to
    `coordinate_space` is the #214 defect class, and it is not even available
    (`_bytes_are_not_a_store` refuses an `opaque` artifact containing a `zarr.json`).

    The control that makes "absent" mean "deliberately not added" rather than "the test
    looked in the wrong place": the SAME two assertions run against the COORDINATES
    artifact find the block.
    """
    image_entry = produced["entry"]
    image_inputs = stage_as_sandbox_input(produced["out"] / image_entry["path"], tmp_path)

    assert list(image_inputs.rglob("zarr.json")) == []
    assert "cyto_spatial" not in json.dumps(image_entry["structure"])
    # the image's ONE route still works
    staged = image_inputs / Path(image_entry["path"]).name
    with tifffile.TiffFile(staged) as tf:
        placement = sys.modules["spatial_declarations"].require_placement(
            tf.ome_metadata, consumer="a spatial analysis")
    assert placement["coordinate_space"] == image_entry["meta"]["coordinate_space"]

    # ── the control: the coordinates artifact DOES have both ─────────────────────────
    coord_inputs = stage_store_as_sandbox_input(coordinates["store"], tmp_path / "coord")
    assert list(coord_inputs.rglob("zarr.json")) != []
    assert "cyto_spatial" in json.dumps(coordinates["entry"]["structure"])

    # ── the scale on the image channel carries ITS PROVENANCE, and the RIGHT one ─────
    #
    # (A counted "one route per kind" assertion used to sit here and could not fail:
    # `coord_channels` was the constant 1 by construction — the coordinates path is
    # `.zarr`, never `.tif` — and `image_channels` restated the `rglob` two assertions
    # above. Removed rather than reworded; the property that IS at risk is the VALUE.)
    #
    # This module now states that a value and the record of where it came from are a PAIR.
    # Presence alone is not that: a constant `"derived-from-spot-diameter"` passed to
    # `emit_images` would tell a sandboxed consumer which leg produced the number, and
    # tell it WRONG — fabricated provenance on the channel this change exists to make
    # auditable. So the image's payload is compared to the coordinates' declaration, which
    # is where the real derivation happened.
    assert placement["microns_per_pixel"] == pytest.approx(
        coordinates["entry"]["meta"]["microns_per_pixel"])
    assert placement["microns_per_pixel_source"] == \
        coordinates["entry"]["meta"]["microns_per_pixel_source"], (
        "the image and the coordinates declare the same coordinate space and disagree "
        "about which leg produced its scale — one of them is fabricated provenance"
    )


# ── TEST-12 ─────────────────────────────────────────────────────────────────────────
def test_the_helper_table_parser_raises_rather_than_matching_nothing(tmp_path, monkeypatch):
    """TEST-12 — a parser that quietly matches nothing is the failure being guarded against.

    If `PY_HELPER_FILES` were renamed and the parser returned `[]`, TEST-3's `/code` dir
    would hold only the entry script. The subprocess would then fail with
    `ModuleNotFoundError` — for a reason with nothing to do with what TEST-3 measures — or,
    on some future consumer that needs no helper, would PASS while modelling a sandbox the
    tree does not ship. So the parser must raise, and this proves it does by pointing it at
    a file where the table is not.
    """
    assert len(CODE.py_helper_files()) >= 4
    assert ("cyto_zarr_read.py", "_lib", "cyto_zarr_read.py") in CODE.py_helper_files()

    decoy = tmp_path / "mod.rs"
    decoy.write_text("// no table here\npub const SOMETHING_ELSE: &[u8] = &[];\n")
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", decoy)
    with pytest.raises(AssertionError) as exc:
        CODE.py_helper_files()
    assert "PY_HELPER_FILES" in str(exc.value)

    # an INDENTED closing `];` must not let the body run on into the NEXT const
    runon = tmp_path / "runon.rs"
    runon.write_text(
        'const RESERVED_HELPER_PACKAGE: &str = "_helpers";\n'
        'const RESERVED_LIB_PACKAGE: &str = "_lib";\n'
        "pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[\n"
        '    ("cyto_zarr.py", RESERVED_LIB_PACKAGE, "cyto_zarr.py"),\n'
        "    ];\n"
        "const OTHER: &[(&str, &str, &str)] = &[\n"
        '    ("not_staged.py", RESERVED_LIB_PACKAGE, "not_staged.py"),\n'
        "];\n"
    )
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", runon)
    staged_names = {name for name, _pkg, _rel in CODE.py_helper_files()}
    assert staged_names == {"cyto_zarr.py"}, (
        f"the parser ran past the indented `];` into a neighbouring const: {staged_names}"
    )

    # a block-commented entry is not live staging, and a `#[cfg]`-gated table is REFUSED
    # rather than guessed at (this parser has no model of which arm a real job gets)
    commented = tmp_path / "commented.rs"
    commented.write_text(
        'const RESERVED_HELPER_PACKAGE: &str = "_helpers";\n'
        'const RESERVED_LIB_PACKAGE: &str = "_lib";\n'
        "pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[\n"
        '    ("cyto_zarr.py", RESERVED_LIB_PACKAGE, "cyto_zarr.py"),\n'
        '    /* ("removed.py", RESERVED_LIB_PACKAGE, "removed.py"), */\n'
        "\n];\n"
    )
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", commented)
    assert {n for n, _p, _r in CODE.py_helper_files()} == {"cyto_zarr.py"}

    gated = tmp_path / "gated.rs"
    gated.write_text(
        'const RESERVED_HELPER_PACKAGE: &str = "_helpers";\n'
        'const RESERVED_LIB_PACKAGE: &str = "_lib";\n'
        "pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[\n"
        '    ("cyto_zarr.py", RESERVED_LIB_PACKAGE, "cyto_zarr.py"),\n'
        '    #[cfg(test)] ("only_in_tests.py", RESERVED_LIB_PACKAGE, "t.py"),\n'
        '    /* ("removed.py", RESERVED_LIB_PACKAGE, "removed.py"), */\n'
        "\n];\n"
    )
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", gated)
    with pytest.raises(AssertionError) as exc:
        CODE.py_helper_files()
    assert "#[" in str(exc.value)

    # an UNRESOLVED package symbol raises instead of degrading to a silent non-stage
    unknown = tmp_path / "unknown.rs"
    unknown.write_text(
        'const RESERVED_HELPER_PACKAGE: &str = "_helpers";\n'
        'const RESERVED_LIB_PACKAGE: &str = "_lib";\n'
        "pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[\n"
        '    ("x.py", RESERVED_BRAND_NEW_PACKAGE, "x.py"),\n'
        "\n];\n"
    )
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", unknown)
    with pytest.raises(AssertionError) as exc:
        CODE.py_helper_files()
    assert "RESERVED_BRAND_NEW_PACKAGE" in str(exc.value)

    empty = tmp_path / "empty.rs"
    empty.write_text(
        'const RESERVED_HELPER_PACKAGE: &str = "_helpers";\n'
        'const RESERVED_LIB_PACKAGE: &str = "_lib";\n'
        "pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[\n];\n"
    )
    monkeypatch.setattr(CODE, "_PROCESSORS_RS", empty)
    with pytest.raises(AssertionError) as exc:
        CODE.py_helper_files()
    assert "ZERO entries" in str(exc.value)


def test_the_manifest_helper_reader_raises_on_every_shape_that_returned_nothing(tmp_path):
    """TEST-12 (cont.) — the `run.helpers` reader, and the three silent empties it had.

    Each shape below is VALID YAML that the first cut returned `[]` for, without raising.
    The consequence was identical every time and is the failure the harness module says it
    exists to prevent: a `/code` dir with no `spatial_declarations.py`, and a subprocess
    dying of `ModuleNotFoundError` for a reason with nothing to do with the measurement.
    """
    def helpers(body):
        (tmp_path / "manifest.yaml").write_text(body, encoding="utf-8")
        return CODE.declared_helpers(tmp_path)

    # (a) items at the SAME indent as the key — valid YAML, previously `[]`
    assert helpers("run:\n  helpers:\n  - compute/a.py\n") == ["compute/a.py"]

    # (b) a blank line BETWEEN `run:` and `helpers:`, with a small item indent. The
    #     earlier spelling of this row ("blank lines before `run:`") was a PHANTOM — the
    #     old code returned the right answer for it, because `^` re-anchors under `re.M`
    #     and `(\s*)` cannot backtrack across `run:`. This is the shape that actually
    #     returned `[]`: the captured indent spans the blank line and computes larger than
    #     the real item indent, so the loop breaks on the first item.
    assert helpers("run:\n\n  helpers:\n   - compute/a.py\n") == ["compute/a.py"]

    # (c) a NON-`run:` block's helpers are entry-scoped and must NOT be unioned in
    assert helpers(
        "run:\n  helpers:\n    - compute/a.py\n"
        "verify:\n  helpers:\n    - compute/gate.py\n"
    ) == ["compute/a.py"]

    # (d) and nothing at all RAISES rather than silently staging a smaller /code dir
    with pytest.raises(AssertionError) as exc:
        helpers("id: p\nversion: 1.0.0\n")
    assert "ZERO" in str(exc.value)
