# method_catalogue

The method catalogue module of the TxResBench app: a DB-free, stateless server
module that owns the app's method facts (the runnable method set of the
benchmark), the marker vocabulary with the seven board groups, the eligibility
matching engine and the time-estimate model. It embeds a generated catalogue at
build time, serves five typed endpoints under `/api/methods`, and exposes an
in-process Rust seam for the other server modules. It performs no network I/O
at run time, keeps no state and has no write path (no database, no migration —
a later SQLite switch does not touch it).

## What is generated from what

The catalogue is DATA, produced by a script at build time and committed; the
runtime only embeds the bytes. The generator is
`scripts/method-catalogue/gen_method_catalogue.py`.

| produced | from (the benchmark tree, read at build time only) |
|---|---|
| `data/method-catalogue/catalogue.json` (the committed real catalogue) | the benchmark registry `dev/code/manifest/methods.csv`, the per-method package manifests `methods/methods/<id>/method.json`, the gate results `methods/gates/<id>.json`, the curated draw facts `dev/code/benchmark/schema/per-method/mindraws/*.json`, the curated marker vocabulary `dev/analysis-catalog/datasets/*/{markers,mapping}.yaml`, the stored aggregates `results/benchmark/{runs,scores}.csv`, plus the two curated files `scripts/method-catalogue/{marker-groups,model-warnings}.tsv` |
| `scripts/method-catalogue/fixtures/expected-catalogue.json` | the synthetic fixture registry (`scripts/method-catalogue/fixtures/`) — the hermetic parity target, never the real data |

Rules that shape the catalogue (two curated, hand-reviewed files, not guessed):
`marker-groups.tsv` maps a standard-id marker to one of the seven board groups;
`model-warnings.tsv` maps a method id to the `embeds_training_data` fact (a
`true` row means the method's saved model keeps its training data inside the
model file; absent rows are `false`). The runnable set only is emitted (a
method with no env image is not listed — the app is for clinicians, not research
wrappers the app cannot run).

## Regen runbook

Prerequisite: `python3` + `PyYAML` on the build machine (the generator's only
dependency; the app runtime has none of it). The benchmark tree path comes from
`SIGTRANS_ROOT` (default `/data/share/pbya/sigtrans`); it is never read at run
time.

```bash
# Hermetic checks (no benchmark tree needed) — run these first:
python3 scripts/method-catalogue/gen_method_catalogue.py --selftest
python3 scripts/method-catalogue/gen_method_catalogue.py --check --fixtures

# Real regeneration (the benchmark tree must exist):
SOURCE_DATE_EPOCH=$(date -u +%s) \
  python3 scripts/method-catalogue/gen_method_catalogue.py
# Parity check vs the committed file (generated_at excluded):
python3 scripts/method-catalogue/gen_method_catalogue.py --check

# Review proposal for the curated marker-group mapping (OWNER-3 surface):
python3 scripts/method-catalogue/gen_method_catalogue.py --propose-groups
```

All commands write only what is named (the default output path, `.tsv` proposal
paths); `--check` and `--selftest` write nothing.

## Owner-only re-run note

The committed real catalogue is an OWNER decision: regeneration rewrites the
facts (enrichments, timings, vocabulary) from a live benchmark tree, so the
owner runs it, reviews the diff of `data/method-catalogue/catalogue.json` and
commits it with the generator change. A stale real-mode `--check` (the fresh
tree has moved on) is a review reminder, not a build failure; the CI-parity
gate is the fixture `--check`, which is hermetic. The catalogue schema is
version 1 (a generated field the binary does not model is a boot refusal by
design — bump the schema together with the module).

Runtime behaviour is fixed by this file and cannot be changed by regenerating:
no `SIGTRANS_ROOT`, no benchmark tree, no network — the embedded bytes are the
only source (the server binary itself contains them).
