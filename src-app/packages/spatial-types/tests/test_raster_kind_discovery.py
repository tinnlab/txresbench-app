#!/usr/bin/env python3
# ruff: noqa
"""#229 — what lets a consumer tell `spatial/image` and `spatial/labels` apart.

The issue is a DISCOVERY problem, not an implementation one, and the premise is a
declaration fact this file pins first: the two kinds declare a BYTE-IDENTICAL container
(`opaque_as_is` + `ome-tiff` + `file_layout: single`, no axes, no capabilities, no schema),
so the producer-declared LAYOUT — the only thing the byte plane and `workbenchDataSource`'s
raster discovery route on — cannot separate them. A label mask is not a picture: its pixel
values are an INDEX into an entity axis, read nearest-neighbour with no interpolation and no
windowing, and rendering one as a tissue underlay is a plausible wrong picture with nothing
anywhere saying so.

## Why the answer is `viewers`, stated as the elimination it actually is

Every other channel is closed, and each is closed by a SHIPPED guard rather than by taste:

* **The datatype id, or a new generic tier above it.** Two guards, both DERIVED from these
  manifests: TEST-1 in this suite scans `src-app/**` + `scripts/**` for every id this package
  contributes, and the FE's `lint-no-domain-in-builtin.mjs` derives its forbidden datatype
  literals by reading the manifests. The second is what refutes a generic tier, and it does
  so in the way that is easy to miss: a token like `image/labels` passes the lint TODAY only
  because nothing declares it — declare it and it joins the derived set, so the consumer that
  was going to route on it may no longer spell it. Measured, both guards red on one probe. A
  new id cannot be its own escape hatch.
  `test_the_discriminator_is_vocabulary_the_app_core_may_spell` below asserts the property
  from the other side: this discriminator is not a contributed id at all.
* **A capability.** INV-7 forbids one on an opaque container, `*-target` excepted
  (`datatype_contribution_test.rs`'s opaque loop, TEST-14's mirror in this suite,
  `datatypeShape.test.ts`'s `contentsClaims`). Reaching for one needs an amendment, not a
  branch.
* **Axis identity.** Semantically the truest statement — a mask's integers key the entity
  axis — but two shipped tests pin the opposite
  (`test_the_rasters_declare_no_axes_and_the_bundle_declares_axis_identity` here,
  `test_the_container_declares_the_axis_vocabulary_a_handed_over_container_must` in
  `test_hd_bundle_container.py`). Reported, not edited.
* **A filename, an OME tag, or `meta.role`.** Heuristics where a declaration is called for.
  `workbenchDataSource.ts`'s own comment says it: "This narrows the ambiguity; it does not
  close it."

`viewers` survives all four. It is legal on an opaque container (INV-7's MAY-NOT table is
capabilities / non-opaque layout / schema / arrays / over-identity axes — a renderer
reference is none of them and claims nothing about the bytes inside), it is PRESENTATION
vocabulary rather than domain vocabulary so a domain-blind consumer may read it, and it is
resolved by the lattice (`viewersFor` walks `extends`, Rust↔TS parity-gated) rather than
being a free-form tag nothing validates.

## What each test here is for

The premise test and the discriminator test are two halves of one claim and are useless
apart: without the premise, "labels declares a viewer" is a fact about one kind rather than
the ONLY thing separating two; without the discriminator, the premise is just #229 restated.
The consumer simulation is the one with teeth — it runs a domain-blind resolver over
declarations with their IDS REDACTED, so a resolver that secretly recognised the kind could
not pass, and it asserts the same resolver FAILS to separate them once the viewer is taken
away. A check that cannot discriminate is indistinguishable from no check.
"""
import json
import re
from pathlib import Path

import yaml

_PACKAGES = Path(__file__).resolve().parents[2]
_REPO = _PACKAGES.parents[1]
_MANIFEST = _PACKAGES / "spatial-types" / "manifest.yaml"

#: The FE domain lint, whose noun list is the tree's own definition of "domain vocabulary
#: the app core may not learn". Read, never restated — a copy here would fall one term
#: behind the day somebody adds one, which is the drift `check-derived-vocabulary.sh` was
#: written to retire.
_DOMAIN_LINT = _REPO / "src-app" / "ui" / "scripts" / "lint-no-domain-in-builtin.mjs"

#: The two kinds this issue is about, named as the SUBJECT of the test rather than as a
#: dispatch. A test may name an id; the point of every assertion below is that the
#: CONSUMER cannot.
_IMAGE = "spatial/image"
_LABELS = "spatial/labels"

#: Declaration keys that are identity or prose, and therefore not part of "the container a
#: consumer sees". `ingest` is here for a reason worth stating: it is an UPLOAD-time sniff
#: key (`datatype/sniff.rs` matches a file EXTENSION), and a consumer choosing between two
#: artifacts already in a project holds rows, not filenames — so it can no more separate
#: them than the layout can.
_NOT_A_CONSUMER_FACT = {"id", "title", "description", "ingest"}


def _load(path):
    return yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}


def _datatypes(manifest):
    return list((manifest.get("contributes") or {}).get("datatypes") or [])


def _spatial_types():
    return {t["id"]: t for t in _datatypes(_load(_MANIFEST))}


def _all_datatypes():
    """Every contributed datatype in the tree, keyed by id (the same set the vocabulary
    guard derives its forbidden tokens from)."""
    out = {}
    for mf in sorted(_PACKAGES.glob("*/manifest.yaml")):
        for dt in _datatypes(_load(mf)):
            out[dt["id"]] = dt
    return out


def _view_kinds(dt):
    return [v["view_kind_id"] for v in (dt.get("viewers") or [])]


def _domain_nouns():
    """`DOMAIN_NOUNS` + `ACRONYM_NOUNS`, PARSED out of the shipped FE lint.

    Returns `(nouns, acronyms)`. The lint matches the first tier case-insensitively and the
    second case-sensitively; both are checked below the way the lint checks them.
    """
    text = _DOMAIN_LINT.read_text(encoding="utf-8")
    out = []
    for const in ("DOMAIN_NOUNS", "ACRONYM_NOUNS"):
        m = re.search(rf"^const {const} = \[(.*?)\]", text, re.S | re.M)
        assert m, f"`{const}` moved in {_DOMAIN_LINT.name}; re-point this derivation"
        body = re.sub(r"//[^\n]*", "", m.group(1))
        out.append([tok for tok in re.findall(r"'([^']+)'", body)])
    nouns, acronyms = out
    assert len(nouns) >= 20, f"the noun tier parsed to {len(nouns)} terms — the reader broke"
    assert len(acronyms) >= 2, f"the acronym tier parsed to {len(acronyms)} — the reader broke"
    return nouns, acronyms


# ── the PREMISE — #229's first sentence, as an assertion ──────────────────────────────
def test_the_two_raster_kinds_declare_an_identical_container():
    """The two kinds are indistinguishable on everything a container ROUTES on.

    This is the fact that makes #229 a discovery problem: `declaresRaster` in
    `workbenchDataSource.ts` matches `encoding: opaque` + `image/tiff;application=ome`, and
    BOTH kinds produce exactly that. If a future edit made the containers differ — a
    different `format`, a different `file_layout`, an axis on one of them — the discovery
    could route on the container and the whole mechanism below would be unnecessary. So the
    premise is pinned: it must fail LOUDLY if it stops being true, rather than leaving a
    more elaborate answer standing on a question that no longer exists.
    """
    spatial = _spatial_types()
    image, labels = spatial[_IMAGE], spatial[_LABELS]

    container = lambda dt: {k: v for k, v in dt.items() if k not in _NOT_A_CONSUMER_FACT
                            and k != "viewers"}
    got_image, got_labels = container(image), container(labels)
    assert set(got_image) >= {"extends", "storage"}, (
        f"the container view collapsed to {sorted(got_image)} — the two kinds would then\n"
        "agree on nothing at all and the equality below would be vacuous"
    )
    assert got_image == got_labels, (
        "the two OME-TIFF kinds no longer declare the same container; #229's premise has "
        f"changed:\nimage : {json.dumps(got_image, sort_keys=True)}\n"
        f"labels: {json.dumps(got_labels, sort_keys=True)}"
    )
    # …and the shared container really is the opaque raster one, so the equality above is
    # not two kinds agreeing on some emptied-out shape.
    assert got_image["extends"] == "data/opaque"
    assert got_image["storage"]["layout"]["kind"] == "opaque_as_is"
    assert got_image["storage"]["format"] == "ome-tiff"
    assert got_image["storage"]["file_layout"] == "single"


def test_the_declared_viewer_is_the_only_difference_between_them():
    """…and the ONE key that separates them is the one a consumer may act on.

    Stated as a set difference over the whole declaration rather than as "labels declares a
    viewer", because the claim being made is exclusive: a reader who wants to know what
    else might serve as the discriminator gets the answer from this assertion instead of
    from a comment.
    """
    spatial = _spatial_types()
    image, labels = spatial[_IMAGE], spatial[_LABELS]

    differing = {k for k in set(image) | set(labels)
                 if image.get(k) != labels.get(k)} - _NOT_A_CONSUMER_FACT
    assert differing == {"viewers"}, (
        "the declarations differ somewhere other than the declared viewer — either a new "
        f"discriminator appeared or the viewer one is gone: {sorted(differing)}"
    )
    assert _view_kinds(labels), "`spatial/labels` declares no viewer — #229 is open again"
    assert not _view_kinds(image), (
        "`spatial/image` now declares a viewer too. That is not wrong in itself, but it "
        "moves the shared Rust/TS parity golden's `spatial/image -> viewers_for: []` case, "
        "i.e. it makes a package declaration cost an edit under `server/src/` — the trade "
        "the golden's frozen `lattice` array was deleted to avoid."
    )


# ── the DISCRIMINATOR is vocabulary app-core is allowed to hold ───────────────────────
def test_the_discriminator_is_vocabulary_the_app_core_may_spell():
    """A `view_kind_id` clears BOTH guards that close every other route.

    (1) It is not a contributed datatype id, so neither guard that derives its forbidden
        tokens from that set — TEST-1 here, `lint-no-domain-in-builtin.mjs` on the FE side —
        forbids the consumer from spelling it. This is the assertion a generic `image/labels`
        TIER could not satisfy: an id is forbidden vocabulary the moment it is declared.
    (2) It carries no term from the FE domain lint's noun list, PARSED from the lint itself.
        Checked as a plain case-insensitive substring, which is STRICTER than the lint's own
        boundary rules — a term that would pass here cannot fail there.
    """
    labels = _spatial_types()[_LABELS]
    kinds = _view_kinds(labels)
    assert kinds, "no view kind declared — the loops below would assert nothing"

    contributed = set(_all_datatypes())
    assert len(contributed) >= 15, f"only {len(contributed)} contributed ids — reader broke"

    nouns, acronyms = _domain_nouns()
    for kind in kinds:
        assert kind not in contributed, (
            f"the discriminator `{kind}` is also a contributed datatype id, so the derived-"
            "vocabulary guard forbids the consumer from spelling it — which is the exact "
            "wall #229 hit"
        )
        for noun in nouns:
            assert noun.lower() not in kind.lower(), (
                f"the discriminator `{kind}` carries the domain noun `{noun}`; the app core "
                "may hold presentation vocabulary but never biology"
            )
        for acronym in acronyms:
            assert acronym not in kind, f"`{kind}` carries the domain acronym `{acronym}`"


def test_the_declared_viewer_names_a_capability_something_actually_declares():
    """`consumes` is CHECKED, which is what makes this a declaration and not a tag.

    The objection to a free-form `role:` string is that nothing validates it. A viewer's
    `consumes` is validatable against the same lattice everything else is: it names what the
    renderer needs from ELSEWHERE in the project (a label mask is meaningless without the
    per-entity lookup its integers index into), so every entry must be a capability some
    contributed type really declares. An invented one would be the silently-ignored-key
    class this tree removes on sight.

    Note what it is NOT: a claim about the bytes inside the container. It sits on the
    viewer, not in `capabilities`, and every shipped INV-7 predicate reads `capabilities`.
    """
    declared_caps = set()
    for dt in _all_datatypes().values():
        declared_caps.update(dt.get("capabilities") or [])
    assert len(declared_caps) >= 5, f"only {len(declared_caps)} capabilities — reader broke"

    labels = _spatial_types()[_LABELS]
    consumed = [c for v in (labels.get("viewers") or []) for c in (v.get("consumes") or [])]
    assert consumed, "the declared viewer consumes nothing — a mask alone renders nothing"
    for cap in consumed:
        assert cap in declared_caps, (
            f"the label-mask viewer consumes `{cap}`, which NO contributed type declares — "
            "a declaration nothing can satisfy"
        )

    # …and declaring a viewer added no INV-7 exposure: still no capabilities, no axes, no
    # schema, no arrays on the container itself.
    for forbidden in ("capabilities", "axes", "schema", "arrays"):
        assert not labels.get(forbidden), (
            f"`{_LABELS}` now declares `{forbidden}` — an opaque container may not (INV-7)"
        )


#: The consumer this declaration exists FOR. Named as a path and re-derived on every run, the
#: same way TEST-14 re-derives the grouping marker from `repository.rs`'s own constant rather
#: than restating its value: two halves of one contract that live in different languages drift
#: silently, and the drift is invisible from either side.
_CONSUMER = (_REPO / "src-app" / "ui" / "src" / "modules" / "workbench" / "extensions" / "data"
             / "workbenchDataSource.ts")


def test_the_consumer_and_the_declaration_name_the_same_view_kind():
    """The declaration and the code that reads it are BOUND, in both directions.

    Without this the two are a private handshake with nothing holding it: rename the
    `view_kind_id` here and the consumer keeps looking for the old token, silently classifying
    every mask as a picture again — with this suite green, because every other assertion in this
    file reads the manifest alone, and with the UI suite green, because its fixtures declare
    whatever the constant says. That is #229 restored under a passing gate.

    The assertion is deliberately one-way in what it PARSES (the constant out of the consumer)
    and two-way in what it CATCHES: a rename on either side breaks the equality.
    """
    source = _CONSUMER.read_text(encoding="utf-8")
    m = re.search(r"^const LABEL_MASK_VIEW_KIND = '([^']+)'", source, re.M)
    assert m, (
        f"the consumer's discriminator constant is no longer declared in {_CONSUMER.name}; "
        "re-point this derivation rather than deleting it — an unbound declaration is how the "
        "two halves come apart"
    )
    declared = _view_kinds(_spatial_types()[_LABELS])
    assert m.group(1) in declared, (
        f"`{_CONSUMER.name}` looks for the view kind `{m.group(1)}`, which `{_LABELS}` does not "
        f"declare (it declares {declared}). The raster discovery would classify every label "
        "mask as a tissue image again."
    )


# ── the CONSUMER, simulated blind ─────────────────────────────────────────────────────
def _redacted(dt):
    """A declaration as a DOMAIN-BLIND consumer sees it: no id, no title, no prose.

    The workbench holds the lattice and the artifact row; what it may not read is the
    contributed id. Redacting it here is what stops a resolver from passing by recognising
    the kind — the failure mode that makes an id-based answer look like a layout-based one.

    `ingest` goes with it, for the reason recorded on `_NOT_A_CONSUMER_FACT`: it matches a
    file EXTENSION at upload time, and a consumer choosing between two artifacts already in
    a project holds rows, not filenames.
    """
    return {k: v for k, v in dt.items()
            if k not in ("id", "title", "description", "ingest")}


def _classify(decl, label_mask_view_kind):
    """The rule a consumer runs, over a redacted declaration.

    `index` — the pixel values are keys into an entity axis (nearest-neighbour, no
    windowing, drives selection through a sibling per-entity lookup).
    `intensity` — pixels to be looked at.

    Fail-open on purpose, and the posture is the discovery's existing one: a raster whose
    producer declares nothing is still renderable, because excluding it would trade a
    hypothetical wrong picture for a certain absent one.
    """
    kinds = [v["view_kind_id"] for v in (decl.get("viewers") or [])]
    return "index" if label_mask_view_kind in kinds else "intensity"


def test_a_domain_blind_consumer_separates_them_and_cannot_without_the_viewer():
    """The whole issue, as one pair of assertions.

    The positive half: a resolver that never sees an id classifies the two correctly. The
    negative half is what gives the positive one meaning — strip the viewer declaration and
    the SAME resolver, over the SAME two declarations, returns the identical answer for
    both. That is #229 reproduced on demand: two kinds, one container, no way to choose.
    """
    spatial = _spatial_types()
    declared = _view_kinds(spatial[_LABELS])
    assert declared, (
        "`spatial/labels` declares no view kind, so there is no discriminator to run this "
        "simulation with — which is #229's open state, not a passing test"
    )
    view_kind = declared[0]

    image, labels = _redacted(spatial[_IMAGE]), _redacted(spatial[_LABELS])
    assert "id" not in image and "id" not in labels, "the redaction leaked the id"

    assert _classify(labels, view_kind) == "index", (
        "a domain-blind consumer cannot tell the label mask is an index raster"
    )
    assert _classify(image, view_kind) == "intensity", (
        "the tissue image was classified as an index raster — the rule is inverted or the "
        "image picked up a label-mask viewer"
    )

    # The NEGATIVE CONTROL: without the declared viewer the two are indistinguishable, so
    # the assertions above are testing the declaration rather than some other difference
    # that happens to be there.
    blind = lambda d: {k: v for k, v in d.items() if k != "viewers"}
    assert _classify(blind(labels), view_kind) == _classify(blind(image), view_kind), (
        "with the viewer removed the resolver STILL separates them — something else is "
        "carrying the distinction, and this test is no longer measuring what it claims"
    )
    assert blind(labels) == blind(image), (
        "with the viewer removed the two declarations are not identical — the premise test "
        "and this one disagree, which means one of them is reading the wrong thing"
    )
