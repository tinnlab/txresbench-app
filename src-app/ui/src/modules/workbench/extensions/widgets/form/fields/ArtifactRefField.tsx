import { useEffect, useState, type ReactNode } from 'react'
import { Button, Empty, MultiSelect, Select, Tag } from '@ziee/kit'
import {
  BINDING_ORIGIN_COPY,
  ORIGIN_AUTO,
  resolveOrThrow,
  type ArtifactRefField as ArtifactRefFieldT,
  type BindingOrigin,
  type TypeSelector,
} from '@/modules/workbench/core'
import {
  DATA_CAPABILITY_ID,
  DATA_CAPABILITY_RANGE,
  type ArtifactRow,
  type DataApi,
} from '@/modules/workbench/extensions/data'
import { useWorkbench } from '@/modules/workbench/core/shell/WorkbenchContext'
import { FieldFrame } from './FieldFrame'
import {
  formatArtifactOption,
  formatArtifactOptionWithDataset,
  groupRowsByDataset,
  shouldGroupByDataset,
} from './artifactLabel'

/** The human name of the accepted datatype (for the empty-state copy). */
function acceptedTypeName(sel: TypeSelector): string {
  return sel.type_id ?? sel.subtypes_of ?? 'artifact'
}

/** Open the workbench Launcher pane. The launcher control lives in the shell (out of
 *  this field's module), so we reuse its stable, e2e-contract testid rather than
 *  reaching across modules — a graceful no-op if the shell isn't mounted. */
function openLauncher(): void {
  document.querySelector<HTMLElement>('[data-testid="workbench-launcher-open"]')?.click()
}

/**
 * Tier-2 — an artifact-ref input. Populates a type-filtered picker from the project
 * catalog (the `data` capability's `artifacts.query(accepts)`, already subtype-filtered) so a
 * user PICKS a compatible artifact rather than typing an id. Single → `Select`
 * (id string); `multiple` → `MultiSelect` (id string[]). Never crashes the form: a
 * rejected query surfaces a retryable ERROR state — distinct from a genuinely empty
 * catalog (which shows the Import CTA), so a transient failure isn't mistaken for
 * "nothing exists to pick".
 *
 * ITEM-35 — option labels are ENRICHED (`datatype · shape · relative-date`), and the
 * empty case shows a CTA (import a dataset / browse analyses) instead of a dead
 * "No compatible artifacts". ITEM-37 — `accepts` may be a resolver over the current
 * form `values`; the picker re-resolves + clears a selection that no longer matches.
 */
export function ArtifactRefField({
  field,
  value,
  values,
  onChange,
  origin,
}: {
  field: ArtifactRefFieldT
  value: unknown
  /** the whole params record — read only to resolve a dependent `acceptsResolver`. */
  values: Record<string, unknown>
  onChange: (v: unknown) => void
  /** ITEM-15 — how the current value was CHOSEN, when the host tracks it. Absent means
   *  unknown, and unknown renders exactly as this control rendered before (INV-4). */
  origin?: BindingOrigin
}) {
  const { api, lattice } = useWorkbench()
  const [rows, setRows] = useState<ArtifactRow[]>([])
  const [loading, setLoading] = useState(true)

  const resolver = field.acceptsResolver
  // A dependent field re-resolves when ANY sibling value changes; a static one only
  // when its declared `accepts` changes.
  const depKey = resolver ? JSON.stringify(values) : JSON.stringify(field.accepts)

  useEffect(() => {
    let cancelled = false
    const clearStale = (fetched: ArtifactRow[]) => {
      // Only a DEPENDENT ref clears a now-invalid selection (back-compat: a static ref
      // never auto-clears). Filter multi; drop single.
      const ids = new Set(fetched.map(r => r.id))
      if (field.multiple) {
        const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
        const kept = arr.filter(id => ids.has(id))
        if (kept.length !== arr.length) onChange(kept)
      } else if (typeof value === 'string' && value && !ids.has(value)) {
        onChange(undefined)
      }
    }
    const run = () => {
      setLoading(true)
      Promise.resolve(resolver ? resolver(values) : field.accepts)
        .then(sel => {
          const data = resolveOrThrow<DataApi>(api.capabilities, DATA_CAPABILITY_ID, DATA_CAPABILITY_RANGE)
          return data.artifacts.query(sel).then(fetched => ({ sel, fetched }))
        })
        .then(({ sel, fetched }) => {
          if (cancelled) return
          // ITEM-19: the backend query filters by `subtypes_of` but NOT `excludes`, so enforce the
          // exclude client-side — a normalized matrix (a subtype of the accepted expression parent)
          // is never OFFERED in the picker. `excludes` rides on the (resolved) TypeSelector.
          const excludes =
            (sel && typeof sel === 'object' ? (sel as { excludes?: string[] }).excludes : undefined) ?? []
          const shown = excludes.length
            ? fetched.filter(r => !excludes.some(e => lattice.isA(r.datatype, e)))
            : fetched
          setRows(shown)
          setLoading(false)
          if (resolver) clearStale(shown)
        })
        .catch(() => {
          if (!cancelled) {
            setRows([])
            setLoading(false)
          }
        })
    }
    // Debounce + cancel-stale on the dependent path (values change rapidly while typing).
    if (resolver) {
      const timer = setTimeout(run, 200)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // `values`/`accepts` captured via depKey; `value`/`onChange` read fresh each run
    // (depKey re-runs cover a value change since value ∈ values).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, depKey])

  // ITEM-22 — group/label candidates by their DERIVED source dataset when that adds
  // signal (≥1 candidate carries a source dataset). The single `Select` uses grouped
  // options (a `SelectOptionGroup` per dataset, labelled by dataset name); the flat
  // `MultiSelect` (no group affordance) prefixes each label with its dataset name.
  const grouped = shouldGroupByDataset(rows)
  const options = grouped
    ? groupRowsByDataset(rows).map(g => ({
        label: g.label,
        options: g.rows.map(r => ({ label: formatArtifactOption(r), value: r.id })),
      }))
    : rows.map(r => ({ label: formatArtifactOption(r), value: r.id }))
  const multiOptions = rows.map(r => ({
    label: grouped ? formatArtifactOptionWithDataset(r) : formatArtifactOption(r),
    value: r.id,
  }))
  const empty = !loading && rows.length === 0
  // ITEM-15 / INV-2 — an AUTO-bound value is never rendered as a chosen one. The mark is
  // rendered as ordinary flow content beside the control, so it is on screen without a
  // hover, a focus or a `title=`; and the wrapper carries `data-binding-origin` so the
  // fact is readable off the DOM by anything downstream (the run panel's e2e, a gallery
  // state) rather than only by a human reading the sentence.
  //
  // The attribute sits on the WRAPPER rather than on the `Select`/`MultiSelect` itself
  // because the kit controls do not forward unknown props to their trigger element — an
  // attribute passed to them would type-check and then never reach the DOM, which is the
  // worst of the three outcomes.
  const markAuto = origin === ORIGIN_AUTO
  const controlId = `schemaform-ctl-${field.id}`
  const testid = `schemaform-field-${field.id}`
  const name = field.title ?? field.id
  const typeName = acceptedTypeName(field.accepts)

  // ITEM-35 — a first-class empty state with a way FORWARD, not a disabled dead control.
  if (empty) {
    return (
      <FieldFrame field={field} htmlFor={controlId}>
        <Empty
          data-testid={`${testid}-empty`}
          title={`No compatible ${typeName}`}
          description={`Import a dataset or run an analysis that produces ${typeName}.`}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button href="/datasets" variant="default" data-testid={`${testid}-import`}>
              Import a dataset
            </Button>
            <Button variant="outline" onClick={openLauncher} data-testid={`${testid}-launch`}>
              Browse analyses
            </Button>
          </div>
        </Empty>
      </FieldFrame>
    )
  }

  if (field.multiple) {
    const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
    return (
      <FieldFrame field={field} htmlFor={controlId}>
        <OriginMark auto={markAuto} testid={testid}>
        <MultiSelect
          id={controlId}
          options={multiOptions}
          value={arr}
          onChange={v => onChange(v)}
          loading={loading}
          placeholder="Select artifacts…"
          searchPlaceholder="Search artifacts…"
          emptyText={`No compatible ${typeName}`}
          removeLabel={l => `Remove ${l}`}
          aria-label={name}
          data-testid={testid}
        />
        </OriginMark>
      </FieldFrame>
    )
  }

  return (
    <FieldFrame field={field} htmlFor={controlId}>
      <OriginMark auto={markAuto} testid={testid}>
      <Select
        id={controlId}
        options={options}
        value={typeof value === 'string' ? value : undefined}
        onChange={v => onChange(v)}
        loading={loading}
        placeholder={loading ? 'Loading…' : 'Select an artifact…'}
        allowClear
        clearLabel="Clear selection"
        data-testid={testid}
      />
      </OriginMark>
    </FieldFrame>
  )
}

/**
 * The ORIGIN mark around a bound control (ITEM-15 / INV-2).
 *
 * A control whose origin is unknown, or which the user chose, renders EXACTLY what it
 * rendered before this existed — the wrapper is not applied at all, so a form given no
 * `origins` is unchanged down to its DOM shape. Only an auto-bound control gains the
 * marked wrapper.
 */
function OriginMark({
  auto,
  testid,
  children,
}: {
  auto: boolean
  testid: string
  children: ReactNode
}) {
  if (!auto) return <>{children}</>
  return (
    <div className="flex flex-col gap-1.5" data-binding-origin="auto" data-testid={`${testid}-origin`}>
      {children}
      <Tag tone="warning" variant="soft" data-testid={`${testid}-origin-mark`}>
        {BINDING_ORIGIN_COPY.autoBound}
      </Tag>
    </div>
  )
}
