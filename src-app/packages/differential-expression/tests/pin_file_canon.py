"""The canonical-bytes precondition, PYTHON side (#192 rounds 2-4, inverted by #214).

## What this holds together, and how much of it is left

One text file — an env recipe's `requirements.txt` — was parsed by ELEVEN programs — ten
written here plus `uv`, the python recipe's installer, which this repository cannot
remove. #214 reduced that to **two we write** (the Rust build gate, which exports its
parse for everyone else to read, and the recipe's own R installer, which runs inside the
image and cannot read that export) plus `uv`, the python lane's third-party installer. This
module is what holds those implementations to one rule; it is no longer a precondition
draped over eight readers.

**It is not itself a parser.** It extracts no pin data and has no line rule, no comment rule
and no token rule. It counts `\\n` only so a refusal can name a line.

## AN ALLOWLIST, NOT A FORBIDDEN SET

Rounds 2, 3 and 4 of #192 each WIDENED a set of forbidden characters — NBSP, then a lone
CR, then U+000B, then U+001C — and each widening was correct and insufficient. Round 4
arrived at "control or whitespace, minus SPACE/TAB/LF", the union of three languages'
notions of a separator, and called the class closed.

A blind audit of #214 walked through the next door. Rust's `char::is_control()` is category
`Cc` only, so the whole `Cf` FORMAT class passed: U+FEFF, U+200B, U+00AD, U+2060, and the
bidi overrides behind Trojan Source (CVE-2021-42574). One zero-width space in
`#<ZWSP>txr:pin-source=` makes the directive *inert* while leaving it visibly present — in
the pin file and in the generated artefact a human reviews.

**A forbidden set fails OPEN on everything nobody thought of, and this class has produced
one new member per audit round.** So the polarity is inverted rather than the set widened a
fifth time:

> A pin file may contain PRINTABLE ASCII, SPACE, TAB, LF, and the small allowlist of
> non-ASCII characters its own prose actually uses. Everything else is refused BY DEFAULT.

That refuses every control, every format character, every exotic space, every homoglyph and
every character Unicode has not defined yet — and it cannot decay, because a character
added to Unicode tomorrow is outside the allowlist on the day it is first used.

The cost is deliberate: adding a decorative character to a pin file's prose costs a line in
three places. `docs/design/derived-guards.md` §4 sanctions exactly that shape — an edit only
when a covered entry changes, never on an addition.

## The three implementations are held together mechanically

  * the Rust gate: `processor_manifest.rs::PIN_FILE_ALLOWED_NON_ASCII`;
  * the R installer: `txr_allowed_non_ascii` in the recipe's Dockerfile;
  * this module.

`the_two_readers_allow_exactly_the_same_non_ascii_characters` (Rust ⇄ R) and
`test_all_three_readers_allow_the_same_characters` (python ⇄ R ⇄ Rust) read the other two
out of their source, so a divergence between any pair reddens a test rather than shipping.
"""
from pathlib import Path

#: The ONLY non-ASCII characters a pin file may contain — the decorative ones its prose
#: uses. Kept in lockstep with the Rust gate and the R installer by the cross-check tests.
ALLOWED_NON_ASCII = frozenset("§—→─")

#: The whitespace a pin file may contain. Everything else that any of the three languages
#: treats as a separator, a line ending or a control is outside the allowlist by default.
_ALLOWED_WHITESPACE = frozenset(" \t\n")


def is_allowed(ch: str) -> bool:
    """The rule, in one expression: printable ASCII, SPACE/TAB/LF, or an allowlisted
    decorative character."""
    return (
        ch in _ALLOWED_WHITESPACE
        or ("\x21" <= ch <= "\x7e")
        or ch in ALLOWED_NON_ASCII
    )


def forbidden_codepoints(limit: int = 0x110000) -> set[int]:
    """Every codepoint the rule refuses, materialised — used by the cross-check tests.

    Derived from `is_allowed`, so it cannot drift from the rule it describes.
    """
    return {cp for cp in range(limit) if not is_allowed(chr(cp))}


def assert_canonical(path: Path) -> None:
    """Refuse a pin file containing any character outside the allowlist.

    Reads with `read_bytes()` and decodes explicitly: `read_text()` applies universal
    -newline translation, which would launder a lone CR into an LF before this check ever
    saw it — the same laundering that made the R suite's own canonicality assertion vacuous
    until #214 found it still in place after round 4 reported it fixed.
    """
    text = path.read_bytes().decode("utf-8")
    for i, ch in enumerate(text):
        if not is_allowed(ch):
            line = text[:i].count("\n") + 1
            allowed = ", ".join(f"U+{ord(c):04X} {c}" for c in sorted(ALLOWED_NON_ASCII))
            raise AssertionError(
                f"{path.name} line {line}: character U+{ord(ch):04X} is not permitted. A "
                f"pin file may contain printable ASCII, SPACE, TAB, LF, and only these "
                f"non-ASCII characters: {allowed}. Everything else is refused BY DEFAULT, "
                "because the programs that parse this file are written in different "
                "languages that do not agree about which exotic bytes separate tokens or "
                "end lines, and because a character a human reviewer cannot see is one "
                "they cannot review. Four audit rounds widened a list of FORBIDDEN "
                "characters and each widening was correct and insufficient; this is the "
                "other polarity. If you genuinely need this character in prose, add it to "
                "`ALLOWED_NON_ASCII` here AND to `PIN_FILE_ALLOWED_NON_ASCII` in the build "
                "gate AND to `txr_allowed_non_ascii` in the R recipe — two cross-check "
                "tests hold the three lists to each other."
            )
