#!/usr/bin/env python3
# ruff: noqa
r"""TEST-19 — EVERY refusal this module can emit is proved safe to put in a `job_logs` row.

The guard is the vendored `visium_hd_refusal_sites.py` (byte-identical to `spatial-import-visium`'s —
TEST-20 holds that shut, and DEC-4 kept this module's exception class named `VisiumImportError`
so it could be). It walks THIS module's own AST, finds every CONSTRUCTION of the refusal, and
demands that each value any of them interpolates be PROVED safe in one of exactly two ways:
it goes through a funnel (`_quoted_for_refusal` / `_quoted_list_for_refusal`), or its SHAPE
cannot carry a vendor byte (a `len()`/`int()`/`ord()` call, a module constant, a name bound
only to literals).

## Why this is structural rather than a list of sites

The defect #336 reports is not "these four refusals are unescaped" — it is that a fix which
NAMES the unescaped sites has the same shape as the defect: it is true of today's module and
silently stops being true the day someone writes one more refusal. So the subject set is
DERIVED. A refusal written tomorrow is inside it the moment it is written, with nobody
remembering anything.

## What consumes the stream, and why this is not cosmetic

`scheduler.rs::drain_logs` reads the compute's stderr with `BufReader::lines()` and writes
EACH LINE as its own `job_logs` row, with no per-line cap, then broadcasts it over SSE; the UI
renders that text HTML-safe but ANSI-unsafe. So a raw `\n` in vendor text FORGES a log row, a
raw `ESC`/`CR`/`BEL` reaches the operator's terminal as a control sequence, and one long line
is one unbounded row. The amplification figures that justify the two funnels were MEASURED on
the sibling's own fixtures and are cited in this module's `compute/` header rather than
restated here as if they had been re-measured on this package's synthesized bundle.

## What this file does NOT prove, and where that half lives

`assert_module_is_funnelled`'s own docstring states the limit: this is a ROUTING guard. It
proves each value GOES THROUGH a funnel; it cannot prove the funnel still ESCAPES anything,
because that is a property of what a function DOES. Redefine `_quoted_for_refusal` as
`return value` and every routing check here still passes. The behavioural half is
`tests/test_refusal_escaping.py` (TEST-21), which runs the real funnels over hostile values
and drives the shipped entrypoint over a hostile bundle.
"""
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import visium_hd_refusal_sites as RS  # noqa: E402


def _module_source():
    r"""The compute's source, read with `encoding="utf-8"` EXPLICITLY.

    Not cosmetic, and not a style rule. This module's prose carries `§ — … → ─`, so under
    `LC_ALL=C` a locale-default read raises `UnicodeDecodeError` — and a guard that raises
    for an environmental reason gets quarantined, skipped, or wrapped in a `try` by the next
    person who meets it on a C-locale box, at which point the whole subject set is empty and
    this file's point evaporates. That is the exact defect class this repo has now shipped
    four times (#330/#333/#336/#339), and TEST-31 exists because of it.
    """
    return HF.COMPUTE.read_text(encoding="utf-8")


def test_TEST_19_every_interpolation_in_every_refusal_is_PROVABLY_safe():
    """TEST-19 — zero unprovable interpolations, over a subject set nobody wrote down.

    `unsafe_interpolations` returning `[]` is the property #336 asks for: every value any
    refusal in this module puts on stderr is either funnelled or provably incapable of
    carrying a vendor byte. The classifier is deliberately NARROW (DEC-2 of the guard's own
    design): where the source and the classifier disagree it is the SOURCE that states the
    fact — `int(shape[1])` rather than `shape[1]` — because a classifier that widens to
    accommodate each new shape converges on accepting everything.

    What this would catch: a refusal added next month that interpolates a vendor filename, a
    column name, a barcode or a third-party exception message directly. It does not need to
    know that refusal exists.

    The failure message enumerates every offending site by line and expression, because "the
    guard is red" without the list is a guard people delete.
    """
    source = _module_source()
    unsafe = RS.unsafe_interpolations(source)
    assert unsafe == [], (
        "refusals in this module interpolate values that are not provably safe to put in a "
        "`job_logs` row:\n"
        + "\n".join(
            f"  {HF.COMPUTE.name}:{line}  {expr}\n      -> {why}" for line, expr, why in unsafe
        )
        + "\n\nRoute the value through `_quoted_for_refusal` / `_quoted_list_for_refusal`, or "
        "state its shape in the source (`int(x)` rather than `x`)."
    )


def test_TEST_19_the_module_DEFINES_the_funnels_it_is_being_checked_against():
    """TEST-19 — the integrity half: the routing guard must not check against nothing.

    `assert_module_is_funnelled` raises when the module does not define both funnels, when
    either is defined MORE THAN ONCE (the second definition silently replaces the first at
    import time, and a routing guard would keep passing while every refusal called something
    else entirely), or when the scalar funnel's body no longer calls `ascii(`.

    That last leg is a FLOOR, not a proof, and the guard says so about itself: what the funnel
    DOES is proved by TEST-21. The floor is still worth having — it makes a silent gutting of
    the funnel a deliberate act rather than a one-word edit.
    """
    RS.assert_module_is_funnelled(_module_source())


def test_TEST_19_the_parser_finds_a_NONZERO_number_of_refusal_sites():
    """TEST-19 — the leg without which a guard that matched NOTHING would report success.

    `unsafe_interpolations` iterates the sites `refusal_sites` returns. A parser that matched
    zero sites would iterate nothing, return `[]`, and pass the test above with a clean bill
    of health on a module putting raw vendor bytes on stderr. `refusal_sites` RAISES rather
    than returning `[]` for exactly that reason — but "it would raise" is a claim about the
    vendored file, so what is measured here is the COUNT this module actually yields.

    The floor is stated as a floor and not as an exact number: this suite must not go red
    because someone added a legitimate refusal. What it must catch is the parser suddenly
    matching far fewer — which is a parser that stopped matching, not a module that got safer.
    """
    _tree, sites = RS.refusal_sites(_module_source())
    assert len(sites) >= 15, (
        f"only {len(sites)} `{RS.REFUSAL}` constructions found in {HF.COMPUTE.name}. This "
        "module refuses on: no bin structure, an unknown or absent bin, a bin identity "
        "disagreement, an unreadable parquet, a missing parquet column, a duplicate barcode, "
        "an unmatched barcode, a non-UTF-8 join key, an unencodable vendor document, a "
        "damaged `/matrix` group, an oversize root attribute and an axis-digest disagreement. "
        "A count this low means the parser stopped matching, not that the module got safer."
    )
    # Every site is reported with a real line number, so the failure message above can point
    # a reader at the source. A site at line 0 is a parse that did not locate anything.
    assert all(lineno > 0 for lineno, _call in sites)


# ── the POSITIVE CONTROLS: a guard whose failure mode is never exercised has none ────


#: The minimum a module needs for the guard to consider it checkable at all: the refusal class
#: and the two funnels. Prepended to every hostile snippet below so that what is being measured
#: is the CLASSIFIER's verdict on the refusal, not `assert_module_is_funnelled` complaining
#: that the funnels are missing.
_PREAMBLE = textwrap.dedent(
    '''
    class VisiumImportError(RuntimeError):
        pass

    def _quoted_for_refusal(value, focus=None, *, noun="path"):
        return ascii(value)

    def _quoted_list_for_refusal(values, noun="value"):
        return "[]"
    '''
)

#: Refusals that no list of TODAY's sites could cover, each of which must come back UNSAFE.
#: The first is the case #336 is actually about; the rest are the spellings and the laundering
#: routes an f-string-only or binding-only checker walks straight past.
_HOSTILE = {
    "a brand-new refusal in a brand-new function": '''
def brand_new_check(vendor_name):
    raise VisiumImportError(f"the bundle declares {vendor_name}, which is wrong.")
''',
    "the %-format spelling": '''
def pct(vendor_name):
    raise VisiumImportError("the bundle declares %s, which is wrong." % vendor_name)
''',
    "the .format() spelling": '''
def fmt(vendor_name):
    raise VisiumImportError("the bundle declares {}, which is wrong.".format(vendor_name))
''',
    "plain concatenation": '''
def cat(vendor_name):
    raise VisiumImportError("the bundle declares " + vendor_name + ", which is wrong.")
''',
    "laundered through a local binding": '''
def laundered(vendor_name):
    shown = vendor_name
    raise VisiumImportError(f"the bundle declares {shown}, which is wrong.")
''',
    "laundered through an accumulator a binding-only check blesses": '''
def acc(names):
    shown = []
    for name in names:
        shown.append(name)
    raise VisiumImportError(f"the bundle declares {shown}, which is wrong.")
''',
}


@pytest.mark.parametrize("label", sorted(_HOSTILE))
def test_TEST_19_the_guard_GOES_RED_on_a_refusal_it_has_never_seen(label):
    """TEST-19 — the control. Zero findings on a clean module proves nothing on its own.

    A classifier with a bug that made everything "safe" would pass every assertion above just
    as green. So the SAME guard, unmodified, is run over synthetic modules each holding a
    refusal a list of today's sites could not possibly cover, and each must come back with at
    least one finding.

    Six spellings, chosen because each defeats a different plausible shortcut: a new function
    (the case #336 is about), `%` and `.format()` (an f-string-only walker), concatenation, a
    value laundered through a local, and an accumulator filled by `.append` (a binding-only
    checker sees the empty literal it was bound to and blesses it — the shape a blind angle
    used to re-introduce #336's own defect into a real module and get a clean bill of health).

    Note what this leg does NOT claim. It does not re-derive the sibling's measured byte
    figures; it asserts the property those measurements motivated — that the guard can SEE a
    violation — on this package's own vendored copy.
    """
    source = _PREAMBLE + _HOSTILE[label]
    findings = RS.unsafe_interpolations(source)
    assert findings, (
        f"the guard reported NOTHING unsafe for {label!r}. It is blind to this spelling, so "
        f"the zero-findings result over {HF.COMPUTE.name} means nothing.\n{source}"
    )


def test_TEST_19_the_guard_RAISES_rather_than_blessing_a_module_it_cannot_check():
    """TEST-19 — the two ways a guard can pass by measuring nothing, both closed.

    1. **A module with NO refusal at all** must RAISE, not report "0 unsafe". Otherwise
       renaming the exception class — or moving the module — turns this whole file green.
    2. **A module missing the funnels** must RAISE, not check every site against a name that
       no longer exists. Otherwise a rename of `_quoted_for_refusal` leaves a routing guard
       happily blessing calls to something else entirely.

    Both are properties of the VENDORED file rather than of the compute, and they are asserted
    here because this suite is the only place they are ever exercised: TEST-20 proves the copy
    is byte-identical, not that the copy works.
    """
    with pytest.raises(AssertionError) as exc:
        RS.unsafe_interpolations("def ordinary():\n    return 1\n")
    assert RS.REFUSAL in str(exc.value)

    with pytest.raises(AssertionError) as exc:
        RS.assert_module_is_funnelled(
            "class VisiumImportError(RuntimeError):\n    pass\n"
            "def check(x):\n    raise VisiumImportError('bad')\n"
        )
    assert "_quoted_for_refusal" in str(exc.value)

    # A funnel defined TWICE: the last definition wins at import time, so a routing guard that
    # only looked for the NAME would keep passing while every refusal called the replacement.
    with pytest.raises(AssertionError) as exc:
        RS.assert_module_is_funnelled(
            _PREAMBLE + "\ndef _quoted_for_refusal(value, focus=None, *, noun='path'):\n"
            "    return value\n"
        )
    assert "more than once" in str(exc.value)

    # A funnel that no longer ESCAPES. The floor, exercised — see the guard's own HONEST LIMIT.
    with pytest.raises(AssertionError) as exc:
        RS.assert_module_is_funnelled(
            'class VisiumImportError(RuntimeError):\n    pass\n'
            'def _quoted_for_refusal(value, focus=None, *, noun="path"):\n    return value\n'
            'def _quoted_list_for_refusal(values, noun="value"):\n    return "[]"\n'
        )
    assert "ascii()" in str(exc.value)
