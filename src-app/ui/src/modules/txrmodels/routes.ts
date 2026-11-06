import { ROUTE_CONVENTIONS } from '../txrintake/module'

/**
 * The model module's route surface — the three screen routes owned by
 * `module.tsx` and built here so sibling flow modules navigate by builder
 * and never by URL literal.
 *
 * Movement rules (the URL-as-view contract):
 *
 * - `pretrainedModelsPath()` is screen D — the convention `txrintake` already
 *   declared (`ROUTE_CONVENTIONS.pretrainedModels`); this module registers it.
 * - `savedModelsPath()` is screen I — the convention `txrintake` already
 *   declared; this module registers it.
 * - `modelsPath()` is screen J — the `/models` route `txrshell`'s scaffold
 *   used to own; the same string, now owned here (the shell's route block is
 *   removed on the same branch). `modelsPath(setId)` appends the `set` query
 *   param — J reads it via `useSearchParams` (DEC-19: the table restricts to
 *   that set's rows with a "Show all" affordance; screen K (`ui-history`)
 *   binds this convention for its "Made: N models" set links).
 */
const MODELS_ROUTE = '/models'

/** Screen D — choose pretrained models (board `Pretrained.dc.html`). */
export const pretrainedModelsPath = (): string => ROUTE_CONVENTIONS.pretrainedModels

/** Screen I — choose saved models (board `Saved.dc.html`). */
export const savedModelsPath = (): string => ROUTE_CONVENTIONS.savedModels

/** Screen J — your models (board `Models.dc.html`); the optional set id focuses the table. */
export const modelsPath = (setId?: string): string =>
  setId === undefined ? MODELS_ROUTE : `${MODELS_ROUTE}?set=${setId}`
