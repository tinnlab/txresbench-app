#!/usr/bin/env python3
"""Tests for scripts/dev-registry/make-real-inputs.py (qa-fixes ITEM-6, TEST-QF-6).

The converter's survival-time rule is the F8 fix: the tidy patients table
declares the unit of every survival value in its own `time_unit` column, and
the converter must respect that declaration (day pass-through, month x
30.4375, anything else refuses) instead of assuming months. The old rule
multiplied ALREADY-DAY values by 30.4375 and shipped follow-ups of up to
32,812 days (90 years); the range check would refuse that same input today.

Unittest, stdlib only, no network, no data of any kind: the unit rule is
pure; the real-dataset generation leg runs only when the open benchmark tree
is present and writes its output under /data/pbya/txresbench-app-work/
(never /tmp, never the repo).

Run: python3 scripts/dev-registry/make_real_inputs.test.py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "make_real_inputs", os.path.join(_HERE, "make-real-inputs.py")
)
conv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(conv)

#: The default output root of the real-dataset leg (outside the repo, DEC-1).
DEFAULT_OUT = "/data/pbya/txresbench-app-work/qa-data"
#: The open benchmark tree root (read-only; the real leg needs the tidy col).
BENCHMARK_TREE = "/data/share/pbya/sigtrans/dev/data/benchmark/Bratman2020_INSPIRE-ctDNA/tidy"


class SurvivalUnitRuleTests(unittest.TestCase):
    """The pure unit rule (the F8 fix's core, no data touched)."""

    def test_day_values_pass_through(self):
        # tidy values declared in days must ship AS DAYS (the old converter
        # multiplied them by 30.4375 - qa-fixes ITEM-6, F8).
        self.assertEqual(conv.survival_unit_of("days"), "day")
        self.assertEqual(conv.survival_unit_of("day"), "day")
        self.assertEqual(conv.convert_survival_time(637.0, "day"), 637)
        self.assertEqual(conv.convert_survival_time(59.0, "days"), 59)

    def test_month_values_convert_with_the_benchmark_factor(self):
        self.assertEqual(conv.survival_unit_of("month"), "month")
        self.assertEqual(conv.survival_unit_of("months"), "month")
        self.assertEqual(conv.convert_survival_time(12.0, "month"), 365)

    def test_unrecognized_unit_refuses_loudly(self):
        with self.assertRaises(RuntimeError):
            conv.survival_unit_of("fortnights")

    def test_implausible_range_is_refused(self):
        # The F8 defect's own shape: a value already in DAYS treated as months
        # would convert to 32,812 days - the range check must refuse it.
        with self.assertRaises(RuntimeError):
            conv.convert_survival_time(1078.0, "month")
        with self.assertRaises(RuntimeError):
            conv.convert_survival_time(-1.0, "day")


class RealDatasetRangeTests(unittest.TestCase):
    """The real-dataset generation leg: ranges stay plausible (TEST-QF-6).

    Runs only when the open benchmark tidy tree is present; self-skipped
    otherwise (the honest record, never a silent pass).
    """

    def test_real_inputs_ranges_stay_plausible(self):
        if not os.path.isdir(BENCHMARK_TREE):
            self.skipTest("open benchmark tree not present")
        out_root = tempfile.mkdtemp(prefix="txr-real-inputs-", dir=DEFAULT_OUT)
        try:
            conv.main(["--out", out_root])
            with open(os.path.join(out_root, "Bratman2020_INSPIRE-ctDNA-app", "inputs.json")) as fh:
                facts = json.load(fh)
            pfs = facts["pfs_days_range"]
            self.assertLessEqual(pfs[1], conv.MAX_PLAUSIBLE_DAYS)
            self.assertGreater(pfs[1], pfs[0])
            self.assertEqual(facts["survival_time_unit"], "day (tidy time_unit declaration)")
            self.assertEqual(facts["n_primary_events"], 82, "pfs_event==1 in the tidy")
            self.assertEqual(facts["n_patients"], 94)
        finally:
            shutil.rmtree(out_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
