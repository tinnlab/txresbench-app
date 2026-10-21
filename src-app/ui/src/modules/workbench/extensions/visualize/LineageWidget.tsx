// `lineage` (INV-7 / DEC-11) — the frozen-artifact VERSION-CHAIN readout.
//
// A DISPLAY widget (no value binding): given a bound frozen artifact id it walks that artifact's
// lineage chain (`GET /api/drafts/artifacts/{id}/lineage`, newest-first) and renders the version
// chain `v3←v2←v1` (current bold; every superseded version DIMMED, never hidden) plus the per-set
// `+A −B` membership delta between the current version and its immediate parent.
//
// DOMAIN-FREE: it speaks only "sets" and "members". The set/member field names ride in from the
// package view config (`values_field` is the domain noun, `sets_field`/`name_field` default to
// `sets`/`name`), so the widget carries no domain vocabulary — it is a registered VISUALIZE kind
// (through the open `registerWidget` seam), not a core form control, exactly like `entry_list`.

import * as React from 'react'
import { ApiClient } from '@/api-client'
import type { DraftLineageEntry } from '@/api-client/types'
import { cn } from '@/lib/utils'
import type { LineageWidget as LineageWidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { evalExpr } from '@/modules/workbench/core/runtime/expr'
import {
  computeMembershipDelta,
  isEmptyDelta,
  type MembershipDelta,
} from '@/modules/workbench/core/runtime/membershipDelta'
import type { WidgetRenderer } from '@/modules/workbench/core/render/registry'

/** What the effect resolves for a bound artifact: the version chain + the computed delta between
 *  the current version and its parent (`null` when there is no parent, i.e. a first version). */
interface Resolved {
  chain: DraftLineageEntry[]
  delta: MembershipDelta | null
}

const EMPTY: Resolved = { chain: [], delta: null }

function structureSets(structure: unknown, setsField: string): unknown {
  const s = structure && typeof structure === 'object' ? (structure as Record<string, unknown>) : {}
  return s[setsField]
}

export const LineageRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as LineageWidgetSpec
  const id = `widget-${(w as { id?: string }).id ?? 'lineage'}`
  const artifactId = String(evalExpr(w.artifact, ctx.scope) ?? '')
  const setsField = w.sets_field ?? 'sets'
  const valuesField = w.values_field
  const nameField = w.name_field ?? 'name'

  const [resolved, setResolved] = React.useState<Resolved>(EMPTY)
  const [loading, setLoading] = React.useState(false)

  // Fetch the chain when the bound artifact changes. Two artifact reads at most (the current
  // version + its parent) drive the delta; older versions contribute only their number to the
  // chain. `cancelled` guards a late resolve after the binding moved on.
  React.useEffect(() => {
    if (artifactId === '') {
      setResolved(EMPTY)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const { chain } = await ApiClient.Draft.lineage({ artifact_id: artifactId })
        if (cancelled) return
        let delta: MembershipDelta | null = null
        if (chain.length >= 2) {
          const [cur, parent] = [chain[0], chain[1]]
          const [curArt, parentArt] = await Promise.all([
            ApiClient.Workstore.getArtifact({ id: cur.artifact_id }),
            ApiClient.Workstore.getArtifact({ id: parent.artifact_id }),
          ])
          if (cancelled) return
          delta = computeMembershipDelta(
            structureSets(parentArt.structure, setsField),
            structureSets(curArt.structure, setsField),
            { nameField, valuesField },
          )
        }
        setResolved({ chain, delta })
      } catch {
        if (!cancelled) setResolved(EMPTY)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [artifactId, setsField, valuesField, nameField])

  const { chain, delta } = resolved

  // Nothing bound, or a single (unforked) version → no chain to show. `empty_text` (optional) is
  // the view's own sentence for the single-version case; absent ⇒ render nothing at all.
  if (artifactId === '' || chain.length === 0) return null

  const heading = w.label ? (
    <span className="text-xs font-medium text-muted-foreground">{w.label}</span>
  ) : null

  if (chain.length === 1) {
    return w.empty_text ? (
      <div data-testid={`${id}-field`} className="flex flex-col gap-1">
        {heading}
        <p data-testid={`${id}-single`} className="text-xs text-muted-foreground">
          {w.empty_text}
        </p>
      </div>
    ) : null
  }

  // The chain line: current (chain[0]) bold + foreground; every superseded version dimmed.
  const versionChain = (
    <div data-testid={`${id}-chain`} className="flex flex-wrap items-center gap-1 font-mono text-xs">
      {chain.map((entry, i) => (
        <React.Fragment key={entry.artifact_id}>
          {i > 0 ? <span aria-hidden className="text-muted-foreground">←</span> : null}
          <span
            data-testid={`${id}-v${entry.version}`}
            className={cn(
              i === 0 ? 'font-bold text-foreground' : 'text-muted-foreground opacity-70',
            )}
          >
            {`v${entry.version}`}
          </span>
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div data-testid={`${id}-field`} className="flex flex-col gap-1">
      {heading}
      <div id={id} data-testid={id} className="flex flex-col gap-1">
        {versionChain}
        {loading ? (
          <p data-testid={`${id}-loading`} className="text-xs text-muted-foreground">
            Loading version history…
          </p>
        ) : delta && !isEmptyDelta(delta) ? (
          <div data-testid={`${id}-delta`} className="flex flex-col gap-0.5 text-xs">
            {delta.changed.map(c => (
              <div key={c.name} data-testid={`${id}-delta-${c.name}`} className="flex flex-wrap items-center gap-1">
                <span className="text-muted-foreground">{c.name}:</span>
                {c.added.map(m => (
                  <span key={`+${m}`} className="font-medium text-success">{`+${m}`}</span>
                ))}
                {c.removed.map(m => (
                  <span key={`-${m}`} className="font-medium text-warning">{`−${m}`}</span>
                ))}
              </div>
            ))}
            {delta.addedSets.map(name => (
              <div key={`+set-${name}`} data-testid={`${id}-added-set-${name}`}>
                <span className="font-medium text-success">{`+ ${name}`}</span>
                <span className="ps-1 text-muted-foreground">(new set)</span>
              </div>
            ))}
            {delta.removedSets.map(name => (
              <div key={`-set-${name}`} data-testid={`${id}-removed-set-${name}`}>
                <span className="font-medium text-warning">{`− ${name}`}</span>
                <span className="ps-1 text-muted-foreground">(removed)</span>
              </div>
            ))}
          </div>
        ) : delta ? (
          <p data-testid={`${id}-nochange`} className="text-xs text-muted-foreground">
            No membership change from the previous version.
          </p>
        ) : null}
      </div>
    </div>
  )
}
