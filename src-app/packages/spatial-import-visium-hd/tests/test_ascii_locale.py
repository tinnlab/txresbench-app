#!/usr/bin/env python3
# ruff: noqa
r"""TEST-31 — the whole import is byte-identical under an ASCII locale. Digest for digest.

This repo has now shipped the locale-default decode defect FOUR times (#330 / #333 / #336 /
#339). Its shape is always the same: a `read_text()` or `open()` with no `encoding=` argument
resolves to `locale.getpreferredencoding(False)`, which on a developer box and in CI is UTF-8
and in a container with `LC_ALL=C` is `ANSI_X3.4-1968`. So the code works everywhere it is
tested and mis-decodes — or raises — exactly where it runs.

The consequences this module could have had are concrete, not abstract:

* `read_scalefactors` catches `ValueError`, and `UnicodeDecodeError` IS one. A locale-default
  read of an ORDINARY bundle whose scale file carries legitimate UTF-8 would be swallowed into
  `{}`, and the run would then report "no scale declared" about a document that declares one —
  a false statement about the vendor's file, produced by the machine's locale.
* `load_inputs_index` reads `inputs.json`, which carries a user-chosen mount name the server
  does not ASCII-escape. The sibling MEASURED that read at the locale default refusing a
  COMPLETE ordinary bundle under `LC_ALL=C`
  (`docs/design/vendor-text-encodability-refusal.md` §6.8 item 9).

So the claim is not "no exception is raised". It is that the ARTIFACTS ARE THE SAME — every
emitted byte, under both locales — because a mis-decode that silently drops a scale, a label
or a provenance string produces a perfectly successful run with different contents.

## The first assertion is about the ENVIRONMENT, not about the importer

A locale test that quietly ran in UTF-8 proves nothing at all, and would be indistinguishable
from a passing one. `hd_fixtures.ASCII_LOCALE_ENV` needs all four of its keys to work —
`PYTHONUTF8=0` turns PEP 540 off, `PYTHONCOERCECLOCALE=0` turns PEP 538's C -> C.UTF-8
coercion off, and `LC_ALL=C`/`LANG=C` then yield `ANSI_X3.4-1968`; drop any one and the child
is back in UTF-8. So the encoding the child ACTUALLY got is measured, in a subprocess, before
anything else in this file is believed.

## The one exclusion, and why it is by NAME

`spatial-image-hires.ome.tif` differs between ANY two runs, in ANY locale: `tifffile` stamps a
fresh `urn:uuid:` (a uuid1, i.e. time + MAC) into the OME-XML on every write. It is excluded
from the digest comparison BY NAME, with the reason stated here and at the assertion — never
by a prefix, never by a suffix rule, and never by a blanket "some files may differ" tolerance,
because either of those would also excuse a file that differed for a reason that IS the locale.
And it is not simply skipped: [`test_TEST_31_the_excluded_image_differs_ONLY_in_its_per_write_UUID`]
compares its bytes with the UUID normalised away and requires the rest to be identical.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402

#: A UTF-8 locale, stated EXPLICITLY rather than inherited. The comparison is between two
#: named environments; taking "whatever this machine happens to be" as the baseline would make
#: a green result depend on the developer's shell, and would make the ASCII run's difference
#: unattributable when it appeared.
UTF8_LOCALE_ENV = {"PYTHONUTF8": "1", "PYTHONCOERCECLOCALE": "1",
                   "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8"}

#: What CPython reports for `locale.getpreferredencoding(False)` under each. The ASCII name is
#: glibc's canonical spelling of US-ASCII; `sys.getfilesystemencoding()` reports it as `ascii`.
_ASCII_ENCODINGS = {"ANSI_X3.4-1968", "US-ASCII", "ascii"}

#: THE ONE EXCLUDED FILE, by exact name. See the module docstring: `tifffile` writes a fresh
#: `urn:uuid:` (uuid1) into the OME-XML on every call, so two runs a millisecond apart in the
#: SAME locale differ here too. Excluded by name and not by a `.ome.tif` suffix rule, because a
#: suffix rule would also excuse a second image that differed for a reason that IS the locale.
UUID_STAMPED = "spatial-image-hires.ome.tif"

#: The uuid1 `tifffile` stamps, as it appears in the file's bytes. Normalised (not deleted) so
#: the excluded file can still be compared byte for byte on everything else.
_URN_UUID = re.compile(rb"urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                       rb"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _preferred_encoding(env):
    """What `locale.getpreferredencoding(False)` really is in a child started with `env`.

    A SUBPROCESS, because that is the only thing that can answer it: the locale is fixed when
    the interpreter starts, so nothing this pytest process does to `os.environ` changes its
    own answer, and asking about `env` any other way would be reasoning rather than measuring.
    """
    child = dict(os.environ)
    child.update(env)
    probe = (
        "import json, locale, sys;"
        "print(json.dumps({'preferred': locale.getpreferredencoding(False),"
        " 'filesystem': sys.getfilesystemencoding()}))"
    )
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True,
                            env=child, timeout=120)
    assert result.returncode == 0, (result.returncode, result.stderr[-1000:])
    return json.loads(result.stdout)


def _digests(root):
    """`{relative path: sha256}` for every file under `root`."""
    root = Path(root)
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*")) if path.is_file()
    }


@pytest.fixture(scope="module")
def two_locale_runs(tmp_path_factory):
    """The SAME staged bundle imported twice, once per locale, into two output dirs.

    One staged bundle deliberately: two stagings would be two copies of the same bytes and any
    difference between them would land in the comparison as if it were the locale's doing.

    Module-scoped because each run is a full import of the fixture and the three tests below
    all measure the same pair.
    """
    tmp = tmp_path_factory.mktemp("ascii-locale")
    inputs, _ordinals = HF.staged_flat(tmp)

    runs = {}
    for label, env in (("utf8", UTF8_LOCALE_ENV), ("ascii", HF.ASCII_LOCALE_ENV)):
        outputs = tmp / f"out-{label}"
        result = HF.run_entry(inputs, outputs, env=env)
        runs[label] = {"result": result, "outputs": outputs, "env": env}
    return runs


def test_TEST_31_the_ascii_locale_env_really_gives_the_child_a_NON_UTF8_encoding():
    """TEST-31 — the precondition, measured. A locale test that ran in UTF-8 proves nothing.

    `ASCII_LOCALE_ENV` needs all four of its keys and the reasons are independent: `PYTHONUTF8=0`
    turns PEP 540's UTF-8 mode off, `PYTHONCOERCECLOCALE=0` turns PEP 538's C -> C.UTF-8
    coercion off, and `LC_ALL`/`LANG` then select the C locale. Drop any one — or run on a
    build where one of them stops working — and the child is back in UTF-8, at which point
    every assertion below compares two identical UTF-8 runs and passes forever while proving
    nothing.

    So this measures the encoding the child ACTUALLY got, and it measures the UTF-8 comparand
    too: if BOTH environments produced the same encoding there would be no contrast to test.

    What this would catch: exactly the silent degradation above — a key removed from
    `ASCII_LOCALE_ENV`, or a future CPython that ignores one of them.
    """
    ascii_run = _preferred_encoding(HF.ASCII_LOCALE_ENV)
    assert ascii_run["preferred"] in _ASCII_ENCODINGS, (
        f"the ASCII-locale child reported preferred encoding {ascii_run['preferred']!r}, which "
        f"is not one of {sorted(_ASCII_ENCODINGS)}. `ASCII_LOCALE_ENV` is not doing what it "
        "says, and every assertion in this file would be comparing two UTF-8 runs."
    )
    assert ascii_run["filesystem"] in _ASCII_ENCODINGS, ascii_run

    utf8_run = _preferred_encoding(UTF8_LOCALE_ENV)
    assert utf8_run["preferred"].lower().replace("-", "") == "utf8", utf8_run
    assert ascii_run["preferred"] != utf8_run["preferred"], (
        "both environments produced the same preferred encoding, so there is no contrast for "
        f"this suite to measure: {ascii_run} vs {utf8_run}"
    )

    # And the strict half: at that encoding, the characters this module's own prose and this
    # repo's manifests carry cannot be written at all. That is what makes an unnamed
    # `read_text()` a real defect rather than a stylistic one.
    with pytest.raises(UnicodeEncodeError):
        "—µ".encode(ascii_run["preferred"])


def test_TEST_31_the_import_SUCCEEDS_under_an_ASCII_locale(two_locale_runs):
    """TEST-31 — the floor: the run must not refuse, and must not traceback.

    Stated separately from the digest comparison because the two failures look nothing alike. A
    locale-default read that RAISES gives rc != 0 and a traceback naming `UnicodeDecodeError`;
    one that is SWALLOWED (`read_scalefactors` catches `ValueError`, and `UnicodeDecodeError`
    is one) gives rc == 0 and a quietly different artifact set. This leg catches the first; the
    next catches the second, which is the dangerous one.
    """
    for label, run in sorted(two_locale_runs.items()):
        result = run["result"]
        assert result.returncode == 0, (
            f"the {label} run exited {result.returncode}.\n{result.stderr[-3000:]}"
        )
        assert "Traceback" not in result.stderr, result.stderr[-2000:]
        assert "UnicodeDecodeError" not in result.stderr, result.stderr[-2000:]
        assert (run["outputs"] / "manifest.json").exists()


def test_TEST_31_every_emitted_artifact_is_BYTE_IDENTICAL_across_the_two_locales(two_locale_runs):
    """TEST-31 [e2e] — the real claim, as digests: the locale changes NOTHING that is emitted.

    Not "it did not crash". A mis-decode that is swallowed produces a successful run with
    different contents — a dropped scale, a mangled label, a provenance string that decoded to
    something else — and the only way to see that is to compare the bytes.

    The comparison is exhaustive in both directions: the two runs must emit the SAME SET of
    paths (a file present in one and absent in the other is the swallowed-decode symptom), and
    every shared path must digest identically.

    ONE file is excluded, by exact name, with its reason at the assertion:
    [`UUID_STAMPED`] — `tifffile` stamps a fresh uuid1 into the OME-XML on every write, so it
    differs between any two runs regardless of locale. It is not waved through: the next test
    compares it byte for byte with that UUID normalised away.

    What this would catch: any `open()`/`read_text()`/`write_text()` in this module or its
    vendored helpers that stops naming `encoding="utf-8"`. That is the defect this repo has
    shipped four times, and it is invisible to every other suite in this directory because they
    all run in the developer's own UTF-8 locale.
    """
    utf8 = _digests(two_locale_runs["utf8"]["outputs"])
    ascii_ = _digests(two_locale_runs["ascii"]["outputs"])

    assert len(utf8) > 20, (
        f"the UTF-8 run emitted only {len(utf8)} files; a comparison over an almost-empty "
        "output tree would pass while measuring nothing"
    )
    assert set(utf8) == set(ascii_), (
        "the two locales emitted DIFFERENT SETS of files, which is the swallowed-decode "
        f"symptom.\nonly in utf8: {sorted(set(utf8) - set(ascii_))}\n"
        f"only in ascii: {sorted(set(ascii_) - set(utf8))}"
    )

    differing = sorted(name for name in utf8 if utf8[name] != ascii_[name])
    assert differing == [UUID_STAMPED] or differing == [], (
        "artifacts differ between a UTF-8 locale and an ASCII one, which means something in "
        "this module reads or writes at the LOCALE DEFAULT (#330/#333/#336/#339). Every read "
        "and write must name `encoding=\"utf-8\"` explicitly.\n"
        f"differing: {differing}\n"
        f"(the only file allowed to differ is {UUID_STAMPED!r}, because `tifffile` stamps a "
        "fresh uuid1 into the OME-XML on every write — see the next test, which compares even "
        "that one byte for byte with the UUID normalised away)"
    )

    # The exclusion must not be silently unnecessary either: if the image stopped differing,
    # the reason above has gone stale and the exclusion should be removed rather than left as
    # a standing licence for that filename to differ.
    if differing == []:
        pytest.fail(
            f"{UUID_STAMPED} no longer differs between two runs, so the exclusion in this "
            "file is stale — `tifffile` presumably stopped stamping a per-write uuid1. Remove "
            "the exclusion; do not leave a licence for that filename to differ."
        )


def test_TEST_31_the_excluded_image_differs_ONLY_in_its_per_write_UUID(two_locale_runs):
    """TEST-31 — the excluded file, compared anyway. An exclusion nobody checks is a hole.

    `spatial-image-hires.ome.tif` is left out of the digest sweep because `tifffile` writes a
    fresh `urn:uuid:` (a uuid1: timestamp + MAC address) into the OME-XML on every call. That
    is a property of the writer, not of this module and not of the locale — two runs one
    millisecond apart in the SAME locale differ the same way.

    But "it always differs" is not a licence for it to differ in any OTHER way. So its bytes
    are compared with that one field normalised, and everything else — the OME-XML's affine,
    coordinate space, extent and scale, the TIFF headers, and every pixel — must be identical.

    The normalisation is a fixed-width substitution, so the comparison is still over the whole
    file at its true length rather than over a stripped-down projection of it.

    What this would catch: an OME-XML whose `PhysicalSizeX`, placement affine or `Name` decoded
    differently under the ASCII locale — which is precisely the kind of silent difference the
    exclusion would otherwise hide.
    """
    utf8_path = two_locale_runs["utf8"]["outputs"] / UUID_STAMPED
    ascii_path = two_locale_runs["ascii"]["outputs"] / UUID_STAMPED
    assert utf8_path.exists() and ascii_path.exists()

    utf8_blob = utf8_path.read_bytes()
    ascii_blob = ascii_path.read_bytes()

    # The control: the field really is there, and really is what differs.
    assert _URN_UUID.search(utf8_blob), (
        "no `urn:uuid:` found in the emitted OME-TIFF, so the stated reason for excluding it "
        "from the digest sweep is not the real one — re-derive the exclusion or drop it"
    )
    assert _URN_UUID.findall(utf8_blob) != _URN_UUID.findall(ascii_blob)

    placeholder = b"urn:uuid:" + b"0" * 8 + b"-" + b"0" * 4 + b"-" + b"0" * 4 + b"-" \
        + b"0" * 4 + b"-" + b"0" * 12
    normalised_utf8 = _URN_UUID.sub(placeholder, utf8_blob)
    normalised_ascii = _URN_UUID.sub(placeholder, ascii_blob)

    assert len(normalised_utf8) == len(utf8_blob), "the normalisation changed the file's length"
    assert normalised_utf8 == normalised_ascii, (
        f"{UUID_STAMPED} differs between the two locales somewhere OTHER than its per-write "
        "uuid1, so excluding it from the digest sweep is hiding a real locale difference. "
        "Find the first differing offset and read the OME-XML around it."
    )
