# file_validator

The shared file layer of the TxResBench app: a DB-free, stateless server module
that owns the two-file contract of the upload screens (a patients table and a
measurements table of blood markers over time), the tidy-2.0 validation rule
semantics applied to those files, marker vocabulary matching with join offers,
unit checks, per-patient marker coverage, the canonical rows an execution
engine turns into a container `/input` bundle, and the template/example CSV
downloads. It performs no network I/O at run time, keeps no state and has no
write path (no database, no migration).

Byte decoding stays in the browser (CSV text, XLSX zip/XML — the server links
no format-parsing crate); the server receives a `ParsedTable` of raw cells and
applies the rules. Both screens — C (patients + measurements) and N
(measurements only) — run this one pipeline.

## What is generated from what

The four CSV assets are DATA, produced by a script at build time and committed;
the runtime only embeds the bytes. The generator is
`scripts/file-validator/gen_material.py`.

| produced | from (the benchmark tree, read at build time only) |
|---|---|
| `data/file-validator/templates/patients.csv` (header only: `patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage`) | the board's C-screen column spec |
| `data/file-validator/templates/measurements.csv` (header only: `patient_id,day,marker,value,unit`) | the board's measurements column spec |
| `data/file-validator/examples/patients.csv` (300 rows) | the open synthetic world `dev/code/benchmark/data-synth/jm_s1/tidy/patients.csv` (`platform: synthetic`, ids `J0000..`, never real patient data) |
| `data/file-validator/examples/measurements.csv` (3848 rows) | `jm_s1/tidy/values.csv` + `features.csv` (the `unit` column comes from `features.csv`) |
| `data/file-validator/tidy-2.0.json` (byte-identical to the benchmark contract — NOT read by the server) | `dev/code/benchmark/analysis-engine/contract/tidy/2.0.json`, the rule set the Rust port implements |

The example's unit is the synthetic world's own `a.u.`; the marker names are
`M1`/`M2` and the day range 0–336. The source facts (sigtrans HEAD
`47f142124dc684ccd075c3764560dcc4dd7285dc`, the three source CSVs untracked in
the sigtrans repo — the pin is byte parity against the working tree, not a
commit) are recorded by `--print-provenance`.

## Regen runbook

Prerequisite: `python3` on the build machine. The benchmark tree path comes
from `SIGTRANS_ROOT` (default `/data/share/pbya/sigtrans`); it is never read at
run time.

```bash
# Hermetic checks (no benchmark tree needed) — run these first:
python3 scripts/file-validator/gen_material.py --selftest
python3 scripts/file-validator/gen_material.py --check --fixtures

# Real regeneration (the benchmark tree must exist):
python3 scripts/file-validator/gen_material.py
# Parity check vs the committed files (byte-exact):
python3 scripts/file-validator/gen_material.py --check
```

All commands write only what is named; `--check` and `--selftest` write nothing.
The fixture write mode writes to `scripts/file-validator/fixtures/out/`
(gitignored) unless `--out` names the committed `fixtures/expected/` target.

## Runtime behaviour

Fixed by this file and unchanged by regenerating: no `SIGTRANS_ROOT`, no
benchmark tree, no network — the embedded bytes are the only source. The four
CSVs are validated once at boot (every asset non-empty, no NUL byte, first line
equal to its declared column spec): an empty or header-broken asset is a boot
refusal, and a missing asset does not compile. The module is a server module
(`ModuleEntry` order 48, unique in the linked set), holds no state between
requests and registers no events.
