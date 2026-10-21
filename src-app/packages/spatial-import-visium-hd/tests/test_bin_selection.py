#!/usr/bin/env python3
# ruff: noqa
"""TEST-14..16 — the bin choice: the parameter, the default, and its disclosure.

The bin is the one genuine PRODUCT decision in this package and it is NOT owner-confirmed
(`.lifecycle/visium-hd-import/DECISIONS.md` DEC-1). What that costs the tests is specific:
it is not enough that the default WORKS, it has to be VISIBLE and it has to be CHEAP TO
MOVE. So TEST-15 asserts the number lives in exactly one place and that the sentence the
report says about it is derived from that place — because the failure mode of an unconfirmed
default is not a wrong import, it is a right import whose disclosure went stale the day the
owner ruled.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402


def _report(outputs_dir):
    return json.loads(
        (Path(outputs_dir) / "visium-hd-import-report.json").read_text(encoding="utf-8")
    )


def test_TEST_14_with_no_parameter_the_run_uses_the_DEFAULT_and_says_so(tmp_path):
    """TEST-14 — the default applies, and the report states BOTH that it applied and what else was there.

    Two separate claims, and the second is the one #313 is about. A report that named only
    the bin would leave a reader unable to tell an owner-confirmed choice from this
    importer's unconfirmed default — which is precisely how "an unstated default becomes a
    shipped contract".
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    report = _report(tmp_path / "out")

    assert report["bin_um"] == module.DEFAULT_BIN_UM
    assert report["bin_chosen_by"] == "default"
    assert report["bin_default_um"] == module.DEFAULT_BIN_UM
    assert report["bins_available"] == sorted(MF.BINS)
    assert sorted(report["bins_not_imported"]) == sorted(b for b in MF.BINS
                                                         if b != module.DEFAULT_BIN_UM)
    # ...and the disclosure reaches a HUMAN, which in this app means artifact `meta` and not
    # the embedded HTML: nothing here renders `report/html` (#223).
    qc_entry = HF.entry_by_id(entries, "visium-hd-import-report")
    assert qc_entry["meta"]["bin_chosen_by"] == "default"
    assert str(module.DEFAULT_BIN_UM) in qc_entry["meta"]["bin_choice"]


def test_TEST_14_the_parameter_selects_another_bin_end_to_end(tmp_path):
    """TEST-14 — `bin_um: 16` really imports the 16 um bin, checked against that bin's own matrix.

    Asserted on the ROW COUNT read out of the emitted artifact and compared against the
    fixture's 16 um matrix, not against the parameter that was passed — otherwise the test
    would pass for an importer that recorded the request and imported the default.
    """
    module, entries = HF.run_over(HF.FIXTURE, tmp_path / "out", requested_bin=16)
    report = _report(tmp_path / "out")

    assert report["bin_um"] == 16
    assert report["bin_chosen_by"] == "parameter"
    expected_rows = sum(1 for r in MF.positions_rows(16) if r[1] == 1)
    assert report["n_bins"] == expected_rows
    coords = HF.read_member(tmp_path / "out", "spatial/coordinates.zarr", "coordinates")
    assert coords.shape == (expected_rows, 2)
    # …and the identity follows the choice, which is the point of stamping it at all.
    assert report["measured_entity"]["resolution_um"] == 16.0


def test_TEST_14_every_declared_bin_is_importable(tmp_path):
    """TEST-14 — all three bins import, including the native 2 um grid.

    2 um is allowed rather than refused (DEC-15): refusing a resolution the vendor emitted
    would be this importer making a scientific judgement it has no standing to make. The
    report states the cost; it does not pre-judge it.
    """
    module = HF.load_compute()
    for bin_um in MF.BINS:
        out = tmp_path / f"out{bin_um}"
        _module, entries = HF.run_over(HF.FIXTURE, out, requested_bin=bin_um)
        report = _report(out)
        assert report["bin_um"] == bin_um
        assert report["measured_entity"]["resolution_um"] == float(bin_um)
        assert report["n_bins"] == sum(1 for r in MF.positions_rows(bin_um) if r[1] == 1)


# ── TEST-15: the default is ONE constant, and its disclosure is DERIVED from it ──────


def test_TEST_15_the_default_is_written_in_exactly_ONE_place(tmp_path):
    """TEST-15 — `DEFAULT_BIN_UM` is the only spelling of the number, in the compute source.

    An unconfirmed default that appears twice is an unconfirmed default that will be moved
    once. The scan is over the module's own source, and it deliberately excludes the places
    the number legitimately appears as something else — a bin DIRECTORY name, a nesting
    ratio, a citation to `06-spatial-processing.md:582` — by requiring that any other
    occurrence of the bare token be inside a comment or a string, never in code.

    `encoding="utf-8"` is EXPLICIT: this module's prose carries em dashes, so under `LC_ALL=C`
    a locale-default read raises and the guard would go red for a reason unrelated to what it
    measures (#330/#333/#336/#339).
    """
    import ast

    module = HF.load_compute()
    source = HF.COMPUTE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    assignments = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "DEFAULT_BIN_UM" for t in n.targets)
    ]
    assert len(assignments) == 1, (
        f"`DEFAULT_BIN_UM` is assigned {len(assignments)} times; the default must have one "
        "home or moving it leaves a stale copy behind"
    )
    # And no CONSUMER of the default may spell the value as a literal.
    #
    # Scoped to the three functions that consume it rather than swept over the whole module,
    # and the reason is a real collision rather than caution: `_REFUSAL_QUOTE_ITEMS` is also
    # 8, for reasons that have nothing to do with bins, and a module-wide literal count would
    # fail on it — which would push the next maintainer to delete the assertion rather than
    # narrow it. What matters is that the DEFAULT is not spelled twice, and its consumers are
    # where a second spelling would go.
    consumers = ("select_bin", "bin_choice_note", "run_import")
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef) or node.name not in consumers:
            continue
        for sub in ast.walk(node):
            if (isinstance(sub, ast.Constant) and not isinstance(sub.value, bool)
                    and sub.value == module.DEFAULT_BIN_UM):
                offenders.append((node.name, sub.lineno))
    assert not offenders, (
        f"the number {module.DEFAULT_BIN_UM} appears as a bare literal inside {offenders}; "
        "every consumer of the default must go through `DEFAULT_BIN_UM`, or moving the "
        "owner's unconfirmed default (DEC-1) leaves a stale copy behind"
    )


def test_TEST_15_the_reports_disclosure_is_DERIVED_from_the_constant(tmp_path, monkeypatch):
    """TEST-15 — move the constant and the sentence moves with it.

    The mutation IS the assertion. With `DEFAULT_BIN_UM` monkeypatched to 16, a run with no
    parameter must import the 16 um bin AND the report's disclosure sentence must name 16 —
    if the sentence were a hand-written string, it would still say 8 and the disclosure would
    be false the day the owner rules on DEC-1.
    """
    module = HF.load_compute()
    monkeypatch.setattr(module, "DEFAULT_BIN_UM", 16)
    entries = module.run_import(HF.FIXTURE, tmp_path / "out")
    report = _report(tmp_path / "out")

    assert report["bin_um"] == 16
    assert report["bin_chosen_by"] == "default"
    assert report["bin_default_um"] == 16
    note = report["bin_choice_note"]
    assert "16 um" in note
    assert "8 um" not in note.split("The other bins")[0], (
        "the disclosure still names the OLD default, so it is a hand-written sentence rather "
        "than one derived from the constant"
    )


def test_TEST_15_the_note_names_the_bins_that_were_NOT_imported(tmp_path):
    """TEST-15 — DEC-14: a member that was present and deliberately not read is not the same
    fact as one that was absent, and the report has to keep them distinguishable.

    It also has to say what to DO about it — the resolution-group sentence — because the
    alternative reading of "one run imports one bin" is that the other two are lost.
    """
    module = HF.load_compute()
    _module, _entries = HF.run_over(HF.FIXTURE, tmp_path / "out")
    note = _report(tmp_path / "out")["bin_choice_note"]
    for other in (b for b in MF.BINS if b != module.DEFAULT_BIN_UM):
        assert f"{other} um" in note
    assert module.BIN_PARAM in note
    assert "resolution group" in note


# ── TEST-16: everything that is not a bin this bundle carries ───────────────────────


@pytest.mark.parametrize("requested", [
    2.5,                    # a real number, not a bin
    "eight",                # a string
    True,                   # `bool` is an `int` subclass — would otherwise read as the 1 um bin
    None,                   # …only via the params dict; here it means "use the default"
    float("inf"),           # `json.loads` accepts `Infinity`
    float("nan"),
    10 ** 400,              # a Python int too large for a double — `math.isfinite` RAISES on it
    -8,
    0,
    4,                      # a plausible bin size Space Ranger does not write by default
])
def test_TEST_16_a_bin_that_is_not_in_the_bundle_is_refused_BY_NAME(requested, tmp_path):
    """TEST-16 — every unusable `bin_um` is a named refusal listing what IS available.

    Never a traceback, and — the half that matters — never a silent fall back to the default.
    A parameter that was asked for and quietly ignored is worse than one that was rejected:
    the user gets an import at a resolution they did not choose, stamped as if they had.

    `None` is in the table on purpose as the CONTROL: it is the "no parameter supplied" case
    and must succeed, so the parametrisation cannot pass by refusing everything.
    """
    module = HF.load_compute()
    available = sorted(MF.BINS)
    if requested is None:
        bin_um, chose_by = module.select_bin(available, None)
        assert (bin_um, chose_by) == (module.DEFAULT_BIN_UM, "default")
        return
    with pytest.raises(module.VisiumImportError) as exc:
        module.select_bin(available, requested)
    message = str(exc.value)
    assert module.BIN_PARAM in message
    for bin_um in available:
        assert str(bin_um) in message, "the refusal must list the bins that ARE available"


def test_TEST_16_the_default_being_absent_is_ALSO_a_named_refusal(tmp_path):
    """TEST-16 — a bundle with no 8 um bin does not fall through to whatever is there.

    Reachable only with a non-default bin set, which is why it has its own case: the "no
    parameter" path has no user input to blame, so the temptation to pick the nearest bin is
    strongest exactly where the user is least able to see it happen.
    """
    module = HF.load_compute()
    with pytest.raises(module.VisiumImportError) as exc:
        module.select_bin([2, 16], None)
    message = str(exc.value)
    assert str(module.DEFAULT_BIN_UM) in message
    assert module.BIN_PARAM in message


def test_TEST_16_a_bad_parameter_refuses_through_the_SHIPPED_ENTRYPOINT(tmp_path):
    """TEST-16 — the same refusal through `main()`, which is the path a user reaches.

    `select_bin` raising is necessary; `main()` catching it, printing one named line and
    exiting 2 is what a job actually does. A unit test of the predicate cannot see a
    `sys.exit` that was never wired.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    out = tmp_path / "out"
    result = HF.run_entry(inputs, out, params={"bin_um": 5})
    assert result.returncode == 2, result.stderr
    assert "Traceback" not in result.stderr
    assert "bin_um" in result.stderr


# ── TEST-16b: the STRING arm — the declarative select is string-valued (issue #361) ────


def test_TEST_16b_every_bin_the_fixture_carries_is_importable_as_an_exact_integer_string(tmp_path):
    """TEST-16b — the form passes the chosen bin as a STRING ("8", not 8): the declarative
    select is string-valued at the kit level, so `select_bin` must accept an exact-integer
    string for EVERY bin the bundle carries — including the whitespace-padded and
    zero-padded spellings a picker or a hand-edited params file can produce — and return
    the same `(int, "parameter")` as the number path."""
    module = HF.load_compute()
    for bin_um in MF.BINS:
        for spelling in (str(bin_um), f" {bin_um} ", f"0{bin_um}"):
            chosen, chose_by = module.select_bin(sorted(MF.BINS), spelling)
            assert chosen == bin_um
            assert isinstance(chosen, int) and not isinstance(chosen, bool)
            assert chose_by == "parameter"


def test_TEST_16b_a_non_numeric_string_is_still_refused_BY_NAME(tmp_path):
    """TEST-16b — a string that does not denote an exact integer — "banana", "", "8um",
    "8.5", "1e3" — is refused with the "not a bin size" message, naming the offending value
    and the bins that ARE available. The string arm must not silently coerce a non-integer."""
    module = HF.load_compute()
    available = sorted(MF.BINS)
    for bad in ("banana", "", "8um", "8.5", "1e3"):
        with pytest.raises(module.VisiumImportError) as exc:
            module.select_bin(available, bad)
        message = str(exc.value)
        assert module.BIN_PARAM in message
        assert "not a bin size" in message
        for bin_um in available:
            assert str(bin_um) in message


def test_TEST_16b_a_numeric_string_for_a_bin_the_bundle_does_NOT_carry_is_refused(tmp_path):
    """TEST-16b — "4" names a plausible bin the fixture does not carry: the string arm must
    fall through to the "not a bin this bundle carries" refusal, not the "not a bin size"
    one — the two refusals stay distinguishable by cause."""
    module = HF.load_compute()
    with pytest.raises(module.VisiumImportError) as exc:
        module.select_bin(sorted(MF.BINS), "4")
    message = str(exc.value)
    assert module.BIN_PARAM in message
    assert "not a bin this bundle carries" in message
    for bin_um in MF.BINS:
        assert str(bin_um) in message


def test_TEST_16b_bool_is_still_refused_before_the_string_arm(tmp_path):
    """TEST-16b — `True` is an `int` subclass AND would coerce to the string "True": the
    bool guard must stay FIRST, so a bool is refused as "not a bin size" rather than parsed."""
    module = HF.load_compute()
    with pytest.raises(module.VisiumImportError) as exc:
        module.select_bin(sorted(MF.BINS), True)
    message = str(exc.value)
    assert module.BIN_PARAM in message
    assert "not a bin size" in message


def test_TEST_16b_a_fractional_float_is_still_refused(tmp_path):
    """TEST-16b — a float with a fractional part (2.5) is still refused, exactly as before
    the string arm existed. The string arm widens the accepted set to exact-integer strings
    only; it does not relax the number path."""
    module = HF.load_compute()
    with pytest.raises(module.VisiumImportError) as exc:
        module.select_bin(sorted(MF.BINS), 2.5)
    message = str(exc.value)
    assert module.BIN_PARAM in message
    assert "not a bin this bundle carries" in message


def test_TEST_16c_the_default_and_an_explicit_choice_are_DISTINGUISHED(tmp_path):
    """TEST-16c — `chose_by` is the provenance the form must preserve (D1): a run that asked
    for 8 um and a run that got 8 um because nobody asked are the same artifacts and
    different decisions, and the report has to be able to tell them apart. The form's
    untouched state sends NO bin, so `select_bin(available, None)` must record
    `"default"`; a picked bin — number or exact-integer string — must record
    `"parameter"`."""
    module = HF.load_compute()
    available = sorted(MF.BINS)
    bin_um, chose_by = module.select_bin(available, None)
    assert (bin_um, chose_by) == (module.DEFAULT_BIN_UM, "default")
    for explicit in (8, "8", " 8 ", "08"):
        chosen, chose_by = module.select_bin(available, explicit)
        assert chosen == module.DEFAULT_BIN_UM
        assert chose_by == "parameter"


def test_TEST_16b_unicode_digits_and_unicode_whitespace_are_refused(tmp_path):
    r"""TEST-16b — the string arm is ASCII-scoped (D2): Python's `\d` matches Unicode digits
    and `str.strip()` strips Unicode whitespace, so without `re.ASCII` + an ASCII-only strip
    a fullwidth "８" or Arabic-Indic "٨" would be read as 8, and an NBSP- or
    ideographic-space-padded " 8" would be stripped and accepted — while the exported
    methods text prints the raw spelling and the artifacts carry 8. All of those are
    REFUSED with the "not a bin size" refusal; plain "8", " 8 " (ASCII spaces) and "08" are
    still ACCEPTED."""
    module = HF.load_compute()
    available = sorted(MF.BINS)
    for bad in (
        "８",                 # fullwidth digit eight (U+FF18)
        "٨",                  # Arabic-Indic digit eight (U+0668)
        "\u00a08",            # leading NBSP (U+00A0)
        "8\u00a0",            # trailing NBSP
        "\u00a08\u00a0",      # NBSP-wrapped
        "\u30008",            # leading ideographic space (U+3000)
        "8\u3000",            # trailing ideographic space
        "\u30008\u3000",      # ideographic-space-wrapped
    ):
        with pytest.raises(module.VisiumImportError) as exc:
            module.select_bin(available, bad)
        message = str(exc.value)
        assert module.BIN_PARAM in message
        assert "not a bin size" in message
    for good in ("8", " 8 ", "08"):
        chosen, chose_by = module.select_bin(available, good)
        assert chosen == module.DEFAULT_BIN_UM
        assert chose_by == "parameter"
