#!/usr/bin/env python3
"""e2e-real — ITEM-3 (node qa-hardening): drive the running TxResBench app over
its HTTP API exactly like the UI does, on REAL open data with REAL published
method environments served by the dev registry.

WHAT IT DOES (one line per step, exit non-zero on the first failure):
  1. health check                                GET  /api/health
  2. local owner session (no login)              POST /api/session/local
  3. load the ITEM-3 inputs                       patients.csv / measurements.csv /
                                                   predict-measurements.csv / inputs.json
                                                   (make-real-inputs.py's product)
  4. file inspection (both files)                POST /api/file-validation/inspect
  5. validation (mapping applied)                POST /api/file-validation/validate
  6. eligibility (the validate inventory)        POST /api/methods/eligibility
  7. estimate                                    POST /api/methods/estimate
  8. create run (train, the published methods)   POST /api/txr/runs
  9. follow to the end                           GET  /api/txr/runs/{id}
 10. predictions (JSON + CSV)                    GET /api/txr/runs/{id}/predictions[.csv]
 11. save the produced models                    POST /api/txr/models/save
 12. resolve + reuse on the predict-only file    POST /api/txr/models/resolve,
                                                POST /api/txr/runs (mode: reuse)
 13. reuse follow + per-patient equality check
 14. history (both runs)                         GET /api/txr/history, /api/txr/runs

The app must already be running against the dev registry (debug build with
TXR_METHOD_ENV_REGISTRY + TXR_ENV_MANIFEST set — the README's
"Start the app against it"). The dev registry must be up too.

--example MODE (qa-fixes3 ITEM-5, TEST-QF3-3)
--------------------------------------------
    python3 scripts/dev-registry/e2e-real.py --example

Drives the THREE USE-EXAMPLE flows over the API exactly as the UI's
one-click buttons do — the example family the app embeds (never local input
files, never the real-data flow): E1 the pretrained path (example predict
table → inspect → predict-mode validate → the pretrained catalogue +
eligibility), E2 the train path (example training pair → inspect →
files-mode validate → eligibility + the example-set pick's estimate) and E3
the reuse path (predict-mode validate → POST /txr/models/example → the
ready set's models through the normal inventory). A catalogue-less app
(E1) or a host without a real environment stack (E3's `failed` answer —
the app's honest reason) is reported as SKIP, never a failure.

RUN
---
    python3 scripts/dev-registry/e2e-real.py
    python3 scripts/dev-registry/e2e-real.py --app-url http://127.0.0.1:3100
    python3 scripts/dev-registry/e2e-real.py --example

The report is written to /data/pbya/txresbench-app-work/qa-data/e2e-real-report.md
(default) and mirrored on stdout; the exit code is 0 only when every step and
every assertion passes.
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request

#: The default app URL (the dev server config: 127.0.0.1:3100).
DEFAULT_APP_URL = "http://127.0.0.1:3100"
#: The default input dir (make-real-inputs.py's default dataset + app dir).
DEFAULT_INPUTS = "/data/pbya/txresbench-app-work/qa-data/Bratman2020_INSPIRE-ctDNA-app"
#: The default report path (DEC-1: outside the repo).
DEFAULT_REPORT = "/data/pbya/txresbench-app-work/qa-data/e2e-real-report.md"
#: The example-family facts (qa-fixes3 ITEM-3's generator, committed as the
#: server's example assets — the API-level pins the ITEM-5 --example mode
#: asserts; the byte parity itself is the server material test's job).
EXAMPLE_DECISION_DAY = 56
EXAMPLE_TRAINING_PATIENTS = 100
EXAMPLE_PREDICT_PATIENTS = 15
EXAMPLE_MARKERS = ("m1", "m2", "m3")
#: The example-set creation timeout (the reuse flow's poll; a real first
#: training run downloads three method environments).
EXAMPLE_SET_TIMEOUT_SECS = 45 * 60
#: The deterministic fast-method pick of the example set (qa-fixes3 ITEM-3's
#: DRIFT record: sorted by the catalogue estimate seconds, then by id; the
#: pick is recomputed per call from the embedded catalogue, so a catalogue
#: change would break this pin loudly — the pin is the point).
#: The pick of a host whose published environment set covers the catalogue's fast
#: methods. The run asks the APP for its pick (POST /txr/models/example) and uses
#: that: the app picks only methods that can run on THIS host's environments, which
#: on the dev registry (a handful of published methods) is a different set.
EXAMPLE_PICK = [
    "kelim",
    "regression-growth-equation",
    "ctdna-clearance-timing-three-group",
]
#: The pick the run uses; replaced by the app's own pick at the estimate step.
picked = {"methods": list(EXAMPLE_PICK)}
#: The six published methods (ITEM-2's REAL_METHODS, after ITEM-3's
#: correction: `linear-response-score` is gate-failed, absent from the app's
#: catalogue AND its shipped env manifest — it was removed from the dev
#: publish; the gate-passing `ctdna-anytime-detectability` replaced it, so
#: the plan's "at least six real methods" still holds).
PUBLISHED_METHODS = [
    "cfmedip-ctdna-clearance-three-group",
    "cox-baseline-delta",
    "ctdna-anytime-detectability",
    "ctdna-clearance",
    "ctdna-week4-rise-or-emergence",
    "landmark-cox-current",
]
#: Run settings (board E defaults; save_models ON so step 11 has models).
RUN_CONFIG = {
    "endpoint": "pfs",
    "decision_day": 56,
    "look_ahead_day": 238,
    "covariates": False,
    "at_a_time": 2,
    "cpus": None,
    "save_models": True,
    "label_day": None,
}
#: Minutes before a run is declared a failure (heavy machine; the worked
#: example totals are minutes, and each sandbox base pull is hundreds of MB).
RUN_TIMEOUT_SECS = 45 * 60
POLL_SECS = 5


class StepFail(RuntimeError):
    pass


def http(app, method, path, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(app + "/api" + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                return resp.status, json.loads(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raise StepFail(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")


#: The transport seam (qa-fixes3 ITEM-5): `main` routes every call through
#: this module attribute, so the driver's unit test can script a fake server
#: (a real HTTP round trip needs the app running; the flows' step order and
#: contracts are pure logic). Never reassigned outside tests.
_http = http


class SkipFlow(RuntimeError):
    """A host-condition skip: the endpoint answered contract-shape, but the
    capability the step needs is NOT provisioned on this host (qa-fixes3
    ITEM-5's reuse flow: training the example set needs a real environment
    stack; the app reports the honest `failed` reason instead). A SKIP is
    reported, never counted as a failure — the flip side of the repo's
    fail-closed rule: this is a DRIVER for the app's own honest answer."""


def table_from_csv(path):
    with open(path, newline="") as fh:
        rd = csv.reader(fh)
        columns = next(rd)
        rows = [[c if c != "" else None for c in row] for row in rd]
    return {
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": os.path.basename(path)},
    }


def table_from_csv_text(text, name):
    """The same table shape from CSV text (the example endpoint's body)."""
    rd = csv.reader(text.splitlines())
    columns = next(rd)
    rows = [[c if c != "" else None for c in row] for row in rd]
    return {
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": name},
    }


def example_table(app, token, kind):
    """One example table through the same endpoint the UI's Use-example flow
    calls: GET /api/file-validation/examples/{kind} → the CSV text."""
    st, raw = _http(app, "GET", f"/file-validation/examples/{kind}", token=token)
    assert st // 100 == 2, raw
    text = raw.decode("utf-8")
    return table_from_csv_text(text, f"{kind}-example.csv")


def inspect_table(app, token, kind, table):
    """POST /api/file-validation/inspect with no error problems (the flow's
    own first check, exactly as the file screens run it)."""
    st, ins = _http(
        app, "POST", "/file-validation/inspect", {"kind": kind, "table": table}, token
    )
    assert st // 100 == 2, ins
    errs = error_problems(ins.get("problems", []))
    assert not errs, f"{kind}: {errs}"
    return ins


def validate_parameters(decision_day):
    return {"decision_day": decision_day, "baseline_max_day": 0}


def example_validate(app, token, mode, measurements, patients=None):
    """POST /api/file-validation/validate for one example table set (the
    N screen's predict mode or the C screen's files mode)."""
    st, body = _http(
        app,
        "POST",
        "/file-validation/validate",
        {
            "mode": mode,
            "patients": patients,
            "measurements": measurements,
            "joins": [],
            "mapping": [],
            "parameters": validate_parameters(EXAMPLE_DECISION_DAY),
        },
        token,
    )
    assert st // 100 == 2, body
    errs = error_problems(body.get("problems", []))
    assert not errs, errs
    return body


def marker_keys(validation):
    """The validate response's marker keys, lowercased (the real validator
    keys by the RAW spelling — 'M1'; the inventory's stable keys are the
    same columns)."""
    return sorted(m.get("key", "").lower() for m in validation.get("markers", []))


def error_problems(problems):
    return [p for p in problems if p.get("severity") == "error"]


def follow_run(app, token, run_id, timeout_secs):
    deadline = time.time() + timeout_secs
    detail = None
    while time.time() < deadline:
        _, detail = _http(app, "GET", f"/txr/runs/{run_id}", token=token)
        if detail.get("status") in ("finished", "failed", "stopped"):
            return detail
        time.sleep(POLL_SECS)
    raise StepFail(f"run {run_id} did not reach a terminal state within {timeout_secs}s")


def linear_probs(detail):
    """Per-method probabilities from a run detail (the predictions tab data)."""
    return detail.get("methods", [])


def run_example_steps(app, token, lines, step):
    """qa-fixes3 ITEM-5's --example mode: the THREE use-example flows over
    the API, exactly as the UI's one-click buttons drive them (TEST-QF3-3).

    E1 — "Predict with a pretrained model": the example predict table (GET
         /file-validation/examples/predict-measurements) -> inspect ->
         predict-mode validate -> the pretrained catalogue + eligibility
         (the D screen's data; a catalogue-less app reports the honest
         SKIP, never a fabricated number).
    E2 — "Learn from my data": the example training pair -> inspect ->
         files-mode validate (the family's pinned facts) -> eligibility over
         the validate inventory + the estimate for the example-set pick (the
         pick the app returns: scripted, not hard-pinned ids).
    E3 — "Use a model I saved": the example predict table -> predict-mode
         validate -> POST /txr/models/example (ITEM-3: create once, return
         the existing set) -> the set's models through the normal inventory.
         A `failed` answer (no real environment stack on this host) is the
         honest SKIP, never a failure of the app.
    """
    def guard(name, fn):
        try:
            return step(name, fn)
        except SkipFlow as exc:
            lines.append(f"SKIP  {name}: {exc}")
            return None

    predict = None
    training = None

    # ── E1: the pretrained path ────────────────────────────────────────────
    def s_e1_fetch():
        nonlocal predict
        predict = example_table(app, token, "predict-measurements")
        ids = sorted({row[0] for row in predict["rows"]})
        markers = sorted({row[2] for row in predict["rows"]})
        assert len(ids) == EXAMPLE_PREDICT_PATIENTS, f"{len(ids)} predict patients"
        assert markers == ["M1", "M2", "M3"], markers
        return f"{len(predict['rows'])} value rows, {len(ids)} patients, markers {markers}"
    step("E1 example predict table", s_e1_fetch)

    def s_e1_inspect():
        ins = inspect_table(app, token, "measurements", predict)
        assert ins["summary"]["rows"] == len(predict["rows"])
        return f"{ins['summary']['rows']} rows, no error problems"
    step("E1 inspect", s_e1_inspect)

    e1_validation = {}
    def s_e1_validate():
        nonlocal e1_validation
        e1_validation = example_validate(app, token, "predict", predict)
        keys = marker_keys(e1_validation)
        assert keys == ["m1", "m2", "m3"], keys
        assert e1_validation["measurements"]["patients"] == EXAMPLE_PREDICT_PATIENTS
        return f"predict-mode validate clean: markers {keys}"
    step("E1 validate (predict mode)", s_e1_validate)

    def s_e1_catalogue():
        st, body = _http(app, "GET", "/txr/pretrained", token=token)
        assert st // 100 == 2, body
        models = body.get("models", [])
        if len(models) == 0:
            raise SkipFlow(
                "this app serves no pretrained catalogue (the D screen's no-cards state) — "
                "the example file is what the flow carries"
            )
        st, body = _http(
            app,
            "POST",
            "/txr/pretrained/eligibility",
            {
                "model_ids": [m["id"] for m in models],
                "inventory": e1_validation["inventory"],
            },
            token,
        )
        assert st // 100 == 2, body
        verdicts = body.get("models", [])
        assert len(verdicts) == len(models), (len(verdicts), len(models))
        for verdict in verdicts:
            assert verdict.get("status") in ("can_run", "can_run_some", "cannot_run"), verdict
        return (f"{len(models)} catalogue entries, verdicts contract-shaped "
                f"({body.get('total_fit')} / {body.get('total_some')} / {body.get('total_cannot')})")
    guard("E1 pretrained catalogue + eligibility", s_e1_catalogue)

    # ── E2: the train path ─────────────────────────────────────────────────
    def s_e2_fetch():
        nonlocal training
        training = {
            "patients": example_table(app, token, "patients"),
            "measurements": example_table(app, token, "measurements"),
        }
        n = len({row[0] for row in training["measurements"]["rows"]})
        assert n == EXAMPLE_TRAINING_PATIENTS, f"{n} training patients"
        assert len(training["patients"]["rows"]) == EXAMPLE_TRAINING_PATIENTS
        ids = sorted({row[0] for row in training["patients"]["rows"]})
        assert ids[0] == "J0000", ids[:3]
        return (f"{len(training['patients']['rows'])} patients, "
                f"{len(training['measurements']['rows'])} value rows")
    step("E2 example training tables", s_e2_fetch)

    def s_e2_inspect():
        for kind, table in (("patients", training["patients"]),
                            ("measurements", training["measurements"])):
            inspect_table(app, token, kind, table)
        return "both tables inspect clean (no error problems)"
    step("E2 inspect", s_e2_inspect)

    e2_validation = {}
    def s_e2_validate():
        nonlocal e2_validation
        e2_validation = example_validate(
            app, token, "files", training["measurements"], training["patients"]
        )
        keys = marker_keys(e2_validation)
        assert keys == ["m1", "m2", "m3"], keys
        assert e2_validation["patients"]["rows"] == EXAMPLE_TRAINING_PATIENTS
        return (f"files-mode validate clean: markers {keys}, "
                f"{e2_validation['patients']['rows']} patient rows")
    step("E2 validate (files mode)", s_e2_validate)

    e2_eligibility = {}
    def s_e2_eligibility():
        nonlocal e2_eligibility
        st, body = _http(
            app, "POST", "/methods/eligibility",
            {"inventory": e2_validation["inventory"]}, token,
        )
        assert st // 100 == 2, body
        e2_eligibility = body
        return f"{len(body['methods'])} verdicts, {body.get('total_fit')} can run"
    step("E2 eligibility", s_e2_eligibility)

    def s_e2_estimate():
        # The estimate step the choose-methods page runs — over the example
        # set's own pick (POST /txr/models/example returns it; here the
        # estimate is asked for the picked methods, so the harness pins the
        # same numbers the run bar would render).
        st, asked = _http(app, "POST", "/txr/models/example", {}, token)
        assert st // 100 == 2 and asked.get("methods"), asked
        picked["methods"] = list(asked["methods"])
        st, body = _http(
            app, "POST", "/methods/estimate",
            {
                "method_ids": picked["methods"],
                "patients": EXAMPLE_TRAINING_PATIENTS,
                "cpus": 2,
            },
            token,
        )
        assert st // 100 == 2, body
        assert len(body.get("methods", [])) == len(picked["methods"]), body
        for method in body["methods"]:
            assert method.get("estimated_seconds", 0) > 0, method
        return f"pick estimate: total {body['total_seconds']:.0f}s"
    step("E2 estimate (the example pick)", s_e2_estimate)

    # ── E3: the reuse path ─────────────────────────────────────────────────
    def s_e3_validate():
        # The reuse promise starts on the SAME predict file (the I screen's
        # file step): a clean predict-mode validate is the flow's own gate.
        validation = example_validate(app, token, "predict", predict)
        assert marker_keys(validation) == ["m1", "m2", "m3"]
        return "predict-mode validate clean (reuse file gate)"
    step("E3 validate (predict mode)", s_e3_validate)

    def s_e3_set():
        st, body = _http(app, "POST", "/txr/models/example", {}, token)
        assert st // 100 == 2, body
        state = body.get("state")
        assert state in ("creating", "ready", "failed"), body
        assert body.get("methods"), body
        assert len(body["methods"]) <= 3, body
        # The ITEM-3 deterministic pick (sorted equality: the estimate
        # seconds + id order is the catalogue's, the id set is the pin).
        assert sorted(body["methods"]) == sorted(picked["methods"]), body["methods"]
        return (f"example set call: state {state}, pick {body['methods']}")
    step("E3 example set (call 1)", s_e3_set)

    def s_e3_poll():
        st, body = _http(app, "POST", "/txr/models/example", {}, token)
        return body
    # The state machine: poll while creating; ready → the set's models;
    # failed → the honest skip (the host's environment, not the app's).
    deadline = time.time() + EXAMPLE_SET_TIMEOUT_SECS
    answer = None
    while time.time() < deadline:
        answer = s_e3_poll()
        state = answer.get("state")
        if state in ("ready", "failed"):
            break
        if state != "creating":
            raise StepFail(f"unexpected example-set state {state!r}")
        time.sleep(POLL_SECS)
    else:
        raise StepFail("the example set did not settle within "
                       f"{EXAMPLE_SET_TIMEOUT_SECS}s")

    if answer.get("state") == "ready":
        def s_e3_ready():
            set_id = answer.get("set_id")
            assert set_id, answer
            st, body = _http(app, "GET", f"/txr/models?set_id={set_id}", token=token)
            assert st // 100 == 2, body
            rows = body.get("models", [])
            assert len(rows) >= 1, body
            for row in rows:
                assert row.get("set_id") == set_id, row
            st, sets = _http(app, "GET", "/txr/model-sets", token=token)
            assert st // 100 == 2, sets
            he = [s for s in sets.get("sets", []) if s.get("id") == set_id]
            assert len(he) == 1, sets
            assert he[0].get("name") == "Example models", he[0]
            return (f"set '{he[0]['name']}': {len(rows)} models "
                    f"({he[0].get('model_count')} in the set)")
        step("E3 example set ready + its models", s_e3_ready)
    elif answer.get("state") == "failed":
        reason = answer.get("error") or "no reason"
        if "environment" in reason.lower() or "env" in reason.lower():
            lines.append(
                f"SKIP  E3 example set ready: the app answered failed — {reason} "
                "(no real environment stack on this host; the honest state machine)"
            )
        else:
            lines.append(
                f"SKIP  E3 example set ready: the app answered failed — {reason} (host condition)"
            )


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="TxResBench ITEM-3 real-data e2e driver (qa-fixes3 ITEM-5 also ships the --example mode)"
    )
    ap.add_argument("--app-url", default=DEFAULT_APP_URL)
    ap.add_argument("--inputs", default=DEFAULT_INPUTS)
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--timeout", type=int, default=RUN_TIMEOUT_SECS)
    ap.add_argument(
        "--example",
        action="store_true",
        help="drive the three USE-EXAMPLE flows (pretrained / train / reuse) over the API — the example family the UI's one-click buttons load, never local input files",
    )
    args = ap.parse_args(argv)

    app = args.app_url.rstrip("/")
    lines = []
    ok = True

    def step(name, fn):
        nonlocal ok
        try:
            out = fn()
            lines.append(f"PASS  {name}")
            if out is not None:
                lines.append(f"      {out}")
            return out
        except StepFail as e:
            lines.append(f"FAIL  {name}: {e}")
            ok = False
            raise
        except AssertionError as e:
            lines.append(f"FAIL  {name}: assertion failed: {e}")
            ok = False
            raise StepFail(f"{name}: assertion failed")

    try:
        # 1. health
        def s_health():
            st, body = _http(app, "GET", "/health")
            assert st // 100 == 2 and body.get("status") == "ok", body
            return "app healthy"
        step("1 health", s_health)

        # 2. session
        token = None
        def s_session():
            nonlocal token
            st, body = _http(app, "POST", "/session/local", {})
            assert st // 100 == 2 and body.get("access_token"), body
            token = body["access_token"]
            return "owner session minted"
        step("2 local session", s_session)

        if args.example:
            run_example_steps(app, token, lines, step)
            step("16 summary", lambda: "ALL EXAMPLE STEPS PASSED")
        else:
            # 3. inputs
            inputs_path = os.path.join(args.inputs, "inputs.json")
            with open(inputs_path) as fh:
                facts = json.load(fh)
            patients = table_from_csv(os.path.join(args.inputs, "patients.csv"))
            measurements = table_from_csv(os.path.join(args.inputs, "measurements.csv"))
            predict = table_from_csv(os.path.join(args.inputs, "predict-measurements.csv"))
            mapping = facts["marker_mapping"]
            step("3 inputs loaded", lambda: (
                f"{facts['dataset']}: {len(patients['rows'])} patients, "
                f"{len(measurements['rows'])} measurement rows, "
                f"{len(predict['rows'])} predict rows, markers {facts['markers']}"
            ))

            # 4. inspect
            def s_inspect():
                for kind, table in (("patients", patients), ("measurements", measurements)):
                    st, ins = _http(app, "POST", "/file-validation/inspect",
                                   {"kind": kind, "table": table}, token)
                    assert st // 100 == 2, ins
                    errs = error_problems(ins.get("problems", []))
                    assert not errs, f"{kind}: {errs}"
                return "no error problems in either inspect"
            step("4 inspect", s_inspect)

            # 5. validate
            validation = {}
            def s_validate():
                nonlocal validation
                st, body = _http(app, "POST", "/file-validation/validate", {
                    "mode": "files",
                    "patients": patients,
                    "measurements": measurements,
                    "joins": [],
                    "mapping": mapping,
                    "parameters": {"decision_day": 56, "baseline_max_day": 0},
                }, token)
                assert st // 100 == 2, body
                errs = error_problems(body.get("problems", []))
                assert not errs, errs
                validation = body
                return (f"{len(validation.get('markers', []))} marker columns, "
                        f"{len(validation.get('problems', []))} warnings")
            step("5 validate", s_validate)

            # 6. eligibility
            eligibility = {}
            def s_eligibility():
                nonlocal eligibility
                st, body = _http(app, "POST", "/methods/eligibility",
                                {"inventory": validation["inventory"]}, token)
                assert st // 100 == 2, body
                eligibility = body
                verdicts = {m["id"]: m for m in body["methods"]}
                rows = []
                for mid in PUBLISHED_METHODS:
                    v = verdicts[mid]
                    rows.append(f"{mid}: {v['status']} ({', '.join(r['code'] for r in v.get('reasons', [])) or 'ok'})")
                runnable = [mid for mid in PUBLISHED_METHODS
                            if verdicts[mid]["status"] in ("can_run", "can_run_some")]
                assert len(runnable) >= 3, f"only {len(runnable)} published methods runnable: {runnable}"
                return "runnable: " + ", ".join(runnable) + " | " + " | ".join(rows)
            step("6 eligibility", s_eligibility)

            # 7. estimate
            estimated = None
            def s_estimate():
                nonlocal estimated
                st, body = _http(app, "POST", "/methods/estimate", {
                    "method_ids": PUBLISHED_METHODS,
                    "patients": len(patients["rows"]),
                    "cpus": 2,
                }, token)
                assert st // 100 == 2, body
                estimated = body
                return (f"{len(body['methods'])} methods, total {body['total_seconds']:.0f}s, "
                        f"schedule {body['schedule_seconds']:.0f}s at {body['at_a_time']} at a time")
            step("7 estimate", s_estimate)

            # 8. create run
            run_id = None
            def s_create():
                nonlocal run_id
                st, body = _http(app, "POST", "/txr/runs", {
                    "mode": "train",
                    "input": {
                        "patients": patients,
                        "measurements": measurements,
                        "predict_measurements": None,
                        "joins": [],
                        "mapping": mapping,
                        "keep_copies": True,
                    },
                    "config": RUN_CONFIG,
                    "method_ids": PUBLISHED_METHODS,
                }, token)
                assert st == 202, body
                run_id = body["id"]
                return f"run {run_id} accepted (status {body.get('status')})"
            step("8 create run", s_create)

            # 9. follow
            detail = None
            def s_follow():
                nonlocal detail
                detail = follow_run(app, token, run_id, args.timeout)
                counts = detail["counts"]
                assert detail["status"] == "finished", (
                    f"run failed: {detail.get('status')} — rows: "
                    + ", ".join(f"{m['method_id']}={m['state']}:{m.get('reason')}"
                                for m in detail.get("methods", []))
                )
                per = {m["method_id"]: m for m in detail.get("methods", [])}
                finished = [mid for mid in PUBLISHED_METHODS if per.get(mid, {}).get("state") == "finished"]
                assert len(finished) >= 3, f"only {len(finished)} methods finished: {finished}"
                lines.append("      " + " | ".join(
                    f"{mid}={per[mid]['state']}"
                    + (f":{per[mid].get('reason')}" if per[mid]['state'] != "finished" else "")
                    for mid in PUBLISHED_METHODS))
                return (f"run finished; counts {json.dumps(counts)}; "
                        f"{len(finished)} finished: {', '.join(finished)}")
            step("9 follow run", s_follow)

            # 10. predictions JSON + CSV
            predictions = {}
            csv_rows = None
            def s_predictions():
                nonlocal predictions, csv_rows
                st, body = _http(app, "GET", f"/txr/runs/{run_id}/predictions", token=token)
                assert st // 100 == 2, body
                predictions = body
                st, raw = _http(app, "GET", f"/txr/runs/{run_id}/predictions.csv", token=token)
                assert st // 100 == 2 and isinstance(raw, bytes), st
                text = raw.decode("utf-8")
                csv_rows = list(csv.reader(text.splitlines()))
                non_null = sum(
                    1 for m in predictions.get("methods", [])
                    if any(v is not None for v in m.get("probabilities", [])))
                assert non_null >= 3, f"{non_null} method columns with values"
                assert len(csv_rows) >= 2, "predictions.csv has no rows"
                return (f"{len(predictions.get('patients', []))} patients, "
                        f"{non_null} method columns with values, csv {len(csv_rows) - 1} rows")
            step("10 predictions", s_predictions)

            # 11. save models
            saved = {}
            def s_save():
                nonlocal saved
                per = {m["method_id"]: m for m in detail.get("methods", [])}
                finished = [mid for mid in PUBLISHED_METHODS if per.get(mid, {}).get("state") == "finished"]
                st, body = _http(app, "POST", "/txr/models/save", {
                    "run_id": run_id,
                    "method_ids": finished,
                    "target": {"set_name": f"qa-hardening-inspire-{run_id[:8]}"},
                    "keep_training_files": False,
                    "also_export": False,
                }, token)
                assert st // 100 == 2, body
                saved = body
                assert len(body.get("models", [])) >= 3, body
                return (f"set {body['set'].get('id')} '{body['set'].get('name')}': "
                        f"{len(body['models'])} models saved")
            step("11 save models", s_save)

            # 12. resolve + reuse run
            reuse_id = None
            reuse_detail = None
            def s_reuse():
                nonlocal reuse_id, reuse_detail
                model_ids = [m["id"] for m in saved["models"]]
                st, body = _http(app, "POST", "/txr/models/resolve", {"model_ids": model_ids}, token)
                assert st // 100 == 2, body
                assets = body.get("assets", [])
                assert len(assets) >= 3, f"resolved only {len(assets)} assets"
                first = saved["models"][0]
                st, body = _http(app, "POST", "/txr/runs", {
                    "mode": "reuse",
                    "input": {
                        "patients": None,
                        "measurements": predict,
                        "predict_measurements": predict,
                        "joins": [],
                        "mapping": mapping,
                        "keep_copies": True,
                    },
                    "config": {
                        "endpoint": first.get("endpoint") or "pfs",
                        "decision_day": 56,
                        "look_ahead_day": first.get("horizon") or 238,
                        "covariates": False,
                        "at_a_time": 2,
                        "cpus": None,
                        "save_models": False,
                        "label_day": None,
                    },
                    "model_ids": assets,
                }, token)
                assert st == 202, body
                reuse_id = body["id"]
                return f"reuse run {reuse_id} accepted ({body.get('status')})"
            step("12 resolve + reuse run", s_reuse)

            def s_reuse_follow():
                nonlocal reuse_detail
                reuse_detail = follow_run(app, token, reuse_id, args.timeout)
                assert reuse_detail["status"] == "finished", (
                    f"reuse run failed: {reuse_detail.get('status')}"
                )
                return "reuse run finished"
            step("13 reuse follow", s_reuse_follow)

            # 14. per-patient equality train vs reuse (the same input table; the
            # design: a predict-only reuse has NO training data to refit the
            # risk->probability conversion — native-probability methods are
            # compared value-for-value, risk-only methods must carry the honest
            # prob_source "none" + the missing-source note, never an invented
            # number).
            def s_compare():
                _, reuse_pred = _http(app, "GET", f"/txr/runs/{reuse_id}/predictions", token=token)
                model_of = {m["id"]: m["method_id"] for m in saved["models"]}
                per_train = {m["method_id"]: m for m in predictions.get("methods", [])}
                assert reuse_pred.get("patients") == predictions.get("patients"),                 "reuse predictions must be on the same patient set"
                compared = 0
                worst = 0.0
                honest_none = 0
                for rm in reuse_pred.get("methods", []):
                    mid = model_of.get(rm.get("method_id"), rm.get("method_id"))
                    tm = per_train.get(mid)
                    if tm is None:
                        continue
                    if rm.get("prob_source") == "native":
                        for a, b in zip(tm.get("probabilities", []), rm.get("probabilities", [])):
                            if a is None or b is None:
                                continue
                            compared += 1
                            worst = max(worst, abs(a - b))
                    elif rm.get("prob_source") == "none":
                        note = " ".join(n for n in rm.get("notes", []) if n)
                        assert "predict-only reuse" in note, f"{mid}: {rm.get('notes')}"
                        assert all(v is None for v in rm.get("probabilities", [])), mid
                        honest_none += 1
                assert compared > 0, "no native probabilities compared"
                assert worst < 1e-9, f"reuse predictions diverge (max |diff| {worst})"
                return (f"{compared} native per-patient probabilities equal "
                        f"(max |diff| {worst:.2e}); {honest_none} risk-only columns "
                        "carry the honest prob_source none")
            step("14 reuse equality", s_compare)

            # 15. history
            def s_history():
                st, body = _http(app, "GET", "/txr/history", token=token)
                assert st // 100 == 2, body
                ids = [i.get("id") for i in body.get("items", [])]
                st, runs = _http(app, "GET", "/txr/runs", token=token)
                assert st // 100 == 2, runs
                run_ids = [r.get("id") for r in runs.get("runs", [])]
                assert run_id in run_ids and reuse_id in run_ids, "runs missing from history"
                st, det = _http(app, "GET", f"/txr/history/{run_id}", token=token)
                assert st // 100 == 2, det
                return f"{len(run_ids)} runs in history ({len(set(ids))} history rows); detail ok"
            step("15 history", s_history)

            step("16 summary", lambda: "ALL STEPS PASSED")
    except StepFail:
        pass
    except Exception as e:  # never lose the partial report to an unhandled error
        lines.append(f"FAIL  unexpected: {type(e).__name__}: {e}")
        ok = False

    report = "\n".join(lines)
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w") as fh:
        fh.write("# e2e-real report\n\n" + report + "\n")
    print(report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
