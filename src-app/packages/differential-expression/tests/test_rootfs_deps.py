#!/usr/bin/env python3
# ruff: noqa
"""The env-recipe gates (#80).

TEST-5/TEST-17 [covers: ITEM-2/3/4/20], plus #196/TEST-12.

## What changed here, and why it matters

This file used to name THREE distributions in a hardcoded tuple and assert each appeared
in the Dockerfile's install list and smoke-import line. That caught the case it was
written for and nothing else: every later addition had to be remembered into the tuple,
and an addition nobody remembered was exactly the failure the test exists to prevent —
"an install the smoke line does not verify silently ships absent".

The subject set is now READ FROM THE PIN FILE. Every distribution the recipe installs is
checked, so the invariant holds for additions nobody has made yet, which is the only way
an invariant like this survives.

## #196 — the WHOLE-TREE claim moved out of this package

The `pin ⇄ build-time smoke import` correspondence was the same failure ONE RING OUT.
It is a property of EVERY env recipe, but it was asserted here about a single hardcoded
`env-rootfs/single-cell`, from inside one analysis package's test directory. So a second
recipe's pins would have been entirely unguarded the day it landed — the
enumerate-instead-of-derive failure `docs/design/derived-guards.md` §1 describes — and a
claim about the shared environment was hostage to this package's lifecycle.

That claim now lives in
`src-app/server/src/modules/sandbox/env_image.rs::every_env_recipe_smoke_verifies_every_pinned_import`,
beside `every_env_dockerfile_installs_jq`, iterating `rootfs::version::discover_env_recipes`
so it covers every recipe with no edit — and it is language-agnostic, keyed on each pin's
own `# import=` token, because a second recipe need not load with the python idiom.
**Do not re-add a whole-tree assertion here.**

What remains below is deliberately NARROWER: the FROZEN anchors that are true of THIS
recipe specifically — #80's named minimum pin set, this recipe's install-from-pin-file
shape, its freeze-before-trim ordering, its schema arg, its runbook pointer. Per
`derived-guards.md` §4 those are enumerated *cases* over the subject, not an enumeration
of the SET, and adding a recipe does not invalidate them. They are pinned to a named
recipe on purpose, and `test_the_frozen_subject_recipe_exists` makes that pin
FAIL-CLOSED: if the named recipe is renamed or removed, this file goes red rather than
silently asserting nothing.
"""
from pathlib import Path

import pytest

import env_pins
import pin_file_canon

_ENV_ROOT = Path(__file__).resolve().parents[3] / "env-rootfs"
# The FROZEN subject of the recipe-specific anchors below — see the module docstring.
# This is not a derived set and is not meant to be one; the derived, all-recipes guard
# lives in `env_image.rs`. Its existence is asserted (fail-closed) rather than assumed.
_ENV = _ENV_ROOT / "single-cell"
_DOCKERFILE = _ENV / "Dockerfile"
_PINS = _ENV / "requirements.txt"
_RUNBOOK = Path(__file__).resolve().parents[4] / "docs" / "runbooks" / "env-image-republish.md"


def test_the_frozen_subject_recipe_exists():
    """#196/TEST-12 — the anchors below are pinned to a NAMED recipe, so its absence must
    be RED here rather than a silent skip.

    `derived-guards.md` §3: "A skip is a skip, never a pass: a guard that quietly no-ops is
    the vacuous-green failure in a different costume." Every other test in this file reads
    `_DOCKERFILE`/`_PINS`; without this one, a renamed recipe would surface as a confusing
    `FileNotFoundError` in each of them rather than one line saying what actually happened.
    """
    pin_file_canon.assert_canonical(_PINS)
    assert _ENV.is_dir(), (
        f"the frozen subject recipe {_ENV.name} is gone from {_ENV_ROOT}. The anchors in "
        "this file are scoped to it BY NAME on purpose (the all-recipes guard is "
        "env_image.rs::every_env_recipe_smoke_verifies_every_pinned_import). Re-point them "
        "at the recipe that now carries #80's named minimum pin set."
    )
    assert _DOCKERFILE.is_file(), f"{_DOCKERFILE} is missing"
    assert _PINS.is_file(), f"{_PINS} is missing"


def _pins():
    """`[(distribution, version, import_module)]` — the BUILD GATE'S OWN PARSE (#214).

    ## This function used to be a parser, and that was the defect

    It read the pin file with `read_text().splitlines()`, split comments on `partition("#")`
    and tokens on `split("==")`. So did the Rust build gate, the smoke-correspondence guard,
    the R installer and six other programs — ten grammars over one text file, in three
    languages, with nothing holding them together. Every exploitable defect found across
    four audit rounds was a disagreement between two of them.

    The one that ended the approach: a single `U+001C` before a real pin. `str.splitlines()`
    breaks a line on it and `str.isspace()` is true for it, while Rust's
    `char::is_whitespace()` is FALSE — so the gate and the installer read a COMMENT (the
    package absent, never installed) while THIS function counted it, and the whole suite
    stayed green including the frozen count floor.

    There is now one parse, in the gate, exported as data. This reads the data. It cannot
    disagree with the gate about how many pins there are or what they are called, because it
    is not answering the question — it is reading the gate's answer.

    `env_pins.load()` refuses a stale artefact by digesting the pin file's bytes, so this
    is not trading a parser for a trust assumption: `just check-py` never runs cargo, and
    without that check a pin file edited without a regen would leave this green.
    See `docs/design/pin-file-single-parse.md`.
    """
    return [
        (p["raw_name"], p["version"], p["import"])
        for p in env_pins.pins(_ENV.name, env_root=_ENV_ROOT)
    ]


def test_pin_file_is_exact_pins_with_import_names():
    """TEST-3's python twin: the pin file is a total function from distribution to
    version, and every line says which module proves it imports."""
    pins = _pins()
    assert len(pins) >= 20, f"only {len(pins)} pin(s) — the checks below would be thin"
    names = [p[0] for p in pins]
    assert len(names) == len(set(names)), "a distribution is pinned twice"


def test_this_recipe_installs_from_the_pin_file():
    """The INSTALL half, scoped to this recipe (#196).

    Structural rather than per-distribution: the recipe installs `-r requirements.txt`, so
    a pinned line IS installed by construction. What matters is that the recipe installs
    FROM the file — an inline token list would not be addressable by the build gate, by
    the pin parser, or by the all-recipes smoke guard.

    The other half — "…and every pinned distribution is VERIFIED by a build-time load" —
    deliberately does NOT live here any more. It is a property of every recipe, not of
    this one, and asserting it here left a second recipe unguarded. See the module
    docstring; its home is
    `env_image.rs::every_env_recipe_smoke_verifies_every_pinned_import`, which iterates
    `discover_env_recipes` and fails naming the recipe AND the pin.
    """
    text = _DOCKERFILE.read_text()
    assert "uv pip install --no-cache -r" in text, (
        "the recipe must install FROM the pin file — an inline token list is not "
        "addressable by the build gate or by this test"
    )
    assert "requirements.txt" in text


def test_recipe_freezes_the_full_closure_before_the_trim():
    """TEST-5 [covers: ITEM-3] — the image bakes the resolved closure, and does it BEFORE
    the trim layer.

    Ordering is the real assertion. The trim uninstalls pip/setuptools/wheel and strips
    package metadata; a freeze that ran after it could silently produce an empty file, and
    an empty lock records nothing while looking exactly like a lock.
    """
    lines = _DOCKERFILE.read_text().splitlines()
    freeze_at = next((i for i, l in enumerate(lines) if "pip freeze" in l), None)
    trim_at = next((i for i, l in enumerate(lines) if "pip uninstall" in l), None)
    assert freeze_at is not None, "the recipe does not freeze the resolved closure"
    assert trim_at is not None, "the trim layer moved; re-check this ordering assertion"
    assert freeze_at < trim_at, (
        "the closure freeze must run BEFORE the trim that uninstalls pip/setuptools"
    )
    assert "/opt/venv/.cyto-env-lock.txt" in _DOCKERFILE.read_text()


def test_schema_version_not_bumped_for_a_package_change():
    """The recipe's schema marker stays at the version the runtime resolves.

    A package addition is not a layout change, and bumping re-points every deployment at
    a tag that does not exist until someone publishes under it — which, with the publish
    workflow disabled, is however long it takes a human to notice.
    """
    version_rs = (Path(__file__).resolve().parents[3] / "server" / "src" / "modules"
                  / "rootfs" / "version.rs").read_text()
    declared = [l for l in version_rs.splitlines() if "const ROOTFS_SCHEMA_VERSION" in l]
    assert declared, "cannot find ROOTFS_SCHEMA_VERSION"
    n = declared[0].rsplit("=", 1)[1].strip().rstrip(";")
    assert f"ARG ROOTFS_SCHEMA_VERSION={n}" in _DOCKERFILE.read_text(), (
        "the recipe's default schema arg must agree with the runtime constant"
    )


def test_pin_file_and_runbook_document_the_upgrade_procedure():
    """TEST-17 [covers: ITEM-20] — the pins cannot be moved by someone who never finds the
    procedure: the pin file points at the runbook, and the runbook has the section."""
    assert "docs/runbooks/env-image-republish.md" in _PINS.read_text(), (
        "the pin file must point at the upgrade procedure"
    )
    runbook = _RUNBOOK.read_text()
    for required in ("Upgrading a pin", "Republishing the image", "re-enable trigger"):
        assert required in runbook, f"the runbook is missing its `{required}` section"


@pytest.mark.parametrize("named", ["scanpy", "scikit-learn", "numpy", "scipy"])
def test_the_minimum_pin_set_the_issue_names_is_exactly_pinned(named):
    """The four distributions #80 names as the floor are present and EXACTLY pinned.

    Expressed as a separate test from the general one because this is the specific claim
    the issue makes; a regression that returned any of these to a bare name would
    otherwise only show up as a slightly shorter pin file.
    """
    pins = {d: v for d, v, _ in _pins()}
    assert named in pins, f"`{named}` is not pinned — #80 names it as the minimum set"
    assert pins[named][0].isdigit(), f"`{named}` must be pinned to a concrete version"


# ─────────────────────────────── #214 ───────────────────────────────────────────────


def test_this_guard_reads_the_exported_parse_and_not_the_pin_file(monkeypatch):
    """TEST-P11 — this module has STOPPED PARSING, proved behaviourally.

    "It now calls the reader" is not "it stopped parsing": a residual read could sit
    anywhere. Round 4 of #192 found a parser whose own comment claimed it mirrored the
    build gate, and a comment cannot be checked.

    So this asks `_pins()` a question only a data-consumer can answer correctly. The
    exported parse is replaced with a sentinel the pin file does not contain and could not
    produce. A consumer of the artefact returns the sentinel; a residual parser returns the
    real pins off disk. There is no way to pass this while still parsing, and no way to fail
    it while not parsing — it is the executable form of "grep for the residual read".
    """
    sentinel = [
        {
            "name": "sentinel-pkg",
            "raw_name": "Sentinel.Pkg",
            "version": "9.9.9",
            "import": "sentinel_pkg",
            "line": 1,
        }
    ]
    monkeypatch.setattr(env_pins, "pins", lambda *a, **k: sentinel)
    assert _pins() == [("Sentinel.Pkg", "9.9.9", "sentinel_pkg")], (
        "`_pins()` did not follow the exported parse — a residual read of "
        "requirements.txt survives in this module, which is exactly what #214 removes"
    )


def test_the_control_for_the_residual_read_detector():
    """TEST-P11's control. Without it, the test above passes just as well against a
    `_pins()` that raises, returns `[]`, or was deleted — "it followed the sentinel" only
    means something if the unpatched function returns the real thing."""
    real = _pins()
    assert len(real) >= 20, f"only {len(real)} pin(s) read from the exported parse"
    assert all(v and v[0].isdigit() for _n, v, _m in real), "every pin has a real version"
    assert all(m for _n, _v, m in real), "every pin carries its import module"


def test_this_module_has_no_pin_file_grammar_left():
    """TEST-P11, the static half — checked over the AST, never over the text.

    The behavioural sentinel above proves `_pins()` follows the artefact. This proves no
    OTHER function in the module quietly grew a grammar back, which the sentinel cannot see.

    Over the AST, because the module's own prose explains `str.splitlines()` at length and a
    grep is defeated by exactly that (`docs/design/derived-guards.md` §1, and #192's FB-2 —
    "two text predicates, both defeated by prose containing the token they searched for").

    ## Why the ban is UNCONDITIONAL rather than receiver-scoped

    The first cut only flagged a splitter whose receiver expression mentioned `_PINS`, so
    the single chained form `_PINS.read_text().splitlines()` was caught and
    `raw = _PINS.read_text(); raw.splitlines()` was not — one local variable defeated it. A
    blind audit demonstrated that. Receiver-tracking needs dataflow; banning the methods
    outright needs nothing, and this module has no legitimate use for them (the Dockerfile
    reads that DO split live in the sibling R module, not here). `_lib/test_deps.py` got
    this right first; this is that pattern.
    """
    import ast

    #: Functions permitted to split text, BY NAME, each because its subject is a DIFFERENT
    #: file. The exemption is not a loophole: every exempted function is additionally
    #: asserted below never to name the pin file, so "exempt" cannot become "exempt and also
    #: reading the thing this check exists for".
    #:
    #: An unconditional ban was tried first (it is what `_lib/test_deps.py` uses, correctly,
    #: because that module has no other subject) and it fired on these three — a guard that
    #: is red on correct code teaches people to delete guards.
    EXEMPT = {
        "test_recipe_freezes_the_full_closure_before_the_trim",  # splits the DOCKERFILE
        "test_schema_version_not_bumped_for_a_package_change",  # splits rootfs/version.rs
    }
    # (Two entries. An earlier cut had a third that split nothing; the NEEDED check below
    # now refuses that, and the comment below says "these two" rather than "these three".)
    BANNED = {"splitlines", "partition", "rpartition", "split", "rsplit"}
    #: `re.*` and a bare `open()` are grammars too, and a blind audit demonstrated that a
    #: method-name ban reaches NEITHER: `re.findall(r"^...==(\S+)", _PINS.read_text(), re.M)`
    #: is the historical shape of this exact defect (the census records
    #: `spatial-import-visium` as "WAS a `re.M` parser"), and `with open(_PINS) as fh: for
    #: line in fh` needs no method call at all — iterating a file object IS a line rule.
    BANNED_CALLS = {
        "findall", "search", "match", "finditer", "fullmatch", "compile",
        "open", "readlines", "readline", "getattr", "glob", "iglob",
    }
    #: `readlines`/`readline` are file-object line rules with no `.split` in sight;
    #: `getattr` is indirect dispatch, which defeats any name-based ban by construction.
    #: Both were smuggled past the previous cut by a blind audit.
    #:
    #: **The honest limit, stated because a fifth predicate is not the answer.** A ban over
    #: names has unbounded evasion space: `getattr(m, "spl" + "it")`, a helper in another
    #: module, `exec`. This is a TRIPWIRE for the accidental reintroduction of a grammar —
    #: which is how all ten of the original parsers actually arrived — not a barrier against
    #: an author who wants one. The barrier is the behavioural residual-read detector next
    #: door, which does not care how the read is spelled because it asks what the consumer
    #: ANSWERS. `docs/design/pin-file-single-parse.md` §5 and the lifecycle's GUARD-SUB rule
    #: both say the same thing: when a predicate keeps being defeated, replace it with a
    #: test of the behaviour it stands in for.

    src = Path(__file__).read_text(encoding="utf-8")
    tree = ast.parse(src)

    def splitters(node):
        out = []
        for c in ast.walk(node):
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute):
                if c.func.attr in BANNED:
                    out.append((c.lineno, f".{c.func.attr}()"))
                elif c.func.attr in BANNED_CALLS:
                    # No `getattr` here — `getattr` is itself in BANNED_CALLS, so using it
                    # would make this function flag ITSELF. An explicit isinstance is the
                    # same thing without the self-reference.
                    recv = c.func.value.id if isinstance(c.func.value, ast.Name) else "?"
                    out.append((c.lineno, f"{recv}.{c.func.attr}()"))
            elif isinstance(c, ast.Call) and isinstance(c.func, ast.Name):
                if c.func.id in BANNED_CALLS:
                    out.append((c.lineno, f"{c.func.id}()"))
            # NO `for-over-<name>` RULE. The first cut flagged every `for x in <bare name>:`
            # loop, so an ordinary `for pin in pins:` in any non-exempt function would have
            # made this module RED with "a text-splitting call is back" — not a call and not
            # a split. It was green only because the module happens to contain no such loop.
            # A guard that is red on correct code is one people learn to delete, which is
            # the pathology this same function's comment names. The shape it was reaching
            # for (`with open(f) as fh: for line in fh`) is already caught by the `open()`
            # ban above, which is where it belongs.
        return out

    #: Every module-level name that RESOLVES to a pin file or its directory. `_ENV_ROOT` was
    #: missing from the first cut, and one identifier defeated the exemption guard: an
    #: exempted function could compose `_ENV_ROOT / "single-cell" / "requirements.txt"` and
    #: split it, which is precisely "exempt and also reading the thing this check is for".
    PIN_NAMES = {"_PINS", "_R_PINS", "_ENV", "_ENV_ROOT"}

    def names_the_pin_file(node):
        return any(
            (isinstance(c, ast.Name) and c.id in PIN_NAMES)
            or (isinstance(c, ast.Constant) and c.value == "requirements.txt")
            for c in ast.walk(node)
        )

    offences = []
    seen_exempt = set()
    needed_exempt = {}
    for fn in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]:
        hits = splitters(fn)
        if fn.name in EXEMPT:
            seen_exempt.add(fn.name)
            needed_exempt[fn.name] = bool(hits)
            # THE EXEMPTION'S OWN GUARD: an exempted function may not touch the pin file.
            assert not names_the_pin_file(fn), (
                f"`{fn.name}` is exempt from the splitter ban because its subject is a "
                "different file, but it now names the pin file. Either it grew a pin-file "
                "grammar, or the exemption is wrong — both need looking at, neither is a "
                "reason to widen the exemption."
            )
            continue
        offences += [f"{fn.name}:{ln} {m}" for ln, m in hits]

    # Module-level code is checked too (a grammar could sit outside any function).
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            offences += [f"<module>:{ln} {m}" for ln, m in splitters(node)]

    assert not offences, (
        f"a text-splitting or pattern-matching construct is back in this module: {offences}. It must read the build "
        "gate's exported parse (`_lib/env_pins.py`), not tokenize anything — "
        "docs/design/pin-file-single-parse.md. If the subject is genuinely a DIFFERENT file, "
        "add the function to EXEMPT above, which will then require it never to name the pin "
        "file."
    )

    # THE EXEMPTION LIST MUST NOT ROT: every name in it still exists. A stale exemption is
    # an exemption that outlives the change it was written for, which is what
    # `derived-guards.md` §5 refuses.
    assert seen_exempt == EXEMPT, (
        f"EXEMPT names functions that no longer exist: {sorted(EXEMPT - seen_exempt)}"
    )
    # …and every exemption must still be NEEDED. Checking only that the name exists let a
    # third entry sit here that split nothing at all, with this very assertion certifying it
    # as fresh — a stale exemption outliving the change it was written for, which is what
    # `derived-guards.md` §5 refuses. Found by a blind audit counting the hits.
    unneeded = sorted(n for n in EXEMPT if not needed_exempt.get(n))
    assert not unneeded, (
        f"these exemptions are no longer needed — the functions split nothing: {unneeded}. "
        "Remove them. An exemption that is not doing any work is one nobody will re-examine "
        "when it starts to."
    )

    # POSITIVE CONTROL — the predicate can FIRE. Without this, `offences == []` is equally
    # consistent with "the walk is broken", which is the failure mode the first cut had in a
    # different costume. Both the CHAINED form and the two-statement form via a local
    # variable are probed: a blind audit defeated a receiver-scoped version of this check
    # with exactly the second one.
    probe = ast.parse(
        "def a():\n"
        "    for line in _PINS.read_text().splitlines():\n"
        "        pass\n"
        "def b():\n"
        "    text = _PINS.read_text()\n"
        "    return text.splitlines()\n"
        "def c():\n"
        "    return re.findall(r'x', _PINS.read_text(), re.M)\n"
        "def d():\n"
        "    with open(_PINS) as fh:\n"
        "        for line in fh:\n"
        "            pass\n"
    )
    probe_by_fn = {
        fn.name: splitters(fn)
        for fn in ast.walk(probe)
        if isinstance(fn, ast.FunctionDef)
    }
    unflagged = sorted(n for n, hits in probe_by_fn.items() if not hits)
    assert not unflagged, (
        f"the predicate did not flag these known-bad shapes: {unflagged}. `a` is the chained "
        "form, `b` the two-statement form via a local, `c` the `re.M` findall (the historical "
        "shape of this exact defect — the census records `spatial-import-visium` as 'WAS a "
        "`re.M` parser'), `d` iterating a file object. Each is a residual pin-file grammar; a "
        "predicate that misses one is a predicate whose silence on this module means nothing."
    )
    # …and it must ACCEPT something legitimate, or "flags everything" would satisfy the line
    # above. A plain read with no split is the case: a split of a different file is
    # deliberately still flagged (the ban is unconditional) and is what EXEMPT is for.
    benign = ast.parse("def e():\n    return _DOCKERFILE.read_text()\n")
    assert not [h for fn in ast.walk(benign) if isinstance(fn, ast.FunctionDef) for h in splitters(fn)], (
        "the predicate flags a plain read with no split — it cannot discriminate"
    )

    # …and it sees this module at all.
    calls = sum(1 for n in ast.walk(tree) if isinstance(n, ast.Call))
    assert calls > 50, f"the AST walk found only {calls} calls — it is not seeing this module"
