"""The RUN-TIME half of the declared dependency + version contract (#80).

## What this is for

A manifest's `run.dependencies[]` declares, per entry, the libraries its compute imports
and the version range each is supported against. The BUILD gate
(`server/build_helper/processor_manifest.rs`) already proved that declaration is
satisfiable by the environment recipe. This module proves it is satisfied by the
environment the job ACTUALLY got, and records what that environment resolved to.

Those are two different claims and both are needed. The recipe says what an image built
from it contains; a running job is handed whatever image the deployment last fetched,
which may predate the recipe change entirely — the runtime lazy-fetches a MOVING tag, so
"the recipe declares it" and "this job has it" can disagree for as long as a republish is
outstanding. Checking here is what turns that disagreement into a named refusal instead
of a wrong number.

## What it replaces

Before this, four separate compute files each carried a private, hand-written

    def _library_versions():
        out = {}
        for mod in ("<a fixed list somebody typed>",):
            try: out[mod] = getattr(__import__(mod), "__version__", None)
            except Exception: out[mod] = None
        return out

and one of them ALSO hand-checked one library's version against a module constant that
duplicated a pin in the recipe. Every one of those copies had the same three defects:
the list of libraries was written down separately from the libraries the code actually
imports (so it drifted); a version that could not be read became `None` rather than a
failure (so an absent library was recorded as "unknown" and the run continued); and
nothing compared the recorded version to anything (so recording it changed no outcome).

This module fixes all three by construction: the subject set is the DECLARED contract
(one source, the manifest, which the build gate also reads), an unreadable version is a
refusal, and every version is compared against its declared range.

## Why `importlib.metadata` and not `__version__`

`__version__` is an attribute a module may or may not define, may define inconsistently
with what is installed, and is actively being removed — the stack's own libraries now
emit `FutureWarning: __version__ is deprecated, use importlib.metadata.version(...)`.
`importlib.metadata.version()` reads the installed DISTRIBUTION's metadata, which is the
thing a pin actually pins and the thing a reproducer would reinstall. It also means this
module never imports the library at all: a version check does not need to execute
somebody's `__init__`, and not importing keeps the check cheap and side-effect free.

## Floor

stdlib + `packaging` (an explicit pin in the recipe, promoted from a transitive
dependency precisely because this gate must not itself rest on an unpinned dependency).
No numpy, no domain library.

## There is no key that turns it off

Deliberate, and the same design property `conformance.py` states for the artifact gate.
The value of this check is that a published result cannot have come from an environment
nobody verified; a deployment that can switch it off is a deployment whose results you
cannot trust, and you would not know which one it was. The check can only ever REFUSE a
run whose environment contradicts its own declaration — it can never grant a capability —
so there is no operational reason to want it off.
"""

import hashlib
import json
import os
from pathlib import Path

# The staged contract: the server writes the resolved entry's declared
# `run.dependencies[]` here, into the same `/code` directory the entry itself is staged
# into, using the same mechanism that stages helper modules. Two consequences worth
# knowing: it is bound READ-ONLY like the rest of `/code`, and a reproduce capsule stages
# it byte-identically because the capsule copies exactly the same staged set.
CONTRACT_FILENAME = "cyto_dependencies.json"

# The full resolved environment closure, frozen into the image at build time. Recorded by
# DIGEST (not by value) so the run record stays small while still identifying the exact
# environment; the file itself lives in the published image, addressable by its digest.
ENV_LOCK_PATH = "/opt/venv/.cyto-env-lock.txt"

#: The reserved output id the server looks for when it lifts this record into the
#: provenance row. A well-known id, matching how other per-run records already reach the
#: server.
OUTPUT_ID = "run-environment"


class DependencyRefusal(RuntimeError):
    """A NAMED refusal: the environment does not satisfy the entry's own declaration.

    Named, rather than a bare `ImportError` or an `AssertionError`, because the failure
    it reports is actionable and the bare forms are not: an import error names a module
    and nothing about why it was expected, and an assertion names a line. The message
    built here names the library, what was declared, what was resolved, and what to do.
    """


def normalize_name(raw):
    """Index-style distribution-name normalization: lowercase, and every run of `-`, `_`
    or `.` collapsed to a single `-`.

    Mirrors the build gate's `normalize_dist_name` exactly. Both sides need it for the
    same reason: a package index treats these spellings as one distribution, so a
    declaration and a pin that differ only in punctuation must still match — otherwise the
    gate rejects a correct declaration over a hyphen.
    """
    out = []
    last_sep = False
    for ch in str(raw).strip():
        if ch in "-_.":
            if not last_sep:
                out.append("-")
                last_sep = True
        else:
            out.append(ch.lower())
            last_sep = False
    return "".join(out).strip("-")


#: Where an unqualified `contract_path()` looks, when set. `None` in production and in
#: a reproduce capsule — both stage this module and the contract into the SAME `/code`
#: dir, so resolving relative to `__file__` is correct there and no override exists.
#:
#: The packages' pytest conftest sets it, because a test process is not a staged `/code`
#: dir: it imports these modules straight out of the source tree, so nothing has staged a
#: contract beside them. Note what this does and does not do — it relocates WHERE the
#: contract is read from; it does not relax WHAT is enforced. There is deliberately no
#: switch that turns the check off (see the module docstring), and the harness stages a
#: real contract that is really resolved and really checked.
DEFAULT_CODE_DIR = None

#: The out-of-process form of [`DEFAULT_CODE_DIR`], for the same reason and with the same
#: scope: the packages' suites run a compute entry as a SUBPROCESS, so a module attribute
#: set in the pytest process does not reach it.
#:
#: Why this is not an off switch in disguise. It relocates WHERE the contract is read
#: from; whatever is found there is resolved and range-checked exactly as always, and
#: there is no value of it that skips the check. It also cannot be set against a real run:
#: the sandbox launches the entry with a CLEARED environment, so nothing an operator or a
#: caller exports reaches the process — the same property that makes the tree's other
#: debug seams safe to honour in any build.
CODE_DIR_ENV = "CYTO_DEPS_CODE_DIR"


def contract_path(code_dir=None):
    """Where the staged contract lives.

    Defaults to the directory THIS module was staged into, which is the entry's `/code`
    dir — resolving relative to `__file__` rather than to a hardcoded absolute path keeps
    the module usable from a unit test and from a reproduce capsule, both of which stage
    the same files somewhere else.
    """
    if code_dir is None:
        code_dir = DEFAULT_CODE_DIR or os.environ.get(CODE_DIR_ENV) or None
    base = Path(code_dir) if code_dir is not None else Path(__file__).resolve().parent
    return base / CONTRACT_FILENAME


def load_contract(code_dir=None):
    """The declared `[{library, version}, ...]` for this entry.

    A MISSING contract file is an empty contract, not an error: entries that declare
    nothing are staged without one, and inventing a failure for them would make the
    mechanism impossible to adopt incrementally. A PRESENT but malformed one IS an error —
    it can only mean the staging wrote something the reader does not understand, and
    silently treating that as "declares nothing" is the exact failure mode this whole
    contract exists to remove.
    """
    path = contract_path(code_dir)
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text())
    except Exception as exc:
        raise DependencyRefusal(
            f"the staged dependency contract at `{path}` is not readable JSON ({exc}). "
            "A contract that cannot be read cannot be enforced; refusing rather than "
            "running as if nothing were declared."
        ) from exc
    if not isinstance(raw, list):
        raise DependencyRefusal(
            f"the staged dependency contract at `{path}` is not a list of declarations."
        )
    out = []
    for entry in raw:
        if not isinstance(entry, dict) or "library" not in entry or "version" not in entry:
            raise DependencyRefusal(
                f"malformed entry in the staged dependency contract at `{path}`: {entry!r}"
            )
        library, spec = str(entry["library"]), str(entry["version"])
        # FAIL CLOSED on a specifier that constrains nothing. `SpecifierSet("")` matches
        # EVERY version, so an empty (or whitespace) range would silently degrade the
        # check to a presence test — satisfied by any installed version, which is exactly
        # the non-enforcement this contract exists to remove. The BUILD gate refuses the
        # same input; this is the runtime half of that, and it matters because the
        # per-package RUNTIME scan (a folder dropped into a deployment) never passed
        # through the build gate at all.
        if not spec.strip():
            raise DependencyRefusal(
                f"the staged dependency contract at `{path}` declares `{library}` with an "
                "EMPTY version range. An empty range is satisfied by every version, so it "
                "would record a check that cannot fail; refusing rather than pretending "
                "to enforce it."
            )
        optional = entry.get("optional", False)
        # Strict, like every other field this loader checks. `bool("false")` is True, so a
        # lenient coercion would turn a REQUIRED declaration into an optional one and
        # silently drop the absent-means-refuse leg — the single most consequential thing
        # this flag controls. The server always writes a real bool; the per-package
        # runtime-scan path (a folder dropped into a deployment) does not go through it,
        # and that is the path the rest of this function's strictness exists for.
        if not isinstance(optional, bool):
            raise DependencyRefusal(
                f"the staged dependency contract at `{path}` declares `{library}` with a "
                f"non-boolean `optional` ({optional!r}). Coercing it would decide whether "
                "an absent library refuses the run, which is not a decision to make by "
                "truthiness."
            )
        out.append({"library": library, "version": spec, "optional": optional})
    return out


def _resolved_version(distribution):
    """The installed version of `distribution`, or `None` when it is not installed."""
    from importlib.metadata import PackageNotFoundError, version as _dist_version

    try:
        return _dist_version(distribution)
    except PackageNotFoundError:
        return None


def _satisfies(resolved, spec):
    """Does `resolved` satisfy the declared specifier set?

    Uses the reference implementation. The BUILD gate implements a deliberately narrower
    subset of the same grammar and fails closed outside it, so anything the build accepted
    is something this agrees with — the narrowing only ever goes one way.
    """
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version

    return Version(resolved) in SpecifierSet(spec)


def env_lock_digest(path=ENV_LOCK_PATH):
    """`sha256:<hex>` over the image's frozen full-closure lock, or `None` if absent.

    This is what makes the TRANSITIVE half of the environment recorded rather than
    invisible. The direct set is pinned and checked above; everything else that got
    installed is identified here by digest, so two runs whose declared libraries agree but
    whose closures differ are DISTINGUISHABLE in the provenance record instead of looking
    identical. `None` (an older image, or a non-sandbox context) is recorded as `None` —
    an honest "not available", never a fabricated digest.
    """
    p = Path(path)
    try:
        # NOT a symlink. `read_bytes()` follows one, and this path lives inside an image
        # built by whoever published it, so a link here would silently digest a file the
        # image does not contain. The shell reader (`scripts/env-lock-of.sh`) treats that
        # as disqualifying; there is no reading on which it is disqualifying for a human
        # and acceptable for a provenance row.
        if p.is_symlink():
            return None
        data = p.read_bytes()
    except Exception:
        return None
    # A LOCK WITH NO PACKAGE LINES IS NOT A LOCK, and this is the one place that used to
    # disagree. The docstring above promises "an honest 'not available', never a fabricated
    # digest" — but `sha256:e3b0c442…` for a ZERO-BYTE file is precisely a digest that
    # identifies nothing while looking exactly like an environment identity, and it lands
    # in `provenance_run_repro`. The recipe's writer refuses to emit such a file and the
    # shell reader refuses to print one; this now refuses to digest one, so all three
    # readers of this artefact agree about what counts as one.
    #
    # The rule is the shell reader's, deliberately: at least one line that is not a comment
    # and carries `<name>==<version>`.
    packages = 0
    for raw in data.split(b"\n"):
        line = raw.strip()
        if not line or line.startswith(b"#"):
            continue
        if b"==" in line:
            packages += 1
    if packages < 1:
        return None
    return "sha256:" + hashlib.sha256(data).hexdigest()


#: Memo for [`resolve_and_check`].
#:
#: A normal run calls it more than once — an entry that carries a report asks for the
#: resolved versions while assembling it, and EVERY entry reaches it again through
#: [`augment`] when the outputs manifest is committed. Memoizing makes the later calls
#: free, and makes the two answers identical by construction: a single run cannot report
#: one set of versions and record another.
#:
#: WHERE THE REFUSAL LANDS, stated precisely because an earlier version of this comment
#: claimed more than the code delivers. The check runs at report-assembly or at
#: manifest-write — i.e. AFTER the compute. It is a correctness gate, not a budget guard:
#: a job in a contradicting environment spends its budget and is then refused, rather than
#: publishing an untrustworthy result. Moving it earlier would need a call at the top of
#: each entry's `main()`; that is worth doing and is NOT done here (see the branch's
#: HUMAN_FEEDBACK). Nothing about the enforcement depends on where it is called from.
_MEMO = {}


def resolve_and_check(code_dir=None, lock_path=ENV_LOCK_PATH):
    """Resolve every declared library, ASSERT it against its declared range, and return
    the run's environment record.

    Raises [`DependencyRefusal`], naming the library, on the first declaration the
    environment does not satisfy — absent, or present at a version outside the range.

    Returns a dict shaped for the run record:

        {
          "declared": [{"library", "version", "resolved"}, ...],
          "libraries": {"<library>": "<resolved version>", ...},
          "env_lock_sha256": "sha256:…" | None,
          "python": "3.11.x",
        }

    `libraries` is the flat mapping the run reports already carried under
    `library_versions`, so the shape every existing report consumer reads is preserved —
    what changes is that it is now derived from the declaration and verified, instead of
    being a hand-typed list of best-effort attribute reads.
    """
    import sys

    # The key must name every input that decides WHICH contract is read. `code_dir=None`
    # is the production call, and it resolves through `contract_path()` against
    # `DEFAULT_CODE_DIR` / the env var — both mutable. Keying on the resolved PATH rather
    # than on the argument is what stops a process that re-points either between calls
    # from being handed the first contract's answer for the second contract's question.
    memo_key = (str(contract_path(code_dir)), str(lock_path))
    if memo_key in _MEMO:
        return _MEMO[memo_key]

    contract = load_contract(code_dir)
    declared = []
    libraries = {}
    for dep in contract:
        library, spec = dep["library"], dep["version"]
        resolved = _resolved_version(library)
        if resolved is None and dep.get("optional"):
            # An OPTIONAL declaration is "used when a parameter enables it". Absence is a
            # legitimate state the package handles with its own named refusal on the path
            # that needs it, so refusing here would break a documented fallback: a run that
            # never enables the feature would fail for a library it never touches. What is
            # NOT relaxed is the version: if it IS installed, it is range-checked below
            # exactly like a required one, because a run that DID use it is a run whose
            # result depends on it.
            declared.append({"library": library, "version": spec, "resolved": None,
                             "optional": True})
            continue
        if resolved is None:
            raise DependencyRefusal(
                f"this analysis declares the library `{library}` ({spec}), which is NOT "
                "installed in the environment this job was given. The environment image "
                "is fetched at run time and may predate the recipe that adds it: "
                "republish the analysis environment image (see "
                "docs/runbooks/env-image-republish.md), then re-run. Refusing rather than "
                "failing later with a bare import error."
            )
        try:
            ok = _satisfies(resolved, spec)
        except Exception as exc:
            raise DependencyRefusal(
                f"this analysis declares `{library} {spec}`, which could not be compared "
                f"against the resolved version `{resolved}` ({exc}). A range that cannot "
                "be evaluated cannot be enforced; refusing rather than assuming it holds."
            ) from exc
        if not ok:
            raise DependencyRefusal(
                f"this analysis declares `{library} {spec}`, but the environment this job "
                f"was given has `{library}=={resolved}` — OUTSIDE the declared supported "
                "range. Results produced against an unsupported version of a library this "
                "analysis depends on are not trustworthy, so the run is refused rather "
                "than published. Either the environment image is stale relative to the "
                "recipe (republish it), or the declaration is stale relative to a "
                "deliberate upgrade (reconcile it)."
            )
        entry = {"library": library, "version": spec, "resolved": resolved}
        if dep.get("optional"):
            entry["optional"] = True
        declared.append(entry)
        libraries[library] = resolved
    record = {
        "declared": declared,
        "libraries": libraries,
        "env_lock_sha256": env_lock_digest(lock_path),
        "python": "%d.%d.%d" % sys.version_info[:3],
    }
    _MEMO[memo_key] = record
    return record


def write_record(outputs_dir, record, datatype_layout, filename="run-environment.json"):
    """Write the environment record into the outputs dir and return the entry a compute
    appends to its outputs manifest.

    Emitted as a declared output with a reserved id, which is how a per-run record already
    reaches the server elsewhere in this codebase (the server finds it among the outputs it
    is handed and lifts its bytes into the run's provenance row). `hidden` because it is a
    provenance carrier, not a result a user chose to produce.

    ## Why `datatype_layout` is a REQUIRED argument and not a constant here

    This module is app-core infrastructure shared by every package, and app-core may not
    name a contributed domain's vocabulary. An earlier cut hard-coded the datatype id of
    one domain's report family, which made the whole dependency-contract mechanism
    unusable by a domain that does not ship that family — the exact coupling the
    architecture invariant exists to prevent, introduced by the one module that is shared
    by everyone. (Caught by `scripts/check-derived-vocabulary.sh`, which derives its
    forbidden set from `contributes.datatypes[].id` across the shipped manifests, so it
    knew the term was domain vocabulary without anyone writing it down.)

    A package DOES know its own output type, so it passes one — as the `(datatype, layout)`
    pair every one of these packages already uses for `output_entry`, so the call site
    reads like the ones beside it. There is deliberately no default: a default would be
    some domain's id, and it would silently become every future domain's id too.
    """
    datatype, layout = datatype_layout
    # Imported here, not at module scope, so the module's own floor stays stdlib-only:
    # `resolve_and_check` must be callable from a context that has staged nothing else.
    import cyto_columns

    outputs_dir = Path(outputs_dir)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    (outputs_dir / filename).write_text(json.dumps(record, indent=2, sort_keys=True))
    return {
        "id": OUTPUT_ID,
        "datatype": datatype,
        "path": filename,
        "layout": layout,
        "role": "artifact",
        "hidden": True,
        # The DECLARED structure, built by the shared format library rather than spelled
        # by hand: an artifact's `structure` column has no default, so "there is nothing
        # to decode, the media type is the whole story" is a statement the producer makes.
        # Hand-spelling it is how this shipped its first defect — an `encoding`-less
        # structure that `workstore::ingest` refuses at the manifest.
        "structure": cyto_columns.opaque("application/json"),
        "meta": {"kind": OUTPUT_ID},
    }


def record_for_run(outputs_dir, datatype_layout, code_dir=None, lock_path=ENV_LOCK_PATH):
    """The one call a compute entry makes: check, write, and hand back
    `(record, output_entry)`.

    The entry appends `output_entry` to its outputs manifest and folds
    `record["libraries"]` into its report under the key it already uses. Doing both in one
    call is deliberate — a compute that checked but did not record, or recorded but did not
    check, is exactly the half-wired state this replaces.
    """
    record = resolve_and_check(code_dir=code_dir, lock_path=lock_path)
    entry = write_record(outputs_dir, record, datatype_layout)
    return record, entry


def augment(outputs_dir, entries, datatype_layout, code_dir=None, lock_path=ENV_LOCK_PATH):
    """Check the environment and APPEND this run's environment record to `entries`.

    Called from every package's outputs-manifest writer, which is the one point every
    successful run passes through. That placement is what makes the mechanism WIRED rather
    than merely available: a compute cannot emit its outputs without also emitting the
    record of the environment that produced them, and there is no path where an entry
    "forgot" to record.

    It does not replace the EARLY call an entry makes to get the resolved versions for its
    report — that one exists so an unsatisfiable environment refuses before the compute
    spends its budget. The two share a memo, so calling both costs one resolution and
    cannot yield two different answers.

    An entry that declares nothing gets an empty record rather than no record: "this run
    declared no libraries" is a fact worth having in provenance, and it is a different
    fact from "this run predates the mechanism", which is what an absent record means.

    `entries` is mutated in place and also returned, so a caller can use either style.

    `datatype_layout` is the caller's `(datatype, layout)` pair — see [`write_record`] for
    why this module will not name one itself.
    """
    record = resolve_and_check(code_dir=code_dir, lock_path=lock_path)
    entries.append(write_record(outputs_dir, record, datatype_layout))
    return entries
