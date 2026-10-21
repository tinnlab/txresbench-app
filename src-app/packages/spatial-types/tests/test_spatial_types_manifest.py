#!/usr/bin/env python3
# ruff: noqa
"""The DECLARATION half of #152 — what `spatial-types/manifest.yaml` contributes.

Every assertion here is DERIVED from the tree (the manifests, the shipped consumers, the
Rust guards' own rules) rather than from a hand-written expectation, so a kind or an axis
added tomorrow is covered tomorrow. That is the same reason `check-derived-vocabulary.sh`
exists as the successor to `check-kinds-zero-core.sh`'s hard-coded trio: a list of terms
somebody remembered to type is one edit behind the tree, always.
"""
import json
import re
import subprocess
from pathlib import Path

import yaml

_PACKAGES = Path(__file__).resolve().parents[2]
_REPO = _PACKAGES.parents[1]
_MANIFEST = _PACKAGES / "spatial-types" / "manifest.yaml"

#: The six universal ROOT datatype ids the core defines in `datatype/builtin.rs`. An
#: `extends` target resolves against these ∪ every contributed id (the same two-pass
#: resolution `build_helper::processor_manifest::lint_processor_tree` does).
_ROOT_IDS = {"data", "data/opaque", "tabular", "matrix", "report/html", "file/upload"}

#: The three structures the design permits, as their manifest `layout.kind` spellings.
#: `table` is a columnar or dense Zarr member; `sparse_csc` is `chunked_sparse` with a
#: CSC orientation; `opaque` is `opaque_as_is`. There is no fourth.
_PERMITTED_LAYOUT_KINDS = {
    "chunked_dense", "columnar_table", "chunked_1d", "chunked_sparse", "opaque_as_is",
}


def _load(path):
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def _all_manifests():
    """`{package_name: parsed_manifest}` for every package in the tree."""
    out = {}
    for mf in sorted(_PACKAGES.glob("*/manifest.yaml")):
        out[mf.parent.name] = _load(mf) or {}
    return out


def _datatypes(manifest):
    return list((manifest.get("contributes") or {}).get("datatypes") or [])


def _spatial_types():
    return {t["id"]: t for t in _datatypes(_load(_MANIFEST))}


def _tracked(*pathspecs):
    """Tracked-or-new files matching `pathspecs` (never `--cached` alone: that returns
    nothing for a working-tree rename, the fail-open this repo has hit repeatedly)."""
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", *pathspecs],
        cwd=_REPO, capture_output=True, text=True, check=True,
    )
    return [p for p in out.stdout.splitlines() if p.strip()]


#: The ONE declaration `scripts/check-derived-vocabulary.sh` also reads (#311, #324).
#:
#: Two guards enforce the invariant TEST-1 below asserts: this wholesale, raw-text scan, and
#: that fast dialect-aware one. They derived their SURFACE and their EXEMPTION RULE separately
#: and could therefore disagree — and twice they did, in the two opposite directions
#: `docs/design/derived-guards.md` §1 insists are ONE failure:
#:
#:   * VACUOUSLY GREEN — #303, then #324. A leak the fast guard could not see (a
#:     `scripts/*.mjs`, then `src-app/libs/viz/scripts/`) reached `main` while this test,
#:     which scans everything, carried the red. A guard that cannot see a region is not a
#:     guard for it.
#:   * FALSELY RED — #311 residual 1. A sibling guard that legitimately HUNTS a spatial id
#:     must spell it, declares a `cyto:guard-vocabulary` block to say so, passes the shell
#:     guard — and fails HERE, which granted no exemption at all. Latent today, and latent is
#:     not fixed: §1 says a guard that "starts refusing things it never meant to refuse" is
#:     the same defect as one that stops covering what it names.
#:
#: So the surface rule and the exemption rule live in ONE committed file that BOTH read. That
#: is #311's own prescription and §2's shape. This module reads the exemption from it (below)
#: and asserts CONTAINMENT against it (TEST-24) — it does NOT read its own scan set from it:
#: this test's surface is deliberately WIDER, and narrowing it to the fast guard's would
#: delete the backstop that caught both leaks.
_SURFACE_DECL = _REPO / "scripts" / "lib" / "zero-core-surface.txt"

#: Single-valued declaration fields this module needs. Fail-CLOSED on every one: a
#: declaration that half-reads is this test granting an exemption nobody declared, or
#: scanning a surface nobody meant.
_DECL_SINGLE = ("surface_dir", "vocab_block_open", "vocab_block_close", "vocab_block_pins")
#: Fields that must carry at least one record.
_DECL_MULTI = ("scan_root", "surface_root", "data_root", "test_path_segment")

#: The charsets. Enforced HERE as well as in the shell guard, and identically, because
#: the values are interpolated into four matcher languages (an awk ERE, a BRE `grep`, a
#: Python `re`, a git pathspec) and a blind audit defeated all four from the declaration
#: alone — `vocab_block_open cyto:guard-vocabulary(` killed awk's lazily-compiled dynamic
#: regex on every build file with its stderr swallowed, and the shell guard printed PASS
#: over a planted leak. A charset with no metacharacter in any of the four needs no
#: escaping in any of them, which is what makes "one declaration, two readers" true of the
#: MATCHING rather than only of the bytes.
_DECL_KIND = {
    "scan_root": "path", "surface_root": "path", "data_root": "path",
    "vocab_block_pins": "path", "surface_exception": "path",
    "surface_dir": "name", "test_path_segment": "name",
    "vocab_block_open": "marker", "vocab_block_close": "marker",
}
_DECL_CHARSET = {
    # No `//`, no trailing `/`, no `..` segment — the same three refusals the shell reader
    # makes, and for the same reason: `data_root src-app/packages/` passes a naive charset,
    # builds a prefix that matches nothing, and silently no-ops the exclusion in BOTH readers.
    #
    # `(?![/.]|$)`, and the `|$` is the whole point. The first cut wrote `(?![/.])`, whose
    # lookahead SUCCEEDS at end-of-string — so `src-app/packages/` was refused by the shell
    # reader and ACCEPTED here, and the control written for that refusal drove only the shell.
    # One declaration with two answers is the exact defect this file exists to remove, and a
    # blind round found it in the round that added the refusal.
    "path": re.compile(r"^[A-Za-z0-9_](?:[A-Za-z0-9_.-]|/(?![/.]|$))*$"),
    "name": re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$"),
    "marker": re.compile(r"^[A-Za-z0-9_][A-Za-z0-9:_-]*$"),
}

#: Fields whose values must NAME SOMETHING git tracks. `derived-guards.md` §3, and the
#: declaration says BOTH readers enforce it — which was a claim rather than a fact until a
#: blind round pointed out this module had no such check at all. A path that resolves to
#: nothing does not narrow a guard by a directory; it removes a region from the scan while
#: the guard reports the same PASS.
#: ONLY the INCLUSION paths. `data_root` is an EXCLUSION — one that names nothing excludes
#: nothing, so the scan gets WIDER rather than narrower, and requiring it to exist pre-empts
#: the more informative "the vocabulary collapsed" failure the floors already give.
_DECL_MUST_EXIST = ("scan_root", "surface_root", "vocab_block_pins")

#: The cap on the SECOND exemption axis. READ from `MAX_TEST_SEGMENTS` in the PINNED
#: scripts/check-derived-vocabulary.sh, not typed here — the first cut held the two equal by
#: hand and nothing checked it, so this module's half could be pre-raised silently (this file
#: is not in scripts/guard-hashes.txt), leaving a later cap raise as ONE pinned diff instead of
#: the two the cap message advertises. §2 applied to a NUMBER: derive it from the declaration
#: that defines it. Measured 3 (`tests`, `testdata`, `fixtures`); `__tests__` was a fourth that
#: matched ZERO tracked files — a capped slot naming nothing is an exemption already paid for.
_FAST_GUARD = _REPO / "scripts" / "check-derived-vocabulary.sh"


def _max_test_segments():
    """`MAX_TEST_SEGMENTS` as the fast guard declares it — one number, one home."""
    text = _FAST_GUARD.read_text(encoding="utf-8")
    found = re.search(r"^MAX_TEST_SEGMENTS=(\d+)", text, re.MULTILINE)
    assert found, (
        f"{_FAST_GUARD} declares no MAX_TEST_SEGMENTS. This module reads the cap from there so "
        "the two cannot drift; a missing constant means the guard was renamed or the cap was "
        "deleted, and either way this module must not invent one."
    )
    return int(found.group(1))


def _declaration():
    """The parsed shared declaration: `{field: [value, ...]}`, first token per record.

    Grammar, byte-identical to the shell reader's: `<field> <value...>`, one record per
    line; a line whose first non-blank character is `#` is a comment and a `#` anywhere
    else is DATA (the exception reasons carry issue numbers). Blank lines are ignored.
    The first whitespace-delimited token of the value is the value; the rest of the line
    is the REASON a reader of the diff sees.
    """
    if not _SURFACE_DECL.exists():
        raise AssertionError(
            f"{_SURFACE_DECL} is missing. It is the ONE declaration this test and "
            "scripts/check-derived-vocabulary.sh both read for the scan roots, the build "
            "surface and the cyto:guard-vocabulary exemption (#311). Restore it rather "
            "than re-typing any of those rules into a guard — two hand-kept copies is the "
            "defect it removes."
        )
    out = {}
    # `read_bytes().decode()`, not `read_text()`. Text mode does UNIVERSAL NEWLINE translation:
    # it turns `\r\n` into `\n` before any of this module's code sees it, so the argument two
    # comments down — "the `\r` stays on the value and the charset refuses it, in both readers"
    # — was defeated one call earlier than the `.split()` it blames. A CRLF declaration parsed
    # clean HERE and failed the shell reader, whose awk keeps the byte. Decoding the raw bytes
    # is what makes the two readers see the same file.
    for raw in _SURFACE_DECL.read_bytes().decode("utf-8").split("\n"):
        # `split("\n")`, not `splitlines()`: the latter eats a trailing `\r`, so a CRLF file
        # parsed clean here and failed the shell reader (whose awk leaves the `\r` on the
        # token). One declaration, two answers, is the thing this file exists to prevent — so
        # the `\r` stays on the value and the charset refuses it, in both readers.
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        # `re.split(r"[ \t]+", ...)` HERE TOO, and the round that fixed the VALUE split left this
        # line alone. `str.split(None, 1)` separates on every Unicode whitespace — `\v`, `\f`,
        # `\x85`, NBSP, `\u2000` — while the shell's awk separates on space and tab only, so a
        # record written with any of those is PARSED here and INVISIBLE there. With NBSP the
        # offending line renders as an ordinary record in `git diff`, so a reviewer sees nothing.
        # One declaration, two answers, at the one place the round did not look.
        parts = re.split(r"[ \t]+", raw.strip(" \t"), maxsplit=1)
        if len(parts) != 2 or not parts[1].strip():
            raise AssertionError(
                f"{_SURFACE_DECL}: unparseable record {raw!r}. Every record is "
                "`<field> <value...>`; a field with no value would read as an empty rule, "
                "which is this test scanning less while reporting green."
            )
        # `re.split(r"[ \t]+", ...)`, not `.split()`. The comment above argues for `split("\n")`
        # so that a trailing `\r` reaches the charset and is refused "in both readers" — and
        # then `str.split()` treated the `\r` as whitespace and ate it, so a CRLF declaration
        # parsed clean HERE and failed the shell reader, whose awk keeps it. The claim was in
        # the file and the behaviour was not, which is the shape a blind round keeps finding.
        # Splitting on SPACE AND TAB ONLY leaves every other whitespace byte on the value where
        # the charset can refuse it.
        out.setdefault(parts[0], []).append(re.split(r"[ \t]+", parts[1].lstrip(" \t"))[0])
    for field in _DECL_SINGLE:
        got = out.get(field, [])
        if len(got) != 1:
            raise AssertionError(
                f"{_SURFACE_DECL} declares `{field}` {len(got)} time(s); exactly one is "
                "required. Zero means this test falls back to nothing; more than one means "
                "its two readers could pick different ones, which is the drift the shared "
                "declaration exists to remove (#311)."
            )
    for field in _DECL_MULTI:
        if not out.get(field):
            raise AssertionError(
                f"{_SURFACE_DECL} declares no `{field}`. Every one of these is "
                "load-bearing; an absent one is a silently different guard."
            )
    for field, values in out.items():
        kind = _DECL_KIND.get(field)
        if kind is None:
            continue
        for value in values:
            if not _DECL_CHARSET[kind].match(value) or ".." in value.split("/"):
                raise AssertionError(
                    f"{_SURFACE_DECL} declares `{field} {value}`, which is not a plain "
                    f"{kind} token. Every value here is interpolated into an awk regex, a "
                    "grep pattern, a Python regex and a git pathspec; a value carrying a "
                    "metacharacter means something different in each, and a blind audit "
                    "turned exactly that into a silent PASS over a planted leak."
                )
    # A `surface_root` at or under a `data_root` is a contradiction, and the dangerous kind:
    # it passes the charset, it passes the existence check, and then the data-root exclusion
    # removes everything it contributed — a declared surface that contributes nothing, which
    # from the outside is indistinguishable from one that works. §3's "a marker naming
    # nothing", one field over from where this declaration already closed it.
    for root in out.get("surface_root", []):
        for data in out.get("data_root", []):
            if root == data or root.startswith(data + "/"):
                raise AssertionError(
                    f"{_SURFACE_DECL} declares `surface_root {root}`, which is at or under "
                    f"`data_root {data}`. The exclusion then removes everything that root "
                    "contributes, so it is a surface that scans nothing while every guard "
                    "reports the same PASS. One of the two records is wrong; both cannot be."
                )
    # THE THIRD EXEMPTION AXIS, and the one both readers applied to BOTH sets — so it was the
    # one this test could not catch. A blind round appended `data_root src-app/libs` to the
    # declaration with a leak planted under src-app/libs/viz/scripts/ and got a PASS out of the
    # fast guard AND out of this module, containment assertion included, because the scan set
    # and the modelled build surface shrink together. A `data_root` is not an opinion about
    # what to skip: it is a statement about where the CONTRIBUTED PACKAGES are, and a directory
    # is a package because it holds a `manifest.yaml`. So it is DERIVED-CHECKED rather than
    # trusted, in both readers, and `src-app/libs` — which holds no manifest — is refused.
    # A `data_root` MUST BE AT OR UNDER the package directory, and this replaces a rule with a
    # one-line bypass. The first cut asked whether the directory held a `<pkg>/manifest.yaml` —
    # a statement about FILE SHAPE, which a blind round satisfied with a one-line empty manifest:
    # that plus `data_root src-app/libs` dropped a real planted leak out of BOTH guards, both
    # PASS. It also needed a collapsed-tree gate, which was itself uncontrolled. This rule has
    # none of that: the package directory is where the vocabulary is READ from, the data roots
    # are the region it lives in, and pinning the two declarations to each other needs no file
    # shape, no gate, and nothing a planted file can satisfy.
    _pkg_rel = str(_PACKAGES.relative_to(_REPO))
    for root in out.get("data_root", []):
        if not _under(_pkg_rel, root) and not _under(root, _pkg_rel):
            raise AssertionError(
                f"{_SURFACE_DECL} declares `data_root {root}`, which is not at or under "
                f"`{_pkg_rel}` — where this module reads the contributed vocabulary from. A "
                "root outside it removes ordinary source from BOTH guards at once, and an "
                "earlier rule that asked only whether the directory held something SHAPED like "
                "a package manifest was bought with a one-line empty file."
            )
    if not any(_under(str(_PACKAGES.relative_to(_REPO)), r) for r in out.get("data_root", [])):
        raise AssertionError(
            f"{_SURFACE_DECL} declares no `data_root` covering {_PACKAGES.relative_to(_REPO)}, "
            "which is where this module reads the contributed packages from. One spelling of "
            "one set: while the two disagree, this test scans a package tree as if it were app "
            "core, or excludes app core as if it were a package."
        )
    # A `surface_exception` naming nothing is a DEAD EXEMPTION — §3's marker switched off — and
    # the shell guard has refused it ungated since #311. This module did not check it at all,
    # which made the design record's "enforced ungated, IN BOTH READERS" a claim rather than a
    # fact, and left this module's model of the fast guard's surface wrong in exactly the
    # direction that makes the containment assertion pass for the wrong reason.
    for field in _DECL_MUST_EXIST:
        for value in out.get(field, []):
            if not _tracked(value):
                raise AssertionError(
                    f"{_SURFACE_DECL} declares `{field} {value}`, and git tracks nothing "
                    "there. A declared path that names nothing removes a region from the scan "
                    "while every guard reports the same PASS — which is how a leak in that "
                    "region reaches main. Re-point it, or delete the record if the region is "
                    "genuinely gone."
                )
    # …and it is the SAME rule the shell enforces, not a weaker one. The first cut asked only
    # "is this tracked", while the shell requires the path to be at or under a file the
    # `surface_dir` WALK reaches inside the scan roots — so `docs/design/derived-guards.md` was
    # a legal exception here and a hard failure there. §7.1.4's own table writes the bound as
    # "names a real path THE WALK REACHES"; a blind round showed only one reader implemented it.
    _dir = out["surface_dir"][0]
    _walk = {
        rel for rel in _tracked(*out["scan_root"]) if _dir in Path(rel).parts[:-1]
    }
    for value in out.get("surface_exception", []):
        if not any(_under(rel, value) for rel in _walk):
            raise AssertionError(
                f"{_SURFACE_DECL} declares `surface_exception {value}`, and no tracked file at "
                f"or under it sits in a `{_dir}/` directory inside the scan roots. An exception "
                "the walk never reaches narrows no guard — it is an entry nobody can check, "
                "sitting where a real one would be."
            )
    # THE SEGMENT RULES RUN LAST, AFTER THE SCAN ROOTS ARE KNOWN TO EXIST, because they READ
    # those roots. The first cut ran them first, so a typo'd `scan_root` produced "no tracked
    # file sits on such a path" — blaming the segment for a root that was not there, while the
    # shell reader (whose existence loop is 800 lines earlier) named the root correctly. That is
    # the gating mistake this same round documented and fixed for `data_root`, one field over.
    # The SECOND exemption axis, priced identically in both readers. The cap is a number in a
    # pinned guard on the shell side; here it is this constant, and the two must move together
    # or the two readers disagree about what an exemption costs — which is the same defect one
    # field over from where the declaration already removed it.
    segments = out.get("test_path_segment", [])
    _cap = _max_test_segments()
    if len(segments) > _cap:
        raise AssertionError(
            f"{_SURFACE_DECL} declares {len(segments)} `test_path_segment` record(s); the cap "
            f"is {_cap}. A path segment is an exemption with the same reach as a "
            "`surface_exception`; raising the cap is a deliberate edit to check-derived-"
            "vocabulary.sh AND to this module, in the same commit as the record."
        )
    # …and a declared segment must CLASSIFY SOMETHING. A capped slot naming nothing is a
    # pre-paid exemption: the cap prices ADDING a segment, so an inert member is a slot a later
    # commit spends on any directory it likes with the count never moving. `__tests__` was
    # exactly that, and a blind round spent it on a directory holding a planted leak.
    for seg in segments:
        if not any(seg in Path(rel).parts[:-1] for rel in _tracked(*out["scan_root"])):
            raise AssertionError(
                f"{_SURFACE_DECL} declares `test_path_segment {seg}`, and no tracked file under "
                "the scan roots sits on such a path. An exemption slot that classifies nothing "
                "is a slot a later commit can spend without the count moving."
            )
    return out


def _pinned_files(decl):
    """The paths pinned in the manifest the declaration names — the FIRST of the exemption's
    two keys. Read from the same manifest `check-guard-integrity.sh` verifies, so an unpinned
    or renamed guard cannot claim the exemption at all."""
    manifest = _REPO / decl["vocab_block_pins"][0]
    if not manifest.exists():
        raise AssertionError(
            f"{manifest} is missing, so there is no structural definition of which files may "
            "DECLARE a vocabulary block. Restore it: scripts/check-guard-integrity.sh --update"
        )
    pinned = set()
    for raw in manifest.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        fields = line.split()
        if len(fields) == 2:
            pinned.add(fields[1])
    assert len(pinned) >= 20, (
        f"only {len(pinned)} pinned path(s) in {manifest} — the reader broke, and a collapsed "
        "pin set would silently REMOVE every exemption rather than grant one. That direction "
        "is safe for the leak scan and wrong for this reader, so it fails here."
    )
    return pinned


def _blank_declared_vocabulary(text, rel, decl, pinned):
    """Blank the lines inside a DECLARED `cyto:guard-vocabulary` block, and ONLY there.

    The exemption #304 gave the shell guard, honoured here on the SAME two committed keys so
    the two guards cannot disagree about a legitimately-spelling guard (#311 residual 1):

      1. the file is PINNED in the manifest the declaration names, and
      2. the block is OPENED and TERMINATED in the file's own bytes.

    Both ways of getting it wrong fail CLOSED — a marker in an unpinned file blanks nothing,
    and an unterminated block blanks nothing rather than the rest of the file, which is the
    whole-file exemption arriving by typo. What bounds the block is the PIN, not a pattern:
    any edit inside it changes the file hash and fails `check-guard-integrity.sh` until a
    human re-pins it in the same commit. `docs/design/derived-guards.md` §7.1 records why
    three attempts at a syntactic bound were each defeated in one line, and why there is no
    predicate here either.

    `re.escape` is belt-and-braces, not the bound: the marker charset above admits no regex
    metacharacter, which is what makes this matcher and the shell guard's unescaped awk one
    agree. Escaping only one side is how they came to disagree in the first cut.
    """
    if rel not in pinned:
        return text
    opener = re.compile(r"^\s*(?:#|//)\s*" + re.escape(decl["vocab_block_open"][0]) + r"(?:\s|$)")
    closer = re.compile(r"^\s*(?:#|//)\s*" + re.escape(decl["vocab_block_close"][0]) + r"(?:\s|$)")
    lines = text.splitlines()
    kept, inside = [], False
    for line in lines:
        if closer.match(line):
            inside = False
            kept.append("")
            continue
        if opener.match(line):
            inside = True
            kept.append("")
            continue
        kept.append("" if inside else line)
    if inside:
        # UNTERMINATED. Blanking to the end of the file is exactly the whole-file exemption
        # #304 removed, reintroduced invisibly by a missing end-marker. Scan the file raw.
        return text
    return "\n".join(kept)


def _under(rel, prefix):
    """`rel` IS `prefix`, or sits under it. Written once because the shell guard matches
    `^p$` or `^p/` and an earlier cut of this module used `str.startswith(p)`, which also
    swallows a sibling `p-legacy/…` — a second rule computed from one declaration, which is
    the thing the declaration exists to prevent."""
    return rel == prefix or rel.startswith(prefix + "/")


def _zero_core_scan_set():
    """TEST-1's surface, as ONE definition TEST-24 also reads, derived from the declaration.

    Byte-for-byte the surface this test has always had — `scan_root` is `src-app`, `scripts`,
    `justfile`; `data_root` is `src-app/packages`; the test segments are the three it already
    used — but READ rather than typed, so it and the fast guard cannot drift. Written once
    rather than twice on purpose: a containment assertion computed from a COPY of the set it
    is about proves the copy, not the set.
    """
    decl = _declaration()
    data_roots = decl["data_root"]
    segments = set(decl["test_path_segment"])
    files = [
        p for p in _tracked(*decl["scan_root"])
        if not any(_under(p, r) for r in data_roots)
        and not any(seg in segments for seg in Path(p).parts[:-1])
    ]
    assert len(files) >= 500, (
        f"only {len(files)} file(s) in the scan set — the derivation collapsed and every "
        "assertion built on it was about to pass having scanned almost nothing."
    )
    return files


def _declared_build_surface(decl):
    """`check-derived-vocabulary.sh`'s BUILD surface, from the declaration it derives it from.

    Mirrors that guard's derivation exactly, and only that part of it: the `surface_root`
    paths, plus every tracked file under a directory named `surface_dir` at any depth WITHIN
    the `scan_root`s, less the `data_root`s and the declared `surface_exception`s. It
    deliberately does NOT model that guard's js-test-module exclusion, which only ever
    REMOVES files — modelling it would make this set smaller, and a containment assertion is
    only worth anything computed over the LARGER candidate set.

    IT ALSO DOES NOT APPLY `test_path_segment`, and that is what makes TEST-24 catch the
    second exemption axis rather than be silenced by it. The fast guard stopped applying the
    segments to its build tier for the reason its own comment gives — build tooling is build
    tooling wherever it sits — after a blind round showed that appending one line,
    `test_path_segment viz`, deleted a whole `scripts/` directory with a planted leak in it
    from BOTH guards and from this containment test, for the price of one re-pin. Modelling
    that filter here would put the silencing straight back: the scan set below drops the
    segment, this set keeps it, and the containment assertion is what notices they disagree.
    A build file that genuinely lives under a `tests/` path therefore reddens TEST-24, which
    is the decision being made out loud instead of a set quietly shrinking.
    """
    directory = decl["surface_dir"][0]
    exceptions = decl.get("surface_exception", [])
    data_roots = decl["data_root"]
    out = set(_tracked(*decl["surface_root"]))
    for rel in _tracked(*decl["scan_root"]):
        if directory in Path(rel).parts[:-1]:
            out.add(rel)
    return {
        rel for rel in out
        if not any(_under(rel, r) for r in data_roots)
        and not any(_under(rel, e) for e in exceptions)
    }


def _boundary(ch):
    """The compound-id token boundary `check-derived-vocabulary.sh` uses: a character
    that is not `[A-Za-z0-9_-]`, or the end of the line. It is what keeps
    `viz-core/spatial/imageTiles` from reading as a hit on `spatial/image`."""
    return ch == "" or not re.match(r"[A-Za-z0-9_-]", ch)


def _bounded_hits(text, term):
    hits = 0
    start = 0
    while True:
        i = text.find(term, start)
        if i < 0:
            return hits
        left = text[i - 1] if i > 0 else ""
        right = text[i + len(term)] if i + len(term) < len(text) else ""
        if _boundary(left) and _boundary(right):
            hits += 1
        start = i + 1


# ── TEST-1 [acceptance] [invariant: INV-1] ───────────────────────────────────────────
def test_a_new_kind_costs_zero_core_code():
    """TEST-1 [acceptance] [invariant: INV-1] — every id this package contributes appears
    NOWHERE in the app-core production surface.

    This is the whole thesis of the leaf: a new kind is DATA. The serve/decode path routes
    on LAYOUT and never on a domain kind, so if adding these kinds had required a core
    edit, the design would have failed and this test would say so.

    The scanned surface is DERIVED, and stated precisely rather than generously: every
    tracked-or-new file under `src-app/`, `scripts/` and `justfile` that is NOT under
    `src-app/packages/` and does not sit on a test/fixture path (a test may legitimately
    name an id; a dispatch cannot be reached from one). `docs/`, `.lifecycle/` and the
    submodules are outside those pathspecs and are therefore not scanned — an exclusion by
    omission, not a subtraction rule. The forbidden terms are DERIVED from the manifest.

    ONE exemption, at the LINE axis, added by #311 and deliberately not wider: a line inside
    a DECLARED `cyto:guard-vocabulary` block in a file PINNED in the manifest
    `scripts/lib/zero-core-surface.txt` names. It exists because a sibling GUARD must SPELL
    the vocabulary it HUNTS (`check-kinds-zero-core.sh`'s `KINDS=`,
    `check-no-legacy-wire.sh`'s `DOMAIN_REGEX=`) and `check-derived-vocabulary.sh` has
    honoured exactly this block since #304 — so without it, one guard structurally permits
    what the other structurally forbids, and `docs/design/derived-guards.md` §1 is explicit
    that a guard which "starts refusing things it never meant to refuse" is the SAME defect
    as one that stops covering what it names, not a lesser one.

    It changes nothing in the tree today: neither shipped block spells an id this package
    contributes, so this test's verdict is byte-identical before and after. And it is the
    narrowest thing here by a distance — against it, this test already exempts, with no
    declaration anywhere, all of `src-app/packages/`, every `tests`/`testdata`/`fixtures`
    path segment, and everything outside its three pathspecs. What it is NOT is
    a way to quiet a leak: none of the three `src-app/libs/viz` sites that made this test
    RED on `4b702edf` (#324) sits inside a marker pair, and none of those files is pinned.
    `scripts/check-derived-vocabulary.test.mjs` TEST-21 asserts that directly, by planting
    the block and the leak together and requiring BOTH guards to stay red.

    Honest limit: this proves no app-core file NAMES one of these ids. It is a proxy for
    "no change outside the package tree", not a proof of it — a core edit that spells none
    of the ids would pass here. The `git diff --stat` in the branch's lifecycle record is
    the direct statement; this is the part that keeps holding on later branches.
    """
    terms = sorted(_spatial_types())
    assert len(terms) >= 5, f"only {len(terms)} contributed id(s) — the reader broke"

    files = _zero_core_scan_set()   # floored at >= 500 inside the helper

    decl = _declaration()
    pinned = _pinned_files(decl)

    leaks = []
    for rel in files:
        path = _REPO / rel
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except (OSError, UnicodeDecodeError):
            continue
        text = _blank_declared_vocabulary(text, rel, decl, pinned)
        for term in terms:
            if _bounded_hits(text, term):
                leaks.append(f"{rel}: {term}")
    assert not leaks, (
        "a spatial kind id leaked into the app-core surface — a new kind must be DATA:\n"
        + "\n".join(leaks[:20])
    )


# ── TEST-24 ──────────────────────────────────────────────────────────────────────────
def test_the_wholesale_scan_contains_the_fast_guards_build_surface():
    """TEST-24 (#311/#324) — every file `check-derived-vocabulary.sh` scans on its BUILD
    surface is also scanned by TEST-1 above.

    #324's mechanism, stated as a relation rather than as a war story. Two guards enforce one
    invariant, and the SLOW one is the backstop: it scans `src-app`, `scripts` and `justfile`
    wholesale, which is why it has now caught two leaks (#303, #324) the fast one could not
    see. That only works while the fast guard's surface is a SUBSET of this one. Nobody was
    checking, and #324 is what the unchecked direction cost — a region (`**/scripts/`) inside
    this test's surface and outside that guard's, so the fast gate went green and the red
    reached `main` through a suite the merge did not run.

    Containment is asserted, not assumed, and it is asserted from the SAME declaration the
    other guard derives its surface from (`scripts/lib/zero-core-surface.txt`), so the two
    cannot be computed from different rules. It fails LOUDLY the day the fast guard is
    pointed at a region this test cannot see — the `src-app/packages/*/scripts/` shape, say,
    which this test excludes by prefix — which is the direction that leaves a leak with no
    backstop at all.

    What this deliberately does NOT do is read this test's own scan set from the declaration.
    This surface is WIDER on purpose (`src-app/libs/**`, `src-app/ui/**`, every extension),
    and narrowing it to the fast guard's would delete the thing that caught both leaks.
    Superset, checked; not equality, imposed.
    """
    decl = _declaration()
    surface = _declared_build_surface(decl)
    assert len(surface) >= 95, (
        f"the fast guard's declared build surface resolved to {len(surface)} file(s) (measured "
        "119) — the "
        "derivation collapsed, and this containment assertion was about to PASS over almost "
        "nothing. Re-point it at `scripts/lib/zero-core-surface.txt`; do NOT lower this."
    )

    scanned = set(_zero_core_scan_set())
    missing = sorted(surface - scanned)
    assert not missing, (
        "the fast guard scans files this wholesale backstop does not, so a leak in them would "
        "have NO second opinion — which is the relation #324 violated in the other direction:"
        + "\n  " + "\n  ".join(missing[:20])
        + "\n\nEither widen this test's pathspecs to cover them, or narrow "
        f"{_SURFACE_DECL.name}'s surface. Do not simply delete this assertion: it is the only "
        "machine statement that the fast guard cannot outrun its backstop."
    )


# ── TEST-2 ───────────────────────────────────────────────────────────────────────────
def test_the_package_is_pure_data_and_every_extends_resolves():
    """TEST-2 — the manifest is converter-less and run-entry-free, contributes exactly the
    the expected ids, and every `extends` + every `entity_axis` resolves the way the Rust
    build gate resolves them."""
    manifest = _load(_MANIFEST)
    assert manifest["id"] == "spatial-types"
    assert re.match(r"^\d+\.\d+\.\d+$", str(manifest["version"])), (
        "the seed reconciliation key must be a real version — a manifest without one "
        "leaves a provisioned deployment on a stale lattice"
    )
    contributes = manifest["contributes"]
    assert set(contributes) == {"datatypes"}, (
        f"pure DATA: the package contributes only datatypes, got {sorted(contributes)}"
    )

    spatial = _spatial_types()
    assert set(spatial) == {
        "spatial/coordinates", "spatial/image", "spatial/labels", "spatial/boundaries",
        "spatial/visium-bundle",
        # #162 — the second vendor upload container, beside its sibling.
        "spatial/xenium-bundle",
        # TEST-12 / #160 — the third, and the first whose members carry a path segment: HD's
        # three `square_NNNum/` bins hold identically-named files, so the members name
        # their bin and the core matches a member on as many trailing segments as it
        # declares. One dataset, three resolutions (design SS14/SS15.1).
        "spatial/visium-hd-bundle",
    }, sorted(spatial)

    known = set(_ROOT_IDS)
    for m in _all_manifests().values():
        known.update(t["id"] for t in _datatypes(m))
    for dt in spatial.values():
        assert dt["extends"] in known, f"{dt['id']} extends unknown {dt['extends']!r}"
        assert dt["is_abstract"] is False
        assert dt["title"] and dt["description"]
        entity = dt.get("entity_axis")
        if entity is not None:
            names = {a["name"] for a in dt.get("axes", [])}
            assert entity in names, (
                f"{dt['id']}: entity_axis {entity!r} names no declared axis {sorted(names)}"
            )


def test_nothing_selects_the_subtree_spatial_coordinates_now_sits_in():
    """TEST-2 (cont.) — `spatial/coordinates` is only safe in the matrix subtree because
    no shipped manifest selects `subtypes_of: matrix` (nor `subtypes_of: embedding`, the
    parent the design originally asked for). If one ever does, a tissue map starts being
    offered to an analysis that would re-embed it, and this test is where that shows up."""
    assert _spatial_types()["spatial/coordinates"]["extends"] == "matrix"

    # The scan has to see BOTH spellings. An earlier form anchored on `$`, which matches
    # only the block mapping — while the shipped selectors are overwhelmingly written as
    # FLOW mappings (`source: { subtypes_of: single-cell/expression }` in
    # `clustering/ui`, `differential-expression/ui`, `embedding-integrate/ui`). The exact
    # regression this test names would have landed in the common spelling and the test
    # would have stayed green.
    pattern = re.compile(r"subtypes_of:\s*[\"']?(?P<target>[A-Za-z0-9/_.-]+)")
    scanned = 0
    offenders = []
    for path in sorted(_PACKAGES.rglob("*.yaml")):
        if "/tests/" in str(path):
            continue
        scanned += 1
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = pattern.search(line)
            if not m:
                continue
            # A COMMENT that discusses a selector is not a selector. `single-cell-types`
            # carries a comment explaining why its upload containers must NOT be matrix
            # subtypes, and counting that as a hit would make this test fire on the prose
            # that agrees with it.
            hash_at = line.find("#")
            if hash_at != -1 and hash_at < m.start():
                continue
            if m.group("target") in ("embedding", "matrix"):
                offenders.append(f"{path.relative_to(_PACKAGES)}:{lineno}: {line.strip()}")
    assert scanned >= 10, (
        f"only {scanned} manifest/view yaml(s) scanned — the walk collapsed and this "
        "assertion was about to pass over nothing"
    )
    assert not offenders, (
        "something now selects `subtypes_of: embedding` or `subtypes_of: matrix`, so "
        f"`spatial/coordinates` would be offered to it: {offenders}"
    )


# ── TEST-3 [acceptance] [invariant: INV-8] ───────────────────────────────────────────
def test_the_measured_entity_reuses_the_cells_axis_and_no_spots_axis_exists():
    """TEST-3 [acceptance] [invariant: INV-8] — `cells` is reused for the measured entity
    and exactly ONE new axis (`vertex`) is introduced.

    A Visium barcode and a Xenium segmented cell are both "the thing one matrix row
    describes". Forking that into a `spots` axis would fork every existing analysis; the
    price — the axis name is imprecise on spot platforms — is paid by `measured_entity`
    recording what a row actually is. Checked tree-wide, not just on this manifest, so a
    `spots` axis introduced anywhere fails here.
    """
    coords = _spatial_types()["spatial/coordinates"]
    assert coords["entity_axis"] == "cells"
    axes = {a["name"]: a["key_label"] for a in coords["axes"]}
    assert axes["cells"] == "barcode", (
        "the entity axis must carry the SAME identity the rest of the tree joins on"
    )

    mine, others = set(), set()
    for pkg, manifest in _all_manifests().items():
        target = mine if pkg == "spatial-types" else others
        for dt in _datatypes(manifest):
            target.update(a["name"] for a in dt.get("axes", []))
    assert mine - others == {"vertex"}, (
        f"expected exactly one NEW axis (`vertex`), got {sorted(mine - others)}"
    )
    assert "spots" not in (mine | others), (
        "a `spots` axis was declared somewhere — that is the fork #175 §5 refuses"
    )


# ── TEST-13 [acceptance] [invariant: INV-9] ──────────────────────────────────────────
def test_transcripts_are_not_declared_anywhere():
    """TEST-13 [acceptance] [invariant: INV-9] — `spatial/transcripts` and the `transcript`
    axis are NOT built (#164).

    Deferred, not designed away: they buy exactly one analysis family (subcellular, the one
    with zero benchmarks), they are by far the largest artifact, they cannot be rendered,
    and they do not align to `cells` — so masks and virtual datasets could only subset them
    wrongly. Asserted tree-wide so a later re-introduction is a deliberate red test rather
    than a silent drift back into scope.
    """
    ids, axes = set(), set()
    for manifest in _all_manifests().values():
        for dt in _datatypes(manifest):
            ids.add(dt["id"])
            axes.update(a["name"] for a in dt.get("axes", []))
    assert not [i for i in ids if "transcript" in i], sorted(ids)
    assert "transcript" not in axes, sorted(axes)


# ── TEST-4 [acceptance] [invariant: INV-6] ───────────────────────────────────────────
def test_plottable_xy_is_declared_not_inherited():
    """TEST-4 [acceptance] [invariant: INV-6] — `plottable-xy` is on
    `spatial/coordinates`'s OWN capability list.

    This test reads ONLY this type's list, which is exactly what a flat resolver sees:
    `Datatype::has_capability` iterates `self.capabilities` and never walks `extends` (the
    same shape as `axes_for`), and the shipped Coordinates section is a CAPABILITY-ONLY
    selector (`applies_to: [{ capabilities: [plottable-xy] }]`). So inheriting from
    `embedding` would buy nothing and the tissue map would simply not appear.

    It would fail if someone deleted the line and relied on the parent — which is the
    precise mistake the design calls out.
    """
    coords = _spatial_types()["spatial/coordinates"]
    caps = coords.get("capabilities") or []
    assert "plottable-xy" in caps, (
        "`plottable-xy` is missing from spatial/coordinates' OWN capabilities. It is not "
        "inherited: capability resolution is a flat lookup over the type's own list."
    )
    assert "obs-aligned" in caps
    assert "spatial-coordinates" in caps, "the dispatch marker is missing"

    # The parent DOES declare it too — which is exactly why the assertion above has to read
    # this type's list rather than the resolved set: with inheritance the test would pass
    # while the capability was absent where it matters.
    embedding = None
    for manifest in _all_manifests().values():
        for dt in _datatypes(manifest):
            if dt["id"] == "embedding":
                embedding = dt
    assert embedding is not None and "plottable-xy" in embedding["capabilities"]


def test_the_has_spatial_token_the_shipped_panes_test_is_actually_declared():
    """TEST-4 (cont.) — every `has:<token>` gate in the shipped package UIs that names a
    spatial capability is satisfiable by something this package declares.

    `has:` is EXACT token membership (`expr.ts::hasCapability` → `caps.has(cap)`), fed by
    `caps.ts::deriveCaps`, which unions each produced datatype's id, its `extends`
    ancestors and their DECLARED capability strings. `cell-filter`'s spatial before/after
    panes have shipped gated on `has:spatial` and have never been able to fire. A
    capability named `spatial-coordinates` alone would NOT change that — which is why both
    are declared.
    """
    declared = set()
    for dt in _spatial_types().values():
        declared.update(dt.get("capabilities") or [])
        declared.add(dt["id"])

    tokens = set()
    for path in _PACKAGES.rglob("ui/*.yaml"):
        tokens.update(re.findall(r"has:([A-Za-z0-9/_.-]+)", path.read_text(encoding="utf-8")))
    spatial_tokens = {t for t in tokens if t.startswith("spatial")}
    assert spatial_tokens, "no shipped `has:spatial*` gate found — the subject moved"
    unsatisfiable = sorted(spatial_tokens - declared)
    assert not unsatisfiable, (
        f"shipped panes gate on {unsatisfiable}, which nothing declares — they can never "
        "fire. `has:` is exact token membership, not a prefix or a marker match."
    )


# ── TEST-5 [acceptance] [invariant: INV-7] ───────────────────────────────────────────
def test_no_fourth_structure_and_no_aux_member():
    """TEST-5 [acceptance] [invariant: INV-7] — everything is `table`, `sparse_csc` or
    `opaque`, and the ragged polygon set needs no `aux` member.

    The `aux` channel is the mechanism that LOOKS like the answer for a ragged per-entity
    structure, and using it would edit `_AUX_ROLES` in `_lib/conformance.py` — a
    framework-owned gate — from a domain declaration. It is not needed: a long table plus
    per-entity offset metadata-columns is the same thing a CSR `indptr` already is.
    """
    for dt in _spatial_types().values():
        kind = dt["storage"]["layout"]["kind"]
        assert kind in _PERMITTED_LAYOUT_KINDS, f"{dt['id']}: new structure {kind!r}"
        for arr in dt.get("arrays", []):
            akind = arr["layout"]["kind"]
            assert akind in _PERMITTED_LAYOUT_KINDS, f"{dt['id']}/{arr['name']}: {akind!r}"

    boundaries = _spatial_types()["spatial/boundaries"]
    attrs = {a["name"] for a in boundaries["arrays"][0]["attrs"]}
    assert attrs == {"entity_index", "x", "y"}, sorted(attrs)

    # The PRODUCTION half of the package only. This file necessarily spells the tokens it
    # hunts for, which is the same self-reference exemption every grep-guard in the tree
    # grants itself — and a dispatch cannot be reached from a test anyway.
    production = sorted((_PACKAGES / "spatial-types" / "compute").rglob("*.py"))
    assert production, "the contract module moved; this scan would pass over nothing"
    for py in production:
        source = py.read_text(encoding="utf-8")
        assert ".aux(" not in source and "_AUX_ROLES" not in source, (
            f"{py.name} reaches for the aux channel; the offsets ride sibling "
            "metadata-columns instead, which costs no framework change"
        )


def test_the_rasters_declare_no_axes_and_the_bundle_declares_axis_identity():
    """TEST-5 (cont.) — the two properties that are independent and get conflated.

    An image's dimensions are y/x/c, which nothing in this system joins on, so declaring
    them would be a structure claim. An opaque UPLOAD CONTAINER is the opposite case: a
    supporting file's axis is validated against the DATASET's datatype, and for an
    uploaded bundle that datatype is the container — axis-less means every axis is unknown
    and every attachment 422s.
    """
    spatial = _spatial_types()
    for raster in ("spatial/image", "spatial/labels"):
        assert not spatial[raster].get("axes"), f"{raster} must declare no axes"
        assert spatial[raster]["storage"]["layout"]["kind"] == "opaque_as_is"
        assert spatial[raster]["storage"]["format"] == "ome-tiff"

    bundle = spatial["spatial/visium-bundle"]
    assert {a["name"] for a in bundle["axes"]} == {"cells", "genes"}
    reqs = bundle["input_requirements"]
    assert reqs["requires"] == "manifest" and reqs["allow_archive"] is True
    members = reqs["members"]
    assert "tissue_positions.csv|tissue_positions_list.csv" in members, (
        "dropping the alternation silently un-groups every Space Ranger <=1.x bundle"
    )
    assert "filtered_feature_bc_matrix.h5" in members, (
        "the .h5 is the declared member, not the MEX directory: filtered and raw "
        "matrix.mtx.gz collide on basename and grouping is by basename"
    )


# ── TEST-12 ──────────────────────────────────────────────────────────────────────────
def test_the_suite_is_enumerated_and_the_unanchored_axis_has_a_stated_disposition():
    """TEST-12 — two housekeeping properties that are silent failures when broken.

    (a) `pytest.ini`'s `testpaths` is an ENUMERATION: a suite not listed there is
    collected by NOTHING, and `annotation-integrate` is the case in point — its I/O
    contract had no suite at all and a change broke the live job with every gate green.

    (b) A datatype whose entity axis is not anchored to a dataset upload boundary must
    carry a STATED disposition in `_lib/model_coverage_exempt.json`. `spatial/boundaries`'
    `vertex` is such an axis. Omitting `entity_axis` would have made the Rust guard skip
    the type entirely — answering the question by suppressing it.
    """
    # Parsed, not substring-matched: `pytest.ini`'s header is long and mentions paths in
    # prose, so `"spatial-types/tests" in ini` would be satisfied by a COMMENT while the
    # suite was collected by nothing — which is the exact failure the assertion is for.
    import configparser

    parser = configparser.ConfigParser()
    parser.read(_PACKAGES / "pytest.ini")
    testpaths = parser["pytest"]["testpaths"].split()
    assert len(testpaths) >= 10, f"testpaths collapsed to {testpaths}"
    assert "spatial-types/tests" in testpaths, (
        "this suite is not on pytest.ini's `testpaths` line, so `just check-py` collects "
        f"none of it. Enumerated: {testpaths}"
    )

    # The INGEST-anchored half only. The Rust guard additionally walks a transitive
    # fixpoint through producer edges, so this set is a SUBSET of its `anchored_axis_keys`
    # — which means this assertion can only ever DEMAND a disposition the Rust guard also
    # demands, never contradict it by demanding one it would call stale. Deliberately
    # one-directional for that reason: it never asserts an entry is absent.
    anchored = set()
    for manifest in _all_manifests().values():
        for dt in _datatypes(manifest):
            if dt.get("ingest"):
                anchored.update(a["key_label"] for a in dt.get("axes", []))
    assert "barcode" in anchored, "the anchored-axis derivation collapsed"

    exempt = json.loads(
        (_PACKAGES / "_lib" / "model_coverage_exempt.json").read_text(encoding="utf-8")
    )
    stated = {e["datatype"] for e in exempt["lattice"]}
    for dt in _spatial_types().values():
        entity = dt.get("entity_axis")
        if entity is None:
            continue
        key = next(a["key_label"] for a in dt["axes"] if a["name"] == entity)
        if key not in anchored:
            assert dt["id"] in stated, (
                f"{dt['id']}'s entity axis key {key!r} is anchored to no upload boundary "
                "and has no stated disposition in model_coverage_exempt.json"
            )
    assert "spatial/boundaries" in stated, (
        "the `vertex` disposition went missing — either the axis became anchored (state "
        "that instead) or the guard is being silenced"
    )


# ── TEST-14 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
def test_every_extends_resolves_under_the_PER_PACKAGE_rule_the_loader_uses():
    """TEST-14 [acceptance] [invariant: INV-1] — the resolution rule that actually runs at
    BOOT, which is not the one the build gate runs.

    THIS IS THE TEST THAT WAS MISSING, and its absence cost the whole feature once. There
    are two `extends` resolvers and they disagree:

      * `lint_processor_tree` (what `build.rs` runs) resolves against the six universal
        roots UNION every id contributed by EVERY package. `cargo check` is green under it
        for a cross-package supertype.
      * `lint_processor_package` (what `ExtensionRegistry::scan_dir` runs on each package
        folder at boot) resolves against the roots ∪ THIS PACKAGE'S OWN ids only. A
        cross-package supertype is a DANGLING extends, and the whole package is
        `tracing::error!`-logged once and SKIPPED.

    So a manifest can build clean and register NOTHING. That happened here: with
    `extends: embedding` (contributed by `single-cell-types`) every kind in this package
    was silently absent from the runtime registry, and the only visible symptom was a
    feature that did nothing.

    The root set is READ OUT of the build helper rather than duplicated, so a root added or
    renamed in the core cannot leave this test asserting yesterday's vocabulary.
    """
    source = (_REPO / "src-app" / "server" / "build_helper" / "processor_manifest.rs").read_text(
        encoding="utf-8"
    )
    block = re.search(r"const ROOT_DATATYPE_IDS: &\[&str\] = &\[(.*?)\];", source, re.S)
    assert block, "ROOT_DATATYPE_IDS moved; re-point this derivation"
    roots = set(re.findall(r'"([^"]+)"', block.group(1)))
    assert roots == _ROOT_IDS, (
        f"the core's root set changed: {sorted(roots)} vs this file's {sorted(_ROOT_IDS)}"
    )

    spatial = _spatial_types()
    own = set(spatial)
    resolvable = roots | own
    dangling = {
        dt["id"]: dt["extends"] for dt in spatial.values()
        if dt["extends"] not in resolvable
    }
    assert not dangling, (
        f"{dangling} — each names a supertype contributed by ANOTHER package. The build "
        "gate resolves it and boot does not, so the package would compile clean and then "
        "be skipped at runtime with every kind unregistered. Extend a universal root or a "
        "sibling in this package."
    )


def test_every_kind_this_package_contributes_has_its_extends_FROZEN_in_the_golden():
    """TEST-14 (cont.) — the `extends` of each contributed kind is frozen in a case row.

    THIS TEST WAS REPOINTED BY A MERGE, and the reason is the point. It used to read the
    golden's `lattice` array and check membership + `extends` against it. `fix/zero-core-derived`
    DELETED that array: a frozen list of the set the package system exists to grow was an
    enumeration by another name, and `reg.len() == lattice.len()` made contributing a
    datatype cost an edit under `src-app/server/src/` — mutually unsatisfiable with the
    zero-core invariant. The set is now DERIVED in `datatype/tests/mod.rs` from the roots ∪
    every manifest's `contributes.datatypes[]`, so membership needs no fixture edit and
    this half of the old assertion is redundant.

    What the derivation canNOT do is freeze a VALUE, and the merged design says so
    explicitly after a mutation audit: both sides of the derivation read the same
    manifests, so a declaration-side change moves them together. Deleting the array is
    therefore what left contributed types' `extends` frozen NOWHERE — which is why the
    merged commit added twelve `is_a` rows of its own, and why the six this package adds
    are the sanctioned form rather than leftovers. A case table is an enumeration of CASES
    over the set, not of the set; adding a datatype does not invalidate it.

    So the assertion that survives is the one only a frozen row can make: every kind here
    has its lattice position pinned by an `is_a` case that would go red if the `extends`
    were repointed.
    """
    golden = json.loads(
        (_REPO / "src-app" / "server" / "src" / "modules" / "datatype" / "tests"
         / "lattice_golden.json").read_text(encoding="utf-8")
    )
    assert "lattice" not in golden, (
        "the frozen `lattice` array is back. It was deleted deliberately — a frozen count "
        "of the contributed set makes adding a datatype cost a core edit, which the "
        "zero-core invariant forbids. `the_shared_golden_holds_case_tables_and_no_frozen_lattice` "
        "is the Rust half of this; re-adding it here would reintroduce the contradiction."
    )

    positives = {
        (row["sub"], row["sup"]) for row in golden["is_a"] if row.get("expect") is True
    }
    assert positives, "the `is_a` case table collapsed"
    for dt in _spatial_types().values():
        assert (dt["id"], dt["extends"]) in positives, (
            f"`{dt['id']}` declares `extends: {dt['extends']}` but no `is_a` case freezes "
            "it. With the `lattice` array gone, a case row is the ONLY thing that would "
            "catch this type being silently repointed — the derivation cannot, because it "
            "reads the same manifest the registry is built from."
        )


def test_the_upload_container_declares_the_marker_the_CORE_actually_enumerates():
    """TEST-14 (cont.) — a manifest-group declaration that nothing enumerates is inert.

    The upload planner builds its specs from
    `reg.types_with_capability(MANIFEST_GROUP_CAPABILITY)`, and that constant's VALUE — not
    its name — is what a contributed type must declare. A descriptively-named marker alone
    would leave a Space Ranger bundle landing as four unrelated single-file datasets, with
    no error anywhere: `detect_manifest_group` simply never runs for a type it never
    enumerated.

    The literal is READ OUT of the Rust constant, so renaming the value in the core makes
    this test fail loudly instead of leaving the declaration quietly dead.
    """
    source = (_REPO / "src-app" / "server" / "src" / "modules" / "dataset"
              / "repository.rs").read_text(encoding="utf-8")
    m = re.search(r'MANIFEST_GROUP_CAPABILITY:\s*&str\s*=\s*"([^"]+)"', source)
    assert m, "MANIFEST_GROUP_CAPABILITY moved; re-point this derivation"
    marker = m.group(1)

    subjects = [dt for dt in _spatial_types().values()
                if (dt.get("input_requirements") or {}).get("requires") == "manifest"]
    assert subjects, "no multi-member upload container declared — the subject set collapsed"
    for dt in subjects:
        assert marker in (dt.get("capabilities") or []), (
            f"`{dt['id']}` declares `input_requirements: manifest` but not the capability "
            f"the core enumerates ({marker!r}), so its members are never grouped and a "
            "multi-file upload silently lands as unrelated single-file datasets"
        )


def test_no_opaque_container_declares_a_non_target_capability():
    """TEST-14 (cont.) — the INV-7 opaque-container rule, in THIS package's own suite.

    An opaque container declares NOTHING about what is inside it. Declaring a capability
    on one puts it into the candidate set of every selector gating on that capability,
    which is how an upload format gets offered to an analysis that cannot open it. The
    rule ships as a Rust gate over the whole tree
    (`server/tests/extensions/datatype_contribution_test.rs::test7`); this package broke
    it on its first cut and the detection came from another language's suite. A guard
    suite that omits the one rule its own change violated is the gap worth closing, so the
    predicate is mirrored here, derived over the same lattice.

    THE PREDICATE IS THE SHIPPED ONE, NOT A WEAKER PARAPHRASE. This mirror previously
    asked only whether a capability was ALSO claimed by an analysable type. That is
    strictly weaker than what ships, and the gap was not theoretical: it is exactly why
    `spatial/image: [spatial-image]` and `spatial/labels: [spatial-labels]` survived a
    full green package suite and failed the Rust gate on the merge. A per-kind marker no
    analysable type happens to claim is still a structure claim. The shipped rule is:
    after filtering `*-target` entries the capability list must be EMPTY.

    The `-target` suffix is the ONLY exemption and it is narrow — it names a ROLE the host
    resolves through `types_with_capability` (a fact about how the file is ROUTED, never
    about its bytes), which is why `spatial/visium-bundle` keeps its two entries.
    """
    lattice = {}
    for manifest in _all_manifests().values():
        for dt in _datatypes(manifest):
            lattice[dt["id"]] = dt

    def is_opaque(dt_id):
        seen = set()
        cur = dt_id
        while cur and cur not in seen:
            seen.add(cur)
            if cur == "data/opaque":
                return True
            cur = (lattice.get(cur) or {}).get("extends")
        return False

    subjects = [dt for dt in _spatial_types().values() if is_opaque(dt["id"])]
    assert subjects, (
        "no opaque container declared by this package — the subject set collapsed and the "
        "loop below would assert nothing"
    )

    offenders = []
    for dt in subjects:
        structural = [c for c in (dt.get("capabilities") or [])
                      if not c.endswith("-target")]
        if structural:
            offenders.append(f"{dt['id']}: {structural}")
    assert not offenders, (
        "opaque container(s) advertising what is INSIDE them (INV-7); only `*-target` "
        f"routing roles are permitted: {offenders}"
    )


def test_this_feature_added_no_aux_role_to_the_framework_gate():
    """TEST-5 (cont.) [invariant: INV-7] — `_AUX_ROLES` gained nothing spatial.

    INV-7's operative clause is that the ragged polygon set costs no framework change. The
    `aux` channel is the mechanism that LOOKS like the answer, and taking it would mean
    adding roles to `_lib/conformance.py`'s `_AUX_ROLES` — a framework-owned gate — from a
    domain declaration. Asserted over the SHIPPED role set rather than over this branch's
    diff, so it stays meaningful on a later branch that legitimately edits that file for
    an unrelated reason.
    """
    conformance = (_PACKAGES / "_lib" / "conformance.py").read_text(encoding="utf-8")
    block = re.search(r"_AUX_ROLES\s*=\s*\{(.*?)\n\}", conformance, re.S)
    assert block, "_AUX_ROLES moved; re-point this derivation"
    roles = set(re.findall(r'"([^"]+)"\s*:', block.group(1)))
    assert roles, "the _AUX_ROLES parse collapsed to nothing"
    spatial_words = ("spatial", "vertex", "boundar", "coordinate", "tissue", "section")
    intruders = sorted(r for r in roles if any(w in r.lower() for w in spatial_words))
    assert not intruders, (
        f"the framework aux-role vocabulary now carries {intruders} — the ragged encoding "
        "is sibling per-entity offset metadata-columns, which costs no framework change"
    )


def test_the_manifest_still_names_every_known_gap_the_reconciliation_recorded():
    """TEST-14 (cont.) — the recorded gaps cannot be deleted quietly.

    The epic reconciliation matched every downstream item's assumed contract against what
    this leaf declares. Two gaps were closed here; four are real, deliberately open, and
    recorded in the manifest header so the next reader meets them instead of rediscovering
    them. A recorded gap that is silently dropped is worse than one never written down —
    it reads as "considered and fine". These are the load-bearing phrases, checked by
    substring so the prose can be rewritten but the SUBJECT cannot vanish.
    """
    header = _MANIFEST.read_text(encoding="utf-8")
    for gap in (
        "NOTHING REQUIRES A `spatial/image` TO DECLARE ITS COORDINATE SPACE",
        "PYRAMID AND ONE-BLOB RULES",
        "no member-listing API",
        "geometry_role",
    ):
        assert gap in header, (
            f"the known gap {gap!r} is no longer recorded in the manifest header — either "
            "it was closed (say so, and remove it deliberately) or it was dropped"
        )
