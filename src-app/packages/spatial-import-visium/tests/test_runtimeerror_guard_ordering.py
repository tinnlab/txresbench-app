#!/usr/bin/env python3
# ruff: noqa
r"""Every widened `except (..., RuntimeError, ...)` is preceded by `except VisiumImportError: raise` (#517).

## The defect this guard exists to make falsifiable

`import_visium.py` wraps every read of an untrusted h5 member in a widened tuple —
`except (KeyError, OSError, TypeError, RuntimeError)` — and turns the failure into a
NAMED `VisiumImportError`. Because `VisiumImportError` SUBCLASSES `RuntimeError`
(`import_visium.py:447`), that widened tuple would catch this package's own named
refusals too: a `VisiumImportError` raised inside the `try` (by a nested call, or by a
later check folded into the same guarded region) would be swallowed and re-wrapped as a
DIFFERENT refusal — losing the specific message, or worse, being reported as a problem
with the wrong member. So every one of those `try` blocks carries an EARLIER
`except VisiumImportError: raise` handler that re-raises the package's own refusal
unchanged.

There are 20 such sites today — the 19 origin/main carried (the scout report's section-5
table, the #474 all-zero-scan guarded block read, and the #517-era sites) plus the one
#471's root-attribute read adds. The defect #517
reports is not "one of the 20 is missing" — it is that NOTHING reddens if any of them is
deleted. A guard that cannot fail is a comment, and a comment is what a future
refactor deletes as dead weight. This test is the structural check that makes the
pattern falsifiable: it walks the module's OWN AST (the same discipline
`tests/visium_refusal_sites.py` argues for — structural, not enumerated, so a site added
tomorrow is covered the moment it is written) and proves the invariant for EVERY
widened tuple, not a sample.

## Why "earlier" is part of the invariant

Python checks `except` clauses in source order. A `except VisiumImportError: raise`
that appears AFTER the widened tuple would never run — the widened tuple catches the
`RuntimeError` subclass first. So the reraise must precede the widened tuple in the
SAME `try` statement, and the check below asserts exactly that.

## Why "FIRST" is part of the invariant (audit round 2, Finding E)

"Precedes the widened tuple" is not quite enough: a handler that swallows
`VisiumImportError` BEFORE the reraise runs would make the reraise dead code while
every "preceded by" check stays green. The candidates are a bare `except:` and a
broad `except Exception:` (or any tuple/name that names `VisiumImportError` or its
`RuntimeError` base) sitting between the START of the handler list and the reraise.
The simplest sufficient rule is the one asserted here: the `except VisiumImportError:
raise` handler is ALWAYS the very FIRST `except` clause (index 0) of every `try` that
carries a widened tuple. A swallowing handler inserted before it would then be caught
by construction. MEASURED on this branch: all 20 widened-tuple `try` statements have
the reraise at index 0, so the stronger rule holds everywhere today — it is a
tightening, not a relaxation.

## The mutation proof (run on this branch, recorded in the implementer report)

Deleting ANY ONE of the 20 `except VisiumImportError: raise` lines makes this test
RED, naming the line; restoring it makes the test GREEN again. That is the property
#517 asks for, and it is asserted here structurally rather than by a per-site list.
"""
import ast
from pathlib import Path

COMPUTE = Path(__file__).resolve().parents[1] / "compute" / "import_visium.py"

#: The exception whose reraise must precede every widened tuple. `VisiumImportError`
#: subclasses `RuntimeError`, so the widened tuple WOULD catch it — the reraise guard is
#: what keeps this package's own named refusals from being swallowed and re-wrapped.
VISIUM = "VisiumImportError"

#: The exception named in the widened tuples this guard is about.
WIDENED = "RuntimeError"


def _names_exception(typ, name):
    """Does `typ` name `name` — directly, or as one element of a tuple?"""
    if isinstance(typ, ast.Name):
        return typ.id == name
    if isinstance(typ, ast.Tuple):
        return any(_names_exception(e, name) for e in typ.elts)
    return False


def _is_reraise(body):
    """A one-statement body that RE-RAISES: `raise` or `raise exc` (not a new refusal)."""
    return (len(body) == 1 and isinstance(body[0], ast.Raise)
            and (body[0].exc is None or isinstance(body[0].exc, ast.Name)))


def _widened_handlers(tree):
    """Every `except (..., RuntimeError, ...)` handler, as `(lineno, Try, index)`.

    `index` is the handler's position in its `try`'s `handlers` list. The invariant
    checked against it is the STRONGER one (Finding E): the `try`'s FIRST handler
    (index 0) must be the `except VisiumImportError: raise` reraise — which is also
    what makes every widened tuple "preceded by" the reraise.
    """
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for i, handler in enumerate(node.handlers):
            if _names_exception(handler.type, WIDENED):
                out.append((handler.lineno, node, i))
    return out


def test_every_widened_runtimeerror_guard_is_preceded_by_a_visium_reraise():
    r"""#517 — the `except VisiumImportError: raise` guards are UNFALSIFIABLE without this.

    Every `try` whose handlers include a widened `except (..., RuntimeError, ...)` tuple
    must carry `except VisiumImportError: raise` (or `except VisiumImportError as exc:
    raise`) as its VERY FIRST handler — index 0 in the `try`'s `handlers` list.
    `VisiumImportError` subclasses `RuntimeError`, so without the reraise guard the
    widened tuple catches this package's own named refusals and re-wraps them as a
    different refusal — the specific message is lost, and a refusal about one member is
    reported as a refusal about another. The check is STRUCTURAL, not enumerated: it
    walks the module's own AST, so a widened tuple added tomorrow is covered the moment
    it is written, and a deleted reraise line reddens by name.

    "FIRST", not merely "earlier" (audit round 2, Finding E): a swallowing handler
    (bare `except:`, broad `except Exception:`, or any tuple/name that could catch
    `VisiumImportError`/`RuntimeError`) inserted BEFORE the reraise would make it dead
    code while every "preceded by" check stayed green. Requiring the reraise at index 0
    rules that out by construction. MEASURED on this branch: all 20 widened-tuple `try`
    statements already have the reraise first, so the stronger rule holds everywhere.

    MEASURED on this branch: deleting ANY ONE of the 20 `except VisiumImportError:
    raise` lines makes this test red, naming the line; restoring it makes the test green
    again. (The widened-tuple count is 20 here — the 19 the base carried plus the one
    #471's root-attribute read adds; the check does not depend on the count.)
    """
    source = COMPUTE.read_text(encoding="utf-8")
    tree = ast.parse(source)
    handlers = _widened_handlers(tree)
    assert handlers, (
        "no `except (..., RuntimeError, ...)` handler found — this guard would pass "
        "vacuously. Was the module moved, or the widened tuples renamed?"
    )
    assert len(handlers) >= 20, (
        f"expected at least the 20 known widened-tuple sites, found {len(handlers)} — "
        "either the parser is matching fewer than the module really contains (a "
        "vacuously-passing guard) or a guarded site was removed"
    )
    bad = []
    for lineno, node, index in handlers:
        first = node.handlers[0]
        if not (_names_exception(first.type, VISIUM) and _is_reraise(first.body)):
            bad.append(lineno)
    assert not bad, (
        f"{len(bad)} widened `except (..., RuntimeError, ...)` handler(s) at line(s) "
        f"{bad} are in a `try` whose FIRST handler is not `except VisiumImportError: "
        "raise`. `VisiumImportError` subclasses `RuntimeError`, so without the reraise "
        "guard the widened tuple catches this package's own named refusals and "
        "re-wraps them as a different refusal — the specific message is lost — and a "
        "swallowing handler BEFORE the reraise would make it dead code. Every widened "
        "tuple must sit in a `try` whose first `except` clause is `except "
        "VisiumImportError: raise`."
    )
