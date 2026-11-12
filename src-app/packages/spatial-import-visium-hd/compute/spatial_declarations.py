#!/usr/bin/env python3
# ruff: noqa
"""spatial_declarations — the WRITE-TIME contract for the spatial kinds (#152 / #174).

`manifest.yaml` beside this file declares the SHAPES. This module declares the FIELDS
that shape cannot carry and that are **unrecoverable from the bytes once artifacts
exist** — so it is executable, not prose. Four of them are the owner-approved
`[FIELD-NOW]` set (#174), realizing §15 of `docs/design/spatial-storage-layout.md`:

1. `measured_entity` — what ONE ROW IS.
2. the always-2-D writer rule — a producer ALWAYS emits `(n × 2)`.
3. `positioning.partial` — a consumer that cannot handle absent positions REFUSES.
4. `section` — recorded now; the section→section transform deliberately undesigned.

Plus the two declarations the kinds need to be readable at all: the coordinate space
(§6.6) — including the `microns_per_pixel` scale a PIXEL space cannot otherwise carry,
without which a neighbour-graph radius in microns is a radius in an arbitrary unit — and,
for `spatial/image`, the display-derivative provenance (#176).

## Why this lives HERE and not in `_lib`

`_lib` is FRAMEWORK code: it is staged into every processor's `/code`, so anything it
names it names on behalf of every producer that will ever exist. `txr_columns.py`'s own
header records what that costs when it is broken — it once defaulted the producer's axis
to a single-cell axis name, i.e. a framework library authoring a domain declaration — and
`scripts/check-derived-vocabulary.sh` now scans it for exactly that. Everything below is
domain vocabulary. It belongs in the domain package, wrapping the framework writer rather
than editing it: `write_spatial_coordinates` calls `txr_columns.write_embedding`
unchanged and adds only DECLARATIONS.

The importer (#154) VENDORS this module verbatim, the way `embedding` vendors
`cell-filter`'s predicate kernel: the platform confines `run.helpers` to a package's OWN
tree, so a kernel cannot be imported across packages.

## Every refusal here is a REFUSAL, never a default

Absence is absence. Where the design says a producer must not write something, this
module raises rather than substituting a plausible value — because every one of these
fields is cheap at write time and impossible to recover afterwards.
"""

# ── measured_entity (INV-3 / §15.1) ──────────────────────────────────────────────────
#
# "One run, one row space" is FALSE for 8 of 17 surveyed platforms. Visium HD emits
# 2 µm (11,222,500 rows), 8 µm (702,244), 16 µm (175,561) bins, H&E-segmented cells AND
# nucleus segmentations from ONE run; Stereo-seq holds bins 1/5/10/20/50/100/150/200
# simultaneously in one file; Open-ST's default run emits beads plus a hex mesh at three
# UMI cutoffs plus segmented cells.
#
# They COEXIST correctly already — each is a distinct key sequence, so the alignment
# digest prevents cross-resolution contamination. That is an undesigned-for strength.
# WHAT BREAKS IS IDENTITY: all three declared bindings are identical across those bins
# (same coordinate space, same run, and the alignment digest is a hash nobody can read),
# so a user tells 8 µm from 16 µm BY ROW COUNT, and cannot tell a 5 µm-expansion cell set
# from a 15 µm one AT ALL — the exact change 10x made between analysis-software versions,
# which alters every cell in the dataset.
#
# The closed vocabulary is the point: an open string would let two producers spell the
# same thing differently and the label would stop being comparable.
MEASURED_ENTITY_KINDS = ("spot", "bin", "bead", "cell", "nucleus")

#: The three sub-keys a `segmentation` block must carry when it is present at all. A
#: partial block is worse than none: "cellpose, parameters unknown" reads as recorded
#: provenance while answering none of the questions provenance is for.
SEGMENTATION_KEYS = ("method", "params", "software_version")

# ── the always-2-D writer rule (INV-2 / §15.2) ───────────────────────────────────────
#
# THE BREAK IS IN DISPATCH, NOT DECODE, and that is what makes it dangerous. The shipped
# coordinates selector is `source: { capabilities: [plottable-xy], dims: 2 }`
# (`single-cell-viz/ui/coordinates.yaml`) and the matcher compares the declared component
# count for EXACT EQUALITY and fails closed
# (`ui/src/modules/workbench/core/runtime/axisSource.ts`). An honest `(n × 3)` artifact —
# the natural encoding for Xenium/MERSCOPE/CosMx/STARmap — would therefore be SILENTLY
# INVISIBLE in the Coordinates section, while the reader underneath is already 3-D
# tolerant. No error, no warning, no artifact: it simply never appears.
#
# So the rule is a REFUSAL at write time, not a convention. Relaxing the UI `dims` filter
# to accept 3 is a separate, later change; until it happens, refusing is strictly better
# than writing something that vanishes.
COORDINATE_COMPONENTS = 2

#: A z value travels as a SIBLING metadata-column with a DECLARED kind — `physical`
#: (micrometres) or `index` (z-plane number) — or it is absent. There is no third option
#: and no default: "z" without a kind is a number whose unit the reader has to guess.
Z_COLUMN_KINDS = ("physical", "index")

# ── the display-derivative policy for spatial/image (INV-10 / #176) ──────────────────
#
# Downsampling and lossy compression are NOT the same thing and must never be conflated.
# Downsampling produces fewer, larger pixels, each a real average of real measurements.
# Lossy compression keeps the pixel count and INVENTS the values. Even for a display-only
# artifact, lossy is refused: someone will eventually zoom a region and read intensity off
# it, and JPEG ringing around a high-contrast edge looks exactly like biology.
# EXACTLY the set #176 names ("lossless only (deflate / LZW)"). `zstd` and `none` are
# also lossless and were in an earlier draft of this list; they are dropped because
# widening an owner-stated set without being asked is how a policy quietly becomes a
# suggestion — and `none` in particular defeats the storage rationale a display
# derivative exists for. Add one by amending #176, not by amending this line.
LOSSLESS_CODECS = ("deflate", "lzw")
LOSSY_CODECS = ("jpeg", "jpg", "jpeg2000", "jp2", "webp", "avif")

#: What a `spatial/image` IS to a consumer choosing between several in one space. Closed
#: for the same reason `MEASURED_ENTITY_KINDS` is: a run legitimately carries more than
#: one image (Visium ships a hires AND a lowres; CytAssist adds a third), and a consumer
#: asking "which one do I display?" must not have to pattern-match a free-form string.
#: `display` is the working image, `overview` a coarser one for a fast first paint, and
#: `alignment` an image acquired to register the others (CytAssist) rather than to be read.
IMAGE_ROLES = ("display", "overview", "alignment")

#: The DEFAULT resolution cap, in micrometres per pixel — a PARAMETER with a default, not
#: a constant. Hard-coding a coarser value to save storage risks a "why does the tissue
#: look mushy" complaint that cannot be fixed without re-importing, and hard-coding this
#: one forecloses a per-platform tune that costs nothing today. At 0.5 µm/pixel a cell is
#: ~30 px across and nuclei are crisp; at 1 µm/pixel a cell is ~15 px — a visible blob,
#: but not crisp — at a quarter of the storage.
DEFAULT_RESOLUTION_CAP_UM = 0.5

#: Keys that would encode a section→section transform. REFUSED inside `section`, on
#: purpose (#175 §2): serial-section registration is frequently NON-LINEAR (PASTE2,
#: STalign), so an affine is INSUFFICIENT — recording one would encode a false precision
#: and mislead every consumer that trusted it. Better to record nothing than a wrong
#: shape. Refusing (rather than merely not defining the key) is what stops a producer
#: smuggling one in as a free-form extra field.
_FORBIDDEN_SECTION_KEYS = (
    "affine", "transform", "to_section", "to_volume", "registration", "warp",
)


class SpatialDeclarationError(ValueError):
    """A producer declaration this contract refuses.

    A distinct type so a caller can tell "the producer declared something impossible"
    from "the array was the wrong dtype" — the first is a bug in the importer, the second
    is a bug in the data it was handed.
    """


def _required_str(value, what):
    if not isinstance(value, str) or not value.strip():
        raise SpatialDeclarationError(
            f"{what}={value!r} is not a declaration — absence is absence (INV-3), and "
            "this contract holds no default for it because the value is unrecoverable "
            "from the bytes once the artifact exists"
        )
    return value


def _number(value, what, *, allow_zero=False):
    """`float(value)`, or the module's own error — never a bare `ValueError`/`TypeError`.

    `SpatialDeclarationError` exists so a caller can tell "the producer declared something
    impossible" from "the array was the wrong dtype", and a raw `float()` defeats that: it
    raises `ValueError` for `"abc"` and `TypeError` for `None`, and because
    `SpatialDeclarationError` subclasses `ValueError`, an importer catching the declared
    type MISSES both. Every numeric coercion in this module goes through here.

    `bool` is refused rather than coerced. `True` is a perfectly good `float(1.0)` in
    Python, so a typo'd flag would land as a 1 µm pitch — a plausible number, silently
    wrong, in a field whose whole job is to be trusted. Non-finite values are refused for
    the same reason: `inf` passes a `> 0` test and means nothing as a measurement.
    """
    import math

    if isinstance(value, bool):
        raise SpatialDeclarationError(
            f"{what}={value!r} is a bool, not a measurement — a flag coerced to 1.0 is a "
            "plausible number and a silently wrong one"
        )
    # A numeric STRING is a parse, not a declaration. `float("0.65")` succeeding would
    # let a producer hand over whatever its JSON happened to hold and call it a
    # measurement; the module's posture everywhere else is to refuse rather than coerce,
    # and a caller that has a string knows it and can convert it deliberately.
    if not isinstance(value, (int, float)):
        raise SpatialDeclarationError(
            f"{what}={value!r} is not a number — pass an int or a float; a numeric string "
            "is a parse the producer should do deliberately, not a declaration"
        )
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise SpatialDeclarationError(f"{what}={value!r} is not a number") from None
    if not math.isfinite(out):
        raise SpatialDeclarationError(
            f"{what}={value!r} is not finite; a measurement cannot be inf or nan"
        )
    if not allow_zero and not out > 0:
        raise SpatialDeclarationError(
            f"{what}={out!r} must be positive — a zero or negative value here is not a "
            "smaller measurement, it is a wrong one"
        )
    return out


def _extent(value, what):
    """A `{width, height}` PIXEL GRID, validated — the one shape, in one place.

    Two callers need it and they must agree exactly: `coordinate_space.extent` (§6.6's raster
    extent, the region the image covers) and `display_derivative_provenance`'s source and
    emitted grids. #176's reconciliation compares those two across the two blocks, so a
    second spelling of the same validation is a second chance for them to disagree about what
    a grid IS.

    `set(extent)` over a LIST yields its ELEMENTS, so `["width", "height"]` used to pass a
    key check and then blow up on the subscript. The mapping is demanded explicitly.
    """
    if not isinstance(value, dict) or set(value) != {"width", "height"}:
        raise SpatialDeclarationError(
            f"{what} is a mapping {{width, height}} (rasters only), got {value!r}"
        )
    return {
        "width": int(_number(value["width"], f"{what}.width")),
        "height": int(_number(value["height"], f"{what}.height")),
    }


def measured_entity(*, kind, platform, resolution_um=None, segmentation=None):
    """Declare WHAT ONE ROW IS — the highest-value field in the spatial set.

    `kind` is one of [`MEASURED_ENTITY_KINDS`]; `platform` is the vendor platform the run
    came off; `resolution_um` is the spot/bin diameter or pitch where the entity has one;
    `segmentation` is present ONLY for a segmented entity and must then carry all of
    [`SEGMENTATION_KEYS`].

    Artifacts that share a run and differ only in this block form a RESOLUTION GROUP —
    which is the thing a user currently cannot see at all.
    """
    kind = _required_str(kind, "measured_entity.kind")
    if kind not in MEASURED_ENTITY_KINDS:
        raise SpatialDeclarationError(
            f"measured_entity.kind={kind!r} is outside the declared vocabulary "
            f"{list(MEASURED_ENTITY_KINDS)}. An open string would let two producers spell "
            "the same entity differently, and the derived label would stop being "
            "comparable across a resolution group — which is the whole point of the field."
        )
    out = {"kind": kind, "platform": _required_str(platform, "measured_entity.platform")}
    if resolution_um is not None:
        out["resolution_um"] = _number(resolution_um, "measured_entity.resolution_um")
    if segmentation is not None:
        if not isinstance(segmentation, dict):
            raise SpatialDeclarationError("measured_entity.segmentation must be a mapping")
        missing = [k for k in SEGMENTATION_KEYS if k not in segmentation]
        if missing:
            raise SpatialDeclarationError(
                f"measured_entity.segmentation is missing {missing} — a partial "
                "segmentation block is worse than none: it reads as recorded provenance "
                "while answering none of the questions provenance is for. A 5 µm and a "
                "15 µm expansion differ in every cell in the dataset, and `params` is "
                "where that difference lives."
            )
        extra = [k for k in segmentation if k not in SEGMENTATION_KEYS]
        if extra:
            raise SpatialDeclarationError(
                f"measured_entity.segmentation carries unknown key(s) {extra}; the block "
                f"is exactly {list(SEGMENTATION_KEYS)}"
            )
        out["segmentation"] = {k: segmentation[k] for k in SEGMENTATION_KEYS}

    # ── THE TWO CASES §15.1 IS ACTUALLY ABOUT ────────────────────────────────────────
    # Making both sub-fields merely optional left the field satisfiable in exactly the two
    # situations it was written for, which is the shape of a rule that reads as enforcement
    # and is not:
    #   * `kind="bin", platform="visium-hd"` with no `resolution_um` — the 8 µm and the
    #     16 µm bin sets then declare IDENTICALLY, and a user is back to telling them apart
    #     by row count.
    #   * `kind="cell", platform="xenium"` with no `segmentation` — a 5 µm and a 15 µm
    #     expansion then declare identically AND have equal row counts, so they are not
    #     distinguishable at all.
    # Neither value is ever unknown at write time: a spot/bin/bead HAS a diameter or pitch,
    # and a segmented cell/nucleus came out of a named method at a named version. So they
    # are REQUIRED for the kinds that have them, rather than encouraged.
    if kind in ("spot", "bin", "bead") and "resolution_um" not in out:
        raise SpatialDeclarationError(
            f"measured_entity.resolution_um is REQUIRED for kind={kind!r} — the diameter "
            "or pitch is the only thing distinguishing one resolution of a run from "
            "another. Without it the 8 µm and 16 µm bin sets of one Visium HD run declare "
            "identically and a user is back to telling them apart by row count, which is "
            "the exact failure this field exists to remove. It is known at write time and "
            "unrecoverable from the bytes afterwards."
        )
    if kind in ("cell", "nucleus") and "segmentation" not in out:
        raise SpatialDeclarationError(
            f"measured_entity.segmentation is REQUIRED for kind={kind!r} — a segmented "
            "entity came out of a named method at a named version with named parameters, "
            "and that is the whole of its identity. A 5 µm-expansion cell set and a 15 µm "
            "one have the SAME row count and differ in every cell; with no segmentation "
            "block they are not distinguishable at all, now or ever."
        )
    return out


def measured_entity_label(entity):
    """The human label for a coordinates artifact, DERIVED FROM THE DECLARATION.

    Never from the row count. That is the whole promise of `measured_entity`: today a
    user distinguishes an 8 µm bin set from a 16 µm one by reading `n`, and cannot
    distinguish two segmentation expansions at all because their row counts are equal.

    Two artifacts with different row counts and the same declaration get the SAME label;
    two with equal row counts and different declarations get DIFFERENT labels.
    """
    if not isinstance(entity, dict) or "kind" not in entity:
        raise SpatialDeclarationError(
            "measured_entity_label: no declaration to derive a label from. Falling back "
            "to the row count is precisely the behaviour this field exists to replace."
        )
    parts = []
    resolution = entity.get("resolution_um")
    if resolution is not None:
        # `4.0` → "4", `0.5` → "0.5": a bin pitch reads as an integer when it is one.
        text = f"{float(resolution):g}"
        parts.append(f"{text} µm {entity['kind']}")
    else:
        parts.append(str(entity["kind"]))
    segmentation = entity.get("segmentation")
    if segmentation:
        detail = str(segmentation.get("method", "")).strip()
        params = segmentation.get("params") or {}
        if isinstance(params, dict) and params:
            rendered = ", ".join(f"{k}={params[k]}" for k in sorted(params))
            detail = f"{detail} ({rendered})" if detail else rendered
        # `software_version` is part of the LABEL, not just of the record. The motivating
        # case in §15.1 is "the exact change 10x made between analysis-software versions,
        # which alters every cell in the dataset" — two runs of the same method with the
        # same parameters at different versions produce different cells. Rendering only
        # method+params would give them the same label, which is the failure this field
        # exists to remove, reintroduced one level down.
        version = str(segmentation.get("software_version", "")).strip()
        if version:
            detail = f"{detail} @ {version}" if detail else version
        if detail:
            parts.append(detail)
    platform = entity.get("platform")
    if platform:
        parts.append(str(platform))
    return " · ".join(parts)


def positioning(*, partial, confidence_column=None):
    """Declare whether EVERY entity has a position (INV-4 / §15.3).

    No platform guarantees it — Slide-tags positions only a subset of nuclei — and a
    reader left to infer it from nulls will infer it wrong on the day the nulls happen to
    be absent from the sample it looked at.
    """
    if not isinstance(partial, bool):
        raise SpatialDeclarationError(
            f"positioning.partial={partial!r} must be an explicit bool. There is no "
            "default: 'probably complete' is the assumption this field exists to remove."
        )
    out = {"partial": partial}
    if confidence_column is not None:
        out["confidence_column"] = _required_str(
            confidence_column, "positioning.confidence_column"
        )
    return out


def require_full_positioning(declaration, *, consumer):
    """REFUSE, do not default, when positions are partial (INV-4).

    A consumer that cannot handle absent positions must say so and stop. Substituting a
    centroid, a zero, or "the ones we have" turns a stated gap into invented data — and
    the invented rows are indistinguishable from measured ones downstream.
    """
    if not isinstance(declaration, dict) or "partial" not in declaration:
        raise SpatialDeclarationError(
            f"{consumer}: the coordinates carry no `positioning` declaration, so whether "
            "every entity is placed is UNKNOWN. Unknown is not complete."
        )
    if declaration["partial"]:
        column = declaration.get("confidence_column")
        hint = (
            f" A per-entity confidence is available as `{column}`."
            if column else ""
        )
        raise SpatialDeclarationError(
            f"{consumer}: these coordinates are declared PARTIAL — not every entity has "
            "a position — and this consumer cannot represent an absent position. "
            "Refusing rather than defaulting: absence is absence." + hint
        )


def section(*, sample_id, index, z_offset_um=None, **forbidden):
    """Declare which section of a sample this is (INV-5 / §15.4).

    `coordinate_space` names ONE frame; it cannot express several sections of one sample
    intended to align into a volume. Recording the section is free at write time and
    unrecoverable later.

    The section→section TRANSFORM is deliberately not part of this — see
    [`_FORBIDDEN_SECTION_KEYS`]. Any keyword that would encode one is refused by name.
    """
    offenders = sorted(k for k in forbidden if k.lower() in _FORBIDDEN_SECTION_KEYS)
    if offenders:
        raise SpatialDeclarationError(
            f"section: {offenders} would encode a section-to-section transform, which is "
            "DELIBERATELY not designed. Serial-section registration is frequently "
            "non-linear (PASTE2, STalign), so an affine is insufficient — recording one "
            "would encode a false precision and mislead every consumer that trusted it. "
            "Recording nothing is better than recording a wrong shape."
        )
    if forbidden:
        raise SpatialDeclarationError(
            f"section: unknown key(s) {sorted(forbidden)}; the block is "
            "{sample_id, index, z_offset_um?}"
        )
    if not isinstance(index, int) or isinstance(index, bool):
        raise SpatialDeclarationError(
            f"section.index={index!r} must be an integer ordinal within the series"
        )
    out = {"sample_id": _required_str(sample_id, "section.sample_id"), "index": index}
    if z_offset_um is not None:
        out["z_offset_um"] = _number(z_offset_um, "section.z_offset_um",
                                     allow_zero=True)
    return out


def coordinate_space(*, space, unit, to_space, extent=None,
                     microns_per_pixel=None, microns_per_pixel_source=None,
                     coordinate_space_source=None):
    """The coordinate-space declaration every spatially-placed artifact carries (§6.6).

    `to_space` is a 2x3 row-major affine mapping THIS artifact into `space`. It is the
    same shape the canvas already reads, so this populates a socket that is already
    shaped for it.

    ## `microns_per_pixel` — the scale a PIXEL space has no way to carry otherwise

    A `unit: "pixel"` space says where things are relative to each other and NOTHING about
    how big they are. That is fatal one step downstream: the spatial neighbour graph that
    roughly two thirds of all spatial analyses are built on takes a radius in MICRONS, and
    a radius applied to pixel coordinates with no scale is a radius in an arbitrary unit.
    Every neighbourhood, colocalization and spatially-variable-gene result computed that
    way inherits a meaningless scale, and none of them can tell.

    It is free at write time — the vendor ships it (Visium's `scalefactors_json.json`,
    which the importer already opens for the affine) — and unrecoverable from the bytes
    afterwards, which puts it in the same class as `measured_entity` and `section`.

    It is OPTIONAL, and that is deliberate: a genuinely unknown scale must be
    EXPRESSIBLE. What is refused is inventing one. There is no default of 1.0 — a
    fabricated scale is indistinguishable from a measured one downstream, which is the
    whole failure this field exists to prevent — so absence stays absence and a consumer
    that needs microns calls [`require_micron_scale`] and REFUSES.

    For `unit: "micrometre"` the coordinates are already microns, so the field is not
    merely unnecessary but wrong to state: it is refused there rather than ignored, and
    [`require_micron_scale`] answers `1.0` for such a space by definition.

    ## `microns_per_pixel_source` / `coordinate_space_source` — provenance, HERE

    Both are optional strings naming WHICH derivation produced the value beside them.
    They live in this block rather than being added to `meta` afterwards for one reason,
    and it is not tidiness: a value and the record of where it came from are a PAIR, and a
    channel that carries one without the other hands a consumer a number it cannot audit.
    The importer already says why the record matters — *"Without it a stated number and a
    derived one are indistinguishable downstream, which is the property
    `require_micron_scale` exists to protect"* — and after #211 this block is what crosses
    into the sandbox, so a provenance bolted on outside it is a provenance no analysis can
    see. Relevant to #222, where two vendor files disagree with the shipped constant: a
    consumer can now tell which leg produced the scale it is about to use.

    `microns_per_pixel_source` names which leg was TRIED, which deliberately INCLUDES the
    leg that found nothing — but ONLY through the sentinel
    [`SCALE_SOURCE_UNAVAILABLE`]. That pairing is not a claim that a scale exists, it is
    the record that one was looked for and is not available, and a consumer chasing #222
    wants exactly that. Any OTHER source string without a `microns_per_pixel` is REFUSED:
    `microns_per_pixel_source="vendor"` beside no scale asserts that the vendor stated a
    number and then states none, which an auditor reads as a successful derivation that
    produced nothing. Nothing can be fabricated by any of it — `require_micron_scale`
    reads the VALUE, never the source — but a provenance record that lies about its own
    outcome is worse than no record.

    What IS refused is a scale source on a `micrometre` space. There a scale is not a
    missing value, it is a category error — the coordinates are already microns — so
    naming a leg that produced one describes a derivation that cannot have happened. Same
    reason the value itself is refused for that unit rather than ignored.
    """
    if unit not in ("micrometre", "pixel"):
        raise SpatialDeclarationError(
            f"coordinate_space.unit={unit!r} must be 'micrometre' or 'pixel' — a length "
            "with no unit is the bug this declaration exists to prevent"
        )
    try:
        affine = list(to_space)
    except TypeError:
        raise SpatialDeclarationError(
            f"coordinate_space.to_space={to_space!r} is not a sequence of 6 numbers"
        ) from None
    if len(affine) != 6:
        raise SpatialDeclarationError(
            f"coordinate_space.to_space needs 6 numbers (a 2x3 row-major affine), got "
            f"{len(affine)}"
        )
    out = {
        "coordinate_space": _required_str(space, "coordinate_space.space"),
        "unit": unit,
        # An affine legitimately contains zeros and negatives (a flip, a pure
        # translation), so these are checked for FINITENESS only.
        "to_space": [_number(v, "coordinate_space.to_space[]", allow_zero=True)
                     for v in affine],
    }
    if extent is not None:
        out["extent"] = _extent(extent, "coordinate_space.extent")
    if microns_per_pixel is not None:
        if unit != "pixel":
            raise SpatialDeclarationError(
                f"coordinate_space.microns_per_pixel is meaningless for unit={unit!r} — "
                "the coordinates are already in microns. Stating a scale for a space that "
                "has none invites a consumer to apply it twice."
            )
        out["microns_per_pixel"] = _number(
            microns_per_pixel, "coordinate_space.microns_per_pixel"
        )
    if microns_per_pixel_source is not None:
        # UNIT FIRST. On a `micrometre` space there is no scale to source AND none may be
        # declared, so the sentinel rule below would fire on the wrong ground and give a
        # message about a missing value when the real fault is the unit.
        if unit != "pixel":
            raise SpatialDeclarationError(
                f"coordinate_space.microns_per_pixel_source is meaningless for "
                f"unit={unit!r} — the coordinates are already in microns, so no leg "
                "produced a pixel scale and naming one describes a derivation that cannot "
                "have happened. Absence is said by the key not being there."
            )
        if microns_per_pixel is None and microns_per_pixel_source != SCALE_SOURCE_UNAVAILABLE:
            raise SpatialDeclarationError(
                f"coordinate_space.microns_per_pixel_source={microns_per_pixel_source!r} "
                "names a leg that PRODUCED a scale, but no `microns_per_pixel` is "
                f"declared. Only {SCALE_SOURCE_UNAVAILABLE!r} — the record that a scale "
                "was looked for and is not available — may stand without a value; any "
                "other source beside no value reads downstream as a successful derivation "
                "that produced nothing."
            )
        out["microns_per_pixel_source"] = _required_str(
            microns_per_pixel_source, "coordinate_space.microns_per_pixel_source"
        )
    if coordinate_space_source is not None:
        out["coordinate_space_source"] = _required_str(
            coordinate_space_source, "coordinate_space.coordinate_space_source"
        )
    return out


def require_micron_scale(space, *, consumer):
    """The micron scale of `space`, or REFUSE — never a fabricated 1.0.

    A consumer that measures in microns (a neighbour graph radius, a bin pitch, a
    distance threshold) calls this instead of reading the field. For a `micrometre` space
    the answer is `1.0` BY DEFINITION; for a `pixel` space it is the declared
    `microns_per_pixel`; and for a pixel space that declares none, there is no answer and
    this raises.

    Refusing is the whole point. Defaulting to 1.0 would silently turn "a 30 µm
    neighbourhood" into "a 30 pixel neighbourhood" — off by whatever the real scale is,
    with a plausible-looking number at the end and nothing anywhere saying so. Same rule
    as `positioning.partial`: absence is absence, and a consumer that cannot represent it
    stops.
    """
    if not isinstance(space, dict) or "unit" not in space:
        raise SpatialDeclarationError(
            f"{consumer}: no coordinate-space declaration, so the unit of these positions "
            "is unknown. Unknown is not microns."
        )
    if space["unit"] == "micrometre":
        return 1.0
    scale = space.get("microns_per_pixel")
    if scale is not None:
        # THROUGH `_number`, not a bare `float()`. Until #211 this dict was always built
        # by `_number` in the same process, so re-checking was redundant. Now it may be
        # JSON parsed off a staged store, and none of those refusals travel with it:
        # measured, `microns_per_pixel: true` came back through a bare `float()` as
        # exactly **1.0** — a fabricated scale, from the one function whose whole purpose
        # is that no 1.0 is ever fabricated. `"0.65"`, `0.0`, `-3` and `NaN` came back as
        # themselves.
        #
        # Checked HERE and not only in `_validated_declaration_block` because
        # `read_spatial_declarations` is public and returns the block unvalidated: a
        # guard that only covers the careful path is the shape this module exists to
        # refuse. This is the one place every scale must pass through.
        try:
            return _number(scale, "microns_per_pixel")
        except SpatialDeclarationError as exc:
            # Re-phrased for a CONSUMER. `_number`'s messages are written for a producer
            # at write time ("pass an int or a float"), and a sandboxed analysis cannot
            # pass anything — the fault is in the artifact it was handed, which is what it
            # needs to be told.
            raise SpatialDeclarationError(
                f"{consumer}: this artifact's declared micron scale is not a usable "
                f"measurement ({exc}). Refusing rather than coercing it: a bool, a numeric "
                "string, a zero or a negative all become plausible numbers under a bare "
                "`float()`, and a plausible number is what this contract exists to prevent."
            ) from exc
    raise SpatialDeclarationError(
        f"{consumer}: these coordinates are in PIXELS and declare no `microns_per_pixel`, "
        "so a radius or distance in microns cannot be converted. Refusing rather than "
        "assuming 1.0: a fabricated scale is indistinguishable from a measured one "
        "downstream, and every neighbourhood, colocalization and spatially-variable-gene "
        "result computed from it would inherit a meaningless scale with no way to tell. "
        "The vendor ships this number (Visium's `scalefactors_json.json`); re-import with "
        "it rather than guessing."
    )


def z_column(*, name, kind, values):
    """Declare the SIBLING metadata-column a z value travels in (INV-2 / DEC-10).

    Never a third component of the coordinates member.

    `values` is REQUIRED, and that is the half of the rule that is easy to lose. §15.2 and
    #175 §3 state "never write `z = 0` for a 2-D platform" UNCONDITIONALLY; making the
    values optional would have left the check opt-in, so a producer who simply never
    passed them could declare a z column full of zeros and nothing would notice. A producer
    HAS the array at write time — it is writing it — so requiring it costs nothing and is
    the only way the refusal is reachable on every path. An all-zero z is not a
    measurement; it is a placeholder a later reader cannot tell from one, so the column is
    refused and omitted instead. Absence stays absence.
    """
    kind = _required_str(kind, "z_column.kind")
    if kind not in Z_COLUMN_KINDS:
        raise SpatialDeclarationError(
            f"z_column.kind={kind!r} must be one of {list(Z_COLUMN_KINDS)} — 'physical' "
            "is micrometres, 'index' is a z-plane number, and there is no third meaning a "
            "reader could infer from the numbers alone"
        )
    if values is None:
        raise SpatialDeclarationError(
            "z_column: `values` is required. The rule this declaration exists to enforce "
            "is a property OF THE VALUES (never an all-zero z for a 2-D platform), so a "
            "declaration made without them enforces nothing. A producer has the array at "
            "write time; if it does not, there is no z column to declare."
        )
    seq = list(values)
    if not seq:
        raise SpatialDeclarationError(
            "z_column: `values` is empty — an empty column is not a z, it is an absence, "
            "and absence is spelled by omitting the column"
        )
    if all(_number(v, "z_column.values[]", allow_zero=True) == 0.0 for v in seq):
        raise SpatialDeclarationError(
            "z_column: every z is 0, which is a 2-D platform wearing a third "
            "dimension. Never write z = 0 for a 2-D platform — omit the column. "
            "Absence stays absence (INV-3). This applies to kind='index' as well as "
            "kind='physical': an acquisition with one z-plane is a 2-D acquisition, and "
            "a column of zeros says nothing a reader could not get from the column's "
            "own absence."
        )
    return {"name": _required_str(name, "z_column.name"), "kind": kind}


#: Subtracted from the cap ratio before `ceil`, so a source sitting EXACTLY at the cap is a
#: pass-through instead of a factor-2 downsample.
#:
#: This is not defensive noise. `cap / original` for two mathematically equal floats can land
#: at `1.0000000000000002`, and `ceil` of that is 2 — so without this an image already at
#: exactly the declared cap would be halved, and the artifact would record a real downsample
#: nobody asked for. 1e-9 is many orders of magnitude below any real resolution ratio (the
#: finest instrument here is ~0.2 µm/pixel against caps around 0.5) and many orders above
#: float64 round-off at these magnitudes, so it cannot swallow a genuine sub-factor either.
_CAP_RATIO_EPSILON = 1e-9


def downsample_factor(original_resolution_um, resolution_cap_um):
    """The INTEGER factor that brings `original` to at least `cap` µm/pixel (#176).

    Resolution is MICROMETRES PER PIXEL, so SMALLER is finer and the cap is a "no finer
    than" bound. `1` means pass-through.

    ## Why an integer, and why the SMALLEST one

    An integer factor is what makes every emitted pixel the mean of a WHOLE block of source
    pixels. A fractional factor needs interpolation, which computes values at positions
    between source pixels — i.e. it INVENTS them, which is the line `LOSSY_CODECS` draws and
    the reason a display derivative can be called lossless at all: it produces "fewer, larger
    pixels, each a real average of real measurements".

    `ceil` rather than `floor` because the cap is a bound the result must SATISFY: flooring
    would leave the image finer than the cap. Among the integers that satisfy it, the
    smallest discards the least, so `ceil` is also the minimal-loss choice.

    The consequence is stated rather than hidden: the achieved resolution generally
    OVERSHOOTS the cap (0.2 µm/pixel at a 0.5 cap lands at 0.6, not 0.5). That is exactly why
    `applied_resolution_um` records `original * factor` and not the cap — see
    [`display_derivative_provenance`].

    ## Why the ratio's finiteness is checked, and what it costs not to

    `cap / original` OVERFLOWS TO `inf` for a subnormal `original` (below ~2.8e-309), and
    `int(math.ceil(inf))` raises `OverflowError` — which is in NEITHER `emit_images`' except
    tuple NOR `main()`'s, so ONE damaged vendor number would abort the WHOLE import: no
    matrix, no coordinates, no columns, no report, no manifest.

    That is not hypothetical and it is not new: `emit_images`' own handler records having
    already fixed this exact class once, for the scalefactor — *"Round 1 added
    `math.isfinite` to the scalefactor guard and still aborted the entire import on a
    SUBNORMAL scalefactor (1e-320 is finite and positive; 1/1e-320 is `inf`), because the
    failure is in the DERIVED quantity, not the input."* Both inputs here are finite and
    positive and pass every guard upstream; the derived RATIO is what overflows. The
    refusal below is `SpatialDeclarationError`, which the producer already catches, so a
    damaged number costs one image and not the import.
    """
    import math

    original = _number(original_resolution_um, "original_resolution_um")
    cap = _number(resolution_cap_um, "resolution_cap_um")
    ratio = cap / original
    if not math.isfinite(ratio):
        raise SpatialDeclarationError(
            f"a {original!r} um/pixel source against a {cap:g} um/pixel cap needs a "
            "downsample factor that is not a finite number — the source resolution is "
            "subnormal, so no integer factor brings it to the cap and no image could be "
            "emitted from it anyway. Refusing here, as this module's own error type, so "
            "one damaged vendor number costs one image rather than the whole import."
        )
    return max(1, int(math.ceil(ratio - _CAP_RATIO_EPSILON)))


def applied_resolution(original_resolution_um, factor):
    """The resolution `factor` ACHIEVES on a source at `original_resolution_um`.

    Three lines, and it exists as a function for one reason: `downsample_plan` and
    `display_derivative_provenance` both compute this number, leg 4 of
    `write_ome_tiff`'s reconciliation REQUIRES the two to be equal, and two spellings of one
    formula is precisely how they stop being.

    No overflow guard, and that is deliberate rather than an omission. An earlier revision
    wrapped this in `_number` "in case a very large factor overflows to inf" — which cannot
    happen: `factor = max(1, ceil(cap/original - eps))` bounds the product below
    `cap + original`, so it is finite for every finite positive pair, and a large source
    yields factor 1 rather than a large factor. A guard whose stated case is arithmetically
    unreachable is a declaration nothing can satisfy, which this tree removes on sight; the
    reachable pathologies are caught upstream by `downsample_factor`'s finiteness check and
    downstream by the sub-one-pixel refusal.

    The PRODUCT is still validated, and that is a different guarantee from the one removed.
    The old line validated the product incidentally, and dropping it silently also dropped
    `_number`'s zero/negative refusal — so a factor of 0 or -1 would have returned a 0.0 or
    negative resolution rather than raising. Both in-tree callers take their factor from
    `downsample_factor`, which is `max(1, ...)`, so neither is reachable today; the check is
    kept because this is a public helper and "unreachable through today's callers" is not a
    property of the function.
    """
    original = _number(original_resolution_um, "original_resolution_um")
    if not isinstance(factor, int) or isinstance(factor, bool) or factor < 1:
        raise SpatialDeclarationError(
            f"applied_resolution: factor {factor!r} must be an integer >= 1 (1 means the "
            "image passed through untouched)"
        )
    return _number(original * factor, "applied_resolution_um")


def display_derivative_provenance(*, original_resolution_um, original_extent, original_source,
                                  codec, tifffile_version,
                                  resolution_cap_um=DEFAULT_RESOLUTION_CAP_UM):
    """Provenance for a `spatial/image` (INV-10 / #176).

    Without this a reader cannot tell a display derivative from a source image, which is
    the difference between "these pixels are what the instrument measured" and "these
    pixels are an average the importer chose".

    `resolution_cap_um` is a PARAMETER with a default, never a constant. A source already
    coarser than the cap PASSES THROUGH — it is never upsampled — and the recorded
    `applied_resolution_um` says which happened.

    ## `applied_resolution_um` is the ACHIEVED resolution, NEVER the cap

    This is the whole of #176 in one field, and it used to be wrong. The earlier shape
    recorded `applied = original if original >= cap else cap` — on the downsampling branch, a
    resolution the pixels are **not required to have**. Because the factor is an integer it
    generally overshoots (0.2 µm/pixel at a 0.5 cap lands at 0.6), so recording the cap would
    misstate the real pixel pitch by 20% on the very first image finer than the cap, and every
    downstream micron measurement would inherit the error silently. A downsampled image whose
    declared scale still describes something other than its own pixels is worse than no
    downsampling at all.

    The old value was never observable in an artifact — the producer refused before reaching
    that branch (#155's `refuse_if_finer_than_cap`, whose refusal text named this issue) — so
    nothing on disk carries it. That is what made the correction safe, not an argument that it
    was right.

    ## Why the source GRID is required, not optional

    `original_extent` is the source's own pixel grid, and `emitted_extent` is derived from it
    by floor division. Together they are the only recorded fact anchored to a pixel COUNT
    rather than to another declaration, which is what lets
    `ome_writer.write_ome_tiff` — the one place the pixels and the declaration are both in
    scope — check that the grid really shrank by the factor this block claims.

    Required for the reason `z_column` gives for requiring its values: a producer HAS the
    array at write time, so requiring it costs nothing, and it is the only way the check is
    reachable on every path. Optional, a producer that simply never passed it would skip the
    one pixel-anchored leg in silence.

    ## `original_source` — where the original is preserved

    The vendor member basename these pixels were derived FROM. The source itself is not
    re-emitted: it stays in the uploaded bundle container, whose own declaration states
    *"The bundle is retained after import, so the vendor's own image files stay
    recoverable"* — and says, in the same breath, that Space Ranger ships no full-resolution
    image, so what is recoverable is the SOURCE the derivative was built from and not the
    instrument's pixels. (That sentence was itself corrected on this branch; this quote is
    kept in sync with it deliberately, because a stale verbatim quote of a declaration is
    indistinguishable from the declaration still saying it.) Re-emitting a 5–50 GB source image as a second artifact would put back
    exactly the bytes design §8.2's ingest cap exists to keep out, at double the storage, for
    a consumer §8.2 says does not exist.

    A basename rather than a path or a URL because basename IS the address in this system —
    the bundle container matches its members by basename and refuses an ambiguous match. A
    staged `/inputs/...` path would be a run-local string meaningless to a later reader.
    [`require_original_reference`] is the consumer-side reach.
    """
    codec_name = _required_str(codec, "codec").lower()
    if codec_name in LOSSY_CODECS:
        raise SpatialDeclarationError(
            f"codec={codec!r} is lossy and is refused for a tissue image. Downsampling and "
            "lossy compression are not the same thing: downsampling produces fewer, larger "
            "pixels, each a real average of real measurements, while lossy compression "
            "keeps the pixel count and invents the values. Someone will eventually zoom a "
            "region and read intensity off it, and JPEG ringing around a high-contrast "
            f"edge looks exactly like biology. Use one of {list(LOSSLESS_CODECS)}."
        )
    if codec_name not in LOSSLESS_CODECS:
        raise SpatialDeclarationError(
            f"codec={codec!r} is not a declared lossless codec {list(LOSSLESS_CODECS)}; "
            "an unrecognised codec cannot be asserted to be lossless"
        )
    original = _number(original_resolution_um, "original_resolution_um")
    cap = _number(resolution_cap_um, "resolution_cap_um")
    source_grid = _extent(original_extent, "original_extent")
    # Resolution here is MICROMETRES PER PIXEL, so SMALLER is finer. A source finer than
    # the cap (Xenium's ~0.2 µm/pixel against a 0.5 cap) is downsampled TOWARD the cap by a
    # whole-number factor; a source already coarser than it (Visium's
    # `tissue_hires_image.png`) PASSES THROUGH unchanged — upsampling it would manufacture
    # pixels to hit a number.
    factor = downsample_factor(original, cap)
    applied = applied_resolution(original, factor)
    # FLOOR, because the ragged final row/column is DROPPED and never padded or replicated —
    # replicating would invent a measurement. Inherited from `ome_writer._halved`, which made
    # the same choice for the same reason; one rule, not two.
    emitted = {"width": source_grid["width"] // factor,
               "height": source_grid["height"] // factor}
    # THE CAP IS A BOUND THE RESULT MUST SATISFY, and this is the only place that says so.
    # `write_ome_tiff`'s reconciliation cannot: it checks that the affine, the OME header,
    # the grid and `applied_resolution_um` all AGREE, and a factor chosen by `floor` instead
    # of `ceil` leaves all four agreeing — on a resolution finer than the declared cap. The
    # artifact would then be internally perfect and in violation of the one policy the block
    # exists to record. (Measured, not assumed: it is a mutation in
    # `test_downsample_mutations.py`, and it was INVISIBLE to every other guard.)
    #
    # The epsilon is the same one `downsample_factor` uses and for the same reason: a source
    # sitting exactly at the cap is a pass-through, and `original` may then be a hair under
    # `cap` in float terms.
    if applied < cap * (1.0 - _CAP_RATIO_EPSILON):
        raise SpatialDeclarationError(
            f"a {original:g} um/pixel source at factor {factor} lands at {applied:g} "
            f"um/pixel, which is FINER than the {cap:g} um/pixel cap the block declares. "
            "The cap is a no-finer-than bound, so the factor must round UP; a block that "
            "records a cap it does not meet is a policy statement nothing enforced."
        )
    if emitted["width"] < 1 or emitted["height"] < 1:
        raise SpatialDeclarationError(
            f"a {original:g} um/pixel source of {source_grid['width']}x"
            f"{source_grid['height']} pixels needs a downsample factor of {factor} to reach "
            f"the {cap:g} um/pixel cap, which leaves {emitted['width']}x{emitted['height']} "
            "pixels — not an image. Refusing rather than reconciling it: clamping the factor "
            "would emit pixels FINER than the declared cap (a false claim in the one block a "
            "reader uses to tell measured pixels from averaged ones), and a 1x1 image is a "
            "measurement nobody can use wearing a valid artifact's shape."
        )
    return {
        "is_display_derivative": True,
        "original_resolution_um": original,
        "original_extent": source_grid,
        "original_source": _required_str(original_source, "original_source"),
        "resolution_cap_um": cap,
        "downsample_factor": factor,
        "applied_resolution_um": applied,
        "emitted_extent": emitted,
        "downsampled": factor != 1,
        "codec": codec_name,
        "lossless": True,
        "writer_version": _required_str(tifffile_version, "tifffile_version"),
    }


def require_original_reference(meta, *, consumer):
    """Where a `spatial/image`'s SOURCE is, or REFUSE (INV-2 / #176).

    A `spatial/image` is a DISPLAY DERIVATIVE: its pixels may be an average the importer
    computed, not the ones it was given. A consumer that needs the source pixels — an
    intensity readout, a re-registration, a re-import at a different cap — calls this
    instead of reading the derived raster as if it were the source.

    Returns `{member, extent, resolution_um, downsample_factor}`: the vendor member basename
    the source is preserved under (inside the retained upload bundle), that source's pixel
    grid, its resolution in µm/pixel, and by how much these pixels were reduced.

    ## "the source", NOT "the full-resolution original" — the distinction is not pedantry

    This used to say "the FULL-RESOLUTION original", and for the one platform that ships
    today that was FALSE. A Space Ranger `outs/` bundle contains no full-resolution image at
    all: `tissue_hires_image.png` is 10x's OWN 0.2x downscale and `tissue_lowres_image.png`
    its 0.06x one. So the member named here is itself a vendor derivative — for the lowres
    image, the most degraded file in the bundle — and calling it the instrument's
    measurement would be the same class of fabricated claim the whole display-derivative
    block exists to prevent.

    ## AND THE POINTER IS NOT A RETENTION GUARANTEE FOR EVERY MEMBER

    `spatial/visium-bundle` declares FOUR members — the matrix, the positions table, the
    scalefactors and `tissue_hires_image.png`. **`tissue_lowres_image.png` is NOT among
    them.** The importer emits an artifact from it when it is present, so this function can
    return it, and nothing in the container declaration requires that file to have been
    uploaded or retained. What is promised is the member NAME the pixels came from; whether
    that file is still there is a property of the bundle a consumer must check, which is why
    the returned value is a name to resolve rather than a handle. Recorded rather than
    papered over — closing it means declaring the optional images as members, which is a
    change to the upload container and not to this function.

    What this promises is exactly what it can: **the file these pixels were derived FROM,
    which is preserved and reachable.** Whether that file is the instrument's raw output is
    a property of the vendor bundle, not of this system, and is not claimed here. On a
    platform that does ship its full-resolution raster (Xenium's morphology OME-TIFF, #162)
    the same pointer resolves to it.

    ## Refusing is the point, and it is the same rule as `require_micron_scale`

    An image carrying NO display-derivative block is one whose resolution could never be
    evaluated — the bundle declared no micron scale, so the cap could not be applied and
    nothing was downsampled. Its pixels are the vendor's, but this function will not SAY so,
    because "no provenance" and "provenance says untouched" are different facts and
    conflating them is how a fabricated claim gets made. Absence stays absence: a consumer
    that needs the source stops here rather than being handed the derived raster with an
    implicit promise that it is the source.

    ## It accepts a DECODED PLACEMENT as well as a catalog `meta`

    Because for an `opaque` kind the OME-XML payload is the ONLY channel that reaches a
    sandboxed consumer (`encode_placement`), and a consumer that cannot tell it is holding
    averages is exactly the consumer this refusal was written for. `display_derivative` is
    therefore carried in that payload too, and `decode_placement`'s result works here
    unchanged.
    """
    if not isinstance(meta, dict):
        raise SpatialDeclarationError(
            f"{consumer}: no image declaration, so there is nothing that says where the "
            "source of these pixels is."
        )
    derivative = meta.get("display_derivative")
    if not isinstance(derivative, dict) or "original_source" not in derivative:
        raise SpatialDeclarationError(
            f"{consumer}: this `spatial/image` carries no display-derivative provenance, so "
            "nothing here says whether its pixels are the ones the importer was given or an "
            "average of them, nor where its source is. Refusing rather than handing back "
            "this raster as if it were the source: an image is emitted without provenance "
            "only when its resolution could not be evaluated at all (the bundle declared no "
            "micron scale), and 'unknown' is not 'untouched'. Re-import with a micron "
            "scale, or read the source out of the retained upload bundle directly."
        )
    # EVERY key is checked, and a missing one is refused as THIS module's error type.
    # Subscripting them directly raised `KeyError` for a partial block — a type a consumer
    # catching the declared error misses entirely, in a function whose entire contract is
    # "returns a reference or raises `SpatialDeclarationError`".
    missing = [k for k in ("original_source", "original_extent", "original_resolution_um",
                           "downsample_factor") if k not in derivative]
    if missing:
        raise SpatialDeclarationError(
            f"{consumer}: this image's display-derivative provenance is missing {missing} "
            "and so cannot say where its source is or how far these pixels are from it. "
            "Build the block with `display_derivative_provenance()` rather than by hand."
        )
    return {
        "member": derivative["original_source"],
        "extent": dict(derivative["original_extent"]),
        "resolution_um": derivative["original_resolution_um"],
        "downsample_factor": derivative["downsample_factor"],
    }


def _revalidated(builder, value, what):
    """Re-run `value` through the constructor that owns it, and refuse anything it refuses.

    THIS IS THE ENFORCEMENT, and a presence check is not a substitute for it. The
    constructors above are where the vocabulary is closed, the sub-blocks are made
    complete, and a section→section transform is refused by name — but a producer reaches
    the artifact through `coordinates_meta`, not through them. Checking only that a key
    exists lets a raw dict carry `kind: "voxel"`, `partial: 0`, or a `transform` key
    straight into the artifact, i.e. every rule stated above enforced nowhere on the path
    that actually writes. Re-constructing is cheap (these are small dicts), it is
    idempotent by construction, and it makes the constructor the ONE place the rules live.
    """
    if not isinstance(value, dict) or not value:
        raise SpatialDeclarationError(
            f"coordinates_meta: `{what}` is required and must be a non-empty mapping "
            f"built by this module's constructor — see `{builder.__name__}()`."
        )
    try:
        return builder(**value)
    except TypeError as exc:
        # An unexpected/absent keyword means the dict is not this block's shape. Surfaced
        # as the module's own error type so a caller can catch one thing.
        raise SpatialDeclarationError(
            f"coordinates_meta: `{what}` is not the shape `{builder.__name__}()` "
            f"produces ({exc}). Build it with the constructor rather than by hand — that "
            "is where the vocabulary is closed and the forbidden keys are refused."
        ) from exc


def coordinates_meta(*, space, entity, placement, series, z=None):
    """Assemble the `meta` a `spatial/coordinates` output entry carries.

    `space`, `entity`, `placement` and `series` are ALL REQUIRED — the coordinate space,
    what one row is, whether every row has a position, and which section of which sample
    it is. Every one of them is cheap at write time and unrecoverable from the bytes
    afterwards, which is the entire reason the four `[FIELD-NOW]` fields exist; `series`
    is required for the same stated reason as the other three, rather than being the one
    of the four that a producer may silently skip.

    Each block is RE-VALIDATED through its constructor (see [`_revalidated`]), so the rules
    those constructors state are enforced on the path that actually writes an artifact and
    not merely on the path a careful producer chooses.
    """
    validated_space = _revalidated(coordinate_space, _space_kwargs(space), "space")
    meta = dict(validated_space)
    validated_entity = _revalidated(measured_entity, entity, "entity")
    meta["measured_entity"] = validated_entity
    meta["measured_entity_label"] = measured_entity_label(validated_entity)
    meta["positioning"] = _revalidated(positioning, placement, "placement")
    meta["section"] = _revalidated(section, series, "series")
    if z is not None:
        # `z_column` needs the VALUES to check the zero-fill rule, and a declaration that
        # has already been through it carries only `{name, kind}`. Re-checking the closed
        # `kind` vocabulary is what is left to verify here.
        if not isinstance(z, dict) or set(z) != {"name", "kind"}:
            raise SpatialDeclarationError(
                "coordinates_meta: `z` must be the declaration `z_column()` returns "
                "(`{name, kind}`) — build it there, where the values are checked"
            )
        if z["kind"] not in Z_COLUMN_KINDS:
            raise SpatialDeclarationError(
                f"coordinates_meta: z kind {z['kind']!r} is outside {list(Z_COLUMN_KINDS)}"
            )
        meta["z_column"] = dict(z)
    return meta


def image_meta(*, space, derivative=None, role=None, source=None):
    """Assemble the `meta` a `spatial/image` output entry carries (§6.6).

    The image half of [`coordinates_meta`]. `space` is the flat block
    [`coordinate_space`] returns and is RE-VALIDATED through it (see [`_revalidated`]), so
    the affine's shape is enforced on the path that actually writes an artifact and not
    merely on the path a careful producer chooses.

    ## `extent` is REQUIRED here, unlike on a coordinates artifact

    §6.6 marks it "rasters only", and this is the raster. An affine alone says where the
    image's ORIGIN lands and NOTHING about how far it extends, so without the extent a
    consumer cannot compute the region the image covers, cannot lay two images out
    against each other, and — the case §7.3 rule 5 names — cannot tell a correct image
    from a transposed one. It is known at write time (it is the array's own shape) and
    unrecoverable from the declaration afterwards.

    ## The affine's DIRECTION is this artifact -> the space

    `to_space` maps THIS image into `coordinate_space`, i.e. the INVERSE of the vendor's
    scalefactor: `[1/s, 0, 0, 0, 1/s, 0]` for `s = tissue_hires_scalef`. Written down
    because the in-tree `multimodal.py:423-429` `visium_affine(s)` returns the FORWARD
    `[s,0,0,0,s,0]`, and §7.3 flags the two as "a one-line difference that is wrong for a
    year if nobody writes it down". The inverse is the direction that COMPOSES: N images,
    one space, every pair placeable.

    `derivative` is the block [`display_derivative_provenance`] returns, and it is
    re-validated by RECONSTRUCTING it from its own recorded inputs and demanding the
    result match. A presence check would let a hand-edited `lossless: True` ride on a
    `jpeg` straight into the artifact — i.e. the one policy this contract exists to
    enforce, enforced nowhere on the path that writes.

    ## What that re-construction does NOT catch — stated so it is not over-read

    The block is checked against ITSELF, never against the bytes or against the codec
    actually handed to the writer. So it catches every tampered DERIVED field
    (`is_display_derivative`, `downsample_factor`, `applied_resolution_um`, `emitted_extent`,
    `downsampled`, `lossless`) and the headline case of a lossy codec wearing
    `lossless: True`. It does NOT catch:

    * `codec` swapped between two LOSSLESS names (`deflate` <-> `lzw`) — the rebuild agrees
      with itself, so the block can misname the compression the bytes actually use;
    * `writer_version`, which is a pure input;
    * `original_source`, likewise a pure input — the block can name the wrong vendor member;
    * a `resolution_cap_um` moved WITHIN the band that yields the same integer factor (#176:
      a 0.2 µm/pixel source at a cap of 0.5 and at a cap of 0.6 both give factor 3, so the
      two blocks are identical but for the cap they claim);
    * a fully self-consistent lie — an `original_resolution_um` that never described the
      pixels, which is what happens when the vendor's own micron scale is wrong. Every
      derived field then agrees with every other and the artifact is uniformly, invisibly
      misscaled. This is the class #155's TEST-9 named for the affine and #176's TEST-11
      names for the scale. "#156's registration overlay is the only real check." — that
      paragraph is corrected rather than removed, because a disclosure of absence and its
      retirement are the same claim in two directions. A registration overlay now exists for
      ALL THREE producers — Visium (#156), Xenium (#301) and Visium HD (#313) — and they
      measure DIFFERENT REFERENTS, because what lies outside the artifact is a property of
      the PLATFORM: Visium's scores the spot lattice against the slide's manufactured 100 µm
      glass pitch and the vendor's own `in_tissue` call; Xenium's has neither, so it scores
      the cell centres placed through the declared `to_space` against a signal mask derived
      from the morphology pixels (`SIGNAL_LIFT_FLOOR = 0.4`); Visium HD's scores the bin
      lattice pitch against the VENDOR-DECLARED `bin_size_um` — one notch weaker, by its own
      accounting, because that is not a manufactured glass constant. Xenium alone also
      cross-checks its two vendor statements (a SINGLE-SOURCE error is caught there; #269),
      and even that is measured rather than airtight: a vendor wrong the SAME way in both
      statements, by a uniform error under about 2%, still passes everything internal, and
      the overlay is what NARROWED the hole rather than closed it: a 2% misscale already
      scores signal-lift 0.303, BELOW the 0.4 floor, so about 2% is the boundary and the
      unresolved band lies strictly under it (a 1.5x error scores 0.000).

    Closing the rest needs the artifact, not the declaration. The producer-side check that
    does close the geometric half is in `ome_writer.write_ome_tiff`, which is the one place
    the pixels and the declaration are both in scope; #176 extended it from the extent alone
    to the full scale chain (grid, factor, affine, OME `PhysicalSize*`, applied resolution).

    ## `source` and the derivative's `original_source` must AGREE

    Both name the vendor file these pixels came from, and two independent strings for one
    fact is one more thing that can silently disagree. When both are present they are
    required to be equal.
    """
    validated = _revalidated(coordinate_space, _space_kwargs(space), "space")
    if "extent" not in validated:
        raise SpatialDeclarationError(
            "image_meta: `space.extent` is REQUIRED for a raster (§6.6). An affine alone "
            "places the image's ORIGIN and says nothing about how far it extends, so a "
            "consumer cannot compute the covered region, cannot place two images against "
            "each other, and cannot tell a correct image from a transposed one. The "
            "producer has the array's shape at write time; this is unrecoverable after."
        )
    meta = dict(validated)
    if role is not None:
        role = _required_str(role, "image_meta.role")
        if role not in IMAGE_ROLES:
            raise SpatialDeclarationError(
                f"image_meta.role={role!r} is outside the declared vocabulary "
                f"{list(IMAGE_ROLES)}. An open string would let two producers spell the "
                "same role differently, and a consumer picking 'the image to display' "
                "would have to guess."
            )
        meta["role"] = role
    if source is not None:
        # The vendor basename this artifact was built FROM. Free at write time, and the
        # only way a reader can tell a hires-derived image from a lowres-derived one once
        # both are OME-TIFFs with the same structure.
        meta["source"] = _required_str(source, "image_meta.source")
    if derivative is not None:
        if not isinstance(derivative, dict):
            raise SpatialDeclarationError(
                "image_meta: `derivative` must be the mapping "
                "`display_derivative_provenance()` returns"
            )
        try:
            rebuilt = display_derivative_provenance(
                original_resolution_um=derivative["original_resolution_um"],
                original_extent=derivative["original_extent"],
                original_source=derivative["original_source"],
                codec=derivative["codec"],
                tifffile_version=derivative["writer_version"],
                resolution_cap_um=derivative["resolution_cap_um"],
            )
        except KeyError as exc:
            raise SpatialDeclarationError(
                f"image_meta: `derivative` is missing {exc} — build it with "
                "`display_derivative_provenance()` rather than by hand"
            ) from None
        if rebuilt != derivative:
            raise SpatialDeclarationError(
                "image_meta: `derivative` does not match what "
                "`display_derivative_provenance()` derives from its own recorded inputs. "
                "The DERIVED fields (`is_display_derivative`, `applied_resolution_um`, "
                "`downsampled`, `lossless`) are not producer-settable — a hand-edited "
                "`lossless` riding on a lossy codec is exactly what this re-construction "
                "exists to refuse."
            )
        if source is not None and rebuilt["original_source"] != meta["source"]:
            raise SpatialDeclarationError(
                f"image_meta: `source` is {meta['source']!r} but the display derivative was "
                f"built from {rebuilt['original_source']!r}. These name the same fact — the "
                "vendor file these pixels came from — and a reader following either one to "
                "the retained upload bundle would reach a different file. Build both from "
                "the same basename."
            )
        meta["display_derivative"] = dict(rebuilt)
    return meta


#: The one `microns_per_pixel_source` value that may stand WITHOUT a scale: the record
#: that every leg was tried and none produced a number. Named rather than spelled inline
#: so the writer, the validator and the producers cannot disagree about the sentinel.
SCALE_SOURCE_UNAVAILABLE = "unavailable"

#: The ONE version token every channel that carries these declarations into a sandbox
#: stamps. Versioned from the start because these bytes OUTLIVE the code that wrote them:
#: an artifact imported today is opened by a consumer built next year, and a payload with
#: no version is one a future reader must guess the shape of.
#:
#: There are exactly TWO such channels and they are NOT alternatives — each kind carries
#: its declarations in ITS OWN FILE FORMAT, and neither depends on the manifest row's
#: `meta` (a catalog column no sandboxed consumer can read):
#:
#:   * a `spatial/image` is `opaque` with NO store, so it carries its placement in its
#:     OME-XML `Image/Description` ([`encode_placement`], prefixed by this token);
#:   * a `spatial/coordinates` is a Zarr store, so it carries its declarations in that
#:     store's own group `attributes.txr` ([`mirror_declarations_into_store`], under
#:     [`STRUCTURE_DECLARATION_KEY`], with this token as the block's `declares`).
#:
#: ONE token for both so a grep finds every channel, and so a future `txr-spatial/2`
#: cannot be introduced on one channel and forgotten on the other.
SPATIAL_DECLARATION_TOKEN = "txr-spatial/1"

#: The marker that opens a `txr` placement payload inside an OME-TIFF's own
#: `Image/Description`. DERIVED from the shared token above rather than restated: the
#: literal it produces is unchanged (`"txr-spatial/1 "`), so every artifact already
#: written still decodes, and the two channels can no longer be versioned apart.
OME_PLACEMENT_PREFIX = SPATIAL_DECLARATION_TOKEN + " "

#: The version-AGNOSTIC marker `decode_placement` matches on. `OME_PLACEMENT_PREFIX` above
#: is what this module WRITES; this is what it RECOGNISES.
#:
#: The two must differ, and the reason is the asymmetry the shared token would otherwise
#: create. On the zarr channel a block whose `declares` is not ours is found, recognised as
#: OURS-BUT-WRONG-VERSION, and refused with a message naming the version. On the OME
#: channel a prefix test against the exact current token cannot do that: after a bump to
#: `txr-spatial/2`, every image already written carries `"txr-spatial/1 "`, the prefix
#: stops matching, `decode_placement` returns `None`, and `require_placement` reports
#: "this image carries no coordinate-space declaration" — of an image that carries one.
#: The operator is sent to look for a missing declaration and told nothing about a version.
#:
#: So the channel that exists to make a bump SAFE would have been the one that could not
#: diagnose it. Matching on the family and reporting the version is what makes the shared
#: token an actual lockstep rather than a shared way to fail differently.
OME_PLACEMENT_FAMILY = "txr-spatial/"

#: The single `structure` key the spatial declarations ride under on the ZARR channel
#: (#211). ONE nested key, not a flat merge, for three reasons:
#:
#:   * `structure` is a FRAMEWORK-owned namespace (`encoding`, `kind`, `axis`, `n`,
#:     `columns`, `arrays`, `aligned_to`, `memberships`). Flat-merging a producer's
#:     generic `unit`/`section`/`extent` into it takes a future collision this mirror does
#:     not need to take — the same risk `txr_csc._WRITER_OWNED_STRUCTURE_KEYS` refuses by
#:     name for `structure_extra`.
#:   * absence becomes ONE unambiguous question. Flat, a reader would have to ask "is
#:     `unit` present?", which a future framework key could answer by accident.
#:   * the VALUE stays flat — exactly the dict [`coordinates_meta`] returns — so
#:     [`require_micron_scale`] and [`require_full_positioning`] read it UNCHANGED. The
#:     block a sandboxed consumer holds is the same shape the catalog row holds; no second
#:     vocabulary is introduced.
STRUCTURE_DECLARATION_KEY = "txr_spatial"

#: The placement keys mirrored into the image bytes. Deliberately NOT the whole `meta`:
#: this is the subset a consumer needs to PLACE the pixels, and every extra key is one
#: more thing that can disagree with the catalog copy (DEC-6).
#:
#: `display_derivative` is here for a reason that overrides the "keep it minimal" rule above
#: (#176). The geometry alone is not enough: with only the affine and the extent, a
#: sandboxed consumer places the pixels CORRECTLY and still cannot tell that they are
#: AVERAGES rather than measurements — and `require_original_reference`, the refusal written
#: for exactly that consumer, would be unreachable from the only channel it has. An
#: `opaque` artifact's manifest `meta` is a catalog column the sandbox never sees, so
#: leaving the block out of the payload made INV-1's "this is a display derivative" true in
#: the catalog and invisible to every reader that would act on it.
#:
#: DEC-6's concern is unchanged by this: both copies are still built from ONE `meta` at ONE
#: call site, so there is no second derivation that could disagree, and the producer test
#: that asserts the two copies agree covers the new key with no change.
#: `microns_per_pixel_source` is here for the same reason `display_derivative` is, and
#: the omission was a live contradiction until #211 named it: this module now states as a
#: principle that *a value and the record of where it came from are a PAIR, and a channel
#: that carries one without the other hands a consumer a number it cannot audit* — and
#: this channel carried the scale WITHOUT its source. A sandboxed image consumer got a
#: number it could not audit while a coordinates consumer got one it could, on the two
#: channels the shared version token exists to keep in step. Relevant to #222 on both.
_PLACEMENT_KEYS = ("coordinate_space", "unit", "to_space", "extent", "microns_per_pixel",
                   "microns_per_pixel_source", "display_derivative")


def encode_placement(meta):
    """The placement subset of an image `meta`, as an OME `Description` string.

    ## Why the bytes carry this at all

    A `structure` key is the only producer declaration that travels with a ZARR artifact's
    bytes (`_lib/test_csc_structure_extra.py:8-12`); the manifest row's `meta` is a catalog
    column a sandboxed consumer cannot read. A `spatial/image` is `opaque` with
    `file_layout: single` and may not contain a `zarr.json` at all
    (`conformance.py:1705-1712`), so it has NO store to stamp and that escape hatch does
    not exist for it. What it does have is OME-XML — which is staged into the sandbox
    byte-verbatim along with the pixels.

    So this is not belt-and-braces duplication. For this kind it is the ONLY channel that
    reaches the analysis code that would actually use the affine. `image_meta()` is the one
    place both copies are derived from, and a producer's test should assert they agree.
    """
    if not isinstance(meta, dict):
        raise SpatialDeclarationError("encode_placement: `meta` must be a mapping")
    import json

    payload = {k: meta[k] for k in _PLACEMENT_KEYS if k in meta}
    if "to_space" not in payload or "coordinate_space" not in payload:
        raise SpatialDeclarationError(
            "encode_placement: a placement payload needs at least `coordinate_space` and "
            "`to_space` — without them the pixels are unplaceable, which is the whole "
            "reason this payload exists"
        )
    return OME_PLACEMENT_PREFIX + json.dumps(payload, sort_keys=True,
                                             separators=(",", ":"))


class _UnknownPlacementVersion:
    """A placement payload that is OURS but of a version this code does not understand.

    A sentinel type rather than `None`, so the two answers stay distinguishable: `None`
    means "this image carries no txr placement at all" and this means "it carries one I
    must refuse". Falsy, so an existing `if placement is None` / truthiness check keeps
    failing CLOSED for a caller that has not been taught about it.
    """

    __slots__ = ("token",)

    def __init__(self, token):
        self.token = token

    def __bool__(self):
        return False

    def __repr__(self):
        return f"_UnknownPlacementVersion({self.token!r})"


def decode_placement(ome_xml):
    """The placement a `spatial/image`'s OME-XML carries, or `None`.

    `ome_xml` is the string `tifffile.TiffFile.ome_metadata` returns. Returns `None` — not
    a fabricated default — when the image carries no `txr` payload, because an image
    written by some other tool legitimately has none and inventing an identity affine for
    it would be the exact silent misregistration §7.3 opens by describing.
    """
    import json
    import xml.etree.ElementTree as ET

    if not isinstance(ome_xml, str) or not ome_xml.strip():
        return None
    try:
        root = ET.fromstring(ome_xml)
    except ET.ParseError:
        return None
    for node in root.iter():
        # Namespace-agnostic: the OME schema URL is versioned, and matching on the
        # local tag name keeps this readable against 2016-06 and whatever supersedes it.
        if node.tag.rsplit("}", 1)[-1] != "Description":
            continue
        text = (node.text or "").strip()
        if not text.startswith(OME_PLACEMENT_FAMILY):
            continue
        token, _, body = text.partition(" ")
        if token != SPATIAL_DECLARATION_TOKEN:
            # OURS, and not a version this code understands. Returned as the token rather
            # than as `None` so `require_placement` can say WHICH version it found — the
            # distinction between "no declaration" and "a declaration I must refuse".
            return _UnknownPlacementVersion(token)
        # A node that CLAIMS to be a txr placement and is not readable is a DAMAGED
        # declaration, and this returns `None` for it rather than looking further.
        #
        # Skipping it and returning a later node's payload would be fail-OPEN in a
        # fail-closed module: `decode_placement` has no notion of which `<Image>` a
        # `Description` belongs to, so "keep looking" means "hand the caller some other
        # image's affine", which is the silent misregistration this module exists to
        # prevent. Non-txr `Description` nodes are still skipped by the prefix test above
        # — those are not damaged declarations, they are somebody else's metadata.
        try:
            payload = json.loads(body)
        except ValueError:
            return None
        return payload if isinstance(payload, dict) else None
    return None


def require_placement(ome_xml, *, consumer):
    """The placement of an image, or REFUSE — never a fabricated identity affine.

    Same posture as [`require_micron_scale`]. A consumer that needs to put pixels in a
    coordinate space calls this instead of reading the payload, so the unplaced case stops
    the analysis instead of silently drawing the tissue in the wrong place — which,
    per §7.3, "does not error" and corrupts every neighbourhood measured downstream.
    """
    placement = decode_placement(ome_xml)
    if isinstance(placement, _UnknownPlacementVersion):
        raise SpatialDeclarationError(
            f"{consumer}: this image carries a placement stamped {placement.token!r}, and "
            f"this consumer understands {SPATIAL_DECLARATION_TOKEN!r}. Refusing rather "
            "than reading it as though it were the shape it knows — and saying so rather "
            "than reporting a MISSING declaration, which is what a prefix test against "
            "the exact current token would have reported for an image that has one."
        )
    if placement is None:
        raise SpatialDeclarationError(
            f"{consumer}: this image carries no coordinate-space declaration, so where "
            "its pixels sit is UNKNOWN. Refusing rather than assuming the identity "
            "affine: an identity is not a missing answer, it is the claim that these "
            "pixels are already full-resolution space pixels, and if they are not, every "
            "spot drawn on this image lands in the wrong place with nothing to say so."
        )
    return placement


# ── the ZARR channel: the store's own `attributes.txr` (#211) ──────────────────────
#
# The exact counterpart of `encode_placement`/`decode_placement`/`require_placement`
# above, for the kind that HAS a store. Same four-part shape, same refusal posture, same
# version token — because it is the same problem: the manifest row's `meta` is a catalog
# column, and a sandboxed consumer reads bytes.


def _read_stamped_structure(store_dir):
    """The `structure` a store stamped into its group `zarr.json`, or `None`.

    Every failure — no store, no `zarr.json`, unreadable, not JSON, not an object, no
    `attributes.txr` — collapses to `None` here, and the DECISION about what that means
    is made one level up. Mirrors `embedding/compute/_shared.py::artifact_structure`,
    which a sandboxed reader in this tree already uses for exactly this read.
    """
    import json
    from pathlib import Path

    # ABSENT is a different answer from UNREADABLE, and only one of them means "this
    # artifact predates the mirror". Collapsing an I/O fault into absence would send an
    # operator chasing a re-import for a permission bit or a truncated file.
    #
    # ONE `try`, and the existence probe is INSIDE it. `Path.exists()` swallows only
    # ENOENT/ENOTDIR/EBADF/ELOOP — `EACCES` is re-raised — so probing before the guard let
    # a raw `PermissionError` escape on a store directory the process cannot stat. That is
    # worse than the collapse it replaced: a caller writing `except SpatialDeclarationError`
    # catches neither, and `SpatialDeclarationError` subclasses `ValueError`, so it is not
    # caught by accident either. `FileNotFoundError`/`NotADirectoryError` are the ABSENT
    # answer and are handled first, before the broader `OSError` arm.
    node = Path(store_dir) / "zarr.json"
    try:
        doc = json.loads(node.read_text(encoding="utf-8"))
    except (FileNotFoundError, NotADirectoryError):
        return None
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise SpatialDeclarationError(
            f"the group `zarr.json` at {store_dir} exists and is not readable as JSON "
            f"({type(exc).__name__}: {exc}). This is an I/O or corruption fault, NOT a "
            "missing declaration — re-importing will not fix it."
        ) from exc
    if not isinstance(doc, dict):
        return None
    attrs = doc.get("attributes")
    if not isinstance(attrs, dict):
        return None
    txr = attrs.get("txr")
    return txr if isinstance(txr, dict) else None


#: The sub-blocks a mirrored declaration may carry, each with the constructor that OWNS
#: its rules. Data rather than a chain of `if`s so the N+1st block is covered by
#: construction — the same shape `conformance._REQUIRED_MEMBER_KEYS` uses, and for the
#: same reason: three member keys were found and closed one at a time before the shape
#: itself was named.
_DECLARATION_SUB_BLOCKS = (
    ("measured_entity", lambda v: measured_entity(**v)),
    ("positioning", lambda v: positioning(**v)),
    ("section", lambda v: section(**v)),
    # `z_column` takes the STORED shape, not the constructor's kwargs: `z_column()`
    # additionally requires `values`, which is a write-time-only argument and is not in
    # the artifact. Kept in the table rather than inlined below it — an inline check
    # beside a table introduced to remove inline checks is a second spelling of one rule,
    # which is the thing `_extent`'s docstring argues against.
    ("z_column", lambda v: z_column_declaration(**v)),
)

#: The COMPLETE top-level vocabulary of a mirrored declaration block. A key outside it is
#: REFUSED rather than carried.
#:
#: `rebuilt = dict(block)` used to pass anything through: a `section` -> `sections` typo in
#: a hand-assembled block wrote cleanly, passed the conformance gate, and left the section
#: UNRECOVERABLE — while the consumer's `require_*` reported "the coordinates carry no
#: section", i.e. a typo degraded to *unknown* rather than being refused. That is the exact
#: shape the four `[FIELD-NOW]` fields exist to prevent, reintroduced by the channel that
#: carries them. It is unreachable through `write_spatial_coordinates` (which builds the
#: keys), and entirely reachable through `mirror_declarations_into_store`, which is public
#: and is the only mirror the next kind will have.
_DECLARATION_KEYS = frozenset({
    "declares",
    "coordinate_space", "unit", "to_space", "extent",
    "microns_per_pixel", "microns_per_pixel_source", "coordinate_space_source",
    "measured_entity", "measured_entity_label", "positioning", "section", "z_column",
})


def z_column_declaration(*, name, kind):
    """The `{name, kind}` half of [`z_column`] — the part that rides in an artifact.

    [`z_column`] needs the VALUES to check the zero-fill rule, and a declaration that has
    already been through it carries only `{name, kind}`. Extracted so the stored shape has
    ONE definition that `coordinates_meta` and [`_validated_declaration_block`] both use,
    rather than two hand-rolled copies that can disagree.
    """
    if kind not in Z_COLUMN_KINDS:
        raise SpatialDeclarationError(
            f"z_column.kind={kind!r} is outside {list(Z_COLUMN_KINDS)}"
        )
    return {"name": _required_str(name, "z_column.name"), "kind": kind}


def _validated_declaration_block(block, *, what):
    """Re-run a declaration block through the constructors that OWN its rules, or REFUSE.

    ## Why this exists on BOTH sides, and why that is not belt-and-braces

    Every rule this module states is enforced by a CONSTRUCTOR — `_number` refuses a bool
    ("a flag coerced to 1.0 is a plausible number and a silently wrong one"), a numeric
    string ("a parse, not a declaration"), a non-finite, a non-positive; `measured_entity`
    closes its `kind` vocabulary; `section` refuses a section-to-section transform by name.
    `coordinates_meta` already re-runs each sub-block through its constructor precisely
    because "a producer reaches the artifact through `coordinates_meta`, not through them".

    #211 adds a second path with the same problem and one more: the block now crosses a
    SERIALIZATION boundary. On the way out, [`mirror_declarations_into_store`] is public
    and would otherwise accept any non-empty mapping — including one a future
    `spatial/geometry` or `spatial/points` producer hand-assembles, since neither has a
    writer in this module. On the way IN, the block a sandboxed consumer holds is JSON
    parsed off a staged file, so NONE of the write-time guards apply to it any more:
    measured before this function existed, `{"unit": "pixel", "microns_per_pixel": true}`
    reached `require_micron_scale` and came back as **`1.0`** — a fabricated scale through
    the one function whose entire stated purpose is that no 1.0 is ever fabricated. `0.0`,
    `"0.65"`, `-3` and `NaN` all came back as themselves.

    So the SAME validator runs at both ends: a block that could not be written cannot be
    read. That is the property, and it is why this is one function and not two.

    ## What it requires, stated exactly — the docstring this replaces overclaimed

    * the COORDINATE SPACE is required and is rebuilt through [`coordinate_space`];
    * every sub-block that is PRESENT is rebuilt through its own constructor;
    * a sub-block that is ABSENT is not invented. A consumer that needs one calls its own
      `require_*` — [`require_full_positioning`] already names the absent case ("the
      coordinates carry no `positioning` declaration ... Unknown is not complete").

    A `spatial/coordinates` artifact always carries all of them, because
    [`coordinates_meta`] requires all four at write time. A future kind that legitimately
    has no measured entity is not forced to invent one.
    """
    if not isinstance(block, dict) or not block:
        raise SpatialDeclarationError(
            f"{what}: the spatial declaration is required and must be a non-empty "
            f"mapping, got {type(block).__name__}"
        )
    unknown = sorted(set(block) - _DECLARATION_KEYS)
    if unknown:
        raise SpatialDeclarationError(
            f"{what}: unknown declaration key(s) {unknown}. The block's vocabulary is "
            f"closed ({sorted(_DECLARATION_KEYS)}) — an unrecognised key is almost always "
            "a typo, and a typo carried through writes an artifact whose declaration is "
            "silently absent rather than wrong, which is unrecoverable afterwards."
        )
    rebuilt = dict(block)
    try:
        space = coordinate_space(**_space_kwargs(
            {k: v for k, v in block.items()
             if k in ("coordinate_space", "unit", "to_space", "extent",
                      "microns_per_pixel", "microns_per_pixel_source",
                      "coordinate_space_source")}
        ))
    except TypeError as exc:
        raise SpatialDeclarationError(
            f"{what}: the coordinate space is not the shape `coordinate_space()` produces "
            f"({exc}). Every spatially-placed artifact carries one — the frame, its unit "
            "and the affine into it — and a block without it declares positions in an "
            "unknown space."
        ) from exc
    except SpatialDeclarationError as exc:
        # Re-raised PREFIXED. The constructors' messages are written for a producer at
        # write time ("coordinate_space.unit='furlong' must be ..."), and a sandboxed
        # consumer reading a bad artifact needs to know WHICH consumer stopped and that
        # the fault is in the artifact it was handed, not in a call it made.
        raise SpatialDeclarationError(f"{what}: {exc}") from exc
    rebuilt.update(space)
    for key, builder in _DECLARATION_SUB_BLOCKS:
        if key not in block:
            continue
        value = block[key]
        if not isinstance(value, dict):
            raise SpatialDeclarationError(
                f"{what}: `{key}` is {type(value).__name__}, not the mapping its "
                "constructor produces"
            )
        try:
            rebuilt[key] = builder(value)
        except TypeError as exc:
            raise SpatialDeclarationError(
                f"{what}: `{key}` is not the shape this module's constructor produces "
                f"({exc})"
            ) from exc
        except SpatialDeclarationError as exc:
            raise SpatialDeclarationError(f"{what}: {exc}") from exc
    if "measured_entity" in rebuilt:
        # RE-DERIVED, and that overwrites whatever the store stamped. The label is a pure
        # function of the entity, so a stamped label that disagrees with its own entity is
        # a corrupt artifact — but silently preferring the derived one hides that, so it
        # is REFUSED instead.
        derived = measured_entity_label(rebuilt["measured_entity"])
        stamped_label = block.get("measured_entity_label")
        if stamped_label is not None and stamped_label != derived:
            raise SpatialDeclarationError(
                f"{what}: `measured_entity_label` is {stamped_label!r} but the declared "
                f"entity derives {derived!r}. The label is a function of the entity, so "
                "these cannot both be right and this artifact says two things about what "
                "one row IS."
            )
        rebuilt["measured_entity_label"] = derived
    elif "measured_entity_label" in block:
        raise SpatialDeclarationError(
            f"{what}: `measured_entity_label` is declared with no `measured_entity` to "
            "derive it from — a label nothing produced is a claim about an entity this "
            "artifact does not declare."
        )
    return rebuilt


def mirror_declarations_into_store(store_dir, *, structure, declarations):
    """Mirror the spatial declarations into the STORE'S OWN BYTES, and return `structure`.

    ## Why this exists (#211)

    `meta` does not cross into the sandbox. `MaterializedInput` becomes an `inputs.json`
    entry of `{slot, kind, content_hash, sandbox_path}` and nothing more
    (`sandbox/inputs.rs:63-69`), and the manifest row's `meta` is a jsonb catalog column
    every reader of which — the UI, the HTTP API, the conformance job — is OUTSIDE the
    sandbox. So a sandboxed analysis could decode a `spatial/coordinates` artifact's
    numbers and could not learn a single thing the importer declared ABOUT them: not the
    frame, not the unit, not the micron scale, not what one row IS.

    What DOES cross is the bytes. `stage_prefix_members` copies every member of a
    multi-file artifact byte-verbatim out of the content-addressed pool, and for a Zarr
    artifact that includes `<store>/zarr.json`, whose `attributes.txr` is the producer's
    `structure`. That is the whole mechanism.

    ## The two copies cannot disagree, by construction

    `_conform_group_attributes` (`_lib/conformance.py:1839-1871`) re-reads
    `attributes.txr` off the store and CONDEMNS the artifact unless it equals the
    manifest row's `structure` — "a consumer reading the store URL and a consumer reading
    the artifact row would decode differently". So this function does not write a second
    declaration; it merges into the ONE `structure` dict and then re-stamps that same dict
    onto disk, exactly as `embedding/compute/_shared.py::stamp_txr_attributes` does.
    Re-implemented here rather than imported because that helper lives in another
    package's `compute/` and `/code` is assembled per package.

    ## Why a `declares` token rather than a bare block

    Same reason the OME payload carries one: these bytes outlive this code. A reader that
    finds a block it does not understand must REFUSE, not guess — see
    [`require_spatial_declarations`].
    """
    import copy
    import json
    from pathlib import Path

    if not isinstance(structure, dict):
        raise SpatialDeclarationError(
            f"mirror_declarations_into_store: `structure` must be the mapping the writer "
            f"returned, got {type(structure).__name__}"
        )
    # THE ENFORCEMENT, and a presence check is not a substitute for it — the same
    # reasoning `_revalidated` states for `coordinates_meta`. This function is PUBLIC and
    # is the only mirror a `spatial/boundaries` producer will have, so
    # accepting any non-empty mapping would make every rule this module states enforced
    # nowhere on the path that writes that kind.
    if isinstance(declarations, dict) and "declares" in declarations:
        # REFUSED by name, the same posture `section`'s `**forbidden` takes. `declares` is
        # the version token this function stamps, and a caller-supplied one would WIN the
        # `update` below — minting an artifact that passes the conformance gate (store ==
        # row) and that every reader in the tree then refuses, permanently, with no error
        # anywhere at write time. Reachable by an ordinary round-trip, because
        # `require_spatial_declarations` returns a block that INCLUDES `declares`.
        raise SpatialDeclarationError(
            "mirror_declarations_into_store: `declarations` carries its own `declares` "
            f"({declarations['declares']!r}). The version token is stamped by this "
            "function and is not a producer declaration — a caller-set one would produce "
            "a conformant artifact that no reader can ever read. Pass the block without "
            "it (a block read back by `require_spatial_declarations` carries it; strip it)."
        )
    validated = _validated_declaration_block(
        declarations, what="mirror_declarations_into_store: `declarations`"
    )
    node = Path(store_dir) / "zarr.json"
    if not node.is_file():
        raise SpatialDeclarationError(
            f"mirror_declarations_into_store: no group `zarr.json` at {store_dir} — the "
            "declarations are mirrored INTO a written store, so the store must exist "
            "first. Call this after the writer has closed."
        )
    # DEEP copy. `declarations` is the SAME object the caller merges into the manifest
    # row's `meta`, and a shallow copy would leave `structure[KEY]["section"]` and
    # `meta["section"]` as one dict: a producer touching a NESTED value of `meta` after
    # the writer returned would then silently desynchronise the row's `structure` from the
    # on-disk stamp — the exact drift `_conform_group_attributes` condemns, arriving
    # through a mutation nobody would think of as touching `structure` at all. Before this
    # copy, `structure["txr_spatial"]["section"] is meta["section"]` was True.
    block = {"declares": SPATIAL_DECLARATION_TOKEN}
    block.update(copy.deepcopy(validated))

    try:
        doc = json.loads(node.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # Surfaced as this module's declared type. `SpatialDeclarationError` subclasses
        # `ValueError`, so a caller writing `except SpatialDeclarationError` does NOT
        # catch a raw `JSONDecodeError` — the same argument `_number`'s docstring makes
        # about a bare `float()`.
        raise SpatialDeclarationError(
            f"mirror_declarations_into_store: the group `zarr.json` at {store_dir} is not "
            f"readable JSON ({type(exc).__name__}: {exc}) — the writer that just closed "
            "should have left one there"
        ) from exc
    attrs = doc.get("attributes")
    if not isinstance(attrs, dict):
        attrs = {}
        doc["attributes"] = attrs
    # The FULL updated structure, so disk == the row's declaration (INV-3). Writing only
    # the new key would leave the two copies agreeing on this block and able to disagree
    # on everything else.
    # SERIALIZE FIRST, then commit. `structure[KEY] = block` used to happen before this
    # point, so an unserializable value left the in-memory `structure` carrying a block
    # the store does not have — a row/store mismatch produced by the very function whose
    # job is to keep them equal, and reported as a raw `TypeError` a caller catching this
    # module's type would miss.
    candidate = dict(structure)
    candidate[STRUCTURE_DECLARATION_KEY] = block
    attrs["txr"] = candidate
    # THE ROUND TRIP, asserted rather than assumed. What is written must equal what is
    # read back, and "serializable" is weaker than that: a tuple in `segmentation.params`
    # serializes fine and comes back a LIST, so `measured_entity_label` — which renders
    # `params` with `str()` — derives a different string on the way in than the one
    # stamped on the way out. The label-disagreement check then refuses the artifact
    # FOREVER, with no error at write time. That is exactly the "conformant artifact no
    # reader can ever read" failure the `declares` guard above exists to prevent,
    # reintroduced by its sibling guard.
    #
    # One check covers every such value, present and future, and fails HERE where the
    # producer can fix it.
    try:
        body = json.dumps(doc, indent=2, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise SpatialDeclarationError(
            f"mirror_declarations_into_store: the declaration is not JSON serializable "
            f"({type(exc).__name__}: {exc}) — an artifact declaration is written to disk, "
            "so every value in it, in the block AND in the rest of `structure`, must "
            "survive a round trip"
        ) from exc
    if json.loads(json.dumps(block)) != block:
        raise SpatialDeclarationError(
            "mirror_declarations_into_store: a value in this declaration does not survive "
            "a JSON round trip unchanged (a tuple becomes a list, a non-string mapping key "
            "becomes a string). It would be written one way and read back another, and "
            "`measured_entity_label` — derived from the entity with `str()` — would then "
            "disagree with its own stamp for the life of the artifact. Declare "
            "round-trip-stable values: lists, not tuples."
        )
    try:
        # `encoding="utf-8"` explicitly, NOT the locale default. This is the first thing
        # to put PRODUCER FREE TEXT (`section.sample_id`, `coordinate_space`,
        # `measured_entity_label`) into the group stamp, which until now held only ASCII
        # framework vocabulary — and with `ensure_ascii=False` a non-ASCII library id
        # would abort the writer under an ASCII locale, AFTER the store is on disk.
        node.write_text(body, encoding="utf-8")
    except OSError as exc:
        raise SpatialDeclarationError(
            f"mirror_declarations_into_store: could not write the group `zarr.json` at "
            f"{store_dir} ({type(exc).__name__}: {exc})"
        ) from exc
    structure[STRUCTURE_DECLARATION_KEY] = block
    return structure


def read_spatial_declarations(store_dir):
    """The declarations a staged `spatial/coordinates` store carries, or `None`.

    `None`, never `{}`. An empty mapping is falsy AND indexable, so a consumer that wrote
    `(read_spatial_declarations(p) or {}).get("microns_per_pixel")` would get `None` for a
    missing declaration and for a declared-absent scale alike — and the whole point of
    this module is that those two are different. The refusing wrapper is
    [`require_spatial_declarations`]; this is the raw read.

    A block stamped with a token this code does not understand reads as `None` here: a
    payload shape from the future is not a payload this reader may guess at.

    Raises only for a store that EXISTS and cannot be read — an I/O or corruption fault is
    not an absent declaration, and reporting it as one sends the reader after the wrong
    fix. Absence itself is still `None`.
    """
    structure = _read_stamped_structure(store_dir)
    if structure is None:
        return None
    block = structure.get(STRUCTURE_DECLARATION_KEY)
    if not isinstance(block, dict) or not block:
        return None
    if block.get("declares") != SPATIAL_DECLARATION_TOKEN:
        return None
    return block


def require_spatial_declarations(store_dir, *, consumer):
    """The declarations of a staged coordinates store, or REFUSE.

    The entry point every sandboxed spatial consumer uses. Same posture as
    [`require_micron_scale`] and [`require_placement`]: there is no default and no `{}`.

    ## What the returned block is GUARANTEED to be, stated exactly

    The block is re-run through [`_validated_declaration_block`], i.e. through the same
    constructors that own its rules on the write side. So what comes back is guaranteed:

    * to carry a well-formed COORDINATE SPACE — the frame, its unit and the affine;
    * that any `microns_per_pixel` in it is a real, finite, positive number, NOT a bool
      coerced to 1.0, NOT a numeric string, NOT a zero and NOT a negative. The block a
      sandboxed consumer holds is JSON parsed off a staged file, so the write-time
      guards do NOT travel with it — re-running them here is what keeps INV-1 true across
      the serialization boundary rather than only up to it;
    * that every sub-block PRESENT (`measured_entity`, `positioning`, `section`,
      `z_column`) is the shape its constructor produces.

    It is NOT guaranteed that every sub-block is present. A `spatial/coordinates` artifact
    always carries all four, because [`coordinates_meta`] requires them at write time —
    but that is a property of that writer, not something this function can verify, and a
    future kind may legitimately have no measured entity. **A consumer that needs one asks
    for it**: `require_full_positioning(block.get("positioning"), consumer=...)` already
    names the absent case rather than raising a bare `KeyError`. That is the honest
    contract; the earlier wording here claimed completeness this function cannot check.

    The refusal names both ways a block can be absent, because they call for different
    fixes and a consumer told only "it is missing" will guess wrong:

      1. the artifact predates the mirror — RE-IMPORT it with a current importer
         (`spatial.import-visium` >= 0.5.0 / `spatial.import-xenium` >= 0.2.0; naming the
         VENDORED `spatial-types` version here was misleading, since an operator only ever
         sees the importer packages and a Xenium one at 0.2.0 would read "< 0.5.0" as
         three minors behind);
      2. it is a GATHERED (filtered-dataset) artifact. The filter path re-mints
         `structure` from scratch (`virtual_dataset.rs:574-628`) and copies only `meta`
         verbatim, so producer keys do not survive a filter — run on the unfiltered
         coordinates artifact.

    Both are REFUSALS and neither is a degraded answer. That is deliberate: the failure
    this module exists to prevent is not an error, it is a plausible number.
    """
    block = read_spatial_declarations(store_dir)
    if block is not None:
        return _validated_declaration_block(
            block, what=f"{consumer}: the spatial declaration in this store"
        )
    structure = _read_stamped_structure(store_dir)
    stamped = (structure or {}).get(STRUCTURE_DECLARATION_KEY)
    # `"declares" in stamped` — NOT merely `stamped.get(...) != TOKEN`. A block with no
    # token at all (a truncated or hand-assembled one) is not a version mismatch, and
    # telling the operator "your payload is from the future" points them away from the two
    # real causes the message below is written to name.
    if isinstance(stamped, dict) and "declares" in stamped \
            and stamped["declares"] != SPATIAL_DECLARATION_TOKEN:
        raise SpatialDeclarationError(
            f"{consumer}: these coordinates carry a spatial declaration stamped "
            f"{stamped['declares']!r}, and this consumer understands "
            f"{SPATIAL_DECLARATION_TOKEN!r}. Refusing rather than reading it as though it "
            "were the shape it knows: a payload version exists precisely so a reader can "
            "stop here instead of misinterpreting fields that moved."
        )
    if isinstance(stamped, dict) and "declares" not in stamped:
        raise SpatialDeclarationError(
            f"{consumer}: these coordinates carry a spatial declaration block with no "
            f"version token. Every block this module writes is stamped "
            f"{SPATIAL_DECLARATION_TOKEN!r}, so an unstamped one was not written by this "
            "contract — it is hand-assembled or truncated. Refusing rather than guessing "
            "which shape it is."
        )
    raise SpatialDeclarationError(
        f"{consumer}: these coordinates carry no spatial declaration in their store, so "
        "the coordinate space, the unit, the micron scale, what one row IS, whether every "
        "row has a position, and which section this is are all UNKNOWN. Refusing rather "
        "than assuming any of them. Two causes: (1) the artifact was written before the "
        "declarations were mirrored into the store — re-import it with a current importer "
        "(`spatial.import-visium` >= 0.5.0, `spatial.import-xenium` >= 0.2.0); (2) it is "
        "a GATHERED artifact from a filtered dataset, whose `structure` the "
        "filter path re-mints from scratch, dropping every producer key — run on the "
        "unfiltered coordinates artifact. The catalog row's `meta` still carries the "
        "declarations in both cases, but a sandboxed consumer cannot read it."
    )


def _space_kwargs(space):
    """`coordinate_space()`'s OUTPUT keyed back to its INPUT names.

    The block is stored flat in `meta` (`coordinate_space` / `unit` / `to_space` /
    `extent`, per §6.6) while the constructor's parameter is `space`. Mapping it back is
    what lets the same re-validation rule apply to this block as to the other three,
    instead of exempting the one whose key happens to be renamed on the way out.
    """
    if not isinstance(space, dict):
        return space
    out = dict(space)
    if "coordinate_space" in out:
        out["space"] = out.pop("coordinate_space")
    return out


def write_spatial_coordinates(outputs_dir, rel_dir, arr, *, axis, space, entity,
                              placement, series, z=None, name="coordinates",
                              aligned_to=None, membership=None):
    """Write a `spatial/coordinates` artifact — REFUSING anything but `(n × 2)`.

    The refusal happens BEFORE the framework writer is called, so a rejected array leaves
    no directory, no partial store and nothing for a later reader to find. This is the
    always-2-D writer rule (INV-2), and it is enforced rather than documented for a
    specific reason: the failure mode it prevents is SILENT INVISIBILITY, not an error.
    The shipped Coordinates section selects on `dims: 2` with exact equality and fails
    closed, so an honest 3-component artifact simply never appears — no message, nothing
    in a log, and a producer with every reason to believe it worked.

    Returns `(structure, meta)`, the two producer declarations the manifest entry carries
    into the artifact row: `structure` from `txr_columns.write_embedding` unchanged,
    `meta` from [`coordinates_meta`] plus the writer's own fields.
    """
    import numpy as np

    import txr_columns

    mat = np.asarray(arr)
    if getattr(mat, "ndim", 0) != 2:
        raise SpatialDeclarationError(
            f"{name!r}: spatial coordinates are a dense 2-D array, got ndim="
            f"{getattr(mat, 'ndim', None)}"
        )
    n_components = int(mat.shape[1])
    if n_components != COORDINATE_COMPONENTS:
        raise SpatialDeclarationError(
            f"{name!r}: a spatial coordinates artifact must have exactly "
            f"{COORDINATE_COMPONENTS} components, got {n_components}. A producer ALWAYS "
            "emits (n x 2); z goes out as a sibling metadata-column with a declared kind "
            "(`physical` micrometres / `index` z-plane / absent), never as a third "
            "component and never as a zero fill. This is refused at WRITE time because "
            "the alternative is not an error: the shipped Coordinates section selects on "
            "`dims: 2` by exact equality and fails closed, so an (n x 3) artifact would be "
            "SILENTLY INVISIBLE in the UI while every gate stayed green. Relaxing that "
            "filter is a separate, later change."
        )
    meta_declarations = coordinates_meta(
        space=space, entity=entity, placement=placement, series=series, z=z
    )
    structure, meta = txr_columns.write_embedding(
        outputs_dir, rel_dir, mat, axis=axis, name=name, kind="spatial-coordinates",
        aligned_to=aligned_to, membership=membership,
    )
    meta.update(meta_declarations)
    # ONE block, TWO destinations, ONE call site (#211). `meta` is the catalog row, which
    # no sandboxed consumer can read; the mirror puts the same dict into the store's own
    # `attributes.txr`, which is staged into the sandbox byte-verbatim. Written here, in
    # the ENFORCED writer, rather than left to each producer: a mirror a producer can
    # forget is the same silent-invisibility shape the always-2-D rule above is enforced
    # to avoid. It is also why the two copies cannot be derived differently — there is no
    # second derivation, only a second destination.
    mirror_declarations_into_store(
        outputs_dir / rel_dir, structure=structure, declarations=meta_declarations
    )
    return structure, meta
