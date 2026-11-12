#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [acceptance] [invariant: INV-2] [covers: ITEM-9] — the run-time half of the
declared dependency + version contract.

The invariant under test is #80's second bullet: *"A run-recorded resolved version for
every scientific library a package's result depends on, asserted against the declared
range."* Each clause is a separate test below, because each is a separate way the old
hand-rolled mechanism failed:

* it recorded a version but asserted nothing (so recording changed no outcome);
* it turned an unreadable version into `None` and carried on (so "we do not know what
  produced this number" could be published as a success);
* it read a hand-typed module list rather than the declaration (so the record described
  libraries the code no longer used, and missed ones it did).

The fixtures declare INVENTED libraries wherever the assertion does not need a real one,
so the tests do not silently depend on what happens to be installed on the test machine.
Where a real distribution IS needed — to separate "absent" from "out of range" — the test
uses one this file itself imports, so its presence is not an assumption.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import txr_deps  # noqa: E402

#: A domain-free `(datatype, layout)` pair. The recorder takes this from its CALLER — a
#: package knows its own output type and app-core does not — so these fixtures name an
#: invented type rather than borrowing a real package's, which would quietly make the
#: shared module look like it belongs to one domain.
FIXTURE_DT = ("test/opaque-record", "opaque")


@pytest.fixture(autouse=True)
def _clear_memo():
    """The module memoizes its answer per (code_dir, lock_path); clear it between tests so
    one test's fixture cannot satisfy another's."""
    txr_deps._MEMO.clear()
    yield
    txr_deps._MEMO.clear()


def _staged(tmp_path, contract):
    """A throwaway `/code`-shaped dir holding a staged contract."""
    d = tmp_path / "code"
    d.mkdir()
    (d / txr_deps.CONTRACT_FILENAME).write_text(json.dumps(contract))
    return d


# ── the resolution + record ──────────────────────────────────────────────────────────

def test_resolves_the_declared_version_and_records_it(tmp_path):
    code = _staged(tmp_path, [{"library": "packaging", "version": ">=20,<100"}])
    rec = txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "absent"))
    assert set(rec["libraries"]) == {"packaging"}, rec
    resolved = rec["libraries"]["packaging"]
    assert resolved and resolved[0].isdigit(), f"a real resolved version, got {resolved!r}"
    # The record carries the DECLARATION alongside the resolution, so a reader can see
    # what was promised as well as what was delivered.
    assert rec["declared"] == [
        {"library": "packaging", "version": ">=20,<100", "resolved": resolved}
    ]
    assert rec["python"].startswith("3.")


def test_an_absent_lock_file_is_recorded_as_absent_not_fabricated(tmp_path):
    code = _staged(tmp_path, [])
    rec = txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "nope"))
    assert rec["env_lock_sha256"] is None
    lock = tmp_path / "lock.txt"
    lock.write_text("alpha==1.0\nbeta==2.0\n")
    txr_deps._MEMO.clear()
    rec = txr_deps.resolve_and_check(code_dir=code, lock_path=str(lock))
    assert rec["env_lock_sha256"].startswith("sha256:")


# ── the two refusals (the half the old mechanism did not have at all) ────────────────

def test_a_declared_library_that_is_absent_is_a_named_refusal(tmp_path):
    code = _staged(tmp_path, [{"library": "txr-not-a-real-distribution", "version": ">=1.0"}])
    with pytest.raises(txr_deps.DependencyRefusal) as e:
        txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "absent"))
    msg = str(e.value)
    assert "txr-not-a-real-distribution" in msg, msg
    assert "republish" in msg.lower(), "the refusal must say what to DO about it"
    # NOT a bare ImportError: the whole point is that the failure names itself.
    assert not isinstance(e.value, ImportError)


def test_a_resolved_version_outside_the_declared_range_is_a_named_refusal(tmp_path):
    """The case that used to publish silently-changed numbers.

    Driven against a distribution that IS installed, with a range chosen to exclude every
    plausible version of it, so the refusal is unambiguously about the RANGE and not about
    absence — those are different failures and a test that could not tell them apart would
    not prove this one.
    """
    code = _staged(tmp_path, [{"library": "packaging", "version": "<1.0"}])
    with pytest.raises(txr_deps.DependencyRefusal) as e:
        txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "absent"))
    msg = str(e.value)
    assert "packaging" in msg and "<1.0" in msg, msg
    assert "OUTSIDE" in msg, msg
    # …and the SAME library passes under a range that admits it, so the refusal is about
    # the range rather than the mechanism refusing everything.
    txr_deps._MEMO.clear()
    widened = tmp_path / "widened"
    widened.mkdir()
    ok = _staged(widened, [{"library": "packaging", "version": ">=1.0"}])
    rec = txr_deps.resolve_and_check(code_dir=ok, lock_path=str(tmp_path / "absent"))
    assert "packaging" in rec["libraries"]


# ── the contract file itself ─────────────────────────────────────────────────────────

def test_a_missing_contract_is_an_empty_contract_but_a_malformed_one_is_refused(tmp_path):
    """These must be DIFFERENT outcomes.

    An entry that declares nothing is staged without a contract, so an absent file has to
    be benign or the mechanism could never be adopted incrementally. A file that exists
    and cannot be parsed can only mean the staging wrote something the reader does not
    understand — treating that as "declares nothing" would reintroduce the exact silent
    non-enforcement this contract exists to remove.
    """
    empty = tmp_path / "empty"
    empty.mkdir()
    assert txr_deps.load_contract(code_dir=empty) == []

    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / txr_deps.CONTRACT_FILENAME).write_text("{not json")
    with pytest.raises(txr_deps.DependencyRefusal):
        txr_deps.load_contract(code_dir=bad)

    wrong = tmp_path / "wrong"
    wrong.mkdir()
    (wrong / txr_deps.CONTRACT_FILENAME).write_text(json.dumps([{"library": "x"}]))
    with pytest.raises(txr_deps.DependencyRefusal):
        txr_deps.load_contract(code_dir=wrong)


def test_name_normalization_matches_the_build_gate(tmp_path):
    """Both sides must agree that these spellings name one distribution, or the gate
    would reject a correct declaration over a hyphen."""
    for raw, want in [
        ("scikit-learn", "scikit-learn"),
        ("scikit_learn", "scikit-learn"),
        ("Scikit.Learn", "scikit-learn"),
        ("  UMAP__Learn  ", "umap-learn"),
    ]:
        assert txr_deps.normalize_name(raw) == want


# ── the wiring: check + record happen together, once ─────────────────────────────────

def test_augment_appends_the_record_and_shares_one_resolution(tmp_path):
    """`augment` is the hook every package's outputs-manifest writer calls. It must emit
    the record AND agree with whatever the entry already resolved for its report —
    a run that reported one set of versions and recorded another would be worse than
    either alone."""
    code = _staged(tmp_path, [{"library": "packaging", "version": ">=1.0"}])
    outputs = tmp_path / "outputs"
    early = txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "absent"))

    entries = [{"id": "something-else"}]
    txr_deps.augment(outputs, entries, FIXTURE_DT, code_dir=code, lock_path=str(tmp_path / "absent"))
    assert len(entries) == 2
    rec_entry = entries[-1]
    assert rec_entry["id"] == txr_deps.OUTPUT_ID
    assert rec_entry["hidden"] is True, "a provenance carrier, not a user-facing result"
    assert rec_entry["datatype"] == FIXTURE_DT[0], (
        "the entry carries the datatype the CALLER passed, not one this module chose"
    )

    written = json.loads((outputs / rec_entry["path"]).read_text())
    assert written["libraries"] == early["libraries"], (
        "the recorded versions must equal the ones the entry reported"
    )


def test_augment_refuses_before_writing_anything(tmp_path):
    """A run whose environment contradicts its declaration must not leave a half-written
    outputs dir behind — the refusal comes first."""
    code = _staged(tmp_path, [{"library": "packaging", "version": "<1.0"}])
    outputs = tmp_path / "outputs"
    with pytest.raises(txr_deps.DependencyRefusal):
        txr_deps.augment(outputs, [], FIXTURE_DT, code_dir=code, lock_path=str(tmp_path / "absent"))
    assert not (outputs / "run-environment.json").exists()


def test_an_entry_declaring_nothing_still_records_an_empty_contract(tmp_path):
    """"This run declared no libraries" is a fact worth having, and it is a DIFFERENT fact
    from "this run predates the mechanism" — which is what an absent record means."""
    code = _staged(tmp_path, [])
    outputs = tmp_path / "outputs"
    entries = []
    txr_deps.augment(outputs, entries, FIXTURE_DT, code_dir=code, lock_path=str(tmp_path / "absent"))
    written = json.loads((outputs / entries[0]["path"]).read_text())
    assert written["declared"] == [] and written["libraries"] == {}
    assert written["python"].startswith("3.")


# ── the declared STRUCTURE of the record, and the two contract fields ────────────────

def test_the_record_entry_declares_a_decodable_structure(tmp_path):
    """The emitted entry must carry an `encoding`-bearing structure.

    This is a REGRESSION test for a defect that shipped: the entry was first hand-spelled
    as `{"kind": "opaque", "media_type": …}`, which `workstore::ingest` refuses at the
    manifest — an artifact's `structure` column has no default, so "there is nothing to
    decode, the media type is the whole story" is a statement the producer has to MAKE.
    It was caught only because an unrelated package's outputs walk happened to check every
    emitted entry; nothing asserted it here, so the same mistake could recur silently.
    """
    code = _staged(tmp_path, [])
    entry = txr_deps.write_record(
        tmp_path / "outputs",
        txr_deps.resolve_and_check(code_dir=code, lock_path=str(tmp_path / "absent")),
        FIXTURE_DT,
    )
    assert entry["datatype"] == FIXTURE_DT[0], (
        "the datatype is the CALLER's — app-core must not name a contributed domain's "
        "vocabulary, so a hard-coded one here would be the defect this asserts against"
    )
    st = entry["structure"]
    assert st.get("encoding") == "opaque", (
        f"an encoding-less structure is refused at ingest: {st!r}"
    )
    assert st.get("media_type") == "application/json"
    assert entry["role"] and entry["layout"] == "opaque"


def test_an_optional_declaration_tolerates_absence_but_not_a_bad_version(tmp_path):
    """`optional` relaxes exactly one leg, and no other.

    Absence stops refusing — that is the whole point, and it is what keeps a
    conditionally-used library from breaking the fallback its own refusal message
    recommends. What is NOT relaxed is the version: a run that DID use the library is a run
    whose result depends on it.
    """
    absent = _staged(tmp_path, [
        {"library": "txr-not-a-real-distribution", "version": ">=1.0", "optional": True},
    ])
    rec = txr_deps.resolve_and_check(code_dir=absent, lock_path=str(tmp_path / "absent"))
    assert rec["declared"][0]["resolved"] is None
    assert rec["declared"][0]["optional"] is True
    # …and it is NOT reported as a resolved library, because nothing resolved.
    assert rec["libraries"] == {}

    txr_deps._MEMO.clear()
    bad = tmp_path / "bad"
    bad.mkdir()
    out_of_range = _staged(bad, [{"library": "packaging", "version": "<1.0", "optional": True}])
    with pytest.raises(txr_deps.DependencyRefusal) as e:
        txr_deps.resolve_and_check(code_dir=out_of_range, lock_path=str(tmp_path / "absent"))
    assert "OUTSIDE" in str(e.value), "an INSTALLED optional library is still range-checked"


def test_a_contract_that_cannot_be_enforced_is_refused_not_softened(tmp_path):
    """Two ways a contract can silently stop enforcing, both refused.

    An EMPTY range is satisfied by every version (`SpecifierSet('')` matches everything),
    so it would degrade the check to a presence test. A non-boolean `optional` decides
    whether an absent library refuses the run, which is not a decision to make by
    truthiness (`bool("false")` is True). Both matter on the per-package runtime-scan
    path — a folder dropped into a deployment — which never passes the build gate.
    """
    for entry, needle in [
        ({"library": "packaging", "version": ""}, "EMPTY"),
        ({"library": "packaging", "version": "   "}, "EMPTY"),
        ({"library": "packaging", "version": ">=1.0", "optional": "false"}, "non-boolean"),
        ({"library": "packaging", "version": ">=1.0", "optional": 1}, "non-boolean"),
    ]:
        d = tmp_path / f"c{abs(hash(str(entry)))}"
        d.mkdir()
        code = _staged(d, [entry])
        with pytest.raises(txr_deps.DependencyRefusal) as e:
            txr_deps.load_contract(code_dir=code)
        assert needle in str(e.value), f"{entry} -> {e.value}"


def test_the_env_lock_digest_is_a_function_of_the_lock_CONTENT(tmp_path):
    """#192 fix round 4 — the only assertion on `env_lock_digest` ranged over a constant.

    `assert rec["env_lock_sha256"].startswith("sha256:")` tests the string literal the
    production code prepends. An audit replaced the hash input with a fixed byte string —
    every image in the fleet recording the same environment identity forever — and this
    module stayed green (12 passed). That function is the whole of the python lane's
    transitive-provenance claim ("two runs whose declared libraries agree but whose
    closures differ are DISTINGUISHABLE"), and nothing asserted it was a function of
    anything.
    """
    import hashlib

    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_bytes(b"numpy==2.4.6\nscipy==1.17.1\n")
    b.write_bytes(b"numpy==2.4.6\nscipy==1.17.2\n")

    da = txr_deps.env_lock_digest(a)
    db = txr_deps.env_lock_digest(b)

    # EQUALITY WITH THE REFERENCE, not a prefix check: this is the claim.
    assert da == "sha256:" + hashlib.sha256(a.read_bytes()).hexdigest()
    # ...and two closures that differ by one character are DISTINGUISHABLE, which is the
    # sentence the docstring makes and the prefix check could not.
    assert da != db


def test_a_lock_that_records_nothing_is_not_given_a_digest(tmp_path):
    """#192 fix round 4 — three readers of this artefact, one of which disagreed.

    The recipe's writer refuses to emit a lock with zero package lines and
    `scripts/env-lock-of.sh` refuses to print one, on the shared reasoning that "an empty
    lock records nothing while looking exactly like a lock". `env_lock_digest` happily
    turned each such artefact into a well-formed `sha256:…` that lands in
    `provenance_run_repro` — a digest that identifies nothing while looking exactly like
    an environment identity, which is the same defect one layer down.
    """
    empty = tmp_path / "empty.txt"
    empty.write_bytes(b"")
    assert txr_deps.env_lock_digest(empty) is None

    header_only = tmp_path / "hdr.txt"
    header_only.write_bytes(b"# R 4.6.1\n# bioconductor 3.23\n# direct-pins 18\n")
    assert txr_deps.env_lock_digest(header_only) is None

    # A shadowed-copy COMMENT carries `==` and is still not a package — the same grammar
    # the shell reader enforces, so the two cannot disagree about what a lock is.
    shadow_only = tmp_path / "shadow.txt"
    shadow_only.write_bytes(b"# R 4.6.1\n# shadowed Matrix==1.7-5 in /x (not the copy R loads)\n")
    assert txr_deps.env_lock_digest(shadow_only) is None

    # CONTROL: one real package line and the same file IS digested, so the cases above
    # fail for the absence of packages and not for the fixture.
    real = tmp_path / "real.txt"
    real.write_bytes(b"# R 4.6.1\n# shadowed Matrix==1.7-5 in /x\nMatrix==1.7-6  # source=CRAN\n")
    assert txr_deps.env_lock_digest(real) is not None


def test_a_symlinked_lock_is_not_digested(tmp_path):
    """#192 fix round 4 — `read_bytes()` follows a symlink; the shell reader refuses one.

    The lock lives inside an image built by whoever published it, so a link there digests
    a file the image does not contain. There is no reading on which that is disqualifying
    for a human operator and acceptable for a provenance row.
    """
    target = tmp_path / "outside.txt"
    target.write_bytes(b"numpy==2.4.6\n")
    link = tmp_path / "link.txt"
    link.symlink_to(target)
    assert txr_deps.env_lock_digest(link) is None
    assert txr_deps.env_lock_digest(target) is not None


# ─────────────────────────────── #214 ───────────────────────────────────────────────


def test_the_exported_pin_parse_reader_is_not_a_parser():
    """TEST-P14 — `_lib/env_pins.py` reads DATA and refuses everything else.

    This module exists so that converting a pin-file reader is one line, which is what
    makes #215 evaporate rather than defer. That only holds if it is not itself an eleventh
    grammar, so its own source is checked for the constructs that would make it one.
    """
    import json
    import hashlib
    from pathlib import Path

    import env_pins

    # Checked over the AST, not over the text. A grep here would match the module's own
    # prose about `str.splitlines()` — the first cut did exactly that — and "a static
    # predicate over text, defeated by prose containing the token it searched for" is
    # itself one of the failures #192 recorded (FB-2). Ask the parser what the code DOES.
    import ast

    tree = ast.parse(Path(env_pins.__file__).read_text(encoding="utf-8"))
    banned_methods = {"splitlines", "partition", "rpartition", "split", "rsplit"}
    banned_modules = {"re"}
    offences = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in banned_methods:
                offences.append(f"line {node.lineno}: .{node.func.attr}()")
            if (
                isinstance(node.func.value, ast.Name)
                and node.func.value.id in banned_modules
            ):
                offences.append(f"line {node.lineno}: {node.func.value.id}.{node.func.attr}()")
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in getattr(node, "names", [])]
            if isinstance(node, ast.ImportFrom):
                names.append(node.module or "")
            if any(n and n.split(".")[0] in banned_modules for n in names):
                offences.append(f"line {node.lineno}: imports {banned_modules & set(names)}")
    assert not offences, (
        f"`env_pins.py` splits or pattern-matches text: {offences}. It is the module every "
        "consumer delegates to precisely so that no consumer has a line, comment or token "
        "rule; giving IT one would move the defect rather than remove it. It is allowed "
        "`json.load` and `hashlib.sha256`, and nothing else that touches these bytes."
    )

    # It loads the SHIPPED artefact and answers about both recipes.
    data = env_pins.load()
    assert set(data["recipes"]) >= {"single-cell", "single-cell-r"}
    assert len(env_pins.pins("single-cell-r")) == 18
    assert env_pins.ecosystem("single-cell-r") == "r"
    assert env_pins.ecosystem("single-cell") == "python"
    assert env_pins.version_of("scDblFinder", "single-cell-r") is not None
    assert env_pins.version_of("not-a-real-package", "single-cell-r") is None


def test_the_reader_refuses_a_stale_or_absent_exported_parse(tmp_path):
    """TEST-P14 / TEST-P21, the refusals — and they are REFUSALS, never skips.

    `just check-py` runs pytest with no cargo anywhere near it, so the build's own freshness
    gate is not in the loop here. Without a consumer-side check, a pin file edited without a
    regen would leave every python gate green over data about a file that had changed.

    The check is **index-and-hash**, which is admissible where a parse is not: each row
    records its own byte range and the SHA-256 of those bytes, so verifying it is a slice
    and a digest. Nothing here asks where a line ends or what a comment is.
    """
    import json
    import hashlib
    from pathlib import Path

    import env_pins
    import pytest as _pytest

    root = tmp_path / "env-rootfs"
    (root / "envx").mkdir(parents=True)
    # A recipe is a DIRECTORY WITH A DOCKERFILE — the same marker the build gate discovers
    # by. The reader compares the artefact's recipe set against the tree's.
    (root / "envx" / "Dockerfile").write_text("FROM scratch\n")
    header = b"# txr:ecosystem=python\n"
    pin_line = b"alpha==1.0  # import=alpha"
    pin_bytes = header + pin_line + b"\n"
    (root / "envx" / "requirements.txt").write_bytes(pin_bytes)

    def artefact(sha=None, pins=None):
        """Write an artefact for `envx`, defaulting to a correct one."""
        raw = (root / "envx" / "requirements.txt").read_bytes()
        off = len(header)
        default = [
            {
                "name": "alpha",
                "raw_name": "alpha",
                "version": "1.0",
                "import": "alpha",
                "line": 2,
                "byte_offset": off,
                "byte_len": len(pin_line),
                "line_sha256": hashlib.sha256(raw[off : off + len(pin_line)]).hexdigest(),
                # COMPUTED, not hand-counted. The first cut counted these by eye and got
                # the import span wrong by two — and the field check under test caught it,
                # which is a small demonstration that the check discriminates.
                "raw_name_span": [off + pin_line.index(b"alpha"), 5],
                "version_span": [off + pin_line.index(b"1.0"), 3],
                "import_span": [
                    off + pin_line.index(b"import=") + len("import="),
                    5,
                ],
            }
        ]
        (root / env_pins.ARTEFACT_NAME).write_text(
            json.dumps(
                {
                    "schema_version": env_pins.SCHEMA_VERSION,
                    "recipes": {
                        "envx": {
                            "ecosystem": "python",
                            "pin_file_sha256": sha
                            if sha is not None
                            else hashlib.sha256(raw).hexdigest(),
                            "pin_sources": [],
                            "pins": default if pins is None else pins,
                        }
                    },
                }
            )
        )
        return json.loads((root / env_pins.ARTEFACT_NAME).read_text())

    # CONTROL FIRST: a correct artefact loads, so every refusal below is attributable to
    # what it changes rather than to the fixture being wrong.
    artefact()
    assert len(env_pins.pins("envx", env_root=root)) == 1

    # (a) STALE — the pin file changed and the artefact did not.
    (root / "envx" / "requirements.txt").write_bytes(header + b"alpha==2.0  # import=alpha\n")
    with _pytest.raises(env_pins.EnvPinsError, match="STALE"):
        env_pins.pins("envx", env_root=root)
    (root / "envx" / "requirements.txt").write_bytes(pin_bytes)

    # (b) MISSING — refused, never a silent empty set.
    artefact()
    (root / env_pins.ARTEFACT_NAME).unlink()
    with _pytest.raises(env_pins.EnvPinsError, match="missing"):
        env_pins.pins("envx", env_root=root)

    # (c) UNKNOWN SCHEMA — refused rather than guessed. A reader that guessed would find no
    #     pins and every derived floor would go quietly vacuous.
    raw = artefact()
    raw["schema_version"] = 999
    (root / env_pins.ARTEFACT_NAME).write_text(json.dumps(raw))
    with _pytest.raises(env_pins.EnvPinsError, match="schema_version"):
        env_pins.pins("envx", env_root=root)

    # (d) AN UNKNOWN RECIPE is a refusal, not an empty list.
    artefact()
    with _pytest.raises(env_pins.EnvPinsError, match="no env recipe"):
        env_pins.pins("nosuch", env_root=root)

    # (e) A RECIPE ON DISK THE ARTEFACT OMITS. The row loop iterates the ARTEFACT, so it
    #     structurally cannot see this — the blind-to-an-addition half of
    #     `derived-guards.md` §4.
    (root / "envy").mkdir()
    (root / "envy" / "Dockerfile").write_text("FROM scratch\n")
    (root / "envy" / "requirements.txt").write_bytes(pin_bytes)
    with _pytest.raises(env_pins.EnvPinsError, match="different recipe sets"):
        env_pins.pins("envx", env_root=root)
    import shutil

    shutil.rmtree(root / "envy")

    # (f) TEST-P21 — A FABRICATED ARTEFACT with a CORRECT pin-file digest.
    #
    #     This is the hole a blind audit demonstrated: the digest proves the FILE is
    #     unchanged, not that the artefact's ROWS were derived from it. An artefact carrying
    #     the right sha256 and invented versions left every python guard green, including
    #     the frozen minimum-pin-set case. Each row now carries its own byte range and hash,
    #     so a fabricated row is caught by the bytes at its own coordinates.
    good = artefact()["recipes"]["envx"]["pins"][0]
    for label, mutation in [
        ("a fabricated VERSION", {"version": "9.9.9"}),
        ("a fabricated NAME", {"raw_name": "not-in-the-file"}),
        ("a fabricated IMPORT token — which a name/version search could not see", {"import": "os.system"}),
        ("a row pointed at a DIFFERENT line", {"byte_offset": 0}),
        ("a row whose length was trimmed to hide a trailing comment", {"byte_len": 10}),
    ]:
        row = dict(good)
        row.update(mutation)
        # The recorded hash is left alone: an attacker who recomputes it has rewritten the
        # row to describe the real bytes, which is not a fabrication any more.
        artefact(pins=[row])
        with _pytest.raises(
            env_pins.EnvPinsError,
            match="hash differently|does not describe the line it points at",
        ):
            env_pins.pins("envx", env_root=root)

    # …and a row with NO coordinates is refused rather than skipped — a row that cannot be
    # checked is worse than a wrong one.
    bare = {
        k: v
        for k, v in good.items()
        if k not in ("byte_offset", "byte_len", "line_sha256")
    }
    artefact(pins=[bare])
    with _pytest.raises(env_pins.EnvPinsError, match="no byte coordinates"):
        env_pins.pins("envx", env_root=root)

    # …and a row missing a FIELD span is refused too, naming the span. A row that can be
    # half-checked is a row whose other half is trusted.
    half = {k: v for k, v in good.items() if k != "version_span"}
    artefact(pins=[half])
    with _pytest.raises(env_pins.EnvPinsError, match="no `version_span`"):
        env_pins.pins("envx", env_root=root)

    # …and coordinates past the end of the file name the arithmetic rather than raising
    # IndexError or silently slicing short.
    over = dict(good)
    over["byte_len"] = 10_000
    artefact(pins=[over])
    with _pytest.raises(env_pins.EnvPinsError, match="bytes long"):
        env_pins.pins("envx", env_root=root)

    # (f4) MALFORMED COORDINATES. Sixty lines of verifier arrived in round 5 with no probe
    #      at all — live but unwitnessed, which by TEST-P21's own standard means its silence
    #      means nothing. These are the exact rows a blind audit used.
    for label, mutation, msg in [
        ("a negative offset (python slicing CLAMPS)", {"byte_offset": -5}, "bytes long"),
        ("a zero-length span (hashes to the digest of NOTHING, so it vouches for anything)",
         {"byte_len": 0}, "bytes long"),
        ("a string coordinate (a bare TypeError, not a refusal)", {"byte_offset": "0"},
         "non-integer"),
        ("a bool coordinate", {"byte_len": True}, "non-integer"),
    ]:
        row = dict(good)
        row.update(mutation)
        artefact(pins=[row])
        with _pytest.raises(env_pins.EnvPinsError, match=msg):
            env_pins.pins("envx", env_root=root)

    # (f5) A FIELD SPAN OUTSIDE THE ROW'S OWN LINE. Spans are absolute file offsets, so
    #      without containment a row can be assembled from bytes scattered anywhere — a
    #      blind audit deleted a pin, rebased the later rows, and aimed the deleted row's
    #      name and version at a PROSE line. It verified.
    row = dict(good)
    row["version_span"] = [0, 3]          # inside the header comment, outside the pin line
    artefact(pins=[row])
    with _pytest.raises(env_pins.EnvPinsError, match="outside"):
        env_pins.pins("envx", env_root=root)

    # (f6) ADJACENCY — the property the substring search had and coordinates lost. A field
    #      may be contained in the row's line and still sit in its COMMENT half; the audit
    #      aimed `version_span` at a version-looking string in a comment and `version_of`
    #      returned the wrong version for the shipped python recipe.
    adj = b"# txr:ecosystem=python\nalpha==1.0  # import=alpha, was 9.9\n"
    (root / "envx" / "requirements.txt").write_bytes(adj)
    off2 = adj.index(b"alpha==1.0")
    write_ok = {
        "name": "alpha", "raw_name": "alpha", "version": "9.9", "import": "alpha",
        "line": 2, "byte_offset": off2, "byte_len": len(adj) - off2 - 1,
        "line_sha256": hashlib.sha256(adj[off2:-1]).hexdigest(),
        "raw_name_span": [off2, 5],
        "version_span": [adj.index(b"9.9"), 3],       # in the COMMENT half — contained!
        "import_span": [adj.index(b"import=") + 7, 5],
    }
    artefact(sha=hashlib.sha256(adj).hexdigest(), pins=[write_ok])
    with _pytest.raises(env_pins.EnvPinsError, match="either side of an `==`"):
        env_pins.pins("envx", env_root=root)
    (root / "envx" / "requirements.txt").write_bytes(pin_bytes)

    # (f7) A VACUOUS pin list. `"pins": []` and `"pins": {}` both verified before — no rows,
    #      nothing checked — and the generator refuses a zero-pin recipe, so reaching this
    #      state means a hand edit, which is the threat model.
    for empty in ([], {}):
        artefact(pins=empty)
        with _pytest.raises(env_pins.EnvPinsError, match="no pins"):
            env_pins.pins("envx", env_root=root)

    # (g) A MISSING FIELD is a refusal naming the field, not a bare KeyError that reads
    #     like a harness bug.
    raw = artefact()
    del raw["recipes"]["envx"]["ecosystem"]
    (root / env_pins.ARTEFACT_NAME).write_text(json.dumps(raw))
    with _pytest.raises(env_pins.EnvPinsError, match="no `ecosystem` field"):
        env_pins.ecosystem("envx", env_root=root)


def test_the_readers_refusals_are_all_EnvPinsError(tmp_path):
    """TEST-P14, the refusals a blind audit found uncovered.

    Deleting the `root.is_dir()` guard left the whole `_lib` suite green — new surface with
    no test, added in a round whose subject was hollow tests. The module's contract is
    "every function here raises `EnvPinsError`", and a bare `FileNotFoundError` reads like a
    harness bug rather than a diagnosis.
    """
    import json
    import hashlib

    import env_pins
    import pytest as _pytest

    # (a) a MISSING recipe tree.
    with _pytest.raises(env_pins.EnvPinsError, match="does not exist"):
        env_pins.assert_fresh({"recipes": {}}, tmp_path / "nope")

    # (b) NON-UTF-8 pin-file bytes are no longer this reader's problem, and that is a
    #     PROPERTY of the coordinate scheme rather than a gap.
    #
    #     The previous version decoded the file to search it, so it needed a
    #     UnicodeDecodeError arm. Index-and-hash never decodes: it slices bytes and digests
    #     them. A non-UTF-8 pin file therefore verifies here exactly as any other would —
    #     and it is REFUSED where it should be, by the gate, whose `generate_env_pin_artefact`
    #     rejects non-UTF-8 outright so no artefact for such a file can exist. Asserted
    #     rather than assumed, because "the other stage checks it" is the reasoning this
    #     branch has rejected twice.
    root = tmp_path / "env-rootfs"
    (root / "envx").mkdir(parents=True)
    (root / "envx" / "Dockerfile").write_text("FROM scratch\n")
    header = b"# txr:ecosystem=python\n"
    pin_line = b"alpha==1.0  # import=alpha"
    raw_bytes = header + pin_line + b"\n\xff\n"
    (root / "envx" / "requirements.txt").write_bytes(raw_bytes)
    off = len(header)
    (root / env_pins.ARTEFACT_NAME).write_text(
        json.dumps(
            {
                "schema_version": env_pins.SCHEMA_VERSION,
                "recipes": {
                    "envx": {
                        "ecosystem": "python",
                        "pin_file_sha256": hashlib.sha256(raw_bytes).hexdigest(),
                        "pin_sources": [],
                        "pins": [
                            {
                                "name": "alpha",
                                "raw_name": "alpha",
                                "version": "1.0",
                                "import": "alpha",
                                "line": 2,
                                "byte_offset": off,
                                "byte_len": len(pin_line),
                                "line_sha256": hashlib.sha256(pin_line).hexdigest(),
                                "raw_name_span": [off + pin_line.index(b"alpha"), 5],
                                "version_span": [off + pin_line.index(b"1.0"), 3],
                                "import_span": [
                                    off + pin_line.index(b"import=") + len("import="),
                                    5,
                                ],
                            }
                        ],
                    }
                },
            }
        )
    )
    assert env_pins.version_of("alpha", "envx", env_root=root) == "1.0", (
        "index-and-hash must be indifferent to bytes elsewhere in the file that are not "
        "valid UTF-8 — it never decodes"
    )

    # (c) `require_version_of` REFUSES rather than returning None, and names what IS pinned.
    assert env_pins.require_version_of("alpha", "envx", env_root=root) == "1.0"  # control
    with _pytest.raises(env_pins.EnvPinsError, match="does not pin"):
        env_pins.require_version_of("Alpha-Typo", "envx", env_root=root)
