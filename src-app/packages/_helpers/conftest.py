# Stable import-path wiring for the processor-script test suites. Adds:
#   * THIS `_helpers` dir → `align`, `colsummary` (the shared sibling helpers the sandbox
#                         runner stages side-by-side with each entry script; re-homed here
#                         from the former baked `scripts/` in D2 Slice 5).
#   * packages/annotation-integrate → `annotation_integrate` (its own processor folder;
#                         the runner stages it alongside the shared helpers at run time).
# Mirrors how the real sandbox runner assembles /code, so `python3 -m pytest` discovers
# and imports the modules from a stable root regardless of the invoking cwd.
import os
import sys

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
# _helpers → processors → src-app  (2 levels up)
_SRC_APP = os.path.abspath(os.path.join(_SCRIPTS, *([os.pardir] * 2)))
_EXT = os.path.join(_SRC_APP, "packages", "annotation-integrate")
# packages/_lib → `cyto_zarr` / `cyto_columns`, the shared OUTPUT-FORMAT library
# (DEC-7). The runner stages these into `/code` next to the shared helpers, so the
# suites must resolve them the same way or every compute script fails at import.
_LIB = os.path.join(_SRC_APP, "packages", "_lib")

for _p in (_SCRIPTS, _EXT, _LIB):
    if _p not in sys.path:
        sys.path.insert(0, _p)
