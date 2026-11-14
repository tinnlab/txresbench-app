#!/usr/bin/env python3
"""record-demo-bundle — demo-mode ITEM-2: record the demo bundle.

The demo replays recorded results; the bundle is what it replays. This script
drives a DESKTOP-mode TxResBench over its HTTP API (the dev-registry flow of
`scripts/dev-registry/e2e-real.py`) on the app's embedded example data, for
every configuration the example supports and every method that has a
published environment and can run on the example data: a real train run, the
per-method predictions + measured seconds + log lines, the saved models, and
a reuse run on the example predict table. The recorded bundle is written to
`$TXR_DEMO_BUNDLE` (default `<app-data-dir>/demo-bundle`), generated and
NEVER committed.

WHAT IT DOES (one line per step, exit non-zero on the first failure):
  1. mode probe (desktop only)                          GET  /api/app/mode
  2. local owner session (no login)                     POST /api/session/local
  3. example tables (the qa-fixes3 family)              GET  /api/file-validation/examples/{kind}
  4. inspect (patients + measurements + predict)        POST /api/file-validation/inspect
  5. validate (files mode) + the inventory              POST /api/file-validation/validate
  6. eligibility — the published-environment methods    POST /api/methods/eligibility
  7. per configuration: train run, follow, predictions, logs, save models,
     resolve + reuse run on the example predict table
  8. write the bundle (manifest.json + the per-method prediction tables)

THE RECORDED CONFIGURATIONS (`--configs`):
  pfs_d56_h238 — progression or death at decision day 56 / look ahead 238
  os_d56_h238  — death at the same day/horizon (recorded when the example
                 data supports it; a failed optional configuration is SKIPPED
                 with a warning, never a broken partial bundle)

The canonical content hash is shared with the server (the loader recomputes
it — see `modules/demo/bundle.rs`): the pinned vector in this file's unit
test is the cross-language lockstep. The bundle's `tables.*.content_hash`
must equal the hash of the SAME example bytes the server embeds; a bundle
recorded against a different generator is refused at boot by design.

RUN
---
    python3 scripts/demo/record-demo-bundle.py
    python3 scripts/demo/record-demo-bundle.py --app-url http://127.0.0.1:3100
    python3 scripts/demo/record-demo-bundle.py --out /data/.../demo-bundle
    TXR_DEMO_BUNDLE=/data/.../demo-bundle \
      python3 scripts/demo/record-demo-bundle.py

The report is written to /data/pbya/txresbench-app-work/qa-data/
record-demo-bundle-report.md (default — DEC-1: outside the repo; never /tmp)
and mirrored on stdout.
"""

import argparse
import csv
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

#: The manifest format tag + version (the loader's pins, DEMO-MODE ITEM-2).
FORMAT_TAG = "txresbench-demo-bundle"
FORMAT_VERSION = 1
#: The dataset id the bundle records on (the app's example family).
DATASET_ID = "example"

#: The default app URL (the dev server config: 127.0.0.1:3100).
DEFAULT_APP_URL = "http://127.0.0.1:3100"
#: The default report path (DEC-1: outside the repo).
DEFAULT_REPORT = "/data/pbya/txresbench-app-work/qa-data/record-demo-bundle-report.md"
#: The example-family facts (qa-fixes3 ITEM-3's generator; the API-level pins).
EXAMPLE_DECISION_DAY = 56
EXAMPLE_TRAINING_PATIENTS = 100
EXAMPLE_PREDICT_PATIENTS = 15
EXAMPLE_MARKERS = ("m1", "m2", "m3")
#: Minutes before a run is declared a failure (a real env pull is minutes).
RUN_TIMEOUT_SECS = 60 * 60
POLL_SECS = 5

#: The recorded configurations (the tuple is `id` + the run config; the
#: canonical id grammar is the config's record key + table dir name).
RECORDED_CONFIGS = [
    {
        "id": "pfs_d56_h238",
        "endpoint": "pfs",
        "decision_day": 56.0,
        "look_ahead_day": 238.0,
        "covariates": False,
        "required": True,
        "label": "progression or death at decision day 56 / look ahead 238",
    },
    {
        "id": "os_d56_h238",
        "endpoint": "os",
        "decision_day": 56.0,
        "look_ahead_day": 238.0,
        "covariates": False,
        "required": False,
        "label": "death at decision day 56 / look ahead 238",
    },
]


class StepFail(RuntimeError):
    pass


def http(app, method, path, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(app + "/api" + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                return resp.status, json.loads(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:500]
        # A typed error response is data, not a transport failure: the caller
        # may handle 400s (a method a save refuses) as an honest answer.
        try:
            return e.code, json.loads(detail)
        except ValueError:
            raise StepFail(f"{method} {path} -> {e.code}: {detail}")


#: The transport seam (e2e-real.py's pattern): `main` routes every call
#: through this module attribute, so the driver's unit tests can script a
#: fake server. Never reassigned outside tests.
_http = http


def canonical_table_text(columns, rows):
    """The canonical text form of a table (module doc rules 1–4).

    A `None` cell and an empty string cell encode identically (a CSV reader's
    empty cell); trailing empty cells are dropped; a cell containing `,`, `"`
    or a line break is quoted RFC4180-style (the quote doubled inside). The
    pinned vector in `record_demo_bundle.test.py` is the cross-language
    lockstep with `modules/demo/bundle.rs`.
    """
    n = len(columns)

    def encode(cell):
        cell = "" if cell in (None, "") else str(cell)
        if any(ch in cell for ch in ',"\n\r'):
            return '"' + cell.replace('"', '""') + '"'
        return cell

    def line(cells, pad_to, trim):
        # Normalize BEFORE the trim: a None cell and an empty string are the
        # same content on both sides of the seam (mirrors the Rust
        # `append_line`, which maps None to "" first).
        cells = ["" if c in (None, "") else str(c) for c in cells]
        if len(cells) < pad_to:
            cells += [""] * (pad_to - len(cells))
        if trim:
            while cells and cells[-1] == "":
                cells.pop()
        return ",".join(encode(c) for c in cells)

    out = [line(columns, 0, False)]
    for row in rows:
        out.append(line(row, n, True))
    return "\n".join(out)


def canonical_content_hash(columns, rows):
    """`sha256:` + lowercase hex, over [`canonical_table_text`]."""
    text = canonical_table_text(columns, rows)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def table_from_csv_text(text, name):
    """The request table shape from CSV text (the example endpoint's body)."""
    rd = csv.reader(text.splitlines())
    columns = next(rd)
    rows = [[c if c != "" else None for c in row] for row in rd]
    return {
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": name},
    }


def config_id(config):
    """The recorded configuration's stable id (its record key + dir name).

    Grammar: `<endpoint>_d<decision>_h<lookahead>` + `_cov` when covariates
    are on; day numbers render without a trailing `.0` when integral.
    """
    def fmt_day(day):
        return str(int(day)) if float(day).is_integer() else repr(float(day))

    cid = f"{config['endpoint']}_d{fmt_day(config['decision_day'])}_h{fmt_day(config['look_ahead_day'])}"
    if config.get("covariates"):
        cid += "_cov"
    return cid


def run_config(config):
    """The run's config block for a recorded configuration."""
    return {
        "endpoint": config["endpoint"],
        "decision_day": config["decision_day"],
        "look_ahead_day": config["look_ahead_day"],
        "covariates": config["covariates"],
        "at_a_time": 2,
        "cpus": None,
        "save_models": True,
        "label_day": None,
    }


def error_problems(problems):
    return [p for p in problems if p.get("severity") == "error"]


def follow_run(app, token, run_id, timeout_secs):
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        _, detail = _http(app, "GET", f"/txr/runs/{run_id}", token=token)
        if detail.get("status") in ("finished", "failed", "stopped"):
            return detail
        time.sleep(POLL_SECS)
    raise StepFail(f"run {run_id} did not reach a terminal state within {timeout_secs}s")


def fetch_example_table(app, token, kind):
    """One example table through the endpoint the UI's Use-example flow calls."""
    st, raw = _http(app, "GET", f"/file-validation/examples/{kind}", token=token)
    assert st // 100 == 2, raw
    text = raw.decode("utf-8")
    return table_from_csv_text(text, f"{kind}-example.csv")


def record_log_lines(app, token, run_id):
    """The run's whole log (all pages), as the bundle's log lines."""
    lines = []
    after = 0
    while True:
        st, body = _http(
            app, "GET", f"/txr/runs/{run_id}/logs?after_seq={after}&limit=2000", token=token
        )
        assert st // 100 == 2, body
        for line in body.get("lines", []):
            lines.append(
                {
                    "method_id": line.get("method_id"),
                    "stream": line.get("stream"),
                    "content": line.get("content"),
                }
            )
        after = body.get("next_seq", 0)
        if not body.get("lines"):
            break
        if len(lines) >= body.get("total", 0):
            break
    return lines


def column_from_response(method, table_path, rows):
    """The manifest's column record from a predictions-response method row."""
    return {
        "table": table_path,
        "label": method.get("label", method.get("method_id", "")),
        "group": method.get("group", ""),
        "group_label": method.get("group_label", ""),
        "task": method.get("task", "pfs"),
        "prob_source": method.get("prob_source", "native"),
        "flat_conversion": bool(method.get("flat_conversion", False)),
        "coverage": method.get("coverage", {"scored": 0, "eligible": 0, "fraction": 0.0}),
        "rows": rows,
    }


def model_from_summary(m):
    """The bundle's model record from a saved-models response row."""
    marker_kind = m.get("marker_kind")
    if isinstance(marker_kind, dict):
        marker_kind = marker_kind.get("kind") or marker_kind
    return {
        "name": m.get("name", ""),
        "method_version": m.get("method_version", ""),
        "group": m.get("group", ""),
        "group_label": m.get("group_label", ""),
        "task": m.get("task"),
        "trained_on_patients": m.get("trained_on_patients"),
        "trained_at": m.get("trained_at"),
        "decision_day": m.get("decision_day", 56.0),
        "endpoint": m.get("endpoint", "pfs"),
        "horizon": m.get("horizon", 238.0),
        "size_bytes": m.get("size_bytes", 0),
        "embeds_training_data": bool(m.get("embeds_training_data", False)),
        "own_auc": m.get("own_auc"),
        "marker_count": m.get("marker_count"),
        "marker_kind": marker_kind,
        "uses_covariates": bool(m.get("uses_covariates", False)),
    }


def write_column_csv(path, patients, probabilities, notes):
    """One method's per-patient prediction table (patient_id,probability,note).

    The row order is the predictions response's patient order (the run's
    aligned array), so the replay reads the recorded order verbatim.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["patient_id", "probability", "note"])
        for i, patient in enumerate(patients):
            prob = probabilities[i] if i < len(probabilities) else None
            note = notes[i] if i < len(notes) else None
            w.writerow([patient, "" if prob is None else prob, note or ""])


def write_bundle(out_dir, dataset_facts, configurations, method_records, report_lines):
    """Write the bundle dir (manifest.json + the prediction tables)."""
    os.makedirs(out_dir, exist_ok=True)
    methods = []
    for method_id in sorted(method_records):
        records = method_records[method_id]
        records.sort(key=lambda r: r["configuration_id"])
        methods.append({"method_id": method_id, "records": records})
    manifest = {
        "format": FORMAT_TAG,
        "version": FORMAT_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dataset_id": DATASET_ID,
        "tables": dataset_facts,
        "configurations": configurations,
        "methods": methods,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    return manifest


def record_configuration(app, token, config, candidates, config_path_dir, lines,
                         run_timeout_secs):
    """One recorded configuration: the train run, the save, the reuse run.

    Returns (configuration_manifest, method_records). Any failure (the run did
    not finish, the save failed, the reuse run failed) raises StepFail with
    the reason — the caller records the required configuration's failure as a
    FAIL and an optional one as a SKIP (a broken partial bundle is never
    written).
    """
    cid = config_id(config)
    st, body = _http(
        app,
        "POST",
        "/txr/runs",
        {
            "mode": "train",
            "input": {
                "patients": config_path_dir["patients"],
                "measurements": config_path_dir["measurements"],
                "predict_measurements": None,
                "joins": [],
                "mapping": [],
                "keep_copies": True,
            },
            "config": run_config(config),
            "method_ids": sorted(candidates),
        },
        token,
    )
    assert st == 202, body
    run_id = body["id"]
    lines.append(f"      run {run_id} accepted for {cid}")

    detail = follow_run(app, token, run_id, run_timeout_secs)
    if detail.get("status") != "finished":
        raise StepFail(f"run {run_id} ended {detail.get('status')}")

    # Per-method measured seconds + state from the finished detail.
    per_method = {m["method_id"]: m for m in detail.get("methods", [])}
    finished = [
        mid for mid, m in per_method.items() if m.get("state") == "finished"
    ]
    if not finished:
        states = ", ".join(
            f"{mid}={m.get('state')}:{m.get('reason', {}).get('code') if m.get('reason') else ''}"
            for mid, m in sorted(per_method.items())
        )
        raise StepFail(
            f"run {run_id} finished with no finished method ({states}) — "
            "nothing to record on this host"
        )
    seconds = {}
    missing_seconds = []
    for mid in finished:
        elapsed = per_method[mid].get("elapsed_secs")
        if elapsed is None or elapsed <= 0:
            missing_seconds.append(mid)
        else:
            seconds[mid] = float(elapsed)

    # The train predictions (patients + the per-method aligned columns).
    st, predictions = _http(app, "GET", f"/txr/runs/{run_id}/predictions", token=token)
    assert st // 100 == 2, predictions
    patients = predictions.get("patients", [])
    columns = {m["method_id"]: m for m in predictions.get("methods", [])}

    # The run's log lines (the replay's log stream data).
    logs = record_log_lines(app, token, run_id)

    # Save the models of the finished methods (the save seam records the
    # produced /model trees; the bundle carries the metadata + reuse results).
    st, saved = _http(
        app,
        "POST",
        "/txr/models/save",
        {
            "run_id": run_id,
            "method_ids": sorted(finished),
            # A unique name per recording (the name is metadata only; the
            # bundle carries the model facts, never the set row).
            "target": {"set_name": f"Recorded demo bundle {cid} {time.strftime('%Y-%m-%d %H:%M:%S')}"},
            "keep_training_files": False,
            "also_export": False,
        },
        token,
    )
    if st // 100 != 2:
        raise StepFail(f"save models failed ({st}): {saved}")
    saved_by_method = {}
    for m in saved.get("models", []):
        saved_by_method.setdefault(m["method_id"], m)
    saved_ids = [m["id"] for m in saved.get("models", [])]

    # Reuse: the saved models resolved + applied to the example predict file.
    reuse_columns = {}
    if saved_ids:
        st, resolved = _http(app, "POST", "/txr/models/resolve", {"model_ids": saved_ids}, token)
        assert st // 100 == 2, resolved
        assets = resolved.get("assets", [])
        assert len(assets) == len(saved_ids), f"resolved only {len(assets)} of {len(saved_ids)}"
        st, body = _http(
            app,
            "POST",
            "/txr/runs",
            {
                "mode": "reuse",
                "input": {
                    "patients": None,
                    "measurements": config_path_dir["predict"],
                    "predict_measurements": config_path_dir["predict"],
                    "joins": [],
                    "mapping": [],
                    "keep_copies": True,
                },
                "config": {
                    "endpoint": config["endpoint"],
                    "decision_day": config["decision_day"],
                    "look_ahead_day": config["look_ahead_day"],
                    "covariates": False,
                    "at_a_time": 2,
                    "cpus": None,
                    "save_models": False,
                    "label_day": None,
                },
                # The resolved assets ARE the engine's model_ids elements
                # (ResolveResponse.assets is TxrModelAsset-shaped) — the run
                # request consumes them verbatim.
                "model_ids": assets,
            },
            token,
        )
        assert st == 202, body
        reuse_id = body["id"]
        reuse_detail = follow_run(app, token, reuse_id, run_timeout_secs)
        if reuse_detail.get("status") != "finished":
            raise StepFail(f"reuse run {reuse_id} ended {reuse_detail.get('status')}")
        st, reuse_pred = _http(app, "GET", f"/txr/runs/{reuse_id}/predictions", token=token)
        assert st // 100 == 2, reuse_pred
        model_of = {m["id"]: m["method_id"] for m in saved.get("models", [])}
        for rm in reuse_pred.get("methods", []):
            mid = model_of.get(rm.get("method_id"), rm.get("method_id"))
            reuse_columns[mid] = (reuse_pred.get("patients", []), rm)
    else:
        lines.append("      no models were saved for this run (nothing to record for reuse)")

    # Assemble the per-method records.
    records = {}
    for mid in sorted(set(finished)):
        if mid in missing_seconds:
            lines.append(f"      SKIP method {mid}: finished without a recorded elapsed time")
            continue
        if mid not in columns:
            lines.append(f"      SKIP method {mid}: finished without a prediction column")
            continue
        col = columns[mid]
        train_path = f"train/{cid}/{mid}.csv"
        write_column_csv(
            os.path.join(config_path_dir["out"], train_path),
            patients,
            col.get("probabilities", []),
            col.get("notes", []),
        )
        record = {
            "configuration_id": cid,
            "seconds": seconds[mid],
            "train": column_from_response(col, train_path, len(patients)),
            "model": None,
            "reuse": None,
        }
        model_row = saved_by_method.get(mid)
        if model_row is not None:
            record["model"] = model_from_summary(model_row)
            if mid in reuse_columns:
                reuse_patients, rm = reuse_columns[mid]
                reuse_path = f"reuse/{cid}/{mid}.csv"
                write_column_csv(
                    os.path.join(config_path_dir["out"], reuse_path),
                    reuse_patients,
                    rm.get("probabilities", []),
                    rm.get("notes", []),
                )
                record["reuse"] = column_from_response(rm, reuse_path, len(reuse_patients))
            elif record["model"] is not None:
                lines.append(
                    f"      SKIP reuse for {mid}: the reuse run carried no column for its model"
                )
        records[mid] = record

    return (
        {"id": cid, "endpoint": config["endpoint"], "decision_day": config["decision_day"],
         "look_ahead_day": config["look_ahead_day"], "covariates": config["covariates"],
         "logs": logs},
        records,
    )


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="record-demo-bundle (demo-mode ITEM-2): record the demo bundle over a desktop-mode app"
    )
    ap.add_argument("--app-url", default=DEFAULT_APP_URL)
    ap.add_argument("--out", default=None, help="the bundle dir (default $TXR_DEMO_BUNDLE, else <app-data-dir>/demo-bundle)")
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--run-timeout", type=int, default=RUN_TIMEOUT_SECS)
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
        # 1. mode probe — the bundle records REAL runs; a demo-mode app has
        # none, so the recorder refuses it loudly.
        def s_mode():
            st, body = _http(app, "GET", "/app/mode")
            assert st // 100 == 2, body
            if body.get("mode") != "desktop":
                raise StepFail(
                    f"the app at {app} is in {body.get('mode')} mode — the recorder drives a "
                    "DESKTOP-mode app (real runs only)"
                )
            return "desktop mode confirmed"
        step("1 mode probe (desktop only)", s_mode)

        # 2. local owner session.
        token = None
        def s_session():
            nonlocal token
            st, body = _http(app, "POST", "/session/local", {})
            assert st // 100 == 2 and body.get("access_token"), body
            token = body["access_token"]
            return "owner session minted"
        step("2 local session", s_session)

        # 3. example tables through the qa-fixes3 example endpoints.
        tables = {}
        def s_examples():
            for kind in ("patients", "measurements", "predict-measurements"):
                tables[kind] = fetch_example_table(app, token, kind)
            n = len({row[0] for row in tables["measurements"]["rows"]})
            assert n == EXAMPLE_TRAINING_PATIENTS, f"{n} training patients"
            assert len(tables["patients"]["rows"]) == EXAMPLE_TRAINING_PATIENTS
            ids = sorted({row[0] for row in tables["predict-measurements"]["rows"]})
            assert len(ids) == EXAMPLE_PREDICT_PATIENTS, f"{len(ids)} predict patients"
            markers = sorted({row[2] for row in tables["predict-measurements"]["rows"]})
            assert markers != [] and markers[0].lower() == "m1", markers
            return (f"example tables: {n} training patients, {len(ids)} predict patients, "
                    f"{len(tables['measurements']['rows'])} value rows")
        step("3 example tables", s_examples)

        # 4. inspect (the screens' own first check).
        def s_inspect():
            for kind, table in (
                ("patients", tables["patients"]),
                ("measurements", tables["measurements"]),
                ("measurements", tables["predict-measurements"]),
            ):
                st, body = _http(app, "POST", "/file-validation/inspect",
                                 {"kind": kind, "table": table}, token)
                assert st // 100 == 2, body
                assert not error_problems(body.get("problems", [])), body
            return "all three example tables inspect clean"
        step("4 inspect", s_inspect)

        # 5. validate (files mode) → the inventory.
        validation = {}
        def s_validate():
            nonlocal validation
            st, body = _http(app, "POST", "/file-validation/validate", {
                "mode": "files",
                "patients": tables["patients"],
                "measurements": tables["measurements"],
                "joins": [],
                "mapping": [],
                "parameters": {"decision_day": EXAMPLE_DECISION_DAY, "baseline_max_day": 0},
            }, token)
            assert st // 100 == 2, body
            assert not error_problems(body.get("problems", [])), body
            validation = body
            keys = sorted(m.get("key", "").lower() for m in body.get("markers", []))
            assert keys == list(EXAMPLE_MARKERS), keys
            return f"validate clean: markers {keys}"
        step("5 validate", s_validate)

        # 6. eligibility — the method set that has a published environment and
        # can run on the example data (the run's own classification is the
        # final arbiter; a method the run refuses is simply not recorded).
        candidates = []
        def s_eligibility():
            nonlocal candidates
            st, body = _http(app, "POST", "/methods/eligibility",
                             {"inventory": validation["inventory"]}, token)
            assert st // 100 == 2, body
            candidates = [m["id"] for m in body.get("methods", [])
                          if m.get("status") in ("can_run", "can_run_some")]
            assert candidates, "no method with a published environment can run on the example data"
            return f"{len(candidates)} methods recordable: {', '.join(sorted(candidates))}"
        step("6 eligibility", s_eligibility)

        # 7+8. record every configuration, then write the bundle.
        out_dir = args.out if args.out else os.environ.get("TXR_DEMO_BUNDLE")
        if not out_dir:
            data_root = os.environ.get("TXR_APP_DATA_DIR") or os.path.join(
                os.path.expanduser("~"), ".txresbench"
            )
            out_dir = os.path.join(data_root, "demo-bundle")
        config_path_dir = {
            "patients": tables["patients"],
            "measurements": tables["measurements"],
            "predict": tables["predict-measurements"],
            "out": out_dir,
        }

        dataset_facts = {}
        for kind, key in (("patients", "patients"), ("measurements", "measurements"),
                          ("predict-measurements", "predict_measurements")):
            dataset_facts[key] = {
                "content_hash": canonical_content_hash(
                    tables[kind]["columns"], tables[kind]["rows"]
                ),
                "rows": len(tables[kind]["rows"]),
                "columns": list(tables[kind]["columns"]),
            }

        configurations = []
        method_records = {}
        for config in RECORDED_CONFIGS:
            cid = config_id(config)
            try:
                step(f"7 record {cid} ({config['label']})", lambda: None)
                cfg, records = record_configuration(app, token, config, candidates,
                                                    config_path_dir, lines, args.run_timeout)
                configurations.append(cfg)
                for mid, record in records.items():
                    method_records.setdefault(mid, []).append(record)
                lines.append(f"      {cid}: {len(records)} methods recorded")
            except StepFail as e:
                if config["required"]:
                    raise
                lines.append(f"SKIP  configuration {cid}: {e}")

        if not configurations:
            raise StepFail("no recorded configuration — the bundle is empty")
        manifest = write_bundle(out_dir, dataset_facts, configurations, method_records, lines)
        total_records = sum(len(m["records"]) for m in manifest["methods"])
        step("8 write bundle", lambda: (
            f"bundle at {out_dir}: {len(manifest['configurations'])} configurations, "
            f"{len(manifest['methods'])} methods, {total_records} (config, method) records"
        ))
        step("9 summary", lambda: "BUNDLE RECORDED")
    except StepFail as e:
        # A StepFail that reached the top (a required configuration's failure)
        # must STILL produce an honest FAIL line + a non-zero exit — never a
        # silent truncated report.
        lines.append(f"FAIL  {e}")
        ok = False
    except Exception as e:
        lines.append(f"FAIL  unexpected: {type(e).__name__}: {e}")
        ok = False

    report = "\n".join(lines)
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w") as fh:
        fh.write("# record-demo-bundle report\n\n" + report + "\n")
    print(report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
