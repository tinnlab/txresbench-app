/**
 * demo test utils — the ONE store-seed helper the demo unit tests share
 * (test-only; the gallery surfaces seed through their own stories).
 */
import { useDemoModeStore, type DemoMode } from '../DemoMode.store'

/** Put the store into a settled mode (the boot read's answer).
 *  `noticeDismissed` is NOT reset unless asked — the gallery surfaces must
 *  preserve the birth read (the sessionStorage close), so a reload with a
 *  dismissed session stays dismissed. */
export function seedDemoMode(
  mode: DemoMode,
  over: { downloadUrl?: string; notice?: string; noticeDismissed?: boolean } = {},
): void {
  useDemoModeStore.setState({
    mode,
    ready: true,
    loading: false,
    downloadUrl: over.downloadUrl ?? (mode === 'demo' ? 'https://downloads.example.test/txresbench' : ''),
    notice: over.notice ?? (mode === 'demo' ? 'Runs and models here are shared with everyone who visits the demo.' : ''),
    historyLimit: 50,
    modelLimit: 50,
    noticeDismissed: over.noticeDismissed ?? useDemoModeStore.getState().noticeDismissed,
  })
}

/** Return the store to its birth state (the boot read still pending). */
export function resetDemoMode(): void {
  useDemoModeStore.setState({
    mode: null,
    ready: false,
    loading: false,
    downloadUrl: '',
    notice: '',
    historyLimit: 50,
    modelLimit: 50,
    noticeDismissed: false,
  })
}
