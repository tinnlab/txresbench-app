# TxResBench site

The GitHub Pages site for the TxResBench desktop app. Three things are served
from one origin:

1. the landing page (design board M): who the app is for, what it does, the
   downloads, the privacy promise, the research-use notice;
2. the update feed `updates/latest.json` — Tauri v2 updater static JSON;
3. the pretrained-model catalogue `pretrained-catalogue.json`.

Everything here is plain static files. The page is HTML + CSS with no
JavaScript; the two feeds are JSON. No server code runs, no analytics, no
third-party requests — the only hosts any published file may reference are
`github.com` and `tinnlab.github.io`, enforced by the node's own test suite.

## Layout

| path | what it is |
|---|---|
| `site/src/` | the page template (`index.html`), `styles.css`, and the self-hosted assets (`fonts/`, `img/`, `favicon*`) |
| `site/config.json` | the site's single values file (schema v1) — every number, link and download row on the page |
| `site/public/` | the two machine feeds, written by the producer nodes and copied byte-identical |
| `site/tests/` | the node's test suite (plain `node --test`, zero dependencies) |
| `site/dist/` | the build output and GitHub Pages publish root — gitignored, never committed |
| `scripts/build-landing-site.mjs` | the zero-dependency build |

The site is additive and self-contained: it touches nothing under `src-app/`,
adds no npm package, no Cargo crate, no migration, no `just` recipe, and it is
inert to `just check` (its own gate is the test suite below).

## Build

```bash
node scripts/build-landing-site.mjs
```

Reads `site/config.json`, `site/src/index.html`, `site/src/**` and
`site/public/**`; writes `site/dist/` (the publish root). Options:

```bash
node scripts/build-landing-site.mjs --out <dir>           # publish dir (default site/dist)
                                    --config <file>        # values file (default site/config.json)
                                    --tauri-conf <file>    # app manifest (default src-app/desktop/tauri/tauri.conf.json)
                                    --public <dir>         # feeds dir (default site/public)
node scripts/build-landing-site.mjs --print-urls           # print the three canonical URLs
```

The build fails (exit 1, naming the field or file) when a config value is
missing or malformed, when `config.product.version` drifts from the Tauri
manifest's `version`, when a hosted feed is present but invalid, or when an
unexpected file sits in `site/public/`. It exits 0 only with a complete,
validated `dist/`. Output is deterministic: two builds of the same tree are
byte-identical, and copied files (assets, feeds) are verified byte-identical
by sha256. No `npm install` is needed — the build and the tests use Node
builtins only.

## Canonical URLs

The paths are stable (the version travels in the file contents, never in the
URL), printed by `--print-urls`:

| constant | URL |
|---|---|
| BASE / LANDING | `https://tinnlab.github.io/txresbench-app/` |
| FEED | `https://tinnlab.github.io/txresbench-app/updates/latest.json` |
| CATALOGUE | `https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json` |

The app's update check reads FEED; the models downloader reads CATALOGUE.
Both are plain GETs with no query strings, no cookies and no identifiers
(owner decision D03).

## `site/config.json` (schema v1)

| field | type | rules |
|---|---|---|
| `schema` | `1` | the schema version |
| `product.name` | string | non-empty |
| `product.version` | string | MUST equal the `version` of `src-app/desktop/tauri/tauri.conf.json` — drift fails the build naming both values (the download URLs also carry it: each `downloads[].url` tag must be `app-v<product.version>`) |
| `paper` | object or `null` | `null` hides the paper band, the nav "Paper" entry and the hero "Cite" link entirely; a present object needs `author`, `title`, `venue`, `year`, `doi`, `cite_url`, `bibtex_url`, the two URLs on an allowed host |
| `stats` | object | `methods`, `datasets`, `patients`, `prediction_kinds` — non-negative numbers, rendered in the stats band |
| `methods[]` | array | `{id, group}` chips; `group` one of `response-call`, `response-probability`, `static-risk`, `dynamic-risk` |
| `downloads[]` | array (non-empty) | one tile per row: `os`, `label`, `detail`, `kind` (`dmg` for macOS, `nsis` for Windows, `deb`/`appimage` for Linux — the release node's four combos), `url` (a `https://github.com/tinnlab/txresbench-app/releases/(tag|download)/app-v<semver>/…` asset URL), `size_mb`, `sha256` (64 lowercase hex). A row with `size_mb: 0` renders no size claim, and the 64-zero digest is the pre-release marker the release pipeline replaces at the first release |
| `system` | object | `memory_gb`, `disk_gb` — rendered in the download note |
| `links` | object | `source`, `licence`, `third_party`, `issues`, `releases`, `benchmark`, `notes` — absolute URLs on `github.com` or `tinnlab.github.io` only |

There is no way to ship an unset value: every field is checked, and the page
carries no text that is not rendered from this file.

## Machine feeds

Both files live under `site/public/`, may be absent (a 404 is the correct
"nothing yet" answer — the app treats it as "no update" / "no catalogue"),
and are copied to the publish root byte-identical after validation. `site/public/`
may contain exactly these two files; anything else fails the build.

### `updates/latest.json` (written by installers-release)

The Tauri v2 updater static-JSON shape: a root object with `version` (semver),
optional `pub_date` (RFC3339 with a zone offset), optional `notes` (string),
and `platforms` — an object with at least one key of
`darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`, `windows-x86_64`, each
entry an object with a non-empty `url` and a non-empty `signature`. Unknown
top-level or platform keys, a missing `platforms`, a non-semver `version` or
a malformed `pub_date` fail the build naming the defect. The writer must
replace the file wholesale at every release; the site never rewrites it
(Tauri verifies the signature against these exact bytes).

### `pretrained-catalogue.json` (written by pretrained-catalogue)

A JSON object root whose field schema belongs to the
`pretrained-catalogue` node (models id/version/url/size/sha256, an optional
signature field, card fields — `dev/docs/app-briefs/models.md`). The site
imposes exactly two rules: the root is an object, and every field named
`url` carrying an `http(s)://` value must point at `github.com` or
`tinnlab.github.io`. Keep the download location in `url` (the
`github.com/tinnlab/txresbench-models` release asset); name citation or
licence links differently (e.g. `paper_url`) — the host policy keys on the
property name.

`pretrained-catalogue` and `installers-release` consume these files from the
canonical URLs above; when their code dials `tinnlab.github.io` they add it
(and the asset host their downloads follow) to `scripts/network-allowlist.txt`
in their own trees — the repo guard does not scan `site/`, and this node adds
no allowlist entry.

## Tests

```bash
node --test 'site/tests/*.test.mjs'   # from the repo root — the glob form is required
```

The suite asserts the published promises against the built output: no board
example values, no third-party host, no `<script>`, the design's sections and
wording, byte-identical feed copies, the Tauri v2 wire shape, the config
schema cases, version drift, download-row wiring, no data files, and the
disabled-workflow + diff-surface checks (TEST-17/18). A visual pass over the
rendered page at 1280 px and 390 px is recorded in
`site/tests/visual-review.md` (TEST-11). Two repo guards complete the node's
gate: `scripts/check-network-allowlist.sh` and
`scripts/check-guard-integrity.sh` (the build script is deliberately not
`scripts/check-*`, so the guard inventory stays untouched).

## Publishing (owner runbook)

The deploy is owner-gated (owner decisions D10 "owner publishes", D61 "the
owner runs the real release"); no worker, no CI run outside this repository
publishes the site. The path, in order:

1. **Verify.** On the release worktree: `node --test 'site/tests/*.test.mjs'`
   (all green), then `scripts/check-network-allowlist.sh` and
   `scripts/check-guard-integrity.sh` (both pass), then
   `node scripts/build-landing-site.mjs`, then serve `site/dist/` over a
   local static server and complete `site/tests/visual-review.md` (TEST-11)
   at 1280 px and 390 px.
2. **Refresh the values at a release.** `installers-release`'s
   `write-downloads-config.mjs` replaces the `downloads[]` rows of
   `site/config.json` with the built artifacts' real sizes and sha256 and
   moves `product.version` together with
   `src-app/desktop/tauri/tauri.conf.json` and the release tag —
   the build's drift checks refuse a partial update. Between releases,
   import the published benchmark census into `stats` and `methods` (owner
   decision D57) and replace `site/public/` files as the producers emit
   them. Commit the refresh before tagging — the tag push deploys the
   tagged commit's tree, so an uncommitted config change would be absent
   from the publish.
3. **Enable the workflow (one time).** In the repository settings, choose
   Pages → Source → **GitHub Actions**, then rename the parked workflow:
   `git mv .github/workflows/pages.yml.disabled .github/workflows/pages.yml`
   and commit. Nothing deploys before this step — GitHub ignores the
   `.disabled` filename.
4. **Deploy.** Push an `app-v<version>` tag (the same tag `release.yml`
   builds the installers from; the site deploys on it too), or use the
   workflow's `workflow_dispatch` for a feeds-or-values-only update between
   releases. The workflow builds with the same
   `node scripts/build-landing-site.mjs` and uploads `site/dist`.
5. **Verify the publish.** With the deployment's page URL (the canonical
   LANDING URL above): the page shows the release's version and sizes, the
   board's example values never appear, `FEED` and `CATALOGUE` answer 200
   with the JSON the producers emitted (or 404 while the files are absent),
   and `pretrained-catalogue.json` bytes equal the bytes of the file the
   producer shipped (sha256).

## Rules the site inherits

- **No data.** No patient-level data and no benchmark result rows in the
  repository; the page's numbers come from `site/config.json`.
- **No third-party requests.** The page loads only its own assets; the only
  outbound references are user-opened links to `github.com/tinnlab/*` and
  `tinnlab.github.io/*`.
- **No unverified claims.** Every value is real at build time; a missing or
  inconsistent value fails the build rather than shipping an approximation.
- **Nothing of the framework is changed.** The site is a new, separate
  static tree; `src-app/**`, the workspace, the lockfiles and the guard
  inventory are untouched.
