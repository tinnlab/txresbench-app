import { Alert, Button, RadioGroup, Sheet, message } from '@txresbench/kit'
import { ProvenanceExport } from '@/modules/provenance/stores/ProvenanceExport.store'
import type { ExportScope } from '@/modules/provenance/types'

const SCOPE_OPTIONS = [
  { label: 'This run and its lineage', value: 'run' as ExportScope },
  { label: 'The whole project', value: 'project' as ExportScope },
]

/**
 * The reproducibility-bundle export drawer (ITEM-16). Pick a scope (this run /
 * whole project), Build → the bundle is assembled server-side and downloaded as a
 * zip. The Build button reflects its phase (building → ready) rather than a
 * silent spinner; a failure surfaces inline.
 */
export function ExportDrawer() {
  const { open, scope, target, phase, error } = ProvenanceExport
  const building = phase === 'building'

  const onBuild = async () => {
    const ok = await ProvenanceExport.build()
    if (ok) message.success('Export bundle downloaded')
    else message.error(ProvenanceExport.$.error ?? 'Failed to build export')
  }

  const buildLabel =
    phase === 'building' ? 'Building…' : phase === 'ready' ? 'Download again' : 'Build & download'

  return (
    <Sheet
      open={open}
      onOpenChange={o => {
        if (!o) ProvenanceExport.close()
      }}
      title="Export reproducibility bundle"
      description="Assemble a zip with the code, environment, inputs, and run-stamps needed to reproduce this analysis."
      data-testid="provenance-export-drawer"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => ProvenanceExport.close()}
            data-testid="provenance-export-close"
          >
            Close
          </Button>
          <Button loading={building} onClick={onBuild} data-testid="provenance-export-build">
            {buildLabel}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          options={SCOPE_OPTIONS.map(o => ({
            ...o,
            disabled: o.value === 'run' && !target,
          }))}
          value={scope}
          onValueChange={v => ProvenanceExport.setScope(v as ExportScope)}
          aria-label="Export scope"
          data-testid="provenance-export-scope"
        />

        {phase === 'ready' && (
          <Alert
            tone="success"
            title="Bundle ready"
            description="The export was built and your download has started."
            data-testid="provenance-export-ready"
          />
        )}
        {phase === 'error' && error && (
          <Alert
            tone="error"
            title="Export failed"
            description={error}
            data-testid="provenance-export-error"
          />
        )}
      </div>
    </Sheet>
  )
}
