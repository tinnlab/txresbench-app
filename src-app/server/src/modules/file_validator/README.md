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

The six CSV assets are DATA, produced by a script at build time and committed;
the runtime only embeds the bytes. The generator is
`scripts/file-validator/gen_material.py`.

| produced | from (the benchmark tree, read at build time only) |
|---|---|
| `data/file-validator/templates/patients.csv` (header only: `patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage`) | the board's C-screen column spec (the qa-fixes3 ITEM-3 growth: the optional response columns joined the spec because the example family carries both outcomes) |
| `data/file-validator/templates/measurements.csv` (header only: `patient_id,day,marker,value,unit`) | the board's measurements column spec |
| `data/file-validator/examples/patients.csv` (101 lines) | the app's seeded example simulator (qa-fixes3 ITEM-3): 100 synthetic patients `J0000..`, ids and markers synthetic, never real patient data |
| `data/file-validator/examples/measurements.csv` (2959 lines) | the same simulator: the training draws of those 100 patients (`M1`/`M2`/`M3` in `a.u.`, days −28..336, outcomes driven a little by the markers) |
| `data/file-validator/examples/predict-measurements.csv` (270 lines) | the same simulator: 15 NEW patients `J1000..` to predict (the same markers, no outcomes — the N screen's file shape) |
| `data/file-validator/tidy-2.0.json` (byte-identical to the benchmark contract — NOT read by the server) | `dev/code/benchmark/analysis-engine/contract/tidy/2.0.json`, the rule set the Rust port implements |

The example family is SYNTHESIZED by the generator's seeded simulator (fixed
MT19937 seeds — byte-identical every run, no clock, no machine paths): markers
`M1` (informative), `M2` (mildly informative) and `M3` (noise) in the
synthetic world's own `a.u.` unit; draw days before (−28/−14) and during
(0..56) treatment with follow-up draws; outcomes for survival (`pfs`/`os`)
and response (`responder`/`response_day`). The invariant check in the
generator asserts the informative marker's on-treatment change separates the
response labels (≥ 0.8 a.u. gap), so predictions trained on the example are
never constant. The source facts (sigtrans HEAD
`47f142124dc684ccd075c3764560dcc4dd7285dc`, the contract file untracked in
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

## OpenAPI regen

The four routes emit request/response schemas into the shared client; after a
route or type change, regenerate and commit the generated output in the same
change (the regen-parity leg of the suite):

```bash
cd src-app/server && CONFIG_FILE=config/dev.yaml cargo run -- --generate-openapi ../ui/openapi
```

That writes `src-app/ui/openapi/openapi.json` and the four
`src-app/ui/src/api-client/*` files. The server links no format-parsing crate
and performs no network I/O; the only build-time inputs are the embedded
assets and the committed catalogue (see above).

## Runtime behaviour

Fixed by this file and unchanged by regenerating: no `SIGTRANS_ROOT`, no
benchmark tree, no network — the embedded bytes are the only source. The six
CSVs are validated once at boot (every asset non-empty, no NUL byte, first line
equal to its declared column spec): an empty or header-broken asset is a boot
refusal, and a missing asset does not compile. The module is a server module
(`ModuleEntry` order 48, unique in the linked set), holds no state between
requests and registers no events.
