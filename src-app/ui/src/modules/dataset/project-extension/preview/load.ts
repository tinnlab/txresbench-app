// Loading the DECLARED dataset previews out of the processor packages.
//
// Every phrase the picker's holdings line is made of comes from a package's own
// `dataset-preview.yaml`; the app registers nothing of its own. This module is the
// whole registration mechanism: find the files, read them through
// `readPreviewDeclaration`, and hand the result to the registry.
//
// ── Why a build-time glob, and what it costs ────────────────────────────────────
//
// The declarations are inlined by `import.meta.glob(..., { query: '?raw' })`, the
// same channel `loadProcessors.ts` uses for its baked leg — the picker renders on
// first paint, so a preview that arrived over the network would be a second, later
// line and a visible reflow for a row the user is already reading.
//
// The cost is stated rather than hidden: this is the BAKED leg only. A package
// dropped into a running deployment's processors directory contributes its analyses
// (the runtime leg refetches `GET /api/processors/packages`) but NOT its preview,
// because that endpoint serves `manifest.yaml` and `ui/*.yaml` and nothing else. A
// runtime leg needs `read_package_assets` to carry this file too; until then a
// dropped-in package degrades to the count-and-title fallback, which is the same
// thing every uncontributed datatype gets — see `summary.ts::fallbackPartText`.
//
// ── Why the file is NOT `manifest.yaml`, and NOT under `ui/` ────────────────────
//
// Both were tried on paper first. `manifest.yaml` cannot carry it: the manifest's
// datatype block is `deny_unknown_fields` in BOTH parsers (the runtime
// `DatatypeContribution` and the stricter `build_helper/processor_manifest.rs` mirror
// that `build.rs` panics on), so an added key fails the build rather than being
// ignored. `ui/*.yaml` cannot carry it either: every file there is required to parse
// as a declarative VIEW SPEC by the build gate, and a preview declaration is not one.
// A package-root file is inert to every existing consumer — the loader, the build
// lint and the assets route all read `manifest.yaml` by name.

import { parse as parseYaml } from 'yaml'
import { datasetPreviewRegistry, type DatasetPreviewRegistry } from './registry'
import { contributionOf, readPreviewDeclaration } from './declared'

/**
 * Every shipped declaration, keyed by module path. Six `../` reaches `src-app/`, so
 * this glob is the sibling of `loadProcessors.ts`'s manifest glob and matches the
 * same package set.
 */
export const DECLARED_PREVIEW_FILES = import.meta.glob(
  '../../../../../../packages/*/dataset-preview.yaml',
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>

/** The owning package's directory name — for a log line that names the file to fix. */
export function sourceLabelOf(modulePath: string): string {
  const parts = modulePath.split('/')
  const i = parts.lastIndexOf('packages')
  return i >= 0 ? parts.slice(i).join('/') : modulePath
}

/**
 * Register every valid declaration in `files` into `registry`, returning how many
 * datatypes gained a contribution.
 *
 * A file that fails to parse or fails validation contributes NOTHING and is reported
 * once — loudly, because a declaration that silently does not apply is
 * indistinguishable from a datatype nobody contributed for, and the whole point of
 * this seam is that those two look different to whoever wrote the file.
 */
export function registerDeclaredPreviews(
  files: Record<string, string>,
  registry: DatasetPreviewRegistry = datasetPreviewRegistry,
): number {
  let registered = 0
  for (const path of Object.keys(files).sort()) {
    const source = sourceLabelOf(path)
    let doc: unknown
    try {
      doc = parseYaml(files[path])
    } catch (err) {
      console.error(`[dataset preview] ${source} is not valid YAML; contributing nothing`, err)
      continue
    }
    const read = readPreviewDeclaration(doc)
    if (!read.ok) {
      console.error(
        `[dataset preview] ${source} is malformed; contributing nothing:\n  ${read.errors.join('\n  ')}`,
      )
      continue
    }
    for (const declared of read.previews) {
      registry.register(contributionOf(declared))
      registered += 1
    }
  }
  return registered
}

/** Registered at module evaluation, so the picker's first render already resolves
 *  them. Importing `./index` (which every consumer does) is what triggers this. */
registerDeclaredPreviews(DECLARED_PREVIEW_FILES)
