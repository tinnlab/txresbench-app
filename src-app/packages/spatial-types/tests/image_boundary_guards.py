#!/usr/bin/env python3
# ruff: noqa
"""ONE `ast` guard over the image boundaries, and the two POLICIES it enforces (#296/#297/#298).

This module exists because there were two of it. `test_ome_dtype_refusal` carried a strong
guard (a broad handler is admitted only in the exact site-rule shape) applied to
`write_ome_tiff` alone, and `test_image_failure_provenance` carried a weak one (any type filter
is refused, any broad handler waved through) applied to five boundaries. They were the same
eighteen lines differing by one clause, each with its own copy of the allow-list — and that
duplication is not a tidiness complaint, it is WHY two boundaries ended up guarded by nothing:
the copy applied broadly was the one that checked least.

## The two policies, named, because they are OPPOSITE and both are correct

`ome_writer.read_image` and `ome_writer.downsample` convert EVERYTHING, unconditionally. That
is attempt 4 of `read_image`'s own four-attempt history and its justification is COVERAGE: every
decode branch in those two functions is exercised by a test, so a typo on any of them goes red
before it can be reported to a user as a bad image. Their `except Exception` is deliberate and
must not be "fixed".

`write_ome_tiff`, `xenium_image.read_plane`, `ome_writer.tifffile_version` and
`import_xenium.emit_image`'s second-open block convert only what a LIBRARY raised, and
propagate what their own code raised, via `image_failure_is_a_bug`. Their `except Exception` is
admissible ONLY in that shape.

A maintainer adding a branch or a handler needs to know which regime a function is in, and
before this the machine-checkable artifacts could not tell them: one test name covered both
lists and accepted either behaviour. Now the policy is data, the guard reads it, and adding a
boundary to the wrong list fails.
"""
import ast
import contextlib
import sys
from pathlib import Path

#: The types an image boundary may catch BY NAME. `ImportError` is here because `importlib`
#: raises a missing module on the caller's own line; the rest are the two refusal taxonomies,
#: the library's own OME refusal, and `OSError`, which both importers already guard.
NAMED_REFUSALS = frozenset({
    "ImageConversionError", "SpatialDeclarationError", "OSError", "OmeXmlError",
})

#: `ImportError` IS DELIBERATELY NOT IN `NAMED_REFUSALS`, and this is the record of why.
#:
#: It was, for two rounds, because `write_ome_tiff`'s import block briefly caught it by name.
#: That block was replaced by the standard boundary shape (the `ImportError` rule now lives
#: entirely in `image_failure_is_a_bug`), and the entry was left behind — where it meant a
#: site-rule boundary could catch `ImportError` by name and skip the site rule entirely. A
#: blind audit inserted exactly that into `tifffile_version`, in all three copies:
#:
#:     except ImportError as exc:
#:         raise ImageConversionError(...) from exc
#:
#: and all 886 tests stayed green, while a TYPO in our own import was laundered as a bad image
#: and a present-but-broken library propagated a bare `ValueError` — both halves of #298 E2,
#: re-opened, silently. No boundary catches `ImportError` by name today and none may: the
#: decision needs the raising site and the module name, and only the predicate has both.
#: Asserted at import time rather than left as prose. In a module whose docstring says "the
#: policy is data, the guard reads it", a policy constant nothing reads is the shape it warns
#: about — so this one is the read.
assert "ImportError" not in NAMED_REFUSALS, (
    "`ImportError` is back in the by-name allow-list. A site-rule boundary could then catch it "
    "by name and skip the site rule entirely, which was measured laundering a typo AND "
    "re-opening the broken-library half of #298 E2, with the whole suite green.")

#: The predicate a site-rule boundary's broad handler must consult. Spelled once.
SITE_RULE = "image_failure_is_a_bug"

#: `src-app/packages/`, DERIVED from this module's own location rather than typed. Every
#: package-dimension derivation below globs from here, so a new sibling package is in scope
#: the moment it exists — see `derive_boundaries`.
PACKAGES = Path(__file__).resolve().parents[2]

#: The two policies a boundary can be under. Every row of `BOUNDARIES` carries one.
SITE_RULE = SITE_RULE
POLICY_SITE_RULE = "site-rule"
POLICY_COVERAGE = "coverage"

#: ── WHAT IS CLASSIFIED BY HAND, AND WHAT IS DERIVED ────────────────────────────────
#:
#: `BOUNDARIES` used to be a flat hand-written list of `(package, file, function, policy)`
#: rows, and this module's own docstring says why that is dangerous — *"a boundary in no
#: list is a boundary nothing checks"*. It then WENT STALE IN SILENCE exactly as predicted:
#: `spatial-import-visium-hd` (#313) shipped a byte-identical fourth `compute/ome_writer.py`
#: and its four boundaries were in no row, so nothing checked them. That is the third
#: occurrence of the #303/#324 class — a guard ENUMERATING what it could DERIVE — and adding
#: four more rows would have repaired the instance and left the mechanism.
#:
#: So the list is now split along the only line that actually separates them:
#:
#:   * the POLICY of a function is a HUMAN JUDGEMENT and cannot be derived from anything.
#:     `read_image`'s `except Exception` is admissible because every decode branch is under
#:     test (COVERAGE); `write_ome_tiff`'s is admissible only in the site-rule shape. The two
#:     are OPPOSITE and both correct, they are indistinguishable structurally, and a machine
#:     that guessed would guess `read_image` wrong. So the classification stays DECLARED.
#:   * WHICH PACKAGES a classified boundary exists in is a FACT ABOUT THE TREE, discoverable
#:     by glob, and a human copying it into a list is the defect above. So it is DERIVED.
#:
#: `OME_WRITER_POLICIES` is that irreducible half for the vendored writer: four functions,
#: one policy each, no package named. TEST-13 asserts every shipped copy is byte-identical,
#: so one classification is the whole truth for all of them, and
#: `test_the_declared_boundary_list_covers_every_function_that_looks_like_one` re-derives
#: the boundary SET out of each copy's source and demands it equal these keys — so a new
#: function in the file still has to be classified before it can ship. The comparison is not
#: circular: this table is the declaration, `declared_boundary_functions` is the derivation,
#: and they are computed from different inputs.
OME_WRITER_POLICIES = {
    "write_ome_tiff": POLICY_SITE_RULE,
    "tifffile_version": POLICY_SITE_RULE,
    "read_image": POLICY_COVERAGE,
    "downsample": POLICY_COVERAGE,
}

#: The policy EVERY importer's per-image boundary is under. One value, not one row per
#: importer, because the package and the function name are both derived (see
#: `per_image_boundary_functions`).
#:
#: SITE_RULE, NOT COVERAGE, and the first version of the `import_visium.py` row got that
#: wrong. `emit_images` has no broad handling today — its per-image guard is the NAMED tuple,
#: which passes under either policy — so `POLICY_COVERAGE` bought nothing on the shipped
#: source while giving up the one thing the entry can enforce: coverage admits
#: `except Exception` unconditionally. MEASURED: adding a broad handler beside the named tuple
#: (the shape that file's OWN comment forbids — "`AttributeError`/`TypeError` already
#: propagate, and a real bug should too") left every suite green under COVERAGE and is caught
#: under SITE_RULE. `importer_guard_names` does not cover it either: it refuses REPLACING the
#: named tuple, not ADDING one beside it.
#:
#: `import_xenium.py`'s `emit_image` was in NEITHER of the two lists this module replaced —
#: that is how its second-open block came to be guarded by nothing — and `import_visium.py`
#: was in no row at all, so the ceiling on the per-image guard rested entirely on the xenium
#: copy being listed. Deriving the importer half is what stops a third importer repeating it:
#: `spatial-import-visium-hd`'s `emit_images` is covered here without anyone adding a row.
IMPORTER_POLICY = POLICY_SITE_RULE

#: WHAT IS STILL ENUMERATED, WHAT MAKES IT COMPLETE, AND HOW IT FAILS WHEN IT IS NOT.
#:
#: One row: `xenium_image.read_plane`. It is a boundary in a package-PRIVATE helper module —
#: not vendored into siblings (so no glob spans it), not the function holding the per-image
#: guard (so the write_ome_tiff derivation does not reach it), and named nothing a sibling
#: package would predictably repeat. There is no property of the tree that picks it out
#: without picking out every converting helper in every package, so it is DECLARED.
#:
#: WHAT MAKES IT COMPLETE: it is the set of image boundaries living OUTSIDE a vendored
#: `compute/ome_writer.py` and OUTSIDE an importer's per-image guard. Today that is one
#: function in one file.
#:
#: HOW IT FAILS WHEN IT IS NOT: silently, in the one direction a check can still see — so
#: both directions are checked rather than asserted in prose. A row naming a function that no
#: longer exists is caught by `boundary_offenders`, which returns "there is no `X` in this
#: source to check" as an offender. A NEW boundary appearing in an already-declared file is
#: caught by `test_the_declared_boundary_list_covers_every_declared_files_boundaries`. The
#: residue this cannot see is a boundary in a file that is in no row at all and is neither a
#: vendored writer nor an importer — adding such a file is the one act that still requires a
#: human to add a row here, and it is stated so the next reader is not surprised by it.
EXTRA_BOUNDARIES = (
    ("spatial-import-xenium", "xenium_image.py", "read_plane", POLICY_SITE_RULE),
)

#: FLOORS. A derivation whose scan set collapses reports "no boundaries" and every
#: parametrized test over it then passes by running zero times — the shape
#: `check-processor-seed-versions.sh` calls "a PASS having verified nothing" and pins with its
#: own `MIN_PACKAGES`. These are minima, deliberately below today's counts, so a new package
#: never has to touch them and a vanished layout still fails closed.
MIN_OME_WRITER_COPIES = 3
MIN_IMAGE_EMITTING_IMPORTERS = 2


def ome_writer_copies(packages=None):
    """Every package shipping a vendored `compute/ome_writer.py`, by GLOB.

    The same discovery `test_image_failure_provenance`'s `SHIPPED` already does — promoted
    here so the DECLARATION and the PARAMETRIZATION cannot disagree about which packages
    exist. They did: the suite globbed, the list did not, and `spatial-import-visium-hd`
    landed in one and not the other.
    """
    return tuple(sorted(Path(packages or PACKAGES).glob("*/compute/ome_writer.py")))


#: The writer call that makes a module an image emitter. Spelled once, matched on the
#: attribute leaf so `ome_writer.write_ome_tiff` and a bare re-export both count.
WRITER_CALL = "write_ome_tiff"


def calls_the_writer(source):
    """Does `source` CALL `write_ome_tiff`, by `ast`?

    By `ast` and not by substring, because a substring hit is also what a docstring, a
    comment or an `assert "write_ome_tiff" in ...` produces — and a file admitted on one of
    those has no per-image guard to find, which would turn `derive_boundaries`' one-boundary
    assertion from "nothing guards the emit" into a false alarm about prose.
    """
    return any(isinstance(node, ast.Call) and ast.unparse(node.func).rsplit(".", 1)[-1] == WRITER_CALL
               for node in ast.walk(ast.parse(source)))


def image_emitting_importers(packages=None):
    """Every `compute/import_*.py` that calls `write_ome_tiff` — i.e. emits an image.

    Membership is the CALL, not the package name: a `spatial-import-*` prefix is a naming
    convention and `derived-guards.md` §5 is about not blessing one. A package that stops
    emitting images leaves this set on its own.
    """
    found = []
    for path in sorted(Path(packages or PACKAGES).glob("*/compute/import_*.py")):
        source = path.read_text(encoding="utf-8")
        if WRITER_CALL in source and calls_the_writer(source):
            found.append(path)
    return tuple(found)


def _owned_by(function):
    """Every node inside `function` that is not inside a NESTED function or class.

    So a `try` in a closure is attributed to the CLOSURE, which `ast.walk` alone would
    attribute to both — and `boundary_offenders` would then be asked about a name that is not
    a module-level function.
    """
    owned, stack = [], list(function.body)
    while stack:
        node = stack.pop()
        owned.append(node)
        stack.extend(child for child in ast.iter_child_nodes(node)
                     if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef,
                                               ast.ClassDef, ast.Lambda)))
    return owned


def per_image_boundary_functions(source):
    """The function(s) holding an importer's per-image guard, DERIVED from the source.

    IDENTIFIED BY WHAT IT GUARDS, which is the definition `importer_guard_names` already
    argues for at length: the per-image body is the `try` whose body calls
    `ome_writer.write_ome_tiff`, so the boundary is the function that `try` lives in. That
    survives every refactor that reader survives — a renamed skip list, a hoisted `_skip`
    helper, a nested handler — because none of them moves the writer call.

    It also means the NAME is derived: `emit_image` in xenium, `emit_images` in visium and in
    visium-hd. Those three names were three hand-written rows, and the third was missing.
    """
    tree = ast.parse(source)
    found = []
    for function in ast.walk(tree):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in _owned_by(function):
            if not isinstance(node, ast.Try):
                continue
            if any(isinstance(n, ast.Call)
                   and ast.unparse(n.func).rsplit(".", 1)[-1] == WRITER_CALL
                   for stmt in node.body for n in ast.walk(stmt)):
                found.append(function.name)
                break
    return sorted(set(found))


def derive_boundaries(packages=None):
    """EVERY boundary with its policy — the package dimension derived, the policy declared.

    Takes `packages` so a test can point it at a FICTIONAL tree and prove the derivation
    notices a new package without anyone editing a list. That is the difference between
    repairing this instance and repairing the mechanism, and it is
    `test_a_fictional_new_package_is_covered_without_editing_any_list`.
    """
    root = Path(packages or PACKAGES)
    writers = ome_writer_copies(root)
    importers = image_emitting_importers(root)
    assert len(writers) >= MIN_OME_WRITER_COPIES, (
        f"found {len(writers)} shipped `compute/ome_writer.py` under {root}, below the floor "
        f"of {MIN_OME_WRITER_COPIES}. The layout this derivation globs no longer resolves, so "
        "`BOUNDARIES` was about to be empty and every test parametrized over it would pass "
        "having run zero times.")
    assert len(importers) >= MIN_IMAGE_EMITTING_IMPORTERS, (
        f"found {len(importers)} `compute/import_*.py` calling `write_ome_tiff` under {root}, "
        f"below the floor of {MIN_IMAGE_EMITTING_IMPORTERS} — see the message above.")

    rows = []
    for writer in writers:
        package = writer.parents[1].name
        rows.extend((package, "ome_writer.py", function, policy)
                    for function, policy in OME_WRITER_POLICIES.items())
    for importer in importers:
        package = importer.parents[1].name
        names = per_image_boundary_functions(importer.read_text(encoding="utf-8"))
        assert len(names) == 1, (
            f"{package}/{importer.name} calls `write_ome_tiff` from {len(names)} function(s) "
            f"{names}, so 'the function holding the per-image guard' is no longer one "
            "sentence. Either the emit body moved out of a `try` — in which case NOTHING "
            "guards it and the import aborts on one bad image — or there are two, and this "
            "derivation cannot say which is the boundary. Both need a human.")
        rows.append((package, importer.name, names[0], IMPORTER_POLICY))
    for package, filename, function, policy in EXTRA_BOUNDARIES:
        assert (root / package / "compute" / filename).is_file(), (
            f"`EXTRA_BOUNDARIES` names {package}/compute/{filename}, which is not in this "
            "tree. An enumerated row pointing at nothing is a boundary declaration nothing "
            "can check, which is the failure this module exists to prevent.")
        rows.append((package, filename, function, policy))
    return tuple(rows)


#: EVERY boundary, with its policy. Derived at import time; see `derive_boundaries`.
BOUNDARIES = derive_boundaries()


def guarded_by_the_site_rule(handler):
    """Does this handler's body ask the discriminator AND obey the answer?

    THE SHAPE IS EXACT, and every relaxation of it was DEMONSTRATED to be an evasion. An
    earlier version accepted any `ast.If` anywhere in the handler whose test MENTIONED the
    predicate and which contained a bare `raise` anywhere in its subtree. A blind audit walked
    through it four ways, on the shipped source, each leaving `write_ome_tiff` swallowing every
    bug:

      `if image_failure_is_a_bug(...): pass` / `else: raise`   — inverted
      `if not image_failure_is_a_bug(...): raise`              — negated
      `if False and image_failure_is_a_bug(...): raise`        — dead
      `if <never true>: \\n    if image_failure_is_a_bug(...): raise`  — nested out of reach

    So the accepted shape is ONE statement, positionally FIRST in the handler body, literally:

        if <call to image_failure_is_a_bug(exc, __file__)>:
            raise

    — an unadorned `ast.Call` as the whole test (no `not`, no `and`, no comparison), whose
    SECOND argument is the name `__file__` (a later audit showed the guard was blind to the
    argument: rewriting every call to pass a sibling module's path left it green, and that
    call answers False for everything), a body that is exactly one bare `raise`, and an empty
    `orelse`. Anything else is refused, which is the correct trade: this shape is the one every
    shipped boundary uses, and a guard that admits a CONDITION is worth exactly what it costs
    to evade.
    """
    if not handler.body:
        return False
    first = handler.body[0]
    if not isinstance(first, ast.If) or not isinstance(first.test, ast.Call):
        return False
    call = first.test
    if ast.unparse(call.func).rsplit(".", 1)[-1] != SITE_RULE:
        return False
    if len(call.args) != 2 or ast.unparse(call.args[1]) != "__file__":
        return False
    # AND THE FIRST ARGUMENT, which was unchecked. `image_failure_is_a_bug(None, __file__)` is
    # False for everything (`getattr(None, "__traceback__", None)` is None), so a handler could
    # pass anything and still READ as guarded. Demonstrated on the shipped source. The
    # behavioural batteries do catch it — twelve legs go red — but a structural guard that
    # validates one argument and not the other is a guard with a hole in the same place twice.
    if handler.name is None or ast.unparse(call.args[0]) != handler.name:
        return False
    if first.orelse:
        return False
    return (len(first.body) == 1
            and isinstance(first.body[0], ast.Raise)
            and first.body[0].exc is None)


def boundary_offenders(source, function_name, policy):
    """Every handler in `function_name` that catches more than its POLICY allows.

    `POLICY_SITE_RULE` — a broad `except Exception` is admitted only in the exact shape above.
    `POLICY_COVERAGE`  — a broad `except Exception` is admitted unconditionally, because that
                         function's own justification is coverage (see this module's docstring).
    Under BOTH policies a bare `except:` is refused, and so is any handler naming a type
    outside `NAMED_REFUSALS` — which is what keeps a deny-list of bug types or an allow-list of
    decoder errors (attempts 2 and 3) from growing back at any boundary.
    """
    tree = ast.parse(source)
    target = next((n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name == function_name), None)
    if target is None:
        return [f"there is no `{function_name}` in this source to check"]
    offenders = []
    for handler in (n for n in ast.walk(target) if isinstance(n, ast.ExceptHandler)):
        if handler.type is None:
            offenders.append(f"{function_name}: a BARE `except:`")
            continue
        names = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
        spellings = [ast.unparse(name) for name in names]
        leaves = [spelled.rsplit(".", 1)[-1] for spelled in spellings]
        if all(leaf in NAMED_REFUSALS for leaf in leaves):
            continue
        if leaves == ["Exception"]:
            if policy == POLICY_COVERAGE or guarded_by_the_site_rule(handler):
                continue
            offenders.append(
                f"{function_name}: `except Exception` without the site rule as its FIRST "
                f"statement (`if {SITE_RULE}(exc, __file__): raise`)")
            continue
        offenders.append(f"{function_name}: `except " + ", ".join(spellings) + "`")
    return offenders


# ── READING THE IMPORTERS' PER-IMAGE GUARD TUPLE OUT OF THEIR OWN SOURCE ────────────


def importer_guard_names(caller_source):
    """The exception names in the caller's PER-IMAGE guard, by `ast`, not by regex.

    WHY IT IS NOT A REGEX. The shipped reader matched the FIRST `except (...)` naming
    `ome_writer.ImageConversionError`. That was unambiguous until a SECOND such handler
    appeared in `import_xenium.emit_image` — the re-open block's pass-through — at which point
    it silently resolved the WRONG tuple, dropped `OSError` from it, and reported that the two
    importers guard different taxonomies. It found a real ambiguity; it just could not name it.

    WHY IT IS NOT "THE WIDEST SKIP-APPENDING HANDLER" EITHER, which is what replaced the regex
    and was itself evaded two ways within one round:

      * a nested handler that is a strict SUPERSET of the real guard becomes "the guard".
        Demonstrated: narrow the real per-image guard from
        `(ImageConversionError, SpatialDeclarationError, OSError)` to
        `(ImageConversionError, SpatialDeclarationError)` and leave `OSError` on the nested
        `read_image` handler, in BOTH importers, and this function reports the nested tuple,
        the "both importers agree" assert passes, and the whole suite stays green while a
        truncated vendor PNG raised anywhere else aborts the import;
      * hoisting `skipped.append(...)` into a `_skip(basename, exc)` helper — an ordinary
        refactor — removes the real guard from the candidate set entirely, because the test
        keyed on the literal word "skip" appearing in the appended-to name.

    SO IT IS IDENTIFIED BY WHAT IT GUARDS. The per-image guard is the handler on the `try`
    whose BODY contains the call to `ome_writer.write_ome_tiff` — that is the definition of
    "the guard around the per-image body", it is the property every claim in this suite is
    actually about, and it survives both refactors above because neither moves the writer call
    out of the guarded body. A nested handler is on a nested `try` and is not considered; a
    renamed skip list is irrelevant.
    """
    tree = ast.parse(caller_source)
    guards = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        emits = any(
            isinstance(n, ast.Call) and ast.unparse(n.func).endswith("write_ome_tiff")
            for stmt in node.body for n in ast.walk(stmt))
        if not emits:
            continue
        for handler in node.handlers:
            if handler.type is None:
                continue
            names = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
            spellings = [ast.unparse(n) for n in names]
            if any(s.endswith("ImageConversionError") for s in spellings):
                guards.append(tuple(sorted(spellings)))
    assert len(guards) == 1, (
        f"expected exactly ONE handler naming `ImageConversionError` on the `try` whose body "
        f"calls `write_ome_tiff`, found {len(guards)}: {guards}. That handler IS the per-image "
        "guard; if there are two, or none, then 'the taxonomy the guards catch' is no longer "
        "one sentence and every test in this suite that resolves it is asserting about "
        "something else.")
    return guards[0]


def declared_boundary_functions(source, filename):
    """Every function in `source` that LOOKS like an image boundary, derived not remembered.

    `BOUNDARIES` above is hand-maintained, and this file's own docstring says why that is
    dangerous: *"a boundary in no list is a boundary nothing checks"*. Nothing checked the list
    itself, so adding a plausible new function to `ome_writer.py` —

        def read_image_thumbnail(path):
            try:
                return read_image(path)
            except Exception:
                return None

    — passed the whole suite. A boundary is recognised structurally: a function containing a
    broad `except Exception` handler, or a deferred import ANYWHERE in it.
    `test_the_declared_boundary_list_covers_every_function_that_looks_like_one` asserts this set
    EQUALS the declared one, so a new boundary must be classified before it can ship.

    "ANYWHERE in it", not "inside a `try`", and the difference is deliberate fail-closed: a
    deferred import OUTSIDE a converting `try` IS #298 E2, so it is exactly the case that must be
    classified. The cost is that a future helper doing a local `import platform` also demands a
    policy — a prompt to classify it, not a false alarm.

    ONE SPELLING IT CANNOT SEE, stated so it is not mistaken for coverage:
    `importlib.import_module("tifffile")` is a `Call`, not an `Import` node. No boundary uses it.
    """
    tree = ast.parse(source)
    #: Module-level names bound to `Exception`/`BaseException` — see the handler check below.
    #:
    #: THREE SPELLINGS, because the first version matched only the first and the other two are
    #: what a maintainer actually reaches for: `_BROAD = (Exception,)` is the idiomatic way to
    #: write a shared handler type, and `_BROAD: type = Exception` is a spelling this very suite
    #: already enumerates as the next reach (`_DENY_LIST_SPELLINGS["annotated-constant"]`). Both
    #: walked past the first version with every suite green.
    def _binds_broad(value):
        if isinstance(value, ast.Name):
            return value.id in {"Exception", "BaseException"}
        if isinstance(value, ast.Tuple):
            return any(_binds_broad(e) for e in value.elts)
        return False

    broad_aliases = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and _binds_broad(stmt.value):
            broad_aliases |= {tgt.id for tgt in stmt.targets if isinstance(tgt, ast.Name)}
        elif (isinstance(stmt, ast.AnnAssign) and stmt.value is not None
              and _binds_broad(stmt.value) and isinstance(stmt.target, ast.Name)):
            broad_aliases.add(stmt.target.id)
    found = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for inner in ast.walk(node):
            if isinstance(inner, (ast.Import, ast.ImportFrom)):
                # THE SECOND CLAUSE, which this function PROMISED and did not implement for a
                # round. A deferred import inside a function is an image boundary whether or
                # not it catches broadly: `ImportError` is what #298 E2 is about, and a
                # deferring function in no policy list is guarded by nothing. Three evasions
                # walked past the handler-only version — a `try`/`except OSError` around a
                # deferred import, `except BaseException`, and a module-level `_BROAD =
                # Exception` used as the handler type.
                found.add(node.name)
            elif isinstance(inner, ast.ExceptHandler):
                if inner.type is None:
                    found.add(node.name)          # a bare `except:`
                    continue
                names = (inner.type.elts if isinstance(inner.type, ast.Tuple) else [inner.type])
                leaves = {ast.unparse(n).rsplit(".", 1)[-1] for n in names}
                # BROAD ONLY, and `BaseException` counts. A NARROW named catch is not a
                # boundary — `_reconcile_scale` converts a `KeyError` into its own taxonomy,
                # which is a targeted repair and exactly what INV-3 wants; flagging it would
                # make the completeness check demand a policy for every converting handler in
                # the file. What INV-3 forbids at a DECLARED boundary is enforced separately,
                # by `boundary_offenders`.
                #
                # `broad_aliases` is what closes the `_BROAD = Exception` evasion: a module-level
                # name bound to `Exception` is a broad catch wearing a local name, and matching
                # on the spelling alone let it walk past.
                if leaves & ({"Exception", "BaseException"} | broad_aliases):
                    found.add(node.name)
    return found


# ── MAKING A LIBRARY ABSENT, THE WAY IT REALLY IS ──────────────────────────────────


@contextlib.contextmanager
def module_really_absent(name):
    """`import <name>` raises `ModuleNotFoundError` FROM THE IMPORTING LINE, as it really does.

    SHARED, because there were two of it and one was wrong. THE TECHNIQUE IS THE WHOLE TEST,
    and this is its third shape:

      1. replacing `builtins.__import__` with a shim that raises — the exception then comes
         from the SHIM's frame, in the test file, which is the OPPOSITE attribution from a real
         missing module and is exactly the attribution the mechanism reads;
      2. a `sys.meta_path` finder whose `find_spec` RAISES — the same defect one layer down,
         and worse, because its docstring claimed it fixed (1) and its "control for the
         control" asserted the innermost frame was `__file__`, which PASSED because the
         blocker lived in the same file. It confirmed the defect instead of catching it;
      3. `sys.modules[name] = None`, this one. Python treats a `None` entry as a poisoned
         import and raises `ModuleNotFoundError(name=<name>)` AT THE IMPORT STATEMENT, in the
         importing module's own frame. MEASURED against a genuinely uninstalled module: same
         type, same `.name`, same `.path`, same frame, same traceback depth.

    It lives HERE rather than in one suite because shape (2) survived in the OTHER suite for a
    round after being replaced in the first — and that suite held the only END-TO-END proof of
    #298 E2, which therefore never touched the `_DECLARED_LIBRARIES` carve-out at all: a
    `find_spec` that raises lands on the "a library's frame -> CONVERT" arm instead. One copy,
    one technique, both suites.
    """
    poisoned = [k for k in list(sys.modules) if k == name or k.startswith(name + ".")]
    saved = {k: sys.modules[k] for k in poisoned}
    for key in poisoned:
        del sys.modules[key]
    sys.modules[name] = None
    try:
        yield
    finally:
        sys.modules.pop(name, None)
        sys.modules.update(saved)
