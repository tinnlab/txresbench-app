// TEST-541 (ITEM-25) — the reproducible METHODS paragraph the in-artifact lineage renders
// (`ArtifactLineage` → `ProvenanceView methodsText`). Each built-in analysis declares a pure
// `methodsText(params)` builder; a user reads (and cites) that sentence, so it must
// interpolate the ACTUAL run params — not a static blurb — and pick the right branch. The
// full inputs→run→outputs render is the env-gated e2e (ETEST-309); this covers the
// parameterized methods-text half that is pure + host-independent. Node runner, no React.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
// QC is now a DATA package (Slice 2): its `methodsText` is a DATA TEMPLATE STRING
// (INV-1 — no closure), synthesized into the `(p)=>string` builder by the loader.
import { processorAnalysisToContribution } from '@/modules/workbench/core/runtime/loadProcessors'

/** Load a processor package's Nth analysis contribution from its DATA `manifest.yaml`
 *  (the loader synthesizes the `methodsText` closure from the DATA template string). */
function loadAnalysis(pkg: string, extensionId: string, i = 0) {
  const m = parseYaml(
    readFileSync(fileURLToPath(new URL(`../../../../../../packages/${pkg}/manifest.yaml`, import.meta.url)), 'utf8'),
  ) as { contributes: { analyses: Array<Record<string, unknown>> } }
  return processorAnalysisToContribution(m.contributes.analyses[i] as never, extensionId)
}

const qc10x = loadAnalysis('qc', 'qc')
// Cellranger + import-h5ad are DATA packages now too (Slice 5, ITEM-22): their `methodsText`
// is a DATA TEMPLATE STRING (INV-1 — no closure), re-homed from the deleted converter builtins.
const cellranger = loadAnalysis('cellranger', 'cellranger')
const importH5ad = loadAnalysis('import-h5ad', 'import-h5ad')
// Cell filter is a DATA package (Slice 4): its `methodsText` is now a DATA TEMPLATE STRING
// (INV-1 — no closure), a STABLE annotate-only sentence (a template can't count criteria / slug
// the label — that rich builder was app code; the label is slugged by the compute on Run).
const cfManifest = parseYaml(
  readFileSync(fileURLToPath(new URL('../../../../../../packages/cell-filter/manifest.yaml', import.meta.url)), 'utf8'),
) as { contributes: { analyses: Array<Record<string, unknown>> } }
const cellFilter = processorAnalysisToContribution(cfManifest.contributes.analyses[0] as never, 'cell-filter')

describe('analysis methodsText builders (TEST-541 / ITEM-25)', () => {
  it('qc is annotate-only: the DATA methodsText names the annotation, never a filter threshold', () => {
    // Slice-2 moved QC to a DATA package (INV-1/INV-6): `methodsText` is now a DATA
    // TEMPLATE STRING wrapped into a `(p)=>string` builder by the loader — a stable
    // annotate-only sentence (DEC-13). It no longer enumerates the selected metric set
    // in the app (that rich builder was app code; the metric list is user-driven DATA).
    const text = qc10x.methodsText?.({
      qc_metrics: [{ name: 'mito', pattern: '^MT-' }],
    } as never)
    expect(text).toContain('QC metrics')
    expect(text).toContain('the matrix was not modified')
    // annotate-only: never a filtering-threshold sentence.
    expect(text).not.toContain('adaptive')
    expect(text).not.toContain('MAD')

    // A param-less run still yields the same stable, non-empty sentence.
    const bare = qc10x.methodsText?.({} as never)
    expect(bare).toContain('QC metrics')
    expect(bare).toContain('the matrix was not modified')
  })

  it('cell-filter records a keep-mask (annotate-only); cellranger interpolates its params', () => {
    // Slice-4: cell-filter is a DATA package — `methodsText` is now a STABLE annotate-only
    // TEMPLATE STRING (INV-1/INV-6): it names the keep-mask + "the matrix was not modified",
    // never a filtered matrix. It no longer enumerates the criteria count (that rich builder was
    // app code; the label IS the committed column's name, verbatim, since 0.9.0).
    const text = cellFilter.methodsText?.({
      label: 'strict',
      criteria: [{ column: 'pct_mito' }, { column: 'n_genes' }],
    } as never)
    expect(text).toContain('keep-mask')
    expect(text).toContain('the matrix was not modified')
    // annotate-only: never a filtered-matrix / subset sentence.
    expect(text).not.toContain('filtered')
    expect(text).not.toContain('subset')
    // A param-less run still yields the same stable, non-empty sentence.
    expect(cellFilter.methodsText?.({} as never)).toContain('keep-mask')
    expect(cellranger.methodsText?.({ reference: 'GRCh38', chemistry: 'SC3Pv3' } as never)).toBe(
      'Aligned 10x FASTQs with Cell Ranger count against GRCh38 (chemistry SC3Pv3).',
    )
  })

  it('a param-less importer still yields a stable, non-empty methods sentence', () => {
    const t = importH5ad.methodsText?.({ input: 'x' } as never)
    expect(t).toBeTruthy()
    expect(t).toContain('read_h5ad')
  })
})
