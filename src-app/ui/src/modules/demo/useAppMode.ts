import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useDemoModeStore, type DemoMode } from './DemoMode.store'

/**
 * useAppMode — the demo-mode app-context hook (ITEM-5).
 *
 * Every mode-specific UI reads the boot answer through this one hook:
 * `isDemo` / `isDesktop` gate the chrome (the notice bar, the header download
 * link) and the page pieces (DemoOnly / DesktopOnly / DisabledBecauseDemo);
 * `downloadUrl` and `notice` carry the server's configured facts; the limits
 * are ITEM-7's "n of 50" numbers.
 *
 * The no-flash rule is in the SHAPE: while `ready` is false (the boot read is
 * still pending) `mode` is null, so `isDemo` and `isDesktop` are both false
 * and a mode-specific renderer's safest branch is the neutral one. Consumers
 * MUST test `isDemo` / `isDesktop`, never `!isDemo` as if it meant desktop —
 * before the read settles it means "unknown".
 */
export interface AppMode {
  /** True once the boot read settled (success or the final failure verdict). */
  ready: boolean
  /** The settled mode; null while the read is pending. */
  mode: DemoMode | null
  /** Demo mode (known — false while the read is pending). */
  isDemo: boolean
  /** Desktop mode (known — false while the read is pending). */
  isDesktop: boolean
  /** The download page URL; empty in desktop mode. */
  downloadUrl: string
  /** The server's resolved notice text; empty in desktop mode. */
  notice: string
  /** The demo limits (ITEM-7's counters). */
  historyLimit: number
  modelLimit: number
  /** True after the visitor closed the notice for this browser session. */
  noticeDismissed: boolean
  /** Hide the notice for this browser session. */
  dismissNotice: () => void
}

export function useAppMode(): AppMode {
  return useStore(
    useDemoModeStore,
    useShallow(s => ({
      ready: s.ready,
      mode: s.mode,
      isDemo: s.mode === 'demo',
      isDesktop: s.mode === 'desktop',
      downloadUrl: s.downloadUrl,
      notice: s.notice,
      historyLimit: s.historyLimit,
      modelLimit: s.modelLimit,
      noticeDismissed: s.noticeDismissed,
      dismissNotice: s.dismissNotice,
    })),
  )
}
