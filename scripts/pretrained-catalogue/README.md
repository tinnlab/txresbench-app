# Pretrained-model catalogue — build tools

The pretrained path of the app is data: a build-time catalogue of published
frozen models (`pack_model_txr.py` packs one model into the `.txr` container,
`gen_pretrained_catalogue.py` assembles the catalogue), the module that serves
and provisions it, and the owner's publish steps. This directory holds the
build tools; the runbook below is the owner's publish sequence. Every step is
run on a machine with access to `/data/share/pbya/sigtrans` and
`tinnlab/txresbench-models`; none of it is executed by a build worker
(STATUS.md merge protocol).

## The assets and the catalogue

- `.txr` container: the model-store container format (magic `TXR_MODL\0`,
  header JSON with the facts, framed entries, per-entry sha256, end magic),
  written deterministically by `pack_model_txr.py`. One container = one
  published model; the bytes are opaque to both tools (the store's import is
  the only reader; `tests/pretrained_catalogue/pack_model_test.rs` pins the
  two sides together).
- `models-manifest.tsv`: the curated enrollment. One row per catalogue entry:
  id, asset version (semver), kind (`published-rule` | `benchmark-trained`),
  method, release tag + file name, the packer's `sha256` + `size_bytes`, the
  bundled flag ("" = size-based default, 20 MiB cap), the data sources
  (`;`-separated dataset ids resolved through the benchmark registry, or
  inline `name|access|licence` paper-cohort sources), the model's data licence
  ("" = resolved from the sources), the packer inputs (`tree`, `facts` — empty
  when the publish workspace keeps them), the card text (name, description,
  citation) and the asset's analysis facts (decision day, endpoint, horizon,
  task, transfer metric).
- `assay-warnings.tsv`: the curated card warnings, one row per
  `method_id  code  detail` (a method's rows, in file order, are its
  `assay_warnings`).

## The publish runbook

1. **Pack.** Produce the method's frozen output (`SIGBENCH_MODE=fit` /
   `--frozen` per contract X1 writes `/model/`), then:
   `python3 scripts/pretrained-catalogue/pack_model_txr.py --tree <model-dir> --facts facts.json --out <id>@<version>.txr`
   The facts JSON carries the card's method facts, the needs, the env digests
   (from `src-app/server/data/method-env-images.json`, `base_digest` +
   `layer_sha256` — INV-7) and the licence; `--verify` re-opens the container.
   The packer prints `size_bytes:` and `sha256:` — record both.
2. **Publish.** Create the release asset `<id>@<version>.txr` under the release
   tag `<id>-v<version>` of `tinnlab/txresbench-models` (immutable: an asset
   change ships as a NEW version — the generator refuses changed bytes under
   the same id+version).
3. **Enroll.** Add one row to `models-manifest.tsv` (the packer's two numbers,
   the sources and their licences from `dev/code/datasets/<id>/dataset.yaml`
   or the inline paper-cohort form, the card text, the asset facts) and any
   warning rows to `assay-warnings.tsv`.
4. **Generate + gate.** `python3 scripts/pretrained-catalogue/gen_pretrained_catalogue.py`
   writes `data/pretrained-catalogue/catalogue.json` (the embedded snapshot),
   `data/pretrained-catalogue/bundled-models.json` (the installer extract) and
   `site/public/pretrained-catalogue.json` (byte-identical served copy). The
   run gate refuses a controlled/undeclared source, an empty licence, a
   non-sha256 asset, a GENIE record-id source, a published-rule whose method is
   not frozen+container+gate-pass in the registry, or a changed asset under
   its version — `--check-restricted` runs the gate alone, `--check` verifies
   the committed files match a fresh generation, `--selftest` runs the
   generator's own invariant matrix against the synthetic fixtures.
5. **Commit.** The three generated files + the manifest/TSV rows + any card
   wording, in one commit (the catalogue is the frozen contract ITEM-3 boots
   from).
6. **Pages deploy.** The landing-site build serves
   `site/public/pretrained-catalogue.json` byte-identically (landing-site
   runbook); the app's boot refresh reads it (pretrained-catalogue module).
7. **Installer re-bundle.** The installer build reads
   `data/pretrained-catalogue/bundled-models.json`, fetches each `url` (the
   bytes must hash to the recorded `sha256`) and ships the bundled
   `file`s + the manifest next to them (installers-release pipeline).

## Facts worth knowing

- The catalogue is generated from committed inputs only: the benchmark tree
  via `SIGTRANS_ROOT` (default `/data/share/pbya/sigtrans`), the method
  catalogue (`data/method-catalogue/catalogue.json`), the env manifest
  (`src-app/server/data/method-env-images.json`) and the two curated TSVs.
  `SOURCE_DATE_EPOCH` pins `generated_at` for reproducible builds.
- Every entry's `needs` is the method catalogue's assembled facts (one fact
  assembly — a pretrained card's verdicts never diverge from the method
  card's); `decision_day`/`endpoint`/`horizon`/`task` are the asset's own
  curated analysis facts. The container header's `task` is the outcome flavor
  (`pfs`/`os`/`response`) — a different field from the card's `needs.task`
  (`survival`/`response`); the generator cross-checks the mapping whenever it
  packs in-tree assets.
- `benchmark-trained` entries are carried by the schema and the fixtures but
  are never emitted by the generator: no saved fitted models exist yet
  (models.md: "not in this task").
- Zero network: the generator reads files; downloads and sha256 verification
  are the module's runtime path (INV-2), and the app never reads the
  benchmark tree.
