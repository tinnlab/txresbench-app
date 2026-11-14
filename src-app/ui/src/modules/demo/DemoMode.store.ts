import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import type { AppModeResponse } from '@/api-client/types'
import { fetchAppMode } from './lib/appModeApi'

/**
 * DemoMode — the app-mode boot read (demo-mode ITEM-5).
 *
 * `GET /api/app/mode` answers `{mode, download_url, limits, notice}` in every
 * deployment (desktop included; ITEM-1 made it public and installed it at
 * boot). This store holds that answer for the whole UI: the notice bar, the
 * header download link and the `DemoOnly` / `DesktopOnly` /
 * `DisabledBecauseDemo` / `ExampleFileCard` components all read
 * `useAppMode()` below it.
 *
 * The NO-FLASH rule (the plan's "until it is known the app renders nothing
 * mode-specific"): `mode` starts `null` and every mode-specific component
 * returns its neutral (non-demo) face while it is null. Only the settled
 * answer renders demo chrome — a demo boot never flashes a notice bar in
 * front of a desktop page or vice versa.
 *
 * The read is retried (the boot-read rule of the local-session store: a
 * transient failure under load is absorbed). After the last try the mode
 * settles to DESKTOP — the honest fail-safe for an unknown mode: the server
 * enforces demo mode itself (the route allowlist), so a UI that understates
 * the mode is blocked by the backend, not by this store.
 *
 * The close of the notice bar is remembered in `sessionStorage` (the plan's
 * "hidden for the browser session, returns in a new session"): one key, read
 * at store birth, written by `dismissNotice`, never a cookie and never
 * localStorage (the demo must not remember a visitor across sessions).
 */

/** The two modes the server can answer (the wire value is a string). */
export type DemoMode = 'desktop' | 'demo'

/** The `sessionStorage` key of the notice-bar close (per browser session). */
export const DEMO_NOTICE_DISMISS_KEY = 'txr-demo-notice-dismissed'

interface DemoModeState {
  /** The settled mode; null while the boot read is unresolved (the no-flash rule). */
  mode: DemoMode | null
  /** True once the read settled (success or the last retry's failure verdict). */
  ready: boolean
  /** True while the read ladder is running (guards `init` against re-entry). */
  loading: boolean
  /** The download page URL; empty in desktop mode. */
  downloadUrl: string
  /** The server's resolved notice text; empty in desktop mode. */
  notice: string
  /** The demo limits (`limits.history` / `limits.models`); the desktop
   *  answer's defaults, used by ITEM-7's "n of 50" counters. */
  historyLimit: number
  modelLimit: number
  /** The visitor closed the notice for this browser session. */
  noticeDismissed: boolean
  /** The boot read (idempotent: a second call while running/ready is a no-op). */
  init: () => Promise<void>
  /** Apply one wire answer (exported for the gallery seed and tests). */
  applyResponse: (response: AppModeResponse) => void
  /** Hide the notice for this browser session (sessionStorage). */
  dismissNotice: () => void
}

/** How many tries the automatic boot read makes (the local-session rule). */
const MODE_ATTEMPTS = 3

/** The backoff between tries (500 ms then 1 s — the session store's own ladder). */
const MODE_BACKOFF_MS = [500, 1000] as const

const DemoModeDef = defineStore('DemoMode', {
  state: {
    mode: null as DemoMode | null,
    ready: false,
    loading: false,
    downloadUrl: '',
    notice: '',
    historyLimit: 50,
    modelLimit: 50,
    noticeDismissed: readDismissed(),
  },
  actions: (set, get) => {
    // One wire answer applied to the store (shared by the ladder + the
    // exported action — `get` carries state only, so the apply is a set too).
    const apply = (response: AppModeResponse): void => {
      const demo = response.mode === 'demo'
      set({
        mode: demo ? 'demo' : 'desktop',
        downloadUrl: demo ? response.download_url : '',
        notice: demo ? response.notice : '',
        historyLimit: response.limits?.history ?? 50,
        modelLimit: response.limits?.models ?? 50,
      })
    }
    return {
      init: async () => {
        if (get().ready || get().loading) return
        set({ loading: true })
        let lastError: unknown = null
        try {
          for (let attempt = 1; attempt <= MODE_ATTEMPTS; attempt += 1) {
            try {
              const response = await fetchAppMode()
              apply(response)
              set({ ready: true, loading: false })
              return
            } catch (error) {
              lastError = error
              if (attempt < MODE_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, MODE_BACKOFF_MS[attempt - 1]))
              }
            }
          }
          apply({ mode: 'desktop', download_url: '', limits: { history: 50, models: 50 }, notice: '' })
          set({ ready: true, loading: false })
          console.warn(
            'DemoMode: the mode read failed; assuming desktop mode (the server still enforces its own mode).',
            lastError,
          )
        } catch (unexpected) {
          // The ladder itself failing (an AbortError out of the backoff sleep)
          // ends in the same settled state, never a hang.
          apply({ mode: 'desktop', download_url: '', limits: { history: 50, models: 50 }, notice: '' })
          set({ ready: true, loading: false })
          console.warn('DemoMode: the mode read failed unexpectedly; assuming desktop mode.', unexpected)
        }
      },
      applyResponse: apply,
      dismissNotice: () => {
        set({ noticeDismissed: true })
        try {
          window.sessionStorage.setItem(DEMO_NOTICE_DISMISS_KEY, '1')
        } catch {
          // A locked-down context (storage disabled) still dismisses for the
          // session in memory — the close works, only the memory is shorter.
        }
      },
    }
  },
})

export const useDemoModeStore = DemoModeDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers under `'DemoMode'`, so
 * a `stores: [...]` entry (if any remains) REUSES this instance.
 */
export const DemoMode = registerLazyStore(DemoModeDef)

/** The sessionStorage read, at store birth (a locked context reads false). */
function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DEMO_NOTICE_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
