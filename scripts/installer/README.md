# Installer pipeline — tools and owner runbook

This directory holds the release pipeline that produces the TxResBench
installers, the updater feed and the landing page's download rows:

- `bundle-pretrained-models.mjs` (PROV-IR-4) — stages the bundled
  pretrained-model set into `src-app/desktop/tauri/resources/pretrained-bundled/`
  at build time: fetch each `data/pretrained-catalogue/bundled-models.json`
  entry, verify sha256 + size, stage via `.part`-rename, then copy the
  manifest byte-identical; `--check` verifies the staged set, `--dry-run`
  prints the plan and fetches nothing. An absent manifest is a valid
  no-models state (exit 0, nothing staged).
- `discover-artifacts.mjs` (PROV-IR-1 fan-out) — reads the Tauri bundler
  output (per-OS directories under `target/release/bundle/`) and prints the
  `ArtifactSet`: the four user-download rows (macos/dmg, windows/nsis,
  linux/deb, linux/appimage) and the three updater payloads (AppImage, the
  universal `.app.tar.gz`, the NSIS exe) with their `.sig` siblings, each
  sized and sha256-verified. `src-app/desktop/tauri/tauri.conf.json`
  `version` is the single version source (DEC-13): the CLI cross-checks the
  artifact names against it and refuses a mismatch, never trusting filenames
  alone.
- `make-update-feed.mjs` (PROV-IR-2) — writes `site/public/updates/latest.json`
  in the Tauri v2 static-JSON shape the landing-site build validates
  (`{version, pub_date?, notes?, platforms{...}}`, one universal `.app.tar.gz`
  under both darwin keys, AppImage under linux, NSIS under windows; each entry
  `url` on the release-download pattern, `signature` = the `.sig` bytes
  verbatim). An empty or missing signature is a named abort: an unsigned
  update is never written.
- `write-downloads-config.mjs` (PROV-IR-3) — fills the `downloads[]` rows of
  `site/config.json` (url, `size_mb` = ceil of the byte size / 1 MiB, sha256)
  from the discovered set, keeping the landing site's own label/detail copy
  and row order, preserving every other key, and refusing a
  `product.version`/artifact mismatch (both values named).
- `scripts/build-installer-local.sh` (repo root) — the local Linux rehearsal:
  stage the bundled models, then `tauri build --bundles deb,appimage`;
  `--skip-models` drops the staging step, `--dry-run` prints the plan and
  executes nothing.

The pipeline's published values are the app's actual promises: the bundled
models make the pretrained path work offline (INV-3), and the update feed is
the one network call the shipped app makes at start — its host
(`tinnlab.github.io`) is the only runtime host this node adds, recorded in
`scripts/network-allowlist.txt` (DEC-16).

## The local rehearsal

Run on a Linux machine with the Tauri prereqs (the release matrix's apt list)
and `npm ci` already done:

1. **Stage + build:** `scripts/build-installer-local.sh` — stages the
   bundled models and builds deb + AppImage. `--dry-run` shows the exact
   plan first; `--skip-models` covers a checkout or machine with no model-host
   reachability.
2. **Feed + rows on the fixture set:** the full four-platform chain cannot be
   built on a Linux-only machine (discovery needs all four OS bundles), so the
   pipeline steps are rehearsed against the synthetic fixture bundle under
   `scripts/installer/fixtures/` (0.2.0, with the fixture
   `tauri-app-conf-0.2.0.json`): `node --test scripts/installer/*.test.mjs
   scripts/installer/lib/*.test.mjs scripts/build-installer-local.test.mjs`
   — the suites drive discover → feed → config → real `build-landing-site.mjs`
   end to end (TEST-IR-18) and never touch the network.
3. **Guards:** `scripts/check-network-allowlist.sh`,
   `scripts/check-guard-integrity.sh` and
   `scripts/check-no-study-domain-literals.sh` on the release tree, plus
   `cargo test -p cytoanalyst-desktop` for the desktop shell the installers
   ship.

The local build is unsigned (there is no signing key on a build machine) and
its artifacts are Linux-only, so it never feeds the real feed — that is the
workflow's job, and the writer refuses to publish an unsigned or incomplete
set whichever way it is run.

## The release sequence (owner-gated)

Every step below is executed by the repository owner; no build worker runs
the release pipeline (STATUS.md merge protocol). The model-host assets and
the landing site deploy are the other two nodes' runbooks
(`scripts/pretrained-catalogue/README.md`, `site/README.md`).

1. **Publish the models (pretrained-catalogue runbook first).** The frozen
   `data/pretrained-catalogue/bundled-models.json` entries must have their
   bytes as immutable release assets of `tinnlab/txresbench-models`: the
   staging step fetches each `url` before the build and aborts naming the
   entry on a missing host asset or a hash mismatch.
2. **Bump the version.** Change `version` in
   `src-app/desktop/tauri/tauri.conf.json` and `product.version` in
   `site/config.json` together (DEC-13) and commit on the repository's
   default branch. The writers and the landing-site build all refuse a
   partial move.
3. **One-time enablement.** Generate the updater keypair with
   `npx tauri signer generate`, commit the public key as
   `plugins.updater.pubkey` in `tauri.conf.json` (the empty pubkey in the
   tree is the disabled state: the app never dials the feed until a real key
   is committed), and store the private key + password as the GitHub secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Enable
   Actions in the repository (the workflow files are committed; nothing is
   scheduled until then) and set Pages → Source → GitHub Actions
   (`site/README.md` step 3).
4. **Run the pipeline.** Push the tag `app-v<semver>` (the workflow also
   accepts `workflow_dispatch` on the default branch while the version is
   already bumped). The workflow stages the models, builds the four artifacts
   with the signing key, uploads them to a draft release, then writes and
   commits `site/public/updates/latest.json` + the filled `downloads[]` rows
   on the default branch. Read the run's log before proceeding: the draft
   release lists every installer, and the commit message names the version.
5. **Deploy and verify (landing-site runbook).** The pages workflow triggers
   on the same tag, but the tag's tree predates the feed commit, so re-run
   the pages workflow on the default branch after step 4's commit lands (its
   dispatch path is the feeds-between-releases path). Publish the draft
   release the workflow created (its assets answer anonymous downloads only
   once it is published). Verify: the landing page shows the version and real
   sizes, `FEED` and `CATALOGUE` answer 200 with the committed bytes, and one
   installed copy checks for an update and reports the current version.

## Failure modes

- **Missing `.sig` files** (no `TAURI_SIGNING_PRIVATE_KEY` secret, or a build
  without it): discovery stops naming the artifact; nothing is written to
  either output — the only way the pipeline's publish steps succeed is with
  real signatures.
- **Version drift** (tag, artifact names, manifest, config disagree): the
  step names both values and exits 1; the tauri manifest is the single source
  of truth.
- **Staging mismatch** (model host asset absent, wrong size or sha256): the
  staging step aborts naming the entry before any byte is staged into the
  bundle.

## Facts worth knowing

- The bundled-model directory is gitignored (model bytes are never committed
  to the app repo, INV-2); the tracked `.gitkeep` keeps the directory present
  for `tauri-build`'s compile-time resource check on a fresh checkout.
- `--check` parity and the desktop provision module re-verify the staged set
  before it is usable, so a corrupted bundle is named at build time and again
  at first run (PROV-PC-12's belt over this strap).
- The writers take an optional `--tauri-conf <path>` seam (default: the
  shipped manifest) so the fixture rehearsal can bind a fixture manifest; the
  production default stays fail-closed.
