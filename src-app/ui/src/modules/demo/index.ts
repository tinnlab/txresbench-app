/**
 * demo — the demo-mode UI foundation (ITEM-5), one surface for the pages:
 * the mode context (useAppMode), the notice bar + header download link, and
 * the reusable mode-gated components (DemoOnly / DesktopOnly /
 * DisabledBecauseDemo / ExampleFileCard). The module itself is registered by
 * `module.tsx` (the boot read fires there); pages import the pieces from
 * here without touching the module system.
 */
export { useAppMode, type AppMode } from './useAppMode'
export { DemoMode, useDemoModeStore, type DemoMode as DemoModeName } from './DemoMode.store'
export { DemoNoticeBar } from './components/DemoNoticeBar'
export { DemoHeaderDownload } from './components/DemoHeaderDownload'
export { DemoOnly } from './components/DemoOnly'
export { DesktopOnly } from './components/DesktopOnly'
export { DisabledBecauseDemo } from './components/DisabledBecauseDemo'
export { ExampleFileCard, type ExampleFileCardProps, type ExampleTableKind } from './components/ExampleFileCard'
