import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Alert, Button, Checkbox, Confirm, Input, InputNumber } from '@ziee/kit'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ziee/kit/shadcn/command'
import { Field, FieldContent, FieldGroup, FieldLabel } from '@ziee/kit/shadcn/field'
import {
  getActionMeta,
  getActionRegistry,
  runAction,
} from '@/core/actions/defineAction'
import {
  isContextActive,
  useActiveContextSnapshot,
} from '@/core/actions/activeContext'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import { actionSearchTerms } from '@/core/actions/search'
import { hasPermissionNow, type Permission } from '@/core/permissions'
import { gatePaletteActions, type GatedAction } from './paletteGating'
// `authStoreProxy` isn't re-exported by `@/core/permissions` (it's a
// framework-internal seam, see `.claude/PERMISSION_GATING.md`) — imported
// directly from the SDK here purely as a REACTIVE change signal (a proxy
// field read during render subscribes) so the permission-filtered list
// below also recomputes the instant a live permission change lands, not
// only at the next palette-open transition.
import { authStoreProxy } from '@ziee/framework/permissions'
import { closeCommandPalette, useCommandPaletteOpen } from './paletteState'
import { defaultParamValue, paramSchemaToFields, type ParamField } from './paramForm'

// PLAN.md ITEM-1 — the human half of the shared action vocabulary: ⌘/Ctrl-K
// lists every registered `defineAction` the current user holds the
// permission for (`hasPermissionNow`, DEC-2 — no new permission, each action
// is filtered by its OWN declared permission), fuzzy-searchable by title/id,
// grouped by a category derived from the action id's `<category>.<verb>`
// prefix (`project.*` → "Projects", `nav.*` → "Settings", …). Selecting a
// no-param action runs it immediately; a param-bearing action shows a
// minimal scalar-only inline form (ITEM-14 descopes complex/nested schemas)
// before calling the SAME `runAction(id, params)` the AI agent engine calls
// (`@/core/actions/engine.ts`) — one execution path, two callers.

const CATEGORY_LABELS: Record<string, string> = {
  app: 'App',
  project: 'Projects',
  job: 'Jobs',
  nav: 'Settings',
}

function categoryFor(id: string): string {
  const prefix = id.split('.')[0] ?? ''
  if (CATEGORY_LABELS[prefix]) return CATEGORY_LABELS[prefix]
  return prefix ? prefix[0].toUpperCase() + prefix.slice(1) : 'General'
}

interface ActionGroup {
  key: string
  label: string
  actions: GatedAction[]
}

interface PermittedActions {
  groups: ActionGroup[]
  /** action id -> its gated form, so a selected instance action can recover
   *  the resolved `view_id` the palette must auto-supply. */
  byId: Map<string, GatedAction>
}

/** Every registered action the current user may invoke HERE, gated by
 *  `paletteGating` (surface + context + permission), grouped by category and
 *  sorted for a stable render (group label, then action title). */
function usePermittedActionGroups(open: boolean): PermittedActions {
  // Reactive read (a store-proxy field access during RENDER subscribes —
  // never read this conditionally or inside the `useMemo` callback below,
  // where it would just be a one-time snapshot). Included in the memo deps
  // so the list recomputes on a live permission change, not only at the
  // next open transition.
  const { permissions } = authStoreProxy()
  // Reactive read of the active-context registry (PLAN.md ITEM-2/3), so the
  // context-gated list recomputes the instant a page declares/clears its
  // context (`useActiveContext`), not only at the next open transition.
  const contextSnapshot = useActiveContextSnapshot()

  return useMemo(() => {
    const gated = gatePaletteActions(
      Array.from(getActionRegistry().values()).map(entry => entry.meta),
      {
        isContextActive,
        hasPermission: perm => hasPermissionNow(perm as Permission),
        // A `kind:'instance'` action is offered against the active FOCUSED
        // instance of its context — the first live instance registered under
        // that context name via `useAction` (the context name doubles as the
        // instance `type`). With no such instance registered (e.g. before the
        // W2 workbench dock exists) the action is not offerable and is
        // excluded — the pre-ITEM-3 behavior of dropping every instance
        // action generalizes to "offer it only where its instance is live".
        activeInstanceId: context => instancesOfType(context)[0]?.id,
      },
    )

    const byId = new Map<string, GatedAction>()
    const byCategory = new Map<string, GatedAction[]>()
    for (const g of gated) {
      byId.set(g.meta.id, g)
      const label = g.meta.group ?? categoryFor(g.meta.id)
      const bucket = byCategory.get(label)
      if (bucket) bucket.push(g)
      else byCategory.set(label, [g])
    }

    const groups = Array.from(byCategory.entries())
      .map(([label, actions]) => ({
        key: label,
        label,
        actions: actions.sort((a, b) => a.meta.title.localeCompare(b.meta.title)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return { groups, byId }
    // Recomputed each time the palette opens (`open` flips), the user's live
    // permission set changes (`permissions`), OR the active-context registry
    // changes (`contextSnapshot`) — the registry itself is populated once at
    // module load (stable) and never needs to be a dep.
  }, [open, permissions, contextSnapshot])
}

type ParamValue = string | number | boolean | undefined

function ParamFieldInput({
  field,
  value,
  onChange,
}: {
  field: ParamField
  value: ParamValue
  onChange: (next: ParamValue) => void
}) {
  const inputId = `command-palette-param-${field.name}`
  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
        </FieldContent>
        <Checkbox
          id={inputId}
          data-testid={inputId}
          checked={value === true}
          onCheckedChange={checked => onChange(checked)}
        />
      </Field>
    )
  }
  if (field.type === 'number') {
    return (
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor={inputId}>
            {field.label}
            {field.required ? ' *' : ''}
          </FieldLabel>
        </FieldContent>
        <InputNumber
          id={inputId}
          data-testid={inputId}
          value={typeof value === 'number' ? value : undefined}
          onChange={next => onChange(next)}
        />
      </Field>
    )
  }
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor={inputId}>
          {field.label}
          {field.required ? ' *' : ''}
        </FieldLabel>
      </FieldContent>
      <Input
        id={inputId}
        data-testid={inputId}
        value={typeof value === 'string' ? value : ''}
        onChange={e => onChange(e.target.value)}
      />
    </Field>
  )
}

/** A run awaiting user confirmation (`meta.dangerous`) before it actually
 *  fires — set by `executeRun`, consumed by the trigger-less `Confirm`
 *  dialog rendered at the bottom of the component. */
interface PendingDangerousRun {
  id: string
  title: string
  params: Record<string, unknown>
}

export function CommandPalette() {
  const open = useCommandPaletteOpen()
  const { groups, byId } = usePermittedActionGroups(open)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, ParamValue>>({})
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [pendingDangerousRun, setPendingDangerousRun] = useState<PendingDangerousRun | null>(
    null,
  )

  // Reset all transient (selection / form / error / pending-confirm) state
  // whenever the dialog closes, so the next open always starts at the root
  // command list.
  useEffect(() => {
    if (!open) {
      setSelectedId(null)
      setFieldValues({})
      setRunning(false)
      setRunError(null)
      setPendingDangerousRun(null)
    }
  }, [open])

  const selectedFields = useMemo(() => {
    if (!selectedId) return []
    const entry = getActionRegistry().get(selectedId)
    if (!entry) return []
    const fields = paramSchemaToFields(entry.params)
    // For an instance action the palette auto-supplies `view_id` (the active
    // focused instance, resolved in `byId`), so it must never be a
    // user-facing form field.
    if (getActionMeta(selectedId)?.kind === 'instance') {
      return fields.filter(field => field.name !== 'view_id')
    }
    return fields
  }, [selectedId])

  /** Merge the auto-supplied `view_id` (for an instance action offered against
   *  the active focused instance) into the user-entered params. */
  const withResolvedTarget = (id: string, params: Record<string, unknown>): Record<string, unknown> => {
    const viewId = byId.get(id)?.viewId
    return viewId !== undefined ? { ...params, view_id: viewId } : params
  }

  const runWithParams = async (id: string, params: Record<string, unknown>) => {
    setRunning(true)
    setRunError(null)
    try {
      await runAction(id, withResolvedTarget(id, params))
      closeCommandPalette()
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Failed to run command')
      setRunning(false)
    }
  }

  /** The SINGLE entry point that actually fires an action from either the
   *  no-param list-select path or the param-form "Run" button. A
   *  `dangerous` action (`ActionMeta.dangerous` — e.g. `project.delete`)
   *  never runs immediately: it's parked in `pendingDangerousRun` and only
   *  actually invoked once the user explicitly confirms, mirroring
   *  `ProjectCard.tsx`'s required delete confirm dialog for the SAME
   *  underlying mutation. */
  const executeRun = (id: string, params: Record<string, unknown>) => {
    const meta = getActionMeta(id)
    if (meta?.dangerous) {
      setPendingDangerousRun({ id, title: meta.title, params })
      return
    }
    void runWithParams(id, params)
  }

  const handleSelect = (id: string) => {
    const entry = getActionRegistry().get(id)
    if (!entry) return
    let fields = paramSchemaToFields(entry.params)
    // Instance actions have their `view_id` auto-supplied (see `selectedFields`
    // / `withResolvedTarget`), so it never counts as a form field here — an
    // instance action whose ONLY param is `view_id` runs immediately.
    if (getActionMeta(id)?.kind === 'instance') {
      fields = fields.filter(field => field.name !== 'view_id')
    }
    if (fields.length === 0) {
      executeRun(id, {})
      return
    }
    setSelectedId(id)
    setRunError(null)
    setFieldValues(
      Object.fromEntries(fields.map(field => [field.name, defaultParamValue(field.type)])),
    )
  }

  const handleBack = () => {
    setSelectedId(null)
    setFieldValues({})
    setRunError(null)
  }

  const handleRunForm = () => {
    if (!selectedId) return
    executeRun(selectedId, fieldValues)
  }

  const selectedMeta = selectedId ? getActionMeta(selectedId) : undefined

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={next => {
          if (!next) closeCommandPalette()
        }}
        title="Command Palette"
        description="Search for a command to run…"
      >
        <Command shouldFilter={!selectedId}>
          {selectedMeta ? (
            <div className="flex flex-col gap-4 p-4" data-testid="command-palette-param-form">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  tooltip="Back to commands"
                  data-testid="command-palette-back"
                  onClick={handleBack}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="text-sm font-medium">{selectedMeta.title}</span>
              </div>
              {runError ? (
                <Alert
                  tone="error"
                  title="Couldn't run command"
                  description={runError}
                  data-testid="command-palette-run-error"
                />
              ) : null}
              <FieldGroup>
                {selectedFields.map(field => (
                  <ParamFieldInput
                    key={field.name}
                    field={field}
                    value={fieldValues[field.name]}
                    onChange={next => setFieldValues(prev => ({ ...prev, [field.name]: next }))}
                  />
                ))}
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={handleBack}
                  disabled={running}
                  data-testid="command-palette-cancel"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleRunForm}
                  loading={running}
                  data-testid="command-palette-run"
                >
                  Run
                </Button>
              </div>
            </div>
          ) : (
            <>
              <CommandInput placeholder="Type a command…" data-testid="command-palette-input" />
              <CommandList>
                <CommandEmpty>No matching commands.</CommandEmpty>
                {groups.map(group => (
                  <CommandGroup key={group.key} heading={group.label}>
                    {group.actions.map(({ meta }) => (
                      <CommandItem
                        key={meta.id}
                        value={`${meta.title} ${meta.id}`}
                        keywords={actionSearchTerms(meta)}
                        data-testid={`command-palette-item-${meta.id}`}
                        onSelect={() => handleSelect(meta.id)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{meta.title}</span>
                          {meta.description ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {meta.description}
                            </span>
                          ) : null}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </>
          )}
        </Command>
      </CommandDialog>
      {/* Destructive-action confirmation gate (`ActionMeta.dangerous`) —
          trigger-less, driven by `pendingDangerousRun`. Rendered as a
          SIBLING of `CommandDialog` (its own AlertDialog root/portal), so it
          stays interactive and visible even though the underlying palette
          dialog is a focus-trapped Radix root. Mirrors `ProjectCard.tsx`'s
          per-card delete confirm for the SAME `project.delete` mutation. */}
      {pendingDangerousRun ? (
        <Confirm
          open
          onOpenChange={next => {
            if (!next) setPendingDangerousRun(null)
          }}
          title={`Run "${pendingDangerousRun.title}"?`}
          description="This action is destructive and cannot be undone."
          danger
          okText="Run"
          cancelText="Cancel"
          data-testid="command-palette-dangerous-confirm"
          onConfirm={() => {
            const { id, params } = pendingDangerousRun
            setPendingDangerousRun(null)
            void runWithParams(id, params)
          }}
        />
      ) : null}
    </>
  )
}
