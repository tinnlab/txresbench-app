"""The build gate's EXPORTED PARSE of every env recipe's pin file — the reader (#214).

## What this replaces, and why it is not another parser

`src-app/env-rootfs/<id>/requirements.txt` was parsed by ELEVEN programs — ten written here
plus `uv`, the python recipe's installer, which is a parser this repository cannot remove:
the Rust build gate, the smoke-correspondence guard, the R installer, the R regime suite,
two python guards in `differential-expression`, and four more readers in other packages'
suites. Nothing held their grammars together. Four audit rounds on #192 each produced three
demonstrated exploitable defects, and every one was a disagreement between two of those
grammars about which bytes separate tokens or end lines:

  * `#<NBSP>txr:pin-source=` — a directive to the Rust gate, prose to the R installer;
  * a lone CR — a comment fragment to every Rust and Python reader, a whole directive line
    to the one program that installs;
  * `U+000B` — excluded by `is_ascii_whitespace`, included by POSIX `[[:space:]]`;
  * `U+001C` — `str.splitlines()` breaks on it and `str.isspace()` is true, where Rust says
    false. One of them, placed before a real pin, made the gate and the installer read a
    COMMENT — the package absent, never installed — while `_pins()` counted the full set
    and the whole python suite stayed green, INCLUDING the frozen pin-count floor and the
    smoke correspondence, the two guards whose entire purpose is to make a silent pin
    removal impossible.

The repair is not a better predicate over text; four rounds of that is the evidence. The
build gate parses the file ONCE and exports the result, and this module reads that export.

**Nothing in this file splits a line, strips a comment or splits a token.** Its entire
contact with pin-file bytes is: `hashlib.sha256`, slicing at coordinates the artefact
carries, and `bytes.decode` of one such slice to compare a field. Everything else it reads
is JSON, through `json.loads`. Read `docs/design/pin-file-single-parse.md` before adding anything
else to it.

**That claim is now literally true, and it took two goes to make it so.** An earlier version
verified rows by SEARCHING the file for `<raw_name>==<version>`; closing two real defects
gave that search a head anchor (a line rule) and a tail anchor (a comment rule), at which
point it held two of the three properties that define a parser — inside the module whose
whole job is to have none. It is now `raw[offset:offset+length]` hashed against a recorded
digest, with the coordinates supplied by the single parser. There is nothing left to anchor
because there is nothing left to find.

## The one thing you may do to pin-file bytes

Hash them. `assert_fresh()` digests the pin file and compares against the
`pin_file_sha256` the artefact records, because this module runs under `just check-py` —
pytest, with no cargo anywhere near it — so the build's own freshness gate is not in the
loop. Without that check a stale artefact would let the python gates stay green over a pin
file that had changed underneath them, which is the original defect wearing a new hat,
invented by the very design that removed it.

A digest is admissible where a parse is not because a digest has no line rule, no comment
rule and no token rule: there is nothing in it for two readers to disagree about.

## Absence is a REFUSAL, never a skip

Every function here raises when the artefact is missing, malformed, of an unknown schema
version, or stale. `docs/design/derived-guards.md` §3: *"A skip is a skip, never a pass: a
guard that quietly no-ops is the vacuous-green failure in a different costume."* That rule
is the reason the artefact is COMMITTED rather than built — a built-only artefact's
realistic pytest handling is a skip.
"""
import hashlib
import json
from pathlib import Path

#: The artefact, at the recipe-tree ROOT. Never inside a recipe directory: a recipe is
#: deliberately two files, because the rootfs freshness key hashes only the Dockerfile and
#: the build gate watches exactly `{Dockerfile, requirements.txt}` — so a third file in a
#: recipe directory would be invisible to both.
ARTEFACT_NAME = "env-pins.generated.json"

#: The pin file each recipe ships. Named here ONLY to locate it for the freshness digest;
#: nothing in this module reads its content as text.
PIN_FILE_NAME = "requirements.txt"

#: The command that rewrites the artefact. Named in every refusal.
REGEN_CMD = "just env-pins-regen"

#: The artefact shape this reader understands.
SCHEMA_VERSION = 1

#: `src-app/env-rootfs` — the default root, resolved from this file's own location so a
#: consumer in any package gets it without computing `parents[n]` itself (three suites had
#: three different `parents[n]` expressions for the same directory).
DEFAULT_ENV_ROOT = Path(__file__).resolve().parents[2] / "env-rootfs"


class EnvPinsError(AssertionError):
    """A refusal. `AssertionError` so pytest reports it as a failed assertion rather than
    an error, and so a consumer that forgets to catch it still goes RED rather than
    surfacing a bare traceback that reads like a harness problem."""


def load(env_root: Path | None = None) -> dict:
    """The artefact, verified fresh against every recipe's pin file.

    Raises `EnvPinsError` if it is missing, unparseable, of an unknown schema version, or
    describes a pin file whose bytes have changed since it was generated.
    """
    root = Path(env_root) if env_root is not None else DEFAULT_ENV_ROOT
    path = root / ARTEFACT_NAME
    if not path.is_file():
        raise EnvPinsError(
            f"the exported pin parse {path} is missing. It is the build gate's parse of "
            f"every recipe's {PIN_FILE_NAME}, and every consumer outside the gate reads it "
            f"instead of writing another grammar over the same text "
            f"(docs/design/pin-file-single-parse.md). Regenerate it with `{REGEN_CMD}`."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise EnvPinsError(
            f"{path} is not readable as JSON ({e}). Do not hand-edit it; run `{REGEN_CMD}`."
        ) from e
    got = data.get("schema_version")
    if got != SCHEMA_VERSION:
        raise EnvPinsError(
            f"{path} declares schema_version {got!r}, but this reader understands "
            f"{SCHEMA_VERSION}. A reader that guessed here would silently find no pins and "
            f"every derived floor would go quietly vacuous."
        )
    if not isinstance(data.get("recipes"), dict) or not data["recipes"]:
        raise EnvPinsError(
            f"{path} describes NO recipes. The generator refuses an empty tree, so this "
            f"means the artefact was hand-edited or truncated; run `{REGEN_CMD}`."
        )
    assert_fresh(data, root)
    return data


def assert_fresh(data: dict, env_root: Path) -> None:
    """The artefact must still describe the files on disk — checked THREE ways.

    This is the consumer-side half of the staleness answer (DEC-5). The build's half is
    `build.rs`, which re-derives the artefact and byte-compares it, but `just check-py`
    never invokes cargo, so without this the python gates would trust whatever the artefact
    said.

    1. **Digest** — every described recipe's pin file must still hash to what was recorded.
       Proves the FILE has not changed since generation.
    2. **Recipe-set equality** — a recipe directory on disk that the artefact does not
       describe is a recipe every consumer verifies nothing about, and the digest loop
       above cannot see it because it iterates the artefact. That is the
       blind-to-an-addition half of `derived-guards.md` §4.
    3. **Row coordinates** — every pin records where its LINE lives and the SHA-256 of
       exactly those bytes; this slices and hashes them.

    ## Why (3) exists, and what it is and is not

    (1) proves the bytes are the bytes that were hashed. It does **not** prove the artefact's
    DATA came from those bytes — a blind audit built an artefact with the *correct* digest
    and fabricated rows (`scDblFinder -> 9.9.9`), and every python guard stayed green,
    including the frozen minimum-pin-set case that used to read the file. The only thing in
    the repo that caught a hand-edited artefact was `build.rs`'s byte-compare, and
    `check-py` does not run it.

    (3) closes that by **indexing and hashing**, not by searching. The generator records each
    row's byte range and the hash of those bytes; this slices and compares. It has no line
    rule and no comment rule, because it never has to FIND anything — the coordinates come
    from the one parser entitled to that opinion. It vouches for the WHOLE line, so the
    `# import=` token is covered too.

    **Its honest limits, all three measured rather than reasoned:**

      * it cannot see a DELETED row — the loop iterates the artefact, so an omission is
        structurally invisible here. That is what the consumers' frozen floors are for, and
        what (2) covers for a whole missing RECIPE;
      * it does not see a DUPLICATED row — two identical rows both verify against the same
        line, so a hand-edited artefact can inflate a count-based floor;
      * it vouches for literal bytes, so the DERIVED fields (`name`, folded under the
        recipe's ecosystem, and `ecosystem` itself) are not covered; nor is `line`, which
        only appears in messages.

    Everything not covered here is covered by the build's byte-compare, which remains the
    authority. `cargo check` decides; `just check` runs it before `check-py`.
    """
    root = Path(env_root)
    if not root.is_dir():
        # `iterdir()` on a missing root raises FileNotFoundError, which contradicts this
        # module's "every function here raises EnvPinsError" and reads like a harness bug.
        raise EnvPinsError(
            f"the env recipe tree {root} does not exist, so the exported parse cannot be "
            f"checked against anything. Run `{REGEN_CMD}` from the repository root."
        )
    described = set(data["recipes"])
    on_disk = {
        d.name
        for d in root.iterdir()
        if d.is_dir() and (d / "Dockerfile").is_file() and (d / PIN_FILE_NAME).is_file()
    }
    if described != on_disk:
        raise EnvPinsError(
            f"the exported pin parse and the recipe tree describe different recipe sets.\n"
            f"  on disk only: {sorted(on_disk - described)}\n"
            f"  in the artefact only: {sorted(described - on_disk)}\n"
            f"A recipe the artefact omits is a recipe every check below verifies NOTHING "
            f"about. Run `{REGEN_CMD}`."
        )

    for env_id, recipe_data in sorted(data["recipes"].items()):
        pin_path = root / env_id / PIN_FILE_NAME
        # read_bytes(), never read_text(): universal-newline translation would launder a
        # lone CR into an LF before the digest ever saw it, which is exactly the byte one
        # of the four historical exploits was built from.
        raw = pin_path.read_bytes()
        actual = hashlib.sha256(raw).hexdigest()
        recorded = recipe_data.get("pin_file_sha256")
        if actual != recorded:
            raise EnvPinsError(
                f"the exported pin parse is STALE for recipe `{env_id}`: {pin_path} hashes "
                f"to {actual}, but the artefact records {recorded}. The pin file changed "
                f"and the artefact did not follow, so everything derived from it below is "
                f"about a file that no longer exists in that form. Run `{REGEN_CMD}` and "
                f"commit the result with the pin change."
            )

        # ── HASH AND INDEX. NO SEARCH, NO LINE RULE, NO COMMENT RULE. ──────────────
        #
        # Each row records where its LINE lives (`byte_offset`, `byte_len`) and the SHA-256
        # of exactly those bytes. Verifying a row is: slice, hash, compare. Nothing here
        # asks where a line ends or what a comment is — the coordinates come from the ONE
        # parser, which is the only program entitled to that opinion.
        #
        # ## Why this replaced a substring search, which is the interesting part
        #
        # The first cut searched the file for `<raw_name>==<version>`. Prose then vouched
        # for a pin (the R pin file already contains `` (`celltypist==1.7.1`) `` in a
        # paragraph), so a head anchor was added; then a TRUNCATED version vouched for
        # itself (`alpha==1.0` against a file pinning `alpha==1.0.5`), so a tail anchor was
        # added. At that point a blind audit named what had been built: a line rule AND a
        # comment rule — **two of the three properties that define a parser** — inside the
        # module whose entire job is to have none. Each anchor was a correct fix to a real
        # defect, and the direction was wrong.
        #
        # Coordinates remove the search, so there is nothing left to anchor. Three defects
        # go with it: the WHOLE line is vouched (so the `# import=` token and any trailing
        # comment are covered, where the substring form vouched only for the name/version
        # pair); a pin on the last line with no trailing newline is no longer a false
        # refusal; and this check no longer depends on the gate having refused a CR upstream
        # for its own correctness.
        def _span(row, key, lo, hi, what):
            """A well-formed span inside `[lo, hi)`, or a refusal naming it."""
            s = row.get(key)
            if not isinstance(s, list) or len(s) != 2:
                raise EnvPinsError(
                    f"the exported parse for recipe `{env_id}` has {what} with no `{key}` "
                    f"({row!r}). Run `{REGEN_CMD}`."
                )
            o, n = s
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (o, n)):
                raise EnvPinsError(
                    f"the exported parse gives {what} a non-integer `{key}` ({s!r}) in "
                    f"recipe `{env_id}`. Run `{REGEN_CMD}`."
                )
            if o < 0 or n <= 0 or o < lo or o + n > hi:
                raise EnvPinsError(
                    f"the exported parse puts {what}'s `{key}` at bytes {o}..{o + n}, "
                    f"outside {lo}..{hi} in {pin_path}. A row assembled from bytes scattered "
                    f"through the file is not a row this file contains; run `{REGEN_CMD}`."
                )
            return o, n

        # ── THE PIN SOURCES ARE VOUCHED TOO (#214 round 6) ─────────────────────────
        #
        # They were not, and they are CONSUMED: a blind audit rewrote the R recipe's CRAN
        # snapshot to `2020-01-01` and its Bioconductor release to `bioconductor-3.99`, and
        # the artefact verified while both #192 regime guards passed on the fabricated
        # values. That is TEST-P21's exact class in the half of the artefact the previous
        # round did not touch — and it is the structure that says WHERE THE PINS WERE
        # RESOLVED, i.e. the supply-chain identity #209 exists for.
        for src in recipe_data.get("pin_sources", []):
            so, sn = src.get("byte_offset"), src.get("byte_len")
            if (
                not all(isinstance(v, int) and not isinstance(v, bool) for v in (so, sn))
                or so < 0
                or sn <= 0
                or so + sn > len(raw)
            ):
                raise EnvPinsError(
                    f"the exported parse gives recipe `{env_id}` a pin source with bad byte "
                    f"coordinates ({so!r}, {sn!r}). Run `{REGEN_CMD}`."
                )
            if hashlib.sha256(raw[so : so + sn]).hexdigest() != src.get("line_sha256"):
                raise EnvPinsError(
                    f"the exported parse claims recipe `{env_id}` declares the pin source "
                    f"`{src.get('class')}:{src.get('coordinate')}`, but the bytes at that "
                    f"directive's own coordinates in {pin_path} hash differently. Run "
                    f"`{REGEN_CMD}`."
                )
            co, cn = _span(src, "coordinate_span", so, so + sn, "a pin source")
            if raw[co : co + cn] != str(src.get("coordinate", "")).encode("utf-8"):
                raise EnvPinsError(
                    f"the exported parse gives recipe `{env_id}` the pin-source coordinate "
                    f"{src.get('coordinate')!r}, but the bytes at its own span say "
                    f"{raw[co : co + cn]!r}. The artefact's row does not describe the "
                    f"directive it points at; run `{REGEN_CMD}`."
                )

        pins_rows = recipe_data.get("pins")
        if not isinstance(pins_rows, list) or not pins_rows:
            # `"pins": []` and `"pins": {}` both verified vacuously before this — no rows,
            # nothing checked. The generator refuses a zero-pin recipe, so this is
            # hand-edit-only, which is exactly the threat model, and `load()` already treats
            # an empty `recipes` the same way.
            raise EnvPinsError(
                f"the exported parse gives recipe `{env_id}` no pins ({pins_rows!r}). The "
                f"generator refuses a zero-pin recipe, so this artefact was hand-edited; "
                f"run `{REGEN_CMD}`."
            )
        for pin in pins_rows:
            off, ln, want = pin.get("byte_offset"), pin.get("byte_len"), pin.get("line_sha256")
            if off is None or ln is None or not want:
                raise EnvPinsError(
                    f"the exported parse for recipe `{env_id}` has a pin with no byte "
                    f"coordinates ({pin.get('raw_name')!r}). This reader verifies rows by "
                    f"indexing and hashing, so a row without them cannot be checked at all "
                    f"— which is worse than a wrong row. Run `{REGEN_CMD}`."
                )
            # WELL-FORMED COORDINATES FIRST. A blind audit got a fabricated row past the
            # earlier version with `byte_offset: -5` (python slicing clamps, so `raw[-5:0]`
            # is `b""`), with `byte_len: 0` (which hashes to the digest of the empty string),
            # and with a string `"0"` (a bare TypeError, not an EnvPinsError). Silent
            # acceptance, not a crash — the worst failure mode for a verifier.
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (off, ln)):
                raise EnvPinsError(
                    f"the exported parse gives recipe `{env_id}`'s pin "
                    f"{pin.get('raw_name')!r} non-integer byte coordinates "
                    f"({off!r}, {ln!r}). Run `{REGEN_CMD}`."
                )
            if off < 0 or ln <= 0 or off + ln > len(raw):
                raise EnvPinsError(
                    f"the exported parse places recipe `{env_id}`'s pin "
                    f"{pin.get('raw_name')!r} at bytes {off}..{off + ln} of {pin_path}, "
                    f"which is {len(raw)} bytes long. A negative offset, an empty span, or "
                    f"one past the end does not describe a line in this file — and an empty "
                    f"span hashes to the digest of nothing, which would vouch for anything. "
                    f"Run `{REGEN_CMD}`."
                )
            if hashlib.sha256(raw[off : off + ln]).hexdigest() != want:
                raise EnvPinsError(
                    f"the exported pin parse claims recipe `{env_id}` pins "
                    f"`{pin.get('raw_name')}=={pin.get('version')}`, but the bytes at that "
                    f"row's own coordinates in {pin_path} hash differently. The artefact's "
                    f"DATA does not come from the file it says it describes — the digest "
                    f"above only proves the file is unchanged, not that the rows were "
                    f"derived from it. Do not hand-edit the artefact; run `{REGEN_CMD}`."
                )

            # EACH FIELD AGAINST ITS OWN BYTES, by exact equality at the coordinates the
            # parser supplied.
            #
            # The line hash above proves the LINE is unchanged; it does NOT prove the row's
            # FIELDS correspond to it, because a fabricated `version` leaves the bytes
            # untouched. That gap was found by writing the test rather than by reading the
            # code — the first cut of the coordinate scheme let `version: "9.9.9"` through
            # with the line hash matching, which is a REGRESSION against the substring form
            # it replaced. Both checks are needed and neither subsumes the other.
            #
            # Exact equality, not containment: it catches a fabrication, a truncation (the
            # length differs) and a wrong span, and it needs no anchor because there is
            # nothing to find.
            # Each field, checked at its OWN span: well-formed, contained in the row's
            # line, and byte-equal to what the artefact claims.
            spans = {}
            for field, key in (
                ("raw_name", "raw_name_span"),
                ("version", "version_span"),
                ("import", "import_span"),
            ):
                fo, fl = _span(pin, key, off, off + ln, f"pin {pin.get('raw_name')!r}")
                # BYTES, not a decode. `errors="replace"` was a laundering step in the trust
                # path: a span covering the two middle bytes of an em-dash decodes to
                # U+FFFD U+FFFD, so a row claiming that as its version VERIFIED. Comparing
                # bytes to bytes removes the codec from the comparison entirely.
                if raw[fo : fo + fl] != str(pin.get(field, "")).encode("utf-8"):
                    raise EnvPinsError(
                        f"the exported pin parse gives recipe `{env_id}`'s pin "
                        f"{pin.get('raw_name')!r} the {field} {pin.get(field)!r}, but the "
                        f"bytes at that field's own span say {raw[fo : fo + fl]!r}. The "
                        f"artefact's row does not describe the line it points at; run "
                        f"`{REGEN_CMD}`."
                    )
                spans[field] = (fo, fl)

            # ── ADJACENCY. The property the substring search had and coordinates lost. ──
            #
            # Containment puts each field somewhere in the row's LINE — including in its
            # COMMENT half. A blind audit aimed `version_span` at the `0.0.10` inside
            # `harmonypy==2.0.0  # ... 0.0.10 vs 2.x changed five defaults` and set
            # `version: "0.0.10"`; every check passed, and `version_of` then returned the
            # wrong version for a file that pins 2.0.0. `b"harmonypy==0.0.10" in RAW` is
            # False, so the substring form REFUSED that — which is exactly what the previous
            # round's comment claimed containment had bought back, and had not.
            #
            # The name and the version are adjacent across `==` by construction of the
            # grammar, and the `# import=` token lives after the `#`. Two comparisons.
            (no, nl) = spans["raw_name"]
            (vo, _vl) = spans["version"]
            if raw[no + nl : vo] != b"==":
                raise EnvPinsError(
                    f"the exported parse for recipe `{env_id}` puts "
                    f"{pin.get('raw_name')!r} and {pin.get('version')!r} on the right line "
                    f"but not either side of an `==` (the bytes between them are "
                    f"{raw[no + nl : vo]!r}). A name and a version that are not adjacent "
                    f"are not a pin; run `{REGEN_CMD}`."
                )
            (io_, _il) = spans["import"]
            if b"#" not in raw[off:io_]:
                raise EnvPinsError(
                    f"the exported parse for recipe `{env_id}` places "
                    f"{pin.get('import')!r} before the `#` on its line, where an "
                    f"`# import=` token cannot be; run `{REGEN_CMD}`."
                )


def recipe(env_id: str, env_root: Path | None = None) -> dict:
    """One recipe's exported parse.

    A recipe the artefact does not describe is a REFUSAL — a reader that returned `{}` here
    would make every derived assertion below it vacuous.

    There is deliberately no `data=` parameter to pass a pre-loaded artefact. The first cut
    had one, and it was a way to skip `load()` and therefore `assert_fresh()` entirely: an
    optional argument that silently turns the freshness check off is the shape of a check
    people route around. Nothing used it.
    """
    d = load(env_root)
    try:
        return d["recipes"][env_id]
    except KeyError:
        raise EnvPinsError(
            f"no env recipe `{env_id}` in the exported parse; it describes "
            f"{sorted(d['recipes'])}. If the recipe was renamed, re-point the consumer at "
            f"the new name — do not let this read as 'no pins'."
        ) from None


def _field(env_id: str, key: str, env_root: Path | None) -> object:
    """One field of a recipe's parse, with a REFUSAL rather than a bare `KeyError`.

    A `KeyError` from a subscript reads like a harness bug and is easy to catch by accident;
    an `EnvPinsError` says what is wrong with the artefact and how to fix it.
    """
    r = recipe(env_id, env_root)
    if key not in r:
        raise EnvPinsError(
            f"the exported parse for recipe `{env_id}` has no `{key}` field. This reader "
            f"understands schema {SCHEMA_VERSION}; the artefact was hand-edited or "
            f"truncated. Run `{REGEN_CMD}`."
        )
    return r[key]


def pins(env_id: str, env_root: Path | None = None) -> list[dict]:
    """`[{name, raw_name, version, import, line}]`, in pin-file order.

    `name` is folded under the recipe's declared ecosystem (PEP 503 for python, exact and
    case-preserving for R); `raw_name` is what the file literally says.
    """
    return _field(env_id, "pins", env_root)


def ecosystem(env_id: str, env_root: Path | None = None) -> str:
    """`"python"` or `"r"` — the recipe's DECLARED packaging ecosystem.

    There is no default anywhere in this chain, on purpose: a default makes "somebody
    deleted the declaration" indistinguishable from "this is a python recipe", which is the
    deletion a derivation reading the same source is blind to (`derived-guards.md` §4).
    """
    return _field(env_id, "ecosystem", env_root)


def pin_sources(env_id: str, env_root: Path | None = None) -> list[dict]:
    """`[{class, coordinate, line}]` — the declared resolution coordinates."""
    return _field(env_id, "pin_sources", env_root)


def version_of(name: str, env_id: str, env_root: Path | None = None) -> str | None:
    """The pinned version of `name`, matched against BOTH the folded and the raw spelling.

    Returns `None` only when the recipe genuinely does not pin the distribution — which some
    callers legitimately ask ("is pillow pinned?"). A caller that EXPECTS a pin should use
    `require_version_of`, because a mis-spelled or differently-folded name reads identically
    to "absent" here, and this module's own docstring says absence is a refusal.
    """
    for p in pins(env_id, env_root):
        if name in (p["name"], p["raw_name"]):
            return p["version"]
    return None


def require_version_of(name: str, env_id: str, env_root: Path | None = None) -> str:
    """`version_of`, as a REFUSAL when the pin is absent — with the names it does know.

    A blind audit pointed out that a caller who expects a pin cannot tell "not pinned" from
    "I spelled it the way the file spells it and the artefact folds it differently". This
    raises with both spellings listed, so the answer is in the message.
    """
    v = version_of(name, env_id, env_root)
    if v is None:
        known = sorted({p["raw_name"] for p in pins(env_id, env_root)})
        raise EnvPinsError(
            f"recipe `{env_id}` does not pin `{name}`. It pins: {known}. If the name looks "
            "present but differently spelled, note that `name` is folded under the recipe's "
            "ecosystem while `raw_name` is what the file says — this matches either."
        )
    return v
