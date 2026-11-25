/**
 * The model module's route surface — the screen routes owned by `module.tsx`
 * and built here so sibling flow modules navigate by builder and never by
 * URL literal.
 *
 * Movement rules (the URL-as-view contract):
 *
 * - `chooseModelsPath(source?)` is the merged model step (round 2 — the ONE
 *   list of the predict path); `source` decorates the redirects from the old
 *   D/I addresses with the chip preset the old intent pinned.
 * - `modelsPath()` is screen J — the `/models` route `txrshell`'s scaffold
 *   used to own; the same string, now owned here (the shell's route block is
 *   removed on the same branch). `modelsPath(setId)` appends the `set` query
 *   param — J reads it via `useSearchParams` (DEC-19: the table restricts to
 *   that set's rows with a "Show all" affordance; screen K (`ui-history`)
 *   binds this convention for its "Made: N models" set links).
 *
 * The old D/I addresses (`/pretrained-models`, `/saved-models`) are not
 * flow steps any more (round 3); they survive as `module.tsx`'s redirect
 * routes to the merged list, whose paths `module.tsx` spells as its own
 * legacy constants.
 */
const MODELS_ROUTE = '/models'

/** The merged model step (predict-card merge round 2) — the one list of the
 *  predict path's model choice; `source` decorates the redirects from the
 *  old D/I routes with the chip preset the old intent pinned. */
export const chooseModelsPath = (source?: 'lab' | 'saved'): string =>
  source === undefined ? '/choose-models' : `/choose-models?source=${source}`

/** Screen J — your models (board `Models.dc.html`); the optional set id focuses the table. */
export const modelsPath = (setId?: string): string =>
  setId === undefined ? MODELS_ROUTE : `${MODELS_ROUTE}?set=${setId}`
