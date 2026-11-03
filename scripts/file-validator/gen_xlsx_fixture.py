#!/usr/bin/env python3
"""Generate the tiny .xlsx fixture for the file-validator browser decode e2e
(PROV-FV-7 / TEST-FV-29).

The fixture pins the decode library's Excel behaviors against a REAL workbook:

* title rows above the header (header-row detection, DEC-6 — the header is on
  FILE row 3);
* a second sheet with a different table — first-sheet-only, the second sheet
  is never read;
* numeric cells (read back as text), an empty cell (null), a TRUE boolean cell
  (Excel's display text) and a date cell (ISO text).

It is SYNTHETIC (P001..P004, markers M1/M2, unit U/L) — no real patient data,
nothing from restricted/ (INV-4). Regenerate with:

    python3 scripts/file-validator/gen_xlsx_fixture.py

The output zip is re-packed with a fixed timestamp so repeated runs are
byte-identical (SOURCE_DATE_EPOCH semantics, like gen_material.py).
"""

import datetime
import os
import re
import zipfile

WORKTREE_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(WORKTREE_HERE, "..", ".."))
OUT = os.path.join(
    REPO_ROOT, "src-app", "ui", "tests", "gallery-e2e", "fixtures", "txr-measurements.xlsx"
)

from openpyxl import Workbook  # noqa: E402

TITLE_ROW_1 = ["Patient measurements export"]
TITLE_ROW_2 = ["Synthetic example - not real patient data"]
HEADER = ["patient_id", "day", "marker", "value", "unit"]
ROWS = [
    ["P001", 0, "M1", 12.5, "U/L"],
    ["P001", 14, "M2", 4.25, "U/L"],
    ["P002", 0, "M1", 9.1, "U/L"],
    ["P002", 21, "M1", None, "U/L"],  # empty cell -> null
    ["P003", -3, "M1", 7.7, "U/L"],
    ["P003", 7, "M1", True, "U/L"],  # Excel boolean -> TRUE
    ["P004", datetime.date(2024, 1, 15), "M1", 5.2, "U/L"],  # date cell
]
DECOY_HEADER = ["patient_id", "day", "marker", "value", "unit"]
DECOY_ROWS = [["Q999", 0, "M9", 1, "U/L"]]


def build() -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Measures"
    for row in [TITLE_ROW_1, TITLE_ROW_2, HEADER] + ROWS:
        ws.append(row)
    decoy = wb.create_sheet("Other sheet")
    for row in [DECOY_HEADER] + DECOY_ROWS:
        decoy.append(row)
    return wb


def repack_with_fixed_timestamp(source: str, target: str) -> None:
    """Rewrite the zip with fixed entry timestamps and drop the volatile
    docProps/core.xml (openpyxl stamps created/modified there) so repeated
    runs are byte-identical."""
    fixed = (1980, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename == "docProps/core.xml":
                continue
            data = zin.read(info.filename)
            out_info = zipfile.ZipInfo(info.filename, fixed)
            out_info.compress_type = zipfile.ZIP_DEFLATED
            out_info.external_attr = info.external_attr
            zout.writestr(out_info, data)


def main() -> int:
    tmp = os.path.join(os.path.dirname(OUT), ".txr-measurements.tmp.xlsx")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    book = build()
    book.save(tmp)
    repack_with_fixed_timestamp(tmp, OUT)
    os.unlink(tmp)
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    if "xl/worksheets/sheet2.xml" not in names:
        print("fixture is missing its second sheet", file=os.sys.stderr)
        return 1
    if len([n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)]) != 2:
        print("fixture should carry exactly two sheets", file=os.sys.stderr)
        return 1
    print(f"wrote {os.path.relpath(OUT, REPO_ROOT)} (rows: {len(ROWS)} + decoy sheet)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
