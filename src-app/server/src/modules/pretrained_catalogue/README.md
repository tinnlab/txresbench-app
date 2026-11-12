# pretrained_catalogue

The frozen published models feature of the TxResBench app: an app-owned,
build-time-generated catalogue of pretrained model cards (source paper,
needs, decision day, results on other cohorts from the benchmark results,
assay warnings, data licence, research-use notice) plus the provisioning
path — download, sha256 verification, cache, install into the local model
store — and the per-model eligibility + time estimates the "Choose the
models to run" list renders. Everything runs on the user's machine; the
only network use is the catalogue refresh and the asset downloads, both
plain GETs of stable URLs (no identifiers, INV-4).

## What is generated from what

The catalogue is data, produced by a build-time script and committed; the
runtime embeds the bytes (`include_bytes!`, the first-party posture of
`extensions::embedded`).

| produced | from |
|---|---|
| `data/pretrained-catalogue/catalogue.json` (embedded snapshot) | `scripts/pretrained-catalogue/gen_pretrained_catalogue.py` reading the curated `models-manifest.tsv` + `assay-warnings.tsv`, the sibling method catalogue (`data/method-catalogue/catalogue.json`), the env-images manifest and the benchmark facts via `SIGTRANS_ROOT` |
| `data/pretrained-catalogue/bundled-models.json` | the same run — the `asset` fields of the `bundled: true` entries, the installer-build extract |
| `site/public/pretrained-catalogue.json` | the same run — the served copy, byte-identical at generation time |

The owner's publish runbook (pack the `.txr` asset with
`pack_model_txr.py`, create the immutable release in
`tinnlab/txresbench-models`, enrol it in `models-manifest.tsv`, generate and
commit) is `scripts/pretrained-catalogue/README.md`.

## The three catalogue layers

1. **Embedded** — the snapshot compiled into the binary; a malformed or
   schema-drifted file fails boot (DEC-16). An empty `models[]` is valid:
   the first release's entries are the owner's curate step.
2. **Disk** — the last good live copy at
   `<data_root>/txr-pretrained/catalogue.json`, validated by the same
   hygiene rules.
3. **Live** — `POST /api/txr/pretrained/refresh` fetches
   `https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json`
   (the landing-site CATALOGUE constant; overridable through the
   `TXR_CATALOGUE_URL` env seam), validates, writes the last-good copy
   and serves. A failed refresh is silent — offline is a valid state and
   never fails boot (INV-8).

Each entry's `asset.url` host must be `github.com` or `tinnlab.github.io`
(the shared `host_allowed`, which also admits loopback for the test seams);
the downloader gates the same policy before any socket work, and the guard
lists `objects.githubusercontent.com` because the release download URL
redirects to it.

## The provisioning path (PROV-PC-6/PROV-PC-7)

- State layout (DEC-13, under the app data root): `<data_root>/pretrained/
  staging/<id>@<version>.txr.part` (the in-flight transfer), `<data_root>/
  pretrained/cache/<sha256>.txr` (verified, content-addressed),
  `<data_root>/txr-pretrained/<id>.json` (per-id terminal state,
  atomic-write, survives a restart), `<data_root>/pretrained-bundled/` (the
  installer bundle, overridable through `TXR_BUNDLED_MODELS_DIR`).
- At most two transfers in flight; one per id (a second start joins the
  running transfer); the state vocabulary is the method-environment
  manager's (`not_downloaded` / `downloading` / `ready` / `failed`).
- The sha256 over the streamed bytes is compared to the catalogue entry's
  recorded value BEFORE the bytes move: a mismatch is `failed` +
  `PRETRAINED_VERIFY_FAILED`, the staged file is removed, and nothing
  unverified ever reaches the cache or the store (INV-2); a byte-flipped
  bundled file answers `409 PRETRAINED_VERIFY_FAILED` and is quarantined
  (`<file>.rejected`).
- Install source order (INV-8): verified bundle → verified cache →
  download. The verified bytes are handed to
  `model_store::store::install_imported_from_path` with
  `Provenance::Pretrained{catalogue_id, version, licence}` — the module
  never reads the store's tables; the installed row is queried through
  `model_store::store::list_pretrained` for the strict id/version mapping
  (`installed_model_id`) and install idempotency.

## The routes

All eight are request/response, `with_permission(JobsUse)` (the app-wide
`txr` gate — no new permission):

| operation | path |
|---|---|
| list | `GET /api/txr/pretrained` |
| card | `GET /api/txr/pretrained/{id}` |
| install | `POST /api/txr/pretrained/{id}/install` |
| start download | `POST /api/txr/pretrained/{id}/download` |
| download states | `GET /api/txr/pretrained/downloads` |
| cancel (+ prune) | `DELETE /api/txr/pretrained/{id}/download?prune=true` |
| refresh | `POST /api/txr/pretrained/refresh` |
| eligibility | `POST /api/txr/pretrained/eligibility` |

The eligibility verdicts are computed from the entry's recorded `needs`
through the method catalogue's OWN matchers (`required_marker_match` +
`parse_standard_ids`) and estimator — a pretrained model's "Can run" means
the same thing as a method's; the reason-code vocabulary is PROV-MC-5's
plus the catalogue's `ASSET_NOT_AVAILABLE` (defensive). The module never
executes a model: the run path is the engine's own reuse mode driven by
`POST /api/txr/models/resolve` (INV-6).

## The in-process seams

`catalogue()` (the boot-validated snapshot), `model(id)`,
`bundled_assets()` and `ensure_installed(pool, id)` serve the other server
modules; `PretrainedCatalogueSeams` is the constructor seam the tests and
the harness use (never process-global `set_var`).
