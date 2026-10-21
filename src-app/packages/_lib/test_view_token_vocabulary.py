#!/usr/bin/env python3
# ruff: noqa
"""#374 — every LITERAL-UNION token a shipped package view declares is one the view-spec admits.

## The defect this exists for, measured twice

`differential-expression/ui/compare.yaml` once declared `tone: destructive` on an alert.
`destructive` is a *shadcn button-variant* token; it is not in `AlertWidget.tone`'s closed
union, and it is not in the kit's `AlertTone` either — so the kit's `toneIcon[tone]` lookup
returned `undefined`, React was handed `<undefined />`, and the live overlap banner CRASHED.
It was found by a user, not by a gate (`9d8025bfa`).

The SAME defect was still live in a second package when this guard was written:
`geneset/ui/collection.yaml` declared `variant: outline` on two buttons. `outline` is the
shadcn token; the view-spec's button vocabulary is `primary | default | destructive`, and the
renderer's `BUTTON_VARIANT` map translates `default` → shadcn `outline`. `outline` missed the
map, the renderer passed `undefined` to `<Button>`, and cva's `defaultVariants` painted both
buttons SOLID PRIMARY. That one does not crash — it silently renders the wrong thing, which is
why it survived. Two packages, two vocabularies, one mistake: a token borrowed from the UI
kit's vocabulary into a DECLARED VIEW, where a different, narrower vocabulary applies.

## Why nothing caught either

`parseViewSpec` (`core/spec/schema.ts`) validates STRUCTURE — unknown widget kinds,
permission-less actions, dangling `$`-refs — and `processorViewSpecs.test.ts` runs it over
every shipped `packages/*/ui/*.yaml`. Neither looks at the value of a literal-union FIELD, so
`tone`/`variant` were unchecked from the yaml all the way to the DOM. The proper long-term
home for this rule is `parseViewSpec` itself (the tokens would then be `as const` arrays in
`core/spec/vocabulary.ts` beside `WIDGET_KINDS`, with the types derived from them); this guard
is the runnable form of the same property, wired to a gate that exists today.

## The admitted sets are DERIVED, never typed here

`differential-expression/tests/test_view_shape.py` guards the same property for ONE package
with a hand-typed `_ALERT_TONES = {...}`. That set is already stale-in-the-loose-direction — it
lists the kit's `neutral`, which `AlertWidget.tone` does not admit — and it is per-package, so
the other seventeen packages are guarded by nothing. This file reads the unions out of the
view-spec type that IS the contract, so a token added or removed there is admitted or refused
here with zero edits to this file. (#303/#324 and both FB-4 rounds are the same enumerate-vs-
derive defect; the repo has now paid for it five times.)

Deriving from `viewSpec.ts` rather than from the kit's `alert.tsx` is deliberate and is the
STRICTER of the two: `AlertTone` (`info|success|warning|error|neutral`) is what the kit will
render without crashing, `AlertWidget.tone` (`info|success|warning|error`) is what a declared
view is allowed to say. A yaml must satisfy the second. The kit lives in the pinned `sdk`
submodule, which need not even be checked out; a guard that reads across that boundary would
report PASS on a bare clone.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[3]

#: The declared view-spec contract — the types `parseViewSpec` validates yaml into, and the
#: single source of truth for every literal-union token a package view may write.
VIEW_SPEC = REPO / "src-app/ui/src/modules/workbench/core/manifest/viewSpec.ts"

#: Where the shipped declarative views live. Same glob the production
#: `import.meta.glob('.../packages/*/ui/*.yaml')` and `processorViewSpecs.test.ts` discover.
PACKAGES = REPO / "src-app/packages"


# ── deriving the admitted sets ──────────────────────────────────────────────────────────


def _interface_body(src: str, name: str) -> str:
    """The brace-matched body of `export interface <name> ... { ... }`.

    Brace-matched rather than regexed to the next `}`: these interfaces contain nested
    object types, and a lazy match would truncate the block and silently derive a SMALLER
    set — the failure mode where a guard passes because it stopped reading.
    """
    m = re.search(rf"^export interface {re.escape(name)}\b[^{{]*{{", src, re.M)
    assert m, (
        f"{VIEW_SPEC.name}: no `export interface {name}` — this guard derives its admitted "
        f"tokens from that declaration and cannot fall back to a typed-in list. If the "
        f"interface was renamed or moved, point this guard at the new home."
    )
    depth, i = 0, m.end() - 1
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j]
    pytest.fail(f"{VIEW_SPEC.name}: unbalanced braces in `interface {name}`")


def _string_union(body: str, field: str, *, owner: str) -> tuple[str, ...]:
    """The quoted members of `<field>?: 'a' | 'b' | 'c'` declared directly in `body`."""
    m = re.search(rf"^\s*{re.escape(field)}\??:\s*((?:'[^']*'\s*\|\s*)*'[^']*')\s*$", body, re.M)
    assert m, (
        f"{VIEW_SPEC.name}: `{owner}.{field}` is no longer a single-line string-literal union. "
        f"This guard derives the admitted `{field}` tokens from it; if the shape changed "
        f"(a named type alias, a multi-line union), update the derivation — do NOT type the "
        f"tokens into this file, which is the drift #374 and #303/#324 are all instances of."
    )
    members = tuple(re.findall(r"'([^']*)'", m.group(1)))
    assert len(members) >= 2, f"{VIEW_SPEC.name}: `{owner}.{field}` derived to {members!r}"
    return members


_SRC = VIEW_SPEC.read_text(encoding="utf-8")

#: Admitted `tone:` values for a `kind: alert` widget — derived, never typed.
ALERT_TONES = frozenset(_string_union(_interface_body(_SRC, "AlertWidget"), "tone", owner="AlertWidget"))

#: Admitted `variant:` values for a `kind: button` widget (and for a table cell's `button:`).
BUTTON_VARIANTS = frozenset(_string_union(_interface_body(_SRC, "ButtonWidget"), "variant", owner="ButtonWidget"))


def _views() -> list[Path]:
    return sorted(p for p in PACKAGES.glob("*/ui/*.y*ml") if p.suffix in (".yaml", ".yml"))


def _nodes(node, parent_key=None, trail=""):
    """Every dict in a parsed view, with the key it hung from and a printable path.

    Recurses through table columns, cells, groups and `children` — a bad token nested
    three levels into a table cell is exactly as live as one on a top-level widget.
    """
    if isinstance(node, dict):
        yield parent_key, node, trail or "<root>"
        for k, v in node.items():
            yield from _nodes(v, k, f"{trail}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _nodes(v, parent_key, f"{trail}[{i}]")


def _scan():
    """(tone_sites, variant_sites, stray_sites) across every shipped view.

    A site is `(field, view, path, id, value, kind)`. `stray_sites` are `tone:`/`variant:`
    keys on a node that carries NEITHER — a declaration the renderer reads from nowhere,
    i.e. a silent no-op.
    """
    tones, variants, strays = [], [], []
    for path in _views():
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        rel = path.relative_to(REPO)
        for parent_key, node, trail in _nodes(doc):
            wid = node.get("id")
            if "tone" in node:
                site = (rel, trail, wid, node["tone"], node.get("kind"))
                (tones if node.get("kind") == "alert" else strays).append(("tone",) + site)
            if "variant" in node:
                site = (rel, trail, wid, node["variant"], node.get("kind"))
                holder = node.get("kind") == "button" or parent_key == "button"
                (variants if holder else strays).append(("variant",) + site)
    return tones, variants, strays


# ── the derivation itself ───────────────────────────────────────────────────────────────


def test_the_admitted_sets_are_the_view_specs_own_unions():
    # A regex that matched too greedily, or a brace-walk that stopped early, would derive an
    # EMPTY or a WILDCARD set and every membership assertion below would pass vacuously. So
    # pin the two properties #374 turns on: the tokens the view-spec admits, and the two it
    # does not — the shadcn tokens that reached a live view from the wrong vocabulary.
    assert "error" in ALERT_TONES and "destructive" not in ALERT_TONES, sorted(ALERT_TONES)
    assert "destructive" in BUTTON_VARIANTS and "outline" not in BUTTON_VARIANTS, sorted(BUTTON_VARIANTS)


def test_the_view_spec_declares_ONE_button_variant_vocabulary():
    # `ButtonWidget.variant` and the table cell's `button.variant` are two declarations of the
    # same vocabulary (`TableCellSpec.button` documents itself as behaving "exactly as a
    # top-level `button`'s"). This guard applies the ButtonWidget set to BOTH, which is only
    # sound while they agree — so assert they agree rather than assume it. If they ever
    # diverge deliberately, split the derivation per context; do not delete this.
    unions = re.findall(r"^\s*variant\??:\s*((?:'[^']*'\s*\|\s*)*'[^']*')\s*$", _SRC, re.M)
    assert len(unions) >= 2, f"expected ButtonWidget.variant AND the cell button's; found {unions!r}"
    sets = {frozenset(re.findall(r"'([^']*)'", u)) for u in unions}
    assert sets == {BUTTON_VARIANTS}, (
        f"{VIEW_SPEC.name}: the `variant` unions have DIVERGED — {[sorted(s) for s in sets]}. "
        f"A view author sees one vocabulary; make this guard derive one set per context."
    )


def test_the_scan_reached_the_shipped_views_and_found_real_tokens():
    # The non-vacuity floor. A glob that matches nothing, or a walker that never descends,
    # makes every assertion below a green over an empty set — the exact vacuous PASS the
    # whole file exists to remove. Floors are measured (27 views, 57 tones, 34 variants at
    # #374) and set well under, so ordinary authoring never touches them.
    views = _views()
    assert len(views) >= 10, f"only {len(views)} package views discovered: {views}"
    pkgs = {p.parent.parent.name for p in views}
    assert {"differential-expression", "geneset", "qc"} <= pkgs, sorted(pkgs)
    tones, variants, _ = _scan()
    assert len(tones) >= 20, f"only {len(tones)} alert tones reached"
    assert len(variants) >= 10, f"only {len(variants)} button variants reached"


# ── the property ────────────────────────────────────────────────────────────────────────


def test_every_alert_tone_in_every_package_view_is_an_admitted_tone():
    bad = [s for s in _scan()[0] if s[4] not in ALERT_TONES]
    assert not bad, "\n".join(
        [
            f"alert tone outside `AlertWidget.tone` {sorted(ALERT_TONES)} — the kit's "
            f"`toneIcon[tone]` returns undefined for an unknown tone and CRASHES the widget "
            f"at runtime (#374, `9d8025bfa`):"
        ]
        + [f"  {v}{t} (id={i!r}): tone: {val!r}" for _, v, t, i, val, _k in bad]
    )


def test_every_button_variant_in_every_package_view_is_an_admitted_variant():
    bad = [s for s in _scan()[1] if s[4] not in BUTTON_VARIANTS]
    assert not bad, "\n".join(
        [
            f"button variant outside the view-spec's {sorted(BUTTON_VARIANTS)} — the "
            f"renderer's BUTTON_VARIANT map has no entry, so <Button> is handed `undefined` "
            f"and cva paints it SOLID PRIMARY. It does not crash; it silently renders the "
            f"wrong button (#374). NOTE `default` is the view-spec's word for the shadcn "
            f"`outline` look — write `default`, not `outline`:"
        ]
        + [f"  {v}{t} (id={i!r}): variant: {val!r}" for _, v, t, i, val, _k in bad]
    )


def test_tone_and_variant_are_declared_only_where_the_view_spec_carries_them():
    # `tone` exists only on `AlertWidget`, `variant` only on `ButtonWidget` / a table cell's
    # `button:`. Declared anywhere else the key is read by nobody — the author sees no error
    # and no effect, which is how `variant: outline` survived: a token that does nothing is
    # indistinguishable from one that works until someone looks at the pixels.
    strays = _scan()[2]
    assert not strays, "\n".join(
        ["`tone:`/`variant:` on a widget that does not carry it — a silent no-op (#374):"]
        + [f"  {v}{t} (id={i!r}, kind={k!r}): {f}: {val!r}" for f, v, t, i, val, k in strays]
    )
