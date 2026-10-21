// Generic, DOMAIN-FREE module actions the draftable editor + frozen views invoke via
// `call_action` (draftable-entity / geneset ITEM-8d + ITEM-10). They carry NO domain noun: a
// package's declarative view supplies the domain field names (the item/value keys) as params, so
// these are reusable by ANY draftable editor. Registered at import (the `defineAction`
// side-effect); the module is pulled in on the workbench render path via `Drafts.store`.
//
//   • `draft.parseInto`    — parse pasted / GMT text into a target `$state` array field.
//   • `draft.freeze`       — freeze the draft bound to the invoking view (`view_id`).
//   • `draft.exportGmt`    — serialize a FROZEN collection artifact's per-set structure to a `.gmt`.
//   • `draft.launchEditor` — CREATE a fresh draft of the given `kind` and LAUNCH the editor pane
//                            bound to THAT draft (the New-collection entry point).
//   • `draft.editFork`     — CREATE a fork draft SEEDED from a frozen artifact's structure and
//                            launch the editor bound to it (Edit → new version; INV-6).

import { z } from 'zod'
import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '@/core/actions/defineAction'
import type { ActionContext } from '@/core/actions/ctx'
import type { InterpreterCtx } from '@/modules/workbench/core/runtime/interpreter'
import { getViewStore } from '@/modules/workbench/core/runtime/viewStores'
import { parseFlexible, parseGmt, type ParsedRecord } from '@/modules/workbench/core/runtime/gmtParse'
import { serializeGmt, type SerializableRecord } from '@/modules/workbench/core/runtime/gmtSerialize'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { revealPane } from '@/modules/workbench/core/shell/regions/openPane'
// The canonical declarative-store disposal (the pane-close counterpart to `retain`). A re-launch
// must TEAR DOWN the prior editor's cached store, not just remove+re-add its pane: the mount is
// keyed by the (stable) view id, and `release()` deliberately never disposes on a region unmount,
// so a synchronous removePane→revealPane leaves the OLD store live and the re-mounted editor
// reuses its stale `$state` (round-2 HIGH: a SECOND launch after freezing the first draft showed
// the prior draft's field values). Disposing here forces `retain` to recreate the store seeded
// from the NEW draft binding.
import { destroy as destroyDeclarativeMount } from '@/modules/workbench/core/render/declarativeMount'
import { Drafts } from './Drafts.store'
// Import the live-session registry accessors from the CALL-FREE `draftRegistry` module, NOT from
// `draftBinding` — importing the resolver back would re-close the import cycle `importCycles.test`
// forbids (this module runs `defineAction(...)` at top level, so it must not sit on any cycle).
import { getDraftInstance, setDraftLaunchIntent, unbindDraftInstance } from './draftRegistry'

/** A toast, when the invoking ctx wired one (the workbench interpreter ctx does); a no-op
 *  in a bare test ctx. Kept off the typed `ActionContext` surface to avoid a hard dep. */
function notify(ctx: ActionContext, msg: { success?: string; error?: string } | string): void {
  const toast = (ctx as { toast?: (m: unknown) => void }).toast
  if (typeof toast === 'function') toast(msg)
  else ctx.log?.(typeof msg === 'string' ? msg : (msg.success ?? msg.error ?? ''))
}

/** The project the workbench is bound to, surfaced on the interpreter ctx (`hostCtx.ts`). A
 *  launcher needs it to create the project-scoped draft. */
function ctxProjectId(ctx: ActionContext): string | undefined {
  return (ctx as InterpreterCtx).projectId
}

/**
 * Launch (or RE-launch) the declarative editor pane for `analysisId`, bound to `draftId`.
 * The intent is threaded to `resolveDraftBinding` BEFORE the pane mounts, so a freshly-opened
 * editor binds to exactly this draft. If an editor pane for this analysis is already open it is
 * removed first, so the pane re-mounts and consumes the new intent (a New-collection / Edit-fork
 * must open the NEW draft, not silently focus a stale one). `viewId === analysisId` for a `ui:`
 * analysis editor.
 *
 * The PRIOR instance bound to this view is UNBOUND before the new intent is set (round-2 HIGH):
 * `resolveDraftBinding` now checks the launch intent before the bound instance, but unbinding is
 * the second belt — it guarantees a re-launch can never resume the previously-open draft even if
 * the intent were somehow lost, so the NEW/fork draft always wins.
 */
function launchEditorBoundTo(analysisId: string, draftId: string): void {
  unbindDraftInstance(analysisId)
  setDraftLaunchIntent(analysisId, draftId)
  const dock = workbenchDockStore.getState()
  const openPaneId = dock.paneIdForRef('view', analysisId)
  if (openPaneId) dock.removePane(openPaneId)
  // Dispose the prior editor's declarative store BEFORE re-revealing. `retain` is keyed by the
  // (stable) view id and `release()` never disposes on a region unmount, so without this the
  // re-mounted editor would `retain` the SAME cached store — still seeded with the previous
  // draft's `$state` — and the new launch intent would never re-seed it (round-2 HIGH regression:
  // a second launch after freezing the first draft re-showed the prior draft's field values).
  // `destroy(analysisId)` tears down every mount this analysis owns, so the reveal below
  // recreates the store fresh from the new draft binding.
  destroyDeclarativeMount(analysisId)
  revealPane('view', analysisId)
}

/** Map one parsed record onto the view's item shape: `{ [nameField]: name, [valuesField]:
 *  values, [descriptionField]?: description, ...defaults }`. */
function toItem(
  rec: ParsedRecord,
  opts: {
    nameField: string
    valuesField: string
    descriptionField?: string
    defaults?: Record<string, unknown>
  },
): Record<string, unknown> {
  const item: Record<string, unknown> = { ...(opts.defaults ?? {}) }
  item[opts.nameField] = rec.name
  item[opts.valuesField] = rec.values
  if (opts.descriptionField) item[opts.descriptionField] = rec.description
  return item
}

defineAction({
  id: 'draft.parseInto',
  title: 'Parse text into a list field',
  permission: Permissions.DraftsUse,
  mutating: true,
  params: z
    .object({
      view_id: z.string(),
      /** The raw text to parse (the view passes `"$state.pasteText"` etc.). */
      text: z.string().optional(),
      /** `gmt` (tab-delimited name/description/values) or `flexible` (name then values). */
      format: z.enum(['gmt', 'flexible']).optional(),
      /** The `$state` array field to write (e.g. `sets`). */
      target: z.string(),
      /** The item field the parsed VALUES array goes into (the domain field name rides here). */
      values_field: z.string(),
      /** The item field the record NAME goes into (default `name`). */
      name_field: z.string().optional(),
      /** The item field the record DESCRIPTION goes into (omitted → not written). */
      description_field: z.string().optional(),
      /** Extra fields merged into every produced item (e.g. `{kind, origin}`). */
      defaults: z.record(z.string(), z.unknown()).optional(),
      /** Append to the existing array (default) or replace it. */
      append: z.boolean().optional(),
    })
    .passthrough(),
  run: (p, _ctx) => {
    const store = getViewStore(p.view_id)
    if (!store) return
    const records = p.format === 'gmt' ? parseGmt(p.text ?? '') : parseFlexible(p.text ?? '')
    const items = records.map(rec =>
      toItem(rec, {
        nameField: p.name_field ?? 'name',
        valuesField: p.values_field,
        descriptionField: p.description_field,
        defaults: p.defaults,
      }),
    )
    const append = p.append !== false
    const current = (store.state as Record<string, unknown>)[p.target]
    const existing = append && Array.isArray(current) ? (current as unknown[]) : []
    store.set(p.target, [...existing, ...items])
  },
})

defineAction({
  id: 'draft.freeze',
  title: 'Freeze the draft',
  permission: Permissions.DraftsUse,
  mutating: true,
  params: z.object({ view_id: z.string() }).passthrough(),
  run: async (p, ctx) => {
    const inst = getDraftInstance(p.view_id)
    if (!inst) {
      notify(ctx, { error: 'No draft is bound to this editor yet — nothing to freeze.' })
      return
    }
    try {
      const resp = await Drafts.freeze(inst.draftId)
      notify(ctx, { success: 'Freezing collection — the frozen version will appear shortly.' })
      return resp
    } catch (e) {
      notify(ctx, { error: e instanceof Error ? e.message : 'Failed to freeze the draft.' })
    }
  },
})

defineAction({
  id: 'draft.launchEditor',
  title: 'New draft — open the editor',
  permission: Permissions.DraftsUse,
  mutating: true,
  params: z
    .object({
      /** The opaque draft `kind` (rides from the package view; the freeze producer is
       *  resolved from it server-side). */
      kind: z.string(),
      /** The `ui:` analysis id whose editor pane to launch (its view id). */
      analysis: z.string(),
      /** Explicit project (defaults to the interpreter ctx's `projectId`). */
      project_id: z.string().optional(),
      /** Initial `data` for the fresh draft (default `{}`). */
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  run: async (p, ctx) => {
    const projectId = p.project_id ?? ctxProjectId(ctx)
    if (!projectId) {
      notify(ctx, { error: 'No project is bound — cannot start a new collection.' })
      return
    }
    try {
      const draft = await Drafts.create({ kind: p.kind, project_id: projectId, data: p.data ?? {} })
      launchEditorBoundTo(p.analysis, draft.id)
      return { draft_id: draft.id }
    } catch (e) {
      notify(ctx, { error: e instanceof Error ? e.message : 'Failed to start a new collection.' })
    }
  },
})

/** The structural read of a frozen artifact's per-set records — DOMAIN-FREE: the value +
 *  meta field names ride as params; a record is copied VERBATIM into the fork's draft `data`
 *  (any extra producer-derived keys are harmless — the freeze producer re-derives them), so
 *  this seeds the editor with the frozen collection's CURRENT content. */
defineAction({
  id: 'draft.editFork',
  title: 'Edit → new version',
  permission: Permissions.DraftsUse,
  mutating: true,
  params: z
    .object({
      /** The frozen artifact to fork FROM (unset until a collection is selected). */
      artifact_id: z.string().nullish(),
      /** The opaque draft `kind` for the fork. */
      kind: z.string(),
      /** The `ui:` analysis id whose editor pane to launch. */
      analysis: z.string(),
      /** Explicit project (defaults to the interpreter ctx's `projectId`). */
      project_id: z.string().optional(),
      /** The structure key holding the per-set records (default `sets`). */
      sets_field: z.string().optional(),
      /** The `$state` array field the sets seed into (default = `sets_field`). */
      target: z.string().optional(),
      /** The structure key holding the collection name (default `collection`). */
      name_field: z.string().optional(),
      /** The `$state` field the collection name seeds into (default `name`). */
      name_target: z.string().optional(),
    })
    .passthrough(),
  run: async (p, ctx) => {
    const projectId = p.project_id ?? ctxProjectId(ctx)
    if (!projectId) {
      notify(ctx, { error: 'No project is bound — cannot fork a new version.' })
      return
    }
    if (!p.artifact_id) {
      notify(ctx, { error: 'Select a frozen collection to edit into a new version.' })
      return
    }
    try {
      const artifact = await ApiClient.Workstore.getArtifact({ id: p.artifact_id })
      const structure = (artifact.structure ?? {}) as Record<string, unknown>
      const setsField = p.sets_field ?? 'sets'
      const target = p.target ?? setsField
      const nameField = p.name_field ?? 'collection'
      const nameTarget = p.name_target ?? 'name'
      // Seed the fork's draft data from the frozen structure so the editor OPENS with the
      // current content (INV-6 edit-from-current-then-fork), not empty defaults. Verbatim
      // copy keeps this domain-free (the item field names live only in the frozen structure).
      const seed: Record<string, unknown> = {}
      const rawName = structure[nameField]
      if (typeof rawName === 'string' && rawName) seed[nameTarget] = rawName
      if (typeof structure.default_kind === 'string') seed.default_kind = structure.default_kind
      seed[target] = Array.isArray(structure[setsField]) ? structure[setsField] : []
      // Thread the source frozen artifact as the fork's parent (INV-7 / DEC-11): the new draft is
      // born pointing at this prior version, so its next freeze records parent = this artifact and
      // the lineage chain LINKS (v2←v1). Without this the fork's `frozen_artifact_id` is NULL and
      // the freeze hook stamps version=1/parent=NULL — the chain never links in-app.
      const draft = await Drafts.create({
        kind: p.kind,
        project_id: projectId,
        data: seed,
        parent_frozen_artifact_id: p.artifact_id,
      })
      launchEditorBoundTo(p.analysis, draft.id)
      return { draft_id: draft.id }
    } catch (e) {
      notify(ctx, { error: e instanceof Error ? e.message : 'Failed to fork a new version.' })
    }
  },
})

/** A per-set record read off a frozen artifact's `structure` — read STRUCTURALLY (only the
 *  generic `name`/`description` meta; the values field name rides as a param). */
interface FrozenSetMeta {
  name?: string
  description?: string
}

defineAction({
  id: 'draft.exportGmt',
  title: 'Export a frozen collection as GMT',
  permission: Permissions.DraftsUse,
  mutating: false,
  params: z
    .object({
      /** The frozen `geneset/collection` artifact to export. */
      artifact_id: z.string().optional(),
      /** Download filename stem (default `collection`). */
      filename: z.string().optional(),
      /** The structure key holding the per-set records (default `sets`). */
      sets_field: z.string().optional(),
      /** The record field holding each set's values (REQUIRED — the domain noun rides here). */
      values_field: z.string(),
    })
    .passthrough(),
  run: async (p, ctx) => {
    if (!p.artifact_id) {
      notify(ctx, { error: 'Select a frozen collection to export.' })
      return
    }
    try {
      const artifact = await ApiClient.Workstore.getArtifact({ id: p.artifact_id })
      const structure = (artifact.structure ?? {}) as Record<string, unknown>
      const setsField = p.sets_field ?? 'sets'
      const valuesField = p.values_field
      const rawSets = Array.isArray(structure[setsField]) ? (structure[setsField] as FrozenSetMeta[]) : []
      const records: SerializableRecord[] = rawSets.map(s => {
        const values = (s as Record<string, unknown>)[valuesField]
        return {
          name: String(s?.name ?? ''),
          description: s?.description ? String(s.description) : '',
          values: Array.isArray(values) ? values.map(String) : [],
        }
      })
      const gmt = serializeGmt(records)
      const stem =
        p.filename ??
        (typeof (structure.collection ?? '') === 'string' && structure.collection
          ? String(structure.collection)
          : 'collection')
      const blob = new Blob([gmt], { type: 'text/tab-separated-values' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${stem.replace(/[^\w.-]+/g, '_')}.gmt`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      notify(ctx, { success: 'Exported collection as GMT.' })
    } catch (e) {
      notify(ctx, { error: e instanceof Error ? e.message : 'Failed to export GMT.' })
    }
  },
})
