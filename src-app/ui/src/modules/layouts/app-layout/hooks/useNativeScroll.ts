import { useLayoutEffect } from 'react'
import { useAppLayoutStore } from '@/modules/layouts/app-layout/AppLayout.store'
import { useWindowMinSize } from '@txresbench/shell'

/** html class the CSS overrides key off (relaxes #root/body height + overflow). */
const NATIVE_SCROLL_CLASS = 'scroll-native'

/**
 * Opt a page into NATIVE DOCUMENT scroll (window scrolls, not an inner box) so
 * iOS Safari collapses its toolbar + flows content under the notch. Scoped to
 * MOBILE (xs) only — desktop keeps the fixed app shell, where there's no toolbar
 * to collapse. Sets the `AppLayout.nativeScroll` store flag (drives the shell's
 * React classes) AND toggles the `scroll-native` html class (drives the CSS that
 * relaxes #root/body, which aren't React-controlled). Reverts on unmount and
 * when the viewport crosses back above xs, so a stale class can never relax the
 * desktop shell.
 */
export function useNativeScroll(enabled: boolean): void {
  const { xs } = useWindowMinSize()
  const active = enabled && xs

  useLayoutEffect(() => {
    if (!active) return
    const setNativeScroll = useAppLayoutStore.getState().setNativeScroll
    setNativeScroll(true)
    document.documentElement.classList.add(NATIVE_SCROLL_CLASS)
    return () => {
      setNativeScroll(false)
      document.documentElement.classList.remove(NATIVE_SCROLL_CLASS)
    }
  }, [active])
}
