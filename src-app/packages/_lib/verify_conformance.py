#!/usr/bin/env python3
# ruff: noqa
"""verify_conformance — the VERIFICATION PROCESSOR that runs the framework gate (DEC-12).

## Why this file exists at all

`conformance.py` was built, tested, and invoked by nothing. DEC-12 settles WHERE it runs:
**a sandboxed verification job dispatched AFTER ingest**, not from the ingest path itself.
This is that job's entry.

The tempting shortcut — have the server shell out to a byte-reading checker during ingest —
keeps the ITEM-20 dependency guard green (the server BINARY still parses nothing) while
making the server's ingest decision depend on what the bytes MEAN. That is INV-1's letter
kept and its spirit bent, and this branch has already been burned once by a guard that
proved a weaker property than the invariant it was named for. The sandbox is where every
other byte-reading step in this system runs, so the gate runs there too.

## What it is handed, and by whom

`jobs::conformance` (the server) builds an `AnalysisSpec` in which:

* every artifact the run just ingested is an `artifact_ref` INPUT, hardlinked back out of
  the content-addressed store to `/inputs/<artifact-id>`. So the bytes gated here are the
  bytes that LANDED — what a consumer will actually read — not a staging copy that was
  about to be deleted.
* `/inputs/params.json` carries `{"outputs": [{"id": <artifact-id>, "path":
  "<artifact-id>", "structure": <the producer's declaration, verbatim>}]}` — the same shape
  `conform_outputs` reads off an emitted `/outputs/manifest.json`. The server COPIES the
  declaration it stored at ingest; it does not read, merge, or synthesize any part of it.

`id` is the artifact's UUID rather than its `output_id` so a violation is attributable to
ONE catalog row: the server marks exactly that row `failed`.

## What it emits

`/outputs/verdict.json`:

    {"schema": 1, "checked": [<artifact-id>…], "evidence": {<artifact-id>: {counters}},
     "violations": {<artifact-id>: [str…]}, "run_violations": [str…]}

and exits 1 when anything is non-conforming, 0 when nothing is — matching
`python3 -m conformance`, which likewise has no flag that makes a violation non-fatal. An
internal failure (the gate itself could not run) writes `{"error": …}` and exits 2, which
the server reports as INDETERMINATE rather than as a verdict about the artifacts: claiming
"these bytes disagree with their declaration" on the strength of a crashed checker would be
a false statement about data that may be perfectly fine.

## `checked` is EVIDENCE, not a restatement of the input

`checked` is the server's positive control: `jobs::conformance::run_gate` refuses a verdict
that does not account for every artifact it submitted, because "everything conformed" and
"the checker examined nothing" both serialize as an empty `violations` map, and the second
one read as the first is a green line for data nobody looked at.

**That control could not fire.** `checked` was built as `[e["id"] for e in
manifest["outputs"]]` — a list re-derived from the very document the SERVER wrote at
`jobs/conformance.rs::build_gate_manifest`. Stubbing `conform_manifest` to return `[]` was
reproduced end to end: the entry reported both submitted ids as checked, exited 0, and the
server logged *"OK — 2 artifact(s) verified against their declared structure"* for a gate
that had read nothing. The one safeguard against a vacuous verdict was itself vacuous.

So `checked` is now derived from `ManifestReport.examined` — the per-artifact
[`conformance.Evidence`] tally, incremented ONLY by the code that has just read the
artifact's bytes off disk (a container part read, a chunk decompressed, an `opaque` payload
read). It deliberately does NOT count declaration-level comparisons:
those are cheap metadata work that runs before the container walk, and while they counted,
stubbing `conformance._decode_shards` to `[]` still produced `checks: 10`, `checked: [the
artifact]`, `violations: {}` and exit 0 — a fully-accounted green verdict from a gate that
decoded nothing. `checks > 0` now means "at least one read of these bytes COMPLETED", with
no weaker quantity beside it.

**Earned by the read, not by reaching it.** Counting only byte-reading code was necessary
and not sufficient: `_decode_shards` recorded its receipt from `len(shards)` — a number
derived from the DECLARED grid — before the loop that opens anything, so an `n=0` member
(legal, and written by the real writer) reached `checks: 1, decoded_bytes: 0`,
`violations: {}`, exit 0 here. Every `Evidence` verb now takes the RESULT of a completed
act and is called on the line that completed it; see the class doc in `conformance.py`.

An artifact the gate neither read nor condemned is reported as a RUN-LEVEL violation
(exit 1) rather than silently omitted, so the honesty of the verdict does not depend on the
server also noticing. That is the INDETERMINATE channel, and it is where an artifact with
NOTHING TO READ lands by construction: an `n=0` member, an empty directory, and a
DIRECTORY-shaped `opaque` artifact (this suite reads no byte of one — its `opaque` claim is
established by LISTING the tree, and the content check applies to a file). The server
refuses such a verdict whole (`verdict_from_run` → `GateOutcome::Indeterminate`) and leaves
every row the status ingest gave it — not green, not condemned. Staying silent instead is
the vacuity this mechanism exists to make impossible.

A read the OS REFUSES (EACCES/EIO) does NOT land here: it is a violation of the artifact
that was being read, on a `zarr_v3` store exactly as on an `opaque` payload, and therefore
a condemnation. That is a false statement about data that may be perfectly fine, it is
known, and it is deliberate — two attempts to route it here instead were withdrawn, the
second because it discarded genuine violations already found on the same artifact and let
proven-bad bytes keep serving. `conformance.py`'s RECORDED LIMITATION block (above
`ManifestReport`) is the full account and the brief for a future fix.

"Does not land here" now includes a DIRECTORY a walk could not enumerate. It did not, at
any of the gate's THREE walk sites, and they failed open in two different spellings:

* the two store walks answered the fault with `continue`, which is a third channel neither
  this file nor that block describes — not a condemnation and not INDETERMINATE, but an
  unreadable subtree read as an EMPTY one. Measured against this entry, a conforming table
  with a `0o111` directory hiding an undeclared node and an unaccounted file exited **0**
  with `violations: {}` and a full receipt, where the identical store at `0o755` exits 1 and
  names both.
* the DEC-8 anti-bypass walk (`conformance._bytes_are_not_a_store`, which refutes an
  `opaque` declaration made over a real Zarr store) had no handler at all: it enumerated
  with `Path.rglob`, which silently skips a directory it cannot list. That one landed in the
  INDETERMINATE channel described above, and landing there is not a milder answer than
  condemnation — an `opaque`-declared store whose only `zarr.json` sat under a `0o111`
  subdirectory returned `violations: {}`, `checked: []`, `evidence: {}`, so the server left
  every row the status ingest gave it and the mis-declared store kept serving. At `0o755`
  the same artifact is condemned.

A verdict here is only ever "these bytes disagree", "the gate could not run", or "the gate
did not examine them"; there is no fourth answer, and a walk that skips what it cannot open
was inventing one. Nor may a walk reach the THIRD answer for a fault: "we did not examine
them" is for an artifact with nothing to read, not for one whose bytes were hidden from the
walk that was supposed to look.

A CONDEMNED artifact needs no receipt: a declaration this suite refuses on its face (no
`encoding`, an encoding it does not implement, bytes that are not a store at all) is
reached without opening a byte, and it is already named in `violations`, which is what the
server acts on. `jobs::conformance::GateVerdict::accounts_for` states the same rule on the
other side. The consequence both sides hold is the one that matters: a CLEAN verdict is
impossible without bytes read.

The raw counters ride along in `evidence` for the server's own check — `GateVerdict::
examined` reads `read_bytes`/`decoded_bytes` and refuses a receipt with neither, rather than
taking `checks` on trust — and `jobs::conformance::conclude` writes the run's totals, and
`violation_counts`, into its log record. That log record is the operator surface: this file
is deleted with the staging tree on every return path (`run_gate` → `cleanup` →
`discard_staging`), so a sentence pointing an operator at `verdict.json` would be pointing
at nothing.

There is deliberately NO `/outputs/manifest.json`. This job produces no artifacts; the
server drives it directly and never routes it through the ingest sink, so a produces-
manifest here would be a fiction that only invited someone to ingest a verdict.

## Its tests

`test_verify_conformance.py`, which did not exist: the MODULE this file calls was
thoroughly covered while the thing production actually dispatches was not, which is where
a wiring bug lives forever. It pins the parts of the contract only this file owns — the
three exit codes, `checked` (the server's positive control), `error` (the only way to say
"this is not a verdict"), and that the exhaustive depth is the one used.
"""
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

INPUTS = "/inputs"
OUTPUTS = "/outputs"
VERDICT = os.path.join(OUTPUTS, "verdict.json")

#: Cap on the violations reported per artifact. The gate returns EVERY violation by design
#: (an author fixing one and re-running to find the next is the slow loop it exists to
#: avoid), but a pathologically broken artifact could produce one per member, and this
#: verdict crosses a process boundary into a log line and a DB write. The count is reported
#: whole in `violation_counts`; only the strings are capped, so "how bad" is never lost.
#:
#: That sentence was FALSE for as long as it stood here. `jobs::conformance::GateVerdict`
#: declared no `violation_counts` field, so serde dropped the key on arrival and the true
#: count of an artifact with more than 50 violations survived nowhere at all — the one
#: number this cap exists to preserve. The field is declared on that struct now, and
#: `conclude` writes it into the run's log record; that record is what an operator reads,
#: because this file is deleted with the staging tree on every return path of `run_gate`.
#:
#: It was HALF false afterwards, for the same reason one map over: the same `[:50]` is
#: applied to `run_violations`, and `violation_counts` is built from the per-ARTIFACT map
#: only, so the run-level list was capped with no surviving total anywhere — and `conclude`
#: logged `run_violations = <the capped length>` as if it were the count. `run_violation_
#: count` below is that map's missing half. Both counts are now whole; only strings are
#: capped, on both.
MAX_VIOLATIONS_PER_ARTIFACT = 50


def _write(verdict):
    os.makedirs(OUTPUTS, exist_ok=True)
    with open(VERDICT, "w") as fh:
        json.dump(verdict, fh, indent=2)


def main():
    try:
        with open(os.path.join(INPUTS, "params.json")) as fh:
            manifest = json.load(fh)
    except Exception as exc:
        _write({"schema": 1, "error": f"cannot read /inputs/params.json: {exc}"})
        return 2

    try:
        import conformance
    except Exception as exc:  # pragma: no cover - a staging fault, not a data fault
        _write({"schema": 1, "error": f"the conformance module did not import: {exc}"})
        return 2

    try:
        # `full=True`: a verification pass that skips bytes is not a verification pass.
        report = conformance.conform_manifest(INPUTS, manifest, full=True)
    except Exception:
        _write({"schema": 1, "error": f"the gate raised:\n{traceback.format_exc()}"})
        return 2

    violations = {}
    run_violations = []
    for labels, violation in report:
        if not labels:
            run_violations.append(violation)
            continue
        for label in labels:
            violations.setdefault(str(label), []).append(violation)

    # `checked` comes from the gate's own tally of the work it did, never from the manifest
    # it was handed — see the module header for the vacuity this closes. `getattr` rather
    # than attribute access so a gate that returned a bare list yields NO evidence (and
    # therefore no `checked`) instead of an AttributeError that would read as exit 2.
    examined = getattr(report, "examined", None)
    if not isinstance(examined, dict):
        examined = {}
    submitted = [
        str(e.get("id"))
        for e in (manifest.get("outputs") or [])
        if e.get("id") is not None
    ]
    evidence = {
        aid: examined[aid]
        for aid in submitted
        if isinstance(examined.get(aid), dict)
        and int(examined[aid].get("checks") or 0) > 0
    }
    checked = [aid for aid in submitted if aid in evidence]
    # A submitted artifact is ACCOUNTED FOR when this run either read its bytes (`checks >
    # 0`) or named a violation against it. Those are the two ways a gate reaches a
    # conclusion; silence is neither. `jobs::conformance::GateVerdict::accounts_for` states
    # the identical rule on the server side, so the two halves agree by construction rather
    # than by inspection.
    unaccounted = [
        aid for aid in submitted if aid not in evidence and not violations.get(aid)
    ]
    if unaccounted:
        # Reported HERE, not left for the server to infer. An artifact the gate produced no
        # evidence of reading and no violation against has not been verified, and a verdict
        # that quietly omits it while exiting 0 is the vacuous pass this whole mechanism
        # exists to make impossible. This is also where an artifact with NOTHING TO READ
        # lands — see the header: the server turns it into INDETERMINATE, never a pass and
        # never a condemnation.
        #
        # LEADS the list, and does not merely join it. This is the run's coverage SUMMARY,
        # not one of its findings, and it was appended last — so `[:50]` dropped it first,
        # i.e. the single line whose job is to say "this batch was not examined" disappeared
        # exactly when the batch was worst. A report that loses its own summary at its worst
        # moment is the opposite of what it is for, so the cap now falls on the findings
        # behind it. (Nothing is displaced: the only other producer of a run-level violation
        # is "declares no outputs", which returns before this point, so the list this
        # prepends to is the per-artifact detail.)
        run_violations.insert(
            0,
            f"the gate produced no evidence of reading {len(unaccounted)} of "
            f"{len(submitted)} submitted artifact(s) ({unaccounted}) and named no violation "
            "against them — `checked` is built from counters that only COMPLETED reads "
            "increment (a container part read, a chunk decompressed, an `opaque` payload "
            "read), so an artifact with no evidence was NOT examined and "
            "must not be reported as conforming",
        )

    verdict = {
        "schema": 1,
        "checked": checked,
        "evidence": evidence,
        "violations": {
            k: v[:MAX_VIOLATIONS_PER_ARTIFACT] for k, v in violations.items()
        },
        "violation_counts": {k: len(v) for k, v in violations.items()},
        "run_violations": run_violations[:MAX_VIOLATIONS_PER_ARTIFACT],
        # The run-level half of `violation_counts`, and it did not exist: the list above is
        # capped and the map beside it is built from the per-ARTIFACT violations only, so the
        # true run-level total survived nowhere — while `conclude` logged the CAPPED length
        # as though it were the count. Emitted whole, and unconditionally, so the number the
        # server logs never depends on whether the cap happened to bite.
        "run_violation_count": len(run_violations),
    }
    _write(verdict)

    for label, vs in violations.items():
        for v in vs:
            print(f"conformance: {label}: {v}", file=sys.stderr)
    for v in run_violations:
        print(f"conformance: {v}", file=sys.stderr)
    if violations or run_violations:
        return 1
    print(f"conformance: OK ({len(checked)} artifact(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
