# installer fixtures — synthetic build-time test data

`bundle-pretrained-models.test.mjs` and `lib/artifacts.test.mjs` run against
this tree; no fixture here is real data.

- `bundled-models.json` — a frozen `bundled-models.json`-shaped manifest
  (schema_version 1, `models[{id, version, file, url, sha256, size_bytes}]`).
  The two entries mirror the naming contract PROV-PC-12 pins: `file` =
  `<id>@<version>.txr`, `url` on the model host
  (`github.com/tinnlab/txresbench-models/...`).
- `assets/<id>@<version>.txr` — the staged bytes for those entries. They are
  plain synthetic strings (declared in the bytes themselves), never model
  output: the installer scripts treat `.txr` content as opaque and verify only
  sha256 + size. The manifest's `sha256`/`size_bytes` are the values of the
  two files here (`sha256sum` / `wc -c`); regenerate the numbers the same way
  if these bytes ever change.
- `bundle/**` — a mini Tauri `target/release/bundle` tree in the canonical
  v2 shape (deb, AppImage, universal dmg + `.app.tar.gz`, NSIS `x64-setup.exe`,
  `.sig` siblings for the updater payloads). All contents are synthetic
  strings; the `.sig` files are non-empty so the feed writer's
  non-empty-signature rule can be exercised without a real minisign key.
- `tauri-app-conf-0.2.0.json` — a fixture of the app manifest's version
  fields (`version: 0.2.0`, the version the bundle fixture files carry).
  ITEM-5's writers check `--version` against
  `src-app/desktop/tauri/tauri.conf.json` (DEC-13: the manifest is the single
  version source of truth) and the repo's manifest says 0.1.0, so the
  fixture lets the release-pipeline tests bind the writers to a fixture
  manifest that matches the fixture bundle — the same `--tauri-conf` test
  seam `scripts/build-landing-site.mjs` uses (PROV-landing-site-4).
