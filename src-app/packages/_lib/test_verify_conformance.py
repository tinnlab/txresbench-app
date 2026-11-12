#!/usr/bin/env python3
# ruff: noqa
"""The PRODUCTION gate entry — `verify_conformance.py` (ITEM-18 / DEC-12).

`jobs/conformance.rs:120` dispatches this file, by name, as the sandboxed verification
job; its `verdict.json` is what flips `artifacts.status` to `failed`. It had **no test**
at all — the module it calls was thoroughly covered, and the thing production actually
runs was not, which is the shape of gap where a wiring bug lives forever.

## What is asserted here that `test_conformance.py` cannot

That file tests `conform_manifest` as a function. This one tests the CONTRACT the server
reads:

  * the exit code (`0` conforms / `1` violations / `2` the gate could not run) — the
    server maps these onto three different actions, one of which is "touch nothing";
  * `checked`, which is the server's positive control (`run_gate` refuses a verdict that
    did not examine every artifact it submitted — an empty `violations` from a checker
    that looked at nothing is otherwise indistinguishable from a clean pass);
  * the `error` key, which is the ONLY way the job says "this is not a verdict about the
    bytes" — a crashed checker must never condemn data;
  * `full=True`, i.e. that the production entry uses the exhaustive depth. A verification
    pass that skips bytes is not a verification pass, and nothing pinned it.

The mount points are module constants (`/inputs`, `/outputs`) because that is what they
are inside the sandbox; each test redirects them at a tmp dir, which is the only thing
about this that is not the production path.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

import conformance
import txr_zarr as cz
import verify_conformance


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """A stand-in for the sandbox's `/inputs` + `/outputs` binds.

    Returns `(inputs, outputs)`; `run(...)` below drives the REAL `main()` against them.
    """
    inputs = tmp_path / "inputs"
    outputs = tmp_path / "outputs"
    inputs.mkdir()
    monkeypatch.setattr(verify_conformance, "INPUTS", str(inputs))
    monkeypatch.setattr(verify_conformance, "OUTPUTS", str(outputs))
    monkeypatch.setattr(verify_conformance, "VERDICT", str(outputs / "verdict.json"))
    return inputs, outputs


def run(sandbox, manifest=None, raw_params=None):
    """Write `/inputs/params.json` (or raw bytes) and run the entry → `(code, verdict)`."""
    inputs, outputs = sandbox
    if raw_params is not None:
        (inputs / "params.json").write_bytes(raw_params)
    elif manifest is not None:
        (inputs / "params.json").write_text(json.dumps(manifest))
    code = verify_conformance.main()
    verdict_path = outputs / "verdict.json"
    verdict = json.loads(verdict_path.read_text()) if verdict_path.exists() else None
    return code, verdict


def a_table(root, n=64, **kw):
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32", **kw)
        return t.close()


def entry(artifact_id, structure, path=None):
    """The manifest entry shape `jobs::conformance::build_gate_manifest` emits: the
    artifact's UUID as BOTH `id` and `path`, plus the producer's `structure` verbatim."""
    return {"id": artifact_id, "path": path or artifact_id, "structure": structure}


# ── exit 0: everything conforms ─────────────────────────────────────────────────


def test_a_conforming_run_exits_zero_and_accounts_for_every_artifact(sandbox):
    """The clean case, and the `checked` contract the server's positive control needs."""
    inputs, _ = sandbox
    ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
    manifest = {"outputs": [entry(i, a_table(inputs / i)) for i in ids]}

    code, verdict = run(sandbox, manifest)
    assert code == 0, verdict
    assert verdict["schema"] == 1
    assert verdict["violations"] == {} and verdict["run_violations"] == []
    assert "error" not in verdict, "a clean run makes a VERDICT, not an excuse"
    assert sorted(verdict["checked"]) == sorted(ids), (
        "`checked` must name every submitted artifact — it is the ONLY thing separating "
        "'everything conformed' from 'the checker looked at nothing', and `run_gate` "
        "refuses the verdict when it does not account for the batch"
    )


# ── exit 1: a verdict AGAINST the bytes ─────────────────────────────────────────


def test_a_non_conforming_artifact_is_named_and_the_conforming_one_is_not(sandbox):
    """Attribution is the whole point of this entry over the CLI: the server flips ONE
    row, so a verdict that cannot say WHICH row is useless to it.

    `bad`'s only shard file is DELETED, so the read of it raises and nothing of it is ever
    in hand. It is therefore condemned WITHOUT a receipt, and this test used to assert the
    opposite — `bad in verdict["checked"]` — which is the receipt-for-a-file-that-does-not-
    exist the container reader used to issue from `len(shards)` before opening anything
    (`checks: 1, shards: 1, decoded_bytes: 0`). A condemned artifact is accounted for by
    its violation, which is what `GateVerdict::accounts_for` and
    `test_a_CONDEMNED_artifact_needs_no_receipt` both already say.
    """
    inputs, _ = sandbox
    good = "33333333-3333-4333-8333-333333333333"
    bad = "44444444-4444-4444-8444-444444444444"
    manifest = {
        "outputs": [
            entry(good, a_table(inputs / good)),
            entry(bad, a_table(inputs / bad)),
        ]
    }
    (inputs / bad / "value" / "c" / "0").unlink()

    code, verdict = run(sandbox, manifest)
    assert code == 1
    assert list(verdict["violations"]) == [bad], verdict
    assert verdict["checked"] == [good], (
        "the conforming artifact must still be CHECKED — otherwise the server cannot "
        f"tell a clean row from an unexamined one — and the one whose bytes could not be "
        f"opened must NOT be: {verdict}"
    )
    assert verdict["evidence"][good]["chunks"] > 0 and bad not in verdict["evidence"], (
        f"the receipt belongs to the artifact that was read, and to no other: {verdict}"
    )
    assert verdict["run_violations"] == [], (
        "a CONDEMNED artifact is accounted for by its violation — raising the "
        f"unaccounted-for run violation here would cost the clean sibling its verdict: "
        f"{verdict}"
    )
    assert verdict["violation_counts"][bad] >= 1


def test_the_production_entry_uses_the_EXHAUSTIVE_depth(sandbox):
    """`full=True`, pinned on the entry rather than trusted from its docstring.

    The corruption below is in a MIDDLE shard, which the bounded depth deliberately does
    not read. If this entry ever passed `full=False` (or defaulted), the job would exit 0
    and the server would log "every ingested artifact conforms" over an artifact whose
    bytes do not decode.
    """
    inputs, _ = sandbox
    aid = "55555555-5555-4555-8555-555555555555"
    root = inputs / aid
    structure = a_table(root, n=200, inner_chunk=16, chunks_per_shard=2)
    shards = sorted((root / "value" / "c").iterdir(), key=lambda p: int(p.name))
    assert len(shards) >= 4, "the fixture must span several shards"
    middle = shards[len(shards) // 2]
    middle.write_bytes(middle.read_bytes()[:-64])

    # The premise: this corruption is INVISIBLE at the bounded depth.
    assert conformance.conform_artifact(root, structure, full=False) == []

    code, verdict = run(sandbox, {"outputs": [entry(aid, structure)]})
    assert code == 1, "the production gate must decode every byte, not a sample"
    assert any("does not decode" in v for v in verdict["violations"][aid]), verdict


def test_the_opaque_bypass_does_not_work_through_the_production_entry(sandbox):
    """The FINDING-1 bypass, driven the way production drives it.

    Relabelling a Zarr store `opaque` used to make every byte-level check skip. Asserted
    here as well as in `test_conformance.py` because a check that exists in the library
    and is not reached by the entry the server dispatches protects nothing.
    """
    inputs, _ = sandbox
    aid = "66666666-6666-4666-8666-666666666666"
    root = inputs / aid
    a_table(root, n=64)
    (root / "value" / "c" / "0").unlink()  # genuinely broken, and hidden by the relabel

    code, verdict = run(
        sandbox,
        {"outputs": [entry(aid, {"encoding": "opaque", "media_type": "text/html"})]},
    )
    assert code == 1, "a producer relabelled its store `opaque` and the gate went quiet"
    assert any("Zarr store" in v for v in verdict["violations"][aid]), verdict


def test_an_encodingless_structure_is_condemned_by_the_production_entry(sandbox):
    """The `{}` case at the layer that acts on it.

    `workstore::ingest` refuses an encoding-less `structure` at the manifest, so this is
    the backstop for a row that reached the catalog some other way — and it is what makes
    the two layers demonstrably agree rather than agree by inspection.
    """
    inputs, _ = sandbox
    aid = "77777777-7777-4777-8777-777777777777"
    (inputs / aid).write_bytes(b"bytes")
    code, verdict = run(sandbox, {"outputs": [entry(aid, {})]})
    assert code == 1
    assert any("declares no `encoding`" in v for v in verdict["violations"][aid]), verdict


def test_a_run_level_violation_is_not_attributed_to_an_artifact(sandbox):
    """A manifest declaring no outputs is a fault of the RUN. Attributing it to an
    artifact would make the server fail a row for something the row did not do."""
    code, verdict = run(sandbox, {"outputs": []})
    assert code == 1
    assert verdict["violations"] == {}
    assert verdict["run_violations"] and "declares no outputs" in verdict["run_violations"][0]
    assert verdict["checked"] == []


def test_the_violation_report_is_capped_but_the_COUNT_is_not(sandbox):
    """The verdict crosses a process boundary into a log line and a DB write, so the
    strings are capped — but capping the count too would understate how bad an artifact
    is, and "50 violations" would read the same as "500"."""
    inputs, _ = sandbox
    aid = "88888888-8888-4888-8888-888888888888"
    root = inputs / aid
    n = verify_conformance.MAX_VIOLATIONS_PER_ARTIFACT + 10
    with cz.Table(root, axis="rows", n=4) as t:
        for i in range(n):
            t.numeric(f"c{i}", np.arange(4, dtype=np.float32), dtype="float32")
        structure = t.close()
    # Every member is declared one dtype and stored as another → one violation each.
    for column in structure["columns"]:
        column["dtype"] = "float64"
    node = json.loads((root / "zarr.json").read_text())
    node["attributes"]["txr"] = structure
    (root / "zarr.json").write_text(json.dumps(node))

    code, verdict = run(sandbox, {"outputs": [entry(aid, structure)]})
    assert code == 1
    assert len(verdict["violations"][aid]) == verify_conformance.MAX_VIOLATIONS_PER_ARTIFACT
    assert verdict["violation_counts"][aid] == n, (
        "the CAP is on the strings only — the count reports how bad it actually is"
    )


def test_the_RUN_LEVEL_report_is_capped_but_its_COUNT_AND_SUMMARY_are_not(sandbox, monkeypatch):
    """The same cap on the other list, where it had neither.

    `run_violations` is truncated by the identical `[:50]` while `violation_counts` is built
    from the per-ARTIFACT map only, so the run-level total survived NOWHERE — and `conclude`
    logged `run_violations.len()`, the CAPPED length, as though it were the count. Worse, the
    coverage summary ("the gate produced no evidence of reading N of M") was appended LAST and
    was therefore the FIRST line dropped: the one line whose job is to say the batch was not
    examined disappeared exactly when the batch was worst.

    Both halves are asserted, because a fix to either alone still loses something an operator
    needs: the summary LEADS the list so the cap falls on the detail behind it, and
    `run_violation_count` reports the whole total the way `violation_counts` does.

    The report is substituted rather than provoked. `main()`'s input IS the ManifestReport,
    the untouched gate makes at most ONE run-level violation per run (measured), and every
    line under test here — the cap, the summary, the count — is the real one.
    """
    inputs, _ = sandbox
    ids = [f"{i:08d}-0000-4000-8000-000000000000" for i in range(3)]
    for aid in ids:
        (inputs / aid).mkdir()
    manifest = {"outputs": [entry(aid, {"encoding": "opaque"}) for aid in ids]}

    n = verify_conformance.MAX_VIOLATIONS_PER_ARTIFACT + 5
    monkeypatch.setattr(
        conformance,
        "conform_manifest",
        lambda *a, **k: conformance.ManifestReport(
            [([], f"run-level finding #{i}") for i in range(n)], {}
        ),
    )

    code, verdict = run(sandbox, manifest)
    assert code == 1
    assert len(verdict["run_violations"]) == verify_conformance.MAX_VIOLATIONS_PER_ARTIFACT
    assert verdict["run_violation_count"] == n + 1, (
        "the run-level count must survive the cap whole — `n` findings plus the coverage "
        f"summary. Got {verdict['run_violation_count']}"
    )
    assert any(
        "produced no evidence of reading" in v for v in verdict["run_violations"]
    ), (
        "the coverage summary must survive the cap. It is the line that says the batch was "
        "NOT examined, and appending it last made `[:50]` drop it precisely when the batch "
        f"was worst: {verdict['run_violations'][:2]}"
    )


# ── exit 2: NOT a verdict about the bytes ───────────────────────────────────────
#
# The distinction the server is built on: exit 1 means "these bytes disagree with their
# declaration" and flips rows to `failed`; exit 2 means "the gate could not run" and
# touches nothing. A checker that crashed and condemned everything would be making a
# false statement about data that may be perfectly fine — so every fault BELOW the level
# of the data must land here, and must carry `error`.


def test_a_missing_params_file_is_an_error_not_a_condemnation(sandbox):
    _, outputs = sandbox
    code = verify_conformance.main()
    verdict = json.loads((outputs / "verdict.json").read_text())
    assert code == 2
    assert "cannot read" in verdict["error"]
    assert verdict.get("violations", {}) == {}, (
        "a gate that could not read its own input must condemn NOTHING"
    )


def test_a_malformed_params_file_is_an_error_not_a_condemnation(sandbox):
    code, verdict = run(sandbox, raw_params=b"{ not json")
    assert code == 2 and "cannot read" in verdict["error"]
    assert verdict.get("violations", {}) == {}


def test_a_gate_that_raises_is_an_error_not_a_condemnation(sandbox, monkeypatch):
    """The internal-fault path. An exception out of the checker is a bug in the CHECKER;
    reporting it as a verdict would fail the producer's data for the framework's crash."""
    inputs, _ = sandbox
    aid = "99999999-9999-4999-8999-999999999999"
    a_table(inputs / aid)

    def boom(*_a, **_kw):
        raise RuntimeError("the gate fell over")

    monkeypatch.setattr(conformance, "conform_manifest", boom)
    code, verdict = run(sandbox, {"outputs": [entry(aid, {"encoding": "opaque"})]})
    assert code == 2
    assert "the gate raised" in verdict["error"] and "the gate fell over" in verdict["error"]
    assert verdict.get("violations", {}) == {}
    assert "checked" not in verdict, (
        "an error verdict must not also look like a completed examination"
    )


def test_the_entry_writes_no_outputs_manifest(sandbox):
    """This job produces no artifacts. A `/outputs/manifest.json` here would be a fiction
    that invites somebody to route the verdict through the ingest sink."""
    inputs, outputs = sandbox
    aid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    code, _ = run(sandbox, {"outputs": [entry(aid, a_table(inputs / aid))]})
    assert code == 0
    assert not (outputs / "manifest.json").exists()
    assert [p.name for p in outputs.iterdir()] == ["verdict.json"]


def test_the_entry_reads_only_the_manifest_it_is_handed(sandbox):
    """DEC-8 property 3, at the entry. A `manifest.yaml` sitting in `/inputs` (a package
    could ship one as data) and an environment variable are both inert: the only document
    consulted is `params.json`."""
    import os

    inputs, _ = sandbox
    aid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    root = inputs / aid
    a_table(root)
    (root / "value" / "c" / "0").unlink()
    manifest = {"outputs": [entry(aid, json.loads(json.dumps(
        conformance.txr_zarr_read.structure(root))))]}

    code, baseline = run(sandbox, manifest)
    assert code == 1 and baseline["violations"][aid]

    (inputs / "manifest.yaml").write_text("id: sneaky\nskip_conformance: true\n")
    for key in ("TXR_SKIP_CONFORMANCE", "SKIP_CONFORMANCE", "CONFORMANCE"):
        os.environ[key] = "0"
    try:
        code2, again = run(sandbox, manifest)
    finally:
        for key in ("TXR_SKIP_CONFORMANCE", "SKIP_CONFORMANCE", "CONFORMANCE"):
            os.environ.pop(key, None)
    assert (code2, again["violations"]) == (code, baseline["violations"]), (
        "a declared opt-out changed the production gate's verdict"
    )


# ── the anti-vacuity control must itself be able to fire ────────────────────────
#
# `checked` is the server's positive control: `run_gate` refuses a verdict that does not
# account for every artifact it submitted, because "everything conformed" and "the checker
# examined nothing" both serialize as an empty `violations` map. The control was VACUOUS —
# `checked` was `[e["id"] for e in manifest["outputs"]]`, re-derived from the document the
# SERVER wrote — so the one safeguard against a green line over unread data could not fire.


def test_a_gate_whose_CHECKER_IS_STUBBED_cannot_report_a_clean_verdict(sandbox):
    """THE DEFECT, driven exactly as it was reproduced.

    `conform_manifest` is stubbed to return `[]` — a gate that opened no file and compared
    no declaration. The real entry then reported `checked = [both ids]` and exited 0, and the
    server logged "OK — 2 artifact(s) verified against their declared structure".

    This is the OUTERMOST stub, and on its own it proves less than its old name
    ("…that READ NOTHING…") claimed: the stub replaces the function that CREATES the
    `Evidence` objects, so no evidence is the trivial outcome. The stub that actually
    tested the receipt is the one below.

    `checked` now comes from `ManifestReport.examined`, the per-artifact evidence tally kept
    by the code that reads the artifact's bytes, so a stub earns none of it.
    The unexamined artifacts are named as a RUN-LEVEL violation here rather than left for the
    server to infer: the honesty of the verdict must not depend on the other side also
    noticing.
    """
    inputs, _ = sandbox
    ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
    manifest = {"outputs": [entry(i, a_table(inputs / i)) for i in ids]}

    # POSITIVE CONTROL: the real gate over the same fixture accounts for both, with evidence.
    code, real = run(sandbox, manifest)
    assert code == 0 and sorted(real["checked"]) == sorted(ids), real
    for aid in ids:
        assert real["evidence"][aid]["checks"] > 0 and real["evidence"][aid]["chunks"] > 0, (
            "the tally must record real work — declarations compared AND chunks decoded — "
            f"or `checked` is back to being a restatement of the input: {real['evidence']}"
        )

    # THE STUB: a gate that read nothing.
    import conformance as conformance_mod

    saved = conformance_mod.conform_manifest
    conformance_mod.conform_manifest = lambda *a, **kw: []
    try:
        code, verdict = run(sandbox, manifest)
    finally:
        conformance_mod.conform_manifest = saved

    assert verdict["checked"] == [], (
        "a gate that examined nothing must report NOTHING as checked — this list is the "
        f"server's only positive control, and it used to be a copy of its own input: {verdict}"
    )
    assert verdict["evidence"] == {}, verdict
    assert code == 1, (
        "…and the run must not exit 0. A verdict that accounts for no artifact while "
        "reporting no violations is the vacuous pass this control exists to make impossible"
    )
    assert verdict["run_violations"] and all(
        aid in verdict["run_violations"][0] for aid in ids
    ), f"the unexamined artifacts must be NAMED: {verdict['run_violations']}"


def test_a_gate_that_KEPT_ITS_RECEIPT_AND_DROPPED_THE_READ_reports_no_clean_verdict(
    sandbox,
):
    """THE SECOND VACUITY, at the depth that actually mattered — the container reader.

    `test_a_gate_whose_CHECKER_IS_STUBBED…` stubs the OUTERMOST function, which also
    removes the code that creates the evidence, so it could never fail. The replacement
    written for it repeated the flaw one level down: it stubbed `_decode_shards` to
    `lambda *a, **kw: []`, which deletes the function that reads the shards AND the
    `_note(evidence, "walked", …)` inside it — proving only "no recorder ⇒ no receipt",
    never "no read ⇒ no receipt".

    The stub here is the REGRESSION SHAPE instead: it keeps the receipt exactly as the
    reader used to issue it — from `len(shards)`, the count the DECLARED grid implies —
    and drops the read. Measured on the code as it was, over this same fixture and this
    same entry: `checks: 1, shards: 1, chunks: 0, decoded_bytes: 0`, `checked: [both
    ids]`, `violations: {}`, **exit 0** — a fully-accounted green verdict from a gate that
    opened no file.

    It cannot report one now. There is no `Evidence` verb that takes a count of container
    parts: the receipt for a container part is [`Evidence.container`], which is handed THE
    BYTES the read returned, so a receipt is unavailable above the `read_bytes()` that
    obtains them. The stub's call names a verb that no longer exists, which is a fault in
    that member's reader and is reported as that member's violation.

    What this does NOT prove, said plainly rather than implied: a stub can still hand
    `Evidence` a fabricated argument (`decoded(4096)` from a function that decompressed
    nothing). No arrangement of a recorder inside the process it measures can prevent
    that, and the value of the test is in the shape a real refactor takes — announcing
    work from the plan instead of from the disk — not in defeating a determined forgery.
    `test_an_artifact_with_NOTHING_TO_READ_is_not_reported_as_conforming` covers the same
    property with NO stub at all, on the real reader.
    """
    inputs, _ = sandbox
    ids = ["3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c", "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d"]
    manifest = {"outputs": [entry(i, a_table(inputs / i)) for i in ids]}

    # POSITIVE CONTROL: the same fixture, same entry, container reader intact.
    code, real = run(sandbox, manifest)
    assert code == 0 and sorted(real["checked"]) == sorted(ids), real
    for aid in ids:
        assert real["evidence"][aid]["chunks"] > 0 and real["evidence"][aid]["checks"] > 0, real
        assert real["evidence"][aid]["shards"] > 0 and real["evidence"][aid]["read_bytes"] > 0, (
            "the receipt records the shard bytes that were actually read off disk, so a "
            f"reader that opened nothing cannot produce it: {real['evidence']}"
        )

    import conformance as conformance_mod

    def receipt_but_no_read(root, path, meta, shards, *, evidence=None):
        """The pre-fix body with its loop removed: announce, then read nothing."""
        shards = list(shards)
        conformance_mod._note(evidence, "walked", len(shards))
        dtype = np.dtype(meta["data_type"]).newbyteorder("<")
        n = int(meta["shape"][0])
        width = meta["shape"][1] if len(meta["shape"]) == 2 else None
        return np.zeros(n if width is None else n * int(width), dtype=dtype)

    saved = conformance_mod._decode_shards
    conformance_mod._decode_shards = receipt_but_no_read
    try:
        code, verdict = run(sandbox, manifest)
    finally:
        conformance_mod._decode_shards = saved

    assert code != 0, (
        "a gate whose container reader read nothing must NOT exit 0 — this is the "
        f"vacuous green verdict the receipt exists to make impossible: {verdict}"
    )
    assert verdict["checked"] == [] and verdict["evidence"] == {}, (
        "…and it must claim NOTHING as checked. The values it returned and the "
        f"declaration-level comparisons that ran are not evidence of a read: {verdict}"
    )
    assert all(aid in verdict["violations"] for aid in ids), (
        f"the artifacts whose reader read nothing must be named: {verdict}"
    )


def test_an_artifact_with_NOTHING_TO_READ_is_not_reported_as_conforming(sandbox):
    """The same property as above, on the REAL reader, with nothing stubbed at all.

    An `n=0` member writes a real, EMPTY `c/` — a legal shape the writer emits and
    `test_conformance.py::test_an_underivable_grid_is_refused_even_with_an_EMPTY_chunk_plane`
    asserts conforms — so `_shard_plan` returns `[]` and the reader's loop never runs.
    The reader used to announce `len(shards)` above that loop, so this exact artifact
    measured `checks: 1, shards: 0, chunks: 0, decoded_bytes: 0`, `checked: [the
    artifact]`, `violations: {}` and **exit 0** through this entry: a fully-accounted
    green verdict over zero bytes, from production code, with no stub anywhere.

    Neither answer available to a gate that read nothing is "conforms". It is not
    CONDEMNED either — an empty table is legitimate data and marking it `failed` would be
    a false statement about it — so it lands in the third state: unaccounted-for here
    (exit 1, named in `run_violations`, `violations` empty), which
    `jobs::conformance::verdict_from_run` refuses whole, leaving the row the status ingest
    gave it. The Rust half of that landing is pinned by
    `a_conformed_outcome_implies_every_artifact_was_read`.
    """
    inputs, _ = sandbox
    empty = "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f"
    read_me = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a"
    manifest = {
        "outputs": [
            entry(empty, a_table(inputs / empty, n=0)),
            entry(read_me, a_table(inputs / read_me, n=64)),
        ]
    }
    assert list((inputs / empty / "value" / "c").iterdir()) == [], (
        "the fixture's premise: an `n=0` member writes a real but EMPTY chunk plane"
    )
    assert conformance.conform_artifact(
        inputs / empty, manifest["outputs"][0]["structure"], full=True
    ) == [], "…and it is LEGAL — nothing about it disagrees with its declaration"

    code, verdict = run(sandbox, manifest)
    assert code == 1, f"a run the gate could not account for must not exit 0: {verdict}"
    assert verdict["violations"] == {}, (
        f"…and legitimate empty data must not be CONDEMNED for it: {verdict}"
    )
    assert verdict["checked"] == [read_me], (
        "only the artifact whose bytes were actually read earns a receipt — the positive "
        f"control that keeps this from passing on a gate that reads nothing at all: {verdict}"
    )
    assert empty not in verdict["evidence"], verdict
    assert verdict["run_violations"] and empty in verdict["run_violations"][0], (
        f"the artifact nothing was read for must be NAMED: {verdict['run_violations']}"
    )


def restamp(root, structure):
    """Rewrite the group's stamped declaration so a test that edits the RETURNED structure
    is testing the check it means to, not tripping the group/row drift check first."""
    node = json.loads((Path(root) / "zarr.json").read_text())
    node["attributes"]["txr"] = structure
    (Path(root) / "zarr.json").write_text(json.dumps(node, indent=2, ensure_ascii=False))


def a_wide_table(root, n=64):
    """A table with THREE members, so a fault can be staged on one and a refutation on
    another. `a_table` above has a single member, which cannot express that pair."""
    with cz.Table(root, axis="rows", n=n) as t:
        t.numeric("value", np.arange(n, dtype=np.float32), dtype="float32")
        t.categorical("group", codes=[i % 3 for i in range(n)], levels=["a", "b", "c"])
        t.string("label", [f"row-{i:05d}" for i in range(n)])
        return t.close()


@pytest.mark.skipif(
    os.getuid() == 0,
    reason="mode 000 does not stop uid 0 reading the file, so the fault cannot be staged",
)
@pytest.mark.parametrize("target", ["group", "member", "shard"])
def test_an_UNREADABLE_member_is_a_VIOLATION_OF_THAT_ARTIFACT(sandbox, target):
    """THE REINSTATED RULE, pinned: an OS fault on an artifact's bytes CONDEMNS it.

    This is a deliberate over-condemnation and it is written down as one — see the RECORDED
    LIMITATION block in `conformance.py`, above `ManifestReport`. A `chmod 000` says nothing
    about whether these bytes agree with their declaration, and answering it with
    `violations[aid]` makes `apply_verdict` write `status = 'failed'`, after which
    `consume::ConsumableArtifact` refuses every serve/stage/promote path until someone edits
    the catalog by hand.

    It is pinned rather than tolerated because the two attempts to do better BOTH shipped a
    worse defect (round 22's asymmetry, round 24's HIGH — see the sibling test below), and a
    third attempt must therefore fail loudly here rather than land quietly. Whoever changes
    this line is changing the module's failure DIRECTION: a false condemnation is visible and
    recoverable (`status='failed'`, fix the mode, re-run), a false pass is silent and leaves
    proven-bad bytes serving.

    All three read targets are driven because each has its own `except OSError` — they
    disagreed with one another for a whole round, which is the other thing that must not
    come back.
    """
    inputs, _ = sandbox
    aid = "3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d"
    structure = a_table(inputs / aid)
    denied = {
        "group": inputs / aid / "zarr.json",
        "member": inputs / aid / "value" / "zarr.json",
        "shard": sorted((inputs / aid / "value" / "c").iterdir())[0],
    }[target]
    denied.chmod(0o000)
    try:
        assert not os.access(denied, os.R_OK), "the fixture's premise"
        code, verdict = run(sandbox, {"outputs": [entry(aid, structure)]})
    finally:
        denied.chmod(0o644)

    assert code == 1, f"a fault must never exit 0: {verdict}"
    assert list(verdict["violations"]) == [aid], (
        "the fault is attributed to the ARTIFACT — that is the channel `apply_verdict` "
        f"turns into `status='failed'`, and it is the reinstated rule: {verdict}"
    )
    # `Permission denied` and not `PermissionError`: the three sites format the exception
    # differently (two interpolate `type(exc).__name__`, `_read_member_node` interpolates
    # only `{exc}`), and the errno text is the part all three genuinely carry.
    assert any("Permission denied" in v for v in verdict["violations"][aid]), (
        f"…and the violation names what actually happened: {verdict['violations'][aid]}"
    )


@pytest.mark.skipif(
    os.getuid() == 0,
    reason="mode 000 does not stop uid 0 reading the file, so the fault cannot be staged",
)
def test_an_OS_FAULT_never_erases_a_GENUINE_violation_already_found(sandbox):
    """THE ROUND-24 HIGH, pinned so it cannot come back silently.

    The withdrawn `_IoFault` doctrine caught the fault at `conform_manifest`'s per-artifact
    seam and `continue`d, and `conform_artifact` accumulates its violations in a local list
    that a raise from a LATER reader throws away with the frame. Measured through this exact
    entry: `value` stored `float32` and declared `float64` — a genuine, refuted artifact —
    reported `violations: {<aid>: ["… declared 'float64' but stored as 'float32'"]}`; add
    `chmod 000` to one shard of the UNRELATED `group` member and `violations` became `{}`.
    The server's `verdict_from_run` then refused the whole verdict, `conclude` returned
    `Indeterminate`, no status was written, and a demonstrably non-conforming artifact kept
    `status = 'ready'` and kept serving.

    So the fault and the refutation are staged on DIFFERENT members on purpose: any future
    attempt to give an OS fault its own channel has to carry the violations that were
    already in hand, and this is the shape that catches one that does not.

    The control below is the other half — the same artifact WITHOUT the fault must report
    the same genuine violation, or this test would pass on a gate that condemns everything.
    """
    inputs, _ = sandbox
    aid = "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c"
    root = inputs / aid
    structure = a_wide_table(root)
    # THE GENUINE VIOLATION, on `value`: stored float32, declared float64.
    structure["columns"][0]["dtype"] = "float64"
    restamp(root, structure)
    mismatch = "declared 'float64' but stored as 'float32'"

    code, control = run(sandbox, {"outputs": [entry(aid, structure)]})
    assert code == 1 and any(mismatch in v for v in control["violations"].get(aid, [])), (
        f"the control: the mismatch is refuted when nothing is unreadable: {control}"
    )

    # THE FAULT, on a DIFFERENT member — nothing to do with the mismatch above.
    denied = sorted((root / "group" / "c").iterdir())[0]
    denied.chmod(0o000)
    try:
        assert not os.access(denied, os.R_OK), "the fixture's premise"
        code, verdict = run(sandbox, {"outputs": [entry(aid, structure)]})
    finally:
        denied.chmod(0o644)

    assert any(mismatch in v for v in verdict["violations"].get(aid, [])), (
        "an I/O fault on ONE member must not erase a refutation already established on "
        f"another — that is round 24's HIGH, and it left bad bytes serving: {verdict}"
    )
    assert code == 1, f"and the run must not exit 0: {verdict}"


def test_a_corrupt_shard_is_still_condemned(sandbox):
    """The negative control for both tests above, so the rule cannot become "condemn
    everything" or "condemn nothing".

    A truncated shard raises `ValueError` out of `_decode`'s blanket `except Exception`.
    That IS a statement about the bytes and must condemn — it is also the reason a future
    fault predicate cannot key on the exception CLASS, since `gzip.BadGzipFile` reaches the
    same clause and subclasses `OSError`.
    """
    inputs, _ = sandbox
    aid = "4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e"
    structure = a_table(inputs / aid)
    sorted((inputs / aid / "value" / "c").iterdir())[0].write_bytes(b"\x00" * 8)

    code, verdict = run(sandbox, {"outputs": [entry(aid, structure)]})
    assert code == 1 and any(
        "does not decode" in v and "ValueError" in v for v in verdict["violations"][aid]
    ), f"a corrupt shard is a fact about the bytes and must still be condemned: {verdict}"


def test_a_DIRECTORY_shaped_opaque_artifact_is_not_reported_as_conforming(sandbox):
    """The receipt is earned by a READ, and a directory LISTING is not one.

    `Evidence` had a fourth verb, `enumerated`, which took the number of entries
    `_bytes_are_not_a_store`'s tree walk had seen. That walk opens no file, and
    `_opaque_bytes_agree_with_media_type` returns early for a non-file root, so a
    directory-shaped `opaque` artifact reached a FULL receipt having read nothing:
    measured through this entry, `checks: 1, shards: 2, chunks: 0, decoded_bytes: 0,
    read_bytes: 0`, `checked: [the artifact]`, `violations: {}`, **exit 0** — and the
    server's real `verdict_from_run` + `conclude` turned that document into
    `GateOutcome::Conformed{checked: 1}`.

    Both shapes below are asserted because the old rule was inconsistent with ITSELF: an
    `opaque` FILE of 0 bytes landed INDETERMINATE while an `opaque` DIRECTORY holding one
    EMPTY subdirectory landed CONFORMED, and both read exactly zero bytes.

    `readable` is the positive control that keeps this from passing on a gate that stopped
    reading altogether.
    """
    inputs, _ = sandbox
    with_bytes = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f"
    with_empty_subdir = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a"
    readable = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b"
    html = {"encoding": "opaque", "media_type": "text/html"}

    (inputs / with_bytes).mkdir()
    (inputs / with_bytes / "blob.bin").write_bytes(b"\x00" * 4096)
    (inputs / with_bytes / "report.html").write_text("<html>twenty-one b</html>")
    (inputs / with_empty_subdir / "sub").mkdir(parents=True)
    (inputs / readable).write_text("<html>read me</html>")

    code, verdict = run(
        sandbox,
        {
            "outputs": [
                entry(with_bytes, html),
                entry(with_empty_subdir, html),
                entry(readable, html),
            ]
        },
    )
    assert verdict["checked"] == [readable], (
        "only the artifact whose bytes were actually READ earns a receipt; a tree walk "
        f"lists entries and opens nothing: {verdict}"
    )
    assert verdict["evidence"][readable]["read_bytes"] > 0, (
        f"the positive control: the file-shaped artifact is still read: {verdict}"
    )
    assert verdict["violations"] == {}, (
        f"neither directory disagrees with its declaration — do not condemn them: {verdict}"
    )
    assert code == 1 and verdict["run_violations"], (
        f"…and the two nothing was read for are reported, not silent: {verdict}"
    )
    named = verdict["run_violations"][0]
    assert with_bytes in named and with_empty_subdir in named, (
        f"both unread artifacts must be NAMED: {verdict['run_violations']}"
    )


def test_a_CONDEMNED_artifact_needs_no_receipt(sandbox):
    """The other side of the same rule, so the fix cannot be "require evidence, always".

    An `encoding` this suite does not implement is refusable on the FACE of the
    declaration: the gate reaches its conclusion without opening a byte, so it earns no
    evidence and never appears in `checked`. It must still be CONDEMNED — a verdict that
    demoted this to "unaccounted for" would make the whole batch indeterminate on the
    server, leaving the artifact serving as `ready`, which is worse than the vacuity the
    receipt closes.
    """
    inputs, _ = sandbox
    aid = "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e"
    (inputs / aid).write_bytes(b"some bytes")

    code, verdict = run(
        sandbox, {"outputs": [entry(aid, {"encoding": "parquet"})]}
    )
    assert code == 1
    assert any("unknown encoding" in v for v in verdict["violations"][aid]), verdict
    assert verdict["checked"] == [] and verdict["evidence"] == {}, (
        f"the gate opened no byte of it, and must not say otherwise: {verdict}"
    )
    assert verdict["run_violations"] == [], (
        "a condemned artifact is accounted for by its violation; adding an "
        f"unaccounted-for run violation would turn a VERDICT into a non-verdict: {verdict}"
    )


def test_the_evidence_tally_is_per_artifact_and_tracks_the_work(sandbox):
    """The tally is not a boolean dressed up: a bigger artifact records more work.

    Two artifacts in one run, one an order of magnitude longer than the other. If `evidence`
    were synthesized from the manifest (the defect) both entries would be identical, so the
    inequality is the discriminator that a constant cannot satisfy.
    """
    inputs, _ = sandbox
    small = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    large = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    manifest = {"outputs": [
        entry(small, a_table(inputs / small, n=8)),
        entry(large, a_table(inputs / large, n=5000)),
    ]}
    code, verdict = run(sandbox, manifest)
    assert code == 0, verdict
    assert (
        verdict["evidence"][large]["decoded_bytes"]
        > verdict["evidence"][small]["decoded_bytes"]
    ), f"the tally must reflect the bytes actually decoded: {verdict['evidence']}"


def test_one_unreadable_artifact_does_not_cost_its_SIBLING_a_verdict(sandbox):
    """The batch abort. One artifact raising used to take the whole run's verdict with it.

    A `zarr_v3` declaration over a plain FILE makes `read_meta` raise `NotADirectoryError`,
    which is an `OSError` and NOT a `FileNotFoundError` — the clause that was caught — so the
    exception escaped `conform_manifest`, the entry wrote `{"error": …}` and exited 2, and the
    perfectly good sibling got NO verdict at all (the server leaves an indeterminate batch
    untouched, so the broken artifact stayed `ready` too).

    Each artifact is now checked in isolation: the raise is that artifact's violation — the
    same judgement every inner check in the module already makes — and the sibling is
    examined and reported clean.

    `bad` is deliberately NOT in `checked`. Its bytes are not a store, so the gate read
    none of them, and `checks > 0` means "these bytes were read" — claiming it as examined
    would be the fiction `Evidence` exists to prevent. It does not need a receipt to be
    acted on: it is named in `violations`, which is what condemns it, and the entry only
    raises the unaccounted-for RUN violation for an artifact that is neither read nor
    condemned. That is asserted here rather than left implicit, because "the gate cannot
    open these bytes" turning the whole batch INDETERMINATE would leave the broken artifact
    serving as `ready` — the exact outcome this test was written about.
    """
    inputs, _ = sandbox
    good = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a"
    bad = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b"
    structure = a_table(inputs / good)
    (inputs / bad).write_bytes(b"not a store at all")
    manifest = {"outputs": [entry(good, structure), entry(bad, dict(structure))]}

    code, verdict = run(sandbox, manifest)
    assert code == 1, (
        "the run reached a VERDICT (exit 1), not an internal failure (exit 2): one "
        f"artifact's bytes not being what it declared is a fact about that artifact. {verdict}"
    )
    assert "error" not in verdict, (
        f"one bad artifact must not turn the whole batch into a non-verdict: {verdict}"
    )
    assert verdict["checked"] == [good], (
        f"the innocent sibling was read and keeps its verdict; the artifact whose bytes "
        f"could not be opened earns no receipt for them: {verdict}"
    )
    assert list(verdict["violations"]) == [bad], (
        f"…and only the broken one is condemned: {verdict['violations']}"
    )
    assert verdict["run_violations"] == [], (
        "a CONDEMNED artifact is accounted for by its violation, not by a receipt — "
        f"raising the unaccounted-for run violation here would make the batch, and the "
        f"innocent sibling with it, INDETERMINATE: {verdict['run_violations']}"
    )
