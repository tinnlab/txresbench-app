/**
 * The ready-made (lab) model flow's shared pieces (predict-card merge round
 * 3): the ONE copies of what screen D (`PretrainedModelsPage`, removed
 * round 3), screen I (`SavedModelsPage`, removed) and the merged list
 * (`ChooseModelsPage`) used to repeat — the D page's download/install
 * guarantee and the reuse-mode config every model step carries.
 *
 * - `cardRunnable` — can the card be run WITHOUT a live download? (The D
 *   page's rule: an entry commits a provider state once — `ready` =
 *   verified present; without an entry the card's own list state decides —
 *   installed / bundled / ready, a bundled or downloaded+verified asset is
 *   installed at Run time.)
 * - `installedModelId` — the one install path (PROV-PC-7): an already
 *   installed card yields its store uuid; a bundled/cached/downloaded asset
 *   is installed now (`status: "installed"` → the response's `model_id`); a
 *   `"installing"` response polls the download manager (PROV-PC-6) until
 *   the asset is `ready`, then re-installs; a `failed` verify throws with
 *   the provider's line. The download itself is never started HERE.
 * - `reuseConfig` — the reuse-mode config: the FIRST SELECTED model's own
 *   endpoint/horizon/decision day (the model steps have no settings
 *   controls — a model is run at the horizon and the decision day it was
 *   trained for, never at the intake's day; DEC-5's endpoint rule extended
 *   to the horizon and the decision day, data-pickup-bugs bug 3), and the
 *   engine-defaults the steps' bars carry (covariates off, detect CPUs,
 *   nothing saved, label day derived). The `unknown` bridge is the
 *   generated client's plain-optional `cpus` / `label_day` (the
 *   toRunConfig class — the wire bytes are the engine's).
 * - `getLiveSelection` — the live selection read FRESH at invoke time (the
 *   shared hook's `getSelection` — the action's selection is never a
 *   render-time snapshot; the stale-state token is the real check). Uses no
 *   component state, so it lives at module scope: ONE function identity,
 *   never a per-render arrow.
 * - `StripEntry` / `DOWNLOAD_STRIP` / the gate lines — the downloads strip
 *   one `TxrDownloadState` per live/failed download (bytes + percent +
 *   spinner + error + Retry — the environment-download idiom, never a
 *   silent boolean), composed at host level, and the two inline gate lines
 *   a Run click refuses while a selected card is downloading or failed.
 */
import type { CSSProperties } from 'react'
import { ApiClient } from '@/api-client'
import type { PretrainedSummary, RunConfig } from '@/api-client/types'
import { useDownloadState } from '../data/useDownloadState'
import { TxrDownloadState } from '../components/TxrDownloadState'
import { DOWNLOAD_POLL_MS, useTxrModelsStore } from '../stores/TxrModels.store'

/** The downloads strip's card (the host chrome between list and footnote). */
export const DOWNLOAD_STRIP: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 18px',
  alignItems: 'center',
  padding: '10px 14px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
}

/** The gate line for a still-downloading selected card. */
export const GATE_DOWNLOADING_LINE =
  'A selected model is still downloading. Wait for it to finish, or uncheck it.'

/** The gate line for a failed selected card's download. */
export const GATE_FAILED_LINE = "A selected model's download failed. Retry it, or uncheck it."

/** Can the card be run WITHOUT a live download? An entry commits a
 *  provider state once (ready = verified present); without an entry the
 *  card's own list state decides (installed / bundled / ready — a bundled
 *  or downloaded+verified asset is installed at Run time). */
export function cardRunnable(
  card: PretrainedSummary,
  entry: { status: { state: string } | null; error: string | null } | undefined,
): boolean {
  const state = entry?.status?.state ?? null
  if (state !== null) return state === 'ready'
  return card.state === 'installed' || card.state === 'bundled' || card.state === 'ready'
}

/** The reuse-mode config: the FIRST SELECTED model's own endpoint/horizon/
 *  decision day (the model steps have no settings controls — a model is run
 *  at the horizon and the decision day it was trained for, never at the
 *  intake's day), and the engine-defaults the steps' bars carry. */
export function reuseConfig(
  first: { endpoint: string; decision_day: number; horizon: number },
  atATime: number,
): RunConfig {
  return {
    endpoint: first.endpoint,
    decision_day: first.decision_day,
    look_ahead_day: first.horizon,
    covariates: false,
    at_a_time: atATime,
    cpus: null,
    save_models: false,
    label_day: null,
  } as unknown as RunConfig
}

/** The live selection read FRESH at invoke time (the shared hook's
 *  `getSelection` — the action's selection is never a render-time snapshot;
 *  the stale-state token is the real check). */
export function getLiveSelection(): ReadonlySet<string> {
  return useTxrModelsStore.getState().selection
}

/**
 * The one install path for a selected card (PROV-PC-7): an already
 * installed card yields its store uuid; a bundled/cached/downloaded asset
 * is installed now (`status: "installed"` → the response's `model_id`);
 * a `"installing"` response polls the download manager (PROV-PC-6) until
 * the asset is `ready`, then re-installs; a `failed` verify throws with
 * the provider's line. The download itself is never started HERE (the
 * gate lets Run through only when every selected asset is installable).
 */
export async function installedModelId(card: PretrainedSummary): Promise<string> {
  if (card.state === 'installed') {
    if (card.installed_model_id === undefined) {
      throw new Error(`The model ${card.id} has no installed model record.`)
    }
    return card.installed_model_id
  }
  let install = await ApiClient.Pretrained.installModel({ id: card.id })
  while (install.status === 'installing') {
    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_POLL_MS))
    const downloads = await ApiClient.Pretrained.listDownloads()
    const entry = downloads.downloads.find(d => d.id === card.id)
    if (entry?.state === 'failed') {
      throw new Error(entry.error ?? `The model ${card.id} could not be downloaded.`)
    }
    if (entry?.state !== 'ready') continue
    install = await ApiClient.Pretrained.installModel({ id: card.id })
  }
  if (install.model_id === undefined) {
    throw new Error(`The model ${card.id} could not be installed.`)
  }
  return install.model_id
}

/** One downloads-strip entry: the card's `TxrDownloadState` with its
 *  controller (a hook per card — the strip's list is bounded by the
 *  live/failed downloads, never the whole catalogue). */
export function StripEntry({ id }: { id: string }) {
  const { entry, retrying, retry } = useDownloadState(id)
  return <TxrDownloadState id={id} label={id} entry={entry} retrying={retrying} onRetry={retry} />
}
