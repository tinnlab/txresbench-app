#!/usr/bin/env python3
# ruff: noqa
r"""Enumerate this module's refusal sites FROM ITS OWN AST, and classify what each interpolates.

## Why this is structural and not a list (#336)

The defect #336 reports is not "these four refusals are unescaped". It is that **#330 built one
escaping funnel and routed ONE refusal through it**, and the fix that names four more sites has
exactly the same shape as the fix that named one: it is true of today's module and silently stops
being true the day someone writes a fifth. The design says this about itself, one level down, in
`vendor-text-encodability-refusal.md` §6.5:

> a rule scoped to today's readers silently stops covering an attribute the day someone reads one
> more — the `section_sample_id` defect (#320) this importer has already shipped once

So the SUBJECT SET is derived, not written down: every `raise VisiumImportError(...)` the module
contains, found by walking its AST. A refusal added tomorrow is inside the subject set the moment
it is written, with nobody remembering anything.

## What "safe" means here, and why the classifier is deliberately NARROW

Each interpolation must be **PROVED** safe, and there are exactly two ways to prove it:

1. **It goes through a funnel** — [`FUNNELS`], i.e. `_quoted_for_refusal` or
   `_quoted_list_for_refusal`, which hold ASCII + bounded + control-character-free.
2. **Its SHAPE cannot carry a vendor byte** — a `len()`/`int()` call, a module-level constant, a
   name bound only to literals, an `enumerate` index. These are proved by SHAPE, never by name:
   there is no allowlist of blessed identifiers, because an allowlist of identifiers is the same
   "true of today's module" object as an allowlist of sites.

Anything the classifier cannot place in one of those two categories is **UNSAFE**. That direction
is the whole design (DEC-2): a classifier that widens to accommodate each new shape converges on
accepting everything, so where the source and the classifier disagree it is the SOURCE that
states the fact (`int(shape[1])` rather than `shape[1]`). The design argues for exactly this
default two sections earlier: *"a guard's default has to be to look."*

## The parser refuses to match nothing

[`refusal_sites`] RAISES when the walk finds no refusal sites, and [`assert_module_is_funnelled`]
RAISES when the module does not define the funnels it is being checked against. This is
`sandbox_code_dir.py`'s stated discipline — a parser that quietly returned `[]` would leave a
guard that passes because it measured nothing, which is the failure mode this whole file exists
to remove.
"""
import ast

#: The functions that make an attacker-controlled value safe to interpolate. A call to one of
#: these is the FIRST of the two ways an interpolation can be proved safe.
FUNNELS = ("_quoted_for_refusal", "_quoted_list_for_refusal")

#: The exception whose messages are audited. Named rather than "any exception" because this is
#: the one `main()` catches and prints to stderr, which is the path `scheduler.rs::drain_logs`
#: turns into `job_logs` rows.
REFUSAL = "VisiumImportError"

#: Calls whose RESULT is a number, WHATEVER the argument is. Each one is TOTAL to `int`/`float`:
#: it either returns a number or raises. That totality is the whole property — a call that can
#: return its ARGUMENT is a laundering route, not a safe shape.
#:
#: FIX_ROUND-1 removed FIVE names from this list, and the two angles found different ones:
#:
#: * `min`, `max`, `sum` — `min` over a list of strings returns a STRING, so
#:   `f"bad {min(names)}"` passed clean with an entire vendor field in it (security angle);
#: * `abs`, `round` — `__abs__` and `__round__` are DUNDERS: a type can define them to return
#:   anything at all, so neither is total to a number the way `len`/`int`/`ord` are
#:   (design-conformance angle).
#:
#: Three remain, and each is total to `int` by its own contract rather than by convention: `len`
#: returns a non-negative `int` or raises, `int` returns an `int` or raises, `ord` returns an
#: `int` or raises. "It reads as numeric" is not the test; "it cannot return its argument" is.
_NUMERIC_CALLS = ("len", "int", "ord")

#: Methods that MUTATE their receiver. A container is bound once, to an empty literal, and then
#: FILLED by one of these — so a binding-only checker sees `[]` and blesses it. That is not
#: hypothetical: a blind security angle re-introduced #336's own defect into the real module as
#:
#:     shown = []
#:     for c in names:
#:         shown.append(c)
#:     ... f"Found {shown}."
#:
#: and this guard returned NO findings, while the regressed module put a **28,320,522-byte**
#: single stderr line on the wire — four times worse than the 7.2 MB it was written to fix. So a
#: name that is EVER the receiver of one of these, anywhere in the module, is unprovable.
#:
#: That byte figure is the AUDITING ANGLE'S measurement of a regressed module that was never
#: committed, so it cannot be re-derived from this tree — a later angle checked and said exactly
#: that. It is kept because it is the reason this rule exists and the order of magnitude is the
#: point, and it is LABELLED here rather than left looking like something a reader could go and
#: reproduce. What IS reproducible is the guard behaviour: TEST-11/TEST-20 assert that every one
#: of these spellings is flagged, and those probes run on every test run.
_MUTATORS = ("append", "extend", "insert", "add", "update", "setdefault", "__setitem__",
             "sort", "pop", "clear", "popitem", "difference_update", "intersection_update",
             "symmetric_difference_update", "reverse")


class Unsafe(Exception):
    """Raised internally when a subtree cannot be proved safe. Carries the reason."""


def _fmt(node):
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - ast.unparse is total on parsed trees
        return f"<{type(node).__name__}>"


# ── scopes ──────────────────────────────────────────────────────────────────────────────


class _Scope:
    """One lexical scope: its parameter list, its assignments, and the calls made inside it.

    Resolution walks OUTWARD from the innermost scope, so `name` inside the nested `column()`
    resolves to `column`'s parameter and not to the unrelated `name` in `decoded_h5_strings`.
    A module-wide bag keyed by identifier would conflate those two and either fail a safe site or
    (worse) pass an unsafe one on the strength of a same-named binding somewhere else.
    """

    def __init__(self, node, parent):
        self.node = node
        self.parent = parent
        self.bindings = {}      # name -> [expression node | None for an unprovable binding]
        self.functions = {}     # name -> FunctionDef
        self.calls = []         # every Call made in this scope's own body

    def bind(self, name, value):
        self.bindings.setdefault(name, []).append(value)


def _build_scopes(tree):
    """Map every AST node to its enclosing scope, collecting bindings, functions and calls.

    Deliberately simple: it models assignment, tuple-unpacking, `for` targets, comprehension
    targets, `except ... as`, `with ... as`, and function parameters. Anything it does not model
    is recorded as an UNPROVABLE binding (`None`), which makes the name unsafe — the safe
    direction.
    """
    scope_of = {}
    module = _Scope(tree, None)
    #: (scope, name) pairs to mark unprovable ONCE THE WHOLE WALK IS DONE.
    #:
    #: FIX_ROUND-2. The first version resolved the owner with `_lookup` DURING the source-order
    #: walk, so a mutation that appears textually BEFORE its container's binding could not find
    #: the owner and poisoned the wrong scope. A blind correctness angle reproduced #336's own
    #: accumulator defect in three orderings the first version missed — the mutation inside a
    #: nested function, the mutation above the binding at module level, and the subscript twin —
    #: each returning a clean bill of health on a module that really did put raw vendor bytes on
    #: stderr. Ordering is not a property a guard may depend on: the poisons are collected here
    #: and applied after every binding in every scope is known.
    poisons = []

    def visit(node, scope):
        scope_of[node] = scope
        inner = scope
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scope.functions[node.name] = node
            inner = _Scope(node, scope)
            args = node.args
            for a in (list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)):
                inner.bind(a.arg, ("param", node, a.arg))
            if args.vararg:
                inner.bind(args.vararg.arg, None)
            if args.kwarg:
                inner.bind(args.kwarg.arg, None)
        elif isinstance(node, ast.Lambda):
            inner = _Scope(node, scope)
            for a in (list(node.args.posonlyargs) + list(node.args.args)):
                inner.bind(a.arg, None)
        elif isinstance(node, ast.ClassDef):
            # A class body is its OWN scope. FIX_ROUND-1: it was not, so `class Box: payload = ""`
            # bound `payload` into the MODULE scope and an unrelated `payload` elsewhere resolved
            # to that literal and passed. A blind security angle wrote exactly that.
            inner = _Scope(node, scope)

        if isinstance(node, ast.Call):
            scope.calls.append(node)
            # A MUTATING METHOD CALL poisons its receiver, in whatever scope the receiver lives.
            # See [`_MUTATORS`]: a container bound to `[]` and then filled by `.append` has ONE
            # recorded binding — the empty literal — and a binding-only checker blesses it. The
            # receiver is poisoned rather than the call being flagged, because the mutation and
            # the interpolation are usually in different statements and it is the NAME that must
            # stop being provable.
            if (isinstance(node.func, ast.Attribute) and node.func.attr in _MUTATORS
                    and isinstance(node.func.value, ast.Name)):
                poisons.append((inner, node.func.value.id))

        # `global X` / `nonlocal X` (FIX_ROUND-2). An assignment under one of these binds a name
        # in an OUTER scope, and `_bind_target` always binds locally — so `global SHOWN; SHOWN =
        # vendor` left the module's `SHOWN = "safe literal"` standing and the refusal that read it
        # passed. A blind correctness angle measured the leak end to end. Rather than model which
        # outer scope receives the write, the name is poisoned in EVERY scope on the chain: a
        # declaration that a name is written from somewhere else is exactly a declaration that its
        # local bindings are not the whole story.
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                walk = inner
                while walk is not None:
                    poisons.append((walk, name))
                    walk = walk.parent

        # `import x` / `from m import len as len` (FIX_ROUND-2). Unmodelled, so every name in
        # [`_NUMERIC_CALLS`], [`FUNNELS`] and `list`/`sorted`/`tuple`/`set`/`type` was shadowable
        # by an import and `_shadowed` said no. `from evil import len` was measured CLEAN.
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                inner.bind(alias.asname or alias.name.split(".")[0], None)

        # `match vendor: case NAME:` (FIX_ROUND-2). A bare `case NAME` is an irrefutable CAPTURE,
        # not a comparison, so it BINDS. The guard recorded nothing, `_lookup` walked out to a
        # module constant of the same name, and the refusal inside the arm passed while printing
        # the vendor's own bytes. Measured by a blind correctness angle.
        if isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            inner.bind(node.name, None)
        if isinstance(node, ast.MatchMapping) and node.rest:
            inner.bind(node.rest, None)

        if isinstance(node, ast.Assign):
            for target in node.targets:
                _bind_target(inner, target, node.value)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            if isinstance(node.target, ast.Name):
                inner.bind(node.target.id, node.value if isinstance(node, ast.AnnAssign) else None)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            _bind_loop_target(inner, node.target, node.iter)
        elif isinstance(node, ast.comprehension):
            _bind_loop_target(inner, node.target, node.iter)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            inner.bind(node.name, None)          # an exception object: never provably safe
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            _bind_target(inner, node.optional_vars, None)
        elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            inner.bind(node.target.id, node.value)

        for child in ast.iter_child_nodes(node):
            visit(child, inner)

    def _bind_target(scope, target, value):
        if isinstance(target, ast.Name):
            scope.bind(target.id, value)
        elif isinstance(target, (ast.Tuple, ast.List)):
            elts = value.elts if isinstance(value, (ast.Tuple, ast.List)) else None
            for i, elt in enumerate(target.elts):
                sub = elts[i] if elts is not None and i < len(elts) else None
                _bind_target(scope, elt, sub)
        elif isinstance(target, ast.Starred):
            _bind_target(scope, target.value, None)
        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
            # `parts[0] = vendor` / `d[k] = vendor` — the CONTAINER changed, so the container is
            # no longer whatever literal it was bound to. Same argument as [`_MUTATORS`], and
            # deferred to the post-walk pass for the same ordering reason.
            poisons.append((scope, target.value.id))
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            poisons.append((scope, target.value.id))

    def _bind_loop_target(scope, target, iterable):
        # `for index, value in enumerate(raw)`: element 0 of the tuple is the INDEX, an int, and
        # element 1 is whatever `raw` holds — which is exactly the vendor bytes. So the two are
        # bound differently rather than the pair being blessed together.
        if (isinstance(target, ast.Tuple) and isinstance(iterable, ast.Call)
                and isinstance(iterable.func, ast.Name) and iterable.func.id == "enumerate"
                and len(target.elts) == 2):
            _bind_target(scope, target.elts[0], ast.Constant(value=0))
            _bind_target(scope, target.elts[1], None)
            return
        if isinstance(iterable, (ast.Tuple, ast.List, ast.Set)):
            # A literal table: `for axis, name, keys in (("cells", "barcode", k), ...)`. Each row
            # is unpacked so a Name in one column does not bless a Constant in another.
            if isinstance(target, ast.Tuple):
                for i, elt in enumerate(target.elts):
                    for row in iterable.elts:
                        sub = (row.elts[i] if isinstance(row, (ast.Tuple, ast.List))
                               and i < len(row.elts) else None)
                        _bind_target(scope, elt, sub)
            else:
                for row in iterable.elts:
                    _bind_target(scope, target, row)
            return
        _bind_target(scope, target, None)

    visit(tree, module)
    # THE SECOND PASS. Every binding in every scope is now known, so each poison can find the
    # scope that really owns its name regardless of where the mutation appeared in the source.
    for scope, name in poisons:
        owner, _bindings = _lookup(scope, name)
        (owner or scope).bind(name, None)
    return scope_of, module


def _lookup(scope, name):
    while scope is not None:
        if name in scope.bindings:
            return scope, scope.bindings[name]
        scope = scope.parent
    return None, None


def _find_function(scope, name):
    while scope is not None:
        if name in scope.functions:
            return scope, scope.functions[name]
        scope = scope.parent
    return None, None


# ── the classifier ──────────────────────────────────────────────────────────────────────


class _Checker:
    def __init__(self, tree):
        self.scope_of, self.module = _build_scopes(tree)
        self._resolving = set()

    def _shadowed(self, name, scope=None):
        """Is a builtin/funnel name REBOUND anywhere the call site can see it?

        FIX_ROUND-1, from both angles. `_NUMERIC_CALLS` and [`FUNNELS`] are matched by NAME, so:

        * a module-level `def len(x): return x` turns every `len(vendor)` into a laundering route
          this guard blesses (security angle);
        * a LOCAL `_quoted_for_refusal = lambda v: v` does the same one scope down, which a
          module-scope-only check cannot see (design-conformance angle).

        So the whole visible chain is walked, from the call site outward. A name bound anywhere
        other than as the funnel's own `def` is no longer trusted.
        """
        walk = scope
        while walk is not None:
            if name in walk.bindings:
                return True
            if walk is not self.module and name in walk.functions:
                return True
            walk = walk.parent
        if name in self.module.bindings:
            return True
        fn = self.module.functions.get(name)
        return fn is not None and name not in FUNNELS

    def check(self, node, scope):
        """Raise `Unsafe` unless `node` is provably incapable of carrying a vendor byte."""
        if isinstance(node, ast.Constant):
            return
        if isinstance(node, ast.JoinedStr):
            for part in node.values:
                if isinstance(part, ast.FormattedValue):
                    self.check(part.value, scope)
                    # THE FORMAT SPEC IS ALSO INTERPOLATED (FIX_ROUND-2). `f"{0:{vendor}}"` puts
                    # the vendor's own string in as the fill character and the width, and a blind
                    # correctness angle measured `f("\x1b<20")` producing 19 RAW ESCAPES. Both
                    # `check` and [`_message_parts`] took only `FormattedValue.value` and dropped
                    # `.format_spec`, which is itself a `JoinedStr` holding arbitrary expressions.
                    if part.format_spec is not None:
                        self.check(part.format_spec, scope)
            return
        if isinstance(node, ast.NamedExpr):
            # `f"{(n := len(v))}"`. Provably safe by this checker's own rules and refused for want
            # of an arm — a FALSE POSITIVE, and a false positive is how a guard gets weakened.
            return self.check(node.value, scope)
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            for elt in node.elts:
                self.check(elt, scope)
            return
        if isinstance(node, ast.BinOp):
            self.check(node.left, scope)
            self.check(node.right, scope)
            return
        if isinstance(node, ast.UnaryOp):
            return self.check(node.operand, scope)
        if isinstance(node, ast.BoolOp):
            for v in node.values:
                self.check(v, scope)
            return
        if isinstance(node, ast.IfExp):
            self.check(node.body, scope)
            self.check(node.orelse, scope)
            return
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if k is not None:
                    self.check(k, scope)
                self.check(v, scope)
            return
        if isinstance(node, ast.Attribute):
            # NO attribute is blessed. FIX_ROUND-1 removed a by-NAME rule that trusted
            # `.size`/`.nbytes`/`.__name__` on any object; FIX_ROUND-2 removes the last survivor,
            # `type(x).__name__`, because the justification written beside it was FALSE and a
            # blind correctness angle said so: a class name is neither ASCII (PEP 3131) nor
            # necessarily an identifier —
            #
            #     type("\x1b[2J forged", (), {}).__name__   ==   "\x1b[2J forged"
            #
            # `type()` accepts any string. The rule was not exploitable at the module's real
            # sites, but "not exploitable today" is not the standard this guard holds itself to,
            # and a bless whose stated reason is untrue is a bless nobody can re-derive. The two
            # real sites now say `_quoted_for_refusal(type(exc).__name__)` — the funnel, which is
            # true of every object, rather than a claim about one.
            raise Unsafe(
                f"attribute `{_fmt(node)}` is not a funnel call; no attribute is blessed by name "
                f"— route it through {FUNNELS[0]}, or make the numeric fact explicit with `int()`"
            )
        if isinstance(node, ast.Name):
            return self._check_name(node, scope)
        if isinstance(node, ast.Call):
            return self._check_call(node, scope)
        raise Unsafe(f"`{_fmt(node)}` ({type(node).__name__}) cannot be proved safe")

    def _check_call(self, node, scope):
        func = node.func
        if isinstance(func, ast.Name):
            if func.id in FUNNELS and not self._shadowed(func.id, scope):
                # (1) it goes through a funnel — but the funnel's OWN arguments are part of its
                # OUTPUT and must be safe too. FIX_ROUND-1: `noun=` lands verbatim in the
                # over-long branch's sentence (`f"...characters of the {noun})"`), so
                # `_quoted_for_refusal(1, noun=vendor)` put a raw vendor value on stderr THROUGH
                # the funnel, and the first version of this checker returned on sight of the
                # callee's name and never looked. A blind design-conformance angle wrote it.
                # ONLY the VALUE argument is exempt — making that safe is the funnel's entire
                # job. EVERY other argument is checked, `focus=` included: it too is interpolated
                # (`f"...the offending unit is at {focus})"`), so exempting it would leave the
                # same hole one keyword over, which is the shape this whole item is about.
                for extra in node.args[1:]:
                    self.check(extra, scope)
                for kw in node.keywords:
                    if kw.arg is None:
                        raise Unsafe(
                            f"`{_fmt(node)}` splats `**kwargs` into a funnel, so its keyword "
                            f"arguments cannot be traced"
                        )
                    self.check(kw.value, scope)
                return
            if func.id in _NUMERIC_CALLS and not self._shadowed(func.id, scope):
                return                                   # (2a) its result is a number, always
            if func.id in ("list", "sorted", "tuple", "set") and not self._shadowed(func.id, scope):
                for a in node.args:
                    self.check(a, scope)
                return
            # A call to a function defined in this module: safe only if what it RETURNS is safe.
            _, fn = _find_function(scope, func.id)
            if fn is not None:
                return self._check_returns(fn)
            raise Unsafe(f"call `{_fmt(node)}` is not a funnel and its result is not provably safe")
        if isinstance(func, ast.Attribute):
            if func.attr == "join":
                # `' / '.join(x)` — the separator is fixed; the safety is entirely `x`'s.
                self.check(func.value, scope)
                for a in node.args:
                    self.check(a, scope)
                return
            if func.attr in ("format", "format_map"):
                raise Unsafe(
                    f"`{_fmt(node)}` interpolates through `str.{func.attr}`; route the values "
                    f"through {FUNNELS[0]}"
                )
            raise Unsafe(f"method call `{_fmt(node)}` cannot be proved safe")
        raise Unsafe(f"call `{_fmt(node)}` cannot be proved safe")

    def _check_returns(self, fn):
        key = ("ret", id(fn))
        if key in self._resolving:
            return
        self._resolving.add(key)
        try:
            inner = self.scope_of.get(fn.body[0], self.module)
            found = False
            for sub in ast.walk(fn):
                if isinstance(sub, ast.Return) and sub.value is not None:
                    found = True
                    self.check(sub.value, self.scope_of.get(sub, inner))
            if not found:
                raise Unsafe(f"`{fn.name}()` returns nothing provably safe")
        finally:
            self._resolving.discard(key)

    def _check_name(self, node, scope):
        owner, bindings = _lookup(scope, node.id)
        if bindings is None:
            raise Unsafe(f"`{node.id}` has no binding this checker can find")
        key = ("name", id(owner), node.id)
        if key in self._resolving:
            # `label = label or f"/matrix/{name}"` — a self-reference. The OTHER bindings decide;
            # a cycle back to the same name adds no new way for a vendor byte to enter.
            return
        self._resolving.add(key)
        try:
            for binding in bindings:
                if binding is None:
                    raise Unsafe(
                        f"`{node.id}` is bound to something this checker cannot prove safe "
                        f"(an exception, a `*args`, a subscript, or an unmodelled statement)"
                    )
                if isinstance(binding, tuple) and binding and binding[0] == "param":
                    self._check_param(binding[1], binding[2], owner)
                    continue
                self.check(binding, owner)
        finally:
            self._resolving.discard(key)

    def _check_param(self, fn, arg_name, owner):
        """A parameter is safe iff EVERY call to its function passes a safe argument for it.

        This is what lets internal PROSE stay unquoted without an identifier allowlist:
        `absent_what`, `unreadable_what`, `not_dataset_what`, `inline_what`, `label`,
        `source` and `remedy` are proved safe because every call site in the module hands
        them a literal — and the day one of them is handed a vendor value, this goes red.
        """
        args = fn.args
        names = [a.arg for a in (list(args.posonlyargs) + list(args.args))]
        kwonly = [a.arg for a in args.kwonlyargs]
        pos = names.index(arg_name) if arg_name in names else None

        defaults = list(args.defaults)
        if pos is not None and defaults:
            first_default = len(names) - len(defaults)
            if pos >= first_default:
                self.check(defaults[pos - first_default], self.scope_of.get(fn, self.module))
        if arg_name in kwonly:
            d = args.kw_defaults[kwonly.index(arg_name)]
            if d is not None:
                self.check(d, self.scope_of.get(fn, self.module))

        # FIX_ROUND-2: a call site this tracer CANNOT SEE is worse than no call site at all,
        # because one visible SAFE call satisfies the `seen == 0` guard below while an invisible
        # hostile one supplies the real argument. A blind correctness angle measured three:
        # `self.refuse(vendor)` (an attribute callee), `fn = refuse; fn(vendor)` (an alias), and a
        # decorated re-binding. So the function's own NAME must be used ONLY as a direct call: any
        # other reference to it, and any call to an attribute of the same name, makes the
        # parameter untraceable rather than safe.
        for other in ast.walk(self.module.node):
            if (isinstance(other, ast.Call) and isinstance(other.func, ast.Attribute)
                    and other.func.attr == fn.name):
                raise Unsafe(
                    f"`{fn.name}` is also called as an ATTRIBUTE (`{_fmt(other)}`), so this "
                    f"checker cannot see every argument `{arg_name}` receives"
                )
            if (isinstance(other, ast.Name) and other.id == fn.name
                    and not isinstance(other.ctx, ast.Store)):
                parent_is_direct_call = any(
                    isinstance(c, ast.Call) and c.func is other
                    for c in ast.walk(self.module.node)
                )
                if not parent_is_direct_call:
                    raise Unsafe(
                        f"`{fn.name}` is referenced other than as a direct call (aliased, passed "
                        f"as an argument, or decorated), so `{arg_name}` is untraceable"
                    )

        seen = 0
        for scope in self._scopes_that_can_see(fn):
            for call in scope.calls:
                if not (isinstance(call.func, ast.Name) and call.func.id == fn.name):
                    continue
                seen += 1
                caller = scope
                for kw in call.keywords:
                    if kw.arg == arg_name:
                        self.check(kw.value, caller)
                    elif kw.arg is None:
                        raise Unsafe(
                            f"`{fn.name}()` is called with `**kwargs`, so `{arg_name}` cannot be "
                            f"traced to its argument"
                        )
                if pos is not None and pos < len(call.args):
                    a = call.args[pos]
                    if isinstance(a, ast.Starred):
                        raise Unsafe(f"`{fn.name}()` is called with `*args`; `{arg_name}` is untraceable")
                    self.check(a, caller)
        if seen == 0:
            raise Unsafe(
                f"`{fn.name}()` has no call site this checker can find, so `{arg_name}` cannot "
                f"be proved to receive only literals"
            )

    def _scopes_that_can_see(self, _fn):
        """Every scope in the module — a nested helper's call sites live in its parent's body."""
        out = []
        seen = set()
        for scope in self.scope_of.values():
            if id(scope) not in seen:
                seen.add(id(scope))
                out.append(scope)
        return out


# ── the public surface ──────────────────────────────────────────────────────────────────


def _message_parts(call):
    r"""Every DYNAMIC contribution to a refusal's message, whatever spelling was used.

    An f-string is the spelling this module uses today, but it is not the only one that puts a
    vendor byte on stderr, and a guard that only understood f-strings would be a guard a
    `.format()` walks straight past. So `%`, `.format()`, `+` concatenation and a bare
    `raise VisiumImportError(msg)` all decompose here into the same list of expressions.
    """
    parts = []

    def walk(node):
        if isinstance(node, ast.Constant):
            return
        if isinstance(node, ast.JoinedStr):
            for v in node.values:
                if isinstance(v, ast.FormattedValue):
                    # The FormattedValue's VALUE is the unit; the classifier descends into it.
                    parts.append(v.value)
                    # ... and so is its FORMAT SPEC, which is interpolated just as literally.
                    # See `check`'s JoinedStr arm (FIX_ROUND-2).
                    if v.format_spec is not None:
                        walk(v.format_spec)
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            walk(node.left)
            walk(node.right)
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            walk(node.left)
            if isinstance(node.right, ast.Tuple):
                parts.extend(node.right.elts)
            else:
                parts.append(node.right)
            return
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("format", "format_map")):
            walk(node.func.value)
            parts.extend(node.args)
            parts.extend(kw.value for kw in node.keywords)
            return
        parts.append(node)

    for arg in call.args:
        walk(arg)
    for kw in call.keywords:
        walk(kw.value)
    return parts


def _refusal_aliases(tree):
    """`VisiumImportError` plus every module-level name bound directly to it.

    FIX_ROUND-1: `Refusal = VisiumImportError; raise Refusal(f"bad {v}")` was invisible to a
    finder that matched the literal name.
    """
    names = {REFUSAL}
    for _ in range(8):                       # a fixed point: an alias of a subclass of an alias
        before = set(names)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name):
                if node.value.id in names:
                    names |= {t.id for t in node.targets if isinstance(t, ast.Name)}
            # A SUBCLASS is the same exception as far as `main()`'s `except` is concerned
            # (FIX_ROUND-2). A blind correctness angle wrote `class MyErr(VisiumImportError)`,
            # raised it with a raw vendor value, confirmed `main()` catches and PRINTS it, and
            # the guard reported a clean module.
            if isinstance(node, ast.ClassDef):
                for base in node.bases:
                    base_name = (base.id if isinstance(base, ast.Name)
                                 else base.attr if isinstance(base, ast.Attribute) else None)
                    if base_name in names:
                        names.add(node.name)
        if names == before:
            break
    return names


def refusal_sites(source):
    """Every CONSTRUCTION of the refusal in `source`, as `(lineno, Call)`. RAISES if none.

    ## Every construction, not every `raise` (FIX_ROUND-1)

    The first version matched `ast.Raise` whose `exc` was a `Call` to the bare name
    `VisiumImportError`. A blind security angle defeated that four ways, each of which returned a
    clean bill of health on a module putting raw vendor bytes on stderr:

        err = VisiumImportError(f"bad {vendor}"); raise err      # `exc` is a Name
        raise _refuse(f"bad {vendor}")                           # `exc` is a call to a helper
        Refusal = VisiumImportError; raise Refusal(f"bad {v}")   # an alias
        raise mod.VisiumImportError(f"bad {v}")                  # an Attribute func

    The subject is therefore the CONSTRUCTION — every `Call` whose callee names the refusal, by
    the bare name, by an alias, or as an attribute — and not the `raise`. That closes all four at
    once, and it closes them by REMOVING a distinction rather than by adding four patterns:
    wherever a refusal is built, its arguments are audited, no matter what is later done with the
    object. The helper case falls out for free — the construction inside `_refuse` is found, its
    argument is `_refuse`'s parameter, and the parameter is traced to every call site.
    """
    tree = ast.parse(source)
    names = _refusal_aliases(tree)
    sites = [
        (node.lineno, node)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and ((isinstance(node.func, ast.Name) and node.func.id in names)
             or (isinstance(node.func, ast.Attribute) and node.func.attr in names))
    ]
    if not sites:
        raise AssertionError(
            f"no `{REFUSAL}(...)` construction found — the parser matched NOTHING, so this guard "
            f"would pass vacuously. Was the exception renamed, or the module moved?"
        )
    return tree, sorted(sites, key=lambda pair: pair[0])


def unsafe_interpolations(source):
    """`[(lineno, expression-source, reason)]` — every interpolation that cannot be proved safe.

    An empty list is the property #336 asks for: every value any refusal in this module puts on
    stderr is either funnelled or provably incapable of carrying a vendor byte.
    """
    tree, sites = refusal_sites(source)
    checker = _Checker(tree)
    out = []
    for _, call in sites:
        scope = checker.scope_of.get(call, checker.module)
        for part in _message_parts(call):
            try:
                checker.check(part, scope)
            except Unsafe as why:
                out.append((getattr(part, "lineno", 0), _fmt(part), str(why)))
    return out


def assert_module_is_funnelled(source):
    r"""The integrity half: the module must DEFINE each funnel, EXACTLY ONCE, and it must escape.

    ## HONEST LIMIT, stated because it is easy to mistake this file for more than it is

    This is a ROUTING guard. It proves that every value a refusal interpolates GOES THROUGH a
    funnel; it cannot prove the funnel still ESCAPES anything, because that is a property of what
    the function DOES and no amount of AST walking observes behaviour. A blind security angle
    demonstrated the gap directly: redefine `_quoted_for_refusal` as `return value` and every
    routing check still passes.

    What closes it is not a cleverer parser, it is the BEHAVIOURAL tests, and they are the reason
    this limit is acceptable rather than fatal:

    * `test_refusal_escaping.py::TEST-12` runs the REAL module's funnels over hostile values and
      asserts ASCII, control-free and bounded output;
    * `TEST-13` asserts the funnel's output for #330's own shapes is byte-identical;
    * `TEST-1..TEST-7`, `TEST-15` and `TEST-16` drive the SHIPPED ENTRYPOINT over hostile bundles
      and assert on the bytes that actually reach stderr, which is true of the whole chain
      regardless of what any one function does.

    Two structural legs ARE worth having, and both were added in FIX_ROUND-1:

    1. **EXACTLY ONE definition each.** A second `def _quoted_for_refusal` silently REPLACES the
      first — the shape the angle used — and the check for a name's mere presence cannot see it.
    2. **The scalar funnel's body must call `ascii(`.** Not proof, and not claimed as proof: a
      floor that makes a silent gutting of the funnel a deliberate act rather than a one-word
      edit.
    """
    tree = ast.parse(source)
    defined = {}
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defined.setdefault(n.name, []).append(n)

    missing = [f for f in FUNNELS if f not in defined]
    if missing:
        raise AssertionError(
            f"the module does not define {missing} — this guard is checking every refusal "
            f"against a funnel that no longer exists, so it would report every site as unsafe "
            f"or (if the name were merely renamed) bless a call to something else entirely"
        )
    duplicated = {f: len(defined[f]) for f in FUNNELS if len(defined[f]) > 1}
    if duplicated:
        raise AssertionError(
            f"a funnel is defined more than once {duplicated} — the LAST definition wins at "
            f"import time, so a routing guard would keep passing while every refusal called "
            f"something else entirely"
        )
    scalar = defined[FUNNELS[0]][0]
    escapes = any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "ascii"
                  for n in ast.walk(scalar))
    if not escapes:
        raise AssertionError(
            f"`{FUNNELS[0]}` no longer calls `ascii()`. This is a floor, not a proof — what the "
            f"funnel DOES is proved by the behavioural tests (TEST-12/TEST-13 and the entrypoint "
            f"tests) — but a funnel that does not escape is not a funnel"
        )
