#!/usr/bin/env python3
# ruff: noqa
r"""TEST-131..135 — the RETRACTED reason and the #503 OVERSTATEMENT are absent
package-wide, and the surviving copies agree with the one canonical sentence.

## The two defects this node closes, and the one rule

#489 measured that the empty-matrix justification is duplicated in eleven unasserted
places and took three adversarial rounds to repair, with every gate green. #503
measured that the duplicated sentence contains an overstatement: "`main()` has exactly
two outcomes" is false as stated (an uncaught exception exits 1 with a raw traceback —
INV-1's prohibited outcome — MEASURED through the shipped entrypoint on this node:
`TXR_OUTPUTS_DIR` set to a path that is an existing regular file makes `io_dirs()`'s
`Path.mkdir` raise `FileExistsError` outside `main()`'s try, rc 1, raw traceback, NO
`spatial.import-visium:` prefix), and "there is no 'succeeded with a warning' outcome"
is false as stated because the import DOES carry passive warning channels on success
(verified: `progress("done", 100, ...)` at import_visium.py:5244 emitted only on the
success path, and the report's `image_warnings` (5135), `images_not_emitted` (5134),
`registration_qc` (5141), `scale_note` (5149) fields plus every output entry's `meta`).

FIX ROUND 1 (this file's hardening) exists because the corrected prose ITSELF carried
the same overclaim class one level deeper: the round-1 canonical sentence said nothing in
the signal the operator acts on DISTINGUISHES the import from a real one — but the
zero-barcodes shape's stream and report DO show the emptiness (MEASURED with the
refusals set aside: `progress: matrix|15|0 spots ...`, `progress: coordinates|65|0 spot
positions`, report `n_spots: 0`, manifest `structure.nnz: 0`), so the absolute was false
for that shape. The correction is a SCOPED claim plus one measured per-shape honesty
clause per refusal, and the recovered overstatement phrase is the seventh forbidden
fragment — the #359 retracted destination claim (this node) is the eighth.

## The TRUE claim, scoped to the outcome signal

What is genuinely true is about what the operator is TOLD, not about what the stream
shows: an import of a matrix with no usable stored value is reported as SUCCESS at exit
0; `main()` has exactly two DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed (an
uncaught exception exits 1 with a raw traceback, which is INV-1's PROHIBITED outcome,
not a designed one) — and there is no outcome REPORTED TO THE OPERATOR as anything other
than SUCCESS: the process exits 0 and emits the same closing `progress("done", 100,
...)` line whether the matrix is empty or full (MEASURED — `progress: done|100|16
outputs` is the identical closing line in every measured case, all of them on this
node's committed fixture; the count in that line is `len(entries)` — one entry per
emitted artifact, including one per emitted vendor image — so it is bundle-dependent,
and what is identical for every measured shape is that the SUCCESS path emits that
line at the end), and the report's
`image_warnings` and `images_not_emitted` lists, the `registration_qc` block, the
`scale_note` field and every output entry's `meta` are PASSIVE channels — they change
nothing about the exit code or stderr and are only visible to someone who opens the
report or manifest artifact. The load-bearing harm is the plausible wrong answer: the
operator is told the import SUCCEEDED and downstream analysis runs on nothing usable.

Nothing in that claim says the emptiness is invisible. Whether the stream shows it is
per-shape, and each refusal message states its own measured visibility: zero-barcodes
streams `matrix|15|0 spots ...` / `coordinates|65|0 spot positions` and a report with
`n_spots: 0`, and the manifest's expression entry carries `structure.nnz: 0`; the
`nnz == 0` shape streams progress and a report byte-identical to a real import (the
manifest's expression entry differs in its machine-readable structure record (the
stored-value count, the shapes and the byte counts), which no note field restates);
all-zero and mixed stream progress byte-identical to a real import with
nothing in the report stating the matrix's stored values or their count. The canonical
constant `REASON_NO_USABLE_COUNTS` carries the load-bearing claim; the shape-specific
visibility is stated in each refusal's own clause, never in the constant.

## Why an ABSENCE scan, and not a spot fix

#489 measured it: the retracted/overstated sentence survives in copies nobody asserts —
a builder docstring, a changelog entry, a decision comment — so a one-place correction
leaves the false claim alive in an unasserted copy, which the next #470-shaped change
writes straight back into a message. The repair shape is therefore the sweep: every
`.py` and `.yaml` under this package is scanned.

## The forbidden fragments, and WHY the levels are three

FORBIDDEN (each assembled from concatenated parts — see `_fragment` — so this file
never carries the raw contiguous phrase, and it is `SELF`-excluded anyway for the same
reason the sibling's TEST-111 excludes itself):

  * the retracted #488 predicate: `indistinguishable` + ` from a successful import`;
  * the retracted #488 phrase: `complete but` + ` empty dataset`;
  * the retracted #488 phrase: `bundle with` + ` data in it`;
  * the retracted #488 gate: `imports into a` + ` complete but`;
  * the #503 overstatement: `exactly two` + ` outcomes`;
  * the #503 overstatement: `succeeded with a` + ` warning`;
  * the FIX-ROUND-1 overstatement: `nothing in the signal the operator acts on `
    + `distinguishes` (the absolute the round-1 constant carried; the corrected
    per-shape clauses say "the operator-visible signal does not distinguish ...",
    which is a DIFFERENT string and is deliberately NOT forbidden).
  * the #359 retracted destination claim: `That is issue ` + `#160` (the old
    `binned_outputs/` refusal reported the platform gap to issue #160 — a CLOSED issue,
    exactly the deferral-outlives-its-target class; the corrected message names no issue
    at all and points at the HD importer instead). The corrected comment's HISTORY
    mention of #160 (`pointed its reader at #160` / `never as a destination`) is
    deliberately NOT this fragment.

Deliberately NOT forbidden: `indistinguishable` alone (it appears legitimately in
dozens of places), `does not distinguish` / `distinguishes ... from a real one` (the
TRUE scoped claim the corrected text carries), `complete, coherent, empty dataset` (the
comma-bearing TRUE phrasing in the adjacent compute comment), `plausible wrong answer
rather than an error` (true), and the corrected HD-refusal message's true clauses
(`hide the platform gap rather than close it`, `basename member matching`, `per-bin
upload or a directory-aware matcher` — the #359 message keeps them, so forbidding them
would make the sweep unshippable); the retirement-record comment's history citation of
`#160` is exactly the class-rule carve-out that must stay allowed. The no-false-match
property is itself asserted below:
`exactly two DESIGNED outcomes` must NOT match `exactly two outcomes` under ANY of the
levels, and the canonical constant text must match none of the eight.

(a) WHITESPACE-COLLAPSED: every `\s` run — newlines included — becomes one space, so a
docstring's line wrap is no longer a hiding place. (b) WHITESPACE-, QUOTE- AND
`#`-FREE: `"`, `'`, `#` and whitespace are removed too, so a phrase split across
ADJACENT STRING LITERALS (the shape the old messages shipped — the quote characters sit
between the words) or written back as a `#`-wrapped COMMENT (the shape a `#`-comment
block takes; the `#` and the space after it sit between the words) is joined, which (a)
cannot see. (c) DECODED RUNTIME VALUES — the levels a `#`-comment wrapped in SILENT
quotes cannot defeat: text normalizations run on SOURCE BYTES, so a phrase the source
hides from them is invisible to both — backslash line-continuation (`"a \` + newline +
`"b"`), `+`-concatenation (`"a " + "b"`), a `%`-format (`"a %s" % "b"`, `"%s %s" % ("a",
"b")`, `"%(a)s" % {"a": "b"}`), and `\x20`/`\u0020` escapes between words all yield
the EXACT forbidden runtime string while (a) and (b) stay silent. The AST pass walks
every `.py` file and checks the DECODED value of every string literal (the parser folds
adjacent literals and decodes escapes) and of every constant-folded `BinOp` the parser
leaves un-folded — `+`-concat and `%`-format, folded by hand in `_fold_runtime_value`
(recursive over literal operands only: strings, constant tuples, constant dicts; a
format that could not actually RUN — wrong arity, a mapping missing a key — is not
folded, because the runtime never produces it). The YAML pass `yaml.safe_load_all`s
every `.yaml` and walks EVERY document of the `---`-separated stream, checking every
string leaf (dict keys and values, list items) of every document, so a
second-document escape is not skipped; a document whose stream fails to parse ends the
pass (PyYAML cannot resynchronise — the remaining documents are skipped and the two
text levels scanned the whole file anyway). Strings built by CALLS (`f"...{chr(32)}..."`,
`"".join([...])`, a `%`-format whose operand is a variable) and assemblies that need a
VARIABLE (`f"...{name}..."`, `a + "b"` where `a` is a name, `+=`) are NOT decoded by
either pass and are the documented ceiling — the controls below assert those shapes are
NOT caught, and the gap is the tracked residual
https://github.com/tinnlab/txresbench/issues/614 (the HD sibling's counterpart of the
same `#`-lesson is their issue #604).

## The exclusion is one named path, asserted

This file quotes and exercises the forbidden phrases in its docstring and its probe
cases, so the sweep must not scan it — exactly the reason the sibling's TEST-111
excludes itself. `SELF` is one named path, and `scanned_files()` asserts it removed
EXACTLY one existing file, so the exclusion cannot silently widen into "the tests are
not scanned".

## Known ceiling

The detector is LITERAL, and it is exact only for the assemblies it CAN fold at scan
time. It checks five surfaces: (1) the decoded runtime string value of every `.py`
string literal — the parser has already folded adjacent literals and decoded
`\x20`/`\u0020`/backslash-continuations into the value; (2) the hand-folded value of
every constant `+`-concatenation (`"a " + "b"`), recursing through nested operands;
(3) the hand-folded value of every constant `%`-format (`"a %s" % "b"`,
`"%s %s" % ("a", "b")`, `"%(a)s" % {"a": "b"}`) — a literal format string with a
literal, constant-tuple or constant-dict operand, recursing into nested operands, and
NOT folded when the format could not actually run (wrong arity, a mapping missing a
key — the runtime never produces that value); (4) the decoded string leaves of EVERY
`.yaml` document of a multi-document stream (`---`-separated; a document the stream
cannot parse ends the pass, and the source-text levels still scanned the file); (5)
the two source-text normalizations (whitespace-collapse; whitespace/quote/`#`-free) on
every `.py` and `.yaml` file.

What it does NOT catch is ANY assembly whose runtime value needs code the detector
does not execute — the residual is that whole class, not a shape list: a string built
by a CALL (`f"{chr(32)}"` between the words, `"".join(...)`, `.format(...)`, a `%`
whose operand is a variable), an f-string interpolating a NAME
(`f"...on {x}distinguishes"`, whose `{x}` the detector will not replace), a
variable-mediated `+` (`a = "...acts on "; a + "distinguishes"`) or `+=`, or any value
held in a variable and assembled later; a genuinely NEW paraphrase in different words;
hyphenation, an inserted comma or a capitalisation change that breaks a fragment; and
non-string content (numbers, bytes, or the deliberately non-scanned fixture/JSON
surface). Six of those shapes are pinned below as NOT caught — `f"{chr(32)}"`,
`"".join(...)`, a `%`-format whose operand is a variable, an f-string interpolating a
NAME, a variable-mediated `+` and `+=` (items (16)-(21)); the rest of the class —
`.format(...)` (also a call-built shape, but NOT one of the six pinned controls),
hyphenation, an inserted comma, a capitalisation change, a genuinely NEW paraphrase in
different words, non-string content — is named but NOT pinned by a control, so those
stay unmeasured and the ceiling is stated exactly as far as it is measured. The residual is the tracked
ceiling:
https://github.com/tinnlab/txresbench/issues/614 (the HD sibling notes the same class
of gap as its #604). What it pins is the retracted sentence's four
distinctive fragments, the #503 overstatement's two, FIX ROUND 1's recovered
overstatement fragment and the #359 destination claim — in the shapes they actually
shipped in (line-wrapped,
string-literal-split, `#`-comment-wrapped) plus the escape/continuation/`%`-format/
multi-document shapes the AST and YAML passes decode (the `%`-format and multi-document
YAML classes are FIX ROUND 2 additions). A future author's NEW wording is caught by the
repair-sweep discipline (the package-wide sweep-measurement #489 describes), not by
this guard.

## The scanned suffix surface — and what is deliberately NOT scanned

`scanned_files()` walks `.py` and `.yaml` only, matching the sibling's TEST-111
convention. The package ALSO ships non-`.py`/`.yaml` files — the committed fixture
members under `tests/fixtures/` (`.h5`, `.csv`, `.jpg`, `.png`, and the JSON documents
`scalefactors_json.json` / `PROVENANCE.json`) — and those are NOT scanned: a DELIBERATE
exclusion, not an accident, and not a guarantee about them. The basis is honest about
what each named member is, because they are two different kinds of thing: the `.h5`,
`.csv`, `.jpg` and `.png` members and `scalefactors_json.json` are generated or vendored
bytes, not prose a future edit can introduce the claim into (the editable prose this
guard protects — the messages, the manifest changelog, the docstrings — is
`.py`/`.yaml`); `PROVENANCE.json` is the exception — 29 KB of narrative notes and
attribution, i.e. prose — and it is excluded as a DELIBERATE scope choice, not on the
false basis that it cannot carry prose: it is the committed evidence record that the
standing fixture-protection tests pin, and the claim being made is about the surface
the claim ships in — the messages, the changelog and the docstrings — not about the
fixture provenance record. The fixture members are still pinned by the standing
fixture-protection tests, and adding a new suffix to the walk is a DELIBERATE change —
the floor-30 coverage leg plus the compute/manifest coverage leg exist to keep the walk
honest.

## The invariant mapping, stated

INV-1 says a bundle this importer cannot carry is REFUSED BY NAME — never a traceback
and never an exit-1. #503's class is precisely the honesty half of the NAME: the named
refusal carried a reason that was false/overstated, and nothing asserted what the name
says. These tests pin that the name carries the TRUE canonical reason (TEST-132/134),
that it is impossible to reintroduce the retracted/overstated wording anywhere in the
package — in source text OR in decoded runtime string values (TEST-131), that each
reason-carrying refusal really interpolates the constant rather than a private copy
(TEST-133) — with the detector's own discrimination proven by controls (TEST-135). The
INV-2 half (refusal before any artifact byte) stays pinned by the standing TEST-77/78/
114/127-130 zero-path legs, which this node does not change.

## Standing tests this re-cites

The discrimination of this node depends on the standing acceptance legs, which are
re-cited rather than duplicated: TEST-77 (empty-nnz refusal rc 2 + zero paths),
TEST-78 (zero-barcodes refusal rc 2 + zero paths), TEST-79 (the unmutated fixture
still imports rc 0 — the positive control that keeps this file's refusals from being
over-broad), TEST-80 (a small but non-zero `nnz` is NOT refused as empty), TEST-114 and
TEST-115 (the #474 all-zero and the #548 some-NaN boundary controls — the scan's
all-zero/mixed per-shape legs are pinned to the same shapes). All were re-run green by
the orchestrator's final battery (see TEST_RESULTS.md).
"""
import ast
import re
import sys
from pathlib import Path

import h5py
import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

PKG = Path(__file__).resolve().parents[1]
MATRIX = "filtered_feature_bc_matrix.h5"

#: THIS FILE, excluded from its own sweep — the one exclusion, stated rather than quiet,
#: exactly as the sibling's TEST-111 `SELF` is.
SELF = Path(__file__).resolve().relative_to(PKG).as_posix()

#: The canonical sentence's distinctive claim — the load-bearing clause the corrected
#: wording states, in the exact case it is spelled with. Every surviving copy must carry
#: it; spelling it once here is what makes the agreement legs about ONE claim.
_DISTINCTIVE = "no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS"

#: The module-level constant name the four reason-carrying refusals interpolate.
CONSTANT = "REASON_NO_USABLE_COUNTS"

_WS = re.compile(r"\s+")
_QUOTES_WS = re.compile(r"""["'#\s]+""")


def _fragment(*parts):
    """Assemble one forbidden fragment from parts.

    The assembly serves ONE purpose: this source file never carries the raw contiguous
    fragment (the joined parts are a forbidden phrase). It says nothing about where the
    split sits — a split at a natural word boundary is just as fine as one inside a
    word; both are only so the file is not itself a copy of the phrase. The `SELF`
    exclusion is what makes quoting-and-excluding safe: this file is removed from its
    own sweep, and `scanned_files()` asserts that exclusion removed EXACTLY one file,
    so the assembly is belt-and-braces, not the mechanism.
    """
    return "".join(parts)


#: The eight forbidden fragments — the retracted #488 reason (four pieces), the #503
#: overstatement (two pieces), FIX ROUND 1's recovered overstatement (one piece) and
#: the #359 retracted destination claim (one piece — the binned_outputs/ refusal's
#: stale "That is issue " + "#160" deferral) — that must never come back. The seventh is the
#: absolute the round-1 canonical sentence carried; the corrected per-shape clauses use
#: "the operator-visible signal does not distinguish ...", which is deliberately NOT
#: this string. The eighth is the destination sentence the corrected message deleted —
#: the corrected message names NO issue at all, and the retirement-record comment's
#: HISTORY mention of #160 is deliberately NOT this fragment (the class rule's own
#: carve-out: a closed issue cited as history is a legitimate citation, never a
#: destination).
_FORBIDDEN = (
    _fragment("indistinguishable", " from a successful import"),
    _fragment("complete but", " empty dataset"),
    _fragment("bundle with", " data in it"),
    _fragment("imports into a", " complete but"),
    _fragment("exactly two", " outcomes"),
    _fragment("succeeded with a", " warning"),
    _fragment("nothing in the signal the operator acts on ", "distinguishes"),
    _fragment("That is issue ", "#160"),
)


def _line_containing(text, fragment):
    """The 1-based source line carrying `fragment`'s first word, or 0.

    Attribution, not detection: the fragment was already found in the whole text under a
    normalization, and the words of the phrase are contiguous in the SOURCE too (only
    whitespace, quotes or the `#` of a comment-wrapped copy sit between them), so a
    pattern that lets each inter-word gap be whitespace, a quote or a `#` finds the
    exact span and its first line. Returns 0 when the source never carries it
    contiguously (the escape/continuation shapes the runtime pass alone sees) — the
    hit is still reported, just without a line.
    """
    pattern = re.compile(r"[\s\"#']+".join(re.escape(word) for word in fragment.split(" ")))
    match = pattern.search(text)
    if match is None:  # pragma: no cover — a found fragment is always attributable
        return 0
    return text.count("\n", 0, match.start()) + 1


def _text_level_hits(text):
    """The forbidden fragments the TWO SOURCE-TEXT normalizations see in `text`.

    This is the source-byte half of the detector, separated so a DECODE-shape control
    can assert the other half stays silent about it: a shape that (a) and (b) already
    see is not a decode shape, and its claim ("both text normalizations stay silent")
    would be false. The runtime-value half (the decoded values of `_runtime_strings` /
    `_yaml_strings`) is checked separately, on the decoded strings.
    """
    collapsed = _WS.sub(" ", text)
    stripped = _QUOTES_WS.sub("", text)
    return {fragment for fragment in _FORBIDDEN
            if fragment in collapsed or _QUOTES_WS.sub("", fragment) in stripped}


def _contains_forbidden(text):
    """Every forbidden fragment `text` carries, under either normalization.

    Returns the list of fragments found — empty means clean. Both normalizations are
    required, and each is checked over the WHOLE TEXT (not line by line), because the
    phrase can span two source lines and, in the messages, adjacent string literals:

    (a) whitespace-collapsed — every `\\s` run, newlines included, becomes one space, so
        line wraps are no longer a hiding place;
    (b) whitespace-, quote- AND `#`-free — `"`, `'` and `#` are removed too, so a phrase
        split across adjacent literals OR written back as a `#`-wrapped comment is
        joined, which (a) cannot see because the quote/`#` characters keep the words
        apart.

    This one function is the checker for ALL THREE levels: the source-text levels (a)
    and (b) run on the raw file bytes (see `_text_level_hits`), and the runtime-value
    levels run on the DECODED strings the AST and YAML passes extract — the decoded
    value is just another string, checked exactly the same way (the two normalizations
    still apply: a multi-line string's newline is still whitespace, and a runtime value
    can still carry a quote or `#` as content).
    """
    return sorted(_text_level_hits(text))


def _fold_runtime_value(node):
    """Constant-fold a value the parser leaves as a `BinOp`, or `None`.

    `ast.literal_eval` deliberately REFUSES a string `+` ("malformed node or string" —
    string add is not in its supported operation set), so the folding is done here, and
    it is extended to `%`-format for the same reason: a constant `BinOp(Mod)` whose
    template is a string literal and whose operand folds to a string, a constant tuple
    or a constant dict is exactly the string the running module would hold, so it is
    folded and checked. The recursion is hand-rolled and literal-only — a non-literal
    operand (a variable, a call, a subscript) returns `None`, which is exactly the
    call/variable-built ceiling, not an oversight. A format that could not actually
    RUN — wrong arity (`"%s %s" % "a"`), a mapping missing a key, a non-string for a
    `%s` — raises at runtime, so no such string is ever produced and the fold returns
    `None` rather than inventing one.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Tuple):
        items = [_fold_runtime_value(elt) for elt in node.elts]
        if all(isinstance(item, str) for item in items):
            return tuple(items)
    if isinstance(node, ast.Dict):
        keys = [k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)]
        if len(keys) == len(node.keys):
            values = [_fold_runtime_value(v) for v in node.values]
            if all(isinstance(v, str) for v in values):
                return dict(zip(keys, values))
    if isinstance(node, ast.BinOp):
        if isinstance(node.op, ast.Add):
            left = _fold_runtime_value(node.left)
            right = _fold_runtime_value(node.right)
            if isinstance(left, str) and isinstance(right, str):
                return left + right
        elif isinstance(node.op, ast.Mod):
            template = _fold_runtime_value(node.left)
            operand = _fold_runtime_value(node.right)
            if isinstance(template, str) and isinstance(operand, (str, tuple, dict)):
                try:
                    return template % operand
                except (TypeError, ValueError, IndexError, KeyError):
                    return None
    return None


def _runtime_strings(source):
    """Every decoded runtime string value in a `.py` source: `(node, value)` pairs.

    `ast.walk` visits every `ast.Constant` carrying a `str` — and the parser has ALREADY
    folded adjacent string literals (a line-continuation splitting one literal is one
    Constant before this code ever runs) and DECODED every escape (`\x20`, `\u0020`,
    `\n`), so the value is exactly what the running module would hold. `+`-concatenation
    and `%`-format are NOT folded by the parser, so every `ast.BinOp` with `Add` or
    `Mod` is additionally constant-folded by hand (see `_fold_runtime_value`) — a
    non-literal operand makes the fold return `None`, which is the exact
    call/variable-built ceiling, not an oversight.
    """
    out = []
    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover — a committed .py should parse; if it does
        return out       # not, the source-text levels still scanned it
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append((node, node.value))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
            value = _fold_runtime_value(node)
            if isinstance(value, str):
                out.append((node, value))
    return out


def _yaml_strings(text):
    """Every decoded string leaf of EVERY `.yaml` document: dict keys and values, list items.

    `yaml.safe_load_all` yields one mapping per `---`-separated document, so a
    second-document escape is not skipped the way a single `yaml.safe_load` would skip
    a stream it cannot parse as ONE document (a multi-document stream raises
    `ComposerError` — measured, and that made the whole file silently unscanned). The
    decoder has already decoded double-quoted scalar escapes and folded a double-quoted
    backslash line-continuation, so a phrase the source hides from the two text levels
    is a plain leaf here. A document whose stream fails to parse ENDS this pass — PyYAML
    cannot resynchronise into the next document, so the remaining documents are skipped
    too, and the source-text levels still scanned the whole file.
    """
    out = []
    try:
        loader = yaml.safe_load_all(text)
    except yaml.YAMLError:
        return out
    while True:
        try:
            doc = next(loader)
        except StopIteration:
            return out
        except yaml.YAMLError:
            return out
        stack = [doc]
        while stack:
            value = stack.pop()
            if isinstance(value, str):
                out.append(value)
            elif isinstance(value, dict):
                for key, item in value.items():
                    if isinstance(key, str):
                        out.append(key)
                    stack.append(item)
            elif isinstance(value, (list, tuple)):
                stack.extend(value)


def _source_runtime_hits(source):
    """The forbidden fragments a `.py` source's DECODED runtime strings carry."""
    return sorted({fragment for _node, value in _runtime_strings(source)
                   for fragment in _contains_forbidden(value)})


def _yaml_value_hits(text):
    """The forbidden fragments a `.yaml` document's string leaves carry."""
    return sorted({fragment for value in _yaml_strings(text)
                   for fragment in _contains_forbidden(value)})


def scanned_files():
    """Every `.py` and `.yaml` under this package, as package-relative POSIX paths.

    Enumerated by walking the tree rather than listed, so a file added tomorrow is
    scanned tomorrow. `__pycache__` is skipped: a `.pyc` is not source, and a stale one
    would make the scan answer about code that is no longer here. [`SELF`] is skipped
    for the reason recorded in the docstring, and the exclusion is asserted to have
    removed EXACTLY one existing file.
    """
    out = []
    excluded = 0
    for path in sorted(PKG.rglob("*")):
        if path.suffix not in (".py", ".yaml") or not path.is_file():
            continue
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(PKG).as_posix()
        if rel == SELF:
            excluded += 1
            continue
        out.append(rel)
    assert excluded == 1, (
        f"the self-exclusion matched {excluded} file(s) instead of exactly one — either "
        f"{SELF} has moved (and the guard is now scanning itself, which cannot pass) or the "
        "path is stale (and something else is being skipped silently)"
    )
    return out


def scan_forbidden():
    """`{rel: [(lineno, fragment), ...]}` for every forbidden fragment in the package.

    Per file, THREE layers are checked: the two source-text normalizations, then — for a
    `.py` — every DECODED runtime string value, or — for a `.yaml` — every decoded
    string leaf. A fragment is reported once per file, with the best available line:
    the source-text attribution when the source carries the phrase contiguously, the AST
    node's own line for a runtime-only hit, and 0 when neither applies.
    """
    hits = {}
    for rel in scanned_files():
        text = (PKG / rel).read_text(encoding="utf-8")
        per = {}
        for fragment in _contains_forbidden(text):
            per[fragment] = _line_containing(text, fragment)
        if rel.endswith(".py"):
            for node, value in _runtime_strings(text):
                for fragment in _contains_forbidden(value):
                    per.setdefault(fragment, max(0, getattr(node, "lineno", 0) or 0))
        else:
            for value in _yaml_strings(text):
                for fragment in _contains_forbidden(value):
                    per.setdefault(fragment, 0)
        if per:
            hits[rel] = sorted(per.items())
    return hits


# ── the acceptance test: the absence half ─────────────────────────────────────────────


# TEST-2 (#359): the package-wide sweep now carries the EIGHTH fragment — the #359
# retracted destination claim (per TESTS.md).
def test_TEST_131_the_retracted_reason_and_overstatement_are_ABSENT_package_wide():
    """TEST-131 [acceptance, INV-1] [covers: ITEM-8, ITEM-6] — the real sweep.

    Every `.py` and `.yaml` under the package is read with `encoding="utf-8"` and none
    may contain a forbidden fragment — the retracted #488 reason, the #503 overstatement,
    the FIX ROUND 1 recovered overstatement or the #359 retracted destination claim
    (the same "That is issue " + "#160" claim, the binned_outputs/ refusal's stale
    deferral to a CLOSED issue) — in the source text (either
    normalization) OR in a decoded runtime string value (the AST pass for `.py`, the
    YAML-leaf pass for `.yaml`). This leg is RED until every copy is reworded — that is
    by design: the absence is the acceptance test, and it must never be "greened" by
    weakening the assertion or the fragment list.
    """
    hits = scan_forbidden()
    assert not hits, (
        "the retracted/overstated reason is still present in this package:\n"
        + "\n".join(
            f"  {rel}:{lineno}: {fragment}"
            for rel, found in sorted(hits.items())
            for lineno, fragment in found
        )
    )


# ── the agreement half, operator-facing first ─────────────────────────────────────────

_REFUSAL_PREFIX = b"spatial.import-visium: "


def _empty_nnz_bundle(tmp_path, name):
    """A copy of the committed fixture with `/matrix/data` and `/matrix/indices` empty
    and `/matrix/indptr` all zeros — the #445 shape, exactly as TEST-77 builds it."""
    bundle = VF.stage_bundle(tmp_path, name=name)
    with h5py.File(bundle / MATRIX, "r+") as handle:
        shape = handle["matrix"]["shape"][:]
        n_barcodes = int(shape[1])
        m = handle["matrix"]
        del m["data"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        del m["indices"]
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        del m["indptr"]
        m.create_dataset("indptr", data=np.zeros(n_barcodes + 1, dtype=np.int64))
    return bundle


def _zero_barcodes_bundle(tmp_path, name):
    """A copy of the committed fixture with `/matrix/barcodes` and `/matrix/shape`
    zeroed and the other members emptied — the documented empty case, as TEST-78."""
    bundle = VF.stage_bundle(tmp_path, name=name)
    with h5py.File(bundle / MATRIX, "r+") as handle:
        shape = handle["matrix"]["shape"][:]
        n_features = int(shape[0])
        m = handle["matrix"]
        del m["barcodes"]
        m.create_dataset("barcodes", data=np.array([], dtype="S18"))
        del m["shape"]
        m.create_dataset("shape", data=np.array([n_features, 0], dtype=np.int32))
        del m["data"]
        m.create_dataset("data", data=np.array([], dtype=np.int32))
        del m["indices"]
        m.create_dataset("indices", data=np.array([], dtype=np.int64))
        del m["indptr"]
        m.create_dataset("indptr", data=np.array([0], dtype=np.int64))
    return bundle


def _all_zero_bundle(tmp_path, name):
    """A copy of the committed fixture with `/matrix/data` all zeros, same length and
    dtype — the #474 shape, as TEST-114 builds it."""
    bundle = VF.stage_bundle(tmp_path, name=name)
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        data[:] = 0
        del m["data"]
        m.create_dataset("data", data=data)
    return bundle


def _mixed_bundle(tmp_path, name):
    """A copy of the committed fixture with `/matrix/data` every value 0 except 3 NaNs —
    the #548 mixed shape, as TEST-130 builds it."""
    bundle = VF.stage_bundle(tmp_path, name=name)
    with h5py.File(bundle / MATRIX, "r+") as handle:
        m = handle["matrix"]
        data = m["data"][:]
        assert len(data) > 0, "the fixture must have stored values for this test to mean anything"
        mixed = np.zeros(len(data), dtype=np.float32)
        mixed[:3] = np.nan
        del m["data"]
        m.create_dataset("data", data=mixed)
    return bundle


def test_TEST_132_the_canonical_reason_is_emitted_VERBATIM_on_the_refused_runs(tmp_path):
    """TEST-132 [acceptance, INV-1] [covers: ITEM-1, ITEM-2, ITEM-9] — the operator's log.

    #489 point 2: assert the canonical sentence appears in the refusal messages as
    actually emitted through the shipped entrypoint — from the stderr of a refused run,
    which is what the operator sees — not by reading the source. ALL FOUR reason-carrying
    refusal shapes are driven (empty-nnz, zero-barcodes, all-zero and mixed), each must
    refuse rc 2 with the canonical constant VERBATIM on stderr, no traceback, the
    `spatial.import-visium:` prefix — and each must also carry its own measured per-shape
    clause: the zero-barcodes clause states the emptiness IS visible in the stream
    (never a "byte-identical" strong claim), the empty-nnz clause states the stream and
    report ARE byte-identical to a real import, and the all-zero/mixed clauses state the
    declared counts and the missing stored-value content. `load_compute` reads the SAME
    module the subprocess runs, so the message cannot drift from the constant.

    FIX ROUND 2 hardening (R2-4): every per-shape clause is pinned to the ONE raised
    message that owns it. The `clause_signal` is a STRING THAT APPEARS ONLY in that
    shape's own new per-shape clause — the empty-nnz signal is the R2-8 qualification,
    the all-zero and mixed signals are the clause tails a pre-existing sentence cannot
    satisfy (the mixed row's old signal `no usable stored value` was already on the
    floor in the pre-existing "Refusing rather than shipping a matrix with no usable
    stored value..." sentence, so TEST-132 passed with the new mixed clause deleted).
    The single-source leg below asserts each signal occurs in EXACTLY ONE raised
    message, and the message-claim leg asserts the R2-9 operative claim is present for
    the all-zero/mixed clauses while the R2-9 gloss it replaced ("its fields are counts
    of spots, genes and positions, never values" — literally false: the report holds
    scalefactors, micron scales, affines/extents, QC metrics) is absent from their
    stderr.
    """
    module = VF.load_compute()
    canonical = getattr(module, CONSTANT)
    assert canonical, f"the compute module must define {CONSTANT}"

    # The R2-9 claim, in the operative form, and the gloss it replaced — stated at
    # module scope so the single-source leg and the stderr legs name ONE sentence.
    _REPORT_CLAIM = "nothing in the report states the matrix's stored values or their count"
    _REPORT_GLOSS = "its fields are counts of spots, genes and positions, never values"

    shapes = (
        (_empty_nnz_bundle, "t489-empty-nnz", b"are both empty",
         b"which no note field restates", b"VISIBLE in the stream", False),
        (_zero_barcodes_bundle, "t489-zero-barcodes", b"carries no barcodes at all",
         b"the emptiness is VISIBLE in the stream and in the artifacts",
         b"byte-identical to a real import", False),
        (_all_zero_bundle, "t489-all-zero", b"every one of them exactly 0",
         b"downstream analysis runs on a matrix whose every stored value is 0.)",
         None, True),
        (_mixed_bundle, "t489-mixed", b"not one of them a usable count",
         b"downstream analysis runs on a matrix with no usable stored value.)",
         None, True),
    )
    for make, name, marker, clause_signal, forbidden_signal, report_claim in shapes:
        bundle = make(tmp_path / name, name)
        out = tmp_path / f"out-{name}" / "outputs"
        result = VF.run_entry_bytes(bundle, out)
        assert result.returncode == 2, (
            f"the {name} bundle must be a NAMED refusal (rc 2); rc={result.returncode} "
            f"stderr: {result.stderr[-2000:]!r}"
        )
        assert b"Traceback" not in result.stderr, result.stderr[-2000:]
        assert _REFUSAL_PREFIX in result.stderr, result.stderr[-2000:]
        assert marker in result.stderr, (
            f"the {name} refusal lost its defect marker: {result.stderr[-2000:]!r}"
        )
        # VERBATIM in TWO byte-forms. The canonical prose carries em dashes, and under a
        # non-UTF-8 locale (LC_ALL=C etc.) CPython gives sys.stderr errors="backslashreplace"
        # (MEASURED: import_visium.py:1004), so the child emits each non-ASCII character as
        # its literal `\uXXXX` escape — the refusal still fires rc 2 with the same ASCII
        # bytes and the prefix; only the dash glyph is escaped. Accept exactly the two forms
        # the two locale regimes produce, so this pin is locale-deterministic: it still
        # asserts the WHOLE canonical sentence, never a marker or a fragment.
        assert (canonical.encode("utf-8") in result.stderr
                or canonical.encode("ascii", "backslashreplace") in result.stderr), (
            f"the {name} refusal does not state the canonical reason verbatim; expected "
            f"{canonical[:80]!r}... stderr: {result.stderr[-2000:]!r}"
        )
        assert clause_signal in result.stderr, (
            f"the {name} refusal does not carry its own measured per-shape clause "
            f"({clause_signal!r}): {result.stderr[-2000:]!r}"
        )
        if forbidden_signal is not None:
            assert forbidden_signal not in result.stderr, (
                f"the {name} refusal carries the OTHER shape's visibility claim "
                f"({forbidden_signal!r}) — the per-shape clauses must not be mixed up: "
                f"{result.stderr[-2000:]!r}"
            )
        if report_claim:
            assert _REPORT_CLAIM.encode() in result.stderr, (
                f"the {name} refusal's per-shape clause must state the operative R2-9 "
                f"claim ({_REPORT_CLAIM!r}): {result.stderr[-2000:]!r}"
            )
            assert _REPORT_GLOSS.encode() not in result.stderr, (
                f"the {name} refusal still carries the R2-9 gloss ({_REPORT_GLOSS!r}) — "
                "the report DOES hold values (scalefactors, micron scales, extents, QC "
                f"metrics), so the claim was false: {result.stderr[-2000:]!r}"
            )

    # R2-4 single-source leg: each per-shape clause is satisfied by EXACTLY ONE raised
    # message in `refuse_malformed_counts` — a second copy of a clause is the exact
    # duplication #489 measures, and a signal the pre-existing prose already satisfies
    # pins nothing. `_reason_carrying_raises` joins each raise's adjacent literals the
    # way the module runs them, so a signal split across literals is still seen.
    compute_text = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    raises, _markers = _reason_carrying_raises(ast.parse(compute_text))
    utterances = [literals for _label, literals, _interp in raises]
    for make, name, _marker, clause_signal, _forbidden, _claim in shapes:
        signal = clause_signal.decode("utf-8")
        owners = [i for i, text in enumerate(utterances) if signal in text]
        assert len(owners) == 1, (
            f"the {name} per-shape clause signal {signal!r} is satisfied by "
            f"{len(owners)} raised message(s) ({[utterances[i][:60] for i in owners]}) "
            "— it must be single-source, or TEST-132 passes while the clause is deleted "
            "or copied elsewhere"
        )


# ── the agreement half, structural ────────────────────────────────────────────────────


def _message_parts(node):
    """The (constants, interpolations) of a refusal message argument.

    `node` is the argument to `raise VisiumImportError(...)`. Returns the concatenated
    literal text and the set of `FormattedValue` expression names — so a caller can tell
    "the sentence arrives as an interpolation" from "the sentence is pasted as text".
    """
    literals = []
    interpolates = []
    if isinstance(node, ast.JoinedStr):
        for part in node.values:
            if isinstance(part, ast.Constant):
                literals.append(str(part.value))
            elif isinstance(part, ast.FormattedValue):
                value = part.value
                name = value.id if isinstance(value, ast.Name) else None
                interpolates.append(name)
            else:  # pragma: no cover — f-strings hold constants and formatted values
                pass
    elif isinstance(node, ast.Constant):
        literals.append(str(node.value))
    return "".join(literals), interpolates


def _reason_carrying_raises(tree):
    """Every raise in `refuse_malformed_counts`, as (marker_if_reason_carrying, parts).

    The subject set is DERIVED from the module's AST — never enumerated as lines. The
    four reason-carrying refusals are identified by the DEFECT markers the standing suite
    already pins (the same markers TEST-77/78/114/130 assert on stderr), so a refusal
    added tomorrow is inside the subject set the moment it is written.
    """
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "refuse_malformed_counts")
    markers = {
        "carries no barcodes at all": "Refusal A (zero barcodes)",
        "are both empty": "Refusal B (nnz == 0)",
        "every one of them exactly 0": "Refusal C (#474 all-zero)",
        "not one of them a usable count": "the #548 mixed no-usable refusal",
    }
    raises = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            call = node.exc
            if not (isinstance(call.func, ast.Name) and call.func.id == "VisiumImportError"):
                raise AssertionError("a non-VisiumImportError raise inside refuse_malformed_counts")
            args = call.args
            if not args:
                raise AssertionError("a VisiumImportError with no message inside refuse_malformed_counts")
            literals, interpolates = _message_parts(args[0])
            label = None
            for marker, name in markers.items():
                if marker in literals:
                    if label is not None:
                        raise AssertionError(f"markers {label} and {name} both match one refusal")
                    label = name
            raises.append((label, literals, interpolates))
    return raises, markers


def test_TEST_133_each_reason_carrying_refusal_INTERPOLATES_the_constant_by_name():
    """TEST-133 [acceptance, INV-1] [covers: ITEM-1, ITEM-3, ITEM-9, ITEM-12].

    The structural half of the agreement (#489 point 4): walk `refuse_malformed_counts`
    with `ast`, the way `tests/visium_refusal_sites.py` derives its own subject set. Each
    of the four reason-carrying refusals — identified by the defect markers, never by a
    line list — must interpolate `REASON_NO_USABLE_COUNTS` BY NAME as a `FormattedValue`,
    and NO raise in the function may carry the distinctive claim as LITERAL text (the
    per-shape clauses are literal, so this is what stops a clause from smuggling the
    claim as its own copy).

    This is also the mutation-proof half: delete the interpolation from one refusal (or
    paste the sentence as text) and this test goes red; the emitted-verbatim leg
    (TEST-132) reddens too if the constant's text itself is edited without the copies.
    """
    source = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    tree = ast.parse(source)

    # The constant exists, is bound at module level, and is a plain literal.
    bindings = [n for n in tree.body
                if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == CONSTANT for t in n.targets)]
    assert len(bindings) == 1, f"{CONSTANT} must be defined exactly once, found {len(bindings)}"
    value = bindings[0].value
    assert isinstance(value, ast.Constant) or isinstance(value, ast.BinOp), (
        f"{CONSTANT} must be bound to plain literals (the shape the structural refusal "
        "classifier proves safe by) — a non-literal binding would need a different proof"
    )
    constant_text = ast.literal_eval(value) if isinstance(value, ast.Constant) else None
    if constant_text is None:
        # a BinOp chain of adjacent literals — evaluate it from the AST to get the text.
        def _eval(node):
            if isinstance(node, ast.Constant):
                return node.value
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                return _eval(node.left) + _eval(node.right)
            raise AssertionError(f"{CONSTANT} must be literal-only, found {ast.dump(node)[:80]}")
        constant_text = _eval(value)
    assert _DISTINCTIVE in constant_text, (
        f"{CONSTANT} must carry the distinctive claim, which is what every copy agrees on"
    )

    raises, markers = _reason_carrying_raises(tree)
    labeled = {label for label, _literals, _interp in raises if label}
    missing = sorted(set(markers.values()) - labeled)
    assert not missing, (
        f"refuse_malformed_counts no longer raises reason-carrying refusals matching the "
        f"defect markers {missing} — either the refusal was removed or its marker prose "
        "changed (which would also break the standing TEST-77/78/114/130 pins)"
    )
    for label, literals, interpolates in raises:
        if label is not None:
            assert CONSTANT in interpolates, (
                f"{label} does not interpolate {CONSTANT} by name — it states the reason "
                "as its own private copy, which is exactly the duplication #489 measures; "
                f"interpolates={interpolates}"
            )
        else:
            # No literal-copy may carry the claim without interpolating the constant.
            assert _DISTINCTIVE not in _QUOTES_WS.sub("", literals), (
                "a refusal outside the four reason-carrying ones carries the distinctive "
                "claim as literal text — if it states the same reason, it must interpolate "
                f"{CONSTANT} like the other four; {literals[:200]!r}"
            )


# ── the agreement half, the surviving copies ──────────────────────────────────────────


def _normalized(text):
    """Whitespace/quote/`#`-free — the normalization that makes a `#`-wrapped comment
    join into one string, exactly the detector's own."""
    return _QUOTES_WS.sub("", text)


def test_TEST_134_the_surviving_copies_agree_with_the_canonical_claim():
    """TEST-134 [acceptance, INV-1] [covers: ITEM-4, ITEM-5, ITEM-6, ITEM-7, ITEM-9].

    The copies the absence scan cannot see are the ones that AGREE — a drifted copy is a
    TRUE statement in the wrong words, and the sweep would pass it. So the agreement
    legs assert the surviving copies carry the canonical sentence's distinctive claim:

      * the manifest 0.15.0, 0.17.0 and 0.20.0 changelog entries;
      * `tests/test_empty_matrix_refusal.py`'s module docstring;
      * the decision comment regions — the PREAMBLE, point 1, point 3, the SUPPORTING
        NOTE and the Refusal C comment — checked PER-REGION: each region is located by
        the source's OWN marker line, cut at the next region's marker, and must carry
        the claim itself. The one-coarse-window shape is exactly what a stale point-1
        paraphrase would pass (point 3's claim sat inside point 1's window); per-region,
        a revert of ANY single region reddens naming that region.

    Every read uses `encoding="utf-8"` EXPLICITLY — a locale-default read raises or
    mis-decodes under `LC_ALL=C` and the guard would go green on a real regression
    (#333/#339/#330). `_normalized` is the detector's own joining, so a line-wrapped
    comment copy is compared as one string.
    """
    manifest = (PKG / "manifest.yaml").read_text(encoding="utf-8")
    entries = re.split(r"^# 0\.(\d+)\.0 ", manifest, flags=re.M)
    # re.split with a capture group: [pre, "15", body, "16", body, ...] — the captured
    # group is the numeric middle segment, so 0.15.0 -> "15".
    bodies = {entries[i]: entries[i + 1] for i in range(1, len(entries) - 1, 2)}
    needle = _normalized(_DISTINCTIVE)
    for version in ("15", "17", "20"):
        assert needle in _normalized(bodies.get(version, "")), (
            f"the manifest 0.{version}.0 changelog entry does not carry the distinctive "
            f"claim — it must agree with {CONSTANT}: {'-- missing --' if version not in bodies else bodies[version][:200]}"
        )

    # TEST-134 (#624/#625): the 0.17.0 ALL-ZERO clause is re-scoped to the per-shape
    # scoped form, and its machine-readable exception states the MEASURED per-shape
    # truth: the #624 probe found ONLY `data.stored_bytes` differing for all-zero/mixed
    # (nnz and shape unchanged). The 10-structural-field machine-readable-structure-
    # record form (the stored-value count, the shapes and the byte counts among ten
    # structural fields, four of them shard geometry) belongs to the `nnz == 0` copies
    # (the 0.15.0 entry below; TEST-136 (e) pins the
    # rest per-site). FIX ROUND 1 (F1): the fuller form must NOT be pinned on the
    # all-zero clause — the probe refutes it there.
    scoped_clause = _normalized(
        "in the streamed progress and the report the operator-visible signal does not "
        "distinguish an all-zero matrix from a real one")
    assert scoped_clause in _normalized(bodies.get("17", "")), (
        "the 0.17.0 entry's all-zero clause must be the SCOPED per-shape form (#624): "
        f"{'-- missing --' if '17' not in bodies else bodies['17'][:200]}"
    )
    for part in (
        "the machine-readable difference is the expression entry's byte count",
        "`data.stored_bytes` is 19,504 B for the real fixture vs 339 B for the all-zero "
        "variant and 362 B for the mixed zero/NaN variant"):
        assert _normalized(part) in _normalized(bodies.get("17", "")), (
            f"the 0.17.0 all-zero clause must state {part!r} — the measured byte-count "
            "truth (#624): "
            f"{'-- missing --' if '17' not in bodies else bodies['17'][:200]}"
        )
    assert _normalized("the stored-value count (`nnz`) and the shape are unchanged"
                       " for both variants") in _normalized(bodies.get("17", "")), (
        "the 0.17.0 all-zero clause must state nnz and shape unchanged for "
        f"all-zero/mixed (probe: 17677 / [17677] in all three): "
        f"{'-- missing --' if '17' not in bodies else bodies['17'][:200]}"
    )
    structure_record = _normalized(
        "the manifest's expression entry differs in its machine-readable structure "
        "record (the stored-value count, the shapes and the byte counts)")
    assert structure_record not in _normalized(bodies.get("17", "")), (
        "the 0.17.0 ALL-ZERO clause must NOT carry the 10-field fuller form — the probe "
        "measured ONE differing field (`stored_bytes`) for all-zero/mixed; the fuller "
        "form belongs to the `nnz == 0` copies (#624, F1)"
    )
    assert structure_record in _normalized(bodies.get("15", "")), (
        "the manifest 0.15.0 entry (the `nnz == 0` copy) must carry the fuller 10-field "
        "machine-readable-structure-record form (#625-5): "
        f"{'-- missing --' if '15' not in bodies else bodies['15'][:200]}"
    )

    docstring = (PKG / "tests" / "test_empty_matrix_refusal.py").read_text(encoding="utf-8")
    assert needle in _normalized(docstring), (
        "the test module docstring does not carry the distinctive claim — it is one of "
        "the six copies #489 measures"
    )

    compute = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    # The comment regions are found by the source's OWN marker lines — not a line list.
    # Each region runs from its marker to the NEXT marker (or a bounded tail), so one
    # region's claim cannot cover for another's drift.
    regions = (
        ("the decision PREAMBLE (Refusal B)", "THE DECISION — REFUSE, and the reason does not depend"),
        ("the decision POINT 1", "1. THE LOAD-BEARING REASON"),
        ("the decision POINT 3", '3. "Import but disclose"'),
        ("the SUPPORTING NOTE", "SUPPORTING NOTE — the vendor material"),
        ("the Refusal C comment", "THE DECISION — REFUSE, and the reason is the SAME load-bearing"),
    )
    positions = []
    for name, marker in regions:
        pos = compute.find(marker)
        assert pos >= 0, (
            f"the source no longer carries the marker {marker!r} ({name}) — the decision "
            "comment changed shape and the per-region agreement leg is now vacuous"
        )
        positions.append((name, marker, pos))
    for i, (name, marker, pos) in enumerate(positions):
        end = positions[i + 1][2] if i + 1 < len(positions) else pos + 3500
        region = compute[pos:end]
        assert needle in _normalized(region), (
            f"the {name} (after {marker!r}) does not carry the distinctive claim — a "
            "revert of THIS copy would pass the old one-window check and is exactly what "
            "the per-region split exists to catch"
        )


# ── the non-vacuity controls: this sweep is measuring something ──────────────────────


@pytest.mark.parametrize(
    "text",
    [
        # (1) UNWRAPPED — the retracted sentence's own shape.
        _fragment("would say 'an import ", "indistinguishable from a successful ", "import'"),
        _fragment("main() has exactly two ", "outcomes — refuse or succeed"),
        _fragment("nothing in the signal the operator acts on ", "distinguishes this import"),
        # (2) WRAPPED across two source lines — a docstring's shape; the
        #     whitespace-collapse normalization (a) is what sees it.
        _fragment("which is indistinguishable\n", "    from a successful import"),
        _fragment("exactly two\n", " outcomes"),
        _fragment("nothing in the signal the operator acts on\n", "distinguishes it"),
        # (3) SPLIT across ADJACENT string literals (quote chars between the parts) —
        #     the shape the old messages shipped; the quote-free normalization (b).
        _fragment('source says: "indistinguishable from a" ', '" successful import" here'),
        _fragment('"there is no \\"succeeded with a', ' warning\\" outcome"'),
        # (4) The literal-split through THREE parts, with splits INSIDE the phrases, so no
        #     source line carries a raw contiguous fragment even here.
        _fragment('"imports into a complete', ' but " ', '"empty dataset, which is ',
                  '"indistinguishable from a successful ', 'import of a ', '"bundle with',
                  ' data in it."'),
        # (5) #-COMMENT-WRAPPED — the sentence written back as a line-wrapped comment;
        #     `#` and the space after it sit between the words, so only the
        #     `#`-stripping normalization (b) sees it.
        _fragment("# An empty matrix imports into a complete\n", "# but empty dataset, which is indistinguishable\n",
                  "# from a successful import of a bundle with\n", "# data in it."),
        _fragment("# main() has exactly two outcomes\n", "# and succeeds — no warning outcome\n"),
        _fragment("# nothing in the signal the operator acts on\n", "# distinguishes it from a real one.\n"),
        # (5b) #359 — the retracted DESTINATION claim in the shapes the old sentence
        #      shipped (unwrapped, wrapped, literal-split, `#`-comment-wrapped).
        _fragment("That is issue ", "#160, and picking one bin here would "),
        _fragment("the old message said 'That is issue\n", "#160' and picking one bin here"),
        _fragment('msg = "That is issue ', '#160, and picking one bin here', '" would hide the gap"'),
        _fragment("# the old binned_outputs refusal said: That is issue\n",
                  "# #160, and picking one bin here — corrected.\n"),
    ],
)
# TEST-4 (#359): the text-shape battery now covers the #359 destination claim too —
# unwrapped, wrapped, adjacent-literal split and `#`-comment-wrapped (per TESTS.md).
def test_TEST_135_the_detector_CATCHES_every_shape_of_the_forbidden_phrases(text):
    """TEST-135 [positive control] — a detector that found nothing would pass the
    acceptance test vacuously, and a whitespace-only normalization would pass it on the
    string-literal split this package actually shipped. The #359 destination claim is
    in the battery in all four source-text shapes; the corrected message's own true
    clauses live in the negative control below."""
    assert _contains_forbidden(text), (
        f"the detector did not flag this shape of the forbidden phrase: {text!r}"
    )


@pytest.mark.parametrize(
    "source",
    [
        # (6) BACKSLASH LINE-CONTINUATION inside one string literal — the parser folds
        #     the two halves INTO one literal, so only the decoded-runtime-value pass (c)
        #     sees it; both text normalizations keep the backslash and stay silent.
        _fragment('s = "indistinguishable from a \\\n', 'successful import"\n'),
        # (7) `+`-CONCATENATION — two literals joined at runtime; the constant-fold pass
        #     folds the BinOp for the check (parenthesised so the line break is legal
        #     Python — a bare `+` at line start is a SyntaxError, not a hiding shape).
        _fragment('s = ("indistinguishable from a "\n', '+ "successful import")\n'),
        # (8) `\x20` ESCAPE between the words — the source has no space at all; only the
        #     decoded runtime value carries the phrase.
        _fragment('s = "nothing in the signal the operator acts on\\x20', 'distinguishes it"\n'),
        # (9) `\u0020` ESCAPE between the words — the same shape, unicode spelling.
        _fragment('s = "exactly two\\u0020', 'outcomes"\n'),
        # (10) YAML double-quoted scalar with a BACKSLASH-CONTINUATION — the YAML
        #      decoder folds the continuation; the source text levels stay silent.
        _fragment('prose: "complete but \\\n', ' empty dataset"\n'),
        _fragment('prose: "nothing in the signal the operator acts on \\\n',
                  'distinguishes it"\n'),
        # (11) `%`-FORMAT with one literal operand — `"a %s" % "b"`; the runtime value
        #      is the assembled phrase, the source has `%s` between the words, so only
        #      the folded-BinOp pass (c) sees it.
        _fragment('s = "indistinguishable from a %s" % "successful import"\n'),
        # (12) `%`-FORMAT with a 2-TUPLE operand — `"%s %s" % ("a", "b")`; the fold
        #      recurses into the tuple elements.
        _fragment('s = "%s %s" % ("indistinguishable from a", ', '"successful import")\n'),
        # (13) `%`-FORMAT, NESTED — the outer operand is itself a `%`-format, so the
        #      fold must recurse into tuple elements; neither half alone is the phrase.
        _fragment('s = "%s %s" % ("indistinguishable from a", ',
                  '"%s" % "successful import")\n'),
        # (14) `%`-FORMAT with a literal DICT (the `%(name)s` spelling) — same class.
        _fragment('s = "%(a)s %(b)s" % {"a": "indistinguishable from a", ',
                  '"b": "successful import"}\n'),
        # (15) YAML MULTI-DOCUMENT stream — the escape sits in the SECOND document, and
        #      a single `yaml.safe_load` refuses the whole two-document stream
        #      (ComposerError, measured) while `safe_load_all` walks both documents; the
        #      source text levels stay silent.
        _fragment('prose: "plain"\n---\nprose: "nothing in the signal the operator acts on \\\n',
                  'distinguishes it"\n'),
        # (15b) #359 — the destination claim in the DECODE shapes: the runtime value is
        #       assembled only by folding/escaping/concat/format/YAML-decode, so both
        #       text normalizations stay silent by construction.
        _fragment('s = "That is issue \\\n', '#160 and picking one bin here"\n'),
        _fragment('s = ("That is issue "\n', '+ "#160 and picking one bin here")\n'),
        _fragment('s = "That is issue\\x20', '#160 and picking one bin here"\n'),
        _fragment('s = "%s %s" % ("That is issue", ', '"#160 and picking one bin here")\n'),
        _fragment('prose: "plain"\n---\nprose: "That is issue \\\n',
                  '#160 and picking one bin here"\n'),
    ],
)
# TEST-5 (#359): the decode-shape battery now covers the #359 destination claim too —
# backslash continuation, `+`-concat, `\x20` escape, `%`-format 2-tuple and a
# second-document YAML escape (per TESTS.md).
def test_TEST_135_the_detector_CATCHES_decode_shapes_the_text_levels_cannot_see(source):
    """TEST-135 [positive control] — the fix-round-1/2 evasion battery. Each of these
    source shapes yields the EXACT forbidden runtime string while both text
    normalizations stay silent, which is the defeat the AST/YAML passes exist to close:
    without them, a backslash-continuation or escape-split reintroduction would pass
    TEST-131 green while the running module emitted the forbidden phrase verbatim.

    The silence half is asserted, not claimed: `_text_level_hits` is the source-byte
    half of the detector alone, and a decode shape that the text levels DID see would
    make this case a plain text hit rather than a decode shape (R2-7). New with FIX
    ROUND 2: `%`-format (single literal, 2-tuple, nested, `%(name)s` dict) and a
    second-document YAML escape — both measured to escape the round-1 detector while
    TEST-131 stayed green (Angle-B/Opus F1, R2-1/R2-2). This node (#359) adds the same
    five shapes for the destination claim.
    """
    assert _text_level_hits(source) == set(), (
        f"this case is supposed to be a DECODE shape (the two text normalizations stay "
        f"silent), but the source text already carries the phrase: {source!r}"
    )
    if source.startswith("prose:"):
        assert _fragment("complete but empty dataset") in _yaml_value_hits(source) or \
            _fragment("nothing in the signal the operator acts on distinguishes") in _yaml_value_hits(source) or \
            _fragment("That is issue ", "#160") in _yaml_value_hits(source), (
            f"the YAML value pass did not flag this shape: {source!r}"
        )
    else:
        assert _source_runtime_hits(source), (
            f"the runtime-value pass did not flag this shape: {source!r}"
        )


@pytest.mark.parametrize(
    "source",
    [
        # (16) f-string `{chr(32)}` — the runtime pass does NOT evaluate calls, so this
        #      documented escape is NOT caught. Asserted [] so the ceiling stays honest
        #      and the gap stays measured rather than assumed.
        _fragment('s = f"indistinguishable from a{chr(32)}', 'successful import"\n'),
        # (17) `"".join(...)` — the same call-built class.
        _fragment('s = "".join(["indistinguishable from a ", ', '"successful import"])\n'),
        # (18) `%`-FORMAT whose operand is a VARIABLE — the fold is literal-only, so
        #      this is the same call/variable-built ceiling, now named by R2-3.
        _fragment('s = "indistinguishable from a %s" % value\n'),
        # (19) f-string interpolating a NAME — `{x}` is not a constant the fold can
        #      replace, so the assembled value is unreachable for the detector.
        _fragment('s = f"nothing in the signal the operator acts on {x}',
                  'distinguishes it"\n'),
        # (20) VARIABLE-MEDIATED `+` — one operand is a name, so neither the text levels
        #      nor the fold see the assembled phrase.
        _fragment('a = "nothing in the signal the operator acts on "\n',
                  's = a + "distinguishes it"\n'),
        # (21) `+=` — the same assembly, in its augmenting spelling.
        _fragment('s = "nothing in the signal the operator acts on "\n',
                  's += "distinguishes it"\n'),
    ],
)
def test_TEST_135_the_documented_call_built_ceiling_is_NOT_caught(source):
    """TEST-135 [documented ceiling, negative control] — the residual is ANY assembly
    whose runtime value needs code the detector does not execute: a string built by a
    CALL (`f"{chr(32)}"`, `"".join(...)`, `%` with a variable operand), an f-string
    interpolating a NAME, a variable-mediated `+`, `+=`. None of these is inside the
    detector's guarantee: the AST Constants pass and the constant-fold see only literal
    operands. This control asserts each gap EXACTLY as documented (no overclaim), and
    the residual is tracked as https://github.com/tinnlab/txresbench/issues/614."""
    assert _source_runtime_hits(source) == [], (
        f"the {source!r} shape was caught — update the ceiling, this changes the guarantee!"
    )


# TEST-6 (#359): the negative controls — the corrected message's TRUE clauses and the
# comment's #160-in-HISTORY retirement record must match NONE of the eight fragments
# (per TESTS.md).
def test_TEST_135_the_detector_does_NOT_flag_the_TRUE_claim_or_clean_prose():
    """TEST-135 [positive control] — the sweep must stay scoped to the RETRACTED reason,
    the #503 OVERSTATEMENT, the FIX-ROUND-1 absolute and the #359 retracted DESTINATION
    claim; the TRUE scoped claims and
    ordinary clean prose are exactly what the corrected message, comments, docstring and
    changelog now carry, so flagging them would make the sweep unshippable and would be
    a false positive on the fix.

    The no-false-match cases are asserted explicitly because they are the ones a naive
    fragment list gets wrong: "exactly two DESIGNED outcomes" must not match "exactly two
    outcomes" — under EITHER normalizations AND as a decoded runtime value — the
    operator-visible-signal form the per-shape clauses use must not match the recovered
    absolute, and the comma-bearing true phrasing of the adjacent comment must not match
    the comma-less forbidden phrase. The #359 half is the class-rule carve-out in action:
    the corrected message's true clauses and the retirement record's `#160`-as-HISTORY
    sentence are what the fix ships, so they must match none of the eight.
    """
    module = VF.load_compute()
    true_claim = getattr(module, CONSTANT)
    assert _contains_forbidden(true_claim) == [], (
        f"the canonical sentence itself carries a forbidden fragment: {true_claim}"
    )
    assert _source_runtime_hits(
        f"REASON_NO_USABLE_COUNTS = {true_claim!r}") == [], (
        "the canonical sentence's DECODED runtime value carries a forbidden fragment"
    )
    assert _contains_forbidden(
        "`main()` has exactly two DESIGNED outcomes — refuse (`sys.exit(2)`) or succeed") == []
    assert _contains_forbidden(
        "Imports into a complete, coherent, empty dataset otherwise.") == []
    assert _contains_forbidden("a plausible wrong answer rather than an error") == []
    assert _contains_forbidden(
        "the operator-visible signal does not distinguish this shape from a real import") == []
    assert _contains_forbidden(
        "the streamed progress is byte-identical to a real import of this bundle") == []
    assert _contains_forbidden(
        "progress: matrix|15|0 spots x 150 genes and progress: coordinates|65|0 spot positions") == []
    assert _contains_forbidden(
        "the report states n_spots: 0 and the manifest's expression entry carries structure.nnz: 0") == []
    assert _contains_forbidden(
        "reported as SUCCESS at exit 0 with no outcome reported to the operator as "
        "anything other than SUCCESS") == []
    # FIX ROUND 2's reworded clauses: the R2-8 qualification, the R2-9 operative claim
    # and the R2-6 scoping parenthetical are all TRUE prose the sweep must not flag.
    assert _contains_forbidden(
        "the manifest's expression entry differs in its machine-readable structure "
        "record (the stored-value count, the shapes and the byte counts), which no note "
        "field restates") == []
    assert _contains_forbidden(
        "nothing in the report states the matrix's stored values or their count") == []
    assert _contains_forbidden(
        "16 outputs on this node's committed fixture; `len(entries)`, one per emitted "
        "artifact and per vendor image, so bundle-dependent") == []
    assert _contains_forbidden(
        "in the streamed progress and the report the operator-visible signal does not "
        "distinguish this shape from a real import") == []
    # #359 — the corrected message's TRUE clauses (the ones #359's corrected text keeps)
    # and the retirement record's history citation of the CLOSED #160. None may match
    # any of the eight fragments; the #160-in-history mention is the carve-out itself.
    assert _contains_forbidden(
        "Import it with `Import Visium HD (Space Ranger binned_outputs)` instead") == []
    assert _contains_forbidden(
        "picking one bin here would hide the platform gap rather than close it") == []
    assert _contains_forbidden(
        "it needs a per-bin upload or a directory-aware matcher") == []
    assert _contains_forbidden(
        "A previous version of this message pointed its reader at #160 — which CLOSED "
        "without ever shipping an importer (measured 2026-09-26), so the pointer "
        "outlived the issue it pointed to — and the reader is now told to import it "
        "with `Import Visium HD (Space Ranger binned_outputs)` instead. #160 is named "
        "here as HISTORY, never as a destination") == []


def test_TEST_135_the_sweep_and_self_exclusion_are_non_vacuous():
    """TEST-135 [positive control] — the scan must see the files the fix actually
    touched (the compute message and the manifest changelog) and must exclude exactly
    one existing file: itself.

    A walk pointed at the wrong root, a suffix filter gone wrong or a broken read would
    make the acceptance test above vacuously green while the forbidden sentence stayed in
    the product — the exact failure mode the `encoding="utf-8"` requirement and this
    coverage leg exist to expose.
    """
    files = scanned_files()
    assert files, "the package scan enumerated no files at all"
    assert len(files) >= 30, (
        f"only {len(files)} .py/.yaml files were scanned (floor 30) — the sweep is not "
        "reading the package tree it claims to"
    )
    assert "compute/import_visium.py" in files, (
        "the compute module carrying the refusal message is not scanned — the sweep "
        "cannot be the acceptance test for the correction if it never reads the message"
    )
    assert "manifest.yaml" in files, (
        "the manifest changelog is not scanned — a reworded entry could quote the false "
        "sentence and the sweep would not see it"
    )
    assert SELF.endswith(".py") and (PKG / SELF).is_file(), (
        f"SELF is {SELF!r}, which is not an existing .py file — the exactly-one "
        "self-exclusion inside `scanned_files` would be vacuous"
    )
    assert SELF not in files, f"the self-exclusion did not remove {SELF} from the scan"


def test_TEST_136_the_claim_accuracy_honesty_clauses_stay_pinned():
    r"""TEST-136 (#615/#624/#625) — the corrected honesty clauses are pinned where they
    live, so the prose cannot silently drift back to the overclaim the issues filed.

    (#625-1..4 plus the #625-5 wording and the #625-6 caveat are all file-level prose,
    and this file is SELF-excluded from the package sweep, so the absence detector can
    never see a regression of THIS file's own honesty clauses — the pin reads them back
    with explicit `encoding="utf-8"` and asserts the now-honest forms are present and
    the old overclaiming forms are gone. #625-6's caveat lives in the manifest 0.20.0
    entry and is asserted here too; #625-5's six claim-carrying sites are asserted
    PER-SITE — each site individually, never once per file — and the old single-field
    "one artifact difference" wording is asserted ABSENT at each of them, with the
    deliberate quoted mentions in the 0.22.0 entry and TEST-14's history docstring
    outside the check.)
    """
    this_doc = (PKG / SELF).read_text(encoding="utf-8")
    manifest_text = (PKG / "manifest.yaml").read_text(encoding="utf-8")
    # The MODULE docstring (not this function's own source, which quotes the old forms in
    # its assertions and would otherwise fail the absence checks below): `ast` reads it
    # back from the parsed module, so a future edit that moves a clause OUT of the
    # docstring reddens here.
    doc = _normalized(ast.get_docstring(ast.parse(this_doc)) or "")

    # (a) #625-1 — the known-ceiling sentence names the SIX pinned NOT-caught controls
    # EXPLICITLY (never as "the call-built assemblies", which would re-assert coverage
    # of `.format(...)` — a call-built shape with NO control), and states that
    # `.format(...)` plus the rest of the class (hyphenation, inserted comma,
    # capitalisation, NEW paraphrase, non-string content) is named but NOT pinned by a
    # control. FIX ROUND 1 (F3): the explicit six-shape naming and the `.format(...)`
    # unpinned clause.
    assert _normalized(
        'Six of those shapes are pinned below as NOT caught — `f"{chr(32)}"`, '
        '`"".join(...)`, a `%`-format whose operand is a variable, an f-string '
        'interpolating a NAME, a variable-mediated `+` and `+=` (items (16)-(21));'
    ) in doc, (
        "the known-ceiling sentence must name the six pinned NOT-caught controls "
        "explicitly — the call-built class alone would mis-assign `.format(...)` "
        "(#625-1, F3)"
    )
    assert _normalized(
        '`.format(...)` (also a call-built shape, but NOT one of the six pinned controls)'
    ) in doc, (
        "the known-ceiling sentence must name `.format(...)` as call-built but unpinned "
        "(#625-1, F3)"
    )
    full = _normalized("so the ceiling is stated AND measured")
    assert full not in doc, (
        "the known-ceiling sentence must not claim the unpinned residual shapes are "
        "measured (#625-1)"
    )
    assert _normalized("is named but NOT pinned by a control") in doc, (
        "the known-ceiling sentence must name the rest of the class as unpinned (#625-1)"
    )

    # (b) #625-3 — the docstring's closing-line claim carries the fixture-scoping and
    # len(entries) note every shipped copy got.
    assert _normalized("all of them on this node's committed fixture; the count in that"
                       " line is `len(entries)`") in doc, (
        "the closing-line claim must be scoped to this node's committed fixture and the "
        "len(entries) bundle-dependence (#625-3)"
    )

    # (c) #625-2 + #625-4 — the not-scanned basis names the prose-bearing member and the
    # deliberate exclusion, and the sentence is grammatical (no dangling "and in the
    # durable prose files").
    assert _normalized("`PROVENANCE.json` is the exception — 29 KB of narrative notes "
                       "and attribution, i.e. prose") in doc, (
        "the not-scanned section must name PROVENANCE.json as narrative prose (#625-2)"
    )
    assert _normalized("excluded as a DELIBERATE scope choice, not on the false basis"
                       " that it cannot carry prose") in doc, (
        "the not-scanned section must state the REAL reason prose-bearing JSON is "
        "excluded (#625-2)"
    )
    dangling = _normalized("so the scan says what it scans and in the durable prose files")
    assert dangling not in doc, (
        "the not-scanned section's reason sentence must be grammatical (#625-4)"
    )
    assert _normalized("not about the fixture provenance record") in doc, (
        "the not-scanned section must state what surface the claim is about (#625-4)"
    )

    # (d) #625-6 — the manifest 0.20.0 entry's "every string leaf" clause carries the
    # unparsable-document caveat.
    assert _normalized("a document its stream cannot parse ends the pass — PyYAML cannot"
                       " resynchronise — so the remaining documents are skipped") in \
        _normalized(manifest_text), (
        "the 0.20.0 changelog's every-string-leaf clause must state the unparsable-"
        "document caveat (#625-6)"
    )

    # (e) #625-5 — PER-SITE, not per-file: each of the six claim-carrying sites states
    # its SHAPE-TRUE form — the five `nnz == 0` copies carry the 10-field fuller
    # machine-readable-structure-record form, the 0.17.0 all-zero clause states the
    # measured byte-count-only truth (the probe: only `data.stored_bytes` differs;
    # nnz and shape unchanged) — and NOT one of them carries the old single-field
    # "one artifact difference" wording. The deliberate QUOTED mentions of the old
    # phrase (the 0.22.0 entry's correction record, TEST-14's history docstring) are
    # references, not claim sites, and are outside the check.
    compute_text = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    empty_src = (PKG / "tests" / "test_empty_matrix_refusal.py").read_text(encoding="utf-8")
    empty_doc = _normalized(ast.get_docstring(ast.parse(empty_src)) or "")
    fuller = _normalized(
        "the manifest's expression entry differs in its machine-readable structure "
        "record (the stored-value count, the shapes and the byte counts)")
    byte_only = (
        "the machine-readable difference is the expression entry's byte count",
        "`data.stored_bytes` is 19,504 B for the real fixture vs 339 B for the all-zero "
        "variant and 362 B for the mixed zero/NaN variant")
    old = _normalized("one artifact difference")

    def _site(label, region, expects):
        n = _normalized(region)
        for ex in expects:
            assert _normalized(ex) in n, (
                f"the {label} site does not state its shape-true form {ex!r} (#625-5)")
        assert old not in n, (
            f"the {label} site carries the old single-field claim (#625-5, F2)")

    comp = compute_text
    comment_site = comp[comp.find("in the stream and the report the operator-visible signal"):
                        comp.find("in the stream and the report the operator-visible signal") + 700]
    msg_site = comp[comp.find("are both empty"):comp.find("# REFUSAL C")]
    man = manifest_text
    s15_site = man[man.find("0.15.0 — #345/#451/#445"):man.find("0.16.0 — #462")]
    s17_site = man[man.find("0.17.0 — #474/#478/#505/#506/#517"):man.find("0.17.1 — #453")]
    _site("compute SUPPORTING-NOTE comment", comment_site, (fuller,))
    _site("compute nnz == 0 refusal MESSAGE", msg_site, (fuller,))
    _site("this module's docstring", doc, (fuller,))
    _site("test_empty_matrix_refusal.py docstring", empty_doc, (fuller,))
    _site("the manifest 0.15.0 `nnz == 0` entry", s15_site, (fuller,))
    _site("the manifest 0.17.0 ALL-ZERO clause", s17_site, byte_only)
    # The shipped `nnz == 0` message keeps its pinned marker and clause tail.
    assert "no note field restates" in compute_text, (
        "the nnz == 0 message must keep its agreement clause tail (#625-5)"
    )


# ── TEST-137 (#638): the three non-emitted residual sites stay corrected ──────────────


# TEST-4 (#638): this node's honesty pin for #638 sites 1/2/3 (per TESTS.md).
def test_TEST_137_the_638_residual_sites_stay_corrected():
    r"""TEST-137 (#638) — the three NON-EMITTED #638 sites are pinned where they live,
    so the prose cannot drift back to the vendor-claim overclaim the issue filed.

    #638 item 1 and item 2 live in the compute module (the mixed message's head and
    the decision comment's vendor claim), item 3 lives in THIS module's neighbour — the
    `test_empty_matrix_refusal.py` module docstring — and none of the three is emitted
    stderr, so the TEST-1 (mixed) / TEST-2 / TEST-3 (HD) byte-asserts cannot see a
    regression of them. Each is read back with explicit `encoding="utf-8"` (the locale
    rule this tree has closed four times) and asserted for the corrected form present /
    the old form gone (whitespace/quote-normalized exactly like this file's own
    detector, `_normalized`). The old-form TOKENS are quoted in this function's own
    assertion needles — that is safe ONLY because this pin never reads this file: the
    checked texts are the compute module and `test_empty_matrix_refusal.py`'s module
    docstring, so the quoted old forms are outside every checked text and cannot
    satisfy or defeat the absence checks (contrast TEST-136, whose check DOES read
    its own module docstring and must therefore keep the old forms out of it).
    """
    compute_text = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    empty_src = (PKG / "tests" / "test_empty_matrix_refusal.py").read_text(encoding="utf-8")
    empty_doc = _normalized(ast.get_docstring(ast.parse(empty_src)) or "")

    # (#638 site 1) the mixed message's head: the inferred reading is stated, the
    # vendor-wide settled fact is gone.
    assert _normalized("a matrix of real read counts produces") in _normalized(compute_text), (
        "the mixed refusal must state the block's inferred reading (#638 site 1)"
    )
    assert _normalized("a well-formed 10x Space Ranger matrix produces") not in \
        _normalized(compute_text), (
        "the mixed refusal must not state the vendor-wide settled fact (#638 site 1)"
    )

    # (#638 site 2) the decision comment's vendor claim: corrected in place — no
    # measurement in this tree supports a vendor-wide claim — and the old claim is gone.
    assert _normalized("measurement in this tree supports a vendor-wide claim") in \
        _normalized(compute_text), (
        "the decision comment must state that no measurement supports a vendor-wide "
        "claim (#638 site 2)"
    )
    assert _normalized("Space Ranger never emits NaN") not in _normalized(compute_text), (
        "the decision comment must not carry the vendor-wide settled claim (#638 site 2)"
    )

    # (#638 site 3) the Refusal-B docstring's closing-line claim: the fixture-scoping /
    # len(entries) note is present and the bare form is gone.
    assert _normalized(
        "this node's committed fixture; the count in that line is `len(entries)`"
    ) in empty_doc, (
        "the Refusal-B docstring claim must be scoped to this node's committed fixture "
        "and the len(entries) bundle-dependence (#638 site 3)"
    )
    assert _normalized("16 outputs") in empty_doc, (
        "the Refusal-B docstring claim must state the measured visium closing-line count "
        "(#638 site 3)"
    )
    assert _normalized("bundle-dependent") in empty_doc, (
        "the Refusal-B docstring claim must state the bundle-dependence of the count "
        "(#638 site 3)"
    )
    assert _normalized("or full (MEASURED),") not in empty_doc, (
        "the Refusal-B docstring claim must not be the bare unscoped form (#638 site 3)"
    )


# ── TEST-140 (#359): the ITEM-2 retirement-record comment stays corrected ──────────────


# TEST-3 (#359): this node's honesty pin for ITEM-2's corrected comment (per TESTS.md).
def test_TEST_140_the_359_refusal_citation_sites_stay_corrected():
    r"""TEST-140 (#359) — the comment surface the runtime pin cannot see, pinned where
    it lives.

    TEST-1 asserts the EMITTED refusal message and the package sweep (TEST-131) forbids
    the DESTINATION sentence — but neither can see a regression of the comment above the
    refusal: the comment is never emitted, and the forbidden fragment is the destination
    sentence, not the comment's stale naming claim. So a revert of ITEM-2 alone (the
    comment goes back to "Naming it here is what stops #160's gap being rediscovered
    as a bug" while the message stays corrected) reddens NOTHING else — this pin closes
    exactly that gap, the #638 ITEM-13 / TEST-137 discipline: an explicit
    `encoding="utf-8"` read of `compute/import_visium.py` ONLY (never this pin's own
    file, so the quoted old forms cannot satisfy—or defeat—the checks), `_normalized`
    like this file's own detector.

    Asserts: the retirement record is present (`pointed its reader at #160`, `HISTORY`,
    `never as a destination` — #160 named as history, per INV-1's carve-out) and the OLD
    comment claim is ABSENT. TEST-1 owns the EMITTED refusal form at runtime; this pin
    covers the comment's retirement record and the old claim's absence.
    """
    compute_text = (PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")

    # The retirement record, present (the #160-in-HISTORY citation the class rule's
    # carve-out allows — it is a citation, never a destination).
    assert _normalized("pointed its reader at #160") in _normalized(compute_text), (
        "the comment must record that a previous version of the message pointed its "
        "reader at #160 — the retirement record is the corrected-rather-than-removed half"
    )
    assert _normalized("named here as HISTORY") in _normalized(compute_text), (
        "the comment must name #160 as HISTORY (a closed issue cited as history, never "
        "as a destination)"
    )
    assert _normalized("never as a destination") in _normalized(compute_text), (
        "the comment must state #160 is never a destination — the class rule's own "
        "carve-out"
    )
    # The OLD comment claim, ABSENT (the false sentence ITEM-2 replaces).
    assert _normalized("Naming it here is what stops #160's gap") not in _normalized(
        compute_text), (
        "the old comment claim ('Naming it here is what stops #160's gap being "
        "rediscovered as a bug.') is back in the compute source — ITEM-2's replacement "
        "did not land"
    )
