#!/usr/bin/env python3
"""Generate the `expected.json` pins of the marker-rank parity fixtures
(single-marker-choice round 1a, item 6).

It imports the benchmark's copied `ranking.py` from the directory in
`TXR_RUNNER_COPY` (read-only copy; NEVER run inside the benchmark's tree) and
rebuilds the runner's `_fold` cohort + coverage + top-5 steps from the
fixture CSVs. The Rust port
(`src/modules/execution_engine/marker_rank.rs`) must match this output.

Usage (cwd = $TMPDIR, `-I` so no cwd import can shadow the copy):
    TXR_RUNNER_COPY=<runner dir> python3 -I gen_expected.py <fixtures root>

For every sub-folder holding values.csv + outcomes.csv + case.json the script
writes <sub-folder>/expected.json.

The ported steps (source, the benchmark's runner — read-only copy):
- `ranking.py::rank_markers` (lines 86-91) / `score_markers` (36-83) /
  `last_values` (19-24): `rank_markers` is imported directly and applied to
  the SAME tables the app ranks.
- `pilot.py::Context.__init__` lines 149-154 (the unit cohort: a draw of a
  candidate at `day <= baseline_max_day` AND one at
  `baseline_max_day < day <= L`) — rebuilt here; `data.py::read_values`
  (lines 59-78) drops non-finite days and values, so the cohort's draws are
  the NUMERIC rows only (`values_num` below).
- `pilot.py::_fold` lines 186-206:
  - line 186: ranking patients = cohort ∩ survival frame;
  - lines 188-190: fewer than 10 -> no ranking (error code);
  - lines 196-202: `need = max(10, ceil(0.80 * len(rk_ids)))`, coverage =
    `n / len(rk_ids)`, a marker is offered only when `n >= need`; none ->
    the no-coverage error code;
  - line 204: `top = head(TOP_N)` (`TOP_N = 5`, pilot.py:49).
- `data.py::observed` lines 562-583: the survival frame — finite time and
  event and `time > L` (the horizon only picks one copy of those rows).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.environ["TXR_RUNNER_COPY"])
from ranking import rank_markers, is_companion  # noqa: E402

TOP_N = 5            # pilot.py:49
COVERAGE_MIN = 0.80  # pilot.py:50


def read_values_csv(path):
    """The app's canonical values table: patient_id, day, feature, value
    (an empty value cell = `None`, i.e. pandas NaN)."""
    return pd.read_csv(path, dtype={"patient_id": str})


def case_expected(values, outcomes, decision_day, baseline_max_day):
    values = values.copy()
    # data.py::read_values (lines 59-78): the runner's VALUES TABLE carries
    # only rows with a finite day and a finite value — the cohort's draw
    # rule counts NUMERIC rows only; a same-day empty cell can still win the
    # last-value tie at rank time (ranking.py::last_values keeps the row, its
    # NaN value then counts as missing).
    values_num = values[np.isfinite(values["day"]) & np.isfinite(values["value"])].copy()
    candidates = [f for f in values["feature"].unique() if not is_companion(str(f))]

    # pilot.py::Context.__init__ lines 149-154 — the unit cohort.
    coh = values_num[values_num["feature"].isin(set(candidates))]
    coh = coh[coh["day"] <= decision_day]
    base = set(coh.loc[coh["day"] <= baseline_max_day, "patient_id"])
    ont = set(coh.loc[coh["day"] > baseline_max_day, "patient_id"])
    cohort = base & ont

    # data.py::observed lines 562-583 — the survival frame (time > L).
    o = outcomes.copy()
    o = o[np.isfinite(o["time"]) & np.isfinite(o["event"]) & (o["time"] > decision_day)]
    frame = o.set_index("patient_id")[["time", "event"]]

    # pilot.py::_fold line 186 — ranking patients.
    rk_ids = [p for p in frame.index if p in cohort]
    if len(rk_ids) < 10:  # lines 188-190
        return {"error": "BUNDLE_MARKER_RANKING_TOO_FEW"}

    # ranking.py::rank_markers over the FULL values table (a same-day empty
    # cell stays and can win the tie — the app's ported rule).
    r = rank_markers(values, frame.loc[rk_ids], "survival", decision_day, features=candidates)

    # pilot.py::_fold lines 196-204 — coverage cut + top 5.
    need = max(10, int(np.ceil(COVERAGE_MIN * len(rk_ids))))
    r = r.assign(coverage=r["n"] / len(rk_ids))
    offered = r[r["n"] >= need]
    if offered.empty:  # lines 200-202
        return {"error": "BUNDLE_MARKER_RANKING_NO_COVERAGE"}
    return {
        "ranking": [
            {"marker": str(row.feature), "score": float(row.score), "n": int(row.n),
             "coverage": float(row.coverage)}
            for row in r.itertuples(index=False)
        ],
        "offered": [str(f) for f in offered["feature"]],
        "top": [str(f) for f in offered["feature"].head(TOP_N)],
        "ranking_patients": int(len(rk_ids)),
        "error": None,
    }


def main():
    root = sys.argv[1]
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        values = read_values_csv(os.path.join(d, "values.csv"))
        outcomes = pd.read_csv(os.path.join(d, "outcomes.csv"), dtype={"patient_id": str})
        with open(os.path.join(d, "case.json")) as f:
            case = json.load(f)
        expected = case_expected(values, outcomes, case["decision_day"], case["baseline_max_day"])
        with open(os.path.join(d, "expected.json"), "w") as f:
            json.dump(expected, f, indent=2)
        print(name, "->", expected.get("error") or f"{len(expected['top'])} top")


if __name__ == "__main__":
    main()
